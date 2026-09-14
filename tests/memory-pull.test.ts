import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getEvent } from "../src/events.js";
import {
  approvedMemoryEntries,
  browseMemory,
  createBehaviorCandidate,
  ensureMemoryIndex,
  invalidateMemoryEntry,
  readMemory,
  rebuildMemoryIndex,
  recordKnowledge,
  searchMemory,
} from "../src/memory.js";
import { logDecision, registerTask } from "../src/tasks.js";

const at = new Date("2026-09-14T00:00:00.000Z");

function board() {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at);
  const reader = { taskId: task.id, scope: "tidepool", agent: "deckhand" };
  const record = (over: { path?: string; title?: string; text?: string; scope?: string | null }) =>
    recordKnowledge(
      db,
      {
        scope: "tidepool",
        path: "notes",
        title: "t",
        text: "x",
        source: { commit: "0a46a46" },
        author: { activity: "worker_verb", name: "deckhand" },
        ...over,
      },
      "worker",
      at,
    ).entry_id;
  return { db, task, reader, record };
}

it.each([
  ["派生", "derived"],
  ["索引 記録", "derived"],
  ["src/tasks.ts", "tasks"],
  ["tasks.ts", "tasks"],
  ["merge-back", "landing"],
  ["ADR 0109", "landing"],
])("#357 の実測表の query %s は、CJK bigram + unicode61 の索引で当たる", (query, title) => {
  const { db, reader, record } = board();
  record({ title: "derived", text: "盤面の記録から派生した索引である" });
  record({ title: "tasks", text: "tasks テーブルへの直接 SQL は src/tasks.ts に残す" });
  record({ title: "landing", text: "The landing runs after merge-back (ADR 0109)" });
  expect(searchMemory(db, reader, { query }, at).results.map((r) => r.title)).toEqual([title]);
});

it("INDEX は prefix 直下の子だけ —— sub-prefix の名前と、その path に置かれた leaf の id + title", () => {
  const { db, reader, record } = board();
  const node = record({ path: "build", title: "Build uses tsc" });
  record({ path: "build/tests", title: "Tests need Node 22" });
  record({ path: "build/tests/e2e", title: "E2E uses Playwright" });
  record({ path: "build/lint", title: "Lint is biome" });
  record({ path: "deploy", title: "Deploy to the Pi" });

  expect(browseMemory(db, reader, {}, at)).toMatchObject({ prefixes: ["build", "deploy"], entries: [], truncated: false });
  expect(browseMemory(db, reader, { prefix: "build" }, at)).toMatchObject({
    prefixes: ["build/lint", "build/tests"],
    entries: [{ id: node, title: "Build uses tsc" }],
    truncated: false,
  });
});

it("read は本文・path・出所の参照と、参照の型から導いた出所の種別(commit / event = fact、decision = inference)を返す", () => {
  const { db, task, reader, record } = board();
  const fact = record({ path: "build", title: "Build uses tsc", text: "The build runs tsc." });
  const decision = logDecision(db, task, "chose tsc over esbuild", "deckhand", at);
  const inference = recordKnowledge(
    db,
    {
      scope: null,
      path: "build",
      title: "esbuild was slower",
      text: "esbuild was judged slower here.",
      source: { event_id: decision },
      author: { activity: "worker_verb", name: "deckhand" },
    },
    "worker",
    at,
  ).entry_id;

  expect(readMemory(db, reader, { ids: [inference, fact] }, at)).toMatchObject({
    entries: [
      { id: fact, title: "Build uses tsc", path: "build", text: "The build runs tsc.", source_kind: "fact", source: { kind: "commit", ref: "0a46a46" } },
      { id: inference, title: "esbuild was slower", path: "build", text: "esbuild was judged slower here.", source_kind: "inference", source: { kind: "decision", ref: decision } },
    ],
  });
});

