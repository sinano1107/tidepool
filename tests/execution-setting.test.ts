import { expect, it, vi } from "vitest";
import { type AdvisorCeiling, isClaudeModelAlias } from "../src/claude-model-alias.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { whyInvalidEffort } from "../src/effort.js";
import { listEventsOfKinds } from "../src/events.js";
import {
  applyExecutionSettingsChange,
  assertTierRunnableFor,
  BOARD_DEFAULT_PRIORITY,
  changeExecutionSettings,
  composeRoutingRow,
  type ExecutionSetting,
  type ExecutionSettingsChange,
  type ExecutionSettingTable,
  executionSettingsChangeSchema,
  executionSettingsFor,
  parseAddTierAmendment,
  parseAgentTierAmendment,
  parseRoutingRowChange,
  readExecutionSettings,
  registryPinChanges,
  routingPinChanges,
  SEED_EXECUTION_SETTINGS,
  type SelectorInput,
  selectable,
  selectExecutionSetting,
  tierFieldDescriptions,
} from "../src/execution-setting.js";
import { submitAnswer } from "../src/human-verbs.js";
import { registerMetaReview } from "../src/meta-review.js";
import { PROVIDER_VALUES, type Provider } from "../src/provider.js";
import { registerQuarantine, tableRowValue } from "../src/quarantine.js";
import { assertValidAgentDefinition } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { proposeRoutingChange } from "../src/routing-review.js";
import { cancelTaskDirectly, getTask, listChildren, type RegistryProposal, type RoutingProposal, type RoutingRowProposal, registerTask, type TierDescriptionProposal } from "../src/tasks.js";
import { boardCallRow, reportProviderUsage } from "../src/throttle.js";
import { assertKnownTier, PRIORITIES, readTiers, SEED_TIERS, type Tier, tierNames } from "../src/tier.js";
import { unusedLanding } from "./fakes.js";
import { HUMAN_WEBUI } from "./harness.js";

const table: ExecutionSettingTable = SEED_EXECUTION_SETTINGS;
/** 種の盤面の段の名前(順序どおり)。 */
const tiers = SEED_TIERS.map((tier) => tier.name);

/** selector の入力の既定形。テストが言いたい1点だけを上書きする。 */
function input(overrides: Partial<SelectorInput> = {}): SelectorInput {
  return {
    entries: [{ provider: "anthropic", advisor: false }],
    providerRank: PROVIDER_VALUES,
    taskTier: undefined,
    priority: undefined,
    agentTier: undefined,
    boardTier: "economy",
    tiers: SEED_TIERS.map((tier, i) => ({ id: i + 1, name: tier.name })),
    advisorCeiling: "off",
    ...overrides,
  };
}

/** 「選べた」ことまで込みの呼び出し —— 全 entry 除外(null)を主張したいテストだけが
 *  `selectExecutionSetting` を直に呼ぶ。 */
function select(request: SelectorInput, tbl: ExecutionSettingTable = table): ExecutionSetting {
  const setting = selectExecutionSetting(request, tbl);
  expect(setting).not.toBeNull();
  return setting!;
}

it("新しい盤面は種の3段を説明つきで持ち、読み口が順序どおりに返す(ADR 0200 決定1・3)", () => {
  expect(readTiers(openDb(":memory:"))).toEqual([
    { name: "economy", description: "Work that follows a pattern already in the codebase: adding tests, routine wiring, mechanical edits." },
    { name: "standard", description: "Work where the approach has to be worked out: a multi-file implementation or a larger refactor." },
    { name: "frontier", description: "A hard problem that has already resisted an attempt, or long autonomous work where a wrong call is expensive." },
  ]);
});

it("種の表は `/implementation-delegation` の表と同じ7行 — anthropic も openai も具体 id 行で、anthropic の行は alias の拒否一覧に当たらない、moonshot は kimi-k3 を economy に1行(ADR 0114: 価格は USD per MTok / ADR 0182 決定1)", () => {
  expect(SEED_EXECUTION_SETTINGS.filter((row) => row.provider === "anthropic" && isClaudeModelAlias(row.model))).toEqual([]);
  // 種は扉を通らずに入るので、effort が語彙の中にあることはここで刺す(ADR 0216 決定4)
  expect(SEED_EXECUTION_SETTINGS.filter((row) => whyInvalidEffort(row.effort))).toEqual([]);
  expect(SEED_EXECUTION_SETTINGS).toEqual([
    { provider: "anthropic", tier: "economy", model: "claude-sonnet-5-5", effort: "high", price_in: 2, price_out: 10 },
    { provider: "anthropic", tier: "standard", model: "claude-opus-5-5", effort: "high", price_in: 5, price_out: 25 },
    { provider: "anthropic", tier: "frontier", model: "claude-fable-5-1", effort: "high", price_in: 10, price_out: 50 },
    { provider: "moonshot", tier: "economy", model: "kimi-k3[1m]", effort: "high", price_in: 3, price_out: 15 },
    { provider: "openai", tier: "economy", model: "gpt-5.6-terra", effort: "high", price_in: 2, price_out: 12 },
    { provider: "openai", tier: "standard", model: "gpt-5.6-sol", effort: "high", price_in: 4, price_out: 20 },
    { provider: "openai", tier: "frontier", model: "gpt-6-astra", effort: "high", price_in: 10, price_out: 50 },
  ]);
});

it("effort の語彙は low / medium / high / xhigh / max の閉じた5値で、それ以外は5値を挙げて拒む(ADR 0216 決定1・2)", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"]) expect(whyInvalidEffort(effort)).toBeUndefined();
  for (const effort of ["ultra", "minimal", "none", "bogus", "High", ""]) expect(whyInvalidEffort(effort)).toBe("effort must be one of low / medium / high / xhigh / max");
});

it("tier を書かない agent は盤面既定のティアで解決され、出所は board", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: undefined, agentTier: undefined }), table),
  ).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    effort: "high",
    advisor: undefined,
    tier_id: 1,
    source: { tier: "board", provider: "only" },
  });
});

it("agent の tier は盤面既定より優先され、出所は agent", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: undefined, agentTier: "economy" }), table),
  ).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    effort: "high",
    advisor: undefined,
    tier_id: 1,
    source: { tier: "agent", provider: "only" },
  });
});

it("provider が違えば同じティアでもその provider の表記で解決される", () => {
  expect(
    select(input({ entries: [{ provider: "openai", advisor: false }], taskTier: undefined, agentTier: "frontier" }), table)
      .model,
  ).toBe("gpt-6-astra");
  expect(
    select(input({ entries: [{ provider: "moonshot", advisor: false }], taskTier: undefined, agentTier: "economy" }), table)
      .model,
  ).toBe("kimi-k3[1m]");
});

it("要求ティアの行を持たない Provider の entry は候補から落ち、それしか無ければ null —— 表の穴は設定漏れではなく事実で、全 entry 除外と同じ枝(ADR 0114 決定3)", () => {
  expect(
    selectExecutionSetting(input({ entries: [{ provider: "moonshot", advisor: false }], agentTier: "frontier" }), table),
  ).toBeNull();
});

it("entry が複数で片方の Provider に行が無ければ、もう片方で走る —— 表の穴は他の候補を巻き込まない", () => {
  expect(
    select(
      input({
        entries: [
          { provider: "moonshot", advisor: false },
          { provider: "openai", advisor: false },
        ],
        taskTier: "frontier",
      }),
    ),
  ).toMatchObject({ provider: "openai", model: "gpt-6-astra" });
});

const cheapStandardRow = (model: string): ExecutionSettingTable[number] =>
  ({ provider: "anthropic", tier: "standard", model, effort: "high", price_in: 1, price_out: 1 });

/** advisor つきの entry が、その1行だけの表で選んだ advisor と出所。候補にならなければ null。 */
function advisorOn(model: string, advisorCeiling: AdvisorCeiling) {
  const setting = selectExecutionSetting(
    input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "standard", advisorCeiling }),
    [cheapStandardRow(model)],
  );
  return setting && { advisor: setting.advisor, source: setting.source.advisor };
}

it("advisor の上限5値 × 行の advisor と出所は #1538 の表どおり —— 上限より下の系列は上限の alias、同じ系列は main と同一、上限より上は付けない、off はすべての行で無し、Fable の窓が開いていれば fable_then_opus は fable と同じ(ADR 0208 決定2)", () => {
  const rows = ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
  const ceilings = ["off", "sonnet", "opus", "fable", "fable_then_opus"] as const;
  const fable = [
    { advisor: "fable", source: "ceiling" },
    { advisor: "fable", source: "ceiling" },
    { advisor: "fable", source: "ceiling" },
    { advisor: "claude-fable-5-1", source: "ceiling" },
  ];
  const none = (source: string) => ({ advisor: undefined, source });
  expect(Object.fromEntries(ceilings.map((ceiling) => [ceiling, rows.map((model) => advisorOn(model, ceiling))]))).toEqual({
    off: [none("off"), none("off"), none("off"), none("off")],
    sonnet: [
      { advisor: "sonnet", source: "ceiling" },
      { advisor: "claude-sonnet-5-5", source: "ceiling" },
      none("main_above_ceiling"),
      none("main_above_ceiling"),
    ],
    opus: [
      { advisor: "opus", source: "ceiling" },
      { advisor: "opus", source: "ceiling" },
      { advisor: "claude-opus-5-5", source: "ceiling" },
      none("main_above_ceiling"),
    ],
    fable,
    fable_then_opus: fable,
  });
});

