import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, getEvent, listEvents, listLog } from "../src/events.js";
import {
  approvedMemoryEntries,
  approveMemoryProposal,
  buildMemoryInjection,
  createBehaviorCandidate,
  defineMemoryBranch,
  ensureMemoryIndex,
  humanEntryInput,
  invalidateMemoryEntry,
  listMemoryEntries,
  type MemoryAmendment,
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
import { countUnsettledAttachedChildren, DomainError, getTask, logDecision, registerTask } from "../src/tasks.js";

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
  const boardWide = defineMemoryBranch(db, { ...definition, scope: null }, "worker", at).entry_id;
  expect(() => defineMemoryBranch(db, { ...definition, text: "Another line." }, "worker", at)).toThrow(/already defined/);
  expect(() => defineMemoryBranch(db, { ...definition, scope: null, text: "Another line." }, "worker", at)).toThrow(/already defined/);

  invalidateMemoryEntry(db, { entry_id: workspace, reason: "requirement_change" }, "human", "webui", at);
  const revised = defineMemoryBranch(db, { ...definition, text: "Another line." }, "worker", at).entry_id;
  expect(approvedMemoryEntries(db).map((e) => e.id)).toEqual([boardWide, revised]);
});

it("同じ枝の定義は supersedes で書き直し、旧定義は superseded + 後継で無効化される —— 1つの枝に approved は1つのまま", () => {
  const { db } = board();
  const old = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const revised = defineMemoryBranch(db, { ...definition, text: "Another line.", supersedes: old }, "webui", at).entry_id;
  expect(approvedMemoryEntries(db)).toMatchObject([{ id: revised, path: "build", text: "Another line." }]);
  expect(() => defineMemoryBranch(db, { ...definition, text: "Third line.", supersedes: old }, "webui", at)).toThrow(/already defined/);
});

it("定義の別の枝への付け替えは、枝の改名が移動(path_moved + 複製)、別の枝への統合が superseded + 後継", () => {
  const { db } = board();
  const old = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const renamed = moveMemory(db, { entry_id: old, scope: "tidepool", path: "toolchain", mover: human }, "webui", at).entry_id;
  const merged = defineMemoryBranch(db, { ...definition, path: "ci" }, "worker", at).entry_id;
  invalidateMemoryEntry(db, { entry_id: renamed, reason: "superseded", successor_id: merged }, "human", "webui", at);
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
    payload: { kind: "worker_spawned", registry_commit: "c", definition_version: "1", advisor: null, provider: "anthropic", model: "opus", effort: "high", source: { tier: "task", provider: "only" }, harness: "claude-code", cli_version: "1" },
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

it("人間の Behavior は supersedes で approved の Behavior を書き直し、旧を人間名義の superseded + 後継で無効化する —— candidate・無効化済み・Knowledge・Definition を指すと domain error で何も変わらない(ADR 0152 決定4)", () => {
  const { db } = board();
  const write = (title: string, supersedes?: number) =>
    recordBehavior(db, { ...humanEntryInput(db, { ...humanKnowledge, title }), addressee: "deckhand", ...(supersedes === undefined ? {} : { supersedes }) }, "webui", at).entry_id;
  const old = write("old rule");
  const candidate = createBehaviorCandidate(db, { ...knowledge, addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "board", at).entry_id;
  const dead = write("dead rule");
  invalidateMemoryEntry(db, { entry_id: dead, reason: "requirement_change" }, "human", "webui", at);
  const fact = record(db, "fact");
  const branch = defineMemoryBranch(db, { scope: "tidepool", path: "build", text: "How the build runs.", author: human }, "webui", at).entry_id;
  const before = listMemoryEntries(db, {});

  for (const target of [candidate, dead, fact, branch]) expect(() => write("new rule", target)).toThrow(DomainError);
  expect(listMemoryEntries(db, {})).toEqual(before);

  const revised = write("new rule", old);
  expect(listMemoryEntries(db, { kind: "behavior" })).toMatchObject([
    { id: old, invalidation_reason: "superseded", successor_id: revised },
    { id: candidate },
    { id: dead },
    { id: revised, state: "approved", title: "new rule", addressee: "deckhand", author: human },
  ]);
  // 作成 event の直後が旧の無効化 event
  expect(getEvent(db, revised + 1)).toMatchObject({ worker_id: "human", payload: { kind: "memory_entry_invalidated", entry_id: old, activity: "human" } });
});

it("人間の Behavior の編集は出所を渡さなければ旧の出所(RCA 起草の帰責 event も)を継ぎ、渡せば置き換える —— 旧の出所が自身の作成 event なら後継も自身の作成 event(ADR 0153 決定3)", () => {
  const { db, task } = board();
  const decision = logDecision(db, task, "split the migration", "deckhand", at);
  const registered = listEvents(db, task.id)[0]!.id;
  const drafted = createBehaviorCandidate(db, { ...knowledge, addressee: null, source: { event_id: registered }, author: { activity: "rca", name: "auditor" } }, "board", at).entry_id;
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: drafted, replaces: [] }, "question-1", "webui", at);
  const edit = (supersedes: number, source_event_id?: number) =>
    recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null, supersedes, ...(source_event_id === undefined ? {} : { source_event_id }) }, "webui", at).entry_id;

  const inherited = edit(drafted);
  const replaced = edit(inherited, decision);
  const own = recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null }, "webui", at).entry_id;
  const ownEdited = edit(own);

  expect(approvedMemoryEntries(db).map((e) => [e.id, e.source])).toEqual([
    [replaced, { kind: "event", ref: decision }],
    [ownEdited, { kind: "event", ref: ownEdited }],
  ]);
  expect(listMemoryEntries(db, { kind: "behavior" }).find((e) => e.id === inherited)?.source).toEqual({ kind: "event", ref: registered });
});

