import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { BOARD_WORKER_ID, registerTask } from "../src/tasks.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("get_current_task exposes the current task's decisions as a chronological history", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "chart the shoals");
  await t.clock.advance(HOUR);

  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    await client.callTool({
      name: "log_decision",
      arguments: { line: "sound the western channel before plotting the route" },
    });

    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.history).toEqual([
      {
        decision: "sound the western channel before plotting the route",
        children: [],
      },
    ]);
    expect(payload.children).toBeUndefined();
    expect(payload.decision_log).toBeUndefined();
  } finally {
    await client.close();
  }
});

it("a resumed parent history carries every field of a done question child", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "choose a harbor");
  await t.clock.advance(HOUR);
  const questions = [
    {
      title: "which harbor?",
      detail: "compare shelter as well as distance",
      options: ["north", "south"],
      recommendation: "north",
    },
  ];

  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "escalate",
    arguments: { context: "the route depends on human preference", questions },
  });
  await parentClient.close();
  const question = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.type === "question" && task.parent_id === parent.id,
  );
  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answers: ["south"],
    comment: "the southern harbor has repair facilities",
  });

  const resumedClient = await mcpClient(t.mcpBaseUrl, parent.id);
  try {
    const result: any = await resumedClient.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.history).toEqual([
      {
        child_outside_the_decomposition: {
          title: "which harbor?",
          purpose: "the route depends on human preference",
          completion_criteria: "a human answer is recorded",
          status: "done",
          items: questions,
          answer: ["south"],
          comment: "the southern harbor has repair facilities",
        },
      },
    ]);
  } finally {
    await resumedClient.close();
  }
});

it("a child sees every sibling in registration-event order under its decision, including itself as you", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "survey the harbor");
  await t.clock.advance(HOUR);

  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "decompose",
    arguments: {
      reason: "depth and current can be measured independently",
      children: [
        {
          title: "measure depth",
          purpose: "find the safe channel",
          completion_criteria: "depth readings cover every waypoint",
        },
        {
          title: "measure current",
          purpose: "predict vessel drift",
          completion_criteria: "current vectors cover every waypoint",
        },
      ],
    },
  });
  await parentClient.close();

  const current = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (task: any) => task.title === "measure current",
  );
  await api(t.baseUrl, "POST", `/api/tasks/${current.id}/move`, { after: null });
  await t.clock.advance(HOUR);
  const clientTask = t.worker.started.at(-1)!;
  const client = await mcpClient(t.mcpBaseUrl, clientTask.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.parent.history).toEqual([
      {
        decision: "depth and current can be measured independently",
        children: [
          {
            title: "measure depth",
            purpose: "find the safe channel",
            completion_criteria: "depth readings cover every waypoint",
            status: "todo",
          },
          {
            title: "measure current",
            purpose: "predict vessel drift",
            completion_criteria: "current vectors cover every waypoint",
            status: "in_progress",
            you: true,
          },
        ],
      },
    ]);
  } finally {
    await client.close();
  }
});

it("history orders decisions, completion, and children outside decomposition by event id", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "publish the harbor chart", undefined, true);
  await t.clock.advance(HOUR);

  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "log_decision",
    arguments: { line: "publish soundings in fathoms" },
  });
  await parentClient.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await parentClient.close();

  await t.clock.advance(HOUR);
  const review = t.worker.started.at(-1)!;
  const client = await mcpClient(t.mcpBaseUrl, review.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.parent.history).toEqual([
      { decision: "publish soundings in fathoms", children: [] },
      { completion: FULL_HANDOFF.outcome },
      {
        child_outside_the_decomposition: {
          title: "review: publish the harbor chart",
          purpose:
            'read-only review of "publish the harbor chart"\'s deliverable against its completion criteria',
          completion_criteria:
            "findings are read-only — issues land as repair tasks for the original assignee",
          status: "in_progress",
          you: true,
        },
      },
    ]);
    expect(JSON.stringify(payload.parent.history)).not.toContain("created_at");
  } finally {
    await client.close();
  }
});

it("a resumed parent history carries a done work child's full handoff document", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "assemble the sailing directions");
  await t.clock.advance(HOUR);

  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({
    name: "decompose",
    arguments: {
      reason: "verify the entrance before assembling the directions",
      children: [
        {
          title: "verify the entrance",
          purpose: "establish the safe approach",
          completion_criteria: "the approach is verified",
        },
      ],
    },
  });
  await parentClient.close();

  await t.clock.advance(HOUR);
  const child = t.worker.started.at(-1)!;
  const childClient = await mcpClient(t.mcpBaseUrl, child.id);
  await childClient.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await childClient.close();

  await t.clock.advance(HOUR);
  const resumedClient = await mcpClient(t.mcpBaseUrl, parent.id);
  try {
    const result: any = await resumedClient.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.history[0].children[0]).toEqual({
      title: "verify the entrance",
      purpose: "establish the safe approach",
      completion_criteria: "the approach is verified",
      status: "done",
      handoff_doc:
        "## Outcome vs completion criteria\n\n" +
        "done as specified\n\n" +
        "## Deliverable locations\n\n" +
        "n/a\n\n" +
        "## Key decision-log references\n\n" +
        "n/a\n\n" +
        "## Dead ends tried\n\n" +
        "n/a\n\n" +
        "## Context needed to resume\n\n" +
        "n/a\n\n" +
        "## Known issues not worth a task\n\n" +
        "n/a",
    });
  } finally {
    await resumedClient.close();
  }
});

it("a work child of a done parent receives the parent's handoff document", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "publish the pilot book");
  await t.clock.advance(HOUR);
  const parentClient = await mcpClient(t.mcpBaseUrl, parent.id);
  await parentClient.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await parentClient.close();

  const db = openDb(join(t.dir, "board.sqlite"));
  const repair = registerTask(
    db,
    {
      type: "work",
      title: "repair the pilot book",
      purpose: "correct the objected directions",
      completion_criteria: "the directions reflect the objection",
      parent_id: parent.id,
    },
    t.clock.now(),
    BOARD_WORKER_ID,
  );
  db.close();

  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, repair.id);
  try {
    const result: any = await client.callTool({ name: "get_current_task", arguments: {} });
    const payload = JSON.parse(result.content[0].text);
    expect(payload.parent.handoff_doc).toContain("## Outcome vs completion criteria");
    expect(payload.parent.handoff_doc).toContain(FULL_HANDOFF.outcome);
  } finally {
    await client.close();
  }
});

it("get_current_task describes how to read history in exactly three English sentences", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "read the briefing");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "get_current_task")?.description).toBe(
      "Fetch the context of the task occupying the slot, reading history from top to bottom " +
        "in chronological order. A decision's children are the tasks registered based on that " +
        "decision. A child_outside_the_decomposition is based on no decomposition decision, " +
        "such as a repair task from a human objection, this task's own escalation, or a " +
        "watchdog failure question.",
    );
  } finally {
    await client.close();
  }
});
