import type { Clock } from "./clock.js";
import { quarantineContainment } from "./containment.js";
import type { Db } from "./db.js";
import type { Slot } from "./slot.js";
import {
  escalateTask,
  getTask,
  type Task,
  type TaskType,
  unfinishedDecisionSiblingCount,
} from "./tasks.js";
import type { WorkerAdapter } from "./worker.js";
import type { WorkerContainers } from "./worker-container.js";
import {
  BOARD_WORKER_ID,
  buildWorkspaceResolver,
  releaseWorkspace,
  resolveOrQuarantine,
  type WorkspaceConfig,
} from "./workspace.js";

export const WATCHDOG_TICK = 60 * 1000;

/** 強制回収を送ってから回収済み観測を諦めるまで(ADR 0099 決定3)。tick 1本より
 *  十分長く取る — 猶予と同じく「待つ時間」であって、機構の性質ではない。 */
export const RECLAIM_TIMEOUT = 5 * 60 * 1000;

export interface WatchdogConfig {
  /** Absolute wall-clock limit per task type, measured from pickup. A type
   *  without an entry is never watched (v1 has no inactivity detection). */
  timeLimits: Partial<Record<TaskType, number>>;
  /** 畳み込み停止から強制回収までの猶予。 */
  grace: number;
  /** 強制回収から回収済み観測までの上限。省略時 `RECLAIM_TIMEOUT`。 */
  reclaimTimeout?: number;
}

/** 回収済み観測を待って止まっている slot の門(ADR 0099 決定3)。Containment
 *  quarantine の確認回答の受理側(human-verbs)だけがこれを読む。 */
export interface ReclaimStandoff {
  /** 空をまだ観測できていない standoff の task id、無ければ undefined。 */
  pendingReclaim: () => string | undefined;
  /** 空を再観測できた standoff を受理する: slot-release tree rule を走らせ、
   *  slot を解放する。standoff が無い / まだ populated なら no-op。 */
  acceptReclaimed: () => void;
}

export interface Watchdog extends ReclaimStandoff {
  stop: () => void;
}

/** The task's most recent pickup, not its first: a retried task is picked up
 *  again after its earlier kill, and the watchdog must time the new run, not
 *  the original one. */
function pickedUpAt(db: Db, taskId: string): number {
  const row = db
    .prepare(
      "SELECT created_at FROM events WHERE task_id = ? AND kind = 'task_picked_up' ORDER BY id DESC LIMIT 1",
    )
    .get(taskId) as { created_at: string } | undefined;
  return row ? new Date(row.created_at).getTime() : 0;
}

/** Canonical English abandon consequence baked into failure questions
 *  (ADR 0015 / 0048). It states the decision-discard rule and count only when
 *  unfinished same-decision siblings exist. Shared by watchdog and issue-backed
 *  deterministic failures so their wording cannot drift. */
export function abandonConsequence(db: Db, task: Task): string {
  const siblingCount = unfinishedDecisionSiblingCount(db, task);
  return siblingCount > 0
    ? `"abandon" discards this decomposition decision — this task's remaining work plus ` +
        `${siblingCount} unfinished ${siblingCount === 1 ? "sibling" : "siblings"} from the same ` +
        `decomposition decision — and returns the parent to the queue head to replan.`
    : `"abandon" cancels this task and its remaining work.`;
}

/** The failure escalation: a question child in tidepool's own name (the agent
 *  could not self-report), with a standing "retry" option — answering it runs
 *  through the ordinary unblock-to-head path, same as any other escalation. */
export function failTask(
  db: Db,
  task: Task,
  title: string,
  reason: string,
  /** Resolves the failed task's own execution workspace against the registry
   *  (issue #26 / ADR 0009). Build with `buildWorkspaceResolver` — absent
   *  means no workspace tracking at all (a workspaceless caller). */
  resolve: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  now: Date,
): void {
  // the failure question registers first, mirroring an agent's own escalate
  // call; the tree rule runs after, same order as every releasing MCP verb —
  // a tree-rule failure adds its own quarantine question on top, it never
  // replaces the failure question
  escalateTask(
    db,
    task,
    {
      // abandon's consequence is spelled out via abandonConsequence; it's
      // declared via the system-internal cancel_option below, never exposed
      // to agents.
      context:
        `${reason}\n\n` +
        `"retry" restarts this task from scratch at the queue head. ` +
        abandonConsequence(db, task),
      questions: [{ title, options: ["retry", "abandon"], recommendation: "retry" }],
      cancel_option: "abandon",
    },
    BOARD_WORKER_ID,
    now,
    "board",
  );
  if (resolve) {
    const resolved = resolveOrQuarantine(db, resolve, task.workspace, now);
    if (resolved) releaseWorkspace(db, resolved, task, now);
  }
}

/** Process-internal watchdog (#9): an absolute per-type time limit on the
 *  slot task, checked against the injected clock so overruns are
 *  deterministic in tests. 畳み込み停止 at the limit, 強制回収 after grace —
 *  そして**回収済み観測を経てから**、他のエスカレーションと同じ tree rule +
 *  failure question の経路へ進み、slot を解放する(ADR 0099 決定3)。
 *
 *  slot を解放するのは force の送達ではなく容器が空になった観測である。観測
 *  できないまま timeout したときは、失敗の記録(failure question)は残すが
 *  slot は解放せず、Containment quarantine の確認 question が解放の唯一の門に
 *  なる — 残存 process はどの Harness の次の worker とも同じホスト・workspace で
 *  同居しうるので、止められるより狭い資源が存在しない(決定4)。 */
