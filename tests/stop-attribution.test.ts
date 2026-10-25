import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { CliAuthError } from "../src/cli-auth.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, latestEventOfTask, listEvents } from "../src/events.js";
import { humanEntryInput, listMemoryEntries, recordBehavior } from "../src/memory.js";
import { projectAndPersist } from "../src/precedent.js";
import { completeRca, listHaltedRefires, markHaltedRefire, proposeFromObjection, type RetrospectiveCallDeps, refireRetrospectiveCalls } from "../src/retrospective.js";
import { answerQuestion, cancelTaskDirectly, getTask, listBoard, listChildren, logDecision, pickupTask, registerTask, type Task, taskHistoryRows } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { recordHumanStop } from "../src/watchdog.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "../src/worker-id.js";
import { FakeAttributionClient, noRetrospectiveCalls } from "./fakes.js";
import { HUMAN_WEBUI, interviewExaminee, judgmentRows, QUIET_EXIT, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";

const at = new Date("2026-10-25T00:00:00Z");
const HOUR = 60 * 60 * 1000;

const work = (db: Db) => registerTask(db, { type: "work", title: "parser", purpose: "parse", completion_criteria: "works" }, at, ...HUMAN_WEBUI);

function fixture({ task = work, spawn = {}, worker = "deckhand" }: { task?: (db: Db) => Task; spawn?: Partial<Extract<EventPayload, { kind: "worker_spawned" }>>; worker?: string } = {}) {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const picked = pickupTask(db, task(db), "deckhand", at)!;
  const spawned = appendEvent(db, { taskId: picked.id, workerId: worker, origin: "board", at, payload: { ...WORKER_SPAWNED, ...spawn } });
  const entry = logDecision(db, picked, "deleted the fixtures", "deckhand", at, "worker");
  const client = new FakeAttributionClient();
  client.scriptStopJudgment({ cause: "capability", evidence: "deleted files outside the workspace" });
  const deps: RetrospectiveCallDeps = { ...noRetrospectiveCalls, attributionClient: client };
  const exit = (session = spawned) =>
    appendEvent(db, { taskId: picked.id, workerId: "deckhand", origin: "board", at, payload: { kind: "worker_exited", worker_spawned_event_id: session, output_closed: true, usage: null, ...QUIET_EXIT } });
  const sweep = async (now = at, with_ = deps) => {
    refireRetrospectiveCalls(db, with_, now);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const stopEvent = () => listEvents(db, picked.id).find((e) => e.kind === "session_stopped_by_human")!;
  const stopInputs = () => client.stopCalls.map((c) => c.input);
  const judged = () => listEvents(db, picked.id).filter((e) => e.kind === "stop_attributed").map((e) => e.payload);
  return { db, task: picked, spawned, entry, client, deps, exit, sweep, stopEvent, stopInputs, judged };
}

it("a stop with a reason is judged once by the sweep after its session closes, from the session window, its reads and no actions", async () => {
  const b = fixture();
  const memory = recordBehavior(b.db, humanEntryInput(b.db, { workspace: null, path: "build", title: "Keep fixtures", text: "Keep the fixtures.", addressee: "deckhand" }), "webui", at).entry_id;
  appendEvent(b.db, { taskId: b.task.id, workerId: "deckhand", origin: "worker", at, payload: { kind: "memory_pulled", verb: "read_memory", input: {}, returned_ids: [memory], watermark: 0 } });
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");

  await b.sweep();
  expect(b.client.stopCalls).toEqual([]);

  b.exit();
  await b.sweep();
  await b.sweep();

  expect(b.stopInputs()).toEqual([
    {
      human_stop: { reason: "deleting unrelated files" },
      decision_log: ["deleted the fixtures"],
      memory_read: [{ id: memory, kind: "behavior", title: "Keep fixtures", text: "Keep the fixtures." }],
      agent_definition: null,
      actions: null,
    },
  ]);
  expect(b.judged()).toEqual([{ kind: "stop_attributed", stop_event_id: b.stopEvent().id, cause: "capability", evidence: "deleted files outside the workspace", entries: null }]);
  expect(b.client.calls).toEqual([]);
});

it("the judge reads only the stopped session's decisions, not an earlier session's of the same task", async () => {
  const b = fixture();
  b.exit();
  const retry = appendEvent(b.db, { taskId: b.task.id, workerId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  logDecision(b.db, getTask(b.db, b.task.id)!, "removed ../other", "deckhand", at, "worker");
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit(retry);

  await b.sweep();

  expect(b.stopInputs().map((i) => i.decision_log)).toEqual([["removed ../other"]]);
});

it("an unanswered stop is not judged until its reason question is answered, then with the answer", async () => {
  const b = fixture();
  recordHumanStop(b.db, b.task.id, undefined, at, "webui");
  b.exit();

  await b.sweep();
  expect(b.client.stopCalls).toEqual([]);

  const reason = listBoard(b.db).find((q) => q.question_stop_reason_task_id === b.task.id)!;
  answerQuestion(b.db, getTask(b.db, reason.id)!, ["parser was deleting unrelated files"], at, undefined, undefined, undefined, "webui");
  await b.sweep();

  expect(b.stopInputs().map((i) => i.human_stop)).toEqual([{ reason: "parser was deleting unrelated files" }]);
});

it("a stop-approved cancel's stop is not judged", async () => {
  const b = fixture();
  cancelTaskDirectly(b.db, b.task, "work no longer needed", at, {}, "webui", undefined, {
    taskId: b.task.id,
    stop: (cancel) => recordHumanStop(b.db, b.task.id, "work no longer needed", at, "webui", cancel),
  });
  b.exit();

  await b.sweep();

  expect(b.client.stopCalls).toEqual([]);
});

it("an examinee's stop is not judged", async () => {
  const b = fixture({ task: (db) => interviewExaminee(db, at) });
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();

  await b.sweep();

  expect(b.client.stopCalls).toEqual([]);
});

it("a stop the board could not fire for (no client) leaves nothing", async () => {
  const b = fixture();
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();
  const before = listEvents(b.db, b.task.id).length;

  await b.sweep(at, { ...b.deps, attributionClient: undefined });

  expect(listEvents(b.db, b.task.id).length).toBe(before);
});

it("a 401 from the stop attribution Board call quarantines the Provider's authentication and leaves no failure event", async () => {
  const b = fixture();
  b.client.scriptStopJudgment(new CliAuthError("Invalid API key"));
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();

  await b.sweep();

  expect(listBoard(b.db).map((q) => q.title)).toContain("anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped");
  expect(listEvents(b.db, b.task.id).some((e) => e.kind === "stop_attribution_failed" || e.kind === "stop_attributed")).toBe(false);
});

const claudeLines = (decision: number) => [
  '{"type":"assistant","uuid":"u1","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"rm -rf ../other"}}]}}',
  '{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"denied"}]}}',
  '{"type":"assistant","uuid":"u3","message":{"content":[{"type":"tool_use","id":"t2","name":"mcp__tidepool__log_decision","input":{"line":"deleted the fixtures"}}]}}',
  `{"type":"user","uuid":"u4","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":[{"type":"text","text":${JSON.stringify(JSON.stringify({ event_id: decision }))}}]}]}}`,
];
const codexLines = (decision: number) => [
  '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"rm -rf ../other","status":"failed"}}',
  `{"type":"item.completed","item":{"id":"item_2","type":"mcp_tool_call","server":"tidepool","tool":"log_decision","arguments":{},"result":{"content":[{"type":"text","text":${JSON.stringify(JSON.stringify({ event_id: decision }))}}]},"error":null,"status":"completed"}}`,
];

it.each([
  { harness: "claude-code" as const, tool: "Bash", lines: claudeLines, cli_version: "1" },
  { harness: "codex" as const, tool: "command_execution", lines: codexLines, cli_version: "codex-cli 0.147.0" },
])("the judge reads the $harness session's action sequence with the decision's position", async ({ harness, tool, lines, cli_version }) => {
  const b = fixture({ spawn: { harness, cli_version } });
  await stoppedWithTranscript(b, lines(b.entry));

  await b.sweep();

  expect(b.stopInputs()[0]!.actions).toEqual({
    calls: [
      { index: 0, tool, args: "rm -rf ../other", failed: true },
      { index: 1, tool: "mcp__tidepool__log_decision", args: null, failed: false },
    ],
    decisions: [{ position: 1, line: "deleted the fixtures" }],
  });
});

it("a session whose transcript the projector could not read is judged with actions null", async () => {
  const b = fixture();
  await stoppedWithTranscript(b, ['{"type":"mystery"}']);

  await b.sweep();

  expect(b.stopInputs().map((i) => i.actions)).toEqual([null]);
});

/** setup: 理由つきで止め、session を閉じ、その transcript を投影する。 */
async function stoppedWithTranscript(b: ReturnType<typeof fixture>, lines: string[]) {
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();
  const transcriptPath = join(await tempDir("tidepool-stop-"), `${b.task.id}.${b.spawned}.stream.jsonl`);
  writeFileSync(transcriptPath, lines.join("\n"));
  projectAndPersist(b.db, { workerSpawnedEventId: b.spawned, transcriptPath });
}

it.each([
  { judgment: { cause: "memory" as const, evidence: "followed a note", entries: [999] }, rejected: "memory attribution rejected: entry 999 was not read before the decision" },
  { judgment: { cause: "capability" as const, evidence: "e", entries: [1] }, rejected: "capability attribution rejected: entries are only for cause memory" },
])("a $judgment.cause judgment the gate refuses falls to uncertain", async ({ judgment, rejected }) => {
  const b = fixture();
  b.client.scriptStopJudgment(judgment);
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();

  await b.sweep();

  expect(b.judged()).toEqual([{ kind: "stop_attributed", stop_event_id: b.stopEvent().id, cause: "uncertain", evidence: rejected, entries: null }]);
});

it("a failing Board call leaves failure events, halts after 3 as a stop row without an entry, and Retry / Dismiss act on it", async () => {
  const b = fixture();
  b.client.scriptStopJudgment(new Error("CLI exited 1"));
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();
  const stop = b.stopEvent().id;
  for (const hour of [0, 1, 2, 3]) await b.sweep(new Date(at.getTime() + hour * HOUR));

  expect(b.client.stopCalls).toHaveLength(3);
  expect(listEvents(b.db, b.task.id).filter((e) => e.kind === "stop_attribution_failed").map((e) => e.payload)).toEqual(
    Array(3).fill({ kind: "stop_attribution_failed", stop_event_id: stop, reason: "Board call failed: CLI exited 1" }),
  );
  expect(listHaltedRefires(b.db)).toEqual([
    {
      refire: "stop_attribution",
      target: stop,
      stop: { reason: "deleting unrelated files" },
      task: { id: b.task.id, title: "parser" },
      last_failure: { reason: "Board call failed: CLI exited 1", at: new Date(at.getTime() + 2 * HOUR).toISOString() },
    },
  ]);

  markHaltedRefire(b.db, "refire_retried", { refire: "stop_attribution", target: stop }, "webui", at);
  await b.sweep(new Date(at.getTime() + 4 * HOUR));
  expect(b.client.stopCalls).toHaveLength(4);

  for (const hour of [5, 6]) await b.sweep(new Date(at.getTime() + hour * HOUR));
  markHaltedRefire(b.db, "refire_dismissed", { refire: "stop_attribution", target: stop }, "webui", at);
  await b.sweep(new Date(at.getTime() + 7 * HOUR));
  expect(b.client.stopCalls).toHaveLength(6);
  expect(listHaltedRefires(b.db)).toEqual([]);
});

it("the history's stop row carries the judgment's cause and evidence", async () => {
  const b = fixture();
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();

  await b.sweep();

  expect(taskHistoryRows(b.db, b.task.id).find((r) => "stopped_by_human" in r.entry)?.entry).toEqual({
    stopped_by_human: { reason: "deleting unrelated files", cause: "capability", evidence: "deleted files outside the workspace" },
  });
});

/** 止められた task の付帯子の review と、その登録の材料 id(ADR 0310 決定4)。 */
const rcas = (b: ReturnType<typeof fixture>) =>
  listChildren(b.db, b.task.id)
    .filter((c) => c.type === "review")
    .map((r) => ({ task: r, material: latestEventOfTask(b.db, r.id, "task_registered")!.payload.objection_event_ids }));

/** setup: 理由つきで止め、session を閉じ、sweep で判定させる。 */
async function stoppedAndJudged(b: ReturnType<typeof fixture>) {
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();
  await b.sweep();
  return b.stopEvent().id;
}

it("a capability stop judgment registers a self RCA for the session's worker and an auditor RCA under the stopped task, on the stop as material, quoting the reason", async () => {
  const b = fixture();
  const stop = await stoppedAndJudged(b);

  expect(rcas(b).map(({ task, material }) => ({ title: task.title, assignee: task.assignee, material }))).toEqual([
    { title: "rca (self): parser", assignee: "deckhand", material: [stop] },
    { title: "rca (auditor): parser", assignee: null, material: [stop] },
  ]);
  for (const { task } of rcas(b)) expect(task.purpose).toContain(`> stop ${stop}: deleting unrelated files`);
});

it.each([
  { cause: "uncertain" as const, registered: 2 },
  { cause: "task_ambiguity" as const, registered: 2 },
  { cause: "requirement_change" as const, registered: 0 },
  { cause: "preference" as const, registered: 0 },
  { cause: "memory" as const, registered: 0 },
])("a $cause stop judgment registers $registered RCAs", async ({ cause, registered }) => {
  const b = fixture();
  const memory = recordBehavior(b.db, humanEntryInput(b.db, { workspace: null, path: "build", title: "Keep fixtures", text: "Keep the fixtures.", addressee: "deckhand" }), "webui", at).entry_id;
  appendEvent(b.db, { taskId: b.task.id, workerId: "deckhand", origin: "worker", at, payload: { kind: "memory_pulled", verb: "read_memory", input: {}, returned_ids: [memory], watermark: 0 } });
  b.client.scriptStopJudgment({ cause, evidence: "e", ...(cause === "memory" && { entries: [memory] }) });

  await stoppedAndJudged(b);

  expect(b.judged()).toEqual([expect.objectContaining({ cause })]);
  expect(rcas(b)).toHaveLength(registered);
});

it("a session the human ran gets only the auditor RCA", async () => {
  const b = fixture({ worker: HUMAN_WORKER_ID });

  const stop = await stoppedAndJudged(b);

  expect(rcas(b).map(({ task }) => task.title)).toEqual(["rca (auditor): parser"]);
  expect(() => proposeFromObjection(b.db, rcas(b)[0]!.task.id, { path: "p", title: "t", text: "x", entry_id: stop }, { workspace: { name: "charts" } }, "auditor", at)).toThrow(
    `entry ${stop} was written by a human`,
  );
});

it.each([
  { state: "held while its failure question is open", abandon: false, status: "todo" },
  { state: "cancelled by abandon", abandon: true, status: "cancelled" },
])("the RCAs register when the stopped task is $state", async ({ abandon, status }) => {
  const b = fixture();
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  const failure = listChildren(b.db, b.task.id).find((c) => c.type === "question")!;
  if (abandon) answerQuestion(b.db, failure, ["abandon"], at, undefined, undefined, undefined, "webui");
  b.exit();

  await b.sweep();

  expect(getTask(b.db, b.task.id)!.status).toBe(status);
  expect(rcas(b)).toHaveLength(2);
});

it("a stop on a session whose entry already has an objection-bundle RCA registers its own RCAs beside it", async () => {
  const b = fixture();
  startTriage(b.db, at);
  const objection = raiseObjection(b.db, b.entry, "redo it", at);
  commitTriage(b.db, at, [], new Map([[b.entry, { cause: "capability", evidence: "e", entries: null }]]));

  const stop = await stoppedAndJudged(b);

  expect(rcas(b).map(({ task, material }) => [task.title, material])).toEqual([
    ["rca (self): parser", [objection]],
    ["rca (auditor): parser", [objection]],
    ["rca (self): parser", [stop]],
    ["rca (auditor): parser", [stop]],
  ]);
});

it("a stop RCA completes with one finding covering the stop, and refuses another id, an empty finding and the stop in two findings", async () => {
  const b = fixture();
  const stop = await stoppedAndJudged(b);
  const self = rcas(b)[0]!.task;
  const complete = (findings: Array<{ entries: number[]; root_cause: string; no_proposal?: true }>) => completeRca(b.db, self, { findings }, "deckhand", at, "worker");

  expect(() => complete([{ entries: [b.entry], root_cause: "r", no_proposal: true }])).toThrow(`not in this RCA's material: entries ${b.entry}; in no finding: entries ${stop}`);
  expect(() => complete([{ entries: [], root_cause: "r", no_proposal: true }])).toThrow("a finding names no entries");
  expect(() => complete([{ entries: [stop], root_cause: "r", no_proposal: true }, { entries: [stop], root_cause: "r", no_proposal: true }])).toThrow(`named more than once: entries ${stop}`);

  expect(complete([{ entries: [stop], root_cause: "deleted outside the workspace", no_proposal: true }]).status).toBe("done");
  expect(judgmentRows(b.db, self.id)).toEqual([
    {
      kind: "decision_logged",
      line: `no_proposal: entries ${stop} — deleted outside the workspace`,
      judgment: { kind: "rca", entries: [stop], root_cause: "deleted outside the workspace", memories: [], repairs: [], no_proposal: true },
    },
  ]);
});

it("a stop RCA proposes from its stop: a Behavior candidate from the latest stop attribution, addressed to the session's worker, scoped as the stopped task, listed by complete_rca; another id is refused", async () => {
  const b = fixture();
  const stop = await stoppedAndJudged(b);
  const self = rcas(b)[0]!.task;
  const latest = appendEvent(b.db, { taskId: b.task.id, workerId: BOARD_WORKER_ID, origin: "board", at, payload: { kind: "stop_attributed", stop_event_id: stop, cause: "capability", evidence: "later", entries: null } });
  const draft = { path: "workspace/scope", title: "Stay inside the workspace", text: "Never delete outside the workspace." };
  const propose = (entry_id: number) => proposeFromObjection(b.db, self.id, { ...draft, entry_id }, { workspace: { name: "charts" } }, "deckhand", at);

  expect(() => propose(b.entry)).toThrow(`entry ${b.entry} is not in this review's material`);
  const { entry_id } = propose(stop);

  expect(listMemoryEntries(b.db, {})).toEqual([
    expect.objectContaining({ ...draft, id: entry_id, kind: "behavior", state: "candidate", scope: "charts", addressee: "deckhand", source: { kind: "event", ref: latest }, cause: "capability" }),
  ]);
  completeRca(b.db, self, { findings: [{ entries: [stop], root_cause: "r" }] }, "deckhand", at, "worker");
  expect(judgmentRows(b.db, self.id).map((r) => r.line)).toEqual([`entries ${stop} → behavior candidate #${entry_id} — r`]);
});

it("an RCA opened on objections refuses a stop's id", async () => {
  const b = fixture();
  startTriage(b.db, at);
  raiseObjection(b.db, b.entry, "redo it", at);
  commitTriage(b.db, at, [], new Map([[b.entry, { cause: "capability", evidence: "e", entries: null }]]));
  const stop = await stoppedAndJudged(b);
  const objectionSelf = rcas(b)[0]!.task;

  expect(() => proposeFromObjection(b.db, objectionSelf.id, { path: "p", title: "t", text: "x", entry_id: stop }, { workspace: { name: "charts" } }, "deckhand", at)).toThrow(
    `entry ${stop} is not a decision-log entry of your parent task`,
  );
});
