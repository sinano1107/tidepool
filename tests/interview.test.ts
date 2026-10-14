import { expect, it } from "vitest";
import type { AdvisorCeiling } from "../src/claude-model-alias.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor, firstSelectable } from "../src/execution-setting.js";
import { countTasksAwaitingLanding, countTasksAwaitingLandingInWorkspace } from "../src/landing.js";
import { loadEpisodes, observedInTier, selectorBranch } from "../src/learner.js";
import type { Provider } from "../src/provider.js";
import { abandonConsequence, completeTask, countUnsettledTasksReferencing, declarePremiseBreach, getTask, interviewTargets, listBoard, listChildren, nextSlotTask, presentTask, redecompose, registerTask, scoreInterview, type Task, taskHistoryRows, withheldDecompositionVerbs } from "../src/tasks.js";
import { tierIdOf, tierNames } from "../src/tier.js";
import { answerQuestionViaWebui, decomposeTaskViaWorker, FULL_HANDOFF, failureQuestion, HUMAN_WEBUI, humanDecomposeTaskViaWebui, WORKER_SPAWNED } from "./harness.js";

// Interview(CONTEXT.md「Interview」/ ADR 0199)の domain 層の振る舞い。盤面境界の写像は interview-boundary.test.ts。

const ROOT = { type: "review" as const, title: "interview", purpose: "the original task", completion_criteria: "every target scored" };
const opusHigh = { provider: "anthropic", model: "claude-opus-5-5", effort: "high", tier: "standard" };
const haikuNull = { provider: "anthropic", model: "claude-haiku-4-5", effort: null, tier: "economy" };
const sonnetHigh = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high", tier: "economy" };

function registerInterview(db = openDb(":memory:"), targets: Array<Record<string, unknown>> = [opusHigh]) {
  return { db, root: registerTask(db, { ...ROOT, interview_targets: targets as never }, new Date(0), ...HUMAN_WEBUI) };
}

it("Interview の root は対象の一覧を持つ —— 対象は表の行でなくてよく、effort の「無い」も対象の値(ADR 0199 決定1・2 / ADR 0218 決定5)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  expect(interviewTargets(db, root.id)).toEqual([opusHigh, haikuNull]);
});

it("登録の扉は未知の Provider、anthropic の alias、走らない effort の対象を拒む(ADR 0199 決定3 / ADR 0182 決定1 / ADR 0218 決定4)", () => {
  expect(() => registerInterview(undefined, [{ ...opusHigh, provider: "acme" }])).toThrow(/unknown provider "acme"/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, model: "opus" }])).toThrow(/"opus" is a Claude CLI alias/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, model: "claude-opus-4-5", effort: "max" }])).toThrow(/runs as high/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, effort: "ultra" }])).toThrow(/effort must be one of/);
});

it("登録の扉は4欄一致の対象を2つ含む一覧を拒み、effort の null 同士も一致として扱う —— effort だけ違う2つは通る(ADR 0249 決定2 / ADR 0218 決定5)", () => {
  expect(() => registerInterview(undefined, [haikuNull, opusHigh, { ...haikuNull }])).toThrow(`${JSON.stringify(haikuNull)} appears more than once`);
  const { db, root } = registerInterview(undefined, [opusHigh, { ...opusHigh, effort: "medium" }]);
  expect(interviewTargets(db, root.id)).toEqual([opusHigh, { ...opusHigh, effort: "medium" }]);
});

/** 子が走る pin: anthropic の entry を持つ agent の候補の値と段。 */
function pinOf(db: Db, taskId: string) {
  const [setting] = executionSettingsFor(db, { provider: [{ name: "anthropic", advisor: false }], tier: undefined }, getTask(db, taskId)!);
  return setting && { provider: setting.provider, model: setting.model, effort: setting.effort, tier_id: setting.tier_id, source: setting.source.tier };
}

const CHILD = { title: "probe", purpose: "run the probe", completion_criteria: "the probe's deliverable" };
const pinned = (...targets: object[]) => targets.map((target) => ({ ...CHILD, interview_pin: target as never }));