it("advisor の無い entry の実行設定は advisor の出所を持たない —— off で advisor 無しになった候補と記録で区別できる", () => {
  expect(select(input({ entries: [{ provider: "anthropic", advisor: false }], advisorCeiling: "fable" })).source).toEqual({ tier: "board", provider: "only" });
  expect(select(input({ entries: [{ provider: "anthropic", advisor: true }], advisorCeiling: "off" })).source).toEqual({ tier: "board", provider: "only", advisor: "off" });
});

it("上限が off なら advisor を有効にした entry は advisor の無い entry として選ばれ、Haiku・知らない系列・下限未満の行も候補に残る(ADR 0208 決定3)", () => {
  for (const model of ["claude-haiku-4-5", "claude-mythos-1", "claude-sonnet-4-5", "claude-haiku-5"]) {
    expect(advisorOn(model, "off")).toEqual({ advisor: undefined, source: "off" });
  }
});

it("adapter が知らない新しい世代の main は、上限の alias でなく main と同一(出所は知らない世代)に落ち、advisor になれない系列(Haiku)の新しい世代は候補から外れる(ADR 0208 決定4)", () => {
  expect(advisorOn("claude-sonnet-6", "opus")).toEqual({ advisor: "claude-sonnet-6", source: "unknown_generation" });
  expect(advisorOn("claude-sonnet-6", "fable")).toEqual({ advisor: "claude-sonnet-6", source: "unknown_generation" });
  expect(advisorOn("claude-opus-6", "fable")).toEqual({ advisor: "claude-opus-6", source: "unknown_generation" });
  for (const ceiling of ["sonnet", "opus", "fable"] as const) expect(advisorOn("claude-haiku-5", ceiling)).toBeNull();
});

it("main が上限より上で advisor 無しになった行は除外ではない —— 候補に残って選ばれる", () => {
  expect(select(input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "frontier", advisorCeiling: "opus" }))).toMatchObject({
    model: "claude-fable-5-1",
    advisor: undefined,
    source: { advisor: "main_above_ceiling" },
  });
  // advisor が付かないので CLI が断る組も無い —— main の下限(4.6 未満)は効かない
  expect(advisorOn("claude-opus-4-5", "sonnet")).toEqual({ advisor: undefined, source: "main_above_ceiling" });
});

it("表に Fable の行が無くても、上限 fable なら advisor は `fable` —— advisor は行でなく、表を読まない", () => {
  const noFable: ExecutionSettingTable = table.filter((row) => row.model !== "claude-fable-5-1");
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "standard", advisorCeiling: "fable" }), noFable),
  ).toMatchObject({ model: "claude-opus-5-5", advisor: "fable" });
});

it("adapter が知らない系列の行は、advisor つきの entry では off 以外の上限で候補に入らず、advisor なしの entry では入る —— 付かない advisor を記録に残さない", () => {
  // 知らない系列の行のほうが安いので、候補に入っていれば先に選ばれる
  const withMythos: ExecutionSettingTable = [
    ...table,
    { provider: "anthropic", tier: "standard", model: "claude-mythos-1", effort: "high", price_in: 1, price_out: 1 },
  ];
  const standard = (advisor: boolean, advisorCeiling: AdvisorCeiling) =>
    select(input({ entries: [{ provider: "anthropic", advisor }], agentTier: "standard", advisorCeiling }), withMythos).model;
  expect(standard(true, "opus")).toBe("claude-opus-5-5");
  expect(standard(true, "fable")).toBe("claude-opus-5-5");
  expect(standard(false, "fable")).toBe("claude-mythos-1");
});

/** 種の表の standard に、種の行より安い anthropic の行を1つ足し、選ばれた model を返す。足した行が候補に
 *  入っていれば先に選ばれる。 */
function standardWithCheapRow(model: string, advisor: boolean, advisorCeiling: AdvisorCeiling): string {
  const withRow: ExecutionSettingTable = [...table, cheapStandardRow(model)];
  return select(input({ entries: [{ provider: "anthropic", advisor }], agentTier: "standard", advisorCeiling }), withRow).model;
}

it("main として advisor を受けない世代(Sonnet / Opus の 4.6 未満)の行は、advisor つきの entry では上限が main の系列以上なら候補に入らず、advisor なしの entry では入る(ADR 0200 追記 2026-10-07)", () => {
  for (const model of ["claude-sonnet-4-5", "claude-opus-4-5", "claude-sonnet-4-20250514", "claude-opus-4-1-20250805"]) {
    expect(standardWithCheapRow(model, true, "opus")).toBe("claude-opus-5-5");
    expect(standardWithCheapRow(model, true, "fable")).toBe("claude-opus-5-5");
    expect(standardWithCheapRow(model, false, "off")).toBe(model);
  }
});

it("Haiku 4.5 の行は advisor つきの entry では上限の alias で入る —— advisor が main と同一にはならない", () => {
  expect(standardWithCheapRow("claude-haiku-4-5", false, "off")).toBe("claude-haiku-4-5");
  const haikuTable: ExecutionSettingTable = [cheapStandardRow("claude-haiku-4-5")];
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "standard", advisorCeiling: "fable" }), haikuTable),
  ).toMatchObject({ model: "claude-haiku-4-5", advisor: "fable" });
});

it("Sonnet 4.6 は下限ちょうどで advisor を受ける —— 上限 sonnet なら advisor は同一 id、fable なら `fable`", () => {
  const sonnet46: ExecutionSettingTable = [cheapStandardRow("claude-sonnet-4-6")];
  const advisorWith = (advisorCeiling: AdvisorCeiling) =>
    select(input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "standard", advisorCeiling }), sonnet46).advisor;
  expect(advisorWith("sonnet")).toBe("claude-sonnet-4-6");
  expect(advisorWith("fable")).toBe("fable");
});

it("旧形式の id(`claude-3-5-haiku-…`)は系列の prefix に合わず、知らない系列として advisor つきの entry の候補に入らない", () => {
  expect(standardWithCheapRow("claude-3-5-haiku-20241022", true, "fable")).toBe("claude-opus-5-5");
  expect(standardWithCheapRow("claude-3-5-haiku-20241022", false, "off")).toBe("claude-3-5-haiku-20241022");
});

it("advisor を受けられない行しか無ければ、advisor つきの entry は候補が空で null(skipped の枝)", () => {
  const ineligible: ExecutionSettingTable = [
    cheapStandardRow("claude-sonnet-4-5"),
    cheapStandardRow("claude-haiku-5"),
  ];
  expect(
    selectExecutionSetting(input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "standard", advisorCeiling: "opus" }), ineligible),
  ).toBeNull();
});

it("盤面設定の変更の検証は advisor の上限5値だけを受け、旧い真偽値を含むそれ以外を拒む", () => {
  for (const value of ["off", "sonnet", "opus", "fable", "fable_then_opus"]) {
    expect(executionSettingsChangeSchema.safeParse({ setting: "advisor_ceiling", value }).success).toBe(true);
  }
  for (const value of [true, false, "haiku", "fable_then_sonnet", "claude-opus-5-5", ""]) {
    expect(executionSettingsChangeSchema.safeParse({ setting: "advisor_ceiling", value }).success).toBe(false);
  }
  expect(executionSettingsChangeSchema.safeParse({ setting: "advisor_above_main", value: true }).success).toBe(false);
});

it("優先順位は quality / cost の2値で、既定は quality(CONTEXT.md「要求」/ ADR 0114 決定1: speed は落とした)", () => {
  expect(PRIORITIES).toEqual(["quality", "cost"]);
  expect(BOARD_DEFAULT_PRIORITY).toBe("quality");
});

it("task の要求ティアは agent の tier より優先され、出所は task(ADR 0110 決定2)", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "frontier", agentTier: "economy" }),
      table,
    ),
  ).toEqual({
    provider: "anthropic",
    model: "claude-fable-5-1",
    effort: "high",
    advisor: undefined,
    tier_id: 3,
    source: { tier: "task", provider: "only" },
  });
});

it("task の要求ティアは agent が tier を持たなくても盤面既定より優先される", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "standard", agentTier: undefined }),
      table,
    ),
  ).toEqual({
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
    advisor: undefined,
    tier_id: 2,
    source: { tier: "task", provider: "only" },
  });
});

it("task の要求が agent の tier と同じ値でも出所は task —— 「誰が要求したか」は値の一致で消えない", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "economy", agentTier: "economy" }),
      table,
    ).source,
  ).toEqual({ tier: "task", provider: "only" });
});

it("task の要求ティアは advisor の導出にも効く —— main が Fable の行に動けば advisor はその具体 id", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: "frontier", agentTier: "economy", advisorCeiling: "fable" }),
      table,
    ).advisor,
  ).toBe("claude-fable-5-1");
});

/* ------------------------------------------------------------------ *
 * entry 集合からの選択(ADR 0110 決定1 / 決定5、issue #544)
 * ------------------------------------------------------------------ */

