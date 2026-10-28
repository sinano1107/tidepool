import type { BoardCallUsage } from "./board-call-usage.js";
import type { ModelSwap } from "./events.js";
import type { Provider } from "./provider.js";

/** What one translation call ran on, in the pin's spelling (`haiku` / `low`) — not the concrete id that answered. */
export interface TranslationSetting {
  /** a Board call is never pointed at moonshot (ADR 0096) */
  provider: Exclude<Provider, "moonshot">;
  model: string;
  effort: string | null;
}

export interface TranslationResult {
  model_swaps: ModelSwap[];
  refusals: (string | null)[];
  /** one per fragment, in the fragments' order */
  texts: string[];
  /** the whole call's usage — a batched call carries no per-fragment usage (ADR 0296 決定5) */
  usage: BoardCallUsage;
  setting: TranslationSetting;
}

/** The LLM-facing seam for display-time translation (issue #47 / ADR 0015):
 *  canonical board text stays English; this is the derivation a display
 *  surface calls at read time, same shape as DraftClient (draft.ts). */
export interface TranslationClient {
  /** fragments: one display target's text not yet in the cache, translated
   *  in one call (ADR 0296 決定4) — agent prose (a decision-log line, a
   *  completion report, a question's purpose/item text, a handoff doc's
   *  section bodies) or a human's own memory text (issue #593).
   *  language: the target — the board's display language (issue #46), read
   *  fresh by the caller at each use, or "English" when a human's original
   *  becomes the canonical text. */
  translate(fragments: string[], language: string): Promise<TranslationResult>;
}
