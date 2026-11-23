
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents, listEventsOfKinds } from "../src/events.js";
import { GitHubAuth } from "../src/github-auth.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import {
  contentLeftBehindLocally,
  createLanding,
  registerPrPromotionFailureQuestion,
  taskIdsAwaitingLandingInWorkspace,
} from "../src/landing.js";
import { openQuarantineValues } from "../src/quarantine.js";
import { type AuthorityProfile, type MergeDial, } from "../src/registry.js";
import {
  cancelTaskDirectly,
  completeTask,
  getTask,
  listBoard,
  lostTaskIsTransparent,
  pickupTask,
  registerTask,
  type Task,
} from "../src/tasks.js";
import { markTeardown } from "../src/teardown.js";
import { workbenchPath } from "../src/workbench.js";
import {
  boardRefWriter,
  holdsBaseline,
  mergeTaskToProtected,
  OutOfBandProtectedBranchError,
  quarantineWorkspace,
  recordTaskCheckoutTip,
  redoMergeBacks,
  releaseWorkspace,
  UnknownWorkspaceError,
  type WorkspaceConfig,
  writeBoardRefs,
} from "../src/workspace.js";
import { afterCiRead, awaitWindow, FakeClock, FakeGitHubClient, UNRESOLVABLE_AGENT, unusedLanding } from "./fakes.js";
import {
  CLEAN_LANDING_INTAKE,
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
} from "./harness.js";
import {
  afterEachPush,
  agentQuarantines,
  answerLocalMerge,
  answerMergeQuestion,
  answerPromotion,
  answerWorkspaceQuarantine,
  attachUnsettledChild,
  autoMerging,
  boardEvents,
  breakPackedRefs,
  CI_RED_PURPOSE,
  CONFLICT,
  closeObserved,
  commitOutOfBand,
  commitThroughTaskCheckout,
  convergeOn,
  droppedRepair,
  failPrepareOnce,
  fetchHeldAtToken,
  finish,
  forkHead,
  HUMAN_ANSWERER,
  head,
  landingWork,
  landLocally,
  mergeOnGitHub,
  mergeQuestions,
  openBoard,
  openLocalMergeQuestions,
  openPushedPr,
  profile,
  promotionFailures,
  pushedRoot,
  pushOutsideBoard,
  pushPrHead,
  queueAutoMerge,
  readOnNextTick,
  recordPrOpenedOutsideConvergence,
  settleRepairNotMergedBack,
  tearDownRepair,
  textA4a,
  textA4c,
  unreadableRefsRefusal,
  unresolvable,
} from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

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
  await landing.tick("auto_merge");

  expect(await readOnNextTick(landing, github)).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "auto_merge_withdrawn")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "auto_merge_withdrawn", pr_number: 1, merge: "external" } },
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
  recordPrOpenedOutsideConvergence(db, root, prNumber, clock.now(), { authority: { merge: "escalate" } });
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

  await autoMerging(db, clock, workspace, github).tick("outside_merge");

  expect(getTask(db, question.id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, question.id).map((e) => e.kind)).not.toContain("question_answered");
  expect(boardEvents(db, question.id, kind)).toEqual([]);
  expect(boardEvents(db, root.id, kind)).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind, pr_number: 1 } },
  ]);
});

// ADR 0265 決定5(#1820): merge 回答の merge の後・記録の前に落ちた盤面。回答の記録は失われているので question は観測の経路で閉じる
it("遅い走査は、盤面の名義で merge 済みの PR の open な merge question を回答なしで閉じ、pr_merged を根に刻む", async () => {
  const workspace = await makeWorkspace("landing-scan-board-merged");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const { root, question } = escalatedRoot(db, clock, 1);
  github.scriptMergedByBoard(1);

  await autoMerging(db, clock, workspace, github).tick("outside_merge");

  expect(getTask(db, question.id)).toMatchObject({ status: "done", question_answer: null });
  expect(listEvents(db, question.id).map((e) => e.kind)).not.toContain("question_answered");
  expect(boardEvents(db, root.id, "pr_merged")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_merged", pr_number: 1 } },
  ]);
  expect(boardEvents(db, root.id, "pr_merge_observed")).toEqual([]);
});

it("別の workspace の同じ番号の PR の観測は、それぞれの workspace の根に1件ずつ刻まれ混ざらない", async () => {
  const workspace = await makeWorkspace("landing-scan-same-number");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const here = escalatedRoot(db, clock, 1, "here");
  const there = escalatedRoot(db, clock, 1, "there");
  github.scriptClosedOutside(1);
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: () => workspace, github });

  await landing.tick("outside_merge");

  expect(boardEvents(db, here.root.id, "pr_close_observed")).toEqual(closeObserved(1));
  expect(boardEvents(db, there.root.id, "pr_close_observed")).toEqual(closeObserved(1));
});

// #2026: 外で閉じた escalate の根の閉じた記録が question の側にあり、収束が読めずに撃ち続けていた
it("遅い走査が外で閉じたと観測した escalate の根は、次の収束で候補から外れ、git も読まれず verdict にも出ない", async () => {
  const { workspace, db, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-closed-root");
  expect(listBoard(db).filter((q) => q.question_pending_merge_pr === 1)).toHaveLength(1);
  github.scriptClosedOutside(1);
  const pushes = github.pushes.length;

  await landing.tick("outside_merge");
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
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github, () => profile("escalate"));
  const root = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, root.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, root);
  await landing.converge();
  return { workspace, db, clock, github, landing, root: getTask(db, root.id)! };
}

// 観測の重複除け: 根の決着は経路の順によらず1件だけ刻まれ、question は回答なしの done で閉じる
it("収束が先に閉じた PR を観測した根の merge question は、遅い走査が回答なしで閉じ、根に閉じた観測を重ねない", async () => {
  const { workspace, db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-converge-then-scan");
  await commitThroughTaskCheckout(db, clock, workspace, root, "repair.txt", "fixed\n");
  github.scriptClosedOutside(1);
  const question = listBoard(db).find((q) => q.question_pending_merge_pr === 1)!;

  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ reason: "pull_request_closed" });
  expect(getTask(db, question.id)!.status).toBe("todo");
  await landing.tick("outside_merge");

  expect(getTask(db, question.id)).toMatchObject({ status: "done", question_answer: null });
  expect(boardEvents(db, root.id, "pr_close_observed")).toEqual(closeObserved(1));
});

it("収束が PR の状態を読んでいる間に遅い走査が閉じた観測を刻めば、収束は観測を重ねない", async () => {
  const { workspace, db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-during-converge");
  await commitThroughTaskCheckout(db, clock, workspace, root, "repair.txt", "fixed\n");
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
  await landing.tick("outside_merge");
  gate.open();

  await expect(converging).resolves.toMatchObject({ reason: "pull_request_closed" });
  expect(boardEvents(db, root.id, "pr_close_observed")).toEqual(closeObserved(1));
});

// ADR 0265 決定6: 閉じた根の付帯子は cancel せず、観測の時点で走らない子と出口2つを判断行で言う
it("遅い走査が外で閉じたと観測した根の下に走らない子があれば、盤面名義の判断行が1行だけ流れ、PR・子・出口2つを言う", async () => {
  const { db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-closed-announce");
  const child = attachUnsettledChild(db, clock, root.id);
  github.scriptClosedOutside(1);

  await landing.tick("outside_merge");
  await landing.tick("outside_merge");
  await landing.converge();

  const lines = boardEvents(db, root.id, "decision_logged");
  expect(lines).toEqual([{ actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "decision_logged", line: expect.any(String) } }]);
  for (const part of ["PR #1", child.id, "reopen", "merge", "cancel"]) expect(lines[0]!.payload).toMatchObject({ line: expect.stringContaining(part) });
});

it("ref が動いていても、回答時に閉じた PR を観測すれば、取り残された子を名指す盤面名義の判断行が1行流れる", async () => {
  const { db, clock, github, landing, root, workspace } = await escalatedRootWithOpenedPr("landing-backstop-closed-announce");
  const child = attachUnsettledChild(db, clock, root.id);
  github.scriptClosedOutside(1);
  git(workspace.path, "tag", "intruder");
  const question = listBoard(db).find((q) => q.question_pending_merge_pr === 1)!;

  await expect(submitAnswer(
    { db, pollNow: () => {}, landing, workspace, github },
    getTask(db, question.id)!,
    ["merge"],
    undefined,
    () => clock.now(),
    "webui",
  )).resolves.toMatchObject({ status: "done", question_answer: null });
  await landing.tick("outside_merge");

  expect(boardEvents(db, root.id, "pr_close_observed")).toEqual(closeObserved(1));
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  const lines = boardEvents(db, root.id, "decision_logged");
  expect(lines).toEqual([{ actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "decision_logged", line: expect.stringContaining(child.id) } }]);
});

// ADR 0405 決定2: 閉じた観測と告知の判断行は1つの transaction —— 判断行が書けなければ観測も刻まれず、次の tick が通り直す
it("quarantine 回答前の観測が閉じた PR を読んでも、取り残された子の判断行が書けなければキューの行を外さず、次の観測が通り直す", async () => {
  const { db, clock, github, landing, work } = await openPrByConvergence("landing-observe-closed-announce-rollback", "auto_if_ci_green");
  const child = attachUnsettledChild(db, clock, work.id);
  github.scriptClosedOutside(1);
  const repair = failEventInsert(db, "decision_logged");

  await expect(landing.observeAutoMergeOutcomes("tako")).rejects.toThrow("decision_logged write failed");
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual([]);

  repair();
  await landing.observeAutoMergeOutcomes("tako");
  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closeObserved(1));
  expect(boardEvents(db, work.id, "decision_logged")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "decision_logged", line: expect.stringContaining(child.id) } },
  ]);
});

it("遅い走査が閉じた PR を観測しても、取り残された子の判断行が書けなければ merge question を開いたまま残し、次の tick が通り直す", async () => {
  const { db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-closed-announce-rollback");
  const child = attachUnsettledChild(db, clock, root.id);
  github.scriptClosedOutside(1);
  const question = listBoard(db).find((q) => q.question_pending_merge_pr === 1)!;
  const repair = failEventInsert(db, "decision_logged");

  await landing.tick("outside_merge");
  expect(getTask(db, question.id)!.status).toBe("todo");
  expect(boardEvents(db, root.id, "pr_close_observed")).toEqual([]);

  repair();
  await landing.tick("outside_merge");
  expect(getTask(db, question.id)!.status).toBe("done");
  expect(boardEvents(db, root.id, "decision_logged")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "decision_logged", line: expect.stringContaining(child.id) } },
  ]);
});

it("遅い走査が外で閉じたと観測した根の下に走らない子が無ければ、判断行は流れない", async () => {
  const { db, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-closed-silent");
  github.scriptClosedOutside(1);

  await landing.tick("outside_merge");

  expect(boardEvents(db, root.id, "pr_close_observed")).toEqual(closeObserved(1));
  expect(boardEvents(db, root.id, "decision_logged")).toEqual([]);
});

it("遅い走査が外で閉じたと観測した根への retry は、閉じたことを理由に verdict で拒まれる", async () => {
  const { db, clock, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-closed-retry");
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  const [failure] = promotionFailures(db, root.id);
  github.scriptClosedOutside(1);

  await landing.tick("outside_merge");

  await expect(convergeOn(landing, root.id, failure!.id)).resolves.toEqual({
    kind: "excluded",
    reason: "pull_request_closed",
    error: `PR #1 was closed outside the board, so task/${root.id} is not pushed to it`,
  });
});

it("遅い走査が外で merge されたと観測した根は、収束が GitHub を読まず観測を重ねずに着地が終わったと刻む", async () => {
  const { workspace, db, github, landing, root } = await escalatedRootWithOpenedPr("landing-scan-merged-finish");
  await mergeOnGitHub(workspace, root.id);
  github.scriptMergedOutside(1);
  await landing.tick("outside_merge");
  const stateChecks = github.stateChecks.length;

  await expect(convergeOn(landing, root.id)).resolves.toEqual({ kind: "nothing_to_land", base: "refs/remotes/origin/main" });
  expect(github.stateChecks).toHaveLength(stateChecks);
  expect(boardEvents(db, root.id, "pr_merge_observed")).toHaveLength(1);
  expect(boardEvents(db, root.id, "landing_finished")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "landing_finished", pr_number: 1, basis: "merge" } },
  ]);
});

