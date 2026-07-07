import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const fullHandoff = {
  outcome: "moisture reading live on dashboard, matches criteria",
  deliverables: "PR #12 on greenhouse repo",
  decision_refs: "decision log entries 3 and 7",
  dead_ends: "I2C polling — sensor locks up under 100ms intervals",
  resume_context: "sensor firmware v2.1 assumed; calibration constant in config.ts",
  known_issues: "reading jitters ±2% in rain, not worth a task",
};

it("complete_task on a work task requires the 6-field handoff doc", async () => {
  t = await bootTidepool();
  const first = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "wire the moisture sensor",
      purpose: "get readings flowing",
      completion_criteria: "dashboard shows a live number",
    })
  ).json;
  const second = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "calibrate the sensor",
      purpose: "raw readings are uncalibrated",
      completion_criteria: "reading matches manual probe ±5%",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.baseUrl, first.id);
  try {
    // no handoff → refused, task stays in_progress
    const bare: any = await client.callTool({ name: "complete_task", arguments: {} });
    expect(bare.isError).toBe(true);
    expect((await api(t.baseUrl, "GET", `/api/tasks/${first.id}`)).json.status).toBe("in_progress");

    // a missing field → still refused
    const { known_issues: _dropped, ...partial } = fullHandoff;
    const short: any = await client.callTool({
      name: "complete_task",
      arguments: { handoff: partial },
    });
    expect(short.isError).toBe(true);

    // full handoff → done, doc stored on the task row
    const ok: any = await client.callTool({
      name: "complete_task",
      arguments: { handoff: fullHandoff },
    });
    expect(ok.isError ?? false).toBe(false);
    const done = (await api(t.baseUrl, "GET", `/api/tasks/${first.id}`)).json;
    expect(done.status).toBe("done");
    expect(done.handoff_doc).toContain("moisture reading live on dashboard");
    expect(done.handoff_doc).toContain("I2C polling");
  } finally {
    await client.close();
  }

  // slot was released: the next tick picks up the next task
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id, second.id]);
});
