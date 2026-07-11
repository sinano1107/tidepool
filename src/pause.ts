import type { Db } from "./db.js";

/** Board-wide pickup pause (CONTEXT.md's Pause): a human-only toggle, same
 *  single-row shape as throttle_state, but with no auto-resume — clearing it
 *  is purely manual (issue #34). No row means never paused. */
export function setPaused(db: Db, paused: boolean): void {
  db.prepare(
    `INSERT INTO pause_state (id, paused) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET paused = excluded.paused`,
  ).run(paused ? 1 : 0);
}

export function isPaused(db: Db): boolean {
  const row = db.prepare("SELECT paused FROM pause_state WHERE id = 1").get() as
    | { paused: number }
    | undefined;
  return row ? row.paused === 1 : false;
}
