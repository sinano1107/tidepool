import { createRequire } from "node:module";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { z } from "zod";
import type { Cause } from "./cause.js";
import { type Db, MEMORY_FTS_DDL, MEMORY_FTS_TOKENIZER, MEMORY_PREPROCESS_VERSION } from "./db.js";
import { getDisplayLanguage } from "./display-language.js";
import { appendEvent, type EventOrigin, type EventPayload, getEvent, listEvents } from "./events.js";
import { metaReviewSubjectOf, paged, previousMetaReviewWatermark } from "./meta-review.js";
import { entriesReadBefore, entriesSeenBefore, listEpisodes } from "./precedent.js";
import { BOARD_WORKER_ID, DomainError, HUMAN_WORKER_ID, type MemoryProposal, registerTask, settleQuestionAsObserved, type Task } from "./tasks.js";

/** 無効化の理由コード(spec #586 A)。自由記述は持たない。置換と path の付け替えは後継 id
 *  必須、cause.ts の語彙の3つ(間違っていた / 陳腐化)と、人間が提案 question を reject した `rejected`(issue #620)。 */
export type InvalidationReason = "superseded" | "path_moved" | Extract<Cause, "capability" | "environment" | "requirement_change"> | "rejected";
const INVALIDATION_REASONS = ["superseded", "path_moved", "capability", "environment", "requirement_change", "rejected"] as const satisfies readonly InvalidationReason[];

/** 出所(spec #586 A)。種別は参照の型から導く: commit / event = 事実、decision
 *  (decision_logged の event id)= 推論。 */
type MemorySource = { kind: "event" | "decision"; ref: number } | { kind: "commit"; ref: string };

/** エントリの欄のうち events に写すもの。同一性(id)と版は event 自身の id なので
 *  payload には持たない。 */
export interface MemoryEntryFields {
  kind: "knowledge" | "behavior" | "definition";
  state: "candidate" | "approved";
  /** workspace 名。null = 盤面全体。 */
  scope: string | null;
  path: string;
  title: string;
  /** 英語の正文 —— 注入・索引・pull はこれだけを読む。 */
  text: string;
  /** 人間由来のみ: 原文の title と text の揃いと言語名(ADR 0015 四度目・五度目の精密化)。agent 由来は null。 */
  original: { title: string; text: string; language: string } | null;
  /** Behavior のみ: agent 名 or null = 全員。Knowledge は常に null。 */
  addressee: string | null;
  /** definition と人間が書くエントリ(出所を添えない Behavior を含む)は null —— 出所は自身の作成 event(ADR 0083 追記4・追記5)で、
   *  id は event を書くまで決まらないので投影と再生が id から導く(sourceOf)。 */
  source: MemorySource | null;
  author: { activity: "worker_verb" | "human" | "rca" | "meta_review" | "board"; name: string };
}

interface MemoryEntry extends Omit<MemoryEntryFields, "source"> {
  source: MemorySource;
  /** = memory_entry_created の event id。 */
  id: number;
  /** = 承認 event の id(Knowledge は作成 event の id)。candidate は null。 */
  version: number | null;
}

/** 書き手が渡す出所: 盤面の event id か commit のどちらか一方。 */
interface SourceInput {
  event_id?: number;
  commit?: string;
}

interface EntryInput {
  scope: string | null;
  path: string;
  title: string;
  text: string;
  /** 人間が書くエントリのみ。 */
  original?: MemoryEntryFields["original"];
  source?: SourceInput;
  author: MemoryEntryFields["author"];
}

function resolveSource(db: Db, source: SourceInput | undefined): MemorySource {
  if (!source || (source.event_id === undefined) === (source.commit === undefined)) {
    throw new DomainError("source must be exactly one of event_id or commit");
  }
  if (source.commit !== undefined) {
    const commit = source.commit.toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(commit)) throw new DomainError(`not a commit hash: ${source.commit}`);
    return { kind: "commit", ref: commit };
  }
  const event = getEvent(db, source.event_id!);
  if (!event) throw new DomainError(`no event ${source.event_id} on this board`);
  return { kind: event.kind === "decision_logged" ? "decision" : "event", ref: event.id };
}

function sourceOf(entry: MemoryEntryFields, id: number): MemorySource {
  return entry.source ?? { kind: "event", ref: id };
}

/** 版 = 承認 event の id。表の投影と watermark 再生が同じ1つを読む。 */
function versionOf(state: MemoryEntryFields["state"], createdEventId: number): number | null {
  return state === "approved" ? createdEventId : null;
}

