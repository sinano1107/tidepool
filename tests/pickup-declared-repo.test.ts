import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import type { Db } from "../src/db.js";
import { GhCliClient, type GitHubClient, type IssueRef } from "../src/github.js";
import { type GitHubAuth, workspaceNetworkDestination } from "../src/github-auth.js";
import { submitAnswer } from "../src/human-verbs.js";
import { checkoutPickupPredicates } from "../src/pickup-predicates.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { questionKindOf } from "../src/question-kind.js";
import { repositoryLabel } from "../src/repo-access.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { getTask, listChildren, pickupTask, registerFailureQuestion, registerTask, type Task } from "../src/tasks.js";
import { queueReturnHandler, spawnFailureHandler } from "../src/watchdog.js";
import { DeclaredRepoMismatchError, fireBeforeOpenPredicates, firePickupPredicates, PickupGateError, pickupRepoCheck, releaseWorkspace, type WorkspaceConfig, WorkspaceRepoMismatchError, withRememberedRepoCheck } from "../src/workspace.js";
import { awaitWindow, FakeClock, FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, MATCHING_GH, makeRemoteBackedWorkspace, prepareAtPickup, quarantineQuestion, restedInterviewRoom, shimGit } from "./harness.js";
import { commitThroughTaskCheckout, fetchHeldAtToken, landingWork, openBoard, type RegisteredReef, registeredReef, reRegister } from "./landing-fixture.js";
import { setWorkspaceEntry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

function schedulerOn(db: Db, clock: FakeClock, workspace: WorkspaceConfig, resolve: (name: string | null) => WorkspaceConfig, base: string, github: { githubAuth?: GitHubAuth; github?: GitHubClient } = {}) {
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const containers = fakeContainers();
  const teardown = { db, clock, slot, resolve, pollNow: () => scheduler.pollNow() };
  const scheduler = startScheduler({
    db, clock, slot, worker, containers, workspace, ...github,
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    onSpawnFailed: spawnFailureHandler(teardown, containers),
    onRecordContainerFailed: () => {},
    onPickupStopped: queueReturnHandler(teardown, containers, { defaultWorkspaceName: workspace.name }),
    resolveWorkspace: resolve,
    workspacesDir: base,
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
  });
  onTestFinished(() => scheduler.stop());
  return { scheduler, worker };
}

const openQuestions = (db: Db, task: Task) => listChildren(db, task.id).filter(({ type, status }) => type === "question" && status === "todo");

// ADR 0419 決定1・5: every path stops with the same one question, whose only exit is cancel, and leaves the task as it was.
function expectRepoFailure(db: Db, task: Task, recorded: string, declared: string, worker: ScriptedWorker) {
  const questions = openQuestions(db, task);
  expect(questions).toHaveLength(1);
  const [question] = questions;
  expect(question!.title).toMatch(/^the workspace's repo changed under this task: /);
  expect(question!.purpose).toContain(`recorded repo ${recorded}`);
  expect(question!.purpose).toContain(`now declares repo ${declared}`);
  expect(question!.purpose).not.toContain("worker never started");
  expect(questionKindOf(question!)).toMatchObject({ kind: "failure", cancel_option: "abandon" });
  expect(question!.question_items?.[0]?.options).toEqual(["abandon"]);
  expect(getTask(db, task.id)!.status).toBe("todo");
  const declaredRepo = db.prepare("SELECT declared_repo FROM tasks WHERE id = ?").pluck().get(task.id) as string;
  expect(repositoryLabel(JSON.parse(declaredRepo) as string)).toBe(recorded);
  expect(db.prepare("SELECT COUNT(*) FROM events WHERE task_id = ? AND kind = 'spawn_failed'").pluck().get(task.id)).toBe(0);
  expect(worker.started).toEqual([]);
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
  return question!;
}

// ADR 0378 決定9: deletion refuses unsettled references, so the fixture makes the task eligible again after registration.
async function reRegisterBeforeRequeue(db: Db, reef: RegisteredReef, workspace: WorkspaceConfig, tasks: Task[], between?: () => void) {
  const updateStatus = db.prepare("UPDATE tasks SET status = ? WHERE id = ?");
  for (const task of tasks) updateStatus.run("cancelled", task.id);
  try {
    await reRegister(db, reef, workspace, between);
  } finally {
    for (const task of tasks) updateStatus.run(task.status, task.id);
  }
}

it("別の repo で登録し直した名前へ再 pickup すると、その task だけが網に出ずに止まり、出口は cancel だけである (ADR 0399 決定3・5 / ADR 0419 決定1・5)", async () => {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("pickup-old");
  const { workspace: moved } = await makeRemoteBackedWorkspace("pickup-moved");
  const reef = await registeredReef(old);
  const task = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), task, "work.txt", "from the first pickup\n");
  await reRegisterBeforeRequeue(db, reef, moved, [task]);
  const calls = await shimGit();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir);

  await scheduler.rerunPoll();

  const question = expectRepoFailure(db, task, old.repo!, moved.repo!, worker);
  expect(calls().filter(({ args }) => (args.includes("ls-remote") || args.includes("fetch")) && args.includes(moved.repo!))).toEqual([]);
  const answers = { db, landing: unusedLanding, pollNow: scheduler.pollNow };
  await expect(submitAnswer(answers, question, ["retry"], undefined, () => clock.now(), "webui")).rejects.toThrow();

  await submitAnswer(answers, question, ["abandon"], undefined, () => clock.now(), "webui");
  await scheduler.rerunPoll();

  expect(getTask(db, task.id)!.status).toBe("cancelled");
  expect(worker.started).toEqual([]);
});

