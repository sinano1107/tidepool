import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function registerWork(t: Tidepool, title: string) {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
  });
  return res.json;
}

it("decompose converts a child riskier than its parent into an approval question instead of registering it", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "one child touches production data and needs sign-off",
      children: [
        {
          title: "migrate the prod table",
          purpose: "backfill the new column",
          completion_criteria: "backfill script has run against prod",
          risk_flag: true,
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  // the risky child never lands as a work task
  expect(board.find((x: any) => x.title === "migrate the prod table")).toBeUndefined();

  // an approval question stands in its place instead
  const question = board.find((x: any) => x.type === "question" && x.parent_id === parent.id);
  expect(question).toBeDefined();
  expect(question.question_options).toEqual(["approve", "reject"]);
  expect(question.question_recommendation).toBe("approve");

  // the parent is blocked on that question (derived from the unfinished child)
  expect(board.find((x: any) => x.id === parent.id).status).toBe("blocked");
});

async function decomposeRiskyChild(t: Tidepool, parentId: string) {
  const client = await mcpClient(t.baseUrl, parentId);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "one child touches production data and needs sign-off",
      children: [
        {
          title: "migrate the prod table",
          purpose: "backfill the new column",
          completion_criteria: "backfill script has run against prod",
          risk_flag: true,
        },
      ],
    },
  });
  await client.close();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return board.find((x: any) => x.type === "question" && x.parent_id === parentId);
}

it("approving a risk-approval question registers the pending child and raises the parent's risk flag", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await decomposeRiskyChild(t, parent.id);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "approve",
  });
  expect(answered.status).toBe(200);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "migrate the prod table");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.parent_id).toBe(parent.id);
  expect(child.risk_flag).toBe(1);

  const updatedParent = board.find((x: any) => x.id === parent.id);
  expect(updatedParent.risk_flag).toBe(1);
  // the newly-materialized child is itself unfinished, so the parent stays
  // blocked rather than jumping back to the queue head
  expect(updatedParent.status).toBe("blocked");
});

it("approving a risk-approval question records an auditable event on the parent's risk flag raise", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await decomposeRiskyChild(t, parent.id);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "approve" });

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${parent.id}/events`)).json;
  const raised = events.filter((e: any) => e.kind === "risk_flag_raised");
  expect(raised).toHaveLength(1);
  expect(raised[0].payload).toEqual({
    kind: "risk_flag_raised",
    origin_question_id: question.id,
  });
});

it("the child materialized on approval carries the same decision-log provenance as an ordinary decomposed child", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await decomposeRiskyChild(t, parent.id);

  await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answer: "approve" });

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  const decision = log.entries.find((e: any) => e.kind === "decision_logged");
  expect(decision).toBeDefined();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "migrate the prod table");
  const childEvents = (await api(t.baseUrl, "GET", `/api/tasks/${child.id}/events`)).json;
  const registered = childEvents.find((e: any) => e.kind === "task_registered");
  expect(registered.payload.based_on_decision).toBe(decision.id);
});

it("rejecting a risk-approval question leaves the child unregistered and the parent's risk flag untouched", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await decomposeRiskyChild(t, parent.id);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "reject",
  });
  expect(answered.status).toBe(200);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "migrate the prod table")).toBeUndefined();

  const updatedParent = board.find((x: any) => x.id === parent.id);
  expect(updatedParent.risk_flag).toBe(0);
  // no unfinished children remain, so the parent returns to the queue head
  // and the free slot picks it back up at once
  expect(updatedParent.status).toBe("in_progress");
});

/** Complete the slot task via MCP with a full work handoff. */
async function completeVia(t: Tidepool, taskId: string) {
  const client = await mcpClient(t.baseUrl, taskId);
  await client.callTool({
    name: "complete_task",
    arguments: {
      handoff: {
        outcome: "criteria met",
        deliverables: "the migration ran",
        decision_refs: "none",
        dead_ends: "none",
        resume_context: "none",
        known_issues: "none",
      },
    },
  });
  await client.close();
}

it("approving a later, non-risk escalation once the parent is already risky does not re-fire risk_flag_raised", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", assignable_to: ["deckhand"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up

  // first escalation: genuinely raises the parent from risk_flag=0 to 1
  const firstQuestion = await decomposeRiskyChild(t, parent.id);
  await api(t.baseUrl, "POST", `/api/tasks/${firstQuestion.id}/answer`, { answer: "approve" });
  const firstChild = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.title === "migrate the prod table",
  );

  // clear the board of that child so the parent can resume and decompose again
  await t.clock.advance(HOUR); // firstChild picked up
  await completeVia(t, firstChild.id);
  await t.clock.advance(HOUR); // parent resumes and is picked up again

  // second escalation on the now-already-risky parent: assignee-only (the
  // child itself declares risk, but the parent's risk was already raised by
  // the first approval — this approval propagates nothing new)
  const client = await mcpClient(t.baseUrl, parent.id);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "a specialist should also own the follow-up",
      children: [
        {
          title: "verify the migrated data",
          purpose: "spot-check the backfilled rows",
          completion_criteria: "spot-checks pass",
          risk_flag: true,
          assignee: "dba-specialist",
        },
      ],
    },
  });
  await client.close();
  const secondQuestion = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question" && x.status === "todo" && x.parent_id === parent.id,
  );

  await api(t.baseUrl, "POST", `/api/tasks/${secondQuestion.id}/answer`, { answer: "approve" });

  // only the first approval's propagation is on record — the second
  // approval found the parent already risky and raised nothing new
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${parent.id}/events`)).json;
  const raised = events.filter((e: any) => e.kind === "risk_flag_raised");
  expect(raised).toHaveLength(1);
  expect(raised[0].payload.origin_question_id).toBe(firstQuestion.id);
});