/** エントリ表と FTS への投影(作成と rebuild の再生が共有する)。 */
function insertEntry(db: Db, id: number, entry: MemoryEntryFields): void {
  const source = sourceOf(entry, id);
  db.prepare(
    `INSERT INTO memory_entries (id, kind, state, scope, path, title, text, original_title, original_text, original_language,
       addressee, source_kind, source_ref, author_activity, author, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.kind,
    entry.state,
    entry.scope,
    entry.path,
    entry.title,
    entry.text,
    entry.original?.title ?? null,
    entry.original?.text ?? null,
    entry.original?.language ?? null,
    entry.addressee,
    source.kind,
    String(source.ref),
    entry.author.activity,
    entry.author.name,
    versionOf(entry.state, id),
  );
  db.prepare("INSERT INTO memory_fts (rowid, text, title, path, original) VALUES (?, ?, ?, ?, ?)").run(
    id,
    ftsText(entry.text),
    ftsText(entry.title),
    ftsText(entry.path),
    `${ftsText(entry.original?.title ?? "")} ${ftsText(entry.original?.text ?? "")}`,
  );
}

function createEntry(db: Db, fields: Omit<MemoryEntryFields, "source"> & { source?: SourceInput }, origin: EventOrigin, at: Date): number {
  if (fields.path.split("/").some((segment) => segment === "" || segment.trim() !== segment)) {
    throw new DomainError(`path must be "/"-separated non-empty segments without surrounding spaces: ${JSON.stringify(fields.path)}`);
  }
  if (fields.title.trim() === "" || fields.text.trim() === "") throw new DomainError("title and text must be non-empty");
  // board = Board call の起草(ADR 0120 決定1(b)(c))は Behavior candidate だけ
  if (fields.author.activity === "board" && fields.kind !== "behavior") throw new DomainError("a board-drafted entry can only be a behavior candidate");
  // 承認の線は「人間が文言を保証したか」(ADR 0152 決定1): AI の起草は candidate → question
  if (fields.kind === "behavior" && fields.state === "approved" && fields.author.activity !== "human") {
    throw new DomainError("only a human can write an approved behavior; others write a candidate");
  }
  // 人間の Behavior だけは任意で出所の Episode を添えられる(ADR 0153 決定3)
  const ownSource = fields.kind === "definition" || (fields.author.activity === "human" && (fields.kind !== "behavior" || fields.source === undefined));
  if (ownSource && fields.source !== undefined) throw new DomainError("a definition or a human-written knowledge entry has no source: it is the writer's own declaration");
  return db.transaction(() => {
    const entry: MemoryEntryFields = { ...fields, source: ownSource ? null : resolveSource(db, fields.source) };
    const id = appendEvent(db, {
      taskId: null,
      workerId: entry.author.name,
      origin,
      payload: { kind: "memory_entry_created", entry },
      at,
    });
    insertEntry(db, id, entry);
    return id;
  })();
}

/** Knowledge の書き込み(spec #586 E)。承認不要なので書いた瞬間に approved。 */
export function recordKnowledge(db: Db, input: EntryInput, origin: EventOrigin, at: Date): { entry_id: number; event_id: number } {
  const id = createEntry(db, { ...input, kind: "knowledge", state: "approved", original: input.original ?? null, addressee: null }, origin, at);
  return { entry_id: id, event_id: id };
}

/** 枝の定義(spec #600 A): その枝の下に何を保存するかの1行。承認不要で書いた瞬間に approved、
 *  出所は持たない(自身の作成 event)。同じ枝・同じスコープの approved は1つだけ —— 同じ枝の改訂は
 *  `supersedes` に旧定義を渡し、書くのと superseded + 後継の無効化を1つの transaction で行う。 */
export function defineMemoryBranch(
  db: Db,
  input: Omit<EntryInput, "title"> & { supersedes?: number },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_id: number } {
  if (/[\r\n]/.test(input.text)) throw new DomainError("a definition must be one line");
  return db.transaction(() => {
    const defined = db
      .prepare(
        `SELECT id FROM memory_entries WHERE kind = 'definition' AND state = 'approved' AND invalidation_reason IS NULL
          AND path = ? AND scope IS ?`,
      )
      .get(input.path, input.scope) as { id: number } | undefined;
    if (defined && defined.id !== input.supersedes) throw new DomainError(`branch ${input.path} is already defined in this scope by entry ${defined.id}; revise it with supersedes`);
    const { supersedes, ...fields } = input;
    const id = createEntry(db, { ...fields, title: fields.text, kind: "definition", state: "approved", original: fields.original ?? null, addressee: null }, origin, at);
    if (supersedes !== undefined) {
      invalidateMemoryEntry(db, { entry_id: supersedes, reason: "superseded", successor_id: id }, fields.author.name, origin, at, { activity: fields.author.activity });
    }
    return { entry_id: id, event_id: id };
  })();
}

/** meta-review の Knowledge の畳み(issue #619 / ADR 0122 決定1): 新本文を `based_on_decision` の decision(推論)を
 *  出所に作り、replaces(approved かつ未無効化の Knowledge、1つ以上)をその後継つき superseded にする。1 transaction。 */
export function foldMemory(
  db: Db,
  input: Omit<EntryInput, "source" | "original"> & { replaces: number[]; based_on_decision: number },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_id: number } {
  const { replaces, based_on_decision, ...fields } = input;
  if (replaces.length === 0) throw new DomainError("fold_memory needs at least one entry to replace");
  requireDecision(db, based_on_decision);
  return db.transaction(() => {
    for (const id of replaces) requireKnowledge(db, id);
    const created = recordKnowledge(db, { ...fields, source: { event_id: based_on_decision } }, origin, at);
    for (const id of replaces) invalidateMemoryEntry(db, { entry_id: id, reason: "superseded", successor_id: created.entry_id }, fields.author.name, origin, at, { activity: fields.author.activity });
    return created;
  })();
}

/** meta-review の Knowledge の移動(ADR 0122 決定1): 盤面が title・text・原文・出所を写して新しい scope / path に作り、
 *  旧を `path_moved` で新へ指す —— 「本文は同じ」は LLM の申告でなくここが保証する。 */
export function moveMemory(
  db: Db,
  input: { entry_id: number; scope: string | null; path: string; author: MemoryEntryFields["author"] },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_id: number } {
  return db.transaction(() => {
    const old = rowToEntry(requireKnowledge(db, input.entry_id));
    const source = old.source.kind === "commit" ? { commit: old.source.ref } : { event_id: old.source.ref };
    const created = recordKnowledge(db, { scope: input.scope, path: input.path, title: old.title, text: old.text, original: old.original, source, author: input.author }, origin, at);
    invalidateMemoryEntry(db, { entry_id: old.id, reason: "path_moved", successor_id: created.entry_id }, input.author.name, origin, at, { activity: input.author.activity });
    return created;
  })();
}

/** 畳みと統合の出所 = meta-review が log_decision で書いた推論。 */
function requireDecision(db: Db, eventId: number): number {
  if (getEvent(db, eventId)?.kind !== "decision_logged") throw new DomainError(`event ${eventId} is not a logged decision`);
  return eventId;
}

function requireKnowledge(db: Db, id: number): EntryRow {
  const row = requireEntry(db, id);
  if (row.kind !== "knowledge" || row.invalidation_reason !== null) throw new DomainError(`memory entry ${id} is not an approved, non-invalidated knowledge entry`);
  return row;
}

/** 人間の面(settings の HTTP / 管理MCP)の書き込み欄(spec #586 F)。workspace は null = 盤面全体、
 *  original_title / original_text は人間の原文で言語は盤面の表示言語。出所欄は Behavior だけが持つ(ADR 0083 追記5 / ADR 0153 決定3)。 */
const humanEntryFields = {
  workspace: z.string().min(1).nullable(),
  path: z.string(),
  text: z.string(),
  original_text: z.string().optional(),
};
export const humanKnowledgeSchema = z.object({ ...humanEntryFields, title: z.string(), original_title: z.string().optional() });
export const humanDefinitionSchema = z.object({ ...humanEntryFields, supersedes: z.number().int().positive().optional() });
/** Behavior は Knowledge の欄 + 宛先(null = 全員)、任意の編集先と出所の Episode(ADR 0152 / ADR 0153 決定3)。 */
export const humanBehaviorSchema = humanKnowledgeSchema.extend({
  addressee: z.string().min(1).nullable(),
  supersedes: z.number().int().positive().optional(),
  source_event_id: z.number().int().positive().optional(),
});
// `rejected` は提案 question の reject だけが書く(人間の面・meta-review の verb からは渡せない)
export const invalidationSchema = z.object({ reason: z.enum(INVALIDATION_REASONS).exclude(["rejected"]), successor_id: z.number().int().positive().optional() });

/** 一覧の絞り込み(HTTP の query と管理MCP が共有)。workspace は完全一致、board_wide は盤面全体だけ。 */
export const memoryListFilterSchema = z.object({
  workspace: z.string().min(1).optional(),
  kind: z.enum(["knowledge", "behavior", "definition"]).optional(),
  state: z.enum(["candidate", "approved", "invalidated"]).optional(),
});

/** 原文は title と text の揃いで持つか持たないか。英語の title を持たない Definition は、英語側と
 *  同じく原文も title = text(ADR 0015 五度目の精密化)。 */
export function humanEntryInput<T extends { workspace: string | null; original_title?: string; original_text?: string }>(
  db: Db,
  { workspace, original_title, original_text, ...rest }: T,
) {
  const originalTitle = "title" in rest ? original_title : original_text;
  if (!originalTitle?.trim() !== !original_text?.trim()) throw new DomainError("an original needs both its title and its text");
  return {
    ...rest,
    scope: workspace,
    original: originalTitle?.trim() && original_text?.trim() ? { title: originalTitle, text: original_text, language: getDisplayLanguage(db) } : null,
    author: { activity: "human" as const, name: HUMAN_WORKER_ID },
  };
}

/** worker の verb の Memory のスコープ = task の workspace に固定。listLog と同じ解決で、null の workspace は盤面の
 *  既定を継ぐ。worker の verb(read verb も同じ helper を通るので込みで)と Board call の起草は null に解決されるなら
 *  拒否する(issue #623)。meta-review の専用 verb はここを通らず引数の scope を使う(ADR 0122 決定1)。
 *  resolveTaskWorkspace は quarantine の副作用を持つので使わない。 */
export function memoryScope(board: { workspace?: { name: string } }, task: Pick<Task, "workspace">): string {
  const scope = task.workspace ?? board.workspace?.name ?? null;
  if (scope === null) throw new DomainError("memory verbs need a task workspace — this board has none configured");
  return scope;
}

/** Behavior の candidate(spec #586 G の #358 向け seam)。宛先は agent 名 or null = 全員。
 *  承認は question を経由するので、ここでは作らない。 */
export function createBehaviorCandidate(
  db: Db,
  input: EntryInput & { addressee: string | null },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_id: number } {
  const id = createEntry(db, { ...input, kind: "behavior", state: "candidate", original: null }, origin, at);
  return { entry_id: id, event_id: id };
}

/** 人間が書く Behavior(ADR 0152 決定3・4): 書いた時点で approved。出所は任意で事例の Episode(decision_logged か
 *  worker_spawned の event、ADR 0153 決定3)、無ければ自身の作成 event。`supersedes` は編集 —— 未無効化の approved
 *  Behavior を指し、書くのと superseded + 後継の無効化を1 transaction(defineMemoryBranch と同じ形)。 */
export function recordBehavior(
  db: Db,
  input: Omit<EntryInput, "source"> & { addressee: string | null; source_event_id?: number; supersedes?: number },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_id: number } {
  const { source_event_id, supersedes, ...fields } = input;
  if (source_event_id !== undefined && !["decision_logged", "worker_spawned"].includes(getEvent(db, source_event_id)?.kind ?? "")) {
    throw new DomainError(`a behavior's source must be a decision_logged or worker_spawned event: ${source_event_id}`);
  }
  const source = source_event_id === undefined ? undefined : { event_id: source_event_id };
  return db.transaction(() => {
    // candidate を直す口は提案 question の修正値だけ(ADR 0152 決定3)
    if (supersedes !== undefined) requireBehavior(db, supersedes, "approved");
    const id = createEntry(db, { ...fields, source, kind: "behavior", state: "approved", original: fields.original ?? null }, origin, at);
    if (supersedes !== undefined) {
      invalidateMemoryEntry(db, { entry_id: supersedes, reason: "superseded", successor_id: id }, fields.author.name, origin, at, { activity: fields.author.activity });
    }
    return { entry_id: id, event_id: id };
  })();
}

