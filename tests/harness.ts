import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, expect, onTestFinished, vi } from "vitest";
import {
  BOARD_ACTOR_ID,
  HUMAN_ACTOR_ID,
} from "../src/actor-id.js";
import type { AgentAdmin, AgentView } from "../src/agent-create.js";
import type { AllocationClient } from "../src/allocation-review.js";
import {
  bootstrapUrl as authBootstrapUrl,
  generateToken,
  type HumanCredential,
  hashToken,
} from "../src/auth.js";
import type { BoardCall } from "../src/board-call.js";
import type { BoardStatePath } from "../src/board-state.js";
import type { Cause } from "../src/cause.js";
import { moonshotKeyAbsence } from "../src/claude-worker.js";
import type { CliAuthCheck, ModelProbe } from "../src/cli-auth.js";
import type { Clock } from "../src/clock.js";
import { type CodexAppServerProbe, codexLoginAbsence } from "../src/codex-app-server.js";
import { type Db, openDb } from "../src/db.js";
import type { DraftClient } from "../src/draft.js";
import { appendEvent, type EventPayload, type EventRow, getEvent, type Judgment, latestEventOfTask, listEvents } from "../src/events.js";
import { type ExecutionSetting, matchesRowKey, readExecutionSettings } from "../src/execution-setting.js";
import type { GitHubAuth } from "../src/github-auth.js";
import type { HarnessContainmentCheck } from "../src/harness-containment.js";
import { recordShadow, type TrackRecord } from "../src/learner.js";
import { buildMetaReviewMaterial, completeMemoryReview, moveMemoryByMetaReview, recordKnowledge, recordMetaReviewMaterial, routingPrecedents } from "../src/memory.js";
import { type MetaReviewSubject, registerMetaReview } from "../src/meta-review.js";
import { EXTRACTOR_VERSION } from "../src/precedent.js";
import type { ContainerRuntime, ProcessContainers } from "../src/process-container.js";
import type { ProfileAdmin } from "../src/profile-create.js";
import type { Provider } from "../src/provider.js";
import { openQuarantineQuestion, type QuarantineKind, type QuarantineResolvers, quarantineAgent } from "../src/quarantine.js";
import type {
  AuthorityProfile,
  RegistryCandidates,
  RegistryReachabilityCheck,
  RegistrySource,
  RosterAgent,
} from "../src/registry.js";
import { type AttributionClient, type BehaviorDraftClient, completeRca } from "../src/retrospective.js";
import { completeRoutingReview, judgmentKey, type RegistryAgent, type RoutingObject } from "../src/routing-review.js";
import { HOURLY, type TaskExecutionCandidates } from "../src/scheduler.js";
import { startServer } from "../src/server.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import type { Slot } from "../src/slot.js";
import {
  answerQuestion,
  completeAudit,
  completeIntegrationReview,
  completeTask,
  decomposeTask,
  getTask,
  humanDecomposeTask,
  isRca,
  listBoard,
  listChildren,
  listExaminees,
  logDecision,
  metaReviewSubjectOf,
  poseProbe,
  presentTask,
  type RegisterTaskInput,
  recordPrOpened,
  registerTask,
  type Task,
  type TaskType,
  taskVerbSwap,
} from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { TranscriptStore } from "../src/transcript-store.js";
import type { TranslationClient } from "../src/translate.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { startWatchdog, type WatchdogConfig } from "../src/watchdog.js";
import type { WorkerExit, WorkerExitClassification } from "../src/worker.js";
import type { WorkerMcpReachabilityProbe } from "../src/worker-mcp-reachability.js";
import { openInterviewRoom, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import type { WorkspaceAdmin } from "../src/workspace-create.js";
import {
  FakeAttributionClient,
  FakeBehaviorDraftClient,
  FakeClock,
  FakeContainerRuntime,
  FakeGitHubClient,
  FakePushClient,
  fakeHead,
  pinnedCliVersions,
  ScriptedWorker,
} from "./fakes.js";
import { tempDir } from "./temp-dir.js";

export { HOURLY as HOUR } from "../src/scheduler.js";

/** 実行設定の候補。テストが言いたい欄だけを上書きする。 */
export function executionSetting(provider: Provider, model: string, overrides: Partial<ExecutionSetting> = {}): ExecutionSetting {
  return {
    provider,
    model,
    effort: "high",
    advisor: undefined,
    tier_id: 1,
    source: { tier: "board", provider: "only" },
    ...overrides,
  };
}

/** テスト盤面の credential(issue #153 / ADR 0036)。`bootTidepool` は必ず
 *  これを持つ盤面を起こし、`api()` が bearer で提示する — 既存テストの本文は
 *  認証の存在を知らないままでよい。無認証の振る舞いを主張したいテストだけが
 *  素の `fetch` を使う。
 *
 *  **リテラルではなくその場で生成する(issue #154)。** 盤面もハーネスも同じ
 *  プロセスの中にいるので、平文はこの変数として存在すれば足り、ディスクに置く
 *  理由が1つも無い — 置けば「テスト用だから」で始まった文字列が、実盤面に
 *  貼り付けられる既定値として一人歩きする余地が残る(ADR 0036 が盤面側で
 *  ハッシュしか持たないと決めたのと同じ理由を、道具側にも通す)。
 *  プロセスごとに違う値になるが、盤面を起こすのも提示するのもこのモジュールなので
 *  テストからは見えない。 */
export const TEST_TOKEN = generateToken();

/** `startServer` を直に呼ぶテスト(harness を通さないもの)が渡す credential。
 *  ハッシュの組み立てを各所で書き直さない。 */
export const TEST_CREDENTIAL = { tokenHash: () => hashToken(TEST_TOKEN) };

/** 既定値を外した登録者・経路(#1361)を、今までの既定どおり human / webui で渡す。 */
export const HUMAN_WEBUI = [HUMAN_ACTOR_ID, "webui"] as const;

/** domain 層の出題が記録する root の分岐元の仮の sha。checkout で引く受験者の pickup が要るテストは実の sha を渡す。 */
export const POSED_HEAD = "0000000000000000000000000000000000000000";

// 位置引数の `undefined` の列を呼び手から隠す(#1505 / #1519)。domain の signature は渡し忘れを型で止めるために
// `T | undefined` の位置引数のまま残し(ADR 0194 決定2)、テストの呼び出しだけがここを通る。origin を確かめるテストは
// domain を直接呼ぶ。

/** 人間が webui から答える。`stageUnblock` は渡さない(triage session の前挿しを持たない)。 */
export function answerQuestionViaWebui(
  db: Db,
  question: Task,
  answers: string[],
  now: Date,
  { comment, amendment, runnable }: { comment?: string; amendment?: Parameters<typeof answerQuestion>[6]; runnable?: Parameters<typeof answerQuestion>[8] } = {},
): Task {
  return answerQuestion(db, question, answers, now, undefined, comment, amendment, "webui", runnable);
}

/** worker として分解する。保護 workspace は無い。 */
export function decomposeTaskViaWorker(
  db: Db,
  parent: Task,
  input: Parameters<typeof decomposeTask>[2],
  actorId: string,
  now: Date,
  { authority }: { authority?: Parameters<typeof decomposeTask>[5] } = {},
): Task[] {
  return decomposeTask(db, parent, input, actorId, now, authority, undefined, "worker");
}

/** 人間が webui から分解する。保護 workspace は無い。 */
export function humanDecomposeTaskViaWebui(
  db: Db,
  parent: Task,
  input: Parameters<typeof humanDecomposeTask>[2],
  now: Date,
): Task[] {
  return humanDecomposeTask(db, parent, input, now, undefined, "webui");
}

export interface Tidepool {
  baseUrl: string;
  /** `/mcp`'s own base URL (issue #37) — separate from `baseUrl` now that
   *  `/mcp` lives on its own port, off the one `tailscale serve` would
   *  publish. */
  mcpBaseUrl: string;
  clock: FakeClock;
  worker: ScriptedWorker;
  /** 容器機構の fake(ADR 0099 決定2)。強制回収の記録と、空の観測の駆動口。 */
  containers: FakeContainerRuntime;
  github: FakeGitHubClient;
  push: FakePushClient;
  /** Shared setup connection; assertions still go through public read surfaces. */
  db: Db;
  dir: string;
  /** Shut down the process only, keeping the SQLite file — for restart tests. */
  stopServer: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface BootOptions {
  /** Existing board dir to reboot on — for restart tests. */
  dir?: string;
  /** Override the scripted WorkerAdapter identity across board restarts. */
  workerId?: string;
  /** 起動の間に GitHub を待たせるテスト(起動の収束 —— ADR 0241 決定5)が、起動前に細工した fake を渡す。 */
  github?: FakeGitHubClient;
  workerAdapter?: Parameters<typeof startServer>[0]["worker"];
  /** The board's workspace: a real git checkout the tree rule acts on. */
  workspace?: WorkspaceConfig;
  /** ADR 0093 決定5: `TIDEPOOL_GITHUB_TOKEN_FILE` のパス。settings の
   *  「GitHub にログイン済みか」だけがこれを読む。 */
  githubTokenFile?: string;
  /** ADR 0093: 盤面の GitHub 身元。pickup / 完了時の fetch が仲介から
   *  installation token を取る経路を持つ盤面だけが渡す。 */
  githubAuth?: GitHubAuth;
  /** ADR 0052 / issue #211: どの registry clone を読み書きするか + remote 正本の宣言。
   *  registry clone が workspace としても登録されているときの「2つの宣言」の
   *  突き合わせだけがこれを要る。Absent → registry を持たない盤面 = 突き合わせ無し。 */
  registry?: RegistrySource;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009). Absent → every task runs against the single `workspace`
   *  above. */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** Per-task-type absolute time limits (#9). */
  watchdog?: WatchdogConfig;
  /** 容器機構(ADR 0099 決定2)。boot 前にスクリプトしたいテストだけが渡す
   *  (機構前提検査の不成立など)。Absent → 既定の fake。fake でない機構を渡した盤面では
   *  `t.containers` は配線されない fake になる(`workerAdapter` と `t.worker` と同じ)。 */
  containerRuntime?: ContainerRuntime;
  /** transcript の器(ADR 0149)。session の stream を取って落としたいテストだけが渡す。
   *  Absent → 盤面の dir に開く既定の器。 */
  transcripts?: TranscriptStore;
  /** This board's one worker's authority profile (issue #11). */
  authority?: AuthorityProfile;
  /** Resolves the executing task's own agent's authority profile (ADR 0012 /
   *  issue #36), read fresh every call from `task.assignee` (null → the
   *  board's default agent). Takes precedence over the static `authority`
   *  above when both are given. Absent → falls back to `authority`. */
  resolveAuthority?: (assignee: string | null, taskType: TaskType) => AuthorityProfile | undefined;
  /** Whether an agent name is currently registered (ADR 0012 / issue #36),
   *  read fresh against the registry — used both for registration-time
   *  validation and an agent quarantine Confirmation question's clearance
   *  check. Absent → no registry configured, so any name is accepted at
   *  registration and only "no more todo tasks depend on it" can clear a
   *  quarantine. */
  agentRegistered?: (name: string) => boolean;
  /** Whether an agent name currently resolves to the built-in agent (ADR 0228)
   *  — no registry entry shadows it. Absent → nothing resolves to the built-in. */
  resolvesToBuiltIn?: (name: string) => boolean;
  /** Why a registered agent name fails pickup's resolution, or undefined when
   *  it resolves (issue #1745). Absent → registration alone counts as back. */
  agentDefinitionFailure?: (name: string) => string | undefined;
  /** Assignee/workspace candidates for the registration screen (issue #12).
   *  A static snapshot (the common case) or a per-request provider — the
   *  latter lets a test prove the endpoint re-reads each call (issue #78). */
  registryCandidates?: RegistryCandidates | (() => RegistryCandidates | undefined);
  /** The LLM draft seam (issue #12). Absent (the default) — same as no LLM
   *  configured, matching the "LLM outage" fallback path. */
  draftClient?: DraftClient;
  /** The display-time translation seam (issue #47). Absent (the default) —
   *  same "unreachable" posture as no draftClient configured. */
  translationClient?: TranslationClient;
  /** The allocation review's Board call seam (issue #547). Absent (the
   *  default) — integration reviews complete without an annotation. */
  allocationClient?: AllocationClient;
  /** The attribution's Board call seam (issue #574). Absent (the default) —
   *  every objection bundles as `uncertain`, the pre-#574 shape. */
  attributionClient?: AttributionClient;
  /** The Behavior candidate drafting Board call seam (issue #617). Absent (the
   *  default) — no candidate is drafted from an attributed objection. */
  behaviorDraftClient?: BehaviorDraftClient;
  /** The board's Auditor pointer (issue #15 layer 2). Absent → falls back to
   *  `DEFAULT_AUDITOR_NAME` inside `commitTriage` itself. */
  auditorName?: string;
  interviewerName?: string;
  /** Whether an explicitly named workspace is protected (issue #15 layer 2 /
   *  ADR 0013). Absent → no workspace is protected. */
  isProtectedWorkspace?: (name: string) => boolean;
  /** The pull half of the roster (issue #43 / ADR 0014). Absent → `list_agents`
   *  reports only the fixed `human` line. */
  listAgents?: () => RosterAgent[];
  /** The settings surface's workspace verbs (issue #57) — endpoint tests
   *  fake the one verb they exercise (hence Partial); the orchestration
   *  itself has its own real-git coverage (tests/create-workspace.test.ts,
   *  tests/update-workspace.test.ts). */
  workspaceAdmin?: Partial<WorkspaceAdmin>;
  /** The settings surface's agent verbs (issue #71), workspaceAdmin's twin —
   *  endpoint tests fake the one verb they exercise; the orchestration
   *  itself has its own coverage (tests/create-agent.test.ts,
   *  tests/update-agent.test.ts). */
  agentAdmin?: Partial<AgentAdmin>;
  /** The settings surface's profile verbs (issue #77), agentAdmin's twin —
   *  endpoint tests fake the one verb they exercise; the orchestration itself
   *  has its own coverage (tests/create-profile.test.ts). */
  profileAdmin?: Partial<ProfileAdmin>;
  /** The skills picker's candidate source (issue #106 / ADR 0025 点4) — faked
   *  here so GET /api/skills is exercised without a real `claude` CLI (ADR
   *  0027). Absent → the route degrades to an empty candidate set. */
  hostSkills?: (call: BoardCall) => Promise<string[] | null>;
  /** ADR 0137 決定6: 資源単位の quarantine の値 → agent 名(合成 root の map と同じ形)。
   *  直接 cancel の門が読む。Absent → agent 名の行のほかは何も止めない。 */
  quarantineResolvers?: QuarantineResolvers;
  openaiUsage?: CodexAppServerProbe;
  /** ADR 0116 決定4: moonshot の鍵ファイル / Codex の codexHome。渡した盤面だけが
   *  資格情報の不在を実ファイルの存否で観測する。Absent → 不在の観測なし。 */
  moonshotApiKeyFile?: string;
  codexHome?: string;
  /** ADR 0110 決定1/3 / issue #544: この task が走りうる実行設定を Provider 順位で
   *  並べたもの(除外は未適用)。Absent → registry なしの盤面と同じ暗黙の entry
   *  (合成 root の `implicitTaskExecutionCandidates`、ADR 0140 決定3)。 */
  taskExecutionCandidates?: TaskExecutionCandidates;
  /** Adapter-owned sandbox/tool-surface capability seam. Passing it arms the
   *  shared container and human-surface checks too. */
  harnessContainment?: HarnessContainmentCheck;
  /** ADR 0186 決定3: Board call の口が呼び出しのたびに読む Harness の CLI の版の検査。
   *  Absent → 常に一致(版の門を駆動するテストだけが渡す)。 */
  checkHarnessCliVersion?: HarnessContainmentCheck;
  /** ADR 0331 決定8: 開いている Worker MCP の probe の id。テストが id を直に足し引きする。 */
  probeIds?: Set<string>;
  /** ADR 0331 決定8: Worker MCP 到達性の解放の probe。Absent → その確認への回答は拒まれる。 */
  workerMcpReachability?: WorkerMcpReachabilityProbe;
  /** ADR 0097 決定2 / issue #446: per-provider auth probes for the
   *  answer-time re-verification of a provider-auth Confirmation question. */
  providerCliAuth?: Partial<Record<Provider, CliAuthCheck>>;
  /** ADR 0184 決定5: 行の Quarantine への回答時の probe。 */
  modelProbes?: Partial<Record<Provider, ModelProbe>>;
  /** ADR 0052: remote-backed registry reachability seam. */
  registryReachability?: RegistryReachabilityCheck;
  /** ADR 0070: Claude CLI authentication probe. */
  cliAuth?: CliAuthCheck;
  /** ADR 0075: optional token expiry used only for advance warning. */
  cliAuthExpiresAt?: Date;
  /** 盤面自身の状態パスと、boot 一斉検査の対象(ADR 0040 / issue #149)。
   *  Absent → 守る状態パスを持たない盤面(既定): テスト盤面は実プロセスの env を
   *  持たないので、重なりガードそのものを駆動するテストだけが渡す。 */
  boardState?: {
    paths: BoardStatePath[];
    listWorkspaces: () => WorkspaceConfig[];
  };
  /** 人間面の credential(issue #153 / ADR 0036)。Absent → 既定の
   *  `TEST_CREDENTIAL`。認証が成立しない盤面の振る舞い(fail-open と、それを
   *  検出する封じ込め能力ゲート — issue #154)を駆動するテストだけが渡す。 */
  credential?: HumanCredential;
}

/** The server wants a per-request candidates provider; a test may pass one
 *  directly (to prove re-reads) or a plain snapshot for convenience. */
function normalizeCandidates(
  candidates: BootOptions["registryCandidates"],
): (() => RegistryCandidates | undefined) | undefined {
  if (typeof candidates === "function") return candidates;
  if (candidates === undefined) return undefined;
  return () => candidates;
}

/** Boot the whole monolith in-process: temp SQLite, real HTTP on an ephemeral port.
 *  The worker and the GitHubClient are swapped for scripted fakes, at the
 *  WorkerAdapter and GitHubClient seams. */
export async function bootTidepool(options: BootOptions = {}): Promise<Tidepool> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "tidepool-test-")));
  const dbPath = join(dir, "board.sqlite");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock, options.workerId);
  const containers =
    options.containerRuntime instanceof FakeContainerRuntime ? options.containerRuntime : new FakeContainerRuntime();
  const github = options.github ?? new FakeGitHubClient();
  const push = new FakePushClient();
  // 盤面の接続は1本。テストが直接 SQL を撃つ `t.db` も、盤面が使うのも同じ handle で、
  // 閉じるのは `server.stop()`(ADR 0107 決定4 の「setup 用に db を公開する」の形)。
  const db = openDb(dbPath);
  const server = await startServer({
    db,
    port: 0,
    mcpPort: 0,
    clock,
    // issue #153: テスト盤面も本番と同じく必ず credential を持つ(「省略 =
    // 認証なし」の口は作らない)。既定で提示するのは TEST_TOKEN。
    credential: options.credential ?? TEST_CREDENTIAL,
    // 本番の adapter と同じく、盤面側 supervisor を factory から受け取る —— root の
    // exit で強制回収を撃つのは adapter の仕事である(ADR 0109 決定4)
    worker: options.workerAdapter ?? ((deps) => {
      worker.useContainers(deps.containers);
      worker.onSpawnFailed = deps.onSpawnFailed;
      worker.onWorkerExited = deps.onWorkerExited;
      return worker;
    }),
    containerRuntime: options.containerRuntime ?? containers,
    transcripts: options.transcripts ?? new TranscriptStore(dir),
    workspace: options.workspace,
    resolveWorkspace: options.resolveWorkspace,
    // 面接室(ADR 0273 決定1)は盤面の dir の下に作る —— テストがホームの既定の基点に書かない
    workspacesDir: join(dir, "workspaces"),
    watchdog: options.watchdog,
    github,
    authority: options.authority,
    resolveAuthority: options.resolveAuthority,
    agentRegistered: options.agentRegistered,
    resolvesToBuiltIn: options.resolvesToBuiltIn,
    agentDefinitionFailure: options.agentDefinitionFailure,
    // the server takes a per-request provider now; a test may pass one
    // directly, otherwise wrap the static snapshot
    registryCandidates: normalizeCandidates(options.registryCandidates),
    draftClient: options.draftClient,
    translationClient: options.translationClient,
    allocationClient: options.allocationClient,
    attributionClient: options.attributionClient,
    behaviorDraftClient: options.behaviorDraftClient,
    push,
    auditorName: options.auditorName,
    interviewerName: options.interviewerName,
    isProtectedWorkspace: options.isProtectedWorkspace,
    listAgents: options.listAgents,
    workspaceAdmin: options.workspaceAdmin,
    agentAdmin: options.agentAdmin,
    profileAdmin: options.profileAdmin,
    hostSkills: options.hostSkills,
    quarantineResolvers: options.quarantineResolvers,
    openaiUsage: options.openaiUsage,
    credentialAbsence: {
      ...(options.moonshotApiKeyFile && { moonshot: () => moonshotKeyAbsence(options.moonshotApiKeyFile) }),
      ...(options.codexHome && { openai: () => codexLoginAbsence(options.codexHome!) }),
    },
    taskExecutionCandidates: options.taskExecutionCandidates ?? implicitTaskExecutionCandidates(db),
    harnessContainment: options.harnessContainment,
    checkHarnessCliVersion: options.checkHarnessCliVersion ?? pinnedCliVersions,
    probeIds: options.probeIds,
    workerMcpReachability: options.workerMcpReachability,
    providerCliAuth: options.providerCliAuth,
    modelProbes: options.modelProbes,
    registryReachability: options.registryReachability,
    cliAuth: options.cliAuth,
    cliAuthExpiresAt: options.cliAuthExpiresAt,
    registry: options.registry,
    githubAuth: options.githubAuth,
    githubTokenFile: options.githubTokenFile,
    boardState: options.boardState,
  });
  // 起動完了の poll は起動の収束の後に走る(ADR 0241 決定5)。GitHub を待たない起動の収束と poll はここで終わる ——
  // テストが盤面に何かを足す前に、起動完了の poll が空の queue を読み終えている(待つ GitHub の fake を渡した盤面は別)
  await new Promise((resolve) => setImmediate(resolve));
  const mcpBaseUrl = `http://127.0.0.1:${server.mcpPort}`;
  boards.set(mcpBaseUrl, worker);
  // 走っている停止の Promise を覚える(issue #775) —— ブールでは、中断された1度目の
  // 途中に来た2度目が撃ち直しを起こし、2度目の `close()` が ERR_SERVER_NOT_RUNNING で
  // 落ちる。`stopping` は1度目の呼び手が立て、以降の呼び手は同じ Promise を待つだけになる。
  let stopping: Promise<void> | undefined;
  const stopServer = () => (stopping ??= server.stop().then(() => { boards.delete(mcpBaseUrl); }));
  // 同じ理由で `rm(dir)` も1度だけ —— 2度目の呼び手が同じ dir を並行に消しにいかない。
  let removing: Promise<void> | undefined;
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    mcpBaseUrl,
    clock,
    worker,
    containers,
    github,
    push,
    db,
    dir,
    stopServer,
    stop: () => (removing ??= stopServer().then(() => rm(dir, { recursive: true, force: true }))),
  };
}

