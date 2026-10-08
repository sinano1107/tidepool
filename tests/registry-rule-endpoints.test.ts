import { afterEach, expect, it } from "vitest";
import { createAgent, updateAgent } from "../src/agent-create.js";
import { createProfile } from "../src/profile-create.js";
import { whyInvalidRegistryName } from "../src/registry-name.js";
import { whyInvalidSkillAllowlist } from "../src/skill-allowlist.js";
import { createWorkspace } from "../src/workspace-create.js";
import { seedTierNames } from "./fakes.js";
import { api, bootTidepool, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

let t: Tidepool;
afterEach(() => t?.stop());

const agent = { authority: "standard", provider: "anthropic", description: "General work", skills: [], systemPrompt: "" };

it.each([
  ["workspace", "POST", "/api/workspaces", { mode: "create", name: ".." }, whyInvalidRegistryName("..")],
  ["agent", "POST", "/api/agents", { ...agent, name: "." }, whyInvalidRegistryName(".")],
  ["profile", "POST", "/api/profiles", { name: "a/b", guidance: "", assignable_to: [], allowed_workspaces: [], merge: "external" }, whyInvalidRegistryName("a/b")],
  ["agent skills creation", "POST", "/api/agents", { ...agent, name: "new-agent", skills: ["foo*"] }, whyInvalidSkillAllowlist(["foo*"])],
  ["agent skills update", "PATCH", "/api/agents/deckhand", { ...agent, skills: ["foo*"] }, whyInvalidSkillAllowlist(["foo*"])],
] as const)("%s HTTP refusal includes the shared leaf reason", async (_name, method, path, body, reason) => {
  const registry = { dir: await makeRegistry(), mode: "purely-local" as const };
  const deps = { registry, tiers: () => seedTierNames };
  const workspacesBaseDir = await tempDir("tidepool-name-rule-");
  t = await bootTidepool({
    workspaceAdmin: { create: (input) => createWorkspace(input, { registry, workspacesBaseDir }) },
    agentAdmin: { create: (input) => createAgent(input, deps), update: (input) => updateAgent(input, deps) },
    profileAdmin: { create: (input) => createProfile(input, { registry }) },
  });
  const res = await api(t.baseUrl, method, path, body);
  expect(res.status).toBe(400);
  expect(res.json.error).toContain(reason);
});
