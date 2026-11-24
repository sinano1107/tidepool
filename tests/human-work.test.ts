import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { quarantineContainment } from "../src/containment.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, latestEventOfTask, listEvents, listEventsOfKinds } from "../src/events.js";
import { applyExecutionSettingsChange } from "../src/execution-setting.js";
import { quarantineFailedTeardown, quarantineUnclosedSession } from "../src/failed-teardown.js";
import type { GitHubAuth } from "../src/github-auth.js";
import { completeThroughHumanDoor, decomposeThroughHumanDoor, startWorkThroughHumanDoor, submitAnswer, takeInWorkThroughHumanDoor } from "../src/human-verbs.js";
import { createLanding, landingBlock } from "../src/landing.js";
import { REVIEWER_AUTHORITY_PROFILE, UnknownAgentError } from "../src/registry.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { type CompletionReviewRequest, cancelTaskDirectly, completeTask, decomposeTask, editTask, getTask, listBoard, listChildren, pickupTask, type RegisterTaskInput, registerTask, type Task } from "../src/tasks.js";
import { markTeardown, runTeardown, teardownStep } from "../src/teardown.js";
import { workbenchCommands, workbenchPath } from "../src/workbench.js";
import {
  boardRefWriter,
  completeHumanWork,
  holdsBaseline,
  humanWorkbenchDisplay,
  prepareHumanWork,
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
  recordTaskCheckoutTip,
  takeWorkspaceInFlightKey,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, decomposeTaskViaWorker, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, lockDirInside, makeRemoteBackedWorkspace, makeShallowWorkspace, makeWorkspace, newTreePointsAtDamagedNamedBlob, notRemoved, prepareAtPickup, quarantineQuestion, seedZeroPaddedTree, sessionId, WORKER_SPAWNED, withPushDuringWrap } from "./harness.js";
import { tempDir } from "./temp-dir.js";
import { answer } from "./workbench-fixture.js";

// ADR 0374 決定1〜11 / spec #3273 group C(#3293・#3294): 人間担当の work の書き始める(`start_work`)・完了を伴わない取り込み
// (`take_in_work`)・完了の扉と、分解の警告、作業台の表示(`humanWorkbenchDisplay`・`workbenchCommands`)。domain 層の釘(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

type Board = { db: Db; clock: FakeClock; ws: WorkspaceConfig; base: string };

async function board(name: string): Promise<Board> {
  return { db: openDb(":memory:"), clock: new FakeClock(), ws: await makeWorkspace(name), base: await tempDir("tidepool-task-checkouts-") };
}

function work(b: Board, title: string, extra: Partial<RegisterTaskInput> = {}): Task {
  const workspace = extra.parent_id ? undefined : b.ws.name;
  return registerTask(b.db, { type: "work", title, purpose: "why", completion_criteria: "done", workspace, ...extra }, b.clock.now(), ...HUMAN_WEBUI);
}

const deps = ({ db, ws, base }: Board) => ({ db, pollNow: () => {}, workspace: ws, workspacesDir: base, agentRegistered: (name: string) => ["deckhand", "auditor"].includes(name) });

async function startWork(b: Board, task: Task) {
  return startWorkThroughHumanDoor(deps(b), task.id, () => b.clock.now(), "webui");
}

async function complete(b: Board, task: Task, handoff: Partial<typeof FULL_HANDOFF> | undefined = FULL_HANDOFF, review?: CompletionReviewRequest) {
  return completeThroughHumanDoor(deps(b), task.id, { handoff, ...review }, () => b.clock.now(), "webui");
}

async function takeIn(b: Board, task: Task) {
  return takeInWorkThroughHumanDoor(deps(b), task.id, () => b.clock.now(), "webui");
}

/** ADR 0390 決定3 / spec #3365: 帰り先の持ち主 `owner` が解放を負う間の拒否(`verb` は答え直す行為)。 */
const ownerOwesRelease = (owner: Task, verb: string) =>
  `task ${owner.id} "${owner.title}", whose branch this task returns to, is still running or being torn down — ${verb} again once it has finished.`;

const refused = (error: string) => ({ ok: false, failure: { kind: "domain_error", error } });

/** 名前の場所の全 ref(HEAD を含む)と作業ツリーの状態 —— 盤面が名前の場所に書いていないことの観測。 */
const namedPlace = (ws: WorkspaceConfig) => [git(ws.path, "symbolic-ref", "HEAD"), git(ws.path, "for-each-ref"), git(ws.path, "status", "--porcelain")];

const kinds = (db: Db, taskId: string) => listEvents(db, taskId).map((e) => e.kind);

const humanWorkbench = (b: Board, task: Task) => workbenchPath(b.base, { task: task.id });

/** agent の task を拾い、task の checkout を開く(pickup の準備 —— 未着手の祖先を固定する)。 */
async function picked(b: Board, task: Task) {
  const { db, clock, ws, base } = b;
  const pickedUp = pickupTask(db, getTask(db, task.id)!, "deckhand", clock.now())!;
  const place = await prepareAtPickup(db, ws, pickedUp, { now: clock.now(), workspacesBaseDir: base, defaultWorkspaceName: ws.name });
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  return { task: pickedUp, place };
}

const pickedAgentChild = (b: Board, parent: Task) => picked(b, work(b, "child", { parent_id: parent.id }));

/** 後始末の印が立った task の後始末(解放と merge back)を、slot を握った形で通す。 */
async function runMarkedTeardown(b: Board, taskId: string): Promise<void> {
  const slot = new Slot();
  slot.occupy(taskId, sessionId(b.db, taskId));
  slot.enterTeardown();
  await runTeardown({ db: b.db, clock: b.clock, slot, resolve: () => b.ws, pollNow: () => {} }, taskId, teardownStep(b.db, taskId));
}

/** 拾った子の task の checkout で `file` を書いて完了させ、後始末(merge back)まで通す。 */
async function finishAgentChild(b: Board, { task, place }: Awaited<ReturnType<typeof pickedAgentChild>>, file: string, body: string): Promise<Task> {
  const { db, clock } = b;
  commitWork(place.path, file, body);
  recordTaskCheckoutTip(db, place, task.id);
  completeTask(db, task, FULL_HANDOFF, "worker", clock.now(), "worker");
  markTeardown(db, task.id, clock.now());
  await runMarkedTeardown(b, task.id);
  return getTask(db, task.id)!;
}

const completedAgentChild = async (b: Board, parent: Task, file: string, body: string) => finishAgentChild(b, await pickedAgentChild(b, parent), file, body);

async function expectReviewPickedUp(b: Board, reviewId: string) {
  const worker = new ScriptedWorker(b.clock);
  const scheduler = startScheduler({
    db: b.db, clock: b.clock, slot: new Slot(), worker, containers: fakeContainers(),
    workspace: b.ws, workspacesDir: b.base,
    retrospectiveCalls: noRetrospectiveCalls, converge: async () => [],
    onSpawnFailed: () => {}, onRecordContainerFailed: () => {}, onPickupStopped: () => {},
    taskExecutionCandidates: implicitTaskExecutionCandidates(b.db),
  });
  try {
    scheduler.pollNow();
    await vi.waitFor(() => expect(worker.started.map((task) => task.id)).toEqual([reviewId]));
  } finally {
    scheduler.stop();
  }
}

it("a human root's handoff can be picked up for review without a parent pickup or worker spawn", async () => {
  const b = await board("human-review-pickup");
  const root = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  expect((await startWork(b, root)).ok).toBe(true);
  expect((await complete(b, root)).ok).toBe(true);
  expect(kinds(b.db, root.id)).toEqual(["task_registered", "task_branch_created", "task_work_started", "task_completed"]);
  const [review] = listChildren(b.db, root.id);
  expect(review).toMatchObject({ type: "review", status: "todo" });
  await expectReviewPickedUp(b, review!.id);
});

it("invalid reviewer designations leave a human workbench's commits and completion untouched", async () => {
  const b = await board("human-review-refusal");
  applyExecutionSettingsChange(b.db, { setting: "insert_tier", name: "retired", description: "an obsolete tier", position: 0 }, "webui", b.clock.now());
  applyExecutionSettingsChange(b.db, { setting: "delete_tier", name: "retired" }, "webui", b.clock.now());
  const root = work(b, "pending intake", { assignee: HUMAN_ACTOR_ID });
  const started = await startWork(b, root);
  if (!started.ok) throw new Error(started.failure.error);
  commitWork(started.value.path, "new.txt", "work to take in\n");
  const branchBefore = namedPlace(b.ws);
  const workbenchBefore = namedPlace({ ...b.ws, path: started.value.path });
  const taskBefore = getTask(b.db, root.id);
  const eventsBefore = listEvents(b.db, root.id);

  for (const [input, error] of [
    [{ review_by: ["human"] }, /^unknown agent: human$/],
    [{ review_by: ["unknown"] }, /^unknown agent: unknown$/],
    [{ review_by: ["deckhand", " deckhand "] }, /names the same reviewer twice/],
    [{ review_tier: "retired" }, /unknown review_tier "retired"/],
  ] satisfies [CompletionReviewRequest, RegExp][]) {
    expect(await complete(b, root, FULL_HANDOFF, input)).toMatchObject({
      ok: false, failure: { error: expect.stringMatching(error) },
    });
    expect(getTask(b.db, root.id)).toEqual(taskBefore);
    expect(listEvents(b.db, root.id)).toEqual(eventsBefore);
    expect(listChildren(b.db, root.id)).toEqual([]);
    expect(takenIn(b.db)).toEqual([]);
    expect(namedPlace(b.ws)).toEqual(branchBefore);
    expect(namedPlace({ ...b.ws, path: started.value.path })).toEqual(workbenchBefore);
  }
});

it("an invalid reviewer is refused before dirty named-place preparation can raise Quarantine", async () => {
  const b = await board("human-review-dirty-named-place");
  const root = work(b, "pending review", { assignee: HUMAN_ACTOR_ID });
  expect((await startWork(b, root)).ok).toBe(true);
  writeFileSync(join(b.ws.path, "dirty.txt"), "outside the board\n");
  const before = untouched(b, root);

  expect(await complete(b, root, FULL_HANDOFF, { review_by: ["unknown"] })).toEqual(refused("unknown agent: unknown"));
  expect(quarantineQuestion(b.db, "workspace", b.ws.name)).toBeUndefined();
  expect(untouched(b, root)).toEqual(before);

  const valid = await complete(b, root, FULL_HANDOFF, { review_by: ["auditor"] });
  const question = quarantineQuestion(b.db, "workspace", b.ws.name);
  expect(question).toBeDefined();
  expect(valid).toEqual(refused(`cannot complete: workspace ${b.ws.name} is quarantined — answer question ${question!.id} first.`));
});

it("branchless human work refuses a completion review designation and completes without raising a review", async () => {
  const b = await board("human-review-no-branch");
  const root = work(b, "no task branch", { assignee: HUMAN_ACTOR_ID });
  const before = getTask(b.db, root.id);
  const inputs = [{ review_by: ["auditor"] }, { review_tier: "standard" }, { review_flag: true }];
  for (const review of inputs) {
    expect(await completeThroughHumanDoor(deps(b), root.id, review, () => b.clock.now(), "webui")).toEqual(refused(
      "this task has no task branch, so its completion raises no review — complete it without `review_by`, `review_tier` or `review_flag`.",
    ));
  }
  expect(getTask(b.db, root.id)).toEqual(before);
  expect(kinds(b.db, root.id)).toEqual(["task_registered"]);

  expect((await completeThroughHumanDoor(deps(b), root.id, {}, () => b.clock.now(), "webui")).ok).toBe(true);
  expect(listChildren(b.db, root.id)).toEqual([]);
});

