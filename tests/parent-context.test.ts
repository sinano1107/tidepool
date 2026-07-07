import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("a blocked parent is skipped and get_current_task exposes the parent context", async () => {
  t = await bootTidepool();
  const parent = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "ship the moon-phase widget",
      purpose: "surf forecast needs moon phase",
      completion_criteria: "widget renders on the dashboard",
    })
  ).json;
  const child = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "compute moon phase from date",
      purpose: "parent widget needs the raw number",
      completion_criteria: "phase function passes known-date checks",
      parent_id: parent.id,
    })
  ).json;
  expect(child.parent_id).toBe(parent.id);

  // parent is queue head but blocked (unfinished child) — pickup takes the child
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([child.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("todo");

  const client = await mcpClient(t.baseUrl, child.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.parent).toEqual({
      id: parent.id,
      title: "ship the moon-phase widget",
      purpose: "surf forecast needs moon phase",
      completion_criteria: "widget renders on the dashboard",
    });
  } finally {
    await client.close();
  }
});
