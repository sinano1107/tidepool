import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, latestEventOfTask } from "../src/events.js";
import { applyExecutionSettingsChange, loadExecutionSettingTable, matchesRowKey } from "../src/execution-setting.js";
import { submitAnswer } from "../src/human-verbs.js";
import { metaReviewWindow, registerDueMetaReviews } from "../src/meta-review.js";
import { proposeRoutingChange, type RoutingObject, routingMaterial, routingRepairVerbs } from "../src/routing-review.js";
import { getTask, listBoard, listChildren, registerTask, type Task, taskHistoryRows } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { commitTriage, raiseObjection } from "../src/triage.js";
import { unusedLanding } from "./fakes.js";
import { DECKHAND_AGENT, divergedSession, HUMAN_WEBUI, judgedRoutingReview, OPUS_ROW, routedOpusSessions, routingJudgmentRepairTask } from "./harness.js";

/** routing meta-review の判断の行への異議の修理子 routing_repair(ADR 0279 決定4 / ADR 0278 決定5、issue #2305)のドメイン層。tool の
 *  登録と Codex の宣言はサーバ境界(tests/mcp-memory-write-record.test.ts・tests/codex-worker.test.ts)が言う。 */
const at = new Date("2026-10-20T00:00:00.000Z");

/** opus の行の session が窓で走り、項目(opus の行・agent deckhand・段 standard・学習器)をすべて no_change で完了した routing meta-review。 */
function board() {
  const db = openDb(":memory:");
  let evidence: number[] = [];
  const judged = judgedRoutingReview(db, at, () => (evidence = routedOpusSessions(db, at)));
  return { db, evidence, ...judged };
}

it("routing meta-review の型つきの判断の行への異議は routing_repair を1本立て work の修理子は立てず、完了の行への異議は修理子を立てない(ADR 0279 決定4)", () => {
  const { db, review, row } = board();
  const completed = latestEventOfTask(db, review.id, "task_completed")!.id;
  const objections = [raiseObjection(db, row({ row: OPUS_ROW }), "move it to frontier", at), raiseObjection(db, row({ learner: true }), "promote the learner", at)];
  commitTriage(db, at);

  const repairs = listChildren(db, review.id).filter((child) => child.type === "routing_repair" || child.type === "work" || child.type === "memory_repair");
  expect(repairs.map((child) => child.type)).toEqual(["routing_repair"]);
  expect(latestEventOfTask(db, repairs[0]!.id, "task_registered")?.payload).toMatchObject({ opened_on_event_ids: objections });

  // 自由文の log_decision の行(judgment を持たない)も対象を名指さない
  const freeText = appendEvent(db, { taskId: review.id, actorId: "auditor", origin: "worker", at, payload: { kind: "decision_logged", line: "the table looks fine overall" } });
  raiseObjection(db, completed, "you should have proposed something", at);
  raiseObjection(db, freeText, "it does not", at);
  commitTriage(db, at);

  expect(listChildren(db, review.id).filter((child) => child.type === "routing_repair" || child.type === "work")).toHaveLength(1);
});

it("routing_repair の purpose と get_current_task の親の history は親の判断の行・異議の対・帰責の判定を運ぶ(ADR 0279 決定4)", () => {
  const { db, review, row } = board();
  const learner = row({ learner: true });
  raiseObjection(db, learner, "promote the learner", at);
  commitTriage(db, at, [], new Map([[learner, { cause: "capability", evidence: "the track records favour the learner", wrong_memory_entries: null }]]));
  const repair = listChildren(db, review.id).find((child) => child.type === "routing_repair")!;

  expect(repair.purpose).toContain("> no_change: the learner\n- promote the learner\nboard judged: capability — the track records favour the learner");
  expect(taskHistoryRows(db, review.id, repair.id).map((r) => r.entry)).toEqual(expect.arrayContaining([expect.objectContaining({ decision: "no_change: the learner" })]));
});

it("routing_repair の verb は、routing の判断の行を運べば routing の読み口5本と propose_routing_change と指針の節の id 読み(read_memory_entries)、型つきの行を運ばなければ無い(ADR 0279 決定4 / ADR 0283 決定3)", () => {
  const db = openDb(":memory:");
  const judged = routingJudgmentRepairTask(db, at);
  const bare = registerTask(db, { type: "routing_repair", title: "routing repair", purpose: "redo it", completion_criteria: "c", parent_id: judged.parent_id! }, at, ...HUMAN_WEBUI);

  expect(routingRepairVerbs(db, judged.id).sort()).toEqual(["list_allocations", "list_precedents", "list_routing_cells", "list_routing_shadow", "propose_routing_change", "read_memory_entries", "read_routing_settings"]);
  expect(routingRepairVerbs(db, bare.id)).toEqual([]);
});

