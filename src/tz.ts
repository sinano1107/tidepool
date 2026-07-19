/** Minutes east of UTC for `tz` at the instant `now` (DST-aware). `longOffset`
 *  always renders `GMT±HH:MM` (or bare `GMT` for UTC) — unlike `shortOffset`,
 *  which drops `:MM` for whole-hour zones, this never truncates a half-hour
 *  zone like Asia/Kolkata (GMT+5:30). Shared by usage.ts (parsing `/usage`
 *  panel reset times) and quiet-hours.ts (the board timezone, ADR 0022) so
 *  the IANA-tz-to-offset mechanism exists in exactly one place. */
export function offsetMinutesEastOfUtc(tz: string, now: Date): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")!.value; // "GMT+05:30" / "GMT-04:00" / "GMT"
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
  if (!match) return 0;
  const [, sign, hours, minutes] = match;
  const magnitude = Number(hours) * 60 + Number(minutes);
  return sign === "-" ? -magnitude : magnitude;
}
