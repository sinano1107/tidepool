import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { agentNeedsHuman } from "../src/agent.js";
import type { BoardCall, BoardCallSpec } from "../src/board-call.js";
import { boardHalts } from "../src/board-halt.js";
import { boardDoctrine, fenced, type PromptPart } from "../src/board-prose.js";
import { POSTURE_FLAGS } from "../src/claude-board-call-spec.js";
import {
  agentGitIdentityEnv,
  ClaudeCodeWorker,
  type EnumerateSkillsFn,
  enumerateHostSkills,
  enumerateToolsThrough,
  enumerateWorkspaceSkills,
  execThrough,
  PROMPT_READY_MARKER,
  pinnedModelFlags,
  toolSurfaceProbeSpec,
} from "../src/claude-worker.js";
import { type Db, openDb } from "../src/db.js";
import { DEFAULT_AUDITOR_NAME, DEFAULT_INTERVIEWER_NAME } from "../src/defaults.js";
import { appendEvent, type EventPayload, listEvents } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor } from "../src/execution-setting.js";
import { BOARD_WRITE_LANGUAGE_RULE } from "../src/mcp.js";
import { buildMemoryInjection, buildMetaReviewMaterial, humanEntryInput, type InjectionQuery, recordBehavior, recordKnowledge } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { listEpisodes, projectionPending } from "../src/precedent.js";
import { ProcessContainers, type PtyFn } from "../src/process-container.js";
import { FAILED_TEARDOWN_QUESTION_TITLE } from "../src/quarantine.js";
import {
  loadRegistry,
  REVIEWER_AUTHORITY_PROFILE,
  type Registry,
  type RegistryMode,
  refreshRegistry,
  registryRef,
} from "../src/registry.js";
import { Slot } from "../src/slot.js";
import { getTask, HUMAN_ROSTER_AGENT, interviewRoomPath, listBoard, nextSlotTask, pickupTask, poseProbe, registerTask, resolveTaskAgent, type Task } from "../src/tasks.js";
import { acceptTeardownQuarantine, sessionInTeardown } from "../src/teardown.js";
import { getProviderUsage, reportProviderUsage } from "../src/throttle.js";
import { TranscriptStore } from "../src/transcript-store.js";
import { RECLAIM_TIMEOUT, spawnFailureHandler, startWatchdog } from "../src/watchdog.js";
import type { WorkerExit } from "../src/worker.js";
import {
  excludeWorkspaceProjectSettings,
  prepareWorkspaceAtPickup,
  projectSettingsHiddenByBoard,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import {
  containerHarness,
  definitionPart,
  FakeClock,
  FakeContainerRuntime,
  noSkillPings,
  passthroughContainers,
  recordingPty,
  recordingSpawn,
  recordPrompt,
  ScriptedWorker,
  specRecordingCall,
} from "./fakes.js";
import { failQuarantineQuestion, failTeardownMark, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, openTestExamineeCheckout, openTestInterviewRoom, POSED_HEAD, poseAccepted, quarantineQuestion, unhandledRejectionsDuring, WORKER_SPAWNED } from "./harness.js";
import { FIXTURE_WORKSPACE, makeRegistry, makeRemoteBackedRegistry, writeUnannounced } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

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
    review_by: null,
    review_tier: null,
    tier: null,
    priority: null,
    parent_id: null,
    based_on_decision: null,
    premise_breach_decision: null,
    sort_key: 1,
    handoff_doc: null,
    pr_number: null,
    question_items: null,
    question_answer: null,
    question_answer_comment: null,
    question_cancel_option: null,
    question_breached_decision: null,
    question_broken_probe_reason: null,
    question_pending_child: null,
    question_proposal: null,
    question_pending_merge_pr: null,
    question_pending_local_merge_task_id: null,
    question_pending_pr_promotion_task_id: null,
    question_quarantine_kind: null,
    question_quarantine_value: null,
    question_cli_auth_expiry: null,
    question_stop_reason_task_id: null,
    github_issue_number: null,
    meta_review_subject: null,
    interview_target_id: null,
    created_at: "2026-07-08T00:00:00.000Z",
  };
}

