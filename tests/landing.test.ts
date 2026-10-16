import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveExecutionAgent } from "../src/agent.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, latestEventOfTask, listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import {
  contentLeftBehind,
  countTasksAwaitingLanding,
  countTasksAwaitingLandingInWorkspace,
  createLanding,
  type Landing,
  landingAnnotation,
  registerLocalMergeQuestion,
  registerPrPromotionFailureQuestion,
} from "../src/landing.js";
import { type AuthorityProfile, loadRegistry, type MergeDial, UnknownAgentError } from "../src/registry.js";
import {
  answerQuestion,
  cancelTaskDirectly,
  completeTask,
  countUnsettledTasksReferencing,
  editTask,
  getTask,
  listBoard,
  pickupTask,
  recordPrOpened,
  registerTask,
  type Task,
  type TaskType,
} from "../src/tasks.js";
import { markTeardown } from "../src/teardown.js";
import { raiseObjection } from "../src/triage.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import {
  mergeTaskToProtected,
  OutOfBandProtectedBranchError,
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
  refreshProtectedBranch,
  releaseWorkspace,
  UnknownWorkspaceError,
  type WorkspaceConfig,
  writeBoardRefs,
} from "../src/workspace.js";
import { afterCiRead, awaitWindow, FakeClock, FakeGitHubClient, fakeHead, holdAfterMerge, seedTierNames, UNRESOLVABLE_AGENT, unusedLanding } from "./fakes.js";
import {
  commitWork,
  completedWork,
  defaultingTo,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  quarantineQuestion,
  queuedForAutoMerge,
  settleReviews,
  squashTaskIntoOrigin,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let db: Db | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  db?.close();
  db = undefined;
});

async function openBoard(): Promise<{ db: Db; clock: FakeClock }> {
  const boardDir = await tempDir("tidepool-landing-");
  const database = openDb(join(boardDir, "board.sqlite"));
  db = database;
  return { db: database, clock: new FakeClock() };
}

/** PR を worker として記録する。保護 workspace は無い。 */
function recordPrOpenedViaWorker(
  db: Db,
  task: Task,
  prNumber: number,
  workerId: string,
  now: Date,
  { authority, isProtected }: { authority?: Parameters<typeof recordPrOpened>[6]; isProtected?: boolean } = {},
): void {
  recordPrOpened(db, task, prNumber, fakeHead(prNumber), workerId, now, authority, isProtected, "worker");
}

function promotionFailures(board: Db, taskId: string) {
  return listBoard(board).filter(
    (candidate) => candidate.question_pending_pr_promotion_task_id === taskId,
  );
}

/** 別タスクのセッションを盤面の書き込み `boardWrite` をまたいで走らせ、解放する。
 *  盤面の書き込みの予告と畳み(ADR 0243)が効くのはこの形だけである —— 書き込みの後に拾う
 *  セッションは pickup で基準を全撮りする。`workerForges` は、そのセッションの worker が
 *  書き込みの前に偽造する ref。 */
async function straddle(
  board: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  boardWrite: () => Promise<unknown>,
  workerForges?: string,
): Promise<void> {
  const straddler = landingWork(board, clock);
  await prepareWorkspaceAtPickup(board, workspace, straddler, { now: new Date(0) });
  if (workerForges) git(workspace.path, "update-ref", workerForges, "HEAD");
  await boardWrite();
  commitWork(workspace.path, "straddler.txt", "work\n");
  releaseWorkspace(board, workspace, straddler, clock.now());
}

/** fake の push のたびに、転送の後で `effect` を撃つ —— push が失敗と報告されても撃つ。 */
function afterEachPush(github: FakeGitHubClient, effect: () => void): void {
  const prepare = github.preparePush.bind(github);
  github.preparePush = async (input) => {
    const push = await prepare(input);
    return () => {
      try {
        push();
      } finally {
        effect();
      }
    };
  };
}

/** 予告だけを残して落ちた盤面(ADR 0243 決定5): 口の書き込みの中で transaction を開き、畳みをその中に入れて捨てる ——
 *  落ちた盤面の畳みはディスクに届かない。ref は動かさない(動かすなら呼び手が後で書く)。 */
function announceThenCrash(board: Db, workspace: WorkspaceConfig, ref: string, newSha: string): void {
  writeBoardRefs(board, workspace, [[ref, newSha]], () => board.exec("BEGIN"));
  board.exec("ROLLBACK");
}

/** 収束を1回走らせ、`taskId` の根の verdict を返す。その回で扱わなかった(根でない・候補から外れた)なら undefined。 */
async function convergeOn(landing: Landing, taskId: string, answering?: string) {
  const verdicts = await landing.converge(answering === undefined ? undefined : { answering });
  return verdicts.find((root) => root.taskId === taskId)?.verdict;
}

/** タスクを完了し、盤面の完了時レビューを決着させる —— 収束が根に読むのは done の work だけである。 */
function finish(board: Db, clock: FakeClock, task: Task): Task {
  completeTask(board, getTask(board, task.id)!, FULL_HANDOFF, "worker", clock.now(), "worker");
  settleReviews(board, clock.now());
  return getTask(board, task.id)!;
}

// ADR 0241 決定1: 着地は入口が名指しせず、収束が記録と内容から根を導いて撃つ
it("収束は、保護ブランチへ帰る done の work を根に導いて PR を開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-converge-root");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);

  await expect(landing.converge()).resolves.toEqual([
    { taskId: work.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 1 } },
  ]);
  expect(github.requests).toMatchObject([{ branch: `task/${work.id}` }]);
});

it("work でないタスクは着地対象ではない", async () => {
  const workspace = await makeWorkspace("landing-verdict");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const question = registerTask(
    db,
    {
      type: "question",
      title: "choose",
      purpose: "choose one option",
      completion_criteria: "a choice is recorded",
      question: [{ title: "choice", options: ["yes", "no"], recommendation: "yes" }],
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );

  answerQuestion(db, question, ["yes"], clock.now(), undefined, undefined, undefined, "webui");

  await expect(landing.converge()).resolves.toEqual([]);
});

it("祖先の task branch へ帰る done の work には、何も刻まれず何も撃たれない —— 祖先の根だけが着地する", async () => {
  const workspace = await makeWorkspace("landing-lineage");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "integrate",
      purpose: "integrate child work",
      completion_criteria: "the child result is integrated",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  const child = registerTask(
    db,
    {
      type: "work",
      parent_id: parent.id,
      title: "implement",
      purpose: "implement one part",
      completion_criteria: "the part exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );

  git(workspace.path, "checkout", "-b", `task/${parent.id}`);
  commitWork(workspace.path, "feature.txt", "integrated\n");
  git(workspace.path, "branch", `task/${child.id}`);
  finish(db, clock, child);
  finish(db, clock, parent);
  const before = listEvents(db, child.id).length;

  await expect(landing.converge()).resolves.toEqual([
    { taskId: parent.id, verdict: { kind: "landed", form: "local_merge_question" } },
  ]);
  expect(listEvents(db, child.id)).toHaveLength(before);
  expect(listBoard(db).filter((t) => t.question_pending_local_merge_task_id === child.id)).toEqual([]);
});

it("保護ブランチへ運ぶ内容が無い work はその事実を返して記録する", async () => {
  const workspace = await makeWorkspace("landing-empty");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "inspect",
      purpose: "inspect the current state",
      completion_criteria: "the result is reported",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "branch", `task/${task.id}`);
  finish(db, clock, task);
  registerPrPromotionFailureQuestion(db, task, "first failed attempt", clock.now());
  registerPrPromotionFailureQuestion(db, task, "second failed attempt", clock.now());
  const failures = promotionFailures(db, task.id);

  await expect(convergeOn(landing, task.id, failures[0]!.id)).resolves.toEqual({
    kind: "nothing_to_land",
    base: "main",
  });
  expect(listEvents(db, task.id)).toContainEqual(
    expect.objectContaining({
      worker_id: "tidepool",
      origin: "board",
      payload: { kind: "nothing_to_land", base: "main" },
    }),
  );
  expect(getTask(db, failures[0]!.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(getTask(db, failures[1]!.id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, failures[1]!.id)).toContainEqual(
    expect.objectContaining({ payload: { kind: "pr_promotion_observed" } }),
  );
});

it("squash 済みで内容差が無い work は commit 差が残っていても着地しない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-squashed");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "already shipped",
      purpose: "recognize squash-equivalent content",
      completion_criteria: "no duplicate PR is opened",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "already on main\n");
  await squashTaskIntoOrigin(workspace, task.id);
  git(workspace.path, "fetch", "origin", "main");
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "nothing_to_land",
    base: "refs/remotes/origin/main",
  });
  expect(github.requests).toEqual([]);
});

// ADR 0240 決定2: 失敗 question が開いている根は、人間の回答を先回りしない。retry の回だけが門を読む
it("失敗 question が開いている根は収束が撃たず、retry の回が門で止まれば failure question を開いたままにして GitHub を再試行しない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-deferred");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptFailure(new Error("first promotion failed"));
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship reviewed work",
      completion_criteria: "the work is ready",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  const [failure] = promotionFailures(db, task.id);
  registerTask(
    db,
    {
      type: "review",
      parent_id: task.id,
      title: "review",
      purpose: "review the result",
      completion_criteria: "the review is complete",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  github.scriptFailure(null);

  await expect(convergeOn(landing, task.id)).resolves.toBeUndefined();
  expect(latestEventOfTask(db, task.id, "landing_deferred")).toBeUndefined();

  await expect(convergeOn(landing, task.id, failure!.id)).resolves.toEqual({
    kind: "deferred",
    reason: "attached_children",
    count: 1,
  });
  expect(listEvents(db, task.id)).toContainEqual(
    expect.objectContaining({
      payload: { kind: "landing_deferred", reason: "attached_children", count: 1 },
    }),
  );
  expect(getTask(db, failure!.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(listEvents(db, failure!.id)).not.toContainEqual(
    expect.objectContaining({ payload: { kind: "pr_promotion_observed" } }),
  );
  expect(github.requests).toHaveLength(1);
});

it("GitHub の無い purely-local work は merge question 面へ着地する", async () => {
  const workspace = await makeWorkspace("landing-local");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship locally",
      purpose: "ship a local change",
      completion_criteria: "the change awaits a merge decision",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "landed",
    form: "local_merge_question",
  });
  expect(listBoard(db)).toContainEqual(
    expect.objectContaining({
      status: "todo",
      question_pending_local_merge_task_id: task.id,
    }),
  );
});

it("purely-local の着地は ref を書かないので、またいだセッションが偽造した remote ref は quarantine される", async () => {
  const workspace = await makeWorkspace("landing-local-straddle");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  const remoteTaskRef = `refs/remotes/origin/task/${task.id}`;

  await straddle(
    db,
    clock,
    workspace,
    () => expect(convergeOn(landing, task.id)).resolves.toMatchObject({ form: "local_merge_question" }),
    remoteTaskRef,
  );

  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(remoteTaskRef);
});

it("remote-backed から purely-local へ変わった根の retry は local question を立てて受理される", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-became-local");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptFailure(new Error("token expired"));
  let currentWorkspace: WorkspaceConfig = workspace;
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    resolveWorkspace: () => currentWorkspace,
    github,
  });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship after publication mode changes",
      purpose: "land using the current workspace declaration",
      completion_criteria: "a current landing surface exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  const [failure] = promotionFailures(db, task.id);
  currentWorkspace = { ...workspace, repo: undefined };

  await answerPromotion(db, clock, landing, currentWorkspace, failure!, "retry");
  expect(getTask(db, failure!.id)).toMatchObject({ status: "done", question_answer: ["retry"] });
  expect(listBoard(db)).toContainEqual(
    expect.objectContaining({ question_pending_local_merge_task_id: task.id }),
  );
  expect(github.requests).toHaveLength(1);
});

it("GitHub の無い remote-backed work は閉じた理由で失敗し failure question を立てる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-no-github");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "failed",
    reason: "github_not_configured",
    error: "GitHub is not configured for PR promotion",
  });
  expect(listBoard(db)).toContainEqual(
    expect.objectContaining({
      status: "todo",
      question_pending_pr_promotion_task_id: task.id,
    }),
  );
});

it("remote-backed work は PR を開いた面を返す", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "landed",
    form: "pull_request_opened",
    prNumber: 1,
  });
  expect(github.requests).toMatchObject([{ branch: `task/${task.id}`, base: "main" }]);
  expect(github.requests[0]?.body).toMatch(/board/i);
  expect(github.requests[0]?.body).not.toMatch(/#\d/);
  expect(getTask(db, task.id)?.pr_number).toBe(1);
});

it("open PR を持つ work の修理は同じ PR の branch を更新する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-open-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  commitWork(workspace.path, "repair.txt", "fixed\n");

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "landed",
    form: "open_pull_request_updated",
    prNumber: 1,
  });
  expect(github.requests).toHaveLength(1);
  expect(github.pushes).toEqual([{ path: workspace.path, branch: `task/${task.id}` }]);
});

it("open PR 更新は盤面が動かした remote ref だけを予告して畳む", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-announce-fold");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "repair an open PR",
      purpose: "push the repair without hiding another ref write",
      completion_criteria: "only the board-written ref is announced and folded",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  finish(db, clock, task);
  recordPrOpenedViaWorker(db, task, 1, "worker", clock.now());

  // push をまたいで走る別タスクのセッションは、盤面の push を違反に数えない
  await straddle(db, clock, workspace, () => landing.converge());
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();

  await prepareWorkspaceAtPickup(db, workspace, task, { now: new Date(0) });
  commitWork(workspace.path, "repair.txt", "fixed\n");
  git(workspace.path, "tag", "worker-created-tag");

  await expect(convergeOn(landing, task.id)).resolves.toMatchObject({
    kind: "landed",
    form: "open_pull_request_updated",
  });
  releaseWorkspace(db, workspace, task, clock.now());

  const quarantine = quarantineQuestion(db, "workspace", workspace.name);
  expect(quarantine?.purpose).toContain("refs/tags/worker-created-tag");
  expect(quarantine?.purpose).not.toContain(`refs/remotes/origin/task/${task.id}`);
});

it("merge 済み PR に残った修理は閉じた理由で失敗し failure question を立てる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-merged-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptMergedOutside(1);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "failed",
    reason: "pull_request_already_merged",
    error: expect.stringContaining("PR #1 is already merged"),
  });
  expect(listBoard(db)).toContainEqual(
    expect.objectContaining({
      status: "todo",
      question_pending_pr_promotion_task_id: task.id,
    }),
  );
  expect(github.pushes).toEqual([]);
});

// ADR 0241 決定3: 盤面の外で閉じられた PR には push せず、閉じたことを観測として刻む(#1734)
it("盤面の外で閉じた PR を持つ根の収束は push せず、閉じた観測を1件だけ刻み、着地したと返さず失敗 question も立てない。次の回からは候補に入らず、retry は閉じたことを理由に拒まれる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-closed-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptClosedOutside(1);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "failed",
    reason: "pull_request_closed",
    error: expect.stringContaining("PR #1 was closed"),
  });
  await expect(convergeOn(landing, task.id)).resolves.toBeUndefined();
  expect(github.pushes).toEqual([]);
  expect(boardEvents(db, task.id, "pr_close_observed")).toEqual(closeObserved(1));
  expect(promotionFailures(db, task.id)).toEqual([]);

  registerPrPromotionFailureQuestion(db, getTask(db, task.id)!, "earlier failure", clock.now());
  const [failure] = promotionFailures(db, task.id);
  await expect(answerPromotion(db, clock, landing, workspace, failure!, "retry")).rejects.toThrow("PR #1 was closed");
  expect(getTask(db, failure!.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(github.pushes).toEqual([]);
});

it("無人 merge キューにいる閉じた PR は、収束が閉じた観測を刻んだ後の tick で観測を重ねない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-closed-queued-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptClosedOutside(1);
  const landing = autoMerging(db, clock, workspace, github);

  completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  settleReviews(db, clock.now());

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ reason: "pull_request_closed" });
  await landing.tick("auto_merge", clock.now());

  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
});

it("執行側が印を取っている閉じた PR は、収束が観測を刻まず、印を放した後の tick が1件だけ刻む", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-closed-marked-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptClosedOutside(1);
  const landing = autoMerging(db, clock, workspace, github);
  completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  settleReviews(db, clock.now());
  const release = landing.takeInFlightMark(getTask(db, work.id)!.workspace, 1)!;

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ reason: "pull_request_closed" });
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual([]);

  release();
  await landing.tick("auto_merge", clock.now());
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
});

/** 開いている PR を持つ根。fake の push は転送の**後**に失敗する —— 写しは動いたのに失敗と報告される形。 */
async function openPrWhosePushFailsAfterTransfer(name: string) {
  const { workspace } = await makeRemoteBackedWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptPushFailure(new Error("push rejected"));
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "repair the PR",
      purpose: "update the existing pull request",
      completion_criteria: "the repair reaches the PR branch",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  recordPrOpenedViaWorker(db, task, 1, "worker", clock.now());
  const pushFailed = () =>
    expect(convergeOn(landing, task.id)).resolves.toEqual({
      kind: "failed",
      reason: "promotion_failed",
      error: "push rejected",
    });
  return { workspace, db, clock, github, task, pushFailed, remoteTaskRef: `refs/remotes/origin/task/${task.id}` };
}

// ADR 0243 決定2: 畳みは ref を読み返した2択なので、失敗の報告のされ方に依らず、転送が済んでいれば押した値に畳む
it("転送の後に失敗と報告された open PR branch の push は failure question を立て、またいだセッションを quarantine しない", async () => {
  const { workspace, db, clock, task, pushFailed } = await openPrWhosePushFailsAfterTransfer("landing-push-failure");

  await straddle(db, clock, workspace, pushFailed);

  expect(listBoard(db)).toContainEqual(
    expect.objectContaining({ question_pending_pr_promotion_task_id: task.id }),
  );
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

// 押した値の1値に畳む —— 2値の行のまま残れば、予告の前の値(写しが無い)へ戻った写しを解放が通してしまう
it("転送の後に失敗と報告された push の後で写しが予告の前へ戻れば、またいだセッションは quarantine に落ち、基準の行は押した値の1値で名指しされる", async () => {
  const { workspace, db, clock, task, pushFailed, remoteTaskRef } = await openPrWhosePushFailsAfterTransfer("landing-push-failure-reverted");

  await straddle(db, clock, workspace, async () => {
    await pushFailed();
    git(workspace.path, "update-ref", "-d", remoteTaskRef);
  });

  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(
    `was: ${git(workspace.path, "rev-parse", `task/${task.id}`)} ${remoteTaskRef}`,
  );
});

// ADR 0243 決定2: 予告の窓で worker が偽造した値は基準に入らない —— 通るのは盤面が書こうとした値そのものだけ
it("push の後・畳みの前に worker が写しを偽造すれば、偽造は基準に入らず、またいだセッションは quarantine に落ちる", async () => {
  const { workspace, db, clock, github, pushFailed, remoteTaskRef } = await openPrWhosePushFailsAfterTransfer("landing-push-forged");
  afterEachPush(github, () => git(workspace.path, "update-ref", remoteTaskRef, "HEAD"));

  await straddle(db, clock, workspace, pushFailed);

  const purpose = quarantineQuestion(db, "workspace", workspace.name)?.purpose;
  expect(purpose).toContain(`now: ${git(workspace.path, "rev-parse", remoteTaskRef)} ${remoteTaskRef}`);
  // 予告の前の値(写しが無い)に畳まれている —— 2値のまま残っていれば `was: |<押した値>` が載る
  expect(purpose).not.toContain("was:");
});

// ADR 0243 決定1・5 / #1846: 盤面が予告した後・畳む前に落ちる(kill -9 でも子の push は完走する)。走っていた
// セッションの解放は、残った2値の行のどちらの値も違反と読まず、3つ目の値だけを違反と読む
it.each<[string, boolean, (path: string, ref: string, announced: string, elsewhere: string) => void]>([
  ["予告した値へ動いた", false, (path, ref, announced) => git(path, "update-ref", ref, announced)],
  ["予告の前の値(無い)のまま", false, () => {}],
  ["どちらでもない値へ動いた", true, (path, ref, _announced, elsewhere) => git(path, "update-ref", ref, elsewhere)],
])("予告だけを残して盤面が落ち、ref が%s解放は quarantine=%s", async (_, quarantined, move) => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-crash-after-announce");
  const { db, clock } = await openBoard();
  const ref = "refs/remotes/origin/task/pushed-by-the-board";
  const announced = git(workspace.path, "rev-parse", "HEAD");
  const elsewhere = git(workspace.path, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "elsewhere");
  const running = landingWork(db, clock);
  await prepareWorkspaceAtPickup(db, workspace, running, { now: new Date(0) });

  // 落ちた盤面: 予告は書かれ、書き込みは返らず、畳みは来ない
  announceThenCrash(db, workspace, ref, announced);
  move(workspace.path, ref, announced, elsewhere);
  commitWork(workspace.path, "running.txt", "work\n");
  releaseWorkspace(db, workspace, running, clock.now());

  const question = quarantineQuestion(db, "workspace", workspace.name);
  expect(question !== undefined).toBe(quarantined);
  // 動いた ref は2値の行のまま名指しされる(ADR 0243 / spec #1870)
  if (quarantined) expect(question?.purpose).toContain(`was: |${announced} ${ref}`);
});

// 畳みの失敗が書き込みの失敗を置き換えれば、人間に届く理由が git の理由ではなくなる
it("書き込みが投げた後に畳みも落ちれば、口は書き込みの失敗のほうを投げる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-fold-fails");
  const { db, clock } = await openBoard();
  await prepareWorkspaceAtPickup(db, workspace, landingWork(db, clock), { now: new Date(0) });
  const write = () => {
    db.exec("CREATE TEMP TRIGGER fold_fails BEFORE UPDATE ON workspace_state BEGIN SELECT RAISE(ABORT, 'fold failed'); END");
    throw new Error("push rejected");
  };

  expect(() => writeBoardRefs(db, workspace, [["refs/remotes/origin/task/x", git(workspace.path, "rev-parse", "HEAD")]], write)).toThrow(
    "push rejected",
  );
});

