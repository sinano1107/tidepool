
import { existsSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, latestEventOfTask, listEvents, listEventsOfKinds } from "../src/events.js";
import type { PreparePushInput } from "../src/github.js";
import { submitAnswer } from "../src/human-verbs.js";
import {
  createLanding,
  landingAnnotation,
  registerPrPromotionFailureQuestion,
  settledByObservation,
} from "../src/landing.js";
import { type AuthorityProfile, type MergeDial, } from "../src/registry.js";
import {
  completeTask,
  editTask,
  getTask,
  listBoard,
  recordPrOpened,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { markTeardown } from "../src/teardown.js";
import { workbenchPath } from "../src/workbench.js";
import {
  recordDeclaredRepo,
  workspaceProtectionReader,
} from "../src/workspace.js";
import { afterCiRead, awaitWindow, FakeGitHubClient, UNRESOLVABLE_AGENT, unusedLanding } from "./fakes.js";
import {
  checkoutTaskBranch,
  commitWork,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  leaveBaseline,
  makeLandingWorkspace,
  makeWorkspace,
  quarantineQuestion,
  squashTaskIntoOrigin,
} from "./harness.js";
import {
  afterEachPush,
  answerHoldOnPr,
  answerMergeQuestion,
  answerPromotion,
  attachUnsettledChild,
  autoMergeOutcomeEvents,
  autoMerging,
  boardEvents,
  CI_RED_PURPOSE,
  CONFLICT,
  catchUpConflictRoot,
  closeObserved,
  commitThroughTaskCheckout,
  convergeOn,
  droppedRepair,
  finish,
  forkHead,
  landingWork,
  mergeQuestion,
  mergeQuestions,
  openBoard,
  openPrMergeQuestion,
  outsideClone,
  profile,
  promotionFailures,
  pushedRoot,
  pushOutsideBoard,
  queueAutoMerge,
  raiseUnbundledObjection,
  readOnNextTick,
  recordPrOpenedOutsideConvergence,
  recordPushedHeadRepo,
  rootWithOpenedPr,
  settleRepairNotMergedBack,
  straddle,
  tearDownRepair,
  textA4a,
  textA4c,
} from "./landing-fixture.js";
import { makeRegistry } from "./registry-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

it("回の途中で後始末に入った木の根は、その回でも撃たれない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-teardown-mid-pass");
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
  checkoutTaskBranch(db, workspace, first.id);
  commitWork(workspace.path, "first.txt", "first\n");
  finish(db, clock, first);
  const second = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, second.id, "main");
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
  await commitThroughTaskCheckout(db, clock, workspace, root, "repair.txt", "fixed\n");
  await convergeOn(landing, root.id, failure!.id);
  await expect(convergeOn(landing, root.id, failure!.id)).resolves.toEqual({
    kind: "excluded",
    reason: "pull_request_closed",
    error: `PR #1 was closed outside the board, so task/${root.id} is not pushed to it`,
  });

  const done = finish(db, clock, landingWork(db, clock));
  appendEvent(db, { taskId: done.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "nothing_to_land", base: "main" }, at: clock.now() });
  registerPrPromotionFailureQuestion(db, done, "stale", clock.now());
  const [stale] = promotionFailures(db, done.id);
  await expect(convergeOn(landing, done.id, stale!.id)).resolves.toMatchObject({ kind: "excluded", reason: "not_a_root" });
});

// ADR 0394 決定4: 回答が待つ根を収束が飛ばしたら、回答の拒否文は飛ばした理由を言う。以下がこの拒否文を述べる唯一の場所(ADR 0107)
/** `c` の盤面の収束で、回が始まる直前に `effect` を1回だけ走らせる —— 回答が収束を待つ間に根の状態が変わる形。 */
const landingThatFirst = (c: Awaited<ReturnType<typeof pushedRoot>>, effect: () => void) => {
  let fired = false;
  return c.landingWith({
    pickupIdle: async () => {
      if (!fired) effect();
      fired = true;
    },
  });
};
/** 根の着地を終わらせる記録 —— 根は候補から外れる。 */
const endLanding = (c: Awaited<ReturnType<typeof pushedRoot>>) => () =>
  appendEvent(c.db, { taskId: c.work.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "nothing_to_land", base: "main" }, at: c.clock.now() });
const refusalOf = (answer: Promise<unknown>) =>
  answer.then(
    () => undefined,
    (err: unknown) => {
      expect(err).toBeInstanceOf(DomainError);
      return (err as Error).message;
    },
  );

it("外の push が内容を落とした PR の merge question への「merge」を待つ間に根が候補から外れれば、拒否文は根でなくなったことを言い、merge されず question は開いたまま", async () => {
  const { c } = await droppedRepair("skipped-root-merge-answer");
  await c.landing.tick("auto_merge");
  const [question] = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  const landing = landingThatFirst(c, endLanding(c));

  expect(await refusalOf(answerMergeQuestion({ ...c, landing }))).toBe(`task ${c.work.id} is no longer a landing root, so the board did not carry this answer`);

  expect(c.github.merged).toEqual([]);
  expect(getTask(c.db, question!.id)?.status).toBe("todo");
});

it("PR 昇格失敗の question への「retry」を待つ間に根が候補から外れれば、拒否文は根でなくなったことを言い、何も運ばず question は開いたまま", async () => {
  const c = await pushedRoot("skipped-root-retry-answer", { openFailure: true });
  const [failure] = promotionFailures(c.db, c.work.id);
  const landing = landingThatFirst(c, endLanding(c));

  expect(await refusalOf(answerPromotion(c.db, c.clock, landing, c.workspace, failure!, "retry"))).toBe(
    `task ${c.work.id} is no longer a landing root, so the board did not carry this answer`,
  );

  c.expectNothingCarried();
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
});

it("「retry」が待つ根の着地が回の中で例外に落ちれば、拒否文は根が外れたとは言わず、その根の着地が失敗したことを言う", async () => {
  const c = await pushedRoot("skipped-root-landing-threw", { openFailure: true });
  const [failure] = promotionFailures(c.db, c.work.id);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const prepare = c.db.prepare.bind(c.db);
  const landing = landingThatFirst(c, () => {
    // 根の PR の決着の読み(回が根ごとに最初に読む記録)が1回だけ落ちる
    const spy = vi.spyOn(c.db, "prepare").mockImplementation(((sql: string) => {
      if (!sql.includes("pr_merge_observed")) return prepare(sql);
      spy.mockRestore();
      throw new Error("database is locked");
    }) as typeof c.db.prepare);
  });

  expect(await refusalOf(answerPromotion(c.db, c.clock, landing, c.workspace, failure!, "retry"))).toBe(
    `the board failed to land task ${c.work.id} (database is locked); answer again`,
  );

  c.expectNothingCarried();
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
});

it("「retry」が待つ回で候補の読みそのものが失敗すれば、拒否文は根を読めなかったことを言う", async () => {
  const c = await pushedRoot("skipped-root-candidates-unread", { openFailure: true });
  const [failure] = promotionFailures(c.db, c.work.id);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const landing = landingThatFirst(c, () => {
    vi.spyOn(c.db, "prepare").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });
  });

  expect(await refusalOf(answerPromotion(c.db, c.clock, landing, c.workspace, failure!, "retry"))).toBe(
    "the board could not read its landing roots; answer again",
  );

  c.expectNothingCarried();
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
});

it("1つの根の失敗はその根に閉じ込められ、回は残りの根を着地させる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-contained");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  // タスクブランチを持たない根は、内容を比べる git が失敗する
  const broken = finish(db, clock, landingWork(db, clock));
  const healthy = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, healthy.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, healthy);

  await expect(landing.converge()).resolves.toEqual([
    { taskId: broken.id, verdict: expect.objectContaining({ kind: "failed", reason: "promotion_failed" }) },
    { taskId: healthy.id, verdict: { kind: "landed", form: "pull_request_opened", prNumber: 1 } },
  ]);
});

it("候補の読み取りそのものが失敗した回は、ログに出して何も撃たずに終わり、次の突きで走り直す", async () => {
  const { workspace } = await makeLandingWorkspace("landing-candidate-read");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
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
  const { workspace } = await makeLandingWorkspace("landing-retry-mid-pass");
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
  checkoutTaskBranch(db, workspace, failed.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, failed);
  registerPrPromotionFailureQuestion(db, failed, "token expired", clock.now());
  const [failure] = promotionFailures(db, failed.id);
  const busy = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, busy.id, "main");
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
  const { workspace } = await makeLandingWorkspace("landing-catch-up");
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
  checkoutTaskBranch(db, workspace, parent.id);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now(), "worker");
  recordPrOpenedOutsideConvergence(db, parent, 1, clock.now());
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
  checkoutTaskBranch(db, workspace, repair.id, `task/${parent.id}`);
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

// ADR 0371 決定7・11 / spec #3273 pin A9: 追いつきの conflict は昇格の失敗の中で作業台を開き、question の本文がそれを言う(text A2)。
// retry は人間の merge を取り込み、追いついてから push する(ADR 0376 決定8)
it("追いつきの conflict は作業台を開いて本文が名指し、作業台で merge して retry すると取り込んで PR を開く", async () => {
  const c = await catchUpConflictRoot("catch-up-conflict-workbench");

  const verdict = await convergeOn(c.landing, c.repair.id);

  expect(verdict).toMatchObject({ kind: "failed", reason: "promotion_failed" });
  const [failure] = promotionFailures(c.db, c.repair.id);
  expect(failure!.title).toBe("PR promotion failed: repair");
  c.expectA2(failure!.purpose);
  expect(git(c.workbench(), "rev-parse", "board/origin/main")).toBe(git(c.workspace.path, "rev-parse", "refs/remotes/origin/main"));
  // origin から引くのは保護ブランチだけ —— `board/origin/task/<root>` を持つのは GitHub の head を運ぶ作業台(ADR 0376 決定4)
  expect(git(c.workbench(), "for-each-ref", "--format=%(refname)", "refs/heads/board/origin/")).toBe("refs/heads/board/origin/main");
  expect(c.github.requests).toEqual([]);

  c.resolve();
  const tip = git(c.workbench(), "rev-parse", "HEAD");
  await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry");

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"]).map(({ payload }) => payload)).toEqual([
    expect.objectContaining({ target: `refs/heads/${c.target}`, tip, entry: "promotion_retry" }),
  ]);
  expect(c.github.requests).toEqual([expect.objectContaining({ branch: c.target, base: "main" })]);
  expect(git(c.workspace.path, "ls-remote", "head-repo", `refs/heads/${c.target}`).split("\t")[0]).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(git(c.workspace.path, "diff", "--name-only", `refs/remotes/origin/main...${c.target}`)).toBe("repair-only.txt");
});

// spec #3273 text C6: 作業台を残す追いつきの取り込みは、retry の回答の応答が C6 を言う
it("追いつきの取り込みの後に作業台に人間の作業が残れば、作業台の branch を包む commit へ進め、retry の応答が text C6 を言う", async () => {
  const c = await catchUpConflictRoot("catch-up-conflict-kept-workbench");
  await convergeOn(c.landing, c.repair.id);
  const [failure] = promotionFailures(c.db, c.repair.id);
  c.resolve();
  const tip = git(c.workbench(), "rev-parse", "HEAD");
  git(c.workbench(), "checkout", "--quiet", "-b", "side");
  commitWork(c.workbench(), "side.txt", "the human's other work\n");
  git(c.workbench(), "checkout", "--quiet", c.target);

  const answered = await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry");

  const commit = listEventsOfKinds(c.db, ["workbench_taken_in"]).map(({ payload }) => (payload as { commit: string }).commit)[0]!;
  expect(answered.notice).toBe(`took ${tip} in as ${commit} on ${c.target}. In a clone, fetch the workbench and fast-forward to \`board/${c.target}\` before you write on.`);
  expect(git(c.workbench(), "rev-parse", c.target)).toBe(commit);
  expect(getTask(c.db, failure!.id)?.status).toBe("done");
});

