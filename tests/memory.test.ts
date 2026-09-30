import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, getEvent, listEvents, listLog } from "../src/events.js";
import {
  approvedMemoryEntries,
  approveMemoryProposal,
  buildMemoryInjection,
  createBehaviorCandidate,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  ensureMemoryIndex,
  foldMemory,
  foldMemoryEntries,
  humanEntryInput,
  invalidateMemoryEntry,
  listMemoryEntries,
  type MemoryAmendment,
  movedPins,
  moveMemory,
  moveMemoryBranch,
  previewCase,
  proposeMemoryChange,
  readMemory,
  rebuildMemoryIndex,
  recordBehavior,
  recordExemplar,
  recordKnowledge,
  rejectMemoryProposal,
  restoreMemoryEntry,
} from "../src/memory.js";
import { countUnsettledAttachedChildren, DomainError, getTask, logDecision, type MemoryProposal, registerTask } from "../src/tasks.js";
import { bundledObjection, WORKER_SPAWNED } from "./harness.js";

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
  ["理由コードが cause の memory(ADR 0166 決定7)", () => ({ reason: "memory" as never }), /unknown invalidation reason/],
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
  const draft = (title: string) => createBehaviorCandidate(db, { ...knowledge, title, addressee: null, source: { commit: "0a46a46" } }, "board", at).entry_id;
  const replaced = draft("replaced");
  const candidate = draft("draft");
  for (const [entry_id, successor_id] of [
    [entry, dead],
    [replaced, candidate],
  ] as const) {
    expect(() => invalidateMemoryEntry(db, { entry_id, reason: "superseded", successor_id }, "human", "webui", at)).toThrow(
      /must be an approved, non-invalidated entry/,
    );
  }
  expect(approvedMemoryEntries(db).map((e) => e.title)).toEqual(["kept"]);
  expect(listMemoryEntries(db, { state: "invalidated" }).map((e) => e.id)).toEqual([dead]);
});

it("author の活動 board(Board call の起草)は Knowledge と Definition では domain error で拒まれ、Behavior candidate にだけ書ける", () => {
  const { db } = board();
  const author = { activity: "board" as const, name: "tidepool" };
  expect(() => recordKnowledge(db, { ...knowledge, author, source: { commit: "0a46a46" } }, "board", at)).toThrow(DomainError);
  expect(() => defineMemoryBranch(db, { scope: "tidepool", path: "build", text: "how the build runs", author }, "board", at)).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual([]);

  createBehaviorCandidate(db, { ...knowledge, author, addressee: null, source: { commit: "0a46a46" } }, "board", at);
  expect(listMemoryEntries(db, {}).map((e) => e.author)).toEqual([author]);
});

it("approved の Behavior を直接作れるのは人間名義だけ —— worker・RCA・Board call・meta-review の名義では domain error で何も残らない(ADR 0152)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration", "deckhand", at);
  for (const activity of ["worker_verb", "rca", "board", "meta_review"] as const) {
    expect(() =>
      recordBehavior(db, { ...knowledge, addressee: null, source_event_id: decision, author: { activity, name: "deckhand" } }, "worker", at),
    ).toThrow(/only a human/);
  }
  expect(listMemoryEntries(db, {})).toEqual([]);
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

const definition = {
  scope: "tidepool",
  path: "build",
  text: "How this workspace is built and tested.",
  author: { activity: "worker_verb" as const, name: "deckhand" },
};

it("枝の定義は種別 definition の approved エントリで、title = text、出所は自身の作成 event(版 = 作成 event の id)。作成 event の kind は definition", () => {
  const { db } = board();
  const { entry_id, event_id } = defineMemoryBranch(db, definition, "worker", at);

  expect(entry_id).toBe(event_id);
  expect(approvedMemoryEntries(db)).toEqual([
    {
      id: entry_id,
      kind: "definition",
      state: "approved",
      scope: "tidepool",
      path: "build",
      title: "How this workspace is built and tested.",
      text: "How this workspace is built and tested.",
      original: null,
      addressee: null,
      source: { kind: "event", ref: entry_id },
      author: { activity: "worker_verb", name: "deckhand" },
      version: event_id,
    },
  ]);
  expect(getEvent(db, event_id)).toMatchObject({ kind: "memory_entry_created", payload: { entry: { kind: "definition" } } });
});

it.each([
  ["改行を含む", { text: "Builds.\nAnd tests." }, /one line/],
  ["CR を含む", { text: "Builds.\rAnd tests." }, /one line/],
  ["出所を渡した", { source: { commit: "0a46a46" } }, /no source/],
  ["path に空の段", { path: "build//tests" }, /path/],
  ["text が空白だけ", { text: " " }, /title and text/],
])("%s定義は domain error で拒まれ、何も載らない", (_, overrides, message) => {
  const { db } = board();
  const define = () => defineMemoryBranch(db, { ...definition, ...overrides }, "worker", at);
  expect(define).toThrow(DomainError);
  expect(define).toThrow(message);
  expect(approvedMemoryEntries(db)).toEqual([]);
});

it("同じ枝・同じスコープに approved の定義があれば domain error —— スコープが違えば共存し、無効化の後なら書ける", () => {
  const { db } = board();
  const workspace = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const other = defineMemoryBranch(db, { ...definition, scope: "charts" }, "worker", at).entry_id;
  expect(() => defineMemoryBranch(db, { ...definition, text: "Another line." }, "worker", at)).toThrow(/already defined/);
  expect(() => defineMemoryBranch(db, { ...definition, scope: "charts", text: "Another line." }, "worker", at)).toThrow(/already defined/);

  invalidateMemoryEntry(db, { entry_id: workspace, reason: "requirement_change" }, "human", "webui", at);
  const revised = defineMemoryBranch(db, { ...definition, text: "Another line." }, "worker", at).entry_id;
  expect(approvedMemoryEntries(db).map((e) => e.id)).toEqual([other, revised]);
});

it("同じ枝の定義は supersedes にその生きた定義を含めれば書き直せ、supersedes の各定義(同じ path の別 scope も)は superseded + 後継で無効化される —— 含めなければ domain error で何も変わらない(ADR 0162 決定1)", () => {
  const { db } = board();
  const old = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const other = defineMemoryBranch(db, { ...definition, scope: "charts", text: "How charts builds." }, "worker", at).entry_id;
  const before = listMemoryEntries(db, {});
  expect(() => defineMemoryBranch(db, { ...definition, text: "Third line.", supersedes: [other] }, "webui", at)).toThrow(/already defined/);
  expect(listMemoryEntries(db, {})).toEqual(before);

  const revised = defineMemoryBranch(db, { ...definition, text: "Another line.", supersedes: [old, other] }, "webui", at).entry_id;
  expect(approvedMemoryEntries(db)).toMatchObject([{ id: revised, path: "build", text: "Another line." }]);
  expect(listMemoryEntries(db, { state: "invalidated" })).toMatchObject([
    { id: old, invalidation_reason: "superseded", successor_id: revised },
    { id: other, invalidation_reason: "superseded", successor_id: revised },
  ]);
});

it("定義の書き込みの supersedes に別 path の定義があれば、書く先の定義の有無を問わず domain error で枝ごとの移動へ案内して何も書かず、同じ path・別 scope の定義は置き換えられる(ADR 0177 決定6)", () => {
  const { db } = board();
  const old = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const target = defineMemoryBranch(db, { ...definition, path: "toolchain", text: "The toolchain." }, "worker", at).entry_id;
  const before = listMemoryEntries(db, {});

  expect(() => defineMemoryBranch(db, { ...definition, path: "ci", text: "How CI runs.", supersedes: [old] }, "webui", at)).toThrow(/move_memory_branch/);
  expect(() => defineMemoryBranch(db, { ...definition, path: "toolchain", text: "Both.", supersedes: [old, target] }, "webui", at)).toThrow(/move_memory_branch/);
  expect(listMemoryEntries(db, {})).toEqual(before);

  const lifted = defineMemoryBranch(db, { ...definition, scope: null, text: "How the board builds.", supersedes: [old] }, "webui", at).entry_id;
  expect(listMemoryEntries(db, { state: "invalidated" })).toMatchObject([{ id: old, invalidation_reason: "superseded", successor_id: lifted }]);
});

it("既にある後継への畳みは Definition を別 path の Definition へ畳むと domain error で枝ごとの移動へ案内して何も変えず、同じ path・別 scope の Definition へは畳める(ADR 0177 決定6)", () => {
  const { db } = board();
  const old = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const elsewhere = defineMemoryBranch(db, { ...definition, path: "toolchain" }, "worker", at).entry_id;
  const other = defineMemoryBranch(db, { ...definition, scope: "charts" }, "worker", at).entry_id;
  const before = listMemoryEntries(db, {});
  const fold = (successor_id: number) => () => foldMemoryEntries(db, { replaces: [old], successor_id, author: human }, "webui", at);

  expect(fold(elsewhere)).toThrow(/move_memory_branch/);
  expect(listMemoryEntries(db, {})).toEqual(before);
  fold(other)();
  expect(entryById(db, old)).toMatchObject({ invalidation_reason: "superseded", successor_id: other });
});

it("定義の別の枝への付け替えは、枝の改名が枝ごとの移動(path_moved + 複製)、別の枝への統合が枝ごとの移動の merge(superseded + 行き先の定義が後継)(ADR 0176 決定7 / ADR 0177 決定1)", () => {
  const { db } = board();
  defineMemoryBranch(db, definition, "worker", at);
  const renamed = moveMemoryBranch(db, { scope: "tidepool", path: "build", to_scope: "tidepool", to_path: "toolchain", mover: human }, "webui", at).moved[0]!.successor_id;
  const merged = defineMemoryBranch(db, { ...definition, path: "ci" }, "worker", at).entry_id;
  const { folded } = moveMemoryBranch(db, { scope: "tidepool", path: "toolchain", to_scope: "tidepool", to_path: "ci", merge: true, mover: human }, "webui", at);
  expect(folded).toEqual([{ entry_id: renamed, successor_id: merged }]);
  expect(approvedMemoryEntries(db).map((e) => e.id)).toEqual([merged]);
});

it("watermark 再生と rebuild は定義を含めて表と同じ集合に戻す(自身の作成 event の出所も)", () => {
  const { db } = board();
  const define = defineMemoryBranch(db, definition, "worker", at).event_id;
  const fact = record(db, "fact");
  const current = approvedMemoryEntries(db);

  expect(approvedMemoryEntries(db, fact)).toEqual(current);
  expect(approvedMemoryEntries(db, define).map((e) => e.kind)).toEqual(["definition"]);
  // setup のみ: 版の古い店を模して rebuild を走らせる
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  ensureMemoryIndex(db, at);
  expect(approvedMemoryEntries(db)).toEqual(current);
});

const human = { activity: "human" as const, name: "human" };
const original = { title: "Node 22 が要る", text: "テストは Node 22 が要る", language: "Japanese" };
const humanKnowledge = { workspace: "tidepool", path: "build/tests", title: knowledge.title, text: knowledge.text };

it("人間が書く Knowledge は原文の title / text / 言語を持ち、memory_entry_created にも載り、出所は自身の作成 event(種別 = 事実)—— watermark 再生と rebuild でも同じ", () => {
  const { db } = board();
  const { entry_id } = recordKnowledge(
    db,
    humanEntryInput(db, { ...humanKnowledge, original_title: original.title, original_text: original.text }),
    "webui",
    at,
  );

  const current = approvedMemoryEntries(db);
  expect(current).toMatchObject([{ id: entry_id, original, source: { kind: "event", ref: entry_id }, author: human }]);
  expect(getEvent(db, entry_id)).toMatchObject({ payload: { entry: { original } } });
  expect(approvedMemoryEntries(db, entry_id)).toEqual(current);
  // setup のみ: 版の古い店を模して rebuild を走らせる
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  ensureMemoryIndex(db, at);
  expect(approvedMemoryEntries(db)).toEqual(current);
});

it("人間が書く Knowledge の原文は title と text の揃い —— 片方だけは domain error、どちらも無ければ original は null", () => {
  const { db } = board();
  expect(() => recordKnowledge(db, humanEntryInput(db, { ...humanKnowledge, original_title: original.title }), "webui", at)).toThrow(DomainError);
  expect(() => recordKnowledge(db, humanEntryInput(db, { ...humanKnowledge, original_text: original.text }), "webui", at)).toThrow(DomainError);
  expect(() => recordKnowledge(db, humanEntryInput(db, { ...humanKnowledge, original_title: "  ", original_text: original.text }), "webui", at)).toThrow(DomainError);
  recordKnowledge(db, humanEntryInput(db, humanKnowledge), "webui", at);
  expect(approvedMemoryEntries(db)).toMatchObject([{ original: null, author: human }]);
});

it("人間が書く Knowledge に出所を渡すと domain error —— 出所は自身の作成 event", () => {
  const { db } = board();
  expect(() => recordKnowledge(db, { ...knowledge, author: human, source: { commit: "0a46a46" } }, "webui", at)).toThrow(/no source/);
  expect(approvedMemoryEntries(db)).toEqual([]);
});

