/** The effort vocabulary every execution-setting row takes, whatever its provider (ADR 0216 決定1): the claude CLI's closed
 *  `--effort` set, which every non-hidden Codex model also advertises. A leaf module so the table's door, the adapters and the
 *  WebUI (ADR 0209) read one list without an import cycle. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export function whyInvalidEffort(effort: string): string | undefined {
  return (EFFORT_LEVELS as readonly string[]).includes(effort) ? undefined : `effort must be one of ${EFFORT_LEVELS.join(" / ")}`;
}
