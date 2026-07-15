import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { buildMorningDigest, recordDigestSent } from "../src/push.js";
import { answerQuestion, registerTask } from "../src/tasks.js";

function registerQuestion(db: ReturnType<typeof openDb>, title: string) {
  return registerTask(
    db,
    {
      type: "question",
      title,
      purpose: `purpose of ${title}`,
      completion_criteria: "n/a",
      question: [{ title, options: ["yes", "no"], recommendation: "yes" }],
    },
    new Date(0),
  );
}

function logDecision(db: ReturnType<typeof openDb>, taskId: string, line: string) {
  appendEvent(db, {
    taskId,
    workerId: "tidepool",
    payload: { kind: "decision_logged", line },
    at: new Date(0),
  });
}

describe("buildMorningDigest(issue #14): quiet hours 中に溜まった件数をまとめる", () => {
  it("未通知の question 件数と新規ログ件数を集計し、まとめ文言を作る", () => {
    const db = openDb(":memory:");
    const q1 = registerQuestion(db, "質問1");
    registerQuestion(db, "質問2");
    logDecision(db, q1.id, "decision A");
    logDecision(db, q1.id, "decision B");
    logDecision(db, q1.id, "decision C");

    expect(buildMorningDigest(db)).toEqual({
      questionCount: 2,
      logCount: 3,
      text: "2 questions · 3 new log entries",
    });
  });

  it("recordDigestSent の後は同じ件数を二重に数えない", () => {
    const db = openDb(":memory:");
    const q1 = registerQuestion(db, "質問1");
    logDecision(db, q1.id, "decision A");

    recordDigestSent(db, new Date(0));

    expect(buildMorningDigest(db)).toEqual({ questionCount: 0, logCount: 0, text: "0 questions · 0 new log entries" });
  });

  it("digest が発火する前にボードで直接回答済みの question は件数に数えない(code review 指摘)", () => {
    const db = openDb(":memory:");
    const answered = registerQuestion(db, "回答済み");
    registerQuestion(db, "未回答");
    answerQuestion(db, answered, ["yes"], new Date(0));

    expect(buildMorningDigest(db).questionCount).toBe(1);
  });
});