it("直接編集で superseded になった approved Behavior を pin する open な提案 question は、観測で決着し回答は残らない(ADR 0152 決定4)", () => {
  const { db, task } = board();
  const write = (supersedes?: number) =>
    recordBehavior(db, { ...humanEntryInput(db, humanKnowledge), addressee: null, ...(supersedes === undefined ? {} : { supersedes }) }, "webui", at).entry_id;
  const old = write();
  const { question_id } = proposeMemoryChange(db, task.id, { op: "invalidate", target_id: old, reason: "requirement_change", rationale: "r" }, "auditor", at);

  write(old);

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
    payload: { kind: "worker_spawned", registry_commit: "c", definition_version: "1", advisor: null, provider: "anthropic", model: "opus", effort: "high", source: { tier: "task", provider: "only" }, harness: "claude-code", cli_version: "1" },
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
    payload: { kind: "worker_spawned", registry_commit: "c", definition_version: "1", advisor: null, provider: "anthropic", model: "opus", effort: "high", source: { tier: "task", provider: "only" }, harness: "claude-code", cli_version: "1" },
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
  // setup のみ: 帰責の event(同じ entry への追記は最新が有効)
  const attribute = (entry_id: number, cause: "memory" | "capability", entries: number[] | null) =>
    appendEvent(db, { taskId: task.id, workerId: "tidepool", origin: "board", at, payload: { kind: "objection_attributed", entry_id, objection_event_ids: [], cause, evidence: "e", entries, round: "initial" } });
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

it("一覧は candidate と無効化済み(理由コード・後継 id つき)と影になった盤面全体の定義も出し、スコープ・種別・状態で絞れる", () => {
  const { db } = board();
  const boardWide = defineMemoryBranch(db, { ...definition, scope: null }, "worker", at).entry_id;
  const workspace = defineMemoryBranch(db, definition, "worker", at).entry_id;
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
function candidate(db: ReturnType<typeof openDb>, title: string, scope: string | null = null, addressee: string | null = null) {
  return createBehaviorCandidate(
    db,
    { scope, path: "habits", title, text: `${title}.`, addressee, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
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
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
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
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [], cause: "preference", evidence: "e", entries: null, round: "after_rca" },
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
  expect(previewCase(db, attributed)).toEqual({ decision: "split the migration into two commits", steering: [], handoff: null, result: null });
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

it("移動は4種別の未無効化の approved / candidate を写し、複製は本文の側(書き手・状態・出所・版・宛先・注釈・原文)を継いで scope と path だけを変え、旧は path_moved + 複製 —— 移した者は両方の event の activity に載る(ADR 0162 決定4・5)", () => {
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

  const copies = before.map(({ id }) => moveMemory(db, { entry_id: id, scope: null, path: "moved/here", mover: human }, "webui", at).entry_id);

  const after = new Map(listMemoryEntries(db, {}).map((e) => [e.id, e]));
  before.forEach((old, i) => {
    const copy = copies[i]!;
    expect(after.get(copy)).toEqual({ ...old, id: copy, scope: null, path: "moved/here", source: old.source.ref === old.id ? { kind: "event", ref: copy } : old.source });
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

it("Definition を生きた Definition のある path / scope へ移すと domain error で畳むよう促し、何も変わらない —— scope が違えば移せる", () => {
  const { db } = board();
  const moving = defineMemoryBranch(db, definition, "worker", at).entry_id;
  defineMemoryBranch(db, { ...definition, path: "toolchain", text: "The toolchain." }, "worker", at);
  const before = listMemoryEntries(db, {});

  expect(() => moveMemory(db, { entry_id: moving, scope: "tidepool", path: "toolchain", mover: human }, "webui", at)).toThrow(/fold/);
  expect(listMemoryEntries(db, {})).toEqual(before);
  moveMemory(db, { entry_id: moving, scope: null, path: "toolchain", mover: human }, "webui", at);
  expect(approvedMemoryEntries(db).map((e) => [e.scope, e.path])).toEqual([["tidepool", "toolchain"], [null, "toolchain"]]);
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
  const kept = [fact("buildx"), fact("build/tests", null)];

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

it("枝ごとの移動は、移される Definition の置き場に生きた Definition があれば全体を domain error で拒んで畳むよう促し、移すものが無い・同じ置き場も domain error —— どれも何も変わらない", () => {
  const { db } = board();
  defineMemoryBranch(db, definition, "worker", at);
  record(db, "fact");
  defineMemoryBranch(db, { ...definition, scope: null, path: "toolchain" }, "worker", at);
  const before = listMemoryEntries(db, {});
  const move = (path: string, to_scope: string | null, to_path: string) => () =>
    moveMemoryBranch(db, { scope: "tidepool", path, to_scope, to_path, mover: human }, "webui", at);

  expect(move("build", null, "toolchain")).toThrow(/fold/);
  expect(move("nothing", null, "elsewhere")).toThrow(/no live memory entry/);
  expect(move("build", "tidepool", "build")).toThrow(/already at/);
  expect(listMemoryEntries(db, {})).toEqual(before);
});

it("watermark 再生と rebuild は移した複製(1件・枝ごと、2度の移動も)を表と同じ版・状態・書き手・出所に戻す", () => {
  const db = movable();
  for (const { id } of listMemoryEntries(db, {})) moveMemory(db, { entry_id: id, scope: "charts", path: "moved", mover: human }, "webui", at);
  moveMemoryBranch(db, { scope: "charts", path: "moved", to_scope: null, to_path: "again", mover: human }, "webui", at);
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