it("遅い走査は、workspace の解決が分類できない失敗で落ちた question を open のまま残し、tick は落ちず後ろの question は決着する(ADR 0229 決定1)", async () => {
  const workspace = await makeWorkspace("landing-scan-resolve-throws");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const broken = escalatedRoot(db, clock, 1, "broken").question;
  const { root: blockingRoot, question: closed } = escalatedRoot(db, clock, 2, "healthy");
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

  await expect(landing.tick("outside_merge")).resolves.toBeUndefined();

  expect(getTask(db, broken.id)!.status).toBe("todo");
  expect(getTask(db, closed.id)!.status).toBe("done");
  expect(boardEvents(db, blockingRoot.id, "pr_close_observed")).toEqual(closeObserved(2));
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

  await expect(landing.tick("outside_merge")).resolves.toBeUndefined();

  expect(quarantineQuestion(db, "workspace", "gone")).toBeDefined();
  expect(getTask(db, question.id)!.status).toBe("todo");
});

// issue #3122 の観測: session の後に PR が待つ間の名前の読み手(ADR 0366 決定4)は、tick ごとに読み直しても開いた question に何も足さない
it.each(["auto_merge", "outside_merge"] as const)("%s の poll は drift した workspace の Quarantine を1枚立て、次の tick は何も足さない(ADR 0366 決定1・4)", async (poll) => {
  const { db, clock } = await openBoard();
  if (poll === "auto_merge") queueAutoMerge(db, clock, 1);
  else escalatedRoot(db, clock, 1);
  const landing = createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    resolveWorkspace: (name) => {
      throw new UnknownWorkspaceError(name ?? "reef");
    },
    github: new FakeGitHubClient(),
  });

  await landing.tick(poll);
  await landing.tick(poll);

  const drifted = listBoard(db).filter((q) => q.question_quarantine_kind === "workspace");
  expect(drifted).toHaveLength(1);
  expect(listEvents(db, drifted[0]!.id).map((e) => e.kind)).toEqual(["task_registered"]);
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
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);

  // キューに残っている —— check が緑で報告されれば次の tick で merge される
  github.scriptCiStatus("success");
  await landing.tick("auto_merge");
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
  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([
    { pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: UNREPORTED_PURPOSE },
  ]);
});

it("開いている PR への修理の push は盤面の名義の event に残り、check 未報告の猶予をその push から数え直す", async () => {
  const { workspace } = await makeLandingWorkspace("landing-unreported-repair-push");
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
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  await landing.converge();
  await clock.advance(4 * 60_000);
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "fixed\n");
  await landing.converge();
  github.scriptCiStatus("unreported");

  // PR を開いてから6分、修理の push からは2分
  await clock.advance(2 * 60_000);
  await landing.tick("auto_merge");
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_branch_pushed")).toEqual([
    {
      actor_id: BOARD_ACTOR_ID,
      origin: "board",
      payload: { kind: "pr_branch_pushed", pr_number: 1, sha: git(workspace.path, "rev-parse", `task/${work.id}`) },
    },
  ]);

  await clock.advance(3 * 60_000);
  await landing.tick("auto_merge");
  expect(mergeQuestions(db).map(({ pr, purpose }) => ({ pr, purpose }))).toEqual([
    { pr: 1, purpose: UNREPORTED_PURPOSE },
  ]);
  // 盤面自身の push は記録にある head なので、観測としては刻まない
  expect(boardEvents(db, work.id, "pr_head_observed")).toEqual([]);
});

// ADR 0394 決定1: 書き換えられた head は CI を待たず、最初の読みで問う。
it("書き換えられた head は check 未報告でもすぐにキューを外れて merge question になり、観測は1件だけ刻まれる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-unreported-rewritten-head");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github);
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  await landing.converge();
  const rewritten = await pushOutsideBoard(workspace, work.id, git(workspace.path, "rev-parse", `task/${work.id}~1`));
  github.scriptCiStatus("unreported");

  await clock.advance(6 * 60_000);
  await landing.tick("auto_merge");

  expect(mergeQuestions(db)).toEqual([
    { pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: textA4c(`task/${work.id}`, `task/${work.id} on head repo ${workspace.head_repo}`) },
  ]);
  expect(boardEvents(db, work.id, "pr_head_observed")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_head_observed", pr_number: 1, sha: rewritten } },
  ]);

  await clock.advance(FIVE_MINUTES);
  expect(await readOnNextTick(landing, github)).toEqual([]);
  expect(boardEvents(db, work.id, "pr_head_observed")).toHaveLength(1);
});

// 1件だけの読みは、上の書き換えられた head と人間の merge 回答(human-verbs.test.ts)で述べる —— 外から進んだ head は最初の tick でキューを外れる
it("check が報告中(pending)の盤面の外の head も、読んだ時点で観測として刻まれる", async () => {
  const { workspace } = await makeLandingWorkspace("landing-pending-outside-head");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github);
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  await landing.converge();
  const outside = await pushOutsideBoard(workspace, work.id);
  github.scriptCiStatus("pending");

  await landing.tick("auto_merge");

  expect(boardEvents(db, work.id, "pr_head_observed")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_head_observed", pr_number: 1, sha: outside } },
  ]);
});

it("PR を開いたときの event は、作成前に push したタスクブランチの sha を持つ", async () => {
  const { workspace } = await makeLandingWorkspace("landing-pr-opened-sha");
  const { db, clock } = await openBoard();
  const landing = autoMerging(db, clock, workspace, new FakeGitHubClient());
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
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
  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

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

  await landing.tick("auto_merge");
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");

  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge");
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

  await landing.tick("auto_merge");
  expect(github.ciChecks).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");

  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge");
  // 外れた後の tick で何も重ならない
  await landing.tick("auto_merge");
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

  await landing.tick("auto_merge");
  expect(github.ciChecks).toHaveLength(1);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");

  completeTask(db, child!, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge");
  // 外れた後の tick で何も重ならない
  await landing.tick("auto_merge");
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

  await landing.tick("auto_merge");
  expect(boardEvents(db, work.id, "auto_merge_withdrawn")).toEqual([]);

  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge");
  // 外れた後の tick で何も重ならない
  await landing.tick("auto_merge");
  expect(github.ciChecks).toHaveLength(1);
  expect(mergeQuestions(db)).toEqual([]);
  expect(boardEvents(db, work.id, "auto_merge_withdrawn").map((e) => e.payload)).toEqual([
    { kind: "auto_merge_withdrawn", pr_number: 1, merge: "external" },
  ]);
});

/** #1777 の形: 修理の merge back が後始末で conflict し、workspace が quarantine に落ちる。名前の場所は保護ブランチに、
 *  中断状態なしで残る(ADR 0356 決定5 —— 旧: 着地するタスクのブランチの tip に残った)。解放は修理の task の checkout の基点の下に
 *  作業台を開き(ADR 0373 決定9)、受理も同じ基点を読む(`workbenchBase`)。 */
async function quarantinedByMergeBackConflict(name: string, merge: MergeDial) {
  const pr = await openPushedPr(name, merge);
  const { workspace, db, clock, work } = pr;
  const repair = attachUnsettledChild(db, clock, work.id);
  checkoutTaskBranch(db, workspace, repair.id, `task/${work.id}`);
  commitWork(workspace.path, "repair.txt", "fixed\n");
  git(workspace.path, "checkout", `task/${work.id}`);
  commitWork(workspace.path, "repair.txt", "conflicting\n");
  git(workspace.path, "push", "head-repo", `task/${work.id}`);
  git(workspace.path, "checkout", "main");
  const workbenchBase = await tempDir("tidepool-task-checkouts-");
  const place = await prepareAtPickup(db, workspace, repair, { workspacesBaseDir: workbenchBase });
  completeTask(db, repair, FULL_HANDOFF, "worker", clock.now(), "worker");
  releaseWorkspace(db, place, getTask(db, repair.id)!, clock.now(), true);
  const question = quarantineQuestion(db, "workspace", workspace.name)!;
  return { ...pr, repair: getTask(db, repair.id)!, question, workbenchBase };
}

it("merge back が conflict して後始末が閉じても、修理の内容が merge される head に無ければ積み残しで、CI 緑でも無人 merge されない", async () => {
  const { github, repair, question, landing } = await quarantinedByMergeBackConflict(
    "left-behind-merge-back-conflict",
    "auto_if_ci_green",
  );
  expect(question.purpose).toContain(`task/${repair.id} does not merge cleanly`);

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
});

it("後始末の merge back が conflict しても、MERGE_HEAD を残さず quarantine に落ちる(ADR 0356 決定5)", async () => {
  const { workspace, repair, question } = await quarantinedByMergeBackConflict("merge-back-conflict-leaves-nothing", "escalate");

  // まだ答えていない question なので、出口の文は「答え直す」と結ばない(spec #3273 text A1)
  expect(question.purpose).toContain(`record that with \`git merge -s ours board/task/${repair.id}\`. Then answer. `);
  expect(() => git(workspace.path, "rev-parse", "--verify", "--quiet", "MERGE_HEAD")).toThrow();
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
});

// ADR 0371 決定11: 旧文は名前の場所で merge して答えさせた —— 作業台の在り処と、そこで打つ merge を言う(spec #3273 text A1)
it("merge back の conflict に手を付けないままの受理は、merge back をやり直して conflict し、休止位置へ戻し、作業台と2つの出口を示して拒む", async () => {
  const pr = await quarantinedByMergeBackConflict("redo-merge-back-conflict", "escalate");
  const { workspace, db, work, repair, question } = pr;

  const refused = answerWorkspaceQuarantine(pr, question);

  const workbench = realpathSync(workbenchPath(pr.workbenchBase, { task: work.id }, `task/${repair.id}`));
  await expect(refused).rejects.toThrow(
    new DomainError(
      `task/${repair.id} does not merge cleanly into 'task/${work.id}'. The board opened the workbench at ${workbench} for it. ` +
        `There, on task/${work.id}, run \`git merge board/task/${repair.id}\` and resolve the conflict (or, in your own clone with the ` +
        `workbench as a remote: fetch it, \`git merge <remote>/board/task/${repair.id}\`, and push task/${work.id} to it). Your tip must ` +
        `contain both task/${work.id} as the board has it now (\`board/task/${work.id}\`) and task/${repair.id}, with nothing uncommitted. ` +
        `To discard task/${repair.id}'s work instead, record that with \`git merge -s ours board/task/${repair.id}\`. Then answer again.`,
    ),
  );

  expect(head(workspace)).toBe("main");
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect(contentLeftBehindLocally(db, workspace, work.id, forkHead(workspace, work.id))).toEqual([repair.id]);
  expect(getTask(db, question.id)!.status).toBe("todo");
});

// ADR 0373 決定7 / ADR 0370 決定1: 2回目の比較は merge back のやり直しの fetch の await の後、`task/<id>` を読む直前に掛かる
it("merge back のやり直しの fetch の await の間に人間が動かした子のタスクブランチは、`repaired by hand` の比較が名指して拒み、帰り先へ運ばない(pin B10)", async () => {
  const pr = await openPushedPr("redo-merge-back-moved-in-fetch", "escalate");
  const { workspace, db, clock, work } = pr;
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  quarantineWorkspace(db, workspace.name, new Error("GitHub token acquisition failed"), clock.now());
  const question = quarantineQuestion(db, "workspace", workspace.name)!;
  const parentBefore = git(workspace.path, "rev-parse", `task/${work.id}`);
  let byHand = "";
  // fresh でない token の取得は merge back のやり直しの fetch(後半の fetch は fresh)
  const githubAuth = {
    ensureToken: async (_key: unknown, options?: { fresh?: boolean }) => {
      if (options?.fresh || byHand !== "") return;
      byHand = git(workspace.path, "commit-tree", `task/${repair.id}^{tree}`, "-p", `task/${repair.id}`, "-m", "by hand during the merge-back fetch");
      git(workspace.path, "update-ref", `refs/heads/task/${repair.id}`, byHand);
    },
    env: () => process.env,
  } as unknown as GitHubAuth;

  const refused = submitAnswer(
    { db, pollNow: () => {}, landing: pr.landing, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db, workspace, githubAuth }) },
    getTask(db, question.id)!, ["repaired by hand"], undefined, () => clock.now(), "webui",
  );

  await expect(refused).rejects.toThrow(`refs/heads/task/${repair.id}. The board does not accept moved refs.`);
  expect(byHand).not.toBe("");
  expect(git(workspace.path, "rev-parse", `task/${work.id}`)).toBe(parentBefore);
  expect(getTask(db, question.id)!.status).toBe("todo");
});