/** Events reference tasks by FK, so a started task must exist on the board. */
function insertTask(db: ReturnType<typeof openDb>, task: Task): void {
  db.prepare(
    `INSERT INTO tasks (id, type, status, assignee, workspace, title, purpose, completion_criteria,
       risk_flag, review_flag, sort_key, created_at, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    task.parent_id,
  );
}

const loadedRegistries = new Map<string, Registry>();

/** scheduler が pickup の瞬間に選ぶ実行設定(除外なし)。assignee が registry で解決
 *  できない task は adapter が設定を読む前に quarantine するので、既定 agent の設定で足りる。 */
function pickedSetting(
  db: ReturnType<typeof openDb>,
  registry: { dir: string; mode: RegistryMode },
  task: Task,
  agent = "deckhand",
  auditorName = DEFAULT_AUDITOR_NAME,
) {
  // 同じ commit の registry を start ごとに読み直さない(issue #983)。鍵に解決済みの
  // commit を含めるので、makeWorker の後に積んだ commit は読み直す
  const commit = execFileSync("git", ["rev-parse", registryRef(registry.mode)], { cwd: registry.dir })
    .toString()
    .trim();
  const key = `${registry.dir}@${commit}`;
  const loaded = loadedRegistries.get(key) ?? loadRegistry(registry.dir, registry.mode);
  loadedRegistries.set(key, loaded);
  const { agents } = loaded;
  return executionSettingsFor(db, (agents[resolveTaskAgent(task, agent, auditorName, DEFAULT_INTERVIEWER_NAME)] ?? agents[agent])!, task)[0]!;
}

/** The registry fixture's deckhand body — what a spawn of deckhand records as its `definition` part. */
const DECKHAND_BODY = "You are Deckhand, the tidepool board's general work agent.\nWork only through the tidepool MCP verbs.";

/** The reviewer constant's Authority part as a review's spawn records it (ADR 0314 決定5). */
const REVIEWER_AUTHORITY_PART: PromptPart = { part: "authority", text: `\n\n## Authority\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}`, source: "reviewer" };

/** The objected task's record a self RCA anchors on (ADR 0020 part 4): `actorId`
 *  spawned (recording `system` as its prompt), logged one decision, and a human objected to it. */
function objectDecisionAt(db: Db, logDir: string, taskId: string, actorId: string, system: PromptPart[]): number {
  const at = new FakeClock().now();
  const spawned = appendEvent(db, { taskId, actorId, origin: "board", payload: WORKER_SPAWNED, at });
  recordPrompt(logDir, taskId, spawned, system);
  const entryId = appendEvent(db, {
    taskId,
    actorId,
    origin: "worker",
    payload: { kind: "decision_logged", line: "chose approach X" },
    at,
  });
  appendEvent(db, {
    taskId,
    actorId: "human",
    origin: "webui",
    payload: { kind: "objection_raised", entry_id: entryId, comment: "reconsider X", session_id: 1 },
    at,
  });
  return entryId;
}

/** self RCA の fixture は、親の異議を登録材料として持つ(ADR 0171 決定1)。 */
function insertSelfRca(db: Db, rca: Task): void {
  insertTask(db, rca);
  appendEvent(db, { taskId: rca.id, actorId: "human", origin: "webui", at: new FakeClock().now(), payload: {
    kind: "task_registered", type: "review", title: rca.title,
    opened_on_event_ids: listEvents(db, rca.parent_id!).filter((event) => event.kind === "objection_raised").map((event) => event.id),
  } });
}

/** `taskId` の判断の行1つと、それへの異議を置き、異議の event id を返す(setup)。 */
function objectionOn(db: Db, taskId: string): number {
  const at = new FakeClock().now();
  const entryId = appendEvent(db, { taskId, actorId: "deckhand", origin: "worker", payload: { kind: "decision_logged", line: "accepted" }, at });
  return appendEvent(db, { taskId, actorId: "human", origin: "webui", payload: { kind: "objection_raised", entry_id: entryId, comment: "too loose", session_id: 1 }, at });
}

/** A git runner pinned to the registry fixture clone, identity flags inlined
 *  so fixture commits need no global config. */
function registryGit(cwd: string) {
  return (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
}

/** A worker wired to a fake PTY, for the checkUsage scrape tests. The container
 *  runtime is the fake one so the mouth's force reclaims are observable, and the
 *  mouth counts its limit on `clock` (checkUsage's own timers are setTimeout). */
async function makeUsageWorker(pty: PtyFn) {
  const registryDir = await makeRegistry();
  const logDir = await tempDir("tidepool-worker-logs-");
  const clock = new FakeClock();
  const runtime = new FakeContainerRuntime();
  const worker = new ClaudeCodeWorker({
    db: openDb(":memory:"),
    clock,
    registry: { dir: registryDir, mode: "purely-local" },
    agent: "deckhand",
    workspace: "tidepool",
    mcpUrl: "http://127.0.0.1:4589/mcp",
    logDir,
    transcripts: new TranscriptStore(logDir),
    ...containerHarness(new ProcessContainers(runtime), clock),
    pty,
  });
  return { worker, runtime, clock };
}

async function makeWorker(
  registryFiles: Record<string, string> = {},
  extraOptions: Partial<ConstructorParameters<typeof ClaudeCodeWorker>[0]> = {},
  /** 上限到達による中断(ADR 0104)の tree rule が引く resolver。既定は workspace
   *  追跡の無い盤面 = tree rule は no-op。 */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig,
) {
  const registryDir = await makeRegistry(registryFiles);
  // 後始末の待ち責務(spawn 本数ぶんのログ open を待つ)はこの fixture に置く(issue #908)。
  // onTestFinished は後から積んだものが先に走るので、下の待ちが済んでから `tempDir` が消す。
  const logDir = await tempDir("tidepool-worker-logs-");
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const slot = new Slot();
  const recorder = recordingSpawn();
  // 容器 supervisor はテストが差し替えうる。Board call の口は**その**supervisor
  // から組む —— 既定から組むと、テストが hold した容器と launch の門が見る帳簿が
  // ずれて、門が効いていなくてもテストが緑になる。
  const containers = extraOptions.containers ?? passthroughContainers(recorder.spawn);
  onTestFinished(async () => {
    // spawn 1回ごとに worker は stream.jsonl / stderr.log の2本を非同期に open
    // する(issue #908)。open が rm と競合すると ENOTEMPTY / ENOENT になるので、
    // spawn 本数ぶんのファイルが揃うまで待ってから消す。揃わなければ諦めて消す
    // (`vi.waitFor` は条件待ちで、タイムアウトしても投げるだけでハングしない)。
    // 本数は `recorder` でなく worker_spawned で数える —— containers を差し替える
    // テストは fixture の recorder を通らずに spawn する。数えるのは worker 自身が
    // 書いた origin = 'board' だけ —— 当時版注入のテスト(ADR 0020 part 4)が手で
    // 積む過去 session の worker_spawned はファイルを作らないので、数えると揃わない
    // ファイルを timeout まで待つことになる(issue #983)。
    const { n } = db
      .prepare(
        "SELECT COUNT(*) AS n FROM events WHERE kind = 'worker_spawned' AND origin = 'board'",
      )
      .get() as { n: number };
    const want = n * 2;
    if (want > 0) {
      await vi
        .waitFor(
          async () => {
            const files = await readdir(logDir).catch(() => []);
            const ready = files.filter(
              (name) => name.endsWith(".stream.jsonl") || name.endsWith(".stderr.log"),
            ).length;
            expect(ready).toBeGreaterThanOrEqual(want);
          },
          { timeout: 2_000, interval: 20 },
        )
        .catch(() => {});
    }
  });
  // 多くの test が exit を撃たないまま終わる —— task temp の後始末は exit / spawn-error 経路止まりなので、
  // 本番と同じ exit 経路で消す(ADR 0257。Codex 側の issue #1001 と同じ形)。上の待ちより先に走る
  onTestFinished(() => recorder.emitExit(0, null));
  // 資源の停止で spawn まで届かなかった pickup の盤面側の一撃(ADR 0274)の呼び出し
  const stops: Array<[string, unknown]> = [];
  const watchdog = startWatchdog({ db, clock, slot, containers, worker: new ScriptedWorker(clock), resolveWorkspace, pollNow: () => {}, config: { timeLimits: {}, grace: 0 } });
  onTestFinished(watchdog.stop);
  // 既定 agent の `*` は列挙 ping と同梱 ping を撃つ(ADR 0335 決定1)。既定はどちらも空集合を返す偽物で、deny は空のまま
  const enumeration = recordingEnumerator([]);
  const bundled = recordingBundledSet([]);
  const worker = new ClaudeCodeWorker({
    db,
    clock,
    registry: { dir: registryDir, mode: "purely-local" },
    agent: "deckhand",
    workspace: "tidepool",
    mcpUrl: "http://127.0.0.1:4589/mcp",
    logDir,
    transcripts: new TranscriptStore(logDir),
    ...containerHarness(containers, clock),
    // Claude の分類は解決済みの値で渡る(ADR 0309)ので、Promise を真と読まないよう値で比べる
    onWorkerExited: (taskId, exit, facts) => { if (facts.capInterrupted === true) watchdog.onWorkerExited(taskId, exit, facts); },
    onPickupStopped: (taskId, payload) => stops.push([taskId, payload]),
    enumerateSkills: enumeration.enumerateSkills,
    enumerateHostSkills: bundled.enumerateHostSkills,
    ...extraOptions,
  });
  /** Register a board task and hand it to the worker, as the scheduler would. */
  const start = (
    id?: string,
    workspace: string | null = null,
    assignee: string | null = "deckhand",
    type: Task["type"] = "work",
    query?: InjectionQuery,
  ): Task => {
    const task = makeTask(id, workspace, assignee, type);
    insertTask(db, task);
    // scheduler と同じ順序: slot を取ってから spawn する。この unit 盤面では
    // 1つずつ順に走らせるので、前の session の slot は次の pickup で明け渡す。
    slot.release();
    slot.occupy(task.id);
    worker.start(task, setting(task), query);
    return task;
  };
  const setting = (task: Task) =>
    pickedSetting(
      db,
      extraOptions.registry ?? { dir: registryDir, mode: "purely-local" },
      task,
      extraOptions.agent,
      extraOptions.auditorName,
    );
  return { worker, start, setting, logDir, db, slot, clock, registryDir, containers, stops, watchdog, enumeration, bundled, ...recorder };
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

/** Scripted stand-in for the bundled-set ping (ADR 0335 決定2): counts the pings and returns a scripted set (or null). */
function recordingBundledSet(result: string[] | null) {
  const rec = {
    pings: 0,
    enumerateHostSkills: async () => {
      rec.pings += 1;
      return result;
    },
  };
  return rec;
}

/** The `--disallowedTools` value a spawn used, split into its comma-separated
 *  tokens (Workflow + any Skill(...) denies + any review Bash(...) denies).
 *  Comma, not space, is the separator the production code joins with (issue
 *  #59): a `Bash(git push*)` token carries an internal space, so a
 *  space-separated join would misdivide that one entry into two. */
function systemText(args: string[]): string {
  return readFileSync(args[args.indexOf("--append-system-prompt-file") + 1]!, "utf8");
}

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
 *  になる(tests/review-tool-denials.test.ts の線)。review の13本も「work から3本
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
  "TaskStop",
];

/** skill 許可リストが空の agent の work の面(ADR 0185): `--disable-slash-commands` の下では
 *  CLI が `Skill` を面から外すので、宣言からも外す。上の2つと同じく独立した literal。 */
const WORK_SURFACE_WITHOUT_SKILL = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "Task",
  "WebFetch",
  "WebSearch",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskStop",
];

describe("ClaudeCodeWorker", () => {
  it("タスクの workspace を cwd に、stream-json 出力のヘッドレス Claude Code を起動する", async () => {
    const { start, calls } = await makeWorker();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0]!;
    expect(call.command).toBe("claude");
    // cwd comes from the registry's workspaces.yaml, not from tidepool itself
    expect(call.cwd).toBe(FIXTURE_WORKSPACE);
    expect(call.args.join(" ")).toContain("--output-format stream-json");
    // headless: nobody is present to answer a permission prompt, so the mode's
    // residual answer is the floor (ADR 0038). work runs acceptEdits — edits
    // pass, cwd 外は訊く = 拒否。authority itself comes from the profile + MCP verbs.
    expect(call.args.join(" ")).toContain("--permission-mode acceptEdits");
  });

  it("spawn する worker child の env に、spawn されたエージェント名義の GIT_* 4変数を機械注入する(issue #53)", async () => {
    const { start, calls } = await makeWorker();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    const repo = await tempDir("tidepool-git-identity-");
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
    const prod = await realpath(await tempDir("tidepool-prod-"));
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${FIXTURE_WORKSPACE}\nprod:\n  path: ${prod}\n`,
    });
    start("task-prod", "prod");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.cwd).toBe(prod);
  });

  it("task.workspace が null なら、これまで通りコンストラクタの workspace を cwd に使う", async () => {
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${FIXTURE_WORKSPACE}\nprod:\n  path: /srv/pi/work/prod\n`,
    });
    start("task-default", null);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.cwd).toBe(FIXTURE_WORKSPACE);
  });

  it("task.workspace が registry に存在しない名前(registry drift)なら、投げずに quarantine して spawn せず、盤面の一撃で todo へ戻す(issue #26 / ADR 0009 / ADR 0274)", async () => {
    const { start, calls, db, stops } = await makeWorker();
    const task = start("task-drifted", "ghost");
    expect(calls).toEqual([]);
    expect(workspaceNeedsHuman(db, "ghost")).toBe(true);
    expect(stops).toEqual([[task.id, { kind: "pickup_stopped", quarantine: "workspace", value: "ghost", reason: "unknown workspace: ghost" }]]);
  });

  const NAVIGATOR_MD = `---\nversion: 1.0.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: Navigation specialist\n---\nYou are Navigator, the specialist.\n`;

  it("task.assignee が指定されていれば、コンストラクタの agent より優先してそのエージェントとして spawn する(ADR 0012 / issue #36)", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-navigator", null, "navigator");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain("You are Navigator");
    expect(systemPrompt).not.toContain("You are Deckhand");
  });

  it("task.assignee が null なら、これまで通りコンストラクタの agent(既定 agent)として spawn する", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-default-agent", null, null);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain("You are Deckhand");
  });

  it("task.assignee が registry に存在しない agent 名(registry drift)なら、投げずに agent を quarantine して spawn せず、盤面の一撃で todo へ戻す(ADR 0012 / issue #36 / ADR 0274)", async () => {
    const { start, calls, db, stops } = await makeWorker();
    const task = start("task-drifted-agent", null, "ghost");
    expect(calls).toEqual([]);
    expect(agentNeedsHuman(db, "ghost")).toBe(true);
    expect(stops).toEqual([[task.id, { kind: "pickup_stopped", quarantine: "agent", value: "ghost", reason: expect.stringContaining("ghost") }]]);
  });

  it("system prompt に roster を push する: assignable_to(既定は \"*\")を解決した registry 全体が「名前 — description」で並ぶ(issue #43 / ADR 0014)", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain("## Roster");
    expect(systemPrompt).toContain("navigator — Navigation specialist");
    expect(systemPrompt).toContain("deckhand — General work agent for the tidepool board");
  });

  it("roster の human 行: assignable_to に human があれば固定の1行で描画する(issue #43 / ADR 0014)", async () => {
    const { start, calls } = await makeWorker({
      "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - navigator\n  - human\nallowed_workspaces:\n  - "*"\nmerge: external\n`,
      "agents/navigator.md": NAVIGATOR_MD,
    });
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain("navigator — Navigation specialist");
    expect(systemPrompt).toContain(
      "human — delegate to a human — runs outside the slot in their own task list; " +
        "human attention is scarce, delegate only what genuinely needs a human",
    );
    // 明示リストに無い deckhand 自身は roster に現れない
    expect(systemPrompt).not.toContain("deckhand — General work agent");
  });

  it("組み込み agent に解決される名前は、assignable_to の \"*\" 展開にも名指しにも roster に現れない(ADR 0235 決定1)", async () => {
    for (const assignableTo of ['"*"', "fugu\n  - navigator"]) {
      const { start, calls } = await makeWorker({
        "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - ${assignableTo}\nallowed_workspaces:\n  - "*"\nmerge: external\n`,
        "agents/navigator.md": NAVIGATOR_MD,
      });
      start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const args = calls[0]!.args;
      const systemPrompt = systemText(args);
      expect(systemPrompt).toContain("navigator — Navigation specialist");
      expect(systemPrompt).not.toContain("fugu —");
    }
  });

  it("組み込み agent を shadow している間、その名前は普通の agent として roster に現れる(ADR 0235 決定1 / ADR 0228 決定2)", async () => {
    const { start, calls } = await makeWorker({
      "agents/fugu.md": `---\nversion: 1.0.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: Shadowing work agent\n---\nYou are Fugu.\n`,
    });
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain("fugu — Shadowing work agent");
  });

  it("assignable_to の Object.prototype 由来のキー(toString 等)は drift と同じく黙ってスキップされ roster に混入しない(issue #69)", async () => {
    const { start, calls } = await makeWorker({
      "authority/standard.yaml": `guidance: be careful\nassignable_to:\n  - toString\nallowed_workspaces:\n  - "*"\nmerge: external\n`,
    });
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).not.toContain("## Roster");
  });

  const KEEPER_MD = `---\nversion: 1.0.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: Independent reviewer\n---\nYou are Keeper, the auditor.\n`;

  it("review タイプかつ assignee が未指定なら、コンストラクタの既定 agent ではなく auditorName で spawn する(issue #42)", async () => {
    const { start, calls } = await makeWorker(
      { "agents/keeper.md": KEEPER_MD },
      { auditorName: "keeper" },
    );
    start("task-review", null, null, "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain("You are Keeper");
    expect(systemPrompt).not.toContain("You are Deckhand");
  });

  it("review タスクの system prompt は task-type 固定の authority guidance を使い、registry profile の guidance を使わない(ADR 0056 / issue #249)", async () => {
    const registryGuidance = "Registry authority guidance must not appear in a review.";
    const { start, calls } = await makeWorker({
      "authority/standard.yaml":
        `guidance: ${registryGuidance}\nassignable_to:\n  - \"*\"\nallowed_workspaces:\n  - \"*\"\nmerge: external\n`,
      "agents/keeper.md": KEEPER_MD,
    });
    start("task-review-authority", null, "keeper", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain(
      "You are reviewing read-only. Never fix directly — findings become repair tasks.\n" +
        "Assign a repair to the worker in your roster: they executed the task you are reviewing.",
    );
    expect(systemPrompt).not.toContain(registryGuidance);
  });

  it("review タスクの roster は registry profile が全員への委譲を許していても被レビュータスクの executor 1名だけを示す(ADR 0056 / issue #249)", async () => {
    const { worker, setting, calls, db } = await makeWorker({
      "agents/keeper.md": KEEPER_MD,
      "agents/navigator.md": NAVIGATOR_MD,
    });
    const reviewed = makeTask("task-reviewed", null, null);
    insertTask(db, reviewed);
    appendEvent(db, {
      taskId: reviewed.id,
      actorId: "deckhand",
      origin: "worker",
      payload: { kind: "task_completed", handoff_present: true, result: "done" },
      at: new FakeClock().now(),
    });
    const review: Task = {
      ...makeTask("task-review-roster", null, "keeper", "review"),
      parent_id: reviewed.id,
    };
    insertTask(db, review);
    worker.start(review, setting(review));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    const roster = systemPrompt.split("## Roster\n\n")[1]?.split("\n\n## Board doctrine")[0];
    expect(roster).toBe("deckhand — General work agent for the tidepool board");
  });

  it("親を持たないルート review の system prompt には roster セクションを出さない(ADR 0056 / issue #249)", async () => {
    const { start, calls } = await makeWorker({ "agents/keeper.md": KEEPER_MD });
    start("task-root-review", null, "keeper", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).not.toContain("## Roster");
  });

  it("被レビュータスクの executor が registry から drift していれば review の roster セクションを出さない(ADR 0056 / issue #249)", async () => {
    const { worker, setting, calls, db } = await makeWorker({ "agents/keeper.md": KEEPER_MD });
    const reviewed = makeTask("task-reviewed-by-drifted-agent", null, null);
    insertTask(db, reviewed);
    appendEvent(db, {
      taskId: reviewed.id,
      actorId: "ghost",
      origin: "worker",
      payload: { kind: "task_completed", handoff_present: true, result: "done" },
      at: new FakeClock().now(),
    });
    const review: Task = {
      ...makeTask("task-review-drifted-executor", null, "keeper", "review"),
      parent_id: reviewed.id,
    };
    insertTask(db, review);
    worker.start(review, setting(review));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).not.toContain("## Roster");
  });

  it.each(["work", "review"] as const)("見える approved の記憶があれば、%s task でも注入節を system prompt の連結の末尾に置き、worker_spawned の直後に memory_injected を書く(spec #586 C / issue #592)", async (type) => {
    const { start, calls, db } = await makeWorker();
    recordKnowledge(
      db,
      { scope: "tidepool", path: "faucet", title: "Faucet valve", text: "The faucet valve is in the attic.", author: { activity: "human", name: "human" } },
      "webui",
      new FakeClock().now(),
    );
    const task = start("task-memory", null, "deckhand", type);
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    const { section } = buildMemoryInjection(db, task, "tidepool", "deckhand");
    expect(systemPrompt.endsWith(`\n\n${section}`)).toBe(true);
    const events = listEvents(db, task.id);
    const spawned = events.findIndex((e) => e.kind === "worker_spawned");
    expect(events[spawned + 1]?.payload).toMatchObject({ kind: "memory_injected", worker_spawned_event_id: events[spawned]!.id });
  });

  it("start の入力が英語の view を持てば memory_injected はその文面を持ち、持たなければ query の欄は無い(view で引くことは memory-injection.test.ts —— ADR 0175)", async () => {
    const { calls, start, db } = await makeWorker();
    const viewed = start("task-view", null, "deckhand", "work", { view: "Find the attic ladder" });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const bare = start("task-bare");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    const injected = (id: string) => listEvents(db, id).find((e) => e.kind === "memory_injected")!.payload;
    expect(injected(viewed.id)).toMatchObject({ query: { view: "Find the attic ladder" } });
    expect(injected(bare.id)).not.toHaveProperty("query");
  });

  it("見える approved の記憶が無ければ注入節を置かず、memory_injected は entries 空で残る(issue #592)", async () => {
    const { start, calls, db } = await makeWorker();
    const task = start("task-no-memory");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    expect(systemText(args)).not.toContain("## Memory");
    const events = listEvents(db, task.id);
    const spawned = events.findIndex((e) => e.kind === "worker_spawned");
    expect(events[spawned + 1]?.payload).toMatchObject({ kind: "memory_injected", worker_spawned_event_id: events[spawned]!.id, entries: [] });
  });

  it("meta-review の spawn は主題の材料の節を記憶の節の枠(system prompt の連結の末尾)に置き、memory_injected の直後に meta_review_material_injected を書く —— 主題 memory には routing の節が入らず、普通の task には節も記録も無い(ADR 0180 決定2・追記 #1239)", async () => {
    const { worker, setting, slot, calls, db } = await makeWorker();
    const spawn = async (subject: "memory" | "routing" | null) => {
      // setup のみ: 盤面名義の登録を deckhand に割り当てる(既定の auditor は skill の列挙 ping を挟んで spawn が非同期になる)
      if (subject) {
        registerMetaReview(db, subject, new FakeClock().now());
        db.prepare("UPDATE tasks SET assignee = 'deckhand' WHERE meta_review_subject = ?").run(subject);
      }
      const task = subject ? getTask(db, listBoard(db).find((t) => t.meta_review_subject === subject)!.id)! : makeTask(`task-${calls.length}`);
      if (!subject) insertTask(db, task);
      slot.release();
      slot.occupy(task.id);
      const before = calls.length;
      worker.start(task, setting(task));
      await vi.waitFor(() => expect(calls).toHaveLength(before + 1));
      const args = calls.at(-1)!.args;
      return { task, systemPrompt: systemText(args) };
    };

    for (const subject of ["memory", "routing"] as const) {
      const review = await spawn(subject);
      const { section } = buildMetaReviewMaterial(db, review.task.id)!;
      expect(review.systemPrompt.endsWith(`\n\n${section}`)).toBe(true);
      const events = listEvents(db, review.task.id);
      const spawned = events.findIndex((e) => e.kind === "worker_spawned");
      expect(events.slice(spawned + 1, spawned + 3).map((e) => e.payload)).toMatchObject([
        { kind: "memory_injected" },
        { kind: "meta_review_material_injected", subject, worker_spawned_event_id: events[spawned]!.id },
      ]);
      if (subject === "memory") expect(review.systemPrompt).not.toContain("## Routing meta-review material");
    }
    const work = await spawn(null);
    expect(work.systemPrompt).not.toContain("meta-review material");
    expect(listEvents(db, work.task.id).map((e) => e.kind)).not.toContain("meta_review_material_injected");
  });

  it("主題つきの meta-review の spawn は指針の節を材料の節と別に、その直前に置き、memory_injected は指針の節の id と token 量を持つ(ADR 0279 決定2)", async () => {
    const { worker, setting, slot, calls, db } = await makeWorker();
    const at = new FakeClock().now();
    const { entry_id } = recordBehavior(db, humanEntryInput(db, { workspace: null, path: "review", title: "Fold duplicates first", text: "x", addressee: "deckhand" }), "webui", at);
    // setup のみ: 盤面名義の登録を deckhand に割り当てる
    registerMetaReview(db, "memory", at);
    db.prepare("UPDATE tasks SET assignee = 'deckhand' WHERE meta_review_subject = 'memory'").run();
    const task = getTask(db, listBoard(db).find((t) => t.meta_review_subject === "memory")!.id)!;
    slot.release();
    slot.occupy(task.id);
    worker.start(task, setting(task));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls.at(-1)!.args;
    const guidance = buildMemoryInjection(db, task, "work", "deckhand");
    const { section } = buildMetaReviewMaterial(db, task.id)!;
    expect(systemText(args).endsWith(`\n\n${guidance.section}\n\n${section}`)).toBe(true);
    expect(listEvents(db, task.id).find((e) => e.kind === "memory_injected")?.payload).toMatchObject({
      entries: [{ id: entry_id, version: entry_id }],
      tokens: guidance.tokens,
    });
  });

  it("worker_spawned イベントの actor_id は解決済みの assignee になる(コンストラクタの既定 agent 固定ではない)", async () => {
    const { calls, start, db } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-attributed", null, "navigator");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spawned = listEvents(db, "task-attributed").find((e) => e.kind === "worker_spawned");
    expect(spawned?.actor_id).toBe("navigator");
  });

  it("一時 MCP 設定でボードを ?task= 付きで指す(呼び出しのタスク帰属)", async () => {
    const { start, calls } = await makeWorker();
    start("task-42");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain("You are Deckhand");
    expect(systemPrompt).toContain("Prefer reversible actions");
  });

  it("authority guidance が空文字なら、system prompt から `## Authority` 見出しごと省く(issue #488)", async () => {
    const { start, calls } = await makeWorker({
      "authority/standard.yaml": `guidance: ""\nassignable_to:\n  - "*"\nallowed_workspaces:\n  - "*"\nmerge: external\n`,
      "agents/navigator.md": NAVIGATOR_MD,
    });
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).not.toContain("## Authority");
    expect(systemPrompt).toContain("You are Deckhand");
    const rosterIndex = systemPrompt.indexOf("## Roster");
    const doctrineIndex = systemPrompt.indexOf("## Board doctrine");
    expect(rosterIndex).toBeGreaterThan(-1);
    expect(doctrineIndex).toBeGreaterThan(rosterIndex);
  });

  it("盤面教義(subagent/workflow は説明責任を分割しない労力の分割にのみ使う)を、agent や profile によらず system prompt に注入する(ADR 0010 / issue #31)", async () => {
    const { start, calls } = await makeWorker({ "agents/navigator.md": NAVIGATOR_MD });
    start("task-navigator", null, "navigator");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain("Agent tool");
    expect(systemPrompt).toContain("decompose");
    // ADR 0010 追補の受け入れ基準: 教義自体にオーケストレーション禁止の1行が含まれる
    // (--disallowedTools でツールを塞ぐのとは別に、教義の文言としても明示する)
    expect(systemPrompt).toContain("Workflow tool");
  });

  it("Interview の pin の子の system prompt には、分けない doctrine が載る(ADR 0245 決定2)", async () => {
    const { worker, setting, slot, calls, db } = await makeWorker();
    const target = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
    const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [target] }, new Date(0), ...HUMAN_WEBUI);
    openTestInterviewRoom(db, root);
    const [child] = poseAccepted(db, root, { title: "probe", probe: "p", completion_criteria: "c", rubric: "r" }, "auditor", new Date(0), "worker", POSED_HEAD);
    openTestExamineeCheckout(db, child!);
    slot.occupy(child!.id);
    worker.start(child!, setting(child!));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain(boardDoctrine({ delegate: "the Agent tool", workflow: true }, { withheld: ["decompose", "redecompose", "record_knowledge", "define_memory_branch"], added: [] }));
  });

  it("出題前の Interview の root の system prompt には、pose_probe を足した verb の差し替えの doctrine が載る(ADR 0253 決定5)", async () => {
    const { worker, setting, slot, calls, db } = await makeWorker();
    const target = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
    const root = registerTask(db, { type: "interview", assignee: "deckhand", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [target] }, new Date(0), ...HUMAN_WEBUI);
    openTestInterviewRoom(db, root);
    slot.occupy(root.id);
    worker.start(root, setting(root));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    // 文面そのものは tests/board-prose.test.ts が固定する。ここは task ごとの verb の差し替えの配線だけ
    expect(systemText(args)).toContain(boardDoctrine({ delegate: "the Agent tool", workflow: true }, { withheld: ["decompose", "redecompose", "complete_task"], added: ["pose_probe"] }));
  });

  it("出題済みの Interview の root の system prompt には、分けない doctrine が載り decompose を指す文は載らない(ADR 0247 決定3)", async () => {
    const { worker, setting, slot, calls, db } = await makeWorker();
    const target = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
    const root = registerTask(db, { type: "interview", assignee: "deckhand", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [target] }, new Date(0), ...HUMAN_WEBUI);
    openTestInterviewRoom(db, root);
    poseAccepted(db, root, { title: "probe", probe: "p", completion_criteria: "c", rubric: "r" }, "auditor", new Date(0), "worker", POSED_HEAD);
    slot.occupy(root.id);
    worker.start(root, setting(root));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    expect(systemText(args)).toContain(boardDoctrine({ delegate: "the Agent tool", workflow: true }, { withheld: ["decompose", "redecompose", "complete_task"], added: ["complete_interview", "report_broken_probe"] }));
  });

  // ADR 0017: agent 定義ファイルは専門性のみを運び、ワーカープロトコル(rules
  // of the road)は盤面がコード側で全ワーカーに注入する。本文が空の正規形エージェント
  // (tako)でも、cwd=workspace・side channel 禁止・escalate をためらわない posture が
  // system prompt に現れることを固定する。verb の意味論は MCP description 側にあり、
  // ここには重複させない(issue #51)。
  const TAKO_MD = `---\ndescription: General work agent for the tidepool board\nversion: 0.1.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\nicon: \u{1F419}\n---\n`;

  it("本文が空の既定エージェントでも、ワーカープロトコル(rules of the road)を system prompt に注入する(ADR 0017 / issue #51)", async () => {
    const { start, calls } = await makeWorker({ "agents/tako.md": TAKO_MD });
    start("task-tako", null, "tako");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    // cwd = the task's workspace
    expect(systemPrompt).toContain("current working directory");
    // no side channels — everything flows through the MCP verbs
    expect(systemPrompt).toContain("did not happen");
    // escalate posture (deckhand 本文が運んでいた rules of the road)
    expect(systemPrompt).toContain("Escalating is never wrong");
    // 前提の破綻と自タスク外の発見の2文(ADR 0121 / issue #631)
    expect(systemPrompt).toContain("When the premise of the decomposition decision your task rests on turns out to be false, declare a premise breach rather than working around it or escalating it.");
    expect(systemPrompt).toContain("A finding outside your task's scope is not your task: record the decision not to act on it with `log_decision`, and never decompose it into a child.");
    expect(systemPrompt).toContain(
      "This may be a resumed task session: if the task history shows prior-session traces, inspect the task branch with `git log` before starting work.",
    );
    // verb の意味論は description 側に一本化: WORKER_PROTOCOL に verb 名を複写しない
    expect(systemPrompt).not.toContain("get_current_task");
  });

  it("英語ルールは WORKER_PROTOCOL から移設され、system prompt には複写されない(ADR 0015 2026-08-21 追補 / issue #415)", async () => {
    const { start, calls } = await makeWorker();
    start("task-canonical-text");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).not.toContain(
      "Write everything you put on the board — decision log lines, child task fields, handoff docs, results — in English, even when the task's payload is in another language. Human-authored text you quote stays in its original language.",
    );
    expect(systemPrompt).not.toContain(BOARD_WRITE_LANGUAGE_RULE);
  });

  it("許可ドメインがある session は実効 egress とリトライ禁止を英語で伝える(ADR 0072)", async () => {
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:
  path: ${FIXTURE_WORKSPACE}
  allowed_domains:
    - registry.npmjs.org
`,
    });

    start("task-network-protocol");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain(
      "Network egress is deny-by-default. This session may reach only: registry.npmjs.org. " +
        "Do not retry downloads from any other domain.",
    );
  });

  it("許可ドメインがない session は外部取得不能を英語で明言する(ADR 0072)", async () => {
    const { start, calls } = await makeWorker();

    start("task-closed-network-protocol");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const systemPrompt = systemText(args);
    expect(systemPrompt).toContain(
      "Network egress is deny-by-default. This session cannot fetch from any external domain. " +
        "Do not retry external downloads.",
    );
  });

  it("Workflow ツールを spawn 時に無効化する(オーケストレーションは worker にカテゴリ禁止・ADR 0010 追補 / issue #31)", async () => {
    const { start, calls } = await makeWorker();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toContain("Edit");
    expect(deny).toContain("Write");
  });

  it("work タスクの spawn には影響しない(deny は Workflow のみ)", async () => {
    const { start, calls } = await makeWorker();
    start("task-work-no-deny", null, "deckhand", "work");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toEqual(["Workflow"]);
  });

  // ADR 0035 / issue #144: review の書き込み床は permission 層が担う。auto の
  // 判定は LLM 分類器でモデル判断なので床に数えない、という原則の実装面。
  it("review タスクの spawn は --permission-mode manual で走る(ADR 0035)", async () => {
    const { start, calls } = await makeWorker();
    start("task-review-manual", null, "deckhand", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.join(" ")).toContain("--permission-mode manual");
  });

  it.each(["memory_repair", "routing_repair"] as const)("%s タスクの spawn も --permission-mode manual で走る —— read-only 保証を運ぶ type(ADR 0272 決定3 / ADR 0279 決定4)", async (type) => {
    const { start, calls } = await makeWorker();
    start("task-memory-repair-manual", null, "deckhand", type);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    start("task-sources-review", null, "deckhand", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    for (const call of calls) {
      expect(call.args[call.args.indexOf("--setting-sources") + 1]).toBe("project");
    }
  });

  // ADR 0039(issue #145): ADR 0038 の床が届かない層 — ファイル操作でない
  // in-process ツール — を `--tools` の既定拒否で閉じる。期待値は実装を import せず
  // 独立した literal で書く(tests/spawn-tools.test.ts と同じ線): ここが確かめるのは
  // 「盤面が emit するフラグ列」までで、面が実際にそうなったかは実セッションの init
  // 行しか答えられない(ADR 0027)。
  it("work タスクの spawn は --tools に work の16本を渡す(ADR 0039 決定1)", async () => {
    const { start, calls } = await makeWorker();
    start("task-work-tools", null, "deckhand", "work");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(spawnedTools(calls[0]!.args)).toEqual(WORK_SURFACE);
  });

  it("review タスクの spawn は --tools に review の13本を渡す — 編集系が面から消える(ADR 0039 決定2)", async () => {
    const { start, calls } = await makeWorker();
    start("task-review-tools", null, "deckhand", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spelled = calls[0]!.args.join(" ");
    for (const tool of ["CronCreate", "RemoteTrigger", "PushNotification", "EnterWorktree"]) {
      expect(spelled).not.toContain(tool);
    }
  });

  it("review タスクの spawn は tidepool MCP をサーバ単位で allow する — 無いと盤面への唯一の channel が承認待ちで詰まる", async () => {
    const { start, calls } = await makeWorker();
    start("task-review-mcp-allow", null, "deckhand", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(allowedTools(calls[0]!.args)).toEqual(["mcp__tidepool"]);
  });

  it("allow する permission subject の綴りは、同じ spawn が書いた mcp-config のサーバ名と一致する", async () => {
    // 一致は綴りの偶然ではなく成立条件: ズレれば review は盤面に一切触れられず、
    // しかも「モデルが何もせず終了した」ようにしか見えない(ADR 0035 事実2)。
    // 両側を別々の情報源(片や CLI 引数、片やディスク上の JSON)から読んで
    // 突き合わせる — 実装の定数を import して比べると同語反復になる。
    const { start, calls, logDir } = await makeWorker();
    const task = start("task-review-mcp-key", null, "deckhand", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const config = JSON.parse(
      await readFile(join(logDir, `${task.id}.mcp.json`), "utf8"),
    ) as { mcpServers: Record<string, unknown> };
    const [serverName] = Object.keys(config.mcpServers);
    expect(allowedTools(calls[0]!.args)).toContain(`mcp__${serverName}`);
  });

  it("workspace の review_allowed_commands が review spawn の --allowedTools に Bash パターンとして畳まれる", async () => {
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:
  path: ${FIXTURE_WORKSPACE}
  review_allowed_commands:
    - npm test
`,
    });
    start("task-review-allowed-cmds", null, "deckhand", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(allowedTools(calls[0]!.args)).toEqual(["mcp__tidepool"]);
  });

  it("review_allowed_commands は work の spawn には効かない(allowlist は MCP サーバだけ)", async () => {
    const { start, calls } = await makeWorker({
      "workspaces.yaml": `tidepool:
  path: ${FIXTURE_WORKSPACE}
  review_allowed_commands:
    - npm test
`,
    });
    start("task-work-no-allow", null, "deckhand", "work");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // Bash の接頭辞 allow は review 専用のまま — work は元から書けるので何も買わず、
    // 開けば registry のデータが work の Bash 面を広げる経路になる。
    expect(allowedTools(calls[0]!.args)).toEqual(["mcp__tidepool"]);
  });

  // issue #56 / ADR 0025: skill access is the agent's frontmatter allowlist,
  // enforced at spawn as the complement deny of the CLI-enumerated full set.
  const skilledMd = (skillsYaml: string) =>
    `---\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\ndescription: General work agent for the tidepool board\nskills:\n${skillsYaml}---\nYou are Deckhand.\n`;

  it("skills が ['*'] の agent は workspace cwd の列挙 ping と同梱 ping の両方を撃ってから spawn する(ADR 0335 決定1)", async () => {
    const { start, calls, enumeration, bundled } = await makeWorker();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(enumeration.calls).toEqual([FIXTURE_WORKSPACE]);
    expect(bundled.pings).toBe(1);
    expect(calls[0]!.args).not.toContain("--disable-slash-commands");
  });

  it("skills が空リストの agent は列挙 ping を呼ばず --disable-slash-commands 一発で全禁止し、--tools に Skill を載せない(ADR 0025 point 5 / ADR 0185)", async () => {
    const { start, calls, enumeration, bundled } = await makeWorker({ "agents/deckhand.md": skilledMd("  []\n") });
    start();
    expect(calls).toHaveLength(1);
    expect(enumeration.calls).toEqual([]);
    expect(bundled.pings).toBe(0);
    expect(calls[0]!.args).toContain("--disable-slash-commands");
    // disable フラグが CLI の面から外す `Skill` を、宣言からも外す
    expect(spawnedTools(calls[0]!.args)).not.toContain("Skill");
  });

  it("有限の許可リストは列挙 ping の全集合から許可の補集合を Skill(名前) で deny する(ADR 0025 point 3)", async () => {
    const rec = recordingEnumerator(["code-review", "tdd", "grilling"]);
    const { start, calls } = await makeWorker(
      { "agents/deckhand.md": skilledMd("  - code-review\n") },
      { enumerateSkills: rec.enumerateSkills, enumerateHostSkills: recordingBundledSet(["code-review", "tdd", "grilling"]).enumerateHostSkills },
    );
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // ping はタスクの workspace cwd で走る
    expect(rec.calls).toEqual([FIXTURE_WORKSPACE]);
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toContain("Workflow");
    expect(deny).toContain("Skill(tdd)");
    expect(deny).toContain("Skill(grilling)");
    // 許可した skill は deny されない
    expect(deny).not.toContain("Skill(code-review)");
    // 全件 deny されても面に残る(#1268 の実測)ので、`Skill` が外れるのは空リストだけ(ADR 0185)
    expect(spawnedTools(calls[0]!.args)).toContain("Skill");
  });

  it("@workspace は checkout が運ぶ skill だけを許可し、列挙に載った user 層・plugin の名前を deny する(ADR 0025 / ADR 0335 決定1)", async () => {
    const wsDir = await tempDir("tidepool-ws-");
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

  describe.each([".claude/skills", ".claude"] as const)("外を指す %s の親 symlink(issue #2784)", (parent) => {
    it.each([
      ["@workspace", [], ["Workflow", "Skill(shared)", "Skill(debug)"]],
      ["@host", ["debug"], ["Workflow", "Skill(shared)"]],
      ["*", ["debug"], ["Workflow", "Skill(shared)"]],
    ] as const)("%s は外の実 dir を deny し、workspace・host・permitted に数えない", async (scope, permitted, deny) => {
      const wsDir = await tempDir("tidepool-ws-");
      const outside = await tempDir("tidepool-outside-");
      if (parent === ".claude/skills") {
        await mkdir(join(outside, "shared-skills", "shared"), { recursive: true });
        await mkdir(join(wsDir, ".claude"));
        await symlink(join(outside, "shared-skills"), join(wsDir, parent));
      } else {
        await mkdir(join(outside, "dotclaude", "skills", "shared"), { recursive: true });
        await symlink(join(outside, "dotclaude"), join(wsDir, parent));
      }
      const { start, calls, db } = await makeWorker(
        { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`, "agents/deckhand.md": skilledMd(`  - "${scope}"\n`) },
        {
          enumerateSkills: recordingEnumerator(["shared", "debug"]).enumerateSkills,
          enumerateHostSkills: recordingBundledSet(["shared", "debug"]).enumerateHostSkills,
        },
      );
      start("task-skill-parent-symlink");
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      expect(disallowedTools(calls[0]!.args)).toEqual(deny);
      const spawned = listEvents(db, "task-skill-parent-symlink").find((e) => e.kind === "worker_spawned")!;
      expect(spawned.payload).toMatchObject({ skills: { workspace: [], host: ["debug"], permitted } });
    });
  });

  it("内側の .agents/skills を指す .claude/skills の下の実 dir は @workspace で許可し、workspace と permitted に数える(issue #2784)", async () => {
    const wsDir = await tempDir("tidepool-ws-");
    await mkdir(join(wsDir, ".agents", "skills", "inner"), { recursive: true });
    await mkdir(join(wsDir, ".claude"));
    await symlink("../.agents/skills", join(wsDir, ".claude", "skills"));
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`, "agents/deckhand.md": skilledMd('  - "@workspace"\n') },
      { enumerateSkills: recordingEnumerator(["inner", "debug"]).enumerateSkills },
    );
    start("task-skill-internal-parent-symlink");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(disallowedTools(calls[0]!.args)).toEqual(["Workflow", "Skill(debug)"]);
    const spawned = listEvents(db, "task-skill-internal-parent-symlink").find((e) => e.kind === "worker_spawned")!;
    expect(spawned.payload).toMatchObject({ skills: { workspace: ["inner"], host: [], permitted: ["inner"] } });
  });

  // issue #2774: `.claude/skills/*` を `.agents/skills/*` への相対 symlink で置く checkout(tidepool 自身)
  const symlinkedSkillWorkspace = async () => {
    const wsDir = await tempDir("tidepool-ws-");
    await mkdir(join(wsDir, ".agents", "skills", "inner"), { recursive: true });
    await mkdir(join(wsDir, ".claude", "skills", "tdd"), { recursive: true });
    await symlink("../../.agents/skills/inner", join(wsDir, ".claude", "skills", "inner"));
    return wsDir;
  };

  it("checkout の内側の dir を指す symlink の skill は @workspace で deny されず、worker_spawned の workspace と permitted に入る(issue #2774)", async () => {
    const wsDir = await symlinkedSkillWorkspace();
    const rec = recordingEnumerator(["inner", "tdd", "plug:deploy"]);
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`, "agents/deckhand.md": skilledMd('  - "@workspace"\n') },
      { enumerateSkills: rec.enumerateSkills },
    );
    start("task-skill-symlink");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toContain("Skill(plug:deploy)");
    expect(deny).not.toContain("Skill(inner)");
    const spawned = listEvents(db, "task-skill-symlink").find((e) => e.kind === "worker_spawned")!;
    expect(spawned.payload).toMatchObject({ skills: { workspace: ["inner", "tdd"], permitted: ["inner", "tdd"] } });
  });

  it("名前の違う symlink(alias -> tdd)の skill は entry 名で workspace に数え、@workspace で deny しない(issue #2785 —— 固定版 CLI は entry 名で名乗る)", async () => {
    const wsDir = await tempDir("tidepool-ws-");
    await mkdir(join(wsDir, ".agents", "skills", "tdd"), { recursive: true });
    await mkdir(join(wsDir, ".claude", "skills"), { recursive: true });
    await symlink("../../.agents/skills/tdd", join(wsDir, ".claude", "skills", "alias"));
    const rec = recordingEnumerator(["alias", "plug:deploy"]);
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`, "agents/deckhand.md": skilledMd('  - "@workspace"\n') },
      { enumerateSkills: rec.enumerateSkills },
    );
    start("task-skill-symlink-alias");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const deny = disallowedTools(calls[0]!.args);
    expect(deny).toContain("Skill(plug:deploy)");
    expect(deny).not.toContain("Skill(alias)");
    const spawned = listEvents(db, "task-skill-symlink-alias").find((e) => e.kind === "worker_spawned")!;
    expect(spawned.payload).toMatchObject({ skills: { workspace: ["alias"], permitted: ["alias"] } });
  });

  it("checkout の外・名前が前方一致する隣の dir・壊れた先・ファイルを指す symlink は数えず、spawn は進む(issue #2774)", async () => {
    const parent = await tempDir("tidepool-ws-parent-");
    const wsDir = join(parent, "ws");
    const outside = await tempDir("tidepool-outside-");
    await mkdir(join(wsDir, ".claude", "skills", "tdd"), { recursive: true });
    await mkdir(join(outside, "ext"));
    await mkdir(join(`${wsDir}-other`, "sibling"), { recursive: true });
    await writeFile(join(wsDir, "file.md"), "not a skill");
    const skillsDir = join(wsDir, ".claude", "skills");
    await symlink(join(outside, "ext"), join(skillsDir, "ext"));
    await symlink("../../../ws-other/sibling", join(skillsDir, "sibling"));
    await symlink("../../missing", join(skillsDir, "broken"));
    await symlink("../../file.md", join(skillsDir, "file"));
    const rec = recordingEnumerator(["tdd", "ext", "sibling"]);
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`, "agents/deckhand.md": skilledMd('  - "@workspace"\n') },
      { enumerateSkills: rec.enumerateSkills },
    );
    start("task-skill-symlink-rejected");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spawned = listEvents(db, "task-skill-symlink-rejected").find((e) => e.kind === "worker_spawned")!;
    expect(spawned.payload).toMatchObject({ skills: { workspace: ["tdd"], permitted: ["tdd"] } });
  });

  // ADR 0335 決定1・3: 実 dir・内側を指す link・外を指す link・壊れた link・同梱と同名の dir を置いた checkout で、entry の形ごとの
  // deny と記録の3列。列挙は workspace cwd の ping(user 層の名前も載る)、同梱は neutral cwd の ping の生の結果
  const mixedSkillWorkspace = async () => {
    const wsDir = await symlinkedSkillWorkspace(); // tdd(実 dir)と inner(内側を指す link)
    const outside = await tempDir("tidepool-outside-");
    await mkdir(join(outside, "ext"));
    const skillsDir = join(wsDir, ".claude", "skills");
    await symlink(join(outside, "ext"), join(skillsDir, "ext"));
    await symlink("../../missing", join(skillsDir, "broken"));
    await mkdir(join(skillsDir, "dataviz"));
    return wsDir;
  };
  it.each([
    ["@workspace", '  - "@workspace"\n', ["tdd", "inner", "dataviz"], ["ext", "debug", "user-skill"]],
    ["@host", '  - "@host"\n', ["debug"], ["tdd", "inner", "ext", "dataviz", "user-skill"]],
    ["*", '  - "*"\n', ["tdd", "inner", "dataviz", "debug"], ["ext", "user-skill"]],
    ["名前指定", "  - ext\n  - debug\n", ["debug"], ["tdd", "inner", "ext", "dataviz", "user-skill"]],
  ] as const)("%s の agent は運ぶ・同梱のどちらにも無い名前を開かず、deny と worker_spawned の3列が checkout の置き方どおりになる(ADR 0335 決定1・3)", async (_entry, skillsYaml, permitted, deny) => {
    const wsDir = await mixedSkillWorkspace();
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`, "agents/deckhand.md": skilledMd(skillsYaml) },
      {
        enumerateSkills: recordingEnumerator(["tdd", "inner", "ext", "dataviz", "debug", "user-skill"]).enumerateSkills,
        enumerateHostSkills: recordingBundledSet(["dataviz", "debug", "broken"]).enumerateHostSkills,
      },
    );
    start("task-skill-matrix");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(disallowedTools(calls[0]!.args)).toEqual(["Workflow", ...deny.map((name) => `Skill(${name})`)]);
    const spawned = listEvents(db, "task-skill-matrix").find((e) => e.kind === "worker_spawned")!;
    expect(spawned.payload).toMatchObject({ skills: { workspace: ["dataviz", "inner", "tdd"], host: ["debug"], permitted } });
  });

  it.each<[string, Partial<ConstructorParameters<typeof ClaudeCodeWorker>[0]>, RegExp]>([
    ["同梱 ping の null", { enumerateHostSkills: async () => null }, /^bundled skill enumeration failed, so /],
    ["同梱 ping の reject", {
      enumerateHostSkills: async () => {
        throw new Error("bundled ping blew up");
      },
    }, /^bundled skill enumeration failed, so /],
    ["両方の ping の null", { enumerateSkills: async () => null, enumerateHostSkills: async () => null }, /^skill enumeration and bundled skill enumeration failed, so /],
  ])("%s は spawn_failed を書いて onSpawnFailed を呼び、どの ping が落ちたかを名指し、worker を起こさない(ADR 0335 決定2)", async (_shape, pings, message) => {
    const spawnFailures: Array<[string, { error_code: string | null; message: string }]> = [];
    const { start, calls, db } = await makeWorker({}, {
      ...pings,
      onSpawnFailed: (taskId, failure, record) => {
        record();
        spawnFailures.push([taskId, failure]);
      },
    });
    start("task-bundled-fail");
    await vi.waitFor(() => expect(spawnFailures).toHaveLength(1));
    expect(spawnFailures).toEqual([["task-bundled-fail", { error_code: null, message: expect.stringMatching(message) }]]);
    expect(listEvents(db, "task-bundled-fail").filter((e) => e.kind === "spawn_failed")).toHaveLength(1);
    expect(calls).toEqual([]);
  });

  // ADR 0325 決定2: 帰責の判事が scope を引けるよう、spawn の記録は allowlist の形に関わらず checkout の skill と許可した集合を持つ
  it.each([
    ["*", '  - "*"\n', ["tdd", "code-review"]],
    ["[]", "  []\n", []],
    ["有限", "  - code-review\n", ["code-review"]],
    ["scope 語", '  - "@workspace"\n', ["tdd", "code-review"]],
  ] as const)("allowlist が %s でも worker_spawned は checkout の skill の集合・同梱の集合・許可した集合を記録する(ADR 0325 決定2 / ADR 0335 決定3)", async (_shape, skillsYaml, permitted) => {
    const wsDir = await tempDir("tidepool-ws-");
    await mkdir(join(wsDir, ".claude", "skills", "tdd"), { recursive: true });
    await mkdir(join(wsDir, ".claude", "skills", "code-review"), { recursive: true });
    const rec = recordingEnumerator(["tdd", "code-review", "plug:deploy"]);
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`, "agents/deckhand.md": skilledMd(skillsYaml) },
      { enumerateSkills: rec.enumerateSkills },
    );
    start("task-skills-record");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spawned = listEvents(db, "task-skills-record").find((e) => e.kind === "worker_spawned")!;
    expect(spawned.payload).toMatchObject({ skills: { workspace: ["code-review", "tdd"], host: [], permitted } });
  });

  // ADR 0136 決定5 / issue #767: skill 列挙は Board call の口を1回通る。ここは
  // whole-probe の fake(`EnumerateSkillsFn`)を**外して**、実物の列挙を fake の
  // 容器機構の上で走らせる唯一の場所である —— 門が立っていることは probe の中身
  // ではなく「容器が空になるまで launch の spawn が1本も起きない」で現れる。
  // issue #767 の AC はこれをサーバー境界と書いているが、adapter の export で
  // 全部見えるので ADR 0107 の最下位 seam であるここに置く。
  const skillEnumOnFakeContainers = async () => {
    const recorder = recordingSpawn();
    onTestFinished(() => recorder.emitExit(0, null)); // task temp の後始末(ADR 0257)
    const runtime = new FakeContainerRuntime(recorder.spawn);
    const worker = await makeWorker(
      { "agents/deckhand.md": skilledMd("  - code-review\n") },
      // 列挙だけ実物に戻す(`undefined` で constructor の既定へ落ちる)。同梱 ping は偽物のままなので、口を通る spawn は列挙の1本
      { containers: new ProcessContainers(runtime), enumerateSkills: undefined },
    );
    return { ...worker, recorder, runtime };
  };
  const skillsInit = (skills: string[]) =>
    `${JSON.stringify({ type: "system", subtype: "init", skills })}\n`;
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  it("skill 列挙の容器が空になるまで worker は launch されない(ADR 0136 決定5)", async () => {
    const { start, recorder, runtime } = await skillEnumOnFakeContainers();
    start("task-skill-gate", null, "deckhand", "work");

    // 1本目の spawn は skill 列挙の probe。その容器は worker のものとは別である
    await vi.waitFor(() => expect(recorder.calls).toHaveLength(1));
    const probeContainer = runtime.created[0]!;
    expect(probeContainer).not.toBe("task-skill-gate");
    runtime.hold(probeContainer); // force だけでは空にならないホスト

    recorder.processes[0]!.stdout.write(skillsInit(["code-review", "tdd"]));
    await settle();
    recorder.emitExitAt(0, 0, null);
    await settle();

    // root の exit で force は撃たれるが、結果はまだ返らない —— launch も起きない
    expect(runtime.forceReclaims).toEqual([probeContainer]);
    expect(recorder.calls).toHaveLength(1);
    // 自前の timeout + root への SIGKILL は消えた: 回収は容器の側ひとつである
    expect(recorder.killed).toEqual([]);
  });

  it("skill 列挙の容器が空になったら launch が進む(門は回収済み観測ひとつ)", async () => {
    const { start, recorder, runtime } = await skillEnumOnFakeContainers();
    start("task-skill-gate-open", null, "deckhand", "work");
    await vi.waitFor(() => expect(recorder.calls).toHaveLength(1));
    const probeContainer = runtime.created[0]!;
    runtime.hold(probeContainer);
    recorder.processes[0]!.stdout.write(skillsInit(["code-review", "tdd"]));
    await settle();
    recorder.emitExitAt(0, 0, null);
    await settle();

    runtime.fireEmpty(probeContainer);

    await vi.waitFor(() => expect(recorder.calls).toHaveLength(2));
    // 列挙の答えはそのまま deny になる(口を通しても probe の意味は変わらない)
    expect(disallowedTools(recorder.calls[1]!.args)).toContain("Skill(tdd)");
  });

  // issue #770: ADR 0118 の族の3つ目の観測点。時計は進めない —— 失敗の瞬間に記録する
  it("列挙 ping が失敗(null)したらその瞬間に spawn_failed を書いて onSpawnFailed を1度呼び、deny 未解決のまま spawn しない(fail-open にしない・ADR 0025 point 6)", async () => {
    const rec = recordingEnumerator(null);
    const spawnFailures: Array<[string, { error_code: string | null; message: string }]> = [];
    const { start, calls, db } = await makeWorker(
      { "agents/deckhand.md": skilledMd("  - code-review\n") },
      {
        enumerateSkills: rec.enumerateSkills,
        onSpawnFailed: (taskId, failure, record) => {
        record();
        spawnFailures.push([taskId, failure]);
      },
      },
    );
    start("task-ping-fail");
    await vi.waitFor(() => expect(spawnFailures).toHaveLength(1));
    const [[, failure]] = spawnFailures as [[string, { error_code: string | null; message: string }]];
    expect(spawnFailures).toEqual([
      ["task-ping-fail", { error_code: null, message: expect.stringMatching(/^skill enumeration failed, so /) }],
    ]);
    expect(failure.message).not.toMatch(/time limit|reclaim/i);
    const failed = listEvents(db, "task-ping-fail").filter((e) => e.kind === "spawn_failed");
    expect(failed.map((e) => [e.actor_id, e.origin, e.payload])).toEqual([
      ["deckhand", "board", { kind: "spawn_failed", ...failure }],
    ]);
    // 列挙は試みたが、その失敗で子プロセスは起動しない
    expect(calls).toEqual([]);
  });

  it("列挙 ping が reject しても null と同じく spawn_failed を書いて onSpawnFailed を呼び、spawn しない(issue #770)", async () => {
    const spawnFailures: string[] = [];
    const { start, calls, db } = await makeWorker(
      { "agents/deckhand.md": skilledMd("  - code-review\n") },
      {
        enumerateSkills: async () => {
          throw new Error("reader blew up");
        },
        onSpawnFailed: (taskId, _failure, record) => {
        record();
        spawnFailures.push(taskId);
      },
      },
    );
    start("task-ping-reject");
    await vi.waitFor(() => expect(spawnFailures).toEqual(["task-ping-reject"]));
    expect(listEvents(db, "task-ping-reject").filter((e) => e.kind === "spawn_failed")).toHaveLength(1);
    expect(calls).toEqual([]);
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const sandbox = sandboxSettings(calls[0]!.args, logDir);
    expect(sandbox.enabled).toBe(true);
    expect(sandbox.allowUnsandboxedCommands).toBe(false);
    // 起動できなかった場合の fail-open ハッチも閉じる(ベンダー既定は「警告して
    // 裸で走る」— ADR 0033 が唯一拒む状態)
    expect(sandbox.failIfUnavailable).toBe(true);
    expect(sandbox.filesystem.denyRead).toEqual(["/"]);
    expect(sandbox.filesystem.allowRead).toContain(FIXTURE_WORKSPACE);
  });

  it.each([
    ["シンボリックリンク経由で登録した workspace は、実体のパス", true],
    ["シンボリックリンクでない workspace は、登録したパスのまま", false],
  ])("%sで sandbox settings の workspace 由来の行と spawn の cwd を書く(issue #1954)", async (_, link) => {
    const real = await realpath(await tempDir("tidepool-claude-ws-"));
    const registered = link ? join(await tempDir("tidepool-claude-link-"), "tidepool") : real;
    if (link) await symlink(real, registered);
    const { start, calls, logDir } = await makeWorker({ "workspaces.yaml": `tidepool:\n  path: ${registered}\n` });

    start("task-sbx-workspace-path");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const { allowRead, allowWrite, denyWrite } = sandboxSettings(calls[0]!.args, logDir).filesystem;
    expect(allowRead).toContain(real);
    expect(allowWrite).toEqual([real, calls[0]!.env.TMPDIR]);
    expect(denyWrite).toEqual([join(real, ".claude", "settings.json"), join(real, ".claude", "settings.local.json")]);
    expect(calls[0]!.cwd).toBe(real);
    if (link) expect(JSON.stringify({ allowRead, allowWrite, denyWrite })).not.toContain(registered);
  });

  it("registry の allowed_domains が実 spawn の network.allowedDomains に届く(ADR 0072)", async () => {
    const { start, calls, logDir } = await makeWorker({
      "workspaces.yaml": `tidepool:
  path: ${FIXTURE_WORKSPACE}
  allowed_domains:
    - registry.npmjs.org
`,
    });

    start("task-domain-egress");
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    expect(sandboxSettings(calls[0]!.args, logDir).network).toEqual({
      allowLocalBinding: true,
      strictAllowlist: true,
      allowedDomains: ["registry.npmjs.org"],
      deniedDomains: [],
    });
  });

  it("review タスクは allowWrite が task temp だけの profile で走る — profile は行為の性質(task.type)だけで決まり assignee によらない(ADR 0013)", async () => {
    const { start, calls, logDir } = await makeWorker();
    start("task-sbx-review", null, "deckhand", "review");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(sandboxSettings(calls[0]!.args, logDir).filesystem.allowWrite).toEqual([calls[0]!.env.TMPDIR]);
  });

  it("work タスクは workspace 内書き込みを許す profile で走る", async () => {
    const { start, calls, logDir } = await makeWorker();
    start("task-sbx-work", null, "deckhand", "work");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(sandboxSettings(calls[0]!.args, logDir).filesystem.allowWrite).toEqual([
      FIXTURE_WORKSPACE,
      calls[0]!.env.TMPDIR,
    ]);
  });

  it("Interview の root は面接室を cwd に acceptEdits で走り、面接室に書けて実環境を読みに開き Read の許可も足す。受験者は自分の checkout を cwd に走り、面接室も実環境も開かず、許可ドメインは実環境の宣言のまま(ADR 0273 決定1・2・8 / ADR 0276 決定1)", async () => {
    const real = await realpath(await tempDir("tidepool-claude-real-env-"));
    const { worker, setting, slot, calls, logDir, db } = await makeWorker({ "workspaces.yaml": `tidepool:\n  path: ${real}\n  allowed_domains:\n    - registry.npmjs.org\n` });
    const target = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
    const root = registerTask(db, { type: "interview", assignee: "deckhand", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [target] }, new Date(0), ...HUMAN_WEBUI);
    openTestInterviewRoom(db, root);
    slot.occupy(root.id);
    worker.start(root, setting(root));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [child] = poseAccepted(db, root, { title: "probe", probe: "p", completion_criteria: "c", rubric: "r" }, "deckhand", new Date(0), "worker", POSED_HEAD);
    const checkout = openTestExamineeCheckout(db, child!);
    slot.release();
    slot.occupy(child!.id);
    worker.start(child!, setting(child!));
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    const room = realpathSync(interviewRoomPath(db, root.id)!);
    expect(calls.map((call) => call.cwd)).toEqual([room, checkout]);
    const [rootCall, childCall] = calls as [(typeof calls)[0], (typeof calls)[0]];
    expect(rootCall.args[rootCall.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    const rootSandbox = sandboxSettings(rootCall.args, logDir);
    expect(rootSandbox.filesystem.allowWrite).toEqual([room, rootCall.env.TMPDIR]);
    expect(rootSandbox.filesystem.allowRead).toContain(real);
    expect(JSON.parse(readFileSync(rootCall.args[rootCall.args.indexOf("--settings") + 1]!, "utf8")).permissions.allow).toEqual([`Read(/${real}/**)`]);
    const childSandbox = sandboxSettings(childCall.args, logDir);
    expect(childSandbox.filesystem.allowRead).not.toContain(real);
    expect(childSandbox.filesystem.allowRead).not.toContain(room);
    expect(childSandbox.network.allowedDomains).toEqual(["registry.npmjs.org"]);
  });

  it.each(["監査 review", "監査の判断行への異議から立つ RCA review(監査の子)"] as const)("Interview の%sは実環境を cwd に manual で走り、書けるのは task temp だけで、root の面接室を読みに開き Read の許可も足す —— 付帯子の review は親の読みの面を継ぐ(ADR 0273 決定1・4)", async (reviewer) => {
    const real = await realpath(await tempDir("tidepool-claude-real-env-"));
    const { worker, setting, slot, calls, logDir, db } = await makeWorker({ "workspaces.yaml": `tidepool:\n  path: ${real}\n` }, { auditorName: "deckhand" });
    const target = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
    const root = registerTask(db, { type: "interview", assignee: "deckhand", title: "interview", hypothesis: "h", tier: "standard", interview_targets: [target] }, new Date(0), ...HUMAN_WEBUI);
    openTestInterviewRoom(db, root);
    const audit = poseProbe(db, root, { title: "probe", probe: "p", completion_criteria: "c", rubric: "r" }, "deckhand", new Date(0), "worker", POSED_HEAD);
    const task =
      reviewer === "監査 review"
        ? audit
        : registerTask(
            db,
            // 異議の id を運ぶ RCA —— 帰り先の無い系譜にも立つ(ADR 0301 決定2)
            { type: "review", assignee: "deckhand", title: "rca (self): audit", purpose: "p", completion_criteria: "c", parent_id: audit.id, opened_on_event_ids: [objectionOn(db, audit.id)] },
            new Date(0),
            BOARD_ACTOR_ID,
            "board",
          );
    slot.occupy(task.id);
    worker.start(task, setting(task));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const room = realpathSync(interviewRoomPath(db, root.id)!);
    const [call] = calls as [(typeof calls)[0]];
    expect(call.cwd).toBe(real);
    expect(call.args[call.args.indexOf("--permission-mode") + 1]).toBe("manual");
    const sandbox = sandboxSettings(call.args, logDir);
    expect(sandbox.filesystem.allowWrite).toEqual([call.env.TMPDIR]);
    expect(sandbox.filesystem.allowRead).toEqual(expect.arrayContaining([real, room]));
    expect(JSON.parse(readFileSync(call.args[call.args.indexOf("--settings") + 1]!, "utf8")).permissions.allow).toEqual([`Read(/${room}/**)`]);
  });

  // ADR 0257 決定2: CLI のプロセスの TMPDIR が task temp を指さないと、proxy の中継 socket が閉じた /tmp に
  // 置かれて許可ドメインに届かない。先例は tests/codex-worker.test.ts の issue #705 の task temp のテスト。
  it("spawn env の TMPDIR と CLAUDE_CODE_TMPDIR は同じ task temp を指し、それが settings の allowRead と allowWrite に入る(ADR 0257)", async () => {
    const { start, calls, logDir } = await makeWorker();
    for (const type of ["work", "review"] as const) {
      start(`task-temp-${type}`, null, "deckhand", type);
    }
    for (const call of calls) {
      const taskTemp = call.env.TMPDIR!;
      expect(call.env.CLAUDE_CODE_TMPDIR).toBe(taskTemp);
      expect(existsSync(taskTemp)).toBe(true);
      const { allowRead, allowWrite } = sandboxSettings(call.args, logDir).filesystem;
      expect(allowRead).toContain(taskTemp);
      expect(allowWrite).toContain(taskTemp);
    }
  });

  it("task temp は task ごとに別のパスになる(ADR 0257)", async () => {
    const { start, calls } = await makeWorker();
    start("task-temp-a");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    start("task-temp-b");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.env.TMPDIR).not.toBe(calls[1]!.env.TMPDIR);
  });

  it("worker の exit(0 / 非0 / signal)の後、task temp は残らない(ADR 0257 / issue #705 と同じ)", async () => {
    const { start, calls, emitExitAt } = await makeWorker();
    const exits = [[0, null], [2, null], [null, "SIGKILL"]] as const;
    exits.forEach((_, i) => start(`task-temp-exit-${i}`));
    const files = calls.map((call) => call.args[call.args.indexOf("--append-system-prompt-file") + 1]!);
    expect(files.every((file) => existsSync(file))).toBe(true);
    const taskTemps = calls.map((call) => call.env.TMPDIR!);
    expect(taskTemps.every((dir) => existsSync(dir))).toBe(true);

    exits.forEach(([code, signal], i) => emitExitAt(i, code, signal));
    expect(taskTemps.filter((dir) => existsSync(dir))).toEqual([]);
    expect(files.some((file) => existsSync(file))).toBe(false);
  });

  it("stdinの早期切断はexit0でも既存の報告なき終了の失敗と回収を通し、CLIの逐語を保つ", async () => {
    const onExit = vi.fn();
    const { start, calls, processes, emitExit, db, watchdog, containers, killed } = await makeWorker({}, { onWorkerExited: onExit });
    onExit.mockImplementation(watchdog.onWorkerExited);
    const value = start("stdin-error");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const file = calls[0]!.args[calls[0]!.args.indexOf("--append-system-prompt-file") + 1]!;
    expect(existsSync(file)).toBe(true);
    expect(() => processes[0]!.stdin.emit("error", new Error("broken pipe"))).not.toThrow();
    expect(killed).toContain("SIGKILL");
    emitExit(0, null);
    expect(listEvents(db, value.id).find((e) => e.kind === "worker_exited")!.payload).toMatchObject({ exit_code: 0, reported_error: null });
    expect(listBoard(db).find((task) => task.type === "question")?.title).toBe(`worker exited without reporting: ${value.title}`);
    expect(getTask(db, value.id)?.status).not.toBe("done");
    await containers.reclaimed(value.id);
    expect(existsSync(file)).toBe(false);
  });

  it("停止はsystem fileをCLIの終了まで保ち、終了の後始末で消す", async () => {
    const { worker, start, calls, emitExit, killed } = await makeWorker();
    const value = start("prompt-stop");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const file = calls[0]!.args[calls[0]!.args.indexOf("--append-system-prompt-file") + 1]!;
    worker.gracefulStop(value.id);
    expect(killed).toContain("SIGTERM");
    expect(existsSync(file)).toBe(true);
    emitExit(null, "SIGTERM");
    expect(existsSync(file)).toBe(false);
  });

  it("spawn の失敗(exit が来ないことがある)の後も、task temp は残らない(ADR 0257)", async () => {
    const { start, calls, emitError } = await makeWorker();
    start("task-temp-spawn-error");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const taskTemp = calls[0]!.env.TMPDIR!;
    const file = calls[0]!.args[calls[0]!.args.indexOf("--append-system-prompt-file") + 1]!;
    expect(existsSync(file)).toBe(true);

    emitError(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT", syscall: "spawn claude" }));
    expect(existsSync(taskTemp)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("spawn までの間に例外が出たら start はそれを投げ直し、task temp は残らない(ADR 0257 / issue #705 と同じ)", async () => {
    let file = "";
    // 同期に launch するのは ping の無い `[]` の形だけ(ADR 0335 決定1)。ping の後の throw は spawn_failed に落ちる(ADR 0149 決定6)
    const { start } = await makeWorker({ "agents/deckhand.md": skilledMd("  []\n") }, {
      containers: passthroughContainers((_command, args) => {
        file = args[args.indexOf("--append-system-prompt-file") + 1]!;
        expect(existsSync(file)).toBe(true);
        throw new Error("spawn blew up");
      }),
    });

    expect(() => start("task-temp-sync-throw")).toThrow("spawn blew up");
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith("tidepool-claude-task-temp-sync-throw-"))).toEqual([]);
  });

  it.each([
    [
      "untracked settings.json の sandbox + hooks",
      "settings.json",
      JSON.stringify({ sandbox: { filesystem: { allowRead: ["/"] } }, hooks: {} }),
    ],
    [
      "untracked settings.json の permissions",
      "settings.json",
      JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
    ],
    ["untracked settings.json の hooks", "settings.json", JSON.stringify({ hooks: {} })],
    ["settings.local.json の hooks", "settings.local.json", JSON.stringify({ hooks: {} })],
    [
      "settings.local.json の permissions",
      "settings.local.json",
      JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
    ],
    ["壊れた untracked settings.json", "settings.json", "{ not json"],
    // 読めないファイル: ディレクトリなら root で走る CI でも読み取りが失敗する
    ["読めない settings.local.json", "settings.local.json", null],
  ])("%s は spawn せず (claude-code, workspace) の組を quarantine する —— workspace は止めない(ADR 0259)", async (_case, name, body) => {
    const wsDir = await tempDir("tidepool-ws-");
    await mkdir(join(wsDir, ".claude"), { recursive: true });
    if (body === null) await mkdir(join(wsDir, ".claude", name));
    else await writeFile(join(wsDir, ".claude", name), body);
    const { start, calls, db, stops } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`,
    });
    const task = start("task-sbx-override");
    expect(calls).toEqual([]);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
    const question = quarantineQuestion(db, "workspaceContainment", "claude-code/tidepool");
    expect(question?.purpose).toContain(`.claude/${name}`);
    // spawn_failed にはせず、組の停止として盤面の一撃に1回渡す —— 一撃が todo へ戻して枠を空ける(ADR 0274)
    expect(listEvents(db, task.id).map((e) => e.kind)).not.toContain("spawn_failed");
    expect(stops).toEqual([[task.id, { kind: "pickup_stopped", quarantine: "workspaceContainment", value: "claude-code/tidepool", reason: expect.stringContaining(`.claude/${name}`) }]]);
  });

  it("workspace が盤面の状態パスと重なっていたら spawn せず workspace を quarantine する(issue #149 / ADR 0040)", async () => {
    // 盤面の DB が workspace の checkout の中にある形 — worker の書き込み半径
    // (allowWrite: [workspace.path])に盤面の状態が入る、issue #149 の本体。
    const wsDir = await tempDir("tidepool-ws-");
    const { start, calls, db, stops } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n` },
      { boardState: [{ label: "board database (TIDEPOOL_DB)", path: join(wsDir, "board.sqlite") }] },
    );
    const task = start("task-overlap");
    expect(calls).toEqual([]);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(true);
    const question = quarantineQuestion(db, "workspace", "tidepool");
    expect(question?.purpose).toContain("board database (TIDEPOOL_DB)");
    expect(stops).toEqual([[task.id, { kind: "pickup_stopped", quarantine: "workspace", value: "tidepool", reason: expect.stringContaining("board database (TIDEPOOL_DB)") }]]);
  });

  it("盤面の状態パスと交差しない workspace は spawn を止めない", async () => {
    const wsDir = await tempDir("tidepool-ws-");
    const boardDir = await tempDir("tidepool-board-");
    const { start, calls, db } = await makeWorker(
      { "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n` },
      { boardState: [{ label: "board database (TIDEPOOL_DB)", path: join(boardDir, "board.sqlite") }] },
    );
    start("task-no-overlap");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
  });

  it("重なりの検査は settings ガードより先に走る(盤面自身の checkout は自前の .claude/settings.json を持つので、後だと診断名が入れ替わる)", async () => {
    const wsDir = await tempDir("tidepool-ws-");
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
    const question = quarantineQuestion(db, "workspace", "tidepool");
    expect(question?.purpose).toContain("the board's own checkout (process cwd)");
    expect(question?.purpose).not.toContain("settings.local.json");
  });

  it.each([
    ["hooks(issue #382)", JSON.stringify({ hooks: { PostToolUse: [] }, model: "sonnet" })],
    ["permissions(ADR 0158)", JSON.stringify({ permissions: { allow: ["Bash(*)"] } })],
    [
      "sandbox + hooks(ADR 0158)",
      JSON.stringify({ sandbox: { filesystem: { allowRead: ["/"] } }, hooks: {} }),
    ],
    ["壊れた JSON(ADR 0158)", "{ not json"],
  ])("tracked settings.json の %s は spawn 前に実体化から外し、workspace を quarantine しない", async (_case, body) => {
    const ws = await makeWorkspace("tracked-settings");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    await writeFile(join(ws.path, ".claude", "settings.json"), body);
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "share project settings");
    const { start, calls, db, emitExit } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });
    start("task-sbx-plain-settings");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
    expect(() => readFileSync(join(ws.path, ".claude", "settings.json"), "utf8")).toThrow();
    expect(git(ws.path, "status", "--porcelain")).toBe("");

    emitExit(0, null);
    await vi.waitFor(() =>
      expect(readFileSync(join(ws.path, ".claude", "settings.json"), "utf8")).toBe(body),
    );
  });

  it("tracked settings.json を隠せなければ (claude-code, workspace) の組ではなく workspace を quarantine し、spawn しない(ADR 0259 決定1)", async () => {
    const ws = await makeWorkspace("tracked-settings-unhidable");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    await writeFile(join(ws.path, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "share project hooks");
    // 変更中の tracked ファイルは sparse-checkout が作業ツリーから消さない
    await writeFile(join(ws.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [] } }));
    const { start, calls, db, stops } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });
    const task = start("task-sbx-unhidable-settings");
    expect(calls).toEqual([]);
    expect(quarantineQuestion(db, "workspace", "tidepool")?.purpose).toContain("could not exclude");
    expect(quarantineQuestion(db, "workspaceContainment", "claude-code/tidepool")).toBeUndefined();
    expect(stops).toEqual([[task.id, { kind: "pickup_stopped", quarantine: "workspace", value: "tidepool", reason: expect.stringContaining("could not exclude") }]]);
  });

  it("隠れたままの tracked settings.json を戻せなければ workspace を quarantine して spawn せず、盤面の一撃で todo へ戻す(ADR 0158 / ADR 0274)", async () => {
    const ws = await makeWorkspace("tracked-settings-unrestorable");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    // 床キーも hooks も持たない settings は隠さずに走る —— 隠れたままなら戻すだけの枝に入る
    await writeFile(join(ws.path, ".claude", "settings.json"), JSON.stringify({}));
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "share project hooks");
    const { start, calls, db, stops } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });
    // 前の session が隠したまま(写しが残る —— ADR 0293 決定3)。index を lock で塞ぐと戻せない
    excludeWorkspaceProjectSettings(db, { ...ws, name: "tidepool" });
    await writeFile(join(ws.path, ".git", "index.lock"), "");
    const task = start("task-sbx-unrestorable-settings");
    expect(calls).toEqual([]);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(true);
    expect(stops).toEqual([[task.id, { kind: "pickup_stopped", quarantine: "workspace", value: "tidepool", reason: expect.stringContaining("sparse-checkout") }]]);
  });

  it("回収後に隠した settings.json を戻せなければ workspace を quarantine する(#1969)", async () => {
    const ws = await makeWorkspace("tracked-settings-unrestorable-after-reclaim");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    await writeFile(join(ws.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [] } }));
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "share project hooks");
    const { start, calls, db, emitExit } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });
    start("task-sbx-unrestorable-after-reclaim");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    await writeFile(join(ws.path, ".git", "index.lock"), "");

    emitExit(0, null);
    await vi.waitFor(() =>
      expect(quarantineQuestion(db, "workspace", "tidepool")?.purpose).toContain("sparse-checkout"),
    );
  });

  it("回収後の復元の書き込みも quarantine の書き込みも rollback しても、次の session の回収で復元できる(ADR 0342 決定5)", async () => {
    const ws = await makeWorkspace("tracked-settings-restore-rollback");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    const body = JSON.stringify({ hooks: { PostToolUse: [] } });
    await writeFile(join(ws.path, ".claude", "settings.json"), body);
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "share project hooks");
    const { start, calls, db, emitExitAt } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });
    const settings = () => readFileSync(join(ws.path, ".claude", "settings.json"), "utf8");
    const hidden = () => projectSettingsHiddenByBoard(db, { ...ws, name: "tidepool" });
    start("task-restore-rollback-1");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    db.exec(
      "CREATE TRIGGER fail_snapshot_drop BEFORE UPDATE OF sparse_snapshot ON workspace_state " +
        "BEGIN SELECT RAISE(ABORT, 'snapshot drop failed'); END",
    );
    const dropQuarantineTrigger = failQuarantineQuestion(db);

    const rejections = await unhandledRejectionsDuring(async () => {
      emitExitAt(0, 0, null);
      await vi.waitFor(() => expect(settings()).toBe(body));
    });
    expect(rejections).toEqual([expect.objectContaining({ message: "quarantine write failed" })]);
    expect(hidden()).toBe(true);
    db.exec("DROP TRIGGER fail_snapshot_drop");
    dropQuarantineTrigger();

    start("task-restore-rollback-2");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(settings).toThrow();
    emitExitAt(1, 0, null);

    await vi.waitFor(() => expect(settings()).toBe(body));
    expect(hidden()).toBe(false);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
  });

  it("人間の cone が .claude を外していれば、S bit が立っていても隠したものと読まず、tree を変えずに spawn する(ADR 0293 決定3)", async () => {
    const ws = await makeWorkspace("human-cone-without-claude");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    await mkdir(join(ws.path, "pkg-a"), { recursive: true });
    await writeFile(join(ws.path, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [] } }));
    await writeFile(join(ws.path, "pkg-a", "a.txt"), "a\n");
    git(ws.path, "add", ".");
    git(ws.path, "commit", "-m", "monorepo");
    git(ws.path, "sparse-checkout", "set", "pkg-a");
    const { start, calls, db, emitExit } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });

    start("task-human-cone");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
    expect(git(ws.path, "sparse-checkout", "list")).toBe("pkg-a");
    expect(git(ws.path, "config", "--get", "core.sparseCheckoutCone")).toBe("true");

    emitExit(0, null);
    await Promise.resolve();
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
    expect(git(ws.path, "sparse-checkout", "list")).toBe("pkg-a");
  });

  it("sparse 後に branch の settings.json が床キーへ変わっても quarantine せず、次の task も spawn する(ADR 0158)", async () => {
    const ws = await makeWorkspace("tracked-hooks-floor-change");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    await writeFile(
      join(ws.path, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [] } }),
    );
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "share project hooks");
    git(ws.path, "checkout", "-b", "unsafe-settings");
    await writeFile(
      join(ws.path, ".claude", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(*)"] } }),
    );
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "replace hooks with a floor override");
    git(ws.path, "checkout", "main");
    const { start, calls, db } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });

    start("task-hooks-safe");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    git(ws.path, "checkout", "unsafe-settings");
    start("task-hooks-unsafe");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls).toHaveLength(2);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
    expect(() => readFileSync(join(ws.path, ".claude", "settings.json"), "utf8")).toThrow();
    expect(git(ws.path, "status", "--porcelain")).toBe("");
  });

  it("同じ workspace の次 session が先に始まっても、全 container の回収までは hooks を戻さない", async () => {
    const ws = await makeWorkspace("tracked-hooks-overlap");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    const settings = JSON.stringify({ hooks: { PostToolUse: [] } });
    await writeFile(join(ws.path, ".claude", "settings.json"), settings);
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "share project hooks");
    const { start, calls, emitExitAt } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });

    start("task-hooks-first");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    start("task-hooks-second");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    emitExitAt(0, 0, null);
    await Promise.resolve();
    expect(() => readFileSync(join(ws.path, ".claude", "settings.json"), "utf8")).toThrow();

    emitExitAt(1, 0, null);
    await vi.waitFor(() =>
      expect(readFileSync(join(ws.path, ".claude", "settings.json"), "utf8")).toBe(settings),
    );
  });

  it("sparse 後に branch の settings.json から hooks が消えれば通常 project settings を再実体化する", async () => {
    const ws = await makeWorkspace("tracked-hooks-ordinary-change");
    await mkdir(join(ws.path, ".claude"), { recursive: true });
    await writeFile(
      join(ws.path, ".claude", "settings.json"),
      JSON.stringify({ hooks: { PostToolUse: [] } }),
    );
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "share project hooks");
    git(ws.path, "checkout", "-b", "ordinary-settings");
    const ordinary = JSON.stringify({ model: "sonnet" });
    await writeFile(join(ws.path, ".claude", "settings.json"), ordinary);
    git(ws.path, "add", ".claude/settings.json");
    git(ws.path, "commit", "-m", "replace hooks with ordinary settings");
    git(ws.path, "checkout", "main");
    const { start, calls, db } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${ws.path}\n`,
    });

    start("task-hooks-safe");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    git(ws.path, "checkout", "ordinary-settings");
    start("task-hooks-ordinary");
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls).toHaveLength(2);
    expect(workspaceNeedsHuman(db, "tidepool")).toBe(false);
    expect(readFileSync(join(ws.path, ".claude", "settings.json"), "utf8")).toBe(ordinary);
    expect(git(ws.path, "status", "--porcelain")).toBe("");
  });

  it("床キーを持たない通常の project settings(model 等)は spawn を止めない", async () => {
    const wsDir = await tempDir("tidepool-ws-");
    await mkdir(join(wsDir, ".claude"), { recursive: true });
    await writeFile(
      join(wsDir, ".claude", "settings.json"),
      JSON.stringify({ model: "sonnet" }),
    );
    const { start, calls, db } = await makeWorker({
      "workspaces.yaml": `tidepool:\n  path: ${wsDir}\n`,
    });
    start("task-sbx-harmless-settings");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
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
  // `mcp_servers` は 2.1.267 の init 行に必ず出る(実測)。実セッションでは盤面が
  // 書いた `tidepool` が接続済みで1つ載る —— 既定はその形(Worker MCP 到達性が止めない、ADR 0331 決定6)。
  const initLine = (tools: string[], mcpServers: unknown[] = [{ name: "tidepool", status: "connected" }], memoryPaths?: Record<string, string>) =>
    `${JSON.stringify({ type: "system", subtype: "init", tools, mcp_servers: mcpServers, memory_paths: memoryPaths })}\n`;
  const containmentQuestion = (db: ReturnType<typeof openDb>) =>
    quarantineQuestion(db, "containment", null);

  it("宣言どおりの init 行なら何も起きない — 封じ込めの question は立たない", async () => {
    const { start, processes, db } = await makeWorker();
    start("task-init-ok", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(
      // 実セッションには MCP verb も並ぶ — 比較対象外
      initLine([...WORK_SURFACE, "mcp__tidepool__get_current_task"]),
    );
    await vi.waitFor(() => expect(containmentQuestion(db)).toBeUndefined());
  });

  it("skills が空リストの agent の、Skill を含まない init 行では何も起きない — question も kill も無い(ADR 0185)", async () => {
    // `--disable-slash-commands` の下で CLI が返す面そのもの(#1268 の実測)。盤面の
    // 宣言がこれに合っていれば、照合は食い違いを見ない。
    const { start, processes, killed, db } = await makeWorker({
      "agents/deckhand.md": skilledMd("  []\n"),
    });
    start("task-init-noskills-ok", null, "deckhand", "work");
    processes[0]!.stdout.write(
      initLine([...WORK_SURFACE_WITHOUT_SKILL, "mcp__tidepool__get_current_task"]),
    );
    processes[0]!.stdout.write(`{"type":"result","result":"done"}\n`);
    await vi.waitFor(() => expect(killed).toEqual([]));
    await vi.waitFor(() => expect(containmentQuestion(db)).toBeUndefined());
  });

  it("skills が空リストの agent の init 行に Skill があれば不成立 — CLI が disable フラグを守らなくなった(ADR 0185)", async () => {
    const { start, processes, db } = await makeWorker({
      "agents/deckhand.md": skilledMd("  []\n"),
    });
    start("task-init-noskills-drift", null, "deckhand", "work");
    processes[0]!.stdout.write(initLine(WORK_SURFACE));
    const question = await vi.waitFor(() => {
      const q = containmentQuestion(db);
      expect(q).toBeDefined();
      return q!;
    });
    expect(question.purpose).toContain("Skill");
  });

  it("init 行に allowlist 外のツールが並んでいたら封じ込め能力の question が立つ(ADR 0039 決定3)", async () => {
    const { start, processes, db } = await makeWorker();
    start("task-init-drift", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // `CronCreate` は測定2 でそのまま実行できてしまったツールそのもの。`--tools` が
    // honor されていないホストでは、これが面に残る。
    processes[0]!.stdout.write(initLine(["Bash", "Read", "CronCreate"]));
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
    // 走らせる理由がない。slot は回収後の root の exit が0ターンの資源の停止として
    // todo へ戻して後始末へ入れる(ADR 0331 決定4)。
    const { start, processes, killed } = await makeWorker();
    start("task-init-kill", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine(["Bash", "Read", "CronCreate"]));
    await vi.waitFor(() => expect(killed).toContain("SIGKILL"));
  });

  it("ずれた面の回収は watchdog と同じ回収 module(worker 容器)を通る(ADR 0099 決定2)", async () => {
    // session を終わらせる経路が2つある以上、回収の書き方が2つあってはならない。
    // adapter が signal を直に撃たないことまで含めてここで測る。
    const recorder = recordingSpawn();
    onTestFinished(() => recorder.emitExit(0, null)); // task temp の後始末(ADR 0257)
    const runtime = new FakeContainerRuntime(recorder.spawn);
    const { start } = await makeWorker({}, { containers: new ProcessContainers(runtime) });
    const task = start("task-init-container-kill", null, "deckhand", "work");
    await vi.waitFor(() => expect(recorder.processes).toHaveLength(1));
    recorder.processes[0]!.stdout.write(initLine(["Bash", "Read", "CronCreate"]));
    await vi.waitFor(() => expect(runtime.forceReclaims).toEqual([task.id]));
    expect(recorder.killed).toEqual([]);
  });

  it("宣言どおりのセッションは kill されない", async () => {
    const { start, processes, killed, db } = await makeWorker();
    start("task-init-nokill", null, "deckhand", "review");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(
      initLine([...REVIEW_SURFACE, "mcp__tidepool__get_current_task"]),
    );
    processes[0]!.stdout.write(`{"type":"result","result":"done"}\n`);
    await vi.waitFor(() => expect(killed).toEqual([]));
    await vi.waitFor(() => expect(containmentQuestion(db)).toBeUndefined());
  });

  it("review セッションの init 行は review の期待集合で照合される — 編集系が残っていたら不成立", async () => {
    const { start, processes, db } = await makeWorker();
    start("task-init-review-drift", null, "deckhand", "review");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(
      initLine([...REVIEW_SURFACE, "Write", "Edit", "NotebookEdit"]),
    );
    const question = await vi.waitFor(() => {
      const q = containmentQuestion(db);
      expect(q).toBeDefined();
      return q!;
    });
    expect(question.purpose).toContain("Write");
    expect(question.purpose).toContain("Edit");
    expect(question.purpose).toContain("NotebookEdit");
  });

  it("ずれたまま何セッション走っても question は1枚(封じ込めは1資源につき確認1枚)", async () => {
    const { start, processes, db } = await makeWorker();
    start("task-init-dup-1", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine(["Bash", "Read", "CronCreate"]));
    const question = await vi.waitFor(() => {
      const q = containmentQuestion(db);
      expect(q).toBeDefined();
      return q!;
    });
    const refiredCount = () =>
      listEvents(db, question.id)
        .map((e) => e.payload)
        .filter((p) => p.kind === "quarantine_refired").length;

    // 2セッション目・3セッション目はそれぞれ別の process(別セッション)で起こす —
    // 同じ process の stdout に3回書くだけでは1セッションしか検査を走らせない
    // (issue #873)。各セッションが実際に照合されたことは、既存 question への
    // `quarantine_refired` 追記が1つずつ増えることで確かめる。
    start("task-init-dup-2", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(2));
    processes[1]!.stdout.write(initLine(["Bash", "Read", "CronCreate"]));
    await vi.waitFor(() => expect(refiredCount()).toBe(1));

    start("task-init-dup-3", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(3));
    processes[2]!.stdout.write(initLine(["Bash", "Read", "RemoteTrigger"]));
    await vi.waitFor(() => expect(refiredCount()).toBe(2));

    expect(listBoard(db).filter((t) => t.type === "question")).toHaveLength(1);
  });

  it("init 行を持たないセッションは判定しない — 盤面の照合は観測があったときだけ動く", async () => {
    // `tools` を持たない init 行、壊れた行、`result` 行は「init の報告ではない」と
    // 読む(`parseInitSkills` と同じ fail-closed の形)。ここで question を立てると、
    // 正本である `/usage` ping が答えるべき問いを stdout の欠落で代弁してしまう。
    const { start, processes, db } = await makeWorker();
    start("task-init-absent", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(`{"type":"system","subtype":"init"}\n`);
    processes[0]!.stdout.write(`{"type":"result","result":"done"}\n`);
    processes[0]!.stdout.write(`{not json\n`);
    await vi.waitFor(() => expect(containmentQuestion(db)).toBeUndefined());
  });

  it("`tools` は読めて `mcp_servers` が読めない init 行は不成立 — 正本には見えない面(ADR 0108)", async () => {
    // `tools` の門を抜けた時点で手元にあるのは**読めた init 報告**なので、そこで
    // `mcp_servers` だけが読めないのは torn な行ではなく形の変化である。正本の ping は
    // `--strict-mcp-config` を `--mcp-config` 無しで撃つので `mcp_servers` は構造上
    // いつも空 —— 要素の形が変わっても空配列は空配列のまま通る。要素を持つのは
    // `tidepool` が付いた実セッションだけなので、ここで倒さないと MCP 軸が黙って死ぬ。
    const { start, processes, db } = await makeWorker();
    start("task-init-mcp-unreadable", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine(WORK_SURFACE, [{ status: "connected" }]));
    const question = await vi.waitFor(() => {
      const q = containmentQuestion(db);
      expect(q).toBeDefined();
      return q!;
    });
    expect(question.purpose).toContain("mcp_servers");
  });

  // ADR 0156 決定3: 実セッションの init 行でも auto-memory の閉鎖を確かめる。per-task の
  // `--settings` が丸ごと黙って無視された場合、正本の probe(inline の2キーだけを運ぶ)は
  // 通ってしまうので、観測できるのはここだけである。止め方はツール面のずれと同じ経路。
  it("init 行に memory_paths.auto が有ればそのセッションを強制回収し、封じ込めの question が立つ", async () => {
    const { start, processes, db, killed } = await makeWorker();
    start("task-init-auto-memory", null, "deckhand", "work");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(
      initLine(WORK_SURFACE, [], { auto: "/home/pi/.claude/projects/x/memory" }),
    );
    await vi.waitFor(() => expect(killed).toContain("SIGKILL"));
    const question = await vi.waitFor(() => {
      const q = containmentQuestion(db);
      expect(q).toBeDefined();
      return q!;
    });
    expect(question.purpose).toContain("/home/pi/.claude/projects/x/memory");
  });

  it("セッションの stream-json を全量ファイルに記録する(監査性)", async () => {
    const { start, processes, logDir, db } = await makeWorker();
    start("task-7");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(`{"type":"system","subtype":"init"}\n`);
    processes[0]!.stdout.write(`{"type":"result","result":"done"}\n`);
    processes[0]!.stdout.end();
    // issue #379: ファイル名は worker_spawned の event id を挟んでセッションごとに
    // 一意 — その id はイベントログから読み返す(採番自体はここでは検証しない)
    const spawnedId = listEvents(db, "task-7").find((e) => e.kind === "worker_spawned")!.id;
    await vi.waitFor(async () => {
      const transcript = await readFile(
        join(logDir, `task-7.${spawnedId}.stream.jsonl`),
        "utf8",
      );
      expect(transcript).toBe(
        `{"type":"system","subtype":"init"}\n{"type":"result","result":"done"}\n`,
      );
    });
  });

  it("セッションの stderr を <taskId>.<event id>.stderr.log として stream.jsonl の隣に全量保存する(issue #125 / #379)", async () => {
    const { start, processes, logDir, db } = await makeWorker();
    start("task-stderr");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stderr.write("Error: Invalid API key\n");
    processes[0]!.stderr.write("(run /login to authenticate)\n");
    processes[0]!.stderr.end();
    const spawnedId = listEvents(db, "task-stderr").find((e) => e.kind === "worker_spawned")!.id;
    await vi.waitFor(async () => {
      const log = await readFile(join(logDir, `task-stderr.${spawnedId}.stderr.log`), "utf8");
      expect(log).toBe("Error: Invalid API key\n(run /login to authenticate)\n");
    });
  });

  it("200KiB以上のstdinとsession専用system fileが持ち主・task・配置の記録と逐語で一致する", async () => {
    const large = `開始\n${"魚🐟\n".repeat(40000)}末尾\n\n`;
    const recorder = recordingSpawn();
    const { calls, processes } = recorder;
    let systemAtSpawn = "";
    const { worker, setting, logDir, db } = await makeWorker({ "agents/deckhand.md": `---\ndescription: d\nversion: 1\nauthority: standard\nskills: []\n---\n${large}` }, { containers: passthroughContainers((command, args, options) => {
      systemAtSpawn = readFileSync(args[args.indexOf("--append-system-prompt-file") + 1]!, "utf8");
      return recorder.spawn(command, args, options);
    }) });
    onTestFinished(() => recorder.emitExit(0, null));
    const value = makeTask("task-prompt");
    value.purpose = large;
    insertTask(db, value);
    worker.start(value, setting(value));
    const spawned = listEvents(db, value.id).find((e) => e.kind === "worker_spawned")!;
    const recorded = new TranscriptStore(logDir).readPrompt(value.id, spawned.id)!;
    const args = calls[0]!.args;
    const file = args[args.indexOf("--append-system-prompt-file") + 1]!;
    expect(calls[0]!.stdin).toBe("pipe");
    expect(args).not.toContain(large);
    expect(args).not.toContain("--append-system-prompt");
    expect(recorded.placement).toEqual({ board: "system" });
    expect(recorded.board[0]!.text).toBe(large.trimEnd());
    expect(readFileSync(file, "utf8")).toBe(recorded.board.map((p) => p.text).join(""));
    expect(systemAtSpawn).toBe(recorded.board.map((p) => p.text).join(""));
    expect(processes[0]!.stdin.read()?.toString()).toBe(recorded.task);
    expect(recorded.task).toBe(`First call get_current_task for task ${value.id}, then complete this task: ${value.title}\n\nPurpose: ${large}\nCompletion criteria: ${value.completion_criteria}`);
    expect(processes[0]!.stdin.writableEnded).toBe(true);
    const { registry_commit, definition_version } = spawned.payload as Extract<EventPayload, { kind: "worker_spawned" }>;
    expect(recorded.board[0]).toMatchObject({ part: "definition", registry_commit, definition_version });
  });

  it("user turn は Codex と同じ文で title / purpose / 完了基準を持ち、記録した prompt の user も同じ文になる(ADR 0320 決定2 / ADR 0124 決定1)", async () => {
    const { start, calls, processes, logDir, db } = await makeWorker();
    start("task-user-turn");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spawnedId = listEvents(db, "task-user-turn").find((e) => e.kind === "worker_spawned")!.id;
    const args = calls[0]!.args;

    const expected =
      "First call get_current_task for task task-user-turn, then complete this task: fix the leaky faucet\n\n" +
      "Purpose: stop the drip\nCompletion criteria: no drip for 24h";
    expect(args).not.toContain(expected);
    expect(processes[0]!.stdin.read()?.toString()).toBe(expected);
    const recorded = JSON.parse(await readFile(join(logDir, `task-user-turn.${spawnedId}.prompt.json`), "utf8"));
    expect(recorded.task).toBe(expected);
  });

  it("同一タスクを2回 spawn すると、両方の worker session の transcript が別ファイルで残る(issue #379)", async () => {
    const { worker, start, setting, logDir } = await makeWorker();
    const task = start("task-retry");
    // retry / decompose 復帰 / quarantine 復帰はいずれも同じ task を worker が
    // 再度 start する形なので、直接 worker.start を2回呼んで再現する
    worker.start(task, setting(task));
    await vi.waitFor(async () => {
      const files = (await readdir(logDir)).filter((name) => name.startsWith("task-retry."));
      expect(files.filter((name) => name.endsWith(".stream.jsonl"))).toHaveLength(2);
      expect(files.filter((name) => name.endsWith(".stderr.log"))).toHaveLength(2);
      expect(files.filter((name) => name.endsWith(".prompt.json"))).toHaveLength(2);
    });
  });

  it("worker session の終わりに transcript を Precedent に投影する — 書き込みが flush され worker_exited が記録されたあと(issue #356)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    const task = start("task-precedent", "tidepool", "deckhand");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(`{"type":"system","subtype":"init","claude_code_version":"9.9.9"}\n`);
    processes[0]!.stdout.write(
      `{"type":"assistant","uuid":"u1","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}\n`,
    );
    processes[0]!.stdout.end();
    emitExit(0, null);

    const episode = await vi.waitFor(() => {
      const [found] = listEpisodes(db, { workspace: "tidepool", agent: "deckhand" });
      expect(found).toBeDefined();
      return found!;
    });
    expect(episode.taskId).toBe(task.id);
    expect(episode.actions.map((a) => [a.tool, a.args])).toEqual([["Bash", "ls"]]);
    expect(episode.cliVersion).toBe("9.9.9");
    // exit の事実は投影の入力 — worker_exited を書いたあとに投影している証拠
    expect(episode.exitCode).toBe(0);
    expect(episode.workerExitedEventId).toBe(
      listEvents(db, task.id).find((e) => e.kind === "worker_exited")!.id,
    );
  });

  it("session の Episode の投影待ちは transcript を開いた時点から立ち、投影の決着で外れる(issue #2570)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    const task = start("task-projection-pending", "tidepool", "deckhand");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    const spawnedId = listEvents(db, task.id).find((e) => e.kind === "worker_spawned")!.id;
    expect(projectionPending(db, spawnedId)).toBe(true);

    processes[0]!.stdout.end();
    emitExit(0, null);
    // worker_exited を書いた後も、transcript の書き込みストリームが閉じて投影が決着するまでは立ったまま
    expect(listEvents(db, task.id).some((e) => e.kind === "worker_exited")).toBe(true);
    expect(projectionPending(db, spawnedId)).toBe(true);
    await vi.waitFor(() => expect(listEpisodes(db, { workspace: "tidepool", agent: "deckhand" })).toHaveLength(1));

    expect(projectionPending(db, spawnedId)).toBe(false);
  });

  it("worker_exited は自分を開いた worker_spawned の event id を持ち、そのセッションの transcript ファイル名を再構成できる(issue #379 code review)", async () => {
    const { calls, start, emitExit, db, logDir } = await makeWorker();
    const task = start("task-exit-pointer");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitExit(0, null);
    const spawned = listEvents(db, task.id).find((e) => e.kind === "worker_spawned")!;
    const exited = listEvents(db, task.id).find((e) => e.kind === "worker_exited")!;
    const payload = exited.payload as Extract<EventPayload, { kind: "worker_exited" }>;
    expect(payload.worker_spawned_event_id).toBe(spawned.id);
    await vi.waitFor(async () => {
      await expect(
        readFile(join(logDir, `${task.id}.${payload.worker_spawned_event_id}.stream.jsonl`), "utf8"),
      ).resolves.not.toThrow();
    });
  });

  it("相対 logDir でも MCP config への参照は絶対パス(spawn 先の cwd は workspace であって盤面ではない)", async () => {
    const registryDir = await makeRegistry();
    const base = await tempDir("tidepool-relative-logs-");
    const prevCwd = process.cwd();
    process.chdir(base);
    try {
      const db = openDb(":memory:");
      const recorder = recordingSpawn();
      onTestFinished(() => recorder.emitExit(0, null)); // task temp の後始末(ADR 0257)
      const worker = new ClaudeCodeWorker({
        db,
        clock: new FakeClock(),
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "deckhand",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:4589/mcp",
        logDir: "worker-logs",
        transcripts: new TranscriptStore("worker-logs"),
        ...containerHarness(passthroughContainers(recorder.spawn)),
        ...noSkillPings,
      });
      await mkdir(join(base, "worker-logs"), { recursive: true });
      const task = makeTask("task-rel");
      insertTask(db, task);
      worker.start(task, pickedSetting(db, { dir: registryDir, mode: "purely-local" }, task));
      await vi.waitFor(() => expect(recorder.calls).toHaveLength(1));
      const args = recorder.calls[0]!.args;
      const configPath = args[args.indexOf("--mcp-config") + 1]!;
      expect(isAbsolute(configPath)).toBe(true);
      // and the file really is where the flag says it is
      await readFile(configPath, "utf8");
    } finally {
      process.chdir(prevCwd);
    }
  });

  // ADR 0110 決定3: fallback の出所が adapter 定数から盤面の表へ移った。明示
  // ピン留めの要求(ADR 0005)は不変で、変わったのは**どこから値が来るか**だけ。
  it("model は常に明示的に渡す: agent が tier を書かなければ盤面既定のティアの行(ホストのモデル設定を漏らさない)", async () => {
    const { start, calls } = await makeWorker();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.join(" ")).toContain("--model claude-sonnet-5-5");
  });

  it("agent が tier を書けばその行の model を使う", async () => {
    const { start, calls } = await makeWorker({
      "agents/deckhand.md": `---\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent\ntier: economy\n---\nYou are Deckhand.\n`,
    });
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.join(" ")).toContain("--model claude-sonnet-5-5");
  });

  it("effort は明示的に渡す: 値は表の行から来る(ホストの effort 設定を漏らさない)", async () => {
    const { start, calls } = await makeWorker();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.join(" ")).toContain("--effort high");
  });

  it("effort「無い」の行で走る worker は --effort 無しで spawn され、worker_spawned の effort は null(ADR 0218 決定5)", async () => {
    const { worker, db, calls } = await makeWorker();
    const task = makeTask("task-no-effort", null, "deckhand", "work");
    insertTask(db, task);
    worker.start(task, { provider: "anthropic", model: "claude-haiku-4-5-20251001", effort: null, advisor: undefined, tier_id: 1, source: { tier: "board", provider: "only" } });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.join(" ")).toContain("--model claude-haiku-4-5-20251001");
    expect(calls[0]!.args).not.toContain("--effort");
    expect(listEvents(db, "task-no-effort").find((e) => e.kind === "worker_spawned")!.payload).toMatchObject({ effort: null });
  });

  it("worker_spawned は選ばれた実行設定と、そのティアの出所を刻む(ADR 0110 決定3 — agent.md からはもう復元できない事実)", async () => {
    const board = await makeWorker();
    board.start("task-setting-board");
    await vi.waitFor(() => expect(board.calls).toHaveLength(1));
    expect(
      listEvents(board.db, "task-setting-board").find((e) => e.kind === "worker_spawned")!.payload,
    ).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-5-5",
      effort: "high",
      source: { tier: "board", provider: "only" },
    });

    const agent = await makeWorker({
      "agents/deckhand.md": `---\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\ndescription: General work agent\ntier: frontier\n---\nYou are Deckhand.\n`,
    });
    agent.start("task-setting-agent");
    await vi.waitFor(() => expect(agent.calls).toHaveLength(1));
    expect(
      listEvents(agent.db, "task-setting-agent").find((e) => e.kind === "worker_spawned")!.payload,
    ).toMatchObject({ model: "claude-fable-5-1", source: { tier: "agent", provider: "only" } });
  });

  it("worker_spawned は Provider の出所も刻む —— 単一 entry の agent は only(ADR 0110 決定5 / issue #544)", async () => {
    const board = await makeWorker();
    board.start("task-provider-source");
    await vi.waitFor(() => expect(board.calls).toHaveLength(1));
    expect(
      listEvents(board.db, "task-provider-source").find((e) => e.kind === "worker_spawned")!.payload,
    ).toMatchObject({ provider: "anthropic", source: { tier: "board", provider: "only" } });
  });

  it("盤面が選んだ実行設定を渡されたら、spawn 側で解決し直さずそれで走る(#544 —— 再解決は除外の文脈を持たない)", async () => {
    const { worker, db, calls } = await makeWorker();
    const task = makeTask("task-carried-setting", null, "deckhand", "work");
    insertTask(db, task);
    // 盤面の表の economy 行は claude-sonnet-5-5。渡された設定はそれと違う値で、しかも
    // 「順位で選ばれた」出所を持つ —— どちらも再解決からは出てこない
    worker.start(task, {
      provider: "anthropic",
      model: "opus",
      effort: "max",
      advisor: undefined,
      tier_id: 1, source: { tier: "task", provider: "rank" },
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.join(" ")).toContain("--model opus");
    expect(calls[0]!.args.join(" ")).toContain("--effort max");
    expect(
      listEvents(db, "task-carried-setting").find((e) => e.kind === "worker_spawned")!.payload,
    ).toMatchObject({ model: "opus", effort: "max", source: { tier: "task", provider: "rank" } });
  });

  it.each(["work", "review"] as const)("%s task の worker_spawned は、盤面が選んだ候補の段の id を持つ(ADR 0210 決定1)", async (type) => {
    const { calls, worker, db } = await makeWorker();
    const task = makeTask(`task-tier-${type}`, null, "deckhand", type);
    insertTask(db, task);
    worker.start(task, { provider: "anthropic", model: "opus", effort: "high", advisor: undefined, tier_id: 3, source: { tier: "task", provider: "rank" } });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(listEvents(db, task.id).find((e) => e.kind === "worker_spawned")!.payload).toMatchObject({ tier_id: 3 });
  });

  it("表の行を書き換えれば次の spawn の model / effort が変わる — 正本は DB であって adapter の定数ではない", async () => {
    const { start, calls, db } = await makeWorker();
    db.prepare(
      "UPDATE execution_settings SET model = 'claude-opus-5', effort = 'max' WHERE provider = 'anthropic' AND tier_id = (SELECT id FROM tiers WHERE name = 'economy')",
    ).run();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.args.join(" ")).toContain("--model claude-opus-5");
    expect(calls[0]!.args.join(" ")).toContain("--effort max");
  });

  it("設定ミス(未知の workspace 名)は boot 時のコンストラクタで即座に失敗する", async () => {
    // a misconfigured registry must refuse to start the board, not wedge the
    // first task at pickup time
    const registryDir = await makeRegistry();
    const logDir = await tempDir("tidepool-worker-logs-");
    expect(
      () =>
        new ClaudeCodeWorker({
          db: openDb(":memory:"),
          clock: new FakeClock(),
          registry: { dir: registryDir, mode: "purely-local" },
          agent: "deckhand",
          workspace: "no-such-workspace",
          mcpUrl: "http://127.0.0.1:4589/mcp",
          logDir,
          transcripts: new TranscriptStore(logDir),
          ...containerHarness(passthroughContainers(recordingSpawn().spawn)),
        }),
    ).toThrow(/unknown workspace/);
  });

  it("checkUsage はプロンプト到達パターンを待ち、さらに入力ボックスが落ち着いてから /usage を送る(盲送りしない・描画直後の取りこぼしも避ける・ADR 0028)", async () => {
    const rec = recordingPty();
    const { worker } = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる

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
      await vi.advanceTimersByTimeAsync(5_000); // パネル debounce → Ctrl-C×2
      rec.emitExit(); // Ctrl-C に応じて root が exit する
      await vi.runAllTimersAsync(); // 画面合成を完了
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage はパネル描画を捉えたら Ctrl-C×2 で終了させ、ANSI ではなく合成画面を返す(ADR 0074)", async () => {
    const rec = recordingPty();
    const { worker, runtime } = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる

      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(5_000); // settle を過ぎて /usage 送信
      // ANSI エスケープを含む生描画を、端末画面へ合成して返す。
      const panel =
        "\x1b[1mCurrent session: 56% used · resets Jul 9 at 5:59pm\x1b[0m\n" +
        "Current week (all models): 12% used · resets Jul 14\n";
      rec.emitData(panel);
      await vi.advanceTimersByTimeAsync(5_000); // パネル debounce → Ctrl-C×2
      expect(rec.writes.at(-1)).toBe("\x03\x03");
      expect(runtime.forceReclaims).toEqual([]);

      // root が Ctrl-C に応じて exit する —— 口はその exit で容器ごと force を撃つ
      rec.emitExit();
      await vi.runAllTimersAsync(); // 画面合成を完了

      const screen = await pending;
      expect(screen).toContain("Current session: 56% used");
      expect(screen).not.toContain("\x1b[1m");
      expect(runtime.forceReclaims).toEqual(runtime.created);
      // root への直接の kill は無い(孤児を残さない保証は容器が担う — ADR 0136 決定8)
      expect(rec.kills).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage はパネルのヘッダ2行が出ても即断せず、描画が静穏化するまで待って後続チャンクの % / reset まで取り込む", async () => {
    const rec = recordingPty();
    const { worker } = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる
      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(5_000);

      // ヘッダ2行は出そろったが、% / reset 行はまだ後続チャンク
      rec.emitData("Current session\nCurrent week (all models)\n");
      // debounce 未満のうちに残りが届く(チャンク境界で数値が分断されるケース)
      await vi.advanceTimersByTimeAsync(200);
      rec.emitData("56% used\nResets Jul 9\n");
      await vi.advanceTimersByTimeAsync(5_000); // 静穏化 → Ctrl-C×2
      rec.emitExit();
      await vi.runAllTimersAsync(); // 画面合成を完了

      const screen = await pending;
      // 後続チャンクの数値まで取り込めている(ヘッダ即断なら失われていた)
      expect(screen).toContain("56% used");
      expect(screen).toContain("Resets Jul 9");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage は旧500ms窓より遅い差分再描画まで待ち、fable ラベルを含む合成画面を返す(issue #323)", async () => {
    const rec = recordingPty();
    const { worker } = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる
      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(5_000);

      rec.emitData(
        "\x1b[?1049h\x1b[2J\x1b[H" +
          "Current session\r\n10% used\r\nResets 1:30pm (Asia/Tokyo)\r\n" +
          "Current week (all models)\r\n5% used\r\nResets Aug 20 at 1pm (Asia/Tokyo)\r\n" +
          "   Current week (all models)\r\n0% used\r\nResets Aug 20 at 1pm (Asia/Tokyo)",
      );
      // Pi 実測の redraw gap は499ms/485ms。1秒後の差分でも、2秒窓はまだ確定しない。
      await vi.advanceTimersByTimeAsync(1_000);
      rec.emitData(
        "\x1b[7;1H\x1b[17CFable)\x1b[K" +
          "\x1b[8;1H7% used\x1b[K" +
          "\x1b[9;1HResets Aug 20 at 1pm (Asia/Tokyo)\x1b[K",
      );
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(pending).resolves.toContain("Current week (Fable)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage はパネル描画後の再描画がタイムアウトまで止まらなくても、その時点の合成画面を返す(ADR 0074 safety floor)", async () => {
    const rec = recordingPty();
    const { worker, runtime } = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる
      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(5_000);
      rec.emitData(
        "\x1b[?1049h\x1b[2J\x1b[HCurrent session\r\n10% used\r\n" +
          "Resets 1:30pm (Asia/Tokyo)\r\nCurrent week (all models)\r\n5% used\r\n" +
          "Resets Aug 20 at 1pm (Asia/Tokyo)",
      );

      // 1秒ごとの再描画で2秒の quiet debounce を延ばし続ける。
      for (let second = 6; second < 30; second += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
        rec.emitData("\x1b[1;1HCurrent session");
      }
      await vi.advanceTimersByTimeAsync(1_000); // 30s の全体 timeout → Ctrl-C×2
      expect(rec.writes.at(-1)).toBe("\x03\x03");

      // root は Ctrl-C に応じない: 猶予のあいだは force を撃たず、過ぎたら口の force で畳む
      await vi.advanceTimersByTimeAsync(4_000);
      expect(runtime.forceReclaims).toEqual([]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runtime.forceReclaims).toEqual(runtime.created);
      await vi.runAllTimersAsync(); // headless terminal の非同期 write を完了

      await expect(pending).resolves.toContain("Current session");
      // root への直接の kill は無い(ADR 0136 決定8)
      expect(rec.kills).toEqual([]);
      // パネルは見えている = 列挙漏れではないので、画面を盤面ログに流さない
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("checkUsage はパネル未描画のままタイムアウトしたら容器ごと回収して null を返す(fail-closed・孤児を残さない)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rec = recordingPty();
      const { worker, runtime } = await makeUsageWorker(rec.pty);
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる

      // プロンプトには着いたが /usage パネルが返ってこない(CLI ハング相当)
      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(pending).resolves.toBeNull();
      // 孤児を残さない: Ctrl-C×2 に応じない root は口の force で容器ごと畳む。直接の kill は無い
      expect(rec.writes.at(-1)).toBe("\x03\x03");
      expect(runtime.forceReclaims).toEqual(runtime.created);
      expect(rec.kills).toEqual([]);
      // REPL には着いている = 初回対話で止まってはいないので、画面は残さない
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("checkUsage は REPL に着かないままタイムアウトしたら、画面の先頭だけを盤面ログに1行残す(ADR 0131 決定3)", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const rec = recordingPty();
      const { worker } = await makeUsageWorker(rec.pty);
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる

      // 初回対話(テーマ選択)が REPL より手前に出て、プロンプトに一度も着かない。
      // #738 の実測どおり、門を名指しする行はスプラッシュの ASCII アートの下にある
      rec.emitData(
        [
          "\x1b[2J\x1b[H Welcome to Claude Code v2.1.276",
          " ..........................................................",
          "      *                                       █████▓▓░",
          "             ░░░░░░                        ███▓░",
          "    ░░░░░░░░░░░░░░░░░░░    *                ██▓░░      ▓",
          " .......█ █   █ █..........................................",
          "",
          " Let's get started.",
          "",
          " Choose the text style that looks best with your terminal",
          " To change this later, run /theme",
          "",
          "   1. Auto (match terminal)",
          " ❯ 2. Dark mode ✔",
          `   3. TAIL_BEYOND_CAP ${"x".repeat(400)}`,
        ].join("\r\n"),
      );
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(pending).resolves.toBeNull();
      // どの門で止まったかが人間に読める(cli-auth の1行しか残らなかったのが #682)。
      // アートと罫線の行は落ち、ダイアログ自身の語が 200 文字の内側に入る
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "[usage] timed out before the CLI prompt: Welcome to Claude Code v2.1.276 | " +
            "Let's get started. | Choose the text style that looks best with your terminal | " +
            "To change this later, run /theme",
        ),
      );
      // 長さは固定 —— 画面全体を盤面ログに流し込まない
      expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining("TAIL_BEYOND_CAP"));
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("checkUsage はセッションがパネル前に終了(認証落ち・CLI 不在相当)したら null を返す", async () => {
    const rec = recordingPty();
    const { worker } = await makeUsageWorker(rec.pty);
    const pending = worker.checkUsage();
    await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる

    rec.emitExit();

    await expect(pending).resolves.toBeNull();
  });

  it("checkUsage は spawn 自体が投げても(claude バイナリ不在)null に丸める", async () => {
    const failingPty: PtyFn = () => {
      throw new Error("claude binary not found");
    };
    const { worker } = await makeUsageWorker(failingPty);

    await expect(worker.checkUsage()).resolves.toBeNull();
  });

  it("checkUsage は口の時間上限に達したら null を返す(fail-closed)", async () => {
    // 口の上限は注入した時計で数え、scrape の timer は setTimeout —— setImmediate は
    // FakeClock の前進が使うので本物のまま
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const rec = recordingPty();
      const { worker, clock } = await makeUsageWorker(rec.pty);
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1));

      await clock.advance(10 * 60_000);

      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkUsage は容器の機構前提が不成立なら PTY を起こさず null を返す(ADR 0136 決定7)", async () => {
    const rec = recordingPty();
    const { worker, runtime } = await makeUsageWorker(rec.pty);
    runtime.scriptPreflight("cgroup v2 is not mounted at /sys/fs/cgroup");

    await expect(worker.checkUsage()).resolves.toBeNull();
    expect(rec.calls).toEqual([]);
  });

  it("checkUsage は board 自身の cwd で claude --safe-mode を、折り返しを避ける広い桁幅で起動する(ADR 0028)", async () => {
    const rec = recordingPty();
    const { worker } = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる
      rec.emitData(PROMPT_READY_MARKER);
      await vi.advanceTimersByTimeAsync(5_000);
      rec.emitData("Current session: 1%\nCurrent week: 1%\n");
      await vi.advanceTimersByTimeAsync(5_000); // パネル debounce → Ctrl-C×2
      rec.emitExit();
      await vi.runAllTimersAsync(); // 画面合成を完了
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
    const { worker } = await makeUsageWorker(rec.pty);
    vi.useFakeTimers();
    try {
      const pending = worker.checkUsage();
      await vi.waitFor(() => expect(rec.calls).toHaveLength(1)); // 版の門を通ってから起きる
      // プレースホルダの語が ANSI カーソル移動で分断され、raw に "Try \"" が
      // 連続部分文字列として現れないケース
      rec.emitData('❯ Try\x1b[6G"refactor <filepath>"');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(rec.writes.join("")).toContain("/usage"); // それでも送信された

      // パネルも "Current" と "session" がカーソル移動で分断される
      const spaceless = "Current\x1b[10Gsession\r\n34%used\r\nCurrent\x1b[10Gweek\r\n35%used\r\n";
      rec.emitData(spaceless);
      await vi.advanceTimersByTimeAsync(5_000); // パネル debounce → Ctrl-C×2
      rec.emitExit();
      await vi.runAllTimersAsync(); // 画面合成を完了

      const screen = await pending;
      expect(screen).toContain("34%used"); // raw marker 照合を通り、合成まで完了
      expect(screen).not.toContain("\x1b[10G");
    } finally {
      vi.useRealTimers();
    }
  });

  it("正常終了したセッションは worker_exited イベントにトークン内訳と estimated_cost_usd を記録する(issue #32)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-usage");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(
      `${JSON.stringify({
        type: "result",
        result: "done",
        // 実 CLI の正常完了行は is_error: false を運ぶ。ここが欠けていると
        // 「is_error 欄があるだけで捨てる」実装も緑になる(issue #534 code review)
        is_error: false,
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
    const spawned = listEvents(db, "task-usage").find((e) => e.kind === "worker_spawned");
    const exited = listEvents(db, "task-usage").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toEqual({
      kind: "worker_exited",
      exit_code: 0,
      signal: null,
      // stderr を一切書かず終わったセッション — 「stderr が無かった」ことが
      // null で残る(空文字とは違い、捕捉の欠落と区別できる — issue #125)
      stderr_tail: null,
      reported_error: null,
      last_message: null,
      // このセッションを開いた worker_spawned を指す(issue #379)
      worker_spawned_event_id: spawned?.id,
      output_closed: true,
      // issue #33: この agent には advisor capability が無いので、そもそも
      // 相談は起こりえない。既存欄の意味は変わっていない(トークンは main
      // モデル・親スレッドのみ、コストはセッション総額)。
      advisor: null,
      // ADR 0215: 欄は常に置かれる
      model_swaps: [],
      refusals: [],
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
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-no-trailing-newline");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // no trailing "\n": the stream just closes mid-line, as a real process
    // exit can — this line must not get stranded in the tee's buffer
    processes[0]!.stdout.write(
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
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-malformed-usage");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(
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

  it("is_error の result 行は usage の自己申告ではない — 途中で止まった session は欠測(issue #534)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-aborted-streaming");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // 2.1.241 を SIGINT で止めたときの実測(2026-09-12 のトリアージ)から、
    // 読まれる欄だけを写したもの。主モデルの出力は実際に流れているのに
    // envelope は全ゼロで、形検査は通る。
    processes[0]!.stdout.write(
      `${JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming",
        duration_ms: 11623,
        num_turns: 2,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          iterations: [],
        },
        modelUsage: {},
      })}\n`,
    );
    emitExit(1, null);
    const exited = listEvents(db, "task-aborted-streaming").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ usage: null });
  });

  it("total_cost_usd が非ゼロでも is_error なら usage null — 判定はゼロではなく is_error 一点(issue #534)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-aborted-nonzero-cost");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // 2.1.269 の形: helper モデル分だけコストが乗った「ゼロではないが誤り」の envelope
    processes[0]!.stdout.write(
      `${JSON.stringify({
        type: "result",
        is_error: true,
        total_cost_usd: 0.001,
        usage: {
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
        },
      })}\n`,
    );
    emitExit(1, null);
    const exited = listEvents(db, "task-aborted-nonzero-cost").find(
      (e) => e.kind === "worker_exited",
    );
    expect(exited?.payload).toMatchObject({ usage: null });
  });

  it("非ゼロ終了は worker_exited イベントに加えて console.error でも観測できる(issue #32 code review: defaultSpawn から失われた診断ログの復元)", async () => {
    const { calls, start, emitExit } = await makeWorker();
    start("task-crashed");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      emitExit(1, null);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("claude exited with"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("実行中セッションの result が API 401 を返したら anthropic Provider 認証停止へ昇格する(issue #454)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-cli-auth-expired");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", api_error_status: 401 })}\n`);

    emitExit(1, null);

    expect(
      listBoard(db)
        .filter((task) => task.type === "question")
        .map((task) => task.title),
    ).toEqual([
      "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped",
    ]);
  });

  it("root の exit は worker_exited を書いて強制回収を撃ったあとで、盤面側の一撃に exit code / signal / stderr 末尾を渡す(ADR 0145)", async () => {
    const calls: Array<[string, WorkerExit, { exitedRecorded: boolean; forced: boolean }]> = [];
    const f = await makeWorker({}, {
      onWorkerExited: (taskId, exit) =>
        calls.push([taskId, exit, {
          exitedRecorded: listEvents(f.db, taskId).some((e) => e.kind === "worker_exited"),
          forced: f.killed.includes("SIGKILL"),
        }]),
    });
    f.start("task-exit-without-report");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.processes[0]!.stderr.write("boom\n");
    f.emitExit(0, null);

    expect(calls).toEqual([
      ["task-exit-without-report", { exit_code: 0, signal: null, stderr_tail: "boom", reported_error: null, last_message: null }, { exitedRecorded: true, forced: true }],
    ]);
  });

  it("worker_exited イベントに stderr の末尾20行を stderr_tail として載せる(issue #125)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-stderr-tail");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // 20行を超える stderr — イベントに載るのは末尾20行だけ
    const lines = Array.from({ length: 25 }, (_, i) => `stderr line ${i + 1}`);
    processes[0]!.stderr.write(`${lines.join("\n")}\n`);
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
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-stderr-mb");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // "認証" の2文字目(証)のバイト列の途中で chunk を切る
    const bytes = Buffer.from("認証エラー: トークン期限切れ\n");
    processes[0]!.stderr.write(bytes.subarray(0, 4));
    processes[0]!.stderr.write(bytes.subarray(4));
    emitExit(0, null);
    const exited = listEvents(db, "task-stderr-mb").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ stderr_tail: "認証エラー: トークン期限切れ" });
  });

  it("改行だけで実内容の無い stderr も stderr_tail null(空文字で「捕捉欠落」と紛れさせない — issue #125 code review)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-stderr-blank");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stderr.write("\n");
    emitExit(0, null);
    const exited = listEvents(db, "task-stderr-blank").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ stderr_tail: null });
  });

  /** stdout に行を流して exit し、worker_exited の payload を読む(ADR 0188 / 0189)。 */
  async function exitedAfter(lines: object[]): Promise<Record<string, unknown>> {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-exited-after");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    emitExit(1, null);
    return listEvents(db, "task-exited-after").find((e) => e.kind === "worker_exited")!.payload as Record<string, unknown>;
  }
  const reportedErrorAfter = async (lines: object[]) => (await exitedAfter(lines)).reported_error;

  it("is_error の success 行は result を、api_error_status が数値なら前に添えて reported_error に載せる(ADR 0188)", async () => {
    expect(
      await reportedErrorAfter([
        { type: "result", subtype: "success", is_error: true, api_error_status: 400, result: "model is not available" },
      ]),
    ).toBe("API error status 400: model is not available");
  });

  it("api_error_status の無い is_error 行は result だけを reported_error に載せる(ADR 0188)", async () => {
    expect(
      await reportedErrorAfter([{ type: "result", subtype: "success", is_error: true, result: "Invalid API key" }]),
    ).toBe("Invalid API key");
  });

  it("error_max_turns の行は errors を改行で連結して reported_error に載せる(ADR 0188)", async () => {
    expect(
      await reportedErrorAfter([
        { type: "result", subtype: "error_max_turns", is_error: true, errors: ["first failure", "second failure"] },
      ]),
    ).toBe("first failure\nsecond failure");
  });

  it("result が空文字なら errors を載せる(ADR 0188)", async () => {
    expect(
      await reportedErrorAfter([{ type: "result", subtype: "error_during_execution", is_error: true, result: "", errors: ["failed"] }]),
    ).toBe("failed");
  });

  it("is_error でない result 行・result も errors も無い is_error 行・result 行の無い exit は reported_error null(ADR 0188)", async () => {
    expect(await reportedErrorAfter([{ type: "result", subtype: "success", is_error: false, result: "done" }])).toBeNull();
    expect(await reportedErrorAfter([{ type: "result", subtype: "error_during_execution", is_error: true }])).toBeNull();
    expect(await reportedErrorAfter([{ type: "result", subtype: "error_during_execution", is_error: true, errors: [] }])).toBeNull();
    expect(await reportedErrorAfter([])).toBeNull();
    // 最後の is_error 行が文を持たなければ、前の行の文を残さない
    expect(
      await reportedErrorAfter([
        { type: "result", is_error: true, result: "earlier" },
        { type: "result", subtype: "error_during_execution", is_error: true },
      ]),
    ).toBeNull();
  });

  it("is_error の行が2本あれば最後の1本を、改行で終わらない最終行も拾う(ADR 0188)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-reported-error-last");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(`${JSON.stringify({ type: "result", is_error: true, result: "earlier" })}\n`);
    processes[0]!.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "later" }));
    emitExit(1, null);
    const exited = listEvents(db, "task-reported-error-last").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ reported_error: "later" });
  });

  it("マルチバイト文字の途中で割れた stdout からも reported_error が化けずに載る(#1298)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-stdout-mb");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    const bytes = Buffer.from(`${JSON.stringify({ type: "result", is_error: true, result: "認証エラー" })}\n`);
    const cut = bytes.indexOf(Buffer.from("証")) + 1;
    processes[0]!.stdout.write(bytes.subarray(0, cut));
    processes[0]!.stdout.write(bytes.subarray(cut));
    emitExit(1, null);
    const exited = listEvents(db, "task-stdout-mb").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ reported_error: "認証エラー" });
  });

  const lastMessageAfter = async (lines: object[]) => (await exitedAfter(lines)).last_message;
  const said = (content: object[], extra: object = {}) => ({
    type: "assistant",
    parent_tool_use_id: null,
    message: { model: "claude-sonnet-4-6", content },
    ...extra,
  });
  const text = (value: string) => ({ type: "text", text: value });
  const toolUse = { type: "tool_use", id: "toolu_1", name: "Bash", input: {} };

  it("root の assistant 行の最後の text を last_message に載せ、tool_use だけの行は上書きしない(ADR 0189)", async () => {
    expect(await lastMessageAfter([said([text("first")]), said([text("second"), toolUse, text("")])])).toBe("second");
    expect(await lastMessageAfter([said([text("done")]), said([toolUse])])).toBe("done");
  });

  it("<synthetic> の行と subagent の行の text は載せず、その前の root の text を残す(ADR 0189 決定2)", async () => {
    const synthetic = said([text("API Error: 429")], { message: { model: "<synthetic>", content: [text("API Error: 429")] } });
    expect(await lastMessageAfter([said([text("working")]), synthetic])).toBe("working");
    expect(await lastMessageAfter([synthetic])).toBeNull();
    expect(await lastMessageAfter([said([text("root")]), said([text("from subagent")], { parent_tool_use_id: "toolu_1" })])).toBe(
      "root",
    );
  });

  it("assistant 行の無い exit は last_message null、result 行の result は読まない(ADR 0189)", async () => {
    expect(await lastMessageAfter([])).toBeNull();
    expect(await lastMessageAfter([{ type: "result", subtype: "success", is_error: false, result: "done" }])).toBeNull();
  });

  it("改行で終わらない最終行の text も exit の flush で拾う(ADR 0189)", async () => {
    const { start, processes, emitExit, db } = await makeWorker();
    start("task-last-message-flush");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(`${JSON.stringify(said([text("earlier")]))}\n${JSON.stringify(said([text("later")]))}`);
    emitExit(0, null);
    const exited = listEvents(db, "task-last-message-flush").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({ last_message: "later" });
  });

  it("最終 result イベントが出ないまま終了したセッション(watchdog kill 等)は usage null で worker_exited を記録する(issue #32)", async () => {
    const { calls, start, emitExit, db } = await makeWorker();
    start("task-killed");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    emitExit(null, "SIGKILL");
    const spawned = listEvents(db, "task-killed").find((e) => e.kind === "worker_spawned");
    const exited = listEvents(db, "task-killed").find((e) => e.kind === "worker_exited");
    expect(exited?.payload).toEqual({
      kind: "worker_exited", advisor: null, model_swaps: [], refusals: [],
      exit_code: null,
      signal: "SIGKILL",
      stderr_tail: null,
      reported_error: null,
      last_message: null,
      worker_spawned_event_id: spawned?.id,
      output_closed: true,
      usage: null,
    });
  });

  // issue #127: Node's spawn() itself failing (ENOENT/EACCES/PATH misconfig)
  // fires "error" but never "exit", so worker_exited never gets written —
  // spawn_failed is the dedicated event that closes the pair worker_spawned
  // opened.
  it("spawn 自体が ENOENT で失敗(syscall が \"spawn\" で始まる)すると spawn_failed を error_code/message 付きで記録し running から消す(issue #127)", async () => {
    const spawnFailures: Array<[string, { error_code: string | null; message: string }]> = [];
    const { calls, start, emitError, db, worker, killed } = await makeWorker({}, {
      onSpawnFailed: (taskId, failure, record) => {
        record();
        spawnFailures.push([taskId, failure]);
      },
    });
    const task = start("task-spawn-enoent");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const err = Object.assign(new Error("spawn claude ENOENT"), {
      code: "ENOENT",
      syscall: "spawn claude",
    });
    emitError(err);
    const failed = listEvents(db, task.id).find((e) => e.kind === "spawn_failed");
    expect(failed?.actor_id).toBe("deckhand");
    expect(failed?.payload).toEqual({
      kind: "spawn_failed",
      error_code: "ENOENT",
      message: "spawn claude ENOENT",
    });
    // ADR 0118: 記録と後始末は盤面側の一撃が持つ
    expect(spawnFailures).toEqual([[task.id, { error_code: "ENOENT", message: "spawn claude ENOENT" }]]);
    // running から消えている: 死んだ子への合図は no-op のはずなので、
    // watchdog 相当の畳み込み停止を呼んでも子の kill() は一切呼ばれない
    worker.gracefulStop(task.id);
    expect(killed).toEqual([]);
  });

  it("spawn 族でない error(例: kill 失敗の syscall: \"kill\")は console.error のみで spawn_failed イベントは書かない(issue #127)", async () => {
    const spawnFailures: string[] = [];
    const { calls, start, emitError, db } = await makeWorker({}, { onSpawnFailed: (taskId, _failure, record) => {
        record();
        spawnFailures.push(taskId);
      } });
    const task = start("task-non-spawn-error");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const err = Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" });
      emitError(err);
      expect(listEvents(db, task.id).some((e) => e.kind === "spawn_failed")).toBe(false);
      expect(spawnFailures).toEqual([]);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("使用中レジストリの commit hash を events に記録する(判断の来歴)", async () => {
    const { calls, start, db, registryDir } = await makeWorker();
    const main = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir })
      .toString()
      .trim();
    start("task-9");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spawned = listEvents(db, "task-9").find((e) => e.kind === "worker_spawned");
    expect(spawned).toBeDefined();
    expect(spawned!.actor_id).toBe("deckhand");
    expect(spawned!.payload).toMatchObject({
      kind: "worker_spawned",
      registry_commit: main,
      definition_version: "0.3.1",
    });
  });

  // ADR 0052 決定1 の核心。盤面側の resolver(server-options.ts)だけをリモートへ
  // 移しても、spawn がローカル main を読む限り「人間の merge を通った内容が spawn に
  // 効く」は成立しない —— **ここが本番で読む ref を測る唯一のテスト**である。
  // ローカル main を意図的に古いまま残すのが要点で、remote 側だけが進んでいる状態は
  // 「GitHub 上で PR が merge されたが、ホストの checkout はまだ動いていない」の形。
  it("remote-backed 盤面の spawn は、ローカル main ではなく origin/main の定義と hash で走る(ADR 0052)", async () => {
    const { registryDir, publish } = await makeRemoteBackedRegistry();
    const git = registryGit(registryDir);
    const staleLocal = git("rev-parse", "main");
    // merge はリモート上の出来事。その後 pickup ゲートが fetch を撃つところまでが
    // spawn の手前で起きること —— ローカル main はどちらでも動かない
    const mergedOnRemote = publish(
      "agents/deckhand.md",
      `---\ndescription: General work agent for the tidepool board\nversion: 0.4.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nYou are Deckhand, MERGED on the remote.\n`,
      "merged registry change",
    );
    expect(await refreshRegistry(registryDir, undefined, writeUnannounced)).toEqual({ available: true });
    expect(git("rev-parse", "main")).toBe(staleLocal);

    const db = openDb(":memory:");
    const recorder = recordingSpawn();
    onTestFinished(() => recorder.emitExit(0, null)); // task temp の後始末(ADR 0257)
    const worker = new ClaudeCodeWorker({
      db,
      clock: new FakeClock(),
      registry: { dir: registryDir, mode: "remote-backed" },
      agent: "deckhand",
      workspace: "tidepool",
      mcpUrl: "http://127.0.0.1:4589/mcp",
      logDir: await tempDir("tidepool-worker-logs-"),
      transcripts: new TranscriptStore(await tempDir("tidepool-worker-logs-")),
      ...containerHarness(passthroughContainers(recorder.spawn)),
      ...noSkillPings,
    });
    const task = makeTask("task-remote", null, "deckhand", "work");
    insertTask(db, task);
    worker.start(task, pickedSetting(db, { dir: registryDir, mode: "remote-backed" }, task));
    await vi.waitFor(() => expect(recorder.calls).toHaveLength(1));

    const spawned = listEvents(db, "task-remote").find((e) => e.kind === "worker_spawned");
    const args = recorder.calls[0]!.args;
    expect({
      provenance: spawned!.payload,
      systemPrompt: systemText(args).includes(
        "MERGED on the remote",
      ),
    }).toMatchObject({
      provenance: {
        kind: "worker_spawned",
        registry_commit: mergedOnRemote,
        definition_version: "0.4.0",
      },
      systemPrompt: true,
    });
    // ADR 0020 が刻む hash と、pickup 直前の refresh が更新する ref は同じでなければ
    // ならない(ADR 0052 決定2)。ローカル main を刻んでいたら、その一致が壊れている。
    expect(spawned!.payload).not.toMatchObject({ registry_commit: staleLocal });
  });

  it("当事者レビュー(self RCA)の spawn には、異議された task の spawn で記録した agent 定義本文を証拠として注入する(ADR 0020 part 4 / ADR 0314 決定1)", async () => {
    const { worker, setting, calls, db, registryDir, logDir } = await makeWorker();
    const git = registryGit(registryDir);
    // main advances: the definition is refined after the objected call. The RCA
    // still runs on the current definition (ADR 0019), but must read the 当時版
    // as evidence — so current body and 当時版 body must be distinguishable.
    await writeFile(
      join(registryDir, "agents", "deckhand.md"),
      `---\ndescription: General work agent for the tidepool board\nversion: 0.4.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nYou are Deckhand, REFINED after the objected call.\n`,
    );
    git("add", "-A");
    git("commit", "-m", "refine deckhand");

    // the objected (parent) task, carrying deckhand's worker_spawned record and
    // the objected decision + the triage objection that anchors the RCA
    insertTask(db, makeTask("objected-1", null, "deckhand", "work"));
    objectDecisionAt(db, logDir, "objected-1", "deckhand", [definitionPart(DECKHAND_BODY)]);

    // self RCA: concrete assignee = the historical worker, parent = objected
    const rca: Task = { ...makeTask("rca-1", null, "deckhand", "review"), parent_id: "objected-1" };
    insertSelfRca(db, rca);
    worker.start(rca, setting(rca));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const prompt = systemText(args);
    // executes as the current definition (ADR 0019: repair is not a re-enactment)
    expect(prompt).toContain("REFINED after the objected call");
    // and the 当時版 body is injected, fenced, as evidence for the "why did I decide" read
    expect(prompt).toContain(`---\n\n${fenced(DECKHAND_BODY)}`);
  });

  it("同一 worker が objected task を複数回 spawn した場合、objected 判断時の session の記録を注入し、後の再 spawn の記録は使わない(ADR 0020 part 4)", async () => {
    const { worker, setting, calls, db, logDir } = await makeWorker();
    const objected = makeTask("objected-3", null, "deckhand", "work");
    insertTask(db, objected);
    // spawn 1 → objected decision → objection, all in that first session
    objectDecisionAt(db, logDir, objected.id, "deckhand", [definitionPart(DECKHAND_BODY)]);
    // a LATER re-spawn (escalation return) runs the objected task again under a
    // refined definition — must not be mistaken for 当時版
    const later = appendEvent(db, { taskId: objected.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: new FakeClock().now() });
    recordPrompt(logDir, objected.id, later, [definitionPart("You are Deckhand, REFINED v2.")]);

    const rca: Task = { ...makeTask("rca-3", null, "deckhand", "review"), parent_id: "objected-3" };
    insertSelfRca(db, rca);
    worker.start(rca, setting(rca));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const prompt = systemText(args);
    // the injected 当時版 evidence is the objected session's, not the later re-spawn's
    // — `.at(-1)` would have wrongly picked it
    expect(prompt).toContain(fenced(DECKHAND_BODY));
    expect(prompt).not.toContain("REFINED v2");
  });

  it("objected 判断が記録の異なる session にまたがるとき、当時版は entry ごとに解決され、各記録が entry id 付きで全部注入される(issue #87)", async () => {
    const { worker, setting, calls, db, logDir } = await makeWorker();
    const objected = makeTask("objected-4", null, "deckhand", "work");
    insertTask(db, objected);
    const authority: PromptPart = { part: "authority", text: "\n\n## Authority\n\nPrefer reversible actions.", source: "profile", profile: "standard" };
    // session 1 → objected decision 1; session 2 (escalation return) under a refined body → objected decision 2
    const decision1 = objectDecisionAt(db, logDir, objected.id, "deckhand", [definitionPart(DECKHAND_BODY), authority]);
    const decision2 = objectDecisionAt(db, logDir, objected.id, "deckhand", [definitionPart("You are Deckhand, REFINED v2."), authority]);

    const rca: Task = { ...makeTask("rca-4", null, "deckhand", "review"), parent_id: "objected-4" };
    insertSelfRca(db, rca);
    worker.start(rca, setting(rca));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const prompt = systemText(args);
    // both 当時版 bodies are injected — neither session's record is folded away
    expect(prompt).toContain("## Definitions under review (each as recorded at your spawn)");
    expect(prompt).toContain(`### Live for your objected entry ${decision1}\n\n---\n\n${fenced(DECKHAND_BODY)}`);
    expect(prompt).toContain(`### Live for your objected entry ${decision2}\n\n---\n\n${fenced("You are Deckhand, REFINED v2.")}`);
    // each section names its Authority's source (ADR 0314 決定5)
    expect(prompt).toContain("The Authority below came from the registry's authority profile standard.");
    // full coverage: no evidence-gap note
    expect(prompt).not.toContain("no recorded definition could be read");
  });

  it("独立レビュー(assignee 未設定)の spawn には当時版定義を注入しない: 当事者レビューのみ(ADR 0020 part 4)", async () => {
    // an auditor agent so the unset-assignee review resolves and spawns
    const { worker, setting, calls, db, logDir } = await makeWorker(
      {
        "agents/auditor.md": `---\ndescription: Independent reviewer\nversion: 1.0.0\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nYou are the Auditor.\n`,
      },
      { auditorName: "auditor" },
    );
    const objected = makeTask("objected-2", null, "deckhand", "work");
    insertTask(db, objected);
    objectDecisionAt(db, logDir, objected.id, "deckhand", [definitionPart(DECKHAND_BODY)]);
    // independent review: unset assignee → resolves to the Auditor pointer
    const audit: Task = { ...makeTask("audit-1", null, null, "review"), parent_id: "objected-2" };
    insertTask(db, audit);
    worker.start(audit, setting(audit));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const args = calls[0]!.args;
    const prompt = systemText(args);
    expect(prompt).toContain("You are the Auditor");
    // no deckhand definition body injected — the auditor's value is distance
    expect(prompt).not.toContain("general work agent");
  });

  it("当事者レビューの当時版には記録した Authority と Roster が fence で入り、Authority の出所に profile 名を添える(issue #1741 / ADR 0314 決定5・6)", async () => {
    const { worker, setting, calls, db, logDir } = await makeWorker();
    insertTask(db, makeTask("objected-6", null, "deckhand", "work"));
    const roster = `\n\n## Roster\n\ndeckhand — General work agent for the tidepool board\nhuman — ${HUMAN_ROSTER_AGENT.description}`;
    objectDecisionAt(db, logDir, "objected-6", "deckhand", [
      definitionPart(DECKHAND_BODY),
      { part: "authority", text: "\n\n## Authority\n\nPrefer reversible actions THEN.", source: "profile", profile: "standard" },
      { part: "roster", text: roster },
    ]);

    const rca: Task = { ...makeTask("rca-6", null, "deckhand", "review"), parent_id: "objected-6" };
    insertSelfRca(db, rca);
    worker.start(rca, setting(rca));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const prompt = systemText(args);
    expect(prompt).toContain(
      `## Definition under review (as recorded at your spawn)\n\n` +
        "This is your agent definition as recorded at your spawn for the objected task",
    );
    expect(prompt).toContain(
      `${fenced(DECKHAND_BODY)}\n\nThe Authority below came from the registry's authority profile standard.\n\n` +
        `${fenced("## Authority\n\nPrefer reversible actions THEN.")}\n\n${fenced(roster.trimStart())}`,
    );
  });

  it("被レビュー task が review だったとき、当時の Authority は reviewer 定数を RCA 自身の Authority と同じ文として指し、Roster は記録のまま入る(issue #1741 / ADR 0314 決定5)", async () => {
    const { worker, setting, calls, db, logDir } = await makeWorker();
    insertTask(db, makeTask("reviewed-10", null, "lookout", "work"));
    insertTask(db, { ...makeTask("objected-10", null, "deckhand", "review"), parent_id: "reviewed-10" });
    objectDecisionAt(db, logDir, "objected-10", "deckhand", [
      definitionPart(DECKHAND_BODY),
      REVIEWER_AUTHORITY_PART,
      { part: "roster", text: "\n\n## Roster\n\nlookout — Looks out for the board." },
    ]);

    const rca: Task = { ...makeTask("rca-10", null, "deckhand", "review"), parent_id: "objected-10" };
    insertSelfRca(db, rca);
    worker.start(rca, setting(rca));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const prompt = systemText(args);
    expect(prompt).toContain(
      "The Authority below is the board's fixed reviewer authority — the same text as your own Authority above. " +
        "It is board code, not a registry profile, so it is not a target for a registry diff.\n\n" +
        `${fenced(`## Authority\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}`)}\n\n${fenced("## Roster\n\nlookout — Looks out for the board.")}`,
    );
    expect(prompt).not.toContain("Prefer reversible actions.");
  });

  it("当時の担当が組み込み Auditor だった self RCA でも当時版の節は消えず、本文の位置の1行と記録した Roster が入る(issue #1741)", async () => {
    const { worker, setting, calls, db, logDir } = await makeWorker(
      {},
      { enumerateSkills: recordingEnumerator([]).enumerateSkills },
    );
    insertTask(db, makeTask("reviewed-11", null, "deckhand", "work"));
    insertTask(db, { ...makeTask("objected-11", null, DEFAULT_AUDITOR_NAME, "review"), parent_id: "reviewed-11" });
    objectDecisionAt(db, logDir, "objected-11", DEFAULT_AUDITOR_NAME, [
      definitionPart("", true),
      REVIEWER_AUTHORITY_PART,
      { part: "roster", text: "\n\n## Roster\n\ndeckhand — General work agent for the tidepool board" },
    ]);

    const rca: Task = { ...makeTask("rca-11", null, DEFAULT_AUDITOR_NAME, "review"), parent_id: "objected-11" };
    insertSelfRca(db, rca);
    worker.start(rca, setting(rca));
    // the built-in's finite skill list launches after the async skill enumeration
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const prompt = systemText(args);
    expect(prompt).toContain(
      `---\n\nYou ran then as the board's built-in ${DEFAULT_AUDITOR_NAME}, whose definition lives in board code, ` +
        "not the registry; its body was empty at that version.\n\nThe Authority below is the board's fixed reviewer authority",
    );
    expect(prompt).toContain(fenced("## Roster\n\ndeckhand — General work agent for the tidepool board"));
  });

  it("組み込み suzumedai への異議の self RCA は、本文を持っていた spawn の記録の本文を当時版として出す —— 今の本文が空でも(ADR 0314 決定1)", async () => {
    const { worker, setting, calls, db, logDir } = await makeWorker(
      {},
      { enumerateSkills: recordingEnumerator([]).enumerateSkills },
    );
    insertTask(db, makeTask("reviewed-12", null, "deckhand", "work"));
    insertTask(db, { ...makeTask("objected-12", null, DEFAULT_INTERVIEWER_NAME, "review"), parent_id: "reviewed-12" });
    const body = "You run Interviews: one probe that every target solves, and a score for each answer.";
    objectDecisionAt(db, logDir, "objected-12", DEFAULT_INTERVIEWER_NAME, [definitionPart(body, true), REVIEWER_AUTHORITY_PART]);

    const rca: Task = { ...makeTask("rca-12", null, DEFAULT_INTERVIEWER_NAME, "review"), parent_id: "objected-12" };
    insertSelfRca(db, rca);
    worker.start(rca, setting(rca));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const args = calls[0]!.args;
    const prompt = systemText(args);
    expect(prompt).toContain(`repair is not a re-enactment).\n\n---\n\n${fenced(body)}`);
    expect(prompt).not.toContain("its body was empty");
  });

  it("registry チェックアウトがタスクブランチ上にあっても、記録する commit hash と版は main のもの(ADR 0020 part 3)", async () => {
    const { calls, start, db, registryDir } = await makeWorker();
    const main = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir })
      .toString()
      .trim();
    const git = registryGit(registryDir);
    // branch discipline has the registry clone sitting on a registry-edit task
    // branch with an unmerged definition bump — must not leak into the record
    git("checkout", "-b", "task/bump");
    await writeFile(
      join(registryDir, "agents", "deckhand.md"),
      `---\ndescription: General work agent for the tidepool board\nversion: 9.9.9\nauthority: standard\nprovider: anthropic\nskills:\n  - "*"\n---\nYou are Deckhand.\n`,
    );
    git("add", "-A");
    git("commit", "-m", "unmerged bump");
    start("task-branch-spawn");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spawned = listEvents(db, "task-branch-spawn").find((e) => e.kind === "worker_spawned");
    expect(spawned!.payload).toMatchObject({
      kind: "worker_spawned",
      registry_commit: main,
      definition_version: "0.3.1",
    });
  });
});

