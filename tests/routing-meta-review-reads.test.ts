import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, type EventPayload } from "../src/events.js";
import { applyExecutionSettingsChange, type ExecutionSetting } from "../src/execution-setting.js";
import { recordShadow } from "../src/learner.js";
import { registerMetaReview } from "../src/meta-review.js";
import { listAllocations, listRoutingCells, listRoutingShadow } from "../src/routing-review.js";
import { registerTask } from "../src/tasks.js";

/** 主題 routing の meta-review の読み口(issue #917 / spec #916 C)のドメイン層。verb への写像はサーバ境界
 *  (tests/routing-meta-review.test.ts)が言う。 */
const at = new Date("2026-09-23T00:00:00.000Z");

const setting = (provider: ExecutionSetting["provider"], model: string): ExecutionSetting => ({
  provider,
  model,
  effort: "high",
  advisor: undefined,
  source: { tier: "agent", provider: "rank" },
});
const opus = setting("anthropic", "opus");
const sol = setting("openai", "gpt-5.6-sol");

function board() {
  const db = openDb(":memory:");
  const work = (title: string) => registerTask(db, { type: "work", title, purpose: "p", completion_criteria: "c" }, at);
  const spawn = (taskId: string, agent: string, run: ExecutionSetting, tier: "agent" | "task" = "agent") =>
    appendEvent(db, {
      taskId,
      workerId: agent,
      origin: "board",
      at,
      payload: {
        kind: "worker_spawned",
        registry_commit: "c",
        definition_version: "1",
        advisor: null,
        provider: run.provider,
        model: run.model,
        effort: run.effort,
        source: { tier, provider: "rank" },
        harness: run.provider === "openai" ? "codex" : "claude-code",
        cli_version: "1",
      },
    });
  const exit = (taskId: string, spawned: number, models: string[] = [], cost = 0.5) => {
    const tokens = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: cost };
    return appendEvent(db, {
      taskId,
      workerId: "board",
      origin: "board",
      at,
      payload: {
        kind: "worker_exited",
        exit_code: 0,
        signal: null,
        stderr_tail: null,
        worker_spawned_event_id: spawned,
        usage: { ...tokens, advisor: null, models: Object.fromEntries(models.map((m) => [m, tokens])) },
      },
    });
  };
  /** outcome = judge と、評価(allocation / cause / evidence)または unevaluated。 */
  const allocate = (taskId: string, spawned: number, outcome: object) =>
    appendEvent(db, {
      taskId,
      workerId: "tidepool",
      origin: "board",
      at,
      payload: { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: spawned, ...outcome } as Extract<EventPayload, { kind: "allocation_reviewed" }>,
    });
  /** 登録された routing meta-review(読み手)。 */
  const routingReview = () => {
    registerMetaReview(db, "routing", at);
    return (db.prepare("SELECT id FROM tasks WHERE meta_review_subject = 'routing' ORDER BY rowid DESC").get() as { id: string }).id;
  };
  return { db, work, spawn, exit, allocate, routingReview };
}

const judge = { provider: "anthropic" as const, model: "fable", effort: "high" };

it("list_routing_shadow は shadow 行をその pickup が開いた session の agent・outcome・費用と結び、diverged_only で推薦と実際が分かれた行だけに絞る", () => {
  const { db, work, spawn, exit, allocate, routingReview } = board();
  const diverged = work("diverged");
  const agreed = work("agreed");
  // 分かれた pickup が2回: 1回目は spawn に辿り着かず、2回目の session が capability で退けられた
  recordShadow(db, diverged, [sol, opus], opus, at);
  recordShadow(db, diverged, [sol, opus], opus, at);
  const second = spawn(diverged.id, "reef-crab", opus);
  exit(diverged.id, second, [], 1.25);
  allocate(diverged.id, second, { judge, allocation: "underpowered", cause: "capability", evidence: "e" });
  recordShadow(db, agreed, [opus], opus, at);
  spawn(agreed.id, "deckhand", opus);
  const reader = routingReview();

  const cell = (s: ExecutionSetting) => ({ provider: s.provider, model: s.model, effort: s.effort, advisor: null });
  expect(listRoutingShadow(db, reader, {})).toEqual({
    shadow: [
      { task_id: diverged.id, recommended: cell(sol), actual: cell(opus), source: opus.source, basis: "prior", diverged: true, created_at: at.toISOString(), worker_spawned_event_id: null, agent: null, outcome: null, cost_usd: null, duration_ms: null },
      { task_id: diverged.id, recommended: cell(sol), actual: cell(opus), source: opus.source, basis: "prior", diverged: true, created_at: at.toISOString(), worker_spawned_event_id: second, agent: "reef-crab", outcome: "rejected", cost_usd: 1.25, duration_ms: 0 },
      { task_id: agreed.id, recommended: cell(opus), actual: cell(opus), source: opus.source, basis: "data", diverged: false, created_at: at.toISOString(), worker_spawned_event_id: expect.any(Number), agent: "deckhand", outcome: "excluded", cost_usd: null, duration_ms: null },
    ],
    truncated: false,
  });
  expect(listRoutingShadow(db, reader, { diverged_only: true }).shadow.map((r) => r.worker_spawned_event_id)).toEqual([null, second]);
});

