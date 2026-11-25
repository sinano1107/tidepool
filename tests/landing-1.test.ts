
import { readFileSync, } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, } from "../src/actor-id.js";
import { type Db, } from "../src/db.js";
import { appendEvent, latestEventOfTask, listEvents, } from "../src/events.js";
import { GhCliClient } from "../src/github.js";
import { GitHubAuth } from "../src/github-auth.js";
import {
  createLanding,
  registerLocalMergeQuestion,
  registerPrPromotionFailureQuestion,
  taskIdsAwaitingLanding,
} from "../src/landing.js";
import { type AuthorityProfile, type MergeDial, UnknownAgentError } from "../src/registry.js";
import {
  answerQuestion,
  completeTask,
  getTask,
  listBoard,
  recordPrOpened,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { markTeardown } from "../src/teardown.js";
import {
  boardRefWriter,
  quarantineWorkspace,
  recordDeclaredRepo,
  recordTaskCheckoutTip,
  refreshProtectedBranch,
  releaseWorkspace,
  UnknownWorkspaceError,
  writeBoardRefs,
} from "../src/workspace.js";
import { awaitWindow, FakeClock, FakeGitHubClient, } from "./fakes.js";
import { startGitHttpRemote } from "./git-http-remote.js";
import {
  checkoutTaskBranch,
  commitWork,
  FULL_HANDOFF,
  failEventInsert,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  leaveBaseline,
  makeLandingWorkspace,
  makeWorkspace,
  prepareAtPickup,
  quarantineQuestion,
  seedTaskBranch,
  settleReviews,
  squashTaskIntoOrigin,
} from "./harness.js";
import {
  afterEachPush,
  announceThenCrash,
  answerPromotion,
  attachUnsettledChild,
  autoMergeOutcomeEvents,
  autoMerging,
  boardEvents,
  closeObserved,
  commitThroughTaskCheckout,
  completeThroughTaskCheckout,
  convergeOn,
  finish,
  forkHead,
  HUMAN_ANSWERER,
  landingWork,
  mergeOnGitHub,
  mergeQuestions,
  openBoard,
  openPromotionQuestions,
  openPushedPr,
  profile,
  promotionFailures,
  pushPrHead,
  queueAutoMerge,
  raiseUnbundledObjection,
  recordPrOpenedOutsideConvergence,
  recordPushedHeadRepo,
  rootWithOpenedPr,
  settle,
  straddle,
} from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0241 決定1: 着地は入口が名指しせず、収束が記録と内容から根を導いて撃つ
it("収束は、保護ブランチへ帰る done の work を根に導いて PR を開く", async () => {
  const { workspace } = await makeLandingWorkspace("landing-converge-root");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);

  await expect(landing.converge()).resolves.toEqual([
    { taskId: work.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 1 } },
  ]);
  expect(github.requests).toMatchObject([{ branch: `task/${work.id}` }]);
});

// ADR 0400 決定2: PR を開くかどうかは収束の規則が決める —— 完了した agent の名前は pr_opened に載らない
it.each(["new PR", "found open PR"] as const)("agent の根の収束が開いた PR(%s)の pr_opened は盤面の名義で、origin board", async (path) => {
  const { workspace } = await makeLandingWorkspace("landing-pr-opened-by-board");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  if (path === "found open PR") {
    git(workspace.path, "push", "head-repo", `task/${work.id}`);
    github.scriptPullRequestOnBranch(`task/${work.id}`);
  }
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(github.requests).toHaveLength(path === "new PR" ? 1 : 0);
  expect(listEvents(db, work.id).filter((e) => e.kind === "pr_opened").map((e) => [e.actor_id, e.origin])).toEqual([[BOARD_ACTOR_ID, "board"]]);
});

const PUSH_PATHS = ["new PR", "found open PR", "recorded open PR"] as const;

async function landingBeforePush(path: (typeof PUSH_PATHS)[number], resolveAuthority?: () => AuthorityProfile) {
  const { workspace } = await makeLandingWorkspace("landing-push-recheck");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  if (path !== "new PR") {
    // PR の head は実在し、origin に載っている(ADR 0376 決定1)
    git(workspace.path, "push", "head-repo", `task/${work.id}`);
    const number = github.scriptPullRequestOnBranch(`task/${work.id}`);
    if (path === "recorded open PR") {
      recordPushedHeadRepo(db, work.id, workspace);
      recordPrOpened(db, work, number, git(workspace.path, "rev-parse", "HEAD"), clock.now(), undefined, undefined);
      commitWork(workspace.path, "repair.txt", "fixed\n");
    }
  }
  const window = awaitWindow();
  const prepare = github.preparePush.bind(github);
  github.preparePush = async (input) => {
    const push = await prepare(input);
    await window.hold();
    return push;
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority });
  const converging = convergeOn(landing, work.id);
  await window.entered;
  return { workspace, db, clock, github, work, converging, open: window.open };
}

it.each(PUSH_PATHS)("%s の push の準備の await 中に異議が出たら、push と PR の作成をせず deferred を刻む", async (path) => {
  const { db, clock, github, work, converging, open } = await landingBeforePush(path);
  raiseUnbundledObjection(db, clock, work.id);
  open();

  await expect(converging).resolves.toEqual({ kind: "deferred", reason: "objections", count: 1 });
  expect(github.pushes).toEqual([]);
  expect(github.requests).toEqual([]);
  expect(listEvents(db, work.id).filter((event) => event.kind === "landing_deferred").map((event) => event.payload)).toEqual([
    { kind: "landing_deferred", reason: "objections", count: 1 },
  ]);
});

it.each(PUSH_PATHS)("%s の push の準備の await 中に workspace が quarantine されたら、push と PR の作成をせず quarantined を返す", async (path) => {
  const { workspace, db, clock, github, work, converging, open } = await landingBeforePush(path);
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());
  open();

  await expect(converging).resolves.toEqual({
    kind: "quarantined",
    error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
  });
  expect(github.pushes).toEqual([]);
  expect(github.requests).toEqual([]);
  expect(listEvents(db, work.id).filter((event) => event.kind === "landing_deferred")).toEqual([]);
  expect(promotionFailures(db, work.id)).toEqual([]);
});

it.each(PUSH_PATHS)("%s の push の準備の await 中に profile が読めなくなったら、面を開く経路だけ agent quarantine で止まる", async (path) => {
  let unreadable = false;
  const { db, github, work, converging, open } = await landingBeforePush(path, () => {
    if (unreadable) throw new UnknownAgentError("tako");
    return profile("escalate");
  });
  unreadable = true;
  open();

  if (path === "recorded open PR") {
    await expect(converging).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
    expect(github.pushes).toHaveLength(1);
    expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
  } else {
    await expect(converging).resolves.toMatchObject({ kind: "quarantined" });
    expect(github.pushes).toEqual([]);
    expect(quarantineQuestion(db, "agent", "tako")).toBeDefined();
  }
  expect(github.requests).toEqual([]);
  expect(promotionFailures(db, work.id)).toEqual([]);
});

