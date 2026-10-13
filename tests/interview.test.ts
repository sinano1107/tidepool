import { expect, it } from "vitest";
import type { AdvisorCeiling } from "../src/claude-model-alias.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor, firstSelectable } from "../src/execution-setting.js";
import { countTasksAwaitingLanding, countTasksAwaitingLandingInWorkspace } from "../src/landing.js";
import { loadEpisodes, observedInTier, selectorBranch } from "../src/learner.js";
import type { Provider } from "../src/provider.js";
import { completeTask, interviewPin, interviewTargets, listChildren, registerTask, scoreInterview, type Task } from "../src/tasks.js";
import { tierIdOf, tierNames } from "../src/tier.js";
import { answerQuestionViaWebui, decomposeTaskViaWorker, FULL_HANDOFF, HUMAN_WEBUI, WORKER_SPAWNED } from "./harness.js";

// Interview(CONTEXT.md「Interview」/ ADR 0199)の domain 層の振る舞い。盤面境界の写像は interview-boundary.test.ts。

const ROOT = { type: "review" as const, title: "interview", purpose: "the original task", completion_criteria: "every target scored" };
const opusHigh = { provider: "anthropic", model: "claude-opus-5-5", effort: "high", tier: "standard" };

function registerInterview(db = openDb(":memory:"), targets: Array<Record<string, unknown>> = [opusHigh]) {
  return { db, root: registerTask(db, { ...ROOT, interview_targets: targets as never }, new Date(0), ...HUMAN_WEBUI) };
}

it("Interview の root は対象の一覧を持つ —— 対象は表の行でなくてよく、effort の「無い」も対象の値(ADR 0199 決定1・2 / ADR 0218 決定5)", () => {
  const haiku = { provider: "anthropic", model: "claude-haiku-4-5", effort: null, tier: "economy" };
  const { db, root } = registerInterview(undefined, [opusHigh, haiku]);
  expect(interviewTargets(db, root.id)).toEqual([opusHigh, haiku]);
});

it("登録の扉は未知の Provider、anthropic の alias、走らない effort の対象を拒む(ADR 0199 決定3 / ADR 0182 決定1 / ADR 0218 決定4)", () => {
  expect(() => registerInterview(undefined, [{ ...opusHigh, provider: "acme" }])).toThrow(/unknown provider "acme"/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, model: "opus" }])).toThrow(/"opus" is a Claude CLI alias/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, model: "claude-opus-4-5", effort: "max" }])).toThrow(/runs as high/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, effort: "ultra" }])).toThrow(/effort must be one of/);
});

const CHILD = { title: "probe", purpose: "run the probe", completion_criteria: "the probe's deliverable" };

it("子の pin は root の対象のどれかと4欄一致しなければ拒まれ、effort の null も値として比べる —— 一致した子は対象の段を要求する(ADR 0199 決定3 / ADR 0218 決定5)", () => {
  const haiku = { provider: "anthropic", model: "claude-haiku-4-5", effort: null, tier: "economy" };
  const { db, root } = registerInterview(undefined, [opusHigh, haiku]);
  const decompose = (pin: Record<string, unknown>) =>
    decomposeTaskViaWorker(db, root, { reason: "one child per target", children: [{ ...CHILD, interview_pin: pin as never }] }, "auditor", new Date(0));
  expect(() => decompose({ ...haiku, effort: "high" })).toThrow(/not one of this Interview's targets/);
  expect(() => decompose({ ...opusHigh, effort: null })).toThrow(/not one of this Interview's targets/);
  expect(() => decompose({ ...opusHigh, tier: "frontier" })).toThrow(/not one of this Interview's targets/);
  const [child] = decompose(haiku);
  expect(interviewPin(db, child!.id)).toEqual(haiku);
  expect(child!.tier).toBe("economy");
});

it("pin は Interview の root の子だけが持ち、pin した子は完了時レビューも別の要求も持たない", () => {
  const db = openDb(":memory:");
  const plain = registerTask(db, { ...ROOT }, new Date(0), ...HUMAN_WEBUI);
  const pinned = (parent: Task, extra: object = {}) =>
    decomposeTaskViaWorker(db, parent, { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh, ...extra }] }, "auditor", new Date(0));
  expect(() => pinned(plain)).toThrow(/only an Interview's children carry interview_pin/);
  const { root } = registerInterview(db);
  for (const extra of [{ review_flag: true }, { risk_flag: true }, { tier: "standard" }, { priority: "cost" }]) {
    expect(() => pinned(root, extra)).toThrow(/an Interview child runs at its pin/);
  }
});

it("承認 question に変わった pin の子は、approve で同じ pin のまま登録される", () => {
  const { db, root } = registerInterview();
  decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, assignee: "deckhand", interview_pin: opusHigh }] }, "auditor", new Date(0), {
    authority: { assignable_to: [] },
  });
  const question = listChildren(db, root.id).find((task) => task.type === "question")!;
  answerQuestionViaWebui(db, question, ["approve"], new Date(0));
  const child = listChildren(db, root.id).find((task) => task.type === "work")!;
  expect(interviewPin(db, child.id)).toEqual(opusHigh);
});