it("子の pin は root の対象のどれかと4欄一致しなければ拒まれ、effort の null も値として比べる —— 一致した子は対象の段を要求する(ADR 0199 決定3 / ADR 0218 決定5)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const decompose = (pin: Record<string, unknown>) =>
    decomposeTaskViaWorker(db, root, { reason: "one child per target", children: [{ ...CHILD, interview_pin: pin as never }, { ...CHILD, interview_pin: opusHigh }] }, "auditor", new Date(0));
  expect(() => decompose({ ...haikuNull, effort: "high" })).toThrow(/not one of this Interview's targets/);
  expect(() => decompose({ ...opusHigh, effort: null })).toThrow(/not one of this Interview's targets/);
  expect(() => decompose({ ...opusHigh, tier: "frontier" })).toThrow(/not one of this Interview's targets/);
  const [child] = decompose(haikuNull);
  expect(pinOf(db, child!.id)).toEqual({ provider: "anthropic", model: "claude-haiku-4-5", effort: null, tier_id: tierIdOf(db, "economy"), source: "interview" });
  expect(child!.tier).toBe("economy");
});

it("pin は Interview の root の子だけが持ち、pin した子は完了時レビューも別の要求も持たない", () => {
  const db = openDb(":memory:");
  const plain = registerTask(db, { ...ROOT }, new Date(0), ...HUMAN_WEBUI);
  const decomposeOne = (parent: Task, extra: object = {}) =>
    decomposeTaskViaWorker(db, parent, { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh, ...extra }] }, "auditor", new Date(0));
  expect(() => decomposeOne(plain)).toThrow(/only an Interview's children carry interview_pin/);
  const { root } = registerInterview(db);
  for (const extra of [{ review_flag: true }, { risk_flag: true }, { tier: "standard" }, { priority: "cost" }]) {
    expect(() => decomposeOne(root, extra)).toThrow(/an Interview child runs at its pin/);
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
  expect(pinOf(db, child.id)).toEqual({ provider: "anthropic", model: "claude-opus-5-5", effort: "high", tier_id: tierIdOf(db, "standard"), source: "interview" });
});

it("pin の子は分解できない —— agent の decompose も人間の扉も拒み、承認 question も含めて何も登録されない(ADR 0245 決定1)", () => {
  const { db, root } = registerInterview();
  const [child] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh }] }, "auditor", new Date(0));
  const before = listBoard(db).length;
  const split = { reason: "too large for one session", children: [{ ...CHILD, assignee: "deckhand" }] };
  expect(() => decomposeTaskViaWorker(db, child!, split, "tako", new Date(0), { authority: { assignable_to: [] } })).toThrow(/this task is not split/);
  expect(() => humanDecomposeTaskViaWebui(db, child!, split, new Date(0))).toThrow(/this task is not split/);
  expect(listBoard(db)).toHaveLength(before);
});

it("Interview の root の子は全部 pin を持つ —— pin の無い子を混ぜた decompose は、人間の扉でも何も登録せず拒まれる(ADR 0245 決定4)", () => {
  const { db, root } = registerInterview();
  const unpinned = { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh }, CHILD] };
  expect(() => decomposeTaskViaWorker(db, root, unpinned, "auditor", new Date(0))).toThrow(/every child of an Interview carries interview_pin/);
  expect(() => humanDecomposeTaskViaWebui(db, root, { reason: "r", children: [CHILD] }, new Date(0))).toThrow(/every child of an Interview carries interview_pin/);
  expect(listChildren(db, root.id)).toEqual([]);
});

it("Interview の decompose は対象の一覧の各対象にちょうど1つの子を求める —— 欠けた対象は agent の decompose でも人間の扉でも拒否の文に名指され、何も登録されない(ADR 0249 決定1・3)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull, sonnetHigh]);
  const missing = { reason: "r", children: pinned(opusHigh, haikuNull) };
  // 権限外で承認 question になる子を混ぜても、question も立たない
  const [outside, inside] = missing.children;
  const withOutside = { reason: "r", children: [{ ...outside!, assignee: "deckhand" }, inside!] };
  expect(() => decomposeTaskViaWorker(db, root, withOutside, "auditor", new Date(0), { authority: { assignable_to: [] } })).toThrow(`no child pins ${JSON.stringify(sonnetHigh)}`);
  expect(() => humanDecomposeTaskViaWebui(db, root, missing, new Date(0))).toThrow(`no child pins ${JSON.stringify(sonnetHigh)}`);
  expect(listChildren(db, root.id)).toEqual([]);
});

