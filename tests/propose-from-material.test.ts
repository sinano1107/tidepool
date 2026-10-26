import { expect, it } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import type { Cause } from "../src/cause.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents, objectionBundles } from "../src/events.js";
import { listMemoryEntries } from "../src/memory.js";
import { proposeFromMaterial } from "../src/retrospective.js";
import { listChildren, logDecision, registerTask, type Task, type TaskType } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { bundledObjection, decomposedChild, markPickedUp } from "./harness.js";

/** RCA の起草 verb `propose_from_material` の門(issue #1077)と成功経路(issue #1092)のドメイン層。
 *  tool error への写像はサーバ境界(tests/mcp-propose-from-material.test.ts)が言う。 */
const at = new Date("2026-09-15T00:00:00.000Z");
/** 起草の中身(門と導出はこれを見ない)。 */
const draft = { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures." };

const task = (db: Db, type: TaskType, title: string, registrant = HUMAN_ACTOR_ID, parent_id?: string): Task =>
  registerTask(db, { type, title, purpose: "p", completion_criteria: "c", workspace: "charts", parent_id }, at, registrant, "webui");
/** entry に束ね済みの異議群を1つ足し、その異議群に cause を帰責する(呼ぶたびに後の異議群)。 */
const attribute = (db: Db, taskId: string, entry_id: number, cause: Cause, entries: number[] | null = null): number => {
  const objection = bundledObjection(db, taskId, entry_id, at);
  return appendEvent(db, { taskId, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "objection_attributed", entry_id, objection_event_ids: [objection], cause, evidence: "e", wrong_memory_entries: entries, round: "initial" }, at });
};
/** 異議されたエントリに cause を帰責する。親は deckhand が一度 pickup した形にする —— RCA 子(人間名義の登録)が付ける(ADR 0292 決定2)。
 *  pickup は人間に起きないので、エントリの書き手が人間でも pickup の名義は deckhand。 */
const objected = (db: Db, parent: Task, cause: Cause, worker = "deckhand"): number => {
  markPickedUp(db, parent.id, at);
  const entry = logDecision(db, parent, `decided as ${cause}`, worker, at, "worker");
  attribute(db, parent.id, entry, cause);
  return entry;
};
/** 親の entry ごとの最後の異議群の異議 id —— commit が立てる RCA 子と同じく、1本の RCA 子が覆う異議群は entry ごとに1つ(ADR 0171 決定1)。 */
const material = (db: Db, parentId: string): number[] =>
  [...objectionBundles(db).values()].flatMap((bundles) => (bundles.at(-1)!.task_id === parentId ? bundles.at(-1)!.objection_event_ids : []));
/** 親のいまの異議群を材料にした RCA 子。 */
const rca = (db: Db, title: string, parent: Task): Task =>
  registerTask(db, { type: "review", title, purpose: "p", completion_criteria: "c", parent_id: parent.id, opened_on_event_ids: material(db, parent.id) }, at, HUMAN_ACTOR_ID, "webui");

