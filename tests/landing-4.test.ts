import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { resolveExecutionAgent } from "../src/agent.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, latestEventOfTask, listEvents, listEventsOfKinds } from "../src/events.js";
import { GitHubAuth } from "../src/github-auth.js";
import { submitAnswer } from "../src/human-verbs.js";
import {
  blockingRootOf,
  createLanding,
  type Landing,
  landingState,
  registerLocalMergeQuestion,
  registerPrPromotionFailureQuestion,
  taskIdsAwaitingLanding,
  taskIdsAwaitingLandingInWorkspace,
} from "../src/landing.js";
import { openQuarantineQuestion, openQuarantineValues, registerResourceStop, workspaceContainmentValue } from "../src/quarantine.js";
import { type AuthorityProfile, loadRegistry, UnknownAgentError } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import {
  answerQuestion,
  cancelTaskDirectly,
  completeTask,
  countUnsettledTasksReferencing,
  getTask,
  listBoard,
  pickupTask,
  registerTask,
  type Task,
  type TaskType,
} from "../src/tasks.js";
import { workbenchPath } from "../src/workbench.js";
import {
  announceHeadRepo,
  dropWorkspaceState,
  holdsBaseline,
  mergeTaskToProtected,
  OutOfBandProtectedBranchError,
  openHumanContentWorkbench,
  openIntakeQuestionId,
  quarantineWorkspace,
  recordTaskCheckoutTip,
  refreshProtectedBranch,
  releaseWorkspace,
  takeWorkspaceInFlightKey,
  UnknownWorkspaceError,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { afterCiRead, awaitWindow, FakeClock, FakeGitHubClient, fakeContainers, holdAfterMerge, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { humanAskpass, startDenyingHttpRemote, } from "./git-http-remote.js";
import {
  CLEAN_LANDING_INTAKE,
  checkoutTaskBranch,
  commitWork,
  completedWork,
  defaultingTo,
  dropBoardBeforeFold,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  leaveBaseline,
  lockDirInside,
  makeLandingWorkspace,
  makeWorkspace,
  notRemoved,
  prepareAtPickup,
  quarantineQuestion,
  queuedForAutoMerge,
  settleReview,
  settleReviews,
  squashTaskIntoOrigin,
  tempDirSync,
} from "./harness.js";
import {
  agentQuarantines,
  announceThenCrash,
  answerHoldOnPr,
  answerLocalMerge,
  answerMerge,
  answerMergeQuestion,
  answerPromotion,
  answerWorkspaceQuarantine,
  attachUnsettledChild,
  autoMergeOutcomeEvents,
  autoMerging,
  boardEvents,
  breakPackedRefs,
  catchUpConflictRoot,
  closeObserved,
  commitOutOfBand,
  commitThroughTaskCheckout,
  completeThroughTaskCheckout,
  convergeOn,
  failPrepareOnce,
  fetchHeldAtToken,
  finish,
  HUMAN_ANSWERER,
  landingWork,
  landLocally,
  mergeQuestion,
  mergeQuestions,
  openBoard,
  openLocalMergeQuestions,
  openPromotionQuestions,
  openPushedPr,
  profile,
  promotionFailures,
  pushPrHead,
  queueAutoMerge,
  recordPrOpenedOutsideConvergence,
  settleRepairNotMergedBack,
  unreadableRefsRefusal,
} from "./landing-fixture.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let db: Db | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

// ADR 0228 決定4: 扉の外で shadow が消え、work が組み込みに落ちたら解決の失敗と同じ quarantine に乗る ——
// 組み込みの reviewer profile(ダイヤル無し)で `outside_board` に黙って外れることはない。
it("shadow が消えて組み込みに落ちた work のキューの PR は、キューから外れず quarantine でスキップされ、直った後の tick が merge する", async () => {
  const workspace = await makeWorkspace("landing-built-in-work");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = registerTask(
    db,
    { type: "work", title: "ship", purpose: "p", completion_criteria: "c", assignee: "fugu" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  recordPrOpenedOutsideConvergence(db, work, 1, clock.now(), { authority: { merge: "auto_if_ci_green" } });
  const registry = loadRegistry(await makeRegistry(), "purely-local");
  let resolveAuthority = (assignee: string | null, taskType: TaskType): AuthorityProfile =>
    resolveExecutionAgent(registry, "tako", assignee, taskType).profile;
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: (assignee, taskType) => resolveAuthority(assignee, taskType),
  });

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");
  expect(agentQuarantines(db).map((q) => q.question_quarantine_value)).toEqual(["fugu"]);

  resolveAuthority = () => profile("auto_if_ci_green");
  await landing.tick("auto_merge");
  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

// ADR 0103 決定1・4: 帯域外の判定は盤面自身の記録(ref snapshot)との突き合わせで、
// 着地の回答だけがこの型を隔離に結ぶ。以下のテストがこの判定を述べる唯一の場所(ADR 0107)。
/** 記録がある形: work を拾い、task の checkout でタスクブランチに commit し、解放する。保護ブランチの行が
 *  記録に入り、名前の場所の HEAD は保護ブランチのまま(ADR 0356 決定1)。 */
async function recordedWork(
  board: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  content = "finished\n",
  file = "feature.txt",
) {
  const work = landingWork(board, clock);
  const place = await prepareAtPickup(board, workspace, work);
  commitWork(place.path, file, content);
  releaseWorkspace(board, place, work, clock.now());
  return work;
}

/** ADR 0356 決定5: intercept the symbolic HEAD read to move the ref between the baseline comparison and the plumbing write. */
async function moveRefBeforeTheLandingWrite(repo: string, ref: string, sha: string): Promise<void> {
  const shimDir = await tempDir("tidepool-git-shim-");
  const real = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
  writeFileSync(
    join(shimDir, "git"),
    `#!/bin/sh\ncase " $* " in *" symbolic-ref -q HEAD "*) "${real}" -C "${repo}" update-ref ${ref} ${sha};; esac\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${shimDir}:${process.env.PATH}`);
}

/** 記録の欠落の形: 一度も拾われていないので ref snapshot に保護ブランチの行が無い。 */
async function unrecordedWork(board: Db, clock: FakeClock, workspace: WorkspaceConfig) {
  const work = landingWork(board, clock);
  checkoutTaskBranch(board, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "finished\n");
  git(workspace.path, "checkout", "main");
  return work;
}

it("保護ブランチが記録から進んでいれば着地を拒み、保護ブランチを動かさない", async () => {
  const workspace = await makeWorkspace("landing-out-of-band-advanced");
  const { db, clock } = await openBoard();
  const work = await recordedWork(db, clock, workspace);
  commitWork(workspace.path, "out-of-band.txt", "moved by hand\n");
  const moved = git(workspace.path, "rev-parse", "refs/heads/main");

  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow(OutOfBandProtectedBranchError);
  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow("the board recorded it at");
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(moved);
});

it("保護ブランチがタスクブランチの祖先へ巻き戻されていても、ff できる位置で着地を拒む", async () => {
  const workspace = await makeWorkspace("landing-out-of-band-rolled-back");
  // 巻き戻し先を祖先として残すため、拾う前に1 commit 足しておく
  commitWork(workspace.path, "base.txt", "the base the task forks from\n");
  const rolledBackTo = git(workspace.path, "rev-parse", "HEAD~1");
  const { db, clock } = await openBoard();
  const work = await recordedWork(db, clock, workspace);
  git(workspace.path, "reset", "--hard", rolledBackTo);

  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow(OutOfBandProtectedBranchError);
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(rolledBackTo);
});

// ADR 0243 決定4 / ADR 0339 Status 追記: 着地は転送を起こさないので checkout の config が転送を書き換えていても網に出ない。記録の基準は帯域外の文で読む
it("HEAD が保護ブランチの外の ff の着地は、checkout の insteadOf と fetch.recurseSubmodules があっても網に出ずに成功し、保護ブランチと記録の基準が landed に揃う", async () => {
  const workspace = await makeWorkspace("landing-off-head-offline");
  const remote = await startDenyingHttpRemote();
  // 登録済みの submodule の remote が網を向く: `fetch.recurseSubmodules` はこれを辿る
  git(workspace.path, "-c", "protocol.file.allow=always", "submodule", "add", (await makeWorkspace("landing-off-head-submodule")).path, "sub");
  git(workspace.path, "config", "-f", ".gitmodules", "submodule.sub.url", remote.url);
  git(workspace.path, "submodule", "sync");
  git(workspace.path, "add", ".gitmodules");
  git(workspace.path, "commit", "-m", "register the submodule");
  const { db, clock } = await openBoard();
  const work = await recordedWork(db, clock, workspace);
  const before = git(workspace.path, "rev-parse", "refs/heads/main");
  const tip = git(workspace.path, "rev-parse", `refs/heads/task/${work.id}`);
  git(workspace.path, "checkout", `task/${work.id}`);
  git(workspace.path, "config", `url.${remote.url}.insteadOf`, ".");
  git(workspace.path, "config", "fetch.recurseSubmodules", "true");
  const askpass = await humanAskpass();

  const { landed } = mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE);

  expect({ landed, protected: git(workspace.path, "rev-parse", "refs/heads/main"), askpass: askpass.tripped(), requests: remote.requests() }).toEqual({
    landed: tip,
    protected: tip,
    askpass: false,
    requests: [],
  });
  git(workspace.path, "update-ref", "refs/heads/main", before);
  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow(`the board recorded it at ${tip} and it now sits at ${before}`);
});

// `update-ref` の旧 sha が CAS。動いた先がタスクブランチの途中でまだ ff できる位置でも、動いたというだけで落ちる
it("記録との突き合わせから書き込みまでに保護ブランチが動いていれば、ff の着地は書き込みで落ち、記録の基準は元の位置に畳まれる", async () => {
  const workspace = await makeWorkspace("landing-off-head-cas");
  const { db, clock } = await openBoard();
  const work = await recordedWork(db, clock, workspace);
  const before = git(workspace.path, "rev-parse", "refs/heads/main");
  git(workspace.path, "checkout", `task/${work.id}`);
  const moved = git(workspace.path, "rev-parse", "HEAD");
  commitWork(workspace.path, "second.txt", "the second commit\n");
  await moveRefBeforeTheLandingWrite(workspace.path, "refs/heads/main", moved);
  vi.stubEnv("LC_ALL", "C");

  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow(`but expected ${before}`);

  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(moved);
  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow(`the board recorded it at ${before} and it now sits at ${moved}`);
});

it("記録に保護ブランチの行が無ければ、位置が動いていなくても着地を拒む", async () => {
  const workspace = await makeWorkspace("landing-out-of-band-unrecorded");
  const { db, clock } = await openBoard();
  const work = await unrecordedWork(db, clock, workspace);
  const before = git(workspace.path, "rev-parse", "refs/heads/main");

  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow("no recorded position");
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(before);
});

// ADR 0243 決定2: 帯域外の判定も、予告中の行は2値のどちらとも一致で通す。走行中の merge の回答の途中で落ちた盤面が
// 残した行の上で、人間が同じ question に答え直す
it.each([
  ["書く前に落ちた(保護ブランチは記録の位置のまま)", false],
  ["書いた後に落ちた(保護ブランチは予告した位置)", true],
])("merge の回答の途中で%s盤面の2値の記録の上で答え直すと、帯域外と読まずに保護ブランチをタスクブランチへ進める", async (_shape, written) => {
  const workspace = await makeWorkspace("landing-answer-over-announced");
  const { db, clock } = await openBoard();
  const work = await recordedWork(db, clock, workspace);
  const question = mergeQuestion(db, clock, { pending_local_merge_task_id: work.id });
  const running = landingWork(db, clock);
  const place = await prepareAtPickup(db, workspace, running);
  const tip = git(workspace.path, "rev-parse", `task/${work.id}`);
  announceThenCrash(db, workspace, "refs/heads/main", tip);
  if (written) git(workspace.path, "update-ref", "refs/heads/main", tip);

  await answerMerge(db, clock, workspace, question);
  commitWork(place.path, "running.txt", "work\n");
  releaseWorkspace(db, place, running, clock.now());

  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(tip);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

// ADR 0401 決定4: 着地が保護ブランチを動かした後・記録の前に死んだ盤面の答え直し —— 含まれているかを履歴で読み、何も書かずにこの根を持ち込んだ commit を返す
it("非 ff で着地した task をもう一度着地させると、commit を足さずにその merge commit を返す", async () => {
  const workspace = await makeWorkspace("landing-reanswer-non-ff");
  const { db, clock } = await openBoard();
  const first = await recordedWork(db, clock, workspace, "first\n", "first.txt");
  const second = await recordedWork(db, clock, workspace, "second\n", "second.txt");
  mergeTaskToProtected(db, workspace, first.id, CLEAN_LANDING_INTAKE);
  const { landed } = mergeTaskToProtected(db, workspace, second.id, CLEAN_LANDING_INTAKE);
  expect(git(workspace.path, "rev-parse", `${landed}^2`)).toBe(git(workspace.path, "rev-parse", `task/${second.id}`));

  expect(mergeTaskToProtected(db, workspace, second.id, CLEAN_LANDING_INTAKE)).toEqual({ landed, kept: undefined });
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(landed);
});

// ADR 0289 決定1: 保護ブランチの tip は他の根の commit でありうる —— 返すのはこの根を持ち込んだ commit
it.each([
  ["ff", 0],
  ["非 ff", 1],
])("%s で着地した task の後に別の根が着地しても、もう一度着地させると commit を足さずにこの根の commit を返す", async (_form, index) => {
  const workspace = await makeWorkspace("landing-reanswer-after-other-root");
  const { db, clock } = await openBoard();
  const works = [];
  for (const file of ["first.txt", "second.txt", "third.txt"]) works.push(await recordedWork(db, clock, workspace, `${file}\n`, file));
  const landings = works.map((work) => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE).landed);
  const after = git(workspace.path, "rev-parse", "refs/heads/main");

  expect(mergeTaskToProtected(db, workspace, works[index]!.id, CLEAN_LANDING_INTAKE)).toEqual({ landed: landings[index], kept: undefined });
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(after);
});

it("task のブランチが無ければ、保護ブランチに含まれていると読まない", async () => {
  const workspace = await makeWorkspace("landing-reanswer-branch-gone");
  const { db, clock } = await openBoard();
  const work = await recordedWork(db, clock, workspace);
  mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE);
  git(workspace.path, "branch", "-D", `task/${work.id}`);
  const before = git(workspace.path, "rev-parse", "refs/heads/main");

  // ADR 0401 帰結: 諦めて(ADR 0392)ブランチが消えた後は判定できず fail-closed のまま
  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow(`fatal: Not a valid object name task/${work.id}`);
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(before);
});

it("基準の行が無い workspace のローカル着地の merge 回答は、最初の撮りをして着地する", async () => {
  const workspace = await makeWorkspace("landing-answer-first-capture");
  const { db, clock } = await openBoard();
  const work = await unrecordedWork(db, clock, workspace);
  const question = mergeQuestion(db, clock, { pending_local_merge_task_id: work.id });
  expect(holdsBaseline(db, workspace.name)).toBe(false);

  await expect(answerMerge(db, clock, workspace, question)).resolves.toMatchObject({ status: "done" });

  expect(holdsBaseline(db, workspace.name)).toBe(true);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(git(workspace.path, "rev-parse", "main")).toBe(git(workspace.path, "rev-parse", `task/${work.id}`));
});

it("最初の撮りが別の workspace の封じ込めを待つ間、merge の回答はその question を名指して拒む", async () => {
  const workspace = await makeWorkspace("landing-answer-capture-waits");
  const held = await makeWorkspace("landing-answer-containment");
  const { db, clock } = await openBoard();
  await leaveBaseline(db, held);
  const work = await unrecordedWork(db, clock, workspace);
  const question = mergeQuestion(db, clock, { pending_local_merge_task_id: work.id });
  const value = workspaceContainmentValue("claude-code", held.name);
  registerResourceStop(db, "workspaceContainment", value, "repair the containment", clock.now());
  const containment = openQuarantineQuestion(db, "workspaceContainment", value)!;

  await expect(answerMerge(db, clock, workspace, question)).rejects.toThrow(`answer question ${containment.id}`);

  expect(holdsBaseline(db, workspace.name)).toBe(false);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(getTask(db, question.id)?.status).toBe("todo");
});

// ADR 0351 決定2: 基準は切れないので、休止中に載った帯域外の commit の行き先は着地の回答の時刻に依らない(#2953)
it.each([
  ["次の pickup の前(着地の帯域外判定が止める)", false],
  ["次の pickup の後(pickup の比較が止める)", true],
])("休止中に保護ブランチへ載った帯域外の commit は、着地の merge 回答が%sでも workspace を quarantine し、回答を拒んで保護ブランチを動かさない", async (_shape, pickedUp) => {
  const workspace = await makeWorkspace("landing-rest-out-of-band");
  const { db, clock } = await openBoard();
  const work = await recordedWork(db, clock, workspace);
  const question = mergeQuestion(db, clock, { pending_local_merge_task_id: work.id });
  commitWork(workspace.path, "out-of-band.txt", "moved by hand while the checkout rested\n");
  const moved = git(workspace.path, "rev-parse", "refs/heads/main");
  if (pickedUp) {
    await pickUpOnce(db, clock, workspace);
    expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(`now: ${moved} refs/heads/main`);
  }

  await expect(answerMerge(db, clock, workspace, question)).rejects.toThrow(DomainError);

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined();
  expect(getTask(db, question.id)?.status).toBe("todo");
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(moved);
});

/** scheduler の pickup を1回撃ち、その workspace の quarantine が立つまで待つ(pickup の比較の停止、ADR 0274)。 */
async function pickUpOnce(db: Db, clock: FakeClock, workspace: WorkspaceConfig): Promise<void> {
  const worker = new ScriptedWorker(clock);
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    // task の checkout(ADR 0356 決定2)をホームの既定の基点に作らない
    workspacesDir: tempDirSync("tidepool-task-checkouts-"),
    converge: async () => [],
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: () => {},
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspace,
    resolveWorkspace: () => workspace,
  });
  await clock.advance(HOURLY);
  await vi.waitFor(() => expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined());
  scheduler.stop();
  expect(worker.started).toEqual([]);
}

// ADR 0103 決定4 の否定側: 記録と一致していれば、着地のコンフリクトは回答の拒否であって隔離ではない。
// 拒否の後も着地 question が開いたまま残る(ADR 0137 決定3)ので、人間は直してもう一度答えられる。
it.each([
  ["slot が空いている", false],
  ["走行中の slot を占めている", true],
])("%s形で着地がコンフリクトしても、回答を拒むだけで quarantine せず、ブランチも HEAD も作業ツリーも動かさない", async (_shape, occupied) => {
  const workspace = await makeWorkspace("landing-conflict-answer");
  const { db, clock } = await openBoard();
  const base = await tempDir("tidepool-task-checkouts-");
  const first = await recordedWork(db, clock, workspace, "from the first task\n");
  const second = await recordedWork(db, clock, workspace, "from the second task\n");
  const firstQuestion = mergeQuestion(db, clock, { pending_local_merge_task_id: first.id });
  const secondQuestion = mergeQuestion(db, clock, { pending_local_merge_task_id: second.id });
  await answerMerge(db, clock, workspace, firstQuestion);
  const third = occupied ? landingWork(db, clock) : undefined;
  if (third) await prepareAtPickup(db, workspace, third);
  const protectedSha = git(workspace.path, "rev-parse", "refs/heads/main");
  const taskSha = git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`);
  const head = git(workspace.path, "rev-parse", "HEAD");
  const branch = git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD");
  // ADR 0356 決定1: 走行中も名前の場所は保護ブランチに居る(旧: 走行中のタスクブランチに居た)
  expect(branch).toBe("main");

  const rejected = answerMerge(db, clock, workspace, secondQuestion, base);

  await expect(rejected).rejects.toThrow(DomainError);
  // spec #3273 text A3(全文は「local 着地の merge が conflict すれば…」が持つ)
  const workbench = realpathSync(workbenchPath(base, { workspace: workspace.name }, `task/${second.id}`));
  await expect(rejected).rejects.toThrow(`task/${second.id} does not merge cleanly into 'main'. The board opened the workbench at ${workbench} for it.`);
  await expect(rejected).rejects.toThrow("Then answer `merge` again.");
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(getTask(db, secondQuestion.id)?.status).toBe("todo");
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(protectedSha);
  expect(git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`)).toBe(taskSha);
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(head);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
});

