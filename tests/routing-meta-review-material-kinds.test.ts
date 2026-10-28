import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, getEvent, listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange, type ExecutionSetting } from "../src/execution-setting.js";
import { recordShadow } from "../src/learner.js";
import { buildMetaReviewMaterial, recordMetaReviewMaterial } from "../src/memory.js";
import { META_REVIEW_SUBJECTS, readMetaReviewStatus, registerDueMetaReviews, registerMetaReview } from "../src/meta-review.js";
import { completeRoutingReview, listRoutingCells, listRoutingShadow } from "../src/routing-review.js";
import { completeInterview, completeTask, getTask, registerTask } from "../src/tasks.js";
import { executionSetting, FULL_HANDOFF, HUMAN_WEBUI, injectRoutingMaterial, markPickedUp, POSED_HEAD, poseAccepted, QUIET_EXIT, WORKER_SPAWNED } from "./harness.js";

/** routing meta-review の材料の kind ごとの1組(ADR 0312 決定1 / ADR 0319 決定3)のドメイン層: どの kind も、部分に現れる event だけを数える。 */
const at = new Date("2026-10-28T00:00:00.000Z");

/** routing meta-review を登録し、その task の id を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, done = false, subject: "routing" | "memory" = "routing"): string {
  registerMetaReview(db, subject, at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return taskId;
}

function routingMaterialOf(db: Db, taskId: string) {
  const material = buildMetaReviewMaterial(db, taskId);
  if (material?.subject !== "routing") throw new Error(`no routing material for ${taskId}`);
  return material;
}

/** 節の部分 `heading` の本文(次の見出しまで)。 */
const partOf = (section: string, heading: string) => section.split(`### ${heading}\n`)[1]?.split("\n### ")[0] ?? "";

const opus = executionSetting("anthropic", "claude-opus-5-5");
const sol = executionSetting("openai", "gpt-5.6-sol");
const none = { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 }, seed: null };
/** recordShadow へ渡す組(setup のみ): 実績は空。 */
const shadow = (recommended: ExecutionSetting, actual: ExecutionSetting) => ({ recommended, actual, basis: "prior" as const, recommended_record: none, actual_record: none, candidates: 2 });

const work = (db: Db) => registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
const spawn = (db: Db, taskId: string, advisor: string | null = null) =>
  appendEvent(db, { taskId, actorId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, advisor, provider: opus.provider, model: opus.model, effort: opus.effort, tier_id: opus.tier_id, source: opus.source } });
const exit = (db: Db, taskId: string, spawned: number) =>
  appendEvent(db, { taskId, actorId: "board", origin: "board", at, payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, advisor: null, model_swaps: [], refusals: [], usage: null } });
/** setup のみ: work task を pickup して(列は動かさない)、その pickup に乗る shadow 行を書く。返り値は行の id。 */
const pickedUpWithShadow = (db: Db, taskId: string, recommended: ExecutionSetting) => recordShadow(db, taskId, shadow(recommended, opus), at, markPickedUp(db, taskId, at));

type Target = { provider: "anthropic"; model: string; effort: string };
/** setup のみ: 1対象の Interview を段 `tier` で出題し、受験者を完了させる。採点は返す関数で(root を done にし、採点の event id を返す)。 */
function posedInterview(db: Db, target: Target, tier = "standard") {
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the target writes the parser", tier, interview_targets: [target] }, at, ...HUMAN_WEBUI);
  const [examinee] = poseAccepted(db, root, { title: "add a parser", probe: "write a parser", completion_criteria: "the parser works", rubric: "tests pass" }, "auditor", at, "worker", POSED_HEAD);
  completeTask(db, examinee!, FULL_HANDOFF, "deckhand", at, "worker");
  const score = (verdict: "accepted" | "rejected") => {
    completeInterview(db, getTask(db, root.id)!, { scores: [{ child_id: examinee!.id, verdict }], handoff: { outcome: "findings" } }, "auditor", at, "worker");
    return listEventsOfKinds(db, ["interview_scored"]).find((e) => e.task_id === examinee!.id)!.id;
  };
  return { root, examinee: examinee!, score };
}
/** 表に (provider, model, effort) の行の無い対象(既定の表の opus は effort high だけ)。 */
const opusLow: Target = { provider: "anthropic", model: "claude-opus-5-5", effort: "low" };