it("単一 entry の agent は今の挙動と一致し、出所は only —— 順位で選んだのではなく、それしか無かった", () => {
  expect(select(input({ entries: [{ provider: "openai", advisor: false }] }))).toEqual({
    provider: "openai",
    model: "gpt-5.6-terra",
    effort: "high",
    advisor: undefined,
    tier_id: 1,
    source: { tier: "board", provider: "only" },
  });
});

it("複数 entry は Provider 順位で選ばれ、出所は rank", () => {
  expect(
    select(
      input({
        entries: [
          { provider: "openai", advisor: false },
          { provider: "anthropic", advisor: false },
        ],
      }),
    ),
  ).toMatchObject({ provider: "anthropic", source: { tier: "board", provider: "rank" } });
});

it("Provider 順位は入力であって定数の並びではない —— 盤面境界が渡した順で決まる", () => {
  expect(
    select(
      input({
        entries: [
          { provider: "anthropic", advisor: false },
          { provider: "openai", advisor: false },
        ],
        providerRank: ["openai", "anthropic", "moonshot"],
      }),
    ).provider,
  ).toBe("openai");
});

it("温存中の Provider の entry は飛ばされ、除外されていない entry で走る(ADR 0110 決定5 の demo)", () => {
  expect(
    selectExecutionSetting(
      input({
        entries: [
          { provider: "anthropic", advisor: false },
          { provider: "openai", advisor: false },
        ],
      }),
      table,
      { providers: ["anthropic"], models: [] },
    ),
  ).toMatchObject({ provider: "openai", source: { provider: "rank" } });
});

it("モデル窓の除外は entry の解決した model に当たる —— 窓 fable は部分一致で claude-fable-5-1 の行に当たり(Throttle の窓は系列単位の枠、ADR 0182 決定3)、同じ Provider でもティアが違えば当たらない", () => {
  const excluded = { providers: [], models: [{ provider: "anthropic" as const, model: "fable" }] };
  expect(
    selectExecutionSetting(input({ agentTier: "frontier" }), table, excluded),
  ).toBeNull();
  expect(
    selectExecutionSetting(input({ agentTier: "standard" }), table, excluded)?.model,
  ).toBe("claude-opus-5-5");
});

/** Fable の窓が throttled の除外集合(Throttle の model 固有の窓の綴り)。 */
const fableWindow = { providers: [], models: [{ provider: "anthropic" as const, model: "fable" }] };

/** advisor つきの entry が、行1つの表で Fable の窓を除外されて選んだ advisor と出所。候補が残らなければ null。 */
function advisorUnderFableWindow(model: string, advisorCeiling: AdvisorCeiling) {
  const setting = selectExecutionSetting(
    input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "standard", advisorCeiling }),
    [cheapStandardRow(model)],
    fableWindow,
  );
  return setting && { advisor: setting.advisor, source: setting.source.advisor };
}

it("Fable の窓が除外のとき、上限 fable では advisor が fable の候補が外れ、fable_then_opus では advisor を opus(上限 opus と同じ導出)に下げた候補が出所「窓で下げた」で選ばれる(ADR 0208 決定5)", () => {
  for (const model of ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5"]) {
    expect(advisorUnderFableWindow(model, "fable")).toBeNull();
  }
  expect(advisorUnderFableWindow("claude-haiku-4-5", "fable_then_opus")).toEqual({ advisor: "opus", source: "window_downgraded" });
  expect(advisorUnderFableWindow("claude-sonnet-5-5", "fable_then_opus")).toEqual({ advisor: "opus", source: "window_downgraded" });
  expect(advisorUnderFableWindow("claude-opus-5-5", "fable_then_opus")).toEqual({ advisor: "claude-opus-5-5", source: "window_downgraded" });
  // Fable の行は main の窓で外れたまま —— 下げた候補を持たない
  for (const ceiling of ["fable", "fable_then_opus"] as const) expect(advisorUnderFableWindow("claude-fable-5-1", ceiling)).toBeNull();
  // advisor の無い entry は advisor の窓を見ない
  expect(selectExecutionSetting(input({ agentTier: "standard", advisorCeiling: "fable" }), table, fableWindow)?.model).toBe("claude-opus-5-5");
});

it("Fable の窓が開いているあいだ、fable_then_opus の下げた候補は先頭にも selectable な母集団にも現れない(ADR 0208 決定5)", () => {
  const db = openDb(":memory:");
  applyExecutionSettingsChange(db, { setting: "advisor_ceiling", value: "fable_then_opus" }, "webui", new Date());
  const candidates = executionSettingsFor(db, { provider: [{ name: "anthropic", advisor: true }], tier: "economy" }, undefined);
  const open = selectable(candidates, { providers: [], models: [] });
  expect(open.map((setting) => [setting.advisor, setting.source.advisor])).toEqual([["fable", "ceiling"]]);
  expect(selectable(candidates, fableWindow).map((setting) => [setting.advisor, setting.source.advisor])).toEqual([["opus", "window_downgraded"]]);
});

it("全 entry が除外されたら null —— 例外ではない(全除外は正常な skipped の枝であって設定の穴ではない)", () => {
  expect(
    selectExecutionSetting(
      input({
        entries: [
          { provider: "anthropic", advisor: false },
          { provider: "openai", advisor: false },
        ],
      }),
      table,
      { providers: ["anthropic", "openai"], models: [] },
    ),
  ).toBeNull();
});

it("advisor は entry ごとの宣言 —— 同じ agent でも経路が違えば advisor の有無が違う", () => {
  expect(
    select(
      input({
        entries: [
          { provider: "anthropic", advisor: true },
          { provider: "openai", advisor: false },
        ],
        advisorCeiling: "sonnet",
      }),
    ).advisor,
  ).toBe("claude-sonnet-5-5");
  expect(
    selectExecutionSetting(
      input({
        entries: [
          { provider: "anthropic", advisor: true },
          { provider: "openai", advisor: false },
        ],
      }),
      table,
      { providers: ["anthropic"], models: [] },
    ),
  ).toMatchObject({ provider: "openai", advisor: undefined });
});

/* ------------------------------------------------------------------ *
 * 優先順位は要求ティアの候補を並べる鍵(ADR 0114、issue #562)
 * ------------------------------------------------------------------ */

const both = [
  { provider: "anthropic" as const, advisor: false },
  { provider: "openai" as const, advisor: false },
];

it("quality(既定)は Provider 順位で並べる —— standard では順位が先の opus が価格の安い sol に勝ち、出所は rank", () => {
  expect(select(input({ entries: both, taskTier: "standard" }))).toMatchObject({
    provider: "anthropic",
    model: "claude-opus-5-5",
    source: { tier: "task", provider: "rank" },
  });
});

it("cost は価格で並べる —— standard では順位が後の sol(4 / 20)が opus(5 / 25)に勝ち、出所は cost", () => {
  expect(select(input({ entries: both, taskTier: "standard", priority: "cost" }))).toMatchObject({
    provider: "openai",
    model: "gpt-5.6-sol",
    source: { tier: "task", provider: "cost" },
  });
});

/** 同じ (provider, tier) に複数行、かつ Provider をまたいで同額の行がある表。 */
const crowded: ExecutionSettingTable = [
  { provider: "anthropic", tier: "standard", model: "opus", effort: "high", price_in: 5, price_out: 25 },
  { provider: "anthropic", tier: "standard", model: "opus-mini", effort: "high", price_in: 3, price_out: 20 },
  { provider: "anthropic", tier: "frontier", model: "fable", effort: "high", price_in: 10, price_out: 50 },
  { provider: "anthropic", tier: "frontier", model: "fable-lite", effort: "high", price_in: 6, price_out: 30 },
  { provider: "openai", tier: "standard", model: "gpt-5.6-sol", effort: "high", price_in: 4, price_out: 20 },
];

it("同じ Provider × ティアに複数行あれば、quality でも順位が同じ行の間は価格で決まる", () => {
  expect(select(input({ entries: both, taskTier: "standard" }), crowded)).toMatchObject({
    provider: "anthropic",
    model: "opus-mini",
  });
});

it("cost で out 単価が同額なら in 単価、それも同額なら Provider 順位で決まる", () => {
  // opus-mini(3 / 20)と sol(4 / 20)は out が同額 —— in の安い opus-mini が先
  expect(select(input({ entries: both, taskTier: "standard", priority: "cost" }), crowded).model).toBe("opus-mini");
  // 完全に同額なら順位 —— openai を先にすると sol
  const tied = crowded.map((row) => (row.model === "opus-mini" ? { ...row, price_in: 4 } : row));
  expect(
    select(input({ entries: both, taskTier: "standard", priority: "cost", providerRank: ["openai", "anthropic", "moonshot"] }), tied).model,
  ).toBe("gpt-5.6-sol");
});

it("並べ方は入力の priority だけで決まり、review の要求(reviewTier)があっても変わらない(ADR 0111 追記10)", () => {
  expect(select(input({ entries: both, reviewTier: "standard", priority: "cost" }))).toMatchObject({ model: "gpt-5.6-sol", source: { provider: "cost" } });
  expect(select(input({ entries: both, reviewTier: "standard", priority: "quality" }))).toMatchObject({ model: "claude-opus-5-5", source: { provider: "rank" } });
});

