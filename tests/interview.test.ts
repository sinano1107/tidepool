import { expect, it } from "vitest";
import type { AdvisorCeiling } from "../src/claude-model-alias.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents, taskDecisionLog } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor, firstSelectable } from "../src/execution-setting.js";
import { registerThroughHumanDoor } from "../src/human-verbs.js";
import { taskIdsAwaitingLanding, taskIdsAwaitingLandingInWorkspace } from "../src/landing.js";
import type { Provider } from "../src/provider.js";
import { buildMorningDigest } from "../src/push.js";
import { registerQuarantine, tableRowEffortValue, tableRowValue } from "../src/quarantine.js";
import { abandonConsequence, cancelTaskDirectly, completeAudit, completeInterview, completeTask, countUnsettledTasksReferencing, declarePremiseBreach, escalateTask, getRegistrant, getTask, type InterviewFields, interviewFields, interviewTargets, listBoard, listChildren, listExaminees, logDecision, nextSlotTask, openedPlaceNames, pickupTask, poseProbe, presentTask, redecompose, registerTask, reportBrokenProbe, resolveTaskAgent, retryInterviewRoot, type Task, taskHistoryRows, taskVerbSwap, unrowedTarget, whyNoReturnDestination } from "../src/tasks.js";
import { tierIdOf, tierNameOf, tierNames } from "../src/tier.js";
import { commitTriage, entryObjections, listLog, raiseObjection, startTriage } from "../src/triage.js";
import { registerFailureQuestion } from "../src/watchdog.js";
import { whyAssigneeCannotTake, whyNoCompletionReview, whyReviewFlagIsInert } from "../src/webui-rules.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "../src/worker-id.js";
import { answerQuestionViaWebui, decomposeTaskViaWorker, FULL_HANDOFF, failureQuestion, HUMAN_WEBUI, humanDecomposeTaskViaWebui, markPickedUp, POSED_HEAD, poseAccepted, WORKER_SPAWNED } from "./harness.js";

// Interview(CONTEXT.md「Interview」/ ADR 0199)の domain 層の振る舞い。盤面境界の写像は interview-boundary.test.ts。

const ROOT = { type: "interview" as const, title: "interview", hypothesis: "the targets write the parser", tier: "standard" };
/** Interview でない task の欄。 */
const PLAIN = { title: "interview", purpose: "the original task", completion_criteria: "every target scored" };
const opusHigh = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
const haikuNull = { provider: "anthropic", model: "claude-haiku-4-5", effort: null };
const sonnetHigh = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" };

type RootFields = Partial<InterviewFields> & { workspace?: string; review_tier?: string; assignee?: string; tier?: string };
function registerInterview(db = openDb(":memory:"), targets: Array<Record<string, unknown>> = [opusHigh], fields: RootFields = {}) {
  return { db, root: registerTask(db, { ...ROOT, ...fields, interview_targets: targets as never }, new Date(0), ...HUMAN_WEBUI) };
}

it("Interview の root は type interview で対象の一覧を持つ —— 対象は表の行でなくてよく、effort の「無い」も対象の値で、段は root の tier(ADR 0199 決定1 / ADR 0218 決定5 / ADR 0273 決定2・6)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  expect(root).toMatchObject({ type: "interview", tier: "standard" });
  expect(interviewTargets(db, root.id)).toEqual([opusHigh, haikuNull]);
});

it("盤面は仮説・測る仕事・根拠の task から purpose と完了基準を組み、人間が書いた purpose は拒む(ADR 0273 決定9)", () => {
  const db = openDb(":memory:");
  const evidence = registerTask(db, { type: "work", ...PLAIN }, new Date(0), ...HUMAN_WEBUI);
  const { root } = registerInterview(db, [opusHigh], { measured_work: "a parser for a config format", evidence_task_ids: [evidence.id] });
  for (const text of [ROOT.hypothesis, "a parser for a config format", evidence.id]) expect(root.purpose).toContain(text);
  expect(root.completion_criteria).toMatch(/complete_interview/);
  expect(() => registerTask(db, { ...ROOT, ...PLAIN, interview_targets: [opusHigh] as never }, new Date(0), ...HUMAN_WEBUI)).toThrow(DomainError);
});

it("空白だけの測る仕事は「無し」として記録され、欄にも purpose にも出ない —— Interview でない type の空の測る仕事は従来どおり拒む(ADR 0273 決定9)", () => {
  for (const measured_work of ["", "  \n "]) {
    const { db, root } = registerInterview(undefined, [opusHigh], { measured_work });
    expect(interviewFields(db, root.id)).not.toHaveProperty("measured_work");
    expect(root.purpose).not.toContain("Work to measure:");
  }
  expect(() => registerTask(openDb(":memory:"), { type: "work", ...PLAIN, measured_work: "" }, new Date(0), ...HUMAN_WEBUI)).toThrow(/only an Interview \(type interview\) carries/);
});

it("登録は仮説の空・測る段の欠け・測る段より下の root の段・知らない根拠の task・対象の無い一覧を拒む —— 測る段以上の root の段は通る(ADR 0273 決定6・9)", () => {
  expect(() => registerTask(openDb(":memory:"), { ...ROOT, hypothesis: "  ", interview_targets: [opusHigh] as never }, new Date(0), ...HUMAN_WEBUI)).toThrow(/hypothesis/);
  expect(() => registerTask(openDb(":memory:"), { ...ROOT, tier: undefined, interview_targets: [opusHigh] as never }, new Date(0), ...HUMAN_WEBUI)).toThrow(/tier/);
  expect(() => registerInterview(undefined, [opusHigh], { review_tier: "economy" })).toThrow(/review_tier "economy" is below the measured tier "standard"/);
  expect(() => registerInterview(undefined, [opusHigh], { evidence_task_ids: ["no-such-task"] })).toThrow(/no-such-task/);
  expect(() => registerInterview(undefined, [])).toThrow(/at least one target/);
  expect(registerInterview(undefined, [opusHigh], { review_tier: "frontier" }).root.review_tier).toBe("frontier");
  // 対象の一覧は Interview だけが持つ
  expect(() => registerTask(openDb(":memory:"), { type: "review", ...PLAIN, interview_targets: [opusHigh] as never }, new Date(0), ...HUMAN_WEBUI)).toThrow(DomainError);
});

it("登録の扉は未知の Provider、anthropic の alias、走らない effort の対象を拒む(ADR 0199 決定3 / ADR 0182 決定1 / ADR 0218 決定4)", () => {
  expect(() => registerInterview(undefined, [{ ...opusHigh, provider: "acme" }])).toThrow(/unknown provider "acme"/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, model: "opus" }])).toThrow(/"opus" is a Claude CLI alias/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, model: "claude-opus-4-5", effort: "max" }])).toThrow(/runs as high/);
  expect(() => registerInterview(undefined, [{ ...opusHigh, effort: "ultra" }])).toThrow(/effort must be one of/);
});

it("登録の扉は3欄一致の対象を2つ含む一覧を拒み、effort の null 同士も一致として扱う —— effort だけ違う2つは通る(ADR 0249 決定2 / ADR 0218 決定5 / ADR 0273 決定6)", () => {
  expect(() => registerInterview(undefined, [haikuNull, opusHigh, { ...haikuNull }])).toThrow(`${JSON.stringify(haikuNull)} appears more than once`);
  const { db, root } = registerInterview(undefined, [opusHigh, { ...opusHigh, effort: "medium" }]);
  expect(interviewTargets(db, root.id)).toEqual([opusHigh, { ...opusHigh, effort: "medium" }]);
});

it("表の行と一致する対象かは3欄 + root の測る段で決まる —— 同じ3欄でも root の段に行が無ければ表の行でない(ADR 0199 決定2 / ADR 0273 決定6)", () => {
  // 種の表は claude-opus-5-5 / high を standard に持つ
  const examineeAt = (tier: string) => {
    const { db, root } = registerInterview(undefined, [opusHigh], { tier });
    return { db, examinee: poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD)[0]! };
  };
  const rowed = examineeAt("standard");
  expect(unrowedTarget(rowed.db, rowed.examinee)).toBeUndefined();
  const unrowed = examineeAt("frontier");
  expect(unrowedTarget(unrowed.db, unrowed.examinee)).toEqual(opusHigh);
});

it("空の assignee は Interviewer ポインタに type で解決され、組み込み agent を interview の assignee に名指せる(ADR 0233 追記2 / ADR 0228 追記)", async () => {
  const { db, root } = registerInterview();
  expect(resolveTaskAgent(root, "tako", "auditor", "suzumedai")).toBe("suzumedai");
  const deps = { db, pollNow: () => {}, agentRegistered: () => true, resolvesToBuiltIn: (name: string) => name === "fugu" };
  const named = await registerThroughHumanDoor(deps, { ...ROOT, assignee: "fugu", interview_targets: [opusHigh] as never }, () => new Date(0), "webui");
  expect(named).toMatchObject({ ok: true, task: { type: "interview", assignee: "fugu" } });
  expect(whyAssigneeCannotTake("fugu", "interview", true)).toBeUndefined();
});

it("root の走る段は盤面の判断の段・測る段・root の段の名指しのうち最も上(ADR 0273 決定6 / ADR 0200 決定4)", () => {
  const tierOf = (judgement: string, fields: RootFields) => {
    const db = openDb(":memory:");
    applyExecutionSettingsChange(db, { setting: "judgement_tier", value: judgement }, "webui", new Date(0));
    const { root } = registerInterview(db, [opusHigh], fields);
    const [setting] = executionSettingsFor(db, { provider: [{ name: "anthropic", advisor: false }], tier: undefined }, getTask(db, root.id)!);
    return tierNameOf(db, setting!.tier_id);
  };
  expect(tierOf("economy", { tier: "standard" })).toBe("standard");
  expect(tierOf("economy", { tier: "standard", review_tier: "frontier" })).toBe("frontier");
  expect(tierOf("frontier", { tier: "economy" })).toBe("frontier");
});

/** 子が走る pin: anthropic の entry を持つ agent の候補の値と段。 */
function pinOf(db: Db, taskId: string) {
  const [setting] = executionSettingsFor(db, { provider: [{ name: "anthropic", advisor: false }], tier: undefined }, getTask(db, taskId)!);
  return setting && { provider: setting.provider, model: setting.model, effort: setting.effort, tier_id: setting.tier_id, source: setting.source.tier };
}

