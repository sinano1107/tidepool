import { expect, it } from "vitest";
import { agentNeedsHuman } from "../src/agent.js";
import { openDb } from "../src/db.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { registerTask } from "../src/tasks.js";
import { FakeClock, fakeContainers, healthyOpenai, noRetrospectiveCalls, ScriptedWorker, UNRESOLVABLE_AGENT } from "./fakes.js";
import { executionSetting, HUMAN_WEBUI } from "./harness.js";

// ADR 0097 決定1/3: pickup の時点で解決できない assignee は、poll を倒さず agent 名の quarantine に落とし、その head を飛ばす
it.each(UNRESOLVABLE_AGENT)("先頭の assignee の候補解決が %s で倒れると、poll はその agent を quarantine し、後ろのタスクを拾う", async (_, fail) => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const candidates = implicitTaskExecutionCandidates(db);
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    taskExecutionCandidates: (task) => {
      if (task.assignee === "drifted") throw fail("drifted");
      return candidates(task);
    },
  });

  registerTask(
    db,
    { type: "work", title: "drifted head", purpose: "p", completion_criteria: "c", assignee: "drifted" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  const behind = registerTask(
    db,
    { type: "work", title: "behind", purpose: "p", completion_criteria: "c" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  await clock.advance(HOURLY);

  expect(agentNeedsHuman(db, "drifted")).toBe(true);
  expect(worker.started.map((t) => t.id)).toEqual([behind.id]);
  scheduler.stop();
});

// ADR 0184 決定3: openai を初めて observed で観測した直後の引き直しも、1度目と同じ扱いを通る(issue #1713)
it.each(UNRESOLVABLE_AGENT)("openai の観測後に引き直した候補解決が %s で倒れても、poll は reject せずその agent を quarantine し、後ろのタスクを拾う", async (_, fail) => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const candidates = implicitTaskExecutionCandidates(db);
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  let driftedCalls = 0;
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    openaiUsage: healthyOpenai,
    taskExecutionCandidates: (task) => {
      if (task.assignee !== "drifted") return candidates(task);
      driftedCalls++;
      if (driftedCalls === 1) return [executionSetting("openai", "gpt-5.6-sol")];
      throw fail("drifted");
    },
  });

  registerTask(
    db,
    { type: "work", title: "drifted head", purpose: "p", completion_criteria: "c", assignee: "drifted" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  const behind = registerTask(
    db,
    { type: "work", title: "behind", purpose: "p", completion_criteria: "c" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  await clock.advance(HOURLY);
  // unhandledRejection は reject の後の macrotask で届く
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onRejection);

  expect(rejections).toEqual([]);
  expect(driftedCalls).toBe(2);
  expect(agentNeedsHuman(db, "drifted")).toBe(true);
  expect(worker.started.map((t) => t.id)).toEqual([behind.id]);
  scheduler.stop();
});

it("openai の観測後に引き直した候補解決が解決できない agent 以外の例外で倒れたら、その例外は poll の外へ伝わる", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const failure = new Error("registry read failed");
  const raised = new Promise((resolve) => process.once("unhandledRejection", resolve));
  let calls = 0;
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    openaiUsage: healthyOpenai,
    taskExecutionCandidates: () => {
      calls++;
      if (calls === 1) return [executionSetting("openai", "gpt-5.6-sol")];
      throw failure;
    },
  });

  registerTask(db, { type: "work", title: "head", purpose: "p", completion_criteria: "c" }, clock.now(), ...HUMAN_WEBUI);
  await clock.advance(HOURLY);

  expect(await raised).toBe(failure);
  expect(worker.started).toEqual([]);
  scheduler.stop();
});
