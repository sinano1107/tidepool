import { expect, it, vi } from "vitest";
import { isClaudeModelAlias } from "../src/claude-model-alias.js";
import { type Db, openDb } from "../src/db.js";
import { listEventsOfKinds } from "../src/events.js";
import {
  applyExecutionSettingsChange,
  assertKnownTier,
  assertTierRunnableFor,
  BOARD_DEFAULT_PRIORITY,
  changeExecutionSettings,
  composeRoutingRow,
  type ExecutionSetting,
  type ExecutionSettingsChange,
  type ExecutionSettingTable,
  executionSettingsFor,
  PRIORITIES,
  parseAddTierAmendment,
  parseAgentTierAmendment,
  parseRoutingRowChange,
  readExecutionSettings,
  readTiers,
  registryPinChanges,
  resolveExecutionSetting,
  routingPinChanges,
  SEED_EXECUTION_SETTINGS,
  SEED_TIERS,
  type SelectorInput,
  selectExecutionSetting,
  type Tier,
  tierFieldDescriptions,
  tierNames,
} from "../src/execution-setting.js";

import { submitAnswer } from "../src/human-verbs.js";
import { registerMetaReview } from "../src/meta-review.js";
import { registerQuarantine, tableRowValue } from "../src/quarantine.js";
import { assertValidAgentDefinition, PROVIDER_VALUES, type Provider } from "../src/registry.js";
import { RegistryPushFailedError } from "../src/registry-write.js";
import { proposeRoutingChange } from "../src/routing-review.js";
import { cancelTaskDirectly, DomainError, getTask, type RegistryProposal, type RoutingProposal, type RoutingRowProposal, registerTask, type TierDescriptionProposal } from "../src/tasks.js";
import { boardCallRow, reportProviderUsage } from "../src/throttle.js";
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
    advisorAboveMain: false,
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

it("tier を書かない agent は盤面既定のティアで解決され、出所は board", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: undefined, agentTier: undefined, advisorAboveMain: false }), table),
  ).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    effort: "high",
    advisor: undefined,
    source: { tier: "board", provider: "only" },
  });
});

it("agent の tier は盤面既定より優先され、出所は agent", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: undefined, agentTier: "economy", advisorAboveMain: false }), table),
  ).toEqual({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    effort: "high",
    advisor: undefined,
    source: { tier: "agent", provider: "only" },
  });
});

it("provider が違えば同じティアでもその provider の表記で解決される", () => {
  expect(
    select(input({ entries: [{ provider: "openai", advisor: false }], taskTier: undefined, agentTier: "frontier", advisorAboveMain: false }), table)
      .model,
  ).toBe("gpt-6-astra");
  expect(
    select(input({ entries: [{ provider: "moonshot", advisor: false }], taskTier: undefined, agentTier: "economy", advisorAboveMain: false }), table)
      .model,
  ).toBe("kimi-k3[1m]");
});

it("advisor が真でも「main より上の model を advisor に使える」フラグが立つまでは main と同一のモデルに倒れる(Fable の同意も org の availableModels も盤面から読めない)", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: undefined, agentTier: "economy", advisorAboveMain: false }), table)
      .advisor,
  ).toBe("claude-sonnet-5-5");
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: undefined, agentTier: "standard", advisorAboveMain: false }), table)
      .advisor,
  ).toBe("claude-opus-5-5");
});

it("フラグが立てば Sonnet / Opus の行の advisor は最上位の系列の alias `fable`、Fable の行の advisor はその行の具体 id(ADR 0200 決定6)", () => {
  const advisorAt = (agentTier: Tier) =>
    select(input({ entries: [{ provider: "anthropic", advisor: true }], agentTier, advisorAboveMain: true })).advisor;
  expect(advisorAt("economy")).toBe("fable");
  expect(advisorAt("standard")).toBe("fable");
  expect(advisorAt("frontier")).toBe("claude-fable-5-1");
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

it("表に Fable の行が無くても、フラグありなら advisor は `fable` —— advisor は行でなく、表を読まない", () => {
  const noFable: ExecutionSettingTable = table.filter((row) => row.model !== "claude-fable-5-1");
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "standard", advisorAboveMain: true }), noFable),
  ).toMatchObject({ model: "claude-opus-5-5", advisor: "fable" });
});

