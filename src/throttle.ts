import type { Db } from "./db.js";
import type { ThrottleDecision, WindowDecision } from "./usage.js";

/** Persists the scheduler's last just-in-time /usage decision (ADR 0008),
 *  extended by ADR 0030 with the per-window pace verdicts: which line is hit
 *  and its catch-up instant. A NULL *_throttled column records that the
 *  window went unobserved (fail-closed input), distinct from "not throttled". */
export function reportThrottle(db: Db, decision: ThrottleDecision): void {
  db.prepare(
    `INSERT INTO throttle_state (
       id, throttled, resets_at,
       session_throttled, session_resume_at, week_throttled, week_resume_at,
       fable_throttled, fable_resume_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       throttled = excluded.throttled,
       resets_at = excluded.resets_at,
       session_throttled = excluded.session_throttled,
       session_resume_at = excluded.session_resume_at,
       week_throttled = excluded.week_throttled,
       week_resume_at = excluded.week_resume_at,
       fable_throttled = excluded.fable_throttled,
       fable_resume_at = excluded.fable_resume_at`,
  ).run(
    decision.throttled ? 1 : 0,
    decision.resetsAt?.toISOString() ?? null,
    ...windowColumns(decision.windows.session),
    ...windowColumns(decision.windows.week),
    ...windowColumns(decision.windows.fable),
  );
}

function windowColumns(w: WindowDecision | null): [number | null, string | null] {
  if (!w) return [null, null];
  return [w.throttled ? 1 : 0, w.resumeAt?.toISOString() ?? null];
}

interface ThrottleStateRow {
  throttled: number;
  resets_at: string | null;
  session_throttled: number | null;
  session_resume_at: string | null;
  week_throttled: number | null;
  week_resume_at: string | null;
  fable_throttled: number | null;
  fable_resume_at: string | null;
}

function readThrottleState(db: Db): ThrottleStateRow | undefined {
  return db
    .prepare(
      `SELECT throttled, resets_at,
              session_throttled, session_resume_at, week_throttled, week_resume_at,
              fable_throttled, fable_resume_at
       FROM throttle_state WHERE id = 1`,
    )
    .get() as ThrottleStateRow | undefined;
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

/** One window's last-observed pace verdict, for display: null when the
 *  window went unobserved. resumeAt is the catch-up instant (ADR 0030), not
 *  the window's reset time. */
export interface WindowThrottleState {
  throttled: boolean;
  resumeAt: string | null;
}

/** The fable line's own isPickupBlocked (ADR 0030): true while the last
 *  observation has fable over its pace line and the catch-up instant hasn't
 *  passed. Unlike the board-wide gate this blocks only fable-model tasks —
 *  the caller applies it per task. A missing fable observation (NULL column)
 *  is "no per-model limit", never blocked. */
export function isFablePickupBlocked(db: Db, now: Date): boolean {
  const row = readThrottleState(db);
  if (!row || !row.fable_throttled) return false;
  if (!row.fable_resume_at) return true;
  return now.getTime() < new Date(row.fable_resume_at).getTime();
}

export interface ThrottleState {
  throttled: boolean;
  resetsAt: string | null;
  windows: {
    session: WindowThrottleState | null;
    week: WindowThrottleState | null;
    /** fable の null は「個別制限の観測なし」(Pro プラン等)— session/week の
     *  null(観測不能 = fail-closed)とは意味が違う (ADR 0030)。 */
    fable: WindowThrottleState | null;
  };
}

function windowState(throttled: number | null, resumeAt: string | null): WindowThrottleState | null {
  if (throttled === null) return null;
  return { throttled: !!throttled, resumeAt };
}

/** Raw throttle_state for display (issue #82): unlike isPickupBlocked, this
 *  doesn't resolve a passed resets_at back to false — the human sees the last
 *  reported state as-is until the next poll refreshes it. */
export function getThrottleState(db: Db): ThrottleState {
  const row = readThrottleState(db);
  if (!row) {
    return {
      throttled: false,
      resetsAt: null,
      windows: { session: null, week: null, fable: null },
    };
  }
  return {
    throttled: !!row.throttled,
    resetsAt: row.resets_at,
    windows: {
      session: windowState(row.session_throttled, row.session_resume_at),
      week: windowState(row.week_throttled, row.week_resume_at),
      fable: windowState(row.fable_throttled, row.fable_resume_at),
    },
  };
}
