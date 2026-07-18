import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { createNotificationTick, type PushClient, type PushPayload, type PushSubscription, savePushSubscription } from "../src/push.js";
import { registerTask } from "../src/tasks.js";
import { FakePushClient } from "./fakes.js";

/** A PushClient whose send() doesn't resolve until release() is called —
 *  for driving a genuine overlap between two tick.run() calls (the
 *  inFlight reentrancy guard's own reason to exist). */
class GatedPushClient implements PushClient {
  readonly sent: Array<{ subscription: PushSubscription; payload: PushPayload }> = [];
  private release!: () => void;
  private gate = new Promise<void>((resolve) => (this.release = resolve));

  async send(subscription: PushSubscription, payload: PushPayload): Promise<void> {
    await this.gate;
    this.sent.push({ subscription, payload });
  }

  open(): void {
    this.release();
  }
}

function registerQuestion(db: ReturnType<typeof openDb>, title: string, at: Date) {
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

const MIDNIGHT = new Date(Date.UTC(2026, 0, 1, 0, 0));
const SEVEN_AM = new Date(Date.UTC(2026, 0, 1, 7, 0)); // quiet hours ちょうど明ける瞬間
const NOON = new Date(Date.UTC(2026, 0, 1, 12, 0));

describe("createNotificationTick(issue #14): quiet hours 明けの1通まとめ通知", () => {
  it("quiet hours 中に溜まった question とログは push されず、明けた瞬間に1通のまとめ通知にまとまる", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const push = new FakePushClient();
    const tick = createNotificationTick(db, push, MIDNIGHT);

    const q1 = registerQuestion(db, "深夜の質問1", MIDNIGHT);
    const q2 = registerQuestion(db, "深夜の質問2", MIDNIGHT);
    appendEvent(db, { taskId: q1.id, workerId: "tidepool", payload: { kind: "decision_logged", line: "a" }, at: MIDNIGHT });

    await tick.run(MIDNIGHT); // still quiet hours: nothing sent
    expect(push.sent).toEqual([]);

    await tick.run(SEVEN_AM); // quiet hours just ended: one digest push
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toEqual({
      title: "Good morning",
      body: "2 questions · 1 new log entries",
      url: "/",
    });
    void q2;
  });

  it("同じ明け方を2回ティックしても再送しない", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const push = new FakePushClient();
    const tick = createNotificationTick(db, push, MIDNIGHT);
    registerQuestion(db, "深夜の質問", MIDNIGHT);

    await tick.run(SEVEN_AM);
    expect(push.sent).toHaveLength(1);

    await tick.run(NOON); // still daytime, no new questions
    expect(push.sent).toHaveLength(1);
  });

  it("日中に新規登録された question は個別に即時通知される(まとめではない)", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const push = new FakePushClient();
    const tick = createNotificationTick(db, push, NOON); // 起動時点で既に quiet hours 外

    const task = registerQuestion(db, "日中の質問", NOON);
    await tick.run(NOON);

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload.title).toBe("日中の質問");
    expect(push.sent[0]?.payload.url).toBe(`/?question=${task.id}`);
  });

  it("前回の tick がまだ送信中なら次の tick は何もしない(code review 指摘: 再入防止)", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const push = new GatedPushClient();
    const tick = createNotificationTick(db, push, MIDNIGHT);
    registerQuestion(db, "深夜の質問", MIDNIGHT);

    const firstRun = tick.run(SEVEN_AM); // quiet hours 明け — digest 送信中、まだ gate で止まっている
    const secondRun = tick.run(SEVEN_AM); // 重なって発火した2回目の poll tick

    await secondRun; // inFlight ガードにより即座に no-op で戻る
    expect(push.sent).toEqual([]); // 1回目はまだ gate 待ち

    push.open();
    await firstRun;

    expect(push.sent).toHaveLength(1); // digest は1通だけ
  });
});
