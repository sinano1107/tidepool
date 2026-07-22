import type { Db } from "./db.js";
import type { SpendDownState } from "./usage.js";

/** Spend-down (ADR 0030 / issue #128): the human-only board state that drops
 *  the target window's pace line and leaves only the 100% hard cap. Same
 *  one-row shape as pause_state, but with an expiry: the scheduler clears it
 *  once the target window's observed reset shows the activation belongs to a
 *  previous window (取り残された状態は必ず放置 — Pause の純手動解除とは逆). */
export function setSpendDown(db: Db, window: SpendDownState["window"], now: Date): void {
  db.prepare(
    `INSERT INTO spend_down_state (id, window, activated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       window = excluded.window, activated_at = excluded.activated_at`,
  ).run(window, now.toISOString());
}

export function clearSpendDown(db: Db): void {
  db.prepare("DELETE FROM spend_down_state WHERE id = 1").run();
}

export function getSpendDown(db: Db): SpendDownState | null {
  const row = db
    .prepare("SELECT window, activated_at FROM spend_down_state WHERE id = 1")
    .get() as { window: SpendDownState["window"]; activated_at: string } | undefined;
  if (!row) return null;
  return { window: row.window, activatedAt: new Date(row.activated_at) };
}
