import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

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
