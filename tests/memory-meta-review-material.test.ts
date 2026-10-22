import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, getEvent, listEvents, listEventsOfKinds } from "../src/events.js";
import {
  approveMemoryProposal,
  buildMetaReviewMaterial,
  completeMemoryReview,
  createBehaviorCandidate,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  foldMemory,
  humanEntryInput,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  listMemoryEntries,
  listPrecedents,
  moveMemory,
  moveMemoryBranch,
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
import { entriesReadBefore, entriesSeenBefore, projectEpisode } from "../src/precedent.js";
import { getTask, logDecision, type MemoryProposal, registerTask } from "../src/tasks.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { answerQuestionViaWebui, bundledObjection, episodeOfDecision, failureQuestion, HUMAN_WEBUI, objectedJudgment, toolCall, WORKER_SPAWNED, writerTask } from "./harness.js";


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

it("材料の節は主題 memory の meta-review に memory の部分で組まれ、両端の watermark と6つの部分の見出しを持ち、材料の無い部分は空と書く —— 普通の task には null、主題 routing の meta-review には routing の部分(ADR 0180 追記 #1239)", () => {
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
    "### Items to judge",
    "(no items to judge)",
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
const knowledgeIn = (db: Db, scope: string, path: string) =>
  recordKnowledge(db, { scope, path, title: path, text: `${path}.`, source: { commit: "0a46a46" }, author: deckhand }, "worker", at);
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
  defineMemoryByMetaReview(db, { scope: null, path: "build", text: "How it builds.", author: metaReview }, "worker", at, writerTask(db));
  foldMemory(db, previous, { scope: "tidepool", path: "folded", title: "Folded", text: "Folded.", replaces: [toFold], based_on_decision: decision, author: metaReview }, "worker", at);
  moveMemoryByMetaReview(db, { entry_id: toMove, scope: "tidepool", path: "moved", mover: metaReview }, "worker", at, writerTask(db));
  invalidateMemoryByMetaReview(db, { entry_id: toRetire, reason: "environment" }, "auditor", "worker", at, writerTask(db));
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
  const freshCopy = moveMemoryByMetaReview(db, { entry_id: fresh, scope: "tidepool", path: "settled", mover: metaReview }, "worker", at, writerTask(db)).entry_id;
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
  episodeOfDecision(db, taskId, decision);
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

it("異議つき判断は読み手 memory の list_precedents の行と同じ —— 窓に routing meta-review とその子の行があっても(ADR 0279 決定6)", () => {
  const db = openDb(":memory:");
  const previous = register(db, "memory", true);
  const routing = register(db, "routing", true);
  // meta-review の子は修理子 —— work は帰り先の無い系譜に立たない(ADR 0301 決定2)
  const work = (parent_id?: string) => registerTask(db, { type: parent_id ? "memory_repair" : "work", title: "w", purpose: "p", completion_criteria: "c", parent_id }, at, ...HUMAN_WEBUI).id;
  [previous, work(previous), routing, work(routing), work()].forEach((taskId, i) => bundledObjection(db, taskId, objectedDecision(db, taskId, i + 1), at));
  const review = register(db, "memory");

  const { parts } = memoryMaterialOf(db, review);

  expect(parts.precedents).toEqual(listPrecedents(db, { taskId: review, agent: "auditor" }, {}, at).precedents);
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
  invalidateMemoryByMetaReview(db, { entry_id: stale!, reason: "rejected" }, "auditor", "worker", at, writerTask(db));
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
  expect(parts.branches).toEqual(pullMemoryBranches(db, reader, {}, at).branches);
  expect(parts.branches.flatMap((b) => b.definitions)).toEqual([expect.not.objectContaining({ original: expect.anything() })]);
});

it("判断を要する項目は verb と同じ鍵で並ぶ: 窓で起草された candidate・窓で決着した提案が名指す candidate(reject で無効化済みのものは載らない)・cause memory の異議つき判断が名指すエントリ・店の変更、定義の無い枝の (path, scope) —— 窓の外の candidate と定義のある枝は載らず、2つの workspace が同じ path を定義していても載らない(ADR 0278 決定5 / ADR 0282 決定1・2)", () => {
  const db = openDb(":memory:");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const decision = objectedDecision(db, work, 1);
  const older = candidate(db, "Older habit");
  const answered = candidate(db, "Answered");
  const followed = knowledge(db, "tools/node");
  for (const scope of ["tidepool", "reef"]) defineMemoryBranch(db, { scope, path: "tools", text: "Tools.", author: deckhand }, "worker", at);
  defineMemoryBranch(db, { scope: "tidepool", path: "notes", text: "Notes.", author: deckhand }, "worker", at);
  const previous = register(db, "memory", true);
  const drafted = candidate(db, "New habit");
  const written = knowledge(db, "notes");
  const question = proposeMemoryChange(db, previous, { op: "approve", candidate_id: answered, rationale: "r" }, "auditor", at).question_id;
  answerQuestionViaWebui(db, getTask(db, question)!, ["reject"], at, { comment: "No." });
  rejectMemoryProposal(db, getTask(db, question)!.question_proposal as MemoryProposal, question, "webui", at);
  appendEvent(db, {
    taskId: work,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [bundledObjection(db, work, decision, at)], cause: "memory", evidence: "e", entries: [followed], round: "initial" },
    at,
  });
  const review = register(db, "memory");
  candidate(db, "Late");

  const { parts, section } = memoryMaterialOf(db, review);

  expect(parts.items).toEqual([
    ...[followed, drafted, written].sort((a, b) => a - b).map((entry) => ({ entry })),
    { branch: "tools/node", scope: "tidepool" },
  ]);
  expect(ids(parts.candidates)).toContain(older);
  expect(section).toContain("### Items to judge");
  for (const item of parts.items) expect(section).toContain(JSON.stringify(item));
});

it("窓で異議された前の memory meta-review の判断の行が名指すエントリ(本文が同じ鎖の末尾)と枝が、生きていれば項目に1度だけ載る —— 無効化済みのエントリ・木に無い枝・窓の外の異議は載らない(ADR 0279 決定5)", () => {
  const db = openDb(":memory:");
  defineMemoryBranch(db, { scope: "tidepool", path: "notes", text: "Notes.", author: deckhand }, "worker", at);
  const [kept, dropped, outside] = ["notes", "notes", "notes"].map((path) => knowledge(db, path));
  invalidateMemoryEntry(db, { entry_id: dropped!, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  const judged = (entry: number | string) => ({ kind: "memory" as const, value: "left_as_is" as const, ...(typeof entry === "number" ? { entry } : { branch: entry, scope: "tidepool" }) });
  const older = register(db, "memory", true);
  objectedJudgment(db, older, judged(outside!), at);
  const previous = register(db, "memory", true);
  const written = knowledge(db, "notes");
  for (const object of [kept!, dropped!, written, "notes", "gone"]) objectedJudgment(db, previous, judged(object), at);
  const review = register(db, "memory");

  const { parts, section } = memoryMaterialOf(db, review);

  expect(parts.items).toEqual([{ entry: kept }, { entry: written }, { branch: "notes", scope: "tidepool" }]);
  expect(section).toContain("the entries and branches named by the judgments of the objected decisions");
});

it("窓の中に枝ごと移された枝を名指す異議つき判断の行は、エントリの移動をたどった今の path の枝で項目に載る —— 旧の path は木に無い(ADR 0279 決定5)", () => {
  const db = openDb(":memory:");
  defineMemoryBranch(db, { scope: "tidepool", path: "notes", text: "Notes.", author: deckhand }, "worker", at);
  knowledge(db, "notes/today");
  const previous = register(db, "memory", true);
  objectedJudgment(db, previous, { kind: "memory", branch: "notes", scope: "tidepool", value: "left_as_is" }, at);
  defineMemoryBranch(db, { scope: "tidepool", path: "memo/today", text: "Today.", author: deckhand }, "worker", at);
  moveMemoryBranch(db, { scope: "tidepool", path: "notes", to_scope: "tidepool", to_path: "memo", mover: human }, "webui", at);
  const review = register(db, "memory");

  const { parts } = memoryMaterialOf(db, review);

  expect(parts.branches.map((b) => b.path)).not.toContain("notes");
  expect(parts.items.filter((item) => "branch" in item)).toEqual([{ branch: "memo", scope: "tidepool" }]);
});

it("異議された枝の再掲は (path, scope) の鍵 —— その scope にエントリが無ければ載らず、別 scope の同じ path の枝は載らない。scope の配下が移されていれば今の (path, scope) で、盤面全体へ広げられていれば盤面全体で載る(ADR 0282 決定2 / ADR 0279 決定5)", () => {
  const db = openDb(":memory:");
  const define = (scope: string | null, path: string) => defineMemoryBranch(db, { scope, path, text: `${path}.`, author: deckhand }, "worker", at);
  for (const scope of ["charts", "docks"]) define(scope, "tides");
  define("reef", "tides");
  for (const scope of ["charts", "docks", "reef"]) knowledgeIn(db, scope, "tides");
  const previous = register(db, "memory", true);
  for (const scope of ["charts", "docks", "reef", "sand"]) objectedJudgment(db, previous, { kind: "memory", branch: "tides", scope, value: "left_as_is" }, at);
  moveMemoryBranch(db, { scope: "docks", path: "tides", to_scope: null, to_path: "sea", mover: human }, "webui", at);
  moveMemoryBranch(db, { scope: "reef", path: "tides", to_scope: "reef", to_path: "shore", mover: human }, "webui", at);
  const review = register(db, "memory");

  const { parts } = memoryMaterialOf(db, review);

  expect(parts.items.filter((item) => "branch" in item)).toEqual([
    { branch: "sea", scope: null },
    { branch: "shore", scope: "reef" },
    { branch: "tides", scope: "charts" },
  ]);
});

/** charts の `tides` に Knowledge → 前の review の (tides, charts) の left_as_is に異議 → 人間がその Knowledge を引退 → charts の
 *  `tides/high` に candidate(#2331 の実測1の盤面)。approved の木は空。 */
function candidateOnlyBranch() {
  const db = openDb(":memory:");
  const retired = knowledgeIn(db, "charts", "tides").entry_id;
  const previous = register(db, "memory", true);
  objectedJudgment(db, previous, { kind: "memory", branch: "tides", scope: "charts", value: "left_as_is" }, at);
  invalidateMemoryEntry(db, { entry_id: retired, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  const drafted = createBehaviorCandidate(
    db,
    { scope: "charts", path: "tides/high", title: "High", text: "High.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    at,
  ).entry_id;
  return { db, drafted };
}

it("異議された枝の配下にその scope の candidate だけが残っていても、枝の一覧に無い (path, scope) のまま再掲される(ADR 0284 決定1)", () => {
  const { db } = candidateOnlyBranch();

  const { parts, section } = memoryMaterialOf(db, register(db, "memory"));

  expect(parts.branches).toEqual([]);
  expect(parts.items.filter((item) => "branch" in item)).toEqual([{ branch: "tides", scope: "charts" }]);
  expect(section).toContain("a branch if an entry of its scope that is not invalidated (candidates included) sits at or under the path, even a path not in Branches");
});

it("candidate だけが残る異議された枝が枝ごと移されていれば、candidate の移動の鎖をたどった今の (path, scope) で再掲され、その candidate も無効化されていれば載らない(ADR 0284 決定1 / ADR 0279 決定5)", () => {
  const moved = candidateOnlyBranch();
  moveMemoryBranch(moved.db, { scope: "charts", path: "tides", to_scope: "charts", to_path: "memo", mover: human }, "webui", at);
  const rejected = candidateOnlyBranch();
  invalidateMemoryEntry(rejected.db, { entry_id: rejected.drafted, reason: "rejected" }, HUMAN_WORKER_ID, "webui", at);

  const afterMove = memoryMaterialOf(moved.db, register(moved.db, "memory")).parts;
  const afterReject = memoryMaterialOf(rejected.db, register(rejected.db, "memory")).parts;

  expect(afterMove.candidates.map(({ path, scope }) => ({ path, scope }))).toEqual([{ path: "memo/high", scope: "charts" }]);
  expect(afterMove.items.filter((item) => "branch" in item)).toEqual([{ branch: "memo", scope: "charts" }]);
  expect(afterReject.items.filter((item) => "branch" in item)).toEqual([]);
});

it("枝ごと移された candidate の複製も無効化されていれば、移動先の (path, scope) でも再掲されない(ADR 0284 決定1)", () => {
  const { db } = candidateOnlyBranch();
  moveMemoryBranch(db, { scope: "charts", path: "tides", to_scope: "charts", to_path: "memo", mover: human }, "webui", at);
  const copy = memoryMaterialOf(db, register(db, "memory")).parts.candidates[0]!.id;
  invalidateMemoryEntry(db, { entry_id: copy, reason: "rejected" }, HUMAN_WORKER_ID, "webui", at);

  const { parts } = memoryMaterialOf(db, register(db, "memory"));

  expect(parts.items.filter((item) => "branch" in item)).toEqual([]);
});

it("枝の一覧にある path でも、異議された scope の配下が candidate だけなら再掲される —— 木の scope に無くてよい(ADR 0284 決定1)", () => {
  const { db } = candidateOnlyBranch();
  knowledgeIn(db, "reef", "tides");

  const { parts } = memoryMaterialOf(db, register(db, "memory"));

  expect(parts.branches.map(({ path, scopes }) => ({ path, scopes }))).toEqual([{ path: "tides", scopes: ["reef"] }]);
  expect(parts.items.filter((item) => "branch" in item)).toEqual([
    { branch: "tides", scope: "reef" },
    { branch: "tides", scope: "charts" },
  ]);
});

it("異議の無い path に workspace の candidate だけがあっても、構造の項目「定義の無い枝」は立たない —— 木は approved だけ(ADR 0284 決定2)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  createBehaviorCandidate(db, { scope: "charts", path: "tides/high", title: "High", text: "High.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at);

  const { parts } = memoryMaterialOf(db, register(db, "memory"));

  expect(parts.items.filter((item) => "branch" in item)).toEqual([]);
});

it("異議された workspace の枝の下に盤面全体のエントリがあっても、再掲は人間が名指した (path, scope) のままで、構造の (path, 盤面全体) と並ぶ(ADR 0284 決定3)", () => {
  const db = openDb(":memory:");
  knowledgeIn(db, "charts", "tides/low");
  const previous = register(db, "memory", true);
  objectedJudgment(db, previous, { kind: "memory", branch: "tides", scope: "charts", value: "left_as_is" }, at);
  recordKnowledge(db, { scope: null, path: "tides/deep", title: "Deep", text: "Deep.", source: { commit: "0a46a46" }, author: deckhand }, "worker", at);

  const { parts } = memoryMaterialOf(db, register(db, "memory"));

  expect(parts.items.filter((item) => "branch" in item)).toEqual([
    { branch: "tides", scope: null },
    { branch: "tides", scope: "charts" },
    { branch: "tides/deep", scope: null },
    { branch: "tides/low", scope: "charts" },
  ]);
});

it("盤面全体のエントリ(candidate も)がその path かその下にある定義の無い枝は (path, 盤面全体) の1項目だけで、無ければ欠けている workspace ごとに1項目(ADR 0282 決定2・3)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  for (const scope of ["charts", "docks"]) for (const path of ["tides", "reefs"]) knowledgeIn(db, scope, path);
  createBehaviorCandidate(db, { scope: null, path: "tides/high", title: "High", text: "High.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } }, "worker", at);
  const review = register(db, "memory");

  const { parts, section } = memoryMaterialOf(db, review);

  expect(parts.items.filter((item) => "branch" in item)).toEqual([
    { branch: "reefs", scope: "charts" },
    { branch: "reefs", scope: "docks" },
    { branch: "tides", scope: null },
  ]);
  expect(section).toContain(
    "the branches that hold entries without a Definition in their scope or whole-board — one item per scope that lacks one, keyed by path and " +
      "scope (null = the whole board), or a single whole-board item when whole-board entries sit at or under the path —",
  );
  expect(section).not.toContain("two or more scopes");
});

it("節を組んだ記録は task 帰属・agent 名義の meta_review_material_injected で、主題・worker_spawned の event id・両端の watermark・部分ごとの id(エントリ・decision の event・question・Definition)・注入した Items to judge と同じ並び・同じ鍵の items・トークン数と計数器を持つ", () => {
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
      precedent_entries: [],
      proposals: [question],
      proposal_entries: [rejected],
      branches: [definition],
      items: [...[written, definition, drafted].map((entry) => ({ entry })), { branch: "tools/node", scope: "tidepool" }],
      tokens: material.tokens,
      tokenizer: "gpt-tokenizer/o200k_base",
      tokenizer_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    },
  });
  expect(material.tokens).toBeGreaterThan(0);
});

it("決着した提案の部分の行も pin した本文の今の居場所 relocated を持ち、記録の proposal_entries は名指す entry の鎖の末尾を数える(ADR 0222 決定2・4)", () => {
  const db = openDb(":memory:");
  const previous = register(db, "memory", true);
  const moved = candidate(db, "Moved");
  const question = proposeMemoryChange(db, previous, { op: "approve", candidate_id: moved, rationale: "r" }, "auditor", at).question_id;
  const copy = moveMemory(db, { entry_id: moved, scope: null, path: "elsewhere", mover: human }, "webui", at).entry_id;
  answerQuestionViaWebui(db, getTask(db, question)!, ["defer"], at, { comment: "Later." });
  const review = register(db, "memory");
  const material = memoryMaterialOf(db, review);

  const eventId = recordMetaReviewMaterial(db, review, "auditor", 42, material, at);

  expect(material.parts.proposals).toMatchObject([{ question_id: question, relocated: [{ id: moved, tail_id: copy, path: "elsewhere", scope: null, invalidation_reason: null }] }]);
  expect(getEvent(db, eventId)).toMatchObject({ payload: { proposals: [question], proposal_entries: [copy] } });
});

it("主題 memory の材料の節に載ったエントリは、その session の decision の entries_seen に入り entries_read に入らない —— 異議つき判断と決着した提案の部分は list_precedents と list_memory_proposals が返すのと同じエントリで数え、主題 routing の材料の節は異議つき判断の部分のエントリだけ数える(ADR 0279 決定6)", () => {
  const db = openDb(":memory:");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  // objectedDecision の直挿し(episodeOfDecision)は decision の event id を Episode の id と worker_spawned の event id に兼ねるので、その session の注入はこの id で結ぶ
  const objected = objectedDecision(db, work, 1);
  const workSession = objected;
  const followed = knowledge(db, "followed");
  appendEvent(db, {
    taskId: work,
    workerId: "deckhand",
    origin: "board",
    payload: { kind: "memory_injected", worker_spawned_event_id: workSession, watermark: 0, entries: [{ id: followed, version: 1 }], tokens: 0, index_depth: 0, index_max_depth: 0, omitted: 0, tokenizer: "t", tokenizer_version: "0" },
    at,
  });
  const previous = register(db, "memory", true);
  bundledObjection(db, work, objected, at);
  const written = knowledge(db, "tools/node");
  const definition = defineMemoryBranch(db, { scope: "tidepool", path: "tools", text: "Tools.", author: deckhand }, "worker", at).entry_id;
  const [drafted, rejected] = ["Drafted", "Rejected"].map((title) => candidate(db, title));
  const question = proposeMemoryChange(db, previous, { op: "approve", candidate_id: rejected!, rationale: "r" }, "auditor", at).question_id;
  answerQuestionViaWebui(db, getTask(db, question)!, ["reject"], at, { comment: "No." });
  rejectMemoryProposal(db, getTask(db, question)!.question_proposal as MemoryProposal, question, "webui", at);
  const review = register(db, "memory");
  const routingShown = knowledge(db, "routing-shown");
  const spawned = appendEvent(db, { taskId: review, workerId: "auditor", origin: "board", payload: WORKER_SPAWNED, at });
  recordMetaReviewMaterial(db, review, "auditor", spawned, memoryMaterialOf(db, review), at);
  appendEvent(db, {
    taskId: review,
    workerId: "auditor",
    origin: "board",
    payload: {
      kind: "meta_review_material_injected",
      subject: "routing",
      worker_spawned_event_id: spawned,
      previous_watermark: 0,
      material_watermark: 0,
      tokens: 0,
      tokenizer: "t",
      tokenizer_version: "0",
      shadow: [9001],
      shadow_rows: 1,
      shadow_rows_multi_candidate: 0,
      allocations: [9002],
      cells: [9003],
      rows: [9004],
      precedents: [9005],
      precedent_entries: [routingShown],
      proposals: [],
      items: [],
    },
    at,
  });
  const decision = logDecision(db, getTask(db, review)!, "kept the tools note", "auditor", at, "worker");
  const events = listEvents(db, review);

  const episode = projectEpisode({
    transcriptLines: toolCall(1, "mcp__tidepool__log_decision", decision),
    events,
    workerSpawnedEventId: spawned,
    extractorVersion: "test",
  });

  expect(entriesSeenBefore(episode, events, decision)).toEqual([followed, written, definition, drafted!, rejected!, routingShown].sort((a, b) => a - b));
  expect(entriesReadBefore(episode, events, decision)).toEqual([]);
});

/** setup のみ: review の session を spawn して材料の節を記録し、decision を1本書いて、材料の項目とその decision の seen / read を返す。 */
function seenOfMaterial(db: Db, review: string) {
  const spawned = appendEvent(db, { taskId: review, workerId: "auditor", origin: "board", payload: WORKER_SPAWNED, at });
  const material = memoryMaterialOf(db, review);
  recordMetaReviewMaterial(db, review, "auditor", spawned, material, at);
  const decision = logDecision(db, getTask(db, review)!, "judged the items", "auditor", at, "worker");
  const events = listEvents(db, review);
  const episode = projectEpisode({ transcriptLines: toolCall(1, "mcp__tidepool__log_decision", decision), events, workerSpawnedEventId: spawned, extractorVersion: "test" });
  return { items: material.parts.items, seen: entriesSeenBefore(episode, events, decision), read: entriesReadBefore(episode, events, decision) };
}

it("reject で決着した consolidate の提案の replaces が名指す approved のエントリは、材料の節の項目に載り、その session の decision の entries_seen に入り entries_read に入らない", () => {
  const db = openDb(":memory:");
  const replaced = candidate(db, "Brief notes");
  approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: replaced, replaces: [] }, "question-replaced", "webui", at);
  const previous = register(db, "memory", true);
  const successor = candidate(db, "Short notes");
  const question = proposeMemoryChange(db, previous, { op: "consolidate", candidate_id: successor, replaces: [replaced], rationale: "r" }, "auditor", at).question_id;
  answerQuestionViaWebui(db, getTask(db, question)!, ["reject"], at, { comment: "No." });
  rejectMemoryProposal(db, getTask(db, question)!.question_proposal as MemoryProposal, question, "webui", at);

  const { items, seen, read } = seenOfMaterial(db, register(db, "memory"));

  expect(db.prepare("SELECT invalidation_reason FROM memory_entries WHERE id = ?").get(replaced)).toEqual({ invalidation_reason: null });
  expect(items).toContainEqual({ entry: replaced });
  expect(seen).toContain(replaced);
  expect(read).toEqual([]);
});

it("窓で承認された既存の後継への consolidate の replaces は superseded で鎖の末尾が無効化済みなので項目に載らず、後継も項目に載らない(ADR 0286 決定1)", () => {
  const db = openDb(":memory:");
  const [successor, replaced] = ["Short notes", "Brief notes"].map((title) => candidate(db, title));
  for (const [id, name] of [[successor!, "question-successor"], [replaced!, "question-replaced"]] as const) {
    approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: id, replaces: [] }, name, "webui", at);
  }
  const previous = register(db, "memory", true);
  const question = proposeMemoryChange(db, previous, { op: "consolidate", successor_id: successor!, replaces: [replaced!], rationale: "r" }, "auditor", at).question_id;
  answerQuestionViaWebui(db, getTask(db, question)!, ["approve"], at);
  approveMemoryProposal(db, getTask(db, question)!.question_proposal as MemoryProposal, question, "webui", at);

  const { parts } = memoryMaterialOf(db, register(db, "memory"));

  expect(listMemoryEntries(db, { state: "invalidated" }).map(({ id, invalidation_reason }) => ({ id, invalidation_reason }))).toEqual([
    { id: replaced, invalidation_reason: "superseded" },
  ]);
  expect(parts.proposals.map((row) => row.question_id)).toEqual([question]);
  expect(parts.items).toEqual([{ branch: "habits", scope: null }]);
});

