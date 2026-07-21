import type { Db } from "./db.js";
import { getEvent } from "./events.js";
import { getTask, splitHandoffMarkdown } from "./tasks.js";
import { getThrottleState } from "./throttle.js";
import type { TranslationClient } from "./translate.js";
import { getCachedTranslation, hashSource, saveTranslation } from "./translation-cache.js";

/** Raised when a translation request names a target that doesn't resolve to
 *  translatable source text — an unknown event id, an event that isn't a
 *  decision-log entry, a completion report with no result text (issue #47).
 *  Deliberately its own type rather than tasks.ts's `DomainError`: this is a
 *  "no such resource" failure (mapped to 404 by the API layer), not the
 *  in-authority-but-rejected shape `DomainError` covers (400/409 there). */
export class TranslationTargetError extends Error {}

export type TranslationOutcome =
  | { status: "translated"; text: string; cached: boolean }
  | { status: "throttled" };

/** Resolves one translation, cache-first (issue #47): a cache hit never
 *  touches the client or the throttle gate (an already-paid-for translation
 *  costs nothing to show again, even while throttled). A cache miss checks
 *  `getThrottleState` — the raw last-observed reading, not `isPickupBlocked`'s
 *  now-resolved variant, since there is no /usage poll on this path to refresh
 *  it — and skips the call entirely while throttled (CONTEXT.md's Throttle:
 *  a worker budget). */
export async function translateSource(
  db: Db,
  client: TranslationClient,
  source: string,
  language: string,
  now: Date,
): Promise<TranslationOutcome> {
  const hash = hashSource(source);
  const cached = getCachedTranslation(db, hash, language);
  if (cached) return { status: "translated", text: cached.translated, cached: true };
  if (getThrottleState(db).throttled) return { status: "throttled" };
  const result = await client.translate(source, language);
  saveTranslation(db, hash, language, result.text, result.usage, now);
  return { status: "translated", text: result.text, cached: false };
}

/** Resolves the translatable source text for a decision-log entry or a
 *  completion report (issue #47's first two translation targets) — both are
 *  `HUMAN_FACING_KINDS` rows in the events table, so one event-id lookup
 *  covers either. */
function resolveLogEntrySource(db: Db, eventId: number): string {
  const event = getEvent(db, eventId);
  if (!event) throw new TranslationTargetError(`no event with id ${eventId}`);
  if (event.payload.kind === "decision_logged") return event.payload.line;
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

/** Internal short-circuit for a multi-fragment translation (a handoff's
 *  sections, a question's purpose/items): thrown by translateTracked instead
 *  of each caller repeating its own "outcome.status === 'throttled' → early
 *  return" check. Never escapes this module — every exported multi-fragment
 *  translator catches it at its own top level. */
class ThrottledSignal extends Error {}

/** Translates one fragment and folds its cache-hit status into `tracker`
 *  (issue #47) — the shared body behind translateHandoff/translateQuestion's
 *  per-fragment loops, so "translate, note throttled, fold into allCached"
 *  is written once. */
async function translateTracked(
  db: Db,
  client: TranslationClient,
  source: string,
  language: string,
  now: Date,
  tracker: { allCached: boolean },
): Promise<string> {
  const outcome = await translateSource(db, client, source, language, now);
  if (outcome.status === "throttled") throw new ThrottledSignal();
  tracker.allCached = tracker.allCached && outcome.cached;
  return outcome.text;
}

export type TranslateHandoffOutcome =
  | { status: "translated"; doc: string; cached: boolean }
  | { status: "throttled" };

/** The handoff doc translation target (issue #47): headings are recovered
 *  mechanically by splitHandoffMarkdown and never sent to the client — only
 *  each section's body is translated, then reassembled under its original
 *  (English) heading. A miss on ANY section while throttled reports the
 *  whole doc as throttled rather than a partially-translated blob — a
 *  handoff reads as one coherent unit, same "all English or all translated"
 *  posture the toggle UX implies. */
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

  const tracker = { allCached: true };
  try {
    const translatedSections: string[] = [];
    for (const section of sections) {
      const text = await translateTracked(db, client, section.body, language, now, tracker);
      translatedSections.push(`## ${section.heading}\n\n${text}`);
    }
    return { status: "translated", doc: translatedSections.join("\n\n"), cached: tracker.allCached };
  } catch (err) {
    if (err instanceof ThrottledSignal) return { status: "throttled" };
    throw err;
  }
}

export interface TranslatedQuestionItem {
  title: string;
  detail?: string;
}

export type TranslateQuestionOutcome =
  | { status: "translated"; purpose: string; items: TranslatedQuestionItem[]; cached: boolean }
  | { status: "throttled" };

/** A question's purpose and each item's title/detail (issue #47) — CONTEXT.md's
 *  scope exclusion: option labels and the recommendation are never sent here
 *  (a mistranslated option is a 30-second decision an agent reads back, ADR
 *  0015's precision addendum keeps those original). Same all-or-nothing
 *  throttle posture as translateHandoff: a question card is one coherent
 *  unit. */
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

  const tracker = { allCached: true };
  try {
    const purpose = await translateTracked(db, client, task.purpose, language, now, tracker);
    const items: TranslatedQuestionItem[] = [];
    for (const item of task.question_items ?? []) {
      const title = await translateTracked(db, client, item.title, language, now, tracker);
      const detail =
        item.detail !== undefined
          ? await translateTracked(db, client, item.detail, language, now, tracker)
          : undefined;
      items.push({ title, detail });
    }
    return { status: "translated", purpose, items, cached: tracker.allCached };
  } catch (err) {
    if (err instanceof ThrottledSignal) return { status: "throttled" };
    throw err;
  }
}
