import { afterEach, expect, it } from "vitest";
import { pickupTask, registerTask } from "../src/tasks.js";
import { api, bootTidepool, callAsTask, FULL_HANDOFF, HUMAN_WEBUI, humanDecomposeTaskViaWebui, managementMcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());
const MIN = 60 * 1000;

it("HTTP cancel maps a running descendant's refusal to kind, id and title", async () => {
  t = await bootTidepool();
  const root = registerTask(t.db, { type: "work", title: "plan", purpose: "p", completion_criteria: "c" }, t.clock.now(), ...HUMAN_WEBUI);
  const [child] = humanDecomposeTaskViaWebui(t.db, root, { reason: "split", children: [{ title: "running child", purpose: "p", completion_criteria: "c" }] }, t.clock.now());
  pickupTask(t.db, child!, "deckhand", t.clock.now());
  const response = await api(t.baseUrl, "POST", `/api/tasks/${root.id}/cancel`, {});
  expect(response.status).toBe(400);
  expect(response.json).toMatchObject({ kind: "running_task", task_id: child!.id, title: child!.title, error: expect.stringContaining("cancel again with approval") });
});

it("an HTTP-approved cancel closes the worker door immediately and picks up the next task only after reclaim", async () => {
  t = await bootTidepool({ watchdog: { timeLimits: {}, grace: MIN } });
  const task = await registerWork(t, "running root");
  t.containers.hold(task.id);
  const next = await registerWork(t, "next");
  const response = await api(t.baseUrl, "POST", `/api/tasks/${task.id}/cancel`, { stop_approval: task.id, reason: "work no longer needed" });
  expect(response.status).toBe(200);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toMatchObject({ taskId: task.id, humanStop: { reason: "work no longer needed" } });
  const late = await callAsTask(t, task.id, "complete_task", { handoff: FULL_HANDOFF });
  expect(late.isError).toBe(true);
  expect(JSON.stringify(late)).toMatch(/session.*over/i);
  await t.clock.advance(MIN);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  t.containers.fireEmpty(task.id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, next.id]);
});

it("management cancel names the running task and accepts its pinned approval through the same tool", async () => {
  t = await bootTidepool({ watchdog: { timeLimits: {}, grace: MIN } });
  const task = await registerWork(t, "running root");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const refusal = await client.callTool({ name: "cancel_task", arguments: { task_id: task.id } });
    expect(refusal.isError).toBe(true);
    expect(JSON.stringify(refusal)).toContain(task.id);
    expect(JSON.stringify(refusal)).toContain("stop_approval");
    const cancelled = await client.callTool({ name: "cancel_task", arguments: { task_id: task.id, stop_approval: task.id, reason: "no longer needed" } });
    expect(cancelled.isError).not.toBe(true);
    expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toMatchObject({ taskId: task.id, humanStop: { reason: "no longer needed" } });
  } finally {
    await client.close();
  }
});

it("approval cannot commit a cancellation when the live slot does not own the running task", async () => {
  t = await bootTidepool({ watchdog: { timeLimits: {}, grace: MIN } });
  const task = registerTask(t.db, { type: "work", title: "stale running record", purpose: "p", completion_criteria: "c" }, t.clock.now(), ...HUMAN_WEBUI);
  pickupTask(t.db, task, "deckhand", t.clock.now());
  const response = await api(t.baseUrl, "POST", `/api/tasks/${task.id}/cancel`, { stop_approval: task.id });
  expect(response.status).toBe(400);
  expect(response.json.error).toContain("nothing running");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
});

it("HTTP and management cancel reject blank reasons and blank stop approvals", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "running root");
  const client = await managementMcpClient(t.baseUrl);
  try {
    for (const input of [{ reason: " \n " }, { stop_approval: " \n " }]) {
      expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/cancel`, input)).status).toBe(400);
      expect((await client.callTool({ name: "cancel_task", arguments: { task_id: task.id, ...input } })).isError).toBe(true);
    }
  } finally {
    await client.close();
  }
});