/** issue #33: advisor capability。frontmatter の `advisor` が spawn の面まで
 *  届くか、不在・盤面の上限 off で**確実に閉じる**か、そして「実際に走ったか」が
 *  worker_exited に残るか。実 CLI は使わず、既存の ContainerSpawn seam に fake stream を
 *  流す(ADR 0027 / ADR 0041 §4)。 */
describe("advisor capability (issue #33)", () => {
  const ADVISOR_MD = `---\ndescription: General work agent for the tidepool board\nversion: 0.3.1\nauthority: standard\nprovider:\n  - name: anthropic\n    advisor: true\nskills:\n  - "*"\n---\nYou are Deckhand.\n`;
  const withAdvisor = { "agents/deckhand.md": ADVISOR_MD };

  /** advisor の付く盤面の worker: 種の既定の上限は off なので、上限 sonnet にする —— economy の Sonnet 5.5 の
   *  main には main と同一の advisor が付く(ADR 0208 決定2)。 */
  const makeAdvisorWorker = async () => {
    const w = await makeWorker(withAdvisor);
    applyExecutionSettingsChange(w.db, { setting: "advisor_ceiling", value: "sonnet" }, "webui", new Date());
    return w;
  };

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
    const { start, calls } = await makeAdvisorWorker();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0]!;
    expect(advisorFlag(call.args)).toBe("claude-sonnet-5-5");
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
      const { start, calls } = await makeAdvisorWorker();
      start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const call = calls[0]!;
      expect(advisorFlag(call.args)).toBe("claude-sonnet-5-5");
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
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0]!;
    expect(advisorFlag(call.args)).toBeUndefined();
    expect(call.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
  });

  // ── 上限 off(ADR 0208 決定3): advisor の不在は CLI の無効化 env だけで綴る ──────

  it("上限が off なら、frontmatter が advisor を持っていてもフラグを渡さず env で閉じる(ADR 0208 決定3)", async () => {
    const { start, calls } = await makeWorker(withAdvisor);
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0]!;
    expect(advisorFlag(call.args)).toBeUndefined();
    expect(call.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe("1");
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
    await vi.waitFor(() => expect(off.calls).toHaveLength(1));
    const on = await makeAdvisorWorker();
    on.start("task-advisor");
    await vi.waitFor(() => expect(on.calls).toHaveLength(1));
    const ceilingOff = await makeWorker(withAdvisor);
    ceilingOff.start("task-advisor-ceiling-off");
    await vi.waitFor(() => expect(ceilingOff.calls).toHaveLength(1));
    for (const call of [off.calls[0]!, on.calls[0]!, ceilingOff.calls[0]!]) {
      expect(call.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS).toBe("600000");
      expect(call.env.API_TIMEOUT_MS).toBe("600000");
    }
    // 同じ関数が組み立てる2つの関心が**独立している**ことを1箇所で測る:
    // advisor の口は3セルで開/閉/閉と動くのに、timeout は3セルとも同じ値で立つ。
    // 片方を advisor の有無に紐づける将来の編集は、ここで落ちる。
    expect([
      off.calls[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL,
      on.calls[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL,
      ceilingOff.calls[0]!.env.CLAUDE_CODE_DISABLE_ADVISOR_TOOL,
    ]).toEqual(["1", undefined, "1"]);
  });

  // ── 判断6 前半: worker_spawned は「盤面が何をピン留めしたか」 ──────

  it("worker_spawned は盤面がピン留めした advisor とその出所を記録する(判断6 / ADR 0208 決定6)—— agent.md には真偽しか書かれていない", async () => {
    const { calls, start, db } = await makeAdvisorWorker();
    start("task-spawn-advisor");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const spawned = listEvents(db, "task-spawn-advisor").find((e) => e.kind === "worker_spawned");
    expect(spawned!.payload).toMatchObject({ kind: "worker_spawned", advisor: "claude-sonnet-5-5", source: { advisor: "ceiling" } });
  });

  // registry_commit があるので frontmatter の真偽は後から引ける。**イベント履歴だけで**確定できないのは
  // 盤面の上限のほうなので、記録するのは「盤面が実際にピン留めした値」とその出所 —— 上限 off では advisor は
  // null に畳まれ、出所が advisor の無い agent と区別する。
  it("advisor 不在の agent と上限 off は、どちらも worker_spawned.advisor が null で、出所 off があるのは上限 off の側だけ(判断6 / ADR 0208 決定6)", async () => {
    const plain = await makeWorker();
    plain.start("task-plain");
    await vi.waitFor(() => expect(plain.calls).toHaveLength(1));
    const ceilingOff = await makeWorker(withAdvisor);
    ceilingOff.start("task-ceiling-off-event");
    await vi.waitFor(() => expect(ceilingOff.calls).toHaveLength(1));
    const spawned = (w: { db: Db }, id: string) => listEvents(w.db, id).find((e) => e.kind === "worker_spawned")!.payload;
    expect(spawned(plain, "task-plain")).toMatchObject({ kind: "worker_spawned", advisor: null, source: { tier: "board", provider: "only" } });
    expect(spawned(plain, "task-plain")).not.toHaveProperty("source.advisor");
    expect(spawned(ceilingOff, "task-ceiling-off-event")).toMatchObject({ kind: "worker_spawned", advisor: null, source: { advisor: "off" } });
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
        "claude-sonnet-5": {
          inputTokens: 4,
          outputTokens: 31,
          cacheReadInputTokens: 61644,
          cacheCreationInputTokens: 13114,
          costUSD: 0.0968847,
        },
        // 実測: advisor 側の cache_read は常に 0(相談のたび transcript 全体を
        // 非キャッシュで読む — ADR 0094 測定コメント)。
        "claude-opus-5": {
          inputTokens: 38484,
          outputTokens: 313,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 38484,
          costUSD: 0.200245,
        },
      },
      ...over,
    })}\n`;

  const assistantLine = (content: unknown[]) => `${JSON.stringify({ type: "assistant", message: { content } })}\n`;
  // advisor の呼び出し1本。`result` は結果の content で、既定は成功(`advisor_redacted_result`)、
  // 失敗は `failure()`(`advisor_tool_result_error`、ADR 0214)。既定は1行に並べる形。`twoLines` は実物の形(呼び出しと結果が別々の assistant 行 ——
  // fixture worker-session-2.1.237.stream.jsonl の22〜23行目)。
  const advisorCall = (
    id: string,
    { result = { type: "advisor_redacted_result" }, twoLines = false }: { result?: { type: string; error_code?: string }; twoLines?: boolean } = {},
  ) => {
    const call = { type: "server_tool_use", id, name: "advisor", input: {} };
    const outcome = { type: "advisor_tool_result", tool_use_id: id, content: result };
    return twoLines ? assistantLine([call]) + assistantLine([outcome]) : assistantLine([call, outcome]);
  };
  const failure = (error_code?: string) => ({ type: "advisor_tool_result_error", ...(error_code === undefined ? {} : { error_code }) });

  const initLine = (model: string) =>
    `${JSON.stringify({ type: "system", subtype: "init", model })}\n`;

  const exitFieldsOf = (db: ReturnType<typeof openDb>, id: string) => {
    const exited = listEvents(db, id).find((e) => e.kind === "worker_exited");
    const payload = exited!.payload as Extract<EventPayload, { kind: "worker_exited" }>;
    return { usage: payload.usage, advisor: payload.advisor, model_swaps: payload.model_swaps, refusals: payload.refusals };
  };

  it("相談が観測されたセッションは、解決済み advisor id・相談回数・分離した消費を記録する(判断6)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-usage");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
    processes[0]!.stdout.write(resultLine());
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-usage")).toEqual({
      usage: {
        // 既存欄の意味は**変えない** — トークンは main モデル・親スレッドのみ、
        // コストはセッション総額(advisor 込み)。過去行との比較可能性を守る。
        input_tokens: 4,
        output_tokens: 31,
        cache_read_tokens: 61644,
        cache_creation_tokens: 13114,
        estimated_cost_usd: 0.2999,
        // ADR 0094 決定2: 観測された per-model 内訳。帰属は推論しない —— この
        // モデルが advisor だと分かるのは、この event と同じセッションの
        // `worker_spawned.advisor` を読者が突き合わせるからで、ここでは決めない。
        models: {
          "claude-sonnet-5": {
            input_tokens: 4,
            output_tokens: 31,
            cache_read_tokens: 61644,
            cache_creation_tokens: 13114,
            estimated_cost_usd: 0.0968847,
          },
          "claude-opus-5": {
            input_tokens: 38484,
            output_tokens: 313,
            cache_read_tokens: 0,
            cache_creation_tokens: 38484,
            estimated_cost_usd: 0.200245,
          },
        },
      },
      advisor: {
        model: "claude-opus-5",
        consultations: 1,
        usage: { input_tokens: 38484, output_tokens: 313, estimated_cost_usd: 0.200245 },
        failed_calls: [],
      },
      model_swaps: [],
      refusals: [],
    });
  });

  // コストだけでは「長い会話で1回」と「短い会話で3回」が区別できないので、回数は
  // usage とは独立に数える。数え上げは既に1行ずつ読んでいる stdout から取れる。
  it("相談回数は stream 中の、助言が返った advisor_tool_result の本数を数える(判断6 / ADR 0214)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-count");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_02"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_03"));
    processes[0]!.stdout.write(resultLine());
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-count")?.advisor).toMatchObject({ consultations: 3 });
  });

  // ADR 0214 決定1: 数えるのは結果の型。呼び出しと結果が別の行でも1行でも同じ数になる。
  it("呼び出しと結果が別々の assistant 行に出る実物の形でも、1行の形と同じ数になる(ADR 0214)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-two-lines");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01", { twoLines: true }));
    processes[0]!.stdout.write(advisorCall("srvtoolu_02"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_03", { twoLines: true, result: failure("unavailable") }));
    processes[0]!.stdout.write(advisorCall("srvtoolu_04", { result: failure("too_many_requests") }));
    processes[0]!.stdout.write(resultLine());
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-two-lines")?.advisor).toMatchObject({
      consultations: 2,
      failed_calls: ["unavailable", "too_many_requests"],
    });
  });

  // ADR 0214 決定2: 失敗は advisor が付いていた証拠なので record は非 null、相談は0。
  it("失敗だけの session は consultations 0 で、失敗の error_code を逐語で残す(ADR 0214)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-failed-only");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01", { twoLines: true, result: failure("too_many_requests") }));
    // 失敗した呼び出しには advisor_message が来ない(#1524 の triage で観測した形)
    processes[0]!.stdout.write(
      resultLine({
        usage: {
          input_tokens: 4,
          output_tokens: 31,
          cache_read_input_tokens: 61644,
          cache_creation_input_tokens: 13114,
          iterations: [{ type: "message" }],
        },
      }),
    );
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-failed-only")?.advisor).toEqual({
      model: null,
      consultations: 0,
      usage: null,
      failed_calls: ["too_many_requests"],
    });
  });

  it("成功と失敗が混ざれば、相談は成功の数、failed_calls は出た順で error_code の無い失敗は null(ADR 0214)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-mixed");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01", { result: failure("unavailable") }));
    processes[0]!.stdout.write(advisorCall("srvtoolu_02"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_03", { result: failure() }));
    processes[0]!.stdout.write(advisorCall("srvtoolu_04", { result: failure("too_many_requests") }));
    processes[0]!.stdout.write(resultLine());
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-mixed")?.advisor).toMatchObject({
      consultations: 1,
      failed_calls: ["unavailable", null, "too_many_requests"],
    });
  });

  // ADR 0214 決定1: 観測した2つの型のどちらでもない結果、結果の無い呼び出しは、相談にも失敗にも数えない。
  it("成功でも失敗でもない結果と、結果の無い呼び出しは数えない(ADR 0214)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-neither");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01", { result: { type: "advisor_something_new" } }));
    processes[0]!.stdout.write(assistantLine([{ type: "server_tool_use", id: "srvtoolu_02", name: "advisor", input: {} }]));
    processes[0]!.stdout.write(resultLine());
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-neither")?.advisor).toBeNull();
  });

  it("改行なしの最終チャンクにある相談も数える(issue #1301)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-final-chunk");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(resultLine());
    processes[0]!.stdout.write(advisorCall("srvtoolu_01").trimEnd());
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-final-chunk")?.advisor).toMatchObject({ consultations: 1 });
  });

  // 通常の tool_use(MCP verb 等)を advisor と数え間違えない — 数えるのは
  // `advisor_tool_result` の結果ブロックだけ(ADR 0214)。
  it("advisor の結果でないブロックは、中身が助言の型でも相談として数えない", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-noise");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(
      assistantLine([{ type: "tool_result", tool_use_id: "toolu_01", content: { type: "advisor_redacted_result" } }]),
    );
    processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
    processes[0]!.stdout.write(resultLine());
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-noise")?.advisor).toMatchObject({ consultations: 1 });
  });

  // 判断6 の眼目。能力不足の advisor は exit 0 で完走し、stderr に警告1行を残して
  // 未 attach のまま終わる —— 盤面から見て成功セッションと区別が付かない。
  // `advisor: null` が、そのセッションで advisor が**走らなかった**ことを言う。
  it("advisor をピン留めしても相談が1本も観測されなければ worker_exited.advisor は null(判断6)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-silent");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(resultLine({ modelUsage: { "claude-sonnet-5": { costUSD: 0.09 } }, usage: {
      input_tokens: 4,
      output_tokens: 31,
      cache_read_input_tokens: 61644,
      cache_creation_input_tokens: 13114,
    } }));
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-silent")?.advisor).toBeNull();
  });

  // 「設定されていて一度も相談しなかった」と「設定されたが未 attach のまま走った」は
  // どちらも上の null になる。両者を分ける唯一の材料は stderr の警告1行であり、
  // 盤面はそれを**正規表現で判定しない**(黙って劣化する検出器は #172 が拒んだ形
  // そのもの)。証拠は stderr_tail に verbatim で残る、という形で保つ。
  it("未 attach の警告は判定に使わず、stderr_tail に verbatim で残す(判断3)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-warning");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // 実測の文言(main opus × advisor sonnet のセル)
    const warning =
      '"sonnet" cannot advise "claude-opus-5" (the advisor must be at least as ' +
      "capable as the main model). The advisor will not be used for the main model.";
    processes[0]!.stderr.write(`${warning}\n`);
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(resultLine({ usage: {
      input_tokens: 4,
      output_tokens: 31,
      cache_read_input_tokens: 61644,
      cache_creation_input_tokens: 13114,
    } }));
    emitExit(0, null);
    const exited = listEvents(db, "task-advisor-warning").find((e) => e.kind === "worker_exited");
    expect(exited!.payload).toMatchObject({ exit_code: 0, stderr_tail: warning });
    expect(exitFieldsOf(db, "task-advisor-warning")?.advisor).toBeNull();
  });

  // 同一モデルペアでは `modelUsage` が1キーに合算されて消費を分離できない(実測)。
  // そのときの usage は 0 ではなく null —— 「測れなかった」を 0 に化けさせない
  // (`usage: null` が「セッションは走ったが report が無い」を表すのと同じ形)。
  // 回数だけは数えられるので `consultations` は usage の外に出してある。
  it("main と advisor が同じモデルに解決されたら usage は null(0 ではない)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-same-model");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
    processes[0]!.stdout.write(
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
    expect(exitFieldsOf(db, "task-advisor-same-model")?.advisor).toEqual({
      model: "claude-sonnet-5",
      consultations: 1,
      usage: null,
      failed_calls: [],
    });
  });

  // `usage.iterations` は**最終ターンぶんしか出ない**(実測)。最後の相談が最終
  // ターンより前だったセッションでは解決済み id がどこにも残らないので、model は
  // null になる。`modelUsage` のキーから引き算する手は使えない —— キーは
  // {内部 haiku, main, advisor} になりうる(実測)ので、main を引いても1つに
  // 定まらない。名前表もキャッシュ量のヒューリスティックも、黙って外れる形なので採らない。
  it("最終ターンに相談が無ければ解決済み id は残らない — model は null、相談回数は残る", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-earlier-turn");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
    processes[0]!.stdout.write(
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
    expect(exitFieldsOf(db, "task-advisor-earlier-turn")?.advisor).toEqual({
      model: null,
      consultations: 1,
      usage: null,
      failed_calls: [],
    });
  });

  // main モデルの解決先が分からなければ、**分離できるかどうかも分からない** ——
  // advisor と main が同じ id に解決されていれば `modelUsage` のそのキーは合算済み
  // なので、読めば advisor の消費として合算値を publish してしまう。init 行を
  // 観測できなかったセッション(壊れた行・`model` を持たない init)はこの状態に
  // なる。「測れなかった」を誤った値に化けさせない。
  it("main モデルの解決先が観測できていなければ usage は null(分離可否そのものが不明)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-no-init");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // init 行を一切流さない
    processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
    processes[0]!.stdout.write(resultLine());
    emitExit(0, null);
    expect(exitFieldsOf(db, "task-advisor-no-init")?.advisor).toEqual({
      model: "claude-opus-5",
      consultations: 1,
      usage: null,
      failed_calls: [],
    });
  });

  // `modelUsage` を持たない result 行(古い CLI・壊れた行)でも、相談の事実と回数は
  // stream 側から取れている。ここで throw して usage 全体を失わない。
  it("modelUsage を持たない result 行でも相談の事実は失わない", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-no-modelusage");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
    processes[0]!.stdout.write(
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
    expect(exitFieldsOf(db, "task-advisor-no-modelusage")).toMatchObject({
      usage: { estimated_cost_usd: 0.3 },
      advisor: { model: null, consultations: 1, usage: null },
    });
    // ADR 0094 決定2: modelUsage を持たない result 行では models も丸ごと省略
    // する —— 部分的な内訳を「完全」と誤読させないための all-or-nothing。
    expect("models" in exitFieldsOf(db, "task-advisor-no-modelusage").usage!).toBe(false);
  });

  // ADR 0094 決定2: 1エントリでも五項目のうち欠けがあれば内訳全体を省略する
  // (`isStreamResultEvent` と同じ fail-closed 姿勢 — 部分的な内訳は「完全」と
  // 見分けが付かないので、丸ごと落とす)。既存の advisor 判定(advisorUsage は
  // 別の三項目narrowingのまま)には影響しない。
  it("modelUsage の1エントリが五項目のうち1つでも欠けば usage.models は丸ごと省略される(ADR 0094)", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-models-malformed-entry");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(initLine("claude-sonnet-5"));
    processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
    processes[0]!.stdout.write(
      resultLine({
        modelUsage: {
          "claude-sonnet-5": {
            inputTokens: 4,
            outputTokens: 31,
            cacheReadInputTokens: 61644,
            cacheCreationInputTokens: 13114,
            costUSD: 0.0968847,
          },
          // cacheReadInputTokens が欠けている — この1エントリのせいで
          // models 全体を省略する
          "claude-opus-5": { inputTokens: 38484, outputTokens: 313, costUSD: 0.200245 },
        },
      }),
    );
    emitExit(0, null);
    const fields = exitFieldsOf(db, "task-models-malformed-entry");
    expect("models" in fields.usage!).toBe(false);
    // advisorUsage は既存の三項目 narrowing のままなので、advisor 側の判定は
    // 影響を受けない(このセルは main と別モデルなので分離できる)。
    expect(fields.advisor).toMatchObject({ model: "claude-opus-5" });
  });

  // 未知のモデルは exit 1・stdout 完全に空(実測)。result 行が無いので usage は
  // null のまま、相談も失敗も無いので advisor も null。
  it("stdout が空のまま exit 1 したセッションは usage null のまま", async () => {
    const { start, processes, emitExit, db } = await makeAdvisorWorker();
    start("task-advisor-exit1");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stderr.write('Error: The model "haiku" cannot be used as an advisor.\n');
    emitExit(1, null);
    const exited = listEvents(db, "task-advisor-exit1").find((e) => e.kind === "worker_exited");
    expect(exited!.payload).toMatchObject({
      exit_code: 1,
      usage: null,
      stderr_tail: 'Error: The model "haiku" cannot be used as an advisor.',
    });
  });

  // ── subagent の model(issue #1887 / ADR 0287)────────────────────
  describe("subagent の model(issue #1887 / ADR 0287)", () => {
    const SUBAGENT_ENVS = ["CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_DISABLE_EXPLORE_INHERIT_CAP"];

    // 決定3: host が立てた subagent の model の env 3つは spawn には渡らない(ADR 0005)。親の采配と固定版の既定だけが残る
    it("ホストが立てた subagent の model の env 3つを spawn env から消す", async () => {
      for (const name of SUBAGENT_ENVS) vi.stubEnv(name, "1");
      try {
        const { start, calls } = await makeWorker();
        start();
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        for (const name of SUBAGENT_ENVS) expect(calls[0]!.env[name]).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  // ── main の pin を上書きする host env(issue #2351)──────────────
  describe("main の pin を上書きする host env(issue #2351)", () => {
    const PIN_OVERRIDE_ENVS = ["CLAUDE_CODE_EFFORT_LEVEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"];

    // 2.1.286 実測: CLAUDE_CODE_EFFORT_LEVEL は --effort に勝ち、ANTHROPIC_DEFAULT_*_MODEL は --advisor の alias を差し替える。
    // worker_spawned は pin を書くので、host の値が残ると記録と実走が食い違う(ADR 0005)
    it("ホストが立てた effort / alias の env 4つを spawn env から消す", async () => {
      for (const name of PIN_OVERRIDE_ENVS) vi.stubEnv(name, "low");
      try {
        const { start, calls } = await makeWorker();
        start();
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        for (const name of PIN_OVERRIDE_ENVS) expect(calls[0]!.env[name]).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  // ── 差し替え(issue #1523 / ADR 0215)────────────────────────────

  // #1425 の VM 実測で見た2段目の行(`...` で省かれていた欄は足さない)
  const swapLine = (over: Record<string, unknown> = {}) =>
    `${JSON.stringify({
      type: "system",
      subtype: "model_refusal_fallback",
      trigger: "refusal",
      direction: "retry",
      scope: "session",
      original_model: "claude-fable-5-1",
      fallback_model: "claude-opus-4-8",
      api_refusal_category: "cyber",
      ...over,
    })}\n`;

  describe("差し替え(issue #1523 / ADR 0215)", () => {
    const REFUSAL_ENVS = ["CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", "CLAUDE_CODE_NO_MODEL_FALLBACK", "CLAUDE_CODE_DISABLE_REFUSAL_RETRY"];

    // 決定1: 止める側の env を host が立てていても spawn には渡らない(ADR 0005)
    it("ホストが立てた差し替えを止める env 3つを spawn env から消す", async () => {
      for (const name of REFUSAL_ENVS) vi.stubEnv(name, "1");
      try {
        const { start, calls } = await makeWorker();
        start();
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        for (const name of REFUSAL_ENVS) expect(calls[0]!.env[name]).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("model_refusal_fallback の行は出た順に worker_exited.model_swaps へ逐語で載り、scope が local の行も載る(決定2・3)", async () => {
      const exits: WorkerExit[] = [];
      const { start, processes, emitExit, db } = await makeWorker({}, { onWorkerExited: (_taskId, exit) => exits.push(exit) });
      start("task-swaps");
      await vi.waitFor(() => expect(processes).toHaveLength(1));
      processes[0]!.stdout.write(initLine("claude-fable-5-1"));
      processes[0]!.stdout.write(swapLine());
      processes[0]!.stdout.write(
        swapLine({ scope: "local", original_model: "claude-opus-4-8", fallback_model: "claude-opus-5", api_refusal_category: "bio" }),
      );
      // scope と分類の省略
      processes[0]!.stdout.write(swapLine({ scope: undefined, api_refusal_category: undefined }));
      processes[0]!.stdout.write(resultLine());
      emitExit(0, null);
      expect(exitFieldsOf(db, "task-swaps")?.model_swaps).toEqual([
        { from: "claude-fable-5-1", to: "claude-opus-4-8", scope: "session", category: "cyber" },
        { from: "claude-opus-4-8", to: "claude-opus-5", scope: "local", category: "bio" },
        { from: "claude-fable-5-1", to: "claude-opus-4-8", scope: null, category: null },
      ]);
      // 報告なき exit の文面(watchdog)へは直下の欄の写しで渡る(決定5)
      expect(exits[0]?.model_swaps).toEqual(exitFieldsOf(db, "task-swaps")?.model_swaps);
    });

    // #1523 の grilling の session で観測した1段目の形: 1 message が block ごとに3行に割れ、3本とも refusal
    const refusalLine = (id: string, block: unknown, over: Record<string, unknown> = {}) =>
      `${JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-fable-5-1",
          id,
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: "cyber", explanation: "This request triggered restrictions on violative cyber content." },
          content: [block],
          ...over,
        },
        parent_tool_use_id: null,
      })}\n`;

    it("root の拒否は message.id ごとに1つ、分類を出た順に worker_exited.refusals へ載せ、subagent の拒否は数えない(決定3)", async () => {
      const { start, processes, emitExit, db } = await makeWorker();
      start("task-refusals");
      await vi.waitFor(() => expect(processes).toHaveLength(1));
      processes[0]!.stdout.write(initLine("claude-fable-5-1"));
      processes[0]!.stdout.write(refusalLine("msg_011CfpqdBwiLDBbB6Zw8pMEK", { type: "thinking", thinking: "" }));
      processes[0]!.stdout.write(refusalLine("msg_011CfpqdBwiLDBbB6Zw8pMEK", { type: "text", text: "Let me check" }));
      processes[0]!.stdout.write(refusalLine("msg_011CfpqdBwiLDBbB6Zw8pMEK", { type: "tool_use", id: "toolu_01", name: "Bash", input: {} }));
      processes[0]!.stdout.write(
        `${JSON.stringify({
          type: "assistant",
          message: { model: "claude-fable-5-1", id: "msg_sub", stop_reason: "refusal", stop_details: { category: "bio" }, content: [] },
          parent_tool_use_id: "toolu_task",
        })}\n`,
      );
      processes[0]!.stdout.write(refusalLine("msg_02", { type: "text", text: "again" }, { stop_details: { type: "refusal" } }));
      processes[0]!.stdout.write(swapLine());
      processes[0]!.stdout.write(resultLine());
      emitExit(0, null);
      expect(exitFieldsOf(db, "task-refusals")?.refusals).toEqual(["cyber", null]);
    });

    it("差し替えも拒否も無い session でも model_swaps と refusals は空の列で置かれる", async () => {
      const { start, processes, emitExit, db } = await makeWorker();
      start("task-no-swap");
      await vi.waitFor(() => expect(processes).toHaveLength(1));
      processes[0]!.stdout.write(initLine("claude-sonnet-5"));
      processes[0]!.stdout.write(resultLine());
      emitExit(0, null);
      expect(exitFieldsOf(db, "task-no-swap")).toMatchObject({ model_swaps: [], refusals: [] });
    });

    // ADR 0317: 消費の報告が無くても failure question へ差し替えを渡す。
    it("result 行の無い session の差し替えは onWorkerExited へ渡り、usage は null のまま", async () => {
      const exits: WorkerExit[] = [];
      const { start, processes, emitExit, db } = await makeWorker({}, { onWorkerExited: (_taskId, exit) => exits.push(exit) });
      start("task-swap-killed");
      await vi.waitFor(() => expect(processes).toHaveLength(1));
      processes[0]!.stdout.write(initLine("claude-fable-5-1"));
      processes[0]!.stdout.write(refusalLine("msg_01", { type: "text", text: "no" }));
      processes[0]!.stdout.write(swapLine());
      emitExit(null, "SIGKILL");
      expect(exitFieldsOf(db, "task-swap-killed").usage).toBeNull();
      expect(exits[0]?.model_swaps).toEqual([{ from: "claude-fable-5-1", to: "claude-opus-4-8", scope: "session", category: "cyber" }]);
    });

    // 決定4: 分離の判定が比べる init の model が、差し替え後は走っていない model になる
    it("main が替わった session の advisor.usage は null、scope が local だけなら従来どおり分離する", async () => {
      const run = async (id: string, scope: string | undefined) => {
        const { start, processes, emitExit, db } = await makeAdvisorWorker();
        start(id);
        await vi.waitFor(() => expect(processes).toHaveLength(1));
        processes[0]!.stdout.write(initLine("claude-sonnet-5"));
        processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
        processes[0]!.stdout.write(swapLine({ scope }));
        processes[0]!.stdout.write(resultLine());
        emitExit(0, null);
        return exitFieldsOf(db, id)?.advisor;
      };
      const separated = { input_tokens: 38484, output_tokens: 313, estimated_cost_usd: 0.200245 };
      expect(await run("task-swap-session", "session")).toEqual({ model: "claude-opus-5", consultations: 1, usage: null, failed_calls: [] });
      expect(await run("task-swap-omitted", undefined)).toMatchObject({ usage: null });
      expect(await run("task-swap-local", "local")).toMatchObject({ usage: separated });
    });
  });

  // ── advisor と同じ model の subagent(issue #2432)──────────────────
  // `modelUsage` は model id ごとの合算なので、advisor と同じ model の subagent の消費は advisor の entry に足される
  // (2.1.286 実測、run D)。stream に見えた事実で「入ったか、入ったかもしれない」なら null、差し引きはしない。
  describe("advisor と同じ model の subagent(issue #2432)", () => {
    // fixture worker-session-2.1.237.stream.jsonl の形: 起動の行と、親の tool_result 行の top-level の `tool_use_result`
    const taskStarted = (toolUseId: string, task_type = "local_agent") =>
      `${JSON.stringify({ type: "system", subtype: "task_started", task_id: `task-${toolUseId}`, tool_use_id: toolUseId, task_type })}\n`;
    const agentResult = (toolUseId: string, resolvedModel: string, status = "completed") =>
      `${JSON.stringify({
        type: "user",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content: [{ type: "text", text: "done" }] }] },
        tool_use_result: { status, resolvedModel },
      })}\n`;

    /** main sonnet × advisor opus、最後の呼び出しに相談がある session に `lines` を挟んで流し、stream 由来の欄を返す。 */
    const run = async (id: string, lines: string[]) => {
      const { start, processes, emitExit, db } = await makeAdvisorWorker();
      start(id);
      await vi.waitFor(() => expect(processes).toHaveLength(1));
      processes[0]!.stdout.write(initLine("claude-sonnet-5"));
      for (const line of lines) processes[0]!.stdout.write(line);
      processes[0]!.stdout.write(advisorCall("srvtoolu_01"));
      processes[0]!.stdout.write(resultLine());
      emitExit(0, null);
      return exitFieldsOf(db, id);
    };
    const separated = { input_tokens: 38484, output_tokens: 313, estimated_cost_usd: 0.200245 };
    // model / consultations / failed_calls と models は、どの場合でも変わらない
    const expectAdvisorUsage = (fields: Awaited<ReturnType<typeof run>>, advisorUsage: typeof separated | null) =>
      expect(fields).toMatchObject({
        usage: {
          models: {
            "claude-sonnet-5": { input_tokens: 4, output_tokens: 31, cache_read_tokens: 61644, cache_creation_tokens: 13114, estimated_cost_usd: 0.0968847 },
            "claude-opus-5": { input_tokens: 38484, output_tokens: 313, cache_read_tokens: 0, cache_creation_tokens: 38484, estimated_cost_usd: 0.200245 },
          },
        },
        advisor: { model: "claude-opus-5", consultations: 1, usage: advisorUsage, failed_calls: [] },
      });

    it("subagent が走っていない、または advisor と別の model で返った session は数字のまま", async () => {
      expectAdvisorUsage(await run("task-sub-none", []), separated);
      expectAdvisorUsage(await run("task-sub-sonnet", [taskStarted("toolu_A"), agentResult("toolu_A", "claude-sonnet-5")]), separated);
    });

    it("subagent の resolvedModel が advisor と同じ id なら null(foreground の completed でも background の async_launched でも)", async () => {
      expectAdvisorUsage(await run("task-sub-opus", [taskStarted("toolu_A"), agentResult("toolu_A", "claude-opus-5")]), null);
      expectAdvisorUsage(
        await run("task-sub-opus-bg", [taskStarted("toolu_A"), agentResult("toolu_A", "claude-opus-5", "async_launched")]),
        null,
      );
    });

    // run F: 2段目の結果の行は `tool_use_result` を持たず、2段目の opus の消費も advisor の行に足された
    it("解決先が観測されないまま終わった起動があれば null(2段目の subagent)", async () => {
      expectAdvisorUsage(
        await run("task-sub-depth2", [taskStarted("toolu_A"), taskStarted("toolu_B"), agentResult("toolu_A", "claude-sonnet-5")]),
        null,
      );
    });

    it("local_bash の起動の行だけの session は数字のまま(背景の Bash は model を走らせない)", async () => {
      expectAdvisorUsage(await run("task-sub-bash", [taskStarted("toolu_A", "local_bash")]), separated);
    });

    // local の差し替えは subagent だけが替わる(ADR 0215 決定2)—— 行き先が advisor の id なら、その消費が advisor の entry に入る
    it("scope が local の差し替えの行き先が advisor の id なら null、別の id なら数字", async () => {
      const localSwap = (to: string) => swapLine({ scope: "local", original_model: "claude-sonnet-5", fallback_model: to });
      expectAdvisorUsage(await run("task-local-to-advisor", [localSwap("claude-opus-5")]), null);
      expectAdvisorUsage(await run("task-local-elsewhere", [localSwap("claude-opus-4-8")]), separated);
    });
  });
});

describe("provider 別の spawn env(issue #445 / ADR 0096・0097)", () => {
  // 期待値は独立した literal(実装の定数を import しない)
  const HOST_CREDENTIAL_ENVS = ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
  /** `provider: moonshot` の agent 定義(fixture)。ベンダー知識(URL・モデル)は
   *  書かせない — registry が宣言するのは provider 名だけ(ADR 0005 / 0097)。 */
  const MOONSHOT_AGENT_MD = `---
