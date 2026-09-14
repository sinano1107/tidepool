import type { Cause } from "./cause.js";
import { type Db, MEMORY_FTS_DDL, MEMORY_FTS_TOKENIZER, MEMORY_PREPROCESS_VERSION } from "./db.js";
import { appendEvent, type EventOrigin, type EventPayload, getEvent } from "./events.js";
import { BOARD_WORKER_ID, DomainError } from "./tasks.js";

/** 無効化の理由コード(spec #586 A)。自由記述は持たない。置換と path の付け替えは後継 id
 *  必須、残りの3つは cause.ts の語彙そのもの(間違っていた / 陳腐化)。 */
export type InvalidationReason = "superseded" | "path_moved" | Extract<Cause, "capability" | "environment" | "requirement_change">;
const INVALIDATION_REASONS: readonly InvalidationReason[] = ["superseded", "path_moved", "capability", "environment", "requirement_change"];

/** 出所(spec #586 A)。種別は参照の型から導く: commit / event = 事実、decision
 *  (decision_logged の event id)= 推論。 */
type MemorySource = { kind: "event" | "decision"; ref: number } | { kind: "commit"; ref: string };

/** エントリの欄のうち events に写すもの。同一性(id)と版は event 自身の id なので
 *  payload には持たない。 */
export interface MemoryEntryFields {
  kind: "knowledge" | "behavior";
  state: "candidate" | "approved";
  /** workspace 名。null = 盤面全体。 */
  scope: string | null;
  path: string;
  title: string;
  /** 英語の正文 —— 注入・索引・pull はこれだけを読む。 */
  text: string;
  /** 人間由来のみ: 原文と言語名(ADR 0015 四度目の精密化)。agent 由来は null。 */
  original: { text: string; language: string } | null;
  /** Behavior のみ: agent 名 or null = 全員。Knowledge は常に null。 */
  addressee: string | null;
  source: MemorySource;
  author: { activity: "worker_verb" | "human" | "rca" | "meta_review"; name: string };
}