function requireEntry(db: Db, id: number): EntryRow {
  const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as EntryRow | undefined;
  if (!row) throw new DomainError(`no memory entry ${id}`);
  return row;
}

/** 無効化(削除は無い)。人間 / meta-review の判断で、エントリは approved 集合から外れる。
 *  mark は meta-review の産物の印(ADR 0151 決定3): 回答が刻む無効化は question_id、書き込みが刻む無効化は書き手の activity。
 *  返り値は memory_entry_invalidated の event id。 */
export function invalidateMemoryEntry(
  db: Db,
  input: { entry_id: number; reason: InvalidationReason; successor_id?: number },
  workerId: string,
  origin: EventOrigin,
  at: Date,
  mark?: { question_id: string } | { activity: MemoryEntryFields["author"]["activity"] },
): number {
  const { entry_id, reason, successor_id } = input;
  if (!INVALIDATION_REASONS.includes(reason)) throw new DomainError(`unknown invalidation reason: ${reason}`);
  if ((reason === "superseded" || reason === "path_moved") !== (successor_id !== undefined)) {
    throw new DomainError("a successor id is required for superseded / path_moved and only for them");
  }
  if (successor_id === entry_id) throw new DomainError("an entry cannot be its own successor");
  return db.transaction(() => {
    if (requireEntry(db, entry_id).invalidation_reason !== null) {
      throw new DomainError(`memory entry ${entry_id} is already invalidated`);
    }
    if (successor_id !== undefined) {
      // 後継は注入に届く側でなければ置換の連鎖が行き止まる
      const successor = requireEntry(db, successor_id);
      if (successor.state !== "approved" || successor.invalidation_reason !== null) {
        throw new DomainError(`successor ${successor_id} must be an approved, non-invalidated entry`);
      }
    }
    markInvalidated(db, entry_id, reason, successor_id ?? null);
    const eventId = appendEvent(db, {
      taskId: null,
      workerId,
      origin,
      payload: { kind: "memory_entry_invalidated", entry_id, reason, successor_id: successor_id ?? null, ...mark },
      at,
    });
    // pin の陳腐化(ADR 0120 決定4): この entry を pin する open な提案 question を観測で決着させる。回答中の question は
    // answerQuestion が先に done にしているので、reject や承認の superseded が自分自身を決着させることは無い
    for (const id of openProposalsPinning(db, entry_id)) {
      settleQuestionAsObserved(db, id, { kind: "memory_proposal_stale", question_id: id, entry_id, observed_event_id: eventId }, at);
    }
    return eventId;
  })();
}

/** meta-review の無効化(ADR 0122 決定1): approved の Behavior は承認の線なので提案へ回し、`path_moved` は
 *  `moveMemory` だけが生む。 */
export function invalidateMemoryByMetaReview(
  db: Db,
  input: Parameters<typeof invalidateMemoryEntry>[1],
  workerId: string,
  origin: EventOrigin,
  at: Date,
): number {
  if (input.reason === "path_moved") throw new DomainError("path_moved comes only from move_memory, which copies the text itself");
  const row = requireEntry(db, input.entry_id);
  if (row.kind === "behavior" && row.state === "approved") throw new DomainError(`memory entry ${row.id} is an approved behavior: propose its invalidation instead`);
  return invalidateMemoryEntry(db, input, workerId, origin, at, { activity: "meta_review" });
}

/** この entry を pin する open な提案 question の id(陳腐化の hook と、同じ entry への二重提案の拒否が読む)。 */
function openProposalsPinning(db: Db, entryId: number): string[] {
  return (
    db
      .prepare(
        `SELECT id FROM tasks WHERE status = 'todo' AND json_extract(question_proposal, '$.kind') = 'memory'
           AND (json_extract(question_proposal, '$.candidate_id') = @entryId
             OR json_extract(question_proposal, '$.target.id') = @entryId
             OR EXISTS (SELECT 1 FROM json_each(question_proposal, '$.replaces') WHERE json_extract(value, '$.id') = @entryId))`,
      )
      .all({ entryId }) as Array<{ id: string }>
  ).map(({ id }) => id);
}

/** pin 検査(ADR 0120 決定4): candidate が未無効化の Behavior candidate(invalidate op は target の版が一致し未無効化)で、
 *  replaces の版が現在と一致し未無効化。
 *  approve も reject も、見せた状態に対してだけ適用する。 */
