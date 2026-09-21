import { afterEach, expect, it } from "vitest";
import { usagePanelText } from "./fakes.js";
import { api, bootTidepool, HOUR, mcpClient, queueWork, type Tidepool } from "./harness.js";

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

const NO_SPEND_DOWN = {
  anthropic: { session: null, week: null },
  openai: { primary: null, secondary: null },
};

it("POST /api/spend-down で Provider × ウィンドウを arm / cancel でき、応答と GET /api/pause に Provider ごとの形で載る", async () => {
  t = await bootTidepool();
  const at = t.clock.now().toISOString();

  const res = await api(t.baseUrl, "POST", "/api/spend-down", { provider: "openai", window: "primary", active: true });
  expect(res).toEqual({
    status: 200,
    json: { spendDown: { ...NO_SPEND_DOWN, openai: { primary: { activatedAt: at }, secondary: null } } },
  });
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "anthropic", window: "session", active: true });
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "openai", window: "primary", active: false });

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toEqual({
    ...NO_SPEND_DOWN,
    anthropic: { session: { activatedAt: at }, week: null },
  });
});

it("既知の組(anthropic × session / week、openai × primary / secondary)以外は入口で弾く", async () => {
  t = await bootTidepool();

  for (const body of [
    { provider: "anthropic", window: "fable", active: true },
    { provider: "anthropic", window: "primary", active: true },
    { provider: "openai", window: "session", active: true },
    { provider: "moonshot", window: "session", active: true },
    { window: "session", active: true },
    { provider: "anthropic", window: "session", active: "yes" },
    { provider: "anthropic", window: "session" },
  ]) {
    const res = await api(t.baseUrl, "POST", "/api/spend-down", body);
    expect(res.status).toBe(400);
  }
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toEqual(NO_SPEND_DOWN);
});

it("ペース線超過で skip された盤面は、spend-down(session) の有効化で(hourly tick を待たず)即時 pickup が走る", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "burn the rest");

  // t=1h 時点: resets まで30分 → 経過90%、線70 — 85 は超過で skip
  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(sessionOverPace(resetsAt));
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  // 有効化そのものが再評価の発火点 — ペース線が外れ 85 < 100 で通る
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "anthropic", window: "session", active: true });
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("100% キャップで止まった spend-down はリセット時刻に再評価され、リセットを跨いだ poll の観測で対象が失効して通常ペース判定に戻る", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "after reset");
  const t0 = t.clock.now();

  // session 100% — spend-down 中でもキャップが止める。再開見込みはリセット時刻(t=1.5h)
  const resetsAt = new Date(t0.getTime() + 90 * MIN);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 100, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "anthropic", window: "session", active: true });
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
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toEqual(NO_SPEND_DOWN);
  expect(t.worker.started).toEqual([]);

  // 通常判定に戻った証拠: catch-up(経過45% = t=3.75h)を跨げば普通に流れる
  await t.clock.advance(150 * MIN);
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("Pause が勝つ — pause 中は spend-down を有効化しても pickup せず、resume で spend-down が効いた状態で流れる", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "waits behind pause");

  // ペース判定なら絞られる観測(t=1h 時点で経過40%・線20、85 は超過)
  t.worker.scriptUsage(sessionOverPace(new Date(t.clock.now().getTime() + 4 * HOUR)));
  await api(t.baseUrl, "POST", "/api/pause", { paused: true });
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "anthropic", window: "session", active: true });
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  // 独立した状態: resume すると spend-down がペース線を外しているので流れる
  await api(t.baseUrl, "POST", "/api/pause", { paused: false });
  expect(t.worker.started.map((x) => x.id)).toEqual([task.id]);
});

it("手動取り消しも再評価を発火する — 取り消し後の観測が通るなら hourly tick を待たず pickup する", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "runs after cancel");

  // session 100% — キャップが止めるので spend-down 有効化の poll でも pickup しない
  const resetsAt = new Date(t.clock.now().getTime() + 90 * MIN);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 100, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "anthropic", window: "session", active: true });
  expect(t.worker.started).toEqual([]);

  // 使用状況が健全に変わった後の取り消し — 発火しなければ次の tick まで観測されない
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 10, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "anthropic", window: "session", active: false });
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
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "anthropic", window: "session", active: true });
  await api(t.baseUrl, "POST", "/api/spend-down", { provider: "openai", window: "secondary", active: true });
  const activatedAt = t.clock.now().toISOString();

  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });

  expect((await api(t.baseUrl, "GET", "/api/pause")).json.spendDown).toEqual({
    anthropic: { session: { activatedAt }, week: null },
    openai: { primary: null, secondary: { activatedAt } },
  });
});
