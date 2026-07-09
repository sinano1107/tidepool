import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { Slot } from "./slot.js";
import { nextSlotTask, pickupTask } from "./tasks.js";
import { reportThrottle } from "./throttle.js";
import { activeTriageSession } from "./triage.js";
import { evaluateThrottle, parseUsage, type UsageSnapshot } from "./usage.js";
import type { WorkerAdapter } from "./worker.js";
import { ensureTaskBranch, workspaceNeedsHuman, type WorkspaceConfig } from "./workspace.js";

export const HOURLY = 60 * 60 * 1000;

const DEFAULT_USAGE_THRESHOLD = 80;

function usageThreshold(): number {
  return Number(process.env.TIDEPOOL_USAGE_THRESHOLD ?? DEFAULT_USAGE_THRESHOLD);
}

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
  let inFlight = false;
  // single, replace-style handle (ADR 0008): a fresh skip re-arms this every
  // poll while still throttled, so it must never stack duplicates
  let resetTimerCancel: (() => void) | null = null;

  function scheduleResetTimer(resetsAt: Date): void {
    resetTimerCancel?.();
    const delay = Math.max(0, resetsAt.getTime() - clock.now().getTime());
    const cancel = clock.setInterval(() => {
      cancel();
      resetTimerCancel = null;
      pollNow();
    }, delay);
    resetTimerCancel = cancel;
  }

  async function poll(): Promise<void> {
    if (inFlight) return;
    if (slot.currentTaskId !== null) return;
    // triage pauses pickup: the human is re-steering the queue, so nothing
    // new enters the slot until the session commits (issue #6)
    if (activeTriageSession(db)) return;
    // a quarantined workspace halts its tasks — with the board-level single
    // workspace, that is every slot task (issue #8)
    if (workspace && workspaceNeedsHuman(db, workspace.name)) return;
    if (!nextSlotTask(db)) return;
    inFlight = true;
    try {
      // ADR 0008: usage only matters at the moment of a pickup decision — a
      // fresh check every time there is a candidate, never a background poll
      const resultText = await worker.checkUsage();
      const snapshot: UsageSnapshot =
        resultText !== null ? parseUsage(resultText, clock.now()) : { session: null, week: null };
      const decision = evaluateThrottle(snapshot, usageThreshold());
      reportThrottle(db, decision);
      if (decision.throttled) {
        if (decision.resetsAt) scheduleResetTimer(decision.resetsAt);
        return;
      }
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
      resetTimerCancel?.();
    },
    pollNow,
  };
}
