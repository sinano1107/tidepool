import { afterEach, expect, it } from "vitest";
import { CLI_AUTH_QUESTION_TITLE } from "../src/cli-auth.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("checkUsage がnullでも追加probeで401が確定したときだけcliAuth questionを立てる(ADR 0070)", async () => {
  let checks = 0;
  t = await bootTidepool({
    cliAuth: async () => {
      checks += 1;
      return checks === 1
        ? { status: "authenticated" }
        : { status: "unauthorized", reason: "API returned 401" };
    },
  });
  t.worker.scriptUsage(null);
  const task = await registerWork(t, "waits after usage becomes unobservable");

  await api(t.baseUrl, "POST", `/api/tasks/${task.id}/move`, { after: null });

  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  expect({
    checks,
    started: t.worker.started,
    questionTitles: tasks.filter((candidate) => candidate.type === "question").map((candidate) => candidate.title),
  }).toEqual({
    checks: 2,
    started: [],
    questionTitles: [CLI_AUTH_QUESTION_TITLE],
  });
});

it("checkUsage のnullを追加probeでも分類できなければfail-closed throttleだけに留める(ADR 0070)", async () => {
  let checks = 0;
  t = await bootTidepool({
    cliAuth: async () => {
      checks += 1;
      return { status: "unknown", reason: "probe did not return a JSON envelope" };
    },
  });
  t.worker.scriptUsage(null);
  const task = await registerWork(t, "waits while usage is ambiguous");

  await api(t.baseUrl, "POST", `/api/tasks/${task.id}/move`, { after: null });

  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const pause = (await api(t.baseUrl, "GET", "/api/pause")).json;
  expect({
    checks,
    questions: tasks.filter((candidate) => candidate.type === "question"),
    halts: pause.halts.map((halt: { kind: string }) => halt.kind),
  }).toEqual({ checks: 2, questions: [], halts: ["throttle"] });
});
