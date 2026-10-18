import { afterEach, expect, it, vi } from "vitest";
import type { AgentView } from "../src/agent-create.js";
import { appendEvent } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor } from "../src/execution-setting.js";
import { registerMetaReview } from "../src/meta-review.js";
import { registerTask } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { api, bootTidepool, callAsTask, GIT_FIXTURE_TEST_TIMEOUT, HUMAN_WEBUI, makeWorkspace, managementMcpClient, runNow, type Tidepool, WORKER_SPAWNED } from "./harness.js";

/** routing meta-review の Interview の提案 question(#921 / ADR 0199 決定5 / ADR 0258 / ADR 0273 決定9)のサーバ境界: 提案 verb の op
 *  interview、approve が人間の扉で登録する interview root と修正値、pin の陳腐化、registry から消えた実環境、shadow 行の workspace 欄、
 *  登録した root の根拠の読み口。 */

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(() => t?.stop());

const CHILD = { title: "migration", purpose: "write the migration", completion_criteria: "the migration runs" };
/** 表の standard の行(種の表)。根拠の session はこの行で走る。 */
const OPUS = { provider: "anthropic" as const, model: "claude-opus-5-5", effort: "high" };
const OPUS_MAX = { ...OPUS, effort: "max" };
const OPUS_LOW = { ...OPUS, effort: "low" };
/** economy にだけ行のある model の、standard では行でない対象。 */
const SONNET_MAX = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "max" };

/** registry: 名前の集合からテストが消せる(消えた実環境の approve)。 */
let registered: Set<string>;
let spaces: Map<string, WorkspaceConfig>;

/** reef と lagoon を registry に持ち、既定 agent が anthropic の advisor つき entry 1つの盤面に、slot に入った routing meta-review を置く。 */
async function boardWithRoutingReview() {
  const reef = await makeWorkspace("reef");
  const lagoon = await makeWorkspace("lagoon");
  spaces = new Map([reef, lagoon].map((w) => [w.name, w]));
  registered = new Set(spaces.keys());
  const definition = { provider: [{ name: "anthropic", advisor: true }], tier: undefined };
  const board: Tidepool = await bootTidepool({
    workspace: reef,
    resolveWorkspace: (name) => {
      const found = name === null ? reef : registered.has(name) ? spaces.get(name) : undefined;
      if (!found) throw new UnknownWorkspaceError(name!);
      return found;
    },
    agentAdmin: { list: () => [{ name: "fake-worker", provider: "anthropic" } as AgentView] },
    taskExecutionCandidates: (task) => executionSettingsFor(board.db, definition, task),
  });
  t = board;
  applyExecutionSettingsChange(t.db, { setting: "advisor_ceiling", value: "fable" }, "webui", t.clock.now());
  registerMetaReview(t.db, "routing", t.clock.now());
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((task: any) => task.meta_review_subject === "routing" && task.status !== "done");
  await runNow(t, review.id);
  return review.id as string;
}

/** `workspace` の work task の本番の session を1つ刻む(scripted worker は worker_spawned を刻まない)。 */
function session(workspace: string, cell = OPUS) {
  const task = registerTask(t.db, { type: "work", ...CHILD, workspace }, t.clock.now(), ...HUMAN_WEBUI);
  const eventId = appendEvent(t.db, {
    taskId: task.id,
    workerId: "fake-worker",
    origin: "board",
    at: t.clock.now(),
    payload: { ...WORKER_SPAWNED, ...cell, advisor: null, tier_id: tierIdOf(t.db, "standard") },
  });
  return { eventId, taskId: task.id };
}

const proposal = (evidence: number[], fields: Record<string, unknown> = {}) => ({
  op: "interview",
  hypothesis: "opus at a higher effort writes the migrations standard gets wrong",
  measured_work: "schema migrations",
  evidence,
  tier: "standard",
  targets: [OPUS_MAX, OPUS_LOW],
  workspace: "reef",
  rationale: "3 of 4 migrations on opus at effort high were rejected.",
  ...fields,
});

