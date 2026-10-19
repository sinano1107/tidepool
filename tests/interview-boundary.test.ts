import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentView } from "../src/agent-create.js";
import { DEFAULT_INTERVIEWER_NAME } from "../src/defaults.js";
import { appendEvent, listEvents } from "../src/events.js";
import { applyExecutionSettingsChange, executionSettingsFor } from "../src/execution-setting.js";
import { buildMemoryInjection } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { registerQuarantine, tableRowValue, workspaceContainmentValue } from "../src/quarantine.js";
import { getTask, INTERVIEW_AUDIT_NOTICE } from "../src/tasks.js";
import { tierIdOf } from "../src/tier.js";
import type { WatchdogConfig } from "../src/watchdog.js";
import { UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import type { WorkspaceDeletionReferences } from "../src/workspace-create.js";
import {
  api,
  type BootOptions,
  bootTidepool,
  callAsTask,
  commitWork,
  completeMetaReviews,
  FULL_HANDOFF,
  failGitCommits,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  managementMcpClient,
  mcpClient,
  poseThroughAudit,
  QUIET_EXIT,
  questions,
  readFollowingNext,
  registerQuestion,
  runNow,
  servedQuarantineQuestion,
  type Tidepool,
  WORKER_SPAWNED,
} from "./harness.js";

// Interview の盤面境界(登録 → 出題 → 統合復帰 → 採点完了)。振る舞いは interview.test.ts の domain 層で一度ずつ言い、
// ここは扉の写像だけを言う(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(() => t?.stop());

const opus46 = { provider: "anthropic", model: "claude-opus-4-6", effort: "high" };
const sol = { provider: "openai", model: "gpt-5.6-sol", effort: "high" };
const INTERVIEW = { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "frontier" };
const CHILD = { title: "probe", purpose: "run the probe", completion_criteria: "the probe's deliverable" };
const FINDINGS = { outcome: "the parser probe separates the targets" };
const POSE = { title: "add a parser", probe: "write a parser for the config format", completion_criteria: "the parser handles every sample", rubric: "tests pass, no new dependency" };
/** root が出題し、監査の受理で立った受験者の id を返す。 */
const pose = async (rootId: string) => (await poseThroughAudit(t, rootId, POSE)) as [string, ...string[]];

/** 既定 agent(scripted worker の id)を anthropic の advisor つき entry 1つで持つ盤面。上限は fable、学習器は既定で昇格済み。 */
let workspacePath: string;
/** 既定 agent の定義。テストが entry を差し替えて、登録の後に走れなくなった盤面を作れる。 */
let definition: { provider: Array<{ name: string; advisor: boolean }>; tier: undefined };
async function boot({
  promoted = true,
  watchdog,
  workspace,
  resolveWorkspace,
  workspaceAdmin,
}: { promoted?: boolean; watchdog?: WatchdogConfig; workspace?: WorkspaceConfig; resolveWorkspace?: BootOptions["resolveWorkspace"]; workspaceAdmin?: BootOptions["workspaceAdmin"] } = {}): Promise<Tidepool> {
  workspace ??= await makeWorkspace("reef");
  workspacePath = workspace.path;
  definition = { provider: [{ name: "anthropic", advisor: true }], tier: undefined };
  const board: Tidepool = await bootTidepool({
    workspace,
    agentAdmin: { list: () => [{ name: "fake-worker", provider: "anthropic" } as AgentView] },
    taskExecutionCandidates: (task) => executionSettingsFor(board.db, definition, task),
    watchdog,
    resolveWorkspace,
    workspaceAdmin,
  });
  applyExecutionSettingsChange(board.db, { setting: "advisor_ceiling", value: "fable" }, "webui", board.clock.now());
  if (promoted) applyExecutionSettingsChange(board.db, { setting: "learner_promoted", value: true }, "webui", board.clock.now());
  return board;
}

it("登録の扉(WebUI の Register API・管理MCP)は interview を新しい欄で受け、扉の拒否をそれぞれの失敗(400・tool error)に写す —— 拒否の種類は interview.test.ts の domain 層(ADR 0273 決定9 / ADR 0107 決定3)", async () => {
  const workspace = await makeWorkspace("reef");
  t = await boot({
    workspace,
    resolveWorkspace: (name) => {
      if (name !== null && name !== workspace.name) throw new UnknownWorkspaceError(name);
      return workspace;
    },
  });
  const evidence = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
  const fields = { ...INTERVIEW, measured_work: "a config parser", evidence_task_ids: [evidence.id], review_tier: "frontier", interview_targets: [opus46] };
  // registry に無い実環境の拒否は人間の扉(registerThroughHumanDoor)が持つ —— interview でこれを釘にするのはここだけ
  const unknown = { ...fields, workspace: "nowhere" };
  const refused = await api(t.baseUrl, "POST", "/api/tasks", unknown);
  expect(refused.status).toBe(400);
  expect(refused.json.error).toBe("unknown workspace: nowhere");
  const client = await managementMcpClient(t.baseUrl);
  try {
    const refusedMcp: any = await client.callTool({ name: "register_task", arguments: unknown });
    expect(refusedMcp.isError).toBe(true);
    expect(JSON.parse(refusedMcp.content[0].text).error).toBe("unknown workspace: nowhere");
    const root = await api(t.baseUrl, "POST", "/api/tasks", fields);
    expect(root.status).toBe(201);
    expect(root.json).toMatchObject({ type: "interview", title: INTERVIEW.title, tier: "frontier", review_tier: "frontier" });
    expect((await client.callTool({ name: "register_task", arguments: fields })).isError).toBeFalsy();
  } finally {
    await client.close();
  }
});

it("worker の MCP からは interview を登録できない —— 分解の子は type も Interview の欄も持たず、名指しても work の子になる(ADR 0273 決定2 / ADR 0021)", async () => {
  t = await boot();
  const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
  const child = { ...CHILD, type: "interview", hypothesis: "h", tier: "frontier", interview_targets: [opus46] };
  expect((await callAsTask(t, work.id, "decompose", { reason: "measure", children: [child] })).isError).toBeFalsy();
  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.filter((task: any) => task.parent_id === work.id).map((task: any) => task.type)).toEqual(["work"]);
  expect(board.map((task: any) => task.type)).not.toContain("interview");
});

