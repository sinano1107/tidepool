import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, registerQuestion, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const MIN = 60 * 1000;

it("quiet hours 中に登録された question は push されず、明けると1通のまとめ通知が届く(注入クロック)", async () => {
  t = await bootTidepool(); // FakeClock は epoch(00:00 UTC)開始
  // 既定 tz は Asia/Tokyo なので epoch(UTC 00:00)は JST 09:00 で quiet hours 外 —
  // この統合テストは「epoch = quiet hours 内」という前提で組まれているので、tz を
  // Etc/UTC に合わせて epoch が既定の 23:00–07:00 quiet hours 内になるようにする。
  await api(t.baseUrl, "POST", "/api/settings/timezone", { tz: "Etc/UTC" });
  await api(t.baseUrl, "POST", "/api/push/subscribe", {
    endpoint: "https://push.example/abc",
    keys: { p256dh: "k", auth: "a" },
  });

  registerQuestion(t, {
    title: "深夜に上がった質問",
    purpose: "quiet hours 中のテスト",
    completion_criteria: "n/a",
    question: [{ title: "深夜に上がった質問", options: ["yes", "no"], recommendation: "yes" }],
  });

  await t.clock.advance(60 * MIN); // 01:00 — まだ quiet hours 内、1分ポーリングが数回回る
  expect(t.push.sent).toEqual([]);

  await t.clock.advance(6 * 60 * MIN); // 07:00 到達 — quiet hours が明ける
  expect(t.push.sent).toHaveLength(1);
  expect(t.push.sent[0]?.payload.title).toBe("Good morning");
  expect(t.push.sent[0]?.payload.body).toContain("1 questions");
});
