import { expect, it } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import type { Cause } from "../src/cause.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, listEventsOfKinds, type TaskScopedPayload } from "../src/events.js";
import { buildMetaReviewMaterial, completeMemoryReview, invalidateMemoryEntry, listPrecedents, recordKnowledge } from "../src/memory.js";
import { META_REVIEW_SUBJECTS, type MetaReviewSubject, readMetaReviewStatus, registerDueMetaReviews, registerMetaReview } from "../src/meta-review.js";
import { getTask, logDecision, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { raiseObjection, startTriage } from "../src/triage.js";
import { recordHumanStop } from "../src/watchdog.js";
import { bundledObjection, episodeOfDecision, HUMAN_WEBUI, injectMemoryMaterial, injectRoutingMaterial, routingJudgmentRepairTask, WORKER_SPAWNED } from "./harness.js";

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

/** setup のみ: log entry に束ね済みの異議を1つ置く(帰責はまだ無い)。`decision` は異議を打てる4種のどれでもよい。 */
const objectedEntry = (db: Db, taskId: string, decision: number) => ({ taskId, decision, objection: bundledObjection(db, taskId, decision, at) });

/** setup のみ: work task の判断の行を置き、束ね済みの異議を1つ置く —— Episode は置かない(投影の無い session)。 */
const unprojectedDecision = (db: Db, work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI)) =>
  objectedEntry(db, work.id, logDecision(db, work, "deleted the fixtures", "deckhand", at, "worker"));

/** setup のみ: work task の判断の行を episode に載せ、束ね済みの異議を1つ置く(帰責はまだ無い)。 */
function objectedDecision(db: Db, work?: Task) {
  const objected = unprojectedDecision(db, work);
  episodeOfDecision(db, objected.taskId, objected.decision);
  return objected;
}

/** setup のみ: workspace reef の work task の session を deckhand が開き、その session に異議を打てる種類 `kind` の行を1つ書いて
 *  束ね済みの異議を1つ置く(Episode は置かない)。`line` は帰責の入力の行の文。 */
function objectedRowOf(db: Db, kind: "decision_logged" | "task_completed" | "premise_breached" | "memory_written") {
  const task = pickupTask(db, registerTask(db, { type: "work", title: "parser", purpose: "parse", completion_criteria: "works", workspace: "reef" }, at, ...HUMAN_WEBUI), "deckhand", at)!;
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  const worker = (payload: TaskScopedPayload) => appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "worker", at, payload });
  const objected = (entry: number, line: string) => ({ ...objectedEntry(db, task.id, entry), line });
  if (kind === "decision_logged") return objected(logDecision(db, task, "deleted the fixtures", "deckhand", at, "worker"), "deleted the fixtures");
  if (kind === "task_completed") return objected(worker({ kind: "task_completed", handoff_present: true, result: "parsed the charts" }), "completion report: parsed the charts");
  if (kind === "premise_breached") {
    const based_on_decision = logDecision(db, task, "module M parses", "deckhand", at, "worker");
    return objected(worker({ kind: "premise_breached", line: "module M is broken", based_on_decision }), "module M is broken");
  }
  const wrote = recordKnowledge(db, { scope: "tidepool", path: "charts", title: "Charts", text: "Charts.", source: { commit: "0a46a46" }, author: deckhand }, "worker", at, task.id);
  return objected(wrote.event_id, `wrote knowledge #${wrote.entry_id} "Charts" at charts (tidepool)`);
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

