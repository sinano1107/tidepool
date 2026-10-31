import { BoardCallUsageError, recordBoardCall } from "./board-call-usage.js";
import type { Db } from "./db.js";
import { getEvent } from "./events.js";
import { listMemoryEntries } from "./memory.js";
import { getTask, splitHandoffMarkdown } from "./tasks.js";
import { isAnthropicBoardCallBlocked } from "./throttle.js";
import type { TranslationClient } from "./translate.js";
import { getCachedTranslation, hashSource, saveTranslation } from "./translation-cache.js";

/** Raised when a translation request names a target that doesn't resolve to
 *  translatable source text — an unknown event id, an event that isn't a
 *  decision-log entry, a completion report with no result text (issue #47).
 *  Deliberately its own type rather than domain-error.ts's `DomainError`: this is a
 *  "no such resource" failure (mapped to 404 by the API layer), not the
 *  in-authority-but-rejected shape `DomainError` covers (400/409 there). */
export class TranslationTargetError extends Error {}

/** How many fragments one translation call carries at most (ADR 0296 決定4) —
 *  a target with more is split into calls of this size, fired one after another.
 *  Also the most event ids one `log_entries` request may name; webui/triage-screen.tsx
 *  copies it to size its chunks. */
export const TRANSLATION_FRAGMENTS_PER_CALL = 20;

export type TranslationOutcome =
  | { status: "translated"; text: string; cached: boolean }
  | { status: "throttled" };

/** One display target's fragments, cache-first (issue #47 / ADR 0296 決定4):
 *  only the fragments not yet cached go out, in calls of at most
 *  TRANSLATION_FRAGMENTS_PER_CALL; each fragment is cached and each call
 *  leaves one `translation` row in `board_calls`. A cache hit never touches the client
 *  or the throttle gate (an already-paid-for translation costs nothing to
 *  show again, even while throttled); a call is skipped while the Anthropic
 *  Board call is unavailable (`isAnthropicBoardCallBlocked`), and then the
 *  whole target reports throttled — a target reads as one coherent unit,
 *  never a partly translated blob. A call that fails caches nothing, but
 *  still leaves its row when the CLI reported usage (ADR 0299 決定3). */
async function translateFragments(
  db: Db,
  client: TranslationClient,
  sources: string[],
  language: string,
  now: Date,
): Promise<{ status: "translated"; texts: string[]; cached: boolean } | { status: "throttled" }> {
  const translated = new Map<string, string>();
  for (const source of sources) {
    const hit = getCachedTranslation(db, hashSource(source), language);
    if (hit !== undefined) translated.set(source, hit);
  }
  const misses = [...new Set(sources)].filter((source) => !translated.has(source));
  for (let at = 0; at < misses.length; at += TRANSLATION_FRAGMENTS_PER_CALL) {
    if (isAnthropicBoardCallBlocked(db)) return { status: "throttled" };
    const chunk = misses.slice(at, at + TRANSLATION_FRAGMENTS_PER_CALL);
    const answer = await client.translate(chunk, language).catch((err: unknown) => {
      if (err instanceof BoardCallUsageError) recordBoardCall(db, "translation", err.setting, err.usage, now, chunk.length, err);
      throw err;
    });
    const { texts, usage, setting } = answer;
    chunk.forEach((source, i) => {
      saveTranslation(db, hashSource(source), language, texts[i]!, now);
      translated.set(source, texts[i]!);
    });
    recordBoardCall(db, "translation", setting, usage, now, chunk.length, answer);
  }
  return { status: "translated", texts: sources.map((source) => translated.get(source)!), cached: misses.length === 0 };
}

/** One fragment as a target of its own (a log entry, a human's original, the pickup-time query). */
export async function translateSource(
  db: Db,
  client: TranslationClient,
  source: string,
  language: string,
  now: Date,
): Promise<TranslationOutcome> {
  const outcome = await translateFragments(db, client, [source], language, now);
  return outcome.status === "throttled" ? outcome : { status: "translated", text: outcome.texts[0]!, cached: outcome.cached };
}

/** Resolves the translatable source text for a decision-log entry or a
 *  completion report (issue #47's first two translation targets) — both are
 *  `HUMAN_FACING_KINDS` rows in the events table, so one event-id lookup
 *  covers either. */
function resolveLogEntrySource(db: Db, eventId: number): string {
  const event = getEvent(db, eventId);
  if (!event) throw new TranslationTargetError(`no event with id ${eventId}`);
  if (event.payload.kind === "decision_logged" || event.payload.kind === "premise_breached" || event.payload.kind === "memory_written") return event.payload.line;
  if (event.payload.kind === "task_completed") {
    if (event.payload.result === null) {
      throw new TranslationTargetError(`event ${eventId} has no completion report text`);
    }
    return event.payload.result;
  }
  throw new TranslationTargetError(`event ${eventId} is not a decision-log entry`);
}