it("追いつきの conflict で作業台を開けなくても本文はその理由を言い、retry の答え直しが作業台を開く(text A7d)", async () => {
  const c = await catchUpConflictRoot("catch-up-conflict-no-workbench");
  // 段の場所にファイルがあって作業台の dir を作れない
  const segment = dirname(workbenchPath(c.workbenchBase, { task: c.repair.id }, "origin/main"));
  writeFileSync(segment, "in the way\n");

  await convergeOn(c.landing, c.repair.id);

  const [failure] = promotionFailures(c.db, c.repair.id);
  expect(failure!.purpose).toMatch(/^main does not merge cleanly into /);
  expect(failure!.purpose).toContain("The board could not open the workbench (");
  expect(failure!.purpose).toContain("answer again");
  expect(failure!.purpose).not.toContain("opened the workbench");
  rmSync(segment);

  const refusal = await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry").then(() => undefined, (err: unknown) => err);

  expect(refusal).toBeInstanceOf(DomainError);
  c.expectA2((refusal as Error).message);
});

it("別の失敗で開いていた昇格失敗 question への retry は追いつきの conflict に当たって拒まれ、作業台を開き、作業台で merge した次の retry が通る", async () => {
  const c = await catchUpConflictRoot("catch-up-conflict-on-retry", { openFailure: true });
  const [failure] = promotionFailures(c.db, c.repair.id);
  const before = git(c.workspace.path, "rev-parse", c.target);

  const refusal = await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry").then(() => undefined, (err: unknown) => err);

  expect(refusal).toBeInstanceOf(DomainError);
  c.expectA2((refusal as Error).message);
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
  expect(git(c.workspace.path, "rev-parse", c.target)).toBe(before);
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toEqual([]);
  expect(c.github.requests).toEqual([]);

  c.resolve();
  await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry");

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  expect(c.github.requests).toEqual([expect.objectContaining({ branch: c.target, base: "main" })]);
  expect(git(c.workspace.path, "diff", "--name-only", `refs/remotes/origin/main...${c.target}`)).toBe("repair-only.txt");
});

it("作業台で merge した後に origin の保護ブランチが進めば、retry は `board/origin/main` を名指して拒まれ、その ref を新しい値へ引き直し、何も書かない", async () => {
  const c = await catchUpConflictRoot("catch-up-conflict-origin-moved");
  await convergeOn(c.landing, c.repair.id);
  const [failure] = promotionFailures(c.db, c.repair.id);
  c.resolve();
  await c.advanceOrigin();
  const before = git(c.workspace.path, "rev-parse", c.target);

  const refusal = await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry").then(() => undefined, (err: unknown) => err);

  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain("`board/origin/main`");
  expect(git(c.workbench(), "rev-parse", "board/origin/main")).toBe(git(c.workspace.path, "rev-parse", "refs/remotes/origin/main"));
  expect(git(c.workspace.path, "rev-parse", c.target)).toBe(before);
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toEqual([]);
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
  expect(c.github.requests).toEqual([]);
});

// spec #3273 text A7c / D6(ADR 0376 決定12): remote-backed の入口の人間しか書けない path の拒否は origin への道を言う
it("追いつきの作業台の tip が人間しか書けない path を変えていれば、retry は text D6 の道を言って拒み何も書かない", async () => {
  const c = await catchUpConflictRoot("catch-up-conflict-human-only");
  await convergeOn(c.landing, c.repair.id);
  const [failure] = promotionFailures(c.db, c.repair.id);
  c.resolve();
  commitWork(c.workbench(), ".mcp.json", "{}\n");
  const before = git(c.workspace.path, "rev-parse", c.target);

  const refusal = await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry").then(() => undefined, (err: unknown) => err);

  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain(
    "which is written only by a human; take that change out and commit, then answer again. Put the change into origin's main — a fast-forward push from your own " +
      `clone, or a merge of your own PR. Never push from ${c.workspace.path}. Tasks that have already forked do not get it; it takes effect from the next fork.`,
  );
  expect(git(c.workspace.path, "rev-parse", c.target)).toBe(before);
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toEqual([]);
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
});

// ADR 0382 決定1・2(#3347): 追いつきの作業台と子の merge back の作業台は別の鍵 —— 子は盤面が運び、人間の追いつきの tip はその後の
// 書く先を欠いて A7a で1回増える
it("追いつきの作業台に人間の `board/origin/main` の merge があり子の merge back が根に届いていなければ、retry は子を盤面が運び、追いつきの取り込みを `board/task/<root>` を名指して拒み、それを merge した次の retry が通る", async () => {
  const c = await catchUpConflictRoot("catch-up-with-undelivered-child", { undeliveredChild: true });
  await convergeOn(c.landing, c.repair.id);
  const [failure] = promotionFailures(c.db, c.repair.id);
  c.expectA2(failure!.purpose);
  c.resolve();
  const before = git(c.workspace.path, "rev-parse", c.target);

  const refusal = await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry").then(() => undefined, (err: unknown) => err);

  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain(
    `the workbench at ${c.workbench()} is not ready: ${c.target} there does not contain ${c.target} (\`board/${c.target}\`). Run \`git merge board/${c.target}\` there`,
  );
  expect(git(c.workspace.path, "rev-parse", `${c.target}^1`)).toBe(before);
  expect(git(c.workspace.path, "show", `${c.target}:child.txt`)).toBe("fixed");
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toEqual([]);
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");

  git(c.workbench(), "merge", "--quiet", "--no-edit", `board/${c.target}`);
  await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry");

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"]).map(({ payload }) => payload)).toEqual([expect.objectContaining({ target: `refs/heads/${c.target}`, entry: "promotion_retry" })]);
  expect(c.github.requests).toEqual([expect.objectContaining({ branch: c.target, base: "main" })]);
  expect(git(c.workspace.path, "diff", "--name-only", `refs/remotes/origin/main...${c.target}`)).toBe("child.txt\nrepair-only.txt");
});

// ADR 0376 決定1・4 / spec #3273 pin D1・D6: PR の無い出元 repo のブランチに盤面の知らない commit があれば、clean に merge できても盤面は merge も
// push もしない。収束が先に見つければ本文が作業台を言い(text D1)、人間の merge の後の retry が取り込んで push する
it("出元 repo のタスクブランチに盤面の知らない commit がある PR の無い根を収束は merge も push もせず、作業台を開いて本文が text D1 を言い、作業台で merge した retry が取り込んで push し PR を開く", async () => {
  const c = await pushedRoot("outside-commits-no-pr");
  const head = await pushOutsideBoard(c.workspace, c.work.id);

  const verdict = await convergeOn(c.landing, c.work.id);

  expect(verdict).toMatchObject({ kind: "failed", reason: "promotion_failed" });
  const [failure] = promotionFailures(c.db, c.work.id);
  expect(failure!.purpose).toBe(c.d1(head));
  expect(git(c.workbench(), "rev-parse", `board/origin/${c.target}`)).toBe(head);
  c.expectNothingCarried();

  const tip = c.mergeInWorkbench();
  expect(await c.retry(failure!)).toBeUndefined();

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"]).map(({ payload }) => payload)).toEqual([
    expect.objectContaining({ target: `refs/heads/${c.target}`, tip, entry: "promotion_retry" }),
  ]);
  expect(forkHead(c.workspace, c.work.id)).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(git(c.workspace.path, "show", `${c.target}:outside.txt`)).toBe("pushed on GitHub");
  expect(c.github.requests).toEqual([expect.objectContaining({ branch: c.target, base: "main" })]);
});

// spec #3273 pin D1: PR が記録済みでも同じ —— 未 push の修理があっても、盤面は外の commit を自分では merge しない
it("記録済みの PR の head に盤面の知らない commit があれば、収束は未 push の修理を merge も push もせず作業台を開いて text D1 を言い、作業台で merge した retry が取り込んで push する", async () => {
  const c = await pushedRoot("outside-commits-recorded-pr", { pr: "recorded" });
  const head = await pushOutsideBoard(c.workspace, c.work.id);

  const verdict = await convergeOn(c.landing, c.work.id);

  expect(verdict).toMatchObject({ kind: "failed", reason: "promotion_failed" });
  const [failure] = promotionFailures(c.db, c.work.id);
  expect(failure!.purpose).toBe(c.d1(head));
  expect(git(c.workbench(), "rev-parse", `board/origin/${c.target}`)).toBe(head);
  c.expectNothingCarried();

  c.mergeInWorkbench();
  expect(await c.retry(failure!)).toBeUndefined();

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  const landed = forkHead(c.workspace, c.work.id);
  expect(landed).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(git(c.workspace.path, "ls-tree", "--name-only", landed).split("\n")).toEqual(expect.arrayContaining(["outside.txt", "repair.txt"]));
  expect(latestEventOfTask(c.db, c.work.id, "pr_branch_pushed")?.payload).toMatchObject({ pr_number: 1, sha: landed });
});

// ADR 0376 決定4 / spec #3273 pin D6: 答えていない昇格失敗 question がある根を収束は撃たないので、盤面が head を最初に読むのは retry の中 ——
// 作業台はその拒否の中で開き、人間は2回答える
it("別の失敗で昇格失敗 question が開いている間に 出元 repo のタスクブランチが進めば、retry は text D1 で拒まれてその中で作業台を開き、何も書かず、作業台で merge した次の retry が通る", async () => {
  const c = await pushedRoot("outside-commits-on-retry", { openFailure: true });
  const head = await pushOutsideBoard(c.workspace, c.work.id);
  expect(await convergeOn(c.landing, c.work.id)).toBeUndefined();
  expect(existsSync(c.workbenchAt)).toBe(false);
  const [failure] = promotionFailures(c.db, c.work.id);

  const refusal = await c.retry(failure!);

  expect(refusal).toBe(c.d1(head));
  expect(git(c.workbench(), "rev-parse", `board/origin/${c.target}`)).toBe(head);
  expect(promotionFailures(c.db, c.work.id).map(({ id, status }) => ({ id, status }))).toEqual([{ id: failure!.id, status: "todo" }]);
  c.expectNothingCarried();

  c.mergeInWorkbench();
  expect(await c.retry(failure!)).toBeUndefined();

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  expect(forkHead(c.workspace, c.work.id)).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(c.github.requests).toEqual([expect.objectContaining({ branch: c.target, base: "main" })]);
});

// ADR 0376 決定1・2 / spec #3273 pin D2: PR が見つからず出元 repo のブランチも「読めて、無い」根は、今どおり push して PR を作る。head の読みは
// 写しを書かない —— 写しを書くのは push だけ(決定3)
it("PR も 出元 repo のタスクブランチも無い根を収束は「読めて、無い」と読んで push し PR を開き、head の読みは写しを書かない", async () => {
  const { workspace } = await makeLandingWorkspace("outside-head-absent");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  const target = `task/${work.id}`;
  git(workspace.path, "checkout", "-b", target);
  recordDeclaredRepo(db, work.id, workspace);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  finish(db, clock, work);
  const tip = git(workspace.path, "rev-parse", target);
  const copy = () => git(workspace.path, "for-each-ref", "--format=%(objectname)", `refs/remotes/head-repo/${target}`);
  // push が撃たれる時点 = head の読みの後 —— そこで写しを読む
  const copyWhenPushing: string[] = [];
  const prepare = github.preparePush.bind(github);
  github.preparePush = async (input) => {
    const push = await prepare(input);
    return (sha) => {
      copyWhenPushing.push(copy());
      push(sha);
    };
  };
  expect(forkHead(workspace, work.id)).toBe("");

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "landed", form: "pull_request_opened", prNumber: 1 });

  expect(copyWhenPushing).toEqual([""]);
  expect(forkHead(workspace, work.id)).toBe(tip);
  expect(copy()).toBe(tip);
  expect(github.requests).toEqual([expect.objectContaining({ branch: target, base: "main" })]);
});

