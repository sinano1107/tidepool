import { describe, expect, it } from "vitest";
import type { Registry } from "../src/registry.js";
import {
  protectedBranch,
  resolveExecutionWorkspace,
  UnknownWorkspaceError,
} from "../src/workspace.js";

function makeRegistry(
  workspaces: Record<string, { path: string; branch?: string }>,
): Registry {
  return {
    commit: "0".repeat(40),
    agents: {},
    authority: {},
    workspaces,
  };
}

describe("resolveExecutionWorkspace", () => {
  it("task.workspace が null のとき、盤面既定の workspace 名で解決する", () => {
    const registry = makeRegistry({
      sandbox: { path: "/home/pi/work/sandbox" },
      prod: { path: "/home/pi/work/prod" },
    });
    const resolved = resolveExecutionWorkspace(registry, "sandbox", null);
    expect(resolved).toEqual({ name: "sandbox", path: "/home/pi/work/sandbox" });
  });

  it("task.workspace が指定されているとき、盤面既定と異なっていてもその名前で解決する", () => {
    const registry = makeRegistry({
      sandbox: { path: "/home/pi/work/sandbox" },
      prod: { path: "/home/pi/work/prod" },
    });
    const resolved = resolveExecutionWorkspace(registry, "sandbox", "prod");
    expect(resolved).toEqual({ name: "prod", path: "/home/pi/work/prod" });
  });

  it("workspace entry の branch はそのまま resolved workspace に載る(issue #27)", () => {
    const registry = makeRegistry({
      sandbox: { path: "/home/pi/work/sandbox", branch: "master" },
    });
    const resolved = resolveExecutionWorkspace(registry, "sandbox", null);
    expect(resolved).toEqual({ name: "sandbox", path: "/home/pi/work/sandbox", branch: "master" });
  });

  it("registry に存在しない workspace 名は UnknownWorkspaceError を投げる", () => {
    const registry = makeRegistry({ sandbox: { path: "/home/pi/work/sandbox" } });
    expect(() => resolveExecutionWorkspace(registry, "sandbox", "no-such-workspace")).toThrow(
      UnknownWorkspaceError,
    );
    try {
      resolveExecutionWorkspace(registry, "sandbox", "no-such-workspace");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownWorkspaceError);
      expect((err as UnknownWorkspaceError).workspaceName).toBe("no-such-workspace");
    }
  });
});

describe("protectedBranch", () => {
  it("workspace.branch が未設定なら main を返す(issue #27: 省略時の既定はここ一箇所で解決する)", () => {
    expect(protectedBranch({ name: "sandbox", path: "/home/pi/work/sandbox" })).toBe("main");
  });

  it("workspace.branch が設定されていればそれを返す", () => {
    expect(
      protectedBranch({ name: "sandbox", path: "/home/pi/work/sandbox", branch: "master" }),
    ).toBe("master");
  });
});
