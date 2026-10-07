/** The spellings the claude CLI's `--model` takes as an alias — measured on 2.1.286 by `modelUsage`
 *  reporting a different id than the pin (#1245); the CLI matches them case-insensitively. A table
 *  row is a concrete id only (ADR 0182), so the table's door rejects these. A missed alias just
 *  passes, unlike an allowlist that would reject a new model (ADR 0005). Anthropic-adapter knowledge
 *  kept in a leaf module: `claude-worker.ts` imports execution-setting.ts, so the door importing it
 *  from there would be an import cycle that breaks at module evaluation. */
const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "best", "default", "opusplan", "sonnet[1m]", "opus[1m]", "fable[1m]"]);

export const isClaudeModelAlias = (model: string): boolean => MODEL_ALIASES.has(model.toLowerCase());

/** The model families this adapter knows, by concrete-id prefix, and the top one the advisor may climb to
 *  (ADR 0200 決定6). Each family carries the lowest generation (major * 100 + minor) whose main takes an
 *  advisor, and whether it can act as one (ADR 0200 追記 2026-10-07). Only the top is needed, so there is no
 *  per-family rank. A family missing here makes its rows non-candidates for advisor entries until a release
 *  adds it: an advisor the CLI would not attach must not reach the record or the learner's cells. */
const FAMILIES = [
  { prefix: "claude-haiku-", minGeneration: 0, canAdvise: false },
  { prefix: "claude-sonnet-", minGeneration: 406, canAdvise: true },
  { prefix: "claude-opus-", minGeneration: 406, canAdvise: true },
  { prefix: "claude-fable-", minGeneration: 0, canAdvise: true },
];
const TOP_FAMILY = { alias: "fable", prefix: "claude-fable-" };

/** `<major>[-<minor>][-<date>]` after the family prefix: minor is 1-2 digits, the date 8, so
 *  `claude-sonnet-4-20250514` is 4.0 and `claude-opus-4-1-20250805` is 4.1. */
const GENERATION = /^(\d+)(?:-(\d{1,2})(?!\d))?/;

/** The advisor pinned beside an anthropic main row; undefined when the CLI would refuse the pair at
 *  launch: the row's family is unknown, its generation is unreadable or below the family's floor, or its
 *  family cannot advise and `aboveMain` is off. With `aboveMain` it is the top family's alias (an alias,
 *  since the advisor is not a row), except that a main already in the top family gets its own concrete
 *  id — an alias lagging the row's generation would not attach. Without it the advisor is main itself. */
export function claudeAdvisorFor(model: string, aboveMain: boolean): string | undefined {
  const family = FAMILIES.find((f) => model.startsWith(f.prefix));
  const digits = family && GENERATION.exec(model.slice(family.prefix.length));
  if (!family || !digits) return undefined;
  if (Number(digits[1]) * 100 + Number(digits[2] ?? 0) < family.minGeneration) return undefined;
  if (aboveMain) return model.startsWith(TOP_FAMILY.prefix) ? model : TOP_FAMILY.alias;
  return family.canAdvise ? model : undefined;
}
