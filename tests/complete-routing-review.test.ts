import { expect, it } from "vitest";
import type { AgentView } from "../src/agent-create.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, listEvents, listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange } from "../src/execution-setting.js";
import { recordShadow } from "../src/learner.js";
import { registerMetaReview } from "../src/meta-review.js";
import { completeRoutingReview, proposeRoutingChange } from "../src/routing-review.js";
import { completeTask, getTask, registerTask, type Task, taskVerbSwap } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { executionSetting, FULL_HANDOFF, HUMAN_WEBUI, humanDecomposeTaskViaWebui, injectRoutingMaterial, judgmentRows, QUIET_EXIT, WORKER_SPAWNED } from "./harness.js";

/** routing meta-review は complete_routing_review で終わる(ADR 0278 決定1〜5・追記4・追記5 の routing、issue #2284)。 */

const at = new Date("2026-10-20T00:00:00.000Z");

/** routing の meta-review を登録し、その task を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, done = false): Task {
  registerMetaReview(db, "routing", at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return getTask(db, taskId)!;
}

const OPUS = { provider: "anthropic" as const, model: "claude-opus-5-5", effort: "high" };
const none = { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 }, seed: null };
const deckhand: AgentView = { name: "deckhand", version: "1", authority: "standard", description: "agent", provider: "anthropic", advisor: false, tier: "standard", skills: ["*"], retiredFields: [], systemPrompt: "p" };

/** 前回の後に standard を求めた task の opus の行の session が2つ走った routing meta-review(setup): 1つは乖離した shadow 行の pickup で
 *  段の出所が agent、もう1つは段の出所が task で、どちらにも配分評価が付く。項目は opus の行・agent deckhand・段 standard・学習器。 */
function cycle() {
  const db = openDb(":memory:");
  register(db, true);
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c", tier: "standard", workspace: "reef" }, at, ...HUMAN_WEBUI).id;
  const sonnet = executionSetting("anthropic", "claude-sonnet-5-5");
  recordShadow(db, work, { recommended: sonnet, actual: executionSetting("anthropic", OPUS.model), basis: "prior", recommended_record: none, actual_record: none, candidates: 2 }, at);
  const spawn = (tier: "agent" | "task") =>
    appendEvent(db, { taskId: work, workerId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, ...OPUS, advisor: null, tier_id: tierIdOf(db, "standard"), source: { tier, provider: "rank" } } });
  const evidence = [spawn("agent"), spawn("task")];
  for (const spawned of evidence) {
    const payload = { kind: "allocation_reviewed", review_task_id: "r", worker_spawned_event_id: spawned, judge: { provider: "anthropic", model: "fable", effort: "high" }, allocation: "overpowered", cause: "uncertain", evidence: "e" };
    appendEvent(db, { taskId: work, workerId: "tidepool", origin: "board", at, payload: payload as Extract<EventPayload, { kind: "allocation_reviewed" }> });
  }
  const review = register(db);
  return { db, review, evidence, injected: injectRoutingMaterial(db, review.id, "auditor", at) };
}

const complete = (db: Db, review: Task, judgments: Parameters<typeof completeRoutingReview>[2]["judgments"]) =>
  completeRoutingReview(db, getTask(db, review.id)!, { judgments }, "auditor", at, "worker");

it("routing meta-review の verb の差し替えは complete_task を伏せ complete_routing_review を足す", () => {
  const { db, review } = cycle();

  expect(taskVerbSwap(db, review.id)).toEqual({ withheld: ["complete_task"], added: ["complete_routing_review"] });
});