it("同じ対象への2つ目の子も、agent の decompose でも人間の扉でも拒否の文に名指され、何も登録されない(ADR 0249 決定1・3)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull, sonnetHigh]);
  const doubled = { reason: "r", children: pinned(opusHigh, opusHigh, haikuNull, sonnetHigh) };
  expect(() => decomposeTaskViaWorker(db, root, doubled, "auditor", new Date(0))).toThrow(`more than one child pins ${JSON.stringify(opusHigh)}`);
  expect(() => humanDecomposeTaskViaWebui(db, root, doubled, new Date(0))).toThrow(`more than one child pins ${JSON.stringify(opusHigh)}`);
  expect(listChildren(db, root.id)).toEqual([]);
});

it("各対象を1つずつ覆う decompose は通る —— 権限外の assignee で承認 question になる子も、その対象を覆う子として数える(ADR 0249 決定1)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull, sonnetHigh]);
  const [outside, ...inside] = pinned(sonnetHigh, opusHigh, haikuNull);
  const split = { reason: "one child per target", children: [{ ...outside!, assignee: "deckhand" }, ...inside] };
  decomposeTaskViaWorker(db, root, split, "auditor", new Date(0), { authority: { assignable_to: [] } });
  expect(listChildren(db, root.id).map((task) => task.type).sort()).toEqual(["question", "work", "work"]);
});

it("Interview の root は作り直せない —— 子の前提の破綻を受けた root の redecompose は拒まれ、子は cancel されず何も登録されない(ADR 0245 決定3)", () => {
  const { db, root } = registerInterview();
  const [child] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh }] }, "auditor", new Date(0));
  declarePremiseBreach(db, child!, "the probe is broken", "tako", new Date(0), "worker");
  const replan = { reason: "a fixed probe", children: [{ ...CHILD, interview_pin: opusHigh }] };
  expect(() => redecompose(db, getTask(db, root.id)!, replan, "auditor", new Date(0), undefined, undefined, "worker")).toThrow(/continue_decomposition/);
  expect(listChildren(db, root.id).map(({ id, status }) => ({ id, status }))).toEqual([{ id: child!.id, status: "todo" }]);
});

it("Interview の root は2回分解できない —— 分解の直後から decompose は拒まれ、外れた pin も同じ文で拒まれ、何も登録されない。分解の verb は最初の分解の後に両方伏せる(ADR 0245 決定3)", () => {
  const { db, root } = registerInterview();
  expect(withheldDecompositionVerbs(db, root.id)).toEqual(["redecompose"]);
  decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh }] }, "auditor", new Date(0));
  const before = listChildren(db, root.id);
  const again = { reason: "a second probe", children: [{ ...CHILD, interview_pin: opusHigh }] };
  expect(() => decomposeTaskViaWorker(db, getTask(db, root.id)!, again, "auditor", new Date(0))).toThrow(/score_interview/);
  // 外れた pin も同じ文で拒まれ、対象を探る手がかりにならない
  const guessed = { ...again, children: [{ ...CHILD, interview_pin: { ...opusHigh, effort: "low" } }] };
  expect(() => decomposeTaskViaWorker(db, getTask(db, root.id)!, guessed, "auditor", new Date(0))).toThrow(/score_interview/);
  expect(listChildren(db, root.id)).toEqual(before);
  expect(withheldDecompositionVerbs(db, root.id)).toEqual(["decompose", "redecompose"]);
});

/** root の task_cancelled が出自に名指す question の id。 */
const cancelledBy = (db: Db, taskId: string) =>
  listEvents(db, taskId).flatMap(({ payload }) => (payload.kind === "task_cancelled" && "origin_question_id" in payload ? [payload.origin_question_id] : []));

