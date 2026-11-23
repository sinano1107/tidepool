import { afterEach, expect, it } from "vitest";
import { createAgent } from "../src/agent-create.js";
import { createProfile } from "../src/profile-create.js";
import { RegistryUnreadableError } from "../src/registry-unreadable.js";
import { createWorkspace } from "../src/workspace-create.js";
import { seedTierNames } from "./fakes.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

let t: Tidepool;
afterEach(() => t?.stop());

const agent = { authority: "standard", provider: "anthropic", description: "General work", skills: [], systemPrompt: "" };
const profile = { guidance: "", assignable_to: [], allowed_workspaces: [], merge: "external" };

// ADR 0403 決定5: 読めない registry に当たった人間の要求は、外部の一手の失敗(502)ではなく止まりの理由(503)を返す
it.each([
  ["POST", "/api/workspaces", { mode: "create", name: "lagoon" }],
  ["PATCH", "/api/workspaces/lagoon", {}],
  ["POST", "/api/workspaces/lagoon/publish", { repo: "octo/lagoon" }],
  ["DELETE", "/api/workspaces/lagoon", {}],
  ["POST", "/api/agents", { ...agent, name: "tako" }],
  ["PATCH", "/api/agents/tako", agent],
  ["DELETE", "/api/agents/tako", {}],
  ["POST", "/api/profiles", { ...profile, name: "risky" }],
  ["PATCH", "/api/profiles/risky", {}],
  ["DELETE", "/api/profiles/risky", {}],
] as const)("registry が読めないと、%s %s は 503 を返す", async (method, path, body) => {
  const unreadable = async (): Promise<never> => {
    throw new RegistryUnreadableError(new Error("workspaces.yaml does not parse"));
  };
  t = await bootTidepool({
    workspaceAdmin: { create: unreadable, update: unreadable, publish: unreadable, delete: unreadable },
    agentAdmin: { create: unreadable, update: unreadable, delete: unreadable },
    profileAdmin: { create: unreadable, update: unreadable, delete: unreadable },
  });

  expect((await api(t.baseUrl, method, path, body)).status).toBe(503);
});

// registry のファイルに既にある不正な名前は、要求の名前の誤り(400)ではない
it.each([
  ["workspace", { "workspaces.yaml": "Bad Name:\n  path: /nonexistent/bad\n" }, "/api/workspaces", { mode: "create", name: "lagoon" }],
  ["agent", { "agents/Bad Name.md": "---\ndescription: d\nversion: \"1\"\nauthority: standard\nprovider: anthropic\nskills: []\n---\nYou are bad.\n" }, "/api/agents", { ...agent, name: "tako" }],
  ["authority profile", { "authority/Bad Name.yaml": "guidance: g\nassignable_to: []\nallowed_workspaces: []\nmerge: external\n" }, "/api/profiles", { ...profile, name: "risky" }],
] as const)("registry に不正な %s の名前があると、作成の要求は 503 を返す", async (_kind, files, path, body) => {
  const registry = { dir: await makeRegistry(files), mode: "purely-local" as const };
  const workspacesBaseDir = await tempDir("tidepool-unreadable-");
  t = await bootTidepool({
    workspaceAdmin: { create: (input) => createWorkspace(input, { registry, workspacesBaseDir, db: t.db }) },
    agentAdmin: { create: (input) => createAgent(input, { registry, db: t.db, tiers: () => seedTierNames }) },
    profileAdmin: { create: (input) => createProfile(input, { registry, db: t.db }) },
  });

  expect((await api(t.baseUrl, "POST", path, body)).status).toBe(503);
});
