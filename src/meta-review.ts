import { z } from "zod";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "./actor-id.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, type EventKind, type EventOrigin, type EventPayload, type EventRowOf, getEvent, type Judgment, latestEventOfTask, parseEventRow } from "./events.js";
import { type ListAgentTiers, readExecutionSettings, settleStaleProposals } from "./execution-setting.js";
import { whyNotPositiveInteger } from "./positive-integer.js";
import { normalizeText, whyBlank } from "./required-text.js";
import { unsettledSql } from "./task-status.js";
import { finishTask, getTask, type HandoffDoc, isRepairType, lineageSubjectOf, lineageSubjectSql, metaReviewSubjectOf, registerTask, type Task, workSideTypeSql } from "./tasks.js";

/** worker の memory verb。主題 memory の meta-review の接続では `MEMORY_META_REVIEW_VERBS` に置き換わる
 *  (ADR 0122 決定2)。MCP の登録と Codex の `enabled_tools` が同じ差を写す。 */
export const WORKER_MEMORY_VERBS = ["record_knowledge", "define_memory_branch", "browse_memory", "search_memory", "read_memory"] as const;
/** memory_repair の書き込みの行の修理 verb(ADR 0252 決定4 / ADR 0272 決定3 / ADR 0281)。`invalidate_memory` / `move_memory` /
 *  `move_memory_branch` は meta-review と同じ tool で、射程は門が対象で切り替える。 */
export const MEMORY_REPAIR_VERBS = ["invalidate_memory", "restore_memory", "move_memory", "move_memory_branch", "restore_memory_branch", "replace_memory"] as const;
/** 主題 memory の meta-review の接続で worker の memory verb を置き換える専用 verb(ADR 0122 決定2)。判断の行を運ぶ記憶の修理子も
 *  持つ(ADR 0279 決定3、memoryRepairVerbs)。 */
export const MEMORY_META_REVIEW_VERBS = [
  "list_memory_candidates",
  "list_precedents",
  "list_memory_entries",
  "read_memory_entries",
  "list_memory_branches",
  "list_memory_proposals",
  "search_memory_entries",
  "define_memory",
  "fold_memory",
  "move_memory",
  "move_memory_branch",
  "invalidate_memory",
  "propose_memory_change",
] as const;
/** 主題 routing の読み口と提案 verb、両主題が共有する Precedent の読み口(issue #917・#918)と指針の節の id 読み(ADR 0279 決定2)。 */
export const ROUTING_META_REVIEW_VERBS = [
  // 指針の節の本文の読み口(ADR 0279 決定2)
  "read_memory_entries",
  "list_routing_shadow",
  "list_allocations",
  "list_routing_cells",
  "read_routing_settings",
  "list_precedents",
  "propose_routing_change",
] as const;

/** 昇格規則の5択(spec #949 / issue #954 / ADR 0161 決定3): propose_memory_change の記述と memory meta-review の purpose が同じ文を載せる。 */
export const PROMOTION_RULE =
  "For each candidate, first fold it into an existing approved Behavior or Exemplar that already says the same (find it with search_memory_entries; fold_memory with successor_id); " +
  "otherwise promote it to a Behavior when its scope and criterion can be stated so they hold for any future task; " +
  "fold it into an Exemplar (consolidate with kind exemplar) when that cannot be said but the concrete case carries quality worth reusing; " +
  "retire it with invalidate_memory reason rejected when it will become neither; leave it unpromoted while more material could still " +
  "change the judgment — there is no threshold or deadline.";

/** tier が何かの半文(ADR 0324 決定3): 配分評価は setting の出所の半文を、起草は `TIER_DEFINITION_RULE` を後に続ける。 */
export const TIER_QUALITY_FLOOR = "The tier is the quality floor this session ran at";

/** 段の定義の置き場(ADR 0200 決定7): Behavior の起草側(RCA の propose_from_material・Board call)と memory meta-review が同じ文を載せる。 */
export const TIER_DEFINITION_RULE =
  "A tier's definition is not a Behavior: it belongs in the tier's description. A habit of declaring tiers specific to one workspace or writer may be a Behavior.";

/** 材料の述語の1組(ADR 0312 決定1): due が数え節が読む event の where(`events` の行の SQL、行を受け取る読み手の主題もここ)と、
 *  その行を描く節の部分の見出し。 */
type MaterialPredicate = { where: string; part: string };
type MaterialMap = { [K in EventKind]?: MaterialPredicate };
/** due と節の読みが使う組の部分: where だけ。 */
type MaterialWhere = { [K in EventKind]?: Pick<MaterialPredicate, "where"> };

