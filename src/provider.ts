/** The provider enumeration (ADR 0097 決定1 / issue #444): the closed set of
 *  values an agent definition's `provider` may carry. What each value *means*
 *  (endpoint URL, env names, model spellings) is the adapter's vendor knowledge
 *  (ADR 0005) and never appears here.
 *
 *  A leaf module of its own (issue #545): registry.ts imports execution-setting.ts
 *  for the tiers and execution-setting.ts needs this list at module-evaluation
 *  time (the change schema's `z.enum`), which the registry ↔ execution-setting
 *  cycle cannot provide. registry.ts re-exports it, so every other importer is
 *  unchanged. */
export const PROVIDER_VALUES = ["anthropic", "moonshot", "openai"] as const;
export type Provider = (typeof PROVIDER_VALUES)[number];
