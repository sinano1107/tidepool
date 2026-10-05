import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, getEvent, listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange, type ExecutionSetting, readExecutionSettings } from "../src/execution-setting.js";
import { recordShadow } from "../src/learner.js";
import { buildMetaReviewMaterial, recordMetaReviewMaterial } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { listRoutingCells, listRoutingProposals, listRoutingShadow, proposeRoutingChange } from "../src/routing-review.js";
import { answerQuestion, getTask, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI, QUIET_EXIT, WORKER_SPAWNED } from "./harness.js";

/** routing meta-review の材料の節(ADR 0180 追記 #1239)のドメイン層。spawn の prompt に入ることは両 adapter のテストが言う。 */
const at = new Date("2026-10-01T00:00:00.000Z");

/** routing の meta-review を登録し、その task の id を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, done = false): string {
  registerMetaReview(db, "routing", at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return taskId;
}

/** 主題 routing の材料の節(型を routing の部分に絞る)。 */
function routingMaterialOf(db: Db, taskId: string) {
  const material = buildMetaReviewMaterial(db, taskId);
  if (material?.subject !== "routing") throw new Error(`no routing material for ${taskId}`);
  return material;
}

it("材料の節は両端の watermark と5つの部分の見出しを持ち、材料の無い部分は空と書く", () => {
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
    "### Settled proposals",
    "(no settled proposals)",
  ]) {
    expect(material.section).toContain(line);
  }
});

const setting = (provider: ExecutionSetting["provider"], model: string): ExecutionSetting => ({
  provider,
  model,
  effort: "high",
  advisor: undefined,
  source: { tier: "agent", provider: "rank" },
});
const opus = setting("anthropic", "opus");
const sol = setting("openai", "gpt-5.6-sol");
const none = { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 } };
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
      payload: { ...WORKER_SPAWNED, advisor: null, provider: run.provider, model: run.model, effort: run.effort, source: run.source, harness: run.provider === "openai" ? "codex" : "claude-code" },
    });
  const exit = (taskId: string, spawned: number) => {
    const tokens = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: 0.5 };
    return appendEvent(db, {
      taskId,
      workerId: "board",
      origin: "board",
      at,
      payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, usage: { ...tokens, advisor: null, models: {} } },
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
  const row = { provider: "anthropic" as const, tier: "economy" as const, model: "claude-haiku-4-5", effort: "low", price_in: 1, price_out: 5 };
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

  expect(parts.allocations.groups).toEqual([{ source_tier: "agent", agent: "reef-crab", allocation: "overpowered", cause: "uncertain", count: 1, judged_by_same_model: 0 }]);
  expect(parts.allocations.counted).toEqual([counted]);
  expect(section).toContain('{"source_tier":"agent","agent":"reef-crab","allocation":"overpowered","cause":"uncertain","count":1,"judged_by_same_model":0}');
});

it("新しいセルは初観測が窓の中のものだけ、人間が変えた行は窓の中の直接編集だけで、提案への approve の適用は出ない", () => {
  const { db, work, spawn, exit } = board();
  const task = work("t");
  const row = { provider: "anthropic" as const, tier: "standard" as const, model: "claude-opus-4-1", effort: "high", price_in: 5, price_out: 25 };
  exit(task, spawn(task, "deckhand", opus));
  applyExecutionSettingsChange(db, { setting: "row", row }, "webui", at);
  register(db, true);
  exit(task, spawn(task, "deckhand", opus)); // 既知のセル
  const seen = exit(task, spawn(task, "deckhand", sol));
  const edited = applyExecutionSettingsChange(db, { setting: "row", row: { ...row, effort: "max" } }, "mcp", at)!;
  applyExecutionSettingsChange(db, { setting: "row", row: { ...row, tier: "frontier" } }, "webui", at, "question-1");
  const review = register(db);
  exit(task, spawn(task, "deckhand", setting("moonshot", "kimi-k3")));
  applyExecutionSettingsChange(db, { setting: "row", row: { ...row, effort: "low" } }, "mcp", at);

  const { parts, section } = routingMaterialOf(db, review);

  expect(parts.cells).toEqual([{ cell: { provider: "openai", model: "gpt-5.6-sol", effort: "high", advisor: null }, first_observed_event_id: seen }]);
  expect(parts.rows.map((r) => r.event_id)).toEqual([edited]);
  const verb = listRoutingCells(db, review, {});
  for (const shown of [verb.cells[0], verb.rows![0]]) expect(section).toContain(JSON.stringify(shown));
});

