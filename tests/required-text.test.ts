import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { normalizeText, whyBlank } from "../src/required-text.js";
import { completeTask, decomposeTask, editTask, getTask, listChildren, logDecision, registerTask } from "../src/tasks.js";
import { raiseObjection } from "../src/triage.js";
import { HUMAN_WEBUI } from "./harness.js";

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