description: Kimi-speaking work agent for the tidepool board
version: "1"
authority: standard
provider: moonshot
skills:
  - "*"
---
You are Kipper, the tidepool board's Kimi work agent.
`;

  /** Moonshot キーの fixture ファイル(mode 600 の状態ファイル置き場の形)。 */
  async function makeMoonshotKeyFile(key = "sk-moonshot-test-key"): Promise<string> {
    const dir = await tempDir("tidepool-moonshot-key-");
    const path = join(dir, "moonshot-api-key");
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    return path;
  }

  it("anthropic の spawn の挙動は導入前のまま — env マップの差分は scrub の対称化のみ(Moonshot 注入一式 = 向き先・トークン・モデルをすべて除去)", async () => {
    // これは挙動の回帰ではなく env マップの意図的な変更である: これまでの除去は
    // 向き先・トークンの2つだったが、moonshot に注入する一式すべて(+
    // ANTHROPIC_MODEL)を相手から除去する形に対称化した(注入一覧と除去一覧は
    // 同じ定数から導かれる)。`--model claude-sonnet-5-5` のピン留めがある限り、env の
    // ANTHROPIC_MODEL は anthropic spawn では元々効いていない — 実効挙動は不変。
    // それ以外は導入前どおり: process.env の継承 + timeout ピン + advisor 閉じ +
    // GIT_* の名義注入だけが載る(回帰ゼロ — issue #443 user story 4)。後から足したのは
    // 自動更新の停止(ADR 0186 決定4)と、task temp を指す2つの temp 変数(ADR 0257 決定2)だけである。
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.moonshot.ai/anthropic");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "sk-leaked-moonshot-token");
    vi.stubEnv("ANTHROPIC_MODEL", "kimi-k3[1m]");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-subscription-token");
    try {
      const { start, calls } = await makeWorker();
      start();
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const expected: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_STREAM_IDLE_TIMEOUT_MS: "600000",
        API_TIMEOUT_MS: "600000",
        DISABLE_AUTOUPDATER: "1",
        CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
        TMPDIR: calls[0]!.env.TMPDIR,
        CLAUDE_CODE_TMPDIR: calls[0]!.env.TMPDIR,
        GIT_AUTHOR_NAME: "deckhand",
        GIT_AUTHOR_EMAIL: "deckhand@tidepool.invalid",
        GIT_COMMITTER_NAME: "deckhand",
        GIT_COMMITTER_EMAIL: "deckhand@tidepool.invalid",
      };
      delete expected.ANTHROPIC_BASE_URL;
      delete expected.ANTHROPIC_AUTH_TOKEN;
      delete expected.ANTHROPIC_MODEL;
      // host の GitHub / OpenAI の資格情報も載らない(issue #2469)—— 開発者の shell に GH_TOKEN があっても落ちない
      for (const name of HOST_CREDENTIAL_ENVS) delete expected[name];
      expect(calls[0]!.env).toEqual(expected);
      // 従来通りの認証継承: Claude のサブスク資格情報は残る
      expect(calls[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-subscription-token");
      // 実効挙動不変の根拠: モデルは env ではなくフラグでピン留めされる
      // (値の出所は盤面の表 —— ADR 0110 決定3)
      expect(calls[0]!.args.join(" ")).toContain("--model claude-sonnet-5-5");
      expect(calls[0]!.args.join(" ")).toContain("--effort high");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("moonshot の spawn env は Moonshot 互換エンドポイント向きの一式(向き先・Bearer トークン・モデル)を注入する(issue #445)", async () => {
    // 期待値は独立した literal(トートロジー防止 — 実装の定数を import しない)。
    // 向き先と既定モデル表記は Moonshot 公式の Claude Code ガイドの値。
    const keyFile = await makeMoonshotKeyFile();
    const { start, calls } = await makeWorker(
      { "agents/kipper.md": MOONSHOT_AGENT_MD },
      { moonshotApiKeyFile: keyFile },
    );
    start("task-kimi", null, "kipper");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const env = calls[0]!.env;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.moonshot.ai/anthropic");
    // キーは盤面 env ではなく spawn 時にファイルから読まれた値が載る
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-moonshot-test-key");
    expect(env.ANTHROPIC_MODEL).toBe("kimi-k3[1m]");
  });

  it("moonshot の spawn から Claude のサブスク資格情報(CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY)は除去される(双方向 scrub)", async () => {
    // Moonshot 公式も ANTHROPIC_API_KEY 残留との衝突を警告している(ADR 0097 決定4)
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-subscription-token");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api-key");
    try {
      const keyFile = await makeMoonshotKeyFile();
      const { start, calls } = await makeWorker(
        { "agents/kipper.md": MOONSHOT_AGENT_MD },
        { moonshotApiKeyFile: keyFile },
      );
      start("task-kimi", null, "kipper");
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      const env = calls[0]!.env;
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      // それ以外の盤面 env は従来通り継承される(PATH 等で子プロセスが死なない)
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // ADR 0024 決定3: Claude CLI は自分の資格情報以外を Bash の子 process に素通しする(ADR 0070 の実測)ので、
  // host の GitHub / OpenAI の資格情報は向き先の provider に依らず spawn env に載せない(issue #2469)
  it("host の GitHub / OpenAI の資格情報 env 4つは anthropic も moonshot も spawn env から消え、anthropic の Claude のサブスク資格情報は残る", async () => {
    for (const name of HOST_CREDENTIAL_ENVS) vi.stubEnv(name, "host-secret");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "claude-subscription-token");
    try {
      const keyFile = await makeMoonshotKeyFile();
      const { start, calls } = await makeWorker(
        { "agents/kipper.md": MOONSHOT_AGENT_MD },
        { moonshotApiKeyFile: keyFile },
      );
      start("task-claude");
      await vi.waitFor(() => expect(calls).toHaveLength(1));
      start("task-kimi", null, "kipper");
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      for (const call of calls) for (const name of HOST_CREDENTIAL_ENVS) expect(call.env[name]).toBeUndefined();
      expect(calls[0]!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-subscription-token");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  // ADR 0186 決定4: worker の `claude` も自分で更新しない —— 向き先の provider に依らない
  it("worker の spawn env は CLI の自動更新を閉じる(anthropic も moonshot も)", async () => {
    const keyFile = await makeMoonshotKeyFile();
    const { start, calls } = await makeWorker(
      { "agents/kipper.md": MOONSHOT_AGENT_MD },
      { moonshotApiKeyFile: keyFile },
    );
    start("task-claude");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    start("task-kimi", null, "kipper");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((call) => call.env.DISABLE_AUTOUPDATER)).toEqual(["1", "1"]);
  });

  it("moonshot agent の --model は provider のモデル表記でピン留めされ、env にも同じ値が載る(表の moonshot 行、ADR 0005 / 0110)", async () => {
    const keyFile = await makeMoonshotKeyFile();
    const worker = await makeWorker(
      { "agents/kipper.md": MOONSHOT_AGENT_MD },
      { moonshotApiKeyFile: keyFile },
    );
    worker.start("task-kimi-default", null, "kipper");
    await vi.waitFor(() => expect(worker.calls).toHaveLength(1));
    const flag = (args: string[]) => args[args.indexOf("--model") + 1];
    // ホストのモデル設定を漏らさないための値も provider の表記で(ADR 0005)。
    // moonshot は economy の1行(ADR 0114)なので、既定ティア(economy)はこの1つに解決する。
    expect(flag(worker.calls[0]!.args)).toBe("kimi-k3[1m]");
    expect(worker.calls[0]!.env.ANTHROPIC_MODEL).toBe("kimi-k3[1m]");
  });

  it("キー未配置で moonshot agent を spawn しようとすると、置き場を指す失敗で pickup が止まり、spawn もイベント記録もされない(issue #445)", async () => {
    const missing = join(await tempDir("tidepool-moonshot-key-"), "moonshot-api-key");
    const { start, calls, db } = await makeWorker(
      { "agents/kipper.md": MOONSHOT_AGENT_MD },
      { moonshotApiKeyFile: missing },
    );
    let thrown: unknown;
    try {
      start("task-kimi-no-key", null, "kipper");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // 分かりやすい失敗: どこに何を置けば直るかがメッセージから読める
    expect((thrown as Error).message).toContain(missing);
    expect(calls).toEqual([]);
    expect(listEvents(db, "task-kimi-no-key")).toEqual([]);
  });

  it("空のキーファイルも未配置と同じ失敗になる(中身のない credential で spawn しない)", async () => {
    const keyFile = await makeMoonshotKeyFile(" ");
    const { start, calls } = await makeWorker(
      { "agents/kipper.md": MOONSHOT_AGENT_MD },
      { moonshotApiKeyFile: keyFile },
    );
    expect(() => start("task-kimi-empty-key", null, "kipper")).toThrow(/moonshot-api-key/);
    expect(calls).toEqual([]);
  });

  it("キーは spawn のたびにファイルから読まれる — 盤面 env に乗らず、ローテーションが再起動なしで効く(ADR 0097 決定4)", async () => {
    const keyFile = await makeMoonshotKeyFile("sk-first-key");
    const { start, calls } = await makeWorker(
      { "agents/kipper.md": MOONSHOT_AGENT_MD },
      { moonshotApiKeyFile: keyFile },
    );
    start("task-kimi-first", null, "kipper");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    // ローテーション: 同じパスに新しいキーを書く(盤面の再起動はない)
    await writeFile(keyFile, "sk-rotated-key\n", { mode: 0o600 });
    start("task-kimi-second", null, "kipper");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]!.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-first-key");
    expect(calls[1]!.env.ANTHROPIC_AUTH_TOKEN).toBe("sk-rotated-key");
  });

  it("moonshot session の終了が 401 envelope なら、その provider の資源単位 quarantine に落ちる — 盤面全体は止まらない(issue #446 / ADR 0097 決定2)", async () => {
    // 401 の帰属は envelope の内容から推測しない — その session がどの provider
    // で spawn されたかという spawn 時の事実で決まる。
    const keyFile = await makeMoonshotKeyFile();
    const { start, processes, emitExit, db } = await makeWorker(
      { "agents/kipper.md": MOONSHOT_AGENT_MD },
      { moonshotApiKeyFile: keyFile },
    );
    start("task-kimi-auth-expired", null, "kipper");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", api_error_status: 401 })}\n`);

    emitExit(1, null);

    const questions = listBoard(db).filter((task) => task.type === "question");
    expect(questions.map((task) => task.title)).toEqual([
      "moonshot authentication is unavailable — pickup of moonshot-speaking agents is stopped",
    ]);
    expect(quarantineQuestion(db, "providerAuth", "moonshot")).toBeDefined();
    expect(boardHalts(db)).toEqual([]);
  });
});