function assertProposalFresh(db: Db, proposal: MemoryProposal): EntryRow {
  const unchanged = ({ id, version }: { id: number; version: number | null }) => {
    const row = requireEntry(db, id);
    return row.version === version && row.invalidation_reason === null;
  };
  const named = requireEntry(db, proposal.op === "invalidate" ? proposal.target.id : proposal.candidate_id);
  const fresh =
    (proposal.op === "invalidate"
      ? unchanged(proposal.target)
      : named.kind === "behavior" && named.state === "candidate" && named.invalidation_reason === null) && proposal.replaces.every(unchanged);
  if (!fresh) throw new DomainError("this proposal is stale: a memory entry it names changed since it was proposed");
  return named;
}

function markApproved(db: Db, id: number, version: number): void {
  db.prepare("UPDATE memory_entries SET state = 'approved', version = ? WHERE id = ?").run(version, id);
}

/** Behavior 承認の export(spec #615 A / issue #620): pin 検査(assertProposalFresh)→ memory_entry_approved(版 = この event の id)→ replaces を candidate を後継とする superseded で
 *  無効化、を1 transaction。承認は人間の回答なので人間名義。返り値は memory_entry_approved の event id。
 *  invalidate op(issue #621)は target を理由コードで後継なしに無効化し、その memory_entry_invalidated の event id を返す。 */
export function approveMemoryProposal(db: Db, proposal: MemoryProposal, questionId: string, origin: EventOrigin, at: Date): number {
  return db.transaction(() => {
    const candidate = assertProposalFresh(db, proposal);
    if (proposal.op === "invalidate") {
      return invalidateMemoryEntry(db, { entry_id: candidate.id, reason: proposal.reason }, HUMAN_WORKER_ID, origin, at, { question_id: questionId });
    }
    const eventId = appendEvent(db, {
      taskId: null,
      workerId: HUMAN_WORKER_ID,
      origin,
      payload: { kind: "memory_entry_approved", entry_id: candidate.id, question_id: questionId, replaced: proposal.replaces },
      at,
    });
    markApproved(db, candidate.id, eventId);
    for (const { id } of proposal.replaces) {
      invalidateMemoryEntry(db, { entry_id: id, reason: "superseded", successor_id: candidate.id }, HUMAN_WORKER_ID, origin, at, { question_id: questionId });
    }
    return eventId;
  })();
}

/** 提案の reject(spec #615 F): 同じ pin 検査の後、approve / consolidate は candidate だけを `rejected` で無効化し
 *  (consolidate の replaces は残る)、invalidate は何もしない。 */
export function rejectMemoryProposal(db: Db, proposal: MemoryProposal, questionId: string, origin: EventOrigin, at: Date): void {
  assertProposalFresh(db, proposal);
  if (proposal.op !== "invalidate") invalidateMemoryEntry(db, { entry_id: proposal.candidate_id, reason: "rejected" }, HUMAN_WORKER_ID, origin, at, { question_id: questionId });
}

function requireBehavior(db: Db, id: number, state?: MemoryEntryFields["state"]): EntryRow {
  const row = requireEntry(db, id);
  if (row.kind !== "behavior" || row.invalidation_reason !== null || (state !== undefined && row.state !== state)) {
    throw new DomainError(`memory entry ${id} is not a non-invalidated behavior${state ? ` in state ${state}` : ""}`);
  }
  return row;
}

/** op ごとの欄。worker MCP の入力は平たい object のまま(判別共用体を top-level に置いた schema を worker harness が
 *  受けるかは確かめていない)なので、必須と越境はここで引く。 */
const PROPOSAL_FIELDS = {
  approve: ["candidate_id"],
  consolidate: ["text", "replaces", "based_on_decision"],
  invalidate: ["target_id", "reason"],
} as const;

/** 提案 verb(spec #615 E / issue #620・#621): meta-review の子に提案 question を1件立て、pin を焼いて question の id を返す。
 *  consolidate の新 candidate と question は1 transaction。 */
export function proposeMemoryChange(
  db: Db,
  metaReviewId: string,
  input: {
    op: "approve" | "consolidate" | "invalidate";
    rationale: string;
    candidate_id?: number;
    text?: { scope: string | null; path: string; title: string; text: string; addressee: string | null };
    replaces?: number[];
    based_on_decision?: number;
    target_id?: number;
    reason?: Extract<MemoryProposal, { op: "invalidate" }>["reason"];
  },
  workerId: string,
  now: Date,
): { question_id: string } {
  const need = <T>(value: T | undefined, field: string): T => {
    if (value === undefined) throw new DomainError(`op ${input.op} needs ${field}`);
    return value;
  };
  // 別の op の欄は黙って捨てず断る —— 捨てると meta-review は統合したつもりで承認の question が立つ
  const stray = Object.entries(PROPOSAL_FIELDS).flatMap(([op, fields]) => (op === input.op ? [] : fields.filter((f) => input[f] !== undefined)));
  if (stray.length > 0) throw new DomainError(`op ${input.op} does not take ${stray.join(", ")}`);
  return db.transaction(() => {
    let proposal: MemoryProposal;
    let heading: string[];
    let shown: EntryRow;
    if (input.op === "consolidate") {
      const replaced = [...new Set(need(input.replaces, "replaces"))].map((id) => requireBehavior(db, id));
      if (replaced.length === 0) throw new DomainError("a consolidation needs at least one entry to replace");
      const decision = requireDecision(db, need(input.based_on_decision, "based_on_decision"));
      const created = createBehaviorCandidate(
        db,
        { ...need(input.text, "text"), source: { event_id: decision }, author: { activity: "meta_review", name: workerId } },
        "worker",
        now,
      );
      proposal = { kind: "memory", op: "consolidate", candidate_id: created.entry_id, replaces: replaced.map(({ id, version }) => ({ id, version })) };
      shown = requireEntry(db, created.entry_id);
      // scope null への統合で、どの workspace・宛先から広がるかを人間が見られるように置換対象ごとに載せる
      heading = [
        `Consolidate into new behavior candidate #${created.entry_id}, replacing:`,
        ...replaced.map((row) => `#${row.id} (scope: ${row.scope ?? "whole board"}, addressee: ${row.addressee ?? "every agent"}): ${row.text}`),
      ];
    } else if (input.op === "invalidate") {
      shown = requireBehavior(db, need(input.target_id, "target_id"), "approved");
      const reason = need(input.reason, "reason");
      proposal = { kind: "memory", op: "invalidate", target: { id: shown.id, version: shown.version! }, reason, replaces: [] };
      heading = [`Invalidate approved behavior #${shown.id} (reason: ${reason}).`];
    } else {
      shown = requireBehavior(db, need(input.candidate_id, "candidate_id"), "candidate");
      proposal = { kind: "memory", op: "approve", candidate_id: shown.id, replaces: [] };
      heading = [`Approve behavior candidate #${shown.id} as worded.`];
    }
    // 承認は無効化ではないので陳腐化の hook に掛からない —— pin する entry が別の提案にも pin されていると、片方の承認後に
    // もう片方が人間の reject 待ちで周期を止める(ADR 0120 退けた案)。提案の時点で断る
    for (const id of [shown.id, ...proposal.replaces.map(({ id }) => id)]) {
      if (openProposalsPinning(db, id).length > 0) throw new DomainError(`memory entry ${id} is already in an open proposal question`);
    }
    const detail = [
      ...heading,
      `Scope: ${shown.scope ?? "whole board"}`,
      `Path: ${shown.path}`,
      `Addressee: ${shown.addressee ?? "every agent"}`,
      `Title: ${shown.title}`,
      input.op === "invalidate" ? "Text:" : "New text:",
      shown.text,
    ].join("\n");
    const title = `${{ approve: "Approve", consolidate: "Consolidate", invalidate: "Invalidate" }[input.op]} memory: ${shown.title}`;
    const question = registerTask(
      db,
      {
        type: "question",
        title,
        purpose: input.rationale,
        completion_criteria: "a human answer is recorded",
        parent_id: metaReviewId,
        question: [{ title, detail, options: ["approve", "reject"], recommendation: "approve" }],
        proposal,
      },
      now,
      workerId,
      "worker",
    );
    return { question_id: question.id };
  })();
}

