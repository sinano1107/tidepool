import type { Db } from "./db.js";
import type { ThrottleDecision } from "./usage.js";

/** Persists the scheduler's last just-in-time /usage decision (ADR 0008): a
 *  single `throttled` state, superseding #10's `rejected`/`allowed_warning`
 *  pair — a percentage threshold has only one boundary to cross, not two. */
export function reportThrottle(db: Db, decision: ThrottleDecision): void {
  db.prepare(
    `INSERT INTO throttle_state (id, throttled, resets_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET throttled = excluded.throttled, resets_at = excluded.resets_at`,
  ).run(decision.throttled ? 1 : 0, decision.resetsAt?.toISOString() ?? null);
}

interface ThrottleStateRow {
  throttled: number;
  resets_at: string | null;
}

function readThrottleState(db: Db): ThrottleStateRow | undefined {
  return db.prepare("SELECT throttled, resets_at FROM throttle_state WHERE id = 1").get() as
    | ThrottleStateRow
    | undefined;
}

/** No row means no /usage check has ever run — normal (unthrottled). A row
 *  with no resets_at is a parse failure (fail-closed): stays active until a
 *  fresher report arrives, since there is no known recovery time to wait out. */
export function isPickupBlocked(db: Db, now: Date): boolean {
  const row = readThrottleState(db);
  if (!row || !row.throttled) return false;
  if (!row.resets_at) return true;
  return now.getTime() < new Date(row.resets_at).getTime();
}

export interface ThrottleState {
  throttled: boolean;
  resetsAt: string | null;
}

/** Raw throttle_state for display (issue #82): unlike isPickupBlocked, this
 *  doesn't resolve a passed resets_at back to false — the human sees the last
 *  reported state as-is until the next poll refreshes it. */
export function getThrottleState(db: Db): ThrottleState {
  const row = readThrottleState(db);
  if (!row) return { throttled: false, resetsAt: null };
  return { throttled: !!row.throttled, resetsAt: row.resets_at };
}
