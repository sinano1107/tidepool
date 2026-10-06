import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, HANDOFF_FIELDS, listChildren, registerTask } from "../src/tasks.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { api, bootTidepool, FULL_HANDOFF, HOUR, HUMAN_WEBUI, mcpClient, type Tidepool } from "./harness.js";

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

  const client = await mcpClient(t.mcpBaseUrl, first.id);
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

it("worker 用 complete_task の description は HANDOFF_FIELDS の全フィールド名を挙げる(issue #1084)", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "index the tide charts",
      purpose: "make historical tides searchable",
      completion_criteria: "a query for 2025-06 returns chart rows",
    })
  ).json;

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === "complete_task")?.description ?? "";
    for (const field of HANDOFF_FIELDS) {
      expect(description).toContain(field);
    }
  } finally {
    await client.close();
  }
});

it("完了時レビューは完了させた agent ではなく盤面の名義・経路で登録される(ADR 0194 決定3)", () => {
  const db = openDb(":memory:");
  const at = new Date("2026-10-02T00:00:00.000Z");
  const root = registerTask(db, { type: "work", title: "root", purpose: "p", completion_criteria: "c", assignee: "deckhand" }, at, ...HUMAN_WEBUI);

  completeTask(db, root, FULL_HANDOFF, "deckhand", at, "worker");

  const [review] = listChildren(db, root.id);
  expect(listEvents(db, review!.id).find((e) => e.kind === "task_registered")).toMatchObject({ worker_id: BOARD_WORKER_ID, origin: "board" });
});
