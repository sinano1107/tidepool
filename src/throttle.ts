import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import type { Slot } from "./slot.js";
import { getTask, moveTask, type Task } from "./tasks.js";
import { BOARD_WORKER_ID, releaseWorkspace, type WorkspaceConfig } from "./workspace.js";

/** Swell throttle (issue #10): a usage-limit hit is an environmental event to
 *  recover from, not a failure — account-scoped (CONTEXT.md's Usage limit),
 *  never attributed to a task. */
export interface ThrottleEvent {
  state: "rejected" | "allowed_warning";
  /** When the account is expected to recover, if the adapter reported one. */
  resetsAt: Date | null;
  utilization?: number | null;
}

export function reportThrottle(db: Db, event: ThrottleEvent): void {
  db.prepare(
    `INSERT INTO throttle_state (id, state, resets_at, utilization) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, resets_at = excluded.resets_at,
       utilization = excluded.utilization`,
  ).run(event.state, event.resetsAt?.toISOString() ?? null, event.utilization ?? null);
}

interface ThrottleStateRow {
  state: "rejected" | "allowed_warning";
  resets_at: string | null;
}

function readThrottleState(db: Db): ThrottleStateRow | undefined {
  return db.prepare("SELECT state, resets_at FROM throttle_state WHERE id = 1").get() as
    | ThrottleStateRow
    | undefined;
}

/** A missing resets_at means the adapter reported without a known recovery
 *  time, so the row stays active until a fresher report arrives. */
function activeBefore(row: ThrottleStateRow | undefined, now: Date): boolean {
  if (!row) return false;
  if (!row.resets_at) return true;
  return now.getTime() < new Date(row.resets_at).getTime();
}

/** Both rejected and allowed_warning stop new pickup until resets_at. Neither
 *  state touches a task already in the slot (PRD: allowed_warning lets the
 *  current task finish; a mid-run rejected is handled separately). */
export function isPickupBlocked(db: Db, now: Date): boolean {
  return activeBefore(readThrottleState(db), now);
}

/** Only a hard rejected — never allowed_warning — interrupts a task already
 *  in the slot (PRD: a warning lets the current task finish). */
function isRejectedActive(db: Db, now: Date): boolean {
  const row = readThrottleState(db);
  if (!row || row.state !== "rejected") return false;
  return activeBefore(row, now);
}

/** A mid-run rejected (PRD): the same tree-rule WIP evacuation as a watchdog
 *  kill, but deliberately no failure question — a usage limit is environmental
 *  recovery, not a failure, so escalation/failure statistics stay untouched.
 *  The task returns to `todo` at the queue head, same as a retried failure,
 *  so its own existing branch is simply checked out again on the next pickup.
 *  Order matches `failTask` (watchdog.ts): the DB-side transition registers
 *  first, the tree rule (filesystem/git, outside SQL) runs after — a tree-rule
 *  failure quarantines on top of an already-recorded state, never blocks it. */
function interruptForThrottle(
  db: Db,
  task: Task,
  workspace: WorkspaceConfig | undefined,
  now: Date,
): void {
  db.transaction(() => {
    const resetsAt = readThrottleState(db)?.resets_at ?? null;
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(task.id);
    appendEvent(db, {
      taskId: task.id,
      workerId: BOARD_WORKER_ID,
      payload: { kind: "worker_throttled", resets_at: resetsAt },
      at: now,
    });
    moveTask(db, getTask(db, task.id)!, null, now, BOARD_WORKER_ID);
  })();
  if (workspace) releaseWorkspace(db, workspace, task.id, now);
}

export const THROTTLE_TICK = 60 * 1000;

export interface ThrottleWatch {
  stop: () => void;
}

/** Reset never waits for the hourly scheduler tick (PRD: "reset 時に即時ポーリ
 *  ング") — a short tick watches for the blocked→unblocked edge and pollNow()s
 *  right there. Edge-triggered, not "poll every tick": the hourly cadence is
 *  the scheduler's own contract everywhere else, and this must not shorten it.
 *  The same tick also evacuates a task the slot is holding the moment a hard
 *  rejected becomes active (PRD's mid-run rejected path). */
export function startThrottleWatch(deps: {
  db: Db;
  clock: Clock;
  slot: Slot;
  scheduler: { pollNow: () => void };
  workspace?: WorkspaceConfig;
}): ThrottleWatch {
  const { db, clock, slot, scheduler, workspace } = deps;
  let wasBlocked = false;
  function tick(): void {
    const now = clock.now();
    const taskId = slot.currentTaskId;
    if (taskId !== null && isRejectedActive(db, now)) {
      const task = getTask(db, taskId);
      if (task && task.status === "in_progress") {
        interruptForThrottle(db, task, workspace, now);
        slot.release();
      }
    }
    const blocked = isPickupBlocked(db, now);
    if (wasBlocked && !blocked) scheduler.pollNow();
    wasBlocked = blocked;
  }
  const cancel = clock.setInterval(tick, THROTTLE_TICK);
  return { stop: cancel };
}
