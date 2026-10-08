/** Required text at every input surface (ADR 0212). Empty-allowed fields keep their own semantics. */
export const normalizeText = (value: string): string => value.trim();

export const whyBlank = (value: string): string | undefined => normalizeText(value) === "" ? "must not be blank" : undefined;
