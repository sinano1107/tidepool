import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/your-tasks は human 宛てタスクを返し、実行キューには現れない", async () => {
  t = await bootTidepool();

  const human = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "physically water the greenhouse",
      purpose: "the sensor can't do this itself",
      completion_criteria: "soil visibly moist",
      assignee: "human",
    })
  ).json;
  const agent = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "agent-executable todo",
      purpose: "p",
      completion_criteria: "c",
    })
  ).json;

  const yourTasks = await api(t.baseUrl, "GET", "/api/your-tasks");
  expect(yourTasks.status).toBe(200);
  expect(yourTasks.json.map((x: any) => x.id)).toEqual([human.id]);

  const queue = await api(t.baseUrl, "GET", "/api/queue");
  expect(queue.json.tasks.map((x: any) => x.id)).not.toContain(human.id);
  expect(queue.json.tasks.map((x: any) => x.id)).toContain(agent.id);
});

it("GET /api/your-tasks の各行は塞いでいる親を blocking で運ぶ(issue #301)", async () => {
  t = await bootTidepool();

  const lone = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "physically water the greenhouse",
      purpose: "the sensor can't do this itself",
      completion_criteria: "soil visibly moist",
      assignee: "human",
    })
  ).json;
  const parent = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "parent work",
      purpose: "p",
      completion_criteria: "c",
    })
  ).json;
  const child = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "sign the paperwork",
      purpose: "p",
      completion_criteria: "c",
      assignee: "human",
      parent_id: parent.id,
      decompose_reason: "the signature is mine to give",
    })
  ).json;

  const rows: any[] = (await api(t.baseUrl, "GET", "/api/your-tasks")).json;
  const blocking = new Map(rows.map((r) => [r.id, r.blocking]));
  // JSON を渡っても「塞いでいない」は欠落ではなく null として届く
  expect(blocking.get(lone.id)).toBeNull();
  expect(blocking.get(child.id)).toBe(parent.id);
});