/** 段の id は盤面の内部(ADR 0200 決定2)。照合のテストは種の段に id を振って使う。 */
const TIERS = SEED_TIERS.map((tier, index) => ({ id: index + 1, ...tier }));
const tierId = (name: string) => TIERS.find((tier) => tier.name === name)!.id;
const renamed = (from: string, to: string) => TIERS.map((tier) => (tier.name === from ? { ...tier, name: to } : tier));
/** 段 `name` を消し、同じ名前・説明・位置の新しい段(別の id)を置いた一覧。 */
const withNew = (name: string) => TIERS.map((tier) => (tier.name === name ? { ...tier, id: 99 } : tier));
/** 段 `from` を `to` に改名し、空いた `from` の名前で新しい段を足した一覧。 */
const reusing = (from: string, to: string) => [...withNew(from), { ...TIERS.find((tier) => tier.name === from)!, name: to }];
const renameRows = (from: string, to: string) => SEED_EXECUTION_SETTINGS.map((row) => (row.tier === from ? { ...row, tier: to } : row));
const withTiers = (tierList: readonly { id: number; name: string; description: string }[]) => ({ table: SEED_EXECUTION_SETTINGS, learnerPromoted: false, tiers: tierList });

/** routing の行の提案(issue #918 / ADR 0150 決定1): pin はその行の全欄。段は id で焼く。 */
const opusRow = { provider: "anthropic", tier: "standard", model: "claude-opus-5-5", effort: "high", price_in: 5, price_out: 25 } as const;
const rowProposal: RoutingRowProposal = {
  kind: "routing",
  op: "row",
  row: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
  change: { tier: tierId("frontier") },
  pin: { ...opusRow, tier: tierId("standard") },
};

it("pin の照合は鍵 (provider, model, effort) で引いた行の全欄の一致で、崩れた欄の名前を返す —— 行が消えていれば(effort の書き換えも)null", () => {
  expect(routingPinChanges(rowProposal, { table: SEED_EXECUTION_SETTINGS, learnerPromoted: false, tiers: TIERS })).toEqual([]);
  const edit = (change: object) => SEED_EXECUTION_SETTINGS.map((row) => (row.model === "claude-opus-5-5" ? { ...row, ...change } : row));
  expect(routingPinChanges(rowProposal, { table: edit({ tier: "frontier", price_out: 30 }), learnerPromoted: false, tiers: TIERS })).toEqual(["tier", "price_out"]);
  expect(routingPinChanges(rowProposal, { table: edit({ effort: "max" }), learnerPromoted: false, tiers: TIERS })).toBeNull();
  // 別の行の編集は pin に触れない
  const other = SEED_EXECUTION_SETTINGS.map((row) => (row.model === "claude-sonnet-5-5" ? { ...row, tier: "standard" as const } : row));
  expect(routingPinChanges(rowProposal, { table: other, learnerPromoted: false, tiers: TIERS })).toEqual([]);
  expect(routingPinChanges(rowProposal, { table: SEED_EXECUTION_SETTINGS.filter((row) => row.model !== "claude-opus-5-5"), learnerPromoted: false, tiers: TIERS })).toBeNull();
});

it("行の pin の段は id で比べる —— 改名では崩れず、改名で空いた名前の新しい段に行が移れば tier が崩れる(issue #1436)", () => {
  expect(routingPinChanges(rowProposal, { table: renameRows("standard", "mid"), learnerPromoted: false, tiers: renamed("standard", "mid") })).toEqual([]);
  expect(routingPinChanges(rowProposal, { table: SEED_EXECUTION_SETTINGS, learnerPromoted: false, tiers: reusing("standard", "mid") })).toEqual(["tier"]);
});

it("行の提案は変更の段が一覧から消えると target_tier が崩れる —— 同じ名前の新しい段でも戻らず、改名・無関係な段の挿入 / 削除では崩れない(issue #1458)", () => {
  expect(routingPinChanges(rowProposal, withTiers(TIERS.filter((tier) => tier.name !== "frontier")))).toEqual(["target_tier"]);
  expect(routingPinChanges(rowProposal, withTiers(withNew("frontier")))).toEqual(["target_tier"]);
  expect(routingPinChanges(rowProposal, withTiers(renamed("frontier", "top")))).toEqual([]);
  expect(routingPinChanges(rowProposal, withTiers([...TIERS, { id: 4, name: "mid", description: "x" }]))).toEqual([]);
  expect(routingPinChanges(rowProposal, withTiers(TIERS.filter((tier) => tier.name !== "economy")))).toEqual([]);
});

it("昇格 / 降格の提案の pin はフラグの現在値 —— フラグが変われば learner_promoted が崩れ、表の編集では崩れない", () => {
  const settings = (learnerPromoted: boolean, t: ExecutionSettingTable = SEED_EXECUTION_SETTINGS) => ({ table: t, learnerPromoted, tiers: TIERS });
  const promote = { kind: "routing", op: "promote", pin: { promoted: false } } as const;
  const demote = { kind: "routing", op: "demote", pin: { promoted: true } } as const;
  expect(routingPinChanges(promote, settings(false, []))).toEqual([]);
  expect(routingPinChanges(promote, settings(true))).toEqual(["learner_promoted"]);
  expect(routingPinChanges(demote, settings(true))).toEqual([]);
  expect(routingPinChanges(demote, settings(false))).toEqual(["learner_promoted"]);
});

it("適用する行は pin の行に提案の変更、その上に修正値を重ねたもの(段は名前へ引いた提案で合成する)", () => {
  const named: RoutingRowProposal<string> = { ...rowProposal, change: { tier: "frontier" }, pin: opusRow };
  expect(composeRoutingRow(named)).toEqual({ ...opusRow, tier: "frontier" });
  expect(composeRoutingRow(named, { effort: "max" })).toEqual({ ...opusRow, tier: "frontier", effort: "max" });
  expect(composeRoutingRow(named, { tier: "economy" })).toEqual({ ...opusRow, tier: "economy" });
});

it("行の変更・修正値の形は tier / effort の少なくとも1つだけで、それ以外は DomainError", () => {
  expect(parseRoutingRowChange(tiers, { tier: "economy", effort: "low" })).toEqual({ tier: "economy", effort: "low" });
  for (const bad of [{}, { tier: "ultra" }, { effort: "" }, { tier: "economy", price_in: 1 }, "frontier", null]) {
    expect(() => parseRoutingRowChange(tiers, bad)).toThrow(DomainError);
  }
});

/** 段の説明の書き換えの提案(ADR 0200 決定7): pin は説明のいまの文面。 */
it("段の説明の提案の pin は id で引いた生きている段の説明 —— 文面が変われば description、段が無ければ null、改名・別の段・位置・表の編集では崩れない", () => {
  const proposal: TierDescriptionProposal = { kind: "routing", op: "tier_description", tier: tierId("standard"), description: "new", evidence: [7], pin: { description: SEED_TIERS[1]!.description } };
  const settings = (tierList: readonly { id: number; name: string; description: string }[], t: ExecutionSettingTable = SEED_EXECUTION_SETTINGS) => ({ table: t, learnerPromoted: false, tiers: tierList });
  const edit = (name: string, change: object) => TIERS.map((tier) => (tier.name === name ? { ...tier, ...change } : tier));
  expect(routingPinChanges(proposal, settings(TIERS))).toEqual([]);
  expect(routingPinChanges(proposal, settings(edit("standard", { description: "edited" })))).toEqual(["description"]);
  expect(routingPinChanges(proposal, settings(TIERS.filter((tier) => tier.name !== "standard")))).toBeNull();
  expect(routingPinChanges(proposal, settings(edit("economy", { description: "edited" })))).toEqual([]);
  expect(routingPinChanges(proposal, settings([...TIERS].reverse()))).toEqual([]);
  expect(routingPinChanges(proposal, settings(TIERS, SEED_EXECUTION_SETTINGS.filter((row) => row.tier !== "standard")))).toEqual([]);
  // 改名は同じ段。消した段の名前を使い直した新しい段(同じ説明)は別の段(issue #1436)
  expect(routingPinChanges(proposal, settings(renamed("standard", "mid")))).toEqual([]);
  expect(routingPinChanges(proposal, settings(withNew("standard")))).toBeNull();
});

/** agent の既定 tier の提案(issue #920 / ADR 0150 決定1・5): pin は (agent, tier)・下げ先がその1段下にいること(issue #1438)と根拠の episode が走った行。 */
const fableRow = { provider: "anthropic", model: "claude-fable-5-1", tier: "frontier", effort: "high" } as const;
const tierProposal: RegistryProposal = {
  kind: "registry",
  op: "agent_tier",
  agent: "deckhand",
  to: tierId("standard"),
  pin: { tier: tierId("frontier"), rows: [{ ...fableRow, tier: tierId("frontier") }] },
  evidence: [7],
};

