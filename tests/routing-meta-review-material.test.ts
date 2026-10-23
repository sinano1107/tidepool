import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, getEvent, listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange, type ExecutionSetting, readExecutionSettings } from "../src/execution-setting.js";
import { recordShadow } from "../src/learner.js";
import { buildMetaReviewMaterial, listPrecedents, recordMetaReviewMaterial } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { listRoutingCells, listRoutingShadow, proposeRoutingChange, type RoutingObject, readRoutingSettings } from "../src/routing-review.js";
import { getTask, logDecision, registerTask } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { answerQuestionViaWebui, bundledObjection, divergedSession, episodeOfDecision, executionSetting, HUMAN_WEBUI, objectedJudgment, QUIET_EXIT, rowSession, WORKER_SPAWNED } from "./harness.js";

/** routing meta-review の材料の節(ADR 0180 追記 #1239)のドメイン層。spawn の prompt に入ることは両 adapter のテストが言う。 */
const at = new Date("2026-10-01T00:00:00.000Z");

/** 主題(既定 routing)の meta-review を登録し、その task の id を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, done = false, subject: "routing" | "memory" = "routing"): string {
  registerMetaReview(db, subject, at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return taskId;
}

/** registry の agent(setup): deckhand は standard で、1段下げる先がある。 */
const AGENTS = [{ name: "deckhand", tier: "standard" }];

/** 主題 routing の材料の節(型を routing の部分に絞る)。 */
function routingMaterialOf(db: Db, taskId: string, agents: readonly { name: string; tier?: string }[] = AGENTS) {
  const material = buildMetaReviewMaterial(db, taskId, agents);
  if (material?.subject !== "routing") throw new Error(`no routing material for ${taskId}`);
  return material;
}

it("材料の節は両端の watermark と7つの部分の見出しを持ち、材料の無い部分は空と書く —— 学習器は毎周期の項目", () => {
  const db = openDb(":memory:");
  register(db, true);
  const review = register(db);
  const [first, second] = listEventsOfKinds(db, ["meta_review_registered"]).map((e) => e.payload.material_watermark);

  const material = routingMaterialOf(db, review);

  expect([material.previous_watermark, material.material_watermark]).toEqual([first, second]);
  for (const line of [
    "## Routing meta-review material",
    `after event ${first} up to and including event ${second}`,
    "### Table and settings",
    "### Diverged shadow rows",
    "(no diverged shadow rows)",
    "### Allocation reviews",
    "(no allocation reviews)",
    "### New cells and changed rows",
    "(no new cells or changed rows)",
    "### Objected decisions",
    "(no objected decisions)",
    "### Settled proposals",
    "(no settled proposals)",
    "### Items to judge",
    '{"learner":true}',
  ]) {
    expect(material.section).toContain(line);
  }
});

const opus = executionSetting("anthropic", "opus", { source: { tier: "agent", provider: "rank" } });
const sol = executionSetting("openai", "gpt-5.6-sol", { source: { tier: "agent", provider: "rank" } });
const none = { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 }, seed: null };
/** recordShadow へ渡す組(setup のみ): 実績は空。 */
const shadow = (recommended: ExecutionSetting, actual: ExecutionSetting, candidates = 2) => ({
  recommended,
  actual,
  basis: "prior" as const,
  recommended_record: none,
  actual_record: none,
  candidates,
});
const judge = { provider: "anthropic" as const, model: "fable", effort: "high" };

/** setup の口(tests/routing-meta-review-reads.test.ts と同じ形)。 */
function board() {
  const db = openDb(":memory:");
  const work = (title: string) => registerTask(db, { type: "work", title, purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const spawn = (taskId: string, agent: string, run: ExecutionSetting) =>
    appendEvent(db, {
      taskId,
      workerId: agent,
      origin: "board",
      at,
      payload: { ...WORKER_SPAWNED, advisor: null, provider: run.provider, model: run.model, effort: run.effort, tier_id: run.tier_id, source: run.source, harness: run.provider === "openai" ? "codex" : "claude-code" },
    });
  const exit = (taskId: string, spawned: number) => {
    const tokens = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: 0.5 };
    return appendEvent(db, {
      taskId,
      workerId: "board",
      origin: "board",
      at,
      payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, usage: { ...tokens, advisor: null, model_swaps: [], refusals: [], models: {} } },
    });
  };
  const allocate = (taskId: string, spawned: number, allocation: "overpowered" | "appropriate") =>
    appendEvent(db, {
      taskId,
      workerId: "tidepool",
      origin: "board",
      at,
      payload: { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: spawned, judge, allocation, cause: "uncertain", evidence: "e" } as Extract<EventPayload, { kind: "allocation_reviewed" }>,
    });
  return { db, work, spawn, exit, allocate };
}

