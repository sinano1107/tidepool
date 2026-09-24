import { expect, it } from "vitest";
import {
  AdvisorPairingError,
  assertAdvisorPairing,
  BOARD_DEFAULT_PRIORITY,
  BOARD_DEFAULT_TIER,
  composeRoutingRow,
  type ExecutionSetting,
  type ExecutionSettingTable,
  PRIORITIES,
  parseRoutingRowChange,
  routingPinChanges,
  SEED_EXECUTION_SETTINGS,
  type SelectorInput,
  selectExecutionSetting,
  TIERS,
} from "../src/execution-setting.js";
import { PROVIDER_VALUES } from "../src/registry.js";
import { DomainError } from "../src/tasks.js";

const table: ExecutionSettingTable = SEED_EXECUTION_SETTINGS;

/** selector の入力の既定形。テストが言いたい1点だけを上書きする。 */
function input(overrides: Partial<SelectorInput> = {}): SelectorInput {
  return {
    entries: [{ provider: "anthropic", advisor: false }],
    providerRank: PROVIDER_VALUES,
    taskTier: undefined,
    priority: undefined,
    agentTier: undefined,
    frontierAdvisor: false,
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

it("ティアは廉価 / 主力 / 上位の3段で、盤面既定は廉価 —— 配布される既定は最小の床(ADR 0094 の線)", () => {
  expect(TIERS).toEqual(["economy", "standard", "frontier"]);
  expect(BOARD_DEFAULT_TIER).toBe("economy");
});

it("種の表は `/implementation-delegation` の表と同じ7行 — anthropic は alias 行、openai は具体 id 行、moonshot は kimi-k3 を economy に1行(ADR 0114: 価格は USD per MTok)", () => {
  expect(SEED_EXECUTION_SETTINGS).toEqual([
    { provider: "anthropic", tier: "economy", model: "sonnet", effort: "high", price_in: 2, price_out: 10 },
    { provider: "anthropic", tier: "standard", model: "opus", effort: "high", price_in: 5, price_out: 25 },
    { provider: "anthropic", tier: "frontier", model: "fable", effort: "high", price_in: 10, price_out: 50 },
    { provider: "moonshot", tier: "economy", model: "kimi-k3[1m]", effort: "high", price_in: 3, price_out: 15 },
    { provider: "openai", tier: "economy", model: "gpt-5.6-terra", effort: "high", price_in: 2, price_out: 12 },
    { provider: "openai", tier: "standard", model: "gpt-5.6-sol", effort: "high", price_in: 4, price_out: 20 },
    { provider: "openai", tier: "frontier", model: "gpt-6-astra", effort: "high", price_in: 10, price_out: 50 },
  ]);
});

it("tier を書かない agent は盤面既定のティアで解決され、出所は board", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: undefined, agentTier: undefined, frontierAdvisor: false }), table),
  ).toEqual({
    provider: "anthropic",
    model: "sonnet",
    effort: "high",
    advisor: undefined,
    source: { tier: "board", provider: "only" },
  });
});

it("agent の tier は盤面既定より優先され、出所は agent", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: undefined, agentTier: "economy", frontierAdvisor: false }), table),
  ).toEqual({
    provider: "anthropic",
    model: "sonnet",
    effort: "high",
    advisor: undefined,
    source: { tier: "agent", provider: "only" },
  });
});

it("provider が違えば同じティアでもその provider の表記で解決される", () => {
  expect(
    select(input({ entries: [{ provider: "openai", advisor: false }], taskTier: undefined, agentTier: "frontier", frontierAdvisor: false }), table)
      .model,
  ).toBe("gpt-6-astra");
  expect(
    select(input({ entries: [{ provider: "moonshot", advisor: false }], taskTier: undefined, agentTier: "economy", frontierAdvisor: false }), table)
      .model,
  ).toBe("kimi-k3[1m]");
});

it("advisor が真でも「Fable を advisor に使える」フラグが立つまでは main と同一のモデルに倒れる(Fable の同意も org の availableModels も盤面から読めない)", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: undefined, agentTier: "economy", frontierAdvisor: false }), table)
      .advisor,
  ).toBe("sonnet");
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: undefined, agentTier: "standard", frontierAdvisor: false }), table)
      .advisor,
  ).toBe("opus");
});

