import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, managementMcpClient, queueWork, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("the hourly tick hands the queue head to the worker and marks it in_progress", async () => {
  t = await bootTidepool();
  const first = queueWork(t, "first in line");
  const second = queueWork(t, "second in line");

  // deterministic: just under an hour, nothing happens
  await t.clock.advance(HOUR - 1);
  expect(t.worker.started).toEqual([]);

  await t.clock.advance(1);
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const byId = Object.fromEntries(list.map((x: any) => [x.id, x]));
  expect(byId[first.id].status).toBe("in_progress");
  // an unspecified assignee is never baked in at pickup (ADR 0012 / issue
  // #36): it stays a live reference to the board's default agent, resolved
  // Board shows the current resolved assignee, while raw_assignee proves it
  // remains a live reference rather than a name baked at pickup.
  expect(byId[first.id]).toMatchObject({ assignee: "fake-worker", raw_assignee: null });
  expect(byId[second.id].status).toBe("todo");

  // slot is busy (concurrency = 1): the next tick starts nothing new
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${second.id}`)).json.status).toBe("todo");
});

// ADR 0119 決定2: 登録は pickup の契機である —— 人間の扉の2経路とも、tick を待たない
it("POST /api/tasks で登録した work タスクは tick を進めずに pickup される", async () => {
  t = await bootTidepool();

  const task = await registerWork(t, "fresh work");

  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("管理MCP の register_task で登録した work タスクも tick を進めずに pickup される", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "register_task",
      arguments: { type: "work", title: "fresh work", purpose: "p", completion_criteria: "c" },
    });

    expect(result.isError).toBeFalsy();
    expect(t.worker.started.map((x) => x.title)).toEqual(["fresh work"]);
  } finally {
    await client.close();
  }
});

it("管理MCP の decompose_task で足した子も tick を進めずに pickup される", async () => {
  t = await bootTidepool();
  const parent = queueWork(t, "parent");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({
      name: "decompose_task",
      arguments: { task_id: parent.id, reason: "split", children: [{ title: "child", purpose: "p", completion_criteria: "c" }] },
    });

    expect(result.isError).toBeFalsy();
    expect(t.worker.started.map((x) => x.title)).toEqual(["child"]);
  } finally {
    await client.close();
  }
});

it("門で弾かれた登録は poll を撃たない", async () => {
  t = await bootTidepool({ agentRegistered: (name) => name !== "ghost" });
  queueWork(t, "waiting");

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "rejected",
    purpose: "p",
    completion_criteria: "c",
    assignee: "ghost",
  });

  expect(res.status).toBe(400);
  expect(t.worker.started).toEqual([]);
});
