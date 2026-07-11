import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listPushSubscriptions, removePushSubscription, savePushSubscription } from "../src/push.js";

describe("push 購読の保存(issue #14)", () => {
  it("一度も購読されていなければ一覧は空", () => {
    const db = openDb(":memory:");
    expect(listPushSubscriptions(db)).toEqual([]);
  });

  it("savePushSubscription で保存すると一覧に現れる", () => {
    const db = openDb(":memory:");
    savePushSubscription(db, {
      endpoint: "https://push.example/abc",
      p256dh: "key-p256dh",
      auth: "key-auth",
    });
    expect(listPushSubscriptions(db)).toEqual([
      { endpoint: "https://push.example/abc", p256dh: "key-p256dh", auth: "key-auth" },
    ]);
  });

  it("同じ endpoint への再購読はキーを差し替える(古いキーは残らない)", () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "old", auth: "old" });
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "new", auth: "new" });
    expect(listPushSubscriptions(db)).toEqual([
      { endpoint: "https://push.example/abc", p256dh: "new", auth: "new" },
    ]);
  });

  it("removePushSubscription で該当 endpoint を取り除く", () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    removePushSubscription(db, "https://push.example/abc");
    expect(listPushSubscriptions(db)).toEqual([]);
  });
});
