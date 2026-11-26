import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import type { Db } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { GhCliClient } from "../src/github.js";
import { HEAD_REPO_REMOTE } from "../src/github-auth.js";
import { submitAnswer } from "../src/human-verbs.js";
import { blockingRootOf, createLanding, type Landing, landingState, registerPrPromotionFailureQuestion, rootPrOutcome, settledByObservation } from "../src/landing.js";
import { openQuarantineQuestion, registerQuarantine } from "../src/quarantine.js";
import { getTask, listBoard, nextSlotTask, registerMergeQuestion } from "../src/tasks.js";
import { dropWorkspaceState, quarantineWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { createWorkspace } from "../src/workspace-create.js";
import { afterCiRead, awaitWindow, FakeGitHubClient, heldInPrepareMerge, holdAfterMerge } from "./fakes.js";
import { checkoutTaskBranch, commitWork, failEventInsert, GIT_FIXTURE_TEST_TIMEOUT, git, MATCHING_GH, makeLandingWorkspace } from "./harness.js";
import { attachUnsettledChild, boardEvents, commitThroughTaskCheckout, fetchHeldAtToken, finish, giveHeadRepo, landingWork, openBoard, profile, promotionFailures, pushOutsideBoard, pushPrHead, type RegisteredReef, recordPrOpenedOutsideConvergence, registeredReef, reRegister } from "./landing-fixture.js";
import { commitWorkspaceDeletion, setWorkspaceEntry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

async function recordGhCommands() {
  const dir = await tempDir("tidepool-fake-gh-");
  const calls = join(dir, "calls");
  writeFileSync(calls, "");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TIDEPOOL_TEST_GH_CALLS"\n`, { mode: 0o755 });
  vi.stubEnv("TIDEPOOL_TEST_GH_CALLS", calls);
  vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
  return () => readFileSync(calls, "utf8");
}

async function reefWithPr(merge: "auto_if_ci_green" | "escalate", declaredRepo?: string) {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeLandingWorkspace("reef-old");
  if (declaredRepo) {
    git(old.path, "remote", "set-url", "origin", declaredRepo);
    old.repo = declaredRepo;
  }
  // 盤面は出元 repo へ push する(ADR 0395 決定2)—— 新しい repo の根も出元 repo を記録して PR を開く(ADR 0399 決定1)
  const { workspace: moved } = await makeLandingWorkspace("reef-new");
  const reef = await registeredReef(old);
  giveHeadRepo(db, reef, old.head_repo!);
  const github = new FakeGitHubClient();

  const move = async () => {
    // 開いた merge question や無人 merge キューが削除を拒むので、扉の外で宣言と workspace の状態を入れ替えた盤面を作る。
    commitWorkspaceDeletion(reef.registryDir, "reef");
    dropWorkspaceState(db, "reef");
    await createWorkspace({ name: "reef", mode: "register", path: moved.path, confirm: true }, { ...reef.admin, db });
    expect(reef.resolve("reef").repo).toBe(moved.repo);
    giveHeadRepo(db, reef, moved.head_repo!);
  };
  const workspace = reef.resolve("reef");
  const work = landingWork(db, clock, "reef");
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "feature.txt", "ready\n");
  const root = finish(db, clock, work);
  const head = pushPrHead(github, workspace, root.id, 1);
  recordPrOpenedOutsideConvergence(db, root, 1, clock.now(), { authority: { merge }, head, workspace });
  const landing = createLanding({ db, clock, resolveWorkspace: reef.resolve, defaultAgentName: "tako", github, resolveAuthority: () => profile(merge) });
  const submit = (questionId: string, option: string) =>
    submitAnswer(
      { db, pollNow: () => {}, landing, resolveWorkspace: reef.resolve, github, workspacesDir: join(reef.admin.workspacesBaseDir, "workbenches") },
      getTask(db, questionId)!, [option], undefined, () => clock.now(), "webui",
    );
  const answer = (option: "merge" | "hold") =>
    submit(listBoard(db).find((task) => task.status === "todo" && task.question_pending_merge_task_id === root.id)!.id, option);
  const answerFailure = (option: string) => submit(promotionFailures(db, root.id).find((task) => task.status === "todo")!.id, option);
  return { db, clock, reef, old, moved, root, github, landing, move, answer, answerFailure };
}

function expectStopped({ db, root, old, moved }: Awaited<ReturnType<typeof reefWithPr>>) {
  expect(rootPrOutcome(db, root.id)).toBeNull();
  const [failure, ...repeated] = promotionFailures(db, root.id);
  expect(repeated).toEqual([]);
  expect(failure?.purpose).toContain(`recorded repo ${old.repo}`);
  expect(failure?.purpose).toContain(`now declares repo ${moved.repo}`);
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
}

it("無人 merge の tick は登録し直した repo の同じ番号の PR を旧い根として読まず、旧い根だけを止める", async () => {
  const fixture = await reefWithPr("auto_if_ci_green");
  const { db, clock, reef, moved, github, landing, move } = fixture;
  await move();
  const newWork = landingWork(db, clock, "reef");
  checkoutTaskBranch(db, reef.resolve("reef"), newWork.id);
  const newRoot = finish(db, clock, newWork);
  recordPrOpenedOutsideConvergence(db, newRoot, 1, clock.now(), { authority: { merge: "auto_if_ci_green" }, workspace: reef.resolve("reef") });
  github.scriptClosedOutside(1, moved.repo);

  await landing.tick("auto_merge");
  await landing.tick("auto_merge");

  expect(github.ciChecks).toEqual([{ path: moved.path, number: 1 }]);
  expect(rootPrOutcome(db, newRoot.id)).toEqual({ state: "CLOSED", observed: true, prNumber: 1 });
  expectStopped(fixture);
});

it("外の merge の tick は登録し直した repo の同じ番号の PR を読まず、旧い根を止める", async () => {
  const fixture = await reefWithPr("escalate");
  const { moved, github, landing, move } = fixture;
  await move();
  github.scriptClosedOutside(1, moved.repo);

  await landing.tick("outside_merge");

  expect(github.stateChecks).toEqual([]);
  expectStopped(fixture);
});

it("無人 merge の観測は登録し直した repo の同じ番号の PR を読まず、旧い根を止める", async () => {
  const fixture = await reefWithPr("auto_if_ci_green");
  const { moved, github, landing, move } = fixture;
  await move();
  github.scriptClosedOutside(1, moved.repo);

  await landing.observeAutoMergeOutcomes("tako");

  expect(github.stateChecks).toEqual([]);
  expectStopped(fixture);
});

// ADR 0399 決定5 の追記(#3791): tick は workspace の Quarantine 単独では止まらない(ADR 0370 決定1)ので、その根を止めているのは食い違いで、
// 信号はこの question しか持たない —— ADR 0241 決定6 の「重ねない」の対象ではない。伏せると tick はその根だけを黙って読まなくなる
const openStops = {
  "workspace の Quarantine": (db: Db, now: Date) => void quarantineWorkspace(db, "reef", new Error("a ref moved out of band"), now),
  "registry の止まり": (db: Db, now: Date) => void registerQuarantine(db, "registryUnreadable", null, "the registry could not be read", now),
};
const repoReaders = {
  "無人 merge の tick": { merge: "auto_if_ci_green", read: (landing: Landing) => landing.tick("auto_merge") },
  "外の merge の走査": { merge: "escalate", read: (landing: Landing) => landing.tick("outside_merge") },
  "無人 merge の観測": { merge: "auto_if_ci_green", read: (landing: Landing) => landing.observeAutoMergeOutcomes("tako") },
} as const;
const stoppedReads = Object.keys(openStops).flatMap((stop) => Object.keys(repoReaders).map((reader) => [stop, reader] as [keyof typeof openStops, keyof typeof repoReaders]));

it.each(stoppedReads)("%s が開いていても、%s は食い違った根を問い、「end landing」は受理される", async (stop, reader) => {
  const { merge, read } = repoReaders[reader];
  const { db, clock, old, moved, root, landing, move, answerFailure } = await reefWithPr(merge);
  await move();
  openStops[stop](db, clock.now());
  const stopQuestions = () => [openQuarantineQuestion(db, "workspace", "reef"), openQuarantineQuestion(db, "registryUnreadable", null)].filter(Boolean).length;

  await read(landing);

  const [failure, ...repeated] = promotionFailures(db, root.id);
  expect(repeated).toEqual([]);
  expect(failure?.purpose).toContain(`recorded repo ${old.repo}`);
  expect(failure?.purpose).toContain(`now declares repo ${moved.repo}`);

  await answerFailure("end landing");

  expect(landingState(db, getTask(db, root.id)!)).toBe("pr_left");
  expect(stopQuestions()).toBe(1);
});

// 別の昇格失敗 question が開いた根を収束は撃たない(ADR 0403 決定3)—— その根の食い違いを問うのは tick だけで、断念を出さない
// question(決定5)が届かなければ、断念した根はキューに残ったまま誰にも問われない
it("別の昇格失敗 question が開いた根の食い違いは、収束が問わず、tick が問う", async () => {
  const { db, clock, moved, root, landing, move } = await reefWithPr("auto_if_ci_green");
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  await move();

  await landing.converge();
  expect(promotionFailures(db, root.id).map(({ purpose }) => purpose)).toEqual([expect.stringContaining("push rejected")]);

  await landing.tick("auto_merge");
  expect(promotionFailures(db, root.id).map(({ purpose }) => purpose)).toEqual([
    expect.stringContaining("push rejected"),
    expect.stringContaining(`now declares repo ${moved.repo}`),
  ]);
});

it("登録し直した名前で旧い根への merge の回答は、PR を読む前に両方の repo を名指して拒む", async () => {
  const { db, old, moved, root, github, move, answer } = await reefWithPr("escalate");
  await move();
  github.scriptClosedOutside(1, moved.repo);

  const refusal = await answer("merge").catch((error: Error) => error);

  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain(`recorded repo ${old.repo}`);
  expect((refusal as Error).message).toContain(`now declares repo ${moved.repo}`);
  expect([github.stateChecks, github.ciChecks, github.merged]).toEqual([[], [], []]);
  expect(rootPrOutcome(db, root.id)).toBeNull();
});

it("登録し直した名前で旧い根への hold は、PR を読まずに受ける", async () => {
  const { db, moved, root, github, move, answer } = await reefWithPr("escalate");
  await move();
  github.scriptClosedOutside(1, moved.repo);

  const answered = await answer("hold");

  expect(github.stateChecks).toEqual([]);
  expect(rootPrOutcome(db, root.id)).toBeNull();
  expect(getTask(db, answered.id)?.status).toBe("done");
  expect(boardEvents(db, root.id, "landing_declined")).toHaveLength(1);
});

it("無人 merge の tick が PR の読みを待つ間に登録し直すと、読みから決着を刻まず旧い根を止める", async () => {
  const fixture = await reefWithPr("auto_if_ci_green");
  const { old, github, landing, move } = fixture;
  github.scriptClosedOutside(1, old.repo);
  const window = awaitWindow();
  afterCiRead(github, window.hold);

  const ticking = landing.tick("auto_merge");
  await window.entered;
  await move();
  window.open();
  await ticking;

  expect(github.ciChecks).toEqual([{ path: old.path, number: 1 }]);
  expectStopped(fixture);
});

it.each(["outside_merge", "observe"] as const)("%s が PR の状態を待つ間に登録し直すと、観測を刻まず旧い根を止める", async (action) => {
  const fixture = await reefWithPr(action === "observe" ? "auto_if_ci_green" : "escalate");
  const { old, github, landing, move } = fixture;
  github.scriptClosedOutside(1, old.repo);
  const window = awaitWindow();
  const read = github.getPullRequestState.bind(github);
  vi.spyOn(github, "getPullRequestState").mockImplementation(async (ref) => {
    const result = await read(ref);
    await window.hold();
    return result;
  });

  const observing = action === "observe" ? landing.observeAutoMergeOutcomes("tako") : landing.tick(action);
  await window.entered;
  await move();
  window.open();
  await observing;

  expect(github.stateChecks).toEqual([{ path: old.path, number: 1 }]);
  expectStopped(fixture);
});

it.each(["outside_merge", "observe"] as const)("%s は旧い repo への merge の結果を待つ根に昇格失敗 question を立てない", async (action) => {
  const { db, old, root, github, landing, move, answer } = await reefWithPr(action === "observe" ? "auto_if_ci_green" : "escalate");
  const window = awaitWindow();
  holdAfterMerge(github, window.hold);

  const merging = action === "observe" ? landing.tick("auto_merge") : answer("merge");
  await window.entered;
  await move();
  await (action === "observe" ? landing.observeAutoMergeOutcomes("tako") : landing.tick(action));
  window.open();
  await merging;

  expect(github.merged).toEqual([{ path: old.path, number: 1 }]);
  expect(rootPrOutcome(db, root.id)).toEqual({ state: "MERGED", observed: false, prNumber: 1 });
  expect(promotionFailures(db, root.id)).toEqual([]);
});

it("merge の回答が CI の読みを待つ間に登録し直すと、両方の repo を名指して拒む", async () => {
  const { db, old, moved, root, github, move, answer } = await reefWithPr("escalate");
  const window = awaitWindow();
  afterCiRead(github, window.hold);

  const answering = answer("merge").catch((error: Error) => error);
  await window.entered;
  await move();
  window.open();
  const refusal = await answering;

  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain(`recorded repo ${old.repo}`);
  expect((refusal as Error).message).toContain(`now declares repo ${moved.repo}`);
  expect(github.ciChecks).toEqual([{ path: old.path, number: 1 }]);
  expect(github.merged).toEqual([]);
  expect(rootPrOutcome(db, root.id)).toBeNull();
});

it("書き換えられた head への merge 回答の寄り道で登録し直すと、待っていた PR の決着は刻まない", async () => {
  const { db, clock, reef, old, moved, root, github, move, answer } = await reefWithPr("escalate");
  const workspace = reef.resolve("reef");
  const tip = git(workspace.path, "rev-parse", `task/${root.id}`);
  const outside = await pushOutsideBoard(workspace, root.id, `${tip}~1`);
  registerMergeQuestion(db, root, {
    pr: 1, tip, outside: { kind: "rewritten", sha: outside }, missingBranches: null, reason: "outside_head",
  }, "Merge the rewritten head, or hold?", "hold", clock.now());
  const window = awaitWindow();
  const read = github.getPullRequestState.bind(github);
  vi.spyOn(github, "getPullRequestState").mockImplementationOnce(read).mockImplementationOnce(async (ref) => {
    github.scriptClosedOutside(1, old.repo);
    const result = await read(ref);
    await window.hold();
    return result;
  });

  const answering = answer("merge").catch((error: Error) => error);
  await window.entered;
  await move();
  window.open();
  const refusal = await answering;

  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain(`recorded repo ${old.repo}`);
  expect((refusal as Error).message).toContain(`now declares repo ${moved.repo}`);
  expect(github.stateChecks).toEqual([{ path: old.path, number: 1 }, { path: old.path, number: 1 }]);
  expect(rootPrOutcome(db, root.id)).toBeNull();
});

it("無人 merge の執行が token を待つ間に登録し直すと、最後の確認で旧い根を止める", async () => {
  const fixture = await reefWithPr("auto_if_ci_green");
  const { old, github, landing, move } = fixture;
  const window = heldInPrepareMerge(github);

  const ticking = landing.tick("auto_merge");
  await window.entered;
  await move();
  window.open();
  await ticking;

  expect(github.ciChecks).toEqual([{ path: old.path, number: 1 }]);
  expect(github.merged).toEqual([]);
  expectStopped(fixture);
});

it("無人 merge の失敗を待つ間に登録し直すと、PR を読み直す前に旧い根を止める", async () => {
  const fixture = await reefWithPr("auto_if_ci_green");
  const { old, github, landing, move } = fixture;
  const window = awaitWindow();
  github.prepareMerge = async () => async () => {
    await window.hold();
    throw new Error("merge unavailable");
  };

  const ticking = landing.tick("auto_merge");
  await window.entered;
  await move();
  window.open();
  await ticking;

  expect(github.ciChecks).toEqual([{ path: old.path, number: 1 }]);
  expectStopped(fixture);
});

it("無人 merge の PR 読み取りが token を待つ間に登録し直すと、gh を起動せず旧い根を止める", async () => {
  const { db, clock, reef, moved, root, move } = await reefWithPr("auto_if_ci_green", "https://github.com/acme/reef-old.git");
  const { window, githubAuth } = fetchHeldAtToken();
  const ghCommands = await recordGhCommands();
  const github = new GhCliClient(githubAuth, MATCHING_GH);
  const landing = createLanding({ db, clock, resolveWorkspace: reef.resolve, defaultAgentName: "tako", github });

  const ticking = landing.tick("auto_merge");
  await window.entered;
  await move();
  window.open();
  await ticking;

  expect(ghCommands()).toBe("");
  expect(rootPrOutcome(db, root.id)).toBeNull();
  const [failure] = promotionFailures(db, root.id);
  expect(failure?.purpose).toContain("recorded repo acme/reef-old");
  expect(failure?.purpose).toContain(`now declares repo ${moved.repo}`);
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
});

it("merge の回答が執行用 token を待つ間に登録し直すと、取得に失敗しても両方の repo を名指す", async () => {
  const { db, moved, root, github, move, answer } = await reefWithPr("escalate", "https://github.com/acme/reef-old.git");
  const { window, githubAuth } = fetchHeldAtToken();
  githubAuth.ensureToken = async () => {
    await window.hold();
    throw new Error("token unavailable");
  };
  const ghCommands = await recordGhCommands();
  const client = new GhCliClient(githubAuth, MATCHING_GH);
  github.prepareMerge = client.prepareMerge.bind(client);

  const answering = answer("merge").catch((error: Error) => error);
  await window.entered;
  await move();
  window.open();
  const refusal = await answering;

  expect(refusal).toBeInstanceOf(DomainError);
  expect((refusal as Error).message).toContain("recorded repo acme/reef-old");
  expect((refusal as Error).message).toContain(`now declares repo ${moved.repo}`);
  expect(ghCommands()).toBe("");
  expect(rootPrOutcome(db, root.id)).toBeNull();
});

// ADR 0399 決定5・6: 止まった PR のある根の出口「この根の着地を終える」(spec #3595 の振る舞い 4)
/** 着地を終えた根に、収束・両方の tick・無人 merge の観測をもう一度流す —— どれも問い直さず GitHub を撃たない(#3604 のコメント)。 */
async function expectNothingReasked({ db, root, github, landing }: Awaited<ReturnType<typeof reefWithPr>>) {
  const calls = () => [github.stateChecks.length, github.ciChecks.length, github.merged.length, github.pushes.length, github.requests.length];
  const before = calls();
  await landing.converge();
  await landing.tick("auto_merge");
  await landing.tick("outside_merge");
  await landing.observeAutoMergeOutcomes("tako");
  expect(calls()).toEqual(before);
  expect(promotionFailures(db, root.id).filter((task) => task.status === "todo")).toEqual([]);
  expect(rootPrOutcome(db, root.id)).toBeNull();
}

it("無人 merge キューで止まった PR のある根は「end landing」で着地を終え、キューから外れ、収束も tick も問い直さない", async () => {
  const fixture = await reefWithPr("auto_if_ci_green");
  const { db, root, landing, move, answerFailure } = fixture;
  await move();
  await landing.tick("auto_merge");
  // ADR 0399 決定5: 食い違いで止まった PR の根には断念を出さない —— 断念はキューの行を残し、次の tick が同じ食い違いを問い直す
  expect(promotionFailures(db, root.id).map((task) => task.question_items?.[0]?.options)).toEqual([["retry", "end landing"]]);

  const answered = await answerFailure("end landing");

  expect(getTask(db, answered.id)?.question_answer).toEqual(["end landing"]);
  expect(boardEvents(db, root.id, "landing_ended_pr_left")).toEqual([
    { actor_id: HUMAN_ACTOR_ID, origin: "webui", payload: { kind: "landing_ended_pr_left", question_ids: [] } },
  ]);
  expect(boardEvents(db, root.id, "landing_declined")).toEqual([]);
  expect(landingState(db, getTask(db, root.id)!)).toBe("pr_left");
  await expectNothingReasked(fixture);
});

it("merge question で止まった PR のある根は「end landing」で、merge question を PR の観測を刻まずに引退させる", async () => {
  const fixture = await reefWithPr("escalate");
  const { db, root, landing, move, answerFailure } = fixture;
  await move();
  await landing.tick("outside_merge");
  const merge = listBoard(db).find((task) => task.status === "todo" && task.question_pending_merge_task_id === root.id)!;

  await answerFailure("end landing");

  const retired = getTask(db, merge.id)!;
  expect([retired.status, retired.question_answer]).toEqual(["done", null]);
  expect(settledByObservation(db, retired)).toBeNull();
  expect(boardEvents(db, root.id, "landing_ended_pr_left").map(({ payload }) => payload)).toEqual([{ kind: "landing_ended_pr_left", question_ids: [merge.id] }]);
  expect(landingState(db, getTask(db, root.id)!)).toBe("pr_left");
  await expectNothingReasked(fixture);
});

it("merge 中の印が付いた根への「end landing」は拒まれ、根の着地は終わらない", async () => {
  const { db, clock, root, landing, answerFailure } = await reefWithPr("auto_if_ci_green");
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  const release = landing.takeInFlightMark(root.id)!;

  await expect(answerFailure("end landing")).rejects.toThrow("PR #1 is being merged or pushed to by the board right now");

  release();
  expect(boardEvents(db, root.id, "landing_ended_pr_left")).toEqual([]);
  expect(landingState(db, getTask(db, root.id)!)).toBe("auto_merge_queue");
});

// ADR 0413 決定2: 人間が着地を終えた根にも、根の下に未決着の子があれば盤面名義の告知を回答と同じ transaction で書く(ADR 0405 決定2)
const ENDED_NOTICE =
  "Landing of this task was ended with PR #1 left as it was. Tasks under it that return to its branch will not run " +
  "— the queue marks them skipped. Cancel them; register the work again if it is still wanted.";

it("根の下に未決着の子があれば、「end landing」の回答は盤面名義の告知を根に1行書き、出口は cancel だけを言う", async () => {
  const { db, clock, root, answerFailure } = await reefWithPr("auto_if_ci_green");
  attachUnsettledChild(db, clock, root.id);
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());

  const answered = await answerFailure("end landing");

  expect(answered).not.toHaveProperty("notice");
  expect(boardEvents(db, root.id, "decision_logged")).toEqual([
    { actor_id: BOARD_ACTOR_ID, origin: "board", payload: { kind: "decision_logged", line: ENDED_NOTICE } },
  ]);
});

