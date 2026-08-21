import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import {
  api,
  bootTidepool,
  commitWork,
  FULL_HANDOFF,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];

afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 盤面の DB へ直に付帯子(親を持ち、based_on_decision を持たず、question でない子)を
 *  1つ足す — `bundleObjections` が異議修理を登録するのと同じ形。人間面の /api/tasks は
 *  parent_id つきの登録に decompose_reason を要求する(= 分解子になる)ので、付帯子の
 *  fixture はこの seam を通す(`registerQuestion` と同じ理由)。 */
function attachChild(pool: Tidepool, parentId: string, title: string, assignee?: string) {
  const db = openDb(join(pool.dir, "board.sqlite"));
  try {
    return registerTask(
      db,
      {
        type: "work",
        title,
        purpose: `purpose of ${title}`,
        completion_criteria: `criteria of ${title}`,
        parent_id: parentId,
        ...(assignee !== undefined && { assignee }),
      },
      pool.clock.now(),
    );
  } finally {
    db.close();
  }
}

async function questions(pool: Tidepool): Promise<any[]> {
  return (await api(pool.baseUrl, "GET", "/api/tasks")).json.filter(
    (candidate: any) => candidate.type === "question",
  );
}

/** 完了 → slot が空く → 次の todo が拾われる、を待たずに任意のタスクを slot へ入れる。
 *  MCP の verb は slot task にしか attribution できない。 */
async function pickUp(pool: Tidepool, taskId: string): Promise<void> {
  await api(pool.baseUrl, "POST", `/api/tasks/${taskId}/move`, { after: null });
  await pool.clock.advance(HOUR);
}

async function completeViaMcp(pool: Tidepool, taskId: string, handoff = true): Promise<any> {
  const client = await mcpClient(pool.mcpBaseUrl, taskId);
  const res: any = await client.callTool({
    name: "complete_task",
    arguments: handoff ? { handoff: FULL_HANDOFF } : {},
  });
  await client.close();
  return res;
}

it("purely-local: 未決着の付帯子がある間は着地 question を立てず、付帯子の完了で立つ", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature", undefined, true);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  expect((await completeViaMcp(t, task.id)).isError ?? false).toBe(false);

  expect(await questions(t)).toEqual([]);
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "review" && candidate.parent_id === task.id,
  );
  expect(review).toBeDefined();
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json).toContainEqual(
    expect.objectContaining({
      worker_id: "tidepool",
      origin: "board",
      kind: "landing_deferred",
      payload: { kind: "landing_deferred", unsettled_attached_children: 1 },
    }),
  );

  await pickUp(t, review.id);
  await completeViaMcp(t, review.id, false);

  const landing = await questions(t);
  expect(landing).toHaveLength(1);
  expect(landing[0]).toMatchObject({
    question_pending_local_merge_task_id: task.id,
    question_items: [{ options: ["merge", "hold"] }],
  });
});

it("remote-backed(escalate): 付帯子が未決着なら PR を開かず、決着後に PR と merge question が立つ", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const task = await registerWork(t, "ship remotely", undefined, true);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  await completeViaMcp(t, task.id);

  expect(t.github.requests).toEqual([]);
  expect(await questions(t)).toEqual([]);

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "review" && candidate.parent_id === task.id,
  );
  await pickUp(t, review.id);
  await completeViaMcp(t, review.id, false);

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.requests[0]?.branch).toBe(`task/${task.id}`);
  expect(await questions(t)).toMatchObject([{ question_pending_merge_pr: 1 }]);
});

it("remote-backed(auto_if_ci_green、risk なし): 付帯子が未決着なら auto-merge キューに入らず、決着後に無人 merge へ進む", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "auto_if_ci_green" },
  });
  const task = await registerWork(t, "ship unattended", undefined, true);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  await completeViaMcp(t, task.id);

  t.github.scriptCiStatus("success");
  await t.clock.advance(60 * 1000); // auto-merge poll ticks with nothing queued
  expect(t.github.requests).toEqual([]);
  expect(t.github.merged).toEqual([]);

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "review" && candidate.parent_id === task.id,
  );
  await pickUp(t, review.id);
  await completeViaMcp(t, review.id, false);

  expect(t.github.requests).toHaveLength(1);
  await t.clock.advance(60 * 1000);
  expect(t.github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

it("remote-backed(external): 付帯子の決着後に PR が開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "external" },
  });
  const task = await registerWork(t, "ship to an outside merge surface", undefined, true);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");

  await completeViaMcp(t, task.id);
  expect(t.github.requests).toEqual([]);

  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "review" && candidate.parent_id === task.id,
  );
  await pickUp(t, review.id);
  await completeViaMcp(t, review.id, false);

  expect(t.github.requests).toHaveLength(1);
  expect(t.github.requests[0]?.branch).toBe(`task/${task.id}`);
  expect(await questions(t)).toEqual([]);
});

