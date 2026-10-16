import { expect, it } from "vitest";
import type { AdvisorCeiling } from "../src/claude-model-alias.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor, firstSelectable } from "../src/execution-setting.js";
import { countTasksAwaitingLanding, countTasksAwaitingLandingInWorkspace } from "../src/landing.js";
import { loadEpisodes, observedInTier, selectorBranch } from "../src/learner.js";
import type { Provider } from "../src/provider.js";
import { abandonConsequence, cancelTaskDirectly, completeInterview, completeTask, countUnsettledTasksReferencing, declarePremiseBreach, escalateTask, examineeParent, getRegistrant, getTask, interviewTargets, listBoard, listChildren, logDecision, nextSlotTask, poseProbe, presentTask, redecompose, registerTask, reportBrokenProbe, type Task, taskHistoryRows, taskVerbSwap } from "../src/tasks.js";
import { tierIdOf, tierNames } from "../src/tier.js";
import { listLog } from "../src/triage.js";
import { registerFailureQuestion } from "../src/watchdog.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID } from "../src/worker-id.js";
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
const POSE = { title: "add a parser", probe: "write a parser for the config format", completion_criteria: "the parser handles every sample", rubric: "tests pass, no new dependency" };
it("pin の子は分解できない —— agent の decompose も人間の扉も拒み、承認 question も含めて何も登録されない(ADR 0245 決定1)", () => {
  const { db, root } = registerInterview();
  const [child] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  const before = listBoard(db).length;
  const split = { reason: "too large for one session", children: [{ ...CHILD, assignee: "deckhand" }] };
  expect(() => decomposeTaskViaWorker(db, child!, split, "tako", new Date(0), { authority: { assignable_to: [] } })).toThrow(/this task is not split/);
  expect(() => humanDecomposeTaskViaWebui(db, child!, split, new Date(0))).toThrow(/this task is not split/);
  expect(listBoard(db)).toHaveLength(before);
});

it("task ごとの verb の差し替え —— Interview の root は分解の verb と complete_task を伏せ、出題前は出題の verb を、出題済みは採点完了の verb と、報告したことが無ければ報告の verb を足す。pin の子は分解の verb だけを伏せる(ADR 0253 決定4・5 / ADR 0245 決定1 / ADR 0251 決定1)", () => {
  const { db, root } = registerInterview();
  expect(taskVerbSwap(db, root.id)).toEqual({ withheld: ["decompose", "redecompose", "complete_task"], added: ["pose_probe"] });
  const [child] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  expect(taskVerbSwap(db, root.id)).toEqual({ withheld: ["decompose", "redecompose", "complete_task"], added: ["complete_interview", "report_broken_probe"] });
  expect(taskVerbSwap(db, child!.id)).toEqual({ withheld: ["decompose", "redecompose"], added: [] });
  // 報告したあとの root は報告の verb を失う(ADR 0251 決定2)
  completeTask(db, child!, FULL_HANDOFF, "tako", new Date(0), "worker");
  report(db, root);
  expect(taskVerbSwap(db, root.id)).toEqual({ withheld: ["decompose", "redecompose", "complete_task"], added: ["complete_interview"] });
});

it("Interview の root は作り直せない —— 子の前提の破綻を受けた root の redecompose は拒まれ、子は cancel されず何も登録されない(ADR 0245 決定3)", () => {
  const { db, root } = registerInterview();
  const [child] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  declarePremiseBreach(db, child!, "the probe is broken", "tako", new Date(0), "worker");
  const replan = { reason: "a fixed probe", children: [CHILD] };
  expect(() => redecompose(db, getTask(db, root.id)!, replan, "auditor", new Date(0), undefined, undefined, "worker")).toThrow(
    "an Interview is not redecomposed: a broken probe is the human's premise-breach question to settle (continue, abandon or retry)",
  );
  expect(listChildren(db, root.id).map(({ id, status }) => ({ id, status }))).toEqual([{ id: child!.id, status: "todo" }]);
});

