import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("未決着・実行中でない親への人間の子追加は成功し、追加した子タスクがそのまま返る", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose of child",
    completion_criteria: "criteria of child",
    parent_id: parent.id,
  });

  expect(res.status).toBe(201);
  expect(res.json.parent_id).toBe(parent.id);
  expect(res.json.title).toBe("child");
  expect(res.json.type).toBe("work");

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "child")).toBeDefined();
  expect(board.find((x: any) => x.id === parent.id).status).toBe("blocked");
});

it("分解理由を書くと decision log エントリとして残る", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");

  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "splitting off the edge case first",
  });

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const decisions = log.entries.filter((e: any) => e.kind === "decision_logged");
  expect(decisions).toHaveLength(1);
  expect(decisions[0].payload.line).toBe("splitting off the edge case first");
});

it("分解理由を書かなくても登録でき、decision log エントリは残らないが子の登録イベントは残る", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
  });

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries.filter((e: any) => e.kind === "decision_logged")).toEqual([]);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${res.json.id}/events`)).json;
  expect(events.some((e: any) => e.kind === "task_registered")).toBe(true);
});

it("人間は同じ親に複数回にわたって子を追加できる(agent の子がまだない限り)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");

  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "first child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
  });
  const second = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "second child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
  });

  expect(second.status).toBe(201);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((x: any) => x.parent_id === parent.id)).toHaveLength(2);
});

it("存在しない parent_id への子追加は 404", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: "no-such-task",
  });

  expect(res.status).toBe(404);
});
