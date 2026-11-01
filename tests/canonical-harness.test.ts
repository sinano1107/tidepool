import { expect, it } from "vitest";
import { DEFAULT_AUDITOR_NAME } from "../src/defaults.js";
import { PROVIDER_VALUES } from "../src/provider.js";
import {
  assertValidAgentDefinition,
  canonicalHarness,
  InvalidAgentDefinitionError,
  loadRegistry,
  normalizeProviderEntries,
} from "../src/registry.js";
import { seedTierNames } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

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

// ADR 0337 決定1: skill の提供は経路の能力ではない —— 非空の allowlist を持つ agent も openai で、省略なら Provider 全部に
// advisor なしで展開され、どちらもそのまま門を通る。組み込み agent(`@workspace`)も Codex に乗る。
it.each([
  ["openai", "provider: openai\n", [{ name: "openai", advisor: false }]],
  ["省略", "", PROVIDER_VALUES.map((name) => ({ name, advisor: false }))],
])("非空の skill allowlist を持つ agent は provider が %s でも登録でき、Provider の候補は skills で絞られない(ADR 0116 決定1 / ADR 0337 決定1)", async (_, provider, entries) => {
  const dir = await makeRegistry({
    "agents/deckhand.md": `---\nversion: 1\nauthority: standard\n${provider}skills:\n  - "@workspace"\n  - tdd\ndescription: d\n---\np\n`,
  });
  const registry = loadRegistry(dir, "purely-local");
  expect(registry.agents.deckhand!.provider).toEqual(entries);
  expect(() => assertValidAgentDefinition("deckhand", registry.agents.deckhand!, seedTierNames)).not.toThrow();
  expect(registry.agents[DEFAULT_AUDITOR_NAME]!.provider).toEqual(PROVIDER_VALUES.map((name) => ({ name, advisor: false })));
});

it("単一文字列の provider は advisor なしの長さ1 entry(ADR 0116 決定2)", () => {
  expect(normalizeProviderEntries("anthropic")).toEqual([{ name: "anthropic", advisor: false }]);
});

it("走れる経路が1つも無い provider の集合は宣言を満たす経路が無いとして拒否される(ADR 0116 決定1)", () => {
  expect(() => assertValidAgentDefinition("deckhand", { provider: [] }, seedTierNames)).toThrow(
    /no provider entry is left/,
  );
});