type MaterialRecord = Extract<EventPayload, { kind: "meta_review_material_injected"; subject: "routing" }>;
type RoutingKind = keyof (typeof META_REVIEW_SUBJECTS)["routing"]["material"];
/** kind ごとの fixture: 呼ぶと窓の前に材料でない下ごしらえを置き、返す関数は窓にその kind の event をちょうど1つ書いて、節の記録の
 *  どの部分にどの id で載るべきかを返す。帰責の2 kind は tests/memory-meta-review-material-kinds.test.ts が同じ形で言う。 */
const KIND_FIXTURES: Record<Exclude<RoutingKind, "objection_attributed" | "stop_attributed">, (db: Db) => () => [keyof MaterialRecord, number]> = {
  task_picked_up: (db) => {
    const task = work(db);
    return () => ["shadow", pickedUpWithShadow(db, task, sol)];
  },
  worker_exited: (db) => {
    const task = work(db);
    const spawned = spawn(db, task);
    return () => ["cell_event_ids", exit(db, task, spawned)];
  },
  execution_settings_changed: (db) => () => [
    "row_change_event_ids",
    applyExecutionSettingsChange(db, { setting: "row", row: { provider: "anthropic", tier: "economy", model: "claude-haiku-5-5", effort: "low", price_in: 1, price_out: 5 } }, "webui", at)!,
  ],
  interview_scored: (db) => {
    const { score } = posedInterview(db, opusLow);
    return () => ["cell_event_ids", score("accepted")];
  },
  allocation_reviewed: (db) => {
    const task = work(db);
    const spawned = spawn(db, task);
    const judge = { provider: "anthropic" as const, model: "claude-fable-5-1", effort: "high" };
    return () => [
      "allocation_review_event_ids",
      appendEvent(db, { taskId: task, actorId: "tidepool", origin: "board", at, payload: { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: spawned, judge, allocation: "appropriate", cause: "uncertain", evidence: "e" } }),
    ];
  },
};

it.each(Object.entries(KIND_FIXTURES))("routing の材料の kind %s の event が窓に1つだけあれば、due が開き(件数 1)、注入した節のその部分の記録に載る(ADR 0319 決定3)", (_, fixture) => {
  const db = openDb(":memory:");
  const inWindow = fixture(db);
  register(db, true);
  const [part, id] = inWindow();

  expect(readMetaReviewStatus(db).routing).toMatchObject({ material_since: 1 });
  registerDueMetaReviews(db, new Date(at.getTime() + 8 * 24 * 60 * 60 * 1000));
  const review = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  expect(getTask(db, review)).toMatchObject({ meta_review_subject: "routing", status: "todo" });
  injectRoutingMaterial(db, review, "auditor", at);
  expect(listEventsOfKinds(db, ["meta_review_material_injected"]).at(-1)!.payload).toMatchObject({ [part]: expect.arrayContaining([id]) });
});

it("推薦と実際が一致した shadow 行の pickup だけの窓は due が開き、節の乖離した行は無く全行数が 1", () => {
  const db = openDb(":memory:");
  const task = work(db);
  register(db, true);
  pickedUpWithShadow(db, task, opus);

  expect(readMetaReviewStatus(db).routing).toMatchObject({ material_since: 1 });
  const { parts, section } = routingMaterialOf(db, register(db));
  expect([parts.shadow, parts.shadow_rows]).toEqual([[], 1]);
  expect(partOf(section, "Diverged shadow rows")).toContain("1 shadow rows were written in this window");
});

it("既に観測されたセルの session の exit だけの窓は due が開き、新しいセルは無く、閉じた本番 session の件数 1 が節と材料の記録に出る(ADR 0319 決定3・4)", () => {
  const db = openDb(":memory:");
  const task = work(db);
  exit(db, task, spawn(db, task));
  register(db, true);
  exit(db, task, spawn(db, task));

  expect(readMetaReviewStatus(db).routing).toMatchObject({ material_since: 1 });
  const review = register(db);
  const { parts, section } = routingMaterialOf(db, review);
  expect([parts.cells, parts.closed_sessions]).toEqual([[], 1]);
  expect(partOf(section, "New cells and changed rows")).toContain("1 production sessions closed in this window");
  injectRoutingMaterial(db, review, "auditor", at);
  expect(listEventsOfKinds(db, ["meta_review_material_injected"]).at(-1)!.payload).toMatchObject({ cell_event_ids: [], closed_sessions: 1, shadow_rows: 0 });
});