// ADR 0243 決定4(#1871): 休止中の merge 回答も merge commit を先に作り、口を通して `merge --ff-only` で checkout ごと動かす
/** 休止中の直列の着地: 同じ保護ブランチから分かれ、被らないファイルを足した3件を記録し、1件目を ff で着地させた形。
 *  2件目以降の回答は、盤面自身が進めた保護ブランチへ merge commit で追いつく。 */
async function dormantSerialLanding(board: Db, clock: FakeClock, workspace: WorkspaceConfig) {
  const works = [];
  for (const name of ["first", "second", "third"]) works.push(await recordedWork(board, clock, workspace, `${name}\n`, `${name}.txt`));
  const questions = works.map((work) => mergeQuestion(board, clock, { pending_local_merge_task_id: work.id }));
  await answerMerge(board, clock, workspace, questions[0]!);
  return { works, questions };
}

it("休止中の merge 回答が保護ブランチを書いた後、畳む前に盤面が落ちても、次の回答は帯域外と読まずに着地する", async () => {
  const workspace = await makeWorkspace("landing-dormant-merge-dropped");
  const { db, clock } = await openBoard();
  const { works, questions } = await dormantSerialLanding(db, clock, workspace);
  const reopen = dropBoardBeforeFold(db);
  await expect(answerMerge(db, clock, workspace, questions[1]!)).rejects.toThrow("the board dropped");
  reopen();
  expect(git(workspace.path, "rev-list", "--count", `main..task/${works[1]!.id}`)).toBe("0");

  await answerMerge(db, clock, workspace, questions[2]!);

  expect(git(workspace.path, "rev-list", "--count", `main..task/${works[2]!.id}`)).toBe("0");
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it.each([
  ["そのままなら、次の回答が追いつく", false],
  ["merge の前の位置へ手で戻せば、次の回答は帯域外と読む", true],
])("休止中の merge 回答の後、記録は保護ブランチを merge commit の位置だけで通す —— %s", async (_shape, rolledBack) => {
  const workspace = await makeWorkspace("landing-dormant-merge-folded");
  const { db, clock } = await openBoard();
  const { works, questions } = await dormantSerialLanding(db, clock, workspace);
  const beforeMerge = git(workspace.path, "rev-parse", "refs/heads/main");
  await answerMerge(db, clock, workspace, questions[1]!);
  if (rolledBack) git(workspace.path, "reset", "--hard", beforeMerge);

  const answered = answerMerge(db, clock, workspace, questions[2]!);

  if (rolledBack) {
    await expect(answered).rejects.toThrow(DomainError);
    expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined();
  } else {
    await answered;
    expect(git(workspace.path, "rev-list", "--count", `main..task/${works[2]!.id}`)).toBe("0");
    expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  }
});

it("休止中の merge 回答は checkout ごと merge commit へ進め、作業ツリーはその内容になる", async () => {
  const workspace = await makeWorkspace("landing-dormant-merge-checkout");
  const { db, clock } = await openBoard();
  const { works, questions } = await dormantSerialLanding(db, clock, workspace);
  const protectedBefore = git(workspace.path, "rev-parse", "refs/heads/main");

  await answerMerge(db, clock, workspace, questions[1]!);

  // 第1親は保護ブランチの先の位置 —— first-parent の履歴が保護ブランチの歩みのまま残る
  expect(git(workspace.path, "rev-parse", "main^1")).toBe(protectedBefore);
  expect(git(workspace.path, "rev-parse", "main^2")).toBe(git(workspace.path, "rev-parse", `task/${works[1]!.id}`));
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(git(workspace.path, "rev-parse", "refs/heads/main"));
  expect(readFileSync(join(workspace.path, "first.txt"), "utf8")).toBe("first\n");
  expect(readFileSync(join(workspace.path, "second.txt"), "utf8")).toBe("second\n");
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
});

it("休止中の着地がコンフリクトしても、中断した merge を残さない", async () => {
  const workspace = await makeWorkspace("landing-dormant-conflict");
  const { db, clock } = await openBoard();
  const base = await tempDir("tidepool-task-checkouts-");
  const first = await recordedWork(db, clock, workspace, "from the first task\n");
  const second = await recordedWork(db, clock, workspace, "from the second task\n");
  await answerMerge(db, clock, workspace, mergeQuestion(db, clock, { pending_local_merge_task_id: first.id }));

  await expect(
    answerMerge(db, clock, workspace, mergeQuestion(db, clock, { pending_local_merge_task_id: second.id }), base),
  ).rejects.toThrow(`task/${second.id} does not merge cleanly into 'main'. The board opened the workbench at`);

  expect(() => git(workspace.path, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toThrow();
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
});

/** local 着地の conflict(H7): 先の task が着地した保護ブランチへ、同じファイルを変えた task の `merge` が conflict する盤面。`others` は
 *  先の着地の前に作る別の task(既定の file は同じなのでそれも conflict する)。作業台の基点は回答が渡す `workspacesDir`。 */
async function localLandingConflict(name: string, others: Array<[content: string, file?: string]> = []) {
  const workspace = await makeWorkspace(name);
  const { db, clock } = await openBoard();
  const base = await tempDir("tidepool-workbenches-");
  const answerOn = (question: Task) => answerMerge(db, clock, workspace, question, base);
  const first = await recordedWork(db, clock, workspace, "from the first task\n");
  /** 着地を待つ task: その merge question、作業台、text A3、作業台での解決、回答。 */
  const landing = async (content: string, file?: string) => {
    const work = await recordedWork(db, clock, workspace, content, file);
    const question = mergeQuestion(db, clock, { pending_local_merge_task_id: work.id });
    const source = `task/${work.id}`;
    const workbench = () => realpathSync(workbenchPath(base, { workspace: workspace.name }, source));
    /** spec #3273 text A3。 */
    const refused = () =>
      new DomainError(
        `${source} does not merge cleanly into 'main'. The board opened the workbench at ${workbench()} for it. There, on main, ` +
          `run \`git merge board/${source}\` and resolve the conflict (or, in your own clone with the workbench as a remote: fetch it, ` +
          `\`git merge <remote>/board/${source}\`, and push main to it). Your tip must contain both main as the board has it now ` +
          `(\`board/main\`) and ${source}, with nothing uncommitted. Then answer \`merge\` again.`,
      );
    /** 人間が作業台の main で `board/<ref>`(既定は task のブランチ)を merge し、conflict を解いて commit する。 */
    const resolve = (body = "from both tasks\n", ref = source) => {
      expect(() => git(workbench(), "merge", `board/${ref}`)).toThrow();
      writeFileSync(join(workbench(), "feature.txt"), body);
      git(workbench(), "add", "feature.txt");
      git(workbench(), "commit", "--no-edit");
      return git(workbench(), "rev-parse", "HEAD");
    };
    return { work, question, source, workbench, refused, resolve, answer: () => answerOn(question) };
  };
  const c = await landing("from the second task\n");
  const more = [];
  for (const [content, file] of others) more.push(await landing(content, file));
  await answerOn(mergeQuestion(db, clock, { pending_local_merge_task_id: first.id }));
  /** 今の保護ブランチを控え、拒否が何も書いていないこと(ref・event・question)を確かめる手を返す。 */
  const unchanged = () => {
    const protectedSha = git(workspace.path, "rev-parse", "refs/heads/main");
    return () => {
      expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(protectedSha);
      expect(listEventsOfKinds(db, ["workbench_taken_in"])).toEqual([]);
      expect(boardEvents(db, c.work.id, "local_merge_executed")).toEqual([]);
      expect(getTask(db, c.question.id)?.status).toBe("todo");
    };
  };
  return { workspace, db, clock, base, ...c, others: more, answerOn, unchanged };
}

type LocalLandingConflict = Awaited<ReturnType<typeof localLandingConflict>>;

// ADR 0371 決定2・4・11 / ADR 0382 決定1・5 / spec #3273 pin A9: local 着地の conflict は (workspace, 保護ブランチ, task のブランチ) の作業台を
// 開いて拒み(text A3)、作業台で merge した次の `merge` がその tip を取り込む —— 包む commit が着地で、根に刻む執行の記録もそれを指し、
// 取り込んだままの作業台は消える
it("local 着地の merge が conflict すれば作業台を名指して拒み何も書かず、作業台で merge した次の merge が取り込んで着地する", async () => {
  const c = await localLandingConflict("local-landing-workbench");
  const { workspace, db } = c;
  const nothingWritten = c.unchanged();
  const before = git(workspace.path, "rev-parse", "refs/heads/main");

  await expect(c.answer()).rejects.toThrow(c.refused());
  nothingWritten();

  const tip = c.resolve();
  await c.answer();

  const landed = git(workspace.path, "rev-parse", "refs/heads/main");
  expect(git(workspace.path, "rev-list", "--parents", "-n", "1", landed).split(" ").slice(1)).toEqual([before, tip]);
  expect(git(workspace.path, "rev-parse", `${landed}^{tree}`)).toBe(git(workspace.path, "rev-parse", `${tip}^{tree}`));
  expect(git(workspace.path, "merge-base", "--is-ancestor", c.source, "main")).toBe("");
  expect(git(workspace.path, "show", "main:feature.txt")).toBe("from both tasks");
  // 名前の場所は保護ブランチに居て作業ツリーも追従する(ADR 0356 決定5)
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(landed);
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect(boardEvents(db, c.work.id, "local_merge_executed")).toEqual([{ actor_id: HUMAN_ACTOR_ID, origin: "webui", payload: { kind: "local_merge_executed", sha: landed } }]);
  expect(listEventsOfKinds(db, ["workbench_taken_in"]).map(({ actor_id, payload }) => ({ actor_id, payload }))).toEqual([
    { actor_id: HUMAN_ACTOR_ID, payload: { kind: "workbench_taken_in", workspace: workspace.name, target: "refs/heads/main", tip, commit: landed, entry: "landing_merge" } },
  ]);
  expect(getTask(db, c.question.id)?.status).toBe("done");
  expect(existsSync(workbenchPath(c.base, { workspace: workspace.name }, c.source))).toBe(false);
});

// ADR 0382 決定5 / spec #3273 text C6: 取り込みの後も人間の作業が残る作業台は残し、その branch を包む commit へ進め、応答が C6 を言う
it("local 着地の取り込みの後に作業台に人間の作業が残れば、作業台を残してその branch を包む commit へ進め、応答が text C6 を言う", async () => {
  const c = await localLandingConflict("local-landing-kept-workbench");
  await expect(c.answer()).rejects.toThrow(c.refused());
  const tip = c.resolve();
  git(c.workbench(), "checkout", "--quiet", "-b", "side");
  commitWork(c.workbench(), "side.txt", "the human's other work\n");
  git(c.workbench(), "checkout", "--quiet", "main");

  const answered = await c.answer();

  const landed = git(c.workspace.path, "rev-parse", "refs/heads/main");
  expect(answered.notice).toBe(`took ${tip} in as ${landed} on main. In a clone, fetch the workbench and fast-forward to \`board/main\` before you write on.`);
  expect(git(c.workbench(), "rev-parse", "main")).toBe(landed);
  expect(git(c.workbench(), "rev-parse", "board/main")).toBe(landed);
  expect(git(c.workbench(), "status", "--porcelain")).toBe("");
});

// ADR 0401 決定1 の (3): 取り込みの ref と event を書いた後に作業台を消せなくても回答は拒まず、根に執行を刻み、作業台の在り処と原因を言う
it("local 着地の取り込みの後に作業台を消せなければ、回答は通って根に執行を刻み、notice が作業台を消せなかったことと在り処を言う", async () => {
  const c = await localLandingConflict("local-landing-unremovable-workbench");
  const before = git(c.workspace.path, "rev-parse", "refs/heads/main");
  await expect(c.answer()).rejects.toThrow(c.refused());
  c.resolve();
  lockDirInside(c.workbench());
  const tip = git(c.workbench(), "rev-parse", "HEAD");
  const at = c.workbench();

  const answered = await c.answer();

  const landed = git(c.workspace.path, "rev-parse", "refs/heads/main");
  expect(git(c.workspace.path, "rev-list", "--parents", "-n", "1", landed).split(" ").slice(1)).toEqual([before, tip]);
  expect(boardEvents(c.db, c.work.id, "local_merge_executed")).toEqual([{ actor_id: HUMAN_ACTOR_ID, origin: "webui", payload: { kind: "local_merge_executed", sha: landed } }]);
  expect(getTask(c.db, c.question.id)?.status).toBe("done");
  const [said, exit] = notRemoved(`took ${tip} in as ${landed} on main.`, at);
  expect(answered.notice).toContain(said);
  expect(answered.notice?.endsWith(exit)).toBe(true);
});

// ADR 0401 決定4: 取り込みで着地した後・記録の前に死んだ盤面の答え直しは、取り込みの後の片付けと同じに、人間の作業が残る作業台は残して
// text C6 を言い、残っていなければ消す
/** 作業台の取り込みで着地し、人間の別の branch が残るので作業台は残った盤面 —— 回答の記録は刻まない(question は開いたまま)。
 *  `beforeLanding` は解決の後・着地の前に作業台へ掛ける手。 */
async function landedThroughKeptWorkbench(name: string, beforeLanding?: (workbench: string) => void) {
  const c = await localLandingConflict(name);
  await expect(c.answer()).rejects.toThrow(c.refused());
  c.resolve();
  beforeLanding?.(c.workbench());
  const tip = git(c.workbench(), "rev-parse", "HEAD");
  git(c.workbench(), "checkout", "--quiet", "-b", "side");
  commitWork(c.workbench(), "side.txt", "the human's other work\n");
  git(c.workbench(), "checkout", "--quiet", "main");
  const intake = { ...CLEAN_LANDING_INTAKE, workbenchBase: c.base };
  const { landed, kept } = mergeTaskToProtected(c.db, c.workspace, c.work.id, intake);
  const notice = `took ${tip} in as ${landed} on main. In a clone, fetch the workbench and fast-forward to \`board/main\` before you write on.`;
  expect(kept).toBe(notice);
  return { ...c, tip, landed, notice, again: () => mergeTaskToProtected(c.db, c.workspace, c.work.id, intake) };
}

// ADR 0382 決定5: tip が取り込んだまま(包む commit へ進めた後でも、進める前に死んでも)なら、人間の作業が残る間は残して text C6 を言い、
// 残らなくなれば消す
it("取り込みで着地した task をもう一度着地させると、commit を足さずに包む commit を返し、人間の作業が残る作業台は残し、残らなくなれば消す", async () => {
  const c = await landedThroughKeptWorkbench("local-landing-reanswer-workbench");

  expect(c.again()).toEqual({ landed: c.landed, kept: c.notice });
  expect(git(c.workbench(), "rev-parse", "main")).toBe(c.landed);

  // 包む commit へ進める前に死んだ形: 作業台の tip は取り込んだ tip のまま
  git(c.workbench(), "update-ref", "refs/heads/main", c.tip);
  expect(c.again()).toEqual({ landed: c.landed, kept: c.notice });
  expect(git(c.workbench(), "rev-parse", "main")).toBe(c.landed);

  git(c.workbench(), "branch", "--quiet", "-D", "side");
  git(c.workbench(), "update-ref", "refs/heads/main", c.tip);
  expect(c.again()).toEqual({ landed: c.landed, kept: undefined });
  expect(existsSync(workbenchPath(c.base, { workspace: c.workspace.name }, c.source))).toBe(false);
  expect(git(c.workspace.path, "rev-parse", "refs/heads/main")).toBe(c.landed);
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toHaveLength(1);
});

it("取り込みで着地した後に作業台へ人間の commit が届いていれば、もう一度着地させても取り込まずに作業台を残してそう言う", async () => {
  const c = await landedThroughKeptWorkbench("local-landing-reanswer-workbench-moved");
  commitWork(c.workbench(), "later.txt", "after the crash\n");
  const moved = git(c.workbench(), "rev-parse", "main");
  const at = c.workbench();

  expect(c.again()).toEqual({ landed: c.landed, kept: `Commits reached the workbench at ${at} after the board read it and were not taken in; the workbench is kept.` });
  expect(git(c.workbench(), "rev-parse", "main")).toBe(moved);
  expect(git(c.workspace.path, "rev-parse", "refs/heads/main")).toBe(c.landed);
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toHaveLength(1);
});

// ADR 0382 決定5: tip が取り込んだ tip でも包む commit でもなければ、新しい commit が無くても取り込んだままと読まず、何もせず残す
it("取り込みで着地した後に作業台の tip が新しい commit なしにほかへ動いていれば、もう一度着地させても作業台を消さず何も言わない", async () => {
  const c = await landedThroughKeptWorkbench("local-landing-reanswer-workbench-reset");
  git(c.workbench(), "branch", "--quiet", "-D", "side");
  git(c.workbench(), "reset", "--hard", "--quiet", `${c.landed}^1`);

  expect(c.again()).toEqual({ landed: c.landed, kept: undefined });
  expect(existsSync(workbenchPath(c.base, { workspace: c.workspace.name }, c.source))).toBe(true);
  expect(git(c.workbench(), "rev-parse", "main")).toBe(git(c.workspace.path, "rev-parse", `${c.landed}^1`));
});

// ADR 0401 決定1 の (3) / 決定4: 答え直しの片付けも、作業台を消せなければ黙らずに在り処と原因を言う
it("取り込みで着地した task をもう一度着地させるとき作業台を消せなければ、kept が作業台を消せなかったことと在り処を言う", async () => {
  const c = await landedThroughKeptWorkbench("local-landing-reanswer-unremovable", lockDirInside);
  git(c.workbench(), "branch", "--quiet", "-D", "side");
  const at = c.workbench();

  const again = c.again();

  expect(again.landed).toBe(c.landed);
  const [said, exit] = notRemoved(`took ${c.tip} in as ${c.landed} on main.`, at);
  expect(again.kept).toContain(said);
  expect(again.kept?.endsWith(exit)).toBe(true);
});

// ADR 0371 決定3・5 / spec #3273 pin A4: 受け取る条件は保護ブランチの今の値と task の tip を祖先に持つことで、人間しか書けない path は
// この入口では拒む。拒否は何も書かない
it.each([
  [
    "人間の merge の後に兄弟が着地し、tip が保護ブランチの今の値を持たない",
    async (c: LocalLandingConflict) => {
      const sibling = await recordedWork(c.db, c.clock, c.workspace, "from a sibling\n", "sibling.txt");
      await c.answerOn(mergeQuestion(c.db, c.clock, { pending_local_merge_task_id: sibling.id }));
      c.resolve();
    },
    (c: LocalLandingConflict) => `${c.workbench()} is not ready: main there does not contain main (\`board/main\`)`,
  ],
  [
    "task を merge せずに保護ブランチへ commit した",
    async (c: LocalLandingConflict) => {
      commitWork(c.workbench(), "feature.txt", "only the human's\n");
    },
    (c: LocalLandingConflict) => `${c.workbench()} is not ready: main there does not contain ${c.source} (\`board/${c.source}\`)`,
  ],
  [
    "merge で人間しか書けない path を変えた",
    async (c: LocalLandingConflict) => {
      c.resolve();
      commitWork(c.workbench(), ".mcp.json", "{}\n");
    },
    // spec #3273 text A7c: purely-local の出口は、intake question が開いていなければ open_workbench
    (c: LocalLandingConflict) =>
      `the tip of the workbench at ${c.workbench()} changes .mcp.json, which is written only by a human; take that change out and commit, then answer again. ` +
      `To change a human-only path, open a workbench for ${c.workspace.name} (\`open_workbench\`).`,
  ],
])("local 着地の merge は作業台の tip を拒めば何も書かない —— %s", async (_case, write, says) => {
  const c = await localLandingConflict("local-landing-refused");
  await expect(c.answer()).rejects.toThrow(c.refused());
  await write(c);
  const nothingWritten = c.unchanged();

  const refused = c.answer();

  await expect(refused).rejects.toThrow(DomainError);
  await expect(refused).rejects.toThrow(says(c));
  nothingWritten();
});

// spec #3273 text A7c: intake question が開いていれば、人間しか書けない path の拒否はその question を名指す
it("intake question が開いていれば、local 着地の merge の人間しか書けない path の拒否はその question を名指す", async () => {
  const c = await localLandingConflict("local-landing-human-only-intake");
  await expect(c.answer()).rejects.toThrow(c.refused());
  c.resolve();
  commitWork(c.workbench(), ".mcp.json", "{}\n");
  await openHumanContentWorkbench(c.db, c.workspace, c.base, HUMAN_ANSWERER, () => c.clock.now(), { resolveRegistered: undefined });
  const intake = openIntakeQuestionId(c.db, c.workspace.name)!;
  const nothingWritten = c.unchanged();

  await expect(c.answer()).rejects.toThrow(
    `which is written only by a human; take that change out and commit, then answer again. To change a human-only path, use the intake question ${intake} of workspace ${c.workspace.name}.`,
  );
  nothingWritten();
});

// ADR 0371 決定4 / ADR 0373 決定8: `merge` は in-flight の守りの対象ではなく、同時の回答は旧値の CAS で守る
it("workspace の in-flight の鍵が取られている間も、local 着地の merge は作業台の merge を取り込んで着地する", async () => {
  const c = await localLandingConflict("local-landing-in-flight");
  await expect(c.answer()).rejects.toThrow(c.refused());
  const tip = c.resolve();
  const release = takeWorkspaceInFlightKey(c.db, c.workspace.name)!;
  try {
    await c.answer();
  } finally {
    release();
  }

  expect(getTask(c.db, c.question.id)?.status).toBe("done");
  expect(git(c.workspace.path, "rev-parse", "main^2")).toBe(tip);
});

// ADR 0382 決定4: 答えている task の tip にある commit は数えない —— merge back された子のブランチの commit もそこにある
it("merge back された子を持つ task の local 着地は、作業台で merge した次の merge で着地する", async () => {
  const c = await localLandingConflict("local-landing-merged-back-child");
  const child = attachUnsettledChild(c.db, c.clock, c.work.id);
  const place = await prepareAtPickup(c.db, c.workspace, child);
  commitWork(place.path, "child.txt", "from the child\n");
  recordTaskCheckoutTip(c.db, place, child.id);
  finish(c.db, c.clock, child);
  releaseWorkspace(c.db, place, getTask(c.db, child.id)!, c.clock.now(), true);
  await expect(c.answer()).rejects.toThrow(c.refused());
  c.resolve();

  await c.answer();

  expect(getTask(c.db, c.question.id)?.status).toBe("done");
  expect(git(c.workspace.path, "show", "main:child.txt")).toBe("from the child");
});

// ADR 0382 決定1(#3352 の観測1): 着地の作業台は task ごと —— 別の task の作業台に残る人間の merge を、clean な着地は読まない
it("別の task の作業台に人間の merge が残っていても、clean な local 着地は盤面の merge で着地する", async () => {
  const c = await localLandingConflict("local-landing-other-workbench", [["from a clean task\n", "clean.txt"]]);
  const [clean] = c.others;
  await expect(c.answer()).rejects.toThrow(c.refused());
  c.resolve();

  await clean!.answer();

  expect(getTask(c.db, clean!.question.id)?.status).toBe("done");
  expect(git(c.workspace.path, "show", "main:clean.txt")).toBe("from a clean task");
  expect(() => git(c.workspace.path, "merge-base", "--is-ancestor", c.source, "main")).toThrow();
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toEqual([]);
});

// ADR 0382 決定4(#3352 の観測2): local 着地は、答えている task 以外のどの task のブランチの commit を持つ tip も拒む —— task の内容は
// 自分の着地でだけ保護ブランチに入る(ADR 0371 決定6)。cancel 済みの task も数える
it.each([
  ["着地を待つ", (_c: LocalLandingConflict) => {}],
  [
    "cancel 済みの",
    (c: LocalLandingConflict) => {
      cancelTaskDirectly(c.db, getTask(c.db, c.others[0]!.work.id)!, null, c.clock.now(), {}, "webui");
      expect(getTask(c.db, c.others[0]!.work.id)?.status).toBe("cancelled");
    },
  ],
])("作業台で%s別の task のブランチも merge した tip は、local 着地の merge が拒み何も書かない", async (_case, settle) => {
  const c = await localLandingConflict("local-landing-other-task", [["from another task\n", "other.txt"]]);
  const [other] = c.others;
  await expect(c.answer()).rejects.toThrow(c.refused());
  c.resolve();
  git(c.workbench(), "merge", "--no-edit", `board/${other!.source}`);
  settle(c);
  const nothingWritten = c.unchanged();

  const refused = c.answer();

  await expect(refused).rejects.toThrow(DomainError);
  await expect(refused).rejects.toThrow(
    `the tip of the workbench at ${c.workbench()} contains commits of ${other!.source}, and a task's work enters main only through its own landing. ` +
      `Start main in the workbench over with \`git reset --hard board/main\` — this drops your merge there too — then merge only \`board/${c.source}\`, ` +
      "resolve its conflict again and answer again.",
  );
  nothingWritten();
});

// ADR 0382 決定1・4: 2つの task がそれぞれ conflict しても作業台は別で、互いの内容で拒み合わない。先に着地した task の commit は保護ブランチに
// あるので、後の task の作業台がそれを merge しても数えない(後の取り込みは保護ブランチの今の値を欠いて A7a で1回増える、ADR 0382 帰結)
it("2つの task の local 着地がそれぞれ conflict しても互いを拒まず、先の着地を merge した後の task も着地する", async () => {
  const c = await localLandingConflict("local-landing-two-conflicts", [["from a third task\n"]]);
  const [later] = c.others;
  await expect(c.answer()).rejects.toThrow(c.refused());
  await expect(later!.answer()).rejects.toThrow(later!.refused());
  expect(later!.workbench()).not.toBe(c.workbench());
  c.resolve();
  later!.resolve("from the first and third tasks\n");

  await c.answer();
  await expect(later!.answer()).rejects.toThrow(`${later!.workbench()} is not ready: main there does not contain main (\`board/main\`)`);
  later!.resolve("from all three tasks\n", "main");
  await later!.answer();

  expect(getTask(c.db, later!.question.id)?.status).toBe("done");
  expect(git(c.workspace.path, "show", "main:feature.txt")).toBe("from all three tasks");
  for (const source of [c.source, later!.source]) expect(git(c.workspace.path, "merge-base", "--is-ancestor", source, "main")).toBe("");
});

// 旧(#1872): 走っている session の worker が名前の場所で保護ブランチを checkout していれば、merge 回答は checkout ごと ff した。
// ADR 0356 決定1・5 の後、worker は task の checkout で走り、名前の場所の HEAD は常に保護ブランチなので、merge 回答はいつも
// 名前の場所の作業ツリーを追従させる
/** 着地を待つ work と、DB 上で走っている(拾われた)session が task の checkout に untracked の WIP を書いた形。 */
async function landingUnderRunningSession(board: Db, clock: FakeClock, workspace: WorkspaceConfig, wipFile: string) {
  const work = await recordedWork(board, clock, workspace);
  const question = mergeQuestion(board, clock, { pending_local_merge_task_id: work.id });
  const running = pickupTask(board, landingWork(board, clock), "worker", clock.now())!;
  const place = await prepareAtPickup(board, workspace, running);
  writeFileSync(join(place.path, wipFile), "the running session's work in progress\n");
  return { work, question, place };
}

it("走っている session の間も merge 回答は名前の場所を checkout ごと ff し、task の checkout の WIP に触れず quarantine しない(ADR 0356 決定1・5)", async () => {
  const workspace = await makeWorkspace("landing-worker-on-protected");
  const { db, clock } = await openBoard();
  const { work, question, place } = await landingUnderRunningSession(db, clock, workspace, "wip.txt");

  await answerMerge(db, clock, workspace, question);

  const tip = git(workspace.path, "rev-parse", `refs/heads/task/${work.id}`);
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(tip);
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(tip);
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect(readFileSync(join(place.path, "wip.txt"), "utf8")).toBe("the running session's work in progress\n");
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

// 旧: 保護ブランチを checkout した worker の WIP が着地の運ぶファイルと被った形(#1872)。名前の場所の作業ツリーに被るものを
// 置けるのはもう盤面の外の書き手だけ
it("名前の場所の作業ツリーの untracked が着地の運ぶファイルと被れば、ff の拒否が回答の拒否として返り、何も動かさない(ADR 0356 決定5)", async () => {
  const workspace = await makeWorkspace("landing-worker-on-protected-overlap");
  const { db, clock } = await openBoard();
  const before = git(workspace.path, "rev-parse", "refs/heads/main");
  const { question } = await landingUnderRunningSession(db, clock, workspace, "unrelated.txt");
  writeFileSync(join(workspace.path, "feature.txt"), "the running session's work in progress\n");

  await expect(answerMerge(db, clock, workspace, question)).rejects.toThrow("would be overwritten");

  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(before);
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(join(workspace.path, "feature.txt"), "utf8")).toBe("the running session's work in progress\n");
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(getTask(db, question.id)?.status).toBe("todo");
});

/** 付帯子の門で着地が止まった記録 —— `land()` が残す形。 */
function deferLanding(board: Db, taskId: string, now: Date): void {
  appendEvent(board, {
    taskId,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    payload: { kind: "landing_deferred", reason: "attached_children", count: 1 },
    at: now,
  });
}

/** 下の3つの観測の題材の盤面。PR を持つ根は出元 repo へ push してから PR を開いているので、その名前は出元 repo を宣言している
 *  (ADR 0395 決定2)。 */
async function observationBoard() {
  const { workspace: observationWorkspace } = await makeLandingWorkspace("reef");
  return { ...(await openBoard()), observationWorkspace };
}

it("既定 agent の quarantine 回答前の観測は、assignee 未指定の work の外部 merge を記録してキューを退ける", async () => {
  const { db, clock, observationWorkspace } = await observationBoard();
  const work = completeTask(db, landingWork(db, clock), FULL_HANDOFF, "tako", clock.now(), "worker");
  recordPrOpenedOutsideConvergence(db, work, 7, clock.now(), {
    authority: { merge: "auto_if_ci_green" },
    workspace: observationWorkspace,
  });
  const github = new FakeGitHubClient();
  github.scriptMergedOutside(7);
  const landing = createLanding({
    db,
    clock,
    workspace: observationWorkspace,
    github,
    defaultAgentName: "tako",
  });

  await landing.observeAutoMergeOutcomes("shako");
  expect(taskIdsAwaitingLanding(db, undefined, "tako", "tako")).toHaveLength(1);
  await landing.observeAutoMergeOutcomes("tako");

  expect(taskIdsAwaitingLanding(db, undefined, "tako", "tako")).toHaveLength(0);
  expect(listEvents(db, work.id).filter((event) => event.payload.kind === "pr_merge_observed")).toMatchObject([
    { origin: "board", actor_id: BOARD_ACTOR_ID, payload: { kind: "pr_merge_observed", pr_number: 7 } },
  ]);
});

it("quarantine 回答前の観測は、盤面の名義で merge 済みのキューの PR を pr_merged として根に刻みキューから外す(ADR 0265 決定5)", async () => {
  const { db, clock, observationWorkspace } = await observationBoard();
  const work = completeTask(db, landingWork(db, clock), FULL_HANDOFF, "tako", clock.now(), "worker");
  recordPrOpenedOutsideConvergence(db, work, 7, clock.now(), {
    authority: { merge: "auto_if_ci_green" },
    workspace: observationWorkspace,
  });
  const github = new FakeGitHubClient();
  github.scriptMergedByBoard(7);
  const landing = createLanding({
    db,
    clock,
    workspace: observationWorkspace,
    github,
    defaultAgentName: "tako",
  });

  await landing.observeAutoMergeOutcomes("tako");

  expect(taskIdsAwaitingLanding(db, undefined, "tako", "tako")).toHaveLength(0);
  expect(boardEvents(db, work.id, "pr_merged")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merged", pr_number: 7 } },
  ]);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([]);
});

it("quarantine 回答前の観測は、盤面の外で閉じられたキューの PR を閉じた観測としてキューから外す(ADR 0229 決定4)", async () => {
  const { db, clock, observationWorkspace } = await observationBoard();
  const work = completeTask(db, landingWork(db, clock), FULL_HANDOFF, "tako", clock.now(), "worker");
  recordPrOpenedOutsideConvergence(db, work, 7, clock.now(), {
    authority: { merge: "auto_if_ci_green" },
    workspace: observationWorkspace,
  });
  const github = new FakeGitHubClient();
  github.scriptClosedOutside(7);
  const landing = createLanding({
    db,
    clock,
    workspace: observationWorkspace,
    github,
    defaultAgentName: "tako",
  });

  await landing.observeAutoMergeOutcomes("tako");

  expect(taskIdsAwaitingLanding(db, undefined, "tako", "tako")).toHaveLength(0);
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(7));
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([]);
});

it.each(["auto_merge", "promotion_failure"] as const)("assignee 未指定の完了 work が %s を待つとき、既定 agent の着地待ちに数える", (waiting) => {
  db = openDb(":memory:");
  const clock = new FakeClock();
  const work = completeTask(db, landingWork(db, clock), FULL_HANDOFF, "tako", clock.now(), "worker");
  if (waiting === "auto_merge") {
    recordPrOpenedOutsideConvergence(db, work, 7, clock.now(), {
      authority: { merge: "auto_if_ci_green" },
    });
  } else {
    registerPrPromotionFailureQuestion(db, work, "boom", clock.now());
  }

  expect(taskIdsAwaitingLanding(db, undefined, "tako", "tako")).toEqual([work.id]);
  expect(taskIdsAwaitingLanding(db, undefined, "shako", "tako")).toHaveLength(0);
  expect(taskIdsAwaitingLanding(db, undefined, "tako")).toHaveLength(0);
});

// ADR 0241 決定6: 待ちの証拠の寄せ集めではなく、収束が導く根から数える —— quarantine が抱えている根は失敗 question を持たない
it("着地を待つ完了タスクは、PR をまだ開いていない未着地の根(門・失敗 question・retry で止まったもの、待ちの証拠を何も持たないもの)と無人 merge キューにいるものを数える", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  deferLanding(db, completedWork(db, now, "tako").id, now);
  recordPrOpenedOutsideConvergence(db, completedWork(db, now, "tako"), 7, now, {
    authority: { merge: "auto_if_ci_green" },
  });
  registerPrPromotionFailureQuestion(db, completedWork(db, now, "tako"), "boom", now);
  const retried = completedWork(db, now, "tako");
  registerPrPromotionFailureQuestion(db, retried, "boom", now);
  const [failure] = promotionFailures(db, retried.id);
  answerQuestion(db, getTask(db, failure!.id)!, ["retry"], now, undefined, undefined, undefined, "webui");
  completedWork(db, now, "tako");

  expect(taskIdsAwaitingLanding(db, undefined, "tako")).toHaveLength(5);
});

it("parentless landing questions register in the completed task's workspace", () => {
  db = openDb(":memory:");
  const now = new Date(0);
  const prWork = completedWork(db, now, "tako", undefined, "reef");
  const failedWork = completedWork(db, now, "tako", undefined, "reef");
  const localWork = completedWork(db, now, "tako", undefined, "reef");

  recordPrOpenedOutsideConvergence(db, prWork, 7, now, { authority: { merge: "escalate" } });
  registerPrPromotionFailureQuestion(db, failedWork, "push failed", now);
  registerLocalMergeQuestion(db, localWork, "merge it", now);

  const questions = listBoard(db).filter((task) => task.type === "question");
  expect(questions).toEqual(expect.arrayContaining([
    expect.objectContaining({ question_pending_merge_pr: 7, parent_id: null, workspace: "reef" }),
    expect.objectContaining({ question_pending_pr_promotion_task_id: failedWork.id, parent_id: null, workspace: "reef" }),
    expect.objectContaining({ question_pending_local_merge_task_id: localWork.id, parent_id: null, workspace: "reef" }),
  ]));
});

/** 失敗 question に abandon promotion と答えた完了 work —— 断念が効いている。 */
async function abandonedWork(board: Db, now: Date, workspace?: string): Promise<Task> {
  const work = completedWork(board, now, "tako", undefined, workspace);
  registerPrPromotionFailureQuestion(board, work, "boom", now);
  const [failure] = promotionFailures(board, work.id);
  await answerPromotion(board, new FakeClock(), unusedLanding, undefined, failure!, "abandon promotion");
  return work;
}

it("着地済み・未完了・別 agent・PR 昇格を abandon した・祖先の枝に乗る子は、着地を待つ完了タスクに数えない", async () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  recordPrOpenedOutsideConvergence(db, completedWork(db, now, "tako"), 7, now, { authority: { merge: "escalate" } });
  completedWork(db, now, "squid");
  await abandonedWork(db, now);
  // 未完了の親と、その枝へ帰る完了した子(収束は何も記録しない)
  const parent = registerTask(
    db,
    { type: "work", title: "integrate", purpose: "p", completion_criteria: "c", assignee: "tako", workspace: "reef" },
    now,
    ...HUMAN_WEBUI,
  );
  appendEvent(db, { taskId: parent.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_branch_created", sha: "0".repeat(40), workspace: "reef" }, at: now });
  completedWork(db, now, "tako", parent.id);

  // 根かどうかを lineage で読ませる —— 祖先が未決着なら git を呼ばずにその枝へ帰るので、checkout の実体は要らない
  expect(taskIdsAwaitingLanding(db, () => ({ name: "reef", path: "/nonexistent/reef" }), "tako")).toHaveLength(0);
});

// ADR 0241 決定6: 1回の要求で導出は1回。数えは何も書かない —— 根かどうか読めない候補を workspace の quarantine に落とさない
it("数えは導出を1回だけ走らせ、workspace を解決できない候補も根として数え、quarantine に落とさない", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  completedWork(db, now, "tako", undefined, "ghost");
  completedWork(db, now, "tako", undefined, "ghost");
  queuedForAutoMerge(db, now, "tako");
  let resolved = 0;
  const resolve = (name: string | null): WorkspaceConfig => {
    resolved += 1;
    throw new UnknownWorkspaceError(name ?? "reef");
  };

  expect(taskIdsAwaitingLanding(db, resolve, "tako")).toHaveLength(3);
  expect(resolved).toBe(3);
  expect(quarantineQuestion(db, "workspace", "ghost")).toBeUndefined();
});

// ADR 0226: workspace の削除の扉は同じ集合を、タスクの `workspace` の参照で数える
const completedWorkIn = (board: Db, now: Date, workspace?: string) =>
  completedWork(board, now, "tako", undefined, workspace);

it("workspace 名でも、無人 merge キューにいる・PR 昇格失敗の question が開いている・PR をまだ開いていない完了タスクを数える", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  const queued = completedWorkIn(db, now, "reef");
  recordPrOpenedOutsideConvergence(db, queued, 7, now, {
    authority: { merge: "auto_if_ci_green" },
  });
  const failed = completedWorkIn(db, now, "reef");
  registerPrPromotionFailureQuestion(db, failed, "boom", now);
  const unopened = completedWorkIn(db, now, "reef");

  expect(taskIdsAwaitingLandingInWorkspace(db, undefined, "reef").sort()).toEqual([queued.id, failed.id, unopened.id].sort());
});

it("workspace 名では、abandon 済み・着地済み・別 workspace・workspace 未指定の完了タスクを数えない", async () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  await abandonedWork(db, now, "reef");
  recordPrOpenedOutsideConvergence(db, completedWorkIn(db, now, "reef"), 7, now, { authority: { merge: "escalate" } });
  appendEvent(db, {
    taskId: completedWorkIn(db, now, "reef").id,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    payload: { kind: "nothing_to_land", base: "main" },
    at: now,
  });
  completedWorkIn(db, now, "lagoon");
  completedWorkIn(db, now);

  expect(taskIdsAwaitingLandingInWorkspace(db, undefined, "reef")).toHaveLength(0);
  expect(taskIdsAwaitingLandingInWorkspace(db, undefined, "lagoon")).toHaveLength(1);
});

