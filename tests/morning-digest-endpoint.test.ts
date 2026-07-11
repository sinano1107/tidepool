import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const MIN = 60 * 1000;

it("quiet hours 中に登録された question は push されず、明けると1通のまとめ通知が届く(注入クロック)", async () => {
  t = await bootTidepool(); // FakeClock は epoch(00:00 UTC)開始 = 既定 quiet hours 内
  await api(t.baseUrl, "POST", "/api/push/subscribe", {
    endpoint: "https://push.example/abc",
    keys: { p256dh: "k", auth: "a" },
  });

  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "question",
    title: "深夜に上がった質問",
    purpose: "quiet hours 中のテスト",
    completion_criteria: "n/a",
    question: { options: ["yes", "no"], recommendation: "yes" },
  });

  await t.clock.advance(60 * MIN); // 01:00 — まだ quiet hours 内、1分ポーリングが数回回る
  expect(t.push.sent).toEqual([]);

  await t.clock.advance(6 * 60 * MIN); // 07:00 到達 — quiet hours が明ける
  expect(t.push.sent).toHaveLength(1);
  expect(t.push.sent[0]?.payload.title).toBe("おはようございます");
  expect(t.push.sent[0]?.payload.body).toContain("質問1件");
});
