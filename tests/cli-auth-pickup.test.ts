import { afterEach, expect, it, vi } from "vitest";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

const ANTHROPIC_AUTH_QUESTION_TITLE =
  "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped";

let t: Tidepool;
afterEach(() => {
  t?.stop();
  vi.restoreAllMocks();
});

it("checkUsage がnullでも追加probeで401が確定したときだけcliAuth questionを立てる(ADR 0070)", async () => {
  let checks = 0;
  t = await bootTidepool({
    cliAuth: async () => {
      checks += 1;
      return { status: "unauthorized", reason: "API returned 401" };
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
    checks: 1,
    started: [],
    questionTitles: [ANTHROPIC_AUTH_QUESTION_TITLE],
  });
});

it("checkUsage のnullを追加probeでも分類できなければfail-closed throttleだけに留める(ADR 0070)", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
  }).toEqual({ checks: 1, questions: [], halts: ["throttle"] });
  expect(warn).toHaveBeenCalledWith(
    "[cli-auth] usage failure could not be classified",
    "probe did not return a JSON envelope",
  );
});