it("pin の子を失敗 question の abandon で全部 cancel すると、root は起きずにその question を出自に cancel される(ADR 0247 決定1)", () => {
  const { db, root } = registerInterview();
  const [child] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh }] }, "auditor", new Date(0));
  const question = failureQuestion(db, child!.id, new Date(0));
  answerQuestionViaWebui(db, question, ["abandon"], new Date(0));
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  expect(cancelledBy(db, root.id)).toEqual([question.id]);
  expect(nextSlotTask(db)).toBeUndefined();
});

it("pin の子の承認 question を全部 reject すると、root は起きずに最後の question を出自に cancel される(ADR 0247 決定1)", () => {
  const { db, root } = registerInterview();
  const outside = { reason: "r", children: [{ ...CHILD, assignee: "deckhand", interview_pin: opusHigh }] };
  decomposeTaskViaWorker(db, root, outside, "auditor", new Date(0), { authority: { assignable_to: [] } });
  const [question] = listChildren(db, root.id);
  answerQuestionViaWebui(db, question!, ["reject"], new Date(0), { comment: "not this assignee" });
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  expect(cancelledBy(db, root.id)).toEqual([question!.id]);
});

it("failure の abandon と承認の reject が混ざっても、最後の1つを断った答えで root が cancel される —— 未回答の承認 question が残るあいだは cancel されない(ADR 0247 決定1)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const mixed = { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh }, { ...CHILD, assignee: "deckhand", interview_pin: haikuNull as never }] };
  const [child] = decomposeTaskViaWorker(db, root, mixed, "auditor", new Date(0), { authority: { assignable_to: [] } });
  const approval = listChildren(db, root.id).find((task) => task.type === "question")!;
  answerQuestionViaWebui(db, failureQuestion(db, child!.id, new Date(0)), ["abandon"], new Date(0));
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("blocked");
  answerQuestionViaWebui(db, getTask(db, approval.id)!, ["reject"], new Date(0), { comment: "not this assignee" });
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  expect(cancelledBy(db, root.id)).toEqual([approval.id]);
});

it("Interview でない task は、子を全部 abandon されて起きたあとも decompose で分け直せる", () => {
  const db = openDb(":memory:");
  const plain = registerTask(db, { ...ROOT, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  const [child] = decomposeTaskViaWorker(db, plain, { reason: "r", children: [CHILD] }, "tako", new Date(0));
  answerQuestionViaWebui(db, failureQuestion(db, child!.id, new Date(0)), ["abandon"], new Date(0));
  const [again] = decomposeTaskViaWorker(db, getTask(db, plain.id)!, { reason: "another split", children: [CHILD] }, "tako", new Date(0));
  expect(listChildren(db, plain.id).filter((task) => task.type === "work").map(({ id, status }) => ({ id, status }))).toEqual([
    { id: child!.id, status: "cancelled" },
    { id: again!.id, status: "todo" },
  ]);
  expect(withheldDecompositionVerbs(db, plain.id)).toEqual([]);
});

/** 対象2つの Interview の root を、人間が対象ごとの pin の子2つに分解する(書き手が人間なので前提の破綻は question になる)。 */
function twoPinnedChildren() {
  const haiku = { provider: "anthropic", model: "claude-haiku-4-5", effort: null, tier: "economy" };
  const { db, root } = registerInterview(undefined, [opusHigh, haiku]);
  const split = { reason: "one child per target", children: [{ ...CHILD, interview_pin: opusHigh }, { ...CHILD, interview_pin: haiku as never }] };
  const [failed, sibling] = humanDecomposeTaskViaWebui(db, root, split, new Date(0));
  return { db, root, failed: failed!, sibling: sibling! };
}

it("pin の子の failure question は兄弟の pin の子を held にしない —— 兄弟はそのまま pickup できる(ADR 0245 決定5)", () => {
  const { db, failed, sibling } = twoPinnedChildren();
  failureQuestion(db, failed.id, new Date(0));
  expect(presentTask(db, getTask(db, sibling.id)!).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(sibling.id);
});

it("pin の子の failure question への abandon は、その子だけを cancel する —— 兄弟の pin の子は todo のまま、root は blocked のまま(ADR 0245 決定5)", () => {
  const { db, root, failed, sibling } = twoPinnedChildren();
  answerQuestionViaWebui(db, failureQuestion(db, failed.id, new Date(0)), ["abandon"], new Date(0));
  expect([getTask(db, failed.id)!.status, getTask(db, sibling.id)!.status]).toEqual(["cancelled", "todo"]);
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("blocked");
});

it("done の兄弟が居れば、最後の pin の子の failure question への abandon は root を cancel せず先頭へも動かさない —— 通常どおり起きる(ADR 0245 決定5 / ADR 0247 決定1)", () => {
  const { db, root, failed, sibling } = twoPinnedChildren();
  completeTask(db, sibling, FULL_HANDOFF, "tako", new Date(0), "worker");
  const before = getTask(db, root.id)!.sort_key;
  answerQuestionViaWebui(db, failureQuestion(db, failed.id, new Date(0)), ["abandon"], new Date(0));
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("todo");
  expect(getTask(db, root.id)!.sort_key).toBe(before);
});

it("pin の子の failure question の abandon の文は、分解判断の破棄も兄弟の件数も言わず、他の対象が残らなければ Interview も終わると条件付きで言う(ADR 0245 決定5 / ADR 0247 決定1)", () => {
  const { db, failed } = twoPinnedChildren();
  expect(abandonConsequence(db, failed)).toBe(
    `"abandon" cancels this task and its remaining work. If no other target of this Interview is done or still unsettled, the Interview ends too.`,
  );
});

it("pin の子の前提の破綻の abandon の文は、親を先頭へ戻すと言わず、Interview ごと終わり登録し直すのは人間だと言う(ADR 0247 決定2)", () => {
  const { db, failed } = twoPinnedChildren();
  const consequence = abandonConsequence(db, failed, true);
  expect(consequence).toContain("1 unfinished sibling from the same decomposition decision");
  expect(consequence).toContain("ends this Interview");
  expect(consequence).toContain("a human registers the Interview again with a fixed probe");
  expect(consequence).not.toContain("queue head");
});

it("pin の子の承認 question は、reject で他の対象が残らなければ Interview も終わると条件付きで言う(ADR 0247 決定1)", () => {
  const { db, root } = registerInterview();
  decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, assignee: "deckhand", interview_pin: opusHigh }] }, "auditor", new Date(0), {
    authority: { assignable_to: [] },
  });
  const [question] = listChildren(db, root.id);
  expect(question!.purpose).toContain(`"reject" leaves this target unregistered. If no other target of this Interview is done or still unsettled, the Interview ends too.`);
});

