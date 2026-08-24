import { expect, it } from "vitest";
import {
  CODEX_CLI_VERSION,
  type CodexCapabilityObservation,
  checkCodexCapability,
} from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import { canonicalHarness } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { registerTask, type Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { FakeClock, healthyUsageText } from "./fakes.js";

const VALID: CodexCapabilityObservation = {
  cliVersion: CODEX_CLI_VERSION,
  mcpTools: ["get_current_task", "list_agents", "complete_task", "log_decision", "decompose", "escalate"],
  skills: [],
  hooks: ["SubagentStart", "PreToolUse"],
  permissions: ["tidepool-work", "tidepool-review"],
};

it.each([
  ["version", { cliVersion: "codex-cli 0.148.0" }],
  ["tool", { mcpTools: VALID.mcpTools.slice(1) }],
  ["skill", { skills: ["openai-docs"] }],
  ["hook", { hooks: ["SubagentStart"] }],
  ["permission", { permissions: ["tidepool-work"] }],
] as const)("Codex %s surface drift fails its Harness preflight closed", async (_, changed) => {
  const capability = await checkCodexCapability(async () => ({ ...VALID, ...changed }));
  expect(capability.available).toBe(false);
  if (!capability.available) expect(capability.reason).toContain("Codex containment preflight");
});

it("a failed Codex Harness preflight skips that route and starts a Claude-route row in the same poll", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const started: string[] = [];
  const worker: WorkerAdapter = {
    id: "claude-agent",
    start: (task) => started.push(task.id),
    kill() {},
    checkUsage: async () => healthyUsageText(clock.now()),
  };
  const codex = registerTask(db, {
    type: "work",
    assignee: "codex-agent",
    title: "Codex head",
    purpose: "exercise Codex",
    completion_criteria: "done",
  }, clock.now());
  const claude = registerTask(db, {
    type: "work",
    assignee: "claude-agent",
    title: "Claude next",
    purpose: "keep working",
    completion_criteria: "done",
  }, clock.now());
  const providers = new Map<string, "openai" | "anthropic">([
    ["codex-agent", "openai"],
    ["claude-agent", "anthropic"],
  ]);
  const scheduler = startScheduler({
    db,
    clock,
    slot: new Slot(),
    worker,
    resolveHarness: (task: Task) => canonicalHarness(providers.get(task.assignee!)!),
    harnessContainment: async (harness) =>
      harness === "codex"
        ? { available: false, reason: "Codex containment preflight: permission drift" }
        : { available: true },
  });

  await clock.advance(HOURLY);

  expect(started).toEqual([claude.id]);
  expect(codex.status).toBe("todo");
  scheduler.stop();
});
