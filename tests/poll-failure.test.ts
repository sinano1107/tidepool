import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setPaused } from "../src/pause.js";
import { api, bootTidepool, HOUR, managementMcpClient, queueWork, servedQuarantineQuestion, type Tidepool } from "./harness.js";

let t: Tidepool | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

// ADR 0294 決定1: 行の振る舞いは domain 層(tests/scheduler-poll-failure.test.ts)が言う。ここは2つの読み口への写像だけ
it("最後の poll の失敗は GET /api/queue と list_queue の封筒に同じ欄で載る", async () => {
  let broken = false;
  t = await bootTidepool({
    taskExecutionCandidates: () => {
      if (broken) throw new Error("registry is broken");
      return [];
    },
  });
  queueWork(t, "waits for the registry");
  broken = true;
  await t.clock.advance(HOUR);
  broken = false;

  const expected = { at: t.clock.now().toISOString(), message: "registry is broken" };
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.lastPollFailure).toEqual(expected);
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({ name: "list_queue", arguments: {} });
    expect(JSON.parse(result.content[0].text).lastPollFailure).toEqual(expected);
  } finally {
    await client.close();
  }
});

/** 投げ続ける候補の読みで、成功を挟まず1時間離れた2回の失敗 → 続く poll の失敗の question(ADR 0294 決定2)。 */
async function bootWithPollFailureQuestion() {
  const registry = { broken: false, n: 0 };
  t = await bootTidepool({
    taskExecutionCandidates: () => {
      if (registry.broken) throw new Error(`registry is broken (${++registry.n})`);
      return [];
    },
  });
  // queue が空なら本体の読みは候補を引かずに成功する —— 投げ続けるには候補の読みに届く todo が要る
  queueWork(t, "waits for the registry");
  registry.broken = true;
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  const question = await servedQuarantineQuestion(t, "pollFailure", null);
  expect(question).toBeDefined();
  const answer = () => api(t!.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });
  return { registry, question, answer };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

it("回答は poll の撃ち直しで確かめる —— まだ投げれば新しい例外の本文で拒み、直れば観測決着の形で返す", async () => {
  const { registry, question, answer } = await bootWithPollFailureQuestion();

  const refused = await answer();
  expect(refused.status).toBe(409);
  expect(refused.json.error).toBe("the board's poll still throws: registry is broken (3)");
  expect((await api(t!.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");

  registry.broken = false;
  const accepted = await answer();
  expect(accepted.status).toBe(200);
  expect(accepted.json.settled_by_observation).toBe("quarantine_released");
  expect((await api(t!.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("done");
});

it("撃ち直しが本体に入れなければ、入れなかった理由を名指して拒む", async () => {
  const { registry, question, answer } = await bootWithPollFailureQuestion();
  registry.broken = false;
  setPaused(t!.db, true);

  const refused = await answer();

  expect(refused.status).toBe(409);
  expect(refused.json.error).toBe("the board cannot re-run the poll now: pickup is stopped: pause");
  expect((await api(t!.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");
});