describe("上限到達による中断(issue #467 / ADR 0104)", () => {
  /** #447 のライブ検証(2026-08-24、Claude Code 2.1.241)の逐語。判定の根拠は
   *  最終行 `result` の `api_error_status: 429` 一点で、その手前の
   *  `rate_limit_event` や本文の「session limit」は見ない。ただし init 行の
   *  `memory_paths` は除いてある — auto-memory を閉じた今の spawn 形では出ない項目で、
   *  残すと再生のたびに封じ込めが不成立になる(ADR 0156、#994)。`tools` の `TaskOutput` も
   *  同じ理由で除いた — 2.1.284 以降の CLI は面に出さず、盤面の宣言からも外した(#1269)。 */
  const CAP_STREAM = readFileSync(
    join(import.meta.dirname, "fixtures", "worker-session-cap-429.stream.jsonl"),
    "utf8",
  );

  const kinds = (db: ReturnType<typeof openDb>, taskId: string) =>
    listEvents(db, taskId).map((e) => e.kind);

  it("429 で exit した session の task は todo へ戻り slot が解放される — failure question は立たない", async () => {
    const { start, processes, emitExit, db, slot } = await makeWorker();
    const task = start("task-capped");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(CAP_STREAM);

    emitExit(1, null);
    await vi.waitFor(() => expect(slot.currentTaskId).toBeNull());

    expect(getTask(db, task.id)!.status).toBe("todo");
    // ほかに候補が無いので、そのまま次に拾われる
    expect(nextSlotTask(db)?.id).toBe(task.id);
    // 失敗ではなく環境事象なので、リトライ判断を問う question は生まれない
    expect(listBoard(db).filter((t) => t.type === "question")).toEqual([]);
  });

  it("429 の exit 通知は解決済みの中断分類を運ぶ(ADR 0309)", async () => {
    const order: unknown[] = [];
    const { start, processes, emitExit } = await makeWorker({}, {
      onWorkerExited: (_taskId, _exit, facts) => order.push(facts.capInterrupted),
    });
    start("task-capped-order");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(CAP_STREAM);

    emitExit(1, null);

    expect(order).toEqual([true]);
  });

  it("行の拒否(result 行の 404)は exit の束に、spawn 時の provider / model と worker_spawned の id を運んで乗る(ADR 0184 決定4 / ADR 0338 決定1)", async () => {
    const order: unknown[] = [];
    const { start, processes, emitExit, db } = await makeWorker({}, {
      onWorkerExited: (_taskId, _exit, facts) => order.push(facts.stop),
    });
    const task = start("task-row-refused-order");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // 2026-10-01 実測の形(#1249): subtype は success のまま is_error と 404 が立つ
    processes[0]!.stdout.write(
      `${JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 404, total_cost_usd: 0, modelUsage: {} })}\n`,
    );

    emitExit(1, null);

    const spawned = listEvents(db, task.id).find((e) => e.kind === "worker_spawned")!;
    expect(order).toEqual([
      { refusal: { provider: "anthropic", model: "claude-sonnet-5-5", worker_spawned_event_id: spawned.id, cause: "api_404" } },
    ]);
  });

  it("中断の事実を盤面名義の event として worker_exited と並べて刻む(ADR 0104 決定4)", async () => {
    const { start, processes, emitExit, db, slot } = await makeWorker();
    const task = start("task-capped-event");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(CAP_STREAM);

    emitExit(1, null);
    await vi.waitFor(() => expect(slot.currentTaskId).toBeNull());

    const events = listEvents(db, task.id);
    const exited = events.find((e) => e.kind === "worker_exited")!;
    // 429 の envelope は usage 欄の形を満たすが自己申告ではない(issue #534)
    expect(exited.payload).toMatchObject({ kind: "worker_exited", exit_code: 1, usage: null });
    const interrupted = events.find((e) => e.kind === "cap_interrupted")!;
    expect(interrupted.origin).toBe("board");
    expect(interrupted.actor_id).toBe("tidepool");
    // 刻むのは1件だけ
    expect(events.filter((e) => e.kind === "cap_interrupted")).toHaveLength(1);
  });

  it("Provider 使用量の観測には書かない — 再開の門は次の pickup の使用量観測である(ADR 0104 決定3)", async () => {
    const { start, processes, emitExit, db, slot } = await makeWorker();
    start("task-capped-throttle");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    // 空の表と比べても「書かなかった」は測れない。直前の pickup が残した観測を
    // 1行置き、それが 429 の後も1文字も動かないことを見る
    const observedAt = new Date("2026-08-24T13:00:00.000Z");
    reportProviderUsage(db, {
      provider: "anthropic",
      status: "observed",
      plan: null,
      cliVersion: null,
      observedAt,
      windows: [
        {
          window: "session",
          model: null,
          usedPercent: 50,
          durationMs: 5 * 60 * 60 * 1000,
          resetsAt: new Date(observedAt.getTime() + 60 * 60 * 1000),
          throttled: false,
          resumesAt: null,
        },
      ],
    });
    const before = getProviderUsage(db);
    expect(before[0]?.observedAt).toBe("2026-08-24T13:00:00.000Z");
    processes[0]!.stdout.write(CAP_STREAM);

    emitExit(1, null);
    await vi.waitFor(() => expect(slot.currentTaskId).toBeNull());

    expect(getProviderUsage(db)).toEqual(before);
  });

  it("401 の envelope は従来どおり認証 quarantine に落ち、上限到達とは混ざらない", async () => {
    const { start, processes, emitExit, db, slot } = await makeWorker();
    const task = start("task-capped-401");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(`${JSON.stringify({ type: "result", subtype: "error", api_error_status: 401 })}\n`);

    emitExit(1, null);

    expect(kinds(db, task.id)).not.toContain("cap_interrupted");
    expect(getTask(db, task.id)!.status).toBe("in_progress");
    expect(slot.currentTaskId).toBe(task.id);
    expect(
      listBoard(db)
        .filter((t) => t.type === "question")
        .map((t) => t.title),
    ).toEqual([
      "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped",
    ]);
  });

  it("rate_limit_event を含むだけの正常な session では何も起きない(既存 fixture の回帰)", async () => {
    const { start, processes, emitExit, db, slot } = await makeWorker();
    const task = start("task-not-capped");
    await vi.waitFor(() => expect(processes).toHaveLength(1));
    processes[0]!.stdout.write(
      readFileSync(
        join(import.meta.dirname, "fixtures", "worker-session-2.1.237.stream.jsonl"),
        "utf8",
      ),
    );

    emitExit(0, null);

    expect(kinds(db, task.id)).not.toContain("cap_interrupted");
    expect(getTask(db, task.id)!.status).toBe("in_progress");
    expect(slot.currentTaskId).toBe(task.id);
    // fixture の init 行が盤面の宣言からずれると封じ込めの question が立つ(#1282)
    expect(listBoard(db).filter((t) => t.type === "question")).toEqual([]);
  });

  it("slot 解放は容器の回収済み観測の後に起きる — 送達も exit も観測ではない(ADR 0099 決定3)", async () => {
    // 容器が空になる瞬間をテストが握る器。process 境界は makeWorker の既定と
    // 同じ recordingSpawn だが、容器はこちらが差し替えるので stdout / exit も
    // この recorder から撃つ。
    const { spawn, processes, emitExit } = recordingSpawn();
    const runtime = new FakeContainerRuntime(spawn);
    const ws = await makeWorkspace("cap-ws");
    const { start, db, slot } = await makeWorker(
      {},
      { containers: new ProcessContainers(runtime) },
      () => ws,
    );
    const task = start("task-capped-ordering");
    // ADR 0109 決定4: root の exit を観測した adapter はその場で強制回収を撃つ。ここで
    // 測りたいのは「送達も exit も観測ではない」なので、force では空にならないホスト —
    // 行儀よく exit しない子孫が残っている session — を明示的にスクリプトする。
    runtime.hold(task.id);
    // pickup が checkout に対してすること(ブランチ規律 + ref のスナップショット)を
    // 実物で通す —— tree rule はその基準に対して退避する
    await prepareWorkspaceAtPickup(db, ws, task);
    // 途中ターンの WIP: session はタスクブランチの上で作業していた
    writeFileSync(join(ws.path, "wip.txt"), "half-done work\n");
    processes[0]!.stdout.write(CAP_STREAM);

    emitExit(1, null);
    expect(sessionInTeardown(db)).toEqual({
      taskId: task.id,
      startedAt: new FakeClock().now().toISOString(),
      settlement: "interrupted",
    });
    expect(slot.inTeardown).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));

    // 容器はまだ空になっていない — exit を観測に数えない
    expect(slot.currentTaskId).toBe(task.id);
    expect(getTask(db, task.id)!.status).toBe("in_progress");

    runtime.fireEmpty(task.id);
    await vi.waitFor(() => expect(slot.currentTaskId).toBeNull());

    expect(getTask(db, task.id)!.status).toBe("todo");
    // tree rule が走った: WIP はタスクブランチへ退避され、checkout は保護ブランチへ戻る
    expect(git(ws.path, "status", "--porcelain")).toBe("");
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(ws.path, "show", `task/${task.id}:wip.txt`)).toBe("half-done work");
    expect(listBoard(db).filter((t) => t.type === "question")).toEqual([]);
  });

  it("spawn が落ちた pickup の後始末は、読み口に process を1つも持たなかった session として報される(ADR 0274 決定3 / #651)", async () => {
    let onSpawnFailed: (taskId: string, failure: { error_code: string | null; message: string }, record: () => void) => void = () => {};
    const { calls, worker, setting, emitError, db, slot, clock, containers } = await makeWorker({}, {
      onSpawnFailed: (taskId, failure, record) => onSpawnFailed(taskId, failure, record),
    });
    onSpawnFailed = spawnFailureHandler({ db, clock, slot, resolve: undefined, pollNow: () => {} }, containers);
    const registered = registerTask(db, { type: "work", title: "never ran", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI);
    const task = pickupTask(db, registered, "deckhand", clock.now(), { assignee: "deckhand" })!;
    slot.occupy(task.id);
    worker.start(task, setting(task));
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    emitError(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT", syscall: "spawn claude" }));

    expect(sessionInTeardown(db)).toEqual({
      taskId: task.id,
      startedAt: clock.now().toISOString(),
      settlement: "never_ran",
    });
  });

  it("spawn の失敗で盤面側の一撃の記録が盤面のバグで投げても、listener の外へ抜けず落ちた後始末が立つ(ADR 0342 決定6 / #2036)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let onSpawnFailed: (taskId: string, failure: { error_code: string | null; message: string }, record: () => void) => void = () => {};
    const { calls, worker, setting, emitError, db, slot, clock, containers } = await makeWorker({}, {
      onSpawnFailed: (taskId, failure, record) => onSpawnFailed(taskId, failure, record),
    });
    onSpawnFailed = spawnFailureHandler({ db, clock, slot, resolve: undefined, pollNow: () => {} }, containers);
    const registered = registerTask(db, { type: "work", title: "never ran", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI);
    const task = pickupTask(db, registered, "deckhand", clock.now(), { assignee: "deckhand" })!;
    slot.occupy(task.id);
    worker.start(task, setting(task));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    failTeardownMark(db);

    expect(() => emitError(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT", syscall: "spawn claude" }))).not.toThrow();

    expect(listBoard(db).filter((t) => t.type === "question").map((q) => q.title)).toEqual([FAILED_TEARDOWN_QUESTION_TITLE]);
    expect(slot.currentTaskId).toBe(task.id);
  });

  it("spawn の失敗の観測点の spawn_failed の書き込みが盤面のバグで投げても、listener の外へ抜けず落ちた後始末になり、受理が1行だけ書く(ADR 0342 決定6 / #2036)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let onSpawnFailed: (taskId: string, failure: { error_code: string | null; message: string }, record: () => void) => void = () => {};
    const { calls, worker, setting, emitError, db, slot, clock, containers } = await makeWorker({}, {
      onSpawnFailed: (taskId, failure, record) => onSpawnFailed(taskId, failure, record),
    });
    onSpawnFailed = spawnFailureHandler({ db, clock, slot, resolve: undefined, pollNow: () => {} }, containers);
    const registered = registerTask(db, { type: "work", title: "never ran", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI);
    const task = pickupTask(db, registered, "deckhand", clock.now(), { assignee: "deckhand" })!;
    slot.occupy(task.id);
    worker.start(task, setting(task));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    db.exec("CREATE TRIGGER fail_spawn_failed BEFORE INSERT ON events WHEN NEW.kind = 'spawn_failed' BEGIN SELECT RAISE(ABORT, 'spawn_failed write failed'); END");

    expect(() => emitError(Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT", syscall: "spawn claude" }))).not.toThrow();
    expect(listBoard(db).filter((t) => t.type === "question").map((q) => q.title)).toEqual([FAILED_TEARDOWN_QUESTION_TITLE]);
    expect(listEvents(db, task.id).filter((e) => e.kind === "spawn_failed")).toEqual([]);
    db.exec("DROP TRIGGER fail_spawn_failed");
    await acceptTeardownQuarantine({ db, clock, slot, resolve: undefined, pollNow: () => {} }, task.id);

    expect(listEvents(db, task.id).filter((e) => e.kind === "spawn_failed")).toHaveLength(1);
  });
});

describe("root の出力の読み切り(issue #1336 / ADR 0201)", () => {
  const resultLine = (fields: Record<string, unknown>) =>
    `${JSON.stringify({
      type: "result",
      is_error: false,
      total_cost_usd: 0.25,
      usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...fields,
    })}\n`;
  const exitedOf = (db: ReturnType<typeof openDb>, taskId: string) =>
    listEvents(db, taskId).find((e) => e.kind === "worker_exited")?.payload;
  /** root の exit を撃ったあと、読み切りの前に stdout / stderr を流す。間に macrotask を挟む ——
   *  exit の時点で記録を確定させる実装が、遅れて届く出力を読む前に確定し終えるように。 */
  const lateOutput = async (f: Awaited<ReturnType<typeof makeWorker>>, out: { stdout?: string; stderr?: string }, code = 0) => {
    f.emitExitOnlyAt(0, code, null);
    await new Promise((resolve) => setImmediate(resolve));
    if (out.stdout) f.processes[0]!.stdout.write(out.stdout);
    if (out.stderr) f.processes[0]!.stderr.write(out.stderr);
    await new Promise((resolve) => setImmediate(resolve));
    f.emitCloseAt(0, code, null);
  };

  it("exit のあと読み切りの前に届いた result 行の消費が worker_exited に載り、読み切った事実が残る", async () => {
    const f = await makeWorker();
    f.start("task-late-result");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));

    await lateOutput(f, { stdout: resultLine({}) });

    expect(exitedOf(f.db, "task-late-result")).toMatchObject({
      usage: { input_tokens: 7, output_tokens: 3, estimated_cost_usd: 0.25 },
      output_closed: true,
    });
  });

  it("exit のあと読み切りの前に届いた stderr の末尾が stderr_tail に載る", async () => {
    const f = await makeWorker();
    f.start("task-late-stderr");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));

    await lateOutput(f, { stderr: "early\nLAST-STDERR\n" }, 1);

    expect(exitedOf(f.db, "task-late-stderr")).toMatchObject({ stderr_tail: "early\nLAST-STDERR" });
  });

  it("読み切りまでに届いた 429 も exit 通知の解決済みの中断分類に載る", async () => {
    const order: unknown[] = [];
    const f = await makeWorker({}, {
      onWorkerExited: (_taskId, _exit, facts) => order.push(facts.capInterrupted),
    });
    f.start("task-late-429");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));

    await lateOutput(f, { stdout: resultLine({ is_error: true, api_error_status: 429 }) }, 1);

    expect(order).toEqual([true]);
  });

  it("exit のあと読み切りの前に届いた 404 の result 行で、行の拒否が exit の束に乗る", async () => {
    const refused: unknown[] = [];
    const f = await makeWorker({}, { onWorkerExited: (_taskId, _exit, { stop }) => stop && "refusal" in stop && refused.push(stop.refusal.cause) });
    f.start("task-late-404");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));

    await lateOutput(f, { stdout: resultLine({ is_error: true, api_error_status: 404 }) }, 1);

    expect(refused).toEqual(["api_404"]);
  });

  it("exit のあと読み切りの前に届いた 401 の result 行で、Provider 認証停止へ昇格する", async () => {
    const f = await makeWorker();
    f.start("task-late-401");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));

    await lateOutput(f, { stdout: resultLine({ is_error: true, api_error_status: 401 }) }, 1);

    expect(listBoard(f.db).filter((task) => task.type === "question").map((task) => task.title)).toEqual([
      "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped",
    ]);
  });

  it("強制回収は root の exit の時点で撃たれ、worker_exited は読み切りまで書かれない", async () => {
    const f = await makeWorker();
    f.start("task-force-at-exit");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));

    f.emitExitOnlyAt(0, 0, null);

    expect(f.killed).toEqual(["SIGKILL"]);
    expect(exitedOf(f.db, "task-force-at-exit")).toBeUndefined();
    f.emitCloseAt(0, 0, null);
    expect(exitedOf(f.db, "task-force-at-exit")).toMatchObject({ exit_code: 0, output_closed: true });
  });

  it("読み切りが回収 timeout までに来なければ、それまでに読めた分で worker_exited を書き、盤面側の一撃を呼ぶ", async () => {
    const exits: WorkerExit[] = [];
    const f = await makeWorker({}, { onWorkerExited: (_taskId, exit) => exits.push(exit) });
    f.start("task-never-closed");
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    f.processes[0]!.stdout.write(resultLine({}));
    f.processes[0]!.stderr.write("stuck\n");
    await new Promise((resolve) => setImmediate(resolve));

    f.emitExitOnlyAt(0, 0, null);
    await f.clock.advance(RECLAIM_TIMEOUT);

    expect(exitedOf(f.db, "task-never-closed")).toMatchObject({
      exit_code: 0,
      stderr_tail: "stuck",
      usage: { input_tokens: 7 },
      output_closed: false,
    });
    expect(exits).toEqual([{ exit_code: 0, signal: null, stderr_tail: "stuck", reported_error: null, last_message: null }]);
  });
});