it("下げ先の検査は、対象ティアに agent の entry のいずれかの行があるか", () => {
  const db = openDb(":memory:");
  expect(() => assertTierRunnableFor(db, "kimi", ["moonshot"], "economy")).not.toThrow();
  // moonshot に standard の行は無い —— entry が1つでも行があれば通る
  expect(() => assertTierRunnableFor(db, "kimi", ["moonshot"], "standard")).toThrow(/no row at standard/);
  expect(() => assertTierRunnableFor(db, "kimi", ["moonshot", "openai"], "standard")).not.toThrow();
  expect(() => assertTierRunnableFor(db, "kimi", [], "economy")).toThrow(/no row at economy/);
});

it("registry の提案の pin: 根拠の行は (provider, model) の tier / effort で照合し、agent は tier の値で照合する", () => {
  const settings = (t: ExecutionSettingTable) => ({ table: t, learnerPromoted: false, tiers: TIERS });
  expect(routingPinChanges(tierProposal, settings(SEED_EXECUTION_SETTINGS))).toEqual([]);
  // 根拠の行の effort が変わる・行が消える → rows が崩れる。価格や別の行の編集では崩れない
  const edit = (model: string, change: object) => SEED_EXECUTION_SETTINGS.map((row) => (row.model === model ? { ...row, ...change } : row));
  expect(routingPinChanges(tierProposal, settings(edit("claude-fable-5-1", { effort: "max" })))).toEqual(["rows"]);
  expect(routingPinChanges(tierProposal, settings(SEED_EXECUTION_SETTINGS.filter((row) => row.model !== "claude-fable-5-1")))).toEqual(["rows"]);
  expect(routingPinChanges(tierProposal, settings(edit("claude-fable-5-1", { price_out: 60 })))).toEqual([]);
  expect(routingPinChanges(tierProposal, settings(edit("claude-opus-5-5", { effort: "max" })))).toEqual([]);

  expect(registryPinChanges(tierProposal, { tier: "frontier" }, TIERS)).toEqual([]);
  expect(registryPinChanges(tierProposal, { tier: "standard" }, TIERS)).toEqual(["agent_tier"]);
  expect(registryPinChanges(tierProposal, {}, TIERS)).toEqual(["agent_tier"]);
  expect(registryPinChanges(tierProposal, undefined, TIERS)).toEqual(["agent_tier"]);
});

it("registry の提案の pin の段は id で比べる —— 改名(agent.md も新しい名前)では崩れず、空いた名前の新しい段は別の段(issue #1436)", () => {
  expect(routingPinChanges(tierProposal, { table: renameRows("frontier", "top"), learnerPromoted: false, tiers: renamed("frontier", "top") })).toEqual([]);
  expect(registryPinChanges(tierProposal, { tier: "top" }, renamed("frontier", "top"))).toEqual([]);
  expect(routingPinChanges(tierProposal, { table: SEED_EXECUTION_SETTINGS, learnerPromoted: false, tiers: reusing("frontier", "top") })).toEqual(["rows", "tier_order"]);
  expect(registryPinChanges(tierProposal, { tier: "frontier" }, reusing("frontier", "top"))).toEqual(["agent_tier"]);
});

it("registry の提案は to が pin の段のいまの1段下にいる間だけ生きている —— 間への挿入・to を上へ並べ替え・どちらかの段の削除で tier_order が崩れる(issue #1438)", () => {
  const [economy, standard, frontier] = TIERS;
  const mid = { id: 4, name: "mid", description: "x" };
  expect(routingPinChanges(tierProposal, withTiers([economy!, standard!, mid, frontier!]))).toEqual(["tier_order"]);
  expect(routingPinChanges(tierProposal, withTiers([economy!, frontier!, standard!]))).toEqual(["tier_order"]);
  // 外側への挿入・隣接を保つ並べ替えでは崩れない
  expect(routingPinChanges(tierProposal, withTiers([mid, economy!, standard!, frontier!]))).toEqual([]);
  expect(routingPinChanges(tierProposal, withTiers([...TIERS, mid]))).toEqual([]);
  expect(routingPinChanges(tierProposal, withTiers([standard!, frontier!, economy!]))).toEqual([]);
  // pin の段・to の段の削除
  expect(routingPinChanges(tierProposal, withTiers([economy!, standard!]))).toContain("tier_order");
  expect(routingPinChanges(tierProposal, withTiers([economy!, frontier!]))).toContain("tier_order");
  expect(routingPinChanges(tierProposal, withTiers([frontier!, economy!]))).toContain("tier_order");
});

it("tier の提案の修正値は to だけで、pin の tier より下の任意のティア —— 同位・上位・それ以外の欄は DomainError", () => {
  const named: RegistryProposal<string> = { ...tierProposal, to: "standard", pin: { tier: "frontier", rows: [fableRow] } };
  expect(parseAgentTierAmendment(tiers, named, { to: "economy" })).toBe("economy");
  expect(parseAgentTierAmendment(tiers, named, { to: "standard" })).toBe("standard");
  for (const bad of [{ to: "frontier" }, { to: "ultra" }, { to: "economy", effort: "low" }, {}, "economy"]) {
    expect(() => parseAgentTierAmendment(tiers, named, bad)).toThrow(DomainError);
  }
});

/** 段を足して行を移す提案(issue #1424 / ADR 0200 決定8): pin は移す行の全欄と、提案時点の位置の隣の段(id と説明)。 */
const [economy, standard, frontier] = TIERS;
const sonnetRow = SEED_EXECUTION_SETTINGS.find((row) => row.model === "claude-sonnet-5-5")!;
const neighbour = (tier: { id: number; description: string } | undefined) => (tier ? { id: tier.id, description: tier.description } : null);
const addTier = (position: number): RoutingProposal => ({
  kind: "routing",
  op: "add_tier",
  tier: { name: "routine", description: "Work one step above routine wiring.", position },
  row: { provider: sonnetRow.provider, model: sonnetRow.model, effort: sonnetRow.effort },
  evidence: [7],
  pin: { row: { ...sonnetRow, tier: tierId(sonnetRow.tier) }, below: neighbour(TIERS[position - 1]), above: neighbour(TIERS[position]) },
});
const tierSettings = (tierList: readonly { id: number; name: string; description: string }[], t: ExecutionSettingTable = SEED_EXECUTION_SETTINGS) => ({
  table: t,
  learnerPromoted: false,
  tiers: tierList,
});

it("段を足す提案の pin: 移す行は全欄、隣の段は提案時点の添字にいまいる段の id と説明で照合する", () => {
  expect(routingPinChanges(addTier(1), tierSettings(TIERS))).toEqual([]);
  // 移す行の編集・削除
  const edit = (change: object) => SEED_EXECUTION_SETTINGS.map((row) => (row.model === sonnetRow.model ? { ...row, ...change } : row));
  expect(routingPinChanges(addTier(1), tierSettings(TIERS, edit({ price_in: 9 })))).toEqual(["price_in"]);
  expect(routingPinChanges(addTier(1), tierSettings(TIERS, edit({ effort: "max" })))).toBeNull();
  // 隣の段の説明の編集は崩す。改名は同じ段なので崩さない(issue #1436)
  expect(routingPinChanges(addTier(1), tierSettings([{ ...economy!, description: "changed" }, standard!, frontier!]))).toEqual(["neighbours"]);
  expect(routingPinChanges(addTier(1), tierSettings([economy!, { ...standard!, name: "middle" }, frontier!]))).toEqual([]);
  // 隣の段を消して同じ名前・同じ説明の新しい段を置いても、別の段なので崩れる
  expect(routingPinChanges(addTier(1), tierSettings(withNew("standard")))).toEqual(["neighbours"]);
  // 下に段が挿入されて添字がずれる
  expect(routingPinChanges(addTier(1), tierSettings([{ id: 4, name: "lowest", description: "x" }, ...TIERS]))).toEqual(["neighbours"]);
  // 隣でない段の説明の編集は崩さない
  expect(routingPinChanges(addTier(1), tierSettings([economy!, standard!, { ...frontier!, description: "changed" }]))).toEqual([]);
});

it("段を足す提案の pin の端: 先頭なら下、末尾なら上の隣は null で、端の外に段が来ても崩れる", () => {
  expect(routingPinChanges(addTier(0), tierSettings(TIERS))).toEqual([]);
  expect(routingPinChanges(addTier(3), tierSettings(TIERS))).toEqual([]);
  expect(routingPinChanges(addTier(3), tierSettings([...TIERS, { id: 4, name: "top", description: "x" }]))).toEqual(["neighbours"]);
  expect(routingPinChanges(addTier(3), tierSettings(TIERS.slice(0, 2)))).toEqual(["neighbours"]);
  expect(routingPinChanges(addTier(0), tierSettings([{ id: 4, name: "lowest", description: "x" }, ...TIERS]))).toEqual(["neighbours"]);
});

it("段を足す提案の修正値は名前・説明・位置の少なくとも1つだけで、それ以外は DomainError", () => {
  expect(parseAddTierAmendment({ name: "routine", position: 0 })).toEqual({ name: "routine", position: 0 });
  for (const bad of [{}, { name: "x", tier: "economy" }, { position: -1 }, { position: 1.5 }, "routine", null]) {
    expect(() => parseAddTierAmendment(bad)).toThrow(DomainError);
  }
});