/** この harness が起こした盤面の worker、MCP の口の URL 引き。解放系 verb を撃った
 *  client に「session がそこで終わる」を演じさせるために要る(下記)。 */
const boards = new Map<string, ScriptedWorker>();

/** 最終 verb を着地させた session は、そこで終わる(GLOSSARY.md「後始末」)。行儀のよい
 *  worker の root process は締めのターンの直後に exit し、adapter が盤面 supervisor 経由で
 *  強制回収を撃つ(ADR 0109 決定4)—— 既定の容器はそれで空になり、後始末が走って枠が空く。
 *
 *  `ScriptedWorker` は process を持たないので、その exit をここで演じる: 締めのターンの
 *  長さはゼロである。**まだ生きている session**(空にならない容器)を測りたいテストは
 *  `t.containers.hold(taskId)` を先に呼ぶ —— `FakeContainerRuntime` が最初から持っている
 *  「回収に失敗するホストは明示的にスクリプトする」と同じ形である。 */
const RELEASING_VERBS = new Set([
  "complete_task",
  "decompose",
  "escalate",
  "declare_premise_breach",
  "continue_decomposition",
  "redecompose",
  "pose_probe",
  "complete_interview",
  "complete_integration_review",
  "complete_memory_review",
  "complete_routing_review",
  "complete_rca",
]);

