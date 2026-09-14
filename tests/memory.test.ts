import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getEvent, listEvents, listLog } from "../src/events.js";
import {
  approvedMemoryEntries,
  createBehaviorCandidate,
  ensureMemoryIndex,
  invalidateMemoryEntry,
  readMemory,
  recordKnowledge,
} from "../src/memory.js";
import { DomainError, logDecision, registerTask } from "../src/tasks.js";

const at = new Date("2026-09-14T00:00:00.000Z");

/** 盤面と、出所に使える event を1つ持つ task(setup だけが db を触る — ADR 0107 決定2)。 */
function board() {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at);
  return { db, task };
}

const knowledge = {
  scope: "tidepool",
  path: "build/tests",
  title: "Tests need Node 22",
  text: "npm test fails on Node 24 because of the better-sqlite3 ABI.",
  author: { activity: "worker_verb" as const, name: "deckhand" },
};

it("Knowledge は書いた瞬間に approved で載り、エントリ全欄を持つ memory_entry_created を残す(版 = 作成 event の id)", () => {
  const { db } = board();
  const { entry_id, event_id } = recordKnowledge(db, { ...knowledge, source: { commit: "0a46a46" } }, "worker", at);

  const expected = {
    id: entry_id,
    kind: "knowledge",
    state: "approved",
    scope: "tidepool",
    path: "build/tests",
    title: "Tests need Node 22",
    text: "npm test fails on Node 24 because of the better-sqlite3 ABI.",
    original: null,
    addressee: null,
    source: { kind: "commit", ref: "0a46a46" },
    author: { activity: "worker_verb", name: "deckhand" },
    version: event_id,
  };
  expect(approvedMemoryEntries(db)).toEqual([expected]);
  const { id: _id, version: _version, ...fields } = expected;
  expect(getEvent(db, event_id)).toMatchObject({
    task_id: null,
    worker_id: "deckhand",
    kind: "memory_entry_created",
    // 同一性(id)と版は event 自身の id なので payload には写さない
    payload: { kind: "memory_entry_created", entry: fields },
  });
});

it("出所の種別は参照の型から導く —— decision_logged の event id は decision(推論)、それ以外の event は event(事実)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "kept the note short", "deckhand", at);
  const registered = listEvents(db, task.id)[0]!.id;
  recordKnowledge(db, { ...knowledge, source: { event_id: decision } }, "worker", at);
  recordKnowledge(db, { ...knowledge, source: { event_id: registered } }, "worker", at);
  expect(approvedMemoryEntries(db).map((e) => e.source)).toEqual([
    { kind: "decision", ref: decision },
    { kind: "event", ref: registered },
  ]);
});

it.each([
  ["出所が無い", { source: undefined }, /exactly one of event_id or commit/],
  ["出所が2つ", { source: { event_id: 1, commit: "0a46a46" } }, /exactly one of event_id or commit/],
  ["盤面に存在しない event id", { source: { event_id: 999 } }, /no event 999/],
  ["commit の形でない", { source: { commit: "HEAD~1" } }, /not a commit hash/],
  ["path が空", { path: "", source: { commit: "0a46a46" } }, /path/],
  ["path に空の段", { path: "build//tests", source: { commit: "0a46a46" } }, /path/],
  ["path が / で始まる", { path: "/build", source: { commit: "0a46a46" } }, /path/],
  ["path の段の前後に空白", { path: " build/tests", source: { commit: "0a46a46" } }, /path/],
  ["title が空白だけ", { title: " ", source: { commit: "0a46a46" } }, /title and text/],
  ["text が空", { text: "", source: { commit: "0a46a46" } }, /title and text/],
])("%s Knowledge は domain error で拒まれ、何も載らない", (_, overrides, message) => {
  const { db } = board();
  const record = () => recordKnowledge(db, { ...knowledge, ...overrides }, "worker", at);
  expect(record).toThrow(DomainError);
  expect(record).toThrow(message);
  expect(approvedMemoryEntries(db)).toEqual([]);
});

it("commit は大文字の hex も受け、小文字に揃えて載せる", () => {
  const { db } = board();
  recordKnowledge(db, { ...knowledge, source: { commit: "0A46A46" } }, "worker", at);
  expect(approvedMemoryEntries(db).map((e) => e.source)).toEqual([{ kind: "commit", ref: "0a46a46" }]);
});

const record = (db: ReturnType<typeof openDb>, title: string) =>
  recordKnowledge(db, { ...knowledge, title, source: { commit: "0a46a46" } }, "worker", at).entry_id;

it("無効化は memory_entry_invalidated を残し、そのエントリを approved 集合から外す(superseded は後継 id つき)", () => {
  const { db } = board();
  const old = record(db, "old wording");
  const successor = record(db, "new wording");

  const eventId = invalidateMemoryEntry(db, { entry_id: old, reason: "superseded", successor_id: successor }, "human", "webui", at);

  expect(approvedMemoryEntries(db).map((e) => e.title)).toEqual(["new wording"]);
  expect(getEvent(db, eventId)).toMatchObject({
    task_id: null,
    worker_id: "human",
    origin: "webui",
    payload: { kind: "memory_entry_invalidated", entry_id: old, reason: "superseded", successor_id: successor },
  });
});

it.each(["capability", "environment", "requirement_change"] as const)(
  "cause の語彙の理由コード %s は後継 id 無しで無効化できる",
  (reason) => {
    const { db } = board();
    const entry = record(db, "stale");
    invalidateMemoryEntry(db, { entry_id: entry, reason }, "human", "mcp", at);
    expect(approvedMemoryEntries(db)).toEqual([]);
  },
);

