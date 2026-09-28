import { expect, it } from "vitest";
import { proposeFromObjection } from "../src/attribution.js";
import type { Cause } from "../src/cause.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { listMemoryEntries } from "../src/memory.js";
import { BOARD_WORKER_ID, DomainError, HUMAN_WORKER_ID, logDecision, registerTask, type Task, type TaskType } from "../src/tasks.js";

/** RCA の起草 verb `propose_from_objection` の門(issue #1077)と成功経路(issue #1092)のドメイン層。
 *  tool error への写像はサーバ境界(tests/mcp-propose-from-objection.test.ts)が言う。 */
const at = new Date("2026-09-15T00:00:00.000Z");

const task = (db: Db, type: TaskType, title: string, registrant = HUMAN_WORKER_ID, parent_id?: string): Task =>
  registerTask(db, { type, title, purpose: "p", completion_criteria: "c", workspace: "charts", parent_id }, at, registrant);
const attribute = (db: Db, taskId: string, entry_id: number, cause: Cause, entries: number[] | null = null): number =>
  appendEvent(db, { taskId, workerId: BOARD_WORKER_ID, origin: "board", payload: { kind: "objection_attributed", entry_id, objection_event_ids: [], cause, evidence: "e", entries, round: "initial" }, at });
/** 異議されたエントリ(agent の記入)に cause を帰責する。 */
const objected = (db: Db, parent: Task, cause: Cause, worker = "deckhand"): number => {
  const entry = logDecision(db, parent, `decided as ${cause}`, worker, at);
  attribute(db, parent.id, entry, cause);
  return entry;
};

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
  const memory = logDecision(db, mixed, "decided as memory", "deckhand", at);
  attribute(db, mixed.id, memory, "memory", [1]);
  const unattributed = appendEvent(db, { taskId: mixed.id, workerId: "deckhand", origin: "worker", payload: { kind: "task_completed", handoff_present: true, result: null }, at });
  // 異議されたが初回の帰責が無い(撃てなかった / 失敗した)エントリは uncertain と同じに読む(ADR 0168 決定3)
  const objectedUnattributed = logDecision(db, mixed, "decided before the Board call failed", "deckhand", at);
  appendEvent(db, { taskId: mixed.id, workerId: HUMAN_WORKER_ID, origin: "webui", payload: { kind: "objection_raised", entry_id: objectedUnattributed, comment: "keep the fixtures", session_id: 1 }, at });
  const byHuman = objected(db, mixed, "capability", HUMAN_WORKER_ID);
  const notDecision = attribute(db, mixed.id, capability, "capability");
  const otherEntry = objected(db, task(db, "work", "other"), "capability");
  const delegated = task(db, "work", "delegated", "tako");
  const delegatedEntry = objected(db, delegated, "missing_information");
  const byBoard = task(db, "work", "by the board", BOARD_WORKER_ID);
  const byBoardEntry = objected(db, byBoard, "task_ambiguity");

  const self = task(db, "review", "rca (self): mixed", HUMAN_WORKER_ID, mixed.id).id;
  const decision = logDecision(db, task(db, "review", "rca (auditor): mixed", HUMAN_WORKER_ID, mixed.id), "the fixture rule was never written down", "auditor", at);
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
    [self, { entry_id: unattributed }, `entry ${unattributed} carries no attributed objection`],
    [self, { entry_id: otherEntry }, `entry ${otherEntry} is not a decision-log entry of your parent task`],
    [self, { entry_id: 999_999 }, "entry 999999 is not a decision-log entry of your parent task"],
    [task(db, "work", "repair: mixed", HUMAN_WORKER_ID, mixed.id).id, { entry_id: capability }, "propose_from_objection is only for a review of an objected task"],
    [task(db, "review", "loose review").id, { entry_id: capability }, "propose_from_objection is only for a review of an objected task"],
    [self, { entry_id: byHuman }, `entry ${byHuman} was written by a human`],
    [task(db, "review", "rca (auditor): delegated", HUMAN_WORKER_ID, delegated.id).id, { entry_id: delegatedEntry, as: "behavior", based_on_decision: decision }, decisionRule],
    // 盤面(tidepool)の登録は agent の登録ではない
    [task(db, "review", "rca (auditor): by the board", HUMAN_WORKER_ID, byBoard.id).id, { entry_id: byBoardEntry }, notAgent],
  ] as const) {
    const propose = () => proposeFromObjection(db, reviewId, { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", ...args }, {}, "auditor", at);
    expect(propose).toThrow(DomainError);
    expect(propose).toThrow(new DomainError(error));
  }
  expect(listMemoryEntries(db, {})).toEqual([]);
});