function markInvalidated(db: Db, id: number, reason: InvalidationReason, successorId: number | null): void {
  db.prepare("UPDATE memory_entries SET invalidation_reason = ?, successor_id = ? WHERE id = ?").run(reason, successorId, id);
}

interface EntryRow {
  id: number;
  kind: MemoryEntryFields["kind"];
  state: MemoryEntryFields["state"];
  scope: string | null;
  path: string;
  title: string;
  text: string;
  original_title: string | null;
  original_text: string | null;
  original_language: string | null;
  addressee: string | null;
  source_kind: MemorySource["kind"];
  source_ref: string;
  author_activity: MemoryEntryFields["author"]["activity"];
  author: string;
  version: number | null;
  invalidation_reason: InvalidationReason | null;
  successor_id: number | null;
}

function rowToEntry(row: EntryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    scope: row.scope,
    path: row.path,
    title: row.title,
    text: row.text,
    original: row.original_text === null ? null : { title: row.original_title!, text: row.original_text, language: row.original_language! },
    addressee: row.addressee,
    source:
      row.source_kind === "commit"
        ? { kind: "commit", ref: row.source_ref }
        : { kind: row.source_kind, ref: Number(row.source_ref) },
    author: { activity: row.author_activity, name: row.author },
    version: row.version,
  };
}

/** 店を変える memory 系 event の種別。watermark(snapshot 識別子)と再生が同じ列を読む。 */
const STORE_EVENT_KINDS = "('memory_entry_created', 'memory_entry_approved', 'memory_entry_invalidated')";

/** 店を変える memory 系 events(id 順)。watermark の再生と rebuild が同じ列を読む。 */
function storeEvents(db: Db, watermark = Number.MAX_SAFE_INTEGER) {
  return (
    db
      .prepare(`SELECT id, payload FROM events WHERE kind IN ${STORE_EVENT_KINDS} AND id <= ? ORDER BY id`)
      .all(watermark) as Array<{ id: number; payload: string }>
  ).map(({ id, payload }) => ({ id, event: JSON.parse(payload) as Extract<EventPayload, { kind: `memory_entry_${string}` }> }));
}

/** approved かつ無効化されていないエントリ(id 順)。`watermark`(memory 系 event の id)を
 *  渡すと、その時点までの events を再生して当時の集合を返す —— 表は投影なので、指定が
 *  無ければ表を読む。 */
export function approvedMemoryEntries(db: Db, watermark?: number): MemoryEntry[] {
  if (watermark !== undefined) {
    const entries = new Map<number, MemoryEntry>();
    for (const { id, event } of storeEvents(db, watermark)) {
      if (event.kind === "memory_entry_created") {
        entries.set(id, { ...event.entry, id, source: sourceOf(event.entry, id), version: versionOf(event.entry.state, id) });
      } else if (event.kind === "memory_entry_approved") {
        const entry = entries.get(event.entry_id);
        if (entry) entries.set(event.entry_id, { ...entry, state: "approved", version: id });
      } else {
        entries.delete(event.entry_id);
      }
    }
    return [...entries.values()].filter((entry) => entry.state === "approved");
  }
  return (
    db
      .prepare("SELECT * FROM memory_entries WHERE state = 'approved' AND invalidation_reason IS NULL ORDER BY id")
      .all() as EntryRow[]
  ).map(rowToEntry);
}

/** 人間の面の一覧(spec #586 F): candidate・無効化済み・影になった盤面全体の定義も出す(id 順)。
 *  scope は完全一致(null = 盤面全体、省略 = すべて)、state の invalidated は無効化済み、
 *  approved / candidate は無効化されていないもの。 */
export function listMemoryEntries(
  db: Db,
  filter: { scope?: string | null; kind?: MemoryEntryFields["kind"]; state?: MemoryEntryFields["state"] | "invalidated" },
): Array<MemoryEntry & { invalidation_reason: InvalidationReason | null; successor_id: number | null; cause: Cause | null }> {
  const { scope, kind, state } = filter;
  // cause = 出所 event が帰責(objection_attributed)のときのその cause(spec #615 G)
  return (
    db
      .prepare(
        `SELECT m.*, json_extract(e.payload, '$.cause') AS cause FROM memory_entries m
           LEFT JOIN events e ON m.source_kind = 'event' AND e.id = CAST(m.source_ref AS INTEGER) AND e.kind = 'objection_attributed'
          ORDER BY m.id`,
      )
      .all() as Array<EntryRow & { cause: Cause | null }>
  )
    .filter(
      (row) =>
        (scope === undefined || row.scope === scope) &&
        (kind === undefined || row.kind === kind) &&
        (state === undefined || (state === "invalidated" ? row.invalidation_reason !== null : row.invalidation_reason === null && row.state === state)),
    )
    .map((row) => ({ ...rowToEntry(row), invalidation_reason: row.invalidation_reason, successor_id: row.successor_id, cause: row.cause }));
}

/** 索引と query の共通の前処理(spec #586 B / #606 / #608 / #610)。まず CJK の連なりを重なりつきの2文字語に割り(LWC 式)
 *  空白で囲む。unicode61 は CJK を語に切らない。1文字の連なりはそのまま。長音符 ー は Script=Common なので
 *  Script_Extensions で拾う(拾わないと「サーバ」が割れて当たらない)。その後で . - _ の連なりを、連なりの外側の隣が
 *  unicode61 の token にならない文字(空白・文字列の端・`)` `"` などの記号)のとき連なりごと落とす(tokenchars なので
 *  文末の `narrow.)` が `narrow` に当たらない。語中は `foo__bar` のような連なりも残す。unicode61 は結合文字 Mn を
 *  token に含め、Mc / Me では切る)。bigram が先なので、CJK に接した `東京.csv` の `.` も隣が空白になって落ちる。 */
function ftsText(value: string): string {
  return value
    .replace(/[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]+/gu, (run) => {
      const chars = [...run];
      const grams = chars.length === 1 ? chars : chars.slice(1).map((char, i) => chars[i] + char);
      return ` ${grams.join(" ")} `;
    })
    .replace(/(?<![\p{L}\p{N}\p{Mn}\p{Co}._-])[._-]+|[._-]+(?![\p{L}\p{N}\p{Mn}\p{Co}._-])/gu, "");
}

