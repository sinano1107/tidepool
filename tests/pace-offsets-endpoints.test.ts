import { afterEach, expect, it } from "vitest";
import { usagePanelText } from "./fakes.js";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/settings/pace-offsets は既定値 session 20 / week 10 / fable 10 を返す(ADR 0030)", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/pace-offsets");
  expect(res.json).toEqual({ session: 20, week: 10, fable: 10 });
});

it("POST /api/settings/pace-offsets で設定を変更でき、GET に反映される", async () => {
  t = await bootTidepool();
  const post = await api(t.baseUrl, "POST", "/api/settings/pace-offsets", {
    session: 30,
    week: 15,
    fable: 5,
  });
  expect(post.status).toBe(200);

  const res = await api(t.baseUrl, "GET", "/api/settings/pace-offsets");
  expect(res.json).toEqual({ session: 30, week: 15, fable: 5 });
});

it("throttle 中に pace offsets を緩めると hourly tick を待たず新しい判定で pickup される(issue #296)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "runs after a relaxed pace offset");
  const resetsAt = new Date(t.clock.now().getTime() + 4 * HOUR);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 30, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );

  // t=1h: session の経過は40%。既定 offset 20 の線20を30が超えるため throttle。
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  const res = await api(t.baseUrl, "POST", "/api/settings/pace-offsets", {
    session: 0,
    week: 10,
    fable: 10,
  });

  expect(res.status).toBe(200);
  expect(t.worker.started.map((started) => started.id)).toEqual([task.id]);
});

it("不正な pace offsets の POST は即時再評価を発火しない(issue #296)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "waits for the next hourly tick");
  const resetsAt = new Date(t.clock.now().getTime() + 4 * HOUR);
  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 30, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  await t.clock.advance(HOUR);
  expect(t.worker.started).toEqual([]);

  t.worker.scriptUsage(
    usagePanelText({
      session: { percent: 5, resetsAt },
      week: { percent: 5, resetsAt: new Date(resetsAt.getTime() + 24 * HOUR) },
    }),
  );
  const res = await api(t.baseUrl, "POST", "/api/settings/pace-offsets", {
    session: "invalid",
    week: 10,
    fable: 10,
  });

  expect(res.status).toBe(400);
  expect(t.worker.started).toEqual([]);
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((started) => started.id)).toEqual([task.id]);
});

it("不正値(非数値・範囲外・非整数)は入口で 400 に弾かれ、設定は変わらない(ADR 0030)", async () => {
  t = await bootTidepool();

  for (const bad of [
    { session: "twenty", week: 10, fable: 10 },
    { session: -5, week: 10, fable: 10 },
    { session: 101, week: 10, fable: 10 },
    { session: 12.5, week: 10, fable: 10 },
  ]) {
    const res = await api(t.baseUrl, "POST", "/api/settings/pace-offsets", bad);
    expect(res.status).toBe(400);
  }

  const res = await api(t.baseUrl, "GET", "/api/settings/pace-offsets");
  expect(res.json).toEqual({ session: 20, week: 10, fable: 10 });
});

it("オフセット 0(予約なし)も有効な設定として保存できる境界値", async () => {
  t = await bootTidepool();
  const post = await api(t.baseUrl, "POST", "/api/settings/pace-offsets", {
    session: 0,
    week: 0,
    fable: 0,
  });
  expect(post.status).toBe(200);

  const res = await api(t.baseUrl, "GET", "/api/settings/pace-offsets");
  expect(res.json).toEqual({ session: 0, week: 0, fable: 0 });
});