// ADR 0243 決定3: 写しを進める fetch は原本の sha を先に知ってから予告し、その sha だけを取って写しを書く
it("収束前の保護ブランチの fetch は写しを原本の sha へ進め、基準をその1値に畳み、refs/ に写し以外の差を残さない", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("landing-split-fetch");
  const { db, clock } = await openBoard();
  const running = landingWork(db, clock);
  await prepareWorkspaceAtPickup(db, workspace, running, { now: new Date(0) });
  publish("merged.txt", "merged on GitHub\n", "merged outside");
  const copy = "refs/remotes/origin/main";
  const pickedUp = git(workspace.path, "rev-parse", copy);
  const refsBesidesCopy = () => git(workspace.path, "for-each-ref", "--format=%(objectname) %(refname)").split("\n").filter((line) => !line.endsWith(` ${copy}`));
  const before = refsBesidesCopy();

  await refreshProtectedBranch(db, workspace, undefined);

  const original = git(workspace.path, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
  expect(git(workspace.path, "rev-parse", copy)).toBe(original);
  expect(refsBesidesCopy()).toEqual(before);
  // 原本の1値に畳まれている —— 2値の行のまま残れば、pickup の値へ戻った写しを解放が通してしまう
  git(workspace.path, "update-ref", copy, pickedUp);
  commitWork(workspace.path, "running.txt", "work\n");
  releaseWorkspace(db, workspace, running, clock.now());
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(`was: ${original} ${copy}`);
});

it("PR 作成の失敗は閉じた理由で返して failure question を立てる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-pr-failure");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptFailure(new Error("token expired"));
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "failed",
    reason: "promotion_failed",
    error: "token expired",
  });
  expect(listBoard(db)).toContainEqual(
    expect.objectContaining({
      status: "todo",
      question_pending_pr_promotion_task_id: task.id,
    }),
  );
});

// ADR 0241 決定4: PR は作る前に、同じタスクブランチの PR を探す
it("GitHub に同じ head の開いた PR がある根の着地は PR を作らず、その番号を記録して merge question を開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-find-open-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const existing = github.scriptPullRequestOnBranch(`task/${work.id}`);
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "landed", form: "pull_request_opened", prNumber: existing });
  expect(github.requests).toEqual([]);
  expect(getTask(db, work.id)?.pr_number).toBe(existing);
  expect(mergeQuestions(db).map(({ pr }) => pr)).toEqual([existing]);
  // 作ったときと同じく、タスクブランチの今の内容を押してから記録する —— 落ちた後に帰った修理も PR に載る
  expect(github.pushes.map(({ branch }) => branch)).toEqual([`task/${work.id}`]);
  expect(git(workspace.path, "rev-parse", `origin/task/${work.id}`)).toBe(git(workspace.path, "rev-parse", "HEAD"));
});

it("PR の作成の後・記録の前に盤面が落ちた根(GitHub にだけ PR がある)の着地は、作成を呼ばず失敗 question も立てない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-find-unrecorded-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  github.scriptPullRequestOnBranch(`task/${work.id}`);
  finish(db, clock, work);

  await landing.converge();

  expect(github.requests).toEqual([]);
  expect(promotionFailures(db, work.id)).toEqual([]);
});

it("GitHub に同じ head の merge 済み PR がある根の着地は、番号と merge の観測を刻み、失敗 question を1枚立てる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-find-merged-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const merged = github.scriptPullRequestOnBranch(`task/${work.id}`);
  github.scriptMergedOutside(merged);
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "pull_request_already_merged" });
  expect(github.requests).toEqual([]);
  expect(getTask(db, work.id)?.pr_number).toBe(merged);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_merge_observed", pr_number: merged } },
  ]);
  expect(promotionFailures(db, work.id)).toHaveLength(1);
});

it("GitHub に同じ head の閉じた PR がある根の着地は、番号と閉じた観測を刻み、PR を作らず失敗 question も立てない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-find-closed-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const closed = github.scriptPullRequestOnBranch(`task/${work.id}`);
  github.scriptClosedOutside(closed);
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "pull_request_closed" });
  expect(github.requests).toEqual([]);
  expect(getTask(db, work.id)?.pr_number).toBe(closed);
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(closed));
  expect(promotionFailures(db, work.id)).toEqual([]);
});

it("同じ head の PR を探す読み取りが失敗した根の着地は、PR を作らず失敗 question に落ちる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-find-failure");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptFindFailure(new Error("gh pr list failed"));
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "failed",
    reason: "promotion_failed",
    error: "gh pr list failed",
  });
  expect(github.requests).toEqual([]);
  expect(promotionFailures(db, work.id)).toHaveLength(1);
});

it("workspace 不在は閉じた理由で返す", async () => {
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship a change",
      completion_criteria: "the change is shipped",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "failed",
    reason: "workspace_unavailable",
    error: "no workspace is configured for landing",
  });
});

it("retry 時の registry drift は workspace の quarantine を名乗る verdict を返し、既存の failure question を引退させない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-registry-drift");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
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
  });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship despite a transient registry repair",
      completion_criteria: "the failure remains actionable",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  github.scriptFailure(new Error("first promotion failed"));
  finish(db, clock, task);
  await landing.converge();
  const [failure] = promotionFailures(db, task.id);
  drifted = true;
  github.scriptFailure(null);

  await expect(convergeOn(landing, task.id, failure!.id)).resolves.toEqual({
    kind: "quarantined",
    error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
  });
  expect(promotionFailures(db, task.id)).toHaveLength(1);
  expect(getTask(db, failure!.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(listEvents(db, failure!.id)).not.toContainEqual(
    expect.objectContaining({ payload: { kind: "pr_promotion_observed" } }),
  );
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined();
  expect(github.requests).toHaveLength(1);
});

// ADR 0241 決定6: 止まっている原因は workspace の quarantine の question としてすでに出ている
it("workspace が quarantine で門が開いている根の収束は、失敗 question を立てず、verdict は workspace の quarantine を名乗る", async () => {
  const workspace = await makeWorkspace("landing-needs-human");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "quarantined",
    error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
  });
  expect(promotionFailures(db, task.id)).toEqual([]);
});

// ADR 0241 決定3: 門は workspace の quarantine より先に読む(#1834)
it("workspace が quarantine で門が閉じている根の収束は、門で待つ verdict を返し失敗 question を立てない", async () => {
  const workspace = await makeWorkspace("landing-needs-human-gate");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  attachUnsettledChild(db, clock, task.id);
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());

  await expect(convergeOn(landing, task.id)).resolves.toEqual({ kind: "deferred", reason: "attached_children", count: 1 });
  expect(promotionFailures(db, task.id)).toEqual([]);
});

it("根でない分解の親は、付帯子が未決着でも門で待った記録を刻まない", async () => {
  const workspace = await makeWorkspace("landing-lineage-gate");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const root = landingWork(db, clock);
  const parent = finish(db, clock, attachUnsettledChild(db, clock, root.id));
  attachUnsettledChild(db, clock, parent.id);

  await expect(convergeOn(landing, parent.id)).resolves.toBeUndefined();
  expect(latestEventOfTask(db, parent.id, "landing_deferred")).toBeUndefined();
});

it("着地判定の Git failure も throw せず閉じた失敗 verdict と question にする", async () => {
  const workspace = await makeWorkspace("landing-git-failure");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "surface a broken landing checkout",
      completion_criteria: "the failure is actionable",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "update-ref", "-d", "refs/heads/main");
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toMatchObject({
    kind: "failed",
    reason: "promotion_failed",
    error: expect.any(String),
  });
  expect(promotionFailures(db, task.id)).toContainEqual(
    expect.objectContaining({ status: "todo" }),
  );
});

it("着地成立は積み上がった failure question を引退させ、回答中の1件だけ除外する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-retirement");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptFailure(new Error("token expired"));
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  // 収束は失敗 question の開いた根を撃たないので、積み上がった形は直接作る
  registerPrPromotionFailureQuestion(db, task, "token expired", clock.now());
  const failures = promotionFailures(db, task.id);
  expect(failures).toHaveLength(2);
  github.scriptFailure(null);

  await expect(convergeOn(landing, task.id, failures[0]!.id)).resolves.toMatchObject({
    kind: "landed",
    form: "pull_request_opened",
  });
  expect(getTask(db, failures[0]!.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(getTask(db, failures[1]!.id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, failures[1]!.id)).toContainEqual(
    expect.objectContaining({ payload: { kind: "pr_promotion_observed" } }),
  );
});

it("retry の時点で運ぶ内容が無ければ回答を受理し、着地対象なしを1件だけ刻んで兄弟の failure question を引退させる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-retry-nothing");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptFailure(new Error("token expired"));
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  registerPrPromotionFailureQuestion(db, task, "token expired", clock.now());
  const failures = promotionFailures(db, task.id);
  github.scriptFailure(null);
  git(workspace.path, "update-ref", "refs/remotes/origin/main", `refs/heads/task/${task.id}`);

  await answerPromotion(db, clock, landing, workspace, failures[0]!, "retry");

  expect(getTask(db, failures[0]!.id)).toMatchObject({ status: "done", question_answer: ["retry"] });
  expect(getTask(db, failures[1]!.id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, failures[1]!.id)).toContainEqual(
    expect.objectContaining({ payload: { kind: "pr_promotion_observed" } }),
  );
  expect(listEvents(db, task.id).filter((e) => e.kind === "nothing_to_land")).toHaveLength(1);
  expect(github.requests).toHaveLength(1);
});

it("未束ねの異議がある work は同じ門で理由と数を返す", async () => {
  const workspace = await makeWorkspace("landing-objection");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship an agreed change",
      completion_criteria: "the change is ready",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  raiseUnbundledObjection(db, clock, task.id);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "deferred",
    reason: "objections",
    count: 1,
  });
  expect(listEvents(db, task.id)).toContainEqual(
    expect.objectContaining({
      payload: { kind: "landing_deferred", reason: "objections", count: 1 },
    }),
  );
});

it("収束は open PR を持つ根を更新し、ローカル着地の question を持つ根は撃たない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-ancestors");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const root = registerTask(
    db,
    {
      type: "work",
      title: "root",
      purpose: "integrate the work",
      completion_criteria: "the tree is integrated",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "branch", `task/${root.id}`);
  completeTask(db, root, FULL_HANDOFF, "worker", clock.now(), "worker");
  registerLocalMergeQuestion(db, root, "keep this settled surface", clock.now());
  const parent = registerTask(
    db,
    {
      type: "work",
      parent_id: root.id,
      title: "parent",
      purpose: "hold the open PR",
      completion_criteria: "the PR is open",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${parent.id}`, "main");
  commitWork(workspace.path, "feature.txt", "ready\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now(), "worker");
  recordPrOpenedViaWorker(db, parent, 1, "worker", clock.now());
  commitWork(workspace.path, "repair.txt", "fixed\n");
  const settled = registerTask(
    db,
    {
      type: "review",
      parent_id: parent.id,
      title: "review",
      purpose: "review the repair",
      completion_criteria: "the review is complete",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );

  completeTask(db, settled, undefined, "worker", clock.now(), "worker");

  await expect(landing.converge()).resolves.toEqual([
    {
      taskId: parent.id,
      verdict: { kind: "landed", form: "open_pull_request_updated", prNumber: 1 },
    },
  ]);
  expect(github.pushes).toEqual([{ path: workspace.path, branch: `task/${parent.id}` }]);
});

// ADR 0241 決定2 / ADR 0106 決定7: 着地の書き込みは盤面で1本の列を流れる —— 並走の窓(#412・#1835)そのものが無い
it("2つの収束を重ねても同じ根の PR は1回だけ作られ、回の途中の突きは束ねられて、その後にちょうど1回走る", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-lane");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const window = awaitWindow();
  const create = github.createPullRequest.bind(github);
  github.createPullRequest = async (input) => {
    await window.hold();
    return create(input);
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const first = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${first.id}`);
  commitWork(workspace.path, "feature.txt", "first\n");
  finish(db, clock, first);

  const running = landing.converge();
  await window.entered;
  // 回の途中で、もう1つの根が完了し、突きが3回届く
  const second = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${second.id}`, "main");
  commitWork(workspace.path, "second.txt", "second\n");
  finish(db, clock, second);
  const pokes = [landing.converge(), landing.converge(), landing.converge()];
  window.open();

  await expect(running).resolves.toEqual([
    { taskId: first.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 1 } },
  ]);
  const after = await Promise.all(pokes);
  // 突いた呼び手はみな、突いた後に始まった同じ1回の結果を受け取る
  expect(after[1]).toBe(after[0]);
  expect(after[2]).toBe(after[0]);
  expect(after[0]).toEqual([
    { taskId: first.id, verdict: { kind: "up_to_date", prNumber: 1 } },
    { taskId: second.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 2 } },
  ]);
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${first.id}`, `task/${second.id}`]);
  expect(promotionFailures(db, first.id)).toEqual([]);
});

it("人間が担当して完了した work は根にならず、何も撃たれない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-human-work");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    { type: "work", title: "done by hand", purpose: "p", completion_criteria: "c", assignee: "human" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  completeTask(db, task, undefined, "human", clock.now(), "webui");

  await expect(landing.converge()).resolves.toEqual([]);
  expect(promotionFailures(db, task.id)).toEqual([]);
  expect(github.requests).toEqual([]);
});

// ADR 0240 決定2: 後始末が未了の行と、その行が着地し直す祖先は、その後始末の分なので外す
it("後始末が未了の行を木に持つ根は、収束が撃たない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-teardown-unfinished");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const root = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${root.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, root);
  const repair = finish(db, clock, attachUnsettledChild(db, clock, root.id));
  markTeardown(db, repair.id, clock.now());

  await expect(landing.converge()).resolves.toEqual([]);
  expect(github.requests).toEqual([]);
});

// ADR 0241 決定1(spec #1839 A): merge 済みの PR の根は、根自身のブランチを保護ブランチと比べる
/** 収束が PR #1 を開いた根。checkout は根のタスクブランチに残る。 */
async function rootWithOpenedPr(name: string) {
  const { workspace } = await makeRemoteBackedWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const root = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${root.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, root);
  await landing.converge();
  return { workspace, db, clock, github, landing, root: getTask(db, root.id)! };
}

/** GitHub が PR を merge する —— origin 側のタスクブランチ(PR の head)を origin の保護ブランチへ squash する。
 *  手元の保護ブランチの写しは動かさない(盤面が fetch するまで古い)。 */
async function mergeOnGitHub(workspace: WorkspaceConfig, taskId: string) {
  const merger = await tempDir("tidepool-github-merge-");
  git(merger, "clone", workspace.repo!, ".");
  git(merger, "merge", "--squash", `origin/task/${taskId}`);
  git(merger, "commit", "-m", "squash the PR on GitHub");
  git(merger, "push", "origin", "main");
}

function boardMerged(db: Db, clock: FakeClock, taskId: string, prNumber: number) {
  appendEvent(db, { taskId, workerId: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_merged", pr_number: prNumber }, at: clock.now() });
}

it("merge 済みの PR の根に運ぶ内容が無ければ着地が終わった事実を1回刻み、次の回からは git も読まない", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-merged-finished");
  await squashTaskIntoOrigin(workspace, root.id);
  git(workspace.path, "fetch", "origin", "main");
  boardMerged(db, clock, root.id, 1);

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "nothing_to_land", base: "refs/remotes/origin/main" });
  expect(boardEvents(db, root.id, "landing_finished")).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "landing_finished", pr_number: 1 } },
  ]);

  // 読めば壊れていると分かる checkout でも、終わった根は読まれない
  git(workspace.path, "checkout", "main");
  git(workspace.path, "branch", "-D", `task/${root.id}`);
  await expect(landing.converge()).resolves.toEqual([]);
  expect(promotionFailures(db, root.id)).toEqual([]);
  expect(boardEvents(db, root.id, "landing_finished")).toHaveLength(1);
  expect(github.stateChecks).toEqual([]);
});

it("盤面が merge した直後で保護ブランチの写しがまだ古くても、収束は保護ブランチを読み直し、運ぶ内容が無ければ失敗 question を立てず着地が終わったと刻む", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-merged-stale-main");
  await mergeOnGitHub(workspace, root.id);
  boardMerged(db, clock, root.id, 1);

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "nothing_to_land", base: "refs/remotes/origin/main" });
  expect(promotionFailures(db, root.id)).toEqual([]);
  expect(boardEvents(db, root.id, "landing_finished")).toHaveLength(1);
  expect(github.stateChecks).toEqual([]);
});

it("merge の後に根のブランチへ帰った修理は、失敗 question を1回だけ立てる", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-merged-repair");
  await mergeOnGitHub(workspace, root.id);
  boardMerged(db, clock, root.id, 1);
  commitWork(workspace.path, "repair.txt", "merged back after the merge\n");

  await expect(convergeOn(landing, root.id)).resolves.toEqual({
    kind: "failed",
    reason: "pull_request_already_merged",
    error: expect.stringContaining("PR #1 is already merged"),
  });
  await landing.converge();

  expect(promotionFailures(db, root.id)).toHaveLength(1);
  expect(boardEvents(db, root.id, "landing_finished")).toEqual([]);
  expect(github.pushes).toEqual([]);
});

it("merge の後に完了して自分で根になった子孫は自分の PR を開き、merge 済みの根には偽の失敗 question が立たない", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-merged-descendant");
  await squashTaskIntoOrigin(workspace, root.id);
  git(workspace.path, "fetch", "origin", "main");
  boardMerged(db, clock, root.id, 1);
  const repair = attachUnsettledChild(db, clock, root.id);
  git(workspace.path, "checkout", "-b", `task/${repair.id}`, "refs/remotes/origin/main");
  commitWork(workspace.path, "repair.txt", "after the merge\n");
  finish(db, clock, repair);

  await expect(landing.converge()).resolves.toEqual([
    { taskId: root.id, verdict: { kind: "nothing_to_land", base: "refs/remotes/origin/main" } },
    { taskId: repair.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 2 } },
  ]);
  expect(promotionFailures(db, root.id)).toEqual([]);
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`, `task/${repair.id}`]);
});

it("PR の状態を読んだ後に merge され、その後に push した修理は、merge された head に無いので失敗 question を1回だけ立て、着地が終わったとは刻まない", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-merged-after-read");
  commitWork(workspace.path, "repair.txt", "pushed after the merge\n");
  const readState = github.getPullRequestState.bind(github);
  github.getPullRequestState = async (ref) => {
    const state = await readState(ref);
    // 収束が OPEN を読んだ直後に、無人 merge が PR の head(修理の前)を merge する
    await mergeOnGitHub(workspace, root.id);
    boardMerged(db, clock, root.id, 1);
    return state;
  };
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  github.getPullRequestState = readState;

  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ kind: "failed", reason: "pull_request_already_merged" });
  await landing.converge();

  expect(promotionFailures(db, root.id)).toHaveLength(1);
  expect(boardEvents(db, root.id, "landing_finished")).toEqual([]);
});

// ADR 0241: 開いている PR の根は、積み残しがあるときだけ push する
it("積み残しの無い開いた PR の根は、GitHub を1回も呼ばない", async () => {
  const { github, landing, root } = await rootWithOpenedPr("landing-open-pr-idle");
  const requests = github.requests.length;

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "up_to_date", prNumber: 1 });
  expect(github.requests).toHaveLength(requests);
  expect(github.pushes).toEqual([]);
  expect(github.stateChecks).toEqual([]);
});

it("運ぶ内容の無い根の nothing_to_land と、門で待った根の landing_deferred は、何回収束しても1回しか刻まれない", async () => {
  const workspace = await makeWorkspace("landing-once");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const empty = landingWork(db, clock);
  git(workspace.path, "branch", `task/${empty.id}`);
  finish(db, clock, empty);
  const waiting = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${waiting.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, waiting);
  attachUnsettledChild(db, clock, waiting.id);

  for (let pass = 0; pass < 3; pass++) await landing.converge();

  expect(boardEvents(db, empty.id, "nothing_to_land")).toHaveLength(1);
  expect(boardEvents(db, waiting.id, "landing_deferred")).toHaveLength(1);
});

// ADR 0250: 閉じた PR の根と断念した根の子孫も記録で外さず、lineage が根かどうかを決める
it.each(["closed", "abandoned"] as const)("%s の根の内容が保護ブランチにあれば、その下で完了した子孫は自分で根になり自分の PR を開く", async (shape) => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr(`landing-carried-${shape}`);
  if (shape === "closed") {
    github.scriptClosedOutside(1);
    commitWork(workspace.path, "repair.txt", "a repair the closed PR never gets\n");
    await landing.converge();
  } else {
    registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
    await answerPromotion(db, clock, landing, workspace, promotionFailures(db, root.id)[0]!, "abandon promotion");
  }
  await squashTaskIntoOrigin(workspace, root.id);
  git(workspace.path, "fetch", "origin", "main");
  const child = attachUnsettledChild(db, clock, root.id);
  git(workspace.path, "checkout", "-b", `task/${child.id}`, "refs/remotes/origin/main");
  commitWork(workspace.path, "child.txt", "the child's own change\n");
  finish(db, clock, child);

  await expect(convergeOn(landing, child.id)).resolves.toEqual({ kind: "landed", form: "pull_request_opened", prNumber: 2 });
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`, `task/${child.id}`]);
});