describe("Claude 側の probe は中立の cwd で走る(skill 列挙: issue #106、tool-surface probe: ADR 0039)", () => {
  /** spec の cwd と、呼ばれた瞬間のその中身を写し取る偽の口。`fails` なら口が throw する。 */
  function cwdRecordingCall(fails = false) {
    const seen = { calls: 0, cwd: "", entries: [] as string[] };
    const call = (async (spec: BoardCallSpec) => {
      Object.assign(seen, { calls: seen.calls + 1, cwd: spec.cwd, entries: readdirSync(spec.cwd) });
      if (fails) throw new Error("口が落ちた");
      return null;
    }) as BoardCall;
    return { call, seen };
  }

  const probes = [
    ["ホストの skill 列挙", (call: BoardCall) => enumerateHostSkills(call)],
    ["tool-surface probe", (call: BoardCall) => enumerateToolsThrough(call)()],
  ] as const;

  it.each(probes)("%s の Board call は盤面の cwd ではなく、呼び出しの最中だけ存在する空のディレクトリで走る", async (_, probe) => {
    const { call, seen } = cwdRecordingCall();

    await probe(call);

    expect(seen.calls).toBe(1);
    expect(seen.cwd).not.toBe(process.cwd());
    expect(seen.entries).toEqual([]);
    expect(existsSync(seen.cwd)).toBe(false);
  });

  // ADR 0335 決定2: 同梱集合は worker と同じ tier フラグで撃つ —— user 層の skill は同梱に数えない
  it("ホストの skill 列挙(同梱集合)は --setting-sources project と --strict-mcp-config で撃つ(ADR 0341 決定4)", async () => {
    const { call, specs } = specRecordingCall();
    await enumerateHostSkills(call);

    const { args } = specs[0]!;
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
    expect(args).toContain("--strict-mcp-config");
  });

  it.each(probes)("%s の空の cwd は、口が throw したあとにも残らない", async (_, probe) => {
    const { call, seen } = cwdRecordingCall(true);

    await expect(probe(call)).rejects.toThrow("口が落ちた");

    expect(existsSync(seen.cwd)).toBe(false);
  });
});