it.each(["new PR", "found open PR"] as const)("%s の面は push の準備の await 中に変わった profile のダイヤルで開く", async (path) => {
  let dial: MergeDial = "escalate";
  const { db, converging, open } = await landingBeforePush(path, () => profile(dial));
  dial = "external";
  open();

  await expect(converging).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(mergeQuestions(db)).toEqual([]);
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

  checkoutTaskBranch(db, workspace, parent.id);
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
  recordDeclaredRepo(db, task.id, workspace);
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
      actor_id: "tidepool",
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

// ADR 0405 決定5: 着地の終わりの記録と、それで閉じる兄弟の PR 昇格失敗 question は1つの transaction —— 閉じられなければ記録も残らず、
// 次の収束が同じ根を通り直す
/** purely-local の workspace の根(`pr` があれば、その PR を記録した根)。 */
async function purelyLocalRoot(name: string, pr?: number) {
  const workspace = await makeWorkspace(name);
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = registerTask(db, { type: "work", title: "inspect", purpose: "inspect the current state", completion_criteria: "the result is reported" }, clock.now(), ...HUMAN_WEBUI);
  recordDeclaredRepo(db, task.id, workspace);
  if (pr !== undefined) recordPrOpenedOutsideConvergence(db, task, pr, clock.now(), { authority: { merge: "escalate" }, workspace });
  return { workspace, db, clock, landing, task };
}

function stackFailures(db: Db, clock: FakeClock, task: Task) {
  registerPrPromotionFailureQuestion(db, task, "first failed attempt", clock.now());
  registerPrPromotionFailureQuestion(db, task, "second failed attempt", clock.now());
  return promotionFailures(db, task.id);
}

it.each([
  ["nothing_to_land", undefined],
  ["landing_finished", 1],
] as const)("兄弟の失敗 question を閉じられなければ %s も刻まれず、次の収束が通り直して両方を書く", async (kind, pr) => {
  const { workspace, db, clock, landing, task } = await purelyLocalRoot(`landing-${kind}-rollback`, pr);
  git(workspace.path, "branch", `task/${task.id}`);
  finish(db, clock, task);
  const failures = stackFailures(db, clock, task);
  const repair = failEventInsert(db, "pr_promotion_observed");

  await convergeOn(landing, task.id, failures[0]!.id);
  expect({ recorded: listEvents(db, task.id).filter((e) => e.kind === kind).length, sibling: getTask(db, failures[1]!.id)!.status }).toEqual({ recorded: 0, sibling: "todo" });

  repair();
  await expect(convergeOn(landing, task.id, failures[0]!.id)).resolves.toMatchObject({ kind: "nothing_to_land" });
  expect({ recorded: listEvents(db, task.id).filter((e) => e.kind === kind).length, sibling: getTask(db, failures[1]!.id)!.status }).toEqual({ recorded: 1, sibling: "done" });
});

it("兄弟の失敗 question を閉じられなければ local merge question も立たず、次の収束が通り直して両方を書く", async () => {
  const { workspace, db, clock, landing, task } = await purelyLocalRoot("landing-local-merge-question-rollback");
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  const failures = stackFailures(db, clock, task);
  const localMergeQuestions = () => listBoard(db).filter((q) => q.question_pending_local_merge_task_id === task.id).length;
  const repair = failEventInsert(db, "pr_promotion_observed");

  await convergeOn(landing, task.id, failures[0]!.id);
  expect({ asked: localMergeQuestions(), sibling: getTask(db, failures[1]!.id)!.status }).toEqual({ asked: 0, sibling: "todo" });

  repair();
  await expect(convergeOn(landing, task.id, failures[0]!.id)).resolves.toEqual({ kind: "landed", form: "local_merge_question" });
  expect({ asked: localMergeQuestions(), sibling: getTask(db, failures[1]!.id)!.status }).toEqual({ asked: 1, sibling: "done" });
});

it("squash 済みで内容差が無い work は commit 差が残っていても着地しない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-squashed");
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
  checkoutTaskBranch(db, workspace, task.id);
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
  const { workspace } = await makeLandingWorkspace("landing-deferred");
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
  checkoutTaskBranch(db, workspace, task.id);
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
  checkoutTaskBranch(db, workspace, task.id);
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

// ADR 0370 決定1: 偽造は解放を待たず、着地の比較が捕まえる
it("またいだセッションが偽造した remote ref は、purely-local の着地の比較が動いた ref として quarantine する", async () => {
  const workspace = await makeWorkspace("landing-local-straddle");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: null });
  const task = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  const remoteTaskRef = `refs/remotes/head-repo/task/${task.id}`;

  await straddle(
    db,
    clock,
    workspace,
    () => expect(convergeOn(landing, task.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(remoteTaskRef) }),
    remoteTaskRef,
  );

  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(remoteTaskRef);
});

it("GitHub の無い remote-backed work は閉じた理由で失敗し failure question を立てる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-no-github");
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
  checkoutTaskBranch(db, workspace, task.id);
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
  const { workspace } = await makeLandingWorkspace("landing-pr");
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
  checkoutTaskBranch(db, workspace, task.id);
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
  const { workspace } = await makeLandingWorkspace("landing-open-pr");
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
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  await commitThroughTaskCheckout(db, clock, workspace, task, "repair.txt", "fixed\n");

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "landed",
    form: "open_pull_request_updated",
    prNumber: 1,
  });
  expect(github.requests).toHaveLength(1);
  expect(github.pushes).toEqual([{ path: workspace.path, branch: `task/${task.id}` }]);
});

// ADR 0378 決定8: the destination check raises Quarantine even when a tick ignores a failed PR read.
it.each(["rewritten", "removed"] as const)("quarantines a workspace when its open PR's repo declaration is %s", async (drift) => {
  const { workspace } = await makeLandingWorkspace("landing-repo-drift");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  let current = workspace;
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: () => current, github, isProtectedWorkspace: () => drift === "rewritten", resolveAuthority: () => profile("auto_if_ci_green") });
  const task = landingWork(db, clock);
  await completeThroughTaskCheckout(db, clock, workspace, task, "feature.txt", "ready\n");
  await expect(convergeOn(landing, task.id)).resolves.toMatchObject({ form: "pull_request_opened" });
  await commitThroughTaskCheckout(db, clock, workspace, task, "repair.txt", "fixed\n");

  const readState = vi.spyOn(github, "getPullRequestState").mockRejectedValue(new Error("unreachable"));
  const readCi = vi.spyOn(github, "readPullRequest");
  const preparePush = vi.spyOn(github, "preparePush");
  const newRepo = "https://github.com/other/project.git";
  current = { ...workspace, repo: drift === "rewritten" ? "https://dummy-user:dummy-password@github.com/other/project.git?token=dummy-token" : undefined };
  const converge = () => expect(convergeOn(landing, task.id)).resolves.toMatchObject({ kind: "quarantined" });
  // The outside-merge tick normally ignores an unreadable PR. The destination refusal must still raise Quarantine.
  if (drift === "rewritten") await landing.tick("outside_merge");
  else await converge();

  const question = quarantineQuestion(db, "workspace", workspace.name);
  const summary = drift === "rewritten"
    ? `its registry entry now says ${newRepo}. Put \`repo:\` back and answer. To move the workspace to another repository, delete it afterwards and register it again.`
    : "its registry entry no longer declares one. Put `repo:` back and answer.";
  expect(question?.purpose).toContain(`workspace ${workspace.name} was registered for repo ${workspace.repo}, but ${summary}`);
  expect(question?.purpose).not.toMatch(/dummy-user|dummy-password|dummy-token/);
  await converge();
  await landing.tick(drift === "rewritten" ? "outside_merge" : "auto_merge");

  expect(readState).not.toHaveBeenCalled();
  expect(readCi).not.toHaveBeenCalled();
  expect(preparePush).not.toHaveBeenCalled();
  expect(github.requests).toHaveLength(1);
  expect(listBoard(db).filter((row) => row.question_quarantine_kind === "workspace")).toHaveLength(1);
  expect(listBoard(db).some((row) => row.question_pending_local_merge_task_id === task.id)).toBe(false);
});