it("PR が開いている根の下で完了し、根のブランチへ帰る子孫は撃たれず、根がその内容を push する", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-carried-open");
  const child = attachUnsettledChild(db, clock, root.id);
  git(workspace.path, "checkout", "-b", `task/${child.id}`);
  commitWork(workspace.path, "repair.txt", "merged back\n");
  git(workspace.path, "checkout", `task/${root.id}`);
  git(workspace.path, "merge", "--no-edit", `task/${child.id}`);
  finish(db, clock, child);

  await expect(landing.converge()).resolves.toEqual([
    { taskId: root.id, verdict: { kind: "landed", form: "open_pull_request_updated", prNumber: 1 } },
  ]);
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`]);
});

// ADR 0250 決定1 / ADR 0229 決定3: 閉じた根への修理は閉じる判断の内側で、問い返さない
it("閉じた PR の根の内容が保護ブランチに無いまま、根のブランチへ帰って完了した子孫は撃たれず、根にも push せず、question も立たない", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-carried-closed-back");
  github.scriptClosedOutside(1);
  commitWork(workspace.path, "repair.txt", "a repair the closed PR never gets\n");
  await landing.converge();
  expect(boardEvents(db, root.id, "pr_close_observed")).toHaveLength(1);
  const child = attachUnsettledChild(db, clock, root.id);
  git(workspace.path, "checkout", "-b", `task/${child.id}`);
  commitWork(workspace.path, "child.txt", "merged back\n");
  git(workspace.path, "checkout", `task/${root.id}`);
  git(workspace.path, "merge", "--no-edit", `task/${child.id}`);
  finish(db, clock, child);

  await expect(landing.converge()).resolves.toEqual([]);
  expect(github.pushes).toEqual([]);
  expect(promotionFailures(db, root.id)).toEqual([]);
});

// #1840 の実装で見つけた3点(#1842 のコメント)
it("断念した根の PR が盤面の外で閉じられたと観測されていれば、内容が変わっても昇格を問い直さない", async () => {
  const { workspace, db, clock, landing, root } = await rootWithOpenedPr("landing-abandoned-then-closed");
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  await answerPromotion(db, clock, landing, workspace, promotionFailures(db, root.id)[0]!, "abandon promotion");
  appendEvent(db, { taskId: root.id, workerId: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number: 1 }, at: clock.now() });
  commitWork(workspace.path, "repair.txt", "changed after the abandon\n");

  await expect(landing.converge()).resolves.toEqual([]);
  expect(openPromotionQuestions(db, root.id)).toEqual([]);
});

it("閉じた PR を初めて読んだ根は、追いつきの merge をせずにタスクブランチを残す", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-closed-no-catch-up");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const parent = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${parent.id}`);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  finish(db, clock, parent);
  recordPrOpenedViaWorker(db, parent, 1, "worker", clock.now());
  const repair = attachUnsettledChild(db, clock, parent.id);
  git(workspace.path, "checkout", "-b", `task/${repair.id}`, `task/${parent.id}`);
  await squashTaskIntoOrigin(workspace, parent.id);
  git(workspace.path, "fetch", "origin", "main");
  boardMerged(db, clock, parent.id, 1);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, repair);
  recordPrOpenedViaWorker(db, repair, 2, "worker", clock.now());
  github.scriptClosedOutside(2);
  const before = git(workspace.path, "rev-parse", `task/${repair.id}`);

  await expect(convergeOn(landing, repair.id)).resolves.toMatchObject({ kind: "failed", reason: "pull_request_closed" });
  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(before);
  expect(github.pushes).toEqual([]);
});

it("nothing_to_land を刻んだ根の子の修理は根のブランチへ帰らず、自分で根になって着地する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-nothing-then-repair");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const root = landingWork(db, clock);
  git(workspace.path, "branch", `task/${root.id}`, "refs/remotes/origin/main");
  finish(db, clock, root);
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ kind: "nothing_to_land" });
  // 修理を後始末と同じ形で拾い、commit し、完了して merge back する
  const repair = attachUnsettledChild(db, clock, root.id);
  await prepareWorkspaceAtPickup(db, workspace, repair, { now: new Date(0) });
  commitWork(workspace.path, "repair.txt", "repaired after nothing to land\n");
  const done = finish(db, clock, repair);
  releaseWorkspace(db, workspace, done, clock.now(), true);

  await expect(landing.converge()).resolves.toEqual([
    { taskId: repair.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 1 } },
  ]);
  expect(git(workspace.path, "rev-parse", `task/${root.id}`)).toBe(git(workspace.path, "rev-parse", "refs/remotes/origin/main"));
  expect(boardEvents(db, root.id, "nothing_to_land")).toHaveLength(1);
});

// 根かどうか読めない候補は、黙って飛ばさず、その根の失敗として人間に見せる(着地の module の旧 land() と同じ結果)
it("workspace を解決できない、親を持つ完了 work は、workspace を quarantine に落とし、失敗 question を立てない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-child-unresolvable");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    resolveWorkspace: (name) => {
      if (name === "ghost") throw new UnknownWorkspaceError(name);
      return workspace;
    },
    github,
  });
  const parent = landingWork(db, clock);
  const child = registerTask(
    db,
    { type: "work", title: "lost child", purpose: "p", completion_criteria: "c", parent_id: parent.id, workspace: "ghost" },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  finish(db, clock, child);

  await expect(convergeOn(landing, child.id)).resolves.toEqual({
    kind: "quarantined",
    error: 'workspace "ghost" is quarantined and needs human attention before landing; answer its quarantine question',
  });
  await landing.converge();
  expect(promotionFailures(db, child.id)).toEqual([]);
  expect(quarantineQuestion(db, "workspace", "ghost")).toBeDefined();
});

it("lineage が読めない完了 work は、その根の失敗として失敗 question を1枚立て、他の根は着地する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-lineage-unreadable");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  // 完了した親のタスクブランチが無いので、子の lineage を解く git が失敗する
  const parent = landingWork(db, clock);
  const child = attachUnsettledChild(db, clock, parent.id);
  git(workspace.path, "branch", `task/${child.id}`);
  finish(db, clock, child);
  finish(db, clock, parent);
  const healthy = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${healthy.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, healthy);

  const verdicts = await landing.converge();

  expect(verdicts.find((root) => root.taskId === child.id)?.verdict).toMatchObject({ kind: "failed", reason: "promotion_failed" });
  expect(verdicts.find((root) => root.taskId === healthy.id)?.verdict).toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(promotionFailures(db, child.id)).toHaveLength(1);
});

it("回の途中で後始末に入った木の根は、その回でも撃たれない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-teardown-mid-pass");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const window = awaitWindow();
  const create = github.createPullRequest.bind(github);
  github.createPullRequest = async (input) => {
    if (input.branch === `task/${first.id}`) await window.hold();
    return create(input);
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const first = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${first.id}`);
  commitWork(workspace.path, "first.txt", "first\n");
  finish(db, clock, first);
  const second = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${second.id}`, "main");
  commitWork(workspace.path, "second.txt", "second\n");
  finish(db, clock, second);

  const running = landing.converge();
  await window.entered;
  const repair = finish(db, clock, attachUnsettledChild(db, clock, second.id));
  markTeardown(db, repair.id, clock.now());
  window.open();

  expect((await running).map(({ taskId }) => taskId)).toEqual([first.id]);
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${first.id}`]);
});

// ADR 0241 決定5: retry は、答えている根をその回が撃たなかった理由を verdict で受け取る
it("retry が答えている根を回が撃たなければ、閉じた PR・未了の後始末・根でなくなった、の理由を verdict に持つ", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-retry-excluded");
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  const [failure] = promotionFailures(db, root.id);
  const repair = finish(db, clock, attachUnsettledChild(db, clock, root.id));
  markTeardown(db, repair.id, clock.now());

  await expect(convergeOn(landing, root.id, failure!.id)).resolves.toMatchObject({ kind: "excluded", reason: "teardown_unfinished" });

  db.prepare("UPDATE tasks SET teardown_started_at = NULL WHERE id = ?").run(repair.id);
  github.scriptClosedOutside(1);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  await convergeOn(landing, root.id, failure!.id);
  await expect(convergeOn(landing, root.id, failure!.id)).resolves.toEqual({
    kind: "excluded",
    reason: "pull_request_closed",
    error: `PR #1 was closed outside the board, so task/${root.id} is not pushed to it`,
  });

  const done = finish(db, clock, landingWork(db, clock));
  appendEvent(db, { taskId: done.id, workerId: BOARD_WORKER_ID, origin: "board", payload: { kind: "nothing_to_land", base: "main" }, at: clock.now() });
  registerPrPromotionFailureQuestion(db, done, "stale", clock.now());
  const [stale] = promotionFailures(db, done.id);
  await expect(convergeOn(landing, done.id, stale!.id)).resolves.toMatchObject({ kind: "excluded", reason: "not_a_root" });
});

it("1つの根の失敗はその根に閉じ込められ、回は残りの根を着地させる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-contained");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  // タスクブランチを持たない根は、内容を比べる git が失敗する
  const broken = finish(db, clock, landingWork(db, clock));
  const healthy = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${healthy.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, healthy);

  await expect(landing.converge()).resolves.toEqual([
    { taskId: broken.id, verdict: expect.objectContaining({ kind: "failed", reason: "promotion_failed" }) },
    { taskId: healthy.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 1 } },
  ]);
});

it("候補の読み取りそのものが失敗した回は、ログに出して何も撃たずに終わり、次の突きで走り直す", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-candidate-read");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(db, "prepare").mockImplementationOnce(() => {
    throw new Error("database is locked");
  });

  await expect(landing.converge()).resolves.toEqual([]);
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("[landing]"), expect.objectContaining({ message: "database is locked" }));
  expect(github.requests).toEqual([]);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
});

// ADR 0241 決定5 / ADR 0106 決定5: retry は、答えている question を開いていないと読む回を1回待ち、その根の verdict で受理・拒否される
it("走っている回の途中で届いた retry は、その後に始まる回の verdict で受理され、その根の PR が開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-retry-mid-pass");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const window = awaitWindow();
  const create = github.createPullRequest.bind(github);
  github.createPullRequest = async (input) => {
    if (input.branch === `task/${busy.id}`) await window.hold();
    return create(input);
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const failed = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${failed.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, failed);
  registerPrPromotionFailureQuestion(db, failed, "token expired", clock.now());
  const [failure] = promotionFailures(db, failed.id);
  const busy = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${busy.id}`, "main");
  commitWork(workspace.path, "busy.txt", "busy\n");
  finish(db, clock, busy);

  const running = landing.converge();
  await window.entered;
  const answered = answerPromotion(db, clock, landing, workspace, failure!, "retry");
  window.open();
  await running;

  await expect(answered).resolves.toMatchObject({ id: failure!.id });
  expect(getTask(db, failure!.id)).toMatchObject({ status: "done", question_answer: ["retry"] });
  expect(getTask(db, failed.id)?.pr_number).not.toBeNull();
});

it("fork 元が squash 着地した根は保護ブランチへ merge で追いついてから PR を開く", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-catch-up");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "parent",
      purpose: "ship the parent change",
      completion_criteria: "the parent PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${parent.id}`);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now(), "worker");
  recordPrOpenedViaWorker(db, parent, 1, "worker", clock.now());
  const repair = registerTask(
    db,
    {
      type: "work",
      parent_id: parent.id,
      title: "repair",
      purpose: "repair the landed result",
      completion_criteria: "a repair PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${repair.id}`, `task/${parent.id}`);
  await squashTaskIntoOrigin(workspace, parent.id);
  git(workspace.path, "fetch", "origin", "main");
  commitWork(workspace.path, "repair.txt", "fixed\n");
  const before = git(workspace.path, "rev-parse", `task/${repair.id}`);
  finish(db, clock, repair);

  await expect(convergeOn(landing, repair.id)).resolves.toMatchObject({
    kind: "landed",
    form: "pull_request_opened",
  });
  expect(
    git(
      workspace.path,
      "diff",
      "--name-only",
      `refs/remotes/origin/main...task/${repair.id}`,
    ),
  ).toBe("repair.txt");
  const [, firstParent, secondParent] = git(
    workspace.path,
    "rev-list",
    "--parents",
    "-n",
    "1",
    `task/${repair.id}`,
  ).split(" ");
  expect(firstParent).toBe(before);
  expect(secondParent).toBe(git(workspace.path, "rev-parse", "refs/remotes/origin/main"));
});

