import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { Slot } from "./slot.js";
import { escalateTask, getTask, type Task, type TaskType } from "./tasks.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import { BOARD_WORKER_ID, releaseWorkspace, type WorkspaceConfig } from "./workspace.js";

export const WATCHDOG_TICK = 60 * 1000;

export interface WatchdogConfig {
  /** Absolute wall-clock limit per task type, measured from pickup. A type
   *  without an entry is never watched (v1 has no inactivity detection). */
  timeLimits: Partial<Record<TaskType, number>>;
  /** Gap between SIGTERM and SIGKILL. */
  grace: number;
}

export interface Watchdog {
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

/** The failure escalation: a question child in tidepool's own name (the agent
 *  could not self-report), with a standing "retry" option — answering it runs
 *  through the ordinary unblock-to-head path, same as any other escalation. */
export function failTask(
  db: Db,
  task: Task,
  title: string,
  reason: string,
  workspace: WorkspaceConfig | undefined,
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
      title,
      // the option label alone ("abandon") can't carry what it does, so the
      // consequence is spelled out here — this is the only human-visible
      // surface for it (ADR 0006's implementation note); it's declared via
      // the system-internal cancel_option below, never exposed to agents.
      context:
        `${reason}\n\n` +
        `"retry" restarts this task from scratch at the queue head. ` +
        `"abandon" discards the rest of this plan — this task's remaining ` +
        `work plus its parent's other unfinished children — and returns the ` +
        `parent to the queue head to replan.`,
      options: ["retry", "abandon"],
      recommendation: "retry",
      cancel_option: "abandon",
    },
    BOARD_WORKER_ID,
    now,
  );
  if (workspace) releaseWorkspace(db, workspace, task.id, now);
}

/** Process-internal watchdog (#9): an absolute per-type time limit on the
 *  slot task, checked against the injected clock so overruns are
 *  deterministic in tests. SIGTERM at the limit, SIGKILL after grace — then
 *  the same tree rule + failure-question path as any other escalation, and
 *  the slot is freed so a stuck session never wedges the board. */
export function startWatchdog(deps: {
  db: Db;
  clock: Clock;
  slot: Slot;
  worker: WorkerAdapter;
  workspace?: WorkspaceConfig;
  config: WatchdogConfig;
}): Watchdog {
  const { db, clock, slot, worker, workspace, config } = deps;
  // keyed by task id; reset whenever a fresh pickup shows up for that id so a
  // retried run starts its own SIGTERM/SIGKILL clock instead of inheriting
  // the previous run's already-tripped state
  const lastSeenPickup = new Map<string, number>();
  const sigtermSentAt = new Map<string, number>();
  const sigkillSent = new Set<string>();

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
      sigtermSentAt.delete(taskId);
      sigkillSent.delete(taskId);
    }
    if (sigkillSent.has(taskId)) return;

    const now = clock.now().getTime();
    const sentAt = sigtermSentAt.get(taskId);
    if (sentAt === undefined) {
      if (now - pickup >= limit) {
        worker.kill(taskId, "SIGTERM" satisfies KillSignal);
        sigtermSentAt.set(taskId, now);
      }
      return;
    }
    if (now - sentAt >= config.grace) {
      worker.kill(taskId, "SIGKILL" satisfies KillSignal);
      sigkillSent.add(taskId);
      failTask(
        db,
        task,
        `watchdog killed task: ${task.title}`,
        `the task hit its ${task.type} time limit (${limit}ms) and was terminated ` +
          `(SIGTERM, then SIGKILL after ${config.grace}ms grace). No self-report is possible.`,
        workspace,
        clock.now(),
      );
      slot.release();
    }
  }

  const cancel = clock.setInterval(tick, WATCHDOG_TICK);
  return { stop: cancel };
}
