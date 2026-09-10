import { expect, it } from "vitest";
import {
  assertValidAgentDefinition,
  canonicalHarness,
  InvalidAgentDefinitionError,
  PROVIDER_VALUES,
} from "../src/registry.js";

it("Provider は1つの正準 Harness に解決され、agent 定義に harness を持たない(ADR 0098)", () => {
  expect(PROVIDER_VALUES).toEqual(["anthropic", "moonshot", "openai"]);
  expect(PROVIDER_VALUES.map((provider) => [provider, canonicalHarness(provider)])).toEqual([
    ["anthropic", "claude-code"],
    ["moonshot", "claude-code"],
    ["openai", "codex"],
  ]);
});

it("OpenAI / Codex の正準経路に無い advisor は登録時と pickup 時の共有検査で拒否される(ADR 0098)", () => {
  expect(() => assertValidAgentDefinition("deckhand", { provider: "openai", advisor: true })).toThrow(
    new InvalidAgentDefinitionError(
      "deckhand",
      'canonical route "openai -> codex" does not offer an advisor — a definition declaring one does not stand (ADR 0098)',
    ),
  );
  expect(() => assertValidAgentDefinition("deckhand", { provider: "openai", advisor: false })).not.toThrow();
});

it("OpenAI / Codex v1 に無い skill capability も共有検査で拒否される(ADR 0098)", () => {
  expect(() => assertValidAgentDefinition("deckhand", { provider: "openai", advisor: false, skills: ["tdd"] })).toThrow(
    new InvalidAgentDefinitionError(
      "deckhand",
      'canonical route "openai -> codex" does not offer skills in v1 — a definition declaring a non-empty allowlist does not stand (ADR 0098)',
    ),
  );
  expect(() => assertValidAgentDefinition("deckhand", { provider: "openai", advisor: false, skills: [] })).not.toThrow();
});
