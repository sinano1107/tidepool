/** A single window's utilization as observed via `/usage` (issue #22 grill:
 *  the date carries no year, English month name, 12-hour clock, tz name in
 *  parens — `now` disambiguates the year by always rounding to the future). */
export interface UsageWindowSnapshot {
  percent: number;
  resetsAt: Date;
}

export interface UsageSnapshot {
  session: UsageWindowSnapshot | null;
  week: UsageWindowSnapshot | null;
}

const LINE_PATTERN =
  /^Current (?<window>session|week \(all models\)): (?<percent>\d+)% used · resets (?<month>\w+) (?<day>\d+) at (?<hour>\d+):(?<minute>\d+)(?<meridiem>am|pm) \((?<tz>[^)]+)\)$/;

/** The reset half of a parsed `/usage` line — the month/day/hour/minute/tz
 *  fields that only ever travel together, bundled so parseResetsAt takes one
 *  value instead of a clump of loose strings. */
interface ParsedResetTime {
  month: string;
  day: number;
  hour: number;
  minute: number;
  tz: string;
}

function to24Hour(hour12: number, meridiem: "am" | "pm"): number {
  if (meridiem === "am") return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Minutes east of UTC for `tz` at the instant `now` (DST-aware). `longOffset`
 *  always renders `GMT±HH:MM` (or bare `GMT` for UTC) — unlike `shortOffset`,
 *  which drops `:MM` for whole-hour zones, this never truncates a half-hour
 *  zone like Asia/Kolkata (GMT+5:30). */
function offsetMinutesEastOfUtc(tz: string, now: Date): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT+05:30" / "GMT-04:00" / "GMT"
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
  if (!match) return 0;
  const [, sign, hours, minutes] = match;
  const magnitude = Number(hours) * 60 + Number(minutes);
  return sign === "-" ? -magnitude : magnitude;
}

/** No year in the source text (issue #22 grill) — always rounds to the
 *  soonest future occurrence of month/day relative to `now`, so a Dec→Jan
 *  reset correctly lands in the following year. */
function parseResetsAt(reset: ParsedResetTime, now: Date): Date {
  const referenceYear = now.getUTCFullYear();
  const offsetMinutes = offsetMinutesEastOfUtc(reset.tz, now);
  const asUtcMinutes = reset.hour * 60 + reset.minute - offsetMinutes;
  const monthIndex = MONTHS.indexOf(reset.month);
  const asOfCurrentYear = new Date(Date.UTC(referenceYear, monthIndex, reset.day, 0, asUtcMinutes));
  if (asOfCurrentYear.getTime() > now.getTime()) return asOfCurrentYear;
  return new Date(Date.UTC(referenceYear + 1, monthIndex, reset.day, 0, asUtcMinutes));
}

export interface ThrottleDecision {
  throttled: boolean;
  resetsAt: Date | null;
}

/** ADR 0008: session or week (all models) at or above threshold blocks new
 *  pickup. Neither window touches an already-running task. */
export function evaluateThrottle(snapshot: UsageSnapshot, thresholdPercent: number): ThrottleDecision {
  // fail-closed: either window unobserved means the decision can't be trusted,
  // even if the other window looks fine (issue #22: "観測不能なとき...は
  // fail-closed で skip する")
  if (snapshot.session === null || snapshot.week === null) return { throttled: true, resetsAt: null };
  const triggered = [snapshot.session, snapshot.week].filter(
    (w): w is UsageWindowSnapshot => w !== null && w.percent >= thresholdPercent,
  );
  if (triggered.length === 0) return { throttled: false, resetsAt: null };
  const resetsAt = triggered.reduce((latest, w) => (w.resetsAt > latest ? w.resetsAt : latest), triggered[0]!.resetsAt);
  return { throttled: true, resetsAt };
}

/** Parses the `result` text of `claude -p "/usage" --output-format json`
 *  (ADR 0008). Only the all-models week line is read — per-model week rows
 *  are ignored. */
export function parseUsage(resultText: string, now: Date): UsageSnapshot {
  let session: UsageWindowSnapshot | null = null;
  let week: UsageWindowSnapshot | null = null;
  for (const line of resultText.split("\n")) {
    const groups = LINE_PATTERN.exec(line.trim())?.groups;
    if (!groups) continue;
    const snapshot: UsageWindowSnapshot = {
      percent: Number(groups.percent),
      resetsAt: parseResetsAt(
        {
          month: groups.month!,
          day: Number(groups.day),
          hour: to24Hour(Number(groups.hour), groups.meridiem as "am" | "pm"),
          minute: Number(groups.minute),
          tz: groups.tz!,
        },
        now,
      ),
    };
    if (groups.window === "session") session = snapshot;
    else week = snapshot;
  }
  return { session, week };
}
