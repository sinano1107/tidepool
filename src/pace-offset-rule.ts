/** Human-reserved points in a provider's usage window. */
export function whyInvalidOffset(value: unknown): string | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? undefined : "offset must be an integer between 0 and 100";
}

export const isValidOffset = (value: unknown): value is number => whyInvalidOffset(value) === undefined;
