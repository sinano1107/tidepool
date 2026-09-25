import { afterEach, expect, it, vi } from "vitest";
import { AgentTierMismatchError, type AgentView, type ChangeAgentTierInput } from "../src/agent-create.js";
import { appendEvent } from "../src/events.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, completeViaMcp, HOUR, mcpClient, type Tidepool } from "./harness.js";

/** agent の既定 tier の提案(issue #920 / ADR 0150 決定1・2・5)のサーバ境界: 提案 verb、回答での registry への commit と修正値、
 *  push 失敗・前提の崩れ、due 判定時と表の編集での陳腐化。registry 書き込みは fake(`agentAdmin.changeTier`)、実 git の書き込みは
 *  tests/update-agent.test.ts、下げ先の検査と pin の照合はドメイン層(tests/execution-setting.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

const DAY = 24 * HOUR;
const agent = (name: string, provider: string, tier: string | undefined, extra: Partial<AgentView> = {}): AgentView => ({
  name,
  version: "1",
  authority: "standard",
  description: `${name} agent`,
  provider,
  advisor: false,
  tier,
  skills: ["*"],
  retiredFields: [],
  systemPrompt: "p",
  ...extra,
});

/** registry の fake: agent 一覧は可変(人間が registry を直接編集した、を表す)、書き込みは sha を返すか注入した失敗を投げる。 */
function fakeRegistry() {
  const agents = new Map<string, AgentView>([
    ["deckhand", agent("deckhand", "openai", "frontier")],
    ["kimi", agent("kimi", "moonshot", "frontier")],
    ["fugu", agent("fugu", "anthropic", "frontier", { builtin: true })],
  ]);
  const changeTier = vi.fn(async (_input: ChangeAgentTierInput) => "c0ffee");
  return { agents, changeTier, agentAdmin: { list: () => [...agents.values()], changeTier } };
}

/** routing の材料で poll させ、slot に入った routing meta-review の接続を返す。 */
async function boardWithRoutingReview(registry = fakeRegistry()) {
  t = await bootTidepool({ agentAdmin: registry.agentAdmin });
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" })).status).toBe(200);
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "routing");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  return { review, client, call, ...registry };
}

/** 根拠の episode(setup): agent が表の行 (provider, model) で走った worker_spawned。 */
function spawned(tp: Tidepool, workerId: string, provider: "openai" | "moonshot", model: string, tierSource: "agent" | "task" = "agent"): number {
  const { id } = registerTask(tp.db, { type: "work", title: "evidence", purpose: "p", completion_criteria: "c" }, tp.clock.now());
  return appendEvent(tp.db, {
    taskId: id,
    workerId,
    origin: "board",
    at: tp.clock.now(),
    payload: {
      kind: "worker_spawned",
      registry_commit: "c",
      definition_version: "1",
      advisor: null,
      provider,
      model,
      effort: "high",
      source: { tier: tierSource, provider: "only" },
      harness: "codex",
      cli_version: "1",
    },
  });
}

const task = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;
const events = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
const answer = (id: string, body: Record<string, unknown>) => api(t.baseUrl, "POST", `/api/tasks/${id}/answer`, body);
const ASTRA_PIN = { provider: "openai", model: "gpt-6-astra", tier: "frontier", effort: "high" };

it("tier の提案は meta-review の子に1 item の question を立て、(agent, tier) と根拠の行を pin に、evidence を焼く", async () => {
  const { review, client, call } = await boardWithRoutingReview();
  try {
    const evidence = [spawned(t, "deckhand", "openai", "gpt-6-astra"), spawned(t, "deckhand", "openai", "gpt-6-astra")];

    const { question_id } = await call("propose_routing_change", {
      op: "agent_tier",
      agent: "deckhand",
      to: "standard",
      evidence,
      rationale: "9 of 11 deckhand sessions were overpowered under its own tier.",
    });

    const question = await task(question_id);
    expect(question).toMatchObject({
      type: "question",
      status: "todo",
      parent_id: review.id,
      question_proposal: { kind: "registry", op: "agent_tier", agent: "deckhand", to: "standard", pin: { tier: "frontier", rows: [ASTRA_PIN] }, evidence },
      question_items: [{ options: ["approve", "reject"], recommendation: "approve" }],
    });
    expect(question.question_items).toHaveLength(1);
    for (const shown of ["deckhand", "frontier -> standard", "9 of 11 deckhand sessions were overpowered under its own tier."]) {
      expect(question.question_items[0].detail).toContain(shown);
    }
  } finally {
    await client.close();
  }
});