it("表と設定は read_routing_settings の提案以外の全部で、窓ではなく spawn 時点の値 —— 前回より前に書かれた行も、登録より後の変更も出る", () => {
  const { db } = board();
  const row = { provider: "anthropic" as const, tier: "economy" as const, model: "claude-haiku-5-5", effort: "low", price_in: 1, price_out: 5 };
  applyExecutionSettingsChange(db, { setting: "row", row }, "webui", at);
  register(db, true);
  const review = register(db);
  applyExecutionSettingsChange(db, { setting: "priority", value: "cost" }, "webui", at);

  const { parts, section } = routingMaterialOf(db, review);

  expect(parts.settings).toEqual(readExecutionSettings(db));
  expect(parts.settings).toMatchObject({ table: expect.arrayContaining([row]), priority: "cost" });
  expect(parts.settings).not.toHaveProperty("proposals");
  expect(section).toContain(JSON.stringify(readExecutionSettings(db)));
});

it("shadow の部分は窓 `前回 <= event_watermark < 今回` の乖離した行だけを list_routing_shadow の行で載せ、全行数は一致した行を含み、候補が2行以上あった行の数を並べる —— 前回より前と今回以後の行は行にも数にも入らない", () => {
  const { db, work } = board();
  register(db, true);
  const review = register(db);
  const [after, upTo] = listEventsOfKinds(db, ["meta_review_registered"]).map((e) => e.payload.material_watermark) as [number, number];
  // setup のみ: 境界の watermark を直接置く(recordShadow は書いた時点の最大 id を焼く)
  const shadowAt = (title: string, watermark: number, recommended = sol, candidates = 2) => {
    const taskId = work(title);
    recordShadow(db, taskId, shadow(recommended, opus, candidates), at);
    db.prepare("UPDATE learner_shadow SET event_watermark = ? WHERE id = (SELECT MAX(id) FROM learner_shadow)").run(watermark);
    return taskId;
  };
  shadowAt("before", after - 1);
  const atAfter = shadowAt("at-after", after);
  shadowAt("matched", after + 1, opus, 1);
  const inside = shadowAt("inside", upTo - 1);
  shadowAt("at-up-to", upTo);
  shadowAt("later", upTo + 1);

  const { parts, section } = routingMaterialOf(db, review);

  expect(parts.shadow.map((row) => row.task_id)).toEqual([atAfter, inside]);
  expect(parts.shadow_rows).toBe(3);
  expect(parts.shadow_rows_multi_candidate).toBe(2);
  const verbRows = listRoutingShadow(db, review, { diverged_only: true }).shadow.filter((row) => [atAfter, inside].includes(row.task_id));
  for (const row of verbRows) expect(section).toContain(JSON.stringify(row));
  expect(section).toContain("3 shadow rows were written in this window, 2 of them with two or more candidates");
});

it("配分評価の分布は窓の中の注釈だけを list_allocations の行で数え、前回より前とこの task の登録より後の注釈は数えない", () => {
  const { db, work, spawn, allocate } = board();
  const task = work("t");
  const early = spawn(task, "reef-crab", opus);
  allocate(task, early, "appropriate");
  register(db, true);
  const counted = allocate(task, spawn(task, "reef-crab", opus), "overpowered");
  const review = register(db);
  allocate(task, spawn(task, "reef-crab", opus), "overpowered");

  const { parts, section } = routingMaterialOf(db, review);

  expect(parts.allocations.groups).toEqual([
    { source_tier: "agent", row: "anthropic / opus at effort high", tier: "economy", agent: "reef-crab", workspace: "none", writer: "human", allocation: "overpowered", cause: "uncertain", count: 1, judged_by_same_model: 0 },
  ]);
  expect(parts.allocations.counted).toEqual([counted]);
  expect(section).toContain(
    '{"source_tier":"agent","row":"anthropic / opus at effort high","tier":"economy","agent":"reef-crab","workspace":"none","writer":"human","allocation":"overpowered","cause":"uncertain","count":1,"judged_by_same_model":0}',
  );
});