/** 同じ主題の meta-review 自身の産物を除く印(ADR 0151 決定3): 提案 question への回答が刻んだ question_id と、review の直接書き込みの
 *  activity(無効化は payload の、作成は entry の書き手の)。店の変更と routing の `allocation_reviewed`・`execution_settings_changed` の組だけが持つ。 */
const NOT_OWN_PRODUCT_SQL = `json_extract(payload, '$.question_id') IS NULL
  AND COALESCE(json_extract(payload, '$.activity'), json_extract(payload, '$.entry.author.activity')) IS NOT 'meta_review'`;

/** event の task の行の主題(lineageSubjectOf、主題の無い行は memory)が `subject` か(ADR 0279 決定6)。null は主題の無い読み手で全件。 */
export const rowSubjectSql = (subject: "memory" | "routing" | null) =>
  subject === null ? "1" : `IFNULL(${lineageSubjectSql("events.task_id")}, 'memory') = '${subject}'`;

/** memory の読み手が受け取る帰責(ADR 0312 決定4): 行の主題が memory か、行の主題を問わず cause memory(payload の印 —— 行を読まない)。 */
const MEMORY_ATTRIBUTION_SQL = `(${rowSubjectSql("memory")} OR json_extract(payload, '$.cause') = 'memory')`;

/** 本番の session の event(ADR 0319 決定3): event の task が work 側(学習器の観測の領域、ADR 0272 決定4 追記)で受験者でない。
 *  shadow 行を書く pickup と、閉じた本番 session の exit が持つ。 */
const PRODUCTION_SESSION_SQL = `EXISTS (SELECT 1 FROM tasks WHERE tasks.id = events.task_id AND ${workSideTypeSql("tasks")} AND tasks.interview_target_id IS NULL)`;

/** 周期 meta-review の主題(ADR 0120 決定2・ADR 0150 決定7): 登録する task の欄(文面と review のティア)、due 判定が数え節が描く
 *  材料の kind → 組の写像(ADR 0312 決定1)、接続で worker の memory verb を置き換える専用 verb。 */
