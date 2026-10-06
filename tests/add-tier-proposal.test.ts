import { afterEach, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { SEED_TIERS } from "../src/execution-setting.js";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, HUMAN_WEBUI, mcpClient, type Tidepool, WORKER_SPAWNED } from "./harness.js";

/** 段を足して行を移す提案(issue #1424 / ADR 0200 決定8)のサーバ境界: 提案 verb と pin、approve での段の挿入と行の移動、
 *  修正値、修正後の名前の衝突で回答ごと拒むこと、隣の段・移す行の変更での陳腐化。pin の照合と修正値の形はドメイン層
 *  (tests/execution-setting.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

const [economy, standard, frontier] = SEED_TIERS;
const OPUS = { provider: "anthropic", tier: "standard", model: "claude-opus-5-5", effort: "high", price_in: 5, price_out: 25 };
const OPUS_KEY = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
const CAREFUL = { name: "careful", description: "Work where standard missed a cross-file invariant but frontier is more than needed.", position: 2 };

/** routing の材料で poll させ、slot に入った routing meta-review から opus の行を standard と frontier の間の新しい段へ移す提案を立てる。 */
async function boardWithAddTierProposal() {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" })).status).toBe(200);
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "routing");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  // 足す段は tool の平たい欄(tier = 名前、description、position)で渡す
  const call = async ({ tier, ...args }: { tier?: { name: string; description: string; position: number } } & Record<string, unknown>) => {
    const flat = tier && { tier: tier.name, description: tier.description, position: tier.position };
    const result: any = await client.callTool({ name: "propose_routing_change", arguments: { op: "add_tier", rationale: "opus split 6 / 6 on standard work.", ...args, ...flat } });
    return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
  };
  return { review, client, call };
}

/** 根拠の episode(setup): 表の opus の行で走った worker_spawned。 */
function spawned(): number {
  const { id } = registerTask(t.db, { type: "work", title: "evidence", purpose: "p", completion_criteria: "c" }, t.clock.now(), ...HUMAN_WEBUI);
  return appendEvent(t.db, { taskId: id, workerId: "fugu", origin: "board", at: t.clock.now(), payload: { ...WORKER_SPAWNED, provider: "anthropic", model: "claude-opus-5-5" } });
}

const task = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;
const events = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
const answer = (id: string, body: Record<string, unknown>) => api(t.baseUrl, "POST", `/api/tasks/${id}/answer`, body);
const change = (body: Record<string, unknown>) => api(t.baseUrl, "POST", "/api/settings/execution", body);
/** 段の一覧と opus の行(行の Quarantine の question id は落とす)。 */
const settings = async () => {
  const { tiers, table } = (await api(t.baseUrl, "GET", "/api/settings/execution")).json;
  const { quarantine_question_id: _, ...opus } = (table as any[]).find((r) => r.model === "claude-opus-5-5");
  return { tiers, opus };
};

it("提案は meta-review の子に1 item の question を立て、段・移す行・根拠と、移す行の全欄と位置の隣の段を pin に焼く", async () => {
  const { review, client, call } = await boardWithAddTierProposal();
  try {
    const evidence = [spawned()];
    const { question_id } = await call({ tier: CAREFUL, row: OPUS_KEY, evidence });

    const question = await task(question_id);
    expect(question).toMatchObject({
      type: "question",
      status: "todo",
      parent_id: review.id,
      question_proposal: { kind: "routing", op: "add_tier", tier: CAREFUL, row: OPUS_KEY, evidence, pin: { row: OPUS, below: standard, above: frontier } },
      question_items: [{ options: ["approve", "reject"], recommendation: "approve" }],
    });
    for (const shown of ["careful", CAREFUL.description, "anthropic / claude-opus-5-5", "opus split 6 / 6 on standard work."]) {
      expect(question.question_items[0].detail).toContain(shown);
    }
  } finally {
    await client.close();
  }
});

it("既存の段の名前・表に無い行・範囲外の位置・worker_spawned でない根拠・根拠なしの提案は断られる", async () => {
  const { review, client, call } = await boardWithAddTierProposal();
  try {
    const evidence = [spawned()];
    for (const [args, error] of [
      [{ tier: { ...CAREFUL, name: "standard" }, row: OPUS_KEY, evidence }, /already has a tier named/],
      [{ tier: { ...CAREFUL, name: "Careful" }, row: OPUS_KEY, evidence }, /must start with a lowercase letter/],
      [{ tier: { ...CAREFUL, description: "" }, row: OPUS_KEY, evidence }, /one non-empty line/],
      [{ tier: { ...CAREFUL, position: 4 }, row: OPUS_KEY, evidence }, /0 to 3/],
      [{ tier: CAREFUL, row: { ...OPUS_KEY, effort: "max" }, evidence }, /has no row for/],
      [{ tier: CAREFUL, row: OPUS_KEY, evidence: [1] }, /not a worker_spawned event/],
      [{ tier: CAREFUL, row: OPUS_KEY }, /at least one evidence/],
    ] as const) {
      expect(await call(args)).toMatchObject({ error: expect.stringMatching(error) });
    }
    expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((q) => q.parent_id === review.id)).toEqual([]);
  } finally {
    await client.close();
  }
});

