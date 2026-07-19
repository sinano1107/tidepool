import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/settings/quiet-hours は既定値 23:00–07:00 Asia/Tokyo を返す", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/quiet-hours");
  expect(res.json).toEqual({ start: "23:00", end: "07:00", tz: "Asia/Tokyo" });
});

it("POST /api/settings/quiet-hours で設定を変更でき、GET に反映される(tz は変わらない)", async () => {
  t = await bootTidepool();
  const post = await api(t.baseUrl, "POST", "/api/settings/quiet-hours", {
    start: "22:00",
    end: "06:30",
  });
  expect(post.status).toBe(200);

  const res = await api(t.baseUrl, "GET", "/api/settings/quiet-hours");
  expect(res.json).toEqual({ start: "22:00", end: "06:30", tz: "Asia/Tokyo" });
});

it("不正な形式(HH:MM でない)は 400", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/quiet-hours", {
    start: "11pm",
    end: "07:00",
  });
  expect(res.status).toBe(400);
});

it("GET /api/settings/timezone は既定値 Asia/Tokyo を返す", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/timezone");
  expect(res.json).toEqual({ tz: "Asia/Tokyo" });
});

it("POST /api/settings/timezone で tz を変更でき、GET /settings/quiet-hours の tz にも反映される(start/end は変わらない)", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/settings/quiet-hours", { start: "22:00", end: "06:30" });

  const post = await api(t.baseUrl, "POST", "/api/settings/timezone", { tz: "America/New_York" });
  expect(post.status).toBe(200);
  expect(post.json).toEqual({ tz: "America/New_York" });

  const tzRes = await api(t.baseUrl, "GET", "/api/settings/timezone");
  expect(tzRes.json).toEqual({ tz: "America/New_York" });

  const quietHoursRes = await api(t.baseUrl, "GET", "/api/settings/quiet-hours");
  expect(quietHoursRes.json).toEqual({ start: "22:00", end: "06:30", tz: "America/New_York" });
});

it("不正な IANA 名(実在しないゾーン)は 400", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/timezone", { tz: "Asia/Osaka" });
  expect(res.status).toBe(400);

  const tzRes = await api(t.baseUrl, "GET", "/api/settings/timezone");
  expect(tzRes.json).toEqual({ tz: "Asia/Tokyo" });
});

it("tz が空文字、または欠落は 400", async () => {
  t = await bootTidepool();
  const empty = await api(t.baseUrl, "POST", "/api/settings/timezone", { tz: "" });
  expect(empty.status).toBe(400);

  const missing = await api(t.baseUrl, "POST", "/api/settings/timezone", {});
  expect(missing.status).toBe(400);
});
