import { afterEach, expect, it } from "vitest";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("review タスクの get_current_task に、親(レビュー対象)の decision log 全行と handoff doc 全文が含まれる", async () => {
  t = await bootTidepool();
  const reviewed = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "ship the tide widget",
      purpose: "purpose",
      completion_criteria: "criteria",
      review_flag: true,
    })
  ).json;
  await t.clock.advance(HOUR); // reviewed task picked up
  const client = await mcpClient(t.mcpBaseUrl, reviewed.id);
  await client.callTool({ name: "log_decision", arguments: { line: "kept the API surface small" } });
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();

  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const review = list.find((x: any) => x.type === "review");
  expect(review.parent_id).toBe(reviewed.id);

  await t.clock.advance(HOUR); // review picked up
  const reviewClient = await mcpClient(t.mcpBaseUrl, review.id);
  try {
    const result: any = await reviewClient.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.parent.handoff_doc).toBe(
      (await api(t.baseUrl, "GET", `/api/tasks/${reviewed.id}`)).json.handoff_doc,
    );
    expect(payload.parent.decision_log.map((e: any) => e.kind)).toEqual([
      "decision_logged",
      "task_completed",
    ]);
    expect(payload.parent.decision_log[0].payload.line).toBe("kept the API surface small");
  } finally {
    await reviewClient.close();
  }
});

it("review でない親コンテキストには decision log / handoff doc が含まれない", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent 3");
  const child = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "child 3",
      purpose: "purpose",
      completion_criteria: "criteria",
      parent_id: parent.id,
      decompose_reason: "split the context child",
    })
  ).json;
  await t.clock.advance(HOUR); // child picked up (parent blocked)

  const client = await mcpClient(t.mcpBaseUrl, child.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.parent.decision_log).toBeUndefined();
    expect(payload.parent.handoff_doc).toBeUndefined();
  } finally {
    await client.close();
  }
});
