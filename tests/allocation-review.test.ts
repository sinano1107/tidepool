import { afterEach, expect, it } from "vitest";
import { buildAllocationReviewInput } from "../src/allocation-review.js";
import { appendEvent } from "../src/events.js";
import { completeTask, getTask, HUMAN_WORKER_ID } from "../src/tasks.js";
import { reportProviderUsage } from "../src/throttle.js";
import { FakeAllocationClient } from "./fakes.js";
import { api, bootTidepool, FULL_HANDOFF, HOUR, mcpClient, nextPoll, WORKER_SPAWNED as spawned, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const usage = {
  input_tokens: 100,
  output_tokens: 20,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  estimated_cost_usd: 1.5,
  advisor: null,
};

it("配分評価の入力は verdict・findings・実行設定と出所・要求ティア・usage・行動列マーカーの計数から組まれる", () => {
  expect(
    buildAllocationReviewInput({
      verdict: "accepted with one nit",
      findings: "## Outcome\n\nfine",
      requestedTier: "standard",
      spawned,
      exited: {
        kind: "worker_exited",
        exit_code: 0,
        signal: null,
        stderr_tail: null,
        reported_error: null,
        last_message: null,
        worker_spawned_event_id: 7,
        usage,
      },
      markers: ["decision", "advisor", "commit", "advisor", "compaction"],
    }),
  ).toEqual({
    verdict: "accepted with one nit",
    findings: "## Outcome\n\nfine",
    setting: {
      provider: "anthropic",
      model: "opus",
      effort: "high",
      advisor: "fable",
      source: { tier: "task", provider: "only" },
    },
    requested_tier: "standard",
    usage,
    actions: { advisor_consultations: 2, compactions: 1, commits: 1 },
  });
});

it("usage と Precedent の episode が無い session(codex 等)は null で区別され、空の観測とは混ざらない", () => {
  expect(
    buildAllocationReviewInput({
      verdict: null,
      findings: null,
      requestedTier: null,
      spawned,
      exited: undefined,
      markers: null,
    }),
  ).toMatchObject({ verdict: null, findings: null, requested_tier: null, usage: null, actions: null });
});

/** A root work task with one recorded worker session (spawn + exit), completed
 *  so its integration review exists. Returns the ids the annotation must name. */
async function reviewedWork(t: Tidepool, options: { session: boolean } = { session: true }) {
  const task = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "subject",
      purpose: "p",
      completion_criteria: "c",
      tier: "standard",
    })
  ).json;
  await t.clock.advance(HOUR);
  const spawnedId = options.session
    ? appendEvent(t.db, {
        taskId: task.id,
        workerId: "reef-crab",
        origin: "board",
        at: t.clock.now(),
        payload: { ...spawned, model: "subject-model" },
      })
    : null;
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  await client.close();
  if (spawnedId !== null) {
    appendEvent(t.db, {
      taskId: task.id,
      workerId: "reef-crab",
      origin: "board",
      at: t.clock.now(),
      payload: {
        kind: "worker_exited",
        exit_code: 0,
        signal: null,
        stderr_tail: null,
        reported_error: null,
        last_message: null,
        worker_spawned_event_id: spawnedId,
        usage,
      },
    });
  }
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "review" && x.parent_id === task.id,
  );
  return { task, review, spawnedId };
}

/** worker が MCP の complete_task で review を完了する —— 後始末が poll を促す。 */
async function completeReview(t: Tidepool, reviewId: string) {
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, reviewId);
  await client.callTool({
    name: "complete_task",
    arguments: { handoff: { ...FULL_HANDOFF, outcome: "accepted with one nit" } },
  });
  await client.close();
}

/** 人間が書き手の完了(worker_id human の task_completed)を置く —— poll は促さない。統合点レビューは盤面が agent 名義で
 *  登録し review_by も human を拒むので、人間の扉で完了できる公開の経路が今は無く、完了の verb を直に呼ぶ。 */
function completeReviewByHand(t: Tidepool, reviewId: string) {
  completeTask(t.db, getTask(t.db, reviewId)!, { ...FULL_HANDOFF, outcome: "accepted by hand" }, HUMAN_WORKER_ID, t.clock.now(), "webui");
}

