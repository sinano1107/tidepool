import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("a blocked parent is skipped and get_current_task exposes the parent context", async () => {
  t = await bootTidepool();
  // 扉を通さずに置く —— 扉の登録は pickup の契機で(ADR 0119 決定2)、親が子を持つ前に走り出す
  const parent = registerTask(
    t.db,
    {
      type: "work",
      title: "ship the moon-phase widget",
      purpose: "surf forecast needs moon phase",
      completion_criteria: "widget renders on the dashboard",
    },
    t.clock.now(),
  );
  const child = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "compute moon phase from date",
      purpose: "parent widget needs the raw number",
      completion_criteria: "phase function passes known-date checks",
      parent_id: parent.id,
      decompose_reason: "separate the phase calculation",
    })
  ).json;
  expect(child.parent_id).toBe(parent.id);

  // parent is queue head but blocked (unfinished child) — pickup takes the
  // child, and the board presents the derived state
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([child.id]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe("blocked");

  const client = await mcpClient(t.mcpBaseUrl, child.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.parent).toEqual({
      id: parent.id,
      title: "ship the moon-phase widget",
      purpose: "surf forecast needs moon phase",
      completion_criteria: "widget renders on the dashboard",
      handoff_doc: null,
      history: [
        {
          decision: "separate the phase calculation",
          children: [
            {
              title: "compute moon phase from date",
              purpose: "parent widget needs the raw number",
              completion_criteria: "phase function passes known-date checks",
              status: "in_progress",
              you: true,
            },
          ],
        },
      ],
    });
  } finally {
    await client.close();
  }
});