type Invalidation = Parameters<typeof invalidateMemoryEntry>[1];

it.each<[string, (ids: { entry: number; other: number }) => Omit<Invalidation, "entry_id">, RegExp]>([
  ["superseded に後継 id が無い", () => ({ reason: "superseded" }), /successor/],
  ["path_moved に後継 id が無い", () => ({ reason: "path_moved" }), /successor/],
  ["後継 id が盤面に無い", () => ({ reason: "path_moved", successor_id: 999 }), /no memory entry 999/],
  ["理由コードが語彙に無い", () => ({ reason: "wrong" as never }), /unknown invalidation reason/],
  ["後継 id が自分自身", ({ entry }) => ({ reason: "superseded", successor_id: entry }), /own successor/],
  ["cause の理由コードに後継 id がある", ({ other }) => ({ reason: "capability", successor_id: other }), /successor/],
])("%s無効化は domain error で拒まれ、エントリは残る", (_, input, message) => {
  const { db } = board();
  const entry = record(db, "kept");
  const other = record(db, "other");
  const invalidate = () => invalidateMemoryEntry(db, { entry_id: entry, ...input({ entry, other }) }, "human", "webui", at);
  expect(invalidate).toThrow(DomainError);
  expect(invalidate).toThrow(message);
  expect(approvedMemoryEntries(db).map((e) => e.title)).toEqual(["kept", "other"]);
});

it("後継が無効化済み・candidate のエントリなら置換は domain error —— 置換の連鎖を行き止まりにしない", () => {
  const { db } = board();
  const entry = record(db, "kept");
  const dead = record(db, "dead");
  invalidateMemoryEntry(db, { entry_id: dead, reason: "environment" }, "human", "webui", at);
  const { entry_id: candidate } = createBehaviorCandidate(
    db,
    { ...knowledge, addressee: null, source: { commit: "0a46a46" } },
    "board",
    at,
  );
  for (const successor_id of [dead, candidate]) {
    expect(() => invalidateMemoryEntry(db, { entry_id: entry, reason: "superseded", successor_id }, "human", "webui", at)).toThrow(
      /must be an approved, non-invalidated entry/,
    );
  }
  expect(approvedMemoryEntries(db).map((e) => e.title)).toEqual(["kept"]);
});

it("無効化済み・存在しないエントリの無効化は domain error", () => {
  const { db } = board();
  const entry = record(db, "gone");
  invalidateMemoryEntry(db, { entry_id: entry, reason: "environment" }, "human", "webui", at);
  expect(() => invalidateMemoryEntry(db, { entry_id: entry, reason: "environment" }, "human", "webui", at)).toThrow(/already invalidated/);
  expect(() => invalidateMemoryEntry(db, { entry_id: 999, reason: "environment" }, "human", "webui", at)).toThrow(/no memory entry 999/);
});

it("watermark 指定の approved 集合は events の再生で、最新の watermark では現在の表と一致し、無効化前の watermark では無効化前の集合を返す", () => {
  const { db } = board();
  const first = record(db, "first");
  const second = record(db, "second");
  const invalidation = invalidateMemoryEntry(db, { entry_id: first, reason: "superseded", successor_id: second }, "human", "webui", at);
  const third = recordKnowledge(db, { ...knowledge, title: "third", source: { event_id: first } }, "worker", at).event_id;

  expect(approvedMemoryEntries(db, third)).toEqual(approvedMemoryEntries(db));
  expect(approvedMemoryEntries(db, invalidation - 1).map((e) => e.title)).toEqual(["first", "second"]);
  expect(approvedMemoryEntries(db, first).map((e) => e.title)).toEqual(["first"]);
});

it("Behavior は宛先つきの candidate として作られ、承認されるまで approved 集合(表・再生とも)に入らない", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration from the feature", "deckhand", at);
  const { entry_id, event_id } = createBehaviorCandidate(
    db,
    {
      scope: null,
      path: "habits/commits",
      title: "Keep migrations in their own commit",
      text: "Commit schema changes separately from the feature that uses them.",
      addressee: "deckhand",
      source: { event_id: decision },
      author: { activity: "rca", name: "auditor" },
    },
    "board",
    at,
  );

  expect(getEvent(db, event_id)?.payload).toEqual({
    kind: "memory_entry_created",
    entry: {
      kind: "behavior",
      state: "candidate",
      scope: null,
      path: "habits/commits",
      title: "Keep migrations in their own commit",
      text: "Commit schema changes separately from the feature that uses them.",
      original: null,
      addressee: "deckhand",
      source: { kind: "decision", ref: decision },
      author: { activity: "rca", name: "auditor" },
    },
  });
  expect(entry_id).toBe(event_id);
  expect(approvedMemoryEntries(db)).toEqual([]);
  expect(approvedMemoryEntries(db, event_id)).toEqual([]);
});

it("memory 系の event は決定 log の人間向け種別に入らない", () => {
  const { db, task } = board();
  const entry = record(db, "not for the human log");
  invalidateMemoryEntry(db, { entry_id: entry, reason: "environment" }, "human", "webui", at);
  readMemory(db, { taskId: task.id, scope: "tidepool", agent: "deckhand" }, { ids: [entry] }, at);
  // setup のみ: 版の古い店を模して rebuild を走らせる
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  ensureMemoryIndex(db, at);
  logDecision(db, task, "a decision", "deckhand", at);
  expect(listLog(db).map((e) => e.kind)).toEqual(["decision_logged"]);
});