const events = async (t: Tidepool, taskId: string, kind: string) =>
  (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter((e: any) => e.kind === kind);
const annotations = (t: Tidepool, taskId: string) => events(t, taskId, "allocation_reviewed");
const failures = (t: Tidepool, taskId: string) => events(t, taskId, "allocation_review_failed");

/** Board call の model(fable)の窓を閉じる / 開ける。 */
function reportFableWindow(t: Tidepool, throttled: boolean) {
  const resumesAt = new Date(t.clock.now().getTime() + HOUR);
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: t.clock.now(),
    windows: [
      { window: "fable", model: "fable", usedPercent: throttled ? 100 : 10, durationMs: HOUR, resetsAt: resumesAt, throttled, resumesAt: throttled ? resumesAt : null },
    ],
  });
}

it("統合点レビューを worker が MCP で完了した後の poll で、sweep が被レビュー task の episode に配分評価の注釈を1件だけ載せ、Board call は verdict・findings・実行設定を受け取る", async () => {
  const allocationClient = new FakeAllocationClient();
  allocationClient.scriptJudgment({
    allocation: "overpowered",
    cause: "uncertain",
    evidence: "a small diff, no consultations",
  });
  t = await bootTidepool({ allocationClient });
  const { task, review, spawnedId } = await reviewedWork(t);

  await completeReview(t, review.id);
  await nextPoll(t);

  expect((await annotations(t, task.id)).map((e: any) => e.payload)).toEqual([
    {
      kind: "allocation_reviewed",
      review_task_id: review.id,
      worker_spawned_event_id: spawnedId,
      judge: { provider: "anthropic", model: "claude-fable-5-1", effort: "high" },
      allocation: "overpowered",
      cause: "uncertain",
      evidence: "a small diff, no consultations",
    },
  ]);
  expect(allocationClient.calls).toEqual([
    {
      input: {
        verdict: "accepted with one nit",
        findings: expect.stringContaining("accepted with one nit"),
        setting: {
          provider: "anthropic",
          model: "subject-model",
          effort: "high",
          advisor: "fable",
          source: { tier: "task", provider: "only" },
        },
        requested_tier: "standard",
        usage,
        actions: null,
      },
      // the board's own frontier row (seed), never the reviewed session's model
      setting: expect.objectContaining({ model: "claude-fable-5-1", effort: "high" }),
    },
  ]);
});

it("人間が完了した統合点レビューも評価される —— 完了そのものは撃たず、次の poll の sweep が撃つ", async () => {
  const allocationClient = new FakeAllocationClient();
  t = await bootTidepool({ allocationClient });
  const { task, review, spawnedId } = await reviewedWork(t);

  completeReviewByHand(t, review.id);
  expect(allocationClient.calls).toEqual([]);
  expect(await annotations(t, task.id)).toEqual([]);
  await nextPoll(t);

  expect((await annotations(t, task.id)).map((e: any) => e.payload)).toMatchObject([{ review_task_id: review.id, worker_spawned_event_id: spawnedId }]);
  expect(allocationClient.calls.map((c) => c.input.verdict)).toEqual(["accepted by hand"]);
});