export const META_REVIEW_SUBJECTS = {
  memory: {
    task: {
      title: "Memory meta-review",
      purpose:
        "Periodic meta-review of the board's memory store. This cycle's material is in your prompt, in the Memory meta-review material section: " +
        "the store changes since the previous memory meta-review, every live candidate, the decisions whose objections were attributed since then, " +
        "the human stops attributed since then, the memory proposals answered or settled since then, the branch list, and the items to judge. " +
        "Every item to judge needs a judgment: act on it with the verbs below, or leave it as is. End the session with complete_memory_review, " +
        "listing each item you leave as is (with a reason when it helps). " +
        "Judge repeats among candidates and exemplars, redundant examples included, by reading them, not by counting. " +
        "Read the case of a candidate or an Exemplar — the example it was drafted from — with read_memory_entries. " +
        "For each store change, check that it fits the Definition of its branch (move it with move_memory when it does not), and look for an entry " +
        "that already says the same with search_memory_entries with like (its id). When that finds an entry that was dropped, read why it was dropped " +
        "(its invalidation_reason, and for a rejected candidate the human's comment in list_memory_proposals) before you decide whether to keep the new one. " +
        "Where a store change rewrote a Definition, read the entries under its branch with list_memory_entries (path). " +
        "The branch list shows every branch with the Definitions at its path and the scopes that hold entries under it. " +
        "For a Definition, ask whether it holds true whatever leaf sits under its branch. " +
        "Where a branch holds entries but has no Definition in their scope or whole-board, write one that passes the same test " +
        "(define_memory) — in the workspace when the entries are all in one, whole-board otherwise. " +
        PROMOTION_RULE +
        " " +
        TIER_DEFINITION_RULE +
        " Changes to approved Behaviors and Exemplars go through the proposal verb: consolidate redundant ones into the one you keep (propose_memory_change's successor_id), " +
        "into a new candidate when they share a source, or into an existing candidate (candidate_id). Apply fixes to Knowledge and Definitions directly, and retire or fold a candidate directly " +
        "(fold_memory's successor_id folds it into an approved Behavior or Exemplar). " +
        "Fold Knowledge entries that state the same fact into one, across branches too (fold_memory). " +
        "Fix placement by moving, not by rewriting: move an entry that sits under the wrong branch (move_memory), rename a " +
        "branch by moving it whole, and merge two branches that hold the same thing by moving one into the other with " +
        "merge: true (move_memory_branch), and widen an entry every workspace needs to the whole board — " +
        "widen a candidate before you propose it, so the question shows the human the scope it will have. You cannot narrow " +
        "an entry to a workspace, move it between workspaces, or change the scope of an approved Behavior or Exemplar: when " +
        "you judge one of those right, leave the entry in place and say so — in its reason in complete_memory_review when the entry " +
        "is an item to judge, otherwise in one log_decision line naming the entry id, or the branch path and scope, and the scope you judged right (complete_memory_review " +
        "refuses an entry not on the injected list). " +
        "A Precedent or an attributed stop with cause memory names the wrong entries it followed (wrong_memory_entries), each an item to judge: read them with read_memory_entries, then drop the wrong entry (reason capability) or replace it — " +
        "a Behavior or Exemplar through propose_memory_change, Knowledge through fold_memory or invalidate_memory. The proposals settled since the previous meta-review are in the material section; read " +
        "earlier ones, with the human's answers and comments, with list_memory_proposals, and the invalidated candidates with invalidated_by (list_memory_candidates " +
        "with include_invalidated), so you do not repeat a retirement of your own. A rejected proposal always carries the human's reason: " +
        "propose it again only when that reason no longer holds. " +
        "A deferred proposal is one the human did not decide: read their comment, then propose it again when you still judge it right, or fold or retire it. " +
        "When you propose a past proposal again, use the tail_id for each entry its relocated lists: that entry was moved or restored. " +
        "A consolidation that went stale or was deferred keeps its candidate: propose it again with candidate_id and the replaces you now judge right, " +
        "or approve the Behavior or Exemplar candidate alone to leave the entries it would have replaced in place. " +
        "Where a human amended a candidate when approving it (a superseded candidate whose invalidated_by is a question and whose successor a human wrote — not one you folded into an existing entry), draft closer to the human's wording.",
      completion_criteria:
        "every item to judge in this cycle's material is either proposed, retired, folded, moved, applied (Knowledge / Definitions), or listed as left as is in complete_memory_review",
    },
    material: {
      memory_entry_created: { where: NOT_OWN_PRODUCT_SQL, part: "Store changes" },
      memory_entry_invalidated: { where: NOT_OWN_PRODUCT_SQL, part: "Store changes" },
      objection_attributed: { where: MEMORY_ATTRIBUTION_SQL, part: "Objected decisions" },
      stop_attributed: { where: MEMORY_ATTRIBUTION_SQL, part: "Stops attributed" },
    } as const satisfies MaterialMap,
    verbs: MEMORY_META_REVIEW_VERBS,
  },
  routing: {
    task: {
      title: "Routing meta-review",
      purpose:
        "Periodic meta-review of how the board routes work to execution settings. This cycle's material is in your prompt, in the " +
        "Routing meta-review material section: the current table and settings, the shadow rows since the previous routing meta-review " +
        "where the learner's recommendation diverged from what ran, the allocation reviews since then, the cells first seen and the rows " +
        "humans changed since then, the decisions whose objections were attributed since then, the human stops attributed since then, " +
        "the routing proposals answered or settled since then, and the items to judge. " +
        "Every item to judge needs a judgment: propose a change to it, or leave it unchanged. End the session with complete_routing_review, " +
        "listing each item you leave unchanged as no_change (with a reason when it helps). " +
        "A diverged row is a pickup whose recommended and actual cells differ, with the track records it carried at that pickup; the section counts every " +
        "shadow row of the window but lists only the diverged ones, without outcomes (read a row's outcome with list_routing_shadow) — read the matched rows, and anything before the previous meta-review, " +
        "with list_routing_shadow, list_allocations and list_routing_cells (since_watermark). The allocation reviews are grouped by tier " +
        "source, row, tier, agent, workspace and the writer of the task's text (an overpowered verdict under an agent's default tier is not a " +
        "writer's declaration), and " +
        "judged_by_same_model counts those whose judge ran on the worker's own model. " +
        "When the evidence says a row's tier or effort is wrong, propose replacing it with propose_routing_change, naming as evidence the sessions " +
        "that ran on that row in its current tier: the board shows the human their outcomes and allocation reviews, and that row's sessions you did not cite. " +
        "When rows in the same tier split in their results and no existing tier fits the split, propose adding a tier and moving one " +
        "row into it (op add_tier); write the new tier's description as the work that the tier below is not enough for and this tier is. " +
        "When the evidence raises a doubt that another effort or tier of a model in the table would do, propose measuring it before any row changes " +
        "(op interview), naming the evidence sessions and, from their shadow rows, the workspace the Interview reads. " +
        "The learner leaves the table's first choice only when both that choice and the cell it moves to have observations, and " +
        "each diverged row carries the track records of the recommended and the actual cell as of that pickup (accepted and rejected, " +
        "board and workspace stage) and how many candidates the pickup had. While the learner is not promoted, a diverged row's outcome " +
        "is the result of the setting the table chose, not of the one the learner recommended. Base any case for promoting the learner " +
        "on whether the recommended cells' track records, counts included, justify leaving the table. When you propose promoting or demoting the " +
        "learner, name the diverged rows your case rests on as evidence: the board shows the human their cells' track records and the diverged rows you did not cite. Of the section's shadow rows, " +
        "a pickup with one candidate always matches the table, so do not count it as evidence of agreement. When overpowered verdicts pile up under an " +
        "agent's own tier, propose lowering that agent's tier by exactly one step, never more. When verdicts under tier source task show a " +
        "tier's description draws the wrong work across workspaces and writers, propose rewriting that description; a habit of one workspace or writer is a Behavior, not the tier's definition. The section holds only the proposals " +
        "settled since the previous meta-review: before you propose a change to a row, the learner flag, an agent's tier or a tier's description, read the " +
        "earlier proposals on it, with their answers, amendments and comments, with read_routing_settings. Do not re-propose what was " +
        "amended. A rejected proposal always carries the human's reason in its comment: propose it again only when that reason no longer holds.",
      completion_criteria:
        "every item to judge in this cycle's material is either proposed on or listed as no_change in complete_routing_review, and each change the evidence supports is proposed",
    },
    // どの kind も部分に現れる event だけを数える(ADR 0319 決定3): shadow 行は pickup の event に乗り、exit は初観測のセルか閉じた
    // session の件数、設定の変更は表の行、採点は受理だけ(種のセル)
    material: {
      task_picked_up: { where: PRODUCTION_SESSION_SQL, part: "Diverged shadow rows" },
      allocation_reviewed: { where: NOT_OWN_PRODUCT_SQL, part: "Allocation reviews" },
      worker_exited: { where: PRODUCTION_SESSION_SQL, part: "New cells and changed rows" },
      execution_settings_changed: { where: `json_extract(payload, '$.setting') = 'row' AND ${NOT_OWN_PRODUCT_SQL}`, part: "New cells and changed rows" },
      interview_scored: { where: "json_extract(payload, '$.verdict') = 'accepted'", part: "New cells and changed rows" },
      objection_attributed: { where: rowSubjectSql("routing"), part: "Objected decisions" },
      stop_attributed: { where: rowSubjectSql("routing"), part: "Stops attributed" },
    } as const satisfies MaterialMap,
    verbs: ROUTING_META_REVIEW_VERBS,
  },
} as const;
export type MetaReviewSubject = keyof typeof META_REVIEW_SUBJECTS;
/** 主題の材料の部分(材料の kind が描く見出し)。描き手は部分ごとの行を `satisfies Record<MaterialPart<S>, …>` で置く —— kind を足して
 *  部分を描かなければ compile が落ちる。 */
