import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, latestEventOfTask, listEvents } from "../src/events.js";
import { submitAnswer } from "../src/human-verbs.js";
import {
  countTasksAwaitingLanding,
  countTasksAwaitingLandingInWorkspace,
  createLanding,
  type Landing,
  landingAnnotation,
  registerLocalMergeQuestion,
  registerPrPromotionFailureQuestion,
} from "../src/landing.js";
import { type AuthorityProfile, type MergeDial, REVIEWER_AUTHORITY_PROFILE, UnknownAgentError } from "../src/registry.js";
import {
  answerQuestion,
  completeTask,
  editTask,
  getTask,
  listBoard,
  recordPrOpened,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { raiseObjection } from "../src/triage.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import {
  mergeTaskToProtected,
  OutOfBandProtectedBranchError,
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
  releaseWorkspace,
  UnknownWorkspaceError,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { FakeClock, FakeGitHubClient, UNRESOLVABLE_AGENT, unusedLanding } from "./fakes.js";
import {
  commitWork,
  completedWork,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  quarantineQuestion,
  squashTaskIntoOrigin,
} from "./harness.js";
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
  { authority, isProtected }: { authority?: Parameters<typeof recordPrOpened>[5]; isProtected?: boolean } = {},
): void {
  recordPrOpened(db, task, prNumber, workerId, now, authority, isProtected, "worker");
}

function promotionFailures(board: Db, taskId: string) {
  return listBoard(board).filter(
    (candidate) => candidate.question_pending_pr_promotion_task_id === taskId,
  );
}

/** 別タスクのセッションを盤面の書き込み `boardWrite` をまたいで走らせ、解放する。
 *  ADR 0064 決定4 の撮り直しが効くのはこの形だけである —— 書き込みの後に拾う
 *  セッションは pickup で全体を撮り直す。`workerForges` は、そのセッションの worker が
 *  書き込みの前に偽造する ref。 */
async function straddle(
  board: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  boardWrite: () => Promise<unknown>,
  workerForges?: string,
): Promise<void> {
  const straddler = landingWork(board, clock);
  await prepareWorkspaceAtPickup(board, workspace, straddler, {});
  if (workerForges) git(workspace.path, "update-ref", workerForges, "HEAD");
  await boardWrite();
  commitWork(workspace.path, "straddler.txt", "work\n");
  releaseWorkspace(board, workspace, straddler, clock.now());
}

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

  await expect(landing.land(question)).resolves.toEqual({
    kind: "not_applicable",
    reason: "not_work",
  });
});

