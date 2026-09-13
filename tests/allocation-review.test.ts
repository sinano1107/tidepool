import { afterEach, expect, it } from "vitest";
import { buildAllocationReviewInput } from "../src/allocation-review.js";
import { appendEvent, type EventPayload } from "../src/events.js";
import { reportProviderUsage } from "../src/throttle.js";
import { FakeAllocationClient } from "./fakes.js";
import { api, bootTidepool, FULL_HANDOFF, HOUR, mcpClient, type Tidepool } from "./harness.js";

let t: Tidepool;
afterEach(() => t?.stop());

const spawned: Extract<EventPayload, { kind: "worker_spawned" }> = {
  kind: "worker_spawned",
  registry_commit: "commit",
  definition_version: "1",
  advisor: "fable",
  provider: "anthropic",
  model: "opus",
  effort: "high",
  source: { tier: "task", provider: "only" },
  harness: "claude-code",
  cli_version: "1",
};

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

async function completeReview(t: Tidepool, reviewId: string) {
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, reviewId);
  await client.callTool({
    name: "complete_task",
    arguments: { handoff: { ...FULL_HANDOFF, outcome: "accepted with one nit" } },
  });
  await client.close();
}

async function annotations(t: Tidepool, taskId: string) {
  return (await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter(
    (e: any) => e.kind === "allocation_reviewed",
  );
}

it("統合点レビューの完了で被レビュー task の episode に配分評価の注釈が1件だけ生まれ、Board call は verdict・findings・実行設定を受け取る", async () => {
  const allocationClient = new FakeAllocationClient();
  allocationClient.scriptJudgment({
    allocation: "overpowered",
    cause: "uncertain",
    evidence: "a small diff, no consultations",
  });
  t = await bootTidepool({ allocationClient });
  const { task, review, spawnedId } = await reviewedWork(t);

  await completeReview(t, review.id);

  expect((await annotations(t, task.id)).map((e: any) => e.payload)).toEqual([
    {
      kind: "allocation_reviewed",
      review_task_id: review.id,
      worker_spawned_event_id: spawnedId,
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
      setting: expect.objectContaining({ model: "fable", effort: "high" }),
    },
  ]);
});

it("Board call の失敗は完了を倒さず、注釈は「未評価」の理由コードで1件残る(空と区別)", async () => {
  const allocationClient = new FakeAllocationClient();
  allocationClient.scriptFailure(new Error("claude CLI timed out"));
  t = await bootTidepool({ allocationClient });
  const { task, review, spawnedId } = await reviewedWork(t);

  await completeReview(t, review.id);

  expect((await api(t.baseUrl, "GET", `/api/tasks/${review.id}`)).json.status).toBe("done");
  expect((await annotations(t, task.id)).map((e: any) => e.payload)).toEqual([
    {
      kind: "allocation_reviewed",
      review_task_id: review.id,
      worker_spawned_event_id: spawnedId,
      unevaluated: "board_call_failed",
    },
  ]);
});

it("Board call の model の窓が閉じている間は client を呼ばず、注釈は throttled で残る", async () => {
  const allocationClient = new FakeAllocationClient();
  t = await bootTidepool({ allocationClient });
  const { task, review } = await reviewedWork(t);
  reportProviderUsage(t.db, {
    provider: "anthropic",
    status: "observed",
    plan: null,
    cliVersion: null,
    observedAt: t.clock.now(),
    windows: [
      {
        window: "fable",
        model: "fable",
        usedPercent: 100,
        durationMs: HOUR,
        resetsAt: new Date(t.clock.now().getTime() + HOUR),
        throttled: true,
        resumesAt: new Date(t.clock.now().getTime() + HOUR),
      },
    ],
  });

  await completeReview(t, review.id);

  expect((await annotations(t, task.id)).map((e: any) => e.payload)).toMatchObject([
    { unevaluated: "throttled" },
  ]);
  expect(allocationClient.calls).toEqual([]);
});

it("被レビュー task に worker session の記録が無ければ client を呼ばず、注釈は no_session で残る", async () => {
  const allocationClient = new FakeAllocationClient();
  t = await bootTidepool({ allocationClient });
  const { task, review } = await reviewedWork(t, { session: false });

  await completeReview(t, review.id);

  expect((await annotations(t, task.id)).map((e: any) => e.payload)).toEqual([
    {
      kind: "allocation_reviewed",
      review_task_id: review.id,
      worker_spawned_event_id: null,
      unevaluated: "no_session",
    },
  ]);
  expect(allocationClient.calls).toEqual([]);
});
