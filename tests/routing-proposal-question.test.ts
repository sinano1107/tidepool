import { afterEach, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { createBehaviorCandidate, proposeMemoryChange } from "../src/memory.js";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, completeViaMcp, HOUR, HUMAN_WEBUI, managementMcpClient, mcpClient, type Tidepool, WORKER_SPAWNED } from "./harness.js";

/** routing の行の提案 question(issue #918 / ADR 0150 決定1・2)のサーバ境界: 提案 verb、付帯子としての question、回答での
 *  適用と修正値、pin の陳腐化、過去の提案の読み口。pin の照合と修正値の合成はドメイン層(tests/execution-setting.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

const OPUS = { provider: "anthropic", tier: "standard", model: "claude-opus-5-5", effort: "high", price_in: 5, price_out: 25 };

/** routing の材料で poll させ、slot に入った routing meta-review の接続を返す。 */
async function boardWithRoutingReview() {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" })).status).toBe(200);
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "routing");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  const propose = async (change: Record<string, unknown> = { tier: "frontier" }, row = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }) =>
    (await call("propose_routing_change", { op: "row", row, change, rationale: "12 of 14 opus episodes were underpowered." })).question_id as string;
  return { review, client, call, propose };
}

const task = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;

it("行の提案は meta-review の子に1 item の question を立て、その行の全欄を pin に焼き、detail に散文 diff と根拠を載せ、open な間の門の1文で終える(ADR 0165 決定4)", async () => {
  const { review, client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier", effort: "max" });

    const question = await task(questionId);
    expect(question).toMatchObject({
      type: "question",
      status: "todo",
      parent_id: review.id,
      question_proposal: { kind: "routing", op: "row", row: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, change: { tier: "frontier", effort: "max" }, pin: OPUS },
      question_items: [{ options: ["approve", "reject"], recommendation: "approve" }],
    });
    expect(question.question_items).toHaveLength(1);
    const { detail } = question.question_items[0];
    for (const shown of ["anthropic / claude-opus-5-5", "tier: standard -> frontier", "effort: high -> max", "12 of 14 opus episodes were underpowered."]) {
      expect(detail).toContain(shown);
    }
    expect(detail).toMatch(/\nWhile this question is open, the next routing meta-review is not registered\.$/);
  } finally {
    await client.close();
  }
});

it("表に無い行の提案と schema 違反の変更は断られ、question は立たない(変更の schema の中身はドメイン層が言う)", async () => {
  const { review, client, call } = await boardWithRoutingReview();
  try {
    for (const [row, change] of [
      [{ provider: "anthropic", model: "haiku", effort: "high" }, { tier: "economy" }],
      [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, { tier: "ultra" }],
    ]) {
      expect(await call("propose_routing_change", { op: "row", row, change, rationale: "r" })).toMatchObject({
        error: expect.stringMatching(/has no row for|a row change takes tier/),
      });
    }
    expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((q) => q.parent_id === review.id)).toEqual([]);
  } finally {
    await client.close();
  }
});

it("提案 question が open でも meta-review は完了できる", async () => {
  const { review, client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose();

    expect((await completeViaMcp(t, review.id, false)).isError).not.toBe(true);
    expect(await task(review.id)).toMatchObject({ status: "done" });
    expect(await task(questionId)).toMatchObject({ status: "todo" });
  } finally {
    await client.close();
  }
});

const answer = (id: string, body: Record<string, unknown>) => api(t.baseUrl, "POST", `/api/tasks/${id}/answer`, body);
const events = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
/** 行の欄だけ(行の Quarantine の question id は落とす)。 */
const row = async (model: string) => {
  const found = ((await api(t.baseUrl, "GET", "/api/settings/execution")).json.table as any[]).find((r) => r.provider === "anthropic" && r.model === model);
  const { quarantine_question_id: _, ...fields } = found;
  return fields;
};

