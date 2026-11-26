import { rmSync } from "node:fs";
import { expect, it, onTestFinished, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import type { Db } from "../src/db.js";
import { submitAnswer } from "../src/human-verbs.js";
import { createLanding, type Landing, landingState, registerPrPromotionFailureQuestion, settledByObservation } from "../src/landing.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { loadRegistry } from "../src/registry.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, getTask, listBoard, registerTask, type Task } from "../src/tasks.js";
import { queueReturnHandler, spawnFailureHandler } from "../src/watchdog.js";
import { holdsBaseline, refreshProtectedBranch } from "../src/workspace.js";
import { deleteWorkspace } from "../src/workspace-create.js";
import { FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, POSED_HEAD, poseAccepted } from "./harness.js";
import {
  answerHoldOnPr,
  answerPromotion,
  commitThroughTaskCheckout,
  completeThroughTaskCheckout,
  convergeOn,
  deletionReaders,
  fetchHeldAtToken,
  finish,
  landingWork,
  mergeOnGitHub,
  openBoard,
  openLocalMergeQuestions,
  promotionFailures,
  recordPrOpenedOutsideConvergence,
  reefWithPrRootAndChild,
  registeredReef,
  reRegister,
  settleRepairNotMergedBack,
  tearDownRepair,
} from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0421 決定1・2: 削除の扉は、通すときに、その名前の着地が終わっていない完了 task すべての着地を終える。domain 層の釘(ADR 0107)。

/** 削除の後、収束と2つの tick が `tasks` に何もしないこと —— verdict も GitHub への書き込みも開いた question も無い。 */
async function expectLandingDoesNothing(c: { db: Db; landing: Landing; github: FakeGitHubClient }, tasks: Task[]) {
  const pushes = c.github.pushes.length;
  const ids = tasks.map(({ id }) => id);
  expect((await c.landing.converge()).filter(({ taskId }) => ids.includes(taskId))).toEqual([]);
  await c.landing.tick("auto_merge");
  await c.landing.tick("outside_merge");
  expect(c.github.pushes).toHaveLength(pushes);
  expect(c.github.requests).toEqual([]);
  expect(listBoard(c.db).filter((t) => t.type === "question" && t.status === "todo")).toEqual([]);
}

it("削除が通ると、PR を開いた external の根とその下の done の子の着地が終わり、収束も tick もその task に何もしない", async () => {
  const c = await reefWithPrRootAndChild();

  await c.door();

  expect([c.root, c.child].map((task) => landingState(c.db, getTask(c.db, task.id)!))).toEqual(["workspace_deleted", "workspace_deleted"]);
  await expectLandingDoesNothing(c, [c.root, c.child]);
});

it("push の失敗に断念と答えた PR の根も、削除が着地を終える", async () => {
  const c = await reefWithPrRootAndChild();
  registerPrPromotionFailureQuestion(c.db, c.root, "push rejected", c.clock.now());
  await answerPromotion(c.db, c.clock, c.landing, c.workspace, promotionFailures(c.db, c.root.id)[0]!, "abandon promotion");

  await c.door();

  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe("workspace_deleted");
  await expectLandingDoesNothing(c, [c.root, c.child]);
});

it("merge question に hold と答えた PR の根も、削除が着地を終える", async () => {
  const c = await reefWithPrRootAndChild("escalate");
  await answerHoldOnPr(c);

  await c.door();

  expect([c.root, c.child].map((task) => landingState(c.db, getTask(c.db, task.id)!))).toEqual(["workspace_deleted", "workspace_deleted"]);
  await expectLandingDoesNothing(c, [c.root, c.child]);
});