it.each([
  [
    "meta-review 自身と Interview の root の session の exit",
    (db: Db) => {
      const own = register(db);
      exit(db, own, spawn(db, own));
      const memory = register(db, false, "memory");
      exit(db, memory, spawn(db, memory));
      const { root } = posedInterview(db, opusLow);
      exit(db, root.id, spawn(db, root.id));
      db.prepare("UPDATE tasks SET status = 'done' WHERE id IN (?, ?)").run(own, memory);
    },
  ],
  [
    "受験者の pickup と exit",
    (db: Db) => {
      const { examinee } = posedInterview(db, opusLow);
      register(db, true);
      markPickedUp(db, examinee.id, at);
      exit(db, examinee.id, spawn(db, examinee.id));
    },
  ],
  ["行でない設定の変更(優先順位)", (db: Db) => (register(db, true), applyExecutionSettingsChange(db, { setting: "priority", value: "cost" }, "webui", at))],
  [
    "却下の採点",
    (db: Db) => {
      const { score } = posedInterview(db, opusLow);
      register(db, true);
      score("rejected");
    },
  ],
] as const)("%s だけの窓は routing の due を開かない —— 部分に現れない event は数えない(ADR 0319 決定3)", (_, setup) => {
  const db = openDb(":memory:");
  setup(db);

  expect(readMetaReviewStatus(db).routing).toMatchObject({ material_since: 0 });
});

it("pickup が前の窓、exit が次の窓にあれば、前の窓の節に行が outcome 無しで載り、次の窓は due が開いて閉じた session の件数 1 —— shadow の部分に行は無い(ADR 0319 決定1・2)", () => {
  const db = openDb(":memory:");
  const task = work(db);
  register(db, true);
  pickedUpWithShadow(db, task, sol);
  const spawned = spawn(db, task);
  const first = register(db);

  const firstMaterial = routingMaterialOf(db, first);
  expect(firstMaterial.parts.shadow.map((row) => row.task_id)).toEqual([task]);
  const [row] = listRoutingShadow(db, first, {}).shadow;
  const { outcome: _, ...sectionRow } = row!;
  expect(partOf(firstMaterial.section, "Diverged shadow rows")).toContain(JSON.stringify(sectionRow));
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(first);
  exit(db, task, spawned);

  expect(readMetaReviewStatus(db).routing).toMatchObject({ material_since: 1 });
  const { parts } = routingMaterialOf(db, register(db));
  expect([parts.shadow, parts.shadow_rows, parts.closed_sessions]).toEqual([[], 0, 1]);
});

it("学習器の分岐が落ちて shadow 行の無い pickup だけの窓は due が開き、shadow の部分は行 0・全行数 0 —— 受け入れた隙間(ADR 0319 決定5)", () => {
  const db = openDb(":memory:");
  const task = work(db);
  register(db, true);
  markPickedUp(db, task, at);

  expect(readMetaReviewStatus(db).routing).toMatchObject({ material_since: 1 });
  const { parts } = routingMaterialOf(db, register(db));
  expect([parts.shadow, parts.shadow_rows]).toEqual([[], 0]);
});

it("節は shadow 行の outcome を list_routing_shadow へ送り、worker_spawned_event_id の null の2義を言い、閉じた本番 session の件数を New cells の注に添える —— purpose も outcome を節で読ませない(ADR 0319 決定2)", () => {
  const db = openDb(":memory:");
  register(db, true);
  const review = register(db);

  const { section } = routingMaterialOf(db, review);

  const shadowPart = partOf(section, "Diverged shadow rows");
  expect(shadowPart).toContain("read a row's outcome with list_routing_shadow");
  expect(shadowPart).toContain("A null worker_spawned_event_id means the pickup has not reached a spawn yet or never started a worker");
  expect(partOf(section, "New cells and changed rows")).toContain("0 production sessions closed in this window");
  const { purpose } = getTask(db, review)!;
  expect(purpose).not.toContain("with how that episode ended");
  expect(purpose).toContain("read a row's outcome with list_routing_shadow");
});