it("既定 agent が走らせられない対象(entry に無い Provider・導出できない advisor)は、登録の扉(Register API・管理MCP)と出題が名指して拒み、出題の拒否は escalate を指す(ADR 0253 決定3)", async () => {
  t = await boot();
  const ghost = { provider: "anthropic", model: "claude-ghost-1-0", effort: "high" };
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

/** その task の worker MCP の tools/list の名前。 */
async function tools(taskId: string) {
  const client = await mcpClient(t.mcpBaseUrl, taskId);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

/** interview の root の verb の一覧(ADR 0273 決定2・9)。 */
const ROOT_VERBS = [
  "get_current_task", "pose_probe", "report_broken_probe", "complete_interview", "escalate", "log_decision",
  "record_knowledge", "define_memory_branch", "browse_memory", "search_memory", "read_memory",
  "list_routing_shadow", "list_allocations", "list_precedents",
];

it("worker MCP の tool 一覧は type で決まる —— interview の root は出題の前後で同じ一覧を持ち、根拠があれば根拠の history の読み口を足す。受験者は分解の verb と記憶を書く verb を持たず、普通の work はどの Interview の verb も持たない(ADR 0273 決定2・9 / ADR 0268 決定2)", async () => {
  t = await boot();
  const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const withEvidence = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, evidence_task_ids: [work.id], interview_targets: [opus46] })).json;
  const ordinary = await tools(work.id);
  expect(ordinary).toEqual(expect.arrayContaining(["decompose", "redecompose", "complete_task"]));
  for (const verb of [...ROOT_VERBS.filter((verb) => !ordinary.includes(verb)), "read_evidence_history"]) expect(ordinary).not.toContain(verb);
  expect((await tools(root.id)).sort()).toEqual([...ROOT_VERBS].sort());
  expect((await tools(withEvidence.id)).sort()).toEqual([...ROOT_VERBS, "read_evidence_history"].sort());
  // 出題の後に監査より先に拾われないように退かせる(setup)
  expect((await api(t.baseUrl, "POST", `/api/tasks/${withEvidence.id}/cancel`, {})).status).toBe(200);
  // 出題の前に対象の一覧を読める(#1924 User Story 3)
  await runNow(t, root.id);
  expect(JSON.parse((await callAsTask(t, root.id, "get_current_task", {})).content[0].text).interview_targets).toEqual([opus46]);
  const [childId] = await pose(root.id);
  expect((await tools(root.id)).sort()).toEqual([...ROOT_VERBS].sort());
  const unsplit = ordinary.filter((name) => name !== "decompose" && name !== "redecompose");
  expect(await tools(childId)).toEqual(unsplit.filter((name) => name !== "record_knowledge" && name !== "define_memory_branch"));
});

it("root の get_current_task は仮説・測る仕事・根拠の id・測る段の名前と説明・実環境の許可ドメインを構造で載せる(ADR 0273 決定9)", async () => {
  const workspace = { ...(await makeWorkspace("reef")), allowed_domains: ["registry.npmjs.org"], review_allowed_commands: ["npm test"] };
  t = await boot({ workspace });
  const evidence = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, measured_work: "a config parser", evidence_task_ids: [evidence.id], interview_targets: [opus46] })).json;
  await runNow(t, root.id);
  const { interview } = JSON.parse((await callAsTask(t, root.id, "get_current_task", {})).content[0].text);
  expect(interview).toEqual({
    hypothesis: INTERVIEW.hypothesis,
    measured_work: "a config parser",
    evidence_task_ids: [evidence.id],
    measured_tier: { name: "frontier", description: expect.any(String) },
    real_environment: realpathSync(workspace.path),
    allowed_domains: ["registry.npmjs.org"],
  });
});

it("管理 MCP の register_task に空の測る仕事を渡すと、root の get_current_task の interview に測る仕事が載らない(ADR 0273 決定9)", async () => {
  t = await boot();
  const client = await managementMcpClient(t.baseUrl);
  try {
    expect((await client.callTool({ name: "register_task", arguments: { ...INTERVIEW, measured_work: "", interview_targets: [opus46] } })).isError).toBeFalsy();
  } finally {
    await client.close();
  }
  const [root] = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  await runNow(t, root.id);
  const { interview } = JSON.parse((await callAsTask(t, root.id, "get_current_task", {})).content[0].text);
  expect(interview).not.toHaveProperty("measured_work");
});

it("根拠の history の読み口は根拠の task の判断・完了の handoff・配分評価を history の行で返し、根拠でない task は拒む(ADR 0273 決定9)", async () => {
  t = await boot();
  const evidence = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
  const other = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
  await runNow(t, evidence.id);
  await callAsTask(t, evidence.id, "log_decision", { line: "chose a hand-written lexer" });
  commitWork(workspacePath, "lexer.txt", "lexer\n");
  await callAsTask(t, evidence.id, "complete_task", { handoff: FULL_HANDOFF });
  // 根拠の task には子(完了時レビュー)が立つ —— その行が返らないことを下で言う
  const review = (await api(t.baseUrl, "GET", "/api/tasks")).json.find((task: any) => task.parent_id === evidence.id);
  expect(review.type).toBe("review");
  const allocation = { kind: "allocation_reviewed", review_task_id: other.id, worker_spawned_event_id: 1, judge: { provider: "anthropic", model: "claude-opus-4-6", effort: "high" }, allocation: "overpowered", cause: "capability", evidence: "a cheaper row would do" } as const;
  appendEvent(t.db, { taskId: evidence.id, workerId: "tidepool", origin: "board", at: t.clock.now(), payload: allocation as never });
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, evidence_task_ids: [evidence.id], interview_targets: [opus46] })).json;
  await runNow(t, root.id);

  const read: any = await callAsTask(t, root.id, "read_evidence_history", { task_id: evidence.id });
  expect(read.isError).toBeFalsy();
  // 根拠の task 自身の行だけ —— 完了時レビュー(子)の行は返さない
  expect(JSON.parse(read.content[0].text).history).toEqual([
    { decision: "chose a hand-written lexer" },
    { completion: FULL_HANDOFF.outcome, handoff_doc: expect.stringContaining(FULL_HANDOFF.outcome) },
    { allocation_review: { allocation: "overpowered", cause: "capability", evidence: "a cheaper row would do" } },
  ]);
  const refused: any = await callAsTask(t, root.id, "read_evidence_history", { task_id: other.id });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toContain(`${other.id} is not an evidence task of this Interview`);
});

