import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, managementMcpClient, queueWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("HTTP maps a blank edit to 400 and passes normalized registration content through", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "editable");
  expect((await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { title: "   " })).status).toBe(400);
  const saved = await api(t.baseUrl, "POST", "/api/tasks", { type: "work", title: " foo ", purpose: "p", completion_criteria: "c" });
  expect(saved.status).toBe(201);
  expect(saved.json.title).toBe("foo");
});

it("MCP rejects blank registration and delivers parsed text to the register_task handler", async () => {
  const resolved: string[] = [];
  t = await bootTidepool({ agentRegistered: (name) => { resolved.push(name); return name === "security"; } });
  const client = await managementMcpClient(t.baseUrl);
  try {
    const input = { type: "work", title: "   ", purpose: "p", completion_criteria: "c" };
    expect((await client.callTool({ name: "register_task", arguments: input })).isError).toBe(true);
    const saved = await client.callTool({ name: "register_task", arguments: { ...input, title: " foo ", review_by: [" security "] } });
    expect(saved.isError).toBeFalsy();
    // review_by is checked by the injected registry seam before registration, so domain title trimming cannot mask raw callback args.
    expect(resolved).toContain("security");
    expect(resolved).not.toContain(" security ");
    const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
    expect(board.find((task: any) => task.title === "foo")).toBeDefined();
  } finally {
    await client.close();
  }
});