it("pin の子の前提の破綻の question は、これまでどおり兄弟の pin の子を held にし、その abandon は兄弟も root も cancel する(ADR 0245 決定2 / ADR 0247 決定2)", () => {
  const { db, root, failed, sibling } = twoPinnedChildren();
  const question = declarePremiseBreach(db, failed, "the probe is broken", "tako", new Date(0), "worker")!;
  expect(question.purpose).toContain("1 unfinished sibling from the same decomposition decision");
  expect(presentTask(db, getTask(db, sibling.id)!).status).toBe("held");
  answerQuestionViaWebui(db, question, ["abandon"], new Date(0));
  expect([failed.id, sibling.id, root.id].map((id) => getTask(db, id)!.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(cancelledBy(db, root.id)).toEqual([question.id]);
});

it("done の兄弟が居ても、pin の子の前提の破綻の abandon は root ごと cancel する —— done の答案はそのまま残り、root は起きない(ADR 0247 決定2)", () => {
  const { db, root, failed, sibling } = twoPinnedChildren();
  completeTask(db, sibling, FULL_HANDOFF, "tako", new Date(0), "worker");
  const question = declarePremiseBreach(db, failed, "the probe is broken", "tako", new Date(0), "worker")!;
  answerQuestionViaWebui(db, question, ["abandon"], new Date(0));
  expect([failed.id, sibling.id, root.id].map((id) => getTask(db, id)!.status)).toEqual(["cancelled", "done", "cancelled"]);
  expect(nextSlotTask(db)).toBeUndefined();
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
  expect(() => change({ setting: "delete_tier", name: "trial" })).toThrow(`unsettled tasks request it: ${root.id}`);
  completeTask(db, root, undefined, "auditor", new Date(0), "worker");
  change({ setting: "delete_tier", name: "trial" });
  expect(tierNames(db)).not.toContain("trial");
});

/** 1回の分解で root の対象ごとに pin した子を1つずつ走らせて完了させる(spawn は pin の値と対象の段で記録される)。 */
function ranChildren(db: Db, root: Task) {
  const targets = interviewTargets(db, root.id)!;
  return decomposeTaskViaWorker(db, root, { reason: "r", children: pinned(...targets) }, "auditor", new Date(0)).map((child, i) => {
    const { model, effort, tier } = targets[i]!;
    const spawned = { ...WORKER_SPAWNED, advisor: null, model, effort, tier_id: tierIdOf(db, tier) };
    appendEvent(db, { taskId: child.id, workerId: "tako", origin: "board", at: new Date(0), payload: spawned });
    return completeTask(db, child, FULL_HANDOFF, "tako", new Date(0), "worker");
  });
}

it("学習器は Interview の子の採点を、同じセル・同じ段の観測として本番の episode と並べて数え、種別は episode に残る(ADR 0181 決定4 / ADR 0210 決定4)", () => {
  // 同じ対象は1つの一覧に2つ置けない(ADR 0249 決定2)ので、同じセルの答案3つは Interview 3件から取る
  const db = openDb(":memory:");
  const roots = [1, 2, 3].map(() => registerInterview(db).root);
  const [accepted, rejected, unscored] = roots.map((root) => ranChildren(db, root)[0]) as [Task, Task, Task];
  scoreInterview(db, roots[0]!, accepted.id, "accepted", "auditor", new Date(1), "worker");
  scoreInterview(db, roots[1]!, rejected.id, "rejected", "auditor", new Date(1), "worker");
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

it("採点の無い done の pin の子が残るあいだ root は完了できず、拒否は score_interview と未採点の子を名指す —— accepted でも rejected でも全部採点すれば完了できる(ADR 0247 決定4)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const [accepted, rejected] = ranChildren(db, root) as [Task, Task];
  scoreInterview(db, root, accepted.id, "accepted", "auditor", new Date(1), "worker");
  const complete = () => completeTask(db, getTask(db, root.id)!, undefined, "auditor", new Date(1), "worker");
  expect(complete).toThrow(/score_interview/);
  expect(complete).toThrow(new RegExp(`unscored: ${rejected.id}$`));
  scoreInterview(db, root, rejected.id, "rejected", "auditor", new Date(1), "worker");
  expect(complete().status).toBe("done");
});

it("採点は Interview の root が、決着した自分の pin の子にだけ付けられる", () => {
  const { db, root } = registerInterview();
  const [open] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, interview_pin: opusHigh }] }, "auditor", new Date(0));
  expect(() => scoreInterview(db, root, open!.id, "accepted", "auditor", new Date(0), "worker")).toThrow(/only a done child/);
  const other = registerInterview(db).root;
  const [done] = ranChildren(db, other) as [Task];
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

it("着地しない pin の子は、workspace の削除の扉が数える「着地し直す祖先」にならない(ADR 0234 決定1)", () => {
  const { db, root } = registerInterview();
  const [child] = decomposeTaskViaWorker(db, root, { reason: "r", children: [{ ...CHILD, workspace: "reef", interview_pin: opusHigh }] }, "auditor", new Date(0));
  completeTask(db, child!, FULL_HANDOFF, "tako", new Date(0), "worker");
  registerTask(db, { type: "work", ...CHILD, parent_id: child!.id, workspace: "other" }, new Date(0), ...HUMAN_WEBUI);
  expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(0);
});

it("Interview の root の history で、pin の子は採点のための id を持ち、走った agent も model も持たない(伏せた handoff)", () => {
  const { db, root } = registerInterview();
  const [child] = ranChildren(db, root) as [Task];
  const [entry] = taskHistoryRows(db, root.id).map((row) => row.entry).filter((entry) => "children" in entry);
  expect(entry).toEqual({ decision: "r", children: [expect.objectContaining({ id: child.id, title: CHILD.title, handoff_doc: child.handoff_doc })] });
  expect(Object.keys((entry as { children: object[] }).children[0]!).sort()).toEqual(["completion_criteria", "handoff_doc", "id", "purpose", "status", "title"]);
});
