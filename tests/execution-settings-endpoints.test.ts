import { afterEach, expect, it, vi } from "vitest";
import type { AgentView } from "../src/agent-create.js";
import { listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor, SEED_EXECUTION_SETTINGS } from "../src/execution-setting.js";
import { PROVIDER_VALUES, type Provider } from "../src/provider.js";
import { openQuarantineQuestion, registerQuarantine, tableRowValue } from "../src/quarantine.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { SEED_TIERS } from "../src/tier.js";
import { healthyOpenai } from "./fakes.js";
import {
  api,
  bootTidepool,
  completeIntegrationReviews,
  completeMetaReviews,
  FULL_HANDOFF,
  HOUR,
  managementMcpClient,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("GET /api/settings/execution は種の表と盤面既定(advisor の上限 off・Provider 順位は宣言順・優先順位 quality)と選択肢を返す(ADR 0110 決定5 / ADR 0208 決定1)", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/execution");
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    table: [...SEED_EXECUTION_SETTINGS]
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
      .map((row) => ({ ...row, quarantine_question_id: null })),
    advisorCeiling: "off",
    providerRank: [...PROVIDER_VALUES],
    priority: "quality",
    learnerPromoted: false,
    defaultTier: "economy",
    judgementTier: "frontier",
    providers: [
      { value: "anthropic", label: "anthropic — Claude models, Anthropic billing" },
      { value: "moonshot", label: "moonshot — Kimi models, Moonshot Platform billing" },
      { value: "openai", label: "openai — Codex models, OpenAI billing" },
    ],
    tiers: SEED_TIERS,
    priorities: ["quality", "cost"],
    advisorCeilings: ["off", "sonnet", "opus", "fable", "fable_then_opus"],
  });
});

/** 盤面境界の読み口(GET)から見た状態。選択肢は落とす(段の一覧は状態なので残す)。 */
const state = async () => {
  const { providers: _p, priorities: _q, advisorCeilings: _a, ...rest } = (await api(t.baseUrl, "GET", "/api/settings/execution")).json;
  return rest;
};

it("POST /api/settings/execution は1つの変更を受け、Provider 順位・優先順位・advisor の上限は GET に反映される", async () => {
  t = await bootTidepool();
  for (const change of [
    { setting: "provider_rank", value: ["openai", "anthropic", "moonshot"] },
    { setting: "priority", value: "cost" },
    { setting: "advisor_ceiling", value: "opus" },
    { setting: "judgement_tier", value: "standard" },
  ]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", change)).status).toBe(200);
  }
  expect(await state()).toMatchObject({
    providerRank: ["openai", "anthropic", "moonshot"],
    priority: "cost",
    advisorCeiling: "opus",
    judgementTier: "standard",
  });
});

it("表の行は (provider, model, effort) を鍵に追加・編集(key つき)・削除でき、同じ provider × tier に複数行を置ける(ADR 0114 決定2 / ADR 0200 決定5)", async () => {
  t = await bootTidepool();
  const haiku = { provider: "anthropic", tier: "economy", model: "claude-haiku-4-5", effort: "low", price_in: 1, price_out: 5 };
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: haiku })).status).toBe(200);
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", key: { ...haiku, effort: "low" }, row: { ...haiku, effort: "high" } })).status).toBe(200);
  expect(
    (await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "openai", model: "gpt-6-astra", effort: "high" })).status,
  ).toBe(200);

  const { table } = await state();
  expect(table.filter((row: any) => row.provider === "anthropic" && row.tier === "economy")).toEqual([
    { ...haiku, effort: "high", quarantine_question_id: null },
    { provider: "anthropic", tier: "economy", model: "claude-sonnet-5-5", effort: "high", price_in: 2, price_out: 10, quarantine_question_id: null },
  ]);
  expect(table.find((row: any) => row.model === "gpt-6-astra")).toBeUndefined();
});

it("ある provider × tier の行を全部消すことは許される —— その Provider はそのティアの task で除外されるだけ(ADR 0114 決定3)", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "moonshot", model: "kimi-k3[1m]", effort: "high" });
  expect(res.status).toBe(200);
  expect((await state()).table.some((row: any) => row.provider === "moonshot")).toBe(false);
});