// ADR 0234: 未決着タスクは、決着したときに着地し直す完了した work の祖先の workspace も参照する

/** reef の完了 work を、abandon promotion 済みか PR を開き終えた形にする。 */
function rerunnableWorkInReef(board: Db, now: Date, shape: "abandoned" | "pr_opened"): Task {
  const work = completedWork(board, now, "tako", undefined, "reef");
  if (shape === "pr_opened") {
    recordPrOpenedOutsideConvergence(board, work, 7, now, { authority: { merge: "escalate" } });
  } else {
    deferLanding(board, work.id, now);
    registerPrPromotionFailureQuestion(board, work, "boom", now);
    const [failure] = promotionFailures(board, work.id);
    answerQuestion(board, getTask(board, failure!.id)!, ["abandon promotion"], now, undefined, undefined, undefined, "webui");
  }
  return getTask(board, work.id)!;
}

/** 人間の門で、`parentId` の下に未決着の review を足す —— workspace は最も近い固定済みの祖先から導かれる(ADR 0290 決定1)。 */
function attachReview(board: Db, now: Date, parentId: string): Task {
  return registerTask(
    board,
    { type: "review", title: "second opinion", purpose: "p", completion_criteria: "c", assignee: "squid", parent_id: parentId },
    now,
    ...HUMAN_WEBUI,
  );
}

