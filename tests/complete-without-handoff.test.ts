import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, getTask, registerTask } from "../src/tasks.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { api, bootTidepool, HOUR, HUMAN_WEBUI, mcpClient, type Tidepool } from "./harness.js";

const NOW = new Date("2026-10-19T00:00:00.000Z");

let t: Tidepool;
afterEach(() => t?.stop());

// question tasks never enter the slot (they are answered from the WebUI), so
// review is the slot-completed type that exercises the "a supplied handoff is
// stored" rule
it("a review task may attach a handoff, and it is stored rather than dropped", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "review the sensor choice",
      purpose: "unblock the hardware order",
      completion_criteria: "the choice is confirmed",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const result: any = await client.callTool({
      name: "complete_task",
      arguments: { handoff: { outcome: "chose the SEN-0193 capacitive probe" } },
    });
    expect(result.isError ?? false).toBe(false);
    const done = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
    expect(done.status).toBe("done");
    expect(done.handoff_doc).toContain("SEN-0193");
  } finally {
    await client.close();
  }
});

// ADR 0278 決定6: agent の完了は判断を運ぶ —— work 以外の type も handoff の outcome が無ければ拒み、何も記録しない
for (const type of ["review", "memory_repair"] as const) {
  it(`an agent ${type} task cannot complete without a handoff outcome`, () => {
    const db = openDb(":memory:");
    const parent = registerTask(db, { type: "work", title: "parent", purpose: "p", completion_criteria: "c" }, NOW, ...HUMAN_WEBUI);
    const task = registerTask(db, { type, title: `some ${type}`, purpose: "p", completion_criteria: "c", parent_id: parent.id }, NOW, ...HUMAN_WEBUI);

    for (const handoff of [undefined, { outcome: "  " }]) {
      expect(() => completeTask(db, task, handoff, "shako", NOW, "worker")).toThrow(`a ${type} task cannot complete without a handoff outcome`);
    }
    expect(getTask(db, task.id)?.status).not.toBe("done");
    expect(listEvents(db, task.id).map((e) => e.payload.kind)).not.toContain("task_completed");
  });
}

it("a human-assignee review completes without a handoff outcome", () => {
  const db = openDb(":memory:");
  const review = registerTask(db, { type: "review", title: "eyeball it", purpose: "p", completion_criteria: "c", assignee: HUMAN_WORKER_ID }, NOW, ...HUMAN_WEBUI);
  expect(completeTask(db, review, undefined, HUMAN_WORKER_ID, NOW, "worker").status).toBe("done");
});