it("「end landing」の告知が書けなければ回答ごと巻き戻り、根の着地は終わらず question も開いたまま", async () => {
  const { db, clock, root, answerFailure } = await reefWithPr("auto_if_ci_green");
  attachUnsettledChild(db, clock, root.id);
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  failEventInsert(db, "decision_logged");

  await expect(answerFailure("end landing")).rejects.toThrow("decision_logged write failed");

  expect(boardEvents(db, root.id, "landing_ended_pr_left")).toEqual([]);
  expect(promotionFailures(db, root.id).map((task) => task.status)).toEqual(["todo"]);
});

it("食い違い以外で止まった PR の根(修理の push が拒まれた)は、断念も着地を終える出口も出す(ADR 0241 決定3 / ADR 0399 決定5)", async () => {
  const { db, clock, reef, root, github, landing, answerFailure } = await reefWithPr("escalate");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), root, "repair.txt", "repair\n");
  github.scriptPushFailure(new Error("push rejected"));

  await landing.converge();

  expect(promotionFailures(db, root.id).map((task) => task.question_items?.[0]?.options)).toEqual([["retry", "abandon promotion", "end landing"]]);
  await answerFailure("end landing");
  expect(landingState(db, getTask(db, root.id)!)).toBe("pr_left");
});

it("同じ根に開いた別の昇格失敗の question も「end landing」の回答が閉じ、記録が名指す", async () => {
  const { db, clock, root, landing, move, answerFailure } = await reefWithPr("auto_if_ci_green");
  await move();
  await landing.tick("auto_merge");
  registerPrPromotionFailureQuestion(db, root, "push rejected", clock.now());
  const [answering, second] = promotionFailures(db, root.id);

  await answerFailure("end landing");

  expect(getTask(db, answering!.id)?.question_answer).toEqual(["end landing"]);
  expect([getTask(db, second!.id)?.status, getTask(db, second!.id)?.question_answer]).toEqual(["done", null]);
  expect(boardEvents(db, root.id, "landing_ended_pr_left").map(({ payload }) => payload)).toEqual([{ kind: "landing_ended_pr_left", question_ids: [second!.id] }]);
});