type Material<S extends MetaReviewSubject> = (typeof META_REVIEW_SUBJECTS)[S]["material"];
type PartOf<T> = T extends { part: infer P } ? P : never;
export type MaterialPart<S extends MetaReviewSubject> = PartOf<Material<S>[keyof Material<S>]>;

/** 同主題で完了(done)した最新の登録の watermark(無ければ 0)。取り消された登録は材料の窓の起点にならない(ADR 0193 決定1)。
 *  `excludeTaskId` は読み手自身 —— その登録の watermark は「今」なので除く。 */
function lastDoneWatermark(db: Db, subject: MetaReviewSubject | null, excludeTaskId: string | null): number {
  return (
    db
      .prepare(
        `SELECT json_extract(e.payload, '$.material_watermark') AS watermark FROM events e JOIN tasks t ON t.id = e.task_id
          WHERE e.kind = 'meta_review_registered' AND json_extract(e.payload, '$.subject') = ? AND t.status = 'done'
            AND e.task_id IS NOT ? ORDER BY e.id DESC LIMIT 1`,
      )
      .get(subject, excludeTaskId) as { watermark: number } | undefined
  )?.watermark ?? 0;
}

/** 読み手の task より前の、同主題で完了した最新の登録の watermark(読み口の既定、無ければ 0)。meta-review でない読み手
 *  (interview の root、ADR 0273 決定2)は盤面の始まりから。 */
export const previousMetaReviewWatermark = (db: Db, readerTaskId: string): number => {
  const subject = metaReviewSubjectOf(db, readerTaskId); // 自身の列: 問いは「この task は meta-review か」で、行の主題ではない(ADR 0283 決定1)
  return subject === null ? 0 : lastDoneWatermark(db, subject, readerTaskId);
};

/** 材料の窓 `(after, upTo]`。upTo 省略 = 上限なし(due の判定と verb の既定)。 */
export type MetaReviewWindow = { after: number; upTo?: number };

/** event id が窓 `(after, upTo]` の中にあるか(null は外)。 */
export const inWindow = (id: number | null, { after, upTo = Number.MAX_SAFE_INTEGER }: MetaReviewWindow) => id !== null && id > after && id <= upTo;