it("approve で表の行が提案の値になり、推奨どおりに数えられる", async () => {
  const { client, call, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });

    expect((await answer(questionId, { answers: ["approve"] })).status).toBe(200);

    expect(await row("claude-opus-5-5")).toEqual({ ...OPUS, tier: "frontier" });
    // 適用は回答の印を持ち、人間が変えた行として meta-review に読まれない(ADR 0151)
    expect((await call("list_routing_cells", { since_watermark: 0 })).rows).toEqual([]);
    expect((await events(questionId)).find((e) => e.kind === "question_answered").payload).toEqual(
      expect.objectContaining({ answers: [{ answer: "approve", recommendation_accepted: true }] }),
    );
  } finally {
    await client.close();
  }
});

it("修正値つき approve では行が提案に修正値を重ねた値になり、修正値が回答に残り、推奨どおりに数えない", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });

    expect((await answer(questionId, { answers: ["approve"], amendment: { effort: "max" } })).status).toBe(200);

    expect(await row("claude-opus-5-5")).toEqual({ ...OPUS, tier: "frontier", effort: "max" });
    expect((await events(questionId)).find((e) => e.kind === "question_answered").payload).toMatchObject({
      answers: [{ answer: "approve", recommendation_accepted: false }],
      amendment: { effort: "max" },
    });
  } finally {
    await client.close();
  }
});

it("schema 違反の修正値・reject に添えた修正値・memory の提案への行の修正値は回答ごと断られ、question は open のまま何も書かれない", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });
    for (const body of [
      { answers: ["approve"], amendment: { tier: "ultra" } },
      { answers: ["reject"], comment: "not now", amendment: { effort: "max" } },
    ]) {
      expect((await answer(questionId, body)).status).toBe(409);
    }
    // 管理MCP の扉も修正値を運ぶ —— 落とせば素の approve として通ってしまう
    const management = await managementMcpClient(t.baseUrl);
    try {
      const viaMcp: any = await management.callTool({ name: "answer_question", arguments: { task_id: questionId, answers: ["approve"], amendment: { tier: "ultra" } } });
      expect(viaMcp.isError).toBe(true);
    } finally {
      await management.close();
    }
    expect(await task(questionId)).toMatchObject({ status: "todo", question_answer: null });
    expect((await events(questionId)).map((e) => e.kind)).toEqual(["task_registered"]);
    expect(await row("claude-opus-5-5")).toEqual(OPUS);
  } finally {
    await client.close();
  }

  const memoryQuestion = registerMemoryProposal(t);
  expect((await answer(memoryQuestion, { answers: ["approve"], amendment: { effort: "max" } })).status).toBe(409);
  expect(await task(memoryQuestion)).toMatchObject({ status: "todo", question_answer: null });
});

/** memory の提案 question(種別違いの修正値の拒否だけを見るので、親は普通の task でよい)。 */
function registerMemoryProposal(tp: Tidepool): string {
  const candidate = createBehaviorCandidate(
    tp.db,
    { scope: null, path: "habits", title: "Split migrations", text: "Split migrations.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    tp.clock.now(),
  ).entry_id;
  const parent = registerTask(tp.db, { type: "work", title: "p", purpose: "p", completion_criteria: "c" }, tp.clock.now(), ...HUMAN_WEBUI);
  return proposeMemoryChange(tp.db, parent.id, { op: "approve", candidate_id: candidate, rationale: "r" }, "auditor", tp.clock.now()).question_id;
}

it("reject で表は変わらず、コメントが回答に残る", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });

    expect((await answer(questionId, { answers: ["reject"], comment: "opus struggled only on the migration tasks" })).status).toBe(200);

    expect(await row("claude-opus-5-5")).toEqual(OPUS);
    expect(await task(questionId)).toMatchObject({ status: "done", question_answer: ["reject"], question_answer_comment: "opus struggled only on the migration tasks" });
  } finally {
    await client.close();
  }
});

const staleEvents = async (id: string) => (await events(id)).filter((e) => e.kind !== "task_registered").map((e) => [e.kind, e.worker_id, e.payload]);

