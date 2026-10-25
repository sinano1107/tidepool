import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { agentDefinitionThen } from "../src/board-prose.js";
import { openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents } from "../src/events.js";
import { editTask, getTask, pickupTask, registerTask, returnToQueue } from "../src/tasks.js";
import { api, bootTidepool, defaultingTo, FULL_HANDOFF, HOUR, HUMAN_WEBUI, mcpClient, queueChild, queueWork, type Tidepool, WORKER_SPAWNED } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

let t: Tidepool;
afterEach(() => t?.stop());

async function events(t: Tidepool, id: string): Promise<any[]> {
  return (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json;
}

/** MCP の complete_task で完了させ、立った完了時レビューの assignee を返す。 */
async function completeAndListReviewers(t: Tidepool, id: string): Promise<string[]> {
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  return (await api(t.baseUrl, "GET", "/api/tasks")).json
    .filter((x: any) => x.type === "review" && x.parent_id === id)
    .map((x: any) => x.assignee);
}

it("人間登録タスクの title / purpose / completion criteria を編集でき、旧値がイベント履歴に残る", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "before");

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
  const task = queueWork(t, "same");

  await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { title: "same" });

  const edited = (await events(t, task.id)).filter((e) => e.kind === "task_edited");
  expect(edited).toHaveLength(0);
});

it("assignee を編集でき、登録時と同じ registry 解決の検査が再実行される(未知の agent は拒否)", async () => {
  t = await bootTidepool({ agentRegistered: (name) => name === "coder" });
  const task = queueWork(t, "assign me");

  const ok = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { assignee: "coder" });
  expect(ok.status).toBe(200);
  expect(ok.json.assignee).toBe("coder");

  const bad = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { assignee: "ghost" });
  expect(bad.status).toBe(400);
  const after = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json;
  expect(after.assignee).toBe("coder");

  // empty string means "unset — resolve to the board default" (stored as null),
  // exempt from the registry check
  const unset = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { assignee: "" });
  expect(unset.status).toBe(200);
  expect(unset.json.raw_assignee).toBe(null);
});

it("通常タスクの workspace を編集でき、未知の workspace 名は拒否される", async () => {
  t = await bootTidepool({
    workspace: { name: "home", path: "/fake/home" },
    resolveWorkspace: defaultingTo({ name: "home", path: "/fake/home" }, { name: "other", path: "/fake/other" }),
  });
  const task = queueWork(t, "move me", "home");

  const ok = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { workspace: "other" });
  expect(ok.status).toBe(200);
  expect(ok.json.workspace).toBe("other");

  const bad = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { workspace: "nope" });
  expect(bad.status).toBe(400);
});