/** 読み手の task の材料の窓 `(after, upTo]`(ADR 0180 決定1): after = 前回の登録の watermark、upTo = 読み手自身の登録の
 *  watermark —— 登録から spawn までに入った変更は次の周期の材料。登録 event の無い task(registerMetaReview を通らない)は今まで。 */
export function metaReviewWindow(db: Db, readerTaskId: string): Required<MetaReviewWindow> {
  const own = db
    .prepare(
      `SELECT COALESCE((SELECT json_extract(payload, '$.material_watermark') FROM events WHERE kind = 'meta_review_registered' AND task_id = ?),
         (SELECT MAX(id) FROM events)) AS watermark`,
    )
    .get(readerTaskId) as { watermark: number };
  return { after: previousMetaReviewWatermark(db, readerTaskId), upTo: own.watermark };
}

/** 材料の節の描き方(ADR 0180 決定2、両主題共通): 両端の watermark を書き、部分ごとに見出し・読み口の注・1行1 JSON の行を
 *  並べ、行が無ければ空の印。 */
export function materialSection(subject: MetaReviewSubject, window: Required<MetaReviewWindow>, parts: Array<[heading: string, note: string, rows: unknown[], empty: string]>): string {
  return [
    `## ${META_REVIEW_SUBJECTS[subject].task.title} material`,
    "",
    `This cycle's material, gathered by the board when this session started: changes after event ${window.after} up to and including event ` +
      `${window.upTo} — the registrations of the previous completed ${subject} meta-review and of this one. Each row is one JSON object with the fields of the read verb named under its heading.`,
    ...parts.flatMap(([heading, note, rows, empty]) => ["", `### ${heading}`, "", note, ...(rows.length === 0 ? [`(${empty})`] : rows.map((row) => JSON.stringify(row)))]),
  ].join("\n");
}

/** 材料の節の部分: 見出しの下の注・1行1 JSON の行・空の印。 */
export type MaterialPartRows = [note: string, rows: unknown[], empty: string];

/** 帰責の2部分(両主題、ADR 0312 決定3): 窓の中で帰責の付いた異議の行(決定5・6)と、窓の中で帰責の判定された人間の停止の1停止1行(決定7)。 */
export const attributionParts = (precedents: unknown[], stops: ReadonlyArray<{ row: unknown }>) =>
  ({
    "Objected decisions": [
      "Rows of list_precedents for the log rows (decisions, completion reports, premise breaches and memory writes) whose objections were attributed in this window, each with its latest attribution up to this window's end.",
      precedents,
      "no objected decisions",
    ],
    "Stops attributed": [
      "One row per human stop whose attribution was judged in this window, with the latest judgment up to this window's end: the stopped task " +
        "and session, the human's reason, and the cause, evidence, wrong_memory_entries and round of that judgment.",
      stops.map((s) => s.row),
      "no stops attributed",
    ],
  }) satisfies Record<string, MaterialPartRows>;

/** 写像の部分を、写像の順で materialSection の部分に並べる。 */
export const partEntries = (parts: Record<string, MaterialPartRows>) => Object.entries(parts).map(([heading, part]) => [heading, ...part] as [string, ...MaterialPartRows]);

/** 異議つき判断の行のうち、主題 `kind` の完了の verb が書いた型つきの判断(ADR 0279 決定5): 次周期の Items to judge が名指す対象を読む。 */
export const objectedJudgments = <K extends MetaReviewSubject>(db: Db, precedents: readonly { decision_event_id: number }[], kind: K) =>
  precedents.flatMap(({ decision_event_id }) => {
    const payload = getEvent(db, decision_event_id)?.payload;
    return payload?.kind === "decision_logged" && payload.judgment?.kind === kind ? [payload.judgment as Extract<Judgment, { kind: K }>] : [];
  });

/** 修理子(memory_repair / routing_repair)の束が異議した行の id(task_registered の opened_on_event_ids → 異議の entry_id)。修理子でなければ
 *  空(ADR 0272 決定3)—— work の修理子と RCA の review 子も同じ欄を持つ。 */
export function objectedRowIds(db: Db, taskId: string): number[] {
  const task = getTask(db, taskId);
  if (!task || !isRepairType(task.type)) return [];
  return (latestEventOfTask(db, taskId, "task_registered")?.payload.opened_on_event_ids ?? []).flatMap((id) => {
    const objection = getEvent(db, id)?.payload;
    return objection?.kind === "objection_raised" ? [objection.entry_id] : [];
  });
}

