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
  /^Current (session|week \(all models\)): (\d+)% used · resets (\w+ \d+) at (\d+:\d+)(am|pm) \(([^)]+)\)$/;

function parseResetsAt(monthDay: string, time: string, meridiem: string, tz: string, now: Date): Date {
  const [hourStr, minuteStr] = time.split(":");
  let hour = Number(hourStr);
  if (meridiem === "pm" && hour !== 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const minute = Number(minuteStr);

  const referenceYear = now.getUTCFullYear();
  const offsetLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT+9" / "GMT-5" / "GMT"
  const offsetMatch = /GMT([+-]\d+)?/.exec(offsetLabel)!;
  const offsetHours = offsetMatch[1] ? Number(offsetMatch[1]) : 0;

  const asOfCurrentYear = new Date(
    Date.UTC(referenceYear, monthIndex(monthDay), dayOf(monthDay), hour - offsetHours, minute),
  );
  if (asOfCurrentYear.getTime() > now.getTime()) return asOfCurrentYear;
  return new Date(
    Date.UTC(referenceYear + 1, monthIndex(monthDay), dayOf(monthDay), hour - offsetHours, minute),
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthIndex(monthDay: string): number {
  return MONTHS.indexOf(monthDay.split(" ")[0]!);
}

function dayOf(monthDay: string): number {
  return Number(monthDay.split(" ")[1]);
}

export interface ThrottleDecision {
  throttled: boolean;
  resetsAt: Date | null;
}

/** ADR 0008: session or week (all models) at or above threshold blocks new
 *  pickup. Neither window touches an already-running task. */
export function evaluateThrottle(snapshot: UsageSnapshot, thresholdPercent: number): ThrottleDecision {
  if (snapshot.session === null && snapshot.week === null) return { throttled: true, resetsAt: null };
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
    const match = LINE_PATTERN.exec(line.trim());
    if (!match) continue;
    const [, window, percent, monthDay, time, meridiem, tz] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const snapshot: UsageWindowSnapshot = {
      percent: Number(percent),
      resetsAt: parseResetsAt(monthDay, time, meridiem, tz, now),
    };
    if (window === "session") session = snapshot;
    else week = snapshot;
  }
  return { session, week };
}
