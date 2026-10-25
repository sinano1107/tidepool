import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange, composeRoutingRow } from "../src/execution-setting.js";
import {
  approveMemoryProposal,
  createBehaviorCandidate,
  defineMemoryBranch,
  defineMemoryByMetaReview,
  foldMemory,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  moveMemoryByMetaReview,
  recordKnowledge,
  rejectMemoryProposal,
} from "../src/memory.js";
import { type MetaReviewSubject, registerDueMetaReviews, registerMetaReview } from "../src/meta-review.js";
import { getTask, listBoard, listChildren, logDecision, registerTask } from "../src/tasks.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { answerQuestionViaWebui, auditorRcaOn, failureQuestion, HUMAN_WEBUI, writerTask } from "./harness.js";


/** 周期の due 判定(ADR 0120 決定2・ADR 0151)のドメイン層: 同じ主題の meta-review 自身の産物は材料に数えない。 */
const at = new Date("2026-09-24T00:00:00.000Z");
const afterPeriod = new Date(at.getTime() + 8 * 24 * 60 * 60 * 1000);
const row = { provider: "anthropic" as const, tier: "standard" as const, model: "claude-opus-5", effort: "high", price_in: 5, price_out: 25 };

/** 前回の meta-review を登録して完了させる(周期の起点と watermark)。 */
function previousReview(db: Db, subject: MetaReviewSubject) {
  registerMetaReview(db, subject, at);
  db.prepare("UPDATE tasks SET status = 'done' WHERE meta_review_subject = ?").run(subject);
}

/** 盤面に載っている主題ごとの meta-review の数。listBoard は settled なツリー(root と子孫が
 *  すべて done / cancelled)を除くので、previousReview が done にした前回の meta-review は数えない。 */
const openMetaReviews = (db: Db, subject: MetaReviewSubject) =>
  listBoard(db).filter((task) => task.meta_review_subject === subject).length;

it("routing の行の提案への approve(修正値つきも)の適用だけでは、周期が過ぎても次の routing meta-review を登録しない", () => {
  const db = openDb(":memory:");
  previousReview(db, "routing");
  const proposal = { kind: "routing" as const, op: "row" as const, row: { provider: row.provider, model: row.model, effort: row.effort }, pin: row, change: { tier: "frontier" as const }, evidence: [1] };
  applyExecutionSettingsChange(db, { setting: "row", row: composeRoutingRow(proposal) }, "webui", at, "question-1");
  applyExecutionSettingsChange(db, { setting: "row", key: proposal.row, row: composeRoutingRow(proposal, { effort: "max" }) }, "webui", at, "question-2");

  registerDueMetaReviews(db, afterPeriod);

  expect(openMetaReviews(db, "routing")).toBe(0);
});

it("settings タブ / 管理MCP からの人間の行の直接編集は材料で、周期が過ぎれば次の routing meta-review を登録する", () => {
  const db = openDb(":memory:");
  previousReview(db, "routing");
  applyExecutionSettingsChange(db, { setting: "row", row }, "mcp", at);

  registerDueMetaReviews(db, afterPeriod);

  expect(openMetaReviews(db, "routing")).toBe(1);
});

const deckhand = { activity: "worker_verb" as const, name: "deckhand" };
const metaReview = { activity: "meta_review" as const, name: "auditor" };
const behavior = (db: Db, title: string) =>
  createBehaviorCandidate(db, { scope: null, path: "habits", title, text: `${title}.`, addressee: null, source: { commit: "0a46a46" }, author: deckhand }, "worker", at)
    .entry_id;
const knowledge = (db: Db, title: string) =>
  recordKnowledge(db, { scope: null, path: "build", title, text: `${title}.`, source: { commit: "0a46a46" }, author: deckhand }, "worker", at).entry_id;

it("memory の提案 question への回答(置換つき approve の superseded・invalidate の approve・reject)だけでは、次の memory meta-review を登録しない", () => {
  const db = openDb(":memory:");
  const old = behavior(db, "old wording");
  const version = approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: old, replaces: [] }, "question-0", "webui", at);
  const target = behavior(db, "retired habit");
  const targetVersion = approveMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: target, replaces: [] }, "question-1", "webui", at);
  const merged = behavior(db, "merged wording");
  const rejected = behavior(db, "rejected wording");
  previousReview(db, "memory");

  approveMemoryProposal(db, { kind: "memory", op: "consolidate", candidate_id: merged, replaces: [{ id: old, version }] }, "question-2", "webui", at);
  approveMemoryProposal(db, { kind: "memory", op: "invalidate", target: { id: target, version: targetVersion }, reason: "environment", replaces: [] }, "question-3", "webui", at);
  rejectMemoryProposal(db, { kind: "memory", op: "approve", candidate_id: rejected, replaces: [] }, "question-4", "webui", at);
  registerDueMetaReviews(db, afterPeriod);

  expect(openMetaReviews(db, "memory")).toBe(0);
});