it("checks the repo before convergence can mistake a descendant's open PR for work that still returns to its ancestor", async () => {
  const { workspace } = await makeLandingWorkspace("landing-repo-drift-descendant");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  let current = workspace;
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: () => current, github });
  const parent = landingWork(db, clock);
  await completeThroughTaskCheckout(db, clock, workspace, parent, "parent.txt", "parent result\n");
  await expect(convergeOn(landing, parent.id)).resolves.toMatchObject({ form: "pull_request_opened" });
  const child = attachUnsettledChild(db, clock, parent.id);
  await commitThroughTaskCheckout(db, clock, workspace, child, "child.txt", "child result\n");
  finish(db, clock, child);
  // Refresh sees the published parent result while the checkout's local main is still behind.
  await squashTaskIntoOrigin(workspace, parent.id);
  await refreshProtectedBranch(db, workspace, undefined, () => clock.now());
  await expect(convergeOn(landing, child.id)).resolves.toMatchObject({ form: "pull_request_opened" });
  expect(github.stateChecks).toEqual([]);

  current = { ...workspace, repo: undefined };

  await expect(convergeOn(landing, child.id)).resolves.toMatchObject({ kind: "quarantined" });
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain("its registry entry no longer declares one");
  expect(github.stateChecks).toEqual([]);
  expect(github.requests).toHaveLength(2);
});

it("open PR への push をまたぐ session は盤面の push を違反に数えず、名前の場所の帯域外の tag は収束の比較が名指して止め、worker の task の checkout の tag は読まない(ADR 0356 決定4 / ADR 0370 決定1)", async () => {
  const { workspace } = await makeLandingWorkspace("landing-announce-fold");
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
  checkoutTaskBranch(db, workspace, task.id);
  const head = pushPrHead(github, workspace, task.id, 1);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  finish(db, clock, task);
  recordPrOpenedOutsideConvergence(db, task, 1, clock.now(), { head, workspace });

  // push をまたいで走る別タスクのセッションは、盤面の push を違反に数えない
  await straddle(db, clock, workspace, () => landing.converge());
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();

  // 旧: worker が共有の checkout に作った tag を解放の比較が名指した。ADR 0356 決定4 の後、worker の tag は task の checkout に
  // 留まって読まれず、名前の場所で ref を動かせるのは盤面の外の書き手だけ
  const place = await prepareAtPickup(db, workspace, task);
  commitWork(place.path, "repair.txt", "fixed\n");
  git(place.path, "tag", "worker-created-tag");
  git(workspace.path, "tag", "out-of-band-tag");
  // 修理の tip は盤面が口を通して名前の場所へ引く(完了の門の前半と同じ手、ADR 0356 決定3)
  recordTaskCheckoutTip(db, place, task.id);

  // ADR 0370 決定1: 名前の場所の帯域外の tag は、解放を待たず収束の比較が止める
  await expect(convergeOn(landing, task.id)).resolves.toMatchObject({ kind: "quarantined" });
  releaseWorkspace(db, place, task, clock.now());

  const quarantine = quarantineQuestion(db, "workspace", workspace.name);
  expect(quarantine?.purpose).toContain("refs/tags/out-of-band-tag");
  expect(quarantine?.purpose).not.toContain("refs/tags/worker-created-tag");
});

it("merge 済み PR に残った修理は閉じた理由で失敗し failure question を立てる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-merged-pr");
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
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  await commitThroughTaskCheckout(db, clock, workspace, task, "repair.txt", "fixed\n");
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

// ADR 0265 決定5: 収束の PR の状態の読み取りも、merge した名義で執行と観測を分ける
it.each([
  ["盤面の名義", "pr_merged", (github: FakeGitHubClient) => github.scriptMergedByBoard(1)],
  ["人間の名義", "pr_merge_observed", (github: FakeGitHubClient) => github.scriptMergedOutside(1)],
] as const)("%sで merge 済みの PR を収束が読むと、根に %s を1件だけ刻む", async (_, kind, scriptMerged) => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-converge-merged-by");
  await commitThroughTaskCheckout(db, clock, workspace, root, "repair.txt", "fixed\n");
  scriptMerged(github);

  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ reason: "pull_request_already_merged" });
  const merges = listEvents(db, root.id).filter((e) => e.kind === "pr_merged" || e.kind === "pr_merge_observed");
  expect(merges.map((e) => e.payload)).toEqual([{ kind, pr_number: 1 }]);
});

// ADR 0241 決定3: 盤面の外で閉じられた PR には push せず、閉じたことを観測として刻む(#1734)
it("盤面の外で閉じた PR を持つ根の収束は push せず、閉じた観測を1件だけ刻み、着地したと返さず失敗 question も立てない。次の回からは候補に入らず、retry は閉じたことを理由に拒まれる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-closed-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  await commitThroughTaskCheckout(db, clock, workspace, task, "repair.txt", "fixed\n");
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
  const { workspace } = await makeLandingWorkspace("landing-closed-queued-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1, workspace);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptClosedOutside(1);
  const landing = autoMerging(db, clock, workspace, github);

  completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  settleReviews(db, clock.now());

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ reason: "pull_request_closed" });
  await landing.tick("auto_merge");

  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
});

it("執行側が印を取っている閉じた PR は、収束が観測を刻まず、印を放した後の tick が1件だけ刻む", async () => {
  const { workspace } = await makeLandingWorkspace("landing-closed-marked-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1, workspace);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  github.scriptClosedOutside(1);
  const landing = autoMerging(db, clock, workspace, github);
  completeTask(db, work, FULL_HANDOFF, "tako", clock.now(), "worker");
  settleReviews(db, clock.now());
  const release = landing.takeInFlightMark(work.id)!;

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ reason: "pull_request_closed" });
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual([]);

  release();
  await landing.tick("auto_merge");
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
});

/** 開いている PR を持つ根。fake の push は転送の**後**に失敗する —— 写しは動いたのに失敗と報告される形。 */
async function openPrWhosePushFailsAfterTransfer(name: string) {
  const { workspace } = await makeLandingWorkspace(name);
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
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const head = pushPrHead(github, workspace, task.id, 1);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, task);
  recordPrOpenedOutsideConvergence(db, task, 1, clock.now(), { head, workspace });
  const pushFailed = () =>
    expect(convergeOn(landing, task.id)).resolves.toEqual({
      kind: "failed",
      reason: "promotion_failed",
      error: "push rejected",
    });
  return { workspace, db, clock, github, task, pushFailed, remoteTaskRef: `refs/remotes/head-repo/task/${task.id}` };
}