/** Real MCP client over streamable HTTP, attributed to a task via ?task=. */
export async function mcpClient(baseUrl: string, taskId?: string): Promise<Client> {
  const url = new URL(`${baseUrl}/mcp`);
  if (taskId !== undefined) url.searchParams.set("task", taskId);
  const client = new Client({ name: "tidepool-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  const worker = boards.get(baseUrl);
  if (worker && taskId !== undefined) {
    const callTool = client.callTool.bind(client);
    client.callTool = (async (params: Parameters<Client["callTool"]>[0], ...rest: never[]) => {
      const result = await callTool(params, ...rest);
      if (RELEASING_VERBS.has(params.name) && result.isError !== true) {
        worker.exit(taskId);
        // 後始末は回収済み観測の後ろ = microtask の先にある。テストが続きを読む前に
        // 走り切らせる(実物では締めのターンと exit にかかる時間がここに入る)
        await new Promise((resolve) => setImmediate(resolve));
      }
      return result;
    }) as Client["callTool"];
  }
  return client;
}

/** `taskId` の task として verb を1回呼んで client を閉じ、CallToolResult をそのまま返す(isError は見ない)。 */
export async function callAsTask(t: Tidepool, taskId: string, name: string, args: Record<string, unknown>): Promise<any> {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

/** 応答予算(ADR 0195)。読み口の応答は、盤面が返す CallToolResult を丸ごとシリアライズした UTF-8 バイト数でこれ以下に収まる。 */
export const RESPONSE_BUDGET_BYTES = 40_000;

/** `name` を `args` で呼び、続き(next)が尽きるまで next だけを渡して追った応答(CallToolResult のバイト数と本文)の列。 */
export async function readFollowingNext(client: Client, name: string, args: Record<string, unknown> = {}) {
  const responses: Array<{ bytes: number; payload: any }> = [];
  let next: unknown;
  do {
    const result: any = await client.callTool({ name, arguments: next === undefined ? args : { next } });
    if (result.isError) throw new Error(`${name}: ${result.content[0].text}`);
    responses.push({ bytes: Buffer.byteLength(JSON.stringify(result)), payload: JSON.parse(result.content[0].text) });
    next = responses.at(-1)!.payload.next;
  } while (next !== undefined);
  return responses;
}

/** Real authenticated client for the human-facing Management MCP.  Keep this
 * distinct from `mcpClient`: the worker and human surfaces are separate trust
 * domains (ADR 0032 / ADR 0036). */
export async function managementMcpClient(baseUrl: string): Promise<Client> {
  const client = new Client({ name: "tidepool-management-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/admin-mcp`), {
      requestInit: { headers: AUTH_HEADERS },
    }),
  );
  return client;
}

/** 道具側の credential(issue #153): 盤面が受ける2つの形のうち bearer のほう。
 *  ブラウザ導線(cookie)は e2e が bootstrap URL を踏んで得る。 */
export const AUTH_HEADERS = { authorization: `Bearer ${TEST_TOKEN}` } as const;

/** テスト盤面の bootstrap URL — 実ブラウザ(e2e)がここを1回踏んで cookie を得る。 */
export function bootstrapUrl(baseUrl: string): string {
  return authBootstrapUrl(baseUrl, TEST_TOKEN);
}

export async function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...AUTH_HEADERS },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** 記憶の一覧を settings タブの読み口(GET /api/settings/memory/entries)で読む。query は `?state=approved` など。 */
export async function memoryEntries(tp: Tidepool, query = ""): Promise<any[]> {
  return (await api(tp.baseUrl, "GET", `/api/settings/memory/entries${query}`)).json.entries;
}

/** Quarantines an agent name — for tests that drive the pickup/queue gate
 *  SQL (ADR 0012 / issue #36). The open Confirmation question is the state
 *  (ADR 0137 決定3), so this puts one on the board. */
export function quarantineTestAgent(db: Db, name: string): void {
  quarantineAgent(db, name, "test quarantine", new Date(0));
}

/** 後始末の印の書き込みだけを落とす(setup、issue #1935 / #2025)—— 記録と印が同じ
 *  transaction なら記録も巻き戻る。 */
export function failTeardownMark(db: Db): void {
  db.exec(
    "CREATE TRIGGER fail_teardown_mark BEFORE UPDATE OF teardown_started_at ON tasks " +
      "BEGIN SELECT RAISE(ABORT, 'teardown mark failed'); END",
  );
}

/** A real git checkout for tree-rule/branch-discipline/quarantine tests —
 *  stderr captured, not inherited, same as src/git.ts's `git`. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
  )
    .toString()
    .trim();
}

/** 「ワーカーが成果を書き、本文を付けてコミットした」の fixture(ADR 0084)。完了を
 *  測るテストはこれを使う —— 書きっぱなしのツリーは完了の門に弾かれる。逆に WIP 退避を
 *  測るテストは素の `writeFileSync` のままでよい(escalate / decompose / review)。 */
export function commitWork(path: string, file: string, body: string): void {
  writeFileSync(join(path, file), body);
  // その1ファイルだけを stage する: `add -A` だと、テストがわざと untracked のまま
  // 残している sandbox shadow まで巻き込んで測りたい差を消す
  git(path, "add", "--", file);
  git(path, "commit", "-m", `add ${file}`);
}

/** 「ワーカーがこのタスクの成果を出した」の fixture。ADR 0084 の完了の門が入って以降、
 *  成果はコミット済みでなければ完了できない —— 書きっぱなしにすると完了が拒否され、
 *  着地も PR も測れない。 */
export function addTaskChange(path: string, taskId: string): void {
  commitWork(path, `${taskId}.txt`, "finished\n");
}

export const FIXTURE_TASK = "6b4c0b23-289e-4f9f-ade1-995fb27f3c0e";
/** seedFixtureBoard が FIXTURE_TASK の隣に置くもう1つのタスク。 */
export const FIXTURE_OTHER_TASK = "609d9475-0191-4a7f-b5bf-5b939695315a";
export const FIXTURE_SPAWNED_EVENT_ID = 5;

// 2.1.237 の実セッションの記録。init 行の `memory_paths` は除いてある —
// auto-memory を閉じた今の spawn 形では出ない項目で、残すと再生のたびに封じ込めが
// 不成立になる(ADR 0156、#994)。init 行の `tools` の `TaskOutput` も同じ理由で除いた —
// 2.1.284 以降の CLI は面に出さず、盤面の宣言からも外した(#1269)。
const sessionFixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `worker-session-2.1.237.${name}`), "utf8");

/** 2.1.237 の実セッションの init 行の `mcp_servers` だけを差し替える —— 封じ込めの照合は通る面(Worker MCP 到達性、ADR 0331 決定6)。 */
export const initWithMcpServers = (mcpServers: unknown[]) => {
  const [init] = sessionFixture("stream.jsonl").split("\n");
  return `${JSON.stringify({ ...JSON.parse(init!), mcp_servers: mcpServers })}\n`;
};

/** #386 のフィクスチャをそのまま持つ盤面。events は id ごと写す(投影の結合は
 *  盤面が発行した event id の完全一致なので、採番が変わると意味が変わる)。
 *  workspace / assignee / handoff は events には無いので tasks 行から解決される。 */
export function seedFixtureBoard(handoffDoc: string | null = null): Db {
  const db = openDb(":memory:");
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, type, status, assignee, workspace, title, purpose, completion_criteria,
       risk_flag, review_flag, sort_key, created_at, handoff_doc)
     VALUES (?, 'work', 'done', ?, ?, 'fixture', 'fixture', 'fixture', 0, 0, 1, '2026-08-20T05:50:48.374Z', ?)`,
  );
  insertTask.run(FIXTURE_TASK, "tako", "sandbox", handoffDoc);
  insertTask.run(FIXTURE_OTHER_TASK, "tidepool", "sandbox", null);
  const insertEvent = db.prepare(
    "INSERT INTO events (id, task_id, actor_id, origin, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const e of JSON.parse(sessionFixture("events.json")) as EventRow[]) {
    insertEvent.run(e.id, e.task_id, e.actor_id, e.origin, e.kind, JSON.stringify(e.payload), e.created_at);
  }
  return db;
}

/** フィクスチャの transcript を dir に name で書き、その path を返す。 */
export function writeFixtureTranscript(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, sessionFixture("stream.jsonl"));
  return path;
}

/** 実 git の fixture を組むテストの上限。macOS CI の runner の速さのばらつき用
 *  (ADR 0155 追記 / issue #1127)。値は 9/26〜28 の macOS CI 288 job でケースごとの
 *  最大 4951ms(timeout 分 5645ms)の約3倍。 */
export const GIT_FIXTURE_TEST_TIMEOUT = 15_000;

/** `git init` + one commit into an already-created dir. Shared by `makeWorkspace`
 *  (a self-cleaning `tempDir`), `buildRemoteTemplate` (a dir that must
 *  outlive a single test, so it creates its own non-self-cleaning dir) and the
 *  `workspace` fixture in `e2e/fixtures.ts` (Playwright, where `tempDir`'s
 *  `onTestFinished` cannot run — issue #1307). */
export async function initWorkspaceCheckout(path: string, name: string): Promise<WorkspaceConfig> {
  git(path, "init", "-b", "main");
  await writeFile(join(path, "README.md"), "workspace\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  return { name, path };
}

/** A fresh temp git checkout named `name`, one commit deep. The dir is a
 *  `tempDir`, so it is removed when the calling test finishes. */
export async function makeWorkspace(name: string): Promise<WorkspaceConfig> {
  const path = await tempDir(`tidepool-${name}-`);
  return initWorkspaceCheckout(path, name);
}

/** 盤面が組んだ URL `from` への git の往復を local の `to` へ回す(実ネットワークへは出ない)。盤面の網に出る git は
 *  checkout の insteadOf を読まない(ADR 0339 決定5)ので、PATH の git の前で引数を書き換える。テストの終わりに戻す。 */
export async function routeGitUrl(from: string, to: string): Promise<void> {
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  const dir = await tempDir("tidepool-git-route-");
  writeFileSync(join(dir, "git"), `#!/bin/sh\nfor a; do shift; [ "$a" = "${from}" ] && a="${to}"; set -- "$@" "$a"; done\nexec "${real}" "$@"\n`, {
    mode: 0o755,
  });
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  onTestFinished(() => {
    process.env.PATH = path;
  });
}

