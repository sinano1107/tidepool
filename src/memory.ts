import type { Cause } from "./cause.js";
import type { Db } from "./db.js";
import { appendEvent, type EventOrigin, type EventPayload, getEvent } from "./events.js";
import { DomainError } from "./tasks.js";

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
    db.prepare("UPDATE memory_entries SET invalidation_reason = ?, successor_id = ? WHERE id = ?").run(
      reason,
      successor_id ?? null,
      entry_id,
    );
    return appendEvent(db, {
      taskId: null,
      workerId,
      origin,
      payload: { kind: "memory_entry_invalidated", entry_id, reason, successor_id: successor_id ?? null },
      at,
    });
  })();
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
export function approvedMemoryEntries(db: Db, watermark?: number): MemoryEntry[] {
  if (watermark !== undefined) {
    const entries = new Map<number, MemoryEntry>();
    for (const { id, payload } of db
      .prepare(
        "SELECT id, payload FROM events WHERE kind IN ('memory_entry_created', 'memory_entry_invalidated') AND id <= ? ORDER BY id",
      )
      .all(watermark) as Array<{ id: number; payload: string }>) {
      const event = JSON.parse(payload) as Extract<EventPayload, { kind: `memory_entry_${string}` }>;
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