// ADR 0376 決定2 / spec #3273 pin D3: 「読めなかった」は「読めて、無い」と違い、push を撃たない(text D4)
it("出元 repo のタスクブランチを読めなければ、収束は push も PR の作成もせず、昇格の失敗が text D4 を言う", async () => {
  const c = await pushedRoot("outside-head-unreadable");
  renameSync(c.workspace.head_repo!, `${c.workspace.head_repo}.unreachable`);

  const verdict = await convergeOn(c.landing, c.work.id);

  const error = expect.stringMatching(new RegExp(`^could not read head repo ${c.workspace.head_repo}'s ${c.target} \\(.+\\), so the board did not push\\.$`, "s"));
  expect(verdict).toEqual({ kind: "failed", reason: "promotion_failed", error });
  expect(promotionFailures(c.db, c.work.id).map(({ purpose }) => purpose)).toEqual([`Creating a PR for completed task "ship" failed: ${(verdict as { error: string }).error}`]);
  expect(git(c.workspace.repo!, "for-each-ref", "refs/heads/task/")).toBe("");
  c.expectNothingCarried();
});

// ADR 0376 決定6 / spec #3273 pin D4: PR の記録が無い巻き戻しは push を止め、retry を毎回拒む。同意は出元 repo への操作で表す。作業台は開かず、
// 印も event も足さない
it("PR を記録していない根の出元 repo のタスクブランチが最後に push した値より前へ巻き戻されていれば、収束は push せず本文が text D2 を言い、retry は毎回拒まれて作業台も event も足さず、落とされた commit を push し直した後の retry が通る", async () => {
  const c = await pushedRoot("outside-rewind-pushed-back", { pr: "found", commits: 2 });
  const head = git(c.workspace.path, "rev-parse", `${c.pushed}~1`);
  const outside = await outsideClone(c.workspace);
  outside.push(`${head}:refs/heads/${c.target}`);

  const verdict = await convergeOn(c.landing, c.work.id);

  expect(verdict).toEqual({ kind: "failed", reason: "promotion_failed", error: c.d2(head, 1) });
  const [failure] = promotionFailures(c.db, c.work.id);
  expect(failure!.purpose).toBe(c.d2(head, 1));
  const events = listEvents(c.db, c.work.id).length;
  expect(await c.retry(failure!)).toBe(c.d2(head, 1));
  expect(await c.retry(failure!)).toBe(c.d2(head, 1));
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
  expect(listEvents(c.db, c.work.id)).toHaveLength(events);
  expect(existsSync(c.workbenchAt)).toBe(false);
  expect(forkHead(c.workspace, c.work.id)).toBe(head);
  c.expectNothingCarried();

  // 落とされた commit を名前の場所から自分の clone へ取り、fast-forward で push し直す
  git(outside.clone, "fetch", c.workspace.path, c.target);
  outside.push(`FETCH_HEAD:refs/heads/${c.target}`);
  expect(await c.retry(failure!)).toBeUndefined();

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  expect(getTask(c.db, c.work.id)?.pr_number).toBe(1);
  expect(forkHead(c.workspace, c.work.id)).toBe(c.pushed);
});

// ADR 0376 決定6: 巻き戻しは取り込みより前に決まる —— 前の text D1 の作業台に取り込める tip が残っていても、印も event も足さない
it("作業台で merge した後に出元 repo のタスクブランチが最後に push した値より前へ巻き戻されれば、retry は text D2 で拒まれ、作業台の tip を取り込まない", async () => {
  const c = await pushedRoot("outside-rewind-after-merge", { commits: 2 });
  await pushOutsideBoard(c.workspace, c.work.id);
  await convergeOn(c.landing, c.work.id);
  const [failure] = promotionFailures(c.db, c.work.id);
  c.mergeInWorkbench();
  const head = git(c.workspace.path, "rev-parse", `${c.pushed}~1`);
  (await outsideClone(c.workspace)).push(`${head}:refs/heads/${c.target}`);

  expect(await c.retry(failure!)).toBe(c.d2(head));

  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
  c.expectNothingCarried();
});

it("別の失敗で昇格失敗 question が開いている PR の無い根の出元 repo のタスクブランチが巻き戻されていれば、retry は text D2 で拒まれ、出元 repo のブランチを消した後の retry が push し直して PR を開く", async () => {
  const c = await pushedRoot("outside-rewind-deleted", { commits: 2, openFailure: true });
  const head = git(c.workspace.path, "rev-parse", `${c.pushed}~1`);
  const outside = await outsideClone(c.workspace);
  outside.push(`${head}:refs/heads/${c.target}`);
  const [failure] = promotionFailures(c.db, c.work.id);

  expect(await c.retry(failure!)).toBe(c.d2(head));
  expect(existsSync(c.workbenchAt)).toBe(false);
  c.expectNothingCarried();

  outside.push(`:refs/heads/${c.target}`);
  expect(await c.retry(failure!)).toBeUndefined();

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  expect(forkHead(c.workspace, c.work.id)).toBe(c.pushed);
  expect(c.github.requests).toEqual([expect.objectContaining({ branch: c.target, base: "main" })]);
});

