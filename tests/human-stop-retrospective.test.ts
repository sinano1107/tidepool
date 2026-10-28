import { expect, it, onTestFinished } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { approveMemoryProposal, createBehaviorCandidate, humanEntryInput, readMemory, recordBehavior } from "../src/memory.js";
import { attributeObjections, completeRca, refireRetrospectiveCalls } from "../src/retrospective.js";
import { answerQuestion, cancelTaskDirectly, getTask, listBoard, listChildren, logDecision, pickupTask, registerTask } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { recordHumanStop } from "../src/watchdog.js";
import { FakeAttributionClient, FakeBehaviorDraftClient, noRetrospectiveCalls } from "./fakes.js";
import { HUMAN_WEBUI, QUIET_EXIT, rcaFindings, WORKER_SPAWNED } from "./harness.js";

const at = new Date("2026-10-25T00:00:00Z");
function fixture() {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const registered = registerTask(db, { type: "work", title: "parser", purpose: "parse", completion_criteria: "works" }, at, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", at)!;
  const spawned = appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  const entry = logDecision(db, task, "deleted the fixtures", "deckhand", at, "worker");
  const session = startTriage(db, at);
  raiseObjection(db, entry, "keep the fixtures", at);
  const client = new FakeAttributionClient();
  const deps = { ...noRetrospectiveCalls, attributionClient: client, workspace: { name: "charts" } };
  return { db, task, spawned, entry, session, client, deps };
}

it.each(["deleting unrelated files", undefined])("attribution receives the same session's human stop after its last decision (reason: %s)", async (reason) => {
  const b = fixture();
  recordHumanStop(b.db, b.task.id, reason, at, "webui");

  await attributeObjections(b.db, b.deps, b.session.id, at);

  expect(b.client.calls[0]!.input).toMatchObject({
    human_stop: { reason: reason ?? "not yet answered" },
    decision_log: [{ id: b.entry, line: "deleted the fixtures" }],
  });
});


it("a stop in a later retry session does not enter the first session's attribution", async () => {
  const b = fixture();
  // Setup: the first worker exited, then a retry started on the same task.
  appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: { kind: "worker_exited", advisor: null, model_swaps: [], refusals: [], worker_spawned_event_id: b.spawned, output_closed: true, usage: null, ...QUIET_EXIT } });
  appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  recordHumanStop(b.db, b.task.id, "retry went wrong", at, "webui");

  await attributeObjections(b.db, b.deps, b.session.id, at);

  expect(b.client.calls[0]!.input).not.toHaveProperty("human_stop");
});

it("stop-approved cancel supplies the human stop to attribution and initial drafting", async () => {
  const b = fixture();
  const reason = "work no longer needed";
  cancelTaskDirectly(b.db, b.task, reason, at, {}, "webui", undefined, {
    taskId: b.task.id,
    stop: (cancel) => recordHumanStop(b.db, b.task.id, reason, at, "webui", cancel),
  });
  b.client.scriptJudgment(b.entry, { cause: "preference", evidence: "human preference" });
  const drafter = new FakeBehaviorDraftClient();
  const deps = { ...b.deps, behaviorDraftClient: drafter };
  commitTriage(b.db, at, [], await attributeObjections(b.db, deps, b.session.id, at));

  refireRetrospectiveCalls(b.db, deps, at);
  await new Promise((resolve) => setImmediate(resolve));

  expect([b.client.calls[0]!.input, drafter.calls[0]!.input].map((i) => i.human_stop)).toEqual([{ reason }, { reason }]);
});

it("second-round attribution and drafting resolve the later answer without changing the historical decision log", async () => {
  const b = fixture();
  recordHumanStop(b.db, b.task.id, undefined, at, "webui");
  commitTriage(b.db, at, [], await attributeObjections(b.db, b.deps, b.session.id, at));
  const reason = listBoard(b.db).find((q) => q.question_stop_reason_task_id === b.task.id)!;
  answerQuestion(b.db, getTask(b.db, reason.id)!, ["deleting unrelated files"], at, undefined, undefined, undefined, "webui");
  for (const rca of listChildren(b.db, b.task.id).filter((c) => c.type === "review")) {
    completeRca(b.db, rca, rcaFindings(b.db, rca.id), "auditor", at, "worker");
  }
  b.client.scriptJudgment(b.entry, { cause: "capability", evidence: "RCA explained the mistake" });
  const drafter = new FakeBehaviorDraftClient();

  refireRetrospectiveCalls(b.db, { ...b.deps, behaviorDraftClient: drafter }, at);
  await new Promise((resolve) => setImmediate(resolve));

  expect(b.client.calls[0]!.input.human_stop).toEqual({ reason: "not yet answered" });
  expect([b.client.calls[1]!.input, drafter.calls[0]!.input].map((i) => ({ stop: i.human_stop, log: i.decision_log }))).toEqual([
    { stop: { reason: "deleting unrelated files" }, log: [{ id: b.entry, line: "deleted the fixtures" }] },
    { stop: { reason: "deleting unrelated files" }, log: [{ id: b.entry, line: "deleted the fixtures" }] },
  ]);
});


it.each(["deleting unrelated files", undefined, null])("memory cases from attribution carry its session's stop, while directly cited cases omit it (reason: %s)", async (reason) => {
  const b = fixture();
  if (reason !== null) recordHumanStop(b.db, b.task.id, reason, at, "webui");
  b.client.scriptJudgment(b.entry, { cause: "preference", evidence: "human preference" });
  commitTriage(b.db, at, [], await attributeObjections(b.db, b.deps, b.session.id, at));
  const attributed = listEvents(b.db, b.task.id).find((e) => e.kind === "objection_attributed")!;
  const candidate = createBehaviorCandidate(b.db, {
    scope: null, path: "build", title: "Keep fixtures", text: "Keep the fixtures.", addressee: "deckhand",
    source: { event_id: attributed.id }, author: { activity: "rca", name: "auditor" },
  }, "board", at).entry_id;
  approveMemoryProposal(b.db, { kind: "memory", op: "approve", candidate_id: candidate, replaces: [] }, "approval", "webui", at);
  const direct = recordBehavior(b.db, humanEntryInput(b.db, {
    workspace: null, path: "build", title: "Direct case", text: "Keep the fixtures.", addressee: "deckhand", source_event_id: b.entry,
  }), "webui", at).entry_id;

  const cases = readMemory(b.db, { taskId: b.task.id, scope: null, agent: "deckhand" }, { ids: [candidate, direct] }, at).entries.map((e) => e.case);

  expect(cases[0]).toEqual({
    decision: "deleted the fixtures", steering: ["keep the fixtures"], handoff: null, result: null,
    ...(reason === null ? {} : { human_stop: { reason: reason ?? "not yet answered" } }),
  });
  expect(cases[1]).not.toHaveProperty("human_stop");
});