it("追いつき merge をまたいで走るセッションは、盤面が動かした task branch で quarantine されない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-catch-up-straddle");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const parent = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${parent.id}`);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now(), "worker");
  recordPrOpenedViaWorker(db, parent, 1, "worker", clock.now());
  const repair = attachUnsettledChild(db, clock, parent.id);
  git(workspace.path, "checkout", "-b", `task/${repair.id}`, `task/${parent.id}`);
  await squashTaskIntoOrigin(workspace, parent.id);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  const before = git(workspace.path, "rev-parse", `task/${repair.id}`);
  finish(db, clock, repair);

  await straddle(db, clock, workspace, () => landing.converge());

  expect(git(workspace.path, "rev-parse", `task/${repair.id}^1`)).toBe(before);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

// landingAnnotation は DB の状態だけで決まる — blocked_by の規則はここ(domain 層)で1度だけ述べる(ADR 0107)。
// サーバ境界のテストは「読み口が注釈を写す」ことだけを述べる。
function landingWork(db: Db, clock: FakeClock) {
  return registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship an agreed change",
      completion_criteria: "the change is ready",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
}

function mergeQuestion(
  db: Db,
  clock: FakeClock,
  pending: { pending_local_merge_task_id: string } | { pending_merge_pr: number },
  workspace?: string,
) {
  return registerTask(
    db,
    {
      type: "question",
      title: "land it",
      workspace,
      purpose: "a human decides whether to land",
      completion_criteria: "the answer is recorded",
      question: [{ title: "land it", options: ["merge", "hold"], recommendation: "merge" }],
      question_kind:
        "pending_merge_pr" in pending
          ? { kind: "pr_merge", pr: pending.pending_merge_pr }
          : { kind: "local_merge", task_id: pending.pending_local_merge_task_id },
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
}

function attachUnsettledChild(db: Db, clock: FakeClock, parentId: string) {
  return registerTask(
    db,
    {
      type: "work",
      title: "repair",
      purpose: "repair the landing task",
      completion_criteria: "the repair is ready",
      parent_id: parentId,
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
}

function raiseUnbundledObjection(db: Db, clock: FakeClock, taskId: string) {
  const entryId = appendEvent(db, {
    taskId,
    workerId: "worker",
    origin: "worker",
    payload: { kind: "decision_logged", line: "ship this implementation" },
    at: clock.now(),
  });
  raiseObjection(db, entryId, "the implementation still misses the edge case", clock.now());
}

it("着地 question でない question には landingAnnotation が null を返す", async () => {
  const { db, clock } = await openBoard();
  const question = registerTask(
    db,
    {
      type: "question",
      title: "which way?",
      purpose: "a human decides the direction",
      completion_criteria: "the answer is recorded",
      question: [{ title: "which way?", options: ["left", "right"], recommendation: "left" }],
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );

  expect(landingAnnotation(db, question)).toBeNull();
});

it("付帯子も異議も無い着地 question は blocked_by が null", async () => {
  const { db, clock } = await openBoard();
  const work = landingWork(db, clock);

  expect(
    landingAnnotation(db, mergeQuestion(db, clock, { pending_local_merge_task_id: work.id })),
  ).toEqual({ blocked_by: null });
});

it("未決着の付帯子を持つ着地 question は attached_children で塞がる", async () => {
  const { db, clock } = await openBoard();
  const work = landingWork(db, clock);
  attachUnsettledChild(db, clock, work.id);

  expect(
    landingAnnotation(db, mergeQuestion(db, clock, { pending_local_merge_task_id: work.id })),
  ).toEqual({ blocked_by: "attached_children" });
});

it("同じ triage で未束ねの異議を持つ着地 question は objections で塞がる", async () => {
  const { db, clock } = await openBoard();
  const work = landingWork(db, clock);
  raiseUnbundledObjection(db, clock, work.id);

  expect(
    landingAnnotation(db, mergeQuestion(db, clock, { pending_local_merge_task_id: work.id })),
  ).toEqual({ blocked_by: "objections" });
});

it("付帯子と異議が両方あれば attached_children を名乗り、回答経路の拒否理由と一致する", async () => {
  const { db, clock } = await openBoard();
  const work = landingWork(db, clock);
  attachUnsettledChild(db, clock, work.id);
  raiseUnbundledObjection(db, clock, work.id);
  const question = mergeQuestion(db, clock, { pending_local_merge_task_id: work.id });

  expect(landingAnnotation(db, question)).toEqual({ blocked_by: "attached_children" });
  await expect(
    submitAnswer(
      { db, pollNow: () => {}, landing: unusedLanding },
      question,
      ["merge"],
      undefined,
      () => clock.now(),
      "webui",
    ),
  ).rejects.toThrow("attached child task(s) unsettled");
});

it("PR の merge question は PR から引いた着地タスクの付帯子で塞がる", async () => {
  const { db, clock } = await openBoard();
  const work = landingWork(db, clock);
  recordPrOpenedViaWorker(db, work, 7, "worker", clock.now());
  const question = mergeQuestion(db, clock, { pending_merge_pr: 7 });
  expect(landingAnnotation(db, question)).toEqual({ blocked_by: null });

  attachUnsettledChild(db, clock, work.id);

  expect(landingAnnotation(db, question)).toEqual({ blocked_by: "attached_children" });
});

it("PR を開いた後の merge question も、CI red で止まった auto-merge の merge question も盤面の名義・経路で登録される(ADR 0194 決定3)", async () => {
  const workspace = await makeWorkspace("landing-merge-question-registrant");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptCiStatus("failure");
  recordPrOpenedViaWorker(db, landingWork(db, clock), 1, "worker", clock.now(), { authority: { merge: "escalate" } });
  recordPrOpenedViaWorker(db, landingWork(db, clock), 2, "worker", clock.now(), { authority: { merge: "auto_if_ci_green" } });

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => ({ name: "standard", guidance: "", merge: "auto_if_ci_green" }),
  }).tick("auto_merge", clock.now());

  const registered = listBoard(db)
    .filter((q) => q.question_pending_merge_pr !== null)
    .map((q) => {
      const { worker_id, origin } = listEvents(db, q.id).find((e) => e.kind === "task_registered")!;
      return [q.question_pending_merge_pr, worker_id, origin];
    });
  expect(registered).toEqual([
    [1, BOARD_WORKER_ID, "board"],
    [2, BOARD_WORKER_ID, "board"],
  ]);
});

// ADR 0217 決定1・2: 無人 merge キューの PR は merge の瞬間に着地の面を読み直す。
// 以下はこの読み直しを述べる唯一の場所(ADR 0107)。
const profile = (merge: MergeDial) => ({
  name: "standard",
  guidance: "",
  merge,
});

/** auto_if_ci_green で PR を開き、無人 merge キューへ入れる。 */
function queueAutoMerge(db: Db, clock: FakeClock, prNumber: number): Task {
  const work = landingWork(db, clock);
  recordPrOpenedViaWorker(db, work, prNumber, "worker", clock.now(), {
    authority: { merge: "auto_if_ci_green" },
  });
  return work;
}

function mergeQuestions(db: Db) {
  return listBoard(db)
    .filter((q) => q.question_pending_merge_pr !== null)
    .map((q) => {
      const { worker_id, origin } = listEvents(db, q.id).find((e) => e.kind === "task_registered")!;
      return {
        pr: q.question_pending_merge_pr,
        registrant: [worker_id, origin],
        recommendation: q.question_items?.[0]?.recommendation,
        purpose: q.purpose,
      };
    });
}

// 着地の面(question)の理由 3 つは、question 本文の違いだけで区別される。本文を逐語で釘付けする。
it("PR を開いた時点で question 面に倒れた理由は、保護・ダイヤル・risk のそれぞれの本文で merge question に残る", async () => {
  const { db, clock } = await openBoard();
  recordPrOpenedViaWorker(db, landingWork(db, clock), 1, "worker", clock.now(), {
    authority: { merge: "auto_if_ci_green" },
    isProtected: true,
  });
  recordPrOpenedViaWorker(db, landingWork(db, clock), 2, "worker", clock.now(), {
    authority: { merge: "escalate" },
  });
  const risky = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship an agreed change",
      completion_criteria: "the change is ready",
      risk_flag: true,
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  recordPrOpenedViaWorker(db, risky, 3, "worker", clock.now(), {
    authority: { merge: "auto_if_ci_green" },
  });

  expect(mergeQuestions(db).map(({ pr, purpose }) => ({ pr, purpose }))).toEqual([
    {
      pr: 1,
      purpose:
        '"ship" completed and opened PR #1 against a protected workspace — always needs a human ' +
        "merge, regardless of the merge dial. Merge it now?",
    },
    { pr: 2, purpose: '"ship" completed and opened PR #2. Merge it now?' },
    {
      pr: 3,
      purpose:
        '"ship" completed and opened PR #3, but carries risk — auto_if_ci_green never auto-merges ' +
        "a risky task. Merge it now?",
    },
  ]);
});

it("キュー投入の後に risk が付いた PR は、CI 緑でも merge されずキューを外れ、盤面の名義の merge question になる", async () => {
  const workspace = await makeWorkspace("landing-risk-after-queue");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  editTask(db, getTask(db, work.id)!, { risk_flag: true }, clock.now(), "webui");
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  });

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_WORKER_ID, "board"],
      recommendation: "merge",
      purpose:
        '"ship"\'s PR #1 was queued for auto_if_ci_green auto-merge, but its landing surface ' +
        "changed after it was queued: the task now carries risk, and auto_if_ci_green never " +
        "auto-merges a risky task. Merge it now?",
    },
  ]);
});

it("キュー投入の後にダイヤルが escalate へ取り下げられた PR は、CI 緑でも merge されずキューを外れ、盤面の名義の merge question になる", async () => {
  const workspace = await makeWorkspace("landing-withdrawn-to-escalate");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("escalate"),
  });

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_WORKER_ID, "board"],
      recommendation: "merge",
      purpose: expect.stringMatching(/queued.*landing surface changed.*escalate/),
    },
  ]);
});

it("キュー投入の後に workspace が保護された PR も、CI 緑でも merge されず盤面の名義の merge question になる", async () => {
  const workspace = await makeWorkspace("landing-protected-after-queue");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
    isProtectedWorkspace: (name) => name === workspace.name,
  });

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_WORKER_ID, "board"],
      recommendation: "merge",
      purpose: expect.stringMatching(/queued.*landing surface changed.*protected/),
    },
  ]);
});

it("キュー投入の後にダイヤルが external へ取り下げられた PR は、question なしでキューを外れ、外した事実が盤面の名義の event に残る", async () => {
  const workspace = await makeWorkspace("landing-withdrawn-to-external");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("external"),
  });

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "auto_merge_withdrawn")
      .map(({ worker_id, origin, payload }) => ({ worker_id, origin, payload })),
  ).toEqual([
    {
      worker_id: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "auto_merge_withdrawn", pr_number: 1, merge: "external" },
    },
  ]);
});

it("キュー投入の後に profile がダイヤルを持たなくなった PR も、question なしでキューを外れ、event の merge は null になる", async () => {
  const workspace = await makeWorkspace("landing-withdrawn-to-no-dial");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => undefined,
  }).tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "auto_merge_withdrawn")
      .map((e) => e.payload),
  ).toEqual([{ kind: "auto_merge_withdrawn", pr_number: 1, merge: null }]);
});

// ADR 0238 決定1・2: 面は PR の状態の後で読む。CI が pending でも、面が変われば同じ tick で外れる
// ADR 0238 決定2: 猶予内の未報告も pending と同じに扱う
it.each(["pending", "unreported"] as const)("CI が %s(猶予内)の間にダイヤルが escalate へ変わった PR は、その tick でキューを外れ、推奨 merge の面変化の question になる", async (ci) => {
  const workspace = await makeWorkspace(`landing-surface-${ci}-ci`);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptCiStatus(ci);
  queueAutoMerge(db, clock, 1);
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));

  await landing.tick("auto_merge", clock.now());

  expect(github.ciChecks).toHaveLength(1);
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    expect.objectContaining({ pr: 1, recommendation: "merge", purpose: expect.stringMatching(/landing surface changed.*escalate/) }),
  ]);
});

it("CI 赤の PR でダイヤルが escalate へ変わっていたら、推奨 merge の面変化の question でなく推奨 hold の CI 赤の question を立てる", async () => {
  const workspace = await makeWorkspace("landing-surface-red-ci");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptCiStatus("failure");
  queueAutoMerge(db, clock, 1);
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(mergeQuestions(db)).toEqual([
    { pr: 1, registrant: [BOARD_WORKER_ID, "board"], recommendation: "hold", purpose: CI_RED_PURPOSE },
  ]);
});

// ADR 0238 決定1: 閉じた PR は面の変化に依らず観測になる(ADR 0229 決定2・3)
it("盤面の外で閉じられた PR は、ダイヤルが escalate へ変わっていても question を立てず、閉じた観測としてキューを外れる", async () => {
  const workspace = await makeWorkspace("landing-surface-closed-escalate");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  github.scriptClosedOutside(1);
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));

  await landing.tick("auto_merge", clock.now());

  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
});

it("盤面の外で閉じられた PR は、ダイヤルが external へ変わっていても取り下げでなく閉じた観測としてキューを外れる", async () => {
  const workspace = await makeWorkspace("landing-surface-closed-external");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  github.scriptClosedOutside(1);
  const landing = autoMerging(db, clock, workspace, github, () => profile("external"));

  await landing.tick("auto_merge", clock.now());

  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
  expect(boardEvents(db, work.id, "auto_merge_withdrawn")).toEqual([]);
});

// ADR 0238 決定3: 状態が読めない tick では、面が変わっていてもキューに残す
it("状態が読めない PR は、ダイヤルが escalate へ変わっていても question を立てずキューに残る", async () => {
  const workspace = await makeWorkspace("landing-surface-unreadable");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  github.scriptUnreadable(1);
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));

  await landing.tick("auto_merge", clock.now());

  expect(await readOnNextTick(landing, github, clock.now())).toEqual([1]);
  expect(mergeQuestions(db)).toEqual([]);
});

it("着地の面は merge の直前にも読まれる — CI を読んでいる間にダイヤルが取り下げられたら merge しない", async () => {
  const workspace = await makeWorkspace("landing-surface-before-merge");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  let dial: MergeDial = "auto_if_ci_green";
  afterCiRead(github, () => {
    dial = "escalate";
  });

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile(dial),
  }).tick("auto_merge", clock.now());

  expect(github.ciChecks).toHaveLength(1);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});

// ADR 0217 決定1・2(#1644): CI 赤の question も盤面の名義の行為なので、立てる直前に merge の枝と
// 同じ順(profile → 門 → 着地の面、ADR 0232)で読み直す。CI を読んでいる間に変えるのは、既存の「merge の直前」と同じ形
const CI_RED_PURPOSE = '"ship"\'s auto_if_ci_green auto-merge found CI red on PR #1. Merge anyway, or hold?';

it("CI 赤を読んでいる間にダイヤルが external へ取り下げられた PR は、question なしでキューを外れ、外した事実が盤面の名義の event に残る", async () => {
  const workspace = await makeWorkspace("landing-red-ci-to-external");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  let dial: MergeDial = "auto_if_ci_green";
  github.scriptCiStatus("failure");
  afterCiRead(github, () => {
    dial = "external";
  });
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile(dial),
  });

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([]);
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "auto_merge_withdrawn")
      .map(({ worker_id, origin, payload }) => ({ worker_id, origin, payload })),
  ).toEqual([
    {
      worker_id: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "auto_merge_withdrawn", pr_number: 1, merge: "external" },
    },
  ]);
});

it("CI 赤を読んでいる間にダイヤルが escalate へ取り下げられた PR は、面変化の question ではなく推奨 hold の CI 赤の question を1件だけ立ててキューを外れる", async () => {
  const workspace = await makeWorkspace("landing-red-ci-to-escalate");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  let dial: MergeDial = "auto_if_ci_green";
  github.scriptCiStatus("failure");
  afterCiRead(github, () => {
    dial = "escalate";
  });
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile(dial),
  });

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([
    { pr: 1, registrant: [BOARD_WORKER_ID, "board"], recommendation: "hold", purpose: CI_RED_PURPOSE },
  ]);
});

it("CI 赤を読んでいる間に門が閉じた PR は、question なしでキューに残り、門が開いた後の tick で CI を読み直してから CI 赤の question を立てる", async () => {
  const workspace = await makeWorkspace("landing-red-ci-gate-closes");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  let child: Task | undefined;
  github.scriptCiStatus("failure");
  afterCiRead(github, () => {
    child ??= attachUnsettledChild(db, clock, work.id);
  });
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  });

  await landing.tick("auto_merge", clock.now());
  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");

  completeTask(db, child!, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge", clock.now());
  expect(github.ciChecks).toHaveLength(2);
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});

it("CI 赤の question の登録が throw したら、PR は無言でキューから消えず、次の tick で question が立つ(ADR 0105 決定3)", async () => {
  const workspace = await makeWorkspace("landing-red-ci-question-throws");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptCiStatus("failure");
  queueAutoMerge(db, clock, 1);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  });
  db.exec(
    `CREATE TEMP TRIGGER fail_question BEFORE INSERT ON tasks WHEN NEW.type = 'question'
     BEGIN SELECT RAISE(ABORT, 'question insert failed'); END`,
  );

  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  await landing.tick("auto_merge", clock.now());
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("auto-merge of PR #1 "), expect.any(Error));

  db.exec("DROP TRIGGER fail_question");
  await landing.tick("auto_merge", clock.now());
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});

// ADR 0229: merge できない PR は状態で分けてキューから外す。tick は reject せず、1件の失敗は後ろの PR を巻き込まない
// キューに残った行は次の tick で CI を読み直される —— 行の有無は行の直読みでなく振る舞いで見る(ADR 0107 決定2)
async function readOnNextTick(landing: Landing, github: FakeGitHubClient, now: Date): Promise<number[]> {
  const before = github.ciChecks.length;
  await landing.tick("auto_merge", now);
  return github.ciChecks.slice(before).map((ref) => ref.number);
}

function autoMerging(db: Db, clock: FakeClock, workspace: WorkspaceConfig, github: FakeGitHubClient, dial = () => profile("auto_if_ci_green")) {
  return createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: dial });
}

function boardEvents(db: Db, taskId: string, kind: string) {
  return listEvents(db, taskId)
    .filter((e) => e.kind === kind)
    .map(({ worker_id, origin, payload }) => ({ worker_id, origin, payload }));
}

const closeObserved = (pr_number: number) => [
  { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number } },
];

/** キューの行の行方を記録する event — 残っていなければ、PR はキューに残ったまま何も起きていない。 */
const autoMergeOutcomeEvents = (db: Db, taskId: string) =>
  ["pr_merged", "pr_merge_observed", "pr_close_observed", "auto_merge_withdrawn"].flatMap((kind) =>
    boardEvents(db, taskId, kind),
  );

const CONFLICT = "Pull request is not mergeable: the merge commit cannot be cleanly created.";

it("merge に失敗した開いたままの PR は、tick を落とさずキューを外れて失敗を本文に書いた推奨 hold の merge question になり、後ろの PR は同じ tick で merge される", async () => {
  const workspace = await makeWorkspace("landing-merge-fails-open");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  queueAutoMerge(db, clock, 2);
  github.scriptMergeFailure(1, new Error(CONFLICT));

  const landing = autoMerging(db, clock, workspace, github);
  await expect(landing.tick("auto_merge", clock.now())).resolves.toBeUndefined();

  // PR #1 は merge の失敗の後に同じ読み取りで読み直される(ADR 0231 決定1)
  expect(github.ciChecks.map((ref) => ref.number)).toEqual([1, 1, 2]);
  expect(github.merged).toEqual([{ path: workspace.path, number: 2 }]);
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_WORKER_ID, "board"],
      recommendation: "hold",
      purpose: `"ship"'s auto_if_ci_green auto-merge could not merge PR #1: ${CONFLICT}. Merge once it is fixed, or hold?`,
    },
  ]);
});

it.each(["success", "failure", "unreported", "pending"] as const)("盤面の外で閉じられた PR は CI が %s でも merge も question もせず、閉じた観測を盤面の名義で残してキューを外れる", async (ci) => {
  const workspace = await makeWorkspace(`landing-closed-${ci}`);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  github.scriptCiStatus(ci);
  github.scriptClosedOutside(1);
  const landing = autoMerging(db, clock, workspace, github);

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.ciChecks).toHaveLength(1);
  expect(github.stateChecks).toEqual([]);
  expect(github.merged).toEqual([]);
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([]);
});

it.each(["failure", "pending"] as const)("盤面の外で merge 済みの PR は CI が %s でも、行為の前の読み取りで merge の観測としてキューを外れる(ADR 0229 決定2)", async (ci) => {
  const workspace = await makeWorkspace(`landing-merged-before-${ci}`);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  github.scriptCiStatus(ci);
  github.scriptMergedOutside(1);

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge", clock.now());

  expect(github.stateChecks).toEqual([]);
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_merge_observed", pr_number: 1 } },
  ]);
});

it("CI を読んだ後に閉じられて merge が失敗した PR は、読み直した状態で閉じた観測になり question を立てない", async () => {
  const workspace = await makeWorkspace("landing-closed-during-merge");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  afterCiRead(github, () => github.scriptClosedOutside(1));

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge", clock.now());

  // CI の読みと、merge の失敗の後の読み直し(ADR 0231 決定1)
  expect(github.ciChecks).toHaveLength(2);
  expect(github.stateChecks).toEqual([]);
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
});

it("CI を読んだ後に盤面の外で merge されて merge が失敗した PR は、merge の観測としてキューを外れる(ADR 0079 決定3)", async () => {
  const workspace = await makeWorkspace("landing-merged-during-merge");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  afterCiRead(github, () => github.scriptMergedOutside(1));

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge", clock.now());

  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_merge_observed", pr_number: 1 } },
  ]);
  expect(boardEvents(db, work.id, "pr_merged")).toEqual([]);
});

it("merge が失敗し状態の読み直しも失敗した PR は、tick を落とさず question も event も残さずキューに残る", async () => {
  const workspace = await makeWorkspace("landing-merge-and-reread-fail");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  github.scriptMergeFailure(1, new Error(CONFLICT));
  afterCiRead(github, () => github.scriptUnreadable(1));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  const landing = autoMerging(db, clock, workspace, github);
  await expect(landing.tick("auto_merge", clock.now())).resolves.toBeUndefined();

  expect(logged).toHaveBeenCalledWith(expect.stringContaining("auto-merge of PR #1 "), expect.any(Error));
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([1]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(autoMergeOutcomeEvents(db, work.id)).toEqual([]);
});

// ADR 0231 決定1: 失敗の文面では見分けない — head が同じなら、文面が head の不一致に見えても「開いたまま失敗」
it("head が CI を読んだときのまま merge が失敗した PR は、失敗の文面に依らず推奨 hold の merge question になる", async () => {
  const workspace = await makeWorkspace("landing-same-head-fails");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  const headLikeFailure = "Head branch was modified. Review and try the merge again.";
  github.scriptMergeFailure(1, new Error(headLikeFailure));

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge", clock.now());

  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db).map((q) => [q.pr, q.recommendation])).toEqual([[1, "hold"]]);
});

// ADR 0231 決定1: head が動いたことは次の tick で新しい head の CI を読む理由であって、人間に問うことではない
it("CI を読んだ後に head が動いた PR は merge されず、question も event も残さずキューに残り、次の tick で新しい head の CI が緑なら新しい head で merge される", async () => {
  const workspace = await makeWorkspace("landing-head-moved");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  github.scriptHead(1, "ci-read-head");
  afterCiRead(github, () => github.scriptHead(1, "pushed-after-ci-read"));

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(autoMergeOutcomeEvents(db, work.id)).toEqual([]);

  expect(await readOnNextTick(landing, github, clock.now())).toEqual([1]);
  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
  expect(github.mergedHeads).toEqual(["pushed-after-ci-read"]);
});

it("分類できない例外が1件の PR で起きても、tick は落ちずその PR はキューに残り、後ろの PR は処理される", async () => {
  const workspace = await makeWorkspace("landing-unclassified-throw");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  queueAutoMerge(db, clock, 2);
  const readPullRequest = github.readPullRequest.bind(github);
  github.readPullRequest = async (ref) => {
    if (ref.number === 1) throw new Error("unexpected");
    return readPullRequest(ref);
  };
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  const landing = autoMerging(db, clock, workspace, github);
  await expect(landing.tick("auto_merge", clock.now())).resolves.toBeUndefined();

  expect(logged).toHaveBeenCalledWith(expect.stringContaining("auto-merge of PR #1 "), expect.any(Error));
  expect(github.merged).toEqual([{ path: workspace.path, number: 2 }]);
  github.readPullRequest = readPullRequest;
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([1]);
});

it("merge に失敗した開いたままの PR も、question を立てる直前に着地の面を読み直し、external へ取り下げられていれば question なしで外れる", async () => {
  const workspace = await makeWorkspace("landing-merge-fails-to-external");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  let dial: MergeDial = "auto_if_ci_green";
  github.mergePullRequest = async () => {
    dial = "external";
    throw new Error(CONFLICT);
  };

  const landing = autoMerging(db, clock, workspace, github, () => profile(dial));
  await landing.tick("auto_merge", clock.now());

  expect(await readOnNextTick(landing, github, clock.now())).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "auto_merge_withdrawn")).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "auto_merge_withdrawn", pr_number: 1, merge: "external" } },
  ]);
});

/** escalate の PR `prNumber` を開いた根(workspace は `workspace`)と、PR を開いたときに立った merge question。 */
function escalatedRoot(db: Db, clock: FakeClock, prNumber: number, workspace?: string) {
  const root = registerTask(
    db,
    { type: "work", title: "ship", purpose: "ship an agreed change", completion_criteria: "the change is ready", workspace },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  recordPrOpenedViaWorker(db, root, prNumber, "worker", clock.now(), { authority: { merge: "escalate" } });
  const question = listBoard(db).find((q) => q.question_pending_merge_pr === prNumber && q.workspace === root.workspace)!;
  return { root, question };
}

// ADR 0265 決定1: 観測で閉じた question は回答なしの done、PR の決着は PR を開いた根に残る
it.each([
  ["閉じられた", "pr_close_observed"],
  ["merge された", "pr_merge_observed"],
] as const)("遅い走査は、盤面の外で%s PR の open な merge question を回答なしで閉じ、%s を根に刻む(ADR 0229 決定4)", async (_, kind) => {
  const workspace = await makeWorkspace("landing-scan-settled");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const { root, question } = escalatedRoot(db, clock, 1);
  if (kind === "pr_close_observed") github.scriptClosedOutside(1);
  else github.scriptMergedOutside(1);

  await autoMerging(db, clock, workspace, github).tick("outside_merge", clock.now());

  expect(getTask(db, question.id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, question.id).map((e) => e.kind)).not.toContain("question_answered");
  expect(boardEvents(db, question.id, kind)).toEqual([]);
  expect(boardEvents(db, root.id, kind)).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind, pr_number: 1 } },
  ]);
});

it("別の workspace の同じ番号の PR の観測は、それぞれの workspace の根に1件ずつ刻まれ混ざらない", async () => {
  const workspace = await makeWorkspace("landing-scan-same-number");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const here = escalatedRoot(db, clock, 1, "here");
  const there = escalatedRoot(db, clock, 1, "there");
  github.scriptClosedOutside(1);
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: () => workspace, github });

  await landing.tick("outside_merge", clock.now());

  expect(boardEvents(db, here.root.id, "pr_close_observed")).toEqual(closeObserved(1));
  expect(boardEvents(db, there.root.id, "pr_close_observed")).toEqual(closeObserved(1));
});

