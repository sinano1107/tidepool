import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { appendEvent, listEvents } from "../src/events.js";
import { projectAndPersist } from "../src/precedent.js";
import { getTask, logDecision, registerTask } from "../src/tasks.js";
import { api, bootTidepool, bundledObjection, callAsTask, FULL_HANDOFF, managementMcpClient, mcpClient, nextPoll, questions, registerWork, type Tidepool, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";

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
    expect(JSON.parse(result.content[0].text).history).toContainEqual({ id: expect.any(Number), stopped_by_human: { reason: expected } });
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
  const payload = { kind: "stop_attributed", stop_event_id: stop, cause: "capability", evidence: "removed ../other", wrong_memory_entries: null, round: "initial" } as const;
  appendEvent(t.db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", at: t.clock.now(), payload });

  const detail = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;

  expect(detail.human_stops).toEqual([{ id: stop, reason: "deleting unrelated files", cause: "capability", evidence: "removed ../other" }]);
});

/** setup: worker が判断を1行書いた session を理由つきで止めて abandon し、slot が空いてから、その task の付帯子に RCA を直に登録して
 *  拾わせる(停止の帰責からの登録の経路は tests/stop-attribution.test.ts)。材料は停止 event か、判断の行への異議。 */
async function runningRca(material: "stop" | "objection", transcript?: string[]) {
  t = await bootTidepool({ watchdog: { timeLimits: {}, grace: MIN } });
  const task = await registerWork(t, "write parser");
  const spawned = appendEvent(t.db, { taskId: task.id, actorId: "deckhand", origin: "board", at: t.clock.now(), payload: WORKER_SPAWNED });
  const entry = logDecision(t.db, getTask(t.db, task.id)!, "deleted the fixtures", "deckhand", t.clock.now(), "worker");
  await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "deleting unrelated files" });
  const failure = (await questions(t)).find((q) => q.parent_id === task.id)!;
  await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, { answers: ["abandon"] });
  await t.clock.advance(MIN);
  const stop = listEvents(t.db, task.id).find((e) => e.kind === "session_stopped_by_human")!.id;
  if (transcript) {
    const transcriptPath = join(await tempDir("tidepool-stop-rca-"), "session.jsonl");
    writeFileSync(transcriptPath, transcript.join("\n"));
    projectAndPersist(t.db, { workerSpawnedEventId: spawned, transcriptPath });
  }
  const opened_on_event_ids = material === "stop" ? [stop] : [bundledObjection(t.db, task.id, entry, t.clock.now())];
  const rca = registerTask(t.db, { type: "review", title: "rca (auditor): write parser", purpose: "p", completion_criteria: "c", parent_id: task.id, opened_on_event_ids }, t.clock.now(), BOARD_ACTOR_ID, "board");
  await nextPoll(t);
  const client = await mcpClient(t.mcpBaseUrl, rca.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe(rca.id);
    return { payload, material: material === "stop" ? stop : entry };
  } finally {
    await client.close();
  }
}

it("get_current_task of an RCA opened on a stop carries the stopped session's actions", async () => {
  const { payload } = await runningRca("stop", [
    '{"type":"assistant","uuid":"u1","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"rm -rf ../other"}}]}}',
    '{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
  ]);

  expect(payload.actions.calls).toHaveLength(1);
});

it("get_current_task of an RCA opened on a stop whose session has no Episode says actions null", async () => {
  expect((await runningRca("stop")).payload).toHaveProperty("actions", null);
});

it("get_current_task of an RCA opened on objections carries no actions", async () => {
  expect((await runningRca("objection")).payload).not.toHaveProperty("actions");
});

it.each(["stop", "objection"] as const)("get_current_task of an RCA opened on a %s carries the material ids complete_rca takes, and complete_rca's description points at them (ADR 0322 決定4)", async (material) => {
  const { payload, material: opened } = await runningRca(material);

  expect(payload.material).toEqual([opened]);
  const client = await mcpClient(t.mcpBaseUrl, payload.id);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "complete_rca")!.description).toContain("material in get_current_task");
  } finally {
    await client.close();
  }
  const completed = await callAsTask(t, payload.id, "complete_rca", { findings: [{ material: payload.material, root_cause: "no guard on rm", no_act: true }] });
  expect(completed.isError).toBeFalsy();
});
