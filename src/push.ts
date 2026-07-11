import webpush from "web-push";
import type { Db } from "./db.js";
import { HUMAN_FACING_KINDS } from "./events.js";
import { isQuietHours } from "./quiet-hours.js";
import { rowToTask, type Task, type TaskRow } from "./tasks.js";

/** A browser's Web Push registration (the standard PushSubscription shape,
 *  flattened) — endpoint is the push service URL, p256dh/auth the keys
 *  needed to encrypt a payload to it. */
export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export function listPushSubscriptions(db: Db): PushSubscription[] {
  return db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as PushSubscription[];
}

export function removePushSubscription(db: Db, endpoint: string): void {
  db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
}

export function savePushSubscription(db: Db, sub: PushSubscription): void {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth) VALUES (@endpoint, @p256dh, @auth)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(sub);
}

/** What a notification says and where tapping it goes — never HTML/markup,
 *  just the three fields the Web Push payload and the service worker's
 *  `notificationclick` handler both need (issue #14). */
export interface PushPayload {
  title: string;
  body: string;
  /** App-relative path the service worker opens on tap (deep link). */
  url: string;
}

/** The Web Push-facing seam (issue #14): sending a notification is never
 *  entrusted to inline fetch calls, only to this — an external API is a
 *  system boundary (mocking.md), faked in tests, real `web-push` for real. */
export interface PushClient {
  send(subscription: PushSubscription, payload: PushPayload): Promise<void>;
}

/** A question task's push notification content (issue #14): title is the
 *  question itself, body the purpose a human needs to decide, url a deep
 *  link the service worker opens straight into that single question's
 *  answer view on tap. */
export function buildQuestionPushPayload(task: Task): PushPayload {
  return { title: task.title, body: task.purpose, url: `/?question=${task.id}` };
}

/** Question tasks the human hasn't been pushed about yet — no row in
 *  question_notifications (issue #14) and still todo. A question answered
 *  directly on the board (bypassing the push deep link) before the next
 *  poll must not still count here — it would both re-push a resolved
 *  question and inflate the morning digest's "N questions" figure. */
export function listUnnotifiedQuestions(db: Db): Task[] {
  const rows = db
    .prepare(
      `SELECT t.* FROM tasks t
       LEFT JOIN question_notifications n ON n.task_id = t.id
       WHERE t.type = 'question' AND t.status = 'todo' AND n.task_id IS NULL
       ORDER BY t.created_at`,
    )
    .all() as TaskRow[];
  return rows.map(rowToTask);
}

export function markQuestionNotified(db: Db, taskId: string, now: Date): void {
  db.prepare(
    "INSERT OR IGNORE INTO question_notifications (task_id, notified_at) VALUES (?, ?)",
  ).run(taskId, now.toISOString());
}

/** Outside quiet hours, push each still-unnotified question individually
 *  (issue #14) — a poll rather than a hook at every registerTask call site,
 *  so every question-creating path (API, MCP escalate, watchdog failure,
 *  quarantine confirmation) is covered without threading push through each
 *  of them. Inside quiet hours, does nothing — they stay pending for the
 *  morning digest. Absent `push` (not configured), does nothing at all. */
export async function pollNotifications(deps: { db: Db; push?: PushClient }, now: Date): Promise<void> {
  const { db, push } = deps;
  if (!push) return;
  if (isQuietHours(db, now)) return;
  const subscriptions = listPushSubscriptions(db);
  for (const task of listUnnotifiedQuestions(db)) {
    const payload = buildQuestionPushPayload(task);
    for (const subscription of subscriptions) {
      await sendOrLog(push, subscription, payload);
    }
    markQuestionNotified(db, task.id, now);
  }
}

/** A dead/expired subscription (410/404, or any other push-service failure)
 *  must not abort the whole tick — it would strand every other subscription
 *  and every other still-unnotified question unmarked, retried forever on
 *  the next poll (github.ts/scheduler.ts's own "a failed external call logs
 *  and moves on" shape). */
async function sendOrLog(push: PushClient, subscription: PushSubscription, payload: PushPayload): Promise<void> {
  try {
    await push.send(subscription, payload);
  } catch (err) {
    console.error(`[push] failed to send to ${subscription.endpoint}:`, err);
  }
}

