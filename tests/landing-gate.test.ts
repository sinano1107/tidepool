import { rm } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import {
  api,
  attachChild,
  bootTidepool,
  commitWork,
  completeViaMcp,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  mcpClient,
  questions,
  registerWork,
  type Tidepool,
} from "./harness.js";

let t: Tidepool;
const dirs: string[] = [];

afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 完了 → slot が空く → 次の todo が拾われる、を待たずに任意のタスクを slot へ入れる。
 *  MCP の verb は slot task にしか attribution できない。 */
async function pickUp(pool: Tidepool, taskId: string): Promise<void> {
  await api(pool.baseUrl, "POST", `/api/tasks/${taskId}/move`, { after: null });
  await pool.clock.advance(HOUR);
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
      payload: { kind: "landing_deferred", reason: "attached_children", count: 1 },
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

it("付帯子の付帯子(修理に付いたレビュー)も、根の着地を待たせる", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  const repair = attachChild(t, task.id, "repair the feature", "human");
  const repairReview = attachChild(t, repair.id, "review the repair", "human");

  await completeViaMcp(t, task.id);
  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/complete`, {});

  // 修理は決着したが、その成果は根のブランチへ流れ込んでおり、そのレビューが未決着
  expect(await questions(t)).toEqual([]);

  await api(t.baseUrl, "POST", `/api/tasks/${repairReview.id}/complete`, {});

  expect(await questions(t)).toMatchObject([
    { question_pending_local_merge_task_id: task.id },
  ]);
});

it("着地済みの根の下で自分が着地の根になった付帯子も、自分の付帯子の決着で着地する", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  const [landing] = await questions(t);
  await api(t.baseUrl, "POST", `/api/tasks/${landing.id}/answer`, { answers: ["merge"] });

  // 着地後に付いた修理は保護ブランチと同じ地点から切られるので、自分が着地の根になる
  const repair = attachChild(t, task.id, "repair the landed feature");
  const repairReview = attachChild(t, repair.id, "review the repair", "human");
  await pickUp(t, repair.id);
  commitWork(workspace.path, "repair.txt", "repaired\n");
  await completeViaMcp(t, repair.id);
  expect((await questions(t)).filter((q: any) => q.status === "todo")).toEqual([]);

  await api(t.baseUrl, "POST", `/api/tasks/${repairReview.id}/complete`, {});

  expect((await questions(t)).filter((q: any) => q.status === "todo")).toMatchObject([
    { question_pending_local_merge_task_id: repair.id },
  ]);
});

/** 異議は log entry に対して出る — 完了報告(`task_completed`)がそのエントリ。 */
async function completionEntry(pool: Tidepool, taskId: string): Promise<any> {
  const log = (await api(pool.baseUrl, "GET", "/api/log")).json;
  return log.entries.find((entry: any) => entry.kind === "task_completed" && entry.task_id === taskId);
}

/** commit が束ねた子(修理 + RCA レビュー)を全部決着させる。commit の即時 poll が
 *  すでに1つを slot へ入れているので、in_progress のものから順に完了させる。 */
async function settleAttachedChildren(pool: Tidepool, taskId: string): Promise<void> {
  for (let round = 0; ; round++) {
    expect(round, "attached children keep appearing").toBeLessThan(10);
    const board = (await api(pool.baseUrl, "GET", "/api/tasks")).json;
    const pending = board.filter(
      (candidate: any) =>
        candidate.parent_id === taskId && !["done", "cancelled"].includes(candidate.status),
    );
    if (pending.length === 0) return;
    const child = pending.find((candidate: any) => candidate.status === "in_progress") ?? pending[0];
    if (child.status !== "in_progress") await pickUp(pool, child.id);
    const res = await completeViaMcp(pool, child.id, child.type === "work");
    expect(res.isError ?? false).toBe(false);
  }
}

/** 門(#402)を抜けて question が立った**後**に付帯子が付く盤面 — 回答時検証が要る理由そのもの。 */
async function landingQuestionThenAttachedChild(): Promise<{ task: any; landing: any; workspace: any }> {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  const [landing] = await questions(t);
  attachChild(t, task.id, "repair: ship the feature", "human");
  return { task, landing, workspace };
}

it("着地 question への merge 回答は、後から付いた未決着の付帯子を理由に 409 になり question は開いたまま", async () => {
  const { task, landing, workspace } = await landingQuestionThenAttachedChild();

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${landing.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered).toMatchObject({
    status: 409,
    json: { error: "cannot merge yet: 1 attached child task(s) unsettled" },
  });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${landing.id}`)).json).toMatchObject({
    status: "todo",
    question_answer: null,
  });
  expect(git(workspace.path, "rev-list", "--count", `main..task/${task.id}`)).toBe("1");
});

