import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, type EventPayload } from "../src/events.js";
import { applyExecutionSettingsChange, type ExecutionSetting, loadExecutionSettingTable } from "../src/execution-setting.js";
import { aggregateCells, loadEpisodes, recordShadow, selectorBranch } from "../src/learner.js";
import { toolResult } from "../src/mcp.js";
import { registerMetaReview } from "../src/meta-review.js";
import { listAllocations, listRoutingCells, listRoutingShadow, proposeRoutingChange, readRoutingSettings } from "../src/routing-review.js";
import { getTask, registerTask } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { answerQuestionViaWebui, executionSetting, HUMAN_WEBUI, QUIET_EXIT, RESPONSE_BUDGET_BYTES, WORKER_SPAWNED } from "./harness.js";

/** 主題 routing の meta-review の読み口(issue #917 / spec #916 C)のドメイン層。verb への写像はサーバ境界
 *  (tests/routing-meta-review.test.ts)が言う。 */
const at = new Date("2026-09-23T00:00:00.000Z");

const opus = executionSetting("anthropic", "claude-opus-5-5");
const sol = executionSetting("openai", "gpt-5.6-sol");

function board() {
  const db = openDb(":memory:");
  const work = (title: string, tier?: string) => registerTask(db, { type: "work", title, purpose: "p", completion_criteria: "c", tier }, at, ...HUMAN_WEBUI);
  const spawn = (taskId: string, agent: string, run: ExecutionSetting, tier: "agent" | "task" = "agent") =>
    appendEvent(db, {
      taskId,
      workerId: agent,
      origin: "board",
      at,
      payload: {
        ...WORKER_SPAWNED,
        advisor: null,
        provider: run.provider,
        model: run.model,
        effort: run.effort,
        tier_id: run.tier_id,
        source: { tier, provider: "rank" },
        harness: run.provider === "openai" ? "codex" : "claude-code",
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
        ...QUIET_EXIT,
        worker_spawned_event_id: spawned,
        output_closed: true,
        usage: { ...tokens, advisor: null, model_swaps: [], refusals: [], models: Object.fromEntries(models.map((m) => [m, tokens])) },
      },
    });
  };
  /** outcome = judge と評価(allocation / cause / evidence)。 */
  const allocate = (taskId: string, spawned: number, outcome: object) =>
    appendEvent(db, {
      taskId,
      workerId: "tidepool",
      origin: "board",
      at,
      payload: { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: spawned, ...outcome } as Extract<EventPayload, { kind: "allocation_reviewed" }>,
    });
  /** 登録された routing meta-review(読み手)。done にすれば次の登録の「前回」になる(setup のみ、ADR 0193)。 */
  const routingReview = (done = false) => {
    registerMetaReview(db, "routing", at);
    const id = (db.prepare("SELECT id FROM tasks WHERE meta_review_subject = 'routing' ORDER BY rowid DESC").get() as { id: string }).id;
    if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(id);
    return id;
  };
  return { db, work, spawn, exit, allocate, routingReview };
}

const judge = { provider: "anthropic" as const, model: "claude-fable-5-1", effort: "high" };

const none = { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 } };
/** recordShadow へ渡す組(setup のみ): 実績は空、候補は2行。 */
const shadow = (recommended: ExecutionSetting, actual: ExecutionSetting, basis: "prior" | "data") => ({
  recommended,
  actual,
  basis,
  recommended_record: none,
  actual_record: none,
  candidates: 2,
});