it("人間が書く Behavior は任意で decision_logged か worker_spawned の event を出所に添えられ(decision でも種別は event)、他の種別の event は domain error —— 添えなければ出所は自身の作成 event(ADR 0153 決定3)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration", "deckhand", at);
  // setup のみ: worker session の開始 event
  const spawned = appendEvent(db, {
    taskId: task.id,
    workerId: "deckhand",
    origin: "board",
    at,
    payload: WORKER_SPAWNED,
  });
  const write = (source_event_id?: number) =>
    recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null, ...(source_event_id === undefined ? {} : { source_event_id }) }, "webui", at).entry_id;

  const fromDecision = write(decision);
  const fromSession = write(spawned);
  const own = write();
  expect(() => write(1)).toThrow(/decision_logged or worker_spawned/);
  expect(() => write(999)).toThrow(DomainError);

  expect(approvedMemoryEntries(db).map((e) => [e.id, e.source])).toEqual([
    [fromDecision, { kind: "event", ref: decision }],
    [fromSession, { kind: "event", ref: spawned }],
    [own, { kind: "event", ref: own }],
  ]);
});

it("人間の Behavior は supersedes で approved の Behavior を書き直し、旧を人間名義の superseded + 後継で無効化する —— candidate・無効化済み・Knowledge・Definition を指すと domain error で何も変わらない(ADR 0152 決定4 / ADR 0162 決定2)", () => {
  const { db } = board();
  const write = (title: string, supersedes?: number[]) =>
    recordBehavior(db, { ...humanEntryInput(db, { ...humanKnowledge, title }), addressee: "deckhand", ...(supersedes === undefined ? {} : { supersedes }) }, "webui", at).entry_id;
  const old = write("old rule");
  const candidate = createBehaviorCandidate(db, { ...knowledge, addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "board", at).entry_id;
  const dead = write("dead rule");
  invalidateMemoryEntry(db, { entry_id: dead, reason: "requirement_change" }, "human", "webui", at);
  const fact = record(db, "fact");
  const branch = defineMemoryBranch(db, { scope: "tidepool", path: "build", text: "How the build runs.", author: human }, "webui", at).entry_id;
  const before = listMemoryEntries(db, {});

  for (const target of [candidate, dead, fact, branch]) expect(() => write("new rule", [old, target])).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);

  const revised = write("new rule", [old]);
  expect(listMemoryEntries(db, { kind: "behavior" })).toMatchObject([
    { id: old, invalidation_reason: "superseded", successor_id: revised },
    { id: candidate },
    { id: dead },
    { id: revised, state: "approved", title: "new rule", addressee: "deckhand", author: human },
  ]);
  // 作成 event の直後が旧の無効化 event
  expect(getEvent(db, revised + 1)).toMatchObject({ worker_id: "human", payload: { kind: "memory_entry_invalidated", entry_id: old, activity: "human" } });
});

it("人間の Behavior の出所は、渡せばそれ、渡さなければ supersedes の出所が1つに揃うとき(1件の編集も、RCA 起草の帰責 event も)それを継ぎ、揃わない・自身の作成 event なら後継自身の作成 event(ADR 0162 決定3)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration", "deckhand", at);
  const other = logDecision(db, task, "keep the schema first", "deckhand", at);
  const registered = listEvents(db, task.id)[0]!.id;
  const drafted = createBehaviorCandidate(db, { ...knowledge, addressee: null, source: { event_id: registered }, author: { activity: "rca", name: "auditor" } }, "board", at).entry_id;
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: drafted, replaces: [] }, "question-1", "webui", at);
  const write = (supersedes?: number[], source_event_id?: number) =>
    recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null, supersedes, ...(source_event_id === undefined ? {} : { source_event_id }) }, "webui", at).entry_id;

  const inherited = write([drafted]);
  const replaced = write([inherited], decision);
  const shared = write([replaced, write(undefined, decision)]);
  const unshared = write([shared, write(undefined, other)]);
  const ownEdited = write([write()]);

  expect(approvedMemoryEntries(db).map((e) => [e.id, e.source])).toEqual([
    [unshared, { kind: "event", ref: unshared }],
    [ownEdited, { kind: "event", ref: ownEdited }],
  ]);
  expect([inherited, replaced, shared].map((id) => entryById(db, id)?.source)).toEqual([
    { kind: "event", ref: registered },
    { kind: "event", ref: decision },
    { kind: "event", ref: decision },
  ]);
});

it("直接編集で superseded になった approved Behavior を pin する open な提案 question は、観測で決着し回答は残らない(ADR 0152 決定4)", () => {
  const { db, task } = board();
  const write = (supersedes?: number[]) => recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null, supersedes }, "webui", at).entry_id;
  const old = write();
  const { question_id } = proposeMemoryChange(db, task.id, { op: "invalidate", target_id: old, reason: "requirement_change", rationale: "r" }, "auditor", at);

  write([old]);

  expect(getTask(db, question_id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, question_id).map((e) => e.kind)).toEqual(["task_registered", "memory_proposal_stale"]);
});

const exemplar = (db: ReturnType<typeof openDb>, source_event_id: number, annotations: unknown[]) =>
  recordExemplar(
    db,
    humanEntryInput(db, { workspace: "tidepool", path: "habits/migrations", title: "Split the migration", addressee: null, source_event_id, annotations }),
    "webui",
    at,
  ).entry_id;
const whole = { anchor: "whole", polarity: "imitate", text: "Keep the whole shape." };

it("人間が書く Exemplar は書いた時点で approved・書き手 human・出所は事例の event(decision でも種別は event)で、text は注釈の英語 text の連結、原文は注釈ごとに表示言語つきで持つ —— 作成 event が残り watermark 再生と rebuild でも同じ(ADR 0153 決定1)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  const id = exemplar(db, decision, [
    { anchor: { field: "decision", quote: "two commits" }, polarity: "imitate", text: "Split schema changes from data changes.", original: "スキーマとデータの変更を分ける" },
    { anchor: "whole", polarity: "avoid", text: "Do not mix in unrelated refactors." },
  ]);

  const current = approvedMemoryEntries(db);
  expect(current).toEqual([
    {
      id,
      kind: "exemplar",
      state: "approved",
      scope: "tidepool",
      path: "habits/migrations",
      title: "Split the migration",
      text: "Split schema changes from data changes.\nDo not mix in unrelated refactors.",
      original: null,
      addressee: null,
      annotations: [
        {
          anchor: { field: "decision", quote: "two commits" },
          polarity: "imitate",
          text: "Split schema changes from data changes.",
          original: { text: "スキーマとデータの変更を分ける", language: "Japanese" },
        },
        { anchor: "whole", polarity: "avoid", text: "Do not mix in unrelated refactors." },
      ],
      source: { kind: "event", ref: decision },
      author: human,
      version: id,
    },
  ]);
  expect(getEvent(db, id)).toMatchObject({ payload: { kind: "memory_entry_created", entry: { kind: "exemplar", annotations: current[0]!.annotations } } });
  expect(approvedMemoryEntries(db, id)).toEqual(current);
  // setup のみ: 版の古い店を模して rebuild を走らせる
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  ensureMemoryIndex(db, at);
  expect(approvedMemoryEntries(db)).toEqual(current);
});

it.each([
  ["出所が decision_logged / worker_spawned 以外の event", "registered", [whole]],
  ["出所の event が無い", 999, [whole]],
  ["注釈が空", "decision", []],
  ["polarity が無い", "decision", [{ anchor: "whole", text: "Keep it." }]],
  ["text が無い", "decision", [{ anchor: "whole", polarity: "imitate" }]],
  ["text が空白だけ", "decision", [{ anchor: "whole", polarity: "imitate", text: " " }]],
  ["quote が decision の逐語部分文字列でない", "decision", [whole, { anchor: { field: "decision", quote: "three commits" }, polarity: "avoid", text: "x" }]],
  ["quote の欄が空(steering 無し)", "decision", [{ anchor: { field: "steering", quote: "two" }, polarity: "avoid", text: "x" }]],
  ["quote の欄が無い(handoff 無し)", "decision", [{ anchor: { field: "handoff", quote: "two" }, polarity: "avoid", text: "x" }]],
] as const)("Exemplar の%sは domain error で何も書かない(ADR 0153 決定3)", (_, source, annotations) => {
  const { db, task } = board();
  const registered = listEvents(db, task.id)[0]!.id;
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  const ref = source === "registered" ? registered : source === "decision" ? decision : source;
  expect(() => exemplar(db, ref, [...annotations])).toThrow(DomainError);
  expect(approvedMemoryEntries(db)).toEqual([]);
});

it("worker_spawned を出所に持つ Exemplar の decision の quote はその session のどの decision に当たってもよく、steering の anchor は domain error(ADR 0153 決定3)", () => {
  const { db, task } = board();
  // setup のみ: worker session の開始 event
  const spawned = appendEvent(db, {
    taskId: task.id,
    workerId: "deckhand",
    origin: "board",
    at,
    payload: WORKER_SPAWNED,
  });
  logDecision(db, task, "read the schema first", "deckhand", at);
  logDecision(db, task, "split the migration into two commits", "deckhand", at);

  expect(() => exemplar(db, spawned, [{ anchor: { field: "steering", quote: "split" }, polarity: "avoid", text: "x" }])).toThrow(DomainError);
  const id = exemplar(db, spawned, [{ anchor: { field: "decision", quote: "two commits" }, polarity: "imitate", text: "Split it." }]);
  expect(approvedMemoryEntries(db)).toMatchObject([{ id, source: { kind: "event", ref: spawned } }]);
});

/** 種別の線(ADR 0161 決定1)の各種別のエントリ。Behavior は candidate、Exemplar は人間の approved。 */
function kinds() {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  const make = {
    knowledge: () => record(db, "fact"),
    definition: () => defineMemoryBranch(db, definition, "worker", at).entry_id,
    behavior: () => createBehaviorCandidate(db, { ...knowledge, addressee: null, source: { commit: "0a46a46" } }, "board", at).entry_id,
    exemplar: () => exemplar(db, decision, [whole]),
  };
  return { db, make };
}

it.each([
  ["Behavior を Knowledge で superseded", "superseded", "behavior", "knowledge"],
  ["Knowledge を Definition で superseded", "superseded", "knowledge", "definition"],
  ["Behavior を Exemplar で path_moved", "path_moved", "behavior", "exemplar"],
] as const)("%sにする無効化は種別の線を跨ぐので domain error で、エントリは残る(ADR 0161 決定1)", (_, reason, from, to) => {
  const { db, make } = kinds();
  const entry_id = make[from]();
  const successor_id = make[to]();

  expect(() => invalidateMemoryEntry(db, { entry_id, reason, successor_id }, "human", "webui", at)).toThrow(`${from} entry ${entry_id} cannot be ${reason} by ${to} entry ${successor_id}`);
  expect(listMemoryEntries(db, { state: "invalidated" })).toEqual([]);
});

it("superseded は Behavior と Exemplar を互いに置き換え、path_moved は同じ種別を置き換える(ADR 0161 決定1)", () => {
  const { db, make } = kinds();
  const behavior = make.behavior();
  const exemplarEntry = make.exemplar();
  const human = recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null }, "webui", at).entry_id;
  const [moved, fact] = [make.knowledge(), make.knowledge()];

  invalidateMemoryEntry(db, { entry_id: behavior, reason: "superseded", successor_id: exemplarEntry }, "human", "webui", at);
  invalidateMemoryEntry(db, { entry_id: exemplarEntry, reason: "superseded", successor_id: human }, "human", "webui", at);
  invalidateMemoryEntry(db, { entry_id: moved, reason: "path_moved", successor_id: fact }, "human", "webui", at);

  expect(listMemoryEntries(db, { state: "invalidated" }).map((e) => [e.id, e.invalidation_reason, e.successor_id])).toEqual([
    [behavior, "superseded", exemplarEntry],
    [exemplarEntry, "superseded", human],
    [moved, "path_moved", fact],
  ]);
});

it("決定ログの各エントリは、それを含む worker session の worker_spawned の id を持ち、session の窓の外なら null(#953 の picker が「この session」に使う)", () => {
  const { db, task } = board();
  const before = logDecision(db, task, "before any session", "human", at);
  // setup のみ: worker session の開始と終了の event
  const spawned = appendEvent(db, {
    taskId: task.id,
    workerId: "deckhand",
    origin: "board",
    at,
    payload: WORKER_SPAWNED,
  });
  const inside = logDecision(db, task, "inside the session", "deckhand", at);
  appendEvent(db, {
    taskId: task.id,
    workerId: "deckhand",
    origin: "board",
    at,
    payload: { kind: "worker_exited", exit_code: 0, signal: null, stderr_tail: null, worker_spawned_event_id: spawned, usage: null },
  });
  const after = logDecision(db, task, "after the session exited", "human", at);

  expect(listLog(db).map((e) => [e.id, e.session_event_id])).toEqual([
    [before, null],
    [inside, spawned],
    [after, null],
  ]);
});

