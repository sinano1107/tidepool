import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, latestEventOfTask, listEvents, listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange } from "../src/execution-setting.js";
import { routingPrecedents } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { completeRoutingReview, proposeRoutingChange } from "../src/routing-review.js";
import { completeTask, escalateTask, getTask, registerTask, type Task, taskVerbSwap } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { HUMAN_WORKER_ID } from "../src/worker-id.js";
import { DECKHAND_AGENT, divergedSession, FULL_HANDOFF, HUMAN_WEBUI, injectRoutingMaterial, judgmentRows, OPUS_ROW, objectedJudgment, QUIET_EXIT, routedOpusSessions, WORKER_SPAWNED } from "./harness.js";

/** routing meta-review は complete_routing_review で終わる(ADR 0278 決定1〜5・追記4・追記5 の routing、issue #2284)。 */

const at = new Date("2026-10-20T00:00:00.000Z");

/** routing の meta-review を登録し、その task を返す。done にすれば次の登録の「前回」になる(setup のみ)。 */
function register(db: Db, done = false): Task {
  registerMetaReview(db, "routing", at);
  const taskId = listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!;
  if (done) db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(taskId);
  return getTask(db, taskId)!;
}


/** 前回の後に opus の行の session が2つ走った routing meta-review(setup、tests/harness.ts の routedOpusSessions)。項目は opus の行・
 *  agent deckhand・段 standard・学習器。 */
function cycle() {
  const db = openDb(":memory:");
  register(db, true);
  const evidence = routedOpusSessions(db, at);
  const review = register(db);
  return { db, review, evidence, injected: injectRoutingMaterial(db, review.id, "auditor", at, [DECKHAND_AGENT]) };
}

const complete = (db: Db, review: Task, judgments: Parameters<typeof completeRoutingReview>[2]["judgments"]) =>
  completeRoutingReview(db, getTask(db, review.id)!, { judgments }, "auditor", at, "worker", routingPrecedents(db, review.id), [DECKHAND_AGENT]);