it("フラグが立てば advisor は同 Provider の上位ティアの行、main が既に上位なら main と同一", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: undefined, agentTier: "standard", frontierAdvisor: true }), table)
      .advisor,
  ).toBe("fable");
  const frontier = select(
    input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: undefined, agentTier: "frontier", frontierAdvisor: true }),
    table,
  );
  expect(frontier.advisor).toBe(frontier.model);
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

it("advisor が真で frontier 行を持たない Provider の entry は除外される —— advisor 無しで黙って走らせない", () => {
  const partial: ExecutionSettingTable = table.filter((row) => row.tier !== "frontier");
  expect(
    selectExecutionSetting(
      input({ entries: [{ provider: "anthropic", advisor: true }], agentTier: "standard", frontierAdvisor: true }),
      partial,
    ),
  ).toBeNull();
});

it("pairing はティアの水準だけで判定する — advisor が main 未満なら拒否、同位・上位なら通る(ADR 0042: 盤面は alias の解決先を judge しない)", () => {
  expect(() => assertAdvisorPairing("frontier", "standard")).toThrow(
    new AdvisorPairingError("frontier", "standard"),
  );
  expect(() => assertAdvisorPairing("standard", "economy")).toThrow(new AdvisorPairingError("standard", "economy"));
  expect(() => assertAdvisorPairing("standard", "standard")).not.toThrow();
  expect(() => assertAdvisorPairing("economy", "frontier")).not.toThrow();
});

it("優先順位は quality / cost の2値で、既定は quality(CONTEXT.md「要求」/ ADR 0114 決定1: speed は落とした)", () => {
  expect(PRIORITIES).toEqual(["quality", "cost"]);
  expect(BOARD_DEFAULT_PRIORITY).toBe("quality");
});

it("task の要求ティアは agent の tier より優先され、出所は task(ADR 0110 決定2)", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "frontier", agentTier: "economy", frontierAdvisor: false }),
      table,
    ),
  ).toEqual({
    provider: "anthropic",
    model: "fable",
    effort: "high",
    advisor: undefined,
    source: { tier: "task", provider: "only" },
  });
});

it("task の要求ティアは agent が tier を持たなくても盤面既定より優先される", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "standard", agentTier: undefined, frontierAdvisor: false }),
      table,
    ),
  ).toEqual({
    provider: "anthropic",
    model: "opus",
    effort: "high",
    advisor: undefined,
    source: { tier: "task", provider: "only" },
  });
});

it("task の要求が agent の tier と同じ値でも出所は task —— 「誰が要求したか」は値の一致で消えない", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: "economy", agentTier: "economy", frontierAdvisor: false }),
      table,
    ).source,
  ).toEqual({ tier: "task", provider: "only" });
});

it("task の要求ティアは advisor の導出にも効く —— main が動けば pairing の基準も動く", () => {
  expect(
    select(
      input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: "frontier", agentTier: "economy", frontierAdvisor: true }),
      table,
    ).advisor,
  ).toBe("fable");
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

it("モデル窓の除外は entry の解決した model に当たる —— 同じ Provider でもティアが違えば当たらない", () => {
  const excluded = { providers: [], models: [{ provider: "anthropic" as const, model: "fable" }] };
  expect(
    selectExecutionSetting(input({ agentTier: "frontier" }), table, excluded),
  ).toBeNull();
  expect(
    selectExecutionSetting(input({ agentTier: "standard" }), table, excluded)?.model,
  ).toBe("opus");
});

it("fable の窓は model 名の部分一致で当たる —— CLI の --model は開かれた文字列(ADR 0030)", () => {
  const generation: ExecutionSettingTable = table.map((row) =>
    row.provider === "anthropic" && row.tier === "frontier"
      ? { ...row, model: "claude-fable-5" }
      : row,
  );
  expect(
    selectExecutionSetting(input({ agentTier: "frontier" }), generation, {
      providers: [],
      models: [{ provider: "anthropic", model: "fable" }],
    }),
  ).toBeNull();
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
  ).toBe("sonnet");
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
    model: "opus",
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

it("advisor は同 Provider の frontier 行、複数なら最安 —— 複数行でも advisor の行は一意に決まる", () => {
  expect(
    select(input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: "standard", frontierAdvisor: true }), crowded).advisor,
  ).toBe("fable-lite");
});