/** `makeWorkspace` の remote 正本つきの姿(ADR 0052 / issue #211): bare な origin を
 *  持つ checkout と、そこへ**人間の merge を模して**書き込む publisher を組む。
 *  返す `WorkspaceConfig` の `repo` が「この workspace はリモートの正本を持つ」の
 *  宣言そのもので、値としては bare な origin のパス —— 盤面が読むのは有無だけである。
 *
 *  `makeWorkspace` に remote を足さないのは意図的で、remote を持たない workspace は
 *  正当な構成(既存の全テストがその形)だから。remote が要るテストだけがこれを使う。 */
export async function makeRemoteBackedWorkspace(
  name: string,
): Promise<{
  workspace: WorkspaceConfig;
  /** origin の保護ブランチへ直接コミットして push する = リモートで merge が起きた
   *  状態を作る。clone 側の `refs/remotes/origin/main` は fetch するまで動かない ——
   *  そこが測りたい差である。 */
  publish: (file: string, body: string, message: string) => void;
}> {
  // 中身は全ケースで同一なので、組むのは1度だけ。各ケースはそのコピーを使う(issue #842)
  remoteTemplate ??= buildRemoteTemplate();
  const template = await remoteTemplate;
  const path = await tempDir(`tidepool-${name}-`);
  const origin = await tempDir(`tidepool-${name}-origin-`);
  const publisher = await tempDir(`tidepool-${name}-publisher-`);
  await cp(template.origin, origin, { recursive: true });
  for (const [from, to] of [
    [template.path, path],
    [template.publisher, publisher],
  ] as const) {
    await cp(from, to, { recursive: true });
    const config = join(to, ".git", "config");
    await writeFile(config, (await readFile(config, "utf8")).replaceAll(template.origin, origin));
  }
  return {
    workspace: { name, path, repo: origin },
    publish: (file, body, message) => {
      writeFileSync(join(publisher, file), body);
      netGit(publisher, "add", file);
      netGit(publisher, "commit", "-m", message);
      netGit(publisher, "push", "origin", "main");
    },
  };
}

let remoteTemplate: ReturnType<typeof buildRemoteTemplate> | undefined;
// 自己完結する harness の `tempDir` には載せない —— どのケースの後始末でも消えてはならず、ファイルの afterAll で消す。
// module はテストファイルごとに読み直されるので、組むのもファイルごとに1度。
// afterAll はテスト実行中には登録できないので import 時に置く。e2e(Playwright)も api を
// ここから import するので vitest の下に限る
const remoteTemplateDirs: string[] = [];
if (process.env.VITEST) {
  afterAll(() => Promise.all(remoteTemplateDirs.map((dir) => rm(dir, { recursive: true, force: true }))));
}

// stderr は piped: clone / push の進捗は成否に関係なく stderr へ出るので、素通しすると
// テスト出力が git のノイズで埋まる(registry-fixture.ts と同じ規律)
const netGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

async function buildRemoteTemplate() {
  const path = await mkdtemp(join(tmpdir(), "tidepool-remote-template-"));
  remoteTemplateDirs.push(path);
  await initWorkspaceCheckout(path, "remote-template");
  const origin = await mkdtemp(join(tmpdir(), "tidepool-remote-template-origin-"));
  const publisher = await mkdtemp(join(tmpdir(), "tidepool-remote-template-publisher-"));
  remoteTemplateDirs.push(origin, publisher);
  netGit(origin, "init", "--bare", "-b", "main");
  netGit(path, "remote", "add", "origin", origin);
  netGit(path, "push", "-u", "origin", "main");
  netGit(publisher, "clone", "--quiet", origin, ".");
  return { path, origin, publisher };
}

/** Land a task branch on a bare origin by content but not ancestry, mirroring
 *  an out-of-band squash merge. */
export async function squashTaskIntoOrigin(
  workspace: WorkspaceConfig,
  taskId: string,
): Promise<void> {
  const merger = await tempDir("tidepool-squash-");
  git(merger, "clone", workspace.repo!, ".");
  git(merger, "fetch", workspace.path, `task/${taskId}:landed`);
  git(merger, "merge", "--squash", "landed");
  git(merger, "commit", "-m", "squash task outside the board");
  git(merger, "push", "origin", "main");
}

/** done の根(内容はタスクブランチにだけある)の下に、異議由来の修理と RCA review(盤面名義の付帯子)が未決着で残る木。
 *  `closed` なら根の PR #1 が盤面の外で閉じられたと観測されている(ADR 0265 決定6)。`decomposed` なら根は分解子を1つ持ち
 *  (内容は根のブランチへ merge 済み)、異議はその分解子に出る。 */
export async function closedRootTree(
  name: string,
  { decomposed = false, closed = true } = {},
): Promise<{ workspace: WorkspaceConfig; db: Db; root: Task; repairs: Task[] }> {
  const now = new Date("2026-10-16T00:00:00.000Z");
  const workspace = await makeWorkspace(name);
  const db = openDb(":memory:");
  const root = registerTask(db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI);
  git(workspace.path, "checkout", "-b", `task/${root.id}`);
  let objected = root;
  if (decomposed) {
    [objected] = decomposeTaskViaWorker(db, root, { reason: "split", children: [{ title: "part", purpose: "p", completion_criteria: "c" }] }, "deckhand", now) as [Task];
    git(workspace.path, "checkout", "-b", `task/${objected.id}`);
    commitWork(workspace.path, "part.txt", "part\n");
    git(workspace.path, "checkout", `task/${root.id}`);
    git(workspace.path, "merge", "--no-edit", `task/${objected.id}`);
    completeTask(db, objected, FULL_HANDOFF, "deckhand", now, "worker");
  } else {
    commitWork(workspace.path, "feature.txt", "ready\n");
  }
  git(workspace.path, "checkout", "main");
  const entry = logDecision(db, objected, "ship it", "deckhand", now, "worker");
  completeTask(db, getTask(db, root.id)!, FULL_HANDOFF, "deckhand", now, "worker");
  settleReviews(db, now);
  startTriage(db, now);
  raiseObjection(db, entry, "redo it", now);
  commitTriage(db, now);
  if (closed) {
    appendEvent(db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number: 1 }, at: now });
  }
  const repairs = listChildren(db, objected.id).filter((child) => child.status === "todo");
  expect(repairs.map((child) => child.type).sort()).toEqual(["review", "review", "work"]);
  return { workspace, db, root, repairs };
}

export async function registerWork(
  t: Tidepool,
  title: string,
  workspace?: string,
  assignee?: string,
): Promise<any> {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    ...(workspace !== undefined && { workspace }),
    ...(assignee !== undefined && { assignee }),
  });
  return res.json;
}

/** 次の poll を起こす: 第2回と起草を撃つのは poll の sweep だけで(ADR 0169)、RCA 子の決着の扉は親が拾えるときしか poll を
 *  促さない。人間の登録は常に促す(ADR 0119 決定2)—— 人間担当の行なので slot は取らない。 */
export const nextPoll = (t: Tidepool) => registerWork(t, "a pickup trigger", undefined, "human");

/** `registerWork` と同じ行を、人間の扉を通さずに置く。扉の登録は自身が pickup の契機なので
 *  (ADR 0119 決定2)、「todo のまま待っている行」を前提にするテストはこちらを使う。 */
export function queueWork(
  t: Tidepool,
  title: string,
  workspace?: string,
  assignee?: string,
): Task {
  return registerTask(
    t.db,
    {
      type: "work",
      title,
      purpose: `purpose of ${title}`,
      completion_criteria: `criteria of ${title}`,
      ...(workspace !== undefined && { workspace }),
      ...(assignee !== undefined && { assignee }),
    },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
}

/** Put one decision line in the log for the slot task and return its entry. */
export async function loggedEntry(t: Tidepool, taskId: string, line: string): Promise<any> {
  await callAsTask(t, taskId, "log_decision", { line });
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  return log.entries.find((e: any) => e.payload.line === line);
}

/** 盤面全体の knowledge entry を1件置き、その id を返す(setup のみ)。taskId があればその task の書き込みとして記録する。 */
export function rememberedNote(t: Tidepool, title: string, taskId?: string): number {
  return recordKnowledge(
    t.db,
    { scope: null, path: "build", title, text: `${title}.`, source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    t.clock.now(),
    taskId,
  ).entry_id;
}

/** setup のみ: 受験者の Interview の root の id。受験者は親を持たないので、詳細の読み口が名指す root を引く(ADR 0267 決定1・6)。 */
export function examineeRootId(db: Db, examineeId: string): string {
  return presentTask(db, { id: examineeId }).interview_root_id!;
}

/** setup のみ: root の面接室を使い捨ての基点の下に開く(ADR 0273 決定1)—— 盤面の pickup を通らずに root や受験者を adapter で
 *  走らせるテストが、pickup の代わりに置く。 */
export function openTestInterviewRoom(db: Db, root: Task): void {
  const base = mkdtempSync(join(tmpdir(), "tidepool-rooms-"));
  onTestFinished(() => rm(base, { recursive: true, force: true }));
  openInterviewRoom(db, root, base, new Date(0));
}

/** setup のみ: 受験者の pickup が開く自分の checkout の代わりに、空コミットだけの repo を在り処として残す(ADR 0276 決定1)—— 盤面の
 *  pickup を通らずに受験者を adapter で走らせるテストが置く。 */
export function openTestExamineeCheckout(db: Db, examinee: Task): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "tidepool-examinee-")));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "commit", "--quiet", "--allow-empty", "-m", "Initial commit");
  appendEvent(db, { taskId: examinee.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "examinee_checkout_opened", path }, at: new Date(0) });
  return path;
}

/** setup のみ: このプロセスの git の commit だけを落とす(署名を求め、署名の program は無い)。他の git は通る。
 *  config は既存の `GIT_CONFIG_*`(vitest.config.ts の env)の後ろに足す。途中で戻すのは `vi.unstubAllEnvs()`、テストの終わりには必ず戻る。 */