it("token を待つ間に扉で別の repo へ登録し直しても、その repo に出ず task の失敗の question で止まる (ADR 0399 決定3・5)", async () => {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("pickup-await-old");
  const { workspace: moved } = await makeRemoteBackedWorkspace("pickup-await-moved");
  const reef = await registeredReef(old);
  const task = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), task, "work.txt", "from the first pickup\n");
  const calls = await shimGit();
  const { window, githubAuth } = fetchHeldAtToken();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir, { githubAuth });

  const picking = scheduler.rerunPoll();
  await window.entered;
  try {
    await reRegisterBeforeRequeue(db, reef, { ...old, repo: moved.repo }, [{ ...task, status: "in_progress" }], () => {
      git(old.path, "remote", "set-url", "origin", moved.repo!);
    });
  } finally {
    window.open();
  }
  await picking;

  expectRepoFailure(db, task, old.repo!, moved.repo!, worker);
  expect(calls().filter(({ args }) => (args.includes("ls-remote") || args.includes("fetch")) && args.includes(moved.repo!))).toEqual([]);
});

class DestinationCheckingGitHub extends FakeGitHubClient {
  override async getIssueWithState(ref: IssueRef) {
    workspaceNetworkDestination(ref.workspace);
    return super.getIssueWithState(ref);
  }
}

it.each(["own", "parent"] as const)("再 pickup の repo の食い違いは %s issue を読む前にその task の失敗になる (ADR 0399 決定3・5)", async (source) => {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("issue-pickup-old");
  const { workspace: moved } = await makeRemoteBackedWorkspace("issue-pickup-moved");
  const reef = await registeredReef(old);
  const issueTask = registerTask(db, { type: "work", workspace: "reef", github_issue_number: 49, ...(source === "parent" && { assignee: HUMAN_ACTOR_ID }) }, clock.now(), ...HUMAN_WEBUI);
  const task = source === "own" ? issueTask : registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: issueTask.id }, clock.now(), ...HUMAN_WEBUI);
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), task, "work.txt", "from the first pickup\n");
  await reRegisterBeforeRequeue(db, reef, moved, source === "own" ? [task] : [issueTask, task]);
  const github = new DestinationCheckingGitHub();
  github.scriptIssue(49, { title: "wrong issue", body: "different work", comments: [], state: "closed" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir, { github });

  await scheduler.rerunPoll();

  expect(github.issueFetches).toEqual([]);
  expectRepoFailure(db, task, old.repo!, moved.repo!, worker);
  expect(scheduler.lastIssueExpansionFailure()).toBeUndefined();
});

