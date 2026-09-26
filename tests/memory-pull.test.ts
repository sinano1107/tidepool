import { expect, it } from "vitest";
import { draftBehaviorCandidate } from "../src/attribution.js";
import { openDb } from "../src/db.js";
import { appendEvent, getEvent, type TaskScopedPayload } from "../src/events.js";
import {
  approvedMemoryEntries,
  approveMemoryProposal,
  browseMemory,
  createBehaviorCandidate,
  defineMemoryBranch,
  ensureMemoryIndex,
  humanEntryInput,
  invalidateMemoryEntry,
  previewCase,
  readMemory,
  recordExemplar,
  recordKnowledge,
  searchMemory,
} from "../src/memory.js";
import { projectAndPersist } from "../src/precedent.js";
import { DomainError, logDecision, registerTask } from "../src/tasks.js";
import { TriageError } from "../src/triage.js";
import { FakeBehaviorDraftClient } from "./fakes.js";
import { FIXTURE_SPAWNED_EVENT_ID, FIXTURE_TASK, seedFixtureBoard, tempDir, writeFixtureTranscript } from "./harness.js";

const at = new Date("2026-09-14T00:00:00.000Z");
const approve = (db: ReturnType<typeof openDb>, candidate_id: number) =>
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id, replaces: [] }, "question-1", "webui", at);

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
  const define = (path: string, text: string, scope: string | null = "tidepool") =>
    defineMemoryBranch(db, { scope, path, text, author: { activity: "worker_verb", name: "deckhand" } }, "worker", at).entry_id;
  return { db, task, reader, record, define };
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

it("長音符 ー を含むカタカナ語も、それ単独の query で当たる", () => {
  const { db, reader, record } = board();
  record({ title: "boundary", text: "サーバ境界で応答形を言う" });
  expect(searchMemory(db, reader, { query: "サーバ" }, at).results.map((r) => r.title)).toEqual(["boundary"]);
});

it("人間が書いた原文の title にだけある語でも当たる", () => {
  const { db, reader } = board();
  const input = { workspace: "tidepool", path: "notes", title: "Toolchain", text: "Use Node 22.", original_title: "道具立て", original_text: "Node 22 を使う" };
  recordKnowledge(db, humanEntryInput(db, input), "webui", at);
  expect(searchMemory(db, reader, { query: "道具" }, at).results.map((r) => r.title)).toEqual(["Toolchain"]);
});

it.each([
  ["The settings tab is narrow.", "narrow"],
  ["The settings tab is narrow.", "narrow."],
  ["The settings tab is narrow.)", "narrow"],
  ['The tab was called "narrow." by the user', "narrow"],
  ["The settings tab is narrow.", "narrow.)"],
  ["The chart reads tides.csv.", "tides.csv"],
  ["The chart reads data (see tides.csv.)", "tides.csv"],
  ["東京.csv を読む", "csv"],
  ["データ-v2", "v2"],
  ["src/設定.ts", "ts"],
  ["src/設定.ts", "src/設定.ts"],
  ["src/設定.ts", "設定.ts"],
  ["設定 画面", "設定_画面"],
])("語の先頭・末尾の . - _ は隣が空白・文字列の端・括弧や引用符・CJK でも索引と query の両方で落とすので、text %j の leaf は query %j で当たる", (text, query) => {
  const { db, reader, record } = board();
  record({ title: "hit", text });
  record({ title: "other", text: "Unrelated note." });
  expect(searchMemory(db, reader, { query }, at).results.map((r) => r.title)).toEqual(["hit"]);
});

it.each([
  ["The chart reads tides.csv.", "csv"],
  ["Use foo__bar here", "foobar"],
  ["Pin v1..2 now", "v12"],
  ["Visit the cafe\u0301.x page", "cafe\u0301x"],
])("語中の . - _ は連なりでも結合文字の隣でも残るので、text %j の leaf は query %j では当たらない", (text, query) => {
  const { db, reader, record } = board();
  record({ title: "leaf", text });
  expect(searchMemory(db, reader, { query }, at).results).toEqual([]);
});

it("search は英語の stopword を query から落として AND で当て、stopword と記号だけの query は memory_pulled を残さず DomainError になる", () => {
  const { db, reader, record } = board();
  record({ title: "Settings tab is the admin surface", text: "Admin settings live in one tab." });
  record({ title: "Deploy to the Pi", text: "Run deploy-pi on the Pi." });
  const before = searchMemory(db, reader, { query: "settings" }, at).event_id;

  expect(() => searchMemory(db, reader, { query: "The, —" }, at)).toThrow(DomainError);
  const hit = searchMemory(db, reader, { query: "the settings tab" }, at);
  expect(hit.results.map((r) => r.title)).toEqual(["Settings tab is the admin surface"]);
  expect(hit.event_id).toBe(before + 1);
});

