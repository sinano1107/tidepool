import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { agentNeedsHuman, resolveAgentOrQuarantine, resolveExecutionAgent } from "../src/agent.js";
import { openDb } from "../src/db.js";
import { DEFAULT_INTERVIEWER_NAME } from "../src/defaults.js";
import { buildMemoryInjection, humanEntryInput, recordBehavior } from "../src/memory.js";
import {
  assertValidAgentName,
  InvalidAgentNameError,
  loadRegistry,
  REVIEWER_AUTHORITY_PROFILE,
} from "../src/registry.js";
import { listQueue, nextSlotTask, registerTask, resolveTaskAgent } from "../src/tasks.js";
import { seedTierNames } from "./fakes.js";
import { HUMAN_WEBUI } from "./harness.js";
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
    // spawn 記録の definition_version が運ぶのは本文の内容 hash(ADR 0270 決定1)。空本文も空文字列の hash
    version: createHash("sha256").update("").digest("hex").slice(0, 16),
  });
});

it("各組み込みの version は現在の本文の hash(ADR 0270 決定1)", async () => {
  const registry = loadRegistry(await makeRegistry(), "purely-local");

  for (const name of ["fugu", DEFAULT_INTERVIEWER_NAME]) {
    const agent = registry.agents[name]!;
    expect(agent.version).toBe(createHash("sha256").update(agent.systemPrompt).digest("hex").slice(0, 16));
  }
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

  const resolved = resolveExecutionAgent(registry, "deckhand", "fugu", seedTierNames, "review");

  expect(resolved.name).toBe("fugu");
  expect(resolved.profile).toEqual(REVIEWER_AUTHORITY_PROFILE);
  expect(registry.authority.reviewer).toBeUndefined();
});

it("組み込みに解決される work の実行解決は失敗し、agent 名の quarantine に落ちる(ADR 0228 決定4)", async () => {
  const registry = loadRegistry(await makeRegistry(), "purely-local");
  const db = openDb(":memory:");

  const resolved = resolveAgentOrQuarantine(
    db,
    (assignee) => resolveExecutionAgent(registry, "deckhand", assignee, seedTierNames, "work"),
    "fugu",
    new Date(0),
  );

  expect(resolved).toBeUndefined();
  expect(agentNeedsHuman(db, "fugu")).toBe(true);
});

it("shadow している間は、その名前の work は registry のエントリで解決する(ADR 0228 決定2)", async () => {
  const registry = loadRegistry(
    await makeRegistry({
      "agents/fugu.md": '---\nversion: "2"\nauthority: standard\ndescription: My own auditor.\nprovider: anthropic\nskills: []\n---\nYou are my fugu.\n',
    }),
    "purely-local",
  );

  const resolved = resolveExecutionAgent(registry, "deckhand", "fugu", seedTierNames, "work");

  expect(resolved.definition.builtin).toBeUndefined();
  expect(resolved.profile.name).toBe("standard");
});

it("組み込みだけが持つ名前は「既に存在する」で弾かれない —— 作成の扉は同名を拒まない(ADR 0117 決定2)", async () => {
  const registry = loadRegistry(await makeRegistry(), "purely-local");

  expect(() => assertValidAgentName(registry, "fugu")).not.toThrow();
  expect(() => assertValidAgentName(registry, "deckhand")).toThrow(InvalidAgentNameError);
});

it("組み込みの Interviewer suzumedai も、ファイルが無ければ印つきで map に居て reviewer profile で解決し、同名のファイルが shadow する(ADR 0269 決定1)", async () => {
  const dir = await makeRegistry();
  const builtIn = loadRegistry(dir, "purely-local");

  expect(builtIn.agents.suzumedai).toMatchObject({ name: "suzumedai", builtin: true, skills: ["@workspace"], icon: "🐠" });
  // ADR 0275 決定3: 規律は盤面が運ぶので本文は空
  expect(builtIn.agents.suzumedai!.systemPrompt).toBe("");
  expect(resolveExecutionAgent(builtIn, "deckhand", "suzumedai", seedTierNames, "review").profile).toEqual(REVIEWER_AUTHORITY_PROFILE);

  const shadowed = loadRegistry(
    await makeRegistry({
      "agents/suzumedai.md": '---\nversion: "2"\nauthority: standard\ndescription: My own interviewer.\nprovider: anthropic\nskills: []\n---\nYou are my suzumedai.\n',
    }),
    "purely-local",
  );
  expect(shadowed.agents.suzumedai).toMatchObject({ systemPrompt: "You are my suzumedai." });
  expect(shadowed.agents.suzumedai!.builtin).toBeUndefined();
});

