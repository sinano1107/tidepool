import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  FULL_HANDOFF as fullHandoff,
  HOUR,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

function queueIds(list: any[]): string[] {
  // "work" only: a restart-time failure escalation (#9) can add its own
  // question task to the todo list, which isn't part of the work ordering
  // these tests are about
  return list.filter((x) => x.status === "todo" && x.type === "work").map((x) => x.id);
}

/** Park a filler task in the slot so reordering below never triggers a pickup:
 *  a queue-head change while the slot is free immediately executes the new head. */
async function occupySlot(t: Tidepool) {
  const filler = await registerWork(t, "occupies the slot");
  await t.clock.advance(HOUR);
  return filler;
}

it("moving a task to the head (after: null) reorders the queue, surviving a restart", async () => {
  t = await bootTidepool();
  await occupySlot(t);
  const a = await registerWork(t, "a");
  const b = await registerWork(t, "b");
  const c = await registerWork(t, "c");

  const res = await api(t.baseUrl, "POST", `/api/tasks/${c.id}/move`, { after: null });
  expect(res.status).toBe(200);

  expect(queueIds((await api(t.baseUrl, "GET", "/api/tasks")).json)).toEqual([c.id, a.id, b.id]);

  // the order is a fact on the board, not in the process
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });
  expect(queueIds((await api(t.baseUrl, "GET", "/api/tasks")).json)).toEqual([c.id, a.id, b.id]);
});

it("moving a task after another slots it between that task and its next neighbour", async () => {
  t = await bootTidepool();
  await occupySlot(t);
  const a = await registerWork(t, "a");
  const b = await registerWork(t, "b");
  const c = await registerWork(t, "c");

  const res = await api(t.baseUrl, "POST", `/api/tasks/${c.id}/move`, { after: a.id });
  expect(res.status).toBe(200);

  expect(queueIds((await api(t.baseUrl, "GET", "/api/tasks")).json)).toEqual([a.id, c.id, b.id]);
});

it("a task registered after manual reordering still joins the queue tail", async () => {
  t = await bootTidepool();
  await occupySlot(t);
  const a = await registerWork(t, "a");
  const b = await registerWork(t, "b");
  await api(t.baseUrl, "POST", `/api/tasks/${b.id}/move`, { after: null });

  const c = await registerWork(t, "c");

  expect(queueIds((await api(t.baseUrl, "GET", "/api/tasks")).json)).toEqual([b.id, a.id, c.id]);
});

it("a move is appended to the task's event log, attributed to the human worker", async () => {
  t = await bootTidepool();
  await occupySlot(t);
  await registerWork(t, "a");
  const b = await registerWork(t, "b");
  await api(t.baseUrl, "POST", `/api/tasks/${b.id}/move`, { after: null });

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${b.id}/events`)).json;
  const moved = events.filter((e: any) => e.kind === "task_moved");
  expect(moved).toHaveLength(1);
  expect(moved[0].worker_id).toBe("human");
  expect(moved[0].payload).toEqual({ kind: "task_moved", after: null });
});

it("reordering is a human steering channel: no MCP tool exposes it", async () => {
  t = await bootTidepool();
  const client = await mcpClient(t.mcpBaseUrl);
  const { tools } = await client.listTools();
  const names = tools.map((x) => x.name);
  expect(names).not.toContain("move_task");
  expect(names.filter((n) => /move|reorder|sort/.test(n))).toEqual([]);
  await client.close();
});

it("promoting a non-head task to the head reorders it without firing an immediate poll", async () => {
  t = await bootTidepool();
  await registerWork(t, "a");
  const b = await registerWork(t, "b");

  // slot is free, but promoting b is pure reordering — it wasn't already at
  // the head, so this isn't "run now" (issue #82 follow-up)
  await api(t.baseUrl, "POST", `/api/tasks/${b.id}/move`, { after: null });
  expect(t.worker.started).toEqual([]);

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([b.id]);
});

it("a promoted task can then be run now once it is the head", async () => {
  t = await bootTidepool();
  await registerWork(t, "a");
  const b = await registerWork(t, "b");

  await api(t.baseUrl, "POST", `/api/tasks/${b.id}/move`, { after: null }); // promote only
  expect(t.worker.started).toEqual([]);

  await api(t.baseUrl, "POST", `/api/tasks/${b.id}/move`, { after: null }); // b is now head: run now
  expect(t.worker.started.map((x) => x.id)).toEqual([b.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${b.id}`)).json.status).toBe("in_progress");
});

it("a reorder that leaves the queue head unchanged does not fire an immediate poll", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "a");
  await registerWork(t, "b");
  const c = await registerWork(t, "c");

  // a stays at the head: no human said "run now", so the slot stays idle
  await api(t.baseUrl, "POST", `/api/tasks/${c.id}/move`, { after: a.id });
  expect(t.worker.started).toEqual([]);

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([a.id]);
});

it("run-now on the task already at the head still fires the immediate poll", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "a");

  // the head's front button is the human's immediate-poll trigger
  await api(t.baseUrl, "POST", `/api/tasks/${a.id}/move`, { after: null });
  expect(t.worker.started.map((x) => x.id)).toEqual([a.id]);
});

it("moving the head task down does not fire an immediate poll for the new head", async () => {
  t = await bootTidepool();
  const a = await registerWork(t, "a");
  const b = await registerWork(t, "b");

  await api(t.baseUrl, "POST", `/api/tasks/${a.id}/move`, { after: b.id });
  expect(t.worker.started).toEqual([]);

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([b.id]);
});

it("a non-todo task can be moved — board order is global — without firing a run-now", async () => {
  t = await bootTidepool();
  // review_flag keeps a's tree unsettled after completion (its auto-generated
  // review child starts todo) — issue #35's board otherwise retreats a
  // standalone done task the instant its whole tree settles, which would
  // make it disappear from the list this test inspects
  const a = await registerWork(t, "a", undefined, true);
  const b = await registerWork(t, "b");
  await t.clock.advance(HOUR); // a picked up
  const client = await mcpClient(t.mcpBaseUrl, a.id);
  const done: any = await client.callTool({
    name: "complete_task",
    arguments: { handoff: fullHandoff },
  });
  expect(done.isError ?? false).toBe(false);
  await client.close();

  // slot is free and b heads the queue, but surfacing a done task on the
  // board is a display move, not a "run now"
  const res = await api(t.baseUrl, "POST", `/api/tasks/${a.id}/move`, { after: null });
  expect(res.status).toBe(200);
  expect(t.worker.started.map((x) => x.id)).toEqual([a.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${b.id}`)).json.status).toBe("todo");

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.filter((x: any) => x.id === a.id || x.id === b.id).map((x: any) => x.id)).toEqual([
    a.id,
    b.id,
  ]);
});

it("a todo task can be placed after a non-todo task", async () => {
  t = await bootTidepool();
  const filler = await occupySlot(t);
  const a = await registerWork(t, "a");
  const b = await registerWork(t, "b");

  const res = await api(t.baseUrl, "POST", `/api/tasks/${b.id}/move`, { after: filler.id });
  expect(res.status).toBe(200);
  expect(queueIds((await api(t.baseUrl, "GET", "/api/tasks")).json)).toEqual([b.id, a.id]);
});