// spec #3273 pin D9("Rewind, precisely"): 最後に push した値から分かれた head は巻き戻しではない —— 人間が merge するまで push する sha の
// 祖先にならないので盤面の知らない commit として入り、その merge を取り込んだ後は、最後に push した値を欠いたままでも盤面が push する
it("PR を記録していない根の出元 repo のタスクブランチが最後に push した値と分かれた head に書き換えられていれば、巻き戻しでなく text D1 で作業台を開き、作業台で merge した retry が push する", async () => {
  const c = await pushedRoot("outside-rewrite-no-pr", { commits: 2, openFailure: true });
  const head = await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${c.pushed}~1`));
  const [failure] = promotionFailures(c.db, c.work.id);

  expect(await c.retry(failure!)).toBe(c.d1(head));
  c.expectNothingCarried();

  c.mergeInWorkbench();
  expect(await c.retry(failure!)).toBeUndefined();

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  const landed = forkHead(c.workspace, c.work.id);
  expect(landed).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(git(c.workspace.path, "ls-tree", "--name-only", landed).split("\n")).toEqual(expect.arrayContaining(["feature-2.txt", "outside.txt"]));
  expect(c.github.requests).toEqual([expect.objectContaining({ branch: c.target, base: "main" })]);
});

// ADR 0376 Status 追記(#3605): 収束の push は決定2 の判断に使った head を lease として載せる —— 読んだ後に動いた head には、fast-forward
// になる祖先への巻き戻しでも、作られたブランチでも書かない。落ちた push は今どおり昇格の失敗で、retry が読み直す
/** 収束が head を読んだ後・push の前(次の push の準備の中)に、その準備の入力で `effect` を撃つ。 */
function beforeNextPush(github: FakeGitHubClient, effect: (input: PreparePushInput) => void) {
  const prepare = github.preparePush.bind(github);
  vi.spyOn(github, "preparePush").mockImplementationOnce(async (input) => {
    effect(input);
    return prepare(input);
  });
}

it("収束が出元 repo のタスクブランチを読んだ後・push の前に祖先へ戻されれば、push は落ちて昇格の失敗になり、出元 repo は戻されたままで、続く retry は text D2 で拒まれる", async () => {
  const c = await pushedRoot("lease-rewound-after-read", { commits: 2 });
  const head = git(c.workspace.path, "rev-parse", `${c.pushed}~1`);
  beforeNextPush(c.github, () => git(c.workspace.head_repo!, "update-ref", `refs/heads/${c.target}`, head));

  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed" });

  expect(forkHead(c.workspace, c.work.id)).toBe(head);
  expect(c.github.requests).toEqual([]);
  const [failure] = promotionFailures(c.db, c.work.id);
  expect(await c.retry(failure!)).toBe(c.d2(head));
  expect(forkHead(c.workspace, c.work.id)).toBe(head);
});

it("収束が出元 repo のタスクブランチを「無い」と読んだ後・push の前にブランチが作られれば、push は落ちて昇格の失敗になり、PR を開かない", async () => {
  const { workspace } = await makeLandingWorkspace("lease-created-after-read");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock);
  const target = `task/${work.id}`;
  git(workspace.path, "checkout", "-b", target);
  recordDeclaredRepo(db, work.id, workspace);
  commitWork(workspace.path, "feature.txt", "ready\n");
  git(workspace.path, "checkout", "main");
  finish(db, clock, work);
  const created = git(workspace.path, "rev-parse", "main");
  beforeNextPush(github, () => git(workspace.head_repo!, "update-ref", `refs/heads/${target}`, created));

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed" });

  expect(forkHead(workspace, work.id)).toBe(created);
  expect(github.requests).toEqual([]);
});

it("PR がある根の収束の push は、push する sha でも出元 repo のブランチでもなく、PR の読みの head を期待値に載せる", async () => {
  const c = await pushedRoot("lease-on-pr-head", { pr: "recorded" });
  // GitHub の PR の読みが出元 repo のブランチ(最後に push した値)と食い違い、1つ目の修理の commit を head と報告する。push する sha は2つ目の修理
  const prHead = git(c.workspace.path, "rev-parse", c.target);
  c.github.scriptHead(1, prHead);
  await commitThroughTaskCheckout(c.db, c.clock, c.workspace, getTask(c.db, c.work.id)!, "repair-2.txt", "more\n");
  const tip = git(c.workspace.path, "rev-parse", c.target);
  expect(new Set([prHead, tip, c.pushed]).size).toBe(3);
  const expectations: string[] = [];
  beforeNextPush(c.github, (input) => expectations.push(input.expected));

  await expect(convergeOn(c.landing, c.work.id)).resolves.toMatchObject({ kind: "failed", reason: "promotion_failed" });

  expect(expectations).toEqual([prHead]);
  expect(forkHead(c.workspace, c.work.id)).toBe(c.pushed);
});

/** 盤面の外で記録済みの PR の head を動かす: `rewound` は最後に push した値の1つ前へ戻し、`rewritten` はその上に別の commit を作る
 *  (最後に push した値から分かれる)。動かした head を返す。 */
async function moveRecordedHead(c: Awaited<ReturnType<typeof pushedRoot>>, form: "rewound" | "rewritten"): Promise<string> {
  const before = git(c.workspace.path, "rev-parse", `${c.pushed}~1`);
  if (form === "rewritten") return pushOutsideBoard(c.workspace, c.work.id, before);
  (await outsideClone(c.workspace)).push(`${before}:refs/heads/${c.target}`);
  return before;
}

// ADR 0376 決定7 / spec #3273 pin D5: 記録済みの PR の head が最後に push した値を欠けば、収束は push せず昇格の失敗にもせず、キューの行を外して
// 推奨 hold の merge question を立てる —— 開いていれば足さない
it.each(["rewound", "rewritten"] as const)("記録済みの PR の head が盤面の外で %s なら、収束は push せず昇格の失敗も立てず、キューの行を外して推奨 hold の merge question を1枚立て、次の収束はその question を待って足さない", async (form) => {
  const c = await pushedRoot(`outside-push-question-${form}`, { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  await moveRecordedHead(c, form);

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });

  expect(mergeQuestions(c.db)).toEqual([{ pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: textA4c(c.target) }]);
  expect(promotionFailures(c.db, c.work.id)).toEqual([]);
  expect(await readOnNextTick(c.landing, c.github)).toEqual([]);
  c.expectNothingCarried();
});

it("CI 赤の merge question を収束が書き換えの question に取り替え、同じ外の部分なら修理が届いても取り替えない", async () => {
  const c = await pushedRoot("outside-rewrite-replaces-ci-red", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  c.github.scriptCiStatus("failure");
  await c.landing.tick("auto_merge");
  const [ciQuestion] = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  const original = getTask(c.db, ciQuestion!.id)!;
  expect(original.purpose).toBe(CI_RED_PURPOSE);
  expect(original.question_pr_merge_reason).toBe("ci_red");

  const before = git(c.workspace.path, "rev-parse", `${c.pushed}~1`);
  const head = await pushOutsideBoard(c.workspace, c.work.id, before, "CODEOWNERS");
  await convergeOn(c.landing, c.work.id);

  expect(mergeQuestions(c.db).map(({ purpose }) => purpose)).toEqual([
    `${textA4c(c.target)}\n\nThis PR changes paths that require a human merge. "CODEOWNERS".`,
  ]);
  expect(getTask(c.db, original.id)).toEqual({ ...original, status: "done" });
  const [question] = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  expect(question).toMatchObject({
    question_landing_tip: git(c.workspace.path, "rev-parse", c.target),
    question_pr_merge_outside_sha: head,
    question_pr_merge_outside_kind: "rewritten",
    question_pr_merge_missing_branches: [c.target],
    question_pr_merge_reason: "outside_head",
  });
  const replacement = { kind: "pr_merge_question_replaced", question_id: original.id, replacement_question_id: question!.id };
  expect(boardEvents(c.db, c.work.id, "pr_merge_question_replaced").map(({ payload }) => payload)).toEqual([replacement]);
  expect(listEvents(c.db, original.id).map(({ kind }) => kind)).toEqual(["task_registered"]);
  await expect(submitAnswer({ ...c, pollNow: () => {} }, original, ["merge"], undefined, () => c.clock.now(), "webui")).rejects.toThrow("question closed");
  expect(c.github.merged).toEqual([]);

  await commitThroughTaskCheckout(c.db, c.clock, c.workspace, c.work, "another-repair.txt", "repair\n");
  await convergeOn(c.landing, c.work.id);

  expect(listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1)).toEqual([question]);
  expect(boardEvents(c.db, c.work.id, "pr_merge_question_replaced").map(({ payload }) => payload)).toEqual([replacement]);

  c.github.scriptMergedOutside(1);
  await c.landing.tick("outside_merge");
  expect(settledByObservation(c.db, original)).toBeNull();
  expect(settledByObservation(c.db, question!)).toBe("pr_merge_observed");
});

it.each(["state", "CI"] as const)("回答が %s の読みを待つ間に question が取り替われば、読めなくても question closed になる", async (read) => {
  const c = await pushedRoot(`outside-rewrite-answer-read-${read}`, { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  c.github.scriptCiStatus("failure");
  await c.landing.tick("auto_merge");
  const original = getTask(c.db, listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)!.id)!;
  const window = awaitWindow();
  if (read === "state") {
    vi.spyOn(c.github, "getPullRequestState").mockImplementationOnce(async () => {
      await window.hold();
      throw new Error("network unavailable");
    });
  } else {
    vi.spyOn(c.github, "readPullRequest").mockImplementationOnce(async () => {
      await window.hold();
      return { state: "unreadable", ci: "pending" };
    });
  }
  const answer = submitAnswer({ ...c, pollNow: () => {} }, original, [read === "state" ? "hold" : "merge"], undefined, () => c.clock.now(), "webui");
  try {
    await window.entered;
    const outside = await moveRecordedHead(c, "rewound");
    await convergeOn(c.landing, c.work.id);
    expect(listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)?.question_pr_merge_outside_sha).toBe(outside);
  } finally {
    window.open();
  }
  await expect(answer).rejects.toThrow("question closed");
  expect(c.github.merged).toEqual([]);
});

/** spec #3273 text A4b の全文(`lacks` は `<branches>` の句)。 */
const textA4b = (c: Awaited<ReturnType<typeof pushedRoot>>, head: string, lacks: string, answerOn?: string) =>
  `PR #1's head was rewritten outside the board to ${head}, which lacks the content of ${lacks}. The board opened the workbench at ${c.workbench()}. ` +
  `There, on ${c.target}, either keep that content with \`git merge board/origin/${c.target}\` (or, in your own clone with the workbench as a remote: fetch it, ` +
  `\`git merge <remote>/board/origin/${c.target}\`, and push ${c.target} to it), or discard it with \`git merge -s ours --no-commit board/origin/${c.target}\`, ` +
  `\`git read-tree -u --reset board/origin/${c.target}\`, \`git commit\`. Your tip must contain both ${c.target} as the board has it now (\`board/${c.target}\`) ` +
  `and the PR's observed head (\`board/origin/${c.target}\`), with nothing uncommitted. Then answer \`merge\` ${answerOn === undefined ? "again" : `on question ${answerOn}`}: ` +
  "the board takes your merge in and pushes it, and CI runs on the result.";

// ADR 0371 決定10 / ADR 0376 決定7・8 / spec #3273 pin A10: 最初の `merge` は作業台を開いて拒まれ、作業台で merge した次の `merge` が取り込んで
// 同じ回答の中で push する。その後の CI の拒否は取り込みと push を残し、そう言う(text A10)
it("書き換えられた記録済みの PR の merge question への最初の「merge」は text A4b で拒まれて作業台を開き、作業台で merge した次の「merge」が取り込んで push し、CI 待ちの拒否は取り込んで push したと言い、CI が緑になれば merge される", async () => {
  const c = await pushedRoot("outside-rewrite-merge-answer", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const head = await moveRecordedHead(c, "rewritten");
  await convergeOn(c.landing, c.work.id);

  expect(await c.answerMerge()).toBe(textA4b(c, head, c.target));
  expect(git(c.workbench(), "rev-parse", `board/origin/${c.target}`)).toBe(head);
  c.expectNothingCarried();

  const tip = c.mergeInWorkbench();
  c.github.scriptCiStatus("pending");
  expect(await c.answerMerge()).toBe(`took your merge in and pushed ${c.target}; CI is not green yet (status: pending) — cannot merge`);

  expect(listEventsOfKinds(c.db, ["workbench_taken_in"]).map(({ payload }) => payload)).toEqual([
    expect.objectContaining({ target: `refs/heads/${c.target}`, tip, entry: "landing_merge" }),
  ]);
  const landed = forkHead(c.workspace, c.work.id);
  expect(landed).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(git(c.workspace.path, "ls-tree", "--name-only", landed).split("\n")).toEqual(expect.arrayContaining(["feature-2.txt", "outside.txt", "repair.txt"]));
  expect(c.github.merged).toEqual([]);

  c.github.scriptCiStatus("success");
  expect(await c.answerMerge()).toBeUndefined();
  expect(c.github.mergedHeads).toEqual([landed]);
});

// spec #3273 pin D12: 巻き戻しは commit するものが無い —— 次の `merge` は tip を包まず(commit も event も無い)、落とされた内容を push し直す
it("巻き戻された記録済みの PR への最初の「merge」は text A4a で拒まれ、作業台で何もしない次の「merge」は包む commit も取り込みの event も書かずに落とされた内容を push し直す", async () => {
  const c = await pushedRoot("outside-rewind-merge-answer", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const head = await moveRecordedHead(c, "rewound");
  await convergeOn(c.landing, c.work.id);
  const local = git(c.workspace.path, "rev-parse", c.target);

  expect(await c.answerMerge()).toBe(textA4a(c, head, c.target));
  c.expectNothingCarried();

  c.github.scriptCiStatus("pending");
  expect(await c.answerMerge()).toBe(`pushed ${c.target}; CI is not green yet (status: pending) — cannot merge`);

  expect(git(c.workspace.path, "rev-parse", c.target)).toBe(local);
  expect(forkHead(c.workspace, c.work.id)).toBe(local);
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toEqual([]);

  // push の後に同じ head へまた巻き戻されれば、それは新しい外の push —— もう一度拒む
  await moveRecordedHead(c, "rewound");
  expect(await c.answerMerge()).toBe(textA4a(c, head, c.target));
  expect(forkHead(c.workspace, c.work.id)).toBe(head);
});

/** spec #3273 text D3b の全文。 */
const textD3b = (form: "rewritten" | "moved back", question: string) =>
  `PR #1's head was ${form} outside the board — answer question ${question} (\`merge\`); its first \`merge\` opens a workbench.`;

// ADR 0376 決定7 / spec #3273 pin D10・A10: 答えていない昇格失敗 question がある根を収束は撃たないので、retry がキューの行を外して merge
// question を立て、それを名指して拒む。最初の `merge` は、別の入口が開いた同じ鍵の作業台があっても拒まれ、昇格失敗 question を名指さない
it("別の失敗で昇格失敗 question が開いている根の記録済みの PR の head が書き換えられれば、retry はキューの行を外して merge question を立て text D3b で拒まれ、同じ鍵の作業台が既にあっても最初の「merge」は text A4b で拒まれ、作業台で merge した次の「merge」が取り込んで push し merge する", async () => {
  const c = await pushedRoot("outside-rewrite-promotion-open", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  // 盤面の知らない commit(text D1)が昇格失敗 question を立て、(task/<root>, GitHub の head) の作業台を開く
  await pushOutsideBoard(c.workspace, c.work.id);
  await convergeOn(c.landing, c.work.id);
  const [failure] = promotionFailures(c.db, c.work.id);
  expect(existsSync(c.workbenchAt)).toBe(true);
  const head = await moveRecordedHead(c, "rewritten");

  const refusal = await c.retry(failure!);

  const [question] = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  expect(refusal).toBe(textD3b("rewritten", question!.id));
  expect(mergeQuestions(c.db)).toEqual([{ pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: textA4c(c.target) }]);
  expect(await readOnNextTick(c.landing, c.github)).toEqual([]);
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
  expect(await c.retry(failure!)).toBe(textD3b("rewritten", question!.id));

  expect(await c.answerMerge()).toBe(textA4b(c, head, c.target));
  c.expectNothingCarried();

  c.mergeInWorkbench();
  expect(await c.answerMerge()).toBeUndefined();

  const landed = forkHead(c.workspace, c.work.id);
  expect(landed).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(c.github.mergedHeads).toEqual([landed]);
  expect(getTask(c.db, failure!.id)?.status).toBe("done");
});

/** 書き換えの head の merge question に「hold」と答えた根 —— 盤面には未 push の修理(積み残し)が残る(#3402 の再現の形)。 */
async function heldRewrite(name: string) {
  const c = await pushedRoot(name, { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const head = await moveRecordedHead(c, "rewritten");
  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
  const held = await answerHoldOnPr(c);
  return { c, head, held };
}

// ADR 0394 決定5〜7(#3402): PR の hold は答えた question の内容を断ったと根に刻み、内容が同じ間は収束が問い直さず、書き換えの head にも push しない
it("書き換えの head の merge question に「hold」と答えると、question の内容を根に刻み、次の収束は question を立てず hold された question を待つと返し、push もしない", async () => {
  const { c, head, held } = await heldRewrite("outside-rewrite-held");

  expect(boardEvents(c.db, c.work.id, "landing_declined")).toEqual([{
    actor_id: HUMAN_ACTOR_ID,
    origin: "webui",
    payload: {
      kind: "landing_declined",
      question_id: held.id,
      tip: git(c.workspace.path, "rev-parse", c.target),
      outside: { kind: "rewritten", sha: head },
      missing_branches: [c.target],
    },
  }]);
  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "awaiting_held_question", prNumber: 1, question: held.id });
  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "awaiting_held_question", prNumber: 1, question: held.id });

  expect(mergeQuestions(c.db)).toEqual([]);
  c.expectNothingCarried();
});

it("書き換えの head の merge question を hold した後に修理が届けば、次の収束は新しい merge question を立て、push はしない", async () => {
  const { c, held } = await heldRewrite("outside-rewrite-held-repair");

  await commitThroughTaskCheckout(c.db, c.clock, c.workspace, c.work, "another-repair.txt", "repair\n");

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
  const question = openPrMergeQuestion(c.db);
  expect(question!.id).not.toBe(held.id);
  expect(question!.question_landing_tip).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(c.github.pushes).toEqual([]);
});

it("書き換えの head の merge question を hold した後、積み残しがあるまま head がまた書き換えられれば、次の収束は新しい merge question を立てる", async () => {
  const { c, held } = await heldRewrite("outside-rewrite-held-rewritten-again");

  const again = await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${c.pushed}~1`), "again.txt");

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
  const question = openPrMergeQuestion(c.db);
  expect(question).toMatchObject({ question_pr_merge_outside_sha: again, question_pr_merge_outside_kind: "rewritten" });
  expect(question!.id).not.toBe(held.id);
});

// ADR 0394 決定6: PR の hold は同じ PR に新しい question が立つと効かなくなる —— 断った head へ戻されても、間に立った question を待たせず問い直す
it("書き換えの head X1 の merge question を hold した後に X2 への書き換えで新しい question が立てば、head が X1 へ戻されても hold は効かず、X1 を問う question に立て直す", async () => {
  const { c, head: first } = await heldRewrite("outside-rewrite-held-then-asked-again");
  await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${c.pushed}~1`), "again.txt");
  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
  const second = openPrMergeQuestion(c.db)!;

  (await outsideClone(c.workspace)).push(`${first}:refs/heads/${c.target}`);

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
  expect(getTask(c.db, second.id)?.status).toBe("done");
  expect(openPrMergeQuestion(c.db)).toMatchObject({ question_pr_merge_outside_sha: first, question_pr_merge_outside_kind: "rewritten" });
});

// ADR 0394 決定6 / ADR 0376 決定7: PR の hold が効いている間の retry は、人間の明示の操作として merge question を新しく立て、それを名指す
it("PR の hold が効いている間に、別の失敗の昇格失敗 question への retry が外の push の段に来れば、merge question を新しく立てて text D3b で名指して拒まれ、次の収束も merge question を足さない", async () => {
  const { c, held } = await heldRewrite("outside-rewrite-held-retry");
  registerPrPromotionFailureQuestion(c.db, c.work, "push failed", c.clock.now());
  const [failure] = promotionFailures(c.db, c.work.id);

  const refusal = await c.retry(failure!);

  const question = openPrMergeQuestion(c.db);
  expect(question!.id).not.toBe(held.id);
  expect(refusal).toBe(textD3b("rewritten", question!.id));
  expect(mergeQuestions(c.db)).toHaveLength(1);
  c.expectNothingCarried();

  await convergeOn(c.landing, c.work.id);
  expect(openPrMergeQuestion(c.db)?.id).toBe(question!.id);
  expect(mergeQuestions(c.db)).toHaveLength(1);
});

// ADR 0394 決定7 / ADR 0387 の帰結: 収束が GitHub の head を読むのは積み残しがあるときだけ —— 無ければ hold の後に head が動いても問い直さない
it("積み残しの無い PR の書き換えの head の merge question を hold した後に head がまた動いても、収束も tick も問い直さない", async () => {
  const c = await pushedRoot("outside-rewrite-held-nothing-left", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  expect(await convergeOn(c.landing, c.work.id)).toMatchObject({ form: "open_pull_request_updated" });
  const pushed = forkHead(c.workspace, c.work.id);
  await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${pushed}~1`));
  await c.landing.tick("auto_merge");
  await answerHoldOnPr(c);

  await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${pushed}~1`), "again.txt");

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "up_to_date", prNumber: 1 });
  expect(await readOnNextTick(c.landing, c.github)).toEqual([]);
  expect(mergeQuestions(c.db)).toEqual([]);
});

