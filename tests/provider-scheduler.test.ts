import { afterEach, expect, it } from "vitest";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import type { ExecutionSetting } from "../src/execution-setting.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import { InvalidAgentDefinitionError, type Provider } from "../src/registry.js";
import { usagePanelText } from "./fakes.js";
import {
  api,
  bootTidepool,
  completeIntegrationReviews,
  FULL_HANDOFF,
  HOUR,
  managementMcpClient,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

/** 除外を当てる前の候補1件。この suite が言いたいのは「どの資源に当たるか」なので、
 *  entry の並びは各テストが自分で書く(#544 以降、盤面は候補の**列**を渡す)。 */
const candidate = (provider: Provider, model: string): ExecutionSetting => ({
  provider,
  model,
  effort: "high",
  advisor: undefined,
  source: { tier: "board", provider: "only" },
});

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
    taskExecutionCandidates: (task) => [
      task.assignee === "codex-agent"
        ? candidate("openai", "gpt-5.6-sol")
        : candidate("anthropic", "claude-opus-4-1"),
    ],
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
    taskExecutionCandidates: (task) => [
      candidate("openai", task.assignee === "limited-agent" ? "gpt-limited" : "gpt-healthy"),
    ],
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
    taskExecutionCandidates: (task) => [
      task.assignee === "codex-agent"
        ? candidate("openai", "gpt-5.6-sol")
        : candidate("anthropic", "claude-opus-4-1"),
    ],
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
    taskExecutionCandidates: () => [candidate("openai", "gpt-5.6-sol")],
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
    taskExecutionCandidates: (task) => [
      task.assignee === "claude-agent"
        ? candidate("anthropic", "claude-opus-4-1")
        : candidate("openai", "gpt-5.6-sol"),
    ],
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
  await completeIntegrationReviews(t, firstOpenai.id);
  const secondOpenai = await registerWork(t, "OpenAI still flows next poll", undefined, undefined, "codex-agent");
  await t.clock.advance(HOUR);
  expect(t.worker.started.filter((task) => task.type === "work").map((task) => task.id)).toEqual([firstOpenai.id, secondOpenai.id]);
});

it("model-specific window が外すのは当たった task だけ —— 同じ agent の要求なしタスクは走り続ける(ADR 0110 決定3)", async () => {
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
          name: "primary",
          model: "gpt-frontier",
          usedPercent: 50,
          durationMs: 5 * HOUR,
          resetsAt: new Date(now.getTime() + 4 * HOUR).toISOString(),
        },
      ],
    }),
    // #543 以降、model は agent ではなく **task の要求**で決まる
    taskExecutionCandidates: (task) => [
      candidate("openai", task.tier === "frontier" ? "gpt-frontier" : "gpt-economy"),
    ],
  });
  const requested = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "frontier を要求して窓に当たる",
      purpose: "p",
      completion_criteria: "c",
      assignee: "sole-agent",
      tier: "frontier",
    })
  ).json;
  const plain = await registerWork(t, "要求なしなので別のモデルで走る", undefined, undefined, "sole-agent");

  await t.clock.advance(HOUR);
  // agent ごと外すと plain も止まる —— 外れるのは窓に当たった task だけ
  expect(t.worker.started.map((task) => task.id)).toEqual([plain.id]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect(queue.find((task) => task.id === requested.id)?.status).toBe("skipped");
});

/* ------------------------------------------------------------------ *
 * entry 配列(issue #544): 温存中の Provider を飛ばして他所へ流れる
 * ------------------------------------------------------------------ */

/** session/week は健全なまま、anthropic の fable 窓だけが超過している観測
 *  (ADR 0030 / throttle.test.ts の同じ数字)。 */
function fableOverPace(now: Date): string {
  return usagePanelText({
    session: { percent: 0, resetsAt: new Date(now.getTime() + 3 * HOUR) },
    week: { percent: 5, resetsAt: new Date(now.getTime() + 2 * 24 * HOUR) },
    fable: { percent: 84, resetsAt: new Date(now.getTime() + 12 * HOUR) },
  });
}

const healthyOpenai = async (now: Date): Promise<CodexAppServerProbeResult> => ({
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
  ],
});