it("merge back が走らなかった修理は、受理の検査が帰り先へ merge して休止位置へ戻し、受理する", async () => {
  const pr = await openPushedPr("redo-merge-back-clean", "escalate");
  const { workspace, db, clock, work } = pr;
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  // 名前の場所が休止位置の外に居る(受理の検査が戻す)。旧: 手で出した —— HEAD の移動も ref の違いなので、ADR 0373 決定1 の後は
  // 受理が拒む。盤面の口で出す(基準の HEAD の行も付いてくる)
  writeBoardRefs(db, workspace, [["HEAD", `symref=refs/heads/task/${work.id}`]], () => git(workspace.path, "checkout", "-q", `task/${work.id}`));
  quarantineWorkspace(db, workspace.name, new Error("GitHub token acquisition failed"), clock.now());
  const question = quarantineQuestion(db, "workspace", workspace.name)!;
  const pollNow = vi.fn();

  await answerWorkspaceQuarantine(pr, question, pollNow);

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(pollNow).toHaveBeenCalledOnce();
  expect(head(workspace)).toBe("main");
  // 帰り先は修理が分かれてから動いていない —— merge commit を作らず修理の tip へ ff する
  expect(git(workspace.path, "rev-parse", `task/${work.id}`)).toBe(git(workspace.path, "rev-parse", `task/${repair.id}`));
});

// ADR 0243 決定4・5: 受理の merge back も休止位置の ff も口を通る —— 帰り先の行は merge commit の1値に畳まれる
it.each([
  ["そのままなら、古い基準で解放をやり直しても帰り先も保護ブランチも名指ししない", false],
  ["merge back の前の位置へ手で戻せば、merge commit の値から動いたと名指しする", true],
])("受理の検査がやり直した merge back は、帰り先を先の tip を第1親とする merge commit へ進め、基準をその1値に畳む —— %s", async (_shape, rolledBack) => {
  const pr = await openPushedPr("redo-merge-back-baseline", "escalate");
  const { workspace, db, clock, work } = pr;
  const earlier = landingWork(db, clock);
  const earlierPlace = await prepareAtPickup(db, workspace, earlier);
  commitWork(earlierPlace.path, "earlier.txt", "work\n");
  releaseWorkspace(db, earlierPlace, earlier, clock.now());
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  // 修理が分かれた後に帰り先が進む —— merge back は ff にならず merge commit を作る。進めるのは盤面の口(手で進めると受理が拒む、ADR 0373 決定1)
  const movedOn = git(workspace.path, "commit-tree", `task/${work.id}^{tree}`, "-p", `task/${work.id}`, "-m", "moved on");
  boardRefWriter(db, workspace)(`refs/heads/task/${work.id}`, movedOn, () => git(workspace.path, "update-ref", `refs/heads/task/${work.id}`, movedOn));
  const targetBefore = git(workspace.path, "rev-parse", `task/${work.id}`);
  // 原本の保護ブランチも進む —— やり直しの休止位置の ff がローカルの保護ブランチを動かす
  pr.publish("merged.txt", "merged on GitHub\n", "merged outside");
  quarantineWorkspace(db, workspace.name, new Error("GitHub token acquisition failed"), clock.now());

  await answerWorkspaceQuarantine(pr, quarantineQuestion(db, "workspace", workspace.name)!);

  const merged = git(workspace.path, "rev-parse", `task/${work.id}`);
  expect(git(workspace.path, "rev-parse", `${merged}^1`)).toBe(targetBefore);
  expect(git(workspace.path, "rev-parse", `${merged}^2`)).toBe(git(workspace.path, "rev-parse", `task/${repair.id}`));
  // 同じ基準で次の pickup が比べる: 帰り先の行が merge commit の1値なら、その位置は通り、戻した位置は名指しされる
  // (旧: earlier の解放をやり直して比べた —— ADR 0356 決定2 の後、解放を刻んだ再実行は削除だけを撃つ)
  if (rolledBack) git(workspace.path, "update-ref", `refs/heads/task/${work.id}`, targetBefore);
  const failure = await prepareAtPickup(db, workspace, landingWork(db, clock)).then(() => undefined, (err: unknown) => err as Error);
  if (rolledBack) expect(failure?.message).toContain(`was: ${merged} refs/heads/task/${work.id}`);
  else expect(failure?.message ?? "").not.toMatch(new RegExp(`refs/heads/(task/${work.id}|main)\\b`));
});

// 旧: 名前の場所で merge を解いて(捨てて)から答えた。ADR 0371 決定1・2 の後は作業台で解き、名前の場所での手の merge は受理が拒む(ADR 0373 決定1)
it.each<[string, (workbench: string, repairId: string) => void]>([
  [
    "作業台で merge を解いた",
    (workbench, repairId) => {
      expect(() => git(workbench, "merge", `board/task/${repairId}`)).toThrow();
      commitWork(workbench, "repair.txt", "fixed and conflicting\n");
    },
  ],
  [
    "作業台で `merge -s ours` により修理を捨てると記録した",
    (workbench, repairId) => {
      git(workbench, "merge", "-s", "ours", "--no-edit", `board/task/${repairId}`);
    },
  ],
])("merge back の conflict を%s後の受理は通り、収束を突き、続く収束が根へ push して積み残しが消える", async (_, repairInWorkbench) => {
  const pr = await quarantinedByMergeBackConflict("redo-merge-back-repaired", "escalate");
  const { db, clock, work, repair, question, landing } = pr;
  // 1回目の回答が conflict に当たって作業台を開く(text A1)
  await expect(answerWorkspaceQuarantine(pr, question)).rejects.toThrow("The board opened the workbench at");
  repairInWorkbench(realpathSync(workbenchPath(pr.workbenchBase, { task: work.id }, `task/${repair.id}`)), repair.id);
  const pollNow = vi.fn();

  await answerWorkspaceQuarantine(pr, question, pollNow);

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(pollNow).toHaveBeenCalledOnce();
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  expect(contentLeftBehindLocally(db, pr.workspace, work.id, forkHead(pr.workspace, work.id))).toEqual([]);
});

it("merge back の conflict を名前の場所で手で解いてから答えると、`repaired by hand` は動いた帰り先を名指して拒む(ADR 0373 決定1)", async () => {
  const pr = await quarantinedByMergeBackConflict("redo-merge-back-by-hand", "escalate");
  const { workspace, work, repair, question, db } = pr;
  git(workspace.path, "checkout", `task/${work.id}`);
  git(workspace.path, "merge", "-s", "ours", "--no-edit", `task/${repair.id}`);

  const refused = answerWorkspaceQuarantine(pr, question);
  await expect(refused).rejects.toThrow(`now: ${git(workspace.path, "rev-parse", `task/${work.id}`)} refs/heads/task/${work.id}`);
  await expect(refused).rejects.toThrow("The board does not accept moved refs.");

  expect(getTask(db, question.id)!.status).toBe("todo");
});

it("その workspace で session が走っている間は、checkout を動かさずに受理を拒む(ADR 0356 決定1)", async () => {
  const pr = await quarantinedByMergeBackConflict("redo-merge-back-running", "escalate");
  const { workspace, db, clock, repair, question } = pr;
  const branches = () => [git(workspace.path, "rev-parse", "HEAD"), git(workspace.path, "rev-parse", `task/${repair.id}`)];
  const before = branches();
  pickupTask(db, landingWork(db, clock), "worker", clock.now());

  await expect(answerWorkspaceQuarantine(pr, question)).rejects.toThrow(
    new DomainError(`a session or its teardown is still running in workspace ${workspace.name} — answer again once it has finished`),
  );

  // 旧: checkout は修理のブランチに居たまま。ADR 0356 決定1 の後、名前の場所は保護ブランチに居て、受理はそこから何も動かさない
  expect(head(workspace)).toBe("main");
  expect(branches()).toEqual(before);
  expect(getTask(db, question.id)!.status).toBe("todo");
});

// 旧: 受理は worker が index で隠した変更を拒んだ。ADR 0356 決定3 の後、名前の場所は自分の git で読み(人間の index の印は
// 人間の宣言)、worker はそこに書かない —— 受理が拒むのは名前の場所の自分の git に見える変更
it("受理は名前の場所を自分の git で読み、見える変更を拒み、checkout を動かさない(ADR 0356 決定3)", async () => {
  const pr = await openPushedPr("redo-merge-back-refused-to-start", "escalate");
  const { workspace, db, clock, work } = pr;
  const repair = attachUnsettledChild(db, clock, work.id);
  checkoutTaskBranch(db, workspace, repair.id, `task/${work.id}`);
  commitWork(workspace.path, "README.md", "repaired\n");
  git(workspace.path, "checkout", `task/${work.id}`);
  completeTask(db, repair, FULL_HANDOFF, "worker", clock.now(), "worker");
  // The board sees the change before attempting merge-back or parking.
  writeFileSync(join(workspace.path, "README.md"), "local\n");
  quarantineWorkspace(db, workspace.name, new Error("GitHub token acquisition failed"), clock.now());

  await expect(answerWorkspaceQuarantine(pr, quarantineQuestion(db, "workspace", workspace.name)!)).rejects.toThrow(
    /still has uncommitted changes/,
  );

  expect(head(workspace)).toBe(`task/${work.id}`);
  expect(readFileSync(join(workspace.path, "README.md"), "utf8")).toBe("local\n");
});

it("purely-local な workspace で、やり直しの前に帯域外に動いた保護ブランチは、やり直しの後も着地で帯域外と読まれる", async () => {
  const workspace = await makeWorkspace("redo-merge-back-local");
  const { db, clock } = await openBoard();
  const work = landingWork(db, clock);
  const place = await prepareAtPickup(db, workspace, work);
  commitWork(place.path, "feature.txt", "ready\n");
  releaseWorkspace(db, place, work, clock.now());
  await settleRepairNotMergedBack(db, clock, workspace, work.id);
  // 名前の場所が休止位置の外に居る(やり直しが戻す)
  git(workspace.path, "checkout", `task/${work.id}`);
  git(workspace.path, "update-ref", "refs/heads/main", git(workspace.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "out of band"));

  // やり直しそのものを撃つ —— 受理は動いた ref を拒む(ADR 0373 決定1)ので、帯域外の main を残したまま merge back のやり直しだけを測る
  await redoMergeBacks(db, workspace, workspace.name, undefined, { workbenchBase: await tempDir("tidepool-workbenches-"), entry: "workspace_quarantine", answerer: HUMAN_ANSWERER, now: () => clock.now() });

  expect(head(workspace)).toBe("main");
  expect(() => mergeTaskToProtected(db, workspace, work.id, CLEAN_LANDING_INTAKE)).toThrow(OutOfBandProtectedBranchError);
});

it("内容が帰り先に届いていない done の work が無ければ、merge back のやり直しは checkout を動かさない(ADR 0240 決定4)", async () => {
  const pr = await openPushedPr("redo-merge-back-nothing", "escalate");
  const { workspace, db, work, clock } = pr;

  await redoMergeBacks(db, workspace, workspace.name, undefined, { workbenchBase: await tempDir("tidepool-workbenches-"), entry: "workspace_quarantine", answerer: HUMAN_ANSWERER, now: () => clock.now() });

  expect(head(workspace)).toBe(`task/${work.id}`);
});

