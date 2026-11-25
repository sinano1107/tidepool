// ADR 0415: 写しを消しうる出元 repo の畳みは扉と workspace の Quarantine の受理でだけ行い、行き先の検査は終わっていない変更で1回止める(#3797)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { workspaceNetworkDestination } from "../src/github-auth.js";
import { assertLandingRefs, createLanding } from "../src/landing.js";
import { openQuarantineValues } from "../src/quarantine.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { getTask, registerTask } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import {
  announceHeadRepo,
  assertRememberedHeadRepo,
  finishHeadRepoChange,
  pickupGate,
  quarantineWorkspace,
  UnfinishedHeadRepoChangeError,
  type WorkspaceConfig,
  WorkspaceRepoMismatchError,
  withRememberedRepoCheck,
} from "../src/workspace.js";
import { FakeClock, FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { checkoutTaskBranch, commitWork, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeLandingWorkspace, makeRemoteBackedWorkspace, makeWorkspace, quarantineQuestion } from "./harness.js";
import {
  answerWorkspaceQuarantine,
  breakPackedRefs,
  convergeOn,
  finish,
  landingWork,
  mergeQuestions,
  openBoard,
  profile,
  promotionFailures,
  recordPrOpenedOutsideConvergence,
} from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-25T00:00:00.000Z");
const copies = (workspace: WorkspaceConfig) => git(workspace.path, "for-each-ref", "--format=%(refname)", "refs/remotes/head-repo/");

/** 扉が予告 `[無し, fork]` と registry の宣言・checkout の remote までを書いて死んだ workspace の、done の根。 */
async function doneRootAfterDeadDoor(name: string) {
  const { workspace: local } = await makeRemoteBackedWorkspace(name);
  const fork = await tempDir("tidepool-head-repo-");
  git(fork, "clone", "--bare", local.repo!, ".");
  git(local.path, "remote", "add", "head-repo", fork);
  git(local.path, "fetch", "--quiet", "head-repo");
  const workspace: WorkspaceConfig = { ...local, head_repo: fork };
  const { db, clock } = await openBoard();
  announceHeadRepo(db, local, fork);
  return { ...(await doneRoot(db, clock, workspace)), fork };
}

/** 覚えた古い fork の写しを持つ workspace で、扉が新しい fork への予告 `[古い fork, 新しい fork]` と remote・registry の宣言までを書いて
 *  死んだ形の、done の根。`landing` は今の宣言を引き直す。 */
async function doneRootMidChange(name: string) {
  const { workspace: old } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  git(old.path, "fetch", "--quiet", "head-repo");
  const next = await tempDir("tidepool-next-fork-");
  git(next, "clone", "--bare", old.repo!, ".");
  announceHeadRepo(db, old, next);
  git(old.path, "remote", "set-url", "head-repo", next);
  return { ...(await doneRoot(db, clock, { ...old, head_repo: next })), old };
}

async function doneRoot(db: Db, clock: FakeClock, workspace: WorkspaceConfig) {
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github });
  const work = landingWork(db, clock, workspace.name);
  checkoutTaskBranch(db, workspace, work.id);
  commitWork(workspace.path, "board.txt", "board\n");
  git(workspace.path, "checkout", "--quiet", "main");
  finish(db, clock, work);
  return { workspace, db, clock, github, landing, work };
}

it("予告 [無し, fork] が残り ref が読めない checkout の根の収束は、workspace の Quarantine 1つで止まり、昇格失敗 question を立てず、2回目も重ねない", async () => {
  const { workspace, db, landing, work } = await doneRootAfterDeadDoor("unfinished-head-repo-unreadable");
  breakPackedRefs(workspace);

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
  expect(promotionFailures(db, work.id)).toEqual([]);
});

it("同じ行で ref が読める checkout でも収束は止まり、出元 repo の写しを消さず、変更は終わらないまま残る", async () => {
  const { workspace, db, landing, work } = await doneRootAfterDeadDoor("unfinished-head-repo-readable");
  const before = copies(workspace);
  expect(before).not.toBe("");

  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  expect(copies(workspace)).toBe(before);
  expect(() => assertRememberedHeadRepo(db, workspace, NOW)).toThrow(UnfinishedHeadRepoChangeError);
});