it("存在しない行の削除は何も変えないので、操作イベントを残さず null を返す", () => {
  const db = openDb(":memory:");
  expect(applyExecutionSettingsChange(db, { setting: "delete_row", provider: "openai", model: "no-such-model", effort: "high" }, "webui", new Date())).toBeNull();
});

// ── 行の拒否(ADR 0184 決定2): 表の行の Quarantine が開いている行は候補にならない。advisor は行でないので Quarantine を見ない(ADR 0200 決定6) ──

/** 盤面の表(種)に行を足し、指定した (provider, model) の行の Quarantine を開く。 */
function boardWithRefusedRows(extraRows: ExecutionSettingTable, refused: Array<[Provider, string]>) {
  const db = openDb(":memory:");
  const now = new Date();
  for (const row of extraRows) applyExecutionSettingsChange(db, { setting: "row", row }, "webui", now);
  applyExecutionSettingsChange(db, { setting: "advisor_ceiling", value: "fable" }, "webui", now);
  for (const [provider, model] of refused) registerQuarantine(db, "tableRow", tableRowValue(provider, model), "refused", now);
  return db;
}
const anthropicAgent = (advisor: boolean) => ({ provider: [{ name: "anthropic", advisor }], tier: undefined });
const workAt = (tier: Tier) => ({ type: "work" as const, tier, priority: null, review_tier: null });

it("行の Quarantine の照合は完全一致 —— claude-opus-5 の Quarantine は claude-opus-5-5 の行を外さない", () => {
  const db = boardWithRefusedRows(
    [{ provider: "anthropic", tier: "standard", model: "claude-opus-5", effort: "high", price_in: 4, price_out: 20 }],
    [["anthropic", "claude-opus-5"]],
  );
  expect(executionSettingsFor(db, anthropicAgent(false), workAt("standard")).map((s) => s.model)).toEqual(["claude-opus-5-5"]);
});

it("Fable の行が Quarantine 中でも、ほかの行の advisor は `fable` のまま", () => {
  const db = boardWithRefusedRows([], [["anthropic", "claude-fable-5-1"]]);
  expect(executionSettingsFor(db, anthropicAgent(true), workAt("standard"))).toMatchObject([{ model: "claude-opus-5-5", advisor: "fable" }]);
});

const sonnet5 = { provider: "anthropic", tier: "economy", model: "claude-sonnet-5", effort: "high", price_in: 3, price_out: 15 } as const;

it("表の行で走る Board call(振り返り・下書き)は走れる行の最安で撃つ —— 最安の行が Quarantine 中なら同じティアの次の行", () => {
  const db = boardWithRefusedRows([sonnet5], [["anthropic", "claude-sonnet-5-5"]]);
  expect(boardCallRow(db, "economy")).toMatchObject({ model: "claude-sonnet-5" });
});

it("そのティアの anthropic の行がすべて Quarantine 中なら、Board call の行は Quarantine を名指して投げ、行が無いときと区別する", () => {
  const db = boardWithRefusedRows([sonnet5], [["anthropic", "claude-sonnet-5-5"], ["anthropic", "claude-sonnet-5"]]);
  // 行が無いときの文面(quarantine を含まない)は tests/claude-draft-client.test.ts が釘付けている
  expect(() => boardCallRow(db, "economy")).toThrow(/under a row quarantine/);
});

/** Anthropic の窓を閉じる観測を1件置く。`model` を省くと Provider 全体の窓(model 固有の窓は部分一致で当たる)。 */
function closeAnthropicWindow(db: Db, model?: string) {
  const now = new Date();
  const until = new Date(now.getTime() + 60 * 60 * 1000);
  reportProviderUsage(db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: now,
    windows: [{ window: model ?? "five_hour", model: model ?? null, usedPercent: 100, durationMs: 60 * 60 * 1000, resetsAt: until, throttled: true, resumesAt: until }],
  });
}

it("Board call の行は、最安の行の model 固有の窓だけが閉じていれば同じティアの次に安い行(#1445)", () => {
  const db = boardWithRefusedRows([sonnet5], []);
  closeAnthropicWindow(db, "sonnet-5-5");
  expect(boardCallRow(db, "economy")).toMatchObject({ model: "claude-sonnet-5" });
});

it("そのティアの走れる行すべてで窓が閉じていれば、Board call の行は窓を名指して投げる(model 固有の窓・Provider 全体の窓)", () => {
  const byModel = boardWithRefusedRows([sonnet5], []);
  closeAnthropicWindow(byModel, "sonnet-5");
  expect(() => boardCallRow(byModel, "economy")).toThrow("the Anthropic window is closed");

  const providerWide = boardWithRefusedRows([sonnet5], []);
  closeAnthropicWindow(providerWide);
  expect(() => boardCallRow(providerWide, "economy")).toThrow("the Anthropic window is closed");
});

it("最安の行が Quarantine 中で残りの行すべてで窓が閉じていれば、理由は Quarantine でなく窓", () => {
  const db = boardWithRefusedRows([sonnet5], [["anthropic", "claude-sonnet-5-5"]]);
  closeAnthropicWindow(db, "claude-sonnet-5");
  expect(() => boardCallRow(db, "economy")).toThrow("the Anthropic window is closed");
});

it("行がすべて Quarantine 中なら、窓が閉じていても理由は Quarantine のまま", () => {
  const db = boardWithRefusedRows([sonnet5], [["anthropic", "claude-sonnet-5-5"], ["anthropic", "claude-sonnet-5"]]);
  closeAnthropicWindow(db);
  expect(() => boardCallRow(db, "economy")).toThrow(/under a row quarantine/);
});

// ── 1つの段に同じ model は1行まで(ADR 0200 決定5 / issue #1419): 行の鍵は (provider, model, effort) ──

const opusMax = { provider: "anthropic", tier: "frontier", model: "claude-opus-5-5", effort: "max", price_in: 5, price_out: 25 } as const;
const opusKey = (effort: string) => ({ provider: "anthropic", model: "claude-opus-5-5", effort }) as const;
/** 種の表に opus の max 行を frontier へ足した盤面。 */
function boardWithOpusMax() {
  const db = openDb(":memory:");
  applyExecutionSettingsChange(db, { setting: "row", row: opusMax }, "webui", new Date());
  return db;
}
const opusRows = (db: ReturnType<typeof openDb>) => readExecutionSettings(db).table.filter((row) => row.model === "claude-opus-5-5");

it("同じ model を effort 違いで別の段に2行置け、それぞれの段の要求でその行が選ばれる", () => {
  const db = boardWithOpusMax();
  expect(executionSettingsFor(db, anthropicAgent(false), workAt("standard"))[0]).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  expect(executionSettingsFor(db, anthropicAgent(false), workAt("frontier"))[0]).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
});

it("行を書く扉は、同じ段に同じ model の2行目と、同じ (model, effort) の2行目の追加を拒み、表は変わらない", () => {
  const db = openDb(":memory:");
  const add = (row: ExecutionSettingTable[number]) => applyExecutionSettingsChange(db, { setting: "row", row }, "webui", new Date());
  expect(() => add({ ...opusRow, effort: "max" })).toThrow(/one row per model/);
  expect(() => add({ ...opusRow, tier: "frontier" })).toThrow(/belongs to one tier/);
  expect(opusRows(db)).toEqual([opusRow]);
});

it("行を書く扉は、どの provider の行でも語彙の外の effort を拒んで表を変えず、5値は通す(ADR 0216 決定3)", () => {
  const seedOf = (provider: Provider) => SEED_EXECUTION_SETTINGS.find((row) => row.provider === provider)!;
  const writeEffort = (db: Db, provider: Provider, effort: string) => {
    const row = seedOf(provider);
    applyExecutionSettingsChange(db, { setting: "row", key: { provider, model: row.model, effort: row.effort }, row: { ...row, effort } }, "webui", new Date());
  };
  for (const provider of ["anthropic", "moonshot", "openai"] as const) {
    const db = openDb(":memory:");
    for (const effort of ["ultra", "minimal", "bogus"]) {
      expect(() => writeEffort(db, provider, effort)).toThrow(DomainError);
    }
    expect(readExecutionSettings(db).table).toEqual(readExecutionSettings(openDb(":memory:")).table);
    for (const effort of ["low", "medium", "high", "xhigh", "max"]) {
      const fresh = openDb(":memory:");
      writeEffort(fresh, provider, effort);
      expect(readExecutionSettings(fresh).table).toContainEqual({ ...seedOf(provider), effort });
    }
  }
});

it("鍵つきの編集は名指した行が無ければ、また effort / tier の書き換えが別の行と衝突すれば拒まれ、表は変わらない", () => {
  const db = boardWithOpusMax();
  const edit = (key: ReturnType<typeof opusKey>, row: ExecutionSettingTable[number]) =>
    applyExecutionSettingsChange(db, { setting: "row", key, row }, "webui", new Date());
  expect(() => edit(opusKey("high"), { ...opusRow, effort: "max" })).toThrow(DomainError);
  expect(() => edit(opusKey("high"), { ...opusRow, tier: "frontier" })).toThrow(DomainError);
  expect(() => edit(opusKey("low"), opusRow)).toThrow(/no row/);
  expect(opusRows(db)).toEqual([opusRow, opusMax]);
});

