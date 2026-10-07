import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { getEvent, listEventsOfKinds } from "../src/events.js";
import {
  approveMemoryProposal,
  buildMetaReviewMaterial,
  createBehaviorCandidate,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  foldMemory,
  humanEntryInput,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listPrecedents,
  moveMemory,
  moveMemoryByMetaReview,
  proposeMemoryChange,
  pullMemoryBranches,
  pullMemoryList,
  pullMemoryProposals,
  recordKnowledge,
  recordMetaReviewMaterial,
  rejectMemoryProposal,
} from "../src/memory.js";
import { type MetaReviewSubject, registerMetaReview } from "../src/meta-review.js";
import { EXTRACTOR_VERSION } from "../src/precedent.js";
import { getTask, logDecision, type MemoryProposal, registerTask } from "../src/tasks.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { answerQuestionViaWebui, bundledObjection, failureQuestion, HUMAN_WEBUI } from "./harness.js";

/** memory meta-review の材料の節(ADR 0180 決定1・2)のドメイン層。spawn の prompt に入ることは両 adapter のテストが言う。 */
const at = new Date("2026-10-01T00:00:00.000Z");

/** 主題の meta-review を登録し、その task の id を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, subject: MetaReviewSubject, done = false): string {
  registerMetaReview(db, subject, at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return taskId;
}

/** 主題 memory の材料の節(型を memory の部分に絞る)。 */
function memoryMaterialOf(db: Db, taskId: string) {
  const material = buildMetaReviewMaterial(db, taskId);
  if (material?.subject !== "memory") throw new Error(`no memory material for ${taskId}`);
  return material;
}

it("材料の節は主題 memory の meta-review に memory の部分で組まれ、両端の watermark と5つの部分の見出しを持ち、材料の無い部分は空と書く —— 普通の task には null、主題 routing の meta-review には routing の部分(ADR 0180 追記 #1239)", () => {
  const db = openDb(":memory:");
  const previous = register(db, "memory", true);
  const review = register(db, "memory");
  const [first, second] = listEventsOfKinds(db, ["meta_review_registered"]).map((e) => e.payload.material_watermark);

  const material = memoryMaterialOf(db, review);

  expect(previous).not.toBe(review);
  expect([material.previous_watermark, material.material_watermark]).toEqual([first, second]);
  for (const line of [
    `after event ${first} up to and including event ${second}`,
    "### Store changes",
    "(no store changes)",
    "### Live candidates",
    "(no live candidates)",
    "### Objected decisions",
    "(no objected decisions)",
    "### Settled proposals",
    "(no settled proposals)",
    "### Branches",
    "(no branches)",
  ]) {
    expect(material.section).toContain(line);
  }
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  expect(buildMetaReviewMaterial(db, work)).toBeNull();
  expect(buildMetaReviewMaterial(db, register(db, "routing"))?.subject).toBe("routing");
});

const deckhand = { activity: "worker_verb" as const, name: "deckhand" };
const metaReview = { activity: "meta_review" as const, name: "auditor" };
const human = { activity: "human" as const, name: HUMAN_WORKER_ID };
const knowledge = (db: Db, path: string, author: { activity: "worker_verb" | "human"; name: string } = deckhand) =>
  recordKnowledge(db, { scope: "tidepool", path, title: path, text: `${path}.`, ...(author === deckhand ? { source: { commit: "0a46a46" } } : {}), author }, "worker", at).entry_id;
