import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

for (const type of ["question", "review"] as const) {
  it(`a ${type} task completes without a handoff doc`, async () => {
    t = await bootTidepool();
    const task = (
      await api(t.baseUrl, "POST", "/api/tasks", {
        type,
        title: `some ${type} task`,
        purpose: `exercise ${type} completion`,
        completion_criteria: "answered",
      })
    ).json;
    await t.clock.advance(HOUR);

    const client = await mcpClient(t.baseUrl, task.id);
    try {
      const result: any = await client.callTool({ name: "complete_task", arguments: {} });
      expect(result.isError ?? false).toBe(false);
      const done = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
      expect(done.status).toBe("done");
      expect(done.handoff_doc).toBeNull();
    } finally {
      await client.close();
    }
  });
}