/** purely-local の名前 `reef` で、local merge question が立った根。 */
async function localReefWithQuestion() {
  const { db, clock } = await openBoard();
  const reef = await registeredReef(await makeWorkspace("reef-local"));
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github: null });
  const root = await completeThroughTaskCheckout(db, clock, reef.resolve("reef"), landingWork(db, clock, "reef"), "feature.txt", "ready\n");
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ form: "local_merge_question" });
  const answer = async (option: "merge" | "hold", rootId = root.id) =>
    submitAnswer(
      { db, pollNow: () => {}, landing, resolveWorkspace: reef.resolve, workspacesDir: await tempDir("tidepool-task-checkouts-") },
      getTask(db, openLocalMergeQuestions(db, rootId)[0]!.id)!,
      [option],
      undefined,
      () => clock.now(),
      "webui",
    );
  const door = (confirm = true) => deleteWorkspace({ name: "reef", confirm }, { ...reef.admin, db, ...deletionReaders(db, reef.resolve, landing) });
  return { db, clock, reef, github, landing, root, answer, door };
}

it("purely-local の名前で local merge question に hold と答えた根も、削除が着地を終える", async () => {
  const c = await localReefWithQuestion();
  await c.answer("hold");

  await c.door();

  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe("workspace_deleted");
  await expectLandingDoesNothing(c, [c.root]);
});

it("確認なしの要求は何も終えず、着地が終わる task を id・題・PR の番号・PR の head が push していない内容を欠くかで名指す", async () => {
  const c = await reefWithPrRootAndChild();
  const second = await settleRepairNotMergedBack(c.db, c.clock, c.workspace, c.root.id, "second.txt");
  tearDownRepair(c.db, c.clock, c.workspace, second);
  c.github.preparePush = async () => {
    throw new Error("push rejected");
  };
  await c.landing.converge();
  await answerPromotion(c.db, c.clock, c.landing, c.workspace, promotionFailures(c.db, c.root.id)[0]!, "abandon promotion");

  await expect(c.door(false)).rejects.toMatchObject({
    name: "DeletionConfirmationRequiredError",
    landingEnds: [
      { id: c.root.id, title: "ship", pr_number: 1, pr_head_lacks_unpushed_content: true },
      { id: c.child.id, title: "repair", pr_number: null, pr_head_lacks_unpushed_content: false },
      { id: second.id, title: "repair", pr_number: null, pr_head_lacks_unpushed_content: false },
    ],
  });
  expect([c.root, c.child, second].map((task) => landingState(c.db, getTask(c.db, task.id)!))).not.toContain("workspace_deleted");
});

// 終える集合の端(PR の表): 収束の候補の述語と突き合わせる —— 着地が終わったと読まれる task は終えない
it("収束が着地を終えた根とその子は終える集合に入らず、削除の後も行が変わらない", async () => {
  const c = await reefWithPrRootAndChild();
  await mergeOnGitHub(c.workspace, c.root.id);
  c.github.scriptMergedOutside(1);
  await refreshProtectedBranch(c.db, c.workspace, undefined, () => c.clock.now());
  await c.landing.converge();
  const before = [c.root, c.child].map((task) => landingState(c.db, getTask(c.db, task.id)!));
  expect(before[0]).toBe("landed");

  await expect(c.door(false)).rejects.toMatchObject({ landingEnds: [] });
  await c.door();

  expect([c.root, c.child].map((task) => landingState(c.db, getTask(c.db, task.id)!))).toEqual(before);
});

it("盤面の外の merge を観測して収束がまだ着地を終えていない根も、その子も終える集合に入り、根の行は merge の観測のまま", async () => {
  const c = await reefWithPrRootAndChild("escalate");
  await mergeOnGitHub(c.workspace, c.root.id);
  c.github.scriptMergedOutside(1);
  await c.landing.tick("outside_merge");
  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe("merge_observed");

  await expect(c.door(false)).rejects.toMatchObject({ landingEnds: [{ id: c.root.id, pr_number: 1 }, { id: c.child.id }] });
  await c.door();

  expect([c.root, c.child].map((task) => landingState(c.db, getTask(c.db, task.id)!))).toEqual(["merge_observed", "workspace_deleted"]);
  await expectLandingDoesNothing(c, [c.root, c.child]);
});

