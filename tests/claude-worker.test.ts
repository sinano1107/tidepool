import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { agentNeedsHuman } from "../src/agent.js";
import {
  agentGitIdentityEnv,
  ClaudeCodeWorker,
  type EnumerateSkillsFn,
  PROMPT_READY_MARKER,
  type PtyFn,
  pinnedModelFlags,
  type SpawnFn,
} from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import { appendEvent, type EventPayload, listEvents } from "../src/events.js";
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
    question_pending_pr_promotion_task_id: null,
    question_quarantine_workspace: null,
    question_quarantine_agent: null,
    question_quarantine_sandbox: null,
    github_issue_number: null,
    created_at: "2026-07-08T00:00:00.000Z",
  };
}

interface SpawnCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
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

/** A git runner pinned to the registry fixture clone, identity flags inlined
 *  so fixture commits need no global config. */
function registryGit(cwd: string) {
  return (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd })
      .toString()
      .trim();
}

/** Scripted stand-in at the process boundary: records the spawn recipe. */
function recordingSpawn() {
  const calls: SpawnCall[] = [];
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const killed: NodeJS.Signals[] = [];
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const errorListeners: Array<(err: Error) => void> = [];
  const spawn: SpawnFn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, env: opts.env });
    return {
      stdout,
      stderr,
      kill: (signal) => killed.push(signal),
      on: (
        event: "exit" | "error",
        listener:
          | ((code: number | null, signal: NodeJS.Signals | null) => void)
          | ((err: Error) => void),
      ) => {
        if (event === "exit") {
          exitListeners.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        }
        if (event === "error") errorListeners.push(listener as (err: Error) => void);
      },
    };
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null) => {
    for (const listener of exitListeners) listener(code, signal);
  };
  const emitError = (err: Error) => {
    for (const listener of errorListeners) listener(err);
  };
  return { calls, stdout, stderr, killed, spawn, emitExit, emitError };
}

/** Scripted stand-in at the PTY boundary (issue #81 / ADR 0028): the test
 *  drives data emission and process exit, and reads back the spawn recipe,
 *  what checkUsage wrote to stdin, and how many times it killed the session. */
function recordingPty() {
  const calls: Array<{
    command: string;
    args: string[];
    cwd: string;
    cols: number;
    env: NodeJS.ProcessEnv;
  }> = [];
  const writes: string[] = [];
  const kills: Array<string | undefined> = [];
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: (() => void) | undefined;
  const pty: PtyFn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, cols: opts.cols, env: opts.env });
    return {
      onData: (listener) => {
        dataListener = listener;
      },
      write: (data) => {
        writes.push(data);
      },
      kill: (signal) => {
        kills.push(signal);
      },
      onExit: (listener) => {
        exitListener = listener;
      },
    };
  };
  return {
    pty,
    calls,
    writes,
    kills,
    emitData: (data: string) => dataListener?.(data),
    emitExit: () => exitListener?.(),
  };
}

/** A worker wired to a fake PTY, for the checkUsage scrape tests. */
async function makeUsageWorker(pty: PtyFn) {
  const registryDir = await makeRegistry();
  const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
  return new ClaudeCodeWorker({
    db: openDb(":memory:"),
    clock: new FakeClock(),
    registryDir,
    agent: "deckhand",
    workspace: "tidepool",
    mcpUrl: "http://127.0.0.1:4589/mcp",
    logDir,
    spawn: recordingSpawn().spawn,
    pty,
  });
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

/** Scripted stand-in at the skill-enumeration boundary (issue #56 / ADR 0025):
 *  records the cwd it was probed at and returns a scripted full skill set (or
 *  null to simulate a probe failure). */
function recordingEnumerator(result: string[] | null) {
  const calls: string[] = [];
  const enumerateSkills: EnumerateSkillsFn = async (cwd) => {
    calls.push(cwd);
    return result;
  };
  return { calls, enumerateSkills };
}

/** The `--disallowedTools` value a spawn used, split into its comma-separated
 *  tokens (Workflow + any Skill(...) denies + any review Bash(...) denies).
 *  Comma, not space, is the separator the production code joins with (issue
 *  #59): a `Bash(git push*)` token carries an internal space, so a
 *  space-separated join would misdivide that one entry into two. */
function disallowedTools(args: string[]): string[] {
  return args[args.indexOf("--disallowedTools") + 1]!.split(",");
}

/** The `--allowedTools` value a spawn used, split the same way (ADR 0035).
 *  Every spawn carries one now: leaving `auto` put the MCP verbs behind the same
 *  approval prompt as everything else (ADR 0038), so the board's only channel has
 *  to be opened explicitly in both profiles. Empty only if the flag went missing. */
function allowedTools(args: string[]): string[] {
  const at = args.indexOf("--allowedTools");
  return at === -1 ? [] : args[at + 1]!.split(",");
}

/** The `--tools` value a spawn used, split the same way (ADR 0039): the
 *  default-deny allowlist of built-in tools. Comma-joined for the same reason as
 *  the two above — the CLI accepts comma or space (`--help`) and comma keeps one
 *  token one entry. Empty array if the flag went missing, which is *not* the
 *  same as `--tools ""` (that spelling disables every tool). */
function spawnedTools(args: string[]): string[] {
  const at = args.indexOf("--tools");
  return at === -1 ? [] : args[at + 1]!.split(",");
}

/** 盤面が宣言するツール面(ADR 0039 決定1)。**実装を import せず独立した literal**
 *  で書く — import して組み立て直すとコードが計算する通りに期待値も計算するトートロジー
 *  になる(tests/review-tool-denials.test.ts の線)。review の14本も「work から3本
 *  引いた」ではなく手で全量を綴る。この2つはこのファイル内の spawn 引数の主張と
 *  init 行の主張が共有する — 同じ literal をテストごとに書き写すと、リストを1本
 *  足したときに直す場所がテスト本文の数だけ増える。 */
const WORK_SURFACE = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Skill",
  "Task",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
];