it("無効化済み・candidate・宛先外・他 workspace のエントリは INDEX / search / read のどれにも出ない", () => {
  const { db, reader, record } = board();
  const shown = record({ path: "tide", title: "tide shown", text: "tide chart" });
  const boardWide = record({ path: "tide", title: "tide board-wide", text: "tide chart", scope: null });
  const other = record({ path: "tide", title: "tide other workspace", text: "tide chart", scope: "sandbox" });
  const invalidated = record({ path: "tide", title: "tide invalidated", text: "tide chart" });
  invalidateMemoryEntry(db, { entry_id: invalidated, reason: "environment" }, "human", "webui", at);
  const behavior = (addressee: string) =>
    createBehaviorCandidate(
      db,
      { scope: "tidepool", path: "tide", title: `tide for ${addressee}`, text: "tide chart", addressee, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
      "board",
      at,
    ).entry_id;
  const candidate = behavior("deckhand");
  const elsewhere = behavior("someone-else");
  const addressed = behavior("deckhand");
  // setup のみ: Behavior の承認経路は #358 が置くので、宛先の効き目を見るために行を approved にする
  db.prepare("UPDATE memory_entries SET state = 'approved', version = id WHERE id IN (?, ?)").run(elsewhere, addressed);
  const all = [shown, boardWide, other, invalidated, candidate, elsewhere, addressed];
  const expected = [shown, boardWide, addressed];

  expect(browseMemory(db, reader, { prefix: "tide" }, at).entries.map((e) => e.id)).toEqual(expected);
  expect(searchMemory(db, reader, { query: "tide" }, at).results.map((e) => e.id).sort()).toEqual(expected);
  expect(readMemory(db, reader, { ids: all }, at).entries.map((e) => e.id)).toEqual(expected);
});

it("pull は1回ごとに task 帰属の memory_pulled を残す —— verb・入力・返した id・その時点の memory 系 event の最大 id(watermark)", () => {
  const { db, task, reader, record } = board();
  const first = record({ path: "build", title: "Build uses tsc" });
  const second = record({ path: "build/tests", title: "Tests need Node 22" });
  const browse = browseMemory(db, reader, { prefix: "build" }, at);
  // pull 自身は店を変えないので watermark を動かさない
  const read = readMemory(db, reader, { ids: [second, 999] }, at);

  expect(getEvent(db, browse.event_id)).toMatchObject({
    task_id: task.id,
    worker_id: "deckhand",
    origin: "worker",
    payload: { kind: "memory_pulled", verb: "browse_memory", input: { prefix: "build" }, returned_ids: [first], watermark: second },
  });
  expect(getEvent(db, read.event_id)?.payload).toEqual({
    kind: "memory_pulled",
    verb: "read_memory",
    input: { ids: [second, 999] },
    returned_ids: [second],
    watermark: second,
  });
});

it("search の memory_pulled は FTS の順位どおりの候補と、返さなかった理由(宛先で外れた / 無効化済み / 上限で溢れた)を持つ", () => {
  const { db, reader, record } = board();
  const invalidated = record({ title: "tide invalidated", text: "tide tide tide tide" });
  invalidateMemoryEntry(db, { entry_id: invalidated, reason: "capability" }, "human", "webui", at);
  const elsewhere = createBehaviorCandidate(
    db,
    { scope: "tidepool", path: "notes", title: "tide for someone else", text: "tide tide tide", addressee: "someone-else", source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "board",
    at,
  ).entry_id;
  // setup のみ: Behavior の承認経路は #358
  db.prepare("UPDATE memory_entries SET state = 'approved', version = id WHERE id = ?").run(elsewhere);
  const pages = Array.from({ length: 21 }, (_, i) => record({ title: `tide ${i}`, text: `tide and ${"filler ".repeat(i + 1)}` }));

  const search = searchMemory(db, reader, { query: "tide" }, at);

  expect(search.truncated).toBe(true);
  expect(search.results.map((r) => r.id)).toEqual(pages.slice(0, 20));
  expect(getEvent(db, search.event_id)?.payload).toEqual({
    kind: "memory_pulled",
    verb: "search_memory",
    input: { query: "tide" },
    returned_ids: pages.slice(0, 20),
    watermark: pages[20],
    candidates: [
      { id: invalidated, dropped: "invalidated" },
      { id: elsewhere, dropped: "addressee" },
      ...pages.slice(0, 20).map((id) => ({ id, dropped: null })),
      { id: pages[20], dropped: "page_limit" },
    ],
  });
  expect(searchMemory(db, reader, { query: "tide", page: 2 }, at)).toMatchObject({ results: [{ id: pages[20] }], truncated: false });
});

/** 読取面の export で見た店の姿(版つきの approved 集合、INDEX、search の順位と候補)。 */
function storeView(db: ReturnType<typeof openDb>, reader: { taskId: string; scope: string | null; agent: string }) {
  const { event_id: _b, ...index } = browseMemory(db, reader, { prefix: "build" }, at);
  const { event_id: search, ...results } = searchMemory(db, reader, { query: "派生 tsc" }, at);
  const { watermark: _w, ...candidates } = getEvent(db, search)!.payload as object as { watermark: number };
  return { approved: approvedMemoryEntries(db), index, results, candidates };
}

it("rebuild はエントリ表と FTS を events から作り直し、無効化済みの行も含めて rebuild 前と同じ店に戻して memory_index_rebuilt を残す", () => {
  const { db, reader, record } = board();
  const old = record({ path: "build", title: "old tsc", text: "派生した tsc の設定" });
  const successor = record({ path: "build", title: "new tsc", text: "派生した tsc の設定" });
  record({ path: "build/tests", title: "tests", text: "tsc 派生" });
  invalidateMemoryEntry(db, { entry_id: old, reason: "superseded", successor_id: successor }, "human", "webui", at);
  const before = storeView(db, reader);

  const eventId = rebuildMemoryIndex(db, "human", "mcp", at);

  expect(storeView(db, reader)).toEqual(before);
  expect(before.candidates).toMatchObject({ candidates: expect.arrayContaining([{ id: old, dropped: "invalidated" }]) });
  expect(() => invalidateMemoryEntry(db, { entry_id: old, reason: "environment" }, "human", "webui", at)).toThrow(/already invalidated/);
  expect(getEvent(db, eventId)).toMatchObject({
    task_id: null,
    worker_id: "human",
    origin: "mcp",
    payload: { kind: "memory_index_rebuilt", tokenizer: "unicode61 tokenchars '_-.'", preprocess_version: "cjk-bigram-1" },
  });
});

it("店に刻まれた tokenizer id が今の版と違えば、open 後の照合が rebuild を走らせ event を残す —— 一致していれば何もしない", () => {
  const { db, reader, record } = board();
  record({ path: "build", title: "tsc", text: "派生した設定" });
  expect(ensureMemoryIndex(db, at)).toBeNull();

  // setup のみ: 前の tokenizer で作られた店を模す
  db.prepare("UPDATE memory_index_version SET tokenizer = 'trigram'").run();
  db.prepare("DELETE FROM memory_fts").run();
  const eventId = ensureMemoryIndex(db, at);

  expect(getEvent(db, eventId!)).toMatchObject({ task_id: null, worker_id: "tidepool", origin: "board", payload: { kind: "memory_index_rebuilt" } });
  expect(searchMemory(db, reader, { query: "派生" }, at).results.map((r) => r.title)).toEqual(["tsc"]);
  expect(ensureMemoryIndex(db, at)).toBeNull();
});
