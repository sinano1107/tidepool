import { expect, it, onTestFinished } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { questionKindOf } from "../src/question-kind.js";
import { getTask, listChildren, pickupTask, presentTask, registerTask, taskHistoryRows } from "../src/tasks.js";
import { markTeardown, sessionInTeardown } from "../src/teardown.js";
import { recordHumanStop } from "../src/watchdog.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "../src/worker-id.js";
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
  expect(listEvents(db, question!.id).find((e) => e.kind === "task_registered")).toMatchObject({ worker_id: BOARD_WORKER_ID, origin: "board" });
  const stop = listEvents(db, task.id).find((e) => e.kind === "session_stopped_by_human");
  expect(stop).toMatchObject({ worker_id: HUMAN_WORKER_ID, origin: "webui" });
  expect(stop!.payload).toEqual({ kind: "session_stopped_by_human", ...(reason ? { reason } : {}) });
  expect(sessionInTeardown(db)).toMatchObject({ taskId: task.id });
  expect(sessionInTeardown(db)).toHaveProperty("humanStop", { reason: reason ?? null });
  expect(taskHistoryRows(db, task.id).at(-1)?.entry).toEqual({ stopped_by_human: { reason: reason ?? null } });
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