it("done の子孫のブランチに merge される head に無い内容があれば積み残しで、CI 緑でも無人 merge されず、event も question も無くキューに残る", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-descendant", "auto_if_ci_green");
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  const events = listEvents(db, work.id).length;

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id)).toHaveLength(events);

  // キューに残っている —— 修理を merge back し、着地が push した後の tick で merge される
  tearDownRepair(db, clock, workspace, repair);
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  await landing.tick("auto_merge");
  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("cancelled の祖先の下に残った done の work の内容は積み残しではなく、無人 merge される", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-cancelled", "auto_if_ci_green");
  const abandoned = attachUnsettledChild(db, clock, work.id);
  // 祖先も走っていた: 拾いが task/<abandoned> を作り、修理はそこから fork する。祖先は cancel される走りの途中なので解放しない
  await prepareAtPickup(db, workspace, abandoned);
  const inner = await settleRepairNotMergedBack(db, clock, workspace, abandoned.id);
  cancelTaskDirectly(db, getTask(db, abandoned.id)!, null, clock.now(), {}, "webui");
  expect(getTask(db, inner.id)!.status).toBe("done");

  await landing.tick("auto_merge");

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

// ADR 0387 決定1: 外の push の head は無人では merge されない —— 積み残しの述語は、その head を問うた question への「merge」で言う
it("修理の内容がローカルの着地するタスクのブランチに無くても、merge される head に載っていれば積み残しではない", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-on-fork", "auto_if_ci_green");
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  // 盤面の外の clone が修理を PR のブランチへ push する —— 名前の場所の ref は動かさない
  const clone = await tempDir("tidepool-outside-push-");
  git(clone, "clone", workspace.head_repo!, ".");
  git(clone, "fetch", workspace.path, `task/${repair.id}`);
  git(clone, "push", "origin", `FETCH_HEAD:refs/heads/task/${work.id}`);
  await landing.tick("auto_merge");

  await expect(answerMergeQuestion({ db, clock, github, workspace, landing })).resolves.toMatchObject({ status: "done" });
  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

/** GitHub に修理を捨てた merge が載った形。別の clone で作り、名前の場所の ref は動かさない。 */
async function pushDiscardedRepair(workspace: WorkspaceConfig, taskId: string, repairId: string) {
  const branch = `task/${taskId}`;
  const clone = await tempDir("tidepool-discarded-repair-");
  git(clone, "clone", "--branch", branch, workspace.head_repo!, ".");
  git(clone, "fetch", workspace.path, `task/${repairId}`);
  git(clone, "merge", "-s", "ours", "--no-edit", "FETCH_HEAD");
  git(clone, "push", "origin", branch);
}

it("PR の head に修理を `merge -s ours` で捨てた記録があれば、修理は積み残しではない", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-discarded", "auto_if_ci_green");
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  await pushDiscardedRepair(workspace, work.id, repair.id);
  await landing.tick("auto_merge");

  await expect(answerMergeQuestion({ db, clock, github, workspace, landing })).resolves.toMatchObject({ status: "done" });
  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("merge back 済み・push 前でタスクブランチが出元 repo に無い内容を持てば積み残しで無人 merge されず、着地が push した後の tick で merge される", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-unpushed", "auto_if_ci_green");
  commitWork(workspace.path, "repair.txt", "fixed\n");

  await landing.tick("auto_merge");
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);

  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  await landing.tick("auto_merge");
  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("盤面の外の push で出元 repo だけが先へ進んでいるのは積み残しではなく、その head を問うた question への「merge」で merge される", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-outside-push", "auto_if_ci_green");
  git(workspace.path, "checkout", "-b", "outside");
  commitWork(workspace.path, "outside.txt", "pushed by a human\n");
  git(workspace.path, "push", "head-repo", `outside:task/${work.id}`);
  git(workspace.path, "checkout", `task/${work.id}`);
  await landing.tick("auto_merge");

  await expect(answerMergeQuestion({ db, clock, github, workspace, landing })).resolves.toMatchObject({ status: "done" });
  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("修理のブランチが PR に届いた位置へ帯域外で巻き戻されたら、merge の回答を拒み Quarantine を立てる", async () => {
  const pr = await openPushedPr("merge-answer-rewound-repair", "escalate");
  const repair = await settleRepairNotMergedBack(pr.db, pr.clock, pr.workspace, pr.work.id);
  const ref = `refs/heads/task/${repair.id}`;
  const recorded = git(pr.workspace.path, "rev-parse", ref);
  const rewound = forkHead(pr.workspace, pr.work.id);
  git(pr.workspace.path, "update-ref", ref, rewound);
  const question = listBoard(pr.db).find((q) => q.question_pending_merge_pr === 1)!;

  await expect(answerMergeQuestion(pr)).rejects.toThrow(`now: ${rewound} ${ref}`);

  expect(quarantineQuestion(pr.db, "workspace", pr.workspace.name)?.purpose).toContain(`was: ${recorded} ${ref}`);
  expect(getTask(pr.db, question.id)?.status).toBe("todo");
  expect(pr.github.merged).toEqual([]);
});

it("CI を待つ間に修理のブランチが巻き戻されたら、無人 merge は PR をキューに残して Quarantine を立てる", async () => {
  const { workspace, db, clock, github, work } = await openPushedPr("auto-merge-rewound-repair", "auto_if_ci_green");
  let dial: MergeDial = "auto_if_ci_green";
  const landing = autoMerging(db, clock, workspace, github, () => profile(dial));
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  const ref = `refs/heads/task/${repair.id}`;
  const recorded = git(workspace.path, "rev-parse", ref);
  const rewound = forkHead(workspace, work.id);
  const read = github.readPullRequest.bind(github);
  vi.spyOn(github, "readPullRequest").mockImplementationOnce(async (pr) => {
    const result = await read(pr);
    git(workspace.path, "update-ref", ref, rewound);
    dial = "escalate";
    return result;
  });

  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(`was: ${recorded} ${ref}`);
  expect(await readOnNextTick(landing, github)).toEqual([1]);
});

// ADR 0404 決定1: tick が await の後に立てる Quarantine は、tick を撃った時刻でなく書いた時刻を持つ
it("PR を読む間に時が進めば、帯域外で動いたタスクブランチに無人 merge が立てる workspace の Quarantine は読んだ後の時刻を持つ", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("auto-merge-quarantine-time", "auto_if_ci_green");
  await leaveBaseline(db, workspace);
  const moved = commitOutOfBand(workspace, `task/${work.id}`);
  const window = awaitWindow();
  afterCiRead(github, window.hold);

  const ticking = landing.tick("auto_merge");
  await window.entered;
  await clock.advance(60_000);
  const afterTheRead = clock.now().toISOString();
  window.open();
  await ticking;

  const quarantine = quarantineQuestion(db, "workspace", workspace.name);
  expect(quarantine?.purpose).toContain(`now: ${moved} refs/heads/task/${work.id}`);
  expect(quarantine?.created_at).toBe(afterTheRead);
});

it("PR の head の fetch を待つ間に修理が巻き戻されたら、merge 回答は積み残しの比較をせず Quarantine で止まる", async () => {
  const pr = await openPushedPr("merge-answer-rewound-during-fetch", "escalate");
  const repair = await settleRepairNotMergedBack(pr.db, pr.clock, pr.workspace, pr.work.id);
  const ref = `refs/heads/task/${repair.id}`;
  const recorded = git(pr.workspace.path, "rev-parse", ref);
  const rewound = forkHead(pr.workspace, pr.work.id);
  const prHead = await pushOutsideBoard(pr.workspace, pr.work.id);
  const { window, githubAuth } = fetchHeldAtToken();

  const answering = answerMergeQuestion({ ...pr, githubAuth });
  await window.entered;
  git(pr.workspace.path, "update-ref", ref, rewound);
  window.open();

  await expect(answering).rejects.toThrow(new RegExp(`^workspace ${pr.workspace.name}: refs changed before landing read them.*now: ${rewound} ${ref}`));
  expect(() => git(pr.workspace.path, "cat-file", "-e", `${prHead}^{commit}`)).toThrow();
  expect(quarantineQuestion(pr.db, "workspace", pr.workspace.name)?.purpose).toContain(`was: ${recorded} ${ref}`);
  expect(mergeQuestions(pr.db)).toHaveLength(1);
  expect(pr.github.merged).toEqual([]);
});

it.each(["CI", "fetch token"] as const)("%s を待つ間に merge question が観測で閉じられたら、ref が動いていても観測の結果を返す", async (waitingFor) => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("merge-answer-closed-while-waiting", "escalate");
  await leaveBaseline(db, workspace);
  const { window, githubAuth } = fetchHeldAtToken();
  if (waitingFor === "CI") afterCiRead(github, window.hold);
  else await pushOutsideBoard(workspace, work.id);
  const question = getTask(db, listBoard(db).find((q) => q.question_pending_merge_pr === 1)!.id)!;

  const answering = submitAnswer(
    { db, pollNow: () => {}, landing, workspace, github, githubAuth },
    question,
    ["merge"],
    undefined,
    () => clock.now(),
    "webui",
  );
  await window.entered;
  git(workspace.path, "tag", "intruder");
  github.scriptClosedOutside(1);
  await landing.tick("outside_merge");
  window.open();

  await expect(answering).resolves.toMatchObject({
    status: "done",
    question_answer: null,
    settled_by_observation: "pr_close_observed",
  });
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(github.merged).toEqual([]);
});

it("基準どおりの ref を持つ workspace の Quarantine は PR への merge 回答を拒まない", async () => {
  const pr = await openPushedPr("merge-answer-open-quarantine", "escalate");
  await leaveBaseline(pr.db, pr.workspace);
  quarantineWorkspace(pr.db, pr.workspace.name, new Error("repair the checkout"), pr.clock.now());

  await expect(answerMergeQuestion(pr)).resolves.toMatchObject({ status: "done" });

  expect(pr.github.merged.map((merged) => merged.number)).toEqual([1]);
  expect(quarantineQuestion(pr.db, "workspace", pr.workspace.name)).toBeDefined();
});

it.each(["pr_close_observed", "pr_merge_observed"] as const)("ref が動いていても、無人 merge の tick は GitHub の決着を %s として記録する", async (kind) => {
  const { workspace, db, github, work, landing } = await openPushedPr("auto-merge-observed-with-moved-ref", "auto_if_ci_green");
  await leaveBaseline(db, workspace);
  git(workspace.path, "tag", "intruder");
  if (kind === "pr_close_observed") github.scriptClosedOutside(1);
  else github.scriptMergedOutside(1);

  await landing.tick("auto_merge");

  expect(boardEvents(db, work.id, kind)).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind, pr_number: 1 } },
  ]);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(await readOnNextTick(landing, github)).toEqual([]);
});

/** #1831 の形: 修理を merge back して収束が push した後、別の clone が PR のブランチを修理より前の commit の上へ
 *  force-push する。 */
async function dropRepairOutsideBoard(pr: Awaited<ReturnType<typeof openPushedPr>>) {
  const { workspace, db, clock, work, landing } = pr;
  const beforeRepair = git(workspace.path, "rev-parse", "HEAD");
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  tearDownRepair(db, clock, workspace, repair);
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "open_pull_request_updated" });
  await pushOutsideBoard(workspace, work.id, beforeRepair);
  return repair;
}

// ADR 0242 決定4: 盤面の外の push が落とした内容は、盤面には運ぶ手が無い —— キューを外して推奨 hold の merge question に倒す
it("別の clone からの force-push で修理が消えた PR は、CI 緑でも無人 merge されず、キューを外れ、届いていない修理のブランチを名指す推奨 hold の merge question(text A4c)が1枚立つ", async () => {
  const pr = await openPushedPr("left-behind-dropped-outside", "auto_if_ci_green");
  const repair = await dropRepairOutsideBoard(pr);

  await pr.landing.tick("auto_merge");

  expect(pr.github.merged).toEqual([]);
  expect(await readOnNextTick(pr.landing, pr.github)).toEqual([]);
  expect(mergeQuestions(pr.db)).toEqual([
    { pr: 1, registrant: [BOARD_ACTOR_ID, "board"], recommendation: "hold", purpose: textA4c(`task/${repair.id}`) },
  ]);
});

// ADR 0376 決定7(#3250): 外の push が落とした内容への `merge` は、積み残しの拒否で昇格失敗 question を名指さず、作業台を開いて拒まれる
it("別の clone からの force-push で修理が消えた PR への人間の「merge」は、text A4a で修理を名指して拒まれて作業台を開き、merge されず question は開いたまま", async () => {
  const { c, repair } = await droppedRepair("left-behind-dropped-outside-answer");
  await c.landing.tick("auto_merge");
  const [question] = listBoard(c.db).filter((q) => q.question_pending_merge_pr === 1);

  expect(await c.answerMerge()).toBe(textA4a(c, c.pushed, `task/${repair.id}`));

  expect(c.github.merged).toEqual([]);
  expect(getTask(c.db, question!.id)?.status).toBe("todo");
});