/** pull の読み手: 帰属 task、そのスコープ(workspace 名 / null = 盤面全体)、agent 名(宛先)。 */
interface MemoryReader {
  taskId: string;
  scope: string | null;
  agent: string;
}

/** search の候補が返らなかった理由(spec #586 D)。関連度の閾値は持たない(ADR 0083
 *  決定9)ので「関連度で切った」は FTS だけでは起きず、型にも置かない。スコープ外と
 *  candidate は候補になる前の SQL の絞り込み。 */
export type MemoryDropReason = "addressee" | "invalidated" | "page_limit";

/** snapshot 識別子 = 店を変える memory 系 event の最大 id(approvedMemoryEntries が再生する種別)。 */
function memoryWatermark(db: Db): number {
  return (
    db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE kind IN ${STORE_EVENT_KINDS}`)
      .get() as { id: number }
  ).id;
}

/** pull 1回 = memory_pulled 1つ(task 帰属)。event id を結果に載せ、投影器がそれを
 *  memory マーカーに結ぶ。 */
function recordPull<T>(
  db: Db,
  reader: Pick<MemoryReader, "taskId" | "agent">,
  pull: Omit<Extract<EventPayload, { kind: "memory_pulled" }>, "kind" | "watermark">,
  result: T,
  at: Date,
): T & { event_id: number } {
  const event_id = appendEvent(db, {
    taskId: reader.taskId,
    workerId: reader.agent,
    origin: "worker",
    payload: { kind: "memory_pulled", ...pull, watermark: memoryWatermark(db) },
    at,
  });
  return { ...result, event_id };
}

/** query から落とす英語の stopword(#606、大文字小文字を区別しない)。落とすのは query 側だけで、
 *  索引には残す。日本語は bigram で語に割れないので対象外。not / no は AND の意味を変えるので入れない。 */
const STOPWORDS = new Set(
  `a an the
   about above after at before below by down for from in into of off on onto out over through to under up with without
   am are be been being is was were
   and but if nor or so than that then
   he her him his i it its me my our she their them they this those these us we what which who you your
   as can do does did has have had will would should could may might must`
    .trim()
    .split(/\s+/),
);

/** query を前処理して stopword を落とし、語ごとに引用符で囲む(識別子の / . - を FTS の構文として
 *  読ませない)。語は既定で AND、注入は OR で繋ぐ。残る語が無ければ null。 */
function ftsQuery(query: string, join: " " | " OR " = " "): string | null {
  const terms = query
    .split(/\s+/)
    .map((word) => ftsText(word).trim())
    // 語の端の記号を除いて見る(`it,` も FTS には `it` として届く。記号だけの語は消える)
    .filter((term) => {
      const word = term.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      return word !== "" && !STOPWORDS.has(word);
    });
  return terms.length === 0 ? null : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(join);
}

/** FTS に当たったスコープ内の approved(順位順)。宛先と無効化はここで落とさない —— search は
 *  それを候補の落ちた理由として残す。 */
function rankedEntries(db: Db, match: string, scope: string | null): EntryRow[] {
  return db
    .prepare(
      `SELECT e.* FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.rowid
        WHERE memory_fts MATCH ? AND e.state = 'approved' AND (e.scope IS NULL OR e.scope = ?)
        ORDER BY memory_fts.rank, e.id`,
    )
    .all(match, scope) as EntryRow[];
}

/** 順位は FTS の rank のみ(ADR 0083 決定9)。
 *  ponytail: stream は FTS の1本なのでその順位そのもの。埋め込み stream(#589)が来たら
 *  ここで RRF(k = 60)融合する。 */
export function searchMemory(
  db: Db,
  reader: MemoryReader,
  input: { query: string; page?: number },
  at: Date,
): { results: Array<{ id: number; title: string; path: string }>; truncated: boolean; event_id: number } {
  return db.transaction(() => {
    const match = ftsQuery(input.query);
    if (match === null) throw new DomainError("query has no searchable terms: it is empty or only stopwords");
    const hits = rankedEntries(db, match, reader.scope);
    const visible = hits.filter((row) => dropReason(row, reader) === null);
    const { rows: shown, truncated } = paged(visible, input.page);
    const candidates = hits.map((row) => ({
      id: row.id,
      dropped: dropReason(row, reader) ?? (shown.includes(row) ? null : ("page_limit" as const)),
    }));
    return recordPull(
      db,
      reader,
      { verb: "search_memory", input, returned_ids: shown.map((row) => row.id), candidates },
      {
        results: shown.map(({ id, title, path }) => ({ id, title, path })),
        truncated,
      },
      at,
    );
  })();
}

function dropReason(row: EntryRow, reader: Pick<MemoryReader, "agent">): MemoryDropReason | null {
  if (row.invalidation_reason !== null) return "invalidated";
  if (row.addressee !== null && row.addressee !== reader.agent) return "addressee";
  return null;
}

/** search / INDEX / read に共通のフィルタ(spec #586 B): approved、未無効化、スコープ(task の
 *  workspace or 盤面全体)、宛先(agent 名一致 or 全員)。 */
function visibleEntries(db: Db, reader: Omit<MemoryReader, "taskId">): EntryRow[] {
  return db
    .prepare(
      `SELECT * FROM memory_entries
        WHERE state = 'approved' AND invalidation_reason IS NULL
          AND (scope IS NULL OR scope = ?) AND (addressee IS NULL OR addressee = ?)
        ORDER BY id`,
    )
    .all(reader.scope, reader.agent) as EntryRow[];
}

/** INDEX の枝: prefix の path と、その path に置かれた定義(workspace が盤面全体に勝つ —— 見える
 *  スコープは task の workspace と盤面全体の2つだけ)。null = 未定義。 */
interface IndexBranch {
  name: string;
  definition: EntryRow | null;
}

/** 派生の INDEX(ADR 0083 追記3・追記4): prefix の直下の子 —— 1段深い sub-prefix(定義の path
 *  自身も枝を作る)と、path が prefix そのものの leaf(定義は leaf に数えない)。prefix 無し =
 *  最上位(深さ1)。保存しない。browse と注入が共有する。 */
function indexChildren(entries: EntryRow[], prefix: string): Array<IndexBranch | EntryRow> {
  const below = prefix === "" ? entries : entries.filter((e) => e.path.startsWith(`${prefix}/`));
  const depth = prefix === "" ? 1 : prefix.split("/").length + 1;
  return [
    ...[...new Set(below.map((e) => e.path.split("/").slice(0, depth).join("/")))].sort().map((name) => {
      const own = entries.filter((e) => e.kind === "definition" && e.path === name);
      return { name, definition: own.find((e) => e.scope !== null) ?? own[0] ?? null };
    }),
    ...entries.filter((e) => e.path === prefix && e.kind !== "definition"),
  ];
}

const isBranch = (child: IndexBranch | EntryRow): child is IndexBranch => "name" in child;

export function browseMemory(
  db: Db,
  reader: MemoryReader,
  input: { prefix?: string; page?: number },
  at: Date,
): {
  children: Array<{ name: string; definition: string | null }>;
  entries: Array<{ id: number; title: string }>;
  truncated: boolean;
  event_id: number;
} {
  const prefix = input.prefix ?? "";
  return db.transaction(() => {
    const children = indexChildren(visibleEntries(db, reader), prefix);
    const { rows: shown, truncated } = paged(children, input.page);
    const leaves = shown.filter((child): child is EntryRow => !isBranch(child));
    return recordPull(
      db,
      reader,
      { verb: "browse_memory", input, returned_ids: leaves.map((e) => e.id) },
      {
        children: shown.filter(isBranch).map(({ name, definition }) => ({ name, definition: definition?.text ?? null })),
        entries: leaves.map(({ id, title }) => ({ id, title })),
        truncated,
      },
      at,
    );
  })();
}

/** meta-review の一覧3つ(issue #619): 人間の面と同じ一覧を verb ごとに絞ってページで返す。scope・宛先では
 *  絞らない(両方を見る必要があるのは矛盾を見る人間と meta-review だけ —— ADR 0083 追記4)。 */
export function pullMemoryList(
  db: Db,
  reader: Pick<MemoryReader, "taskId" | "agent">,
  verb: "list_memory_candidates" | "list_memory_behaviors" | "list_memory_entries",
  input: Parameters<typeof listMemoryEntries>[1] & { include_invalidated?: boolean; page?: number },
  at: Date,
) {
  return db.transaction(() => {
    const entries =
      verb === "list_memory_entries"
        ? listMemoryEntries(db, input)
        : verb === "list_memory_behaviors"
          ? listMemoryEntries(db, { kind: "behavior", state: "approved" })
          : listMemoryEntries(db, {}).filter((e) => e.state === "candidate" && (input.include_invalidated || e.invalidation_reason === null));
    const { rows: shown, truncated } = paged(entries, input.page);
    return recordPull(db, reader, { verb, input, returned_ids: shown.map((e) => e.id) }, { entries: shown, truncated }, at);
  })();
}

/** meta-review の Precedent の読み口(issue #619): 異議つき decision マーカーを cause・outcome と、その decision より前に
 *  読んだ / 見た記憶つきで返す。既定の `since_watermark` は読み手と同主題の前回の meta-review 登録の
 *  watermark で、異議の event がそれより後の decision だけを返す —— 古い decision への新しい異議も材料である。 */
export function listPrecedents(
  db: Db,
  reader: Pick<MemoryReader, "taskId" | "agent">,
  input: { since_watermark?: number; page?: number },
  at: Date,
) {
  return db.transaction(() => {
    const since = input.since_watermark ?? previousMetaReviewWatermark(db, reader.taskId);
    const lastObjection = db.prepare(
      `SELECT MAX(id) AS id FROM events WHERE kind IN ('objection_raised', 'objection_attributed') AND json_extract(payload, '$.entry_id') = ?`,
    );
    const precedents = listEpisodes(db, {}).flatMap((episode) => {
      const objected = episode.markers.filter(
        (m) => m.kind === "decision" && ((lastObjection.get(m.eventId) as { id: number | null }).id ?? -1) > since,
      );
      const events = objected.length === 0 ? [] : listEvents(db, episode.taskId);
      return objected.map((m) => ({
        task_id: episode.taskId,
        workspace: episode.workspace,
        agent: episode.agent,
        worker_spawned_event_id: episode.workerSpawnedEventId,
        decision_event_id: m.eventId!,
        line: m.line,
        displayed: m.displayed,
        objections: m.objections,
        cause: m.cause,
        completed: episode.completed,
        pr_merged: episode.prMerged,
        entries_read: entriesReadBefore(episode, events, m.eventId!),
        entries_seen: entriesSeenBefore(episode, events, m.eventId!),
      }));
    });
    const { rows: shown, truncated } = paged(precedents, input.page);
    return recordPull(
      db,
      reader,
      { verb: "list_precedents", input, returned_ids: [...new Set(shown.flatMap((p) => [...(p.entries_read ?? []), ...(p.entries_seen ?? [])]))] },
      { precedents: shown, truncated },
      at,
    );
  })();
}

/** 出所の種別(ADR 0083 追記3): commit / event の参照は事実、decision の参照は推論。 */
const SOURCE_KIND = { commit: "fact", event: "fact", decision: "inference" } as const;

/** id で本文を読む。見えないエントリ(フィルタ外・存在しない id)は黙って返さない。 */
export function readMemory(
  db: Db,
  reader: MemoryReader,
  input: { ids: number[] },
  at: Date,
): {
  entries: Array<{ id: number; title: string; path: string; text: string; source: MemorySource; source_kind: "fact" | "inference" }>;
  event_id: number;
} {
  return db.transaction(() => {
    const entries = visibleEntries(db, reader)
      .filter((row) => input.ids.includes(row.id))
      .map(rowToEntry)
      .map(({ id, title, path, text, source }) => ({ id, title, path, text, source, source_kind: SOURCE_KIND[source.kind] }));
    return recordPull(db, reader, { verb: "read_memory", input, returned_ids: entries.map((e) => e.id) }, { entries }, at);
  })();
}

export const TOKENIZER = { id: "gpt-tokenizer/o200k_base", version: (createRequire(import.meta.url)("gpt-tokenizer/package.json") as { version: string }).version };

const INJECTION_PREAMBLE =
  "Approved board memory for this workspace. Browse deeper with browse_memory and find more with search_memory. " +
  "A fact source is a commit or board event; an inference source is an agent's decision — weigh it. Each index " +
  "line is a branch and its definition — what is filed under it, or (undefined) — and a closing line, when " +
  "present, counts the relevant entries omitted and the depth the index is shown to; browse or search for the " +
  "rest. Relevant entries are pointers ranked by relevance, without their text: read the ones that bear on " +
  "your task with read_memory before acting.";

type MemoryInjection = {
  /** null = 見える approved が無い(節を出さない)。 */
  section: string | null;
  watermark: number;
  /** 出した定義(INDEX の順)と関連 leaf(順位順)。 */
  entries: Array<{ id: number; version: number }>;
  tokens: number;
  /** 出した INDEX の深さと木の全深さ(最上位 = 1、節が無ければ 0)。 */
  index_depth: number;
  index_max_depth: number;
  /** 上限で落とした関連 leaf の件数(印と同じ数)。 */
  omitted: number;
};

/** spawn 注入の節(spec #586 C / #600 C、provider 非依存): 全階層の定義つき INDEX + 関連 leaf の
 *  ポインタ(title・path・出所の種別、本文は運ばない —— 読むのは read_memory だけ、#604)を上限内に
 *  組む。関連度の query は task の title + purpose + completion criteria の語の OR で、順位は search と
 *  同じ FTS の rank。削り順は固定 —— 関連 leaf を順位の下から1件ずつ → INDEX を深い階層から1段ずつ。
 *  最上位 INDEX はそれだけで上限を超えても残す(枝が無いと pull で降りられない)。meta-review(どの主題も)には組まない ——
 *  節は scope を task から解決し、案内する pull verb はその接続に無い(ADR 0122 決定2)。 */
export function buildMemoryInjection(
  db: Db,
  task: Pick<Task, "id" | "title" | "purpose" | "completion_criteria">,
  scope: string | null,
  agent: string,
): MemoryInjection {
  return db.transaction(() => {
    const watermark = memoryWatermark(db);
    const visible = metaReviewSubjectOf(db, task.id) !== null ? [] : visibleEntries(db, { scope, agent });
    if (visible.length === 0) return { section: null, watermark, entries: [], tokens: 0, index_depth: 0, index_max_depth: 0, omitted: 0 };
    const tree = (prefix: string, depth: number): Array<IndexBranch & { depth: number }> =>
      indexChildren(visible, prefix)
        .filter(isBranch)
        .flatMap((branch) => [{ ...branch, depth }, ...tree(branch.name, depth + 1)]);
    const branches = tree("", 1);
    const maxDepth = Math.max(...branches.map((b) => b.depth));
    // 語が残らなければ(空 / stopword だけ)関連 leaf は無い。spawn は落とさない
    const match = ftsQuery(`${task.title} ${task.purpose} ${task.completion_criteria}`, " OR ");
    const relevant =
      match === null
        ? []
        : rankedEntries(db, match, scope).filter((row) => row.kind !== "definition" && dropReason(row, { agent }) === null);
    const render = (shown: EntryRow[], depth: number) => {
      const omitted = relevant.length - shown.length;
      const omissionNote = [
        ...(omitted > 0 ? [`${omitted} relevant ${omitted === 1 ? "entry" : "entries"} omitted`] : []),
        ...(depth < maxDepth ? [`index shown to depth ${depth} of ${maxDepth}`] : []),
      ].join("; ");
      return [
        "## Memory",
        "",
        INJECTION_PREAMBLE,
        "",
        "### Index",
        "",
        ...branches
          .filter((b) => b.depth <= depth)
          .map((b) => `${"  ".repeat(b.depth - 1)}- ${b.name.split("/").at(-1)}/ — ${b.definition?.text ?? "(undefined)"}`),
        ...(shown.length === 0
          ? []
          : [
              "",
              "### Relevant entries",
              "",
              ...shown.map((row) => `- #${row.id} ${row.title} (path: ${row.path}, source: ${SOURCE_KIND[row.source_kind]})`),
            ]),
        ...(omissionNote === "" ? [] : ["", omissionNote]),
      ].join("\n");
    };
    const cap = readMemorySettings(db).injection_token_cap;
    let leaves = relevant;
    let depth = maxDepth;
    let section = render(leaves, depth);
    let tokens = countTokens(section);
    while (tokens > cap && (leaves.length > 0 || depth > 1)) {
      if (leaves.length > 0) leaves = leaves.slice(0, -1);
      else depth--;
      section = render(leaves, depth);
      tokens = countTokens(section);
    }
    const definitions = branches.flatMap((b) => (b.depth <= depth && b.definition ? [b.definition] : []));
    return {
      section,
      watermark,
      entries: [...definitions, ...leaves].map((row) => ({ id: row.id, version: row.version! })),
      tokens,
      index_depth: depth,
      index_max_depth: maxDepth,
      omitted: relevant.length - leaves.length,
    };
  })();
}

