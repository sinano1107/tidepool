import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents } from "../src/events.js";
import { submitAnswer } from "../src/human-verbs.js";
import {
  countTasksAwaitingLanding,
  createLanding,
  landingAnnotation,
  registerLocalMergeQuestion,
  registerPrPromotionFailureQuestion,
} from "../src/landing.js";
import {
  answerQuestion,
  completeTask,
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
import { FakeClock, FakeGitHubClient, unusedLanding } from "./fakes.js";
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
  { authority }: { authority?: Parameters<typeof recordPrOpened>[5] } = {},
): void {
  recordPrOpened(db, task, prNumber, workerId, now, authority, undefined, "worker");
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
    surface: "local_merge_question",
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
    () => expect(landing.land(task)).resolves.toMatchObject({ surface: "local_merge_question" }),
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
    surface: "local_merge_question",
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
    surface: "pull_request_opened",
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
    surface: "open_pull_request_updated",
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
    surface: "open_pull_request_updated",
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
    surface: "pull_request_opened",
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
      verdict: { kind: "landed", surface: "open_pull_request_updated", prNumber: 1 },
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

  expect(retry).toMatchObject({ kind: "landed", surface: "pull_request_opened" });
  expect(relanded).toMatchObject({ kind: "landed", surface: "pull_request_opened" });
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
    surface: "pull_request_opened",
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

  await createLanding({ defaultAgentName: "tako", db, clock, workspace, github }).tick("auto_merge", clock.now());

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

it("着地を待つ完了タスクは、付帯子待ちで PR 未作成・無人 merge キューにいる・PR 昇格失敗の question が開いている、の3つを数える", () => {
  db = openDb(":memory:");
  const now = new Date("2026-10-09T00:00:00.000Z");
  deferLanding(db, completedWork(db, now, "tako").id, now);
  recordPrOpenedViaWorker(db, completedWork(db, now, "tako"), 7, "tako", now, {
    authority: { merge: "auto_if_ci_green" },
  });
  registerPrPromotionFailureQuestion(db, completedWork(db, now, "tako"), "boom", now);

  expect(countTasksAwaitingLanding(db, "tako")).toBe(3);
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
  // 未完了の親と、その枝へ帰る完了した子(`land()` は何も記録しない)
  const parent = registerTask(
    db,
    { type: "work", title: "integrate", purpose: "p", completion_criteria: "c", assignee: "tako" },
    now,
    ...HUMAN_WEBUI,
  );
  completedWork(db, now, "tako", parent.id);

  expect(countTasksAwaitingLanding(db, "tako")).toBe(0);
});
