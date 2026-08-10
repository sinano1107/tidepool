import { z } from "zod";
import { defaultExec, type ExecFn, noThinkingEnv, pinnedModelFlags } from "./claude-worker.js";
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

/** What this board asks of a translation (ADR 0062 決定3), passed as
 *  `--system-prompt` so the requirements are stated once per call instead of
 *  riding on top of the CLI's default coding-agent persona — which cost ~3,600
 *  tokens and actively worked against the translation (measured: the default
 *  produced stray spaces around numbers and inside katakana compounds that
 *  this version does not). It lives here as a constant because it is the
 *  **implementation** of the translation feature, not a setting: no registry
 *  or workspace ever touches it, and a file of its own would just add one more
 *  thing that looks configurable.
 *
 *  These few lines are also the first machine-readable spelling of issue #48's
 *  bar for Japanese board copy ("翻訳調は不採用"). */
const TRANSLATION_SYSTEM_PROMPT = [
  "You are the translator for a work-tracking board. You are given board text and a target " +
    "language, and you return that text in that language. Nothing else is asked of you.",
  "Rules:",
  "- Respond with ONLY the translation. No preamble, no explanation, no markdown fence around it.",
  "- Preserve the markdown structure and line breaks of the source exactly: headings stay " +
    "headings, list items stay list items, blank lines stay where they are.",
  "- Do not translate identifiers, file paths, code spans, commands, or quoted error messages — " +
    "reproduce them verbatim, including their backticks.",
  "- Write natural prose in the target language, the way someone would have written it there " +
    "first. Do not carry the source's word order or sentence shape across.",
  "- Translate everything and nothing more: omit no content, add no content, reorder nothing.",
].join("\n");

function buildPrompt(source: string, language: string, glossary: GlossaryEntry[]): string {
  // the glossary's Japanese gloss only means something when translating into
  // Japanese — CONTEXT.md carries no other language's terms (issue #47).
  // Exact match against the canonical value: display-language is normalized
  // at the write boundary (api.ts's displayLanguageSchema) against
  // SUPPORTED_DISPLAY_LANGUAGES, so only "Japanese" ever reaches here —
  // no case-insensitive matching needed (issue #115).
  const glossaryBlock =
    language === "Japanese" && glossary.length > 0
      ? "Board terminology glossary — use these exact Japanese translations for these terms " +
        `wherever they appear:\n${glossary.map((g) => `${g.term} = ${g.ja}`).join("\n")}`
      : "";
  // the glossary sits between the target language and the source: it is
  // per-board data the system prompt (a constant) cannot carry, and it reads
  // as a note about this text rather than as a standing rule
  return [`Target language: ${language}`, glossaryBlock, `Text:\n${source}`]
    .filter(Boolean)
    .join("\n\n");
}

/** The board's floor on how many `claude` processes display-time translation
 *  may have alive at once (ADR 0063 決定2). What it protects is this host's
 *  memory: one CLI process peaks at ~300MB regardless of how few tokens it
 *  carries (measured, unchanged by ADR 0062's 87% cut), and the Pi has ~2,980MB
 *  free that the board and its worker sessions already share.
 *
 *  This is not a pacer — the caller (webui's translateTarget) already sends at
 *  most two at a time, so the floor is normally empty and nothing ever waits.
 *  It exists for a *second* caller: another tab, a phone beside the laptop, a
 *  future route. Not registry- or settings-driven on purpose: a movable limit
 *  is a permission-shaped setting (ADR 0061) and grows a "whose call is it"
 *  question the board has no need of yet. */
const MAX_CONCURRENT_TRANSLATIONS = 2;

/** How long a translation waits for a slot before giving up (ADR 0063 決定2).
 *  The point of having any limit is to not lean on someone else's timeout:
 *  Node's `server.requestTimeout` and whatever Tailscale Funnel enforces are
 *  values the board did not choose and that can change without notice. 30s
 *  means "a few translations' worth of waiting is fine, minutes are not" —
 *  and since the caller keeps to two at a time, reaching it is not a slow
 *  board but evidence that some caller stopped behaving, which is exactly what
 *  the human then sees in place of the translation. */
const SLOT_WAIT_TIMEOUT_MS = 30_000;

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
  /** CLI processes alive right now, and the calls queued behind them. A
   *  released slot is handed straight to the next waiter rather than counted
   *  down and re-acquired, so a wakeup can never race a new arrival into the
   *  same slot. */
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: ClaudeTranslationClientOptions = {}) {
    this.glossary = options.glossary ?? [];
    this.exec = options.exec ?? defaultExec;
  }

  private acquireSlot(): Promise<void> {
    if (this.running < MAX_CONCURRENT_TRANSLATIONS) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(wake);
        if (at !== -1) this.waiting.splice(at, 1);
        reject(
          new Error(
            `waited ${SLOT_WAIT_TIMEOUT_MS / 1000}s for a translation slot and gave up — ` +
              "more translations were asked for at once than this board runs",
          ),
        );
      }, SLOT_WAIT_TIMEOUT_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiting.push(wake);
    });
  }

  private releaseSlot(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }

  async translate(source: string, language: string): Promise<TranslationResult> {
    await this.acquireSlot();
    try {
      return await this.runTranslation(source, language);
    } finally {
      this.releaseSlot();
    }
  }

  private async runTranslation(source: string, language: string): Promise<TranslationResult> {
    const stdout = await this.exec(
      "claude",
      [
        "-p",
        buildPrompt(source, language, this.glossary),
        "--output-format",
        "json",
        "--system-prompt",
        TRANSLATION_SYSTEM_PROMPT,
        ...pinnedModelFlags("haiku", "low"),
        // an empty tool surface, declared (ADR 0062 決定1): a translation
        // carries no tools, and the declaration is what keeps their
        // *definitions* off the system prompt — measured, they were 18k of the
        // input. `--allowedTools ""` narrows permissions only; the definitions
        // ride along regardless.
        "--tools",
        "",
        // with no tools at all a second turn is structurally impossible; the
        // flag stays as the explicit statement that a single answer is what
        // this call is for, so a CLI that ever raises another turn fails loud
        "--max-turns",
        "1",
        // --system-prompt already keeps the board repo's own CLAUDE.md out, so
        // --safe-mode remains here for the rest: hooks, plugins and MCP config
        // the board's own cwd would otherwise contribute to what must stay a
        // bare translated answer
        "--safe-mode",
      ],
      // a Board call with no advisor (ADR 0044) and no reasoning (ADR 0062
      // 決定2). A haiku main model is no protection for the first — measured
      // 2026-08-04, haiku + an inherited advisorModel attaches opus to every
      // display-time translation. The second was 80% of the output tokens.
      noThinkingEnv(),
    );
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
