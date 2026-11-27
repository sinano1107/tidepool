import { afterEach, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { registerTask } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { api, bootTidepool, completeRoutingReviewViaMcp, fakeRegistry, HOUR, HUMAN_WEBUI, mcpClient, routingMaterialViaWebui, startFirstMetaReviewViaWebui, type Tidepool, WORKER_SPAWNED } from "./harness.js";

/** agent の段の提案(issue #920 / ADR 0410 決定4)のサーバ境界: 提案 verb の応答と拒否の toolError、回答の HTTP の写し(承認の 200、
 *  agent が消えたときの観測の印、registry が読めないときの 409)、due 判定への registry の一覧の配線。門・pin・hook・修正値・
 *  承認の transaction はドメイン層(tests/execution-setting.test.ts / tests/routing-proposal-evidence.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

const DAY = 24 * HOUR;

/** deckhand の既定ティアを frontier に設定し、routing の材料で poll させ、slot に入った routing meta-review の接続を返す。 */
async function boardWithRoutingReview(registry = fakeRegistry()) {
  t = await bootTidepool({ agentAdmin: registry.agentAdmin });
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "agent_tier", agent: "deckhand", tier: "frontier" })).status).toBe(200);
  await routingMaterialViaWebui(t);
  await startFirstMetaReviewViaWebui(t, "routing");
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "routing");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  return { review, client, call, ...registry };
}

/** 根拠の episode(setup): deckhand が astra の行で、既定ティア frontier で走った worker_spawned。 */
function spawned(tp: Tidepool): number {
  const { id } = registerTask(tp.db, { type: "work", title: "evidence", purpose: "p", completion_criteria: "c" }, tp.clock.now(), ...HUMAN_WEBUI);
  return appendEvent(tp.db, {
    taskId: id,
    actorId: "deckhand",
    origin: "board",
    at: tp.clock.now(),
    payload: { ...WORKER_SPAWNED, provider: "openai", model: "gpt-6-astra", tier_id: tierIdOf(tp.db, "frontier"), source: { tier: "agent", provider: "only" }, harness: "codex" },
  });
}

const task = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;
const answer = (id: string, body: Record<string, unknown>) => api(t.baseUrl, "POST", `/api/tasks/${id}/answer`, body);

/** 提案を1つ立てて question id を返す(deckhand: frontier → standard)。 */
async function proposeDeckhand(call: (name: string, args: Record<string, unknown>) => Promise<any>) {
  return (await call("propose_routing_change", { op: "agent_tier", agent: "deckhand", to: "standard", evidence: [spawned(t)], rationale: "r" })).question_id as string;
}

it("agent の段の提案は meta-review の子に routing の提案の question を立て、走る段と根拠の行を pin に焼き、本文は registry への commit を言わない", async () => {
  const { review, client, call } = await boardWithRoutingReview();
  try {
    const evidence = [spawned(t)];
    const { question_id } = await call("propose_routing_change", { op: "agent_tier", agent: "deckhand", to: "standard", evidence, rationale: "9 of 11 deckhand sessions were overpowered under its own tier." });

    const question = await task(question_id);
    expect(question).toMatchObject({
      type: "question",
      status: "todo",
      parent_id: review.id,
      question_proposal: {
        kind: "routing",
        op: "agent_tier",
        agent: "deckhand",
        to: "standard",
        pin: { tier: "frontier", rows: [{ provider: "openai", model: "gpt-6-astra", tier: "frontier", effort: "high" }] },
        evidence,
      },
      question_items: [{ options: ["approve", "reject"], recommendation: "approve" }],
    });
    for (const shown of ["deckhand", "frontier -> standard", "9 of 11 deckhand sessions were overpowered under its own tier."]) {
      expect(question.question_items[0].detail).toContain(shown);
    }
    expect(question.purpose).not.toMatch(/registry/);
  } finally {
    await client.close();
  }
});

it("組み込み agent・知らない agent の提案は toolError で断られる", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    const own = spawned(t);
    expect(await call("propose_routing_change", { op: "agent_tier", agent: "fugu", to: "standard", evidence: [own], rationale: "r" })).toMatchObject({ error: expect.stringMatching(/built-in: the tier its reviews and Interviews run on/) });
    expect(await call("propose_routing_change", { op: "agent_tier", agent: "ghost", to: "standard", evidence: [own], rationale: "r" })).toMatchObject({ error: expect.stringMatching(/unknown agent/) });
  } finally {
    await client.close();
  }
});

it("HTTP の approve は 200 で、観測の印の無い回答済みの question を返す", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    const questionId = await proposeDeckhand(call);

    expect(await answer(questionId, { answers: ["approve"] })).toMatchObject({ status: 200, json: { id: questionId, status: "done", settled_by_observation: null } });
  } finally {
    await client.close();
  }
});

it("agent が registry から消えていれば approve は 200 と観測の印で返り、registry が読めなければ 409 で理由を返す", async () => {
  const registry = fakeRegistry();
  const { client, call } = await boardWithRoutingReview(registry);
  try {
    const questionId = await proposeDeckhand(call);
    registry.state.unreadable = true;
    const refused = await answer(questionId, { answers: ["approve"] });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain("registry clone is broken");

    registry.state.unreadable = false;
    registry.agents.delete("deckhand");
    expect(await answer(questionId, { answers: ["approve"] })).toMatchObject({ status: 200, json: { id: questionId, status: "done", settled_by_observation: "routing_proposal_stale" } });
  } finally {
    await client.close();
  }
});

it("registry から agent が消えた提案は due 判定の直前に観測で決着し、未決着に数えられず次の routing meta-review が登録される", async () => {
  const registry = fakeRegistry();
  const { review, client, call } = await boardWithRoutingReview(registry);
  const nextReviews = async () =>
    ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.meta_review_subject === "routing" && task.id !== review.id);
  try {
    expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 1 })).status).toBe(200);
    const questionId = await proposeDeckhand(call);
    expect((await completeRoutingReviewViaMcp(t, review.id)).isError).not.toBe(true);
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "quality" })).status).toBe(200);
    await t.clock.advance(2 * DAY);
    expect(await task(questionId)).toMatchObject({ status: "todo" });
    expect(await nextReviews()).toEqual([]);

    registry.agents.delete("deckhand");
    await t.clock.advance(HOUR);

    expect(await task(questionId)).toMatchObject({ settled_by_observation: "routing_proposal_stale" });
    expect(await nextReviews()).toHaveLength(1);
  } finally {
    await client.close();
  }
});

it("registry の無い盤面では agent の段の提案は断られる", async () => {
  t = await bootTidepool();
  await routingMaterialViaWebui(t);
  await startFirstMetaReviewViaWebui(t, "routing");
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