const call = async (reviewId: string, name: string, args: Record<string, unknown>) => {
  const result: any = await callAsTask(t, reviewId, name, args);
  return result.isError ? { error: result.content[0].text as string } : JSON.parse(result.content[0].text);
};
const task = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json;
const answer = (id: string, body: Record<string, unknown>) => api(t.baseUrl, "POST", `/api/tasks/${id}/answer`, body);
const interviews = async () => ((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((x) => x.type === "interview");

it("interview の提案は meta-review の子に approve / reject の question を立て、approve で人間名義の interview root を提案の段・対象・実環境・根拠の task で登録する", async () => {
  const reviewId = await boardWithRoutingReview();
  const first = session("reef");
  const second = session("lagoon");
  const { question_id } = await call(reviewId, "propose_routing_change", proposal([first.eventId, second.eventId]));

  const question = await task(question_id);
  expect(question).toMatchObject({
    type: "question",
    status: "todo",
    parent_id: reviewId,
    question_proposal: { kind: "routing", op: "interview", tier: "standard", targets: [OPUS_MAX, OPUS_LOW], workspace: "reef", evidence: [first.eventId, second.eventId] },
    question_items: [{ options: ["approve", "reject"], recommendation: "approve" }],
  });
  for (const shown of ["opus at a higher effort", "schema migrations", "anthropic / claude-opus-5-5 at effort max", "reef", "3 of 4 migrations"]) {
    expect(question.question_items[0].detail).toContain(shown);
  }

  expect((await answer(question_id, { answers: ["approve"] })).status).toBe(200);
  const [root] = await interviews();
  expect(root).toMatchObject({ status: "todo", registrant: "human", workspace: "reef", tier: "standard", parent_id: null });
  await runNow(t, root.id);
  const current = JSON.parse((await callAsTask(t, root.id, "get_current_task", {})).content[0].text);
  expect(current.interview_targets).toEqual([OPUS_MAX, OPUS_LOW]);
  expect(current.interview).toMatchObject({
    hypothesis: "opus at a higher effort writes the migrations standard gets wrong",
    measured_work: "schema migrations",
    evidence_task_ids: [first.taskId, second.taskId],
    measured_tier: { name: "standard" },
  });
});

it("approve の修正値は仮説・測る仕事・対象の effort・実環境を差し替え、実環境は根拠の workspace に縛られない", async () => {
  const reviewId = await boardWithRoutingReview();
  const { eventId } = session("reef");
  const { question_id } = await call(reviewId, "propose_routing_change", proposal([eventId]));
  const amendment = { hypothesis: "opus at effort max is enough for migrations", measured_work: "data backfills", targets: [OPUS_MAX, { ...OPUS, effort: "medium" }], workspace: "lagoon" };

  // 管理MCP の扉も修正値を運ぶ
  const management = await managementMcpClient(t.baseUrl);
  try {
    const answered: any = await management.callTool({ name: "answer_question", arguments: { task_id: question_id, answers: ["approve"], amendment } });
    expect(answered.isError).not.toBe(true);
  } finally {
    await management.close();
  }
  const [root] = await interviews();
  expect(root).toMatchObject({ workspace: "lagoon", registrant: "human" });
  await runNow(t, root.id);
  const current = JSON.parse((await callAsTask(t, root.id, "get_current_task", {})).content[0].text);
  expect(current.interview_targets).toEqual(amendment.targets);
  expect(current.interview).toMatchObject({ hypothesis: amendment.hypothesis, measured_work: amendment.measured_work, real_environment: expect.stringContaining("tidepool-lagoon-") });
});

it("修正値の対象は effort だけを動かせ、effort の述語に外れる修正値は回答ごと断られて何も登録されない", async () => {
  const reviewId = await boardWithRoutingReview();
  const { eventId } = session("reef");
  const { question_id } = await call(reviewId, "propose_routing_change", proposal([eventId]));
  for (const [targets, refusal] of [
    [[{ ...OPUS_MAX, model: "claude-fable-5-1" }, OPUS_LOW], "with only effort changed"],
    [[OPUS_MAX], "with only effort changed"],
    [[OPUS_MAX, { ...OPUS, effort: "ultra" }], "effort must be one of"],
  ] as const) {
    const refused = await answer(question_id, { answers: ["approve"], amendment: { targets } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toContain(refusal);
  }
  expect(await task(question_id)).toMatchObject({ status: "todo", question_answer: null });
  expect(await interviews()).toEqual([]);
});

it("approve は人間の扉と同じく既定 agent が走らせられない対象を拒み、回答ごと巻き戻って question は開いたまま(ADR 0253 決定3)", async () => {
  const reviewId = await boardWithRoutingReview();
  const { eventId } = session("reef");
  // 既定 agent の entry は anthropic だけ —— openai の対象は走れない
  const { question_id } = await call(reviewId, "propose_routing_change", proposal([eventId], { targets: [{ provider: "openai", model: "gpt-5.6-sol", effort: "low" }] }));

  const refused = await answer(question_id, { answers: ["approve"] });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain("cannot run as");
  expect(await task(question_id)).toMatchObject({ status: "todo", question_answer: null });
  expect(await interviews()).toEqual([]);
});

it("reject では何も登録されず、根拠の行が書き換わるか対象と一致する行が足されると question は observed で決着する", async () => {
  const reviewId = await boardWithRoutingReview();
  const { eventId } = session("reef");
  const [rejected, priced, rowed] = [
    (await call(reviewId, "propose_routing_change", proposal([eventId]))).question_id,
    (await call(reviewId, "propose_routing_change", proposal([eventId], { targets: [OPUS_LOW] }))).question_id,
    (await call(reviewId, "propose_routing_change", proposal([eventId], { targets: [SONNET_MAX] }))).question_id,
  ];
  expect((await answer(rejected, { answers: ["reject"], comment: "not now" })).status).toBe(200);
  expect(await interviews()).toEqual([]);

  // 対象と一致する行(standard の sonnet at max)を足すと、その対象を運ぶ提案だけが決着する —— 別の段の行は一致しない
  const settings = (change: Record<string, unknown>) => api(t.baseUrl, "POST", "/api/settings/execution", change);
  expect((await settings({ setting: "row", row: { ...SONNET_MAX, tier: "frontier", price_in: 2, price_out: 10 } })).status).toBe(200);
  expect(await task(rowed)).toMatchObject({ status: "todo" });
  expect((await settings({ setting: "row", key: SONNET_MAX, row: { ...SONNET_MAX, tier: "standard", price_in: 2, price_out: 10 } })).status).toBe(200);
  expect(await task(rowed)).toMatchObject({ status: "done" });
  expect(await task(priced)).toMatchObject({ status: "todo" });
  // 根拠の行の値段が変わると、残りの提案も決着する
  expect((await settings({ setting: "row", key: OPUS, row: { ...OPUS, tier: "standard", price_in: 6, price_out: 25 } })).status).toBe(200);
  expect(await task(priced)).toMatchObject({ status: "done" });
  const changed = async (id: string) => ((await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[]).find((e) => e.kind === "routing_proposal_stale")?.payload.changed;
  expect([await changed(rowed), await changed(priced)]).toEqual([["target_row"], ["rows"]]);
  expect(await interviews()).toEqual([]);
});

it("実環境が registry から消えた提案の approve は直す手段を添えて断られ、question は開いたまま —— 修正値で差し替えれば通る(ADR 0258 決定4)", async () => {
  const reviewId = await boardWithRoutingReview();
  const { eventId } = session("reef");
  const { question_id } = await call(reviewId, "propose_routing_change", proposal([eventId]));
  registered.delete("reef");

  const refused = await answer(question_id, { answers: ["approve"] });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toBe("workspace reef is not in the registry: approve again with an amendment naming a registered workspace, or reject");
  expect(await task(question_id)).toMatchObject({ status: "todo", question_answer: null });
  expect(await interviews()).toEqual([]);

  expect((await answer(question_id, { answers: ["approve"], amendment: { workspace: "lagoon" } })).status).toBe(200);
  expect(await interviews()).toMatchObject([{ workspace: "lagoon" }]);
});

it("shadow 行は session の task の workspace を運び、approve で登録された root の根拠の読み口は根拠の task の history を返す", async () => {
  await boardWithRoutingReview();
  const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD, workspace: "lagoon" })).json;
  await runNow(t, work.id);
  // 実 adapter が spawn に刻む記録(scripted worker は刻まない)
  const eventId = appendEvent(t.db, { taskId: work.id, workerId: "fake-worker", origin: "board", at: t.clock.now(), payload: { ...WORKER_SPAWNED, ...OPUS, advisor: null, tier_id: tierIdOf(t.db, "standard") } });
  await callAsTask(t, work.id, "log_decision", { line: "split the migration in two" });
  // 読み手は work の pickup の後の routing meta-review(前のものは runNow が完了させた)
  registerMetaReview(t.db, "routing", t.clock.now());
  const reviewId = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((x: any) => x.meta_review_subject === "routing" && x.status !== "done").id;
  await runNow(t, reviewId);

  const { shadow } = await call(reviewId, "list_routing_shadow", { since_watermark: 0 });
  expect(shadow.find((row: any) => row.task_id === work.id)).toMatchObject({ worker_spawned_event_id: eventId, workspace: "lagoon" });
  const { question_id } = await call(reviewId, "propose_routing_change", proposal([eventId], { workspace: "lagoon" }));
  expect((await answer(question_id, { answers: ["approve"] })).status).toBe(200);
  const [root] = await interviews();
  await runNow(t, root.id);
  const read: any = await callAsTask(t, root.id, "read_evidence_history", { task_id: work.id });
  expect(read.isError).toBeFalsy();
  expect(JSON.parse(read.content[0].text).history).toContainEqual({ decision: "split the migration in two" });
});

it("verb は根拠を欠く提案・表に無い model の対象・表の行と一致する対象・effort の述語に外れる対象・根拠の workspace でない実環境を拒み、question は立たない", async () => {
  const reviewId = await boardWithRoutingReview();
  const { eventId } = session("reef");
  // xhigh を high で走らせる model の行(economy)を足す
  applyExecutionSettingsChange(t.db, { setting: "row", row: { provider: "anthropic", tier: "economy", model: "claude-opus-4-6", effort: "high", price_in: 1, price_out: 5 } }, "webui", t.clock.now());
  for (const [fields, refusal] of [
    [{ evidence: [] }, "at least one evidence worker_spawned event id"],
    [{ targets: [{ ...OPUS, model: "claude-opus-9-9" }] }, "the execution-setting table has no row for anthropic / claude-opus-9-9"],
    [{ targets: [OPUS] }, "is already a row of the table in tier standard"],
    [{ targets: [{ ...OPUS, model: "claude-opus-4-6", effort: "xhigh" }] }, "runs as high"],
    [{ workspace: "lagoon" }, "workspace lagoon is not the workspace of any evidence session (reef)"],
    [{ workspace: "nowhere" }, "unknown workspace: nowhere"],
  ] as const) {
    expect(await call(reviewId, "propose_routing_change", proposal([eventId], fields))).toEqual({ error: expect.stringContaining(refusal) });
  }
  expect(((await api(t.baseUrl, "GET", "/api/tasks")).json as any[]).filter((q) => q.parent_id === reviewId)).toEqual([]);
});