// ADR 0243 決定2: 畳みは ref を読み返した2択なので、失敗の報告のされ方に依らず、転送が済んでいれば押した値に畳む
it("転送の後に失敗と報告された open PR branch の push は failure question を立て、またいだセッションを quarantine しない", async () => {
  const { workspace, db, clock, task, pushFailed } = await openPrWhosePushFailsAfterTransfer("landing-push-failure");

  await straddle(db, clock, workspace, pushFailed);

  expect(latestEventOfTask(db, task.id, "pr_branch_pushed")?.payload).toEqual({
    kind: "pr_branch_pushed", pr_number: 1, sha: git(workspace.path, "rev-parse", `task/${task.id}`),
  });
  expect(git(workspace.repo!, "for-each-ref", "refs/heads/task/")).toBe("");
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

// ADR 0334 決定1・4: 着地の push は同期のまま(ADR 0243)無音で投げ、口は実 ref を読んで基準を畳む
it("出元 repo が返らない push は何秒の無音で切れたかを書いて投げ、基準は予告の前の値に畳まれる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-push-hangs");
  const { db, clock } = await openBoard();
  const ref = "refs/remotes/head-repo/task/pushed";
  git(workspace.path, "branch", "task/pushed");
  const pushed = git(workspace.path, "rev-parse", "task/pushed");
  const elsewhere = git(workspace.path, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "elsewhere");
  // 返らない origin: hook は自分の pid を残して眠る —— 投げた後に殺し、test の後始末まで生き残らせない
  const hookPid = join(workspace.head_repo!, "hook.pid");
  const remote = await startGitHttpRemote(workspace.head_repo!, "stall-push");
  const client = new GhCliClient(new GitHubAuth(join(workspace.path, "no-token")), { timeoutMs: 1000 });

  await straddle(db, clock, workspace, async () => {
    const push = await client.preparePush({ workspace: { ...workspace, head_repo: remote }, branch: "task/pushed", expected: "" });
    expect(() => boardRefWriter(db, workspace)(ref, pushed, () => push(pushed))).toThrow(/^`git push` stalled: no bytes for 1 s/);
    process.kill(Number(readFileSync(hookPid, "utf8")), "SIGKILL");
    // 畳みの後に写しが3つ目の値へ動く —— 予告の行が2値のまま残っていれば `was: |<押した値>` が載る
    git(workspace.path, "update-ref", ref, elsewhere);
  });

  const purpose = quarantineQuestion(db, "workspace", workspace.name)?.purpose;
  expect(purpose).toContain(`now: ${elsewhere} ${ref}`);
  expect(purpose).not.toContain("was:");
});

// ADR 0243 決定1・5 / #1846: 盤面が予告した後・畳む前に落ちる(kill -9 でも子の push は完走する)。走っていた
// セッションの解放は、残った2値の行のどちらの値も違反と読まず、3つ目の値だけを違反と読む
it.each<[string, boolean, (path: string, ref: string, announced: string, elsewhere: string) => void]>([
  ["予告した値へ動いた", false, (path, ref, announced) => git(path, "update-ref", ref, announced)],
  ["予告の前の値(無い)のまま", false, () => {}],
  ["どちらでもない値へ動いた", true, (path, ref, _announced, elsewhere) => git(path, "update-ref", ref, elsewhere)],
])("予告だけを残して盤面が落ち、ref が%s解放は quarantine=%s", async (_, quarantined, move) => {
  const { workspace } = await makeLandingWorkspace("landing-crash-after-announce");
  const { db, clock } = await openBoard();
  const ref = "refs/remotes/head-repo/task/pushed-by-the-board";
  const announced = git(workspace.path, "rev-parse", "HEAD");
  const elsewhere = git(workspace.path, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "elsewhere");
  const running = landingWork(db, clock);
  const place = await prepareAtPickup(db, workspace, running);

  // 落ちた盤面: 予告は書かれ、書き込みは返らず、畳みは来ない
  announceThenCrash(db, workspace, ref, announced);
  move(workspace.path, ref, announced, elsewhere);
  commitWork(place.path, "running.txt", "work\n");
  releaseWorkspace(db, place, running, clock.now());

  const question = quarantineQuestion(db, "workspace", workspace.name);
  expect(question !== undefined).toBe(quarantined);
  // 動いた ref は2値の行のまま名指しされる(ADR 0243 / spec #1870)
  if (quarantined) expect(question?.purpose).toContain(`was: |${announced} ${ref}`);
});

// 畳みの失敗が書き込みの失敗を置き換えれば、人間に届く理由が git の理由ではなくなる
it("書き込みが投げた後に畳みも落ちれば、口は書き込みの失敗のほうを投げる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-fold-fails");
  const { db, clock } = await openBoard();
  await prepareAtPickup(db, workspace, landingWork(db, clock));
  const write = () => {
    db.exec("CREATE TEMP TRIGGER fold_fails BEFORE UPDATE ON workspace_state BEGIN SELECT RAISE(ABORT, 'fold failed'); END");
    throw new Error("push rejected");
  };

  expect(() => writeBoardRefs(db, workspace, [["refs/remotes/head-repo/task/x", git(workspace.path, "rev-parse", "HEAD")]], write)).toThrow(
    "push rejected",
  );
});

// ADR 0243 決定3: 写しを進める fetch は原本の sha を先に知ってから予告し、その sha だけを取って写しを書く
it("収束前の保護ブランチの fetch は写しを原本の sha へ進め、基準をその1値に畳み、refs/ に写し以外の差を残さない", async () => {
  const { workspace, publish } = await makeLandingWorkspace("landing-split-fetch");
  const { db, clock } = await openBoard();
  const running = landingWork(db, clock);
  const place = await prepareAtPickup(db, workspace, running);
  publish("merged.txt", "merged on GitHub\n", "merged outside");
  const copy = "refs/remotes/origin/main";
  const pickedUp = git(workspace.path, "rev-parse", copy);
  const refsBesidesCopy = () => git(workspace.path, "for-each-ref", "--format=%(objectname) %(refname)").split("\n").filter((line) => !line.endsWith(` ${copy}`));
  const before = refsBesidesCopy();

  await refreshProtectedBranch(db, workspace, undefined, () => clock.now());

  const original = git(workspace.path, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
  expect(git(workspace.path, "rev-parse", copy)).toBe(original);
  expect(refsBesidesCopy()).toEqual(before);
  // 原本の1値に畳まれている —— 2値の行のまま残れば、pickup の値へ戻った写しを解放が通してしまう
  git(workspace.path, "update-ref", copy, pickedUp);
  commitWork(place.path, "running.txt", "work\n");
  releaseWorkspace(db, place, running, clock.now());
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(`was: ${original} ${copy}`);
});

it("PR 作成の失敗は閉じた理由で返して failure question を立てる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-pr-failure");
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
  checkoutTaskBranch(db, workspace, task.id);
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

// ADR 0241 決定4: PR は作る前に、同じタスクブランチの PR を探す。ADR 0376 決定1〜3: 見つけた PR の head は探す読みが返す —— 盤面が最後に
// push した値(写し)のままなら、その上に今のタスクブランチを押す
it("GitHub に同じ head の開いた PR がある根の着地は PR を作らず、その head が盤面の push した値のままなら落ちた後に帰った修理ごと押し、番号を記録して merge question を開く", async () => {
  const { workspace } = await makeLandingWorkspace("landing-find-open-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  // 盤面が push して PR を作り、番号を記録する前に落ちた
  git(workspace.path, "push", "head-repo", `task/${work.id}`);
  const existing = github.scriptPullRequestOnBranch(`task/${work.id}`);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "landed", form: "pull_request_opened", prNumber: existing });
  expect(github.requests).toEqual([]);
  expect(getTask(db, work.id)?.pr_number).toBe(existing);
  expect(mergeQuestions(db).map(({ pr }) => pr)).toEqual([existing]);
  // 作ったときと同じく、タスクブランチの今の内容を押してから記録する —— 落ちた後に帰った修理も PR に載る
  expect(github.pushes.map(({ branch }) => branch)).toEqual([`task/${work.id}`]);
  expect(git(workspace.path, "rev-parse", `head-repo/task/${work.id}`)).toBe(git(workspace.path, "rev-parse", "HEAD"));
  expect(forkHead(workspace, work.id)).toBe(git(workspace.path, "rev-parse", "HEAD"));
});