/** domain の registerTask で、`parentId` の下に workspace を明示した未決着の work を足す —— 人間の扉は子の workspace を拒む(ADR 0384 決定1)が、
 *  共有の registerTask は agent の分解のために #3423 まで明示を運ぶ。 */
function registerWorkChildIn(board: Db, now: Date, parentId: string, workspace: string): Task {
  return registerTask(
    board,
    { type: "work", title: "follow-up", purpose: "p", completion_criteria: "c", assignee: "squid", parent_id: parentId, workspace },
    now,
    ...HUMAN_WEBUI,
  );
}

it.each(["abandoned", "pr_opened"] as const)(
  "reef の完了 work(%s)の下にいる、別 workspace・workspace 未指定の未決着タスクを reef の参照に数え、reef にいる子は一度だけ数え、agent 名の参照には数えない",
  (shape) => {
    db = openDb(":memory:");
    const now = new Date("2026-10-10T00:00:00.000Z");
    const work = rerunnableWorkInReef(db, now, shape);
    settleReviews(db, now);
    // PR を開き終えた形では merge の question が reef を参照している
    const before = countUnsettledTasksReferencing(db, "workspace", "reef");

    registerWorkChildIn(db, now, work.id, "lagoon");
    attachReview(db, now, work.id);
    registerWorkChildIn(db, now, work.id, "reef");

    expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(before + 3);
    expect(countUnsettledTasksReferencing(db, "workspace", "lagoon")).toBe(1);
    expect(countUnsettledTasksReferencing(db, "assignee", "tako")).toBe(0);
  },
);

/** PR を持たずに着地した形 —— 収束の候補から外れる。 */
function landWithoutPr(board: Db, now: Date, work: Task, form: "nothing_to_land" | "local_merge_question"): void {
  if (form === "local_merge_question") {
    registerLocalMergeQuestion(board, work, "merge it", now);
    return;
  }
  appendEvent(board, {
    taskId: work.id,
    actorId: BOARD_ACTOR_ID,
    origin: "board",
    payload: { kind: "nothing_to_land", base: "main" },
    at: now,
  });
}

it.each(["nothing_to_land", "local_merge_question"] as const)(
  "PR を持たずに着地した(%s)完了 work の下の別 workspace の未決着タスクは数えず、導出で着く付帯子の review は数え(ADR 0290 決定5)、その上の着地し直す祖先の workspace の参照には数える",
  (form) => {
    db = openDb(":memory:");
    const now = new Date("2026-10-10T00:00:00.000Z");
    const landed = completedWork(db, now, "tako", undefined, "reef");
    landWithoutPr(db, now, landed, form);
    settleReviews(db, now);
    const before = countUnsettledTasksReferencing(db, "workspace", "reef");
    registerWorkChildIn(db, now, landed.id, "lagoon");
    expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(before);
    attachReview(db, now, landed.id);
    expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(before + 1);

    // reef の祖先 G の下で、lagoon の P が PR を持たずに着地した —— 収束は P を撃たず、G が着地し直す
    const grand = registerTask(
      db,
      { type: "work", title: "integrate", purpose: "p", completion_criteria: "c", assignee: "tako", workspace: "reef" },
      now,
      ...HUMAN_WEBUI,
    );
    const parent = completedWork(db, now, "tako", grand.id, "lagoon");
    landWithoutPr(db, now, parent, form);
    recordPrOpenedOutsideConvergence(db, completeTask(db, grand, FULL_HANDOFF, "tako", now, "worker"), 7, now, {
      authority: { merge: "escalate" },
    });
    settleReviews(db, now);
    const beforeGrand = countUnsettledTasksReferencing(db, "workspace", "reef");
    attachReview(db, now, parent.id);

    expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(beforeGrand + 1);
  },
);

// ADR 0225 / ADR 0394 決定5: abandon promotion が断念するのは question が問うた内容の昇格。付帯子の決着の後の収束は、
// question が問うた tip から内容が変わっていなければ何もせず、変わっていれば PR を開かずに昇格の question を立て直す
/** 完了した work の PR 昇格を失敗させ、人間が abandon promotion と答えた形。`askedTip: false` は tip を読めずに立った
 *  失敗 question への回答 —— 断った内容に tip が無い。 */
async function abandonedPromotion(name: string, { askedTip = true } = {}) {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const authority = { resolve: (): AuthorityProfile => profile("escalate") };
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => authority.resolve(),
  });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  // 完了時レビューを決着させてから着地する
  for (const review of listBoard(db).filter((t) => t.parent_id === work.id)) {
    settleReview(db, getTask(db, review.id)!, "shako", clock.now());
  }
  if (askedTip) {
    github.scriptFailure(new Error("token expired"));
    await landing.converge();
    github.scriptFailure(null);
  } else {
    registerPrPromotionFailureQuestion(db, getTask(db, work.id)!, "token expired", clock.now());
  }
  const [failure] = promotionFailures(db, work.id);
  await answerPromotion(db, clock, landing, workspace, failure!, "abandon promotion");
  return { db, clock, workspace, github, landing, authority, work: getTask(db, work.id)! };
}