it("盤面の外で閉じた PR の根は終える集合に入り、行は閉じた観測のまま", async () => {
  const c = await reefWithPrRootAndChild();
  const second = await settleRepairNotMergedBack(c.db, c.clock, c.workspace, c.root.id, "second.txt");
  tearDownRepair(c.db, c.clock, c.workspace, second);
  c.github.scriptClosedOutside(1);
  await c.landing.converge();
  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe("close_observed");

  // 閉じた PR を GitHub で開き直して merge すると、盤面が push しなかった修理を欠く
  await expect(c.door(false)).rejects.toMatchObject({ landingEnds: [{ id: c.root.id, pr_head_lacks_unpushed_content: true }, { id: c.child.id }, { id: second.id }] });
  await c.door();

  expect([c.root, c.child, second].map((task) => landingState(c.db, getTask(c.db, task.id)!))).toEqual(["close_observed", "workspace_deleted", "workspace_deleted"]);
  await expectLandingDoesNothing(c, [c.root, c.child, second]);
});

// 終える集合の端(purely-local の表): local 着地を執行した根、盤面のタスクブランチを持たない人間担当の work、Interview の受験者は終えない
it("purely-local の名前で、local 着地を執行した根・タスクブランチを持たない人間担当の work・Interview の受験者は終える集合に入らず、local hold の根だけが入る", async () => {
  const c = await localReefWithQuestion();
  await c.answer("merge");
  const held = await completeThroughTaskCheckout(c.db, c.clock, c.reef.resolve("reef"), landingWork(c.db, c.clock, "reef"), "held.txt", "held\n");
  await expect(convergeOn(c.landing, held.id)).resolves.toMatchObject({ form: "local_merge_question" });
  await c.answer("hold", held.id);
  const byHand = registerTask(c.db, { type: "work", title: "by hand", purpose: "p", completion_criteria: "c", assignee: HUMAN_ACTOR_ID, workspace: "reef" }, c.clock.now(), ...HUMAN_WEBUI);
  completeTask(c.db, byHand, FULL_HANDOFF, HUMAN_ACTOR_ID, c.clock.now(), "webui");
  const interview = registerTask(
    c.db,
    { type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: "reef", interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }] },
    c.clock.now(),
    ...HUMAN_WEBUI,
  );
  const [examinee] = poseAccepted(c.db, interview, { title: "add a parser", probe: "write a parser", completion_criteria: "the parser works", rubric: "tests pass" }, "auditor", c.clock.now(), "worker", POSED_HEAD);
  completeTask(c.db, examinee!, FULL_HANDOFF, "worker", c.clock.now(), "worker");
  // 採点を待つ root は未決着で扉を止めるので、受験者の完了の後に root を cancel する
  cancelTaskDirectly(c.db, getTask(c.db, interview.id)!, null, c.clock.now(), {}, "webui");
  const others = [c.root, byHand, examinee!];
  const before = others.map((task) => landingState(c.db, getTask(c.db, task.id)!));

  await expect(c.door(false)).rejects.toMatchObject({ landingEnds: [{ id: held.id, pr_number: null }] });
  await c.door();

  expect(others.map((task) => landingState(c.db, getTask(c.db, task.id)!))).toEqual(before);
  expect(landingState(c.db, getTask(c.db, held.id)!)).toBe("workspace_deleted");
});

// registry の refresh の token の await(扉の入口の読みの後、ADR 0421 決定4 追記の読み直しの前)が、扉の唯一の await である
/** remote-backed の registry に登録した `reef` で PR #1 を開いた `external` の根。`door` は registry の refresh の token で止まる扉を始め、
 *  `window` が開くまで待つ。 */
