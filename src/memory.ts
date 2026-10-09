import { createRequire } from "node:module";
import { countTokens } from "gpt-tokenizer/encoding/o200k_base";
import { z } from "zod";
import type { Cause } from "./cause.js";
import { type Db, MEMORY_FTS_DDL, MEMORY_FTS_TOKENIZER, MEMORY_PREPROCESS_VERSION } from "./db.js";
import { getDisplayLanguage } from "./display-language.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, type EventOrigin, type EventPayload, type EventRow, getEvent, isDecisionLogEntry, listEvents, listEventsOfKinds, sessionSpawnOf, sessionWindow } from "./events.js";
import { landingAnnotation } from "./landing.js";
import { inWindow, type MetaReviewWindow, materialEvents, materialSection, metaReviewSubjectOf, metaReviewWindow, previousMetaReviewWatermark } from "./meta-review.js";
import { whyNotPositiveInteger } from "./positive-integer.js";
import { entriesReadBefore, entriesSeenBefore, listEpisodes } from "./precedent.js";
import { normalizeText, whyBlank } from "./required-text.js";
import { requiredTextSchema } from "./required-text-schema.js";
import { type Packed, packItems, readPosition } from "./response-budget.js";
import { routingMaterial } from "./routing-review.js";
import { approvalAnnotation, getTask, isFixedChoiceQuestion, type MemoryProposal, needsComment, type QuestionProposal, questionBlocking, registerTask, settleQuestionAsObserved, type Task, type TierRef } from "./tasks.js";
import { entryObjections, objectedEntryText, objectionsById } from "./triage.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "./worker-id.js";

/** 無効化の理由コード(spec #586 A)。自由記述は持たない。置換と path の付け替えは後継 id
 *  必須、cause.ts の語彙の3つ(間違っていた / 陳腐化)と、人間が提案 question を reject した `rejected`(issue #620)。 */
export type InvalidationReason = "superseded" | "path_moved" | Extract<Cause, "capability" | "environment" | "requirement_change"> | "rejected";
const INVALIDATION_REASONS = ["superseded", "path_moved", "capability", "environment", "requirement_change", "rejected"] as const satisfies readonly InvalidationReason[];

/** 出所(spec #586 A)。種別は参照の型から導く: commit / event = 事実、decision
 *  (decision_logged の event id)= 推論。 */
type MemorySource = { kind: "event" | "decision"; ref: number } | { kind: "commit"; ref: string };

/** エントリの欄のうち events に写すもの。同一性(id)と版は event 自身の id なので
 *  ここには持たない(移動の複製が継いだ版は memory_entry_created の payload の version が運ぶ)。 */
export interface MemoryEntryFields {
  kind: "knowledge" | "behavior" | "definition" | "exemplar";
  state: "candidate" | "approved";
  /** workspace 名。null = 盤面全体。 */
  scope: string | null;
  path: string;
  title: string;
  /** 英語の正文 —— 注入・索引・pull はこれだけを読む。 */
  text: string;
  /** 人間由来のみ: 原文の title と text の揃いと言語名(ADR 0015 四度目・五度目の精密化)。agent 由来は null。 */
  original: { title: string; text: string; language: string } | null;
  /** Behavior と Exemplar: agent 名 or null = 全員。Knowledge と Definition は常に null。 */
  addressee: string | null;
  /** definition と人間が書くエントリ(出所を添えない Behavior を含む)は null —— 出所は自身の作成 event(ADR 0083 追記4・追記5)で、
   *  id は event を書くまで決まらないので投影と再生が id から導く(sourceOf)。Exemplar は書き手を問わず事例の Episode(ADR 0153 決定1)。 */
  source: MemorySource | null;
  author: { activity: "worker_verb" | "human" | "rca" | "meta_review" | "board"; name: string };
  /** Exemplar のみ: 注釈の list(ADR 0153 決定1)。他の種別は持たない。 */
  annotations?: ExemplarAnnotation[];
}