/** spawn 直後の注入記録(task 帰属、worker_spawned の直後に両 adapter が書く)。 */
export function recordMemoryInjection(
  db: Db,
  taskId: string,
  agent: string,
  workerSpawnedEventId: number,
  injection: MemoryInjection,
  at: Date,
): number {
  const { section: _, ...recorded } = injection;
  return appendEvent(db, {
    taskId,
    workerId: agent,
    origin: "board",
    payload: {
      kind: "memory_injected",
      worker_spawned_event_id: workerSpawnedEventId,
      ...recorded,
      tokenizer: TOKENIZER.id,
      tokenizer_version: TOKENIZER.version,
    },
    at,
  });
}

/** 注入上限の既定(spec #586 C)。上限は ADR 0083 決定10 が置いた唯一のノブ。 */
const DEFAULT_INJECTION_TOKEN_CAP = 2000;

export const memorySettingsChangeSchema = z.object({ injection_token_cap: z.number().int().positive() });
type MemorySettings = { injection_token_cap: number };

export function readMemorySettings(db: Db): MemorySettings {
  const row = db.prepare("SELECT injection_token_cap FROM memory_defaults WHERE id = 1").get() as { injection_token_cap: number | null } | undefined;
  return { injection_token_cap: row?.injection_token_cap ?? DEFAULT_INJECTION_TOKEN_CAP };
}

