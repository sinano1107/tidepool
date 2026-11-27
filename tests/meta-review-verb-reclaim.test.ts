import { afterEach, expect, it, vi } from "vitest";
import type { AgentView } from "../src/agent-create.js";
import { recordKnowledge } from "../src/memory.js";
import {
  api,
  bootTidepool,
  callAsTask,
  defaultingTo,
  expectReclaimed,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  injectMemoryMaterial,
  injectRoutingMaterial,
  makeWorkspace,
  routingJudgmentRepairTask,
  routingMaterialViaWebui,
  sessionId,
  startFirstMetaReviewViaWebui,
  type Tidepool,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** meta-review の完了の verb と routing の提案 verb の、worker に直せない失敗(ADR 0424 決定2、issue #3908)のサーバ境界:
 *  盤面に材料の注入の記録が無い・registry の読みが落ちる —— failure question を登録して session を回収する。入力の拒否は今のまま。
 *  domain の「material was not injected」の拒否は tests/complete-memory-review.test.ts / tests/complete-routing-review.test.ts が言う。 */
let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

/** slot に入った memory meta-review(材料の Knowledge を1件書いて poll させる)。後始末は回収済み観測の後ろに止めておく。 */
async function memoryReviewInSlot() {
  const sandbox = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: sandbox, resolveWorkspace: defaultingTo(sandbox) });
  recordKnowledge(
    t.db,
    { scope: "sandbox", path: "build", title: "Tests need Node 22", text: "Tests need Node 22.", source: { commit: "0a46a46" }, author: { activity: "worker_verb", name: "deckhand" } },
    "worker",
    t.clock.now(),
  );
  await startFirstMetaReviewViaWebui(t, "memory");
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "memory");
  const session = String(sessionId(t.db, review.id));
  t.containers.hold(review.id);
  return { review, session, workspace: sandbox.name };
}

