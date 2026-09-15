import { quarantineAgent, UnknownAgentError } from "./agent.js";
import { boardHalts } from "./board-halt.js";
import {
  type CliAuthCheck,
  quarantineCliAuthForProvider,
  quarantinedAuthProviders,
} from "./cli-auth.js";
import type { Clock } from "./clock.js";
import type { CodexAppServerProbe, CodexAppServerProbeResult } from "./codex-app-server.js";
import {
  type ContainmentCheck,
  containmentPickupBlocked,
} from "./containment.js";
import type { Db } from "./db.js";
import {
  type ExecutionExclusions,
  type ExecutionSetting,
  firstSelectable,
  selectable,
  windowMatchesModel,
} from "./execution-setting.js";
import { type GitHubClient, IssueGoneError } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import {
  type HarnessContainmentCheck,
  harnessContainmentPickupBlocked,
  quarantinedHarnesses,
} from "./harness-containment.js";
import { recordShadow } from "./learner.js";
import { registerDueMetaReviews } from "./memory.js";
import { getProviderPaceOffset } from "./pace-offsets.js";
import {
  canonicalHarness,
  type Harness,
  InvalidAgentDefinitionError,
  PROVIDER_VALUES,
  type Provider,
  type RegistryReachabilityCheck,
  type RegistrySource,
} from "./registry.js";
import { registryReachabilityPickupBlocked } from "./registry-reachability.js";
import { parseGitHubRepo, repairRepoAccess } from "./repo-access.js";
import type { Slot } from "./slot.js";
import { clearSpendDown, getSpendDown } from "./spend-down.js";
import {
  contentSourceFor,
  DEFAULT_AUDITOR_NAME,
  escalateTask,
  nextSlotTask,
  pickupTask,
  resolveTaskAgent,
  type Task,
  type TaskContent,
} from "./tasks.js";
import {
  blockedProviderUsageResources,
  evaluateAndReportProviderUsage,
  type ProviderUsageObservation,
  reportProviderUsage,
  reportThrottle,
} from "./throttle.js";
import {
  evaluateThrottle,
  isSpendDownExpired,
  parseUsage,
  type ThrottleDecision,
  type UsageSnapshot,
} from "./usage.js";
import { abandonConsequence } from "./watchdog.js";
import type { WorkerAdapter } from "./worker.js";
import type { WorkerContainers } from "./worker-container.js";
import {
  BOARD_WORKER_ID,
  buildWorkspaceResolver,
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
  resolveOrQuarantine,
  type WorkspaceConfig,
} from "./workspace.js";

export const HOURLY = 60 * 60 * 1000;

/** candidates を引くのに要る task の断面。queue の行(`BoardTask`)からも引けるので、
 *  pickup のゲートと skipped 表示が同じ関数を共有できる。 */
export type ExecutionCandidateTarget = Pick<Task, "type" | "assignee" | "tier" | "priority" | "review_tier">;
export type TaskExecutionCandidates = (task: ExecutionCandidateTarget) => ExecutionSetting[];

/** この task の entry が**すべて**除外されているか(ADR 0110 決定3 / issue #544)。
 *  scheduler の pickup ゲートも、queue の skipped 表示も、move route の Pickable
 *  head もこの1つの述語を通る —— 「走る」と「skipped と表示する」が退化して
 *  ズレることがない。要求ティアの行を持たない entry は候補に入らないので、候補が
 *  空なのも全 entry 除外である(ADR 0114 決定3: 表の穴は Throttle と同じ除外)。 */
export function allEntriesExcluded(
  task: ExecutionCandidateTarget,
  excluded: ExecutionExclusions,
  candidates?: TaskExecutionCandidates,
): boolean {
  if (!candidates) return false;
  let settings: ExecutionSetting[];
  try {
    settings = candidates(task);
  } catch (error) {
    // 定義が成立していない / registry が知らない assignee。**読み口では投げない**
    // —— 偽である(判定できないものを skipped とは言わない)。scheduler は同じ例外を自分で捕まえて agent を quarantine し、
    // その行は quarantine の枝で skipped として現れる。表示側がここで投げると、
    // 1行の定義違反でキュー全体が 500 になる。
    if (error instanceof UnknownAgentError || error instanceof InvalidAgentDefinitionError) {
      return false;
    }
    throw error;
  }
  return firstSelectable(settings, excluded) === null;
}

/** 「この行は全 entry が除外されているか」を答える述語を、今の除外集合に対して
 *  1つ作る(ADR 0110 決定3)。queue の skipped 表示(`/api/queue` と `list_queue`)
 *  と move route の Pickable head が**同じこの1本**を呼ぶ —— 読み口ごとに同じ
 *  クロージャを書くと、片方だけが古い除外集合を読むようになる。 */