/** 設定を書き、盤面スコープの操作イベントとして経路つきで残す(applyExecutionSettingsChange と
 *  同じ形)。返り値は memory_settings_changed の event id。 */
export function changeMemorySettings(
  db: Db,
  change: z.infer<typeof memorySettingsChangeSchema>,
  origin: EventOrigin,
  at: Date,
): number {
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO memory_defaults (id, injection_token_cap) VALUES (1, @injection_token_cap)
       ON CONFLICT(id) DO UPDATE SET injection_token_cap = excluded.injection_token_cap`,
    ).run(change);
    return appendEvent(db, {
      taskId: null,
      workerId: HUMAN_WORKER_ID,
      origin,
      payload: { kind: "memory_settings_changed", ...readMemorySettings(db) },
      at,
    });
  })();
}

/** worker の memory verb。主題 memory の meta-review の接続では `MEMORY_META_REVIEW_VERBS`(meta-review.ts)に置き換わる
 *  (ADR 0122 決定2)。MCP の登録と Codex の `enabled_tools` が同じ差を写す。 */
export const WORKER_MEMORY_VERBS = ["record_knowledge", "define_memory_branch", "browse_memory", "search_memory", "read_memory"] as const;

/** rebuild(spec #586 G): エントリ表と FTS を消し、memory 系 events を再生して作り直し、
 *  索引の版を今の版に刻む。無効化済みの行(理由コード・後継 id)も再生で戻る。 */
export function rebuildMemoryIndex(db: Db, workerId: string, origin: EventOrigin, at: Date): number {
  return db.transaction(() => {
    db.exec(`DELETE FROM memory_entries; DROP TABLE memory_fts; ${MEMORY_FTS_DDL};`);
    for (const { id, event } of storeEvents(db)) {
      if (event.kind === "memory_entry_created") insertEntry(db, id, event.entry);
      else if (event.kind === "memory_entry_approved") markApproved(db, event.entry_id, id);
      else markInvalidated(db, event.entry_id, event.reason, event.successor_id);
    }
    db.prepare("UPDATE memory_index_version SET tokenizer = ?, preprocess_version = ?").run(MEMORY_FTS_TOKENIZER, MEMORY_PREPROCESS_VERSION);
    return appendEvent(db, {
      taskId: null,
      workerId,
      origin,
      payload: { kind: "memory_index_rebuilt", tokenizer: MEMORY_FTS_TOKENIZER, preprocess_version: MEMORY_PREPROCESS_VERSION },
      at,
    });
  })();
}

/** boot 時の照合: 店に刻まれた索引の版が今の版と違えば rebuild する。返り値は
 *  memory_index_rebuilt の event id、一致していれば null。 */
export function ensureMemoryIndex(db: Db, at: Date): number | null {
  const stored = db.prepare("SELECT tokenizer, preprocess_version FROM memory_index_version").get() as {
    tokenizer: string;
    preprocess_version: string;
  };
  if (stored.tokenizer === MEMORY_FTS_TOKENIZER && stored.preprocess_version === MEMORY_PREPROCESS_VERSION) return null;
  return rebuildMemoryIndex(db, BOARD_WORKER_ID, "board", at);
}