it("不正値(未知の Provider / ティア / 優先順位、負の価格、順列でない Provider 順位)は 400 で弾かれ、設定は変わらない", async () => {
  t = await bootTidepool();
  const before = await state();
  const row = { provider: "anthropic", tier: "economy", model: "claude-haiku-4-5", effort: "high", price_in: 1, price_out: 5 };
  for (const bad of [
    { setting: "row", row: { ...row, provider: "moonshto" } },
    { setting: "row", row: { ...row, tier: "premium" } },
    { setting: "row", row: { ...row, price_in: -1 } },
    { setting: "row", row: { ...row, price_out: -0.5 } },
    { setting: "delete_row", provider: "typo", model: "sonnet", effort: "high" },
    { setting: "priority", value: "speed" },
    { setting: "provider_rank", value: ["anthropic", "openai"] }, // moonshot が欠ける → indexOf -1 で先頭に来てしまう
    { setting: "provider_rank", value: ["anthropic", "anthropic", "openai"] },
    { setting: "provider_rank", value: ["anthropic", "openai", "moonshot", "openai"] },
    { setting: "tier", value: "frontier" }, // ティアの既定は設定ではない(BOARD_DEFAULT_TIER)
    { setting: "judgement_tier", value: "premium" }, // ティア語彙の外(issue #914)
  ]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", bad)).status, JSON.stringify(bad)).toBe(400);
  }
  expect(await state()).toEqual(before);
});

it("advisor の上限は settings タブと管理MCP の両方の扉で検証を通った値だけが書かれ、拒まれた値は設定を変えない(ADR 0208 決定1)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const viaMcp = async (change: object) => (await client.callTool({ name: "change_execution_settings", arguments: { change } })) as any;
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "advisor_ceiling", value: "opus" })).status).toBe(200);
    expect((await viaMcp({ setting: "advisor_ceiling", value: "fable_then_opus" })).isError).not.toBe(true);
    expect((await state()).advisorCeiling).toBe("fable_then_opus");
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "advisor_ceiling", value: "fable_then_opus" })).status).toBe(200);
    const bad = { setting: "advisor_ceiling", value: true };
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", bad)).status).toBe(400);
    expect((await viaMcp(bad)).isError).toBe(true);
  } finally {
    await client.close();
  }
  expect((await state()).advisorCeiling).toBe("fable_then_opus");
});

it("anthropic の alias の行は settings タブと管理MCP の両方の扉で拒まれ表は変わらない —— 具体 id の行と openai の行は通る(ADR 0182 決定1)", async () => {
  t = await bootTidepool();
  const before = await state();
  const row = (provider: string, model: string) => ({ setting: "row", row: { provider, tier: "standard", model, effort: "high", price_in: 5, price_out: 25 } });

  const refused = await api(t.baseUrl, "POST", "/api/settings/execution", row("anthropic", "opus"));
  expect(refused.status).toBe(400);
  expect(refused.json.error).toContain("concrete model id");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const viaMcp = (await client.callTool({ name: "change_execution_settings", arguments: { change: row("anthropic", "opus") } })) as any;
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.content[0].text).toContain("concrete model id");
    expect(await state()).toEqual(before);

    const opusKey = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { ...row("anthropic", "claude-opus-5-5"), key: opusKey })).status).toBe(200);
    expect(((await client.callTool({ name: "change_execution_settings", arguments: { change: row("openai", "gpt-5.7-sol") } })) as any).isError).not.toBe(true);
  } finally {
    await client.close();
  }
  expect((await state()).table.map((r: any) => r.model)).toEqual(expect.arrayContaining(["claude-opus-5-5", "gpt-5.7-sol"]));
});

/** task が pickup されたときの実行設定(設定の変更は routing meta-review の材料なので、それが先に slot を取りうる)。 */
const settingsOf = (taskId: string) => t.worker.startedSettings[t.worker.started.findIndex((task) => task.id === taskId)];

/** 候補は**実物の selector**(盤面の表 + 盤面設定)から。 */
const boardWith = (entries: string[]): Parameters<typeof bootTidepool>[0] => ({
  openaiUsage: healthyOpenai,
  taskExecutionCandidates: (task) =>
    executionSettingsFor(t.db, { provider: entries.map((name) => ({ name, advisor: false })), tier: undefined }, task),
});

