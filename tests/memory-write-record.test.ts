import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import {
  approveMemoryProposal,
  buildMetaReviewMaterial,
  createBehaviorCandidate,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  foldMemory,
  HUMAN_AUTHOR,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listPrecedents,
  moveMemory,
  moveMemoryBranchByMetaReview,
  moveMemoryByMetaReview,
  readMemory,
  recordKnowledge,
  restoreMemoryEntry,
} from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { listEpisodes, projectAndPersist } from "../src/precedent.js";
import { attributeObjections, proposeFromObjection } from "../src/retrospective.js";
import { completeTask, getTask, listBoard, logDecision, registerTask, type Task } from "../src/tasks.js";
import { listLog, raiseObjection, startTriage } from "../src/triage.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { FakeAttributionClient, noRetrospectiveCalls } from "./fakes.js";
import { bundledObjection, HUMAN_WEBUI, toolCall, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";

/** AI の直接適用の書き込みの記録(issue #632 / ADR 0252 決定1〜3)のドメイン層。tool 結果と決定ログ API への写像はサーバ境界
 *  (tests/mcp-memory-write-record.test.ts)が言う。 */
const at = new Date("2026-10-14T00:00:00.000Z");
const worker = { activity: "worker_verb" as const, name: "deckhand" };
const metaReview = { activity: "meta_review" as const, name: "auditor" };

function board() {
  const db = openDb(":memory:");
  const task = (title: string, extra: Partial<Parameters<typeof registerTask>[1]> = {}): Task =>
    registerTask(db, { type: "work", title, purpose: "p", completion_criteria: "c", workspace: "charts", ...extra }, at, ...HUMAN_WEBUI);
  const knowledge = (title: string, scope: string | null = "charts") =>
    recordKnowledge(db, { scope, path: "build/tests", title, text: `${title}.`, source: { commit: "0a46a46" }, author: worker }, "worker", at).entry_id;
  const rows = () => listLog(db).filter((e) => e.payload.kind === "memory_written");
  return { db, task, knowledge, rows };
}

it("worker の record_knowledge は書き手の task に書き込みの記録を1つ追記し、決定ログの1行になる —— 文は盤面が店の event から組み、作ったエントリを持ち、tool 結果の event_id はその記録", () => {
  const { db, task, rows } = board();
  const writer = task("index the tide charts");

  const written = recordKnowledge(
    db,
    { scope: "charts", path: "build/tests", title: "Tests need Node 22", text: "npm test fails on Node 24.", source: { commit: "0a46a46" }, author: worker },
    "worker",
    at,
    writer.id,
  );

  expect(rows()).toEqual([
    expect.objectContaining({
      id: written.event_id,
      task_id: writer.id,
      worker_id: "deckhand",
      payload: { kind: "memory_written", line: `wrote knowledge #${written.entry_id} "Tests need Node 22" at build/tests (charts)`, created: [written.entry_id], invalidated: [] },
    }),
  ]);
});

it("worker の define_memory_branch・RCA の Knowledge・meta-review の define_memory / move_memory / move_memory_branch / invalidate_memory は、それぞれ呼び出し1回で書き手の task に記録を1つ追記する", () => {
  const { db, task, knowledge, rows } = board();
  const worked = task("worked");
  const reviewed = task("memory meta-review", { type: "review", meta_review_subject: "memory" });

  defineMemoryBranch(db, { scope: "charts", path: "build", text: "How the charts build.", author: worker }, "worker", at, worked.id);
  defineMemoryByMetaReview(db, { scope: null, path: "toolchain", text: "Toolchains every workspace shares.", author: metaReview }, "worker", at, reviewed.id);
  moveMemoryByMetaReview(db, { entry_id: knowledge("Moved one"), scope: "charts", path: "build/moved", mover: metaReview }, "worker", at, reviewed.id);
  knowledge("Under the branch");
  moveMemoryBranchByMetaReview(db, { scope: "charts", path: "build/tests", to_scope: "charts", to_path: "build/checks", mover: metaReview }, "worker", at, reviewed.id);
  invalidateMemoryByMetaReview(db, { entry_id: knowledge("Dropped one"), reason: "environment" }, "auditor", "worker", at, reviewed.id);

  // RCA の Knowledge(missing_information の異議を材料にした review 子が as knowledge で書く)
  const objected = task("objected");
  const entry = logDecision(db, objected, "skipped the fixtures", "deckhand", at, "worker");
  const objection = bundledObjection(db, objected.id, entry, at);
  appendEvent(db, {
    taskId: objected.id,
    workerId: BOARD_WORKER_ID,
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: entry, objection_event_ids: [objection], cause: "missing_information", evidence: "e", entries: null, round: "initial" },
    at,
  });
  const rca = task("rca (auditor): objected", { type: "review", parent_id: objected.id, objection_event_ids: [objection] });
  const reasoning = logDecision(db, rca, "the fixture rule was never written down", "auditor", at, "worker");
  proposeFromObjection(db, rca.id, { entry_id: entry, path: "testing", title: "Fixtures", text: "Keep the fixtures.", as: "knowledge", based_on_decision: reasoning }, {}, "auditor", at);

  expect(rows().map((r) => [r.task_id, r.payload.kind === "memory_written" && r.payload.line.split(" ")[0]])).toEqual([
    [worked.id, "wrote"],
    [reviewed.id, "wrote"],
    [reviewed.id, "moved"],
    [reviewed.id, "moved"],
    [reviewed.id, "dropped"],
    [rca.id, "wrote"],
  ]);
});

