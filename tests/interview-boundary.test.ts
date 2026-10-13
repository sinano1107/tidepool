import { afterEach, expect, it, vi } from "vitest";
import type { AgentView } from "../src/agent-create.js";
import { appendEvent } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor } from "../src/execution-setting.js";
import { registerMetaReview } from "../src/meta-review.js";
import { tierIdOf } from "../src/tier.js";
import {
  api,
  bootTidepool,
  callAsTask,
  commitWork,
  completeMetaReviews,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  HOUR,
  makeWorkspace,
  managementMcpClient,
  questions,
  runNow,
  type Tidepool,
  WORKER_SPAWNED,
} from "./harness.js";

// Interview の盤面境界(登録 → decompose → 統合復帰 → 注釈)。振る舞いは interview.test.ts の domain 層で一度ずつ言い、
// ここは扉の写像だけを言う(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(() => t?.stop());

const opus46 = { provider: "anthropic", model: "claude-opus-4-6", effort: "high", tier: "frontier" };
const sol = { provider: "openai", model: "gpt-5.6-sol", effort: "high", tier: "standard" };
const INTERVIEW = { type: "review", title: "interview", purpose: "the original task", completion_criteria: "every target scored" };
const CHILD = { title: "probe", purpose: "run the probe", completion_criteria: "the probe's deliverable" };

/** 既定 agent(scripted worker の id)を anthropic の advisor つき entry 1つで持つ盤面。上限は fable、学習器は昇格済み。 */
let workspacePath: string;
async function boot(): Promise<Tidepool> {
  const workspace = await makeWorkspace("reef");
  workspacePath = workspace.path;
  const definition = { provider: [{ name: "anthropic", advisor: true }], tier: undefined };
  const board: Tidepool = await bootTidepool({
    workspace,
    agentAdmin: { list: () => [{ name: "fake-worker", provider: "anthropic" } as AgentView] },
    taskExecutionCandidates: (task) => executionSettingsFor(board.db, definition, task),
  });
  applyExecutionSettingsChange(board.db, { setting: "advisor_ceiling", value: "fable" }, "webui", board.clock.now());
  board.db.prepare("UPDATE execution_defaults SET learner_promoted = 1").run();
  return board;
}

it("登録の扉(WebUI の Register API・管理MCP)は対象の一覧を受け、検査の拒否をそれぞれの失敗に写す", async () => {
  t = await boot();
  const refused = await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [{ ...opus46, provider: "acme" }] });
  expect(refused.status).toBe(400);
  expect(refused.json.error).toContain('unknown provider "acme"');
  const client = await managementMcpClient(t.baseUrl);
  const viaMcp: any = await client.callTool({ name: "register_task", arguments: { ...INTERVIEW, interview_targets: [{ ...opus46, model: "opus" }] } });
  await client.close();
  expect(viaMcp.isError).toBe(true);
  expect(viaMcp.content[0].text).toContain("is a Claude CLI alias");
  const root = await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] });
  expect(root.status).toBe(201);
  const child = await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD, parent_id: root.json.id, decompose_reason: "r", interview_targets: [opus46] });
  expect(child.json.error).toContain("only a root review task (an Interview) carries interview_targets");
});

it("Interview の root は対象を読んで decompose し、一覧に無い pin と assignee の entry に無い Provider の pin は拒まれる", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46, sol] })).json;
  const current = JSON.parse((await callAsTask(t, root.id, "get_current_task", {})).content[0].text);
  expect(current.interview_targets).toEqual([opus46, sol]);
  const decompose = (pin: object) => callAsTask(t, root.id, "decompose", { reason: "one child per target", children: [{ ...CHILD, interview_pin: pin }] });
  const offList: any = await decompose({ ...opus46, effort: "medium" });
  expect(offList.content[0].text).toContain("is not one of this Interview's targets");
  const offEntries: any = await decompose(sol);
  expect(offEntries.content[0].text).toContain("openai is not among fake-worker's providers");
});