it("retry rediscovers the fork PR after its creation response is lost", async () => {
  const { workspace } = await makeLandingWorkspace("landing-find-unrecorded-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);

  const create = github.createPullRequest.bind(github);
  vi.spyOn(github, "createPullRequest").mockImplementationOnce(async (input) => {
    await create(input);
    throw new Error("the creation response was lost");
  });
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed" });
  const [failure] = promotionFailures(db, work.id);

  await expect(answerPromotion(db, clock, landing, workspace, failure!, "retry")).resolves.toMatchObject({ status: "done" });
  expect(github.requests).toHaveLength(1);
  expect(getTask(db, work.id)?.pr_number).toBe(1);
  expect(git(workspace.repo!, "for-each-ref", "refs/heads/task/")).toBe("");
});

it("GitHub に同じ head の merge 済み PR がある根の着地は、番号と merge の観測を刻み、失敗 question を1枚立てる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-find-merged-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const merged = github.scriptPullRequestOnBranch(`task/${work.id}`);
  github.scriptMergedOutside(merged);
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "pull_request_already_merged" });
  expect(github.requests).toEqual([]);
  expect(getTask(db, work.id)?.pr_number).toBe(merged);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merge_observed", pr_number: merged } },
  ]);
  expect(promotionFailures(db, work.id)).toHaveLength(1);
});

it("GitHub に同じ head の閉じた PR がある根の着地は、番号と閉じた観測を刻み、PR を作らず失敗 question も立てない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-find-closed-pr");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
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
  const { workspace } = await makeLandingWorkspace("landing-find-failure");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptFindFailure(new Error("gh pr list failed"));
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
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
  const { workspace } = await makeLandingWorkspace("landing-registry-drift");
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
  checkoutTaskBranch(db, workspace, task.id);
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
  checkoutTaskBranch(db, workspace, task.id);
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
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  finish(db, clock, task);
  // 基準の行が無ければ、この名前の Quarantine の間は最初の撮りを待つ(ADR 0373 決定13 追記)
  await leaveBaseline(db, workspace);
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
  seedTaskBranch(db, workspace, root.id);
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
  checkoutTaskBranch(db, workspace, task.id);
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
  const { workspace } = await makeLandingWorkspace("landing-retirement");
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
  checkoutTaskBranch(db, workspace, task.id);
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
  const { workspace } = await makeLandingWorkspace("landing-retry-nothing");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptFailure(new Error("token expired"));
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const task = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, task.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  await landing.converge();
  registerPrPromotionFailureQuestion(db, task, "token expired", clock.now());
  const failures = promotionFailures(db, task.id);
  github.scriptFailure(null);
  // 内容は盤面の外で保護ブランチに届き、盤面の fetch が写しを進める
  await squashTaskIntoOrigin(workspace, task.id);
  await refreshProtectedBranch(db, workspace, undefined, () => clock.now());

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
  checkoutTaskBranch(db, workspace, task.id);
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
  const { workspace } = await makeLandingWorkspace("landing-ancestors");
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
  seedTaskBranch(db, workspace, root.id);
  completeTask(db, getTask(db, root.id)!, FULL_HANDOFF, "worker", clock.now(), "worker");
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
  checkoutTaskBranch(db, workspace, parent.id, "main");
  commitWork(workspace.path, "feature.txt", "ready\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now(), "worker");
  recordPrOpenedOutsideConvergence(db, parent, 1, clock.now(), { head: pushPrHead(github, workspace, parent.id, 1), workspace });
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

  completeTask(db, settled, { outcome: "no findings" }, "worker", clock.now(), "worker");

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
  const { workspace } = await makeLandingWorkspace("landing-lane");
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
  checkoutTaskBranch(db, workspace, first.id);
  commitWork(workspace.path, "feature.txt", "first\n");
  finish(db, clock, first);
  // もう1つの根の内容は最初の回より前に置く —— 回の途中に名前の場所へ手で書くと、基準の後の帯域外の移動になる(ADR 0370 決定1)
  const second = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, second.id, "main");
  commitWork(workspace.path, "second.txt", "second\n");

  const running = landing.converge();
  await window.entered;
  // 回の途中で、もう1つの根が完了し、突きが3回届く
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

it("回が走っていないときの stop は待たずに解ける", async () => {
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, github: null });

  let stopped = false;
  void landing.stop().then(() => {
    stopped = true;
  });
  await settle();
  expect(stopped).toBe(true);
});

it("stop の後の収束は回を始めず空を返す", async () => {
  const { db, clock } = await openBoard();
  const pickupIdle = vi.fn(async () => {});
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, github, pickupIdle });

  await landing.stop();
  await expect(landing.converge()).resolves.toEqual([]);
  expect(pickupIdle).not.toHaveBeenCalled();
  expect(github.requests).toEqual([]);
});

it("stop の時点で走っている回と列に入った回は走り切り、stop はその後に解ける", async () => {
  const { workspace } = await makeLandingWorkspace("landing-stop-drains");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const window = awaitWindow();
  const create = github.createPullRequest.bind(github);
  github.createPullRequest = async (input) => {
    await window.hold();
    return create(input);
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const root = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, root.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, root);

  const running = landing.converge();
  await window.entered;
  const queued = landing.converge();
  let stopped = false;
  const stopping = landing.stop().then(() => {
    stopped = true;
  });
  await settle();
  expect(stopped).toBe(false);

  window.open();
  await expect(running).resolves.toEqual([
    { taskId: root.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 1 } },
  ]);
  await expect(queued).resolves.toEqual([{ taskId: root.id, verdict: { kind: "up_to_date", prNumber: 1 } }]);
  await stopping;
});

it("stop は待っている回の失敗で reject しない", async () => {
  const { db, clock } = await openBoard();
  const window = awaitWindow();
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    github: null,
    pickupIdle: async () => {
      await window.hold();
      throw new Error("idle failed");
    },
  });

  const run = landing.converge();
  await window.entered;
  const stopping = landing.stop();
  window.open();
  await expect(run).rejects.toThrow("idle failed");
  await expect(stopping).resolves.toBeUndefined();
});

// #2400: 回の失敗はその回の呼び手(束ねられた呼び手も)だけが受け取る —— 列は rejection を以後の突きに持ち越さない
it("pickupIdle が一度 reject した回の後でも、次の収束は新しい回として pickupIdle を待ってから走る", async () => {
  const { db, clock } = await openBoard();
  const pickupIdle = vi.fn().mockRejectedValueOnce(new Error("idle failed")).mockResolvedValue(undefined);
  const landing = createLanding({ defaultAgentName: "tako", db, clock, github: null, pickupIdle });

  await expect(landing.converge()).rejects.toThrow("idle failed");
  await expect(landing.converge()).resolves.toEqual([]);
  expect(pickupIdle).toHaveBeenCalledTimes(2);
});

it("retry の回が答えている question を読めずに reject しても、束ねられた呼び手も同じ理由を受け取り、次の収束は走る", async () => {
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, github: null });
  const prepare = db.prepare.bind(db);
  let thrown = false;
  vi.spyOn(db, "prepare").mockImplementation((sql) => {
    if (!thrown && sql.startsWith("SELECT *, ") && sql.endsWith("FROM tasks WHERE id = ?")) {
      thrown = true;
      throw new Error("database is locked");
    }
    return prepare(sql);
  });

  const retry = landing.converge({ answering: { question: "question-1", answerer: HUMAN_ANSWERER } });
  const bundled = landing.converge();
  await expect(retry).rejects.toThrow("database is locked");
  await expect(bundled).rejects.toThrow("database is locked");
  await expect(landing.converge()).resolves.toEqual([]);
});