/** root の面接室: 盤面の規約の基点(harness の既定は盤面の dir の下の workspaces)の下の root の id、実体の綴り。 */
const roomOf = (rootId: string) => realpathSync(join(t.dir, "workspaces", rootId));
/** 受験者の checkout: 同じ基点の下の受験者の id、実体の綴り(ADR 0276 決定1)。 */
const examineeCheckoutOf = (examineeId: string) => realpathSync(join(t.dir, "workspaces", examineeId));

it("root の pickup は面接室を盤面の規約の基点の下に root の id で作って root をそこで走らせ、受験者は同じ基点の下の自分の id の checkout で走る —— 実環境に受験者のブランチは立たず、受験者の workspace 列は実環境の名前で、受験者の詳細は checkout の在り処を運び、決着した後の実環境の削除の門は残った面接室を数えない(ADR 0273 決定1・8 / ADR 0276 決定1・4)", async () => {
  const deletions: WorkspaceDeletionReferences[] = [];
  t = await boot({ workspaceAdmin: { delete: async (_input, references) => (deletions.push(references), "/checkout") } });
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const room = roomOf(root.id);

  const opened = (await api(t.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json.filter((e: any) => e.kind === "interview_room_opened");
  expect(opened.map((e: any) => e.payload.path)).toEqual([room]);
  expect(git(room, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${root.id}`);
  const [childId] = await pose(root.id);
  await completeMetaReviews(t);

  // checkout の中身(出題の head から分岐し、面接室にブランチを立てない)は interview-pin-branch.test.ts の domain 層で言う
  expect(t.worker.started.at(-1)!.id).toBe(childId);
  expect(git(workspacePath, "branch", "--list", `task/${root.id}`, `task/${childId}`)).toBe("");
  const detail = (await api(t.baseUrl, "GET", `/api/tasks/${childId}`)).json;
  expect(detail.workspace).toBe("reef");
  expect(detail.examinee_checkout).toBe(examineeCheckoutOf(childId));

  expect((await api(t.baseUrl, "POST", `/api/tasks/${root.id}/cancel`, {})).status).toBe(200);
  expect((await api(t.baseUrl, "DELETE", "/api/workspaces/reef", { confirm: true })).status).toBe(200);
  expect(deletions.map((references) => references.unsettledTaskCount)).toEqual([0]);
  expect(existsSync(join(room, ".git"))).toBe(true);
});

it("root の pickup は読む実環境を remote へ追従させる —— origin の main が進んでいれば実環境の origin/main と作業ツリーが進み、実環境に root のブランチは立たない(issue #2223 / ADR 0052 決定1・2)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("reef");
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  t = await boot({ workspace });

  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;

  expect(t.worker.started.at(-1)!.id).toBe(root.id);
  expect(git(workspace.path, "rev-parse", "refs/remotes/origin/main")).toBe(git(workspace.repo!, "rev-parse", "main"));
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(git(workspace.path, "rev-parse", "refs/remotes/origin/main"));
  expect(existsSync(join(workspace.path, "merged.txt"))).toBe(true);
  expect(git(workspace.path, "branch", "--list", `task/${root.id}`)).toBe("");
});

it("root の envelope は実環境の在り処を持ち、retry の新しい root は旧い面接室の在り処を retry_of で、根拠が Interview の root ならその面接室の在り処を根拠の読み口で受ける —— 面接室は root の決着後も残る(ADR 0273 決定1・9)", async () => {
  t = await boot();
  const first = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  await pose(first.id);
  const measured = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, evidence_task_ids: [first.id], interview_targets: [opus46] })).json;
  // 受験者が決着すると戻る first より先に拾わせる
  await api(t.baseUrl, "POST", `/api/tasks/${measured.id}/move`, { after: null });
  await runNow(t, measured.id);

  const read = JSON.parse((await callAsTask(t, measured.id, "read_evidence_history", { task_id: first.id })).content[0].text);
  expect(read.interview_room).toBe(roomOf(first.id));
  expect(JSON.parse((await callAsTask(t, measured.id, "get_current_task", {})).content[0].text).interview.real_environment).toBe(realpathSync(workspacePath));

  const retried = (await api(t.baseUrl, "POST", `/api/tasks/${first.id}/retry`, {})).json;
  await api(t.baseUrl, "POST", `/api/tasks/${retried.id}/move`, { after: null });
  expect((await callAsTask(t, measured.id, "pose_probe", POSE)).isError).toBeFalsy();
  t.worker.exit(measured.id);
  await runNow(t, retried.id);
  expect(t.worker.started.at(-1)!.id).toBe(retried.id);
  const current = JSON.parse((await callAsTask(t, retried.id, "get_current_task", {})).content[0].text);
  expect(current.history).toContainEqual({ retry_of: expect.objectContaining({ previous_root_id: first.id, interview_room: roomOf(first.id) }) });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${first.id}`)).json.status).toBe("cancelled");
  expect(existsSync(join(roomOf(first.id), ".git"))).toBe(true);
});

/** キューの読み口でのその task の status(skipped = 資源の停止で外れている)。 */
const queueStatus = async (taskId: string) => (await api(t.baseUrl, "GET", "/api/queue")).json.tasks.find((task: any) => task.id === taskId).status;

it("資源の停止は走る場所の単位 —— 実環境の quarantine と (Harness, 実環境) の封じ込めの組は interview の root の pickup を止めるが受験者を止めず、面接室の quarantine は受験者を止める(ADR 0273 決定8)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46, sonnet55] })).json;
  // 監査は実環境で走るので、実環境の停止は受験者が立ってから
  const [first, second] = await pose(root.id);
  registerQuarantine(t.db, "workspace", "reef", "the real environment broke", t.clock.now());
  registerQuarantine(t.db, "workspaceContainment", workspaceContainmentValue("claude-code", "reef"), "its settings widen the floor", t.clock.now());
  // 監査の pickup が立てた meta-review を終えて枠を空ける
  await completeMetaReviews(t);

  expect(t.worker.started.at(-1)!.id).toBe(first);
  const waiting = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  expect(t.worker.started.map((task) => task.id)).not.toContain(waiting.id);
  expect(await queueStatus(waiting.id)).toBe("skipped");
  expect(await queueStatus(second!)).toBe("todo");
  registerQuarantine(t.db, "workspace", root.id, "the interview room broke", t.clock.now());
  expect(await queueStatus(second!)).toBe("skipped");
});