interface MemoryEntry extends Omit<MemoryEntryFields, "source"> {
  source: MemorySource;
  /** = memory_entry_created の event id。 */
  id: number;
  /** = 承認 event の id(Knowledge と Definition は作成 event の id、移動の複製は旧から継いだ版)。candidate は null。 */
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

/** 事例の Episode を指す出所(ADR 0153 決定1・3): decision_logged か worker_spawned の event で、decision でも種別は
 *  event(書き手の推論ではなく記録を指す)。人間の Behavior の出所と Exemplar の出所が通る。 */
function citedEpisode(db: Db, eventId: number): MemorySource {
  if (!["decision_logged", "worker_spawned"].includes(getEvent(db, eventId)?.kind ?? "")) {
    throw new DomainError(`a cited episode must be a decision_logged or worker_spawned event: ${eventId}`);
  }
  return { kind: "event", ref: eventId };
}

function sourceOf(entry: MemoryEntryFields, id: number): MemorySource {
  return entry.source ?? { kind: "event", ref: id };
}

/** 後継が継げる出所: 自身の作成 event(人間が出所を添えずに書いたもの)は事例を持たないので継がない。 */
function inheritableSource(entry: MemoryEntry): MemorySource | undefined {
  return entry.source.ref === entry.id ? undefined : entry.source;
}

/** 置き換えられるエントリが1つに揃えて持つ継げる出所(kind と ref が同一 —— ADR 0162 決定3)。meta-review の consolidate と
 *  人間の書き込みの supersedes が共有する。workspace を跨ぐ統合は帰責 event が揃わないので無い。 */
function sharedSource(entries: MemoryEntry[]): MemorySource | undefined {
  const [head, ...rest] = entries;
  return head && rest.every(({ source }) => source.kind === head.source.kind && source.ref === head.source.ref) ? inheritableSource(head) : undefined;
}

/** 版 = 承認 event の id。表の投影と watermark 再生が同じ1つを読む。`carried` は移動の複製が作成 event で運ぶ旧の版。 */
function versionOf(state: MemoryEntryFields["state"], createdEventId: number, carried?: number): number | null {
  return state === "approved" ? (carried ?? createdEventId) : null;
}

/** エントリ表と FTS への投影(作成・移動と rebuild の再生が共有する)。 */
function insertEntry(db: Db, id: number, entry: MemoryEntryFields, carried?: number): void {
  const source = sourceOf(entry, id);
  db.prepare(
    `INSERT INTO memory_entries (id, kind, state, scope, path, title, text, original_title, original_text, original_language,
       addressee, annotations, source_kind, source_ref, author_activity, author, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    entry.annotations ? JSON.stringify(entry.annotations) : null,
    source.kind,
    String(source.ref),
    entry.author.activity,
    entry.author.name,
    versionOf(entry.state, id, carried),
  );
  db.prepare("INSERT INTO memory_fts (rowid, text, title, path) VALUES (?, ?, ?, ?)").run(id, ftsText(entry.text), ftsText(entry.title), ftsText(entry.path));
}

/** 入口の path / prefix の検査と正規化(#1191): 正準等価な path は同じ枝なので NFC にして返し、以後の比較・保存はそれを使う。
 *  全角・半角は見た目が違うので畳まない(NFKC にしない)。 */
function checkedPath(path: string): string {
  path = normalizeText(path);
  if (path.split("/").some((segment) => whyBlank(segment) || normalizeText(segment) !== segment)) {
    throw new DomainError(`path must be "/"-separated non-empty segments without surrounding spaces: ${JSON.stringify(path)}`);
  }
  return path.normalize("NFC");
}

/** path が枝 branch そのものか、その配下 branch/… にあるか(`branch-x` は別の枝)。 */
const atOrUnder = (path: string, branch: string) => path === branch || path.startsWith(`${branch}/`);

function createEntry(
  db: Db,
  fields: Omit<MemoryEntryFields, "source"> & { source?: SourceInput | MemorySource },
  origin: EventOrigin,
  at: Date,
  mark?: { question_id: string },
): number {
  const path = checkedPath(fields.path);
  if (whyBlank(fields.title) || whyBlank(fields.text)) throw new DomainError("title and text must be non-empty");
  // board = Board call の起草(ADR 0120 決定1(b)(c))は Behavior candidate だけ
  if (fields.author.activity === "board" && fields.kind !== "behavior") throw new DomainError("a board-drafted entry can only be a behavior candidate");
  // 承認の線は「人間が文言を保証したか」(ADR 0152 決定1): AI の起草は candidate → question
  if ((fields.kind === "behavior" || fields.kind === "exemplar") && fields.state === "approved" && fields.author.activity !== "human") {
    throw new DomainError(`only a human can write an approved ${fields.kind}; others write a candidate`);
  }
  // 人間の Behavior は任意で、Exemplar は必ず出所の Episode を持つ(ADR 0153 決定1・3)
  const mayCiteSource = (fields.kind === "behavior" && fields.author.activity === "human") || fields.kind === "exemplar";
  const ownSource = fields.kind === "definition" || fields.author.activity === "human";
  const { source } = fields;
  if (ownSource && !mayCiteSource && source !== undefined) throw new DomainError("a definition or a human-written knowledge entry has no source: it is the writer's own declaration");
  return db.transaction(() => {
    // 解決済みの出所(事例の引用・編集が継ぐ旧の出所)はそのまま
    const resolved = source !== undefined && "kind" in source ? source : ownSource && source === undefined ? null : resolveSource(db, source);
    const entry: MemoryEntryFields = { ...fields, path, title: normalizeText(fields.title), text: normalizeText(fields.text), source: resolved };
    const id = appendEvent(db, {
      taskId: null,
      workerId: entry.author.name,
      origin,
      payload: { kind: "memory_entry_created", entry, ...mark },
      at,
    });
    insertEntry(db, id, entry);
    return id;
  })();
}

/** 書き込みの `supersedes`(ADR 0162 決定1・2): write で新エントリを書き、supersedes の各要素をその superseded にするのを
 *  1 transaction。要素は未無効化の approved だけ —— candidate を新しい文言で置き換えるのは提案 question の修正値(ADR 0152 決定3)。
 *  種別の線は無効化の門が持つ。write は置き換えられるエントリ(出所を継ぐ書き込みが読む)を受け、新エントリの id を返す。
 *  supersedes は省略か1件以上 —— 空配列は書く前に拒否する(#1135)。 */
function writeSuperseding(
  db: Db,
  supersedes: number[] | undefined,
  author: Actor,
  origin: EventOrigin,
  at: Date,
  write: (replaced: MemoryEntry[]) => number,
): { entry_id: number; event_id: number } {
  if (supersedes?.length === 0) throw new DomainError("supersedes needs at least one entry to replace; omit it to write without replacing");
  return db.transaction(() => {
    const since = memoryWatermark(db);
    const replaced = (supersedes ?? []).map((id) => rowToEntry(requireLive(db, id, undefined, "approved")));
    const id = write(replaced);
    if (supersedes) foldMemoryEntries(db, { replaces: supersedes, successor_id: id, author }, origin, at);
    requireOneTree(db, since);
    return { entry_id: id, event_id: id };
  })();
}

/** 重ねた1本の木の門(ADR 0178 決定2〜5): 無効化されていない盤面全体のエントリ(種別・状態・宛先を問わない)の path かその上位に、
 *  無効化されていない workspace の Definition があってはならない。操作が残す状態で見る —— エントリを置く操作の transaction の終わりに、
 *  since(操作の前の watermark)より後に置かれたエントリを片側に含む組を探す。同じ操作で畳まれた定義・一緒に動いたエントリは当たらない。
 *  組はすべて名指し、出口は操作が盤面全体のエントリを置いたかで選ぶ。registry は見ない。rebuild と watermark 再生は掛けない。
 *  ponytail: 生きたエントリの自己結合を書き込みごとに走らせる。店が大きくなったら path の索引か、置いた行だけから引く形へ */
function requireOneTree(db: Db, since: number): void {
  const pairs = db
    .prepare(
      `SELECT e.id AS e_id, e.kind AS e_kind, e.path AS e_path, ef.id AS e_from,
              d.id AS d_id, d.path AS d_path, d.scope AS d_scope, df.id AS d_from
         FROM memory_entries e JOIN memory_entries d
           ON d.kind = 'definition' AND d.scope IS NOT NULL AND d.invalidation_reason IS NULL
          AND (e.path = d.path OR substr(e.path, 1, length(d.path) + 1) = d.path || '/')
         LEFT JOIN memory_entries ef ON ef.invalidation_reason = 'path_moved' AND ef.successor_id = e.id
         LEFT JOIN memory_entries df ON df.invalidation_reason = 'path_moved' AND df.successor_id = d.id
        WHERE e.scope IS NULL AND e.invalidation_reason IS NULL AND (e.id > ? OR d.id > ?)
        ORDER BY e.id, d.id`,
    )
    .all(since, since) as Array<{
    e_id: number;
    e_kind: string;
    e_path: string;
    e_from: number | null;
    d_id: number;
    d_path: string;
    d_scope: string;
    d_from: number | null;
  }>;
  if (pairs.length === 0) return;
  // 置かれる側は巻き戻る id でなく、移動なら移動元の id で名指す
  const hits = pairs.map((p) => {
    const entry =
      p.e_id <= since
        ? `whole-board ${p.e_kind} entry ${p.e_id} at ${p.e_path}`
        : p.e_from === null
          ? `the whole-board ${p.e_kind} being placed at ${p.e_path}`
          : `whole-board ${p.e_kind} entry ${p.e_from} moving to ${p.e_path}`;
    const def =
      p.d_id <= since
        ? `workspace definition ${p.d_id} at ${p.d_path} in scope ${p.d_scope}`
        : p.d_from === null
          ? `the workspace definition being placed at ${p.d_path} in scope ${p.d_scope}`
          : `workspace definition ${p.d_from} moving to ${p.d_path} in scope ${p.d_scope}`;
    return `${entry} lies at or under ${def}`;
  });
  const placesWholeBoard = db.prepare("SELECT 1 FROM memory_entries WHERE scope IS NULL AND id > ?").get(since) !== undefined;
  const side = (id: number, from: number | null) => ({ id: id <= since ? id : from, existing: id <= since });
  throw new OneTreeError(
    `${hits.join("; ")}: a workspace cannot define a path that holds whole-board entries at or under it — ` +
      (placesWholeBoard
        ? "write a whole-board definition at the workspace definition's path with supersedes, rename the workspace branch with move_memory_branch, or choose another path"
        : "file under the branch as it is, or define a sub-branch"),
    pairs.map((p) => ({
      entry: { ...side(p.e_id, p.e_from), kind: p.e_kind as MemoryEntryFields["kind"], path: p.e_path },
      definition: { ...side(p.d_id, p.d_from), path: p.d_path, scope: p.d_scope },
    })),
  );
}

/** 門が名指す組の片側: 今ある行(`existing`)か、この操作が置く行(`id` は null)・動かす行(`id` は移動元)。 */
interface OneTreeSide {
  id: number | null;
  existing: boolean;
  path: string;
}
export interface OneTreePair {
  entry: OneTreeSide & { kind: MemoryEntryFields["kind"] };
  definition: OneTreeSide & { scope: string };
}

/** 重ねた1本の木の門の拒否(ADR 0221): message は worker・管理MCP が読む英語の文のまま、当たった組をすべて構造で持つ。 */
export class OneTreeError extends DomainError {
  constructor(
    message: string,
    readonly pairs: OneTreePair[],
  ) {
    super(message);
  }
}

/** Knowledge の書き込み(spec #586 E)。承認不要なので書いた瞬間に approved。 */
export function recordKnowledge(db: Db, input: EntryInput & { supersedes?: number[] }, origin: EventOrigin, at: Date): { entry_id: number; event_id: number } {
  const { supersedes, ...fields } = input;
  return writeSuperseding(db, supersedes, fields.author, origin, at, () =>
    createEntry(db, { ...fields, kind: "knowledge", state: "approved", original: fields.original ?? null, addressee: null }, origin, at),
  );
}

/** 枝の定義(spec #600 A): その枝の下に何を保存するかの1行。承認不要で書いた瞬間に approved、
 *  出所は持たない(自身の作成 event)。同じ枝・同じスコープの approved は1つだけ —— 改訂は
 *  `supersedes` に旧定義を含める。置き換えられるのは同じ path の定義だけで(畳みの線 —— foldMemoryEntries)、枝の改名と統合は
 *  枝ごとの移動が持つ(ADR 0177 決定6)。meta-review は defineMemoryByMetaReview の門を通して呼ぶ。 */
export function defineMemoryBranch(
  db: Db,
  input: Omit<EntryInput, "title"> & { supersedes?: number[] },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_id: number } {
  if (/[\r\n]/.test(input.text)) throw new DomainError("a definition must be one line");
  const { supersedes, ...rest } = input;
  const fields = { ...rest, path: checkedPath(rest.path) };
  return writeSuperseding(db, supersedes, fields.author, origin, at, () => {
    const defined = liveDefinitions(db, fields.scope, fields.path).find((id) => !supersedes?.includes(id));
    if (defined) throw new DomainError(`branch ${fields.path} is already defined in this scope by entry ${defined}; revise it with supersedes`);
    return createEntry(db, { ...fields, title: fields.text, kind: "definition", state: "approved", original: fields.original ?? null, addressee: null }, origin, at);
  });
}

/** meta-review の `define_memory`(ADR 0161 追記7): defineMemoryBranch に覆いの門を掛ける。Definition は宛先を持たないので
 *  門は scope だけを見る —— 別 path の定義を置き換えない線は foldMemoryEntries が両方の面に持つ(ADR 0177 決定6)。人間の面は
 *  defineMemoryBranch を直接呼ぶ。 */
export function defineMemoryByMetaReview(db: Db, input: Parameters<typeof defineMemoryBranch>[1], origin: EventOrigin, at: Date): { entry_id: number; event_id: number } {
  requireCovers({ scope: input.scope, addressee: null }, (input.supersedes ?? []).map((id) => requireLive(db, id, undefined, "approved")));
  return defineMemoryBranch(db, input, origin, at);
}

/** 既にある後継への畳み(ADR 0162 決定1・2): replaces(1つ以上、approved も candidate も)を successor_id の superseded にする。
 *  1 transaction。後継が approved・未無効化であることと種別の線は無効化の門が持つ。Definition を別 path の Definition へは畳まない
 *  —— path を跨ぐ定義の superseded は枝ごとの移動の統合だけが書く(ADR 0177 決定6)。人間の面と書き込みの supersedes が直接、
 *  meta-review は foldMemory の門を通して呼ぶ。返り値の event_ids は replaces の memory_entry_invalidated。 */
export function foldMemoryEntries(
  db: Db,
  input: { replaces: number[]; successor_id: number; author: Actor },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_ids: number[] } {
  const { replaces, successor_id, author } = input;
  if (replaces.length === 0) throw new DomainError("a fold needs at least one entry to replace");
  return db.transaction(() => {
    const successor = requireEntry(db, successor_id);
    for (const row of replaces.map((id) => requireEntry(db, id))) {
      if (row.kind === "definition" && successor.kind === "definition" && row.path !== successor.path) {
        throw new DomainError(
          `definition ${row.id} at ${row.path} cannot be replaced by a definition at ${successor.path}: a definition is replaced only at its own path — merge branches with move_memory_branch and merge: true`,
        );
      }
    }
    return {
      entry_id: successor_id,
      event_ids: replaces.map((id) => invalidateMemoryEntry(db, { entry_id: id, reason: "superseded", successor_id }, author.name, origin, at, { activity: author.activity })),
    };
  })();
}

/** 覆いの門(ADR 0161 決定6・追記7): meta-review の直接の畳みは、後継の scope が盤面全体か各 replaces と同じで、宛先が全員か
 *  各 replaces と同じときだけ。scope を変える畳みは移動の側で、狭める置き換えは人間の判断。 */
function requireCovers(successor: { scope: string | null; addressee: string | null }, replaced: EntryRow[]): void {
  for (const row of replaced) {
    if (successor.scope !== null && successor.scope !== row.scope) {
      throw new DomainError(`the successor in scope ${successor.scope} does not cover memory entry ${row.id} in scope ${row.scope ?? "whole board"}: the successor must be whole-board or in the same scope`);
    }
    if (successor.addressee !== null && successor.addressee !== row.addressee) {
      throw new DomainError(`the successor addressed to ${successor.addressee} does not cover memory entry ${row.id} addressed to ${row.addressee ?? "every agent"}: the successor must address every agent or the same agent`);
    }
  }
}

/** meta-review の畳み(issue #619 / ADR 0122 決定1 / ADR 0161 決定2・6): foldMemoryEntries に meta-review の門を掛ける。
 *  後継は新しく書く Knowledge(`based_on_decision` の decision(推論)を出所に)か、既にある approved の `successor_id` のどちらか一方で、
 *  どちらも replaces を覆う(requireCovers)。組(Knowledge → Knowledge、Behavior / Exemplar ↔)は種別の線が持ち、approved の
 *  Behavior / Exemplar は承認の線なので consolidate の提案へ回す。Definition → Definition は同じ path に限られ、覆う後継(盤面全体か
 *  同じ scope)は同じ path に並べない(ADR 0178)ので、ここでは起きない。 */
export function foldMemory(
  db: Db,
  metaReviewId: string,
  input: Partial<Omit<EntryInput, "source" | "original" | "author"> & { based_on_decision: number; successor_id: number }> & {
    replaces: number[];
    author: MemoryEntryFields["author"];
  },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_ids: number[] } {
  const { replaces, successor_id, author, ...draft } = input;
  if ((successor_id === undefined) === Object.values(draft).every((value) => value === undefined)) {
    throw new DomainError("fold_memory takes exactly one of successor_id (an existing approved entry) and scope, path, title, text and based_on_decision (a new knowledge entry)");
  }
  return db.transaction(() => {
    const replaced = replaces.map((id) => requireNotApprovedBehaviorOrExemplar(db, id));
    let successor = successor_id;
    if (successor === undefined) {
      const { scope, path, title, text, based_on_decision } = draft;
      if (scope === undefined || path === undefined || title === undefined || text === undefined || based_on_decision === undefined) {
        throw new DomainError("a new knowledge entry needs scope, path, title, text and based_on_decision");
      }
      successor = recordKnowledge(db, { scope, path, title, text, author, source: { event_id: requireDecision(db, based_on_decision, metaReviewId) } }, origin, at).entry_id;
    }
    requireCovers(requireEntry(db, successor), replaced);
    return foldMemoryEntries(db, { replaces, successor_id: successor, author }, origin, at);
  })();
}

type Actor = MemoryEntryFields["author"];

/** 移動の本体(ADR 0162 決定4・5)。盤面が本文の側 —— title・text・原文・宛先・注釈・出所・書き手・状態・版 —— を写して新しい
 *  scope / path に複製を作り、旧を `path_moved` で複製へ指す(「本文は同じ」は申告でなくここが保証する)。複製は新規の書き込みでは
 *  ないので書き込みの門(approved の Behavior / Exemplar は人間だけ・人間の Knowledge は出所なし・注釈の再検査)を掛けない。出所が
 *  自身の宣言なら複製も自身の宣言(ADR 0162 追記)。移した者は両方の event の activity に載る。移される Definition の置き場に、
 *  一緒に移されない生きた Definition があれば衝突 —— エントリ1件の移動(merge が undefined)は畳むよう促して拒む。枝ごとの移動は
 *  merge なら衝突する各 Definition を置き場の定義の `superseded` にし(複製は作らない)、merge が無ければ衝突の組をすべて名指して
 *  拒み、merge で衝突が無くても拒む(ADR 0177 決定1〜3)。1 transaction。 */
function moveEntries(
  db: Db,
  moves: Array<{ old: EntryRow; scope: string | null; path: string }>,
  mover: Actor,
  origin: EventOrigin,
  at: Date,
  merge?: boolean,
) {
  const moving = new Set(moves.map(({ old }) => old.id));
  return db.transaction(() => {
    const since = memoryWatermark(db);
    const into = new Map<number, number>();
    const collisions: string[] = [];
    for (const { old, scope, path } of moves) {
      if (old.scope === scope && old.path === path) throw new DomainError(`memory entry ${old.id} is already at ${path} in this scope`);
      if (old.kind !== "definition") continue;
      const defined = liveDefinitions(db, scope, path).find((id) => !moving.has(id));
      if (defined === undefined) continue;
      if (merge === undefined) throw new DomainError(`branch ${path} is already defined in that scope by entry ${defined}: fold the two definitions into one instead of moving`);
      into.set(old.id, defined);
      collisions.push(`definition ${old.id} onto definition ${defined} at ${path} in scope ${scope ?? "whole board"}`);
    }
    if (!merge && collisions.length > 0) {
      throw new DomainError(`the move would land ${collisions.join(", ")}: pass merge: true to fold each into the definition already there and move the rest`);
    }
    if (merge && collisions.length === 0) throw new DomainError("merge: true, but no moved definition lands on a path already defined in its scope: move without merge");
    const folded = [...into].map(([entry_id, successor_id]) => {
      invalidateMemoryEntry(db, { entry_id, reason: "superseded", successor_id }, mover.name, origin, at, { activity: mover.activity });
      return { entry_id, successor_id };
    });
    const moved = moves
      .filter(({ old }) => !into.has(old.id))
      .map(({ old: row, scope, path }) => {
        const old = rowToEntry(row);
        const copy = copyBody(db, old, { scope, path }, mover, origin, at, old.version === null ? {} : { version: old.version });
        invalidateMemoryEntry(db, { entry_id: old.id, reason: "path_moved", successor_id: copy }, mover.name, origin, at, { activity: mover.activity });
        return { entry_id: old.id, successor_id: copy };
      });
    requireOneTree(db, since);
    return { moved, folded };
  })();
}

/** scope / path に生きている Definition の id(定義の書き込み・移動・復元の置き場の門)。 */
function liveDefinitions(db: Db, scope: string | null, path: string): number[] {
  return (
    db.prepare("SELECT id FROM memory_entries WHERE kind = 'definition' AND invalidation_reason IS NULL AND path = ? AND scope IS ?").all(path, scope) as Array<{ id: number }>
  ).map(({ id }) => id);
}

/** 本文の側の複製(移動と復元が共有する): 出所・書き手・状態ごと写して place に作り、写した者を作成 event の activity に載せる。
 *  mark は移動が継ぐ版か、復元の復元元。返り値は複製の id。 */
function copyBody(
  db: Db,
  old: MemoryEntry,
  place: Pick<MemoryEntryFields, "scope" | "path">,
  actor: Actor,
  origin: EventOrigin,
  at: Date,
  mark: { version?: number; restored_from?: number },
): number {
  const { id: _id, version: _version, source: _source, ...body } = old;
  const entry: MemoryEntryFields = { ...body, ...place, source: inheritableSource(old) ?? null };
  const id = appendEvent(db, { taskId: null, workerId: actor.name, origin, payload: { kind: "memory_entry_created", entry, activity: actor.activity, ...mark }, at });
  insertEntry(db, id, entry, mark.version);
  return id;
}

/** 復元元の id → 復元の複製の id(ADR 0163 追記 #1059)。正本は複製の作成 event の restored_from で、旧の行に列は持たない。
 *  一度復元した旧は再び復元できないので復元元ごとに高々1つ。 */
function restoredAs(db: Db): Map<number, number> {
  return new Map(
    (
      db
        .prepare("SELECT json_extract(payload, '$.restored_from') AS old, id FROM events WHERE kind = 'memory_entry_created' AND json_extract(payload, '$.restored_from') IS NOT NULL")
        .all() as Array<{ old: number; id: number }>
    ).map(({ old, id }) => [old, id]),
  );
}

/** 本文が同じ後継の鎖(row 自身から末尾まで): `path_moved` の後継と、restored を渡せば復元の複製(ADR 0167 決定1)。
 *  どちらの複製も旧より後の行なので鎖は閉じない。 */
function sameBodyChain(db: Db, row: EntryRow, restored?: Map<number, number>): EntryRow[] {
  const chain = [row];
  for (;;) {
    const last = chain.at(-1)!;
    const next = last.invalidation_reason === "path_moved" ? last.successor_id : restored?.get(last.id);
    if (next == null) return chain;
    chain.push(requireEntry(db, next));
  }
}

/** id の `path_moved` の鎖の末尾(id 自身か、最後に移した複製)。提案 question の pin の照合・適用(ADR 0162 決定6)と、
 *  復元が見る後継の生死が読む。 */
export function movedTail(db: Db, id: number): EntryRow {
  return sameBodyChain(db, requireEntry(db, id)).at(-1)!;
}

/** 復元(ADR 0163): 無効化済みのエントリ(4種別、状態は問わない)の本文の側を同じ scope / path に写して新エントリにする ——
 *  移動の複製と同じ形で新規の書き込みの門は掛けず、版は継がない(approved なら版は複製の作成 event)。旧の行は触らず、旧を pin して
 *  いた提案 question も戻さない。`path_moved` と一度復元した旧は複製の側を扱う(移し戻すか、落ちた複製を復元する —— 追記 #1059)
 *  ので拒み、後継が生きている間も拒む —— 後継の `path_moved` の鎖は末尾までたどる(`superseded` はたどらない)。Definition は同じ枝に生きた Definition があれば拒む。 */
export function restoreMemoryEntry(
  db: Db,
  input: { entry_id: number; restorer: Actor },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_id: number } {
  return db.transaction(() => {
    const since = memoryWatermark(db);
    const row = requireEntry(db, input.entry_id);
    if (row.invalidation_reason === null) throw new DomainError(`memory entry ${row.id} is not invalidated`);
    if (row.invalidation_reason === "path_moved") {
      throw new DomainError(`memory entry ${row.id} was moved to entry ${row.successor_id}: move that copy back, or restore it if it was invalidated`);
    }
    const copy = restoredAs(db).get(row.id);
    if (copy !== undefined) throw new DomainError(`memory entry ${row.id} was already restored as entry ${copy}: handle that copy instead`);
    const successor = row.successor_id === null ? undefined : movedTail(db, row.successor_id);
    if (successor && successor.invalidation_reason === null) {
      throw new DomainError(`memory entry ${row.id} was replaced by the live successor ${successor.id}: invalidate that first`);
    }
    const [defined] = row.kind === "definition" ? liveDefinitions(db, row.scope, row.path) : [];
    if (defined) throw new DomainError(`branch ${row.path} is already defined in that scope by entry ${defined}: invalidate it first`);
    const old = rowToEntry(row);
    const id = copyBody(db, old, { scope: old.scope, path: old.path }, input.restorer, origin, at, { restored_from: old.id });
    requireOneTree(db, since);
    return { entry_id: id, event_id: id };
  })();
}

/** エントリ1件の移動(ADR 0162 決定4): 4種別の未無効化の approved か candidate を、scope(null = 盤面全体)と path へ。
 *  Definition で変えられるのは scope だけ —— path を変えると配下の leaf が旧 path に残るので枝ごとの移動へ(ADR 0176 決定7)。
 *  人間の面と meta-review の `move_memory`(moveMemoryByMetaReview)が共有する。返り値は複製。 */
export function moveMemory(
  db: Db,
  input: { entry_id: number; scope: string | null; path: string; mover: Actor },
  origin: EventOrigin,
  at: Date,
): { entry_id: number; event_id: number } {
  const old = requireEntry(db, input.entry_id);
  const path = checkedPath(input.path);
  if (old.kind === "definition" && old.path !== path) {
    throw new DomainError(`memory entry ${old.id} is the definition of branch ${old.path}: move the whole branch with move_memory_branch to change its path`);
  }
  const { successor_id } = moveEntries(db, [{ old, scope: input.scope, path }], input.mover, origin, at).moved[0]!;
  return { entry_id: successor_id, event_id: successor_id };
}

/** 枝ごとの移動(ADR 0162 決定4 / ADR 0177 決定1〜5): scope(null = 盤面全体)で path が P か P/… の未無効化エントリすべてを、
 *  to_scope の to_path + 残りの path へ1 transaction で。盤面全体 → 盤面全体なら全 workspace の同じ配下も運び、それぞれ自分の scope に
 *  残す(branchRows —— それ以外は scope の完全一致)。merge は行き先に定義があるという申告で、衝突する定義は行き先の定義へ畳む(moveEntries —— 衝突は scope ごと)。
 *  無効化済みは元の置き場に残る。返り値は旧 id → 複製の id と、畳んだ定義 → 畳み先の定義。 */
export function moveMemoryBranch(
  db: Db,
  input: { scope: string | null; path: string; to_scope: string | null; to_path: string; merge?: boolean; mover: Actor },
  origin: EventOrigin,
  at: Date,
): ReturnType<typeof moveEntries> {
  const { scope, to_scope, merge, mover } = input;
  const path = checkedPath(input.path);
  const to_path = checkedPath(input.to_path);
  const rows = branchRows(db, { scope, path, to_scope });
  if (rows.length === 0) throw new DomainError(`no live memory entry at ${path} or under it in this scope`);
  const moves = rows.map((old) => ({ old, scope: old.scope === scope ? to_scope : old.scope, path: to_path + old.path.slice(path.length) }));
  return moveEntries(db, moves, mover, origin, at, merge ?? false);
}

/** 枝ごとの移動が移す行(移動と meta-review の門が同じ集合を見る): scope(完全一致)で path が P か P/… の未無効化エントリ。
 *  盤面全体 → 盤面全体で盤面全体に1件でもあれば、全 workspace の同じ配下も足す(ADR 0177 決定5)。id 順。 */
function branchRows(db: Db, { scope, path, to_scope }: { scope: string | null; path: string; to_scope: string | null }): EntryRow[] {
  const under = (db.prepare("SELECT * FROM memory_entries WHERE invalidation_reason IS NULL ORDER BY id").all() as EntryRow[]).filter((row) => atOrUnder(row.path, path));
  const own = under.filter((row) => row.scope === scope);
  return scope === null && to_scope === null && own.length > 0 ? under : own;
}

/** meta-review の `move_memory`(ADR 0176 決定1〜4): 4種別の approved / candidate を同じ scope の中で直接移せ、scope を跨ぐのは
 *  盤面全体へ広げる向きだけ(requireWidening)。書き手は継ぎ、移した meta-review は activity に載るので自身の移動は次の周期の
 *  材料にならない(ADR 0151)。人間の面は moveMemory を直接呼ぶ。 */
export function moveMemoryByMetaReview(db: Db, input: Parameters<typeof moveMemory>[1], origin: EventOrigin, at: Date): { entry_id: number; event_id: number } {
  return db.transaction(() => {
    const old = requireEntry(db, input.entry_id);
    requireWidening(db, [old], old.scope, input.scope);
    return moveMemory(db, input, origin, at);
  })();
}

/** meta-review の `move_memory_branch`(ADR 0176 決定1・5 / ADR 0177 決定5): 移す行すべて(盤面全体 → 盤面全体で運ぶ workspace の行も)
 *  に scope の門を掛けてから、人間の面と同じ本体で移す。1件でも門に掛かれば何も書かない —— 枝を自分で割らない。 */
export function moveMemoryBranchByMetaReview(
  db: Db,
  input: Parameters<typeof moveMemoryBranch>[1],
  origin: EventOrigin,
  at: Date,
): ReturnType<typeof moveMemoryBranch> {
  return db.transaction(() => {
    requireWidening(db, branchRows(db, { ...input, path: checkedPath(input.path) }), input.scope, input.to_scope);
    return moveMemoryBranch(db, input, origin, at);
  })();
}

/** meta-review の scope の門(ADR 0176 決定2〜5): 行き先の scope は移動元と同じか盤面全体だけ。scope が変わるなら、approved の
 *  Behavior / Exemplar と open な提案 question が名指すエントリ(既存の後継も数える)を1件でも含めば全体を拒み、すべて名指す。 */
function requireWidening(db: Db, rows: EntryRow[], from: string | null, to: string | null): void {
  if (to === from) return;
  if (to !== null) {
    throw new DomainError(
      `a meta-review moves entries in scope ${from ?? "whole board"} only within it or to the whole board: narrowing to a workspace or moving between workspaces is the human's — say so with log_decision and leave the entries in place`,
    );
  }
  const blocked = rows.flatMap((row) => {
    const questions = openProposalsPinning(db, row.id, true);
    if (questions.length > 0) return [`memory entry ${row.id} (named by open proposal question ${questions.join(", ")})`];
    if ((row.kind === "behavior" || row.kind === "exemplar") && row.state === "approved") return [`memory entry ${row.id} (an approved ${row.kind})`];
    return [];
  });
  if (blocked.length > 0) {
    throw new DomainError(`a meta-review cannot change the scope of ${blocked.join(", ")}: say so with log_decision and leave the entries in place`);
  }
}

