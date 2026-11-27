import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, getTask, listChildren, pickupTask, registerTask, returnToQueue } from "../src/tasks.js";
import { registerRcaReview } from "../src/triage.js";
import { workbenchPath } from "../src/workbench.js";
import { NamedPlaceSideError, recordTaskCheckoutTip, redoMergeBacks, redoOwedReleases, releaseWorkspace, type WorkspaceConfig, type WorkspaceResolver } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { answerQuestionViaWebui, checkoutOf, commitWork, decomposeTaskViaWorker, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, makeWorkspace, prepareAtPickup, quarantineQuestion, tempDirSync } from "./harness.js";
import { HUMAN_ANSWERER } from "./landing-fixture.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0369 決定4: 解放も Quarantine の登録も済まなかった状態を、checkout を開いた session を todo に戻して作る。
async function boardWithOwedRelease(end: "return" | "decompose" = "return") {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const now = clock.now();
  const ws = await makeWorkspace("owed-release");
  const workspacesDir = tempDirSync("owed-release-");
  const spec = { type: "work", title: "parent", purpose: "p", completion_criteria: "c", workspace: ws.name } as const;
  const parent = pickupTask(db, registerTask(db, spec, now, ...HUMAN_WEBUI), "deckhand", now)!;
  const checkout = await prepareAtPickup(db, ws, parent, { now, workspacesBaseDir: workspacesDir });
  commitWork(checkout.path, "parent.txt", "parent\n");
  writeFileSync(join(checkout.path, "wip.txt"), "wip\n");
  if (end === "decompose") decomposeTaskViaWorker(db, parent, { reason: "split", children: [{ title: "child", purpose: "p", completion_criteria: "c" }] }, "deckhand", now);
  else returnToQueue(db, parent, { kind: "cap_interrupted" }, now);
  const question = () => quarantineQuestion(db, "workspace", ws.name);

  function answer() {
    const checks = quarantineChecks({ quarantineResolvers: {}, db, workspace: ws, resolveWorkspace: () => ws, workspacesDir, clock });
    return submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: checks }, question()!, ["repaired by hand"], undefined, () => now, "webui");
  }

  const slot = new Slot();
  const worker = new ScriptedWorker(clock);
  function start(places: { workspace?: WorkspaceConfig; resolveWorkspace?: WorkspaceResolver } = { workspace: ws }) {
    const scheduler = startScheduler({
      db, clock, slot, worker, ...places, workspacesDir,
      containers: fakeContainers(),
      retrospectiveCalls: noRetrospectiveCalls,
      converge: async () => [],
      onSpawnFailed: () => {},
      onRecordContainerFailed: () => {},
      onPickupStopped: () => {},
      taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    });
    onTestFinished(() => scheduler.stop());
    return scheduler;
  }
  return { db, now, ws, workspacesDir, parent, checkout, question, answer, slot, worker, start };
}

it("別の session が slot を握っている poll でも、済んでいない解放の Quarantine を立てる", async () => {
  const b = await boardWithOwedRelease();
  b.slot.occupy("other-task", 1);

  await b.start().rerunPoll();

  expect(b.question()?.purpose).toContain(`The release of task ${b.parent.id} is unfinished`);
});

it("poll は解放を負う task を拾わず、回答がその枝に運んで checkout を消した後に拾う", async () => {
  const b = await boardWithOwedRelease();
  const history = () => listEvents(b.db, b.parent.id).map((e) => e.kind);
  const scheduler = b.start();

  await scheduler.rerunPoll();

  const question = b.question()!;
  expect(question.purpose).toContain(`The release of task ${b.parent.id} is unfinished and answering this question retries it.`);
  expect(question.purpose).not.toContain(b.checkout.path);
  expect(history().filter((kind) => kind === "task_picked_up")).toHaveLength(1);
  expect(history()).not.toContain("pickup_stopped");
  await scheduler.rerunPoll();
  expect(b.question()?.id).toBe(question.id);

  await b.answer();
  expect(b.question()).toBeUndefined();
  expect(git(b.ws.path, "show", `task/${b.parent.id}:parent.txt`)).toBe("parent");
  expect(git(b.ws.path, "show", `task/${b.parent.id}:wip.txt`)).toBe("wip");
  expect(existsSync(b.checkout.path)).toBe(false);

  await scheduler.rerunPoll();
  expect(b.worker.started.map((task) => task.id)).toEqual([b.parent.id]);
  expect(history().filter((kind) => kind === "task_picked_up")).toHaveLength(2);
});

it.each(["todo", "cancelled"] as const)("解放を負う親(%s)の子は、回答の後で親の commit 済み・未 commit の成果を持って走る", async (status) => {
  const b = await boardWithOwedRelease(status === "todo" ? "decompose" : "return");
  // ADR 0271 決定3: RCA は親の cancel を生き延びる付帯子。
  if (status === "cancelled") {
    const stop = appendEvent(b.db, { taskId: b.parent.id, actorId: "human", origin: "webui", payload: { kind: "session_stopped_by_human", reason: "wrong approach" }, at: b.now });
    registerRcaReview(b.db, b.parent.id, { title: "rca", purpose: "examine the stop", opened_on_event_ids: [stop] }, b.now);
    cancelTaskDirectly(b.db, getTask(b.db, b.parent.id)!, null, b.now, {}, "webui");
  }
  const child = listChildren(b.db, b.parent.id)[0]!;
  expect(getTask(b.db, b.parent.id)?.status).toBe(status);
  const scheduler = b.start();

  await scheduler.rerunPoll();

  expect(b.question()).toBeDefined();
  expect(listEvents(b.db, child.id).map((event) => event.kind)).not.toContain("task_picked_up");
  await b.answer();
  await scheduler.rerunPoll();

  expect(b.worker.started.map((task) => task.id)).toEqual([child.id]);
  const checkout = checkoutOf(b.db, child.id);
  expect(readFileSync(join(checkout, "parent.txt"), "utf8")).toBe("parent\n");
  expect(readFileSync(join(checkout, "wip.txt"), "utf8")).toBe("wip\n");
});

