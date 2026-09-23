import { afterEach, expect, it } from "vitest";
import { appendEvent } from "../src/events.js";
import { createBehaviorCandidate, proposeMemoryChange, WORKER_MEMORY_VERBS } from "../src/memory.js";
import { BOARD_WORKER_ID, registerTask } from "../src/tasks.js";
import { api, bootTidepool, completeViaMcp, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

/** 主題 routing の周期 meta-review(issue #917 / ADR 0150 決定7・ADR 0120 決定2)のサーバ境界: 周期登録、
 *  接続ごとの verb の可視性、読み口の写像。読み物の集計はドメイン層(tests/routing-meta-review-reads.test.ts)が言う。 */
let t: Tidepool;
afterEach(() => t?.stop());

const DAY = 24 * HOUR;
const ROUTING_READS = ["list_routing_shadow", "list_allocations", "list_routing_cells", "read_routing_settings"];

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
    assignee: null,
    registrant: BOARD_WORKER_ID,
  });
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
  expect(events.filter((e) => e.kind === "meta_review_registered")).toMatchObject([
    { worker_id: BOARD_WORKER_ID, payload: { subject: "routing", material_watermark: expect.any(Number) } },
  ]);
});

it("worker_spawned だけでは routing の材料にならない", async () => {
  t = await bootTidepool();
  const { id } = registerTask(t.db, { type: "work", title: "source", purpose: "p", completion_criteria: "c" }, t.clock.now());
  t.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id);
  appendEvent(t.db, {
    taskId: id,
    workerId: "deckhand",
    origin: "board",
    at: t.clock.now(),
    payload: {
      kind: "worker_spawned",
      registry_commit: "c",
      definition_version: "1",
      advisor: null,
      provider: "anthropic",
      model: "sonnet",
      effort: "high",
      source: { tier: "board", provider: "only" },
      harness: "claude-code",
      cli_version: "1",
    },
  });

  await t.clock.advance(HOUR);

  expect(await openRoutingReviews(t)).toEqual([]);
});

it("同主題の open な task があれば登録せず、完了後は前回 watermark 以降の材料で次の周期に登録される", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/memory", { meta_review_period_days: 1 })).status).toBe(200);
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
  expect((await api(t.baseUrl, "POST", "/api/settings/memory", { meta_review_period_days: 1 })).status).toBe(200);
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

  expect((await api(t.baseUrl, "POST", `/api/tasks/${question_id}/answer`, { answers: ["reject"] })).status).toBe(200);
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

it("主題 routing の task の接続は、普通の task の一覧から worker の memory verb を除き読み口4本と list_precedents を足したもの", async () => {
  const { client } = await boardWithRoutingReview();
  const work = await registerWork(t, "index the tide charts");
  const workClient = await mcpClient(t.mcpBaseUrl, work.id);
  try {
    const names = async (c: typeof client) => (await c.listTools()).tools.map((tool) => tool.name);
    const routing = await names(client);
    const worker = await names(workClient);
    const memory: string[] = [...WORKER_MEMORY_VERBS];
    expect(worker.filter((name) => [...ROUTING_READS, "list_precedents"].includes(name))).toEqual([]);
    expect(routing.sort()).toEqual([...worker.filter((name) => !memory.includes(name)), ...ROUTING_READS, "list_precedents"].sort());
  } finally {
    await client.close();
    await workClient.close();
  }
});

it("主題外の task から読み口を呼ぶと tool error", async () => {
  t = await bootTidepool();
  const work = await registerWork(t, "index the tide charts");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, work.id);
  try {
    for (const name of ROUTING_READS) expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
  } finally {
    await client.close();
  }
});

it("読み口4本と list_precedents は routing の task から引数ごと写る", async () => {
  const { client, call } = await boardWithRoutingReview();
  try {
    for (const verb of ["list_routing_shadow", "list_allocations", "list_routing_cells"]) {
      expect(await call(verb, { since_watermark: 0, page: 1 })).toMatchObject({ isError: false, body: { truncated: false } });
    }
    expect(await call("list_routing_shadow", { diverged_only: true })).toMatchObject({ isError: false, body: { shadow: [] } });
    expect(await call("read_routing_settings")).toMatchObject({ isError: false, body: { priority: "cost", table: expect.any(Array), providerRank: expect.any(Array), frontierAdvisor: expect.any(Boolean) } });
    expect(await call("list_precedents")).toMatchObject({ isError: false, body: { precedents: [], truncated: false } });
  } finally {
    await client.close();
  }
});