it("人間が担当して完了した work は根にならず、何も撃たれない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-human-work");
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
  const { workspace } = await makeLandingWorkspace("landing-teardown-unfinished");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const root = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, root.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, root);
  const repair = finish(db, clock, attachUnsettledChild(db, clock, root.id));
  markTeardown(db, repair.id, clock.now());

  await expect(landing.converge()).resolves.toEqual([]);
  expect(github.requests).toEqual([]);
});

function boardMerged(db: Db, clock: FakeClock, taskId: string, prNumber: number) {
  appendEvent(db, { taskId, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merged", pr_number: prNumber }, at: clock.now() });
}

it("merge 済みの PR の根に運ぶ内容が無ければ着地が終わった事実を1回刻み、次の回からは git も読まない", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-merged-finished");
  await squashTaskIntoOrigin(workspace, root.id);
  await refreshProtectedBranch(db, workspace, undefined, () => clock.now());
  boardMerged(db, clock, root.id, 1);

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "nothing_to_land", base: "refs/remotes/origin/main" });
  expect(boardEvents(db, root.id, "landing_finished")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "landing_finished", pr_number: 1, basis: "merge" } },
  ]);

  // 読めば壊れていると分かる checkout でも、終わった根は読まれない
  git(workspace.path, "checkout", "main");
  git(workspace.path, "branch", "-D", `task/${root.id}`);
  await expect(landing.converge()).resolves.toEqual([]);
  expect(promotionFailures(db, root.id)).toEqual([]);
  expect(boardEvents(db, root.id, "landing_finished")).toHaveLength(1);
  expect(github.stateChecks).toEqual([]);
});

// ADR 0265 決定3: `external` の根は内容で終わる —— GitHub を読まず、merge の記録が無くても1回で候補を外れる(#1849)
it("external の根の PR が外で squash merge されれば、収束の1回目が根拠 content の着地の終わりを1件刻み、2回目はその根の git を読まない", async () => {
  const { workspace, db, clock, github, landing, work } = await openPushedPr("landing-external-content-finished", "external");
  finish(db, clock, work);
  await squashTaskIntoOrigin(workspace, work.id);
  git(workspace.path, "fetch", "origin", "main");

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "nothing_to_land", base: "refs/remotes/origin/main" });
  expect(boardEvents(db, work.id, "landing_finished")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "landing_finished", pr_number: 1, basis: "content" } },
  ]);

  // 読めば壊れていると分かる checkout でも、終わった根は読まれない
  git(workspace.path, "checkout", "main");
  git(workspace.path, "branch", "-D", `task/${work.id}`);
  await expect(landing.converge()).resolves.toEqual([]);
  expect(promotionFailures(db, work.id)).toEqual([]);
  expect(boardEvents(db, work.id, "landing_finished")).toHaveLength(1);
  expect(boardEvents(db, work.id, "nothing_to_land")).toEqual([]);
  expect(github.stateChecks).toEqual([]);
});

// ADR 0265 決定3 / ADR 0250 決定1: 開いた PR の根の子孫は候補にならず、根が内容で終わった後の修理は自分で根になる
it("external の根の PR が開いている間、根のブランチへ帰る子孫は撃たれず、外で merge された後に完了した修理は根が内容で終わった回に自分で根になって着地する", async () => {
  const { workspace, db, clock, github, landing, work } = await openPushedPr("landing-external-descendant", "external");
  finish(db, clock, work);
  const child = attachUnsettledChild(db, clock, work.id);
  checkoutTaskBranch(db, workspace, child.id);
  commitWork(workspace.path, "child.txt", "merged back\n");
  git(workspace.path, "checkout", `task/${work.id}`);
  git(workspace.path, "merge", "--no-edit", `task/${child.id}`);
  const nested = attachUnsettledChild(db, clock, child.id);
  git(workspace.path, "branch", `task/${nested.id}`, `task/${child.id}`);
  recordDeclaredRepo(db, nested.id, workspace);
  finish(db, clock, nested);
  finish(db, clock, child);
  // 読めば壊れていると分かる checkout でも、PR の開いた根の子孫の lineage は読まれない(記録で外れる)
  git(workspace.path, "branch", "-D", `task/${child.id}`);
  await expect(landing.converge()).resolves.toEqual([
    { taskId: work.id, verdict: { kind: "landed", form: "open_pull_request_updated", prNumber: 1 } },
  ]);
  // 消えた子のブランチは、拾い直しが lineage の帰り先(子の内容を merge 済みの根のブランチ)から盤面の書き込みで作り直す ——
  // 手で書き戻すと基準の後の帯域外の移動になる(ADR 0370 決定1)
  const reopened = await prepareAtPickup(db, workspace, child);
  releaseWorkspace(db, reopened, getTask(db, child.id)!, clock.now());

  await squashTaskIntoOrigin(workspace, work.id);
  await refreshProtectedBranch(db, workspace, undefined, () => clock.now());
  const repair = attachUnsettledChild(db, clock, work.id);
  await completeThroughTaskCheckout(db, clock, workspace, repair, "repair.txt", "after the merge\n");

  // 根へ帰っていた子孫も自分で根になるが、その内容は根の PR と一緒に届いている
  await expect(landing.converge()).resolves.toEqual([
    { taskId: work.id, verdict: { kind: "nothing_to_land", base: "refs/remotes/origin/main" } },
    { taskId: child.id, verdict: { kind: "nothing_to_land", base: "refs/remotes/origin/main" } },
    { taskId: nested.id, verdict: { kind: "nothing_to_land", base: "refs/remotes/origin/main" } },
    { taskId: repair.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 2 } },
  ]);
  expect(boardEvents(db, work.id, "landing_finished").map(({ payload }) => payload)).toEqual([
    { kind: "landing_finished", pr_number: 1, basis: "content" },
  ]);
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${repair.id}`]);
});

// ADR 0265 帰結 / ADR 0240 決定2: 未回答の失敗 question で止まった根は内容の確かめに届かないので、子孫を記録で外さない
it("PR が開いている external の根が未回答の失敗 question で止まっていれば、外で merge された後に完了した修理は自分で根になって着地し、着地を待つ完了タスクに数えられる", async () => {
  const { workspace, db, clock, github, landing, work } = await openPushedPr("landing-external-blocked-root", "external");
  finish(db, clock, work);
  registerPrPromotionFailureQuestion(db, getTask(db, work.id)!, "push failed earlier", clock.now());
  await squashTaskIntoOrigin(workspace, work.id);
  git(workspace.path, "fetch", "origin", "main");
  const repair = attachUnsettledChild(db, clock, work.id);
  checkoutTaskBranch(db, workspace, repair.id, "refs/remotes/origin/main");
  commitWork(workspace.path, "repair.txt", "after the merge\n");
  finish(db, clock, repair);

  expect(taskIdsAwaitingLanding(db, () => workspace, "tako", "tako")).toHaveLength(1);
  await expect(landing.converge()).resolves.toEqual([
    { taskId: repair.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 2 } },
  ]);
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${repair.id}`]);
});