const REVIEW_SURFACE = [
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "Skill",
  "Task",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskOutput",
  "TaskStop",
];

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
    // headless: nobody is present to answer a permission prompt, so the mode's
    // residual answer is the floor (ADR 0038). work runs acceptEdits — edits
    // pass, cwd 外は訊く = 拒否。authority itself comes from the profile + MCP verbs.
    expect(call.args.join(" ")).toContain("--permission-mode acceptEdits");
  });

  it("spawn する worker child の env に、spawn されたエージェント名義の GIT_* 4変数を機械注入する(issue #53)", async () => {
    const { start, calls } = await makeWorker();
    start();
    expect(calls).toHaveLength(1);
    const { env } = calls[0]!;
    // エージェントの善意に依存せず、盤面が author/committer 双方を焼き込む。
    // 名義は spawn された既定エージェント(deckhand)、email は .invalid
    // (RFC 2606 の到達不能ドメイン — 実在アドレスに化けない)。
    expect(env.GIT_AUTHOR_NAME).toBe("deckhand");
    expect(env.GIT_AUTHOR_EMAIL).toBe("deckhand@tidepool.invalid");
    expect(env.GIT_COMMITTER_NAME).toBe("deckhand");
    expect(env.GIT_COMMITTER_EMAIL).toBe("deckhand@tidepool.invalid");
  });

  it("GIT_* の名義は task.assignee で解決された実 spawn エージェントに従う(issue #53 / ADR 0012)", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-navigator", null, "navigator");
    expect(calls).toHaveLength(1);
    const { env } = calls[0]!;
    expect(env.GIT_AUTHOR_NAME).toBe("navigator");
    expect(env.GIT_AUTHOR_EMAIL).toBe("navigator@tidepool.invalid");
    expect(env.GIT_COMMITTER_NAME).toBe("navigator");
    expect(env.GIT_COMMITTER_EMAIL).toBe("navigator@tidepool.invalid");
  });

  it("git は agentGitIdentityEnv の GIT_* を実際に尊重する: その env で打ったコミットの author がエージェント名になる(issue #53 完了基準 a)", async () => {
    // spawn env に変数が載ることだけでなく、git がそれを本当に author/committer
    // に反映することまで確かめる — 変数名が1つでも綴り違いなら、env には載るが
    // 履歴には効かない。実 claude セッションは要らない: git 自体が GIT_* を
    // 尊重する事実が、注入機構の end-to-end の正しさを担保する。
    const repo = await mkdtemp(join(tmpdir(), "tidepool-git-identity-"));
    const env = { ...process.env, ...agentGitIdentityEnv("tako") };
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "work"], { cwd: repo, env });
    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], { cwd: repo })
      .toString()
      .trim();
    expect(author).toBe("tako <tako@tidepool.invalid>");
  });

  it("ADR 0024 の不変条件: 盤面が注入する identity env は GIT_* 4変数のみで、トークンを含まない", () => {
    // worker は process.env をまるごと継承する(既存挙動)ので、盤面が worker
    // env に「足す」ものだけがこの issue の関心。その注入物は identity 変数
    // だけに閉じ、GitHub トークンは決して混ざらない(トークンは github-auth.ts
    // が execFileSync の env に都度注入するのみ — ADR 0024 の「効く場所は1箇所」)。
    expect(Object.keys(agentGitIdentityEnv("deckhand")).sort()).toEqual([
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
    ]);
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

  const NAVIGATOR_MD = `---\nname: navigator\nversion: 1.0.0\nauthority: standard\nskills:\n  - "*"\ndescription: Navigation specialist\n---\nYou are Navigator, the specialist.\n`;

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
      "human — delegate to a human — runs outside the slot in their own task list; " +
        "human attention is scarce, delegate only what genuinely needs a human",
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

  const KEEPER_MD = `---\nname: keeper\nversion: 1.0.0\nauthority: standard\nskills:\n  - "*"\ndescription: Independent reviewer\n---\nYou are Keeper, the auditor.\n`;

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

  // ADR 0017: agent 定義ファイルは専門性のみを運び、ワーカープロトコル(rules
  // of the road)は盤面がコード側で全ワーカーに注入する。本文が空の正規形エージェント
  // (tako)でも、cwd=workspace・side channel 禁止・escalate をためらわない posture が
  // system prompt に現れることを固定する。verb の意味論は MCP description 側にあり、
  // ここには重複させない(issue #51)。
  const TAKO_MD = `---\nname: tako\ndescription: General work agent for the tidepool board\nversion: 0.1.0\nauthority: standard\nskills:\n  - "*"\nicon: \u{1F419}\n---\n`;

  it("本文が空の既定エージェントでも、ワーカープロトコル(rules of the road)を system prompt に注入する(ADR 0017 / issue #51)", async () => {
    const { start, calls } = await makeWorker({ "agents/tako.md": TAKO_MD });
    start("task-tako", null, "tako");
    const args = calls[0]!.args;
    const systemPrompt = args[args.indexOf("--append-system-prompt") + 1]!;
    // cwd = the task's workspace
    expect(systemPrompt).toContain("current working directory");
    // no side channels — everything flows through the MCP verbs
    expect(systemPrompt).toContain("did not happen");
    // escalate posture (deckhand 本文が運んでいた rules of the road)
    expect(systemPrompt).toContain("Escalating is never wrong");
    // verb の意味論は description 側に一本化: WORKER_PROTOCOL に verb 名を複写しない
    expect(systemPrompt).not.toContain("get_current_task");
  });

  it("Workflow ツールを spawn 時に無効化する(オーケストレーションは worker にカテゴリ禁止・ADR 0010 追補 / issue #31)", async () => {
    const { start, calls } = await makeWorker();
    start();
    const args = calls[0]!.args;
    expect(args[args.indexOf("--disallowedTools") + 1]).toBe("Workflow");
  });

  // ADR 0013 追記(issue #59): read-only は review という task type の性質
  // であって実行エージェントの性質ではない(self RCA を含む)——ので、review
  // タスクの spawn は誰が assignee でも Edit/Write/NotebookEdit と Bash の
  // 書き込み系パターンを --disallowedTools に足す。
  it("review タスクの spawn は Edit / Write / NotebookEdit と Bash の書き込み系パターンを deny する(ADR 0013 追記 / issue #59)", async () => {
    const { start, calls } = await makeWorker();
    start("task-review-deny", null, "deckhand", "review");
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toContain("Workflow");
    expect(deny).toContain("Edit");
    expect(deny).toContain("Write");
    expect(deny).toContain("NotebookEdit");
    expect(deny).toContain("Bash(git push*)");
    expect(deny).toContain("Bash(rm*)");
  });

  it("self RCA(review タスクの assignee がレビュー対象の実行者そのもの)でも書き込み deny は外れない(ADR 0013: read-only は行為の性質であって行為者の性質ではない)", async () => {
    const { start, calls } = await makeWorker();
    // deckhand 自身が review タスクの assignee — self review でも例外なし
    start("task-self-rca", null, "deckhand", "review");
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toContain("Edit");
    expect(deny).toContain("Write");
  });

  it("work タスクの spawn には影響しない(deny は Workflow のみ)", async () => {
    const { start, calls } = await makeWorker();
    start("task-work-no-deny", null, "deckhand", "work");
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toEqual(["Workflow"]);
  });

  // ADR 0035 / issue #144: review の書き込み床は permission 層が担う。auto の
  // 判定は LLM 分類器でモデル判断なので床に数えない、という原則の実装面。
  it("review タスクの spawn は --permission-mode manual で走る(ADR 0035)", async () => {
    const { start, calls } = await makeWorker();
    start("task-review-manual", null, "deckhand", "review");
    expect(calls[0]!.args.join(" ")).toContain("--permission-mode manual");
  });

  // ADR 0038(issue #151 / #162): 床とは残余の既定である。`auto` の残余は分類器の
  // 自己承認(既定「はい」)で、ツール層(Read / Write / Edit …)にはサンドボックス
  // が届かない ——「ホスト上の読める物すべてを読め、書ける場所すべてに書ける」の
  // 正体がこれだった。`acceptEdits` は編集を通しつつ残余を承認要求に倒すので、
  // work は書けるまま cwd 外だけが閉じる。
  it("work タスクの spawn は --permission-mode acceptEdits で走る(ADR 0038)", async () => {
    const { start, calls } = await makeWorker();
    start("task-work-accept-edits", null, "deckhand", "work");
    expect(calls[0]!.args.join(" ")).toContain("--permission-mode acceptEdits");
  });

  it("盤面はどの task type でも auto を吐かない — 分類器は worker の床に一切関与しない(ADR 0038)", async () => {
    const { start, calls } = await makeWorker();
    start("task-no-auto-work", null, "deckhand", "work");
    start("task-no-auto-review", null, "deckhand", "review");
    for (const call of calls) {
      const mode = call.args[call.args.indexOf("--permission-mode") + 1];
      expect(mode).not.toBe("auto");
    }
  });

  // ADR 0038: permission の**マージ**は tier をまたぐので、flag tier のモード境界は
  // 人間の user tier(`~/.claude/settings.json`)と gitignore された local tier
  // (`<ws>/.claude/settings.local.json`)の `permissions.allow` に持ち上げられる
  // (両方とも control 付きで実測)。床はどちらの worker が走っているかを問わない
  // (ADR 0013)ので両プロファイルに付ける。`project` を残すのは workspace の
  // CLAUDE.md と skill がそこに乗るため — `""` / `user` はそれを道連れにする(ADR 0037)。
  it("両プロファイルの spawn が --setting-sources project で走る(ADR 0038)", async () => {
    const { start, calls } = await makeWorker();
    start("task-sources-work", null, "deckhand", "work");
    start("task-sources-review", null, "deckhand", "review");
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.args[call.args.indexOf("--setting-sources") + 1]).toBe("project");
    }
  });

  // ADR 0039(issue #145): ADR 0038 の床が届かない層 — ファイル操作でない
  // in-process ツール — を `--tools` の既定拒否で閉じる。期待値は実装を import せず
  // 独立した literal で書く(tests/spawn-tools.test.ts と同じ線): ここが確かめるのは
  // 「盤面が emit するフラグ列」までで、面が実際にそうなったかは実セッションの init
  // 行しか答えられない(ADR 0027)。
  it("work タスクの spawn は --tools に work の17本を渡す(ADR 0039 決定1)", async () => {
    const { start, calls } = await makeWorker();
    start("task-work-tools", null, "deckhand", "work");
    expect(spawnedTools(calls[0]!.args)).toEqual(WORK_SURFACE);
  });

  it("review タスクの spawn は --tools に review の14本を渡す — 編集系が面から消える(ADR 0039 決定2)", async () => {
    const { start, calls } = await makeWorker();
    start("task-review-tools", null, "deckhand", "review");
    expect(spawnedTools(calls[0]!.args)).toEqual(REVIEW_SURFACE);
  });

  it("--tools は空にならない — 空文字は CLI の綴りでは「全ツール無効」である", async () => {
    // `--help`(2.1.220): `""` で全ツール無効、`"default"` で全ツール。空の join が
    // 事故で通ると「床が立った」ではなく「何も呼べない worker」になり、しかも
    // モデルが何もせず終了したようにしか見えない。
    const { start, calls } = await makeWorker();
    start("task-tools-nonempty-work", null, "deckhand", "work");
    start("task-tools-nonempty-review", null, "deckhand", "review");
    for (const call of calls) {
      const value = call.args[call.args.indexOf("--tools") + 1];
      expect(value).toBeTruthy();
      // 次の引数を食わない: `--tools <tools...>` は可変長なので、値の直後は
      // 必ず別のフラグでなければならない
      expect(call.args[call.args.indexOf("--tools") + 2]).toMatch(/^--/);
    }
  });

  it("既定拒否なので、落としたツールは spawn の綴りのどこにも現れない(列挙 deny ではない)", async () => {
    // 列挙 deny(`--disallowedTools`)には執行力はあるが閉世界の仮定で、ベンダーが
    // 増やしたツールは開いたまま入ってくる(ADR 0039 測定3)。`CronCreate` を
    // deny の列に足したのではなく、allowlist に**書いていない**ことが塞ぎ方である。
    const { start, calls } = await makeWorker();
    start("task-tools-default-deny", null, "deckhand", "work");
    const spelled = calls[0]!.args.join(" ");
    for (const tool of ["CronCreate", "RemoteTrigger", "PushNotification", "EnterWorktree"]) {
      expect(spelled).not.toContain(tool);
    }
  });

  it("review タスクの spawn は tidepool MCP をサーバ単位で allow する — 無いと盤面への唯一の channel が承認待ちで詰まる", async () => {
    const { start, calls } = await makeWorker();
    start("task-review-mcp-allow", null, "deckhand", "review");
    expect(allowedTools(calls[0]!.args)).toEqual(["mcp__tidepool"]);
  });

  it("allow する permission subject の綴りは、同じ spawn が書いた mcp-config のサーバ名と一致する", async () => {
    // 一致は綴りの偶然ではなく成立条件: ズレれば review は盤面に一切触れられず、
    // しかも「モデルが何もせず終了した」ようにしか見えない(ADR 0035 事実2)。
    // 両側を別々の情報源(片や CLI 引数、片やディスク上の JSON)から読んで
    // 突き合わせる — 実装の定数を import して比べると同語反復になる。
    const { start, calls, logDir } = await makeWorker();
    const task = start("task-review-mcp-key", null, "deckhand", "review");
    const config = JSON.parse(
      await readFile(join(logDir, `${task.id}.mcp.json`), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    const [serverName] = Object.keys(config.mcpServers);
    expect(allowedTools(calls[0]!.args)).toContain(`mcp__${serverName}`);
  });

  it("workspace の review_allowed_commands が review spawn の --allowedTools に Bash パターンとして畳まれる", async () => {
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - npm test
`,
    });
    start("task-review-allowed-cmds", null, "deckhand", "review");
    expect(allowedTools(calls[0]!.args)).toEqual(["mcp__tidepool", "Bash(npm test*)"]);
  });

  // ADR 0038: `auto` を離れると MCP verb も全部承認待ちになり、盤面への唯一の
  // channel が詰まって work セッションが仕事にならない(ADR 0035 が review に
  // ついて測ったのと同じことが work にも起きる)。verb の権限は盤面側
  // (authority profile / MCP router)が縛るので、CLI 側で開けても権限モデルは
  // 緩まない。
  it("work タスクの spawn も tidepool MCP をサーバ単位で allow する(ADR 0038)", async () => {
    const { start, calls } = await makeWorker();
    start("task-work-mcp-allow", null, "deckhand", "work");
    expect(allowedTools(calls[0]!.args)).toEqual(["mcp__tidepool"]);
  });

  it("review_allowed_commands は work の spawn には効かない(allowlist は MCP サーバだけ)", async () => {
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:
  path: /home/pi/work/tidepool
  review_allowed_commands:
    - npm test
`,
    });
    start("task-work-no-allow", null, "deckhand", "work");
    // Bash の接頭辞 allow は review 専用のまま — work は元から書けるので何も買わず、
    // 開けば registry のデータが work の Bash 面を広げる経路になる。
    expect(allowedTools(calls[0]!.args)).toEqual(["mcp__tidepool"]);
  });

  // issue #56 / ADR 0025: skill access is the agent's frontmatter allowlist,
  // enforced at spawn as the complement deny of the CLI-enumerated full set.
  const skilledMd = (skillsYaml: string) =>
    `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\ndescription: General work agent for the tidepool board\nskills:\n${skillsYaml}---\nYou are Deckhand.\n`;

  it("skills が ['*'] の agent は列挙 ping を呼ばず、skill deny も付けない(Workflow のみ・ADR 0025 point 5)", async () => {
    const rec = recordingEnumerator(["code-review", "tdd"]);
    const { start, calls } = await makeWorker({}, { enumerateSkills: rec.enumerateSkills });
    start();
    expect(calls).toHaveLength(1);
    expect(rec.calls).toEqual([]); // '*' はゼロトークン ping すら不要
    expect(disallowedTools(calls[0]!.args)).toEqual(["Workflow"]);
    expect(calls[0]!.args).not.toContain("--disable-slash-commands");
  });

  it("skills が空リストの agent は列挙 ping を呼ばず --disable-slash-commands 一発で全禁止する(ADR 0025 point 5)", async () => {
    const rec = recordingEnumerator(["code-review", "tdd"]);
    const { start, calls } = await makeWorker(
      { "agents/deckhand.md": skilledMd("  []\n") },
      { enumerateSkills: rec.enumerateSkills },
    );
    start();
    expect(calls).toHaveLength(1);
    expect(rec.calls).toEqual([]);
    expect(calls[0]!.args).toContain("--disable-slash-commands");
  });

  it("有限の許可リストは列挙 ping の全集合から許可の補集合を Skill(名前) で deny する(ADR 0025 point 3)", async () => {
    const rec = recordingEnumerator(["code-review", "tdd", "grilling"]);
    const { start, calls } = await makeWorker(
      { "agents/deckhand.md": skilledMd("  - code-review\n") },
      { enumerateSkills: rec.enumerateSkills },
    );
    start();
    // ping はタスクの workspace cwd で走る
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(rec.calls).toEqual(["/home/pi/work/tidepool"]);
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toContain("Workflow");
    expect(deny).toContain("Skill(tdd)");
    expect(deny).toContain("Skill(grilling)");
    // 許可した skill は deny されない
    expect(deny).not.toContain("Skill(code-review)");
  });

  it("@workspace は checkout の .claude/skills 走査との差分でホスト由来(user + plugin)だけを deny する(ADR 0025)", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
    await mkdir(join(wsDir, ".claude", "skills", "tdd"), { recursive: true });
    await mkdir(join(wsDir, ".claude", "skills", "code-review"), { recursive: true });
    const rec = recordingEnumerator(["tdd", "code-review", "plug:deploy", "user-skill"]);
    const { start, calls } = await makeWorker(
      {
        "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`,
        "agents/deckhand.md": skilledMd('  - "@workspace"\n'),
      },
      { enumerateSkills: rec.enumerateSkills },
    );
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const deny = disallowedTools(calls[0]!.args);
    // checkout が運ぶ skill は許可、ホスト由来は deny
    expect(deny).toContain("Skill(plug:deploy)");
    expect(deny).toContain("Skill(user-skill)");
    expect(deny).not.toContain("Skill(tdd)");
    expect(deny).not.toContain("Skill(code-review)");
  });

  it("列挙 ping が失敗(null)したら spawn 失敗として扱い、deny 未解決のまま spawn しない(fail-open にしない・ADR 0025 point 6)", async () => {
    const rec = recordingEnumerator(null);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { start, calls } = await makeWorker(
        { "agents/deckhand.md": skilledMd("  - code-review\n") },
        { enumerateSkills: rec.enumerateSkills },
      );
      start("task-ping-fail");
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1));
      // 列挙は試みたが、その失敗で子プロセスは起動しない
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(calls).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("skill enumeration failed"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  // issue #60 / ADR 0033: 全 worker セッションはハーネス内蔵サンドボックスの
  // settings を per-task ファイルで受け取る(--mcp-config と同型)。ここは
  // 「配線」の seam — profile の中身そのものは sandbox-settings.test.ts。
  const sandboxSettings = (args: string[], logDir: string) => {
    const path = args[args.indexOf("--settings") + 1]!;
    expect(isAbsolute(path)).toBe(true);
    expect(path.startsWith(logDir)).toBe(true);
    return JSON.parse(readFileSync(path, "utf8")).sandbox;
  };

  it("spawn ごとに sandbox settings を per-task ファイルで書き、--settings で注入する(ADR 0033)", async () => {
    const { start, calls, logDir } = await makeWorker();
    start("task-sbx");
    const sandbox = sandboxSettings(calls[0]!.args, logDir);
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    // 起動できなかった場合の fail-open ハッチも閉じる(ベンダー既定は「警告して
    // 裸で走る」— ADR 0033 が唯一拒む状態)
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.filesystem.denyRead).toEqual(["~/"]);
    expect(sandbox.filesystem.allowRead).toContain("/home/pi/work/tidepool");
  });

  it("review タスクは allowWrite が空の profile で走る — profile は行為の性質(task.type)だけで決まり assignee によらない(ADR 0013)", async () => {
    const { start, calls, logDir } = await makeWorker();
    start("task-sbx-review", null, "deckhand", "review");
    expect(sandboxSettings(calls[0]!.args, logDir).filesystem.allowWrite).toEqual([]);
  });

  it("work タスクは workspace 内書き込みを許す profile で走る", async () => {
    const { start, calls, logDir } = await makeWorker();
    start("task-sbx-work", null, "deckhand", "work");
    expect(sandboxSettings(calls[0]!.args, logDir).filesystem.allowWrite).toEqual([
      "/home/pi/work/tidepool",
    ]);
  });

  it("有限の許可リストの agent は、許可された skill のディレクトリだけが allowRead に載る(拒否 skill のものは載らない・ADR 0033)", async () => {
    const rec = recordingEnumerator(["code-review", "tdd", "grilling"]);
    const { start, calls, logDir } = await makeWorker(
      { "agents/deckhand.md": skilledMd("  - code-review\n") },
      { enumerateSkills: rec.enumerateSkills },
    );
    start("task-sbx-skills");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const { allowRead } = sandboxSettings(calls[0]!.args, logDir).filesystem;
    expect(allowRead).toContain("~/.claude/skills/code-review");
    // ホスト側の skill ルートは開かない — 開けば拒否 skill の本文が cat で読める
    expect(allowRead).not.toContain("~/.claude/skills");
    expect(allowRead).not.toContain("~/.claude/plugins");
    expect(allowRead).not.toContain("~/.claude/skills/tdd");
    expect(allowRead).not.toContain("~/.claude/skills/grilling");
    // 注: workspace 側の同名エントリも配列には載らないが、そちらは allowRead が
    // workspace そのものを再帰的に開いている以上どのみち読める。この per-skill
    // 封じ込めが実効を持つのはホスト側だけ(workspace の中身は定義上、封じ込め
    // 境界の内側)。
  });

  it("workspace が自前の .claude/settings.json で sandbox を再定義していたら spawn せず workspace を quarantine する(issue #60: 床を自分で広げてから抜ける2セッション経路を塞ぐ)", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
    await mkdir(join(wsDir, ".claude"), { recursive: true });
    await writeFile(
      join(wsDir, ".claude", "settings.json"),
      JSON.stringify({ sandbox: { filesystem: { allowRead: ["/"] } } }),
    );
    const { start, calls, db } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`,
    });
    start("task-sbx-override");
    expect(calls).toEqual([]);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(true);
  });

  it("workspace が盤面の状態パスと重なっていたら spawn せず workspace を quarantine する(issue #149 / ADR 0040)", async () => {
    // 盤面の DB が workspace の checkout の中にある形 — worker の書き込み半径
    // (allowWrite: [workspace.path])に盤面の状態が入る、issue #149 の本体。
    const wsDir = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n` },
      { boardState: [{ label: "board database (TIDEPOOL_DB)", path: join(wsDir, "board.sqlite") }] },
    );
    start("task-overlap");
    expect(calls).toEqual([]);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(true);
    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.purpose).toContain("board database (TIDEPOOL_DB)");
  });

  it("盤面の状態パスと交差しない workspace は spawn を止めない", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
    const boardDir = await mkdtemp(join(tmpdir(), "tidepool-board-"));
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n` },
      { boardState: [{ label: "board database (TIDEPOOL_DB)", path: join(boardDir, "board.sqlite") }] },
    );
    start("task-no-overlap");
    expect(calls).toHaveLength(1);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
  });

  it("重なりの検査は settings ガードより先に走る(盤面自身の checkout は自前の .claude/settings.json を持つので、後だと診断名が入れ替わる)", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
    await mkdir(join(wsDir, ".claude"), { recursive: true });
    await writeFile(
      join(wsDir, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { allow: ["Bash(strings *)"] } }),
    );
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n` },
      { boardState: [{ label: "the board's own checkout (process cwd)", path: wsDir }] },
    );
    start("task-overlap-and-settings");
    expect(calls).toEqual([]);
    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.purpose).toContain("the board's own checkout (process cwd)");
    expect(question?.purpose).not.toContain("settings.local.json");
  });

  it("sandbox を含まない通常の project settings(hooks 等)は spawn を止めない", async () => {
    const wsDir = await mkdtemp(join(tmpdir(), "tidepool-ws-"));
    await mkdir(join(wsDir, ".claude"), { recursive: true });
    await writeFile(
      join(wsDir, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [] } }),
    );
    const { start, calls, db } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`,
    });
    start("task-sbx-plain-settings");
    expect(calls).toHaveLength(1);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
  });

  it("skills が空リストの agent は skill ディレクトリを一切開かない", async () => {
    const { start, calls, logDir } = await makeWorker({
      "agents/deckhand.md": skilledMd("  []\n"),
    });
    start("task-sbx-noskills");
    const { allowRead } = sandboxSettings(calls[0]!.args, logDir).filesystem;
    expect(allowRead.some((p: string) => p.includes(".claude/skills"))).toBe(false);
  });

  // ADR 0039 決定3 の**深層防御側**: 正本は封じ込め能力の `/usage` ping だが、盤面は
  // すでに worker の stdout を1行ずつパースしている(`parseResultLine`)ので、同じ
  // ループで init 行の `tools` も見る。追加コストは実質ゼロで、**実セッションその
  // ものを**測れる。不成立時は既存の封じ込め能力の経路にそのまま乗る(盤面全体の
  // pickup 停止 + Tidepool 名義の確認 question)。
  const initLine = (tools: string[]) =>
    `${JSON.stringify({ type: "system", subtype: "init", tools })}\n`;
  const containmentQuestion = (db: ReturnType<typeof openDb>) =>
    listBoard(db).find((t) => t.type === "question" && t.question_quarantine_sandbox !== null);

  it("宣言どおりの init 行なら何も起きない — 封じ込めの question は立たない", async () => {
    const { start, stdout, db } = await makeWorker();
    start("task-init-ok", null, "deckhand", "work");
    stdout.write(
      // 実セッションには MCP verb も並ぶ — 比較対象外
      initLine([...WORK_SURFACE, "mcp__tidepool__get_current_task"]),
    );
    await vi.waitFor(() => expect(containmentQuestion(db)).toBeUndefined());
  });

  it("init 行に allowlist 外のツールが並んでいたら封じ込め能力の question が立つ(ADR 0039 決定3)", async () => {
    const { start, stdout, db } = await makeWorker();
    start("task-init-drift", null, "deckhand", "work");
    // `CronCreate` は測定2 でそのまま実行できてしまったツールそのもの。`--tools` が
    // honor されていないホストでは、これが面に残る。
    stdout.write(initLine(["Bash", "Read", "CronCreate"]));
    const question = await vi.waitFor(() => {
      const q = containmentQuestion(db);
      expect(q).toBeDefined();
      return q!;
    });
    // 止まる資源も question も1つのまま(fs 半分・人間面と同じ1択の確認型)
    expect(question.question_items?.[0]!.options).toEqual(["repaired by hand"]);
    // 観測された具体名が本文に残る(「ずれた」ではなく「何がどうずれたか」)
    expect(question.purpose).toContain("CronCreate");
    expect(question.purpose).toContain("Glob");
  });

  it("ずれた面のセッションはそのまま走らせない — その場で kill する", async () => {
    // init 行はセッションの**開始直後**に出る(モデルが最初の tool_use を出す前)。
    // ここで止めるのは「走っている仕事を途中で殺す」ことではなく、ADR 0025 point 6 が
    // skill 列挙の失敗に対して取ったのと同じ「このセッションは走らせない」である。
    // 面が広い側にずれていればそれは worker が持つべきでない能力を持ったまま走る
    // ことであり、狭い側にずれていれば能力を1つ失ったまま詰まるだけである。どちらも
    // 走らせる理由がない。slot は watchdog が per-type 時限で回収する(既存の
    // 失敗経路)。
    const { start, stdout, killed } = await makeWorker();
    start("task-init-kill", null, "deckhand", "work");
    stdout.write(initLine(["Bash", "Read", "CronCreate"]));
    await vi.waitFor(() => expect(killed).toContain("SIGKILL"));
  });

  it("宣言どおりのセッションは kill されない", async () => {
    const { start, stdout, killed } = await makeWorker();
    start("task-init-nokill", null, "deckhand", "review");
    stdout.write(
      initLine([...REVIEW_SURFACE, "mcp__tidepool__get_current_task"]),
    );
    stdout.write(`{"type":"result","result":"done"}\n`);
    await vi.waitFor(() => expect(killed).toEqual([]));
  });

  it("review セッションの init 行は review の期待集合で照合される — 編集系が残っていたら不成立", async () => {
    const { start, stdout, db } = await makeWorker();
    start("task-init-review-drift", null, "deckhand", "review");
    stdout.write(
      initLine([...REVIEW_SURFACE, "Write"]),
    );
    const question = await vi.waitFor(() => {
      const q = containmentQuestion(db);
      expect(q).toBeDefined();
      return q!;
    });
    expect(question.purpose).toContain("Write");
  });

  it("ずれたまま何セッション走っても question は1枚(封じ込めは1資源につき確認1枚)", async () => {
    const { start, stdout, db } = await makeWorker();
    start("task-init-dup-1", null, "deckhand", "work");
    stdout.write(initLine(["Bash", "Read", "CronCreate"]));
    await vi.waitFor(() => expect(containmentQuestion(db)).toBeDefined());
    stdout.write(initLine(["Bash", "Read", "CronCreate"]));
    stdout.write(initLine(["Bash", "Read", "RemoteTrigger"]));
    await vi.waitFor(() =>
      expect(listBoard(db).filter((t) => t.type === "question")).toHaveLength(1),
    );
  });

  it("init 行を持たないセッションは判定しない — 盤面の照合は観測があったときだけ動く", async () => {
    // `tools` を持たない init 行、壊れた行、`result` 行は「init の報告ではない」と
    // 読む(`parseInitSkills` と同じ fail-closed の形)。ここで question を立てると、
    // 正本である `/usage` ping が答えるべき問いを stdout の欠落で代弁してしまう。
    const { start, stdout, db } = await makeWorker();
    start("task-init-absent", null, "deckhand", "work");
    stdout.write(`{"type":"system","subtype":"init"}\n`);
    stdout.write(`{"type":"result","result":"done"}\n`);
    stdout.write(`{not json\n`);
    await vi.waitFor(() => expect(containmentQuestion(db)).toBeUndefined());
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

  it("セッションの stderr を <taskId>.stderr.log として stream.jsonl の隣に全量保存する(issue #125)", async () => {
    const { start, stderr, logDir } = await makeWorker();
    start("task-stderr");
    stderr.write("Error: Invalid API key\n");
    stderr.write("(run /login to authenticate)\n");
    stderr.end();
    await vi.waitFor(async () => {
      const log = await readFile(join(logDir, "task-stderr.stderr.log"), "utf8");
      expect(log).toBe("Error: Invalid API key\n(run /login to authenticate)\n");
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
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nskills:\n  - "*"\ndescription: General work agent\nmodel: opus\n---\nYou are Deckhand.\n`,
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
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nskills:\n  - "*"\ndescription: General work agent\neffort: high\n---\nYou are Deckhand.\n`,
    });
    start();
    expect(calls[0]!.args.join(" ")).toContain("--effort high");
  });

  it("未知の effort 値は boot 時のコンストラクタで即座に失敗する(ADR 0005: CLI 側で閉じた集合はここで検証する)", async () => {
    const registryDir = await makeRegistry({
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nskills:\n  - "*"\ndescription: General work agent\neffort: super-fast\n---\nYou are Deckhand.\n`,
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
      "agents/deckhand.md": `---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nskills:\n  - "*"\ndescription: General work agent\neffort: ultracode\n---\nYou are Deckhand.\n`,
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

  it("checkUsage はプロンプト到達パターンを待ち、さらに入力ボックスが落ち着いてから /usage を送る(盲送りしない・描画直後の取りこぼしも避ける・ADR 0028)", async () => {
    const rec = recordingPty();
    const worker = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();

      // プロンプト未到達の間は何も送らない
      rec.emitData("Booting…\n");
      expect(rec.writes).toEqual([]);

      // 到達パターンが出ても、描いた直後は送らない(box が入力を取りこぼす)
      rec.emitData(PROMPT_READY_MARKER);
      expect(rec.writes).toEqual([]);

      // settle を過ぎたら、Enter 付きで /usage を一度だけ送る
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rec.writes.join("")).toContain("/usage");
      expect(rec.writes.join("")).toContain("\r");

      // パネルを描いて片付けさせ、テストがハングしないようにする
      rec.emitData("Current session: 10% used\nCurrent week: 5% used\n");
      await vi.advanceTimersByTimeAsync(1_000); // パネル debounce を発火
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage はパネル描画を捉えたら Ctrl-C×2 で終了させ、キャプチャした生テキストをそのまま返す(#80 は ANSI 除去を担う)", async () => {
    const rec = recordingPty();
    const worker = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();

      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(5_000); // settle を過ぎて /usage 送信
      // ANSI エスケープを含む生の描画をそのまま返すこと(除去は parseUsage の責務)
      const panel =
        "\x1b[1mCurrent session: 56% used · resets Jul 9 at 5:59pm\x1b[0m\n" +
        "Current week (all models): 12% used · resets Jul 14\n";
      rec.emitData(panel);
      await vi.advanceTimersByTimeAsync(1_000); // パネル debounce を発火

      await expect(pending).resolves.toContain(panel);
      // Ctrl-C×2 で畳んだうえで、捕捉不可な SIGKILL を backstop に送る
      // (孤児を残さないための保証は TUI の signal 処理に依存させない)
      expect(rec.writes.at(-1)).toBe("\x03\x03");
      expect(rec.kills).toContain("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage はパネルのヘッダ2行が出ても即断せず、描画が静穏化するまで待って後続チャンクの % / reset まで取り込む", async () => {
    const rec = recordingPty();
    const worker = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(5_000);

      // ヘッダ2行は出そろったが、% / reset 行はまだ後続チャンク
      rec.emitData("Current session\nCurrent week (all models)\n");
      // debounce 未満のうちに残りが届く(チャンク境界で数値が分断されるケース)
      await vi.advanceTimersByTimeAsync(200);
      rec.emitData("56% used\nResets Jul 9\n");
      await vi.advanceTimersByTimeAsync(1_000); // 静穏化 → 捕捉

      const raw = await pending;
      // 後続チャンクの数値まで取り込めている(ヘッダ即断なら失われていた)
      expect(raw).toContain("56% used");
      expect(raw).toContain("Resets Jul 9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage はパネル未描画のままタイムアウトしたら kill して null を返す(fail-closed・孤児を残さない)", async () => {
    vi.useFakeTimers();
    try {
      const rec = recordingPty();
      const worker = await makeUsageWorker(rec.pty);
      const pending = worker.checkUsage();

      // プロンプトには着いたが /usage パネルが返ってこない(CLI ハング相当)
      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(pending).resolves.toBeNull();
      // 孤児を残さない: 捕捉不可な SIGKILL で確実に落とす
      expect(rec.kills).toContain("SIGKILL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage はセッションがパネル前に終了(認証落ち・CLI 不在相当)したら null を返す", async () => {
    const rec = recordingPty();
    const worker = await makeUsageWorker(rec.pty);
    const pending = worker.checkUsage();

    rec.emitExit();

    await expect(pending).resolves.toBeNull();
  });

  it("checkUsage は spawn 自体が投げても(claude バイナリ不在)null に丸める", async () => {
    const failingPty: PtyFn = () => {
      throw new Error("claude binary not found");
    };
    const worker = await makeUsageWorker(failingPty);

    await expect(worker.checkUsage()).resolves.toBeNull();
  });

  it("checkUsage は board 自身の cwd で claude --safe-mode を、折り返しを避ける広い桁幅で起動する(ADR 0028)", async () => {
    const rec = recordingPty();
    const worker = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(5_000);
      rec.emitData("Current session: 1%\nCurrent week: 1%\n");
      await vi.advanceTimersByTimeAsync(1_000); // パネル debounce を発火
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.command).toBe("claude");
    expect(rec.calls[0]!.args).toContain("--safe-mode");
    expect(rec.calls[0]!.cwd).toBe(process.cwd());
    // 80桁折り返しで "Current session …" 行が分断されないよう十分広く取る
    expect(rec.calls[0]!.cols).toBeGreaterThan(80);
    // 使用量スクレイプも Board call(ADR 0044)。この呼び出しは人間のプロンプトを
    // 1文字も送らないのでモデルターンが立たず、今日は advisor が乗りようがない ——
    // が、それはベンダーの TUI の性質であって盤面が置いた性質ではないので、
    // 不在は他の Board call と同じく明示的に綴る。
    expect(rec.calls[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
    // ホストの TUI 設定に依らず fullscreen renderer を強制する(classic の
    // cursor-position 描画は ANSI 除去後に語が連結し parseUsage が読めない)
    const args = rec.calls[0]!.args;
    const settingsPath = args[args.indexOf("--settings") + 1]!;
    expect(settingsPath).toBeTruthy();
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ tui: "fullscreen" });
  });

  it("checkUsage は語間がカーソル移動(空白ではない)で描画されても、プロンプト到達とパネルを取りこぼさない(Pi の classic 相当・spaceless 照合)", async () => {
    const rec = recordingPty();
    const worker = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      // プレースホルダの語が ANSI カーソル移動で分断され、raw に "Try \"" が
      // 連続部分文字列として現れないケース
      rec.emitData('❯ Try\x1b[6G"refactor <filepath>"');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rec.writes.join("")).toContain("/usage"); // それでも送信された

      // パネルも "Current" と "session" がカーソル移動で分断される
      const spaceless = "Current\x1b[10Gsession\r\n34%used\r\nCurrent\x1b[10Gweek\r\n35%used\r\n";
      rec.emitData(spaceless);
      await vi.advanceTimersByTimeAsync(1_000);

      await expect(pending).resolves.toContain(spaceless); // 生テキストは verbatim
    } finally {
      vi.useRealTimers();
    }
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
      // stderr を一切書かず終わったセッション — 「stderr が無かった」ことが
      // null で残る(空文字とは違い、捕捉の欠落と区別できる — issue #125)
      stderr_tail: null,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: 10,
        cache_creation_tokens: 5,
        estimated_cost_usd: 0.1234,
        // issue #33: この agent には advisor capability が無いので、そもそも
        // 相談は起こりえない。既存欄の意味は変わっていない(トークンは main
        // モデル・親スレッドのみ、コストはセッション総額)。
        advisor: null,
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

  it("worker_exited イベントに stderr の末尾20行を stderr_tail として載せる(issue #125)", async () => {
    const { start, stderr, emitExit, db } = await makeWorker();
    start("task-stderr-tail");
    // 20行を超える stderr — イベントに載るのは末尾20行だけ
    const lines = Array.from({ length: 25 }, (_, i) => `stderr line ${i + 1}`);
    stderr.write(`${lines.join("\n")}\n`);
    emitExit(0, null);
    const exited = listEvents(db, "task-stderr-tail").find((e) => e.kind === "worker_exited");
    // 期待値は独立に書き下す(入力から slice で再計算すると実装と同じ誤りを
    // 共有しうる): 25行流したら 6〜25 行目の20行が残る
    expect(exited?.payload).toMatchObject({
      kind: "worker_exited",
      stderr_tail:
        "stderr line 6\nstderr line 7\nstderr line 8\nstderr line 9\nstderr line 10\n" +
        "stderr line 11\nstderr line 12\nstderr line 13\nstderr line 14\nstderr line 15\n" +
        "stderr line 16\nstderr line 17\nstderr line 18\nstderr line 19\nstderr line 20\n" +
        "stderr line 21\nstderr line 22\nstderr line 23\nstderr line 24\nstderr line 25",
    });
  });

  it("マルチバイト文字が chunk 境界で割れても stderr_tail に置換文字が混入しない(issue #125 code review)", async () => {
    const { start, stderr, emitExit, db } = await makeWorker();
    start("task-stderr-mb");
    // "認証" の2文字目(証)のバイト列の途中で chunk を切る
    const bytes = Buffer.from("認証エラー: トークン期限切れ\n");
    stderr.write(bytes.subarray(0, 4));
    stderr.write(bytes.subarray(4));
    emitExit(0, null);
    const exited = listEvents(db, "task-stderr-mb").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ stderr_tail: "認証エラー: トークン期限切れ" });
  });

  it("改行だけで実内容の無い stderr も stderr_tail null(空文字で「捕捉欠落」と紛れさせない — issue #125 code review)", async () => {
    const { start, stderr, emitExit, db } = await makeWorker();
    start("task-stderr-blank");
    stderr.write("\n");
    emitExit(0, null);
    const exited = listEvents(db, "task-stderr-blank").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ stderr_tail: null });
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
      stderr_tail: null,
      usage: null,
    });
  });

  // issue #127: Node's spawn() itself failing (ENOENT/EACCES/PATH misconfig)
  // fires "error" but never "exit", so worker_exited never gets written —
  // spawn_failed is the dedicated event that closes the pair worker_spawned
  // opened.
  it("spawn 自体が ENOENT で失敗(syscall が \"spawn\" で始まる)すると spawn_failed を error_code/message 付きで記録し running から消す(issue #127)", async () => {
    const { start, emitError, db, worker, killed } = await makeWorker();
    const task = start("task-spawn-enoent");
    const err = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
      syscall: "spawn claude",
    });
    emitError(err);
    const failed = listEvents(db, task.id).find((e) => e.kind === "spawn_failed");
    expect(failed?.worker_id).toBe("deckhand");
    expect(failed?.payload).toEqual({
      kind: "spawn_failed",
      error_code: "ENOENT",
      message: "spawn claude ENOENT",
    });
    // running から消えている: 死んだ子への kill は no-op のはずなので、
    // watchdog 相当の kill() を呼んでも子の kill() は一切呼ばれない
    worker.kill(task.id, "SIGKILL");
    expect(killed).toEqual([]);
  });

  it("spawn 族でない error(例: kill 失敗の syscall: \"kill\")は console.error のみで spawn_failed イベントは書かない(issue #127)", async () => {
    const { start, emitError, db } = await makeWorker();
    const task = start("task-non-spawn-error");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
      emitError(err);
      expect(listEvents(db, task.id).some((e) => e.kind === "spawn_failed")).toBe(false);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("使用中レジストリの commit hash を events に記録する(判断の来歴)", async () => {
    const { start, db, registryDir } = await makeWorker();
    const main = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir })
      .toString()
      .trim();
    start("task-9");
    const spawned = listEvents(db, "task-9").find((e) => e.kind === "worker_spawned");
    expect(spawned).toBeDefined();
    expect(spawned!.worker_id).toBe("deckhand");
    expect(spawned!.payload).toMatchObject({
      kind: "worker_spawned",
      registry_commit: main,
      definition_version: "0.3.1",
    });
  });

  it("当事者レビュー(self RCA)の spawn には、記録 hash 時点の agent 定義本文を証拠として注入する(ADR 0020 part 4)", async () => {
    const { worker, calls, db, registryDir } = await makeWorker();
    const git = registryGit(registryDir);
    // the version deckhand actually ran the objected task under
    const oldHash = git("rev-parse", "main");
    // main advances: the definition is refined after the objected call. The RCA
    // still runs on the current definition (ADR 0019), but must read the 当時版
    // as evidence — so current body and 当時版 body must be distinguishable.
    await writeFile(
      join(registryDir, "agents", "deckhand.md"),
      `---\nname: deckhand\ndescription: General work agent for the tidepool board\nversion: 0.4.0\nauthority: standard\nskills:\n  - "*"\n---\nYou are Deckhand, REFINED after the objected call.\n`,
    );
    git("add", "-A");
    git("commit", "-m", "refine deckhand");

    // the objected (parent) task, carrying deckhand's worker_spawned record and
    // the objected decision + the triage objection that anchors the RCA
    const objected = makeTask("objected-1", null, "deckhand", "work");
    insertTask(db, objected);
    appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: {
        kind: "worker_spawned",
        registry_commit: oldHash,
        definition_version: "0.3.1",
        advisor: null,
      },
      at: new FakeClock().now(),
    });
    const decisionId = appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "decision_logged", line: "chose approach X" },
      at: new FakeClock().now(),
    });
    appendEvent(db, {
      taskId: objected.id,
      workerId: "human",
      payload: { kind: "objection_raised", entry_id: decisionId, comment: "reconsider X", session_id: 1 },
      at: new FakeClock().now(),
    });

    // self RCA: concrete assignee = the historical worker, parent = objected
    const rca: Task = { ...makeTask("rca-1", null, "deckhand", "review"), parent_id: "objected-1" };
    insertTask(db, rca);
    worker.start(rca);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const prompt = args[args.indexOf("--append-system-prompt") + 1]!;
    // executes as the current definition (ADR 0019: repair is not a re-enactment)
    expect(prompt).toContain("REFINED after the objected call");
    // and the 当時版 body is injected as evidence for the "why did I decide" read
    expect(prompt).toContain("the tidepool board's general work agent");
  });

  it("同一 worker が objected task を複数回 spawn した場合、objected 判断時の session の版を注入し、後の再 spawn の版は使わない(ADR 0020 part 4)", async () => {
    const { worker, calls, db, registryDir } = await makeWorker();
    const git = registryGit(registryDir);
    // v1: the version live when the objected decision was made (fixture body)
    const v1Hash = git("rev-parse", "main");
    const objected = makeTask("objected-3", null, "deckhand", "work");
    insertTask(db, objected);
    // spawn 1 (v1) → objected decision → objection, all in that first session
    appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "worker_spawned", registry_commit: v1Hash, definition_version: "0.3.1", advisor: null },
      at: new FakeClock().now(),
    });
    const decisionId = appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "decision_logged", line: "chose approach X" },
      at: new FakeClock().now(),
    });
    appendEvent(db, {
      taskId: objected.id,
      workerId: "human",
      payload: { kind: "objection_raised", entry_id: decisionId, comment: "reconsider X", session_id: 1 },
      at: new FakeClock().now(),
    });
    // main advances and deckhand is refined; a LATER re-spawn (escalation return)
    // runs the objected task again under v2 — must not be mistaken for 当時版
    await writeFile(
      join(registryDir, "agents", "deckhand.md"),
      `---\nname: deckhand\ndescription: General work agent for the tidepool board\nversion: 0.4.0\nauthority: standard\nskills:\n  - "*"\n---\nYou are Deckhand, REFINED v2.\n`,
    );
    git("add", "-A");
    git("commit", "-m", "refine deckhand");
    const v2Hash = git("rev-parse", "main");
    appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "worker_spawned", registry_commit: v2Hash, definition_version: "0.4.0", advisor: null },
      at: new FakeClock().now(),
    });

    const rca: Task = { ...makeTask("rca-3", null, "deckhand", "review"), parent_id: "objected-3" };
    insertTask(db, rca);
    worker.start(rca);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const prompt = args[args.indexOf("--append-system-prompt") + 1]!;
    // the injected 当時版 evidence is v1 (the objected session), not the later v2
    // re-spawn — `.at(-1)` would have wrongly picked v2
    expect(prompt).toContain("the tidepool board's general work agent");
  });

  it("objected 判断が異なる版の session にまたがるとき、当時版は entry ごとに解決され、各版が entry id 付きで全部注入される(issue #87)", async () => {
    const { worker, calls, db, registryDir } = await makeWorker();
    const git = registryGit(registryDir);
    const objected = makeTask("objected-4", null, "deckhand", "work");
    insertTask(db, objected);
    // session 1 under v1 (fixture body) → objected decision 1
    const v1Hash = git("rev-parse", "main");
    appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "worker_spawned", registry_commit: v1Hash, definition_version: "0.3.1", advisor: null },
      at: new FakeClock().now(),
    });
    const decision1 = appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "decision_logged", line: "chose approach X" },
      at: new FakeClock().now(),
    });
    // main advances; session 2 (escalation return) under v2 → objected decision 2
    await writeFile(
      join(registryDir, "agents", "deckhand.md"),
      `---\nname: deckhand\ndescription: General work agent for the tidepool board\nversion: 0.4.0\nauthority: standard\nskills:\n  - "*"\n---\nYou are Deckhand, REFINED v2.\n`,
    );
    git("add", "-A");
    git("commit", "-m", "refine deckhand to v2");
    const v2Hash = git("rev-parse", "main");
    appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "worker_spawned", registry_commit: v2Hash, definition_version: "0.4.0", advisor: null },
      at: new FakeClock().now(),
    });
    const decision2 = appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "decision_logged", line: "chose approach Y" },
      at: new FakeClock().now(),
    });
    // objections land on entries from BOTH sessions
    for (const entryId of [decision1, decision2]) {
      appendEvent(db, {
        taskId: objected.id,
        workerId: "human",
        payload: { kind: "objection_raised", entry_id: entryId, comment: "reconsider", session_id: 1 },
        at: new FakeClock().now(),
      });
    }
    // main advances again: the RCA executes under v3, distinct from both 当時版
    await writeFile(
      join(registryDir, "agents", "deckhand.md"),
      `---\nname: deckhand\ndescription: General work agent for the tidepool board\nversion: 0.5.0\nauthority: standard\nskills:\n  - "*"\n---\nYou are Deckhand, REFINED v3 current.\n`,
    );
    git("add", "-A");
    git("commit", "-m", "refine deckhand to v3");

    const rca: Task = { ...makeTask("rca-4", null, "deckhand", "review"), parent_id: "objected-4" };
    insertTask(db, rca);
    worker.start(rca);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const prompt = args[args.indexOf("--append-system-prompt") + 1]!;
    // executes as the current definition (ADR 0019)
    expect(prompt).toContain("REFINED v3 current");
    // both 当時版 bodies are injected — neither session's version is folded away
    expect(prompt).toContain("Definitions under review");
    expect(prompt).toContain("the tidepool board's general work agent");
    expect(prompt).toContain("REFINED v2");
    // each version is labeled with the decision-log entry ids it was live for
    expect(prompt).toContain(
      `As of registry commit ${v1Hash.slice(0, 7)} — live for your objected entry #${decision1}`,
    );
    expect(prompt).toContain(
      `As of registry commit ${v2Hash.slice(0, 7)} — live for your objected entry #${decision2}`,
    );
    // full coverage: no evidence-gap note
    expect(prompt).not.toContain("no definition version could be resolved");
  });

  it("一部の objected entry の版が解決できないとき、解決できた版を注入した上で証拠の欠落を申告する(issue #87)", async () => {
    const { worker, calls, db, registryDir } = await makeWorker();
    const main = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir })
      .toString()
      .trim();
    const objected = makeTask("objected-5", null, "deckhand", "work");
    insertTask(db, objected);
    // session 1's spawn hash points at a commit the registry no longer has
    appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: {
        kind: "worker_spawned",
        registry_commit: "0000000000000000000000000000000000000000",
        definition_version: "0.2.0",
        advisor: null,
      },
      at: new FakeClock().now(),
    });
    const decision1 = appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "decision_logged", line: "chose approach X" },
      at: new FakeClock().now(),
    });
    // session 2 under the reachable main commit
    appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "worker_spawned", registry_commit: main, definition_version: "0.3.1", advisor: null },
      at: new FakeClock().now(),
    });
    const decision2 = appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "decision_logged", line: "chose approach Y" },
      at: new FakeClock().now(),
    });
    for (const entryId of [decision1, decision2]) {
      appendEvent(db, {
        taskId: objected.id,
        workerId: "human",
        payload: { kind: "objection_raised", entry_id: entryId, comment: "reconsider", session_id: 1 },
        at: new FakeClock().now(),
      });
    }

    const rca: Task = { ...makeTask("rca-5", null, "deckhand", "review"), parent_id: "objected-5" };
    insertTask(db, rca);
    worker.start(rca);

    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const prompt = args[args.indexOf("--append-system-prompt") + 1]!;
    // the resolvable version is injected, labeled with its entry
    expect(prompt).toContain(
      `As of registry commit ${main.slice(0, 7)} — live for your objected entry #${decision2}`,
    );
    // and the gap is declared, not silently absorbed
    expect(prompt).toContain(
      `no definition version could be resolved for your objected entry #${decision1}`,
    );
  });

  it("独立レビュー(assignee 未設定)の spawn には当時版定義を注入しない: 当事者レビューのみ(ADR 0020 part 4)", async () => {
    // an auditor agent so the unset-assignee review resolves and spawns
    const { worker, calls, db, registryDir } = await makeWorker(
      {
        "agents/auditor.md": `---\nname: auditor\ndescription: Independent reviewer\nversion: 1.0.0\nauthority: standard\nskills:\n  - "*"\n---\nYou are the Auditor.\n`,
      },
      { auditorName: "auditor" },
    );
    const oldHash = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir })
      .toString()
      .trim();
    const objected = makeTask("objected-2", null, "deckhand", "work");
    insertTask(db, objected);
    appendEvent(db, {
      taskId: objected.id,
      workerId: "deckhand",
      payload: { kind: "worker_spawned", registry_commit: oldHash, definition_version: "0.3.1", advisor: null },
      at: new FakeClock().now(),
    });
    // independent review: unset assignee → resolves to the Auditor pointer
    const audit: Task = { ...makeTask("audit-1", null, null, "review"), parent_id: "objected-2" };
    insertTask(db, audit);
    worker.start(audit);
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    const prompt = args[args.indexOf("--append-system-prompt") + 1]!;
    expect(prompt).toContain("You are the Auditor");
    // no deckhand definition body injected — the auditor's value is distance
    expect(prompt).not.toContain("general work agent");
  });

  it("registry チェックアウトがタスクブランチ上にあっても、記録する commit hash と版は main のもの(ADR 0020 part 3)", async () => {
    const { start, db, registryDir } = await makeWorker();
    const main = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir })
      .toString()
      .trim();
    const git = registryGit(registryDir);
    // branch discipline has the registry clone sitting on a registry-edit task
    // branch with an unmerged definition bump — must not leak into the record
    git("checkout", "-b", "task/bump");
    await writeFile(
      join(registryDir, "agents", "deckhand.md"),
      `---\nname: deckhand\ndescription: General work agent for the tidepool board\nversion: 9.9.9\nauthority: standard\nskills:\n  - "*"\n---\nYou are Deckhand.\n`,
    );
    git("add", "-A");
    git("commit", "-m", "unmerged bump");
    start("task-branch-spawn");
    const spawned = listEvents(db, "task-branch-spawn").find((e) => e.kind === "worker_spawned");
    expect(spawned!.payload).toMatchObject({
      kind: "worker_spawned",
      registry_commit: main,
      definition_version: "0.3.1",
    });
  });
});

