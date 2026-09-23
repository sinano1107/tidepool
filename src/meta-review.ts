import { z } from "zod";
import type { Db } from "./db.js";
import { appendEvent, type EventOrigin } from "./events.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID, registerTask } from "./tasks.js";

/** memory の pull と routing の読み口が共有するページ長(定数 — spec #586 D)。 */
export const PAGE_LENGTH = 20;

/** 主題 memory の meta-review の接続で worker の memory verb を置き換える専用 verb(ADR 0122 決定2)。 */
export const MEMORY_META_REVIEW_VERBS = [
  "list_memory_candidates",
  "list_memory_behaviors",
  "list_precedents",
  "list_memory_entries",
  "define_memory",
  "fold_memory",
  "move_memory",
  "invalidate_memory",
  "propose_memory_change",
] as const;
/** 主題 routing の読み口と、両主題が共有する Precedent の読み口(issue #917)。 */
export const ROUTING_META_REVIEW_VERBS = [
  "list_routing_shadow",
  "list_allocations",
  "list_routing_cells",
  "read_routing_settings",
  "list_precedents",
] as const;

/** 周期 meta-review の主題(ADR 0120 決定2・ADR 0150 決定7): 登録する task の欄(文面と review のティア)、due 判定が数える
 *  材料の event 種別、接続で worker の memory verb を置き換える専用 verb。 */
export const META_REVIEW_SUBJECTS = {
  memory: {
    task: {
      title: "Memory meta-review",
      purpose:
        "Periodic meta-review of the board's memory store. Judge repeats among candidates by reading them, not by counting. " +
        "For a Behavior, ask whether it holds true whatever leaf sits under its branch. Propose changes through the proposal verb; " +
        "apply fixes directly only to Knowledge and Definitions. Read the invalidated candidates and their reasons first, so you do not re-propose what was rejected.",
      completion_criteria:
        "every candidate and store change since the previous meta-review is either proposed, applied (Knowledge / Definitions only), or deliberately left as is",
      review_tier: "frontier",
    },
    material: ["memory_entry_created", "memory_entry_invalidated", "objection_attributed"],
    verbs: MEMORY_META_REVIEW_VERBS,
  },
  routing: {
    task: {
      title: "Routing meta-review",
      purpose:
        "Periodic meta-review of how the board routes work to execution settings. Read the current table and settings first, " +
        "then where the learner's recommendation diverged from what ran and how those episodes ended, then the allocation " +
        "reviews split by tier source and agent (an overpowered verdict under an agent's default tier is not a registrant's " +
        "declaration), and whether the judge ran on the worker's own model. Finish with cells first seen and rows humans changed " +
        "since the previous meta-review. Record each judgment with log_decision, and base any case for promoting the learner " +
        "on the outcomes of the diverged episodes.",
      completion_criteria: "every routing reading since the previous meta-review is judged and each judgment is logged as a decision",
      review_tier: "frontier",
    },
    material: ["allocation_reviewed", "worker_exited", "execution_settings_changed"],
    verbs: ROUTING_META_REVIEW_VERBS,
  },
} as const;
export type MetaReviewSubject = keyof typeof META_REVIEW_SUBJECTS;

/** この task が meta-review ならその主題、そうでなければ null(専用 verb の登録と門が読む、ADR 0122 決定2)。 */
export function metaReviewSubjectOf(db: Db, taskId: string): MetaReviewSubject | null {
  return (db.prepare("SELECT meta_review_subject FROM tasks WHERE id = ?").get(taskId) as { meta_review_subject: MetaReviewSubject | null } | undefined)
    ?.meta_review_subject ?? null;
}

/** 読み手の task より前の、同主題の最新の登録の watermark(読み口の既定、無ければ 0)。読み手自身の登録の watermark は
 *  「今」なので除く。 */
export function previousMetaReviewWatermark(db: Db, readerTaskId: string): number {
  return (
    db
      .prepare(
        `SELECT json_extract(payload, '$.material_watermark') AS watermark FROM events
          WHERE kind = 'meta_review_registered' AND json_extract(payload, '$.subject') = (SELECT meta_review_subject FROM tasks WHERE id = @task)
            AND task_id IS NOT @task ORDER BY id DESC LIMIT 1`,
      )
      .get({ task: readerTaskId }) as { watermark: number } | undefined
  )?.watermark ?? 0;
}