it("外の push が落とした内容をブランチに戻して push すれば、その merge question への「merge」の回答は通る", async () => {
  const pr = await openPushedPr("left-behind-dropped-outside-restored", "auto_if_ci_green");
  await dropRepairOutsideBoard(pr);
  await pr.landing.tick("auto_merge");
  git(pr.workspace.path, "push", "--force", "head-repo", `task/${pr.work.id}`);

  await expect(answerMergeQuestion(pr)).resolves.toMatchObject({ status: "done" });

  expect(pr.github.merged.map((merged) => merged.number)).toEqual([1]);
});

// ADR 0371 決定3・10: 落とされた内容を捨てるのも作業台の merge —— 3つのコマンドの後の `merge` が取り込み、push し、merge する
it("外の push が落とした修理を作業台で捨てた次の「merge」は、修理の内容を戻さずに取り込んで push し merge する", async () => {
  const { c } = await droppedRepair("left-behind-dropped-outside-discarded");
  await c.landing.tick("auto_merge");
  await c.answerMerge();
  git(c.workbench(), "merge", "--quiet", "-s", "ours", "--no-commit", `board/origin/${c.target}`);
  git(c.workbench(), "read-tree", "-u", "--reset", `board/origin/${c.target}`);
  // 巻き戻しでは head が tip の祖先なので `merge -s ours` は何もせず、commit の文は人間が書く
  git(c.workbench(), "commit", "--quiet", "-m", "Discard what the outside push dropped");

  expect(await c.answerMerge()).toBeUndefined();

  const landed = forkHead(c.workspace, c.work.id);
  expect(c.github.mergedHeads).toEqual([landed]);
  expect(() => git(c.workspace.path, "cat-file", "-e", `${landed}:dropped.txt`)).toThrow();
});

/** 収束が PR #1 を開く(盤面自身の push)。`narrowRefspec` は #1778 の形 —— fetch の refspec を保護ブランチだけに絞った
 *  checkout(`--single-branch` の clone)で、push しても写しが書かれない。 */
async function openPrByConvergence(name: string, merge: MergeDial, { narrowRefspec = false } = {}) {
  const { workspace } = await makeLandingWorkspace(name);
  if (narrowRefspec) git(workspace.path, "config", "remote.head-repo.fetch", "+refs/heads/main:refs/remotes/head-repo/main");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = autoMerging(db, clock, workspace, github, () => profile(merge));
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
  return { workspace, db, clock, github, work, landing };
}

it("refspec を保護ブランチだけに絞った checkout でも、収束が PR を開いて push した後の tick で無人 merge される", async () => {
  const { github, landing } = await openPrByConvergence("left-behind-narrow-refspec", "auto_if_ci_green", {
    narrowRefspec: true,
  });

  await landing.tick("auto_merge");

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

it("refspec を絞った checkout の PR への人間の merge 回答は通り、PR を1回だけ読んで、その head で merge する", async () => {
  const pr = await openPrByConvergence("left-behind-narrow-refspec-answer", "escalate", { narrowRefspec: true });

  await expect(answerMergeQuestion(pr)).resolves.toMatchObject({ status: "done" });

  expect(pr.github.ciChecks).toHaveLength(1);
  expect(pr.github.mergedHeads).toEqual([forkHead(pr.workspace, pr.work.id)]);
});

it("盤面自身が push した head は手元にあるので、origin に届かなくても fetch を撃たずに無人 merge される", async () => {
  const { workspace, github, work, landing } = await openPrByConvergence("left-behind-no-fetch", "auto_if_ci_green");
  github.scriptHead(1, forkHead(workspace, work.id));
  const observed = await github.readPullRequest({ workspace, number: 1 });
  vi.spyOn(github, "readPullRequest").mockResolvedValue(observed);
  rmSync(workspace.head_repo!, { recursive: true });

  await landing.tick("auto_merge");

  expect(github.merged.map((pr) => pr.number)).toEqual([1]);
});

// ADR 0242 決定2: 収束は盤面が最後に push した head と比べる —— 写しは読まない
it("写しが無くても、盤面が最後に push した head に内容が全部載っていれば、収束は push せず up_to_date を返す", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-converge-no-copy", "escalate");
  finish(db, clock, work);
  git(workspace.path, "update-ref", "-d", `refs/remotes/head-repo/task/${work.id}`);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "up_to_date", prNumber: 1 });
  expect(github.pushes).toEqual([]);
});

// ADR 0370 決定1: push の後の読み直しの前に比べる —— push の間に動いた ref は積み残しと読まない
it("push の直後に写しが消えれば、積み残しでなく動いた ref として止まり、失敗 question を立てない", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-after-push-no-copy", "escalate");
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, work);
  afterEachPush(github, () => git(workspace.path, "update-ref", "-d", `refs/remotes/head-repo/task/${work.id}`));

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined", error: expect.stringContaining(`refs/remotes/head-repo/task/${work.id}`) });
  expect(promotionFailures(db, work.id)).toEqual([]);
});

// ADR 0242 決定3: 比べられなければ積み残し。人間の merge 回答は「運んでいる途中」でなく、比べられなかった事実と理由で拒む(#1854)
const NOWHERE = "0123456789abcdef0123456789abcdef01234567";

it("GitHub の head が手元にも出元 repo にも無い PR への人間の merge 回答は、head の fetch が失敗したことを言って拒まれる", async () => {
  const pr = await openPushedPr("left-behind-fetch-fails-answer", "escalate");
  pr.github.scriptHead(1, NOWHERE);

  const error = await answerMergeQuestion(pr).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(DomainError);
  expect((error as Error).message).toMatch(
    new RegExp(`^cannot merge: could not compare PR #1's head ${NOWHERE} with the task's content — .*git (?:-c [^ ]+ )*fetch`, "s"),
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

// ADR 0403 決定4: 基準と比べる ref が git の失敗で読めなければ、収束と同じ workspace の Quarantine で止まる
it("壊れた packed-refs で基準との比較ができなければ、無人 merge をせず workspace の Quarantine を1つ立て、PR をキューに残す", async () => {
  const { workspace, db, github, landing, work } = await openPushedPr("auto-merge-unreadable-refs", "auto_if_ci_green");
  await leaveBaseline(db, workspace);
  breakPackedRefs(workspace);

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toMatch(/^could not verify refs .* before landing: .*git for-each-ref/s);
  expect(promotionFailures(db, work.id)).toEqual([]);
  expect(await readOnNextTick(landing, github)).toEqual([1]);
});

// 遅い走査は PR の状態だけを読み、名前の場所の ref を読まない —— 読めない checkout でも止まらず、Quarantine も立てない
it.each([false, true])("壊れた packed-refs の workspace でも、遅い走査は ref を読まずに PR を観測する(外で閉じた: %s)", async (closed) => {
  const { workspace, db, github, landing, work } = await openPushedPr("outside-merge-unreadable-refs", "escalate");
  await leaveBaseline(db, workspace);
  breakPackedRefs(workspace);
  if (closed) github.scriptClosedOutside(1);

  await landing.tick("outside_merge");

  expect(boardEvents(db, work.id, "pr_close_observed")).toEqual(closed ? closeObserved(1) : []);
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(promotionFailures(db, work.id)).toEqual([]);
});

it("基準と ref が比べられない workspace では、PR の内容を比べる前に merge の回答を拒み、workspace の Quarantine を立てる", async () => {
  const pr = await openPushedPr("merge-answer-unreadable-refs", "escalate");
  await leaveBaseline(pr.db, pr.workspace);
  breakPackedRefs(pr.workspace);
  const question = listBoard(pr.db).find((q) => q.question_pending_merge_pr === 1)!;

  const error = await answerMergeQuestion(pr).catch((err: unknown) => err);

  expect(error).toBeInstanceOf(DomainError);
  expect((error as Error).message).toMatch(/^could not verify refs .* before landing: .*git for-each-ref/s);
  expect((error as Error).message).not.toContain(STILL_CARRYING);
  expect(quarantineQuestion(pr.db, "workspace", pr.workspace.name)?.purpose).toMatch(/^could not verify refs .* before landing: .*git for-each-ref/s);
  expect(getTask(pr.db, question.id)?.status).toBe("todo");
  expect(pr.github.merged).toEqual([]);
});

// ADR 0241 決定7: push しても積み残しが消えなければ、着地したとは言わない。push はする
// ADR 0371 決定10: 積み残しの retry は、その根の分解ツリーの merge back を撃ち直してから収束する —— 人間は名前の場所で merge しない
it("PR を開いた後に積み残しが残れば landed を返さず、内容の届いていない子孫を名指す失敗 question を1枚立て、retry が merge back を撃ち直して着地する", async () => {
  const { workspace } = await makeLandingWorkspace("left-behind-after-open");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, workspacesDir: await tempDir("tidepool-task-checkouts-") });
  const work = landingWork(db, clock);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
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

  await answerPromotion(db, clock, landing, workspace, failures[0]!, "retry");

  expect(getTask(db, failures[0]!.id)?.status).toBe("done");
  expect(git(workspace.path, "show", `refs/remotes/head-repo/task/${work.id}:repair.txt`)).toBe("fixed");
  expect(git(workspace.path, "ls-remote", "head-repo", `refs/heads/task/${work.id}`).split("\t")[0]).toBe(git(workspace.path, "rev-parse", `task/${work.id}`));
  expect(git(workspace.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

// ADR 0371 決定10「受理と同じ条件で」: 撃ち直す前に受理の前半(名前に掛かる前半の項と clean)を掛ける
it("積み残しの retry は、名前の場所に未 commit の変更があれば merge back を撃ち直さずに拒まれ、何も書かない", async () => {
  const { workspace, db, clock, github, work } = await openPushedPr("left-behind-dirty-named-place", "escalate");
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: () => profile("escalate"), workspacesDir: await tempDir("tidepool-task-checkouts-") });
  await settleRepairNotMergedBack(db, clock, workspace, work.id);
  finish(db, clock, work);
  await convergeOn(landing, work.id);
  const [leftover] = promotionFailures(db, work.id);
  writeFileSync(join(workspace.path, "stray.txt"), "left by hand\n");
  const root = git(workspace.path, "rev-parse", `task/${work.id}`);

  await expect(answerPromotion(db, clock, landing, workspace, leftover!, "retry")).rejects.toThrow(
    new DomainError(
      `workspace ${workspace.name} still has uncommitted changes. Discard them with \`git restore --staged --worktree .\` then \`git clean -fd\` until ` +
        "`git status --porcelain` is empty (`git clean -ffd` for a nested repository, `git worktree remove --force <path>` for a linked worktree inside the tree).",
    ),
  );

  expect(git(workspace.path, "rev-parse", `task/${work.id}`)).toBe(root);
  expect(getTask(db, leftover!.id)?.status).toBe("todo");
  expect(github.pushes).toHaveLength(1);
});

it("開いている PR へ push した後に積み残しが残れば landed を返さず、失敗 question を1枚立てる", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-after-push", "escalate");
  const repair = await settleRepairNotMergedBack(db, clock, workspace, work.id);
  finish(db, clock, work);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "content_left_behind" });
  expect(github.pushes).toHaveLength(1);
  expect(promotionFailures(db, work.id).map(({ title, purpose }) => ({ title, purpose }))).toEqual([
    {
      title: "PR promotion left content behind: ship",
      purpose:
        `Pushing task/${work.id} for completed task "ship" left content behind: the content of task/${repair.id} ` +
        `has not reached task/${work.id}. Answer \`retry\` and the board re-fires those merge backs. If one conflicts, the answer is ` +
        "refused and the refusal says where to resolve it.",
    },
  ]);
});

