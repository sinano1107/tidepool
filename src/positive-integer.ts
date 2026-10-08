export function whyNotPositiveInteger(value: number): string | undefined {
  return Number.isInteger(value) && value > 0 ? undefined : "must be a positive integer";
}