// #2026: 外で閉じた escalate の根の閉じた記録が question の側にあり、収束が読めずに撃ち続けていた
it("遅い走査が外で閉じたと観測した escalate の根は、次の収束で候補から外れ、git も読まれず verdict にも出ない", async () => {
  const { workspace, db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-closed-root");
  expect(listBoard(db).filter((q) => q.question_pending_merge_pr === 1)).toHaveLength(1);
  github.scriptClosedOutside(1);
  const pushes = github.pushes.length;

  await landing.tick("outside_merge", clock.now());
  // 読めば壊れていると分かる checkout でも、閉じた根は読まれない
  git(workspace.path, "checkout", "main");
  git(workspace.path, "branch", "-D", `task/${root.id}`);

  await expect(landing.converge()).resolves.toEqual([]);
  await expect(landing.converge()).resolves.toEqual([]);
  expect(promotionFailures(db, root.id)).toEqual([]);
  expect(github.pushes).toHaveLength(pushes);
});

/** escalate のダイヤルで PR #1 を開き、merge question が開いている根。 */
async function escalatedRootWithOpenedPr(name: string) {
  const { workspace } = await makeRemoteBackedWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));
  const root = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${root.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, root);
  await landing.converge();
  return { workspace, db, clock, github, landing, root: getTask(db, root.id)! };
}

// 観測の重複除け: 根の決着は経路の順によらず1件だけ刻まれ、question は回答なしの done で閉じる
it("収束が先に閉じた PR を観測した根の merge question は、遅い走査が回答なしで閉じ、根に閉じた観測を重ねない", async () => {
  const { workspace, db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-converge-then-scan");
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptClosedOutside(1);
  const question = listBoard(db).find((q) => q.question_pending_merge_pr === 1)!;

  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ reason: "pull_request_closed" });
  expect(getTask(db, question.id)!.status).toBe("todo");
  await landing.tick("outside_merge", clock.now());

  expect(getTask(db, question.id)).toMatchObject({ status: "done", question_answer: null });
  expect(boardEvents(db, root.id, "pr_close_observed")).toEqual(closeObserved(1));
});

it("収束が PR の状態を読んでいる間に遅い走査が閉じた観測を刻めば、収束は観測を重ねない", async () => {
  const { workspace, db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-during-converge");
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptClosedOutside(1);
  const gate = awaitWindow();
  const read = github.getPullRequestState.bind(github);
  github.getPullRequestState = async (ref) => {
    const state = await read(ref);
    await gate.hold();
    return state;
  };

  const converging = convergeOn(landing, root.id);
  await gate.entered;
  await landing.tick("outside_merge", clock.now());
  gate.open();

  await expect(converging).resolves.toMatchObject({ reason: "pull_request_closed" });
  expect(boardEvents(db, root.id, "pr_close_observed")).toEqual(closeObserved(1));
});

it("遅い走査が外で閉じたと観測した根への retry は、閉じたことを理由に verdict で拒まれる", async () => {
  const { db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-closed-retry");
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  const [failure] = promotionFailures(db, root.id);
  github.scriptClosedOutside(1);

  await landing.tick("outside_merge", clock.now());

  await expect(convergeOn(landing, root.id, failure!.id)).resolves.toEqual({
    kind: "excluded",
    reason: "pull_request_closed",
    error: `PR #1 was closed outside the board, so task/${root.id} is not pushed to it`,
  });
});

it("遅い走査が外で merge されたと観測した根は、収束が GitHub を読まず観測を重ねずに着地が終わったと刻む", async () => {
  const { workspace, db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-merged-finish");
  await mergeOnGitHub(workspace, root.id);
  github.scriptMergedOutside(1);
  await landing.tick("outside_merge", clock.now());
  const stateChecks = github.stateChecks.length;

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "nothing_to_land", base: "refs/remotes/origin/main" });
  expect(github.stateChecks).toHaveLength(stateChecks);
  expect(boardEvents(db, root.id, "pr_merge_observed")).toHaveLength(1);
  expect(boardEvents(db, root.id, "landing_finished")).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "landing_finished", pr_number: 1 } },
  ]);
});

it("遅い走査は、workspace の解決が分類できない失敗で落ちた question を open のまま残し、tick は落ちず後ろの question は決着する(ADR 0229 決定1)", async () => {
  const workspace = await makeWorkspace("landing-scan-resolve-throws");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const broken = escalatedRoot(db, clock, 1, "broken").question;
  const { root: closedRoot, question: closed } = escalatedRoot(db, clock, 2, "healthy");
  github.scriptClosedOutside(2);
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    resolveWorkspace: (name) => {
      if (name === "broken") throw new Error("registry unreadable");
      return workspace;
    },
    github,
  });

  await expect(landing.tick("outside_merge", clock.now())).resolves.toBeUndefined();

  expect(getTask(db, broken.id)!.status).toBe("todo");
  expect(getTask(db, closed.id)!.status).toBe("done");
  expect(boardEvents(db, closedRoot.id, "pr_close_observed")).toEqual(closeObserved(2));
  expect(logged).toHaveBeenCalledWith(expect.stringContaining(`PR #1 (question ${broken.id})`), expect.any(Error));
});

it("遅い走査で UnknownWorkspaceError を投げる workspace は quarantine に落ち、tick は落ちない", async () => {
  const workspace = await makeWorkspace("landing-scan-unknown-workspace");
  const { db, clock } = await openBoard();
  const { question } = escalatedRoot(db, clock, 1, "gone");
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    resolveWorkspace: (name) => {
      if (name === "gone") throw new UnknownWorkspaceError("gone");
      return workspace;
    },
    github: new FakeGitHubClient(),
  });

  await expect(landing.tick("outside_merge", clock.now())).resolves.toBeUndefined();

  expect(quarantineQuestion(db, "workspace", "gone")).toBeDefined();
  expect(getTask(db, question.id)!.status).toBe("todo");
});

// ADR 0227 決定2・3: check が1つも報告されていない PR は、盤面がその head を知ってから5分の猶予の間だけ待つ
const FIVE_MINUTES = 5 * 60_000;

it("check 未報告の PR は、盤面がその head を知ってから5分の猶予の内なら merge も question もせずキューに残る", async () => {
  const workspace = await makeWorkspace("landing-unreported-within-grace");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptCiStatus("unreported");
  queueAutoMerge(db, clock, 1);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  });

  await clock.advance(FIVE_MINUTES - 1);
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);

  // キューに残っている —— check が緑で報告されれば次の tick で merge される
  github.scriptCiStatus("success");
  await landing.tick("auto_merge", clock.now());
  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

const UNREPORTED_PURPOSE =
  "\"ship\"'s auto_if_ci_green auto-merge found no CI check reported on PR #1 in the 5 minutes since " +
  "the board first saw its current head, so its CI-green condition cannot be observed. Merge anyway, or hold?";

it("猶予の5分を過ぎても check 未報告の PR は、キューを外れて推奨 hold の merge question を盤面の名義で1件だけ立てる", async () => {
  const workspace = await makeWorkspace("landing-unreported-past-grace");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptCiStatus("unreported");
  queueAutoMerge(db, clock, 1);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  });

  await clock.advance(FIVE_MINUTES);
  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([
    { pr: 1, registrant: [BOARD_WORKER_ID, "board"], recommendation: "hold", purpose: UNREPORTED_PURPOSE },
  ]);
});

it("開いている PR への修理の push は盤面の名義の event に残り、check 未報告の猶予をその push から数え直す", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-unreported-repair-push");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  await landing.converge();
  await clock.advance(4 * 60_000);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  await landing.converge();
  github.scriptCiStatus("unreported");

  // PR を開いてから6分、修理の push からは2分
  await clock.advance(2 * 60_000);
  await landing.tick("auto_merge", clock.now());
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_branch_pushed")).toEqual([
    {
      worker_id: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "pr_branch_pushed", pr_number: 1, sha: git(workspace.path, "rev-parse", `task/${work.id}`) },
    },
  ]);

  await clock.advance(3 * 60_000);
  await landing.tick("auto_merge", clock.now());
  expect(mergeQuestions(db).map(({ pr, purpose }) => ({ pr, purpose }))).toEqual([
    { pr: 1, purpose: UNREPORTED_PURPOSE },
  ]);
  // 盤面自身の push は記録にある head なので、観測としては刻まない
  expect(boardEvents(db, work.id, "pr_head_observed")).toEqual([]);
});

// ADR 0231 決定4: 盤面の外で push された head の猶予は、盤面がその head を初めて読んだ時点から数える
/** 盤面を通さず、別の clone からタスクブランチへ commit を push する —— `onto` を渡せば、その commit の上に作って
 *  force-push する。PR の head はその sha になり、盤面の checkout の写しは動かない。 */
async function pushOutsideBoard(workspace: WorkspaceConfig, taskId: string, onto?: string): Promise<string> {
  const clone = await tempDir("tidepool-outside-push-");
  git(clone, "clone", "--branch", `task/${taskId}`, git(workspace.path, "remote", "get-url", "origin"), ".");
  if (onto) git(clone, "reset", "--hard", onto);
  commitWork(clone, "outside.txt", "pushed on GitHub\n");
  git(clone, "push", "--force", "origin", `task/${taskId}`);
  return git(clone, "rev-parse", "HEAD");
}

it("PR を開いてから6分後に読んだ盤面の外の head が check 未報告なら、初めて読んでから5分間キューで待ち、過ぎれば merge question に倒れる。観測は1件だけ刻まれる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-unreported-outside-head");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github);
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  await landing.converge();
  const outside = await pushOutsideBoard(workspace, work.id);
  github.scriptCiStatus("unreported");

  await clock.advance(6 * 60_000);
  await landing.tick("auto_merge", clock.now());
  await clock.advance(FIVE_MINUTES - 1);
  await landing.tick("auto_merge", clock.now());

  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_head_observed")).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_head_observed", pr_number: 1, sha: outside } },
  ]);

  await clock.advance(1);
  await landing.tick("auto_merge", clock.now());
  expect(mergeQuestions(db).map(({ pr, purpose }) => ({ pr, purpose }))).toEqual([{ pr: 1, purpose: UNREPORTED_PURPOSE }]);
  expect(boardEvents(db, work.id, "pr_head_observed")).toHaveLength(1);
});

it("check が報告中(pending)の盤面の外の head も、読んだ時点で観測として1件だけ刻まれる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-pending-outside-head");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github);
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  await landing.converge();
  const outside = await pushOutsideBoard(workspace, work.id);
  github.scriptCiStatus("pending");

  await landing.tick("auto_merge", clock.now());
  await clock.advance(60_000);
  await landing.tick("auto_merge", clock.now());

  expect(boardEvents(db, work.id, "pr_head_observed")).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_head_observed", pr_number: 1, sha: outside } },
  ]);
});

it("PR を開いたときの event は、作成前に push したタスクブランチの sha を持つ", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-pr-opened-sha");
  const { db, clock } = await openBoard();
  const landing = autoMerging(db, clock, workspace, new FakeGitHubClient());
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);

  await landing.converge();

  expect(listEvents(db, work.id).find((e) => e.kind === "pr_opened")?.payload).toEqual({
    kind: "pr_opened",
    pr_number: 1,
    sha: git(workspace.path, "rev-parse", `task/${work.id}`),
  });
});

it("猶予を過ぎた check 未報告を読んでいる間にダイヤルが external へ取り下げられた PR は、question なしでキューを外れ、外した事実が残る", async () => {
  const workspace = await makeWorkspace("landing-unreported-to-external");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  let dial: MergeDial = "auto_if_ci_green";
  github.scriptCiStatus("unreported");
  afterCiRead(github, () => {
    dial = "external";
  });
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile(dial),
  });

  await clock.advance(FIVE_MINUTES);
  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([]);
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "auto_merge_withdrawn")
      .map((e) => e.payload),
  ).toEqual([{ kind: "auto_merge_withdrawn", pr_number: 1, merge: "external" }]);
});

it("門に当たった PR は面が変わっていなければキューに残り、門が開いた後の tick で merge される", async () => {
  const workspace = await makeWorkspace("landing-gate-keeps-queued");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  const child = attachUnsettledChild(db, clock, work.id);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  });

  await landing.tick("auto_merge", clock.now());
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");

  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge", clock.now());
  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

// ADR 0232: 読み直しは profile → 門 → 面の順。門が閉じている間は面が変わっても PR はキューで待ち、
// 門が開いた後の tick で CI と面を読み直す(ADR 0238)
it("門が閉じている間にダイヤルが escalate へ変わった PR は、CI を読まれず question もなくキューに残り、門が開いた後の tick で面の変化の question になる", async () => {
  const workspace = await makeWorkspace("landing-gate-before-surface");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  const child = attachUnsettledChild(db, clock, work.id);
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));

  await landing.tick("auto_merge", clock.now());
  expect(github.ciChecks).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");

  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge", clock.now());
  // 外れた後の tick で何も重ならない
  await landing.tick("auto_merge", clock.now());
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    expect.objectContaining({ pr: 1, recommendation: "merge", purpose: expect.stringMatching(/landing surface changed.*escalate/) }),
  ]);
});

// CI を読んでいる間に門が閉じ、ダイヤルも escalate へ変わる(#1720 の再現)。門が開いた後の tick は CI を読み直してから
// 面の変化に当たるので、CI 赤なら推奨 hold の CI 赤の question、緑なら推奨 merge の面変化の question になる(ADR 0238 決定1)
it.each([
  ["failure", { recommendation: "hold", purpose: CI_RED_PURPOSE }],
  ["success", { recommendation: "merge", purpose: expect.stringMatching(/landing surface changed.*escalate/) }],
] as const)("CI %s を読んでいる間に門が閉じダイヤルが escalate へ変わった PR は、merge も question もなくキューに残り、門が開いた後の tick で CI を読み直して question になる", async (ci, question) => {
  const workspace = await makeWorkspace(`landing-gate-before-surface-${ci}`);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  let dial: MergeDial = "auto_if_ci_green";
  let child: Task | undefined;
  github.scriptCiStatus(ci);
  afterCiRead(github, () => {
    dial = "escalate";
    child ??= attachUnsettledChild(db, clock, work.id);
  });
  const landing = autoMerging(db, clock, workspace, github, () => profile(dial));

  await landing.tick("auto_merge", clock.now());
  expect(github.ciChecks).toHaveLength(1);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");

  completeTask(db, child!, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge", clock.now());
  // 外れた後の tick で何も重ならない
  await landing.tick("auto_merge", clock.now());
  expect(github.ciChecks).toHaveLength(2);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([expect.objectContaining({ pr: 1, ...question })]);
});

it("門が閉じている間にダイヤルが external へ変わった PR は、取り下げの event を刻まずキューに残り、門が開いた後の tick で event を1回だけ刻んで外れる", async () => {
  const workspace = await makeWorkspace("landing-gate-before-external");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  const child = attachUnsettledChild(db, clock, work.id);
  const landing = autoMerging(db, clock, workspace, github, () => profile("external"));

  await landing.tick("auto_merge", clock.now());
  expect(boardEvents(db, work.id, "auto_merge_withdrawn")).toEqual([]);

  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge", clock.now());
  // 外れた後の tick で何も重ならない
  await landing.tick("auto_merge", clock.now());
  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "auto_merge_withdrawn").map((e) => e.payload)).toEqual([
    { kind: "auto_merge_withdrawn", pr_number: 1, merge: "external" },
  ]);
});

// ADR 0231 決定2・3 / ADR 0239: 積み残しは回答時と merge 時に読み、門にも着地の登録にも混ぜない。
// 以下がこの検査を述べる唯一の場所(ADR 0107)。
/** タスクブランチを push して PR #1 を開く。auto_if_ci_green なら無人 merge キューに入り、
 *  escalate なら merge question が立つ。checkout はタスクブランチに残る。 */
async function openPushedPr(name: string, merge: MergeDial) {
  const { workspace } = await makeRemoteBackedWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "push", "-u", "origin", `task/${work.id}`);
  github.scriptPullRequestOnBranch(`task/${work.id}`);
  recordPrOpened(db, work, 1, git(workspace.path, "rev-parse", "HEAD"), "worker", clock.now(), { merge }, undefined, "worker");
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile(merge),
  });
  return { workspace, db, clock, github, work: getTask(db, work.id)!, landing };
}

/** 修理(`parentId` の付帯子)を着地するタスクのブランチから fork し、`repair.txt` を commit して done にする。
 *  merge back はしない。門は開いている。checkout は着地するタスクのブランチに戻す。 */
function settleRepairNotMergedBack(
  db: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  landingTaskId: string,
  parentId = landingTaskId,
) {
  const repair = attachUnsettledChild(db, clock, parentId);
  git(workspace.path, "checkout", "-b", `task/${repair.id}`, `task/${landingTaskId}`);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  git(workspace.path, "checkout", `task/${landingTaskId}`);
  completeTask(db, repair, FULL_HANDOFF, "worker", clock.now(), "worker");
  return getTask(db, repair.id)!;
}

/** #1777 の形: 修理の merge back が後始末で conflict し、workspace が quarantine に落ちる。checkout は着地するタスクの
 *  ブランチの上で merge の途中のまま残る。 */
async function quarantinedByMergeBackConflict(name: string, merge: MergeDial) {
  const pr = await openPushedPr(name, merge);
  const { workspace, db, clock, work } = pr;
  const repair = attachUnsettledChild(db, clock, work.id);
  git(workspace.path, "checkout", "-b", `task/${repair.id}`, `task/${work.id}`);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  git(workspace.path, "checkout", `task/${work.id}`);
  commitWork(workspace.path, "repair.txt", "conflicting\n");
  git(workspace.path, "push", "origin", `task/${work.id}`);
  await prepareWorkspaceAtPickup(db, workspace, repair, { now: new Date(0) });
  completeTask(db, repair, FULL_HANDOFF, "worker", clock.now(), "worker");
  releaseWorkspace(db, workspace, getTask(db, repair.id)!, clock.now(), true);
  const question = quarantineQuestion(db, "workspace", workspace.name)!;
  return { ...pr, repair: getTask(db, repair.id)!, question };
}

it("merge back が conflict して後始末が閉じても、修理の内容が merge される head に無ければ積み残しで、CI 緑でも無人 merge されない", async () => {
  const { clock, github, repair, question, landing } = await quarantinedByMergeBackConflict(
    "left-behind-merge-back-conflict",
    "auto_if_ci_green",
  );
  expect(question.purpose).toContain(`git merge task/${repair.id}`);

  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
});

// ADR 0240 決定4: workspace の quarantine の受理の検査は、内容が帰り先に届いていない done の work の merge back を
// やり直す。以下がこの検査を述べる唯一の場所(ADR 0107)。
function answerWorkspaceQuarantine(
  { db, clock, workspace, landing }: { db: Db; clock: FakeClock; workspace: WorkspaceConfig; landing: Landing },
  question: Task,
  pollNow: () => void = () => {},
) {
  return submitAnswer(
    { db, pollNow, landing, quarantineChecks: quarantineChecks({ db, workspace }) },
    getTask(db, question.id)!,
    ["repaired by hand"],
    undefined,
    () => clock.now(),
    "webui",
  );
}

const head = (workspace: WorkspaceConfig) => git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD");
/** origin のタスクブランチの先端 —— GitHub が報告する PR の head。 */
const originHead = (workspace: WorkspaceConfig, taskId: string) =>
  git(workspace.path, "ls-remote", "origin", `refs/heads/task/${taskId}`).split("\t")[0]!;

it("merge back の conflict を abort しただけの受理は、merge back をやり直して conflict し、取り消して休止位置へ戻し、2つの出口を示して拒む", async () => {
  const pr = await quarantinedByMergeBackConflict("redo-merge-back-conflict", "escalate");
  const { workspace, db, work, repair, question } = pr;
  git(workspace.path, "merge", "--abort");

  await expect(answerWorkspaceQuarantine(pr, question)).rejects.toThrow(
    new DomainError(
      `task/${repair.id} does not merge cleanly into 'task/${work.id}' — either merge it there by hand in workspace ` +
        `${workspace.name} and commit, or, to discard it, record it there with \`git merge -s ours task/${repair.id}\`; ` +
        "then answer again",
    ),
  );

  expect(head(workspace)).toBe("main");
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect(await contentLeftBehind(db, workspace, work.id, originHead(workspace, work.id))).toEqual([repair.id]);
  expect(getTask(db, question.id)!.status).toBe("todo");
});

it("merge back が走らなかった修理は、受理の検査が帰り先へ merge して休止位置へ戻し、受理する", async () => {
  const pr = await openPushedPr("redo-merge-back-clean", "escalate");
  const { workspace, db, clock, work } = pr;
  const repair = settleRepairNotMergedBack(db, clock, workspace, work.id);
  quarantineWorkspace(db, workspace.name, new Error("GitHub token acquisition failed"), clock.now());
  const question = quarantineQuestion(db, "workspace", workspace.name)!;
  const pollNow = vi.fn();

  await answerWorkspaceQuarantine(pr, question, pollNow);

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(pollNow).toHaveBeenCalledOnce();
  expect(head(workspace)).toBe("main");
  expect(git(workspace.path, "merge-base", "--is-ancestor", `task/${repair.id}`, `task/${work.id}`)).toBe("");
});