it("別の checkout で登録し直した名前でも、着地を終えた根の下の子は塞がれて拾われない —— 根のブランチが読めなくても塞ぐ(ADR 0399 決定5・6)", async () => {
  const { db, clock, reef, root, landing, move, answerFailure } = await reefWithPr("escalate");
  const child = attachUnsettledChild(db, clock, root.id);
  await move();
  await landing.tick("outside_merge");

  await answerFailure("end landing");

  expect(blockingRootOf(db, reef.resolve)(getTask(db, child.id)!)).toEqual({ task_id: root.id, pr_number: 1, kind: "landing_ended" });
  expect(nextSlotTask(db, "reef", undefined, undefined, undefined, undefined, blockingRootOf(db, reef.resolve))).toBeUndefined();
});

/** PR の無い根の PR 作成で、`createPullRequest` が宣言を読んで PR を作った後の await(本物では作成の応答待ち)で1回止める盤面。
 *  `during` はその窓の間の人間の手。merge dial は PR を読まない(既定)ので、作成の後に宣言を読み直すのは比較器だけ。 */
async function heldAfterPrCreated(during: (fixture: { db: Db; reef: RegisteredReef; old: WorkspaceConfig }) => Promise<void> | void) {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeLandingWorkspace("reef-old");
  const reef = await registeredReef(old);
  giveHeadRepo(db, reef, old.head_repo!);
  const github = new FakeGitHubClient();
  const root = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), root, "feature.txt", "ready\n");
  const done = finish(db, clock, root);
  const window = awaitWindow();
  const original = github.createPullRequest.bind(github);
  // FakeGitHubClient は宣言を同期で読む —— 窓は本物の順(宣言を読んだ後の await)に合わせて、元の呼び出しが返った後に置く
  github.createPullRequest = async (input) => {
    const created = await original(input);
    await window.hold();
    return created;
  };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github });
  const converging = landing.converge();
  await window.entered;
  const door = await Promise.resolve(during({ db, reef, old })).then(() => undefined, (error: unknown) => error);
  window.open();
  const [verdict, ...rest] = await converging;
  expect(rest).toEqual([]);
  return { db, old, root: done, github, verdict: verdict!.verdict, door };
}

