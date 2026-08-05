import { afterEach, expect, it } from "vitest";
import { UnknownWorkspaceError } from "../src/workspace.js";
import { api, bootTidepool, registerWork, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function events(t: Tidepool, id: string): Promise<any[]> {
  return (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json;
}

it("人間登録タスクの title / purpose / completion criteria を編集でき、旧値がイベント履歴に残る", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "before");

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, {
    title: "after",
    purpose: "new purpose",
    completion_criteria: "new criteria",
  });

  expect(res.status).toBe(200);
  expect(res.json.title).toBe("after");
  expect(res.json.purpose).toBe("new purpose");
  expect(res.json.completion_criteria).toBe("new criteria");

  const edited = (await events(t, task.id)).filter((e) => e.kind === "task_edited");
  const titleEdit = edited.find((e) => e.payload.field === "title");
  expect(titleEdit.payload.from).toBe("before");
  expect(titleEdit.payload.to).toBe("after");
  expect(edited.find((e) => e.payload.field === "purpose").payload.from).toBe("purpose of before");
  expect(edited.find((e) => e.payload.field === "completion_criteria").payload.from).toBe(
    "criteria of before",
  );
});

it("値が変わらないフィールドを送っても no-op で、task_edited イベントは残らない", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "same");

  await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { title: "same" });

  const edited = (await events(t, task.id)).filter((e) => e.kind === "task_edited");
  expect(edited).toHaveLength(0);
});

it("assignee を編集でき、登録時と同じ registry 解決の検査が再実行される(未知の agent は拒否)", async () => {
  t = await bootTidepool({ agentRegistered: (name) => name === "coder" });
  const task = await registerWork(t, "assign me");

  const ok = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { assignee: "coder" });
  expect(ok.status).toBe(200);
  expect(ok.json.assignee).toBe("coder");

  const bad = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { assignee: "ghost" });
  expect(bad.status).toBe(400);
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(after.assignee).toBe("coder");

  // empty string means "unset — resolve to the board default" (null), exempt
  // from the registry check
  const unset = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { assignee: "" });
  expect(unset.status).toBe(200);
  expect(unset.json.assignee).toBe(null);
});

it("通常タスクの workspace を編集でき、未知の workspace 名は拒否される", async () => {
  t = await bootTidepool({
    workspace: { name: "home", path: "/fake/home" },
    resolveWorkspace: (w) => {
      const name = w ?? "home";
      if (name !== "home" && name !== "other") {
        throw new UnknownWorkspaceError(name);
      }
      return { name, path: `/fake/${name}` };
    },
  });
  const task = await registerWork(t, "move me", "home");

  const ok = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { workspace: "other" });
  expect(ok.status).toBe(200);
  expect(ok.json.workspace).toBe("other");

  const bad = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { workspace: "nope" });
  expect(bad.status).toBe(400);
});

it("review flag を編集でき、旧値がイベントに残る(人間登録タスクでは flag は未消費の間 可変)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "opt in", undefined, false);

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_flag: true });
  expect(res.status).toBe(200);
  expect(res.json.review_flag).toBe(1);

  const edited = (await events(t, task.id)).filter(
    (e) => e.kind === "task_edited" && e.payload.field === "review_flag",
  );
  expect(edited).toHaveLength(1);
  expect(edited[0].payload.from).toBe("false");
  expect(edited[0].payload.to).toBe("true");
});

it("人間 decompose で足した子タスク(人間登録)も編集できる", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  const child = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "child",
      purpose: "p",
      completion_criteria: "c",
      parent_id: parent.id,
      decompose_reason: "split the child work",
    })
  ).json;

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${child.id}`, { title: "renamed child" });
  expect(res.status).toBe(200);
  expect(res.json.title).toBe("renamed child");
});