// ADR 0376 決定4・7: 印が head と同じでも、書き換えた head を人間が作業台で merge していなければ盤面は押せない —— retry を言う text D1 でなく、
// 同じ text A4b で拒む
it("書き換えられた記録済みの PR への2回目の「merge」は、作業台で何も commit していなければもう一度 text A4b で拒まれ、何も取り込まず push もしない", async () => {
  const c = await pushedRoot("outside-rewrite-nothing-merged", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const head = await moveRecordedHead(c, "rewritten");
  await convergeOn(c.landing, c.work.id);
  await c.answerMerge();

  expect(await c.answerMerge()).toBe(textA4b(c, head, c.target));

  c.expectNothingCarried();
  expect(forkHead(c.workspace, c.work.id)).toBe(head);
});

// ADR 0376 決定2: 最後に push した値が読めなければ(記録の sha が手元に無い)止めない —— 今どおり push する
it("記録済みの PR の最後に push した値が手元に無ければ、収束は書き換えと読まずに今どおり push する", async () => {
  const c = await pushedRoot("outside-push-unreadable-last-pushed", { pr: "recorded", recordedSha: "1111111111111111111111111111111111111111" });

  await expect(convergeOn(c.landing, c.work.id)).resolves.toEqual({ kind: "landed", form: "open_pull_request_updated", prNumber: 1 });

  expect(forkHead(c.workspace, c.work.id)).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(mergeQuestions(c.db)).toEqual([]);
});

// spec #3273 text A4d / group D「事実だけを言う」: 同じ内容のまま書き換えた head は何も落としていない —— 未 push の内容だけを名指し、落とされたとは言わない
it("同じ内容のまま書き換えられた記録済みの PR の head に未 push の内容が重なれば、merge question の本文は未 push の内容だけを名指す", async () => {
  const c = await pushedRoot("outside-rebase-same-content", { pr: "recorded", merge: "auto_if_ci_green" });
  const outside = await outsideClone(c.workspace);
  git(outside.clone, "checkout", "-q", c.target);
  git(outside.clone, "commit", "--quiet", "--amend", "-m", "Reworded outside the board");
  outside.push(c.target);

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });

  expect(mergeQuestions(c.db).map(({ purpose }) => purpose)).toEqual([textA4c(`${c.target} (not pushed by the board yet)`)]);
});

// ADR 0371 決定11 / ADR 0382 の上書き(取り込み → 追いつき → push): `merge` の中の追いつきの conflict は、答え直す回答として `merge` を言う
it("書き換えられた記録済みの PR への2回目の「merge」の追いつきが conflict すれば、text A2 の拒否は retry でなく「merge」を答え直させる", async () => {
  const c = await catchUpConflictRoot("outside-rewrite-catch-up-conflict");
  git(c.workspace.path, "push", "head-repo", c.target);
  const pushed = git(c.workspace.path, "rev-parse", c.target);
  c.github.scriptPullRequestOnBranch(c.target, 2);
  recordPushedHeadRepo(c.db, c.repair.id, c.workspace);
  recordPrOpened(c.db, c.repair, 2, pushed, c.clock.now(), { merge: "escalate" }, undefined);
  await pushOutsideBoard(c.workspace, c.repair.id, git(c.workspace.path, "rev-parse", `${pushed}~1`));
  const answerMerge = () =>
    submitAnswer(
      { db: c.db, pollNow: () => {}, landing: c.landing, workspace: c.workspace, github: c.github, workspacesDir: c.workbenchBase },
      getTask(c.db, listBoard(c.db).find((q) => q.question_pending_merge_pr === 2)!.id)!,
      ["merge"],
      undefined,
      () => c.clock.now(),
      "webui",
    ).then(
      () => undefined,
      (err: Error) => err.message,
    );
  await answerMerge();
  const outsideWorkbench = realpathSync(workbenchPath(c.workbenchBase, { task: c.repair.id }, `origin/${c.target}`));
  git(outsideWorkbench, "merge", "--quiet", "--no-edit", `board/origin/${c.target}`);

  const refusal = await answerMerge();

  expect(refusal).toEqual(expect.stringMatching(/^main does not merge cleanly into /));
  expect(refusal).toContain("Then answer `merge` again.");
  expect(refusal).not.toContain("`retry`");
});

// spec #3273 text C6: 作業台を残した取り込みは、後の拒否(CI 待ちの text A10)にも添える
it("2回目の「merge」の取り込みが作業台を残せば、CI 待ちの拒否は text C6 を添える", async () => {
  const c = await pushedRoot("outside-rewrite-kept-workbench", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  await moveRecordedHead(c, "rewritten");
  await convergeOn(c.landing, c.work.id);
  await c.answerMerge();
  const tip = c.mergeInWorkbench();
  git(c.workbench(), "checkout", "-q", "-b", "stray");
  commitWork(c.workbench(), "stray.txt", "kept\n");
  git(c.workbench(), "checkout", "-q", c.target);
  c.github.scriptCiStatus("pending");

  const refusal = await c.answerMerge();

  const wrapped = git(c.workspace.path, "rev-parse", c.target);
  expect(refusal).toBe(
    `took your merge in and pushed ${c.target}; CI is not green yet (status: pending) — cannot merge\n` +
      `took ${tip} in as ${wrapped} on ${c.target}. In a clone, fetch the workbench and fast-forward to \`board/${c.target}\` before you write on.`,
  );
});

it("無人 merge の tick が PR を読む間に収束が書き換えの merge question を立てたら、古い head でその question を取り替えない", async () => {
  const c = await pushedRoot("outside-rewrite-tick-race", {
    pr: "recorded", commits: 2, merge: "auto_if_ci_green", resolveAuthority: () => profile("escalate"),
  });
  c.github.scriptCiStatus("pending");
  const read = c.github.readPullRequest.bind(c.github);
  let asked: string | undefined;
  vi.spyOn(c.github, "readPullRequest").mockImplementationOnce(async (ref) => {
    const state = await read(ref);
    expect(state).toMatchObject({ state: "OPEN", head: c.pushed });
    await moveRecordedHead(c, "rewritten");
    expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
    const questions = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
    expect(questions).toHaveLength(1);
    asked = questions[0]!.id;
    return state;
  });

  await c.landing.tick("auto_merge");

  expect(asked).toBeDefined();
  expect(listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1).map((q) => q.id)).toEqual([asked]);
  expect(mergeQuestions(c.db).map(({ purpose }) => purpose)).toEqual([textA4c(c.target)]);
  expect(boardEvents(c.db, c.work.id, "pr_merge_question_replaced")).toEqual([]);
});

