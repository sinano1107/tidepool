import { expect, it } from "vitest";
import { createAgent, listAgentViews } from "../src/agent-create.js";
import { openDb } from "../src/db.js";
import { createProfile, listProfileViews } from "../src/profile-create.js";
import { openQuarantineValues } from "../src/quarantine.js";
import type { RegistrySource } from "../src/registry.js";
import { RegistryUnreadableError } from "../src/registry-unreadable.js";
import { createWorkspace, listWorkspaceViews } from "../src/workspace-create.js";
import { FakeClock, seedTierNames } from "./fakes.js";
import { breakRegistry, makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

type Door = (deps: { db: ReturnType<typeof openDb>; clock: FakeClock; registry: RegistrySource; workspacesBaseDir: string }) => unknown;

const doors: Record<string, Door> = {
  "agent create": (deps) =>
    createAgent({ name: "tako", authority: "standard", provider: "anthropic", skills: ["*"], description: "d", systemPrompt: "p" }, { ...deps, tiers: () => seedTierNames }),
  "agent list": (deps) => listAgentViews(deps),
  "workspace create": (deps) => createWorkspace({ mode: "create", name: "lagoon" }, deps),
  "workspace list": (deps) => listWorkspaceViews(deps, "configured"),
  "authority profile create": (deps) =>
    createProfile({ name: "risky", guidance: "g", assignable_to: ["*"], allowed_workspaces: ["*"], merge: "external" }, deps),
  "authority profile list": (deps) => listProfileViews(deps),
};

async function doorDeps(registryDir: string) {
  return { db: openDb(":memory:"), clock: new FakeClock(), registry: { dir: registryDir, mode: "purely-local" as const }, workspacesBaseDir: await tempDir("tidepool-doors-") };
}

// ADR 0403 決定5: 管理の扉の registry の読みも読み込みの1点を通る —— 読めなければ止まりを1枚立ててから投げる
it.each(Object.keys(doors))("registry が読めないと、%s は RegistryUnreadableError を投げて registryUnreadable を1枚立てる", async (door) => {
  const registryDir = await makeRegistry();
  breakRegistry(registryDir);
  const deps = await doorDeps(registryDir);

  await expect((async () => doors[door]!(deps))()).rejects.toThrow(RegistryUnreadableError);

  expect(openQuarantineValues(deps.db, "registryUnreadable")).toEqual([null]);
});

// registry のファイルに既にある不正な名前は読み込みの失敗であって、呼び手の入力の誤り(名前の型の 400)ではない
it.each([
  ["workspace", { "workspaces.yaml": "Bad Name:\n  path: /nonexistent/bad\n" }, "workspace create"],
  ["authority profile", { "authority/Bad Name.yaml": "guidance: g\nassignable_to: []\nallowed_workspaces: []\nmerge: external\n" }, "authority profile create"],
] as const)("registry に不正な %s の名前があると、作成の扉は RegistryUnreadableError を投げる", async (_kind, files, door) => {
  const deps = await doorDeps(await makeRegistry(files));

  await expect((async () => doors[door]!(deps))()).rejects.toThrow(RegistryUnreadableError);
});
