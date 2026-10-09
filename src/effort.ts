import { undatedClaudeId } from "./claude-model-alias.js";

/** The effort vocabulary every execution-setting row takes, whatever its provider (ADR 0216 決定1): the claude CLI's closed
 *  `--effort` set, which every non-hidden Codex model also advertises. A leaf module so the table's door, the adapters and the
 *  WebUI (ADR 0209) read one list without an import cycle. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** How Claude CLI 2.1.286's built-in model rules treat effort, per undated id (ADR 0218 決定3): a copy of the binary's fixed
 *  refusal list, not the served catalog. `runsAsHigh` lists the values the CLI lowers to `high`; `dropsEffort` the ids it sends
 *  without effort (`claude-3-*` by prefix). Every other id, unknown ones included, takes all five. Checked at each CLI bump. */
const CLAUDE_EFFORT_RULES = {
  runsAsHigh: { "claude-opus-4-5": ["xhigh", "max"], "claude-opus-4-6": ["xhigh"], "claude-sonnet-4-6": ["xhigh"] } as Record<string, readonly string[]>,
  // ponytail: recorded, not read yet; the "no effort" spelling that acts on it is the next slice of #1655
  dropsEffort: ["claude-3-*", "claude-opus-4-0", "claude-opus-4-1", "claude-sonnet-4-0", "claude-sonnet-4-5", "claude-haiku-4-5"],
};

/** Why a row may not take this effort: outside the vocabulary for any provider, and on an anthropic / moonshot row (both run on
 *  the claude CLI) a value the model runs as `high`. Codex rows' per-model efforts are the probe's to check, not the door's. */
export function whyInvalidEffort(provider: string, model: string, effort: string): string | undefined {
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) return `effort must be one of ${EFFORT_LEVELS.join(" / ")}`;
  if (provider === "openai") return undefined;
  const undated = undatedClaudeId(model);
  return undated && CLAUDE_EFFORT_RULES.runsAsHigh[undated]?.includes(effort)
    ? `${model} at effort ${effort} runs as high under the claude CLI's built-in model rules; write high`
    : undefined;
}