it("routing meta-review の verb の差し替えは complete_task と分解の verb を伏せ complete_routing_review を足す —— 帰り先の無い系譜(ADR 0301 決定3)", () => {
  const { db, review } = cycle();

  expect(taskVerbSwap(db, review.id)).toEqual({ withheld: ["decompose", "redecompose", "complete_task"], added: ["complete_routing_review"] });
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

it("注入の記録は評価の対象を運び、段は id で名指して注入した名前を添える —— agent が写す鍵は段を名前で名指す", () => {
  const { db, review, injected } = cycle();

  expect(latestEventOfTask(db, review.id, "meta_review_material_injected")!.payload).toMatchObject({
    items: [{ row: OPUS_ROW, tier: "standard" }, { agent: "deckhand" }, { tier_id: tierIdOf(db, "standard"), tier: "standard" }, { learner: true }],
  });
  expect(injected).toEqual([{ row: OPUS_ROW, tier: "standard" }, { agent: "deckhand" }, { tier: "standard" }, { learner: true }]);
});

it("値も提案も無い対象があれば unjudged で名指して拒まれ、注入した一覧に無い対象も名指して拒まれ、どちらも何も記録しない", () => {
  const { db, review } = cycle();
  const before = listEvents(db, review.id).length;

  expect(() => complete(db, review, [])).toThrow("unjudged: anthropic / claude-opus-5-5 at effort high, agent deckhand, tier standard, the learner —");
  expect(() =>
    complete(db, review, [{ row: OPUS_ROW }, { agent: "deckhand" }, { tier: "standard" }, { learner: true }, { row: { ...OPUS_ROW, effort: "max" } }, { agent: "kimi" }, { tier: "frontier" }]),
  ).toThrow("not items to judge: anthropic / claude-opus-5-5 at effort max, agent kimi, tier frontier");
  expect(listEvents(db, review.id)).toHaveLength(before);
  expect(getTask(db, review.id)!.status).toBe("todo");
});

it("窓で異議された前の判断の行が名指す行・agent・段は項目で、値も提案も無ければ unjudged で拒まれ、no_change を渡せば完了する(ADR 0279 決定5)", () => {
  const db = openDb(":memory:");
  const previous = register(db, true);
  const sonnet = { provider: "anthropic" as const, model: "claude-sonnet-5-5", effort: "high" };
  for (const object of [{ row: sonnet }, { agent: "deckhand" }, { tier_id: tierIdOf(db, "frontier") }]) objectedJudgment(db, previous.id, { kind: "routing", value: "no_change", ...object }, at);
  const review = register(db);
  injectRoutingMaterial(db, review.id, "auditor", at, [DECKHAND_AGENT]);

  expect(() => complete(db, review, [{ learner: true }])).toThrow("unjudged: anthropic / claude-sonnet-5-5 at effort high, agent deckhand, tier frontier —");
  expect(complete(db, review, [{ row: sonnet }, { agent: "deckhand" }, { tier: "frontier" }, { learner: true }]).status).toBe("done");
});

/** 提案の op ごとに、その提案が覆う対象(ADR 0278 決定5)。 */
const proposals: Array<[op: string, covers: object, propose: (db: Db, review: Task, evidence: number[]) => unknown]> = [
  ["row", { row: OPUS_ROW }, (db, review) => proposeRoutingChange(db, review.id, { op: "row", row: OPUS_ROW, change: { tier: "frontier" }, rationale: "r" }, "auditor", at)],
  [
    "add_tier",
    { row: OPUS_ROW },
    (db, review, evidence) =>
      proposeRoutingChange(db, review.id, { op: "add_tier", tier: "careful", description: "Careful work.", position: 2, row: OPUS_ROW, evidence, rationale: "r" }, "auditor", at),
  ],
  [
    "agent_tier",
    { agent: "deckhand" },
    (db, review, evidence) => proposeRoutingChange(db, review.id, { op: "agent_tier", agent: "deckhand", to: "economy", evidence: [evidence[0]!], rationale: "r" }, "auditor", at, () => [DECKHAND_AGENT]),
  ],
  [
    "tier_description",
    { tier: "standard" },
    (db, review, evidence) => proposeRoutingChange(db, review.id, { op: "tier_description", tier: "standard", description: "Work that needs care.", evidence: [evidence[1]!], rationale: "r" }, "auditor", at),
  ],
  ["promote", { learner: true }, (db, review, evidence) => proposeRoutingChange(db, review.id, { op: "promote", evidence: [evidence[0]!], rationale: "r" }, "auditor", at)],
  [
    "demote",
    { learner: true },
    (db, review) => {
      // 昇格は承認の適用だけが書き、公開の扉は降格しか受けない(executionSettingsChangeSchema の learner_promoted)
      db.prepare("UPDATE execution_defaults SET learner_promoted = 1").run();
      return proposeRoutingChange(db, review.id, { op: "demote", evidence: [divergedSession(db, at, { learner: true })], rationale: "r" }, "auditor", at);
    },
  ],
  [
    "interview",
    { row: OPUS_ROW },
    (db, review, evidence) =>
      proposeRoutingChange(
        db,
        review.id,
        { op: "interview", hypothesis: "opus at effort max does the careful work", evidence: [evidence[0]!], tier: "standard", targets: [{ ...OPUS_ROW, effort: "max" }], workspace: "reef", rationale: "r" },
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
  ["人間が行を編集した", (db: Db) => applyExecutionSettingsChange(db, { setting: "row", key: OPUS_ROW, row: { ...OPUS_ROW, tier: "frontier", price_in: 5, price_out: 25 } }, "webui", at)],
  [
    "registry に agent の段が書かれた",
    (db: Db) =>
      appendEvent(db, { taskId: null, workerId: "human", origin: "webui", at, payload: { kind: "agent_tier_changed", agent: "deckhand", from: "standard", to: "economy", question_id: "q", registry_commit: "c0ffee" } }),
  ],
  ["人間が段の説明を書き換えた", (db: Db) => applyExecutionSettingsChange(db, { setting: "edit_tier", name: "standard", description: "Rewritten." }, "webui", at)],
  [
    "人間が学習器を降格した",
    (db: Db) => {
      // 昇格は承認の適用だけが書き、公開の扉は降格しか受けない(executionSettingsChangeSchema の learner_promoted)
      db.prepare("UPDATE execution_defaults SET learner_promoted = 1").run();
      return applyExecutionSettingsChange(db, { setting: "learner_promoted", value: false }, "webui", at);
    },
  ],
] as const)("注入の後に%sら、その対象は行為済みで、注入した一覧どおりの値は受け取られ、その行は書かれない", (_, act) => {
  const { db, review, injected } = cycle();
  act(db);

  const done = complete(db, review, injected);

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toHaveLength(3);
});

it("注入の後に段が改名されても段は id で同じ項目のまま —— 改名は行為ではなく、注入した名前で値が無ければ unjudged、値があれば今の名前の文で行になる", () => {
  const { db, review, injected } = cycle();
  applyExecutionSettingsChange(db, { setting: "rename_tier", name: "standard", to: "steady" }, "webui", at);

  expect(() => complete(db, review, injected.filter((item) => !("tier" in item && !("row" in item))))).toThrow("unjudged: tier standard —");
  const done = complete(db, review, injected);

  expect(done.status).toBe("done");
  expect(judgmentRows(db, review.id)).toContainEqual({ kind: "decision_logged", line: "no_change: tier steady", judgment: { kind: "routing", tier_id: tierIdOf(db, "steady"), value: "no_change" } });
});

it.each([
  ["段の位置だけを動かした", (db: Db) => applyExecutionSettingsChange(db, { setting: "edit_tier", name: "standard", position: 2 }, "webui", at)],
  ["段を足した", (db: Db) => applyExecutionSettingsChange(db, { setting: "insert_tier", name: "careful", description: "Careful work.", position: 2 }, "webui", at)],
] as const)("注入の後に人間が%sのは段の項目への行為ではなく、値が無ければ unjudged で、値があれば行になる", (_, act) => {
  const { db, review, injected } = cycle();
  act(db);

  expect(() => complete(db, review, injected.filter((item) => !("tier" in item && !("row" in item))))).toThrow("unjudged: tier standard —");
  complete(db, review, injected);
  expect(judgmentRows(db, review.id)).toHaveLength(4);
});

it("再 spawn で注入の記録が2つあれば最新の記録の項目を読み、2つ目で増えた項目は unjudged で拒まれる", () => {
  const db = openDb(":memory:");
  register(db, true);
  const work = registerTask(db, { type: "work", title: "t", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI).id;
  const spawned = appendEvent(db, { taskId: work, workerId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, ...OPUS_ROW, advisor: null } });
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0, estimated_cost_usd: 0.5, advisor: null, model_swaps: [], refusals: [], models: {} };
  appendEvent(db, { taskId: work, workerId: "board", origin: "board", at, payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, usage } });
  applyExecutionSettingsChange(db, { setting: "delete_row", ...OPUS_ROW }, "webui", at);
  const review = register(db);
  const first = injectRoutingMaterial(db, review.id, "auditor", at);
  applyExecutionSettingsChange(db, { setting: "row", row: { ...OPUS_ROW, tier: "standard", price_in: 5, price_out: 25 } }, "webui", at);
  const second = injectRoutingMaterial(db, review.id, "auditor", at);

  expect([first, second]).toEqual([[{ learner: true }], [{ row: OPUS_ROW, tier: "standard" }, { learner: true }]]);
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
    { kind: "decision_logged", line: "no_change: anthropic / claude-opus-5-5 at effort high (standard) — still fits", judgment: { kind: "routing", row: OPUS_ROW, value: "no_change", reason: "still fits" } },
    { kind: "decision_logged", line: "no_change: agent deckhand", judgment: { kind: "routing", agent: "deckhand", value: "no_change" } },
    { kind: "decision_logged", line: "no_change: tier standard", judgment: { kind: "routing", tier_id: tierIdOf(db, "standard"), value: "no_change" } },
    { kind: "decision_logged", line: "no_change: the learner", judgment: { kind: "routing", learner: true, value: "no_change" } },
  ]);
});

it("完了が拒まれれば判断の行も書かれない —— 行と完了は1つの transaction", () => {
  const { db, review, injected } = cycle();
  escalateTask(db, review, { context: "c", questions: [{ title: "which agent?", options: ["a", "b"], recommendation: "a" }] }, "auditor", at, "worker");

  expect(() => complete(db, review, injected)).toThrow("unfinished children");
  expect(judgmentRows(db, review.id)).toEqual([]);
});

it("routing meta-review でない task は拒まれる", () => {
  const db = openDb(":memory:");
  registerMetaReview(db, "memory", at);
  const memory = getTask(db, listEventsOfKinds(db, ["meta_review_registered"]).at(-1)!.task_id!)!;

  expect(() => complete(db, memory, [])).toThrow("only a routing meta-review completes with complete_routing_review");
});
