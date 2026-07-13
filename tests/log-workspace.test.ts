import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { api, bootTidepool, HOUR, makeWorkspace, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

it("a log entry from a task registered against a named workspace carries that workspace name", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "build the parser", "alpha");
  await t.clock.advance(HOUR); // picked up into the slot
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "log_decision", arguments: { line: "kept the grammar LL(1)" } });
  await client.close();

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries[0].workspace).toBe("alpha");
});

it("a log entry from a task with no named workspace falls back to the board's default", async () => {
  const board = await makeWorkspace(dirs, "board-default");
  t = await bootTidepool({ workspace: board });
  const task = await registerWork(t, "build the parser"); // no workspace named
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "log_decision", arguments: { line: "kept the grammar LL(1)" } });
  await client.close();

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries[0].workspace).toBe(board.name);
});

it("a log entry stays workspace-less when neither the task nor the board names one", async () => {
  t = await bootTidepool(); // no board workspace configured at all
  const task = await registerWork(t, "build the parser");
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "log_decision", arguments: { line: "kept the grammar LL(1)" } });
  await client.close();

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries[0].workspace).toBeNull();
});