/** root の task_cancelled が出自に名指す question の id。 */
const cancelledBy = (db: Db, taskId: string) =>
  listEvents(db, taskId).flatMap(({ payload }) => (payload.kind === "task_cancelled" && "origin_question_id" in payload ? [payload.origin_question_id] : []));

it("pin の子を失敗 question の abandon で全部 cancel すると、root は起きずにその question を出自に cancel される(ADR 0247 決定1)", () => {
  const { db, root } = registerInterview();
  const [child] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  const question = failureQuestion(db, child!.id, new Date(0));
  answerQuestionViaWebui(db, question, ["abandon"], new Date(0));
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  expect(cancelledBy(db, root.id)).toEqual([question.id]);
  expect(nextSlotTask(db)).toBeUndefined();
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
  expect(taskVerbSwap(db, plain.id)).toEqual({ withheld: [], added: [] });
});

/** 対象2つの Interview の root が出題し、対象ごとの pin の子2つが立つ。 */
function twoPinnedChildren() {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const [failed, sibling] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  return { db, root, failed: failed!, sibling: sibling! };
}

/** 前提の破綻の question: pin の子の宣言は初回から人間の question になる(ADR 0248 決定1)。 */
function breachQuestion(db: Db, failed: Task) {
  return declarePremiseBreach(db, failed, "the probe is broken", "tako", new Date(0), "worker")!;
}

it("pin の子の初回の宣言は、出題の書き手が agent でも Tidepool 名義の question(continue / abandon / retry)になり、root も宣言者も pickup されない(ADR 0248 決定1・2)", () => {
  const { db, failed } = twoPinnedChildren();
  const question = breachQuestion(db, failed);
  expect(question.parent_id).toBe(failed.id);
  expect(question.question_items).toEqual([expect.objectContaining({ options: ["continue", "abandon", "retry"], recommendation: "continue" })]);
  expect(nextSlotTask(db)).toBeUndefined();
});

it("pin の子の前提の破綻の question への continue は宣言者を再開させ、兄弟の held を解く —— root は blocked のまま(ADR 0248 決定2)", () => {
  const { db, root, failed, sibling } = twoPinnedChildren();
  answerQuestionViaWebui(db, breachQuestion(db, failed), ["continue"], new Date(0));
  expect(nextSlotTask(db)?.id).toBe(failed.id);
  expect(presentTask(db, getTask(db, sibling.id)!).status).toBe("todo");
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("blocked");
});

it("pin の子の前提の破綻の question の、人間が答える context は、理由に加えて盤面が確定した probe と rubric、retry の帰結を言う(ADR 0248 決定2・4)", () => {
  const { db, failed } = twoPinnedChildren();
  const question = breachQuestion(db, failed);
  for (const text of ["the probe is broken", POSE.probe, POSE.rubric, `"retry"`]) expect(getTask(db, question.id)!.purpose).toContain(text);
});

it("continue の後、宣言した pin の子が読む自分の history の破綻の question は人間の答えを運び、context(rubric・Interview の帰結)も continue のコメントも運ばない —— コメントは question の記録に残る(ADR 0253 決定2 / ADR 0245 決定2 / ADR 0263 決定8)", () => {
  const { db, failed } = twoPinnedChildren();
  const question = breachQuestion(db, failed);
  answerQuestionViaWebui(db, question, ["continue"], new Date(0), { comment: "the probe holds" });
  const history = taskHistoryRows(db, failed.id).map((row) => row.entry);
  expect(history).toEqual([
    { child_outside_the_decomposition: expect.objectContaining({ title: `premise breach: ${POSE.title}`, answer: ["continue"], comment: null }) },
  ]);
  expect(JSON.stringify(history)).not.toContain(POSE.rubric);
  expect(JSON.stringify(history)).not.toMatch(/interview/i);
  expect(getTask(db, question.id)!.question_answer_comment).toBe("the probe holds");
});