interface MemoryEntry extends MemoryEntryFields {
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

/** 版 = 承認 event の id。表の投影と watermark 再生が同じ1つを読む。 */
function versionOf(state: MemoryEntryFields["state"], createdEventId: number): number | null {
  return state === "approved" ? createdEventId : null;
}

/** エントリ表と FTS への投影(作成と rebuild の再生が共有する)。 */
function insertEntry(db: Db, id: number, entry: MemoryEntryFields): void {
  db.prepare(
    `INSERT INTO memory_entries (id, kind, state, scope, path, title, text, original_text, original_language,
       addressee, source_kind, source_ref, author_activity, author, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    entry.kind,
    entry.state,
    entry.scope,
    entry.path,
    entry.title,
    entry.text,
    entry.original?.text ?? null,
    entry.original?.language ?? null,
    entry.addressee,
    entry.source.kind,
    String(entry.source.ref),
    entry.author.activity,
    entry.author.name,
    versionOf(entry.state, id),
  );
  db.prepare("INSERT INTO memory_fts (rowid, text, title, path, original) VALUES (?, ?, ?, ?, ?)").run(
    id,
    bigram(entry.text),
    bigram(entry.title),
    bigram(entry.path),
    bigram(entry.original?.text ?? ""),
  );
}

function createEntry(db: Db, fields: Omit<MemoryEntryFields, "source"> & { source?: SourceInput }, origin: EventOrigin, at: Date): number {
  if (fields.path.split("/").some((segment) => segment === "" || segment.trim() !== segment)) {
    throw new DomainError(`path must be "/"-separated non-empty segments without surrounding spaces: ${JSON.stringify(fields.path)}`);
  }
  if (fields.title.trim() === "" || fields.text.trim() === "") throw new DomainError("title and text must be non-empty");
  return db.transaction(() => {
    const entry: MemoryEntryFields = { ...fields, source: resolveSource(db, fields.source) };
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
  const id = createEntry(db, { ...input, kind: "knowledge", state: "approved", original: null, addressee: null }, origin, at);
  return { entry_id: id, event_id: id };
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

function requireEntry(db: Db, id: number): EntryRow {
  const row = db.prepare("SELECT * FROM memory_entries WHERE id = ?").get(id) as EntryRow | undefined;
  if (!row) throw new DomainError(`no memory entry ${id}`);
  return row;
}

/** 無効化(削除は無い)。人間 / meta-review の判断で、エントリは approved 集合から外れる。
 *  返り値は memory_entry_invalidated の event id。 */
export function invalidateMemoryEntry(
  db: Db,
  input: { entry_id: number; reason: InvalidationReason; successor_id?: number },
  workerId: string,
  origin: EventOrigin,
  at: Date,
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
    return appendEvent(db, {
      taskId: null,
      workerId,
      origin,
      payload: { kind: "memory_entry_invalidated", entry_id, reason, successor_id: successor_id ?? null },
      at,
    });
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
  original_text: string | null;
  original_language: string | null;
  addressee: string | null;
  source_kind: MemorySource["kind"];
  source_ref: string;
  author_activity: MemoryEntryFields["author"]["activity"];
  author: string;
  version: number | null;
  invalidation_reason: InvalidationReason | null;
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
    original: row.original_text === null ? null : { text: row.original_text, language: row.original_language! },
    addressee: row.addressee,
    source:
      row.source_kind === "commit"
        ? { kind: "commit", ref: row.source_ref }
        : { kind: row.source_kind, ref: Number(row.source_ref) },
    author: { activity: row.author_activity, name: row.author },
    version: row.version,
  };
}

/** approved かつ無効化されていないエントリ(id 順)。`watermark`(memory 系 event の id)を
 *  渡すと、その時点までの events を再生して当時の集合を返す —— 表は投影なので、指定が
 *  無ければ表を読む。 */
/** 店を変える memory 系 events(id 順)。watermark の再生と rebuild が同じ列を読む。 */
function storeEvents(db: Db, watermark = Number.MAX_SAFE_INTEGER) {
  return (
    db
      .prepare("SELECT id, payload FROM events WHERE kind IN ('memory_entry_created', 'memory_entry_invalidated') AND id <= ? ORDER BY id")
      .all(watermark) as Array<{ id: number; payload: string }>
  ).map(({ id, payload }) => ({ id, event: JSON.parse(payload) as Extract<EventPayload, { kind: `memory_entry_${string}` }> }));
}

export function approvedMemoryEntries(db: Db, watermark?: number): MemoryEntry[] {
  if (watermark !== undefined) {
    const entries = new Map<number, MemoryEntry>();
    for (const { id, event } of storeEvents(db, watermark)) {
      if (event.kind === "memory_entry_created") {
        entries.set(id, { ...event.entry, id, version: versionOf(event.entry.state, id) });
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

/** CJK の連なりを重なりつきの2文字語に割る(spec #586 B、LWC 式)。unicode61 は CJK を
 *  語に切らないので、索引と query の両方にこれを通す。1文字の連なりはそのまま。 */
function bigram(value: string): string {
  return value.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu, (run) => {
    const chars = [...run];
    const grams = chars.length === 1 ? chars : chars.slice(1).map((char, i) => chars[i] + char);
    return ` ${grams.join(" ")} `;
  });
}

/** pull 3動詞のページ長(定数 — spec #586 D)。 */
const PAGE_LENGTH = 20;

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
      .prepare("SELECT COALESCE(MAX(id), 0) AS id FROM events WHERE kind IN ('memory_entry_created', 'memory_entry_invalidated')")
      .get() as { id: number }
  ).id;
}

/** pull 1回 = memory_pulled 1つ(task 帰属)。event id を結果に載せ、投影器がそれを
 *  memory マーカーに結ぶ。 */
function recordPull<T>(
  db: Db,
  reader: MemoryReader,
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

/** query を語ごとに引用符で囲む(識別子の / . - を FTS の構文として読ませない)。 */
function ftsQuery(query: string): string {
  const terms = query.split(/\s+/).filter(Boolean);
  if (terms.length === 0) throw new DomainError("query must be non-empty");
  return terms.map((term) => `"${bigram(term).trim().replaceAll('"', '""')}"`).join(" ");
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
  const page = input.page ?? 1;
  return db.transaction(() => {
    const hits = db
      .prepare(
        `SELECT e.* FROM memory_fts JOIN memory_entries e ON e.id = memory_fts.rowid
          WHERE memory_fts MATCH ? AND e.state = 'approved' AND (e.scope IS NULL OR e.scope = ?)
          ORDER BY memory_fts.rank, e.id`,
      )
      .all(ftsQuery(input.query), reader.scope) as EntryRow[];
    const visible = hits.filter((row) => dropReason(row, reader) === null);
    const shown = visible.slice((page - 1) * PAGE_LENGTH, page * PAGE_LENGTH);
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
        truncated: visible.length > page * PAGE_LENGTH,
      },
      at,
    );
  })();
}

