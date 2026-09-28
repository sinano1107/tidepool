import { expect, it } from "vitest";
import { proposeFromObjection } from "../src/attribution.js";
import type { Cause } from "../src/cause.js";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { listMemoryEntries } from "../src/memory.js";
import { BOARD_WORKER_ID, DomainError, HUMAN_WORKER_ID, logDecision, registerTask, type TaskType } from "../src/tasks.js";

/** RCA の起草 verb `propose_from_objection` の門(issue #1077)のドメイン層。成功経路と tool error への
 *  写像はサーバ境界(tests/mcp-propose-from-objection.test.ts)が言う。 */
const at = new Date("2026-09-15T00:00:00.000Z");

it("学習に向かない cause・宛先の agent が無い Behavior・as と based_on_decision の過不足・decision でない based_on_decision・帰責の無い / 他 task の / 存在しない / 人間が書いたエントリ・work task や parent の無い review からの呼び出しは DomainError で拒否され、店には何も載らない", () => {
  const db = openDb(":memory:");
  const task = (type: TaskType, title: string, registrant = HUMAN_WORKER_ID, parent_id?: string) =>
    registerTask(db, { type, title, purpose: "p", completion_criteria: "c", workspace: "charts", parent_id }, at, registrant);
  const attribute = (taskId: string, entry_id: number, cause: Cause) =>
    appendEvent(db, { taskId, workerId: BOARD_WORKER_ID, origin: "board", payload: { kind: "objection_attributed", entry_id, objection_event_ids: [], cause, evidence: "e", round: "initial" }, at });
  /** 異議されたエントリ(agent の記入)に cause を帰責する。 */
  const objected = (parent: ReturnType<typeof task>, cause: Cause, worker = "deckhand") => {
    const entry = logDecision(db, parent, `decided as ${cause}`, worker, at);
    attribute(parent.id, entry, cause);
    return entry;
  };

  const mixed = task("work", "mixed");
  const capability = objected(mixed, "capability");
  const uncertain = objected(mixed, "uncertain");
  const requirementChange = objected(mixed, "requirement_change");
  const environment = objected(mixed, "environment");
  const taskAmbiguity = objected(mixed, "task_ambiguity");
  const missingInformation = objected(mixed, "missing_information");
  const unattributed = appendEvent(db, { taskId: mixed.id, workerId: "deckhand", origin: "worker", payload: { kind: "task_completed", handoff_present: true, result: null }, at });
  const byHuman = objected(mixed, "capability", HUMAN_WORKER_ID);
  const notDecision = attribute(mixed.id, capability, "capability");
  const otherEntry = objected(task("work", "other"), "capability");
  const delegated = task("work", "delegated", "tako");
  const delegatedEntry = objected(delegated, "missing_information");
  const byBoard = task("work", "by the board", BOARD_WORKER_ID);
  const byBoardEntry = objected(byBoard, "task_ambiguity");

  const self = task("review", "rca (self): mixed", HUMAN_WORKER_ID, mixed.id).id;
  const decision = logDecision(db, task("review", "rca (auditor): mixed", HUMAN_WORKER_ID, mixed.id), "the fixture rule was never written down", "auditor", at);
  const notAgent = "the task was not registered by an agent: there is no agent to address a behavior to";
  const asRule = 'as ("behavior" or "knowledge") is required for a missing_information entry and only for it';
  const decisionRule = "based_on_decision is required for a knowledge entry and only for it";

  for (const [reviewId, args, error] of [
    [self, { entry_id: uncertain }, "the entry's cause is uncertain: nothing to learn from it"],
    [self, { entry_id: requirementChange }, "the entry's cause is requirement_change: nothing to learn from it"],
    [self, { entry_id: environment }, "the entry's cause is environment: nothing to learn from it"],
    [self, { entry_id: taskAmbiguity }, notAgent],
    [self, { entry_id: missingInformation, as: "behavior" }, notAgent],
    [self, { entry_id: missingInformation }, asRule],
    [self, { entry_id: capability, as: "behavior" }, asRule],
    [self, { entry_id: missingInformation, as: "knowledge" }, decisionRule],
    [self, { entry_id: missingInformation, as: "knowledge", based_on_decision: notDecision }, `event ${notDecision} is not a logged decision`],
    [self, { entry_id: capability, based_on_decision: decision }, decisionRule],
    [self, { entry_id: unattributed }, `entry ${unattributed} carries no attributed objection`],
    [self, { entry_id: otherEntry }, `entry ${otherEntry} is not a decision-log entry of your parent task`],
    [self, { entry_id: 999_999 }, "entry 999999 is not a decision-log entry of your parent task"],
    [task("work", "repair: mixed", HUMAN_WORKER_ID, mixed.id).id, { entry_id: capability }, "propose_from_objection is only for a review of an objected task"],
    [task("review", "loose review").id, { entry_id: capability }, "propose_from_objection is only for a review of an objected task"],
    [self, { entry_id: byHuman }, `entry ${byHuman} was written by a human`],
    [task("review", "rca (auditor): delegated", HUMAN_WORKER_ID, delegated.id).id, { entry_id: delegatedEntry, as: "behavior", based_on_decision: decision }, decisionRule],
    // 盤面(tidepool)の登録は agent の登録ではない
    [task("review", "rca (auditor): by the board", HUMAN_WORKER_ID, byBoard.id).id, { entry_id: byBoardEntry }, notAgent],
  ] as const) {
    const propose = () => proposeFromObjection(db, reviewId, { path: "testing/fixtures", title: "Keep fixtures", text: "Never skip the fixtures.", ...args }, {}, "auditor", at);
    expect(propose).toThrow(DomainError);
    expect(propose).toThrow(new DomainError(error));
  }
  expect(listMemoryEntries(db, {})).toEqual([]);
});
