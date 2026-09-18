import { expect, it } from "vitest";
import { resolveExecutionAgent } from "../src/agent.js";
import {
  agentBodyAtCommit,
  assertValidAgentName,
  InvalidAgentNameError,
  loadRegistry,
  REVIEWER_AUTHORITY_PROFILE,
} from "../src/registry.js";
import { makeRegistry } from "./registry-fixture.js";

it("agents/fugu.md の無い registry を読むと、組み込みの fugu が印つきで map に居る(ADR 0117 決定1/2)", async () => {
  const dir = await makeRegistry();

  const registry = loadRegistry(dir, "purely-local");

  expect(registry.agents.fugu).toMatchObject({
    name: "fugu",
    builtin: true,
    skills: ["@workspace"],
    icon: "🐡",
    // 省略の展開(ADR 0116 決定1): 非空の skills を満たす正準経路だけ —— codex 経路
    // (openai)は v1 で skills を提供しないので落ちる
    provider: [
      { name: "anthropic", advisor: false },
      { name: "moonshot", advisor: false },
    ],
    // 当時版は registry commit に無い(ADR 0020 / ADR 0117 帰結)—— spawn 記録の
    // definition_version が運ぶのは盤面の版である
    version: "built-in",
  });
});

it("agents/fugu.md があればそのファイルの定義が fugu であり、組み込みの印は付かない(ADR 0117 決定2 の shadowing)", async () => {
  const dir = await makeRegistry({
    "agents/fugu.md": `---
version: "2"
authority: standard
description: My own auditor.
provider: openai
skills: []
---
You are my fugu.
`,
  });

  const registry = loadRegistry(dir, "purely-local");

  expect(registry.agents.fugu).toMatchObject({
    version: "2",
    authority: "standard",
    skills: [],
    provider: [{ name: "openai", advisor: false }],
    systemPrompt: "You are my fugu.",
  });
  expect(registry.agents.fugu!.builtin).toBeUndefined();
});

it("組み込みの fugu は authority/auditor.yaml の無い registry でも reviewer profile で解決する(ADR 0013 / ADR 0117 決定1)", async () => {
  const dir = await makeRegistry();
  const registry = loadRegistry(dir, "purely-local");

  const resolved = resolveExecutionAgent(registry, "deckhand", "fugu");

  expect(resolved.name).toBe("fugu");
  expect(resolved.profile).toEqual(REVIEWER_AUTHORITY_PROFILE);
  expect(registry.authority.reviewer).toBeUndefined();
});

it("組み込みの名前でも、その commit にファイルが無ければ当時版は undefined —— 自己 RCA は証拠なしに degrade する(ADR 0020 / ADR 0117 帰結)", async () => {
  const dir = await makeRegistry();

  expect(agentBodyAtCommit(dir, "HEAD", "fugu")).toBeUndefined();
});

it("組み込みだけが持つ名前は「既に存在する」で弾かれない —— 作成の扉は同名を拒まない(ADR 0117 決定2)", async () => {
  const registry = loadRegistry(await makeRegistry(), "purely-local");

  expect(() => assertValidAgentName(registry, "fugu")).not.toThrow();
  expect(() => assertValidAgentName(registry, "deckhand")).toThrow(InvalidAgentNameError);
});