it("root の pickup で読む実環境の refresh が落ちると実環境の quarantine に落ち、root は failure question 無しに todo の先頭へ戻り、受験者の pickup は止まらない(issue #2223 / ADR 0273 決定8 / ADR 0274 決定1)", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("reef");
  t = await boot({ workspace });
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46, sonnet55] })).json;
  // 監査は実環境で走るので、実環境を壊すのは受験者が立ってから
  const [first, second] = await pose(root.id);
  await completeMetaReviews(t);
  expect(t.worker.started.at(-1)!.id).toBe(first);
  git(workspace.path, "remote", "set-url", "origin", "/nonexistent/workspace-remote");
  const waiting = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  await api(t.baseUrl, "POST", `/api/tasks/${waiting.id}/move`, { after: null });

  expect((await callAsTask(t, first, "complete_task", { handoff: FULL_HANDOFF })).isError).toBeFalsy();
  t.worker.exit(first);

  await vi.waitFor(() => expect(t.worker.started.at(-1)?.id).toBe(second));
  expect(t.worker.started.map((s) => s.id)).not.toContain(waiting.id);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${waiting.id}`)).json.status).toBe("todo");
  expect((await api(t.baseUrl, "GET", `/api/tasks/${waiting.id}/events`)).json.filter((e: any) => e.kind === "pickup_stopped").map((e: any) => e.payload)).toEqual([
    { kind: "pickup_stopped", quarantine: "workspace", value: "reef", reason: expect.stringContaining("/nonexistent/workspace-remote") },
  ]);
  expect((await questions(t)).filter((q) => q.status !== "done" && q.parent_id === waiting.id)).toEqual([]);
});

it("監査の pickup は読む面接室を remote へ追従させない —— 面接室の quarantine は監査の pickup の門に掛からず、落とすと同じ監査を毎回拾い直す(issue #2223)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  // 面接室が remote を持つと宣言との突き合わせが落ちる —— 監査の pickup がそこへ当たれば面接室の quarantine が立つ
  const examinees = await poseThroughAudit(t, root.id, POSE, async (taskId) => {
    t.worker.exit(taskId);
    if (taskId === root.id) git(roomOf(root.id), "remote", "add", "origin", "/nonexistent/room-remote");
  });

  expect(examinees).toHaveLength(1);
  expect((await questions(t)).filter((q) => q.status !== "done" && q.question_quarantine_kind === "workspace")).toEqual([]);
});

it.each([
  ["registry の盤面(面接室の名前を知らない resolver)", true],
  ["registry の無い盤面(どの名前にも既定の workspace を返す resolver)", false],
])("面接室の quarantine の回答は、%sでも実環境ではなく root の面接室を検査して受理する(ADR 0273 決定8)", async (_board, registry) => {
  const workspace = await makeWorkspace("reef");
  const resolveWorkspace = (name: string | null) => {
    if (name !== null && name !== workspace.name) throw new UnknownWorkspaceError(name);
    return workspace;
  };
  t = await boot({ workspace, ...(registry && { resolveWorkspace }) });
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  registerQuarantine(t.db, "workspace", root.id, "the interview room broke", t.clock.now());
  const question = await servedQuarantineQuestion(t, "workspace", root.id);
  const stray = join(roomOf(root.id), "stray.txt");
  writeFileSync(stray, "left behind\n");

  const refused = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain(`workspace ${root.id} still has uncommitted changes`);
  rmSync(stray);
  expect((await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);
});

it("面接室が作れなかった pickup は面接室の quarantine に落ち、root は failure question 無しに後始末を通って todo の先頭へ戻り、人間の回答で quarantine が解けると、次の pickup が残った面接室の続きから作って root を走らせる(ADR 0273 決定1・8 / ADR 0274 決定1)", async () => {
  t = await boot();
  failGitCommits();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  vi.unstubAllEnvs();
  expect((await servedQuarantineQuestion(t, "workspace", root.id)).purpose).toContain("/nonexistent-gpg");
  await vi.waitFor(async () => expect((await api(t.baseUrl, "GET", `/api/tasks/${root.id}`)).json.status).toBe("todo"));
  // slot が空いて盤面は流れ続ける(ADR 0274 決定1)—— root は面接室の quarantine が外し、走ったのは他の task だけ
  expect(t.worker.started.map((s) => s.id)).not.toContain(root.id);

  const open = (await questions(t)).filter((q) => q.status !== "done");
  expect(open.map((q) => q.question_quarantine_kind)).not.toContain("failedTeardown");
  expect(open.filter((q) => q.type === "question" && q.parent_id === root.id)).toEqual([]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${root.id}/events`)).json.filter((e: any) => e.kind === "pickup_stopped").map((e: any) => e.payload)).toEqual([
    { kind: "pickup_stopped", quarantine: "workspace", value: root.id, reason: expect.stringContaining("/nonexistent-gpg") },
  ]);
  const quarantine = await servedQuarantineQuestion(t, "workspace", root.id);
  expect((await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);
  await completeMetaReviews(t);

  await vi.waitFor(() => expect(t.worker.started.at(-1)?.id).toBe(root.id));
  expect(git(roomOf(root.id), "log", "--format=%s", "main")).toBe("Initial commit");
  expect(git(roomOf(root.id), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${root.id}`);
});

it("受験者の checkout が作れなかった pickup は面接室(root id)の quarantine に落ち、受験者は failure question 無しに後始末を通って todo の先頭へ戻り、人間の回答で quarantine が解けると、次の pickup が checkout を作り直して走らせる(ADR 0276 決定3 / ADR 0274 決定1)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46, sonnet55] })).json;
  const [first, second] = await pose(root.id);
  await completeMetaReviews(t);
  expect(t.worker.started.at(-1)!.id).toBe(first);
  // 2人目の在り処に repo として読めない .git を置く —— init が落ちる
  const blocker = join(t.dir, "workspaces", second!, ".git");
  mkdirSync(dirname(blocker), { recursive: true });
  writeFileSync(blocker, "not a git dir\n");
  expect((await callAsTask(t, first, "complete_task", { handoff: FULL_HANDOFF })).isError).toBeFalsy();
  t.worker.exit(first);

  await vi.waitFor(async () => expect((await api(t.baseUrl, "GET", `/api/tasks/${second}/events`)).json.some((e: any) => e.kind === "pickup_stopped")).toBe(true));
  // 先頭への復帰と pickup_stopped は1つの transaction(ADR 0274 決定3)
  expect((await api(t.baseUrl, "GET", `/api/tasks/${second}`)).json.status).toBe("todo");
  expect(t.worker.started.map((s) => s.id)).not.toContain(second);
  const open = (await questions(t)).filter((q) => q.status !== "done");
  expect(open.map((q) => q.question_quarantine_kind)).not.toContain("failedTeardown");
  expect(open.filter((q) => q.type === "question" && q.parent_id === second)).toEqual([]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${second}/events`)).json.filter((e: any) => e.kind === "pickup_stopped").map((e: any) => e.payload)).toEqual([
    { kind: "pickup_stopped", quarantine: "workspace", value: root.id, reason: expect.stringContaining(".git") },
  ]);

  rmSync(blocker);
  const quarantine = await servedQuarantineQuestion(t, "workspace", root.id);
  expect((await api(t.baseUrl, "POST", `/api/tasks/${quarantine.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);
  await runNow(t, second!);

  expect(t.worker.started.at(-1)!.id).toBe(second);
  expect(git(examineeCheckoutOf(second!), "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${second}`);
});

