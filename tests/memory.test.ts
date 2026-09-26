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
  proposeMemoryChange,
  readMemory,
  rebuildMemoryIndex,
  recordBehavior,
  recordExemplar,
  recordKnowledge,
  rejectMemoryProposal,
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

it("定義は別の枝への付け替えにも既存の無効化で直る —— 枝の改名は path_moved + 後継、別の枝への統合は superseded + 後継", () => {
  const { db } = board();
  const old = defineMemoryBranch(db, definition, "worker", at).entry_id;
  const renamed = defineMemoryBranch(db, { ...definition, path: "toolchain" }, "worker", at).entry_id;
  invalidateMemoryEntry(db, { entry_id: old, reason: "path_moved", successor_id: renamed }, "human", "webui", at);
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

  rejectMemoryProposal(db, { kind: "memory", op: "invalidate", target: { id: old, version }, reason: "environment", replaces: [] }, "question-1", "webui", at);
  expect(listMemoryEntries(db, {})).toEqual(before);

  rejectMemoryProposal(db, { kind: "memory", op: "consolidate", candidate_id: merged, replaces: [{ id: old, version }] }, "question-2", "webui", at);
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
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [], cause: "preference", evidence: "e", round: "after_rca" },
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