it("学習に向かない cause・異議済みで未帰責のエントリ・宛先の agent が無い Behavior・as と based_on_decision の過不足・decision でない / 別の task の decision の based_on_decision・帰責の無い / 他 task の / 存在しない / 人間が書いたエントリ・work task や parent の無い review からの呼び出しは DomainError で拒否され、店には何も載らない", () => {
  const db = openDb(":memory:");
  const mixed = task(db, "work", "mixed");
  const capability = objected(db, mixed, "capability");
  const uncertain = objected(db, mixed, "uncertain");
  const requirementChange = objected(db, mixed, "requirement_change");
  const environment = objected(db, mixed, "environment");
  const taskAmbiguity = objected(db, mixed, "task_ambiguity");
  const missingInformation = objected(db, mixed, "missing_information");
  // memory の帰責は読んだ記憶を名指す(門は cause だけで断るので、entries の中身は見ない)
  const memory = logDecision(db, mixed, "decided as memory", "deckhand", at, "worker");
  attribute(db, mixed.id, memory, "memory", [1]);
  const unobjected = appendEvent(db, { taskId: mixed.id, actorId: "deckhand", origin: "worker", payload: { kind: "task_completed", handoff_present: true, result: null }, at });
  // 異議されたが初回の帰責が無い(撃てなかった / 失敗した)エントリは uncertain と同じに読む(ADR 0168 決定3)
  const objectedUnattributed = logDecision(db, mixed, "decided before the Board call failed", "deckhand", at, "worker");
  bundledObjection(db, mixed.id, objectedUnattributed, at, "keep the fixtures");
  const byHuman = objected(db, mixed, "capability", HUMAN_ACTOR_ID);
  const notDecision = attribute(db, mixed.id, capability, "capability");
  const otherEntry = objected(db, task(db, "work", "other"), "capability");
  const delegated = task(db, "work", "delegated", "tako");
  const delegatedEntry = objected(db, delegated, "missing_information");
  const byBoard = task(db, "work", "by the board", BOARD_ACTOR_ID);
  const byBoardEntry = objected(db, byBoard, "task_ambiguity");

  const self = rca(db, "rca (self): mixed", mixed).id;
  const decision = logDecision(db, task(db, "review", "rca (auditor): mixed", HUMAN_ACTOR_ID, mixed.id), "the fixture rule was never written down", "auditor", at, "worker");
  const notAgent = "the task's text was not written by an agent: there is no agent to address a behavior to";
  const asRule = 'as ("behavior" or "knowledge") is required for a missing_information entry and only for it';
  const decisionRule = "based_on_decision is required for a knowledge entry and only for it";

  for (const [reviewId, args, error] of [
    [self, { material_id: uncertain }, "the entry's cause is uncertain: nothing to learn from it"],
    [self, { material_id: objectedUnattributed }, "the entry's cause is uncertain: nothing to learn from it"],
    [self, { material_id: requirementChange }, "the entry's cause is requirement_change: nothing to learn from it"],
    [self, { material_id: environment }, "the entry's cause is environment: nothing to learn from it"],
    [self, { material_id: memory }, "the entry's cause is memory: nothing to learn from it"],
    [self, { material_id: taskAmbiguity }, notAgent],
    [self, { material_id: missingInformation, as: "behavior" }, notAgent],
    [self, { material_id: missingInformation }, asRule],
    [self, { material_id: capability, as: "behavior" }, asRule],
    [self, { material_id: missingInformation, as: "knowledge" }, decisionRule],
    [self, { material_id: missingInformation, as: "knowledge", based_on_decision: notDecision }, `event ${notDecision} is not a logged decision`],
    [self, { material_id: missingInformation, as: "knowledge", based_on_decision: capability }, `event ${capability} is not a decision of this task`],
    [self, { material_id: capability, based_on_decision: decision }, decisionRule],
    [self, { material_id: unobjected }, `entry ${unobjected} carries no objection`],
    [self, { material_id: otherEntry }, `entry ${otherEntry} is not a decision-log entry of your parent task`],
    [self, { material_id: 999_999 }, "entry 999999 is not a decision-log entry of your parent task"],
    [task(db, "work", "repair: mixed", HUMAN_ACTOR_ID, mixed.id).id, { material_id: capability }, "propose_from_material is only for a review of an objected or stopped task"],
    [task(db, "review", "loose review").id, { material_id: capability }, "propose_from_material is only for a review of an objected or stopped task"],
    [self, { material_id: byHuman }, `entry ${byHuman} was written by a human`],
    [rca(db, "rca (auditor): delegated", delegated).id, { material_id: delegatedEntry, as: "behavior", based_on_decision: decision }, decisionRule],
    // 盤面(tidepool)の登録は agent の登録ではない
    [rca(db, "rca (auditor): by the board", byBoard).id, { material_id: byBoardEntry }, notAgent],
  ] as const) {
    const propose = () => proposeFromMaterial(db, reviewId, { ...draft, ...args }, {}, "auditor", at);
    expect(propose).toThrow(DomainError);
    expect(propose).toThrow(new DomainError(error));
  }
  expect(listMemoryEntries(db, {})).toEqual([]);
});

it("capability・preference は agent 登録の task でも entry の worker 宛ての Behavior candidate になり、起草の中身を載せ、出所は最新の帰責 event、scope は RCA でなく親の workspace", () => {
  const db = openDb(":memory:");
  const mixed = task(db, "work", "mixed", "tako");
  const capabilityEntry = objected(db, mixed, "capability");
  const latest = attribute(db, mixed.id, capabilityEntry, "capability"); // 後の異議群の帰責 —— 出所は最後の異議群の帰責を指す
  const preferenceEntry = objected(db, mixed, "preference", "helmsman");
  const self = registerTask(db, { type: "review", title: "rca (self): mixed", purpose: "p", completion_criteria: "c", parent_id: mixed.id, opened_on_event_ids: material(db, mixed.id) }, at, HUMAN_ACTOR_ID, "webui").id;

  const capabilityResult = proposeFromMaterial(db, self, { ...draft, material_id: capabilityEntry }, {}, "auditor", at);
  const preferenceResult = proposeFromMaterial(db, self, { ...draft, material_id: preferenceEntry }, {}, "auditor", at);

  expect(capabilityResult.event_id).toBe(capabilityResult.memory_entry_id);
  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ ...draft, id: capabilityResult.memory_entry_id, kind: "behavior", state: "candidate", scope: "charts", addressee: "deckhand", source: { kind: "event", ref: latest }, cause: "capability" }),
    expect.objectContaining({ id: preferenceResult.memory_entry_id, kind: "behavior", state: "candidate", addressee: "helmsman", cause: "preference" }),
  ]);
});