/** 修理子が運ぶ、主題 `kind` の型つきの判断の行(ADR 0279 決定3・4): 行の種類で盤面が登録する verb と、対象の門が名指す対象を読む。 */
export const repairJudgments = <K extends MetaReviewSubject>(db: Db, taskId: string, kind: K) =>
  objectedJudgments(db, objectedRowIds(db, taskId).map((decision_event_id) => ({ decision_event_id })), kind);

/** 完了の verb が読む項目の全体(ADR 0278 追記4): その task の最新の材料の記録 —— 再 spawn なら agent が最後に読んだ表。記録が無ければ
 *  (spawn を通っていない)項目が読めないので拒む。 */
export function injectedMaterial<S extends MetaReviewSubject>(db: Db, reviewId: string, subject: S) {
  const record = latestEventOfTask(db, reviewId, "meta_review_material_injected");
  if (record?.payload.subject !== subject) throw new DomainError(`material was not injected into this ${subject} meta-review's session, so its items to judge cannot be read`);
  return { id: record.id, items: record.payload.items as Extract<EventPayload, { kind: "meta_review_material_injected"; subject: S }>["items"] };
}

/** meta-review の完了の骨格(ADR 0278 決定2〜4・追記4、memory と routing が共有): 開いている項目 = 注入した一覧 ∩ `open`(今も項目で、
 *  この review の行為も記録の後の誰かの行為も判断済みにしていないもの)。足りない項目と、注入した一覧に無い対象は名指して拒み、何も記録しない。
 *  注入済みでも開いていない項目への値は受け取って何もしない。値1つが対象を名指す型つきの判断ログ1行で、文は盤面が「<値>: <対象> — <reason>」で
 *  組み、完了と同じ transaction で書く。`items` は項目の一覧、`judging` は主題ごとの綴り —— 項目と判断を突き合わせる鍵、文の対象の綴り、
 *  判断の型(kind と value)と、その行が名指す対象。 */
export function completeMetaReview<I, J = I>(
  db: Db,
  review: Task,
  { judgments, handoff }: { judgments: ReadonlyArray<J & { reason?: string }>; handoff?: Partial<HandoffDoc> },
  items: { injected: readonly I[]; open: readonly I[] },
  judging: { key: (item: I | J) => string; label: (item: I) => string; object: (item: I) => object } & ({ kind: "memory"; value: "left_as_is" } | { kind: "routing"; value: "no_change" }),
  actorId: string,
  now: Date,
  origin: EventOrigin,
): Task {
  const injected = new Set(items.injected.map(judging.key));
  const open = new Map(items.open.flatMap((item) => (injected.has(judging.key(item)) ? [[judging.key(item), item] as const] : [])));
  const given = new Map(judgments.map((judgment) => [judging.key(judgment), judgment]));
  const unknown = [...given.keys()].filter((key) => !injected.has(key));
  const unjudged = [...open.keys()].filter((key) => !given.has(key));
  const refusals = [unknown.length > 0 && `not items to judge: ${unknown.join(", ")}`, unjudged.length > 0 && `unjudged: ${unjudged.join(", ")} — act on each or pass it as ${judging.value}`];
  if (refusals.some(Boolean)) throw new DomainError(refusals.filter(Boolean).join("; "));
  return db.transaction(() => {
    for (const [key, item] of open) {
      const { reason } = given.get(key)!;
      const said = reason === undefined || whyBlank(reason) ? undefined : normalizeText(reason);
      // 対象の形は主題の object が決める —— kind と value の組は judging の型が縛る
      const judgment = { kind: judging.kind, ...judging.object(item), value: judging.value, ...(said && { reason: said }) } as Judgment;
      appendEvent(db, {
        taskId: review.id,
        actorId,
        origin,
        payload: { kind: "decision_logged", line: `${judging.value}: ${judging.label(item)}${said ? ` — ${said}` : ""}`, judgment },
        at: now,
      });
    }
    return finishTask(db, review, handoff, actorId, now, origin);
  })();
}

/** 窓の中の材料の event の SQL(ADR 0312 決定1): kind ごとの組の where の和。材料の述語の唯一の置き場で、材料の event の読みと件数の
 *  読みが共有する。 */
function materialSql(select: string, material: MaterialWhere, { after, upTo = Number.MAX_SAFE_INTEGER }: MetaReviewWindow) {
  const kinds = Object.entries(material) as Array<[EventKind, Pick<MaterialPredicate, "where">]>;
  return {
    sql: `SELECT ${select} FROM events WHERE id > ? AND id <= ? AND (${kinds.map(([, { where }]) => `(kind = ? AND ${where})`).join(" OR ")})`,
    params: [after, upTo, ...kinds.map(([kind]) => kind)],
  };
}

