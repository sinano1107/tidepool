import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import type { Db } from "../src/db.js";
import { GhCliClient, type GitHubClient, type IssueRef } from "../src/github.js";
import { type GitHubAuth, workspaceNetworkDestination } from "../src/github-auth.js";
import { submitAnswer } from "../src/human-verbs.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { questionKindOf } from "../src/question-kind.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { listChildren, pickupTask, registerFailureQuestion, registerTask, type Task } from "../src/tasks.js";
import { queueReturnHandler, spawnFailureHandler } from "../src/watchdog.js";
import { releaseWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { awaitWindow, FakeClock, FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, MATCHING_GH, makeRemoteBackedWorkspace, prepareAtPickup, restedInterviewRoom, shimGit } from "./harness.js";
import { commitThroughTaskCheckout, fetchHeldAtToken, landingWork, openBoard, type RegisteredReef, registeredReef, reRegister } from "./landing-fixture.js";
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

function expectRepoFailure(db: Db, task: Task, recorded: string, declared: string, worker: ScriptedWorker) {
  const questions = openQuestions(db, task);
  expect(questions).toHaveLength(1);
  const [question] = questions;
  expect(question!.purpose).toContain(`recorded repo ${recorded}`);
  expect(question!.purpose).toContain(`now declares repo ${declared}`);
  expect(questionKindOf(question!)).toMatchObject({ kind: "failure", cancel_option: "abandon" });
  expect(question!.question_items?.[0]?.options).toEqual(["retry", "abandon"]);
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

it("別の repo で登録し直した名前へ再 pickup すると、その task だけが止まり、宣言を戻して retry すると再開する (ADR 0399 決定3・5)", async () => {
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

  await reRegisterBeforeRequeue(db, reef, old, [task, question]);
  await submitAnswer({ db, landing: unusedLanding, pollNow: scheduler.pollNow }, question, ["retry"], undefined, () => clock.now(), "webui");

  await vi.waitFor(() => expect(worker.started.map(({ id }) => id)).toEqual([task.id]));
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