it("INDEX は prefix 直下の子だけ —— sub-prefix の名前と定義(未定義は null)、その path に置かれた leaf の id + title", () => {
  const { db, reader, record, define } = board();
  define("build/tests", "How the test suite runs.");
  const node = record({ path: "build", title: "Build uses tsc" });
  record({ path: "build/tests", title: "Tests need Node 22" });
  record({ path: "build/tests/e2e", title: "E2E uses Playwright" });
  record({ path: "build/lint", title: "Lint is biome" });
  record({ path: "deploy", title: "Deploy to the Pi" });

  expect(browseMemory(db, reader, {}, at)).toMatchObject({
    children: [
      { name: "build", definition: null },
      { name: "deploy", definition: null },
    ],
    entries: [],
    truncated: false,
  });
  expect(browseMemory(db, reader, { prefix: "build" }, at)).toMatchObject({
    children: [
      { name: "build/lint", definition: null },
      { name: "build/tests", definition: "How the test suite runs." },
    ],
    entries: [{ id: node, title: "Build uses tsc" }],
    truncated: false,
  });
});

it("定義だけの枝も子として出て、定義は親の子一覧でもその枝自身でも leaf に数えられない", () => {
  const { db, reader, define } = board();
  define("runbooks", "Step-by-step procedures for operating the board.");
  define("runbooks/deploy", "How a release reaches the Pi.");

  expect(browseMemory(db, reader, {}, at)).toMatchObject({
    children: [{ name: "runbooks", definition: "Step-by-step procedures for operating the board." }],
    entries: [],
  });
  expect(browseMemory(db, reader, { prefix: "runbooks" }, at)).toMatchObject({
    children: [{ name: "runbooks/deploy", definition: "How a release reaches the Pi." }],
    entries: [],
  });
  expect(browseMemory(db, reader, { prefix: "runbooks/deploy" }, at)).toMatchObject({ children: [], entries: [] });
});

it("同じ枝に workspace と盤面全体の定義があれば workspace が勝ち、影の盤面全体の定義は browse に出ないが read / search では見える", () => {
  const { db, reader, define } = board();
  const shadowed = define("build", "Board-wide build conventions.", null);
  define("build", "How this workspace is built.");
  define("deploy", "Board-wide deploy conventions.", null);

  expect(browseMemory(db, reader, {}, at)).toMatchObject({
    children: [
      { name: "build", definition: "How this workspace is built." },
      { name: "deploy", definition: "Board-wide deploy conventions." },
    ],
  });
  expect(readMemory(db, reader, { ids: [shadowed] }, at).entries.map((e) => e.text)).toEqual(["Board-wide build conventions."]);
  expect(searchMemory(db, reader, { query: "build" }, at).results.map((r) => r.id)).toContain(shadowed);
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
  approve(db, elsewhere);
  approve(db, addressed);
  const all = [shown, boardWide, other, invalidated, candidate, elsewhere, addressed];
  const expected = [shown, boardWide, addressed];

  expect(browseMemory(db, reader, { prefix: "tide" }, at).entries.map((e) => e.id)).toEqual(expected);
  expect(searchMemory(db, reader, { query: "tide" }, at).results.map((e) => e.id).sort()).toEqual(expected);
  expect(readMemory(db, reader, { ids: all }, at).entries.map((e) => e.id)).toEqual(expected);
});

/** #386 のフィクスチャの session(worker_spawned 5、decision 6・7・8、完了 9)を投影した盤面と、その task の reader。 */
async function projectedBoard() {
  const db = seedFixtureBoard("## Outcome\nCreated notes.md.");
  projectAndPersist(db, {
    workerSpawnedEventId: FIXTURE_SPAWNED_EVENT_ID,
    transcriptPath: writeFixtureTranscript(await tempDir("tidepool-case-"), `${FIXTURE_TASK}.${FIXTURE_SPAWNED_EVENT_ID}.stream.jsonl`),
  });
  return { db, reader: { taskId: FIXTURE_TASK, scope: "sandbox", agent: "tako" } };
}