it("memory meta-review の直接書き込み(define・fold・move・invalidate)だけでは、次の memory meta-review を登録しない", () => {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
  const decision = logDecision(db, task, "these notes say the same thing", "auditor", at, "worker");
  const a = knowledge(db, "a");
  const b = knowledge(db, "b");
  const moved = knowledge(db, "moved");
  const invalidated = knowledge(db, "invalidated");
  const definition = defineMemoryBranch(db, { scope: null, path: "build", text: "How it builds.", author: deckhand }, "worker", at).entry_id;
  previousReview(db, "memory");

  defineMemoryByMetaReview(db, { scope: null, path: "build", text: "How the board builds.", supersedes: [definition], author: metaReview }, "worker", at, writerTask(db));
  foldMemory(db, task.id, { scope: null, path: "build", title: "Folded", text: "Folded.", replaces: [a, b], based_on_decision: decision, author: metaReview }, "worker", at);
  moveMemoryByMetaReview(db, { entry_id: moved, scope: null, path: "toolchain", mover: metaReview }, "worker", at, writerTask(db));
  invalidateMemoryByMetaReview(db, { entry_id: invalidated, reason: "environment" }, "auditor", "worker", at, writerTask(db));
  registerDueMetaReviews(db, afterPeriod);

  expect(openMetaReviews(db, "memory")).toBe(0);
});