it("purely-local: 人間が付帯子を cancel しても着地する — cancel も決着である", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship despite the cancelled review");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  const attached = attachChild(t, task.id, "review the feature");

  await completeViaMcp(t, task.id);
  expect(await questions(t)).toEqual([]);

  const cancelled = await api(t.baseUrl, "POST", `/api/tasks/${attached.id}/cancel`, {});

  expect(cancelled.status).toBe(200);
  expect(await questions(t)).toMatchObject([
    { question_pending_local_merge_task_id: task.id },
  ]);
});

it("purely-local: 人間が付帯子を complete しても着地する", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship after the human check");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  const attached = attachChild(t, task.id, "check the feature by hand", "human");

  await completeViaMcp(t, task.id);
  expect(await questions(t)).toEqual([]);

  const completed = await api(t.baseUrl, "POST", `/api/tasks/${attached.id}/complete`, {});

  expect(completed.status).toBe(200);
  expect(await questions(t)).toMatchObject([
    { question_pending_local_merge_task_id: task.id },
  ]);
});

it("待機中に付いた2つ目の付帯子が着地をもう一度待たせ、landing_deferred は重複しない", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship after two attached children", undefined, true);
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);

  // 待っている間に異議修理が付く — 門は着地の瞬間に読み直される(ADR 0092 決定3)
  const repair = attachChild(t, task.id, "repair: ship after two attached children", "human");
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "review" && candidate.parent_id === task.id,
  );
  await pickUp(t, review.id);
  await completeViaMcp(t, review.id, false);

  expect(await questions(t)).toEqual([]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  expect(events.filter((event: any) => event.kind === "landing_deferred")).toHaveLength(1);

  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/complete`, {});

  expect(await questions(t)).toMatchObject([
    { question_pending_local_merge_task_id: task.id },
  ]);
});

it("決着済み分解子に付いた異議修理が未決着なら、親の着地は待つ", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const parent = await registerWork(t, "integrate the feature");
  await t.clock.advance(HOUR);
  const decomposer = await mcpClient(t.mcpBaseUrl, parent.id);
  await decomposer.callTool({
    name: "decompose",
    arguments: {
      reason: "the child can be implemented independently",
      children: [
        {
          title: "implement the child",
          purpose: "finish one part",
          completion_criteria: "the child artifact exists",
        },
      ],
    },
  });
  await decomposer.close();
  const child = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.parent_id === parent.id && candidate.type === "work",
  );
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "child.txt", "child work\n");
  await completeViaMcp(t, child.id);

  // 決着済みの分解子へ付いた修理 — 系譜経由で親のタスクブランチへ流れ込むので、
  // 親の着地はこれも待つ(ADR 0092 決定1 / ADR 0053)
  const repair = attachChild(t, child.id, "repair: implement the child", "human");
  await t.clock.advance(HOUR);
  await completeViaMcp(t, parent.id);

  expect(await questions(t)).toEqual([]);

  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/complete`, {});

  expect(await questions(t)).toMatchObject([
    { question_pending_local_merge_task_id: parent.id },
  ]);
});

it("差分ゼロの完了は付帯子に関係なく着地対象なしを即座に記録する", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "inspect without changing files", undefined, true);
  await t.clock.advance(HOUR);

  await completeViaMcp(t, task.id);

  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  expect(events).toContainEqual(
    expect.objectContaining({
      kind: "nothing_to_land",
      payload: { kind: "nothing_to_land", base: "main" },
    }),
  );
  expect(events.filter((event: any) => event.kind === "landing_deferred")).toEqual([]);
  expect(await questions(t)).toEqual([]);
});

it("strict 経路(PR 昇格失敗の retry)では、門の不成立が付帯子を指す例外になる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  t.github.scriptFailure(new Error("token expired"));
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  const failure = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.question_pending_pr_promotion_task_id === task.id,
  );
  // 着地済みタスクへ後から出た異議の修理と同じ形
  attachChild(t, task.id, "repair: ship the feature");
  t.github.scriptFailure(null);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, {
    answers: ["retry"],
  });

  expect(answered).toMatchObject({
    status: 409,
    json: { error: "review still running: 1 attached child task(s) unsettled" },
  });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failure.id}`)).json).toMatchObject({
    status: "todo",
    question_answer: null,
  });
  expect(t.github.requests).toHaveLength(1);
});

it("付帯子が abandon で決着した場合も着地する", async () => {
  const grace = 30 * 60 * 1000;
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace,
    watchdog: { timeLimits: { work: 90 * 60 * 1000 }, grace },
  });
  const task = await registerWork(t, "ship despite the abandoned repair");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  const attached = attachChild(t, task.id, "repair: ship despite the abandoned repair");
  await completeViaMcp(t, task.id);
  expect(await questions(t)).toEqual([]);

  await t.clock.advance(HOUR); // 付帯子が拾われる
  await t.clock.advance(90 * 60 * 1000); // SIGTERM
  await t.clock.advance(grace); // SIGKILL — failure question が立つ
  const failure = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.type === "question" && candidate.parent_id === attached.id,
  );

  await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, { answers: ["abandon"] });

  expect((await api(t.baseUrl, "GET", `/api/tasks/${attached.id}`)).json.status).toBe("cancelled");
  expect(await questions(t)).toMatchObject([
    { question_pending_local_merge_task_id: task.id },
  ]);
});
