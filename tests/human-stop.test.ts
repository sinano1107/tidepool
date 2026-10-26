import { expect, it, onTestFinished } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { questionKindOf } from "../src/question-kind.js";
import { answerQuestion, getTask, listBoard, listChildren, nextSlotTask, pickupTask, presentTask, registerTask, taskHistoryRows } from "../src/tasks.js";
import { markTeardown, sessionInTeardown } from "../src/teardown.js";
import { recordHumanStop } from "../src/watchdog.js";
import { failTeardownMark, HUMAN_WEBUI, interviewExaminee, judgmentRepairTask, routingJudgmentRepairTask } from "./harness.js";

const now = new Date(0);
function fixture() {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const task = registerTask(db, { type: "work", title: "write parser", purpose: "parse", completion_criteria: "works" }, now, ...HUMAN_WEBUI);
  return { db, task };
}

it.each(["wrong direction", undefined])("human stop records the board failure question, human event and teardown together (reason: %s)", (reason) => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  recordHumanStop(db, task.id, reason, now, "webui");
  const [question] = listChildren(db, task.id);
  expect(question).toMatchObject({ title: "stopped by human: write parser", question_cancel_option: "abandon", question_items: [{ title: "stopped by human: write parser", options: ["retry", "abandon"], recommendation: "retry" }] });
  expect(questionKindOf(question!)).toEqual({ kind: "failure", cancel_option: "abandon" });
  if (reason) expect(question!.purpose).toContain(reason);
  expect(listEvents(db, question!.id).find((e) => e.kind === "task_registered")).toMatchObject({ actor_id: BOARD_ACTOR_ID, origin: "board" });
  const stop = listEvents(db, task.id).find((e) => e.kind === "session_stopped_by_human");
  expect(stop).toMatchObject({ actor_id: HUMAN_ACTOR_ID, origin: "webui" });
  expect(stop!.payload).toEqual({ kind: "session_stopped_by_human", ...(reason ? { reason } : { reason_question_id: expect.any(String) }) });
  expect(sessionInTeardown(db)).toMatchObject({ taskId: task.id });
  expect(sessionInTeardown(db)).toHaveProperty("humanStop", { reason: reason ?? null });
  expect(taskHistoryRows(db, task.id).at(-1)?.entry).toEqual({ stopped_by_human: { reason: reason ?? "not yet answered" } });
  expect(presentTask(db, getTask(db, task.id)!).status).toBe("blocked");
});

it("a failed teardown mark rolls back the human stop's question and event", () => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  const events = listEvents(db, task.id);
  failTeardownMark(db);
  expect(() => recordHumanStop(db, task.id, "stop", now, "mcp")).toThrow("teardown mark failed");
  expect(listChildren(db, task.id)).toEqual([]);
  expect(listEvents(db, task.id)).toEqual(events);
  expect(getTask(db, task.id)?.status).toBe("in_progress");
  expect(sessionInTeardown(db)).toBeUndefined();
});

it("stopping an examinee keeps the failure question's human-only notice", () => {
  const { db } = fixture();
  const examinee = interviewExaminee(db, now);
  pickupTask(db, examinee, "deckhand", now);
  recordHumanStop(db, examinee.id, undefined, now, "mcp");
  expect(listChildren(db, examinee.id)[0]!.purpose).toContain("only this target");
  expect(JSON.stringify(taskHistoryRows(db, examinee.id))).not.toContain("only this target");
});

it.each(["review", "interview", "memory_repair", "routing_repair"] as const)("human stop accepts a running %s session", (type) => {
  const { db } = fixture();
  const task = type === "memory_repair" ? judgmentRepairTask(db, now)
    : type === "routing_repair" ? routingJudgmentRepairTask(db, now)
    : registerTask(db, type === "interview"
      ? { type, title: "interview", hypothesis: "writes a parser", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] }
      : { type, title: "review", purpose: "review work", completion_criteria: "reviewed" }, now, ...HUMAN_WEBUI);
  pickupTask(db, task, "deckhand", now);
  recordHumanStop(db, task.id, undefined, now, "mcp");
  expect(presentTask(db, getTask(db, task.id)!).status).toBe("blocked");
});

