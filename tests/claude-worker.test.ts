import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeWorker, type SpawnFn } from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { listBoard, type Task } from "../src/tasks.js";
import { workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

function makeTask(id = "task-1", workspace: string | null = null): Task {
  return {
    id,
    type: "work",
    status: "in_progress",
    assignee: "deckhand",
    workspace,
    title: "fix the leaky faucet",
    purpose: "stop the drip",
    completion_criteria: "no drip for 24h",
    risk_flag: 0,
    review_flag: 0,
    parent_id: null,
    sort_key: 1,
    handoff_doc: null,
    pr_number: null,
    question_options: null,
    question_recommendation: null,
    question_answer: null,
    question_cancel_option: null,
    question_pending_child: null,
    question_pending_merge_pr: null,
    question_quarantine_workspace: null,
    created_at: "2026-07-08T00:00:00.000Z",
  };
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
}

/** Events reference tasks by FK, so a started task must exist on the board. */
function insertTask(db: ReturnType<typeof openDb>, task: Task): void {
  db.prepare(
    `INSERT INTO tasks (id, type, status, assignee, workspace, title, purpose, completion_criteria,
       risk_flag, review_flag, sort_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.type,
    task.status,
    task.assignee,
    task.workspace,
    task.title,
    task.purpose,
    task.completion_criteria,
    task.risk_flag,
    task.review_flag,
    task.sort_key,
    task.created_at,
  );
}

/** Scripted stand-in at the process boundary: records the spawn recipe. */
function recordingSpawn() {
  const calls: SpawnCall[] = [];
  const stdout = new PassThrough();
  const killed: NodeJS.Signals[] = [];
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    return { stdout, kill: (signal) => killed.push(signal) };
  };
  return { calls, stdout, killed, spawn };
}

async function makeWorker(registryFiles: Record<string, string> = {}) {
  const registryDir = await makeRegistry(registryFiles);
  const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
  const db = openDb(":memory:");
  const recorder = recordingSpawn();
  const worker = new ClaudeCodeWorker({
    db,
    clock: new FakeClock(),
    registryDir,
    agent: "deckhand",
    workspace: "tidepool",
    mcpUrl: "http://127.0.0.1:4589/mcp",
    logDir,
    spawn: recorder.spawn,
  });
  /** Register a board task and hand it to the worker, as the scheduler would. */
  const start = (id?: string, workspace: string | null = null): Task => {
    const task = makeTask(id, workspace);
    insertTask(db, task);
    worker.start(task);
    return task;
  };
  return { worker, start, logDir, db, registryDir, ...recorder };
}

describe("ClaudeCodeWorker", () => {
  it("タスクの workspace を cwd に、stream-json 出力のヘッドレス Claude Code を起動する", async () => {
    const { start, calls } = await makeWorker();
    start();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.command).toBe("claude");
    // cwd comes from the registry's workspaces.yaml, not from tidepool itself
    expect(call.cwd).toBe("/home/pi/work/tidepool");
    expect(call.args.join(" ")).toContain("--output-format stream-json");
    // headless: nobody is present to answer a permission prompt. auto mode
    // self-approves routine actions but keeps the classifier safety layer —
    // authority itself comes from the profile + MCP verbs.
    expect(call.args.join(" ")).toContain("--permission-mode auto");
  });

  it("task.workspace が設定されていれば、コンストラクタの workspace より優先して cwd に使う(issue #26)", async () => {
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: /home/pi/work/tidepool\nprod:\n  path: /home/pi/work/prod\n`,
    });
    start("task-prod", "prod");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe("/home/pi/work/prod");
  });

  it("task.workspace が null なら、これまで通りコンストラクタの workspace を cwd に使う", async () => {
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: /home/pi/work/tidepool\nprod:\n  path: /home/pi/work/prod\n`,
    });
    start("task-default", null);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cwd).toBe("/home/pi/work/tidepool");
  });

  it("task.workspace が registry に存在しない名前(registry drift)なら、投げずに quarantine して spawn しない(issue #26 / ADR 0009)", async () => {
    const { start, calls, db } = await makeWorker();
    start("task-drifted", "ghost");
    expect(calls).toEqual([]);
    expect(workspaceNeedsHuman(db, "ghost")).toBe(true);
    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.question_quarantine_workspace).toBe("ghost");
  });

  it("一時 MCP 設定でボードを ?task= 付きで指す(呼び出しのタスク帰属)", async () => {
    const { start, calls } = await makeWorker();
    start("task-42");
    const args = calls[0]!.args;
    const configPath = args[args.indexOf("--mcp-config") + 1]!;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    expect(config.mcpServers.tidepool.url).toBe("http://127.0.0.1:4589/mcp?task=task-42");
    // the spawned session sees only the board, not the host's own MCP servers
    expect(args).toContain("--strict-mcp-config");
  });

  it("エージェント定義の本文と authority guidance をシステムプロンプトへ注入する", async () => {
    const { start, calls } = await makeWorker();
    start();
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(systemPrompt).toContain("You are Deckhand");
    expect(systemPrompt).toContain("Prefer reversible actions");
  });

  it("セッションの stream-json を全量ファイルに記録する(監査性)", async () => {
    const { start, stdout, logDir } = await makeWorker();
    start("task-7");
    stdout.write(`{"type":"system","subtype":"init"}\n`);
    stdout.write(`{"type":"result","result":"done"}\n`);
    stdout.end();
    await vi.waitFor(async () => {
      const transcript = await readFile(join(logDir, "task-7.stream.jsonl"), "utf8");
      expect(transcript).toBe(
        `{"type":"system","subtype":"init"}\n{"type":"result","result":"done"}\n`,
      );
    });
  });

  it("相対 logDir でも MCP config への参照は絶対パス(spawn 先の cwd は workspace であって盤面ではない)", async () => {
    const registryDir = await makeRegistry();
    const base = await mkdtemp(join(tmpdir(), "tidepool-relative-logs-"));
    const prevCwd = process.cwd();
    process.chdir(base);
    try {
      const db = openDb(":memory:");
      const recorder = recordingSpawn();
      const worker = new ClaudeCodeWorker({
        db,
        clock: new FakeClock(),
        registryDir,
        agent: "deckhand",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:4589/mcp",
        logDir: "worker-logs",
        spawn: recorder.spawn,
      });
      await mkdir(join(base, "worker-logs"), { recursive: true });
      const task = makeTask("task-rel");
      insertTask(db, task);
      worker.start(task);
      const args = recorder.calls[0]!.args;
      const configPath = args[args.indexOf("--mcp-config") + 1]!;
      expect(isAbsolute(configPath)).toBe(true);
      // and the file really is where the flag says it is
      await readFile(configPath, "utf8");
    } finally {
      process.chdir(prevCwd);
    }
  });

  it("model は常に明示的に渡す: frontmatter に無ければ sonnet(ホストのモデル設定を漏らさない)", async () => {
    const { start, calls } = await makeWorker();
    start();
    expect(calls[0]!.args.join(" ")).toContain("--model sonnet");
  });

  it("frontmatter に model があればそれを使う", async () => {
    const { start, calls } = await makeWorker({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nmodel: opus\n---\nYou are Deckhand.\n`,
    });
    start();
    expect(calls[0]!.args.join(" ")).toContain("--model opus");
  });

  it("effort は常に明示的に渡す: frontmatter に無ければ medium(ホストの effort 設定を漏らさない)", async () => {
    const { start, calls } = await makeWorker();
    start();
    expect(calls[0]!.args.join(" ")).toContain("--effort medium");
  });

  it("frontmatter に effort があればそれを使う", async () => {
    const { start, calls } = await makeWorker({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\neffort: high\n---\nYou are Deckhand.\n`,
    });
    start();
    expect(calls[0]!.args.join(" ")).toContain("--effort high");
  });

  it("未知の effort 値は boot 時のコンストラクタで即座に失敗する(ADR 0005: CLI 側で閉じた集合はここで検証する)", async () => {
    const registryDir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\neffort: super-fast\n---\nYou are Deckhand.\n`,
    });
    const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
    expect(
      () =>
        new ClaudeCodeWorker({
          db: openDb(":memory:"),
          clock: new FakeClock(),
          registryDir,
          agent: "deckhand",
          workspace: "tidepool",
          mcpUrl: "http://127.0.0.1:4589/mcp",
          logDir,
          spawn: recordingSpawn().spawn,
        }),
    ).toThrow(/unknown effort level/);
  });

  it("設定ミス(未知の workspace 名)は boot 時のコンストラクタで即座に失敗する", async () => {
    // a misconfigured registry must refuse to start the board, not wedge the
    // first task at pickup time
    const registryDir = await makeRegistry();
    const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
    expect(
      () =>
        new ClaudeCodeWorker({
          db: openDb(":memory:"),
          clock: new FakeClock(),
          registryDir,
          agent: "deckhand",
          workspace: "no-such-workspace",
          mcpUrl: "http://127.0.0.1:4589/mcp",
          logDir,
          spawn: recordingSpawn().spawn,
        }),
    ).toThrow(/unknown workspace/);
  });

  it("checkUsage は `claude -p /usage --output-format json` の result フィールドをそのまま返す(ADR 0008)", async () => {
    const registryDir = await makeRegistry();
    const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
    const resultText = "Current session: 56% used · resets Jul 9 at 5:59pm (Asia/Tokyo)\n";
    const worker = new ClaudeCodeWorker({
      db: openDb(":memory:"),
      clock: new FakeClock(),
      registryDir,
      agent: "deckhand",
      workspace: "tidepool",
      mcpUrl: "http://127.0.0.1:4589/mcp",
      logDir,
      spawn: recordingSpawn().spawn,
      exec: async () => JSON.stringify({ result: resultText }),
    });

    await expect(worker.checkUsage()).resolves.toBe(resultText);
  });

  it("checkUsage は exec の失敗を null に丸める(fail-closed の入り口)", async () => {
    const registryDir = await makeRegistry();
    const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
    const worker = new ClaudeCodeWorker({
      db: openDb(":memory:"),
      clock: new FakeClock(),
      registryDir,
      agent: "deckhand",
      workspace: "tidepool",
      mcpUrl: "http://127.0.0.1:4589/mcp",
      logDir,
      spawn: recordingSpawn().spawn,
      exec: async () => {
        throw new Error("claude binary not found");
      },
    });

    await expect(worker.checkUsage()).resolves.toBeNull();
  });

  it("checkUsage は万一の暴走に備え、--model haiku・--max-turns 1・--max-budget-usd 0.01 を明示指定する(ADR 0005/0008)", async () => {
    const registryDir = await makeRegistry();
    const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
    const calls: Array<{ command: string; args: string[] }> = [];
    const worker = new ClaudeCodeWorker({
      db: openDb(":memory:"),
      clock: new FakeClock(),
      registryDir,
      agent: "deckhand",
      workspace: "tidepool",
      mcpUrl: "http://127.0.0.1:4589/mcp",
      logDir,
      spawn: recordingSpawn().spawn,
      exec: async (command, args) => {
        calls.push({ command, args });
        return JSON.stringify({ result: "" });
      },
    });

    await worker.checkUsage();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("claude");
    const argLine = calls[0]!.args.join(" ");
    expect(argLine).toContain("-p /usage");
    expect(argLine).toContain("--output-format json");
    expect(argLine).toContain("--model haiku");
    expect(argLine).toContain("--max-turns 1");
    expect(argLine).toContain("--max-budget-usd 0.01");
  });

  it("使用中レジストリの commit hash を events に記録する(判断の来歴)", async () => {
    const { start, db, registryDir } = await makeWorker();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: registryDir })
      .toString()
      .trim();
    start("task-9");
    const spawned = listEvents(db, "task-9").find((e) => e.kind === "worker_spawned");
    expect(spawned).toBeDefined();
    expect(spawned!.worker_id).toBe("deckhand");
    expect(spawned!.payload).toMatchObject({
      kind: "worker_spawned",
      registry_commit: head,
      definition_version: "0.3.1",
    });
  });
});