/** LLM が合成した本文の出所 = 書き手が log_decision で書いた推論(meta-review の畳みと統合、RCA の Knowledge —— ADR 0115 追記)。
 *  書き手は呼んだ task で引く(events.task_id —— ADR 0120 決定1(a))。他 task の decision だと由来の連鎖が別の task に着地する。 */
export function requireDecision(db: Db, eventId: number, taskId: string): number {
  const event = getEvent(db, eventId);
  if (event?.kind !== "decision_logged") throw new DomainError(`event ${eventId} is not a logged decision`);
  if (event.task_id !== taskId) throw new DomainError(`event ${eventId} is not a decision of this task`);
  return eventId;
}

/** 人間の面(settings の HTTP / 管理MCP)の書き込み欄(spec #586 F)。workspace は null = 盤面全体、
 *  original_title / original_text は人間の原文で言語は盤面の表示言語。出所欄は Behavior(任意)と Exemplar(必須)だけが持つ(ADR 0083 追記5 / ADR 0153 決定3)。 */
const humanEntryFields = {
  workspace: requiredTextSchema.nullable(),
  path: requiredTextSchema,
  text: requiredTextSchema,
  original_text: z.string().optional(),
  /** 新エントリが置き換える approved のエントリ(ADR 0162 決定1)。 */
  supersedes: z.array(z.number().int().positive()).optional(),
};
export const humanKnowledgeSchema = z.object({ ...humanEntryFields, title: requiredTextSchema, original_title: z.string().optional() });
export const humanDefinitionSchema = z.object(humanEntryFields);
/** Behavior は Knowledge の欄 + 宛先(null = 全員)と任意の出所の Episode(ADR 0152 / ADR 0153 決定3)。 */
export const humanBehaviorSchema = humanKnowledgeSchema.extend({
  addressee: requiredTextSchema.nullable(),
  source_event_id: z.number().int().positive().optional(),
});
/** Exemplar の注釈(ADR 0153 決定1・3)。anchor は case 描画の欄に結ぶ —— `whole` か、欄(decision / steering / handoff /
 *  result)とその逐語部分文字列。text は英語の正文、original は人間の原文(言語は盤面の表示言語)。 */
export const exemplarAnnotationSchema = z.object({
  anchor: z.union([z.literal("whole"), z.object({ field: z.enum(["decision", "steering", "handoff", "result"]), quote: requiredTextSchema })]),
  polarity: z.enum(["imitate", "avoid"]),
  text: requiredTextSchema,
  original: z.string().optional(),
});
type ExemplarAnnotation = Omit<z.infer<typeof exemplarAnnotationSchema>, "original"> & { original?: { text: string; language: string } };
/** meta-review の consolidate の注釈: 原文は人間のものなので持たない(渡されたら黙って捨てず断る)。 */
export const metaReviewAnnotationSchema = exemplarAnnotationSchema.omit({ original: true }).strict();
/** Exemplar は Behavior の置き場・title・宛先・supersedes・出所の Episode + 注釈の list。英語の title の原文は持たない。出所は
 *  supersedes の揃った出所を継ぐときだけ省ける(recordExemplar)。 */
export const humanExemplarSchema = humanBehaviorSchema.pick({ workspace: true, path: true, title: true, addressee: true, supersedes: true, source_event_id: true }).extend({
  annotations: z.array(exemplarAnnotationSchema),
});

/** memory の提案の approve に添える修正値(ADR 0152 決定2): 文言と宛先と Exemplar の注釈 list。置き場(path / scope)は動かさない。
 *  扉は形だけを見る —— candidate の種別ごとの拒否(Exemplar に text・原文、Behavior に注釈)は approveMemoryProposal が持つ。 */
const memoryAmendmentSchema = humanBehaviorSchema
  .pick({ title: true, text: true, addressee: true, original_title: true, original_text: true })
  .extend({ annotations: z.array(exemplarAnnotationSchema) })
  .partial()
  .strict()
  .refine((amendment) => Object.keys(amendment).length > 0, { message: "name at least one field" });
export type MemoryAmendment = z.infer<typeof memoryAmendmentSchema>;