it.each([
  ["worker", "auditor", "worker"],
  ["人間", HUMAN_WORKER_ID, "webui"],
] as const)("routing meta-review への complete_task は %s の扉でも拒まれ、拒否文は complete_routing_review を指し、何も書かない", (_, workerId, origin) => {
  const { db, review } = cycle();
  const before = listEvents(db, review.id).length;

  expect(() => completeTask(db, review, FULL_HANDOFF, workerId, at, origin)).toThrow("complete_routing_review");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("注入の記録は評価の対象を complete_routing_review の鍵で運ぶ", () => {
  const { injected } = cycle();

  expect(injected).toEqual([{ row: OPUS, tier: "standard" }, { agent: "deckhand" }, { tier: "standard" }, { learner: true }]);
});

it("値も提案も無い対象があれば unjudged で名指して拒まれ、注入した一覧に無い対象も名指して拒まれ、どちらも何も記録しない", () => {
  const { db, review } = cycle();
  const before = listEvents(db, review.id).length;

  expect(() => complete(db, review, [])).toThrow("unjudged: anthropic / claude-opus-5-5 at effort high, agent deckhand, tier standard, the learner —");
  expect(() =>
    complete(db, review, [{ row: OPUS }, { agent: "deckhand" }, { tier: "standard" }, { learner: true }, { row: { ...OPUS, effort: "max" } }, { agent: "kimi" }, { tier: "frontier" }]),
  ).toThrow("not items to judge: anthropic / claude-opus-5-5 at effort max, agent kimi, tier frontier");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

/** 提案の op ごとに、その提案が覆う対象(ADR 0278 決定5)。 */
const proposals: Array<[op: string, covers: object, propose: (db: Db, review: Task, evidence: number[]) => unknown]> = [
  ["row", { row: OPUS }, (db, review) => proposeRoutingChange(db, review.id, { op: "row", row: OPUS, change: { tier: "frontier" }, rationale: "r" }, "auditor", at)],
  [
    "add_tier",
    { row: OPUS },
    (db, review, evidence) =>
      proposeRoutingChange(db, review.id, { op: "add_tier", tier: "careful", description: "Careful work.", position: 2, row: OPUS, evidence, rationale: "r" }, "auditor", at),
  ],
  [
    "agent_tier",
    { agent: "deckhand" },
    (db, review, evidence) => proposeRoutingChange(db, review.id, { op: "agent_tier", agent: "deckhand", to: "economy", evidence: [evidence[0]!], rationale: "r" }, "auditor", at, () => [deckhand]),
  ],
  [
    "tier_description",
    { tier: "standard" },
    (db, review, evidence) => proposeRoutingChange(db, review.id, { op: "tier_description", tier: "standard", description: "Work that needs care.", evidence: [evidence[1]!], rationale: "r" }, "auditor", at),
  ],
  ["promote", { learner: true }, (db, review) => proposeRoutingChange(db, review.id, { op: "promote", rationale: "r" }, "auditor", at)],
  [
    "demote",
    { learner: true },
    (db, review) => {
      db.prepare("UPDATE execution_defaults SET learner_promoted = 1").run();
      return proposeRoutingChange(db, review.id, { op: "demote", rationale: "r" }, "auditor", at);
    },
  ],
  [
    "interview",
    { row: OPUS },
    (db, review, evidence) =>
      proposeRoutingChange(
        db,
        review.id,
        { op: "interview", hypothesis: "opus at effort max does the careful work", evidence: [evidence[0]!], tier: "standard", targets: [{ ...OPUS, effort: "max" }], workspace: "reef", rationale: "r" },
        "auditor",
        at,
      ),
  ],
];

it.each(proposals)("op %s の提案 question は %j を覆い、その対象に値が無くても完了し、行は残りの対象だけ", (_, covers, propose) => {
  const { db, review, evidence, injected } = cycle();
  propose(db, review, evidence);
  const rest = injected.filter((item) => JSON.stringify(item) !== JSON.stringify("row" in covers ? { ...covers, tier: "standard" } : covers));

  const done = complete(db, review, rest);

  expect(rest).toHaveLength(3);
  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toHaveLength(3);
});

it.each([
  ["人間が行を編集した", (db: Db) => applyExecutionSettingsChange(db, { setting: "row", key: OPUS, row: { ...OPUS, tier: "frontier", price_in: 5, price_out: 25 } }, "webui", at)],
  [
    "registry に agent の段が書かれた",
    (db: Db) =>
      appendEvent(db, { taskId: null, workerId: "human", origin: "webui", at, payload: { kind: "agent_tier_changed", agent: "deckhand", from: "standard", to: "economy", question_id: "q", registry_commit: "c0ffee" } }),
  ],
  ["人間が段の説明を書き換えた", (db: Db) => applyExecutionSettingsChange(db, { setting: "edit_tier", name: "standard", description: "Rewritten." }, "webui", at)],
  ["人間が学習器を降格した", (db: Db) => applyExecutionSettingsChange(db, { setting: "learner_promoted", value: false }, "webui", at)],
] as const)("注入の後に%sら、その対象は行為済みで、注入した一覧どおりの値は受け取られ、その行は書かれない", (_, act) => {
  const { db, review, injected } = cycle();
  act(db);

  const done = complete(db, review, injected);

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toHaveLength(3);
});

it("注入の後に段が改名されれば、注入した名前の段はもう項目でなく、その値は受け取られて行は書かれない —— 今の計算は絞り込みにだけ使う", () => {
  const { db, review, injected } = cycle();
  applyExecutionSettingsChange(db, { setting: "rename_tier", name: "standard", to: "steady" }, "webui", at);

  const done = complete(db, review, injected);

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id).map((row) => row.judgment)).not.toContainEqual(expect.objectContaining({ tier: expect.anything() }));
});

it("再 spawn で注入の記録が2つあれば最新の記録の項目を読み、2つ目で増えた項目は unjudged で拒まれる", () => {
  const db = openDb(":memory:");
  register(db, true);
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const spawned = appendEvent(db, { taskId: work, workerId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, ...OPUS, advisor: null } });
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: 0.5, advisor: null, model_swaps: [], refusals: [], models: {} };
  appendEvent(db, { taskId: work, workerId: "board", origin: "board", at, payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, usage } });
  applyExecutionSettingsChange(db, { setting: "delete_row", ...OPUS }, "webui", at);
  const review = register(db);
  const first = injectRoutingMaterial(db, review.id, "auditor", at);
  applyExecutionSettingsChange(db, { setting: "row", row: { ...OPUS, tier: "standard", price_in: 5, price_out: 25 } }, "webui", at);
  const second = injectRoutingMaterial(db, review.id, "auditor", at);

  expect([first, second]).toEqual([[{ learner: true }], [{ row: OPUS, tier: "standard" }, { learner: true }]]);
  expect(() => complete(db, review, first)).toThrow("unjudged: anthropic / claude-opus-5-5 at effort high —");
});

