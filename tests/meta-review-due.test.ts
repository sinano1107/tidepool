import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { applyExecutionSettingsChange, composeRoutingRow } from "../src/execution-setting.js";
import {
  approveMemoryProposal,
  createBehaviorCandidate,
  defineMemoryBranch,
  foldMemory,
  invalidateMemoryByMetaReview,
  invalidateMemoryEntry,
  moveMemory,
  recordKnowledge,
  rejectMemoryProposal,
} from "../src/memory.js";
import { type MetaReviewSubject, registerDueMetaReviews, registerMetaReview } from "../src/meta-review.js";
import { HUMAN_WORKER_ID, logDecision, registerTask } from "../src/tasks.js";

/** 周期の due 判定(ADR 0120 決定2・ADR 0151)のドメイン層: 同じ主題の meta-review 自身の産物は材料に数えない。 */
const at = new Date("2026-09-24T00:00:00.000Z");
const afterPeriod = new Date(at.getTime() + 8 * 24 * 60 * 60 * 1000);
const row = { provider: "anthropic" as const, tier: "standard" as const, model: "claude-opus-4-1", effort: "high", price_in: 5, price_out: 25 };

/** 前回の meta-review を登録して完了させる(周期の起点と watermark)。 */
function previousReview(db: Db, subject: MetaReviewSubject) {
  registerMetaReview(db, subject, at);
  db.prepare("UPDATE tasks SET status = 'done' WHERE meta_review_subject = ?").run(subject);
}

const registered = (db: Db, subject: MetaReviewSubject) =>
  (db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'meta_review_registered' AND json_extract(payload, '$.subject') = ?").get(subject) as { n: number }).n;

it("routing の行の提案への approve(修正値つきも)の適用だけでは、周期が過ぎても次の routing meta-review を登録しない", () => {
  const db = openDb(":memory:");
  previousReview(db, "routing");
  const proposal = { kind: "routing" as const, op: "row" as const, row: { provider: row.provider, model: row.model }, pin: row, change: { tier: "frontier" as const } };
  applyExecutionSettingsChange(db, { setting: "row", row: composeRoutingRow(proposal) }, "webui", at, "question-1");
  applyExecutionSettingsChange(db, { setting: "row", row: composeRoutingRow(proposal, { effort: "max" }) }, "webui", at, "question-2");

  registerDueMetaReviews(db, afterPeriod);

  expect(registered(db, "routing")).toBe(1);
});

it("settings タブ / 管理MCP からの人間の行の直接編集は材料で、周期が過ぎれば次の routing meta-review を登録する", () => {
  const db = openDb(":memory:");
  previousReview(db, "routing");
  applyExecutionSettingsChange(db, { setting: "row", row }, "mcp", at);

  registerDueMetaReviews(db, afterPeriod);

  expect(registered(db, "routing")).toBe(2);
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

  expect(registered(db, "memory")).toBe(1);
});

it("memory meta-review の直接書き込み(define・fold・move・invalidate)だけでは、次の memory meta-review を登録しない", () => {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at);
  const decision = logDecision(db, task, "these notes say the same thing", "auditor", at);
  const a = knowledge(db, "a");
  const b = knowledge(db, "b");
  const moved = knowledge(db, "moved");
  const invalidated = knowledge(db, "invalidated");
  const definition = defineMemoryBranch(db, { scope: null, path: "build", text: "How it builds.", author: deckhand }, "worker", at).entry_id;
  previousReview(db, "memory");

  defineMemoryBranch(db, { scope: null, path: "build", text: "How the board builds.", supersedes: definition, author: metaReview }, "worker", at);
  foldMemory(db, { scope: null, path: "build", title: "Folded", text: "Folded.", replaces: [a, b], based_on_decision: decision, author: metaReview }, "worker", at);
  moveMemory(db, { entry_id: moved, scope: null, path: "toolchain", author: metaReview }, "worker", at);
  invalidateMemoryByMetaReview(db, { entry_id: invalidated, reason: "environment" }, "auditor", "worker", at);
  registerDueMetaReviews(db, afterPeriod);

  expect(registered(db, "memory")).toBe(1);
});

it("人間の memory の直接の無効化は材料で、周期が過ぎれば次の memory meta-review を登録する", () => {
  const db = openDb(":memory:");
  const entry = knowledge(db, "stale");
  previousReview(db, "memory");

  invalidateMemoryEntry(db, { entry_id: entry, reason: "environment" }, HUMAN_WORKER_ID, "webui", at);
  registerDueMetaReviews(db, afterPeriod);

  expect(registered(db, "memory")).toBe(2);
});
