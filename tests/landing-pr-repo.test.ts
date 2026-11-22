import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { DomainError } from "../src/domain-error.js";
import { GhCliClient } from "../src/github.js";
import { submitAnswer } from "../src/human-verbs.js";
import { createLanding, rootPrOutcome, taskIdsAwaitingLandingInWorkspace } from "../src/landing.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { countUnsettledTasksReferencing, getTask, listBoard, registerMergeQuestion } from "../src/tasks.js";
import { createWorkspace, deleteWorkspace } from "../src/workspace-create.js";
import { afterCiRead, awaitWindow, FakeGitHubClient, holdAfterMerge } from "./fakes.js";
import { checkoutTaskBranch, commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, makeLandingWorkspace } from "./harness.js";
import { boardEvents, fetchHeldAtToken, finish, giveHeadRepo, landingWork, openBoard, profile, promotionFailures, pushOutsideBoard, pushPrHead, recordPrOpenedOutsideConvergence, registeredReef } from "./landing-fixture.js";
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

  // 削除の扉は参照を数えた時点の値を受ける。その後に PR がキューや question に載った盤面を作る。
  const references = {
    unsettledTaskCount: countUnsettledTasksReferencing(db, "workspace", "reef"),
    awaitingLandingTaskIds: taskIdsAwaitingLandingInWorkspace(db, reef.resolve, "reef"),
  };
  const move = async () => {
    await deleteWorkspace({ name: "reef", confirm: true }, { ...reef.admin, db, ...references });
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
  const answer = (option: "merge" | "hold") => {
    const question = listBoard(db).find((task) => task.status === "todo" && task.question_pending_merge_task_id === root.id)!;
    return submitAnswer(
      { db, pollNow: () => {}, landing, resolveWorkspace: reef.resolve, github, workspacesDir: join(reef.admin.workspacesBaseDir, "workbenches") },
      getTask(db, question.id)!, [option], undefined, () => clock.now(), "webui",
    );
  };
  return { db, clock, reef, old, moved, root, github, landing, move, answer };
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

  await landing.tick("auto_merge", clock.now());
  await landing.tick("auto_merge", clock.now());

  expect(github.ciChecks).toEqual([{ path: moved.path, number: 1 }]);
  expect(rootPrOutcome(db, newRoot.id)).toEqual({ state: "CLOSED", observed: true, prNumber: 1 });
  expectStopped(fixture);
});

it("外の merge の tick は登録し直した repo の同じ番号の PR を読まず、旧い根を止める", async () => {
  const fixture = await reefWithPr("escalate");
  const { clock, moved, github, landing, move } = fixture;
  await move();
  github.scriptClosedOutside(1, moved.repo);

  await landing.tick("outside_merge", clock.now());

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
  const { clock, old, github, landing, move } = fixture;
  github.scriptClosedOutside(1, old.repo);
  const window = awaitWindow();
  afterCiRead(github, window.hold);

  const ticking = landing.tick("auto_merge", clock.now());
  await window.entered;
  await move();
  window.open();
  await ticking;

  expect(github.ciChecks).toEqual([{ path: old.path, number: 1 }]);
  expectStopped(fixture);
});

it.each(["outside_merge", "observe"] as const)("%s が PR の状態を待つ間に登録し直すと、観測を刻まず旧い根を止める", async (action) => {
  const fixture = await reefWithPr(action === "observe" ? "auto_if_ci_green" : "escalate");
  const { clock, old, github, landing, move } = fixture;
  github.scriptClosedOutside(1, old.repo);
  const window = awaitWindow();
  const read = github.getPullRequestState.bind(github);
  vi.spyOn(github, "getPullRequestState").mockImplementation(async (ref) => {
    const result = await read(ref);
    await window.hold();
    return result;
  });

  const observing = action === "observe" ? landing.observeAutoMergeOutcomes("tako") : landing.tick(action, clock.now());
  await window.entered;
  await move();
  window.open();
  await observing;

  expect(github.stateChecks).toEqual([{ path: old.path, number: 1 }]);
  expectStopped(fixture);
});

it.each(["outside_merge", "observe"] as const)("%s は旧い repo への merge の結果を待つ根に昇格失敗 question を立てない", async (action) => {
  const { db, clock, old, root, github, landing, move, answer } = await reefWithPr(action === "observe" ? "auto_if_ci_green" : "escalate");
  const window = awaitWindow();
  holdAfterMerge(github, window.hold);

  const merging = action === "observe" ? landing.tick("auto_merge", clock.now()) : answer("merge");
  await window.entered;
  await move();
  await (action === "observe" ? landing.observeAutoMergeOutcomes("tako") : landing.tick(action, clock.now()));
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
  const { clock, old, github, landing, move } = fixture;
  const window = awaitWindow();
  const merge = github.mergePullRequest.bind(github);
  github.mergePullRequest = async (ref, head, beforeMerge) => {
    await window.hold();
    return merge(ref, head, beforeMerge);
  };

  const ticking = landing.tick("auto_merge", clock.now());
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
  const { clock, old, github, landing, move } = fixture;
  const window = awaitWindow();
  github.mergePullRequest = async () => {
    await window.hold();
    throw new Error("merge unavailable");
  };

  const ticking = landing.tick("auto_merge", clock.now());
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
  const github = new GhCliClient(githubAuth);
  const landing = createLanding({ db, clock, resolveWorkspace: reef.resolve, defaultAgentName: "tako", github });

  const ticking = landing.tick("auto_merge", clock.now());
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
  const client = new GhCliClient(githubAuth);
  github.mergePullRequest = client.mergePullRequest.bind(client);

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