it("新しいセルは初観測が窓の中のものだけ、人間が変えた行は窓の中の直接編集だけで、提案への approve の適用は出ない", () => {
  const { db, work, spawn, exit } = board();
  const task = work("t");
  const row = { provider: "anthropic" as const, tier: "standard" as const, model: "claude-opus-5", effort: "high", price_in: 5, price_out: 25 };
  exit(task, spawn(task, "deckhand", opus));
  applyExecutionSettingsChange(db, { setting: "row", row }, "webui", at);
  register(db, true);
  exit(task, spawn(task, "deckhand", opus)); // 既知のセル
  const seen = exit(task, spawn(task, "deckhand", sol));
  const key = (effort: string) => ({ provider: row.provider, model: row.model, effort });
  const edited = applyExecutionSettingsChange(db, { setting: "row", key: key("high"), row: { ...row, effort: "max" } }, "mcp", at)!;
  applyExecutionSettingsChange(db, { setting: "row", key: key("max"), row: { ...row, tier: "frontier" } }, "webui", at, "question-1");
  const review = register(db);
  exit(task, spawn(task, "deckhand", executionSetting("moonshot", "kimi-k3")));
  applyExecutionSettingsChange(db, { setting: "row", key: key("high"), row: { ...row, effort: "low" } }, "mcp", at);

  const { parts, section } = routingMaterialOf(db, review);

  expect(parts.cells).toEqual([{ cell: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null }, first_observed_event_id: seen, seeds: [] }]);
  expect(parts.rows.map((r) => r.event_id)).toEqual([edited]);
  const verb = listRoutingCells(db, review, {});
  for (const shown of [verb.cells[0], verb.rows![0]]) expect(section).toContain(JSON.stringify(shown));
});

it("決着した提案は回答か陳腐化が窓の中にあるものだけを read_routing_settings の提案の行で、回答・修正値・comment・observed の理由とともに載せる —— registry 種別も含み、前回より前・この task の登録より後に決着した提案と open な提案は出ない", () => {
  const { db } = board();
  const parent = register(db, true);
  // fable は種で frontier —— 同じ段への提案は拒まれる(issue #1666)ので、別の段を名指す
  const propose = (model: string) =>
    proposeRoutingChange(
      db,
      parent,
      { op: "row", row: { provider: "anthropic", model, effort: "high" }, change: { tier: model === "claude-fable-5-1" ? "economy" : "frontier" }, evidence: [rowSession(db, { provider: "anthropic", model, effort: "high" }, at)], rationale: "r" },
      "auditor",
      at,
    ).question_id;
  const answer = (id: string, answers: string[], comment?: string, amendment?: { tier: "economy" }) => answerQuestionViaWebui(db, getTask(db, id)!, answers, at, { comment, amendment });
  const early = propose("claude-sonnet-5-5");
  answer(early, ["reject"], "Too early.");
  const [rejected, stale, open, late] = ["claude-opus-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5"].map(propose) as [string, string, string, string];
  const registry = registerTask(
    db,
    {
      type: "question",
      title: "Lower agent reef-crab's tier",
      purpose: "p",
      completion_criteria: "a human answer is recorded",
      parent_id: parent,
      question: [{ title: "t", detail: "d", options: ["approve", "reject"], recommendation: "approve" }],
      question_kind: { kind: "proposal", proposal: { kind: "registry", op: "agent_tier", agent: "reef-crab", to: tierIdOf(db, "economy"), pin: { tier: tierIdOf(db, "standard"), rows: [] }, evidence: [1] } },
    },
    at,
    "auditor",
    "worker",
  ).id;
  register(db, true);
  answer(rejected, ["approve"], "Amended.", { tier: "economy" });
  applyExecutionSettingsChange(
    db,
    { setting: "row", key: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, row: { provider: "anthropic", tier: "frontier", model: "claude-opus-5-5", effort: "high", price_in: 5, price_out: 25 } },
    "webui",
    at,
  );
  answer(registry, ["reject"], "Keep it.");
  const review = register(db);
  answer(late, ["reject"], "Too late.");

  const { parts } = routingMaterialOf(db, review);

  expect(parts.proposals.map((p) => p.question_id)).toEqual([rejected, stale, registry]);
  expect(parts.proposals).toEqual(readRoutingSettings(db, {}).proposals.filter((p) => [rejected, stale, registry].includes(p.question_id)));
  expect(parts.proposals).toMatchObject([
    { answer: "approve", amendment: { tier: "economy" }, comment: "Amended.", observed: null },
    { answer: null, observed: { changed: expect.anything(), observed_event_id: expect.any(Number) } },
    { proposal: { kind: "registry" }, answer: "reject", comment: "Keep it." },
  ]);
  expect(readRoutingSettings(db, {}).proposals.map((p) => p.question_id)).toEqual([early, rejected, stale, open, late, registry]);
});