it("表に (provider, model, effort) の行の無い対象の受理の採点は、種のセルとして節と list_routing_cells に出るが項目にはならない —— 段を消した後も tier_retired で載る(ADR 0319 決定4)", () => {
  const db = openDb(":memory:");
  applyExecutionSettingsChange(db, { setting: "insert_tier", name: "careful", description: "Careful work.", position: 1 }, "webui", at);
  const { score } = posedInterview(db, opusLow, "careful");
  register(db, true);
  const scored = score("accepted");
  applyExecutionSettingsChange(db, { setting: "delete_tier", name: "careful" }, "webui", at);
  const review = register(db);

  const { parts } = routingMaterialOf(db, review);

  const cell = { cell: { ...opusLow, advisor: null }, first_observed_event_id: null, seeds: [{ tier: "careful", tier_retired: true, kind: "interview", event_id: scored }] };
  expect(parts.cells).toEqual([cell]);
  expect(listRoutingCells(db, review, {}).cells).toEqual([cell]);
  expect(parts.items).toEqual([{ learner: true }]);
});

it("別の段に同じ (provider, model, effort) の行がある対象の受理の採点は、その行が Items to judge に入り complete_routing_review がその行の判断を求める(ADR 0319 決定4 / ADR 0278 追記5)", () => {
  const db = openDb(":memory:");
  const { score } = posedInterview(db, { provider: "anthropic", model: "claude-opus-5-5", effort: "high" }, "frontier");
  register(db, true);
  const scored = score("accepted");
  const review = register(db);

  const items = injectRoutingMaterial(db, review, "auditor", at);

  expect(routingMaterialOf(db, review).parts.cells).toMatchObject([{ seeds: [{ tier: "frontier", event_id: scored }] }]);
  const opusRow = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
  expect(items).toEqual([{ row: opusRow, tier: "standard" }, { learner: true }]);
  expect(() => completeRoutingReview(db, getTask(db, review)!, { judgments: [{ learner: true }] }, "auditor", at, "worker", [])).toThrow(
    "unjudged: anthropic / claude-opus-5-5 at effort high —",
  );
});

it("窓の中の採点 S1 の後、登録より後に同じ (セル, 段) の採点 S2 が着いても、節のセルは S1 で載る —— list_routing_cells は全期間の最新 S2(ADR 0319 決定4)", () => {
  const db = openDb(":memory:");
  const first = posedInterview(db, opusLow);
  const second = posedInterview(db, opusLow);
  register(db, true);
  const s1 = first.score("accepted");
  const review = register(db);
  const s2 = second.score("accepted");

  expect(routingMaterialOf(db, review).parts.cells).toMatchObject([{ seeds: [{ tier: "standard", event_id: s1 }] }]);
  expect(listRoutingCells(db, review, {}).cells).toMatchObject([{ seeds: [{ tier: "standard", event_id: s2 }] }]);
});

it.each(["previous", "current"])("セルの初観測が %s の窓でも、記録は初観測と今の窓の受理の採点を順に載せる", (window) => {
  const db = openDb(":memory:");
  const { score } = posedInterview(db, { provider: "anthropic", model: opus.model, effort: "high" });
  const task = work(db);
  if (window === "current") register(db, true);
  const seen = exit(db, task, spawn(db, task));
  if (window === "previous") register(db, true);
  const seed = score("accepted");
  const review = register(db);
  const material = routingMaterialOf(db, review);

  expect(material.parts.cells).toMatchObject([{ first_observed_event_id: seen, seeds: [{ event_id: seed }] }]);
  expect(getEvent(db, recordMetaReviewMaterial(db, review, "auditor", 42, material, at))!.payload).toMatchObject({ cell_event_ids: [seen, seed] });
});

