import { afterEach, expect, it } from "vitest";
import { CLI_AUTH_PROBE_INTERVAL_MS, CLI_AUTH_QUESTION_TITLE } from "../src/cli-auth.js";
import { api, bootTidepool, HOUR, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("起動時のprobeで401が確定しても人間面は開き、修理questionを1枚だけ立てる(ADR 0070)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "unauthorized", reason: "API returned 401" }),
  });

  const tasks = await api(t.baseUrl, "GET", "/api/tasks");
  expect({
    status: tasks.status,
    questionTitles: (tasks.json as any[])
      .filter((task) => task.type === "question")
      .map((task) => task.title),
  }).toEqual({ status: 200, questionTitles: [CLI_AUTH_QUESTION_TITLE] });
});

it("起動後は30分ごとにprobeし、401を検出した後はquestionを重ねない(ADR 0070)", async () => {
  let calls = 0;
  t = await bootTidepool({
    cliAuth: async () => {
      calls += 1;
      return calls === 1
        ? { status: "authenticated" }
        : { status: "unauthorized", reason: "API returned 401" };
    },
  });
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toEqual([]);

  await t.clock.advance(CLI_AUTH_PROBE_INTERVAL_MS);
  await t.clock.advance(CLI_AUTH_PROBE_INTERVAL_MS * 2);

  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  expect({ calls, questionTitles: tasks.map((task) => task.title) }).toEqual({
    calls: 2,
    questionTitles: [CLI_AUTH_QUESTION_TITLE],
  });
});

it("cliAuth question が開いている間は盤面全体のpickupを止める(ADR 0070)", async () => {
  t = await bootTidepool({
    cliAuth: async () => ({ status: "unauthorized", reason: "API returned 401" }),
  });
  await registerWork(t, "waits for authentication repair");

  await t.clock.advance(HOUR);

  expect(t.worker.started).toEqual([]);
});