it("読み口の既定の窓は読み手より前の routing の登録の watermark から —— 読み手自身の登録も memory の登録も窓を動かさない", () => {
  const { db, work, spawn, exit, allocate, routingReview } = board();
  const before = work("before");
  recordShadow(db, before, [opus], opus, at);
  const old = spawn(before.id, "deckhand", sol);
  exit(before.id, old, ["gpt-5.6-sol"]);
  allocate(before.id, old, { judge, allocation: "appropriate", cause: "uncertain", evidence: "e" });
  applyExecutionSettingsChange(db, { setting: "row", row: { provider: "openai", tier: "standard", model: "gpt-5.6-sol", effort: "high", price_in: 1, price_out: 2 } }, "webui", at);
  routingReview(); // 前回
  const after = work("after");
  recordShadow(db, after, [opus], opus, at);
  const fresh = spawn(after.id, "deckhand", opus);
  exit(after.id, fresh, ["claude-opus-4-1"]);
  allocate(after.id, fresh, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  applyExecutionSettingsChange(db, { setting: "row", row: { provider: "anthropic", tier: "frontier", model: "claude-opus-4-1", effort: "max", price_in: 5, price_out: 25 } }, "mcp", at);
  applyExecutionSettingsChange(db, { setting: "priority", value: "cost" }, "webui", at);
  registerMetaReview(db, "memory", at);
  const reader = routingReview();

  expect(listRoutingShadow(db, reader, {}).shadow.map((r) => r.task_id)).toEqual([after.id]);
  expect(listAllocations(db, reader, {}).allocations.map((a) => a.allocation)).toEqual(["overpowered"]);
  expect(listRoutingCells(db, reader, {})).toMatchObject({
    cells: [{ cell: { provider: "anthropic", model: "claude-opus-4-1" } }],
    rows: [{ origin: "mcp", row: { model: "claude-opus-4-1", effort: "max" } }],
  });
  // since_watermark を渡せば前回より前も読める
  expect(listRoutingShadow(db, reader, { since_watermark: 0 }).shadow.map((r) => r.task_id)).toEqual([before.id, after.id]);
});

it("list_allocations は評価された注釈を source.tier × agent × allocation × cause で数え、judge の model が worker のセルと同じ件数を添える —— unevaluated は数えない", () => {
  const { db, work, spawn, exit, allocate, routingReview } = board();
  const task = work("t");
  // 観測された具体 id(claude-fable-5)は表の alias 行(fable)の judge と同じ model
  const selfJudged = spawn(task.id, "reef-crab", setting("anthropic", "fable"));
  exit(task.id, selfJudged, ["claude-fable-5"]);
  allocate(task.id, selfJudged, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  const other = spawn(task.id, "reef-crab", opus);
  allocate(task.id, other, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  const declared = spawn(task.id, "reef-crab", opus, "task");
  allocate(task.id, declared, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  const unjudged = spawn(task.id, "deckhand", opus);
  allocate(task.id, unjudged, { judge: null, allocation: "appropriate", cause: "uncertain", evidence: "e" });
  allocate(task.id, unjudged, { judge, unevaluated: "throttled" });

  expect(listAllocations(db, routingReview(), {})).toEqual({
    allocations: [
      { source_tier: "agent", agent: "reef-crab", allocation: "overpowered", cause: "uncertain", count: 2, judged_by_same_model: 1 },
      { source_tier: "task", agent: "reef-crab", allocation: "overpowered", cause: "uncertain", count: 1, judged_by_same_model: 0 },
      { source_tier: "agent", agent: "deckhand", allocation: "appropriate", cause: "uncertain", count: 1, judged_by_same_model: 0 },
    ],
    truncated: false,
  });
});

it("list_routing_cells の新セルは終わった session で初めて観測されたセルで、窓より前に観測済みのセルは再び走っても出ない", () => {
  const { db, work, spawn, exit, routingReview } = board();
  const task = work("t");
  exit(task.id, spawn(task.id, "deckhand", opus), ["claude-opus-4-1"]);
  routingReview();
  exit(task.id, spawn(task.id, "deckhand", opus), ["claude-opus-4-1"]); // 既知
  spawn(task.id, "deckhand", sol); // 終わっていない session は観測ではない
  const seen = exit(task.id, spawn(task.id, "deckhand", setting("moonshot", "kimi-k3")), []);

  expect(listRoutingCells(db, routingReview(), {})).toEqual({
    cells: [{ cell: { provider: "moonshot", model: "kimi-k3", effort: "high", advisor: null }, first_observed_event_id: seen }],
    rows: [],
    truncated: false,
  });
});