it("the human completion door uses individual review choices and risk without storing the designation", async () => {
  const b = await board("human-review-child");
  const root = work(b, "plan", { assignee: HUMAN_ACTOR_ID, risk_flag: true });
  const individual = work(b, "review it separately", { assignee: HUMAN_ACTOR_ID, parent_id: root.id });
  const risky = work(b, "risky work", { assignee: HUMAN_ACTOR_ID, parent_id: root.id, risk_flag: true });
  for (const task of [individual, risky]) expect((await startWork(b, task)).ok).toBe(true);

  expect(await complete(b, individual, FULL_HANDOFF, { review_by: ["deckhand"] })).toMatchObject({
    ok: false, failure: { error: expect.stringContaining("set review_flag") },
  });
  expect((await complete(b, individual, FULL_HANDOFF, { review_flag: true, review_by: [" deckhand ", "auditor"], review_tier: "standard" })).ok).toBe(true);
  expect((await complete(b, risky, FULL_HANDOFF, { review_by: ["auditor"], review_tier: "standard" })).ok).toBe(true);

  expect(listChildren(b.db, individual.id)).toMatchObject([
    { type: "review", assignee: "deckhand", review_tier: "standard" },
    { type: "review", assignee: "auditor", review_tier: "standard" },
  ]);
  expect(listChildren(b.db, risky.id)).toMatchObject([{ type: "review", assignee: "auditor", review_tier: "standard" }]);
  for (const task of [individual, risky]) {
    expect(getTask(b.db, task.id)).toMatchObject({ status: "done", review_flag: 0, review_by: null, review_tier: null });
  }
});

it("a human completion review's repair children default to human and only an explicit agent needs approval", async () => {
  const b = await board("human-review-repairs");
  const root = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  expect((await startWork(b, root)).ok).toBe(true);
  expect((await complete(b, root)).ok).toBe(true);
  const [review] = listChildren(b.db, root.id);
  const finding = { purpose: "fix a review finding", completion_criteria: "finding fixed" };
  expect(landingBlock(b.db, root.id)).toBeNull();
  appendEvent(b.db, { taskId: review!.id, actorId: "auditor", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });

  const direct = decomposeTask(b.db, review!, {
    reason: "three fixes",
    children: [
      { ...finding, title: "omitted assignee" },
      { ...finding, title: "explicit human", assignee: "human" },
      { ...finding, title: "explicit agent", assignee: "deckhand" },
    ],
  }, "auditor", b.clock.now(), REVIEWER_AUTHORITY_PROFILE, undefined, "worker");

  expect(direct.map(({ title, assignee }) => ({ title, assignee }))).toEqual([
    { title: "omitted assignee", assignee: "human" },
    { title: "explicit human", assignee: "human" },
  ]);
  expect(listChildren(b.db, review!.id).filter((child) => child.type === "question")).toMatchObject([
    { question_pending_child: { title: "explicit agent", assignee: "deckhand" } },
  ]);
  expect(landingBlock(b.db, root.id)).toEqual({ kind: "attached_children", count: 1 });
});

/** 扉を準備の fetch(token の取得)で待たせ、その await の間に `during` を走らせてから続けさせる —— 最後の await の後の読みの観測。 */
async function duringPreparation<T>(door: (githubAuth: GitHubAuth) => Promise<T>, during: () => void | Promise<void>): Promise<T> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const reached = new Promise<void>((resolve) => (held = resolve));
  const result = door({ ensureToken: () => (held(), hold), env: () => process.env } as unknown as GitHubAuth);
  await reached;
  await during();
  release();
  return result;
}

it("start_work は pickup の準備を通して task/<H> を保護ブランチから作り、作業台を開いて task_work_started を残す —— 名前の場所の作業ツリーも HEAD も動かさず、status は todo のまま(pin C2)", async () => {
  const b = await board("start-work");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const before = namedPlace(b.ws);

  const started = await startWork(b, h);

  const path = realpathSync(humanWorkbench(b, h));
  expect(started).toEqual({ ok: true, value: { path } });
  expect(git(b.ws.path, "rev-parse", `task/${h.id}`)).toBe(git(b.ws.path, "rev-parse", "main"));
  expect([git(path, "symbolic-ref", "HEAD"), git(path, "rev-parse", "HEAD")]).toEqual([`refs/heads/task/${h.id}`, git(b.ws.path, "rev-parse", "main")]);
  expect(git(path, "rev-parse", `board/task/${h.id}`)).toBe(git(b.ws.path, "rev-parse", "main"));
  expect(kinds(b.db, h.id)).toEqual(["task_registered", "task_branch_created", "task_work_started"]);
  expect(getTask(b.db, h.id)!.status).toBe("todo");
  const [head, refs, status] = namedPlace(b.ws);
  expect([head, status]).toEqual([before[0], before[2]]);
  expect(refs).toBe(`${before[1]}\n${git(b.ws.path, "for-each-ref", `refs/heads/task/${h.id}`)}`);
});

it("2回目の start_work は同じ在り処を返して board/* を引き直し、disk から消えた作業台は task/<H> から開き直す —— event は増えない(pin C2)", async () => {
  const b = await board("start-work-again");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const first = await startWork(b, h);
  const path = realpathSync(humanWorkbench(b, h));
  commitWork(path, "draft.txt", "kept while open\n");

  const sibling = work(b, "write another", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, sibling);
  expect(() => git(path, "rev-parse", "--verify", `board/task/${sibling.id}`)).toThrow();

  expect(await startWork(b, h)).toEqual(first);
  expect(git(path, "show", "HEAD:draft.txt")).toBe("kept while open");
  expect(git(path, "rev-parse", `board/task/${sibling.id}`)).toBe(git(b.ws.path, "rev-parse", `task/${sibling.id}`));

  rmSync(path, { recursive: true, force: true });
  expect(await startWork(b, h)).toEqual(first);
  expect(git(path, "rev-parse", "HEAD")).toBe(git(b.ws.path, "rev-parse", `task/${h.id}`));
  expect(kinds(b.db, h.id)).toEqual(["task_registered", "task_branch_created", "task_work_started"]);
});

it("remote-backed では start_work の準備が origin の保護ブランチを fetch し、task/<H> は origin の今の値から切られる(ADR 0374 決定2)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("start-work-remote");
  const b = { ...(await board("start-work-remote-board")), ws: workspace };
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  publish("upstream.txt", "merged on origin\n", "upstream");

  expect((await startWork(b, h)).ok).toBe(true);

  expect(git(workspace.path, "show", `task/${h.id}:upstream.txt`)).toBe("merged on origin");
});

it("registry の無い盤面では、task の列がどの名前でも唯一の workspace で書き始める —— 導く名前が準備の間に変わったときだけ拒む", async () => {
  const b = await board("start-work-no-registry");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID, workspace: "a-name-this-board-does-not-know" });

  expect((await startWork(b, h)).ok).toBe(true);
  expect(git(b.ws.path, "rev-parse", `task/${h.id}`)).toBe(git(b.ws.path, "rev-parse", "main"));
});

it("start_work は人間担当の work だけを受け、ほかは何も書かずに拒む", async () => {
  const b = await board("start-work-gate");
  const agent = work(b, "an agent's task", { assignee: "deckhand" });

  expect(await startWork(b, agent)).toEqual(refused("only a work task assigned to the human can start work here"));
  expect(kinds(b.db, agent.id)).toEqual(["task_registered"]);
});

it("導ける workspace が無ければ start_work は text C1b で拒み、何も書かない(pin C2)", async () => {
  const b = await board("start-work-nowhere");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });

  const result = await startWorkThroughHumanDoor({ db: b.db, pollNow: () => {} }, h.id, () => b.clock.now(), "webui");

  expect(result).toEqual(refused("cannot start work: no workspace can be derived for this task — set its workspace with Edit first."));
  expect(kinds(b.db, h.id)).toEqual(["task_registered"]);
});

// ADR 0384 決定1: 子は workspace の欄を持たないので、text C1b は子には根の workspace を Edit するよう案内する
it("導ける workspace が無い子の start_work は、根の workspace を Edit するよう案内する text C1b で拒み、何も書かない", async () => {
  const b = await board("start-work-nowhere-child");
  const root = work(b, "the whole change", { assignee: HUMAN_ACTOR_ID });
  const child = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID, parent_id: root.id });

  const result = await startWorkThroughHumanDoor({ db: b.db, pollNow: () => {} }, child.id, () => b.clock.now(), "webui");

  expect(result).toEqual(refused("cannot start work: no workspace can be derived for this task — set its root task's workspace with Edit first."));
  expect(kinds(b.db, child.id)).toEqual(["task_registered"]);
});

it("その workspace の Quarantine が開いている間、start_work・take_in_work・完了は text C1a で拒まれ task に何も書かない —— 回答の後は通る(#3155 の追加要件)", async () => {
  const b = await board("start-work-quarantined");
  await leaveBaseline(b.db, b.ws);
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, h);
  const other = work(b, "not started yet", { assignee: HUMAN_ACTOR_ID });
  quarantineWorkspace(b.db, b.ws.name, new Error("a hand edit"), b.clock.now());
  const question = quarantineQuestion(b.db, "workspace", b.ws.name)!.id;
  const main = git(b.ws.path, "rev-parse", "main");

  expect(await startWork(b, other)).toEqual(refused(`cannot start work: workspace ${b.ws.name} is quarantined — answer question ${question} first.`));
  expect(await complete(b, h)).toEqual(refused(`cannot complete: workspace ${b.ws.name} is quarantined — answer question ${question} first.`));
  expect(await takeIn(b, h)).toEqual(refused(`cannot take in: workspace ${b.ws.name} is quarantined — answer question ${question} first.`));
  expect(kinds(b.db, other.id)).toEqual(["task_registered"]);
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${other.id}`)).toBe("");
  expect([getTask(b.db, h.id)!.status, git(b.ws.path, "rev-parse", `task/${h.id}`)]).toEqual(["todo", main]);

  await answer(b);

  expect((await startWork(b, other)).ok).toBe(true);
  expect((await complete(b, h)).ok).toBe(true);
});

it("準備が落ちれば start_work は pickup と同じ workspace の Quarantine を立てて text C1a で拒み、task に何も書かない —— 準備がした最初の撮りは残る(pin C2)", async () => {
  const b = await board("start-work-resting");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  writeFileSync(join(b.ws.path, "resting.txt"), "written while resting\n");

  const result = await startWork(b, h);

  const question = quarantineQuestion(b.db, "workspace", b.ws.name);
  expect(question?.purpose).toMatch(/uncommitted changes while resting/);
  expect(result).toEqual(refused(`cannot start work: workspace ${b.ws.name} is quarantined — answer question ${question!.id} first.`));
  expect(kinds(b.db, h.id)).toEqual(["task_registered"]);
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${h.id}`)).toBe("");
  expect(existsSync(humanWorkbench(b, h))).toBe(false);
  expect(holdsBaseline(b.db, b.ws.name)).toBe(true);
});

it("基準の行の無い workspace の最初の撮りは、基準の行を持つ別の workspace の Quarantine が開いている間、理由を問わず待つ —— start_work は止めた Quarantine を名指して拒む(ADR 0373 決定13 追記)", async () => {
  const b = await board("start-work-first-capture");
  const held = await makeWorkspace("start-work-held");
  await leaveBaseline(b.db, held);
  quarantineWorkspace(b.db, held.name, new Error("a hand edit"), b.clock.now());
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });

  const result = await startWork(b, h);

  expect(result).toEqual(refused(`cannot start work: workspace ${held.name} is quarantined — answer question ${quarantineQuestion(b.db, "workspace", held.name)!.id} first.`));
  expect(holdsBaseline(b.db, b.ws.name)).toBe(false);
  expect(kinds(b.db, h.id)).toEqual(["task_registered"]);
});

