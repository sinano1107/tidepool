import { z } from "zod";
import { BoardCallUsageError } from "./board-call-usage.js";
import { runClaudeBoardCallJson } from "./claude-board-call-runner.js";
import type { ExecFn } from "./claude-worker.js";
import type { GlossaryEntry } from "./glossary.js";
import type { TranslationClient, TranslationResult, TranslationSetting } from "./translate.js";

/** haiku is an alias, not a table row: a refusal names it, and nothing quarantines it (ADR 0202 決定2) */
const TRANSLATION_SETTING: TranslationSetting = { provider: "anthropic", model: "haiku", effort: "low" };

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
  '- The text arrives as JSON fragments, each with an id. Respond with ONLY {"items": [{"id": <id>, "text": ' +
    "<translation>}]}, one item per fragment with its id unchanged. No preamble, no explanation, no " +
    "markdown fence around it. Each rule below applies to each fragment on its own.",
  "- Preserve the markdown structure and line breaks of the source exactly: headings stay " +
    "headings, list items stay list items, blank lines stay where they are.",
  "- Do not translate identifiers, file paths, code spans, commands, or quoted error messages — " +
    "reproduce them verbatim, including their backticks.",
  "- Write natural prose in the target language, the way someone would have written it there " +
    "first. Do not carry the source's word order or sentence shape across.",
  "- Translate everything and nothing more: omit no content, add no content, reorder nothing.",
].join("\n");

/** The answer's shape (ADR 0296 決定4): the model's reply is untrusted input. */
const answerSchema = z.object({ items: z.array(z.object({ id: z.number(), text: z.string() })) });

function buildPrompt(fragments: string[], language: string, glossary: GlossaryEntry[]): string {
  // the glossary's Japanese gloss only means something when translating into
  // Japanese — GLOSSARY.md carries no other language's terms (issue #47).
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
  const items = fragments.map((text, id) => ({ id, text }));
  return [`Target language: ${language}`, glossaryBlock, `Text:\n${JSON.stringify({ items })}`]
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

/** How long a translation waits for the floor to clear before giving up (ADR
 *  0063 決定2). Deliberately not called a "slot": GLOSSARY.md gives `Slot` to the
 *  board's single execution frame, and a Board call — which this is — "タスクにも
 *  slot にも属さず". The floor is a different limit on a different resource.
 *  The point of having any limit is to not lean on someone else's timeout:
 *  Node's `server.requestTimeout` and whatever Tailscale Funnel enforces are
 *  values the board did not choose and that can change without notice. 30s
 *  means "a few translations' worth of waiting is fine, minutes are not" —
 *  and since the caller keeps to two at a time, reaching it is not a slow
 *  board but evidence that some caller stopped behaving, which is exactly what
 *  the human then sees in place of the translation. */
const FLOOR_WAIT_TIMEOUT_MS = 30_000;

export interface ClaudeTranslationClientOptions {
  /** GLOSSARY.md's own term pairs (issue #47), injected as a translation aid
   *  when the target language is Japanese. Absent → no glossary guidance. */
  glossary?: GlossaryEntry[];
  exec: ExecFn;
}

/** The real TranslationClient (issue #47): a headless one-shot `claude -p`
 *  call through the same runner as ClaudeDraftClient (#662) — pinned to the
 *  haiku alias rather than a table row: this is a mechanical translation, not
 *  a generation task. */
export class ClaudeTranslationClient implements TranslationClient {
  private readonly glossary: GlossaryEntry[];
  private readonly exec: ExecFn;
  /** CLI processes alive right now, and the calls queued behind them. A place
   *  freed on the floor is handed straight to the next waiter rather than
   *  counted down and re-acquired, so a wakeup can never race a new arrival
   *  into the same place. */
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: ClaudeTranslationClientOptions) {
    this.glossary = options.glossary ?? [];
    this.exec = options.exec;
  }

  private enterFloor(): Promise<void> {
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
            `waited ${FLOOR_WAIT_TIMEOUT_MS / 1000}s for the translation floor to clear ` +
              "and gave up — more translations were asked for at once than this board runs",
          ),
        );
      }, FLOOR_WAIT_TIMEOUT_MS);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiting.push(wake);
    });
  }

  private leaveFloor(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }

  async translate(fragments: string[], language: string): Promise<TranslationResult> {
    await this.enterFloor();
    try {
      return await this.runTranslation(fragments, language);
    } finally {
      this.leaveFloor();
    }
  }

  private async runTranslation(fragments: string[], language: string): Promise<TranslationResult> {
    const { output, usage, model_swaps, refusals } = await runClaudeBoardCallJson(
      {
        exec: this.exec,
        label: "translation",
        systemPrompt: TRANSLATION_SYSTEM_PROMPT,
        prompt: buildPrompt(fragments, language, this.glossary),
        setting: TRANSLATION_SETTING,
        reasoning: false,
      },
      answerSchema,
    );
    // ids are the fragments' indexes: a missing, duplicate or extra id fails the whole call,
    // so a wrong pairing never reaches the cache (ADR 0296 決定4) — the turn still ran, so the usage rides along (ADR 0299 決定3)
    const byId = new Map(output.items.map(({ id, text }) => [id, text]));
    if (output.items.length !== fragments.length || fragments.some((_, id) => !byId.has(id))) {
      throw new BoardCallUsageError("translation answer ids do not match the fragments sent", TRANSLATION_SETTING, usage, model_swaps, refusals);
    }
    return { texts: fragments.map((_, id) => byId.get(id)!), usage, setting: TRANSLATION_SETTING, model_swaps, refusals };
  }
}
