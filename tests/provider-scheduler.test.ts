import { afterEach, expect, it } from "vitest";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import { usagePanelText } from "./fakes.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("先頭 Provider が throttle 中でも同じ poll で次を選び、回復後は元の順序へ戻り、実行中 worker を止めない", async () => {
  let openaiThrottled = true;
  const openaiUsage = async (now: Date): Promise<CodexAppServerProbeResult> => ({
    status: "observed",
    provider: "openai",
    cliVersion: "codex-cli 0.147.0",
    plan: "plus",
    windows: [
      {
        name: "primary",
        model: null,
        usedPercent: openaiThrottled ? 50 : 0,
        durationMs: 5 * HOUR,
        resetsAt: new Date(now.getTime() + 4 * HOUR).toISOString(),
      },
      {
        name: "secondary",
        model: null,
        usedPercent: 0,
        durationMs: 7 * 24 * HOUR,
        resetsAt: new Date(now.getTime() + 6 * 24 * HOUR).toISOString(),
      },
    ],
  });
  t = await bootTidepool({
    openaiUsage,
    resolveUsageResource: (task) =>
      task.assignee === "codex-agent"
        ? { provider: "openai", model: "gpt-5.6-sol" }
        : { provider: "anthropic", model: "claude-opus-4-1" },
    agentsSpeakingProviders: (providers) =>
      providers.includes("openai") ? ["codex-agent"] : ["claude-agent"],
  });
  const openai = await registerWork(t, "first, but throttled", undefined, undefined, "codex-agent");
  const anthropic = await registerWork(t, "second and healthy", undefined, undefined, "claude-agent");

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([anthropic.id]);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.tasks.map((task: any) => task.id)).toEqual([
    openai.id,
    anthropic.id,
  ]);
  const providerUsage = (await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage;
  expect(providerUsage.find((usage: any) => usage.provider === "openai").windows[0]).toMatchObject({
    window: "primary",
    model: null,
    throttled: true,
  });

  openaiThrottled = false;
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([anthropic.id]);
  expect(t.worker.gracefulStops).toEqual([]);

  const client = await mcpClient(t.mcpBaseUrl, anthropic.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([anthropic.id, openai.id]);
});

