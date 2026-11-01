import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { listBoardCalls } from "../src/board-call-usage.js";
import type { CliAuthCheck } from "../src/cli-auth.js";
import { openDb } from "../src/db.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { registerTask } from "../src/tasks.js";
import { BOARD_CALL_USAGE, FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { api, bootTidepool, HUMAN_WEBUI, queueWork, type Tidepool } from "./harness.js";

const ANTHROPIC_AUTH_QUESTION_TITLE =
  "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped";

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
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

/** 行には production の読み口がまだ無いので、server 境界の `t.db` でなく scheduler を直に組んで言う(ADR 0154 決定1・2)。
 *  使用量を読めない(checkUsage が null の)scheduler を、queue に task 1つで組む。 */
function usageBlindScheduler(cliAuth: CliAuthCheck) {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  worker.scriptUsage(null);
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: () => {},
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    cliAuth,
  });
  registerTask(db, { type: "work", title: "waits while usage is ambiguous", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
  return { db, clock, scheduler };
}

const boardCall = { setting: { provider: "anthropic" as const, model: "haiku", effort: "low" }, usage: BOARD_CALL_USAGE };
const capped = { status: "unknown" as const, reason: "probe hit its budget cap before returning an authentication verdict", boardCall };

it("使用量を読めない poll が撃った認証 probe は、usage を返せば cli_auth_probe の1行を残す(ADR 0299 決定1・6)", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const { db, clock, scheduler } = usageBlindScheduler(async () => capped);

  await scheduler.rerunPoll();
  scheduler.stop();

  expect(listBoardCalls(db)).toEqual([
    { use: "cli_auth_probe", ...boardCall.setting, fragments: null, model_swaps: [], refusals: [], usage: BOARD_CALL_USAGE, createdAt: clock.now().toISOString() },
  ]);
});

// ADR 0342 決定4: probe の catch は境界 —— 盤面 DB の拒否は「分類できなかった」の log にせず投げる
it("認証 probe の区間で盤面 DB が拒めば、poll は投げる", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const refusal = new Database.SqliteError("disk I/O error", "SQLITE_IOERR_WRITE");
  const { scheduler } = usageBlindScheduler(async () => {
    throw refusal;
  });

  await expect(scheduler.rerunPoll()).rejects.toBe(refusal);
  scheduler.stop();
});
