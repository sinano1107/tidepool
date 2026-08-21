import { boardHalts } from "./board-halt.js";
import { type CliAuthCheck, quarantineCliAuth } from "./cli-auth.js";
import type { Clock } from "./clock.js";
import { type ContainmentCheck, containmentPickupBlocked } from "./containment.js";
import type { Db } from "./db.js";
import { type GitHubClient, IssueGoneError } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import { getPaceOffsets } from "./pace-offsets.js";
import type { RegistryReachabilityCheck, RegistrySource } from "./registry.js";
import { registryReachabilityPickupBlocked } from "./registry-reachability.js";
import { parseGitHubRepo, type RepoAccessRepair, repairRepoAccess } from "./repo-access.js";
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
} from "./tasks.js";
import { reportThrottle } from "./throttle.js";
import {
  evaluateThrottle,
  isSpendDownExpired,
  parseUsage,
  type ThrottleDecision,
  type UsageSnapshot,
} from "./usage.js";
import { abandonConsequence } from "./watchdog.js";
import type { WorkerAdapter } from "./worker.js";
import {
  BOARD_WORKER_ID,
  buildWorkspaceResolver,
  noteOnWorkspaceQuarantine,
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
  resolveOrQuarantine,
  type WorkspaceConfig,
} from "./workspace.js";