it("pin の子の前提の破綻の question の context は、continue のコメントが受験者に届かず、probe を直すなら retry だと人間に言う(ADR 0263 決定8)", () => {
  const { db, failed } = twoPinnedChildren();
  expect(getTask(db, breachQuestion(db, failed).id)!.purpose).toMatch(/comment given with "continue" reaches no target .*"retry"/);
});

const ONLY_THIS_TARGET = /answer and comment reach only this target/;

it("pin の子の failure question の context は答えとコメントがこの対象にだけ届くと人間に言い、自分の history はその文を外して答えとコメントを運ぶ(ADR 0263 決定9)", () => {
  const { db, failed } = twoPinnedChildren();
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

it("pin の子が escalate した question の context は、agent の書いた context の後ろに盤面が「この対象にだけ届く」を足し、自分の history は agent の context と答え・コメントを運ぶ(ADR 0263 決定9)", () => {
  const { db, failed } = twoPinnedChildren();
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

it("pin の子の failure question は兄弟の pin の子を held にしない —— 兄弟はそのまま pickup できる(ADR 0245 決定5)", () => {
  const { db, failed, sibling } = twoPinnedChildren();
  failureQuestion(db, failed.id, new Date(0));
  expect(presentTask(db, getTask(db, sibling.id)!).status).toBe("todo");
  expect(nextSlotTask(db)?.id).toBe(sibling.id);
});

it("retry 後の pin の子の failure question の history は失敗の理由と再実行の帰結を残し、Interview の帰結だけを伏せる —— 人間の context は残る(ADR 0245 決定2 / ADR 0247 決定1)", () => {
  const { db, failed } = twoPinnedChildren();
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

it("pin の子の失敗理由に引用された Interview の帰結は逐語で残し、末尾の生成文だけを history から外す", () => {
  const { db, failed } = twoPinnedChildren();
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

it("pin の子の前提の破綻の abandon の文は、親を先頭へ戻すと言わず、Interview ごと終わり、測り直すのは retry だと言う(ADR 0247 決定2 / ADR 0248 決定2)", () => {
  const { db, failed } = twoPinnedChildren();
  const consequence = abandonConsequence(db, failed, true);
  expect(consequence).toContain("1 unfinished sibling from the same decomposition decision");
  expect(consequence).toContain("ends this Interview");
  expect(consequence).toContain(`"retry" ends it the same way and registers a new Interview`);
  expect(consequence).not.toContain("a human registers the Interview again");
  expect(consequence).not.toContain("queue head");
});

it("pin の子の前提の破綻の question は、これまでどおり兄弟の pin の子を held にし、その abandon は兄弟も root も cancel する(ADR 0245 決定2 / ADR 0247 決定2)", () => {
  const { db, root, failed, sibling } = twoPinnedChildren();
  const question = breachQuestion(db, failed);
  expect(question.purpose).toContain("1 unfinished sibling from the same decomposition decision");
  expect(presentTask(db, getTask(db, sibling.id)!).status).toBe("held");
  answerQuestionViaWebui(db, question, ["abandon"], new Date(0));
  expect([failed.id, sibling.id, root.id].map((id) => getTask(db, id)!.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(cancelledBy(db, root.id)).toEqual([question.id]);
});

it("done の兄弟が居ても、pin の子の前提の破綻の abandon は root ごと cancel する —— done の答案はそのまま残り、root は起きない(ADR 0247 決定2)", () => {
  const { db, root, failed, sibling } = twoPinnedChildren();
  completeTask(db, sibling, FULL_HANDOFF, "tako", new Date(0), "worker");
  const question = breachQuestion(db, failed);
  answerQuestionViaWebui(db, question, ["abandon"], new Date(0));
  expect([failed.id, sibling.id, root.id].map((id) => getTask(db, id)!.status)).toEqual(["cancelled", "done", "cancelled"]);
  expect(nextSlotTask(db)).toBeUndefined();
});

it("pin の子の前提の破綻の question への retry は root ごと cancel し、同じ対象・目的の Interview を人間名義で登録して、その history に旧い root・probe・rubric・理由・コメントを見せる(ADR 0248 決定2・3)", () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { ...ROOT, workspace: "reef", review_tier: "standard", interview_targets: [opusHigh, haikuNull] as never }, new Date(0), ...HUMAN_WEBUI);
  const [failed, sibling] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  const question = breachQuestion(db, failed!);
  answerQuestionViaWebui(db, question, ["retry"], new Date(0), { comment: "the probe leaks the answer" });
  expect([failed!.id, sibling!.id, root.id].map((id) => getTask(db, id)!.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  expect(cancelledBy(db, root.id)).toEqual([question.id]);
  const again = getTask(db, listBoard(db).find((task) => task.parent_id === null && task.id !== root.id)!.id)!;
  const fields = ({ type, title, purpose, completion_criteria, workspace, review_tier }: Task) => ({ type, title, purpose, completion_criteria, workspace, review_tier });
  expect(fields(again)).toEqual(fields(root));
  expect(getRegistrant(db, again.id)).toBe(HUMAN_WORKER_ID);
  expect(interviewTargets(db, again.id)).toEqual([opusHigh, haikuNull]);
  expect(taskVerbSwap(db, again.id).added).toEqual(["pose_probe"]);
  expect(listEvents(db, again.id).find((event) => event.kind === "interview_retried")?.worker_id).toBe(BOARD_WORKER_ID);
  const retry = { retry_of: { previous_root_id: root.id, probe: POSE.probe, rubric: POSE.rubric, reason: "the probe is broken", comment: "the probe leaks the answer" } };
  expect(taskHistoryRows(db, again.id).map((row) => row.entry)).toEqual([retry]);
  expect(nextSlotTask(db)?.id).toBe(again.id);
  // 新しい root の受験者から見える親には、旧い root の `retry_of` を載せない(ADR 0263 決定3)
  const [child] = poseProbe(db, again, POSE, "auditor", new Date(0), "worker");
  expect(examineeParent(db, child!).rows.map((row) => row.entry)).not.toContainEqual(retry);
});

/** 採点の段階の root: 出題して対象ごとの pin の子を全部 done にした(答案は FULL_HANDOFF)。 */
function scoringRoot() {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  const children = poseProbe(db, root, POSE, "auditor", new Date(0), "worker").map((child) => completeTask(db, child, FULL_HANDOFF, "tako", new Date(0), "worker"));
  return { db, root: getTask(db, root.id)!, children };
}
const BROKEN = { reason: "the probe leaks the expected output", recommendation: "retry" as const };
const report = (db: Db, root: Task, input: { reason: string; recommendation: "abandon" | "retry" } = BROKEN) =>
  reportBrokenProbe(db, getTask(db, root.id)!, input, "auditor", new Date(1), "worker");

it("probe の破綻の報告は root の agent 名義の question(continue / abandon / retry、推奨は root の指定)を立て、context に理由・probe・rubric・done の pin の子の id を載せて答案の本文は載せず、root を blocked にする(ADR 0251 決定1〜3 / ADR 0194 決定1)", () => {
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

it("probe の破綻の報告は Interview でない task・pin の子・出題前の root・報告したことのある root で DomainError になり、何も登録しない(ADR 0251 決定1・2)", () => {
  const { db, root, children } = scoringRoot();
  const unposed = registerInterview(db).root;
  const plain = registerTask(db, { ...ROOT, type: "work" }, new Date(0), ...HUMAN_WEBUI);
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

/** 既定 agent の entry と、それを読む判定の口(ADR 0253 決定3)。entry はテストが後から書き換える。 */
function runnablePort(db: Db, ...providers: Provider[]) {
  const entry = agent(false, ...providers);
  return { entry, runnable: { candidates: (task: Parameters<typeof executionSettingsFor>[2]) => executionSettingsFor(db, entry, task) } };
}
/** 旧い root 以外の root の数 —— retry が登録した新しい Interview。 */
const otherRoots = (db: Db, root: Task) => listBoard(db).filter((task) => task.parent_id === null && task.id !== root.id).length;
const UNRUNNABLE_RETRY = /target \{"provider":"anthropic","model":"claude-opus-5-5".*cannot run as the default agent.*answer "retry" again.*answer "abandon"/;

it("登録の後に既定 agent の entry から対象の Provider が外れた盤面で、前提の破綻の question への retry は対象と abandon を名指して答えごと拒まれ、question は todo のまま、root は cancel されず、新しい Interview も登録されない —— entry を戻せば retry が通る(ADR 0253 決定3 / ADR 0248 決定2)", () => {
  const { db, root, failed } = twoPinnedChildren();
  const question = breachQuestion(db, failed);
  const { entry, runnable } = runnablePort(db, "openai");
  expect(() => answerQuestionViaWebui(db, question, ["retry"], new Date(0), { runnable })).toThrow(UNRUNNABLE_RETRY);
  expect([question.id, root.id, failed.id].map((id) => getTask(db, id)!.status)).toEqual(["todo", "todo", "todo"]);
  expect(otherRoots(db, root)).toBe(0);
  entry.provider = [{ name: "anthropic", advisor: false }];
  answerQuestionViaWebui(db, getTask(db, question.id)!, ["retry"], new Date(0), { runnable });
  expect(getTask(db, root.id)!.status).toBe("cancelled");
  expect(otherRoots(db, root)).toBe(1);
});

it("同じ盤面で、probe の破綻の報告の question への retry も答えごと拒まれ、question は todo のまま、root は cancel されず、新しい Interview も登録されない(ADR 0253 決定3 / ADR 0251 決定2)", () => {
  const { db, root } = scoringRoot();
  const question = report(db, root);
  const { runnable } = runnablePort(db, "openai");
  expect(() => answerQuestionViaWebui(db, question, ["retry"], new Date(1), { runnable })).toThrow(UNRUNNABLE_RETRY);
  expect([question.id, root.id].map((id) => getTask(db, id)!.status)).toEqual(["todo", "todo"]);
  expect(otherRoots(db, root)).toBe(0);
});

it("走れない対象を抱えたままでも、前提の破綻の question と probe の破綻の報告の question への continue と abandon は今どおり通る(ADR 0253 決定3)", () => {
  for (const answer of ["continue", "abandon"]) {
    const breach = twoPinnedChildren();
    answerQuestionViaWebui(breach.db, breachQuestion(breach.db, breach.failed), [answer], new Date(0), runnablePort(breach.db, "openai"));
    const scoring = scoringRoot();
    answerQuestionViaWebui(scoring.db, report(scoring.db, scoring.root), [answer], new Date(1), runnablePort(scoring.db, "openai"));
    expect(getTask(breach.db, breach.root.id)!.status).toBe(answer === "abandon" ? "cancelled" : "todo");
    expect(getTask(scoring.db, scoring.root.id)!.status).toBe(answer === "abandon" ? "cancelled" : "todo");
  }
});

/** root に対象を1つ持たせ、それを pin した子を返す。 */
function pinnedChild(target: Record<string, unknown>, ceiling: AdvisorCeiling = "off") {
  const { db, root } = registerInterview(undefined, [target]);
  applyExecutionSettingsChange(db, { setting: "advisor_ceiling", value: ceiling }, "webui", new Date(0));
  const [child] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
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
  const db = openDb(":memory:");
  const root = registerTask(db, { ...ROOT, workspace: "reef", interview_targets: [opusHigh] }, new Date(0), ...HUMAN_WEBUI);
  const plain = registerTask(db, { type: "work", ...CHILD, workspace: "reef" }, new Date(0), ...HUMAN_WEBUI);
  completeTask(db, plain, FULL_HANDOFF, "tako", new Date(0), "worker");
  const [child] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
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
  cancelTaskDirectly(db, root, null, new Date(0), {}, "webui");
  change({ setting: "delete_tier", name: "trial" });
  expect(tierNames(db)).not.toContain("trial");
});

/** 出題で立った対象ごとの pin の子を1つずつ走らせて完了させる(spawn は pin の値と対象の段で記録される)。 */
function ranChildren(db: Db, root: Task) {
  const targets = interviewTargets(db, root.id)!;
  return poseProbe(db, root, POSE, "auditor", new Date(0), "worker").map((child, i) => {
    const { model, effort, tier } = targets[i]!;
    const spawned = { ...WORKER_SPAWNED, advisor: null, model, effort, tier_id: tierIdOf(db, tier) };
    appendEvent(db, { taskId: child.id, workerId: "tako", origin: "board", at: new Date(0), payload: spawned });
    return completeTask(db, child, FULL_HANDOFF, "tako", new Date(0), "worker");
  });
}

it("学習器は採点完了で入った Interview の子の採点を、同じセル・同じ段の観測として本番の episode と並べて数え、種別は episode に残る(ADR 0181 決定4 / ADR 0210 決定4)", () => {
  // 同じ対象は1つの一覧に2つ置けない(ADR 0249 決定2)ので、同じセルの答案3つは Interview 3件から取る
  const db = openDb(":memory:");
  const roots = [1, 2, 3].map(() => registerInterview(db).root);
  const [accepted, rejected, unscored] = roots.map((root) => ranChildren(db, root)[0]) as [Task, Task, Task];
  for (const [root, child, outcome] of [[roots[0]!, accepted, "accepted"], [roots[1]!, rejected, "rejected"]] as const) {
    completeInterview(db, getTask(db, root.id)!, { scores: [{ child_id: child.id, outcome }], handoff: FINDINGS }, "auditor", new Date(1), "worker");
  }
  // 受験者は root の子ではない(ADR 0267 決定1)—— 学習器は対象 → root で root の決着を引く
  db.prepare("UPDATE tasks SET parent_id = NULL, based_on_decision = NULL WHERE interview_target_id IS NOT NULL").run();
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

it("root が cancelled や未決着の Interview の子の採点は、採点の無い子と同じく excluded で学習器に数えられない —— 採点は root の完了で確定する(ADR 0251 決定4)", () => {
  const db = openDb(":memory:");
  const scored = [true, false].map((cancelled) => {
    const { root } = registerInterview(db, [opusHigh, haikuNull]);
    const children = ranChildren(db, root) as [Task, Task];
    // 採点完了は採点と完了を一度に入れるので、この状態は verb では作れない —— 学習器の読みの規則だけを event で釘付けする
    for (const [child, outcome] of [[children[0], "accepted"], [children[1], "rejected"]] as const) {
      appendEvent(db, { taskId: child.id, workerId: "auditor", origin: "worker", at: new Date(1), payload: { kind: "interview_scored", outcome } });
    }
    if (cancelled) cancelTaskDirectly(db, getTask(db, root.id)!, null, new Date(1), {}, "webui");
    return children;
  });
  // 受験者は root の子ではない(ADR 0267 決定1)—— 学習器は対象 → root で root の決着を引く
  db.prepare("UPDATE tasks SET parent_id = NULL, based_on_decision = NULL WHERE interview_target_id IS NOT NULL").run();
  const episodes = loadEpisodes(db);
  expect(episodes.map(({ task_id, outcome }) => ({ task_id, outcome }))).toEqual(scored.flat().map(({ id }) => ({ task_id: id, outcome: "excluded" })));
  expect(observedInTier(episodes, tierIdOf(db, "standard"), null).board).toEqual([]);
  expect(observedInTier(episodes, tierIdOf(db, "economy"), null).board).toEqual([]);
});

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
  const [a, b, cancelled] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker") as [Task, Task, Task];
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
  const plain = registerTask(db, { ...ROOT, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  const complete = (task: Task, scores: Array<{ child_id: string; outcome: "accepted" }> = []) => () =>
    completeInterview(db, task, { scores, handoff: FINDINGS }, "auditor", new Date(1), "worker");
  expect(complete(plain)).toThrow(/only an Interview root/);
  expect(complete(getTask(db, root.id)!)).toThrow(/pose_probe/);
  const [done, open] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker") as [Task, Task];
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
  const db = openDb(":memory:");
  const root = registerTask(db, { ...ROOT, workspace: "reef", interview_targets: [opusHigh] }, new Date(0), ...HUMAN_WEBUI);
  const [child] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  completeTask(db, child!, FULL_HANDOFF, "tako", new Date(0), "worker");
  // root も reef を指すので、採点完了させてから数える
  completeInterview(db, getTask(db, root.id)!, { scores: [{ child_id: child!.id, outcome: "accepted" }], handoff: FINDINGS }, "auditor", new Date(0), "worker");
  registerTask(db, { type: "work", ...CHILD, parent_id: child!.id, workspace: "other" }, new Date(0), ...HUMAN_WEBUI);
  expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(0);
});

it("Interview の root の history で、pin の子は採点のための id を持ち、走った agent も model も持たない(伏せた handoff)", () => {
  const { db, root } = registerInterview();
  const [child] = ranChildren(db, root) as [Task];
  const [entry] = taskHistoryRows(db, root.id).map((row) => row.entry).filter((entry) => "children" in entry);
  expect(entry).toEqual({ decision: expect.stringContaining(POSE.rubric), children: [expect.objectContaining({ id: child.id, title: POSE.title, handoff_doc: child.handoff_doc })] });
  expect(Object.keys((entry as { children: object[] }).children[0]!).sort()).toEqual(["completion_criteria", "handoff_doc", "id", "purpose", "status", "title"]);
});

it("出題は判断ログの1件(型つきの欄つき)と、対象ごとの pin の子を一覧の順に1つの transaction で入れ、root を blocked にする —— 子は全部同じ題・目的・完了基準、assignee 未指定、親の workspace、その1件の上、root の agent 名義(ADR 0253 決定1・3)", () => {
  const db = openDb(":memory:");
  const root = registerTask(db, { ...ROOT, workspace: "reef", interview_targets: [opusHigh, haikuNull, sonnetHigh] }, new Date(0), ...HUMAN_WEBUI);
  const children = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  const decisions = listEvents(db, root.id).filter((event) => event.kind === "decision_logged");
  expect(decisions).toHaveLength(1);
  const [decision] = decisions;
  expect(decision!.payload).toMatchObject({ interview_probe: POSE });
  for (const text of Object.values(POSE)) expect((decision!.payload as { line: string }).line).toContain(text);
  expect(listChildren(db, root.id).map((child) => child.id)).toEqual(children.map((child) => child.id));
  expect(children.map((child) => [pinOf(db, child.id)?.model, pinOf(db, child.id)?.effort, child.tier])).toEqual([
    ["claude-opus-5-5", "high", "standard"],
    ["claude-haiku-4-5", null, "economy"],
    ["claude-sonnet-5-5", "high", "economy"],
  ]);
  for (const child of children) {
    expect(child).toMatchObject({ type: "work", title: POSE.title, purpose: POSE.probe, completion_criteria: POSE.completion_criteria, assignee: null, workspace: "reef", based_on_decision: decision!.id });
    expect(listEvents(db, child.id).find((event) => event.kind === "task_registered")!.worker_id).toBe("auditor");
  }
  expect(listChildren(db, root.id).filter((task) => task.type === "question")).toEqual([]);
  expect(presentTask(db, getTask(db, root.id)!).status).toBe("blocked");
});

it("2度目の出題・Interview でない task・pin の子への出題は拒まれ、何も登録されない(ADR 0253 決定1 / ADR 0245 決定3)", () => {
  const { db, root } = registerInterview();
  const [child] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  const plain = registerTask(db, { ...ROOT, type: "work" }, new Date(0), ...HUMAN_WEBUI);
  const before = listBoard(db).length;
  expect(() => poseProbe(db, getTask(db, root.id)!, POSE, "auditor", new Date(0), "worker")).toThrow(/already posed/);
  expect(() => poseProbe(db, plain, POSE, "tako", new Date(0), "worker")).toThrow(/only an Interview root poses a probe/);
  expect(() => poseProbe(db, child!, POSE, "tako", new Date(0), "worker")).toThrow(/only an Interview root poses a probe/);
  expect(listBoard(db)).toHaveLength(before);
  expect(listEvents(db, root.id).filter((event) => event.kind === "decision_logged")).toHaveLength(1);
});

it("受験者から見える親は出題そのもの —— 欄は出題の値で handoff は null、history は1つの子の登録だけを言う出題の行1つで、子は id の無い自分の行だけ。root 自身の history と人間の判断ログは全部を持つ(ADR 0263 決定3・4 / ADR 0253 決定2)", () => {
  const { db, root } = registerInterview(undefined, [opusHigh, haikuNull]);
  logDecision(db, root, "a note the root logged before posing", "auditor", new Date(0), "worker");
  const [child, sibling] = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  completeTask(db, sibling!, FULL_HANDOFF, "tako", new Date(0), "worker");
  registerTask(db, { type: "question", title: "a root question", purpose: "p", completion_criteria: "c", parent_id: root.id, question: [{ title: "q", options: ["a", "b"], recommendation: "a" }] }, new Date(0), BOARD_WORKER_ID, "board");
  const parent = examineeParent(db, child!);
  expect(parent.context).toEqual({ id: root.id, title: POSE.title, purpose: POSE.probe, completion_criteria: POSE.completion_criteria, handoff_doc: null });
  expect(parent.rows.map((row) => row.entry)).toEqual([
    { decision: "Registered one child to do this task.", children: [{ title: POSE.title, purpose: POSE.probe, completion_criteria: POSE.completion_criteria, status: presentTask(db, child!).status, you: true }] },
  ]);
  const decisionOf = (rows: ReturnType<typeof taskHistoryRows>) => (rows.map((row) => row.entry).find((entry) => "children" in entry && entry.children.length) as { decision: string }).decision;
  const asRoot = decisionOf(taskHistoryRows(db, root.id));
  const humanLog = listLog(db).find((entry) => entry.task_id === root.id && entry.payload.kind === "decision_logged" && "interview_probe" in entry.payload)!.payload as { line: string };
  for (const line of [asRoot, humanLog.line]) for (const text of Object.values(POSE)) expect(line).toContain(text);
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
  const children = poseProbe(db, root, POSE, "auditor", new Date(0), "worker");
  refuse(/an Interview root is not decomposed/);
  expect(listChildren(db, root.id).map(({ id }) => id)).toEqual(children.map(({ id }) => id));
});

it("出題済みの root に届く拒否(decompose・complete_task・2度目の出題)は complete_interview か report_broken_probe を指し、escalate を指さない(ADR 0251 決定5 / ADR 0253 決定5)", () => {
  const { db, root } = scoringRoot();
  const refusals = [
    () => decomposeTaskViaWorker(db, root, { reason: "r", children: [CHILD] }, "auditor", new Date(1)),
    () => completeTask(db, root, FINDINGS, "auditor", new Date(1), "worker"),
    () => poseProbe(db, root, POSE, "auditor", new Date(1), "worker"),
  ];
  for (const refused of refusals) {
    expect(refused).toThrow(DomainError);
    expect(refused).toThrow(/report_broken_probe/);
    expect(refused).not.toThrow(/escalate|pose_probe/);
  }
});
