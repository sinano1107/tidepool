import { afterEach, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { loadExecutionSettingTable } from "../src/execution-setting.js";
import { recordShadow } from "../src/learner.js";
import { createBehaviorCandidate, proposeMemoryChange, WORKER_MEMORY_VERBS } from "../src/memory.js";
import { proposeRoutingChange } from "../src/routing-review.js";
import { BOARD_WORKER_ID, registerTask } from "../src/tasks.js";
import {
  api,
  bootTidepool,
  completeViaMcp,
  HOUR,
  HUMAN_WEBUI,
  mcpClient,
  QUIET_EXIT,
  readFollowingNext,
  registerWork,
  type Tidepool,
  WORKER_SPAWNED,
} from "./harness.js";

/** 主題 routing の周期 meta-review(issue #917 / ADR 0150 決定7・ADR 0120 決定2)のサーバ境界: 周期登録、
 *  接続ごとの verb の可視性、読み口の写像。読み物の集計はドメイン層(tests/routing-meta-review-reads.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

const DAY = 24 * HOUR;
const ROUTING_READS = ["list_routing_shadow", "list_allocations", "list_routing_cells", "read_routing_settings"];
const TRACK = { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 } };

/** routing の材料を1つ(setup —— 人間が優先順位の既定を変える)。 */
async function material(tp: Tidepool, value: "cost" | "quality" = "cost") {
  expect((await api(tp.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value })).status).toBe(200);
}

async function openRoutingReviews(tp: Tidepool): Promise<any[]> {
  return ((await api(tp.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.meta_review_subject === "routing");
}

it("前回登録が無く routing の材料があれば、poll が盤面名義で routing meta-review を frontier・assignee null・workspace null で登録する", async () => {
  t = await bootTidepool();
  await material(t);

  await t.clock.advance(HOUR);

  const [{ id }] = await openRoutingReviews(t);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json).toMatchObject({
    type: "review",
    meta_review_subject: "routing",
    review_tier: "frontier",
    workspace: null,
    raw_assignee: null,
    registrant: BOARD_WORKER_ID,
  });
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
  expect(events.filter((e) => e.kind === "meta_review_registered")).toMatchObject([
    { worker_id: BOARD_WORKER_ID, payload: { subject: "routing", material_watermark: expect.any(Number) } },
  ]);
});

it("worker_spawned だけでは routing の材料にならない", async () => {
  t = await bootTidepool();
  const { id } = registerTask(t.db, { type: "work", title: "source", purpose: "p", completion_criteria: "c" }, t.clock.now(), ...HUMAN_WEBUI);
  t.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id);
  appendEvent(t.db, {
    taskId: id,
    workerId: "deckhand",
    origin: "board",
    at: t.clock.now(),
    payload: WORKER_SPAWNED,
  });

  await t.clock.advance(HOUR);

  expect(await openRoutingReviews(t)).toEqual([]);
});

it("同主題の open な task があれば登録せず、完了後は前回 watermark 以降の材料で次の周期に登録される", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 1 })).status).toBe(200);
  await material(t);
  await t.clock.advance(HOUR);
  const [first] = await openRoutingReviews(t);

  await material(t, "quality");
  await t.clock.advance(2 * DAY); // 周期は過ぎ材料もあるが、同主題が open
  expect((await openRoutingReviews(t)).map((task) => task.id)).toEqual([first.id]);

  expect((await completeViaMcp(t, first.id, false)).isError).not.toBe(true);
  await t.clock.advance(HOUR);
  expect(await openRoutingReviews(t)).toMatchObject([{ status: "in_progress" }]);
});