// ADR 0371 決定10 / spec #3273 pin A12: 積み残しの retry は merge back を撃ち直し、conflict は作業台を開いて拒む(text A1)。同じ帰り先へ
// conflict する子が2つなら、1回の回答で1つの conflict
it("積み残しの retry が撃ち直す merge back が同じ帰り先へ2つ conflict すれば、回答ごとに1つずつ作業台で拒み、解いた分を取り込んで最後の回答で push する", async () => {
  const { workspace, db, clock, github, work } = await openPushedPr("left-behind-two-conflicts", "escalate");
  const workbenchBase = await tempDir("tidepool-task-checkouts-");
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: () => profile("escalate"), workspacesDir: workbenchBase });
  const children: Task[] = [];
  for (const body of ["from the first child\n", "from the second child\n"]) {
    const child = attachUnsettledChild(db, clock, work.id);
    const place = await prepareAtPickup(db, workspace, child);
    commitWork(place.path, "repair.txt", body);
    recordTaskCheckoutTip(db, place, child.id);
    completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
    children.push(child);
  }
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "from the root\n");
  finish(db, clock, work);
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "failed", reason: "content_left_behind" });
  const [leftover] = promotionFailures(db, work.id);
  const target = `task/${work.id}`;
  const workbench = (source: string) => realpathSync(workbenchPath(workbenchBase, { task: work.id }, source));
  const refused = (source: string) =>
    `${source} does not merge cleanly into '${target}'. The board opened the workbench at ${workbench(source)} for it. There, on ${target}, ` +
    `run \`git merge board/${source}\` and resolve the conflict (or, in your own clone with the workbench as a remote: fetch it, ` +
    `\`git merge <remote>/board/${source}\`, and push ${target} to it). Your tip must contain both ${target} as the board has it now ` +
    `(\`board/${target}\`) and ${source}, with nothing uncommitted. To discard ${source}'s work instead, record that with ` +
    `\`git merge -s ours board/${source}\`. Then answer again.`;
  const resolve = (source: string) => {
    expect(() => git(workbench(source), "merge", `board/${source}`)).toThrow();
    writeFileSync(join(workbench(source), "repair.txt"), `${readFileSync(join(workbench(source), "repair.txt"), "utf8").replace(/^[<=>|].*\n/gm, "")}`);
    git(workbench(source), "commit", "-am", `resolve ${source}`);
  };
  const retryRefusal = () => answerPromotion(db, clock, landing, workspace, leftover!, "retry").then(() => undefined, (err: unknown) => err);
  const [first, second] = children.map((child) => `task/${child.id}`) as [string, string];
  const rootBefore = git(workspace.path, "rev-parse", target);

  // 新しい子から運ぶ(子孫を先に運ぶ順)—— 1回目は2つ目の子の conflict だけを言い、何も書かない
  expect(await retryRefusal()).toEqual(new DomainError(refused(second)));
  expect(git(workspace.path, "rev-parse", target)).toBe(rootBefore);
  expect(listEventsOfKinds(db, ["workbench_taken_in"])).toEqual([]);
  expect(getTask(db, leftover!.id)?.status).toBe("todo");

  // 作業台に書きかけがあれば、tip が書く先のままでも答え直しは拒まれ、作業台は作り直されない —— 書きかけは残る(ADR 0382 決定2・5)
  writeFileSync(join(workbench(second), "draft.txt"), "half-made\n");
  expect(((await retryRefusal()) as Error).message).toBe(
    `the workbench at ${workbench(second)} has nothing new on ${target}, but it has uncommitted changes — commit them on ${target} or discard them. Then answer again.`,
  );
  expect(readFileSync(join(workbench(second), "draft.txt"), "utf8")).toBe("half-made\n");
  rmSync(join(workbench(second), "draft.txt"));

  resolve(second);
  expect(await retryRefusal()).toEqual(new DomainError(refused(first)));
  expect(listEventsOfKinds(db, ["workbench_taken_in"]).map(({ payload }) => payload)).toEqual([expect.objectContaining({ target: `refs/heads/${target}`, entry: "promotion_retry" })]);
  expect(getTask(db, leftover!.id)?.status).toBe("todo");
  expect(github.pushes).toHaveLength(1);

  resolve(first);
  await answerPromotion(db, clock, landing, workspace, leftover!, "retry");

  expect(getTask(db, leftover!.id)?.status).toBe("done");
  expect(listEventsOfKinds(db, ["workbench_taken_in"])).toHaveLength(2);
  expect(github.pushes).toHaveLength(2);
  for (const source of [first, second]) {
    expect(git(workspace.path, "merge-base", "--is-ancestor", source, `refs/remotes/head-repo/${target}`)).toBe("");
  }
  expect(git(workspace.path, "ls-remote", "head-repo", `refs/heads/${target}`).split("\t")[0]).toBe(git(workspace.path, "rev-parse", target));
});

// #3384: 取り込みの時刻は `redoMergeBacks` の中の await(前半・保護ブランチの fetch の token)の後、書く瞬間に読む —— 呼び手が渡す前に読んだ値ではない
it("積み残しの retry が作業台から取り込む記録の時刻は、merge back のやり直しの中の token を待った後の時刻", async () => {
  const { workspace, db, clock, github, work } = await openPushedPr("left-behind-intake-time", "escalate");
  const workbenchBase = await tempDir("tidepool-task-checkouts-");
  const landingWith = (githubAuth?: GitHubAuth) =>
    createLanding({ defaultAgentName: "tako", db, clock, workspace, github, githubAuth, resolveAuthority: () => profile("escalate"), workspacesDir: workbenchBase });
  const child = attachUnsettledChild(db, clock, work.id);
  const place = await prepareAtPickup(db, workspace, child);
  commitWork(place.path, "repair.txt", "from the child\n");
  recordTaskCheckoutTip(db, place, child.id);
  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await commitThroughTaskCheckout(db, clock, workspace, work, "repair.txt", "from the root\n");
  finish(db, clock, work);
  await expect(convergeOn(landingWith(), work.id)).resolves.toMatchObject({ kind: "failed", reason: "content_left_behind" });
  const [leftover] = promotionFailures(db, work.id);
  const source = `task/${child.id}`;
  await expect(answerPromotion(db, clock, landingWith(), workspace, leftover!, "retry")).rejects.toThrow(DomainError);
  const workbench = realpathSync(workbenchPath(workbenchBase, { task: work.id }, source));
  expect(() => git(workbench, "merge", `board/${source}`)).toThrow();
  writeFileSync(join(workbench, "repair.txt"), "from the root\nfrom the child\n");
  git(workbench, "commit", "-am", `resolve ${source}`);
  const { window, githubAuth } = fetchHeldAtToken();

  const answering = answerPromotion(db, clock, landingWith(githubAuth), workspace, leftover!, "retry");
  await window.entered;
  await clock.advance(60_000);
  const afterTheToken = clock.now().toISOString();
  window.open();
  await answering;

  expect(listEventsOfKinds(db, ["workbench_taken_in"]).map(({ created_at }) => created_at)).toEqual([afterTheToken]);
});

it("push の後に積み残しが残っても、workspace の quarantine が抱えていれば失敗 question を立てず、その quarantine を名乗る", async () => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-quarantined", "escalate");
  await settleRepairNotMergedBack(db, clock, workspace, work.id);
  finish(db, clock, work);
  afterEachPush(github, () => quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now()));

  await expect(convergeOn(landing, work.id)).resolves.toEqual({
    kind: "quarantined",
    error: `workspace "${workspace.name}" is quarantined and needs human attention before landing; answer its quarantine question`,
  });
  expect(promotionFailures(db, work.id)).toEqual([]);
});

// ADR 0241 決定6: push の後に積み残しを比べられなくても、workspace の quarantine が抱えていれば失敗 question を重ねない。
// 抱えていなければ失敗 question を立てる(fail-closed)。比較を落とすのは積み残しの対象の読み —— ref 検査は通る
it.each([
  ["workspace の quarantine が抱えていれば、失敗 question を立てずその quarantine を名乗る", true],
  ["quarantine が抱えていなければ、失敗 question を1枚立てる", false],
])("push の後に積み残しを比べられないとき、%s", async (_, quarantine) => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("left-behind-unreadable-after-push", "escalate");
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, work);
  const tip = git(workspace.path, "rev-parse", `refs/heads/task/${work.id}`);
  afterEachPush(github, () => {
    failPrepareOnce(db, "id = @root OR", "the left-behind targets could not be read");
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
    expect(verdict).toMatchObject({ kind: "failed", reason: "promotion_failed", error: expect.stringContaining("the left-behind targets could not be read") });
    expect(promotionFailures(db, work.id)).toEqual([expect.objectContaining({ question_landing_tip: tip })]);
  }
});

// ADR 0403 決定4: push の後に読めなくなった checkout は、積み残しを比べる前の ref 検査が workspace の Quarantine で止める
it.each([
  ["workspace の Quarantine が開いていれば2つ目を立てず、拒否文が読めない ref を言う", true],
  ["Quarantine が開いていなければ workspace の Quarantine を1つ立て、昇格失敗 question は立てない", false],
])("push の後に checkout の ref が読めなくなったとき、%s", async (_, quarantine) => {
  const { workspace, db, clock, github, work, landing } = await openPushedPr("unreadable-refs-after-push", "escalate");
  commitWork(workspace.path, "repair.txt", "fixed\n");
  finish(db, clock, work);
  afterEachPush(github, () => {
    breakPackedRefs(workspace);
    if (quarantine) quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());
  });

  const verdict = await convergeOn(landing, work.id);

  expect(github.pushes).toHaveLength(1);
  expect(verdict).toEqual({
    kind: "quarantined",
    error: expect.stringMatching(unreadableRefsRefusal(workspace)),
  });
  expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(quarantine ? "repair the checkout" : "could not verify refs");
  expect(promotionFailures(db, work.id)).toEqual([]);
});

// ADR 0403 決定4: 基準の行を持つ名前の `.git` が無ければ、ref 検査が git の失敗で読めず workspace の Quarantine で止まる
it("workspace の Git リポジトリが無ければ、収束は workspace の Quarantine で止まり、昇格失敗 question は立てない", async () => {
  const c = await pushedRoot("promotion-failed-without-repository");
  // 基準の行が無い名前なら、着地の最初の撮りの開く前の項(`.git` がディレクトリ)が Quarantine で止める(ADR 0399 決定7)
  await leaveBaseline(c.db, c.workspace);
  renameSync(join(c.workspace.path, ".git"), join(c.workspace.path, "saved-git"));

  expect(await convergeOn(c.landing, c.work.id)).toMatchObject({ kind: "quarantined", error: expect.stringContaining("could not verify refs") });
  expect(quarantineQuestion(c.db, "workspace", c.workspace.name)?.purpose).toContain("could not verify refs");
  expect(promotionFailures(c.db, c.work.id)).toEqual([]);
});

it("基準の行が無い名前でも、checkout の ref が読めなければ、収束は最初の撮りをせず workspace の Quarantine 1つで止まる", async () => {
  const c = await pushedRoot("unreadable-refs-without-baseline");
  breakPackedRefs(c.workspace);

  expect(await convergeOn(c.landing, c.work.id)).toMatchObject({ kind: "quarantined", error: expect.stringContaining("could not verify refs") });
  expect(openQuarantineValues(c.db, "workspace")).toEqual([c.workspace.name]);
  expect(holdsBaseline(c.db, c.workspace.name)).toBe(false);
  expect(promotionFailures(c.db, c.work.id)).toEqual([]);
});

// ADR 0403 決定1: 問いに写す tip が読めなくても、昇格失敗 question は tip 無しで立つ
it("workspace を解決できず昇格失敗の question に写す tip が読めないときも、収束は tip が無い昇格失敗 question を立てる", async () => {
  const c = await pushedRoot("unreadable-promotion-question-tip");
  vi.spyOn(console, "error").mockImplementation(() => {});
  const landing = createLanding({
    defaultAgentName: "tako", db: c.db, clock: c.clock, github: c.github,
    resolveWorkspace: () => { throw new Error("the registry cannot be read"); },
  });

  expect(await convergeOn(landing, c.work.id)).toMatchObject({
    kind: "failed", reason: "promotion_failed", error: expect.stringContaining("the registry cannot be read"),
  });
  expect(promotionFailures(c.db, c.work.id)).toEqual([expect.objectContaining({ question_landing_tip: null })]);
});

/** 根の導出の最初の読み(根の PR の決着)を1回だけ落とす —— 回の根ごとの catch に届く想定外の例外。 */
function failRootDerivationRead(db: Db) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  failPrepareOnce(db, "pr_merge_observed", "the board hit a bug");
}

const LANDING_FAILED = { kind: "failed", reason: "landing_failed" };