it("収束が PR を読む間に tick が新しい head の merge question を立てたら、収束の古い head で取り替えない", async () => {
  const c = await pushedRoot("outside-rewrite-convergence-race", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const firstHead = await moveRecordedHead(c, "rewound");
  const window = awaitWindow();
  const read = c.github.getPullRequestState.bind(c.github);
  vi.spyOn(c.github, "getPullRequestState").mockImplementationOnce(async (ref) => {
    const state = await read(ref);
    await window.hold();
    expect(state.head).toBe(firstHead);
    return state;
  });
  const converging = convergeOn(c.landing, c.work.id);
  let asked: (ReturnType<typeof listBoard>)[number] | undefined;
  try {
    await window.entered;
    const secondHead = await pushOutsideBoard(c.workspace, c.work.id, firstHead);
    c.github.scriptCiStatus("pending");
    await c.landing.tick("auto_merge");
    asked = listBoard(c.db).find((q) => q.question_pending_merge_pr === 1);
    expect(asked?.question_pr_merge_outside_sha).toBe(secondHead);
  } finally {
    window.open();
    await converging;
  }
  expect(listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1)).toEqual([asked]);
  expect(boardEvents(c.db, c.work.id, "pr_merge_question_replaced")).toEqual([]);
});

it("先に走る収束が merge question を取り替えたら、後ろで待っていた古い回答は作業台を取り込まず push しない", async () => {
  const c = await pushedRoot("queued-merge-answer-replaced", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const outside = await moveRecordedHead(c, "rewritten");
  await convergeOn(c.landing, c.work.id);
  const original = getTask(c.db, listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)!.id)!;
  expect(await c.answerMerge()).toContain("opened the workbench");
  c.mergeInWorkbench();
  // 収束は動いた head を読み、回答は question が問うた head を読む —— 回答は一致の検査を通って収束の列で待つ
  const movedAgain = await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${c.pushed}~1`), "outside-again.txt");

  const polling = awaitWindow();
  const find = c.github.findPullRequestByHead.bind(c.github);
  vi.spyOn(c.github, "findPullRequestByHead").mockImplementationOnce(async (ref) => {
    const state = await find(ref);
    await polling.hold();
    return state;
  });
  const background = c.landing.converge();
  await polling.entered;
  c.github.scriptHead(1, outside);

  let signalQueued!: () => void;
  const queued = new Promise<void>((resolve) => { signalQueued = resolve; });
  const converge = c.landing.converge.bind(c.landing);
  vi.spyOn(c.landing, "converge").mockImplementationOnce((options) => {
    const result = converge(options);
    signalQueued();
    return result;
  });
  const answer = c.answerMerge();
  try {
    await Promise.race([queued, answer.then(() => { throw new Error("answer did not queue for convergence"); })]);
  } finally {
    polling.open();
    await background;
  }

  expect(await answer).toContain("question closed");
  expect(getTask(c.db, original.id)?.status).toBe("done");
  expect(listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)?.question_pr_merge_outside_sha).toBe(movedAgain);
  expect(existsSync(c.workbenchAt)).toBe(true);
  c.expectNothingCarried();
});

// spec #3273 "Refused once" / ADR 0227 決定2: 印は盤面のどの push でも消える —— 拒否の後に人間が出元 repo の head を戻し、収束が push した後に同じ head へ
// また巻き戻されれば、最初の `merge` はもう一度拒まれる
it("拒否の後に出元 repo の head が戻され収束が push した後、同じ head へまた巻き戻されれば、最初の「merge」はもう一度 text A4a で拒まれる", async () => {
  const c = await pushedRoot("outside-rewind-stale-mark", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const head = await moveRecordedHead(c, "rewound");
  await convergeOn(c.landing, c.work.id);
  await c.answerMerge();
  const outside = await outsideClone(c.workspace);
  outside.push(`${c.pushed}:refs/heads/${c.target}`);
  expect(await convergeOn(c.landing, c.work.id)).toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  outside.push(`${head}:refs/heads/${c.target}`);

  expect(await c.answerMerge()).toBe(textA4a(c, head, c.target));
  expect(forkHead(c.workspace, c.work.id)).toBe(head);
});

// spec #3273 pin A10: 作業台があるだけでは印でない —— 巻き戻しは commit するものが無いので、印が無ければ最初の `merge` が黙って push してしまう
it("別の入口が開いた同じ鍵の作業台がある根の記録済みの PR が巻き戻されても、retry は text D3b(moved back)で拒まれ、最初の「merge」は text A4a で拒まれて push しない", async () => {
  const c = await pushedRoot("outside-rewind-existing-workbench", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  await pushOutsideBoard(c.workspace, c.work.id);
  await convergeOn(c.landing, c.work.id);
  const [failure] = promotionFailures(c.db, c.work.id);
  expect(existsSync(c.workbenchAt)).toBe(true);
  const head = await moveRecordedHead(c, "rewound");

  const refusal = await c.retry(failure!);

  const [question] = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  expect(refusal).toBe(textD3b("moved back", question!.id));

  expect(await c.answerMerge()).toBe(textA4a(c, head, c.target));
  c.expectNothingCarried();
  expect(forkHead(c.workspace, c.work.id)).toBe(head);
});

// spec #3273 pin A10: 印は拒否が伝えた head —— 拒否の後に head がまた動けば、もう一度拒む。ADR 0394 決定3: その拒否は question を立て直し、
// 新しい head に「1回拒んだ」印を付ける —— 立て直した question への次の `merge` はそのまま取り込みへ進む
it("最初の「merge」の拒否の後に記録済みの PR の head がまた書き換えられれば、次の「merge」は text A4b で拒まれて足された commit と立て直した question を名指し、`board/origin/task/<root>` を新しい head へ引き直し、作業台で merge した後の立て直した question への「merge」が取り込んで merge する", async () => {
  const c = await pushedRoot("outside-rewrite-moved-again", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  await moveRecordedHead(c, "rewritten");
  await convergeOn(c.landing, c.work.id);
  const asked = listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)!;
  await c.answerMerge();
  const moved = await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${c.pushed}~1`), "outside-again.txt");

  const refusal = await c.answerMerge();

  const [replacement] = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  expect(replacement!.id).not.toBe(asked.id);
  expect(getTask(c.db, asked.id)?.status).toBe("done");
  expect(refusal).not.toContain("did not push"); // ADR 0401 決定3
  expect(refusal).toBe(
    `${textA4b(c, moved, c.target, replacement!.id)} These commits on it are not in the board's push record: ${moved} add outside-again.txt. ` +
      `This question is closed — question ${replacement!.id} now asks about this head.`,
  );
  expect(git(c.workbench(), "rev-parse", `board/origin/${c.target}`)).toBe(moved);
  c.expectNothingCarried();

  c.mergeInWorkbench();
  expect(await c.answerMerge()).toBeUndefined();
  expect(c.github.mergedHeads).toEqual([forkHead(c.workspace, c.work.id)]);
  expect(git(c.workspace.path, "show", `${c.target}:outside-again.txt`)).toBe("pushed on GitHub");
});

// ADR 0394 決定3 / #3485: 内容が落ちた head の question への `merge` は、寄り道の後に外の部分が無しのときだけ通す —— 寄り道の push の後に
// head が動けば、同じ書き換えへ戻されても、人間の見ていない head を merge しない
it.each([
  ["同じ書き換え", false],
  ["別の書き換え", true],
] as const)("作業台で merge した後の「merge」が取り込んで push した後、2回目の読みの前に head が%sの sha へ差し替えられれば、merge されず拒まれる", async (_, another) => {
  const c = await pushedRoot(`outside-rewrite-moved-during-detour-${another}`, { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const head = await moveRecordedHead(c, "rewritten");
  await convergeOn(c.landing, c.work.id);
  const asked = listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)!;
  await c.answerMerge();
  c.mergeInWorkbench();
  const swapped = another ? git(c.workspace.path, "rev-parse", `${c.pushed}~1`) : head;
  afterEachPush(c.github, () => c.github.scriptHead(1, swapped));

  const refusal = await c.answerMerge();

  expect(refusal).toMatch(new RegExp(`^took your merge in and pushed ${c.target}; PR #1's head was (rewritten|moved) outside the board to ${swapped}`));
  expect(c.github.merged).toEqual([]);
  const open = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  expect(open).toHaveLength(1);
  if (another) {
    expect(open[0]!.id).not.toBe(asked.id);
    expect(refusal).toContain(`This question is closed — question ${open[0]!.id} now asks about this head`);
    expect(refusal).not.toContain("answer `merge` again");
  } else {
    expect(open[0]!.id).toBe(asked.id);
  }
});

// ADR 0394 決定1・3: 外の部分は sha と種類の組で比べる —— 問うた時の種類のまま執行すると、寄り道を通さずに内容の落ちた head を merge する
it("盤面が push していない head と問うた sha が、取り込みの後に内容が落ちた head と読めれば、「merge」は拒まれ、作業台を開いて立て直した question を名指す", async () => {
  const c = await pushedRoot("outside-head-reads-rewritten-after-intake", { pr: "recorded", merge: "auto_if_ci_green" });
  const head = await pushOutsideBoard(c.workspace, c.work.id);
  await c.landing.tick("auto_merge");
  const asked = listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)!;
  expect(asked.purpose).toContain(`PR #1's head ${head} holds commits not in the board's push record`);
  await convergeOn(c.landing, c.work.id);
  const [failure] = promotionFailures(c.db, c.work.id);
  c.mergeInWorkbench();
  expect(await c.retry(failure!)).toBeUndefined();
  (await outsideClone(c.workspace)).push(`${head}:refs/heads/${c.target}`);

  const refusal = await c.answerMerge();

  const open = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  expect(open).toHaveLength(1);
  expect(open[0]!.id).not.toBe(asked.id);
  expect(getTask(c.db, asked.id)?.status).toBe("done");
  expect(refusal).toMatch(new RegExp(`^PR #1's head was moved outside the board to ${head}, .* The board opened the workbench at `));
  expect(refusal).toContain(`This question is closed — question ${open[0]!.id} now asks about this head`);
  expect(refusal).not.toContain("answer `merge` again");
  expect(c.github.merged).toEqual([]);
});

// ADR 0394 決定3: 寄り道の中で収束が読んだ head が問うた書き換えと違えば、収束が立て直して拒む —— 回答の拒否は1回で、作業台の印もその head に付く
it("作業台で merge した後の「merge」の寄り道で収束が head を読む前に別の書き換えへ動かされれば、立て直した question を名指して1回だけ拒まれ、作業台で merge した後のその question への「merge」がそのまま取り込んで merge する", async () => {
  const c = await pushedRoot("outside-rewrite-moved-before-detour-read", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  const head = await moveRecordedHead(c, "rewritten");
  await convergeOn(c.landing, c.work.id);
  const asked = listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)!;
  await c.answerMerge();
  c.mergeInWorkbench();
  const outside = await outsideClone(c.workspace);
  const moved = await pushOutsideBoard(c.workspace, c.work.id, git(c.workspace.path, "rev-parse", `${c.pushed}~1`), "outside-again.txt");
  git(outside.clone, "fetch", "--quiet", "origin");
  outside.push(`${head}:refs/heads/${c.target}`);
  // 回答は問うた head を読み、収束はその後に動いた head を読む
  const read = c.github.readPullRequest.bind(c.github);
  c.github.readPullRequest = async (ref) => {
    const status = await read(ref);
    c.github.readPullRequest = read;
    outside.push(`${moved}:refs/heads/${c.target}`);
    return status;
  };

  const refusal = await c.answerMerge();

  const [replacement] = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);
  expect(replacement!.id).not.toBe(asked.id);
  expect(getTask(c.db, asked.id)?.status).toBe("done");
  expect(refusal).toBe(
    `${textA4b(c, moved, c.target, replacement!.id)} These commits on it are not in the board's push record: ${moved} add outside-again.txt. ` +
      `This question is closed — question ${replacement!.id} now asks about this head.`,
  );
  c.expectNothingCarried();

  c.mergeInWorkbench();
  expect(await c.answerMerge()).toBeUndefined();
  expect(c.github.mergedHeads).toEqual([forkHead(c.workspace, c.work.id)]);
});