// ADR 0243 決定4: 受理の merge back は走っている session が無いときだけ checkout を動かす書き込みなので、基準に触らない ——
// 次の pickup の全撮りが作り直す
it("受理の検査がやり直した merge back は、盤面の基準を書き換えない", async () => {
  const pr = await openPushedPr("redo-merge-back-baseline", "escalate");
  const { workspace, db, clock, work } = pr;
  const earlier = landingWork(db, clock);
  await prepareWorkspaceAtPickup(db, workspace, earlier, { now: new Date(0) });
  const pickedUp = git(workspace.path, "rev-parse", `task/${work.id}`);
  commitWork(workspace.path, "earlier.txt", "work\n");
  releaseWorkspace(db, workspace, earlier, clock.now());
  git(workspace.path, "checkout", `task/${work.id}`);
  const repair = settleRepairNotMergedBack(db, clock, workspace, work.id);
  quarantineWorkspace(db, workspace.name, new Error("GitHub token acquisition failed"), clock.now());

  await answerWorkspaceQuarantine(pr, quarantineQuestion(db, "workspace", workspace.name)!);

  expect(git(workspace.path, "merge-base", "--is-ancestor", `task/${repair.id}`, `task/${work.id}`)).toBe("");
  // 基準は earlier の pickup のまま —— その基準で解放をやり直すと、merge back が動かしたタスクブランチを pickup の値から
  // 動いたと名指しする(merge back が基準を書き換えていれば名指ししない)
  git(workspace.path, "checkout", `task/${earlier.id}`);
  releaseWorkspace(db, workspace, earlier, clock.now());
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(`was: ${pickedUp} refs/heads/task/${work.id}`);
});

it.each<[string, (workspace: WorkspaceConfig, repairId: string) => void]>([
  [
    "手で merge を解いた",
    (workspace, repairId) => {
      expect(() => git(workspace.path, "merge", `task/${repairId}`)).toThrow();
      commitWork(workspace.path, "repair.txt", "fixed and conflicting\n");
    },
  ],
  [
    "`merge -s ours` で修理を捨てると記録した",
    (workspace, repairId) => {
      git(workspace.path, "merge", "-s", "ours", "--no-edit", `task/${repairId}`);
    },
  ],
])("merge back の conflict を%s後の受理は通り、収束を突き、続く収束が根へ push して積み残しが消える", async (_, repairByHand) => {
  const pr = await quarantinedByMergeBackConflict("redo-merge-back-repaired", "escalate");
  const { workspace, db, clock, work, repair, question, landing } = pr;
  git(workspace.path, "merge", "--abort");
  repairByHand(workspace, repair.id);
  const pollNow = vi.fn();

  await answerWorkspaceQuarantine(pr, question, pollNow);

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(pollNow).toHaveBeenCalledOnce();
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  expect(await contentLeftBehind(db, workspace, work.id, originHead(workspace, work.id))).toEqual([]);
});

it("その workspace で session が走っている間は、checkout を動かさずに受理を拒む", async () => {
  const pr = await quarantinedByMergeBackConflict("redo-merge-back-running", "escalate");
  const { workspace, db, clock, work, question } = pr;
  git(workspace.path, "merge", "--abort");
  pickupTask(db, landingWork(db, clock), "worker", clock.now());

  await expect(answerWorkspaceQuarantine(pr, question)).rejects.toThrow(
    new DomainError(`a session or its teardown is still running in workspace ${workspace.name} — answer again once it has finished`),
  );

  expect(head(workspace)).toBe(`task/${work.id}`);
  expect(getTask(db, question.id)!.status).toBe("todo");
});

it("merge が始まる前に落ちても、取り消す merge の無いまま git の理由で拒み、checkout は休止位置に戻っている", async () => {
  const pr = await openPushedPr("redo-merge-back-refused-to-start", "escalate");
  const { workspace, db, clock, work } = pr;
  const repair = attachUnsettledChild(db, clock, work.id);
  git(workspace.path, "checkout", "-b", `task/${repair.id}`, `task/${work.id}`);
  commitWork(workspace.path, "README.md", "repaired\n");
  git(workspace.path, "checkout", `task/${work.id}`);
  completeTask(db, repair, FULL_HANDOFF, "worker", clock.now(), "worker");
  // status に出ないローカルの変更が merge を始まる前に止める
  git(workspace.path, "update-index", "--skip-worktree", "README.md");
  writeFileSync(join(workspace.path, "README.md"), "local\n");
  quarantineWorkspace(db, workspace.name, new Error("GitHub token acquisition failed"), clock.now());

  await expect(answerWorkspaceQuarantine(pr, quarantineQuestion(db, "workspace", workspace.name)!)).rejects.toThrow(
    /would be overwritten by merge/,
  );

  expect(head(workspace)).toBe("main");
});

it("purely-local な workspace で、やり直しの前に帯域外に動いた保護ブランチは、やり直しの後も着地で帯域外と読まれる", async () => {
  const workspace = await makeWorkspace("redo-merge-back-local");
  const { db, clock } = await openBoard();
  const work = landingWork(db, clock);
  await prepareWorkspaceAtPickup(db, workspace, work, { now: new Date(0) });
  commitWork(workspace.path, "feature.txt", "ready\n");
  settleRepairNotMergedBack(db, clock, workspace, work.id);
  git(workspace.path, "update-ref", "refs/heads/main", git(workspace.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "out of band"));
  quarantineWorkspace(db, workspace.name, new Error("GitHub token acquisition failed"), clock.now());

  await answerWorkspaceQuarantine({ db, clock, workspace, landing: unusedLanding }, quarantineQuestion(db, "workspace", workspace.name)!);

  expect(head(workspace)).toBe("main");
  expect(() => mergeTaskToProtected(db, workspace, work.id)).toThrow(OutOfBandProtectedBranchError);
});

it("内容が帰り先に届いていない done の work が無ければ、受理の検査は checkout を動かさない", async () => {
  const pr = await openPushedPr("redo-merge-back-nothing", "escalate");
  const { workspace, db, clock, work } = pr;
  quarantineWorkspace(db, workspace.name, new Error("repaired out of band"), clock.now());

  await answerWorkspaceQuarantine(pr, quarantineQuestion(db, "workspace", workspace.name)!);

  expect(head(workspace)).toBe(`task/${work.id}`);
});

it("done の子孫のブランチに merge される head に無い内容があれば積み残しで、CI 緑でも無人 merge されず、event も question も無くキューに残る", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-descendant", "auto_if_ci_green");
  const repair = settleRepairNotMergedBack(db, clock, workspace, work.id);
  const events = listEvents(db, work.id).length;

  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id)).toHaveLength(events);

  // キューに残っている —— 修理を merge back し、着地が push した後の tick で merge される
  git(workspace.path, "merge", "--no-edit", `task/${repair.id}`);
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  await landing.tick("auto_merge", clock.now());
  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("cancelled の祖先の下に残った done の work の内容は積み残しではなく、無人 merge される", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-cancelled", "auto_if_ci_green");
  const abandoned = attachUnsettledChild(db, clock, work.id);
  const inner = settleRepairNotMergedBack(db, clock, workspace, work.id, abandoned.id);
  cancelTaskDirectly(db, getTask(db, abandoned.id)!, null, clock.now(), {}, "webui");
  expect(getTask(db, inner.id)!.status).toBe("done");

  await landing.tick("auto_merge", clock.now());

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("修理の内容がローカルの着地するタスクのブランチに無くても、merge される head に載っていれば積み残しではない", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-on-origin", "auto_if_ci_green");
  const repair = settleRepairNotMergedBack(db, clock, workspace, work.id);
  git(workspace.path, "push", "origin", `task/${repair.id}:task/${work.id}`);

  await landing.tick("auto_merge", clock.now());

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("着地するタスクのブランチに修理を `merge -s ours` で記録して push すれば、捨てた修理は積み残しではない", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-discarded", "auto_if_ci_green");
  const repair = settleRepairNotMergedBack(db, clock, workspace, work.id);
  git(workspace.path, "merge", "-s", "ours", "--no-edit", `task/${repair.id}`);
  git(workspace.path, "push", "origin", `task/${work.id}`);

  await landing.tick("auto_merge", clock.now());

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("merge back 済み・push 前でタスクブランチが origin 側に無い内容を持てば積み残しで無人 merge されず、着地が push した後の tick で merge される", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-unpushed", "auto_if_ci_green");
  commitWork(workspace.path, "repair.txt", "fixed\n");

  await landing.tick("auto_merge", clock.now());
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);

  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  await landing.tick("auto_merge", clock.now());
  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("盤面の外の push で origin 側だけが先へ進んでいるのは積み残しではなく、無人 merge される", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-outside-push", "auto_if_ci_green");
  git(workspace.path, "checkout", "-b", "outside");
  commitWork(workspace.path, "outside.txt", "pushed by a human\n");
  git(workspace.path, "push", "origin", `outside:task/${work.id}`);
  git(workspace.path, "checkout", `task/${work.id}`);

  await landing.tick("auto_merge", clock.now());

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
  expect(mergeQuestions(db)).toEqual([]);
});

// ADR 0242 決定1: merge の門は GitHub が報告した head と比べる —— 盤面の checkout の写しは読まない
/** PR #1 の merge question に人間が「merge」と答える。 */
function answerMergeQuestion({
  db,
  clock,
  github,
  workspace,
}: { db: Db; clock: FakeClock; github: FakeGitHubClient; workspace: WorkspaceConfig }) {
  const question = getTask(db, listBoard(db).find((q) => q.question_pending_merge_pr === 1)!.id)!;
  return submitAnswer(
    { db, pollNow: () => {}, landing: unusedLanding, workspace, github },
    question,
    ["merge"],
    undefined,
    () => clock.now(),
    "webui",
  );
}

/** #1831 の形: 修理を merge back して収束が push した後、別の clone が PR のブランチを修理より前の commit の上へ
 *  force-push する。 */
async function dropRepairOutsideBoard(pr: Awaited<ReturnType<typeof openPushedPr>>) {
  const { workspace, db, clock, work, landing } = pr;
  const beforeRepair = git(workspace.path, "rev-parse", "HEAD");
  const repair = settleRepairNotMergedBack(db, clock, workspace, work.id);
  git(workspace.path, "merge", "--no-edit", `task/${repair.id}`);
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  await pushOutsideBoard(workspace, work.id, beforeRepair);
  return repair;
}

// ADR 0242 決定4: 盤面の外の push が落とした内容は、盤面には運ぶ手が無い —— キューを外して推奨 hold の merge question に倒す
it("別の clone からの force-push で修理が消えた PR は、CI 緑でも無人 merge されず、キューを外れ、届いていない修理のブランチを名指す推奨 hold の merge question が1枚立つ", async () => {
  const pr = await openPushedPr("left-behind-dropped-outside", "auto_if_ci_green");
  const repair = await dropRepairOutsideBoard(pr);

  await pr.landing.tick("auto_merge", pr.clock.now());

  expect(pr.github.merged).toEqual([]);
  expect(await readOnNextTick(pr.landing, pr.github, pr.clock.now())).toEqual([]);
  expect(mergeQuestions(pr.db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_WORKER_ID, "board"],
      recommendation: "hold",
      purpose: expect.stringContaining(`task/${repair.id}`),
    },
  ]);
});

it("別の clone からの force-push で修理が消えた PR への人間の merge 回答は、head が盤面の外で push され修理の内容を持たないと言って拒まれ、merge されず question は開いたまま", async () => {
  const pr = await openPushedPr("left-behind-dropped-outside-answer", "auto_if_ci_green");
  const repair = await dropRepairOutsideBoard(pr);
  await pr.landing.tick("auto_merge", pr.clock.now());
  const head = originHead(pr.workspace, pr.work.id);
  const question = listBoard(pr.db).find((q) => q.question_pending_merge_pr === 1)!;

  const error = await answerMergeQuestion(pr).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(DomainError);
  expect((error as Error).message).toMatch(
    new RegExp(`^cannot merge: PR #1's head ${head} was pushed outside the board and lacks the content of task/${repair.id} — .*merge -s ours`),
  );
  expect(pr.github.merged).toEqual([]);
  expect(listBoard(pr.db).find((q) => q.id === question.id)?.status).toBe("todo");
});

it("外の push が落とした内容をブランチに戻して push すれば、その merge question への「merge」の回答は通る", async () => {
  const pr = await openPushedPr("left-behind-dropped-outside-restored", "auto_if_ci_green");
  await dropRepairOutsideBoard(pr);
  await pr.landing.tick("auto_merge", pr.clock.now());
  git(pr.workspace.path, "push", "--force", "origin", `task/${pr.work.id}`);

  await expect(answerMergeQuestion(pr)).resolves.toMatchObject({ status: "done" });

  expect(pr.github.merged.map((merged) => merged.number)).toEqual([1]);
});

it("外の push が落とした内容を、workspace でタスクブランチを GitHub の head に合わせてから `merge -s ours` で記録して push すれば、修理の内容を戻さずに「merge」の回答が通る", async () => {
  const pr = await openPushedPr("left-behind-dropped-outside-discarded", "auto_if_ci_green");
  const repair = await dropRepairOutsideBoard(pr);
  await pr.landing.tick("auto_merge", pr.clock.now());
  git(pr.workspace.path, "fetch", "origin");
  git(pr.workspace.path, "reset", "--hard", `origin/task/${pr.work.id}`);
  git(pr.workspace.path, "merge", "-s", "ours", "--no-edit", `task/${repair.id}`);
  git(pr.workspace.path, "push", "origin", `task/${pr.work.id}`);

  await expect(answerMergeQuestion(pr)).resolves.toMatchObject({ status: "done" });

  expect(pr.github.merged.map((merged) => merged.number)).toEqual([1]);
  expect(() => git(pr.workspace.path, "cat-file", "-e", `${originHead(pr.workspace, pr.work.id)}:repair.txt`)).toThrow();
});

/** 収束が PR #1 を開く(盤面自身の push)。`narrowRefspec` は #1778 の形 —— fetch の refspec を保護ブランチだけに絞った
 *  checkout(`--single-branch` の clone)で、push しても写しが書かれない。 */
async function openPrByConvergence(name: string, merge: MergeDial, { narrowRefspec = false } = {}) {
  const { workspace } = await makeRemoteBackedWorkspace(name);
  if (narrowRefspec) git(workspace.path, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github, () => profile(merge));
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
  return { workspace, db, clock, github, work, landing };
}

it("refspec を保護ブランチだけに絞った checkout でも、収束が PR を開いて push した後の tick で無人 merge される", async () => {
  const { github, landing, clock } = await openPrByConvergence("left-behind-narrow-refspec", "auto_if_ci_green", {
    narrowRefspec: true,
  });

  await landing.tick("auto_merge", clock.now());

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("refspec を絞った checkout の PR への人間の merge 回答は通り、PR を1回だけ読んで、その head で merge する", async () => {
  const pr = await openPrByConvergence("left-behind-narrow-refspec-answer", "escalate", { narrowRefspec: true });

  await expect(answerMergeQuestion(pr)).resolves.toMatchObject({ status: "done" });

  expect(pr.github.ciChecks).toHaveLength(1);
  expect(pr.github.mergedHeads).toEqual([originHead(pr.workspace, pr.work.id)]);
});

it("盤面自身が push した head は手元にあるので、origin に届かなくても fetch を撃たずに無人 merge される", async () => {
  const { workspace, github, work, landing, clock } = await openPrByConvergence("left-behind-no-fetch", "auto_if_ci_green");
  github.scriptHead(1, originHead(workspace, work.id));
  git(workspace.path, "remote", "set-url", "origin", join(workspace.path, "unreachable"));

  await landing.tick("auto_merge", clock.now());

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

// ADR 0242 決定2: 収束は盤面が最後に push した head と比べる —— 写しは読まない
it("写しが無くても、盤面が最後に push した head に内容が全部載っていれば、収束は push せず up_to_date を返す", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-converge-no-copy", "escalate");
  finish(db, clock, work);
  git(workspace.path, "update-ref", "-d", `refs/remotes/origin/task/${work.id}`);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "up_to_date", prNumber: 1 });
  expect(github.pushes).toEqual([]);
});

it("push の直後に写しが消えても、今 push した head に内容が載っていれば着地し、失敗 question を立てない", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-after-push-no-copy", "escalate");
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, work);
  afterEachPush(github, () => git(workspace.path, "update-ref", "-d", `refs/remotes/origin/task/${work.id}`));

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  expect(promotionFailures(db, work.id)).toEqual([]);
});

// ADR 0242 決定3: 比べられなければ積み残し。人間の merge 回答は「運んでいる途中」でなく、比べられなかった事実と理由で拒む(#1854)
const NOWHERE = "0123456789abcdef0123456789abcdef01234567";

it("GitHub の head が手元にも origin にも無ければ、head の fetch が失敗して積み残しとなり、無人 merge されずキューに残る", async () => {
  const { db, github, landing, clock } = await openPushedPr("left-behind-fetch-fails", "auto_if_ci_green");
  github.scriptHead(1, NOWHERE);

  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([1]);
});

it("GitHub の head が手元にも origin にも無い PR への人間の merge 回答は、head の fetch が失敗したことを言って拒まれる", async () => {
  const pr = await openPushedPr("left-behind-fetch-fails-answer", "escalate");
  pr.github.scriptHead(1, NOWHERE);

  const error = await answerMergeQuestion(pr).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(DomainError);
  expect((error as Error).message).toMatch(
    new RegExp(`^cannot merge: could not compare PR #1's head ${NOWHERE} with the task's content — .*git fetch`, "s"),
  );
  expect((error as Error).message).not.toContain(STILL_CARRYING);
  expect(pr.github.merged).toEqual([]);
});

it("読めない PR への人間の merge 回答は、head を比べられなかったと言って拒まれる", async () => {
  const pr = await openPushedPr("left-behind-unreadable-answer", "escalate");
  pr.github.scriptUnreadable(1);

  await expect(answerMergeQuestion(pr)).rejects.toThrow(
    new DomainError("cannot merge: could not read PR #1, so its head could not be compared with the task's content"),
  );
});

/** ref を読む git が exit 128 で落ちる checkout にする —— `rev-parse --verify --quiet` も「無い」(exit 1)とは答えない。 */
const breakPackedRefs = (workspace: WorkspaceConfig) =>
  appendFileSync(join(workspace.path, ".git", "packed-refs"), "not a packed ref\n");

it("タスクブランチの有無を読む rev-parse が exit 1 以外で落ちれば積み残しとなり、無人 merge されない", async () => {
  const { workspace, github, landing, clock } = await openPushedPr("left-behind-rev-parse-fails", "auto_if_ci_green");
  breakPackedRefs(workspace);

  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
});

it("タスクブランチの有無を読む rev-parse が exit 1 以外で落ちた PR への人間の merge 回答は、比べられなかったと言って拒まれ、運んでいる途中とは言わない", async () => {
  const pr = await openPushedPr("left-behind-rev-parse-fails-answer", "escalate");
  breakPackedRefs(pr.workspace);

  const error = await answerMergeQuestion(pr).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(DomainError);
  expect((error as Error).message).toMatch(/^cannot merge: could not compare PR #1's head [0-9a-f]{40} with the task's content — /);
  expect((error as Error).message).not.toContain(STILL_CARRYING);
  expect(pr.github.merged).toEqual([]);
});

// ADR 0241 決定7: push しても積み残しが消えなければ、着地したとは言わない。push はする
it("PR を開いた後に積み残しが残れば landed を返さず、内容の届いていない子孫を名指す失敗 question を1枚立て、merge back の後の retry で着地する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("left-behind-after-open");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const repair = settleRepairNotMergedBack(db, clock, workspace, work.id);
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "failed",
    reason: "content_left_behind",
    error: `pushed task/${work.id}, but the content of task/${repair.id} has not reached it`,
  });
  expect(github.requests).toHaveLength(1);
  expect(getTask(db, work.id)?.pr_number).toBe(1);
  const failures = promotionFailures(db, work.id);
  expect(failures.map((q) => q.purpose)).toEqual([expect.stringContaining(`task/${repair.id}`)]);

  git(workspace.path, "merge", "--no-edit", `task/${repair.id}`);
  await expect(convergeOn(landing, work.id, failures[0]!.id)).resolves.toMatchObject({
    kind: "landed",
    form: "open_pull_request_updated",
  });
});