it("hold は付帯子が未決着でも受理される — 着地しない決定はいつでもできる", async () => {
  const { task, landing, workspace } = await landingQuestionThenAttachedChild();
  const entry = await completionEntry(t, task.id);
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "この方針では直らない — やり直してほしい",
  });

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${landing.id}/answer`, {
    answers: ["hold"],
  });

  expect(answered.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${task.id}`)).toBe("1");
});

it("open な triage session の未束ねの異議は、着地 question への merge 回答を 409 にする", async () => {
  const workspace = await makeWorkspace(dirs, "sandbox");
  t = await bootTidepool({ workspace });
  const task = await registerWork(t, "ship the objected feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  const [landing] = await questions(t);
  const entry = await completionEntry(t, task.id);
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "この完了報告の判断に異議がある",
  });

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${landing.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered).toMatchObject({
    status: 409,
    json: { error: "cannot merge yet: 1 objection(s) raised in this triage await commit" },
  });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${landing.id}`)).json).toMatchObject({
    status: "todo",
    question_answer: null,
  });
});

it("分解子の判断への異議も親の着地 question を 409 にし、commit 後は付帯子として捕まり、決着で受理される", async () => {
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
  await t.clock.advance(HOUR);
  await completeViaMcp(t, parent.id);
  const [landing] = await questions(t);
  const entry = await completionEntry(t, child.id);
  await api(t.baseUrl, "POST", "/api/triage/objection", {
    entry_id: entry.id,
    comment: "分解子の判断に異議がある",
  });

  const objected = await api(t.baseUrl, "POST", `/api/tasks/${landing.id}/answer`, {
    answers: ["merge"],
  });

  expect(objected).toMatchObject({
    status: 409,
    json: { error: "cannot merge yet: 1 objection(s) raised in this triage await commit" },
  });

  // commit が異議を修理子へ束ねる — 以後は (b) ではなく (a) の付帯子側で捕まる
  await api(t.baseUrl, "POST", "/api/triage/close");
  const bundled = await api(t.baseUrl, "POST", `/api/tasks/${landing.id}/answer`, {
    answers: ["merge"],
  });

  expect(bundled.status).toBe(409);
  expect(bundled.json.error).toContain("attached child task(s) unsettled");

  await settleAttachedChildren(t, child.id);
  const landed = await api(t.baseUrl, "POST", `/api/tasks/${landing.id}/answer`, {
    answers: ["merge"],
  });

  expect(landed.status).toBe(200);
  expect(git(workspace.path, "rev-list", "--count", `main..task/${parent.id}`)).toBe("0");
});

it("PR の merge question も同じ検証を通る — 未決着の付帯子があれば CI も見ずに 409", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  t = await bootTidepool({
    workspace,
    authority: { name: "standard", guidance: "", merge: "escalate" },
  });
  const task = await registerWork(t, "ship remotely");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  const [merge] = await questions(t);
  attachChild(t, task.id, "repair: ship remotely", "human");
  t.github.scriptCiStatus("success");

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${merge.id}/answer`, {
    answers: ["merge"],
  });

  expect(answered).toMatchObject({
    status: 409,
    json: { error: "cannot merge yet: 1 attached child task(s) unsettled" },
  });
  expect(t.github.merged).toEqual([]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${merge.id}`)).json).toMatchObject({
    status: "todo",
    question_answer: null,
  });
});
