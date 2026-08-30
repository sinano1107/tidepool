import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { loadRegistry } from "../src/registry.js";
import { resolveExecutionWorkspace } from "../src/workspace.js";
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
import { makeRegistry } from "./registry-fixture.js";

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


/** 「PR 昇格が失敗して失敗 question が立っている根 work」—— 失敗のあとに何が起きるかを
 *  測るテストの共通の出発点。 */
async function failedPromotion() {
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
  expect(t.github.requests).toHaveLength(1);
  return { workspace, task, failure };
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
  const { task, failure } = await failedPromotion();
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

it("再発火で PR が開いたら、PR 昇格失敗 question は観測で引退する", async () => {
  const { workspace, task, failure } = await failedPromotion();

  const repair = attachChild(t, task.id, "repair: ship the feature");
  t.github.scriptFailure(null);
  await pickUp(t, repair.id);
  commitWork(workspace.path, "repair.txt", "repaired\n");
  await completeViaMcp(t, repair.id);

  expect(t.github.requests).toHaveLength(2);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failure.id}`)).json).toMatchObject({
    status: "done",
    question_answer: null,
  });
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${failure.id}/events`)).json;
  expect(events.filter((event: any) => event.kind === "question_answered")).toEqual([]);
  expect(events.filter((event: any) => event.kind === "pr_promotion_observed")).toMatchObject([
    { worker_id: "tidepool", origin: "board", payload: { kind: "pr_promotion_observed" } },
  ]);

  // 引退済みなので retry は受理されず、既存 PR へ `gh pr create` を撃ち直さない
  expect(await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, { answers: ["retry"] })).toMatchObject({
    status: 409,
    json: { error: "a done question cannot be answered" },
  });
  expect(t.github.requests).toHaveLength(2);
});

it("purely-local の着地 question は、再発火時に不要になった PR 昇格失敗 question を引退させる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "sandbox");
  const registryDir = await makeRegistry({
    "workspaces.yaml": `sandbox:\n  path: ${workspace.path}\n  repo: ${workspace.repo}\n`,
  });
  dirs.push(registryDir);
  t = await bootTidepool({
    workspace,
    resolveWorkspace: (taskWorkspace) =>
      resolveExecutionWorkspace(
        loadRegistry(registryDir, "purely-local"),
        "sandbox",
        taskWorkspace,
        "/unused",
      ),
  });
  t.github.scriptFailure(new Error("token expired"));
  const task = await registerWork(t, "ship the feature");
  await t.clock.advance(HOUR);
  commitWork(workspace.path, "feature.txt", "finished\n");
  await completeViaMcp(t, task.id);
  const failure = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (candidate: any) => candidate.question_pending_pr_promotion_task_id === task.id,
  );
  expect(t.github.requests).toHaveLength(1);

  const child = attachChild(t, task.id, "check the feature");
  writeFileSync(join(registryDir, "workspaces.yaml"), `sandbox:\n  path: ${workspace.path}\n`);
  git(registryDir, "add", "workspaces.yaml");
  git(registryDir, "commit", "-m", "make sandbox purely local");
  git(workspace.path, "remote", "remove", "origin");

  await pickUp(t, child.id);
  await completeViaMcp(t, child.id);

  expect(await questions(t)).toContainEqual(
    expect.objectContaining({
      status: "todo",
      question_pending_local_merge_task_id: task.id,
    }),
  );
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failure.id}`)).json).toMatchObject({
    status: "done",
    question_answer: null,
  });
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${failure.id}/events`)).json;
  expect(events.filter((event: any) => event.kind === "question_answered")).toEqual([]);
  expect(events.filter((event: any) => event.kind === "pr_promotion_observed")).toEqual([
    expect.objectContaining({ worker_id: "tidepool", origin: "board" }),
  ]);
  expect(t.github.requests).toHaveLength(1);
});

it("再発火が門で止まったら、PR 昇格失敗 question は開いたまま残る", async () => {
  const { task, failure } = await failedPromotion();

  const first = attachChild(t, task.id, "repair: ship the feature", "human");
  attachChild(t, task.id, "review: ship the feature", "human");
  t.github.scriptFailure(null);
  await api(t.baseUrl, "POST", `/api/tasks/${first.id}/complete`, {});

  // 再発火は走った上で門に止まった —— 走らなかったのと区別する
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json).toContainEqual(
    expect.objectContaining({
      kind: "landing_deferred",
      payload: { kind: "landing_deferred", unsettled_attached_children: 1 },
    }),
  );
  expect(t.github.requests).toHaveLength(1);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failure.id}`)).json).toMatchObject({
    status: "todo",
    question_answer: null,
  });
});

it("再発火が着地対象なしを記録した場合も、PR 昇格失敗 question は引退する", async () => {
  const { workspace, task, failure } = await failedPromotion();

  // 失敗した昇格の間に、その成果は別経路で保護ブランチへ載った = 再発火には運ぶ差分がない
  git(workspace.path, "push", "--quiet", "origin", `task/${task.id}:main`);
  const repair = attachChild(t, task.id, "repair: ship the feature", "human");
  t.github.scriptFailure(null);
  await api(t.baseUrl, "POST", `/api/tasks/${repair.id}/complete`, {});

  expect(t.github.requests).toHaveLength(1);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json).toContainEqual(
    expect.objectContaining({ kind: "nothing_to_land" }),
  );
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failure.id}`)).json).toMatchObject({
    status: "done",
    question_answer: null,
  });
});