it("予告 [古い fork, 新しい fork] の workspace の Quarantine に回答すると、古い fork の写しが消え、変更が終わり、次の収束が進む", async () => {
  const { workspace, db, clock, landing, work } = await doneRootMidChange("unfinished-head-repo-answer");
  expect(copies(workspace)).not.toBe("");
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "quarantined" });

  await answerWorkspaceQuarantine({ db, clock, workspace, landing }, quarantineQuestion(db, "workspace", workspace.name)!);

  expect(copies(workspace)).toBe("");
  expect(() => assertRememberedHeadRepo(db, workspace, NOW)).not.toThrow();
  await expect(convergeOn(landing, work.id)).resolves.toMatchObject({ kind: "landed", form: "pull_request_opened" });
});

it("ref が読めないままの回答は git の文つきで拒まれて Quarantine は開いたまま、直してから答えると受理される", async () => {
  const { workspace, db, clock, landing, work } = await doneRootAfterDeadDoor("unfinished-head-repo-answer-unreadable");
  breakPackedRefs(workspace);
  await convergeOn(landing, work.id);
  const question = quarantineQuestion(db, "workspace", workspace.name)!;

  await expect(answerWorkspaceQuarantine({ db, clock, workspace, landing }, question)).rejects.toThrow("not a packed ref");
  expect(quarantineQuestion(db, "workspace", workspace.name)?.id).toBe(question.id);

  const packed = join(workspace.path, ".git", "packed-refs");
  writeFileSync(packed, readFileSync(packed, "utf8").replace("not a packed ref\n", ""));
  await answerWorkspaceQuarantine({ db, clock, workspace, landing }, question);

  expect(quarantineQuestion(db, "workspace", workspace.name)).toBeUndefined();
  expect(copies(workspace)).toBe("");
  expect(() => assertRememberedHeadRepo(db, workspace, NOW)).not.toThrow();
});

it("出元 repo の remote が宣言と食い違ったままの回答は、その文つきで拒まれ、写しを消さず、変更は終わらないまま残る", async () => {
  const { workspace, db, clock, landing, work } = await doneRootMidChange("unfinished-head-repo-answer-remote");
  await convergeOn(landing, work.id);
  const question = quarantineQuestion(db, "workspace", workspace.name)!;
  const before = copies(workspace);
  const elsewhere = await tempDir("tidepool-elsewhere-fork-");
  git(workspace.path, "remote", "set-url", "head-repo", elsewhere);

  await expect(answerWorkspaceQuarantine({ db, clock, workspace, landing }, question)).rejects.toThrow(`its checkout's 'head-repo' remote is ${elsewhere}`);

  expect(quarantineQuestion(db, "workspace", workspace.name)?.id).toBe(question.id);
  expect(copies(workspace)).toBe(before);
  expect(() => assertRememberedHeadRepo(db, workspace, NOW)).toThrow(UnfinishedHeadRepoChangeError);
});

it("外す予告 [fork, 無し] が残り宣言が無い workspace は行き先の読みで止まって外す変更を言い、回答で写しが消えて変更が終わる", async () => {
  const { workspace: given } = await makeLandingWorkspace("unfinished-head-repo-removal");
  const { db, clock } = await openBoard();
  git(given.path, "fetch", "--quiet", "head-repo");
  announceHeadRepo(db, given, undefined);
  git(given.path, "config", "--remove-section", "remote.head-repo");
  const workspace = { ...given, head_repo: undefined };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: new FakeGitHubClient() });

  expect(() => workspaceNetworkDestination(withRememberedRepoCheck(db, workspace, () => NOW))).toThrow(UnfinishedHeadRepoChangeError);
  expect(quarantineQuestion(db, "workspace", workspace.name)?.purpose).toContain(
    `workspace ${workspace.name}'s removal of head repo ${given.head_repo} is not finished. Answer, and the board deletes the checkout's copies from it and finishes the removal; or set the head repo again in the workspace settings`,
  );

  await answerWorkspaceQuarantine({ db, clock, workspace, landing }, quarantineQuestion(db, "workspace", workspace.name)!);

  expect(copies(workspace)).toBe("");
  expect(workspaceNetworkDestination(withRememberedRepoCheck(db, workspace, () => NOW))?.url).toBe(workspace.repo);
});