export function failGitCommits(): void {
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const n = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  vi.stubEnv("GIT_CONFIG_COUNT", String(n + 2));
  vi.stubEnv(`GIT_CONFIG_KEY_${n}`, "commit.gpgsign");
  vi.stubEnv(`GIT_CONFIG_VALUE_${n}`, "true");
  vi.stubEnv(`GIT_CONFIG_KEY_${n + 1}`, "gpg.program");
  vi.stubEnv(`GIT_CONFIG_VALUE_${n + 1}`, "/nonexistent-gpg");
}

/** `body` の間に撃たれた `unhandledRejection` の理由を集める。reject は後の macrotask で届くので、1つ流してから外す。 */
export async function unhandledRejectionsDuring(body: () => Promise<unknown>): Promise<unknown[]> {
  const rejections: unknown[] = [];
  const record = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", record);
  try {
    await body();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", record);
  }
  return rejections;
}

/** setup のみ: task を一度 pickup された形にする(列も status も動かさない)—— 人間名義の review 子が付ける(ADR 0292 決定2)。返り値は
 *  `task_picked_up` の id(shadow 行が乗る event、ADR 0319 決定1)。 */
export function markPickedUp(db: Db, taskId: string, at: Date, actorId = "deckhand"): number {
  return appendEvent(db, { taskId, actorId, origin: "board", at, payload: { kind: "task_picked_up" } });
}

/** setup のみ: 対象1つの Interview を登録して probe を出し、その受験者を返す。 */
export function interviewExaminee(db: Db, at: Date): Task {
  const interview = registerTask(
    db,
    { type: "interview", title: "interview", hypothesis: "the target writes the parser", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] },
    at,
    ...HUMAN_WEBUI,
  );
  return poseAccepted(db, interview, { title: "add a parser", probe: "write a parser", completion_criteria: "the parser works", rubric: "tests pass" }, "auditor", at, "worker", POSED_HEAD)[0]!;
}

/** setup のみ: root が出題し、その監査 review が受理して立った受験者を返す(ADR 0273 決定3)。受理は出題した agent と別の名前の Auditor 名義。 */
export function poseAccepted(...args: Parameters<typeof poseProbe>): Task[] {
  const [db, root, , , now] = args;
  const audit = poseProbe(...args);
  completeAudit(db, audit, { verdict: "accepted", findings: "the probe asks for the measured tier's work" }, "fugu", now, "worker");
  return listExaminees(db, root.id);
}

/** `entryId` に異議を打ってセッションを閉じ(束ね済みにし)、その異議群に `entries` を名指す memory の帰責を足す。
 *  setup のみ —— 門を通った帰責を直に置き、Board call は撃たない。 */
export async function memoryAttributedObjection(t: Tidepool, taskId: string, entryId: number, entries: number[], evidence = "followed the note"): Promise<void> {
  const objection = await object(t, entryId, "そのメモが間違っています");
  await api(t.baseUrl, "POST", "/api/triage/close");
  appendEvent(t.db, {
    taskId,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    at: t.clock.now(),
    payload: { kind: "objection_attributed", entry_id: entryId, objection_event_ids: [objection], cause: "memory", evidence, wrong_memory_entries: entries, round: "after_rca" },
  });
}

/** setup のみ: `entryId` に束ね済みの異議を1つ置き、その異議 event の id(異議群の名前)を返す —— commit 済みの triage session を
 *  1行足し、その session の `objection_raised` を書く(Board call も修理子・RCA 子も立たない)。呼ぶたびに別の session なので、
 *  2回呼べば同じ entry の2つの異議群になる。帰責の fixture はこの id を `objection_event_ids` に名指す。 */
export function bundledObjection(db: Db, taskId: string, entryId: number, at: Date, comment = "redo it"): number {
  const iso = at.toISOString();
  const session = db
    .prepare("INSERT INTO triage_sessions (started_at, last_activity_at, committed_at, closed_by) VALUES (?, ?, ?, 'commit')")
    .run(iso, iso, iso);
  return appendEvent(db, {
    taskId,
    actorId: "human",
    origin: "webui",
    payload: { kind: "objection_raised", entry_id: entryId, comment, session_id: Number(session.lastInsertRowid) },
    at,
  });
}

/** setup のみ: bundledObjection の異議群に cause capability の初回の帰責を直に置き(Board call は撃たない)、異議 event の id を返す ——
 *  異議つき判断の行(list_precedents・材料の節)は帰責のある判断だけ(ADR 0312 決定5)。 */
export function attributedObjection(db: Db, taskId: string, entryId: number, at: Date, comment = "redo it"): number {
  const objection = bundledObjection(db, taskId, entryId, at, comment);
  appendEvent(db, {
    taskId,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    at,
    payload: { kind: "objection_attributed", entry_id: entryId, objection_event_ids: [objection], cause: "capability", evidence: "e", wrong_memory_entries: null, round: "initial" },
  });
  return objection;
}

/** setup のみ: 判断の行の event を 1 marker = 1 episode の直挿しで episode に載せる(#356 の投影は使わない)。episode の id と
 *  worker_spawned_event_id はその event id —— 呼び手ごとの採番が重ならない。 */
export function episodeOfDecision(db: Db, taskId: string, decision: number, agent = "deckhand"): void {
  db.prepare("INSERT INTO episodes (id, worker_spawned_event_id, extractor_version, task_id, agent, lines) VALUES (?, ?, ?, ?, ?, '{}')").run(decision, decision, EXTRACTOR_VERSION, taskId, agent);
  db.prepare("INSERT INTO episode_markers (episode_id, seq, kind, position, event_id) VALUES (?, 0, 'decision', 0, ?)").run(decision, decision);
}

/** setup のみ: meta-review の task に完了の verb が書く型つきの判断の行を置いて episode に載せ、その行に帰責つきの異議を立てる。
 *  返り値は判断の行の event id。 */
export function objectedJudgment(db: Db, taskId: string, judgment: Judgment, at: Date): number {
  const decision = appendEvent(db, { taskId, actorId: "auditor", origin: "worker", at, payload: { kind: "decision_logged", line: judgment.kind, judgment } });
  episodeOfDecision(db, taskId, decision, "auditor");
  attributedObjection(db, taskId, decision, at);
  return decision;
}

/** 直接適用の書き込みの記録が帰属する task(盤面ごとに1本)。書き込みの記録を読まない検査の setup が、書き手の task として渡す。 */
const writers = new WeakMap<Db, string>();
export function writerTask(db: Db): string {
  const known = writers.get(db);
  if (known) return known;
  const id = registerTask(db, { type: "work", title: "memory writer", purpose: "p", completion_criteria: "c" }, new Date(0), ...HUMAN_WEBUI).id;
  writers.set(db, id);
  return id;
}

/** `parentId` を主題とする失敗 question(retry / abandon、cancel option は abandon)を1本立てる。 */
export function failureQuestion(db: Db, parentId: string, at: Date): Task {
  return registerTask(
    db,
    {
      type: "question",
      title: "failure",
      purpose: "choose retry or abandon",
      completion_criteria: "answered",
      parent_id: parentId,
      question: [{ title: "next step", options: ["retry", "abandon"], recommendation: "retry" }],
      question_kind: { kind: "failure", cancel_option: "abandon" },
    },
    at,
    ...HUMAN_WEBUI,
  );
}

/** A child under `parentId` — which makes the parent `blocked` (unfinished
 *  child), so the parent sits at the raw head while never being pickable. */
/** 人間 decompose の子を1本、扉を通さずに置く(扉の登録は pickup の契機 —— ADR 0119 決定2 ——
 *  なので、子が todo のまま待つことを前提にするテストのための形。`queueWork` と同じ)。 */
export function queueChild(t: Tidepool, title: string, parentId: string): Task {
  const [child] = humanDecomposeTaskViaWebui(
    t.db,
    getTask(t.db, parentId)!,
    {
      reason: `split ${title} from its parent`,
      children: [{ title, purpose: `purpose of ${title}`, completion_criteria: `criteria of ${title}` }],
    },
    t.clock.now(),
  );
  return child!;
}

/** An unanswered question under `parentId`, which holds every sibling below it
 *  out of the slot — `todo` rows in the table that can never be picked. Returns
 *  the question so a test can answer it and watch the hold release. */
export function holdChildren(t: Tidepool, parentId: string): Task {
  return registerQuestion(t, {
    title: "unrelated decision",
    purpose: "a human wants steering input",
    completion_criteria: "answered",
    parent_id: parentId,
    question: [{ title: "unrelated decision", options: ["yes", "no"], recommendation: "yes" }],
  });
}

/** Fabricates a question task directly on the board's own handle,
 *  mirroring how tidepool's internal callers (watchdog/quarantine/merge/
 *  decompose) register one. The human-facing `/api/tasks` door refuses
 *  `type: "question"` outright (issue #38), so tests that need a question
 *  fixture go through this seam instead. */
export function registerQuestion(t: Tidepool, input: Omit<RegisterTaskInput, "type">): Task {
  return registerTask(t.db, { ...input, type: "question" }, t.clock.now(), BOARD_ACTOR_ID, "board");
}

/** 盤面の DB へ直に付帯子(親を持ち、based_on_decision を持たず、question でない子)を
 *  1つ足す — `bundleObjections` が異議修理を登録するのと同じ形。人間面の /api/tasks は
 *  parent_id つきの登録に decompose_reason を要求する(= 分解子になる)ので、付帯子の
 *  fixture はこの seam を通す(`registerQuestion` と同じ理由)。 */
export function attachChild(
  t: Tidepool,
  parentId: string,
  title: string,
  assignee?: string,
  type: "work" | "review" = "work",
): Task {
  return registerTask(
    t.db,
    {
      type,
      title,
      purpose: `purpose of ${title}`,
      completion_criteria: `criteria of ${title}`,
      parent_id: parentId,
      ...(assignee !== undefined && { assignee }),
    },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );
}

/** 盤面が今立てている question の行すべて — 読み口(`GET /api/tasks`)から引く。 */
export async function questions(t: Tidepool): Promise<any[]> {
  return (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (candidate: any) => candidate.type === "question",
  );
}

/** その kind・value の、開いている quarantine question(GLOSSARY.md の Quarantine)—
 *  読み口(`GET /api/tasks`)から引く。board scope の kind の value は null。無ければ undefined。
 *  ドメイン層は `quarantineQuestion`。 */
export async function servedQuarantineQuestion(
  t: Tidepool,
  kind: QuarantineKind,
  value: string | null,
): Promise<any> {
  return (await questions(t)).find(
    (q: any) =>
      q.question_quarantine_kind === kind &&
      q.question_quarantine_value === value &&
      q.status === "todo",
  );
}

/** その kind・value の、開いている quarantine question(GLOSSARY.md の Quarantine)。
 *  無ければ undefined。行は直に読まず、production の読み口 `openQuarantineQuestion` で引く
 *  (ADR 0107 決定2)。サーバ境界は `servedQuarantineQuestion`。 */
export function quarantineQuestion(db: Db, kind: QuarantineKind, value: string | null): Task | undefined {
  const open = openQuarantineQuestion(db, kind, value);
  return open && getTask(db, open.id);
}

