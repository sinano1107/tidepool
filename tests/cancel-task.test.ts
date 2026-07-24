import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  HOUR,
  mcpClient,
  registerQuestion,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function addChild(t: Tidepool, parentId: string, title: string, assignee?: string): Promise<any> {
  return (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title,
      purpose: "p",
      completion_criteria: "c",
      parent_id: parentId,
      ...(assignee !== undefined && { assignee }),
    })
  ).json;
}

it("直接 cancel は対象と未決着の子孫を一括で cancelled にし、done の子孫は残す", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "plan");
  const doneChild = await addChild(t, parent.id, "already done", "human");
  const todoChild = await addChild(t, parent.id, "still open", "human");
  const grandchild = await addChild(t, todoChild.id, "grandchild", "human");

  // settle one branch (a human-assignee task completes with no handoff required)
  await api(t.baseUrl, "POST", `/api/tasks/${doneChild.id}/complete`, { handoff: FULL_HANDOFF });

  const res = await api(t.baseUrl, "POST", `/api/tasks/${parent.id}/cancel`, {});
  expect(res.status).toBe(200);

  const get = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json.status;
  expect(await get(parent.id)).toBe("cancelled");
  expect(await get(todoChild.id)).toBe("cancelled");
  expect(await get(grandchild.id)).toBe("cancelled");
  expect(await get(doneChild.id)).toBe("done"); // a completed record is never degraded
});

it("cancelled のツリーは即時にボードから退く", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "doomed");
  await addChild(t, parent.id, "child", "human");

  await api(t.baseUrl, "POST", `/api/tasks/${parent.id}/cancel`, {});

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.id === parent.id)).toBeUndefined();
});

it("理由は任意 — 付ければ cancelled イベントに残る", async () => {
  t = await bootTidepool();
  const withReason = await registerWork(t, "with reason");
  const without = await registerWork(t, "without reason");

  await api(t.baseUrl, "POST", `/api/tasks/${withReason.id}/cancel`, { reason: "changed my mind" });
  await api(t.baseUrl, "POST", `/api/tasks/${without.id}/cancel`, {});

  const ev1 = (await api(t.baseUrl, "GET", `/api/tasks/${withReason.id}/events`)).json.find(
    (e: any) => e.kind === "task_cancelled_directly",
  );
  expect(ev1.payload.reason).toBe("changed my mind");

  const ev2 = (await api(t.baseUrl, "GET", `/api/tasks/${without.id}/events`)).json.find(
    (e: any) => e.kind === "task_cancelled_directly",
  );
  expect(ev2.payload.reason).toBe(null);
});

it("agent が decompose で登録した子タスクの直接 cancel は拒否される(対象は人間登録のみ)", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR);
  const mcp = await mcpClient(t.mcpBaseUrl, parent.id);
  await mcp.callTool({
    name: "decompose",
    arguments: {
      reason: "split",
      children: [{ title: "agent child", purpose: "p", completion_criteria: "c" }],
    },
  });
  await mcp.close();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  const agentChild = board.find((x: any) => x.title === "agent child");

  const res = await api(t.baseUrl, "POST", `/api/tasks/${agentChild.id}/cancel`, {});
  expect(res.status).toBe(400);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${agentChild.id}`)).json.status).not.toBe(
    "cancelled",
  );
});

it("実行中(他人)のタスクの直接 cancel は拒否される", async () => {
  t = await bootTidepool();
  const running = await registerWork(t, "running");
  await t.clock.advance(HOUR); // the only todo — picked up into the slot

  const res = await api(t.baseUrl, "POST", `/api/tasks/${running.id}/cancel`, {});
  expect(res.status).toBe(400);
});

it("実行中なら自分(assignee: human)のタスクでも直接 cancel は拒否される(cancel の線も「実行中でない」)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "my own task", undefined, undefined, "human");
  const db = openDb(join(t.dir, "board.sqlite"));
  db.prepare("UPDATE tasks SET status = 'in_progress' WHERE id = ?").run(task.id);
  db.close();

  const res = await api(t.baseUrl, "POST", `/api/tasks/${task.id}/cancel`, {});
  expect(res.status).toBe(400);
});

it("そのタスクを主題とする未回答の failure question が開いている間は直接 cancel 不可", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "failed task");
  // a Tidepool-name failure question sitting on the task (retry / abandon)
  registerQuestion(t, {
    title: "failure",
    purpose: "the task failed",
    completion_criteria: "a human answers",
    parent_id: task.id,
    question: [{ title: "retry or abandon?", options: ["retry", "abandon"], recommendation: "retry" }],
    cancel_option: "abandon",
  });

  const res = await api(t.baseUrl, "POST", `/api/tasks/${task.id}/cancel`, {});
  expect(res.status).toBe(400);
  // still unsettled — the cancel didn't go through (its raw status is todo,
  // presented as blocked by the open question child)
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).not.toBe("cancelled");
});

it("そのタスクの資源に対する未回答の quarantine 確認が開いている間は直接 cancel 不可", async () => {
  t = await bootTidepool({ workspace: { name: "home", path: "/fake/home" } });
  const task = await registerWork(t, "on home workspace"); // inherits default workspace "home"

  // an open quarantine Confirmation for the workspace the task resolves to
  registerQuestion(t, {
    title: "workspace home needs human",
    purpose: "tree rule failed",
    completion_criteria: "repaired by hand",
    question: [{ title: "repaired?", options: ["repaired by hand"], recommendation: "repaired by hand" }],
    quarantine_workspace: "home",
  });

  const res = await api(t.baseUrl, "POST", `/api/tasks/${task.id}/cancel`, {});
  expect(res.status).toBe(400);
});
