import { afterEach, expect, it, vi } from "vitest";
import { completeTask, getTask, listChildren, registerTask } from "../src/tasks.js";
import {
  answerQuestionViaWebui,
  api,
  bootTidepool,
  decomposeTaskViaWorker,
  FULL_HANDOFF,
  failureQuestion,
  GIT_FIXTURE_TEST_TIMEOUT,
  HUMAN_WEBUI,
  managementMcpClient,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// 捨てる done の work の欄の配線(ADR 0271 決定4・5)。範囲そのものは domain の釘(cancel-discards.test.ts)が言うので、
// ここは各口に同じ一覧が載ることだけを言う。

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/tasks/:id・question の読み・管理MCP の get_task / list_board に discards、cancel_task の ack に discarded が載る", async () => {
  t = await bootTidepool();
  const now = t.clock.now();
  const root = registerTask(t.db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI);
  decomposeTaskViaWorker(t.db, root, { reason: "split", children: [{ title: "a", purpose: "p", completion_criteria: "c" }, { title: "b", purpose: "p", completion_criteria: "c" }] }, "deckhand", now);
  const a = listChildren(t.db, root.id).find((c) => c.title === "a")!;
  completeTask(t.db, a, FULL_HANDOFF, "deckhand", now, "worker");
  const question = failureQuestion(t.db, root.id, now);
  const discards = [{ id: a.id, title: "a" }];

  expect((await api(t.baseUrl, "GET", `/api/tasks/${root.id}`)).json.discards).toEqual(discards);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.discards).toEqual(discards);
  expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((x) => x.id === question.id).discards).toEqual(discards);

  const client = await managementMcpClient(t.baseUrl);
  try {
    const board: any = await client.callTool({ name: "list_board", arguments: {} });
    const rows = JSON.parse(board.content[0].text).tasks as any[];
    expect(rows.find((x) => x.id === root.id).discards).toEqual(discards);
    expect(rows.find((x) => x.id === question.id).discards).toEqual(discards);
    const single: any = await client.callTool({ name: "get_task", arguments: { task_id: root.id } });
    expect(JSON.parse(single.content[0].text).discards).toEqual(discards);

    answerQuestionViaWebui(t.db, getTask(t.db, question.id)!, ["retry"], t.clock.now());
    const cancelled: any = await client.callTool({ name: "cancel_task", arguments: { task_id: root.id } });
    expect(cancelled.isError ?? false).toBe(false);
    expect(JSON.parse(cancelled.content[0].text)).toMatchObject({ id: root.id, status: "cancelled", discarded: discards });
  } finally {
    await client.close();
  }
});
