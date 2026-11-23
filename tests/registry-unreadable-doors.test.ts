import { expect, it } from "vitest";
import { type AgentView, createAgent, listAgentViews, registryTiersOf } from "../src/agent-create.js";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { settleStaleProposals } from "../src/execution-setting.js";
import { registerMetaReview } from "../src/meta-review.js";
import { createProfile, listProfileViews } from "../src/profile-create.js";
import { openQuarantineValues } from "../src/quarantine.js";
import type { RegistrySource } from "../src/registry.js";
import { RegistryUnreadableError } from "../src/registry-unreadable.js";
import { proposeRoutingChange } from "../src/routing-review.js";
import { registerTask } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { createWorkspace, listWorkspaceViews } from "../src/workspace-create.js";
import { FakeClock, seedTierNames } from "./fakes.js";
import { HUMAN_WEBUI, WORKER_SPAWNED } from "./harness.js";
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

// #3682 の最初のコメント: meta-review の registry の照合(registry の提案が開いているときの agent 一覧)も、扉の一覧を通って1点に行き着く
it("registry の提案が開いたまま registry が読めないと、提案の照合は registryUnreadable を1枚立てる", async () => {
  const registryDir = await makeRegistry();
  const deps = await doorDeps(registryDir);
  const now = deps.clock.now();
  const review = registerMetaReview(deps.db, "routing", now).id;
  const evidence = appendEvent(deps.db, {
    taskId: registerTask(deps.db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, now, ...HUMAN_WEBUI).id,
    actorId: "deckhand",
    origin: "board",
    at: now,
    payload: { ...WORKER_SPAWNED, provider: "openai", model: "gpt-6-astra", tier_id: tierIdOf(deps.db, "frontier"), source: { tier: "agent", provider: "only" }, harness: "codex" },
  });
  const deckhand = { name: "deckhand", provider: "openai", tier: "frontier" } as AgentView;
  proposeRoutingChange(deps.db, review, { op: "agent_tier", agent: "deckhand", to: "standard", evidence: [evidence], rationale: "r" }, "auditor", now, () => [deckhand]);
  breakRegistry(registryDir);

  settleStaleProposals(deps.db, now, null, registryTiersOf({ list: () => listAgentViews(deps) }));

  expect(openQuarantineValues(deps.db, "registryUnreadable")).toEqual([null]);
});
