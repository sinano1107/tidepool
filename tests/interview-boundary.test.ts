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
  git,
  HOUR,
  makeWorkspace,
  managementMcpClient,
  mcpClient,
  questions,
  runNow,
  type Tidepool,
  WORKER_SPAWNED,
} from "./harness.js";

// Interview の盤面境界(登録 → 出題 → 統合復帰 → 採点完了)。振る舞いは interview.test.ts の domain 層で一度ずつ言い、
// ここは扉の写像だけを言う(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(() => t?.stop());

const opus46 = { provider: "anthropic", model: "claude-opus-4-6", effort: "high", tier: "frontier" };
const sol = { provider: "openai", model: "gpt-5.6-sol", effort: "high", tier: "standard" };
const INTERVIEW = { type: "review", title: "interview", purpose: "the original task", completion_criteria: "every target scored" };
const CHILD = { title: "probe", purpose: "run the probe", completion_criteria: "the probe's deliverable" };
const FINDINGS = { outcome: "the parser probe separates the targets" };
const POSE = { title: "add a parser", probe: "write a parser for the config format", completion_criteria: "the parser handles every sample", rubric: "tests pass, no new dependency" };
/** root が出題し、立った pin の子の id を返す。 */
const pose = async (rootId: string): Promise<[string, ...string[]]> => JSON.parse((await callAsTask(t, rootId, "pose_probe", POSE)).content[0].text).child_ids;

/** 既定 agent(scripted worker の id)を anthropic の advisor つき entry 1つで持つ盤面。上限は fable、学習器は既定で昇格済み。 */
let workspacePath: string;
/** 既定 agent の定義。テストが entry を差し替えて、登録の後に走れなくなった盤面を作れる。 */
let definition: { provider: Array<{ name: string; advisor: boolean }>; tier: undefined };
async function boot({ promoted = true } = {}): Promise<Tidepool> {
  const workspace = await makeWorkspace("reef");
  workspacePath = workspace.path;
  definition = { provider: [{ name: "anthropic", advisor: true }], tier: undefined };
  const board: Tidepool = await bootTidepool({
    workspace,
    agentAdmin: { list: () => [{ name: "fake-worker", provider: "anthropic" } as AgentView] },
    taskExecutionCandidates: (task) => executionSettingsFor(board.db, definition, task),
  });
  applyExecutionSettingsChange(board.db, { setting: "advisor_ceiling", value: "fable" }, "webui", board.clock.now());
  if (promoted) applyExecutionSettingsChange(board.db, { setting: "learner_promoted", value: true }, "webui", board.clock.now());
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

it("既定 agent が走らせられない対象(entry に無い Provider・導出できない advisor)は、登録の扉(Register API・管理MCP)と出題が名指して拒み、出題の拒否は escalate を指す(ADR 0253 決定3)", async () => {
  t = await boot();
  const ghost = { provider: "anthropic", model: "claude-ghost-1-0", effort: "high", tier: "frontier" };
  for (const target of [sol, ghost]) {
    const refused = await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46, target] });
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain(`${JSON.stringify(target)} cannot run as fake-worker`);
  }
  const client = await managementMcpClient(t.baseUrl);
  const viaMcp: any = await client.callTool({ name: "register_task", arguments: { ...INTERVIEW, interview_targets: [sol] } });
  await client.close();
  expect(viaMcp.isError).toBe(true);
  expect(viaMcp.content[0].text).toContain("gpt-5.6-sol");
  expect(viaMcp.content[0].text).toContain("cannot run as fake-worker");
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json).toEqual([]);

  // 登録の後に既定 agent の entry から Provider が外れた盤面: 出題が拒み、何も登録されない
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  definition.provider = [{ name: "openai", advisor: false }];
  const posed: any = await callAsTask(t, root.id, "pose_probe", POSE);
  expect(posed.isError).toBe(true);
  expect(posed.content[0].text).toContain(`${JSON.stringify(opus46)} cannot run as fake-worker`);
  expect(posed.content[0].text).toContain("escalate");
  expect((await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.parent_id === root.id)).toEqual([]);
});

it("worker MCP の tool 一覧は taskVerbSwap に従う —— Interview の root は分解の verb も complete_task も持たず、出題前は pose_probe を、出題済みは complete_interview と report_broken_probe を持つ。pin の子は分解の verb だけを持たず、普通の work は分解の verb を持ち、pin の子と普通の work はどの差し替えの verb も持たない(ADR 0253 決定4・5 / ADR 0251 決定1・2)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
  const tools = async (taskId: string) => {
    const client = await mcpClient(t.mcpBaseUrl, taskId);
    try {
      return (await client.listTools()).tools.map((tool) => tool.name);
    } finally {
      await client.close();
    }
  };
  const ordinary = await tools(work.id);
  expect(ordinary).toEqual(expect.arrayContaining(["decompose", "redecompose", "complete_task"]));
  for (const verb of ["pose_probe", "complete_interview", "report_broken_probe", "score_interview"]) expect(ordinary).not.toContain(verb);
  const unsplit = ordinary.filter((name) => name !== "decompose" && name !== "redecompose");
  const rootVerbs = unsplit.filter((name) => name !== "complete_task");
  expect((await tools(root.id)).sort()).toEqual([...rootVerbs, "pose_probe"].sort());
  // 出題の前に対象の一覧を読める(#1924 User Story 3)
  expect(JSON.parse((await callAsTask(t, root.id, "get_current_task", {})).content[0].text).interview_targets).toEqual([opus46]);
  const [childId] = await pose(root.id);
  expect((await tools(root.id)).sort()).toEqual([...rootVerbs, "complete_interview", "report_broken_probe"].sort());
  expect(await tools(childId)).toEqual(unsplit);
});