it("主題つきの親(meta-review)の行からの Behavior candidate は、盤面に既定 workspace があっても scope null(盤面全体)で作る(ADR 0279 決定1)", () => {
  const db = openDb(":memory:");
  const review = registerTask(db, { type: "review", title: "memory meta-review", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at, HUMAN_ACTOR_ID, "webui");
  const entry = objected(db, review, "capability");
  const auditor = rca(db, "rca (auditor): memory meta-review", review);

  const { memory_entry_id } = proposeFromMaterial(db, auditor.id, { ...draft, material_id: entry }, { workspace: { name: "charts" } }, "auditor", at);

  expect(listMemoryEntries(db, {})).toEqual([expect.objectContaining({ id: memory_entry_id, kind: "behavior", state: "candidate", scope: null, addressee: "deckhand" })]);
});

it("meta-review の系譜の行(主題の修理子の行・RCA の行・RCA の子の RCA の行)からの Behavior candidate は、盤面に既定 workspace があっても scope null —— 祖先に meta-review の無い修理子の行からは今どおり task の workspace(ADR 0283 決定1)", () => {
  const db = openDb(":memory:");
  const board = { workspace: { name: "charts" } };
  const child = (type: TaskType, title: string, parent: Task, workspace?: string) =>
    registerTask(db, { type, title, purpose: "p", completion_criteria: "c", parent_id: parent.id, workspace }, at, HUMAN_ACTOR_ID, "webui");
  const proposeOn = (objectedTask: Task) => {
    const entry = objected(db, objectedTask, "capability");
    return proposeFromMaterial(db, rca(db, `rca (auditor): ${objectedTask.title}`, objectedTask).id, { ...draft, material_id: entry }, board, "auditor", at).memory_entry_id;
  };
  const memoryReview = registerTask(db, { type: "review", title: "memory meta-review", purpose: "p", completion_criteria: "c", meta_review_subject: "memory" }, at, HUMAN_ACTOR_ID, "webui");
  const routingReview = registerTask(db, { type: "review", title: "routing meta-review", purpose: "p", completion_criteria: "c", meta_review_subject: "routing" }, at, HUMAN_ACTOR_ID, "webui");
  objected(db, memoryReview, "capability");
  const reviewRca = rca(db, "rca (auditor): memory meta-review", memoryReview);
  const work = task(db, "work", "index the tide charts");

  const ids = [
    proposeOn(child("memory_repair", "memory repair: memory meta-review", memoryReview)),
    proposeOn(child("routing_repair", "routing repair: routing meta-review", routingReview)),
    proposeOn(reviewRca),
    proposeOn(child("memory_repair", "memory repair: index the tide charts", work, "reef")),
  ];

  expect(listMemoryEntries(db, {}).map((m) => [m.id, m.scope])).toEqual([
    [ids[0], null],
    [ids[1], null],
    [ids[2], null],
    [ids[3], "reef"],
  ]);
});

it("agent 登録の task では task_ambiguity と missing_information(as: behavior)は登録者宛て、missing_information(as: knowledge)は宛先なしで即 approved・出所は RCA 自身の decision・cause は null", () => {
  const db = openDb(":memory:");
  const delegated = task(db, "work", "delegated", "tako");
  const taskAmbiguityEntry = objected(db, delegated, "task_ambiguity");
  const missingInformationEntry = objected(db, delegated, "missing_information");
  const auditor = rca(db, "rca (auditor): delegated", delegated);
  const decision = logDecision(db, auditor, "the fixture rule was never written down", "auditor", at, "worker");

  const ambiguityResult = proposeFromMaterial(db, auditor.id, { ...draft, material_id: taskAmbiguityEntry }, {}, "auditor", at);
  const behaviorResult = proposeFromMaterial(db, auditor.id, { ...draft, material_id: missingInformationEntry, as: "behavior" }, {}, "auditor", at);
  const knowledgeResult = proposeFromMaterial(db, auditor.id, { ...draft, material_id: missingInformationEntry, as: "knowledge", based_on_decision: decision }, {}, "auditor", at);

  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: ambiguityResult.memory_entry_id, kind: "behavior", state: "candidate", addressee: "tako", cause: "task_ambiguity" }),
    expect.objectContaining({ id: behaviorResult.memory_entry_id, kind: "behavior", state: "candidate", addressee: "tako", cause: "missing_information" }),
    expect.objectContaining({ id: knowledgeResult.memory_entry_id, kind: "knowledge", state: "approved", addressee: null, source: { kind: "decision", ref: decision }, cause: null }),
  ]);
});