it("issue の token を待つ間に別の repo へ登録し直すと、gh を撃たず task の失敗になる (ADR 0399 決定3・5)", async () => {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("issue-token-old");
  const { workspace: moved } = await makeRemoteBackedWorkspace("issue-token-moved");
  const repo = "https://github.com/acme/reef.git";
  await shimGit({ route: [repo, old.repo!] });
  git(old.path, "remote", "set-url", "origin", repo);
  const reef = await registeredReef({ ...old, repo });
  const task = registerTask(db, { type: "work", workspace: "reef", github_issue_number: 49 }, clock.now(), ...HUMAN_WEBUI);
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), task, "work.txt", "from the first pickup\n");
  const bin = await tempDir("tidepool-pickup-gh-");
  const log = join(bin, "calls");
  writeFileSync(log, "");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
  const { window, githubAuth } = fetchHeldAtToken();
  githubAuth.env = () => ({ ...process.env, PATH: `${bin}:${process.env.PATH}` });
  const github = new GhCliClient(githubAuth, MATCHING_GH);
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir, { github });

  const picking = scheduler.rerunPoll();
  await window.entered;
  try {
    await reRegisterBeforeRequeue(db, reef, moved, [task]);
  } finally {
    window.open();
  }
  await picking;

  expect(readFileSync(log, "utf8")).toBe("");
  expectRepoFailure(db, task, "acme/reef", moved.repo!, worker);
});

it("登録し直した後に旧い repo の closed が届いても、issue の消滅でなく repo の食い違いで止まる (ADR 0399 決定3・5)", async () => {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("issue-reply-old");
  const { workspace: moved } = await makeRemoteBackedWorkspace("issue-reply-moved");
  const reef = await registeredReef(old);
  const task = registerTask(db, { type: "work", workspace: "reef", github_issue_number: 49 }, clock.now(), ...HUMAN_WEBUI);
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), task, "work.txt", "from the first pickup\n");
  const github = new DestinationCheckingGitHub();
  const window = awaitWindow();
  github.scriptIssueGate(window.hold());
  github.scriptIssue(49, { title: "old issue", body: "old work", comments: [], state: "closed" });
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir, { github });

  const picking = scheduler.rerunPoll();
  try {
    await vi.waitFor(() => expect(github.issueFetches).toEqual([{ path: old.path, number: 49 }]));
    await reRegisterBeforeRequeue(db, reef, moved, [task]);
  } finally {
    window.open();
  }
  await picking;

  expectRepoFailure(db, task, old.repo!, moved.repo!, worker);
});

/** 同じ checkout を origin を向け直して別の repo で登録し直す。`between` は登録の前に checkout を崩す。 */
type Checkouts = { old: WorkspaceConfig; moved: WorkspaceConfig; publishOld: Publish; publishMoved: Publish };
type Publish = Awaited<ReturnType<typeof makeRemoteBackedWorkspace>>["publish"];

async function movedInPlace(name: string, { issue = false, between = (_checkouts: Checkouts) => {} } = {}) {
  const { db, clock } = await openBoard();
  const { workspace: old, publish: publishOld } = await makeRemoteBackedWorkspace(`${name}-old`);
  const { workspace: moved, publish: publishMoved } = await makeRemoteBackedWorkspace(`${name}-moved`);
  const reef = await registeredReef(old);
  const task = issue ? registerTask(db, { type: "work", workspace: "reef", github_issue_number: 49 }, clock.now(), ...HUMAN_WEBUI) : landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), task, "work.txt", "from the first pickup\n");
  await reRegisterBeforeRequeue(db, reef, { ...old, repo: moved.repo }, [task], () => {
    between({ old, moved, publishOld, publishMoved });
    git(old.path, "remote", "set-url", "origin", moved.repo!);
  });
  return { db, clock, old, moved, reef, task };
}

const networkTo = (calls: () => Array<{ args: string[] }>, repo: string) => calls().filter(({ args }) => (args.includes("ls-remote") || args.includes("fetch")) && args.includes(repo));