it("登録の時点で開いていた triage session の異議が上限の後に束ねられ帰責されても、窓の行の判定と注入時・完了時の Items は変わらない(ADR 0312 決定6)", () => {
  const db = openDb(":memory:");
  const followed = knowledge(db, "followed");
  register(db, "memory", true);
  const objected = objectedDecision(db);
  attributeObjection(db, objected, "memory", { wrong: [followed] });
  const session = startTriage(db, at);
  const late = raiseObjection(db, objected.decision, "again", at);
  const review = register(db, "memory");
  const rows = () => memoryMaterialOf(db, review).parts.precedents.map((p) => [p.decision_event_id, p.cause, p.wrong_memory_entries]);
  const injected = rows();

  injectMemoryMaterial(db, review, "fugu", at);
  db.prepare("UPDATE triage_sessions SET committed_at = ?, closed_by = 'commit' WHERE id = ?").run(at.toISOString(), session.id); // setup のみ: 束ねだけを起こす
  attributeObjection(db, { ...objected, objection: late }, "capability");

  expect(injected).toEqual([[objected.decision, "memory", [followed]]]);
  expect(rows()).toEqual(injected);
  const branches = memoryMaterialOf(db, review).parts.items.filter((item) => "branch" in item);
  expect(() => completeMemoryReview(db, getTask(db, review)!, { judgments: branches }, "fugu", at, "worker")).toThrow(`unjudged: memory entry #${followed} —`);
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

type MaterialRecord<S extends MetaReviewSubject> = Extract<EventPayload, { kind: "meta_review_material_injected"; subject: S }>;
/** kind ごとの fixture: 呼ぶと窓の前に材料でない下ごしらえを置き、返す関数は窓にその kind の event をちょうど1つ書いて、
 *  節の記録のどの部分にどの id で載るべきかを返す。 */
type MaterialKind<S extends MetaReviewSubject> = keyof (typeof META_REVIEW_SUBJECTS)[S]["material"];
type KindFixtures<S extends MetaReviewSubject, K extends MaterialKind<S> = MaterialKind<S>> = Record<K, (db: Db) => () => [keyof MaterialRecord<S>, number]>;
const KIND_FIXTURES: KindFixtures<"memory"> = {
  memory_entry_created: (db) => () => ["changed_memory_entry_ids", knowledge(db, "written")],
  memory_entry_invalidated: (db) => {
    const dropped = knowledge(db, "dropped");
    return () => (invalidateMemoryEntry(db, { entry_id: dropped, reason: "environment" }, "human", "webui", at), ["changed_memory_entry_ids", dropped]);
  },
  objection_attributed: (db) => {
    const objected = objectedDecision(db);
    return () => (attributeObjection(db, objected, "capability"), ["precedents", objected.decision]);
  },
  stop_attributed: (db) => {
    const stopped = stoppedSession(db);
    return () => ["stop_attributed_event_ids", attributeStop(db, stopped, "capability")];
  },
};

/** setup のみ: 行の主題 routing の task(routing meta-review)を登録し、下ごしらえを置いてから、それと子(停止の failure question)を
 *  done にする —— 周期の登録は未決着の同主題 task を待つ。 */
function onRoutingReview<T>(db: Db, setup: (review: Task) => T): T {
  const review = getTask(db, register(db, "routing"))!;
  const made = setup(review);
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ? OR parent_id = ?").run(review.id, review.id);
  return made;
}

/** routing の帰責2 kind だけ(他の kind の行の不変条件は tests/routing-meta-review-material-kinds.test.ts)。 */
const ROUTING_KIND_FIXTURES: KindFixtures<"routing", "objection_attributed" | "stop_attributed"> = {
  objection_attributed: (db) => {
    const objected = onRoutingReview(db, (review) => objectedDecision(db, review));
    return () => (attributeObjection(db, objected, "capability"), ["precedents", objected.decision]);
  },
  stop_attributed: (db) => {
    const stopped = onRoutingReview(db, (review) => stoppedSession(db, "wrong rows", review));
    return () => ["stop_attributed_event_ids", attributeStop(db, stopped, "capability")];
  },
};

/** 異議つき判断の行は Episode でなく帰責 event から選ぶ(ADR 0312 追記・ADR 0252 追記): Episode の無い判断と、判断以外の3種の行への帰責。 */
const attributedInWindow = (db: Db, objected: ReturnType<typeof objectedEntry>) => (): ["precedents", number] => (attributeObjection(db, objected, "capability"), ["precedents", objected.decision]);
const OBJECTED_ROW_FIXTURES = [
  ["memory", "objection_attributed(Episode の無い判断)", (db: Db) => attributedInWindow(db, unprojectedDecision(db))],
  ["routing", "objection_attributed(Episode の無い判断)", (db: Db) => attributedInWindow(db, onRoutingReview(db, (review) => unprojectedDecision(db, review)))],
  ...(["task_completed", "premise_breached", "memory_written"] as const).map(
    (kind) => ["memory", `objection_attributed(${kind} の行)`, (db: Db) => attributedInWindow(db, objectedRowOf(db, kind))] as const,
  ),
] as const;

it.each([
  ...Object.entries(KIND_FIXTURES).map(([kind, fixture]) => ["memory", kind, fixture] as const),
  ...Object.entries(ROUTING_KIND_FIXTURES).map(([kind, fixture]) => ["routing", kind, fixture] as const),
  ...OBJECTED_ROW_FIXTURES,
])("主題 %s の材料の kind %s の event が窓に1つだけあれば、due が開き(件数 1)、注入した節のその部分の記録に載る(ADR 0312 決定1)", (subject, _, fixture) => {
  const db = openDb(":memory:");
  const inWindow = fixture(db);
  register(db, subject, true);
  const [part, id] = inWindow();

  expect(readMetaReviewStatus(db)[subject]).toMatchObject({ material_since: 1 });
  registerDueMetaReviews(db, new Date(at.getTime() + 8 * 24 * 60 * 60 * 1000));
  const review = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  expect(getTask(db, review)).toMatchObject({ meta_review_subject: subject, status: "todo" });
  if (subject === "memory") injectMemoryMaterial(db, review, "fugu", at);
  else injectRoutingMaterial(db, review, "auditor", at);
  expect(listEventsOfKinds(db, ["meta_review_material_injected"]).at(-1)!.payload).toMatchObject({ [part]: expect.arrayContaining([id]) });
});

it("routing meta-review とその修理子の行への異議の帰責・routing meta-review の session の停止の帰責は、cause が memory でなければ memory の due を開かず memory の節にも載らない(ADR 0312 決定3)", () => {
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

it("routing meta-review の行への異議と、その session の停止の帰責が cause memory なら、memory と routing の両方の due を開き両方の節に載り、memory の Items to judge と list_precedents(読み手 memory)に入る —— routing の Items to judge は変わらない(ADR 0312 決定4)", () => {
  const db = openDb(":memory:");
  const [followed, seen] = [knowledge(db, "followed"), knowledge(db, "seen")];
  register(db, "memory", true);
  const routing = getTask(db, register(db, "routing"))!;
  const objected = objectedDecision(db, routing);
  attributeObjection(db, objected, "memory", { wrong: [followed] });
  const stopped = stoppedSession(db, "wrong rows", routing);
  attributeStop(db, stopped, "memory", { wrong: [seen] });

  expect(readMetaReviewStatus(db)).toMatchObject({ memory: { material_since: 2 }, routing: { material_since: 2 } });
  const memoryReview = register(db, "memory");
  const { parts } = memoryMaterialOf(db, memoryReview);
  expect([parts.precedents.map((p) => p.decision_event_id), parts.stops.map((s) => s.row.stop_event_id)]).toEqual([[objected.decision], [stopped.stop]]);
  expect(listPrecedents(db, { taskId: memoryReview, agent: "fugu" }, {}, at).precedents.map((p) => p.decision_event_id)).toEqual([objected.decision]);
  const items = injectMemoryMaterial(db, memoryReview, "fugu", at);
  expect(items.filter((item) => "memory_entry" in item)).toEqual([{ memory_entry: followed }, { memory_entry: seen }]);
  const branches = items.filter((item) => "branch" in item);
  expect(() => completeMemoryReview(db, getTask(db, memoryReview)!, { judgments: branches }, "fugu", at, "worker")).toThrow(`unjudged: memory entry #${followed}, memory entry #${seen} —`);

  const routingMaterial = buildMetaReviewMaterial(db, register(db, "routing"));
  if (routingMaterial?.subject !== "routing") throw new Error("no routing material");
  expect([routingMaterial.parts.precedents.map((p) => p.decision_event_id), routingMaterial.parts.stops.map((s) => s.row.stop_event_id)]).toEqual([[objected.decision], [stopped.stop]]);
  expect(routingMaterial.parts.items).toEqual([{ learner: true }]);
});

it.each(["decision_logged", "task_completed", "premise_breached", "memory_written"] as const)(
  "%s の行への cause memory の帰責は、Episode が無くても節の Objected decisions と list_precedents に帰責の入力と同じ文の1行で載り、名指すエントリが Items to judge に入る —— 読んだ / 見た記憶は null、spawn と完了は session の event から(ADR 0312 追記)",
  (kind) => {
    const db = openDb(":memory:");
    const followed = knowledge(db, "followed");
    const objected = objectedRowOf(db, kind);
    register(db, "memory", true);
    attributeObjection(db, objected, "memory", { wrong: [followed] });
    expect(readMetaReviewStatus(db).memory).toMatchObject({ material_since: 1 });
    const review = register(db, "memory");

    const { parts, section } = memoryMaterialOf(db, review);

    const row = {
      task_id: objected.taskId,
      workspace: "reef",
      agent: "deckhand",
      worker_spawned_event_id: listEventsOfKinds(db, ["worker_spawned"]).at(-1)!.id,
      decision_event_id: objected.decision,
      line: objected.line,
      displayed: false,
      objections: ["redo it"],
      cause: "memory",
      wrong_memory_entries: [followed],
      completed: kind === "task_completed" ? { result: "parsed the charts", handoffPresent: true } : null,
      pr_merged: null,
      memory_entries_read: null,
      memory_entries_seen: null,
    };
    expect(listPrecedents(db, { taskId: review, agent: "fugu" }, {}, at).precedents).toEqual([row]);
    expect(partOf(section, "Objected decisions")).toContain(JSON.stringify(row));
    expect(parts.items.filter((item) => "memory_entry" in item)).toEqual([{ memory_entry: followed }]);
  },
);

it.each(["memory", "routing"] as const)(
  "spawn も Episode も無い判断(主題 %s の行)への cause memory の帰責は、material_since 1 で、その主題の節の Objected decisions と list_precedents に1行で載り(spawn・agent・読んだ / 見た記憶は null)、名指すエントリが memory の Items to judge に入る(ADR 0312 追記)",
  (subject) => {
    const db = openDb(":memory:");
    const followed = knowledge(db, "followed");
    const objected = subject === "memory" ? unprojectedDecision(db) : onRoutingReview(db, (review) => unprojectedDecision(db, review));
    register(db, "memory", true);
    attributeObjection(db, objected, "memory", { wrong: [followed] });
    expect(readMetaReviewStatus(db)[subject]).toMatchObject({ material_since: 1 });
    const review = register(db, subject);

    const { section } = buildMetaReviewMaterial(db, review)!;

    const row = {
      task_id: objected.taskId,
      workspace: null,
      agent: null,
      worker_spawned_event_id: null,
      decision_event_id: objected.decision,
      line: "deleted the fixtures",
      displayed: false,
      objections: ["redo it"],
      cause: "memory",
      wrong_memory_entries: [followed],
      completed: null,
      pr_merged: null,
      memory_entries_read: null,
      memory_entries_seen: null,
    };
    expect(listPrecedents(db, { taskId: review, agent: "fugu" }, {}, at).precedents).toEqual([row]);
    expect(partOf(section, "Objected decisions")).toContain(JSON.stringify(row));
    const memoryReview = subject === "memory" ? review : register(db, "memory");
    expect(memoryMaterialOf(db, memoryReview).parts.items.filter((item) => "memory_entry" in item)).toEqual([{ memory_entry: followed }]);
  },
);

it("同じ停止の初回 uncertain と第2回の判定が同じ窓にあれば、件数は 2(due を開く event の数)で Stops attributed は1行 —— 件数と行数の一致は不変条件に入れない(ADR 0312 追記 #2609)", () => {
  const db = openDb(":memory:");
  register(db, "memory", true);
  const stopped = stoppedSession(db);
  attributeStop(db, stopped, "uncertain");
  attributeStop(db, stopped, "capability", { round: "after_rca" });

  expect(readMetaReviewStatus(db).memory).toMatchObject({ material_since: 2 });
  expect(memoryMaterialOf(db, register(db, "memory")).parts.stops.map(({ row }) => [row.stop_event_id, row.cause])).toEqual([[stopped.stop, "capability"]]);
});
