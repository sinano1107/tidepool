/** The spellings the claude CLI's `--model` takes as an alias — measured on 2.1.286 by `modelUsage`
 *  reporting a different id than the pin (#1245); the CLI matches them case-insensitively. A table
 *  row is a concrete id only (ADR 0182), so the table's door rejects these. A missed alias just
 *  passes, unlike an allowlist that would reject a new model (ADR 0005). Anthropic-adapter knowledge
 *  kept in a leaf module: `claude-worker.ts` imports execution-setting.ts, so the door importing it
 *  from there would be an import cycle that breaks at module evaluation. */
const MODEL_ALIASES = new Set(["sonnet", "opus", "haiku", "fable", "best", "default", "opusplan", "sonnet[1m]", "opus[1m]", "fable[1m]"]);

export const isClaudeModelAlias = (model: string): boolean => MODEL_ALIASES.has(model.toLowerCase());