async function reefAwaitingRegistry() {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("reef-window");
  const reef = await registeredReef(old, { remoteBacked: true });
  const github = new FakeGitHubClient();
  const workspace = reef.resolve("reef");
  const work = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, workspace, work, "feature.txt", "ready\n");
  const root = finish(db, clock, work);
  recordPrOpenedOutsideConvergence(db, root, 1, clock.now(), { authority: { merge: "external" }, workspace });
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github });
  const { window, githubAuth } = fetchHeldAtToken();
  const door = () => deleteWorkspace({ name: "reef", confirm: true }, { ...reef.admin, db, githubAuth, ...deletionReaders(db, reef.resolve, landing) });
  /** 扉を registry の refresh の await まで進め、`during` を撃ってから await を開く。 */
  const deleteAround = async (during: () => void) => {
    const deleting = door();
    await window.entered;
    during();
    window.open();
    return deleting;
  };
  const registered = () => loadRegistry(reef.registryDir, "remote-backed").workspaces.reef !== undefined;
  return { db, clock, reef, workspace, landing, root, door, deleteAround, registered };
}

it("registry の refresh を待つ間に完了した task も、その間に立った着地の question とキューの行ごと、扉が着地を終える", async () => {
  const c = await reefAwaitingRegistry();
  let queued!: Task;
  let question!: string;

  await c.deleteAround(() => {
    registerPrPromotionFailureQuestion(c.db, c.root, "push rejected", c.clock.now());
    question = promotionFailures(c.db, c.root.id)[0]!.id;
    queued = finish(c.db, c.clock, landingWork(c.db, c.clock, "reef"));
    recordPrOpenedOutsideConvergence(c.db, queued, 2, c.clock.now(), { authority: { merge: "auto_if_ci_green" }, workspace: c.workspace });
    expect(landingState(c.db, getTask(c.db, queued.id)!)).toBe("auto_merge_queue");
  });

  expect(c.registered()).toBe(false);
  expect([c.root, queued].map((task) => landingState(c.db, getTask(c.db, task.id)!))).toEqual(["workspace_deleted", "workspace_deleted"]);
  expect(getTask(c.db, question)!.status).toBe("done");
  expect(settledByObservation(c.db, getTask(c.db, question)!)).toBe("workspace_deleted_observed");
});

it("registry の refresh を待つ間に着地の執行が始まれば、扉は何も書かずに投げ、執行が終われば削除し直して通る", async () => {
  const c = await reefAwaitingRegistry();
  let release!: () => void;

  await expect(c.deleteAround(() => (release = c.landing.takeInFlightMark(c.root.id)!))).rejects.toMatchObject({
    reasons: [{ code: "landing_in_progress", task_ids: [c.root.id] }],
  });
  expect(c.registered()).toBe(true);
  expect(holdsBaseline(c.db, "reef")).toBe(true);
  expect(landingState(c.db, getTask(c.db, c.root.id)!)).not.toBe("workspace_deleted");
  release();

  await c.door();

  expect(c.registered()).toBe(false);
  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe("workspace_deleted");
});

// 終える集合が収束の候補と違う唯一の端: local 着地の question が開いた根は、入口では未決着で拒まれ、窓の中で立てば終える側が閉じる
it("purely-local の名前で registry の refresh を待つ間に完了して local merge question が立った根も、扉がその question ごと着地を終える", async () => {
  const { db, clock } = await openBoard();
  const reef = await registeredReef(await makeWorkspace("reef-local-window"), { remoteBacked: true });
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github: null });
  const { window, githubAuth } = fetchHeldAtToken();
  const deleting = deleteWorkspace({ name: "reef", confirm: true }, { ...reef.admin, db, githubAuth, ...deletionReaders(db, reef.resolve, landing) });
  await window.entered;
  const root = await completeThroughTaskCheckout(db, clock, reef.resolve("reef"), landingWork(db, clock, "reef"), "feature.txt", "ready\n");
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ form: "local_merge_question" });
  const [question] = openLocalMergeQuestions(db, root.id);
  window.open();

  await deleting;

  expect(landingState(db, getTask(db, root.id)!)).toBe("workspace_deleted");
  expect(getTask(db, question!.id)!.status).toBe("done");
  expect(settledByObservation(db, getTask(db, question!.id)!)).toBe("workspace_deleted_observed");
});

