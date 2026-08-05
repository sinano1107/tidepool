import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  answerQuestion,
  getTask,
  listChildren,
  nextSlotTask,
  presentTask,
  registerTask,
} from "../src/tasks.js";
import { abandonConsequence } from "../src/watchdog.js";

const at = new Date("2026-08-05T00:00:00.000Z");

function work(db: ReturnType<typeof openDb>, title: string, parent_id?: string, based_on_decision?: number) {
  return registerTask(
    db,
    {
      type: "work",
      title,
      purpose: `purpose of ${title}`,
      completion_criteria: `criteria of ${title}`,
      ...(parent_id && { parent_id }),
      ...(based_on_decision !== undefined && { based_on_decision }),
    },
    at,
  );
}

function failureQuestion(db: ReturnType<typeof openDb>, failedId: string) {
  return registerTask(
    db,
    {
      type: "question",
      title: "failure",
      purpose: "choose retry or abandon",
      completion_criteria: "answered",
      parent_id: failedId,
      question: [{ title: "next step", options: ["retry", "abandon"], recommendation: "retry" }],
      cancel_option: "abandon",
    },
    at,
  );
}

it("RCA self の abandon は独立した auditor と修理タスクを巻き込まない", () => {
  const db = openDb(":memory:");
  const target = work(db, "T");
  const selfReview = work(db, "RCA self", target.id);
  const auditorReview = work(db, "RCA auditor", target.id);
  const repair = work(db, "repair", target.id);
  const question = failureQuestion(db, selfReview.id);

  answerQuestion(db, question, ["abandon"], at);

  expect(getTask(db, selfReview.id)?.status).toBe("cancelled");
  expect(getTask(db, auditorReview.id)?.status).toBe("todo");
  expect(getTask(db, repair.id)?.status).toBe("todo");
  db.close();
});

it("failure question は同じ分解判断の兄弟自身だけを held にし、別判断の兄弟は pickup できる", () => {
  const db = openDb(":memory:");
  const parent = work(db, "T");
  const failed = work(db, "A", parent.id, 48);
  const sameDecision = work(db, "B", parent.id, 48);
  const otherDecision = work(db, "RCA auditor", parent.id);
  failureQuestion(db, failed.id);

  expect(presentTask(db, sameDecision).status).toBe("held");
  expect(presentTask(db, otherDecision).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(otherDecision.id);
  db.close();
});

it("abandon の説明は同判断の未決着兄弟がいるときだけ規則と件数を伝える", () => {
  const db = openDb(":memory:");
  const parent = work(db, "T");
  const failed = work(db, "A", parent.id, 48);
  work(db, "B", parent.id, 48);
  work(db, "C", parent.id, 48);
  const independent = work(db, "RCA self", parent.id);

  expect(abandonConsequence(db, failed)).toBe(
    `"abandon" discards this decomposition decision — this task's remaining work plus ` +
      `2 unfinished siblings from the same decomposition decision — and returns the parent ` +
      `to the queue head to replan.`,
  );
  expect(abandonConsequence(db, independent)).toBe(
    `"abandon" cancels this task and its remaining work.`,
  );
  db.close();
});

it("判断を持たない異議由来タスクの abandon は既存の分解判断を逆向きに破棄しない", () => {
  const db = openDb(":memory:");
  const parent = work(db, "T");
  const a = work(db, "A", parent.id, 48);
  const b = work(db, "B", parent.id, 48);
  const selfReview = work(db, "RCA self", parent.id);
  const auditorReview = work(db, "RCA auditor", parent.id);
  const question = failureQuestion(db, selfReview.id);

  answerQuestion(db, question, ["abandon"], at);

  expect(getTask(db, selfReview.id)?.status).toBe("cancelled");
  expect(getTask(db, a.id)?.status).toBe("todo");
  expect(getTask(db, b.id)?.status).toBe("todo");
  expect(getTask(db, auditorReview.id)?.status).toBe("todo");
  db.close();
});

it("承認経由で実体化した子と未回答の承認 question は同じ分解判断とともに倒れる", () => {
  const db = openDb(":memory:");
  const parent = work(db, "T");
  const failed = work(db, "A", parent.id, 48);
  const approvedQuestion = registerTask(
    db,
    {
      type: "question",
      title: "approve B",
      purpose: "approval",
      completion_criteria: "answered",
      parent_id: parent.id,
      based_on_decision: 48,
      question: [{ title: "approve B", options: ["approve", "reject"], recommendation: "approve" }],
      pending_child: {
        title: "B",
        purpose: "purpose of B",
        completion_criteria: "criteria of B",
        based_on_decision: 48,
      },
    },
    at,
  );
  answerQuestion(db, approvedQuestion, ["approve"], at);
  const approvedChild = listChildren(db, parent.id).find((task) => task.title === "B")!;
  const unansweredQuestion = registerTask(
    db,
    {
      type: "question",
      title: "approve C",
      purpose: "approval",
      completion_criteria: "answered",
      parent_id: parent.id,
      based_on_decision: 48,
      question: [{ title: "approve C", options: ["approve", "reject"], recommendation: "approve" }],
      pending_child: {
        title: "C",
        purpose: "purpose of C",
        completion_criteria: "criteria of C",
        based_on_decision: 48,
      },
    },
    at,
  );
  const failure = failureQuestion(db, failed.id);

  answerQuestion(db, failure, ["abandon"], at);

  expect(getTask(db, approvedChild.id)?.based_on_decision).toBe(48);
  expect(getTask(db, approvedChild.id)?.status).toBe("cancelled");
  expect(getTask(db, unansweredQuestion.id)?.status).toBe("cancelled");
  db.close();
});