it("登録より後の本番の exit は次の窓の初観測になり、今の窓は種だけを載せる —— 上限のない読みは exit を返す", () => {
  const db = openDb(":memory:");
  const { score } = posedInterview(db, { provider: "anthropic", model: opus.model, effort: "high" });
  const task = work(db);
  const spawned = spawn(db, task);
  register(db, true);
  const seed = score("accepted");
  const review = register(db);
  const seen = exit(db, task, spawned);
  const material = routingMaterialOf(db, review);

  expect(material.parts.cells).toEqual([{ cell: { provider: opus.provider, model: opus.model, effort: opus.effort, advisor: null }, first_observed_event_id: null, seeds: [{ tier: "standard", kind: "interview", event_id: seed }] }]);
  expect(getEvent(db, recordMetaReviewMaterial(db, review, "auditor", 42, material, at))!.payload).toMatchObject({ cell_event_ids: [seed] });
  expect(listRoutingCells(db, review, {}).cells).toMatchObject([{ first_observed_event_id: seen, seeds: [{ event_id: seed }] }]);
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(review);
  const next = register(db);
  const nextMaterial = routingMaterialOf(db, next);
  expect(nextMaterial.parts.cells).toMatchObject([{ first_observed_event_id: seen, seeds: [{ event_id: seed }] }]);
  expect(getEvent(db, recordMetaReviewMaterial(db, next, "auditor", 43, nextMaterial, at))!.payload).toMatchObject({ cell_event_ids: [seen, seed] });
});

it("本番の無い種のセルは、別の段の古い種も今の種も記録に残す", () => {
  const db = openDb(":memory:");
  const first = posedInterview(db, opusLow);
  const second = posedInterview(db, opusLow, "frontier");
  const oldSeed = first.score("accepted");
  register(db, true);
  const currentSeed = second.score("accepted");
  const review = register(db);
  const material = routingMaterialOf(db, review);

  expect(material.parts.cells).toMatchObject([{ first_observed_event_id: null, seeds: [{ event_id: oldSeed }, { event_id: currentSeed }] }]);
  expect(getEvent(db, recordMetaReviewMaterial(db, review, "auditor", 42, material, at))!.payload).toMatchObject({ cell_event_ids: [oldSeed, currentSeed] });
});

it("advisor の違う2セルの共通の種は記録の最初の位置に1回だけ載る", () => {
  const db = openDb(":memory:");
  const { score } = posedInterview(db, { provider: "anthropic", model: opus.model, effort: "high" });
  const firstTask = work(db);
  const first = exit(db, firstTask, spawn(db, firstTask));
  const secondTask = work(db);
  const second = exit(db, secondTask, spawn(db, secondTask, "advisor-model"));
  register(db, true);
  const seed = score("accepted");
  const review = register(db);
  const material = routingMaterialOf(db, review);

  expect(material.parts.cells).toMatchObject([
    { cell: { advisor: null }, first_observed_event_id: first, seeds: [{ event_id: seed }] },
    { cell: { advisor: "advisor-model" }, first_observed_event_id: second, seeds: [{ event_id: seed }] },
  ]);
  expect(getEvent(db, recordMetaReviewMaterial(db, review, "auditor", 42, material, at))!.payload).toMatchObject({ cell_event_ids: [first, seed, second] });
});

it("人間の種を持つセルの記録も本番の初観測と種の両方を載せる", () => {
  const db = openDb(":memory:");
  const task = work(db);
  const seen = exit(db, task, spawn(db, task));
  register(db, true);
  applyExecutionSettingsChange(db, { setting: "delete_row", provider: opus.provider, model: opus.model, effort: opus.effort }, "webui", at);
  const seed = applyExecutionSettingsChange(db, { setting: "row", row: { provider: opus.provider, model: opus.model, effort: opus.effort, tier: "standard", price_in: 5, price_out: 25 }, seed: { comment: "measured" } }, "webui", at)!;
  const review = register(db);
  const material = routingMaterialOf(db, review);

  expect(material.parts.cells).toMatchObject([{ first_observed_event_id: seen, seeds: [{ kind: "human", event_id: seed }] }]);
  expect(getEvent(db, recordMetaReviewMaterial(db, review, "auditor", 42, material, at))!.payload).toMatchObject({ cell_event_ids: [seen, seed] });
});