export const HOURLY = 60 * 60 * 1000;

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
): Promise<ThrottleDecision> {
  const resultText = await worker.checkUsage();
  // `null` is deliberately ambiguous (modal, renderer, marker, auth, …).
  // Preserve fail-closed throttle, and raise cliAuth only if a second probe
  // produces the definitive structured 401 evidence (ADR 0070).
  if (resultText === null && cliAuth) {
    try {
      const auth = await cliAuth();
      if (auth.status === "unauthorized") quarantineCliAuth(db, clock.now());
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
  const decision = evaluateThrottle(snapshot, getPaceOffsets(db), clock.now(), spendDown);
  reportThrottle(db, decision, clock.now());
  return decision;
}

/** A single, replace-style one-shot timer (ADR 0008): scheduling while
 *  already armed cancels the stale handle first, so a fresh skip re-arming
 *  every poll never stacks duplicates. ADR 0030 arms it at the catch-up
 *  instant (再開見込み時刻), not the window reset — waiting for the reset
 *  plus the hourly tick would leak up to ~1h of idle pace every cycle. */
function createResumeTimer(clock: Clock, onFire: () => void) {
  let cancelCurrent: (() => void) | null = null;
  return {
    schedule(resumeAt: Date): void {
      cancelCurrent?.();
      const delay = Math.max(0, resumeAt.getTime() - clock.now().getTime());
      const cancel = clock.setInterval(() => {
        cancel();
        cancelCurrent = null;
        onFire();
      }, delay);
      cancelCurrent = cancel;
    },
    cancel(): void {
      cancelCurrent?.();
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
    workspace,
    resolveWorkspace,
    auditorName = DEFAULT_AUDITOR_NAME,
    github,
    fableAgents,
    containment,
    registryReachability,
    cliAuth,
    githubAuth,
    registry,
  } = deps;
  let inFlight = false;
  let throttleRevalidating = false;
  const resumeTimer = createResumeTimer(clock, pollNow);

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

  /** ADR 0067 決定2 の pickup 側の扉。`prepareWorkspaceAtPickup` が落ちた瞬間に**1回
   *  だけ**修復を試み、pickup を続けてよいかを返す。
   *
   *  撃たない条件は2つで、どちらも今日どおり quarantine に落ちる: `github` 不在
   *  (盤面が GitHub 身元を持たない)と、`repo` が github.com を指していない(非
   *  GitHub の remote / remote 正本の宣言そのものが無い)。
   *
   *  撃ち直すのは**受諾が1件でも起きたときだけ**である。何も変わっていないのに
   *  再試行するのは、正常時の呼び出しを増やさないという不変条件の裏側を破る。 */
  async function repairRepoAccessAtPickup(
    workspace: WorkspaceConfig,
    task: Task,
    err: unknown,
  ): Promise<boolean> {
    // 宣言そのものが無い(`isRemoteBacked` が偽)workspace も、非 GitHub の remote と
    // 同じ `undefined` に落ちる —— どちらもこの扉を持たない
    const ref = parseGitHubRepo(workspace.repo);
    let repair: RepoAccessRepair | null = null;
    if (github && ref) {
      try {
        repair = await repairRepoAccess(github, ref);
      } catch (probeErr) {
        // probe 自身の失敗(タイムアウト、gh の異常終了)は元の原因を置き換えない ——
        // 人間が読むべきは fetch がなぜ落ちたかである
        console.error(`[scheduler] repo access probe failed for ${workspace.name}:`, probeErr);
      }
    }
    if (repair?.accepted && !repair.guidance) {
      try {
        await prepareWorkspaceAtPickup(db, workspace, task, { githubAuth, registry });
        return true;
      } catch (retryErr) {
        err = retryErr;
      }
    }
    // 案内は元の原因を**置き換えず**に連結する —— なぜ落ちたか(生の git のエラー)と
    // 何をすれば直るかは別の情報で、どちらも人間の1つの question に載る
    const guidance = repair?.guidance;
    const cause = guidance
      ? new Error(`${err instanceof Error ? err.message : String(err)}\n\n${guidance}`)
      : err;
    quarantineWorkspace(db, workspace.name, cause, clock.now());
    // ADR 0067 決定7: 受諾した事実は、いま立った(あるいは既にあった)確認 question の
    // イベントとして残す —— 受諾専用の面は作らない
    if (repair?.accepted) {
      noteOnWorkspaceQuarantine(
        db,
        workspace.name,
        `accepted a pending repository invitation to ${workspace.repo}`,
        clock.now(),
      );
    }
    return false;
  }

  async function pickup(task: Task): Promise<void> {
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
        if (!(await repairRepoAccessAtPickup(resolved, picked, err))) return;
      }
      try {
        worker.start(picked);
      } catch (err) {
        console.error(`[scheduler] worker failed to start ${picked.id}:`, err);
      }
      return;
    }
    try {
      worker.start(picked);
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
   *  poll retries. Ordinary tasks pass straight through. Returns whether the
   *  pickup may proceed — a false from the gone-branch has already registered
   *  the failure question as its side effect. */
  async function issuePickupGate(head: Task): Promise<boolean> {
    if (head.github_issue_number == null || !github) return true;
    const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
    // board-driven async workspace use: registry drift quarantines the name
    // (ADR 0009) and its own pickup gate skips this task from the next poll
    const resolved = resolve && resolveOrQuarantine(db, resolve, head.workspace, clock.now());
    if (resolve && !resolved) return false;
    try {
      await contentSourceFor(head, github, () => resolved?.path).expand();
      return true;
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
        return false;
      }
      // 一時的失敗: fail-closed, no human — the next poll retries
      console.error(`[scheduler] issue expansion failed for ${head.id}, skipping this cycle:`, err);
      return false;
    }
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
      // 上位 halt により観測へ至らないなら、再評価中ではない。その halt 自身が
      // `GET /pause` の列挙に現れるので、ここで freshness を降ろす。
      if (await pickupBlocked()) {
        throttleRevalidating = false;
        return;
      }
      let decision: ThrottleDecision;
      try {
        decision = await checkThrottle(db, clock, worker, cliAuth);
      } finally {
        throttleRevalidating = false;
      }
      if (decision.throttled) {
        if (decision.resetsAt) resumeTimer.schedule(decision.resetsAt);
        return;
      }
      // fable 線 (ADR 0030) は盤面を止めず、fable モデルのタスクだけを候補から
      // 外す — Quarantine と同じ「資源単位の停止」。
      const fableWindow = decision.windows.fable;
      const excludedAssignees =
        fableWindow?.throttled && fableAgents ? fableAgents() : undefined;
      const head = nextSlotTask(db, workspace?.name, worker.id, auditorName, excludedAssignees);
      if (!head) {
        // 候補が fable skip で尽きたなら、fable の catch-up でこの poll を再燃
        // させる — hourly tick 待ちの遊休を作らない(全体線のタイマーと同型)
        if (fableWindow?.throttled && fableWindow.resumeAt) resumeTimer.schedule(fableWindow.resumeAt);
        return;
      }
      if (
        registryReachability &&
        (await registryReachabilityPickupBlocked(db, registryReachability, clock.now()))
      )
        return;
      if (!(await issuePickupGate(head))) return;
      await pickup(head);
    } finally {
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
    isThrottleRevalidating: () => throttleRevalidating,
  };
}
