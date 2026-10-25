import { afterEach, expect, it } from "vitest";
import { appendEvent, listEvents } from "../src/events.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { api, bootTidepool, callAsTask, FULL_HANDOFF, managementMcpClient, mcpClient, questions, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());
const MIN = 60 * 1000;

it("HTTP stop remains unavailable when watchdog timing is not configured", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "running");
  const response = await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "stop" });
  expect(response).toMatchObject({ status: 409, json: { error: "session stopping is unavailable" } });
});

it("management stop remains unavailable when watchdog timing is not configured", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "running");
  const management = await managementMcpClient(t.baseUrl);
  try {
    const result = await management.callTool({ name: "stop_task", arguments: { task_id: task.id, reason: "stop" } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("session stopping is unavailable");
  } finally {
    await management.close();
  }
});

it("HTTP stop exposes the failure immediately, rejects late worker completion, and retries only after reclaim", async () => {
  t = await bootTidepool({ watchdog: { timeLimits: {}, grace: MIN } });
  const task = await registerWork(t, "running");
  t.containers.hold(task.id);
  const next = await registerWork(t, "next");
  const response = await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "wrong direction" });
  expect(response.status).toBe(200);
  const [failure] = await questions(t);
  expect(failure.parent_id).toBe(task.id);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toMatchObject({ taskId: task.id, humanStop: { reason: "wrong direction" } });
  const late = await callAsTask(t, task.id, "complete_task", { handoff: FULL_HANDOFF });
  expect(late.isError).toBe(true);
  expect(JSON.stringify(late)).toMatch(/session.*over/i);
  expect((await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, { answers: ["retry"] })).status).toBe(200);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.tasks.map((x: { id: string }) => x.id)).toEqual([task.id, next.id]);
  await t.clock.advance(MIN);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
  t.containers.fireEmpty(task.id);
  await new Promise((resolve) => setImmediate(resolve));
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id, task.id]);
});

it("management stop mirrors HTTP refusal and validation, and the worker has no stop tool", async () => {
  t = await bootTidepool({ watchdog: { timeLimits: {}, grace: MIN } });
  const task = await registerWork(t, "running");
  const worker = await mcpClient(t.mcpBaseUrl, task.id);
  expect((await worker.listTools()).tools.map((tool) => tool.name)).not.toContain("stop_task");
  await worker.close();
  expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: " \n " })).status).toBe(400);
  expect((await api(t.baseUrl, "POST", "/api/tasks/missing/stop", {})).status).toBe(404);
  const management = await managementMcpClient(t.baseUrl);
  try {
    expect((await management.callTool({ name: "stop_task", arguments: { task_id: task.id, reason: "   " } })).isError).toBe(true);
    expect((await management.callTool({ name: "stop_task", arguments: { task_id: task.id } })).isError).not.toBe(true);
    expect((await management.callTool({ name: "stop_task", arguments: { task_id: task.id } })).isError).toBe(true);
    expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, {})).status).toBe(409);
    const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
    expect(events.find((e: { kind: string }) => e.kind === "session_stopped_by_human").origin).toBe("mcp");
    const next = await registerWork(t, "next");
    await t.clock.advance(MIN);
    expect(t.worker.started.map((x) => x.id)).toEqual([task.id, next.id]);
  } finally {
    await management.close();
  }
});

it.each([
  { supplied: "wrong direction", answer: undefined, expected: "wrong direction" },
  { supplied: undefined, answer: undefined, expected: "not yet answered" },
  { supplied: undefined, answer: "parser was deleting files", expected: "parser was deleting files" },
])("get_current_task maps the stop reason: $expected", async ({ supplied, answer, expected }) => {
  t = await bootTidepool({ watchdog: { timeLimits: {}, grace: MIN } });
  const task = await registerWork(t, "write parser");
  await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, supplied ? { reason: supplied } : {});
  const pending = await questions(t);
  const failure = pending.find((q) => q.parent_id === task.id)!;
  const reason = pending.find((q) => q.question_stop_reason_task_id === task.id);
  if (answer) await api(t.baseUrl, "POST", `/api/tasks/${reason!.id}/answer`, { answers: [answer] });
  await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, { answers: ["retry"] });
  await t.clock.advance(MIN);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    expect(JSON.parse(result.content[0].text).history).toContainEqual({ stopped_by_human: { reason: expected } });
    const detail = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
    expect(detail.human_stops).toContainEqual({ id: expect.any(Number), reason: expected });
  } finally {
    await client.close();
  }
});

it("GET /tasks/:id human_stops carries the stop attribution's cause and evidence", async () => {
  t = await bootTidepool({ watchdog: { timeLimits: {}, grace: MIN } });
  const task = await registerWork(t, "write parser");
  await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "deleting unrelated files" });
  const stop = listEvents(t.db, task.id).find((e) => e.kind === "session_stopped_by_human")!.id;
  // setup のみ: sweep の判定を直に置く(撃つ経路は tests/stop-attribution.test.ts)
  const payload = { kind: "stop_attributed", stop_event_id: stop, cause: "capability", evidence: "removed ../other", entries: null } as const;
  appendEvent(t.db, { taskId: task.id, workerId: BOARD_WORKER_ID, origin: "board", at: t.clock.now(), payload });

  const detail = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;

  expect(detail.human_stops).toEqual([{ id: stop, reason: "deleting unrelated files", cause: "capability", evidence: "removed ../other" }]);
});