const CHILD = { title: "probe", purpose: "run the probe", completion_criteria: "the probe's deliverable" };
const POSE = { title: "add a parser", probe: "write a parser for the config format", completion_criteria: "the parser handles every sample", rubric: "tests pass, no new dependency" };
it("受験者は分解できない —— agent の decompose も人間の扉も拒み、承認 question も含めて何も登録されない(ADR 0245 決定1)", () => {
  const { db, root } = registerInterview();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  const before = listBoard(db).length;
  const split = { reason: "too large for one session", children: [{ ...CHILD, assignee: "deckhand" }] };
  expect(() => decomposeTaskViaWorker(db, child!, split, "tako", new Date(0), { authority: { assignable_to: [] } })).toThrow(/this task is not split/);
  expect(() => humanDecomposeTaskViaWebui(db, child!, split, new Date(0))).toThrow(/this task is not split/);
  expect(listBoard(db)).toHaveLength(before);
});

it("受験者は分解の verb と記憶を書く verb を伏せ、root の verb の一覧は出題の前後で変わらない(ADR 0245 決定1 / ADR 0268 決定2 / ADR 0273 決定2。root の一覧そのものは interview-boundary.test.ts の tools/list)", () => {
  const { db, root } = registerInterview();
  const verbs = () => {
    const { withheld, added } = taskVerbSwap(db, root.id);
    return { withheld, added };
  };
  const before = verbs();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  expect(verbs()).toEqual(before);
  expect(taskVerbSwap(db, child!.id)).toEqual({ withheld: ["decompose", "redecompose", "record_knowledge", "define_memory_branch"], added: [] });
});

it("Interview の root は作り直せない —— 出題済みの root の redecompose は拒まれ、受験者は cancel されず何も登録されない(ADR 0245 決定3)", () => {
  const { db, root } = registerInterview();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  const replan = { reason: "a fixed probe", children: [CHILD] };
  expect(() => redecompose(db, getTask(db, root.id)!, replan, "auditor", new Date(0), undefined, undefined, "worker")).toThrow(
    "an Interview is not redecomposed: score every done answer with complete_interview, or report the probe broken with report_broken_probe",
  );
  expect(listExaminees(db, root.id).map(({ id, status }) => ({ id, status }))).toEqual([{ id: child!.id, status: "todo" }]);
});

it("root は対象を待つ —— 出題前は blocked でなく拾われ、出題後は答案が未決着の対象がある間、表示 blocked・pickup 候補外・採点完了の拒否。受験者の下の question が止めるのは受験者だけで、全部決着すると root が拾われる(ADR 0267 決定2 / ADR 0049 決定4)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  expect(presentTask(db, root).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(root.id);
  const [failing, other] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task, Task];
  const question = failureQuestion(db, failing.id, new Date(0));
  const statuses = () => Object.fromEntries(listBoard(db).filter((task) => task.type === "work" || task.type === "interview").map((task) => [task.id, task.status]));
  expect(statuses()).toEqual({ [root.id]: "blocked", [failing.id]: "blocked", [other.id]: "todo" });
  expect(nextSlotTask(db)?.id).toBe(other.id);
  completeTask(db, other, FULL_HANDOFF, "tako", new Date(0), "worker");
  expect(nextSlotTask(db)).toBeUndefined();
  const scores = [{ child_id: other.id, outcome: "accepted" as const }];
  expect(() => completeInterview(db, getTask(db, root.id)!, { scores, handoff: FINDINGS }, "auditor", new Date(1), "worker")).toThrow(/unfinished children/);
  answerQuestionViaWebui(db, question, ["abandon"], new Date(1));
  expect(nextSlotTask(db)?.id).toBe(root.id);
});

it("受験者の前提の破綻の宣言は、本番の親の無い work と同じ文の DomainError(escalate を指す)で拒まれ、question も event も立たない(ADR 0267 決定1・7)", () => {
  const { db, root } = registerInterview();
  const [examinee] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  const plain = registerTask(db, { type: "work", ...CHILD }, new Date(0), ...HUMAN_WEBUI);
  const declare = (task: Task) => () => declarePremiseBreach(db, task, "the probe is broken", "tako", new Date(0), "worker");
  const refusal = (() => { try { declare(plain)(); } catch (err) { return (err as Error).message; } })()!;
  expect(refusal).toMatch(/escalates instead/);
  const before = { board: listBoard(db).length, events: listEvents(db, examinee.id).length };
  expect(declare(examinee)).toThrow(new DomainError(refusal));
  expect({ board: listBoard(db).length, events: listEvents(db, examinee.id).length }).toEqual(before);
});

it("done の受験者は root が決着するまで盤面の一覧に残り、root の決着で一緒に退く —— 受験者の行は Interview の root を名指す(ADR 0267 決定6)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const [done, open] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task, Task];
  completeTask(db, done, FULL_HANDOFF, "tako", new Date(0), "worker");
  // 決着した監査 review も root の木として残る
  const [audit] = listChildren(db, root.id);
  expect(listBoard(db).map(({ id, interview_root_id }) => ({ id, interview_root_id }))).toEqual([
    { id: root.id, interview_root_id: null },
    { id: audit!.id, interview_root_id: null },
    { id: done.id, interview_root_id: root.id },
    { id: open.id, interview_root_id: root.id },
  ]);
  completeTask(db, open, FULL_HANDOFF, "tako", new Date(0), "worker");
  expect(listBoard(db)).toHaveLength(4);
  const scores = [done, open].map(({ id }) => ({ child_id: id, outcome: "accepted" as const }));
  completeInterview(db, getTask(db, root.id)!, { scores, handoff: FINDINGS }, "auditor", new Date(1), "worker");
  expect(listBoard(db)).toEqual([]);
});

/** root の task_cancelled が出自に名指す question の id。 */
const cancelledBy = (db: Db, taskId: string) =>
  listEvents(db, taskId).flatMap(({ payload }) => (payload.kind === "task_cancelled" && "origin_question_id" in payload ? [payload.origin_question_id] : []));

it("受験者を失敗 question の abandon で全部 cancel すると、root は起きずにその question を出自に cancel される(ADR 0247 決定1)", () => {
  const { db, root } = registerInterview();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  const question = failureQuestion(db, child!.id, new Date(0));
  answerQuestionViaWebui(db, question, ["abandon"], new Date(0));
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  expect(cancelledBy(db, root.id)).toEqual([question.id]);
  expect(nextSlotTask(db)).toBeUndefined();
});

