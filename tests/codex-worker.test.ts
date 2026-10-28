import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { boardDoctrine, fenced } from "../src/board-prose.js";
import type { CodexAppServerProbe } from "../src/codex-app-server.js";
import { CODEX_FEATURE_SNAPSHOT, CodexWorker, type CodexWorkerOptions, listedSkillPaths, resolveCodexExecutable } from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import { appendEvent, type EventPayload, listEvents } from "../src/events.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import { buildMemoryInjection, buildMetaReviewMaterial, humanEntryInput, type InjectionQuery, recordBehavior, recordKnowledge } from "../src/memory.js";
import { registerMetaReview } from "../src/meta-review.js";
import { EXTRACTOR_VERSION, listEpisodes, projectionPending } from "../src/precedent.js";
import { type ContainerSpawn, ProcessContainers } from "../src/process-container.js";
import { openQuarantineValues } from "../src/quarantine.js";
import { loadRegistry, REVIEWER_AUTHORITY_PROFILE } from "../src/registry.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, examineeCheckoutPath, getTask, interviewRoomPath, listBoard, listChildren, logDecision, pickupTask, poseProbe, registerTask, retryInterviewRoot, type Task } from "../src/tasks.js";
import { getProviderUsage } from "../src/throttle.js";
import { TranscriptStore } from "../src/transcript-store.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { RECLAIM_TIMEOUT, startWatchdog } from "../src/watchdog.js";
import type { WorkerExit } from "../src/worker.js";
import {
  answerSkillsList,
  codexSkillsListAt,
  definitionPart,
  driveCodexPreflight,
  FakeClock,
  FakeContainerRuntime,
  fakeAppServerCall,
  passthroughContainers,
  recordingSpawn,
  recordPrompt,
} from "./fakes.js";
import {
  bootTidepool,
  decomposeTaskViaWorker,
  examineeRootId,
  FULL_HANDOFF,
  HUMAN_WEBUI,
  judgmentRepairTask,
  markPickedUp,
  mcpClient,
  openTestExamineeCheckout,
  openTestInterviewRoom,
  POSED_HEAD,
  poseAccepted,
  quarantineQuestion,
  routingJudgmentRepairTask,
  type Tidepool,
  WORKER_SPAWNED,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

const CLI_VERSION = "codex-cli 0.147.0";

let t: Tidepool;
afterEach(() => t?.stop());

function task(db: ReturnType<typeof openDb>, title = "codex-task") {
  return registerTask(db, {
    type: "work",
    assignee: "codex-agent",
    workspace: "work",
    title,
    purpose: "keep the board correct",
    completion_criteria: "the focused tests pass",
  }, new Date("2026-08-24T00:00:00.000Z"), ...HUMAN_WEBUI);
}

/** meta-review task —— enabled_tools と盤面の tool 一覧は meta-review の主題でだけ形が変わる(ADR 0122 決定2)。 */
function metaReviewTask(db: ReturnType<typeof openDb>, subject: "memory" | "routing" = "memory") {
  return registerTask(db, {
    type: "review",
    assignee: "codex-agent",
    title: `${subject} meta-review`,
    purpose: `keep the ${subject} correct`,
    completion_criteria: "it is reviewed",
    meta_review_subject: subject,
  }, new Date("2026-08-24T00:00:00.000Z"), ...HUMAN_WEBUI);
}

/** Interview の root(openai の対象1つ)と、出題で立った pin の子 —— verb の差し替えと doctrine はこの2つでだけ形が変わる(ADR 0245 / ADR 0253)。 */
const SOL = { provider: "openai", model: "gpt-5.6-sol", effort: "high" };
function interviewRoot(db: ReturnType<typeof openDb>) {
  const root = registerTask(db, {
    type: "interview",
    assignee: "codex-agent",
    title: "interview",
    hypothesis: "the target writes the parser",
    tier: "standard",
    interview_targets: [SOL],
  }, new Date("2026-08-24T00:00:00.000Z"), ...HUMAN_WEBUI);
  // root は面接室で走る(ADR 0273 決定1)—— pickup の代わりに開く
  openTestInterviewRoom(db, root);
  return root;
}
function pinnedChild(db: ReturnType<typeof openDb>) {
  const probe = { title: "probe", probe: "run the probe", completion_criteria: "the probe's deliverable", rubric: "it runs" };
  const child = poseAccepted(db, interviewRoot(db), probe, "auditor", new Date("2026-08-24T00:00:00.000Z"), "worker", POSED_HEAD)[0]!;
  // 受験者は自分の checkout で走る(ADR 0276 決定1)—— pickup の代わりに開く
  openTestExamineeCheckout(db, child);
  return child;
}
const posedInterviewRoot = (db: ReturnType<typeof openDb>) => getTask(db, examineeRootId(db, pinnedChild(db).id))!;

/** 記憶の書き込みの行への異議の修理 task(memory_repair)—— 記憶の修理 verb はこの type にだけ足される(ADR 0252 決定4 / ADR 0272 決定3)。 */
function writeRepairTask(db: ReturnType<typeof openDb>) {
  const at = new Date("2026-08-24T00:00:00.000Z");
  const objected = task(db, "wrote a note");
  const author = { activity: "worker_verb" as const, name: "codex-agent" };
  const { event_id } = recordKnowledge(db, { scope: "work", path: "build", title: "t", text: "x.", source: { commit: "0a46a46" }, author }, "worker", at, objected.id);
  raiseObjection(db, event_id, "undo it", at);
  commitTriage(db, at);
  // 束ねが立てた memory_repair(assignee は異議された task の列 codex-agent を写す)
  return listChildren(db, objected.id).find((child) => child.type === "memory_repair")!;
}

/** routing meta-review の判断の行への異議の修理 task(routing_repair、ADR 0279 決定4)。束ねは後続の ticket なので、束ねと同じ人間の名義で立てる。 */
function routingRepairTask(db: ReturnType<typeof openDb>) {
  const at = new Date("2026-08-24T00:00:00.000Z");
  const objected = task(db, "judged the routing table");
  return registerTask(db, { type: "routing_repair", assignee: "codex-agent", workspace: "work", title: "routing repair", purpose: "p", completion_criteria: "c", parent_id: objected.id }, at, ...HUMAN_WEBUI);
}

/** 祖先の cancel の下の RCA(self)—— 成果が捨てられた task は分解の verb を伏せる(ADR 0271 決定2)。 */
function discardedRca(db: ReturnType<typeof openDb>) {
  const at = new Date("2026-08-24T00:00:00.000Z");
  const root = task(db, "discarded root");
  const [child] = decomposeTaskViaWorker(db, root, { reason: "split", children: [{ title: "c", purpose: "p", completion_criteria: "c" }] }, "codex-agent", at);
  const entry = logDecision(db, child!, "codex-agent's call", "codex-agent", at, "worker");
  completeTask(db, child!, FULL_HANDOFF, "codex-agent", at, "worker");
  startTriage(db, at);
  raiseObjection(db, entry, "redo it", at);
  commitTriage(db, at);
  cancelTaskDirectly(db, getTask(db, root.id)!, null, at, {}, "webui");
  return listChildren(db, child!.id).find((c) => c.title.startsWith("rca (self)"))!;
}

/** 異議の commit が立てた RCA(self は異議された行の書き手 codex-agent、auditor は Auditor の pointer)—— complete_task の代わりに
 *  complete_rca を持つ(ADR 0278 決定1)。異議された task が meta-review なら行の主題を持つ RCA(ADR 0283 追記1)。 */
function rca(kind: "self" | "auditor", objectedTask: (db: ReturnType<typeof openDb>) => Task = (db) => task(db, `objected for ${kind}`)) {
  return (db: ReturnType<typeof openDb>) => {
    const at = new Date("2026-08-24T00:00:00.000Z");
    const objected = objectedTask(db);
    const entry = logDecision(db, objected, "codex-agent's call", "codex-agent", at, "worker");
    startTriage(db, at);
    raiseObjection(db, entry, "redo it", at);
    commitTriage(db, at);
    return listChildren(db, objected.id).find((c) => c.title.startsWith(`rca (${kind})`))!;
  };
}

/** 完了時に盤面が立てた統合レビュー(review_by で codex-agent が担う)—— complete_task の代わりに complete_integration_review を持つ(ADR 0278 決定1)。 */
function integrationReview(db: ReturnType<typeof openDb>) {
  const work = registerTask(db, { type: "work", assignee: "codex-agent", workspace: "work", title: "reviewed", purpose: "p", completion_criteria: "c", review_by: ["codex-agent"] }, new Date("2026-08-24T00:00:00.000Z"), ...HUMAN_WEBUI);
  completeTask(db, work, FULL_HANDOFF, "codex-agent", new Date("2026-08-24T00:00:00.000Z"), "worker");
  return listChildren(db, work.id).find((child) => child.type === "review")!;
}

/** `-c <prefix>…` の引数をそのまま返す。 */
const configEntry = (args: string[], prefix: string) => args.find((arg, i) => args[i - 1] === "-c" && arg.startsWith(prefix))!;

/** `-c <prefix><値>` を読む。値は toml() = JSON.stringify なので JSON.parse で戻す。 */
function configValue<T>(args: string[], prefix: string): T {
  return JSON.parse(configEntry(args, prefix).slice(prefix.length)) as T;
}

/** `-c permissions.<name>.filesystem=` の値(TOML の inline table のまま)。 */
const filesystem = (args: string[], name: string) => configEntry(args, `permissions.${name}.filesystem=`);

/** `-c skills.config=` の引数(ADR 0259 決定2)。 */
const skills = (args: readonly string[]) => configEntry([...args], "skills.config=");

/** `skills.config` で閉じた path。 */
const closedPaths = (args: readonly string[]) =>
  new Set([...skills(args).matchAll(/path=("(?:[^"\\]|\\.)*")/g)].map((match) => JSON.parse(match[1]!) as string));

/** 閉じた設定を正直に当てる app-server: 列挙には実物の応答を返し、観測ではそのうち閉じられなかった skill を有効と答える。 */
function honestSkillsList(args: readonly string[], cwds: readonly string[]) {
  const listed = codexSkillsListAt(cwds) as { data: Array<{ skills: Array<{ path: string; enabled: boolean }> }> };
  if (!args.includes("--strict-config")) return listed;
  const closed = closedPaths(args);
  for (const skill of listed.data.flatMap((entry) => entry.skills)) skill.enabled = !closed.has(skill.path);
  return listed;
}

/** The short empty override closes ambient developer instructions (ADR 0326). */
const developerInstructions = (args: string[]) => configValue<string>(args, "developer_instructions=");
const boardByArgs = new WeakMap<string[], string>();
const boardText = (args: string[]) => boardByArgs.get(args)!;

/** spawn が `-c mcp_servers.tidepool.enabled_tools=` で Codex に宣言した verb 列。 */
const enabledTools = (args: string[]) => configValue<string[]>(args, "mcp_servers.tidepool.enabled_tools=");
async function fixture(
  onSpawnFailed?: (taskId: string, failure: { error_code: string | null; message: string }) => void,
  allowedDomains = "\n  allowed_domains:\n    - api.github.com",
  onWorkerExited?: CodexWorkerOptions["onWorkerExited"],
  spawn?: ContainerSpawn,
  {
    registryFiles = {},
    linkWorkspace = false,
    appServer = honestSkillsList,
    usageProbe,
    containers,
    auditorName,
    onPickupStopped,
    boardState,
  }: {
    auditorName?: string;
    registryFiles?: Record<string, string>;
    linkWorkspace?: boolean;
    appServer?: Parameters<typeof fakeAppServerCall>[0];
    usageProbe?: CodexAppServerProbe;
    containers?: ProcessContainers;
    onPickupStopped?: CodexWorkerOptions["onPickupStopped"];
    boardState?: (workspace: string) => CodexWorkerOptions["boardState"];
  } = {},
) {
  // 実体のパスで持つ —— spawn は登録 path を realpath する(issue #864)ので、macOS の tmpdir の /var でも assert がそのまま読める
  const workspace = await realpath(await tempDir("tidepool-codex-workspace-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace });
  const registeredWorkspace = linkWorkspace ? join(await tempDir("tidepool-codex-link-"), "work") : workspace;
  if (linkWorkspace) await symlink(workspace, registeredWorkspace);
  const registry = await makeRegistry({
    "agents/codex-agent.md": `---
name: codex-agent
description: Codex agent
version: 1.2.3
authority: standard
provider: openai
skills: []
---
You are the Codex worker.`,
    "workspaces.yaml": `work:
  path: ${registeredWorkspace}${allowedDomains}
`,
    ...registryFiles,
  });
  const db = openDb(":memory:");
  const process = recordingSpawn();
  // 多くの test が exit を撃たないまま終わる —— #705 の後始末は exit / spawn-error 経路
  // 止まりなので、それらは task の一時ディレクトリを os.tmpdir() に残す(issue #1001)。
  onTestFinished(() => process.emitExit(0, null));
  const codexHome = await tempDir("tidepool-codex-home-");
  const logDir = await tempDir("tidepool-codex-logs-");
  const appServerCall = fakeAppServerCall(appServer);
  const clock = new FakeClock();
  const workerContainers = containers ?? passthroughContainers(spawn ?? process.spawn);
  const worker = new CodexWorker({
    db,
    clock,
    registry: { dir: registry, mode: "purely-local" },
    agent: "codex-agent",
    workspace: "work",
    workspacesDir: tmpdir(),
    mcpUrl: "http://127.0.0.1:4590/mcp",
    transcripts: new TranscriptStore(logDir),
    codexHome,
    cliVersion: CLI_VERSION,
    executable: "/opt/tidepool/bin/codex",
    containers: workerContainers,
    boardCall: appServerCall.call,
    onSpawnFailed,
    onWorkerExited,
    usageProbe,
    auditorName,
    onPickupStopped,
    boardState: boardState?.(workspace),
  });
  // scheduler が pickup の瞬間に選ぶ実行設定(除外なし)を渡す
  const agent = loadRegistry(registry, "purely-local").agents["codex-agent"]!;
  const start = (value: Task, query?: InjectionQuery) => {
    const started = worker.start(value, executionSettingsFor(db, agent, value)[0]!, query);
    return started?.then(() => {
      const spawned = listEvents(db, value.id).filter((e) => e.kind === "worker_spawned").at(-1);
      const call = process.calls.at(-1);
      if (spawned && call) {
        const record = new TranscriptStore(logDir).readPrompt(value.id, spawned.id);
        if (record) boardByArgs.set(call.args, record.board.map((part) => part.text).join(""));
      }
    });
  };
  return { db, worker, start, process, clock, codexHome, workspace, registeredWorkspace, logDir, registry, containers: workerContainers, appServer: appServerCall.calls };
}

describe("CodexWorker (ADR 0098)", () => {
  it("spawns the pinned Codex route with isolated auth home and closed worker surfaces", async () => {
    const f = await fixture();
    const value = task(f.db);
    process.env.OPENAI_API_KEY = "must-not-leak";
    process.env.GITHUB_TOKEN = "must-not-leak";

    await f.start(value);
    delete process.env.OPENAI_API_KEY;
    delete process.env.GITHUB_TOKEN;

    const call = f.process.calls[0]!;
    expect(call.command).toBe("/opt/tidepool/bin/codex");
    expect(call.cwd).toBe(f.workspace);
    expect(call.env.CODEX_HOME).toBe(f.codexHome);
    expect(call.env.OPENAI_API_KEY).toBeUndefined();
    expect(call.env.GITHUB_TOKEN).toBeUndefined();
    expect(call.args).toEqual(expect.arrayContaining([
      "--ask-for-approval", "never", "exec", "--json", "--ephemeral", "--ignore-user-config",
      "--ignore-rules", "--strict-config", "--dangerously-bypass-hook-trust",
      "-C", f.workspace, "-m", "gpt-5.6-terra",
    ]));
    const config = call.args.filter((_, index) => call.args[index - 1] === "-c").join("\n");
    // 前提の破綻と自タスク外の発見の2文(ADR 0121 / issue #631)
    expect(boardText(call.args)).toContain("When the premise of the decomposition decision your task rests on turns out to be false, declare a premise breach rather than working around it or escalating it.");
    expect(boardText(call.args)).toContain("A finding outside your task's scope is not your task: record the decision not to act on it with `log_decision`, and never decompose it into a child.");
    expect(config).toContain('model_reasoning_effort="high"');
    expect(config).toContain('default_permissions="tidepool-work"');
    expect(config).toContain('\":root\"=\"deny\"');
    expect(config).toContain('\":slash_tmp\"=\"deny\"');
    expect(config).toContain("permissions.tidepool-work.workspace_roots=");
    // workspace の allowed_domains が network の許可に載る(ADR 0072 決定1 / issue #763)
    expect(config).toContain('\"api.github.com\"=\"allow\"');
    // 既定拒否(ADR 0135 決定1): snapshot が "false" の名前は全部 `-c` に載る
    const closed = Object.entries(CODEX_FEATURE_SNAPSHOT).filter(([, state]) => state === "false");
    expect(closed.filter(([name]) => !config.includes(`features.${name}=false`)).map(([name]) => name)).toEqual([]);
    expect(config).toContain('forced_login_method="chatgpt"');
    expect(config).toContain("project_doc_max_bytes=0");
    expect(config).toContain('web_search="disabled"');
    expect(config).toContain("mcp_servers.tidepool.enabled_tools=");
    expect(config).toContain("get_current_task");
    expect(config).toContain("mcp_servers.tidepool.required=true");
    expect(config).toContain('mcp_servers.tidepool.default_tools_approval_mode="approve"');
    expect(config).toContain("agents.max_concurrent_threads_per_session=3");
    // snapshot が "true" の名前を盤面は書かない —— 開ける名前は書けば版の宣言になり(ADR 0134 決定2)、
    // `=false` が届かない名前は書いても届かない(ADR 0135 決定4)。例外の2つだけ別経路で明示している:
    // network_proxy は closedSurfaceConfig()、hooks は hookConfig()。
    expect(config).toContain("features.network_proxy=true");
    const unwritten = Object.entries(CODEX_FEATURE_SNAPSHOT)
      .filter(([name, state]) => state === "true" && name !== "network_proxy" && name !== "hooks");
    expect(unwritten.filter(([name]) => config.includes(`features.${name}=`)).map(([name]) => name)).toEqual([]);
    // 中身は skills/list の列挙から —— 下の ADR 0259 決定2 のテストが固定する
    expect(config).toContain("skills.config=");
    expect(config).toContain("?task=" + value.id);
    expect(config).toContain("features.hooks=true");
    expect(config).toContain('hooks.PreToolUse=[{matcher="mcp__tidepool__.*"');
    // 門は agent_id 1本(ADR 0130 決定1)—— SubagentStart の登録も state file の env も渡らない
    expect(config).not.toContain("hooks.SubagentStart=");
    expect(call.env.TIDEPOOL_SUBAGENT_STATE).toBeUndefined();
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")?.payload).toMatchObject({
      kind: "worker_spawned",
      // ADR 0110 決定3: -m と model_reasoning_effort に渡した値そのもの、および
      // ティアの出所(この agent は tier を書いていないので盤面既定)
      provider: "openai",
      model: "gpt-5.6-terra",
      effort: "high",
      source: { tier: "board", provider: "only" },
      // openai の正準経路は advisor を提供しない(ADR 0098)
      advisor: null,
      harness: "codex",
      cli_version: CLI_VERSION,
    });
  });

  // Claude の worker spawn env と同じ4本(issue #2469)。期待値は独立した literal(実装の定数を import しない)
  it("host の GitHub / OpenAI の資格情報 env 4つを worker env から消す", async () => {
    const credentialEnvs = ["GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
    const f = await fixture();
    for (const name of credentialEnvs) vi.stubEnv(name, "must-not-leak");
    try {
      await f.start(task(f.db));
      for (const name of credentialEnvs) expect(f.process.calls[0]!.env[name]).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("allowed_domains を持たない workspace では network の許可は 127.0.0.1 だけのまま(issue #763)", async () => {
    const f = await fixture(undefined, "");
    await f.start(task(f.db));

    const call = f.process.calls[0]!;
    const taskTemp = call.env.TMPDIR!;
    expect(call.args).toContain(
      `permissions.tidepool-work.network={"enabled"=true,"domains"={"127.0.0.1"="allow"},"unix_sockets"={${JSON.stringify(taskTemp)}="allow"},"allow_local_binding"=true}`,
    );
  });

  it("review task の spawn にも workspace の allowed_domains が network の許可に載る(issue #763)", async () => {
    const f = await fixture();
    await f.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-review", purpose: "read the diff", completion_criteria: "findings are filed" },
      new Date("2026-08-24T00:00:00.000Z"),
      ...HUMAN_WEBUI,
    ));

    const config = f.process.calls[0]!.args.filter((_, index, args) => args[index - 1] === "-c").join("\n");
    expect(config).toContain('permissions.tidepool-review.network={"enabled"=true,"domains"={"api.github.com"="allow","127.0.0.1"="allow"}');
  });

  it.each([
    ["memory_repair", writeRepairTask],
    ["routing_repair", routingRepairTask],
  ] as const)("%s task の spawn は review と同じ read-only の permission profile で走る(ADR 0272 決定3 / ADR 0279 決定4)", async (_, register) => {
    const f = await fixture();
    await f.start(register(f.db));

    const args = f.process.calls[0]!.args;
    expect(configEntry(args, "default_permissions=")).toBe('default_permissions="tidepool-review"');
    expect(configEntry(args, "permissions.tidepool-review.extends=")).toBe('permissions.tidepool-review.extends=":read-only"');
  });

  // work task の .git の行(write / hooks・config は read)は下の issue #864 のテストが同じ seam で固定する(ADR 0107 決定3)
  it("review task の filesystem 表には workspace の .git の行が無い(issue #849 / ADR 0033)", async () => {
    const f = await fixture();
    await f.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-review", purpose: "read the diff", completion_criteria: "findings are filed" },
      new Date("2026-08-24T00:00:00.000Z"),
      ...HUMAN_WEBUI,
    ));

    expect(filesystem(f.process.calls[0]!.args, "tidepool-review")).not.toContain(join(f.workspace, ".git"));
  });

  it("シンボリックリンク経由で登録した workspace でも、work task の spawn は filesystem 表の workspace・.git・.git/hooks・.git/config の行と skills/list の cwds・-C・cwd を実体のパスで書く(issue #864)", async () => {
    const f = await fixture(undefined, undefined, undefined, undefined, { linkWorkspace: true });
    await f.start(task(f.db));

    const workspaceRows = (args: string[]) =>
      [...filesystem(args, "tidepool-work").matchAll(/"([^"]+)"="\w+"/g)]
        .filter(([, path]) => path!.startsWith(f.workspace) || path!.startsWith(f.registeredWorkspace))
        .map(([row]) => row);
    expect(workspaceRows(f.process.calls[0]!.args)).toEqual([
      `${JSON.stringify(f.workspace)}="write"`,
      `${JSON.stringify(join(f.workspace, ".git"))}="write"`,
      `${JSON.stringify(join(f.workspace, ".git", "hooks"))}="read"`,
      `${JSON.stringify(join(f.workspace, ".git", "config"))}="read"`,
    ]);
    const listed = { method: "skills/list", params: { cwds: [f.workspace], forceReload: true } };
    expect(f.appServer.flatMap(({ requests }) => requests)).toEqual([{ id: 2, ...listed }, { id: 2, ...listed }]);
    const args = f.process.calls[0]!.args;
    expect(args[args.indexOf("-C") + 1]).toBe(f.workspace);
    expect(f.process.calls[0]!.cwd).toBe(f.workspace);
  });

  it("Interview の root は面接室を cwd と -C にして work の profile で面接室に書け(.git の行も work と同じ)、実環境と開ける面接室(根拠の Interview の root のもの)は read で載る(ADR 0273 決定2)", async () => {
    const f = await fixture();
    const evidence = interviewRoot(f.db);
    const root = registerTask(f.db, { type: "interview", assignee: "codex-agent", title: "interview", hypothesis: "h", tier: "standard", evidence_task_ids: [evidence.id], interview_targets: [SOL] }, new Date(0), ...HUMAN_WEBUI);
    openTestInterviewRoom(f.db, root);

    await f.start(root);

    // spawn は実体の綴りで書く(issue #864)
    const roomOf = (id: string) => realpathSync(interviewRoomPath(f.db, id)!);
    const room = roomOf(root.id);
    const args = f.process.calls[0]!.args;
    expect(f.process.calls[0]!.cwd).toBe(room);
    expect(args[args.indexOf("-C") + 1]).toBe(room);
    expect(configEntry(args, "default_permissions=")).toBe('default_permissions="tidepool-work"');
    const rows = filesystem(args, "tidepool-work");
    for (const row of [
      `${JSON.stringify(room)}="write"`,
      `${JSON.stringify(join(room, ".git"))}="write"`,
      `${JSON.stringify(join(room, ".git", "hooks"))}="read"`,
      `${JSON.stringify(f.workspace)}="read"`,
      `${JSON.stringify(roomOf(evidence.id))}="read"`,
    ]) expect(rows).toContain(row);
  });

  it("受験者は自分の checkout を cwd と -C にして走り、面接室の在り処(root の id)はそこに入らない(ADR 0276 決定1)", async () => {
    const f = await fixture();
    const child = pinnedChild(f.db);

    await f.start(child);

    const args = f.process.calls[0]!.args;
    expect(f.process.calls[0]!.cwd).toBe(examineeCheckoutPath(f.db, child.id));
    expect(args[args.indexOf("-C") + 1]).toBe(examineeCheckoutPath(f.db, child.id));
    expect(f.process.calls[0]!.cwd).not.toContain(examineeRootId(f.db, child.id));
  });

  it("Interview の監査 review は実環境を cwd に review の profile で走り、親の root の面接室を read で載せる(ADR 0273 決定4)", async () => {
    const f = await fixture(undefined, undefined, undefined, undefined, { auditorName: "codex-agent" });
    const root = interviewRoot(f.db);
    const audit = poseProbe(f.db, root, { title: "probe", probe: "run the probe", completion_criteria: "the probe's deliverable", rubric: "it runs" }, "codex-agent", new Date(0), "worker", POSED_HEAD);

    await f.start(audit);

    const args = f.process.calls[0]!.args;
    expect(f.process.calls[0]!.cwd).toBe(f.workspace);
    expect(configEntry(args, "default_permissions=")).toBe('default_permissions="tidepool-review"');
    const rows = filesystem(args, "tidepool-review");
    expect(rows).toContain(`${JSON.stringify(f.workspace)}="read"`);
    expect(rows).toContain(`${JSON.stringify(realpathSync(interviewRoomPath(f.db, root.id)!))}="read"`);
  });

  it("retry の新しい root は、retry が残した旧い root の面接室を read で載せる(ADR 0273 決定9)", async () => {
    const f = await fixture();
    const previous = posedInterviewRoot(f.db);
    const root = retryInterviewRoot(f.db, previous, undefined, new Date(1), {}, "webui");
    openTestInterviewRoom(f.db, root);

    await f.start(root);

    const rows = filesystem(f.process.calls[0]!.args, "tidepool-work");
    expect(rows).toContain(`${JSON.stringify(realpathSync(interviewRoomPath(f.db, previous.id)!))}="read"`);
  });

  it("preflight の app-server が読む設定のキーは、work / review とも同じ種別の spawn のキーと一致する(ADR 0142 決定2・3)", async () => {
    const f = await fixture();
    await f.start(task(f.db));
    await f.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-review", purpose: "read the diff", completion_criteria: "findings are filed" },
      new Date("2026-08-24T00:00:00.000Z"),
      ...HUMAN_WEBUI,
    ));

    // preflight を --version・prompt-input・features list・sandbox 2本・hooks/list と通し、review 呼び出しまで進める
    const { spawn: preflight, capability, index } = await driveCodexPreflight("reviewAppServer", { codexHome: f.codexHome });
    preflight.emitExitAt(index, 1, null);
    await capability;

    const keys = (args: string[]) =>
      new Set(args.filter((_, i) => args[i - 1] === "-c").map((entry) => entry.split("=", 1)[0]));
    expect(keys(f.process.calls[0]!.args)).toContain("mcp_servers.tidepool.url");
    expect(keys(preflight.calls[index - 1]!.args)).toEqual(keys(f.process.calls[0]!.args));
    expect(keys(preflight.calls[index]!.args)).toEqual(keys(f.process.calls[1]!.args));
  });

  it("spawn の skills.config は、空の cwd の app-server の skills/list が task の workspace について返したすべての path を、scope を問わず enabled=false で閉じ、同じ設定を --strict-config で当てた skills/list で観測してから spawn する(ADR 0259 決定2・3)", async () => {
    const f = await fixture();
    await f.start(task(f.db));

    const [enumeration, observation] = f.appServer;
    expect(enumeration!.spec).toMatchObject({ kind: "Codex skill enumeration", harness: "codex", args: ["app-server"] });
    expect(observation!.spec.kind).toBe("Codex skill observation");
    expect(enumeration!.spec.cwd).not.toBe(f.workspace);
    expect(enumeration!.requests).toEqual([{ id: 2, method: "skills/list", params: { cwds: [f.workspace], forceReload: true } }]);
    const spawned = f.process.calls[0]!.args;
    expect(skills(spawned)).toBe(
      `skills.config=[${listedSkillPaths(codexSkillsListAt([f.workspace]), [f.workspace]).map((path) => `{path=${JSON.stringify(path)},enabled=false}`).join(",")}]`,
    );
    const configPairs = spawned.flatMap((arg, i) => (spawned[i - 1] === "-c" ? ["-c", arg] : []));
    // Skill observation uses exactly the worker config, including the empty developer override (ADR 0326).
    expect(configPairs).toContain('developer_instructions=""');
    expect(observation!.spec.args).toEqual([
      "app-server",
      "--strict-config",
      ...configPairs,
    ]);
    expect(observation!.requests).toEqual(enumeration!.requests);
  });

  it("worker_spawned は封じ込めの観測の後・本文の描画の前に書かれ、Roster はその id の時点の Executor —— 観測の最中に pickup された親の worker が載る(ADR 0295 決定4)", async () => {
    let duringObservation = () => {};
    const f = await fixture(undefined, undefined, undefined, undefined, {
      appServer: (args, cwds) => {
        if (args.includes("--strict-config")) duringObservation();
        return honestSkillsList(args, cwds);
      },
    });
    const at = new Date("2026-08-24T00:00:00.000Z");
    const parent = registerTask(f.db, { type: "work", workspace: "work", title: "w", purpose: "p", completion_criteria: "c" }, at, ...HUMAN_WEBUI);
    const review = registerTask(f.db, { type: "review", assignee: "codex-agent", title: "rca", purpose: "p", completion_criteria: "c", parent_id: parent.id }, at, BOARD_ACTOR_ID, "board");
    duringObservation = () => markPickedUp(f.db, parent.id, at, "codex-agent");

    await f.start(review);

    const pickedUp = listEvents(f.db, parent.id).find((event) => event.kind === "task_picked_up")!;
    const spawned = listEvents(f.db, review.id).find((event) => event.kind === "worker_spawned")!;
    expect(pickedUp.id).toBeLessThan(spawned.id);
    expect(boardText(f.process.calls[0]!.args)).toContain("## Roster\n\ncodex-agent — Codex agent");
  });

  it("閉じた設定の下で有効と報告される skill が残れば、その名前と path を理由に (codex, workspace) の組を quarantine し、spawn も spawn_failed もしない(ADR 0259 決定1・3)", async () => {
    const onSpawnFailed = vi.fn();
    const onPickupStopped = vi.fn();
    const f = await fixture(onSpawnFailed, undefined, undefined, undefined, {
      appServer: answerSkillsList("one-enabled"),
      onPickupStopped,
    });
    const value = task(f.db);
    await f.start(value);

    expect(f.process.calls).toEqual([]);
    expect(openQuarantineValues(f.db, "workspace")).toEqual([]);
    expect(quarantineQuestion(f.db, "workspaceContainment", "codex/work")?.purpose).toContain(
      "Under the board's closed skills.config, Codex still reports these skills enabled: flat (/board/fixture/ws/B/.agents/skills/flat/SKILL.md).",
    );
    expect(listEvents(f.db, value.id).map((event) => event.kind)).not.toEqual(expect.arrayContaining(["worker_spawned", "spawn_failed"]));
    expect(onSpawnFailed).not.toHaveBeenCalled();
    // 組の停止として盤面の一撃に1回渡す —— 一撃が先頭へ戻して枠を空ける(ADR 0274)
    expect(onPickupStopped.mock.calls).toEqual([
      [value.id, { kind: "pickup_stopped", quarantine: "workspaceContainment", value: "codex/work", reason: expect.stringContaining("Codex still reports these skills enabled: flat") }],
    ]);
    expect(existsSync(f.appServer[0]!.spec.env.TMPDIR!)).toBe(false);
  });

  it.each([
    ["registry に無い workspace 名(registry drift)", { workspace: "ghost" }, false, { quarantine: "workspace", value: "ghost", reason: "unknown workspace: ghost" }],
    ["registry に無い agent 名(registry drift)", { assignee: "ghost" }, false, { quarantine: "agent", value: "ghost", reason: expect.stringContaining("ghost") }],
    ["盤面の状態パスと重なる workspace", {}, true, { quarantine: "workspace", value: "work", reason: expect.stringContaining("board database (TIDEPOOL_DB)") }],
  ])("%s は spawn も skill の列挙もせずに quarantine し、spawn_failed ではなく盤面の一撃で先頭へ戻す(ADR 0274)", async (_case, fields, overlap, stop) => {
    const onSpawnFailed = vi.fn();
    const onPickupStopped = vi.fn();
    const f = await fixture(onSpawnFailed, undefined, undefined, undefined, {
      onPickupStopped,
      boardState: overlap ? (workspace) => [{ label: "board database (TIDEPOOL_DB)", path: join(workspace, "board.sqlite") }] : undefined,
    });
    const value = registerTask(f.db, { type: "work", assignee: "codex-agent", workspace: "work", title: "stopped", purpose: "p", completion_criteria: "c", ...fields }, new Date("2026-08-24T00:00:00.000Z"), ...HUMAN_WEBUI);
    expect(f.start(value)).toBeUndefined();

    expect(f.process.calls).toEqual([]);
    expect(f.appServer).toEqual([]);
    expect(onSpawnFailed).not.toHaveBeenCalled();
    expect(onPickupStopped.mock.calls).toEqual([[value.id, { kind: "pickup_stopped", ...stop }]]);
  });

  it.each([
    ["口が答えを返さない(上限到達)", () => null],
    ["列挙の応答が読めない", (args: readonly string[], cwds: readonly string[]) => (args.includes("--strict-config") ? codexSkillsListAt(cwds, "closed") : { data: [{}] })],
    ["列挙の応答に workspace の entry が無い", (args: readonly string[], cwds: readonly string[]) => (args.includes("--strict-config") ? codexSkillsListAt(cwds, "closed") : { data: [] })],
    ["観測の応答が読めない", (args: readonly string[], cwds: readonly string[]) => (args.includes("--strict-config") ? {} : codexSkillsListAt(cwds))],
    ["観測の応答に workspace の entry が無い", (args: readonly string[], cwds: readonly string[]) => (args.includes("--strict-config") ? { data: [] } : codexSkillsListAt(cwds))],
  ])("skill の列挙・観測の失敗(%s)は spawn_failed を書いて盤面側の一撃を呼び、組の quarantine は立てず spawn しない(ADR 0259 決定6 / ADR 0118)", async (_, appServer) => {
    const calls: Array<[string, { error_code: string | null; message: string }]> = [];
    const f = await fixture((taskId, failure) => calls.push([taskId, failure]), undefined, undefined, undefined, { appServer });
    const value = task(f.db);
    await f.start(value);

    expect(f.process.calls).toEqual([]);
    expect(openQuarantineValues(f.db, "workspaceContainment")).toEqual([]);
    const message = expect.stringMatching(
      /^Codex skills\/list failed while the board enumerated or observed this workspace's skills, so it could not decide or confirm which skills are closed; the worker was not spawned \(no fail-open\): /,
    );
    expect(calls).toEqual([[value.id, { error_code: null, message }]]);
    expect(listEvents(f.db, value.id).find((event) => event.kind === "spawn_failed")?.payload).toEqual({ kind: "spawn_failed", error_code: null, message });
    expect(existsSync(f.appServer[0]!.spec.env.TMPDIR!)).toBe(false);
  });

  it("主題 memory の meta-review の spawn では enabled_tools が worker の memory verb を専用 verb で置き換え、complete_task を complete_memory_review に替え、分解の verb を伏せ、普通の task は変わらない(ADR 0122 決定2 / ADR 0278 決定1 / ADR 0301 決定3)", async () => {
    const f = await fixture();
    await f.start(task(f.db));
    await f.start(metaReviewTask(f.db));

    const base = ["get_current_task", "list_agents", "complete_task", "log_decision", "decompose", "escalate", "declare_premise_breach", "continue_decomposition", "redecompose"];
    expect(enabledTools(f.process.calls[0]!.args)).toEqual([...base, "record_knowledge", "define_memory_branch", "browse_memory", "search_memory", "read_memory", "propose_from_material"]);
    expect(enabledTools(f.process.calls[1]!.args)).toEqual([
      // meta-review は帰り先の無い系譜で、分解の verb も伏せる(ADR 0301 決定3)
      ...base.filter((verb) => !["complete_task", "decompose", "redecompose"].includes(verb)),
      "propose_from_material",
      "list_memory_candidates",
      "list_precedents",
      "list_memory_entries",
      "read_memory_entries",
      "list_memory_branches",
      "list_memory_proposals",
      "search_memory_entries",
      "define_memory",
      "fold_memory",
      "move_memory",
      "move_memory_branch",
      "invalidate_memory",
      "propose_memory_change",
      "complete_memory_review",
    ]);
  });

  it("盤面の文面は user turn の先頭に、task 固有の指示は区切りの後に置く —— work / review とも同じ配置(ADR 0124 決定1・2)", async () => {
    const f = await fixture();
    const work = task(f.db, "codex-layer-work");
    const review = registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-layer-review", purpose: "read the diff", completion_criteria: "findings are filed" },
      new Date("2026-08-24T00:00:00.000Z"),
      ...HUMAN_WEBUI,
    );
    for (const value of [work, review]) await f.start(value);

    for (const [i, value] of [work, review].entries()) {
      const args = f.process.calls[i]!.args;
      const developer = boardText(args);
      expect(developer).toContain("You are the Codex worker.");
      expect(developer).toContain("## Authority");
      expect(developer).toContain("Board verbs (the tidepool MCP tools) are main-thread only");
      expect(developer).toContain('Spawn subagents with fork_turns: "none"; this session keeps no rollout, so forking the parent thread\'s history always fails.');
      expect(developer).toContain("declare a premise breach");
      expect(developer).not.toContain(value.title);
      expect(developer).not.toContain(value.purpose);
      expect(developer).not.toContain(value.completion_criteria);
      // Board context is user text; the developer override carries no variable prompt.
      expect(developerInstructions(args)).toBe("");

      const prompt = f.process.processes[i]!.stdin.read()!.toString();
      expect(prompt).toContain(`First call get_current_task for task ${value.id}, then complete this task: ${value.title}`);
      expect(prompt).toContain(`Purpose: ${value.purpose}`);
      expect(prompt).toContain(`Completion criteria: ${value.completion_criteria}`);
      expect(prompt.startsWith(developer + "\n\n--- Task ---\n\n")).toBe(true);
      expect(prompt).toContain("## Authority");
    }
  });

  it("200KiB以上の盤面の文とtaskは記録した順序と区切りで1つのstdinに送り、developer指示は空にする", async () => {
    const large = `開始\n${"魚🐟\n".repeat(40000)}末尾\n\n`;
    const f = await fixture(undefined, undefined, undefined, undefined, { registryFiles: { "agents/codex-agent.md": `---\nname: codex-agent\ndescription: Codex agent\nversion: 1.2.3\nauthority: standard\nprovider: openai\nskills: []\n---\n${large}` } });
    const value = task(f.db, "codex-prompt-record");
    value.purpose = large;
    await f.start(value);
    const spawned = listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")!;
    const call = f.process.calls[0]!;
    const recorded = new TranscriptStore(f.logDir).readPrompt(value.id, spawned.id)!;
    expect(call.stdin).toBe("pipe");
    expect(recorded.harness).toBe("codex");
    expect(recorded.placement).toEqual({ board: "user", separator: "\n\n--- Task ---\n\n" });
    expect(recorded.board[0]!.text).toBe(large.trimEnd());
    const board = recorded.board.map((part) => part.text).join("");
    expect(f.process.processes[0]!.stdin.read()?.toString()).toBe(`${board}\n\n--- Task ---\n\n${recorded.task}`);
    expect(f.process.processes[0]!.stdin.writableEnded).toBe(true);
    expect(recorded.task).toBe(`First call get_current_task for task ${value.id}, then complete this task: ${value.title}\n\nPurpose: ${large}\nCompletion criteria: ${value.completion_criteria}`);
    expect(developerInstructions(call.args)).toBe("");
    expect(call.args).not.toContain(recorded.task);
    expect(call.args).not.toContain(board);
    const { registry_commit, definition_version } = spawned.payload as Extract<EventPayload, { kind: "worker_spawned" }>;
    expect(recorded.board[0]).toMatchObject({ part: "definition", registry_commit, definition_version });
  });

  it.each([
    ["work", task],
    ["主題 memory の meta-review", metaReviewTask],
    ["主題 routing の meta-review", (db: ReturnType<typeof openDb>) => metaReviewTask(db, "routing")],
    ["Interview の root", interviewRoot],
    ["Interview の pin の子", pinnedChild],
    ["出題済みの Interview の root", posedInterviewRoot],
    ["書き込みの行への異議の修理", writeRepairTask],
    ["memory meta-review の書き込みの行だけへの異議の修理(主題の修理子、ADR 0283 決定3)", (db: ReturnType<typeof openDb>) => judgmentRepairTask(db, new Date("2026-08-24T00:00:00.000Z"), { rows: "write", executor: "codex-agent" })],
    ["memory meta-review の判断の行への異議の修理", (db: ReturnType<typeof openDb>) => judgmentRepairTask(db, new Date("2026-08-24T00:00:00.000Z"), { executor: "codex-agent" })],
    ["memory meta-review の書き込みの行と判断の行への異議の修理", (db: ReturnType<typeof openDb>) => judgmentRepairTask(db, new Date("2026-08-24T00:00:00.000Z"), { rows: "both", executor: "codex-agent" })],
    ["型つきの行を運ばない routing の修理", routingRepairTask],
    ["routing meta-review の判断の行への異議の修理", (db: ReturnType<typeof openDb>) => routingJudgmentRepairTask(db, new Date("2026-08-24T00:00:00.000Z"), { executor: "codex-agent" })],
    ["self RCA", rca("self")],
    ["auditor RCA", rca("auditor")],
    ["meta-review の下の RCA(行の主題を持つ RCA、ADR 0283 追記1)", rca("self", metaReviewTask)],
    ["祖先の cancel の下の RCA", discardedRca],
    ["統合レビュー", integrationReview],
  ] as const)("%s task では、spawn が Codex に宣言する enabled_tools と盤面の server が出す verb が集合として一致する(ADR 0125 決定2)", async (_, register) => {
    // auditor RCA は Auditor の pointer で走る
    const f = await fixture(undefined, undefined, undefined, undefined, { auditorName: "codex-agent" });
    await f.start(register(f.db));
    t = await bootTidepool();
    const client = await mcpClient(t.mcpBaseUrl, register(t.db).id);
    try {
      // 片方は BOARD_VERBS の並び、片方は registerTool の順。どちらの順序も意味を持たない
      expect(enabledTools(f.process.calls[0]!.args).sort())
        .toEqual((await client.listTools()).tools.map((tool) => tool.name).sort());
    } finally {
      await client.close();
    }
  });

  it("見える approved の記憶があれば work / review task とも注入節を user turn の盤面部分の末尾に置き(Claude と同じ位置 —— ADR 0157 決定1)、worker_spawned の直後に memory_injected を書く。無ければ節を置かず entries 空で残す(spec #586 C / issue #592)", async () => {
    const f = await fixture();
    const bare = task(f.db, "codex-no-memory");
    await f.start(bare);
    expect(boardText(f.process.calls[0]!.args)).not.toContain("## Memory");

    recordKnowledge(
      f.db,
      { scope: "work", path: "board", title: "Board correctness", text: "Tests guard the board.", author: { activity: "human", name: "human" } },
      "webui",
      new Date("2026-08-24T00:00:00.000Z"),
    );
    const work = task(f.db, "codex-memory");
    const review = registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", title: "codex-review", purpose: "keep the board correct", completion_criteria: "reviewed" },
      new Date("2026-08-24T00:00:00.000Z"),
      ...HUMAN_WEBUI,
    );
    for (const [i, value] of [work, review].entries()) {
      await f.start(value);
      const { section } = buildMemoryInjection(f.db, value, "work", "codex-agent");
      expect(boardText(f.process.calls[i + 1]!.args).endsWith(`\n\n${section}`)).toBe(true);
    }

    for (const value of [bare, work, review]) {
      const events = listEvents(f.db, value.id);
      const spawned = events.findIndex((e) => e.kind === "worker_spawned");
      expect(events[spawned + 1]?.payload).toMatchObject({ kind: "memory_injected", worker_spawned_event_id: events[spawned]!.id });
    }
    expect(listEvents(f.db, bare.id).find((e) => e.kind === "memory_injected")?.payload).toMatchObject({ entries: [] });
  });

  it("meta-review の spawn は主題の材料の節を記憶の節の枠(user turn の盤面部分の末尾)に置き、memory_injected の直後に meta_review_material_injected を書く —— 主題 memory には routing の節が入らず、普通の task には節も記録も無い(Claude と同じ —— ADR 0180 決定2・追記 #1239)", async () => {
    const f = await fixture();
    // setup のみ: 窓の上限は登録 event が運ぶので盤面名義で登録し、codex-agent に割り当てる
    for (const subject of ["memory", "routing"] as const) registerMetaReview(f.db, subject, new Date("2026-08-24T00:00:00.000Z"));
    f.db.prepare("UPDATE tasks SET assignee = 'codex-agent' WHERE meta_review_subject IS NOT NULL").run();
    const reviews = (["memory", "routing"] as const).map((subject) => getTask(f.db, listBoard(f.db).find((value) => value.meta_review_subject === subject)!.id)!);
    const work = task(f.db);
    for (const value of [...reviews, work]) await f.start(value);

    for (const [i, review] of reviews.entries()) {
      const { section } = buildMetaReviewMaterial(f.db, review.id)!;
      expect(boardText(f.process.calls[i]!.args).endsWith(`\n\n${section}`)).toBe(true);
      const events = listEvents(f.db, review.id);
      const spawned = events.findIndex((e) => e.kind === "worker_spawned");
      expect(events.slice(spawned + 1, spawned + 3).map((e) => e.payload)).toMatchObject([
        { kind: "memory_injected" },
        { kind: "meta_review_material_injected", subject: review.meta_review_subject, worker_spawned_event_id: events[spawned]!.id },
      ]);
    }
    expect(boardText(f.process.calls[0]!.args)).not.toContain("## Routing meta-review material");
    expect(boardText(f.process.calls[2]!.args)).not.toContain("meta-review material");
    expect(listEvents(f.db, work.id).map((e) => e.kind)).not.toContain("meta_review_material_injected");
  });

  it("主題つきの meta-review の spawn は指針の節を材料の節と別に、その直前に置き、memory_injected は指針の節の id と token 量を持つ(Claude と同じ —— ADR 0279 決定2)", async () => {
    const f = await fixture();
    const at = new Date("2026-08-24T00:00:00.000Z");
    const { entry_id } = recordBehavior(f.db, humanEntryInput(f.db, { workspace: null, path: "review", title: "Fold duplicates first", text: "x", addressee: "codex-agent" }), "webui", at);
    // setup のみ: 盤面名義で登録し、codex-agent に割り当てる
    registerMetaReview(f.db, "memory", at);
    f.db.prepare("UPDATE tasks SET assignee = 'codex-agent' WHERE meta_review_subject = 'memory'").run();
    const review = getTask(f.db, listBoard(f.db).find((value) => value.meta_review_subject === "memory")!.id)!;
    await f.start(review);

    const guidance = buildMemoryInjection(f.db, review, "work", "codex-agent");
    const { section } = buildMetaReviewMaterial(f.db, review.id)!;
    expect(boardText(f.process.calls[0]!.args).endsWith(`\n\n${guidance.section}\n\n${section}`)).toBe(true);
    expect(listEvents(f.db, review.id).find((e) => e.kind === "memory_injected")?.payload).toMatchObject({
      entries: [{ id: entry_id, version: entry_id }],
      tokens: guidance.tokens,
    });
  });

  it("start の入力が英語の view を持てば memory_injected はその文面を持ち、持たなければ query の欄は無い(Claude と同じ —— ADR 0175)", async () => {
    const f = await fixture();
    const viewed = task(f.db, "codex-view");
    const bare = task(f.db, "codex-bare");
    await f.start(viewed, { view: "Find the attic ladder" });
    await f.start(bare);

    const injected = (id: string) => listEvents(f.db, id).find((e) => e.kind === "memory_injected")!.payload;
    expect(injected(viewed.id)).toMatchObject({ query: { view: "Find the attic ladder" } });
    expect(injected(bare.id)).not.toHaveProperty("query");
  });

  it("Board doctrine は Claude と同じ正本から、委譲先を subagent と訳して届き、Workflow 段落を持たず fork_turns の1文で終わる(ADR 0157 決定2・3)", async () => {
    const f = await fixture();
    await f.start(task(f.db, "codex-doctrine"));
    const developer = boardText(f.process.calls[0]!.args);
    const doctrine = developer.slice(developer.indexOf("## Board doctrine"), developer.indexOf("## Rules of the road"));
    // 文面そのものは tests/board-prose.test.ts が固定する。ここは Codex の語の配線と末尾の1文だけ
    expect(doctrine).toContain(boardDoctrine({ delegate: "a subagent", workflow: false }, { withheld: [], added: [] }));
    expect(developer).not.toContain("Workflow");
    expect(developer).toContain('Spawn subagents with fork_turns: "none"; this session keeps no rollout, so forking the parent thread\'s history always fails.');
  });

  it("Interview の pin の子の user turn の盤面部分には、Claude と同じ分けない doctrine が載る(ADR 0245 決定2)", async () => {
    const f = await fixture();
    await f.start(pinnedChild(f.db));
    const developer = boardText(f.process.calls[0]!.args);
    // 文面そのものは tests/board-prose.test.ts が固定する。ここは task ごとの verb の差し替えの配線だけ
    expect(developer).toContain(boardDoctrine({ delegate: "a subagent", workflow: false }, { withheld: ["decompose", "redecompose", "record_knowledge", "define_memory_branch"], added: [] }));
  });

  it("出題前の Interview の root の user turn の盤面部分には、pose_probe を足した verb の差し替えの doctrine が載る(ADR 0253 決定5)", async () => {
    const f = await fixture();
    await f.start(interviewRoot(f.db));
    expect(boardText(f.process.calls[0]!.args)).toContain(boardDoctrine({ delegate: "a subagent", workflow: false }, { withheld: ["decompose", "redecompose", "complete_task"], added: ["pose_probe"] }));
  });

  it("出題済みの Interview の root の user turn の盤面部分には、分けない doctrine が載り decompose を指す文は載らない(ADR 0247 決定3)", async () => {
    const f = await fixture();
    await f.start(posedInterviewRoot(f.db));
    expect(boardText(f.process.calls[0]!.args)).toContain(boardDoctrine({ delegate: "a subagent", workflow: false }, { withheld: ["decompose", "redecompose", "complete_task"], added: ["complete_interview", "report_broken_probe"] }));
  });

  it("Rules of the road と network egress の行が届き、行は workspace の allowed_domains に従う(ADR 0157 決定1 / ADR 0072 決定4)", async () => {
    const open = await fixture();
    await open.start(task(open.db, "codex-network-open"));
    const opened = boardText(open.process.calls[0]!.args);
    expect(opened).toContain("## Rules of the road");
    expect(opened).toContain("Commit your work before completing");
    expect(opened).toContain("This session may reach only: api.github.com. Do not retry downloads from any other domain.");

    const closed = await fixture(undefined, "");
    await closed.start(task(closed.db, "codex-network-closed"));
    expect(boardText(closed.process.calls[0]!.args)).toContain(
      "This session cannot fetch from any external domain. Do not retry external downloads.",
    );
  });

  it("authority guidance が空文字なら `## Authority` 見出しごと省き、空でなければ置く(issue #488 / ADR 0157 決定1)", async () => {
    const empty = await fixture(undefined, undefined, undefined, undefined, {
      registryFiles: {
        "authority/standard.yaml": `guidance: ""\nassignable_to:\n  - "*"\nallowed_workspaces:\n  - "*"\nmerge: external\n`,
      },
    });
    await empty.start(task(empty.db, "codex-empty-guidance"));
    expect(boardText(empty.process.calls[0]!.args)).not.toContain("## Authority");

    const filled = await fixture();
    await filled.start(task(filled.db, "codex-guidance"));
    expect(boardText(filled.process.calls[0]!.args)).toContain("## Authority\n\nPrefer reversible actions.");
  });

  it("work task の Roster は profile の assignable_to から、review task は reviewer の authority と被レビュー task の executor 1名の Roster になる(ADR 0056 / ADR 0157 決定1)", async () => {
    const f = await fixture();
    const at = new Date("2026-08-24T00:00:00.000Z");
    const reviewed = registerTask(
      f.db,
      { type: "work", assignee: "deckhand", workspace: "work", title: "deckhand-work", purpose: "do it", completion_criteria: "done" },
      at,
      ...HUMAN_WEBUI,
    );
    markPickedUp(f.db, reviewed.id, at);
    await f.start(task(f.db, "codex-roster-work"));
    await f.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", parent_id: reviewed.id, title: "codex-roster-review", purpose: "read it", completion_criteria: "reviewed" },
      at,
      ...HUMAN_WEBUI,
    ));

    const work = boardText(f.process.calls[0]!.args);
    expect(work).toContain("## Roster\n\n");
    expect(work).toContain("codex-agent — Codex agent");
    expect(work).toContain("deckhand — General work agent for the tidepool board");

    const review = boardText(f.process.calls[1]!.args);
    expect(review).toContain(
      `## Authority\n\n${REVIEWER_AUTHORITY_PROFILE.guidance}\n\n## Roster\n\ndeckhand — General work agent for the tidepool board\n\n## Board doctrine`,
    );
    expect(review).not.toContain("Prefer reversible actions.");
  });

  it("当事者レビューは当時版の定義を証拠として持ち、節は 定義本文 → authority → roster → doctrine → protocol → 当時版 → Memory の順に並ぶ(ADR 0020 part 4 / ADR 0157 決定1)", async () => {
    const f = await fixture();
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: f.registry }).toString().trim();
    const objectedCommit = git("rev-parse", "main");
    // objected の後に定義が改訂される —— review は現行版で走り、当時版は証拠として読む(ADR 0019)
    await writeFile(
      join(f.registry, "agents", "codex-agent.md"),
      "---\nname: codex-agent\ndescription: Codex agent\nversion: 1.2.4\nauthority: standard\nprovider: openai\nskills: []\n---\nYou are the Codex worker, REFINED after the objected call.",
    );
    git("commit", "-am", "refine codex-agent");

    const at = new Date("2026-08-24T00:00:00.000Z");
    const objected = task(f.db, "codex-objected");
    markPickedUp(f.db, objected.id, at, "codex-agent");
    const spawned = appendEvent(f.db, {
      taskId: objected.id,
      actorId: "codex-agent",
      origin: "board",
      payload: { ...WORKER_SPAWNED, registry_commit: objectedCommit },
      at,
    });
    recordPrompt(f.logDir, objected.id, spawned, [definitionPart("You are the Codex worker.")]);
    const decision = appendEvent(f.db, {
      taskId: objected.id,
      actorId: "codex-agent",
      origin: "board",
      payload: { kind: "decision_logged", line: "chose approach X" },
      at,
    });
    const objection = appendEvent(f.db, {
      taskId: objected.id,
      actorId: "human",
      origin: "webui",
      payload: { kind: "objection_raised", entry_id: decision, comment: "reconsider X", session_id: 1 },
      at,
    });
    recordKnowledge(
      f.db,
      { scope: "work", path: "board", title: "Board correctness", text: "Tests guard the board.", author: { activity: "human", name: "human" } },
      "webui",
      at,
    );
    const rca = registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", parent_id: objected.id, title: "codex-rca", purpose: "why X", completion_criteria: "explained", opened_on_event_ids: [objection] },
      at,
      ...HUMAN_WEBUI,
    );
    await f.start(rca);

    const developer = boardText(f.process.calls[0]!.args);
    const { section } = buildMemoryInjection(f.db, rca, "work", "codex-agent");
    const order = [
      "You are the Codex worker, REFINED after the objected call.",
      "## Authority",
      "## Roster\n\ncodex-agent — Codex agent",
      "## Board doctrine",
      "## Rules of the road",
      "## Definition under review",
      section!,
    ].map((heading) => developer.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(developer).toContain(`---\n\n${fenced("You are the Codex worker.")}\n\n`);
    expect(developer.endsWith(`\n\n${section}`)).toBe(true);
  });

  it("当事者レビューの当時版には記録した Authority と Roster が入る —— 文面は Claude と共有の boardProse(issue #1741 / ADR 0157 / ADR 0314 決定1)", async () => {
    const f = await fixture();
    const objectedCommit = execFileSync("git", ["rev-parse", "main"], { cwd: f.registry }).toString().trim();
    const at = new Date("2026-08-24T00:00:00.000Z");
    const objected = task(f.db, "codex-objected-1741");
    markPickedUp(f.db, objected.id, at, "codex-agent");
    const spawned = appendEvent(f.db, {
      taskId: objected.id,
      actorId: "codex-agent",
      origin: "board",
      payload: { ...WORKER_SPAWNED, registry_commit: objectedCommit },
      at,
    });
    recordPrompt(f.logDir, objected.id, spawned, [
      definitionPart("You are the Codex worker."),
      { part: "authority", text: "\n\n## Authority\n\nPrefer reversible actions.", source: "profile", profile: "standard" },
      { part: "roster", text: "\n\n## Roster\n\ncodex-agent — Codex agent" },
    ]);
    const decision = appendEvent(f.db, {
      taskId: objected.id,
      actorId: "codex-agent",
      origin: "board",
      payload: { kind: "decision_logged", line: "chose approach X" },
      at,
    });
    const objection = appendEvent(f.db, {
      taskId: objected.id,
      actorId: "human",
      origin: "webui",
      payload: { kind: "objection_raised", entry_id: decision, comment: "reconsider X", session_id: 1 },
      at,
    });
    await f.start(registerTask(
      f.db,
      { type: "review", assignee: "codex-agent", workspace: "work", parent_id: objected.id, title: "codex-rca-1741", purpose: "why X", completion_criteria: "explained", opened_on_event_ids: [objection] },
      at,
      ...HUMAN_WEBUI,
    ));

    // 文面そのものは claude-worker.test.ts が釘付けする(ADR 0107 決定3)。ここは記録した盤面部分に届くことだけ
    const developer = boardText(f.process.calls[0]!.args);
    expect(developer).toContain("The Authority below came from the registry's authority profile standard.");
    expect(developer).toContain(fenced("## Roster\n\ncodex-agent — Codex agent"));
  });

  it("work / review task の worker_spawned は、盤面が選んだ候補の段の id を持つ(ADR 0210 決定1)", async () => {
    const f = await fixture();
    for (const value of [task(f.db, "codex-tier-work"), metaReviewTask(f.db)]) {
      await f.worker.start(value, { provider: "openai", model: "gpt-6-astra", effort: "high", advisor: undefined, tier_id: 3, source: { tier: "task", provider: "rank" } });
      expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")?.payload).toMatchObject({ tier_id: 3 });
    }
  });

  it("盤面が順位で選んだ openai の設定を渡されれば、anthropic を先頭に持つ agent でも codex で走る(#544 の demo —— spawn 側の再解決は順位1位の anthropic を返して拒否になる)", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-carried-setting");
    await f.worker.start(value, {
      provider: "openai",
      model: "gpt-6-astra",
      effort: "high",
      advisor: undefined,
      tier_id: 1, source: { tier: "task", provider: "rank" },
    });
    expect(f.process.calls[0]!.args).toEqual(
      expect.arrayContaining(["-m", "gpt-6-astra"]),
    );
    expect(
      listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")?.payload,
    ).toMatchObject({
      provider: "openai",
      model: "gpt-6-astra",
      source: { tier: "task", provider: "rank" },
      harness: "codex",
    });
  });

  it("the spawned Board-owned hook denies a Tidepool MCP call carrying an agent_id and fails closed", async () => {
    const f = await fixture();
    await f.start(task(f.db, "codex-hook"));
    const env = f.process.calls[0]!.env;
    const hook = join(f.codexHome, "tidepool-hooks", "main-thread-mcp.mjs");
    const invoke = (input: unknown) =>
      execFileSync(process.execPath, [hook], {
        env,
        input: typeof input === "string" ? input : JSON.stringify(input),
        encoding: "utf8",
      });
    const denied = { hookSpecificOutput: { permissionDecision: "deny" } };

    // subagent の呼び出しには必ず agent_id が載る。main thread では key ごと出ない(ADR 0130 決定1)
    expect(JSON.parse(invoke({
      hook_event_name: "PreToolUse",
      agent_id: "agent-1",
      tool_name: "mcp__tidepool__complete_task",
    }))).toMatchObject(denied);
    expect(invoke({
      hook_event_name: "PreToolUse",
      tool_name: "mcp__tidepool__complete_task",
    })).toBe("");
    // 門が選ぶのは盤面 verb だけ —— subagent の他の tool は素通しする
    expect(invoke({
      hook_event_name: "PreToolUse",
      agent_id: "agent-1",
      tool_name: "shell",
    })).toBe("");
    // 空の agent_id も subagent の識別子 —— 真偽ではなく key の有無で見る
    expect(JSON.parse(invoke({
      hook_event_name: "PreToolUse",
      agent_id: "",
      tool_name: "mcp__tidepool__complete_task",
    }))).toMatchObject(denied);
    // 執行されない門は fail-open にしない: 解釈できない入力はすべて deny
    expect(JSON.parse(invoke("not-json"))).toMatchObject(denied);
    expect(JSON.parse(invoke({ hook_event_name: "SessionStart" }))).toMatchObject(denied);
  });

  it("normalizes a successful Codex JSONL fixture into the durable session event", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-success");
    await f.start(value);

    const jsonl = readFileSync(new URL("fixtures/codex-success.jsonl", import.meta.url), "utf8");
    f.process.processes[0]!.stdout.write(jsonl);
    f.process.emitExit(0, null);

    const exited = listEvents(f.db, value.id).find((event) => event.kind === "worker_exited");
    expect(exited?.payload).toMatchObject({
      kind: "worker_exited",
      exit_code: 0,
      signal: null,
      advisor: null,
      usage: {
        input_tokens: 93,
        output_tokens: 30,
        cache_read_tokens: 20,
        cache_creation_tokens: 7,
        estimated_cost_usd: null,
      },
    });
    // 観測していない印は起動時の復旧だけが書く(ADR 0315 決定2)
    expect(exited?.payload).not.toHaveProperty("exit_observed");
    const spawned = listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")!;
    // transcript は盤面側の器への pipe なので、ファイルに届くのは非同期(ADR 0149)
    await vi.waitFor(() =>
      expect(readFileSync(join(f.logDir, `${value.id}.${spawned.id}.stream.jsonl`), "utf8")).toBe(jsonl),
    );
  });

  it("Codex 経路の session の終わりに transcript を Precedent に投影する —— worker_exited が記録され書き込みが閉じたあと(ADR 0083 追記10)", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-precedent");
    await f.start(value);
    f.process.processes[0]!.stdout.write(
      readFileSync(new URL("fixtures/worker-session-codex-0.147.0.stream.jsonl", import.meta.url), "utf8"),
    );
    f.process.processes[0]!.stdout.end();
    f.process.emitExit(0, null);

    const episode = await vi.waitFor(() => {
      const [found] = listEpisodes(f.db, { workspace: "work", agent: "codex-agent" });
      expect(found).toBeDefined();
      return found!;
    });
    const events = listEvents(f.db, value.id);
    expect(episode.workerSpawnedEventId).toBe(events.find((e) => e.kind === "worker_spawned")!.id);
    expect(episode.extractorVersion).toBe(EXTRACTOR_VERSION);
    // exit の事実は投影の入力 —— worker_exited を書いたあとに投影している証拠
    expect(episode.workerExitedEventId).toBe(events.find((e) => e.kind === "worker_exited")!.id);
  });

  it("Codex 経路の session の Episode の投影待ちは transcript を開いた時点から立ち、投影の決着で外れる(issue #2570)", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-projection-pending");
    await f.start(value);
    const spawnedId = listEvents(f.db, value.id).find((e) => e.kind === "worker_spawned")!.id;
    expect(projectionPending(f.db, spawnedId)).toBe(true);

    f.process.processes[0]!.stdout.end();
    f.process.emitExit(0, null);
    // worker_exited を書いた後も、transcript の書き込みストリームが閉じて投影が決着するまでは立ったまま
    expect(listEvents(f.db, value.id).some((e) => e.kind === "worker_exited")).toBe(true);
    expect(projectionPending(f.db, spawnedId)).toBe(true);
    await vi.waitFor(() => expect(listEpisodes(f.db, { workspace: "work", agent: "codex-agent" })).toHaveLength(1));

    expect(projectionPending(f.db, spawnedId)).toBe(false);
  });

  it("stderr を <taskId>.<worker_spawned の event id>.stderr.log として stream.jsonl の隣に全量保存する(ADR 0149)", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-stderr");
    await f.start(value);
    f.process.processes[0]!.stderr.write("Error: not logged in\n");
    f.process.processes[0]!.stderr.end();

    const spawned = listEvents(f.db, value.id).find((event) => event.kind === "worker_spawned")!;
    await vi.waitFor(() =>
      expect(readFileSync(join(f.logDir, `${value.id}.${spawned.id}.stderr.log`), "utf8")).toBe(
        "Error: not logged in\n",
      ),
    );
  });

  it("does not infer OpenAI auth quarantine from Codex JSONL prose", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-auth");
    await f.start(value);
    f.process.processes[0]!.stdout.write(
      readFileSync(new URL("fixtures/codex-auth-failure.jsonl", import.meta.url), "utf8"),
    );
    f.process.emitExit(1, null);

    expect(openQuarantineValues(f.db, "providerAuth")).toEqual([]);
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({
      kind: "worker_exited",
      exit_code: 1,
      usage: null,
    });
  });

  it("records an ordinary nonzero exit and a successful exit with missing usage without inventing usage", async () => {
    for (const [id, code, stderr] of [
      ["codex-failed", 2, "model unavailable\n"],
      ["codex-missing-usage", 0, ""],
    ] as const) {
      const f = await fixture();
      const value = task(f.db, id);
      await f.start(value);
      f.process.processes[0]!.stderr.write(stderr);
      f.process.emitExit(code, null);

      expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({
        kind: "worker_exited",
        exit_code: code,
        signal: null,
        stderr_tail: stderr.trim() || null,
        usage: null,
      });
    }
  });

  /** stdout に event を流して exit し、worker_exited の payload を読む(ADR 0188 / 0189)。 */
  async function exitedAfter(id: string, events: object[]): Promise<Record<string, unknown>> {
    const f = await fixture();
    const value = task(f.db, id);
    await f.start(value);
    f.process.processes[0]!.stdout.write(events.map((event) => `${JSON.stringify(event)}\n`).join(""));
    f.process.emitExit(1, null);
    return listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")!.payload as Record<string, unknown>;
  }
  const reportedErrorAfter = async (id: string, events: object[]) => (await exitedAfter(id, events)).reported_error;
  const lastMessageAfter = async (id: string, events: object[]) => (await exitedAfter(id, events)).last_message;
  const said = (text: string) => ({ type: "item.completed", item: { id: "item_0", type: "agent_message", text } });

  // issue #2410: Codex の usage は input_tokens をキャッシュ外の入力に写す。欠けた欄と負の引き算は欠測(null)
  it("0.147.0 の実物の turn.completed から、cache 読み・cache 書きを引いたキャッシュ外の input_tokens を書く", async () => {
    const line = readFileSync(new URL("fixtures/worker-session-codex-0.147.0.stream.jsonl", import.meta.url), "utf8")
      .split("\n")
      .find((text) => text.includes('"turn.completed"'))!;
    expect((await exitedAfter("codex-usage-0147", [JSON.parse(line)])).usage).toMatchObject({
      input_tokens: 17_375,
      output_tokens: 584,
      cache_read_tokens: 79_616,
      cache_creation_tokens: 0,
      estimated_cost_usd: null,
    });
  });

  it("cache_write_input_tokens が無い turn.completed の usage は 0 で埋めず欠測(null)", async () => {
    const completed = { type: "turn.completed", usage: { input_tokens: 120, cached_input_tokens: 20, output_tokens: 30 } };
    expect((await exitedAfter("codex-usage-no-cache-write", [completed])).usage).toBeNull();
  });

  it("cached + cache_write が input を超える turn.completed の usage は負にも 0 にも丸めず欠測(null)", async () => {
    const completed = { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 8, cache_write_input_tokens: 3, output_tokens: 1 } };
    expect((await exitedAfter("codex-usage-negative", [completed])).usage).toBeNull();
  });

  // issue #2426: usage の報告を受け取らなかった codex は Usage::default()(全欄 0)を書く
  it("全欄 0 の turn.completed の usage は消費 0 の計測値にせず欠測(null)", async () => {
    const completed = { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 } };
    expect((await exitedAfter("codex-usage-zero", [completed])).usage).toBeNull();
  });

  it("turn.failed の error.message を入れ子の JSON も解かず逐語で reported_error に載せる(ADR 0188 / #1256)", async () => {
    const message =
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-4\' model is not supported when using Codex with a ChatGPT account."}}';
    expect(await reportedErrorAfter("codex-turn-failed", [{ type: "turn.failed", error: { message } }])).toBe(message);
  });

  it("error event だけで turn.failed の無い exit は reported_error null —— 再試行の文で代用しない(ADR 0188 決定3)", async () => {
    expect(
      await reportedErrorAfter("codex-error-only", [{ type: "error", message: "Reconnecting... 1/5", will_retry: true }]),
    ).toBeNull();
  });

  it("turn.failed が2つあれば最後の message を載せる(ADR 0188)", async () => {
    expect(
      await reportedErrorAfter("codex-turn-failed-twice", [
        { type: "turn.failed", error: { message: "first" } },
        { type: "turn.failed", error: { message: "second" } },
      ]),
    ).toBe("second");
  });

  it("agent_message が2つあれば最後の text を last_message に載せ、空の text は前の発話を残す(ADR 0189)", async () => {
    expect(
      await lastMessageAfter("codex-two-messages", [
        said("first"),
        { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "ls" } },
        said("second"),
        said(""),
      ]),
    ).toBe("second");
  });

  it("マルチバイト文字の途中で割れた stdout からも last_message が化けずに載る(#1298)", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-stdout-mb");
    await f.start(value);
    const bytes = Buffer.from(`${JSON.stringify(said("認証エラー"))}\n`);
    const cut = bytes.indexOf(Buffer.from("証")) + 1;
    f.process.processes[0]!.stdout.write(bytes.subarray(0, cut));
    f.process.processes[0]!.stdout.write(bytes.subarray(cut));
    f.process.emitExit(1, null);
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({
      last_message: "認証エラー",
    });
  });

  it("agent_message の無い exit は last_message null(ADR 0189)", async () => {
    expect(await lastMessageAfter("codex-no-message", [{ type: "turn.completed", usage: {} }])).toBeNull();
  });

  it("spawn 自体の失敗(syscall が \"spawn\" で始まる)は盤面側の一撃を呼び、spawn 族でない error は呼ばず spawn_failed も書かない(ADR 0118)", async () => {
    const calls: Array<[string, { error_code: string | null; message: string }]> = [];
    const f = await fixture((taskId, failure) => calls.push([taskId, failure]));
    const value = task(f.db, "codex-spawn-enoent");
    await f.start(value);

    f.process.emitError(Object.assign(new Error("kill EPERM"), { code: "EPERM", syscall: "kill" }));
    expect(calls).toEqual([]);
    expect(listEvents(f.db, value.id).some((e) => e.kind === "spawn_failed")).toBe(false);
    f.process.emitError(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT", syscall: "spawn codex" }));
    expect(calls).toEqual([[value.id, { error_code: "ENOENT", message: "spawn codex ENOENT" }]]);
  });

  it("root の exit は worker_exited を書いて強制回収を撃ったあとで、盤面側の一撃に exit code / signal / stderr 末尾を渡す(ADR 0145)", async () => {
    const calls: Array<[string, WorkerExit, { exitedRecorded: boolean; forced: boolean }]> = [];
    const f = await fixture(undefined, undefined, (taskId, exit) =>
      calls.push([taskId, exit, {
        exitedRecorded: listEvents(f.db, taskId).some((e) => e.kind === "worker_exited"),
        forced: f.process.killed.includes("SIGKILL"),
      }]),
    );
    const value = task(f.db, "codex-exit-without-report");
    await f.start(value);
    f.process.processes[0]!.stderr.write("boom\n");
    f.process.emitExit(null, "SIGSEGV");

    expect(calls).toEqual([
      [value.id, { exit_code: null, signal: "SIGSEGV", stderr_tail: "boom", reported_error: null, last_message: null }, { exitedRecorded: true, forced: true }],
    ]);
  });

  it("delivers graceful stop to the retained Codex root and records the signaled exit", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-killed");
    await f.start(value);

    f.worker.gracefulStop(value.id);
    f.process.emitExit(null, "SIGINT");

    // 畳み込み停止の SIGINT のあと、root の exit を観測した盤面が容器を強制回収する
    // (ADR 0109 決定4)。passthrough の器ではそれが既に終わった子への SIGKILL に
    // なるが、実機構では「容器に残るものを畳む」操作であり、adapter は signal を
    // 選んでいない(ADR 0099 決定2)。
    expect(f.process.killed).toEqual(["SIGINT", "SIGKILL"]);
    expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({
      kind: "worker_exited",
      exit_code: null,
      signal: "SIGINT",
      usage: null,
    });
  });

  it("stdinの早期切断はexit0でも既存の報告なき終了の失敗と回収を通し、CLIの逐語を保つ", async () => {
    const onExit = vi.fn();
    const f = await fixture(undefined, undefined, onExit);
    const value = pickupTask(f.db, task(f.db), "codex-agent", f.clock.now())!;
    const slot = new Slot();
    slot.occupy(value.id);
    const watchdog = startWatchdog({ db: f.db, clock: f.clock, slot, worker: f.worker, containers: f.containers, pollNow: () => {}, config: { timeLimits: {}, grace: 0 } });
    onTestFinished(watchdog.stop);
    onExit.mockImplementation(watchdog.onWorkerExited);
    await f.start(value);
    expect(() => f.process.processes[0]!.stdin.emit("error", new Error("broken pipe"))).not.toThrow();
    expect(f.process.killed).toContain("SIGKILL");
    f.process.emitExit(0, null);
    expect(listEvents(f.db, value.id).find((e) => e.kind === "worker_exited")!.payload).toMatchObject({ exit_code: 0, reported_error: null });
    expect(listBoard(f.db).find((task) => task.type === "question")?.title).toBe(`worker exited without reporting: ${value.title}`);
    expect(getTask(f.db, value.id)?.status).not.toBe("done");
    expect(existsSync(f.process.calls[0]!.env.TMPDIR!)).toBe(false);
  });

  it("worker の exit(0 / 非0 / signal)の後、TMPDIR が指した task の一時ディレクトリは残らない(issue #705)", async () => {
    const f = await fixture();
    const exits = [[0, null], [2, null], [null, "SIGKILL"]] as const;
    for (const [i] of exits.entries()) await f.start(task(f.db, `codex-exit-${i}`));
    const taskTemps = f.process.calls.map((call) => call.env.TMPDIR!);
    expect(taskTemps.every((dir) => existsSync(dir))).toBe(true);

    exits.forEach(([code, signal], i) => f.process.emitExitAt(i, code, signal));
    expect(taskTemps.filter((dir) => existsSync(dir))).toEqual([]);
  });

  it("spawn の失敗(exit が来ないことがある)の後も、task の一時ディレクトリは残らない(issue #705)", async () => {
    const f = await fixture();
    await f.start(task(f.db));
    const taskTemp = f.process.calls[0]!.env.TMPDIR!;

    f.process.emitError(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT", syscall: "spawn codex" }));
    expect(existsSync(taskTemp)).toBe(false);
  });

  it("skill を閉じたあと spawn が同期で投げたら、spawn_failed を書いて盤面側の一撃を呼び、task の一時ディレクトリは残らない(ADR 0149 決定6 / issue #705)", async () => {
    const calls: Array<[string, { error_code: string | null; message: string }]> = [];
    const f = await fixture((taskId, failure) => calls.push([taskId, failure]), undefined, undefined, () => {
      throw new Error("spawn blew up");
    });
    const value = task(f.db);

    await f.start(value);
    expect(calls).toEqual([[value.id, { error_code: null, message: "spawn blew up" }]]);
    expect(listEvents(f.db, value.id).find((event) => event.kind === "spawn_failed")?.payload).toMatchObject({ message: "spawn blew up" });
    expect(readdirSync(tmpdir()).filter((name) => name.startsWith(`tidepool-codex-${value.id}-`))).toEqual([]);
  });

  it("spawn のあとの配線で投げても未処理の reject にせず、spawn_failed を1度だけ書いて盤面側の一撃を呼ぶ(ADR 0118)", async () => {
    const calls: Array<[string, { error_code: string | null; message: string }]> = [];
    const f = await fixture((taskId, failure) => calls.push([taskId, failure]), undefined, undefined, () => ({ on() {}, kill() {} }) as never);
    const value = task(f.db);

    await f.start(value);
    expect(calls).toEqual([[value.id, { error_code: null, message: expect.stringContaining("pipe") }]]);
    expect(listEvents(f.db, value.id).filter((event) => event.kind === "spawn_failed")).toHaveLength(1);
  });
});

