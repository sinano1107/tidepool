import { describe, expect, it } from "vitest";
import { resolveExecutionAgent, UnknownAgentError } from "../src/agent.js";
import { InvalidAgentProviderError, type Registry } from "../src/registry.js";

function makeRegistry(
  agents: Record<string, { authority: string; provider?: string; advisor?: string }>,
): Registry {
  return {
    commit: "0".repeat(40),
    agents: Object.fromEntries(
      Object.entries(agents).map(([name, a]) => [
        name,
        {
          name,
          version: "0.0.1",
          authority: a.authority,
          description: `${name} agent`,
          provider: a.provider ?? "anthropic",
          advisor: a.advisor,
          skills: ["*"],
          systemPrompt: `You are ${name}.`,
        },
      ]),
    ),
    authority: {
      standard: { name: "standard", guidance: "Prefer reversible actions." },
    },
    workspaces: {},
  };
}

describe("resolveExecutionAgent(ADR 0012 / issue #36: spawn 時の assignee 解決)", () => {
  it("taskAssignee が null のとき、盤面既定の agent 名で解決する", () => {
    const registry = makeRegistry({ deckhand: { authority: "standard" } });
    const resolved = resolveExecutionAgent(registry, "deckhand", null);
    expect(resolved.name).toBe("deckhand");
    expect(resolved.definition.name).toBe("deckhand");
    expect(resolved.profile.name).toBe("standard");
  });

  it("taskAssignee が指定されていれば、盤面既定と異なっていてもその agent 名で解決する", () => {
    const registry = makeRegistry({
      deckhand: { authority: "standard" },
      navigator: { authority: "standard" },
    });
    const resolved = resolveExecutionAgent(registry, "deckhand", "navigator");
    expect(resolved.name).toBe("navigator");
  });

  it("Object.prototype 由来のキー(toString 等)は未登録 agent 名として UnknownAgentError を投げる(issue #69)", () => {
    const registry = makeRegistry({ deckhand: { authority: "standard" } });
    expect(() => resolveExecutionAgent(registry, "deckhand", "toString")).toThrow(
      UnknownAgentError,
    );
  });

  it("本当に toString という名前で登録された agent は従来どおり解決される(issue #69: false positive を起こさない)", () => {
    const registry = makeRegistry({ toString: { authority: "standard" } });
    const resolved = resolveExecutionAgent(registry, "toString", null);
    expect(resolved.name).toBe("toString");
    expect(resolved.definition.name).toBe("toString");
    expect(resolved.profile.name).toBe("standard");
  });

  it("authority が Object.prototype 由来のキー(toString 等)を指す定義は unknown authority profile として拒否される(issue #69)", () => {
    const registry = makeRegistry({ deckhand: { authority: "toString" } });
    expect(() => resolveExecutionAgent(registry, "deckhand", null)).toThrow(
      "unknown authority profile: toString",
    );
  });

  it("registry に存在しない agent 名は UnknownAgentError を投げる", () => {
    const registry = makeRegistry({ deckhand: { authority: "standard" } });
    expect(() => resolveExecutionAgent(registry, "deckhand", "ghost")).toThrow(UnknownAgentError);
    try {
      resolveExecutionAgent(registry, "deckhand", "ghost");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownAgentError);
      expect((err as UnknownAgentError).agentName).toBe("ghost");
    }
  });

  it("provider が列挙にない定義は InvalidAgentProviderError を投げ、quarantine すべき agent 名を運ぶ(ADR 0097 決定1)", () => {
    const registry = makeRegistry({ deckhand: { authority: "standard", provider: "moonshto" } });
    try {
      resolveExecutionAgent(registry, "deckhand", null);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidAgentProviderError);
      expect((err as InvalidAgentProviderError).agentName).toBe("deckhand");
    }
  });

  it("advisor を持つ定義に advisor を提供しない provider(moonshot)の組み合わせは InvalidAgentProviderError(ADR 0097 決定3)", () => {
    const registry = makeRegistry({
      deckhand: { authority: "standard", provider: "moonshot", advisor: "opus" },
    });
    expect(() => resolveExecutionAgent(registry, "deckhand", null)).toThrow(
      InvalidAgentProviderError,
    );
  });

  it("moonshot でも advisor を持たない定義は従来どおり解決される", () => {
    const registry = makeRegistry({ deckhand: { authority: "standard", provider: "moonshot" } });
    const resolved = resolveExecutionAgent(registry, "deckhand", null);
    expect(resolved.definition.provider).toBe("moonshot");
  });

  it("anthropic で advisor を持つ定義は従来どおり解決される", () => {
    const registry = makeRegistry({
      deckhand: { authority: "standard", provider: "anthropic", advisor: "opus" },
    });
    expect(resolveExecutionAgent(registry, "deckhand", null).definition.advisor).toBe("opus");
  });
});