it("adapter が知らない系列の行は、advisor つきの entry ではフラグに依らず候補に入らず、advisor なしの entry では入る —— 付かない advisor を記録に残さない", () => {
  // 知らない系列の行のほうが安いので、候補に入っていれば先に選ばれる
  const withMythos: ExecutionSettingTable = [
    ...table,
    { provider: "anthropic", tier: "standard", model: "claude-mythos-1", effort: "high", price_in: 1, price_out: 1 },
  ];
  const standard = (advisor: boolean, advisorAboveMain: boolean) =>
    select(input({ entries: [{ provider: "anthropic", advisor }], agentTier: "standard", advisorAboveMain }), withMythos).model;
  expect(standard(true, false)).toBe("claude-opus-5-5");
  expect(standard(true, true)).toBe("claude-opus-5-5");
  expect(standard(false, true)).toBe("claude-mythos-1");
});

it("優先順位は quality / cost の2値で、既定は quality(CONTEXT.md「要求」/ ADR 0114 決定1: speed は落とした)", () => {
  expect(PRIORITIES).toEqual(["quality", "cost"]);
  expect(BOARD_DEFAULT_PRIORITY).toBe("quality");
});

it("task の要求ティアは agent の tier より優先され、出所は task(ADR 0110 決定2)", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "frontier", agentTier: "economy", advisorAboveMain: false }),
      table,
    ),
  ).toEqual({
    provider: "anthropic",
    model: "claude-fable-5-1",
    effort: "high",
    advisor: undefined,
    source: { tier: "task", provider: "only" },
  });
});

it("task の要求ティアは agent が tier を持たなくても盤面既定より優先される", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "standard", agentTier: undefined, advisorAboveMain: false }),
      table,
    ),
  ).toEqual({
    provider: "anthropic",
    model: "claude-opus-5-5",
    effort: "high",
    advisor: undefined,
    source: { tier: "task", provider: "only" },
  });
});

it("task の要求が agent の tier と同じ値でも出所は task —— 「誰が要求したか」は値の一致で消えない", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "economy", agentTier: "economy", advisorAboveMain: false }),
      table,
    ).source,
  ).toEqual({ tier: "task", provider: "only" });
});

it("task の要求ティアは advisor の導出にも効く —— main が Fable の行に動けば advisor はその具体 id", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: "frontier", agentTier: "economy", advisorAboveMain: true }),
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

it("review の要求は priority を持たず quality の並べ方で解決される(ADR 0111 決定3)", () => {
  expect(select(input({ entries: both, reviewTier: "standard", priority: "cost" })).model).toBe("claude-opus-5-5");
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

/** agent の既定 tier の提案(issue #920 / ADR 0150 決定1・5): pin は (agent, tier) と根拠の episode が走った行。 */
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
  expect(routingPinChanges(tierProposal, { table: SEED_EXECUTION_SETTINGS, learnerPromoted: false, tiers: reusing("frontier", "top") })).toEqual(["rows"]);
  expect(registryPinChanges(tierProposal, { tier: "frontier" }, reusing("frontier", "top"))).toEqual(["agent_tier"]);
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
  applyExecutionSettingsChange(db, { setting: "advisor_above_main", value: true }, "webui", now);
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
  expect(resolveExecutionSetting(db, anthropicAgent(false), workAt("standard"))).toMatchObject({ model: "claude-opus-5-5", effort: "high" });
  expect(resolveExecutionSetting(db, anthropicAgent(false), workAt("frontier"))).toMatchObject({ model: "claude-opus-5-5", effort: "max" });
});

it("行を書く扉は、同じ段に同じ model の2行目と、同じ (model, effort) の2行目の追加を拒み、表は変わらない", () => {
  const db = openDb(":memory:");
  const add = (row: ExecutionSettingTable[number]) => applyExecutionSettingsChange(db, { setting: "row", row }, "webui", new Date());
  expect(() => add({ ...opusRow, effort: "max" })).toThrow(/one row per model/);
  expect(() => add({ ...opusRow, tier: "frontier" })).toThrow(/belongs to one tier/);
  expect(opusRows(db)).toEqual([opusRow]);
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
  expect(resolveExecutionSetting(db, anthropicAgent(false), { type: "work", tier: null, priority: null, review_tier: null })).toMatchObject({
    model: "claude-opus-5-5",
    source: { tier: "board" },
  });
  expect(() => change(db, { setting: "default_tier", value: "premium" })).toThrow(/unknown default_tier "premium"/);
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
