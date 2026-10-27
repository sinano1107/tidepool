import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { BoardCall } from "../src/board-call.js";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import { CodexWorker } from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import type { RepoSlug } from "../src/github.js";
import type { GitHubAuth } from "../src/github-auth.js";
import type { Provider } from "../src/provider.js";
import { refireRetrospectiveCalls } from "../src/retrospective.js";
import type { WorkerFactory } from "../src/server.js";
import { answerQuestion, cancelTaskDirectly, getTask, listBoard, listChildren, pickupTask, registerTask, returnToQueueHead } from "../src/tasks.js";
import { liveSession, markTeardown, sessionInTeardown } from "../src/teardown.js";
import { recordHumanStop } from "../src/watchdog.js";
import type { WorkspaceConfig } from "../src/workspace.js";
import {
  answerSkillsList,
  FakeAttributionClient,
  FakeContainerRuntime,
  FakeGitHubClient,
  FakeTranslationClient,
  fakeAppServerCall,
  healthyOpenai,
  noRetrospectiveCalls,
  recordingSpawn,
  withHealthyUsage,
} from "./fakes.js";
import { api, bootTidepool, git, HOUR, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, questions, queueWork, type Tidepool, WORKER_SPAWNED } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

/** issue #1973: slot を取ってから `worker_spawned` を書くまでの窓に届いた停止に、spawn は譲る。 */

const at = new Date("2026-10-27T00:00:00Z");