it("pin の行を settings タブで編集する・管理MCP で消すと open な提案は観測で決着し routing_proposal_stale が残る", async () => {
  const { client, propose } = await boardWithRoutingReview();
  const management = await managementMcpClient(t.baseUrl);
  try {
    const edited = await propose({ tier: "frontier" });
    const deleted = await propose({ effort: "max" }, { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });

    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", key: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, row: { ...OPUS, price_out: 30 } })).status).toBe(200);
    const removal: any = await management.callTool({ name: "change_execution_settings", arguments: { change: { setting: "delete_row", provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" } } });
    expect(removal.isError).not.toBe(true);

    expect(await task(edited)).toMatchObject({ status: "done", question_answer: null });
    expect(await staleEvents(edited)).toEqual([
      ["routing_proposal_stale", "tidepool", { kind: "routing_proposal_stale", question_id: edited, proposal_kind: "routing", changed: ["price_out"], observed_event_id: expect.any(Number) }],
    ]);
    expect(await task(deleted)).toMatchObject({ status: "done", question_answer: null });
    expect(await staleEvents(deleted)).toEqual([
      ["routing_proposal_stale", "tidepool", { kind: "routing_proposal_stale", question_id: deleted, proposal_kind: "routing", changed: null, observed_event_id: expect.any(Number) }],
    ]);
  } finally {
    await client.close();
    await management.close();
  }
});

it("別の行・別の設定の編集では提案は open のまま", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });

    const fable = { provider: "anthropic", tier: "frontier", model: "claude-fable-5-1", effort: "max", price_in: 10, price_out: 50 };
    for (const change of [{ setting: "row", key: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" }, row: fable }, { setting: "priority", value: "quality" }, { setting: "advisor_above_main", value: true }]) {
      expect((await api(t.baseUrl, "POST", "/api/settings/execution", change)).status).toBe(200);
    }

    expect(await task(questionId)).toMatchObject({ status: "todo" });
    expect(await staleEvents(questionId)).toEqual([]);
  } finally {
    await client.close();
  }
});

it("read_routing_settings は過去の routing の提案を、回答・修正値・コメント・observed の理由とともに返す", async () => {
  const { client, call, propose } = await boardWithRoutingReview();
  try {
    const amended = await propose({ tier: "frontier" });
    const rejected = await propose({ effort: "low" }, { provider: "openai", model: "gpt-5.6-sol", effort: "high" });
    const stale = await propose({ tier: "economy" }, { provider: "openai", model: "gpt-6-astra", effort: "high" });
    const open = await propose({ effort: "max" }, { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });
    expect((await answer(amended, { answers: ["approve"], amendment: { effort: "max" }, comment: "and give it room" })).status).toBe(200);
    expect((await answer(rejected, { answers: ["reject"], comment: "sol is fine at high" })).status).toBe(200);
    const astra = { provider: "openai", tier: "frontier", model: "gpt-6-astra", effort: "high", price_in: 12, price_out: 50 };
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", key: { provider: "openai", model: "gpt-6-astra", effort: "high" }, row: astra })).status).toBe(200);

    const proposal = async (id: string) => (await task(id)).question_proposal;
    expect((await call("read_routing_settings")).proposals).toEqual([
      { question_id: amended, proposal: await proposal(amended), answer: "approve", amendment: { effort: "max" }, comment: "and give it room", observed: null },
      { question_id: rejected, proposal: await proposal(rejected), answer: "reject", amendment: null, comment: "sol is fine at high", observed: null },
      { question_id: stale, proposal: await proposal(stale), answer: null, amendment: null, comment: null, observed: { changed: ["price_in"], observed_event_id: expect.any(Number) } },
      { question_id: open, proposal: await proposal(open), answer: null, amendment: null, comment: null, observed: null },
    ]);
  } finally {
    await client.close();
  }
});

it("同じ行の提案 A の承認は open な提案 B を観測で決着させるが、A 自身は回答で決着する", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const a = await propose({ tier: "frontier" });
    const b = await propose({ effort: "max" });

    expect((await answer(a, { answers: ["approve"] })).status).toBe(200);

    expect((await events(a)).map((e) => e.kind)).toEqual(["task_registered", "question_answered"]);
    expect(await staleEvents(b)).toEqual([
      ["routing_proposal_stale", "tidepool", { kind: "routing_proposal_stale", question_id: b, proposal_kind: "routing", changed: ["tier"], observed_event_id: expect.any(Number) }],
    ]);
  } finally {
    await client.close();
  }
});

