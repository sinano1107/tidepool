import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { createLanding } from "../src/landing.js";
import {
  completeTask,
  getTask,
  listBoard,
  recordPrOpened,
  registerLocalMergeQuestion,
  registerTask,
} from "../src/tasks.js";
import { raiseObjection } from "../src/triage.js";
import {
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
  releaseWorkspace,
} from "../src/workspace.js";
import { FakeClock, FakeGitHubClient } from "./fakes.js";
import {
  commitWork,
  FULL_HANDOFF,
  git,
  makeRemoteBackedWorkspace,
  makeWorkspace,
  squashTaskIntoOrigin,
} from "./harness.js";

const dirs: string[] = [];
let db: Db | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("work でないタスクは着地対象ではない", async () => {
  const workspace = await makeWorkspace(dirs, "landing-verdict");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, workspace, github: null });
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
  );

  await expect(landing.land(question)).resolves.toEqual({
    kind: "not_applicable",
    reason: "not_work",
  });
});

it("祖先の task branch へ帰る work は着地対象ではない", async () => {
  const workspace = await makeWorkspace(dirs, "landing-lineage");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, workspace, github: null });
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "integrate",
      purpose: "integrate child work",
      completion_criteria: "the child result is integrated",
    },
    clock.now(),
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
  );

  await expect(landing.land(child)).resolves.toEqual({
    kind: "not_applicable",
    reason: "ancestor_branch",
  });
});

it("保護ブランチへ運ぶ内容が無い work はその事実を返して記録する", async () => {
  const workspace = await makeWorkspace(dirs, "landing-empty");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "inspect",
      purpose: "inspect the current state",
      completion_criteria: "the result is reported",
    },
    clock.now(),
  );
  git(workspace.path, "branch", `task/${task.id}`);

  await expect(landing.land(task)).resolves.toEqual({
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
});

it("squash 済みで内容差が無い work は commit 差が残っていても着地しない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-squashed");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "already shipped",
      purpose: "recognize squash-equivalent content",
      completion_criteria: "no duplicate PR is opened",
    },
    clock.now(),
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "already on main\n");
  await squashTaskIntoOrigin(dirs, workspace, task.id);
  git(workspace.path, "fetch", "origin", "main");

  await expect(landing.land(task)).resolves.toEqual({
    kind: "nothing_to_land",
    base: "refs/remotes/origin/main",
  });
  expect(github.requests).toEqual([]);
});

it("未決着の付帯子がある work は理由と数を返して着地を待つ", async () => {
  const workspace = await makeWorkspace(dirs, "landing-deferred");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship reviewed work",
      completion_criteria: "the work is ready",
    },
    clock.now(),
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
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
  );

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
});

it("GitHub の無い purely-local work は merge question 面へ着地する", async () => {
  const workspace = await makeWorkspace(dirs, "landing-local");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship locally",
      purpose: "ship a local change",
      completion_criteria: "the change awaits a merge decision",
    },
    clock.now(),
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

it("GitHub の無い remote-backed work は閉じた理由で失敗し failure question を立てる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-no-github");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
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
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-pr");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");

  await expect(landing.land(task)).resolves.toEqual({
    kind: "landed",
    surface: "pull_request_opened",
    prNumber: 1,
  });
  expect(github.requests).toMatchObject([{ branch: `task/${task.id}`, base: "main" }]);
  expect(getTask(db, task.id)?.pr_number).toBe(1);
});

it("open PR を持つ work の修理は同じ PR の branch を更新する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-open-pr");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
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
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-rebaseline");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "repair an open PR",
      purpose: "push the repair without hiding another ref write",
      completion_criteria: "only the board-written ref is rebaselined",
    },
    clock.now(),
  );
  await prepareWorkspaceAtPickup(db, workspace, task, {});
  recordPrOpened(db, task, 1, "worker", clock.now());
  commitWork(workspace.path, "repair.txt", "fixed\n");
  git(workspace.path, "tag", "worker-created-tag");

  await expect(landing.land(getTask(db, task.id)!)).resolves.toMatchObject({
    kind: "landed",
    surface: "open_pull_request_updated",
  });
  releaseWorkspace(db, workspace, task, clock.now());

  const quarantine = listBoard(db).find(
    (candidate) => candidate.question_quarantine_workspace === workspace.name,
  );
  expect(quarantine?.purpose).toContain("refs/tags/worker-created-tag");
  expect(quarantine?.purpose).not.toContain(`refs/remotes/origin/task/${task.id}`);
});

