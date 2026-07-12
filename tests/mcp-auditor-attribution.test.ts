import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("review タスクの未設定 assignee での MCP 呼び出しは、既定 agent ではなく Auditor ポインタに属性される(issue #42)", async () => {
  t = await bootTidepool({ auditorName: "keeper" });
  const review = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "independent rca",
      purpose: "p",
      completion_criteria: "c",
    })
  ).json;
  await t.clock.advance(HOUR); // picked up into the slot

  const client = await mcpClient(t.mcpBaseUrl, review.id);
  await client.callTool({ name: "log_decision", arguments: { line: "no repair needed" } });
  await client.close();

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const decision = log.entries.find((e: any) => e.kind === "decision_logged");
  expect(decision.worker_id).toBe("keeper");
});
