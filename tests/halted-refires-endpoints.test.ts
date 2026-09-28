import { afterEach, expect, it } from "vitest";
import { FakeAllocationClient } from "./fakes.js";
import { api, children, commit, HOUR, KEEP_FIXTURES, managementMcpClient, nextPoll, objectedForDraft, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 管理MCP の tool を呼び、tool error か JSON の結果を返す。 */
function toolCaller(client: Awaited<ReturnType<typeof managementMcpClient>>) {
  return async (name: string, args: Record<string, unknown>) => {
    const result = (await client.callTool({ name, arguments: args })) as any;
    return { isError: result.isError === true, json: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
}

// 撃ち直しの打ち切りと Retry / Dismiss(ADR 0164 決定5 / issue #1066)。置き場所は振り返り Board call の面(ADR 0172 決定3)

const halted = async (t: Tidepool) => (await api(t.baseUrl, "GET", "/api/settings/execution/halted-refires")).json.halted;

const taskEvents = async (t: Tidepool, taskId: string, kind: string) =>
  (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter((e: any) => e.kind === kind);

/** 起草を3回撃って失敗させる(commit の1回 + 1時間後の tick 2回)。 */
async function draftHalted(title: string) {
  const s = await objectedForDraft(title, { initial: { cause: "preference", evidence: "taste" } });
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(s.t, s.task.id, title);
  await s.t.clock.advance(HOUR);
  await s.t.clock.advance(HOUR);
  const [attribution] = await taskEvents(s.t, s.task.id, "objection_attributed");
  return { ...s, attribution };
}

it("起草が撃って3回失敗すると、settings の一覧と管理MCP の一覧に同じ行が出る(2回ではまだ出ない)", async () => {
  const s = await objectedForDraft("hopeless", { initial: { cause: "preference", evidence: "taste" } });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "hopeless");
  await t.clock.advance(HOUR);
  expect(await halted(t)).toEqual([]);

  await t.clock.advance(HOUR);

  const [attribution] = await taskEvents(t, s.task.id, "objection_attributed");
  const [, , last] = await taskEvents(t, s.task.id, "memory_draft_failed");
  const rows = await halted(t);
  expect(rows).toEqual([
    {
      refire: "draft",
      target: attribution.id,
      entry: { id: s.entry.id, text: "skipped the fixtures" },
      task: { id: s.task.id, title: "hopeless" },
      cause: "preference",
      round: "initial",
      last_failure: { reason: "claude CLI timed out", at: last.created_at },
    },
  ]);
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(await toolCaller(client)("list_halted_refires", {})).toEqual({ isError: false, json: { halted: rows } });
  } finally {
    await client.close();
  }
});

it("第2回の帰責が撃って3回失敗すると両方の一覧に出て、管理MCP の Dismiss で消え、以後の tick では撃たれず、Dismiss は人間の event に残る", async () => {
  const s = await objectedForDraft("flaky-rca");
  t = s.t;
  const { self, auditor } = await commit(t, s.task.id, "flaky-rca");
  s.attributionClient.scriptJudgment(s.entry.id, new Error("claude CLI timed out"));
  await api(t.baseUrl, "POST", `/api/tasks/${self.id}/cancel`, {});
  await api(t.baseUrl, "POST", `/api/tasks/${auditor.id}/cancel`, {});
  await nextPoll(t);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  const [, , last] = await taskEvents(t, s.task.id, "objection_attribution_failed");
  const row = {
    refire: "second_round",
    target: s.entry.id,
    entry: { id: s.entry.id, text: "skipped the fixtures" },
    task: { id: s.task.id, title: "flaky-rca" },
    cause: "uncertain",
    round: "after_rca",
    last_failure: { reason: "Board call failed: claude CLI timed out", at: last.created_at },
  };
  expect(await halted(t)).toEqual([row]);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const call = toolCaller(client);
    expect(await call("list_halted_refires", {})).toEqual({ isError: false, json: { halted: [row] } });

    expect(await call("dismiss_halted_refire", { refire: "second_round", target: s.entry.id })).toEqual({ isError: false, json: { event_id: expect.any(Number) } });
    expect(await call("list_halted_refires", {})).toEqual({ isError: false, json: { halted: [] } });
  } finally {
    await client.close();
  }
  expect(await halted(t)).toEqual([]);
  s.attributionClient.scriptJudgment(s.entry.id, { cause: "capability", evidence: "the RCA decided it" });
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect(s.attributionClient.calls).toHaveLength(4);
  expect((await taskEvents(t, s.task.id, "refire_dismissed")).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    ["human", "mcp", { kind: "refire_dismissed", refire: "second_round", target: s.entry.id }],
  ]);
});

