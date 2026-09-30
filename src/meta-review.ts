import { z } from "zod";
import type { Db } from "./db.js";
import { appendEvent, type EventOrigin } from "./events.js";
import { type ListAgentTiers, settleStaleProposals } from "./execution-setting.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID, registerTask } from "./tasks.js";

/** memory の pull と routing の読み口が共有するページ長(定数 — spec #586 D)。ページ割りは `paged()` を通す。 */
export const PAGE_LENGTH = 20;

export function paged<T>(rows: readonly T[], page = 1): { rows: T[]; truncated: boolean } {
  return { rows: rows.slice((page - 1) * PAGE_LENGTH, page * PAGE_LENGTH), truncated: rows.length > page * PAGE_LENGTH };
}

/** 主題 memory の meta-review の接続で worker の memory verb を置き換える専用 verb(ADR 0122 決定2)。 */
export const MEMORY_META_REVIEW_VERBS = [
  "list_memory_candidates",
  "list_memory_behaviors",
  "list_precedents",
  "list_memory_entries",
  "list_memory_branches",
  "list_memory_proposals",
  "define_memory",
  "fold_memory",
  "move_memory",
  "move_memory_branch",
  "invalidate_memory",
  "propose_memory_change",
] as const;
/** 主題 routing の読み口と提案 verb、両主題が共有する Precedent の読み口(issue #917・#918)。 */
export const ROUTING_META_REVIEW_VERBS = [
  "list_routing_shadow",
  "list_allocations",
  "list_routing_cells",
  "read_routing_settings",
  "list_precedents",
  "propose_routing_change",
] as const;

/** 昇格規則の5択(spec #949 / issue #954 / ADR 0161 決定3): propose_memory_change の記述と memory meta-review の purpose が同じ文を載せる。 */
export const PROMOTION_RULE =
  "For each candidate, first fold it into an existing approved Behavior or Exemplar that already says the same (fold_memory with successor_id); " +
  "otherwise promote it to a Behavior when its scope and criterion can be stated so they hold for any future task; " +
  "fold it into an Exemplar (consolidate with kind exemplar) when that cannot be said but the concrete case carries quality worth reusing; " +
  "retire it with invalidate_memory reason rejected when it will become neither; leave it unpromoted while more material could still " +
  "change the judgment — there is no threshold or deadline.";

/** 周期 meta-review の主題(ADR 0120 決定2・ADR 0150 決定7): 登録する task の欄(文面と review のティア)、due 判定が数える
 *  材料の event 種別、接続で worker の memory verb を置き換える専用 verb。 */
