import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { Slot } from "./slot.js";
import { pickupTask, type Task } from "./tasks.js";
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
    // blocked is derived from parent/child alone: a task with a child not
    // done/cancelled never enters the slot. Questions never enter it either:
    // they are human tasks, answered outside the slot (WebUI).
    const head = db
      .prepare(
        `SELECT * FROM tasks t
         WHERE t.status = 'todo'
           AND t.type <> 'question'
           AND NOT EXISTS (
             SELECT 1 FROM tasks c
             WHERE c.parent_id = t.id AND c.status NOT IN ('done', 'cancelled')
           )
         ORDER BY t.sort_key LIMIT 1`,
      )
      .get() as Task | undefined;
    if (!head) return;
    const picked = pickupTask(db, head, worker.id, clock.now());
    slot.occupy(picked.id);
    worker.start(picked);
  }

  const cancel = clock.setInterval(poll, HOURLY);
  return { stop: cancel, pollNow: poll };
}