/** A decision-log line or a completion report (issue #47), by event id. */
export async function translateLogEntry(
  db: Db,
  client: TranslationClient,
  eventId: number,
  language: string,
  now: Date,
): Promise<TranslationOutcome> {
  const source = resolveLogEntrySource(db, eventId);
  return translateSource(db, client, source, language, now);
}

/** Several decision-log lines or completion reports as one target (ADR 0296 決定4) —
 *  the log skim's chunk. Every id resolves before anything is sent, so one
 *  unresolvable id fails the whole request. */
export async function translateLogEntries(
  db: Db,
  client: TranslationClient,
  eventIds: number[],
  language: string,
  now: Date,
): Promise<{ status: "translated"; entries: { event_id: number; text: string }[] } | { status: "throttled" }> {
  const sources = eventIds.map((eventId) => resolveLogEntrySource(db, eventId));
  const outcome = await translateFragments(db, client, sources, language, now);
  if (outcome.status === "throttled") return outcome;
  return { status: "translated", entries: eventIds.map((event_id, i) => ({ event_id, text: outcome.texts[i]! })) };
}

/** 記憶のエントリ1件の title と text を表示言語へ(issue #593 / #603、settings の一覧で原文の無い agent 由来を読む)。 */
export async function translateMemoryEntry(
  db: Db,
  client: TranslationClient,
  entryId: number,
  language: string,
  now: Date,
): Promise<{ status: "translated"; title: string; text: string; cached: boolean } | { status: "throttled" }> {
  // ponytail: 表を全件読んで1行を探す。記憶が数千行になったら id で引く export を足す
  const entry = listMemoryEntries(db, {}).find((e) => e.id === entryId);
  if (!entry) throw new TranslationTargetError(`no memory entry ${entryId}`);
  const outcome = await translateFragments(db, client, [entry.title, entry.text], language, now);
  if (outcome.status === "throttled") return outcome;
  const [title, text] = outcome.texts as [string, string];
  return { status: "translated", title, text, cached: outcome.cached };
}

export type TranslateHandoffOutcome =
  | { status: "translated"; doc: string; cached: boolean }
  | { status: "throttled" };

/** The handoff doc translation target (issue #47): headings are recovered
 *  mechanically by splitHandoffMarkdown and never sent to the client — only
 *  each section's body is translated, then reassembled under its original
 *  (English) heading. */
export async function translateHandoff(
  db: Db,
  client: TranslationClient,
  taskId: string,
  language: string,
  now: Date,
): Promise<TranslateHandoffOutcome> {
  const task = getTask(db, taskId);
  if (!task) throw new TranslationTargetError(`no task with id ${taskId}`);
  if (!task.handoff_doc) throw new TranslationTargetError(`task ${taskId} has no handoff doc`);
  const sections = splitHandoffMarkdown(task.handoff_doc);
  const outcome = await translateFragments(db, client, sections.map((section) => section.body), language, now);
  if (outcome.status === "throttled") return outcome;
  const doc = sections.map((section, i) => `## ${section.heading}\n\n${outcome.texts[i]}`).join("\n\n");
  return { status: "translated", doc, cached: outcome.cached };
}

export interface TranslatedQuestionItem {
  title: string;
  detail?: string;
}

export type TranslateQuestionOutcome =
  | { status: "translated"; purpose: string; items: TranslatedQuestionItem[]; cached: boolean }
  | { status: "throttled" };

/** A question's purpose and each item's title/detail (issue #47) — GLOSSARY.md's
 *  scope exclusion: option labels and the recommendation are never sent here
 *  (a mistranslated option is a 30-second decision an agent reads back, ADR
 *  0015's precision addendum keeps those original). */
export async function translateQuestion(
  db: Db,
  client: TranslationClient,
  taskId: string,
  language: string,
  now: Date,
): Promise<TranslateQuestionOutcome> {
  const task = getTask(db, taskId);
  if (!task) throw new TranslationTargetError(`no task with id ${taskId}`);
  if (task.type !== "question") throw new TranslationTargetError(`task ${taskId} is not a question`);
  const items = task.question_items ?? [];
  const sources = [
    task.purpose,
    ...items.flatMap((item) => (item.detail === undefined ? [item.title] : [item.title, item.detail])),
  ];
  const outcome = await translateFragments(db, client, sources, language, now);
  if (outcome.status === "throttled") return outcome;
  // the texts come back in the order the sources were laid out above
  const texts = outcome.texts.values();
  const next = () => texts.next().value!;
  const purpose = next();
  return {
    status: "translated",
    purpose,
    items: items.map((item) => ({ title: next(), detail: item.detail === undefined ? undefined : next() })),
    cached: outcome.cached,
  };
}