// ADR 0403 決定3: 根ごとの catch に落ちた想定外の例外でも、無人の回なら tip 無しの昇格失敗 question を1枚立てる
it("根の導出の読みが例外に落ちた無人の回は、その根に tip が無い昇格失敗 question を1枚立てる", async () => {
  const c = await pushedRoot("landing-per-root-catch-raises");
  failRootDerivationRead(c.db);

  expect(await convergeOn(c.landing, c.work.id)).toMatchObject(LANDING_FAILED);
  expect(promotionFailures(c.db, c.work.id)).toEqual([
    expect.objectContaining({ status: "todo", question_landing_tip: null, purpose: expect.stringContaining("the board hit a bug") }),
  ]);
});

it("根の導出の読みが例外に落ちても、その根に昇格失敗 question が開いていれば重ねない", async () => {
  const c = await pushedRoot("landing-per-root-catch-open-question", { openFailure: true });
  const before = promotionFailures(c.db, c.work.id);
  failRootDerivationRead(c.db);

  expect(await convergeOn(c.landing, c.work.id)).toMatchObject(LANDING_FAILED);
  expect(promotionFailures(c.db, c.work.id)).toEqual(before);
});

it("根の導出の読みが例外に落ちても、その根に答えている回答がある回は question を立てない", async () => {
  const pr = await openPushedPr("landing-per-root-catch-answering", "escalate");
  finish(pr.db, pr.clock, pr.work);
  const question = listBoard(pr.db).find((q) => q.question_pending_merge_pr === 1)!;
  failRootDerivationRead(pr.db);

  expect(await convergeOn(pr.landing, pr.work.id, question.id)).toMatchObject(LANDING_FAILED);
  expect(promotionFailures(pr.db, pr.work.id)).toEqual([]);
});

// ADR 0240 決定5: 拒否文は積み残しを運ぶ面を名指しする。どちらも無ければ、盤面が運んでいる途中である
const STILL_CARRYING = "the board is still carrying it; answer again later";

const carriedBy = (surface: string, questionId: string) =>
  `the open ${surface} question (${questionId}) carries it; answer that question first, then answer again`;

it.each<[string, (pr: Awaited<ReturnType<typeof openPushedPr>>) => string | Promise<string>]>([
  [
    "子孫の merge back 前",
    async ({ workspace, db, clock, work }) => {
      await settleRepairNotMergedBack(db, clock, workspace, work.id);
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
    async ({ workspace, db, clock, work }) => {
      await settleRepairNotMergedBack(db, clock, workspace, work.id);
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
    const carrier = await leaveBehind(pr);
    const question = listBoard(db).find((q) => q.question_pending_merge_pr === 1)!;
    await expect(answerMergeQuestion(pr)).rejects.toThrow(new DomainError(`cannot merge yet: PR #1 does not carry all of the task's content yet — ${carrier}`));
    expect(github.merged).toEqual([]);
    expect(listBoard(db).find((q) => q.id === question.id)?.status).toBe("todo");
  },
);

const localLeftBehind = (workId: string, carrier: string) =>
  new DomainError(`cannot merge yet: the task branch task/${workId} does not carry all of the task's content yet — ${carrier}`);

it("別の ref が動いたら、ローカル着地の merge 回答を拒み workspace の Quarantine を立てる", async () => {
  const local = await landLocally("local-merge-raises-quarantine");
  const { workspace, db, question } = local;
  const before = git(workspace.path, "rev-parse", "main");
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  git(workspace.path, "tag", "intruder");
  const movedRef = `now: ${before} refs/tags/intruder`;

  await expect(answerLocalMerge(local)).rejects.toThrow(movedRef);

  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(movedRef);
  expect(getTask(db, question.id)?.status).toBe("todo");
  expect(git(workspace.path, "rev-parse", "main")).toBe(before);
});

it("別の ref が動いた workspace のローカル着地は、Quarantine を重ねず、動いた ref を名指して拒む", async () => {
  const local = await landLocally("local-merge-with-moved-tag");
  const { workspace, db, clock, question } = local;
  const before = git(workspace.path, "rev-parse", "main");
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());
  const quarantine = quarantineQuestion(db, "workspace", workspace.name)!;
  git(workspace.path, "tag", "intruder");

  await expect(answerLocalMerge(local)).rejects.toThrow(`now: ${before} refs/tags/intruder`);

  expect(quarantineQuestion(db, "workspace", workspace.name)?.id).toBe(quarantine.id);
  expect(listBoard(db).filter((row) => row.question_quarantine_kind === "workspace")).toHaveLength(1);
  expect(getTask(db, question.id)?.status).toBe("todo");
  expect(git(workspace.path, "rev-parse", "main")).toBe(before);
});

it("基準どおりの ref を持つ workspace の Quarantine はローカル着地の merge 回答を拒まない", async () => {
  const local = await landLocally("local-merge-open-quarantine");
  const { workspace, db, clock, work } = local;
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), clock.now());

  await expect(answerLocalMerge(local)).resolves.toMatchObject({ status: "done" });

  expect(git(workspace.path, "rev-parse", "main")).toBe(git(workspace.path, "rev-parse", `task/${work.id}`));
  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined();
});

it("修理が done で後始末が merge back する前のローカル着地の merge 回答は、盤面がまだ運んでいるとして拒まれ、merge back の後の回答で修理ごと載る", async () => {
  const local = await landLocally("local-left-behind-teardown");
  const { workspace, db, clock, work, question } = local;
  const repair = attachUnsettledChild(db, clock, work.id);
  const place = await prepareAtPickup(db, workspace, repair);
  commitWork(place.path, "repair.txt", "fixed\n");
  // 完了の門が修理の tip を名前の場所へ引く(ADR 0356 決定3)
  recordTaskCheckoutTip(db, place, repair.id);
  finish(db, clock, repair);
  markTeardown(db, repair.id, clock.now());
  const protectedHead = git(workspace.path, "rev-parse", "main");

  await expect(answerLocalMerge(local)).rejects.toThrow(localLeftBehind(work.id, STILL_CARRYING));
  expect(git(workspace.path, "rev-parse", "main")).toBe(protectedHead);
  expect(getTask(db, question.id)!.status).toBe("todo");

  releaseWorkspace(db, place, getTask(db, repair.id)!, clock.now(), true);
  await answerLocalMerge(local);
  expect(getTask(db, question.id)!.status).toBe("done");
  expect(git(workspace.path, "show", "main:repair.txt")).toBe("fixed");
});

// ADR 0371 決定1・2: 旧形は人間が名前の場所で merge を解いてから Quarantine に答えた —— 解く場所は Quarantine が名指す作業台(ADR 0373 決定9)
it("修理の merge back が conflict して quarantine に落ちた間のローカル着地の merge 回答は、その quarantine question を名指して拒まれ、作業台で conflict を解いた受理の後の回答で修理ごと載る", async () => {
  const local = await landLocally("local-left-behind-conflict");
  const { workspace, db, clock, work, question, base } = local;
  // 実経路の順: 修理が W から分かれて commit し中断した後、兄弟の修理が同じファイルを W へ merge back し、修理が再開して完了する
  const repair = attachUnsettledChild(db, clock, work.id);
  const repairPlace = await prepareAtPickup(db, workspace, repair);
  commitWork(repairPlace.path, "repair.txt", "fixed\n");
  releaseWorkspace(db, repairPlace, getTask(db, repair.id)!, clock.now());
  const sibling = attachUnsettledChild(db, clock, work.id);
  const siblingPlace = await prepareAtPickup(db, workspace, sibling);
  commitWork(siblingPlace.path, "repair.txt", "conflicting\n");
  finish(db, clock, sibling);
  releaseWorkspace(db, siblingPlace, getTask(db, sibling.id)!, clock.now(), true);
  const resumed = await prepareAtPickup(db, workspace, repair, { workspacesBaseDir: base });
  finish(db, clock, repair);
  releaseWorkspace(db, resumed, getTask(db, repair.id)!, clock.now(), true);
  const quarantine = quarantineQuestion(db, "workspace", workspace.name)!;
  const workbench = realpathSync(workbenchPath(base, { task: work.id }, `task/${repair.id}`));
  expect(quarantine.purpose).toContain(`The board opened the workbench at ${workbench} for it.`);
  const protectedHead = git(workspace.path, "rev-parse", "main");

  await expect(answerLocalMerge(local)).rejects.toThrow(
    localLeftBehind(work.id, carriedBy("workspace quarantine", quarantine.id)),
  );
  expect(git(workspace.path, "rev-parse", "main")).toBe(protectedHead);
  expect(getTask(db, question.id)!.status).toBe("todo");

  expect(() => git(workbench, "merge", `board/task/${repair.id}`)).toThrow();
  commitWork(workbench, "repair.txt", "fixed and conflicting\n");
  await answerWorkspaceQuarantine({ db, clock, workspace, landing: unusedLanding, workbenchBase: base }, quarantine);
  await answerLocalMerge(local);
  expect(getTask(db, question.id)!.status).toBe("done");
  expect(git(workspace.path, "show", "main:repair.txt")).toBe("fixed and conflicting");
});

// ADR 0289 決定1: ローカル着地も merge の執行を根に刻み、収束はその記録で根を終わらせる
it("ローカル着地の merge 回答が受理されると、保護ブランチの新しい tip を local_merge_executed として根に刻み、以後の収束はその根を撃たず question も増やさない", async () => {
  const local = await landLocally("local-merge-executed");
  const { workspace, db, landing, work } = local;

  await answerLocalMerge(local);

  expect(boardEvents(db, work.id, "local_merge_executed")).toEqual([
    {
      actor_id: HUMAN_ACTOR_ID,
      origin: "webui",
      payload: { kind: "local_merge_executed", sha: git(workspace.path, "rev-parse", "main") },
    },
  ]);
  await expect(convergeOn(landing, work.id)).resolves.toBeUndefined();
  expect(openLocalMergeQuestions(db, work.id)).toEqual([]);
});

// ADR 0289 決定3 / ADR 0394 決定5: hold が断るのは question が問うた時点の内容 —— question の tip を写して根に刻む(旧・回答の時点の tip)
it("ローカル着地の hold 回答は question を立てた後に task ブランチが動いていても受理され、動いた tip でなく question が問うた tip を根に刻む", async () => {
  const local = await landLocally("local-merge-held");
  const { workspace, db, work, question } = local;
  const asked = git(workspace.path, "rev-parse", `task/${work.id}`);
  const moved = commitOutOfBand(workspace, `task/${work.id}`);

  await answerLocalMerge(local, "hold");

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(moved).not.toBe(asked);
  expect(boardEvents(db, work.id, "landing_declined")).toEqual([
    {
      actor_id: HUMAN_ACTOR_ID,
      origin: "webui",
      payload: { kind: "landing_declined", question_id: question.id, tip: asked, outside: null, missing_branches: null },
    },
  ]);
});

type LocalLanding = Awaited<ReturnType<typeof landLocally>>;

/** ADR 0401 決定4 の死: 根 W を保護ブランチへ ff で着地させ、回答の記録は刻まない(question は開いたまま)。W を持ち込んだ commit(W の tip)を返す。 */
function landFfWithoutRecord({ db, workspace, work, base }: LocalLanding): string {
  const { landed } = mergeTaskToProtected(db, workspace, work.id, { ...CLEAN_LANDING_INTAKE, workbenchBase: base });
  expect(landed).toBe(git(workspace.path, "rev-parse", `task/${work.id}`));
  return landed;
}

/** ADR 0401 決定4 の死: 別の根を先に着地させてから根 W を非 ff で保護ブランチへ着地させ、回答の記録は刻まない(question は開いたまま)。
 *  W を持ち込んだ merge commit を返す。 */
async function landNonFfWithoutRecord(local: LocalLanding): Promise<string> {
  const { db, clock, workspace, work, base } = local;
  const other = landingWork(db, clock, workspace.name);
  const place = await prepareAtPickup(db, workspace, other);
  commitWork(place.path, "other.txt", "another root\n");
  releaseWorkspace(db, place, other, clock.now());
  const intake = { ...CLEAN_LANDING_INTAKE, workbenchBase: base };
  mergeTaskToProtected(db, workspace, other.id, intake);
  const { landed } = mergeTaskToProtected(db, workspace, work.id, intake);
  expect(git(workspace.path, "rev-parse", `${landed}^2`)).toBe(git(workspace.path, "rev-parse", `task/${work.id}`));
  return landed;
}

const LANDINGS_WITHOUT_RECORD: Array<[form: string, land: (local: LocalLanding) => string | Promise<string>]> = [
  ["ff", landFfWithoutRecord],
  ["非 ff", landNonFfWithoutRecord],
];