it("決定ログの各エントリは最新の帰責の entries を持つ —— memory なら名指された id 列、他の cause と帰責の無いエントリは null(ADR 0166 決定6)", () => {
  const { db, task } = board();
  const [followed, overturned, plain] = ["followed the note", "followed then overturned", "no objection"].map((line) => logDecision(db, task, line, "deckhand", at));
  // setup のみ: 束ね済みの異議群を1つ足して帰責する(呼ぶたびに後の異議群 —— 最後の異議群の判定が有効、ADR 0170)
  const attribute = (entry_id: number, cause: "memory" | "capability", entries: number[] | null) =>
    appendEvent(db, { taskId: task.id, workerId: "tidepool", origin: "board", at, payload: { kind: "objection_attributed", entry_id, objection_event_ids: [bundledObjection(db, task.id, entry_id, at)], cause, evidence: "e", entries, round: "initial" } });
  attribute(followed!, "memory", [41, 42]);
  attribute(overturned!, "memory", [41]);
  attribute(overturned!, "capability", null);

  expect(listLog(db).map((e) => [e.id, e.cause, e.entries])).toEqual([
    [followed, "memory", [41, 42]],
    [overturned, "capability", null],
    [plain, null, null],
  ]);
});

it("人間が書く定義の原文は title = text で持つ", () => {
  const { db } = board();
  defineMemoryBranch(db, humanEntryInput(db, { workspace: "tidepool", path: "build", text: definition.text, original_text: "ビルドとテストの手順" }), "webui", at);
  expect(approvedMemoryEntries(db)).toMatchObject([
    { kind: "definition", original: { title: "ビルドとテストの手順", text: "ビルドとテストの手順", language: "Japanese" } },
  ]);
});

it("一覧は candidate と無効化済み(理由コード・後継 id つき)も出し、スコープ・種別・状態で絞れる", () => {
  const { db } = board();
  const boardWide = defineMemoryBranch(db, { ...definition, scope: null }, "worker", at).entry_id;
  const workspace = defineMemoryBranch(db, { ...definition, path: "deploy" }, "worker", at).entry_id;
  const old = record(db, "old");
  const successor = record(db, "new");
  invalidateMemoryEntry(db, { entry_id: old, reason: "superseded", successor_id: successor }, "human", "webui", at);
  const candidate = createBehaviorCandidate(db, { ...knowledge, scope: null, addressee: null, source: { commit: "0a46a46" } }, "board", at).entry_id;

  const ids = (filter: Parameters<typeof listMemoryEntries>[1]) => listMemoryEntries(db, filter).map((e) => e.id);
  expect(ids({})).toEqual([boardWide, workspace, old, successor, candidate]);
  expect(listMemoryEntries(db, {}).find((e) => e.id === old)).toMatchObject({ invalidation_reason: "superseded", successor_id: successor });
  expect(listMemoryEntries(db, {}).find((e) => e.id === successor)).toMatchObject({ invalidation_reason: null, successor_id: null });
  expect(ids({ scope: null })).toEqual([boardWide, candidate]);
  expect(ids({ scope: "tidepool" })).toEqual([workspace, old, successor]);
  expect(ids({ kind: "definition" })).toEqual([boardWide, workspace]);
  expect(ids({ kind: "behavior" })).toEqual([candidate]);
  expect(ids({ state: "approved" })).toEqual([boardWide, workspace, successor]);
  expect(ids({ state: "candidate" })).toEqual([candidate]);
  expect(ids({ state: "invalidated" })).toEqual([old]);
  expect(ids({ scope: "tidepool", kind: "knowledge", state: "approved" })).toEqual([successor]);
});

it("rebuild は一覧を無効化の理由コード・後継 id ごと同じに戻し、memory_index_rebuilt の event id を返す", () => {
  const { db } = board();
  const old = record(db, "old");
  const successor = record(db, "new");
  invalidateMemoryEntry(db, { entry_id: old, reason: "superseded", successor_id: successor }, "human", "webui", at);
  const before = listMemoryEntries(db, {});

  const eventId = rebuildMemoryIndex(db, "human", "mcp", at);

  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(getEvent(db, eventId)).toMatchObject({ kind: "memory_index_rebuilt", worker_id: "human", origin: "mcp" });
});

/** 承認の export(issue #620 / spec #615 A)。pin の一致 / 不一致は回答の挙動としてサーバ境界が言う。 */
function candidate(db: ReturnType<typeof openDb>, title: string, scope: string | null = null, addressee: string | null = null, path = "habits") {
  return createBehaviorCandidate(
    db,
    { scope, path, title, text: `${title}.`, addressee, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    at,
  ).entry_id;
}
const approve = (db: ReturnType<typeof openDb>, candidate_id: number, replaces: Array<{ id: number; version: number | null }> = []) =>
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id, replaces }, "question-1", "webui", at);

it("承認は memory_entry_approved を task 非依存で残し、candidate を approved にして版 = その event の id にする", () => {
  const { db } = board();
  const id = candidate(db, "Keep migrations apart");

  const eventId = approve(db, id);

  expect(getEvent(db, eventId)).toMatchObject({
    task_id: null,
    worker_id: "human",
    origin: "webui",
    payload: { kind: "memory_entry_approved", entry_id: id, question_id: "question-1", replaced: [] },
  });
  expect(approvedMemoryEntries(db)).toMatchObject([{ id, state: "approved", version: eventId }]);
});

it("承認は replaces をその candidate を後継とする superseded で無効化する", () => {
  const { db } = board();
  const old = candidate(db, "old wording");
  const oldVersion = approve(db, old);
  const successor = candidate(db, "new wording");

  const eventId = approve(db, successor, [{ id: old, version: oldVersion }]);

  expect(getEvent(db, eventId)?.payload).toMatchObject({ replaced: [{ id: old, version: oldVersion }] });
  expect(approvedMemoryEntries(db).map((e) => e.id)).toEqual([successor]);
  expect(listMemoryEntries(db, { state: "invalidated" })).toMatchObject([{ id: old, invalidation_reason: "superseded", successor_id: successor }]);
});

it("承認は1 transaction —— 置換の途中で失敗すれば承認 event も approved も残らない", () => {
  const { db } = board();
  const old = candidate(db, "old wording");
  const oldVersion = approve(db, old);
  const successor = candidate(db, "new wording");
  const before = listMemoryEntries(db, {});

  // 同じ entry を2度置換すると2度目の無効化が落ちる(pin の検査は両方通る)
  expect(() => approve(db, successor, [{ id: old, version: oldVersion }, { id: old, version: oldVersion }])).toThrow(DomainError);

  expect(listMemoryEntries(db, {})).toEqual(before);
  expect(approvedMemoryEntries(db, Number.MAX_SAFE_INTEGER).map((e) => e.id)).toEqual([old]);
});

it("watermark 再生と rebuild は承認を読む —— 承認前の watermark では candidate のまま、以降は版つきの approved", () => {
  const { db } = board();
  const old = candidate(db, "old wording");
  const oldVersion = approve(db, old);
  const successor = candidate(db, "new wording");
  const eventId = approve(db, successor, [{ id: old, version: oldVersion }]);

  expect(approvedMemoryEntries(db, eventId - 1).map((e) => e.id)).toEqual([old]);
  expect(approvedMemoryEntries(db, Number.MAX_SAFE_INTEGER)).toEqual(approvedMemoryEntries(db));
  const before = listMemoryEntries(db, {});
  rebuildMemoryIndex(db, "human", "webui", at);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("提案を運ぶ question は着地の門で付帯子として数え、提案を運ばない question は親が待つ子として数えない", () => {
  const { db, task } = board();
  const question = {
    type: "question" as const,
    title: "q",
    purpose: "p",
    completion_criteria: "c",
    parent_id: task.id,
    question: [{ title: "q", options: ["approve", "reject"], recommendation: "approve" }],
  };
  registerTask(db, question, at);
  expect(countUnsettledAttachedChildren(db, task.id)).toBe(0);

  registerTask(
    db,
    { ...question, proposal: { kind: "memory", op: "approve", candidate_id: 1, replaces: [] } },
    at,
  );
  expect(countUnsettledAttachedChildren(db, task.id)).toBe(1);
});

it("invalidate op の承認は target を理由コードのまま後継なしで無効化し、承認 event は残さない", () => {
  const { db } = board();
  const target = candidate(db, "Stale rule");
  const version = approve(db, target);

  const eventId = approveMemoryProposal(db, { kind: "memory", op: "invalidate", target: { id: target, version }, reason: "environment", replaces: [] }, "question-2", "webui", at);

  expect(getEvent(db, eventId)?.payload).toEqual({ kind: "memory_entry_invalidated", entry_id: target, reason: "environment", successor_id: null, question_id: "question-2" });
  expect(approvedMemoryEntries(db)).toEqual([]);
});

it("consolidate op の承認は candidate と approved Behavior の混ざった replaces を新 entry を後継とする superseded にし、pin 不一致なら何も残さない", () => {
  const { db } = board();
  const approvedOld = candidate(db, "approved wording");
  const approvedVersion = approve(db, approvedOld);
  const candidateOld = candidate(db, "candidate wording");
  const merged = candidate(db, "merged wording");
  const consolidate = (version: number) =>
    approveMemoryProposal(
      db,
      { kind: "memory", op: "consolidate", candidate_id: merged, replaces: [{ id: approvedOld, version }, { id: candidateOld, version: null }] },
      "question-3",
      "webui",
      at,
    );
  const before = listMemoryEntries(db, {});

  expect(() => consolidate(approvedVersion + 1000)).toThrow(/stale/);
  expect(listMemoryEntries(db, {})).toEqual(before);

  consolidate(approvedVersion);
  expect(approvedMemoryEntries(db).map((e) => e.id)).toEqual([merged]);
  expect(listMemoryEntries(db, { state: "invalidated" })).toMatchObject([
    { id: approvedOld, invalidation_reason: "superseded", successor_id: merged },
    { id: candidateOld, invalidation_reason: "superseded", successor_id: merged },
  ]);
});

it("scope null の統合が承認されると別々の workspace の注入に届き、置換された workspace の entry は注入されなくなる", () => {
  const { db } = board();
  const task = registerTask(db, { type: "work", title: "fix tide chart", purpose: "chart drifts", completion_criteria: "tests pass" }, at);
  const local = candidate(db, "tide chart local rule", "tidepool");
  const localVersion = approve(db, local);
  const injected = (scope: string) => buildMemoryInjection(db, task, scope, "deckhand").entries.map((e) => e.id);
  expect(injected("tidepool")).toEqual([local]);

  const boardWide = candidate(db, "tide chart board rule");
  approveMemoryProposal(db, { kind: "memory", op: "consolidate", candidate_id: boardWide, replaces: [{ id: local, version: localVersion }] }, "question-4", "webui", at);

  expect(injected("tidepool")).toEqual([boardWide]);
  expect(injected("sandbox")).toEqual([boardWide]);
});

it("reject は consolidate の新 candidate だけを後継なしの rejected にして replaces を残し、invalidate の提案では何も変えない", () => {
  const { db } = board();
  const old = candidate(db, "old wording");
  const version = approve(db, old);
  const merged = candidate(db, "merged wording");
  const before = listMemoryEntries(db, {});

  rejectMemoryProposal(db, { kind: "memory", op: "invalidate", target: { id: old, version }, reason: "environment", replaces: [] }, "question-1", "webui", at, "Still true.");
  expect(listMemoryEntries(db, {})).toEqual(before);

  rejectMemoryProposal(db, { kind: "memory", op: "consolidate", candidate_id: merged, replaces: [{ id: old, version }] }, "question-2", "webui", at, "Loses a case.");
  expect(listMemoryEntries(db, { state: "invalidated" })).toMatchObject([{ id: merged, invalidation_reason: "rejected", successor_id: null }]);
  expect(approvedMemoryEntries(db).map((e) => e.id)).toEqual([old]);
});

it("出所の揃わない統合が承認された Behavior(出所 = meta-review の推論)の read_memory の case は null —— 推論は事例ではない(issue #954)", () => {
  const { db, task } = board();
  const other = createBehaviorCandidate(
    db,
    { scope: null, path: "habits", title: "Split schema changes", text: "Split schema changes.", addressee: null, source: { commit: "b7e1c2d" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    at,
  ).entry_id;
  const text = { scope: null, path: "habits", title: "One concern per commit", text: "Keep each commit to one concern.", addressee: null };
  const based_on_decision = logDecision(db, task, "the split rules say the same thing", "auditor", at);
  const { question_id } = proposeMemoryChange(db, task.id, { op: "consolidate", text, replaces: [candidate(db, "Keep migrations apart"), other], based_on_decision, rationale: "r" }, "auditor", at);
  const proposal = getTask(db, question_id)!.question_proposal as Parameters<typeof approveMemoryProposal>[1] & { candidate_id: number };
  approveMemoryProposal(db, proposal, question_id, "webui", at);

  expect(readMemory(db, { taskId: task.id, scope: "tidepool", agent: "deckhand" }, { ids: [proposal.candidate_id] }, at).entries).toMatchObject([
    { id: proposal.candidate_id, source: { kind: "decision", ref: based_on_decision }, source_kind: "inference", case: null },
  ]);
});

/** 修正値つき approve(issue #944 / ADR 0152 決定2・4): 承認の export に修正値を渡す。 */
const entryById = (db: ReturnType<typeof openDb>, id: number) => listMemoryEntries(db, {}).find((e) => e.id === id);

it("修正値つき approve は人間名義の approved エントリを作り、candidate を後継つき superseded にする —— 欠けた欄と出所は candidate から継ぐ", () => {
  const { db } = board();
  const drafted = candidate(db, "Split migrations", "tidepool", "deckhand");

  const created = approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: drafted, replaces: [] }, "question-1", "webui", at, {
    text: "Keep migrations in their own commit.",
  });

  expect(entryById(db, created)).toMatchObject({
    kind: "behavior",
    state: "approved",
    scope: "tidepool",
    path: "habits",
    title: "Split migrations",
    text: "Keep migrations in their own commit.",
    addressee: "deckhand",
    original: null,
    author: { activity: "human" },
    source: { kind: "commit", ref: "0a46a46" },
    invalidation_reason: null,
  });
  expect(entryById(db, drafted)).toMatchObject({ state: "candidate", invalidation_reason: "superseded", successor_id: created });
});

it("修正値つき consolidate は replaces の後継も新エントリにし、統合後の candidate を approved にしない", () => {
  const { db } = board();
  const replaced = [candidate(db, "Split migrations", "tidepool", "deckhand"), candidate(db, "Split schema changes", "tidepool", "deckhand")];
  const merged = candidate(db, "One concern per commit", "tidepool", "deckhand");

  const created = approveMemoryProposal(
    db,
    { kind: "memory", op: "consolidate", candidate_id: merged, replaces: replaced.map((id) => ({ id, version: null })) },
    "question-1",
    "webui",
    at,
    { title: "One concern", addressee: null },
  );

  expect(entryById(db, created)).toMatchObject({ state: "approved", title: "One concern", text: "One concern per commit.", addressee: null, author: { activity: "human" }, source: { kind: "commit", ref: "0a46a46" } });
  for (const id of [merged, ...replaced]) expect(entryById(db, id)).toMatchObject({ state: "candidate", invalidation_reason: "superseded", successor_id: created });
});

it("pin が古ければ修正値つきでも拒否し、何も変えない", () => {
  const { db } = board();
  const drafted = candidate(db, "Split migrations", "tidepool", "deckhand");
  const proposal = { kind: "memory" as const, op: "approve" as const, candidate_id: drafted, replaces: [] };
  approveMemoryProposal(db, proposal, "elsewhere", "webui", at);
  const before = listMemoryEntries(db, {});

  expect(() => approveMemoryProposal(db, proposal, "question-1", "webui", at, { text: "Keep migrations apart." })).toThrow(/stale/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("修正値つき approve が生む event(新エントリの作成と無効化)はすべて question の id を印に持つ", () => {
  const { db } = board();
  const replaced = candidate(db, "Split migrations", "tidepool", "deckhand");
  const merged = candidate(db, "One concern per commit", "tidepool", "deckhand");

  const created = approveMemoryProposal(
    db,
    { kind: "memory", op: "consolidate", candidate_id: merged, replaces: [{ id: replaced, version: null }] },
    "question-1",
    "webui",
    at,
    { text: "One concern." },
  );

  expect([created, created + 1, created + 2, created + 3].map((id) => getEvent(db, id)).map((e) => e && [e.kind, (e.payload as { question_id?: string }).question_id])).toEqual([
    ["memory_entry_created", "question-1"],
    ["memory_entry_invalidated", "question-1"],
    ["memory_entry_invalidated", "question-1"],
    undefined,
  ]);
});

it("RCA が起草した candidate(出所は帰責 event)を修正値つきで approve すると、後継は candidate の出所を継ぎ read_memory の case が引ける(ADR 0152 決定4 / ADR 0153 決定3)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration", "deckhand", at);
  const attributed = appendEvent(db, {
    taskId: task.id,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [bundledObjection(db, task.id, decision, at)], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
    at,
  });
  const drafted = createBehaviorCandidate(db, { ...knowledge, addressee: null, source: { event_id: attributed }, author: { activity: "rca", name: "auditor" } }, "board", at).entry_id;

  const created = approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: drafted, replaces: [] }, "question-1", "webui", at, { text: "Keep migrations apart." });

  const [read] = readMemory(db, { taskId: task.id, scope: "tidepool", agent: "deckhand" }, { ids: [created] }, at).entries;
  expect(read?.source).toEqual(entryById(db, drafted)?.source);
  expect(read?.case).toMatchObject({ decision: "split the migration" });
});

it("出所が自身の作成 event の candidate を修正値つきで approve すると、後継の出所は後継自身の作成 event", () => {
  const { db } = board();
  const drafted = createBehaviorCandidate(db, { ...knowledge, addressee: null, author: human }, "webui", at).entry_id;
  expect(entryById(db, drafted)?.source).toEqual({ kind: "event", ref: drafted });

  const created = approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: drafted, replaces: [] }, "question-1", "webui", at, { text: "Keep migrations apart." });

  expect(entryById(db, created)?.source).toEqual({ kind: "event", ref: created });
});