it("決着した提案は回答か陳腐化が窓の中にあるものだけを read_routing_settings の提案の行で、回答・修正値・comment・observed の理由とともに載せる —— registry 種別も含み、前回より前・この task の登録より後に決着した提案と open な提案は出ない", () => {
  const { db } = board();
  const parent = register(db, true);
  const propose = (model: string) =>
    proposeRoutingChange(db, parent, { op: "row", row: { provider: "anthropic", model }, change: { tier: "frontier" }, rationale: "r" }, "auditor", at).question_id;
  const answer = (id: string, answers: string[], comment?: string, amendment?: { tier: "economy" }) => answerQuestion(db, getTask(db, id)!, answers, at, undefined, comment, amendment, "webui");
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
      proposal: { kind: "registry", op: "agent_tier", agent: "reef-crab", to: "economy", pin: { tier: "standard", rows: [] }, evidence: [1] },
    },
    at,
    "auditor",
    "worker",
  ).id;
  register(db, true);
  answer(rejected, ["approve"], "Amended.", { tier: "economy" });
  applyExecutionSettingsChange(db, { setting: "row", row: { provider: "anthropic", tier: "standard", model: "claude-opus-5-5", effort: "max", price_in: 5, price_out: 25 } }, "webui", at);
  answer(registry, ["reject"], "Keep it.");
  const review = register(db);
  answer(late, ["reject"], "Too late.");

  const { parts } = routingMaterialOf(db, review);

  expect(parts.proposals.map((p) => p.question_id)).toEqual([rejected, stale, registry]);
  expect(parts.proposals).toEqual(listRoutingProposals(db).filter((p) => [rejected, stale, registry].includes(p.question_id)));
  expect(parts.proposals).toMatchObject([
    { answer: "approve", amendment: { tier: "economy" }, comment: "Amended.", observed: null },
    { answer: null, observed: { changed: expect.anything(), observed_event_id: expect.any(Number) } },
    { proposal: { kind: "registry" }, answer: "reject", comment: "Keep it." },
  ]);
  expect(listRoutingProposals(db).map((p) => p.question_id)).toEqual([early, rejected, stale, open, late, registry]);
});

it("節を組んだ記録は主題 routing と、乖離した shadow 行の id・窓の中の全 shadow 行の数と候補が2行以上あった行の数・数えた注釈・新しいセルの初観測・人間が変えた行・提案の question の id、両端の watermark とトークン数を運ぶ", () => {
  const { db, work, spawn, exit, allocate } = board();
  const previous = register(db, true);
  const task = work("t");
  const diverged = recordShadow(db, task, shadow(sol, opus), at);
  recordShadow(db, task, shadow(opus, opus, 1), at);
  const spawned = spawn(task, "deckhand", opus);
  const seen = exit(task, spawned);
  const annotation = allocate(task, spawned, "appropriate");
  applyExecutionSettingsChange(db, { setting: "priority", value: "cost" }, "webui", at);
  const rowEdit = applyExecutionSettingsChange(db, { setting: "row", row: { provider: "anthropic", tier: "economy", model: "claude-haiku-4-5", effort: "low", price_in: 1, price_out: 5 } }, "webui", at)!;
  const question = proposeRoutingChange(db, previous, { op: "promote", rationale: "r" }, "auditor", at).question_id;
  answerQuestion(db, getTask(db, question)!, ["reject"], at, undefined, "Not yet.", undefined, "webui");
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
      tokens: material.tokens,
      tokenizer: "gpt-tokenizer/o200k_base",
    },
  });
  expect(material.tokens).toBeGreaterThan(0);
});