it("親 task の meta_review_subject が routing の open な提案 question があれば登録しない —— 提案の kind では数えない", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 1 })).status).toBe(200);
  await material(t);
  await t.clock.advance(HOUR);
  const [first] = await openRoutingReviews(t);
  // routing の提案 verb はまだ無いので、kind が memory の提案 question を routing meta-review の子として立てる
  const candidate = createBehaviorCandidate(
    t.db,
    { scope: null, path: "habits", title: "Split migrations", text: "Split migrations.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    t.clock.now(),
  ).entry_id;
  const { question_id } = proposeMemoryChange(t.db, first.id, { op: "approve", candidate_id: candidate, rationale: "r" }, "auditor", t.clock.now());
  expect((await completeViaMcp(t, first.id, false)).isError).not.toBe(true);

  await material(t, "quality");
  await t.clock.advance(2 * DAY); // 周期は過ぎ材料もあるが、親が routing の提案 question が open
  expect((await openRoutingReviews(t)).map((task) => task.id)).toEqual([first.id]);

  expect((await api(t.baseUrl, "POST", `/api/tasks/${question_id}/answer`, { answers: ["reject"], comment: "Not now." })).status).toBe(200);
  await t.clock.advance(HOUR);
  // candidate は memory の材料でもあり、memory meta-review が slot を取るので pickup ではなく登録を見る
  expect((await openRoutingReviews(t)).filter((task) => task.id !== first.id)).toHaveLength(1);
});

/** slot に入った routing meta-review とその接続。 */
async function boardWithRoutingReview() {
  t = await bootTidepool();
  await material(t);
  await t.clock.advance(HOUR);
  const [review] = await openRoutingReviews(t);
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result: any = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, body: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
  };
  return { review, client, call };
}

it("主題 routing の task の接続は、普通の task の一覧から worker の memory verb を除き読み口4本と list_precedents と提案 verb を足したもの", async () => {
  const { client } = await boardWithRoutingReview();
  const work = await registerWork(t, "index the tide charts");
  const workClient = await mcpClient(t.mcpBaseUrl, work.id);
  try {
    const names = async (c: typeof client) => (await c.listTools()).tools.map((tool) => tool.name);
    const routing = await names(client);
    const worker = await names(workClient);
    const memory: string[] = [...WORKER_MEMORY_VERBS];
    expect(worker.filter((name) => [...ROUTING_READS, "list_precedents", "propose_routing_change"].includes(name))).toEqual([]);
    expect(routing.sort()).toEqual([...worker.filter((name) => !memory.includes(name)), ...ROUTING_READS, "list_precedents", "propose_routing_change"].sort());
  } finally {
    await client.close();
    await workClient.close();
  }
});

it("主題外の task から読み口・提案 verb を呼ぶと tool error", async () => {
  t = await bootTidepool();
  const work = await registerWork(t, "index the tide charts");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  try {
    for (const name of ROUTING_READS) expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
    const proposal = { op: "row", row: { provider: "anthropic", model: "opus", effort: "high" }, change: { tier: "frontier" }, rationale: "r" };
    expect((await client.callTool({ name: "propose_routing_change", arguments: proposal })).isError).toBe(true);
  } finally {
    await client.close();
  }
});

it("読み口4本は続き(next)だけを受けて続きの応答を返し、next を追うと最初の読みの行がすべて届く(写像。詰め方・順序・最初の応答だけの欄はドメイン層、ADR 0195)", async () => {
  const { review, client } = await boardWithRoutingReview();
  // 長い comment の提案と、長い agent 名と model 名の 20 の session(それぞれ別の配分評価の組・別のセル・大きな shadow 行)
  const [row] = loadExecutionSettingTable(t.db);
  const now = t.clock.now();
  for (let i = 0; i < 20; i++) {
    const { question_id } = proposeRoutingChange(t.db, review.id, { op: "row", row: row!, change: { effort: "low" }, rationale: "r" }, "auditor", now);
    expect((await api(t.baseUrl, "POST", `/api/tasks/${question_id}/answer`, { answers: ["reject"], comment: `${i} ${"潮".repeat(1_000)}` })).status).toBe(200);
    const { id } = registerTask(t.db, { type: "work", title: `w${i}`, purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI);
    const run = { provider: "anthropic" as const, model: `model-${i}-${"m".repeat(2_500)}`, effort: "high", advisor: undefined, source: { tier: "agent" as const, provider: "rank" as const } };
    recordShadow(t.db, id, { recommended: run, actual: run, basis: "prior", recommended_record: TRACK, actual_record: TRACK, candidates: 2 }, now);
    const spawned = appendEvent(t.db, { taskId: id, workerId: `agent-${i}-${"a".repeat(2_500)}`, origin: "board", at: now, payload: { ...WORKER_SPAWNED, model: run.model, source: run.source } });
    const tokens = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: 0 };
    appendEvent(t.db, { taskId: id, workerId: "board", origin: "board", at: now, payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, usage: { ...tokens, advisor: null, models: {} } } });
    appendEvent(t.db, {
      taskId: id,
      workerId: "tidepool",
      origin: "board",
      at: now,
      payload: { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: spawned, judge: { provider: "anthropic", model: "fable", effort: "high" }, allocation: "appropriate", cause: "uncertain", evidence: "e" },
    });
  }
  try {
    const reads = [
      ["list_routing_shadow", { since_watermark: 0 }, "shadow"],
      ["list_allocations", { since_watermark: 0 }, "allocations"],
      ["list_routing_cells", { since_watermark: 0 }, "cells"],
      ["read_routing_settings", {}, "proposals"],
    ] as const;
    for (const [verb, args, key] of reads) {
      const responses = await readFollowingNext(client, verb, args);

      expect(responses.length, verb).toBeGreaterThan(1);
      expect(responses.flatMap((response) => response.payload[key]), verb).toHaveLength(20);
    }
  } finally {
    await client.close();
  }
});

