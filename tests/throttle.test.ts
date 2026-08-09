import { afterEach, expect, it, vi } from "vitest";
import { healthyUsageText, usagePanelText } from "./fakes.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF as fullHandoff,
  HOUR,
  mcpClient,
  registerWork,
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
  const task = await registerWork(t, "long haul");

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
  const task = await registerWork(t, "long haul");

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

it("パース不能(観測不能)は fail-closed で pickup を skip し、次の hourly tick で再試行する", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "long haul");

  t.worker.scriptUsage(null); // simulates a checkUsage failure
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  t.worker.scriptUsage(healthyUsageText(t.clock.now()));
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("ペース線超過の間も実行中タスクには決して触れない(常に完走する)", async () => {
  t = await bootTidepool();
  const first = await registerWork(t, "long haul");
  await t.clock.advance(HOUR); // first picked up while usage is still fine

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overPace(resetsAt));

  // the in-progress task completes normally — the pace line never touches it
  const client = await mcpClient(t.mcpBaseUrl, first.id);
  const done: any = await client.callTool({ name: "complete_task", arguments: { handoff: fullHandoff } });
  expect(done.isError ?? false).toBe(false);
  await client.close();
  expect(t.worker.killed).toEqual([]);

  const second = await registerWork(t, "long haul");
  await t.clock.advance(HOUR); // slot free, but usage is still over the pace line
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id]);

  t.worker.scriptUsage(healthyUsageText(t.clock.now()));
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.id)).toEqual([first.id, second.id]);
});

it("throttled の間、todo タスクはキュービュー(/api/queue)では skipped、ボード(/api/tasks)では todo のまま", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "long haul");

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overPace(resetsAt));
  await t.clock.advance(HOUR); // drives one poll so the observation is persisted

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === task.id).status).toBe("todo");

  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.find((x: any) => x.id === task.id).status).toBe("skipped");

  // once resets_at passes and /usage reports a fresh reading, the queue view
  // goes back to plain todo
  t.worker.scriptUsage(healthyUsageText(t.clock.now()));
  await t.clock.advance(2 * HOUR);
  const queueAfter = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queueAfter.find((x: any) => x.id === task.id)?.status ?? "in_progress").not.toBe(
    "skipped",
  );
});

/** session/week は健全なまま、fable 線だけ超過している観測 (ADR 0030)。
 *  fable resets は12時間後 → 経過 92.9%、オフセット10で線は82.9 — 84% は超過。
 *  catch-up は経過94%の瞬間 = now + 1時間55分12秒後(hourly tick とずれた時刻)。
 *  session(+3h)の壁時計 reset が有効なうちに catch-up が来る数字にしてある —
 *  固定 panel 文字列は clock が session reset を跨ぐと逆算不整合で盤面ごと
 *  fail-closed に化けるため。 */
function fableOverPace(now: Date): string {
  return usagePanelText({
    session: { percent: 0, resetsAt: new Date(now.getTime() + 3 * HOUR) },
    week: { percent: 5, resetsAt: new Date(now.getTime() + 2 * 24 * HOUR) },
    fable: { percent: 84, resetsAt: new Date(now.getTime() + 12 * HOUR) },
  });
}

it("fable 線の超過は fable モデルのタスクだけを skip し、他のタスクは流れ続ける — 盤面全体は止まらない(ADR 0030)", async () => {
  t = await bootTidepool({ fableAgents: () => ["fable-artisan"] });
  const fableTask = await registerWork(t, "fable work", undefined, undefined, "fable-artisan");
  const normalTask = await registerWork(t, "normal work");

  t.worker.scriptUsage(fableOverPace(t.clock.now()));
  await t.clock.advance(HOUR);

  // キュー先頭は fable タスクだが、skip されて後続の通常タスクが拾われる
  expect(t.worker.started.map((x) => x.id)).toEqual([normalTask.id]);

  // キュービューでは fable タスクだけが skipped、盤面(/api/tasks)は todo のまま
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect(queue.find((x: any) => x.id === fableTask.id).status).toBe("skipped");
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === fableTask.id).status).toBe("todo");
});

it("fable タスクしか無いキューは fable の catch-up 時刻で(hourly tick を待たず)再開する", async () => {
  t = await bootTidepool({ fableAgents: () => ["fable-artisan"] });
  const fableTask = await registerWork(t, "fable work", undefined, undefined, "fable-artisan");

  t.worker.scriptUsage(fableOverPace(t.clock.now()));

  // hourly tick(t=1h)が fable skip で候補ゼロを観測し、catch-up タイマーを張る
  await t.clock.advance(HOUR + 50 * MIN); // t=1h50m: catch-up(1h55m)より手前
  expect(t.worker.started).toEqual([]);

  // 使用率は変わらないまま catch-up を跨ぐ — 次の hourly tick(2h)より手前で再開
  await t.clock.advance(7 * MIN); // t=1h57m
  expect(t.worker.started.map((x) => x.id)).toEqual([fableTask.id]);
});

it("盤面設定のオフセットが判定に効く: session オフセットを 0(予約なし)にすると、既定 20pt では絞られていた使用率が通る", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "long haul");

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

it("throttled 中は GET /api/pause が throttle 状態(再開見込み時刻とウィンドウ別内訳)を運ぶ(issue #82 / ADR 0030)", async () => {
  t = await bootTidepool();
  await registerWork(t, "long haul");

  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(overPace(resetsAt));
  await t.clock.advance(HOUR); // drives one poll so the observation is persisted

  const res = await api(t.baseUrl, "GET", "/api/pause");
  expect(res.json.throttle.throttled).toBe(true);
  expect(res.json.throttle.observedAt).toBe(t.clock.now().toISOString());
  // 85+20 ≥ 100% なので再開見込みはリセット時刻そのもの
  expect(res.json.throttle.resumesAt).toBe(resetsAt.toISOString());
  // どの線に当たっているかの内訳 (ADR 0030): session の線、week は健全
  expect(res.json.throttle.windows.session).toEqual({
    throttled: true,
    resumeAt: resetsAt.toISOString(),
  });
  expect(res.json.throttle.windows.week).toEqual({ throttled: false, resumeAt: null });
});

it("usage 再評価を待たず GET /api/pause は revalidating=true を返し、観測完了後に false へ戻る(ADR 0058)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "waits for the usage observation");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.worker.scriptUsageGate(gate);

  await api(t.baseUrl, "POST", `/api/tasks/${task.id}/move`, { after: null });

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.throttle.revalidating).toBe(true);
  release();
  await vi.waitFor(async () => {
    expect((await api(t.baseUrl, "GET", "/api/pause")).json.throttle.revalidating).toBe(false);
  });
});

it("観測不能(パース失敗)の間は GET /api/pause が throttled=true・resumesAt=null・内訳なしを運ぶ — fail-closed の可視化(issue #82)", async () => {
  t = await bootTidepool();
  await registerWork(t, "long haul");

  t.worker.scriptUsage(null); // simulates a checkUsage failure
  await t.clock.advance(HOUR);

  const res = await api(t.baseUrl, "GET", "/api/pause");
  expect(res.json.throttle).toEqual({
    throttled: true,
    resumesAt: null,
    observedAt: t.clock.now().toISOString(),
    revalidating: false,
    windows: { session: null, week: null, fable: null },
  });
});
