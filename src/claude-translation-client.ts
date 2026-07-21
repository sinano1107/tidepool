import { z } from "zod";
import { defaultExec, type ExecFn, pinnedModelFlags } from "./claude-worker.js";
import type { GlossaryEntry } from "./glossary.js";
import type { TranslationClient, TranslationResult } from "./translate.js";

// the CLI's `-p --output-format json` envelope (vendor-specific, kept private
// to this adapter — ADR 0005), verified against a real `claude -p` run: the
// same total_cost_usd/usage shape claude-worker.ts's stream-json result event
// carries, so translation usage can be recorded at the same granularity
const resultEnvelopeSchema = z.object({
  result: z.string(),
  total_cost_usd: z.number(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_read_input_tokens: z.number(),
    cache_creation_input_tokens: z.number(),
  }),
});

function buildPrompt(source: string, language: string, glossary: GlossaryEntry[]): string {
  const instructions =
    `Translate the following text into ${language}. Respond with ONLY the translated text ` +
    "(no markdown fences, no prose, no explanation) — preserve line breaks and markdown " +
    "structure exactly, translating only the prose content.";
  // the glossary's Japanese gloss only means something when translating into
  // Japanese — CONTEXT.md carries no other language's terms (issue #47)
  const glossaryBlock =
    language === "Japanese" && glossary.length > 0
      ? "Board terminology glossary — use these exact Japanese translations for these terms " +
        `wherever they appear:\n${glossary.map((g) => `${g.term} = ${g.ja}`).join("\n")}`
      : "";
  return [instructions, glossaryBlock, `Text:\n${source}`].filter(Boolean).join("\n\n");
}

export interface ClaudeTranslationClientOptions {
  /** CONTEXT.md's own term pairs (issue #47), injected as a translation aid
   *  when the target language is Japanese. Absent → no glossary guidance. */
  glossary?: GlossaryEntry[];
  exec?: ExecFn;
}

/** The real TranslationClient (issue #47): a headless one-shot `claude -p`
 *  call, same ExecFn process boundary ClaudeDraftClient's runDraftPrompt
 *  uses — pinned to haiku (cheaper than draft's sonnet: this is a mechanical
 *  translation, not a generation task). */
export class ClaudeTranslationClient implements TranslationClient {
  private readonly glossary: GlossaryEntry[];
  private readonly exec: ExecFn;

  constructor(options: ClaudeTranslationClientOptions = {}) {
    this.glossary = options.glossary ?? [];
    this.exec = options.exec ?? defaultExec;
  }

  async translate(source: string, language: string): Promise<TranslationResult> {
    const stdout = await this.exec("claude", [
      "-p",
      buildPrompt(source, language, this.glossary),
      "--output-format",
      "json",
      ...pinnedModelFlags("haiku", "low"),
      // no MCP tools are configured for this call — a single translated
      // answer, not a working session, so more than one turn is a
      // malfunction to fail loud on
      "--max-turns",
      "1",
      // this call runs with the board's own cwd, not a task workspace —
      // --safe-mode keeps the board repo's own CLAUDE.md/skills/MCP config
      // from leaking into what must stay a bare translated answer
      "--safe-mode",
    ]);
    const envelope = resultEnvelopeSchema.parse(JSON.parse(stdout));
    return {
      text: envelope.result,
      usage: {
        input_tokens: envelope.usage.input_tokens,
        output_tokens: envelope.usage.output_tokens,
        cache_read_tokens: envelope.usage.cache_read_input_tokens,
        cache_creation_tokens: envelope.usage.cache_creation_input_tokens,
        estimated_cost_usd: envelope.total_cost_usd,
      },
    };
  }
}
