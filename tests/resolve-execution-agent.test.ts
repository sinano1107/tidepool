import { describe, expect, it } from "vitest";
import { resolveExecutionAgent, UnknownAgentError } from "../src/agent.js";
import type { Registry } from "../src/registry.js";

function makeRegistry(agents: Record<string, { authority: string }>): Registry {
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
});