function getDigestCursor(db: Db): number {
  const { last_reported } = db
    .prepare("SELECT last_reported FROM digest_cursor WHERE id = 1")
    .get() as { last_reported: number };
  return last_reported;
}

function countLogEntriesSince(db: Db, lastReported: number): number {
  const placeholders = HUMAN_FACING_KINDS.map(() => "?").join(", ");
  const { count } = db
    .prepare(`SELECT COUNT(*) AS count FROM events WHERE id > ? AND kind IN (${placeholders})`)
    .get(lastReported, ...HUMAN_FACING_KINDS) as { count: number };
  return count;
}

/** What the morning digest reports (issue #14) — the same "N questions · M
 *  new log" shape the triage tab badge already shows, folded into one push
 *  instead of N individual ones once quiet hours end. */
export interface MorningDigest {
  questionCount: number;
  logCount: number;
  text: string;
}

export function buildMorningDigest(db: Db): MorningDigest {
  const questionCount = listUnnotifiedQuestions(db).length;
  const logCount = countLogEntriesSince(db, getDigestCursor(db));
  return { questionCount, logCount, text: `質問${questionCount}件、新規ログ${logCount}件` };
}

/** Marks every currently-pending question notified and advances the digest
 *  cursor to "now" (issue #14) — the digest's one push stands in for all of
 *  them, so none of it is reported again by a later individual poll or digest. */
export function recordDigestSent(db: Db, now: Date): void {
  for (const task of listUnnotifiedQuestions(db)) markQuestionNotified(db, task.id, now);
  const { id: lastEventId } = (db.prepare("SELECT MAX(id) AS id FROM events").get() as {
    id: number | null;
  }) ?? { id: null };
  db.prepare("UPDATE digest_cursor SET last_reported = ? WHERE id = 1").run(lastEventId ?? 0);
}

/** Fires the one summary push a quiet-hours-end transition folds everything
 *  into (issue #14) — a no-op if nothing accumulated (a quiet morning stays
 *  quiet, no empty "0 questions, 0 log entries" push). */
async function fireMorningDigest(db: Db, push: PushClient, now: Date): Promise<void> {
  const digest = buildMorningDigest(db);
  if (digest.questionCount === 0 && digest.logCount === 0) return;
  const payload: PushPayload = { title: "おはようございます", body: digest.text, url: "/" };
  for (const subscription of listPushSubscriptions(db)) await sendOrLog(push, subscription, payload);
  recordDigestSent(db, now);
}

export interface NotificationTick {
  run(now: Date): Promise<void>;
}

/** The quiet-hours-aware notification poll (issue #14): tracks whether the
 *  previous tick was inside quiet hours so the instant they end is
 *  detectable — that one transition gets a single morning digest instead of
 *  an individual push per question. Any other outside-quiet-hours tick just
 *  runs the ordinary per-question poll, which also catches anything the
 *  digest transition itself didn't (a question registered between ticks). */
export function createNotificationTick(db: Db, push: PushClient | undefined, initialNow: Date): NotificationTick {
  let wasQuietHours = isQuietHours(db, initialNow);
  // guards against two ticks overlapping (scheduler.ts's own `inFlight` shape)
  // — a slow tick (many subscriptions/questions) must not race the next timer
  // fire into double-sending or double-observing the quiet-hours transition
  let inFlight = false;
  return {
    async run(now: Date): Promise<void> {
      if (inFlight) return;
      inFlight = true;
      try {
        const nowQuiet = isQuietHours(db, now);
        if (push && wasQuietHours && !nowQuiet) {
          await fireMorningDigest(db, push, now);
        } else if (!nowQuiet) {
          await pollNotifications({ db, push }, now);
        }
        wasQuietHours = nowQuiet;
      } finally {
        inFlight = false;
      }
    },
  };
}

export interface VapidConfig {
  subject: string;
  publicKey: string;
  privateKey: string;
}

/** Real implementation: encrypts and delivers through whichever push service
 *  the subscription's endpoint belongs to (issue #14) — no tidepool-side
 *  server to run, `web-push` speaks the protocol directly. */
export class WebPushClient implements PushClient {
  constructor(vapid: VapidConfig) {
    webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey);
  }

  async send(subscription: PushSubscription, payload: PushPayload): Promise<void> {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
    );
  }
}