// ADR 0225 決定1 / ADR 0394 決定5: 断念するのは question が問うた時点の内容(旧・回答の時点の tip)
it("PR 昇格の abandon promotion は question を立てた後に task ブランチが動いていても受理され、動いた tip でなく question が問うた tip を根に刻む", async () => {
  const { workspace, db, clock, landing, work } = await doneRootWithBaseline("landing-abandon-moved-ref");
  const asked = git(workspace.path, "rev-parse", `task/${work.id}`);
  registerPrPromotionFailureQuestion(db, work, "push failed", clock.now(), undefined, asked);
  const [failure] = openPromotionQuestions(db, work.id);
  const moved = commitOutOfBand(workspace, `task/${work.id}`);

  await expect(answerPromotion(db, clock, landing, workspace, failure!, "abandon promotion")).resolves.toMatchObject({ status: "done" });

  expect(moved).not.toBe(asked);
  expect(boardEvents(db, work.id, "landing_declined")).toEqual([
    { actor_id: HUMAN_ACTOR_ID, origin: "webui", payload: { kind: "landing_declined", question_id: failure!.id, tip: asked, outside: null, missing_branches: null } },
  ]);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

// ADR 0394 決定5: question が開いている間に届いた修理は、人間が見ていないので断念したことにならない
it("昇格失敗の question を立てた後に修理が届いてから abandon と答えても、次の収束は昇格の question を立て直す", async () => {
  const { db, clock, workspace, github, landing, work } = await doneRootWithBaseline("landing-abandon-after-repair");
  github.scriptFailure(new Error("token expired"));
  await landing.converge();
  github.scriptFailure(null);
  const [failure] = promotionFailures(db, work.id);
  await settleAttachedChild(db, clock, workspace, work.id, "repair");

  await answerPromotion(db, clock, landing, workspace, failure!, "abandon promotion");
  await landing.converge();

  expect(openPromotionQuestions(db, work.id).map(({ title, purpose }) => ({ title, purpose }))).toEqual([{
    title: "PR promotion re-asked: ship",
    purpose: `PR promotion for completed task "ship" was abandoned, but task/${work.id} no longer matches ` +
      "(or could not be compared with) the content that question asked about. Promote the current content?",
  }]);
});

/** 付帯子を登録して決着させる。`repair` があれば盤面の経路で親のブランチの内容を変える: 拾い(親のブランチから fork)、task の
 *  checkout で commit し、完了の門が tip を名前の場所へ引き(ADR 0356 決定3)、決着の後の後始末が親のブランチへ merge back する
 *  (ADR 0053 決定2)。 */
async function settleAttachedChild(
  board: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  parentId: string,
  repair?: string,
) {
  const child = attachUnsettledChild(board, clock, parentId);
  if (!repair) return completeTask(board, child, FULL_HANDOFF, "tako", clock.now(), "worker");
  const place = await prepareAtPickup(board, workspace, child);
  commitWork(place.path, `${repair}.txt`, "fixed\n");
  recordTaskCheckoutTip(board, place, child.id);
  const settled = completeTask(board, child, FULL_HANDOFF, "tako", clock.now(), "worker");
  releaseWorkspace(board, place, settled, clock.now(), true, undefined, undefined, true);
  return settled;
}

it("PR 昇格を abandon した後、内容を変えない付帯子が決着しても、profile が読めなくても、PR も question も立てず agent を quarantine に落とさない", async () => {
  const { db, clock, workspace, github, landing, authority, work } =
    await abandonedPromotion("landing-abandon-unchanged");
  authority.resolve = () => {
    throw new UnknownAgentError("tako");
  };

  await settleAttachedChild(db, clock, workspace, work.id);

  await landing.converge();

  expect(github.requests).toHaveLength(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
  expect(taskIdsAwaitingLanding(db, () => workspace, "tako", "tako")).toHaveLength(0);
});

it("PR 昇格を abandon した後、修理が内容を変えて決着すると、profile を読まず PR も開かずに昇格の question を1つ立て直し、retry と答えると PR が開く", async () => {
  const { db, clock, workspace, github, landing, authority, work } =
    await abandonedPromotion("landing-abandon-changed");
  authority.resolve = () => {
    throw new UnknownAgentError("tako");
  };

  await settleAttachedChild(db, clock, workspace, work.id, "repair");

  await landing.converge();

  expect(github.requests).toHaveLength(1);
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
  const reasked = openPromotionQuestions(db, work.id);
  expect(reasked).toMatchObject([
    {
      title: "PR promotion re-asked: ship",
      question_items: [{ options: ["retry", "abandon promotion"], recommendation: "retry" }],
    },
  ]);
  expect(taskIdsAwaitingLanding(db, () => workspace, "tako", "tako")).toHaveLength(1);

  authority.resolve = () => profile("escalate");
  await answerPromotion(db, clock, landing, workspace, reasked[0]!, "retry");

  expect(github.requests).toHaveLength(2);
  expect(getTask(db, work.id)?.pr_number).toBe(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

it("立て直した question への retry の時点で運ぶ内容が無ければ、回答を受理して着地対象なしを1件だけ刻む", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-reasked-nothing");
  await settleAttachedChild(db, clock, workspace, work.id, "repair");
  await landing.converge();
  const [reasked] = openPromotionQuestions(db, work.id);
  // 内容は盤面の外で保護ブランチに届き、盤面の fetch が写しを進める
  await squashTaskIntoOrigin(workspace, work.id);
  await refreshProtectedBranch(db, workspace, undefined, () => clock.now());

  await answerPromotion(db, clock, landing, workspace, reasked!, "retry");

  expect(getTask(db, reasked!.id)).toMatchObject({ status: "done", question_answer: ["retry"] });
  expect(listEvents(db, work.id).filter((e) => e.kind === "nothing_to_land")).toHaveLength(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(github.requests).toHaveLength(1);
});

it("PR 昇格を abandon した後に内容が変わっても、別の付帯子が未決着の間は門で待ち(待った記録は刻まず)question を立てず、その付帯子の決着で立てる", async () => {
  const { db, clock, workspace, landing, work } = await abandonedPromotion("landing-abandon-gate");
  const pending = attachUnsettledChild(db, clock, work.id);

  await settleAttachedChild(db, clock, workspace, work.id, "repair");
  await expect(landing.converge()).resolves.toEqual([
    { taskId: work.id, verdict: { kind: "deferred", reason: "attached_children", count: 1 } },
  ]);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(boardEvents(db, work.id, "landing_deferred")).toEqual([]);

  completeTask(db, pending, FULL_HANDOFF, "tako", clock.now(), "worker");

  await landing.converge();
  expect(openPromotionQuestions(db, work.id).map((q) => q.title)).toEqual(["PR promotion re-asked: ship"]);
});

it("立て直した question にもう一度 abandon と答えるとその question が問うた tip が刻まれ、内容を変えない次の決着では何も起きない", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-abandon-again");
  await settleAttachedChild(db, clock, workspace, work.id, "repair");
  await landing.converge();
  const [reasked] = openPromotionQuestions(db, work.id);

  await answerPromotion(db, clock, landing, workspace, reasked!, "abandon promotion");
  expect(boardEvents(db, work.id, "landing_declined").map(({ payload }) => payload)).toEqual([
    { kind: "landing_declined", question_id: expect.any(String), tip: expect.any(String), outside: null, missing_branches: null },
    { kind: "landing_declined", question_id: reasked!.id, tip: git(workspace.path, "rev-parse", `task/${work.id}`), outside: null, missing_branches: null },
  ]);

  await settleAttachedChild(db, clock, workspace, work.id);

  await landing.converge();
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(github.requests).toHaveLength(1);
});

// ADR 0394 決定5: 写すのは question の tip —— 立てた時点に tip を読めなかった question への abandon は、tip の無い記録になる(旧・回答の時点に読めなかった head)
it("tip を読めずに立った question への abandon は、内容を変えない次の決着でも昇格の question を立てる", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-abandon-no-head", {
    askedTip: false,
  });
  expect(latestEventOfTask(db, work.id, "landing_declined")?.payload.tip).toBeNull();
  const requests = github.requests.length;

  await settleAttachedChild(db, clock, workspace, work.id);

  await landing.converge();

  expect(openPromotionQuestions(db, work.id).map((q) => q.title)).toEqual(["PR promotion re-asked: ship"]);
  expect(github.requests).toHaveLength(requests);
});

// ADR 0234 決定3: 扉の外で消えた workspace を着地し直しで解決できないときも「変わった」と読む
it("PR 昇格を abandon した後、workspace を解決できないまま内容を変えない付帯子が決着しても昇格の question を立て直し、その retry は拒まれて question が開いたまま残る", async () => {
  const { db, clock, workspace, github, work } = await abandonedPromotion("landing-abandon-unresolvable");
  let drifted = false;
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    resolveWorkspace: (name) => {
      if (drifted) throw new UnknownWorkspaceError(name ?? workspace.name);
      return workspace;
    },
    github,
    resolveAuthority: () => profile("escalate"),
  });
  await settleAttachedChild(db, clock, workspace, work.id);
  drifted = true;

  await landing.converge();

  const reasked = openPromotionQuestions(db, work.id);
  expect(reasked.map((q) => q.title)).toEqual(["PR promotion re-asked: ship"]);
  await expect(answerPromotion(db, clock, landing, workspace, reasked[0]!, "retry")).rejects.toThrow(DomainError);
  expect(openPromotionQuestions(db, work.id).map((q) => q.id)).toEqual([reasked[0]!.id]);
  expect(github.requests).toHaveLength(1);
});

// ADR 0241 決定3: 断念した根の守りは PR の有無によらない
/** PR を開いた完了 work の修理の push を失敗させ、人間が abandon promotion と答えた形。 */
async function abandonedPushToOpenPr(name: string) {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const authority = { resolve: (): AuthorityProfile => profile("escalate") };
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => authority.resolve(),
  });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  settleReviews(db, clock.now());
  await landing.converge();
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "fixed\n");
  github.scriptPushFailure(new Error("push rejected"));
  await landing.converge();
  github.scriptPushFailure(null);
  const [failure] = promotionFailures(db, work.id);
  await answerPromotion(db, clock, landing, workspace, failure!, "abandon promotion");
  return { db, clock, workspace, github, landing, authority, work: getTask(db, work.id)! };
}

it("PR を持つ根の昇格を abandon した後、内容を変えない付帯子が決着しても、profile が読めなくても、push も question もせず agent を quarantine に落とさない", async () => {
  const { db, clock, workspace, github, landing, authority, work } =
    await abandonedPushToOpenPr("landing-abandon-with-pr-unchanged");
  authority.resolve = () => {
    throw new UnknownAgentError("tako");
  };
  const pushed = github.pushes.length;

  await settleAttachedChild(db, clock, workspace, work.id);

  await landing.converge();

  expect(github.pushes).toHaveLength(pushed);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
});

it("PR を持つ根の昇格を abandon した後、修理が内容を変えて決着しても push せず昇格の question を1つ立て直し、retry と答えると push する", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPushToOpenPr("landing-abandon-with-pr");
  const pushed = github.pushes.length;

  await settleAttachedChild(db, clock, workspace, work.id, "second-repair");

  await landing.converge();

  expect(github.pushes).toHaveLength(pushed);
  const reasked = openPromotionQuestions(db, work.id);
  expect(reasked.map((q) => q.title)).toEqual(["PR promotion re-asked: ship"]);

  await answerPromotion(db, clock, landing, workspace, reasked[0]!, "retry");

  expect(github.pushes).toHaveLength(pushed + 1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

it("abandon の後の retry が着地させた根は、次の修理の決着で問い直さずに開いた PR へ push する", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-abandon-superseded");
  await settleAttachedChild(db, clock, workspace, work.id, "repair");
  await landing.converge();
  await answerPromotion(db, clock, landing, workspace, openPromotionQuestions(db, work.id)[0]!, "retry");

  await settleAttachedChild(db, clock, workspace, work.id, "second-repair");

  await landing.converge();

  expect(github.pushes).toHaveLength(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

// ADR 0394 決定6: 読み手は記録が指す question の種類で絞る —— PR の hold を断念と読まない
it("abandon → retry で PR が開く → PR の merge question に hold、の順に答えても、次の修理の決着で収束は開いた PR へ push する", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-abandon-retry-pr-hold");
  await settleAttachedChild(db, clock, workspace, work.id, "repair");
  await landing.converge();
  await answerPromotion(db, clock, landing, workspace, openPromotionQuestions(db, work.id)[0]!, "retry");
  await answerHoldOnPr({ db, clock, landing, workspace });
  const pushed = github.pushes.length;

  await settleAttachedChild(db, clock, workspace, work.id, "second-repair");

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "landed", form: "open_pull_request_updated", prNumber: 1 });
  expect(github.pushes).toHaveLength(pushed + 1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

// ADR 0233: 既定への参照は pickup で終わる —— 着手したタスクの着地は、既定を差し替えた盤面でも pickup で解決した先に向かう

/** 既定 `workspace`(省略なら workspace 未指定のまま)と既定 agent `agent` で pickup し、完了して完了時レビューを決着させる。 */
function pickedUpAndCompleted(board: Db, clock: FakeClock, agent: string, workspace?: WorkspaceConfig): Task {
  const picked = pickupTask(board, landingWork(board, clock), agent, clock.now(), { assignee: agent, workspace: workspace?.name })!;
  const done = completeTask(board, picked, FULL_HANDOFF, agent, clock.now(), "worker");
  for (const review of listBoard(board).filter((t) => t.parent_id === done.id)) {
    settleReview(board, getTask(board, review.id)!, "shako", clock.now());
  }
  return getTask(board, done.id)!;
}

it("既定 workspace a で pickup した workspace 未指定の完了タスクの PR は、既定を b に差し替えた盤面でも a で CI を読んで merge され、盤面の外の merge も a で観測し、a の着地待ちに数える", async () => {
  const a = await makeWorkspace("landing-pinned-a");
  const b = await makeWorkspace("landing-pinned-b");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  for (const pr of [7, 8]) {
    recordPrOpenedOutsideConvergence(db, pickedUpAndCompleted(db, clock, "tako", a), pr, clock.now(), {
      authority: { merge: "auto_if_ci_green" },
    });
  }
  github.scriptMergedOutside(8);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace: b,
    resolveWorkspace: defaultingTo(b, a),
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  });

  expect(taskIdsAwaitingLandingInWorkspace(db, undefined, a.name)).toHaveLength(2);
  expect(taskIdsAwaitingLandingInWorkspace(db, undefined, b.name)).toHaveLength(0);

  await landing.observeAutoMergeOutcomes("tako");
  await landing.tick("auto_merge");

  expect(github.stateChecks).toEqual([
    { path: a.path, number: 7 },
    { path: a.path, number: 8 },
  ]);
  expect(github.ciChecks).toEqual([{ path: a.path, number: 7 }]);
  expect(github.merged).toEqual([{ path: a.path, number: 7 }]);
});

it("既定 workspace a で pickup した workspace 未指定のタスクの PR 昇格は、既定を b に差し替えた盤面でも a のタスクブランチから PR を開く", async () => {
  const { workspace: a } = await makeLandingWorkspace("landing-pinned-land-a");
  const { workspace: b } = await makeLandingWorkspace("landing-pinned-land-b");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const done = pickedUpAndCompleted(db, clock, "tako", a);
  checkoutTaskBranch(db, a, done.id);
  commitWork(a.path, "feature.txt", "ready\n");
  git(a.path, "checkout", "main");
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace: b,
    resolveWorkspace: defaultingTo(b, a),
    github,
    resolveAuthority: () => profile("escalate"),
  });

  await landing.converge();

  expect(github.requests.map((r) => r.path)).toEqual([a.path]);
});

it("既定 agent a で pickup した assignee 未指定の完了タスクの PR は、既定 agent を b に差し替えた tick でも a の profile のダイヤルで merge され、a の着地待ちに数える", async () => {
  const workspace = await makeWorkspace("landing-pinned-agent");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  recordPrOpenedOutsideConvergence(db, pickedUpAndCompleted(db, clock, "a"), 7, clock.now(), {
    authority: { merge: "auto_if_ci_green" },
  });
  const landing = createLanding({
    defaultAgentName: "b",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: (assignee) => profile(assignee === "a" ? "auto_if_ci_green" : "escalate"),
  });

  expect(taskIdsAwaitingLanding(db, undefined, "a", "b")).toHaveLength(1);
  expect(taskIdsAwaitingLanding(db, undefined, "b", "b")).toHaveLength(0);

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([{ path: workspace.path, number: 7 }]);
  expect(mergeQuestions(db)).toEqual([]);
});

// ADR 0236: 盤面が merge している PR には、観測も重なった tick も手を出さない。窓は盤面の await を1回だけ止めて作る