it("節を組んだ記録は主題 routing と、乖離した shadow 行の id・窓の中の全 shadow 行の数と候補が2行以上あった行の数・数えた注釈・新しいセルの初観測・人間が変えた行・提案の question の id、注入した Items to judge、両端の watermark とトークン数を運ぶ", () => {
  const { db, work, spawn, exit, allocate } = board();
  // 昇格の提案の根拠(前回の窓の中で、この窓の外)
  const evidence = divergedSession(db, at);
  const previous = register(db, true);
  const task = work("t");
  const diverged = recordShadow(db, task, shadow(sol, opus), at);
  recordShadow(db, task, shadow(opus, opus, 1), at);
  const spawned = spawn(task, "deckhand", opus);
  const seen = exit(task, spawned);
  const annotation = allocate(task, spawned, "appropriate");
  applyExecutionSettingsChange(db, { setting: "priority", value: "cost" }, "webui", at);
  const rowEdit = applyExecutionSettingsChange(db, { setting: "row", row: { provider: "anthropic", tier: "economy", model: "claude-haiku-5-5", effort: "low", price_in: 1, price_out: 5 } }, "webui", at)!;
  const question = proposeRoutingChange(db, previous, { op: "promote", evidence: [evidence], rationale: "r" }, "auditor", at).question_id;
  answerQuestionViaWebui(db, getTask(db, question)!, ["reject"], at, { comment: "Not yet." });
  const review = register(db);
  const [first, second] = listEventsOfKinds(db, ["meta_review_registered"]).map((e) => e.payload.material_watermark);
  const material = routingMaterialOf(db, review);

  const eventId = recordMetaReviewMaterial(db, review, "auditor", 42, material, at);

  expect(getEvent(db, eventId)).toMatchObject({
    task_id: review,
    worker_id: "auditor",
    origin: "board",
    payload: {
      kind: "meta_review_material_injected",
      subject: "routing",
      worker_spawned_event_id: 42,
      previous_watermark: first,
      material_watermark: second,
      shadow: [diverged],
      shadow_rows: 2,
      shadow_rows_multi_candidate: 1,
      allocations: [annotation],
      cells: [seen],
      rows: [rowEdit],
      proposals: [question],
      items: material.parts.items,
      tokens: material.tokens,
      tokenizer: "gpt-tokenizer/o200k_base",
    },
  });
  expect(material.tokens).toBeGreaterThan(0);
});

const haikuRow = { provider: "anthropic" as const, tier: "economy" as const, model: "claude-haiku-5-5", effort: "low", price_in: 1, price_out: 5 };
const haiku = { provider: haikuRow.provider, model: haikuRow.model, effort: haikuRow.effort };