function picked() {
  const db = openDb(":memory:");
  onTestFinished(() => {
    db.close();
  });
  const registered = registerTask(db, { type: "work", title: "parser", purpose: "parse", completion_criteria: "works" }, at, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", at)!;
  return { db, task };
}

describe("spawn の無い session の停止の決着(ADR 0118 決定1 / ADR 0274 決定3)", () => {
  it("spawn の前に人間が止めた session は never-ran として後始末に入る", () => {
    const { db, task } = picked();
    recordHumanStop(db, task.id, "wrong task", at, "webui");
    expect(sessionInTeardown(db)?.settlement).toBe("never_ran");
  });

  it("spawn の前の停止承認付き cancel も never-ran として後始末に入る", () => {
    const { db, task } = picked();
    cancelTaskDirectly(db, task, "not needed", at, {}, "webui", undefined, {
      taskId: task.id,
      stop: (cancel) => recordHumanStop(db, task.id, "not needed", at, "webui", cancel),
    });
    expect(sessionInTeardown(db)?.settlement).toBe("never_ran");
  });

  it("spawn の前の停止は理由 question を立てるが、process の無い停止に帰責するものは無いので停止の帰責には進まない(ADR 0310)", async () => {
    const { db, task } = picked();
    recordHumanStop(db, task.id, undefined, at, "webui");
    const reason = listBoard(db).find((q) => q.question_stop_reason_task_id === task.id)!;
    answerQuestion(db, getTask(db, reason.id)!, ["deleting unrelated files"], at, undefined, undefined, undefined, "webui");
    const client = new FakeAttributionClient();
    client.scriptStopJudgment({ cause: "capability", evidence: "deleted files outside the workspace" });

    refireRetrospectiveCalls(db, { ...noRetrospectiveCalls, attributionClient: client }, at);
    await settle();

    expect(client.stopCalls).toEqual([]);
    expect(listChildren(db, task.id).filter((child) => child.type === "review")).toEqual([]);
  });

  it("spawn の後の停止は今までどおり released", () => {
    const { db, task } = picked();
    appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
    recordHumanStop(db, task.id, "wrong task", at, "webui");
    expect(sessionInTeardown(db)?.settlement).toBe("released");
  });
});

describe("生きた session の述語(継続が冒頭で取った pickup がまだ生きているか)", () => {
  it("pickup のまま何も起きていなければ開いている", () => {
    const { db, task } = picked();
    expect(liveSession(db, task.id)()).toBe(true);
  });

  it("後始末の印が置かれると閉じる", () => {
    const { db, task } = picked();
    const live = liveSession(db, task.id);
    markTeardown(db, task.id, at);
    expect(live()).toBe(false);
  });

  it("status が in_progress を離れると閉じる", () => {
    const { db, task } = picked();
    const live = liveSession(db, task.id);
    returnToQueueHead(db, task, { kind: "cap_interrupted" }, at);
    expect(live()).toBe(false);
  });

  it("停止 → 解放 → 同じ task の retry の後、旧い継続は閉じたまま、新しい継続は開いている", () => {
    const { db, task } = picked();
    const old = liveSession(db, task.id);
    recordHumanStop(db, task.id, "wrong task", at, "webui");
    db.prepare("UPDATE tasks SET status = 'todo', teardown_started_at = NULL WHERE id = ?").run(task.id);
    pickupTask(db, getTask(db, task.id)!, "deckhand", at);
    expect(old()).toBe(false);
    expect(liveSession(db, task.id)()).toBe(true);
  });
});

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const MIN = 60 * 1000;
const WATCHDOG = { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const events = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as Array<{ id: number; kind: string }>;
const status = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json.status;
const teardown = async () => (await api(t.baseUrl, "GET", "/api/queue")).json.teardown;

/** `nth` 回目の呼び出しだけ保留する口。他(retry の pickup など)はすぐ通す。`fail` は保留を落とす。 */
function holdNth(nth = 1) {
  let release!: () => void;
  let fail!: (err: Error) => void;
  const held = new Promise<void>((resolve, reject) => ((release = resolve), (fail = reject)));
  let calls = 0;
  return { release, fail, calls: () => calls, wait: () => (++calls === nth ? held : Promise.resolve()) };
}

async function bootWithAdapter(
  build: (deps: Parameters<WorkerFactory>[0]) => ClaudeCodeWorker | CodexWorker,
  provider: Provider,
  board: { workspace?: WorkspaceConfig; dir?: string } = {},
) {
  const proc = recordingSpawn();
  t = await bootTidepool({
    ...board,
    watchdog: WATCHDOG,
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, { provider: [{ name: provider, advisor: false }], tier: undefined }, task),
    openaiUsage: healthyOpenai,
    containerRuntime: new FakeContainerRuntime(proc.spawn),
    workerAdapter: (deps) => withHealthyUsage(build(deps), deps.clock),
  });
  return proc;
}

/** skill 列挙の continuation の中から spawn する Claude adapter。1回目の列挙を保留する。`workspace` を渡すと盤面がその checkout を
 *  追跡する(tree rule が走る)。`reboot` は同じ DB の上に同じ adapter で盤面を起こし直す。 */
async function bootClaudeHeldInEnumeration(workspace?: WorkspaceConfig) {
  const registryDir = await makeRegistry({
    "agents/deckhand.md":
      "---\nname: deckhand\nversion: 0.3.1\nauthority: standard\nprovider: anthropic\n" +
      "description: General work agent\nskills:\n  - code-review\n---\nYou are Deckhand.\n",
    ...(workspace && { "workspaces.yaml": `${workspace.name}:\n  path: ${workspace.path}\n` }),
  });
  const hold = holdNth();
  const boot = (dir?: string) =>
    bootWithAdapter(
      (deps) =>
        new ClaudeCodeWorker({
          ...deps,
          registry: { dir: registryDir, mode: "purely-local" },
          agent: "deckhand",
          workspace: "tidepool",
          mcpUrl: "http://127.0.0.1:1/mcp",
          logDir: deps.transcripts.dir,
          enumerateSkills: async () => {
            await hold.wait();
            return ["code-review"];
          },
        }),
      "anthropic",
      { workspace, dir },
    );
  const proc = await boot();
  return { proc, release: hold.release, reboot: () => boot(t.dir) };
}

/** Codex adapter。`holdAt` 番目の Board call(1 = skill 列挙、2 = 封じ込め観測)を保留する。1回目の pickup の観測は skill が
 *  1つ開いたままと答える —— 門が無ければ workspaceContainment の quarantine に落ちる。 */
async function bootCodexHeldAt(holdAt: 1 | 2) {
  const workspace = await tempDir("spawn-yields-codex-ws-");
  git(workspace, "init", "-b", "main");
  const registryDir = await makeRegistry({
    "agents/codex-agent.md":
      "---\nname: codex-agent\ndescription: Codex agent\nversion: 1.2.3\nauthority: standard\n" +
      "provider: openai\nskills: []\n---\nYou are the Codex worker.",
    "workspaces.yaml": `work:\n  path: ${workspace}\n`,
  });
  const codexHome = await tempDir("spawn-yields-codex-home-");
  const hold = holdNth(holdAt);
  // 1回目の pickup の観測(2本目の Board call)だけが skill を開いたままと答える。retry の pickup は3本目から
  const inner = fakeAppServerCall((args, cwds) => answerSkillsList(hold.calls() <= 2 ? "one-enabled" : "closed")(args, cwds)).call;
  const boardCall = (async (...args: Parameters<typeof inner>) => {
    await hold.wait();
    return inner(...args);
  }) as BoardCall;
  const proc = await bootWithAdapter(
    ({ db, clock, containers, onSpawnFailed, onRecordContainerFailed, onWorkerExited, onPickupStopped, transcripts }) =>
      new CodexWorker({
        db,
        clock,
        containers,
        onSpawnFailed,
        onRecordContainerFailed,
        onWorkerExited,
        onPickupStopped,
        transcripts,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "codex-agent",
        workspace: "work",
        workspacesDir: tmpdir(),
        mcpUrl: "http://127.0.0.1:1/mcp",
        codexHome,
        cliVersion: "codex-cli 0.147.0",
        executable: "/opt/tidepool/bin/codex",
        boardCall,
      }),
    "openai",
  );
  return { proc, release: hold.release, boardCalls: hold.calls };
}

const WINDOWS = [
  ["Claude の skill 列挙", bootClaudeHeldInEnumeration, undefined],
  // 列挙の間に届いた停止の後は、観測の Board call も撃たない
  ["Codex の skill 列挙", () => bootCodexHeldAt(1), 1],
  ["Codex の封じ込め観測", () => bootCodexHeldAt(2), 2],
] as const;

for (const [window, boot, boardCallsAtStop] of WINDOWS) {
  it(`${window}の窓に届いた人間の停止に spawn は譲り、何も書かずに終わる —— retry の session は自分の容器で1本だけ spawn する`, async () => {
    const booted = await boot();
    const { proc, release } = booted;
    const task = queueWork(t, "stopped in the window");
    await t.clock.advance(HOUR);
    await settle();
    expect(proc.calls).toHaveLength(0);

    expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "wrong direction" })).status).toBe(200);
    await t.clock.advance(WATCHDOG.grace);
    await settle();
    expect(await teardown()).toBeUndefined();
    release();
    await settle();
    await settle();

    expect(proc.calls).toHaveLength(0);
    if ("boardCalls" in booted) expect(booted.boardCalls()).toBe(boardCallsAtStop);
    const kinds = (await events(task.id)).map((e) => e.kind);
    expect(kinds).not.toContain("worker_spawned");
    expect(kinds).not.toContain("spawn_failed");
    expect(t.containers.created.filter((id) => id === task.id)).toHaveLength(1);
    expect(await status(task.id)).toBe("blocked");
    const [failure, ...more] = await questions(t);
    expect(more).toEqual([]);
    expect(failure.title).toBe("stopped by human: stopped in the window");
    expect((await api(t.baseUrl, "GET", "/api/queue")).json.halts).toEqual([]);
    expect(await teardown()).toBeUndefined();

    expect((await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, { answers: ["retry"] })).status).toBe(200);
    await t.clock.advance(HOUR);
    await settle();
    await settle();

    expect(proc.calls).toHaveLength(1);
    expect(t.containers.created.filter((id) => id === task.id)).toHaveLength(2);
    const after = await events(task.id);
    const retried = after.filter((e) => e.kind === "task_picked_up").at(-1)!;
    expect(after.filter((e) => e.kind === "worker_spawned").map((e) => e.id > retried.id)).toEqual([true]);
  });
}