const approvedBehavior = (db: ReturnType<typeof openDb>, title: string, source?: { event_id: number }) => {
  const id = createBehaviorCandidate(
    db,
    { scope: "sandbox", path: "notes", title, text: "Keep notes short.", addressee: null, source, author: { activity: source ? "rca" : "human", name: "auditor" } },
    "board",
    at,
  ).entry_id;
  approve(db, id);
  return id;
};

const FIXTURE_RESULT = "Created notes.md with 3 bullets on tide pools; logged 3 decisions (2 identical); used 1 subagent and 1 advisor consult.";

it("RCA が起草した Behavior の read は、帰責 event から辿った異議の decision 本文・その entry への異議の steering(event 順)・その session の handoff と result を case に持つ", async () => {
  const { db, reader } = await projectedBoard();
  const objection = (entry_id: number, comment: string) =>
    appendEvent(db, { taskId: FIXTURE_TASK, workerId: "human", origin: "webui", payload: { kind: "objection_raised", entry_id, comment, session_id: 1 }, at });
  const first = objection(6, "three bullets is too few");
  objection(8, "not about this entry");
  const second = objection(6, "cover the tide cycle too");
  const attributed = appendEvent(db, {
    taskId: FIXTURE_TASK,
    workerId: "board",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: 6, objection_event_ids: [first, second], cause: "capability", evidence: "e", round: "initial" },
    at,
  });
  const id = approvedBehavior(db, "Cover the topic", { event_id: attributed });
  // 完了 entry は decision マーカーを持たないので、その完了を記録した session から handoff / result を引く
  const completion = approvedBehavior(db, "Report the outcome", { event_id: 9 });

  expect(readMemory(db, reader, { ids: [id, completion] }, at).entries.map((e) => e.case)).toEqual([
    {
      decision: "kept the note to three bullets",
      steering: ["three bullets is too few", "cover the tide cycle too"],
      handoff: "## Outcome\nCreated notes.md.",
      result: FIXTURE_RESULT,
    },
    { decision: `completion report: ${FIXTURE_RESULT}`, steering: [], handoff: "## Outcome\nCreated notes.md.", result: FIXTURE_RESULT },
  ]);
});

/** 同じ entry 6 に session 1 と session 2 から異議を積み、session 2 で帰責した盤面(#958)。 */
async function objectedInTwoSessions() {
  const { db, reader } = await projectedBoard();
  const objection = (comment: string, session_id: number) =>
    appendEvent(db, { taskId: FIXTURE_TASK, workerId: "human", origin: "webui", payload: { kind: "objection_raised", entry_id: 6, comment, session_id }, at });
  objection("three bullets is too few", 1);
  const second = objection("cover the tide cycle too", 2);
  const payload = { kind: "objection_attributed" as const, entry_id: 6, objection_event_ids: [second], cause: "preference" as const, evidence: "e", round: "initial" as const };
  const attributed = appendEvent(db, { taskId: FIXTURE_TASK, workerId: "board", origin: "board", payload, at });
  return { db, reader, attribution: { id: attributed, ...payload } };
}

it("2つ目の session の帰責を出所に持つ Behavior の case の steering は、その session の異議だけで、同じ帰責の AttributionInput.steering と一致する", async () => {
  const { db, reader, attribution } = await objectedInTwoSessions();
  const behaviorDraftClient = new FakeBehaviorDraftClient();
  await draftBehaviorCandidate(db, { behaviorDraftClient, workspace: { name: "sandbox" } }, attribution, at);
  const id = approvedBehavior(db, "Cover the topic", { event_id: attribution.id });

  const steering = (readMemory(db, reader, { ids: [id] }, at).entries[0]?.case as { steering: string[] } | undefined)?.steering;
  expect(steering).toEqual(["cover the tide cycle too"]);
  expect(behaviorDraftClient.calls.map((c) => c.input.steering)).toEqual([steering]);
});

it("帰責の objection_event_ids に objection_raised でない id があると、帰責の入力を組む段で例外になり起草は撃たれない", async () => {
  const { db, attribution } = await objectedInTwoSessions();
  const behaviorDraftClient = new FakeBehaviorDraftClient();

  await expect(
    draftBehaviorCandidate(db, { behaviorDraftClient, workspace: { name: "sandbox" } }, { ...attribution, objection_event_ids: [6] }, at),
  ).rejects.toThrow(TriageError);
  expect(behaviorDraftClient.calls).toEqual([]);
});

