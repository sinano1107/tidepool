import { afterEach, expect, it } from "vitest";
import { recordKnowledge } from "../src/memory.js";
import { BOARD_WORKER_ID, registerTask } from "../src/tasks.js";
import { api, bootTidepool, completeViaMcp, HOUR, type Tidepool } from "./harness.js";

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

/** 決着した task は GET /api/tasks の木から畳まれるので、登録の履歴は表から読む。 */
function metaReviews(tp: Tidepool) {
  return tp.db.prepare("SELECT id, status FROM tasks WHERE meta_review_subject IS NOT NULL ORDER BY sort_key").all() as Array<{
    id: string;
    status: string;
  }>;
}

function registeredEvents(tp: Tidepool) {
  return tp.db.prepare("SELECT task_id, worker_id, payload FROM events WHERE kind = 'meta_review_registered' ORDER BY id").all() as Array<{
    task_id: string;
    worker_id: string;
    payload: string;
  }>;
}

it("前回登録が無く材料があれば、poll が盤面名義で memory meta-review を登録し、同じ pass で pickup する(issue #618)", async () => {
  t = await bootTidepool();
  material(t, "Use Node 22");

  await t.clock.advance(HOUR);

  const { id } = metaReviews(t)[0]!;
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.id === id);
  expect(review).toMatchObject({ type: "review", meta_review_subject: "memory", workspace: null, status: "in_progress" });
  // assignee は未指定のまま刻まれ、読み口で Auditor に解決される
  expect(t.db.prepare("SELECT assignee FROM tasks WHERE id = ?").get(review.id)).toEqual({ assignee: null });
  expect(t.worker.started.map((task) => task.id)).toEqual([review.id]);
  const registrant = t.db.prepare("SELECT worker_id FROM events WHERE task_id = ? AND kind = 'task_registered'").get(review.id);
  expect(registrant).toEqual({ worker_id: BOARD_WORKER_ID });
  const [event] = registeredEvents(t);
  expect(event!).toMatchObject({ task_id: review.id, worker_id: BOARD_WORKER_ID });
  expect(JSON.parse(event!.payload)).toEqual({ kind: "meta_review_registered", subject: "memory", material_watermark: expect.any(Number) });
});

it("材料が無ければ登録せず、meta_review_registered も残さない(issue #618)", async () => {
  t = await bootTidepool();

  await t.clock.advance(HOUR);

  expect(metaReviews(t)).toEqual([]);
  expect(registeredEvents(t)).toEqual([]);
});

it("同主題の open な task があれば登録せず、周期は間隔の下限で、期限超過後は材料が出た poll で登録される(issue #618)", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/memory", { meta_review_period_days: 1 })).status).toBe(200);
  material(t, "first");
  await t.clock.advance(HOUR);
  const first = metaReviews(t)[0]!;

  material(t, "second");
  await t.clock.advance(2 * DAY); // 周期は過ぎ材料もあるが、同主題が open(slot で走っている)
  expect(metaReviews(t)).toHaveLength(1);

  await finish(t, first.id);
  await t.clock.advance(HOUR); // 前回登録より後の材料 "second" があり、周期も過ぎている
  const second = metaReviews(t)[1]!;
  expect(second.status).toBe("in_progress");

  await finish(t, second.id);
  material(t, "third");
  await t.clock.advance(20 * HOUR); // 材料はあるが、前回登録から周期(1日)が経っていない
  expect(metaReviews(t)).toHaveLength(2);
  await t.clock.advance(5 * HOUR); // 周期を過ぎた最初の poll で登録
  const third = metaReviews(t)[2]!;
  expect(third.status).toBe("in_progress");

  await finish(t, third.id);
  await t.clock.advance(2 * DAY); // 周期は過ぎたが、前回登録以降の材料が無い
  expect(metaReviews(t)).toHaveLength(3);
  expect(registeredEvents(t)).toHaveLength(3);
});

async function finish(tp: Tidepool, taskId: string) {
  expect((await completeViaMcp(tp, taskId, false)).isError).not.toBe(true);
}
