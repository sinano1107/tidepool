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

// issue #116: an agent-registered human task (worker_id != 'human') is a
// digest count of its own, alongside questions.
function registerHumanTask(
  db: ReturnType<typeof openDb>,
  title: string,
  workerId: string,
) {
  return registerTask(
    db,
    { type: "work", title, purpose: `purpose of ${title}`, completion_criteria: "n/a", assignee: "human" },
    new Date(0),
    workerId,
  );
}

function logDecision(db: ReturnType<typeof openDb>, taskId: string, line: string) {
  appendEvent(db, {
    taskId,
    workerId: "tidepool",
    origin: "webui",
    payload: { kind: "decision_logged", line },
    at: new Date(0),
  });
}

describe("buildMorningDigest(issue #14 / #116): quiet hours 中に溜まった件数をまとめる", () => {
  it("未通知の question 件数・human タスク件数・新規ログ件数を集計し、3件数のまとめ文言を作る", () => {
    const db = openDb(":memory:");
    const q1 = registerQuestion(db, "質問1");
    registerQuestion(db, "質問2");
    registerHumanTask(db, "水やりして", "planner");
    logDecision(db, q1.id, "decision A");
    logDecision(db, q1.id, "decision B");
    logDecision(db, q1.id, "decision C");

    expect(buildMorningDigest(db)).toEqual({
      questionCount: 2,
      yourTaskCount: 1,
      logCount: 3,
      text: "2 questions · 1 your tasks · 3 new log entries",
    });
  });

  it("human 自身の操作で登録された human タスク(worker_id = 'human')は件数に数えない", () => {
    const db = openDb(":memory:");
    registerHumanTask(db, "agent が委譲", "planner");
    registerHumanTask(db, "自分でメモ", "human");

    expect(buildMorningDigest(db).yourTaskCount).toBe(1);
  });

  it("recordDigestSent の後は同じ件数を二重に数えない(question も human タスクも)", () => {
    const db = openDb(":memory:");
    const q1 = registerQuestion(db, "質問1");
    registerHumanTask(db, "水やりして", "planner");
    logDecision(db, q1.id, "decision A");

    recordDigestSent(db, new Date(0));

    expect(buildMorningDigest(db)).toEqual({
      questionCount: 0,
      yourTaskCount: 0,
      logCount: 0,
      text: "0 questions · 0 your tasks · 0 new log entries",
    });
  });

  it("digest が発火する前にボードで直接回答済みの question は件数に数えない(code review 指摘)", () => {
    const db = openDb(":memory:");
    const answered = registerQuestion(db, "回答済み");
    registerQuestion(db, "未回答");
    answerQuestion(db, answered, ["yes"], new Date(0));

    expect(buildMorningDigest(db).questionCount).toBe(1);
  });
});