/** 注釈の修正値(issue #950 / ADR 0152 決定2・4 の Exemplar 版): RCA の帰責 event を出所に共有する2つの candidate を
 *  consolidate の kind exemplar で統合した Exemplar candidate への approve。 */
function exemplarProposal() {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  // setup のみ: RCA の帰責 event(起草の出所)
  const attributed = appendEvent(db, {
    taskId: task.id,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [bundledObjection(db, task.id, decision, at)], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
    at,
  });
  const replaces = ["Split migrations", "Two commits"].map(
    (title) => createBehaviorCandidate(db, { ...knowledge, title, addressee: null, source: { event_id: attributed }, author: { activity: "rca", name: "auditor" } }, "board", at).entry_id,
  );
  const { question_id } = proposeMemoryChange(
    db,
    task.id,
    {
      op: "consolidate",
      text: {
        scope: "tidepool",
        path: "habits/migrations",
        title: "Split the migration",
        addressee: "deckhand",
        kind: "exemplar",
        annotations: [{ anchor: { field: "decision", quote: "two commits" }, polarity: "imitate", text: "Split schema changes from data changes." }],
      },
      replaces,
      based_on_decision: logDecision(db, task, "too particular for a rule", "auditor", at),
      rationale: "r",
    },
    "auditor",
    at,
  );
  const proposal = getTask(db, question_id)!.question_proposal as Parameters<typeof approveMemoryProposal>[1] & { candidate_id: number };
  return { db, proposal, replaces, attributed };
}

it("Exemplar の candidate への注釈の修正値つき approve は、注釈 list を差し替えた人間名義の approved Exemplar を作り、candidate と replaces を後継つき superseded にする —— 出所は candidate から継ぎ、生む event は question の id を印に持つ", () => {
  const { db, proposal, replaces, attributed } = exemplarProposal();

  const created = approveMemoryProposal(db, proposal, "question-1", "webui", at, {
    title: "Keep the migration apart",
    addressee: null,
    annotations: [
      { anchor: { field: "decision", quote: "the migration" }, polarity: "avoid", text: "Do not bundle the migration.", original: "マイグレーションをまとめない" },
      { anchor: "whole", polarity: "imitate", text: "Keep the whole shape." },
    ],
  });

  expect(entryById(db, created)).toMatchObject({
    kind: "exemplar",
    state: "approved",
    scope: "tidepool",
    path: "habits/migrations",
    title: "Keep the migration apart",
    text: "Do not bundle the migration.\nKeep the whole shape.",
    addressee: null,
    annotations: [
      {
        anchor: { field: "decision", quote: "the migration" },
        polarity: "avoid",
        text: "Do not bundle the migration.",
        original: { text: "マイグレーションをまとめない", language: "Japanese" },
      },
      { anchor: "whole", polarity: "imitate", text: "Keep the whole shape." },
    ],
    author: { activity: "human" },
    source: { kind: "event", ref: attributed },
    invalidation_reason: null,
  });
  for (const id of [proposal.candidate_id, ...replaces]) expect(entryById(db, id)).toMatchObject({ invalidation_reason: "superseded", successor_id: created });
  // setup の question は答えずに candidate が落ちるので陳腐化の event も立つ —— 見るのは memory の event だけ
  const written = [0, 1, 2, 3, 4, 5].map((n) => getEvent(db, created + n)).filter((e) => e?.kind.startsWith("memory_entry_"));
  expect(written.map((e) => [e!.kind, (e!.payload as { question_id?: string }).question_id])).toEqual([
    ["memory_entry_created", "question-1"],
    ["memory_entry_invalidated", "question-1"],
    ["memory_entry_invalidated", "question-1"],
    ["memory_entry_invalidated", "question-1"],
  ]);
});

it("Exemplar の candidate への title だけの修正値は candidate の注釈を継ぐ", () => {
  const { db, proposal } = exemplarProposal();
  const drafted = entryById(db, proposal.candidate_id)!;

  const created = approveMemoryProposal(db, proposal, "question-1", "webui", at, { title: "Keep the migration apart" });

  expect(entryById(db, created)).toMatchObject({ kind: "exemplar", title: "Keep the migration apart", text: drafted.text, annotations: drafted.annotations, author: { activity: "human" } });
});

it.each<[string, MemoryAmendment]>([
  ["anchor の quote が case の逐語部分文字列でない", { annotations: [{ anchor: { field: "decision", quote: "three commits" }, polarity: "avoid", text: "x" }] }],
  ["Exemplar に text", { text: "Split it." }],
  ["Exemplar に原文", { original_title: "分ける", original_text: "分ける" }],
])("Exemplar の candidate への修正値で%sは domain error で何も変えない", (_, amendment) => {
  const { db, proposal } = exemplarProposal();
  const before = listMemoryEntries(db, {});

  expect(() => approveMemoryProposal(db, proposal, "question-1", "webui", at, amendment)).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("Behavior の candidate への修正値の注釈は domain error で何も変えない", () => {
  const { db } = board();
  const drafted = candidate(db, "Split migrations");
  const before = listMemoryEntries(db, {});

  expect(() =>
    approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: drafted, replaces: [] }, "question-1", "webui", at, { annotations: [{ anchor: "whole", polarity: "imitate", text: "Keep the whole shape." }] }),
  ).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("case preview は帰責 event も描く —— RCA 起草の出所を継いだ Exemplar の candidate の case で、修正値の anchor はそこから選ぶ", () => {
  const { db, attributed } = exemplarProposal();
  expect(previewCase(db, attributed)).toEqual({ decision: "split the migration into two commits", steering: ["redo it"], handoff: null, result: null });
});

/** 移動(ADR 0162 決定4・5)の4種別のエントリ: 出所の違う Knowledge 2つ(worker の commit・人間の自身の宣言)、Definition、
 *  自身の宣言の人間の Behavior、question で承認された RCA 起草の Behavior、candidate、事例を引く Exemplar。 */
function movable() {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  const drafted = candidate(db, "Keep migrations apart");
  approve(db, drafted);
  record(db, "worker fact");
  recordKnowledge(db, humanEntryInput(db, { ...humanKnowledge, original_title: original.title, original_text: original.text }), "webui", at);
  defineMemoryBranch(db, definition, "worker", at);
  recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: "deckhand" }, "webui", at);
  candidate(db, "Rebase before push");
  exemplar(db, decision, [{ anchor: { field: "decision", quote: "two commits" }, polarity: "imitate", text: "Split it.", original: "分ける" }]);
  return db;
}

it("移動は4種別の未無効化の approved / candidate を写し、複製は本文の側(書き手・状態・出所・版・宛先・注釈・原文)を継いで scope と path(Definition は scope)だけを変え、旧は path_moved + 複製 —— 移した者は両方の event の activity に載る(ADR 0162 決定4・5 / ADR 0176 決定7)", () => {
  const db = movable();
  const before = listMemoryEntries(db, {});
  expect(before.map((e) => [e.kind, e.state])).toEqual([
    ["behavior", "approved"],
    ["knowledge", "approved"],
    ["knowledge", "approved"],
    ["definition", "approved"],
    ["behavior", "approved"],
    ["behavior", "candidate"],
    ["exemplar", "approved"],
  ]);
  // 自身の宣言の出所(人間の Knowledge・Definition・出所を添えない人間の Behavior)は、複製では複製自身の作成 event(ADR 0162 追記)
  expect(before.filter((e) => e.source.ref === e.id).map((e) => e.kind)).toEqual(["knowledge", "definition", "behavior"]);

  const place = (old: (typeof before)[number]) => (old.kind === "definition" ? old.path : "moved/here");
  const copies = before.map((old) => moveMemory(db, { entry_id: old.id, scope: null, path: place(old), mover: human }, "webui", at).entry_id);

  const after = new Map(listMemoryEntries(db, {}).map((e) => [e.id, e]));
  before.forEach((old, i) => {
    const copy = copies[i]!;
    expect(after.get(copy)).toEqual({ ...old, id: copy, scope: null, path: place(old), source: old.source.ref === old.id ? { kind: "event", ref: copy } : old.source });
    expect(after.get(old.id)).toMatchObject({ invalidation_reason: "path_moved", successor_id: copy, invalidated_by: { activity: "human" } });
    expect(getEvent(db, copy)).toMatchObject({ worker_id: "human", payload: { kind: "memory_entry_created", activity: "human", entry: { author: old.author } } });
  });
});

