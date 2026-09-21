import { afterEach, expect, it, vi } from "vitest";
import { api, bootTidepool, queueWork, type Tidepool } from "./harness.js";

const ANTHROPIC_AUTH_QUESTION_TITLE =
  "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped";

let t: Tidepool;
afterEach(() => {
  t?.stop();
  vi.restoreAllMocks();
});

it("checkUsage がnullでも追加probeで401が確定したときだけ provider の Confirmation を立てる(ADR 0070)", async () => {
  let checks = 0;
  t = await bootTidepool({
    cliAuth: async () => {
      checks += 1;
      return { status: "unauthorized", reason: "API returned 401" };
    },
  });
  t.worker.scriptUsage(null);
  const task = queueWork(t, "waits after usage becomes unobservable");

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

it("checkUsage のnullを追加probeでも分類できなければ anthropic の fail-closed な除外だけに留める —— question も盤面全体の停止も立たない(ADR 0070 / ADR 0140)", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  let checks = 0;
  t = await bootTidepool({
    cliAuth: async () => {
      checks += 1;
      return { status: "unknown", reason: "probe did not return a JSON envelope" };
    },
  });
  t.worker.scriptUsage(null);
  const task = queueWork(t, "waits while usage is ambiguous");

  await api(t.baseUrl, "POST", `/api/tasks/${task.id}/move`, { after: null });

  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json;
  expect({
    checks,
    questions: tasks.filter((candidate) => candidate.type === "question"),
    halts: queue.halts,
    status: queue.tasks.find((row: any) => row.id === task.id)?.status,
  }).toEqual({ checks: 1, questions: [], halts: [], status: "skipped" });
  expect(warn).toHaveBeenCalledWith(
    "[cli-auth] usage failure could not be classified",
    "probe did not return a JSON envelope",
  );
});
