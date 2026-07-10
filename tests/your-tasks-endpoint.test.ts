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
  expect(queue.json.map((x: any) => x.id)).not.toContain(human.id);
  expect(queue.json.map((x: any) => x.id)).toContain(agent.id);
});
