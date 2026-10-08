import { afterEach, expect, it } from "vitest";
import { registerTask } from "../src/tasks.js";
import { api, bootTidepool, HOUR, HUMAN_WEBUI, mcpClient, registerWork, type Tidepool } from "./harness.js";

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
  const task = registerTask(
    t.db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    github_issue_number: 50,
  });

  expect(res.status).toBe(400);
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
  const task = registerTask(
    t.db,
    { type: "work", workspace: "tidepool", github_issue_number: 49 },
    t.clock.now(),
    ...HUMAN_WEBUI,
  );

  const content = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    title: "override the issue title",
  });
  expect(content.status).toBe(400);

  const ws = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    workspace: "tidepool",
  });
  expect(ws.status).toBe(400);
});

it.each(["ghost", "human"])(
  "review_by の編集で %s を指名すると registry の検査で 400 になり、値は変わらない(#1498)",
  async (reviewer) => {
    t = await bootTidepool({ agentRegistered: (name) => name === "security" });
    const task = registerTask(
      t.db,
      { type: "work", title: "named", purpose: "p", completion_criteria: "c", review_by: ["security"] },
      t.clock.now(),
      ...HUMAN_WEBUI,
    );

    const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_by: ["security", reviewer] });

    expect(res.status).toBe(400);
    const after = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
    expect(after.review_by).toEqual(["security"]);
  },
);

it("存在しないタスクへの編集は 404", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "PATCH", "/api/tasks/no-such-task", { title: "x" });
  expect(res.status).toBe(404);
});
