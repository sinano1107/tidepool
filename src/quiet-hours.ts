import { whyInvalidClockTime } from "./clock-time.js";
import type { Db } from "./db.js";
import { offsetMinutesEastOfUtc } from "./tz.js";

export interface QuietHoursConfig {
  /** "HH:MM", inclusive start of the quiet window, read against tz's wall
   *  clock. */
  start: string;
  /** "HH:MM", exclusive end of the quiet window, read against tz's wall
   *  clock. */
  end: string;
  /** The one board timezone (CONTEXT.md's Timezone, ADR 0022) this window is
   *  read against — set only via POST /api/settings/timezone, never by
   *  setQuietHours. */
  tz: string;
}

const DEFAULT_QUIET_HOURS: QuietHoursConfig = { start: "23:00", end: "07:00", tz: "Asia/Tokyo" };

export function getQuietHours(db: Db): QuietHoursConfig {
  const row = db.prepare("SELECT start, end, tz FROM quiet_hours WHERE id = 1").get() as
    | QuietHoursConfig
    | undefined;
  return row ?? DEFAULT_QUIET_HOURS;
}

function minutesSinceMidnight(hhmm: string): number {
  const reason = whyInvalidClockTime(hhmm);
  if (reason) throw new Error(reason);
  const [hours, minutes] = hhmm.split(":");
  return Number(hours) * 60 + Number(minutes);
}

/** Start inclusive, end exclusive. A start > end range wraps past midnight
 *  (e.g. the 23:00–07:00 default) — nowMinutes is "inside" if it's past start
 *  OR before end, rather than between them. `now` is converted to tz's wall
 *  clock first (issue #63 / ADR 0022) — quiet hours is when the human is
 *  asleep, which is a tz-local concept, not a UTC one. */
export function isQuietHours(db: Db, now: Date): boolean {
  const { start, end, tz } = getQuietHours(db);
  const startMin = minutesSinceMidnight(start);
  const endMin = minutesSinceMidnight(end);
  const offsetMinutes = offsetMinutesEastOfUtc(tz, now);
  // + 2 days before the mod keeps the sum positive for any real-world tz
  // offset (-12:00..+14:00) without a second modulo pass.
  const nowMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + offsetMinutes + 2 * 1440) % 1440;
  if (startMin <= endMin) return nowMin >= startMin && nowMin < endMin;
  return nowMin >= startMin || nowMin < endMin;
}

/** Sets the human-configured start/end (issue #14's own quiet-hours API) —
 *  never touches tz, which is only ever set via POST /api/settings/timezone
 *  (ADR 0022's decision to keep the two senders separate). */
export function setQuietHours(db: Db, config: Pick<QuietHoursConfig, "start" | "end">): void {
  db.prepare(
    `INSERT INTO quiet_hours (id, start, end) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET start = excluded.start, end = excluded.end`,
  ).run(config.start, config.end);
}

/** Sets the one board timezone (issue #63 / ADR 0022) — never touches
 *  start/end, which are only ever set via POST /api/settings/quiet-hours. A
 *  first-ever call (no row yet) seeds start/end with the quiet-hours
 *  default rather than leaving them unset. */
export function setBoardTimezone(db: Db, tz: string): void {
  db.prepare(
    `INSERT INTO quiet_hours (id, start, end, tz) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET tz = excluded.tz`,
  ).run(DEFAULT_QUIET_HOURS.start, DEFAULT_QUIET_HOURS.end, tz);
}