// ADR 0394 決定3 / ADR 0376 Status 追記: 外の部分が無ければ head は盤面の push した値 —— 理由が消えた question への `merge` は寄り道を通さずに
// 執行し、`external` の根でも merge する
it.each(["auto_if_ci_green", "external"] as const)("落とされた commit を出元 repo へ push し直した後の、内容が落ちた head の question への「merge」は、merge dial が %s でも取り込まずにそのまま merge する", async (merge) => {
  const c = await pushedRoot(`outside-rewrite-repushed-${merge}`, { pr: "recorded", commits: 2, merge });
  await moveRecordedHead(c, "rewritten");
  await convergeOn(c.landing, c.work.id);
  const asked = listBoard(c.db).find((q) => q.question_pending_merge_pr === 1)!;
  (await outsideClone(c.workspace)).push(`${c.pushed}:refs/heads/${c.target}`);
  expect(await convergeOn(c.landing, c.work.id)).toMatchObject({ kind: "landed", form: "open_pull_request_updated" });

  expect(await c.answerMerge()).toBeUndefined();

  expect(c.github.mergedHeads).toEqual([forkHead(c.workspace, c.work.id)]);
  expect(getTask(c.db, asked.id)?.status).toBe("done");
  expect(listEventsOfKinds(c.db, ["workbench_taken_in"])).toEqual([]);
});

// ADR 0376 Status 追記 / spec #3273 pin D11: 問いは head についてで、誰が merge するかについてではない —— `external` の根にも立ち、`merge` は
// dial を読まずに取り込み、push し、PR を merge する
it("merge dial が external の根でも、書き換えられた記録済みの PR に推奨 hold の merge question が立ち、作業台で merge した後の「merge」が取り込んで push し PR を merge する", async () => {
  const c = await pushedRoot("outside-rewrite-external", { pr: "recorded", commits: 2, merge: "external" });
  expect(mergeQuestions(c.db)).toEqual([]);
  const head = await moveRecordedHead(c, "rewritten");

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });
  expect(mergeQuestions(c.db)).toEqual([{ pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: textA4c(c.target) }]);
  expect(await c.answerMerge()).toBe(textA4b(c, head, c.target));
  c.mergeInWorkbench();
  expect(await c.answerMerge()).toBeUndefined();

  expect(c.github.mergedHeads).toEqual([forkHead(c.workspace, c.work.id)]);
  expect(git(c.workspace.path, "show", `${c.target}:outside.txt`)).toBe("pushed on GitHub");
});

// ADR 0217 決定1・3 / spec #3273 group D: 収束は tick と同じく profile → 門を読み直してから問う —— 読めない profile は agent の Quarantine に、
// head を読む間に閉じた門は待ちになり、どちらも question を立てない
it.each(UNRESOLVABLE_AGENT)("記録済みの PR の head が書き換えられた根の profile が解決できなければ(%s)、収束は merge question を立てず agent を quarantine に落とす", async (_kind, error) => {
  const resolveAuthority = (): AuthorityProfile => {
    throw error("tako");
  };
  const c = await pushedRoot("outside-rewrite-unresolved-profile", { pr: "recorded", commits: 2, resolveAuthority });
  await moveRecordedHead(c, "rewritten");

  expect(await convergeOn(c.landing, c.work.id)).toMatchObject({ kind: "quarantined" });

  expect(mergeQuestions(c.db)).toEqual([]);
  expect(promotionFailures(c.db, c.work.id)).toEqual([]);
  expect(quarantineQuestion(c.db, "agent", "tako")).toBeDefined();
  c.expectNothingCarried();
});

it("記録済みの PR の head を読む間に門が閉じれば、収束は merge question を立てずに待つ", async () => {
  const c = await pushedRoot("outside-rewrite-gate-closes", { pr: "recorded", commits: 2, merge: "auto_if_ci_green" });
  await moveRecordedHead(c, "rewritten");
  const read = c.github.getPullRequestState.bind(c.github);
  c.github.getPullRequestState = async (ref) => {
    const state = await read(ref);
    attachUnsettledChild(c.db, c.clock, c.work.id);
    return state;
  };

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "deferred", reason: "attached_children", count: 1 });

  expect(mergeQuestions(c.db)).toEqual([]);
  expect(promotionFailures(c.db, c.work.id)).toEqual([]);
  c.expectNothingCarried();
});

// spec #3273 pin D5 / text A4d: 未 push の修理が重なっても同じで、文は落とされた内容と未 push の内容を分ける
it("外の push が修理を落とした記録済みの PR に未 push の修理が重なれば、収束は push せず推奨 hold の merge question を立て、本文は落とされた修理と未 push の修理を分けて名指す", async () => {
  const { c, repair } = await droppedRepair("outside-drop-with-unpushed");
  const unpushed = await settleRepairNotMergedBack(c.db, c.clock, c.workspace, c.work.id, "unpushed.txt");
  tearDownRepair(c.db, c.clock, c.workspace, unpushed);
  const local = git(c.workspace.path, "rev-parse", c.target);

  expect(await convergeOn(c.landing, c.work.id)).toEqual({ kind: "landed", form: "merge_question", prNumber: 1 });

  expect(mergeQuestions(c.db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_ACTOR_ID, "board"],
      recommendation: "hold",
      purpose: textA4c(`task/${repair.id} (dropped by the outside push) and of task/${unpushed.id} (not pushed by the board yet)`),
    },
  ]);
  expect(promotionFailures(c.db, c.work.id)).toEqual([]);
  expect(git(c.workspace.path, "rev-parse", c.target)).toBe(local);
  expect(forkHead(c.workspace, c.work.id)).toBe(c.pushed);
});

// spec #3273 pin D7: 取り込みが読むのは今の head —— 作業台の ref ではない
it("作業台で merge した後に出元 repo のタスクブランチがまた進めば、retry は `board/origin/task/<root>` を名指して拒まれ、その ref を新しい head へ引き直し、何も書かず、それを merge した次の retry が通る", async () => {
  const c = await pushedRoot("outside-commits-moved-again");
  await pushOutsideBoard(c.workspace, c.work.id);
  await convergeOn(c.landing, c.work.id);
  const [failure] = promotionFailures(c.db, c.work.id);
  c.mergeInWorkbench();
  const moved = await pushOutsideBoard(c.workspace, c.work.id, undefined, "outside-again.txt");

  const refusal = await c.retry(failure!);

  expect(refusal).toContain(
    `the workbench at ${c.workbench()} is not ready: ${c.target} there does not contain ${c.target} on head repo ${c.workspace.head_repo} (\`board/origin/${c.target}\`). Run \`git merge board/origin/${c.target}\` there`,
  );
  expect(git(c.workbench(), "rev-parse", `board/origin/${c.target}`)).toBe(moved);
  expect(getTask(c.db, failure!.id)?.status).toBe("todo");
  c.expectNothingCarried();

  c.mergeInWorkbench();
  expect(await c.retry(failure!)).toBeUndefined();

  expect(forkHead(c.workspace, c.work.id)).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(git(c.workspace.path, "show", `${c.target}:outside-again.txt`)).toBe("pushed on GitHub");
});

// ADR 0376 決定8 / spec #3273 pin D7: 順は「人間の tip の取り込み → 追いつき → push」—— 追いつきが先なら、収束は conflict の文(text A2)で
// 止まり、retry は人間の tip が書く先の新しい値を欠くとして拒む
it("追いつきが conflict する根でも収束は先に出元 repo の head を確かめて text D1 で止まり、人間の tip が origin の保護ブランチも含めば、retry の追いつきは何も足さず取り込んだ commit がそのまま push される", async () => {
  const c = await catchUpConflictRoot("outside-commits-before-catch-up");
  git(c.workspace.path, "push", "head-repo", c.target);
  const head = await pushOutsideBoard(c.workspace, c.repair.id);
  const before = git(c.workspace.path, "rev-parse", c.target);
  const workbench = () => realpathSync(workbenchPath(c.workbenchBase, { task: c.repair.id }, `origin/${c.target}`));

  await convergeOn(c.landing, c.repair.id);

  const [failure] = promotionFailures(c.db, c.repair.id);
  expect(failure!.purpose).toContain(`Head repo ${c.workspace.head_repo}'s ${c.target} holds commits the board did not push (${head}).`);
  expect(git(c.workspace.path, "rev-parse", c.target)).toBe(before);

  git(workbench(), "merge", "--quiet", "--no-edit", `board/origin/${c.target}`);
  expect(() => git(workbench(), "merge", "board/origin/main")).toThrow();
  writeFileSync(join(workbench(), "repair.txt"), "protected version\n");
  git(workbench(), "add", "repair.txt");
  git(workbench(), "commit", "--no-edit");
  const tip = git(workbench(), "rev-parse", "HEAD");
  await answerPromotion(c.db, c.clock, c.landing, c.workspace, failure!, "retry");

  expect(getTask(c.db, failure!.id)?.status).toBe("done");
  expect(git(c.workspace.path, "rev-list", "--parents", "-n", "1", c.target).split(" ").slice(1)).toEqual([before, tip]);
  expect(forkHead(c.workspace, c.repair.id)).toBe(git(c.workspace.path, "rev-parse", c.target));
  expect(existsSync(workbenchPath(c.workbenchBase, { task: c.repair.id }, "origin/main"))).toBe(false);
});

it("追いつき merge をまたいで走るセッションは、盤面が動かした task branch で quarantine されない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-catch-up-straddle");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const parent = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, parent.id);
  commitWork(workspace.path, "feature.txt", "parent result\n");
  completeTask(db, parent, FULL_HANDOFF, "worker", clock.now(), "worker");
  recordPrOpenedOutsideConvergence(db, parent, 1, clock.now());
  const repair = attachUnsettledChild(db, clock, parent.id);
  checkoutTaskBranch(db, workspace, repair.id, `task/${parent.id}`);
  await squashTaskIntoOrigin(workspace, parent.id);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  const before = git(workspace.path, "rev-parse", `task/${repair.id}`);
  finish(db, clock, repair);

  await straddle(db, clock, workspace, () => landing.converge());

  expect(git(workspace.path, "rev-parse", `task/${repair.id}^1`)).toBe(before);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
});

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

it("PR の merge question は問うた根の付帯子で塞がる", async () => {
  const { db, clock } = await openBoard();
  const work = landingWork(db, clock);
  recordPrOpenedOutsideConvergence(db, work, 7, clock.now());
  const question = mergeQuestion(db, clock, { pending_merge_pr: 7, root: work.id });
  expect(landingAnnotation(db, question)).toEqual({ blocked_by: null });

  attachUnsettledChild(db, clock, work.id);

  expect(landingAnnotation(db, question)).toEqual({ blocked_by: "attached_children" });
});

it("PR を開いた後の merge question も、CI red で止まった auto-merge の merge question も盤面の名義・経路で登録される(ADR 0194 決定3)", async () => {
  const workspace = await makeWorkspace("landing-merge-question-registrant");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  github.scriptCiStatus("failure");
  recordPrOpenedOutsideConvergence(db, landingWork(db, clock), 1, clock.now(), { authority: { merge: "escalate" } });
  recordPrOpenedOutsideConvergence(db, landingWork(db, clock), 2, clock.now(), { authority: { merge: "auto_if_ci_green" } });

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => ({ name: "standard", guidance: "", merge: "auto_if_ci_green" }),
  }).tick("auto_merge");

  const registered = listBoard(db)
    .filter((q) => q.question_pending_merge_pr !== null)
    .map((q) => {
      const { actor_id, origin } = listEvents(db, q.id).find((e) => e.kind === "task_registered")!;
      return [q.question_pending_merge_pr, actor_id, origin];
    });
  expect(registered).toEqual([
    [1, BOARD_ACTOR_ID, "board"],
    [2, BOARD_ACTOR_ID, "board"],
  ]);
});

