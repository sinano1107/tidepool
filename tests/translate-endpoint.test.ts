import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getTask, logDecision } from "../src/tasks.js";
import { reportThrottle } from "../src/throttle.js";
import { FakeTranslationClient } from "./fakes.js";
import { api, bootTidepool, registerQuestion, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("未配線の場合、POST /api/translate は 503 を返す(LLM unreachable と同じ扱い)", async () => {
  t = await bootTidepool();

  const res = await api(t.baseUrl, "POST", "/api/translate", {
    type: "log_entry",
    event_id: 1,
  });
  expect(res.status).toBe(503);
});

it("decision log の一行を翻訳する(type: log_entry)", async () => {
  const translationClient = new FakeTranslationClient();
  translationClient.scriptTranslation("アプローチAを採用することにした");
  t = await bootTidepool({ translationClient });

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "t",
    purpose: "p",
    completion_criteria: "c",
  });
  const db = openDb(`${t.dir}/board.sqlite`);
  const eventId = logDecision(
    db,
    getTask(db, registered.json.id)!,
    "decided to use approach A",
    "tako",
    t.clock.now(),
  );
  db.close();

  const res = await api(t.baseUrl, "POST", "/api/translate", { type: "log_entry", event_id: eventId });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    status: "translated",
    text: "アプローチAを採用することにした",
    cached: false,
  });
  expect(translationClient.calls).toEqual([
    { source: "decided to use approach A", language: "Japanese" },
  ]);
});

it("同じ event_id への2回目の翻訳リクエストはキャッシュから返し、クライアントを再度呼ばない", async () => {
  const translationClient = new FakeTranslationClient();
  translationClient.scriptTranslation("訳文");
  t = await bootTidepool({ translationClient });

  const question = registerQuestion(t, {
    title: "merge decision",
    purpose: "CI passed, ready to merge?",
    completion_criteria: "answered",
    question: [{ title: "merge now?", options: ["merge", "hold"], recommendation: "merge" }],
  });

  const first = await api(t.baseUrl, "POST", "/api/translate", {
    type: "question",
    task_id: question.id,
  });
  expect(first.status).toBe(200);
  expect(first.json).toEqual({
    status: "translated",
    purpose: "訳文",
    items: [{ title: "訳文", detail: undefined }],
    cached: false,
  });

  const second = await api(t.baseUrl, "POST", "/api/translate", {
    type: "question",
    task_id: question.id,
  });
  expect(second.json.cached).toBe(true);
  expect(translationClient.calls).toHaveLength(2); // purpose + 1 item title, no repeat
});

it("throttled 中は翻訳を実行せず、応答が throttled と区別できる", async () => {
  const translationClient = new FakeTranslationClient();
  t = await bootTidepool({ translationClient });

  const db = (await import("../src/db.js")).openDb(`${t.dir}/board.sqlite`);
  reportThrottle(db, { throttled: true, resetsAt: null });
  db.close();

  const question = registerQuestion(t, {
    title: "merge decision",
    purpose: "CI passed, ready to merge?",
    completion_criteria: "answered",
    question: [{ title: "merge now?", options: ["merge", "hold"], recommendation: "merge" }],
  });

  const res = await api(t.baseUrl, "POST", "/api/translate", {
    type: "question",
    task_id: question.id,
  });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({ status: "throttled" });
  expect(translationClient.calls).toEqual([]);
});

it("handoff doc を翻訳する(type: handoff, 見出しは英語のまま)", async () => {
  const translationClient = new FakeTranslationClient();
  translationClient.scriptTranslation("センサーは5分ごとに湿度を報告する");
  t = await bootTidepool({ translationClient });

  const registered = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "t",
    purpose: "p",
    completion_criteria: "c",
    assignee: "human",
  });
  await api(t.baseUrl, "POST", `/api/tasks/${registered.json.id}/complete`, {
    handoff: { outcome: "sensor reports moisture every 5 minutes" },
  });

  const res = await api(t.baseUrl, "POST", "/api/translate", {
    type: "handoff",
    task_id: registered.json.id,
  });

  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    status: "translated",
    doc: "## Outcome vs completion criteria\n\nセンサーは5分ごとに湿度を報告する",
    cached: false,
  });
});

it("存在しない task_id は 404 を返す", async () => {
  const translationClient = new FakeTranslationClient();
  t = await bootTidepool({ translationClient });

  const res = await api(t.baseUrl, "POST", "/api/translate", {
    type: "handoff",
    task_id: "no-such-task",
  });
  expect(res.status).toBe(404);
});

it("不正なリクエストボディは 400 を返す", async () => {
  const translationClient = new FakeTranslationClient();
  t = await bootTidepool({ translationClient });

  const res = await api(t.baseUrl, "POST", "/api/translate", { type: "bogus" });
  expect(res.status).toBe(400);
});
