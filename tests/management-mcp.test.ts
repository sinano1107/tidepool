import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import {
  bootTidepool,
  managementMcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

function readToolPayload(result: any): unknown {
  return JSON.parse(result.content[0].text);
}

function dumpDb(dbPath: string): unknown {
  const db = openDb(dbPath);
  try {
    const snapshot: Record<string, unknown> = {};
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>) {
      snapshot[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    }
    return snapshot;
  } finally {
    db.close();
  }
}

it("管理MCP 自身は無認証リクエストを 401 で拒否する(issue #191 / ADR 0036)", async () => {
  t = await bootTidepool();
  const res = await fetch(`${t.baseUrl}/admin-mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(401);
});

it("管理MCP の initialize は人間面の義手モデル instructions を返す(issue #191)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect(client.getInstructions()).toContain("You are connected to the Management MCP");
    expect(client.getInstructions()).toContain("question task, which only a human may");
  } finally {
    await client.close();
  }
});

it("管理MCP は5つの純読取 board tool を発見する(issue #191)", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "get_task",
      "list_board",
      "list_queue",
      "list_your_tasks",
      "read_decision_log",
    ]);
  } finally {
    await client.close();
  }
});

it("管理MCP の読取 tool は盤面データを返して DB を変えない(issue #191)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "management MCP read fixture");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const before = dumpDb(join(t.dir, "board.sqlite"));
    const { tools } = await client.listTools();
    const results = await Promise.all(
      tools.map((tool) =>
        client.callTool({
          name: tool.name,
          arguments: tool.name === "get_task" ? { task_id: task.id } : {},
        }),
      ),
    );
    const after = dumpDb(join(t.dir, "board.sqlite"));

    expect(after).toEqual(before);
    const resultByName = new Map(tools.map((tool, index) => [tool.name, results[index]]));
    expect(readToolPayload(resultByName.get("list_board"))).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: task.id, title: task.title })]),
    );
    expect(readToolPayload(resultByName.get("get_task"))).toEqual(
      expect.objectContaining({ id: task.id, events: expect.any(Array) }),
    );
    expect(readToolPayload(resultByName.get("read_decision_log"))).toEqual(
      expect.objectContaining({ entries: expect.any(Array), cursor: expect.any(Number) }),
    );
  } finally {
    await client.close();
  }
});

it("管理MCP は issue-backed content を保存済みプレースホルダーのまま返す(issue #191)", async () => {
  t = await bootTidepool();
  const db = openDb(join(t.dir, "board.sqlite"));
  let issueTask;
  try {
    issueTask = registerTask(
      db,
      { type: "work", workspace: "tidepool", github_issue_number: 49 },
      t.clock.now(),
    );
  } finally {
    db.close();
  }
  const client = await managementMcpClient(t.baseUrl);
  try {
    const result: any = await client.callTool({ name: "list_board", arguments: {} });
    expect(readToolPayload(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: issueTask.id,
          title: "#49",
          github_issue_number: 49,
        }),
      ]),
    );
  } finally {
    await client.close();
  }
});
