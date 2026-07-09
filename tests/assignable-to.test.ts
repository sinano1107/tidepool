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

it("decompose converts a child assigned outside assignable_to into an approval question instead of registering it", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", assignable_to: ["deckhand"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "the specialist agent should own this one",
      children: [
        {
          title: "tune the database indexes",
          purpose: "improve query latency",
          completion_criteria: "p95 query latency under 100ms",
          assignee: "dba-specialist",
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  // the child never lands as a work task while its assignee is unapproved
  expect(board.find((x: any) => x.title === "tune the database indexes")).toBeUndefined();

  // an approval question stands in its place instead
  const question = board.find((x: any) => x.type === "question" && x.parent_id === parent.id);
  expect(question).toBeDefined();
  expect(question.question_options).toEqual(["approve", "reject"]);
  expect(question.question_recommendation).toBe("approve");

  // the parent is blocked on that question (derived from the unfinished child)
  expect(board.find((x: any) => x.id === parent.id).status).toBe("blocked");
});

it("a child assigned within assignable_to registers directly, with no approval question", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", assignable_to: ["deckhand"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "deckhand can just take this one",
      children: [
        {
          title: "tidy the changelog",
          purpose: "keep the release notes current",
          completion_criteria: "changelog reflects the last release",
          assignee: "deckhand",
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "tidy the changelog");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.assignee).toBe("deckhand");
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
});

async function decomposeOutOfBoundsAssignee(t: Tidepool, parentId: string) {
  const client = await mcpClient(t.baseUrl, parentId);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "the specialist agent should own this one",
      children: [
        {
          title: "tune the database indexes",
          purpose: "improve query latency",
          completion_criteria: "p95 query latency under 100ms",
          assignee: "dba-specialist",
        },
      ],
    },
  });
  await client.close();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return board.find((x: any) => x.type === "question" && x.parent_id === parentId);
}

it("approving an assignee-approval question registers the pending child with the requested assignee, without touching the parent's risk flag", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", assignable_to: ["deckhand"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await decomposeOutOfBoundsAssignee(t, parent.id);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "approve",
  });
  expect(answered.status).toBe(200);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "tune the database indexes");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.assignee).toBe("dba-specialist");
  expect(child.risk_flag).toBe(0);

  const updatedParent = board.find((x: any) => x.id === parent.id);
  expect(updatedParent.risk_flag).toBe(0);

  const parentEvents = (await api(t.baseUrl, "GET", `/api/tasks/${parent.id}/events`)).json;
  expect(parentEvents.filter((e: any) => e.kind === "risk_flag_raised")).toEqual([]);
});

it("rejecting an assignee-approval question leaves the child unregistered", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", assignable_to: ["deckhand"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await decomposeOutOfBoundsAssignee(t, parent.id);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "reject",
  });
  expect(answered.status).toBe(200);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "tune the database indexes")).toBeUndefined();
});
