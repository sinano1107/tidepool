import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("every state change is appended as a typed event, readable via the events API", async () => {
  t = await bootTidepool();
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "traceable task",
      purpose: "prove the event trail",
      completion_criteria: "events recorded",
    })
  ).json;
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    await client.callTool({
      name: "complete_task",
      arguments: {
        handoff: {
          outcome: "done as specified",
          deliverables: "n/a",
          decision_refs: "none",
          dead_ends: "none",
          resume_context: "none",
          known_issues: "none",
        },
      },
    });
  } finally {
    await client.close();
  }

  const res = await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`);
  expect(res.status).toBe(200);
  const events = res.json;
  expect(events.map((e: any) => e.kind)).toEqual([
    "task_registered",
    "task_picked_up",
    "task_completed",
  ]);

  const [registered, pickedUp, completed] = events;
  // registration through the bare JSON API is attributed to the human worker
  expect(registered.worker_id).toBe("human");
  expect(registered.payload.type).toBe("work");
  expect(pickedUp.worker_id).toBe(t.worker.id);
  expect(completed.worker_id).toBe(t.worker.id);
  expect(completed.payload.handoff_present).toBe(true);
  // append-only trail: every event carries its task and a timestamp
  for (const e of events) {
    expect(e.task_id).toBe(task.id);
    expect(e.created_at).toBeTruthy();
  }
});
