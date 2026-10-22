import { afterEach, expect, it, vi } from "vitest";
import { cancelTaskDirectly, completeTask, getTask, listChildren, logDecision, registerTask } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import {
  answerQuestionViaWebui,
  api,
  bootTidepool,
  callAsTask,
  decomposeTaskViaWorker,
  FULL_HANDOFF,
  failureQuestion,
  GIT_FIXTURE_TEST_TIMEOUT,
  HUMAN_WEBUI,
  managementMcpClient,
  mcpClient,
  nextPoll,
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

it("祖先の cancel の下の RCA の worker MCP は tools/list に分解の verb を出さず、complete_rca の説明は repair task と decompose に触れず、get_current_task は捨てた成果の欄を持たない —— 祖先の cancel の前は今どおり(ADR 0271 決定2 / ADR 0301 決定5)", async () => {
  t = await bootTidepool();
  const now = t.clock.now();
  const root = registerTask(t.db, { type: "work", title: "ship", purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI);
  const [a] = decomposeTaskViaWorker(t.db, root, { reason: "split", children: [{ title: "a", purpose: "p", completion_criteria: "c" }] }, "deckhand", now);
  const entry = logDecision(t.db, a!, "deckhand's call", "deckhand", now, "worker");
  completeTask(t.db, a!, FULL_HANDOFF, "deckhand", now, "worker");
  startTriage(t.db, now);
  raiseObjection(t.db, entry, "redo it", now);
  commitTriage(t.db, now, [], new Map());
  const rca = listChildren(t.db, a!.id).find((child) => child.title.startsWith("rca (self)"))!;
  const tools = async () => {
    const client = await mcpClient(t.mcpBaseUrl, rca.id);
    try {
      return (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
    } finally {
      await client.close();
    }
  };
  const completeRcaDescription = async () => (await tools()).find((tool) => tool.name === "complete_rca")!.description;
  const live = (await tools()).map((tool) => tool.name);
  expect(live).toEqual(expect.arrayContaining(["decompose", "redecompose"]));
  expect(await completeRcaDescription()).toContain("and the repair tasks you filed with decompose (every repair task is listed on every finding; call this once each has settled)");

  cancelTaskDirectly(t.db, getTask(t.db, root.id)!, null, t.clock.now(), {}, "webui");
  await nextPoll(t);

  expect((await tools()).map((tool) => tool.name)).toEqual(live.filter((name) => name !== "decompose" && name !== "redecompose"));
  const withheld = await completeRcaDescription();
  expect(withheld).toContain("lists its acts from the record: the memory you wrote with propose_from_objection from that finding's entries. Only a finding");
  expect(withheld).not.toMatch(/repair task|decompose/);
  expect(t.worker.started.at(-1)!.id).toBe(rca.id);
  expect(JSON.parse((await callAsTask(t, rca.id, "get_current_task", {})).content[0].text)).not.toHaveProperty("artifact_discarded");
});