it("decision entry を直接出所に持つ Behavior の case の steering は、全 session の異議を event 順に並べたもの", async () => {
  const { db, reader } = await objectedInTwoSessions();
  const id = approvedBehavior(db, "Cover the topic", { event_id: 6 });

  expect(readMemory(db, reader, { ids: [id] }, at).entries[0]?.case).toMatchObject({
    steering: ["three bullets is too few", "cover the tide cycle too"],
  });
});

it("worker_spawned を出所に持つ Behavior の case は、その session の decision 列(event id 順)・handoff・result", async () => {
  const { db, reader } = await projectedBoard();
  const id = approvedBehavior(db, "Session", { event_id: FIXTURE_SPAWNED_EVENT_ID });

  expect(readMemory(db, reader, { ids: [id] }, at).entries[0]?.case).toEqual({
    decisions: ["kept the note to three bullets", "kept the note to three bullets", "subagent reported notes.md word count as 62"],
    handoff: "## Outcome\nCreated notes.md.",
    result: FIXTURE_RESULT,
  });
});

it("人間が書いた Behavior(出所 = 自身の作成 event)と Knowledge の case は null", async () => {
  const { db, reader } = await projectedBoard();
  const human = approvedBehavior(db, "Human");
  const knowledge = recordKnowledge(
    db,
    { scope: "sandbox", path: "notes", title: "k", text: "x", source: { event_id: 6 }, author: { activity: "worker_verb", name: "tako" } },
    "worker",
    at,
  ).entry_id;

  expect(readMemory(db, reader, { ids: [human, knowledge] }, at).entries.map((e) => e.case)).toEqual([null, null]);
});

it("episode 行の無い session の decision / 完了 entry の case も、events から その session の handoff と result を持つ", () => {
  const db = seedFixtureBoard("## Outcome\nCreated notes.md.");
  const decision = approvedBehavior(db, "Unprojected", { event_id: 6 });
  const completion = approvedBehavior(db, "Unprojected completion", { event_id: 9 });

  expect(readMemory(db, { taskId: FIXTURE_TASK, scope: "sandbox", agent: "tako" }, { ids: [decision, completion] }, at).entries.map((e) => e.case)).toEqual([
    { decision: "kept the note to three bullets", steering: [], handoff: "## Outcome\nCreated notes.md.", result: FIXTURE_RESULT },
    { decision: `completion report: ${FIXTURE_RESULT}`, steering: [], handoff: "## Outcome\nCreated notes.md.", result: FIXTURE_RESULT },
  ]);
});

it("episode 行の無い同じ task の複数 session は、それぞれの窓の decision(event id 順)と完了だけを case に持ち、前後の session と混ざらない", () => {
  const db = seedFixtureBoard("## Outcome\nCreated notes.md.");
  const append = (payload: TaskScopedPayload) => appendEvent(db, { taskId: FIXTURE_TASK, workerId: "tako", origin: "worker", payload, at });
  const spawned: TaskScopedPayload = {
    kind: "worker_spawned",
    registry_commit: "commit",
    definition_version: "1",
    advisor: null,
    provider: "openai",
    model: "gpt",
    effort: "high",
    source: { tier: "task", provider: "only" },
    harness: "codex",
    cli_version: "1",
  };
  // 2つ目の session: decision を書かずに exit
  const silent = append(spawned);
  append({ kind: "worker_exited", exit_code: 1, signal: null, stderr_tail: null, worker_spawned_event_id: silent, usage: null });
  // 3つ目の session: decision を書いたが完了していない(exit も無い)
  const open = append(spawned);
  const retried = append({ kind: "decision_logged", line: "retried with a shorter note" });
  const ids = [FIXTURE_SPAWNED_EVENT_ID, silent, open, retried].map((ref) => approvedBehavior(db, `Session ${ref}`, { event_id: ref }));

  expect(readMemory(db, { taskId: FIXTURE_TASK, scope: "sandbox", agent: "tako" }, { ids }, at).entries.map((e) => e.case)).toEqual([
    {
      decisions: ["kept the note to three bullets", "kept the note to three bullets", "subagent reported notes.md word count as 62"],
      handoff: "## Outcome\nCreated notes.md.",
      result: FIXTURE_RESULT,
    },
    { decisions: [], handoff: null, result: null },
    { decisions: ["retried with a shorter note"], handoff: null, result: null },
    { decision: "retried with a shorter note", steering: [], handoff: null, result: null },
  ]);
});