it("Interview でない task は、子を全部 abandon されて起きたあとも decompose で分け直せる", () => {
  const db = openDb(":memory:");
  const plain = registerTask(db, { ...PLAIN, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  const [child] = decomposeTaskViaWorker(db, plain, { reason: "r", children: [CHILD] }, "tako", new Date(0));
  answerQuestionViaWebui(db, failureQuestion(db, child!.id, new Date(0)), ["abandon"], new Date(0));
  const [again] = decomposeTaskViaWorker(db, getTask(db, plain.id)!, { reason: "another split", children: [CHILD] }, "tako", new Date(0));
  expect(listChildren(db, plain.id).filter((task) => task.type === "work").map(({ id, status }) => ({ id, status }))).toEqual([
    { id: child!.id, status: "cancelled" },
    { id: again!.id, status: "todo" },
  ]);
  expect(taskVerbSwap(db, plain.id)).toEqual({ withheld: [], added: [] });
});

/** 対象2つの Interview の root が出題し、対象ごとの受験者2人が立つ。 */
function twoExaminees() {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const [failed, sibling] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  return { db, root, failed: failed!, sibling: sibling! };
}

const ONLY_THIS_TARGET = /answer and comment reach only this target/;

it("受験者の failure question の context は答えとコメントがこの対象にだけ届くと人間に言い、自分の history はその文を外して答えとコメントを運ぶ(ADR 0263 決定9)", () => {
  const { db, failed } = twoExaminees();
  registerFailureQuestion(db, failed, "worker timed out", "The worker exceeded its time limit.", new Date(0));
  const question = listChildren(db, failed.id)[0]!;
  expect(getTask(db, question.id)!.purpose).toMatch(ONLY_THIS_TARGET);
  answerQuestionViaWebui(db, question, ["retry"], new Date(0), { comment: "use the streaming API" });
  const [row] = taskHistoryRows(db, failed.id).map((r) => r.entry);
  expect(row).toEqual({ child_outside_the_decomposition: expect.objectContaining({ answer: ["retry"], comment: "use the streaming API" }) });
  expect(JSON.stringify(row)).not.toMatch(ONLY_THIS_TARGET);
  expect(JSON.stringify(row)).not.toMatch(/interview/i);
});

const ESCALATION = { context: "the sample config has two formats", questions: [{ title: "which format?", options: ["yaml", "toml"], recommendation: "yaml" }] };

it("受験者が escalate した question の context は、agent の書いた context の後ろに盤面が「この対象にだけ届く」を足し、自分の history は agent の context と答え・コメントを運ぶ(ADR 0263 決定9)", () => {
  const { db, failed } = twoExaminees();
  const question = escalateTask(db, failed, ESCALATION, "tako", new Date(0), "worker");
  const purpose = getTask(db, question.id)!.purpose;
  expect(purpose.startsWith(ESCALATION.context)).toBe(true);
  expect(purpose.slice(ESCALATION.context.length)).toMatch(ONLY_THIS_TARGET);
  answerQuestionViaWebui(db, question, ["toml"], new Date(0), { comment: "toml only" });
  expect(taskHistoryRows(db, failed.id).map((r) => r.entry)).toEqual([
    { child_outside_the_decomposition: expect.objectContaining({ purpose: ESCALATION.context, answer: ["toml"], comment: "toml only" }) },
  ]);
});

it("本番の work の failure と escalation の question の context は「この対象にだけ届く」を持たず、history は purpose をそのまま運ぶ", () => {
  const db = openDb(":memory:");
  const task = registerTask(db, { ...CHILD, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  registerFailureQuestion(db, task, "worker failed", "The worker exceeded its time limit.", new Date(0));
  answerQuestionViaWebui(db, listChildren(db, task.id)[0]!, ["retry"], new Date(0));
  const escalated = escalateTask(db, getTask(db, task.id)!, ESCALATION, "tako", new Date(0), "worker");
  expect(escalated.purpose).toBe(ESCALATION.context);
  answerQuestionViaWebui(db, escalated, ["toml"], new Date(0), { comment: "toml only" });
  const questions = listChildren(db, task.id);
  for (const q of questions) expect(q.purpose).not.toMatch(ONLY_THIS_TARGET);
  expect(taskHistoryRows(db, task.id).map((r) => r.entry)).toEqual(
    questions.map((q) => ({ child_outside_the_decomposition: expect.objectContaining({ purpose: q.purpose, comment: q.question_answer_comment }) })),
  );
});

it("retry 後の受験者の failure question の history は失敗の理由と再実行の帰結を残し、Interview の帰結だけを伏せる —— 人間の context は残る(ADR 0245 決定2 / ADR 0247 決定1)", () => {
  const { db, failed } = twoExaminees();
  registerFailureQuestion(db, failed, "worker timed out", "The worker exceeded its time limit. Last utterance: still parsing.", new Date(0));
  const question = listChildren(db, failed.id)[0]!;
  answerQuestionViaWebui(db, question, ["retry"], new Date(0));

  const history = taskHistoryRows(db, failed.id).map((row) => row.entry);
  expect(JSON.stringify(history)).not.toMatch(/interview/i);
  expect(history).toEqual([
    { child_outside_the_decomposition: expect.objectContaining({
      purpose: `The worker exceeded its time limit. Last utterance: still parsing.\n\n` +
        `"retry" picks this task up again at the queue head: a new worker session continues on its existing task branch, with the work in progress kept. ` +
        `"abandon" cancels this task and its remaining work.`,
      answer: ["retry"],
    }) },
  ]);
  expect(getTask(db, question.id)!.purpose).toContain("If no other target of this Interview is done or still unsettled, the Interview ends too.");
});

it("通常の task の failure question の history は Interview の帰結と同じ文が理由にあっても purpose をそのまま運ぶ", () => {
  const db = openDb(":memory:");
  const task = registerTask(db, { ...CHILD, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  registerFailureQuestion(db, task, "worker failed", "Quoted output: If no other target of this Interview is done or still unsettled, the Interview ends too.", new Date(0));
  const question = listChildren(db, task.id)[0]!;
  answerQuestionViaWebui(db, question, ["retry"], new Date(0));
  expect(taskHistoryRows(db, task.id).map((row) => row.entry)).toEqual([
    { child_outside_the_decomposition: expect.objectContaining({ purpose: getTask(db, question.id)!.purpose }) },
  ]);
});

it("受験者の失敗理由に引用された Interview の帰結は逐語で残し、末尾の生成文だけを history から外す", () => {
  const { db, failed } = twoExaminees();
  registerFailureQuestion(db, failed, "worker failed", "Quoted output: If no other target of this Interview is done or still unsettled, the Interview ends too.", new Date(0));
  const question = listChildren(db, failed.id)[0]!;
  answerQuestionViaWebui(db, question, ["retry"], new Date(0));
  expect(taskHistoryRows(db, failed.id).map((row) => row.entry)).toEqual([
    { child_outside_the_decomposition: expect.objectContaining({
      purpose: `Quoted output: If no other target of this Interview is done or still unsettled, the Interview ends too.\n\n` +
        `"retry" picks this task up again at the queue head: a new worker session continues on its existing task branch, with the work in progress kept. ` +
        `"abandon" cancels this task and its remaining work.`,
    }) },
  ]);
});

it("受験者の failure question への abandon は、その受験者だけを cancel する —— 他の対象の受験者は todo のまま、root は blocked のまま(ADR 0267 決定1)", () => {
  const { db, root, failed, sibling } = twoExaminees();
  answerQuestionViaWebui(db, failureQuestion(db, failed.id, new Date(0)), ["abandon"], new Date(0));
  expect([getTask(db, failed.id)!.status, getTask(db, sibling.id)!.status]).toEqual(["cancelled", "todo"]);
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("blocked");
});

it("他の対象の答案が done なら、最後の受験者の failure question への abandon は root を cancel せず先頭へも動かさない —— 通常どおり起きる(ADR 0267 決定1 / ADR 0247 決定1)", () => {
  const { db, root, failed, sibling } = twoExaminees();
  completeTask(db, sibling, FULL_HANDOFF, "tako", new Date(0), "worker");
  const before = getTask(db, root.id)!.sort_key;
  answerQuestionViaWebui(db, failureQuestion(db, failed.id, new Date(0)), ["abandon"], new Date(0));
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("todo");
  expect(getTask(db, root.id)!.sort_key).toBe(before);
});

it("受験者の failure question の abandon の文は、分解判断の破棄も他の対象の件数も言わず、他の対象が残らなければ Interview も終わると条件付きで言う(ADR 0267 決定1 / ADR 0247 決定1)", () => {
  const { db, failed } = twoExaminees();
  expect(abandonConsequence(db, failed)).toBe(
    `"abandon" cancels this task and its remaining work. If no other target of this Interview is done or still unsettled, the Interview ends too.`,
  );
});

/** 対象3つの root が出題し、受験者の1人は done、1人は failure question、1人は escalation の question を開いたまま。 */
function examineesWithOpenQuestions(fields: { workspace?: string; review_tier?: string; assignee?: string } = {}) {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull, sonnetHigh], fields);
  const [done, failing, escalating] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task, Task, Task];
  completeTask(db, done, FULL_HANDOFF, "tako", new Date(0), "worker");
  const questions = [failureQuestion(db, failing.id, new Date(0)), escalateTask(db, escalating, ESCALATION, "tako", new Date(0), "worker")];
  return { db, root: getTask(db, root.id)!, done, unsettled: [failing, escalating], questions };
}

it("走行中の受験者があれば Interview の root の直接 cancel 全体を拒み、記録を保つ(ADR 0304 決定1 / ADR 0267 決定3)", () => {
  const { db, root } = registerInterview();
  const [examinee] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  pickupTask(db, examinee, "tako", new Date(0));
  const before = listBoard(db);
  const events = before.map((task) => listEvents(db, task.id));

  expect(() => cancelTaskDirectly(db, getTask(db, root.id)!, null, new Date(1), {}, "webui")).toThrow(DomainError);
  expect(() => cancelTaskDirectly(db, getTask(db, root.id)!, null, new Date(1), {}, "webui")).toThrow(`"${examinee.title}" (${examinee.id}) is running`);
  expect(listBoard(db)).toEqual(before);
  expect(before.map((task) => listEvents(db, task.id))).toEqual(events);
});

it("出題済みの root の直接 cancel は、受験者の failure question と escalation が開いていても拒まれず、未決着の受験者とその question を回答なしで root の cancel の理由ごと cancel する —— done の答案は残る(ADR 0267 決定3)", () => {
  const { db, root, done, unsettled, questions } = examineesWithOpenQuestions();
  cancelTaskDirectly(db, root, "measuring the wrong thing", new Date(1), {}, "webui");
  expect(getTask(db, done.id)!.status).toBe("done");
  for (const task of [root, ...unsettled, ...questions]) {
    expect(getTask(db, task.id)).toMatchObject({ status: "cancelled", question_answer: null });
    expect(listEvents(db, task.id).find((event) => event.kind === "task_cancelled_directly")!.payload).toEqual({ kind: "task_cancelled_directly", reason: "measuring the wrong thing" });
  }
  expect(nextSlotTask(db)).toBeUndefined();
});

it("直接 cancel の門は受験者の資源の quarantine も数えない —— 受験者だけが使う agent が止まっていても root の cancel は通る(ADR 0267 決定3)", () => {
  const { db, root, unsettled } = examineesWithOpenQuestions();
  const defaults = { defaultAgentName: "tako", auditorName: "auditor", quarantined: { workspaces: [], assignees: ["tako"] } };
  cancelTaskDirectly(db, root, null, new Date(1), defaults, "webui");
  expect([root, ...unsettled].map(({ id }) => getTask(db, id)!.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
});

it("受験者は人間の直接 cancel の範囲の外 —— root の agent が登録した task なので拒まれ、何も cancel されない。受験者を外すのは failure の abandon か「この対象は測らない」(ADR 0198 / ADR 0267 決定1)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const [examinee] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  expect(() => cancelTaskDirectly(db, examinee, null, new Date(1), {}, "webui")).toThrow(DomainError);
  expect(getTask(db, examinee.id)!.status).toBe("todo");
});

it("受験者の完了は完了時レビューを立てない —— 規則の正本が理由を言い、完了の起票も同じ規則を読む(ADR 0267 決定1 / ADR 0111 追記8)", () => {
  expect(whyNoCompletionReview({ type: "work", parent_id: null, examinee: true })).toMatch(/Interview examinee/);
  expect(whyReviewFlagIsInert({ type: "work", parent_id: null, examinee: true })).toMatch(/Interview examinee/);
  const { db, root } = registerInterview();
  const [examinee] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  completeTask(db, examinee, FULL_HANDOFF, "tako", new Date(0), "worker");
  expect(listBoard(db).filter((task) => task.type === "review" && task.parent_id !== root.id)).toEqual([]);
});

/** 採点の段階の root: 出題して対象ごとの受験者を全部 done にした(答案は FULL_HANDOFF)。 */
function scoringRoot(fields: { assignee?: string } = {}) {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull], fields);
  const children = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD).map((child) => completeTask(db, child, FULL_HANDOFF, "tako", new Date(0), "worker"));
  return { db, root: getTask(db, root.id)!, children };
}
const BROKEN = { reason: "the probe leaks the expected output", recommendation: "retry" as const };
const report = (db: Db, root: Task, input: { reason: string; recommendation: "abandon" | "retry" } = BROKEN) =>
  reportBrokenProbe(db, getTask(db, root.id)!, input, "auditor", new Date(1), "worker");

it("probe の破綻の報告は root の agent 名義の question(continue / abandon / retry、推奨は root の指定)を立て、context に理由・probe・rubric・done の受験者の id を載せて答案の本文は載せず、root を blocked にする(ADR 0251 決定1〜3 / ADR 0194 決定1)", () => {
  const { db, root, children } = scoringRoot();
  const question = report(db, root);
  expect(question.parent_id).toBe(root.id);
  expect(getRegistrant(db, question.id)).toBe("auditor");
  expect(question.question_items).toEqual([expect.objectContaining({ options: ["continue", "abandon", "retry"], recommendation: "retry" })]);
  for (const text of [BROKEN.reason, POSE.probe, POSE.rubric, ...children.map(({ id }) => id)]) expect(question.purpose).toContain(text);
  expect(question.purpose).not.toContain(FULL_HANDOFF.outcome);
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("blocked");
  expect(nextSlotTask(db)).toBeUndefined();
});

it("probe の破綻の報告は Interview でない task・受験者・出題前の root・報告したことのある root で DomainError になり、何も登録しない(ADR 0251 決定1・2)", () => {
  const { db, root, children } = scoringRoot();
  const unposed = registerInterview(db).root;
  const plain = registerTask(db, { ...PLAIN, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  report(db, root);
  const before = listBoard(db).length;
  for (const task of [plain, children[0]!, unposed, root]) expect(() => report(db, task)).toThrow(DomainError);
  for (const task of [plain, children[0]!]) expect(() => report(db, task)).toThrow("only an Interview root reports a broken probe");
  expect(() => report(db, unposed)).toThrow(/pose_probe/);
  // 人間の continue に不服なら escalate はできる(ADR 0251 決定2)
  expect(() => report(db, root)).toThrow(/complete_interview, or escalate/);
  expect(listBoard(db)).toHaveLength(before);
});

it("報告の question への continue で root が起きて採点完了でき、その後の報告は拒まれる(ADR 0251 決定2)", () => {
  const { db, root, children } = scoringRoot();
  answerQuestionViaWebui(db, report(db, root), ["continue"], new Date(1));
  expect(nextSlotTask(db)?.id).toBe(root.id);
  expect(() => report(db, root)).toThrow(DomainError);
  const scores = children.map(({ id }) => ({ child_id: id, outcome: "rejected" as const }));
  expect(completeInterview(db, getTask(db, root.id)!, { scores, handoff: FINDINGS }, "auditor", new Date(2), "worker").status).toBe("done");
});

it("報告の question への abandon で root はその question を出自に cancelled になり、起きない —— done の答案はそのまま残る(ADR 0251 決定2 / ADR 0248 決定2)", () => {
  const { db, root, children } = scoringRoot();
  const question = report(db, root);
  answerQuestionViaWebui(db, question, ["abandon"], new Date(1));
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  expect(cancelledBy(db, root.id)).toEqual([question.id]);
  expect(children.map(({ id }) => getTask(db, id)!.status)).toEqual(["done", "done"]);
  expect(nextSlotTask(db)).toBeUndefined();
});

it("報告の question への retry で root はその question を出自に cancelled になり、同じ対象・目的の Interview が人間名義で登録され、その history に旧い root・probe・rubric・報告の理由・コメントが見える(ADR 0251 決定2 / ADR 0248 決定2・3)", () => {
  const { db, root } = scoringRoot();
  const question = report(db, root);
  answerQuestionViaWebui(db, question, ["retry"], new Date(1), { comment: "rewrite the probe" });
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  expect(cancelledBy(db, root.id)).toEqual([question.id]);
  const again = listBoard(db).find((task) => task.parent_id === null && task.id !== root.id)!;
  expect(getRegistrant(db, again.id)).toBe(HUMAN_WORKER_ID);
  expect(interviewTargets(db, again.id)).toEqual([opusHigh, haikuNull]);
  expect(again.purpose).toBe(root.purpose);
  const retry = { previous_root_id: root.id, probe: POSE.probe, rubric: POSE.rubric, reason: BROKEN.reason, comment: "rewrite the probe" };
  expect(taskHistoryRows(db, again.id).map((row) => row.entry)).toEqual([{ retry_of: retry }]);
  expect(nextSlotTask(db)?.id).toBe(again.id);
});

it("報告の question への retry でも、名指した agent は新しい root に引き継がれる(ADR 0248 追記3)", () => {
  const { db, root } = scoringRoot({ assignee: "deckhand" });
  answerQuestionViaWebui(db, report(db, root), ["retry"], new Date(1));
  expect(listBoard(db).find((task) => task.parent_id === null && task.id !== root.id)!.assignee).toBe("deckhand");
});

it("probe の破綻の報告への abandon と retry も root の cancel を未決着の受験者とその question に及ぼし、それらは報告の question を出自に回答なしで cancel される(ADR 0267 決定3)", () => {
  for (const answer of ["abandon", "retry"]) {
    const { db, root, done, unsettled, questions } = examineesWithOpenQuestions();
    const question = report(db, root);
    answerQuestionViaWebui(db, question, [answer], new Date(1));
    expect(getTask(db, done.id)!.status).toBe("done");
    for (const task of [root, ...unsettled, ...questions]) {
      expect(getTask(db, task.id)).toMatchObject({ status: "cancelled", question_answer: null });
      expect(cancelledBy(db, task.id)).toEqual([question.id]);
    }
  }
});

/** 既定 agent の entry と、それを読む判定の口(ADR 0253 決定3)。entry はテストが後から書き換える。 */
function runnablePort(db: Db, ...providers: Provider[]) {
  const entry = agent(false, ...providers);
  return { entry, runnable: { candidates: (task: Parameters<typeof executionSettingsFor>[2]) => executionSettingsFor(db, entry, task) } };
}
/** 旧い root 以外の root の数 —— retry が登録した新しい Interview。 */
const otherRoots = (db: Db, root: Task) => listBoard(db).filter((task) => task.parent_id === null && task.interview_root_id === null && task.id !== root.id).length;
const UNRUNNABLE_RETRY = /target \{"provider":"anthropic","model":"claude-opus-5-5".*cannot run as the default agent.*answer "retry" again.*answer "abandon"/;

it("同じ盤面で、probe の破綻の報告の question への retry も答えごと拒まれ、question は todo のまま、root は cancel されず、新しい Interview も登録されない(ADR 0253 決定3 / ADR 0251 決定2)", () => {
  const { db, root } = scoringRoot();
  const question = report(db, root);
  const { runnable } = runnablePort(db, "openai");
  expect(() => answerQuestionViaWebui(db, question, ["retry"], new Date(1), { runnable })).toThrow(UNRUNNABLE_RETRY);
  expect([question.id, root.id].map((id) => getTask(db, id)!.status)).toEqual(["todo", "todo"]);
  expect(otherRoots(db, root)).toBe(0);
});

it("走れない対象を抱えたままでも、probe の破綻の報告の question への continue と abandon は今どおり通る(ADR 0253 決定3)", () => {
  for (const answer of ["continue", "abandon"]) {
    const scoring = scoringRoot();
    answerQuestionViaWebui(scoring.db, report(scoring.db, scoring.root), [answer], new Date(1), runnablePort(scoring.db, "openai"));
    expect(getTask(scoring.db, scoring.root.id)!.status).toBe(answer === "abandon" ? "cancelled" : "todo");
  }
});

// ── root の retry(ADR 0267 決定3・4 / ADR 0248 決定3) ──

const retryRoot = (db: Db, root: Task, comment?: string, runnable?: ReturnType<typeof runnablePort>["runnable"]) =>
  retryInterviewRoot(db, getTask(db, root.id)!, comment, new Date(1), {}, "webui", runnable);

it("出題済みで未決着の root の retry は、未決着の受験者とその question を回答なしで決着させて root を cancel し、同じ対象・題・目的・完了基準・workspace・review tier の Interview を人間名義で登録して、その history に旧い root・probe・rubric・コメントを見せる —— done の答案は残る", () => {
  const { db, root, done, unsettled, questions } = examineesWithOpenQuestions({ workspace: "reef", review_tier: "frontier", assignee: "deckhand" });
  // 受験者の escalation の question は今までどおり、受験者の書いた選択肢だけを持つ(retry は root の面にある)
  expect(questions[1]!.question_items![0]!.options).toEqual(ESCALATION.questions[0]!.options);

  const again = retryRoot(db, root, "the probe names the answer");

  expect(getTask(db, done.id)!.status).toBe("done");
  for (const task of [root, ...unsettled, ...questions]) expect(getTask(db, task.id)).toMatchObject({ status: "cancelled", question_answer: null });
  expect(getRegistrant(db, again.id)).toBe(HUMAN_WORKER_ID);
  expect(interviewTargets(db, again.id)).toEqual([opusHigh, haikuNull, sonnetHigh]);
  expect(again).toMatchObject({ title: root.title, purpose: root.purpose, completion_criteria: root.completion_criteria, workspace: "reef", review_tier: "frontier", assignee: "deckhand", status: "todo" });
  const retry = { previous_root_id: root.id, probe: POSE.probe, rubric: POSE.rubric, comment: "the probe names the answer" };
  expect(taskHistoryRows(db, again.id).map((row) => row.entry)).toEqual([{ retry_of: retry }]);
  expect(nextSlotTask(db)?.id).toBe(again.id);
});

it("名指していない root の retry は assignee を空のまま登録する —— Interviewer ポインタの名前は書き込まれない(ADR 0248 追記3 / ADR 0233 決定3)", () => {
  const { db, root } = examineesWithOpenQuestions();
  expect(retryRoot(db, root).assignee).toBeNull();
});

it("走れない対象を写す root の retry は対象を名指して拒まれ、root・受験者・question は変わらず、新しい Interview も登録されない(ADR 0253 決定3)", () => {
  const { db, root, unsettled, questions } = examineesWithOpenQuestions();
  const { runnable } = runnablePort(db, "openai");
  expect(() => retryRoot(db, root, undefined, runnable)).toThrow(/target \{"provider":"anthropic","model":"claude-opus-5-5".*cannot run as the default agent/);
  expect([root, ...unsettled, ...questions].map(({ id }) => getTask(db, id)!.status)).toEqual(["todo", "todo", "todo", "todo", "todo"]);
  expect(otherRoots(db, root)).toBe(0);
});

it("出題前の root・Interview でない task・受験者・決着済みの root への retry は DomainError で、何も変わらない", () => {
  const { db, root, done } = examineesWithOpenQuestions();
  const unposed = registerInterview(db).root;
  const plain = registerTask(db, { ...PLAIN, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  const settled = registerInterview(db).root;
  poseAccepted(db, settled, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  cancelTaskDirectly(db, getTask(db, settled.id)!, null, new Date(0), {}, "webui");
  const before = listBoard(db).map(({ id, status }) => ({ id, status }));
  for (const task of [unposed, plain, done, settled]) expect(() => retryRoot(db, task)).toThrow(DomainError);
  expect(() => retryRoot(db, unposed)).toThrow(/not posed/);
  expect(listBoard(db).map(({ id, status }) => ({ id, status }))).toEqual(before);
  expect(getTask(db, root.id)!.status).toBe("todo");

  // 採点完了で done になった root も決着済み
  const graded = scoringRoot();
  const scores = graded.children.map(({ id }) => ({ child_id: id, outcome: "accepted" as const }));
  completeInterview(graded.db, graded.root, { scores, handoff: FINDINGS }, "auditor", new Date(1), "worker");
  expect(() => retryRoot(graded.db, graded.root)).toThrow(DomainError);
  expect(otherRoots(graded.db, graded.root)).toBe(0);
});

it("断られた対象の question が開いたまま root を retry すると、新しい root がその対象を持つので question は開いたままで、決着の記録も無い(ADR 0199 追記)", () => {
  const unrowed = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" };
  const { db, root } = registerInterview(undefined, [unrowed], { tier: "economy" });
  poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  registerQuarantine(db, "interviewTarget", tableRowValue("anthropic", "claude-sonnet-5-5"), "API error 404 for this model id", new Date(0));
  const question = listBoard(db).find((task) => task.question_quarantine_kind === "interviewTarget")!;

  retryRoot(db, root);

  expect(getTask(db, question.id)!.status).toBe("todo");
  expect(listEvents(db, question.id).map((event) => event.kind)).not.toContain("quarantine_released");
});

it("task が開く場所の名前は、受験者は面接室(root id)だけ、root は実環境・自分の面接室・他に読める面接室(根拠の root と retry の旧い root)、root 配下の review は親が review でも実環境・root の面接室・root の他に読める面接室、その他は workspace 列だけ —— 面接室の在り処は見ない(ADR 0273 追記、issue #2265)", () => {
  const db = openDb(":memory:");
  const plain = registerTask(db, { type: "work", ...PLAIN }, new Date(0), ...HUMAN_WEBUI);
  const { root: evidence } = registerInterview(db);
  const { root } = registerInterview(db, [opusHigh], { workspace: "reef", evidence_task_ids: [evidence.id, plain.id] });
  const [examinee] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  const audit = listChildren(db, root.id).find((child) => child.type === "review")!;
  const nested = rcaOf(db, audit.id, new Date(0));
  const again = retryRoot(db, root);
  const names = (task: Task) => openedPlaceNames(db, task.id, "sandbox").sort();

  expect(names(examinee)).toEqual([root.id]);
  expect(names(root)).toEqual(["reef", root.id, evidence.id].sort());
  expect(names(again)).toEqual(["reef", again.id, evidence.id, root.id].sort());
  for (const review of [audit, nested]) expect(names(review)).toEqual(["reef", root.id, evidence.id].sort());
  expect(names(plain)).toEqual(["sandbox"]);
  // review の鎖は review でない祖先で切れる(`taskRunPlace` と同じ辿り方)
  const repairUnderAudit = registerTask(db, { type: "memory_repair", ...PLAIN, workspace: "reef", parent_id: audit.id }, new Date(0), ...HUMAN_WEBUI);
  logDecision(db, repairUnderAudit, "drop entry 3", "tako", new Date(0), "worker");
  const reviewUnderRepair = rcaOf(db, repairUnderAudit.id, new Date(0));
  for (const task of [repairUnderAudit, reviewUnderRepair]) expect(names(task)).toEqual(["reef"]);
});

it("workspace を指定しない付帯子の review が開く場所の名前は、既定でなく最も近い固定済みの祖先の名前(ADR 0290 決定5)", () => {
  const db = openDb(":memory:");
  const parent = registerTask(db, { type: "work", ...PLAIN, workspace: "reef" }, new Date(0), ...HUMAN_WEBUI);
  markPickedUp(db, parent.id, new Date(0));
  const review = registerTask(db, { type: "review", ...PLAIN, parent_id: parent.id }, new Date(0), ...HUMAN_WEBUI);

  expect(openedPlaceNames(db, review.id, "sandbox")).toEqual(["reef"]);
});

/** 断られた対象の question が開いたまま probe の破綻を報告した root(question は直接立てる)。断られた受験者は未決着のまま(#2132 の盤面)。 */
function brokenWithRefusedTarget() {
  const unrowed = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" };
  const { db, root } = registerInterview(undefined, [unrowed], { tier: "economy" });
  poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  registerQuarantine(db, "interviewTarget", tableRowValue("anthropic", "claude-sonnet-5-5"), "API error 404 for this model id", new Date(0));
  const question = listBoard(db).find((task) => task.question_quarantine_kind === "interviewTarget")!;
  return { db, root, question, report: report(db, root) };
}

it("probe の破綻の報告への abandon で root が cancel されると、断られた対象の question は回答なしで決着し、root の cancel を観測とする(ADR 0199 追記、issue #1999 / #2132)", () => {
  const { db, root, question, report: broken } = brokenWithRefusedTarget();

  answerQuestionViaWebui(db, broken, ["abandon"], new Date(1));

  expect(getTask(db, question.id)).toMatchObject({ status: "done", question_answer: null });
  const cancelled = listEvents(db, root.id).find((event) => event.kind === "task_cancelled")!;
  expect(listEvents(db, question.id).filter((event) => event.kind === "quarantine_released").map((event) => event.payload)).toEqual([
    { kind: "quarantine_released", quarantine: "interviewTarget", value: "anthropic/claude-sonnet-5-5", observed_event_id: cancelled.id },
  ]);
});

it("probe の破綻の報告への retry では、新しい root がその対象を持つので断られた対象の question は開いたまま(ADR 0199 追記、issue #1999 / #2132)", () => {
  const { db, question, report: broken } = brokenWithRefusedTarget();

  answerQuestionViaWebui(db, broken, ["retry"], new Date(1));

  expect(getTask(db, question.id)!.status).toBe("todo");
  expect(listEvents(db, question.id).map((event) => event.kind)).not.toContain("quarantine_released");
});

it("鍵の受験者が前に決着した Interview の root が、model の鍵への「この対象は測らない」で空になって cancel されても、effort の鍵の question の観測はその鍵を走らせうる最後の Interview の受験者の cancel を指す(ADR 0199 追記、issue #2219)", () => {
  const sonnet = (effort: string) => ({ provider: "anthropic", model: "claude-sonnet-5-5", effort });
  const { db, root: a } = registerInterview(undefined, [sonnet("low"), sonnet("medium")], { tier: "economy" });
  const [aLow, aMedium] = poseAccepted(db, a, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  // A.low は前の transaction で決着する
  registerFailureQuestion(db, aLow!, "worker failed", "The worker ended without a report.", new Date(0));
  answerQuestionViaWebui(db, listChildren(db, aLow!.id)[0]!, ["abandon"], new Date(0));
  registerQuarantine(db, "interviewTarget", tableRowValue("anthropic", "claude-sonnet-5-5"), "API error 404 for this model id", new Date(0));
  registerQuarantine(db, "interviewTargetEffort", tableRowEffortValue("anthropic", "claude-sonnet-5-5", "low"), "another observation", new Date(0));
  const [model, effort] = ["interviewTarget", "interviewTargetEffort"].map((kind) => getTask(db, listBoard(db).find((task) => task.question_quarantine_kind === kind)!.id)!);
  const { root: b } = registerInterview(db, [sonnet("low"), opusHigh], { tier: "economy" });
  const [bLow] = poseAccepted(db, b, POSE, "auditor", new Date(0), "worker", POSED_HEAD);

  answerQuestionViaWebui(db, model!, ["do not measure this target"], new Date(1));

  expect([a, aMedium!, b, bLow!].map((task) => getTask(db, task.id)!.status)).toEqual(["cancelled", "cancelled", "todo", "cancelled"]);
  const cancelledAt = (taskId: string) => listEvents(db, taskId).find((event) => event.kind === "task_cancelled")!.id;
  // root の cancel が後に積まれても、一覧に鍵を持つだけの root は観測にならない
  expect(cancelledAt(a.id)).toBeGreaterThan(cancelledAt(bLow!.id));
  expect(getTask(db, effort!.id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, effort!.id).filter((event) => event.kind === "quarantine_released").map((event) => event.payload)).toEqual([
    { kind: "quarantine_released", quarantine: "interviewTargetEffort", value: "anthropic/claude-sonnet-5-5/low", observed_event_id: cancelledAt(bLow!.id) },
  ]);
});

/** root に対象を1つ持たせ、それを pin した子を返す。 */
function pinnedChild(target: Record<string, unknown>, ceiling: AdvisorCeiling = "off") {
  const { db, root } = registerInterview(undefined, [target], { tier: "frontier" });
  applyExecutionSettingsChange(db, { setting: "advisor_ceiling", value: ceiling }, "webui", new Date(0));
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  return { db, child: child! };
}
const agent = (advisor: boolean, ...providers: Provider[]) => ({ provider: providers.map((name) => ({ name, advisor })), tier: undefined });
const opus46 = { provider: "anthropic", model: "claude-opus-4-6", effort: "high" };

it("受験者は selector の並びを通らず、表に無い対象の (provider, model, effort) と対象の段の候補だけを持つ —— 出所は interview(ADR 0199 決定2 / ADR 0210 決定4)", () => {
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

it("受験者は着地しない —— 完了しても着地の根にも「着地待ち」の数にも入らない(ADR 0241 / ADR 0226)", () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { ...ROOT, workspace: "reef", interview_targets: [opusHigh] }, new Date(0), ...HUMAN_WEBUI);
  const plain = registerTask(db, { type: "work", ...CHILD, workspace: "reef" }, new Date(0), ...HUMAN_WEBUI);
  completeTask(db, plain, FULL_HANDOFF, "tako", new Date(0), "worker");
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  completeTask(db, child!, FULL_HANDOFF, "tako", new Date(0), "worker");
  expect(taskIdsAwaitingLandingInWorkspace(db, undefined, "reef")).toHaveLength(1);
  expect(taskIdsAwaitingLanding(db, undefined, "tako", "tako")).toHaveLength(1);
});

it("未決着の Interview の対象が名指す段は消せない —— root が決着すれば消せる(ADR 0200 決定2)", () => {
  const db = openDb(":memory:");
  const change = (setting: object) => applyExecutionSettingsChange(db, setting as never, "webui", new Date(0));
  change({ setting: "insert_tier", name: "trial", description: "A tier being measured.", position: 0 });
  const { root } = registerInterview(db, [opusHigh], { tier: "trial" });
  expect(() => change({ setting: "delete_tier", name: "trial" })).toThrow(`unsettled tasks request it: ${root.id}`);
  cancelTaskDirectly(db, root, null, new Date(0), {}, "webui");
  change({ setting: "delete_tier", name: "trial" });
  expect(tierNames(db)).not.toContain("trial");
});

/** 出題で立った対象ごとの受験者を1つずつ走らせて完了させる(spawn は pin の値と対象の段で記録される)。 */
function ranChildren(db: Db, root: Task) {
  const targets = interviewTargets(db, root.id)!;
  return poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD).map((child, i) => {
    const { model, effort } = targets[i]!;
    const spawned = { ...WORKER_SPAWNED, advisor: null, model, effort, tier_id: tierIdOf(db, root.tier!) };
    appendEvent(db, { taskId: child.id, workerId: "tako", origin: "board", at: new Date(0), payload: spawned });
    return completeTask(db, child, FULL_HANDOFF, "tako", new Date(0), "worker");
  });
}

const FINDINGS = { outcome: "the parser probe separates the targets" };

it("採点完了は done の子全部をちょうど1回ずつ採点すると、各子の採点と root の完了を一度に入れる(ADR 0253 決定4)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const [accepted, rejected] = ranChildren(db, root) as [Task, Task];
  const scores = [{ child_id: rejected.id, outcome: "rejected" as const }, { child_id: accepted.id, outcome: "accepted" as const }];
  expect(completeInterview(db, getTask(db, root.id)!, { scores, handoff: FINDINGS }, "auditor", new Date(1), "worker").status).toBe("done");
  const scoreOf = (task: Task) => listEvents(db, task.id).flatMap(({ payload }) => (payload.kind === "interview_scored" ? [payload.outcome] : []));
  expect([scoreOf(accepted), scoreOf(rejected)]).toEqual([["accepted"], ["rejected"]]);
  expect(listEvents(db, root.id).find((event) => event.kind === "task_completed")!.payload).toMatchObject({ result: FINDINGS.outcome });
});

it("採点完了は欠け・重複・done でない子・他の root の子・outcome 無しを DomainError で拒み、採点も完了も入れない(ADR 0253 決定4)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull, sonnetHigh]);
  const [a, b, cancelled] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task, Task, Task];
  for (const child of [a, b]) completeTask(db, child, FULL_HANDOFF, "tako", new Date(0), "worker");
  answerQuestionViaWebui(db, failureQuestion(db, cancelled.id, new Date(0)), ["abandon"], new Date(0));
  const [otherRootsChild] = ranChildren(db, registerInterview(db).root) as [Task];
  const tasks = [root, a, b, cancelled, otherRootsChild];
  const written = () => tasks.flatMap((task) => listEvents(db, task.id)).length;
  const before = written();
  const score = (...children: Task[]) => children.map((child) => ({ child_id: child.id, outcome: "accepted" as const }));
  const complete = (scores: ReturnType<typeof score>, handoff: Record<string, string> = FINDINGS) => () =>
    completeInterview(db, getTask(db, root.id)!, { scores, handoff }, "auditor", new Date(1), "worker");
  expect(complete(score(a))).toThrow(new RegExp(`unscored: ${b.id}`));
  expect(complete(score(a, b, a))).toThrow(new RegExp(`${a.id} is scored more than once`));
  expect(complete(score(a, b, cancelled))).toThrow(new RegExp(`${cancelled.id} is not done`));
  expect(complete(score(a, b, otherRootsChild))).toThrow(new RegExp(`${otherRootsChild.id} is not a child of this Interview`));
  expect(complete(score(a, b), {})).toThrow(/outcome/);
  expect(complete(score(a, b), { outcome: "  " })).toThrow(/outcome/);
  for (const refused of [complete(score(a)), complete(score(a, b), {})]) expect(refused).toThrow(DomainError);
  expect(written()).toBe(before);
  expect(getTask(db, root.id)!.status).not.toBe("done");
});

it("採点完了は Interview の root でない task・出題前の root・未決着の子が残る root を拒み、何も入れない(ADR 0253 決定4)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const plain = registerTask(db, { ...PLAIN, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  const complete = (task: Task, scores: Array<{ child_id: string; outcome: "accepted" }> = []) => () =>
    completeInterview(db, task, { scores, handoff: FINDINGS }, "auditor", new Date(1), "worker");
  expect(complete(plain)).toThrow(/only an Interview root/);
  expect(complete(getTask(db, root.id)!)).toThrow(/pose_probe/);
  const [done, open] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task, Task];
  completeTask(db, done, FULL_HANDOFF, "tako", new Date(0), "worker");
  expect(complete(open)).toThrow(/only an Interview root/);
  // done の子の採点を渡しても、未決着の子が残れば採点ごと入らない
  expect(complete(getTask(db, root.id)!, [{ child_id: done.id, outcome: "accepted" }])).toThrow(/unfinished children/);
  expect([root, plain, done, open].flatMap((task) => listEvents(db, task.id)).map((event) => event.kind)).not.toContain("interview_scored");
  expect([getTask(db, root.id)!.status, getTask(db, plain.id)!.status]).not.toContain("done");
});

it("completeTask は Interview の root を出題の前も後も拒み、出題前は pose_probe を指す —— 子0のまま完了できない(ADR 0253 決定5。出題後の文は「出題済みの root に届く拒否」のテスト)", () => {
  const { db, root } = registerInterview();
  const complete = () => completeTask(db, getTask(db, root.id)!, FINDINGS, "auditor", new Date(1), "worker");
  expect(complete).toThrow(/pose_probe/);
  ranChildren(db, root);
  expect(complete).toThrow(DomainError);
  expect(getTask(db, root.id)!.status).not.toBe("done");
});

it("着地しない受験者は、workspace の削除の扉が数える「着地し直す祖先」にならない(ADR 0234 決定1)", () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { ...ROOT, workspace: "reef", interview_targets: [opusHigh] }, new Date(0), ...HUMAN_WEBUI);
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  completeTask(db, child!, FULL_HANDOFF, "tako", new Date(0), "worker");
  // root も reef を指すので、採点完了させてから数える
  completeInterview(db, getTask(db, root.id)!, { scores: [{ child_id: child!.id, outcome: "accepted" }], handoff: FINDINGS }, "auditor", new Date(0), "worker");
  // 受験者の下に生えるのは question だけ(ADR 0268 決定5)
  failureQuestion(db, child!.id, new Date(0));
  expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(0);
});

it("Interview の root の history で、受験者は採点のための id を持ち、走った agent も model も持たない(伏せた handoff)", () => {
  const { db, root } = registerInterview();
  const [child] = ranChildren(db, root) as [Task];
  const [entry] = taskHistoryRows(db, root.id).map((row) => row.entry).filter((entry) => "children" in entry);
  expect(entry).toEqual({ decision: expect.stringContaining(POSE.rubric), children: [expect.objectContaining({ id: child.id, title: POSE.title, handoff_doc: child.handoff_doc })] });
  expect(Object.keys((entry as { children: object[] }).children[0]!).sort()).toEqual(["completion_criteria", "handoff_doc", "id", "purpose", "status", "title"]);
});

it("出題は判断ログの1件(型つきの欄つき)を入れ、監査の受理が対象ごとの受験者を一覧の順に入れ、root は blocked のまま —— 受験者は親も分解判断も持たず対象の行で root に結ばれ、全部同じ題・目的・完了基準、assignee 未指定、root の workspace、出題した root の agent 名義。root の子は監査だけ(ADR 0253 決定1・3 / ADR 0267 決定1・5 / ADR 0273 決定3)", () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { ...ROOT, workspace: "reef", interview_targets: [opusHigh, haikuNull, sonnetHigh] }, new Date(0), ...HUMAN_WEBUI);
  const children = poseAccepted(db, root, POSE, "suzumedai", new Date(0), "worker", POSED_HEAD);
  const decisions = listEvents(db, root.id).filter((event) => event.kind === "decision_logged");
  expect(decisions).toHaveLength(1);
  const [decision] = decisions;
  expect(decision!.payload).toMatchObject({ interview_probe: POSE });
  for (const text of Object.values(POSE)) expect((decision!.payload as { line: string }).line).toContain(text);
  expect(listExaminees(db, root.id).map((child) => child.id)).toEqual(children.map((child) => child.id));
  expect(children.map((child) => [pinOf(db, child.id)?.model, pinOf(db, child.id)?.effort, child.tier])).toEqual([
    ["claude-opus-5-5", "high", "standard"],
    ["claude-haiku-4-5", null, "standard"],
    ["claude-sonnet-5-5", "high", "standard"],
  ]);
  for (const child of children) {
    expect(child).toMatchObject({ type: "work", title: POSE.title, purpose: POSE.probe, completion_criteria: POSE.completion_criteria, assignee: null, workspace: "reef", parent_id: null, based_on_decision: null });
    expect(listEvents(db, child.id).find((event) => event.kind === "task_registered")!.worker_id).toBe("suzumedai");
  }
  expect(listChildren(db, root.id).map(({ type, title }) => [type, title])).toEqual([["review", `audit: ${POSE.title}`]]);
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("blocked");
});

