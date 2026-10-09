import { undatedClaudeId } from "./claude-model-alias.js";

/** The effort vocabulary every execution-setting row takes, whatever its provider (ADR 0216 決定1): the claude CLI's closed
 *  `--effort` set, which every non-hidden Codex model also advertises. A leaf module so the table's door, the adapters and the
 *  WebUI (ADR 0209) read one list without an import cycle. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** How Claude CLI 2.1.286's built-in model rules treat effort, per undated id (ADR 0218 決定3): a copy of the binary's fixed
 *  refusal list, not the served catalog. `runsAsHigh` lists the values the CLI lowers to `high`; `dropsEffort` the ids it sends
 *  without effort, and `dropsEffortPrefix` the older generation it sends without effort by prefix (`undatedClaudeId` reads only
 *  the current families). Every other id, unknown ones included, takes all five. Checked at each CLI bump. */
const CLAUDE_EFFORT_RULES = {
  runsAsHigh: { "claude-opus-4-5": ["xhigh", "max"], "claude-opus-4-6": ["xhigh"], "claude-sonnet-4-6": ["xhigh"] } as Record<string, readonly string[]>,
  dropsEffort: ["claude-opus-4-0", "claude-opus-4-1", "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-haiku-4-5"] as readonly string[],
  dropsEffortPrefix: "claude-3-",
};

/** Why a row may not take this effort (`null` = no effort, ADR 0218 決定5): outside the vocabulary for any provider; on an
 *  anthropic / moonshot row (both run on the claude CLI) an effort on a model the CLI sends without one, no effort on any other
 *  model, or a value the model runs as `high`. Codex rows take the five values; their per-model efforts are the probe's to check. */
export function whyInvalidEffort(provider: string, model: string, effort: string | null): string | undefined {
  const outsideVocabulary = `effort must be one of ${EFFORT_LEVELS.join(" / ")}`;
  if (effort !== null && !(EFFORT_LEVELS as readonly string[]).includes(effort)) return outsideVocabulary;
  if (provider === "openai") return effort === null ? outsideVocabulary : undefined;
  const undated = undatedClaudeId(model);
  if (model.startsWith(CLAUDE_EFFORT_RULES.dropsEffortPrefix) || (undated !== undefined && CLAUDE_EFFORT_RULES.dropsEffort.includes(undated))) {
    return effort === null ? undefined : `${model} takes no effort under the claude CLI's built-in model rules; write no effort (null)`;
  }
  if (effort === null) return outsideVocabulary;
  return undated && CLAUDE_EFFORT_RULES.runsAsHigh[undated]?.includes(effort)
    ? `${model} at effort ${effort} runs as high under the claude CLI's built-in model rules; write high`
    : undefined;
}
