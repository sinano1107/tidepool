import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, mcpClient, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

it("編集不可フィールド type を含む編集は 400 で拒否される", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "editable");

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    type: "review",
  });

  expect(res.status).toBe(400);
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(after.type).toBe("work");
});

it("parent link の付け替え(parent_id)を含む編集は 400 で拒否される", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "editable");
  const other = await registerWork(t, "other");

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    parent_id: other.id,
  });

  expect(res.status).toBe(400);
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(after.parent_id).toBe(null);
});

it("issue-backed の参照番号(github_issue_number)の編集は 400 で拒否される", async () => {
  t = await bootTidepool({ workspace: { name: "tidepool", path: "/fake/path" } });
  const db = openDb(join(t.dir, "board.sqlite"));
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );
  db.close();

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    github_issue_number: 50,
  });

  expect(res.status).toBe(400);
});

it("agent が decompose で登録した子タスクの編集は 400 で拒否される(対象は人間登録のみ)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot

  const mcp = await mcpClient(t.mcpBaseUrl, parent.id);
  await mcp.callTool({
    name: "decompose",
    arguments: {
      reason: "agent split off one piece",
      children: [
        { title: "agent's child", purpose: "agent decided this", completion_criteria: "done" },
      ],
    },
  });
  await mcp.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const child = board.find((x: any) => x.title === "agent's child");
  expect(child).toBeDefined();

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${child.id}`, {
    title: "human renames the agent's child",
  });

  expect(res.status).toBe(400);
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${child.id}`)).json;
  expect(after.title).toBe("agent's child");
});

it("実行中(他人)のタスクの編集は 400 で拒否される", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "will run");
  await t.clock.advance(HOUR); // picked up (agent, in_progress)

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    title: "rename mid-flight",
  });

  expect(res.status).toBe(400);
});

it("決着済み(done)のタスクの編集は 400 で拒否される", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "will finish");
  await t.clock.advance(HOUR);

  const mcp = await mcpClient(t.mcpBaseUrl, task.id);
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

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    title: "rename a done task",
  });

  expect(res.status).toBe(400);
});

it("issue-backed タスクの内容(title)と workspace の編集は 400 で拒否される(正本は GitHub / 焼き込み)", async () => {
  t = await bootTidepool({
    workspace: { name: "tidepool", path: "/fake/path" },
    resolveWorkspace: (w) => ({ name: w ?? "tidepool", path: "/fake/path" }),
  });
  const db = openDb(join(t.dir, "board.sqlite"));
  const task = registerTask(
    db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
  );
  db.close();

  const content = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    title: "override the issue title",
  });
  expect(content.status).toBe(400);

  const ws = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    workspace: "tidepool",
  });
  expect(ws.status).toBe(400);
});

it("実行中なら自分(assignee: human)のタスクでも編集は拒否される(編集の線は「実行中でない」— decompose の自タスク例外は継がない)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "my own task", undefined, undefined, "human");
  // no code path drives a human task into in_progress in normal flow, so drive
  // the row directly — the gate reads only the row's fields (same technique as
  // tests/human-decompose-own-task.test.ts)
  const db = openDb(join(t.dir, "board.sqlite"));
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
  db.close();

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { title: "rename my own" });
  expect(res.status).toBe(400);
});

it("存在しないタスクへの編集は 404", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "PATCH", "/api/tasks/no-such-task", { title: "x" });
  expect(res.status).toBe(404);
});
