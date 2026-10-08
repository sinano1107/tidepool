import { expect, it } from "vitest";
import type { AgentView } from "../src/agent-create.js";
import { openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { readExecutionSettings } from "../src/execution-setting.js";
import { submitAnswer } from "../src/human-verbs.js";
import { normalizeText, whyBlank } from "../src/required-text.js";
import { proposeRoutingChange } from "../src/routing-review.js";
import { answerQuestion, assertAnswerable, completeTask, decomposeTask, editTask, getTask, listChildren, logDecision, registerTask } from "../src/tasks.js";
import { raiseObjection } from "../src/triage.js";
import { unusedLanding } from "./fakes.js";
import { HUMAN_WEBUI, WORKER_SPAWNED } from "./harness.js";

it("required text trims surrounding whitespace and refuses text with no visible content", () => {
  expect(normalizeText(" \tfirst\nsecond\n ")).toBe("first\nsecond");
  expect(whyBlank(" \t\r\n\u3000")).toBe("must not be blank");
  expect(whyBlank(" text ")).toBeUndefined();
});

it("task registration and edits store normalized required content and reject blank content", () => {
  const db = openDb(":memory:");
  try {
    const input = { type: "work" as const, title: " title ", purpose: " purpose\n", completion_criteria: " criteria " };
    for (const field of ["title", "purpose", "completion_criteria"] as const) {
      expect(() => registerTask(db, { ...input, [field]: " \t\n" }, new Date(0), ...HUMAN_WEBUI)).toThrow();
    }
    const task = registerTask(db, input, new Date(0), ...HUMAN_WEBUI);
    expect(task).toMatchObject({ title: "title", purpose: "purpose", completion_criteria: "criteria" });
    for (const field of ["title", "purpose", "completion_criteria"] as const) {
      expect(() => editTask(db, task, { [field]: " \t\n" }, new Date(0), "webui")).toThrow();
    }
    editTask(db, task, { title: " edited ", purpose: " new purpose ", completion_criteria: " new criteria " }, new Date(0), "webui");
    expect(getTask(db, task.id)).toMatchObject({ title: "edited", purpose: "new purpose", completion_criteria: "new criteria" });
  } finally {
    db.close();
  }
});

it("question items normalize required text and keep recommendation matched to normalized options", () => {
  const db = openDb(":memory:");
  try {
    const question = { type: "question" as const, title: "question", purpose: "context", completion_criteria: "answer" };
    for (const item of [
      { title: "choose", options: ["yes", " \t\n"], recommendation: "yes" },
      { title: "choose", detail: " \t\n", options: ["yes", "no"], recommendation: "yes" },
    ]) {
      expect(() => registerTask(db, { ...question, question: [item] }, new Date(0), ...HUMAN_WEBUI)).toThrow();
    }
    const task = registerTask(db, { type: "question", title: "question", purpose: "context", completion_criteria: "answer", question: [{ title: " choose ", detail: " detail ", options: [" yes ", " no "], recommendation: " yes " }] }, new Date(0), ...HUMAN_WEBUI);
    expect(getTask(db, task.id)?.question_items).toEqual([{ title: "choose", detail: "detail", options: ["yes", "no"], recommendation: "yes" }]);
  } finally { db.close(); }
});

it("decomposition rejects blank reasons and stores trimmed decisions", () => {
  const db = openDb(":memory:");
  try {
    const parent = registerTask(db, { type: "work", title: "parent", purpose: "purpose", completion_criteria: "criteria" }, new Date(0), ...HUMAN_WEBUI);
    const input = { reason: " \t\n", children: [{ title: "child", purpose: "purpose", completion_criteria: "criteria" }] };
    expect(() => decomposeTask(db, parent, input, "worker", new Date(0), undefined, undefined, "worker")).toThrow();
    decomposeTask(db, parent, { ...input, reason: " split the work\n" }, "worker", new Date(0), undefined, undefined, "worker");
    expect(listEvents(db, parent.id).find((event) => event.kind === "decision_logged")?.payload).toMatchObject({ line: "split the work" });
  } finally { db.close(); }
});

it("task requests normalize supplied tier and priority names before registration and decomposition checks", () => {
  const db = openDb(":memory:");
  try {
    const input = { type: "work" as const, title: "task", purpose: "purpose", completion_criteria: "criteria", tier: " standard ", review_tier: " frontier\n", priority: " cost " };
    for (const field of ["tier", "review_tier", "priority"] as const) {
      expect(() => registerTask(db, { ...input, [field]: " \t\n" }, new Date(0), ...HUMAN_WEBUI)).toThrow();
    }
    const parent = registerTask(db, input, new Date(0), ...HUMAN_WEBUI);
    expect(getTask(db, parent.id)).toMatchObject({ tier: "standard", review_tier: "frontier", priority: "cost" });
    decomposeTask(db, parent, { reason: "split", children: [{ ...input, title: "child", risk_flag: true }] }, "worker", new Date(0), undefined, undefined, "worker");
    const pending = listChildren(db, parent.id).find((task) => task.type === "question")?.question_pending_child;
    expect(pending).toMatchObject({ tier: "standard", review_tier: "frontier", priority: "cost" });
  } finally { db.close(); }
});

it("reviewer names are normalized before registration, edit, and decomposition validation", () => {
  const db = openDb(":memory:");
  try {
    const input = { type: "work" as const, title: "task", purpose: "purpose", completion_criteria: "criteria" };
    expect(() => registerTask(db, { ...input, review_by: [" \t\n"] }, new Date(0), ...HUMAN_WEBUI)).toThrow();
    const task = registerTask(db, { ...input, review_by: [" auditor "] }, new Date(0), ...HUMAN_WEBUI);
    expect(task.review_by).toEqual(["auditor"]);
    expect(() => editTask(db, task, { review_by: ["auditor", " auditor "] }, new Date(0), "webui")).toThrow(/same reviewer twice/);
    editTask(db, task, { review_by: [" security "] }, new Date(0), "webui");
    expect(getTask(db, task.id)?.review_by).toEqual(["security"]);
    const children = decomposeTask(db, task, { reason: "split", children: [{ ...input, title: "child", review_flag: true, review_by: [" auditor "] }] }, "worker", new Date(0), { assignable_to: ["auditor"] }, undefined, "worker");
    expect(children[0]?.review_by).toEqual(["auditor"]);
  } finally { db.close(); }
});

it("answers reject blank text and normalize free text and fixed choices before validation and persistence", () => {
  const db = openDb(":memory:");
  try {
    const question = registerTask(db, { type: "question", title: "question", purpose: "context", completion_criteria: "answer", question: [{ title: "choose", options: ["yes", "no"], recommendation: "yes" }] }, new Date(0), ...HUMAN_WEBUI);
    expect(() => assertAnswerable(question, [" \t\n"], undefined)).toThrow();
    expect(() => answerQuestion(db, question, [" \t\n"], new Date(0), undefined, undefined, undefined, "webui")).toThrow();
    expect(getTask(db, question.id)?.status).toBe("todo");
    answerQuestion(db, question, [" another answer\n"], new Date(0), undefined, " comment stays padded ", undefined, "webui");
    expect(getTask(db, question.id)?.question_answer).toEqual(["another answer"]);
    expect(listEvents(db, question.id).find((event) => event.kind === "question_answered")?.payload).toMatchObject({ answers: [{ answer: "another answer" }], comment: " comment stays padded " });
    const parent = registerTask(db, { type: "work", title: "parent", purpose: "purpose", completion_criteria: "criteria" }, new Date(0), ...HUMAN_WEBUI);
    decomposeTask(db, parent, { reason: "split", children: [{ title: "child", purpose: "purpose", completion_criteria: "criteria", risk_flag: true }] }, "worker", new Date(0), undefined, undefined, "worker");
    const approval = listChildren(db, parent.id).find((task) => task.type === "question")!;
    expect(() => assertAnswerable(approval, [" reject "], undefined)).toThrow(/non-blank comment/);
    expect(() => assertAnswerable(approval, [" approve "], undefined)).not.toThrow();
    answerQuestion(db, approval, [" approve "], new Date(0), undefined, undefined, undefined, "webui");
    expect(listChildren(db, parent.id).find((task) => task.title === "child")?.risk_flag).toBe(1);
  } finally { db.close(); }
});

it("routing row proposals normalize their required row key and rationale before matching and saving", async () => {
  const db = openDb(":memory:");
  try {
    const review = registerTask(db, { type: "review", title: "routing review", purpose: "purpose", completion_criteria: "criteria", meta_review_subject: "routing" }, new Date(0), ...HUMAN_WEBUI);
    const input = { op: "row" as const, row: { provider: " anthropic ", model: " claude-opus-5-5\n", effort: " high " }, change: { tier: " frontier " }, rationale: " evidence\n" };
    const { question_id } = proposeRoutingChange(db, review.id, input, "worker", new Date(0));
    expect(getTask(db, question_id)?.question_proposal).toMatchObject({ row: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" } });
    expect(getTask(db, question_id)?.question_items?.[0]?.detail).toContain("Rationale: evidence\n");
    expect(() => proposeRoutingChange(db, review.id, { ...input, rationale: " \t\n" }, "worker", new Date(0))).toThrow();
    await submitAnswer({ db, pollNow() {}, landing: unusedLanding }, getTask(db, question_id)!, [" approve "], undefined, () => new Date(0), "webui");
    expect(readExecutionSettings(db).table.find((row) => row.model === "claude-opus-5-5")?.tier).toBe("frontier");
  } finally { db.close(); }
});

it("routing agent-tier proposals normalize supplied agent and target tier names before matching", () => {
  const db = openDb(":memory:");
  try {
    const review = registerTask(db, { type: "review", title: "routing review", purpose: "purpose", completion_criteria: "criteria", meta_review_subject: "routing" }, new Date(0), ...HUMAN_WEBUI);
    const task = registerTask(db, { type: "work", title: "evidence", purpose: "purpose", completion_criteria: "criteria" }, new Date(0), ...HUMAN_WEBUI);
    const evidence = [appendEvent(db, { taskId: task.id, workerId: "deckhand", origin: "board", at: new Date(0), payload: { ...WORKER_SPAWNED, model: "claude-opus-5-5", source: { tier: "agent", provider: "only" } } })];
    const agent: AgentView = { name: "deckhand", version: "1", authority: "standard", description: "agent", provider: "anthropic", advisor: false, tier: "frontier", skills: ["*"], retiredFields: [], systemPrompt: "prompt" };
    const input = { op: "agent_tier" as const, agent: " deckhand ", to: " standard\n", evidence, rationale: "evidence" };
    const { question_id } = proposeRoutingChange(db, review.id, input, "worker", new Date(0), () => [agent]);
    expect(getTask(db, question_id)?.question_proposal).toMatchObject({ kind: "registry", agent: "deckhand" });
    expect(getTask(db, question_id)?.title).toBe("Lower agent deckhand's tier: frontier -> standard");
    for (const field of ["agent", "to"] as const) {
      expect(() => proposeRoutingChange(db, review.id, { ...input, [field]: " \t\n" }, "worker", new Date(0), () => [agent])).toThrow();
    }
  } finally { db.close(); }
});

it("routing tier-description and add-tier proposals normalize required tier names and descriptions", () => {
  const db = openDb(":memory:");
  try {
    const review = registerTask(db, { type: "review", title: "routing review", purpose: "purpose", completion_criteria: "criteria", meta_review_subject: "routing" }, new Date(0), ...HUMAN_WEBUI);
    const task = registerTask(db, { type: "work", title: "evidence", purpose: "purpose", completion_criteria: "criteria", tier: "standard" }, new Date(0), ...HUMAN_WEBUI);
    const evidence = [appendEvent(db, { taskId: task.id, workerId: "worker", origin: "board", at: new Date(0), payload: { ...WORKER_SPAWNED, model: "claude-opus-5-5" } })];
    const { question_id } = proposeRoutingChange(db, review.id, { op: "tier_description", tier: " standard ", description: " new definition\n", evidence, rationale: "evidence" }, "worker", new Date(0));
    expect(getTask(db, question_id)?.question_proposal).toMatchObject({ description: "new definition" });
    expect(getTask(db, question_id)?.title).toBe("Rewrite tier standard's description");
    const added = proposeRoutingChange(db, review.id, { op: "add_tier", tier: " intermediate ", description: " tier definition\n", position: 1, row: { provider: "anthropic", model: " claude-opus-5-5 ", effort: " high " }, evidence, rationale: "evidence" }, "worker", new Date(0));
    expect(getTask(db, added.question_id)?.question_proposal).toMatchObject({ tier: { name: "intermediate", description: "tier definition" } });
  } finally { db.close(); }
});

it("objections store a trimmed required direction comment", () => {
  const db = openDb(":memory:");
  try {
    const task = registerTask(db, { type: "work", title: "parent", purpose: "purpose", completion_criteria: "criteria" }, new Date(0), ...HUMAN_WEBUI);
    const entry = logDecision(db, task, "decision", "worker", new Date(0), "worker");
    const id = raiseObjection(db, entry, " direction\n", new Date(0));
    expect(listEvents(db, task.id).find((event) => event.id === id)?.payload).toMatchObject({ comment: "direction" });
  } finally { db.close(); }
});


it("approval children cannot carry blank content and store trimmed pending content", () => {
  const db = openDb(":memory:");
  try {
    const parent = registerTask(db, { type: "work", title: "parent", purpose: "purpose", completion_criteria: "criteria" }, new Date(0), ...HUMAN_WEBUI);
    const child = { title: " ", purpose: " purpose ", completion_criteria: " criteria ", assignee: "outside" };
    const authority = { name: "limited", guidance: "", assignable_to: ["inside"] };
    expect(() => decomposeTask(db, parent, { reason: "split", children: [child] }, "worker", new Date(0), authority, undefined, "worker")).toThrow();
    decomposeTask(db, parent, { reason: "split", children: [{ ...child, title: " child " }] }, "worker", new Date(0), authority, undefined, "worker");
    expect(listChildren(db, parent.id).find((task) => task.type === "question")?.question_pending_child).toMatchObject({ title: "child", purpose: "purpose", completion_criteria: "criteria" });
  } finally { db.close(); }
});

it("decision logs normalize required lines and reject blank lines", () => {
  const db = openDb(":memory:");
  try {
    const task = registerTask(db, { type: "work", title: "task", purpose: "purpose", completion_criteria: "criteria" }, new Date(0), ...HUMAN_WEBUI);
    expect(() => logDecision(db, task, " \n", "worker", new Date(0), "worker")).toThrow();
    const id = logDecision(db, task, " decision\n", "worker", new Date(0), "worker");
    expect(listEvents(db, task.id).find((event) => event.id === id)?.payload).toMatchObject({ line: "decision" });
  } finally { db.close(); }
});

it("required worker handoff sections are trimmed before they are stored", () => {
  const db = openDb(":memory:");
  try {
    const task = registerTask(db, { type: "work", title: "task", purpose: "purpose", completion_criteria: "criteria" }, new Date(0), ...HUMAN_WEBUI);
    const handoff = { outcome: " outcome\n", deliverables: " deliverables ", decision_refs: " decisions ", dead_ends: " dead ends ", resume_context: " resume context ", known_issues: " known issues " };
    completeTask(db, task, handoff, "worker", new Date(0), "worker");
    expect(getTask(db, task.id)?.handoff_doc).toContain("## Outcome vs completion criteria\n\noutcome\n\n");
    expect(getTask(db, task.id)?.handoff_doc).toMatch(/known issues$/);
  } finally { db.close(); }
});