const QUEUE_WINDOWS: Array<{
  window: string;
  interrupt: "観測" | "2つ目の tick";
  outcome: "pr_merged" | "pr_merge_observed";
  merges: number;
  install: (github: FakeGitHubClient, hold: () => Promise<void>) => void;
}> = [
  {
    window: "merge の await(merge は通る)",
    interrupt: "観測",
    outcome: "pr_merged",
    merges: 1,
    install: holdAfterMerge,
  },
  {
    window: "読み取りの await(盤面の外で merge 済み)",
    interrupt: "観測",
    outcome: "pr_merge_observed",
    merges: 0,
    install: (github, hold) => {
      github.scriptMergedOutside(1);
      afterCiRead(github, hold);
    },
  },
  {
    window: "merge の失敗の後の読み直しの await",
    interrupt: "観測",
    outcome: "pr_merge_observed",
    merges: 0,
    install: (github, hold) => {
      const read = github.readPullRequest.bind(github);
      let reads = 0;
      github.readPullRequest = async (ref) => {
        const pr = await read(ref);
        // CI を読んだ直後に盤面の外で merge される —— 盤面の merge は拒まれ、読み直しで止める
        if (++reads === 1) github.scriptMergedOutside(ref.number);
        else await hold();
        return pr;
      };
    },
  },
  {
    window: "読み取りの await",
    interrupt: "2つ目の tick",
    outcome: "pr_merged",
    merges: 1,
    install: afterCiRead,
  },
];

it.each(QUEUE_WINDOWS)("無人 merge の tick の $window に$interruptが割り込んでも、キューの PR に決着の event は $outcome の1件だけ残る", async ({ interrupt, outcome, merges, install }) => {
  const workspace = await makeWorkspace("landing-in-flight-mark");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  const gate = awaitWindow();
  install(github, gate.hold);
  const landing = autoMerging(db, clock, workspace, github);

  const tick = landing.tick("auto_merge");
  await gate.entered;
  await (interrupt === "観測" ? landing.observeAutoMergeOutcomes("tako") : landing.tick("auto_merge"));
  gate.open();
  await tick;

  expect(autoMergeOutcomeEvents(db, work.id)).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: outcome, pr_number: 1 } },
  ]);
  expect(github.merged).toHaveLength(merges);
});

it("重なった tick が先に決着させた PR に、止まっていた tick が古い一覧から辿り着いても、決着の event も merge も重ねない(#1798)", async () => {
  const workspace = await makeWorkspace("landing-in-flight-mark-stale-list");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  const second = queueAutoMerge(db, clock, 2);
  const gate = awaitWindow();
  afterCiRead(github, gate.hold);
  const landing = autoMerging(db, clock, workspace, github);

  const stalled = landing.tick("auto_merge"); // #1 の読み取りで止まる
  await gate.entered;
  await landing.tick("auto_merge"); // #1 を飛ばし、#2 を merge して印を放す
  gate.open();
  await stalled;

  expect(autoMergeOutcomeEvents(db, second.id)).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merged", pr_number: 2 } },
  ]);
  expect(github.merged.filter((ref) => ref.number === 2)).toHaveLength(1);
});

/** tick が PR の処理を抜ける形。返す関数は、次の tick がその PR を最後まで処理できるように戻す。 */
const TICK_EXITS: Array<[string, (github: FakeGitHubClient) => () => void]> = [
  [
    "CI pending でキューに残して",
    (github) => {
      github.scriptCiStatus("pending");
      return () => github.scriptCiStatus("success");
    },
  ],
  [
    "分類できない例外で",
    (github) => {
      const read = github.readPullRequest.bind(github);
      github.readPullRequest = async () => {
        throw new Error("unexpected");
      };
      return () => {
        github.readPullRequest = read;
      };
    },
  ],
];

it.each(TICK_EXITS.flatMap(([exit, script]) => (["観測", "tick"] as const).map((next) => [exit, next, script] as const)))(
  "tick が PR の処理を%s抜けた後は印が残らず、次の%sがその PR を処理する",
  async (_exit, next, script) => {
    const workspace = await makeWorkspace("landing-in-flight-mark-released");
    const { db, clock } = await openBoard();
    const github = new FakeGitHubClient();
    const work = queueAutoMerge(db, clock, 1);
    const restore = script(github);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const landing = autoMerging(db, clock, workspace, github);

    await landing.tick("auto_merge");
    if (next === "観測") {
      github.scriptMergedOutside(1);
      await landing.observeAutoMergeOutcomes("tako");
    } else {
      restore();
      await landing.tick("auto_merge");
    }

    expect(autoMergeOutcomeEvents(db, work.id)).toEqual([
      {
        actor_id: BOARD_ACTOR_ID,
        origin: "board",
        payload: { kind: next === "観測" ? "pr_merge_observed" : "pr_merged", pr_number: 1 },
      },
    ]);
  },
);

// #1864: merge 済みの根の保護ブランチの読み直しが落ちても、根ごとの手順の catch が決着を書く(ADR 0241 決定6)。
// 回のログ(その根を撃てなかった)に逃がさない。読み直しは PR の状態を読んだ後に撃つので、効果は読みの直後に起こす
/** PR を読んだ直後に change を走らせる —— merge 済みの決着が読み直す前に、盤面の外の状態を変える。 */
function afterPrRead(
  github: FakeGitHubClient,
  read: "getPullRequestState" | "findPullRequestByHead",
  change: () => void,
): void {
  const original = github[read].bind(github) as (input: never) => Promise<unknown>;
  (github as unknown as Record<string, unknown>)[read] = async (input: never) => {
    const result = await original(input);
    change();
    return result;
  };
}

/** origin を届かなくする —— 保護ブランチの読み直しが落ちる。`quarantine` なら workspace も quarantine に落とす。 */
function breakRefresh({ workspace, db, clock }: { workspace: WorkspaceConfig; db: Db; clock: FakeClock }, quarantine: boolean) {
  return () => {
    rmSync(workspace.repo!, { recursive: true });
    if (quarantine) quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());
  };
}

/** 盤面の外で merge された開いている PR の根(積み残しがあり、収束は PR を読みに行く)。 */
async function mergedOutsideOpenPr(name: string, quarantine = false) {
  const pr = await openPushedPr(name, "escalate");
  commitWork(pr.workspace.path, "repair.txt", "fixed\n");
  finish(pr.db, pr.clock, pr.work);
  pr.github.scriptMergedOutside(1);
  afterPrRead(pr.github, "getPullRequestState", breakRefresh(pr, quarantine));
  return pr;
}

/** 作成の後・記録の前に落ち、その PR が盤面の外で merge された根。 */
async function mergedOutsideFoundPr(name: string, quarantine = false) {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  github.scriptMergedOutside(github.scriptPullRequestOnBranch(`task/${work.id}`));
  finish(db, clock, work);
  afterPrRead(github, "findPullRequestByHead", breakRefresh({ workspace, db, clock }, quarantine));
  return { workspace, db, clock, github, work, landing };
}

it.each([
  ["開いている PR が盤面の外で merge された", mergedOutsideOpenPr],
  ["同じ head の merge 済み PR が見つかった", mergedOutsideFoundPr],
])("%s根の保護ブランチの読み直しが失敗すれば、promotion_failed を返し失敗 question を1枚立て、回のログに逃がさない", async (_, setup) => {
  const { db, work, landing } = await setup("merged-refresh-fails");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed" });
  expect(promotionFailures(db, work.id)).toHaveLength(1);
  expect(logged).not.toHaveBeenCalled();
});

it.each([
  ["開いている PR が盤面の外で merge された", mergedOutsideOpenPr],
  ["同じ head の merge 済み PR が見つかった", mergedOutsideFoundPr],
])("%s根の保護ブランチの読み直しが失敗しても、workspace の quarantine が抱えていれば失敗 question を立てずその quarantine を名乗る", async (_, setup) => {
  const { workspace, db, work, landing } = await setup("merged-refresh-fails-quarantined", true);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "quarantined",
    error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
  });
  expect(promotionFailures(db, work.id)).toEqual([]);
});

// 同じ head で見つけた形は、最初の回で PR の番号を記録するので、retry の回は開いている PR の形を通る
it("merge 済みの根の保護ブランチの読み直しの失敗に retry を答える回の verdict は、その失敗であって not_a_root ではなく、失敗 question を立て直さない", async () => {
  const { db, work, landing } = await mergedOutsideOpenPr("merged-refresh-fails-retry");
  const first = await convergeOn(landing, work.id);
  const failures = promotionFailures(db, work.id);

  await expect(convergeOn(landing, work.id, failures[0]!.id)).resolves.toEqual(first);
  expect(promotionFailures(db, work.id)).toEqual(failures);
});

// ADR 0265 決定7: done の work の着地の状態は記録から導く —— 導きはここ(domain 層)で1度だけ述べる(ADR 0107)。
// サーバ境界のテストは「読み口が状態を写す」ことだけを述べる。
const stateOf = (db: Db, taskId: string) => landingState(db, getTask(db, taskId)!);

it("auto_if_ci_green で PR を開いた根は auto_merge_queue で、無人 merge の後は merged になる", async () => {
  const { db, clock, landing, work } = await openPushedPr("landing-state-auto-merged", "auto_if_ci_green");
  finish(db, clock, work);
  expect(stateOf(db, work.id)).toBe("auto_merge_queue");

  await landing.tick("auto_merge");

  expect(stateOf(db, work.id)).toBe("merged");
});

it.each([
  ["merge_observed", (github: FakeGitHubClient) => github.scriptMergedOutside(1)],
  ["close_observed", (github: FakeGitHubClient) => github.scriptClosedOutside(1)],
] as const)("無人 merge キューの PR が盤面の外で決着すると、根は %s になる", async (state, settleOutside) => {
  const { db, clock, github, landing, work } = await openPushedPr(`landing-state-${state}`, "auto_if_ci_green");
  finish(db, clock, work);
  settleOutside(github);

  await landing.tick("auto_merge");

  expect(stateOf(db, work.id)).toBe(state);
});

// ADR 0265 決定3: 内容で終わっても決裁は残る —— 生きているキューの行を landed で隠さない
it("auto_if_ci_green の根が内容で終わってもキューの行が残る間は auto_merge_queue のまま", async () => {
  const { workspace, db, clock, landing, work } = await openPushedPr("landing-state-content-queued", "auto_if_ci_green");
  finish(db, clock, work);
  await squashTaskIntoOrigin(workspace, work.id);
  git(workspace.path, "fetch", "origin", "main");

  await convergeOn(landing, work.id);

  expect(boardEvents(db, work.id, "landing_finished")).toHaveLength(1);
  expect(stateOf(db, work.id)).toBe("auto_merge_queue");
});

it("done でない work の行は、キューの行を持っていても着地の状態は null", async () => {
  const { db, clock } = await openBoard();
  const work = queueAutoMerge(db, clock, 1);

  expect(stateOf(db, work.id)).toBeNull();
});

it("キューから取り下げられた PR の根は withdrawn になる", async () => {
  const { workspace, db, clock, github, work } = await openPushedPr("landing-state-withdrawn", "auto_if_ci_green");
  finish(db, clock, work);

  await autoMerging(db, clock, workspace, github, () => profile("external")).tick("auto_merge");

  expect(stateOf(db, work.id)).toBe("withdrawn");
});

it("escalate の根は merge question が開いている間 merge_question で、人間の merge 回答の後は merged になる", async () => {
  const pr = await openPushedPr("landing-state-escalate", "escalate");
  finish(pr.db, pr.clock, pr.work);
  expect(stateOf(pr.db, pr.work.id)).toBe("merge_question");

  await answerMergeQuestion(pr);

  expect(stateOf(pr.db, pr.work.id)).toBe("merged");
});

it("external の根は内容で終わった後 landed になる", async () => {
  const { workspace, db, clock, landing, work } = await openPushedPr("landing-state-landed", "external");
  finish(db, clock, work);
  await squashTaskIntoOrigin(workspace, work.id);
  git(workspace.path, "fetch", "origin", "main");

  await landing.converge();

  expect(stateOf(db, work.id)).toBe("landed");
});

type StopBeforePr = (db: Db, clock: FakeClock, workspace: WorkspaceConfig, task: Task) => void;

it.each<[string, StopBeforePr]>([
  ["gate", (db, clock, _, task) => void attachUnsettledChild(db, clock, task.id)],
  ["quarantine", (db, clock, workspace) => quarantineWorkspace(db, workspace.name, new Error("repair"), clock.now())],
  ["failure-question", (db, clock, _, task) => registerPrPromotionFailureQuestion(db, task, "push failed", clock.now())],
])("PR を開く前に %s で止まっている根の着地の状態は null", async (stoppedBy, stop) => {
  const { workspace } = await makeLandingWorkspace(`landing-state-stopped-${stoppedBy}`);
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: new FakeGitHubClient() });
  const task = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  stop(db, clock, workspace, finish(db, clock, task));

  await landing.converge();

  expect(getTask(db, task.id)!.pr_number).toBeNull();
  expect(stateOf(db, task.id)).toBeNull();
});

/** 着地の比較(ADR 0370 決定1)の題材: 盤面の経路(pickup と解放)で基準を持ち、完了した根。 */
async function doneRootWithBaseline(name: string) {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = await completeThroughTaskCheckout(db, clock, workspace, landingWork(db, clock), "feature.txt", "ready\n");
  return { workspace, db, clock, github, landing, work };
}

/** `doneRootWithBaseline` の根の PR を開いた形。 */
async function pushedRootWithBaseline(name: string) {
  const root = await doneRootWithBaseline(name);
  await expect(convergeOn(root.landing, root.work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
  return { ...root, work: getTask(root.db, root.work.id)! };
}

it("着地の比較: PR の開いた根の task/<id> が休止中に動いていれば、push せず動いた ref を名指す Quarantine で止まる", async () => {
  const { workspace, db, github, landing, work } = await pushedRootWithBaseline("landing-compare-moved-root");
  const ref = `refs/heads/task/${work.id}`;
  const recorded = git(workspace.path, "rev-parse", ref);
  const pushesBefore = github.pushes.length;
  const moved = commitOutOfBand(workspace, `task/${work.id}`);

  const verdict = await convergeOn(landing, work.id);

  expect(verdict).toMatchObject({ kind: "quarantined", error: expect.stringContaining(moved) });
  expect(github.pushes).toHaveLength(pushesBefore);
  const quarantine = quarantineQuestion(db, "workspace", workspace.name);
  expect(quarantine?.purpose).toContain(`was: ${recorded} ${ref}`);
  expect(quarantine?.purpose).toContain(`now: ${moved} ${ref}`);
  expect(listEvents(db, work.id).filter((event) => event.kind === "pr_branch_pushed")).toEqual([]);
});

it("着地の比較: PR を開く前の根の task/<id> が動いていれば、PR を開かない", async () => {
  const { workspace, db, github, landing, work } = await doneRootWithBaseline("landing-compare-no-pr");
  commitOutOfBand(workspace, `task/${work.id}`);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  expect(github.requests).toEqual([]);
  expect(github.pushes).toEqual([]);
  expect(getTask(db, work.id)!.pr_number).toBeNull();
});

it("着地の比較: 根のブランチでない ref が動いても同じく止まり、運ぶ内容を push しない", async () => {
  const { workspace, db, clock, github, landing, work } = await pushedRootWithBaseline("landing-compare-other-ref");
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "fixed\n");
  const pushesBefore = github.pushes.length;
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/tags/intruder") });

  expect(github.pushes).toHaveLength(pushesBefore);
});

it("着地の比較: 何も動いていなければ、盤面自身の push と fetch を動いた ref と読まず、次の回は up_to_date", async () => {
  const { workspace, db, landing, work } = await pushedRootWithBaseline("landing-compare-control");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "up_to_date" });

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: 運ぶ内容の無い根は、ref が動いていれば nothing_to_land を刻まない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-compare-nothing");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: new FakeGitHubClient() });
  const work = landingWork(db, clock);
  const place = await prepareAtPickup(db, workspace, work);
  releaseWorkspace(db, place, finish(db, clock, work), clock.now(), true, undefined, undefined, true);
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  expect(listEvents(db, work.id).filter((event) => event.kind === "nothing_to_land")).toEqual([]);
});

it("着地の比較: 内容で終わった PR の根は、ref が動いていれば landing_finished を刻まない", async () => {
  const { workspace, db, landing, work } = await pushedRootWithBaseline("landing-compare-finished");
  await squashTaskIntoOrigin(workspace, work.id);
  // 手の fetch が写しを動かす —— これ自体が盤面の外の移動である(ADR 0370 決定1)
  git(workspace.path, "fetch", "origin", "main");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/remotes/origin/main") });

  expect(listEvents(db, work.id).filter((event) => event.kind === "landing_finished")).toEqual([]);
});

it("着地の比較: 門が閉じた根も ref を読むので Quarantine で止まり、landing_deferred を刻まない", async () => {
  const { workspace, db, clock, landing, work } = await pushedRootWithBaseline("landing-compare-gate-moved");
  attachUnsettledChild(db, clock, work.id);
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  expect(listEvents(db, work.id).filter((event) => event.kind === "landing_deferred")).toEqual([]);
});