it("Provider 順位の変更は次の pickup から効く —— 「今週は Claude を残して Codex 優先」(ADR 0110 決定5)", async () => {
  t = await bootTidepool(boardWith(["anthropic", "openai"]));
  const first = await registerWork(t, "before the rank change");
  await t.clock.advance(HOUR);
  expect(t.worker.startedSettings[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5" });

  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "provider_rank", value: ["openai", "anthropic", "moonshot"] });
  const client = await mcpClient(t.mcpBaseUrl, first.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  await completeMetaReviews(t);
  await completeIntegrationReviews(t, first.id);
  const second = await registerWork(t, "after the rank change");
  await t.clock.advance(HOUR);
  expect(t.worker.started.filter((task) => task.type === "work").map((task) => task.id)).toEqual([first.id, second.id]);
  expect(t.worker.startedSettings.at(-1)).toMatchObject({
    provider: "openai",
    model: "gpt-5.6-terra",
    source: { provider: "rank" },
  });
});

it("registry なしの盤面の暗黙の entry は Selector の表に追随する —— anthropic の行を差し替えると次の pickup はその model で走る(ADR 0140 決定3)", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/settings/execution", {
    setting: "row",
    row: { provider: "anthropic", tier: "economy", model: "claude-haiku-4-5", effort: "low", price_in: 1, price_out: 5 },
  });
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });
  const work = await registerWork(t, "runs on the replaced row");
  await completeMetaReviews(t);
  expect(settingsOf(work.id)).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5", effort: "low" });
});

it("優先順位の既定を cost にすると、要求の無い task は最安の行で走り、行を消すとその行は候補から消える(ADR 0114 決定1・3)", async () => {
  t = await bootTidepool(boardWith(["anthropic", "openai"]));
  // economy の最安は openai の terra(out 12)ではなく anthropic の sonnet(out 10)なので、
  // sonnet の行を消してから cost にする —— 両方の変更が同じ pickup に効くことを1度で言う
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" });
  const work = await registerWork(t, "cheapest economy row that is left");
  await t.clock.advance(HOUR);
  await completeMetaReviews(t);
  expect(settingsOf(work.id)).toMatchObject({
    provider: "openai",
    model: "gpt-5.6-terra",
    source: { tier: "board", provider: "cost" },
  });
});

it("管理MCP の read_execution_settings / change_execution_settings は同じ状態を読み書きする(ADR 0110 決定5)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const read = async () => JSON.parse(((await client.callTool({ name: "read_execution_settings", arguments: {} })) as any).content[0].text);
    expect(await read()).toEqual(await state());

    const changed = (await client.callTool({
      name: "change_execution_settings",
      arguments: { change: { setting: "provider_rank", value: ["openai", "moonshot", "anthropic"] } },
    })) as any;
    expect(changed.isError).not.toBe(true);
    expect((await state()).providerRank).toEqual(["openai", "moonshot", "anthropic"]);

    const rejected = (await client.callTool({
      name: "change_execution_settings",
      arguments: { change: { setting: "priority", value: "speed" } },
    })) as any;
    expect(rejected.isError).toBe(true);
    expect((await state()).priority).toBe("quality");

    // judgement_tier(issue #914): 両方の扉から設定でき、語彙の外は両方の扉で拒否される
    const changedTier = (await client.callTool({
      name: "change_execution_settings",
      arguments: { change: { setting: "judgement_tier", value: "standard" } },
    })) as any;
    expect(changedTier.isError).not.toBe(true);
    expect((await state()).judgementTier).toBe("standard");

    const rejectedTier = (await client.callTool({
      name: "change_execution_settings",
      arguments: { change: { setting: "judgement_tier", value: "premium" } },
    })) as any;
    expect(rejectedTier.isError).toBe(true);
    expect((await state()).judgementTier).toBe("standard");
  } finally {
    await client.close();
  }
});

it("task を持たない盤面イベント(execution_settings_changed)が混ざっても decision log の読み口は落ちない(JOIN は kind で絞られる)", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" });
  const log = await api(t.baseUrl, "GET", "/api/log");
  expect(log.status).toBe(200);
  expect(log.json.entries).toEqual([]);
});