/** issue #33: advisor capability。frontmatter の `advisor` が spawn の面まで
 *  届くか、不在・緊急マスク時に**確実に閉じる**か、そして「実際に走ったか」が
 *  worker_exited に残るか。実 CLI は使わず、既存の SpawnFn seam に fake stream を
 *  流す(ADR 0027 / ADR 0041 §4)。 */
describe("advisor capability (issue #33)", () => {
  const ADVISOR_MD = `---\nname: deckhand\ndescription: General work agent for the tidepool board\nversion: 0.3.1\nauthority: standard\nadvisor: opus\nskills:\n  - "*"\n---\nYou are Deckhand.\n`;
  const withAdvisor = { "agents/deckhand.md": ADVISOR_MD };

  /** `--advisor` に渡された値(フラグごと無ければ undefined)。 */
  const advisorFlag = (args: string[]): string | undefined => {
    const at = args.indexOf("--advisor");
    return at === -1 ? undefined : args[at + 1];
  };

  // ── 綴りの場所 ────────────────────────────────────────────────

  // `pinnedModelFlags` は**盤面自身の CLI 呼び出しとも共有されている**
  // (claude-draft-client.ts / claude-translation-client.ts)。ここに `--advisor` を
  // 足すと、下書きポーリングと表示時翻訳が1回ごとに上位モデルへ相談し始める —
  // worker の capability が盤面の内部処理に漏れる。共有ヘルパは worker 専用の
  // 能力を運ばない、という線をここで固定する。
  it("--advisor は共有の pinnedModelFlags には決して入らない(盤面自身の draft/翻訳呼び出しに漏らさない)", () => {
    expect(pinnedModelFlags("sonnet", "medium")).toEqual([
      "--model",
      "sonnet",
      "--effort",
      "medium",
    ]);
  });

  // ── frontmatter → spawn ──────────────────────────────────────

  it("frontmatter に advisor があれば --advisor でピン留めし、無効化 env は立てない(ADR 0005)", async () => {
    const { start, calls } = await makeWorker(withAdvisor);
    start();
    const call = calls[0]!;
    expect(advisorFlag(call.args)).toBe("opus");
    expect(call.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBeUndefined();
  });

  // #174 の鏡像の穴(ADR 0044 決定4)。spawn の env は盤面プロセスの env の上に組まれる
  // ので、ホストが1行 export しているだけで —— `/etc/default/tidepool` は人間が編集し
  // 盤面の env に直接流れ込む生きた面である —— registry が advisor を宣言した worker
  // から advisor が消え、`worker_spawned` は advisor 名を記録し続ける。実測
  // (2026-08-04): env は明示の `--advisor` フラグに**勝つ**ので、優先順位は理論では
  // ない。「立てない」ではなく「消す」でなければ塞げない。
  it("advisor があるとき、ホストが立てた CLAUDE_CODE_DISABLE_ADVISOR_TOOL を積極的に消す", async () => {
    const previous = process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL;
    process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = "1";
    try {
      const { start, calls } = await makeWorker(withAdvisor);
      start();
      const call = calls[0]!;
      expect(advisorFlag(call.args)).toBe("opus");
      expect(call.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBeUndefined();
      // git identity は env の上に重ねられる —— 消したキーを復活させないことと、
      // 重ね順を変えたことで identity 側が落ちていないことを1本で見る(issue #53)
      expect(call.env.GIT_AUTHOR_NAME).toBe("deckhand");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL;
      else process.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL = previous;
    }
  });

  // 「フィールド不在 = advisor なし」を**フラグを省くだけ**で綴ると、閉じるかどうかが
  // ホストの設定に委ねられる。実測(2026-08-04): workspace の checkout が持つ
  // `.claude/settings.json` の `advisorModel` は、本番と同じ `--setting-sources project`
  // の下で advisor を attach させる —— registry が「advisor なし」と言っている
  // セッションが上位モデルを焼き、判断6 の記録は「advisor なし」と書いたままになる。
  it("frontmatter に advisor が無ければフラグを渡さず、CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 で明示的に閉じる", async () => {
    const { start, calls } = await makeWorker();
    start();
    const call = calls[0]!;
    expect(advisorFlag(call.args)).toBeUndefined();
    expect(call.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  });

  // ── 判断8: グローバル kill switch ──────────────────────────────

  it("kill switch が立っていれば、frontmatter が advisor を持っていてもフラグを渡さず env で閉じる(判断8)", async () => {
    const { start, calls } = await makeWorker(withAdvisor, { advisorDisabled: true });
    start();
    const call = calls[0]!;
    expect(advisorFlag(call.args)).toBeUndefined();
    expect(call.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  });

  // マスクは agent.md を1枚も触らずに効く必要がある(判断8 の存在理由そのもの) —
  // registry 側は無傷のまま、盤面ホストの設定だけで全 worker が止まる。
  it("kill switch は registry を書き換えない — 同じ registry で off に戻せば advisor は復活する(判断8)", async () => {
    const masked = await makeWorker(withAdvisor, { advisorDisabled: true });
    masked.start("task-masked");
    expect(advisorFlag(masked.calls[0]!.args)).toBeUndefined();

    const unmasked = await makeWorker(withAdvisor);
    unmasked.start("task-unmasked");
    expect(advisorFlag(unmasked.calls[0]!.args)).toBe("opus");
  });

  // ── anthropics/claude-code#69238 の回避 env ────────────────────

  // ADR 0005 の「明示ピン留め」: これまで Pi の `/etc/default/tidepool` にあり、
  // registry からも盤面のコードからも見えない第二の正本になっていた。advisor の
  // 有無で分けない — ADR 0041 の `work` = 90分 は「10分の idle timeout が全
  // セッションに掛かっている」前提で書かれており、advisor off のセッションだけ
  // 前提が外れる形にしない。
  it("#69238 の回避 env(stream idle / API timeout)は advisor の有無に依らず全 spawn に立つ", async () => {
    const off = await makeWorker();
    off.start("task-no-advisor");
    const on = await makeWorker(withAdvisor);
    on.start("task-advisor");
    const masked = await makeWorker(withAdvisor, { advisorDisabled: true });
    masked.start("task-advisor-masked-env");
    for (const call of [off.calls[0]!, on.calls[0]!, masked.calls[0]!]) {
      expect(call.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("600000");
      expect(call.env.API_TIMEOUT_MS).toBe("600000");
    }
    // 同じ関数が組み立てる2つの関心が**独立している**ことを1箇所で測る:
    // advisor の口は3セルで開/閉/閉と動くのに、timeout は3セルとも同じ値で立つ。
    // 片方を advisor の有無に紐づける将来の編集は、ここで落ちる。
    expect([
      off.calls[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL,
      on.calls[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL,
      masked.calls[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL,
    ]).toEqual(["1", undefined, "1"]);
  });

  // ── 判断6 前半: worker_spawned は「盤面が何をピン留めしたか」 ──────

  it("worker_spawned は盤面がピン留めした advisor を記録する(判断6)", async () => {
    const { start, db } = await makeWorker(withAdvisor);
    start("task-spawn-advisor");
    const spawned = listEvents(db, "task-spawn-advisor").find((e) => e.kind === "worker_spawned");
    expect(spawned!.payload).toMatchObject({ kind: "worker_spawned", advisor: "opus" });
  });

  // registry_commit があるので frontmatter の文字列は後から引ける。**イベント履歴
  // だけで**確定できないのはホスト側のマスクのほうなので、記録するのは「盤面が
  // 実際にピン留めした値」— マスク下は null に畳まれる。
  it("advisor 不在の agent と kill switch 下は、どちらも worker_spawned.advisor が null(判断6)", async () => {
    const plain = await makeWorker();
    plain.start("task-plain");
    const masked = await makeWorker(withAdvisor, { advisorDisabled: true });
    masked.start("task-masked-event");
    for (const [w, id] of [
      [plain, "task-plain"],
      [masked, "task-masked-event"],
    ] as const) {
      const spawned = listEvents(w.db, id).find((e) => e.kind === "worker_spawned");
      expect(spawned!.payload).toMatchObject({ kind: "worker_spawned", advisor: null });
    }
  });

  // ── 判断6 後半: worker_exited は「実際に走ったか」 ────────────────

  /** 実測(2026-08-04)の gate セルをそのまま写した result 行: main sonnet ×
   *  advisor opus、`usage` は main のみ・`total_cost_usd` は全モデル合計、
   *  `usage.iterations` の `advisor_message` だけが解決済み id を名指しする。 */
  const resultLine = (over: Record<string, unknown> = {}) =>
    `${JSON.stringify({
      type: "result",
      result: "done",
      total_cost_usd: 0.2999,
      usage: {
        input_tokens: 4,
        output_tokens: 31,
        cache_read_input_tokens: 61644,
        cache_creation_input_tokens: 13114,
        iterations: [
          { type: "message" },
          { type: "advisor_message", model: "claude-opus-5", input_tokens: 38484, output_tokens: 313 },
          { type: "message" },
        ],
      },
      modelUsage: {
        "claude-sonnet-5": { inputTokens: 4, outputTokens: 31, costUSD: 0.0968847 },
        "claude-opus-5": { inputTokens: 38484, outputTokens: 313, costUSD: 0.200245 },
      },
      ...over,
    })}\n`;

  const consultation = (id: string) =>
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "server_tool_use", id, name: "advisor", input: {} },
          { type: "advisor_tool_result", tool_use_id: id, content: { type: "advisor_redacted_result" } },
        ],
      },
    })}\n`;

  const initLine = (model: string) =>
    `${JSON.stringify({ type: "system", subtype: "init", model })}\n`;

  const usageOf = (db: ReturnType<typeof openDb>, id: string) => {
    const exited = listEvents(db, id).find((e) => e.kind === "worker_exited");
    const payload = exited!.payload as Extract<EventPayload, { kind: "worker_exited" }>;
    return payload.usage;
  };

  it("相談が観測されたセッションは、解決済み advisor id・相談回数・分離した消費を記録する(判断6)", async () => {
    const { start, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-usage");
    stdout.write(initLine("claude-sonnet-5"));
    stdout.write(consultation("srvtoolu_01"));
    stdout.write(resultLine());
    emitExit(0, null);
    expect(usageOf(db, "task-advisor-usage")).toEqual({
      // 既存欄の意味は**変えない** — トークンは main モデル・親スレッドのみ、
      // コストはセッション総額(advisor 込み)。過去行との比較可能性を守る。
      input_tokens: 4,
      output_tokens: 31,
      cache_read_tokens: 61644,
      cache_creation_tokens: 13114,
      estimated_cost_usd: 0.2999,
      advisor: {
        model: "claude-opus-5",
        consultations: 1,
        usage: { input_tokens: 38484, output_tokens: 313, estimated_cost_usd: 0.200245 },
      },
    });
  });

  // コストだけでは「長い会話で1回」と「短い会話で3回」が区別できないので、回数は
  // usage とは独立に数える。数え上げは既に1行ずつ読んでいる stdout から取れる。
  it("相談回数は stream 中の server_tool_use(advisor) の本数を数える(判断6)", async () => {
    const { start, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-count");
    stdout.write(initLine("claude-sonnet-5"));
    stdout.write(consultation("srvtoolu_01"));
    stdout.write(consultation("srvtoolu_02"));
    stdout.write(consultation("srvtoolu_03"));
    stdout.write(resultLine());
    emitExit(0, null);
    expect(usageOf(db, "task-advisor-count")?.advisor).toMatchObject({ consultations: 3 });
  });

  // 通常の tool_use(MCP verb 等)を advisor と数え間違えない — 数えるのは
  // `server_tool_use` かつ name が advisor のものだけ。
  it("通常の tool_use は相談として数えない", async () => {
    const { start, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-noise");
    stdout.write(initLine("claude-sonnet-5"));
    stdout.write(
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "advisor", input: {} }] },
      })}\n`,
    );
    stdout.write(consultation("srvtoolu_01"));
    stdout.write(resultLine());
    emitExit(0, null);
    expect(usageOf(db, "task-advisor-noise")?.advisor).toMatchObject({ consultations: 1 });
  });

  // 判断6 の眼目。能力不足の advisor は exit 0 で完走し、stderr に警告1行を残して
  // 未 attach のまま終わる —— 盤面から見て成功セッションと区別が付かない。
  // `advisor: null` が、そのセッションで advisor が**走らなかった**ことを言う。
  it("advisor をピン留めしても相談が1本も観測されなければ usage.advisor は null(判断6)", async () => {
    const { start, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-silent");
    stdout.write(initLine("claude-sonnet-5"));
    stdout.write(resultLine({ modelUsage: { "claude-sonnet-5": { costUSD: 0.09 } }, usage: {
      input_tokens: 4,
      output_tokens: 31,
      cache_read_input_tokens: 61644,
      cache_creation_input_tokens: 13114,
    } }));
    emitExit(0, null);
    expect(usageOf(db, "task-advisor-silent")?.advisor).toBeNull();
  });

  // 「設定されていて一度も相談しなかった」と「設定されたが未 attach のまま走った」は
  // どちらも上の null になる。両者を分ける唯一の材料は stderr の警告1行であり、
  // 盤面はそれを**正規表現で判定しない**(黙って劣化する検出器は #172 が拒んだ形
  // そのもの)。証拠は stderr_tail に verbatim で残る、という形で保つ。
  it("未 attach の警告は判定に使わず、stderr_tail に verbatim で残す(判断3)", async () => {
    const { start, stderr, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-warning");
    // 実測の文言(main opus × advisor sonnet のセル)
    const warning =
      '"sonnet" cannot advise "claude-opus-5" (the advisor must be at least as ' +
      "capable as the main model). The advisor will not be used for the main model.";
    stderr.write(`${warning}\n`);
    stdout.write(initLine("claude-sonnet-5"));
    stdout.write(resultLine({ usage: {
      input_tokens: 4,
      output_tokens: 31,
      cache_read_input_tokens: 61644,
      cache_creation_input_tokens: 13114,
    } }));
    emitExit(0, null);
    const exited = listEvents(db, "task-advisor-warning").find((e) => e.kind === "worker_exited");
    expect(exited!.payload).toMatchObject({ exit_code: 0, stderr_tail: warning });
    expect(usageOf(db, "task-advisor-warning")?.advisor).toBeNull();
  });

  // 同一モデルペアでは `modelUsage` が1キーに合算されて消費を分離できない(実測)。
  // そのときの usage は 0 ではなく null —— 「測れなかった」を 0 に化けさせない
  // (`usage: null` が「セッションは走ったが report が無い」を表すのと同じ形)。
  // 回数だけは数えられるので `consultations` は usage の外に出してある。
  it("main と advisor が同じモデルに解決されたら usage は null(0 ではない)", async () => {
    const { start, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-same-model");
    stdout.write(initLine("claude-sonnet-5"));
    stdout.write(consultation("srvtoolu_01"));
    stdout.write(
      resultLine({
        usage: {
          input_tokens: 4,
          output_tokens: 31,
          cache_read_input_tokens: 61644,
          cache_creation_input_tokens: 13114,
          iterations: [
            { type: "advisor_message", model: "claude-sonnet-5", input_tokens: 35202, output_tokens: 59 },
          ],
        },
        modelUsage: { "claude-sonnet-5": { inputTokens: 35206, outputTokens: 90, costUSD: 0.1463895 } },
      }),
    );
    emitExit(0, null);
    expect(usageOf(db, "task-advisor-same-model")?.advisor).toEqual({
      model: "claude-sonnet-5",
      consultations: 1,
      usage: null,
    });
  });

  // `usage.iterations` は**最終ターンぶんしか出ない**(実測)。最後の相談が最終
  // ターンより前だったセッションでは解決済み id がどこにも残らないので、model は
  // null になる。`modelUsage` のキーから引き算する手は使えない —— キーは
  // {内部 haiku, main, advisor} になりうる(実測)ので、main を引いても1つに
  // 定まらない。名前表もキャッシュ量のヒューリスティックも、黙って外れる形なので採らない。
  it("最終ターンに相談が無ければ解決済み id は残らない — model は null、相談回数は残る", async () => {
    const { start, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-earlier-turn");
    stdout.write(initLine("claude-sonnet-5"));
    stdout.write(consultation("srvtoolu_01"));
    stdout.write(
      resultLine({
        usage: {
          input_tokens: 2,
          output_tokens: 5,
          cache_read_input_tokens: 37208,
          cache_creation_input_tokens: 342,
          iterations: [{ type: "message" }],
        },
        modelUsage: {
          "claude-haiku-4-5-20251001": { costUSD: 0.00063 },
          "claude-sonnet-5": { inputTokens: 4, outputTokens: 31, costUSD: 0.0744852 },
          "claude-opus-5": { inputTokens: 38484, outputTokens: 313, costUSD: 0.18467 },
        },
      }),
    );
    emitExit(0, null);
    expect(usageOf(db, "task-advisor-earlier-turn")?.advisor).toEqual({
      model: null,
      consultations: 1,
      usage: null,
    });
  });

  // main モデルの解決先が分からなければ、**分離できるかどうかも分からない** ——
  // advisor と main が同じ id に解決されていれば `modelUsage` のそのキーは合算済み
  // なので、読めば advisor の消費として合算値を publish してしまう。init 行を
  // 観測できなかったセッション(壊れた行・`model` を持たない init)はこの状態に
  // なる。「測れなかった」を誤った値に化けさせない。
  it("main モデルの解決先が観測できていなければ usage は null(分離可否そのものが不明)", async () => {
    const { start, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-no-init");
    // init 行を一切流さない
    stdout.write(consultation("srvtoolu_01"));
    stdout.write(resultLine());
    emitExit(0, null);
    expect(usageOf(db, "task-advisor-no-init")?.advisor).toEqual({
      model: "claude-opus-5",
      consultations: 1,
      usage: null,
    });
  });

  // `modelUsage` を持たない result 行(古い CLI・壊れた行)でも、相談の事実と回数は
  // stream 側から取れている。ここで throw して usage 全体を失わない。
  it("modelUsage を持たない result 行でも相談の事実は失わない", async () => {
    const { start, stdout, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-no-modelusage");
    stdout.write(initLine("claude-sonnet-5"));
    stdout.write(consultation("srvtoolu_01"));
    stdout.write(
      `${JSON.stringify({
        type: "result",
        result: "done",
        total_cost_usd: 0.3,
        usage: {
          input_tokens: 4,
          output_tokens: 31,
          cache_read_input_tokens: 61644,
          cache_creation_input_tokens: 13114,
        },
      })}\n`,
    );
    emitExit(0, null);
    expect(usageOf(db, "task-advisor-no-modelusage")).toMatchObject({
      estimated_cost_usd: 0.3,
      advisor: { model: null, consultations: 1, usage: null },
    });
  });

  // 未知のモデルは exit 1・stdout 完全に空(実測)。result 行が無いので usage は
  // null のまま —— `advisor` 欄が生えるのは usage がある行だけであり、欠測が
  // 「advisor なしで走った」に化けない。
  it("stdout が空のまま exit 1 したセッションは usage null のまま(advisor 欄も生えない)", async () => {
    const { start, stderr, emitExit, db } = await makeWorker(withAdvisor);
    start("task-advisor-exit1");
    stderr.write('Error: The model "haiku" cannot be used as an advisor.\n');
    emitExit(1, null);
    const exited = listEvents(db, "task-advisor-exit1").find((e) => e.kind === "worker_exited");
    expect(exited!.payload).toMatchObject({
      exit_code: 1,
      usage: null,
      stderr_tail: 'Error: The model "haiku" cannot be used as an advisor.',
    });
  });
});
