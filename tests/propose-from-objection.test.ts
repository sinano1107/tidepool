import { expect, it } from "vitest";
import type { Cause } from "../src/cause.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents, objectionBundles } from "../src/events.js";
import { listMemoryEntries } from "../src/memory.js";
import { proposeFromObjection } from "../src/retrospective.js";
import { BOARD_WORKER_ID, DomainError, HUMAN_WORKER_ID, listChildren, logDecision, registerTask, type Task, type TaskType } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { bundledObjection } from "./harness.js";

/** RCA の起草 verb `propose_from_objection` の門(issue #1077)と成功経路(issue #1092)のドメイン層。
 *  tool error への写像はサーバ境界(tests/mcp-propose-from-objection.test.ts)が言う。 */
const at = new Date("2026-09-15T00:00:00.000Z");
/** 起草の中身(門と導出はこれを見ない)。 */
const draft = { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures." };

const task = (db: Db, type: TaskType, title: string, registrant = HUMAN_WORKER_ID, parent_id?: string): Task =>
  registerTask(db, { type, title, purpose: "p", completion_criteria: "c", workspace: "charts", parent_id }, at, registrant, "webui");
/** entry に束ね済みの異議群を1つ足し、その異議群に cause を帰責する(呼ぶたびに後の異議群)。 */
const attribute = (db: Db, taskId: string, entry_id: number, cause: Cause, entries: number[] | null = null): number => {
  const objection = bundledObjection(db, taskId, entry_id, at);
  return appendEvent(db, { taskId, workerId: BOARD_WORKER_ID, origin: "board", payload: { kind: "objection_attributed", entry_id, objection_event_ids: [objection], cause, evidence: "e", entries, round: "initial" }, at });
};
/** 異議されたエントリ(agent の記入)に cause を帰責する。 */
const objected = (db: Db, parent: Task, cause: Cause, worker = "deckhand"): number => {
  const entry = logDecision(db, parent, `decided as ${cause}`, worker, at, "worker");
  attribute(db, parent.id, entry, cause);
  return entry;
};
/** 親の entry ごとの最後の異議群の異議 id —— commit が立てる RCA 子と同じく、1本の RCA 子が覆う異議群は entry ごとに1つ(ADR 0171 決定1)。 */
const material = (db: Db, parentId: string): number[] =>
  [...objectionBundles(db).values()].flatMap((bundles) => (bundles.at(-1)!.task_id === parentId ? bundles.at(-1)!.objection_event_ids : []));
/** 親のいまの異議群を材料にした RCA 子。 */
const rca = (db: Db, title: string, parent: Task): Task =>
  registerTask(db, { type: "review", title, purpose: "p", completion_criteria: "c", workspace: "charts", parent_id: parent.id, objection_event_ids: material(db, parent.id) }, at, HUMAN_WORKER_ID, "webui");

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
  const unobjected = appendEvent(db, { taskId: mixed.id, workerId: "deckhand", origin: "worker", payload: { kind: "task_completed", handoff_present: true, result: null }, at });
  // 異議されたが初回の帰責が無い(撃てなかった / 失敗した)エントリは uncertain と同じに読む(ADR 0168 決定3)
  const objectedUnattributed = logDecision(db, mixed, "decided before the Board call failed", "deckhand", at, "worker");
  bundledObjection(db, mixed.id, objectedUnattributed, at, "keep the fixtures");
  const byHuman = objected(db, mixed, "capability", HUMAN_WORKER_ID);
  const notDecision = attribute(db, mixed.id, capability, "capability");
  const otherEntry = objected(db, task(db, "work", "other"), "capability");
  const delegated = task(db, "work", "delegated", "tako");
  const delegatedEntry = objected(db, delegated, "missing_information");
  const byBoard = task(db, "work", "by the board", BOARD_WORKER_ID);
  const byBoardEntry = objected(db, byBoard, "task_ambiguity");

  const self = rca(db, "rca (self): mixed", mixed).id;
  const decision = logDecision(db, task(db, "review", "rca (auditor): mixed", HUMAN_WORKER_ID, mixed.id), "the fixture rule was never written down", "auditor", at, "worker");
  const notAgent = "the task was not registered by an agent: there is no agent to address a behavior to";
  const asRule = 'as ("behavior" or "knowledge") is required for a missing_information entry and only for it';
  const decisionRule = "based_on_decision is required for a knowledge entry and only for it";

  for (const [reviewId, args, error] of [
    [self, { entry_id: uncertain }, "the entry's cause is uncertain: nothing to learn from it"],
    [self, { entry_id: objectedUnattributed }, "the entry's cause is uncertain: nothing to learn from it"],
    [self, { entry_id: requirementChange }, "the entry's cause is requirement_change: nothing to learn from it"],
    [self, { entry_id: environment }, "the entry's cause is environment: nothing to learn from it"],
    [self, { entry_id: memory }, "the entry's cause is memory: nothing to learn from it"],
    [self, { entry_id: taskAmbiguity }, notAgent],
    [self, { entry_id: missingInformation, as: "behavior" }, notAgent],
    [self, { entry_id: missingInformation }, asRule],
    [self, { entry_id: capability, as: "behavior" }, asRule],
    [self, { entry_id: missingInformation, as: "knowledge" }, decisionRule],
    [self, { entry_id: missingInformation, as: "knowledge", based_on_decision: notDecision }, `event ${notDecision} is not a logged decision`],
    [self, { entry_id: missingInformation, as: "knowledge", based_on_decision: capability }, `event ${capability} is not a decision of this task`],
    [self, { entry_id: capability, based_on_decision: decision }, decisionRule],
    [self, { entry_id: unobjected }, `entry ${unobjected} carries no objection`],
    [self, { entry_id: otherEntry }, `entry ${otherEntry} is not a decision-log entry of your parent task`],
    [self, { entry_id: 999_999 }, "entry 999999 is not a decision-log entry of your parent task"],
    [task(db, "work", "repair: mixed", HUMAN_WORKER_ID, mixed.id).id, { entry_id: capability }, "propose_from_objection is only for a review of an objected task"],
    [task(db, "review", "loose review").id, { entry_id: capability }, "propose_from_objection is only for a review of an objected task"],
    [self, { entry_id: byHuman }, `entry ${byHuman} was written by a human`],
    [rca(db, "rca (auditor): delegated", delegated).id, { entry_id: delegatedEntry, as: "behavior", based_on_decision: decision }, decisionRule],
    // 盤面(tidepool)の登録は agent の登録ではない
    [rca(db, "rca (auditor): by the board", byBoard).id, { entry_id: byBoardEntry }, notAgent],
  ] as const) {
    const propose = () => proposeFromObjection(db, reviewId, { ...draft, ...args }, {}, "auditor", at);
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
  const self = registerTask(db, { type: "review", title: "rca (self): mixed", purpose: "p", completion_criteria: "c", workspace: "elsewhere", parent_id: mixed.id, objection_event_ids: material(db, mixed.id) }, at, HUMAN_WORKER_ID, "webui").id;

  const capabilityResult = proposeFromObjection(db, self, { ...draft, entry_id: capabilityEntry }, {}, "auditor", at);
  const preferenceResult = proposeFromObjection(db, self, { ...draft, entry_id: preferenceEntry }, {}, "auditor", at);

  expect(capabilityResult.event_id).toBe(capabilityResult.entry_id);
  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ ...draft, id: capabilityResult.entry_id, kind: "behavior", state: "candidate", scope: "charts", addressee: "deckhand", source: { kind: "event", ref: latest }, cause: "capability" }),
    expect.objectContaining({ id: preferenceResult.entry_id, kind: "behavior", state: "candidate", addressee: "helmsman", cause: "preference" }),
  ]);
});

