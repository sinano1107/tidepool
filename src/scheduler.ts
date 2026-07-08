import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { Slot } from "./slot.js";
import { nextSlotTask, pickupTask } from "./tasks.js";
import { activeTriageSession } from "./triage.js";
import type { WorkerAdapter } from "./worker.js";
import { ensureTaskBranch, workspaceNeedsHuman, type WorkspaceConfig } from "./workspace.js";

export const HOURLY = 60 * 60 * 1000;

export interface Scheduler {
  stop: () => void;
  /** Immediate poll, fired by human-input-originated queue-head changes.
   *  Same poll as the hourly tick: a no-op while the slot is occupied. */
  pollNow: () => void;
}

/** Hourly poll: if the slot is free, hand the queue head (lowest sort_key todo)
 *  to the worker and mark it in_progress. */
export function startScheduler(deps: {
  db: Db;
  clock: Clock;
  slot: Slot;
  worker: WorkerAdapter;
  workspace?: WorkspaceConfig;
}): Scheduler {
  const { db, clock, slot, worker, workspace } = deps;

  function poll(): void {
    if (slot.currentTaskId !== null) return;
    // triage pauses pickup: the human is re-steering the queue, so nothing
    // new enters the slot until the session commits (issue #6)
    if (activeTriageSession(db)) return;
    // a quarantined workspace halts its tasks — with the board-level single
    // workspace, that is every slot task (issue #8)
    if (workspace && workspaceNeedsHuman(db, workspace.name)) return;
    const head = nextSlotTask(db);
    if (!head) return;
    const picked = pickupTask(db, head, worker.id, clock.now());
    slot.occupy(picked.id);
    try {
      // branch discipline is the board's own, not the worker's: by the time
      // the worker starts, the workspace already sits on the task branch
      if (workspace) ensureTaskBranch(workspace, picked.id);
      worker.start(picked);
    } catch (err) {
      // a failed start may not crash the board. The task keeps the slot — the
      // same deliberate wedge as a restart-interrupted task — until the
      // watchdog slice (#9) brings the escalation path.
      console.error(`[scheduler] worker failed to start ${picked.id}:`, err);
    }
  }

  const cancel = clock.setInterval(poll, HOURLY);
  return { stop: cancel, pollNow: poll };
}
