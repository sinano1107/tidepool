import { afterEach, expect, it } from "vitest";
import { usagePanelText } from "./fakes.js";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const MIN = 60 * 1000;

/** session 85% / week 5% — ペース判定なら session 線超過で skip される観測
 *  (throttle.test.ts の overPace と同じ数字)。85 < 100 なのでキャップは通す。 */
function sessionOverPace(resetsAt: Date): string {
  return usagePanelText({
    session: { percent: 85, resetsAt },
    week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
  });
}

it("POST /api/spend-down で対象ウィンドウを有効化すると、GET /api/pause の盤面状態に window と有効化時刻が載る", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/spend-down", { window: "session" });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    spendDown: { window: "session", activatedAt: t.clock.now().toISOString() },
  });

  const pause = (await api(t.baseUrl, "GET", "/api/pause")).json;
  expect(pause.spendDown).toEqual({
    window: "session",
    activatedAt: t.clock.now().toISOString(),
  });
});

it("window: null で手動取り消しできる — 盤面状態から消える", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/spend-down", { window: "week" });

  const res = await api(t.baseUrl, "POST", "/api/spend-down", { window: null });
  expect(res.status).toBe(200);
  expect(res.json).toEqual({ spendDown: null });
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toBeNull();
});

it("session / week / null 以外の window は入口で弾く(fable は対象外 — week に束ねられる)", async () => {
  t = await bootTidepool();

  for (const window of ["fable", "day", 1, undefined]) {
    const res = await api(t.baseUrl, "POST", "/api/spend-down", { window });
    expect(res.status).toBe(400);
  }
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toBeNull();
});

it("ペース線超過で skip された盤面は、spend-down(session) の有効化で(hourly tick を待たず)即時 pickup が走る", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "burn the rest");

  // t=1h 時点: resets まで30分 → 経過90%、線70 — 85 は超過で skip
  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(sessionOverPace(resetsAt));
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  // 有効化そのものが再評価の発火点 — ペース線が外れ 85 < 100 で通る
  await api(t.baseUrl, "POST", "/api/spend-down", { window: "session" });
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("100% キャップで止まった spend-down はリセット時刻に再評価され、リセットを跨いだ観測で自動失効して通常ペース判定に戻る", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "after reset");
  const t0 = t.clock.now();

  // session 100% — spend-down 中でもキャップが止める。再開見込みはリセット時刻(t=1.5h)
  const resetsAt = new Date(t0.getTime() + 90 * MIN);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 100, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  await api(t.baseUrl, "POST", "/api/spend-down", { window: "session" });
  expect(t.worker.started).toEqual([]);

  // リセット後の実世界: 新ウィンドウ(開始 t=1.5h、resets t=6.5h)の観測
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 25, resetsAt: new Date(t0.getTime() + 6.5 * HOUR) },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  // t=1.5h: リセットタイマーの poll が失効を観測して状態をクリア。新ウィンドウは
  // 予約期間(経過0%・線 −20)なのでペース判定で絞られたまま — 失効の放置はない
  await t.clock.advance(90 * MIN);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toBeNull();
  expect(t.worker.started).toEqual([]);

  // 通常判定に戻った証拠: catch-up(経過45% = t=3.75h)を跨げば普通に流れる
  await t.clock.advance(150 * MIN);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("spend-down(week) は fable のタスク単位 skip も解除する — 同じ瞬間に失効する予算(ADR 0030)", async () => {
  t = await bootTidepool({ fableAgents: () => ["fable-artisan"] });
  const fableTask = await registerWork(t, "fable work", undefined, undefined, "fable-artisan");

  // fable 線だけ超過している観測(throttle.test.ts の fableOverPace と同じ数字)
  const now = t.clock.now();
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 0, resetsAt: new Date(now.getTime() + 3 * HOUR) },
      week: { percent: 5, resetsAt: new Date(now.getTime() + 2 * 24 * HOUR) },
      fable: { percent: 84, resetsAt: new Date(now.getTime() + 12 * HOUR) },
    }),
  );
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  await api(t.baseUrl, "POST", "/api/spend-down", { window: "week" });
  expect(t.worker.started.map((x) => x.id)).toEqual([fableTask.id]);
});

it("Pause が勝つ — pause 中は spend-down を有効化しても pickup せず、resume で spend-down が効いた状態で流れる", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "waits behind pause");

  // ペース判定なら絞られる観測(t=1h 時点で経過40%・線20、85 は超過)
  t.worker.scriptUsage(sessionOverPace(new Date(t.clock.now().getTime() + 4 * HOUR)));
  await api(t.baseUrl, "POST", "/api/pause", { paused: true });
  await api(t.baseUrl, "POST", "/api/spend-down", { window: "session" });
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  // 独立した状態: resume すると spend-down がペース線を外しているので流れる
  await api(t.baseUrl, "POST", "/api/pause", { paused: false });
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("手動取り消しも再評価を発火する — 取り消し後の観測が通るなら hourly tick を待たず pickup し、throttle_state も最新化される", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "runs after cancel");

  // session 100% — キャップが止めるので spend-down 有効化の poll でも pickup しない
  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 100, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  await api(t.baseUrl, "POST", "/api/spend-down", { window: "session" });
  expect(t.worker.started).toEqual([]);

  // 使用状況が健全に変わった後の取り消し — 発火しなければ次の tick まで観測されない
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 10, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  await api(t.baseUrl, "POST", "/api/spend-down", { window: null });
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("spend-down は人間専用の操舵チャネル: MCP には一切公開されない(pause と同じ姿勢)", async () => {
  t = await bootTidepool();
  const client = await mcpClient(t.mcpBaseUrl);
  const { tools } = await client.listTools();
  expect(tools.map((x) => x.name).filter((n) => /spend/.test(n))).toEqual([]);
  await client.close();
});

it("spend-down 状態はサーバー再起動を跨いで維持される", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/spend-down", { window: "week" });
  const activatedAt = t.clock.now().toISOString();

  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toEqual({
    window: "week",
    activatedAt,
  });
});