/** 判断の行(型つきの decision_logged)も done も無い。 */
const nothingCompleted = (taskId: string) => async () => {
  expect((await api(t.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json.filter((event: { kind: string }) => event.kind === "decision_logged")).toEqual([]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${taskId}`)).json.status).not.toBe("done");
};

it("材料の注入が記録されていない memory meta-review の complete_memory_review は拒まず、その失敗の文を載せた failure question を登録して session を回収し、何も記録しない(ADR 0424 決定2)", async () => {
  const { review, session, workspace } = await memoryReviewInSlot();

  const res = await callAsTask(t, review.id, "complete_memory_review", { judgments: [] });

  await expectReclaimed(t, {
    verb: "complete_memory_review", taskId: review.id, session, res, fragment: "material was not injected into this memory meta-review's session", quarantined: workspace,
    nothingRecorded: nothingCompleted(review.id),
  });
});

/** 入力の拒否は今のまま(ADR 0424 決定1): 拒否の文が返り、回収も failure question も無く、session は続く(次の呼び出しが答える)。 */
async function expectRefusedAndContinuing(taskId: string, res: any, refusal: string) {
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain(refusal);
  expect(t.containers.forceReclaims).toEqual([]);
  expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.parent_id === taskId && task.question_cancel_option !== null)).toEqual([]);
  expect((await callAsTask(t, taskId, "get_current_task", {})).isError).toBeFalsy();
}

it("材料を注入した memory meta-review の complete_memory_review は、判断の無い項目を今どおり unjudged で拒み、session は続く", async () => {
  const { review } = await memoryReviewInSlot();
  injectMemoryMaterial(t.db, review.id, t.worker.id, t.clock.now());

  await expectRefusedAndContinuing(review.id, await callAsTask(t, review.id, "complete_memory_review", { judgments: [] }), "unjudged");
});

/** registry の agent 一覧の fake: `unreadable` を立てると読みが落ちる。 */
function fakeRegistry() {
  const state = { unreadable: false };
  const list = (): AgentView[] => {
    if (state.unreadable) throw new Error("registry clone is broken");
    return [];
  };
  return { state, agentAdmin: { list } };
}

/** slot に入った routing meta-review(実行設定の行の変更を材料に poll させる)。後始末は回収済み観測の後ろに止めておく。 */
async function routingReviewInSlot() {
  const sandbox = await makeWorkspace("sandbox");
  const registry = fakeRegistry();
  t = await bootTidepool({ workspace: sandbox, resolveWorkspace: defaultingTo(sandbox), agentAdmin: registry.agentAdmin });
  await routingMaterialViaWebui(t);
  await startFirstMetaReviewViaWebui(t, "routing");
  await t.clock.advance(HOUR);
  const review = ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).find((task) => task.meta_review_subject === "routing");
  const session = String(sessionId(t.db, review.id));
  t.containers.hold(review.id);
  return { review, session, workspace: sandbox.name, registry };
}

it("材料の注入が記録されていない routing meta-review の complete_routing_review は拒まず、その失敗の文を載せた failure question を登録して session を回収し、何も記録しない(ADR 0424 決定2)", async () => {
  const { review, session, workspace } = await routingReviewInSlot();

  const res = await callAsTask(t, review.id, "complete_routing_review", { judgments: [] });

  await expectReclaimed(t, {
    verb: "complete_routing_review", taskId: review.id, session, res, fragment: "material was not injected into this routing meta-review's session", quarantined: workspace,
    nothingRecorded: nothingCompleted(review.id),
  });
});

it("complete_routing_review の中の registry の読みが落ちると、protocol error でなく、その失敗の文を載せた failure question を登録して session を回収し、何も記録しない(ADR 0424 決定2)", async () => {
  const { review, session, workspace, registry } = await routingReviewInSlot();
  const judgments = injectRoutingMaterial(t.db, review.id, t.worker.id, t.clock.now(), []);
  registry.state.unreadable = true;

  const res = await callAsTask(t, review.id, "complete_routing_review", { judgments });

  await expectReclaimed(t, {
    verb: "complete_routing_review", taskId: review.id, session, res, fragment: "registry clone is broken", quarantined: workspace,
    nothingRecorded: nothingCompleted(review.id),
  });
});

const lowerDeckhand = { op: "agent_tier", agent: "deckhand", to: "standard", evidence: [1], rationale: "deckhand sessions were overpowered" };

it("propose_routing_change の op agent_tier で registry の読みが落ちると、protocol error でなく、その失敗の文を載せた failure question を登録して session を回収し、提案の question を立てない(ADR 0424 決定2)", async () => {
  const { review, session, workspace, registry } = await routingReviewInSlot();
  registry.state.unreadable = true;

  const res = await callAsTask(t, review.id, "propose_routing_change", lowerDeckhand);

  await expectReclaimed(t, {
    verb: "propose_routing_change", taskId: review.id, session, res, fragment: "registry clone is broken", quarantined: workspace,
    nothingRecorded: async () =>
      expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.parent_id === review.id && task.question_cancel_option === null)).toEqual([]),
  });
});

it("registry が読めなくても、registry を読む前の入力の拒否(op agent_tier に tier)と complete_routing_review の unjudged は今どおり拒否で、session は続く", async () => {
  const { review, registry } = await routingReviewInSlot();
  injectRoutingMaterial(t.db, review.id, t.worker.id, t.clock.now(), []);
  registry.state.unreadable = true;

  await expectRefusedAndContinuing(review.id, await callAsTask(t, review.id, "propose_routing_change", { ...lowerDeckhand, tier: "standard" }), "op agent_tier takes no tier or description");
  registry.state.unreadable = false;
  await expectRefusedAndContinuing(review.id, await callAsTask(t, review.id, "complete_routing_review", { judgments: [] }), "unjudged");
});

it("routing_repair の propose_routing_change(同じ verb、ADR 0279 決定4)でも、registry の読みが落ちると failure question を登録して session を回収する", async () => {
  const sandbox = await makeWorkspace("sandbox");
  const registry = fakeRegistry();
  t = await bootTidepool({ workspace: sandbox, resolveWorkspace: defaultingTo(sandbox), agentAdmin: registry.agentAdmin });
  const repair = routingJudgmentRepairTask(t.db, t.clock.now());
  await t.clock.advance(HOUR);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${repair.id}`)).json.status).toBe("in_progress");
  const session = String(sessionId(t.db, repair.id));
  t.containers.hold(repair.id);
  registry.state.unreadable = true;

  const res = await callAsTask(t, repair.id, "propose_routing_change", lowerDeckhand);

  await expectReclaimed(t, {
    verb: "propose_routing_change", taskId: repair.id, session, res, fragment: "registry clone is broken", quarantined: sandbox.name,
    nothingRecorded: async () =>
      expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((task) => task.parent_id === repair.id && task.question_cancel_option === null)).toEqual([]),
  });
});
