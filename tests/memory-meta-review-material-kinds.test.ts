import { expect, it } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import type { Cause } from "../src/cause.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, listEventsOfKinds } from "../src/events.js";
import { buildMetaReviewMaterial, completeMemoryReview, invalidateMemoryEntry, listPrecedents, recordKnowledge } from "../src/memory.js";
import { META_REVIEW_SUBJECTS, type MetaReviewSubject, readMetaReviewStatus, registerDueMetaReviews, registerMetaReview } from "../src/meta-review.js";
import { getTask, logDecision, pickupTask, registerTask } from "../src/tasks.js";
import { recordHumanStop } from "../src/watchdog.js";
import { bundledObjection, episodeOfDecision, HUMAN_WEBUI, injectMemoryMaterial, routingJudgmentRepairTask, WORKER_SPAWNED } from "./harness.js";

/** memory meta-review の材料を kind ごとの1組で読む(ADR 0312)のドメイン層: due と節が同じ述語を読む。 */
const at = new Date("2026-10-26T00:00:00.000Z");

/** 主題の meta-review を登録し、その task の id を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, subject: MetaReviewSubject, done = false): string {
  registerMetaReview(db, subject, at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return taskId;
}

function memoryMaterialOf(db: Db, taskId: string) {
  const material = buildMetaReviewMaterial(db, taskId);
  if (material?.subject !== "memory") throw new Error(`no memory material for ${taskId}`);
  return material;
}

/** 節の部分 `heading` の本文(次の見出しまで)。 */
const partOf = (section: string, heading: string) => section.split(`### ${heading}\n`)[1]?.split("\n### ")[0] ?? "";

const deckhand = { activity: "worker_verb" as const, name: "deckhand" };
const knowledge = (db: Db, path: string) =>
  recordKnowledge(db, { scope: "tidepool", path, title: path, text: `${path}.`, source: { commit: "0a46a46" }, author: deckhand }, "worker", at).entry_id;

/** setup のみ: workspace reef の work task の session を deckhand が開き、人間が理由つきで止める。 */
function stoppedSession(db: Db, reason = "deleting unrelated files", registered = registerTask(db, { type: "work", title: "parser", purpose: "parse", completion_criteria: "works", workspace: "reef" }, at, ...HUMAN_WEBUI)) {
  const task = pickupTask(db, registered, "deckhand", at)!;
  const spawned = appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  recordHumanStop(db, task.id, reason, at, "webui");
  const stop = listEventsOfKinds(db, ["session_stopped_by_human"]).at(-1)!.id;
  return { taskId: task.id, spawned, stop };
}

/** setup のみ: 門を通った停止の帰責を直に置く(Board call は撃たない)。 */
const attributeStop = (
  db: Db,
  { taskId, stop }: { taskId: string; stop: number },
  cause: Cause,
  { wrong = null, round = "initial", evidence = "e" }: { wrong?: number[] | null; round?: "initial" | "after_rca"; evidence?: string } = {},
) =>
  appendEvent(db, {
    taskId,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    at,
    payload: { kind: "stop_attributed", stop_event_id: stop, cause, evidence, wrong_memory_entries: cause === "memory" ? wrong : null, round } satisfies EventPayload,
  });

it("停止の帰責だけの窓: 節の Stops attributed に止められた session の1行が event から組まれて載り、Objected decisions は空 —— cause capability は項目を足さない", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stopped = stoppedSession(db);
  attributeStop(db, stopped, "capability", { evidence: "the worker deleted files outside the task" });
  const review = register(db, "memory");

  const { parts, section } = memoryMaterialOf(db, review);

  const row = {
    task_id: stopped.taskId,
    workspace: "reef",
    agent: "deckhand",
    worker_spawned_event_id: stopped.spawned,
    stop_event_id: stopped.stop,
    reason: "deleting unrelated files",
    cause: "capability",
    evidence: "the worker deleted files outside the task",
    wrong_memory_entries: null,
    round: "initial",
  };
  expect(parts.stops.map((s) => s.row)).toEqual([row]);
  expect(partOf(section, "Stops attributed")).toContain(JSON.stringify(row));
  expect(partOf(section, "Objected decisions")).toContain("(no objected decisions)");
  expect(parts.items).toEqual([]);
});