it("鍵つきの編集は、同じ model の2行のうち名指した行だけを変える —— effort を書き換えても別の行と衝突しなければ通る", () => {
  const db = boardWithOpusMax();
  applyExecutionSettingsChange(db, { setting: "row", key: opusKey("high"), row: { ...opusRow, effort: "low", price_out: 30 } }, "webui", new Date());
  expect(opusRows(db)).toEqual([{ ...opusRow, effort: "low", price_out: 30 }, opusMax]);
  applyExecutionSettingsChange(db, { setting: "delete_row", ...opusKey("max") }, "webui", new Date());
  expect(opusRows(db)).toEqual([{ ...opusRow, effort: "low", price_out: 30 }]);
});

/** routing meta-review を1つ登録し、その子に opus の `effort` の行の提案を立てる。 */
function proposeOnOpus(db: ReturnType<typeof openDb>, effort: string, change: object) {
  const now = new Date();
  registerMetaReview(db, "routing", now);
  const review = (db.prepare("SELECT id FROM tasks WHERE meta_review_subject = 'routing'").get() as { id: string }).id;
  const { question_id } = proposeRoutingChange(db, review, { op: "row", row: opusKey(effort), change, rationale: "r" }, "auditor", now);
  const answer = (amendment?: object) =>
    submitAnswer({ db, pollNow() {}, landing: unusedLanding }, getTask(db, question_id)!, ["approve"], undefined, () => now, "webui", false, amendment);
  return { question_id, answer };
}

it("行の提案は3欄で名指した行を pin し、その承認は同じ model の2行のうち名指した行だけを変える", async () => {
  const db = boardWithOpusMax();
  const { answer } = proposeOnOpus(db, "max", { effort: "xhigh" });
  await answer();
  expect(opusRows(db)).toEqual([opusRow, { ...opusMax, effort: "xhigh" }]);
});

it("提案は合成した行が別の行と衝突すれば立たず、承認は修正値が衝突すれば回答ごと巻き戻って question は open のまま", async () => {
  const db = boardWithOpusMax();
  expect(() => proposeOnOpus(db, "max", { tier: "standard" })).toThrow(DomainError);
  const { question_id, answer } = proposeOnOpus(db, "max", { effort: "low" });
  await expect(answer({ effort: "high" })).rejects.toThrow(DomainError);
  expect(getTask(db, question_id)).toMatchObject({ status: "todo" });
  expect(opusRows(db)).toEqual([opusRow, opusMax]);
});

it("語彙の外の effort への行の提案は作る時点で拒まれ、question は立たない(ADR 0216 決定3)", () => {
  const db = boardWithOpusMax();
  expect(() => proposeOnOpus(db, "max", { effort: "ultra" })).toThrow(DomainError);
  const review = (db.prepare("SELECT id FROM tasks WHERE meta_review_subject = 'routing'").get() as { id: string }).id;
  expect(listChildren(db, review)).toEqual([]);
});

it("承認に添える語彙の外の effort の修正値は拒まれ、行は変わらず question は open のまま(ADR 0216 決定3)", async () => {
  const db = boardWithOpusMax();
  const { question_id, answer } = proposeOnOpus(db, "max", { effort: "xhigh" });
  await expect(answer({ effort: "ultra" })).rejects.toThrow(DomainError);
  expect(getTask(db, question_id)).toMatchObject({ status: "todo" });
  expect(opusRows(db)).toEqual([opusRow, opusMax]);
});

it("行の Quarantine の鍵は (provider, model) で、effort 違いの行も候補から外れる", () => {
  const db = boardWithRefusedRows([opusMax], [["anthropic", "claude-opus-5-5"]]);
  expect(executionSettingsFor(db, anthropicAgent(false), workAt("standard"))).toEqual([]);
  expect(executionSettingsFor(db, anthropicAgent(false), workAt("frontier")).map((s) => s.model)).toEqual(["claude-fable-5-1"]);
});

// ── 段の編集(ADR 0200 決定2・3 / issue #1421): 挿入・説明と位置の編集・削除・盤面既定の段 ──

const at = new Date();
const change = (db: ReturnType<typeof openDb>, c: ExecutionSettingsChange) => applyExecutionSettingsChange(db, c, "webui", at);
const premium = { name: "premium", description: "Work only the newest frontier model gets right." };

it("段は一覧の任意の位置に挿入でき、読み口と tool の説明が順序どおりに並べる", () => {
  const db = openDb(":memory:");
  change(db, { setting: "insert_tier", ...premium, position: 2 });
  expect(tierNames(db)).toEqual(["economy", "standard", "premium", "frontier"]);
  expect(tierFieldDescriptions(db).tier).toContain(
    "standard — Work where the approach has to be worked out: a multi-file implementation or a larger refactor.\n" +
      "premium — Work only the newest frontier model gets right.\n" +
      "frontier — ",
  );
  change(db, { setting: "insert_tier", name: "trivial", description: "One-line edits.", position: 0 });
  expect(tierNames(db)).toEqual(["trivial", "economy", "standard", "premium", "frontier"]);
});

it("段の説明と位置を名前で名指して直せる", () => {
  const db = openDb(":memory:");
  change(db, { setting: "edit_tier", name: "economy", description: "Mechanical edits." });
  change(db, { setting: "edit_tier", name: "frontier", position: 0 });
  expect(readTiers(db)).toEqual([
    { name: "frontier", description: SEED_TIERS[2]!.description },
    { name: "economy", description: "Mechanical edits." },
    { name: "standard", description: SEED_TIERS[1]!.description },
  ]);
  change(db, { setting: "edit_tier", name: "frontier", position: 2 });
  expect(tierNames(db)).toEqual(["economy", "standard", "frontier"]);
});

it("空・複数行の説明、重複・agent.md に書けない名前、一覧の外の位置、無い段の編集は拒まれ、一覧は変わらない", () => {
  const db = openDb(":memory:");
  const before = readTiers(db);
  for (const bad of [
    { ...premium, description: "" },
    { ...premium, description: "line one\nline two" },
    { ...premium, name: "standard" },
    { ...premium, name: "has space" },
    { ...premium, name: "true" },
    { ...premium, name: "" },
  ]) {
    expect(() => change(db, { setting: "insert_tier", ...bad, position: 0 })).toThrow(DomainError);
  }
  expect(() => change(db, { setting: "insert_tier", ...premium, position: 4 })).toThrow(DomainError);
  expect(() => change(db, { setting: "edit_tier", name: "economy", description: "a\nb" })).toThrow(DomainError);
  expect(() => change(db, { setting: "edit_tier", name: "economy", position: 3 })).toThrow(DomainError);
  expect(() => change(db, { setting: "edit_tier", name: "premium", description: "x" })).toThrow(/unknown tier "premium" — one of economy, standard, frontier/);
  expect(readTiers(db)).toEqual(before);
});

