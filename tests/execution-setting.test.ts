import { expect, it } from "vitest";
import {
  AdvisorPairingError,
  assertAdvisorPairing,
  BOARD_DEFAULT_TIER,
  type ExecutionSettingTable,
  IncompleteExecutionSettingTableError,
  SEED_EXECUTION_SETTINGS,
  selectExecutionSetting,
  TIERS,
} from "../src/execution-setting.js";

const table: ExecutionSettingTable = SEED_EXECUTION_SETTINGS;

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
    selectExecutionSetting({ provider: "anthropic", tier: undefined, advisor: false, frontierAdvisor: false }, table),
  ).toEqual({
    provider: "anthropic",
    model: "sonnet",
    effort: "high",
    advisor: undefined,
    source: { tier: "board" },
  });
});

it("agent の tier は盤面既定より優先され、出所は agent", () => {
  expect(
    selectExecutionSetting({ provider: "anthropic", tier: "economy", advisor: false, frontierAdvisor: false }, table),
  ).toEqual({
    provider: "anthropic",
    model: "sonnet",
    effort: "high",
    advisor: undefined,
    source: { tier: "agent" },
  });
});

it("provider が違えば同じティアでもその provider の表記で解決される", () => {
  expect(
    selectExecutionSetting({ provider: "openai", tier: "frontier", advisor: false, frontierAdvisor: false }, table)
      .model,
  ).toBe("gpt-6-astra");
  expect(
    selectExecutionSetting({ provider: "moonshot", tier: "economy", advisor: false, frontierAdvisor: false }, table)
      .model,
  ).toBe("kimi-k3[1m]");
});

it("advisor が真でも「Fable を advisor に使える」フラグが立つまでは main と同一のモデルに倒れる(Fable の同意も org の availableModels も盤面から読めない)", () => {
  expect(
    selectExecutionSetting({ provider: "anthropic", tier: "economy", advisor: true, frontierAdvisor: false }, table)
      .advisor,
  ).toBe("sonnet");
  expect(
    selectExecutionSetting({ provider: "anthropic", tier: "standard", advisor: true, frontierAdvisor: false }, table)
      .advisor,
  ).toBe("opus");
});

it("フラグが立てば advisor は上位ティアの champion、main が既に上位なら main と同一", () => {
  expect(
    selectExecutionSetting({ provider: "anthropic", tier: "standard", advisor: true, frontierAdvisor: true }, table)
      .advisor,
  ).toBe("fable");
  const frontier = selectExecutionSetting(
    { provider: "anthropic", tier: "frontier", advisor: true, frontierAdvisor: true },
    table,
  );
  expect(frontier.advisor).toBe(frontier.model);
});

it("要求されたティアの行が表に無ければ spawn を拒否する — 表が不完全なまま別のモデルへ黙って倒れない", () => {
  const partial: ExecutionSettingTable = table.filter((row) => row.tier !== "economy");
  expect(() =>
    selectExecutionSetting({ provider: "anthropic", tier: "economy", advisor: false, frontierAdvisor: false }, partial),
  ).toThrow(new IncompleteExecutionSettingTableError("anthropic", "economy"));
});

it("advisor の導出先(上位ティア)の行が無い場合も、advisor 無しで走らせず拒否する", () => {
  const partial: ExecutionSettingTable = table.filter((row) => row.tier !== "frontier");
  expect(() =>
    selectExecutionSetting({ provider: "anthropic", tier: "standard", advisor: true, frontierAdvisor: true }, partial),
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