it("材料の注入が記録されていない routing meta-review の完了は判断を要する項目が読めないので拒まれ、何も記録しない", () => {
  const db = openDb(":memory:");
  register(db, true);
  const review = register(db);
  const before = listEvents(db, review.id).length;

  expect(() => complete(db, review, [{ learner: true }])).toThrow("material was not injected");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("no_change の対象ごとに対象を名指す型つきの decision_logged が1行、文は盤面が組んで行には段を添え reason があれば添え、完了する", () => {
  const { db, review, injected } = cycle();

  const done = complete(db, review, [{ ...injected[0]!, reason: "  still fits " }, ...injected.slice(1)]);

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toEqual([
    { kind: "decision_logged", line: "no_change: anthropic / claude-opus-5-5 at effort high (standard) — still fits", judgment: { kind: "routing", row: OPUS, value: "no_change", reason: "still fits" } },
    { kind: "decision_logged", line: "no_change: agent deckhand", judgment: { kind: "routing", agent: "deckhand", value: "no_change" } },
    { kind: "decision_logged", line: "no_change: tier standard", judgment: { kind: "routing", tier: "standard", value: "no_change" } },
    { kind: "decision_logged", line: "no_change: the learner", judgment: { kind: "routing", learner: true, value: "no_change" } },
  ]);
});

it("完了が拒まれれば判断の行も書かれない —— 行と完了は1つの transaction", () => {
  const { db, review, injected } = cycle();
  humanDecomposeTaskViaWebui(db, review, { reason: "split", children: [{ title: "child", purpose: "p", completion_criteria: "c" }] }, at);

  expect(() => complete(db, review, injected)).toThrow("unfinished children");
  expect(judgmentRows(db, review.id)).toEqual([]);
});

it("routing meta-review でない task は拒まれる", () => {
  const db = openDb(":memory:");
  registerMetaReview(db, "memory", at);
  const memory = getTask(db, listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!)!;

  expect(() => complete(db, memory, [])).toThrow("only a routing meta-review completes with complete_routing_review");
});
