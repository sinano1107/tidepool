import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("get_current_task returns purpose and completion criteria over MCP", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "index the tide charts",
      purpose: "make historical tides searchable",
      completion_criteria: "a query for 2025-06 returns chart rows",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.baseUrl, task.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    expect(result.isError ?? false).toBe(false);
    const payload = JSON.parse(result.content[0].text);
    expect(payload.id).toBe(task.id);
    expect(payload.purpose).toBe("make historical tides searchable");
    expect(payload.completion_criteria).toBe("a query for 2025-06 returns chart rows");
    expect(payload.parent).toBeNull();
  } finally {
    await client.close();
  }
});