it("再発火が飛んでいる最中に retry が着地させたら、再発火の失敗は question にならない", async () => {
  const { workspace, task, failure } = await failedPromotion();

  const repair = attachChild(t, task.id, "repair: ship the feature");
  t.github.scriptFailure(null);
  // 再発火の `gh pr create` を撃った状態で止め、その窓に人間の retry を差し込む。
  // 2本目(retry 側・同一ブランチ)は素通りで成功し、解放した1本目は実 GitHub と
  // 同じ "already exists" で落ちる
  const createPullRequest = t.github.createPullRequest.bind(t.github);
  const order: string[] = [];
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let relandEntered!: () => void;
  const relandStarted = new Promise<void>((resolve) => {
    relandEntered = resolve;
  });
  let calls = 0;
  t.github.createPullRequest = async (input) => {
    if (++calls === 1) {
      order.push("reland:enter");
      relandEntered();
      await gate;
      order.push("reland:already-exists");
      throw new Error(`a pull request for branch ${input.branch} already exists`);
    }
    order.push("retry:create");
    return createPullRequest(input);
  };

  await pickUp(t, repair.id);
  commitWork(workspace.path, "repair.txt", "repaired\n");
  const completing = completeViaMcp(t, repair.id);
  await relandStarted;
  const answered = await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, {
    answers: ["retry"],
  });
  releaseGate();
  await completing;

  expect(answered.status).toBe(200);
  expect(order).toEqual(["reland:enter", "retry:create", "reland:already-exists"]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failure.id}`)).json).toMatchObject({
    status: "done",
    question_answer: ["retry"],
  });
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  expect(events.filter((event: any) => event.kind === "pr_opened")).toHaveLength(1);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.pr_number).not.toBeNull();
  expect(
    (await questions(t)).filter(
      (q: any) => q.status === "todo" && q.question_pending_pr_promotion_task_id === task.id,
    ),
  ).toEqual([]);
});

it("strict retry で着地したら、積み上がった他の PR 昇格失敗 question も観測で引退する", async () => {
  const { workspace, task, failure } = await failedPromotion();

  // 再発火が同じ原因でもう一度落ちて、同じタスクを指す失敗 question が2件になる
  const repair = attachChild(t, task.id, "repair: ship the feature");
  await pickUp(t, repair.id);
  commitWork(workspace.path, "repair.txt", "repaired\n");
  await completeViaMcp(t, repair.id);
  const stacked = (await questions(t)).filter(
    (q: any) => q.status === "todo" && q.question_pending_pr_promotion_task_id === task.id,
  );
  expect(stacked).toHaveLength(2);
  const second = stacked.find((q: any) => q.id !== failure.id);
  t.github.scriptFailure(null);

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, {
    answers: ["retry"],
  });

  expect(answered.status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${failure.id}`)).json).toMatchObject({
    status: "done",
    question_answer: ["retry"],
  });
  const answeredEvents = (await api(t.baseUrl, "GET", `/api/tasks/${failure.id}/events`)).json;
  expect(answeredEvents.filter((event: any) => event.kind === "question_answered")).toHaveLength(1);
  // 引退は観測であって人間の決定ではない —— 誰も答えていない question に回答を書かない
  expect((await api(t.baseUrl, "GET", `/api/tasks/${second.id}`)).json).toMatchObject({
    status: "done",
    question_answer: null,
  });
  const secondEvents = (await api(t.baseUrl, "GET", `/api/tasks/${second.id}/events`)).json;
  expect(secondEvents.filter((event: any) => event.kind === "pr_promotion_observed")).toHaveLength(1);
  expect(secondEvents.filter((event: any) => event.kind === "question_answered")).toEqual([]);
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  expect(events.filter((event: any) => event.kind === "pr_opened")).toHaveLength(1);
  expect(
    (await questions(t)).filter(
      (q: any) => q.status === "todo" && q.question_pending_pr_promotion_task_id === task.id,
    ),
  ).toEqual([]);
});
