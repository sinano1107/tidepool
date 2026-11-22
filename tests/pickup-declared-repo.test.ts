import { expect, it, onTestFinished, vi } from "vitest";
import type { Db } from "../src/db.js";
import type { GitHubAuth } from "../src/github-auth.js";
import { submitAnswer } from "../src/human-verbs.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { questionKindOf } from "../src/question-kind.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { listChildren, pickupTask, registerFailureQuestion, type Task } from "../src/tasks.js";
import { queueReturnHandler, spawnFailureHandler } from "../src/watchdog.js";
import { releaseWorkspace, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, makeRemoteBackedWorkspace, prepareAtPickup, restedInterviewRoom, shimGit } from "./harness.js";
import { commitThroughTaskCheckout, fetchHeldAtToken, landingWork, openBoard, type RegisteredReef, registeredReef, reRegister } from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

function schedulerOn(db: Db, clock: FakeClock, workspace: WorkspaceConfig, resolve: (name: string | null) => WorkspaceConfig, base: string, githubAuth?: GitHubAuth) {
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const containers = fakeContainers();
  const teardown = { db, clock, slot, resolve, pollNow: () => scheduler.pollNow() };
  const scheduler = startScheduler({
    db, clock, slot, worker, containers, workspace, githubAuth,
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

// The deletion door rejects unsettled references. Simulate the old task becoming eligible again after the two doors finish.
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

  const questions = openQuestions(db, task);
  expect(questions).toHaveLength(1);
  const [question] = questions;
  expect(question!.purpose).toContain(`recorded repo ${old.repo}`);
  expect(question!.purpose).toContain(`now declares repo ${moved.repo}`);
  expect(questionKindOf(question!)).toMatchObject({ kind: "failure", cancel_option: "abandon" });
  expect(question!.question_items?.[0]?.options).toEqual(["retry", "abandon"]);
  expect(worker.started).toEqual([]);
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
  expect(calls().filter(({ args }) => (args.includes("ls-remote") || args.includes("fetch")) && args.includes(moved.repo!))).toEqual([]);

  await reRegisterBeforeRequeue(db, reef, old, [task, question!]);
  await submitAnswer({ db, landing: unusedLanding, pollNow: scheduler.pollNow }, question!, ["retry"], undefined, () => clock.now(), "webui");

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
  const { scheduler, worker } = schedulerOn(db, clock, reef.resolve("reef"), reef.resolve, reef.admin.workspacesBaseDir, githubAuth);

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

  const [question] = openQuestions(db, task);
  expect(question?.purpose).toEqual(expect.stringContaining(`recorded repo ${old.repo}`));
  expect(question?.purpose).toEqual(expect.stringContaining(`now declares repo ${moved.repo}`));
  expect(worker.started).toEqual([]);
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
  expect(calls().filter(({ args }) => (args.includes("ls-remote") || args.includes("fetch")) && args.includes(moved.repo!))).toEqual([]);
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
