import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { CliAuthError } from "../src/cli-auth.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, type EventRowOf, latestEventOfTask, listEvents } from "../src/events.js";
import { loadEpisodes } from "../src/learner.js";
import { approveMemoryProposal, humanEntryInput, listMemoryEntries, readMemory, recordBehavior } from "../src/memory.js";
import { META_REVIEW_SUBJECTS, materialEvents } from "../src/meta-review.js";
import { markProjectionPending, projectAndPersist, projectWhenTranscriptCloses } from "../src/precedent.js";
import { completeRca, listHaltedRefires, markHaltedRefire, proposeFromMaterial, type RetrospectiveCallDeps, refireRetrospectiveCalls } from "../src/retrospective.js";
import { answerQuestion, cancelTaskDirectly, getTask, listBoard, listChildren, logDecision, pickupTask, registerTask, type Task, taskHistoryRows } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { recordHumanStop } from "../src/watchdog.js";
import { FakeAttributionClient, FakeBehaviorDraftClient, noRetrospectiveCalls } from "./fakes.js";
import { HUMAN_WEBUI, interviewExaminee, judgmentRows, QUIET_EXIT, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";

const at = new Date("2026-10-25T00:00:00Z");
const HOUR = 60 * 60 * 1000;

const work = (db: Db) => registerTask(db, { type: "work", title: "parser", purpose: "parse", completion_criteria: "works" }, at, ...HUMAN_WEBUI);

function fixture({ task = work, spawn = {}, worker = "deckhand" }: { task?: (db: Db) => Task; spawn?: Partial<Extract<EventPayload, { kind: "worker_spawned" }>>; worker?: string } = {}) {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const picked = pickupTask(db, task(db), "deckhand", at)!;
  const spawned = appendEvent(db, { taskId: picked.id, actorId: worker, origin: "board", at, payload: { ...WORKER_SPAWNED, ...spawn } });
  const entry = logDecision(db, picked, "deleted the fixtures", "deckhand", at, "worker");
  const client = new FakeAttributionClient();
  client.scriptStopJudgment({ cause: "capability", evidence: "deleted files outside the workspace" });
  const deps: RetrospectiveCallDeps = { ...noRetrospectiveCalls, attributionClient: client };
  const exit = (session = spawned) =>
    appendEvent(db, { taskId: picked.id, actorId: "deckhand", origin: "board", at, payload: { kind: "worker_exited", worker_spawned_event_id: session, output_closed: true, usage: null, ...QUIET_EXIT } });
  const sweep = async (now = at, with_ = deps) => {
    refireRetrospectiveCalls(db, with_, now);
    await new Promise((resolve) => setImmediate(resolve));
  };
  const stopEvent = () => listEvents(db, picked.id).find((e) => e.kind === "session_stopped_by_human")!;
  const stopInputs = () => client.stopCalls.map((c) => c.input);
  const judgments = () => listEvents(db, picked.id).filter((e): e is EventRowOf<"stop_attributed"> => e.payload.kind === "stop_attributed");
  const judged = () => judgments().map((e) => e.payload);
  return { db, task: picked, spawned, entry, client, deps, exit, sweep, stopEvent, stopInputs, judgments, judged };
}

it("a stop with a reason is judged once by the sweep after its session closes, from the session window, its reads and no actions", async () => {
  const b = fixture();
  const memory = recordBehavior(b.db, humanEntryInput(b.db, { workspace: null, path: "build", title: "Keep fixtures", text: "Keep the fixtures.", addressee: "deckhand" }), "webui", at).entry_id;
  appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "worker", at, payload: { kind: "memory_pulled", verb: "read_memory", input: {}, returned_ids: [memory], watermark: 0 } });
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
  expect(b.judged()).toEqual([{ kind: "stop_attributed", stop_event_id: b.stopEvent().id, cause: "capability", evidence: "deleted files outside the workspace", wrong_memory_entries: null, round: "initial" }]);
  expect(b.client.calls).toEqual([]);
});