const fixtureExemplar = (db: ReturnType<typeof openDb>, source_event_id: number, annotations: unknown[]) =>
  recordExemplar(db, humanEntryInput(db, { workspace: "sandbox", path: "notes", title: `Case ${source_event_id}`, addressee: null, source_event_id, annotations }), "webui", at).entry_id;

it("Exemplar の read は annotations(原文を除く)と、出所の decision entry / session から描いた case を返す(ADR 0153 決定3)", () => {
  const db = seedFixtureBoard("## Outcome\nCreated notes.md.");
  const avoid = { anchor: { field: "decision", quote: "three bullets" }, polarity: "avoid", text: "Three bullets is too thin for a topic note." };
  const fromSession = [{ anchor: { field: "handoff", quote: "Created notes.md" }, polarity: "imitate", text: "State the outcome first in the handoff." }];
  const ids = [fixtureExemplar(db, 6, [{ ...avoid, original: "3点では薄い" }]), fixtureExemplar(db, FIXTURE_SPAWNED_EVENT_ID, fromSession)];

  const { entries } = readMemory(db, { taskId: FIXTURE_TASK, scope: "sandbox", agent: "tako" }, { ids }, at);
  // 原文は worker に渡らない(ADR 0015)
  expect(entries[0]?.annotations).toEqual([avoid]);
  expect(entries).toMatchObject([
    {
      case: { decision: "kept the note to three bullets", steering: [], handoff: "## Outcome\nCreated notes.md.", result: FIXTURE_RESULT },
    },
    {
      annotations: fromSession,
      case: {
        decisions: ["kept the note to three bullets", "kept the note to three bullets", "subagent reported notes.md word count as 62"],
        handoff: "## Outcome\nCreated notes.md.",
        result: FIXTURE_RESULT,
      },
    },
  ]);
});

it("search_memory は Exemplar に注釈の text で当たる", () => {
  const db = seedFixtureBoard();
  const id = fixtureExemplar(db, 6, [{ anchor: "whole", polarity: "avoid", text: "Cover the tide cycle before the bullets." }]);
  expect(searchMemory(db, { taskId: FIXTURE_TASK, scope: "sandbox", agent: "tako" }, { query: "tide cycle" }, at).results.map((e) => e.id)).toEqual([id]);
});

it("case preview は事例に選べる event id(decision entry / session)の描画を返し、他の event は domain error", () => {
  const db = seedFixtureBoard("## Outcome\nCreated notes.md.");
  expect(previewCase(db, 6)).toEqual({ decision: "kept the note to three bullets", steering: [], handoff: "## Outcome\nCreated notes.md.", result: FIXTURE_RESULT });
  expect(previewCase(db, FIXTURE_SPAWNED_EVENT_ID)).toMatchObject({ decisions: expect.any(Array), handoff: "## Outcome\nCreated notes.md." });
  expect(() => previewCase(db, 9)).toThrow(DomainError);
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
  approve(db, elsewhere);
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

it("browse の children も page 単位で切られ、2 ページ目に残りが出る", () => {
  const { db, reader, record } = board();
  const names = Array.from({ length: 25 }, (_, i) => `wide/c${String(i).padStart(2, "0")}`);
  for (const name of names) record({ path: name, title: name });

  const first = browseMemory(db, reader, { prefix: "wide" }, at);
  expect(first.truncated).toBe(true);
  expect(first.children.map((c) => c.name)).toEqual(names.slice(0, 20));

  const second = browseMemory(db, reader, { prefix: "wide", page: 2 }, at);
  expect(second.truncated).toBe(false);
  expect(second.children.map((c) => c.name)).toEqual(names.slice(20));
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

  // setup のみ: 前処理の版が古い店を模して、rebuild の唯一の入口(boot の照合)を通す
  db.prepare("UPDATE memory_index_version SET preprocess_version = 'cjk-bigram-0'").run();
  const eventId = ensureMemoryIndex(db, at);

  expect(storeView(db, reader)).toEqual(before);
  expect(before.candidates).toMatchObject({ candidates: expect.arrayContaining([{ id: old, dropped: "invalidated" }]) });
  expect(() => invalidateMemoryEntry(db, { entry_id: old, reason: "environment" }, "human", "webui", at)).toThrow(/already invalidated/);
  expect(getEvent(db, eventId!)).toMatchObject({
    task_id: null,
    payload: { kind: "memory_index_rebuilt", tokenizer: "unicode61 tokenchars '_-.'", preprocess_version: "cjk-bigram-5" },
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
