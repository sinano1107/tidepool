import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { pollNotifications, savePushSubscription } from "../src/push.js";
import { answerQuestion, registerTask } from "../src/tasks.js";
import { FakePushClient } from "./fakes.js";

function registerQuestion(db: ReturnType<typeof openDb>, title: string, at = new Date(0)) {
  return registerTask(
    db,
    {
      type: "question",
      title,
      purpose: `purpose of ${title}`,
      completion_criteria: "n/a",
      question: [{ title, options: ["yes", "no"], recommendation: "yes" }],
    },
    at,
  );
}

describe("pollNotifications(issue #14): quiet hours 外の question を即時通知する", () => {
  it("quiet hours 外なら未通知の question を購読済みデバイスへ push し、通知済みにする", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const task = registerQuestion(db, "merge していい?");
    const push = new FakePushClient();

    const noon = new Date(Date.UTC(2026, 0, 1, 12, 0));
    await pollNotifications({ db, push }, noon);

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toEqual({
      title: "merge していい?",
      body: "purpose of merge していい?",
      url: `/?question=${task.id}`,
    });

    // 2回目のポーリングでは既に通知済みなので再送しない
    await pollNotifications({ db, push }, noon);
    expect(push.sent).toHaveLength(1);
  });

  it("quiet hours 中は push せず、未通知のまま残す", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    registerQuestion(db, "深夜の質問");
    const push = new FakePushClient();

    const midnight = new Date(Date.UTC(2026, 0, 1, 0, 0)); // 既定 quiet hours (23:00–07:00) 内
    await pollNotifications({ db, push }, midnight);

    expect(push.sent).toEqual([]);
  });

  it("push が未設定(構成なし)なら何もしない", async () => {
    const db = openDb(":memory:");
    registerQuestion(db, "push 未設定");
    await expect(pollNotifications({ db, push: undefined }, new Date(Date.UTC(2026, 0, 1, 12, 0)))).resolves.toBeUndefined();
  });

  it("push が届く前にボードで直接回答済みの question は通知しない(code review 指摘: status フィルタ漏れ)", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const noon = new Date(Date.UTC(2026, 0, 1, 12, 0));
    const task = registerQuestion(db, "すでに回答済み", noon);
    answerQuestion(db, task, ["yes"], noon);

    const push = new FakePushClient();
    await pollNotifications({ db, push }, noon);

    expect(push.sent).toEqual([]);
  });

  it("1つの購読先への送信失敗が他の購読先や他の question への通知を止めない(code review 指摘: エラー分離)", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/dead", p256dh: "k", auth: "a" });
    savePushSubscription(db, { endpoint: "https://push.example/alive", p256dh: "k", auth: "a" });
    registerQuestion(db, "質問1");
    registerQuestion(db, "質問2");
    const push = new FakePushClient();
    push.scriptFailure("https://push.example/dead");

    const noon = new Date(Date.UTC(2026, 0, 1, 12, 0));
    await expect(pollNotifications({ db, push }, noon)).resolves.toBeUndefined();

    // 生きている購読先へは両方の question が届き、死んでいる方の失敗は他へ波及しない
    expect(push.sent.filter((s) => s.subscription.endpoint === "https://push.example/alive")).toHaveLength(2);
  });
});