/** root に対象を1つ持たせ、それを pin した子を返す。 */
function pinnedChild(target: Record<string, unknown>, ceiling: AdvisorCeiling = "off") {
  const { db, root } = registerInterview(undefined, [target]);
  applyExecutionSettingsChange(db, { setting: "advisor_ceiling", value: ceiling }, "webui", new Date(0));
  const [child] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, interview_pin: target as never }] }, "auditor", new Date(0));
  return { db, child: child! };
}
const agent = (advisor: boolean, ...providers: Provider[]) => ({ provider: providers.map((name) => ({ name, advisor })), tier: undefined });
const opus46 = { provider: "anthropic", model: "claude-opus-4-6", effort: "high", tier: "frontier" };

it("pin の子は selector の並びを通らず、表に無い対象の (provider, model, effort) と対象の段の候補だけを持つ —— 出所は interview(ADR 0199 決定2 / ADR 0210 決定4)", () => {
  const { db, child } = pinnedChild(opus46);
  expect(executionSettingsFor(db, agent(false, "openai", "anthropic"), child)).toEqual([
    { provider: "anthropic", model: "claude-opus-4-6", effort: "high", advisor: undefined, tier_id: tierIdOf(db, "frontier"), source: { tier: "interview", provider: "interview" } },
  ]);
  // pin の Provider を entry に持たない agent には候補が無い
  expect(executionSettingsFor(db, agent(false, "openai"), child)).toEqual([]);
});

it("pin の advisor は本番と同じ導出 —— 上限の alias、上限より上の main は advisor 無しで走り、知らない系列は advisor の entry の候補から外れる(ADR 0208)", () => {
  const advisorOf = (target: Record<string, unknown>, ceiling: AdvisorCeiling) => {
    const { db, child } = pinnedChild(target, ceiling);
    return executionSettingsFor(db, agent(true, "anthropic"), child).map(({ advisor, source }) => ({ advisor, source: source.advisor }));
  };
  expect(advisorOf(opus46, "fable")).toEqual([{ advisor: "fable", source: "ceiling" }]);
  expect(advisorOf(opus46, "sonnet")).toEqual([{ advisor: undefined, source: "main_above_ceiling" }]);
  expect(advisorOf(opus46, "off")).toEqual([{ advisor: undefined, source: "off" }]);
  expect(advisorOf({ ...opus46, model: "claude-ghost-1-0" }, "fable")).toEqual([]);
});

it("pin にも Fable の窓の下げと除外が当たる —— fable_then_opus は Fable の窓のあいだ opus の上限の導出に下がり、Provider の除外で候補が尽きる(ADR 0208 決定5)", () => {
  const { db, child } = pinnedChild(opus46, "fable_then_opus");
  const candidates = executionSettingsFor(db, agent(true, "anthropic"), child);
  expect(firstSelectable(candidates, { providers: [], models: [] })).toMatchObject({ advisor: "fable", source: { advisor: "ceiling" } });
  expect(firstSelectable(candidates, { providers: [], models: [{ provider: "anthropic", model: "fable" }] })).toMatchObject({
    advisor: "claude-opus-4-6",
    source: { advisor: "window_downgraded" },
  });
  expect(firstSelectable(candidates, { providers: ["anthropic"], models: [] })).toBeNull();
});

it("pin の子は着地しない —— 完了しても着地の根にも「着地待ち」の数にも入らない(ADR 0241 / ADR 0226)", () => {
  const { db, root } = registerInterview();
  const plain = registerTask(db, { type: "work", ...CHILD, workspace: "reef" }, new Date(0), ...HUMAN_WEBUI);
  completeTask(db, plain, FULL_HANDOFF, "tako", new Date(0), "worker");
  const [child] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, workspace: "reef", interview_pin: opusHigh }] }, "auditor", new Date(0));
  completeTask(db, child!, FULL_HANDOFF, "tako", new Date(0), "worker");
  expect(countTasksAwaitingLandingInWorkspace(db, undefined, "reef")).toBe(1);
  expect(countTasksAwaitingLanding(db, undefined, "tako", "tako")).toBe(1);
});