function dropReason(row: EntryRow, reader: MemoryReader): MemoryDropReason | null {
  if (row.invalidation_reason !== null) return "invalidated";
  if (row.addressee !== null && row.addressee !== reader.agent) return "addressee";
  return null;
}

/** search / INDEX / read に共通のフィルタ(spec #586 B): approved、未無効化、スコープ(task の
 *  workspace or 盤面全体)、宛先(agent 名一致 or 全員)。 */
function visibleEntries(db: Db, reader: MemoryReader): EntryRow[] {
  return db
    .prepare(
      `SELECT * FROM memory_entries
        WHERE state = 'approved' AND invalidation_reason IS NULL
          AND (scope IS NULL OR scope = ?) AND (addressee IS NULL OR addressee = ?)
        ORDER BY id`,
    )
    .all(reader.scope, reader.agent) as EntryRow[];
}

/** 派生の INDEX(ADR 0083 追記3): prefix の直下の子 —— 1段深い sub-prefix と、path が
 *  prefix そのものの leaf。prefix 無し = 最上位(深さ1)。保存しない。 */
export function browseMemory(
  db: Db,
  reader: MemoryReader,
  input: { prefix?: string; page?: number },
  at: Date,
): { prefixes: string[]; entries: Array<{ id: number; title: string }>; truncated: boolean; event_id: number } {
  const prefix = input.prefix ?? "";
  const page = input.page ?? 1;
  return db.transaction(() => {
    const entries = visibleEntries(db, reader);
    const below = prefix === "" ? entries : entries.filter((e) => e.path.startsWith(`${prefix}/`));
    const depth = prefix === "" ? 1 : prefix.split("/").length + 1;
    const children: Array<string | EntryRow> = [
      ...[...new Set(below.map((e) => e.path.split("/").slice(0, depth).join("/")))].filter((p) => p !== prefix).sort(),
      ...entries.filter((e) => e.path === prefix),
    ];
    const shown = children.slice((page - 1) * PAGE_LENGTH, page * PAGE_LENGTH);
    const leaves = shown.filter((child): child is EntryRow => typeof child !== "string");
    return recordPull(
      db,
      reader,
      { verb: "browse_memory", input, returned_ids: leaves.map((e) => e.id) },
      {
        prefixes: shown.filter((child): child is string => typeof child === "string"),
        entries: leaves.map(({ id, title }) => ({ id, title })),
        truncated: children.length > page * PAGE_LENGTH,
      },
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

/** rebuild(spec #586 G): エントリ表と FTS を消し、memory 系 events を再生して作り直し、
 *  索引の版を今の版に刻む。無効化済みの行(理由コード・後継 id)も再生で戻る。 */
export function rebuildMemoryIndex(db: Db, workerId: string, origin: EventOrigin, at: Date): number {
  return db.transaction(() => {
    db.exec(`DELETE FROM memory_entries; DROP TABLE memory_fts; ${MEMORY_FTS_DDL};`);
    for (const { id, event } of storeEvents(db)) {
      if (event.kind === "memory_entry_created") insertEntry(db, id, event.entry);
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
