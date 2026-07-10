import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const decomposition = {
  reason: "the parser and the printer are independent; splitting them derisks both",
  children: [
    {
      title: "build the lexer",
      purpose: "tokens for the parser",
      completion_criteria: "lexer passes the token fixtures",
    },
    {
      title: "build the printer",
      purpose: "render the tree back to text",
      completion_criteria: "round-trips the fixtures",
    },
  ],
};

it("decompose queues the children at the tail, blocks the parent, and releases the slot", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "build the toolchain");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({ name: "decompose", arguments: decomposition });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  // children joined the queue tail in the given order, linked to the parent
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.map((x: any) => x.title)).toEqual([
    "build the toolchain",
    "build the lexer",
    "build the printer",
  ]);
  const children = board.filter((x: any) => x.parent_id === parent.id);
  expect(children).toHaveLength(2);
  expect(children.every((x: any) => x.status === "todo" && x.type === "work")).toBe(true);

  // the parent is blocked (derived), so the freed slot goes to the first child
  expect(board[0].status).toBe("blocked");
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.title)).toEqual([
    "build the toolchain",
    "build the lexer",
  ]);
});

it("decompose stamps each child with the registering worker and the decision it rests on", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "build the toolchain");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, parent.id);
  await client.callTool({ name: "decompose", arguments: decomposition });
  await client.close();

  // the reason itself is a decision-log entry on the parent
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const decisions = log.entries.filter((e: any) => e.kind === "decision_logged");
  expect(decisions).toHaveLength(1);
  expect(decisions[0].task_id).toBe(parent.id);
  expect(decisions[0].payload.line).toBe(decomposition.reason);

  // every child records who registered it and which decision it rests on
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const children = board.filter((x: any) => x.parent_id === parent.id);
  expect(children).toHaveLength(2);
  for (const child of children) {
    const events = (await api(t.baseUrl, "GET", `/api/tasks/${child.id}/events`)).json;
    const registered = events.filter((e: any) => e.kind === "task_registered");
    expect(registered).toHaveLength(1);
    expect(registered[0].worker_id).toBe("fake-worker");
    expect(registered[0].payload.based_on_decision).toBe(decisions[0].id);
  }
});

/** Complete the slot task via MCP with a full work handoff. */
async function completeVia(t: Tidepool, taskId: string, deliverables = "the code") {
  const client = await mcpClient(t.baseUrl, taskId);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: {
      handoff: {
        outcome: "criteria met",
        deliverables,
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
    },
  });
  await client.close();
  return res;
}

it("when every child is done the parent resumes and completes by decomposition", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "build the toolchain");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, parent.id);
  await client.callTool({ name: "decompose", arguments: decomposition });
  await client.close();
  const other = await registerWork(t, "unrelated work"); // queued behind the children

  // the children run in order while the parent stays blocked
  await t.clock.advance(HOUR);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const [lexer, printer] = board.filter((x: any) => x.parent_id === parent.id);
  await completeVia(t, lexer.id);
  await t.clock.advance(HOUR);
  await completeVia(t, printer.id);

  // the last child's completion unblocks the parent, which resumes ahead of
  // later-registered work for integration
  await t.clock.advance(HOUR);
  expect(t.worker.started.map((x) => x.title)).toEqual([
    "build the toolchain",
    "build the lexer",
    "build the printer",
    "build the toolchain",
  ]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${other.id}`)).json.status).toBe("todo");

  // decompose-completion: the child list + reason land in the deliverables field
  const res = await completeVia(
    t,
    parent.id,
    `decomposed into: build the lexer, build the printer — ${decomposition.reason}`,
  );
  expect(res.isError ?? false).toBe(false);
  const done = (await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json;
  expect(done.status).toBe("done");
  expect(done.handoff_doc).toContain("build the lexer");
});

it("a task with an unfinished child cannot complete — completion criteria cover the whole", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "build the toolchain");
  await t.clock.advance(HOUR); // parent picked up into the slot
  // a child appears through the human door while the agent is mid-session
  await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "handle the edge case first",
    purpose: "found while reviewing",
    completion_criteria: "edge case covered",
    parent_id: parent.id,
  });

  const res = await completeVia(t, parent.id);
  expect(res.isError).toBe(true);

  // the parent kept the slot and its status
  expect((await api(t.baseUrl, "GET", `/api/tasks/${parent.id}`)).json.status).toBe(
    "in_progress",
  );
});

it("a completion flows through the log as its own kind, carrying the one-line outcome", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "build the parser");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, task.id);
  await client.callTool({
    name: "log_decision",
    arguments: { line: "kept the grammar LL(1)" },
  });
  await client.close();
  await completeVia(t, task.id);

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  // both entry kinds interleave in event order; the kind is what tells a
  // completion apart from an ordinary decision line
  expect(log.entries.map((e: any) => e.kind)).toEqual(["decision_logged", "task_completed"]);
  const completion = log.entries[1];
  expect(completion.task_id).toBe(task.id); // the link back to the handoff doc
  expect(completion.worker_id).toBe("fake-worker");
  expect(completion.payload.result).toBe("criteria met");
});

it("the log keeps a read cursor that only ever advances", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "build the parser");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, task.id);
  await client.callTool({ name: "log_decision", arguments: { line: "first decision" } });
  await client.callTool({ name: "log_decision", arguments: { line: "second decision" } });
  await client.close();

  // everything starts unread
  const before = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(before.cursor).toBe(0);
  const [first, second] = before.entries;

  const set = await api(t.baseUrl, "POST", "/api/log/cursor", { last_read: second.id });
  expect(set.status).toBe(200);
  expect((await api(t.baseUrl, "GET", "/api/log")).json.cursor).toBe(second.id);

  // a stale writer (e.g. an old tab) cannot move the cursor backwards
  await api(t.baseUrl, "POST", "/api/log/cursor", { last_read: first.id });
  expect((await api(t.baseUrl, "GET", "/api/log")).json.cursor).toBe(second.id);
});

it("the log is a filtered view of the event stream, not a copy in its own table", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "build the parser");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, task.id);
  await client.callTool({ name: "log_decision", arguments: { line: "kept the grammar LL(1)" } });
  await client.close();
  await completeVia(t, task.id);

  // the same records, byte for byte — same ids, same payloads, same timestamps
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  const humanFacing = events.filter((e: any) =>
    ["decision_logged", "task_completed"].includes(e.kind),
  );
  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries).toEqual(humanFacing);
  expect(humanFacing.length).toBeGreaterThan(0);
});

it("decompose refuses an empty child list and leaves the parent in the slot", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "build the toolchain");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: { reason: "no children at all", children: [] },
  });
  expect(res.isError).toBe(true);
  await client.close();

  // nothing was logged or registered, and the parent kept the slot
  expect((await api(t.baseUrl, "GET", "/api/log")).json.entries).toEqual([]);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board).toHaveLength(1);
  expect(board[0].status).toBe("in_progress");
});

it("log_decision records a one-line decision that appears in the log view", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "build the parser");
  await t.clock.advance(HOUR); // picked up into the slot
  const client = await mcpClient(t.baseUrl, task.id);
  const res: any = await client.callTool({
    name: "log_decision",
    arguments: { line: "chose recursive descent over a parser generator: no new build dep" },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const decisions = log.entries.filter((e: any) => e.kind === "decision_logged");
  expect(decisions).toHaveLength(1);
  expect(decisions[0].task_id).toBe(task.id);
  expect(decisions[0].worker_id).toBe("fake-worker");
  expect(decisions[0].payload.line).toBe(
    "chose recursive descent over a parser generator: no new build dep",
  );
});