it("suzumedai に解決される work の実行解決も失敗し、agent 名の quarantine に落ちる(ADR 0228 決定4 / ADR 0269 決定1)", async () => {
  const registry = loadRegistry(await makeRegistry(), "purely-local");
  const db = openDb(":memory:");

  const resolved = resolveAgentOrQuarantine(
    db,
    (assignee) => resolveExecutionAgent(registry, "deckhand", assignee, seedTierNames, "work"),
    "suzumedai",
    new Date(0),
  );

  expect(resolved).toBeUndefined();
  expect(agentNeedsHuman(db, "suzumedai")).toBe(true);
  // 未知の名前としてではなく、組み込みの検査で落ちる
  expect(() => resolveExecutionAgent(registry, "deckhand", "suzumedai", seedTierNames, "work")).toThrow(
    /runs only reviews, Interviews, memory repairs and routing repairs/,
  );
});

it.each(["memory_repair", "routing_repair"] as const)("suzumedai に解決される %s は reviewer 定数の profile で解決し、agent 名の quarantine に落ちない(ADR 0275 決定1 / ADR 0279 決定4)", async (type) => {
  const registry = loadRegistry(await makeRegistry(), "purely-local");
  const db = openDb(":memory:");

  const resolved = resolveAgentOrQuarantine(
    db,
    (assignee) => resolveExecutionAgent(registry, "deckhand", assignee, seedTierNames, type),
    "suzumedai",
    new Date(0),
  );

  expect(resolved).toMatchObject({ name: "suzumedai", profile: REVIEWER_AUTHORITY_PROFILE });
  expect(agentNeedsHuman(db, "suzumedai")).toBe(false);
});

it("Interview の root の空の assignee は Interviewer ポインタに解決され、spawn の解決と pickup 候補の fallback が一致する —— 本番の review は Auditor、名指した root はその agent(ADR 0269 決定2)", () => {
  const db = openDb(":memory:");
  const target = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
  const register = (fields: object) =>
    registerTask(db, { type: "review", title: "t", purpose: "p", completion_criteria: "c", ...fields }, new Date(0), ...HUMAN_WEBUI);
  const interview = { type: "interview", purpose: undefined, completion_criteria: undefined, hypothesis: "h", tier: "standard", interview_targets: [target] };
  const root = register(interview);
  const named = register({ ...interview, assignee: "shako" });
  const review = register({});

  const spawned = [root, named, review].map((task) => resolveTaskAgent(task, "tako", "fugu", "suzumedai"));
  expect(spawned).toEqual(["suzumedai", "shako", "fugu"]);

  // pickup 側: 解決した名前の quarantine がその task だけを止める
  for (const [index, task] of [root, named, review].entries()) {
    const stopped = { workspaces: [], assignees: [spawned[index]!] };
    const queue = listQueue(db, undefined, "tako", "fugu", stopped, undefined, undefined, "suzumedai");
    expect(queue.find(({ id }) => id === task.id)).toMatchObject({ assignee: spawned[index], status: "skipped" });
    expect(queue.filter(({ status }) => status === "skipped")).toHaveLength(1);
    expect(nextSlotTask(db, undefined, "tako", "fugu", stopped, undefined, undefined, "suzumedai")?.id).not.toBe(task.id);
  }
});

it("suzumedai 宛ての Behavior は Interview の root の注入に載る —— 宛先は名前で照合され、書き込みは registry を引かない(ADR 0269 決定3)", () => {
  const db = openDb(":memory:");
  const root = registerTask(
    db,
    { type: "interview", title: "write the rubric", hypothesis: "measure", tier: "standard", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] },
    new Date(0),
    ...HUMAN_WEBUI,
  );
  const { entry_id } = recordBehavior(
    db,
    humanEntryInput(db, { workspace: "tidepool", path: "probes", title: "Pin the rubric", text: "Write the rubric before any answer.", addressee: "suzumedai" }),
    "webui",
    new Date(0),
  );

  const agent = resolveTaskAgent(root, "tako", "fugu", DEFAULT_INTERVIEWER_NAME);
  expect(buildMemoryInjection(db, root, "tidepool", agent).entries).toEqual([{ id: entry_id, version: entry_id }]);
});