/** 学習器を昇格させる —— approve の適用と同じ書き口(扉は true を断るので、盤面の内側から書く)。 */
const promote = () => applyExecutionSettingsChange(t.db, { setting: "learner_promoted", value: true }, "webui", t.clock.now());

it("学習器の降格は settings タブと管理MCP の扉から直接できるが、昇格は両方の扉で断られる(ADR 0150 決定4)", async () => {
  t = await bootTidepool();
  promote();
  expect((await state()).learnerPromoted).toBe(true);

  const refused = await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "learner_promoted", value: true });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.json)).toContain("the learner is promoted only by approving");
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "learner_promoted", value: false })).status).toBe(200);
  expect((await state()).learnerPromoted).toBe(false);

  promote();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const change = (value: boolean) => client.callTool({ name: "change_execution_settings", arguments: { change: { setting: "learner_promoted", value } } }) as Promise<any>;
    const viaMcp = await change(true);
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.content[0].text).toContain("the learner is promoted only by approving");
    expect((await change(false)).isError).not.toBe(true);
  } finally {
    await client.close();
  }
  expect((await state()).learnerPromoted).toBe(false);
});

it("人間の直接の降格は open な降格提案を観測で決着させ、routing_proposal_stale に崩れた pin を残す", async () => {
  t = await bootTidepool();
  promote();
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" });
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "routing");
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  let questionId: string;
  try {
    const result: any = await client.callTool({ name: "propose_routing_change", arguments: { op: "demote", rationale: "the learner routed worse than the table." } });
    questionId = JSON.parse(result.content[0].text).question_id;
  } finally {
    await client.close();
  }

  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "learner_promoted", value: false })).status).toBe(200);

  expect((await api(t.baseUrl, "GET", `/api/tasks/${questionId}`)).json).toMatchObject({ status: "done", question_answer: null });
  expect(((await api(t.baseUrl, "GET", `/api/tasks/${questionId}/events`)).json as any[]).find((e) => e.kind === "routing_proposal_stale").payload).toEqual({
    kind: "routing_proposal_stale",
    question_id: questionId,
    proposal_kind: "routing",
    changed: ["learner_promoted"],
    observed_event_id: expect.any(Number),
  });
});

/** 行の Quarantine(行の拒否、ADR 0184)の解除の門1。404 は fake worker で起こさず、Quarantine を直に登録する。 */
const quarantineRow = (provider: Provider, model: string) => {
  const value = tableRowValue(provider, model);
  registerQuarantine(t.db, "tableRow", value, "refused in a test", t.clock.now());
  return openQuarantineQuestion(t.db, "tableRow", value)!.id;
};
const SONNET = { provider: "anthropic", tier: "economy", model: "claude-sonnet-5-5", effort: "high", price_in: 2, price_out: 10 } as const;

/** settings タブと管理MCP —— 1つの変更を撃つ2つの扉。 */
const doors: Array<[string, (change: unknown) => Promise<void>]> = [
  [
    "POST /api/settings/execution",
    async (change) => {
      expect((await api(t.baseUrl, "POST", "/api/settings/execution", change)).status).toBe(200);
    },
  ],
  [
    "管理MCP の change_execution_settings",
    async (change) => {
      const client = await managementMcpClient(t.baseUrl);
      try {
        expect(((await client.callTool({ name: "change_execution_settings", arguments: { change } })) as any).isError).not.toBe(true);
      } finally {
        await client.close();
      }
    },
  ],
];

