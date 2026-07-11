import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/settings/quiet-hours は既定値 23:00–07:00 を返す", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/quiet-hours");
  expect(res.json).toEqual({ start: "23:00", end: "07:00" });
});

it("POST /api/settings/quiet-hours で設定を変更でき、GET に反映される", async () => {
  t = await bootTidepool();
  const post = await api(t.baseUrl, "POST", "/api/settings/quiet-hours", {
    start: "22:00",
    end: "06:30",
  });
  expect(post.status).toBe(200);

  const res = await api(t.baseUrl, "GET", "/api/settings/quiet-hours");
  expect(res.json).toEqual({ start: "22:00", end: "06:30" });
});

it("不正な形式(HH:MM でない)は 400", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/quiet-hours", {
    start: "11pm",
    end: "07:00",
  });
  expect(res.status).toBe(400);
});