it("list_routing_shadow は shadow 行をその pickup が開いた session の agent・outcome・費用と結び、diverged_only で推薦と実際が分かれた行だけに絞る", () => {
  const { db, work, spawn, exit, allocate, routingReview } = board();
  const diverged = work("diverged");
  const agreed = work("agreed");
  // 分かれた pickup が2回: 1回目は spawn に辿り着かず、2回目の session が capability で退けられた
  recordShadow(db, diverged.id, shadow(sol, opus, "prior"), at);
  recordShadow(db, diverged.id, shadow(sol, opus, "prior"), at);
  const second = spawn(diverged.id, "reef-crab", opus);
  exit(diverged.id, second, [], 1.25);
  allocate(diverged.id, second, { judge, allocation: "underpowered", cause: "capability", evidence: "e" });
  recordShadow(db, agreed.id, shadow(opus, opus, "data"), at);
  spawn(agreed.id, "deckhand", opus);
  const reader = routingReview();

  const cell = (s: ExecutionSetting) => ({ provider: s.provider, model: s.model, effort: s.effort, advisor: null });
  expect(listRoutingShadow(db, reader, {})).toEqual({
    shadow: [
      { task_id: diverged.id, recommended: cell(sol), actual: cell(opus), source: opus.source, basis: "prior", recommended_record: none, actual_record: none, candidates: 2, diverged: true, created_at: at.toISOString(), worker_spawned_event_id: null, agent: null, outcome: null, cost_usd: null, duration_ms: null },
      { task_id: diverged.id, recommended: cell(sol), actual: cell(opus), source: opus.source, basis: "prior", recommended_record: none, actual_record: none, candidates: 2, diverged: true, created_at: at.toISOString(), worker_spawned_event_id: second, agent: "reef-crab", outcome: "rejected", cost_usd: 1.25, duration_ms: 0 },
      { task_id: agreed.id, recommended: cell(opus), actual: cell(opus), source: opus.source, basis: "data", recommended_record: none, actual_record: none, candidates: 2, diverged: false, created_at: at.toISOString(), worker_spawned_event_id: expect.any(Number), agent: "deckhand", outcome: "excluded", cost_usd: null, duration_ms: null },
    ],
  });
  expect(listRoutingShadow(db, reader, { diverged_only: true }).shadow.map((r) => r.worker_spawned_event_id)).toEqual([null, second]);
});

it("shadow 行は書いた時点の両セルの受理数・却下数と除外後の候補数を運び、後から episode が増えても行の値は変わらない —— 昇格後の行も同じ欄を持つ(ADR 0181 決定5)", () => {
  const { db, work, spawn, allocate, routingReview } = board();
  const rejectedSession = (run: ExecutionSetting) => {
    const task = work("earlier");
    allocate(task.id, spawn(task.id, "deckhand", run), { judge, allocation: "underpowered", cause: "capability", evidence: "e" });
  };
  // opus は却下2件、sol は却下1件 —— 学習器は sol を推薦する
  rejectedSession(opus);
  rejectedSession(opus);
  rejectedSession(sol);
  const later = work("later");
  const branch = (promoted: boolean) => {
    const episodes = loadEpisodes(db);
    return selectorBranch({ promoted, candidates: [opus, sol], board: aggregateCells(episodes), workspace: aggregateCells(episodes.filter((e) => e.workspace === null)) }).shadow;
  };
  recordShadow(db, later.id, branch(false), at);
  recordShadow(db, later.id, branch(true), at);
  const reader = routingReview();
  const opusRecord = { board: { accepted: 0, rejected: 2 }, workspace: { accepted: 0, rejected: 2 } };
  const solRecord = { board: { accepted: 0, rejected: 1 }, workspace: { accepted: 0, rejected: 1 } };
  const expected = [
    { recommended: { model: "gpt-5.6-sol" }, actual: { model: "claude-opus-5-5" }, recommended_record: solRecord, actual_record: opusRecord, candidates: 2 },
    { recommended: { model: "claude-opus-5-5" }, actual: { model: "gpt-5.6-sol" }, source: { provider: "learner" }, recommended_record: opusRecord, actual_record: solRecord, candidates: 2 },
  ];
  expect(listRoutingShadow(db, reader, { since_watermark: 0 }).shadow).toMatchObject(expected);

  rejectedSession(sol);
  rejectedSession(sol);

  expect(listRoutingShadow(db, reader, { since_watermark: 0 }).shadow).toMatchObject(expected);
});