it("畳み1回は判断1回なので、作成と N 件の無効化が1行の記録になる", () => {
  const { db, task, knowledge, rows } = board();
  const reviewed = task("memory meta-review", { type: "review", meta_review_subject: "memory" });
  const decision = logDecision(db, reviewed, "the two notes say the same", "auditor", at, "worker");
  const [a, b] = [knowledge("Tests need Node 22"), knowledge("Node 24 breaks the tests")];

  const { entry_id } = foldMemory(db, reviewed.id, { scope: "charts", path: "build", title: "Node 22 only", text: "Tests run on Node 22 only.", replaces: [a, b], based_on_decision: decision, author: metaReview }, "worker", at);

  expect(rows().map((r) => r.payload)).toEqual([
    {
      kind: "memory_written",
      line: `wrote knowledge #${entry_id} "Node 22 only" at build (charts); folded #${a} into #${entry_id}; folded #${b} into #${entry_id}`,
      created: [entry_id],
      invalidated: [a, b],
    },
  ]);
});

it("人間の面からの書き込み・移動・無効化・復元と、提案 question の承認・candidate の作成は記録を書かない", () => {
  const { db, knowledge, rows } = board();
  const human = recordKnowledge(db, { scope: "charts", path: "notes", title: "Fridays", text: "Deploys are safe any day.", author: HUMAN_AUTHOR }, "webui", at).entry_id;
  defineMemoryBranch(db, { scope: "charts", path: "notes", text: "Deploy notes.", author: HUMAN_AUTHOR }, "webui", at);
  moveMemory(db, { entry_id: knowledge("Moved by a human"), scope: "charts", path: "elsewhere", mover: HUMAN_AUTHOR }, "webui", at);
  invalidateMemoryEntry(db, { entry_id: human, reason: "environment" }, "human", "webui", at);
  restoreMemoryEntry(db, { entry_id: human, restorer: HUMAN_AUTHOR }, "webui", at);
  const candidate = createBehaviorCandidate(db, { scope: "charts", path: "habits", title: "Small commits", text: "Commit small.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at).entry_id;
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: candidate, replaces: [] }, "question-1", "webui", at);

  expect(rows()).toEqual([]);
});


it("書き込みの行に異議でき、帰責の入力は行の文・書いた本文(無効化なら落とした本文)・その書き込みより前に同じ session で読んだ記憶", async () => {
  const { db, task, knowledge } = board();
  const writer = task("index the tide charts");
  const reviewed = task("memory meta-review", { type: "review", meta_review_subject: "memory" });
  const [read, dropped] = [knowledge("Squash before merge"), knowledge("Rebase before merge")];
  appendEvent(db, { taskId: writer.id, workerId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  readMemory(db, { taskId: writer.id, scope: "charts", agent: "deckhand" }, { ids: [read] }, at);
  const wrote = recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: worker }, "worker", at, writer.id);
  const drop = invalidateMemoryByMetaReview(db, { entry_id: dropped, reason: "capability" }, "auditor", "worker", at, reviewed.id);
  const session = startTriage(db, at);
  raiseObjection(db, wrote.event_id, "the note is wrong", at);
  raiseObjection(db, drop, "that note was right", at);
  const client = new FakeAttributionClient();

  await attributeObjections(db, { ...noRetrospectiveCalls, attributionClient: client }, session.id, at);

  expect(client.calls.map(({ input }) => input)).toEqual([
    {
      entry_id: wrote.event_id,
      entry: `wrote knowledge #${wrote.entry_id} "Squash" at build (charts)`,
      steering: ["the note is wrong"],
      decision_log: [`wrote knowledge #${wrote.entry_id} "Squash" at build (charts)`],
      memory_read: [{ id: read, kind: "knowledge", title: "Squash before merge", text: "Squash before merge." }],
      written: [{ id: wrote.entry_id, kind: "knowledge", title: "Squash", text: "Always squash." }],
    },
    {
      entry_id: drop,
      entry: `dropped #${dropped} (capability)`,
      steering: ["that note was right"],
      decision_log: [`dropped #${dropped} (capability)`],
      memory_read: [],
      written: [{ id: dropped, kind: "knowledge", title: "Rebase before merge", text: "Rebase before merge." }],
    },
  ]);
});

