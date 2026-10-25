import { expect, it, onTestFinished } from "vitest";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { listEvents } from "../src/events.js";
import { questionKindOf } from "../src/question-kind.js";
import { cancelTaskDirectly, getTask, listBoard, listChildren, pickupTask, registerTask } from "../src/tasks.js";
import { markTeardown, sessionInTeardown } from "../src/teardown.js";
import { recordHumanStop } from "../src/watchdog.js";
import { failTeardownMark, HUMAN_WEBUI, humanDecomposeTaskViaWebui } from "./harness.js";

const now = new Date(0);
function fixture() {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const root = registerTask(db, { type: "work", title: "plan", purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI);
  const [child] = humanDecomposeTaskViaWebui(db, root, { reason: "split", children: [{ title: "running child", purpose: "p", completion_criteria: "c" }] }, now);
  pickupTask(db, child!, "deckhand", now);
  return { db, root, child: child! };
}

it("direct cancel refuses with the running descendant's kind, id and title without writes", () => {
  const { db, root, child } = fixture();
  const events = listEvents(db, root.id);
  try {
    cancelTaskDirectly(db, root, null, now, {}, "webui");
    expect.fail("cancel must require approval");
  } catch (err) {
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ details: { kind: "running_task", task_id: child.id, title: "running child" } });
    expect((err as Error).message).toContain("cancel again with approval");
  }
  expect(getTask(db, root.id)!.status).toBe("todo");
  expect(getTask(db, child.id)!.status).toBe("in_progress");
  expect(listEvents(db, root.id)).toEqual(events);
});

it("approval of the running descendant cancels every felled task with the reason and stops without a failure question", () => {
  const { db, root, child } = fixture();
  cancelTaskDirectly(db, root, "work no longer needed", now, {}, "webui", undefined, {
    taskId: child.id,
    stop: (cancel) => recordHumanStop(db, child.id, "work no longer needed", now, "webui", cancel),
  });
  for (const task of [root, child]) {
    expect(getTask(db, task.id)!.status).toBe("cancelled");
    expect(listEvents(db, task.id).find((e) => e.kind === "task_cancelled_directly")!.payload).toEqual({ kind: "task_cancelled_directly", reason: "work no longer needed" });
  }
  expect(listChildren(db, child.id)).toEqual([]);
  expect(listEvents(db, child.id).find((e) => e.kind === "session_stopped_by_human")).toMatchObject({ actor_id: "human", origin: "webui", payload: { reason: "work no longer needed" } });
  expect(sessionInTeardown(db)).toMatchObject({ taskId: child.id, humanStop: { reason: "work no longer needed" } });
});

it("a running root can itself be approved and a missing reason is asked in a separate root", () => {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const root = registerTask(db, { type: "work", title: "running root", purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI);
  pickupTask(db, root, "deckhand", now);
  cancelTaskDirectly(db, getTask(db, root.id)!, null, now, {}, "mcp", undefined, {
    taskId: root.id,
    stop: (cancel) => recordHumanStop(db, root.id, undefined, now, "mcp", cancel),
  });
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  const reason = listBoard(db).find((q) => q.question_stop_reason_task_id === root.id)!;
  expect(reason).toMatchObject({ parent_id: null, type: "question", status: "todo" });
  expect(questionKindOf(reason)).toEqual({ kind: "stop_reason", task_id: root.id });
  expect(listEvents(db, root.id).find((e) => e.kind === "session_stopped_by_human")!.payload).toEqual({ kind: "session_stopped_by_human", reason_question_id: reason.id });
  expect(listChildren(db, root.id)).toEqual([]);
});

it("an approval for another task names the current running task and leaves the plan untouched", () => {
  const { db, root, child } = fixture();
  const events = listEvents(db, child.id);
  expect(() => cancelTaskDirectly(db, root, null, now, {}, "webui", undefined, {
    taskId: "previous-session-task",
    stop: () => expect.fail("a mismatched approval must not stop anything"),
  })).toThrow(expect.objectContaining({ details: { kind: "running_task", task_id: child.id, title: child.title } }));
  expect(getTask(db, root.id)!.status).toBe("todo");
  expect(getTask(db, child.id)!.status).toBe("in_progress");
  expect(listEvents(db, child.id)).toEqual(events);
});

it.each(["given reason", undefined])("a failed teardown mark rolls back cancellation, the stop and any reason question (%s)", (reason) => {
  const { db, root, child } = fixture();
  const events = [listEvents(db, root.id), listEvents(db, child.id)];
  failTeardownMark(db);
  expect(() => cancelTaskDirectly(db, root, reason ?? null, now, {}, "webui", undefined, {
    taskId: child.id,
    stop: (cancel) => recordHumanStop(db, child.id, reason, now, "webui", cancel),
  })).toThrow("teardown mark failed");
  expect(getTask(db, root.id)!.status).toBe("todo");
  expect(getTask(db, child.id)!.status).toBe("in_progress");
  expect([listEvents(db, root.id), listEvents(db, child.id)]).toEqual(events);
  expect(listBoard(db).map((task) => task.id)).toEqual([root.id, child.id]);
  expect(sessionInTeardown(db)).toBeUndefined();
});

it("an already ending session cannot be cancelled through stop approval", () => {
  const { db, root, child } = fixture();
  markTeardown(db, child.id, now);
  const events = listEvents(db, child.id);
  expect(() => cancelTaskDirectly(db, root, null, now, {}, "webui", undefined, {
    taskId: child.id,
    stop: (cancel) => recordHumanStop(db, child.id, undefined, now, "webui", cancel),
  })).toThrow("already ending");
  expect(getTask(db, root.id)!.status).toBe("todo");
  expect(getTask(db, child.id)!.status).toBe("in_progress");
  expect(listEvents(db, child.id)).toEqual(events);
});