it("組み込み agent・2段以上・下げ先に行が無い・知らない agent・他の agent の根拠・agent の既定ティアで走っていない根拠の提案は断られ、question は立たない", async () => {
  const { review, client, call } = await boardWithRoutingReview();
  try {
    const own = spawned(t, "deckhand", "openai", "gpt-6-astra");
    const kimis = spawned(t, "kimi", "moonshot", "kimi-k3[1m]");
    for (const [input, reason] of [
      [{ agent: "fugu", to: "standard", evidence: [own] }, /built-in/],
      [{ agent: "deckhand", to: "economy", evidence: [own] }, /exactly one step/],
      // moonshot に standard の行は無い
      [{ agent: "kimi", to: "standard", evidence: [kimis] }, /no row at/],
      [{ agent: "ghost", to: "standard", evidence: [own] }, /unknown agent/],
      [{ agent: "deckhand", to: "standard", evidence: [kimis] }, /not a worker_spawned event of deckhand/],
      [{ agent: "deckhand", to: "standard", evidence: [spawned(t, "deckhand", "openai", "gpt-6-astra", "task")] }, /took its tier from task/],
    ] as const) {
      expect(await call("propose_routing_change", { op: "agent_tier", ...input, rationale: "r" })).toMatchObject({ error: expect.stringMatching(reason) });
    }
    // 他の op に tier の提案の欄が紛れても黙って捨てない
    expect(await call("propose_routing_change", { op: "demote", agent: "deckhand", rationale: "r" })).toMatchObject({ error: expect.stringMatching(/takes no agent/) });
    expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((q) => q.parent_id === review.id)).toEqual([]);
  } finally {
    await client.close();
  }
});

/** 提案を1つ立てて question id を返す(deckhand: frontier → standard、根拠は astra の行)。 */
async function proposeDeckhand(call: (name: string, args: Record<string, unknown>) => Promise<any>) {
  const evidence = [spawned(t, "deckhand", "openai", "gpt-6-astra")];
  return (await call("propose_routing_change", { op: "agent_tier", agent: "deckhand", to: "standard", evidence, rationale: "r" })).question_id as string;
}

it("approve で registry への書き込みが question id つきで撃たれ、read_routing_settings に着地した commit が残る", async () => {
  const { client, call, changeTier } = await boardWithRoutingReview();
  try {
    const questionId = await proposeDeckhand(call);

    expect((await answer(questionId, { answers: ["approve"] })).status).toBe(200);

    expect(changeTier).toHaveBeenCalledTimes(1);
    expect(changeTier.mock.calls[0]![0]).toMatchObject({ name: "deckhand", expectTier: "frontier", to: "standard", message: expect.stringContaining(questionId) });
    expect((await call("read_routing_settings")).proposals).toEqual([
      {
        question_id: questionId,
        proposal: (await task(questionId)).question_proposal,
        answer: "approve",
        amendment: null,
        comment: null,
        observed: null,
        applied: { registry_commit: "c0ffee", from: "frontier", to: "standard" },
      },
    ]);
  } finally {
    await client.close();
  }
});

it("修正値 to で2段下げられ、推奨どおりに数えない —— 下げ先に行が無い修正値は回答ごと断られ question は open のまま", async () => {
  const { client, call, changeTier } = await boardWithRoutingReview();
  try {
    const questionId = await proposeDeckhand(call);
    // openai の economy の行を消す(根拠の行ではないので提案は open のまま)
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "openai", model: "gpt-5.6-terra" })).status).toBe(200);
    expect((await answer(questionId, { answers: ["approve"], amendment: { to: "economy" } })).status).toBe(409);
    expect(await task(questionId)).toMatchObject({ status: "todo", question_answer: null });
    expect(changeTier).not.toHaveBeenCalled();

    const terra = { provider: "openai", tier: "economy", model: "gpt-5.6-terra", effort: "high", price_in: 2, price_out: 12 };
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: terra })).status).toBe(200);
    expect((await answer(questionId, { answers: ["approve"], amendment: { to: "economy" } })).status).toBe(200);

    expect(changeTier.mock.calls[0]![0]).toMatchObject({ expectTier: "frontier", to: "economy" });
    expect((await call("read_routing_settings")).proposals[0]).toMatchObject({ amendment: { to: "economy" }, applied: { from: "frontier", to: "economy" } });
    expect((await events(questionId)).find((e) => e.kind === "question_answered").payload).toMatchObject({
      answers: [{ answer: "approve", recommendation_accepted: false }],
    });
  } finally {
    await client.close();
  }
});

