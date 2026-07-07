import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { Slot } from "./slot.js";
import { nextSlotTask, pickupTask } from "./tasks.js";
import type { WorkerAdapter } from "./worker.js";

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
}): Scheduler {
  const { db, clock, slot, worker } = deps;

  function poll(): void {
    if (slot.currentTaskId !== null) return;
    const head = nextSlotTask(db);
    if (!head) return;
    const picked = pickupTask(db, head, worker.id, clock.now());
    slot.occupy(picked.id);
    worker.start(picked);
  }

  const cancel = clock.setInterval(poll, HOURLY);
  return { stop: cancel, pollNow: poll };
}