it("窓で reject された candidate と、cause memory の異議つき判断が名指し窓で人間が引退させた Knowledge は項目に載らず、値なしで完了する —— 回答と無効化は Settled proposals と Store changes の部分で読まれる(ADR 0286 決定1)", () => {
  const db = openDb(":memory:");
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const decision = objectedDecision(db, work, 1);
  const followed = knowledge(db, "tools/node");
  defineMemoryBranch(db, { scope: "tidepool", path: "tools", text: "Tools.", author: deckhand }, "worker", at);
  const answered = candidate(db, "Answered");
  const previous = register(db, "memory", true);
  const question = proposeMemoryChange(db, previous, { op: "approve", candidate_id: answered, rationale: "r" }, "auditor", at).question_id;
  answerQuestionViaWebui(db, getTask(db, question)!, ["reject"], at, { comment: "No." });
  rejectMemoryProposal(db, getTask(db, question)!.question_proposal as MemoryProposal, question, "webui", at);
  appendEvent(db, {
    taskId: work,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [bundledObjection(db, work, decision, at)], cause: "memory", evidence: "e", entries: [followed], round: "initial" },
    at,
  });
  invalidateMemoryEntry(db, { entry_id: followed, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  const review = register(db, "memory");
  const material = memoryMaterialOf(db, review);
  recordMetaReviewMaterial(db, review, "auditor", 42, material, at);

  expect(material.parts.items).toEqual([]);
  expect(material.parts.proposals.map((row) => row.question_id)).toEqual([question]);
  expect(ids(material.parts.store_changes)).toEqual([followed]);
  expect(completeMemoryReview(db, getTask(db, review)!, { judgments: [] }, "auditor", at, "worker").status).toBe("done");
});

it("異議された前の memory meta-review の判断の行が名指す窓の外のエントリは、5部分のどこにも載らなくても項目に載り、その session の decision の entries_seen に入り entries_read に入らない", () => {
  const db = openDb(":memory:");
  const outside = knowledge(db, "outside");
  const previous = register(db, "memory", true);
  objectedJudgment(db, previous, { kind: "memory", entry: outside, value: "left_as_is" }, at);

  const { items, seen, read } = seenOfMaterial(db, register(db, "memory"));

  expect(items).toContainEqual({ entry: outside });
  expect(seen).toEqual([outside]);
  expect(read).toEqual([]);
});

it("枝の項目しか持たない材料の節は、seen を枝の部分のエントリより増やさない", () => {
  const db = openDb(":memory:");
  const definition = defineMemoryBranch(db, { scope: "tidepool", path: "notes", text: "Notes.", author: deckhand }, "worker", at).entry_id;
  knowledge(db, "notes");
  const previous = register(db, "memory", true);
  objectedJudgment(db, previous, { kind: "memory", branch: "notes", scope: "tidepool", value: "left_as_is" }, at);

  const { items, seen } = seenOfMaterial(db, register(db, "memory"));

  expect(items).toEqual([{ branch: "notes", scope: "tidepool" }]);
  expect(seen).toEqual([definition]);
});

