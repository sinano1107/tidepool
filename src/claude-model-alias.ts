/** The spellings the claude CLI's `--model` takes as an alias — measured on 2.1.286 by `modelUsage`
 *  reporting a different id than the pin (#1245); the CLI matches them case-insensitively. A table
 *  row is a concrete id only (ADR 0182), so the table's door rejects these. A missed alias just
 *  passes, unlike an allowlist that would reject a new model (ADR 0005). Anthropic-adapter knowledge
 *  kept in a leaf module: `claude-worker.ts` imports execution-setting.ts, so the door importing it
 *  from there would be an import cycle that breaks at module evaluation. */
const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "best", "default", "opusplan", "sonnet[1m]", "opus[1m]", "fable[1m]"]);

export const isClaudeModelAlias = (model: string): boolean => MODEL_ALIASES.has(model.toLowerCase());

/** The board's advisor ceiling (ADR 0208 決定1): `off`, or the alias of the highest family the advisor may climb to;
 *  `fable_then_opus` is `fable` that drops to `opus` while the Fable window is throttled (決定5). */
export const ADVISOR_CEILINGS = ["off", "sonnet", "opus", "fable", "fable_then_opus"] as const;
export type AdvisorCeiling = (typeof ADVISOR_CEILINGS)[number];

/** Why the advisor is what it is (ADR 0208 決定6): `off` — the ceiling is off; `ceiling` — the ceiling's alias, or main's own
 *  id when main is in the ceiling's family; `unknown_generation` — main's own id, since this release does not know whether
 *  the ceiling's alias takes main's generation; `main_above_ceiling` — main ranks above the ceiling, so no advisor; `window_downgraded` — under `fable_then_opus`, the `opus`
 *  ceiling's derivation, chosen while the Fable window keeps the `fable` advisor out (決定5). */
export type AdvisorSource = "off" | "ceiling" | "unknown_generation" | "main_above_ceiling" | "window_downgraded";

/** The model families this adapter knows, lowest rank first, by concrete-id prefix. Each carries the lowest generation
 *  (major * 100 + minor) whose main takes an advisor and whether it can act as one (ADR 0200 追記 2026-10-07). A family a
 *  ceiling names also carries, per lower family, the highest main generation its alias accepts at the pinned CLI (ADR 0208
 *  決定4 —— 2.1.286: `sonnet` → Sonnet 5.5, `opus` → Opus 5.5, `fable` → Fable 5.1), checked against the docs' combination
 *  table at each version bump. A family missing here makes its rows non-candidates for advisor entries until a release adds
 *  it: an advisor the CLI would not attach must not reach the record or the learner's cells. */
const FAMILIES: readonly { name: string; prefix: string; minGeneration: number; canAdvise: boolean; accepts?: Record<string, number> }[] = [
  { name: "haiku", prefix: "claude-haiku-", minGeneration: 0, canAdvise: false },
  { name: "sonnet", prefix: "claude-sonnet-", minGeneration: 406, canAdvise: true, accepts: { haiku: 405 } },
  { name: "opus", prefix: "claude-opus-", minGeneration: 406, canAdvise: true, accepts: { haiku: 405, sonnet: 505 } },
  { name: "fable", prefix: "claude-fable-", minGeneration: 0, canAdvise: true, accepts: { haiku: 405, sonnet: 505, opus: 505 } },
];

/** `<major>[-<minor>][-<date>]` after the family prefix: minor is 1-2 digits, the date 8, so
 *  `claude-sonnet-4-20250514` is 4.0 and `claude-opus-4-1-20250805` is 4.1. */
const GENERATION = /^(\d+)(?:-(\d{1,2})(?!\d))?/;

/** The undated id `claude-<family>-<major>-<minor>` a concrete id reads as (`claude-opus-4-20250514` → `claude-opus-4-0`), by the
 *  same family and generation reading as the advisor; undefined when the family or generation is unreadable. */
export function undatedClaudeId(model: string): string | undefined {
  const read = readFamily(model);
  return read && `${read.family.prefix}${read.major}-${read.minor}`;
}

/** The family and `<major>-<minor>` a concrete id reads as; undefined when either is unreadable. */
function readFamily(model: string): { family: (typeof FAMILIES)[number]; major: number; minor: number } | undefined {
  const family = FAMILIES.find((f) => model.startsWith(f.prefix));
  const digits = family && GENERATION.exec(model.slice(family.prefix.length));
  return digits ? { family, major: Number(digits[1]), minor: Number(digits[2] ?? 0) } : undefined;
}

/** The advisor pinned beside an anthropic main row under the board's ceiling, and why; undefined when the row is no
 *  candidate for an advisor entry. `off` decides before the row is read (ADR 0208 決定3): the entry runs as one without an
 *  advisor. A main above the ceiling runs without one, so no floor applies. Otherwise the row is no candidate when its family is
 *  unknown, its generation is unreadable or below the family's floor, or the advisor would be main itself and the family cannot advise (a Haiku generation this release does not know). */
export function claudeAdvisorFor(model: string, ceiling: AdvisorCeiling): { advisor: string | undefined; source: AdvisorSource } | undefined {
  if (ceiling === "off") return { advisor: undefined, source: "off" };
  const alias = ceiling === "fable_then_opus" ? "fable" : ceiling;
  const read = readFamily(model);
  if (!read) return undefined;
  const { family } = read;
  const top = FAMILIES.findIndex((f) => f.name === alias);
  const rank = FAMILIES.indexOf(family);
  if (rank > top) return { advisor: undefined, source: "main_above_ceiling" };
  const generation = read.major * 100 + read.minor;
  if (generation < family.minGeneration) return undefined;
  if (rank === top) return { advisor: model, source: "ceiling" };
  if (generation <= FAMILIES[top]!.accepts![family.name]!) return { advisor: alias, source: "ceiling" };
  return family.canAdvise ? { advisor: model, source: "unknown_generation" } : undefined;
}