it("宣言 repo が registry と同じ repo の PR は flag が無くても人間の merge question になる(ADR 0377 決定5 / ADR 0381 決定1)", async () => {
  const { workspace } = await makeLandingWorkspace("landing-registry-edit");
  const registryDir = await makeRegistry();
  git(registryDir, "remote", "add", "origin", git(workspace.path, "config", "remote.origin.url"));
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = landingWork(db, clock, workspace.name);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
    isProtectedWorkspace: (name) => name === workspace.name && workspaceProtectionReader(registryDir)({ repo: workspace.repo }, workspace.path) !== undefined,
  });

  expect(await convergeOn(landing, work.id)).toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(mergeQuestions(db)).toMatchObject([
    { pr: 1, recommendation: "merge", purpose: expect.stringContaining("always needs a human merge") },
  ]);
});

it("宣言が registry の repo の workspace は、pickup の後に origin を別の repo へ向け替えても人間の merge question になり、盤面は merge しない(ADR 0381 決定1)", async () => {
  const { workspace } = await makeLandingWorkspace("landing-registry-repointed");
  const other = await makeLandingWorkspace("landing-registry-repointed-other");
  const registryDir = await makeRegistry();
  git(registryDir, "remote", "add", "origin", workspace.repo!);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = landingWork(db, clock, workspace.name);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  // pickup の後の向け替え —— 基準の行の無い名前なら、着地の最初の撮りの開く前の項が止める(ADR 0399 決定7)
  await leaveBaseline(db, workspace);
  git(workspace.path, "remote", "set-url", "origin", other.workspace.repo!);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
    isProtectedWorkspace: (name) => name === workspace.name && workspaceProtectionReader(registryDir)({ repo: workspace.repo }, workspace.path) !== undefined,
  });

  expect(await convergeOn(landing, work.id)).toMatchObject({ kind: "landed", form: "pull_request_opened" });
  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toMatchObject([
    { pr: 1, recommendation: "merge", purpose: expect.stringContaining("always needs a human merge") },
  ]);
  // ADR 0378 決定1: タスクブランチは向け替えた先ではなく宣言の registry の repo に届く
  expect(git(workspace.head_repo!, "rev-parse", `refs/heads/task/${work.id}`)).toBe(git(workspace.path, "rev-parse", `task/${work.id}`));
  expect(git(other.workspace.repo!, "for-each-ref", "refs/heads/task")).toBe("");
});

// 着地の面(question)の理由 3 つは、question 本文の違いだけで区別される。本文を逐語で釘付けする。
it("PR を開いた時点で question 面に倒れた理由は、保護・ダイヤル・risk のそれぞれの本文で merge question に残る", async () => {
  const { db, clock } = await openBoard();
  recordPrOpenedOutsideConvergence(db, landingWork(db, clock), 1, clock.now(), {
    authority: { merge: "auto_if_ci_green" },
    isProtected: true,
  });
  recordPrOpenedOutsideConvergence(db, landingWork(db, clock), 2, clock.now(), {
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
  recordPrOpenedOutsideConvergence(db, risky, 3, clock.now(), {
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

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_ACTOR_ID, "board"],
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

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_ACTOR_ID, "board"],
      recommendation: "merge",
      purpose: expect.stringMatching(/queued.*landing surface changed.*escalate/),
    },
  ]);
});

it("キュー投入の後に registry と同じ repo の workspace が保護された PR は、CI 緑でも盤面の名義の merge question になる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-protected-after-queue");
  const registryDir = await makeRegistry();
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1, workspace);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
    isProtectedWorkspace: (name) => name === workspace.name && workspaceProtectionReader(registryDir)({ repo: workspace.repo }, workspace.path) !== undefined,
  });

  git(registryDir, "remote", "add", "origin", git(workspace.path, "config", "remote.origin.url"));
  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_ACTOR_ID, "board"],
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

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "auto_merge_withdrawn")
      .map(({ actor_id, origin, payload }) => ({ actor_id, origin, payload })),
  ).toEqual([
    {
      actor_id: BOARD_ACTOR_ID,
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
  }).tick("auto_merge");

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

  await landing.tick("auto_merge");

  expect(github.ciChecks).toHaveLength(1);
  expect(await readOnNextTick(landing, github)).toEqual([]);
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

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(mergeQuestions(db)).toEqual([
    { pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: CI_RED_PURPOSE },
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

  await landing.tick("auto_merge");

  expect(await readOnNextTick(landing, github)).toEqual([]);
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

  await landing.tick("auto_merge");

  expect(await readOnNextTick(landing, github)).toEqual([]);
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

  await landing.tick("auto_merge");

  expect(await readOnNextTick(landing, github)).toEqual([1]);
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
  }).tick("auto_merge");

  expect(github.ciChecks).toHaveLength(1);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});

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

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([]);
  expect(
    listEvents(db, work.id)
      .filter((e) => e.kind === "auto_merge_withdrawn")
      .map(({ actor_id, origin, payload }) => ({ actor_id, origin, payload })),
  ).toEqual([
    {
      actor_id: BOARD_ACTOR_ID,
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

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([
    { pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: CI_RED_PURPOSE },
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

  await landing.tick("auto_merge");
  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");

  completeTask(db, child!, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge");
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

  await landing.tick("auto_merge");
  expect(logged).toHaveBeenCalledWith(expect.stringContaining("auto-merge of PR #1 "), expect.any(Error));

  db.exec("DROP TRIGGER fail_question");
  await landing.tick("auto_merge");
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});

it("merge に失敗した開いたままの PR は、tick を落とさずキューを外れて失敗を本文に書いた推奨 hold の merge question になり、後ろの PR は同じ tick で merge される", async () => {
  const workspace = await makeWorkspace("landing-merge-fails-open");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  queueAutoMerge(db, clock, 1);
  queueAutoMerge(db, clock, 2);
  github.scriptMergeFailure(1, new Error(CONFLICT));

  const landing = autoMerging(db, clock, workspace, github);
  await expect(landing.tick("auto_merge")).resolves.toBeUndefined();

  // PR #1 は merge の失敗の後に同じ読み取りで読み直される(ADR 0231 決定1)
  expect(github.ciChecks.map((ref) => ref.number)).toEqual([1, 1, 2]);
  expect(github.merged).toEqual([{ path: workspace.path, number: 2 }]);
  expect(await readOnNextTick(landing, github)).toEqual([]);
  expect(mergeQuestions(db)).toEqual([
    {
      pr: 1,
      registrant: [BOARD_ACTOR_ID, "board"],
      recommendation: "hold",
      // spec #3273 text A6: どの失敗でも、conflict した PR を head への merge で解く道を足す
      purpose: `"ship"'s auto_if_ci_green auto-merge could not merge PR #1: ${CONFLICT}. Merge once it is fixed, or hold? If PR #1 conflicts with main, merge main into the PR's head in your own clone and push it — do not rebase or force-push; the board treats such a head as rewritten outside — then answer \`merge\`: the board refuses it, listing the commits you pushed, and closes this question — answer \`merge\` on the new question it names to merge.`,
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

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.ciChecks).toHaveLength(1);
  expect(github.stateChecks).toEqual([]);
  expect(github.merged).toEqual([]);
  expect(await readOnNextTick(landing, github)).toEqual([]);
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
  await landing.tick("auto_merge");

  expect(github.stateChecks).toEqual([]);
  expect(await readOnNextTick(landing, github)).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merge_observed", pr_number: 1 } },
  ]);
});

// ADR 0265 決定5(#1820): merge の後・記録の前に落ちた盤面の merge は、再起動後に執行として刻む
it("盤面の名義(app/tidepool-board)で merge 済みの PR がキューに残っていれば、行為の前の読み取りで pr_merged を根に刻んでキューを外れる", async () => {
  const workspace = await makeWorkspace("landing-board-merged-queued");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  github.scriptMergedByBoard(1);

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(await readOnNextTick(landing, github)).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_merged")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merged", pr_number: 1 } },
  ]);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([]);
});

it("CI を読んだ後に閉じられて merge が失敗した PR は、読み直した状態で閉じた観測になり question を立てない", async () => {
  const workspace = await makeWorkspace("landing-closed-during-merge");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  afterCiRead(github, () => github.scriptClosedOutside(1));

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge");

  // CI の読みと、merge の失敗の後の読み直し(ADR 0231 決定1)
  expect(github.ciChecks).toHaveLength(2);
  expect(github.stateChecks).toEqual([]);
  expect(await readOnNextTick(landing, github)).toEqual([]);
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
  await landing.tick("auto_merge");

  expect(await readOnNextTick(landing, github)).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merge_observed", pr_number: 1 } },
  ]);
  expect(boardEvents(db, work.id, "pr_merged")).toEqual([]);
});

it("merge が失敗した後の読み直しで盤面の名義で merge 済みと読めた PR は、pr_merged を根に刻んでキューを外れる(ADR 0265 決定5)", async () => {
  const workspace = await makeWorkspace("landing-board-merged-during-merge");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const work = queueAutoMerge(db, clock, 1);
  afterCiRead(github, () => github.scriptMergedByBoard(1));

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge");

  expect(await readOnNextTick(landing, github)).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_merged")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merged", pr_number: 1 } },
  ]);
  expect(boardEvents(db, work.id, "pr_merge_observed")).toEqual([]);
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
  await expect(landing.tick("auto_merge")).resolves.toBeUndefined();

  expect(logged).toHaveBeenCalledWith(expect.stringContaining("auto-merge of PR #1 "), expect.any(Error));
  expect(await readOnNextTick(landing, github)).toEqual([1]);
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
  await landing.tick("auto_merge");

  expect(await readOnNextTick(landing, github)).toEqual([]);
  expect(mergeQuestions(db).map((q) => [q.pr, q.recommendation])).toEqual([[1, "hold"]]);
});

// ADR 0231 決定1: head が動いたことは次の tick で新しい head の CI を読む理由であって、人間に問うことではない
it("CI を読んだ後に head が動いた PR は merge されず、question も event も残さずキューに残り、次の tick で新しい head の CI が緑なら新しい head で merge される", async () => {
  const workspace = await makeWorkspace("landing-head-moved");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  // どちらの head も盤面が push した head(ADR 0387 決定1)—— PR を開いた head と、CI を読んだ後に盤面が push した head。盤面の push の
  // 記録は tick が印を放した後に書かれる(ADR 0387 決定4)
  const work = landingWork(db, clock);
  recordPrOpenedOutsideConvergence(db, work, 1, clock.now(), { authority: { merge: "auto_if_ci_green" }, head: "ci-read-head" });
  github.scriptHead(1, "ci-read-head");
  afterCiRead(github, () => github.scriptHead(1, "pushed-after-ci-read"));

  const landing = autoMerging(db, clock, workspace, github);
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(autoMergeOutcomeEvents(db, work.id)).toEqual([]);

  appendEvent(db, { taskId: work.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_branch_pushed", pr_number: 1, sha: "pushed-after-ci-read" }, at: clock.now() });
  expect(await readOnNextTick(landing, github)).toEqual([1]);
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
  await expect(landing.tick("auto_merge")).resolves.toBeUndefined();

  expect(logged).toHaveBeenCalledWith(expect.stringContaining("auto-merge of PR #1 "), expect.any(Error));
  expect(github.merged).toEqual([{ path: workspace.path, number: 2 }]);
  github.readPullRequest = readPullRequest;
  expect(await readOnNextTick(landing, github)).toEqual([1]);
});