it("着地の比較: 門が閉じた根は、何も動いていなければ今どおり待つ", async () => {
  const { workspace, db, clock, landing, work } = await pushedRootWithBaseline("landing-compare-gate-control");
  attachUnsettledChild(db, clock, work.id);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "deferred", reason: "attached_children", count: 1 });

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: 断念した根は、ref が動いていれば問い直さない", async () => {
  const { workspace, db, landing, work } = await abandonedPromotion("landing-compare-abandoned");
  commitOutOfBand(workspace, `task/${work.id}`);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

it("着地の比較: 親の無い断念の根は門が閉じていれば ref を読まないので、動いていても今どおり門で待つ", async () => {
  const { workspace, db, clock, landing, work } = await abandonedPromotion("landing-compare-abandoned-gate");
  attachUnsettledChild(db, clock, work.id);
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "deferred", reason: "attached_children", count: 1 });

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: hold した根は、ref が動いていれば local merge question を立て直さない", async () => {
  const local = await landLocally("landing-compare-held");
  const { workspace, db, landing, work } = local;
  await answerLocalMerge(local, "hold");
  commitOutOfBand(workspace, `task/${work.id}`);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  expect(openLocalMergeQuestions(db, work.id)).toEqual([]);
});

it("着地の比較: 親の無い hold の根は門が閉じていれば ref を読まないので、動いていても今どおり門で待つ", async () => {
  const local = await landLocally("landing-compare-held-gate");
  const { workspace, db, clock, landing, work } = local;
  await answerLocalMerge(local, "hold");
  attachUnsettledChild(db, clock, work.id);
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "deferred", reason: "attached_children", count: 1 });

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: 未回答の失敗 question で飛ばす根は ref を読まないので、動いていても Quarantine を立てない", async () => {
  const { workspace, db, clock, landing, work } = await pushedRootWithBaseline("landing-compare-skipped");
  registerPrPromotionFailureQuestion(db, work, "push failed", clock.now());
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toBeUndefined();

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: lineage が ref を読む子は、動いていれば根かどうかを読む前に止まる", async () => {
  const { workspace, db, clock, landing, work } = await doneRootWithBaseline("landing-compare-child");
  const child = await completeThroughTaskCheckout(db, clock, workspace, attachUnsettledChild(db, clock, work.id), "child.txt", "child\n");
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, child.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/tags/intruder") });
});

// ADR 0403 決定4: 着地の ref 検査が git の失敗で読めなければ、根ごとの昇格失敗 question でなく workspace の Quarantine で1回止まる
it("着地の比較: checkout の ref が読めなければ、根は workspace の Quarantine 1つで止まり、次の収束も重ねず、昇格失敗 question は立たない", async () => {
  const { workspace, db, landing, work } = await doneRootWithBaseline("landing-compare-unreadable-refs");
  breakPackedRefs(workspace);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "quarantined",
    error: expect.stringMatching(unreadableRefsRefusal(workspace)),
  });
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
  expect(quarantineQuestion(db, "workspace", workspace.name)!.purpose).toContain(`could not verify refs for workspace "${workspace.name}" before landing`);
  expect(promotionFailures(db, work.id)).toEqual([]);
});

it("着地の比較: lineage が ref を読む子も、checkout の ref が読めなければ根かどうかを読む前に workspace の Quarantine 1つで止まる", async () => {
  const { workspace, db, clock, landing, work } = await doneRootWithBaseline("landing-compare-child-unreadable-refs");
  const child = await completeThroughTaskCheckout(db, clock, workspace, attachUnsettledChild(db, clock, work.id), "child.txt", "child\n");
  breakPackedRefs(workspace);

  await expect(convergeOn(landing, child.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("could not verify refs") });

  expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
  expect([...promotionFailures(db, work.id), ...promotionFailures(db, child.id)]).toEqual([]);
});

it("着地の比較: checkout の ref が読めなければ、ローカル着地の merge の回答は拒まれ、workspace の Quarantine が立つ", async () => {
  const local = await landLocally("landing-compare-local-merge-unreadable-refs");
  const { workspace, db, question } = local;
  breakPackedRefs(workspace);

  await expect(answerLocalMerge(local)).rejects.toThrow(/^could not verify refs .* before landing: .*git for-each-ref/s);

  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain("could not verify refs");
  expect(getTask(db, question.id)!.status).toBe("todo");
});

it("着地の比較: ref が読めない checkout の Quarantine の回答は、壊れたままなら拒まれ、直してから答えると受理され、次の収束が着地する", async () => {
  const { workspace, db, clock, landing, work } = await doneRootWithBaseline("landing-compare-unreadable-refs-answer");
  const packedRefs = join(workspace.path, ".git", "packed-refs");
  const intact = existsSync(packedRefs) ? readFileSync(packedRefs, "utf8") : undefined;
  breakPackedRefs(workspace);
  await convergeOn(landing, work.id);
  const question = quarantineQuestion(db, "workspace", workspace.name)!;

  await expect(answerWorkspaceQuarantine({ db, clock, workspace, landing }, question)).rejects.toThrow("not a packed ref");
  expect(getTask(db, question.id)!.status).toBe("todo");

  if (intact === undefined) rmSync(packedRefs);
  else writeFileSync(packedRefs, intact);
  await answerWorkspaceQuarantine({ db, clock, workspace, landing }, question);

  expect(getTask(db, question.id)!.status).toBe("done");
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
});

it("着地の比較: PR の状態の読みを待つ間に動いた ref は運ばない", async () => {
  const { workspace, db, clock, github, landing, work } = await pushedRootWithBaseline("landing-compare-pr-state-wait");
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "fixed\n");
  const pushesBefore = github.pushes.length;
  const window = holdAfter(github, "getPullRequestState");

  const converging = convergeOn(landing, work.id);
  await window.entered;
  const moved = commitOutOfBand(workspace, `task/${work.id}`);
  window.open();

  await expect(converging).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(moved) });
  expect(github.pushes).toHaveLength(pushesBefore);
});

it("着地の比較: push の準備を待つ間に動いた ref があれば push しない", async () => {
  const { workspace, db, clock, github, landing, work } = await pushedRootWithBaseline("landing-compare-prepare-wait");
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "fixed\n");
  const pushesBefore = github.pushes.length;
  const window = holdAfter(github, "preparePush");

  const converging = convergeOn(landing, work.id);
  await window.entered;
  const moved = commitOutOfBand(workspace, `task/${work.id}`);
  window.open();

  await expect(converging).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(moved) });
  expect(github.pushes).toHaveLength(pushesBefore);
  expect(listEvents(db, work.id).filter((event) => event.kind === "pr_branch_pushed")).toEqual([]);
});

it("着地の比較: Quarantine に回答した後の retry が着地し、未回答の失敗 question の根はその retry まで撃たない", async () => {
  const { workspace, db, clock, github, landing, work } = await pushedRootWithBaseline("landing-compare-after-answer");
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "fixed\n");
  registerPrPromotionFailureQuestion(db, getTask(db, work.id)!, "push failed", clock.now());
  const [failure] = openPromotionQuestions(db, work.id);
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id, failure!.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/tags/intruder") });
  expect(openPromotionQuestions(db, work.id).map(({ id }) => id)).toEqual([failure!.id]);

  git(workspace.path, "tag", "-d", "intruder");
  await answerWorkspaceQuarantine({ db, clock, workspace, landing }, quarantineQuestion(db, "workspace", workspace.name)!);
  const pushesBefore = github.pushes.length;

  await expect(convergeOn(landing, work.id)).resolves.toBeUndefined();
  expect(github.pushes).toHaveLength(pushesBefore);

  await expect(convergeOn(landing, work.id, failure!.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
});

it("着地の比較: Quarantine が開いているところで ref が動いた retry は、2枚目の question を立てず拒否文が動いた ref を名指す", async () => {
  const { workspace, db, clock, landing, work } = await pushedRootWithBaseline("landing-compare-open-quarantine");
  registerPrPromotionFailureQuestion(db, work, "push failed", clock.now());
  const [failure] = openPromotionQuestions(db, work.id);
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());
  const openQuestions = listBoard(db).filter((task) => task.type === "question" && task.status === "todo").length;
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id, failure!.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/tags/intruder") });

  expect(listBoard(db).filter((task) => task.type === "question" && task.status === "todo")).toHaveLength(openQuestions);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).not.toContain("refs/tags/intruder");
});

/** lineage が ref を読む子(決着した work の親を持つ done の work)を持つ根。 */
async function rootWithDoneChild(name: string) {
  const root = await doneRootWithBaseline(name);
  const { workspace, db, clock, work } = root;
  const child = await completeThroughTaskCheckout(db, clock, workspace, attachUnsettledChild(db, clock, work.id), "child.txt", "child\n");
  return { ...root, child };
}

it("着地の比較: 着地を待つ数えの lineage の読みは、ref が動いていても Quarantine を立てない", async () => {
  const { workspace, db, work } = await rootWithDoneChild("landing-compare-read-only-lineage");
  git(workspace.path, "tag", "intruder");

  expect(taskIdsAwaitingLanding(db, () => workspace, "tako", "tako")).toEqual([work.id]);

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: 着地を待つ数えの lineage の読みは、基準の行が無い workspace で最初の撮りをしない", async () => {
  const { workspace, db, work } = await rootWithDoneChild("landing-compare-read-only-lineage-rowless");
  dropWorkspaceState(db, workspace.name);

  expect(taskIdsAwaitingLanding(db, () => workspace, "tako", "tako")).toEqual([work.id]);

  expect(holdsBaseline(db, workspace.name)).toBe(false);
});

it("着地の比較: 削除の扉が読む hold の内容の比較は、ref が動いていても Quarantine を立てない", async () => {
  const local = await landLocally("landing-compare-read-only-held");
  const { workspace, db, work } = local;
  await answerLocalMerge(local, "hold");
  commitOutOfBand(workspace, `task/${work.id}`);

  expect(taskIdsAwaitingLandingInWorkspace(db, () => workspace, workspace.name)).toEqual([work.id]);

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: 削除の扉が読む hold の内容の比較は、基準の行が無い workspace で最初の撮りをしない", async () => {
  const local = await landLocally("landing-compare-read-only-held-rowless");
  const { workspace, db, work } = local;
  await answerLocalMerge(local, "hold");
  commitOutOfBand(workspace, `task/${work.id}`);
  dropWorkspaceState(db, workspace.name);

  expect(taskIdsAwaitingLandingInWorkspace(db, () => workspace, workspace.name)).toEqual([work.id]);

  expect(holdsBaseline(db, workspace.name)).toBe(false);
});

it("着地の比較: 基準の行が無い workspace は最初の撮りをして着地し、その後の移動を捕まえる", async () => {
  const { workspace, db, github, landing, work } = await doneRootWithBaseline("landing-compare-first-capture");
  dropWorkspaceState(db, workspace.name);
  announceHeadRepo(db, workspace, workspace.head_repo);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(holdsBaseline(db, workspace.name)).toBe(true);
  expect(github.requests).toHaveLength(1);

  git(workspace.path, "tag", "intruder");
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/tags/intruder") });
});

/** 基準の行の無い根の workspace(`rowless`)と、基準の行を持つもう1つの workspace(`held`)が registry に並ぶ盤面。 */
async function rowlessRootBesideHeldWorkspace(name: string, resolveHeld?: () => WorkspaceConfig) {
  const { workspace: rowless } = await makeLandingWorkspace(`${name}-rowless`);
  const held = await makeWorkspace(`${name}-held`);
  const { db, clock } = await openBoard();
  await leaveBaseline(db, held);
  const github = new FakeGitHubClient();
  const resolveWorkspace = (workspace: string | null) => {
    if (workspace === held.name) return resolveHeld?.() ?? held;
    if (workspace === rowless.name) return rowless;
    throw new UnknownWorkspaceError(String(workspace));
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace, github });
  const work = landingWork(db, clock, rowless.name);
  checkoutTaskBranch(db, rowless, work.id);
  commitWork(rowless.path, "feature.txt", "ready\n");
  git(rowless.path, "checkout", "main");
  finish(db, clock, work);
  return { rowless, held, db, clock, github, landing, work: getTask(db, work.id)! };
}

it.each<[string, (db: Db, held: WorkspaceConfig, now: Date) => string]>([
  ["workspace", (db, held, now) => {
    quarantineWorkspace(db, held.name, new Error("repair the checkout"), now);
    return `workspace "${held.name}" is quarantined and needs human attention before landing; answer its quarantine question`;
  }],
  ["組の封じ込め", (db, held, now) => {
    const value = workspaceContainmentValue("claude-code", held.name);
    registerResourceStop(db, "workspaceContainment", value, "repair the containment", now);
    // workspace の Quarantine の question は無い —— 開いている組の封じ込めの question を名指す
    return `the containment of workspace "${held.name}" is quarantined, and a workspace the board holds no baseline for waits until it is closed; answer question ${openQuarantineQuestion(db, "workspaceContainment", value)!.id}`;
  }],
])("着地の比較: 基準の行を持つ名前の %s の Quarantine が開いている間、行の無い workspace は撮らずに待ち、何も書かず、開いている question を名指す", async (_, stop) => {
  const { rowless, held, db, clock, github, landing, work } = await rowlessRootBesideHeldWorkspace("landing-compare-wait");
  const refusal = stop(db, held, clock.now());
  const eventsBefore = listEvents(db, work.id).length;

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "quarantined", error: refusal });

  expect(holdsBaseline(db, rowless.name)).toBe(false);
  expect(github.requests).toEqual([]);
  expect(listEvents(db, work.id)).toHaveLength(eventsBefore);
  expect(promotionFailures(db, work.id)).toEqual([]);
});

it("着地の比較: 待っている根への retry は、止めている名前を言って拒まれる", async () => {
  const { held, db, clock, landing, work } = await rowlessRootBesideHeldWorkspace("landing-compare-wait-retry");
  registerPrPromotionFailureQuestion(db, work, "push failed", clock.now());
  const [failure] = openPromotionQuestions(db, work.id);
  quarantineWorkspace(db, held.name, new Error("repair the checkout"), clock.now());

  await expect(convergeOn(landing, work.id, failure!.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(`workspace "${held.name}"`) });
});

it("着地の比較: 最初の撮りの前の確認に落ちれば、落ちた名前の Quarantine で待つ", async () => {
  const { rowless, held, db, github, landing, work } = await rowlessRootBesideHeldWorkspace("landing-compare-confirm");
  git(held.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(`workspace "${held.name}"`) });

  expect(quarantineQuestion(db, "workspace", held.name)?.purpose).toContain("refs/tags/intruder");
  expect(holdsBaseline(db, rowless.name)).toBe(false);
  expect(github.requests).toEqual([]);
});

it("着地の比較: 最初の撮りの確認が registry を読めなければ、どの名前の Quarantine でもなく根の失敗になる", async () => {
  const { rowless, held, db, landing, work } = await rowlessRootBesideHeldWorkspace("landing-compare-registry", () => {
    throw new Error("the registry cannot be read");
  });

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed", error: expect.stringContaining("the registry cannot be read") });

  expect(quarantineQuestion(db, "workspace", held.name)).toBeUndefined();
  expect(quarantineQuestion(db, "workspace", rowless.name)).toBeUndefined();
  expect(promotionFailures(db, work.id)).toHaveLength(1);
});

it("着地の比較: 行の無い名前自身の Quarantine の間は最初の撮りをせず、その名前で待つ", async () => {
  const { workspace, db, clock, github, landing, work } = await doneRootWithBaseline("landing-compare-own-quarantine");
  dropWorkspaceState(db, workspace.name);
  announceHeadRepo(db, workspace, workspace.head_repo);
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(`workspace "${workspace.name}"`) });

  expect(holdsBaseline(db, workspace.name)).toBe(false);
  expect(github.requests).toEqual([]);

  // 出口: 行の無い名前の受理は比べずに通り(ADR 0373 決定7)、次の収束が撮って着地する
  await answerWorkspaceQuarantine({ db, clock, workspace, landing }, quarantineQuestion(db, "workspace", workspace.name)!);
  await landing.converge();

  expect(holdsBaseline(db, workspace.name)).toBe(true);
  expect(github.requests).toHaveLength(1);
});

/** 基準の行が無い名前の根で、checkout の origin が宣言と別の repo を指す形(登録の後の帯域外の `set-url`、#3390)。 */
async function rowlessRootWithForeignOrigin(name: string) {
  const root = await doneRootWithBaseline(name);
  const { workspace, db } = root;
  dropWorkspaceState(db, workspace.name);
  announceHeadRepo(db, workspace, workspace.head_repo);
  const other = await tempDir(`tidepool-${name}-other-`);
  git(other, "clone", "--bare", workspace.repo!, ".");
  git(workspace.path, "remote", "set-url", "origin", other);
  return root;
}