it("受験者の (Harness, 場所) の封じ込めの組は面接室で立つ(ADR 0273 決定8 / ADR 0259 決定1)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46, sonnet55] })).json;
  const [first, second] = await pose(root.id);
  await completeMetaReviews(t);
  expect(t.worker.started.at(-1)!.id).toBe(first);
  expect(await queueStatus(second!)).toBe("todo");

  registerQuarantine(t.db, "workspaceContainment", workspaceContainmentValue("claude-code", root.id), "the room's settings widen the floor", t.clock.now());

  expect(await queueStatus(second!)).toBe("skipped");
});

/** 出題が残したもの: 出題の event と受験者。 */
async function posedRecord(rootId: string) {
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${rootId}/events`)).json.filter((e: any) => e.payload.interview_probe);
  const examinees = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.interview_root_id === rootId);
  return { events, examinees };
}

it("root の workspace が registry から消えた(registry drift)まま出題すると、head を記録できないので拒まれ escalate を指し、出題の event も受験者も残らず、session は続き、workspace の quarantine が立つ(ADR 0263 追記5)", async () => {
  const workspace = await makeWorkspace("reef");
  let drifted = false;
  t = await boot({
    workspace,
    resolveWorkspace: (name) => {
      if (drifted) throw new UnknownWorkspaceError(name ?? workspace.name);
      return workspace;
    },
  });
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  expect(t.worker.started.at(-1)!.id).toBe(root.id);
  drifted = true;

  const posed: any = await callAsTask(t, root.id, "pose_probe", POSE);

  expect(posed.isError).toBe(true);
  expect(posed.content[0].text).toContain("workspace cannot be resolved");
  expect(posed.content[0].text).toContain("escalate");
  expect(await posedRecord(root.id)).toEqual({ events: [], examinees: [] });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${root.id}`)).json.status).toBe("in_progress");
  expect((await callAsTask(t, root.id, "get_current_task", {})).isError).toBeFalsy();
  expect(await servedQuarantineQuestion(t, "workspace", workspace.name)).toBeDefined();
});

/** 監査 review の worker MCP の verb(ADR 0273 決定3・4): review の読み系と complete_audit。 */
const AUDIT_VERBS = ["get_current_task", "log_decision", "escalate", "complete_audit", "browse_memory", "search_memory", "read_memory"];

// 監査の登録・blocked の理由・verb の差し替え・受理 / 却下・cancel の cascade・異議は interview.test.ts の domain 層が言う。ここは写像だけ
it("出題の gate は面接室の写しを head に記録し、立った監査は root と同じ段で拾われ、その tools/list は review の読み系と complete_audit、envelope は head・面接室の在り処・root の構造欄と findings の行き先の1行を運ぶ(ADR 0273 決定3・4・6)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, tier: "standard", interview_targets: [opus46] })).json;
  const rootTier = t.worker.startedSettings.at(-1)!.tier_id;
  const room = roomOf(root.id);
  writeFileSync(join(room, "probe.txt"), "the environment\n");

  const posed: any = await callAsTask(t, root.id, "pose_probe", POSE);

  expect(posed.isError).toBeFalsy();
  const { audit_id: auditId } = JSON.parse(posed.content[0].text);
  const { head } = (await posedRecord(root.id)).events[0].payload;
  expect(git(room, "show", `${head}:probe.txt`)).toBe("the environment");
  await runNow(t, auditId);
  expect(t.worker.started.at(-1)!.id).toBe(auditId);
  expect(t.worker.startedSettings.at(-1)!.tier_id).toBe(rootTier);
  expect(rootTier).toBe(tierIdOf(t.db, "frontier"));
  expect((await tools(auditId)).sort()).toEqual([...AUDIT_VERBS].sort());
  const envelope = JSON.parse((await callAsTask(t, auditId, "get_current_task", {})).content[0].text);
  expect(envelope.interview_audit).toMatchObject({ notice: INTERVIEW_AUDIT_NOTICE, head, interview_room: room, hypothesis: INTERVIEW.hypothesis });
});