it("出題の event は、出題の verb が呼ばれた checkout の保護ブランチの head を持つ(ADR 0263 決定6)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  await pose(root.id);

  const posed = (await api(t.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json.find((e: any) => e.kind === "decision_logged");
  expect(posed.payload.head).toBe(git(workspacePath, "rev-parse", "main"));
});

it("出題で立った pin の子は対象で spawn され、PR も完了時レビューも生まれず、統合復帰した root が伏せた handoff を採点完了で採点して完了する", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [childId] = await pose(root.id);
  // 上限の書き込みが routing meta-review の材料になるので、先に済ませる(setup)
  await completeMetaReviews(t);

  expect(t.worker.started.at(-1)!.id).toBe(childId);
  expect(t.worker.startedSettings.at(-1)).toMatchObject({ model: "claude-opus-4-6", tier_id: tierIdOf(t.db, "frontier"), source: { tier: "interview", provider: "interview" } });
  commitWork(workspacePath, "probe.txt", "probe\n");
  expect((await callAsTask(t, childId, "complete_task", { handoff: FULL_HANDOFF })).isError).toBeFalsy();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((task: any) => task.parent_id === childId)).toEqual([]);
  expect(await questions(t)).toEqual([]);
  expect(t.github.requests).toEqual([]);

  // 統合復帰: 採点の読み口(get_current_task の応答の全体)は agent 名も model id も持たない(伏せた handoff)
  await t.clock.advance(HOUR);
  expect(t.worker.started.at(-1)!.id).toBe(root.id);
  const scoringInput = (await callAsTask(t, root.id, "get_current_task", {})).content[0].text;
  expect(scoringInput).not.toContain("fake-worker");
  expect(scoringInput).not.toContain("claude-opus-4-6");
  const completed: any = await callAsTask(t, root.id, "complete_interview", { scores: [{ child_id: childId, outcome: "accepted" }], handoff: FINDINGS });
  expect(completed.isError).toBeFalsy();
  const annotation = (await api(t.baseUrl, "GET", `/api/tasks/${childId}/events`)).json.find((e: any) => e.kind === "interview_scored");
  expect(annotation).toMatchObject({ payload: { outcome: "accepted" } });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json.find((e: any) => e.kind === "task_completed")).toMatchObject({ payload: { result: FINDINGS.outcome } });
});

it("採点した対象の段に行を足すと、その行の本番の pickup の shadow 行が Interview の内訳を運び、list_routing_shadow に出る", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [childId] = await pose(root.id);
  await completeMetaReviews(t);
  // 実 adapter が spawn に刻む記録(scripted worker は刻まない —— 刻むことは adapter の seam が言う)
  const { advisor, ...setting } = t.worker.startedSettings.at(-1)!;
  appendEvent(t.db, { taskId: childId, workerId: "fake-worker", origin: "board", at: t.clock.now(), payload: { ...WORKER_SPAWNED, ...setting, advisor: advisor ?? null } });
  await callAsTask(t, childId, "complete_task", { handoff: FULL_HANDOFF });
  await t.clock.advance(HOUR);
  await callAsTask(t, root.id, "complete_interview", { scores: [{ child_id: childId, outcome: "accepted" }], handoff: FINDINGS });
  const row = { setting: "row", row: { ...opus46, price_in: 1, price_out: 5 } };
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", row)).status).toBe(200);
  const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD, tier: "frontier" })).json;
  await t.clock.advance(HOUR);

  // 読み手の routing meta-review を置く(周期の待ちは meta-review の機構の話なので setup で立てる)
  registerMetaReview(t.db, "routing", t.clock.now());
  const [review] = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.meta_review_subject === "routing" && task.status !== "done");
  await runNow(t, review.id);
  const { shadow } = JSON.parse((await callAsTask(t, review.id, "list_routing_shadow", { since_watermark: 0 })).content[0].text);
  expect(shadow.find((r: any) => r.task_id === work.id)).toMatchObject({ actual: { model: "claude-opus-4-6" }, actual_record: { board: { interview: { accepted: 1 } } } });
});

it("pin の子の pickup は、学習器が昇格していない盤面でも shadow 行を残さない(選ぶ余地が無い)", async () => {
  t = await boot({ promoted: false });
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [childId] = await pose(root.id);
  await completeMetaReviews(t);
  expect(t.worker.started.at(-1)!.id).toBe(childId);
  // root を採点完了で終わらせて slot を空けてから meta-review を走らせる
  await callAsTask(t, childId, "complete_task", { handoff: FULL_HANDOFF });
  await t.clock.advance(HOUR);
  await callAsTask(t, root.id, "complete_interview", { scores: [{ child_id: childId, outcome: "accepted" }], handoff: FINDINGS });
  registerMetaReview(t.db, "routing", t.clock.now());
  const [review] = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.meta_review_subject === "routing" && task.status !== "done");
  await runNow(t, review.id);
  const { shadow } = JSON.parse((await callAsTask(t, review.id, "list_routing_shadow", { since_watermark: 0 })).content[0].text);
  expect(shadow.filter((row: any) => row.task_id === childId)).toEqual([]);
});