it("the judge reads only the stopped session's decisions, not an earlier session's of the same task", async () => {
  const b = fixture();
  b.exit();
  const retry = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
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

/** setup: 理由つきで止め、adapter と同じ順で transcript の投影待ちを立てて session を閉じ、投影を閉じていない stream の close に予約する。 */
function stoppedPendingProjection(b: ReturnType<typeof fixture>, transcriptPath: string) {
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  markProjectionPending(b.db, b.spawned);
  b.exit();
  const stream = Object.assign(new EventEmitter(), { closed: false });
  projectWhenTranscriptCloses(b.db, stream, { workerSpawnedEventId: b.spawned, transcriptPath, taskId: b.task.id });
  return () => {
    stream.closed = true;
    stream.emit("close");
  };
}

it("a stop is not judged while its session's Episode projection is pending, then once with the projected actions", async () => {
  const b = fixture();
  const transcriptPath = join(await tempDir("tidepool-stop-"), `${b.task.id}.${b.spawned}.stream.jsonl`);
  writeFileSync(transcriptPath, claudeLines(b.entry).join("\n"));
  const close = stoppedPendingProjection(b, transcriptPath);

  await b.sweep();
  expect(b.client.stopCalls).toEqual([]);

  close();
  await b.sweep();

  expect(b.stopInputs().map((i) => i.actions)).toEqual([
    {
      calls: [
        { index: 0, tool: "Bash", args: "rm -rf ../other", failed: true },
        { index: 1, tool: "mcp__tidepool__log_decision", args: null, failed: false },
      ],
      decisions: [{ position: 1, line: "deleted the fixtures" }],
    },
  ]);
});

it("a projection pending on another board with the same spawn event id does not hold this board's stop", async () => {
  const b = fixture();
  const other = openDb(":memory:");
  onTestFinished(() => { other.close(); });
  markProjectionPending(other, b.spawned);
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();

  await b.sweep();

  expect(b.client.stopCalls).toHaveLength(1);
});

it("a stop whose session's projection threw is judged with actions null after the transcript closes", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const b = fixture();
  const close = stoppedPendingProjection(b, join(await tempDir("tidepool-stop-"), "missing.stream.jsonl"));

  close();
  await b.sweep();

  expect(b.stopInputs().map((i) => i.actions)).toEqual([null]);
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
  { judgment: { cause: "memory" as const, evidence: "followed a note", wrong_memory_entries: [999] }, rejected: "memory attribution rejected: memory entry 999 was not read before the decision" },
  { judgment: { cause: "capability" as const, evidence: "e", wrong_memory_entries: [1] }, rejected: "capability attribution rejected: wrong_memory_entries are only for cause memory" },
])("a $judgment.cause judgment the gate refuses falls to uncertain", async ({ judgment, rejected }) => {
  const b = fixture();
  b.client.scriptStopJudgment(judgment);
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();

  await b.sweep();

  expect(b.judged()).toEqual([{ kind: "stop_attributed", stop_event_id: b.stopEvent().id, cause: "uncertain", evidence: rejected, wrong_memory_entries: null, round: "initial" }]);
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
    .map((r) => ({ task: r, material: latestEventOfTask(b.db, r.id, "task_registered")!.payload.opened_on_event_ids }));

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
  appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "worker", at, payload: { kind: "memory_pulled", verb: "read_memory", input: {}, returned_ids: [memory], watermark: 0 } });
  b.client.scriptStopJudgment({ cause, evidence: "e", ...(cause === "memory" && { wrong_memory_entries: [memory] }) });

  await stoppedAndJudged(b);

  expect(b.judged()).toEqual([expect.objectContaining({ cause })]);
  expect(rcas(b)).toHaveLength(registered);
});