it("registry の push が失敗すると回答ごと断られ、question は open のまま適用も残らない", async () => {
  const registry = fakeRegistry();
  registry.changeTier.mockRejectedValue(new RegistryPushFailedError("remote rejected"));
  const { client, call } = await boardWithRoutingReview(registry);
  try {
    const questionId = await proposeDeckhand(call);

    const res = await answer(questionId, { answers: ["approve"] });

    expect(res.status).toBe(409);
    expect(res.json.error).toContain("remote rejected");
    expect(await task(questionId)).toMatchObject({ status: "todo", question_answer: null });
    expect((await events(questionId)).map((e) => e.kind)).toEqual(["task_registered"]);
    expect((await call("read_routing_settings")).proposals[0]).toMatchObject({ answer: null, observed: null });
    expect((await call("read_routing_settings")).proposals[0].applied).toBeUndefined();
  } finally {
    await client.close();
  }
});

it("書き込み前の registry の tier が pin と違えば、question は観測で決着し回答は適用されない", async () => {
  const registry = fakeRegistry();
  registry.changeTier.mockRejectedValue(new AgentTierMismatchError("deckhand", "frontier", "standard"));
  const { client, call } = await boardWithRoutingReview(registry);
  try {
    const questionId = await proposeDeckhand(call);

    expect((await answer(questionId, { answers: ["approve"] })).status).toBe(409);

    expect(await task(questionId)).toMatchObject({ status: "done", question_answer: null });
    expect((await events(questionId)).filter((e) => e.kind !== "task_registered").map((e) => e.payload)).toEqual([
      { kind: "routing_proposal_stale", question_id: questionId, proposal_kind: "registry", changed: ["agent_tier"], observed_event_id: null },
    ]);
  } finally {
    await client.close();
  }
});

it("due 判定の直前に pin の古い tier の提案が観測で決着し、その後は未決着に数えられず次の routing meta-review が登録される", async () => {
  const { review, client, call, agents } = await boardWithRoutingReview();
  const nextReviews = async () =>
    ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.meta_review_subject === "routing" && task.id !== review.id);
  try {
    expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 1 })).status).toBe(200);
    const questionId = await proposeDeckhand(call);
    expect((await completeViaMcp(t, review.id, false)).isError).not.toBe(true);
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "quality" })).status).toBe(200);

    // 別の agent の tier の変更では決着しない —— open な提案が周期を塞いだまま
    agents.set("kimi", agent("kimi", "moonshot", "economy"));
    await t.clock.advance(2 * DAY);
    expect(await task(questionId)).toMatchObject({ status: "todo" });
    expect(await nextReviews()).toEqual([]);

    // 人間が registry で deckhand の tier を直接下げた
    agents.set("deckhand", agent("deckhand", "openai", "standard"));
    await t.clock.advance(HOUR);

    expect(await task(questionId)).toMatchObject({ status: "done", question_answer: null });
    expect((await events(questionId)).find((e) => e.kind === "routing_proposal_stale").payload).toEqual({
      kind: "routing_proposal_stale",
      question_id: questionId,
      proposal_kind: "registry",
      changed: ["agent_tier"],
      observed_event_id: null,
    });
    expect(await nextReviews()).toHaveLength(1);
  } finally {
    await client.close();
  }
});

it("根拠の行の編集は tier の提案を観測で決着させ、無関係な行の編集では open のまま", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    const questionId = await proposeDeckhand(call);
    const opus = { provider: "anthropic", tier: "standard", model: "opus", effort: "max", price_in: 5, price_out: 25 };
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: opus })).status).toBe(200);
    expect(await task(questionId)).toMatchObject({ status: "todo" });

    const astra = { provider: "openai", tier: "frontier", model: "gpt-6-astra", effort: "max", price_in: 10, price_out: 50 };
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: astra })).status).toBe(200);

    expect(await task(questionId)).toMatchObject({ status: "done", question_answer: null });
    expect((await events(questionId)).find((e) => e.kind === "routing_proposal_stale").payload).toMatchObject({
      proposal_kind: "registry",
      changed: ["rows"],
      observed_event_id: expect.any(Number),
    });
  } finally {
    await client.close();
  }
});

it("registry の無い盤面では tier の提案は断られる", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" })).status).toBe(200);
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "routing");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  try {
    const result: any = await client.callTool({
      name: "propose_routing_change",
      arguments: { op: "agent_tier", agent: "deckhand", to: "standard", evidence: [1], rationale: "r" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no registry/);
  } finally {
    await client.close();
  }
});