it("ref の移動で既に開いている workspace の Quarantine に終わっていない変更が重なると、文面はそのままで、受理が畳んでそう告げ、Quarantine は増えない", async () => {
  const { workspace: old } = await makeLandingWorkspace("unfinished-head-repo-already-open");
  const { db, clock } = await openBoard();
  git(old.path, "fetch", "--quiet", "head-repo");
  assertLandingRefs(db, old, undefined, undefined, NOW);
  git(old.path, "tag", "intruder");
  expect(() => assertLandingRefs(db, old, undefined, undefined, NOW)).toThrow();
  const next = await tempDir("tidepool-next-fork-");
  git(next, "clone", "--bare", old.repo!, ".");
  announceHeadRepo(db, old, next);
  git(old.path, "remote", "set-url", "head-repo", next);
  const workspace = { ...old, head_repo: next };
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: new FakeGitHubClient() });

  expect(() => workspaceNetworkDestination(withRememberedRepoCheck(db, workspace, () => NOW))).toThrow(UnfinishedHeadRepoChangeError);
  expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
  expect(quarantineQuestion(db, "workspace", workspace.name)!.purpose).toContain("refs/tags/intruder");
  expect(quarantineQuestion(db, "workspace", workspace.name)!.purpose).not.toContain("is not finished");

  git(old.path, "tag", "-d", "intruder");
  const answered = await answerWorkspaceQuarantine({ db, clock, workspace, landing }, quarantineQuestion(db, "workspace", workspace.name)!);

  expect(answered).toMatchObject({
    notice: `The board finished the head repo change of workspace ${workspace.name} and deleted its checkout's copies from the previous head repo.`,
  });
  expect(copies(workspace)).toBe("");
  expect(openQuarantineValues(db, "workspace")).toEqual([]);
});

it("畳むものが無い workspace の Quarantine への回答は、変更を終えたとは告げない", async () => {
  const { workspace } = await makeLandingWorkspace("no-head-repo-change");
  const { db, clock } = await openBoard();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github: new FakeGitHubClient() });
  quarantineWorkspace(db, workspace.name, new Error("repair the checkout"), NOW);

  const answered = await answerWorkspaceQuarantine({ db, clock, workspace, landing }, quarantineQuestion(db, "workspace", workspace.name)!);

  expect(answered).not.toHaveProperty("notice");
});

