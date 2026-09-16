import { afterEach, expect, it, vi } from "vitest";
import {
  CODEX_CLI_VERSION,
  CODEX_FEATURE_SNAPSHOT,
  type CodexCapabilityObservation,
  checkCodexCapability,
} from "../src/codex-worker.js";
import { listEvents } from "../src/events.js";
import { harnessContainmentPickupBlocked } from "../src/harness-containment.js";
import { submitAnswer } from "../src/human-verbs.js";
import { canonicalHarness } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { getTask, listBoard, registerTask, type Task } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import { FakeClock, healthyUsageText, passthroughContainers, unusedLanding } from "./fakes.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const VALID: CodexCapabilityObservation = {
  cliVersion: CODEX_CLI_VERSION,
  mcpTools: ["get_current_task", "list_agents", "complete_task", "log_decision", "decompose", "escalate", "declare_premise_breach", "continue_decomposition", "redecompose", "record_knowledge", "define_memory_branch", "browse_memory", "search_memory", "read_memory", "propose_from_objection"],
  skills: [],
  hooks: ["SubagentStart", "PreToolUse"],
  permissions: ["tidepool-work", "tidepool-review"],
  features: CODEX_FEATURE_SNAPSHOT,
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

it("観測した feature 面が期待 snapshot と全量一致すれば preflight は成立する", async () => {
  const capability = await checkCodexCapability(async () => VALID);
  expect(capability.available).toBe(true);
});

it.each([
  [
    "ベンダーが増やした未知の名前",
    { ...CODEX_FEATURE_SNAPSHOT, vendor_new_thing: "true" },
    "vendor_new_thing (expected absent, observed true)",
  ],
  [
    "既存の名前が false から true へ転ぶ",
    { ...CODEX_FEATURE_SNAPSHOT, code_mode: "true" },
    "code_mode (expected false, observed true)",
  ],
  [
    "期待していた名前が面から消える",
    Object.fromEntries(Object.entries(CODEX_FEATURE_SNAPSHOT).filter(([name]) => name !== "computer_use")),
    "computer_use (expected false, observed absent)",
  ],
] as const)("feature 面の%sは preflight を倒し、reason は差分だけを載せる", async (_, features, expected) => {
  const capability = await checkCodexCapability(async () => ({ ...VALID, features }));
  expect(capability.available).toBe(false);
  if (!capability.available) {
    expect(capability.reason).toContain(expected);
    expect(capability.reason).not.toContain("apply_patch_freeform");
  }
});

it("a failed Codex Harness preflight skips that route and starts a Claude-route row in the same poll", async () => {
  t = await bootTidepool();
  const db = t.db;
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
    containers: passthroughContainers(),
    onSpawnFailed: () => {},
    resolveHarness: (task: Task) => canonicalHarness(providers.get(task.assignee!)!),
    harnessContainment: async (harness) =>
      harness === "codex"
        ? { available: false, reason: "Codex containment preflight: permission drift" }
        : { available: true },
  });

  await clock.advance(HOURLY);

  expect(started).toEqual([claude.id]);
  expect(codex.status).toBe("todo");
  const quarantine = listBoard(db).find(
    (task) => task.question_quarantine_harness === "codex" && task.status === "todo",
  );
  expect(quarantine).toMatchObject({ question_quarantine_harness: "codex", status: "todo" });
  scheduler.stop();
});

it("a Harness quarantine answer is accepted only after the same live check recovers", async () => {
  t = await bootTidepool();
  const db = t.db;
  const clock = new FakeClock();
  let repaired = false;
  const check = async () => repaired
    ? { available: true as const }
    : { available: false as const, reason: "permission canary failed" };

  expect(await harnessContainmentPickupBlocked(db, "codex", check, clock.now())).toBe(true);
  const questionId = listBoard(db).find(
    (task) => task.question_quarantine_harness === "codex",
  )?.id;
  expect(questionId).toBeDefined();
  const question = getTask(db, questionId!);
  expect(question).toBeDefined();
  await expect(submitAnswer(
    {
      db,
      pollNow() {},
      harnessContainment: async () => check(),
      landing: unusedLanding,
    },
    question!,
    ["repaired by hand"],
    undefined,
    () => clock.now(),
  )).rejects.toThrow("still not established");
  expect(getTask(db, questionId!)?.status).toBe("todo");

  repaired = true;
  await submitAnswer(
    {
      db,
      pollNow() {},
      harnessContainment: async () => check(),
      landing: unusedLanding,
    },
    question!,
    ["repaired by hand"],
    "updated the pinned CLI",
    () => clock.now(),
  );
  expect(getTask(db, questionId!)?.status).toBe("done");
  expect(listEvents(db, questionId!).at(-1)?.payload).toMatchObject({
    kind: "harness_reinstated",
    harness: "codex",
  });
});

it("the public queue and answer routes expose a durable Harness-scoped stop without halting another route", async () => {
  let codexHealthy = false;
  const tidepool = await bootTidepool({
    resolveHarness: (task) => task.assignee === "codex-agent" ? "codex" : "claude-code",
    harnessContainment: async (harness) =>
      harness === "codex" && !codexHealthy
        ? { available: false, reason: "permission canary failed" }
        : { available: true },
    agentsUsingHarnesses: (harnesses) =>
      harnesses.includes("codex") ? ["codex-agent"] : [],
  });
  try {
    const codex = await registerWork(
      tidepool,
      "Codex waits for its Harness",
      undefined,
      undefined,
      "codex-agent",
    );
    const claude = await registerWork(
      tidepool,
      "Claude keeps flowing",
      undefined,
      undefined,
      "claude-agent",
    );
    await api(tidepool.baseUrl, "POST", `/api/tasks/${claude.id}/move`, { after: null });
    await vi.waitFor(() => expect(tidepool.worker.started.map((task) => task.id)).toEqual([claude.id]));

    const queue = (await api(tidepool.baseUrl, "GET", "/api/queue")).json as { tasks: any[] };
    expect(queue.tasks.find((task) => task.id === codex.id)?.status).toBe("skipped");
    const tasks = (await api(tidepool.baseUrl, "GET", "/api/tasks")).json as any[];
    const question = tasks.find((task) => task.question_quarantine_harness === "codex");
    expect(question?.question_items[0].options).toEqual(["repaired by hand"]);

    const refused = await api(tidepool.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
      answers: ["repaired by hand"],
    });
    expect(refused.status).toBe(409);
    codexHealthy = true;
    const accepted = await api(tidepool.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
      answers: ["repaired by hand"],
    });
    expect(accepted.status).toBe(200);
  } finally {
    await tidepool.stop();
  }
});