export function entryExclusionPredicate(
  db: Db,
  candidates?: TaskExecutionCandidates,
): (task: ExecutionCandidateTarget) => boolean {
  const excluded = pickupExclusions(db);
  return (task) => allEntriesExcluded(task, excluded, candidates);
}

/** **legacy 経路**の名前集合 —— Provider ごとの usage 観測を持たない盤面
 *  (`taskExecutionCandidates` を配線できない盤面)だけが通る面である。fable 線
 *  (ADR 0030)・provider 認証の quarantine(ADR 0097 決定2)・Harness の封じ込め
 *  (ADR 0098)を agent 名で外す。
 *
 *  **entry を持つ盤面はここを通らない**(ADR 0110 決定3 / issue #544): agent 名で
 *  外すと、別の Provider の entry を持つ agent が道連れになる —— 「全 entry が除外
 *  されて初めて skipped」に反する。そちらは `pickupExclusions` + selector が答える。
 *
 *  Empty normalizes to `undefined`, nextSlotTask's "no exclusion" spelling. */
export function pickupExcludedAssignees(
  db: Db,
  fableBlocked: boolean,
  fableAgents?: () => string[],
  agentsSpeakingProviders?: (providers: readonly Provider[]) => string[],
  agentsUsingHarnesses?: (harnesses: readonly Harness[]) => string[],
): string[] | undefined {
  const fable = fableBlocked && fableAgents ? fableAgents() : [];
  const quarantinedProviders = quarantinedAuthProviders(db);
  const providerExcluded =
    quarantinedProviders.length > 0 && agentsSpeakingProviders
      ? agentsSpeakingProviders(quarantinedProviders)
      : [];
  const harnesses = quarantinedHarnesses(db);
  const harnessExcluded =
    harnesses.length > 0 && agentsUsingHarnesses ? agentsUsingHarnesses(harnesses) : [];
  const all = [...new Set([...fable, ...providerExcluded, ...harnessExcluded])];
  return all.length > 0 ? all : undefined;
}

/** **pickup の除外条件を組む1つの式**(ADR 0110 決定3 / issue #544)。scheduler の
 *  ゲートも queue の skipped 表示も Pickable head の判定も、この集合を selector
 *  (`firstSelectable`)へ渡して同じ答えを得る —— 述語だけでなく、そこへ渡す
 *  引数も1つの式から出す(tasks.ts の「乖離させない」の線)。
 *
 *  agent 名ではなく **entry を外す**のが #544 の要点である: provider 認証の
 *  quarantine も Harness の封じ込めも「その Provider では走れない」であって
 *  「この agent は走れない」ではない —— 別の entry を持つ agent はそちらで走る。
 *
 *  `includeStoredUsage` は「保存された観測を読むか」。scheduler は同じ poll の
 *  中で観測し直すので false で始め、観測のたびにこの集合を育てる。 */
export function pickupExclusions(db: Db, includeStoredUsage = true): ExecutionExclusions {
  const usageResources = includeStoredUsage ? blockedProviderUsageResources(db) : [];
  const harnesses = quarantinedHarnesses(db);
  return {
    providers: [
      ...new Set([
        ...quarantinedAuthProviders(db),
        ...usageResources
          .filter((resource) => resource.model === null)
          .map((resource) => resource.provider),
        ...PROVIDER_VALUES.filter((provider) => harnesses.includes(canonicalHarness(provider))),
      ]),
    ],
    models: usageResources.flatMap((resource) =>
      resource.model === null ? [] : [{ provider: resource.provider, model: resource.model }],
    ),
  };
}

/** 観測された1つの窓を除外集合へ足す(scheduler の poll の中で育つ側)。 */
function withExclusion(
  excluded: ExecutionExclusions,
  provider: Provider,
  model: string | null,
): ExecutionExclusions {
  return model === null
    ? { ...excluded, providers: [...excluded.providers, provider] }
    : { ...excluded, models: [...excluded.models, { provider, model }] };
}

/** ADR 0008: usage only matters at the moment of a pickup decision — a fresh
 *  check every time there is a candidate, never a background poll. Persists
 *  the observation as a side effect so /api/queue reflects it immediately.
 *  オフセットは盤面設定 (ADR 0030) を毎回読む — settings で変えた値が次の
 *  poll から効く。 */
