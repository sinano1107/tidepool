import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("実行中(かつ human 自身のタスクでない)親への人間の子追加は 400 で拒否され、子は登録されない", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot (agent, in_progress)

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child",
    purpose: "purpose of child",
    completion_criteria: "criteria of child",
    parent_id: parent.id,
    decompose_reason: "split while the parent is running",
  });

  expect(res.status).toBe(400);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "child")).toBeUndefined();
});

it("agent が既に decompose 済みの親への人間の子追加は 400 で拒否され、子は登録されない(木の組み替えは異議経路の領分)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot

  const mcp = await mcpClient(t.mcpBaseUrl, parent.id);
  await mcp.callTool({
    name: "decompose",
    arguments: {
      reason: "agent split off one piece",
      children: [
        {
          title: "agent's own child",
          purpose: "agent decided this",
          completion_criteria: "done",
        },
      ],
    },
  });
  await mcp.close();
  // parent returns to 'todo' (derived 'blocked' — agent's child unsettled)

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "human's own child",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "split despite the existing agent decision",
  });

  expect(res.status).toBe(400);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "human's own child")).toBeUndefined();
});

it("done/cancelled な親への人間の子追加は 400 で拒否される", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot

  const mcp = await mcpClient(t.mcpBaseUrl, parent.id);
  await mcp.callTool({
    name: "complete_task",
    arguments: {
      handoff: {
        outcome: "done",
        deliverables: "n/a",
        decision_refs: "n/a",
        dead_ends: "n/a",
        resume_context: "n/a",
        known_issues: "n/a",
      },
    },
  });
  await mcp.close();

  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "child of a done task",
    purpose: "purpose",
    completion_criteria: "criteria",
    parent_id: parent.id,
    decompose_reason: "split after completion",
  });

  expect(res.status).toBe(400);
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "child of a done task")).toBeUndefined();
});