it("start_work・take_in_work・完了は workspace の in-flight の鍵を取り、別の回答か操作が検査中なら text B5 で拒まれる(pin B12)", async () => {
  const b = await board("start-work-in-flight");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, h);
  const other = work(b, "not started yet", { assignee: HUMAN_ACTOR_ID });
  const release = takeWorkspaceInFlightKey(b.db, b.ws.name)!;
  const busy = refused(`another answer or operation for workspace ${b.ws.name} is being checked — try again once it has finished.`);

  expect(await startWork(b, other)).toEqual(busy);
  expect(await complete(b, h)).toEqual(busy);
  expect(await takeIn(b, h)).toEqual(busy);
  expect(kinds(b.db, other.id)).toEqual(["task_registered"]);
  expect(getTask(b.db, h.id)!.status).toBe("todo");
  release();
});

const branchEvents = (db: Db, taskId: string) => listEvents(db, taskId).filter((e) => e.kind === "task_branch_created").map((e) => e.payload);

it("start_work は同じ固定の瞬間に、タスクブランチを持たない未着手の work の祖先を上から固定し、task/<H> をその系譜から切って自分の空の列を書く(pin C1)", async () => {
  const b = await board("start-work-fixes");
  const parent = work(b, "plan");
  const h = work(b, "write it myself", { parent_id: parent.id, assignee: HUMAN_ACTOR_ID });
  const main = git(b.ws.path, "rev-parse", "main");

  expect((await startWork(b, h)).ok).toBe(true);

  expect(branchEvents(b.db, parent.id)).toEqual([{ kind: "task_branch_created", sha: main, workspace: b.ws.name }]);
  expect(branchEvents(b.db, h.id)).toEqual([{ kind: "task_branch_created", sha: main, workspace: b.ws.name, column_filled_from: parent.id }]);
  expect([getTask(b.db, h.id)!.workspace, git(b.ws.path, "rev-parse", `task/${parent.id}`)]).toEqual([b.ws.name, main]);
});

it("祖先のブランチを作れなければ start_work は pickup と同じく Quarantine を立てて拒み、その祖先の列・ref・event も task/<H> も残らない(pin C1)", async () => {
  const b = await board("start-work-fix-fails");
  const parent = registerTask(b.db, { type: "work", title: "plan", purpose: "why", completion_criteria: "done" }, b.clock.now(), ...HUMAN_WEBUI);
  const h = work(b, "write it myself", { parent_id: parent.id, assignee: HUMAN_ACTOR_ID });
  // 最初の撮りより前に置く —— 基準に入るので、門でなく task/<parent> の作成(D/F の衝突)で落ちる
  git(b.ws.path, "branch", `task/${parent.id}/blocker`);

  const result = await startWork(b, h);

  expect(result).toEqual(refused(`cannot start work: workspace ${b.ws.name} is quarantined — answer question ${quarantineQuestion(b.db, "workspace", b.ws.name)!.id} first.`));
  expect([getTask(b.db, parent.id)!.workspace, getTask(b.db, h.id)!.workspace]).toEqual([null, null]);
  expect([branchEvents(b.db, parent.id), kinds(b.db, h.id)]).toEqual([[], ["task_registered"]]);
  expect(git(b.ws.path, "for-each-ref", "--format=%(refname)", `refs/heads/task/${parent.id}`, `refs/heads/task/${h.id}`)).toBe(`refs/heads/task/${parent.id}/blocker`);
});

it("人間担当の親の下の agent の子は、子の pickup が固定した task/<H> から切られてそこへ帰り、2つの兄弟は task/<H> で互いの成果を見る(pin C5、#3418 のレビューの形 1b)", async () => {
  const b = await board("human-parent");
  const h = work(b, "integrate it myself", { assignee: HUMAN_ACTOR_ID });

  await completedAgentChild(b, h, "first.txt", "first\n");

  expect(branchEvents(b.db, h.id)).toEqual([{ kind: "task_branch_created", sha: git(b.ws.path, "rev-parse", "main"), workspace: b.ws.name }]);
  expect(git(b.ws.path, "show", `task/${h.id}:first.txt`)).toBe("first");
  const second = pickupTask(b.db, work(b, "second", { parent_id: h.id }), "deckhand", b.clock.now())!;
  const place = await prepareAtPickup(b.db, b.ws, second, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });
  expect(git(place.path, "show", "HEAD:first.txt")).toBe("first");
});

it("agent の親の下の人間担当の子の書き始めるは、親が解放を負う間(session 中・後始末の印)は拒まれ何も書かない —— 解放の後は親の commit を含む task/<親> の今の値から切られる(pin C20、ADR 0390 決定1・2)", async () => {
  const b = await board("agent-parent");
  const parent = work(b, "plan");
  const { task, place } = await picked(b, parent);
  commitWork(place.path, "plan.txt", "plan\n");
  const h = work(b, "write it myself", { parent_id: parent.id, assignee: HUMAN_ACTOR_ID });
  const before = [namedPlace(b.ws), kinds(b.db, h.id)];

  expect(await startWork(b, h)).toEqual(refused(ownerOwesRelease(parent, "start work")));
  decomposeTaskViaWorker(b.db, task, { reason: "split", children: [{ title: "later", purpose: "p", completion_criteria: "c" }] }, "deckhand", b.clock.now());
  markTeardown(b.db, parent.id, b.clock.now());
  expect(await startWork(b, h)).toEqual(refused(ownerOwesRelease(parent, "start work")));
  expect([namedPlace(b.ws), kinds(b.db, h.id)]).toEqual(before);
  expect(existsSync(humanWorkbench(b, h))).toBe(false);

  await runMarkedTeardown(b, parent.id);
  expect((await startWork(b, h)).ok).toBe(true);

  expect(git(b.ws.path, "rev-parse", `task/${h.id}`)).toBe(git(b.ws.path, "rev-parse", `task/${parent.id}`));
  expect(git(b.ws.path, "show", `task/${h.id}:plan.txt`)).toBe("plan");
});

it("Edit: 子の pickup でタスクブランチだけできた未着手の親の assignee は替えられ、task_work_started の後は替えられない(pin C3・C9、ADR 0374 決定4)", async () => {
  const b = await board("edit-freeze");
  const h = work(b, "integrate it myself", { assignee: HUMAN_ACTOR_ID });
  await completedAgentChild(b, h, "first.txt", "first\n");
  const started = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, started);

  expect(editTask(b.db, getTask(b.db, h.id)!, { assignee: "deckhand" }, b.clock.now(), "webui").assignee).toBe("deckhand");
  expect(() => editTask(b.db, getTask(b.db, started.id)!, { assignee: "deckhand" }, b.clock.now(), "webui")).toThrow(/whose work has been started keeps its assignee/);
  expect(() => editTask(b.db, getTask(b.db, started.id)!, { workspace: "elsewhere" }, b.clock.now(), "webui")).toThrow(/has a task branch keeps its workspace/);
});

/** 書き始めた人間担当の work と、その作業台で人間が書いて commit したもの。 */
async function startedWithCommit(b: Board, h: Task, file = "mine.txt", body = "mine\n"): Promise<string> {
  await startWork(b, h);
  const path = realpathSync(humanWorkbench(b, h));
  commitWork(path, file, body);
  return path;
}

/** 拒まれた完了が task に何も書いていないことの観測: `task/<H>` の値、status、event の kind。 */
const untouched = (b: Board, h: Task) => [git(b.ws.path, "rev-parse", `task/${h.id}`), getTask(b.db, h.id)!.status, kinds(b.db, h.id)];

const takenIn = (db: Db) => listEventsOfKinds(db, ["workbench_taken_in"]).map((e) => e.payload);

it("タスクブランチを持つ H の完了は作業台の tip を包む commit で task/<H> に取り込み、done にし、作業台を消す —— handoff の6欄が要る(pin C7・C11)", async () => {
  const b = await board("complete-intake");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  const tip = git(path, "rev-parse", "HEAD");
  const main = git(b.ws.path, "rev-parse", "main");
  const before = untouched(b, h);

  expect(await complete(b, h, {})).toEqual(refused("a work task cannot complete without a full handoff doc; missing: outcome, deliverables, decision_refs, dead_ends, resume_context, known_issues"));
  expect(untouched(b, h)).toEqual(before);
  expect(existsSync(path)).toBe(true);

  const done = await complete(b, h);

  expect(done.ok && done.value.status).toBe("done");
  const wrapped = git(b.ws.path, "rev-parse", `task/${h.id}`);
  expect(git(b.ws.path, "rev-parse", `${wrapped}^1`, `${wrapped}^2`)).toBe(`${main}\n${tip}`);
  expect(takenIn(b.db)).toEqual([{ kind: "workbench_taken_in", workspace: b.ws.name, target: `refs/heads/task/${h.id}`, tip, commit: wrapped, entry: "complete_task" }]);
  expect(existsSync(path)).toBe(false);
});

it("tip が task/<H> と同じなら取り込まずに完了する —— 包む commit も workbench_taken_in も無い", async () => {
  const b = await board("complete-nothing-new");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, h);

  expect((await complete(b, h)).ok).toBe(true);

  expect(git(b.ws.path, "rev-parse", `task/${h.id}`)).toBe(git(b.ws.path, "rev-parse", "main"));
  expect(takenIn(b.db)).toEqual([]);
  expect(existsSync(humanWorkbench(b, h))).toBe(false);
});

it("子孫だけが走った H(タスクブランチあり・作業台なし)は取り込まずに完了し、兄弟の session が走っていても H の merge back を撃つ —— 兄弟の H2 も書き始められる(pin C7、#3418 のレビューの形 2、ADR 0390 決定2)", async () => {
  const b = await board("complete-children-only");
  const root = work(b, "plan");
  const h = work(b, "integrate it", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  const child = await completedAgentChild(b, h, "child.txt", "child\n");
  const sibling = pickupTask(b.db, work(b, "sibling", { parent_id: root.id }), "deckhand", b.clock.now())!;
  await prepareAtPickup(b.db, b.ws, sibling, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });

  expect(branchEvents(b.db, root.id).map((e) => (e as { sha: string }).sha)).toEqual([git(b.ws.path, "rev-parse", "main")]);
  expect(git(b.ws.path, "merge-base", `task/${h.id}`, `task/${root.id}`)).toBe(git(b.ws.path, "rev-parse", "main"));
  expect(git(b.ws.path, "rev-parse", `task/${child.id}^`)).toBe(git(b.ws.path, "rev-parse", "main"));

  // 帰り先の持ち主でない兄弟の session は見ない(ADR 0374 決定9)
  expect((await startWork(b, work(b, "write it too", { parent_id: root.id, assignee: HUMAN_ACTOR_ID }))).ok).toBe(true);
  expect((await complete(b, h)).ok).toBe(true);

  expect(getTask(b.db, h.id)!.status).toBe("done");
  expect(listChildren(b.db, h.id).filter((task) => task.type === "review")).toEqual([]);
  expect(takenIn(b.db)).toEqual([]);
  expect(git(b.ws.path, "show", `task/${root.id}:child.txt`)).toBe("child");
  expect(getTask(b.db, sibling.id)!.status).toBe("in_progress");
});

