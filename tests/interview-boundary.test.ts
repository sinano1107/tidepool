import { afterEach, expect, it, vi } from "vitest";
import type { AgentView } from "../src/agent-create.js";
import { DEFAULT_AUDITOR_NAME } from "../src/defaults.js";
import { appendEvent, listEvents } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor } from "../src/execution-setting.js";
import { buildMemoryInjection } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { registerQuarantine, tableRowValue } from "../src/quarantine.js";
import { getTask } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import type { WatchdogConfig } from "../src/watchdog.js";
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
  QUIET_EXIT,
  questions,
  readFollowingNext,
  registerQuestion,
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
/** root が出題し、立った受験者の id を返す。 */
const pose = async (rootId: string): Promise<[string, ...string[]]> => JSON.parse((await callAsTask(t, rootId, "pose_probe", POSE)).content[0].text).child_ids;

/** 既定 agent(scripted worker の id)を anthropic の advisor つき entry 1つで持つ盤面。上限は fable、学習器は既定で昇格済み。 */
let workspacePath: string;
/** 既定 agent の定義。テストが entry を差し替えて、登録の後に走れなくなった盤面を作れる。 */
let definition: { provider: Array<{ name: string; advisor: boolean }>; tier: undefined };
async function boot({ promoted = true, watchdog }: { promoted?: boolean; watchdog?: WatchdogConfig } = {}): Promise<Tidepool> {
  const workspace = await makeWorkspace("reef");
  workspacePath = workspace.path;
  definition = { provider: [{ name: "anthropic", advisor: true }], tier: undefined };
  const board: Tidepool = await bootTidepool({
    workspace,
    agentAdmin: { list: () => [{ name: "fake-worker", provider: "anthropic" } as AgentView] },
    taskExecutionCandidates: (task) => executionSettingsFor(board.db, definition, task),
    watchdog,
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

it("worker MCP の tool 一覧は taskVerbSwap に従う —— Interview の root は分解の verb も complete_task も持たず、出題前は pose_probe を、出題済みは complete_interview と report_broken_probe を持つ。受験者は分解の verb だけを持たず、普通の work は分解の verb を持ち、受験者と普通の work はどの差し替えの verb も持たない(ADR 0253 決定4・5 / ADR 0251 決定1・2)", async () => {
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

it("出題で立った受験者は対象で spawn され、PR も完了時レビューも生まれず、統合復帰した root が伏せた handoff を採点完了で採点して完了する", async () => {
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

it("受験者の pickup は、学習器が昇格していない盤面でも shadow 行を残さない(選ぶ余地が無い)", async () => {
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

const sonnet55 = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", tier: "economy" };
const haiku45 = { provider: "anthropic", model: "claude-haiku-4-5", effort: null, tier: "economy" };
const SWEEP_POSE = { ...POSE, rubric: "rubric-mark-7f3: the parser rejects a bad sample" };
const SIBLING_ANSWER = "sibling-answer-mark-91c";
const ROOT_MARK = "root-mark-3e9";
const SIBLING_MEMORY = "sibling-memory-mark-4d2";
const TREE_MEMORY = "tree-memory-mark-b85";

it("走れない対象を写す retry の拒否は、WebUI の回答 API では回答の拒否の status(409)に、管理MCP の answer_question では isError に写り、どちらも対象と abandon を名指す(ADR 0253 決定3)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [child] = await pose(root.id);
  await runNow(t, child);
  expect((await callAsTask(t, child, "complete_task", { handoff: FULL_HANDOFF })).isError).toBeFalsy();
  expect((await callAsTask(t, root.id, "report_broken_probe", { reason: "the probe is broken", recommendation: "retry" })).isError).toBeFalsy();
  const question = (await questions(t)).find((q) => q.parent_id === root.id && q.status !== "done");
  definition.provider = [{ name: "openai", advisor: false }];
  const refused = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["retry"] });
  expect(refused.status).toBe(409);
  for (const text of [`${JSON.stringify(opus46)} cannot run as fake-worker`, `answer "abandon"`]) expect(refused.json.error).toContain(text);
  const client = await managementMcpClient(t.baseUrl);
  const viaMcp: any = await client.callTool({ name: "answer_question", arguments: { task_id: question.id, answers: ["retry"] } });
  await client.close();
  expect(viaMcp.isError).toBe(true);
  for (const text of [`${JSON.stringify(opus46)} cannot run as fake-worker`, `answer "abandon"`]) expect(viaMcp.content[0].text).toContain(text);
});

/** 読み手に立った未回答の question に人間が答え、読み手が slot に戻るまで進める。 */
async function answerReaderQuestion(reader: string, answers: string[], comment?: string) {
  await new Promise((resolve) => setImmediate(resolve));
  const question = (await questions(t)).find((q) => q.parent_id === reader && q.status !== "done");
  expect((await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers, comment })).status).toBe(200);
  await t.clock.advance(HOUR);
  // 兄弟が書いた Knowledge が記憶の meta-review を立て、先に slot を取る —— 終えて読み手に戻す
  await completeMetaReviews(t);
  await runNow(t, reader);
  expect(t.worker.started.at(-1)!.id).toBe(reader);
}

/** 最後の受験者が読む盤面(ADR 0263 決定10 の sweep の状況、ADR 0267 決定7 で親の場面を外した形): 人間が書いた root の題・目的は
 *  「Interview」と目印を持ち、root は出題以外の目印つきの判断ログの行と question を持つ —— 受験者には親が無いので、どれも見えては
 *  ならない。兄弟の1つは目印つきの Knowledge を書いて目印つきの handoff で done、1つは「この対象は測らない」で cancel、最後の対象の
 *  受験者は failure を retry で再開し、escalate して答えを受けてから slot に居て、自分の history の長さで get_current_task が続き
 *  (ADR 0195)を持つ。`pulls` はその受験者が記憶の pull verb(browse・search・read)で兄弟の Knowledge と、root が書いた
 *  目印つきの Knowledge・人間が出題の event を出所に書いた目印つきの Exemplar(ADR 0264 決定3)を探した応答と、最後に兄弟が
 *  目印つきで定義した枝を定義した応答(ADR 0264 決定4)。`injection` はその受験者の直近の spawn で adapter が組むはずの記憶の
 *  注入の節で、adapter が渡すのと同じ引数(盤面が渡した task と query、task の workspace 名、worker の agent 名)で組む。
 *  `production` は同じ盤面に Register API で登録した本番の親なし work の tools/list。 */
async function lastExaminee() {
  // 時限は見ない watchdog: 報告なき exit を failure question にする口だけを使う(ADR 0145)
  t = await boot({ watchdog: { timeLimits: {}, grace: HOUR } });
  const root = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: `Interview the parser targets ${ROOT_MARK}`,
      purpose: `Interview which target writes the parser ${ROOT_MARK}`,
      completion_criteria: "every target scored",
      interview_targets: [opus46, sonnet55, haiku45],
    })
  ).json;
  await callAsTask(t, root.id, "log_decision", { line: `chose the parser probe over the lexer one ${ROOT_MARK}` });
  const rootKnowledge = { path: "parser", title: `parser ${TREE_MEMORY}`, text: `the parser ${TREE_MEMORY}`, source: { commit: "0a46a46" } };
  const rootEntry = JSON.parse((await callAsTask(t, root.id, "record_knowledge", rootKnowledge)).content[0].text).entry_id;
  const [done, cancelled, reader] = JSON.parse((await callAsTask(t, root.id, "pose_probe", SWEEP_POSE)).content[0].text).child_ids;
  const posed = listEvents(t.db, root.id).find((e) => e.payload.kind === "decision_logged" && e.payload.interview_probe)!.id;
  const exemplar = await api(t.baseUrl, "POST", "/api/settings/memory/exemplars", {
    workspace: getTask(t.db, root.id)!.workspace,
    path: "parser",
    title: `parser ${TREE_MEMORY}`,
    addressee: null,
    source_event_id: posed,
    annotations: [{ anchor: "whole", polarity: "imitate", text: `the parser ${TREE_MEMORY}` }],
  });
  expect(exemplar.status).toBe(200);
  // root の書き込みが記憶の meta-review を立てる —— 受験者より先に slot を取らせて、出題が立てた meta-review と一緒に終える
  const memoryReview = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((x: any) => x.meta_review_subject === "memory");
  await api(t.baseUrl, "POST", `/api/tasks/${memoryReview.id}/move`, { after: null });
  await completeMetaReviews(t);
  registerQuarantine(t.db, "interviewTarget", tableRowValue("anthropic", sonnet55.model), "the provider refused", t.clock.now());
  const refusal = (await questions(t)).find((q) => q.question_quarantine_kind === "interviewTarget");
  expect((await api(t.baseUrl, "POST", `/api/tasks/${refusal.id}/answer`, { answers: ["do not measure this target"] })).status).toBe(200);
  commitWork(workspacePath, "probe.txt", "probe\n");
  const knowledge = { path: "parser", title: `parser ${SIBLING_MEMORY}`, text: `the parser ${SIBLING_MEMORY}`, source: { commit: "0a46a46" } };
  const { entry_id } = JSON.parse((await callAsTask(t, done, "record_knowledge", knowledge)).content[0].text);
  const siblingBranch = { prefix: "parser", definition: `the parser ${SIBLING_MEMORY}` };
  const siblingDefinition = JSON.parse((await callAsTask(t, done, "define_memory_branch", siblingBranch)).content[0].text).entry_id;
  expect((await callAsTask(t, done, "complete_task", { handoff: { ...FULL_HANDOFF, outcome: SIBLING_ANSWER } })).isError).toBeFalsy();
  await t.clock.advance(HOUR);
  expect(t.worker.started.at(-1)!.id).toBe(reader);
  t.worker.exitWith(reader, { ...QUIET_EXIT, exit_code: 1 });
  await answerReaderQuestion(reader, ["retry"], "retry with the streaming API");
  const escalation = { context: "the sample config has two formats", questions: [{ title: "which format?", options: ["yaml", "toml"], recommendation: "yaml" }] };
  expect((await callAsTask(t, reader, "escalate", escalation)).isError).toBeFalsy();
  await answerReaderQuestion(reader, ["toml"], "toml only");
  registerQuestion(t, {
    parent_id: root.id,
    title: `a root question ${ROOT_MARK}`,
    purpose: `the Interview root asks ${ROOT_MARK}`,
    completion_criteria: "answered",
    question: [{ title: "which?", options: ["a", "b"], recommendation: "a" }],
  });
  const client = await mcpClient(t.mcpBaseUrl, reader);
  try {
    for (let i = 0; i < 15; i++) await client.callTool({ name: "log_decision", arguments: { line: `${i} ${"x".repeat(3_000)}` } });
    const pages = (await readFollowingNext(client, "get_current_task")).map((response) => response.payload);
    const pulls = [
      { name: "browse_memory", arguments: { prefix: "parser" } },
      { name: "search_memory", arguments: { query: SIBLING_MEMORY } },
      { name: "search_memory", arguments: { query: TREE_MEMORY } },
      { name: "read_memory", arguments: { ids: [entry_id, rootEntry, exemplar.json.entry_id] } },
    ];
    const pulled = await Promise.all(pulls.map((call) => client.callTool(call)));
    // 兄弟が定義した枝を定義する(ADR 0264 決定4)—— pull の後に、応答は pull と同じく検査される
    pulled.push(await client.callTool({ name: "define_memory_branch", arguments: { prefix: "parser", definition: "What the parser work files." } }));
    const spawn = t.worker.started.map((task) => task.id).lastIndexOf(reader);
    const spawned = t.worker.started[spawn]!;
    expect(spawned.workspace).not.toBeNull();
    const injection = buildMemoryInjection(t.db, spawned, spawned.workspace, t.worker.id, t.worker.startedQueries[spawn]).section;
    const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
    const productionClient = await mcpClient(t.mcpBaseUrl, work.id);
    let production: Awaited<ReturnType<typeof productionClient.listTools>>["tools"];
    try {
      production = (await productionClient.listTools()).tools;
    } finally {
      await productionClient.close();
    }
    return { rootId: root.id, siblings: [done, cancelled], siblingDefinition, pages, pulls: pulled, injection, tools: (await client.listTools()).tools, production };
  } finally {
    await client.close();
  }
}

it("最後の受験者が読む get_current_task の全ページ・tools/list の全説明文・記憶の pull(browse・search・read)と兄弟が定義した枝の define の応答・記憶の注入の節に、Interview の語・rubric・対象の model 名・兄弟の id・兄弟の答案と記憶の目印・採点者の印・親の欄・親の history の行・登録者の名前が出ず、define は通る(ADR 0263 決定7・10、ADR 0264 決定4・6、ADR 0267 決定7)", async () => {
  const { rootId, siblings, siblingDefinition, pages, pulls, injection, tools, production } = await lastExaminee();
  expect(pages.length).toBeGreaterThan(1);
  for (const page of pages) expect(page.parent ?? null).toBeNull();
  // 登録者は root の agent —— root の面には出ている名前で、受験者の面に出ないことを確かめる
  expect((await api(t.baseUrl, "GET", `/api/tasks/${rootId}`)).json.assignee).toBe(DEFAULT_AUDITOR_NAME);
  for (const pull of pulls) expect(pull.isError).toBeFalsy();
  // tools/list は登録された verb を全部回す —— 新しい verb は自動で検査に入る
  const read = [...pages, ...pulls, injection, ...tools].map((item) => JSON.stringify(item)).join("\n");
  expect(read).not.toMatch(/interview/i);
  for (const text of [SWEEP_POSE.rubric, opus46.model, sonnet55.model, haiku45.model, SIBLING_ANSWER, SIBLING_MEMORY, TREE_MEMORY, ROOT_MARK, DEFAULT_AUDITOR_NAME, "not shown to examinees", ...siblings, `entry ${siblingDefinition}`]) {
    expect(read).not.toContain(text);
  }
  // 写像: 本番の親なし work の tools/list(名前・説明文・schema)との差は分解の verb だけ(ADR 0267 決定7)。どの verb を
  // 外すかは interview.test.ts の taskVerbSwap が言う
  expect(production.map((tool) => tool.name)).toEqual(expect.arrayContaining(["decompose", "redecompose"]));
  expect(tools).toEqual(production.filter((tool) => tool.name !== "decompose" && tool.name !== "redecompose"));
});

it("受験者の詳細と盤面の一覧の行は、その Interview の root の id を名指す(ADR 0267 決定6)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [examinee] = await pose(root.id);
  // 行の中身(どの受験者がどの root を名指すか)は interview.test.ts の domain 層で言う。ここは詳細の wire に欄が載る写像だけ
  expect((await api(t.baseUrl, "GET", `/api/tasks/${examinee}`)).json.interview_root_id).toBe(root.id);
});
