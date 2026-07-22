import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { pollNotifications, savePushSubscription } from "../src/push.js";
import { answerQuestion, registerTask } from "../src/tasks.js";
import { FakePushClient } from "./fakes.js";

// issue #116: a human-assignee task registered without a human operation (an
// agent's decompose registering it directly) is a notification target of equal
// urgency to a question — it blocks its parent the same way. A human task the
// human's own operation created (WebUI direct registration, or an approve
// answer materializing a pending child) is the echo of that click and stays
// silent. The discriminator is the task_registered event's worker_id: 'human'
// for both human-triggered paths, the agent's own id otherwise.

function registerHumanTask(
  db: ReturnType<typeof openDb>,
  title: string,
  workerId: string,
  at = new Date(0),
) {
  return registerTask(
    db,
    {
      type: "work",
      title,
      purpose: `purpose of ${title}`,
      completion_criteria: "n/a",
      assignee: "human",
    },
    at,
    workerId,
  );
}

describe("pollNotifications(issue #116): agent 登録の human タスクを question と同格に通知する", () => {
  it("agent の decompose で直接登録された human タスクを購読済みデバイスへ push し、通知済みにする", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const task = registerHumanTask(db, "水やりして", "planner");
    const push = new FakePushClient();

    const noon = new Date(Date.UTC(2026, 0, 1, 12, 0));
    await pollNotifications({ db, push }, noon);

    expect(push.sent).toHaveLength(1);
    expect(push.sent[0]?.payload).toEqual({
      title: "水やりして",
      body: "purpose of 水やりして",
      // no dedicated your-tasks view exists yet (humanTasks slice is empty in
      // index.html) — the deep link lands on the board root, same as the
      // morning digest's own "/" (issue #116)
      url: "/",
    });
    void task;

    // 2回目のポーリングでは既に通知済みなので再送しない
    await pollNotifications({ db, push }, noon);
    expect(push.sent).toHaveLength(1);
  });

  it("WebUI 直接登録(worker_id = 'human')の human タスクは通知しない", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    registerHumanTask(db, "自分でメモした用事", "human");
    const push = new FakePushClient();

    await pollNotifications({ db, push }, new Date(Date.UTC(2026, 0, 1, 12, 0)));

    expect(push.sent).toEqual([]);
  });

  it("承認 question への approve 回答で実体化した human タスクは通知しない(自分のクリックのエコー)", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    const at = new Date(Date.UTC(2026, 0, 1, 12, 0));

    const parent = registerTask(
      db,
      { type: "work", title: "計画", purpose: "p", completion_criteria: "c" },
      at,
      "planner",
    );
    // an out-of-authority `assignee: "human"` child converts to this approval
    // question at decompose time — answerQuestion materializes it under
    // HUMAN_WORKER_ID on "approve" (tasks.ts), the same silent attribution as
    // a WebUI registration
    const question = registerTask(
      db,
      {
        type: "question",
        title: "人間に委譲していい?",
        purpose: "ctx",
        completion_criteria: "a human answer is recorded",
        parent_id: parent.id,
        question: [
          { title: "人間に委譲していい?", options: ["approve", "reject"], recommendation: "approve" },
        ],
        pending_child: {
          title: "現地で確認して",
          purpose: "センサーでは分からない",
          completion_criteria: "確認済み",
          assignee: "human",
        },
      },
      at,
      "planner",
    );
    answerQuestion(db, question, ["approve"], at);

    const push = new FakePushClient();
    await pollNotifications({ db, push }, at);

    // the question itself is now answered (done), so it is not re-pushed; the
    // materialized human child is human-registered, so it is not pushed either
    expect(push.sent).toEqual([]);
  });

  it("agent 登録の human タスクと question は同じ poll で両方通知される", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    registerTask(
      db,
      {
        type: "question",
        title: "merge していい?",
        purpose: "ctx",
        completion_criteria: "n/a",
        question: [{ title: "merge していい?", options: ["yes", "no"], recommendation: "yes" }],
      },
      new Date(0),
      "planner",
    );
    registerHumanTask(db, "水やりして", "planner");
    const push = new FakePushClient();

    await pollNotifications({ db, push }, new Date(Date.UTC(2026, 0, 1, 12, 0)));

    expect(push.sent.map((s) => s.payload.title).sort()).toEqual(["merge していい?", "水やりして"]);
  });

  it("quiet hours 中は human タスクも push せず、未通知のまま残す", async () => {
    const db = openDb(":memory:");
    savePushSubscription(db, { endpoint: "https://push.example/abc", p256dh: "k", auth: "a" });
    registerHumanTask(db, "深夜に上がった用事", "planner");
    const push = new FakePushClient();

    // 既定 quiet hours (23:00–07:00, Asia/Tokyo) 内 — JST 0:00 は UTC 前日 15:00
    const midnight = new Date(Date.UTC(2025, 11, 31, 15, 0));
    await pollNotifications({ db, push }, midnight);

    expect(push.sent).toEqual([]);
  });
});