it("anthropic を温存中でも openai entry を持つ agent の task は走り、単一 entry の task だけが skipped —— queue 表示と pickup の判定は同じ式(#543 申し送り / ADR 0110 決定5)", async () => {
  // 候補は**実物の selector**(盤面の表 + Provider 順位)から作る —— fake が
  // 順位や model を自前で持つと、ここで測れるのは fake の側だけになる
  const entries = (...names: string[]) => ({
    provider: names.map((name) => ({ name, advisor: false })),
    tier: undefined,
  });
  t = await bootTidepool({
    openaiUsage: healthyOpenai,
    taskExecutionCandidates: (task) =>
      executionSettingsFor(
        t.db,
        task.assignee === "multi-agent" ? entries("anthropic", "openai") : entries("anthropic"),
        task,
      ),
  });
  const frontier = async (title: string, assignee: string) =>
    (
      await api(t.baseUrl, "POST", "/api/tasks", {
        type: "work",
        title,
        purpose: "p",
        completion_criteria: "c",
        assignee,
        tier: "frontier",
      })
    ).json;
  // 先頭から: 単一 entry の frontier(全 entry 除外)→ 複数 entry の frontier →
  // 要求なし(同じ agent だが economy の行なので窓に当たらない)
  const blocked = await frontier("anthropic しか持たない frontier", "solo-agent");
  const multi = await frontier("openai へ流れる frontier", "multi-agent");
  const plain = await registerWork(t, "要求なしなので別のモデル", undefined, undefined, "solo-agent");

  t.worker.scriptUsage(fableOverPace(t.clock.now()));
  await t.clock.advance(HOUR);

  // 温存中の anthropic を飛ばして openai の entry で走る。選ばれた設定は
  // adapter へそのまま運ばれ、実 adapter はこれを worker_spawned に刻む
  expect(t.worker.started.map((task) => task.id)).toEqual([multi.id]);
  expect(t.worker.startedSettings[0]).toMatchObject({
    provider: "openai",
    model: "gpt-6-astra",
    source: { tier: "task", provider: "rank" },
  });

  // queue の skipped 表示は scheduler のゲートと同じ1つの式から出る —— 要求を持つ
  // task だけが skipped で、同じ agent の要求なし task は候補のまま残る
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect({
    blocked: queue.find((task) => task.id === blocked.id)?.status,
    multi: queue.find((task) => task.id === multi.id)?.status,
    plain: queue.find((task) => task.id === plain.id)?.status,
  }).toEqual({ blocked: "skipped", multi: "in_progress", plain: "todo" });
});

it("全 entry が除外された行は Pickable head ではない —— 下の行の ↑ を飲まない(ADR 0110 決定3 / CONTEXT.md「Pickable head」)", async () => {
  t = await bootTidepool({
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, { provider: [{ name: "anthropic", advisor: false }], tier: undefined }, task),
  });
  // 上の行は frontier を要求するので fable 行に解決され、唯一の entry が
  // 温存中の窓に当たる。下の行は要求なし = economy 行なのでその窓に当たらない
  const blocked = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "温存中の fable 窓に当たる frontier",
      purpose: "p",
      completion_criteria: "c",
      tier: "frontier",
    })
  ).json;

  t.worker.scriptUsage(fableOverPace(t.clock.now()));
  await t.clock.advance(HOUR);
  // この poll では候補が blocked しか無く、全 entry 除外なので何も走らない
  expect(t.worker.started).toEqual([]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect(queue.find((task) => task.id === blocked.id)?.status).toBe("skipped");

  // 素の先頭は blocked のままだが、候補の先頭は下の runnable。1回の ↑ が空振り
  // しないことが、Pickable head が entry 集合で判定されている証拠である
  const runnable = await registerWork(t, "要求なしなので別の行で走る");
  await api(t.baseUrl, "POST", `/api/tasks/${runnable.id}/move`, { after: null });
  expect(t.worker.started.map((task) => task.id)).toEqual([runnable.id]);
});