it("読み口4本と list_precedents は routing の task から引数ごと写る", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    for (const verb of ["list_routing_shadow", "list_allocations", "list_routing_cells"]) {
      const read = await call(verb, { since_watermark: 0 });
      expect(read.isError).toBe(false);
      expect(read.body).not.toHaveProperty("next");
    }
    expect(await call("list_routing_shadow", { diverged_only: true })).toMatchObject({ isError: false, body: { shadow: [] } });
    expect(await call("read_routing_settings")).toMatchObject({ isError: false, body: { priority: "cost", table: expect.any(Array), providerRank: expect.any(Array), advisorAboveMain: expect.any(Boolean) } });
    const precedents = await call("list_precedents");
    expect(precedents).toMatchObject({ isError: false, body: { precedents: [] } });
    expect(precedents.body).not.toHaveProperty("next");
  } finally {
    await client.close();
  }
});

it("routing meta-review の purpose は材料の節とその5つの部分を名指し、提案の前に過去の提案を read_routing_settings で読むと言い、一致した shadow 行と前回より前は読み口で読めると言い、読む順の文は無く、昇格の根拠を乖離した行の outcome でなく推薦したセルの実績に置く —— completion_criteria は節の各部分を判断したこと(ADR 0180 追記 #1239)", async () => {
  t = await bootTidepool();
  await material(t);
  await t.clock.advance(HOUR);

  const [review] = await openRoutingReviews(t);

  expect(review.purpose).toContain(
    "This cycle's material is in your prompt, in the Routing meta-review material section: the current table and settings, the shadow rows " +
      "since the previous routing meta-review where the learner's recommendation diverged from what ran, the allocation reviews since then, " +
      "the cells first seen and the rows humans changed since then, and the routing proposals answered or settled since then.",
  );
  expect(review.purpose).toContain(
    "before you propose a change to a row, the learner flag, an agent's tier or a tier's description, read the earlier proposals on it, with their answers, amendments and comments, with read_routing_settings",
  );
  expect(review.purpose).toContain("read the matched rows, and anything before the previous meta-review, with list_routing_shadow, list_allocations and list_routing_cells");
  expect(review.purpose).not.toContain("First read");
  // 昇格の根拠は推薦したセルの実績(ADR 0181 決定1・5・6)
  expect(review.purpose).not.toContain("outcomes of the diverged episodes");
  for (const meaning of [
    "The learner leaves the table's first choice only when both that choice and the cell it moves to have observations",
    "each diverged row carries the track records of the recommended and the actual cell as of that pickup",
    "While the learner is not promoted, a diverged row's outcome is the result of the setting the table chose, not of the one the learner recommended",
    "Base any case for promoting the learner on whether the recommended cells' track records, counts included, justify leaving the table",
    "a pickup with one candidate always matches the table, so do not count it as evidence of agreement",
  ]) {
    expect(review.purpose).toContain(meaning);
  }
  expect(review.completion_criteria).toBe(
    "every part of this cycle's material is judged, each judgment is logged as a decision, and each row change the evidence supports is proposed",
  );
});
