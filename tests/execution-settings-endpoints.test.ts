import { afterEach, expect, it } from "vitest";
import { executionSettingsFor, SEED_EXECUTION_SETTINGS } from "../src/execution-setting.js";
import { PROVIDER_VALUES } from "../src/registry.js";
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

it("GET /api/settings/execution は種の表と盤面既定(frontier advisor 無し・Provider 順位は宣言順・優先順位 quality)と選択肢を返す(ADR 0110 決定5)", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "GET", "/api/settings/execution");
  expect(res.status).toBe(200);
  expect(res.json).toEqual({
    table: [...SEED_EXECUTION_SETTINGS].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    ),
    frontierAdvisor: false,
    providerRank: [...PROVIDER_VALUES],
    priority: "quality",
    providers: [
      { value: "anthropic", label: "anthropic — Claude models, Anthropic billing" },
      { value: "moonshot", label: "moonshot — Kimi models, Moonshot Platform billing" },
      { value: "openai", label: "openai — Codex models, OpenAI billing" },
    ],
    tiers: ["economy", "standard", "frontier"],
    priorities: ["quality", "cost"],
  });
});

/** 盤面境界の読み口(GET)から見た状態。選択肢は落とす。 */
const state = async () => {
  const { providers: _p, tiers: _t, priorities: _q, ...rest } = (await api(t.baseUrl, "GET", "/api/settings/execution")).json;
  return rest;
};

it("POST /api/settings/execution は1つの変更を受け、Provider 順位・優先順位・frontier advisor は GET に反映される", async () => {
  t = await bootTidepool();
  for (const change of [
    { setting: "provider_rank", value: ["openai", "anthropic", "moonshot"] },
    { setting: "priority", value: "cost" },
    { setting: "frontier_advisor", value: true },
  ]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", change)).status).toBe(200);
  }
  expect(await state()).toMatchObject({
    providerRank: ["openai", "anthropic", "moonshot"],
    priority: "cost",
    frontierAdvisor: true,
  });
});

it("表の行は (provider, model) を鍵に追加・編集(upsert)・削除でき、同じ provider × tier に複数行を置ける(ADR 0114 決定2)", async () => {
  t = await bootTidepool();
  const haiku = { provider: "anthropic", tier: "economy", model: "haiku", effort: "low", price_in: 1, price_out: 5 };
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: haiku })).status).toBe(200);
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: { ...haiku, effort: "high" } })).status).toBe(200);
  expect(
    (await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "openai", model: "gpt-6-astra" })).status,
  ).toBe(200);

  const { table } = await state();
  expect(table.filter((row: any) => row.provider === "anthropic" && row.tier === "economy")).toEqual([
    { ...haiku, effort: "high" },
    { provider: "anthropic", tier: "economy", model: "sonnet", effort: "high", price_in: 2, price_out: 10 },
  ]);
  expect(table.find((row: any) => row.model === "gpt-6-astra")).toBeUndefined();
});

it("ある provider × tier の行を全部消すことは許される —— その Provider はそのティアの task で除外されるだけ(ADR 0114 決定3)", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "moonshot", model: "kimi-k3[1m]" });
  expect(res.status).toBe(200);
  expect((await state()).table.some((row: any) => row.provider === "moonshot")).toBe(false);
});

it("不正値(未知の Provider / ティア / 優先順位、負の価格、順列でない Provider 順位)は 400 で弾かれ、設定は変わらない", async () => {
  t = await bootTidepool();
  const before = await state();
  const row = { provider: "anthropic", tier: "economy", model: "haiku", effort: "high", price_in: 1, price_out: 5 };
  for (const bad of [
    { setting: "row", row: { ...row, provider: "moonshto" } },
    { setting: "row", row: { ...row, tier: "premium" } },
    { setting: "row", row: { ...row, price_in: -1 } },
    { setting: "row", row: { ...row, price_out: -0.5 } },
    { setting: "delete_row", provider: "typo", model: "sonnet" },
    { setting: "priority", value: "speed" },
    { setting: "provider_rank", value: ["anthropic", "openai"] }, // moonshot が欠ける → indexOf -1 で先頭に来てしまう
    { setting: "provider_rank", value: ["anthropic", "anthropic", "openai"] },
    { setting: "provider_rank", value: ["anthropic", "openai", "moonshot", "openai"] },
    { setting: "frontier_advisor", value: "yes" },
    { setting: "tier", value: "frontier" }, // ティアの既定は設定ではない(BOARD_DEFAULT_TIER)
  ]) {
    expect((await api(t.baseUrl, "POST", "/api/settings/execution", bad)).status, JSON.stringify(bad)).toBe(400);
  }
  expect(await state()).toEqual(before);
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
  expect(t.worker.startedSettings[0]).toMatchObject({ provider: "anthropic", model: "sonnet" });

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
    row: { provider: "anthropic", tier: "economy", model: "haiku", effort: "low", price_in: 1, price_out: 5 },
  });
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "anthropic", model: "sonnet" });
  const work = await registerWork(t, "runs on the replaced row");
  await completeMetaReviews(t);
  expect(settingsOf(work.id)).toMatchObject({ provider: "anthropic", model: "haiku", effort: "low" });
});

it("優先順位の既定を cost にすると、要求の無い task は最安の行で走り、行を消すとその行は候補から消える(ADR 0114 決定1・3)", async () => {
  t = await bootTidepool(boardWith(["anthropic", "openai"]));
  // economy の最安は openai の terra(out 12)ではなく anthropic の sonnet(out 10)なので、
  // sonnet の行を消してから cost にする —— 両方の変更が同じ pickup に効くことを1度で言う
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "anthropic", model: "sonnet" });
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

it("管理MCP の read_execution_settings / change_execution_settings は同じ状態を読み書きし、変更は人間名義・経路 mcp で残る(ADR 0110 決定5)", async () => {
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
  } finally {
    await client.close();
  }
  expect(t.db.prepare("SELECT worker_id, origin FROM events WHERE kind = 'execution_settings_changed'").all()).toEqual([
    { worker_id: "human", origin: "mcp" },
  ]);
});

it("変更は操作イベント execution_settings_changed として経路 webui つきで残る(CONTEXT.md「管理MCP」の経路の機械記録)", async () => {
  t = await bootTidepool();
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "priority", value: "cost" });
  // 存在しない行の削除は何も変えないので、イベントも残らない
  await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "openai", model: "no-such-model" });
  // task を持たない盤面イベントには読み口が無い(learner_shadow と同じ)ので行を直に読む
  expect(
    t.db.prepare("SELECT task_id, worker_id, origin, payload FROM events WHERE kind = 'execution_settings_changed'").all(),
  ).toEqual([
    {
      task_id: null,
      worker_id: "human",
      origin: "webui",
      payload: JSON.stringify({ kind: "execution_settings_changed", setting: "priority", value: "cost" }),
    },
  ]);
  // task を持たない行が混ざっても decision log の読み口は落ちない(JOIN は kind で絞られる)
  const log = await api(t.baseUrl, "GET", "/api/log");
  expect(log.status).toBe(200);
  expect(log.json.entries).toEqual([]);
});