/** scheduler の poll(収束を撃つ)と2つの tick を1回ずつ回し、開いた question と `reef` の workspace の Quarantine が無いこと。 */
async function expectPollRaisesNothing(c: Awaited<ReturnType<typeof reefWithPrRootAndChild>>) {
  const containers = fakeContainers();
  const slot = new Slot();
  const teardown = { db: c.db, clock: c.clock, slot, resolve: c.reef.resolve, pollNow: () => scheduler.pollNow() };
  const scheduler = startScheduler({
    db: c.db, clock: c.clock, slot, worker: new ScriptedWorker(c.clock), containers, workspace: c.workspace, github: c.github,
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => {
      await c.landing.converge();
      return [];
    },
    onSpawnFailed: spawnFailureHandler(teardown, containers),
    onRecordContainerFailed: () => {},
    onPickupStopped: queueReturnHandler(teardown, containers, { defaultWorkspaceName: "reef" }),
    resolveWorkspace: c.reef.resolve,
    workspacesDir: c.reef.admin.workspacesBaseDir,
    taskExecutionCandidates: implicitTaskExecutionCandidates(c.db),
  });
  onTestFinished(() => scheduler.stop());
  // 素の git エラー(`git rev-list --count …`)をログにも出さない —— poll も収束も何も失敗しない
  const errors = vi.spyOn(console, "error");
  await scheduler.rerunPoll();
  await expectLandingDoesNothing(c, [c.root, c.child]);
  expect(openQuarantineQuestion(c.db, "workspace", "reef")).toBeUndefined();
  expect([c.root, c.child].map((task) => landingState(c.db, getTask(c.db, task.id)!))).toEqual(["workspace_deleted", "workspace_deleted"]);
  expect(errors).not.toHaveBeenCalled();
}

it("削除の後・登録し直す前の poll は、着地が終わった task に question も Quarantine も立てない", async () => {
  const c = await reefWithPrRootAndChild();

  await c.door();

  await expectPollRaisesNothing(c);
});

// 登録し直しの通し(ADR 0421 決定1): 前の登録の根とその子は、次の登録の下で question も Quarantine も立てない
it.each([
  ["同じ repo の fresh clone", "same"],
  ["別の repo の同じ checkout", "other-same-path"],
  ["別の repo の fresh clone", "other-new-path"],
] as const)("%s で登録し直した名前で、前の登録の根とその子は question も Quarantine も立てない", async (_shape, shape) => {
  const c = await reefWithPrRootAndChild();
  const old = c.workspace;
  const other = shape === "same" ? undefined : (await makeRemoteBackedWorkspace("reef-other")).workspace;
  const path = shape === "other-same-path" ? old.path : await tempDir("tidepool-reef-fresh-");
  if (path !== old.path) git(path, "clone", "--quiet", (other ?? old).repo!, ".");
  if (shape === "same") git(path, "remote", "add", "head-repo", old.head_repo!);

  await reRegister(c.db, c.reef, { ...old, path, repo: (other ?? old).repo, head_repo: shape === "same" ? old.head_repo : undefined }, () => {
    if (shape === "other-same-path") {
      git(old.path, "remote", "set-url", "origin", other!.repo!);
      git(old.path, "remote", "remove", "head-repo");
    } else rmSync(old.path, { recursive: true, force: true });
  });

  await expectPollRaisesNothing({ ...c, workspace: c.reef.resolve("reef") });
});

it("別の repo で誤って登録し直した名前は、もう一度削除して元の repo で登録し直せる(#3888)", async () => {
  const c = await reefWithPrRootAndChild();
  const old = c.workspace;
  const { workspace: other } = await makeRemoteBackedWorkspace("reef-other");
  await reRegister(c.db, c.reef, { ...old, repo: other.repo, head_repo: undefined }, () => {
    git(old.path, "remote", "set-url", "origin", other.repo!);
    git(old.path, "remote", "remove", "head-repo");
  });
  await c.landing.converge();

  await reRegister(c.db, c.reef, old, () => {
    git(old.path, "remote", "set-url", "origin", old.repo!);
    git(old.path, "remote", "add", "head-repo", old.head_repo!);
  });

  await expectPollRaisesNothing({ ...c, workspace: c.reef.resolve("reef") });
});