it("読み口の既定の窓は読み手より前に完了した routing の登録の watermark から —— 読み手自身の登録も memory の登録も窓を動かさない", () => {
  const { db, work, spawn, exit, allocate, routingReview } = board();
  const before = work("before");
  recordShadow(db, before.id, shadow(opus, opus, "prior"), at);
  const old = spawn(before.id, "deckhand", sol);
  exit(before.id, old, ["gpt-5.6-sol"]);
  allocate(before.id, old, { judge, allocation: "appropriate", cause: "uncertain", evidence: "e" });
  const solKey = { provider: "openai", model: "gpt-5.6-sol", effort: "high" } as const;
  applyExecutionSettingsChange(db, { setting: "row", key: solKey, row: { ...solKey, tier: "standard", price_in: 1, price_out: 2 } }, "webui", at);
  routingReview(true); // 前回
  const after = work("after");
  recordShadow(db, after.id, shadow(opus, opus, "prior"), at);
  const fresh = spawn(after.id, "deckhand", opus);
  exit(after.id, fresh, ["claude-opus-5-5-20261001"]); // セルは使用量の内訳の鍵でなく pin の綴り(ADR 0182 決定3)
  allocate(after.id, fresh, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  applyExecutionSettingsChange(db, { setting: "row", row: { provider: "anthropic", tier: "frontier", model: "claude-opus-5", effort: "max", price_in: 5, price_out: 25 } }, "mcp", at);
  applyExecutionSettingsChange(db, { setting: "priority", value: "cost" }, "webui", at);
  registerMetaReview(db, "memory", at);
  const reader = routingReview();

  expect(listRoutingShadow(db, reader, {}).shadow.map((r) => r.task_id)).toEqual([after.id]);
  expect(listAllocations(db, reader, {}).allocations.map((a) => a.allocation)).toEqual(["overpowered"]);
  expect(listRoutingCells(db, reader, {})).toMatchObject({
    cells: [{ cell: { provider: "anthropic", model: "claude-opus-5-5" } }],
    rows: [{ origin: "mcp", row: { model: "claude-opus-5", effort: "max" } }],
  });
  // since_watermark を渡せば前回より前も読める
  expect(listRoutingShadow(db, reader, { since_watermark: 0 }).shadow.map((r) => r.task_id)).toEqual([before.id, after.id]);
});

it("list_allocations は評価された注釈を source.tier × 段 × agent × allocation × cause で数え、judge の model が worker のセルと同じ件数を添える —— 段はどの出所の注釈にも走った段が付く(ADR 0210 決定5)", () => {
  const { db, work, spawn, allocate, routingReview } = board();
  const task = work("t", "standard");
  // judge と同じ綴りの pin だけが同じ model —— 照合は学習器のセルと同じ完全一致で、前方一致する綴りは数えない(ADR 0182 決定3)
  const selfJudged = spawn(task.id, "reef-crab", executionSetting("anthropic", "claude-fable-5-1"));
  allocate(task.id, selfJudged, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  const longContext = spawn(task.id, "reef-crab", executionSetting("anthropic", "claude-fable-5-1[1m]"));
  allocate(task.id, longContext, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  const other = spawn(task.id, "reef-crab", opus);
  allocate(task.id, other, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  const declared = spawn(task.id, "reef-crab", { ...opus, tier_id: tierIdOf(db, "standard") }, "task");
  allocate(task.id, declared, { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
  const deckhand = spawn(task.id, "deckhand", opus);
  allocate(task.id, deckhand, { judge, allocation: "appropriate", cause: "uncertain", evidence: "e" });

  expect(listAllocations(db, routingReview(), {})).toEqual({
    allocations: [
      { source_tier: "agent", tier: "economy", agent: "reef-crab", allocation: "overpowered", cause: "uncertain", count: 3, judged_by_same_model: 1 },
      { source_tier: "task", tier: "standard", agent: "reef-crab", allocation: "overpowered", cause: "uncertain", count: 1, judged_by_same_model: 0 },
      { source_tier: "agent", tier: "economy", agent: "deckhand", allocation: "appropriate", cause: "uncertain", count: 1, judged_by_same_model: 0 },
    ],
  });
});

it("list_allocations は書き手が人間の task の申告も段ごとに数え、消した段と同じ名前で足し直した段の注釈を混ぜない(ADR 0200 決定7・追記)", () => {
  const { db, work, spawn, allocate, routingReview } = board();
  const insertScratch = () => applyExecutionSettingsChange(db, { setting: "insert_tier", name: "scratch", description: "d", position: 0 }, "webui", at);
  const declared = (title: string, tier: string) => {
    const task = work(title, tier);
    allocate(task.id, spawn(task.id, "deckhand", { ...opus, tier_id: tierIdOf(db, tier) }, "task"), { judge, allocation: "overpowered", cause: "uncertain", evidence: "e" });
    return task;
  };
  insertScratch();
  const retired = declared("retired", "scratch");
  // setup のみ: 決着した task は段の削除を止めない
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(retired.id);
  applyExecutionSettingsChange(db, { setting: "delete_tier", name: "scratch" }, "webui", at);
  insertScratch();
  declared("live", "scratch");
  declared("economy", "economy");

  const group = { source_tier: "task", agent: "deckhand", allocation: "overpowered", cause: "uncertain", count: 1, judged_by_same_model: 0 };
  expect(listAllocations(db, routingReview(), {}).allocations).toEqual([
    { ...group, tier: "scratch", tier_retired: true },
    { ...group, tier: "scratch" },
    { ...group, tier: "economy" },
  ]);
});

it("list_routing_cells の新セルは終わった session で初めて観測されたセルで、窓より前に観測済みのセルは再び走っても出ない", () => {
  const { db, work, spawn, exit, routingReview } = board();
  const task = work("t");
  exit(task.id, spawn(task.id, "deckhand", opus), ["claude-opus-5-5"]);
  routingReview(true);
  exit(task.id, spawn(task.id, "deckhand", opus), ["claude-opus-5-5"]); // 既知
  spawn(task.id, "deckhand", sol); // 終わっていない session は観測ではない
  const seen = exit(task.id, spawn(task.id, "deckhand", executionSetting("moonshot", "kimi-k3")), []);

  expect(listRoutingCells(db, routingReview(), {})).toEqual({
    cells: [{ cell: { provider: "moonshot", model: "kimi-k3", effort: "high", advisor: null }, first_observed_event_id: seen }],
    rows: [],
  });
});

it("effort「無い」のセルは shadow 行と list_routing_cells で effort null として読める(ADR 0218 決定5)", () => {
  const { db, work, spawn, exit, routingReview } = board();
  const haiku = executionSetting("anthropic", "claude-haiku-4-5-20251001", { effort: null });
  const task = work("t");
  recordShadow(db, task.id, shadow(haiku, haiku, "prior"), at);
  const seen = exit(task.id, spawn(task.id, "deckhand", haiku), [haiku.model]);
  const reader = routingReview();

  const cell = { provider: "anthropic", model: haiku.model, effort: null, advisor: null };
  expect(listRoutingShadow(db, reader, {}).shadow).toEqual([expect.objectContaining({ recommended: cell, actual: cell })]);
  expect(listRoutingCells(db, reader, {}).cells).toEqual([{ cell, first_observed_event_id: seen }]);
});

it("list_routing_cells の人間が変えた行は settings タブ / 管理MCP の直接編集だけで、提案 question への approve の適用は含まない(ADR 0151)", () => {
  const { db, routingReview } = board();
  const row = { provider: "anthropic" as const, tier: "standard" as const, model: "claude-opus-5", effort: "high", price_in: 5, price_out: 25 };
  applyExecutionSettingsChange(db, { setting: "row", row: { ...row, tier: "frontier" } }, "webui", at, "question-1");
  applyExecutionSettingsChange(db, { setting: "row", key: { provider: row.provider, model: row.model, effort: "high" }, row: { ...row, effort: "max" } }, "mcp", at);
  const reader = routingReview();

  expect(listRoutingCells(db, reader, { since_watermark: 0 }).rows).toMatchObject([{ origin: "mcp", row: { effort: "max" } }]);
});

// 応答予算(ADR 0195 / issue #1390): 読み口は予算に収まるだけ返し、収まらない分は続き(next)で読む。

/** `first` の読みから next が尽きるまで追った応答の列。 */
function followNext<I, R extends { next?: string }>(read: (input: I | { next: string }) => R, first: I): R[] {
  const responses = [read(first)];
  while (responses.at(-1)!.next) responses.push(read({ next: responses.at(-1)!.next! }));
  return responses;
}

it("read_routing_settings は予算を超える量の提案を古い順に予算分ずつ返し、next を追うと欠けも重複もなく揃う。表と設定は最初の応答だけに載る", () => {
  const { db, routingReview } = board();
  const review = routingReview();
  const [row] = loadExecutionSettingTable(db);
  const proposed = Array.from({ length: 20 }, (_, i) => {
    const { question_id } = proposeRoutingChange(db, review, { op: "row", row: row!, change: { effort: "low" }, rationale: "r" }, "auditor", at);
    answerQuestionViaWebui(db, getTask(db, question_id)!, ["reject"], at, { comment: `${i} ${"潮".repeat(1_000)}` });
    return question_id;
  });

  const responses = followNext((input) => readRoutingSettings(db, input), {});

  expect(responses.length).toBeGreaterThan(1);
  for (const response of responses) expect(Buffer.byteLength(JSON.stringify(toolResult(response)))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  expect(responses.flatMap((response) => response.proposals.map((p) => p.question_id))).toEqual(proposed);
  expect(responses[0]).toMatchObject({ table: expect.any(Array) });
  for (const response of responses.slice(1)) expect(response).not.toHaveProperty("table");
});

it("list_routing_shadow / list_allocations / list_routing_cells は予算を超える量を予算分ずつ返し、next を追うと全行が揃う", () => {
  const { db, work, spawn, exit, allocate, routingReview } = board();
  // 長い agent 名と model 名で、20 の session がそれぞれ別の配分評価の組・別のセル・大きな shadow 行になる
  const tasks = Array.from({ length: 20 }, (_, i) => {
    const task = work(`w${i}`);
    const run = executionSetting("anthropic", `model-${i}-${"m".repeat(2_500)}`);
    recordShadow(db, task.id, shadow(run, run, "prior"), at);
    const spawned = spawn(task.id, `agent-${i}-${"a".repeat(2_500)}`, run);
    exit(task.id, spawned);
    allocate(task.id, spawned, { judge, allocation: "appropriate", cause: "uncertain", evidence: "e" });
    return task.id;
  });
  const reader = routingReview();
  const window = { since_watermark: 0 };

  const shadows = followNext((input) => listRoutingShadow(db, reader, input), window);
  const allocations = followNext((input) => listAllocations(db, reader, input), window);
  const cells = followNext((input) => listRoutingCells(db, reader, input), window);

  for (const responses of [shadows, allocations, cells]) {
    expect(responses.length).toBeGreaterThan(1);
    for (const response of responses) expect(Buffer.byteLength(JSON.stringify(toolResult(response)))).toBeLessThanOrEqual(RESPONSE_BUDGET_BYTES);
  }
  expect(shadows.flatMap((response) => response.shadow.map((r) => r.task_id))).toEqual(tasks);
  expect(new Set(allocations.flatMap((response) => response.allocations.map((g) => g.agent))).size).toBe(20);
  expect(new Set(cells.flatMap((response) => response.cells.map((c) => c.cell.model))).size).toBe(20);
});