it("開いている PR へ push した後に積み残しが残れば landed を返さず、失敗 question を1枚立てる", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-after-push", "escalate");
  const repair = settleRepairNotMergedBack(db, clock, workspace, work.id);
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "content_left_behind" });
  expect(github.pushes).toHaveLength(1);
  expect(promotionFailures(db, work.id).map(({ title, purpose }) => ({ title, purpose }))).toEqual([
    {
      title: "PR promotion left content behind: ship",
      purpose:
        `Pushing task/${work.id} for completed task "ship" left content behind: the content of task/${repair.id} ` +
        `has not reached task/${work.id}. Merge it back into task/${work.id}, then retry.`,
    },
  ]);
});

it("push の後に積み残しが残っても、workspace の quarantine が抱えていれば失敗 question を立てず、その quarantine を名乗る", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-quarantined", "escalate");
  settleRepairNotMergedBack(db, clock, workspace, work.id);
  finish(db, clock, work);
  afterEachPush(github, () => quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now()));

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "quarantined",
    error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
  });
  expect(promotionFailures(db, work.id)).toEqual([]);
});

// ADR 0241 決定6: push の後に積み残しを比べられなくても、workspace の quarantine が抱えていれば失敗 question を重ねない。
// 抱えていなければ失敗 question を立てる(fail-closed)
it.each([
  ["workspace の quarantine が抱えていれば、失敗 question を立てずその quarantine を名乗る", true],
  ["quarantine が抱えていなければ、失敗 question を1枚立てる", false],
])("push の後に積み残しを比べられないとき、%s", async (_, quarantine) => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-unreadable-after-push", "escalate");
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, work);
  afterEachPush(github, () => {
    breakPackedRefs(workspace);
    if (quarantine) quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());
  });

  const verdict = await convergeOn(landing, work.id);

  expect(github.pushes).toHaveLength(1);
  if (quarantine) {
    expect(verdict).toEqual({
      kind: "quarantined",
      error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
    });
    expect(promotionFailures(db, work.id)).toEqual([]);
  } else {
    expect(verdict).toMatchObject({ kind: "failed", reason: "promotion_failed" });
    expect(promotionFailures(db, work.id)).toHaveLength(1);
  }
});

// ADR 0240 決定5: 拒否文は積み残しを運ぶ面を名指しする。どちらも無ければ、盤面が運んでいる途中である
const STILL_CARRYING = "the board is still carrying it; answer again later";
const carriedBy = (surface: string, questionId: string) =>
  `the open ${surface} question (${questionId}) carries it; answer that question first, then answer again`;
it.each<[string, (pr: Awaited<ReturnType<typeof openPushedPr>>) => string]>([
  [
    "子孫の merge back 前",
    ({ workspace, db, clock, work }) => {
      settleRepairNotMergedBack(db, clock, workspace, work.id);
      return STILL_CARRYING;
    },
  ],
  [
    "merge back 済み・push 前",
    ({ workspace }) => {
      commitWork(workspace.path, "repair.txt", "fixed\n");
      return STILL_CARRYING;
    },
  ],
  [
    "merge back が workspace の quarantine に落ちた",
    ({ workspace, db, clock, work }) => {
      settleRepairNotMergedBack(db, clock, workspace, work.id);
      quarantineWorkspace(db, workspace.name, new Error("merge back conflicted"), clock.now());
      return carriedBy("workspace quarantine", quarantineQuestion(db, "workspace", workspace.name)!.id);
    },
  ],
  [
    "push が PR 昇格失敗 question に落ちた",
    ({ workspace, db, clock, work }) => {
      commitWork(workspace.path, "repair.txt", "fixed\n");
      registerPrPromotionFailureQuestion(db, work, "push failed", clock.now());
      return carriedBy("PR promotion failure", promotionFailures(db, work.id)[0]!.id);
    },
  ],
])(
  "積み残し(%s)のある PR への人間の merge 回答は拒まれ、拒否文は運ぶ面を名指しし、merge されず question は開いたまま残る",
  async (_, leaveBehind) => {
    const pr = await openPushedPr("left-behind-answer", "escalate");
    const { db, github } = pr;
    const carrier = leaveBehind(pr);
    const question = listBoard(db).find((q) => q.question_pending_merge_pr === 1)!;
    await expect(answerMergeQuestion(pr)).rejects.toThrow(new DomainError(`cannot merge yet: PR #1 does not carry all of the task's content yet — ${carrier}`));
    expect(github.merged).toEqual([]);
    expect(listBoard(db).find((q) => q.id === question.id)?.status).toBe("todo");
  },
);

it("escalate で開いた PR の後にダイヤルを auto_if_ci_green へ緩めても、何も無人 merge キューに入らない", async () => {
  const workspace = await makeWorkspace("landing-loosened-dial");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  recordPrOpenedViaWorker(db, landingWork(db, clock), 1, "worker", clock.now(), {
    authority: { merge: "escalate" },
  });

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  }).tick("auto_merge", clock.now());

  expect(github.ciChecks).toEqual([]);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});

// ADR 0217 決定3: 着地の2点 — PR を開く時点と、無人 merge キューの PR に CI を読んだ後で行為する瞬間 — で
// profile が解決できなければ、ダイヤルを推測せず agent を quarantine に落とす。以下はこの判定を述べる唯一の場所(ADR 0107)。
const unresolvable = (): AuthorityProfile => {
  throw new UnknownAgentError("tako");
};
const UNRESOLVABLE: Array<[string, () => AuthorityProfile]> = UNRESOLVABLE_AGENT.map(([kind, error]) => [
  kind,
  () => {
    throw error("tako");
  },
]);

// ADR 0232 決定3: profile は門より先に読むので、門が閉じている間もこの判定は働く
it("門が閉じている間も profile は読まれ、解決できなければその tick で agent を quarantine に落としてキューに残す", async () => {
  const workspace = await makeWorkspace("landing-gate-after-profile");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  const child = attachUnsettledChild(db, clock, work.id);
  let resolveAuthority = unresolvable;
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => resolveAuthority(),
  });

  await landing.tick("auto_merge", clock.now());
  expect(quarantineQuestion(db, "agent", "tako")).toBeDefined();

  resolveAuthority = () => profile("auto_if_ci_green");
  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge", clock.now());
  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

it.each(UNRESOLVABLE)("PR を開く時点で profile が %s で解決できなければ、PR を開かず agent を quarantine に落とし、失敗 question を立てず、registry を直した後の収束で PR を開く", async (_, fail) => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-unresolvable-at-open");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  let resolveAuthority = fail;
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => resolveAuthority(),
  });
  const task = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "quarantined",
    error: 'agent "tako" is quarantined: its authority profile cannot be resolved for landing; repair the registry and answer its quarantine question',
  });
  expect(github.requests).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeDefined();
  expect(promotionFailures(db, task.id)).toEqual([]);

  // registry を直した後の収束で PR が開き、本当のダイヤル(auto_if_ci_green)の面 —— 無人 merge キュー —— に着地する
  resolveAuthority = () => profile("auto_if_ci_green");
  await expect(convergeOn(landing, task.id)).resolves.toMatchObject({
    kind: "landed",
    form: "pull_request_opened",
  });
  expect(github.requests).toHaveLength(1);
  await landing.tick("auto_merge", clock.now());
  expect(github.merged).toHaveLength(1);
});

it("開いている PR へ修理を push する着地は profile を読まないので、解決できなくても push して agent を quarantine に落とさない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-unresolvable-open-pr-update");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: unresolvable,
  });
  const task = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  recordPrOpenedViaWorker(db, task, 1, "worker", clock.now());

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "landed",
    form: "open_pull_request_updated",
    prNumber: 1,
  });
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
});

function agentQuarantines(db: Db) {
  return listBoard(db).filter((q) => q.question_quarantine_kind === "agent" && q.status === "todo");
}

it.each(UNRESOLVABLE)("無人 merge の瞬間に profile が %s で解決できなければ、merge せずキューに残し、agent の quarantine は重ねず、直った後の tick が本当のダイヤルで merge する", async (_, fail) => {
  const workspace = await makeWorkspace("landing-unresolvable-at-merge");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  let resolveAuthority = fail;
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => resolveAuthority(),
  });

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");
  expect(agentQuarantines(db).map((q) => q.question_quarantine_value)).toEqual(["tako"]);

  resolveAuthority = () => profile("auto_if_ci_green");
  await landing.tick("auto_merge", clock.now());
  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

it("直した registry でダイヤルが escalate に変わっていれば、直った後の tick は merge せず盤面の名義の merge question に渡す", async () => {
  const workspace = await makeWorkspace("landing-unresolvable-repaired-escalate");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  let resolveAuthority = unresolvable;
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => resolveAuthority(),
  });
  await landing.tick("auto_merge", clock.now());

  resolveAuthority = () => profile("escalate");
  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([expect.objectContaining({ pr: 1, registrant: [BOARD_WORKER_ID, "board"] })]);
});

it("CI を読んでいる間に profile が解決できなくなっても merge しない — merge の直前の読みも quarantine に落とす", async () => {
  const workspace = await makeWorkspace("landing-unresolvable-before-merge");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  let resolveAuthority = (): AuthorityProfile => profile("auto_if_ci_green");
  afterCiRead(github, () => {
    resolveAuthority = unresolvable;
  });

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => resolveAuthority(),
  }).tick("auto_merge", clock.now());

  expect(github.ciChecks).toHaveLength(1);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeDefined();
});

it("CI 赤を読んでいる間に profile が解決できなくなった PR は、question なしで agent を quarantine に落としてキューに残り、直った後の tick で CI 赤の question を立てる", async () => {
  const workspace = await makeWorkspace("landing-red-ci-unresolvable");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  let resolveAuthority = (): AuthorityProfile => profile("auto_if_ci_green");
  github.scriptCiStatus("failure");
  afterCiRead(github, () => {
    if (github.ciChecks.length === 1) resolveAuthority = unresolvable;
  });
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => resolveAuthority(),
  });

  await landing.tick("auto_merge", clock.now());
  expect(mergeQuestions(db)).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeDefined();

  resolveAuthority = () => profile("auto_if_ci_green");
  await landing.tick("auto_merge", clock.now());
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
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
  recordPrOpenedViaWorker(db, work, 1, "fugu", clock.now(), { authority: { merge: "auto_if_ci_green" } });
  const registry = loadRegistry(await makeRegistry(), "purely-local");
  let resolveAuthority = (assignee: string | null, taskType: TaskType): AuthorityProfile =>
    resolveExecutionAgent(registry, "tako", assignee, seedTierNames, taskType).profile;
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: (assignee, taskType) => resolveAuthority(assignee, taskType),
  });

  await landing.tick("auto_merge", clock.now());

  expect(github.merged).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");
  expect(agentQuarantines(db).map((q) => q.question_quarantine_value)).toEqual(["fugu"]);

  resolveAuthority = () => profile("auto_if_ci_green");
  await landing.tick("auto_merge", clock.now());
  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

// ADR 0103 決定1・4: 帯域外の判定は盤面自身の記録(ref snapshot)との突き合わせで、
// 着地の回答だけがこの型を隔離に結ぶ。以下のテストがこの判定を述べる唯一の場所(ADR 0107)。
/** 記録がある形: work を拾い、タスクブランチに commit し、解放する。保護ブランチの行が
 *  記録に入り、HEAD は保護ブランチへ戻っている。 */
async function recordedWork(
  board: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  content = "finished\n",
  file = "feature.txt",
) {
  const work = landingWork(board, clock);
  await prepareWorkspaceAtPickup(board, workspace, work, { now: new Date(0) });
  commitWork(workspace.path, file, content);
  releaseWorkspace(board, workspace, work, clock.now());
  return work;
}

/** 着地 question に人間が WebUI から merge と答える。 */
function answerMerge(board: Db, clock: FakeClock, workspace: WorkspaceConfig, question: Task) {
  return submitAnswer(
    { db: board, pollNow: () => {}, landing: unusedLanding, workspace },
    question,
    ["merge"],
    undefined,
    () => clock.now(),
    "webui",
  );
}

/** 記録の欠落の形: 一度も拾われていないので ref snapshot に保護ブランチの行が無い。 */
async function unrecordedWork(board: Db, clock: FakeClock, workspace: WorkspaceConfig) {
  const work = landingWork(board, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
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

  expect(() => mergeTaskToProtected(db, workspace, work.id)).toThrow(OutOfBandProtectedBranchError);
  expect(() => mergeTaskToProtected(db, workspace, work.id)).toThrow("the board recorded it at");
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

  expect(() => mergeTaskToProtected(db, workspace, work.id)).toThrow(OutOfBandProtectedBranchError);
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(rolledBackTo);
});

it("記録に保護ブランチの行が無ければ、位置が動いていなくても着地を拒む", async () => {
  const workspace = await makeWorkspace("landing-out-of-band-unrecorded");
  const { db, clock } = await openBoard();
  const work = await unrecordedWork(db, clock, workspace);
  const before = git(workspace.path, "rev-parse", "refs/heads/main");

  expect(() => mergeTaskToProtected(db, workspace, work.id)).toThrow("no recorded position");
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
  await prepareWorkspaceAtPickup(db, workspace, running, { now: new Date(0) });
  const tip = git(workspace.path, "rev-parse", `task/${work.id}`);
  announceThenCrash(db, workspace, "refs/heads/main", tip);
  if (written) git(workspace.path, "update-ref", "refs/heads/main", tip);

  await answerMerge(db, clock, workspace, question);
  commitWork(workspace.path, "running.txt", "work\n");
  releaseWorkspace(db, workspace, running, clock.now());

  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(tip);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it.each([
  [
    "記録から進んだ",
    async (board: Db, clock: FakeClock, workspace: WorkspaceConfig) => {
      const work = await recordedWork(board, clock, workspace);
      commitWork(workspace.path, "out-of-band.txt", "moved by hand\n");
      return work;
    },
  ],
  ["記録に行の無い", unrecordedWork],
])("%s保護ブランチへ merge と答えると、回答を拒み workspace を quarantine し、着地 question は開いたまま残る", async (_shape, setup) => {
  const workspace = await makeWorkspace("landing-out-of-band-answer");
  const { db, clock } = await openBoard();
  const work = await setup(db, clock, workspace);
  const question = mergeQuestion(db, clock, { pending_local_merge_task_id: work.id });
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();

  await expect(answerMerge(db, clock, workspace, question)).rejects.toThrow(DomainError);

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined();
  expect(getTask(db, question.id)?.status).toBe("todo");
});

// ADR 0103 決定4 の否定側: 記録と一致していれば、着地のコンフリクトは回答の拒否であって隔離ではない。
// 拒否の後も着地 question が開いたまま残る(ADR 0137 決定3)ので、人間は直してもう一度答えられる。
it.each([
  ["slot が空いている", false],
  ["走行中の slot を占めている", true],
])("%s形で着地がコンフリクトしても、回答を拒むだけで quarantine せず、ブランチも HEAD も作業ツリーも動かさない", async (_shape, occupied) => {
  const workspace = await makeWorkspace("landing-conflict-answer");
  const { db, clock } = await openBoard();
  const first = await recordedWork(db, clock, workspace, "from the first task\n");
  const second = await recordedWork(db, clock, workspace, "from the second task\n");
  const firstQuestion = mergeQuestion(db, clock, { pending_local_merge_task_id: first.id });
  const secondQuestion = mergeQuestion(db, clock, { pending_local_merge_task_id: second.id });
  await answerMerge(db, clock, workspace, firstQuestion);
  const third = occupied ? landingWork(db, clock) : undefined;
  if (third) await prepareWorkspaceAtPickup(db, workspace, third, { now: new Date(0) });
  const protectedSha = git(workspace.path, "rev-parse", "refs/heads/main");
  const taskSha = git(workspace.path, "rev-parse", `refs/heads/task/${second.id}`);
  const head = git(workspace.path, "rev-parse", "HEAD");
  const branch = git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD");
  expect(branch).toBe(third ? `task/${third.id}` : "main");

  const rejected = answerMerge(db, clock, workspace, secondQuestion);

  await expect(rejected).rejects.toThrow(DomainError);
  await expect(rejected).rejects.toThrow("does not merge cleanly");
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
  // 落ちた盤面の畳みはディスクに届かない: 予告(2値の行)は書けて、1値へ畳む書き込みだけが届かない形
  db.exec(
    "CREATE TEMP TRIGGER board_drops_before_fold BEFORE UPDATE OF ref_snapshot ON workspace_state " +
      "WHEN NEW.ref_snapshot NOT LIKE '%|%' BEGIN SELECT RAISE(ABORT, 'the board dropped'); END",
  );
  await expect(answerMerge(db, clock, workspace, questions[1]!)).rejects.toThrow("the board dropped");
  db.exec("DROP TRIGGER board_drops_before_fold");
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
  const { questions } = await dormantSerialLanding(db, clock, workspace);

  await answerMerge(db, clock, workspace, questions[1]!);

  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(git(workspace.path, "rev-parse", "refs/heads/main"));
  expect(readFileSync(join(workspace.path, "first.txt"), "utf8")).toBe("first\n");
  expect(readFileSync(join(workspace.path, "second.txt"), "utf8")).toBe("second\n");
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
});

it("休止中の着地がコンフリクトしても、中断した merge を残さない", async () => {
  const workspace = await makeWorkspace("landing-dormant-conflict");
  const { db, clock } = await openBoard();
  const first = await recordedWork(db, clock, workspace, "from the first task\n");
  const second = await recordedWork(db, clock, workspace, "from the second task\n");
  await answerMerge(db, clock, workspace, mergeQuestion(db, clock, { pending_local_merge_task_id: first.id }));

  await expect(
    answerMerge(db, clock, workspace, mergeQuestion(db, clock, { pending_local_merge_task_id: second.id })),
  ).rejects.toThrow("does not merge cleanly");

  expect(() => git(workspace.path, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toThrow();
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
});

// #1872: 走っている session の worker が保護ブランチを checkout していれば、merge 回答は HEAD が保護ブランチにある枝
// (checkout ごと ff)に入る —— 枝は DB の走っている行ではなく HEAD の位置で選ぶ
/** 着地を待つ work と、DB 上で走っている(拾われた)session が保護ブランチを checkout して untracked の WIP を書いた形。 */
async function landingUnderWorkerOnProtected(board: Db, clock: FakeClock, workspace: WorkspaceConfig, wipFile: string) {
  const work = await recordedWork(board, clock, workspace);
  const question = mergeQuestion(board, clock, { pending_local_merge_task_id: work.id });
  const running = pickupTask(board, landingWork(board, clock), "worker", clock.now())!;
  await prepareWorkspaceAtPickup(board, workspace, running, { now: new Date(0) });
  git(workspace.path, "checkout", "main");
  writeFileSync(join(workspace.path, wipFile), "the running session's work in progress\n");
  return { work, question };
}

it("走っている session が保護ブランチを checkout していれば、merge 回答は checkout ごと ff し、WIP を残し quarantine しない", async () => {
  const workspace = await makeWorkspace("landing-worker-on-protected");
  const { db, clock } = await openBoard();
  const { work, question } = await landingUnderWorkerOnProtected(db, clock, workspace, "wip.txt");

  await answerMerge(db, clock, workspace, question);

  const tip = git(workspace.path, "rev-parse", `refs/heads/task/${work.id}`);
  expect(git(workspace.path, "rev-parse", "refs/heads/main")).toBe(tip);
  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(tip);
  expect(git(workspace.path, "status", "--porcelain")).toBe("?? wip.txt");
  expect(readFileSync(join(workspace.path, "wip.txt"), "utf8")).toBe("the running session's work in progress\n");
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

it("保護ブランチを checkout した worker の WIP が着地の運ぶファイルと被れば、ff の拒否が回答の拒否として返り、何も動かさない", async () => {
  const workspace = await makeWorkspace("landing-worker-on-protected-overlap");
  const { db, clock } = await openBoard();
  const before = git(workspace.path, "rev-parse", "refs/heads/main");
  const { question } = await landingUnderWorkerOnProtected(db, clock, workspace, "feature.txt");

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
    workerId: BOARD_WORKER_ID,
    origin: "board",
    payload: { kind: "landing_deferred", reason: "attached_children", count: 1 },
    at: now,
  });
}

it("既定 agent の quarantine 回答前の観測は、assignee 未指定の work の外部 merge を記録してキューを退ける", async () => {
  const { db, clock } = await openBoard();
  const work = completeTask(db, landingWork(db, clock), FULL_HANDOFF, "tako", clock.now(), "worker");
  recordPrOpenedViaWorker(db, work, 7, "tako", clock.now(), {
    authority: { merge: "auto_if_ci_green" },
  });
  const github = new FakeGitHubClient();
  github.scriptMergedOutside(7);
  const landing = createLanding({
    db,
    clock,
    workspace: { name: "reef", path: "/reef", repo: "https://github.com/test/reef" },
    github,
    defaultAgentName: "tako",
    auditorName: "shako",
  });

  await landing.observeAutoMergeOutcomes("shako");
  expect(countTasksAwaitingLanding(db, undefined, "tako", "tako")).toBe(1);
  await landing.observeAutoMergeOutcomes("tako");

  expect(countTasksAwaitingLanding(db, undefined, "tako", "tako")).toBe(0);
  expect(listEvents(db, work.id).filter((event) => event.payload.kind === "pr_merge_observed")).toMatchObject([
    { origin: "board", worker_id: BOARD_WORKER_ID, payload: { kind: "pr_merge_observed", pr_number: 7 } },
  ]);
});

it("quarantine 回答前の観測は、盤面の外で閉じられたキューの PR を閉じた観測としてキューから外す(ADR 0229 決定4)", async () => {
  const { db, clock } = await openBoard();
  const work = completeTask(db, landingWork(db, clock), FULL_HANDOFF, "tako", clock.now(), "worker");
  recordPrOpenedViaWorker(db, work, 7, "tako", clock.now(), {
    authority: { merge: "auto_if_ci_green" },
  });
  const github = new FakeGitHubClient();
  github.scriptClosedOutside(7);
  const landing = createLanding({
    db,
    clock,
    workspace: { name: "reef", path: "/reef", repo: "https://github.com/test/reef" },
    github,
    defaultAgentName: "tako",
  });

  await landing.observeAutoMergeOutcomes("tako");

  expect(countTasksAwaitingLanding(db, undefined, "tako", "tako")).toBe(0);
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(7));
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([]);
});

it.each(["auto_merge", "promotion_failure"] as const)("assignee 未指定の完了 work が %s を待つとき、既定 agent の着地待ちに数える", (waiting) => {
  db = openDb(":memory:");
  const clock = new FakeClock();
  const work = completeTask(db, landingWork(db, clock), FULL_HANDOFF, "tako", clock.now(), "worker");
  if (waiting === "auto_merge") {
    recordPrOpenedViaWorker(db, work, 7, "tako", clock.now(), {
      authority: { merge: "auto_if_ci_green" },
    });
  } else {
    registerPrPromotionFailureQuestion(db, work, "boom", clock.now());
  }

  expect(countTasksAwaitingLanding(db, undefined, "tako", "tako")).toBe(1);
  expect(countTasksAwaitingLanding(db, undefined, "shako", "tako")).toBe(0);
  expect(countTasksAwaitingLanding(db, undefined, "tako")).toBe(0);
});

// ADR 0241 決定6: 待ちの証拠の寄せ集めではなく、収束が導く根から数える —— quarantine が抱えている根は失敗 question を持たない
it("着地を待つ完了タスクは、PR をまだ開いていない未着地の根(門・失敗 question・retry で止まったもの、待ちの証拠を何も持たないもの)と無人 merge キューにいるものを数える", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  deferLanding(db, completedWork(db, now, "tako").id, now);
  recordPrOpenedViaWorker(db, completedWork(db, now, "tako"), 7, "tako", now, {
    authority: { merge: "auto_if_ci_green" },
  });
  registerPrPromotionFailureQuestion(db, completedWork(db, now, "tako"), "boom", now);
  const retried = completedWork(db, now, "tako");
  registerPrPromotionFailureQuestion(db, retried, "boom", now);
  const [failure] = promotionFailures(db, retried.id);
  answerQuestion(db, getTask(db, failure!.id)!, ["retry"], now, undefined, undefined, undefined, "webui");
  completedWork(db, now, "tako");

  expect(countTasksAwaitingLanding(db, undefined, "tako")).toBe(5);
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
  recordPrOpenedViaWorker(db, completedWork(db, now, "tako"), 7, "tako", now, { authority: { merge: "escalate" } });
  completedWork(db, now, "squid");
  await abandonedWork(db, now);
  // 未完了の親と、その枝へ帰る完了した子(収束は何も記録しない)
  const parent = registerTask(
    db,
    { type: "work", title: "integrate", purpose: "p", completion_criteria: "c", assignee: "tako" },
    now,
    ...HUMAN_WEBUI,
  );
  completedWork(db, now, "tako", parent.id);

  // 根かどうかを lineage で読ませる —— 祖先が未決着なら git を呼ばずにその枝へ帰るので、checkout の実体は要らない
  expect(countTasksAwaitingLanding(db, () => ({ name: "reef", path: "/nonexistent/reef" }), "tako")).toBe(0);
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

  expect(countTasksAwaitingLanding(db, resolve, "tako")).toBe(3);
  expect(resolved).toBe(3);
  expect(quarantineQuestion(db, "workspace", "ghost")).toBeUndefined();
});

// ADR 0226: workspace の削除の扉は同じ集合を、タスクの `workspace` の参照で数える
const completedWorkIn = (board: Db, now: Date, workspace?: string) =>
  completedWork(board, now, "tako", undefined, workspace);

it("workspace 名でも、無人 merge キューにいる・PR 昇格失敗の question が開いている・PR をまだ開いていない完了タスクを数える", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  recordPrOpenedViaWorker(db, completedWorkIn(db, now, "reef"), 7, "tako", now, {
    authority: { merge: "auto_if_ci_green" },
  });
  registerPrPromotionFailureQuestion(db, completedWorkIn(db, now, "reef"), "boom", now);
  completedWorkIn(db, now, "reef");

  expect(countTasksAwaitingLandingInWorkspace(db, undefined, "reef")).toBe(3);
});

it("workspace 名では、abandon 済み・着地済み・別 workspace・workspace 未指定の完了タスクを数えない", async () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  await abandonedWork(db, now, "reef");
  recordPrOpenedViaWorker(db, completedWorkIn(db, now, "reef"), 7, "tako", now, { authority: { merge: "escalate" } });
  appendEvent(db, {
    taskId: completedWorkIn(db, now, "reef").id,
    workerId: BOARD_WORKER_ID,
    origin: "board",
    payload: { kind: "nothing_to_land", base: "main" },
    at: now,
  });
  completedWorkIn(db, now, "lagoon");
  completedWorkIn(db, now);

  expect(countTasksAwaitingLandingInWorkspace(db, undefined, "reef")).toBe(0);
  expect(countTasksAwaitingLandingInWorkspace(db, undefined, "lagoon")).toBe(1);
});

// ADR 0234: 未決着タスクは、決着したときに着地し直す完了した work の祖先の workspace も参照する

/** reef の完了 work を、abandon promotion 済みか PR を開き終えた形にする。 */
function rerunnableWorkInReef(board: Db, now: Date, shape: "abandoned" | "pr_opened"): Task {
  const work = completedWork(board, now, "tako", undefined, "reef");
  if (shape === "pr_opened") {
    recordPrOpenedViaWorker(board, work, 7, "tako", now, { authority: { merge: "escalate" } });
  } else {
    deferLanding(board, work.id, now);
    registerPrPromotionFailureQuestion(board, work, "boom", now);
    const [failure] = promotionFailures(board, work.id);
    answerQuestion(board, getTask(board, failure!.id)!, ["abandon promotion"], now, undefined, undefined, undefined, "webui");
  }
  return getTask(board, work.id)!;
}

/** 人間の門で、`parentId` の下に未決着の review を足す。 */
function attachReview(board: Db, now: Date, parentId: string, workspace?: string): Task {
  return registerTask(
    board,
    {
      type: "review",
      title: "second opinion",
      purpose: "p",
      completion_criteria: "c",
      assignee: "squid",
      parent_id: parentId,
      workspace,
    },
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

    attachReview(db, now, work.id, "lagoon");
    attachReview(db, now, work.id);
    attachReview(db, now, work.id, "reef");

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
    workerId: BOARD_WORKER_ID,
    origin: "board",
    payload: { kind: "nothing_to_land", base: "main" },
    at: now,
  });
}

