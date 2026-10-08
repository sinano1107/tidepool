export function whyNotPositiveInteger(value: number): string | undefined {
  return Number.isSafeInteger(value) && value > 0 ? undefined : "must be a positive integer";
}