// ADR 0399 決定7 / ADR 0383 決定2 の Status 追記: 着地の最初の撮りも pickup の開く前の項を通す
it("着地の比較: 行の無い名前の checkout の origin が宣言と別の repo を指せば、最初の撮りをせず push せず、その名前の Quarantine で止まる", async () => {
  const { workspace, db, github, landing, work } = await rowlessRootWithForeignOrigin("landing-compare-first-capture-origin");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(`workspace "${workspace.name}"`) });

  expect(holdsBaseline(db, workspace.name)).toBe(false);
  expect(github.requests).toEqual([]);
  expect(github.pushes).toEqual([]);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain("its checkout's origin is");
});

it("着地の比較: 開く前の項に落ちた行の無い名前は、直さずに受理すると拒まれ、直して受理すれば次の収束が撮って着地する", async () => {
  const { workspace, db, clock, github, landing, work } = await rowlessRootWithForeignOrigin("landing-compare-first-capture-origin-exit");
  await convergeOn(landing, work.id);
  const quarantine = quarantineQuestion(db, "workspace", workspace.name)!;

  // 受理は同じ項を撃ち直す(ADR 0378 決定3)
  await expect(answerWorkspaceQuarantine({ db, clock, workspace, landing }, quarantine)).rejects.toThrow("its checkout's origin is");

  git(workspace.path, "remote", "set-url", "origin", workspace.repo!);
  await answerWorkspaceQuarantine({ db, clock, workspace, landing }, quarantine);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(holdsBaseline(db, workspace.name)).toBe(true);
  expect(github.requests).toHaveLength(1);
});

/** 名前の場所の中に盤面の DB を置く固定点 —— 名前の場所と交差する(ADR 0040)。 */
const overlappingFixedPoint = (workspace: WorkspaceConfig) => [{ label: "board database (TIDEPOOL_DB)", path: join(workspace.path, "board.sqlite") }];

it("着地の比較: 行の無い名前の場所が盤面の固定点と重なれば、着地は最初の撮りをせず、その名前の Quarantine で止まる", async () => {
  const { workspace, db, clock, github, work } = await doneRootWithBaseline("landing-compare-first-capture-fixed-point");
  dropWorkspaceState(db, workspace.name);
  announceHeadRepo(db, workspace, workspace.head_repo);
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, boardState: overlappingFixedPoint(workspace) });

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(`workspace "${workspace.name}"`) });

  expect(holdsBaseline(db, workspace.name)).toBe(false);
  expect(github.requests).toEqual([]);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain("overlaps the board's board database (TIDEPOOL_DB)");
});

it("基準の行が無い workspace のローカル着地の merge 回答は、名前の場所が盤面の固定点と重なれば拒まれ、その名前の Quarantine になり、保護ブランチを動かさない", async () => {
  const workspace = await makeWorkspace("landing-answer-first-capture-fixed-point");
  const { db, clock } = await openBoard();
  const work = await unrecordedWork(db, clock, workspace);
  const question = mergeQuestion(db, clock, { pending_local_merge_task_id: work.id });
  const main = git(workspace.path, "rev-parse", "main");

  await expect(
    submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, workspace, boardState: overlappingFixedPoint(workspace) }, question, ["merge"], undefined, () => clock.now(), "webui"),
  ).rejects.toThrow(`workspace "${workspace.name}"`);

  expect(holdsBaseline(db, workspace.name)).toBe(false);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain("overlaps the board's board database (TIDEPOOL_DB)");
  expect(getTask(db, question.id)?.status).toBe("todo");
  expect(git(workspace.path, "rev-parse", "main")).toBe(main);
});

it("着地の比較: 積み残しの retry は、保護ブランチの fetch を待つ間に動いた ref があれば merge back を撃ち直さない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-compare-retry-wait");
  const { db, clock } = await openBoard();
  const window = awaitWindow();
  let holdFetch = false;
  const githubAuth = {
    ensureToken: async () => {
      if (holdFetch) await window.hold();
    },
    env: () => process.env,
  } as unknown as GitHubAuth;
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: new FakeGitHubClient(), githubAuth, workspacesDir: await tempDir("tidepool-task-checkouts-") });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "content_left_behind" });
  const [failure] = promotionFailures(db, work.id);
  holdFetch = true;

  const converging = convergeOn(landing, work.id, failure!.id);
  await window.entered;
  const moved = commitOutOfBand(workspace, `task/${work.id}`);
  window.open();

  await expect(converging).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(moved) });
  expect(git(workspace.path, "rev-parse", `task/${work.id}`)).toBe(moved);
  expect(() => git(workspace.path, "merge-base", "--is-ancestor", `task/${repair.id}`, `task/${work.id}`)).toThrow();
});

it("着地の比較: hold した内容のままの根も、別の ref が動いていれば Quarantine で止まる", async () => {
  const local = await landLocally("landing-compare-held-unchanged");
  const { workspace, db, landing, work } = local;
  await answerLocalMerge(local, "hold");
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/tags/intruder") });

  expect(openLocalMergeQuestions(db, work.id)).toEqual([]);
});

/** fork 元(親)が squash で着地した後に完了した修理の根 —— 収束は親を内容で終え、同じ回で修理を根にして追いつかせる。`prNumber` があれば修理の根自身の PR が開いている。 */
async function outlivedRootWithBaseline(name: string, prNumber?: number) {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const parent = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, parent.id);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now(), "worker");
  recordPrOpenedOutsideConvergence(db, parent, 1, clock.now(), { workspace });
  const repair = attachUnsettledChild(db, clock, parent.id);
  checkoutTaskBranch(db, workspace, repair.id, `task/${parent.id}`);
  const head = prNumber === undefined ? undefined : pushPrHead(github, workspace, repair.id, prNumber);
  await squashTaskIntoOrigin(workspace, parent.id);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  git(workspace.path, "checkout", "main");
  finish(db, clock, repair);
  if (prNumber !== undefined) recordPrOpenedOutsideConvergence(db, getTask(db, repair.id)!, prNumber, clock.now(), { head, workspace });
  await leaveBaseline(db, workspace);
  return { workspace, db, clock, github, landing, repair };
}

it.each([
  ["getPullRequestState", 2],
  ["findPullRequestByHead", undefined],
] as const)("着地の比較: %s を待つ間に動いた tip は、追いつきの commit に入れない", async (method, prNumber) => {
  const { workspace, db, github, landing, repair } = await outlivedRootWithBaseline(`landing-compare-catch-up-${method}`, prNumber);
  const window = holdAfter(github, method);

  const converging = landing.converge();
  await window.entered;
  const moved = commitOutOfBand(workspace, `task/${repair.id}`);
  window.open();
  await converging;

  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(moved);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(moved);
  expect(github.pushes).toEqual([]);
});

it("着地の比較: merge の記録がある根は、保護ブランチの fetch を待つ間に ref が動けば landing_finished を刻まない", async () => {
  const { workspace, db, clock, github, work } = await pushedRootWithBaseline("landing-compare-merged-record");
  appendEvent(db, { taskId: work.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merged", pr_number: 1 }, at: clock.now() });
  const { window, githubAuth } = fetchHeldAtToken();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, githubAuth });

  const converging = convergeOn(landing, work.id);
  await window.entered;
  git(workspace.path, "tag", "intruder");
  window.open();

  await expect(converging).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/tags/intruder") });
  expect(listEvents(db, work.id).filter((event) => event.kind === "landing_finished")).toEqual([]);
});

it("着地の比較: 盤面の外の merge を読んだ根は観測を刻み、fetch を待つ間に ref が動けば landing_finished を刻まない", async () => {
  const { workspace, db, clock, github, work } = await pushedRootWithBaseline("landing-compare-merged-observed");
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "fixed\n");
  github.scriptMergedOutside(1);
  const { window, githubAuth } = fetchHeldAtToken();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, githubAuth });

  const converging = convergeOn(landing, work.id);
  await window.entered;
  git(workspace.path, "tag", "intruder");
  window.open();

  await expect(converging).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("refs/tags/intruder") });
  expect(listEvents(db, work.id).filter((event) => event.kind === "pr_merge_observed")).toHaveLength(1);
  expect(listEvents(db, work.id).filter((event) => event.kind === "landing_finished")).toEqual([]);
});

/** fake の GitHub の `method` を、本来の結果を得た後で窓が開くまで待たせる —— その間に名前の場所を動かす題材。 */
function holdAfter(github: FakeGitHubClient, method: "getPullRequestState" | "findPullRequestByHead" | "preparePush") {
  const window = awaitWindow();
  const client = github as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const call = client[method]!.bind(github);
  client[method] = async (input) => {
    const result = await call(input);
    await window.hold();
    return result;
  };
  return window;
}

const reAsked = (db: Db, taskId: string) => promotionFailures(db, taskId).filter((q) => q.title.startsWith("PR promotion re-asked"));

// ADR 0370 決定1: 比較の失敗は内容の変化の読みに吸わせない —— 比べていない ref で問い直さない。読めない checkout は workspace の
// Quarantine で止まる(ADR 0403 決定4)
it("着地の比較: 断念した根の比較が checkout を読めなければ、問い直さず workspace の Quarantine で止まる", async () => {
  const { workspace, db, landing, work } = await abandonedPromotion("landing-compare-abandoned-unreadable");
  breakPackedRefs(workspace);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining("could not verify refs") });

  expect(reAsked(db, work.id)).toEqual([]);
  expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
});

it("着地の比較: 断念した根の最初の撮りの確認が registry を読めなければ、問い直さず根の失敗になる", async () => {
  const { rowless, db, clock, landing, work } = await rowlessRootBesideHeldWorkspace("landing-compare-abandoned-registry", () => {
    throw new Error("the registry cannot be read");
  });
  registerPrPromotionFailureQuestion(db, work, "push failed", clock.now(), undefined, git(rowless.path, "rev-parse", "main"));
  await answerPromotion(db, clock, landing, rowless, openPromotionQuestions(db, work.id)[0]!, "abandon promotion");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed", error: expect.stringContaining("the registry cannot be read") });

  expect(reAsked(db, work.id)).toEqual([]);
  expect(holdsBaseline(db, rowless.name)).toBe(false);
});

// ADR 0403 決定1: 問い直しに写す tip が読めなくても、tip 無しで問い直す
it("断念した根の問い直しは、workspace を解決できず tip が読めなくても tip 無しの question を立てる", async () => {
  const { db, clock, github, work } = await abandonedPromotion("abandon-reask-tip-unreadable");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const landing = createLanding({
    defaultAgentName: "tako", db, clock, github,
    resolveWorkspace: () => { throw new Error("the registry cannot be read"); },
  });

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed" });

  expect(reAsked(db, work.id)).toEqual([expect.objectContaining({ status: "todo", question_landing_tip: null })]);
});

// ADR 0403 決定1: git が exit 1 以外で落ちても、問い直しは tip 無しで立つ
it("tip 無しの question を断念した根の問い直しは、`.git` がリポジトリでなく git が tip を読めなくても tip 無しで立つ", async () => {
  const { db, workspace, landing, work } = await abandonedPromotion("abandon-reask-git-fails", { askedTip: false });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  rmSync(join(workspace.path, ".git"), { recursive: true });
  mkdirSync(join(workspace.path, ".git"));

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed" });

  expect(reAsked(db, work.id)).toEqual([expect.objectContaining({ status: "todo", question_landing_tip: null })]);
  expect(logged).toHaveBeenCalledWith(expect.stringContaining(`could not read the tip of task/${work.id}`), expect.objectContaining({ status: 128 }));
});

const GATE_READ = "SELECT COUNT(*) AS n FROM tasks attached";

/** 断る記録の枝を通る根 —— PR 昇格を断念した根と、ローカル着地を hold した根。 */
const declinedRoots: Array<[string, string, (name: string) => Promise<{ db: Db; clock: FakeClock; landing: Landing; work: Task; workspace: WorkspaceConfig }>]> = [
  ["断念した根", "abandoned", (name) => abandonedPromotion(name)],
  [
    "ローカル着地を hold した根",
    "held",
    async (name) => {
      const local = await landLocally(name);
      await answerLocalMerge(local, "hold");
      return local;
    },
  ],
];

// ADR 0403 決定2: 断念・hold の枝の失敗も、主経路と同じ境界で昇格失敗 question になる
it.each(declinedRoots)("%sの門の読みが落ちれば、収束はその根に昇格失敗 question を立てる", async (_, slug, declinedRoot) => {
  const { db, landing, work } = await declinedRoot(`declined-branch-gate-read-threw-${slug}`);
  failPrepareOnce(db, GATE_READ, "the gate could not be read");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed", error: "the gate could not be read" });

  expect(openPromotionQuestions(db, work.id)).toEqual([expect.objectContaining({ title: `PR promotion failed: ${work.title}` })]);
});

// ADR 0241 決定6 / ADR 0403 決定2: 主経路の解決より前の枝で落ちた根も、workspace の Quarantine が抱えていれば失敗 question を重ねない
it.each(declinedRoots)("%sの門の読みが落ちても、workspace の Quarantine が開いていればその Quarantine を名乗り、昇格失敗 question を立てない", async (_, slug, declinedRoot) => {
  const { db, clock, landing, work, workspace } = await declinedRoot(`declined-branch-gate-read-quarantined-${slug}`);
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());
  failPrepareOnce(db, GATE_READ, "the gate could not be read");

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "quarantined",
    error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
  });

  // 門の読みは落ちた(落ちると元に戻る)—— Quarantine で手前に止まった根ではない
  expect(vi.isMockFunction(db.prepare)).toBe(false);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

it("着地の比較: tip を読めずに立った question を断念した根は ref を読まずに問い直すので、ref が動いていても止まらない", async () => {
  const { workspace, db, clock, landing, work } = await doneRootWithBaseline("landing-compare-abandoned-no-head");
  registerPrPromotionFailureQuestion(db, work, "token expired", clock.now());
  await answerPromotion(db, clock, landing, workspace, openPromotionQuestions(db, work.id)[0]!, "abandon promotion");
  git(workspace.path, "tag", "intruder");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed" });

  expect(reAsked(db, work.id)).toHaveLength(1);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: 追いつきが作業台の tip を取り込んだ retry が push の準備の間に動いた ref で止まれば、拒否文は ref を名指し text C6 も言う", async () => {
  const c = await catchUpConflictRoot("catch-up-taken-in-then-moved");
  await convergeOn(c.landing, c.repair.id);
  const [failure] = promotionFailures(c.db, c.repair.id);
  c.resolve();
  const tip = git(c.workbench(), "rev-parse", "HEAD");
  git(c.workbench(), "checkout", "--quiet", "-b", "side");
  commitWork(c.workbench(), "side.txt", "the human's other work\n");
  git(c.workbench(), "checkout", "--quiet", c.target);
  const window = holdAfter(c.github, "preparePush");

  const answering = answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry").then(() => undefined, (err: unknown) => err);
  await window.entered;
  git(c.workspace.path, "tag", "intruder");
  window.open();
  const refusal = await answering;

  const commit = listEventsOfKinds(c.db, ["workbench_taken_in"]).map(({ payload }) => (payload as { commit: string }).commit)[0]!;
  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain("refs/tags/intruder");
  expect((refusal as Error).message).toContain(`took ${tip} in as ${commit} on ${c.target}.`);
  expect(c.github.pushes).toEqual([]);
});

/** 盤面の外で閉じた PR の根と、その下で走らない todo の子。 */
async function blockingRootWithStrandedChild(name: string) {
  const root = await pushedRootWithBaseline(name);
  const { db, clock, work } = root;
  appendEvent(db, { taskId: work.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number: 1 }, at: clock.now() });
  return { ...root, child: attachUnsettledChild(db, clock, work.id) };
}

it("着地の比較: キューとタスクの表示の読み(閉じた根に塞がれた子・着地の状態)は、ref が動いていても Quarantine を立てない", async () => {
  const { workspace, db, work, child } = await blockingRootWithStrandedChild("landing-compare-views");
  git(workspace.path, "tag", "intruder");

  expect(blockingRootOf(db, () => workspace)(child)).toEqual({ task_id: work.id, pr_number: 1 });
  expect(landingState(db, getTask(db, work.id)!)).toBe("close_observed");

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("着地の比較: キューとタスクの表示の読みは、基準の行が無い workspace で最初の撮りをしない", async () => {
  const { workspace, db, work, child } = await blockingRootWithStrandedChild("landing-compare-views-rowless");
  dropWorkspaceState(db, workspace.name);

  expect(blockingRootOf(db, () => workspace)(child)).toEqual({ task_id: work.id, pr_number: 1 });

  expect(holdsBaseline(db, workspace.name)).toBe(false);
});