it("拒まれた完了は task に何も書かない: tip が task/<H> の今の値を欠く(text C2a)—— 人間が merge すれば通る(pin C6)", async () => {
  const b = await board("complete-moved-on");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  await completedAgentChild(b, h, "child.txt", "child\n");
  const before = untouched(b, h);

  const result = await complete(b, h);

  expect(result).toEqual(refused(
    `task/${h.id} has moved on since your tip (work of its children arrived). In the workbench at ${path}, on task/${h.id}, run \`git merge board/task/${h.id}\` ` +
      `(or, in your own clone with the workbench as a remote: fetch it, \`git merge <remote>/board/task/${h.id}\`, and push task/${h.id} to it), then complete again.`,
  ));
  expect(untouched(b, h)).toEqual(before);
  expect(git(path, "rev-parse", `board/task/${h.id}`)).toBe(before[0]);

  git(path, "merge", "--no-edit", `board/task/${h.id}`);
  expect((await complete(b, h)).ok).toBe(true);
  expect([git(b.ws.path, "show", `task/${h.id}:mine.txt`), git(b.ws.path, "show", `task/${h.id}:child.txt`)]).toEqual(["mine", "child"]);
});

it("拒まれた完了は task に何も書かない: 帰り先と conflict する(text C2b)—— 盤面が帰り先の値を作業台に引き、人間が解けば通る(pin C6)", async () => {
  const b = await board("complete-conflict");
  const root = work(b, "plan");
  const h = work(b, "write it myself", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h, "work.txt", "human\n");
  await completedAgentChild(b, root, "work.txt", "sibling\n");
  const before = untouched(b, h);

  const result = await complete(b, h);

  expect(result).toEqual(refused(
    `task/${h.id} does not merge cleanly into 'task/${root.id}'. In the workbench at ${path}, on task/${h.id}, run \`git merge board/task/${root.id}\` and resolve the conflict ` +
      `(or, in your own clone with the workbench as a remote: fetch it, \`git merge <remote>/board/task/${root.id}\`, and push task/${h.id} to it), then complete again.`,
  ));
  expect(untouched(b, h)).toEqual(before);
  expect(takenIn(b.db)).toEqual([]);
  expect(git(path, "rev-parse", `board/task/${root.id}`)).toBe(git(b.ws.path, "rev-parse", `task/${root.id}`));

  expect(() => git(path, "merge", `board/task/${root.id}`)).toThrow();
  writeFileSync(join(path, "work.txt"), "human\nsibling\n");
  git(path, "commit", "-am", "resolve");
  expect((await complete(b, h)).ok).toBe(true);
  expect(git(b.ws.path, "show", `task/${root.id}:work.txt`)).toBe("human\nsibling");
});