const learnerPromoted = async () => (await api(t.baseUrl, "GET", "/api/settings/execution")).json.learnerPromoted as boolean;

it("昇格の提案はフラグが寝ている間だけ立ち、pin にフラグの現在値を焼く —— 立っている間の昇格と寝ている間の降格は断られる", async () => {
  const { review, client, call } = await boardWithRoutingReview();
  try {
    expect(await call("propose_routing_change", { op: "demote", rationale: "r" })).toMatchObject({ error: expect.stringContaining("not promoted") });
    const { question_id } = await call("propose_routing_change", { op: "promote", rationale: "the learner beat the table on 9 of 11 diverged episodes." });

    const question = await task(question_id);
    expect(question).toMatchObject({
      type: "question",
      status: "todo",
      parent_id: review.id,
      question_proposal: { kind: "routing", op: "promote", pin: { promoted: false } },
      question_items: [{ title: "Promote the learner", options: ["approve", "reject"], recommendation: "approve" }],
    });
    expect(question.question_items).toHaveLength(1);
    expect(question.question_items[0].detail).toContain("the learner beat the table on 9 of 11 diverged episodes.");

    expect((await answer(question_id, { answers: ["approve"] })).status).toBe(200);
    expect(await learnerPromoted()).toBe(true);
    expect(await call("propose_routing_change", { op: "promote", rationale: "r" })).toMatchObject({ error: expect.stringContaining("already promoted") });
    expect(await call("propose_routing_change", { op: "demote", change: { tier: "economy" }, rationale: "r" })).toMatchObject({ error: expect.stringContaining("takes no row and no change") });
  } finally {
    await client.close();
  }
});

it("昇格の reject ではフラグは立たず、降格の approve でフラグが寝る", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    const rejected = (await call("propose_routing_change", { op: "promote", rationale: "r" })).question_id;
    expect((await answer(rejected, { answers: ["reject"], comment: "not yet" })).status).toBe(200);
    expect(await learnerPromoted()).toBe(false);

    const promoted = (await call("propose_routing_change", { op: "promote", rationale: "r" })).question_id;
    expect((await answer(promoted, { answers: ["approve"] })).status).toBe(200);
    const demoted = (await call("propose_routing_change", { op: "demote", rationale: "the learner misrouted migrations." })).question_id;
    expect((await task(demoted)).question_proposal).toEqual({ kind: "routing", op: "demote", pin: { promoted: true } });
    expect((await answer(demoted, { answers: ["approve"] })).status).toBe(200);
    expect(await learnerPromoted()).toBe(false);
  } finally {
    await client.close();
  }
});

it("昇格 / 降格の approve に添えた修正値は回答ごと断られ、フラグは変わらない(ADR 0150 決定2)", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    const questionId = (await call("propose_routing_change", { op: "promote", rationale: "r" })).question_id;

    expect((await answer(questionId, { answers: ["approve"], amendment: { tier: "frontier" } })).status).toBe(409);

    expect(await task(questionId)).toMatchObject({ status: "todo", question_answer: null });
    expect(await learnerPromoted()).toBe(false);
  } finally {
    await client.close();
  }
});
const settingsChange = (body: Record<string, unknown>) => api(t.baseUrl, "POST", "/api/settings/execution", body);

it("行の提案が触れる段(pin の段・変更の段)を改名しても question は open のまま、いまの名前で見え、修正値なしの approve がいまの名前で適用される(issue #1436)", async () => {
  const { client, call, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });
    expect((await settingsChange({ setting: "rename_tier", name: "standard", to: "mid" })).status).toBe(200);
    expect((await settingsChange({ setting: "rename_tier", name: "frontier", to: "top" })).status).toBe(200);

    const question = await task(questionId);
    expect(question).toMatchObject({ status: "todo", question_proposal: { change: { tier: "top" }, pin: { ...OPUS, tier: "mid" } } });
    expect((await call("read_routing_settings")).proposals).toMatchObject([{ question_id: questionId, proposal: question.question_proposal }]);

    expect((await answer(questionId, { answers: ["approve"] })).status).toBe(200);
    expect(await row("claude-opus-5-5")).toEqual({ ...OPUS, tier: "top" });
  } finally {
    await client.close();
  }
});