// ADR 0415 決定2: 行き先を読む呼び手は、どれも同じ下位型を受け、Quarantine を重ねない
describe("終わっていない変更に当たった行き先の読み", () => {
  const unfinished = "change of head repo to acme/fork is not finished";

  /** 扉が予告 `[無し, acme/fork]` と remote・registry の宣言までを書いて死んだ workspace と、次に拾う task。 */
  async function deadDoor(name: string) {
    const workspace = { ...(await makeWorkspace(name)), repo: "https://github.com/acme/widget", head_repo: "acme/fork" };
    git(workspace.path, "remote", "add", "origin", workspace.repo);
    git(workspace.path, "remote", "add", "head-repo", "https://github.com/acme/fork.git");
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    announceHeadRepo(db, { ...workspace, head_repo: undefined }, workspace.head_repo);
    const task = registerTask(db, { type: "work", title: "next pickup", purpose: "p", completion_criteria: "c", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
    return { db, workspace, task };
  }

  it("pickup の門", async () => {
    const { db, workspace, task } = await deadDoor("unfinished-head-repo-pickup");
    const base = await tempDir("tidepool-destination-checkouts-");

    for (let i = 0; i < 2; i++) {
      await expect(pickupGate(db, workspace, task, base, () => NOW)).rejects.toMatchObject({ cause: expect.any(UnfinishedHeadRepoChangeError) });
    }

    expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
    expect(quarantineQuestion(db, "workspace", workspace.name)!.purpose).toContain(unfinished);
  });

  it("scheduler の poll", async ({ onTestFinished }) => {
    const { db, workspace, task } = await deadDoor("unfinished-head-repo-poll");
    const clock = new FakeClock();
    const worker = new ScriptedWorker(clock);
    const slot = new Slot();
    const containers = fakeContainers();
    const scheduler = startScheduler({
      retrospectiveCalls: noRetrospectiveCalls,
      converge: async () => [],
      db, clock, slot, worker, containers, github: new FakeGitHubClient(),
      onSpawnFailed: () => {},
      onRecordContainerFailed: () => {},
      onPickupStopped: queueReturnHandler({ db, clock, slot, resolve: () => workspace, pollNow: () => scheduler.pollNow() }, containers, { defaultWorkspaceName: workspace.name }),
      taskExecutionCandidates: implicitTaskExecutionCandidates(db),
      workspace,
      resolveWorkspace: () => workspace,
      workspacesDir: await tempDir("tidepool-destination-checkouts-"),
    });
    onTestFinished(() => scheduler.stop());

    await clock.advance(HOURLY);
    await vi.waitFor(() => expect(quarantineQuestion(db, "workspace", workspace.name)).toBeDefined());
    await clock.advance(HOURLY);

    expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
    expect(quarantineQuestion(db, "workspace", workspace.name)!.purpose).toContain(unfinished);
    expect(worker.started).toEqual([]);
    expect(getTask(db, task.id)).toMatchObject({ status: "todo" });
  });

  it("無人 merge の tick", async () => {
    const { workspace: old } = await makeLandingWorkspace("unfinished-head-repo-tick");
    const { db, clock } = await openBoard();
    const next = await tempDir("tidepool-next-fork-");
    git(next, "clone", "--bare", old.repo!, ".");
    announceHeadRepo(db, old, next);
    git(old.path, "remote", "set-url", "head-repo", next);
    const workspace = { ...old, head_repo: next };
    const github = new FakeGitHubClient();
    const landing = createLanding({ defaultAgentName: "tako", db, clock, workspace, github, resolveAuthority: () => profile("auto_if_ci_green") });
    const work = landingWork(db, clock, workspace.name);
    github.scriptPullRequestOnBranch(`task/${work.id}`);
    recordPrOpenedOutsideConvergence(db, finish(db, clock, work), 1, clock.now(), { authority: { merge: "auto_if_ci_green" }, workspace });

    await landing.tick("auto_merge");
    await landing.tick("auto_merge");

    expect(openQuarantineValues(db, "workspace")).toEqual([workspace.name]);
    expect(quarantineQuestion(db, "workspace", workspace.name)!.purpose).toContain(`change of head repo to ${next} is not finished`);
    expect(github.merged).toEqual([]);
    expect(mergeQuestions(db)).toEqual([]);
  });
});

// ADR 0415 決定1: 写しを消さない畳みは今どおり検査が人間を待たずに行う
describe("行を書くだけの畳み", () => {
  const FORK = "https://github.com/acme/fork.git";

  /** 出元 repo `acme/fork` を覚えた workspace(remote も acme/fork)。 */
  async function rememberedFork(name: string) {
    const { workspace } = await makeRemoteBackedWorkspace(name);
    git(workspace.path, "remote", "add", "head-repo", FORK);
    const db = openDb(":memory:");
    onTestFinished(() => { db.close(); });
    const declared = { ...workspace, head_repo: "acme/fork" };
    announceHeadRepo(db, workspace, declared.head_repo);
    finishHeadRepoChange(db, declared);
    return { db, declared };
  }

  it.each([
    ["remote が前の fork のまま", FORK],
    ["remote だけ次の fork を指す", "https://github.com/acme/other.git"],
  ])("registry の commit の前に死んだ扉の予告は、宣言が前の値なら止まらない(%s)", async (_, remote) => {
    const { db, declared } = await rememberedFork("backward-head-repo");
    announceHeadRepo(db, declared, "acme/other");
    git(declared.path, "remote", "set-url", "head-repo", remote);

    expect(() => assertRememberedHeadRepo(db, declared, NOW)).not.toThrow();

    expect(quarantineQuestion(db, "workspace", declared.name)).toBeUndefined();
  });

  it("後ろ方向の予告は、remote が前の値と揃えば検査が前の値へ畳む", async () => {
    const { db, declared } = await rememberedFork("backward-head-repo-folds");
    announceHeadRepo(db, declared, "acme/other");
    assertRememberedHeadRepo(db, declared, NOW);

    // 畳まれた行は次の値を覚えていない —— 次の値の宣言は扉の外の書き換え
    expect(() => assertRememberedHeadRepo(db, { ...declared, head_repo: "acme/other" }, NOW)).toThrow(
      new WorkspaceRepoMismatchError(`workspace ${declared.name} was given head repo acme/fork, but its registry entry now says acme/other. Put \`head_repo:\` back by hand, or clear the head repo in the workspace settings, and answer; then set it there to change it.`),
    );
  });

  it("後ろ方向の予告は、remote が前の値と揃わなければ畳まない", async () => {
    const { db, declared } = await rememberedFork("backward-head-repo-unfolded");
    announceHeadRepo(db, declared, "acme/other");
    git(declared.path, "remote", "set-url", "head-repo", "https://github.com/acme/other.git");
    assertRememberedHeadRepo(db, declared, NOW);

    expect(() => assertRememberedHeadRepo(db, { ...declared, head_repo: "acme/other" }, NOW)).toThrow(UnfinishedHeadRepoChangeError);
  });

  it("同じ repo への予告は、検査が止まらずに通す", async () => {
    const { db, declared } = await rememberedFork("same-head-repo");
    announceHeadRepo(db, declared, FORK);

    expect(() => assertRememberedHeadRepo(db, { ...declared, head_repo: FORK }, NOW)).not.toThrow();

    expect(quarantineQuestion(db, "workspace", declared.name)).toBeUndefined();
  });
});