it("作業台の無い H の帰り先との conflict は、盤面がその拒否の中で作業台を開く —— task_work_started は残らず assignee は替えられる(pin C9)", async () => {
  const b = await board("complete-conflict-opens");
  const root = work(b, "plan");
  const h = work(b, "integrate it", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  await completedAgentChild(b, h, "work.txt", "child\n");
  await completedAgentChild(b, root, "work.txt", "sibling\n");

  const result = await complete(b, h);

  const path = realpathSync(humanWorkbench(b, h));
  expect(result).toEqual(refused(
    `task/${h.id} does not merge cleanly into 'task/${root.id}'. The board opened the workbench at ${path} for it., on task/${h.id}, run \`git merge board/task/${root.id}\` and resolve the conflict ` +
      `(or, in your own clone with the workbench as a remote: fetch it, \`git merge <remote>/board/task/${root.id}\`, and push task/${h.id} to it), then complete again.`,
  ));
  expect(kinds(b.db, h.id)).not.toContain("task_work_started");
  expect(editTask(b.db, getTask(b.db, h.id)!, { assignee: "deckhand" }, b.clock.now(), "webui").assignee).toBe("deckhand");
});

it("拒まれた完了は task に何も書かない: 子孫の後始末が済んでいない(text C2c)・未 commit の変更がある(text C2d)(pin C6)", async () => {
  const b = await board("complete-teardown");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  const child = pickupTask(b.db, work(b, "child", { parent_id: h.id }), "deckhand", b.clock.now())!;
  await prepareAtPickup(b.db, b.ws, child, { now: b.clock.now(), workspacesBaseDir: b.base });
  completeTask(b.db, child, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  markTeardown(b.db, child.id, b.clock.now());
  const before = untouched(b, h);

  expect(await complete(b, h)).toEqual(refused(`task ${child.id} "child" under this task is still being torn down — complete again once it has finished.`));
  expect(untouched(b, h)).toEqual(before);

  b.db.prepare("UPDATE tasks SET teardown_started_at = NULL WHERE id = ?").run(child.id);
  writeFileSync(join(path, "mine.txt"), "not committed\n");
  expect(await complete(b, h)).toEqual(refused(`the workbench at ${path} has uncommitted changes — commit or discard them, then complete again.`));
  expect(untouched(b, h)).toEqual(before);
});

/** 帰り先の持ち主 P(agent の work)と、P を塞がない書き始め済みの人間担当の子 H(`mine.txt` を commit 済み)を作り、P を拾って P の
 *  checkout で `plan.txt` を commit する —— P の session の間。 */
async function ownerSessionOverStartedChild(b: Board) {
  const p = work(b, "plan");
  // 親を塞がない子(分解の決定を持たない)—— P は H を待たずに拾われる
  const h = work(b, "write it myself", { parent_id: p.id, assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, h);
  const { task, place } = await picked(b, p);
  commitWork(place.path, "plan.txt", "plan\n");
  return { p, h, task, place };
}

/** P の session を分解で終える(後始末の印は呼び手が立てる —— 立てなければ解放待ち)。 */
const decomposeOwner = (b: Board, task: Task) =>
  decomposeTaskViaWorker(b.db, task, { reason: "split", children: [{ title: "later", purpose: "p", completion_criteria: "c" }] }, "deckhand", b.clock.now());

/** H と帰り先 `task/<P>` の観測 —— 拒まれた扉がどちらにも書いていないこと。 */
const untouchedWithReturn = (b: Board, h: Task, p: Task) => [...untouched(b, h), git(b.ws.path, "rev-parse", `task/${p.id}`)];

it("帰り先の持ち主 P に後始末の印がある間、書き始め済みの H の完了は拒まれ何も書かない —— P の解放の後は通り、task/<P> は P の commit と H の両方を含む(ADR 0390 決定1・2)", async () => {
  const b = await board("return-owner-teardown");
  const { p, h, task } = await ownerSessionOverStartedChild(b);
  decomposeOwner(b, task);
  markTeardown(b.db, p.id, b.clock.now());
  const before = untouchedWithReturn(b, h, p);

  expect(await complete(b, h)).toEqual(refused(ownerOwesRelease(p, "complete")));
  expect(untouchedWithReturn(b, h, p)).toEqual(before);

  await runMarkedTeardown(b, p.id);
  expect((await complete(b, h)).ok).toBe(true);
  expect([git(b.ws.path, "show", `task/${p.id}:plan.txt`), git(b.ws.path, "show", `task/${p.id}:mine.txt`)]).toEqual(["plan", "mine"]);
});

it("H が開いたまま拾われた帰り先の持ち主 P の session の間、H の完了は拒まれる —— P の完了の後は通り、task/<P> は P の門の tip と H の両方を含む(ADR 0390 決定1・2)", async () => {
  const b = await board("return-owner-session");
  const { p, h, task, place } = await ownerSessionOverStartedChild(b);
  const before = untouchedWithReturn(b, h, p);

  expect(await complete(b, h)).toEqual(refused(ownerOwesRelease(p, "complete")));
  expect(untouchedWithReturn(b, h, p)).toEqual(before);

  recordTaskCheckoutTip(b.db, place, p.id);
  const gateTip = git(b.ws.path, "rev-parse", `task/${p.id}`);
  completeTask(b.db, task, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  markTeardown(b.db, p.id, b.clock.now());
  expect(await complete(b, h)).toEqual(refused(ownerOwesRelease(p, "complete")));
  await runMarkedTeardown(b, p.id);

  expect((await complete(b, h)).ok).toBe(true);
  expect(git(b.ws.path, "merge-base", "--is-ancestor", gateTip, `task/${p.id}`)).toBe("");
  expect(git(b.ws.path, "show", `task/${p.id}:mine.txt`)).toBe("mine");
});

it("解放待ち(印は消え、解放が済んでいない)の帰り先の持ち主 P の間、完了も書き始めるも拒まれる —— Quarantine が立てばその question を名指し、受理が解放をやり直した後は通る(ADR 0390 決定1〜3)", async () => {
  const b = await board("return-owner-owed-release");
  const { p, h, task } = await ownerSessionOverStartedChild(b);
  decomposeOwner(b, task);
  const before = untouchedWithReturn(b, h, p);

  // poll が Quarantine を立て直す前
  expect(await complete(b, h)).toEqual(refused(ownerOwesRelease(p, "complete")));
  expect(await startWork(b, h)).toEqual(refused(ownerOwesRelease(p, "start work")));
  expect(untouchedWithReturn(b, h, p)).toEqual(before);

  // 準備の await の間に Quarantine が立った形 —— 書く区間の読みがその question を名指す。能力検査が立てた封じ込めの確認は解放を止めないので名指さない
  quarantineContainment(b.db, "the host's containment check failed", b.clock.now());
  quarantineWorkspace(b.db, b.ws.name, `The release of task ${p.id} is unfinished and answering this question retries it`, b.clock.now());
  const question = quarantineQuestion(b.db, "workspace", b.ws.name)!;
  expect(() => completeHumanWork(b.db, b.ws, getTask(b.db, h.id)!, b.base, { actorId: HUMAN_ACTOR_ID, origin: "webui" }, b.clock.now(), () => {})).toThrow(
    `${ownerOwesRelease(p, "complete")} Answer question ${question.id} first.`,
  );
  // 扉を通れば、準備の前の Quarantine の拒否(text C1a)が同じ question を名指す
  expect(await startWork(b, h)).toEqual(refused(`cannot start work: workspace ${b.ws.name} is quarantined — answer question ${question.id} first.`));
  expect(untouchedWithReturn(b, h, p)).toEqual(before);

  expect((await answer(b)).status).toBe("done");
  expect((await complete(b, h)).ok).toBe(true);
  expect([git(b.ws.path, "show", `task/${p.id}:plan.txt`), git(b.ws.path, "show", `task/${p.id}:mine.txt`)]).toEqual(["plan", "mine"]);
});

it("帰り先の持ち主 P の後始末を止めている開いた question(封じ込めの確認・落ちた後始末)があれば、拒否文がその id を名指す(ADR 0390 決定3)", async () => {
  const b = await board("return-owner-question");
  const { p, h, task } = await ownerSessionOverStartedChild(b);
  decomposeOwner(b, task);
  markTeardown(b.db, p.id, b.clock.now());

  quarantineContainment(b.db, `the worker session for task ${p.id} is settled`, b.clock.now());
  const containment = quarantineQuestion(b.db, "containment", null)!;
  expect(await complete(b, h)).toEqual(refused(`${ownerOwesRelease(p, "complete")} Answer question ${containment.id} first.`));

  quarantineFailedTeardown(b.db, p.id, new Error("boom"), b.clock.now());
  const failed = quarantineQuestion(b.db, "failedTeardown", p.id)!;
  expect(await startWork(b, h)).toEqual(refused(`${ownerOwesRelease(p, "start work")} Answer question ${failed.id} first.`));
});

it("帰り先の持ち主 P の今の session が閉じ切らなかった question があれば、session 中も後始末の印の後も拒否文がその id を名指す —— 封じ込めの確認より先(ADR 0390 決定3)", async () => {
  const b = await board("return-owner-unclosed");
  const { p, h, task } = await ownerSessionOverStartedChild(b);
  const spawn = latestEventOfTask(b.db, p.id, "worker_spawned")!.id;
  quarantineUnclosedSession(b.db, spawn, p.id, new Error("boom"), b.clock.now());
  const unclosed = quarantineQuestion(b.db, "unclosedSession", String(spawn))!;

  expect(await complete(b, h)).toEqual(refused(`${ownerOwesRelease(p, "complete")} Answer question ${unclosed.id} first.`));

  decomposeOwner(b, task);
  markTeardown(b.db, p.id, b.clock.now());
  quarantineContainment(b.db, `the worker session for task ${p.id} is settled`, b.clock.now());
  expect(await startWork(b, h)).toEqual(refused(`${ownerOwesRelease(p, "start work")} Answer question ${unclosed.id} first.`));
});

it("書き始めるは最後の await の後に帰り先の持ち主を読む —— 準備の fetch を待つ間に P が拾われれば拒み、task/<H> を作らない(ADR 0390 決定2)", async () => {
  const b = await board("return-owner-after-await");
  const p = work(b, "plan");
  // 兄弟の書き始めるが P のタスクブランチを固定する(ADR 0374 決定3)—— 系譜はタスクブランチを持つ祖先だけを数える
  expect((await startWork(b, work(b, "fix it first", { parent_id: p.id, assignee: HUMAN_ACTOR_ID }))).ok).toBe(true);
  const h = work(b, "write it myself", { parent_id: p.id, assignee: HUMAN_ACTOR_ID });

  const result = await duringPreparation(
    (githubAuth) => startWorkThroughHumanDoor({ ...deps(b), githubAuth }, h.id, () => b.clock.now(), "webui"),
    () => {
      pickupTask(b.db, getTask(b.db, p.id)!, "deckhand", b.clock.now());
    },
  );

  expect(result).toEqual(refused(ownerOwesRelease(p, "start work")));
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${h.id}`)).toBe("");
  expect(kinds(b.db, h.id)).toEqual(["task_registered"]);
});

it("書き始めるが帰り先を git で読めなければ、固定の失敗と同じく workspace の Quarantine を立てて text C1a で拒む(ADR 0374 決定2)", async () => {
  const b = await board("return-owner-unreadable");
  const p = work(b, "plan");
  const h = work(b, "write it myself", { parent_id: p.id, assignee: HUMAN_ACTOR_ID });
  const { task, place } = await picked(b, p);
  commitWork(place.path, "plan.txt", "plan\n");
  recordTaskCheckoutTip(b.db, place, p.id);
  completeTask(b.db, task, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  markTeardown(b.db, p.id, b.clock.now());
  await runMarkedTeardown(b, p.id);

  // 完了した P の系譜の読みは task/<P> を git で当てる —— 準備の後にその ref が消えた形
  const result = await duringPreparation(
    (githubAuth) => startWorkThroughHumanDoor({ ...deps(b), githubAuth }, h.id, () => b.clock.now(), "webui"),
    () => {
      git(b.ws.path, "update-ref", "-d", `refs/heads/task/${p.id}`);
    },
  );

  const question = quarantineQuestion(b.db, "workspace", b.ws.name);
  expect(question).toBeDefined();
  expect(result).toEqual(refused(`cannot start work: workspace ${b.ws.name} is quarantined — answer question ${question!.id} first.`));
  expect(kinds(b.db, h.id)).toEqual(["task_registered"]);
});

it("tip が task/<H> のままで作業ツリーが汚れていれば、完了は答え直しに complete again を言って拒み、何も書かない(text C2d)", async () => {
  const b = await board("complete-dirty-no-commit");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, h);
  const path = realpathSync(humanWorkbench(b, h));
  writeFileSync(join(path, "README.md"), "not committed\n");
  const before = untouched(b, h);

  expect(await complete(b, h)).toEqual(refused(
    `the workbench at ${path} has nothing new on task/${h.id}, but it has uncommitted changes — commit them on task/${h.id} or discard them. Then complete again.`,
  ));
  expect(untouched(b, h)).toEqual(before);
});

it("最後の await の後に動いた ref も見る —— 準備の fetch を待つ間に task/<H> が進めば、書く区間の検査が拒む(pin C10)", async () => {
  const b = await board("complete-after-await");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, h);

  const result = await duringPreparation(
    (githubAuth) => completeThroughHumanDoor({ ...deps(b), githubAuth }, h.id, { handoff: FULL_HANDOFF }, () => b.clock.now(), "webui"),
    () => {
      git(b.ws.path, "update-ref", `refs/heads/task/${h.id}`, git(b.ws.path, "commit-tree", "-p", `task/${h.id}`, "-m", "moved", `task/${h.id}^{tree}`));
    },
  );

  expect(!result.ok && result.failure.error).toMatch(new RegExp(`^task/${h.id} has moved on since your tip`));
  expect(getTask(b.db, h.id)!.status).toBe("todo");
});

// #3384: 準備の await の後に書く記録は、書く同期区間で読んだ時刻を持つ —— 扉の先頭で読んだ時刻ではない
const createdAt = (db: Db, taskId: string | null, kinds: Parameters<typeof listEventsOfKinds>[1]) =>
  listEventsOfKinds(db, kinds).filter((e) => e.task_id === taskId).map(({ payload, created_at }) => [payload.kind, created_at]);
const AFTER_THE_PREPARATION = new Date(60_000).toISOString();

it("start_work が準備を待った後に残す task_branch_created と task_work_started の時刻は、準備を待った後の時刻", async () => {
  const b = await board("start-work-time");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });

  await duringPreparation((githubAuth) => startWorkThroughHumanDoor({ ...deps(b), githubAuth }, h.id, () => b.clock.now(), "webui"), () => b.clock.advance(60_000));

  expect(createdAt(b.db, h.id, ["task_branch_created", "task_work_started"])).toEqual([
    ["task_branch_created", AFTER_THE_PREPARATION],
    ["task_work_started", AFTER_THE_PREPARATION],
  ]);
});

it("pickup の準備を待った後に残す task_branch_created と task_checkout_opened の時刻は、準備を待った後の時刻", async () => {
  const b = await board("pickup-time");
  const task = pickupTask(b.db, work(b, "an agent's task", { assignee: "deckhand" }), "deckhand", b.clock.now())!;

  await duringPreparation(
    (githubAuth) => prepareWorkspaceAtPickup(b.db, b.ws, task, { githubAuth, workspacesBaseDir: b.base, now: () => b.clock.now(), resolveRegistered: undefined, defaultWorkspaceName: b.ws.name }),
    () => b.clock.advance(60_000),
  );

  expect(createdAt(b.db, task.id, ["task_branch_created", "task_checkout_opened"])).toEqual([
    ["task_branch_created", AFTER_THE_PREPARATION],
    ["task_checkout_opened", AFTER_THE_PREPARATION],
  ]);
});

it("take_in_work が準備を待った後に残す workbench_taken_in の時刻は、準備を待った後の時刻", async () => {
  const b = await board("take-in-time");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, h);

  await duringPreparation((githubAuth) => takeInWorkThroughHumanDoor({ ...deps(b), githubAuth }, h.id, () => b.clock.now(), "webui"), () => b.clock.advance(60_000));

  expect(createdAt(b.db, null, ["workbench_taken_in"])).toEqual([["workbench_taken_in", AFTER_THE_PREPARATION]]);
});

it("タスクブランチを持つ H の完了が準備を待った後に残す workbench_taken_in と task_completed の時刻は、準備を待った後の時刻", async () => {
  const b = await board("complete-time");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, h);

  await duringPreparation(
    (githubAuth) => completeThroughHumanDoor({ ...deps(b), githubAuth }, h.id, { handoff: FULL_HANDOFF }, () => b.clock.now(), "webui"),
    () => b.clock.advance(60_000),
  );

  expect(createdAt(b.db, null, ["workbench_taken_in"])).toEqual([["workbench_taken_in", AFTER_THE_PREPARATION]]);
  expect(createdAt(b.db, h.id, ["task_completed"])).toEqual([["task_completed", AFTER_THE_PREPARATION]]);
});

it("completion rechecks the review tier after waiting for workspace preparation", async () => {
  const b = await board("human-review-tier-changed");
  const root = work(b, "pending intake", { assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, root);
  const before = untouched(b, root);
  applyExecutionSettingsChange(b.db, { setting: "insert_tier", name: "temporary", description: "a temporary tier", position: 0 }, "webui", b.clock.now());

  const result = await duringPreparation(
    (githubAuth) => completeThroughHumanDoor({ ...deps(b), githubAuth }, root.id, { handoff: FULL_HANDOFF, review_tier: "temporary" }, () => b.clock.now(), "webui"),
    () => {
      applyExecutionSettingsChange(b.db, { setting: "delete_tier", name: "temporary" }, "webui", b.clock.now());
    },
  );

  expect(result).toMatchObject({ ok: false, failure: { error: expect.stringContaining('unknown review_tier "temporary"') } });
  expect(untouched(b, root)).toEqual(before);
  expect(takenIn(b.db)).toEqual([]);
});

it("準備の fetch を待つ間に cancel された H には、start_work も完了も扉の門を掛け直して何も書かない(Edit・cancel は in-flight の鍵を取らない)", async () => {
  const b = await board("gate-after-await");
  const started = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, started);
  const fresh = work(b, "not started yet", { assignee: HUMAN_ACTOR_ID });
  const branch = git(b.ws.path, "rev-parse", `task/${started.id}`);

  const startResult = await duringPreparation(
    (githubAuth) => startWorkThroughHumanDoor({ ...deps(b), githubAuth }, fresh.id, () => b.clock.now(), "webui"),
    () => {
      cancelTaskDirectly(b.db, getTask(b.db, fresh.id)!, null, b.clock.now(), {}, "webui");
    },
  );
  const completeResult = await duringPreparation(
    (githubAuth) => completeThroughHumanDoor({ ...deps(b), githubAuth }, started.id, { handoff: FULL_HANDOFF }, () => b.clock.now(), "webui"),
    () => {
      cancelTaskDirectly(b.db, getTask(b.db, started.id)!, null, b.clock.now(), {}, "webui");
    },
  );

  expect(startResult).toEqual(refused("a settled task cannot be started"));
  expect(completeResult).toEqual(refused("a settled task cannot be completed"));
  expect(kinds(b.db, fresh.id)).not.toContain("task_work_started");
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${fresh.id}`)).toBe("");
  expect([getTask(b.db, started.id)!.status, git(b.ws.path, "rev-parse", `task/${started.id}`), takenIn(b.db)]).toEqual(["cancelled", branch, []]);
});

it("done の後に作業台の tip が読んだものから動いていれば、作業台を残して text C7 を返す —— task の表示は在り処だけを言い、書き込みを誘うコマンドを出さない(pin C11)", async () => {
  const b = await board("complete-kept");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  expect(humanWorkbenchDisplay(b.base, getTask(b.db, h.id)!)).toEqual({ workbench: path, workbench_commands: workbenchCommands(path) });
  await prepareHumanWork(b.db, b.ws, h, "complete", { workspacesBaseDir: b.base, now: () => b.clock.now(), resolveRegistered: undefined, defaultWorkspaceName: b.ws.name });

  const notice = completeHumanWork(b.db, b.ws, getTask(b.db, h.id)!, b.base, { actorId: HUMAN_ACTOR_ID, origin: "webui" }, b.clock.now(), () => {
    completeTask(b.db, getTask(b.db, h.id)!, FULL_HANDOFF, HUMAN_ACTOR_ID, b.clock.now(), "webui");
    commitWork(path, "late.txt", "arrived after the read\n");
  });

  expect(humanWorkbenchDisplay(b.base, getTask(b.db, h.id)!)).toEqual({ workbench: path });
  expect(notice).toBe(`completed. Commits reached the workbench at ${path} after the board read it and were not taken in; the workbench is kept. The task is done, so they do not enter through it.`);
  expect([getTask(b.db, h.id)!.status, existsSync(join(path, "late.txt"))]).toEqual(["done", true]);
  expect(() => git(b.ws.path, "show", `task/${h.id}:late.txt`)).toThrow();
});

// ADR 0401 決定1 の (3): `done` と merge back を書いた後に作業台を消せなくても完了は拒まず、作業台の在り処と原因を言う
it("done の後に作業台を消せなければ、完了は通って task は done のまま、notice が作業台を消せなかったことと在り処を言う", async () => {
  const b = await board("complete-unremovable");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  lockDirInside(path);
  await prepareHumanWork(b.db, b.ws, h, "complete", { workspacesBaseDir: b.base, now: () => b.clock.now(), resolveRegistered: undefined, defaultWorkspaceName: b.ws.name });

  const notice = completeHumanWork(b.db, b.ws, getTask(b.db, h.id)!, b.base, { actorId: HUMAN_ACTOR_ID, origin: "webui" }, b.clock.now(), () => {
    completeTask(b.db, getTask(b.db, h.id)!, FULL_HANDOFF, HUMAN_ACTOR_ID, b.clock.now(), "webui");
  });

  expect(getTask(b.db, h.id)!.status).toBe("done");
  const [said, exit] = notRemoved("completed.", path);
  expect(notice).toContain(said);
  expect(notice?.endsWith(exit)).toBe(true);
});

it("done の後に作業台に stash が残っていれば、作業台を残してそれを言う —— text C7 ではない(pin C11)", async () => {
  const b = await board("complete-kept-stash");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  writeFileSync(join(path, "mine.txt"), "parked\n");
  git(path, "stash");

  const done = await complete(b, h);

  expect(done.ok && done.value.notice).toBe(
    `completed. The workbench at ${path} is kept: the stash holds commits that task/${h.id} does not have — merge them into task/${h.id}, or delete them. The task is done, so nothing enters through it.`,
  );
  expect([getTask(b.db, h.id)!.status, git(b.ws.path, "show", `task/${h.id}:mine.txt`), existsSync(path)]).toEqual(["done", "mine", true]);
});

it("cancel は取り込まず、ブランチも作業台も動かさない(pin C11、ADR 0374 決定11)", async () => {
  const b = await board("cancel-keeps");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  const branch = git(b.ws.path, "rev-parse", `task/${h.id}`);

  cancelTaskDirectly(b.db, getTask(b.db, h.id)!, null, b.clock.now(), {}, "webui");

  expect([git(b.ws.path, "rev-parse", `task/${h.id}`), git(path, "show", "HEAD:mine.txt"), takenIn(b.db)]).toEqual([branch, "mine", []]);
});

it("書き始めたのに作業台が disk から消えていれば、完了は start_work を指して拒まれ(text C2e)、開き直せば通る(pin C12)", async () => {
  const b = await board("complete-gone");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  rmSync(path, { recursive: true, force: true });
  const before = untouched(b, h);

  expect(await complete(b, h)).toEqual(refused(
    `the workbench of this task is gone from ${humanWorkbench(b, h)}; commits that were not taken in are lost. Run start_work to open it again from task/${h.id}, then complete again.`,
  ));
  expect(untouched(b, h)).toEqual(before);

  await startWork(b, h);
  expect((await complete(b, h)).ok).toBe(true);
});

it("帰り先から入った人間しか書けない path の変更を merge した tip は通る —— 帰り先の値も入力の tip(pin C18、ADR 0374 決定6)", async () => {
  const b = await board("complete-human-only-path");
  const root = work(b, "plan");
  const h = work(b, "write it myself", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  // 帰り先に人間しか書けない path の変更が入る(盤面の口を通して書く —— 基準どおりの値)
  const scratch = await tempDir("tidepool-scratch-");
  git(scratch, "clone", "--quiet", "--branch", `task/${root.id}`, b.ws.path, ".");
  commitWork(scratch, ".mcp.json", "{}\n");
  git(b.ws.path, "fetch", "--quiet", scratch, `task/${root.id}`);
  const advanced = git(b.ws.path, "rev-parse", "FETCH_HEAD");
  boardRefWriter(b.db, b.ws)(`refs/heads/task/${root.id}`, advanced, () => git(b.ws.path, "update-ref", `refs/heads/task/${root.id}`, advanced));
  await startWork(b, h);
  git(path, "merge", "--no-edit", `board/task/${root.id}`);

  expect((await complete(b, h)).ok).toBe(true);
  expect(git(b.ws.path, "show", `task/${root.id}:mine.txt`)).toBe("mine");
});

it("書き始めた H の task/<H> への子の merge back の conflict は H 自身の作業台で受け、その Quarantine の回答は人間の書きかけの commit も取り込む —— 回答までは H の完了も take_in_work も準備が拒み何も書かない(pin C20・C6)", async () => {
  const b = await board("child-conflict-into-human");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  const first = await pickedAgentChild(b, h);
  const second = await pickedAgentChild(b, h);
  await finishAgentChild(b, first, "work.txt", "first\n");
  await finishAgentChild(b, second, "work.txt", "second\n");

  const question = quarantineQuestion(b.db, "workspace", b.ws.name)!;
  expect(question.purpose).toContain(
    `task/${second.task.id} does not merge cleanly into 'task/${h.id}'. The board opened the workbench at ${path} for it; its tip does not contain task/${second.task.id}.`,
  );
  expect(await complete(b, h)).toEqual(refused(`cannot complete: workspace ${b.ws.name} is quarantined — answer question ${question.id} first.`));
  const before = untouched(b, h);
  expect(await takeIn(b, h)).toEqual(refused(`cannot take in: workspace ${b.ws.name} is quarantined — answer question ${question.id} first.`));
  expect(untouched(b, h)).toEqual(before);

  git(path, "merge", "--no-edit", `board/task/${h.id}`);
  expect(() => git(path, "merge", `board/task/${second.task.id}`)).toThrow();
  writeFileSync(join(path, "work.txt"), "first\nsecond\n");
  git(path, "commit", "-am", "resolve");
  expect((await answer(b)).status).toBe("done");

  expect([git(b.ws.path, "show", `task/${h.id}:mine.txt`), git(b.ws.path, "show", `task/${h.id}:work.txt`)]).toEqual(["mine", "first\nsecond"]);
  expect(existsSync(path)).toBe(true);
  expect((await complete(b, h)).ok).toBe(true);
  expect(existsSync(path)).toBe(false);
});

// ADR 0382 追記(#3769): `task/*` へ書く入口は、作業台の tip が他の task のブランチの commit を持てば拒む —— 範囲はすべての task
// (決着済み・cancel 済みを含む)。数えないのは書く先・帰り先・保護ブランチの今の値にある commit

/** 人間担当の根を書き始めて commit し、完了させる —— そのブランチは着地を待つ(未着地)。 */
async function completedHumanRoot(b: Board, title: string): Promise<Task> {
  const root = work(b, title, { assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, root, `${title}.txt`, `${title}\n`);
  expect((await complete(b, root)).ok).toBe(true);
  return root;
}

/** 人間担当の根を書き始めて commit し、take_in_work で task/<X> へ取り込んでから cancel する。 */
async function cancelledHumanRoot(b: Board, title: string): Promise<Task> {
  const root = work(b, title, { assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, root, `${title}.txt`, `${title}\n`);
  expect((await takeIn(b, root)).ok).toBe(true);
  cancelTaskDirectly(b.db, getTask(b.db, root.id)!, null, b.clock.now(), {}, "webui");
  return root;
}

const carriesWork = (path: string, branch: string) =>
  `the tip of the workbench at ${path} contains commits of ${branch}, and the board carries a task's work itself — a child's by its merge back, a root's by its landing.`;
const cancelledWork = (path: string, branch: string) => `the tip of the workbench at ${path} contains commits of ${branch}, which was cancelled, so the board does not carry its work.`;
const keepOwnCommits = (h: Task, again: string) =>
  ` To keep only your own commits, start task/${h.id} in the workbench over with \`git reset --hard board/task/${h.id}\` and commit them again — \`git cherry-pick\` copies a change you still want without its history — then ${again}.`;

/** 拒まれた取り込みが何も書いていないことの観測: task、名前の場所の ref と作業ツリー、取り込みの event。 */
const nothingWritten = (b: Board, h: Task) => [untouched(b, h), namedPlace(b.ws), takenIn(b.db)];

const intakeDoors = [
  ["完了", complete, "complete again"],
  ["take_in_work", takeIn, "take in again"],
] as const;

it.each(intakeDoors)("人間担当の work の%sは、未着地の別の根の board/task/<A> を merge した作業台の tip を拒み何も書かない(ADR 0382 追記、#3769)", async (_, door, again) => {
  const b = await board(`carry-unlanded-root-${again.split(" ")[0]}`);
  const a = await completedHumanRoot(b, "a");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  git(path, "merge", "--no-edit", `board/task/${a.id}`);
  const before = nothingWritten(b, h);

  expect(await door(b, h)).toEqual(refused(carriesWork(path, `task/${a.id}`) + keepOwnCommits(h, again)));
  expect(nothingWritten(b, h)).toEqual(before);
});

it.each(intakeDoors)("人間担当の work の%sは、cancel 済みの根の board/task/<X> を merge した作業台の tip を、cancel 済みと言って拒み何も書かない(ADR 0382 追記、#3769)", async (_, door, again) => {
  const b = await board(`carry-cancelled-root-${again.split(" ")[0]}`);
  const x = await cancelledHumanRoot(b, "x");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  git(path, "merge", "--no-edit", `board/task/${x.id}`);
  const before = nothingWritten(b, h);

  expect(await door(b, h)).toEqual(refused(cancelledWork(path, `task/${x.id}`) + keepOwnCommits(h, again)));
  expect(nothingWritten(b, h)).toEqual(before);
});

it("人間担当の work の take_in_work は、運ばれる側でない自分の子の board/task/<C> を merge した作業台の tip を拒み何も書かない —— 子の成果は merge back でだけ届く(ADR 0382 追記、#3769)", async () => {
  const b = await board("carry-own-child");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  const { task: child, place } = await pickedAgentChild(b, h);
  commitWork(place.path, "child.txt", "child\n");
  recordTaskCheckoutTip(b.db, place, child.id);
  await startWork(b, h);
  git(path, "merge", "--no-edit", `board/task/${child.id}`);
  const before = nothingWritten(b, h);

  expect(await takeIn(b, h)).toEqual(refused(carriesWork(path, `task/${child.id}`) + keepOwnCommits(h, "take in again")));
  expect(nothingWritten(b, h)).toEqual(before);
});

it("人間担当の work の完了は、帰り先に merge back の届いた兄弟のブランチの merge、着地済みの根のブランチの merge、未着地の根の commit の cherry-pick を持つ作業台の tip を取り込む(ADR 0382 追記、#3769)", async () => {
  const b = await board("carry-allowed-forms");
  const root = work(b, "plan");
  const h = work(b, "write it myself", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  const sibling = await completedAgentChild(b, root, "sibling.txt", "sibling\n");
  const landed = await completedHumanRoot(b, "landed");
  const landing = createLanding({ defaultAgentName: "tako", db: b.db, clock: b.clock, workspace: b.ws, github: null, resolveAuthority: () => ({ name: "standard", guidance: "", merge: "auto_if_ci_green" as const }) });
  await landing.converge();
  const question = listBoard(b.db).find((q) => q.question_pending_local_merge_task_id === landed.id)!;
  expect((await submitAnswer({ db: b.db, pollNow: () => {}, landing: unusedLanding, workspace: b.ws, workspacesDir: b.base }, getTask(b.db, question.id)!, ["merge"], undefined, () => b.clock.now(), "webui")).status).toBe("done");
  const unlanded = await completedHumanRoot(b, "unlanded");
  await startWork(b, h);
  git(path, "merge", "--no-edit", `board/task/${sibling.id}`);
  git(path, "merge", "--no-edit", `board/task/${landed.id}`);
  // 第2親が人間の commit(第1親は包む commit の前の値)。`-x` で写しの message を変える —— 同じ親・同じ秒の cherry-pick は元と同じ commit になる
  git(path, "cherry-pick", "-x", `board/task/${unlanded.id}^2`);

  expect((await complete(b, h)).ok).toBe(true);
  expect(["sibling.txt", "landed.txt", "unlanded.txt", "mine.txt"].map((file) => git(b.ws.path, "show", `task/${root.id}:${file}`))).toEqual(["sibling", "landed", "unlanded", "mine"]);
});

it("非根の H が帰り先 task/<P> を merge した書きかけを持つ作業台で、子の merge back の conflict を受けて答えた回答は通る —— H の帰り先の commit を数えない(ADR 0382 追記、#3769)", async () => {
  const b = await board("child-conflict-over-return-merge");
  const root = work(b, "plan");
  const h = work(b, "write it myself", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  await completedAgentChild(b, root, "sibling.txt", "sibling\n");
  await startWork(b, h);
  git(path, "merge", "--no-edit", `board/task/${root.id}`);
  const first = await pickedAgentChild(b, h);
  const second = await pickedAgentChild(b, h);
  await finishAgentChild(b, first, "work.txt", "first\n");
  await finishAgentChild(b, second, "work.txt", "second\n");
  expect(quarantineQuestion(b.db, "workspace", b.ws.name)?.purpose).toContain(`The board opened the workbench at ${path} for it`);

  git(path, "merge", "--no-edit", `board/task/${h.id}`);
  expect(() => git(path, "merge", `board/task/${second.task.id}`)).toThrow();
  writeFileSync(join(path, "work.txt"), "first\nsecond\n");
  git(path, "commit", "-am", "resolve");
  expect((await answer(b)).status).toBe("done");

  expect(["mine.txt", "sibling.txt", "work.txt"].map((file) => git(b.ws.path, "show", `task/${h.id}:${file}`))).toEqual(["mine", "sibling", "first\nsecond"]);
});

it("done の後に落ちた H の merge back は積み残しになり、workspace の Quarantine の受理のやり直しが運ぶ", async () => {
  const b = await board("complete-leftover");
  const root = work(b, "plan");
  const h = work(b, "write it myself", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  let first = true;

  // 書く区間の検査の後、H の merge back の直前に帰り先の ref を一度だけ塞ぐ(盤面の外の故障)—— done は書かれた後
  const notice = completeHumanWork(b.db, b.ws, getTask(b.db, h.id)!, b.base, { actorId: HUMAN_ACTOR_ID, origin: "webui" }, b.clock.now(), () => {
    completeTask(b.db, getTask(b.db, h.id)!, FULL_HANDOFF, HUMAN_ACTOR_ID, b.clock.now(), "webui");
    if (first) writeFileSync(join(b.ws.path, ".git", "refs", "heads", "task", `${root.id}.lock`), "");
    first = false;
  });

  expect(notice).toBeUndefined();
  expect(getTask(b.db, h.id)!.status).toBe("done");
  expect(() => git(b.ws.path, "show", `task/${root.id}:mine.txt`)).toThrow();
  expect(quarantineQuestion(b.db, "workspace", b.ws.name)?.purpose).toMatch(new RegExp(`task/${root.id}`));
  expect(existsSync(path)).toBe(false);

  rmSync(join(b.ws.path, ".git", "refs", "heads", "task", `${root.id}.lock`));
  expect((await answer(b)).status).toBe("done");
  expect(git(b.ws.path, "show", `task/${root.id}:mine.txt`)).toBe("mine");
});

it("親が別の workspace に固定された H は根として完了する —— 帰り先は保護ブランチ(pin C8)", async () => {
  const b = await board("complete-as-root");
  const parent = registerTask(b.db, { type: "work", title: "plan", purpose: "why", completion_criteria: "done", workspace: "elsewhere" }, b.clock.now(), ...HUMAN_WEBUI);
  appendEvent(b.db, { taskId: parent.id, actorId: "board", origin: "board", payload: { kind: "task_branch_created", sha: "0".repeat(40), workspace: "elsewhere" }, at: b.clock.now() });
  const h = work(b, "write it myself", { parent_id: parent.id, assignee: HUMAN_ACTOR_ID });
  b.db.prepare("UPDATE tasks SET workspace = ? WHERE id = ?").run(b.ws.name, h.id);
  const path = await startedWithCommit(b, h, "README.md", "human\n");
  const scratch = await tempDir("tidepool-scratch-");
  git(scratch, "clone", "--quiet", b.ws.path, ".");
  commitWork(scratch, "README.md", "protected moved\n");
  git(b.ws.path, "fetch", "--quiet", scratch, "main");
  const moved = git(b.ws.path, "rev-parse", "FETCH_HEAD");
  // 名前の場所は main に居るので、作業ツリーも追わせる(盤面の口の advance と同じ姿)
  boardRefWriter(b.db, b.ws)("refs/heads/main", moved, () => git(b.ws.path, "update-ref", "refs/heads/main", moved));
  git(b.ws.path, "read-tree", "-u", "--reset", "HEAD");

  const result = await complete(b, h);

  expect(!result.ok && result.failure.error).toMatch(new RegExp(`^task/${h.id} does not merge cleanly into 'main'\\. In the workbench at ${path}, on task/${h.id}, run \`git merge board/main\``));
});

it("子が走った後に assignee を human に替えた根は、タスクブランチを持つので完了に handoff の6欄が要り、取り込まずに閉じて子の成果は task/<根> に残り、registry の盤面でも purely-local の local merge question で着地する(#3418 のレビューの形 1a、pin C8・C16)", async () => {
  const b = await board("root-switched-to-human");
  const root = work(b, "plan");
  await completedAgentChild(b, root, "child.txt", "child\n");
  editTask(b.db, getTask(b.db, root.id)!, { assignee: HUMAN_ACTOR_ID }, b.clock.now(), "webui");
  const branch = git(b.ws.path, "rev-parse", `task/${root.id}`);

  expect(!(await complete(b, root, {})).ok).toBe(true);
  expect((await complete(b, root)).ok).toBe(true);
  expect([git(b.ws.path, "rev-parse", `task/${root.id}`), git(b.ws.path, "show", `task/${root.id}:child.txt`), takenIn(b.db)]).toEqual([branch, "child", []]);
  const review = listChildren(b.db, root.id).find((task) => task.type === "review");
  expect(review).toMatchObject({ status: "todo" });

  // registry と同じく、名前 tako だけが解決する —— `human` は agent として引かれない
  const resolveAuthority = (assignee: string | null) => {
    if (assignee !== "tako") throw new UnknownAgentError(String(assignee));
    return { name: "standard", guidance: "", merge: "auto_if_ci_green" as const };
  };
  const landing = createLanding({ defaultAgentName: "tako", db: b.db, clock: b.clock, workspace: b.ws, github: null, resolveAuthority });
  expect((await landing.converge()).find((r) => r.taskId === root.id)?.verdict).toEqual({ kind: "landed", form: "local_merge_question" });
  const question = listBoard(b.db).find((q) => q.question_pending_local_merge_task_id === root.id)!;
  expect(question.purpose).toBe('"plan" was completed by a human. A human-completed root is merged only on your answer. Merge it into main, or hold?');
  expect(listBoard(b.db).filter((q) => q.question_quarantine_kind === "agent")).toEqual([]);

  expect((await submitAnswer({ db: b.db, pollNow: () => {}, landing: unusedLanding, workspace: b.ws, workspacesDir: b.base }, getTask(b.db, question.id)!, ["merge"], undefined, () => b.clock.now(), "webui")).status).toBe("done");
  expect(git(b.ws.path, "show", "main:child.txt")).toBe("child");
  await expectReviewPickedUp(b, review!.id);
});

// ADR 0374 決定5 / spec #3273 group C: 完了を伴わない取り込み(`take_in_work`)
it("take_in_work は作業台の tip を包む commit で task/<H> に取り込み、完了せず、作業台の branch を包む commit へ進めて clean のまま残す —— 後で登録した子はそこから切られる(pin C6・A15)", async () => {
  const b = await board("take-in");
  const h = work(b, "lay the groundwork", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h, "ground.txt", "groundwork\n");
  const tip = git(path, "rev-parse", "HEAD");
  const main = git(b.ws.path, "rev-parse", "main");

  const result = await takeIn(b, h);

  const wrapped = git(b.ws.path, "rev-parse", `task/${h.id}`);
  expect(result).toEqual({
    ok: true,
    value: { message: `took ${tip} in as ${wrapped} on task/${h.id}. In a clone, fetch the workbench and fast-forward to \`board/task/${h.id}\` before you write on.` },
  });
  expect(git(b.ws.path, "rev-parse", `${wrapped}^1`, `${wrapped}^2`)).toBe(`${main}\n${tip}`);
  expect(takenIn(b.db)).toEqual([{ kind: "workbench_taken_in", workspace: b.ws.name, target: `refs/heads/task/${h.id}`, tip, commit: wrapped, entry: "take_in_work" }]);
  expect(getTask(b.db, h.id)!.status).toBe("todo");
  expect([git(path, "rev-parse", `task/${h.id}`), git(path, "rev-parse", `board/task/${h.id}`), git(path, "status", "--porcelain")]).toEqual([wrapped, wrapped, ""]);
  const { place } = await pickedAgentChild(b, h);
  expect(git(place.path, "show", "HEAD:ground.txt")).toBe("groundwork");
});

// ADR 0411 決定2・4: 作業台は閉包を全部持つ複製 —— 運んだ後の確かめが閉包の全部を数え、名前の場所で欠けた blob を作業台の写しから入れ直す
it("take_in_work は作業台の新しい tree が名前の場所で欠けた blob を直に指しても取り込み、名前の場所でその blob が読める(ADR 0411 決定2・4)", async () => {
  const b = await board("take-in-named-place");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, h);
  const workbench = realpathSync(humanWorkbench(b, h));
  const { blob } = newTreePointsAtDamagedNamedBlob(b.ws.path, workbench);
  const tip = git(workbench, "rev-parse", `task/${h.id}`);

  expect(await takeIn(b, h)).toEqual({ ok: true, value: { message: expect.stringContaining(`took ${tip} in as `) } });
  expect(git(b.ws.path, "rev-parse", `task/${h.id}^2`)).toBe(tip);
  expect(git(b.ws.path, "cat-file", "-p", blob)).toBe("workspace");
});

it("take_in_work は tip が task/<H> と同じなら取り込むものが無いと拒み、タスクブランチがあって作業台の無い H は start_work を指して拒む —— どちらも何も書かない(pin C19)", async () => {
  const b = await board("take-in-nothing");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, h);
  const path = realpathSync(humanWorkbench(b, h));
  const childrenOnly = work(b, "integrate it", { assignee: HUMAN_ACTOR_ID });
  await completedAgentChild(b, childrenOnly, "child.txt", "child\n");
  const unstarted = work(b, "not started yet", { assignee: HUMAN_ACTOR_ID });
  const before = [untouched(b, h), untouched(b, childrenOnly), kinds(b.db, unstarted.id)];

  expect(await takeIn(b, h)).toEqual(refused(`nothing to take in: task/${h.id} in the workbench at ${path} is the value the board already has.`));
  expect(await takeIn(b, childrenOnly)).toEqual(refused("this task has no workbench — run start_work first."));
  // タスクブランチの無い H も作業台は無い —— 同じ文で、名前の場所に触れる前に拒む
  expect(await takeIn(b, unstarted)).toEqual(refused("this task has no workbench — run start_work first."));
  expect([untouched(b, h), untouched(b, childrenOnly), kinds(b.db, unstarted.id)]).toEqual(before);
  expect(takenIn(b.db)).toEqual([]);
});

it("書き始めたのに作業台が disk から消えた H と、書く先の branch の無い作りかけの作業台は、take_in_work が text C2e で拒み何も書かない(ADR 0382 決定6)", async () => {
  const b = await board("take-in-gone");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  const before = untouched(b, h);
  const gone = refused(
    `the workbench of this task is gone from ${humanWorkbench(b, h)}; commits that were not taken in are lost. Run start_work to open it again from task/${h.id}, then take in again.`,
  );

  git(path, "checkout", "--quiet", "--detach");
  git(path, "branch", "-D", `task/${h.id}`);
  expect(await takeIn(b, h)).toEqual(gone);
  rmSync(path, { recursive: true, force: true });
  expect(await takeIn(b, h)).toEqual(gone);
  expect(untouched(b, h)).toEqual(before);
});

it("拒否の後の `board/*` の引き直しが名前の場所の側で落ちれば、拒否の文は `board/*` の merge を言ったまま、`board/*` が消えた理由を足し、何も書かない(ADR 0411 決定5)", async () => {
  const b = await board("take-in-refused-strict");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  await completedAgentChild(b, h, "child.txt", "child\n");
  // 盤面の口で `side` を置く —— 取り込みの準備の基準の比較には当たらない
  seedZeroPaddedTree(b.ws, "refs/heads/side");
  const side = git(b.ws.path, "rev-parse", "side");
  git(b.ws.path, "update-ref", "-d", "refs/heads/side");
  boardRefWriter(b.db, b.ws)("refs/heads/side", side, () => git(b.ws.path, "update-ref", "refs/heads/side", side));
  const before = untouched(b, h);

  const result = await takeIn(b, h);

  expect(result).toEqual(refused(expect.stringMatching(new RegExp(`^task/${h.id} has moved on since your tip [\\s\\S]*then take in again\\. workspace ${b.ws.name}: the board cannot give the named workspace's branches to the workbench as \`board/\\*\``))));
  expect(git(path, "for-each-ref", "refs/heads/board/")).toBe("");
  expect(untouched(b, h)).toEqual(before);
});

it("shallow な名前の場所の start_work は作業台を開かず、名前の場所を名指して `git fetch --unshallow` を言い、答え直しを誘わない(ADR 0411 決定5)", async () => {
  const ws = await makeShallowWorkspace("start-work-shallow");
  const b: Board = { db: openDb(":memory:"), clock: new FakeClock(), ws, base: await tempDir("tidepool-task-checkouts-") };
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });

  const result = await startWork(b, h);

  expect(result).toEqual(refused(expect.stringMatching(new RegExp(`^cannot start work: workspace ${ws.name}: ${ws.path} is a shallow clone [\\s\\S]*\`git fetch --unshallow\`\\.$`))));
  expect(!result.ok && result.failure.error).not.toContain("again");
  expect(existsSync(humanWorkbench(b, h))).toBe(false);
});

it("拒まれた take_in_work は task に何も書かない: tip が task/<H> の今の値を欠く(text C2a)・未 commit の変更がある(text C2d)—— 子孫の後始末が済んでいなくても通る(pin C6)", async () => {
  const b = await board("take-in-refused");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  await completedAgentChild(b, h, "child.txt", "child\n");
  const before = untouched(b, h);

  expect(await takeIn(b, h)).toEqual(refused(
    `task/${h.id} has moved on since your tip (work of its children arrived). In the workbench at ${path}, on task/${h.id}, run \`git merge board/task/${h.id}\` ` +
      `(or, in your own clone with the workbench as a remote: fetch it, \`git merge <remote>/board/task/${h.id}\`, and push task/${h.id} to it), then take in again.`,
  ));
  expect(untouched(b, h)).toEqual(before);

  git(path, "merge", "--no-edit", `board/task/${h.id}`);
  writeFileSync(join(path, "mine.txt"), "not committed\n");
  expect(await takeIn(b, h)).toEqual(refused(`the workbench at ${path} has uncommitted changes — commit or discard them, then take in again.`));
  expect(untouched(b, h)).toEqual(before);

  git(path, "checkout", "--", "mine.txt");
  const tearing = pickupTask(b.db, work(b, "child", { parent_id: h.id }), "deckhand", b.clock.now())!;
  await prepareAtPickup(b.db, b.ws, tearing, { now: b.clock.now(), workspacesBaseDir: b.base });
  completeTask(b.db, tearing, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  markTeardown(b.db, tearing.id, b.clock.now());
  expect((await takeIn(b, h)).ok).toBe(true);
  expect([git(b.ws.path, "show", `task/${h.id}:mine.txt`), git(b.ws.path, "show", `task/${h.id}:child.txt`)]).toEqual(["mine", "child"]);
});

// pin A15(この鍵の分): 読んだ tip からの CAS —— 包む commit を作る間に作業台へ push が着けば、作業台の branch は人間のまま残し、
// 応答が `board/task/<H>` の merge を言う
it("take_in_work の間に作業台へ push が着けば、作業台の branch は進めず、応答が board/task/<H> の merge を言い、board/task/<H> は包む commit になる", async () => {
  const b = await board("take-in-pushed");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  const tip = git(path, "rev-parse", "HEAD");
  // 包む commit を作る瞬間に、人間の clone からの push を模して作業台の task/<H> に commit を足す
  const result = await withPushDuringWrap(path, () => takeIn(b, h));

  const wrapped = git(b.ws.path, "rev-parse", `task/${h.id}`);
  expect(result).toEqual({
    ok: true,
    value: {
      message:
        `took ${tip} in as ${wrapped} on task/${h.id}. In a clone, fetch the workbench and fast-forward to \`board/task/${h.id}\` before you write on. ` +
        `Merge \`board/task/${h.id}\` into your branch before the next take-in.`,
    },
  });
  expect([git(path, "rev-parse", `task/${h.id}^`), git(path, "log", "-1", "--format=%s", `task/${h.id}`)]).toEqual([tip, "pushed"]);
  expect(git(path, "rev-parse", `board/task/${h.id}`)).toBe(wrapped);
});

// ADR 0374 決定2 / spec #3273 group C(Surfaces): 作業台へ移るコマンドと、自前の clone の remote に足すコマンド。ssh の名前は盤面が知らないので
// `<name>` と `<ssh-host>` は人間が埋める。Lima の guest(host 名 `lima-<instance>`)で動く盤面だけが VM に入るコマンドを先に足す
it("作業台の表示のコマンドは cd と git remote add で、Lima の guest で動く盤面だけ limactl shell <instance> を先に足す", () => {
  expect(workbenchCommands("/srv/checkouts/@workbench/t1", "board-host")).toEqual(["cd /srv/checkouts/@workbench/t1", "git remote add <name> <ssh-host>:/srv/checkouts/@workbench/t1"]);
  expect(workbenchCommands("/srv/checkouts/@workbench/t1", "lima-tidepool")).toEqual([
    "limactl shell tidepool",
    "cd /srv/checkouts/@workbench/t1",
    "git remote add <name> <ssh-host>:/srv/checkouts/@workbench/t1",
  ]);
});

it("作業台の tip が task/<H> に無い commit を持つ H の分解は拒まれず、子は task/<H> から切られて N 個の commit がまだ取り込まれていないと1行警告する —— 取り込めば警告は消える(pin C17)", async () => {
  const b = await board("decompose-warning");
  const h = work(b, "lay the groundwork", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h, "one.txt", "one\n");
  const decompose = (title: string) =>
    decomposeThroughHumanDoor(deps(b), h.id, { reason: "split", children: [{ title, purpose: "p", completion_criteria: "c", assignee: "deckhand" }] }, () => b.clock.now(), "webui");
  const branch = git(b.ws.path, "rev-parse", `task/${h.id}`);

  const single = decompose("first child");
  commitWork(path, "two.txt", "two\n");
  const warned = decompose("first child");

  expect(single.ok && single.value.warning).toBe(`the children fork from task/${h.id}, and 1 commit in the workbench at ${path} is not taken in yet.`);
  expect(warned.ok && warned.value.warning).toBe(`the children fork from task/${h.id}, and 2 commits in the workbench at ${path} are not taken in yet.`);
  expect(warned.ok && warned.value.children.map((child) => child.title)).toEqual(["first child"]);
  expect([git(b.ws.path, "rev-parse", `task/${h.id}`), takenIn(b.db)]).toEqual([branch, []]);

  expect((await takeIn(b, h)).ok).toBe(true);
  const quiet = decompose("second child");
  expect(quiet.ok && quiet.value.warning).toBeUndefined();
});

// ADR 0374 決定7: 拒否のたびに task/<H> の今の値を作業台の ref に引き直す —— 取り込むものが無い拒否も
it("子の成果が届いた後、人間の commit が無い作業台の take_in_work は取り込むものが無いと拒み、board/task/<H> を今の task/<H> に引き直す", async () => {
  const b = await board("take-in-nothing-repoints");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, h);
  const path = realpathSync(humanWorkbench(b, h));
  await completedAgentChild(b, h, "child.txt", "child\n");
  git(path, "update-ref", `refs/heads/board/task/${h.id}`, git(path, "rev-parse", `task/${h.id}`));

  expect(await takeIn(b, h)).toEqual(refused(`nothing to take in: task/${h.id} in the workbench at ${path} is the value the board already has.`));
  expect(git(path, "rev-parse", `board/task/${h.id}`)).toBe(git(b.ws.path, "rev-parse", `task/${h.id}`));
});

it("帰り先から入った人間しか書けない path の変更を merge した tip は take_in_work でも取り込まれる —— 帰り先の値も入力の tip(pin C18、ADR 0374 決定6)", async () => {
  const b = await board("take-in-human-only-path");
  const root = work(b, "plan");
  const h = work(b, "write it myself", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  // 帰り先に人間しか書けない path の変更が入る(盤面の口を通して書く —— 基準どおりの値)
  const scratch = await tempDir("tidepool-scratch-");
  git(scratch, "clone", "--quiet", "--branch", `task/${root.id}`, b.ws.path, ".");
  commitWork(scratch, ".mcp.json", "{}\n");
  git(b.ws.path, "fetch", "--quiet", scratch, `task/${root.id}`);
  const advanced = git(b.ws.path, "rev-parse", "FETCH_HEAD");
  boardRefWriter(b.db, b.ws)(`refs/heads/task/${root.id}`, advanced, () => git(b.ws.path, "update-ref", `refs/heads/task/${root.id}`, advanced));
  await startWork(b, h);
  git(path, "merge", "--no-edit", `board/task/${root.id}`);

  expect((await takeIn(b, h)).ok).toBe(true);
  expect(git(b.ws.path, "show", `task/${h.id}:.mcp.json`)).toBe("{}");
});
