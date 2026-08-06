import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { createNotificationTick, type PushClient, type PushPayload, type PushSubscription, savePushSubscription } from "../src/push.js";
import { setBoardTimezone } from "../src/quiet-hours.js";
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

// 既定の quiet hours は tz(既定 Asia/Tokyo)の壁時計で判定される(issue #63) —
// このヘルパーは JST の意図した時刻を UTC の瞬間に変換する。
function jst(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - 9 * 60 * 60 * 1000);
}

const MIDNIGHT = jst(2026, 0, 1, 0, 0);
const SEVEN_AM = jst(2026, 0, 1, 7, 0); // quiet hours ちょうど明ける瞬間(JST)
const NOON = jst(2026, 0, 1, 12, 0);

describe("createNotificationTick(issue #14): quiet hours 明けの1通まとめ通知", () => {
  it("quiet hours 中に溜まった question とログは push されず、明けた瞬間に1通のまとめ通知にまとまる", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const push = new FakePushClient();
    const tick = createNotificationTick(db, push, MIDNIGHT);

    const q1 = registerQuestion(db, "深夜の質問1", MIDNIGHT);
    const q2 = registerQuestion(db, "深夜の質問2", MIDNIGHT);
    appendEvent(db, {
      taskId: q1.id,
      workerId: "tidepool",
      origin: "webui",
      payload: { kind: "decision_logged", line: "a" },
      at: MIDNIGHT,
    });

    await tick.run(MIDNIGHT); // still quiet hours: nothing sent
    expect(push.sent).toEqual([]);

    await tick.run(SEVEN_AM); // quiet hours just ended: one digest push
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toEqual({
      title: "Good morning",
      body: "2 questions · 0 your tasks · 1 new log entries",
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

  it("tz の変更で同じ瞬間が quiet → not quiet に転じても、digest 発火はそのまま起きる(issue #63)", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const push = new FakePushClient();
    // 既定 tz(Asia/Tokyo)では MIDNIGHT(JST 0:00)は quiet hours 内
    const tick = createNotificationTick(db, push, MIDNIGHT);
    registerQuestion(db, "深夜の質問", MIDNIGHT);

    await tick.run(MIDNIGHT); // still quiet: nothing sent
    expect(push.sent).toEqual([]);

    // 時刻はそのまま、tz だけ変える — MIDNIGHT の UTC 瞬間は Etc/UTC の壁時計では
    // 15:00 で、quiet hours 外になる。wasQuietHours が前 tick の状態を tz 非依存に
    // 覚えている一方、次の isQuietHours 呼び出しは新しい tz で評価されるので、
    // 「時計が進んだのではなく tz が変わった」だけの遷移でも正しく検出されるはず。
    setBoardTimezone(db, "Etc/UTC");
    await tick.run(MIDNIGHT);

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toEqual({
      title: "Good morning",
      body: "1 questions · 0 your tasks · 0 new log entries",
      url: "/",
    });
  });

  it("quiet hours 中に登録された agent の human タスクは溜まり、明けると digest に3件数で出る(issue #116)", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const push = new FakePushClient();
    const tick = createNotificationTick(db, push, MIDNIGHT);

    // agent の decompose 直接登録(worker_id != 'human')— question と同格の通知対象
    registerTask(
      db,
      {
        type: "work",
        title: "深夜に上がった用事",
        purpose: "現地確認",
        completion_criteria: "n/a",
        assignee: "human",
      },
      MIDNIGHT,
      "planner",
    );

    await tick.run(MIDNIGHT); // still quiet hours: nothing sent
    expect(push.sent).toEqual([]);

    await tick.run(SEVEN_AM); // quiet hours just ended: one digest push
    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toEqual({
      title: "Good morning",
      body: "0 questions · 1 your tasks · 0 new log entries",
      url: "/",
    });
  });
});
