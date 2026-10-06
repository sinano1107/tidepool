/** The provider enumeration (ADR 0097 決定1 / issue #444): the closed set of
 *  values an agent definition's `provider` may carry. What each value *means*
 *  (endpoint URL, env names, model spellings) is the adapter's vendor knowledge
 *  (ADR 0005) and never appears here.
 *
 *  A zero-dependency leaf module of its own, one per concept (ADR 0204 決定5):
 *  registry.ts and execution-setting.ts both read the list from here. */
export const PROVIDER_VALUES = ["anthropic", "moonshot", "openai"] as const;
export type Provider = (typeof PROVIDER_VALUES)[number];