/** 停止の記録(failure question)以外に、窓の継続が何も書いていないこと。 */
async function expectNothingWrittenByTheWindow(taskId: string, title: string) {
  const kinds = (await events(taskId)).map((e) => e.kind);
  for (const kind of ["worker_spawned", "spawn_failed", "pickup_stopped"]) expect(kinds).not.toContain(kind);
  expect((await questions(t)).map((q) => q.title)).toEqual([`stopped by human: ${title}`]);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.halts).toEqual([]);
}

/** 1回目の訳を保留する注入 query の翻訳(scheduler の pickup の最後の await)。 */
class HeldTranslationClient extends FakeTranslationClient {
  readonly hold = holdNth();
  override async translate(fragments: string[], language: string) {
    await this.hold.wait();
    return super.translate(fragments, language);
  }
}

it("scheduler の pickup の窓(注入 query の翻訳)に届いた停止の後、worker は start されず、窓の継続は何も書かない —— task ブランチに乗った checkout は今日どおり退避して休止位置へ戻る", async () => {
  const workspace = await makeWorkspace("sandbox");
  const translationClient = new HeldTranslationClient();
  t = await bootTidepool({ workspace, resolveWorkspace: () => workspace, translationClient, watchdog: WATCHDOG });
  const title = "潮汐グラフのずれを直す";
  const task = queueWork(t, title);
  await t.clock.advance(HOUR);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);

  expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "wrong direction" })).status).toBe(200);
  await t.clock.advance(WATCHDOG.grace);
  await settle();
  translationClient.hold.release();
  await settle();

  expect(t.worker.started).toEqual([]);
  await expectNothingWrittenByTheWindow(task.id, title);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(await teardown()).toBeUndefined();
});

