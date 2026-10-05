/** The spellings the claude CLI's `--model` takes as an alias — measured on 2.1.286 by `modelUsage`
 *  reporting a different id than the pin (#1245); the CLI matches them case-insensitively. A table
 *  row is a concrete id only (ADR 0182), so the table's door rejects these. A missed alias just
 *  passes, unlike an allowlist that would reject a new model (ADR 0005). Anthropic-adapter knowledge
 *  kept in a leaf module: `claude-worker.ts` imports execution-setting.ts, so the door importing it
 *  from there would be an import cycle that breaks at module evaluation. */
const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "best", "default", "opusplan", "sonnet[1m]", "opus[1m]", "fable[1m]"]);

export const isClaudeModelAlias = (model: string): boolean => MODEL_ALIASES.has(model.toLowerCase());

/** The model families this adapter knows, by concrete-id prefix, and the top one the advisor may climb to
 *  (ADR 0200 決定6). Only the top is needed, so there is no per-family rank. A family missing here makes its
 *  rows non-candidates for advisor entries until a release adds it: an advisor the CLI would not attach
 *  must not reach the record or the learner's cells. */
const FAMILY_PREFIXES = ["claude-haiku-", "claude-sonnet-", "claude-opus-", "claude-fable-"];
const TOP_FAMILY = { alias: "fable", prefix: "claude-fable-" };

/** The advisor pinned beside an anthropic main row; undefined when the row's family is unknown. With
 *  `aboveMain` it is the top family's alias (an alias, since the advisor is not a row), except that a main
 *  already in the top family gets its own concrete id — an alias lagging the row's generation would not
 *  attach. Without it the advisor is main itself. */
export function claudeAdvisorFor(model: string, aboveMain: boolean): string | undefined {
  if (!FAMILY_PREFIXES.some((prefix) => model.startsWith(prefix))) return undefined;
  return aboveMain && !model.startsWith(TOP_FAMILY.prefix) ? TOP_FAMILY.alias : model;
}
