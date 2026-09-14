/** Token usage for one translation call, same granularity as claude-worker.ts's
 *  worker_exited usage (issue #47). */
export interface TranslationUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  estimated_cost_usd: number;
}

export interface TranslationResult {
  text: string;
  usage: TranslationUsage;
}

/** The LLM-facing seam for display-time translation (issue #47 / ADR 0015):
 *  canonical board text stays English; this is the derivation a display
 *  surface calls at read time, same shape as DraftClient (draft.ts). */
export interface TranslationClient {
  /** source: the fragment of agent prose being translated (a decision-log
   *  line, a completion report, a question's purpose/item text, or one
   *  section of a handoff doc), or a human's own memory text (issue #593).
   *  language: the target — the board's display language (issue #46), read
   *  fresh by the caller at each use, or "English" when a human's original
   *  becomes the canonical text. */
  translate(source: string, language: string): Promise<TranslationResult>;
}