it.each([false, true])("refuses a non-running or already ending task without writes (ending: %s)", (ending) => {
  const { db, task } = fixture();
  if (ending) {
    pickupTask(db, task, "deckhand", now);
    markTeardown(db, task.id, now);
  }
  const events = listEvents(db, task.id);
  expect(() => recordHumanStop(db, task.id, undefined, now, "webui")).toThrow(DomainError);
  expect(listChildren(db, task.id)).toEqual([]);
  expect(listEvents(db, task.id)).toEqual(events);
});

it("a reasonless stop asks the human in a separate board root linked to the stop", () => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  recordHumanStop(db, task.id, undefined, now, "webui");
  const reason = listBoard(db).find((q) => q.title === 'why did you stop "write parser"?')!;
  expect(reason).toMatchObject({ type: "question", parent_id: null, status: "todo" });
  expect(questionKindOf(reason)).toEqual({ kind: "stop_reason", task_id: task.id });
  expect(listEvents(db, reason.id)[0]).toMatchObject({ actor_id: BOARD_ACTOR_ID, origin: "board" });
  expect(listEvents(db, task.id).find((e) => e.kind === "session_stopped_by_human")!.payload).toEqual({ kind: "session_stopped_by_human", reason_question_id: reason.id });
});

it("a reasonless stop's reason question takes free text only: its item has no options and no recommendation", () => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  recordHumanStop(db, task.id, undefined, now, "webui");
  const reason = listBoard(db).find((q) => q.question_stop_reason_task_id === task.id)!;
  expect(reason.question_items).toEqual([{ title: 'why did you stop "write parser"?', options: [] }]);
});

it("an answer to the reason question is not counted for or against a recommendation it never carried", () => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  recordHumanStop(db, task.id, undefined, now, "webui");
  const reason = getTask(db, listBoard(db).find((q) => q.question_stop_reason_task_id === task.id)!.id)!;
  answerQuestion(db, reason, ["parser was deleting unrelated files"], now, undefined, undefined, undefined, "webui");
  expect(listEvents(db, reason.id).find((e) => e.kind === "question_answered")!.payload).toMatchObject({ answers: [{ answer: "parser was deleting unrelated files", recommendation_accepted: null }] });
  expect(listEvents(db, reason.id).find((e) => e.kind === "question_answered")!.payload).not.toHaveProperty("recommended_by");
});

it.each(["retry", "abandon"])("the root reason question survives %s and does not block retry", (answer) => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  recordHumanStop(db, task.id, undefined, now, "webui");
  const reason = listBoard(db).find((q) => q.question_stop_reason_task_id === task.id)!;
  answerQuestion(db, listChildren(db, task.id)[0]!, [answer], now, undefined, undefined, undefined, "webui");
  expect(getTask(db, reason.id)!.status).toBe("todo");
  if (answer === "retry") expect(nextSlotTask(db)?.id).toBe(task.id);
  else expect(getTask(db, task.id)!.status).toBe("cancelled");
});

it("the stop history resolves the pending question and its nonblank free-text answer", () => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  recordHumanStop(db, task.id, undefined, now, "webui");
  const reason = getTask(db, listBoard(db).find((q) => q.question_stop_reason_task_id === task.id)!.id)!;
  expect(taskHistoryRows(db, task.id).at(-1)?.entry).toEqual({ stopped_by_human: { reason: "not yet answered" } });
  expect(() => answerQuestion(db, reason, [" \n "], now, undefined, undefined, undefined, "webui")).toThrow("answers cannot be blank");
  answerQuestion(db, reason, ["  parser was deleting unrelated files  "], now, undefined, undefined, undefined, "webui");
  expect(getTask(db, reason.id)!.status).toBe("done");
  expect(taskHistoryRows(db, task.id).at(-1)?.entry).toEqual({ stopped_by_human: { reason: "parser was deleting unrelated files" } });
});

it("a supplied stop reason needs no reason question", () => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  recordHumanStop(db, task.id, "wrong direction", now, "webui");
  expect(listBoard(db).filter((q) => q.question_stop_reason_task_id !== null)).toEqual([]);
});

it("a reasonless stop rolls its root question back if teardown cannot be marked", () => {
  const { db, task } = fixture();
  pickupTask(db, task, "deckhand", now);
  failTeardownMark(db);
  expect(() => recordHumanStop(db, task.id, undefined, now, "webui")).toThrow("teardown mark failed");
  expect(listBoard(db).map((q) => q.id)).toEqual([task.id]);
  expect(listEvents(db, task.id).some((e) => e.kind === "session_stopped_by_human")).toBe(false);
  expect(getTask(db, task.id)!.status).toBe("in_progress");
});