/** slot task を MCP の `complete_task` で完了させる: `fullHandoff` は全欄、false は work 以外に要る outcome だけ(ADR 0278 決定6)。 */
export async function completeViaMcp(t: Tidepool, taskId: string, fullHandoff = true): Promise<any> {
  return callAsTask(t, taskId, "complete_task", { handoff: fullHandoff ? FULL_HANDOFF : { outcome: FULL_HANDOFF.outcome } });
}

/** 修理子の無い統合レビューを閉じる complete_integration_review の引数(ADR 0278 決定2)。 */
export const NOTHING_TO_REPAIR = { findings: "the deliverable meets its completion criteria", nothing_to_repair: true } as const;

/** 統合レビューか —— その完了の verb が足されているかで見る(述語そのものは production の内側)。 */
const isIntegrationReview = (db: Db, taskId: string) => taskVerbSwap(db, taskId).added.includes("complete_integration_review");

/** 統合レビューを MCP の complete_integration_review の「指摘なし」で完了させる。 */
export async function completeIntegrationReviewViaMcp(t: Tidepool, reviewId: string): Promise<any> {
  return callAsTask(t, reviewId, "complete_integration_review", NOTHING_TO_REPAIR);
}

/** meta-review の spawn の注入を記録し、材料を返す(setup、ADR 0278 追記4): 記録を書くのは実 adapter の spawn だけで ScriptedWorker は
 *  刻まないので、WORKER_SPAWNED の写しを刻み、その event id で材料の節を記録する。 */
function injectMaterial(db: Db, reviewId: string, actorId: string, at: Date, agents?: readonly RegistryAgent[]) {
  const material = buildMetaReviewMaterial(db, reviewId, agents);
  if (!material) throw new Error(`${reviewId} is not a meta-review`);
  const spawned = appendEvent(db, { taskId: reviewId, actorId, origin: "board", at, payload: WORKER_SPAWNED });
  recordMetaReviewMaterial(db, reviewId, actorId, spawned, material, at);
  return material;
}

/** memory meta-review の注入を記録し、注入した「Items to judge」の項目を返す(setup)。 */
export function injectMemoryMaterial(db: Db, reviewId: string, actorId: string, at: Date) {
  const material = injectMaterial(db, reviewId, actorId, at);
  if (material.subject !== "memory") throw new Error(`${reviewId} is not a memory meta-review`);
  return material.parts.items;
}

/** routing meta-review の注入を記録し、節の「Items to judge」が並べる判断の鍵(agent が写す形)を返す(setup)。 */
export function injectRoutingMaterial(db: Db, reviewId: string, actorId: string, at: Date, agents?: readonly RegistryAgent[]) {
  const material = injectMaterial(db, reviewId, actorId, at, agents);
  if (material.subject !== "routing") throw new Error(`${reviewId} is not a routing meta-review`);
  return material.parts.items.map(judgmentKey);
}

/** 型つきの判断の行(ADR 0278 決定4)を書いた memory meta-review(setup は domain): 前の周期を閉じてから stock() で窓の中に店を作り、
 *  周期を登録して材料を注入し、act(review) の後に注入した項目をすべて left_as_is で完了する。row は項目(エントリの id か枝の (path, scope))の
 *  判断の行の id。executor は review を走らせた agent。 */
export function judgedMemoryReview(db: Db, at: Date, stock: () => void, act: (review: Task) => void = () => {}, executor = "fugu") {
  registerMetaReview(db, "memory", at);
  db.prepare("UPDATE tasks SET status = 'done' WHERE meta_review_subject = 'memory'").run();
  stock();
  registerMetaReview(db, "memory", at);
  const review = listBoard(db).find((task) => task.meta_review_subject === "memory" && task.status === "todo")! as Task;
  const items = injectMemoryMaterial(db, review.id, executor, at);
  act(review);
  completeMemoryReview(db, getTask(db, review.id)!, { judgments: items }, executor, at, "worker");
  const row = (object: number | { branch: string; scope: string | null }) =>
    listEvents(db, review.id).find(({ payload: p }) => {
      const j = p.kind === "decision_logged" ? p.judgment : undefined;
      if (j?.kind !== "memory") return false;
      return "memory_entry" in j ? j.memory_entry === object : typeof object === "object" && j.branch === object.branch && j.scope === object.scope;
    })!.id;
  return { review, row };
}

/** memory meta-review の行への異議で束ねた memory_repair。rows は異議を打つ行: judgment は型つきの判断の行(ADR 0279 決定3)、write は
 *  同じ review の書き込みの行(エントリの移動)、both は両方を同じ commit で —— 両方の行を運ぶ修理子になる(ADR 0281)。修理子は executor の名前を写す。 */
export function judgmentRepairTask(db: Db, at: Date, { rows = "judgment", executor = "fugu" }: { rows?: "judgment" | "write" | "both"; executor?: string } = {}): Task {
  const author = { activity: "worker_verb" as const, name: "deckhand" };
  const note = (title: string, path: string) => recordKnowledge(db, { scope: null, path, title, text: `${title}.`, source: { commit: "0a46a46" }, author }, "worker", at).entry_id;
  const moving = note("Moving note", "misc");
  let judged = 0;
  let moved: number | undefined;
  const { review, row } = judgedMemoryReview(
    db,
    at,
    () => (judged = note("Squash", "build")),
    (review) => {
      if (rows !== "judgment") moved = moveMemoryByMetaReview(db, { entry_id: moving, scope: null, path: "misc/old", mover: { activity: "meta_review", name: executor } }, "worker", at, review.id).event_id;
    },
    executor,
  );
  if (rows !== "write") raiseObjection(db, row(judged), "fold it into the build notes", at);
  if (moved !== undefined) raiseObjection(db, moved, "move it back", at);
  commitTriage(db, at);
  return listChildren(db, review.id).find((child) => child.type === "memory_repair")!;
}

/** `task` に `worker` の判断の行を書き、capability と帰責した異議を commit して、立った auditor RCA(open)を返す。 */
export function auditorRcaOn(db: Db, task: Task, at: Date, worker = "auditor"): Task {
  startTriage(db, at);
  const row = logDecision(db, task, `${worker}'s call`, worker, at, "worker");
  raiseObjection(db, row, "redo it", at);
  commitTriage(db, at, [], new Map([[row, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));
  return listChildren(db, task.id).find((child) => child.title.startsWith("rca (auditor)"))!;
}

/** routing の材料の setup で走る行(段 standard)。 */
export const OPUS_ROW = { provider: "anthropic" as const, model: "claude-opus-5-5", effort: "high" };
/** registry の agent deckhand(組み込みでなく段 standard —— agent_tier で1段下げられる)。 */
export const DECKHAND_AGENT: AgentView = { name: "deckhand", version: "1", authority: "standard", description: "agent", provider: "anthropic", advisor: false, tier: "standard", skills: ["*"], retiredFields: [], unknownFields: [], systemPrompt: "p" };

export const NO_RECORD: TrackRecord = { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 }, seed: null };

/** setup のみ: standard を求めた task の opus の行の session が2つ走る —— 1つは乖離した shadow 行の pickup で段の出所が agent、もう1つは
 *  段の出所が task で、どちらにも配分評価が付く。routing meta-review の窓の中なら項目は opus の行・agent deckhand・段 standard・学習器。
 *  返り値は2つの worker_spawned の id(出所 agent、task の順)。 */
export function routedOpusSessions(db: Db, at: Date): number[] {
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c", tier: "standard", workspace: "reef" }, at, ...HUMAN_WEBUI).id;
  recordShadow(db, work, { recommended: executionSetting("anthropic", "claude-sonnet-5-5"), actual: executionSetting("anthropic", OPUS_ROW.model), basis: "prior", recommended_record: NO_RECORD, actual_record: NO_RECORD, candidates: 2 }, at, markPickedUp(db, work, at));
  const spawn = (tier: "agent" | "task") =>
    appendEvent(db, { taskId: work, actorId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, ...OPUS_ROW, advisor: null, tier_id: tierIdOf(db, "standard"), source: { tier, provider: "rank" } } });
  const evidence = [spawn("agent"), spawn("task")];
  for (const spawned of evidence) {
    const payload = { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: spawned, judge: { provider: "anthropic", model: "fable", effort: "high" }, allocation: "overpowered", cause: "uncertain", evidence: "e" };
    appendEvent(db, { taskId: work, actorId: "tidepool", origin: "board", at, payload: payload as Extract<EventPayload, { kind: "allocation_reviewed" }> });
  }
  return evidence;
}

/** setup のみ: 段 standard の work task(workspace は既定 reef)の pickup で学習器と表が分かれた shadow 行を書き、その pickup が開いた
 *  session を刻んで worker_spawned の id を返す。昇格前の行(`learner` 無し)は表のセル(OPUS_ROW の model)が走り、昇格後の行は
 *  学習器のセル(既定 sonnet)が出所 learner で走る(ADR 0150 決定3)。実績は既定で空。 */
export function divergedSession(
  db: Db,
  at: Date,
  options: { learner?: boolean; tier?: string; workspace?: string; learnerModel?: string; learnerRecord?: TrackRecord; tableRecord?: TrackRecord } = {},
): number {
  const { learner = false, tier = "standard", workspace = "reef", learnerModel = "claude-sonnet-5-5", learnerRecord = NO_RECORD, tableRecord = NO_RECORD } = options;
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c", tier, workspace }, at, ...HUMAN_WEBUI).id;
  const tier_id = tierIdOf(db, tier);
  const table = executionSetting("anthropic", OPUS_ROW.model, { tier_id, source: { tier: "task", provider: "rank" } });
  const chosen = executionSetting("anthropic", learnerModel, { tier_id, source: { tier: "task", provider: learner ? "learner" : "rank" } });
  const [recommended, actual] = learner ? [table, chosen] : [chosen, table];
  const [recommended_record, actual_record] = learner ? [tableRecord, learnerRecord] : [learnerRecord, tableRecord];
  recordShadow(db, work, { recommended, actual, basis: "data", recommended_record, actual_record, candidates: 2 }, at, markPickedUp(db, work, at));
  return appendEvent(db, {
    taskId: work,
    actorId: "deckhand",
    origin: "board",
    at,
    payload: { ...WORKER_SPAWNED, provider: "anthropic", model: actual.model, effort: actual.effort, advisor: null, tier_id, source: actual.source },
  });
}

/** setup のみ: 表の行 `row` で、その行の今の段で走った本番の work session を1つ刻み、worker_spawned の id を返す —— 行・段を足す・Interview の
 *  提案の根拠の母集団に入る(ADR 0302)。task はその段を要求し人間が登録するので、出所 task なら段の説明の提案の根拠にもなる。 */
export function rowSession(db: Db, row: { provider: string; model: string; effort: string | null }, at: Date, agent = "deckhand"): number {
  const tier = readExecutionSettings(db).table.find((r) => matchesRowKey(r, row))!.tier;
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c", tier, workspace: "reef" }, at, ...HUMAN_WEBUI).id;
  return appendEvent(db, {
    taskId: work,
    actorId: agent,
    origin: "board",
    at,
    payload: { ...WORKER_SPAWNED, ...row, provider: row.provider as Provider, advisor: null, tier_id: tierIdOf(db, tier), source: { tier: "task", provider: "rank" } },
  });
}

/** 型つきの判断の行(ADR 0278 決定4)を書いた routing meta-review(setup は domain): 前の周期を閉じてから stock() で窓の中に材料を作り、
 *  周期を登録して材料を注入し、注入した項目をすべて no_change で完了する。row(object) はその対象の判断の行の id。executor は review を
 *  走らせた agent。registry は DECKHAND_AGENT だけ。 */