it("model-specific window は同じ OpenAI Provider の対象 model だけを skipped にする", async () => {
  t = await bootTidepool({
    openaiUsage: async (now) => ({
      status: "observed",
      provider: "openai",
      cliVersion: "codex-cli 0.147.0",
      plan: "plus",
      windows: [
        {
          name: "primary",
          model: null,
          usedPercent: 0,
          durationMs: 5 * HOUR,
          resetsAt: new Date(now.getTime() + 4 * HOUR).toISOString(),
        },
        {
          name: "secondary",
          model: null,
          usedPercent: 0,
          durationMs: 7 * 24 * HOUR,
          resetsAt: new Date(now.getTime() + 6 * 24 * HOUR).toISOString(),
        },
        {
          name: "primary",
          model: "gpt-limited",
          usedPercent: 50,
          durationMs: 5 * HOUR,
          resetsAt: new Date(now.getTime() + 4 * HOUR).toISOString(),
        },
      ],
    }),
    resolveUsageResource: (task) => ({
      provider: "openai",
      model: task.assignee === "limited-agent" ? "gpt-limited" : "gpt-healthy",
    }),
    agentsUsingUsageResources: (resources) =>
      resources.some((resource) => resource.provider === "openai" && resource.model === "gpt-limited")
        ? ["limited-agent"]
        : [],
  });
  const limited = await registerWork(t, "limited model first", undefined, undefined, "limited-agent");
  const healthy = await registerWork(t, "healthy model second", undefined, undefined, "healthy-agent");

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([healthy.id]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect(queue.find((task) => task.id === limited.id)?.status).toBe("skipped");
  expect(queue.find((task) => task.id === healthy.id)?.status).toBe("in_progress");
});

it("OpenAI usage が観測不能なら question を立てず OpenAI だけ fail-closed にして同じ poll の次 Provider を選ぶ", async () => {
  t = await bootTidepool({
    openaiUsage: async () => ({
      status: "unobservable",
      provider: "openai",
      cliVersion: "codex-cli 0.147.0",
      reason: "required App Server method or response schema drifted",
    }),
    resolveUsageResource: (task) =>
      task.assignee === "codex-agent"
        ? { provider: "openai", model: "gpt-5.6-sol" }
        : { provider: "anthropic", model: "claude-opus-4-1" },
    agentsSpeakingProviders: (providers) =>
      providers.includes("openai") ? ["codex-agent"] : ["claude-agent"],
  });
  const codex = await registerWork(t, "unobservable OpenAI", undefined, undefined, "codex-agent");
  const claude = await registerWork(t, "healthy Anthropic", undefined, undefined, "claude-agent");

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([claude.id]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect(queue.find((task) => task.id === codex.id)?.status).toBe("skipped");
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  expect(tasks.filter((task) => task.question_quarantine_provider_auth === "openai")).toEqual([]);
  const openai = (await api(t.baseUrl, "GET", "/api/pause")).json.providerUsage.find(
    (usage: any) => usage.provider === "openai",
  );
  expect(openai).toMatchObject({
    status: "unobservable",
    cliVersion: "codex-cli 0.147.0",
    reason: "required App Server method or response schema drifted",
  });
});

it("Provider/window ごとの catch-up timer は別 window の遅い reset に上書きされない", async () => {
  let healthy = false;
  const primaryReset = new Date(5 * HOUR);
  const secondaryReset = new Date(10 * HOUR);
  t = await bootTidepool({
    openaiUsage: async () => ({
      status: "observed",
      provider: "openai",
      cliVersion: "codex-cli 0.147.0",
      plan: "plus",
      windows: [
        {
          name: "primary",
          model: null,
          usedPercent: healthy ? 0 : 50,
          durationMs: 5 * HOUR,
          resetsAt: primaryReset.toISOString(),
        },
        {
          name: "secondary",
          model: null,
          usedPercent: healthy ? 0 : 50,
          durationMs: 10 * HOUR,
          resetsAt: secondaryReset.toISOString(),
        },
      ],
    }),
    resolveUsageResource: () => ({ provider: "openai", model: "gpt-5.6-sol" }),
    agentsSpeakingProviders: () => ["codex-agent"],
  });
  const task = await registerWork(t, "wakes at primary catch-up", undefined, undefined, "codex-agent");

  await t.clock.advance(3 * HOUR);
  expect(t.worker.started).toEqual([]);
  await t.clock.advance(0.4 * HOUR);
  healthy = true;
  await t.clock.advance(0.1 * HOUR);

  expect(t.worker.started.map((started) => started.id)).toEqual([task.id]);
});

it("Anthropic throttle は legacy board halt を残さず同じ poll と次 poll の OpenAI を流す", async () => {
  t = await bootTidepool({
    openaiUsage: async (now) => ({
      status: "observed",
      provider: "openai",
      cliVersion: "codex-cli 0.147.0",
      plan: "plus",
      windows: [
        {
          name: "primary",
          model: null,
          usedPercent: 0,
          durationMs: 5 * HOUR,
          resetsAt: new Date(now.getTime() + 4 * HOUR).toISOString(),
        },
        {
          name: "secondary",
          model: null,
          usedPercent: 0,
          durationMs: 7 * 24 * HOUR,
          resetsAt: new Date(now.getTime() + 6 * 24 * HOUR).toISOString(),
        },
      ],
    }),
    resolveUsageResource: (task) =>
      task.assignee === "claude-agent"
        ? { provider: "anthropic", model: "claude-opus-4-1" }
        : { provider: "openai", model: "gpt-5.6-sol" },
    agentsSpeakingProviders: (providers) =>
      providers.includes("anthropic") ? ["claude-agent"] : ["codex-agent"],
  });
  t.worker.scriptUsage(usagePanelText({
    session: { percent: 50, resetsAt: new Date(5 * HOUR) },
    week: { percent: 0, resetsAt: new Date(7 * 24 * HOUR) },
  }));
  await registerWork(t, "Anthropic waits", undefined, undefined, "claude-agent");
  const firstOpenai = await registerWork(t, "OpenAI flows", undefined, undefined, "codex-agent");

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([firstOpenai.id]);
  expect((await api(t.baseUrl, "GET", "/api/pause")).json.halts).toEqual([]);

  const client = await mcpClient(t.mcpBaseUrl, firstOpenai.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  const secondOpenai = await registerWork(t, "OpenAI still flows next poll", undefined, undefined, "codex-agent");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([firstOpenai.id, secondOpenai.id]);
});