it("移動先が今の置き場と同じ・無効化済み・存在しないエントリの移動は domain error で何も変わらない", () => {
  const { db } = board();
  const fact = record(db, "fact");
  const dead = record(db, "dead");
  invalidateMemoryEntry(db, { entry_id: dead, reason: "environment" }, "human", "webui", at);
  const before = listMemoryEntries(db, {});
  const move = (entry_id: number, scope: string | null, path: string) => () => moveMemory(db, { entry_id, scope, path, mover: human }, "webui", at);

  expect(move(fact, "tidepool", "build/tests")).toThrow(/already at/);
  expect(move(dead, null, "elsewhere")).toThrow(DomainError);
  expect(move(999, null, "elsewhere")).toThrow(/no memory entry 999/);
  expect(move(fact, null, "a//b")).toThrow(/path/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("エントリ1件の移動は Definition の path を変えると domain error で枝ごとの移動へ案内して何も変わらず、path が同じで scope だけを変える移動は通る(ADR 0176 決定7)", () => {
  const { db } = board();
  const branch = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const before = listMemoryEntries(db, {});

  for (const scope of ["tidepool", null]) {
    expect(() => moveMemory(db, { entry_id: branch, scope, path: "toolchain", mover: human }, "webui", at)).toThrow(/move_memory_branch/);
  }
  expect(listMemoryEntries(db, {})).toEqual(before);

  const widened = moveMemory(db, { entry_id: branch, scope: null, path: "build", mover: human }, "webui", at).entry_id;
  expect(approvedMemoryEntries(db)).toMatchObject([{ id: widened, kind: "definition", scope: null, path: "build" }]);
});

it("Definition を生きた Definition のある scope へ移すと domain error で畳むよう促し、何も変わらない —— 別の scope なら移せる", () => {
  const { db } = board();
  const moving = defineMemoryBranch(db, definition, "worker", at).entry_id;
  defineMemoryBranch(db, { ...definition, scope: "charts", text: "The charts build." }, "worker", at);
  const before = listMemoryEntries(db, {});

  expect(() => moveMemory(db, { entry_id: moving, scope: "charts", path: "build", mover: human }, "webui", at)).toThrow(/fold/);
  expect(listMemoryEntries(db, {})).toEqual(before);
  moveMemory(db, { entry_id: moving, scope: "lagoon", path: "build", mover: human }, "webui", at);
  expect(approvedMemoryEntries(db).map((e) => [e.scope, e.path])).toEqual([["charts", "build"], ["lagoon", "build"]]);
});

it("枝ごとの移動は移動元の scope(完全一致)で path が P か P/… の未無効化エントリを4種別とも to_scope の to_path + 残りへ写し、旧 id → 複製の id を返す —— 無効化済み・隣の枝・別の scope は残る", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  const fact = (path: string, scope: string | null = "tidepool") => recordKnowledge(db, { ...knowledge, scope, path, title: path, source: { commit: "0a46a46" } }, "worker", at).entry_id;
  const branch = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const tests = fact("build/tests");
  const dead = fact("build/old");
  invalidateMemoryEntry(db, { entry_id: dead, reason: "environment" }, "human", "webui", at);
  const drafted = createBehaviorCandidate(db, { ...knowledge, path: "build/ci", addressee: null, source: { commit: "0a46a46" } }, "board", at).entry_id;
  const example = recordExemplar(
    db,
    humanEntryInput(db, { workspace: "tidepool", path: "build/ci/split", title: "Split", addressee: null, source_event_id: decision, annotations: [whole] }),
    "webui",
    at,
  ).entry_id;
  const kept = [fact("buildx"), fact("build/tests", "charts")];

  const { moved } = moveMemoryBranch(db, { scope: "tidepool", path: "build", to_scope: null, to_path: "toolchain", mover: human }, "webui", at);

  const entries = new Map(listMemoryEntries(db, {}).map((e) => [e.id, e]));
  expect(moved.map(({ entry_id, successor_id }) => [entry_id, entries.get(entry_id)?.successor_id === successor_id, entries.get(successor_id)])).toMatchObject([
    [branch, true, { kind: "definition", state: "approved", scope: null, path: "toolchain" }],
    [tests, true, { kind: "knowledge", state: "approved", scope: null, path: "toolchain/tests" }],
    [drafted, true, { kind: "behavior", state: "candidate", scope: null, path: "toolchain/ci" }],
    [example, true, { kind: "exemplar", state: "approved", scope: null, path: "toolchain/ci/split" }],
  ]);
  expect(entries.get(dead)).toMatchObject({ scope: "tidepool", path: "build/old", invalidation_reason: "environment", successor_id: null });
  expect(kept.map((id) => entries.get(id)?.invalidation_reason)).toEqual([null, null]);
});

/** 盤面全体と2つの workspace に同じ枝 build: 盤面全体は定義と leaf、tidepool は子の枝 build/lint の定義と leaf、charts は leaf だけ
 *  (どちらも build は盤面全体の定義に頼る —— workspace は盤面全体のエントリの path とその上位を定義できない、ADR 0178)。 */
function everyWorkspaceUnderBuild() {
  const { db, task } = board();
  const fact = (scope: string | null, path = "build/tests") => recordKnowledge(db, { ...knowledge, scope, path, source: { commit: "0a46a46" } }, "worker", at).entry_id;
  const define = (scope: string | null, path = "build") => defineMemoryBranch(db, { ...definition, scope, path, text: `What ${path} holds in ${scope ?? "the board"}.` }, "worker", at).entry_id;
  const ids = [define(null), fact(null), define("tidepool", "build/lint"), fact("tidepool"), fact("charts", "build/ci")];
  const move = (scope: string | null, to_scope: string | null, to_path = "toolchain", merge?: boolean) =>
    moveMemoryBranch(db, { scope, path: "build", to_scope, to_path, merge, mover: human }, "webui", at);
  return { db, task, define, ids, move };
}

it("盤面全体 → 盤面全体の枝ごとの移動は、全 workspace の同じ path 配下(workspace 自身の定義も)をそれぞれの scope のまま to_path + 残りへ写し、workspace の worker の INDEX に旧 path が残らない(ADR 0177 決定5)", () => {
  const { db, task, ids, move } = everyWorkspaceUnderBuild();

  const { moved } = move(null, null);

  expect(moved.map(({ entry_id }) => entry_id)).toEqual(ids);
  expect(moved.map(({ successor_id }) => entryById(db, successor_id))).toMatchObject([
    { kind: "definition", scope: null, path: "toolchain" },
    { kind: "knowledge", scope: null, path: "toolchain/tests" },
    { kind: "definition", scope: "tidepool", path: "toolchain/lint" },
    { kind: "knowledge", scope: "tidepool", path: "toolchain/tests" },
    { kind: "knowledge", scope: "charts", path: "toolchain/ci" },
  ]);
  for (const scope of ["tidepool", "charts"]) {
    const { section } = buildMemoryInjection(db, task, scope, "deckhand");
    expect(section).not.toContain("- build/");
    expect(section).toContain("- toolchain/ — What build holds in the board.");
  }
  expect(buildMemoryInjection(db, task, "tidepool", "deckhand").section).toContain("  - lint/ — What build/lint holds in tidepool.");
});

it("盤面全体 → 盤面全体の枝ごとの移動の merge は、workspace の中の衝突もその workspace の行き先の定義へ畳んで folded に載せる(ADR 0177 決定5)", () => {
  const { db, ids, define, move } = everyWorkspaceUnderBuild();
  const [boardBuild, boardTests, workspaceLint, workspaceTests, chartsCi] = ids;
  const [boardToolchain, workspaceToolchainLint] = [define(null, "toolchain"), define("tidepool", "toolchain/lint")];

  const { moved, folded } = move(null, null, "toolchain", true);

  expect(folded).toEqual([
    { entry_id: boardBuild, successor_id: boardToolchain },
    { entry_id: workspaceLint, successor_id: workspaceToolchainLint },
  ]);
  expect(moved.map(({ entry_id }) => entry_id)).toEqual([boardTests, workspaceTests, chartsCi]);
  expect(approvedMemoryEntries(db).map((e) => [e.scope, e.path])).toEqual([
    [null, "toolchain"],
    ["tidepool", "toolchain/lint"],
    [null, "toolchain/tests"],
    ["tidepool", "toolchain/tests"],
    ["charts", "toolchain/ci"],
  ]);
});

it("盤面全体に path 配下の未無効化エントリが無ければ、workspace に配下があっても盤面全体 → 盤面全体の枝ごとの移動は domain error で何も変わらない(ADR 0177 決定5)", () => {
  const { db } = board();
  const gone = recordKnowledge(db, { ...knowledge, scope: null, source: { commit: "0a46a46" } }, "worker", at).entry_id;
  invalidateMemoryEntry(db, { entry_id: gone, reason: "environment" }, "human", "webui", at);
  defineMemoryBranch(db, definition, "worker", at);
  record(db, "fact");
  const before = listMemoryEntries(db, {});

  expect(() => moveMemoryBranch(db, { scope: null, path: "build", to_scope: null, to_path: "toolchain", mover: human }, "webui", at)).toThrow(/no live memory entry/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it.each([
  ["workspace の枝の移動", "tidepool", "tidepool", [2, 3]],
  ["盤面全体から workspace へ scope を変える移動", null, "tidepool", [0, 1]],
  ["workspace から盤面全体へ scope を変える移動", "tidepool", null, [2, 3]],
] as const)("%sは移動元の scope のエントリだけを運び、他の scope の配下は旧 path に残る(ADR 0177 決定5)", (_, scope, to_scope, carried) => {
  const { db, ids, move } = everyWorkspaceUnderBuild();

  const { moved } = move(scope, to_scope);

  expect(moved.map(({ entry_id }) => entry_id)).toEqual(carried.map((i) => ids[i]));
  expect(ids.filter((id) => !moved.some((m) => m.entry_id === id)).map((id) => entryById(db, id)?.invalidation_reason)).toEqual([null, null, null]);
});

it("watermark 再生と rebuild は、全 workspace を運んだ盤面全体 → 盤面全体の統合の畳みと複製を表と同じに戻す(ADR 0177 決定5)", () => {
  const { db, define, move } = everyWorkspaceUnderBuild();
  define(null, "toolchain");
  define("tidepool", "toolchain/lint");
  move(null, null, "toolchain", true);
  const current = approvedMemoryEntries(db);
  const listed = listMemoryEntries(db, {});

  expect(approvedMemoryEntries(db, Number.MAX_SAFE_INTEGER)).toEqual(current);
  // setup のみ: 版の古い店を模して rebuild を走らせる
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  ensureMemoryIndex(db, at);
  expect(listMemoryEntries(db, {})).toEqual(listed);
});

it("枝ごとの移動は、移される Definition の置き場に生きた Definition があれば merge なしでは全体を domain error で拒んで衝突する組(根も子も)をすべて名指し、merge ありで衝突が無い・移すものが無い・同じ置き場も domain error —— どれも何も変わらない(ADR 0177 決定2)", () => {
  const { db } = board();
  const [build, buildX] = ["build", "build/x"].map((path) => defineMemoryBranch(db, { ...definition, path }, "worker", at).entry_id);
  record(db, "fact");
  const [toolchain, toolchainX] = ["toolchain", "toolchain/x"].map((path) => defineMemoryBranch(db, { ...definition, scope: null, path }, "worker", at).entry_id);
  const before = listMemoryEntries(db, {});
  const move = (path: string, to_scope: string | null, to_path: string, merge?: boolean) => () =>
    moveMemoryBranch(db, { scope: "tidepool", path, to_scope, to_path, merge, mover: human }, "webui", at);

  expect(move("build", null, "toolchain")).toThrow(
    `definition ${build} onto definition ${toolchain} at toolchain in scope whole board, definition ${buildX} onto definition ${toolchainX} at toolchain/x in scope whole board: pass merge: true`,
  );
  expect(move("build", "tidepool", "elsewhere", true)).toThrow(/move without merge/);
  expect(move("nothing", null, "elsewhere")).toThrow(/no live memory entry/);
  expect(move("build", "tidepool", "build")).toThrow(/already at/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

/** 枝の統合(ADR 0177 決定1〜4)の盤面: 同じ scope の2枝 build と toolchain が根と子 x の両方に定義を持ち、build/tests に leaf。 */
function merging() {
  const { db } = board();
  const define = (path: string) => defineMemoryBranch(db, { ...definition, path, text: `What ${path} holds.` }, "worker", at).entry_id;
  const [build, buildX, toolchain, toolchainX] = ["build", "build/x", "toolchain", "toolchain/x"].map(define) as [number, number, number, number];
  const tests = record(db, "fact");
  const move = (merge?: boolean) => () =>
    moveMemoryBranch(db, { scope: "tidepool", path: "build", to_scope: "tidepool", to_path: "toolchain", merge, mover: human }, "webui", at);
  return { db, build, buildX, toolchain, toolchainX, tests, move };
}

it("枝ごとの移動の merge は、移される定義の行き先(同じ scope・path)の生きた定義へ根も子も一度に superseded(移した者の印)で畳み、残りを写して moved と folded を返す —— 行き先の定義は版も文言も変わらない(ADR 0177 決定1〜4)", () => {
  const { db, build, buildX, toolchain, toolchainX, tests, move } = merging();
  const destinations = () => [toolchain, toolchainX].map((id) => entryById(db, id)).map((e) => [e?.version, e?.text]);
  const before = destinations();

  const { moved, folded } = move(true)();

  expect(folded).toEqual([
    { entry_id: build, successor_id: toolchain },
    { entry_id: buildX, successor_id: toolchainX },
  ]);
  expect(moved).toEqual([{ entry_id: tests, successor_id: expect.any(Number) }]);
  expect([build, buildX, tests].map((id) => entryById(db, id))).toMatchObject([
    { invalidation_reason: "superseded", successor_id: toolchain, invalidated_by: { activity: "human" } },
    { invalidation_reason: "superseded", successor_id: toolchainX, invalidated_by: { activity: "human" } },
    { invalidation_reason: "path_moved", successor_id: moved[0]!.successor_id },
  ]);
  expect(approvedMemoryEntries(db).map((e) => [e.id, e.path])).toEqual([
    [toolchain, "toolchain"],
    [toolchainX, "toolchain/x"],
    [moved[0]!.successor_id, "toolchain/tests"],
  ]);
  expect(destinations()).toEqual(before);
});

it("watermark 再生と rebuild は移した複製(1件・枝ごと、2度の移動も)と統合の畳みを表と同じ版・状態・書き手・出所・後継に戻す", () => {
  const db = movable();
  for (const { id, kind, path } of listMemoryEntries(db, {})) moveMemory(db, { entry_id: id, scope: "charts", path: kind === "definition" ? path : "moved", mover: human }, "webui", at);
  defineMemoryBranch(db, { ...definition, scope: "charts", path: "moved" }, "worker", at);
  defineMemoryBranch(db, { ...definition, scope: null, path: "again" }, "worker", at);
  moveMemoryBranch(db, { scope: "charts", path: "moved", to_scope: null, to_path: "again", merge: true, mover: human }, "webui", at);
  const current = approvedMemoryEntries(db);
  const listed = listMemoryEntries(db, {});

  expect(approvedMemoryEntries(db, Number.MAX_SAFE_INTEGER)).toEqual(current);
  // setup のみ: 版の古い店を模して rebuild を走らせる
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  ensureMemoryIndex(db, at);
  expect(listMemoryEntries(db, {})).toEqual(listed);
});

it("復元は無効化済みのエントリの本文の側(書き手・状態・出所・宛先)を同じ scope / path に写して新エントリにし、作成 event は復元元と復元した者を持ち、旧は無効化のまま —— rejected の candidate は candidate のまま(ADR 0163 決定1・3)", () => {
  const { db } = board();
  const drafted = candidate(db, "Rebase before push", "tidepool", "deckhand");
  invalidateMemoryEntry(db, { entry_id: drafted, reason: "rejected" }, "human", "webui", at);
  const [old] = listMemoryEntries(db, {});

  const { entry_id } = restoreMemoryEntry(db, { entry_id: drafted, restorer: human }, "webui", at);

  const after = new Map(listMemoryEntries(db, {}).map((e) => [e.id, e]));
  expect(after.get(drafted)).toEqual({ ...old, restored_as: entry_id });
  expect(after.get(entry_id)).toEqual({ ...old, id: entry_id, invalidation_reason: null, successor_id: null, invalidated_by: null, cause: null });
  expect(old).toMatchObject({ state: "candidate", scope: "tidepool", addressee: "deckhand", author: { activity: "rca" }, source: { kind: "commit", ref: "0a46a46" } });
  const created = getEvent(db, entry_id);
  expect(created).toMatchObject({ worker_id: "human", payload: { kind: "memory_entry_created", restored_from: drafted, activity: "human" } });
  expect(created?.payload).not.toHaveProperty("version");
});

it("superseded のエントリは後継が生きている間は domain error で復元できず、後継の path_moved の鎖を末尾までたどる —— 末尾の複製も落ちれば復元できる(ADR 0163 決定2)", () => {
  const { db } = board();
  const old = record(db, "old wording");
  const successor = record(db, "new wording");
  invalidateMemoryEntry(db, { entry_id: old, reason: "superseded", successor_id: successor }, "human", "webui", at);
  const restore = () => restoreMemoryEntry(db, { entry_id: old, restorer: human }, "webui", at);

  expect(restore).toThrow(new RegExp(`successor ${successor}`));
  const moved = moveMemory(db, { entry_id: successor, scope: null, path: "moved", mover: human }, "webui", at).entry_id;
  const before = listMemoryEntries(db, {});
  expect(restore).toThrow(new RegExp(`successor ${moved}`));
  expect(listMemoryEntries(db, {})).toEqual(before);

  invalidateMemoryEntry(db, { entry_id: moved, reason: "environment" }, "human", "webui", at);
  const { entry_id } = restore();
  expect(approvedMemoryEntries(db).map((e) => [e.id, e.title])).toEqual([[entry_id, "old wording"]]);
});

it("後継の superseded の鎖はたどらない —— 後継が落ちていれば、その後継の後継が生きていても復元できる(ADR 0163 決定2)", () => {
  const { db } = board();
  const old = record(db, "first wording");
  const middle = record(db, "second wording");
  const latest = record(db, "third wording");
  invalidateMemoryEntry(db, { entry_id: old, reason: "superseded", successor_id: middle }, "human", "webui", at);
  invalidateMemoryEntry(db, { entry_id: middle, reason: "superseded", successor_id: latest }, "human", "webui", at);

  const { entry_id } = restoreMemoryEntry(db, { entry_id: old, restorer: human }, "webui", at);
  expect(approvedMemoryEntries(db).map((e) => [e.id, e.title])).toEqual([
    [latest, "third wording"],
    [entry_id, "first wording"],
  ]);
});

it("path_moved のエントリ・無効化されていないエントリの復元は domain error で何も変わらない —— 移されたものは複製の側を扱う(ADR 0163 決定1)", () => {
  const { db } = board();
  const fact = record(db, "fact");
  const moved = moveMemory(db, { entry_id: fact, scope: null, path: "moved", mover: human }, "webui", at).entry_id;
  const before = listMemoryEntries(db, {});
  const restore = (entry_id: number) => () => restoreMemoryEntry(db, { entry_id, restorer: human }, "webui", at);

  expect(restore(fact)).toThrow(/moved/);
  expect(restore(moved)).toThrow(/not invalidated/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("一度復元した旧の2回目の復元は復元の複製を名指す domain error で何も変わらない(ADR 0163 追記 #1059)", () => {
  const { db } = board();
  const fact = record(db, "fact");
  invalidateMemoryEntry(db, { entry_id: fact, reason: "capability" }, "human", "webui", at);
  const copy = restoreMemoryEntry(db, { entry_id: fact, restorer: human }, "webui", at).entry_id;
  const before = listMemoryEntries(db, {});

  expect(() => restoreMemoryEntry(db, { entry_id: fact, restorer: human }, "webui", at)).toThrow(
    new DomainError(`memory entry ${fact} was already restored as entry ${copy}: handle that copy instead`),
  );
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("一覧の restored_as は復元した旧の行だけに復元の複製の id を持ち、複製とほかの行は null(ADR 0163 追記 #1059)", () => {
  const { db } = board();
  const fact = record(db, "fact");
  const other = record(db, "other");
  invalidateMemoryEntry(db, { entry_id: fact, reason: "capability" }, "human", "webui", at);
  const copy = restoreMemoryEntry(db, { entry_id: fact, restorer: human }, "webui", at).entry_id;

  expect(listMemoryEntries(db, {}).map((e) => [e.id, e.restored_as])).toEqual([
    [fact, copy],
    [other, null],
    [copy, null],
  ]);
});

it("復元の複製を落としても旧は復元できず、落ちた複製は復元できる —— 1つの本文から復元できる行は常に1本(ADR 0163 追記 #1059)", () => {
  const { db } = board();
  const fact = record(db, "fact");
  invalidateMemoryEntry(db, { entry_id: fact, reason: "capability" }, "human", "webui", at);
  const copy = restoreMemoryEntry(db, { entry_id: fact, restorer: human }, "webui", at).entry_id;
  invalidateMemoryEntry(db, { entry_id: copy, reason: "environment" }, "human", "webui", at);
  const before = listMemoryEntries(db, {});

  expect(() => restoreMemoryEntry(db, { entry_id: fact, restorer: human }, "webui", at)).toThrow(new RegExp(`already restored as entry ${copy}`));
  expect(listMemoryEntries(db, {})).toEqual(before);
  const { entry_id } = restoreMemoryEntry(db, { entry_id: copy, restorer: human }, "webui", at);
  expect(approvedMemoryEntries(db).map((e) => [e.id, e.title])).toEqual([[entry_id, "fact"]]);
});

it("復元の複製が生きた後継に畳まれていれば、旧も複製も復元できない(ADR 0163 決定2・追記 #1059)", () => {
  const { db } = board();
  const fact = record(db, "fact");
  invalidateMemoryEntry(db, { entry_id: fact, reason: "capability" }, "human", "webui", at);
  const copy = restoreMemoryEntry(db, { entry_id: fact, restorer: human }, "webui", at).entry_id;
  const successor = record(db, "better fact");
  invalidateMemoryEntry(db, { entry_id: copy, reason: "superseded", successor_id: successor }, "human", "webui", at);
  const before = listMemoryEntries(db, {});
  const restore = (entry_id: number) => () => restoreMemoryEntry(db, { entry_id, restorer: human }, "webui", at);

  expect(restore(fact)).toThrow(new RegExp(`already restored as entry ${copy}`));
  expect(restore(copy)).toThrow(new RegExp(`successor ${successor}`));
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("commit を出所に持つ approved の Knowledge を復元すると複製は同じ commit の出所を持ち、版は旧を継がず複製の作成 event の id(ADR 0163 決定1)", () => {
  const { db } = board();
  const fact = record(db, "fact");
  invalidateMemoryEntry(db, { entry_id: fact, reason: "capability" }, "human", "webui", at);

  const { entry_id } = restoreMemoryEntry(db, { entry_id: fact, restorer: human }, "webui", at);

  expect(approvedMemoryEntries(db)).toMatchObject([{ id: entry_id, version: entry_id, source: { kind: "commit", ref: "0a46a46" }, author: knowledge.author }]);
});

it("Definition の復元は同じ scope / path に生きた Definition があれば domain error で何も変わらず、その定義が落ちれば復元できる(ADR 0163 決定4)", () => {
  const { db } = board();
  const old = defineMemoryBranch(db, definition, "worker", at).entry_id;
  invalidateMemoryEntry(db, { entry_id: old, reason: "requirement_change" }, "human", "webui", at);
  const current = defineMemoryBranch(db, { ...definition, text: "The build." }, "worker", at).entry_id;
  const before = listMemoryEntries(db, {});
  const restore = () => restoreMemoryEntry(db, { entry_id: old, restorer: human }, "webui", at);

  expect(restore).toThrow(new RegExp(`already defined in that scope by entry ${current}`));
  expect(listMemoryEntries(db, {})).toEqual(before);
  invalidateMemoryEntry(db, { entry_id: current, reason: "requirement_change" }, "human", "webui", at);
  const { entry_id } = restore();
  expect(approvedMemoryEntries(db)).toMatchObject([{ id: entry_id, kind: "definition", text: definition.text, source: { kind: "event", ref: entry_id } }]);
});

it("watermark 再生と rebuild は復元した複製(4種別、approved と candidate)を表と同じ版・状態・書き手・出所に戻す", () => {
  const db = movable();
  const entries = listMemoryEntries(db, {});
  for (const { id } of entries) invalidateMemoryEntry(db, { entry_id: id, reason: "capability" }, "human", "webui", at);
  for (const { id } of entries) restoreMemoryEntry(db, { entry_id: id, restorer: human }, "webui", at);
  const current = approvedMemoryEntries(db);
  const listed = listMemoryEntries(db, {});
  expect(current).toHaveLength(6);

  expect(approvedMemoryEntries(db, Number.MAX_SAFE_INTEGER)).toEqual(current);
  // setup のみ: 版の古い店を模して rebuild を走らせる
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  ensureMemoryIndex(db, at);
  expect(listMemoryEntries(db, {})).toEqual(listed);
});

/** 人間の畳み(ADR 0162 決定1・2)の4種別の書き込み: 各種別の置き換えられる approved 2件と、supersedes を取る書き込み。
 *  Behavior と Exemplar の組は互いを混ぜる(種別の線、ADR 0161 決定1)。 */
function folds() {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  const fact = (title: string, supersedes?: number[]) => recordKnowledge(db, { ...humanEntryInput(db, { ...humanKnowledge, title }), supersedes }, "webui", at).entry_id;
  const branch = (workspace: string | null, supersedes?: number[]) =>
    defineMemoryBranch(db, { ...humanEntryInput(db, { workspace, path: "build", text: `How ${workspace ?? "the board"} builds.` }), supersedes }, "webui", at).entry_id;
  const rule = (title: string, supersedes?: number[]) =>
    recordBehavior(db, { ...humanEntryInput(db, { ...humanKnowledge, title }), addressee: null, source_event_id: decision, supersedes }, "webui", at).entry_id;
  const example = (supersedes?: number[]) =>
    recordExemplar(db, { ...humanEntryInput(db, { workspace: "tidepool", path: "habits", title: "Split", addressee: null, source_event_id: decision, annotations: [whole] }), supersedes }, "webui", at)
      .entry_id;
  const writes = [
    ["knowledge", [fact("a"), fact("b")], (supersedes: number[]) => fact("folded", supersedes)],
    ["definition", [branch("tidepool"), branch("charts")], (supersedes: number[]) => branch("tidepool", supersedes)],
    ["behavior", [rule("a"), example()], (supersedes: number[]) => rule("folded", supersedes)],
    ["exemplar", [rule("b"), example()], (supersedes: number[]) => example(supersedes)],
  ] as const;
  return { db, writes, pending: candidate(db, "Pending") };
}

it("4種別の書き込みは supersedes の各要素を新エントリの superseded(書き手 human の印)にし、1件でも candidate・種別の線の外なら新エントリも無効化も残さない(ADR 0162 決定1・2 / ADR 0161 決定1)", () => {
  const { db, writes, pending } = folds();
  const [[, facts], [, branches]] = writes;
  const before = listMemoryEntries(db, {});

  for (const [kind, replaced, write] of writes) {
    const acrossTheLine = kind === "knowledge" ? branches[0] : facts[0];
    for (const bad of [pending, acrossTheLine]) expect(() => write([...replaced, bad])).toThrow(DomainError);
  }
  expect(listMemoryEntries(db, {})).toEqual(before);

  for (const [kind, replaced, write] of writes) {
    const successor = write([...replaced]);
    expect(entryById(db, successor)).toMatchObject({ kind, state: "approved", invalidation_reason: null });
    expect(replaced.map((id) => entryById(db, id))).toMatchObject(
      replaced.map(() => ({ invalidation_reason: "superseded", successor_id: successor, invalidated_by: { activity: "human" } })),
    );
  }
});

it("supersedes: [] は domain error で、エントリも event も足さない(ADR 0162 決定1 は1件以上 / #1135)", () => {
  const { db } = board();
  const count = () => db.prepare("SELECT count(*) AS n FROM events").get();
  const before = { entries: listMemoryEntries(db, {}), events: count() };

  expect(() => recordKnowledge(db, { ...humanEntryInput(db, humanKnowledge), supersedes: [] }, "webui", at)).toThrow(DomainError);
  expect({ entries: listMemoryEntries(db, {}), events: count() }).toEqual(before);
});

it("人間の Exemplar は source_event_id を省くと supersedes の揃った出所(RCA 起草の帰責 event も)を事例に継ぎ、注釈はその case で検査する —— 揃わない・supersedes も無いなら domain error で何も書かない(#1041)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  const other = logDecision(db, task, "read the schema first", "deckhand", at);
  // setup のみ: RCA の帰責 event(起草の出所)
  const attributed = appendEvent(db, {
    taskId: task.id,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [bundledObjection(db, task.id, decision, at)], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
    at,
  });
  const drafted = createBehaviorCandidate(db, { ...knowledge, addressee: null, source: { event_id: attributed }, author: { activity: "rca", name: "auditor" } }, "board", at).entry_id;
  approve(db, drafted);
  const cited = exemplar(db, other, [whole]);
  const quoting = (quote: string) => [{ anchor: { field: "decision", quote }, polarity: "imitate", text: "Split it." }];
  const write = (supersedes?: number[], annotations = quoting("two commits")) =>
    recordExemplar(db, { ...humanEntryInput(db, { workspace: "tidepool", path: "habits", title: "Split", addressee: null, annotations }), supersedes }, "webui", at).entry_id;
  const before = listMemoryEntries(db, {});

  expect(() => write([drafted, cited])).toThrow(/share one source/);
  expect(() => write()).toThrow(DomainError);
  expect(() => write([drafted], quoting("schema first"))).toThrow(/not verbatim/);
  expect(listMemoryEntries(db, {})).toEqual(before);

  const id = write([drafted]);
  expect(entryById(db, id)).toMatchObject({ kind: "exemplar", source: { kind: "event", ref: attributed } });
  expect(entryById(db, drafted)).toMatchObject({ invalidation_reason: "superseded", successor_id: id });
});

it("既にある後継への人間の畳みは approved も candidate も replaces に取り、各要素を後継つき superseded(畳んだ者の印)にして新しい entry を作らない —— 種別の線の外・candidate の後継・空の replaces は domain error で何も変わらない(ADR 0162 決定1・2)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration into two commits", "deckhand", at);
  const successor = exemplar(db, decision, [whole]);
  const rule = recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null }, "webui", at).entry_id;
  const [pending, other] = [candidate(db, "Pending"), candidate(db, "Other")];
  const fact = record(db, "fact");
  const fold = (replaces: number[], successor_id = successor) => () => foldMemoryEntries(db, { replaces, successor_id, author: human }, "webui", at);
  const before = listMemoryEntries(db, {});

  expect(fold([pending, fact])).toThrow(`knowledge entry ${fact} cannot be superseded by exemplar entry ${successor}`);
  expect(fold([pending], other)).toThrow(DomainError);
  expect(fold([])).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);

  expect(fold([pending, rule])()).toEqual({ entry_id: successor, event_ids: [expect.any(Number), expect.any(Number)] });
  expect(listMemoryEntries(db, {})).toHaveLength(before.length);
  expect([pending, rule].map((id) => entryById(db, id))).toMatchObject([
    { invalidation_reason: "superseded", successor_id: successor, invalidated_by: { activity: "human" } },
    { invalidation_reason: "superseded", successor_id: successor, invalidated_by: { activity: "human" } },
  ]);
});

it("一覧の replaced_ids は後継の行に superseded で置き換えた id を持ち(path_moved は数えない)、ほかの行は空", () => {
  const { db } = board();
  const [a, b, c] = ["a", "b", "c"].map((title) => record(db, title)) as [number, number, number];
  const written = recordKnowledge(db, { ...humanEntryInput(db, humanKnowledge), supersedes: [a, b] }, "webui", at).entry_id;
  const moved = moveMemory(db, { entry_id: c, scope: null, path: "moved", mover: human }, "webui", at).entry_id;
  foldMemoryEntries(db, { replaces: [moved], successor_id: written, author: human }, "webui", at);

  expect(listMemoryEntries(db, {}).map((e) => [e.id, e.replaced_ids])).toEqual([
    [a, []],
    [b, []],
    [c, []],
    [written, [a, b, moved]],
    [moved, []],
  ]);
  expect(listMemoryEntries(db, { state: "approved" }).map((e) => [e.id, e.replaced_ids])).toEqual([[written, [a, b, moved]]]);
});

it("watermark 再生と rebuild は4種別の supersedes と既にある後継への畳みの結果を表と同じに戻す", () => {
  const { db, writes, pending } = folds();
  const successors = writes.map(([, replaced, write]) => write([...replaced]));
  foldMemoryEntries(db, { replaces: [pending], successor_id: successors[2]!, author: human }, "webui", at);
  const current = approvedMemoryEntries(db);
  const listed = listMemoryEntries(db, {});

  expect(approvedMemoryEntries(db, Number.MAX_SAFE_INTEGER)).toEqual(current);
  // setup のみ: 版の古い店を模して rebuild を走らせる
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  ensureMemoryIndex(db, at);
  expect(listMemoryEntries(db, {})).toEqual(listed);
});

/** 移したエントリを pin する提案 question(ADR 0162 決定6): pin は `path_moved` の鎖の末尾で照合・適用する。 */
function movedCandidateProposal() {
  const { db, task } = board();
  const drafted = candidate(db, "Keep migrations apart");
  const { question_id } = proposeMemoryChange(db, task.id, { op: "approve", candidate_id: drafted, rationale: "r" }, "auditor", at);
  const moved = moveMemory(db, { entry_id: drafted, scope: "tidepool", path: "habits/moved", mover: human }, "webui", at).entry_id;
  const tail = moveMemory(db, { entry_id: moved, scope: null, path: "habits/again", mover: human }, "webui", at).entry_id;
  const proposal = getTask(db, question_id)!.question_proposal as MemoryProposal;
  return { db, task, drafted, tail, question_id, proposal };
}

it("pin した candidate を移しても(2度でも)提案 question は陳腐化せず pin と detail は移す前のまま、approve は path_moved の鎖の末尾を承認する(ADR 0162 決定6)", () => {
  const { db, drafted, tail, question_id, proposal } = movedCandidateProposal();
  expect(getTask(db, question_id)).toMatchObject({ status: "todo" });
  expect(proposal).toMatchObject({ candidate_id: drafted });
  expect(getTask(db, question_id)!.question_items![0]!.detail).toContain("Scope: whole board\nPath: habits\n");

  const eventId = approveMemoryProposal(db, proposal, question_id, "webui", at);

  expect(approvedMemoryEntries(db)).toMatchObject([{ id: tail, scope: null, path: "habits/again", version: eventId }]);
});

it("移した candidate への修正値つき approve は末尾の置き場に人間名義のエントリを作って末尾を superseded にし、reject は末尾を rejected にする(ADR 0162 決定6)", () => {
  const amended = movedCandidateProposal();
  const created = approveMemoryProposal(amended.db, amended.proposal, amended.question_id, "webui", at, { text: "Keep migrations in their own commit." });
  expect(entryById(amended.db, created)).toMatchObject({ state: "approved", scope: null, path: "habits/again", author: { activity: "human" } });
  expect(entryById(amended.db, amended.tail)).toMatchObject({ invalidation_reason: "superseded", successor_id: created });

  const rejected = movedCandidateProposal();
  rejectMemoryProposal(rejected.db, rejected.proposal, rejected.question_id, "webui", at, "Too broad.");
  expect(entryById(rejected.db, rejected.tail)).toMatchObject({ invalidation_reason: "rejected", successor_id: null });
});

it("移した approved を pin する invalidate と既にある後継の consolidate の approve は、末尾の版で照合して末尾を無効化・畳む(ADR 0162 決定6)", () => {
  const { db, task } = board();
  const approved = (title: string) => {
    const id = candidate(db, title);
    approve(db, id);
    return id;
  };
  const move = (entry_id: number) => moveMemory(db, { entry_id, scope: "tidepool", path: "habits/moved", mover: human }, "webui", at).entry_id;
  const [target, successor, replaced] = [approved("Stale rule"), approved("Kept rule"), approved("Covered rule")];
  const invalidate = proposeMemoryChange(db, task.id, { op: "invalidate", target_id: target, reason: "environment", rationale: "r" }, "auditor", at).question_id;
  const consolidate = proposeMemoryChange(db, task.id, { op: "consolidate", successor_id: successor, replaces: [replaced], rationale: "r" }, "auditor", at).question_id;
  const [targetTail, successorTail, replacedTail] = [target, successor, replaced].map(move) as [number, number, number];

  for (const id of [invalidate, consolidate]) approveMemoryProposal(db, getTask(db, id)!.question_proposal as MemoryProposal, id, "webui", at);

  expect(entryById(db, targetTail)).toMatchObject({ invalidation_reason: "environment", successor_id: null });
  expect(entryById(db, replacedTail)).toMatchObject({ invalidation_reason: "superseded", successor_id: successorTail });
  expect(approvedMemoryEntries(db).map((e) => e.id)).toEqual([successorTail]);
});

it("移した後の複製が superseded になると、移す前の id を pin する open な提案 question は観測で決着する(ADR 0162 決定6)", () => {
  const { db, task } = board();
  const write = (supersedes?: number[]) => recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null, supersedes }, "webui", at).entry_id;
  const old = write();
  const { question_id } = proposeMemoryChange(db, task.id, { op: "invalidate", target_id: old, reason: "requirement_change", rationale: "r" }, "auditor", at);
  const tail = moveMemory(db, { entry_id: old, scope: null, path: "moved", mover: human }, "webui", at).entry_id;

  write([tail]);

  expect(getTask(db, question_id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, question_id).map((e) => e.kind)).toEqual(["task_registered", "memory_proposal_stale"]);
});

it("移す前の id を pin する open な提案 question があれば、移した後の複製への提案は domain error(ADR 0162 決定6)", () => {
  const { db, task, tail } = movedCandidateProposal();

  expect(() => proposeMemoryChange(db, task.id, { op: "approve", candidate_id: tail, rationale: "r" }, "auditor", at)).toThrow(`memory entry ${tail} is already in an open proposal question`);
});

it("移動の注釈は移された pin ごとに旧 id と末尾の id・path・scope を持ち、移されていない pin と memory 以外の提案は載せない(ADR 0162 決定6)", () => {
  const { db, drafted, tail, proposal } = movedCandidateProposal();
  expect(movedPins(db, proposal)).toEqual([{ id: drafted, tail_id: tail, path: "habits/again", scope: null }]);

  const [kept, moved, stays] = ["Kept rule", "Covered rule", "Other rule"].map((title) => candidate(db, title)) as [number, number, number];
  const pins = [kept, moved, stays].map((id) => ({ id, version: approve(db, id) }));
  const consolidate: MemoryProposal = { kind: "memory", op: "consolidate", successor: { id: kept, version: pins[0]!.version }, replaces: pins.slice(1) };
  const [keptTail, movedTail] = [kept, moved].map((entry_id) => moveMemory(db, { entry_id, scope: "tidepool", path: "habits/moved", mover: human }, "webui", at).entry_id);
  expect(movedPins(db, consolidate)).toEqual([
    { id: kept, tail_id: keptTail, path: "habits/moved", scope: "tidepool" },
    { id: moved, tail_id: movedTail, path: "habits/moved", scope: "tidepool" },
  ]);

  expect(movedPins(db, null)).toEqual([]);
  expect(movedPins(db, { kind: "routing", op: "promote", pin: { promoted: false } })).toEqual([]);
});

/** 重ねた1本の木の門(ADR 0178 決定2〜5): 盤面全体のエントリを種別と状態・宛先を変えて path に置く。 */
const wholeBoard: Array<[string, (db: ReturnType<typeof openDb>, path: string) => number]> = [
  ["Definition", (db, path) => defineMemoryBranch(db, { ...definition, scope: null, path }, "worker", at).entry_id],
  ["Knowledge", (db, path) => recordKnowledge(db, { ...knowledge, scope: null, path, source: { commit: "0a46a46" } }, "worker", at).entry_id],
  ["宛先つきの approved Behavior", (db, path) => recordBehavior(db, { ...humanEntryInput(db, { ...humanKnowledge, workspace: null, path }), addressee: "deckhand" }, "webui", at).entry_id],
  ["Behavior candidate", (db, path) => candidate(db, "Rebase before push", null, null, path)],
];

it.each(wholeBoard)("盤面全体の %s がある path に workspace の Definition を置く書き込みは domain error で、当たった組を名指して何も書かない", (_, place) => {
  const { db } = board();
  const blocking = place(db, "build");
  const before = listMemoryEntries(db, {});

  const define = () => defineMemoryBranch(db, definition, "worker", at);

  expect(define).toThrow(DomainError);
  expect(define).toThrow(`entry ${blocking} at build`);
  expect(define).toThrow(/file under the branch as it is, or define a sub-branch/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("盤面全体のエントリが P/x にあれば workspace の Definition を P に置けない —— 盤面全体の枝 P の下で配下に盤面全体のエントリが無い子の path は定義でき、workspace の leaf はどこにでも置ける", () => {
  const { db } = board();
  defineMemoryBranch(db, { ...definition, scope: null }, "worker", at);
  const leaf = recordKnowledge(db, { ...knowledge, scope: null, path: "build/x", source: { commit: "0a46a46" } }, "worker", at).entry_id;
  const deep = recordKnowledge(db, { ...knowledge, scope: null, path: "tools/node/x", source: { commit: "0a46a46" } }, "worker", at).entry_id;

  expect(() => defineMemoryBranch(db, { ...definition, path: "tools" }, "worker", at)).toThrow(`entry ${deep} at tools/node/x lies at or under the workspace definition being placed at tools`);
  expect(() => defineMemoryBranch(db, { ...definition, path: "build/x" }, "worker", at)).toThrow(`entry ${leaf} at build/x`);
  const [child, sibling] = ["build/tests", "tool"].map((path) => defineMemoryBranch(db, { ...definition, path }, "worker", at).entry_id);
  const leaves = ["build", "build/x", "build/tests"].map((path) => recordKnowledge(db, { ...knowledge, path, source: { commit: "0a46a46" } }, "worker", at).entry_id);

  expect(listMemoryEntries(db, { scope: "tidepool" }).map((e) => e.id)).toEqual([child, sibling, ...leaves]);
});

const metaReview = { activity: "meta_review" as const, name: "auditor" };
const workspaceKnowledge = (db: ReturnType<typeof openDb>, path: string) => recordKnowledge(db, { ...knowledge, path, source: { commit: "0a46a46" } }, "worker", at).entry_id;

/** 盤面全体のエントリを置く操作ごとに、workspace の定義(返り値の defined)が塞ぐ置き場への1手(返り値の place)を組む。 */
const placingWholeBoard: Array<[string, (db: ReturnType<typeof openDb>, task: ReturnType<typeof board>["task"]) => { defined: number; place: () => unknown }]> = [
  ["直書きの Knowledge", (db) => ({ defined: defineMemoryBranch(db, definition, "worker", at).entry_id, place: () => recordKnowledge(db, { ...knowledge, scope: null, path: "build", source: { commit: "0a46a46" } }, "worker", at) })],
  ["meta-review の define_memory", (db) => ({ defined: defineMemoryBranch(db, definition, "worker", at).entry_id, place: () => defineMemoryByMetaReview(db, { ...definition, scope: null, path: "build/x", author: metaReview }, "worker", at) })],
  ["RCA が起草する Behavior candidate", (db) => ({ defined: defineMemoryBranch(db, definition, "worker", at).entry_id, place: () => candidate(db, "Rebase before push", null, null, "build/x") })],
  [
    "提案が起草する盤面全体の candidate",
    (db, task) => {
      const replaces = [candidate(db, "Keep migrations apart", "tidepool")];
      const based_on_decision = logDecision(db, task, "one rule", "auditor", at);
      const text = { scope: null, path: "build/x", title: "One rule", text: "One rule.", addressee: null };
      return { defined: defineMemoryBranch(db, definition, "worker", at).entry_id, place: () => proposeMemoryChange(db, task.id, { op: "consolidate", text, replaces, based_on_decision, rationale: "r" }, "auditor", at) };
    },
  ],
  [
    "meta-review の fold_memory の新しい本文",
    (db, task) => {
      const replaces = [workspaceKnowledge(db, "notes")];
      const based_on_decision = logDecision(db, task, "same fact", "auditor", at);
      const fold = { scope: null, path: "build/x", title: "Folded", text: "Folded.", replaces, based_on_decision, author: metaReview };
      return { defined: defineMemoryBranch(db, definition, "worker", at).entry_id, place: () => foldMemory(db, task.id, fold, "worker", at) };
    },
  ],
  [
    "盤面全体へ広げる1件の移動",
    (db) => {
      const entry_id = workspaceKnowledge(db, "build/x");
      return { defined: defineMemoryBranch(db, definition, "worker", at).entry_id, place: () => moveMemory(db, { entry_id, scope: null, path: "build/x", mover: human }, "webui", at) };
    },
  ],
  [
    "盤面全体へ広げる枝ごとの移動",
    (db) => {
      workspaceKnowledge(db, "notes/x");
      return { defined: defineMemoryBranch(db, definition, "worker", at).entry_id, place: () => moveMemoryBranch(db, { scope: "tidepool", path: "notes", to_scope: null, to_path: "build", mover: human }, "webui", at) };
    },
  ],
  [
    "盤面全体のエントリの復元",
    (db) => {
      const entry_id = recordKnowledge(db, { ...knowledge, scope: null, path: "build/x", source: { commit: "0a46a46" } }, "worker", at).entry_id;
      invalidateMemoryEntry(db, { entry_id, reason: "environment" }, "human", "webui", at);
      return { defined: defineMemoryBranch(db, definition, "worker", at).entry_id, place: () => restoreMemoryEntry(db, { entry_id, restorer: human }, "webui", at) };
    },
  ],
];

it.each(placingWholeBoard)("workspace が build を定義していれば、%s で盤面全体のエントリを build かその配下に置く操作は domain error で、塞ぐ定義を名指して何も書かない", (_, arrange) => {
  const { db, task } = board();
  const { defined, place } = arrange(db, task);
  const before = listMemoryEntries(db, {});

  expect(place).toThrow(DomainError);
  expect(place).toThrow(`workspace definition ${defined} at build in scope tidepool`);
  expect(place).toThrow(/write a whole-board definition at the workspace definition's path with supersedes, rename the workspace branch with move_memory_branch, or choose another path/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("盤面全体の Definition を書き、その path の workspace の Definition をすべて supersedes に並べる書き込みは1手で通る —— 1つ漏らせば漏れた定義を名指して拒み、何も書かない(ADR 0178 決定5)", () => {
  const { db } = board();
  const [tidepool, charts] = ["tidepool", "charts"].map((scope) => defineMemoryBranch(db, { ...definition, scope }, "worker", at).entry_id) as [number, number];
  const fold = (supersedes: number[]) => () => defineMemoryBranch(db, { ...definition, scope: null, text: "How the board builds.", supersedes }, "webui", at);
  const before = listMemoryEntries(db, {});

  expect(fold([tidepool])).toThrow(`lies at or under workspace definition ${charts} at build in scope charts`);
  expect(fold([tidepool])).not.toThrow(`definition ${tidepool}`);
  expect(listMemoryEntries(db, {})).toEqual(before);

  const { entry_id } = fold([tidepool, charts])();
  expect(approvedMemoryEntries(db).map((e) => [e.id, e.scope])).toEqual([[entry_id, null]]);
});

it("人間が盤面全体の Definition を workspace の Definition で置き換える(supersedes)のは、その path と配下に盤面全体のエントリが他に残らなければ通り、残れば拒む", () => {
  const { db } = board();
  const boardWide = defineMemoryBranch(db, { ...definition, scope: null }, "worker", at).entry_id;
  const leaf = recordKnowledge(db, { ...knowledge, scope: null, path: "build/x", source: { commit: "0a46a46" } }, "worker", at).entry_id;
  const replace = () => defineMemoryBranch(db, { ...definition, supersedes: [boardWide] }, "webui", at);

  expect(replace).toThrow(`whole-board knowledge entry ${leaf} at build/x lies at or under the workspace definition being placed at build in scope tidepool`);
  expect(replace).toThrow(/file under the branch as it is, or define a sub-branch/);
  invalidateMemoryEntry(db, { entry_id: leaf, reason: "environment" }, "human", "webui", at);
  const { entry_id } = replace();
  expect(approvedMemoryEntries(db).map((e) => [e.id, e.scope])).toEqual([[entry_id, "tidepool"]]);
});

it("盤面全体 → 盤面全体の枝ごとの移動が運ぶ workspace の子の定義が行き先の盤面全体のエントリに当たれば、当たった組をすべて名指して全体を拒み、何も書かない(ADR 0178 決定5 / ADR 0177 決定5)", () => {
  const { db } = board();
  defineMemoryBranch(db, { ...definition, scope: null }, "worker", at);
  defineMemoryBranch(db, { ...definition, path: "build/tests" }, "worker", at);
  defineMemoryBranch(db, { ...definition, scope: "charts", path: "build/lint" }, "worker", at);
  const [tests, lint] = ["ci/tests", "ci/lint"].map((path) => recordKnowledge(db, { ...knowledge, scope: null, path, source: { commit: "0a46a46" } }, "worker", at).entry_id);
  const before = listMemoryEntries(db, {});
  const move = () => moveMemoryBranch(db, { scope: null, path: "build", to_scope: null, to_path: "ci", mover: human }, "webui", at);

  expect(move).toThrow(
    `whole-board knowledge entry ${tests} at ci/tests lies at or under the workspace definition being placed at ci/tests in scope tidepool; ` +
      `whole-board knowledge entry ${lint} at ci/lint lies at or under the workspace definition being placed at ci/lint in scope charts: `,
  );
  expect(move).toThrow(/rename the workspace branch with move_memory_branch, or choose another path/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("watermark 再生と rebuild は記録済みの event を写すだけで門を掛けない —— 門を破る並びの event も表にそのまま戻る(ADR 0178)", () => {
  const { db } = board();
  // setup のみ: どの export でも作れない並びを event で直に置く
  const created = (entry: Parameters<typeof recordKnowledge>[1] & { kind: "knowledge" | "definition" }) =>
    appendEvent(db, { taskId: null, workerId: "deckhand", origin: "worker", payload: { kind: "memory_entry_created", entry: { ...entry, state: "approved", original: null, addressee: null, source: null } }, at });
  const leaf = created({ ...knowledge, scope: null, path: "build/x", kind: "knowledge" });
  const defined = created({ ...definition, title: definition.text, kind: "definition" });

  expect(approvedMemoryEntries(db, Number.MAX_SAFE_INTEGER).map((e) => [e.id, e.scope, e.path])).toEqual([
    [leaf, null, "build/x"],
    [defined, "tidepool", "build"],
  ]);
  rebuildMemoryIndex(db, "human", "mcp", at);
  expect(listMemoryEntries(db, {}).map((e) => [e.id, e.invalidation_reason])).toEqual([
    [leaf, null],
    [defined, null],
  ]);
});