export function judgedRoutingReview(db: Db, at: Date, stock: () => void = () => {}, executor = "auditor") {
  registerMetaReview(db, "routing", at);
  db.prepare("UPDATE tasks SET status = 'done' WHERE meta_review_subject = 'routing'").run();
  stock();
  registerMetaReview(db, "routing", at);
  const review = listBoard(db).find((task) => task.meta_review_subject === "routing" && task.status === "todo")! as Task;
  const judgments = injectRoutingMaterial(db, review.id, executor, at, [DECKHAND_AGENT]);
  completeRoutingReview(db, getTask(db, review.id)!, { judgments }, executor, at, "worker", routingPrecedents(db, review.id), [DECKHAND_AGENT]);
  const row = (object: RoutingObject) =>
    listEvents(db, review.id).find(({ payload: p }) => {
      if (p.kind !== "decision_logged" || p.judgment?.kind !== "routing") return false;
      const { kind: _, value: __, reason: ___, ...named } = p.judgment;
      return isDeepStrictEqual(named, object);
    })!.id;
  return { review, row };
}

/** routing meta-review の学習器の no_change の行への異議で束ねた routing_repair(ADR 0279 決定4)。修理子は executor の名前を写す。 */
export function routingJudgmentRepairTask(db: Db, at: Date, { executor = "auditor" } = {}): Task {
  const { review, row } = judgedRoutingReview(db, at, undefined, executor);
  raiseObjection(db, row({ learner: true }), "promote the learner", at);
  commitTriage(db, at);
  return listChildren(db, review.id).find((child) => child.type === "routing_repair")!;
}

/** 判断ログのうち完了の verb が書いた型つきの行(ADR 0278 決定4)。 */
export const judgmentRows = (db: Db, taskId: string) =>
  listEvents(db, taskId).flatMap((e) => (e.payload.kind === "decision_logged" && e.payload.judgment ? [e.payload] : []));

/** memory meta-review を MCP の complete_memory_review で、材料を注入して記録し、注入した項目をすべて据え置いて完了させる(ADR 0278 決定5)。 */
export async function completeMemoryReviewViaMcp(t: Tidepool, reviewId: string): Promise<any> {
  const judgments = injectMemoryMaterial(t.db, reviewId, t.worker.id, t.clock.now());
  return callAsTask(t, reviewId, "complete_memory_review", { judgments });
}

/** routing meta-review を MCP の complete_routing_review で、材料を注入して記録し、注入した対象をすべて no_change にして完了させる(ADR 0278 決定5)。 */
export async function completeRoutingReviewViaMcp(t: Tidepool, reviewId: string): Promise<any> {
  const judgments = injectRoutingMaterial(t.db, reviewId, t.worker.id, t.clock.now());
  return callAsTask(t, reviewId, "complete_routing_review", { judgments });
}

/** harness の complete_rca の所見の根本原因の既定。 */
export const RCA_ROOT_CAUSE = "the objection came from the call itself";

/** RCA の材料の全エントリを1つの所見に入れた complete_rca の引数(ADR 0278 決定5 / ADR 0280)。no_act は行為が無い所見に要り、
 *  行為があれば無害。handoff の outcome は complete_task の RCA と同じ完了の result を残す。 */
export function rcaFindings(db: Db, reviewId: string, root_cause = RCA_ROOT_CAUSE) {
  const objections = latestEventOfTask(db, reviewId, "task_registered")!.payload.opened_on_event_ids ?? [];
  const entries = [...new Set(objections.map((id) => (getEvent(db, id)!.payload as Extract<EventPayload, { kind: "objection_raised" }>).entry_id))];
  return { findings: [{ material: entries, root_cause, no_act: true as const }], handoff: { outcome: FULL_HANDOFF.outcome } };
}

/** slot task をその種別の完了の verb で完了させる: 統合レビューは「指摘なし」、memory meta-review は項目をすべて据え置き、
 *  routing meta-review は対象をすべて no_change、RCA は材料を1つの所見に、他は complete_task(work だけ handoff 付き)。 */
export async function completeByKindViaMcp(t: Tidepool, task: { id: string; type: string }): Promise<any> {
  if (isIntegrationReview(t.db, task.id)) return completeIntegrationReviewViaMcp(t, task.id);
  const subject = metaReviewSubjectOf(t.db, task.id);
  if (subject) return (subject === "memory" ? completeMemoryReviewViaMcp : completeRoutingReviewViaMcp)(t, task.id);
  if (isRca(t.db, task.id)) return callAsTask(t, task.id, "complete_rca", rcaFindings(t.db, task.id));
  return completeViaMcp(t, task.id, task.type === "work");
}

/** Finish only the reviews generated for this integration point, through the
 *  public worker verbs, so landing fixtures include the mandatory review gate.
 *  A todo review is started with `runNow`, which first completes whichever task holds the slot
 *  (e.g. the parent that took it once its only work child finished). */
export async function completeIntegrationReviews(t: Tidepool, taskId: string): Promise<void> {
  const children = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter(
    (task: any) => task.parent_id === taskId && task.type === "review" && ["todo", "in_progress"].includes(task.status),
  );
  for (const review of children) {
    if (!isIntegrationReview(t.db, review.id)) continue;
    if (review.status === "todo") await runNow(t, review.id);
    const result = await completeIntegrationReviewViaMcp(t, review.id);
    if (result.isError) throw new Error(`review completion failed: ${JSON.stringify(result)}`);
  }
}

/** setup のみ: routing の材料を1つ書く —— 人間が settings タブで表の moonshot の行の出力価格を1つ上げる(行でない設定の変更は
 *  routing の材料でない、ADR 0319 決定3)。economy の価格の並びで最後のままなのでどの pickup の選択も変えず、Items to judge にその行が1つ載る。 */
export async function routingMaterialViaWebui(t: Tidepool): Promise<void> {
  const row = readExecutionSettings(t.db).table.find((r) => r.provider === "moonshot")!;
  const written = await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", key: { provider: row.provider, model: row.model, effort: row.effort }, row: { ...row, price_out: row.price_out + 1 } });
  expect(written.status, JSON.stringify(written.json)).toBe(200);
}

/** 主題の初回の meta-review を人間の扉(WebUI)で起こす(setup)。周期の登録は初回を立てない(ADR 0300 決定2)ので、材料を書いて
 *  meta-review を立てる setup はこれを通す。扉は登録で pickup を促す。 */
export async function startFirstMetaReviewViaWebui(t: Tidepool, subject: MetaReviewSubject): Promise<void> {
  const started = await api(t.baseUrl, "POST", "/api/settings/meta-review/first", { subject });
  expect(started.status, JSON.stringify(started.json)).toBe(200);
}

/** 帰責の event は memory の、worker_exited と実行設定の変更は routing の meta-review の材料なので、盤面が登録して queue に
 *  置く(issue #618・#917)。後続の work が次の pickup を取れるよう、open な meta-review を `runNow` で走らせて完了させる(setup)。
 *  `runNow` は slot の持ち主を先に完了させるので、別の task が slot を握っていても meta-review は完了する。一覧は1件ごとに
 *  読み直す —— 持ち主として先に完了した meta-review を二度完了させず、途中で登録された meta-review も拾う。 */
export async function completeMetaReviews(tp: Tidepool) {
  for (;;) {
    const review = (await api(tp.baseUrl, "GET", "/api/tasks")).json.find(
      (x: any) => x.meta_review_subject && ["todo", "in_progress"].includes(x.status),
    );
    if (!review) break;
    await runNow(tp, review.id);
    expect((await completeByKindViaMcp(tp, review)).isError).not.toBe(true);
  }
}

/** The 6-field handoff doc, filled in with placeholder content — shared by
 *  every test that just needs *a* valid handoff to complete a work task. */
export const FULL_HANDOFF = {
  outcome: "done as specified",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
};

/** 盤面の完了時レビューをすべて決着させる —— 着地の門を、fixture の子だけが閉じる形にする。 */
export function settleReviews(db: Db, now: Date): void {
  for (const review of listBoard(db).filter((t) => t.type === "review" && t.status === "todo")) settleReview(db, getTask(db, review.id)!, "shako", now);
}

/** review をドメインで完了させる(setup): 統合レビューは complete_integration_review の「指摘なし」、memory / routing meta-review は
 *  材料の注入を記録して complete_memory_review で項目をすべて据え置き / complete_routing_review で対象をすべて no_change に、RCA は
 *  complete_rca で材料を1つの所見に、他は complete_task。 */
export function settleReview(db: Db, review: Task, actorId: string, now: Date): Task {
  if (isIntegrationReview(db, review.id)) return completeIntegrationReview(db, review, NOTHING_TO_REPAIR, actorId, now, "worker");
  if (review.meta_review_subject === "memory") return completeMemoryReview(db, review, { judgments: injectMemoryMaterial(db, review.id, actorId, now) }, actorId, now, "worker");
  if (review.meta_review_subject === "routing") return completeRoutingReview(db, review, { judgments: injectRoutingMaterial(db, review.id, actorId, now) }, actorId, now, "worker", routingPrecedents(db, review.id));
  if (isRca(db, review.id)) return completeRca(db, review, rcaFindings(db, review.id), actorId, now, "worker");
  return completeTask(db, review, FULL_HANDOFF, actorId, now, "worker");
}

/** agent `assignee` が完了させた work(domain 層)。着地の記録はまだ何も無い。 */
export function completedWork(db: Db, now: Date, assignee: string, parentId?: string, workspace?: string): Task {
  const task = registerTask(
    db,
    { type: "work", title: "ship", purpose: "p", completion_criteria: "c", assignee, parent_id: parentId, workspace },
    now,
    ...HUMAN_WEBUI,
  );
  return completeTask(db, task, FULL_HANDOFF, assignee, now, "worker");
}

/** agent `assignee` の auto_if_ci_green で無人 merge キューに入った PR #7 を持つ完了タスク(着地待ち)。 */
export function queuedForAutoMerge(db: Db, now: Date, assignee: string): Task {
  const task = completedWork(db, now, assignee);
  recordPrOpened(db, task, 7, fakeHead(7), assignee, now, { merge: "auto_if_ci_green" }, undefined, "worker");
  return task;
}

// 帰責・起草の撃ち直しの setup(tests/retrospective.test.ts と tests/memory-settings-endpoints.test.ts が共有する)

/** triage session の中で entry に異議を打ち、異議 event の id を返す。 */
export async function object(t: Tidepool, entryId: number, comment: string) {
  return (await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: entryId, comment }))
    .json.id as number;
}