it("approve で段が指定の位置に足され、行がその段に移り、2つの書き込みが回答の印を持つ", async () => {
  const { client, call } = await boardWithAddTierProposal();
  try {
    const { question_id } = await call({ tier: CAREFUL, row: OPUS_KEY, evidence: [spawned()] });

    expect((await answer(question_id, { answers: ["approve"] })).status).toBe(200);

    expect(await settings()).toEqual({ tiers: [economy, standard, { name: CAREFUL.name, description: CAREFUL.description }, frontier], opus: { ...OPUS, tier: "careful" } });
    expect(await task(question_id)).toMatchObject({ status: "done" });
  } finally {
    await client.close();
  }
});

it("修正値つき approve は修正後の名前・説明・位置で適用する", async () => {
  const { client, call } = await boardWithAddTierProposal();
  try {
    const { question_id } = await call({ tier: CAREFUL, row: OPUS_KEY, evidence: [spawned()] });

    const amendment = { name: "thorough", description: "Amended description.", position: 1 };
    expect((await answer(question_id, { answers: ["approve"], amendment })).status).toBe(200);

    expect(await settings()).toEqual({ tiers: [economy, { name: "thorough", description: "Amended description." }, standard, frontier], opus: { ...OPUS, tier: "thorough" } });
    expect((await events(question_id)).find((e) => e.kind === "question_answered").payload).toMatchObject({ amendment });
  } finally {
    await client.close();
  }
});

it("修正後の名前が既存の段と重なる approve は回答ごと拒まれ、段も行も変わらず question は open のまま", async () => {
  const { client, call } = await boardWithAddTierProposal();
  try {
    const { question_id } = await call({ tier: CAREFUL, row: OPUS_KEY, evidence: [spawned()] });
    const before = await settings();

    const refused = await answer(question_id, { answers: ["approve"], amendment: { name: "frontier" } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/already has a tier named "frontier"/);

    expect(await settings()).toEqual(before);
    expect(await task(question_id)).toMatchObject({ status: "todo" });
  } finally {
    await client.close();
  }
});

it("移す行の段・隣の段を改名しても question は open のまま、いまの名前で見え、修正値なしの approve で段が足され行が移る(issue #1436)", async () => {
  const { client, call } = await boardWithAddTierProposal();
  try {
    const { question_id } = await call({ tier: CAREFUL, row: OPUS_KEY, evidence: [spawned()] });
    expect((await change({ setting: "rename_tier", name: "standard", to: "mid" })).status).toBe(200);

    const mid = { ...standard!, name: "mid" };
    expect(await task(question_id)).toMatchObject({ status: "todo", question_proposal: { pin: { row: { ...OPUS, tier: "mid" }, below: mid, above: frontier } } });
    expect((await answer(question_id, { answers: ["approve"] })).status).toBe(200);
    expect(await settings()).toEqual({ tiers: [economy, mid, { name: CAREFUL.name, description: CAREFUL.description }, frontier], opus: { ...OPUS, tier: "careful" } });
  } finally {
    await client.close();
  }
});

const staleChanged = async (id: string) => (await events(id)).find((e) => e.kind === "routing_proposal_stale")?.payload.changed;

it("移す行か隣の段が変わると、提案は回答なしで observed になる —— 隣でない段の編集では open のまま", async () => {
  const { client, call } = await boardWithAddTierProposal();
  try {
    const propose = async () => (await call({ tier: CAREFUL, row: OPUS_KEY, evidence: [spawned()] })).question_id as string;
    const rowEdited = await propose();
    expect((await change({ setting: "row", key: OPUS_KEY, row: { ...OPUS, price_out: 30 } })).status).toBe(200);
    expect(await task(rowEdited)).toMatchObject({ status: "done", question_answer: null });
    expect(await staleChanged(rowEdited)).toEqual(["price_out"]);

    const kept = await propose();
    expect((await change({ setting: "edit_tier", name: "economy", description: "Edited, not a neighbour." })).status).toBe(200);
    expect(await task(kept)).toMatchObject({ status: "todo" });

    expect((await change({ setting: "edit_tier", name: "frontier", description: "Edited neighbour." })).status).toBe(200);
    expect(await task(kept)).toMatchObject({ status: "done", question_answer: null });
    expect(await staleChanged(kept)).toEqual(["neighbours"]);
  } finally {
    await client.close();
  }
});