it("行のある段・盤面設定が指す段・未決着の task が要求している段は、理由を添えて削除を拒まれる", () => {
  const db = openDb(":memory:");
  expect(() => change(db, { setting: "delete_tier", name: "standard" })).toThrow(/execution-setting rows: anthropic \/ claude-opus-5-5/);
  expect(() => change(db, { setting: "delete_tier", name: "economy" })).toThrow(/the board's default tier/);
  expect(() => change(db, { setting: "delete_tier", name: "frontier" })).toThrow(/the board's judgement tier/);

  change(db, { setting: "insert_tier", ...premium, position: 3 });
  const work = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c", tier: "premium" }, at, ...HUMAN_WEBUI);
  const review = registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c", review_tier: "premium" }, at, ...HUMAN_WEBUI);
  expect(() => change(db, { setting: "delete_tier", name: "premium" })).toThrow(new RegExp(`unsettled tasks request it: ${work.id}, ${review.id}`));
  expect(tierNames(db)).toContain("premium");
});

// ── agent.md が名指す段(ADR 0200 追記 2026-10-06 / issue #1431): 手元の clone の一覧を読んで断る ──

const deletePremium = { setting: "delete_tier", name: "premium" } as const;

it("registry の agent.md が名指す段は、その agent 名を添えて削除を拒まれ、一覧に残る", async () => {
  const db = openDb(":memory:");
  change(db, { setting: "insert_tier", ...premium, position: 3 });
  const agents = () => [{ name: "kimi", tier: "premium" }, { name: "opus", tier: "premium" }, { name: "plain" }];
  await expect(changeExecutionSettings(db, deletePremium, "webui", at, undefined, agents)).rejects.toThrow(/agents name it in agent\.md: kimi, opus/);
  expect(tierNames(db)).toContain("premium");
});

it("agent.md が別の段を名指すか段を名指さなければ、その段は消せる", async () => {
  const db = openDb(":memory:");
  change(db, { setting: "insert_tier", ...premium, position: 3 });
  await changeExecutionSettings(db, deletePremium, "webui", at, undefined, () => [{ name: "kimi", tier: "economy" }, { name: "plain" }]);
  expect(tierNames(db)).not.toContain("premium");
});

it("registry の一覧が読めなければ、段の削除は拒まれる", async () => {
  const db = openDb(":memory:");
  change(db, { setting: "insert_tier", ...premium, position: 3 });
  const unreadable = () => {
    throw new Error("registry clone is broken");
  };
  await expect(changeExecutionSettings(db, deletePremium, "webui", at, undefined, unreadable)).rejects.toThrow(DomainError);
  expect(tierNames(db)).toContain("premium");
});

it("決着した task だけが要求した段は消せ、その task は消した段の名前を読み続け、名前は挿入し直せる", () => {
  const db = openDb(":memory:");
  change(db, { setting: "insert_tier", ...premium, position: 1 });
  const task = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c", tier: "premium" }, at, ...HUMAN_WEBUI);
  cancelTaskDirectly(db, task, null, at, {}, "webui");
  change(db, { setting: "delete_tier", name: "premium" });
  expect(tierNames(db)).toEqual(["economy", "standard", "frontier"]);
  expect(getTask(db, task.id)).toMatchObject({ tier: "premium" });
  expect(() => assertKnownTier(db, "tier", "premium")).toThrow('unknown tier "premium" — one of economy, standard, frontier');

  change(db, { setting: "insert_tier", name: "premium", description: "Again.", position: 3 });
  expect(readTiers(db).at(-1)).toEqual({ name: "premium", description: "Again." });
  expect(getTask(db, task.id)).toMatchObject({ tier: "premium" });
});

it("盤面既定の段を選び直すと、要求も agent の tier も無い task はその段の行で解決される", () => {
  const db = openDb(":memory:");
  change(db, { setting: "default_tier", value: "standard" });
  expect(readExecutionSettings(db).defaultTier).toBe("standard");
  expect(executionSettingsFor(db, anthropicAgent(false), { type: "work", tier: null, priority: null, review_tier: null })[0]).toMatchObject({
    model: "claude-opus-5-5",
    source: { tier: "board" },
  });
  expect(() => change(db, { setting: "default_tier", value: "premium" })).toThrow(/unknown default_tier "premium"/);
});

it("review 用の優先順位の既定は種 quality で、設定変更が読み口と execution_settings_changed に残り、quality / cost 以外は断られる(ADR 0111 追記10)", () => {
  const db = openDb(":memory:");
  expect(readExecutionSettings(db).reviewPriority).toBe("quality");
  change(db, { setting: "review_priority", value: "cost" });
  expect(readExecutionSettings(db)).toMatchObject({ reviewPriority: "cost", priority: "quality" });
  expect(listEventsOfKinds(db, ["execution_settings_changed"]).at(-1)!.payload).toMatchObject({ setting: "review_priority", value: "cost" });
  expect(executionSettingsChangeSchema.safeParse({ setting: "review_priority", value: "speed" }).success).toBe(false);
});

/** anthropic と openai の2つの entry を持ち、standard を既定の段にする agent(review_tier の無い review も standard で走る)。 */
const twoProviderAgent = { provider: [{ name: "anthropic", advisor: false }, { name: "openai", advisor: false }], tier: "standard" };
const reviewTasks = [
  { type: "review" as const, tier: null, priority: null, review_tier: "standard" },
  { type: "review" as const, tier: null, priority: null, review_tier: null },
];

it("review task は review_tier の有無によらず review 用の既定で並び、work 用の既定を cost にしても判定者は動かない(ADR 0111 追記10)", () => {
  const db = openDb(":memory:");
  change(db, { setting: "priority", value: "cost" });
  for (const task of reviewTasks) {
    expect(executionSettingsFor(db, twoProviderAgent, task)[0]).toMatchObject({ model: "claude-opus-5-5", source: { provider: "rank" } });
  }
  change(db, { setting: "review_priority", value: "cost" });
  for (const task of reviewTasks) {
    expect(executionSettingsFor(db, twoProviderAgent, task)[0]).toMatchObject({ model: "gpt-5.6-sol", source: { provider: "cost" } });
  }
});

it("work task は task の priority → work 用の既定で並び、review 用の既定を読まない", () => {
  const db = openDb(":memory:");
  change(db, { setting: "review_priority", value: "cost" });
  const work = (priority: "quality" | "cost" | null) => ({ type: "work" as const, tier: null, priority, review_tier: null });
  expect(executionSettingsFor(db, twoProviderAgent, work(null))[0]).toMatchObject({ model: "claude-opus-5-5" });
  expect(executionSettingsFor(db, twoProviderAgent, work("cost"))[0]).toMatchObject({ model: "gpt-5.6-sol" });
  change(db, { setting: "priority", value: "cost" });
  expect(executionSettingsFor(db, twoProviderAgent, work(null))[0]).toMatchObject({ model: "gpt-5.6-sol" });
  expect(executionSettingsFor(db, twoProviderAgent, work("quality"))[0]).toMatchObject({ model: "claude-opus-5-5" });
});

it("挿入した段の名前を書いた agent.md の tier は定義の検査を通る", () => {
  const db = openDb(":memory:");
  change(db, { setting: "insert_tier", ...premium, position: 3 });
  expect(() => assertValidAgentDefinition("a", { provider: [{ name: "anthropic", advisor: false }], tier: "premium" }, tierNames(db))).not.toThrow();
});

// ── 段の改名(ADR 0200 決定2 / issue #1422): 盤面は id で段を指し、agent.md の tier だけを名前で書き換える ──

const renameStandard = (to: string) => ({ setting: "rename_tier", name: "standard", to }) as const;
const tierRequest = { title: "t", purpose: "p", completion_criteria: "c" };

it("段を改名しても、その段の行・task の要求・盤面設定は同じ段を指したまま新しい名前で読まれ、agent.md の書き換えは旧い名前から新しい名前へ呼ばれる", async () => {
  const db = openDb(":memory:");
  change(db, { setting: "default_tier", value: "standard" });
  change(db, { setting: "judgement_tier", value: "standard" });
  const work = registerTask(db, { type: "work", ...tierRequest, tier: "standard" }, at, ...HUMAN_WEBUI);
  const review = registerTask(db, { type: "review", ...tierRequest, review_tier: "standard" }, at, ...HUMAN_WEBUI);
  const rows = readExecutionSettings(db).table.filter((row) => row.tier === "standard");
  const rewrite = vi.fn(async () => {});

  await changeExecutionSettings(db, renameStandard("mid"), "webui", at, rewrite);

  expect(rewrite).toHaveBeenCalledWith(expect.objectContaining({ from: "standard", to: "mid" }));
  expect(tierNames(db)).toEqual(["economy", "mid", "frontier"]);
  expect(readExecutionSettings(db).table.filter((row) => row.tier === "mid")).toEqual(rows.map((row) => ({ ...row, tier: "mid" })));
  expect(readExecutionSettings(db)).toMatchObject({ defaultTier: "mid", judgementTier: "mid" });
  expect(getTask(db, work.id)).toMatchObject({ tier: "mid" });
  expect(getTask(db, review.id)).toMatchObject({ review_tier: "mid" });
  expect(listEventsOfKinds(db, ["execution_settings_changed"]).at(-1)!.payload).toMatchObject(renameStandard("mid"));
});

it("改名のあとに旧い名前を書いた要求は未知の段として拒まれ、エラーがいまの一覧を返す", async () => {
  const db = openDb(":memory:");
  await changeExecutionSettings(db, renameStandard("mid"), "webui", at);
  expect(() => registerTask(db, { type: "work", ...tierRequest, tier: "standard" }, at, ...HUMAN_WEBUI)).toThrow(
    'unknown tier "standard" — one of economy, mid, frontier',
  );
});

it("agent.md の書き換えが投げたら改名は成立せず、段の名前は変わらず操作イベントも残らない", async () => {
  const db = openDb(":memory:");
  const failing = async () => {
    throw new RegistryPushFailedError("remote rejected");
  };
  await expect(changeExecutionSettings(db, renameStandard("mid"), "webui", at, failing)).rejects.toThrow(DomainError);
  expect(tierNames(db)).toEqual(["economy", "standard", "frontier"]);
  expect(listEventsOfKinds(db, ["execution_settings_changed"])).toEqual([]);
});

it("新しい名前は挿入と同じ検査を通り、無い段・重複・agent.md に書けない名前は agent.md を書き換える前に拒まれる", async () => {
  const db = openDb(":memory:");
  const rewrite = vi.fn(async () => {});
  for (const bad of [
    { name: "premium", to: "mid" },
    { name: "standard", to: "economy" },
    { name: "standard", to: "standard" },
    { name: "standard", to: "Has Space" },
    { name: "standard", to: "true" },
  ]) {
    await expect(changeExecutionSettings(db, { setting: "rename_tier", ...bad }, "webui", at, rewrite)).rejects.toThrow(DomainError);
  }
  expect(rewrite).not.toHaveBeenCalled();
  expect(tierNames(db)).toEqual(["economy", "standard", "frontier"]);
});

it("tier descriptions trim surrounding whitespace before the one-line rule and persistence", () => {
  const db = openDb(":memory:");
  applyExecutionSettingsChange(db, { setting: "insert_tier", name: "custom", description: " description\n", position: 1 }, "webui", new Date(0));
  expect(readTiers(db).find((tier) => tier.name === "custom")?.description).toBe("description");
});
