import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** Today's system has no code path that ever drives a `human`-assignee task
 *  into `in_progress` (pickupTask, the sole writer of that status, is only
 *  ever called by the scheduler's slot-bound pickup — a human task always
 *  stays outside the slot, per CONTEXT.md's Slot / issue #13's your-tasks
 *  list). CONTEXT.md's Decompose exception ("自分の human タスクは実行中で
 *  も割ってよい") is nonetheless part of the gate's own definition, so this
 *  drives the DB row into that state directly (bypassing the status machine,
 *  the same technique tests/harness.ts's own quarantineAgentRow uses) to
 *  exercise the exception at the seam that actually reads it — the gate
 *  itself only looks at the Task row's fields, never how it got there. */
function forceInProgress(t: Tidepool, taskId: string): void {
  t.db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(taskId);
}

it("実行中でも、自分自身(assignee: human)のタスクへの子追加は許可される", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "my own task", undefined, undefined, "human");
  forceInProgress(t, parent.id);

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "split off piece",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "split off the current piece",
  });

  expect(res.status).toBe(201);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "split off piece")).toBeDefined();
});

it("実行中の他人(agent)のタスクへの子追加は拒否される(対照)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "someone else's task");
  forceInProgress(t, parent.id);

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "split off piece",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "split the other task",
  });

  expect(res.status).toBe(400);
});