it("候補の解決が定義違反で倒れても queue の読み口は 200 を返す —— 1行のドリフトでキュー全体を落とさない(#544)", async () => {
  t = await bootTidepool({
    taskExecutionCandidates: (task) => {
      // registry が後から壊れた agent(登録時には成立していた)。scheduler は
      // 同じ例外を自分で捕まえて quarantine するが、読み口は投げてはならない
      if (task.assignee === "drifted-agent") {
        throw new InvalidAgentDefinitionError("drifted-agent", "unknown provider \"typo\"");
      }
      return executionSettingsFor(
        t.db,
        { provider: [{ name: "anthropic", advisor: false }], tier: undefined },
        task,
      );
    },
  });
  const drifted = await registerWork(t, "定義が壊れた agent の行", undefined, undefined, "drifted-agent");

  const queue = await api(t.baseUrl, "GET", "/api/queue");
  expect(queue.status).toBe(200);
  // 判定できないものを skipped とは言わない —— quarantine の枝がその行を答える
  expect((queue.json.tasks as any[]).find((task) => task.id === drifted.id)?.status).toBe("todo");

  const mcp = await managementMcpClient(t.baseUrl);
  try {
    const result = (await mcp.callTool({ name: "list_queue", arguments: {} })) as {
      content: { text: string }[];
    };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.tasks.find((task: any) => task.id === drifted.id).status).toBe("todo");
  } finally {
    await mcp.close();
  }
});

/* ------------------------------------------------------------------ *
 * 表の穴は除外、優先順位は候補を並べる鍵(ADR 0114、issue #562)
 * ------------------------------------------------------------------ */

/** 候補は**実物の selector**(盤面の表 + Provider 順位)から、agent の entry は
 *  assignee 名で引く。 */
function boardWithEntries(agents: Record<string, string[]>): Parameters<typeof bootTidepool>[0] {
  return {
    openaiUsage: healthyOpenai,
    taskExecutionCandidates: (task) =>
      executionSettingsFor(
        t.db,
        { provider: (agents[task.assignee ?? ""] ?? ["anthropic"]).map((name) => ({ name, advisor: false })), tier: undefined },
        task,
      ),
  };
}

const requested = async (title: string, assignee: string, request: Record<string, string>) =>
  (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title,
      purpose: "p",
      completion_criteria: "c",
      assignee,
      ...request,
    })
  ).json;

it("要求ティアの行を持たない Provider しか entry に無い agent の task は queue で skipped、pickup で spawn されない —— 表の穴は spawn 失敗ではなく除外(ADR 0114 決定3)", async () => {
  t = await bootTidepool(boardWithEntries({ "kimi-agent": ["moonshot"] }));
  const holed = await requested("moonshot に frontier 級は無い", "kimi-agent", { tier: "frontier" });
  const plain = await registerWork(t, "盤面既定の economy なら kimi-k3 で走る", undefined, undefined, "kimi-agent");

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((task) => task.id)).toEqual([plain.id]);
  expect(t.worker.startedSettings[0]).toMatchObject({ provider: "moonshot", model: "kimi-k3[1m]" });
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect(queue.find((task) => task.id === holed.id)?.status).toBe("skipped");
});

it("entry が複数で片方の Provider に行が無ければ、もう片方の entry で走る —— 表の穴は他の候補を巻き込まない", async () => {
  t = await bootTidepool(boardWithEntries({ "kimi-or-codex": ["moonshot", "openai"] }));
  const task = await requested("frontier は openai の行で", "kimi-or-codex", { tier: "frontier" });

  await t.clock.advance(HOUR);
  expect(t.worker.started.map((started) => started.id)).toEqual([task.id]);
  expect(t.worker.startedSettings[0]).toMatchObject({ provider: "openai", model: "gpt-6-astra" });
});

it("cost の task は要求ティアの最安の行で spawn され、Provider の出所は cost —— quality(既定)なら同じ agent でも Provider 順位の行(ADR 0114 決定4)", async () => {
  t = await bootTidepool(boardWithEntries({ "either-agent": ["anthropic", "openai"] }));
  const cheap = await requested("standard を最安で", "either-agent", { tier: "standard", priority: "cost" });
  const ranked = await requested("standard を順位で", "either-agent", { tier: "standard" });

  await t.clock.advance(HOUR);
  expect(t.worker.startedSettings[0]).toMatchObject({
    provider: "openai",
    model: "gpt-5.6-sol",
    source: { tier: "task", provider: "cost" },
  });
  const client = await mcpClient(t.mcpBaseUrl, cheap.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeIntegrationReviews(t, cheap.id);
  await t.clock.advance(HOUR);
  expect(t.worker.started.filter((task) => task.type === "work").map((task) => task.id)).toEqual([cheap.id, ranked.id]);
  expect(t.worker.startedSettings.at(-1)).toMatchObject({
    provider: "anthropic",
    model: "opus",
    source: { tier: "task", provider: "rank" },
  });
});