it.each(["preparation", "issue"] as const)("残った head-repo remote があれば、%s の経路でも workspace の Quarantine が先に立ち、食い違いの question は出ない (ADR 0419 決定1、#3922)", async (path) => {
  const { db, clock, moved, reef, task } = await movedInPlace(`leftover-${path}`, {
    issue: path === "issue",
    between: ({ old, moved }) => git(old.path, "remote", "add", "head-repo", moved.repo!),
  });
  const github = new DestinationCheckingGitHub();
  const calls = await shimGit();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir, { github });

  await scheduler.rerunPoll();

  expect(quarantineQuestion(db, "workspace", "reef")?.purpose).toContain("head-repo");
  expect(openQuestions(db, task)).toEqual([]);
  expect(getTask(db, task.id)!.status).toBe("todo");
  expect(github.issueFetches).toEqual([]);
  expect(networkTo(calls, moved.repo!)).toEqual([]);
  expect(worker.started).toEqual([]);
});

it("分岐した main は網に出ないと測れないので、食い違いの question が先に立ち、新しい repo へ ls-remote・fetch しない (ADR 0419 決定1、#3922 の決定)", async () => {
  const { db, clock, old, moved, reef, task } = await movedInPlace("diverged", {
    between: ({ old, publishOld, publishMoved }) => {
      publishOld("a.txt", "only in the old repo\n", "old only");
      publishMoved("b.txt", "only in the moved repo\n", "moved only");
      git(old.path, "fetch", "--quiet", "origin", "main");
      git(old.path, "merge", "--quiet", "--ff-only", "origin/main");
    },
  });
  const calls = await shimGit();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir);

  await scheduler.rerunPoll();

  expectRepoFailure(db, task, old.repo!, moved.repo!, worker);
  expect(networkTo(calls, moved.repo!)).toEqual([]);
});

it.each(["entrance", "parent read"] as const)("親の issue が別の workspace にある子の再 pickup は、%s で食い違いを読んでも同じ question で止まる (ADR 0419 決定1・2、#3922)", async (when) => {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace(`cross-${when}-old`.replace(" ", "-"));
  const { workspace: moved } = await makeRemoteBackedWorkspace(`cross-${when}-moved`.replace(" ", "-"));
  const { workspace: lagoon } = await makeRemoteBackedWorkspace(`cross-${when}-lagoon`.replace(" ", "-"));
  const reef = await registeredReef(old);
  setWorkspaceEntry(reef.registryDir, "lagoon", "path", lagoon.path);
  setWorkspaceEntry(reef.registryDir, "lagoon", "repo", lagoon.repo!);
  const parent = registerTask(db, { type: "work", workspace: "lagoon", github_issue_number: 49, assignee: HUMAN_ACTOR_ID }, clock.now(), ...HUMAN_WEBUI);
  const task = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id, workspace: "reef" }, clock.now(), ...HUMAN_WEBUI);
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), task, "work.txt", "from the first pickup\n");
  const github = new DestinationCheckingGitHub();
  github.scriptIssue(49, { title: "parent issue", body: "the parent's work", comments: [] });
  const window = awaitWindow();
  if (when === "parent read") github.scriptIssueGate(window.hold());
  else await reRegisterBeforeRequeue(db, reef, moved, [parent, task]);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir, { github });
  const pickups = () => db.prepare("SELECT COUNT(*) FROM events WHERE task_id = ? AND kind = 'task_picked_up'").pluck().get(task.id);
  const pickedBefore = pickups();

  const picking = scheduler.rerunPoll();
  if (when === "parent read") {
    try {
      await vi.waitFor(() => expect(github.issueFetches).toEqual([{ path: lagoon.path, number: 49 }]));
      await reRegisterBeforeRequeue(db, reef, moved, [parent, task]);
    } finally {
      window.open();
    }
  }
  await picking;

  expect(github.issueFetches).toEqual(when === "entrance" ? [] : [{ path: lagoon.path, number: 49 }]);
  // the parent's issue read stops it before pickupTask, not the preparation's floor
  expect(pickups()).toBe(pickedBefore);
  expectRepoFailure(db, task, old.repo!, moved.repo!, worker);
});

