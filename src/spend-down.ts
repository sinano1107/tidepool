import type { Db } from "./db.js";
import type { SpendDownState, SpendDownWindow } from "./usage.js";

/** Spend-down (ADR 0091): one independently expiring row per active window. */
export function setSpendDown(db: Db, window: SpendDownWindow, now: Date): void {
  db.prepare(
    `INSERT INTO spend_down_state (window, activated_at) VALUES (?, ?)
     ON CONFLICT(window) DO UPDATE SET activated_at = excluded.activated_at`,
  ).run(window, now.toISOString());
}

export function clearSpendDown(db: Db, window: SpendDownWindow): void {
  db.prepare("DELETE FROM spend_down_state WHERE window = ?").run(window);
}

export function getSpendDown(db: Db): SpendDownState {
  const rows = db.prepare("SELECT window, activated_at FROM spend_down_state").all() as Array<{
    window: SpendDownWindow;
    activated_at: string;
  }>;
  const state: SpendDownState = { session: null, week: null };
  for (const row of rows) state[row.window] = { activatedAt: new Date(row.activated_at) };
  return state;
}