it("cause memory の停止の帰責が名指すエントリは、鎖の末尾が生きていれば Items to judge に { memory_entry } で入り、complete_memory_review が left_as_is を求める —— 無効化済みは載らない", () => {
  const db = openDb(":memory:");
  const followed = knowledge(db, "followed");
  const dropped = knowledge(db, "dropped");
  invalidateMemoryEntry(db, { entry_id: dropped, reason: "environment" }, "human", "webui", at);
  register(db, "memory", true);
  attributeStop(db, stoppedSession(db), "memory", { wrong: [followed, dropped] });
  const review = register(db, "memory");

  const items = injectMemoryMaterial(db, review, "fugu", at);

  expect(items.filter((item) => "memory_entry" in item)).toEqual([{ memory_entry: followed }]);
  const branches = items.filter((item) => "branch" in item);
  expect(() => completeMemoryReview(db, getTask(db, review)!, { judgments: branches }, "fugu", at, "worker")).toThrow(`unjudged: memory entry #${followed} —`);
  expect(completeMemoryReview(db, getTask(db, review)!, { judgments: items }, "fugu", at, "worker").status).toBe("done");
});

/** setup のみ: work task の判断の行を episode に載せ、束ね済みの異議を1つ置く(帰責はまだ無い)。 */
function objectedDecision(db: Db, work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI)) {
  const decision = logDecision(db, work, "deleted the fixtures", "deckhand", at, "worker");
  episodeOfDecision(db, work.id, decision);
  return { taskId: work.id, decision, objection: bundledObjection(db, work.id, decision, at) };
}

/** setup のみ: 門を通った異議の帰責を直に置く。 */
const attributeObjection = (
  db: Db,
  { taskId, decision, objection }: ReturnType<typeof objectedDecision>,
  cause: Cause,
  { wrong = null, round = "initial" }: { wrong?: number[] | null; round?: "initial" | "after_rca" } = {},
) =>
  appendEvent(db, {
    taskId,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    at,
    payload: { kind: "objection_attributed", entry_id: decision, objection_event_ids: [objection], cause, evidence: "e", wrong_memory_entries: cause === "memory" ? wrong : null, round } satisfies EventPayload,
  });

it("帰責の無い異議だけの判断の行は、節にも list_precedents にも載らず due も開かない —— 帰責が付いた周期で載る(ADR 0312 決定5)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const objected = objectedDecision(db);
  expect(readMetaReviewStatus(db).memory).toMatchObject({ material_since: 0 });
  const review = register(db, "memory");

  expect(memoryMaterialOf(db, review).parts.precedents).toEqual([]);
  expect(listPrecedents(db, { taskId: review, agent: "fugu" }, {}, at).precedents).toEqual([]);

  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(review);
  attributeObjection(db, objected, "capability");
  expect(readMetaReviewStatus(db).memory).toMatchObject({ material_since: 1 });
  const next = register(db, "memory");

  expect(memoryMaterialOf(db, next).parts.precedents.map((p) => [p.decision_event_id, p.cause])).toEqual([[objected.decision, "capability"]]);
  expect(listPrecedents(db, { taskId: next, agent: "fugu" }, {}, at).precedents.map((p) => p.decision_event_id)).toEqual([objected.decision]);
});

it("異議つき判断の行の判定は窓の上限までの最新: 登録の後の第2回は今の行の cause にも、注入時と完了時の Items にも効かず、次の周期の材料に数える(ADR 0312 決定6)", () => {
  const db = openDb(":memory:");
  const followed = knowledge(db, "followed");
  register(db, "memory", true);
  const objected = objectedDecision(db);
  attributeObjection(db, objected, "memory", { wrong: [followed] });
  const review = register(db, "memory");
  attributeObjection(db, objected, "capability", { round: "after_rca" });

  const items = injectMemoryMaterial(db, review, "fugu", at);

  expect(memoryMaterialOf(db, review).parts.precedents.map((p) => [p.cause, p.wrong_memory_entries])).toEqual([["memory", [followed]]]);
  expect(items.filter((item) => "memory_entry" in item)).toEqual([{ memory_entry: followed }]);
  const branches = items.filter((item) => "branch" in item);
  expect(() => completeMemoryReview(db, getTask(db, review)!, { judgments: branches }, "fugu", at, "worker")).toThrow(`unjudged: memory entry #${followed} —`);
  expect(readMetaReviewStatus(db).memory).toMatchObject({ material_since: 1 });
});

