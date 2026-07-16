import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { agentNeedsHuman } from "../src/agent.js";
import { ClaudeCodeWorker, type SpawnFn } from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { listBoard, type Task } from "../src/tasks.js";
import { workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

function makeTask(
  id = "task-1",
  workspace: string | null = null,
  assignee: string | null = "deckhand",
  type: Task["type"] = "work",
): Task {
  return {
    id,
    type,
    status: "in_progress",
    assignee,
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
    question_items: null,
    question_answer: null,
    question_answer_comment: null,
    question_cancel_option: null,
    question_pending_child: null,
    question_pending_merge_pr: null,
    question_quarantine_workspace: null,
    question_quarantine_agent: null,
    github_issue_number: null,
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
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    return {
      stdout,
      kill: (signal) => killed.push(signal),
      on: (event, listener) => {
        if (event === "exit") exitListeners.push(listener);
      },
    };
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null) => {
    for (const listener of exitListeners) listener(code, signal);
  };
  return { calls, stdout, killed, spawn, emitExit };
}

async function makeWorker(
  registryFiles: Record<string, string> = {},
  extraOptions: Partial<ConstructorParameters<typeof ClaudeCodeWorker>[0]> = {},
) {
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
    ...extraOptions,
  });
  /** Register a board task and hand it to the worker, as the scheduler would. */
  const start = (
    id?: string,
    workspace: string | null = null,
    assignee: string | null = "deckhand",
    type: Task["type"] = "work",
  ): Task => {
    const task = makeTask(id, workspace, assignee, type);
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

  const NAVIGATOR_MD = `---\nname: navigator\nversion: 1.0.0\nauthority: standard\ndescription: Navigation specialist\n---\nYou are Navigator, the specialist.\n`;

  it("task.assignee が指定されていれば、コンストラクタの agent より優先してそのエージェントとして spawn する(ADR 0012 / issue #36)", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-navigator", null, "navigator");
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(systemPrompt).toContain("You are Navigator");
    expect(systemPrompt).not.toContain("You are Deckhand");
  });

  it("task.assignee が null なら、これまで通りコンストラクタの agent(既定 agent)として spawn する", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-default-agent", null, null);
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(systemPrompt).toContain("You are Deckhand");
  });

  it("task.assignee が registry に存在しない agent 名(registry drift)なら、投げずに agent を quarantine して spawn しない(ADR 0012 / issue #36)", async () => {
    const { start, calls, db } = await makeWorker();
    start("task-drifted-agent", null, "ghost");
    expect(calls).toEqual([]);
    expect(agentNeedsHuman(db, "ghost")).toBe(true);
    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.question_quarantine_agent).toBe("ghost");
  });

  it("system prompt に roster を push する: assignable_to(既定は \"*\")を解決した registry 全体が「名前 — description」で並ぶ(issue #43 / ADR 0014)", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start();
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(systemPrompt).toContain("## Roster");
    expect(systemPrompt).toContain("navigator — Navigation specialist");
    expect(systemPrompt).toContain("deckhand — General work agent for the tidepool board");
  });

  it("roster の human 行: assignable_to に human があれば固定の1行で描画する(issue #43 / ADR 0014)", async () => {
    const { start, calls } = await makeWorker({
      "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - navigator\n  - human\nallowed_workspaces:\n  - "*"\n`,
      "agents/navigator.md": NAVIGATOR_MD,
    });
    start();
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(systemPrompt).toContain("navigator — Navigation specialist");
    expect(systemPrompt).toContain(
      "human — delegate to a human — runs outside the slot, as a question task",
    );
    // 明示リストに無い deckhand 自身は roster に現れない
    expect(systemPrompt).not.toContain("deckhand — General work agent");
  });

  it("assignable_to の Object.prototype 由来のキー(toString 等)は drift と同じく黙ってスキップされ roster に混入しない(issue #69)", async () => {
    const { start, calls } = await makeWorker({
      "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - toString\nallowed_workspaces:\n  - "*"\n`,
    });
    start();
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(systemPrompt).not.toContain("## Roster");
  });

  const KEEPER_MD = `---\nname: keeper\nversion: 1.0.0\nauthority: standard\ndescription: Independent reviewer\n---\nYou are Keeper, the auditor.\n`;

  it("review タイプかつ assignee が未指定なら、コンストラクタの既定 agent ではなく auditorName で spawn する(issue #42)", async () => {
    const { start, calls } = await makeWorker(
      { "agents/keeper.md": KEEPER_MD },
      { auditorName: "keeper" },
    );
    start("task-review", null, null, "review");
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(systemPrompt).toContain("You are Keeper");
    expect(systemPrompt).not.toContain("You are Deckhand");
  });

  it("worker_spawned イベントの worker_id は解決済みの assignee になる(コンストラクタの既定 agent 固定ではない)", async () => {
    const { start, db } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-attributed", null, "navigator");
    const spawned = listEvents(db, "task-attributed").find((e) => e.kind === "worker_spawned");
    expect(spawned?.worker_id).toBe("navigator");
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

  it("盤面教義(subagent/workflow は説明責任を分割しない労力の分割にのみ使う)を、agent や profile によらず system prompt に注入する(ADR 0010 / issue #31)", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-navigator", null, "navigator");
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(systemPrompt).toContain("Agent tool");
    expect(systemPrompt).toContain("decompose");
    // ADR 0010 追補の受け入れ基準: 教義自体にオーケストレーション禁止の1行が含まれる
    // (--disallowedTools でツールを塞ぐのとは別に、教義の文言としても明示する)
    expect(systemPrompt).toContain("Workflow tool");
  });

  it("Workflow ツールを spawn 時に無効化する(オーケストレーションは worker にカテゴリ禁止・ADR 0010 追補 / issue #31)", async () => {
    const { start, calls } = await makeWorker();
    start();
    const args = calls[0]!.args;
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Workflow");
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
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\ndescription: General work agent\nmodel: opus\n---\nYou are Deckhand.\n`,
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
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\ndescription: General work agent\neffort: high\n---\nYou are Deckhand.\n`,
    });
    start();
    expect(calls[0]!.args.join(" ")).toContain("--effort high");
  });

  it("未知の effort 値は boot 時のコンストラクタで即座に失敗する(ADR 0005: CLI 側で閉じた集合はここで検証する)", async () => {
    const registryDir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\ndescription: General work agent\neffort: super-fast\n---\nYou are Deckhand.\n`,
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

  it("effort: ultracode は未知の effort 値として reject される(CLI --effort の閉じた5値に無く、xhigh+workflow orchestration への迂回路にならない・issue #31)", async () => {
    const registryDir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\ndescription: General work agent\neffort: ultracode\n---\nYou are Deckhand.\n`,
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

  it("checkUsage は --safe-mode を指定し、ボードの起動ディレクトリの CLAUDE.md/skills/MCP を拾わない", async () => {
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

    expect(calls[0]!.args.join(" ")).toContain("--safe-mode");
  });

  it("正常終了したセッションは worker_exited イベントにトークン内訳と estimated_cost_usd を記録する(issue #32)", async () => {
    const { start, stdout, emitExit, db } = await makeWorker();
    start("task-usage");
    stdout.write(
      `${JSON.stringify({
        type: "result",
        result: "done",
        total_cost_usd: 0.1234,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 10,
          cache_creation_input_tokens: 5,
        },
      })}\n`,
    );
    emitExit(0, null);
    const exited = listEvents(db, "task-usage").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toEqual({
      kind: "worker_exited",
      exit_code: 0,
      signal: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_creation_tokens: 5,
        estimated_cost_usd: 0.1234,
      },
    });
  });

  it("最終チャンクが改行なしで終わっても、最後の result 行を usage として拾う(issue #32 code review: 偽の欠測を防ぐ)", async () => {
    const { start, stdout, emitExit, db } = await makeWorker();
    start("task-no-trailing-newline");
    // no trailing "\n": the stream just closes mid-line, as a real process
    // exit can — this line must not get stranded in the tee's buffer
    stdout.write(
      JSON.stringify({
        type: "result",
        result: "done",
        total_cost_usd: 0.5,
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
        },
      }),
    );
    emitExit(0, null);
    const exited = listEvents(db, "task-no-trailing-newline").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        cache_read_tokens: 3,
        cache_creation_tokens: 4,
        estimated_cost_usd: 0.5,
      },
    });
  });

  it("result 行の usage が期待した形と食い違えば、投げずに usage null として fail-closed する(issue #32 code review)", async () => {
    const { start, stdout, emitExit, db } = await makeWorker();
    start("task-malformed-usage");
    stdout.write(
      `${JSON.stringify({
        type: "result",
        result: "done",
        total_cost_usd: 0.9,
        usage: { input_tokens: 1 /* missing the other 3 fields */ },
      })}\n`,
    );
    expect(() => emitExit(0, null)).not.toThrow();
    const exited = listEvents(db, "task-malformed-usage").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ usage: null });
  });

  it("非ゼロ終了は worker_exited イベントに加えて console.error でも観測できる(issue #32 code review: defaultSpawn から失われた診断ログの復元)", async () => {
    const { start, emitExit } = await makeWorker();
    start("task-crashed");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      emitExit(1, null);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("claude exited with"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("最終 result イベントが出ないまま終了したセッション(watchdog kill 等)は usage null で worker_exited を記録する(issue #32)", async () => {
    const { start, emitExit, db } = await makeWorker();
    start("task-killed");
    emitExit(null, "SIGKILL");
    const exited = listEvents(db, "task-killed").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toEqual({
      kind: "worker_exited",
      exit_code: null,
      signal: "SIGKILL",
      usage: null,
    });
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