it("面接室の受験者は宣言の repo の記録を持たなくても、失敗の question の retry で再開する (ADR 0399 決定3)", async () => {
  const { db, ws, root, room, base, examinee } = await restedInterviewRoom("examinee-retry", true);
  onTestFinished(() => { db.close(); });
  const clock = new FakeClock();
  const task = pickupTask(db, examinee!, "fake-worker", clock.now())!;
  const place = await prepareAtPickup(db, room, task, { workspacesBaseDir: base, real: ws });
  releaseWorkspace(db, place, task, clock.now());
  registerFailureQuestion(db, task, "The first session failed", "Retry in the same room.", clock.now());
  const [question] = openQuestions(db, task);
  const { scheduler, worker } = schedulerOn(db, clock, ws, () => ws, base);

  await submitAnswer({ db, landing: unusedLanding, pollNow: scheduler.pollNow }, question!, ["retry"], undefined, () => clock.now(), "webui");

  await vi.waitFor(() => expect(worker.started.map(({ id }) => id)).toEqual([task.id]));
  expect(openQuarantineQuestion(db, "workspace", root.id)).toBeUndefined();
});

// ADR 0399 決定5 / ADR 0329 決定10: 根の記録と宣言の食い違いは場所の失敗でないので包まない。覚えた repo の食い違いは落ちた場所を名指して包む
it("開く前の項が登録し直しで根の比較に落ちると素の DeclaredRepoMismatchError が出て、覚えた repo の食い違いは落ちた場所の PickupGateError に包まれる", async () => {
  const { db, clock } = await openBoard();
  const declared = new DeclaredRepoMismatchError("task/t-1 cannot be carried: the board recorded repo acme/old for it, but workspace reef now declares repo acme/new.");
  const place = withRememberedRepoCheck(db, { name: "reef", path: "/old/reef", checkDeclaredRepo: () => { throw declared; } }, () => clock.now(), () => ({ name: "reef", path: "/new/reef" }));
  const thrown = (check: () => void) => {
    try {
      fireBeforeOpenPredicates(place, [{ phase: "before-open", describe: "the remembered repo", check }]);
    } catch (err) {
      return err;
    }
    throw new Error("no predicate failed");
  };

  expect(thrown(() => { place.checkRememberedRepo(place); })).toBe(declared);

  const remembered = new WorkspaceRepoMismatchError("workspace reef was registered for repo acme/old.");
  const failure = thrown(() => { throw remembered; });
  expect(failure).toBeInstanceOf(PickupGateError);
  expect((failure as PickupGateError).cause).toBe(remembered);
  expect((failure as PickupGateError).place.name).toBe("reef");
});

it("開いた後の項の fetch が token を待つ間に、同じ名前を別の path・別の repo で登録し直すと、PickupGateError でなく素の DeclaredRepoMismatchError が出る (ADR 0399 決定3・5)", async () => {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("after-open-old");
  const { workspace: moved } = await makeRemoteBackedWorkspace("after-open-moved");
  const reef = await registeredReef(old);
  const task = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), task, "work.txt", "from the first pickup\n");
  const place = pickupRepoCheck(db, getTask(db, task.id)!, () => clock.now(), reef.resolve)!(reef.resolve("reef"));
  const { window, githubAuth } = fetchHeldAtToken();

  const firing = firePickupPredicates(db, place, checkoutPickupPredicates(place), "after-open", { githubAuth, now: () => clock.now() }).then(
    () => undefined,
    (err: unknown) => err,
  );
  await window.entered;
  try {
    await reRegisterBeforeRequeue(db, reef, moved, [task]);
  } finally {
    window.open();
  }
  const failure = await firing;

  expect(failure).toBeInstanceOf(DeclaredRepoMismatchError);
  expect(failure).not.toBeInstanceOf(PickupGateError);
  expect((failure as Error).message).toContain(`now declares repo ${moved.repo}`);
});