it("改名で空いた旧い名前で新しい段を足しても、旧い名前を焼いた行の提案はその新しい段に付け替わらず、改名した段へ適用される(issue #1436)", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "standard" }, { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });
    expect((await settingsChange({ setting: "rename_tier", name: "standard", to: "mid" })).status).toBe(200);
    expect((await settingsChange({ setting: "insert_tier", name: "standard", description: "A new tier reusing the old name.", position: 1 })).status).toBe(200);

    expect((await task(questionId)).question_proposal).toMatchObject({ change: { tier: "mid" } });
    expect((await answer(questionId, { answers: ["approve"] })).status).toBe(200);
    expect(await row("claude-sonnet-5-5")).toMatchObject({ tier: "mid" });
  } finally {
    await client.close();
  }
});

it("行の提案の変更の段が消されると提案は削除の時点で観測で決着し、同じ名前の新しい段が足されてもその段へは適用されない(issue #1436 / #1458)", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const careful = { setting: "insert_tier", name: "careful", description: "A tier the proposal moves the row into.", position: 1 };
    expect((await settingsChange(careful)).status).toBe(200);
    const questionId = await propose({ tier: "careful" }, { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });
    expect((await settingsChange({ setting: "delete_tier", name: "careful" })).status).toBe(200);

    expect(await task(questionId)).toMatchObject({ status: "done", question_answer: null });
    expect(await staleEvents(questionId)).toEqual([
      ["routing_proposal_stale", "tidepool", { kind: "routing_proposal_stale", question_id: questionId, proposal_kind: "routing", changed: ["target_tier"], observed_event_id: expect.any(Number) }],
    ]);

    expect((await settingsChange({ ...careful, description: "A new tier reusing the deleted name." })).status).toBe(200);
    expect((await answer(questionId, { answers: ["approve"] })).status).toBe(409);
    expect(await row("claude-sonnet-5-5")).toMatchObject({ tier: "economy" });
  } finally {
    await client.close();
  }
});

// 段の説明の書き換えの提案(ADR 0200 決定7): 根拠は床を task の申告が決めた episode。

/** 根拠の episode(setup): 書き手が人間の task が `tier` を要求し、床の出所が `tierSource` の worker_spawned。 */
function declaredSession(tp: Tidepool, tier: string, tierSource: "task" | "agent" = "task"): number {
  const { id } = registerTask(tp.db, { type: "work", title: "evidence", purpose: "p", completion_criteria: "c", tier }, tp.clock.now(), ...HUMAN_WEBUI);
  return appendEvent(tp.db, {
    taskId: id,
    workerId: "deckhand",
    origin: "board",
    at: tp.clock.now(),
    payload: { ...WORKER_SPAWNED, source: { tier: tierSource, provider: "rank" } },
  });
}

const tierDescription = async (name: string) =>
  ((await api(t.baseUrl, "GET", "/api/settings/execution")).json.tiers as Array<{ name: string; description: string }>).find((tier) => tier.name === name)?.description;
const NEW_STANDARD = "Work where the approach has to be worked out, including any change that spans more than one module.";

async function proposeTierDescription(call: (name: string, args: Record<string, unknown>) => Promise<any>, evidence = [declaredSession(t, "standard")]) {
  return call("propose_routing_change", { op: "tier_description", tier: "standard", description: NEW_STANDARD, evidence, rationale: "5 of 6 standard declarations were overpowered." });
}

it("段の説明の提案は説明のいまの文面を pin に焼き、approve で説明が書き換わる", async () => {
  const { review, client, call } = await boardWithRoutingReview();
  try {
    const current = await tierDescription("standard");
    const evidence = declaredSession(t, "standard");
    const { question_id } = await proposeTierDescription(call, [evidence]);

    const question = await task(question_id);
    expect(question).toMatchObject({
      status: "todo",
      parent_id: review.id,
      question_proposal: { kind: "routing", op: "tier_description", tier: "standard", description: NEW_STANDARD, evidence: [evidence], pin: { description: current } },
    });
    for (const shown of [current, NEW_STANDARD, "5 of 6 standard declarations were overpowered."]) expect(question.question_items[0].detail).toContain(shown);

    expect((await answer(question_id, { answers: ["approve"] })).status).toBe(200);
    expect(await tierDescription("standard")).toBe(NEW_STANDARD);
  } finally {
    await client.close();
  }
});