it("同じ停止は窓に1行、窓の上限までの最新の判定で載る: 初回が前の窓・第2回が今の窓でも、両方が今の窓でも1行 —— 前回の登録以前と自身の登録より後の判定だけの停止は載らず、上限の後の第2回は今の行に効かない", () => {
  const db = openDb(":memory:");
  const followed = knowledge(db, "followed");
  const before = stoppedSession(db);
  attributeStop(db, before, "uncertain");
  const carried = stoppedSession(db);
  attributeStop(db, carried, "uncertain");
  register(db, "memory", true);
  attributeStop(db, carried, "memory", { wrong: [followed], round: "after_rca" });
  const both = stoppedSession(db);
  attributeStop(db, both, "uncertain");
  attributeStop(db, both, "capability", { round: "after_rca" });
  const capped = stoppedSession(db);
  attributeStop(db, capped, "uncertain");
  const review = register(db, "memory");
  attributeStop(db, capped, "memory", { wrong: [followed], round: "after_rca" });
  attributeStop(db, stoppedSession(db), "capability");

  const { parts } = memoryMaterialOf(db, review);

  expect(parts.stops.map(({ row }) => [row.stop_event_id, row.cause, row.round])).toEqual([
    [carried.stop, "memory", "after_rca"],
    [both.stop, "capability", "after_rca"],
    [capped.stop, "uncertain", "initial"],
  ]);
});

it("節を組んだ記録 meta_review_material_injected(主題 memory)の stop_attributed_event_ids は、行の判定の event の id を持つ", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stopped = stoppedSession(db);
  attributeStop(db, stopped, "uncertain");
  const latest = attributeStop(db, stopped, "capability", { round: "after_rca" });
  const review = register(db, "memory");

  injectMemoryMaterial(db, review, "fugu", at);

  expect(listEventsOfKinds(db, ["meta_review_material_injected"]).at(-1)!.payload).toMatchObject({ subject: "memory", stop_attributed_event_ids: [latest] });
});

type MemoryRecord = Extract<EventPayload, { kind: "meta_review_material_injected"; subject: "memory" }>;
/** kind ごとの fixture: before() は窓の前に材料でない下ごしらえを置き、inWindow() は窓にその kind の event をちょうど1つ書いて、
 *  節の記録のどの部分にどの id で載るべきかを返す。 */
const KIND_FIXTURES: Record<keyof (typeof META_REVIEW_SUBJECTS)["memory"]["material"], (db: Db) => { inWindow: () => [keyof MemoryRecord, number] }> = {
  memory_entry_created: (db) => ({ inWindow: () => ["changed_memory_entry_ids", knowledge(db, "written")] }),
  memory_entry_invalidated: (db) => {
    const dropped = knowledge(db, "dropped");
    return { inWindow: () => (invalidateMemoryEntry(db, { entry_id: dropped, reason: "environment" }, "human", "webui", at), ["changed_memory_entry_ids", dropped]) };
  },
  objection_attributed: (db) => {
    const objected = objectedDecision(db);
    return { inWindow: () => (attributeObjection(db, objected, "capability"), ["precedents", objected.decision]) };
  },
  stop_attributed: (db) => {
    const stopped = stoppedSession(db);
    return { inWindow: () => ["stop_attributed_event_ids", attributeStop(db, stopped, "capability")] };
  },
};

it.each(Object.entries(KIND_FIXTURES))("材料の kind %s の event が窓に1つだけあれば、due が開き(件数 1)、注入した節のその部分の記録に載る(ADR 0312 決定1)", (_, fixture) => {
  const db = openDb(":memory:");
  const { inWindow } = fixture(db);
  register(db, "memory", true);
  const [part, id] = inWindow();

  expect(readMetaReviewStatus(db).memory).toMatchObject({ material_since: 1 });
  registerDueMetaReviews(db, new Date(at.getTime() + 8 * 24 * 60 * 60 * 1000));
  const review = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  expect(getTask(db, review)).toMatchObject({ meta_review_subject: "memory", status: "todo" });
  injectMemoryMaterial(db, review, "fugu", at);
  expect(listEventsOfKinds(db, ["meta_review_material_injected"]).at(-1)!.payload).toMatchObject({ [part]: expect.arrayContaining([id]) });
});

it("routing meta-review とその修理子の行への異議の帰責・routing meta-review の session の停止の帰責は、memory の due を開かず memory の節にも載らない(ADR 0312 決定3)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const routing = getTask(db, register(db, "routing"))!;
  attributeObjection(db, objectedDecision(db, routing), "capability");
  attributeStop(db, stoppedSession(db, "wrong rows", routing), "capability");
  attributeObjection(db, objectedDecision(db, routingJudgmentRepairTask(db, at)), "capability");

  expect(readMetaReviewStatus(db).memory).toMatchObject({ material_since: 0 });
  const { parts } = memoryMaterialOf(db, register(db, "memory"));
  expect([parts.precedents, parts.stops]).toEqual([[], []]);
});