/** op ごとに、提案が写す対象(異議して修理子に運ばせる判断の行)、写さない対象、拒否文が名指す綴り、修理子からの提案(ADR 0278 決定5)。 */
const proposals: Array<[op: string, covers: (db: Db) => RoutingObject, other: RoutingObject, named: string, propose: (db: Db, repair: Task, evidence: number[]) => unknown]> = [
  ["row", () => ({ row: OPUS_ROW }), { learner: true }, "anthropic / claude-opus-5-5 at effort high", (db, repair, evidence) => proposeRoutingChange(db, repair.id, { op: "row", row: OPUS_ROW, change: { tier: "frontier" }, evidence: [evidence[0]!], rationale: "r" }, "auditor", at)],
  [
    "add_tier",
    () => ({ row: OPUS_ROW }),
    { learner: true },
    "anthropic / claude-opus-5-5 at effort high",
    (db, repair, evidence) => proposeRoutingChange(db, repair.id, { op: "add_tier", tier: "careful", description: "Careful work.", position: 2, row: OPUS_ROW, evidence, rationale: "r" }, "auditor", at),
  ],
  [
    "agent_tier",
    () => ({ agent: "deckhand" }),
    { learner: true },
    "agent deckhand",
    (db, repair, evidence) => proposeRoutingChange(db, repair.id, { op: "agent_tier", agent: "deckhand", to: "economy", evidence: [evidence[0]!], rationale: "r" }, "auditor", at, () => [DECKHAND_AGENT]),
  ],
  [
    "tier_description",
    (db) => ({ tier_id: tierIdOf(db, "standard") }),
    { learner: true },
    "tier standard",
    (db, repair, evidence) => proposeRoutingChange(db, repair.id, { op: "tier_description", tier: "standard", description: "Work that needs care.", evidence: [evidence[1]!], rationale: "r" }, "auditor", at),
  ],
  ["promote", () => ({ learner: true }), { row: OPUS_ROW }, "the learner", (db, repair, evidence) => proposeRoutingChange(db, repair.id, { op: "promote", evidence: [evidence[0]!], rationale: "r" }, "auditor", at)],
  [
    "demote",
    () => ({ learner: true }),
    { row: OPUS_ROW },
    "the learner",
    (db, repair) => {
      // 昇格は承認の適用だけが書き、公開の扉は降格しか受けない(executionSettingsChangeSchema の learner_promoted)
      db.prepare("UPDATE execution_defaults SET learner_promoted = 1").run();
      return proposeRoutingChange(db, repair.id, { op: "demote", evidence: [divergedSession(db, at, { learner: true })], rationale: "r" }, "auditor", at);
    },
  ],
  [
    "interview",
    () => ({ row: OPUS_ROW }),
    { learner: true },
    "anthropic / claude-opus-5-5 at effort high",
    (db, repair, evidence) =>
      proposeRoutingChange(
        db,
        repair.id,
        { op: "interview", hypothesis: "opus at effort max does the careful work", evidence: [evidence[0]!], tier: "standard", targets: [{ ...OPUS_ROW, effort: "max" }], workspace: "reef", rationale: "r" },
        "auditor",
        at,
      ),
  ],
];

it.each(proposals)("修理子の op %s の提案は、運ぶ判断の行が写す対象を名指せば修理子の子の question になり、名指さなければ対象を名指す DomainError で何も立たない(ADR 0279 決定4)", (_, covers, other, named, propose) => {
  const { db, evidence, review, row } = board();
  const repairOn = (object: RoutingObject) => {
    raiseObjection(db, row(object), "redo it", at);
    commitTriage(db, at);
    return listChildren(db, review.id).filter((child) => child.type === "routing_repair").at(-1)!;
  };
  const [outside, inside] = [repairOn(other), repairOn(covers(db))];

  expect(() => propose(db, outside, evidence)).toThrow(new DomainError(`${named} is not named by the objected judgment: a routing repair proposes only on what that judgment names`));
  expect(listChildren(db, outside.id)).toEqual([]);
  const { question_id } = propose(db, inside, evidence) as { question_id: string };
  expect(getTask(db, question_id)).toMatchObject({ type: "question", parent_id: inside.id });
});

it("修理子の下の提案 question は open な間は次の routing meta-review の登録を止め、承認で盤面が表に適用し、次の周期の材料の Settled proposals に載る(ADR 0279 決定4・7)", async () => {
  const { db, evidence, review, row } = board();
  const objected = row({ row: OPUS_ROW });
  raiseObjection(db, objected, "move it to frontier", at);
  // RCA の要らない cause —— 開いた RCA の子が登録を止めない
  commitTriage(db, at, [], new Map([[objected, { cause: "preference", evidence: "the human wants frontier", wrong_memory_entries: null }]]));
  const repair = listChildren(db, review.id).find((child) => child.type === "routing_repair")!;
  const { question_id } = proposeRoutingChange(db, repair.id, { op: "row", row: OPUS_ROW, change: { tier: "frontier" }, evidence: [evidence[0]!], rationale: "r" }, "auditor", at);
  db.prepare("UPDATE tasks SET status = 'done' WHERE id = ?").run(repair.id);
  // 次の周期の材料(人間が変えた行)—— 材料が無ければ open な question が無くても登録されず、門の釘にならない
  applyExecutionSettingsChange(db, { setting: "row", row: { provider: "anthropic", tier: "standard", model: "claude-opus-5", effort: "high", price_in: 5, price_out: 25 } }, "mcp", at);
  const afterPeriod = new Date(at.getTime() + 8 * 24 * 60 * 60 * 1000);
  const next = () => listBoard(db).find((task) => task.meta_review_subject === "routing" && task.status === "todo");

  registerDueMetaReviews(db, afterPeriod);
  expect(next()).toBeUndefined();

  await submitAnswer({ db, pollNow() {}, landing: unusedLanding }, getTask(db, question_id)!, ["approve"], undefined, () => at, "webui");
  expect(loadExecutionSettingTable(db).find((r) => matchesRowKey(r, OPUS_ROW))?.tier).toBe("frontier");
  registerDueMetaReviews(db, afterPeriod);
  expect(routingMaterial(db, metaReviewWindow(db, next()!.id), []).parts.proposals).toEqual([expect.objectContaining({ question_id, answer: "approve" })]);
});