it.each(doors)("Quarantine 中の行の model を新しい行の追加 → 古い行の delete_row で差し替えると、question は回答なしで盤面名義に決着する(%s)", async (_door, change) => {
  t = await bootTidepool();
  const questionId = quarantineRow("anthropic", "claude-sonnet-5-5");

  await change({ setting: "row", row: { ...SONNET, model: "claude-sonnet-5" } });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${questionId}`)).json.status).toBe("todo");
  await change({ setting: "delete_row", provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" });

  expect((await api(t.baseUrl, "GET", `/api/tasks/${questionId}`)).json).toMatchObject({ status: "done", question_answer: null });
  const timeline = (await api(t.baseUrl, "GET", `/api/tasks/${questionId}/events`)).json as any[];
  expect(timeline.find((e) => e.kind === "quarantine_released")).toMatchObject({
    worker_id: "tidepool",
    origin: "board",
    payload: { kind: "quarantine_released", quarantine: "tableRow", value: "anthropic/claude-sonnet-5-5", observed_event_id: expect.any(Number) },
  });
  expect(timeline.map((e) => e.kind)).not.toContain("question_answered");
  expect(timeline.map((e) => e.kind)).not.toContain("decision_logged");
});

it("Quarantine 中の行の effort / 価格 / ティアだけを書き換えても question は開いたまま", async () => {
  t = await bootTidepool();
  const questionId = quarantineRow("anthropic", "claude-sonnet-5-5");

  // 鍵は1つ前の編集の後の effort
  for (const [effort, row] of [["high", { ...SONNET, effort: "max" }], ["max", { ...SONNET, price_in: 3, price_out: 15 }], ["high", { ...SONNET, tier: "standard" }]] as const) {
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", key: { ...SONNET, effort }, row })).status).toBe(200);
  }

  expect((await api(t.baseUrl, "GET", `/api/tasks/${questionId}`)).json.status).toBe("todo");
});

it("GET /api/settings/execution は Quarantine 中の行にその question の id を、他の行に null を載せる", async () => {
  t = await bootTidepool();
  const questionId = quarantineRow("anthropic", "claude-sonnet-5-5");

  const { table } = await state();
  expect(table.filter((row: any) => row.quarantine_question_id !== null).map((row: any) => [row.model, row.quarantine_question_id])).toEqual([
    ["claude-sonnet-5-5", questionId],
  ]);
});

// ── 段の編集(ADR 0200 決定2 / issue #1421): settings タブと管理MCP の両方の扉 ──

const premium = { name: "premium", description: "Work only the newest frontier model gets right." };

it("段の挿入・編集・削除と盤面既定の段は両方の扉に乗り、拒否は理由つきの 400 / toolError、操作イベントは扉の origin で残る", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "insert_tier", ...premium, position: 2 })).status).toBe(200);
  const refused = await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_tier", name: "standard" });
  expect(refused.status).toBe(400);
  expect(refused.json.error).toContain("it has execution-setting rows");

  const client = await managementMcpClient(t.baseUrl);
  try {
    const call = async (change: object) => (await client.callTool({ name: "change_execution_settings", arguments: { change } })) as any;
    expect((await call({ setting: "edit_tier", name: "premium", description: "Edited." })).isError).not.toBe(true);
    expect((await call({ setting: "default_tier", value: "standard" })).isError).not.toBe(true);
    const viaMcp = await call({ setting: "delete_tier", name: "standard" });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.content[0].text).toContain("it is the board's default tier");
  } finally {
    await client.close();
  }

  expect(await state()).toMatchObject({
    defaultTier: "standard",
    tiers: [SEED_TIERS[0], SEED_TIERS[1], { name: "premium", description: "Edited." }, SEED_TIERS[2]],
  });
  const events = listEventsOfKinds(t.db, ["execution_settings_changed"]);
  expect(events.map((e) => [e.origin, e.payload.setting])).toEqual([
    ["webui", "insert_tier"],
    ["mcp", "edit_tier"],
    ["mcp", "default_tier"],
  ]);
});

it("挿入した段は、人間の Register・register_task・decompose が受け、その段の行で走り、新しい MCP session の説明に並び、一覧に無い段のエラーはいまの一覧を返す", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "insert_tier", ...premium, position: 3 });
  await api(t.baseUrl, "POST", "/api/settings/execution", {
    setting: "row",
    row: { provider: "anthropic", tier: "premium", model: "claude-opus-5-5", effort: "max", price_in: 5, price_out: 25 },
  });
  const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", title: "w", purpose: "p", completion_criteria: "c", tier: "premium" })).json;
  await t.clock.advance(HOUR);
  await completeMetaReviews(t);
  expect(settingsOf(work.id)).toMatchObject({ model: "claude-opus-5-5", effort: "max", source: { tier: "task" } });

  const worker = await mcpClient(t.mcpBaseUrl, work.id);
  const management = await managementMcpClient(t.baseUrl);
  try {
    const decompose = (await worker.listTools()).tools.find((tool) => tool.name === "decompose")!;
    expect(JSON.stringify(decompose.inputSchema)).toContain(`premium — ${premium.description}`);
    const child = (tier: string) => ({ title: "c", purpose: "p", completion_criteria: "c", tier });
    const unknown = (await worker.callTool({ name: "decompose", arguments: { reason: "r", children: [child("platinum")] } })) as any;
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0].text).toContain('unknown tier "platinum" — one of economy, standard, frontier, premium');
    expect(((await worker.callTool({ name: "decompose", arguments: { reason: "r", children: [child("premium")] } })) as any).isError ?? false).toBe(false);

    const registered = (await management.callTool({
      name: "register_task",
      arguments: { type: "work", title: "m", purpose: "p", completion_criteria: "c", tier: "premium" },
    })) as any;
    expect(registered.isError ?? false).toBe(false);
  } finally {
    await worker.close();
    await management.close();
  }
  const tasks = (await api(t.baseUrl, "GET", "/api/tasks")).json as any[];
  expect(tasks.filter((task) => task.tier === "premium").map((task) => task.title).sort()).toEqual(["c", "m", "w"]);
});

it("段の改名は両方の扉に乗り、registry の書き換えを通ってから盤面の名前を変える —— push の失敗は 400 / toolError で名前は変わらない(ADR 0200 決定2)", async () => {
  const renameTier = vi.fn(async (_input: { from: string; to: string; message: string }) => {});
  t = await bootTidepool({ agentAdmin: { renameTier } });
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "rename_tier", name: "standard", to: "mid" })).status).toBe(200);
  expect(renameTier).toHaveBeenLastCalledWith(expect.objectContaining({ from: "standard", to: "mid" }));

  renameTier.mockRejectedValueOnce(new RegistryPushFailedError("remote rejected"));
  const refused = await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "rename_tier", name: "mid", to: "middle" });
  expect(refused.status).toBe(400);
  expect(refused.json.error).toContain("remote rejected");

  const client = await managementMcpClient(t.baseUrl);
  try {
    const call = async (change: object) => (await client.callTool({ name: "change_execution_settings", arguments: { change } })) as any;
    renameTier.mockRejectedValueOnce(new RegistryPushFailedError("remote rejected"));
    const viaMcp = await call({ setting: "rename_tier", name: "mid", to: "middle" });
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.content[0].text).toContain("remote rejected");
    expect((await call({ setting: "rename_tier", name: "frontier", to: "top" })).isError).not.toBe(true);
  } finally {
    await client.close();
  }

  expect(renameTier).toHaveBeenLastCalledWith(expect.objectContaining({ from: "frontier", to: "top" }));
  expect((await state()).tiers.map((tier: { name: string }) => tier.name)).toEqual(["economy", "mid", "top"]);
});

it("agent.md が名指す段の削除は両方の扉で agent 名を添えて断られる(ADR 0200 追記 2026-10-06)", async () => {
  t = await bootTidepool({ agentAdmin: { list: () => [{ name: "kimi", tier: "premium" }] as AgentView[] } });
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "insert_tier", ...premium, position: 3 });
  const refused = await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_tier", name: "premium" });
  expect(refused.status).toBe(400);
  expect(refused.json.error).toContain("agents name it in agent.md: kimi");

  const client = await managementMcpClient(t.baseUrl);
  try {
    const viaMcp = (await client.callTool({ name: "change_execution_settings", arguments: { change: { setting: "delete_tier", name: "premium" } } })) as any;
    expect(viaMcp.isError).toBe(true);
    expect(viaMcp.content[0].text).toContain("agents name it in agent.md: kimi");
  } finally {
    await client.close();
  }
  expect((await state()).tiers.map((tier: { name: string }) => tier.name)).toContain("premium");
});

it("registry の無い盤面では段の改名は盤面の名前だけを変える", async () => {
  t = await bootTidepool();
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "rename_tier", name: "standard", to: "mid" })).status).toBe(200);
  expect((await state()).tiers.map((tier: { name: string }) => tier.name)).toEqual(["economy", "mid", "frontier"]);
});