// ADR 0265 帰結 / ADR 0241 決定5: 根の PR が開いている間に子孫の失敗 question へ答えた retry は、待っている根の PR を理由に拒まれる
it("PR が開いている根の子孫の失敗 question に retry を答える回の verdict は、根の PR が着地を終えるのを待つ、である", async () => {
  const { workspace, db, clock, landing, work } = await openPushedPr("landing-retry-under-open-pr", "external");
  finish(db, clock, work);
  const repair = attachUnsettledChild(db, clock, work.id);
  git(workspace.path, "branch", `task/${repair.id}`, `task/${work.id}`);
  finish(db, clock, repair);
  registerPrPromotionFailureQuestion(db, getTask(db, repair.id)!, "push failed earlier", clock.now());
  const [failure] = promotionFailures(db, repair.id);

  await expect(convergeOn(landing, repair.id, failure!.id)).resolves.toEqual({
    kind: "excluded",
    reason: "root_pull_request_open",
    error: `task ${repair.id} waits for its root task ${work.id}'s PR #1 to finish landing; answer again once it has`,
  });
});

// ADR 0265 決定3 / ADR 0236: 内容で終わることは決裁を引退させない —— キューの行と merge question を閉じるのは PR の状態の読み取りだけ
it.each([
  ["auto_if_ci_green", "auto_merge", 0],
  ["escalate", "outside_merge", 1],
] as const)("%s の根が内容で終わっても決裁はそのまま残り、その後の %s の読み取りが外での merge を観測として決着させる", async (dial, tick, openQuestions) => {
  const { workspace, db, clock, github, landing, work } = await openPushedPr(`landing-content-keeps-${dial}`, dial);
  finish(db, clock, work);
  await squashTaskIntoOrigin(workspace, work.id);
  git(workspace.path, "fetch", "origin", "main");
  const openMergeQuestions = () => listBoard(db).filter((q) => q.question_pending_merge_pr === 1 && q.status === "todo");
  expect(openMergeQuestions()).toHaveLength(openQuestions);

  await convergeOn(landing, work.id);
  expect(boardEvents(db, work.id, "landing_finished")).toHaveLength(1);
  expect(autoMergeOutcomeEvents(db, work.id)).toEqual([]);
  expect(openMergeQuestions()).toHaveLength(openQuestions);

  github.scriptMergedOutside(1);
  await landing.tick(tick);
  expect(autoMergeOutcomeEvents(db, work.id)).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merge_observed", pr_number: 1 } },
  ]);
  expect(openMergeQuestions()).toEqual([]);
  expect(boardEvents(db, work.id, "landing_finished")).toHaveLength(1);
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
  await commitThroughTaskCheckout(db, clock, workspace, root, "repair.txt", "merged back after the merge\n");

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
  await refreshProtectedBranch(db, workspace, undefined, () => clock.now());
  boardMerged(db, clock, root.id, 1);
  const repair = attachUnsettledChild(db, clock, root.id);
  await completeThroughTaskCheckout(db, clock, workspace, repair, "repair.txt", "after the merge\n");

  await expect(landing.converge()).resolves.toEqual([
    { taskId: root.id, verdict: { kind: "nothing_to_land", base: "refs/remotes/origin/main" } },
    { taskId: repair.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 2 } },
  ]);
  expect(promotionFailures(db, root.id)).toEqual([]);
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`, `task/${repair.id}`]);
});

it("PR の状態を読んだ後に merge され、その後に push した修理は、merge された head に無いので失敗 question を1回だけ立て、着地が終わったとは刻まない", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-merged-after-read");
  await commitThroughTaskCheckout(db, clock, workspace, root, "repair.txt", "pushed after the merge\n");
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
  recordDeclaredRepo(db, empty.id, workspace);
  finish(db, clock, empty);
  const waiting = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, waiting.id);
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
    await commitThroughTaskCheckout(db, clock, workspace, root, "repair.txt", "a repair the closed PR never gets\n");
    await landing.converge();
  } else {
    registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
    await answerPromotion(db, clock, landing, workspace, promotionFailures(db, root.id)[0]!, "abandon promotion");
  }
  await squashTaskIntoOrigin(workspace, root.id);
  await refreshProtectedBranch(db, workspace, undefined, () => clock.now());
  const child = attachUnsettledChild(db, clock, root.id);
  await completeThroughTaskCheckout(db, clock, workspace, child, "child.txt", "the child's own change\n");

  await expect(convergeOn(landing, child.id)).resolves.toEqual({ kind: "landed", form: "pull_request_opened", prNumber: 2 });
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`, `task/${child.id}`]);
});

it("PR が開いている根の下で完了し、根のブランチへ帰る子孫は撃たれず、根がその内容を push する", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-carried-open");
  const child = attachUnsettledChild(db, clock, root.id);
  await completeThroughTaskCheckout(db, clock, workspace, child, "repair.txt", "merged back\n");

  await expect(landing.converge()).resolves.toEqual([
    { taskId: root.id, verdict: { kind: "landed", form: "open_pull_request_updated", prNumber: 1 } },
  ]);
  expect(github.requests.map(({ branch }) => branch)).toEqual([`task/${root.id}`]);
});

// ADR 0250 決定1 / ADR 0229 決定3: 閉じた根への修理は閉じる判断の内側で、問い返さない
it("閉じた PR の根の内容が保護ブランチに無いまま、根のブランチへ帰って完了した子孫は撃たれず、根にも push せず、question も立たない", async () => {
  const { workspace, db, clock, github, landing, root } = await rootWithOpenedPr("landing-carried-closed-back");
  github.scriptClosedOutside(1);
  await commitThroughTaskCheckout(db, clock, workspace, root, "repair.txt", "a repair the closed PR never gets\n");
  await landing.converge();
  expect(boardEvents(db, root.id, "pr_close_observed")).toHaveLength(1);
  const child = attachUnsettledChild(db, clock, root.id);
  await completeThroughTaskCheckout(db, clock, workspace, child, "child.txt", "merged back\n");

  await expect(landing.converge()).resolves.toEqual([]);
  expect(github.pushes).toEqual([]);
  expect(promotionFailures(db, root.id)).toEqual([]);
});

// #1840 の実装で見つけた3点(#1842 のコメント)
it("断念した根の PR が盤面の外で閉じられたと観測されていれば、内容が変わっても昇格を問い直さない", async () => {
  const { workspace, db, clock, landing, root } = await rootWithOpenedPr("landing-abandoned-then-closed");
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  await answerPromotion(db, clock, landing, workspace, promotionFailures(db, root.id)[0]!, "abandon promotion");
  appendEvent(db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number: 1 }, at: clock.now() });
  commitWork(workspace.path, "repair.txt", "changed after the abandon\n");

  await expect(landing.converge()).resolves.toEqual([]);
  expect(openPromotionQuestions(db, root.id)).toEqual([]);
});

it("閉じた PR を初めて読んだ根は、追いつきの merge をせずにタスクブランチを残す", async () => {
  const { workspace } = await makeLandingWorkspace("landing-closed-no-catch-up");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const parent = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, parent.id);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  finish(db, clock, parent);
  recordPrOpenedOutsideConvergence(db, parent, 1, clock.now(), { workspace });
  const repair = attachUnsettledChild(db, clock, parent.id);
  checkoutTaskBranch(db, workspace, repair.id, `task/${parent.id}`);
  await squashTaskIntoOrigin(workspace, parent.id);
  git(workspace.path, "fetch", "origin", "main");
  boardMerged(db, clock, parent.id, 1);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, repair);
  recordPrOpenedOutsideConvergence(db, repair, 2, clock.now(), { workspace });
  github.scriptClosedOutside(2);
  const before = git(workspace.path, "rev-parse", `task/${repair.id}`);

  await expect(convergeOn(landing, repair.id)).resolves.toMatchObject({ kind: "failed", reason: "pull_request_closed" });
  expect(git(workspace.path, "rev-parse", `task/${repair.id}`)).toBe(before);
  expect(github.pushes).toEqual([]);
});