it("却下の後の出し直しは出題の gate が新しい写しを commit して新しい head にし、受理された受験者は却下された写しではなく最後の写しから分岐する(ADR 0273 決定3)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const room = roomOf(root.id);
  const { audit_id: first } = JSON.parse((await callAsTask(t, root.id, "pose_probe", POSE)).content[0].text);
  await runNow(t, first);
  expect((await callAsTask(t, first, "complete_audit", { verdict: "rejected", findings: "the tier below solves it" })).isError).toBeFalsy();
  t.worker.exit(first);
  await runNow(t, root.id);
  writeFileSync(join(room, "harder.txt"), "a harder environment\n");

  const reposed: any = await callAsTask(t, root.id, "pose_probe", POSE);

  expect(reposed.isError).toBeFalsy();
  const { audit_id: second } = JSON.parse(reposed.content[0].text);
  const heads = (await posedRecord(root.id)).events.map((event: any) => event.payload.head);
  expect(git(room, "ls-tree", "--name-only", heads[1])).toContain("harder.txt");
  expect(git(room, "ls-tree", "--name-only", heads[0])).not.toContain("harder.txt");
  t.worker.exit(root.id);
  await runNow(t, second);
  expect((await callAsTask(t, second, "complete_audit", { verdict: "accepted", findings: "now it asks for frontier work" })).isError).toBeFalsy();
  t.worker.exit(second);
  const [examinee] = (await posedRecord(root.id)).examinees;
  await runNow(t, examinee.id);
  expect(t.worker.started.at(-1)!.id).toBe(examinee.id);
  expect(git(examineeCheckoutOf(examinee.id), "rev-parse", `task/${examinee.id}`)).toBe(heads[1]);
});

// どの行がグループに入り受験者の行が出ないかは domain 層(tests/interview.test.ts の listLog)が言う。ここは線の上の形だけ
it("ログ API の root の行は Interview のグループを運び、受験者の行への異議 API は 409 に写る(ADR 0268 決定1 / ADR 0273 決定10)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [childId] = await pose(root.id);
  const answer = appendEvent(t.db, { taskId: childId, workerId: "fake-worker", origin: "worker", at: t.clock.now(), payload: { kind: "decision_logged", line: "use a hand-written lexer" } });

  const log = (await api(t.baseUrl, "GET", "/api/log")).json;
  expect(log.entries.find((e: any) => e.task_id === root.id).interview).toEqual({ root_id: root.id, title: POSE.title, workspace: "reef" });
  expect((await api(t.baseUrl, "POST", "/api/triage/objection", { entry_id: answer, comment: "redo it" })).status).toBe(409);
});

it("盤面の行は root と受験者の実環境の名前(workspace)と root の待ちを運び、root の詳細は面接室の在り処と出題の head を運ぶ(ADR 0273 決定3・8 / ADR 0082)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [childId] = await pose(root.id);

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((task: any) => task.id === root.id)).toMatchObject({ workspace: "reef", status: "blocked", interview_waiting: "examinees" });
  expect(board.find((task: any) => task.id === childId)).toMatchObject({ workspace: "reef", interview_root_id: root.id });
  const { head } = (await posedRecord(root.id)).events[0].payload;
  expect((await api(t.baseUrl, "GET", `/api/tasks/${root.id}`)).json).toMatchObject({ interview_room: roomOf(root.id), posed_head: head });
});

it("出題で立った受験者は対象で spawn され、PR も完了時レビューも生まれず、統合復帰した root が伏せた handoff を採点完了で採点して完了する", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [childId] = await pose(root.id);
  // 上限の書き込みが routing meta-review の材料になるので、先に済ませる(setup)
  await completeMetaReviews(t);

  expect(t.worker.started.at(-1)!.id).toBe(childId);
  expect(t.worker.startedSettings.at(-1)).toMatchObject({ model: "claude-opus-4-6", tier_id: tierIdOf(t.db, "frontier"), source: { tier: "interview", provider: "interview" } });
  commitWork(examineeCheckoutOf(childId), "probe.txt", "probe\n");
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

it("採点した対象の段に行を足すと、その行の本番の pickup の shadow 行が Interview の種を運び、受験者の受理は実績に数えない —— list_routing_shadow に出る(ADR 0273 決定7)", async () => {
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
  const scored = (await api(t.baseUrl, "GET", `/api/tasks/${childId}/events`)).json.find((e: any) => e.kind === "interview_scored");
  const row = { setting: "row", row: { ...opus46, tier: "frontier", price_in: 1, price_out: 5 } };
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", row)).status).toBe(200);
  const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD, tier: "frontier" })).json;
  await t.clock.advance(HOUR);

  // 読み手の routing meta-review を置く(周期の待ちは meta-review の機構の話なので setup で立てる)
  registerMetaReview(t.db, "routing", t.clock.now());
  const [review] = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.meta_review_subject === "routing" && task.status !== "done");
  await runNow(t, review.id);
  const { shadow } = JSON.parse((await callAsTask(t, review.id, "list_routing_shadow", { since_watermark: 0 })).content[0].text);
  expect(shadow.find((r: any) => r.task_id === work.id)).toMatchObject({
    actual: { model: "claude-opus-4-6" },
    actual_record: { board: { accepted: 0, rejected: 0 }, workspace: { accepted: 0, rejected: 0 }, seed: { kind: "interview", event_id: scored.id } },
  });
});