it("人間の memory の直接の無効化は材料で、周期が過ぎれば次の memory meta-review を登録する", () => {
  const db = openDb(":memory:");
  const entry = knowledge(db, "stale");
  previousReview(db, "memory");

  invalidateMemoryEntry(db, { entry_id: entry, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  registerDueMetaReviews(db, afterPeriod);

  expect(openMetaReviews(db, "memory")).toBe(1);
});

it("停止の帰責は材料で、周期が過ぎれば次の memory meta-review を登録する(ADR 0310 決定5)", () => {
  const db = openDb(":memory:");
  const work = writerTask(db);
  previousReview(db, "memory");

  appendEvent(db, { taskId: work, workerId: "board", origin: "board", at, payload: { kind: "stop_attributed", stop_event_id: 1, cause: "preference", evidence: "e", wrong_memory_entries: null, round: "initial" } });
  registerDueMetaReviews(db, afterPeriod);

  expect(openMetaReviews(db, "memory")).toBe(1);
});

/** 最新の meta-review を failure question への abandon で取り消す(status を直接書かない、ADR 0193)。 */
function abandonLatest(db: Db, now: Date) {
  const review = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  const question = failureQuestion(db, review, now);
  answerQuestionViaWebui(db, question, ["abandon"], now);
  expect(getTask(db, review)?.status).toBe("cancelled");
}

const registrations = (db: Db) => listEventsOfKinds(db, ["meta_review_registered"]).length;

it("abandon で取り消された meta-review の直後、周期が経つ前の poll では次の回を登録しない —— 周期は取り消された登録から数える(ADR 0193 決定2)", () => {
  const db = openDb(":memory:");
  const entry = knowledge(db, "stale");
  previousReview(db, "memory");
  invalidateMemoryEntry(db, { entry_id: entry, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  registerMetaReview(db, "memory", afterPeriod);
  abandonLatest(db, afterPeriod);
  knowledge(db, "after the abandon");

  registerDueMetaReviews(db, new Date(afterPeriod.getTime() + 24 * 60 * 60 * 1000));

  expect(registrations(db)).toBe(2);
});

it("取り消された回の窓にだけ材料があり、その後に変更が無くても、周期が経てば次の meta-review を登録する(ADR 0193 決定3)", () => {
  const db = openDb(":memory:");
  const entry = knowledge(db, "stale");
  previousReview(db, "memory");
  invalidateMemoryEntry(db, { entry_id: entry, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  registerMetaReview(db, "memory", afterPeriod);
  abandonLatest(db, afterPeriod);

  registerDueMetaReviews(db, new Date(afterPeriod.getTime() + 8 * 24 * 60 * 60 * 1000));

  expect(registrations(db)).toBe(3);
});

it("周期 meta-review は盤面自身の判断の段(judgement_tier の設定)を review_tier にして登録される(ADR 0200 決定4)", () => {
  const db = openDb(":memory:");
  applyExecutionSettingsChange(db, { setting: "judgement_tier", value: "standard" }, "webui", at);

  registerMetaReview(db, "routing", at);

  expect(listBoard(db).find((task) => task.meta_review_subject === "routing")?.review_tier).toBe("standard");
});

/** 前回の meta-review を登録し、その子に memory_repair を1件立ててから meta-review を完了させる(子は open のまま)。 */
function previousReviewWithRepair(db: Db, subject: MetaReviewSubject): string {
  registerMetaReview(db, subject, at);
  const review = listBoard(db).find((task) => task.meta_review_subject === subject)!;
  const repair = registerTask(db, { type: "memory_repair", title: "memory repair: review", purpose: "p", completion_criteria: "c", parent_id: review.id }, at, ...HUMAN_WEBUI);
  db.prepare("UPDATE tasks SET status = 'done' WHERE meta_review_subject = ?").run(subject);
  return repair.id;
}

it("同主題の meta-review の open な memory_repair の子がある間は、周期が過ぎ材料があっても登録しない —— 子が done になれば登録する(ADR 0279 決定7)", () => {
  const db = openDb(":memory:");
  const repair = previousReviewWithRepair(db, "memory");
  knowledge(db, "after the review");

  registerDueMetaReviews(db, afterPeriod);
  expect(registrations(db)).toBe(1);

  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(repair);
  registerDueMetaReviews(db, afterPeriod);
  expect(registrations(db)).toBe(2);
});

it("同主題の meta-review の子の下に open な提案 question があれば、子が done でも登録しない(ADR 0279 決定7)", () => {
  const db = openDb(":memory:");
  const candidate = behavior(db, "split migrations");
  const repair = previousReviewWithRepair(db, "memory");
  // 修理子の提案は判断の行が名指す対象に限られる(ADR 0281 決定4)—— ここでは open な提案 question だけが要るので直接立てる
  const question = [{ title: "Approve", detail: "d", options: ["approve", "reject", "defer"], recommendation: "approve" }];
  const proposal = { kind: "memory" as const, op: "approve" as const, candidate_id: candidate, replaces: [] };
  registerTask(db, { type: "question", title: "Approve", purpose: "r", completion_criteria: "c", parent_id: repair, question, question_kind: { kind: "proposal", proposal } }, at, "auditor", "worker");
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(repair);
  knowledge(db, "after the review");

  registerDueMetaReviews(db, afterPeriod);

  expect(registrations(db)).toBe(1);
});

it("別主題の meta-review の open な子は数えない —— memory の修理子が open でも routing の meta-review は登録する(ADR 0279 決定7)", () => {
  const db = openDb(":memory:");
  previousReviewWithRepair(db, "memory");
  previousReview(db, "routing");
  applyExecutionSettingsChange(db, { setting: "row", row }, "mcp", at);

  registerDueMetaReviews(db, afterPeriod);

  expect(openMetaReviews(db, "routing")).toBe(1);
});

const markDone = (db: Db, ...ids: string[]) => {
  for (const id of ids) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
};

it.each([
  ["done の修理子の下の open な RCA", (db: Db, repair: string) => {
    auditorRcaOn(db, getTask(db, repair)!, at);
    markDone(db, repair);
  }],
  ["meta-review の done の RCA の下の open な RCA", (db: Db, repair: string) => {
    markDone(db, repair);
    const review = getTask(db, repair)!.parent_id!;
    const rca = auditorRcaOn(db, getTask(db, review)!, at);
    auditorRcaOn(db, rca, at);
    markDone(db, rca.id, ...listChildren(db, review).filter((child) => child.id !== rca.id).map((child) => child.id));
  }],
] as const)("同主題の meta-review の系譜の孫(%s)がある間は、周期が過ぎ材料があっても次の周期を登録しない(ADR 0283 決定1)", (_, grandchild) => {
  const db = openDb(":memory:");
  const repair = previousReviewWithRepair(db, "memory");
  grandchild(db, repair);
  knowledge(db, "after the review");

  registerDueMetaReviews(db, afterPeriod);

  expect(registrations(db)).toBe(1);
});

it("祖先に meta-review の無い open な RCA は次の周期を止めない(ADR 0283 決定1)", () => {
  const db = openDb(":memory:");
  previousReview(db, "memory");
  auditorRcaOn(db, registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI), at);
  knowledge(db, "after the review");

  registerDueMetaReviews(db, afterPeriod);

  expect(registrations(db)).toBe(2);
});