it("2度目の出題・Interview でない task・受験者への出題は拒まれ、何も登録されない(ADR 0253 決定1 / ADR 0245 決定3)", () => {
  const { db, root } = registerInterview();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  const plain = registerTask(db, { ...PLAIN, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  const before = listBoard(db).length;
  expect(() => poseProbe(db, getTask(db, root.id)!, POSE, "auditor", new Date(0), "worker", POSED_HEAD)).toThrow(/already posed/);
  expect(() => poseProbe(db, plain, POSE, "tako", new Date(0), "worker", POSED_HEAD)).toThrow(/only an Interview root poses a probe/);
  expect(() => poseProbe(db, child!, POSE, "tako", new Date(0), "worker", POSED_HEAD)).toThrow(/only an Interview root poses a probe/);
  expect(listBoard(db)).toHaveLength(before);
  expect(listEvents(db, root.id).filter((event) => event.kind === "decision_logged")).toHaveLength(1);
});

/** 出題した root の agent と、監査を完了する Auditor —— 登録者がどちらの名義かを分けて言えるように別の名前。 */
const POSER = "suzumedai";
const AUDITOR = "fugu";
const audited = (db: Db, audit: Task, verdict: "accepted" | "rejected", findings = "the probe asks for the measured tier's work") =>
  completeAudit(db, getTask(db, audit.id)!, { verdict, findings }, AUDITOR, new Date(1), "worker");

it("出題は監査 review を root の付帯子として盤面名義で立て(assignee は空、workspace は root の実環境)、root は監査待ちの blocked で拾われない。監査の verb は review の読み系と complete_audit で、complete_task・分解・記憶の書き込み・list_agents は無い。受理で root は受験者待ちになる(ADR 0273 決定3・4)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh], { workspace: "reef" });

  const audit = poseProbe(db, root, POSE, POSER, new Date(0), "worker", POSED_HEAD);

  expect(audit).toMatchObject({ type: "review", parent_id: root.id, assignee: null, status: "todo", based_on_decision: null });
  expect(presentTask(db, getTask(db, audit.id)!).workspace).toBe("reef");
  expect(getRegistrant(db, audit.id)).toBe(BOARD_WORKER_ID);
  expect(presentTask(db, getTask(db, root.id)!)).toMatchObject({ status: "blocked", interview_waiting: "audit" });
  expect(nextSlotTask(db)?.id).toBe(audit.id);
  expect(taskVerbSwap(db, audit.id)).toEqual({
    withheld: ["complete_task", "decompose", "redecompose", "continue_decomposition", "declare_premise_breach", "record_knowledge", "define_memory_branch", "propose_from_material", "list_agents"],
    added: ["complete_audit"],
  });
  audited(db, audit, "accepted");
  expect(presentTask(db, getTask(db, root.id)!)).toMatchObject({ status: "blocked", interview_waiting: "examinees" });
});

it("前の出題の監査が未決着のあいだの出題は拒まれる。監査の却下は findings を root の history の監査の行に載せて root を起こし、root は出題し直せて次の監査が立つ —— 受験者は立たない(ADR 0273 決定3)", () => {
  const { db, root } = registerInterview();
  const first = poseProbe(db, root, POSE, POSER, new Date(0), "worker", POSED_HEAD);
  expect(() => poseProbe(db, getTask(db, root.id)!, POSE, POSER, new Date(0), "worker", POSED_HEAD)).toThrow(/still under audit/);

  audited(db, first, "rejected", "the tier below solves it");

  expect(taskHistoryRows(db, root.id).map((row) => row.entry)).toContainEqual({
    child_outside_the_decomposition: expect.objectContaining({ status: "done", audit: { verdict: "rejected", findings: "the tier below solves it" } }),
  });
  expect(nextSlotTask(db)?.id).toBe(root.id);
  const second = poseProbe(db, getTask(db, root.id)!, POSE, POSER, new Date(2), "worker", POSED_HEAD);
  expect(second.id).not.toBe(first.id);
  expect(listEvents(db, root.id).filter((event) => event.kind === "decision_logged")).toHaveLength(2);
  expect(listExaminees(db, root.id)).toEqual([]);
});

it("監査の完了は監査でない task(root の下の RCA・root)と空の findings を拒み、何も記録しない(ADR 0273 決定3)", () => {
  const { db, root } = registerInterview();
  const audit = poseProbe(db, root, POSE, POSER, new Date(0), "worker", POSED_HEAD);
  markPickedUp(db, root.id, new Date(0));
  logDecision(db, getTask(db, root.id)!, "the probe is sound", "suzumedai", new Date(0), "worker");
  const review = rcaOf(db, root.id, new Date(0));

  for (const task of [review, getTask(db, root.id)!]) expect(() => audited(db, task, "accepted")).toThrow("only an Interview's audit completes with complete_audit");
  expect(() => audited(db, audit, "accepted", "  ")).toThrow(DomainError);

  expect(getTask(db, audit.id)!.status).toBe("todo");
  expect(listEvents(db, audit.id).map((event) => event.kind)).not.toContain("interview_audited");
  expect(listExaminees(db, root.id)).toEqual([]);
});

it.each(["直接 cancel", "retry"] as const)("監査が未決着の root の%sは監査 review を倒す(ADR 0273 決定3 / ADR 0271 決定3)", (path) => {
  const { db, root } = registerInterview();
  const audit = poseProbe(db, root, POSE, POSER, new Date(0), "worker", POSED_HEAD);

  if (path === "直接 cancel") cancelTaskDirectly(db, getTask(db, root.id)!, null, new Date(1), {}, "webui");
  else retryRoot(db, root);

  expect(getTask(db, audit.id)!.status).toBe("cancelled");
});

it("監査の判断行への異議を commit すると監査の下に RCA(self / auditor)だけが立ち、修理子は立たない —— 監査の成果は残らない(ADR 0273 決定3)", () => {
  const { db, root } = registerInterview();
  const audit = poseProbe(db, root, POSE, POSER, new Date(0), "worker", POSED_HEAD);
  audited(db, audit, "accepted");
  const entry = taskDecisionLog(db, audit.id).at(-1)!.id;
  startTriage(db, new Date(2));
  raiseObjection(db, entry, "the tier below solves it", new Date(2));

  commitTriage(db, new Date(2), [], new Map([[entry, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));

  expect(listChildren(db, audit.id).map((child) => [child.type, child.title])).toEqual([
    ["review", `rca (self): audit: ${POSE.title}`],
    ["review", `rca (auditor): audit: ${POSE.title}`],
  ]);
});

it("Interview の root は agent の decompose でも人間の扉でも分けられない —— 出題の前も後も拒まれ、何も登録されない(ADR 0253 決定5 / ADR 0111 決定6)", () => {
  const { db, root } = registerInterview();
  const split = { reason: "r", children: [CHILD] };
  // 出題済みの root への拒否文が指す先は下のテストが言う
  const refuse = (agentRefusal: RegExp) => {
    const current = getTask(db, root.id)!;
    expect(() => decomposeTaskViaWorker(db, current, split, "auditor", new Date(0))).toThrow(agentRefusal);
    expect(() => humanDecomposeTaskViaWebui(db, current, split, new Date(0))).toThrow("a human does not split an Interview root — the root's agent poses the probe");
  };
  refuse(/pose_probe/);
  expect(listChildren(db, root.id)).toEqual([]);
  const children = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  refuse(/an Interview root is not decomposed/);
  expect(listExaminees(db, root.id).map(({ id }) => id)).toEqual(children.map(({ id }) => id));
});

it("出題済みの root に届く拒否(decompose・complete_task・2度目の出題)は complete_interview か report_broken_probe を指し、escalate を指さない(ADR 0251 決定5 / ADR 0253 決定5)", () => {
  const { db, root } = scoringRoot();
  const refusals = [
    () => decomposeTaskViaWorker(db, root, { reason: "r", children: [CHILD] }, "auditor", new Date(1)),
    () => completeTask(db, root, FINDINGS, "auditor", new Date(1), "worker"),
    () => poseProbe(db, root, POSE, "auditor", new Date(1), "worker", POSED_HEAD),
  ];
  for (const refused of refusals) {
    expect(refused).toThrow(DomainError);
    expect(refused).toThrow(/report_broken_probe/);
    expect(refused).not.toThrow(/escalate|pose_probe/);
  }
});

/** 受験者の判断行・記憶の書き込み・完了の3件、root の出題の行、本番の work の判断行。 */
function examineeLogBoard() {
  const { db, root } = registerInterview();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  const examineeEntries = [
    appendEvent(db, { taskId: child.id, workerId: "tako", origin: "worker", at: new Date(0), payload: { kind: "decision_logged", line: "use a hand-written lexer" } }),
    appendEvent(db, { taskId: child.id, workerId: "tako", origin: "worker", at: new Date(0), payload: { kind: "memory_written", line: "wrote knowledge #1", created: [1], invalidated: [] } }),
  ];
  completeTask(db, child, FULL_HANDOFF, "tako", new Date(0), "worker");
  examineeEntries.push(taskDecisionLog(db, child.id).at(-1)!.id);
  const [rootEntry] = taskDecisionLog(db, root.id);
  const production = registerTask(db, { ...PLAIN, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  const productionEntry = appendEvent(db, { taskId: production.id, workerId: "tako", origin: "worker", at: new Date(0), payload: { kind: "decision_logged", line: "split the parser" } });
  return { db, root, child, examineeEntries, rootEntry: rootEntry!.id, productionEntry };
}

it("受験者の判断行・完了・記憶の書き込みへの異議は拒まれ何も残らない —— 本番の work と Interview の root のエントリは今どおり異議を受ける(ADR 0268 決定1)", () => {
  const { db, examineeEntries, rootEntry, productionEntry } = examineeLogBoard();
  for (const id of examineeEntries) expect(() => raiseObjection(db, id, "redo it", new Date(1))).toThrow(DomainError);
  expect(entryObjections(db)).toEqual([]);
  raiseObjection(db, rootEntry, "the rubric is too loose", new Date(1));
  raiseObjection(db, productionEntry, "redo it", new Date(1));
  expect(entryObjections(db).map((o) => o.entry_id)).toEqual([rootEntry, productionEntry]);
});

it("流し読みの一覧に受験者の行は無く、root と監査の行は Interview のグループ(鍵は root の id、見出しは probe の題と実環境)を運ぶ —— 受験者の task の判断ログには今どおり出る(ADR 0268 決定1 / ADR 0273 決定10)", () => {
  const { db, root, child, examineeEntries, rootEntry, productionEntry } = examineeLogBoard();
  const [audit] = listChildren(db, root.id);
  const group = { root_id: root.id, title: POSE.title, workspace: "reef" };
  expect(listLog(db, "reef").map((entry) => [entry.task_id, entry.id, entry.interview])).toEqual([
    [root.id, rootEntry, group],
    [audit!.id, taskDecisionLog(db, audit!.id).at(-1)!.id, group],
    [expect.any(String), productionEntry, null],
  ]);
  expect(taskDecisionLog(db, child.id).map((entry) => entry.id)).toEqual(examineeEntries);
});

it("朝の digest の新着ログ数は受験者の行を数えない(ADR 0268 決定1)", () => {
  const { db } = examineeLogBoard();
  // root の出題・監査の完了・本番の work の3行
  expect(buildMorningDigest(db).logCount).toBe(3);
});

it("受験者を親にした work と review の登録は扉を問わず拒まれ、question は通る —— root を親にした review も帰り先が無いので拒まれる(ADR 0268 決定5 / ADR 0301 決定2)", () => {
  const { db, root } = registerInterview();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  const doors = [HUMAN_WEBUI, ["tako", "worker"], [BOARD_WORKER_ID, "board"]] as const;
  for (const type of ["work", "review"] as const) {
    // 受験者の床(question だけ)が先に当たり、その理由を言う
    for (const [workerId, origin] of doors) expect(() => registerTask(db, { type, ...CHILD, parent_id: child.id }, new Date(0), workerId, origin)).toThrow("an Interview's answer task takes no children other than a question");
  }
  expect(listChildren(db, child.id)).toEqual([]);
  expect(failureQuestion(db, child.id, new Date(0)).parent_id).toBe(child.id);
  // 述語の上でも受験者は帰り先が無い(ADR 0301 決定1)
  expect(whyNoReturnDestination(db, child.id)).toMatch(/root is an Interview's answer task/);
  markPickedUp(db, root.id, new Date(0));
  expect(() => registerTask(db, { type: "review", ...CHILD, parent_id: root.id }, new Date(0), ...HUMAN_WEBUI)).toThrow(/root is an Interview/);
});

/** その task の最後の行への異議を commit して立つ auditor の RCA。 */
function rcaOf(db: Db, taskId: string, at = new Date(1)): Task {
  const entry = taskDecisionLog(db, taskId).at(-1)!.id;
  startTriage(db, at);
  raiseObjection(db, entry, "the call is wrong", at);
  commitTriage(db, at, [], new Map());
  return listChildren(db, taskId).find((child) => child.title.startsWith("rca (auditor)"))!;
}

/** Interview の木の task —— root・出題の監査・root の下の RCA・監査の下の RCA。どれも帰り先の無い系譜(ADR 0301 決定1)。 */
function interviewTree() {
  const { db, root } = registerInterview();
  poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  const audit = listChildren(db, root.id).find((child) => child.title.startsWith("audit:"))!;
  return { db, root: getTask(db, root.id)!, audit: getTask(db, audit.id)!, rootRca: rcaOf(db, root.id), auditRca: rcaOf(db, audit.id) };
}

const APPROVAL_QUESTION = {
  type: "question" as const,
  ...CHILD,
  question: [{ title: "authorize child registration: probe", options: ["approve", "reject"], recommendation: "approve" }],
  question_kind: { kind: "approval" as const, pending_child: CHILD },
};

it("Interview の木の task を親にした work・review・承認 question の登録は扉を問わず拒まれ、拒否文は系譜のルートが Interview だと名指す —— RCA・記憶 / routing の修理子・failure と escalate の question は通る(ADR 0301 決定1・2)", async () => {
  const { db, root, audit, rootRca, auditRca } = interviewTree();
  const doors = [HUMAN_WEBUI, ["auditor", "worker"], [BOARD_WORKER_ID, "board"]] as const;
  for (const parent of [root, audit, rootRca, auditRca]) {
    const before = listChildren(db, parent.id).length;
    for (const input of [{ type: "work" as const, ...CHILD }, { type: "review" as const, ...CHILD }, APPROVAL_QUESTION]) {
      for (const [workerId, origin] of doors) {
        expect(() => registerTask(db, { ...input, parent_id: parent.id }, new Date(2), workerId, origin)).toThrow(/^no (work|review|question) task grows here: this lineage's root is an Interview/);
      }
    }
    const humanDoor = await registerThroughHumanDoor({ db, pollNow: () => {} }, { type: "review", ...CHILD, parent_id: parent.id }, () => new Date(2), "webui");
    expect(humanDoor).toMatchObject({ ok: false, failure: { error: expect.stringMatching(/root is an Interview/) } });
    expect(listChildren(db, parent.id)).toHaveLength(before);
    for (const type of ["memory_repair", "routing_repair"] as const) {
      expect(registerTask(db, { type, ...CHILD, parent_id: parent.id }, new Date(2), ...HUMAN_WEBUI).parent_id).toBe(parent.id);
    }
    expect(failureQuestion(db, parent.id, new Date(2)).parent_id).toBe(parent.id);
    const question = [{ title: "which tier?", options: ["a", "b"], recommendation: "a" }];
    expect(escalateTask(db, getTask(db, parent.id)!, { context: "c", questions: question }, "auditor", new Date(2), "worker").parent_id).toBe(parent.id);
  }
  // RCA の下の RCA も立つ
  logDecision(db, rootRca, "the cause is the rubric", "fugu", new Date(3), "worker");
  expect(rcaOf(db, rootRca.id, new Date(3)).parent_id).toBe(rootRca.id);
});

it.each(["root の下の RCA", "監査の下の RCA", "retry で cancelled になった root の下に残る RCA"] as const)("%sの行への異議は帰責と RCA を立て、work の修理子を立てない(#2505 測定 A・B・C / ADR 0301 決定3)", (where) => {
  const { db, root, rootRca, auditRca } = interviewTree();
  if (where === "retry で cancelled になった root の下に残る RCA") {
    retryRoot(db, root);
    expect([getTask(db, root.id)!.status, getTask(db, rootRca.id)!.status]).toEqual(["cancelled", "todo"]);
  }
  const rca = where === "監査の下の RCA" ? auditRca : rootRca;
  const entry = logDecision(db, rca, "the cause is the rubric", "fugu", new Date(2), "worker");
  startTriage(db, new Date(2));
  raiseObjection(db, entry, "the cause is the tier", new Date(2));

  commitTriage(db, new Date(2), [], new Map([[entry, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));

  expect(listChildren(db, rca.id).map((child) => [child.type, child.title])).toEqual([
    ["review", `rca (self): ${rca.title}`],
    ["review", `rca (auditor): ${rca.title}`],
  ]);
  expect(listEvents(db, rca.id).flatMap(({ payload }) => (payload.kind === "objection_attributed" ? [payload.entry_id] : []))).toEqual([entry]);
});

it("root の retry は、監査の下の RCA と RCA が立てた escalate の question を残し、受験者を倒す —— 直接 cancel・abandon と同じ範囲(ADR 0301 決定4)", () => {
  const { db, root, rootRca, auditRca } = interviewTree();
  const [examinee] = listExaminees(db, root.id);
  const question = [{ title: "which tier?", options: ["a", "b"], recommendation: "a" }];
  const escalations = [rootRca, auditRca].map((rca) => escalateTask(db, rca, { context: "c", questions: question }, "fugu", new Date(2), "worker"));

  retryRoot(db, root);

  expect(getTask(db, examinee!.id)!.status).toBe("cancelled");
  expect([auditRca, ...escalations].map((task) => getTask(db, task.id)!.status)).toEqual(Array(3).fill("todo"));
});

it("Interview の root の下の RCA は worker の decompose でも人間の decompose でも分けられず、何も登録されない —— 分解の verb も見えない(#2505 測定 D / ADR 0301 決定3)", () => {
  const { db, rootRca, auditRca } = interviewTree();
  for (const rca of [rootRca, auditRca]) expect(taskVerbSwap(db, rca.id)).toEqual({ withheld: ["decompose", "redecompose", "complete_task"], added: ["complete_rca"] });
  const split = { reason: "fix the rubric", children: [CHILD] };
  expect(() => decomposeTaskViaWorker(db, rootRca, split, "fugu", new Date(2))).toThrow(/root is an Interview/);
  expect(() => humanDecomposeTaskViaWebui(db, rootRca, split, new Date(2))).toThrow(/root is an Interview/);
  expect(listChildren(db, rootRca.id)).toEqual([]);
});

// 記憶の修理子(ADR 0272)。立てるのは異議の束ね(#2175)で、ここでは束ねと同じ人間の名義の registerTask で立てる
const MEMORY_REPAIR = { type: "memory_repair" as const, title: "memory repair: interview", purpose: "repair the objected memory write", completion_criteria: "every objection direction above is addressed" };

it.each(["memory_repair", "routing_repair"] as const)("%s は Interview の root の子として登録でき、受験者の子としては扉を問わず拒まれる(ADR 0272 決定6 / ADR 0268 決定5 / ADR 0279 決定4)", (type) => {
  const { db, root } = registerInterview();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  for (const [workerId, origin] of [HUMAN_WEBUI, ["tako", "worker"], [BOARD_WORKER_ID, "board"]] as const) {
    expect(() => registerTask(db, { ...MEMORY_REPAIR, type, parent_id: child.id }, new Date(0), workerId, origin)).toThrow(DomainError);
  }
  expect(listChildren(db, child.id)).toEqual([]);
  expect(registerTask(db, { ...MEMORY_REPAIR, type, parent_id: root.id }, new Date(0), ...HUMAN_WEBUI)).toMatchObject({ type, parent_id: root.id });
});

it.each(["memory_repair", "routing_repair"] as const)("root の下の %s は root の retry で倒れず todo のまま pickup 候補に残る —— 旧い root と受験者は cancelled(ADR 0272 決定1・6 / ADR 0279 決定4)", (type) => {
  const { db, root } = registerInterview();
  const [examinee] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  const memoryRepair = registerTask(db, { ...MEMORY_REPAIR, type, parent_id: root.id }, new Date(0), ...HUMAN_WEBUI);

  const again = retryRoot(db, root, "the probe names the answer");

  expect([root, examinee, memoryRepair].map((task) => getTask(db, task.id)!.status)).toEqual(["cancelled", "cancelled", "todo"]);
  const picked: string[] = [];
  for (let next = nextSlotTask(db); next; next = nextSlotTask(db)) picked.push(pickupTask(db, next, "tako", new Date(2))!.id);
  expect(picked.sort()).toEqual([again.id, memoryRepair.id].sort());
});

it("開いた memory_repair を持つ root は、最後の受験者を失敗 question の abandon で cancel しても cancel されない —— root 自身の未決着の子に数える(ADR 0272 / ADR 0268 帰結)", () => {
  const { db, root } = registerInterview();
  const [child] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD);
  registerTask(db, { ...MEMORY_REPAIR, parent_id: root.id }, new Date(0), ...HUMAN_WEBUI);

  answerQuestionViaWebui(db, failureQuestion(db, child!.id, new Date(0)), ["abandon"], new Date(0));

  expect(getTask(db, child!.id)!.status).toBe("cancelled");
  expect(getTask(db, root.id)!.status).not.toBe("cancelled");
});

it.each(["出題", "採点"] as const)("root の%sの行への異議を commit すると root の下に RCA(self / auditor)だけが立ち、修理子は立たない —— 帰責 event は今どおり(ADR 0268 決定3)", (line) => {
  const { db, root, children } = scoringRoot();
  if (line === "採点") {
    const scores = children.map((child) => ({ child_id: child.id, outcome: "accepted" as const }));
    completeInterview(db, root, { scores, handoff: FINDINGS }, "auditor", new Date(1), "worker");
  }
  const entry = (line === "出題" ? taskDecisionLog(db, root.id)[0] : taskDecisionLog(db, root.id).at(-1))!.id;
  startTriage(db, new Date(2));
  raiseObjection(db, entry, "the rubric is too loose", new Date(2));

  commitTriage(db, new Date(2), [], new Map([[entry, { cause: "capability", evidence: "e", wrong_memory_entries: null }]]));

  expect(listChildren(db, root.id).map((child) => [child.type, child.title])).toEqual([
    ["review", `audit: ${POSE.title}`],
    ["review", "rca (self): interview"],
    ["review", "rca (auditor): interview"],
  ]);
  expect(listEvents(db, root.id).flatMap(({ payload }) => (payload.kind === "objection_attributed" ? [payload] : []))).toEqual([
    expect.objectContaining({ entry_id: entry, cause: "capability", round: "initial" }),
  ]);
});

it("出題の行への異議から立った RCA は root の retry で倒れず、todo のまま pickup 候補に残る —— 旧い root と受験者は cancelled(ADR 0268 決定4 / ADR 0271 決定3)", () => {
  const { db, root } = registerInterview();
  const [examinee] = poseAccepted(db, root, POSE, "auditor", new Date(0), "worker", POSED_HEAD) as [Task];
  const [posed] = taskDecisionLog(db, root.id);
  startTriage(db, new Date(1));
  raiseObjection(db, posed!.id, "the probe names the answer", new Date(1));
  commitTriage(db, new Date(1), [], new Map());
  const rcas = listChildren(db, root.id).filter((child) => child.title.startsWith("rca"));
  expect(rcas.map((rca) => rca.title)).toEqual(["rca (self): interview", "rca (auditor): interview"]);

  const again = retryRoot(db, root, "the probe names the answer");

  expect([root, examinee].map((task) => getTask(db, task.id)!.status)).toEqual(["cancelled", "cancelled"]);
  expect(rcas.map((rca) => getTask(db, rca.id)!.status)).toEqual(["todo", "todo"]);
  const picked: string[] = [];
  for (let next = nextSlotTask(db); next; next = nextSlotTask(db)) picked.push(pickupTask(db, next, "tako", new Date(2))!.id);
  expect(picked.sort()).toEqual([again.id, ...rcas.map((rca) => rca.id)].sort());
});