it("承認で実体化した子(Registrant は human)の task_ambiguity と missing_information(as: behavior)は、文面の書き手 = 分解した agent 宛ての Behavior candidate になる(ADR 0197)", () => {
  const db = openDb(":memory:");
  const child = decomposedChild(db, task(db, "work", "parent"), "child", "tako", at);
  const taskAmbiguityEntry = objected(db, child, "task_ambiguity");
  const missingInformationEntry = objected(db, child, "missing_information");
  const auditor = rca(db, "rca (auditor): child", child).id;

  const ambiguityResult = proposeFromMaterial(db, auditor, { ...draft, material_id: taskAmbiguityEntry }, {}, "auditor", at);
  const behaviorResult = proposeFromMaterial(db, auditor, { ...draft, material_id: missingInformationEntry, as: "behavior" }, {}, "auditor", at);

  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: ambiguityResult.memory_entry_id, kind: "behavior", state: "candidate", addressee: "tako", cause: "task_ambiguity" }),
    expect.objectContaining({ id: behaviorResult.memory_entry_id, kind: "behavior", state: "candidate", addressee: "tako", cause: "missing_information" }),
  ]);
});

it("人間の分解の子の task_ambiguity は、文面の書き手が人間なので宛先の agent が無く拒否される", () => {
  const db = openDb(":memory:");
  const child = decomposedChild(db, task(db, "work", "parent"), "child", HUMAN_ACTOR_ID, at);
  const entry = objected(db, child, "task_ambiguity");
  const auditor = rca(db, "rca (auditor): child", child).id;

  expect(() => proposeFromMaterial(db, auditor, { ...draft, material_id: entry }, {}, "auditor", at)).toThrow(
    new DomainError("the task's text was not written by an agent: there is no agent to address a behavior to"),
  );
  expect(listMemoryEntries(db, {})).toEqual([]);
});

it("RCA reviewer は自分の RCA が覆う異議群の判定から起草する —— 後の session が同じ entry を異議して未帰責でも前の判定から起草し、後の異議群にしか無い entry は材料にないとして拒む(ADR 0171 決定3)", () => {
  const db = openDb(":memory:");
  const parent = task(db, "work", "reobjected");
  const x = logDecision(db, parent, "picked X", "deckhand", at, "worker");
  const y = logDecision(db, parent, "picked Y", "deckhand", at, "worker");
  startTriage(db, at);
  const a = raiseObjection(db, x, "A's direction", at);
  commitTriage(db, at, [], new Map([[x, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));
  startTriage(db, at);
  raiseObjection(db, x, "B's direction on X", at);
  raiseObjection(db, y, "B's direction on Y", at);
  commitTriage(db, at, []);
  const aSelf = listChildren(db, parent.id).find((c) => {
    const registered = listEvents(db, c.id)[0]!.payload;
    return c.type === "review" && c.assignee === "deckhand" && registered.kind === "task_registered" && registered.opened_on_event_ids?.includes(a);
  })!.id;
  const aJudgment = listEvents(db, parent.id).find((e) => e.payload.kind === "objection_attributed")!.id;

  const result = proposeFromMaterial(db, aSelf, { ...draft, material_id: x }, {}, "auditor", at);
  const outside = () => proposeFromMaterial(db, aSelf, { ...draft, material_id: y }, {}, "auditor", at);

  expect(outside).toThrow(new DomainError(`entry ${y} is not in this review's material`));
  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: result.memory_entry_id, kind: "behavior", addressee: "deckhand", source: { kind: "event", ref: aJudgment }, cause: "capability" }),
  ]);
});

it("premise_breached の宣言への異議エントリからも提案できる", () => {
  const db = openDb(":memory:");
  const parent = task(db, "work", "T");
  const based_on_decision = logDecision(db, parent, "split T into A", "deckhand", at, "worker");
  const child = task(db, "work", "A", HUMAN_ACTOR_ID, parent.id);
  markPickedUp(db, child.id, at);
  const entry = appendEvent(db, {
    taskId: child.id,
    actorId: "deckhand",
    origin: "worker",
    payload: { kind: "premise_breached", line: "module M is broken", based_on_decision },
    at,
  });
  const attribution = attribute(db, child.id, entry, "capability");
  const self = rca(db, "rca (self): A", child).id;

  const result = proposeFromMaterial(db, self, { ...draft, material_id: entry }, {}, "auditor", at);

  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: result.memory_entry_id, kind: "behavior", state: "candidate", addressee: "deckhand", source: { kind: "event", ref: attribution } }),
  ]);
});