it("段の説明の提案の修正値つき approve は修正後の文面を書き、reject は何も書かず、形の違う修正値は回答ごと断られる", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    const current = await tierDescription("standard");
    const rejected = (await proposeTierDescription(call)).question_id;
    expect((await answer(rejected, { answers: ["reject"], comment: "keep it" })).status).toBe(200);
    expect(await tierDescription("standard")).toBe(current);

    const amended = (await proposeTierDescription(call)).question_id;
    for (const amendment of [{ description: "two\nlines" }, { description: "ok", tier: "economy" }, { tier: "frontier" }]) {
      expect((await answer(amended, { answers: ["approve"], amendment })).status).toBe(409);
    }
    expect(await task(amended)).toMatchObject({ status: "todo" });
    expect((await answer(amended, { answers: ["approve"], amendment: { description: "Amended by the human." } })).status).toBe(200);
    expect(await tierDescription("standard")).toBe("Amended by the human.");
  } finally {
    await client.close();
  }
});

it("人間が先に段の説明を直すと提案は回答なしで観測で決着し、別の段・行・同じ段の位置の編集では open のまま", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    const { question_id } = await proposeTierDescription(call);
    const fable = { provider: "anthropic", tier: "frontier", model: "claude-fable-5-1", effort: "max", price_in: 10, price_out: 50 };
    for (const change of [
      { setting: "edit_tier", name: "economy", description: "Edited economy." },
      { setting: "edit_tier", name: "standard", position: 0 },
      { setting: "row", key: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" }, row: fable },
    ]) {
      expect((await api(t.baseUrl, "POST", "/api/settings/execution", change)).status).toBe(200);
    }
    expect(await task(question_id)).toMatchObject({ status: "todo" });

    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "edit_tier", name: "standard", description: "Edited by a human." })).status).toBe(200);

    expect(await task(question_id)).toMatchObject({ status: "done", question_answer: null });
    expect(await staleEvents(question_id)).toEqual([
      ["routing_proposal_stale", "tidepool", { kind: "routing_proposal_stale", question_id, proposal_kind: "routing", changed: ["description"], observed_event_id: expect.any(Number) }],
    ]);
  } finally {
    await client.close();
  }
});

it("段の説明の提案の段を改名しても question は open のまま、いまの名前で見え、修正値なしの approve がその段の説明を書く(issue #1436)", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    const { question_id } = await proposeTierDescription(call);
    expect((await settingsChange({ setting: "rename_tier", name: "standard", to: "mid" })).status).toBe(200);

    expect(await task(question_id)).toMatchObject({ status: "todo", question_proposal: { tier: "mid" } });
    expect((await answer(question_id, { answers: ["approve"] })).status).toBe(200);
    expect(await tierDescription("mid")).toBe(NEW_STANDARD);
  } finally {
    await client.close();
  }
});

it("段の説明の提案の根拠が task の申告で床を決めていない・別の段を要求した task の session なら、また文面がいまの説明と同じなら断られ、question は立たない", async () => {
  const { review, client, call } = await boardWithRoutingReview();
  try {
    expect(await proposeTierDescription(call, [declaredSession(t, "standard", "agent")])).toMatchObject({ error: expect.stringContaining("not from its task") });
    expect(await proposeTierDescription(call, [declaredSession(t, "economy")])).toMatchObject({ error: expect.stringContaining("did not request standard") });
    expect(
      await call("propose_routing_change", { op: "tier_description", tier: "standard", description: await tierDescription("standard"), evidence: [declaredSession(t, "standard")], rationale: "no change" }),
    ).toMatchObject({ error: expect.stringContaining("already reads") });
    expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((q) => q.parent_id === review.id)).toEqual([]);
  } finally {
    await client.close();
  }
});
