import { expect, it } from "vitest";
import { PROVIDER_VALUES } from "../src/provider.js";
import {
  assertValidAgentDefinition,
  canonicalHarness,
  InvalidAgentDefinitionError,
  normalizeProviderEntries,
} from "../src/registry.js";
import { seedTierNames } from "./fakes.js";

it("Provider は1つの正準 Harness に解決され、agent 定義に harness を持たない(ADR 0098)", () => {
  expect(PROVIDER_VALUES).toEqual(["anthropic", "moonshot", "openai"]);
  expect(PROVIDER_VALUES.map((provider) => [provider, canonicalHarness(provider)])).toEqual([
    ["anthropic", "claude-code"],
    ["moonshot", "claude-code"],
    ["openai", "codex"],
  ]);
});

it("OpenAI / Codex の正準経路に無い advisor は登録時と pickup 時の共有検査で拒否される(ADR 0098)", () => {
  expect(() => assertValidAgentDefinition("deckhand", { provider: [{ name: "openai", advisor: true }] }, seedTierNames)).toThrow(
    new InvalidAgentDefinitionError(
      "deckhand",
      'canonical route "openai -> codex" does not offer an advisor — a definition declaring one does not stand',
    ),
  );
  expect(() => assertValidAgentDefinition("deckhand", { provider: [{ name: "openai", advisor: false }] }, seedTierNames)).not.toThrow();
});

it("OpenAI / Codex v1 に無い skill capability も共有検査で拒否される(ADR 0098)", () => {
  expect(() => assertValidAgentDefinition("deckhand", { provider: [{ name: "openai", advisor: false }], skills: ["tdd"] }, seedTierNames)).toThrow(
    new InvalidAgentDefinitionError(
      "deckhand",
      'canonical route "openai -> codex" does not offer skills in v1 — a definition declaring a non-empty allowlist does not stand',
    ),
  );
  expect(() => assertValidAgentDefinition("deckhand", { provider: [{ name: "openai", advisor: false }], skills: [] }, seedTierNames)).not.toThrow();
});

// ADR 0116 決定1: 省略は「盤面が知る Provider のうち、正準経路が skills を満たすもの」を
// advisor なしで。門と展開は同じ能力表を読むので、展開した結果は必ず門を通る。
it("provider の省略は正準経路が skills を満たす Provider だけに advisor なしで展開され、そのまま門を通る(ADR 0116 決定1)", () => {
  const withSkills = normalizeProviderEntries(undefined, ["*"]);
  const withoutSkills = normalizeProviderEntries(undefined, []);
  expect({ withSkills, withoutSkills }).toEqual({
    withSkills: [
      { name: "anthropic", advisor: false },
      { name: "moonshot", advisor: false },
    ],
    withoutSkills: PROVIDER_VALUES.map((name) => ({ name, advisor: false })),
  });
  expect(() => assertValidAgentDefinition("deckhand", { provider: withSkills, skills: ["*"] }, seedTierNames)).not.toThrow();
  expect(() => assertValidAgentDefinition("deckhand", { provider: withoutSkills, skills: [] }, seedTierNames)).not.toThrow();
});

it("単一文字列の provider は advisor なしの長さ1 entry(ADR 0116 決定2)", () => {
  expect(normalizeProviderEntries("anthropic", ["*"])).toEqual([{ name: "anthropic", advisor: false }]);
});

it("走れる経路が1つも無い provider の集合は宣言を満たす経路が無いとして拒否される(ADR 0116 決定1)", () => {
  expect(() => assertValidAgentDefinition("deckhand", { provider: [] }, seedTierNames)).toThrow(
    /no provider entry is left/,
  );
});