/** 窓の中の材料の event(id 順)。`material` は主題の写像か、その一部。due の判定と材料の節が共有する。 */
export function materialEvents<K extends EventKind>(db: Db, material: { [P in K]?: Pick<MaterialPredicate, "where"> }, window: MetaReviewWindow): EventRowOf<K>[] {
  const { sql, params } = materialSql("*", material, window);
  return db.prepare(`${sql} ORDER BY id`).all(...params).map((row) => parseEventRow(row) as EventRowOf<K>);
}

/** 窓の中の材料の件数(組の count の和)と最初の時刻(行を読み込まない —— 盤面の履歴に比例する、ADR 0300 帰結)。 */
function countMaterial(db: Db, material: MaterialWhere, window: MetaReviewWindow): { count: number; first_at: string | null } {
  const { sql, params } = materialSql("COUNT(*) AS count, MIN(created_at) AS first_at", material, window);
  return db.prepare(sql).get(...params) as { count: number; first_at: string | null };
}

/** 主題の meta-review を盤面名義で登録する(周期と初回の扉が通る1本、due は見ない)。task は盤面名義のまま —— 本文は盤面の指示で
 *  人間は編集できない(ADR 0198 決定4)。誰が起こしたかは `meta_review_registered` の経路が運ぶ: 盤面か、人間の面(ADR 0300 決定2)。 */
export function registerMetaReview(db: Db, subject: MetaReviewSubject, now: Date, origin: "board" | "webui" | "mcp" = "board"): Task {
  return db.transaction(() => {
    // 盤面自身の判断の段で走る —— 振り返り Board call と1つの設定を共有する(ADR 0200 決定4)
    const review_tier = readExecutionSettings(db).judgementTier;
    const task = registerTask(db, { type: "review", ...META_REVIEW_SUBJECTS[subject].task, review_tier, meta_review_subject: subject }, now, BOARD_ACTOR_ID, "board");
    const { watermark } = db.prepare("SELECT MAX(id) AS watermark FROM events").get() as { watermark: number };
    appendEvent(db, {
      taskId: task.id,
      actorId: origin === "board" ? BOARD_ACTOR_ID : HUMAN_ACTOR_ID,
      origin,
      payload: { kind: "meta_review_registered", subject, material_watermark: watermark },
      at: now,
    });
    return task;
  })();
}

/** 主題の初回の meta-review を人間が起こす扉(ADR 0300 決定2)。門は3つ —— 同主題の登録が無い(取り消された回も含む)・
 *  盤面の始まりからの材料が1件以上・同主題の未決着が無い。どれかに当たれば登録せず拒む —— routing の未決着を数える前の
 *  陳腐化の決着(settleStaleProposals)は周期の登録と同じく残る。`agents` は周期の登録と同じ registry の一覧。 */
export function startFirstMetaReview(db: Db, subject: MetaReviewSubject, origin: "webui" | "mcp", now: Date, agents?: ListAgentTiers): Task {
  if (latestRegistration(db, subject)) {
    throw new DomainError(`the first ${subject} meta-review was already registered: every later one is registered by the period`);
  }
  if (countMaterial(db, META_REVIEW_SUBJECTS[subject].material, { after: 0 }).count === 0) {
    throw new DomainError(`there is no ${subject} meta-review material yet: the first ${subject} meta-review needs at least one event that opens a review`);
  }
  if (settleAndHasUnsettled(db, subject, now, agents)) {
    throw new DomainError(`an unsettled ${subject} task or proposal question is open: settle it before starting the first ${subject} meta-review`);
  }
  return registerMetaReview(db, subject, now, origin);
}

/** 同主題の最新の登録(取り消された回も含む)と、その task の状態・watermark。周期の起点(ADR 0193 決定2)で、在れば初回の扉は閉じる
 *  (ADR 0300 決定3)。 */
function latestRegistration(db: Db, subject: MetaReviewSubject) {
  return db
    .prepare(
      `SELECT e.created_at, json_extract(e.payload, '$.material_watermark') AS watermark, t.status FROM events e JOIN tasks t ON t.id = e.task_id
        WHERE e.kind = 'meta_review_registered' AND json_extract(e.payload, '$.subject') = ? ORDER BY e.id DESC LIMIT 1`,
    )
    .get(subject) as { created_at: string; watermark: number; status: Task["status"] } | undefined;
}

/** 周期の既定(日、ADR 0120 決定2)。間隔の下限で、全主題に共通。 */
const DEFAULT_PERIOD_DAYS = 7;

export const metaReviewSettingsChangeSchema = z.object({ period_days: z.number().superRefine((value, ctx) => {
  const reason = whyNotPositiveInteger(value);
  if (reason) ctx.addIssue({ code: "custom", message: reason });
}) });
type MetaReviewSettings = { period_days: number };