it("Items to judge は complete_routing_review の鍵で評価の対象を並べる —— session に辿り着いた乖離 shadow 行で走った行・人間が変えた行・初観測のセルの行(どれも今の表の段を添える)、出所が agent の集計の agent、出所が task の集計の段(項目は段の id を持ち、節には名前で出る)、学習器。配分評価の集計行そのものは項目にならない", () => {
  const { db, work, spawn, exit, allocate } = board();
  register(db, true);
  const ran = work("ran");
  recordShadow(db, ran, shadow(sol, executionSetting("anthropic", "claude-opus-5-5")), at);
  allocate(ran, spawn(ran, "deckhand", executionSetting("anthropic", "claude-opus-5-5", { source: { tier: "agent", provider: "rank" } })), "overpowered");
  // session に辿り着かなかった乖離 shadow 行は走っていない
  recordShadow(db, work("never spawned"), shadow(opus, executionSetting("openai", "gpt-5.6-sol")), at);
  applyExecutionSettingsChange(db, { setting: "row", row: haikuRow }, "webui", at);
  const observed = work("observed");
  const spawned = spawn(observed, "reef-crab", executionSetting("openai", "gpt-5.6-terra", { source: { tier: "task", provider: "rank" } }));
  exit(observed, spawned);
  allocate(observed, spawned, "appropriate");
  const review = register(db);

  const { parts, section } = routingMaterialOf(db, review);

  expect(parts.items).toEqual([
    { row: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, tier: "standard" },
    { row: haiku, tier: "economy" },
    { row: { provider: "openai", model: "gpt-5.6-terra", effort: "high" }, tier: "economy" },
    { agent: "deckhand" },
    { tier_id: tierIdOf(db, "economy"), tier: "economy" },
    { learner: true },
  ]);
  expect(section).toContain("### Items to judge");
  for (const key of [...parts.items.slice(0, 4), { tier: "economy" }, { learner: true }]) expect(section).toContain(JSON.stringify(key));
  expect(section).not.toContain('"tier_id"');
});

it("段の出所が agent の集計の agent は、agent_tier が届くときだけ項目 —— 一番下の段の agent と registry に無い agent は項目にならない", () => {
  const { db, work, spawn, allocate } = board();
  register(db, true);
  const task = work("t");
  for (const agent of ["deckhand", "reef-crab", "gone"]) allocate(task, spawn(task, agent, opus), "overpowered");
  const review = register(db);

  const { parts } = routingMaterialOf(db, review, [...AGENTS, { name: "reef-crab", tier: "economy" }]);

  expect(parts.allocations.groups.map((g) => g.agent)).toEqual(["deckhand", "reef-crab", "gone"]);
  expect(parts.items).toEqual([{ agent: "deckhand" }, { learner: true }]);
});

it("乖離 shadow 行で走った行が spawn の前に表から消されていれば項目にならず、出所が task の集計の段が消された(引退した)段なら項目にならない", () => {
  const { db, work, spawn, allocate } = board();
  register(db, true);
  const ran = work("ran");
  recordShadow(db, ran, shadow(opus, executionSetting("openai", "gpt-5.6-sol")), at);
  spawn(ran, "deckhand", executionSetting("openai", "gpt-5.6-sol"));
  applyExecutionSettingsChange(db, { setting: "delete_row", provider: "openai", model: "gpt-5.6-sol", effort: "high" }, "webui", at);
  applyExecutionSettingsChange(db, { setting: "insert_tier", name: "careful", description: "Careful work.", position: 1 }, "webui", at);
  const careful = tierIdOf(db, "careful");
  const task = work("t");
  allocate(task, spawn(task, "reef-crab", executionSetting("anthropic", "claude-opus-5-5", { tier_id: careful, source: { tier: "task", provider: "rank" } })), "appropriate");
  applyExecutionSettingsChange(db, { setting: "delete_tier", name: "careful" }, "webui", at);
  const review = register(db);

  const { parts } = routingMaterialOf(db, review);

  expect(parts.shadow).toHaveLength(1);
  expect(parts.allocations.groups).toMatchObject([{ source_tier: "task", tier_retired: true }]);
  expect(parts.items).toEqual([{ learner: true }]);
});