/** 回答の `amendment` の検査。schema 違反は DomainError(扉は形を緩く受ける)。 */
export function parseMemoryAmendment(input: unknown): MemoryAmendment {
  const parsed = memoryAmendmentSchema.safeParse(input);
  if (!parsed.success) throw new DomainError(`a memory amendment takes title, text, addressee, original_title + original_text and annotations, nothing else: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data;
}

/** meta-review の invalidate_memory は後継なしで落とすだけ(ADR 0161 決定2): 後継 id は黙って捨てず断る。置き換えは畳みと
 *  定義の supersedes、置き場の変更は移動(`path_moved` を書くのは移動だけ)が持つ。 */
export const metaReviewInvalidationSchema = z.object({ reason: z.enum(INVALIDATION_REASONS).exclude(["superseded", "path_moved"]) }).strict();
/** 人間の面の無効化(ADR 0161 決定4)と提案の invalidate op の理由: meta-review と同じく後継なしで落とすだけで、`rejected` は
 *  提案 question の reject と meta-review の candidate の引退(issue #954)だけが書く。 */
export const invalidationSchema = metaReviewInvalidationSchema.extend({ reason: metaReviewInvalidationSchema.shape.reason.exclude(["rejected"]) });
/** 人間の面の移動(ADR 0162 決定4)。workspace null = 盤面全体。エントリ1件は移動先(扉が entry_id を足す)、枝ごとは移動元と移動先と
 *  統合の申告 merge(ADR 0177 決定2)。 */
export const memoryMoveSchema = z.object({ workspace: humanEntryFields.workspace, path: requiredTextSchema });
export const memoryBranchMoveSchema = z.object({
  workspace: humanEntryFields.workspace,
  path: requiredTextSchema,
  to_workspace: humanEntryFields.workspace,
  to_path: requiredTextSchema,
  merge: z.boolean().optional(),
});
/** 人間の面の既にある後継への畳み(ADR 0162 決定1)。 */
export const memoryFoldSchema = z.object({ replaces: z.array(z.number().int().positive()), successor_id: z.number().superRefine((value, ctx) => {
  const reason = whyNotPositiveInteger(value);
  if (reason) ctx.addIssue({ code: "custom", message: reason });
}) });

/** 一覧の絞り込み(HTTP の query と管理MCP が共有)。workspace は完全一致、board_wide は盤面全体だけ。 */
export const memoryListFilterSchema = z.object({
  workspace: requiredTextSchema.optional(),
  kind: z.enum(["knowledge", "behavior", "definition", "exemplar"]).optional(),
  state: z.enum(["candidate", "approved", "invalidated"]).optional(),
  path: z.string().optional(),
});

/** 人間の面(settings の HTTP / 管理MCP)の書き手・移した者。 */
export const HUMAN_AUTHOR = { activity: "human", name: HUMAN_WORKER_ID } as const satisfies Actor;

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
    author: HUMAN_AUTHOR,
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
  return db.transaction(() => {
    const since = memoryWatermark(db);
    const id = createEntry(db, { ...input, kind: "behavior", state: "candidate", original: null }, origin, at);
    requireOneTree(db, since);
    return { entry_id: id, event_id: id };
  })();
}

/** 人間が書く Behavior(ADR 0152 決定3・4): 書いた時点で approved。出所は任意で事例の Episode(decision_logged か
 *  worker_spawned の event、ADR 0153 決定3)。渡さなければ `supersedes` の出所が1つに揃うとき(1件の編集も)それを継ぎ
 *  (RCA 起草の帰責 event も —— case は編集後も引ける)、揃わなければ自身の作成 event(ADR 0162 決定3)。
 *  `amends` は修正値つき approve の candidate(approveMemoryProposal だけが渡す): 出所の継ぎ方は1件の編集と同じで、無効化は呼び手が持つ。 */
export function recordBehavior(
  db: Db,
  input: Omit<EntryInput, "source"> & { addressee: string | null; source_event_id?: number; supersedes?: number[] },
  origin: EventOrigin,
  at: Date,
  mark?: { question_id: string },
  amends?: EntryRow,
): { entry_id: number; event_id: number } {
  const { source_event_id, supersedes, ...fields } = input;
  const cited = source_event_id === undefined ? undefined : citedEpisode(db, source_event_id);
  return writeSuperseding(db, supersedes, fields.author, origin, at, (replaced) => {
    const source = cited ?? sharedSource(amends ? [rowToEntry(amends)] : replaced);
    return createEntry(db, { ...fields, source, kind: "behavior", state: "approved", original: fields.original ?? null }, origin, at, mark);
  });
}

/** Exemplar の注釈の検査(人間の write と meta-review の consolidate が共有、ADR 0153 決定3)。各 anchor の quote は書く時点の
 *  出所の case 描画のその欄に逐語で含まれなければ拒否する(欄は不変の記録なので以後も一致する)。case を描けない出所
 *  (commit・推論の decision)は事例にならない。形の検査も domain が持つ(扉は形を緩く受けてよい)。text は注釈の英語 text の
 *  連結 —— FTS・注入・既存の読み手はそれを読む。 */
function checkedAnnotations<T extends z.infer<typeof metaReviewAnnotationSchema>>(
  db: Db,
  source: MemorySource,
  raw: unknown,
  schema: z.ZodType<T>,
): { annotations: T[]; text: string } {
  const parsed = z.array(schema).min(1).safeParse(raw);
  if (!parsed.success) {
    throw new DomainError(`an exemplar needs at least one annotation, each with an anchor, a polarity and a non-empty text: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  const rendered = renderCase(db, source);
  if (!rendered) throw new DomainError(`an exemplar's source must be a case the board can render: ${source.kind} ${source.ref}`);
  const fieldTexts: Record<"decision" | "steering" | "handoff" | "result", Array<string | null>> =
    "decisions" in rendered
      ? { decision: rendered.decisions, steering: [], handoff: [rendered.handoff], result: [rendered.result] }
      : { decision: [rendered.decision], steering: rendered.steering, handoff: [rendered.handoff], result: [rendered.result] };
  for (const { anchor } of parsed.data) {
    if (anchor !== "whole" && !fieldTexts[anchor.field].some((text) => text?.includes(anchor.quote))) {
      throw new DomainError(`the quote is not verbatim in the case's ${anchor.field}: ${JSON.stringify(anchor.quote)}`);
    }
  }
  return { annotations: parsed.data, text: parsed.data.map((a) => a.text).join("\n") };
}

/** 人間が書く Exemplar(ADR 0153 決定1・3): 書いた時点で approved。出所は事例の Episode(必須)で、渡さなければ `supersedes` の
 *  揃った出所を継ぐ(RCA 起草の帰責 event は事例に選べないので、それを出所に持つ approved の書き直しはこれだけが言える)。
 *  `amends` は注釈の修正値つき approve の candidate(approveMemoryProposal だけが渡す): 出所は candidate のものを継ぎ、無効化は呼び手が持つ。 */
export function recordExemplar(
  db: Db,
  input: Omit<EntryInput, "text" | "source" | "original"> & { addressee: string | null; source_event_id?: number; supersedes?: number[]; annotations: unknown },
  origin: EventOrigin,
  at: Date,
  mark?: { question_id: string },
  amends?: EntryRow,
): { entry_id: number; event_id: number } {
  const { source_event_id, supersedes, annotations: raw, ...fields } = input;
  return writeSuperseding(db, supersedes, fields.author, origin, at, (replaced) => {
    const source = amends ? rowToEntry(amends).source : source_event_id !== undefined ? citedEpisode(db, source_event_id) : sharedSource(replaced);
    if (!source) throw new DomainError("an exemplar needs source_event_id, or supersedes whose entries share one source: it keeps that as its case");
    const { annotations: checked, text } = checkedAnnotations(db, source, raw, exemplarAnnotationSchema);
    const language = getDisplayLanguage(db);
    const annotations = checked.map(({ original, ...annotation }) => (original?.trim() ? { ...annotation, original: { text: original, language } } : annotation));
    return createEntry(db, { ...fields, kind: "exemplar", state: "approved", text, original: null, annotations, source }, origin, at, mark);
  });
}

/** 人間の面の case preview(ADR 0153 決定3): 事例に選べる event の描画。anchor の quote はここから選ぶ。帰責 event は
 *  選べないが RCA 起草から継いだ Exemplar の candidate の出所で、その注釈の修正値(issue #950)の anchor を選ぶために描く
 *  —— 決定に解かず帰責そのものを描く(steering はその帰責の分だけ、checkedAnnotations が照らすのと同じ描画)。 */
export function previewCase(db: Db, eventId: number): MemoryCase {
  return previewCaseWithLineIds(db, eventId).rendered;
}

/** previewCase に、steering か decisions の各行の event id を同じ順で添える —— 管理MCP の preview_case の続きの鍵(issue #1399)。 */
export function previewCaseWithLineIds(db: Db, eventId: number): { rendered: MemoryCase; lineIds: number[] } {
  if (getEvent(db, eventId)?.kind !== "objection_attributed") citedEpisode(db, eventId);
  const keyed = renderCaseWithLineIds(db, { kind: "event", ref: eventId });
  if (!keyed) throw new DomainError(`event ${eventId} is not a case the board can render`);
  return keyed;
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
    const replaced = requireEntry(db, entry_id);
    if (replaced.invalidation_reason !== null) {
      throw new DomainError(`memory entry ${entry_id} is already invalidated`);
    }
    if (successor_id !== undefined) {
      const successor = requireEntry(db, successor_id);
      // 種別の線(ADR 0161 決定1): Behavior ↔ Exemplar は superseded で互いに、それ以外は同じ種別だけ
      const bothBehaviorOrExemplar = [replaced.kind, successor.kind].every((kind) => kind === "behavior" || kind === "exemplar");
      if (replaced.kind !== successor.kind && !(reason === "superseded" && bothBehaviorOrExemplar)) {
        throw new DomainError(`${replaced.kind} entry ${entry_id} cannot be ${reason} by ${successor.kind} entry ${successor_id}`);
      }
      // 後継は注入に届く側でなければ置換の連鎖が行き止まる。移動の複製は旧の状態のまま(candidate は candidate、ADR 0162 決定5)
      const state = reason === "path_moved" ? replaced.state : "approved";
      if (successor.state !== state || successor.invalidation_reason !== null) {
        throw new DomainError(`successor ${successor_id} must be ${state === "approved" ? "an approved" : "a candidate"}, non-invalidated entry`);
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
    // answerQuestion が先に done にしているので、reject や承認の superseded が自分自身を決着させることは無い。移動は本文が
    // 同じなので決着させない —— pin は複製へたどる(ADR 0162 決定6)
    if (reason !== "path_moved") {
      for (const id of openProposalsPinning(db, entry_id, true)) {
        settleQuestionAsObserved(db, id, { kind: "memory_proposal_stale", question_id: id, entry_id, observed_event_id: eventId }, at);
      }
    }
    return eventId;
  })();
}

/** meta-review が直接落とせるエントリ(ADR 0160 決定1): approved の Behavior / Exemplar は承認の線なので提案へ回す。
 *  無効化済みは提案にも回せないので先に断る。 */
function requireNotApprovedBehaviorOrExemplar(db: Db, id: number): EntryRow {
  const row = requireEntry(db, id);
  if (row.invalidation_reason !== null) throw new DomainError(`memory entry ${row.id} is already invalidated`);
  if ((row.kind === "behavior" || row.kind === "exemplar") && row.state === "approved") throw new DomainError(`memory entry ${row.id} is an approved ${row.kind}: propose it instead`);
  return row;
}

/** meta-review の無効化(ADR 0122 決定1 / ADR 0160 決定1 / ADR 0161 決定2): 後継なしで落とすだけ —— 置き換えは `fold_memory`・
 *  `define_memory` の supersedes・`moveMemory`・`moveMemoryBranch` が持つ。`rejected` は Behavior にも Exemplar にもならない candidate の引退(issue #954)。 */
export function invalidateMemoryByMetaReview(
  db: Db,
  input: Parameters<typeof invalidateMemoryEntry>[1],
  workerId: string,
  origin: EventOrigin,
  at: Date,
): number {
  if (input.reason === "superseded" || input.reason === "path_moved") {
    throw new DomainError(`invalidate_memory does not take ${input.reason}: replace with fold_memory, define_memory's supersedes, move_memory or move_memory_branch`);
  }
  const row = requireNotApprovedBehaviorOrExemplar(db, input.entry_id);
  if (input.reason === "rejected" && row.state !== "candidate") throw new DomainError(`rejected retires only a candidate; memory entry ${row.id} is not one`);
  return invalidateMemoryEntry(db, input, workerId, origin, at, { activity: "meta_review" });
}

/** この entry を pin する open な提案 question の id(陳腐化の hook と、同じ entry への二重提案の拒否が読む)。既存の後継は
 *  陳腐化の hook だけが数える(ADR 0160 決定3)。pin は `path_moved` の鎖の末尾で見る —— 移す前の id を pin する question も
 *  複製を pin している(ADR 0162 決定6)。 */
function openProposalsPinning(db: Db, entryId: number, successors: boolean): string[] {
  const open = db
    .prepare("SELECT id, question_proposal FROM tasks WHERE status = 'todo' AND json_extract(question_proposal, '$.kind') = 'memory'")
    .all() as Array<{ id: string; question_proposal: string }>;
  return open
    .filter(({ question_proposal }) => pinnedIds(JSON.parse(question_proposal) as MemoryProposal, successors).some((id) => movedTail(db, id).id === entryId))
    .map(({ id }) => id);
}

/** 提案が pin した entry の id: 名指す entry(candidate・invalidate の target・既存の後継 —— 後継は successors のときだけ)と replaces。 */
function pinnedIds(proposal: MemoryProposal, successors: boolean): number[] {
  const named = "candidate_id" in proposal ? proposal.candidate_id : proposal.op === "invalidate" ? proposal.target.id : successors ? proposal.successor.id : undefined;
  return [...(named === undefined ? [] : [named]), ...proposal.replaces.map(({ id }) => id)];
}

/** 提案 question の移動の注釈(ADR 0162 決定6): 移された pin ごとに旧 id と末尾の id・path・scope。pin と detail は見せた時点の
 *  まま焼いてあるので、今の置き場は読むときにここで引く(承認 question の `approval` 注釈と同じ位置、issue #757)。 */
export function movedPins(db: Db, proposal: QuestionProposal<TierRef> | null): Array<{ id: number; tail_id: number; path: string; scope: string | null }> {
  if (proposal?.kind !== "memory") return [];
  return pinnedIds(proposal, true).flatMap((id) => {
    const tail = movedTail(db, id);
    return tail.id === id ? [] : [{ id, tail_id: tail.id, path: tail.path, scope: tail.scope }];
  });
}

/** question 行が読むときに運ぶ6つの注釈(issue #1179・ADR 0092 決定4・ADR 0179 決定4・issue #1309・#1304)。HTTP の `GET /api/tasks`・
 *  `GET /api/tasks/:id` と管理MCP の `list_board`・`get_task` がここを広げる。 */
export function questionAnnotations(
  db: Db,
  task: Omit<Task, "status" | "question_proposal"> & { question_proposal: QuestionProposal<TierRef> | null },
) {
  return {
    landing: landingAnnotation(db, task),
    approval: approvalAnnotation(db, task),
    moved: movedPins(db, task.question_proposal),
    blocking: questionBlocking(db, task.id),
    needs_comment: needsComment(task),
    free_text: !isFixedChoiceQuestion(task),
  };
}

/** pin 検査(ADR 0120 決定4): candidate が未無効化の Behavior / Exemplar candidate(invalidate op は target、既存の後継の
 *  consolidate は後継の版が一致し未無効化)で、replaces の版が現在と一致し未無効化。各 pin は `path_moved` の鎖の末尾で
 *  照合し(ADR 0162 決定6)、返した末尾(名指す entry と replaces の id)へ適用する。
 *  approve も reject も、見せた状態に対してだけ適用する。 */
function assertProposalFresh(db: Db, proposal: MemoryProposal): { named: EntryRow; replaced: number[] } {
  const unchanged = (row: EntryRow, version: number | null) => row.version === version && row.invalidation_reason === null;
  const pinned = "candidate_id" in proposal ? undefined : proposal.op === "invalidate" ? proposal.target : proposal.successor;
  const named = movedTail(db, "candidate_id" in proposal ? proposal.candidate_id : pinned!.id);
  const replaced = proposal.replaces.map(({ id, version }) => ({ row: movedTail(db, id), version }));
  const fresh =
    (pinned
      ? unchanged(named, pinned.version)
      : (named.kind === "behavior" || named.kind === "exemplar") && named.state === "candidate" && named.invalidation_reason === null) &&
    replaced.every(({ row, version }) => unchanged(row, version));
  if (!fresh) throw new DomainError("this proposal is stale: a memory entry it names changed since it was proposed");
  return { named, replaced: replaced.map(({ row }) => row.id) };
}

function markApproved(db: Db, id: number, version: number): void {
  db.prepare("UPDATE memory_entries SET state = 'approved', version = ? WHERE id = ?").run(version, id);
}

/** Behavior / Exemplar 承認の export(spec #615 A / issue #620): pin 検査(assertProposalFresh)→ memory_entry_approved(版 = この event の id)→ replaces を candidate を後継とする superseded で
 *  無効化、を1 transaction。承認は人間の回答なので人間名義。返り値は memory_entry_approved の event id。
 *  invalidate op(issue #621)は target を理由コードで後継なしに無効化し、その memory_entry_invalidated の event id を返す。
 *  既存の後継の consolidate(ADR 0160 決定2)は replaces をその後継の superseded にし、後継の id を返す。
 *  修正値つき(ADR 0152 決定2・4)は candidate を approved にせず、人間名義の approved エントリ(欠けた欄は candidate の値)を作って
 *  candidate と replaces をそれの superseded にし、新エントリの id を返す。pin の照合は元の前提のまま。出所は recordBehavior の
 *  編集と同じ規則で candidate から継ぐ(`amends`)。 */
export function approveMemoryProposal(db: Db, proposal: MemoryProposal, questionId: string, origin: EventOrigin, at: Date, amendment?: MemoryAmendment): number {
  const mark = { question_id: questionId };
  return db.transaction(() => {
    const { named, replaced } = assertProposalFresh(db, proposal);
    const supersede = (ids: number[], successor_id: number) => {
      for (const id of ids) invalidateMemoryEntry(db, { entry_id: id, reason: "superseded", successor_id }, HUMAN_WORKER_ID, origin, at, mark);
    };
    if (!("candidate_id" in proposal)) {
      // 文言を承認しないので修正値を持たない(ADR 0152 決定2 / ADR 0160)—— 扉の外から呼ばれても黙って捨てず断る
      if (amendment) throw new DomainError("a proposal without a candidate takes no amendment: approve or reject it as proposed");
      if (proposal.op === "invalidate") return invalidateMemoryEntry(db, { entry_id: named.id, reason: proposal.reason }, HUMAN_WORKER_ID, origin, at, mark);
      supersede(replaced, named.id);
      return named.id;
    }
    if (amendment) {
      const { addressee = named.addressee, title = named.title, text, annotations, ...original } = amendment;
      let entry_id: number;
      if (named.kind === "exemplar") {
        // text は注釈の英語 text の連結で、英語の title の原文は持たない(ADR 0153 決定1)—— 黙って捨てず断る
        if (text !== undefined || Object.keys(original).length > 0) throw new DomainError("an exemplar amendment takes title, addressee and annotations: its text is derived from the annotations");
        const fields = { scope: named.scope, path: named.path, title, addressee, author: HUMAN_AUTHOR, annotations: annotations ?? rowToEntry(named).annotations };
        entry_id = recordExemplar(db, fields, origin, at, mark, named).entry_id;
      } else {
        if (annotations !== undefined) throw new DomainError("only an exemplar amendment takes annotations");
        const input = humanEntryInput(db, { workspace: named.scope, path: named.path, title, text: text ?? named.text, ...original });
        entry_id = recordBehavior(db, { ...input, addressee }, origin, at, mark, named).entry_id;
      }
      supersede([named.id, ...replaced], entry_id);
      return entry_id;
    }
    const eventId = appendEvent(db, {
      taskId: null,
      workerId: HUMAN_WORKER_ID,
      origin,
      payload: { kind: "memory_entry_approved", entry_id: named.id, question_id: questionId, replaced: proposal.replaces },
      at,
    });
    markApproved(db, named.id, eventId);
    supersede(replaced, named.id);
    return eventId;
  })();
}

/** 提案の reject(spec #615 F): 同じ pin 検査の後、candidate を持つ approve / consolidate は candidate だけを `rejected` で無効化し
 *  (consolidate の replaces は残る)、invalidate と既存の後継の consolidate は何もしない。必須の comment の門は回答の側(`needsComment`、ADR 0179 決定4)。 */
export function rejectMemoryProposal(db: Db, proposal: MemoryProposal, questionId: string, origin: EventOrigin, at: Date): void {
  const { named } = assertProposalFresh(db, proposal);
  if ("candidate_id" in proposal) invalidateMemoryEntry(db, { entry_id: named.id, reason: "rejected" }, HUMAN_WORKER_ID, origin, at, { question_id: questionId });
}

/** 無効化されていない kinds(省略 = 種別を問わない)のどれかで、state を渡せばその state の entry(提案が名指す entry と、書き込みの supersedes)。 */
function requireLive(db: Db, id: number, kinds: Array<MemoryEntryFields["kind"]> | undefined, state?: MemoryEntryFields["state"]): EntryRow {
  const row = requireEntry(db, id);
  if ((kinds && !kinds.includes(row.kind)) || row.invalidation_reason !== null || (state !== undefined && row.state !== state)) {
    throw new DomainError(`memory entry ${id} is not a non-invalidated ${kinds?.join(" or ") ?? "entry"}${state ? ` in state ${state}` : ""}`);
  }
  return row;
}

/** op ごとの欄。worker MCP の入力は平たい object のまま(判別共用体を top-level に置いた schema を worker harness が
 *  受けるかは確かめていない)なので、必須と越境はここで引く。 */
const PROPOSAL_FIELDS = {
  approve: ["candidate_id"],
  consolidate: ["text", "successor_id", "candidate_id", "replaces", "based_on_decision"],
  invalidate: ["target_id", "reason"],
} as const;

/** 提案 question の detail の Exemplar の本文(issue #954): 注釈と、worker の read_memory と同じ case 描画。 */
function exemplarDetail(db: Db, row: EntryRow): string[] {
  const { annotations, source } = rowToEntry(row);
  const rendered = renderCase(db, source)!;
  return [
    "Annotations:",
    ...annotations!.map(({ anchor, polarity, text }) => `- ${polarity} (${anchor === "whole" ? "whole" : `${anchor.field}: ${JSON.stringify(anchor.quote)}`}): ${text}`),
    "Case:",
    ...("decisions" in rendered
      ? ["Decisions:", ...rendered.decisions.map((decision) => `- ${decision}`)]
      : [`Decision: ${rendered.decision}`, ...rendered.steering.map((steering) => `Steering: ${steering}`)]),
    `Handoff: ${rendered.handoff ?? "(none)"}`,
    `Result: ${rendered.result ?? "(none)"}`,
  ];
}

/** 提案 verb(spec #615 E / issue #620・#621): meta-review の子に提案 question を1件立て、pin を焼いて question の id を返す。
 *  consolidate の新 candidate と question は1 transaction。 */
export function proposeMemoryChange(
  db: Db,
  metaReviewId: string,
  input: {
    op: "approve" | "consolidate" | "invalidate";
    rationale: string;
    /** approve の candidate、または consolidate の後継に名指す既存の candidate(text の代わり、ADR 0174 決定1)。 */
    candidate_id?: number;
    /** kind 省略 = behavior。exemplar は text を持たず注釈を持つ(text は注釈から導く)。 */
    text?: { scope: string | null; path: string; title: string; text?: string; addressee: string | null; kind?: "behavior" | "exemplar"; annotations?: unknown };
    /** 既存の approved の Behavior / Exemplar を後継に名指す(text の代わり、ADR 0160 決定2)。replaces は approved だけ(ADR 0161 決定5)。 */
    successor_id?: number;
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
  // 今の op の欄に無い欄は黙って捨てず断る —— 捨てると meta-review は統合したつもりで承認の question が立つ
  const own: readonly string[] = PROPOSAL_FIELDS[input.op];
  const stray = [...new Set(Object.values(PROPOSAL_FIELDS).flat())].filter((f) => !own.includes(f) && input[f] !== undefined);
  if (stray.length > 0) throw new DomainError(`op ${input.op} does not take ${stray.join(", ")}`);
  return db.transaction(() => {
    const since = memoryWatermark(db);
    let proposal: MemoryProposal;
    let heading: string[];
    let shown: EntryRow;
    if (input.op === "consolidate") {
      const replaced = [...new Set(need(input.replaces, "replaces"))].map((id) => rowToEntry(requireLive(db, id, ["behavior", "exemplar"])));
      if (replaced.length === 0) throw new DomainError("a consolidation needs at least one entry to replace");
      if ([input.text, input.successor_id, input.candidate_id].filter((v) => v !== undefined).length !== 1) {
        throw new DomainError(
          "op consolidate takes exactly one of text (a new candidate), successor_id (an existing approved entry) and candidate_id (an existing candidate)",
        );
      }
      const pins = replaced.map(({ id, version }) => ({ id, version }));
      // scope null への統合で、どの workspace・宛先から広がるかを人間が見られるように置換対象ごとに載せる
      const replacing = replaced.map((row) => `#${row.id} (scope: ${row.scope ?? "whole board"}, addressee: ${row.addressee ?? "every agent"}): ${row.text}`);
      // 新しい entry を書かないので、出所にする推論は要らない
      if (input.text === undefined && input.based_on_decision !== undefined) {
        throw new DomainError("a consolidation into an existing entry writes no entry, so it takes no based_on_decision");
      }
      const existing = input.candidate_id ?? input.successor_id;
      if (pins.some(({ id }) => id === existing)) throw new DomainError(`successor ${existing} cannot be one of the entries it replaces`);
      if (input.candidate_id !== undefined) {
        // 陳腐化・defer で閉じた提案の再提案の形(ADR 0174 決定1)。replaces の門は text の形と同じで、approved 限定は掛けない
        const candidate = requireLive(db, input.candidate_id, ["behavior", "exemplar"], "candidate");
        // Exemplar は出所が case なので、text の形の起草と同じく replaces がその出所を共有する
        if (candidate.kind === "exemplar" && !sharedSource([rowToEntry(candidate), ...replaced])) {
          throw new DomainError(`an exemplar consolidation needs replaces that share candidate ${candidate.id}'s source: the exemplar keeps it as its case`);
        }
        proposal = { kind: "memory", op: "consolidate", candidate_id: candidate.id, replaces: pins };
        shown = candidate;
        heading = [`Consolidate into existing ${candidate.kind} candidate #${candidate.id}, replacing:`, ...replacing];
      } else if (input.successor_id !== undefined) {
        const successor = requireLive(db, input.successor_id, ["behavior", "exemplar"], "approved");
        // candidate を既にある approved へ寄せるのは fold_memory だけ(ADR 0161 決定5)
        const candidate = replaced.find((row) => row.state !== "approved");
        if (candidate) throw new DomainError(`memory entry ${candidate.id} is a candidate: fold it into ${successor.id} with fold_memory's successor_id instead`);
        proposal = { kind: "memory", op: "consolidate", successor: { id: successor.id, version: successor.version! }, replaces: pins };
        shown = successor;
        heading = [`Consolidate into existing ${successor.kind} #${successor.id}, replacing:`, ...replacing];
      } else {
        const decision = requireDecision(db, need(input.based_on_decision, "based_on_decision"), metaReviewId);
        const { kind = "behavior", text, annotations, ...draft } = need(input.text, "text");
        // replaces が1つの出所を共有するなら新 candidate はそれを継ぐ(rule ↔ case の関係を共有 Episode から導ける)。揃わなければ
        // meta-review の推論のまま
        const shared = sharedSource(replaced);
        const author = { activity: "meta_review" as const, name: workerId };
        let created: number;
        if (kind === "exemplar") {
          // text は注釈の英語 text から導く —— 渡されたら黙って捨てず断る
          if (text !== undefined) throw new DomainError("an exemplar's text is derived from its annotations: do not pass text");
          if (!shared) throw new DomainError("an exemplar consolidation needs replaces that share one source: the exemplar keeps it as its case");
          const checked = checkedAnnotations(db, shared, annotations, metaReviewAnnotationSchema);
          created = createEntry(db, { ...draft, ...checked, kind, state: "candidate", original: null, source: shared, author }, "worker", now);
        } else {
          if (annotations !== undefined) throw new DomainError("only an exemplar takes annotations");
          const source = shared ?? { event_id: decision };
          created = createEntry(db, { ...draft, text: need(text, "text.text"), kind, state: "candidate", original: null, source, author }, "worker", now);
        }
        proposal = { kind: "memory", op: "consolidate", candidate_id: created, replaces: pins };
        shown = requireEntry(db, created);
        heading = [`Consolidate into new ${kind} candidate #${created}, replacing:`, ...replacing];
      }
    } else if (input.op === "invalidate") {
      shown = requireLive(db, need(input.target_id, "target_id"), ["behavior", "exemplar"], "approved");
      const reason = need(input.reason, "reason");
      proposal = { kind: "memory", op: "invalidate", target: { id: shown.id, version: shown.version! }, reason, replaces: [] };
      heading = [`Invalidate approved ${shown.kind} #${shown.id} (reason: ${reason}).`];
    } else {
      // 前に置き換えようとした entry が生きていても断らない —— 残すかは meta-review の選択(ADR 0174 決定3)
      shown = requireLive(db, need(input.candidate_id, "candidate_id"), ["behavior", "exemplar"], "candidate");
      proposal = { kind: "memory", op: "approve", candidate_id: shown.id, replaces: [] };
      heading = [`Approve ${shown.kind} candidate #${shown.id} as worded.`];
    }
    // 承認は無効化ではないので陳腐化の hook に掛からない —— pin する entry が別の提案にも pin されていると、片方の承認後に
    // もう片方が人間の reject 待ちで周期を止める(ADR 0120 退けた案)。提案の時点で断る。既存の後継は置き換えられないので数えない
    // —— A→R と B→R は両立する(ADR 0160 決定3)
    for (const id of [...("successor" in proposal ? [] : [shown.id]), ...proposal.replaces.map(({ id }) => id)]) {
      if (openProposalsPinning(db, id, false).length > 0) throw new DomainError(`memory entry ${id} is already in an open proposal question`);
    }
    requireOneTree(db, since);
    const detail = [
      ...heading,
      `Scope: ${shown.scope ?? "whole board"}`,
      `Path: ${shown.path}`,
      `Addressee: ${shown.addressee ?? "every agent"}`,
      `Title: ${shown.title}`,
      ...(shown.kind === "exemplar" ? exemplarDetail(db, shown) : ["candidate_id" in proposal ? "New text:" : "Text:", shown.text]),
      "",
      "While this question is open, the next memory meta-review is not registered; if you cannot decide yet, answer defer with a comment.",
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
        question: [{ title, detail, options: ["approve", "reject", "defer"], recommendation: "approve" }],
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
  annotations: string | null;
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
    ...(row.annotations === null ? {} : { annotations: JSON.parse(row.annotations) as ExemplarAnnotation[] }),
    version: row.version,
  };
}

/** 店を変える memory 系 event の種別。watermark(snapshot 識別子)と再生が同じ列を読む。 */
const STORE_EVENT_KINDS = ["memory_entry_created", "memory_entry_approved", "memory_entry_invalidated"] as const;

/** 店を変える memory 系 events(id 順)。watermark の再生と rebuild が同じ列を読む。 */
const storeEvents = (db: Db, watermark?: number) => listEventsOfKinds(db, STORE_EVENT_KINDS, { upTo: watermark });

/** approved かつ無効化されていないエントリ(id 順)。`watermark`(memory 系 event の id)を
 *  渡すと、その時点までの events を再生して当時の集合を返す —— 表は投影なので、指定が
 *  無ければ表を読む。 */
export function approvedMemoryEntries(db: Db, watermark?: number): MemoryEntry[] {
  if (watermark !== undefined) {
    const entries = new Map<number, MemoryEntry>();
    for (const { id, payload: event } of storeEvents(db, watermark)) {
      if (event.kind === "memory_entry_created") {
        entries.set(id, { ...event.entry, id, source: sourceOf(event.entry, id), version: versionOf(event.entry.state, id, event.version) });
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

/** 無効化の書き手(ADR 0159 決定2): memory_entry_invalidated の印そのまま —— 回答なら question、書き込みなら書き手の activity、
 *  印の無い無効化(settings タブ / 管理MCP の直接の無効化)は event の worker。 */
type InvalidatedBy = { question_id: string } | { activity: MemoryEntryFields["author"]["activity"] } | { worker: string };

/** 人間の面の一覧(spec #586 F): candidate・無効化済みも出す(id 順)。
 *  scope は完全一致(null = 盤面全体、省略 = すべて)、state の invalidated は無効化済み、
 *  approved / candidate は無効化されていないもの。path はその枝と配下 P/…(#1209)。 */
export function listMemoryEntries(
  db: Db,
  filter: { scope?: string | null; kind?: MemoryEntryFields["kind"]; state?: MemoryEntryFields["state"] | "invalidated"; path?: string },
): Array<
  MemoryEntry & {
    invalidation_reason: InvalidationReason | null;
    successor_id: number | null;
    invalidated_by: InvalidatedBy | null;
    restored_as: number | null;
    /** superseded でこの行を後継に指す id(ADR 0162 の畳みの跡)。列は持たず読むときに引く。 */
    replaced_ids: number[];
    cause: Cause | null;
  }
> {
  const { scope, kind, state } = filter;
  const path = filter.path === undefined ? undefined : checkedPath(filter.path);
  // エントリの無効化は高々1度(invalidateMemoryEntry の門)なので entry_id で引ける。印は event が正本で列は持たない
  const invalidatedBy = new Map(
    listEventsOfKinds(db, ["memory_entry_invalidated"]).map(({ worker_id, payload: { entry_id, question_id, activity } }) =>
      [entry_id, question_id ? { question_id } : activity ? { activity } : { worker: worker_id }] as const,
    ),
  );
  const restored = restoredAs(db);
  // cause = 出所 event が帰責(objection_attributed)のときのその cause(spec #615 G)
  const rows = db
    .prepare(
      `SELECT m.*, json_extract(e.payload, '$.cause') AS cause FROM memory_entries m
         LEFT JOIN events e ON m.source_kind = 'event' AND e.id = CAST(m.source_ref AS INTEGER) AND e.kind = 'objection_attributed'
        ORDER BY m.id`,
    )
    .all() as Array<EntryRow & { cause: Cause | null }>;
  // 絞り込みの前に引く —— 置き換えられた行は無効化済みで、approved の絞り込みでは落ちる
  const replacedIds = new Map<number, number[]>();
  for (const row of rows) {
    if (row.invalidation_reason === "superseded") replacedIds.set(row.successor_id!, [...(replacedIds.get(row.successor_id!) ?? []), row.id]);
  }
  return rows
    .filter(
      (row) =>
        (scope === undefined || row.scope === scope) &&
        (kind === undefined || row.kind === kind) &&
        (path === undefined || atOrUnder(row.path, path)) &&
        (state === undefined || (state === "invalidated" ? row.invalidation_reason !== null : row.invalidation_reason === null && row.state === state)),
    )
    .map((row) => ({
      ...rowToEntry(row),
      invalidation_reason: row.invalidation_reason,
      successor_id: row.successor_id,
      invalidated_by: invalidatedBy.get(row.id) ?? null,
      restored_as: restored.get(row.id) ?? null,
      replaced_ids: replacedIds.get(row.id) ?? [],
      cause: row.cause,
    }));
}

/** CJK の連なり = Script_Extensions が Han / Hiragana / Katakana / Hangul で、一般カテゴリが文字・数字・結合文字 M の字
 *  (#1180)。M は tokenizer が直前の字と同じ語に入れるので、連なりも切らない(切ると `한〮abc` の U+302E が索引では `〮abc`
 *  の語頭に付き、query では語を割って自身の text に当たらない、#1205)。
 *  scx だけだと 、。「」・〜 や ㈱ など句読点・記号(P / S)も入って bigram に混ざるので、それらは連なりを切り、
 *  前処理後もそのまま残って unicode61 の区切りになる。捕獲グループは ftsQuery の split が連なりを結果に残すためにある
 *  (外すと CJK の語が query から消える)。 */
const CJK_SCRIPT = String.raw`[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]`;
const RUN_CATEGORY = String.raw`[\p{L}\p{N}\p{M}]`;
const CJK_RUN = new RegExp(String.raw`((?:(?=${RUN_CATEGORY})${CJK_SCRIPT})+)`, "gu");
/** query の語の切れ目 = 空白と、CJK_RUN から外した CJK の句読点・記号(`注入（src/memory.ts）、drift。` の `drift` も
 *  識別子と別の語になる)。CJK_RUN と文字集合を共有するので、片方だけ字種が変わることはない。 */
const QUERY_BREAK = new RegExp(String.raw`(?:\s|(?!${RUN_CATEGORY})${CJK_SCRIPT})+`, "u");

/** 索引と query の共通の正規化(#1189 / #1192)。query は語に割る前に通すので、語の割り方は正規化の後の字で決まる。
 *  まず全角・半角形 U+FF01–FFEE の連なりだけを NFKC で畳む(`ｶﾞｲﾄﾞ` と `ガイド`、`ｔｉｄｅｐｏｏｌ` と `tidepool`、`０１２０`
 *  と `0120` が同じ語になる)。NFKC 全体にしないのは `…` が tokenchars の `...` に開いて `wait…done` が `wait` にも
 *  `done` にも当たらなくなるから。この範囲で tokenchars を含む形になるのは `－` `．` `＿` だけで、ASCII で書いたのと同じ語に
 *  なる。次に NFC(NFD の `カ` + U+3099 と `ガ`、ハングルの字母と音節、互換漢字 U+FA19 と U+795E が同じ語になる)。NFC を
 *  畳みの後に置くのは、孤立した `ﾞ` `ﾟ` が開いた結合文字を前の字と合成させるため(query は語ごとにもう一度通るので、1度で
 *  形が定まらないと `かﾞいど` の leaf が自分の text で当たらない)。揃えるのは FTS に渡す投影だけで、保存する正文・title・
 *  path は書き換えない。 */
function ftsNormalize(value: string): string {
  return value.replace(/[\uFF01-\uFFEE]+/g, (run) => run.normalize("NFKC")).normalize("NFC");
}

/** 索引と query の共通の前処理(spec #586 B / #606 / #608 / #610 / #1180)。まず ftsNormalize で正規化する。次に CJK の
 *  連なりを重なりつきの2文字語に割り(LWC 式)空白で囲む。unicode61 は CJK を語に切らない。1文字の連なりはそのまま。
 *  長音符 ー は Script=Common なので Script_Extensions で拾う(拾わないと「サーバ」が割れて当たらない)。その後で . - _ の
 *  連なりを、連なりの外側の隣が unicode61 の token にならない文字(空白・文字列の端・`)` `"` などの記号)のとき連なりごと
 *  落とす(tokenchars なので文末の `narrow.)` が `narrow` に当たらない。語中は `foo__bar` のような連なりも残す)。
 *  下の正規表現は結合文字 M(Mc / Mn / Me)を token になる隣として扱い、tokenizer も categories で M を直前の字と同じ語に
 *  入れる(`a` + U+030D + `-b` も `कि.foo` も1語、#1200 / #1205)ので、M について両者は同じ集合を見る。正規表現が token と
 *  みなすのに tokenizer が語を切る字は無い(Node 22 / SQLite 3.53.2 で全コードポイントを実測)。
 *  bigram が先なので、CJK に接した `東京.csv` の `.` も隣が空白になって落ちる。 */
function ftsText(value: string): string {
  return ftsNormalize(value)
    .replace(CJK_RUN, (run) => {
      const chars = [...run];
      const grams = chars.length === 1 ? chars : chars.slice(1).map((char, i) => chars[i] + char);
      return ` ${grams.join(" ")} `;
    })
    .replace(/(?<![\p{L}\p{N}\p{M}\p{Co}._-])[._-]+|[._-]+(?![\p{L}\p{N}\p{M}\p{Co}._-])/gu, "");
}

/** pull の読み手: 帰属 task、そのスコープ(workspace 名 / null = 盤面全体)、agent 名(宛先)。 */
interface MemoryReader {
  taskId: string;
  scope: string | null;
  agent: string;
}

/** search の候補が返らなかった理由(spec #586 D)。関連度の閾値は持たない(ADR 0083
 *  決定9)ので「関連度で切った」は FTS だけでは起きず、型にも置かない。スコープ外と
 *  candidate は候補になる前の SQL の絞り込み。`response_budget` は見えるが、この応答には予算で入らず、続きに回った候補(ADR 0195)。 */
export type MemoryDropReason = "addressee" | "invalidated" | "response_budget";

/** snapshot 識別子 = 店を変える memory 系 event の最大 id(approvedMemoryEntries が再生する種別)。 */
function memoryWatermark(db: Db): number {
  return (
    db
      .prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE kind IN (${STORE_EVENT_KINDS.map(() => "?").join(", ")})`)
      .get(...STORE_EVENT_KINDS) as { id: number }
  ).id;
}

/** 詰める間の event id の仮の値(ADR 0195): id は記録してからでないと分からず、記録する id は詰めてからでないと分からない。
 *  どの event id より桁が多いので、記録の後に recordPull が本物へ差し替えても応答は縮むだけで予算を超えない。 */
const PENDING_EVENT_ID = { event_id: Number.MAX_SAFE_INTEGER };

/** pull 1回 = memory_pulled 1つ(task 帰属)。event id を結果に載せ、投影器がそれを
 *  memory マーカーに結ぶ。続き(next)の呼び出しも1回の pull で、その応答で返した id だけを記録する(ADR 0195)。 */
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
 *  読ませない)。語は空白と CJK の句読点・記号(、。「」 など)と、CJK の連なりとそれ以外の境目で割る(`src/memory.tsの注入`
 *  の識別子も独立の語、#1178 / #1180)。CJK の連なりは bigram の1 phrase のまま(隣接を保ち、`東京都` は「京都と東京」に
 *  当たらない)。語に割る前に query 全体を ftsNormalize にかける(割った後だと、NFD の `Việt` が CJK の連なりに入る U+0323
 *  で先に割れて NFC の leaf に当たらない、#1189)。語は既定で AND、注入は OR で繋ぐ。残る語が無ければ null。 */
function ftsQuery(query: string, join: " " | " OR " = " "): string | null {
  const terms = ftsNormalize(query)
    .split(QUERY_BREAK)
    .flatMap((word) => word.split(CJK_RUN))
    .map((word) => ftsText(word).trim())
    // 語の端の記号を除いて見る(`it,` も FTS には `it` として届く。記号だけの語は消える)
    .filter((term) => {
      const word = term.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
      return word !== "" && !STOPWORDS.has(word);
    });
  return terms.length === 0 ? null : terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(join);
}

/** FTS に当たったスコープ内の approved(順位順)。Definition は当てない —— worker に届くのは INDEX だけで、
 *  search の候補にも注入の関連 leaf にもならない(ADR 0083 追記7)。宛先と無効化はここで落とさない —— search は
 *  それを候補の落ちた理由として残す。 */
function rankedEntries(db: Db, match: string, scope: string | null): EntryRow[] {
  return db
    .prepare(
      `SELECT e.* FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.rowid
        WHERE memory_fts MATCH ? AND e.state = 'approved' AND e.kind != 'definition' AND (e.scope IS NULL OR e.scope = ?)
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
  input: { query?: string; next?: string },
  at: Date,
): Packed<{ results: Array<{ id: number; title: string; path: string }>; event_id: number }> {
  const read = readPosition("search_memory", input);
  if (read.args.query === undefined) throw new DomainError("pass query, or next from a previous search_memory");
  const match = ftsQuery(read.args.query);
  if (match === null) throw new DomainError("query has no searchable terms: it is empty or only stopwords");
  return db.transaction(() => {
    const hits = rankedEntries(db, match, reader.scope);
    const visible = hits.filter((row) => dropReason(row, reader) === null).map(({ id, title, path }) => ({ id, title, path }));
    const packed = packItems(read, "results", visible, {}, { every: PENDING_EVENT_ID }) as ReturnType<typeof searchMemory>;
    const returned = new Set(packed.results.map((r) => r.id));
    // 前の応答で返した候補は外す —— それらは前の応答の pull に dropped: null で残っている
    const earlier = new Set(visible.slice(0, Math.max(0, visible.findIndex((r) => r.id === read.at))).map((r) => r.id));
    const candidates = hits.filter((row) => !earlier.has(row.id)).map((row) => ({
      id: row.id,
      dropped: dropReason(row, reader) ?? (returned.has(row.id) ? null : ("response_budget" as const)),
    }));
    return recordPull(db, reader, { verb: "search_memory", input: read.args, returned_ids: [...returned], candidates }, packed, at);
  })();
}

/** meta-review の scope を通した検索(ADR 0180 決定3): 全 scope・全宛先の Knowledge / Behavior / Exemplar を語の OR で引き、
 *  FTS の順位 → id の順にポインタで返す。 */
export function searchMemoryEntries(db: Db, reader: Pick<MemoryReader, "taskId" | "agent">, input: { query?: string; like?: number; next?: string }, at: Date) {
  const read = readPosition("search_memory_entries", input);
  const args = read.args;
  if ((args.query === undefined) === (args.like === undefined)) throw new DomainError("search_memory_entries takes exactly one of query and like, or next alone");
  return db.transaction(() => {
    const restored = restoredAs(db);
    // like の行と本文が同じ鎖(両向き)は末尾が一致する
    const tailOf = (row: EntryRow) => sameBodyChain(db, row, restored).at(-1)!.id;
    const like = args.like === undefined ? undefined : requireEntry(db, args.like);
    const match = ftsQuery(like ? `${like.title}\n${like.text}` : args.query!, " OR ");
    if (match === null) throw new DomainError("query has no searchable terms: it is empty or only stopwords");
    const likeTail = like && tailOf(like);
    const hits = (db
      .prepare(
        `SELECT e.* FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.rowid
          WHERE memory_fts MATCH ? AND e.kind != 'definition' AND (e.invalidation_reason IS NULL OR e.successor_id IS NULL)
          ORDER BY memory_fts.rank, e.id`,
      )
      .all(match) as EntryRow[]).filter((row) => likeTail === undefined || tailOf(row) !== likeTail);
    const results = hits.map(({ id, kind, state, scope, path, title, addressee, invalidation_reason }) => ({ id, kind, state, scope, path, title, addressee, invalidation_reason }));
    const packed = packItems(read, "results", results, {}, { every: PENDING_EVENT_ID }) as Packed<{ results: typeof results; event_id: number }>;
    return recordPull(db, reader, { verb: "search_memory_entries", input: args, returned_ids: packed.results.map((r) => r.id) }, packed, at);
  })();
}

function dropReason(row: EntryRow, reader: Pick<MemoryReader, "agent">): MemoryDropReason | null {
  if (row.invalidation_reason !== null) return "invalidated";
  if (row.addressee !== null && row.addressee !== reader.agent) return "addressee";
  return null;
}

/** INDEX(browse と注入)のフィルタ(spec #586 B): approved、未無効化、スコープ(task の
 *  workspace or 盤面全体)、宛先(agent 名一致 or 全員)。search は rankedEntries と dropReason に、read は inSight に同じ条件を持つ ——
 *  ただし search は Definition を当てない(ADR 0083 追記7)。 */
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

/** 無効化を問わない visibleEntries の門(ADR 0167 決定3): approved、スコープ、宛先。read が求めた id・たどる鎖・落とした行の
 *  後継を同じ門で見る。 */
function inSight(row: EntryRow, reader: Omit<MemoryReader, "taskId">): boolean {
  return row.state === "approved" && (row.scope === null || row.scope === reader.scope) && (row.addressee === null || row.addressee === reader.agent);
}

/** INDEX の枝: prefix の path と、その path に置かれた定義(読み手に見えるのは高々1つ —— 門が盤面全体のエントリの path に
 *  workspace の定義を置かせない、ADR 0178)。null = 未定義。 */
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
    ...[...new Set(below.map((e) => e.path.split("/").slice(0, depth).join("/")))]
      .sort()
      .map((name) => ({ name, definition: entries.find((e) => e.kind === "definition" && e.path === name) ?? null })),
    ...entries.filter((e) => e.path === prefix && e.kind !== "definition"),
  ];
}

const isBranch = (child: IndexBranch | EntryRow): child is IndexBranch => "name" in child;

export function browseMemory(
  db: Db,
  reader: MemoryReader,
  input: { prefix?: string; next?: string },
  at: Date,
): Packed<{ children: Array<{ name: string; definition: string | null }>; entries: Array<{ id: number; title: string }>; event_id: number }> {
  const read = readPosition("browse_memory", input);
  const prefix = read.args.prefix ? checkedPath(read.args.prefix) : "";
  return db.transaction(() => {
    // 枝の後に leaf の順で1列に詰め、枝は children・leaf は entries に置く。枝の境目の鍵は名前(path)、leaf は id
    const children = indexChildren(visibleEntries(db, reader), prefix).map((child) =>
      isBranch(child) ? { name: child.name, definition: child.definition?.text ?? null } : { id: child.id, title: child.title },
    );
    const packed = packItems(read, ["children", "entries"], children, {}, {
      keyOf: (child) => child.id ?? child.name!,
      listOf: (child) => ("name" in child ? "children" : "entries"),
      every: PENDING_EVENT_ID,
    }) as ReturnType<typeof browseMemory>;
    return recordPull(db, reader, { verb: "browse_memory", input: read.args, returned_ids: packed.entries.map((e) => e.id) }, packed, at);
  })();
}

/** 枝の一覧(ADR 0122 追記 #1209): approved・未無効化のエントリ(4種別・全 scope・宛先を問わない)の path とすべての上位の prefix を
 *  1枝1行、木の順(親の直後に配下、同じ階層は segment の名前順)で。行はその path の Definition と、その path か配下にエントリ
 *  (Definition も)を持つ scope(null = 盤面全体)。件数・未定義の印・leaf は載せない。人間の面はこのまま、meta-review は
 *  pullMemoryBranches が原文を落とす。 */
export function listMemoryBranches(db: Db) {
  const entries = approvedMemoryEntries(db);
  const paths = new Set(entries.flatMap((e) => e.path.split("/").map((_, i, segments) => segments.slice(0, i + 1).join("/"))));
  const bySegments = (a: string, b: string) => {
    const [x, y] = [a.split("/"), b.split("/")];
    const i = x.findIndex((segment, j) => segment !== y[j]);
    return i === -1 ? x.length - y.length : y[i] === undefined || x[i]! > y[i]! ? 1 : -1;
  };
  return [...paths].sort(bySegments).map((path) => ({
    path,
    definitions: entries.filter((e) => e.kind === "definition" && e.path === path).map(({ id, scope, text, original }) => ({ id, scope, text, original })),
    scopes: [...new Set(entries.filter((e) => atOrUnder(e.path, path)).map((e) => e.scope))],
  }));
}

const withoutOriginal = <T extends { original?: unknown }>({ original: _, ...rest }: T) => rest;

/** meta-review の枝の一覧: 木の順に応答予算と続き(next)で返す(ADR 0195、境目の鍵は path)。返した id はその応答の行の Definition の id。
 *  Definition の原文は人間の面にだけ残す(一覧と同じ線、#1052)。 */
export function pullMemoryBranches(db: Db, reader: Pick<MemoryReader, "taskId" | "agent">, input: { next?: string }, at: Date) {
  const read = readPosition("list_memory_branches", input);
  return db.transaction(() => {
    const rows = metaReviewBranches(db);
    const packed = packItems(read, "branches", rows, {}, { keyOf: (row) => row.path, every: PENDING_EVENT_ID }) as Packed<{ branches: typeof rows; event_id: number }>;
    const returned_ids = packed.branches.flatMap((row) => row.definitions.map((d) => d.id));
    return recordPull(db, reader, { verb: "list_memory_branches", input: read.args, returned_ids }, packed, at);
  })();
}

const metaReviewBranches = (db: Db) => listMemoryBranches(db).map((row) => ({ ...row, definitions: row.definitions.map(withoutOriginal) }));

type ListedEntry = ReturnType<typeof listMemoryEntries>[number];

/** meta-review の読み口の行: エントリの原文と Exemplar の注釈の原文は人間の面と正本にだけ残す(#1052 / ADR 0122 追記 #1225)。 */
function metaReviewRow<T extends ListedEntry>(entry: T) {
  const { annotations, ...rest } = withoutOriginal(entry);
  return { ...rest, annotations: annotations?.map(withoutOriginal) };
}

type MemoryListInput = Parameters<typeof listMemoryEntries>[1] & { include_invalidated?: boolean };

/** meta-review の一覧2つ(issue #619): 人間の面と同じ一覧を verb ごとに絞り、応答予算と続き(next)で返す(ADR 0195)。scope・宛先では
 *  絞らない(両方を見る必要があるのは workspace を跨いで構造を見る人間と meta-review だけ —— ADR 0178 決定8)。 */
export function pullMemoryList(
  db: Db,
  reader: Pick<MemoryReader, "taskId" | "agent">,
  verb: "list_memory_candidates" | "list_memory_entries",
  input: MemoryListInput & { next?: string },
  at: Date,
) {
  const read = readPosition<MemoryListInput>(verb, input);
  return db.transaction(() => {
    const rows = memoryListRows(db, verb, read.args);
    const packed = packItems(read, "entries", rows, {}, { every: PENDING_EVENT_ID }) as Packed<{ entries: typeof rows; event_id: number }>;
    return recordPull(db, reader, { verb, input: read.args, returned_ids: packed.entries.map((e) => e.id) }, packed, at);
  })();
}

/** 一覧2つの行(meta-review の行の形)。pull と材料の節の candidate の部分が共有する。 */
function memoryListRows(db: Db, verb: Parameters<typeof pullMemoryList>[2], input: MemoryListInput) {
  // 過去の提案の読み物(ADR 0152 決定2): 後継の文言を載せる —— 人間名義の後継なら修正つきで承認された candidate
  // (か、修正つきの統合に置き換えられた candidate)
  const withSuccessor = (e: ListedEntry, all: ListedEntry[]) => {
    const next = e.successor_id === null ? undefined : all.find((s) => s.id === e.successor_id);
    return next ? { ...e, successor: { title: next.title, text: next.text, addressee: next.addressee, author: next.author } } : e;
  };
  const entries =
    verb === "list_memory_entries"
      ? listMemoryEntries(db, input)
      : ((all) =>
          all
            .filter((e) => e.state === "candidate" && (input.kind === undefined || e.kind === input.kind) && (input.include_invalidated || e.invalidation_reason === null))
            .map((e) => withSuccessor(e, all)))(listMemoryEntries(db, {}));
  return entries.map(metaReviewRow);
}

/** list_memory_proposals(ADR 0159 決定1): 過去の memory 提案 —— 提案、回答(question_answered の答え・修正値・コメント)、
 *  陳腐化の決着(memory_proposal_stale)。`listRoutingProposals` と同じく提案の表は持たず question と event から組み、全期間を
 *  応答予算と続き(next)で pull に載せる(境目の鍵は提案の question id)。invalidate の提案の reject は記憶の側に跡を残さないので、ここだけが読み口になる。
 *  返した id は各提案が名指す entry(candidate か invalidate の target か既存の後継)。 */
export function pullMemoryProposals(db: Db, reader: Pick<MemoryReader, "taskId" | "agent">, input: { next?: string }, at: Date) {
  const read = readPosition("list_memory_proposals", input);
  return db.transaction(() => {
    const rows = memoryProposalRows(db);
    const packed = packItems(read, "proposals", rows, {}, { keyOf: (row) => row.question_id, every: PENDING_EVENT_ID }) as Packed<{ proposals: typeof rows; event_id: number }>;
    return recordPull(db, reader, { verb: "list_memory_proposals", input: read.args, returned_ids: proposalEntryIds(packed.proposals) }, packed, at);
  })();
}

/** list_memory_proposals の行が名指すエントリ(candidate か invalidate の target か既存の後継)。pull と材料の節の記録が同じ id を数える。 */
const proposalEntryIds = (rows: ReturnType<typeof memoryProposalRows>) => [
  ...new Set(rows.map(({ proposal }) => (proposal.op === "invalidate" ? proposal.target.id : "successor" in proposal ? proposal.successor.id : proposal.candidate_id))),
];

/** list_memory_proposals の行。window を渡すと、回答か陳腐化の event がその窓 `(after, upTo]` にある提案だけ
 *  (材料の節の決着した提案、ADR 0180 決定2)。 */
function memoryProposalRows(db: Db, window?: MetaReviewWindow) {
  const rows = db
    .prepare(
      `SELECT t.id, t.question_proposal,
         (SELECT payload FROM events WHERE task_id = t.id AND kind = 'question_answered') AS answered,
         (SELECT payload FROM events WHERE task_id = t.id AND kind = 'memory_proposal_stale') AS stale,
         (SELECT MAX(id) FROM events WHERE task_id = t.id AND kind IN ('question_answered', 'memory_proposal_stale')) AS settled_id
       FROM tasks t WHERE json_extract(t.question_proposal, '$.kind') = 'memory' ORDER BY t.rowid`,
    )
    .all() as Array<{ id: string; question_proposal: string; answered: string | null; stale: string | null; settled_id: number | null }>;
  return rows
    .filter(({ settled_id }) => !window || inWindow(settled_id, window))
    .map((row) => {
      const answered = row.answered === null ? null : (JSON.parse(row.answered) as Extract<EventPayload, { kind: "question_answered" }>);
      const stale = row.stale === null ? null : (JSON.parse(row.stale) as Extract<EventPayload, { kind: "memory_proposal_stale" }>);
      return {
        question_id: row.id,
        proposal: JSON.parse(row.question_proposal) as MemoryProposal,
        answer: answered?.answers[0]?.answer ?? null,
        // 人間の原文(original_* と注釈の original)は人間の面と正本の event にだけ残す —— 一覧2 verb と同じ側(#1173 / ADR 0122 追記 #1225)
        amendment: answered?.amendment
          ? (({ original_title: _t, original_text: _x, annotations, ...rest }) => ({ ...rest, annotations: annotations?.map(withoutOriginal) }))(answered.amendment as MemoryAmendment)
          : null,
        comment: answered?.comment ?? null,
        observed: stale && { entry_id: stale.entry_id, observed_event_id: stale.observed_event_id },
      };
    });
}

/** meta-review の Precedent の読み口(issue #619): 異議つき decision マーカーを cause・outcome と、その decision より前に
 *  読んだ / 見た記憶つきで返す。既定の `since_watermark` は読み手と同主題の前回の meta-review 登録の
 *  watermark で、異議の event がそれより後の decision だけを返す —— 古い decision への新しい異議も材料である。 */
export function listPrecedents(
  db: Db,
  reader: Pick<MemoryReader, "taskId" | "agent">,
  input: { since_watermark?: number; next?: string },
  at: Date,
) {
  const read = readPosition("list_precedents", input);
  return db.transaction(() => {
    const since = read.args.since_watermark ?? previousMetaReviewWatermark(db, reader.taskId);
    const rows = precedentRows(db, { after: since });
    // 境目の鍵は decision の event id(異議つき decision マーカー1つに1行)
    const packed = packItems(read, "precedents", rows, {}, { keyOf: (p) => p.decision_event_id, every: PENDING_EVENT_ID }) as Packed<{ precedents: typeof rows; event_id: number }>;
    return recordPull(db, reader, { verb: "list_precedents", input: read.args, returned_ids: precedentEntryIds(packed.precedents) }, packed, at);
  })();
}

/** list_precedents の行の decision より前に読んだ / 見た記憶。pull と材料の節の記録が同じ id を数える。 */
const precedentEntryIds = (rows: ReturnType<typeof precedentRows>) => [...new Set(rows.flatMap((p) => [...(p.entries_read ?? []), ...(p.entries_seen ?? [])]))];

/** list_precedents の行: 異議の event が窓 `(after, upTo]` にある decision。verb は上限を持たず、材料の節は
 *  読み手の登録の watermark を上限にする(ADR 0180 決定2)。 */
function precedentRows(db: Db, { after, upTo = Number.MAX_SAFE_INTEGER }: MetaReviewWindow) {
  const objectedIn = db.prepare(
    `SELECT 1 FROM events WHERE kind IN ('objection_raised', 'objection_attributed') AND json_extract(payload, '$.entry_id') = ? AND id > ? AND id <= ?`,
  );
  return listEpisodes(db, {}).flatMap((episode) => {
    const objected = episode.markers.filter((m) => m.kind === "decision" && objectedIn.get(m.eventId, after, upTo) !== undefined);
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
      entries: m.entries,
      completed: episode.completed,
      pr_merged: episode.prMerged,
      entries_read: entriesReadBefore(episode, events, m.eventId!),
      entries_seen: entriesSeenBefore(episode, events, m.eventId!),
    }));
  });
}

/** 出所の種別(ADR 0083 追記3): commit / event の参照は事実、decision の参照は推論。 */
const SOURCE_KIND = { commit: "fact", event: "fact", decision: "inference" } as const;

/** case 描画(ADR 0153 決定3): 出所の decision なら本文・steering(event 順。帰責が出所ならその帰責の異議だけ、
 *  decision を直接指すなら entry への全異議)・
 *  Episode の handoff と result、出所の session なら decision 列・handoff・result。transcript は含まない。 */
type MemoryCase =
  | { decision: string; steering: string[]; handoff: string | null; result: string | null }
  | { decisions: string[]; handoff: string | null; result: string | null };

/** 出所から case を描く。帰責 event は異議された entry へ辿る。事例に辿れない出所(commit、自身の作成
 *  event など)は null。decision 種別の出所は書き手(meta-review)自身の推論で事例ではないので null —— RCA / Board call の
 *  起草の出所は帰責 event(issue #954)。handoff / result / decision 列は Episode の投影表でなく、anchor を含む session の窓
 *  (`sessionWindow`)の events から読む —— Harness にも投影の有無にも依らない(issue #960)。 */
function renderCase(db: Db, source: MemorySource): MemoryCase | null {
  return renderCaseWithLineIds(db, source)?.rendered ?? null;
}

/** renderCase に、steering か decisions の各行の event id(`decision_logged` か `objection_raised`)を同じ順で添える。 */
function renderCaseWithLineIds(db: Db, source: MemorySource): { rendered: MemoryCase; lineIds: number[] } | null {
  if (source.kind !== "event") return null;
  const event = getEvent(db, source.ref);
  if (event?.payload.kind === "worker_spawned") {
    const session = caseSession(db, event);
    const decisions = session.events.filter(isDecisionLogEntry).filter((e) => e.kind === "decision_logged");
    return {
      rendered: { decisions: decisions.map(objectedEntryText), handoff: session.handoff, result: session.result },
      lineIds: decisions.map((e) => e.id),
    };
  }
  const entryId = event?.payload.kind === "objection_attributed" ? event.payload.entry_id : source.ref;
  const entry = getEvent(db, entryId);
  if (!isDecisionLogEntry(entry)) return null;
  // 帰責が出所なら、その帰責が入力に使った steering だけ(AttributionInput.steering と同じ列、#958)
  const steering =
    event?.payload.kind === "objection_attributed"
      ? objectionsById(db, entryId, event.payload.objection_event_ids)
      : entryObjections(db, [entryId]);
  const { handoff, result } = caseSession(db, entry);
  return { rendered: { decision: objectedEntryText(entry), steering: steering.map((s) => s.comment), handoff, result }, lineIds: steering.map((s) => s.id) };
}

/** anchor を含む worker session の events(id 順)と、その窓の完了の handoff / result。anchor が
 *  `worker_spawned` ならその session、そうでなければ anchor より前で最後に開いた同じ task の session ——
 *  窓の外(session 無しに書かれた entry)なら空。 */
function caseSession(db: Db, anchor: EventRow): { events: EventRow[]; handoff: string | null; result: string | null } {
  const empty = { events: [], handoff: null, result: null };
  if (anchor.task_id === null) return empty;
  const events = listEvents(db, anchor.task_id);
  const spawned = sessionSpawnOf(events, anchor);
  if (!spawned) return empty;
  const { inSession } = sessionWindow(events, spawned);
  const inWindow = events.filter(inSession);
  const payload = inWindow.find((e) => e.kind === "task_completed")?.payload;
  const completed = payload?.kind === "task_completed" ? payload : null;
  return {
    events: inWindow,
    handoff: completed?.handoff_present ? (getTask(db, anchor.task_id)?.handoff_doc ?? null) : null,
    result: completed?.result ?? null,
  };
}

/** id で本文を読む(ADR 0167)。無効化済みの id は本文が同じ後継(`path_moved` の鎖・復元の複製)を見える行の内側でたどり、
 *  末尾の本文に requested_id(求めた旧 id)を添える —— 同じ行は1件で、自身を求めた id が勝つ。末尾が無効化済みなら本文は返さず
 *  dropped に末尾の理由と、見える後継を載せる。見えない id(スコープ・宛先・candidate・存在しない)は黙って落とす。case は
 *  Behavior と Exemplar が、annotations は Exemplar が持つ。 */
export function readMemory(
  db: Db,
  reader: MemoryReader,
  input: { ids?: number[]; next?: string },
  at: Date,
): Packed<
  {
    entries: Array<{
      id: number;
      requested_id?: number;
      title: string;
      path: string;
      text: string;
      source: MemorySource;
      source_kind: "fact" | "inference";
      case: MemoryCase | null;
      annotations?: Array<Omit<ExemplarAnnotation, "original">>;
    }>;
    event_id: number;
  },
  { dropped: Array<{ id: number; reason: InvalidationReason; successor: number | null }> }
> {
  const read = readPosition("read_memory", input);
  const ids = read.args.ids;
  if (!ids?.length) throw new DomainError("pass ids, or next from a previous read_memory");
  return db.transaction(() => {
    const restored = restoredAs(db);
    const found = new Map<number, { row: EntryRow; requested_id?: number }>();
    const dropped: Array<{ id: number; reason: InvalidationReason; successor: number | null }> = [];
    for (const id of new Set(ids)) {
      const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as EntryRow | undefined;
      if (!row || !inSight(row, reader)) continue;
      const chain = sameBodyChain(db, row, restored);
      const cut = chain.findIndex((link) => !inSight(link, reader));
      const tail = (cut === -1 ? chain : chain.slice(0, cut)).at(-1)!;
      if (tail.invalidation_reason === null) {
        if (tail.id === id) found.set(id, { row: tail });
        else if (!found.has(tail.id)) found.set(tail.id, { row: tail, requested_id: id });
        continue;
      }
      const successor = tail.successor_id === null ? undefined : requireEntry(db, tail.successor_id);
      dropped.push({ id, reason: tail.invalidation_reason, successor: successor && inSight(successor, reader) ? successor.id : null });
    }
    const entries = [...found.values()]
      .sort((a, b) => a.row.id - b.row.id)
      .map(({ row, requested_id }) => {
        const { id, kind, title, path, text, source, annotations } = rowToEntry(row);
        return {
          id,
          requested_id,
          title,
          path,
          text,
          source,
          source_kind: SOURCE_KIND[source.kind],
          case: kind === "behavior" || kind === "exemplar" ? renderCase(db, source) : null,
          // 原文は人間の面のもの —— worker には英語の正文だけ(ADR 0015)
          annotations: annotations?.map(withoutOriginal),
        };
      });
    const packed = packItems(read, "entries", entries, { dropped }, { every: PENDING_EVENT_ID }) as ReturnType<typeof readMemory>;
    return recordPull(
      db,
      reader,
      { verb: "read_memory", input: read.args, returned_ids: packed.entries.map((e) => e.id), dropped: packed.dropped ?? [] },
      packed,
      at,
    );
  })();
}

/** meta-review の id 読み(ADR 0122 追記 #1225): 一覧と同じ行(全 scope・全宛先・全状態)に readMemory と同じ case を足す。
 *  本文が同じ鎖は視界で切らず末尾までたどって requested_id を添え(末尾が無効化済みでも返す)、それ以外の無効化は行そのものを
 *  返す。同じ行は1件で自身を求めた id が勝つ(readMemory と同じ)。存在しない id は missing。 */
export function readMemoryEntries(db: Db, reader: Pick<MemoryReader, "taskId" | "agent">, input: { ids?: number[]; next?: string }, at: Date) {
  const read = readPosition("read_memory_entries", input);
  const ids = read.args.ids;
  if (!ids?.length) throw new DomainError("pass ids, or next from a previous read_memory_entries");
  return db.transaction(() => {
    const restored = restoredAs(db);
    const found = new Map<number, number | undefined>();
    const missing: number[] = [];
    for (const id of new Set(ids)) {
      const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as EntryRow | undefined;
      if (!row) {
        missing.push(id);
        continue;
      }
      const tail = sameBodyChain(db, row, restored).at(-1)!;
      if (tail.id === id) found.set(id, undefined);
      else if (!found.has(tail.id)) found.set(tail.id, id);
    }
    // ponytail: 一覧を全件材料化して id で引く —— コストは #1056
    const listed = new Map(listMemoryEntries(db, {}).map((e) => [e.id, e]));
    const entries = [...found]
      .sort(([a], [b]) => a - b)
      .map(([id, requested_id]) => {
        const entry = listed.get(id)!;
        return { ...metaReviewRow(entry), requested_id, case: entry.kind === "behavior" || entry.kind === "exemplar" ? renderCase(db, entry.source) : null };
      });
    const packed = packItems(read, "entries", entries, { missing }, { every: PENDING_EVENT_ID }) as Packed<{ entries: typeof entries; event_id: number }, { missing: number[] }>;
    return recordPull(db, reader, { verb: "read_memory_entries", input: read.args, returned_ids: packed.entries.map((e) => e.id) }, packed, at);
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

/** 関連 leaf を何で引くか(ADR 0175 決定5)。無ければ訳す対象外で、task の原語で引く。 */
export type InjectionQuery = NonNullable<Extract<EventPayload, { kind: "memory_injected" }>["query"]>;

/** task の title / purpose / 完了基準を1つの文面に(ADR 0175 決定2): 翻訳の元と、原語で引く query の両方。
 *  同じ文面なので翻訳の cache の鍵が揃う。 */
export function injectionQueryText(task: Pick<Task, "title" | "purpose" | "completion_criteria">): string {
  return `${task.title}\n${task.purpose}\n${task.completion_criteria}`;
}

type MemoryInjection = {
  query?: InjectionQuery;
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
 *  組む。関連度の query は渡された英語の view(ADR 0175)、無ければ task の title + purpose + completion criteria
 *  の語の OR で、順位は search と同じ FTS の rank。削り順は固定 —— 関連 leaf を順位の下から1件ずつ → INDEX を深い階層から1段ずつ。
 *  最上位 INDEX はそれだけで上限を超えても残す(枝が無いと pull で降りられない)。meta-review(どの主題も)には組まない ——
 *  節は scope を task から解決し、案内する pull verb はその接続に無い(ADR 0122 決定2)。 */
export function buildMemoryInjection(
  db: Db,
  task: Pick<Task, "id" | "title" | "purpose" | "completion_criteria">,
  scope: string | null,
  agent: string,
  query?: InjectionQuery,
): MemoryInjection {
  return db.transaction(() => {
    const watermark = memoryWatermark(db);
    const visible = metaReviewSubjectOf(db, task.id) !== null ? [] : visibleEntries(db, { scope, agent });
    if (visible.length === 0) return { query, section: null, watermark, entries: [], tokens: 0, index_depth: 0, index_max_depth: 0, omitted: 0 };
    const tree = (prefix: string, depth: number): Array<IndexBranch & { depth: number }> =>
      indexChildren(visible, prefix)
        .filter(isBranch)
        .flatMap((branch) => [{ ...branch, depth }, ...tree(branch.name, depth + 1)]);
    const branches = tree("", 1);
    const maxDepth = Math.max(...branches.map((b) => b.depth));
    // 語が残らなければ(空 / stopword だけ)関連 leaf は無い。spawn は落とさない
    const match = ftsQuery(query && "view" in query ? query.view : injectionQueryText(task), " OR ");
    const relevant =
      match === null
        ? []
        : rankedEntries(db, match, scope).filter((row) => dropReason(row, { agent }) === null);
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
      query,
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

/** 材料の節の店の変更(ADR 0180 決定1): 窓の中に作成か無効化の材料の event(meta-review 自身の産物は除く —— due と同じ述語)が
 *  あるエントリを、本文が同じ鎖の末尾の行1つにまとめ、材料になった変更を添える。移動の `path_moved` は本文の変更でないので数えない。
 *  candidate の行は candidate の部分が持つので載せない。 */
function storeChanges(db: Db, window: MetaReviewWindow) {
  const restored = restoredAs(db);
  const changes = new Map<number, Set<"created" | "invalidated">>();
  for (const { id, payload } of materialEvents(db, ["memory_entry_created", "memory_entry_invalidated"], window)) {
    const created = payload.kind === "memory_entry_created";
    if (!created && payload.reason === "path_moved") continue;
    const tail = sameBodyChain(db, requireEntry(db, created ? id : payload.entry_id), restored).at(-1)!;
    changes.set(tail.id, (changes.get(tail.id) ?? new Set()).add(created ? "created" : "invalidated"));
  }
  return listMemoryEntries(db, {})
    .filter((entry) => changes.has(entry.id) && entry.state !== "candidate")
    .map((entry) => ({ ...metaReviewRow(entry), changes: (["created", "invalidated"] as const).filter((c) => changes.get(entry.id)!.has(c)) }));
}

/** meta-review の材料の節(ADR 0180 決定2・追記 #1239、provider 非依存): 読み手の窓 `(前回, 今回]` の材料を、主題ごとの部分に
 *  それぞれの読み口と同じ行で組む。上限は置かない。meta-review でなければ null。 */
export function buildMetaReviewMaterial(db: Db, taskId: string) {
  const subject = metaReviewSubjectOf(db, taskId);
  if (subject === null) return null;
  return db.transaction(() => {
    const window = metaReviewWindow(db, taskId);
    const material = subject === "routing" ? routingMaterial(db, window) : memoryMaterial(db, window);
    return { ...material, previous_watermark: window.after, material_watermark: window.upTo, tokens: countTokens(material.section) };
  })();
}

/** memory の5つの部分: 店の変更・生きている candidate・異議つき判断・決着した提案・枝の一覧。 */
function memoryMaterial(db: Db, window: Required<MetaReviewWindow>) {
  const parts = {
    store_changes: storeChanges(db, window),
    candidates: memoryListRows(db, "list_memory_candidates", {}),
    precedents: precedentRows(db, window),
    proposals: memoryProposalRows(db, window),
    branches: metaReviewBranches(db),
  };
  const section = materialSection("memory", window, [
    [
      "Store changes",
      "Rows of list_memory_entries whose entry was created or invalidated in this window, except by a memory meta-review or by the answer to its " +
        "proposal; changes says which. A moved or restored entry is shown as its latest copy. Candidates are in the next part.",
      parts.store_changes,
      "no store changes",
    ],
    ["Live candidates", "Rows of list_memory_candidates: every candidate not invalidated, whenever it was drafted.", parts.candidates, "no live candidates"],
    ["Objected decisions", "Rows of list_precedents for the objections raised in this window.", parts.precedents, "no objected decisions"],
    ["Settled proposals", "Rows of list_memory_proposals answered or settled as stale in this window.", parts.proposals, "no settled proposals"],
    ["Branches", "Rows of list_memory_branches: the whole tree.", parts.branches, "no branches"],
  ]);
  return { subject: "memory" as const, section, parts };
}

/** 材料の節の記録(task 帰属、memory_injected の直後に両 adapter が書く): 両端の watermark、部分ごとに載せた id、token 量。 */
export function recordMetaReviewMaterial(
  db: Db,
  taskId: string,
  agent: string,
  workerSpawnedEventId: number,
  material: NonNullable<ReturnType<typeof buildMetaReviewMaterial>>,
  at: Date,
): number {
  const { previous_watermark, material_watermark, tokens } = material;
  const common = {
    kind: "meta_review_material_injected",
    worker_spawned_event_id: workerSpawnedEventId,
    previous_watermark,
    material_watermark,
    tokens,
    tokenizer: TOKENIZER.id,
    tokenizer_version: TOKENIZER.version,
  } as const;
  return appendEvent(db, {
    taskId,
    workerId: agent,
    origin: "board",
    payload:
      material.subject === "routing"
        ? {
            ...common,
            subject: "routing",
            shadow: material.parts.shadow.map((row) => row.id),
            shadow_rows: material.parts.shadow_rows,
            shadow_rows_multi_candidate: material.parts.shadow_rows_multi_candidate,
            allocations: material.parts.allocations.counted,
            cells: material.parts.cells.map((c) => c.first_observed_event_id),
            rows: material.parts.rows.map((r) => r.event_id),
            proposals: material.parts.proposals.map((p) => p.question_id),
          }
        : {
            ...common,
            subject: "memory",
            store_changes: material.parts.store_changes.map((e) => e.id),
            candidates: material.parts.candidates.map((e) => e.id),
            precedents: material.parts.precedents.map((p) => p.decision_event_id),
            precedent_entries: precedentEntryIds(material.parts.precedents),
            proposals: material.parts.proposals.map((p) => p.question_id),
            proposal_entries: proposalEntryIds(material.parts.proposals),
            branches: material.parts.branches.flatMap((b) => b.definitions.map((d) => d.id)),
          },
    at,
  });
}

/** 注入上限の既定(spec #586 C)。上限は ADR 0083 決定10 が置いた唯一のノブ。 */
const DEFAULT_INJECTION_TOKEN_CAP = 2000;

export const memorySettingsChangeSchema = z.object({ injection_token_cap: z.number().superRefine((value, ctx) => {
  const reason = whyNotPositiveInteger(value);
  if (reason) ctx.addIssue({ code: "custom", message: reason });
}) });
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
    for (const { id, payload: event } of storeEvents(db)) {
      if (event.kind === "memory_entry_created") insertEntry(db, id, event.entry, event.version);
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