export function startWatchdog(deps: {
  db: Db;
  clock: Clock;
  slot: Slot;
  worker: WorkerAdapter;
  /** 盤面側 supervisor(ADR 0099 決定2)。force と reclaimed はここだけを通る。 */
  containers: WorkerContainers;
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call. Absent → every task fails against the
   *  board's single fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  config: WatchdogConfig;
}): Watchdog {
  const { db, clock, slot, worker, containers, workspace, resolveWorkspace, config } = deps;
  const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
  const reclaimTimeout = config.reclaimTimeout ?? RECLAIM_TIMEOUT;
  // keyed by task id; reset whenever a fresh pickup shows up for that id so a
  // retried run starts its own graceful-stop clock instead of inheriting
  // the previous run's already-tripped state
  const lastSeenPickup = new Map<string, number>();
  const stopSentAt = new Map<string, number>();
  const forceSentAt = new Map<string, number>();
  // 1回の force につき「回収済み観測」と「回収 timeout」のどちらか**一方だけ**が
  // 動く。遅れて届いた空の観測が、既に quarantine へ倒れた slot を黙って解放して
  // しまわないための門でもある(解放の門は確認 question ただ1つ)。
  const settled = new Set<string>();
  let standoff: string | null = null;

  /** 容器が空になった観測。ここで初めて failure question と slot 解放へ進む。 */
  function onReclaimed(taskId: string, limit: number): void {
    if (settled.has(taskId)) return;
    if (slot.currentTaskId !== taskId) return;
    const task = getTask(db, taskId);
    if (!task || task.status !== "in_progress") return;
    settled.add(taskId);
    failTask(
      db,
      task,
      `watchdog killed task: ${task.title}`,
      `the task hit its ${task.type} time limit (${limit}ms) and its worker container was ` +
        `reclaimed (graceful stop, then force reclaim after ${config.grace}ms grace). ` +
        "No self-report is possible.",
      resolve,
      clock.now(),
    );
    slot.release();
  }

  /** 空を観測できないまま timeout。失敗の記録は残すが slot は解放しない —
   *  tree rule も走らせない(まだ生きている process が書いている作業ツリーを
   *  退避しても、退避そのものが競合する)。 */
  function onReclaimTimeout(task: Task, limit: number): void {
    settled.add(task.id);
    standoff = task.id;
    failTask(
      db,
      task,
      `watchdog killed task: ${task.title}`,
      `the task hit its ${task.type} time limit (${limit}ms) and its worker container was ` +
        `force-reclaimed, but the board could not observe the container going empty within ` +
        `${reclaimTimeout}ms. No self-report is possible.`,
      // tree rule はここでは走らない: slot が解放される瞬間 — 確認 question の
      // 受理 — まで待つ(ADR 0099 決定3 / CONTEXT.md「Slot-release tree rule」)
      undefined,
      clock.now(),
    );
    quarantineContainment(
      db,
      `the worker container for task ${task.id} was force-reclaimed but never observed empty, ` +
        "so processes from that session may still be running against this host and its " +
        "workspaces (ADR 0099). The execution slot stays occupied until this is answered",
      clock.now(),
    );
  }

  function tick(): void {
    const taskId = slot.currentTaskId;
    if (taskId === null) return;
    const task = getTask(db, taskId);
    if (!task || task.status !== "in_progress") return;
    const limit = config.timeLimits[task.type];
    if (limit === undefined) return;

    const pickup = pickedUpAt(db, taskId);
    if (lastSeenPickup.get(taskId) !== pickup) {
      lastSeenPickup.set(taskId, pickup);
      stopSentAt.delete(taskId);
      forceSentAt.delete(taskId);
      settled.delete(taskId);
    }
    if (settled.has(taskId)) return;

    const now = clock.now().getTime();
    const forcedAt = forceSentAt.get(taskId);
    if (forcedAt !== undefined) {
      // 送達は済んでいる。ここから先を進めるのは観測だけで、tick は timeout を
      // 数えるためだけに回る。
      if (now - forcedAt >= reclaimTimeout) onReclaimTimeout(task, limit);
      return;
    }
    const stoppedAt = stopSentAt.get(taskId);
    if (stoppedAt === undefined) {
      if (now - pickup >= limit) {
        worker.gracefulStop(taskId);
        stopSentAt.set(taskId, now);
      }
      return;
    }
    if (now - stoppedAt >= config.grace) {
      forceSentAt.set(taskId, now);
      containers.forceReclaim(taskId);
      void containers.reclaimed(taskId).then(() => onReclaimed(taskId, limit));
    }
  }

  const cancel = clock.setInterval(tick, WATCHDOG_TICK);
  return {
    stop: cancel,
    pendingReclaim: () =>
      standoff !== null && containers.pendingReclaims().includes(standoff) ? standoff : undefined,
    acceptReclaimed: () => {
      if (standoff === null) return;
      // 「検査を回答時にもう一度走らせる」— 呼び出し側も先に見ているが、受理の
      // 直前でもう一度読む(1資源1枚の quarantine と同じ posture)
      if (containers.pendingReclaims().includes(standoff)) return;
      const task = getTask(db, standoff);
      standoff = null;
      // slot が解放される瞬間に tree rule が走る、の対を閉じる(CONTEXT.md
      // 「Slot-release tree rule」)— 回収 timeout の時点では走らせていない
      if (task && resolve) {
        const resolved = resolveOrQuarantine(db, resolve, task.workspace, clock.now());
        if (resolved) releaseWorkspace(db, resolved, task, clock.now());
      }
      slot.release();
    },
  };
}