async function checkThrottle(
  db: Db,
  clock: Clock,
  worker: WorkerAdapter,
  cliAuth?: CliAuthCheck,
  persistLegacy = true,
): Promise<{ decision: ThrottleDecision; snapshot: UsageSnapshot }> {
  const resultText = await worker.checkUsage();
  // `null` is deliberately ambiguous (modal, renderer, marker, auth, …).
  // Preserve fail-closed throttle, and raise cliAuth only if a second probe
  // produces the definitive structured 401 evidence (ADR 0070).
  if (resultText === null && cliAuth) {
    try {
      const auth = await cliAuth();
      if (auth.status === "unauthorized") quarantineCliAuthForProvider(db, "anthropic", clock.now());
      else if (auth.status === "unknown") {
        console.warn("[cli-auth] usage failure could not be classified", auth.reason);
      }
    } catch (err) {
      console.warn("[cli-auth] usage failure could not be classified", err);
    }
  }
  const snapshot: UsageSnapshot =
    resultText !== null
      ? parseUsage(resultText, clock.now())
      : { session: null, week: null, fable: null };
  // Spend-down (ADR 0091) も poll ごとに読み、各対象を自分のリセットで失効させる。
  const spendDown = getSpendDown(db);
  for (const window of ["session", "week"] as const) {
    const state = spendDown[window];
    if (state && isSpendDownExpired(window, state, snapshot)) {
      clearSpendDown(db, window);
      spendDown[window] = null;
    }
  }
  const decision = evaluateThrottle(
    snapshot,
    {
      session: getProviderPaceOffset(db, "anthropic", "session"),
      week: getProviderPaceOffset(db, "anthropic", "week"),
      fable: getProviderPaceOffset(db, "anthropic", "fable"),
    },
    clock.now(),
    spendDown,
  );
  if (persistLegacy) reportThrottle(db, decision, clock.now());
  return { decision, snapshot };
}

/** One replace-style timer per Provider/window/model resource. A fresh probe
 * replaces only that window's stale timer, so a second Provider/window cannot
 * erase an earlier catch-up wakeup. */
function createResumeTimers(clock: Clock, onFire: () => void) {
  const timers = new Map<string, () => void>();
  return {
    schedule(resource: string, resumeAt: Date): void {
      timers.get(resource)?.();
      const delay = Math.max(0, resumeAt.getTime() - clock.now().getTime());
      const cancel = clock.setInterval(() => {
        cancel();
        timers.delete(resource);
        onFire();
      }, delay);
      timers.set(resource, cancel);
    },
    cancel(): void {
      for (const cancel of timers.values()) cancel();
      timers.clear();
    },
  };
}

export interface Scheduler {
  stop: () => void;
  /** Immediate poll, fired by human-input-originated queue-head changes.
   *  Same poll as the hourly tick: a no-op while the slot is occupied. */
  pollNow: () => void;
  /** Whether the just-in-time usage observation is currently running. */
  isThrottleRevalidating: () => boolean;
}

/** Hourly poll: if the slot is free, hand the queue head (lowest sort_key todo)
 *  to the worker and mark it in_progress. */
