import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("decompose converts a child assigned outside allowed_workspaces into an approval question instead of registering it", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", allowed_workspaces: ["sandbox"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "this piece belongs in the prod checkout",
      children: [
        {
          title: "run the prod migration",
          purpose: "apply the schema change",
          completion_criteria: "schema matches the migration",
          workspace: "prod",
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;

  // the child never lands as a work task while its workspace is unapproved
  expect(board.find((x: any) => x.title === "run the prod migration")).toBeUndefined();

  // an approval question stands in its place instead
  const question = board.find((x: any) => x.type === "question" && x.parent_id === parent.id);
  expect(question).toBeDefined();
  expect(question.question_options).toEqual(["approve", "reject"]);
  expect(question.question_recommendation).toBe("approve");

  // the parent is blocked on that question (derived from the unfinished child)
  expect(board.find((x: any) => x.id === parent.id).status).toBe("blocked");
});

it("a child targeting a workspace within allowed_workspaces registers directly, with no approval question", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", allowed_workspaces: ["sandbox"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.baseUrl, parent.id);
  const res: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "this piece stays in the sandbox checkout",
      children: [
        {
          title: "tidy the sandbox fixtures",
          purpose: "keep the sandbox data current",
          completion_criteria: "fixtures reflect the latest schema",
          workspace: "sandbox",
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "tidy the sandbox fixtures");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.workspace).toBe("sandbox");
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
});

async function decomposeOutOfBoundsWorkspace(t: Tidepool, parentId: string) {
  const client = await mcpClient(t.baseUrl, parentId);
  await client.callTool({
    name: "decompose",
    arguments: {
      reason: "this piece belongs in the prod checkout",
      children: [
        {
          title: "run the prod migration",
          purpose: "apply the schema change",
          completion_criteria: "schema matches the migration",
          workspace: "prod",
        },
      ],
    },
  });
  await client.close();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  return board.find((x: any) => x.type === "question" && x.parent_id === parentId);
}

it("approving a workspace-approval question registers the pending child with the requested workspace, without touching the parent's risk flag", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", allowed_workspaces: ["sandbox"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await decomposeOutOfBoundsWorkspace(t, parent.id);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "approve",
  });
  expect(answered.status).toBe(200);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "run the prod migration");
  expect(child).toBeDefined();
  expect(child.type).toBe("work");
  expect(child.workspace).toBe("prod");
  expect(child.risk_flag).toBe(0);

  const updatedParent = board.find((x: any) => x.id === parent.id);
  expect(updatedParent.risk_flag).toBe(0);

  const parentEvents = (await api(t.baseUrl, "GET", `/api/tasks/${parent.id}/events`)).json;
  expect(parentEvents.filter((e: any) => e.kind === "risk_flag_raised")).toEqual([]);
});

it("rejecting a workspace-approval question leaves the child unregistered", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", allowed_workspaces: ["sandbox"] },
  });
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const question = await decomposeOutOfBoundsWorkspace(t, parent.id);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, {
    answer: "reject",
  });
  expect(answered.status).toBe(200);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "run the prod migration")).toBeUndefined();
});

it("a child with no workspace of its own inherits its parent's workspace, without triggering an approval question", async () => {
  t = await bootTidepool({
    authority: { name: "standard", guidance: "", allowed_workspaces: ["sandbox"] },
  });
  const root = await registerWork(t, "root");
  await t.clock.advance(HOUR); // root picked up

  const rootClient = await mcpClient(t.baseUrl, root.id);
  await rootClient.callTool({
    name: "decompose",
    arguments: {
      reason: "this piece runs in the sandbox checkout",
      children: [
        {
          title: "sandbox child",
          purpose: "set up the sandbox checkout",
          completion_criteria: "sandbox checkout is ready",
          workspace: "sandbox",
        },
      ],
    },
  });
  await rootClient.close();

  await t.clock.advance(HOUR); // sandbox child picked up
  const sandboxChild = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.title === "sandbox child",
  );

  const childClient = await mcpClient(t.baseUrl, sandboxChild.id);
  const res: any = await childClient.callTool({
    name: "decompose",
    arguments: {
      reason: "split the sandbox setup further",
      children: [
        {
          title: "sandbox grandchild",
          purpose: "seed the sandbox fixtures",
          completion_criteria: "fixtures are seeded",
        },
      ],
    },
  });
  expect(res.isError ?? false).toBe(false);
  await childClient.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const grandchild = board.find((x: any) => x.title === "sandbox grandchild");
  expect(grandchild).toBeDefined();
  expect(grandchild.type).toBe("work");
  expect(grandchild.workspace).toBe("sandbox");
  expect(board.filter((x: any) => x.type === "question")).toEqual([]);
});