it("nothing_to_land を刻んだ根の子の修理は根のブランチへ帰らず、自分で根になって着地する", async () => {
  const { workspace } = await makeLandingWorkspace("landing-nothing-then-repair");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const { id } = landingWork(db, clock);
  seedTaskBranch(db, workspace, id, "refs/remotes/origin/main");
  const root = getTask(db, id)!;
  finish(db, clock, root);
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ kind: "nothing_to_land" });
  // 修理を後始末と同じ形で拾い、commit し、完了して merge back する
  const repair = attachUnsettledChild(db, clock, root.id);
  const place = await prepareAtPickup(db, workspace, repair);
  commitWork(place.path, "repair.txt", "repaired after nothing to land\n");
  const done = finish(db, clock, repair);
  releaseWorkspace(db, place, done, clock.now(), true);

  await expect(landing.converge()).resolves.toEqual([
    { taskId: repair.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 1 } },
  ]);
  expect(git(workspace.path, "rev-parse", `task/${root.id}`)).toBe(git(workspace.path, "rev-parse", "refs/remotes/origin/main"));
  expect(boardEvents(db, root.id, "nothing_to_land")).toHaveLength(1);
});

// 根かどうか読めない候補は、黙って飛ばさず、その根の失敗として人間に見せる(着地の module の旧 land() と同じ結果)
it("workspace を解決できない、親を持つ完了 work は、workspace を quarantine に落とし、失敗 question を立てない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-child-unresolvable");
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
  const { workspace } = await makeLandingWorkspace("landing-lineage-unreadable");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  // 完了した親は task_branch_created を持つのにタスクブランチが無いので、子の lineage を解く git が失敗する
  const parent = landingWork(db, clock);
  seedTaskBranch(db, workspace, parent.id);
  git(workspace.path, "branch", "-D", `task/${parent.id}`);
  const child = attachUnsettledChild(db, clock, parent.id);
  git(workspace.path, "branch", `task/${child.id}`);
  finish(db, clock, child);
  finish(db, clock, parent);
  const healthy = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, healthy.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, healthy);

  const verdicts = await landing.converge();

  expect(verdicts.find((root) => root.taskId === child.id)?.verdict).toMatchObject({ kind: "failed", reason: "promotion_failed" });
  expect(verdicts.find((root) => root.taskId === healthy.id)?.verdict).toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(promotionFailures(db, child.id)).toHaveLength(1);
});

// ADR 0241 決定6: lineage が読めない根の失敗 question も、workspace の Quarantine が抱えていれば重ねない
it.each([true, false])("基準の行を持つ workspace で lineage が読めない根は、Quarantine が開いていれば(%s)失敗 question を立てずその Quarantine で止まり、無ければ1つ立てる", async (quarantine) => {
  const { workspace } = await makeLandingWorkspace("landing-lineage-unreadable-quarantined");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: new FakeGitHubClient() });
  const parent = landingWork(db, clock);
  seedTaskBranch(db, workspace, parent.id);
  git(workspace.path, "branch", "-D", `task/${parent.id}`);
  const child = attachUnsettledChild(db, clock, parent.id);
  git(workspace.path, "branch", `task/${child.id}`);
  // 出元 repo の記録を持つ子 —— 記録の比較(ADR 0399 決定3)を通って lineage の失敗に届く
  recordDeclaredRepo(db, child.id, workspace);
  finish(db, clock, child);
  finish(db, clock, parent);
  // 基準の行が無ければ、この名前の Quarantine の間は最初の撮りを待つ(ADR 0373 決定13 追記)
  await leaveBaseline(db, workspace);
  if (quarantine) quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());

  const verdict = await convergeOn(landing, child.id);

  if (quarantine) {
    expect(verdict).toEqual({
      kind: "quarantined",
      error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
    });
    expect(promotionFailures(db, child.id)).toEqual([]);
  } else {
    expect(verdict).toMatchObject({ kind: "failed", reason: "promotion_failed" });
    expect(promotionFailures(db, child.id)).toHaveLength(1);
  }
});

// ADR 0241 決定3 / GLOSSARY.md「収束」: lineage が読めない根も、門が閉じていれば失敗を見せる前に待つ —— Quarantine より先に
it.each([false, true])("lineage が読めない根は、自身の門が閉じていれば Quarantine が開いていても(%s)失敗 question を立てず deferred を返し、landing_deferred を1つ刻む", async (quarantine) => {
  const { workspace } = await makeLandingWorkspace("landing-lineage-unreadable-gated");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: new FakeGitHubClient() });
  const parent = landingWork(db, clock);
  seedTaskBranch(db, workspace, parent.id);
  git(workspace.path, "branch", "-D", `task/${parent.id}`);
  const child = attachUnsettledChild(db, clock, parent.id);
  git(workspace.path, "branch", `task/${child.id}`);
  // 出元 repo の記録を持つ子 —— 記録の比較(ADR 0399 決定3)を通って lineage の失敗に届く
  recordDeclaredRepo(db, child.id, workspace);
  finish(db, clock, child);
  finish(db, clock, parent);
  // 門は lineage が読めない根そのものに閉じる —— 門はその根の分解ツリーを数えるので、親の門を閉じてもこの根の門は閉じない
  attachUnsettledChild(db, clock, child.id);
  // 基準の行が無ければ、この名前の Quarantine の間は最初の撮りを待つ(ADR 0373 決定13 追記)
  await leaveBaseline(db, workspace);
  if (quarantine) quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());

  await expect(convergeOn(landing, child.id)).resolves.toEqual({ kind: "deferred", reason: "attached_children", count: 1 });
  expect(promotionFailures(db, child.id)).toEqual([]);
  expect(boardEvents(db, child.id, "landing_deferred")).toHaveLength(1);
});

it("完了した親のタスクブランチが失われて死んでいれば、子は帰り先なしで着地の根にならず失敗 question も立たず、他の根は着地する(ADR 0380 決定3)", async () => {
  const { workspace } = await makeLandingWorkspace("landing-lineage-lost-parent");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  // 完了した親のタスクブランチは give-up で失われ、作成時と違う sha を失った(死んだ)—— 子の系譜はその ref を git で読まない
  const parent = landingWork(db, clock);
  seedTaskBranch(db, workspace, parent.id);
  const child = attachUnsettledChild(db, clock, parent.id);
  git(workspace.path, "branch", `task/${child.id}`);
  finish(db, clock, child);
  // 完了の後に失う —— 死んだ task の下には完了時レビューも立たない(ADR 0380 決定2)
  finish(db, clock, parent);
  const lostEdit = git(workspace.path, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "the parent's lost edit");
  git(workspace.path, "branch", "-D", `task/${parent.id}`);
  appendEvent(db, { taskId: parent.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_branch_lost", sha: lostEdit }, at: clock.now() });
  const healthy = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, healthy.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, healthy);

  const verdicts = await landing.converge();

  expect(verdicts.find((root) => root.taskId === child.id)).toBeUndefined();
  expect(verdicts.find((root) => root.taskId === healthy.id)?.verdict).toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(promotionFailures(db, child.id)).toEqual([]);
});