it("agent 登録の task では task_ambiguity と missing_information(as: behavior)は登録者宛て、missing_information(as: knowledge)は宛先なしで即 approved・出所は RCA 自身の decision・cause は null", () => {
  const db = openDb(":memory:");
  const delegated = task(db, "work", "delegated", "tako");
  const taskAmbiguityEntry = objected(db, delegated, "task_ambiguity");
  const missingInformationEntry = objected(db, delegated, "missing_information");
  const auditor = rca(db, "rca (auditor): delegated", delegated);
  const decision = logDecision(db, auditor, "the fixture rule was never written down", "auditor", at, "worker");

  const ambiguityResult = proposeFromObjection(db, auditor.id, { ...draft, entry_id: taskAmbiguityEntry }, {}, "auditor", at);
  const behaviorResult = proposeFromObjection(db, auditor.id, { ...draft, entry_id: missingInformationEntry, as: "behavior" }, {}, "auditor", at);
  const knowledgeResult = proposeFromObjection(db, auditor.id, { ...draft, entry_id: missingInformationEntry, as: "knowledge", based_on_decision: decision }, {}, "auditor", at);

  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: ambiguityResult.entry_id, kind: "behavior", state: "candidate", addressee: "tako", cause: "task_ambiguity" }),
    expect.objectContaining({ id: behaviorResult.entry_id, kind: "behavior", state: "candidate", addressee: "tako", cause: "missing_information" }),
    expect.objectContaining({ id: knowledgeResult.entry_id, kind: "knowledge", state: "approved", addressee: null, source: { kind: "decision", ref: decision }, cause: null }),
  ]);
});