export function startScheduler(deps: {
  db: Db;
  clock: Clock;
  slot: Slot;
  worker: WorkerAdapter;
  /** 盤面側 supervisor(ADR 0099 決定2): pickup が worker session の容器を作る。 */
  containers: WorkerContainers;
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call. Absent → every task runs in the
   *  board's single fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** The board's Auditor pointer (CONTEXT.md / issue #15 layer 2), the
   *  fallback a `review` task's unset assignee resolves to instead of
   *  `worker.id` (issue #42: `nextSlotTask`'s own type-aware gate). Absent →
   *  `DEFAULT_AUDITOR_NAME` — CONTEXT.md's Auditor never reads as unset. */
  auditorName?: string;
  /** The GitHub seam, for the issue-backed pickup gate (issue #49 / ADR
   *  0016's failure taxonomy): an issue-backed head's content is expanded
   *  before pickup, so an expansion failure never wedges a picked-up task.
   *  Absent → the gate is skipped and issue-backed tasks spawn with their
   *  "#N" placeholder (a board with no GitHub seam at all). */
  github?: GitHubClient;
  /** Agent names whose registry model is fable (ADR 0030), read fresh every
   *  poll — the assignee → registry → `model` resolution the fable line
   *  skips tasks by (spawn 時と同じ経路の前倒し)。Absent → no registry
   *  configured, so the fable line can't attribute tasks and skips nothing. */
  fableAgents?: () => string[];
  /** legacy 経路の名前集合(`pickupExcludedAssignees`)。entry を持つ盤面
   *  (`taskExecutionCandidates` あり)では読まない —— agent 名で外すと別 Provider の
   *  entry まで道連れになる(ADR 0110 決定3)。 */
  agentsSpeakingProviders?: (providers: readonly Provider[]) => string[];
  agentsUsingHarnesses?: (harnesses: readonly Harness[]) => string[];
  /** ADR 0098 / issue #454: structured OpenAI subscription observation. */
  openaiUsage?: CodexAppServerProbe;
  /** ADR 0116 決定4: Provider → 資格情報の不在の理由(置かれていれば undefined)。
   *  path の知識は adapter 側にある。載っていない Provider(anthropic)に不在は無い。 */
  credentialAbsence?: Partial<Record<Provider, () => string | undefined>>;
  /** この task が走りうる実行設定を Provider 順位で並べたもの(ADR 0110 決定1/3、
   *  issue #544)。除外は**当てずに**返す —— 除外は同じ poll の中で観測のたびに
   *  育つので、育つたびに selector を引き直すのはこの scheduler の仕事である。
   *  Absent → Provider ごとの usage 観測を持たない盤面(legacy: 盤面全体の
   *  Claude usage と fable 線だけ)。 */
  taskExecutionCandidates?: TaskExecutionCandidates;
  /** ADR 0098: candidate-scoped Harness safety check. A failed Harness is
   *  excluded for this poll while another route remains eligible. legacy 経路
   *  (`taskExecutionCandidates` 不在)だけが使う —— entry 経路では選ばれた
   *  実行設定の Provider から正準 Harness が決まる。 */
  resolveHarness?: (task: Task) => Harness;
  harnessContainment?: HarnessContainmentCheck;
  /** 封じ込め能力の fail-closed ゲート(ADR 0033 / ADR 0036): このホストで
   *  worker の封じ込めが成立しているか。pickup のたびに読み直す(依存の消滅・
   *  AppArmor の変更・認証の脱落を次の poll で拾う)。人間面の自己検査が実 HTTP を
   *  1往復するので非同期。Absent → ゲートそのものを持たない盤面 — 実 CLI を
   *  持たないテストの既定形で、本番の配線(server.ts)は常に実検査を渡す。 */
  containment?: ContainmentCheck;
  /** ADR 0052: refreshes remote main only when a pickup candidate exists. */
  registryReachability?: RegistryReachabilityCheck;
  /** ADR 0070: disambiguates a failed usage observation with a live auth probe. */
  cliAuth?: CliAuthCheck;
  /** ADR 0024 / issue #211: 盤面の GitHub 身元。remote 正本を宣言した workspace の
   *  pickup 直前の fetch(ADR 0052 決定2)がこの名義で撃つ。Absent → 盤面が GitHub
   *  身元を持たない宣言なので fetch は素の git に委ねる —— private な remote なら
   *  そこで失敗し、その workspace の quarantine が人間を呼ぶ。 */
  githubAuth?: GitHubAuth;
  /** ADR 0052 決定3 / issue #211: どの registry clone を読むか + その remote 正本の
   *  宣言。pickup で要るのは、registry clone が workspace としても登録されていると
   *  **2つの宣言**を持ち、その食い違いが quarantine になるからである。Absent →
   *  registry を持たない盤面なので、食い違う相手の宣言そのものが無い。 */
  registry?: RegistrySource;
}): Scheduler {
  const {
    db,
    clock,
    slot,
    worker,
    containers,
    workspace,
    resolveWorkspace,
    auditorName = DEFAULT_AUDITOR_NAME,
    github,
    fableAgents,
    agentsSpeakingProviders,
    agentsUsingHarnesses,
    openaiUsage,
    credentialAbsence,
    taskExecutionCandidates,
    resolveHarness,
    harnessContainment,
    containment,
    registryReachability,
    cliAuth,
    githubAuth,
    registry,
  } = deps;
  let inFlight = false;
  let throttleRevalidating = false;
  const resumeTimer = createResumeTimers(clock, pollNow);
  if (taskExecutionCandidates) db.prepare("DELETE FROM throttle_state").run();

  async function pickupBlocked(): Promise<boolean> {
    if (slot.currentTaskId !== null) return true;
    // ADR 0068 決定5: 同期の短絡は列挙から導出する — triage セッション (issue #6)・
    // Pause (issue #34)・封じ込め能力とレジストリ到達性の**開いている確認
    // question**。停止が1つ増えたとき、増えるのは配線ではなく列挙の1行になる。
    // stored throttle だけは消費しない: scheduler は常に再観測する
    // (ADR 0008 の just-in-time)。
    if (boardHalts(db).some((halt) => halt.kind !== "throttle")) return true;
    // ADR 0033 / ADR 0036: a worker whose containment is not established is not
    // run at all. Unlike the workspace/agent quarantines below this halts the
    // whole board — containment belongs to the host and to the board's own
    // wiring, so no narrower resource can be halted.
    if (containment && (await containmentPickupBlocked(db, containment, clock.now()))) return true;
    // the gate is keyed on each candidate's own execution workspace (issue
    // #26 / ADR 0009) and assignee (ADR 0012 / issue #36), skipped in SQL by
    // nextSlotTask itself — a quarantined workspace or agent halts only its
    // own tasks, never the whole board.
    return !nextSlotTask(db, workspace?.name, worker.id, auditorName);
  }

  /** ADR 0067 決定2 の pickup 側の扉(修復の中身は ADR 0093 決定8)。
   *  `prepareWorkspaceAtPickup` が落ちた瞬間に**1回だけ**、その repo の token を
   *  仲介が出せるかを訊き、出せなければ install の案内を quarantine の理由に連ねる。
   *
   *  訊かない条件は2つで、どちらも今日どおり quarantine に落ちる: `github` 不在
   *  (盤面が GitHub 身元を持たない)と、`repo` が github.com を指していない(非
   *  GitHub の remote / remote 正本の宣言そのものが無い)。
   *
   *  撃ち直しはしない —— install も push 権限も GitHub 側の人間の操作であり、
   *  盤面がこの場で直せる手は無い。 */
  async function quarantineWithRepoAccessGuidance(
    workspace: WorkspaceConfig,
    err: unknown,
  ): Promise<void> {
    // 宣言そのものが無い(`isRemoteBacked` が偽)workspace も、非 GitHub の remote と
    // 同じ `undefined` に落ちる —— どちらもこの扉を持たない
    const ref = parseGitHubRepo(workspace.repo);
    let guidance: string | null = null;
    // 仲介の断りも到達失敗も `tokenRefusal` が理由の文字列に畳むので、ここは投げない
    if (github && ref) guidance = (await repairRepoAccess(github, ref)).guidance;
    // 案内は元の原因を**置き換えず**に連結する —— なぜ落ちたか(生の git のエラー)と
    // 何をすれば直るかは別の情報で、どちらも人間の1つの question に載る
    const cause = guidance
      ? new Error(`${err instanceof Error ? err.message : String(err)}\n\n${guidance}`)
      : err;
    quarantineWorkspace(db, workspace.name, cause, clock.now());
  }

  /** `setting` は selector が pickup の瞬間に選んだ実行設定(ADR 0110 決定3)。
   *  adapter へそのまま運ぶ —— spawn 側で解決し直すと、除外の文脈を持たない再解決が
   *  scheduler と違う entry を選びうる(温存中の Provider で走る)。 */
  async function pickup(task: Task, setting: ExecutionSetting | undefined, content: Partial<TaskContent>): Promise<void> {
    // assignee is never overwritten (ADR 0012 / issue #36) — the event's
    // attribution resolves the same three-value read CONTEXT.md's Assignee
    // describes: pre-set name as-is, unspecified review to the Auditor pointer,
    // and unspecified work to the board's default agent. Questions never enter
    // the execution slot.
    const picked = pickupTask(
      db,
      task,
      resolveTaskAgent(task, worker.id, auditorName ?? worker.id),
      clock.now(),
    );
    slot.occupy(picked.id);
    // ADR 0099 決定2: 容器は盤面が**先に**作る。adapter が spawn に辿り着けな
    // かった pickup でも、force / reclaimed の相手はもう存在している。
    containers.open(picked.id);
    // branch discipline is the board's own, not the worker's: by the time
    // the worker starts, the workspace already sits on the task branch
    const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
    if (resolve) {
      const resolved = resolveOrQuarantine(db, resolve, picked.workspace, clock.now());
      // an unknown workspace name (registry drift) quarantines in place of a
      // thrown error — the task stays wedged in the slot, same deliberate
      // posture as a failed start below, until the watchdog or a human acts
      if (!resolved) return;
      // a branch discipline gap (issue #27: the workspace's configured
      // branch doesn't exist in this checkout) is a resource problem, same
      // as registry drift above — this task still stays wedged in the slot
      // for the watchdog (the picked task itself isn't the failure), but the
      // *workspace* is quarantined immediately rather than surfacing only as
      // a console.error, so a human sees an actionable repair question and
      // no other task aimed at this workspace gets picked up meanwhile.
      // ADR 0052 / issue #211: remote 正本の宣言と実態のずれ、そしてその refresh の
      // 失敗も同じ行き先 —— どれも特定 workspace の性質なので資源単位で止まる
      // ADR 0067 決定2: 失敗した**瞬間**だけが repo アクセスの修復の契機である ——
      // 通れば quarantine すら立たず、直せなければ案内込みで quarantine に落ちる
      try {
        await prepareWorkspaceAtPickup(db, resolved, picked, { githubAuth, registry });
      } catch (err) {
        await quarantineWithRepoAccessGuidance(resolved, err);
        return;
      }
      try {
        worker.start({ ...picked, ...content }, setting);
      } catch (err) {
        console.error(`[scheduler] worker failed to start ${picked.id}:`, err);
      }
      return;
    }
    try {
      worker.start({ ...picked, ...content }, setting);
    } catch (err) {
      // a failed start may not crash the board. The task keeps the slot — the
      // same deliberate wedge as a restart-interrupted task — until the
      // watchdog slice (#9) brings the escalation path.
      console.error(`[scheduler] worker failed to start ${picked.id}:`, err);
    }
  }

  /** The issue-backed pickup gate (issue #49 §5 / ADR 0016): an issue-backed
   *  head's content is expanded *before* pickupTask, so a dead or unreachable
   *  reference never wedges an in_progress task. A 一時的失敗 (network,
   *  GitHub outage) skips this pickup cycle — the same fail-closed
   *  environmental posture as the throttle, no human is called, the next
   *  poll retries. Ordinary tasks pass straight through. Returns the expanded
   *  content the spawn carries (spawn is a use-moment of contentSourceFor —
   *  the "#N" placeholder never reaches the worker or its memory injection),
   *  `{}` for an ordinary task, or null when the pickup may not proceed — a
   *  null from the gone-branch has already registered the failure question as
   *  its side effect. */
  async function issuePickupGate(head: Task): Promise<Partial<TaskContent> | null> {
    if (head.github_issue_number == null || !github) return {};
    const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
    // board-driven async workspace use: registry drift quarantines the name
    // (ADR 0009) and its own pickup gate skips this task from the next poll
    const resolved = resolve && resolveOrQuarantine(db, resolve, head.workspace, clock.now());
    if (resolve && !resolved) return null;
    try {
      return await contentSourceFor(head, github, () => resolved?.path).expand();
    } catch (err) {
      if (err instanceof IssueGoneError) {
        // 確定的失敗 (ADR 0016): the reference is dead for good, not this
        // cycle's weather — the same watchdog-shaped retry/abandon question
        // as failTask, minus the workspace release (nothing was acquired
        // yet). The unanswered question holds the task out of nextSlotTask,
        // so the gate never re-fires for it until a human answers.
        escalateTask(
          db,
          head,
          {
            context:
              `the GitHub issue this task references is gone ` +
              `(${err.reason === "closed" ? "already closed" : "not found"}) — ` +
              `its content cannot be expanded for spawn.\n\n` +
              `"retry" re-reads the issue and restarts this task from the queue head — ` +
              `pick it after reopening or restoring the issue. ` +
              abandonConsequence(db, head),
            questions: [
              {
                title: `issue reference is gone: ${head.title}`,
                options: ["retry", "abandon"],
                recommendation: "retry",
              },
            ],
            cancel_option: "abandon",
          },
          BOARD_WORKER_ID,
          clock.now(),
          "board",
        );
        return null;
      }
      // 一時的失敗: fail-closed, no human — the next poll retries
      console.error(`[scheduler] issue expansion failed for ${head.id}, skipping this cycle:`, err);
      return null;
    }
  }

  async function observeProviderUsage(provider: Provider): Promise<ProviderUsageObservation> {
    const now = clock.now();
    // 不在は question を立てず、observed 以外の除外にそのまま畳まれる(ADR 0116 決定4)。
    // openai では probe より手前 —— 未ログインの盤面で App Server を起動しない
    const absence = credentialAbsence?.[provider]?.();
    if (absence !== undefined) {
      const observation: ProviderUsageObservation = {
        provider,
        status: "absent",
        plan: null,
        cliVersion: null,
        reason: absence,
        observedAt: now,
        windows: [],
      };
      reportProviderUsage(db, observation);
      return observation;
    }
    if (provider === "openai") {
      const result: CodexAppServerProbeResult = openaiUsage
        ? await openaiUsage(now)
        : {
            status: "unobservable",
            provider: "openai",
            cliVersion: null,
            reason: "no OpenAI App Server probe is configured",
          };
      if (result.status !== "observed") {
        const observation: ProviderUsageObservation = {
          provider,
          status: result.status,
          plan: null,
          cliVersion: result.cliVersion,
          reason: result.reason,
          observedAt: now,
          windows: [],
        };
        reportProviderUsage(db, observation);
        if (result.status === "unauthorized") quarantineCliAuthForProvider(db, provider, now);
        return observation;
      }
      return evaluateAndReportProviderUsage(
        db,
        {
          provider,
          status: "observed",
          plan: result.plan,
          cliVersion: result.cliVersion,
          windows: result.windows.map((window) => ({
            window: window.name,
            model: window.model,
            usedPercent: window.usedPercent,
            durationMs: window.durationMs,
            resetsAt: new Date(window.resetsAt),
          })),
        },
        now,
      );
    }
    if (provider === "moonshot") {
      // 保存された absent を上書きする —— queue の skipped 表示は保存された観測を読む
      const observation: ProviderUsageObservation = {
        provider,
        status: "observed",
        plan: null,
        cliVersion: null,
        observedAt: now,
        windows: [],
      };
      reportProviderUsage(db, observation);
      return observation;
    }

    const { decision, snapshot } = await checkThrottle(db, clock, worker, cliAuth, false);
    const definitions = [
      ["session", null, snapshot.session, decision.windows.session, 5 * HOURLY],
      ["week", null, snapshot.week, decision.windows.week, 7 * 24 * HOURLY],
      ["fable", "fable", snapshot.fable, decision.windows.fable, 7 * 24 * HOURLY],
    ] as const;
    const observable = snapshot.session !== null && snapshot.week !== null;
    const observation: ProviderUsageObservation = {
      provider,
      status: observable ? "observed" : "unobservable",
      plan: null,
      cliVersion: null,
      ...(!observable && { reason: "Claude usage windows are unobservable" }),
      observedAt: now,
      windows: definitions.flatMap(([window, model, value, verdict, durationMs]) =>
        value && value !== "idle" && verdict
          ? [
              {
                window,
                model,
                usedPercent: value.percent,
                durationMs,
                resetsAt: value.resetsAt,
                throttled: verdict.throttled,
                resumesAt: verdict.resumeAt,
              },
            ]
          : [],
      ),
    };
    reportProviderUsage(db, observation);
    return observation;
  }

  async function poll(): Promise<void> {
    if (inFlight) return;
    // **`inFlight` は `pickupBlocked` より手前で立てる。** 封じ込め能力の検査が
    // 実 HTTP を1往復するようになった時点(issue #154)で、ここに await 点が
    // できた — 後で立てると、hourly tick と `POST /tasks/:id/move` が同時に
    // ゲートを抜けて二重に pickup し、確認 question も2枚立つ。
    inFlight = true;
    // **`throttleRevalidating` も `pickupBlocked` より手前で立てる。** 同じ gate が
    // 実 HTTP を待つ間、最後の throttle 観測値は stale でありうる。新しい観測へ
    // 向かっている事実を `GET /pause` が先に出せなければ、古い throttle を現在の
    // pickup block と誤読させる(issue #297)。
    throttleRevalidating = true;
    try {
      // ADR 0120 決定2 / ADR 0119: 周期 meta-review の登録は poll の中なので pickup 契機で、候補の
      // 読み取りより前なので同じ pass で拾われる。slot 占有・halt より手前(空の盤面でも登録する)。
      // **同期**に保つ —— ADR 0119 決定5 の「最初の await より前に slot を読む」を崩さない。
      registerDueMetaReviews(db, clock.now());
      // 上位 halt により観測へ至らないなら、再評価中ではない。その halt 自身が
      // `GET /pause` の列挙に現れるので、ここで freshness を降ろす。
      if (await pickupBlocked()) {
        throttleRevalidating = false;
        return;
      }
      let decision: ThrottleDecision | undefined;
      if (!taskExecutionCandidates) {
        decision = (await checkThrottle(db, clock, worker, cliAuth)).decision;
        if (decision.throttled) {
          if (decision.resetsAt) resumeTimer.schedule("legacy", decision.resetsAt);
          throttleRevalidating = false;
          return;
        }
      }
      // fable 線 (ADR 0030) は盤面を止めず、fable モデルのタスクだけを候補から
      // 外す — Quarantine と同じ「資源単位の停止」。entry 経路ではこれは model 窓の
      // 除外として現れるので、agent 名の集合を使うのは legacy 経路だけである。
      const fableWindow = decision?.windows.fable;
      // agent 名で外れるのは、定義が成立しない agent(quarantineAgent)—— と
      // legacy 経路の fable 線 —— だけになった(ADR 0110 決定3 / issue #544)。
      const excluded =
        pickupExcludedAssignees(
          db,
          fableWindow?.throttled ?? false,
          fableAgents,
          taskExecutionCandidates ? undefined : agentsSpeakingProviders,
          taskExecutionCandidates ? undefined : agentsUsingHarnesses,
        ) ?? [];
      // ADR 0110 決定3: 除外が当たるのは**その task の entry**であって agent では
      // ない —— 要求ティアが task ごとに違う以上、agent を丸ごと外すと別のモデルで
      // 走るはずの兄弟まで止まり、別の Provider を持つ entry まで道連れになる。
      const excludedTasks: string[] = [];
      let entryExcluded = pickupExclusions(db, false);
      let head = nextSlotTask(db, workspace?.name, worker.id, auditorName, excluded, excludedTasks);
      const observedProviders = new Map<Provider, ProviderUsageObservation>();
      /** この poll で head を進める1手。SQL の述語へ渡す引数は上の2つだけである。 */
      const nextHead = () =>
        nextSlotTask(db, workspace?.name, worker.id, auditorName, excluded, excludedTasks);
      let chosen: ExecutionSetting | undefined;
      let candidates: ExecutionSetting[] = [];
      while (head) {
        const assignee = resolveTaskAgent(head, worker.id, auditorName);
        if (!taskExecutionCandidates) {
          // legacy 経路: Provider ごとの観測を持たない盤面。Harness の封じ込めだけを
          // agent 単位で見る(entry 経路ではこれも entry の除外条件に畳まれている)。
          if (resolveHarness && harnessContainment) {
            let harness: Harness;
            try {
              harness = resolveHarness(head);
            } catch (error) {
              if (!(error instanceof UnknownAgentError) && !(error instanceof InvalidAgentDefinitionError)) {
                throw error;
              }
              quarantineAgent(db, assignee, error, clock.now());
              excluded.push(assignee);
              head = nextHead();
              continue;
            }
            if (await harnessContainmentPickupBlocked(db, harness, harnessContainment, clock.now())) {
              excluded.push(assignee);
              head = nextHead();
              continue;
            }
          }
          break;
        }
        try {
          candidates = taskExecutionCandidates(head);
        } catch (error) {
          if (!(error instanceof UnknownAgentError) && !(error instanceof InvalidAgentDefinitionError)) {
            throw error;
          }
          quarantineAgent(db, assignee, error, clock.now());
          excluded.push(assignee);
          head = nextHead();
          continue;
        }
        let setting = firstSelectable(candidates, entryExcluded);
        while (setting) {
          if (
            harnessContainment &&
            (await harnessContainmentPickupBlocked(
              db,
              canonicalHarness(setting.provider),
              harnessContainment,
              clock.now(),
            ))
          ) {
            entryExcluded = withExclusion(entryExcluded, setting.provider, null);
            setting = firstSelectable(candidates, entryExcluded);
            continue;
          }
          const observation =
            observedProviders.get(setting.provider) ??
            (await observeProviderUsage(setting.provider));
          observedProviders.set(setting.provider, observation);
          const model = setting.model;
          const relevant = observation.windows.filter(
            // provider 全体の窓(model === null)は常に関係する。model 固有の窓の
            // 照合は除外を当てる側と同じ1つの式を通す(`windowMatchesModel`)——
            // ここに別の式を書くと、保存された観測を読む skipped 表示と同じ poll
            // で観測し直すゲートが、非 fable の model 名で黙ってズレる。
            (window) => window.model === null || windowMatchesModel(window.model, model),
          );
          if (observation.status === "observed" && !relevant.some((window) => window.throttled)) break;
          for (const window of relevant) {
            if (window.throttled && window.resumesAt) {
              resumeTimer.schedule(
                `${setting.provider}:${window.window}:${window.model ?? ""}`,
                window.resumesAt,
              );
            }
          }
          // 観測不能は provider 全体の fail-closed、model 窓はその model だけ
          const providerWide =
            observation.status !== "observed" ||
            relevant.some((window) => window.model === null && window.throttled);
          entryExcluded = withExclusion(entryExcluded, setting.provider, providerWide ? null : model);
          setting = firstSelectable(candidates, entryExcluded);
        }
        if (setting === null) {
          // 全 entry が除外されて初めて、この task は候補から落ちる(ADR 0110 決定3)
          excludedTasks.push(head.id);
          head = nextHead();
          continue;
        }
        chosen = setting;
        break;
      }
      throttleRevalidating = false;
      if (!head) {
        // 候補が fable skip で尽きたなら、fable の catch-up でこの poll を再燃
        // させる — hourly tick 待ちの遊休を作らない(全体線のタイマーと同型)
        if (fableWindow?.throttled && fableWindow.resumeAt) {
          resumeTimer.schedule("legacy:fable", fableWindow.resumeAt);
        }
        return;
      }
      if (
        registryReachability &&
        (await registryReachabilityPickupBlocked(db, registryReachability, clock.now()))
      )
        return;
      const content = await issuePickupGate(head);
      if (!content) return;
      // 学習器の shadow 行(ADR 0110 決定4): work task の pickup ごとに、除外を当てた
      // 候補から「学習器ならこう選ぶ」を引いて selector の選択と並べる。review task は
      // 学習器を参照しない(ADR 0111 決定3)。legacy 経路(`chosen` 無し)は候補の列を
      // 持たないので行も無い。記録は選択に介入しない —— 学習器が倒れても pickup は進む
      if (chosen && head.type === "work") {
        try {
          recordShadow(db, head, selectable(candidates, entryExcluded), chosen, clock.now());
        } catch (err) {
          console.error(`[scheduler] learner shadow row failed for ${head.id}:`, err);
        }
      }
      await pickup(head, chosen, content);
    } finally {
      throttleRevalidating = false;
      inFlight = false;
    }
  }

  function pollNow(): void {
    void poll();
  }

  const cancel = clock.setInterval(pollNow, HOURLY);
  return {
    stop: () => {
      cancel();
      resumeTimer.cancel();
    },
    pollNow,
    isThrottleRevalidating: () => (taskExecutionCandidates ? false : throttleRevalidating),
  };
}