describe("root の出力の読み切り(issue #1336 / ADR 0201)", () => {
  const exitedOf = (f: Awaited<ReturnType<typeof fixture>>, taskId: string) =>
    listEvents(f.db, taskId).find((event) => event.kind === "worker_exited")?.payload;
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it("exit のあと読み切りの前に届いた usage / turn.failed / stderr の末尾が worker_exited に載る", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-late-output");
    await f.start(value);

    f.process.emitExitOnlyAt(0, 1, null);
    // exit の時点で確定させる実装が、遅れて届く出力を読む前に確定し終えるように間を挟む
    await tick();
    f.process.processes[0]!.stdout.write(
      `${JSON.stringify({ type: "turn.failed", error: { message: "boom" } })}\n` +
        `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 1, cache_write_input_tokens: 0, output_tokens: 4 } })}\n`,
    );
    f.process.processes[0]!.stderr.write("LAST-STDERR\n");
    await tick();
    f.process.emitCloseAt(0, 1, null);

    expect(exitedOf(f, value.id)).toMatchObject({
      reported_error: "boom",
      stderr_tail: "LAST-STDERR",
      usage: { input_tokens: 8, output_tokens: 4, cache_read_tokens: 1 },
      output_closed: true,
    });
  });

  it("強制回収は root の exit の時点で撃たれ、worker_exited は読み切りまで書かれない", async () => {
    const f = await fixture();
    const value = task(f.db, "codex-force-at-exit");
    await f.start(value);

    f.process.emitExitOnlyAt(0, 0, null);

    expect(f.process.killed).toEqual(["SIGKILL"]);
    expect(exitedOf(f, value.id)).toBeUndefined();
    f.process.emitCloseAt(0, 0, null);
    expect(exitedOf(f, value.id)).toMatchObject({ exit_code: 0, output_closed: true });
  });

  it("読み切りが回収 timeout までに来なければ、それまでに読めた分で worker_exited を書き、盤面側の一撃を呼ぶ", async () => {
    const exits: WorkerExit[] = [];
    const f = await fixture(undefined, undefined, (_taskId, exit) => exits.push(exit));
    const value = task(f.db, "codex-never-closed");
    await f.start(value);
    f.process.processes[0]!.stderr.write("stuck\n");
    await tick();

    f.process.emitExitOnlyAt(0, 0, null);
    await f.clock.advance(RECLAIM_TIMEOUT);

    expect(exitedOf(f, value.id)).toMatchObject({ exit_code: 0, stderr_tail: "stuck", output_closed: false });
    expect(exits).toEqual([{ exit_code: 0, signal: null, stderr_tail: "stuck", reported_error: null, last_message: null }]);
  });
});