it("Quarantine が開いたままでも別の workspace の task は走る", async () => {
  const b = await boardWithOwedRelease();
  const other = await makeWorkspace("elsewhere");
  await leaveBaseline(b.db, other);
  const task = registerTask(b.db, { type: "work", title: "other", purpose: "p", completion_criteria: "c", workspace: other.name }, b.now, ...HUMAN_WEBUI);

  await b.start({ workspace: b.ws, resolveWorkspace: (name) => (name === other.name ? other : b.ws) }).rerunPoll();

  expect(b.question()).toBeDefined();
  expect(b.worker.started.map((task) => task.id)).toEqual([task.id]);
});

it("registry の無い再起動でも記録された名前の Quarantine は pickup を止め、名前の無い task は走る", async () => {
  const b = await boardWithOwedRelease();
  const unnamed = registerTask(b.db, { type: "work", title: "unnamed", purpose: "p", completion_criteria: "c" }, b.now, ...HUMAN_WEBUI);

  await b.start({}).rerunPoll();

  expect(b.question()).toBeDefined();
  expect(listEvents(b.db, b.parent.id).filter(({ kind }) => kind === "task_picked_up")).toHaveLength(1);
  expect(b.worker.started.map((task) => task.id)).toEqual([unnamed.id]);
});

it("worker の repo の解放が失敗した後の retry は、新しい checkout を開く", async () => {
  const b = await boardWithOwedRelease();
  rmSync(join(b.checkout.path, ".git"), { recursive: true });
  releaseWorkspace(b.db, b.checkout, b.parent, b.now);
  const failure = listChildren(b.db, b.parent.id).find((child) => child.type === "question")!;
  answerQuestionViaWebui(b.db, failure, ["retry"], b.now);

  await b.start().rerunPoll();

  expect(b.question()).toBeUndefined();
  expect(b.worker.started.map((task) => task.id)).toEqual([b.parent.id]);
  expect(checkoutOf(b.db, b.parent.id)).not.toBe(b.checkout.path);
});

/** 解放を負う親の枝へ子の成果が先に merge back された状態(ADR 0369 決定1)。 */
async function mergedChild(file: string) {
  const b = await boardWithOwedRelease("decompose");
  const child = pickupTask(b.db, listChildren(b.db, b.parent.id)[0]!, "deckhand", b.now)!;
  const checkout = await prepareAtPickup(b.db, b.ws, child, { now: b.now, workspacesBaseDir: b.workspacesDir });
  commitWork(checkout.path, file, "child\n");
  recordTaskCheckoutTip(b.db, checkout, child.id);
  completeTask(b.db, child, FULL_HANDOFF, "deckhand", b.now, "worker");
  releaseWorkspace(b.db, checkout, child, b.now, true, undefined, undefined, true);
  const target = `task/${b.parent.id}`;
  expect(git(b.ws.path, "show", `${target}:${file}`)).toBe("child");
  await b.start().rerunPoll();
  return { ...b, source: `task/${child.id}`, target };
}

it("回答は親の解放を子の merge back より先にやり直し、親子の成果を親の枝に残す", async () => {
  const b = await mergedChild("child.txt");

  await b.answer();

  expect(git(b.ws.path, "show", `${b.target}:parent.txt`)).toBe("parent");
  expect(git(b.ws.path, "show", `${b.target}:wip.txt`)).toBe("wip");
  expect(git(b.ws.path, "show", `${b.target}:child.txt`)).toBe("child");
});

it("親子の成果が競合した merge back の拒否は、名前の場所の側の失敗である(ADR 0433 決定4)", async () => {
  const b = await mergedChild("parent.txt");
  // 回答と同じ順: 親の解放をやり直してから merge back をやり直す(人間の扉は拒否文に包むので、型はその下で見る)
  redoOwedReleases(b.db, b.ws, b.ws.name, b.now, () => false);

  const redone = redoMergeBacks(b.db, b.ws, b.ws.name, undefined, { workbenchBase: b.workspacesDir, entry: "workspace_quarantine", answerer: HUMAN_ANSWERER, now: () => b.now });

  await expect(redone).rejects.toBeInstanceOf(NamedPlaceSideError);
  await expect(redone).rejects.toThrow(`${b.source} does not merge cleanly into '${b.target}'`);
});

it("親子の成果が競合すれば、回答は作業台を開いて拒まれ、Quarantine と子の枝の成果が残る", async () => {
  const b = await mergedChild("parent.txt");
  const question = b.question()!;
  const workbench = workbenchPath(b.workspacesDir, { task: b.parent.id }, b.source);

  const answer = b.answer();
  await expect(answer).rejects.toThrow(`${b.source} does not merge cleanly into '${b.target}'`);
  await expect(answer).rejects.toThrow(`opened the workbench at ${realpathSync(workbench)}`);

  expect(b.question()?.id).toBe(question.id);
  expect(git(workbench, "branch", "--show-current")).toBe(b.target);
  expect(git(b.ws.path, "show", `${b.source}:parent.txt`)).toBe("child");
});