// ADR 0401 決定4: 保護ブランチを動かした後・記録の前に死んだローカル着地の答え直し —— merge は何も書かずに持ち込んだ commit の執行を刻み、
// 刻んだ記録で失われた task は透明に読まれる(ADR 0380 決定1)
it.each(LANDINGS_WITHOUT_RECORD)("%s の着地の後に記録だけ欠けた local merge question に merge と答えると、保護ブランチを動かさずに持ち込んだ commit を local_merge_executed として刻む", async (_form, land) => {
  const local = await landLocally("local-merge-reanswer");
  const { workspace, db, clock, work, question } = local;
  const landed = await land(local);

  await answerLocalMerge(local);

  expect(git(workspace.path, "rev-parse", "main")).toBe(landed);
  expect(boardEvents(db, work.id, "local_merge_executed").map(({ payload }) => payload)).toEqual([{ kind: "local_merge_executed", sha: landed }]);
  expect(getTask(db, question.id)!.status).toBe("done");
  const tip = git(workspace.path, "rev-parse", `task/${work.id}`);
  const lost = appendEvent(db, { taskId: work.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_branch_lost", sha: tip }, at: clock.now() });
  expect(lostTaskIsTransparent(db, work.id, { id: lost, payload: { sha: tip } }, [])).toBe(true);
});

// ADR 0401 決定4: 載った内容に断念を刻まない —— 出口は merge
it.each(LANDINGS_WITHOUT_RECORD)("%s の着地の後に記録だけ欠けた local merge question に hold と答えると、merge を名指して断り何も刻まない", async (_form, land) => {
  const local = await landLocally("local-hold-reanswer");
  const { db, work, question } = local;
  await land(local);

  const refused = answerLocalMerge(local, "hold");

  await expect(refused).rejects.toThrow(DomainError);
  await expect(refused).rejects.toThrow("answer `merge`");
  expect(boardEvents(db, work.id, "landing_declined")).toEqual([]);
  expect(getTask(db, question.id)!.status).toBe("todo");
});

// ADR 0401 帰結: 諦めて(ADR 0392)ブランチが消えた後は含まれているかを判定できない —— hold は今までどおり通る
it("task のブランチが無ければ、着地の後に記録だけ欠けた local merge question への hold は今までどおり断念を刻む", async () => {
  const local = await landLocally("local-hold-branch-gone");
  const { workspace, db, work } = local;
  await landNonFfWithoutRecord(local);
  git(workspace.path, "branch", "-D", `task/${work.id}`);

  await answerLocalMerge(local, "hold");

  expect(boardEvents(db, work.id, "landing_declined")).toHaveLength(1);
});

// ADR 0289 Status 追記 / ADR 0370 決定1: 履歴で載ったと分かるとき以外の hold は拒まない —— 含まれているかを読めなくても断念を刻む
it.each([
  ["workspace が解決できない", (local: LocalLanding) => submitAnswer({ db: local.db, pollNow: () => {}, landing: unusedLanding, workspacesDir: local.base }, getTask(local.db, local.question.id)!, ["hold"], undefined, () => local.clock.now(), "webui")],
  [
    "workspace の git が読めない",
    (local: LocalLanding) => {
      rmSync(join(local.workspace.path, ".git"), { recursive: true, force: true });
      return answerLocalMerge(local, "hold");
    },
  ],
])("%s ときも、local merge question への hold は受理され断念を刻む", async (_case, hold) => {
  const local = await landLocally("local-hold-unread");
  const { db, work, question } = local;

  await hold(local);

  expect(boardEvents(db, work.id, "landing_declined")).toHaveLength(1);
  expect(getTask(db, question.id)!.status).toBe("done");
});

/** 根 W の付帯子として修理 F を pickup(lineage で W から fork)して commit し、完了して後始末の merge back で W へ届ける。 */
async function mergeBackRepair({ db, clock, workspace, work }: Awaited<ReturnType<typeof landLocally>>) {
  const repair = attachUnsettledChild(db, clock, work.id);
  const place = await prepareAtPickup(db, workspace, repair);
  commitWork(place.path, "repair.txt", "fixed\n");
  finish(db, clock, repair);
  releaseWorkspace(db, place, getTask(db, repair.id)!, clock.now(), true);
  return repair;
}

it("hold の後に修理の後始末が merge back してタスクブランチの内容が変わると、根は着地を待つ完了タスクに戻り、次の収束が local merge question を1枚立て直す", async () => {
  const local = await landLocally("local-hold-reasked");
  const { workspace, db, landing, work, question } = local;
  await answerLocalMerge(local, "hold");

  const repair = await mergeBackRepair(local);
  expect(taskIdsAwaitingLandingInWorkspace(db, () => workspace, workspace.name)).toEqual([work.id]);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "landed", form: "local_merge_question" });
  expect(getTask(db, question.id)!.status).toBe("done");
  const reasked = openLocalMergeQuestions(db, work.id);
  expect(reasked).toHaveLength(1);
  expect(reasked[0]!.purpose).toContain("was held");
  expect(reasked[0]!.purpose).toContain(`the content of task/${repair.id} has reached it since`);
});

// ADR 0394 決定5: question が開いている間に届いた修理は、人間が見ていないので hold が断ったことにならない
it("question を立てた後に修理が merge back されてから hold と答えても、次の収束は local merge question を立て直す", async () => {
  const local = await landLocally("local-hold-after-repair");
  const { workspace, db, landing, work } = local;
  await mergeBackRepair(local);

  await answerLocalMerge(local, "hold");

  expect(taskIdsAwaitingLandingInWorkspace(db, () => workspace, workspace.name)).toEqual([work.id]);
  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "landed", form: "local_merge_question" });
  expect(openLocalMergeQuestions(db, work.id)).toHaveLength(1);
});

// ADR 0394 決定1: 盤面の部分は記録にだけ使う —— 盤面自身の修理で tip が進んでも `merge` は拒まない
it("question を立てた後に盤面の修理で tip が進んでいても、ローカル着地の merge は拒まれず今の tip を保護ブランチへ置く", async () => {
  const local = await landLocally("local-merge-after-repair");
  const { workspace, db, work, question } = local;
  await mergeBackRepair(local);
  const tip = git(workspace.path, "rev-parse", `task/${work.id}`);
  expect(getTask(db, question.id)!.question_landing_tip).not.toBe(tip);

  await answerLocalMerge(local);

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(git(workspace.path, "show", "main:repair.txt")).toBe("fixed");
});

it("hold の後に内容が変わっていなければ、収束を2回撃っても local merge question を立て直さず、根は着地を待つ完了タスクに数えない", async () => {
  const local = await landLocally("local-hold-unchanged");
  const { workspace, db, landing, work } = local;
  await answerLocalMerge(local, "hold");

  await expect(convergeOn(landing, work.id)).resolves.toBeUndefined();
  await expect(convergeOn(landing, work.id)).resolves.toBeUndefined();

  expect(openLocalMergeQuestions(db, work.id)).toEqual([]);
  expect(taskIdsAwaitingLandingInWorkspace(db, () => workspace, workspace.name)).toEqual([]);
});

it("立て直した local merge question に hold と答えるとその question が問うた tip が刻まれ、以後の収束はその tip を基準に立て直さない", async () => {
  const local = await landLocally("local-hold-again");
  const { workspace, db, landing, work } = local;
  await answerLocalMerge(local, "hold");
  await mergeBackRepair(local);
  await convergeOn(landing, work.id);
  const reasked = openLocalMergeQuestions(db, work.id)[0]!;

  await answerLocalMerge(local, "hold", reasked);

  expect(boardEvents(db, work.id, "landing_declined").map(({ payload }) => payload)).toEqual([
    { kind: "landing_declined", question_id: local.question.id, tip: expect.any(String), outside: null, missing_branches: null },
    { kind: "landing_declined", question_id: reasked.id, tip: git(workspace.path, "rev-parse", `task/${work.id}`), outside: null, missing_branches: null },
  ]);
  await expect(convergeOn(landing, work.id)).resolves.toBeUndefined();
  expect(openLocalMergeQuestions(db, work.id)).toEqual([]);
});

it("hold の後に内容が変わっても、別の付帯子が未決着の間は門で待ち(待った記録は刻まず)question を立て直さず、門が開いた次の収束で立て直す", async () => {
  const local = await landLocally("local-hold-gate");
  const { db, clock, landing, work } = local;
  await answerLocalMerge(local, "hold");
  const pending = attachUnsettledChild(db, clock, work.id);
  await mergeBackRepair(local);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "deferred", reason: "attached_children", count: 1 });
  expect(openLocalMergeQuestions(db, work.id)).toEqual([]);
  expect(boardEvents(db, work.id, "landing_deferred")).toEqual([]);

  finish(db, clock, pending);

  await expect(convergeOn(landing, work.id)).resolves.toEqual({ kind: "landed", form: "local_merge_question" });
  expect(openLocalMergeQuestions(db, work.id)).toHaveLength(1);
});

it("escalate で開いた PR の後にダイヤルを auto_if_ci_green へ緩めても、何も無人 merge キューに入らない", async () => {
  const workspace = await makeWorkspace("landing-loosened-dial");
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  recordPrOpenedOutsideConvergence(db, landingWork(db, clock), 1, clock.now(), {
    authority: { merge: "escalate" },
  });

  await createLanding({
    defaultAgentName: "tako",
    db,
    clock,
    workspace,
    github,
    resolveAuthority: () => profile("auto_if_ci_green"),
  }).tick("auto_merge");

  expect(github.ciChecks).toEqual([]);
  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});

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

  await landing.tick("auto_merge");
  expect(quarantineQuestion(db, "agent", "tako")).toBeDefined();

  resolveAuthority = () => profile("auto_if_ci_green");
  completeTask(db, child, FULL_HANDOFF, "worker", clock.now(), "worker");
  await landing.tick("auto_merge");
  expect(github.merged).toEqual([{ path: workspace.path, number: 1 }]);
});

it.each(UNRESOLVABLE)("PR を開く時点で profile が %s で解決できなければ、PR を開かず agent を quarantine に落とし、失敗 question を立てず、registry を直した後の収束で PR を開く", async (_, fail) => {
  const { workspace } = await makeLandingWorkspace("landing-unresolvable-at-open");
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
  checkoutTaskBranch(db, workspace, task.id);
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
  await landing.tick("auto_merge");
  expect(github.merged).toHaveLength(1);
});

it("開いている PR へ修理を push する着地は profile を読まないので、解決できなくても push して agent を quarantine に落とさない", async () => {
  const { workspace } = await makeLandingWorkspace("landing-unresolvable-open-pr-update");
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
  checkoutTaskBranch(db, workspace, task.id);
  const head = pushPrHead(github, workspace, task.id, 1);
  commitWork(workspace.path, "feature.txt", "ready\n");
  finish(db, clock, task);
  recordPrOpenedOutsideConvergence(db, task, 1, clock.now(), { head, workspace });

  await expect(convergeOn(landing, task.id)).resolves.toEqual({
    kind: "landed",
    form: "open_pull_request_updated",
    prNumber: 1,
  });
  expect(quarantineQuestion(db, "agent", "tako")).toBeUndefined();
});

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

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([]);
  expect(listEvents(db, work.id).map((e) => e.kind)).not.toContain("auto_merge_withdrawn");
  expect(agentQuarantines(db).map((q) => q.question_quarantine_value)).toEqual(["tako"]);

  resolveAuthority = () => profile("auto_if_ci_green");
  await landing.tick("auto_merge");
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
  await landing.tick("auto_merge");

  resolveAuthority = () => profile("escalate");
  await landing.tick("auto_merge");

  expect(github.merged).toEqual([]);
  expect(mergeQuestions(db)).toEqual([expect.objectContaining({ pr: 1, registrant: [BOARD_ACTOR_ID, "board"] })]);
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
  }).tick("auto_merge");

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

  await landing.tick("auto_merge");
  expect(mergeQuestions(db)).toEqual([]);
  expect(quarantineQuestion(db, "agent", "tako")).toBeDefined();

  resolveAuthority = () => profile("auto_if_ci_green");
  await landing.tick("auto_merge");
  expect(mergeQuestions(db).map((q) => q.pr)).toEqual([1]);
});
