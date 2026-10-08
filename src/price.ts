export function whyInvalidPrice(value: number): string | undefined {
  return Number.isFinite(value) && value >= 0 ? undefined : "price must be a finite non-negative number";
}
