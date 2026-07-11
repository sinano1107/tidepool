import type { Db } from "./db.js";

export interface QuietHoursConfig {
  /** "HH:MM", inclusive start of the quiet window (UTC wall clock). */
  start: string;
  /** "HH:MM", exclusive end of the quiet window (UTC wall clock). */
  end: string;
}

const DEFAULT_QUIET_HOURS: QuietHoursConfig = { start: "23:00", end: "07:00" };

/** The one HH:MM shape both api.ts's request validation and this module's own
 *  parsing agree on — 00–23 hours, 00–59 minutes. Kept in one place so the
 *  two never drift (api.ts previously re-derived a slightly stricter regex
 *  of its own). */
export const HH_MM_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function getQuietHours(db: Db): QuietHoursConfig {
  const row = db.prepare("SELECT start, end FROM quiet_hours WHERE id = 1").get() as
    | QuietHoursConfig
    | undefined;
  return row ?? DEFAULT_QUIET_HOURS;
}

function minutesSinceMidnight(hhmm: string): number {
  const match = HH_MM_PATTERN.exec(hhmm);
  if (!match) throw new Error(`invalid HH:MM time: ${hhmm}`);
  const [, hours, minutes] = match;
  return Number(hours) * 60 + Number(minutes);
}

/** Start inclusive, end exclusive. A start > end range wraps past midnight
 *  (e.g. the 23:00–07:00 default) — nowMinutes is "inside" if it's past start
 *  OR before end, rather than between them. */
export function isQuietHours(db: Db, now: Date): boolean {
  const { start, end } = getQuietHours(db);
  const startMin = minutesSinceMidnight(start);
  const endMin = minutesSinceMidnight(end);
  const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

export function setQuietHours(db: Db, config: QuietHoursConfig): void {
  db.prepare(
    `INSERT INTO quiet_hours (id, start, end) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET start = excluded.start, end = excluded.end`,
  ).run(config.start, config.end);
}
