import { afterEach, expect, it } from "vitest";
import { createBehaviorCandidate, recordKnowledge } from "../src/memory.js";
import { BOARD_WORKER_ID, registerTask } from "../src/tasks.js";
import { api, bootTidepool, completeViaMcp, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const DAY = 24 * HOUR;

/** 材料を1つ(setup —— 店に Knowledge を1件書く)。 */
function material(tp: Tidepool, title: string) {
  const { id } = registerTask(tp.db, { type: "work", title: "source", purpose: "p", completion_criteria: "c" }, tp.clock.now());
  // 出所の event のためだけの task なので queue から外す
  tp.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = ?").run(id);
  recordKnowledge(
    tp.db,
    { scope: null, path: "build", title, text: `${title}.`, source: { event_id: 1 }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    tp.clock.now(),
  );
}

/** 盤面に open な memory meta-review(登録されれば同じ pass で拾われて open のまま見える)。 */
async function openMetaReviews(tp: Tidepool): Promise<any[]> {
  return ((await api(tp.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.meta_review_subject === "memory");
}

it("前回登録が無く材料があれば、poll が盤面名義で memory meta-review を登録し、同じ pass で pickup する(issue #618)", async () => {
  t = await bootTidepool();
  material(t, "Use Node 22");

  await t.clock.advance(HOUR);

  const [{ id }] = await openMetaReviews(t);
  // assignee は未指定のまま刻まれ、読み口で Auditor に解決される
  expect((await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json).toMatchObject({
    type: "review",
    meta_review_subject: "memory",
    review_tier: "frontier",
    workspace: null,
    assignee: null,
    status: "in_progress",
    registrant: BOARD_WORKER_ID,
  });
  expect(t.worker.started.map((task) => task.id)).toEqual([id]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];
  expect(events.filter((e) => e.kind === "meta_review_registered")).toMatchObject([
    { worker_id: BOARD_WORKER_ID, payload: { subject: "memory", material_watermark: expect.any(Number) } },
  ]);
});

it("材料が無ければ登録しない(issue #618)", async () => {
  t = await bootTidepool();

  await t.clock.advance(HOUR);

  expect(await openMetaReviews(t)).toEqual([]);
  expect(t.worker.started).toEqual([]);
});

it("同主題の open な task があれば登録せず、周期は間隔の下限で、期限超過後は材料が出た poll で登録される(issue #618)", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 1 })).status).toBe(200);
  material(t, "first");
  await t.clock.advance(HOUR);
  const [first] = await openMetaReviews(t);

  material(t, "second");
  await t.clock.advance(2 * DAY); // 周期は過ぎ材料もあるが、同主題が open(slot で走っている)
  expect((await openMetaReviews(t)).map((task) => task.id)).toEqual([first.id]);

  await finish(t, first.id);
  await t.clock.advance(HOUR); // 前回登録より後の材料 "second" があり、周期も過ぎている
  const [second] = await openMetaReviews(t);
  expect(second).toMatchObject({ status: "in_progress" });

  await finish(t, second.id);
  material(t, "third");
  await t.clock.advance(20 * HOUR); // 材料はあるが、前回登録から周期(1日)が経っていない
  expect(await openMetaReviews(t)).toEqual([]);
  await t.clock.advance(5 * HOUR); // 周期を過ぎた最初の poll で登録
  const [third] = await openMetaReviews(t);
  expect(third).toMatchObject({ status: "in_progress" });

  await finish(t, third.id);
  await t.clock.advance(2 * DAY); // 周期は過ぎたが、前回登録以降の材料が無い
  expect(await openMetaReviews(t)).toEqual([]);
  expect(t.worker.started).toHaveLength(3);
});

async function finish(tp: Tidepool, taskId: string) {
  expect((await completeViaMcp(tp, taskId, false)).isError).not.toBe(true);
}

it("同主題の open な提案 question があれば、meta-review が完了していても登録しない —— 回答で決着すれば次の poll で登録される(issue #620)", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/meta-review", { period_days: 1 })).status).toBe(200);
  const candidate = createBehaviorCandidate(
    t.db,
    { scope: null, path: "habits", title: "Split migrations", text: "Split migrations.", addressee: null, source: { commit: "0a46a46" }, author: { activity: "rca", name: "auditor" } },
    "worker",
    t.clock.now(),
  ).entry_id;
  await t.clock.advance(HOUR);
  const [first] = await openMetaReviews(t);
  const client = await mcpClient(t.mcpBaseUrl, first.id);
  const proposed: any = await client.callTool({ name: "propose_memory_change", arguments: { op: "approve", candidate_id: candidate, rationale: "r" } });
  await client.close();
  const { question_id } = JSON.parse(proposed.content[0].text);
  await finish(t, first.id);

  material(t, "second");
  await t.clock.advance(2 * DAY); // 周期は過ぎ材料もあるが、提案 question が open
  expect((await openMetaReviews(t)).map((task) => task.id)).toEqual([first.id]); // 完了済みの first は question の木ごと盤面に残る

  expect((await api(t.baseUrl, "POST", `/api/tasks/${question_id}/answer`, { answers: ["reject"] })).status).toBe(200);
  await t.clock.advance(HOUR);
  expect(await openMetaReviews(t)).toMatchObject([{ status: "in_progress" }]);
});
