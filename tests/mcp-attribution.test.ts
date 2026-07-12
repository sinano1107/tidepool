import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("MCP calls not attributed to the current slot task are rejected", async () => {
  t = await bootTidepool();
  const first = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "current task",
      purpose: "occupies the slot",
      completion_criteria: "n/a",
    })
  ).json;
  const second = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "queued task",
      purpose: "still waiting",
      completion_criteria: "n/a",
    })
  ).json;
  await t.clock.advance(HOUR); // first occupies the slot

  // attributed to a task that is NOT in the slot (e.g. a stale killed process)
  const stale = await mcpClient(t.mcpBaseUrl, second.id);
  try {
    const got: any = await stale.callTool({ name: "get_current_task", arguments: {} });
    expect(got.isError).toBe(true);
    const done: any = await stale.callTool({ name: "complete_task", arguments: {} });
    expect(done.isError).toBe(true);
    expect((await api(t.baseUrl, "GET", `/api/tasks/${second.id}`)).json.status).toBe("todo");
    expect((await api(t.baseUrl, "GET", `/api/tasks/${first.id}`)).json.status).toBe(
      "in_progress",
    );
  } finally {
    await stale.close();
  }

  // bare /mcp (no ?task=) may not act as the slot worker
  const bare = await mcpClient(t.mcpBaseUrl);
  try {
    const got: any = await bare.callTool({ name: "get_current_task", arguments: {} });
    expect(got.isError).toBe(true);
  } finally {
    await bare.close();
  }
});