it("未決着の Interview の対象が名指す段は消せない —— root が決着すれば消せる(ADR 0200 決定2)", () => {
  const db = openDb(":memory:");
  const change = (setting: object) => applyExecutionSettingsChange(db, setting as never, "webui", new Date(0));
  change({ setting: "insert_tier", name: "trial", description: "A tier being measured.", position: 0 });
  const { root } = registerInterview(db, [{ ...opusHigh, tier: "trial" }]);
  expect(() => change({ setting: "delete_tier", name: "trial" })).toThrow(`unsettled Interviews target it: ${root.id}`);
  completeTask(db, root, undefined, "auditor", new Date(0), "worker");
  change({ setting: "delete_tier", name: "trial" });
  expect(tierNames(db)).not.toContain("trial");
});

/** pin した子を1つ走らせて完了させる(spawn は pin の値と対象の段で記録される)。 */
function ranChild(db: Db, root: Task, pin = opusHigh) {
  const [child] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, interview_pin: pin }] }, "auditor", new Date(0));
  const spawned = { ...WORKER_SPAWNED, advisor: null, model: pin.model, effort: pin.effort, tier_id: tierIdOf(db, pin.tier) };
  appendEvent(db, { taskId: child!.id, workerId: "tako", origin: "board", at: new Date(0), payload: spawned });
  return completeTask(db, child!, FULL_HANDOFF, "tako", new Date(0), "worker");
}

it("学習器は Interview の子の採点を、同じセル・同じ段の観測として本番の episode と並べて数え、種別は episode に残る(ADR 0181 決定4 / ADR 0210 決定4)", () => {
  const { db, root } = registerInterview();
  const accepted = ranChild(db, root);
  const rejected = ranChild(db, root);
  const unscored = ranChild(db, root);
  scoreInterview(db, root, accepted.id, "accepted", "auditor", new Date(1), "worker");
  scoreInterview(db, root, rejected.id, "rejected", "auditor", new Date(1), "worker");
  const episodes = loadEpisodes(db);
  expect(episodes.map(({ task_id, outcome, interview }) => ({ task_id, outcome, interview }))).toEqual([
    { task_id: accepted.id, outcome: "accepted", interview: true },
    { task_id: rejected.id, outcome: "rejected", interview: true },
    { task_id: unscored.id, outcome: "excluded", interview: true },
  ]);
  const cell = { provider: "anthropic", model: "claude-opus-5-5", effort: "high", advisor: null };
  expect(observedInTier(episodes, tierIdOf(db, "standard"), null).board).toEqual([{ cell, accepted: 1, rejected: 1, interview: { accepted: 1, rejected: 1 } }]);
  expect(observedInTier(episodes, tierIdOf(db, "economy"), null).board).toEqual([]);
});

it("採点は Interview の root が、決着した自分の pin の子にだけ付けられる", () => {
  const { db, root } = registerInterview();
  const [open] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh }] }, "auditor", new Date(0));
  expect(() => scoreInterview(db, root, open!.id, "accepted", "auditor", new Date(0), "worker")).toThrow(/only a done child/);
  const other = registerInterview(db).root;
  const done = ranChild(db, other);
  expect(() => scoreInterview(db, root, done.id, "accepted", "auditor", new Date(0), "worker")).toThrow(/not an Interview child of this task/);
});

it("shadow 行の両セルの実績は、本番と Interview の内訳を運ぶ(ADR 0181 決定5)", () => {
  const cell = { provider: "anthropic" as const, model: "claude-opus-5-5", effort: "high", advisor: null };
  const episode = (interview: boolean, outcome: "accepted" | "rejected") => ({ cell, interview, outcome, tier_id: 1, workspace: "reef", cost_usd: null, duration_ms: null });
  const episodes = [episode(false, "accepted"), episode(true, "accepted"), episode(true, "rejected")];
  const opus = { provider: "anthropic" as const, model: "claude-opus-5-5", effort: "high", advisor: undefined, tier_id: 1, source: { tier: "board" as const, provider: "only" as const } };
  const { shadow } = selectorBranch({ promoted: false, candidates: [opus], ...observedInTier(episodes, 1, "reef") });
  const record = { accepted: 2, rejected: 1, interview: { accepted: 1, rejected: 1 } };
  expect(shadow.actual_record).toEqual({ board: record, workspace: record });
});
