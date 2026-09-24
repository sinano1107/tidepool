import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  answerQuestion,
  completeTask,
  listBoard,
  listQueue,
  nextSlotTask,
  presentTask,
  registerTask,
} from "../src/tasks.js";

const HANDOFF = {
  outcome: "done",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
} as const;

it("an unsettled decomposition child blocks the parent and prevents completion(issue #181)", () => {
  const db = openDb(":memory:");
  const parent = registerTask(
    db,
    { type: "work", title: "parent", purpose: "p", completion_criteria: "c" },
    new Date(0),
  );
  registerTask(
    db,
    {
      type: "work",
      title: "decomposed child",
      purpose: "p",
      completion_criteria: "c",
      parent_id: parent.id,
      based_on_decision: 48,
    },
    new Date(1),
  );

  expect(presentTask(db, parent).status).toBe("blocked");
  expect(() => completeTask(db, parent, HANDOFF, "worker", new Date(2))).toThrow(
    "a task with unfinished children cannot complete",
  );
  db.close();
});

it("a completion review attached to a done child does not block its parent(issue #181)", () => {
  const db = openDb(":memory:");
  const grandparent = registerTask(
    db,
    { type: "work", title: "grandparent", purpose: "p", completion_criteria: "c" },
    new Date(0),
  );
  const child = registerTask(
    db,
    {
      type: "work",
      title: "reviewed child",
      purpose: "p",
      completion_criteria: "c",
      parent_id: grandparent.id,
      based_on_decision: 48,
      review_flag: true,
    },
    new Date(1),
  );
  completeTask(db, child, HANDOFF, "worker", new Date(2));

  const board = listBoard(db);
  expect(board.find((task) => task.id === grandparent.id)?.status).toBe("todo");
  expect(
    board.find((task) => task.type === "review" && task.parent_id === child.id)?.status,
  ).toBe("todo");
  expect(presentTask(db, grandparent).status).toBe("todo");
  db.close();
});

it("answering a question returns the parent to the queue head when only attached children remain(issue #181)", () => {
  const db = openDb(":memory:");
  const other = registerTask(
    db,
    { type: "work", title: "other", purpose: "p", completion_criteria: "c" },
    new Date(0),
  );
  const parent = registerTask(
    db,
    { type: "work", title: "parent", purpose: "p", completion_criteria: "c" },
    new Date(1),
  );
  registerTask(
    db,
    {
      type: "review",
      title: "attached RCA",
      purpose: "p",
      completion_criteria: "c",
      parent_id: parent.id,
    },
    new Date(2),
  );
  const question = registerTask(
    db,
    {
      type: "question",
      title: "which way?",
      purpose: "p",
      completion_criteria: "answered",
      parent_id: parent.id,
      question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
    },
    new Date(3),
  );
  expect(presentTask(db, parent).status).toBe("blocked");

  const answered = answerQuestion(db, question, ["left"], new Date(4));

  expect(answered.parentUnblocked).toBe(true);
  expect(listQueue(db).find((task) => task.status === "todo")?.id).toBe(parent.id);
  expect(listQueue(db).findIndex((task) => task.id === parent.id)).toBeLessThan(
    listQueue(db).findIndex((task) => task.id === other.id),
  );
  expect(nextSlotTask(db)?.id).toBe(parent.id);
  db.close();
});

it("answering a proposal question does not return its parent to the queue head(issue #938)", () => {
  const db = openDb(":memory:");
  const other = registerTask(
    db,
    { type: "work", title: "other", purpose: "p", completion_criteria: "c" },
    new Date(0),
  );
  const parent = registerTask(
    db,
    { type: "work", title: "parent", purpose: "p", completion_criteria: "c" },
    new Date(1),
  );
  const question = registerTask(
    db,
    {
      type: "question",
      title: "approve?",
      purpose: "p",
      completion_criteria: "answered",
      parent_id: parent.id,
      question: [{ title: "approve?", options: ["approve", "reject"], recommendation: "approve" }],
      proposal: { kind: "memory", op: "approve", candidate_id: 1, replaces: [] },
    },
    new Date(2),
  );
  // 提案 question は付帯子(ADR 0049 / ADR 0120 決定3)なので親を塞がない — answerQuestion がそれでも動かさないことを見るには、親が他の条件では unblock 対象になる状態が要る
  expect(presentTask(db, parent).status).toBe("todo");

  const answered = answerQuestion(db, question, ["approve"], new Date(3));

  expect(answered.parentUnblocked).toBe(false);
  expect(listQueue(db).findIndex((task) => task.id === parent.id)).toBeGreaterThan(
    listQueue(db).findIndex((task) => task.id === other.id),
  );
  db.close();
});
