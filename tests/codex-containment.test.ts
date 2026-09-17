import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  CODEX_CLI_VERSION,
  CODEX_DEVELOPER_MARKER,
  type CodexCapabilityObservation,
  checkCodexCapability,
  observedDeveloperMarkers,
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
  closedFeatures: [
    "apps",
    "auth_elicitation",
    "browser_use",
    "browser_use_external",
    "browser_use_full_cdp_access",
    "computer_use",
    "goals",
    "image_generation",
    "in_app_browser",
    "memories",
    "plugins",
    "recommended_plugins",
    "remote_plugin",
    "skill_mcp_dependency_install",
    "skill_search",
    "tool_suggest",
    "view_image",
    "workspace_dependencies",
  ],
  developerMarkers: [CODEX_DEVELOPER_MARKER],
};

it("宣言どおりの観測は封じ込めを成立させる", async () => {
  expect(await checkCodexCapability(async () => VALID)).toEqual({ available: true });
});

it.each([
  ["version", { cliVersion: "codex-cli 0.148.0" }],
  ["tool", { mcpTools: VALID.mcpTools.slice(1) }],
  ["skill", { skills: ["openai-docs"] }],
  ["hook", { hooks: ["SubagentStart"] }],
  ["permission", { permissions: ["tidepool-work"] }],
  ["feature", { closedFeatures: VALID.closedFeatures.slice(1) }],
  // 盤面の文面が developer 層に届かなかった3つの形(ADR 0124 決定4): 鍵が無視された、
  // 別の層に載った、item の構造が変わった
  ["developer instructions (空)", { developerMarkers: [] }],
  ["developer instructions (別値)", { developerMarkers: ["some other text"] }],
  ["developer instructions (重複)", { developerMarkers: [CODEX_DEVELOPER_MARKER, CODEX_DEVELOPER_MARKER] }],
] as const)("Codex %s surface drift fails its Harness preflight closed", async (_, changed) => {
  const capability = await checkCodexCapability(async () => ({ ...VALID, ...changed }));
  expect(capability.available).toBe(false);
  if (!capability.available) expect(capability.reason).toContain("Codex containment preflight");
});

it("届かなかった理由は期待値と観測値の両方を名指す(ADR 0124 決定4)", async () => {
  const capability = await checkCodexCapability(async () => ({ ...VALID, developerMarkers: [] }));
  expect(capability.available).toBe(false);
  if (!capability.available) {
    expect(capability.reason).toContain(CODEX_DEVELOPER_MARKER);
    expect(capability.reason).toContain("observed []");
  }
});

// 実物の `codex debug prompt-input` 出力(0.147.0、preflight と同じ config 列を、
// 運用者の config から隔離した盤面所有の CODEX_HOME で叩いたもの)。
// workspace のパスだけ無害な固定値へ、marker だけ実装の定数へ置換してある。
const promptInput = (name: string) =>
  readFileSync(new URL(`fixtures/codex-prompt-input-${name}.json`, import.meta.url), "utf8");

it("prompt-input の developer item に載った marker だけを拾う(ADR 0124 決定4)", () => {
  expect(observedDeveloperMarkers(promptInput("developer-marker"))).toEqual([CODEX_DEVELOPER_MARKER]);
  expect(observedDeveloperMarkers(promptInput("no-marker"))).toEqual([]);

  // 同じ文字列が user item に載っているだけの形(別の層に載った)は観測に数えない
  const items = JSON.parse(promptInput("no-marker")) as Array<{ content: Array<{ type: string; text: string }> }>;
  items.at(-1)!.content.push({ type: "input_text", text: CODEX_DEVELOPER_MARKER });
  expect(observedDeveloperMarkers(JSON.stringify(items))).toEqual([]);
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