it("a session the human ran gets only the auditor RCA", async () => {
  const b = fixture({ worker: HUMAN_ACTOR_ID });

  const stop = await stoppedAndJudged(b);

  expect(rcas(b).map(({ task }) => task.title)).toEqual(["rca (auditor): parser"]);
  expect(() => proposeFromMaterial(b.db, rcas(b)[0]!.task.id, { path: "p", title: "t", text: "x", material_id: stop }, { workspace: { name: "charts" } }, "auditor", at)).toThrow(
    `stop ${stop} stopped a session a human ran`,
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
  commitTriage(b.db, at, [], new Map([[b.entry, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));

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
  const complete = (findings: Array<{ material: number[]; root_cause: string; no_act?: true }>) => completeRca(b.db, self, { findings }, "deckhand", at, "worker");

  expect(() => complete([{ material: [b.entry], root_cause: "r", no_act: true }])).toThrow(`not in this RCA's material: stop ${b.entry}; in no finding: stop ${stop}`);
  expect(() => complete([{ material: [], root_cause: "r", no_act: true }])).toThrow("a finding names no stop");
  expect(() => complete([{ material: [stop], root_cause: "r", no_act: true }, { material: [stop], root_cause: "r", no_act: true }])).toThrow(`named more than once: stop ${stop}`);

  expect(complete([{ material: [stop], root_cause: "deleted outside the workspace", no_act: true }]).status).toBe("done");
  expect(judgmentRows(b.db, self.id)).toEqual([
    {
      kind: "decision_logged",
      line: `no_act: stop ${stop} — deleted outside the workspace`,
      judgment: { kind: "rca", material: [stop], root_cause: "deleted outside the workspace", memories: [], repairs: [], no_act: true },
    },
  ]);
});

it("a stop RCA proposes from its stop: a Behavior candidate from the latest stop attribution, addressed to the session's worker, scoped as the stopped task, listed by complete_rca; another id is refused", async () => {
  const b = fixture();
  const stop = await stoppedAndJudged(b);
  const self = rcas(b)[0]!.task;
  const latest = appendEvent(b.db, { taskId: b.task.id, actorId: BOARD_ACTOR_ID, origin: "board", at, payload: { kind: "stop_attributed", stop_event_id: stop, cause: "capability", evidence: "later", wrong_memory_entries: null, round: "initial" } });
  const draft = { path: "workspace/scope", title: "Stay inside the workspace", text: "Never delete outside the workspace." };
  const propose = (entry_id: number) => proposeFromMaterial(b.db, self.id, { ...draft, material_id: entry_id }, { workspace: { name: "charts" } }, "deckhand", at);

  expect(() => propose(b.entry)).toThrow(`id ${b.entry} is not the stop this review was opened on`);
  const { memory_entry_id } = propose(stop);

  expect(listMemoryEntries(b.db, {})).toEqual([
    expect.objectContaining({ ...draft, id: memory_entry_id, kind: "behavior", state: "candidate", scope: "charts", addressee: "deckhand", source: { kind: "event", ref: latest } }),
  ]);
  completeRca(b.db, self, { findings: [{ material: [stop], root_cause: "r" }] }, "deckhand", at, "worker");
  expect(judgmentRows(b.db, self.id).map((r) => r.line)).toEqual([`stop ${stop} → behavior candidate #${memory_entry_id} — r`]);
});

it("an RCA opened on objections refuses a stop's id", async () => {
  const b = fixture();
  startTriage(b.db, at);
  raiseObjection(b.db, b.entry, "redo it", at);
  commitTriage(b.db, at, [], new Map([[b.entry, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));
  const stop = await stoppedAndJudged(b);
  const objectionSelf = rcas(b)[0]!.task;

  expect(() => proposeFromMaterial(b.db, objectionSelf.id, { path: "p", title: "t", text: "x", material_id: stop }, { workspace: { name: "charts" } }, "deckhand", at)).toThrow(
    `entry ${stop} is not a decision-log entry of your parent task`,
  );
});

/** setup: 起草 client と盤面の workspace を足した deps(ADR 0310 決定4 の起草)。 */
function withDrafter(b: ReturnType<typeof fixture>, extra: Partial<RetrospectiveCallDeps> = {}) {
  const drafter = new FakeBehaviorDraftClient();
  drafter.scriptStopDraft({ path: "workspace/scope", title: "Stay inside the workspace", text: "Never delete outside the workspace.", addressee: "worker" });
  return { drafter, deps: { ...b.deps, behaviorDraftClient: drafter, workspace: { name: "charts" }, ...extra } };
}

it.each([
  { addressee: "worker" as const, expected: "deckhand" },
  { addressee: "all" as const, expected: null },
])("a preference stop judgment drafts a Behavior candidate from the stop input with the INDEX, sourced from the judgment, scoped as the stopped task, addressed to $expected; a later sweep does not draft again", async ({ addressee, expected }) => {
  const b = fixture();
  b.client.scriptStopJudgment({ cause: "preference", evidence: "the human wanted the fixtures kept" });
  const { drafter, deps } = withDrafter(b);
  drafter.scriptStopDraft({ path: "build", title: "Keep fixtures", text: "Keep the fixtures.", addressee });
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();

  await b.sweep(at, deps);
  await b.sweep(at, deps);

  expect(drafter.stopCalls.map((c) => c.input)).toEqual([
    { human_stop: { reason: "deleting unrelated files" }, decision_log: ["deleted the fixtures"], memory_read: [], agent_definition: null, actions: null, index: null },
  ]);
  expect(listMemoryEntries(b.db, {})).toEqual([
    expect.objectContaining({
      kind: "behavior", state: "candidate", path: "build", title: "Keep fixtures", text: "Keep the fixtures.",
      scope: "charts", addressee: expected, source: { kind: "event", ref: b.judgments()[0]!.id }, cause: "preference",
    }),
  ]);
});

it.each([
  { board: "without the session's worker in its registry", extra: { agentRegistered: () => false } },
  { board: "without a workspace for the stopped task", extra: { workspace: undefined } },
])("a preference stop judgment drafts nothing on a board $board", async ({ extra }) => {
  const b = fixture();
  b.client.scriptStopJudgment({ cause: "preference", evidence: "e" });
  const { drafter, deps } = withDrafter(b, extra);
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();

  await b.sweep(at, deps);

  expect(drafter.stopCalls).toEqual([]);
  expect(listEvents(b.db, b.task.id).some((e) => e.kind === "memory_draft_failed")).toBe(false);
});

/** setup: 初回を `uncertain` で判定させ、立った self / auditor RCA と、RCA を停止1つを覆う所見で完了させる口を返す。 */
async function judgedUncertain(b: ReturnType<typeof fixture>) {
  b.client.scriptStopJudgment({ cause: "uncertain", evidence: "cannot tell from the log" });
  const stop = await stoppedAndJudged(b);
  const [self, auditor] = rcas(b).map((r) => r.task);
  const settle = (rca: Task, root_cause: string) => completeRca(b.db, rca, { findings: [{ material: [stop], root_cause, no_act: true }] }, "deckhand", at, "worker");
  return { stop, self: self!, auditor: auditor!, settle };
}

it.each([
  { cause: "capability" as const, candidates: 1, drafts: "a Behavior candidate from the findings" },
  { cause: "requirement_change" as const, candidates: 0, drafts: "nothing" },
])("an uncertain stop judgment gets its second round with rca_findings once every RCA on the stop settles, beside the initial; a $cause second round drafts $drafts", async ({ cause, candidates }) => {
  const b = fixture();
  const { stop, self, auditor, settle } = await judgedUncertain(b);
  const { drafter, deps } = withDrafter(b);
  b.client.scriptStopJudgment({ cause, evidence: "the RCAs found the worker removed ../other" });

  settle(self, "ignored the workspace boundary");
  await b.sweep(at, deps);
  expect(b.client.stopCalls).toHaveLength(1);

  settle(auditor, "no guard on rm");
  await b.sweep(at, deps);
  await b.sweep(at, deps);

  const initialInput = { human_stop: { reason: "deleting unrelated files" }, decision_log: ["deleted the fixtures"], memory_read: [], agent_definition: null, actions: null };
  const findings = [
    `no_act: stop ${stop} — ignored the workspace boundary`,
    "completion report: (no outcome recorded)",
    `no_act: stop ${stop} — no guard on rm`,
    "completion report: (no outcome recorded)",
  ];
  expect(b.stopInputs()).toEqual([initialInput, { ...initialInput, rca_findings: findings }]);
  expect(b.judged()).toEqual([
    { kind: "stop_attributed", stop_event_id: stop, cause: "uncertain", evidence: "cannot tell from the log", wrong_memory_entries: null, round: "initial" },
    { kind: "stop_attributed", stop_event_id: stop, cause, evidence: "the RCAs found the worker removed ../other", wrong_memory_entries: null, round: "after_rca" },
  ]);
  expect(drafter.stopCalls.map((c) => c.input)).toEqual(Array(candidates).fill({ ...initialInput, rca_findings: findings, index: null }));
  expect(listMemoryEntries(b.db, {}).map((m) => ({ source: m.source, addressee: m.addressee, cause: m.cause }))).toEqual(
    Array(candidates).fill({ source: { kind: "event", ref: b.judgments()[1]!.id }, addressee: "deckhand", cause }),
  );
});

it("a second-round uncertain stop judgment is final and is never fired again", async () => {
  const b = fixture();
  const { self, auditor, settle } = await judgedUncertain(b);
  settle(self, "r");
  settle(auditor, "r");

  for (const hour of [0, 1, 2]) await b.sweep(new Date(at.getTime() + hour * HOUR));

  expect(b.client.stopCalls).toHaveLength(2);
  expect(b.judged().map((j) => [j.cause, j.round])).toEqual([["uncertain", "initial"], ["uncertain", "after_rca"]]);
});

it("a failing second round counts only the failures after the initial judgment, then halts as the stop's row", async () => {
  const b = fixture();
  const sweepAt = (hour: number) => b.sweep(new Date(at.getTime() + hour * HOUR));
  b.client.scriptStopJudgment(new Error("CLI exited 1"));
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();
  for (const hour of [0, 1]) await sweepAt(hour);
  b.client.scriptStopJudgment({ cause: "uncertain", evidence: "cannot tell" });
  await sweepAt(2);
  for (const rca of rcas(b)) completeRca(b.db, rca.task, { findings: [{ material: [b.stopEvent().id], root_cause: "r", no_act: true }] }, "deckhand", at, "worker");
  b.client.scriptStopJudgment(new Error("CLI exited 2"));

  for (const hour of [3, 4, 5, 6]) await sweepAt(hour);

  expect(b.client.stopCalls).toHaveLength(6);
  expect(listHaltedRefires(b.db)).toEqual([
    {
      refire: "stop_attribution",
      target: b.stopEvent().id,
      stop: { reason: "deleting unrelated files" },
      task: { id: b.task.id, title: "parser" },
      last_failure: { reason: "Board call failed: CLI exited 2", at: new Date(at.getTime() + 5 * HOUR).toISOString() },
    },
  ]);
});

it("a failing draft from a stop judgment leaves failure events naming the stop, not an entry, halts after 3 as a stop row, and Retry / Dismiss act on it", async () => {
  const b = fixture();
  b.client.scriptStopJudgment({ cause: "preference", evidence: "e" });
  const { drafter, deps } = withDrafter(b);
  drafter.scriptStopDraft(new Error("CLI exited 1"));
  recordHumanStop(b.db, b.task.id, "deleting unrelated files", at, "webui");
  b.exit();
  const sweepAt = (hour: number) => b.sweep(new Date(at.getTime() + hour * HOUR), deps);
  for (const hour of [0, 1, 2, 3]) await sweepAt(hour);
  const judgment = b.judgments()[0]!.id;

  expect(drafter.stopCalls).toHaveLength(3);
  expect(listEvents(b.db, b.task.id).filter((e) => e.kind === "memory_draft_failed").map((e) => e.payload)).toEqual(
    Array(3).fill({ kind: "memory_draft_failed", stop_event_id: b.stopEvent().id, round: "initial", attribution_event_id: judgment, reason: "CLI exited 1" }),
  );
  expect(listHaltedRefires(b.db)).toEqual([
    {
      refire: "draft",
      target: judgment,
      stop: { reason: "deleting unrelated files" },
      cause: "preference",
      round: "initial",
      task: { id: b.task.id, title: "parser" },
      last_failure: { reason: "CLI exited 1", at: new Date(at.getTime() + 2 * HOUR).toISOString() },
    },
  ]);

  markHaltedRefire(b.db, "refire_retried", { refire: "draft", target: judgment }, "webui", at);
  await sweepAt(4);
  expect(drafter.stopCalls).toHaveLength(4);

  for (const hour of [5, 6]) await sweepAt(hour);
  markHaltedRefire(b.db, "refire_dismissed", { refire: "draft", target: judgment }, "webui", at);
  await sweepAt(7);
  expect(drafter.stopCalls).toHaveLength(6);
  expect(listHaltedRefires(b.db)).toEqual([]);
});

it("after the second round the stop is read by its second judgment: the history's stop row, the learner's negative signal, the memory meta-review material and the case of a candidate drafted from it; the initial judgment stays", async () => {
  const b = fixture();
  const { self, auditor, settle } = await judgedUncertain(b);
  const outcome = () => loadEpisodes(b.db).find((e) => e.worker_spawned_event_id === b.spawned)?.outcome;
  const outcomeBefore = outcome();
  const { drafter, deps } = withDrafter(b);
  b.client.scriptStopJudgment({ cause: "capability", evidence: "the RCAs found the worker removed ../other" });
  settle(self, "r");
  settle(auditor, "r");

  await b.sweep(at, deps);

  const [initial, second] = b.judgments();
  expect(drafter.stopCalls).toHaveLength(1);
  expect(taskHistoryRows(b.db, b.task.id).find((r) => "stopped_by_human" in r.entry)?.entry).toEqual({
    stopped_by_human: { reason: "deleting unrelated files", cause: "capability", evidence: "the RCAs found the worker removed ../other" },
  });
  expect({ before: outcomeBefore, after: outcome() }).toEqual({ before: "excluded", after: "rejected" });
  expect(materialEvents(b.db, META_REVIEW_SUBJECTS.memory.material, { after: initial!.id }).map((e) => e.id)).toContain(second!.id);
  const [candidate] = listMemoryEntries(b.db, {});
  approveMemoryProposal(b.db, { kind: "memory", op: "approve", candidate_id: candidate!.id, replaces: [] }, "approval", "webui", at);
  expect(readMemory(b.db, { taskId: b.task.id, scope: "charts", agent: "deckhand" }, { ids: [candidate!.id] }, at).entries[0]?.case).toEqual({
    decisions: ["deleted the fixtures"], handoff: null, result: null, human_stop: { reason: "deleting unrelated files" },
  });
  expect(b.judged().map((j) => j.cause)).toEqual(["uncertain", "capability"]);
});
