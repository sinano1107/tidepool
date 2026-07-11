import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/push/vapid-public-key は未設定なら null を返す", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/push/vapid-public-key");
  expect(res.json).toEqual({ publicKey: null });
});
