import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeWorker, type SpawnFn } from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import type { Task } from "../src/tasks.js";
import { FakeClock } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

function makeTask(id = "task-1"): Task {
  return {
    id,
    type: "work",
    status: "in_progress",
    assignee: "deckhand",
    title: "fix the leaky faucet",
    purpose: "stop the drip",
    completion_criteria: "no drip for 24h",
    risk_flag: 0,
    review_flag: 0,
    parent_id: null,
    sort_key: 1,
    handoff_doc: null,
    question_options: null,
    question_recommendation: null,
    question_answer: null,
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
    `INSERT INTO tasks (id, type, status, assignee, title, purpose, completion_criteria,
       risk_flag, review_flag, sort_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.type,
    task.status,
    task.assignee,
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
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd });
    return { stdout };
  };
  return { calls, stdout, spawn };
}

async function makeWorker() {
  const registryDir = await makeRegistry();
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
  const start = (id?: string): Task => {
    const task = makeTask(id);
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