describe("上限到達による中断は exit の直後に読み直した使用量で認める(issue #1979 / ADR 0261)", () => {
  const RESETS_AT = "2026-10-15T12:00:00.000Z";
  const windowAt = (name: string, usedPercent: number) =>
    ({ name, model: null, usedPercent, durationMs: 5 * 3_600_000, resetsAt: RESETS_AT });
  const observed = (...windows: ReturnType<typeof windowAt>[]): CodexAppServerProbe => async () =>
    ({ status: "observed", provider: "openai", cliVersion: CLI_VERSION, plan: "plus", models: new Map(), windows });
  // 文を持たない `turn.failed` —— 読み直しの条件が行の有無であって文ではないことを、ここで釘付けにする(ADR 0188 決定1)
  const turnFailed = { type: "turn.failed" };

  /** 最後の行を流して exit させ、盤面側の一撃の順と worker_exited の payload を返す。 */
  async function exitAfter(id: string, usageProbe: CodexAppServerProbe, last: object = turnFailed, code = 1) {
    const calls: Array<boolean | Promise<boolean>> = [];
    const f = await fixture(undefined, undefined, (_taskId, _exit, classification) => calls.push(classification), undefined, { usageProbe });
    const value = task(f.db, id);
    await f.start(value);
    f.process.processes[0]!.stdout.write(`${JSON.stringify(last)}\n`);
    f.process.emitExit(code, null);
    expect(calls).toHaveLength(1);
    const cap = await calls[0];
    const exited = listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")!.payload as Record<string, unknown>;
    return { f, calls, cap, exited };
  }

  it("probe 保留中に exit を即時通知し、分類の解決時には worker_exited が読める(ADR 0309)", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const calls: Array<boolean | Promise<boolean>> = [];
    const f = await fixture(undefined, undefined, (_taskId, _exit, classification) => calls.push(classification), undefined, {
      usageProbe: async (now) => { await pending; return observed(windowAt("primary", 100))(now); },
    });
    const value = task(f.db, "codex-pending-classification");
    await f.start(value);
    f.process.processes[0]!.stdout.write(`${JSON.stringify(turnFailed)}\n`);
    f.process.emitExit(1, null);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeInstanceOf(Promise);
    let resolved = false;
    const classification = Promise.resolve(calls[0]).then((cap) => {
      resolved = true;
      expect(listEvents(f.db, value.id).find((event) => event.kind === "worker_exited")?.payload).toMatchObject({ usage_recheck: { result: "full" } });
      return cap;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);
    release();
    expect(await classification).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("probe 未配線の turn.failed は即時に中断でない分類を渡す", async () => {
    const calls: unknown[] = [];
    const f = await fixture(undefined, undefined, (_taskId, _exit, classification) => calls.push(classification));
    const value = task(f.db, "codex-no-probe");
    await f.start(value);
    f.process.processes[0]!.stdout.write(`${JSON.stringify(turnFailed)}\n`);
    f.process.emitExit(1, null);
    expect(calls).toEqual([false]);
  });

  it("turn.failed で終わり、読み直した窓のどれかが 100% なら、exit と分類を同じ通知で渡し、worker_exited に満杯の窓だけを残す", async () => {
    const { cap, exited } = await exitAfter("codex-capped", observed(windowAt("primary", 100), windowAt("secondary", 40)));

    expect(cap).toBe(true);
    expect(exited.usage_recheck).toEqual({
      result: "full",
      windows: [{ name: "primary", used_percent: 100, resets_at: RESETS_AT }],
    });
  });

  it("turn.failed で終わっても、どの窓も 100% 未満なら中断ではなく、usage_recheck は not_full", async () => {
    const { cap, exited } = await exitAfter("codex-not-full", observed(windowAt("primary", 99), windowAt("secondary", 40)));

    expect(cap).toBe(false);
    expect(exited.usage_recheck).toEqual({ result: "not_full" });
  });

  it("turn.failed で終わって使用量が読めなければ(unobservable / unauthorized / probe が投げる)、中断ではなく、usage_recheck は unreadable で理由を持つ", async () => {
    const cases: Array<[string, CodexAppServerProbe, string]> = [
      ["unobservable", async () => ({ status: "unobservable", provider: "openai", cliVersion: CLI_VERSION, reason: "App Server probe failed: timeout" }), "App Server probe failed: timeout"],
      ["unauthorized", async () => ({ status: "unauthorized", provider: "openai", cliVersion: CLI_VERSION, reason: "Codex rejected the rate-limit read with HTTP 401" }), "Codex rejected the rate-limit read with HTTP 401"],
      ["thrown", async () => { throw new Error("probe blew up"); }, "Error: probe blew up"],
    ];
    for (const [id, probe, reason] of cases) {
      const { cap, exited } = await exitAfter(`codex-unreadable-${id}`, probe);

      expect(cap).toBe(false);
      expect(exited.usage_recheck).toEqual({ result: "unreadable", reason });
    }
  });

  it("turn.completed で exit 0 した session は、窓が 100% でも使用量を読み直さず、usage_recheck の欄を持たない", async () => {
    const probe = vi.fn(observed(windowAt("primary", 100)));
    const { cap, calls, exited } = await exitAfter(
      "codex-completed",
      probe,
      { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1 } },
      0,
    );

    expect(probe).not.toHaveBeenCalled();
    expect(calls).toEqual([false]);
    expect(cap).toBe(false);
    expect(exited).not.toHaveProperty("usage_recheck");
  });

  it("満杯と認めた読み直しは Throttle の状態に書かない(ADR 0261 決定4 / ADR 0104 決定3)", async () => {
    const { f } = await exitAfter("codex-capped-no-throttle", observed(windowAt("primary", 100)));

    expect(getProviderUsage(f.db)).toEqual([]);
  });
});

describe("Codex の分類待ちを停止の梯子が追い越さない(ADR 0309)", () => {
  it.each(["reclaimed", "timeout"] as const)("%s の question は probe 解決後に逐語を持ち、worker_exited より後に記録される", async (bottom) => {
    const process = recordingSpawn();
    const runtime = new FakeContainerRuntime(process.spawn);
    const containers = new ProcessContainers(runtime);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    let notify!: NonNullable<CodexWorkerOptions["onWorkerExited"]>;
    const f = await fixture(undefined, undefined, (...args) => notify(...args), process.spawn, {
      containers,
      usageProbe: async () => {
        await pending;
        return { status: "observed", provider: "openai", cliVersion: CLI_VERSION, plan: "plus", models: new Map(), windows: [] };
      },
    });
    const value = task(f.db, `codex-ladder-${bottom}`);
    pickupTask(f.db, value, "codex-agent", f.clock.now());
    const slot = new Slot();
    slot.occupy(value.id);
    containers.open(value.id);
    runtime.hold(value.id);
    const watchdog = startWatchdog({ db: f.db, clock: f.clock, slot, worker: f.worker, containers, pollNow: () => {}, config: { timeLimits: { work: 60_000 }, grace: 60_000, reclaimTimeout: 60_000 } });
    onTestFinished(watchdog.stop);
    notify = watchdog.onWorkerExited;
    await f.start(getTask(f.db, value.id)!);
    await f.clock.advance(60_000); // 畳み込み停止
    process.processes[0]!.stdout.write(`${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "LAST" } })}\n${JSON.stringify({ type: "turn.failed", error: { message: "ERROR" } })}\n`);
    process.processes[0]!.stderr.write("STDERR\n");
    process.emitExit(1, null);
    await f.clock.advance(60_000); // 梯子が回収の観測を待つ
    if (bottom === "reclaimed") runtime.fireEmpty(value.id);
    else await f.clock.advance(120_000); // timeout 後も分類が揃うまで決めない
    await new Promise((resolve) => setImmediate(resolve));
    expect(listBoard(f.db).filter((task) => task.type === "question")).toEqual([]);
    expect(slot.currentTaskId).toBe(value.id);
    expect(listEvents(f.db, value.id).some((event) => event.kind === "worker_exited")).toBe(false);

    release();
    await vi.waitFor(() => expect(listBoard(f.db).filter((task) => task.parent_id === value.id)).toHaveLength(1));
    const question = listBoard(f.db).find((task) => task.parent_id === value.id)!;
    expect(question.title).toBe(`watchdog killed task: ${value.title}`);
    expect(question.purpose).toContain("last message from the worker:\nLAST\n\nerror reported by the CLI:\nERROR\n\nstderr tail:\nSTDERR");
    const events = listEvents(f.db, value.id);
    expect(events.find((event) => event.kind === "task_escalated")!.id).toBeGreaterThan(events.find((event) => event.kind === "worker_exited")!.id);
  });
});

describe("resolveCodexExecutable", () => {
  it("PATH に載っているのが symlink でも実体のパスを返す(issue #646)", async () => {
    const base = await tempDir("tidepool-codex-which-");
    const linkDir = join(base, "link");
    await mkdir(linkDir);
    const realExecutable = join(base, "codex");
    await writeFile(realExecutable, "#!/bin/sh\n", { mode: 0o755 });
    await symlink(realExecutable, join(linkDir, "codex"));

    expect(resolveCodexExecutable(linkDir).executable).toBe(await realpath(realExecutable));
  });
});