/** 盤面が今持つ `taskId` の子すべて。 */
export async function children(t: Tidepool, taskId: string) {
  return (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((x: any) => x.parent_id === taskId);
}

/** worker session の記録(偽の worker は `worker_spawned` を刻まないので、episode の要る盤面が置く)。 */
export const WORKER_SPAWNED: Extract<EventPayload, { kind: "worker_spawned" }> = {
  kind: "worker_spawned",
  registry_commit: "commit",
  definition_version: "1",
  advisor: "fable",
  provider: "anthropic",
  model: "opus",
  effort: "high",
  tier_id: 1, source: { tier: "task", provider: "only" },
  harness: "claude-code",
  cli_version: "1",
  skills: { workspace: [], host: [], permitted: [] },
};

/** transcript の tool 呼び出し1回 = tool_use と、event_id を返した tool_result の2行(投影器のテストの setup)。 */
export const toolCall = (n: number, name: string, eventId: number | null) => [
  `{"type":"assistant","uuid":"a${n}","message":{"content":[{"type":"tool_use","id":"t${n}","name":"${name}","input":{}}]}}`,
  `{"type":"user","uuid":"r${n}","message":{"content":[{"type":"tool_result","tool_use_id":"t${n}","content":[{"type":"text","text":"{\\"event_id\\":${eventId}}"}]}]}}`,
];

/** worker が見た skill の集合を報告する init 行(固定版 2.1.286 の形、ADR 0325 決定2)。 */
export const skillsInit = (skills: string[]) => JSON.stringify({ type: "system", subtype: "init", skills });

/** transcript の skill の呼び出し1回 = `Skill` の tool_use・commandName つきの結果・本文の合成 user 行の3行(固定版 2.1.286 の形、#2682)。 */
export const skillCall = (n: number, name: string, body: string) => [
  `{"type":"assistant","uuid":"a${n}","message":{"content":[{"type":"tool_use","id":"t${n}","name":"Skill","input":{"skill":"${name}"}}]}}`,
  `{"type":"user","uuid":"r${n}","tool_use_result":{"success":true,"commandName":"${name}"},"message":{"content":[{"type":"tool_result","tool_use_id":"t${n}","content":"Launching skill: ${name}"}]}}`,
  JSON.stringify({ type: "user", uuid: `s${n}`, isSynthetic: true, message: { content: [{ type: "text", text: `Base directory for this skill: /w/.claude/skills/${name}\n\n${body}` }] } }),
];

/** 何も観測しなかった exit(exit 0・signal なし・表示用の欄はすべて null)。各テストは上書きする欄だけを書く(issue #1333)。 */
export const QUIET_EXIT: WorkerExit = {
  exit_code: 0,
  signal: null,
  stderr_tail: null,
  reported_error: null,
  last_message: null,
};

/** setup のみ: 時限の無い watchdog へ root の exit を束付きで渡す —— adapter と同じく、exit で強制回収を撃ってから渡す
 *  (ADR 0109 決定4 / ADR 0201 決定1)。 */
export function exitToWatchdog(
  deps: { db: Db; clock: Clock; slot: Slot; containers: ProcessContainers; resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig; pollNow?: () => void },
  taskId: string,
  facts: WorkerExitClassification,
): void {
  deps.containers.forceReclaim(taskId);
  startWatchdog({ ...deps, worker: new ScriptedWorker(deps.clock), pollNow: deps.pollNow ?? (() => {}) }).onWorkerExited(taskId, QUIET_EXIT, facts);
}

/** agent 名と workspace 名の集合を registry として注入する boot の欄(集合を後から減らすと削除を模せる)。null の workspace は盤面の既定。 */
export function registryOf(agents: Set<string>, workspaces: Set<string>, path = "/workspaces/known"): Pick<BootOptions, "agentRegistered" | "workspace" | "resolveWorkspace"> {
  return {
    agentRegistered: (name) => agents.has(name),
    // 既定の workspace は resolver と同じ出所から渡す —— 本番の合成(`workspaceConfig` / `workspaceResolver`)と同じ形
    workspace: { name: "tidepool", path },
    resolveWorkspace: (name) => {
      if (name === null || name === "tidepool" || workspaces.has(name)) return { name: name ?? "tidepool", path };
      throw new UnknownWorkspaceError(name);
    },
  };
}

/** `fallback` を既定にした盤面の resolver: null は `fallback`、名前は `fallback` と `others` から引く。 */
export const defaultingTo = (fallback: WorkspaceConfig, ...others: WorkspaceConfig[]) => (name: string | null) => {
  const found = [fallback, ...others].find((w) => w.name === (name ?? fallback.name));
  if (!found) throw new UnknownWorkspaceError(name ?? fallback.name);
  return found;
};

/** 起草 client つきの盤面で、work(既定 workspace charts)に1行 log → 完了 → 異議まで進める(commit は呼び手)。
 *  `registrant` を渡すと agent が登録した task(decompose と同じ登録者の形)、`human` は人間が担当して人間の扉で完了。
 *  `allocationClient` を渡すと work に worker session を置き、統合点レビューの完了で配分評価が撃たれる。 */
export async function objectedForDraft(
  title: string,
  opts: Pick<BootOptions, "allocationClient" | "agentRegistered"> & {
    initial?: { cause: Cause; evidence: string };
    registrant?: string;
    /** task を `decomposedBy` の分解判断に乗る子にする(decomposedChild)。workspace が要る。 */
    decomposedBy?: string;
    workspace?: string | null;
    human?: true;
  } = {},
) {
  const attributionClient = new FakeAttributionClient();
  const behaviorDraftClient = new FakeBehaviorDraftClient();
  const t = await bootTidepool({ attributionClient, behaviorDraftClient, allocationClient: opts.allocationClient, agentRegistered: opts.agentRegistered });
  const workspace = opts.workspace === null ? undefined : (opts.workspace ?? "charts");
  const task = opts.decomposedBy
    ? decomposedChild(t.db, registerTask(t.db, { type: "work", title: `parent of ${title}`, purpose: "p", completion_criteria: "c", workspace }, t.clock.now(), ...HUMAN_WEBUI), title, opts.decomposedBy, t.clock.now())
    : opts.registrant
      ? registerTask(t.db, { type: "work", title, purpose: "p", completion_criteria: "c", workspace }, t.clock.now(), opts.registrant, "worker")
      : await registerWork(t, title, workspace, opts.human && "human");
  let entry: any;
  if (opts.human) {
    await api(t.baseUrl, "POST", `/api/tasks/${task.id}/complete`, { handoff: FULL_HANDOFF });
    entry = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json.find((e: any) => e.kind === "task_completed");
  } else {
    await t.clock.advance(HOURLY);
    if (opts.allocationClient) appendEvent(t.db, { taskId: task.id, actorId: t.worker.id, origin: "board", at: t.clock.now(), payload: WORKER_SPAWNED });
    entry = await loggedEntry(t, task.id, "skipped the fixtures");
    await completeViaMcp(t, task.id);
  }
  await completeIntegrationReviews(t, task.id);
  if (opts.initial) attributionClient.scriptJudgment(entry.id, opts.initial);
  await api(t.baseUrl, "POST", "/api/triage/start");
  const objection = await object(t, entry.id, "always keep the fixtures");
  return { t, attributionClient, behaviorDraftClient, task, entry, objection };
}

/** `decomposer` の分解判断に乗る `parent` の子(workspace は parent のもの)。agent の分解は allowed_workspaces の外の子を
 *  承認 question に変え、人間が approve して実体化させる —— 子の登録者は human、文面の書き手は分解した agent(ADR 0197)。
 *  人間の分解は子を直接登録する。 */
export function decomposedChild(db: Db, parent: Task, title: string, decomposer: string, now: Date, tier?: string): Task {
  const viaApproval = decomposer !== HUMAN_ACTOR_ID;
  const child = { title, purpose: "p", completion_criteria: "c", workspace: parent.workspace ?? undefined, tier };
  const authority = viaApproval ? { allowed_workspaces: [] } : undefined;
  decomposeTask(db, parent, { reason: "split it", children: [child] }, decomposer, now, authority, undefined, viaApproval ? "worker" : "webui");
  if (viaApproval) {
    const question = listChildren(db, parent.id).find((x) => x.type === "question")!;
    answerQuestionViaWebui(db, question, ["approve"], now);
  }
  return listChildren(db, parent.id).find((x) => x.type === "work" && x.title === title)!;
}

/** commit して RCA 子を返す。 */
export async function commit(t: Tidepool, taskId: string, title: string) {
  const res = await api(t.baseUrl, "POST", "/api/triage/close");
  const kids = await children(t, taskId);
  return {
    res,
    self: kids.find((x: any) => x.title === `rca (self): ${title}`),
    auditor: kids.find((x: any) => x.title === `rca (auditor): ${title}`),
  };
}

/** slot を占めている task を順に完了させてから、先頭での2回の move で `taskId` を Run now。 */
export async function runNow(t: Tidepool, taskId: string) {
  for (;;) {
    const running = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((x: any) => x.status === "in_progress");
    if (!running || running.id === taskId) break;
    const res = await completeByKindViaMcp(t, running);
    if (res.isError) throw new Error(`slot holder completion failed: ${JSON.stringify(res)}`);
  }
  const moved = await api(t.baseUrl, "POST", `/api/tasks/${taskId}/move`, { after: null });
  if (moved.status !== 200) throw new Error(`run now failed: ${JSON.stringify(moved.json)}`);
  await api(t.baseUrl, "POST", `/api/tasks/${taskId}/move`, { after: null });
}

/** setup のみ: root が worker MCP で出題し、拾われた監査 review が complete_audit で受理する。立った受験者の id を対象の順に返す
 *  (ADR 0273 決定3)。`release` は解放系 verb の後にその session を終えて枠を空ける —— 既定は偽の worker の exit、実 adapter の盤面は
 *  process の exit を渡す。 */
export async function poseThroughAudit(
  t: Tidepool,
  rootId: string,
  probe: Record<string, string>,
  release: (taskId: string) => Promise<void> = async (taskId) => t.worker.exit(taskId),
): Promise<string[]> {
  const posed = await callAsTask(t, rootId, "pose_probe", probe);
  if (posed.isError) throw new Error(`pose_probe failed: ${posed.content[0].text}`);
  await release(rootId);
  const { audit_id } = JSON.parse(posed.content[0].text);
  await runNow(t, audit_id);
  const accepted = await callAsTask(t, audit_id, "complete_audit", { verdict: "accepted", findings: "the probe asks for the measured tier's work" });
  if (accepted.isError) throw new Error(`complete_audit failed: ${accepted.content[0].text}`);
  await release(audit_id);
  return listExaminees(t.db, rootId).map(({ id }) => id);
}

/** RCA 子を worker の complete_rca で決着させる(材料を1つの所見に、no_act)。RCA review は盤面の名義なので人間の直接 cancel は
 *  届かない(ADR 0194)—— `runNow` で拾わせて完了する。 */
export async function settleRcaByWorker(t: Tidepool, reviewId: string) {
  await runNow(t, reviewId);
  const res = await callAsTask(t, reviewId, "complete_rca", rcaFindings(t.db, reviewId));
  if (res.isError) throw new Error(`RCA completion failed: ${JSON.stringify(res)}`);
}

/** `taskId` の task として RCA の起草 verb `propose_from_material` を呼ぶ(起草の中身は固定)。 */
export async function propose(t: Tidepool, taskId: string, args: Record<string, unknown>) {
  return callAsTask(t, taskId, "propose_from_material", { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", ...args });
}

/** settings の撃ち直しを打ち切った件の一覧。 */
export const haltedRefires = async (t: Tidepool) => (await api(t.baseUrl, "GET", "/api/settings/execution/halted-refires")).json.halted;

/** 起草 client の成功の応答。 */
export const KEEP_FIXTURES = { path: "testing/fixtures", title: "Keep fixtures", text: "Always keep the fixtures.", addressee: "all" } as const;