it.each(["nothing_to_land", "local_merge_question"] as const)(
  "PR を持たずに着地した(%s)完了 work の下の未決着タスクは数えず、その上の着地し直す祖先の workspace の参照には数える",
  (form) => {
    db = openDb(":memory:");
    const now = new Date("2026-10-10T00:00:00.000Z");
    const landed = completedWork(db, now, "tako", undefined, "reef");
    landWithoutPr(db, now, landed, form);
    settleReviews(db, now);
    const before = countUnsettledTasksReferencing(db, "workspace", "reef");
    attachReview(db, now, landed.id, "lagoon");
    expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(before);

    // reef の祖先 G の下で、lagoon の P が PR を持たずに着地した —— 収束は P を撃たず、G が着地し直す
    const grand = registerTask(
      db,
      { type: "work", title: "integrate", purpose: "p", completion_criteria: "c", assignee: "tako", workspace: "reef" },
      now,
      ...HUMAN_WEBUI,
    );
    const parent = completedWork(db, now, "tako", grand.id, "lagoon");
    landWithoutPr(db, now, parent, form);
    recordPrOpenedViaWorker(db, completeTask(db, grand, FULL_HANDOFF, "tako", now, "worker"), 7, "tako", now, {
      authority: { merge: "escalate" },
    });
    settleReviews(db, now);
    const beforeGrand = countUnsettledTasksReferencing(db, "workspace", "reef");
    attachReview(db, now, parent.id, "lagoon");

    expect(countUnsettledTasksReferencing(db, "workspace", "reef")).toBe(beforeGrand + 1);
  },
);

// ADR 0225: abandon promotion が断念するのはその時点の内容の昇格。付帯子の決着の後の収束は、
// 刻んだ head から内容が変わっていなければ何もせず、変わっていれば PR を開かずに昇格の question を立て直す
/** 完了した work の PR 昇格を失敗させ、人間が abandon promotion と答えた形。`stampHead: false` は
 *  workspace を持たない回答 —— head を刻めない。 */
async function abandonedPromotion(name: string, { stampHead = true } = {}) {
  const { workspace } = await makeRemoteBackedWorkspace(name);
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
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  // 完了時レビューを決着させてから着地する
  for (const review of listBoard(db).filter((t) => t.parent_id === work.id)) {
    completeTask(db, getTask(db, review.id)!, FULL_HANDOFF, "shako", clock.now(), "worker");
  }
  github.scriptFailure(new Error("token expired"));
  await landing.converge();
  github.scriptFailure(null);
  const [failure] = promotionFailures(db, work.id);
  await answerPromotion(db, clock, landing, stampHead ? workspace : undefined, failure!, "abandon promotion");
  return { db, clock, workspace, github, landing, authority, work: getTask(db, work.id)! };
}

function answerPromotion(
  board: Db,
  clock: FakeClock,
  landing: ReturnType<typeof createLanding>,
  workspace: WorkspaceConfig | undefined,
  question: { id: string },
  answer: "retry" | "abandon promotion",
) {
  return submitAnswer(
    { db: board, pollNow: () => {}, landing, workspace },
    getTask(board, question.id)!,
    [answer],
    undefined,
    () => clock.now(),
    "webui",
  );
}

/** 付帯子を登録し、`repair` があれば親のブランチの内容を変えてから決着させる。 */
function settleAttachedChild(
  board: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  parentId: string,
  repair?: string,
) {
  const child = attachUnsettledChild(board, clock, parentId);
  if (repair) {
    git(workspace.path, "checkout", `task/${parentId}`);
    commitWork(workspace.path, `${repair}.txt`, "fixed\n");
    git(workspace.path, "checkout", "main");
  }
  return completeTask(board, child, FULL_HANDOFF, "tako", clock.now(), "worker");
}

function openPromotionQuestions(board: Db, taskId: string) {
  return promotionFailures(board, taskId).filter((q) => q.status === "todo");
}

it("PR 昇格を abandon した後、内容を変えない付帯子が決着しても、profile が読めなくても、PR も question も立てず agent を quarantine に落とさない", async () => {
  const { db, clock, workspace, github, landing, authority, work } =
    await abandonedPromotion("landing-abandon-unchanged");
  authority.resolve = () => {
    throw new UnknownAgentError("tako");
  };

  settleAttachedChild(db, clock, workspace, work.id);

  await landing.converge();

  expect(github.requests).toHaveLength(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
  expect(countTasksAwaitingLanding(db, () => workspace, "tako", "tako")).toBe(0);
});

it("PR 昇格を abandon した後、修理が内容を変えて決着すると、profile を読まず PR も開かずに昇格の question を1つ立て直し、retry と答えると PR が開く", async () => {
  const { db, clock, workspace, github, landing, authority, work } =
    await abandonedPromotion("landing-abandon-changed");
  authority.resolve = () => {
    throw new UnknownAgentError("tako");
  };

  settleAttachedChild(db, clock, workspace, work.id, "repair");

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
  expect(countTasksAwaitingLanding(db, () => workspace, "tako", "tako")).toBe(1);

  authority.resolve = () => profile("escalate");
  await answerPromotion(db, clock, landing, workspace, reasked[0]!, "retry");

  expect(github.requests).toHaveLength(2);
  expect(getTask(db, work.id)?.pr_number).toBe(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

it("立て直した question への retry の時点で運ぶ内容が無ければ、回答を受理して着地対象なしを1件だけ刻む", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-reasked-nothing");
  settleAttachedChild(db, clock, workspace, work.id, "repair");
  await landing.converge();
  const [reasked] = openPromotionQuestions(db, work.id);
  git(workspace.path, "update-ref", "refs/remotes/origin/main", `refs/heads/task/${work.id}`);

  await answerPromotion(db, clock, landing, workspace, reasked!, "retry");

  expect(getTask(db, reasked!.id)).toMatchObject({ status: "done", question_answer: ["retry"] });
  expect(listEvents(db, work.id).filter((e) => e.kind === "nothing_to_land")).toHaveLength(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(github.requests).toHaveLength(1);
});

it("PR 昇格を abandon した後に内容が変わっても、別の付帯子が未決着の間は門で待ち(待った記録は刻まず)question を立てず、その付帯子の決着で立てる", async () => {
  const { db, clock, workspace, landing, work } = await abandonedPromotion("landing-abandon-gate");
  const pending = attachUnsettledChild(db, clock, work.id);

  settleAttachedChild(db, clock, workspace, work.id, "repair");
  await expect(landing.converge()).resolves.toEqual([
    { taskId: work.id, verdict: { kind: "deferred", reason: "attached_children", count: 1 } },
  ]);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(boardEvents(db, work.id, "landing_deferred")).toEqual([]);

  completeTask(db, pending, FULL_HANDOFF, "tako", clock.now(), "worker");

  await landing.converge();
  expect(openPromotionQuestions(db, work.id).map((q) => q.title)).toEqual(["PR promotion re-asked: ship"]);
});

it("立て直した question にもう一度 abandon と答えるとその時点の head が刻まれ、内容を変えない次の決着では何も起きない", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-abandon-again");
  settleAttachedChild(db, clock, workspace, work.id, "repair");
  await landing.converge();
  const [reasked] = openPromotionQuestions(db, work.id);

  await answerPromotion(db, clock, landing, workspace, reasked!, "abandon promotion");
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "pr_promotion_abandoned")
      .map((e) => e.payload),
  ).toEqual([
    { kind: "pr_promotion_abandoned", head: expect.any(String) },
    { kind: "pr_promotion_abandoned", head: git(workspace.path, "rev-parse", `task/${work.id}`) },
  ]);

  settleAttachedChild(db, clock, workspace, work.id);

  await landing.converge();
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(github.requests).toHaveLength(1);
});

it("head を刻めなかった abandon は、内容を変えない次の決着でも昇格の question を立てる", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-abandon-no-head", {
    stampHead: false,
  });
  expect(latestEventOfTask(db, work.id, "pr_promotion_abandoned")?.payload.head).toBeNull();

  settleAttachedChild(db, clock, workspace, work.id);

  await landing.converge();

  expect(openPromotionQuestions(db, work.id).map((q) => q.title)).toEqual(["PR promotion re-asked: ship"]);
  expect(github.requests).toHaveLength(1);
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
  settleAttachedChild(db, clock, workspace, work.id);
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
  const { workspace } = await makeRemoteBackedWorkspace(name);
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
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  settleReviews(db, clock.now());
  await landing.converge();
  commitWork(workspace.path, "repair.txt", "fixed\n");
  git(workspace.path, "checkout", "main");
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

  settleAttachedChild(db, clock, workspace, work.id);

  await landing.converge();

  expect(github.pushes).toHaveLength(pushed);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
});

it("PR を持つ根の昇格を abandon した後、修理が内容を変えて決着しても push せず昇格の question を1つ立て直し、retry と答えると push する", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPushToOpenPr("landing-abandon-with-pr");
  const pushed = github.pushes.length;

  settleAttachedChild(db, clock, workspace, work.id, "second-repair");

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
  settleAttachedChild(db, clock, workspace, work.id, "repair");
  await landing.converge();
  await answerPromotion(db, clock, landing, workspace, openPromotionQuestions(db, work.id)[0]!, "retry");

  settleAttachedChild(db, clock, workspace, work.id, "second-repair");

  await landing.converge();

  expect(github.pushes).toHaveLength(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

// ADR 0233: 既定への参照は pickup で終わる —— 着手したタスクの着地は、既定を差し替えた盤面でも pickup で解決した先に向かう

/** 既定 `workspace`(省略なら workspace 未指定のまま)と既定 agent `agent` で pickup し、完了して完了時レビューを決着させる。 */
function pickedUpAndCompleted(board: Db, clock: FakeClock, agent: string, workspace?: WorkspaceConfig): Task {
  const picked = pickupTask(board, landingWork(board, clock), agent, clock.now(), { assignee: agent, workspace: workspace?.name })!;
  const done = completeTask(board, picked, FULL_HANDOFF, agent, clock.now(), "worker");
  for (const review of listBoard(board).filter((t) => t.parent_id === done.id)) {
    completeTask(board, getTask(board, review.id)!, FULL_HANDOFF, "shako", clock.now(), "worker");
  }
  return getTask(board, done.id)!;
}

it("既定 workspace a で pickup した workspace 未指定の完了タスクの PR は、既定を b に差し替えた盤面でも a で CI を読んで merge され、盤面の外の merge も a で観測し、a の着地待ちに数える", async () => {
  const a = await makeWorkspace("landing-pinned-a");
  const b = await makeWorkspace("landing-pinned-b");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  for (const pr of [7, 8]) {
    recordPrOpenedViaWorker(db, pickedUpAndCompleted(db, clock, "tako", a), pr, "tako", clock.now(), {
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

  expect(countTasksAwaitingLandingInWorkspace(db, undefined, a.name)).toBe(2);
  expect(countTasksAwaitingLandingInWorkspace(db, undefined, b.name)).toBe(0);

  await landing.observeAutoMergeOutcomes("tako");
  await landing.tick("auto_merge", clock.now());

  expect(github.stateChecks).toEqual([
    { path: a.path, number: 7 },
    { path: a.path, number: 8 },
  ]);
  expect(github.ciChecks).toEqual([{ path: a.path, number: 7 }]);
  expect(github.merged).toEqual([{ path: a.path, number: 7 }]);
});

it("既定 workspace a で pickup した workspace 未指定のタスクの PR 昇格は、既定を b に差し替えた盤面でも a のタスクブランチから PR を開く", async () => {
  const { workspace: a } = await makeRemoteBackedWorkspace("landing-pinned-land-a");
  const { workspace: b } = await makeRemoteBackedWorkspace("landing-pinned-land-b");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const done = pickedUpAndCompleted(db, clock, "tako", a);
  git(a.path, "checkout", "-b", `task/${done.id}`);
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
  recordPrOpenedViaWorker(db, pickedUpAndCompleted(db, clock, "a"), 7, "a", clock.now(), {
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

  expect(countTasksAwaitingLanding(db, undefined, "a", "b")).toBe(1);
  expect(countTasksAwaitingLanding(db, undefined, "b", "b")).toBe(0);

  await landing.tick("auto_merge", clock.now());

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

  const tick = landing.tick("auto_merge", clock.now());
  await gate.entered;
  await (interrupt === "観測" ? landing.observeAutoMergeOutcomes("tako") : landing.tick("auto_merge", clock.now()));
  gate.open();
  await tick;

  expect(autoMergeOutcomeEvents(db, work.id)).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: outcome, pr_number: 1 } },
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

  const stalled = landing.tick("auto_merge", clock.now()); // #1 の読み取りで止まる
  await gate.entered;
  await landing.tick("auto_merge", clock.now()); // #1 を飛ばし、#2 を merge して印を放す
  gate.open();
  await stalled;

  expect(autoMergeOutcomeEvents(db, second.id)).toEqual([
    { worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_merged", pr_number: 2 } },
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

    await landing.tick("auto_merge", clock.now());
    if (next === "観測") {
      github.scriptMergedOutside(1);
      await landing.observeAutoMergeOutcomes("tako");
    } else {
      restore();
      await landing.tick("auto_merge", clock.now());
    }

    expect(autoMergeOutcomeEvents(db, work.id)).toEqual([
      {
        worker_id: BOARD_WORKER_ID,
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
    git(workspace.path, "remote", "set-url", "origin", join(workspace.path, "unreachable"));
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
  const { workspace } = await makeRemoteBackedWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  git(workspace.path, "checkout", "-b", `task/${work.id}`);
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