it("書き込みの記録は tool 結果の event id で Episode の memory_write マーカーに結ばれ、異議された書き込みは list_precedents と meta-review の材料の異議つき判断に読んだ記憶つきで載る", async () => {
  const { db, task, knowledge } = board();
  const writer = task("index the tide charts");
  const read = knowledge("Squash before merge");
  const spawned = appendEvent(db, { taskId: writer.id, workerId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  const pull = readMemory(db, { taskId: writer.id, scope: "charts", agent: "deckhand" }, { ids: [read] }, at).event_id;
  const wrote = recordKnowledge(db, { scope: "charts", path: "build", title: "Squash", text: "Always squash.", source: { commit: "0a46a46" }, author: worker }, "worker", at, writer.id);
  const transcriptPath = join(await tempDir("tidepool-write-record-"), `${writer.id}.${spawned}.stream.jsonl`);
  writeFileSync(transcriptPath, [...toolCall(1, "mcp__tidepool__read_memory", pull), ...toolCall(2, "mcp__tidepool__record_knowledge", wrote.event_id)].join("\n"));
  projectAndPersist(db, { workerSpawnedEventId: spawned, transcriptPath });
  bundledObjection(db, writer.id, wrote.event_id, at, "the note is wrong");
  registerMetaReview(db, "memory", at);
  const reviewId = listBoard(db).find((t) => t.meta_review_subject === "memory")!.id;

  expect(listEpisodes(db, {})[0]!.markers).toEqual([
    expect.objectContaining({ kind: "memory", position: 0, eventId: pull }),
    expect.objectContaining({ kind: "memory_write", position: 1, eventId: wrote.event_id, objections: ["the note is wrong"] }),
  ]);
  const objected = {
    task_id: writer.id,
    decision_event_id: wrote.event_id,
    line: `wrote knowledge #${wrote.entry_id} "Squash" at build (charts)`,
    objections: ["the note is wrong"],
    entries_read: [read],
  };
  expect(listPrecedents(db, { taskId: reviewId, agent: "auditor" }, { since_watermark: 0 }, at).precedents).toEqual([expect.objectContaining(objected)]);
  expect(buildMetaReviewMaterial(db, reviewId)!.parts).toMatchObject({ precedents: [objected] });
});

it("meta-review の畳みへの異議は、次の meta-review の材料の異議つき判断と list_precedents に載る —— meta-review 自身の産物は店の変更から外れても、異議された書き込みは届く", async () => {
  const { db, knowledge } = board();
  registerMetaReview(db, "memory", at);
  const first = getTask(db, listBoard(db).find((t) => t.meta_review_subject === "memory")!.id)!;
  const [a, b] = [knowledge("Tests need Node 22"), knowledge("Node 24 breaks the tests")];
  const spawned = appendEvent(db, { taskId: first.id, workerId: "auditor", origin: "board", at, payload: WORKER_SPAWNED });
  const decision = logDecision(db, first, "the two notes say the same", "auditor", at, "worker");
  const fold = foldMemory(db, first.id, { scope: "charts", path: "build", title: "Node 22 only", text: "Node 22 only.", replaces: [a, b], based_on_decision: decision, author: metaReview }, "worker", at);
  const transcriptPath = join(await tempDir("tidepool-write-record-"), `${first.id}.${spawned}.stream.jsonl`);
  writeFileSync(transcriptPath, [...toolCall(1, "mcp__tidepool__log_decision", decision), ...toolCall(2, "mcp__tidepool__fold_memory", fold.event_id)].join("\n"));
  projectAndPersist(db, { workerSpawnedEventId: spawned, transcriptPath });
  completeTask(db, first, { outcome: "no findings" }, "auditor", at, "worker");
  bundledObjection(db, first.id, fold.event_id, at, "those two were different");
  registerMetaReview(db, "memory", at);
  const next = listBoard(db).find((t) => t.meta_review_subject === "memory" && t.id !== first.id)!;

  const objected = { task_id: first.id, decision_event_id: fold.event_id, objections: ["those two were different"] };
  expect(buildMetaReviewMaterial(db, next.id)!.parts).toMatchObject({ precedents: [objected] });
  expect(listPrecedents(db, { taskId: next.id, agent: "auditor" }, {}, at).precedents).toEqual([expect.objectContaining(objected)]);
});