it("POST .../retry で打ち切りの起草はすぐ次の poll で撃たれ、失敗はもう3回まで数え直す。管理MCP の Retry で撃った起草が成功すると candidate が載って一覧から消え、以後の Retry / Dismiss は 400", async () => {
  const s = await draftHalted("retried");
  t = s.t;

  const retried = await api(t.baseUrl, "POST", `/api/settings/execution/halted-refires/draft/${s.attribution.id}/retry`);
  expect(retried).toEqual({ status: 200, json: { event_id: expect.any(Number) } });
  expect(await halted(t)).toEqual([]);
  await nextPoll(t);
  expect(s.behaviorDraftClient.calls).toHaveLength(4);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(s.behaviorDraftClient.calls).toHaveLength(6);
  expect(await halted(t)).toEqual([expect.objectContaining({ refire: "draft", target: s.attribution.id })]);

  s.behaviorDraftClient.scriptDraft(s.entry.id, KEEP_FIXTURES);
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(await toolCaller(client)("retry_halted_refire", { refire: "draft", target: s.attribution.id })).toEqual({ isError: false, json: { event_id: expect.any(Number) } });
  } finally {
    await client.close();
  }
  await registerWork(t, "another pickup trigger");

  expect((await api(t.baseUrl, "GET", "/api/settings/memory/entries?kind=behavior")).json.entries).toEqual([
    expect.objectContaining({ state: "candidate", source: { kind: "event", ref: s.attribution.id } }),
  ]);
  expect(await halted(t)).toEqual([]);
  expect((await taskEvents(t, s.task.id, "refire_retried")).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    ["human", "webui", { kind: "refire_retried", refire: "draft", target: s.attribution.id }],
    ["human", "mcp", { kind: "refire_retried", refire: "draft", target: s.attribution.id }],
  ]);
  // 撃ち直しが成功して candidate のある起草は打ち切りでない
  for (const verb of ["retry", "dismiss"]) {
    expect((await api(t.baseUrl, "POST", `/api/settings/execution/halted-refires/draft/${s.attribution.id}/${verb}`)).status).toBe(400);
  }
});

it("打ち切りでない件への Retry / Dismiss は 400 / tool error: 3回未満の失敗・Retry 直後・Dismiss 済みへの Dismiss と Retry", async () => {
  const s = await draftHalted("refused");
  t = s.t;
  const post = async (verb: "retry" | "dismiss", key: { refire: string; target: number }) =>
    (await api(t.baseUrl, "POST", `/api/settings/execution/halted-refires/${key.refire}/${key.target}/${verb}`)).status;
  const draft = { refire: "draft", target: s.attribution.id };
  const client = await managementMcpClient(t.baseUrl);
  try {
    // 第2回を撃ったことのない entry(3回未満)。管理MCP では tool error(対応づけはこの1件で見る)
    const neverFired = { refire: "second_round", target: s.entry.id };
    expect([await post("retry", neverFired), await post("dismiss", neverFired)]).toEqual([400, 400]);
    expect((await toolCaller(client)("retry_halted_refire", neverFired)).isError).toBe(true);
  } finally {
    await client.close();
  }

  expect(await post("retry", draft)).toBe(200);
  // Retry の後はまだ1回も失敗していない
  expect([await post("retry", draft), await post("dismiss", draft)]).toEqual([400, 400]);

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(await post("dismiss", draft)).toBe(200);
  expect([await post("dismiss", draft), await post("retry", draft)]).toEqual([400, 400]);
});

// 配分評価の打ち切り(ADR 0172 決定3 / issue #1139)

/** 撃つたびに失敗する配分評価の client。統合点レビューの完了が促す poll で1回目が撃たれる。 */
function failingAllocation() {
  const allocationClient = new FakeAllocationClient();
  allocationClient.scriptFailure(new Error("claude CLI timed out"));
  return allocationClient;
}

it("配分評価が撃って3回失敗すると、settings の一覧と管理MCP の一覧に起草の行と並んで review と被レビュー task の行が出る", async () => {
  const s = await objectedForDraft("hopeless", { initial: { cause: "preference", evidence: "taste" }, allocationClient: failingAllocation() });
  t = s.t;
  s.behaviorDraftClient.scriptDraft(s.entry.id, new Error("claude CLI timed out"));
  await commit(t, s.task.id, "hopeless");
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  const review = (await children(t, s.task.id)).find((x: any) => x.title === "review: hopeless");
  const [completed] = await taskEvents(t, review.id, "task_completed");
  const [, , last] = await taskEvents(t, s.task.id, "allocation_review_failed");
  const rows = await halted(t);
  expect(rows).toEqual([
    expect.objectContaining({ refire: "draft", task: { id: s.task.id, title: "hopeless" } }),
    {
      refire: "allocation",
      target: completed.id,
      review: { id: review.id, title: "review: hopeless" },
      task: { id: s.task.id, title: "hopeless" },
      last_failure: { reason: "claude CLI timed out", at: last.created_at },
    },
  ]);
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(await toolCaller(client)("list_halted_refires", {})).toEqual({ isError: false, json: { halted: rows } });
  } finally {
    await client.close();
  }
});

it("打ち切りの配分評価は POST .../retry で次の poll にまた撃たれ、管理MCP の Dismiss の後は二度と撃たれず、どちらも被レビュー task の人間の event に残る", async () => {
  const allocationClient = failingAllocation();
  const s = await objectedForDraft("hopeless review", { allocationClient });
  t = s.t;
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  const [row] = await halted(t);
  const key = { refire: "allocation", target: row.target };
  expect(row).toMatchObject(key);

  const retried = await api(t.baseUrl, "POST", `/api/settings/execution/halted-refires/allocation/${row.target}/retry`);
  expect(retried).toEqual({ status: 200, json: { event_id: expect.any(Number) } });
  expect(await halted(t)).toEqual([]);
  await nextPoll(t);
  expect(allocationClient.calls).toHaveLength(4);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(await halted(t)).toEqual([expect.objectContaining(key)]);

  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(await toolCaller(client)("dismiss_halted_refire", key)).toEqual({ isError: false, json: { event_id: expect.any(Number) } });
  } finally {
    await client.close();
  }
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect(await halted(t)).toEqual([]);
  expect(allocationClient.calls).toHaveLength(6);
  const human = [...(await taskEvents(t, s.task.id, "refire_retried")), ...(await taskEvents(t, s.task.id, "refire_dismissed"))];
  expect(human.map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    ["human", "webui", { kind: "refire_retried", ...key }],
    ["human", "mcp", { kind: "refire_dismissed", ...key }],
  ]);
});