it("RCA reviewer は自分の RCA が覆う異議群の判定から起草する —— 後の session が同じ entry を異議して未帰責でも前の判定から起草し、後の異議群にしか無い entry は材料にないとして拒む(ADR 0171 決定3)", () => {
  const db = openDb(":memory:");
  const parent = task(db, "work", "reobjected");
  const x = logDecision(db, parent, "picked X", "deckhand", at, "worker");
  const y = logDecision(db, parent, "picked Y", "deckhand", at, "worker");
  startTriage(db, at);
  const a = raiseObjection(db, x, "A's direction", at);
  commitTriage(db, at, [], new Map([[x, { cause: "capability", evidence: "e", entries: null }]]));
  startTriage(db, at);
  raiseObjection(db, x, "B's direction on X", at);
  raiseObjection(db, y, "B's direction on Y", at);
  commitTriage(db, at, []);
  const aSelf = listChildren(db, parent.id).find((c) => {
    const registered = listEvents(db, c.id)[0]!.payload;
    return c.type === "review" && c.assignee === "deckhand" && registered.kind === "task_registered" && registered.objection_event_ids?.includes(a);
  })!.id;
  const aJudgment = listEvents(db, parent.id).find((e) => e.payload.kind === "objection_attributed")!.id;

  const result = proposeFromObjection(db, aSelf, { ...draft, entry_id: x }, {}, "auditor", at);
  const outside = () => proposeFromObjection(db, aSelf, { ...draft, entry_id: y }, {}, "auditor", at);

  expect(outside).toThrow(new DomainError(`entry ${y} is not in this review's material`));
  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: result.entry_id, kind: "behavior", addressee: "deckhand", source: { kind: "event", ref: aJudgment }, cause: "capability" }),
  ]);
});

it("premise_breached の宣言への異議エントリからも提案できる", () => {
  const db = openDb(":memory:");
  const parent = task(db, "work", "T");
  const based_on_decision = logDecision(db, parent, "split T into A", "deckhand", at, "worker");
  const child = task(db, "work", "A", HUMAN_WORKER_ID, parent.id);
  const entry = appendEvent(db, {
    taskId: child.id,
    workerId: "deckhand",
    origin: "worker",
    payload: { kind: "premise_breached", line: "module M is broken", based_on_decision },
    at,
  });
  const attribution = attribute(db, child.id, entry, "capability");
  const self = rca(db, "rca (self): A", child).id;

  const result = proposeFromObjection(db, self, { ...draft, entry_id: entry }, {}, "auditor", at);

  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: result.entry_id, kind: "behavior", state: "candidate", addressee: "deckhand", source: { kind: "event", ref: attribution } }),
  ]);
});
