import { afterEach, expect, it } from "vitest";
import { createBehaviorCandidate, proposeMemoryChange } from "../src/memory.js";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, completeViaMcp, HOUR, managementMcpClient, mcpClient, type Tidepool } from "./harness.js";

/** routing の行の提案 question(issue #918 / ADR 0150 決定1・2)のサーバ境界: 提案 verb、付帯子としての question、回答での
 *  適用と修正値、pin の陳腐化、過去の提案の読み口。pin の照合と修正値の合成はドメイン層(tests/execution-setting.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

const OPUS = { provider: "anthropic", tier: "standard", model: "opus", effort: "high", price_in: 5, price_out: 25 };

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
  const propose = async (change: Record<string, unknown> = { tier: "frontier" }, row = { provider: "anthropic", model: "opus" }) =>
    (await call("propose_routing_change", { op: "row", row, change, rationale: "12 of 14 opus episodes were underpowered." })).question_id as string;
  return { review, client, call, propose };
}

const task = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;

it("行の提案は meta-review の子に1 item の question を立て、その行の全欄を pin に焼き、detail に散文 diff と根拠を載せる", async () => {
  const { review, client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier", effort: "max" });

    const question = await task(questionId);
    expect(question).toMatchObject({
      type: "question",
      status: "todo",
      parent_id: review.id,
      question_proposal: { kind: "routing", op: "row", row: { provider: "anthropic", model: "opus" }, change: { tier: "frontier", effort: "max" }, pin: OPUS },
      question_items: [{ options: ["approve", "reject"], recommendation: "approve" }],
    });
    expect(question.question_items).toHaveLength(1);
    const { detail } = question.question_items[0];
    for (const shown of ["anthropic / opus", "tier: standard -> frontier", "effort: high -> max", "12 of 14 opus episodes were underpowered."]) {
      expect(detail).toContain(shown);
    }
  } finally {
    await client.close();
  }
});

it("表に無い行の提案と schema 違反の変更は断られ、question は立たない(変更の schema の中身はドメイン層が言う)", async () => {
  const { review, client, call } = await boardWithRoutingReview();
  try {
    for (const [row, change] of [
      [{ provider: "anthropic", model: "haiku" }, { tier: "economy" }],
      [{ provider: "anthropic", model: "opus" }, { tier: "ultra" }],
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
const row = async (model: string) =>
  ((await api(t.baseUrl, "GET", "/api/settings/execution")).json.table as any[]).find((r) => r.provider === "anthropic" && r.model === model);

it("approve で表の行が提案の値になり、推奨どおりに数えられる", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });

    expect((await answer(questionId, { answers: ["approve"] })).status).toBe(200);

    expect(await row("opus")).toEqual({ ...OPUS, tier: "frontier" });
    // 適用は回答の印を持ち、meta-review の材料に数えられない(ADR 0151)
    expect(JSON.parse((t.db.prepare("SELECT payload FROM events WHERE id = ?").get(lastSettingsChange()) as { payload: string }).payload)).toMatchObject({ question_id: questionId });
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

    expect(await row("opus")).toEqual({ ...OPUS, tier: "frontier", effort: "max" });
    expect((await events(questionId)).find((e) => e.kind === "question_answered").payload).toMatchObject({
      answers: [{ answer: "approve", recommendation_accepted: false }],
      amendment: { effort: "max" },
    });
  } finally {
    await client.close();
  }
});

it("schema 違反の修正値・reject に添えた修正値・memory の提案への修正値は回答ごと断られ、question は open のまま何も書かれない", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });
    for (const body of [
      { answers: ["approve"], amendment: { tier: "ultra" } },
      { answers: ["reject"], amendment: { effort: "max" } },
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
    expect(await row("opus")).toEqual(OPUS);
  } finally {
    await client.close();
  }

  const memoryQuestion = registerMemoryProposal(t);
  expect((await answer(memoryQuestion, { answers: ["approve"], amendment: { effort: "max" } })).status).toBe(409);
  expect(await task(memoryQuestion)).toMatchObject({ status: "todo", question_answer: null });
});

/** memory の提案 question(修正値の拒否だけを見るので、親は普通の task でよい)。 */
function registerMemoryProposal(tp: Tidepool): string {
  const candidate = createBehaviorCandidate(
    tp.db,
    { scope: null, path: "habits", title: "Split migrations", text: "Split migrations.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    tp.clock.now(),
  ).entry_id;
  const parent = registerTask(tp.db, { type: "work", title: "p", purpose: "p", completion_criteria: "c" }, tp.clock.now());
  return proposeMemoryChange(tp.db, parent.id, { op: "approve", candidate_id: candidate, rationale: "r" }, "auditor", tp.clock.now()).question_id;
}

it("reject で表は変わらず、コメントが回答に残る", async () => {
  const { client, propose } = await boardWithRoutingReview();
  try {
    const questionId = await propose({ tier: "frontier" });

    expect((await answer(questionId, { answers: ["reject"], comment: "opus struggled only on the migration tasks" })).status).toBe(200);

    expect(await row("opus")).toEqual(OPUS);
    expect(await task(questionId)).toMatchObject({ status: "done", question_answer: ["reject"], question_answer_comment: "opus struggled only on the migration tasks" });
  } finally {
    await client.close();
  }
});

const lastSettingsChange = () =>
  (t.db.prepare("SELECT MAX(id) AS id FROM events WHERE kind = 'execution_settings_changed'").get() as { id: number }).id;
const staleEvents = async (id: string) => (await events(id)).filter((e) => e.kind !== "task_registered").map((e) => [e.kind, e.worker_id, e.payload]);

it("pin の行を settings タブで編集する・管理MCP で消すと open な提案は観測で決着し routing_proposal_stale が残る", async () => {
  const { client, propose } = await boardWithRoutingReview();
  const management = await managementMcpClient(t.baseUrl);
  try {
    const edited = await propose({ tier: "frontier" });
    const deleted = await propose({ effort: "max" }, { provider: "anthropic", model: "sonnet" });

    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: { ...OPUS, price_out: 30 } })).status).toBe(200);
    const editEvent = lastSettingsChange();
    const removal: any = await management.callTool({ name: "change_execution_settings", arguments: { change: { setting: "delete_row", provider: "anthropic", model: "sonnet" } } });
    expect(removal.isError).not.toBe(true);
    const deleteEvent = lastSettingsChange();

    expect(await task(edited)).toMatchObject({ status: "done", question_answer: null });
    expect(await staleEvents(edited)).toEqual([
      ["routing_proposal_stale", "tidepool", { kind: "routing_proposal_stale", question_id: edited, proposal_kind: "routing", changed: ["price_out"], observed_event_id: editEvent }],
    ]);
    expect(await task(deleted)).toMatchObject({ status: "done", question_answer: null });
    expect(await staleEvents(deleted)).toEqual([
      ["routing_proposal_stale", "tidepool", { kind: "routing_proposal_stale", question_id: deleted, proposal_kind: "routing", changed: null, observed_event_id: deleteEvent }],
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

    const fable = { provider: "anthropic", tier: "frontier", model: "fable", effort: "max", price_in: 10, price_out: 50 };
    for (const change of [{ setting: "row", row: fable }, { setting: "priority", value: "quality" }, { setting: "frontier_advisor", value: true }]) {
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
    const rejected = await propose({ effort: "low" }, { provider: "openai", model: "gpt-5.6-sol" });
    const stale = await propose({ tier: "economy" }, { provider: "openai", model: "gpt-6-astra" });
    const open = await propose({ effort: "max" }, { provider: "anthropic", model: "sonnet" });
    expect((await answer(amended, { answers: ["approve"], amendment: { effort: "max" }, comment: "and give it room" })).status).toBe(200);
    expect((await answer(rejected, { answers: ["reject"], comment: "sol is fine at high" })).status).toBe(200);
    const astra = { provider: "openai", tier: "frontier", model: "gpt-6-astra", effort: "high", price_in: 12, price_out: 50 };
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: astra })).status).toBe(200);
    const observed = lastSettingsChange();

    const proposal = async (id: string) => (await task(id)).question_proposal;
    expect((await call("read_routing_settings")).proposals).toEqual([
      { question_id: amended, proposal: await proposal(amended), answer: "approve", amendment: { effort: "max" }, comment: "and give it room", observed: null },
      { question_id: rejected, proposal: await proposal(rejected), answer: "reject", amendment: null, comment: "sol is fine at high", observed: null },
      { question_id: stale, proposal: await proposal(stale), answer: null, amendment: null, comment: null, observed: { changed: ["price_in"], observed_event_id: observed } },
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
      ["routing_proposal_stale", "tidepool", { kind: "routing_proposal_stale", question_id: b, proposal_kind: "routing", changed: ["tier"], observed_event_id: lastSettingsChange() }],
    ]);
  } finally {
    await client.close();
  }
});
