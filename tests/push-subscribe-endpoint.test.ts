import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listPushSubscriptions } from "../src/push.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("POST /api/push/subscribe が購読を保存する", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/push/subscribe", {
    endpoint: "https://push.example/abc",
    keys: { p256dh: "key-p256dh", auth: "key-auth" },
  });
  expect(res.status).toBe(201);

  const db = openDb(join(t.dir, "board.sqlite"));
  expect(listPushSubscriptions(db)).toEqual([
    { endpoint: "https://push.example/abc", p256dh: "key-p256dh", auth: "key-auth" },
  ]);
});

it("DELETE /api/push/subscribe が該当 endpoint を取り除く", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/push/subscribe", {
    endpoint: "https://push.example/abc",
    keys: { p256dh: "key-p256dh", auth: "key-auth" },
  });

  const res = await api(t.baseUrl, "DELETE", "/api/push/subscribe", {
    endpoint: "https://push.example/abc",
  });
  expect(res.status).toBe(200);

  const db = openDb(join(t.dir, "board.sqlite"));
  expect(listPushSubscriptions(db)).toEqual([]);
});