it("撃って失敗すると review の完了 event を鍵にした失敗 event だけが残り、注釈は無く、完了は倒れない", async () => {
  const allocationClient = new FakeAllocationClient();
  allocationClient.scriptFailure(new Error("claude CLI timed out"));
  t = await bootTidepool({ allocationClient });
  const { task, review } = await reviewedWork(t);

  await completeReview(t, review.id);
  await nextPoll(t);

  const [completed] = await events(t, review.id, "task_completed");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${review.id}`)).json.status).toBe("done");
  expect(await annotations(t, task.id)).toEqual([]);
  expect((await failures(t, task.id)).map((e: any) => [e.worker_id, e.origin, e.payload])).toEqual([
    [
      "tidepool",
      "board",
      { kind: "allocation_review_failed", review_completed_event_id: completed.id, review_task_id: review.id, reviewed_task_id: task.id, reason: "claude CLI timed out" },
    ],
  ]);
});

it("撃って失敗してから1時間未満の poll では撃たず、1時間以上空けた poll で撃ち直して注釈が載る", async () => {
  const allocationClient = new FakeAllocationClient();
  allocationClient.scriptFailure(new Error("claude CLI timed out"));
  t = await bootTidepool({ allocationClient });
  const { task, review, spawnedId } = await reviewedWork(t);
  await completeReview(t, review.id);
  allocationClient.scriptJudgment({ allocation: "appropriate", cause: "uncertain", evidence: "fine" });

  await t.clock.advance(HOUR / 2);
  await nextPoll(t);
  expect(allocationClient.calls).toHaveLength(1);
  await t.clock.advance(HOUR / 2);
  await nextPoll(t);

  expect(allocationClient.calls).toHaveLength(2);
  expect((await annotations(t, task.id)).map((e: any) => e.payload)).toMatchObject([
    { review_task_id: review.id, worker_spawned_event_id: spawnedId, allocation: "appropriate" },
  ]);
});

it("撃って3回失敗すると、以後の tick では撃たない", async () => {
  const allocationClient = new FakeAllocationClient();
  allocationClient.scriptFailure(new Error("claude CLI timed out"));
  t = await bootTidepool({ allocationClient });
  const { task, review } = await reviewedWork(t);
  await completeReview(t, review.id);

  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);
  expect(await failures(t, task.id)).toHaveLength(3);
  await t.clock.advance(HOUR);
  await t.clock.advance(HOUR);

  expect(allocationClient.calls).toHaveLength(3);
  expect(await failures(t, task.id)).toHaveLength(3);
});

it("Board call の model の窓が閉じている間は client を呼ばず何も書かず、窓が開いた次の poll で撃つ", async () => {
  const allocationClient = new FakeAllocationClient();
  t = await bootTidepool({ allocationClient });
  const { task, review } = await reviewedWork(t);
  reportFableWindow(t, true);

  completeReviewByHand(t, review.id);
  await nextPoll(t);
  expect(allocationClient.calls).toEqual([]);
  expect([...(await annotations(t, task.id)), ...(await failures(t, task.id))]).toEqual([]);
  reportFableWindow(t, false);
  await nextPoll(t);

  expect(await annotations(t, task.id)).toHaveLength(1);
});

it("被レビュー task に worker session の記録が無ければ client を呼ばず何も書かない(1時間後の tick でも)", async () => {
  const allocationClient = new FakeAllocationClient();
  t = await bootTidepool({ allocationClient });
  const { task, review } = await reviewedWork(t, { session: false });

  await completeReview(t, review.id);
  await nextPoll(t);
  await t.clock.advance(HOUR);

  expect(allocationClient.calls).toEqual([]);
  expect([...(await annotations(t, task.id)), ...(await failures(t, task.id))]).toEqual([]);
});

it("review の完了の後に被レビュー task が再 spawn されても、撃つ時点で問うのは完了より前の session", async () => {
  const allocationClient = new FakeAllocationClient();
  t = await bootTidepool({ allocationClient });
  const { task, review, spawnedId } = await reviewedWork(t);
  completeReviewByHand(t, review.id);
  appendEvent(t.db, { taskId: task.id, workerId: "reef-crab", origin: "board", at: t.clock.now(), payload: { ...spawned, model: "respawned-model" } });

  await nextPoll(t);

  expect((await annotations(t, task.id)).map((e: any) => e.payload.worker_spawned_event_id)).toEqual([spawnedId]);
  expect(allocationClient.calls.map((c) => [c.input.setting.model, c.input.usage])).toEqual([["subject-model", usage]]);
});

it("盤面設定 retrospective_tier を standard にすると、次の配分評価は anthropic × standard の行で撃たれ、judge もその行を指す(issue #914)", async () => {
  const allocationClient = new FakeAllocationClient();
  t = await bootTidepool({ allocationClient });
  const { task, review, spawnedId } = await reviewedWork(t);
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "retrospective_tier", value: "standard" })).status).toBe(200);

  await completeReview(t, review.id);
  await nextPoll(t);

  expect((await annotations(t, task.id)).map((e: any) => e.payload)).toMatchObject([
    {
      worker_spawned_event_id: spawnedId,
      judge: { provider: "anthropic", model: "claude-opus-5-5", effort: "high" },
    },
  ]);
  expect(allocationClient.calls).toEqual([
    expect.objectContaining({ setting: expect.objectContaining({ model: "claude-opus-5-5", effort: "high" }) }),
  ]);
});

it("選んだティアの anthropic 行が無ければ、frontier に退避せず client を呼ばず何も書かない(issue #914)", async () => {
  const allocationClient = new FakeAllocationClient();
  t = await bootTidepool({ allocationClient });
  const { task, review } = await reviewedWork(t);
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "retrospective_tier", value: "standard" })).status).toBe(200);
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "anthropic", model: "claude-opus-5-5" })).status).toBe(200);

  await completeReview(t, review.id);
  await nextPoll(t);

  expect(allocationClient.calls).toEqual([]);
  expect([...(await annotations(t, task.id)), ...(await failures(t, task.id))]).toEqual([]);
});