const candidate = (db: Db, title: string) =>
  createBehaviorCandidate(db, { scope: null, path: "habits", title, text: `${title}.`, addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at).entry_id;
const ids = (rows: Array<{ id: number }>) => rows.map((row) => row.id);

it("店の変更: 前回の登録より後に worker が書いた Knowledge と人間が落としたエントリが変更つきで載り、前の review の直接の書き込み・移動・畳み・無効化と、提案への回答が刻んだエントリと、窓の外のエントリは載らない", () => {
  const db = openDb(":memory:");
  const before = knowledge(db, "before");
  const toDrop = knowledge(db, "to-drop");
  const toFold = knowledge(db, "to-fold");
  const toMove = knowledge(db, "to-move");
  const toRetire = knowledge(db, "to-retire");
  const toAmend = candidate(db, "Short notes");
  const previous = register(db, "memory", true);

  const written = knowledge(db, "written");
  invalidateMemoryEntry(db, { entry_id: toDrop, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  const decision = logDecision(db, getTask(db, previous)!, "these say the same", "auditor", at, "worker");
  defineMemoryByMetaReview(db, { scope: null, path: "build", text: "How it builds.", author: metaReview }, "worker", at);
  foldMemory(db, previous, { scope: "tidepool", path: "folded", title: "Folded", text: "Folded.", replaces: [toFold], based_on_decision: decision, author: metaReview }, "worker", at);
  moveMemoryByMetaReview(db, { entry_id: toMove, scope: "tidepool", path: "moved", mover: metaReview }, "worker", at);
  invalidateMemoryByMetaReview(db, { entry_id: toRetire, reason: "environment" }, "auditor", "worker", at);
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: toAmend, replaces: [] }, "question-1", "webui", at, { text: "Keep notes to one line." });
  const review = register(db, "memory");
  knowledge(db, "after");

  const { parts, section } = memoryMaterialOf(db, review);

  expect(parts.store_changes.map(({ id, changes, invalidation_reason }) => ({ id, changes, invalidation_reason }))).toEqual([
    { id: toDrop, changes: ["invalidated"], invalidation_reason: "environment" },
    { id: written, changes: ["created"], invalidation_reason: null },
  ]);
  expect(ids(parts.store_changes)).not.toContain(before);
  expect(parts.store_changes[1]).not.toHaveProperty("original");
  expect(section).toContain(JSON.stringify(parts.store_changes[1]));
});

it("店の変更: 人間が移したエントリは複製の行だけで path_moved の旧は載らず、人間が編集(supersede)したエントリは新しい行が載る —— 置き換えられた旧は無効化の行として並ぶ。窓の中に書かれて前の review が移したエントリは、複製の行に作成の変更を添える", () => {
  const db = openDb(":memory:");
  const moved = knowledge(db, "moved");
  const edited = knowledge(db, "edited");
  register(db, "memory", true);

  const copy = moveMemory(db, { entry_id: moved, scope: null, path: "elsewhere", mover: human }, "webui", at).entry_id;
  const edit = recordKnowledge(db, { ...humanEntryInput(db, { workspace: "tidepool", path: "edited", title: "edited", text: "Edited." }), supersedes: [edited] }, "webui", at).entry_id;
  const fresh = knowledge(db, "fresh");
  const freshCopy = moveMemoryByMetaReview(db, { entry_id: fresh, scope: "tidepool", path: "settled", mover: metaReview }, "worker", at).entry_id;
  const review = register(db, "memory");

  const { parts } = memoryMaterialOf(db, review);

  expect(parts.store_changes.map(({ id, changes, invalidation_reason }) => ({ id, changes, invalidation_reason }))).toEqual([
    { id: edited, changes: ["invalidated"], invalidation_reason: "superseded" },
    { id: copy, changes: ["created"], invalidation_reason: null },
    { id: edit, changes: ["created"], invalidation_reason: null },
    { id: freshCopy, changes: ["created"], invalidation_reason: null },
  ]);
});

it("店の変更に candidate は載らない —— 前回より後に起草された candidate も前からある candidate も、生きていれば candidate の部分に list_memory_candidates の行で載る", () => {
  const db = openDb(":memory:");
  const older = candidate(db, "Older habit");
  const reader = { taskId: register(db, "memory", true), agent: "auditor" };
  const drafted = candidate(db, "New habit");
  const review = register(db, "memory");

  const { parts } = memoryMaterialOf(db, review);

  expect(parts.store_changes).toEqual([]);
  expect(ids(parts.candidates)).toEqual([older, drafted]);
  expect(parts.candidates).toEqual(pullMemoryList(db, reader, "list_memory_candidates", {}, at).entries);
});

/** setup のみ: 1 marker = 1 episode の直挿しで、異議つき decision を置く(memory-meta-review-reads.test.ts と同じ形)。 */
function objectedDecision(db: Db, taskId: string, i: number): number {
  const decision = logDecision(db, getTask(db, taskId)!, `decision ${i}`, "deckhand", at, "worker");
  db.prepare("INSERT INTO episodes (id, worker_spawned_event_id, extractor_version, task_id, agent, lines) VALUES (?, ?, ?, ?, 'deckhand', '{}')").run(i, i, EXTRACTOR_VERSION, taskId);
  db.prepare("INSERT INTO episode_markers (episode_id, seq, kind, position, event_id) VALUES (?, 0, 'decision', 0, ?)").run(i, decision);
  return decision;
}

it("abandon で取り消された登録は窓の起点にならない: 次の回の窓は完了した登録の watermark から始まり、その間の異議は既定の list_precedents と材料の節の両方に載る(ADR 0193 決定1)", () => {
  const db = openDb(":memory:");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const [beforeCancelled, afterCancelled] = [1, 2].map((i) => objectedDecision(db, work, i));
  register(db, "memory", true);
  bundledObjection(db, work, beforeCancelled!, at);
  const cancelled = register(db, "memory");
  const failure = failureQuestion(db, cancelled, at);
  answerQuestionViaWebui(db, failure, ["abandon"], at);
  bundledObjection(db, work, afterCancelled!, at);
  const review = register(db, "memory");
  const [doneWatermark] = listEventsOfKinds(db, ["meta_review_registered"]).map((e) => e.payload.material_watermark);

  const { previous_watermark, parts } = memoryMaterialOf(db, review);

  expect(getTask(db, cancelled)?.status).toBe("cancelled");
  expect(previous_watermark).toBe(doneWatermark);
  expect(parts.precedents.map((p) => p.decision_event_id)).toEqual([beforeCancelled, afterCancelled]);
  expect(listPrecedents(db, { taskId: review, agent: "auditor" }, {}, at).precedents.map((p) => p.decision_event_id)).toEqual([beforeCancelled, afterCancelled]);
});

it("異議つき判断は窓の中に異議のある decision だけを list_precedents の行で、決着した提案は窓の中に回答か陳腐化のあるものだけを list_memory_proposals の行で、枝の一覧は list_memory_branches の行で載せる", () => {
  const db = openDb(":memory:");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const [early, inWindow, late] = [1, 2, 3].map((i) => objectedDecision(db, work, i));
  bundledObjection(db, work, early!, at);
  const previous = register(db, "memory", true);
  const propose = (candidate_id: number) => proposeMemoryChange(db, previous, { op: "approve", candidate_id, rationale: "r" }, "auditor", at).question_id;
  const answer = (questionId: string) => {
    const question = getTask(db, questionId)!;
    answerQuestionViaWebui(db, question, ["reject"], at, { comment: "Not ours." });
    rejectMemoryProposal(db, question.question_proposal as MemoryProposal, questionId, "webui", at);
  };
  const [answered, stale, open, late2] = ["Answered", "Stale", "Open", "Late"].map((title) => candidate(db, title));
  bundledObjection(db, work, inWindow!, at);
  const rejected = propose(answered!);
  answer(rejected);
  const settled = propose(stale!);
  invalidateMemoryByMetaReview(db, { entry_id: stale!, reason: "rejected" }, "auditor", "worker", at);
  propose(open!);
  const lateQuestion = propose(late2!);
  defineMemoryBranch(db, humanEntryInput(db, { workspace: "tidepool", path: "tools", text: "Tools.", original_text: "道具" }), "webui", at);
  knowledge(db, "tools/node");
  const review = register(db, "memory");
  bundledObjection(db, work, late!, at);
  bundledObjection(db, work, early!, at);
  answer(lateQuestion);
  const reader = { taskId: review, agent: "auditor" };

  const { parts } = memoryMaterialOf(db, review);

  expect(parts.precedents.map((p) => p.decision_event_id)).toEqual([inWindow]);
  expect(parts.precedents).toEqual(listPrecedents(db, reader, {}, at).precedents.filter((p) => p.decision_event_id === inWindow));
  expect(parts.proposals.map((p) => p.question_id)).toEqual([rejected, settled]);
  expect(parts.proposals).toEqual(pullMemoryProposals(db, reader, {}, at).proposals.filter((p) => [rejected, settled].includes(p.question_id)));
  expect(parts.branches).toEqual(pullMemoryBranches(db, reader, at).branches);
  expect(parts.branches.flatMap((b) => b.definitions)).toEqual([expect.not.objectContaining({ original: expect.anything() })]);
});

it("節を組んだ記録は task 帰属・agent 名義の meta_review_material_injected で、主題・worker_spawned の event id・両端の watermark・部分ごとの id(エントリ・decision の event・question・Definition)・トークン数と計数器を持つ", () => {
  const db = openDb(":memory:");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const objected = objectedDecision(db, work, 1);
  const previous = register(db, "memory", true);
  bundledObjection(db, work, objected, at);
  const written = knowledge(db, "tools/node");
  const definition = defineMemoryBranch(db, { scope: "tidepool", path: "tools", text: "Tools.", author: deckhand }, "worker", at).entry_id;
  const [drafted, rejected] = ["Drafted", "Rejected"].map((title) => candidate(db, title));
  const question = proposeMemoryChange(db, previous, { op: "approve", candidate_id: rejected!, rationale: "r" }, "auditor", at).question_id;
  answerQuestionViaWebui(db, getTask(db, question)!, ["reject"], at, { comment: "No." });
  rejectMemoryProposal(db, getTask(db, question)!.question_proposal as MemoryProposal, question, "webui", at);
  const review = register(db, "memory");
  const [first, second] = listEventsOfKinds(db, ["meta_review_registered"]).map((e) => e.payload.material_watermark);
  const material = memoryMaterialOf(db, review);

  const eventId = recordMetaReviewMaterial(db, review, "auditor", 42, material, at);

  expect(getEvent(db, eventId)).toMatchObject({
    task_id: review,
    worker_id: "auditor",
    origin: "board",
    payload: {
      kind: "meta_review_material_injected",
      subject: "memory",
      worker_spawned_event_id: 42,
      previous_watermark: first,
      material_watermark: second,
      store_changes: [written, definition],
      candidates: [drafted],
      precedents: [objected],
      proposals: [question],
      branches: [definition],
      tokens: material.tokens,
      tokenizer: "gpt-tokenizer/o200k_base",
      tokenizer_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    },
  });
  expect(material.tokens).toBeGreaterThan(0);
});