it("advisor のティアが main と同じなら main の行そのもの —— 同ティアに複数行あっても advisor が別の行へ割れない", () => {
  const frontierTask = input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: "frontier", frontierAdvisor: true });
  const lite = selectExecutionSetting(frontierTask, crowded, { providers: [], models: [{ provider: "anthropic", model: "fable-lite" }] });
  expect(lite).toMatchObject({ model: "fable", advisor: "fable" });
  // フラグが立つ前は main と同一に倒れる
  expect(select(input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: "standard" }), crowded)).toMatchObject({
    model: "opus-mini",
    advisor: "opus-mini",
  });
});

it("review の要求は priority を持たず quality の並べ方で解決される(ADR 0111 決定3)", () => {
  expect(select(input({ entries: both, reviewTier: "standard", priority: "cost" })).model).toBe("opus");
});

/** routing の行の提案(issue #918 / ADR 0150 決定1): pin はその行の全欄。 */
const opusRow = { provider: "anthropic", tier: "standard", model: "opus", effort: "high", price_in: 5, price_out: 25 } as const;
const rowProposal = { kind: "routing", op: "row", row: { provider: "anthropic", model: "opus" }, change: { tier: "frontier" }, pin: opusRow } as const;

it("pin の照合は行の全欄の一致で、崩れた欄の名前を返す —— 行が消えていれば null", () => {
  expect(routingPinChanges(rowProposal, { table: SEED_EXECUTION_SETTINGS, learnerPromoted: false })).toEqual([]);
  const edited = SEED_EXECUTION_SETTINGS.map((row) => (row.model === "opus" ? { ...row, effort: "max", price_out: 30 } : row));
  expect(routingPinChanges(rowProposal, { table: edited, learnerPromoted: false })).toEqual(["effort", "price_out"]);
  // 別の行の編集は pin に触れない
  const other = SEED_EXECUTION_SETTINGS.map((row) => (row.model === "sonnet" ? { ...row, tier: "standard" as const } : row));
  expect(routingPinChanges(rowProposal, { table: other, learnerPromoted: false })).toEqual([]);
  expect(routingPinChanges(rowProposal, { table: SEED_EXECUTION_SETTINGS.filter((row) => row.model !== "opus"), learnerPromoted: false })).toBeNull();
});

it("昇格 / 降格の提案の pin はフラグの現在値 —— フラグが変われば learner_promoted が崩れ、表の編集では崩れない", () => {
  const settings = (learnerPromoted: boolean, t: ExecutionSettingTable = SEED_EXECUTION_SETTINGS) => ({ table: t, learnerPromoted });
  const promote = { kind: "routing", op: "promote", pin: { promoted: false } } as const;
  const demote = { kind: "routing", op: "demote", pin: { promoted: true } } as const;
  expect(routingPinChanges(promote, settings(false, []))).toEqual([]);
  expect(routingPinChanges(promote, settings(true))).toEqual(["learner_promoted"]);
  expect(routingPinChanges(demote, settings(true))).toEqual([]);
  expect(routingPinChanges(demote, settings(false))).toEqual(["learner_promoted"]);
});

it("適用する行は pin の行に提案の変更、その上に修正値を重ねたもの", () => {
  expect(composeRoutingRow(rowProposal)).toEqual({ ...opusRow, tier: "frontier" });
  expect(composeRoutingRow(rowProposal, { effort: "max" })).toEqual({ ...opusRow, tier: "frontier", effort: "max" });
  expect(composeRoutingRow(rowProposal, { tier: "economy" })).toEqual({ ...opusRow, tier: "economy" });
});

it("行の変更・修正値の形は tier / effort の少なくとも1つだけで、それ以外は DomainError", () => {
  expect(parseRoutingRowChange({ tier: "economy", effort: "low" })).toEqual({ tier: "economy", effort: "low" });
  for (const bad of [{}, { tier: "ultra" }, { effort: "" }, { tier: "economy", price_in: 1 }, "frontier", null]) {
    expect(() => parseRoutingRowChange(bad)).toThrow(DomainError);
  }
});
