import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import { harnessContainmentPickupBlocked } from "../src/harness-containment.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { getTask, listBoard, registerTask } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { FakeClock, healthyUsageText, noRetrospectiveCalls, passthroughContainers, unusedLanding } from "./fakes.js";
import { HUMAN_WEBUI } from "./harness.js";

it("a Harness quarantine answer is accepted only after the same live check recovers", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  let repaired = false;
  const check = async () => repaired
    ? { available: true as const }
    : { available: false as const, reason: "permission canary failed" };

  expect(await harnessContainmentPickupBlocked(db, "codex", check, clock.now())).toBe(true);
  const questionId = listBoard(db).find(
    (task) => (task.question_quarantine_kind === "harnessContainment" && task.question_quarantine_value === "codex"),
  )?.id;
  expect(questionId).toBeDefined();
  const question = getTask(db, questionId!);
  expect(question).toBeDefined();
  await expect(submitAnswer(
    {
      db,
      pollNow() {},
      quarantineChecks: quarantineChecks({ db, harnessContainment: async () => check() }),
      landing: unusedLanding,
    },
    question!,
    ["repaired by hand"],
    undefined,
    () => clock.now(),
    "webui",
  )).rejects.toThrow("still not established");
  expect(getTask(db, questionId!)?.status).toBe("todo");

  repaired = true;
  await submitAnswer(
    {
      db,
      pollNow() {},
      quarantineChecks: quarantineChecks({ db, harnessContainment: async () => check() }),
      landing: unusedLanding,
    },
    question!,
    ["repaired by hand"],
    "updated the pinned CLI",
    () => clock.now(),
    "webui",
  );
  expect(getTask(db, questionId!)?.status).toBe("done");
  expect(listEvents(db, questionId!).at(-1)?.payload).toMatchObject({
    kind: "quarantine_released",
    quarantine: "harnessContainment",
    value: "codex",
  });
});

it("a failed Codex Harness preflight skips that route and starts a Claude-route row in the same poll", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const started: string[] = [];
  const worker: WorkerAdapter = {
    id: "claude-agent",
    start: (task) => started.push(task.id),
    gracefulStop() {},
    checkUsage: async () => healthyUsageText(clock.now()),
  };
  const codex = registerTask(db, {
    type: "work",
    assignee: "codex-agent",
    title: "Codex head",
    purpose: "exercise Codex",
    completion_criteria: "done",
  }, clock.now(), ...HUMAN_WEBUI);
  const claude = registerTask(db, {
    type: "work",
    assignee: "claude-agent",
    title: "Claude next",
    purpose: "keep working",
    completion_criteria: "done",
  }, clock.now(), ...HUMAN_WEBUI);
  const providers = new Map<string, "openai" | "anthropic">([
    ["codex-agent", "openai"],
    ["claude-agent", "anthropic"],
  ]);
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: passthroughContainers(),
    onSpawnFailed: () => {},
    taskExecutionCandidates: (task) =>
      executionSettingsFor(db, { provider: [{ name: providers.get(task.assignee!)!, advisor: false }], tier: undefined }, task),
    harnessContainment: async (harness) =>
      harness === "codex"
        ? { available: false, reason: "Codex containment preflight: hook drift" }
        : { available: true },
  });

  await clock.advance(HOURLY);

  expect(started).toEqual([claude.id]);
  expect(getTask(db, codex.id)?.status).toBe("todo");
  const quarantine = listBoard(db).find(
    (task) => (task.question_quarantine_kind === "harnessContainment" && task.question_quarantine_value === "codex") && task.status === "todo",
  );
  expect(quarantine).toMatchObject({ question_quarantine_kind: "harnessContainment", question_quarantine_value: "codex", status: "todo" });
  scheduler.stop();
});