it("初観測のセルに今の表の行が無ければ(人間が行を消した)Items to judge に出ず、New cells には載る", () => {
  const { db, work, spawn, exit } = board();
  register(db, true);
  const task = work("t");
  exit(task, spawn(task, "deckhand", executionSetting("openai", "gpt-5.6-sol")));
  applyExecutionSettingsChange(db, { setting: "delete_row", provider: "openai", model: "gpt-5.6-sol", effort: "high" }, "webui", at);
  const review = register(db);

  const { parts } = routingMaterialOf(db, review);

  expect(parts.cells.map((c) => c.cell.model)).toEqual(["gpt-5.6-sol"]);
  expect(parts.items).toEqual([{ learner: true }]);
});

it("人間が足した行が同じ窓で走って初観測になれば、走った行・人間が変えた行・初観測の行が重なり、項目は1つ", () => {
  const { db, work, spawn, exit } = board();
  register(db, true);
  applyExecutionSettingsChange(db, { setting: "row", row: haikuRow }, "webui", at);
  const task = work("t");
  const run = executionSetting("anthropic", "claude-haiku-5-5", { effort: "low" });
  recordShadow(db, task, shadow(opus, run), at);
  exit(task, spawn(task, "deckhand", run));
  const review = register(db);

  const { parts } = routingMaterialOf(db, review);

  expect([parts.shadow.length, parts.rows.length, parts.cells.length]).toEqual([1, 1, 1]);
  expect(parts.items).toEqual([{ row: haiku, tier: "economy" }, { learner: true }]);
});

it("窓で異議された前の routing meta-review の判断の行が名指す行・agent・段は、今も評価の対象なら Items to judge に1度だけ載る —— 表から消えた行・agent_tier の届かない agent・引退した段・窓の外の異議は載らない(ADR 0279 決定5)", () => {
  const { db } = board();
  const judged = (object: RoutingObject) => ({ kind: "routing" as const, value: "no_change" as const, ...object });
  const older = register(db, true);
  objectedJudgment(db, older, judged({ tier_id: tierIdOf(db, "frontier") }), at);
  applyExecutionSettingsChange(db, { setting: "insert_tier", name: "careful", description: "Careful work.", position: 1 }, "webui", at);
  const careful = tierIdOf(db, "careful");
  const previous = register(db, true);
  applyExecutionSettingsChange(db, { setting: "row", row: haikuRow }, "webui", at);
  applyExecutionSettingsChange(db, { setting: "delete_row", provider: "openai", model: "gpt-5.6-sol", effort: "high" }, "webui", at);
  applyExecutionSettingsChange(db, { setting: "delete_tier", name: "careful" }, "webui", at);
  const opusRow = { provider: "anthropic" as const, model: "claude-opus-5-5", effort: "high" };
  for (const object of [
    { row: opusRow },
    { row: haiku },
    { row: { provider: "openai" as const, model: "gpt-5.6-sol", effort: "high" } },
    { agent: "deckhand" },
    { agent: "gone" },
    { tier_id: tierIdOf(db, "standard") },
    { tier_id: careful },
    { learner: true as const },
  ])
    objectedJudgment(db, previous, judged(object), at);
  const review = register(db);

  const { parts, section } = routingMaterialOf(db, review);

  expect(parts.items).toEqual([
    { row: haiku, tier: "economy" },
    { row: opusRow, tier: "standard" },
    { agent: "deckhand" },
    { tier_id: tierIdOf(db, "standard"), tier: "standard" },
    { learner: true },
  ]);
  expect(section).toContain("the rows, agents and tiers named by the judgments of the objected decisions");
});

