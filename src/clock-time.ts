export function whyInvalidClockTime(value: string): string | undefined {
  return value.length === 5 && /^([01]\d|2[0-3]):([0-5]\d)$/.test(value) ? undefined : "time must be HH:MM between 00:00 and 23:59";
}
