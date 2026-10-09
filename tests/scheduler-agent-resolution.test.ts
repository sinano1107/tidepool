import { expect, it } from "vitest";
import { agentNeedsHuman } from "../src/agent.js";
import { openDb } from "../src/db.js";
import { InvalidAgentDefinitionError, UnknownAgentError } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { registerTask } from "../src/tasks.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { HUMAN_WEBUI } from "./harness.js";

const UNRESOLVABLE: Array<[string, (name: string) => Error]> = [
  ["UnknownAgentError", (name) => new UnknownAgentError(name)],
  ["InvalidAgentDefinitionError", (name) => new InvalidAgentDefinitionError(name, 'unknown authority profile "ghost"')],
];

// ADR 0097 決定1/3: pickup の時点で解決できない assignee は、poll を倒さず agent 名の quarantine に落とし、その head を飛ばす
it.each(UNRESOLVABLE)("先頭の assignee の候補解決が %s で倒れると、poll はその agent を quarantine し、後ろのタスクを拾う", async (_, fail) => {
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