describe("Claude の Board call は姿勢を名指す(ADR 0341)", () => {
  // worker-shaped の probe が見るものは worker が見るもの —— 姿勢の一覧と worker 本体の spawn をずらさない(決定4)
  it("worker 本体の spawn の argv は worker-shaped の姿勢のフラグをどれも運ぶ", async () => {
    const { start, calls } = await makeWorker();
    start();
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const { args } = calls[0]!;
    for (const flag of POSTURE_FLAGS["worker-shaped"]) expect(args).toContain(flag);
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
  });

  it("workspace を cwd にする skill 列挙は worker の形で撃ち、sandbox の profile は運ばず、回収済み観測を待つ(決定3・4・5)", async () => {
    const { call, specs } = specRecordingCall();

    await enumerateWorkspaceSkills(call)("/workspaces/sandbox");

    expect(specs[0]).toMatchObject({ posture: "worker-shaped", cwd: "/workspaces/sandbox", awaitReclaimed: true });
    const { args } = specs[0]!;
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--settings");
  });

  it("tool-surface probe の argv は姿勢を先に置いた同じ集合のままである(封じ込めの観測は変わらない)", () => {
    const spec = toolSurfaceProbeSpec("/tmp/tidepool-tools-neutral");
    const { args } = spec;
    const settings = args[args.indexOf("--settings") + 1]!;
    const tools = args[args.indexOf("--tools") + 1]!;

    expect(spec).toMatchObject({ posture: "worker-shaped" });
    expect(args.slice(0, 3)).toEqual(["--setting-sources", "project", "--strict-mcp-config"]);
    expect([...args].sort()).toEqual(
      [
        "-p", "/usage", "--output-format", "stream-json", "--verbose", "--model", "haiku", "--max-turns", "1", "--max-budget-usd", "0.01",
        "--permission-mode", "acceptEdits", "--setting-sources", "project", "--strict-mcp-config", "--settings", settings, "--tools", tools,
      ].sort(),
    );
  });

  it("答えを取りに行く呼び出しは --safe-mode と --setting-sources \"\" を姿勢で運ぶ(ADR 0303 決定1)", async () => {
    const { call, specs } = specRecordingCall();

    await expect(execThrough(call, "task draft")("claude", ["-p"], {}, "prompt")).rejects.toThrow("produced no answer");

    expect(specs[0]).toMatchObject({ posture: "answer" });
    expect(specs[0]!.args).toEqual(["--safe-mode", "--setting-sources", "", "-p"]);
  });
});
