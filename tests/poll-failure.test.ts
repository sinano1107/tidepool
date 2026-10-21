import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, managementMcpClient, queueWork, type Tidepool } from "./harness.js";

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