/** 初回の扉の入力(WebUI と管理 MCP が共有する)。 */
export const firstMetaReviewSchema = z.object({ subject: z.enum(Object.keys(META_REVIEW_SUBJECTS) as [MetaReviewSubject, ...MetaReviewSubject[]]) });

export function readMetaReviewSettings(db: Db): MetaReviewSettings {
  const row = db.prepare("SELECT period_days FROM meta_review_defaults WHERE id = 1").get() as { period_days: number | null } | undefined;
  return { period_days: row?.period_days ?? DEFAULT_PERIOD_DAYS };
}

const periodMs = (db: Db) => readMetaReviewSettings(db).period_days * 24 * 60 * 60 * 1000;

/** 人間の面が主題ごとに読む初回の状態(ADR 0300 決定2): 未実施なら盤面の始まりからの回を開く event の数と最初の材料の時刻、登録済みなら
 *  前回の登録の時刻・次に周期が立てられる最早の時刻・次の回を開く event の数(節の行数ではない、ADR 0312 追記。窓の起点は前回の登録、取り消された回の窓は次の回が
 *  読むのでその前の完了した回 —— ADR 0193 決定3)。件数は行を読み込まず数える。 */
export function readMetaReviewStatus(db: Db) {
  const status = (subject: MetaReviewSubject) => {
    const { material } = META_REVIEW_SUBJECTS[subject];
    const last = latestRegistration(db, subject);
    if (!last) {
      const { count, first_at } = countMaterial(db, material, { after: 0 });
      return { first_review: "not_started" as const, material: count, first_material_at: first_at };
    }
    return {
      first_review: "registered" as const,
      last_registered_at: last.created_at,
      next_earliest_at: new Date(Date.parse(last.created_at) + periodMs(db)).toISOString(),
      material_since: countMaterial(db, material, { after: last.status === "cancelled" ? lastDoneWatermark(db, subject, null) : last.watermark }).count,
    };
  };
  return { memory: status("memory"), routing: status("routing") };
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
      actorId: HUMAN_ACTOR_ID,
      origin,
      payload: { kind: "meta_review_settings_changed", ...readMetaReviewSettings(db) },
      at,
    });
  })();
}

/** scheduler の poll が毎回呼ぶ: due な主題の meta-review を登録する(`agents` は registry の agent 一覧、無ければ registry の無い盤面)。due = 前回登録から周期が経ち
 *  (取り消された登録も周期の起点、ADR 0193 決定2)、行の主題が同じ未決着の task(meta-review 自身・その系譜の子孫と提案 question)が無く、完了した前回の watermark より後に主題の材料がある
 *  (前回が無ければ周期は満たす)。材料は meta-review 自身の産物 —— 提案
 *  question への回答が刻んだものと直接書き込み —— を数えない(ADR 0151)。 */
export function registerDueMetaReviews(db: Db, now: Date, agents?: ListAgentTiers): void {
  const period = periodMs(db);
  for (const subject of Object.keys(META_REVIEW_SUBJECTS) as MetaReviewSubject[]) {
    const { material } = META_REVIEW_SUBJECTS[subject];
    const last = latestRegistration(db, subject);
    // 初回は人間が扉で起こす(ADR 0300 決定2)—— 周期は2回目から数える
    if (!last || Date.parse(last.created_at) + period > now.getTime()) continue;
    if (settleAndHasUnsettled(db, subject, now, agents)) continue;
    if (countMaterial(db, material, { after: lastDoneWatermark(db, subject, null) }).count > 0) registerMetaReview(db, subject, now);
  }
}

/** 陳腐化した routing の提案を決着してから(書き込みを伴う)、行の主題が同じ未決着の task があるか —— meta-review 自身と、その系譜の修理子・RCA とその子孫(孫の RCA も)、それらの下の提案
 *  question(親の状態は問わない)(ADR 0120 決定2・ADR 0279 決定7 / ADR 0283 決定1)。周期の登録と初回の扉が共有する(ADR 0300 決定2)。
 *  提案の kind では数えない —— routing の meta-review は registry 種別の提案も出す(spec #916 A)。 */
function settleAndHasUnsettled(db: Db, subject: MetaReviewSubject, now: Date, agents?: ListAgentTiers): boolean {
  // registry の提案の pin は registry の変更 event が無いので、未決着を数える直前に盤面が今読んでいる registry と照合する(fetch はしない)
  if (subject === "routing" && agents) settleStaleProposals(db, now, null, agents);
  // ponytail: 未決着の task ごとに祖先をたどる —— 未決着が数千に届いて poll が重くなったら subtree の SQL 1本に
  const unsettled = db.prepare(`SELECT id FROM tasks WHERE ${unsettledSql("status")}`).pluck().all() as string[];
  return unsettled.some((id) => lineageSubjectOf(db, id) === subject);
}