it("Interview の種は、置かれた窓の list_routing_cells に行のある段の種として出る —— 受験者の session はセルの初観測に数えない(ADR 0273 決定7)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [childId] = await pose(root.id);
  await completeMetaReviews(t);
  // 受験者の session の記録(scripted worker は刻まない)
  const { advisor, ...setting } = t.worker.startedSettings.at(-1)!;
  const spawned = appendEvent(t.db, { taskId: childId, workerId: "fake-worker", origin: "board", at: t.clock.now(), payload: { ...WORKER_SPAWNED, ...setting, advisor: advisor ?? null } });
  appendEvent(t.db, { taskId: childId, workerId: "fake-worker", origin: "board", at: t.clock.now(), payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: spawned, output_closed: true, usage: null } });
  await callAsTask(t, childId, "complete_task", { handoff: FULL_HANDOFF });
  await t.clock.advance(HOUR);
  await callAsTask(t, root.id, "complete_interview", { scores: [{ child_id: childId, outcome: "accepted" }], handoff: FINDINGS });
  const scored = (await api(t.baseUrl, "GET", `/api/tasks/${childId}/events`)).json.find((e: any) => e.kind === "interview_scored");
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: { ...opus46, tier: "frontier", price_in: 1, price_out: 5 } })).status).toBe(200);

  registerMetaReview(t.db, "routing", t.clock.now());
  const [review] = (await api(t.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.meta_review_subject === "routing" && task.status !== "done");
  await runNow(t, review.id);
  const { cells } = JSON.parse((await callAsTask(t, review.id, "list_routing_cells", {})).content[0].text);
  expect(cells).toEqual([{ cell: { ...opus46, advisor: null }, first_observed_event_id: null, seeds: [{ tier: "frontier", kind: "interview", event_id: scored.id }] }]);
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

it("root の retry の扉(WebUI の API・管理MCP の retry_interview)は新しい root を返し、走れない対象の拒否を回答の拒否の status(409)と isError に写して対象を名指す(ADR 0267 決定4 / ADR 0253 決定3)", async () => {
  t = await boot();
  const first = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [firstChild] = await pose(first.id);
  // 受験者は question を待って枠を空ける —— 受験者の question は root の cancel を止めない(ADR 0267 決定3)
  const escalation = { context: "which format?", questions: [{ title: "which format?", options: ["yaml", "toml"], recommendation: "yaml" }] };
  expect((await callAsTask(t, firstChild, "escalate", escalation)).isError).toBeFalsy();
  t.worker.exit(firstChild);
  const client = await managementMcpClient(t.baseUrl);
  definition.provider = [{ name: "openai", advisor: false }];
  const refused = await api(t.baseUrl, "POST", `/api/tasks/${first.id}/retry`, {});
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain(`${JSON.stringify(opus46)} cannot run as fake-worker`);
  const refusedMcp: any = await client.callTool({ name: "retry_interview", arguments: { task_id: first.id } });
  expect(refusedMcp.isError).toBe(true);
  expect(refusedMcp.content[0].text).toContain(`${JSON.stringify(opus46)} cannot run as fake-worker`);

  definition.provider = [{ name: "anthropic", advisor: true }];
  const viaApi = await api(t.baseUrl, "POST", `/api/tasks/${first.id}/retry`, { comment: "the probe names the answer" });
  expect(viaApi.status).toBe(200);
  expect(viaApi.json.id).not.toBe(first.id);

  // 新しい root を拾わせて出題し、管理MCP から retry する
  await runNow(t, viaApi.json.id);
  await pose(viaApi.json.id);
  const viaMcp: any = await client.callTool({ name: "retry_interview", arguments: { task_id: viaApi.json.id } });
  await client.close();
  expect(viaMcp.isError).toBeFalsy();
  expect(JSON.parse(viaMcp.content[0].text).id).not.toBe(viaApi.json.id);
});

const sonnet55 = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" };
const haiku45 = { provider: "anthropic", model: "claude-haiku-4-5", effort: null };
const SWEEP_POSE = { ...POSE, rubric: "rubric-mark-7f3: the parser rejects a bad sample" };
const SIBLING_ANSWER = "sibling-answer-mark-91c";
const ROOT_MARK = "root-mark-3e9";
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
  await runNow(t, reader);
  expect(t.worker.started.at(-1)!.id).toBe(reader);
}

/** 最後の受験者が読む盤面(ADR 0263 決定10 の sweep の状況、ADR 0267 決定7 で親の場面を外した形): 人間が書いた root の題・目的は
 *  「Interview」と目印を持ち、root は出題以外の目印つきの判断ログの行と question を持つ —— 受験者には親が無いので、どれも見えては
 *  ならない。兄弟の1つは目印つきの handoff で done、1つは「この対象は測らない」で cancel、最後の対象の
 *  受験者は failure を retry で再開し、escalate して答えを受けてから slot に居て、自分の history の長さで get_current_task が続き
 *  (ADR 0195)を持つ。`pulls` はその受験者が記憶の pull verb(browse・search・read)で root が書いた目印つきの Knowledge・
 *  人間が出題の event を出所に書いた目印つきの Exemplar(ADR 0264 決定3)を探した応答。`refusals` はその受験者が記憶を書く verb を
 *  呼んだ拒否で、`unregistered` は本番の親なし work が登録されていない verb(pose_probe)を呼んだ拒否(ADR 0268 決定2)。
 *  `injection` はその受験者の直近の spawn で adapter が組むはずの記憶の
 *  注入の節で、adapter が渡すのと同じ引数(盤面が渡した task と query、task の workspace 名、worker の agent 名)で組む。
 *  `production` は同じ盤面に Register API で登録した本番の親なし work の tools/list。 */