export const META_REVIEW_SUBJECTS = {
  memory: {
    task: {
      title: "Memory meta-review",
      purpose:
        "Periodic meta-review of the board's memory store. Judge repeats among candidates and exemplars, redundant examples included, by reading them, not by counting. " +
        "Read the tree with list_memory_branches — every branch with the Definitions at its path and the scopes that hold entries under it — " +
        "and a branch's entries with list_memory_entries (path). " +
        "For a Definition, ask whether it holds true whatever leaf sits under its branch. " +
        "Where a branch holds entries but has no Definition in their scope or whole-board, write one that passes the same test " +
        "(define_memory) — in the workspace when the entries are all in one, whole-board otherwise. " +
        "When two or more workspaces define the same path, read the definitions: fold them into one whole-board definition when they mean the same " +
        "(define_memory with scope null and supersedes), and rename one branch when they do not (move_memory_branch). " +
        PROMOTION_RULE +
        " Changes to approved Behaviors and Exemplars go through the proposal verb: consolidate redundant ones into the one you keep (propose_memory_change's successor_id), " +
        "into a new candidate when they share a source, or into an existing candidate (candidate_id). Apply fixes to Knowledge and Definitions directly, and retire or fold a candidate directly " +
        "(fold_memory's successor_id folds it into an approved Behavior or Exemplar). " +
        "Fold Knowledge entries that state the same fact into one, across branches too (fold_memory). " +
        "Fix placement by moving, not by rewriting: move an entry that sits under the wrong branch (move_memory), rename a " +
        "branch by moving it whole, and merge two branches that hold the same thing by moving one into the other with " +
        "merge: true (move_memory_branch), and widen an entry every workspace needs to the whole board — " +
        "widen a candidate before you propose it, so the question shows the human the scope it will have. You cannot narrow " +
        "an entry to a workspace, move it between workspaces, or change the scope of an approved Behavior or Exemplar: when " +
        "you judge one of those right, say so with log_decision and leave the entry in place. " +
        "A Precedent with cause memory names the wrong entries it followed (entries): read them, then drop the wrong entry (reason capability) or replace it — " +
        "a Behavior or Exemplar through propose_memory_change, Knowledge through fold_memory or invalidate_memory. First read the past memory proposals with the human's answers and comments (list_memory_proposals) " +
        "and the invalidated candidates with invalidated_by, so you do not re-propose what a human rejected and do not repeat a retirement of your own. " +
        "A deferred proposal is one the human did not decide: read their comment, then propose it again when you still judge it right, or fold or retire it. " +
        "A consolidation that went stale or was deferred keeps its candidate: propose it again with candidate_id and the replaces you now judge right, " +
        "or approve the Behavior or Exemplar candidate alone to leave the entries it would have replaced in place. " +
        "Where a human amended a candidate when approving it (a superseded candidate whose invalidated_by is a question and whose successor a human wrote — not one you folded into an existing entry), draft closer to the human's wording.",
      completion_criteria:
        "every candidate and store change since the previous meta-review is either proposed, retired, folded, moved, applied (Knowledge / Definitions), or deliberately left as is",
      review_tier: "frontier",
    },
    material: ["memory_entry_created", "memory_entry_invalidated", "objection_attributed"],
    verbs: MEMORY_META_REVIEW_VERBS,
  },
  routing: {
    task: {
      title: "Routing meta-review",
      purpose:
        "Periodic meta-review of how the board routes work to execution settings. First read the current table and settings " +
        "with the past routing proposals, their answers, amendments and comments (read_routing_settings), so you do not " +
        "re-propose what was rejected or amended. Then read where the learner's recommendation diverged from what ran and how " +
        "those episodes ended, then the allocation reviews split by tier source and agent (an overpowered verdict under an " +
        "agent's default tier is not a registrant's declaration), and whether the judge ran on the worker's own model. Finish " +
        "with cells first seen and rows humans changed since the previous meta-review. Record each judgment with log_decision. " +
        "When the evidence says a row's tier or effort is wrong, propose replacing it with propose_routing_change. Base any " +
        "case for promoting the learner on the outcomes of the diverged episodes. When overpowered verdicts pile up under an " +
        "agent's own tier, propose lowering that agent's tier by exactly one step, never more.",
      completion_criteria:
        "every routing reading since the previous meta-review is judged, each judgment is logged as a decision, and each row change the evidence supports is proposed",
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

/** scheduler の poll が毎回呼ぶ: due な主題の meta-review を登録する(`agents` は registry の agent 一覧、無ければ registry の無い盤面)。due = 前回登録から周期が経ち、
 *  同主題の open な task・提案 question が無く、前回の watermark より後に主題の材料がある(前回が無ければ周期は満たす)。材料は meta-review 自身の産物 —— 提案
 *  question への回答が刻んだものと直接書き込み —— を数えない(ADR 0151)。 */
export function registerDueMetaReviews(db: Db, now: Date, agents?: ListAgentTiers): void {
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
    // registry の提案の pin は registry の変更 event が無いので、未決着を数える直前に盤面が今読んでいる registry と照合する(fetch はしない)
    if (subject === "routing" && agents) settleStaleProposals(db, now, null, agents);
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
    // 同じ主題の meta-review 自身の産物(回答が刻んだ question_id、review の直接書き込みの activity)は材料でない(ADR 0151)
    const found = db
      .prepare(
        `SELECT 1 FROM events WHERE id > ? AND kind IN (${material.map(() => "?").join(", ")})
           AND json_extract(payload, '$.question_id') IS NULL
           AND COALESCE(json_extract(payload, '$.activity'), json_extract(payload, '$.entry.author.activity')) IS NOT 'meta_review'`,
      )
      .get(last?.watermark ?? 0, ...material);
    if (found) registerMetaReview(db, subject, now);
  }
}
