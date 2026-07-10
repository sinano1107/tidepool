import { describe, expect, it } from "vitest";
import { buildWorkspaceResolver, type WorkspaceConfig } from "../src/workspace.js";

describe("buildWorkspaceResolver", () => {
  it("resolveWorkspace が与えられていればそれをそのまま使う", () => {
    const prod: WorkspaceConfig = { name: "prod", path: "/prod" };
    const resolveWorkspace = (name: string | null) => {
      expect(name).toBe("prod");
      return prod;
    };
    const resolve = buildWorkspaceResolver(resolveWorkspace, undefined);
    expect(resolve?.("prod")).toEqual(prod);
  });

  it("resolveWorkspace が無ければ、盤面既定の workspace を常に返す固定リゾルバーにフォールバックする", () => {
    const sandbox: WorkspaceConfig = { name: "sandbox", path: "/sandbox" };
    const resolve = buildWorkspaceResolver(undefined, sandbox);
    expect(resolve?.("anything")).toEqual(sandbox);
    expect(resolve?.(null)).toEqual(sandbox);
  });

  it("どちらも無ければ undefined(ワークスペース追跡なしの盤面)", () => {
    expect(buildWorkspaceResolver(undefined, undefined)).toBeUndefined();
  });
});