it("review flag を編集でき、旧値がイベントに残る(人間登録タスクでは flag は未消費の間 可変)", async () => {
  t = await bootTidepool();
  // ルートは flag によらずレビューされ、その review_flag は拒否される(issue #1467)ので、対象は子
  const task = queueChild(t, "opt in", queueWork(t, "parent").id);

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
  const parent = queueWork(t, "parent");
  const child = queueChild(t, "child", parent.id);

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${child.id}`, { title: "renamed child" });
  expect(res.status).toBe(200);
  expect(res.json.title).toBe("renamed child");
});

it("人間登録 task の review_by を Edit で置き換えると、完了時レビューが新しい reviewer ごとに立ち、旧値が履歴に残る(#1498)", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "review me");

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_by: ["security", "standards"] });
  expect(res.status).toBe(200);
  expect(res.json.review_by).toEqual(["security", "standards"]);

  const edited = (await events(t, task.id)).filter(
    (e) => e.kind === "task_edited" && e.payload.field === "review_by",
  );
  expect(edited).toHaveLength(1);
  expect(edited[0].payload.from).toBe(null);
  expect(edited[0].payload.to).toBe('["security","standards"]');

  expect(await completeAndListReviewers(t, task.id)).toEqual(["security", "standards"]);
});

it("review_by: [] で指名を外すと null に戻り、完了時レビューは盤面の Auditor に解決される", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "unname me");
  await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_by: ["security"] });

  const res = await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_by: [] });
  expect(res.status).toBe(200);
  expect(res.json.review_by).toBe(null);

  const edited = (await events(t, task.id)).filter(
    (e) => e.kind === "task_edited" && e.payload.field === "review_by",
  );
  expect(edited.map((e) => [e.payload.from, e.payload.to])).toEqual([
    [null, '["security"]'],
    ['["security"]', null],
  ]);

  expect(await completeAndListReviewers(t, task.id)).toEqual(["fugu"]);
});

it("同じ review_by を送り直しても、未指名に [] を送っても task_edited は残らない", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "same reviewers");
  await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_by: [] });
  await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_by: ["security"] });
  await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { review_by: ["security"] });

  const edited = (await events(t, task.id)).filter(
    (e) => e.kind === "task_edited" && e.payload.field === "review_by",
  );
  expect(edited).toHaveLength(1);
});

// pickup 済み task の assignee / workspace の門(ADR 0292 決定1 / #2369 / #2362)—— ドメイン層

const at = new Date("2026-10-21T00:00:00.000Z");

/** 人間登録の work を deckhand が pickup し、上限到達で `todo` に戻した盤面(escalate・decompose・queue 復帰と同じ窓)。 */
function returnedAfterPickup() {
  const db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "w", purpose: "p", completion_criteria: "c", assignee: "deckhand", workspace: "home" }, at, ...HUMAN_WEBUI);
  returnToQueue(db, pickupTask(db, task, "deckhand", at)!, { kind: "cap_interrupted" }, at);
  return { db, task: getTask(db, task.id)! };
}

it.each([
  ["assignee を別名に", { assignee: "navigator" }],
  ["assignee を空に", { assignee: "" }],
  ["workspace を別名に", { workspace: "other" }],
  ["workspace を空に", { workspace: "" }],
])("pickup 済みで todo に戻った task の %s変える Edit は拒まれ、列は動かない(ADR 0292 決定1)", (_, input) => {
  const { db, task } = returnedAfterPickup();

  expect(() => editTask(db, task, input, at, "webui")).toThrow(DomainError);
  expect(getTask(db, task.id)).toMatchObject({ assignee: "deckhand", workspace: "home" });
});

it("pickup 済みの task でも、assignee / workspace の値が変わらない送信と他の欄の Edit は従来どおり通る", () => {
  const { db, task } = returnedAfterPickup();

  const edited = editTask(db, task, { assignee: "deckhand", workspace: "home", title: "renamed" }, at, "webui");

  expect(edited.title).toBe("renamed");
  expect(listEvents(db, task.id).filter((e) => e.kind === "task_edited").map((e) => (e.payload as { field: string }).field)).toEqual(["title"]);
});

it("拒否の後も、review の spawn の当時版の Roster は spawn が描いた [deckhand] のまま(#2369 の再現)", async () => {
  const { db, task } = returnedAfterPickup();
  const review = registerTask(db, { type: "review", title: "r", purpose: "p", completion_criteria: "c", parent_id: task.id }, at, ...HUMAN_WEBUI);
  const registryDir = await makeRegistry();
  const commit = execFileSync("git", ["rev-parse", "main"], { cwd: registryDir }).toString().trim();
  appendEvent(db, { taskId: review.id, actorId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, registry_commit: commit } });
  const spawned = listEvents(db, review.id).find((e) => e.kind === "worker_spawned")!;

  expect(() => editTask(db, task, { assignee: "navigator" }, at, "webui")).toThrow(DomainError);
  const then = agentDefinitionThen(db, registryDir, spawned);
  expect(then?.authority.assignable_to).toEqual(["deckhand"]);
  expect(then?.roster.map((agent) => agent.name)).toEqual(["deckhand"]);
});
