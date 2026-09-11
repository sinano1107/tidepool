import { expect, it } from "vitest";
import {
  AdvisorPairingError,
  assertAdvisorPairing,
  BOARD_DEFAULT_TIER,
  type ExecutionSetting,
  type ExecutionSettingTable,
  IncompleteExecutionSettingTableError,
  PRIORITIES,
  SEED_EXECUTION_SETTINGS,
  type SelectorInput,
  selectExecutionSetting,
  TIERS,
} from "../src/execution-setting.js";
import { PROVIDER_VALUES } from "../src/registry.js";

const table: ExecutionSettingTable = SEED_EXECUTION_SETTINGS;

/** selector の入力の既定形。テストが言いたい1点だけを上書きする。 */
function input(overrides: Partial<SelectorInput> = {}): SelectorInput {
  return {
    entries: [{ provider: "anthropic", advisor: false }],
    providerRank: PROVIDER_VALUES,
    taskTier: undefined,
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

it("種の表は `/implementation-delegation` の表と同じ内容を持つ — anthropic は alias 行、openai は具体 id 行(実測: Codex の -m は Astra / Sol / Terra を alias として受けない)", () => {
  expect(SEED_EXECUTION_SETTINGS).toEqual([
    { provider: "anthropic", tier: "economy", model: "sonnet", effort: "high" },
    { provider: "anthropic", tier: "standard", model: "opus", effort: "high" },
    { provider: "anthropic", tier: "frontier", model: "fable", effort: "high" },
    { provider: "moonshot", tier: "economy", model: "kimi-k3[1m]", effort: "high" },
    { provider: "moonshot", tier: "standard", model: "kimi-k3[1m]", effort: "high" },
    { provider: "moonshot", tier: "frontier", model: "kimi-k3[1m]", effort: "high" },
    { provider: "openai", tier: "economy", model: "gpt-5.6-terra", effort: "high" },
    { provider: "openai", tier: "standard", model: "gpt-5.6-sol", effort: "high" },
    { provider: "openai", tier: "frontier", model: "gpt-6-astra", effort: "high" },
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

it("フラグが立てば advisor は上位ティアの champion、main が既に上位なら main と同一", () => {
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

it("要求されたティアの行が表に無ければ spawn を拒否する — 表が不完全なまま別のモデルへ黙って倒れない", () => {
  const partial: ExecutionSettingTable = table.filter((row) => row.tier !== "economy");
  expect(() =>
    select(input({ entries: [{ provider: "anthropic", advisor: false }], taskTier: undefined, agentTier: "economy", frontierAdvisor: false }), partial),
  ).toThrow(new IncompleteExecutionSettingTableError("anthropic", "economy"));
});

it("advisor の導出先(上位ティア)の行が無い場合も、advisor 無しで走らせず拒否する", () => {
  const partial: ExecutionSettingTable = table.filter((row) => row.tier !== "frontier");
  expect(() =>
    select(input({ entries: [{ provider: "anthropic", advisor: true }], taskTier: undefined, agentTier: "standard", frontierAdvisor: true }), partial),
  ).toThrow(new IncompleteExecutionSettingTableError("anthropic", "frontier"));
});

it("pairing はティアの水準だけで判定する — advisor が main 未満なら拒否、同位・上位なら通る(ADR 0042: 盤面は alias の解決先を judge しない)", () => {
  expect(() => assertAdvisorPairing("frontier", "standard")).toThrow(
    new AdvisorPairingError("frontier", "standard"),
  );
  expect(() => assertAdvisorPairing("standard", "economy")).toThrow(new AdvisorPairingError("standard", "economy"));
  expect(() => assertAdvisorPairing("standard", "standard")).not.toThrow();
  expect(() => assertAdvisorPairing("economy", "frontier")).not.toThrow();
});

it("優先順位は quality / cost / speed の3値(CONTEXT.md「要求」)", () => {
  expect(PRIORITIES).toEqual(["quality", "cost", "speed"]);
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