it("merge 済み PR に残った修理は閉じた理由で失敗し failure question を立てる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-merged-pr");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
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
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-push-failure");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  github.scriptPushFailure(new Error("push rejected"));
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "repair the PR",
      purpose: "update the existing pull request",
      completion_criteria: "the repair reaches the PR branch",
    },
    clock.now(),
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  recordPrOpened(db, task, 1, "worker", clock.now());

  await expect(landing.land(getTask(db, task.id)!)).resolves.toEqual({
    kind: "failed",
    reason: "promotion_failed",
    error: "push rejected",
  });
  expect(listBoard(db)).toContainEqual(
    expect.objectContaining({ question_pending_pr_promotion_task_id: task.id }),
  );
});

it("PR 作成の失敗は閉じた理由で返して failure question を立てる", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-pr-failure");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  github.scriptFailure(new Error("token expired"));
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
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
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship a change",
      completion_criteria: "the change is shipped",
    },
    clock.now(),
  );

  await expect(landing.land(task)).resolves.toEqual({
    kind: "failed",
    reason: "workspace_unavailable",
    error: "no workspace is configured for landing",
  });
});

it("needs-human workspace は閉じた理由で返す", async () => {
  const workspace = await makeWorkspace(dirs, "landing-needs-human");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship a change",
      completion_criteria: "the change is shipped",
    },
    clock.now(),
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());

  await expect(landing.land(task)).resolves.toEqual({
    kind: "failed",
    reason: "workspace_needs_human",
    error: `workspace "${workspace.name}" needs human attention before landing`,
  });
});

it("着地成立は積み上がった failure question を引退させ、回答中の1件だけ除外する", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-retirement");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  github.scriptFailure(new Error("token expired"));
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship remotely",
      purpose: "ship a remote change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  await landing.land(task);
  await landing.land(task);
  const failures = listBoard(db).filter(
    (candidate) => candidate.question_pending_pr_promotion_task_id === task.id,
  );
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
  const workspace = await makeWorkspace(dirs, "landing-objection");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const landing = createLanding({ db, clock, workspace, github: null });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship an agreed change",
      completion_criteria: "the change is ready",
    },
    clock.now(),
  );
  git(workspace.path, "checkout", "-b", `task/${task.id}`);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const entryId = appendEvent(db, {
    taskId: task.id,
    workerId: "worker",
    origin: "worker",
    payload: { kind: "decision_logged", line: "ship this implementation" },
    at: clock.now(),
  });
  raiseObjection(db, entryId, "the implementation still misses the edge case", clock.now());

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
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-ancestors");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  const landing = createLanding({ db, clock, workspace, github });
  const root = registerTask(
    db,
    {
      type: "work",
      title: "root",
      purpose: "integrate the work",
      completion_criteria: "the tree is integrated",
    },
    clock.now(),
  );
  git(workspace.path, "branch", `task/${root.id}`);
  completeTask(db, root, FULL_HANDOFF, "worker", clock.now());
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
  );
  git(workspace.path, "checkout", "-b", `task/${parent.id}`, "main");
  commitWork(workspace.path, "feature.txt", "ready\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now());
  recordPrOpened(db, parent, 1, "worker", clock.now());
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
  );
  const done = completeTask(db, settled, undefined, "worker", clock.now());

  await expect(landing.relandAncestors(done)).resolves.toEqual([
    {
      taskId: parent.id,
      verdict: { kind: "landed", surface: "open_pull_request_updated", prNumber: 1 },
    },
  ]);
  expect(github.pushes).toEqual([{ path: workspace.path, branch: `task/${parent.id}` }]);
});

it("並行 retry が先に着地したら遅い再発火の失敗は failure question にしない", async () => {
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-race");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
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
  const landing = createLanding({ db, clock, workspace, github });
  const task = registerTask(
    db,
    {
      type: "work",
      title: "ship",
      purpose: "ship a change",
      completion_criteria: "a PR exists",
    },
    clock.now(),
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
  const { workspace } = await makeRemoteBackedWorkspace(dirs, "landing-catch-up");
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-landing-"));
  dirs.push(boardDir);
  db = openDb(join(boardDir, "board.sqlite"));
  const clock = new FakeClock();
  const github = new FakeGitHubClient();
  const landing = createLanding({ db, clock, workspace, github });
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "parent",
      purpose: "ship the parent change",
      completion_criteria: "the parent PR exists",
    },
    clock.now(),
  );
  git(workspace.path, "checkout", "-b", `task/${parent.id}`);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now());
  recordPrOpened(db, parent, 1, "worker", clock.now());
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
  );
  git(workspace.path, "checkout", "-b", `task/${repair.id}`, `task/${parent.id}`);
  await squashTaskIntoOrigin(dirs, workspace, parent.id);
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