it("capability・preference は entry の worker 宛ての Behavior candidate になり、出所は最新の帰責 event、scope は親の workspace", () => {
  const db = openDb(":memory:");
  const mixed = task(db, "work", "mixed");
  const capabilityEntry = objected(db, mixed, "capability", "deckhand");
  const latest = attribute(db, mixed.id, capabilityEntry, "capability"); // 2度目の帰責 —— 出所は最新を指す
  const preferenceEntry = objected(db, mixed, "preference", "helmsman");
  const self = task(db, "review", "rca (self): mixed", HUMAN_WORKER_ID, mixed.id).id;

  const capabilityResult = proposeFromObjection(db, self, { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", entry_id: capabilityEntry }, {}, "auditor", at);
  const preferenceResult = proposeFromObjection(db, self, { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", entry_id: preferenceEntry }, {}, "auditor", at);

  expect(capabilityResult.event_id).toBe(capabilityResult.entry_id);
  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: capabilityResult.entry_id, kind: "behavior", state: "candidate", scope: "charts", addressee: "deckhand", source: { kind: "event", ref: latest }, cause: "capability" }),
    expect.objectContaining({ id: preferenceResult.entry_id, kind: "behavior", state: "candidate", scope: "charts", addressee: "helmsman", cause: "preference" }),
  ]);
});

it("agent 登録の task では task_ambiguity と missing_information(as: behavior)は登録者宛て、missing_information(as: knowledge)は宛先なしで即 approved・出所は RCA 自身の decision・cause は null", () => {
  const db = openDb(":memory:");
  const delegated = task(db, "work", "delegated", "tako");
  const taskAmbiguityEntry = objected(db, delegated, "task_ambiguity");
  const missingInformationEntry = objected(db, delegated, "missing_information");
  const auditor = task(db, "review", "rca (auditor): delegated", HUMAN_WORKER_ID, delegated.id);
  const decision = logDecision(db, auditor, "the fixture rule was never written down", "auditor", at);

  const ambiguityResult = proposeFromObjection(db, auditor.id, { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", entry_id: taskAmbiguityEntry }, {}, "auditor", at);
  const behaviorResult = proposeFromObjection(db, auditor.id, { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", entry_id: missingInformationEntry, as: "behavior" }, {}, "auditor", at);
  const knowledgeResult = proposeFromObjection(db, auditor.id, { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", entry_id: missingInformationEntry, as: "knowledge", based_on_decision: decision }, {}, "auditor", at);

  expect(knowledgeResult.event_id).toBe(knowledgeResult.entry_id);
  expect(listMemoryEntries(db, {})).toEqual([
    expect.objectContaining({ id: ambiguityResult.entry_id, kind: "behavior", state: "candidate", addressee: "tako", cause: "task_ambiguity" }),
    expect.objectContaining({ id: behaviorResult.entry_id, kind: "behavior", state: "candidate", addressee: "tako", cause: "missing_information" }),
    expect.objectContaining({ id: knowledgeResult.entry_id, kind: "knowledge", state: "approved", addressee: null, source: { kind: "decision", ref: decision }, cause: null }),
  ]);
});

it("premise_breached の宣言への異議エントリからも提案できる(decompose / continue_decomposition は経由しない)", () => {
  const db = openDb(":memory:");
  const child = task(db, "work", "A");
  const based_on_decision = logDecision(db, child, "split T into A", "board", at);
  const entry = appendEvent(db, {
    taskId: child.id,
    workerId: "deckhand",
    origin: "worker",
    payload: { kind: "premise_breached", line: "module M is broken", based_on_decision },
    at,
  });
  attribute(db, child.id, entry, "capability");
  const self = task(db, "review", "rca (self): A", HUMAN_WORKER_ID, child.id).id;

  const result = proposeFromObjection(db, self, { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", entry_id: entry }, {}, "auditor", at);

  expect(result.event_id).toBe(result.entry_id);
  expect(listMemoryEntries(db, {})).toEqual([expect.objectContaining({ id: result.entry_id, kind: "behavior", state: "candidate", addressee: "deckhand" })]);
});