it("routing meta-review の purpose は材料の節とその7つの部分を名指し、各項目を提案か complete_routing_review の no_change で判断すると言い、提案の前に過去の提案を read_routing_settings で読むと言い、一致した shadow 行と前回より前は読み口で読めると言い、読む順の文は無く、昇格の根拠を乖離した行の outcome でなく推薦したセルの実績に置く —— completion_criteria は各項目を判断したこと(ADR 0180 追記 #1239 / ADR 0278)", () => {
  const db = openDb(":memory:");

  const review = getTask(db, register(db))!;

  expect(review.purpose).toContain(
    "This cycle's material is in your prompt, in the Routing meta-review material section: the current table and settings, the shadow rows " +
      "since the previous routing meta-review where the learner's recommendation diverged from what ran, the allocation reviews since then, " +
      "the cells first seen and the rows humans changed since then, the decisions objected to since then, the routing proposals answered or settled since then, and the items to judge.",
  );
  expect(review.purpose).toContain(
    "Every item to judge needs a judgment: propose a change to it, or leave it unchanged. End the session with complete_routing_review, listing each item you leave unchanged as no_change (with a reason when it helps).",
  );
  expect(review.purpose).not.toContain("log_decision");
  expect(review.purpose).toContain(
    "before you propose a change to a row, the learner flag, an agent's tier or a tier's description, read the earlier proposals on it, with their answers, amendments and comments, with read_routing_settings",
  );
  expect(review.purpose).toContain("read the matched rows, and anything before the previous meta-review, with list_routing_shadow, list_allocations and list_routing_cells");
  expect(review.purpose).not.toContain("First read");
  // 配分評価の組は session の6軸(ADR 0306 決定2)
  expect(review.purpose).toContain(
    "The allocation reviews are grouped by tier source, row, tier, agent, workspace and the writer of the task's text (an overpowered verdict under an agent's default tier is not a writer's declaration)",
  );
  expect(review.purpose).not.toContain("split by tier source and agent");
  // 昇格の根拠は推薦したセルの実績(ADR 0181 決定1・5・6)
  expect(review.purpose).not.toContain("outcomes of the diverged episodes");
  for (const meaning of [
    "The learner leaves the table's first choice only when both that choice and the cell it moves to have observations",
    "each diverged row carries the track records of the recommended and the actual cell as of that pickup",
    "While the learner is not promoted, a diverged row's outcome is the result of the setting the table chose, not of the one the learner recommended",
    "Base any case for promoting the learner on whether the recommended cells' track records, counts included, justify leaving the table",
    "a pickup with one candidate always matches the table, so do not count it as evidence of agreement",
  ]) {
    expect(review.purpose).toContain(meaning);
  }
  expect(review.completion_criteria).toBe(
    "every item to judge in this cycle's material is either proposed on or listed as no_change in complete_routing_review, and each change the evidence supports is proposed",
  );
});

/** setup のみ: 1 marker = 1 episode の直挿しで、task に異議つき decision を置く(memory-meta-review-material.test.ts と同じ形)。 */
function objectedDecision(db: Db, taskId: string, i: number): number {
  const decision = logDecision(db, getTask(db, taskId)!, `decision ${i}`, "deckhand", at, "worker");
  episodeOfDecision(db, taskId, decision);
  bundledObjection(db, taskId, decision, at);
  return decision;
}

it("Objected decisions は読み手 routing の list_precedents の行を載せ、記録はその decision の event id と行のエントリを運ぶ —— 窓に memory meta-review とその子の行と worker の行があっても(ADR 0279 決定6)", () => {
  const { db, work } = board();
  const memory = register(db, true, "memory");
  const previous = register(db, true);
  // meta-review の子は修理子 —— work は帰り先の無い系譜に立たない(ADR 0301 決定2)
  const child = (parent_id: string) => registerTask(db, { type: "memory_repair", title: "repair", purpose: "p", completion_criteria: "c", parent_id }, at, ...HUMAN_WEBUI).id;
  [memory, child(memory), previous, child(previous), work("w")].forEach((taskId, i) => objectedDecision(db, taskId, i + 1));
  const review = register(db);
  const material = routingMaterialOf(db, review);

  const record = getEvent(db, recordMetaReviewMaterial(db, review, "auditor", 42, material, at))!.payload;

  expect(material.parts.precedents).toEqual(listPrecedents(db, { taskId: review, agent: "auditor" }, {}, at).precedents);
  expect(material.section).toContain(`### Objected decisions\n\nRows of list_precedents for the objections raised in this window.\n${JSON.stringify(material.parts.precedents[0])}`);
  expect(record).toMatchObject({ precedents: material.parts.precedents.map((p) => p.decision_event_id), precedent_entries: [] });
});