/** 主題の meta-review を盤面名義で登録する(周期が通る1本、due は見ない)。 */
export function registerMetaReview(db: Db, subject: MetaReviewSubject, now: Date): void {
  db.transaction(() => {
    const task = registerTask(db, { type: "review", ...META_REVIEW_SUBJECTS[subject].task, meta_review_subject: subject }, now, BOARD_WORKER_ID, "board");
    const { watermark } = db.prepare("SELECT MAX(id) AS watermark FROM events").get() as { watermark: number };
    appendEvent(db, {
      taskId: task.id,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "meta_review_registered", subject, material_watermark: watermark },
      at: now,
    });
  })();
}

/** 周期の既定(日、ADR 0120 決定2)。間隔の下限で、全主題に共通。 */
const DEFAULT_PERIOD_DAYS = 7;

export const metaReviewSettingsChangeSchema = z.object({ period_days: z.number().int().positive() });
type MetaReviewSettings = { period_days: number };

export function readMetaReviewSettings(db: Db): MetaReviewSettings {
  const row = db.prepare("SELECT period_days FROM meta_review_defaults WHERE id = 1").get() as { period_days: number | null } | undefined;
  return { period_days: row?.period_days ?? DEFAULT_PERIOD_DAYS };
}

/** 周期を書き、盤面スコープの操作イベントとして経路つきで残す(changeMemorySettings と同じ形)。
 *  返り値は meta_review_settings_changed の event id。 */
export function changeMetaReviewSettings(db: Db, change: z.infer<typeof metaReviewSettingsChangeSchema>, origin: EventOrigin, at: Date): number {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO meta_review_defaults (id, period_days) VALUES (1, @period_days)
       ON CONFLICT(id) DO UPDATE SET period_days = excluded.period_days`,
    ).run(change);
    return appendEvent(db, {
      taskId: null,
      workerId: HUMAN_WORKER_ID,
      origin,
      payload: { kind: "meta_review_settings_changed", ...readMetaReviewSettings(db) },
      at,
    });
  })();
}

/** scheduler の poll が毎回呼ぶ: due な主題の meta-review を登録する。due = 前回登録から周期が経ち、
 *  同主題の open な task・提案 question が無く、前回の watermark より後に主題の材料がある(前回が無ければ周期は満たす)。 */
export function registerDueMetaReviews(db: Db, now: Date): void {
  const periodMs = readMetaReviewSettings(db).period_days * 24 * 60 * 60 * 1000;
  for (const subject of Object.keys(META_REVIEW_SUBJECTS) as MetaReviewSubject[]) {
    const { material } = META_REVIEW_SUBJECTS[subject];
    const last = db
      .prepare(
        `SELECT created_at, json_extract(payload, '$.material_watermark') AS watermark FROM events
          WHERE kind = 'meta_review_registered' AND json_extract(payload, '$.subject') = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(subject) as { created_at: string; watermark: number } | undefined;
    if (last && Date.parse(last.created_at) + periodMs > now.getTime()) continue;
    // 未決着 = 同主題の open な task か、親が同主題の meta-review である open な提案 question(ADR 0120 決定2)。
    // 提案の kind では数えない —— routing の meta-review は registry 種別の提案も出す(spec #916 A)
    const open = db
      .prepare(
        `SELECT 1 FROM tasks WHERE status IN ('todo', 'in_progress')
           AND (meta_review_subject = @subject
             OR (question_proposal IS NOT NULL AND parent_id IN (SELECT id FROM tasks WHERE meta_review_subject = @subject)))`,
      )
      .get({ subject });
    if (open) continue;
    const found = db
      .prepare(`SELECT 1 FROM events WHERE id > ? AND kind IN (${material.map(() => "?").join(", ")})`)
      .get(last?.watermark ?? 0, ...material);
    if (found) registerMetaReview(db, subject, now);
  }
}