it("祖先の task branch へ帰る work は着地対象ではない", async () => {
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

  await expect(landing.land(child)).resolves.toEqual({
    kind: "not_applicable",
    reason: "ancestor_branch",
  });
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
  registerPrPromotionFailureQuestion(db, task, "first failed attempt", clock.now());
  registerPrPromotionFailureQuestion(db, task, "second failed attempt", clock.now());
  const failures = promotionFailures(db, task.id);

  await expect(landing.land(task, failures[0]!.id)).resolves.toEqual({
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

  await expect(landing.land(task)).resolves.toEqual({
    kind: "nothing_to_land",
    base: "refs/remotes/origin/main",
  });
  expect(github.requests).toEqual([]);
});

it("再発火が門で止まったら failure question を開いたままにして GitHub を再試行しない", async () => {
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
  await landing.land(task);
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

  await expect(landing.land(task)).resolves.toEqual({
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

  await expect(landing.land(task)).resolves.toEqual({
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
  const remoteTaskRef = `refs/remotes/origin/task/${task.id}`;

  await straddle(
    db,
    clock,
    workspace,
    () => expect(landing.land(task)).resolves.toMatchObject({ form: "local_merge_question" }),
    remoteTaskRef,
  );

  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(remoteTaskRef);
});

it("remote-backed から purely-local へ変わった再発火は local question を立てて failure question を引退する", async () => {
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
  await landing.land(task);
  const [failure] = promotionFailures(db, task.id);
  currentWorkspace = { ...workspace, repo: undefined };

  await expect(landing.land(task)).resolves.toEqual({
    kind: "landed",
    form: "local_merge_question",
  });
  expect(getTask(db, failure!.id)).toMatchObject({ status: "done", question_answer: null });
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

  await expect(landing.land(task)).resolves.toEqual({
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

  await expect(landing.land(task)).resolves.toEqual({
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
  await landing.land(task);
  commitWork(workspace.path, "repair.txt", "fixed\n");

  await expect(landing.land(getTask(db, task.id)!)).resolves.toEqual({
    kind: "landed",
    form: "open_pull_request_updated",
    prNumber: 1,
  });
  expect(github.requests).toHaveLength(1);
  expect(github.pushes).toEqual([{ path: workspace.path, branch: `task/${task.id}` }]);
});

it("open PR 更新は盤面が動かした remote ref だけを再基準化する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-rebaseline");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "repair an open PR",
      purpose: "push the repair without hiding another ref write",
      completion_criteria: "only the board-written ref is rebaselined",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  recordPrOpenedViaWorker(db, task, 1, "worker", clock.now());

  // push をまたいで走る別タスクのセッションは、盤面の push を違反に数えない
  await straddle(db, clock, workspace, () => landing.land(getTask(db, task.id)!));
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();

  await prepareWorkspaceAtPickup(db, workspace, task, {});
  commitWork(workspace.path, "repair.txt", "fixed\n");
  git(workspace.path, "tag", "worker-created-tag");

  await expect(landing.land(getTask(db, task.id)!)).resolves.toMatchObject({
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
  await landing.land(task);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptMergedOutside(1);

  await expect(landing.land(getTask(db, task.id)!)).resolves.toEqual({
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

it("open PR branch の push 失敗は既存の着地痕跡で隠さず failure question を立てる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-push-failure");
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
  recordPrOpenedViaWorker(db, task, 1, "worker", clock.now());
  const remoteTaskRef = `refs/remotes/origin/task/${task.id}`;

  // 失敗した push の後に撮り直すと、またいだセッションの worker が偽造した ref まで
  // 基準に飲まれる(ADR 0064 決定4)。fake の push は転送の後に失敗するので、偽造が
  // 無くても quarantine にはなる —— 偽造は筋書きと理由文のため
  await straddle(
    db,
    clock,
    workspace,
    () =>
      expect(landing.land(getTask(db, task.id)!)).resolves.toEqual({
        kind: "failed",
        reason: "promotion_failed",
        error: "push rejected",
      }),
    remoteTaskRef,
  );
  expect(listBoard(db)).toContainEqual(
    expect.objectContaining({ question_pending_pr_promotion_task_id: task.id }),
  );
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(remoteTaskRef);
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

  await expect(landing.land(task)).resolves.toEqual({
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

  await expect(landing.land(task)).resolves.toEqual({
    kind: "failed",
    reason: "workspace_unavailable",
    error: "no workspace is configured for landing",
  });
});

it("再発火時の registry drift は閉じた失敗を返し、既存の failure question を引退させない", async () => {
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
  await landing.land(task);
  const [failure] = promotionFailures(db, task.id);
  drifted = true;
  github.scriptFailure(null);

  await expect(landing.land(task)).resolves.toMatchObject({
    kind: "failed",
    reason: "workspace_unavailable",
  });
  expect(getTask(db, failure!.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(listEvents(db, failure!.id)).not.toContainEqual(
    expect.objectContaining({ payload: { kind: "pr_promotion_observed" } }),
  );
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined();
  expect(github.requests).toHaveLength(1);
});

it("needs-human workspace は閉じた理由で返す", async () => {
  const workspace = await makeWorkspace("landing-needs-human");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
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
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  registerPrPromotionFailureQuestion(db, task, "first failed attempt", clock.now());
  const [failure] = promotionFailures(db, task.id);
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());

  await expect(landing.land(task)).resolves.toEqual({
    kind: "failed",
    reason: "workspace_needs_human",
    error: `workspace "${workspace.name}" needs human attention before landing`,
  });
  expect(getTask(db, failure!.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(listEvents(db, failure!.id)).not.toContainEqual(
    expect.objectContaining({ payload: { kind: "pr_promotion_observed" } }),
  );
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

  await expect(landing.land(task)).resolves.toMatchObject({
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
  await landing.land(task);
  await landing.land(task);
  const failures = promotionFailures(db, task.id);
  expect(failures).toHaveLength(2);
  github.scriptFailure(null);

  await expect(landing.land(task, failures[0]!.id)).resolves.toMatchObject({
    kind: "landed",
    form: "pull_request_opened",
  });
  expect(getTask(db, failures[0]!.id)).toMatchObject({ status: "todo", question_answer: null });
  expect(getTask(db, failures[1]!.id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, failures[1]!.id)).toContainEqual(
    expect.objectContaining({ payload: { kind: "pr_promotion_observed" } }),
  );
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
  raiseUnbundledObjection(db, clock, task.id);

  await expect(landing.land(task)).resolves.toEqual({
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

it("祖先の再発火は open PR を持つ work だけを更新する", async () => {
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
  const done = completeTask(db, settled, undefined, "worker", clock.now(), "worker");

  await expect(landing.relandAncestors(done)).resolves.toEqual([
    {
      taskId: parent.id,
      verdict: { kind: "landed", form: "open_pull_request_updated", prNumber: 1 },
    },
  ]);
  expect(github.pushes).toEqual([{ path: workspace.path, branch: `task/${parent.id}` }]);
});

it("並行 retry が先に着地したら遅い再発火の失敗は failure question にしない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace("landing-race");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const create = github.createPullRequest.bind(github);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  github.createPullRequest = async (input) => {
    if (++calls === 1) {
      entered();
      await gate;
      throw new Error("a pull request already exists");
    }
    return create(input);
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship a change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
    ...HUMAN_WEBUI,
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");

  const relanding = landing.land(task);
  await started;
  const retry = await landing.land(task, "answering-question");
  release();
  const relanded = await relanding;

  expect(retry).toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(relanded).toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(
    listBoard(db).filter(
      (candidate) => candidate.question_pending_pr_promotion_task_id === task.id,
    ),
  ).toEqual([]);
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

  await expect(landing.land(repair)).resolves.toMatchObject({
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

  await straddle(db, clock, workspace, () => landing.land(repair));

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
) {
  return registerTask(
    db,
    {
      type: "question",
      title: "land it",
      purpose: "a human decides whether to land",
      completion_criteria: "the answer is recorded",
      question: [{ title: "land it", options: ["merge", "hold"], recommendation: "merge" }],
      ...pending,
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

it("PR から着地タスクを引けない merge question は fail-closed で attached_children を名乗る", async () => {
  const { db, clock } = await openBoard();
  const question = mergeQuestion(db, clock, { pending_merge_pr: 99 });

  expect(landingAnnotation(db, question)).toEqual({ blocked_by: "attached_children" });
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

it("着地の面は CI を読む前に読まれる — 面が変わった PR は CI が pending でも、CI を読まれずにキューを外れる", async () => {
  const workspace = await makeWorkspace("landing-surface-before-ci");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptCiStatus("pending");
  queueAutoMerge(db, clock, 1);

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("escalate"),
  }).tick("auto_merge", clock.now());

  expect(github.ciChecks).toEqual([]);
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});

/** CI を読み終えた瞬間に change を走らせる — 「CI を読んでいる間に変わる」を作る。 */
function afterCiRead(github: FakeGitHubClient, change: () => void) {
  const readPullRequest = github.readPullRequest.bind(github);
  github.readPullRequest = async (ref) => {
    const pr = await readPullRequest(ref);
    change();
    return pr;
  };
}

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
// 同じ順(profile → 着地の面 → 門)で読み直す。CI を読んでいる間に変えるのは、既存の「merge の直前」と同じ形
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

  expect(github.ciChecks.map((ref) => ref.number)).toEqual([1, 2]);
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

  expect(github.stateChecks).toHaveLength(1);
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
  github.scriptStateReadFailure(1, new Error("gh: could not reach github.com"));
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});

  const landing = autoMerging(db, clock, workspace, github);
  await expect(landing.tick("auto_merge", clock.now())).resolves.toBeUndefined();

  expect(logged).toHaveBeenCalledWith(expect.stringContaining("auto-merge of PR #1 "), expect.any(Error));
  expect(await readOnNextTick(landing, github, clock.now())).toEqual([1]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(
    ["pr_merged", "pr_merge_observed", "pr_close_observed", "auto_merge_withdrawn"].flatMap((kind) =>
      boardEvents(db, work.id, kind),
    ),
  ).toEqual([]);
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

it("遅い走査は、盤面の外で閉じられた PR の open な merge question を閉じた観測として決着させる(ADR 0229 決定4)", async () => {
  const workspace = await makeWorkspace("landing-scan-closed");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const question = mergeQuestion(db, clock, { pending_merge_pr: 1 });
  github.scriptClosedOutside(1);

  await autoMerging(db, clock, workspace, github).tick("outside_merge", clock.now());

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(boardEvents(db, question.id, "question_answered")).toEqual([]);
  expect(boardEvents(db, question.id, "pr_close_observed")).toEqual(closeObserved(1));
});

// ADR 0227 決定2・3: check が1つも報告されていない PR は、盤面自身がその PR へ最後に push してから5分の猶予の間だけ待つ
const FIVE_MINUTES = 5 * 60_000;

it("check 未報告の PR は、盤面の最後の push から5分の猶予の内なら merge も question もせずキューに残る", async () => {
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
  "the board last pushed to it, so its CI-green condition cannot be observed. Merge anyway, or hold?";

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
  await landing.land(work);
  await clock.advance(4 * 60_000);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  await landing.land(getTask(db, work.id)!);
  github.scriptCiStatus("unreported");

  // PR を開いてから6分、修理の push からは2分
  await clock.advance(2 * 60_000);
  await landing.tick("auto_merge", clock.now());
  expect(mergeQuestions(db)).toEqual([]);
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "pr_branch_pushed")
      .map(({ worker_id, origin, payload }) => ({ worker_id, origin, payload })),
  ).toEqual([{ worker_id: BOARD_WORKER_ID, origin: "board", payload: { kind: "pr_branch_pushed", pr_number: 1 } }]);

  await clock.advance(3 * 60_000);
  await landing.tick("auto_merge", clock.now());
  expect(mergeQuestions(db).map(({ pr, purpose }) => ({ pr, purpose }))).toEqual([
    { pr: 1, purpose: UNREPORTED_PURPOSE },
  ]);
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

it.each(UNRESOLVABLE)("PR を開く時点で profile が %s で解決できなければ、PR を開かず agent を quarantine に落とし、着地は retry できる失敗として返る", async (_, fail) => {
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

  await expect(landing.land(task)).resolves.toMatchObject({ kind: "failed", reason: "agent_unavailable" });
  expect(github.requests).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeDefined();
  const [failure] = promotionFailures(db, task.id);
  expect(failure?.question_items?.[0]?.recommendation).toBe("retry");

  // registry を直して retry すると PR が開き、本当のダイヤル(auto_if_ci_green)の面 —— 無人 merge キュー —— に着地する
  resolveAuthority = () => profile("auto_if_ci_green");
  await expect(landing.land(task, failure!.id)).resolves.toMatchObject({
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
  recordPrOpenedViaWorker(db, task, 1, "worker", clock.now());

  await expect(landing.land(getTask(db, task.id)!)).resolves.toEqual({
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

it("解決できてダイヤルを持たない組み込みの reviewer profile は、quarantine に落ちない", async () => {
  const workspace = await makeWorkspace("landing-reviewer-profile");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => REVIEWER_AUTHORITY_PROFILE,
  }).tick("auto_merge", clock.now());

  expect(agentQuarantines(db)).toEqual([]);
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "auto_merge_withdrawn")
      .map((e) => e.payload),
  ).toEqual([{ kind: "auto_merge_withdrawn", pr_number: 1, merge: null }]);
});

// ADR 0103 決定1・4: 帯域外の判定は盤面自身の記録(ref snapshot)との突き合わせで、
// 着地の回答だけがこの型を隔離に結ぶ。以下の5本がこの判定を述べる唯一の場所(ADR 0107)。
/** 記録がある形: work を拾い、タスクブランチに commit し、解放する。保護ブランチの行が
 *  記録に入り、HEAD は保護ブランチへ戻っている。 */
async function recordedWork(
  board: Db,
  clock: FakeClock,
  workspace: WorkspaceConfig,
  content = "finished\n",
) {
  const work = landingWork(board, clock);
  await prepareWorkspaceAtPickup(board, workspace, work, {});
  commitWork(workspace.path, "feature.txt", content);
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
  if (third) await prepareWorkspaceAtPickup(db, workspace, third, {});
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
  expect(countTasksAwaitingLanding(db, "tako", "tako", "shako")).toBe(1);
  await landing.observeAutoMergeOutcomes("tako");

  expect(countTasksAwaitingLanding(db, "tako", "tako", "shako")).toBe(0);
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

  expect(countTasksAwaitingLanding(db, "tako", "tako")).toBe(0);
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

  expect(countTasksAwaitingLanding(db, "tako", "tako", "shako")).toBe(1);
  expect(countTasksAwaitingLanding(db, "shako", "tako", "shako")).toBe(0);
  expect(countTasksAwaitingLanding(db, "tako")).toBe(0);
});

it("着地を待つ完了タスクは、付帯子待ちで PR 未作成(retry が再び門で止まったものも)・無人 merge キューにいる・PR 昇格失敗の question が開いている、を数える", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  deferLanding(db, completedWork(db, now, "tako").id, now);
  recordPrOpenedViaWorker(db, completedWork(db, now, "tako"), 7, "tako", now, {
    authority: { merge: "auto_if_ci_green" },
  });
  registerPrPromotionFailureQuestion(db, completedWork(db, now, "tako"), "boom", now);
  // retry が再び門で止まった —— `landing_deferred` は最初の1つしか刻まれない
  const retried = completedWork(db, now, "tako");
  deferLanding(db, retried.id, now);
  registerPrPromotionFailureQuestion(db, retried, "boom", now);
  const [failure] = promotionFailures(db, retried.id);
  answerQuestion(db, getTask(db, failure!.id)!, ["retry"], now, undefined, undefined, undefined, "webui");

  expect(countTasksAwaitingLanding(db, "tako")).toBe(4);
});

it("着地済み・未完了・別 agent・PR 昇格を abandon した・祖先の枝に乗る子は、着地を待つ完了タスクに数えない", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  const landed = completedWork(db, now, "tako");
  deferLanding(db, landed.id, now);
  recordPrOpenedViaWorker(db, landed, 7, "tako", now, { authority: { merge: "escalate" } });
  deferLanding(db, completedWork(db, now, "squid").id, now);
  const abandoned = completedWork(db, now, "tako");
  deferLanding(db, abandoned.id, now);
  registerPrPromotionFailureQuestion(db, abandoned, "boom", now);
  const [failure] = promotionFailures(db, abandoned.id);
  answerQuestion(db, getTask(db, failure!.id)!, ["abandon promotion"], now, undefined, undefined, undefined, "webui");
  // 未完了の親(門で止まった記録があっても done でない)と、その枝へ帰る完了した子(`land()` は何も記録しない)
  const parent = registerTask(
    db,
    { type: "work", title: "integrate", purpose: "p", completion_criteria: "c", assignee: "tako" },
    now,
    ...HUMAN_WEBUI,
  );
  deferLanding(db, parent.id, now);
  completedWork(db, now, "tako", parent.id);

  expect(countTasksAwaitingLanding(db, "tako")).toBe(0);
});

// ADR 0226: workspace の削除の扉は同じ集合を、タスクの `workspace` の参照で数える
const completedWorkIn = (board: Db, now: Date, workspace?: string) =>
  completedWork(board, now, "tako", undefined, workspace);

it("workspace 名でも、無人 merge キューにいる・PR 昇格失敗の question が開いている・門で止まって abandon していない完了タスクを数える", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  recordPrOpenedViaWorker(db, completedWorkIn(db, now, "reef"), 7, "tako", now, {
    authority: { merge: "auto_if_ci_green" },
  });
  registerPrPromotionFailureQuestion(db, completedWorkIn(db, now, "reef"), "boom", now);
  deferLanding(db, completedWorkIn(db, now, "reef").id, now);

  expect(countTasksAwaitingLandingInWorkspace(db, "reef")).toBe(3);
});

it("workspace 名では、abandon 済み・着地済み・別 workspace・workspace 未指定の完了タスクを数えない", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  const abandoned = completedWorkIn(db, now, "reef");
  deferLanding(db, abandoned.id, now);
  registerPrPromotionFailureQuestion(db, abandoned, "boom", now);
  const [failure] = promotionFailures(db, abandoned.id);
  answerQuestion(db, getTask(db, failure!.id)!, ["abandon promotion"], now, undefined, undefined, undefined, "webui");
  const opened = completedWorkIn(db, now, "reef");
  deferLanding(db, opened.id, now);
  recordPrOpenedViaWorker(db, opened, 7, "tako", now, { authority: { merge: "escalate" } });
  const nothing = completedWorkIn(db, now, "reef");
  deferLanding(db, nothing.id, now);
  appendEvent(db, {
    taskId: nothing.id,
    workerId: BOARD_WORKER_ID,
    origin: "board",
    payload: { kind: "nothing_to_land", base: "main" },
    at: now,
  });
  deferLanding(db, completedWorkIn(db, now, "lagoon").id, now);
  deferLanding(db, completedWorkIn(db, now).id, now);

  expect(countTasksAwaitingLandingInWorkspace(db, "reef")).toBe(0);
  expect(countTasksAwaitingLandingInWorkspace(db, "lagoon")).toBe(1);
});

// ADR 0225: abandon promotion が断念するのはその時点の内容の昇格。付帯子の決着による再発火は、
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
  const done = completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  // 完了時レビューを決着させてから着地する
  for (const review of listBoard(db).filter((t) => t.parent_id === work.id)) {
    completeTask(db, getTask(db, review.id)!, FULL_HANDOFF, "shako", clock.now(), "worker");
  }
  github.scriptFailure(new Error("token expired"));
  await landing.land(done);
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

  await landing.relandAncestors(settleAttachedChild(db, clock, workspace, work.id));

  expect(github.requests).toHaveLength(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
  expect(countTasksAwaitingLanding(db, "tako", "tako")).toBe(0);
});

it("PR 昇格を abandon した後、修理が内容を変えて決着すると、profile を読まず PR も開かずに昇格の question を1つ立て直し、retry と答えると PR が開く", async () => {
  const { db, clock, workspace, github, landing, authority, work } =
    await abandonedPromotion("landing-abandon-changed");
  authority.resolve = () => {
    throw new UnknownAgentError("tako");
  };

  await landing.relandAncestors(settleAttachedChild(db, clock, workspace, work.id, "repair"));

  expect(github.requests).toHaveLength(1);
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
  const reasked = openPromotionQuestions(db, work.id);
  expect(reasked).toMatchObject([
    {
      title: "PR promotion re-asked: ship",
      question_items: [{ options: ["retry", "abandon promotion"], recommendation: "retry" }],
    },
  ]);
  expect(countTasksAwaitingLanding(db, "tako", "tako")).toBe(1);

  authority.resolve = () => profile("escalate");
  await answerPromotion(db, clock, landing, workspace, reasked[0]!, "retry");

  expect(github.requests).toHaveLength(2);
  expect(getTask(db, work.id)?.pr_number).toBe(1);
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
});

it("PR 昇格を abandon した後に内容が変わっても、別の付帯子が未決着の間は question を立てず、その付帯子の決着で立てる", async () => {
  const { db, clock, workspace, landing, work } = await abandonedPromotion("landing-abandon-gate");
  const pending = attachUnsettledChild(db, clock, work.id);

  await landing.relandAncestors(settleAttachedChild(db, clock, workspace, work.id, "repair"));
  expect(openPromotionQuestions(db, work.id)).toEqual([]);

  await landing.relandAncestors(completeTask(db, pending, FULL_HANDOFF, "tako", clock.now(), "worker"));
  expect(openPromotionQuestions(db, work.id).map((q) => q.title)).toEqual(["PR promotion re-asked: ship"]);
});

it("立て直した question にもう一度 abandon と答えるとその時点の head が刻まれ、内容を変えない次の決着では何も起きない", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-abandon-again");
  await landing.relandAncestors(settleAttachedChild(db, clock, workspace, work.id, "repair"));
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

  await landing.relandAncestors(settleAttachedChild(db, clock, workspace, work.id));
  expect(openPromotionQuestions(db, work.id)).toEqual([]);
  expect(github.requests).toHaveLength(1);
});

it("head を刻めなかった abandon は、内容を変えない次の決着でも昇格の question を立てる", async () => {
  const { db, clock, workspace, github, landing, work } = await abandonedPromotion("landing-abandon-no-head", {
    stampHead: false,
  });
  expect(latestEventOfTask(db, work.id, "pr_promotion_abandoned")?.payload.head).toBeNull();

  await landing.relandAncestors(settleAttachedChild(db, clock, workspace, work.id));

  expect(openPromotionQuestions(db, work.id).map((q) => q.title)).toEqual(["PR promotion re-asked: ship"]);
  expect(github.requests).toHaveLength(1);
});