it("pin の子は対象で spawn され、PR も完了時レビューも生まれず、統合復帰した root が伏せた handoff を採点する", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  await callAsTask(t, root.id, "log_decision", { line: "probe: add a parser; rubric: tests pass, no new dependency" });
  await t.clock.advance(1000);
  const decomposed = JSON.parse((await callAsTask(t, root.id, "decompose", { reason: "one child per target", children: [{ ...CHILD, interview_pin: opus46 }] })).content[0].text);
  const [childId] = decomposed.child_ids;
  // 上限の書き込みが routing meta-review の材料になるので、先に済ませる(setup)
  await completeMetaReviews(t);

  expect(t.worker.started.at(-1)!.id).toBe(childId);
  expect(t.worker.startedSettings.at(-1)).toEqual({
    provider: "anthropic",
    model: "claude-opus-4-6",
    effort: "high",
    advisor: "fable",
    tier_id: tierIdOf(t.db, "frontier"),
    source: { tier: "interview", provider: "interview", advisor: "ceiling" },
  });
  commitWork(workspacePath, "probe.txt", "probe\n");
  expect((await callAsTask(t, childId, "complete_task", { handoff: FULL_HANDOFF })).isError).toBeFalsy();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((task: any) => task.parent_id === childId)).toEqual([]);
  expect(await questions(t)).toEqual([]);
  expect(t.github.requests).toEqual([]);

  // 統合復帰: 採点する子の history は agent 名も model id も持たない(伏せた handoff)
  await t.clock.advance(HOUR);
  expect(t.worker.started.at(-1)!.id).toBe(root.id);
  await t.clock.advance(1000);
  const scoringInput = JSON.stringify(JSON.parse((await callAsTask(t, root.id, "get_current_task", {})).content[0].text).history);
  expect(scoringInput).toContain(childId);
  expect(scoringInput).not.toContain("fake-worker");
  expect(scoringInput).not.toContain("claude-opus-4-6");
  const scored: any = await callAsTask(t, root.id, "score_interview", { child_id: childId, outcome: "accepted" });
  expect(scored.isError).toBeFalsy();

  const decision = (await api(t.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json.find((e: any) => e.kind === "decision_logged");
  const annotation = (await api(t.baseUrl, "GET", `/api/tasks/${childId}/events`)).json.find((e: any) => e.kind === "interview_scored");
  expect(annotation).toMatchObject({ payload: { outcome: "accepted" } });
  expect(Date.parse(annotation.created_at)).toBeGreaterThan(Date.parse(decision.created_at));
});

it("採点した対象の段に行を足すと、その行の本番の pickup の shadow 行が Interview の内訳を運び、list_routing_shadow に出る", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const decomposed = JSON.parse((await callAsTask(t, root.id, "decompose", { reason: "one child per target", children: [{ ...CHILD, interview_pin: opus46 }] })).content[0].text);
  await completeMetaReviews(t);
  // 実 adapter が spawn に刻む記録(scripted worker は刻まない —— 刻むことは adapter の seam が言う)
  const { advisor, ...setting } = t.worker.startedSettings.at(-1)!;
  appendEvent(t.db, { taskId: decomposed.child_ids[0], workerId: "fake-worker", origin: "board", at: t.clock.now(), payload: { ...WORKER_SPAWNED, ...setting, advisor: advisor ?? null } });
  await callAsTask(t, decomposed.child_ids[0], "complete_task", { handoff: FULL_HANDOFF });
  await t.clock.advance(HOUR);
  await callAsTask(t, root.id, "score_interview", { child_id: decomposed.child_ids[0], outcome: "accepted" });
  await callAsTask(t, root.id, "complete_task", {});
  const row = { setting: "row", row: { ...opus46, price_in: 1, price_out: 5 } };
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", row)).status).toBe(200);
  const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD, tier: "frontier" })).json;
  await t.clock.advance(HOUR);

  // 読み手の routing meta-review を置く(周期の待ちは meta-review の機構の話なので setup で立てる)
  registerMetaReview(t.db, "routing", t.clock.now());
  const [review] = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.meta_review_subject === "routing" && task.status !== "done");
  await runNow(t, review.id);
  const { shadow } = JSON.parse((await callAsTask(t, review.id, "list_routing_shadow", { since_watermark: 0 })).content[0].text);
  const record = { accepted: 1, rejected: 0, interview: { accepted: 1, rejected: 0 } };
  expect(shadow.find((r: any) => r.task_id === work.id)).toMatchObject({ actual: { model: "claude-opus-4-6" }, actual_record: { board: record, workspace: record } });
});