/** remote 正本を持つ checkout を盤面が追跡し、pickup の追従(token の取得)を保留して止める。返す `token` で保留を解くか落とす。 */
async function stoppedWhileFreshening() {
  const { workspace, publish } = await makeRemoteBackedWorkspace("sandbox");
  const token = holdNth();
  const githubAuth = { ensureToken: token.wait } as unknown as GitHubAuth;
  t = await bootTidepool({ workspace, resolveWorkspace: () => workspace, githubAuth, watchdog: WATCHDOG });
  const task = queueWork(t, "stopped while freshening");
  await t.clock.advance(HOUR);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "wrong direction" })).status).toBe(200);
  return { workspace, publish, task, token };
}

it("remote 正本の追従の窓で止めた session の準備の失敗は捨てられ、後始末は休止位置の checkout に触れず workspace を quarantine しない", async () => {
  const { workspace, task, token } = await stoppedWhileFreshening();
  token.fail(new Error("fatal: could not read from remote repository"));
  await settle();
  await t.clock.advance(WATCHDOG.grace);
  await settle();

  expect(t.worker.started).toEqual([]);
  await expectNothingWrittenByTheWindow(task.id, task.title);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(await teardown()).toBeUndefined();
});

it("追従の token が停止の後に届いても、準備は git に進まない —— fetch も task ブランチも無く、checkout は休止位置のまま", async () => {
  const { workspace, publish, task, token } = await stoppedWhileFreshening();
  const before = git(workspace.path, "rev-parse", "refs/remotes/origin/main");
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  token.release();
  await settle();
  await t.clock.advance(WATCHDOG.grace);
  await settle();

  expect(t.worker.started).toEqual([]);
  await expectNothingWrittenByTheWindow(task.id, task.title);
  expect(git(workspace.path, "rev-parse", "refs/remotes/origin/main")).toBe(before);
  expect(git(workspace.path, "branch", "--list", `task/${task.id}`)).toBe("");
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(await teardown()).toBeUndefined();
});

/** 準備の失敗の修復の問い合わせ(`tokenRefusal`)を保留する GitHub。 */
class HeldRefusalGitHub extends FakeGitHubClient {
  readonly hold = holdNth();
  override async tokenRefusal(ref: RepoSlug) {
    await this.hold.wait();
    return super.tokenRefusal(ref);
  }
}

it("準備の失敗の修復の問い合わせの間に止めた session は、その問い合わせが落ちても spawn_failed も quarantine も書かない", async () => {
  // remote 正本を宣言しながら origin を持たない checkout —— 追従は宣言のずれで落ち、修復の問い合わせへ進む
  const workspace = { ...(await makeWorkspace("sandbox")), repo: "https://github.com/acme/sandbox.git" };
  const github = new HeldRefusalGitHub();
  t = await bootTidepool({ workspace, resolveWorkspace: () => workspace, github, watchdog: WATCHDOG });
  const task = queueWork(t, "stopped while repairing");
  await t.clock.advance(HOUR);
  expect(github.hold.calls()).toBe(1);

  expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "wrong direction" })).status).toBe(200);
  github.hold.fail(new Error("broker unreachable"));
  await settle();
  await t.clock.advance(WATCHDOG.grace);
  await settle();

  expect(t.worker.started).toEqual([]);
  await expectNothingWrittenByTheWindow(task.id, task.title);
  expect(await teardown()).toBeUndefined();
});

it("Claude の列挙の窓で止めた session の後始末が再起動で途切れても、起動時の復旧は途切れなかった後始末と同じところへ着き、worker_exited を書かない(ADR 0274 決定3 / #2638)", async () => {
  const workspace = await makeWorkspace("tidepool");
  const { release, reboot } = await bootClaudeHeldInEnumeration(workspace);
  const task = queueWork(t, "stopped then restarted");
  await t.clock.advance(HOUR);
  await settle();
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect((await api(t.baseUrl, "POST", `/api/tasks/${task.id}/stop`, { reason: "wrong direction" })).status).toBe(200);
  release();
  await settle();
  expect(await teardown()).toMatchObject({ taskId: task.id, settlement: "never_ran" });
  await t.stopServer();

  const proc = await reboot();
  await settle();

  expect(proc.calls).toEqual([]);
  expect((await events(task.id)).map((e) => e.kind)).not.toContain("worker_exited");
  await expectNothingWrittenByTheWindow(task.id, task.title);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(await status(task.id)).toBe("blocked");
  expect(await teardown()).toBeUndefined();
});
