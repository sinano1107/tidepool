import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, registerQuestion, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 購読の production の読み手は通知 poll(ADR 0154 決定1)。question を1件登録して poll を回し、
 *  push が届いた購読を返す。boot 時の FakeClock は JST 09:00 で quiet hours 外なので即時通知になる。 */
async function pushedSubscriptions(t: Tidepool) {
  registerQuestion(t, {
    title: "日中の質問",
    purpose: "購読の読み手を通す",
    completion_criteria: "n/a",
    question: [{ title: "日中の質問", options: ["yes", "no"], recommendation: "yes" }],
  });
  await t.clock.advance(60 * 1000);
  return t.push.sent.map((sent) => sent.subscription);
}

it("POST /api/push/subscribe が購読を保存する", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/push/subscribe", {
    endpoint: "https://push.example/abc",
    keys: { p256dh: "key-p256dh", auth: "key-auth" },
  });
  expect(res.status).toBe(201);

  expect(await pushedSubscriptions(t)).toEqual([
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

  expect(await pushedSubscriptions(t)).toEqual([]);
});
