import { afterEach, expect, it } from "vitest";
import { healthyUsageText, usagePanelText } from "./fakes.js";
import {
  api,
  bootTidepool,
  completeIntegrationReviews,
  FULL_HANDOFF as fullHandoff,
  HOUR,
  mcpClient,
  queueWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const MIN = 60 * 1000;

/** session 85% / week 5% の観測 (ADR 0030): 90分後リセットなら経過70%、
 *  オフセット20で線は50 — 85は超過、しかも 85+20=105% ≥ 100 なので catch-up は
 *  ウィンドウ内に来ず、再開見込みはリセット時刻にクランプされる。week は
 *  同時刻+1日リセットで健全なまま。 */
function overPace(resetsAt: Date): string {
  return usagePanelText({
    session: { percent: 85, resetsAt },
    week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
  });
}

it("ペース線超過は catch-up 時刻(経過 = 使用率 + オフセット)で再開し、リセット時刻まで待たない(ADR 0030 の急所)", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "long haul");

  // 40% used, resets 4時間後 → ウィンドウ開始は1時間前。hourly tick(t=1h)の時点で
  // 経過40%、オフセット20で線は20 — 40は超過。catch-up は経過60%の瞬間 = t=2h。
  // リセット(t=4h)より2時間早い。
  const resetsAt = new Date(t.clock.now().getTime() + 4 * HOUR);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 40, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );

  await t.clock.advance(HOUR); // hourly tick: 超過を観測し catch-up タイマーを張る
  await t.clock.advance(30 * MIN); // t=1.5h: catch-up(2h)より手前 — まだ skip
  expect(t.worker.started).toEqual([]);

  // 使用率は変わらなくても、時間の経過がペース線に追いつけば再開する —
  // /usage の再スクリプトなしで、同じ観測が catch-up 後は線上(strict で通過)になる
  await t.clock.advance(40 * MIN); // t=2h10m: catch-up(2h)を跨ぐ(リセット4hはまだ先)
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("使用率+オフセットが100%を超えると catch-up はリセット時刻にクランプされ、到達で(hourly tick を待たず)再開する", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "long haul");

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overPace(resetsAt));

  await t.clock.advance(HOUR); // still short of resets_at: skipped
  expect(t.worker.started).toEqual([]);

  // by the time the one-shot reset timer fires, /usage now reports a fresh
  // (post-reset) reading — this is what the real world looks like at resets_at
  t.worker.scriptUsage(healthyUsageText(t.clock.now()));
  await t.clock.advance(40 * MIN); // crosses the 90-min resets_at mark
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("パース不能(観測不能)は fail-closed で暗黙の entry を外し(行は skipped、盤面全体の停止には現れない)、次の hourly tick で再試行する(ADR 0140 決定3)", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "long haul");

  t.worker.scriptUsage(null); // simulates a checkUsage failure
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);
  expect(await queueView(task)).toEqual({ status: "skipped", queueHalts: [], pauseHalts: [] });

  t.worker.scriptUsage(healthyUsageText(t.clock.now()));
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("ペース線超過の間も実行中タスクには決して触れない(常に完走する)", async () => {
  t = await bootTidepool();
  const first = queueWork(t, "long haul");
  await t.clock.advance(HOUR); // first picked up while usage is still fine

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overPace(resetsAt));

  // the in-progress task completes normally — the pace line never touches it
  const client = await mcpClient(t.mcpBaseUrl, first.id);
  const done: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  expect(done.isError ?? false).toBe(false);
  await client.close();
  expect(t.worker.gracefulStops).toEqual([]);

  const second = queueWork(t, "long haul");
  await t.clock.advance(HOUR); // slot free, but usage is still over the pace line
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);

  t.worker.scriptUsage(healthyUsageText(t.clock.now()));
  await t.clock.advance(HOUR);
  await completeIntegrationReviews(t, first.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.filter((x) => x.type === "work").map((x) => x.id)).toEqual([first.id, second.id]);
});

/** 盤面全体の停止の列挙(`GET /api/queue` と `GET /pause` の halts)に throttle が
 *  居ないこと、と行の状態。 */
async function queueView(task: { id: string }) {
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  const pause = (await api(t.baseUrl, "GET", "/api/pause")).json;
  return {
    status: queue.tasks.find((x: any) => x.id === task.id).status,
    queueHalts: queue.halts.map((halt: any) => halt.kind),
    pauseHalts: pause.halts.map((halt: any) => halt.kind),
  };
}

it("registry なしの盤面でも Anthropic の Provider 全体の窓の throttle は暗黙の entry だけを外す —— pickup は起きず、行は skipped、盤面全体の停止には現れない(ADR 0140 決定1・3)", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "long haul");

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overPace(resetsAt));
  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
  expect(await queueView(task)).toEqual({ status: "skipped", queueHalts: [], pauseHalts: [] });
});

it("registry なしの盤面で窓が回復すると、元のキュー順の先頭が pickup される(ADR 0140 決定3)", async () => {
  t = await bootTidepool();
  const first = queueWork(t, "first in line");
  queueWork(t, "second in line");

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overPace(resetsAt));
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  // リセットの瞬間の再開タイマーが、hourly tick を待たずに撃ち直す
  t.worker.scriptUsage(healthyUsageText(t.clock.now()));
  await t.clock.advance(40 * MIN);
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);
});

it("盤面設定のオフセットが判定に効く: session オフセットを 0(予約なし)にすると、既定 20pt では絞られていた使用率が通る", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "long haul");

  // 40% used, resets 4時間後 → t=1h 時点で経過40%。既定オフセット20なら線は20で
  // 40 は超過(冒頭の catch-up テストと同じ数字)。オフセット0なら線は40 —
  // strict 比較で 40 は通る。
  await api(t.baseUrl, "POST", "/api/settings/pace-offsets", { session: 0, week: 10, fable: 10 });
  const resetsAt = new Date(t.clock.now().getTime() + 4 * HOUR);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 40, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});
