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
  type SpawnFn,
} from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
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
  const calls: Array<{ command: string; args: string[]; cwd: string; cols: number }> = [];
  const writes: string[] = [];
  const kills: Array<string | undefined> = [];
  let dataListener: ((data: string) => void) | undefined;
  let exitListener: (() => void) | undefined;
  const pty: PtyFn = (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, cols: opts.cols });
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

  it("skills が空リストの agent は skill ディレクトリを一切開かない", async () => {
    const { start, calls, logDir } = await makeWorker({
      "agents/deckhand.md": skilledMd("  []\n"),
    });
    start("task-sbx-noskills");
    const { allowRead } = sandboxSettings(calls[0]!.args, logDir).filesystem;
    expect(allowRead.some((p: string) => p.includes(".claude/skills"))).toBe(false);
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
      payload: { kind: "worker_spawned", registry_commit: v1Hash, definition_version: "0.3.1" },
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
      payload: { kind: "worker_spawned", registry_commit: v2Hash, definition_version: "0.4.0" },
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
      payload: { kind: "worker_spawned", registry_commit: v1Hash, definition_version: "0.3.1" },
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
      payload: { kind: "worker_spawned", registry_commit: v2Hash, definition_version: "0.4.0" },
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
      payload: { kind: "worker_spawned", registry_commit: main, definition_version: "0.3.1" },
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
      payload: { kind: "worker_spawned", registry_commit: oldHash, definition_version: "0.3.1" },
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