it("PR を作る応答を待つ間に registry の path: を同じ repo の clone へ手で書き換え古い checkout を消すと、根だけが path の変更で止まり、作った PR は記録されている(ADR 0399 決定3・5)", async () => {
  const { db, root, verdict, door } = await heldAfterPrCreated(async ({ reef, old }) => {
    const clone = join(await tempDir("reef-clone-"), "reef");
    git(old.path, "clone", "--quiet", old.path, clone);
    git(clone, "remote", "set-url", "origin", old.repo!);
    git(clone, "remote", "add", HEAD_REPO_REMOTE, old.head_repo!);
    setWorkspaceEntry(reef.registryDir, "reef", "path", clone);
    rmSync(old.path, { recursive: true, force: true });
  });

  expect(door).toBeUndefined();
  expect(verdict.kind).toBe("failed");
  const [failure, ...rest] = promotionFailures(db, root.id);
  expect(rest).toEqual([]);
  expect(failure?.purpose).toContain("the registered checkout path changed during the operation");
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
  expect(getTask(db, root.id)?.pr_number).toBe(1);
});

it("PR を作る応答を待つ間に registry の path: と repo: を別の checkout へ手で書き換えると、repo: の手編集として workspace で止まり、作った PR は記録されている(ADR 0378 決定6)", async () => {
  const { workspace: other } = await makeLandingWorkspace("reef-new");
  const { db, root, verdict, door } = await heldAfterPrCreated(({ reef, old }) => {
    setWorkspaceEntry(reef.registryDir, "reef", "path", other.path);
    setWorkspaceEntry(reef.registryDir, "reef", "repo", other.repo!);
    rmSync(old.path, { recursive: true, force: true });
  });

  expect(door).toBeUndefined();
  expect(verdict.kind).toBe("quarantined");
  expect(getTask(db, openQuarantineQuestion(db, "workspace", "reef")!.id)!.purpose).toContain(`its registry entry now says ${other.repo}`);
  expect(getTask(db, root.id)?.pr_number).toBe(1);
});

it("PR を作る応答を待つ間の削除の扉は、着地を待つ根を数えて拒み、根は作った PR で着地する", async () => {
  const { workspace: moved } = await makeLandingWorkspace("reef-new");
  const { db, root, verdict, door } = await heldAfterPrCreated(({ db, reef }) => reRegister(db, reef, moved));

  expect(door).toMatchObject({ reasons: [{ code: "tasks_awaiting_landing", task_ids: [root.id] }] });
  expect(verdict).toMatchObject({ kind: "landed", form: "pull_request_opened", prNumber: 1 });
  expect(getTask(db, root.id)?.pr_number).toBe(1);
});
