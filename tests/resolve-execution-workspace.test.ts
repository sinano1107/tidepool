import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Registry } from "../src/registry.js";
import {
  listRegisteredWorkspaces,
  protectedBranch,
  resolveExecutionWorkspace,
  resolveWorkspacesBaseDir,
  UnknownWorkspaceError,
} from "../src/workspace.js";

describe("resolveWorkspacesBaseDir", () => {
  it("TIDEPOOL_WORKSPACES_DIR が未設定なら ~/tidepool-workspaces を返す(ADR 0018)", () => {
    expect(resolveWorkspacesBaseDir(undefined)).toBe(join(homedir(), "tidepool-workspaces"));
  });

  it("TIDEPOOL_WORKSPACES_DIR が設定されていればその値をそのまま返す", () => {
    expect(resolveWorkspacesBaseDir("/mnt/ssd/tidepool-workspaces")).toBe(
      "/mnt/ssd/tidepool-workspaces",
    );
  });
});

function makeRegistry(
  workspaces: Record<string, { path?: string; branch?: string; allowed_domains?: string[] }>,
): Registry {
  return {
    commit: "0".repeat(40),
    agents: {},
    authority: {},
    workspaces,
  };
}

const BASE_DIR = "/home/pi/tidepool-workspaces";

describe("resolveExecutionWorkspace", () => {
  it("task.workspace が null のとき、盤面既定の workspace 名で解決する", () => {
    const registry = makeRegistry({
      sandbox: { path: "/home/pi/work/sandbox" },
      prod: { path: "/home/pi/work/prod" },
    });
    const resolved = resolveExecutionWorkspace(registry, "sandbox", null, BASE_DIR);
    expect(resolved).toEqual({ name: "sandbox", path: "/home/pi/work/sandbox" });
  });

  it("task.workspace が指定されているとき、盤面既定と異なっていてもその名前で解決する", () => {
    const registry = makeRegistry({
      sandbox: { path: "/home/pi/work/sandbox" },
      prod: { path: "/home/pi/work/prod" },
    });
    const resolved = resolveExecutionWorkspace(registry, "sandbox", "prod", BASE_DIR);
    expect(resolved).toEqual({ name: "prod", path: "/home/pi/work/prod" });
  });

  it("workspace entry の branch はそのまま resolved workspace に載る(issue #27)", () => {
    const registry = makeRegistry({
      sandbox: { path: "/home/pi/work/sandbox", branch: "master" },
    });
    const resolved = resolveExecutionWorkspace(registry, "sandbox", null, BASE_DIR);
    expect(resolved).toEqual({ name: "sandbox", path: "/home/pi/work/sandbox", branch: "master" });
  });

  it("workspace entry の allowed_domains は worker session 設定へ渡せる形で解決される(ADR 0072)", () => {
    const registry = makeRegistry({
      sandbox: {
        path: "/home/pi/work/sandbox",
        allowed_domains: ["registry.npmjs.org"],
      },
    });

    expect(resolveExecutionWorkspace(registry, "sandbox", null, BASE_DIR)).toEqual({
      name: "sandbox",
      path: "/home/pi/work/sandbox",
      allowed_domains: ["registry.npmjs.org"],
    });
  });

  it("registry に存在しない workspace 名は UnknownWorkspaceError を投げる", () => {
    const registry = makeRegistry({ sandbox: { path: "/home/pi/work/sandbox" } });
    expect(() =>
      resolveExecutionWorkspace(registry, "sandbox", "no-such-workspace", BASE_DIR),
    ).toThrow(UnknownWorkspaceError);
    try {
      resolveExecutionWorkspace(registry, "sandbox", "no-such-workspace", BASE_DIR);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownWorkspaceError);
      expect((err as UnknownWorkspaceError).workspaceName).toBe("no-such-workspace");
    }
  });

  it("Object.prototype 由来のキー(toString 等)は未登録名として UnknownWorkspaceError を投げる(issue #69)", () => {
    const registry = makeRegistry({ sandbox: { path: "/home/pi/work/sandbox" } });
    expect(() => resolveExecutionWorkspace(registry, "sandbox", "toString", BASE_DIR)).toThrow(
      UnknownWorkspaceError,
    );
  });

  it("本当に toString という名前で登録された workspace は従来どおり解決される(issue #69: false positive を起こさない)", () => {
    const registry = makeRegistry({ toString: { path: "/home/pi/work/toString" } });
    const resolved = resolveExecutionWorkspace(registry, "toString", null, BASE_DIR);
    expect(resolved).toEqual({ name: "toString", path: "/home/pi/work/toString" });
  });

  it("path 省略エントリは <TIDEPOOL_WORKSPACES_DIR>/<name> に解決時導出される(ADR 0018)", () => {
    const registry = makeRegistry({ sandbox: {} });
    const resolved = resolveExecutionWorkspace(registry, "sandbox", null, BASE_DIR);
    expect(resolved).toEqual({ name: "sandbox", path: `${BASE_DIR}/sandbox` });
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

describe("listRegisteredWorkspaces(ADR 0040 の boot 一斉検査の対象)", () => {
  it("登録済み workspace を全件、path を解決して返す(明示 path と ADR 0018 の規約由来が混ざっていても)", () => {
    const registry = makeRegistry({
      sandbox: { path: "/home/pi/work/sandbox" },
      // path 省略 = <workspacesBaseDir>/<name>(ADR 0018)
      lagoon: {},
    });
    expect(listRegisteredWorkspaces(registry, BASE_DIR)).toEqual([
      { name: "sandbox", path: "/home/pi/work/sandbox", branch: undefined, review_allowed_commands: undefined },
      { name: "lagoon", path: `${BASE_DIR}/lagoon`, branch: undefined, review_allowed_commands: undefined },
    ]);
  });

  it("登録が1つも無ければ空(検査する相手がいない)", () => {
    expect(listRegisteredWorkspaces(makeRegistry({}), BASE_DIR)).toEqual([]);
  });
});