async function lastExaminee() {
  // 時限は見ない watchdog: 報告なき exit を failure question にする口だけを使う(ADR 0145)
  t = await boot({ watchdog: { timeLimits: {}, grace: HOUR } });
  const root = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "interview",
      title: `Interview the parser targets ${ROOT_MARK}`,
      hypothesis: `Interview which target writes the parser ${ROOT_MARK}`,
      tier: "standard",
      interview_targets: [opus46, sonnet55, haiku45],
    })
  ).json;
  await callAsTask(t, root.id, "log_decision", { line: `chose the parser probe over the lexer one ${ROOT_MARK}` });
  const rootKnowledge = { path: "parser", title: `parser ${TREE_MEMORY}`, text: `the parser ${TREE_MEMORY}`, source: { commit: "0a46a46" } };
  const rootEntry = JSON.parse((await callAsTask(t, root.id, "record_knowledge", rootKnowledge)).content[0].text).entry_id;
  const [done, cancelled, reader] = (await poseThroughAudit(t, root.id, SWEEP_POSE)) as [string, string, string];
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
  commitWork(examineeCheckoutOf(done), "probe.txt", "probe\n");
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
      { name: "search_memory", arguments: { query: TREE_MEMORY } },
      { name: "read_memory", arguments: { ids: [rootEntry, exemplar.json.entry_id] } },
    ];
    const pulled = await Promise.all(pulls.map((call) => client.callTool(call)));
    const refusals = [
      await client.callTool({ name: "record_knowledge", arguments: { path: "parser", title: "parser", text: "the parser", source: { commit: "0a46a46" } } }),
      await client.callTool({ name: "define_memory_branch", arguments: { prefix: "parser", definition: "What the parser work files." } }),
    ];
    const spawn = t.worker.started.map((task) => task.id).lastIndexOf(reader);
    const spawned = t.worker.started[spawn]!;
    expect(spawned.workspace).not.toBeNull();
    const injection = buildMemoryInjection(t.db, spawned, spawned.workspace, t.worker.id, t.worker.startedQueries[spawn]).section;
    const work = (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", ...CHILD })).json;
    const productionClient = await mcpClient(t.mcpBaseUrl, work.id);
    let production: Awaited<ReturnType<typeof productionClient.listTools>>["tools"];
    let unregistered: Awaited<ReturnType<typeof productionClient.callTool>>;
    try {
      production = (await productionClient.listTools()).tools;
      unregistered = await productionClient.callTool({ name: "pose_probe", arguments: POSE });
    } finally {
      await productionClient.close();
    }
    return { rootId: root.id, reader, siblings: [done, cancelled], pages, pulls: pulled, refusals, unregistered, injection, tools: (await client.listTools()).tools, production };
  } finally {
    await client.close();
  }
}

it("最後の受験者が読む get_current_task の全ページ・tools/list の全説明文・記憶の pull(browse・search・read)の応答・記憶を書く verb の拒否・記憶の注入の節に、Interview と面接室の語・面接室の在り処・rubric・対象の model 名・兄弟の id・兄弟の答案と記憶の目印・採点者の印・親の欄・親の history の行・登録者の名前が出ず、記憶を書く verb の拒否は本番の未登録の verb と同じ(ADR 0263 決定7・10、ADR 0264 決定6、ADR 0267 決定7、ADR 0268 決定2、ADR 0273 決定1)", async () => {
  const { rootId, siblings, pages, pulls, refusals, unregistered, injection, tools, production } = await lastExaminee();
  expect(pages.length).toBeGreaterThan(1);
  for (const page of pages) expect(page.parent ?? null).toBeNull();
  // 登録者は root の agent —— root の面には出ている名前で、受験者の面に出ないことを確かめる
  expect((await api(t.baseUrl, "GET", `/api/tasks/${rootId}`)).json.assignee).toBe(DEFAULT_INTERVIEWER_NAME);
  for (const pull of pulls) expect(pull.isError).toBeFalsy();
  // tools/list は登録された verb を全部回す —— 新しい verb は自動で検査に入る
  const read = [...pages, ...pulls, ...refusals, injection, ...tools].map((item) => JSON.stringify(item)).join("\n");
  // 面接室の語(英語の面は "interview room" で上の照合に入る)と在り処も出ない(ADR 0273 決定1)
  expect(read).not.toMatch(/interview/i);
  for (const text of [SWEEP_POSE.rubric, opus46.model, sonnet55.model, haiku45.model, SIBLING_ANSWER, TREE_MEMORY, ROOT_MARK, DEFAULT_INTERVIEWER_NAME, "not shown to examinees", "面接室", roomOf(rootId), ".gitignore anything you want the targets", ...siblings]) {
    expect(read).not.toContain(text);
  }
  // 写像: 本番の親なし work の tools/list(名前・説明文・schema)との差は分解の verb と記憶を書く verb だけ(ADR 0267 決定7 /
  // ADR 0268 決定2)。どの verb を外すかは interview.test.ts の taskVerbSwap が言う
  const withheld = ["decompose", "redecompose", "record_knowledge", "define_memory_branch"];
  expect(production.map((tool) => tool.name)).toEqual(expect.arrayContaining(withheld));
  expect(tools).toEqual(production.filter((tool) => !withheld.includes(tool.name)));
  // 外した verb の拒否は、本番の work が登録されていない verb を呼んだ拒否と verb の名前のほかは同じ
  for (const [refusal, verb] of [[refusals[0], "record_knowledge"], [refusals[1], "define_memory_branch"]] as const) {
    expect(JSON.parse(JSON.stringify(refusal).replaceAll(verb, "pose_probe"))).toEqual(unregistered);
  }
});

it("受験者の詳細と盤面の一覧の行は、その Interview の root の id を名指す(ADR 0267 決定6)", async () => {
  t = await boot();
  const root = (await api(t.baseUrl, "POST", "/api/tasks", { ...INTERVIEW, interview_targets: [opus46] })).json;
  const [examinee] = await pose(root.id);
  // 行の中身(どの受験者がどの root を名指すか)は interview.test.ts の domain 層で言う。ここは詳細の wire に欄が載る写像だけ
  expect((await api(t.baseUrl, "GET", `/api/tasks/${examinee}`)).json.interview_root_id).toBe(root.id);
});
