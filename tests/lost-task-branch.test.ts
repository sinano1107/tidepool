import { chmodSync, existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { appendEvent, listEvents, listEventsOfKinds, type TaskScopedPayload } from "../src/events.js";
import { completeThroughHumanDoor, quarantineChecks, startWorkThroughHumanDoor, submitAnswer, takeInWorkThroughHumanDoor } from "../src/human-verbs.js";
import { blockingRootOf, contentLeftBehindLocally, createLanding, type Landing, landingState, prInFlightRefusal, registerLocalMergeQuestion, registerPrPromotionFailureQuestion, settledByObservation, taskIdsAwaitingLandingInWorkspace } from "../src/landing.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { completeTask, countUnsettledTasksReferencing, editTask, fillEmptyWorkspace, getTask, listBoard, listChildren, type RegisterTaskInput, recordPrOpened, registerTask, type Task, taskBranchLostInForce, whyNoReturnDestination } from "../src/tasks.js";
import { queueReturnHandler, spawnFailureHandler } from "../src/watchdog.js";
import { workbenchPath } from "../src/workbench.js";
import { boardRefWriter, LostTaskBranchPresentError, quarantineWorkspace, recordTaskCheckoutTip, releaseWorkspace, removeReleasedTaskCheckoutsOn, resolveTaskBranchLineage, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, decomposeTaskViaWorker, dropBoardBeforeFold, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, makeLandingWorkspace, makeWorkspace, prepareAtPickup, quarantineQuestion, recordTaskBranchCreated, settleReviews, WORKER_SPAWNED } from "./harness.js";
import { attachUnsettledChild, commitThroughTaskCheckout, completeThroughTaskCheckout, finish, landingWork, openBoard, promotionFailures } from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

// 失われたタスクブランチを系譜が記録で読む(ADR 0375 決定1・2、ADR 0380 決定1・3、spec #3273 group H、#3297)。domain 層の釘(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** git の呼び出しの引数の記録 —— 失われた `task/<id>` を git で読む経路が無いことの釘(ADR 0407 決定1)。既定は素通し。 */
const gitCalls = vi.hoisted(() => [] as string[][]);
vi.mock("../src/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...actual,
    git: (cwd: string, ...args: string[]) => {
      gitCalls.push(args);
      return actual.git(cwd, ...args);
    },
  };
});
/** `run` の間に、`taskIds` のどれかの `task/<id>` を名指した git の呼び出し。 */
async function gitReadsOf<T>(taskIds: string[], run: () => T | Promise<T>): Promise<{ result: T; reads: string[][] }> {
  gitCalls.length = 0;
  const result = await run();
  return { result, reads: gitCalls.filter((args) => args.some((arg) => taskIds.some((id) => arg.includes(`task/${id}`)))) };
}

const GIVE_UP = "give up the lost refs and restore the baseline";

type Board = { db: Db; clock: FakeClock; ws: WorkspaceConfig; base: string };

async function board(name: string): Promise<Board> {
  return { db: openDb(":memory:"), clock: new FakeClock(), ws: await makeWorkspace(name), base: await tempDir("tidepool-task-checkouts-") };
}

function work(b: Board, title: string, extra: Partial<RegisterTaskInput> = {}): Task {
  const workspace = extra.parent_id ? undefined : b.ws.name;
  return registerTask(b.db, { type: "work", title, purpose: "why", completion_criteria: "done", workspace, ...extra }, b.clock.now(), ...HUMAN_WEBUI);
}

/** 盤面の pickup の準備(系譜の帰り先から fork、未着手の祖先も固定 —— ADR 0372 決定3)。 */
const pickUp = (b: Board, task: Task) => prepareAtPickup(b.db, b.ws, task, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });

/** 盤面の経路で拾い(系譜の帰り先から fork、未着手の祖先も固定 —— ADR 0372 決定3)、`file` があれば commit し、完了して後始末の merge back まで通す。 */
async function completeThrough(b: Board, task: Task, file?: string, settle = true): Promise<Task> {
  const place = await pickUp(b, task);
  if (file !== undefined) commitWork(place.path, file, `${file}\n`);
  recordTaskCheckoutTip(b.db, place, task.id);
  completeTask(b.db, getTask(b.db, task.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  if (settle) settleReviews(b.db, b.clock.now());
  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now(), true, undefined, undefined, true);
  return getTask(b.db, task.id)!;
}

/** 盤面の経路で拾って `file` を commit し、完了するが merge back はまだ届けない(完了の後始末の前)。 */
async function completeUndelivered(b: Board, task: Task, file: string): Promise<Task> {
  const place = await pickUp(b, task);
  commitWork(place.path, file, `${file}\n`);
  recordTaskCheckoutTip(b.db, place, task.id);
  completeTask(b.db, getTask(b.db, task.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  settleReviews(b.db, b.clock.now());
  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now());
  return getTask(b.db, task.id)!;
}

/** 盤面の経路で拾い、`file` を commit して、完了せずに解放する —— 未決着の task が `task/<id>` に成果を持つ。 */
async function commitThrough(b: Board, task: Task, file: string): Promise<Task> {
  const place = await pickUp(b, task);
  commitWork(place.path, file, `${file}\n`);
  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now());
  return getTask(b.db, task.id)!;
}

/** 人間が `task/<id>` を消し、届かなくなった commit を gc で失わせ、workspace の Quarantine に give-up で答える。 */
async function giveUp(b: Board, ...taskIds: string[]) {
  return giveUpAfter(b, () => {}, ...taskIds);
}

/** `giveUp` の、gc の後(失われた object は戻らない)・回答の前に `incident` で別の ref も動かす形。 */
async function giveUpAfter(b: Board, incident: () => void, ...taskIds: string[]) {
  for (const id of taskIds) git(b.ws.path, "update-ref", "-d", `refs/heads/task/${id}`);
  git(b.ws.path, "reflog", "expire", "--expire=now", "--all");
  git(b.ws.path, "gc", "--quiet", "--prune=now");
  incident();
  quarantineWorkspace(b.db, b.ws.name, new Error("a human deleted task branches"), b.clock.now());
  return answerQuarantine(b, GIVE_UP);
}

/** 開いている workspace の Quarantine に `option` で答える(回答の verb と、その検査)。 */
function answerQuarantine(b: Board, option: string) {
  return submitAnswer(
    { db: b.db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db: b.db, workspace: b.ws, workspacesDir: b.base }) },
    quarantineQuestion(b.db, "workspace", b.ws.name)!,
    [option],
    undefined,
    () => b.clock.now(),
    "webui",
  );
}

const lostEvents = (db: Db) => listEventsOfKinds(db, ["task_branch_lost"]).map(({ task_id, payload }) => ({ task_id, payload }));

it("give-up は tip の object が無い `task/<id>` ごとに失われた sha つきの `task_branch_lost` を status を問わず残し、merge back が届いていた子は書き戻されて event を持たない(ADR 0375 決定1、pin H3)", async () => {
  const b = await board("lost-branch-events");
  const parent = work(b, "parent");
  const child = await completeThrough(b, work(b, "child", { parent_id: parent.id, review_flag: true }), "child.txt", false);
  const childTip = git(b.ws.path, "rev-parse", `task/${child.id}`);
  const reviews = () => listChildren(b.db, child.id).map(({ id, type, status }) => ({ id, type, status }));
  const reviewsBefore = reviews();
  expect(reviewsBefore).toEqual([expect.objectContaining({ type: "review", status: "todo" })]);
  const doneRoot = await completeThrough(b, work(b, "done root"), "done.txt", false);
  const doneTip = git(b.ws.path, "rev-parse", `task/${doneRoot.id}`);
  const unsettled = await commitThrough(b, work(b, "unsettled"), "unsettled.txt");
  const unsettledTip = git(b.ws.path, "rev-parse", `task/${unsettled.id}`);

  await giveUp(b, child.id, doneRoot.id, unsettled.id);

  expect(git(b.ws.path, "rev-parse", `task/${child.id}`)).toBe(childTip);
  expect(reviews()).toEqual(reviewsBefore);
  expect(whyNoReturnDestination(b.db, child.id)).toBeUndefined();
  expect(lostEvents(b.db)).toHaveLength(2);
  expect(lostEvents(b.db)).toEqual(expect.arrayContaining([
    { task_id: doneRoot.id, payload: { kind: "task_branch_lost", sha: doneTip } },
    { task_id: unsettled.id, payload: { kind: "task_branch_lost", sha: unsettledTip } },
  ]));
});

/** `seedThroughBoard` で組む盤面 —— 基準の行を先に撮る(行の無い名前の受理は比べず、失われた ref も数えない)。 */
async function seededBoard(name: string): Promise<Board> {
  const b = await board(name);
  await leaveBaseline(b.db, b.ws);
  return b;
}

/** setup のみ: 盤面の口で `task/<id>` を `sha` に書き(基準に入る)、列を埋めて `task_branch_created` を残す。 */
function seedThroughBoard(b: Board, taskId: string, sha: string): void {
  const ref = `refs/heads/task/${taskId}`;
  boardRefWriter(b.db, b.ws)(ref, sha, () => git(b.ws.path, "update-ref", ref, sha));
  fillEmptyWorkspace(b.db, taskId, b.ws.name);
  recordTaskBranchCreated(b.db, taskId, sha, b.ws.name);
}

const lineageOf = (b: Board, task: Task) => resolveTaskBranchLineage(b.db, b.ws, getTask(b.db, task.id)!, () => b.clock.now());
const accepted = (b: Board) => quarantineQuestion(b.db, "workspace", b.ws.name) === undefined;
const NO_RETURN = { branch: undefined, outlivedForkSource: false, noReturn: true };

it("done の親のブランチが失われ子のブランチが残る: 編集のあった親は死んで子は帰り先なし —— 受理は生の git のエラーで落ちない(ADR 0380 決定1・3、pin H7)", async () => {
  const b = await board("lost-parent-dead");
  const parent = work(b, "parent");
  const child = await completeThrough(b, work(b, "child", { parent_id: parent.id }), "child.txt");
  await completeThrough(b, parent, "parent.txt");

  await giveUp(b, parent.id);

  expect(accepted(b)).toBe(true);
  expect(lineageOf(b, child)).toEqual(NO_RETURN);
});

it("done の親のブランチが失われ子のブランチが残る: handoff だけの親(失われた sha = 作成時の sha)は透明で、子は次の数える祖先へ帰り、レビューも残る(ADR 0380 決定1・3、pin H7・H9)", async () => {
  const b = await seededBoard("lost-parent-transparent");
  const grandparent = work(b, "grandparent");
  const parent = work(b, "parent", { parent_id: grandparent.id });
  const child = work(b, "child", { parent_id: parent.id });
  const main = git(b.ws.path, "rev-parse", "main");
  seedThroughBoard(b, grandparent.id, main);
  seedThroughBoard(b, parent.id, git(b.ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "only on the parent's branch"));
  seedThroughBoard(b, child.id, main);
  completeTask(b.db, child, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  completeTask(b.db, getTask(b.db, parent.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  const review = humanTask(b, { type: "review", title: "child's review", parent_id: child.id });

  await giveUp(b, parent.id);

  expect(accepted(b)).toBe(true);
  expect(lineageOf(b, child)).toEqual({ branch: `task/${grandparent.id}`, outlivedForkSource: false });
  expect(statusOf(b, review)).toBe("todo");
});

/** 生きている根 R(自分の commit を持つ)→ 死ぬ D → 無事な M → C。C と M は完了して merge back が届き、D は自分の commit を積んで完了したが R へは届いていない。
 *  D のブランチを失わせて give-up で答えた盤面。 */
async function deadTaskUnderLivingRoot(name: string, beforeGiveUp?: (b: Board, child: Task) => void) {
  const b = await board(name);
  const root = await commitThrough(b, work(b, "living root"), "root.txt");
  const dead = work(b, "dead", { parent_id: root.id });
  const healthy = work(b, "healthy", { parent_id: dead.id });
  const child = await completeThrough(b, work(b, "child", { parent_id: healthy.id }), "child.txt");
  await completeThrough(b, healthy, "healthy.txt");
  const place = await pickUp(b, dead);
  commitWork(place.path, "dead.txt", "dead\n");
  completeTask(b.db, getTask(b.db, dead.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  releaseWorkspace(b.db, place, getTask(b.db, dead.id)!, b.clock.now());
  completeTask(b.db, getTask(b.db, root.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  beforeGiveUp?.(b, child);
  await giveUp(b, dead.id);
  return { b, root, dead, healthy: getTask(b.db, healthy.id)!, child };
}

it("死んだ祖先を数える task は、間に無事な祖先を挟んでも帰り先なしで、着地の根でも着地を待つ完了タスクでもなく、着地の状態も記録も持たず、生きている根の積み残しにも数えない(ADR 0380 決定3、spec #3273 group H、pin H9・H14)", async () => {
  const { b, root, healthy, child } = await deadTaskUnderLivingRoot("dead-ancestor-no-return");

  expect(accepted(b)).toBe(true);
  for (const task of [healthy, child]) {
    expect(lineageOf(b, task)).toEqual(NO_RETURN);
    expect(landingState(b.db, getTask(b.db, task.id)!)).toBeNull();
    expect(taskBranchLostInForce(b.db, task.id)).toBeUndefined();
  }
  expect(taskIdsAwaitingLandingInWorkspace(b.db, () => b.ws, b.ws.name)).toEqual([root.id]);
  expect(contentLeftBehindLocally(b.db, b.ws, root.id, `task/${root.id}`)).toEqual([]);
});

it("透明か死んだかは失われた時点の記録で決まる —— 失われた後に生きている根が着地しても、死んだ task は死んだまま(ADR 0380 決定1 Status 追記、ADR 0375 決定6、#3297)", async () => {
  const { b, root, healthy, child } = await deadTaskUnderLivingRoot("dead-ancestor-root-lands-later");

  appendEvent(b.db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "landing_finished", pr_number: 1, basis: "merge" }, at: b.clock.now() });

  for (const task of [healthy, child]) expect(lineageOf(b, task)).toEqual(NO_RETURN);
});

/** 帰り先なしの `child` の下に、give-up の前に別の workspace に固定された未着手の子孫を置く。 */
function elsewhereUnder(b: Board, child: Task): void {
  const elsewhere = work(b, "elsewhere", { parent_id: child.id });
  fillEmptyWorkspace(b.db, elsewhere.id, "elsewhere");
}
const titled = (b: Board, title: string) => b.db.prepare("SELECT id FROM tasks WHERE title = ?").pluck().get(title) as string;

it("別の workspace に固定された子孫は死んだ祖先を数えず、倒されない(ADR 0372 決定4、ADR 0380 決定2、pin H9)", async () => {
  const { b } = await deadTaskUnderLivingRoot("dead-ancestor-other-workspace", elsewhereUnder);
  const elsewhere = getTask(b.db, titled(b, "elsewhere"))!;

  expect(resolveTaskBranchLineage(b.db, { ...b.ws, name: "elsewhere" }, elsewhere, () => b.clock.now())).toEqual({ branch: undefined, outlivedForkSource: false });
  expect(elsewhere.status).toBe("todo");
});

it("登録の床は親の系譜で問い、子が親と違う workspace を明示すれば子の系譜でも問う —— 無事な親の下でも死んだ祖先の workspace を明示した子は拒み、帰り先の無い親の下の別 workspace の子も拒み、列が空の task は導出で読む(ADR 0380 決定5、ADR 0301 決定7、pin H9・H15)", async () => {
  const { b, dead, healthy, child } = await deadTaskUnderLivingRoot("dead-ancestor-floor", elsewhereUnder);
  const elsewhere = titled(b, "elsewhere");
  const refusal = `no work task grows here: the work of "dead" (${dead.id}) was lost with its task branch`;

  expect(whyNoReturnDestination(b.db, elsewhere)).toBeUndefined();
  expect(humanTask(b, { type: "work", title: "stays elsewhere", parent_id: elsewhere }).status).toBe("todo");
  expect(() => humanTask(b, { type: "work", title: "names the dead's workspace", parent_id: elsewhere, workspace: b.ws.name })).toThrow(refusal);
  expect(() => humanTask(b, { type: "work", title: "names another workspace", parent_id: child.id, workspace: "elsewhere" })).toThrow(refusal);
  // healthy の列は pickup の固定が埋め(ADR 0372 決定3)、その下の子は列が空のまま導出で healthy の workspace を読む(ADR 0372 決定1)
  expect(getTask(b.db, healthy.id)!.workspace).toBe(b.ws.name);
  expect(() => humanTask(b, { type: "work", title: "empty column", parent_id: healthy.id })).toThrow(refusal);
});

it("agent の分解の床は、子が明示した別の workspace の系譜でも承認 question に包む前に問う —— 死んだ祖先の workspace を明示した子は question にもならずに拒む(ADR 0380 決定5、ADR 0271 決定2、ADR 0301 決定3)", async () => {
  const { b, dead } = await deadTaskUnderLivingRoot("dead-ancestor-decompose", elsewhereUnder);
  const parent = getTask(b.db, titled(b, "elsewhere"))!;
  const child = { title: "names the dead's workspace", purpose: "p", completion_criteria: "c", workspace: b.ws.name };
  const authority = { name: "standard", guidance: "", allowed_workspaces: ["elsewhere"] };

  expect(() => decomposeTaskViaWorker(b.db, parent, { reason: "split", children: [child] }, "deckhand", b.clock.now(), { authority })).toThrow(
    `no work task grows here: the work of "dead" (${dead.id}) was lost with its task branch`,
  );
  expect(listChildren(b.db, parent.id)).toEqual([]);
});

it("give-up は人間の値で残る done の子の失われたブランチを keep-around へ移して消し、merge back の数え直しは帰り先へ運ばない(ADR 0380 決定3、ADR 0392 決定1)", async () => {
  const b = await board("lost-child-moved");
  const parent = await commitThrough(b, work(b, "parent"), "parent.txt");
  const child = work(b, "child", { parent_id: parent.id });
  const place = await pickUp(b, child);
  commitWork(place.path, "child.txt", "child\n");
  recordTaskCheckoutTip(b.db, place, child.id);
  completeTask(b.db, getTask(b.db, child.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  // merge back は届いていない
  releaseWorkspace(b.db, place, getTask(b.db, child.id)!, b.clock.now());
  const parentTip = git(b.ws.path, "rev-parse", `task/${parent.id}`);
  // 人間が ref を、同じ内容を持つ別の commit へ動かした —— 運べば帰り先が動く
  const moved = git(b.ws.path, "commit-tree", `task/${child.id}^{tree}`, "-p", "main", "-m", "a human moved the lost ref here");
  git(b.ws.path, "update-ref", `refs/heads/task/${child.id}`, moved);

  await giveUp(b);

  expect(accepted(b)).toBe(true);
  expect(taskBranchLostInForce(b.db, child.id)).toBeDefined();
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${child.id}`)).toBe("");
  expect(git(b.ws.path, "rev-parse", `refs/keep-around/${moved}`)).toBe(moved);
  expect(git(b.ws.path, "rev-parse", `task/${parent.id}`)).toBe(parentTip);
});

it("死んだ task に残るレビュー(RCA)は保護ブランチを読み、失われた ref が人間の値で残っていても git で読まない(ADR 0380 決定3、pin H16)", async () => {
  const b = await board("dead-task-review");
  const dead = await completeThrough(b, work(b, "dead"), "dead.txt");
  const review = registerTask(b.db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: dead.id }, b.clock.now(), BOARD_ACTOR_ID, "board");
  // 人間が失われた ref を別の commit へ動かした —— give-up はその値を keep-around へ移して ref を消す(ADR 0392 決定1)
  git(b.ws.path, "update-ref", `refs/heads/task/${dead.id}`, git(b.ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "a human moved the lost ref here"));

  await giveUp(b);

  expect(taskBranchLostInForce(b.db, dead.id)).toBeDefined();
  expect(lineageOf(b, review)).toEqual({ branch: undefined, outlivedForkSource: false });
});

/** 根 R の下に、編集のあった done の D と、その子 C(ブランチが残る)。R の記録 `kind` は D の完了の `after` に刻む。D に人間登録の review 子を
 *  付け、D のブランチを失わせて give-up で答える。C の系譜と、D の review の status を返す。 */
async function lostUnderRootRecord(name: string, record: TaskScopedPayload, after: boolean, holder: "root" | "self" = "root") {
  const b = await seededBoard(name);
  const root = work(b, "root");
  const dead = work(b, "lost", { parent_id: root.id });
  const child = work(b, "child", { parent_id: dead.id });
  const main = git(b.ws.path, "rev-parse", "main");
  seedThroughBoard(b, root.id, main);
  seedThroughBoard(b, dead.id, main);
  const ref = `refs/heads/task/${dead.id}`;
  const edited = git(b.ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "edited");
  boardRefWriter(b.db, b.ws)(ref, edited, () => git(b.ws.path, "update-ref", ref, edited));
  seedThroughBoard(b, child.id, main);
  const landed = () => appendEvent(b.db, { taskId: holder === "root" ? root.id : dead.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: record, at: b.clock.now() });
  completeTask(b.db, child, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  if (!after) landed();
  completeTask(b.db, getTask(b.db, dead.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  if (after) landed();
  completeTask(b.db, getTask(b.db, root.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  const review = humanTask(b, { type: "review", title: "review", parent_id: dead.id });
  await giveUp(b, dead.id);
  return { lineage: lineageOf(b, child), review: statusOf(b, review) };
}

const REACHED: TaskScopedPayload[] = [
  { kind: "local_merge_executed", sha: "0".repeat(40) },
  { kind: "pr_merged", pr_number: 1 },
  { kind: "pr_merge_observed", pr_number: 1 },
  { kind: "landing_finished", pr_number: 1, basis: "merge" },
];
const NOT_REACHED: TaskScopedPayload[] = [{ kind: "nothing_to_land", base: "0".repeat(40) }, { kind: "pr_close_observed", pr_number: 1 }];

it.each(REACHED)("数える祖先が完了の後に `$kind` を持てば、編集のあった失われた task は透明 —— 子は保護ブランチへ帰り、レビューは残る(ADR 0380 決定1、pin H12)", async (record) => {
  expect(await lostUnderRootRecord(`landed-${record.kind}`, record, true)).toEqual({ lineage: { branch: undefined, outlivedForkSource: false }, review: "todo" });
});

it.each(NOT_REACHED)("`$kind` は保護ブランチに届いた記録に数えない —— 編集のあった失われた task は死んで、子は帰り先なし、レビューは倒れる(spec #3273 group H)", async (record) => {
  expect(await lostUnderRootRecord(`not-landed-${record.kind}`, record, true)).toEqual({ lineage: NO_RETURN, review: "cancelled" });
});

it("失われた task 自身が完了の後に保護ブランチに届いた記録を持てば透明(ADR 0380 決定1、pin H12)", async () => {
  expect(await lostUnderRootRecord("landed-self", REACHED[0]!, true, "self")).toEqual({ lineage: { branch: undefined, outlivedForkSource: false }, review: "todo" });
});

it("完了の前の着地の記録では透明にならない(ADR 0380 決定1、pin H12)", async () => {
  expect(await lostUnderRootRecord("landed-before-completion", REACHED[3]!, false)).toEqual({ lineage: NO_RETURN, review: "cancelled" });
});

it("`task_branch_created` が作成時の sha を持たないブランチは、失われた sha と比べず編集があった側に数える(ADR 0375 決定2、pin H4)", async () => {
  const b = await seededBoard("created-without-sha");
  const parent = work(b, "parent");
  const child = work(b, "child", { parent_id: parent.id });
  const main = git(b.ws.path, "rev-parse", "main");
  const lost = git(b.ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "only on the parent's branch");
  const ref = `refs/heads/task/${parent.id}`;
  boardRefWriter(b.db, b.ws)(ref, lost, () => git(b.ws.path, "update-ref", ref, lost));
  fillEmptyWorkspace(b.db, parent.id, b.ws.name);
  // この event の実装の前に作られたブランチの記録 —— sha を持たない
  appendEvent(b.db, { taskId: parent.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_branch_created", workspace: b.ws.name } as TaskScopedPayload, at: b.clock.now() });
  seedThroughBoard(b, child.id, main);
  completeTask(b.db, child, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  completeTask(b.db, getTask(b.db, parent.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");

  await giveUp(b, parent.id);

  expect(lineageOf(b, child)).toEqual(NO_RETURN);
});

it("未決着の親のブランチが失われ done の子のブランチが残る: 子の merge back は飛ばされて届かないまま、pickup が親を作り直すと帰り先が戻り、作り直した後に完了した親は死んだに数えない(spec #3273 group H、pin H7・H8)", async () => {
  const b = await board("lost-parent-unsettled");
  const parent = work(b, "parent");
  const child = await completeThrough(b, work(b, "child", { parent_id: parent.id }), "child.txt");
  await commitThrough(b, parent, "parent.txt");

  await giveUp(b, parent.id);

  expect(accepted(b)).toBe(true);
  expect(lineageOf(b, child)).toEqual(NO_RETURN);
  await completeThrough(b, parent, "again.txt");
  expect(whyNoReturnDestination(b.db, parent.id)).toBeUndefined();
  expect(lineageOf(b, child).branch).toBe(`task/${parent.id}`);
  expect(lineageOf(b, work(b, "later child", { parent_id: parent.id }))).toEqual({ branch: `task/${parent.id}`, outlivedForkSource: false });
});

it("pickup の固定は、失われた event が効いている未決着の祖先をタスクブランチを持たないと読んで作り直し、workspace の Edit の凍結は前の `task_branch_created` で効いたまま(ADR 0372 決定3・5、spec #3273 group H)", async () => {
  const b = await board("lost-ancestor-refixed");
  // 親は拾われず、最初の子の pickup の固定だけがブランチを作った —— 凍結を効かせるのは `task_branch_created` だけ
  const parent = work(b, "parent");
  const first = await completeThrough(b, work(b, "first child", { parent_id: parent.id }), "first.txt");
  await giveUp(b, parent.id, first.id);
  expect(taskBranchLostInForce(b.db, parent.id)).toBeDefined();
  expect(() => editTask(b.db, getTask(b.db, parent.id)!, { workspace: "elsewhere" }, b.clock.now(), "webui")).toThrow(/has a task branch keeps its workspace/);

  const child = await commitThrough(b, work(b, "child", { parent_id: parent.id }), "child.txt");

  expect(taskBranchLostInForce(b.db, parent.id)).toBeUndefined();
  expect(lineageOf(b, child).branch).toBe(`task/${parent.id}`);
  expect(git(b.ws.path, "rev-parse", `task/${child.id}^`)).toBe(git(b.ws.path, "rev-parse", `task/${parent.id}`));
});

/** 親 P の下の子 C が完了したが merge back は届いておらず、その後 P が自分の commit を積んだ(`parentDone` なら完了もした)。P のブランチを
 *  失わせて give-up で答えた盤面。 */
async function lostParentOverUndeliveredChild(name: string, parentDone: boolean) {
  const b = await board(name);
  const parent = work(b, "parent");
  const child = await completeUndelivered(b, work(b, "child", { parent_id: parent.id }), "child.txt");
  const childTip = git(b.ws.path, "rev-parse", `task/${child.id}`);
  if (parentDone) await completeThrough(b, parent, "parent.txt");
  else await commitThrough(b, parent, "parent.txt");
  await giveUp(b, parent.id);
  return { b, parent, child, childTip };
}

/** 次の workspace の Quarantine の受理(`repaired by hand`)—— 届いていない merge back をやり直す。 */
function answerRepairedByHand(b: Board) {
  quarantineWorkspace(b.db, b.ws.name, new Error("look again"), b.clock.now());
  return answerQuarantine(b, "repaired by hand");
}

const isAncestor = (b: Board, ancestor: string, of: string) => {
  try {
    git(b.ws.path, "merge-base", "--is-ancestor", ancestor, of);
    return true;
  } catch {
    return false;
  }
};

it("死んだ done の親の下で merge back が届いていなかった子は、受理の数え直しで飛ばされて運ばれず、生の git のエラーにならない(ADR 0380 決定3、pin H7・H9)", async () => {
  const { b, parent, child, childTip } = await lostParentOverUndeliveredChild("dead-parent-undelivered-child", true);

  expect(accepted(b)).toBe(true);
  expect(lineageOf(b, child)).toEqual(NO_RETURN);
  expect(git(b.ws.path, "rev-parse", `task/${child.id}`)).toBe(childTip);
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${parent.id}`)).toBe("");
});

it("未決着の親のブランチが失われ、merge back が届いていなかった子は飛ばされて届かないまま —— pickup が親を作り直した後の受理が運ぶ(spec #3273 group H、pin H7)", async () => {
  const { b, parent, child, childTip } = await lostParentOverUndeliveredChild("unsettled-parent-undelivered-child", false);

  expect(accepted(b)).toBe(true);
  expect(lineageOf(b, child)).toEqual(NO_RETURN);
  expect(git(b.ws.path, "rev-parse", `task/${child.id}`)).toBe(childTip);

  await commitThrough(b, parent, "again.txt");
  expect(isAncestor(b, childTip, `task/${parent.id}`)).toBe(false);
  await answerRepairedByHand(b);

  expect(accepted(b)).toBe(true);
  expect(isAncestor(b, childTip, `task/${parent.id}`)).toBe(true);
});

it("帰り先なしの task は閉じた根に塞がれた子と読まない —— 失われた ref が人間の値で残っていても git で辿らない(ADR 0380 決定3、spec #3273 group H)", async () => {
  const b = await board("no-return-not-closed-root");
  const root = await commitThrough(b, work(b, "root"), "root.txt");
  const dead = work(b, "dead", { parent_id: root.id });
  const child = await completeThrough(b, work(b, "child", { parent_id: dead.id }), "child.txt");
  await completeUndelivered(b, dead, "dead.txt");
  completeTask(b.db, getTask(b.db, root.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  appendEvent(b.db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number: 1 }, at: b.clock.now() });
  // 人間が失われる ref を、同じ内容を持つ別の commit へ動かした —— git で辿れば根の閉じた PR に行き着く
  const ref = `refs/heads/task/${dead.id}`;
  git(b.ws.path, "update-ref", ref, git(b.ws.path, "commit-tree", `${ref}^{tree}`, "-p", `task/${root.id}`, "-m", "a human moved the lost ref here"));

  await giveUp(b);

  expect(taskBranchLostInForce(b.db, dead.id)).toBeDefined();
  expect(blockingRootOf(b.db, () => b.ws)(getTask(b.db, child.id)!)).toBeNull();
});

const doorDeps = (b: Board) => ({ db: b.db, pollNow: () => {}, workspace: b.ws, workspacesDir: b.base });

it("失われた event が効いている H の取り込みと完了は `start_work` を案内して拒み、何も書かない —— `start_work` がブランチを作り直す(spec #3273 group H、pin C21)", async () => {
  const b = await board("lost-human-work");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const at = () => b.clock.now();
  await startWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui");
  commitWork(realpathSync(workbenchPath(b.base, { task: h.id })), "mine.txt", "mine\n");
  expect((await takeInWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui")).ok).toBe(true);
  await giveUp(b, h.id);
  const before = listEvents(b.db, h.id).length;

  for (const [verb, result] of [
    ["take in", await takeInWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui")],
    ["complete", await completeThroughHumanDoor(doorDeps(b), h.id, { handoff: FULL_HANDOFF }, at, "webui")],
  ] as const) {
    expect(result).toEqual({ ok: false, failure: { kind: "domain_error", error: expect.stringContaining("run start_work") } });
    expect(result.ok || result.failure.error).toContain(verb);
  }
  expect(getTask(b.db, h.id)!.status).toBe("todo");
  expect(listEvents(b.db, h.id)).toHaveLength(before);
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${h.id}`)).toBe("");

  // 名前の場所の gc は作業台が借りていた object(取り込みの包む commit)も消した —— 開き直しは disk に無い作業台から(spec の範囲外)
  rmSync(workbenchPath(b.base, { task: h.id }), { recursive: true, force: true });
  expect(await startWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui")).toMatchObject({ ok: true });
  expect(taskBranchLostInForce(b.db, h.id)).toBeUndefined();
  expect(git(b.ws.path, "rev-parse", `task/${h.id}`)).toBe(git(b.ws.path, "rev-parse", "main"));
});

/** H の取り込みと完了を順に呼び、拒否を返す —— どちらも名前の場所の ref と H の event を書かない。 */
async function refusedHumanDoors(b: Board, h: Task) {
  const at = () => b.clock.now();
  const before = [git(b.ws.path, "for-each-ref"), listEvents(b.db, h.id).length];
  const results = [
    ["take in", await takeInWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui")],
    ["complete", await completeThroughHumanDoor(doorDeps(b), h.id, { handoff: FULL_HANDOFF }, at, "webui")],
  ] as const;
  expect([git(b.ws.path, "for-each-ref"), listEvents(b.db, h.id).length]).toEqual(before);
  return results;
}

/** 人間担当の子 H を書き始め、作業台で commit する。 */
async function startedHuman(b: Board, parent: Task): Promise<Task> {
  const h = work(b, "write it myself", { parent_id: parent.id, assignee: HUMAN_ACTOR_ID });
  await startWorkThroughHumanDoor(doorDeps(b), h.id, () => b.clock.now(), "webui");
  commitWork(realpathSync(workbenchPath(b.base, { task: h.id })), "mine.txt", "mine\n");
  return h;
}

it("帰り先の未決着の親のブランチが失われた H の取り込みと完了は、保護ブランチを帰り先と読まず `start_work` を案内して拒む(ADR 0380 決定3、spec #3273 group H)", async () => {
  const b = await board("lost-human-return");
  const parent = work(b, "parent");
  const h = await startedHuman(b, parent);
  await commitThrough(b, parent, "parent.txt");
  await giveUp(b, parent.id);

  for (const [verb, result] of await refusedHumanDoors(b, h)) {
    expect(result).toEqual({
      ok: false,
      failure: { kind: "domain_error", error: `cannot ${verb}: task/${parent.id}, the branch this task returns into, was lost when the lost refs were given up — run start_work to create it again, then ${verb} again.` },
    });
  }
});

it("帰り先の done の親が死んだ H は give-up が work の修理子として倒し、取り込みと完了は決着した task として拒む —— 固定は決着した祖先を作り直さない(ADR 0372 決定3、ADR 0375 決定4、ADR 0380 決定2)", async () => {
  const b = await board("dead-human-return");
  const parent = await completeThrough(b, work(b, "parent"), "parent.txt");
  const h = await startedHuman(b, parent);
  // H が切られた後に親のブランチが進んだ —— その tip は H から届かず、失われると親は死ぬ
  const ref = `refs/heads/task/${parent.id}`;
  const edited = git(b.ws.path, "commit-tree", `${ref}^{tree}`, "-p", ref, "-m", "after the child forked");
  boardRefWriter(b.db, b.ws)(ref, edited, () => git(b.ws.path, "update-ref", ref, edited));
  await giveUp(b, parent.id);

  expect(statusOf(b, h)).toBe("cancelled");
  for (const [, result] of await refusedHumanDoors(b, h)) {
    expect(result).toEqual({ ok: false, failure: { kind: "domain_error", error: expect.stringMatching(/^a settled task cannot be /) } });
  }
});

const statusOf = (b: Board, task: Task) => getTask(b.db, task.id)!.status;
const humanTask = (b: Board, input: Omit<RegisterTaskInput, "purpose" | "completion_criteria">) =>
  registerTask(b.db, { purpose: "p", completion_criteria: "c", ...input }, b.clock.now(), ...HUMAN_WEBUI);
const reviewOf = (b: Board, task: Task) => listChildren(b.db, task.id).find((child) => child.type === "review")!;

it("give-up は死んだ task と、死んだ祖先を系譜に数える task に付いた未決着の完了時レビュー・人間登録の review 子・work の修理子を倒し、RCA と記憶・routing の修理子は残して、残る RCA の下の work も倒す —— 以後その下に work と work の修理子は立たない(ADR 0375 決定4、ADR 0380 決定2、pin H2)", async () => {
  const b = await board("dead-task-felling");
  const dead = work(b, "dead");
  const healthy = await completeThrough(b, work(b, "healthy", { parent_id: dead.id, review_flag: true }), "healthy.txt", false);
  await completeThrough(b, dead, "dead.txt", false);
  const completionReviews = [reviewOf(b, dead), reviewOf(b, healthy)];
  const humanReview = humanTask(b, { type: "review", title: "human review", parent_id: dead.id });
  const repair = humanTask(b, { type: "work", title: "work repair", parent_id: healthy.id });
  const repairChild = humanTask(b, { type: "work", title: "the repair's child", parent_id: repair.id });
  const rca = humanTask(b, { type: "review", title: "rca", parent_id: dead.id, opened_on_event_ids: [listEvents(b.db, dead.id)[0]!.id] });
  const underRca = humanTask(b, { type: "work", title: "the RCA's work", parent_id: rca.id });
  const memoryRepair = humanTask(b, { type: "memory_repair", title: "memory repair", parent_id: dead.id });
  const routingRepair = humanTask(b, { type: "routing_repair", title: "routing repair", parent_id: dead.id });

  await giveUp(b, dead.id);

  expect(accepted(b)).toBe(true);
  expect([...completionReviews, humanReview, repair, repairChild, underRca].map((task) => statusOf(b, task))).toEqual(Array(6).fill("cancelled"));
  // 倒すものが入れ子でも(修理子とその子)、cancel の event は task ごとに1件
  expect(listEventsOfKinds(b.db, ["task_cancelled"]).filter(({ task_id }) => task_id === repair.id || task_id === repairChild.id)).toHaveLength(2);
  expect([rca, memoryRepair, routingRepair].map((task) => statusOf(b, task))).toEqual(["todo", "todo", "todo"]);
  for (const parent of [dead, healthy, rca]) {
    expect(() => humanTask(b, { type: "work", title: "another repair", parent_id: parent.id })).toThrow(`no work task grows here: the work of "dead" (${dead.id}) was lost with its task branch`);
  }
});

const landingFor = (b: Board) => createLanding({ defaultAgentName: "deckhand", db: b.db, clock: b.clock, workspace: b.ws, github: null });
const answer = (b: Board, questionId: string, option: string) =>
  submitAnswer({ db: b.db, pollNow: () => {}, landing: unusedLanding, workspace: b.ws, workspacesDir: b.base }, getTask(b.db, questionId)!, [option], undefined, () => b.clock.now(), "webui");
/** 盤面に見える、根を名指す開いた着地の question(local 着地・昇格失敗・merge)。 */
const openLandingQuestions = (b: Board, root: Task) =>
  listBoard(b.db)
    .filter(
      (q) =>
        q.status === "todo" &&
        (q.question_pending_local_merge_task_id === root.id || q.question_pending_pr_promotion_task_id === root.id || q.question_pending_merge_task_id === root.id),
    )
    .map(({ id }) => id);
/** 観測で閉じた question の印(ADR 0265 決定7)—— give-up が閉じた着地の question は「ブランチが失われた」と読まれる(#3490)。 */
const settledMarks = (b: Board, ids: string[]) => ids.map((id) => settledByObservation(b.db, getTask(b.db, id)!));
const closedByLostBranch = (ids: string[]) => ids.map(() => "task_branch_lost_observed");

/** 着地がどこまで進んでいたか —— どの形でも、死んだ根の着地は give-up で終わる。 */
const LANDING_SO_FAR: Array<[string, (b: Board, root: Task) => Promise<void>]> = [
  ["着地の前", async () => {}],
  ["local 着地の question が開いている", async (b) => void (await landingFor(b).converge())],
  [
    "hold 済み",
    async (b, root) => {
      await landingFor(b).converge();
      await answer(b, openLandingQuestions(b, root)[0]!, "hold");
    },
  ],
  ["昇格失敗の question が開いている", async (b, root) => registerPrPromotionFailureQuestion(b.db, root, "gh failed", b.clock.now())],
  [
    "断念済み",
    async (b, root) => {
      registerPrPromotionFailureQuestion(b.db, root, "gh failed", b.clock.now());
      await answer(b, openLandingQuestions(b, root)[0]!, "abandon promotion");
    },
  ],
];

it.each(LANDING_SO_FAR)("PR の無い死んだ根の着地は give-up で終わる(%s)—— 開いた着地の question はブランチが失われたので閉じたと読まれ、着地を待たず、削除の扉を塞がず、後の収束も問い直さず、行は `branch_lost` を出す(ADR 0407 決定1・2、#3490)", async (_, before) => {
  const b = await board("dead-root-landing-ends");
  const root = await completeThrough(b, work(b, "root"), "root.txt");
  await before(b, root);
  const open = openLandingQuestions(b, root);

  await giveUp(b, root.id);

  expect(accepted(b)).toBe(true);
  expect(openLandingQuestions(b, root)).toEqual([]);
  expect(settledMarks(b, open)).toEqual(closedByLostBranch(open));
  expect(landingState(b.db, getTask(b.db, root.id)!)).toBe("branch_lost");
  expect(taskIdsAwaitingLandingInWorkspace(b.db, () => b.ws, b.ws.name)).toEqual([]);
  expect(countUnsettledTasksReferencing(b.db, "workspace", b.ws.name)).toBe(0);
  expect((await landingFor(b).converge()).map(({ taskId }) => taskId)).not.toContain(root.id);
  expect(openLandingQuestions(b, root)).toEqual([]);
});

it("handoff だけの根(失われた sha = 作成時の sha)はレビューを残し、着地は終わりの記録なしに終わり、開いた着地の question は閉じ、行は何も出さない(ADR 0407 決定1・4、ADR 0380 決定1、pin H4)", async () => {
  const b = await seededBoard("handoff-only-root");
  const root = work(b, "root");
  seedThroughBoard(b, root.id, git(b.ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "created here, never edited"));
  completeTask(b.db, root, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  const review = humanTask(b, { type: "review", title: "human review", parent_id: root.id });
  registerLocalMergeQuestion(b.db, getTask(b.db, root.id)!, "land it?", b.clock.now());
  registerPrPromotionFailureQuestion(b.db, getTask(b.db, root.id)!, "gh failed", b.clock.now());
  const open = openLandingQuestions(b, root);

  await giveUp(b, root.id);

  expect(accepted(b)).toBe(true);
  expect(statusOf(b, review)).toBe("todo");
  expect(listEventsOfKinds(b.db, ["nothing_to_land"])).toEqual([]);
  expect(settledMarks(b, open)).toEqual(closedByLostBranch(open));
  expect(landingState(b.db, getTask(b.db, root.id)!)).toBeNull();
  expect(taskIdsAwaitingLandingInWorkspace(b.db, () => b.ws, b.ws.name)).toEqual([]);
});

/** PR を開いた done の根 —— `merge` が `escalate` なら merge question が立ち、`auto_if_ci_green` なら無人 merge キューに入る。 */
async function prRoot(b: Board, title: string, merge: "escalate" | "auto_if_ci_green", prNumber: number): Promise<Task> {
  const root = await completeThrough(b, work(b, title), `${title}.txt`);
  recordPrOpened(b.db, root, prNumber, git(b.ws.path, "rev-parse", `task/${root.id}`), b.clock.now(), { merge }, false);
  return getTask(b.db, root.id)!;
}

it("give-up は失われた PR の根の merge question・昇格失敗の question・local 着地の question を閉じ、無人 merge キューから外す —— どれもブランチが失われたので閉じたと読まれ、行は `branch_lost` を出し、PR は GitHub に残す(ADR 0407 決定2・3、#3490)", async () => {
  const b = await board("lost-pr-roots");
  const asked = await prRoot(b, "asked", "escalate", 1);
  registerPrPromotionFailureQuestion(b.db, asked, "gh failed", b.clock.now());
  registerLocalMergeQuestion(b.db, asked, "land it?", b.clock.now());
  const queued = await prRoot(b, "queued", "auto_if_ci_green", 2);
  const open = openLandingQuestions(b, asked);
  expect(open).toHaveLength(3);
  expect([asked, queued].map((root) => landingState(b.db, root))).toEqual(["merge_question", "auto_merge_queue"]);

  await giveUp(b, asked.id, queued.id);

  expect(accepted(b)).toBe(true);
  expect(openLandingQuestions(b, asked)).toEqual([]);
  expect(settledMarks(b, open)).toEqual(closedByLostBranch(open));
  expect([asked, queued].map((root) => landingState(b.db, getTask(b.db, root.id)!))).toEqual(["branch_lost", "branch_lost"]);
  expect([asked, queued].map((root) => getTask(b.db, root.id)!.pr_number)).toEqual([1, 2]);
  expect(taskIdsAwaitingLandingInWorkspace(b.db, () => b.ws, b.ws.name)).toEqual([]);
  expect(countUnsettledTasksReferencing(b.db, "workspace", b.ws.name)).toBe(0);
});

it("workspace の削除の扉は、失われた PR の根を着地し直す根に数えず、その下の別の workspace の未決着の子孫で塞がない(ADR 0407 決定1、ADR 0234 決定1)", async () => {
  const b = await board("lost-pr-root-delete-door");
  const root = await prRoot(b, "asked", "escalate", 1);
  const elsewhere = work(b, "elsewhere", { parent_id: root.id });
  fillEmptyWorkspace(b.db, elsewhere.id, "elsewhere");

  await giveUp(b, root.id);

  expect(statusOf(b, elsewhere)).toBe("todo");
  expect(countUnsettledTasksReferencing(b.db, "workspace", b.ws.name)).toBe(0);
});

it("盤面が失われる task に執行の印を持つ間の give-up は、何も書かずに `prInFlightRefusal` の形で拒み、Quarantine は開いたまま —— 印が放れた後の give-up は通る(ADR 0407 決定2、ADR 0399 決定6)", async () => {
  const b = await board("lost-root-marked");
  const root = await prRoot(b, "asked", "escalate", 1);
  const open = openLandingQuestions(b, root);
  const landing = landingFor(b);
  const release = landing.takeInFlightMark(root.id)!;
  const giveUpWith = () =>
    submitAnswer(
      { db: b.db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db: b.db, workspace: b.ws, workspacesDir: b.base, landing }) },
      quarantineQuestion(b.db, "workspace", b.ws.name)!,
      [GIVE_UP],
      undefined,
      () => b.clock.now(),
      "webui",
    );
  git(b.ws.path, "update-ref", "-d", `refs/heads/task/${root.id}`);
  git(b.ws.path, "reflog", "expire", "--expire=now", "--all");
  git(b.ws.path, "gc", "--quiet", "--prune=now");
  quarantineWorkspace(b.db, b.ws.name, new Error("a human deleted task branches"), b.clock.now());

  const refused = giveUpWith();
  await expect(refused).rejects.toThrow(DomainError);
  await expect(refused).rejects.toThrow(prInFlightRefusal(1));

  expect(accepted(b)).toBe(false);
  expect(lostEvents(b.db)).toEqual([]);
  expect(openLandingQuestions(b, root)).toEqual(open);

  release();
  await giveUpWith();

  expect(accepted(b)).toBe(true);
  expect(openLandingQuestions(b, root)).toEqual([]);
});

/** 子のブランチと同じ出来事で、親のブランチに起きたこと —— どれも object は残り、書き戻しが基準の値へ戻す。 */
const PARENT_INCIDENT: Array<[string, (b: Board, parent: Task) => void]> = [
  ["何も起きない", () => {}],
  ["別の commit へ動いた", (b, parent) => git(b.ws.path, "update-ref", `refs/heads/task/${parent.id}`, "main")],
  ["消えたが戻せる", (b, parent) => git(b.ws.path, "update-ref", "-d", `refs/heads/task/${parent.id}`)],
];

it.each(PARENT_INCIDENT)("親のブランチが残り子のブランチだけが失われたら(親のブランチは%s)、親の着地は止めない —— event は子が持ち、merge back が届かないまま失われた子の行は根でなくても `branch_lost` を出す(ADR 0375 決定6、ADR 0407 帰結、pin H5)", async (_, incident) => {
  const b = await board("lost-child-living-parent");
  const parent = work(b, "parent");
  const child = await completeUndelivered(b, work(b, "child", { parent_id: parent.id }), "child.txt");
  await completeThrough(b, parent, "parent.txt");
  const parentTip = git(b.ws.path, "rev-parse", `task/${parent.id}`);
  const parentReview = humanTask(b, { type: "review", title: "parent's review", parent_id: parent.id });

  await giveUpAfter(b, () => incident(b, parent), child.id);

  expect(accepted(b)).toBe(true);
  expect(git(b.ws.path, "rev-parse", `task/${parent.id}`)).toBe(parentTip);
  expect(lostEvents(b.db).map(({ task_id }) => task_id)).toEqual([child.id]);
  expect(landingState(b.db, getTask(b.db, child.id)!)).toBe("branch_lost");
  expect(statusOf(b, parentReview)).toBe("todo");
  settleReviews(b.db, b.clock.now());
  expect((await landingFor(b).converge()).find(({ taskId }) => taskId === parent.id)?.verdict).toEqual({ kind: "landed", form: "local_merge_question" });
});

it("event・倒したもの・閉じた question は書き戻しと一緒に書かれ、後の段(merge back のやり直しの conflict)で回答が拒まれても残る(ADR 0375 決定9、ADR 0407 決定2、pin H6)", async () => {
  const b = await board("lost-records-survive-refusal");
  // 届いていない子の merge back が親と conflict する —— spec #3273 受理の 11 が拒む
  const parent = work(b, "parent");
  await completeUndelivered(b, work(b, "child", { parent_id: parent.id }), "same.txt");
  const place = await pickUp(b, parent);
  commitWork(place.path, "same.txt", "the parent's\n");
  releaseWorkspace(b.db, place, getTask(b.db, parent.id)!, b.clock.now());
  const dead = await completeThrough(b, work(b, "dead"), "dead.txt");
  await landingFor(b).converge();
  const open = openLandingQuestions(b, dead);
  const review = humanTask(b, { type: "review", title: "human review", parent_id: dead.id });

  await expect(giveUp(b, dead.id)).rejects.toThrow(/does not merge cleanly/);

  expect(accepted(b)).toBe(false);
  expect(lostEvents(b.db).map(({ task_id }) => task_id)).toEqual([dead.id]);
  expect(statusOf(b, review)).toBe("cancelled");
  expect(openLandingQuestions(b, dead)).toEqual([]);
  expect(settledMarks(b, open)).toEqual(closedByLostBranch(open));
});

/** PR の無い死んだ根に `openLanding` で着地の question を開かせ(既定は収束が立てる local 着地の question)、その `task/<id>` を失わせ、
 *  書き戻しが消す人間の ref(`refs/heads/stray`)を足して、`breakWriteBack` で書き戻しを落とした give-up で答える。1回目の give-up の拒否と、
 *  `breakWriteBack` を外す関数を返す。 */
async function giveUpWithFailedWriteBack(
  name: string,
  breakWriteBack: (b: Board) => () => void,
  openLanding: (b: Board, root: Task) => Promise<unknown> | void = (b) => landingFor(b).converge(),
) {
  const b = await board(name);
  const root = await completeThrough(b, work(b, "root"), "root.txt");
  await openLanding(b, root);
  const open = openLandingQuestions(b, root);
  let repair = () => {};
  const refusal = giveUpAfter(
    b,
    () => {
      git(b.ws.path, "update-ref", "refs/heads/stray", "main");
      repair = breakWriteBack(b);
    },
    root.id,
  ).then(
    () => undefined,
    (err: unknown) => err,
  );
  return { b, root, open, refusal: await refusal, repair };
}

/** stray の `.lock` で書き戻しの `update-ref -d` を落とす。 */
const lockStray = (b: Board) => {
  const lock = join(b.ws.path, ".git", "refs", "heads", "stray.lock");
  writeFileSync(lock, "");
  return () => rmSync(lock);
};
/** 書いて畳む前に盤面が落ちる —— give-up の transaction の1値への UPDATE を通すので、2値の行を畳むときだけ落とす。 */
const dropBeforeFold = (b: Board) => dropBoardBeforeFold(b.db, { foldOnly: true });

/** 着地の question を3種類とも開く: PR #1 の merge question(`escalate`)・昇格失敗・local 着地。 */
const openEveryLandingQuestion = (b: Board, root: Task) => {
  recordPrOpened(b.db, root, 1, git(b.ws.path, "rev-parse", `task/${root.id}`), b.clock.now(), { merge: "escalate" }, false);
  registerPrPromotionFailureQuestion(b.db, getTask(b.db, root.id)!, "gh failed", b.clock.now());
  registerLocalMergeQuestion(b.db, getTask(b.db, root.id)!, "land it?", b.clock.now());
};

it.each([
  ["stray の `.lock` で書き戻しが落ちる", "write-back-fails-on-lock", lockStray, "stray.lock"],
  ["書いて畳む前に盤面が落ちる", "write-back-fails-board-drops", dropBeforeFold, "the board dropped"],
] as const)("give-up の書き戻しが落ちても(%s)、失われた event と同じ transaction で閉じた着地の question(merge・昇格失敗・local 着地)はブランチが失われたので閉じたと読まれ、収束は問い直さず、Quarantine は開いたまま次の受理が通る(ADR 0407 決定2)", async (_, name, breakWriteBack, message) => {
  const { b, root, open, refusal, repair } = await giveUpWithFailedWriteBack(name, breakWriteBack, openEveryLandingQuestion);
  expect(String(refusal)).toContain(message);
  expect(accepted(b)).toBe(false);
  expect(taskBranchLostInForce(b.db, root.id)).toBeDefined();
  expect(open).toHaveLength(3);
  expect(openLandingQuestions(b, root)).toEqual([]);
  expect(settledMarks(b, open)).toEqual(closedByLostBranch(open));
  expect((await landingFor(b).converge()).map(({ taskId }) => taskId)).not.toContain(root.id);
  expect(countUnsettledTasksReferencing(b.db, "workspace", b.ws.name)).toBe(0);
  repair();

  await answerQuarantine(b, "restore the baseline");

  expect(accepted(b)).toBe(true);
  expect(landingState(b.db, getTask(b.db, root.id)!)).toBe("branch_lost");
});

it("親が生きている間に失われた死んだ子は、親の local 着地の後も着地の根にならない —— 昇格失敗の question を立てず、着地を待つ完了タスクに数えず、行は `branch_lost` を出す(ADR 0407 決定1、#3492)", async () => {
  const b = await board("dead-child-after-parent-lands");
  const parent = work(b, "parent");
  const child = await completeUndelivered(b, work(b, "child", { parent_id: parent.id }), "child.txt");
  await giveUp(b, child.id);
  expect(accepted(b)).toBe(true);
  await completeThrough(b, parent, "parent.txt");
  await landingFor(b).converge();
  await answer(b, openLandingQuestions(b, getTask(b.db, parent.id)!)[0]!, "merge");

  const verdicts = await landingFor(b).converge();

  expect(verdicts.map(({ taskId }) => taskId)).not.toContain(child.id);
  expect(openLandingQuestions(b, child)).toEqual([]);
  expect(taskIdsAwaitingLandingInWorkspace(b.db, () => b.ws, b.ws.name)).toEqual([]);
  expect(countUnsettledTasksReferencing(b.db, "workspace", b.ws.name)).toBe(0);
  expect(landingState(b.db, getTask(b.db, child.id)!)).toBe("branch_lost");
});

it("review の権限の文の当時版は spawn の時点の失われた event・`task_branch_created` で読む —— 失われる前の spawn は帰り先あり、失われた後は無し、作り直した後はまたあり(ADR 0380 帰結、pin H16)", async () => {
  const b = await board("as-of-spawn");
  const dead = await completeThrough(b, work(b, "dead"), "dead.txt");
  const rca = humanTask(b, { type: "review", title: "rca", parent_id: dead.id, opened_on_event_ids: [listEvents(b.db, dead.id)[0]!.id] });
  const spawn = () => appendEvent(b.db, { taskId: rca.id, actorId: "fugu", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });
  const beforeLost = spawn();
  await giveUp(b, dead.id);
  const afterLost = spawn();
  recordTaskBranchCreated(b.db, dead.id, git(b.ws.path, "rev-parse", "main"), b.ws.name);
  const afterRecreated = spawn();

  expect(whyNoReturnDestination(b.db, rca.id, beforeLost)).toBeUndefined();
  expect(whyNoReturnDestination(b.db, rca.id, afterLost)).toMatch(new RegExp(`^the work of "dead" \\(${dead.id}\\) was lost with its task branch`));
  expect(whyNoReturnDestination(b.db, rca.id, afterRecreated)).toBeUndefined();
});

it("spawn の時点で未決着のまま失われていた祖先は、後で作り直して完了しても、その spawn の当時版では死んだと読まない(ADR 0380 帰結、pin H16)", async () => {
  const b = await board("as-of-unsettled-then-done");
  const parent = work(b, "parent");
  const child = await completeThrough(b, work(b, "child", { parent_id: parent.id }), "child.txt");
  await commitThrough(b, parent, "parent.txt");
  const review = humanTask(b, { type: "review", title: "human review", parent_id: child.id });
  await giveUp(b, parent.id);
  const spawn = appendEvent(b.db, { taskId: review.id, actorId: "fugu", origin: "board", payload: WORKER_SPAWNED, at: b.clock.now() });
  await completeThrough(b, parent, "again.txt");

  expect(whyNoReturnDestination(b.db, review.id, spawn)).toBeUndefined();
});

/** 人間が `task/<id>` を `main` の子へ動かす —— 盤面の tip はどこからも届かなくなり、give-up の gc で失われる。人間の commit を返す。 */
function humanMoves(b: Board, taskId: string): string {
  const human = git(b.ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "a human moved the task branch here");
  git(b.ws.path, "update-ref", `refs/heads/task/${taskId}`, human);
  return human;
}

const createdShas = (b: Board, task: Task) => listEventsOfKinds(b.db, ["task_branch_created"]).filter(({ task_id }) => task_id === task.id).map(({ payload }) => payload.sha);

it("give-up は失われた未決着の root の `task/<id>` を、人間の値で残っていても今の値を keep-around へ移して消し、次の pickup が fork 元から作り直す —— 人間の commit は task の成果に入らない(ADR 0392 決定1)", async () => {
  const b = await board("lost-root-moved");
  const task = await commitThrough(b, work(b, "root"), "root.txt");
  const human = humanMoves(b, task.id);

  const answered = await giveUp(b);

  expect(accepted(b)).toBe(true);
  expect(answered.notice).toContain(`refs/heads/task/${task.id} was ${human}, kept as refs/keep-around/${human}`);
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${task.id}`)).toBe("");
  expect(git(b.ws.path, "rev-parse", `refs/keep-around/${human}`)).toBe(human);

  // 基準の行も消えている —— 残っていれば pickup の比較が無い ref を違反と読む
  const place = await pickUp(b, getTask(b.db, task.id)!);
  const main = git(b.ws.path, "rev-parse", "main");
  expect(createdShas(b, task).at(-1)).toBe(main);
  expect(git(place.path, "rev-parse", "HEAD")).toBe(main);
  expect(taskBranchLostInForce(b.db, task.id)).toBeUndefined();
});

it("親子とも失われ人間が両方の `task/<id>` を動かした未決着の木で、子の pickup の固定は親を fork 元から作り直し、子をその親から切る(ADR 0392 決定1、ADR 0372 決定3)", async () => {
  const b = await board("lost-parent-and-child-moved");
  const parent = await commitThrough(b, work(b, "parent"), "parent.txt");
  const child = await commitThrough(b, work(b, "child", { parent_id: parent.id }), "child.txt");
  const humans = [humanMoves(b, parent.id), humanMoves(b, child.id)];

  await giveUp(b);
  const place = await pickUp(b, getTask(b.db, child.id)!);

  const parentTip = git(b.ws.path, "rev-parse", `task/${parent.id}`);
  expect(parentTip).toBe(git(b.ws.path, "rev-parse", "main"));
  expect(createdShas(b, parent).at(-1)).toBe(parentTip);
  expect(createdShas(b, child).at(-1)).toBe(parentTip);
  expect(git(place.path, "rev-parse", "HEAD")).toBe(parentTip);
  for (const human of humans) expect(git(b.ws.path, "rev-parse", `refs/keep-around/${human}`)).toBe(human);
});

it("人間が動かした失われた `task/<H>` は give-up が keep-around へ移して消し、`start_work` が fork 元から作り直す(ADR 0392 決定1、ADR 0374 決定3)", async () => {
  const b = await board("lost-human-work-moved");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const at = () => b.clock.now();
  await startWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui");
  commitWork(realpathSync(workbenchPath(b.base, { task: h.id })), "mine.txt", "mine\n");
  expect((await takeInWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui")).ok).toBe(true);
  const human = humanMoves(b, h.id);
  await giveUp(b);
  rmSync(workbenchPath(b.base, { task: h.id }), { recursive: true, force: true });

  expect(await startWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui")).toMatchObject({ ok: true });

  const main = git(b.ws.path, "rev-parse", "main");
  expect(git(b.ws.path, "rev-parse", `task/${h.id}`)).toBe(main);
  expect(createdShas(b, h).at(-1)).toBe(main);
  expect(git(b.ws.path, "rev-parse", `refs/keep-around/${human}`)).toBe(human);
});

it("名前の場所で人間が失われた `task/<id>` を checkout したままの give-up は、HEAD を基準へ戻してから ref を消す(ADR 0392 決定1、ADR 0373 決定4)", async () => {
  const b = await board("lost-ref-checked-out");
  const task = await commitThrough(b, work(b, "root"), "root.txt");
  humanMoves(b, task.id);
  git(b.ws.path, "checkout", "--quiet", `task/${task.id}`);

  await giveUp(b);

  expect(accepted(b)).toBe(true);
  expect(git(b.ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${task.id}`)).toBe("");
});

const keptEvents = (db: Db) => listEventsOfKinds(db, ["task_checkout_kept"]).map(({ task_id, payload }) => ({ task_id, payload }));

it("開きの後に失われた event が刻まれた task の解放済みの checkout は、作り直された後に解放されても、解放の直後でも受理でも消えず、残したことを1回だけ刻む(ADR 0393 決定1・3)", async () => {
  const b = await board("lost-after-open-kept");
  const task = work(b, "task");
  const place = await pickUp(b, task);
  commitWork(place.path, "task.txt", "task\n");
  const sha = git(b.ws.path, "rev-parse", `task/${task.id}`);
  appendEvent(b.db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_branch_lost", sha }, at: b.clock.now() });
  // 子の pickup の固定が作り直した —— 失われた event はもう効かない
  recordTaskBranchCreated(b.db, task.id, sha, b.ws.name);

  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now());
  removeReleasedTaskCheckoutsOn(b.db, b.ws.name, b.ws.name, b.clock.now());

  expect(listEventsOfKinds(b.db, ["task_checkout_released"])).toHaveLength(1);
  expect(existsSync(place.path)).toBe(true);
  expect(keptEvents(b.db)).toEqual([{ task_id: task.id, payload: { kind: "task_checkout_kept", path: place.path } }]);
});

/** #3533 の S2・S3: 盤面の経路で拾って commit し、門が tip を記録した後(`completed` なら完了も)、解放の前に人間が `task/<id>` を `main` の子へ
 *  動かす —— 解放の比較が Quarantine して解放待ちになり、盤面の tip は checkout にだけ残る(give-up の gc で名前の場所から失われる)。
 *  `earlierVersion` は門が tip を記録すると開きが言わない旧版の完了。 */
async function movedBeforeRelease(b: Board, task: Task, completed: boolean, earlierVersion = false) {
  const place = await pickUp(b, task);
  if (earlierVersion) appendEvent(b.db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_opened", path: place.path }, at: b.clock.now() });
  commitWork(place.path, "task.txt", "task\n");
  const tip = recordTaskCheckoutTip(b.db, place, task.id);
  if (completed) {
    completeTask(b.db, getTask(b.db, task.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
    settleReviews(b.db, b.clock.now());
  }
  const human = humanMoves(b, task.id);
  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now(), completed, undefined, undefined, completed);
  expect(accepted(b)).toBe(false);
  return { place, tip, human };
}

const kindsOf = (b: Board, task: Task) => listEvents(b.db, task.id).map(({ kind }) => kind);
const openQuestionOf = (b: Board, task: Task) => listChildren(b.db, task.id).find((child) => child.type === "question" && child.status === "todo");

it.each([["門が tip を記録した完了", false], ["旧版の完了", true]] as const)("S2(%s): 解放の前に人間が `task/<id>` を動かし盤面の tip が checkout にだけ残る完了済みの task で、give-up の回答は通り、`task/<id>` を書かず checkout を残して在り処を1回だけ告げる(ADR 0393 決定2・3、ADR 0392 決定3)", async (_, earlierVersion) => {
  const b = await board("s2-completed");
  const task = work(b, "root");
  const { place, tip, human } = await movedBeforeRelease(b, task, true, earlierVersion);

  const answered = await giveUp(b);

  expect(accepted(b)).toBe(true);
  expect(kindsOf(b, task)).toEqual(expect.arrayContaining(["task_branch_lost", "task_checkout_release_failed", "task_checkout_kept"]));
  expect(kindsOf(b, task)).not.toContain("task_checkout_written_after_completion");
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${task.id}`)).toBe("");
  expect(git(b.ws.path, "rev-parse", `refs/keep-around/${human}`)).toBe(human);
  expect(git(place.path, "rev-parse", "HEAD")).toBe(tip);
  expect(openQuestionOf(b, task)).toBeUndefined();
  expect(answered.notice).toContain(place.path);
  expect(answered.notice).not.toContain('"retry"');

  const next = await answerRepairedByHand(b);

  expect(accepted(b)).toBe(true);
  expect(next.notice).toBeUndefined();
  expect(existsSync(place.path)).toBe(true);
  expect(keptEvents(b.db)).toEqual([{ task_id: task.id, payload: { kind: "task_checkout_kept", path: place.path } }]);
});

// S1 は checkout の `.git` を消して読めない形で代える —— 2回目の session の alternates の祖先が gc で消える形そのものではない
it.each([["S3: checkout が tip を持つ", false], ["S1: checkout が読めない", true]] as const)("%s未決着の task で人間が動かした `task/<id>` は、give-up が keep-around へ移して消し、やり直した解放は書かずに解放の失敗にして checkout を残し、failure question の retry が fork 元から作り直す(ADR 0393 決定2・3、ADR 0392 決定1・3)", async (_, unreadable) => {
  const b = await board("s3-unsettled");
  const task = work(b, "root");
  const { place, tip, human } = await movedBeforeRelease(b, task, false);
  if (unreadable) rmSync(join(place.path, ".git"), { recursive: true, force: true });

  const answered = await giveUp(b);

  expect(accepted(b)).toBe(true);
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${task.id}`)).toBe("");
  expect(git(b.ws.path, "rev-parse", `refs/keep-around/${human}`)).toBe(human);
  if (!unreadable) expect(git(place.path, "rev-parse", "HEAD")).toBe(tip);
  expect(kindsOf(b, task)).toEqual(expect.arrayContaining(["task_checkout_release_failed", "task_checkout_kept"]));
  expect(answered.notice).toContain(`The board kept the task checkout at ${place.path} and no longer touches it; you may delete it. "retry" picks this task up again`);
  const question = openQuestionOf(b, task)!;
  expect(question.purpose).toContain(`The board kept the task checkout at ${place.path}`);
  expect(question.purpose).toContain("if its task branch was lost, the board makes it again from the fork source");

  await answer(b, question.id, "retry");
  const again = await pickUp(b, getTask(b.db, task.id)!);

  const main = git(b.ws.path, "rev-parse", "main");
  expect(createdShas(b, task).at(-1)).toBe(main);
  expect(git(again.path, "rev-parse", "HEAD")).toBe(main);
  expect(existsSync(place.path)).toBe(true);
});

/** 盤面の経路で拾って commit し、解放するが checkout の削除だけが落ちた task —— 成果は `task/<id>` に着き、checkout は解放済みのまま disk に残る。 */
async function releasedButLeft(b: Board, title: string) {
  const task = work(b, title);
  const place = await pickUp(b, task);
  commitWork(place.path, "task.txt", "task\n");
  const parent = join(place.path, "..");
  chmodSync(parent, 0o555);
  try {
    expect(() => releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now())).toThrow();
  } finally {
    chmodSync(parent, 0o755);
  }
  expect(listEventsOfKinds(b.db, ["task_checkout_released"]).map(({ task_id }) => task_id)).toContain(task.id);
  return { task, place };
}

it("解放済みで削除が落ちて残る checkout の task で give-up しても、その回答でも次の回答でも checkout は消えず、残したことは1回だけ刻んで告げる(ADR 0393 決定1・3)", async () => {
  const b = await board("released-left-give-up");
  const { task, place } = await releasedButLeft(b, "task");

  const answered = await giveUp(b, task.id);
  const next = await answerRepairedByHand(b);

  expect(accepted(b)).toBe(true);
  expect(existsSync(place.path)).toBe(true);
  expect(keptEvents(b.db)).toEqual([{ task_id: task.id, payload: { kind: "task_checkout_kept", path: place.path } }]);
  expect(answered.notice).toContain(`The board kept the task checkout at ${place.path} and no longer touches it`);
  expect(next.notice).toBeUndefined();
});

it("give-up が失われた event を刻んだ後、同じ回答の後半で拒まれれば残したことは告げず、次に残す回答が刻んで告げる(ADR 0393 決定3)", async () => {
  const b = await board("kept-after-refusal");
  // 名前の場所の事情(残った ref の lock)で解放を負う別の task —— 受理のやり直しが lock の間は拒む
  const owing = work(b, "owing");
  const owingPlace = await pickUp(b, owing);
  commitWork(owingPlace.path, "owing.txt", "owing\n");
  const lock = join(b.ws.path, ".git", "refs", "heads", "task", `${owing.id}.lock`);
  writeFileSync(lock, "");
  releaseWorkspace(b.db, owingPlace, getTask(b.db, owing.id)!, b.clock.now());
  rmSync(lock);
  const { task, place } = await releasedButLeft(b, "task");

  await expect(giveUpAfter(b, () => writeFileSync(lock, ""), task.id)).rejects.toThrow(DomainError);

  expect(taskBranchLostInForce(b.db, task.id)).toBeDefined();
  expect(keptEvents(b.db)).toEqual([]);
  rmSync(lock);

  const answered = await answerRepairedByHand(b);

  expect(accepted(b)).toBe(true);
  expect(keptEvents(b.db)).toEqual([{ task_id: task.id, payload: { kind: "task_checkout_kept", path: place.path } }]);
  expect(answered.notice).toContain(`The board kept the task checkout at ${place.path} and no longer touches it`);
});

it.each([["disk に在る", true], ["disk に無い", false]] as const)("give-up の前の `restore the baseline` の拒否は、失われた `task/<id>` の checkout が%sときだけ、その在り処と give-up しても残ることを言う(ADR 0393 決定3)", async (_, onDisk) => {
  const b = await board("restore-names-kept-checkout");
  const task = work(b, "root");
  const { place } = await movedBeforeRelease(b, task, true);
  if (!onDisk) rmSync(place.path, { recursive: true, force: true });
  git(b.ws.path, "reflog", "expire", "--expire=now", "--all");
  git(b.ws.path, "gc", "--quiet", "--prune=now");

  const refusal = answerQuarantine(b, "restore the baseline");

  await expect(refusal).rejects.toThrow(`cannot restore refs/heads/task/${task.id} to `);
  const says = `The task checkout at ${place.path} stays even if you give up the lost refs`;
  if (onDisk) await expect(refusal).rejects.toThrow(says);
  else await expect(refusal).rejects.not.toThrow(says);
});

/** setup のみ: 失われた event が効いたまま、盤面の口で `task/<id>` を `main` に作る(基準に入る)—— give-up の後は届かない状態。値を返す。 */
function lostButPresent(b: Board, taskId: string): string {
  const ref = `refs/heads/task/${taskId}`;
  const main = git(b.ws.path, "rev-parse", "main");
  boardRefWriter(b.db, b.ws)(ref, main, () => git(b.ws.path, "update-ref", ref, main));
  return main;
}

// 盤面の pickup がこれを workspace の Quarantine でなく task の spawn の失敗(cancel だけ)にする分岐は scheduler にあり、ここでは見ない
it("失われた event が効いたまま `task/<id>` が在れば、pickup の準備は採らずに止まり、`task_branch_created` を書かない(ADR 0392 決定2)", async () => {
  const b = await board("lost-but-present-pickup");
  const task = await commitThrough(b, work(b, "root"), "root.txt");
  await giveUp(b, task.id);
  const value = lostButPresent(b, task.id);
  const created = createdShas(b, task);

  await expect(pickUp(b, getTask(b.db, task.id)!))
    .rejects.toThrow(new LostTaskBranchPresentError(task.id, `refs/heads/task/${task.id}`, value));

  expect(createdShas(b, task)).toEqual(created);
  expect(taskBranchLostInForce(b.db, task.id)).toBeDefined();
});

it("give-up の回答が checkout を残したと刻んだ後に後の task のやり直しで拒まれても、拒否の文が在り処を言い、次に通る回答は告げ直さない(ADR 0393 決定3)", async () => {
  const b = await board("kept-then-refused");
  // 解放のやり直しは task の id 順 —— 完了した task が先に残され、名前の場所の事情(残った ref の lock)で解放を負う後の task が拒む
  const [done, owing] = [work(b, "done"), work(b, "owing")].sort((p, q) => (p.id < q.id ? -1 : 1)) as [Task, Task];
  const owingPlace = await pickUp(b, owing);
  commitWork(owingPlace.path, "owing.txt", "owing\n");
  const lock = join(b.ws.path, ".git", "refs", "heads", "task", `${owing.id}.lock`);
  writeFileSync(lock, "");
  releaseWorkspace(b.db, owingPlace, getTask(b.db, owing.id)!, b.clock.now());
  rmSync(lock);
  const { place } = await movedBeforeRelease(b, done, true);

  const refusal = giveUpAfter(b, () => writeFileSync(lock, ""));

  await expect(refusal).rejects.toThrow(DomainError);
  await expect(refusal).rejects.toThrow(`The board kept the task checkout at ${place.path} and no longer touches it; you may delete it.`);
  expect(keptEvents(b.db)).toEqual([{ task_id: done.id, payload: { kind: "task_checkout_kept", path: place.path } }]);
  rmSync(lock);

  const answered = await answerRepairedByHand(b);

  expect(accepted(b)).toBe(true);
  expect(answered.notice ?? "").not.toContain(place.path);
  expect(keptEvents(b.db)).toHaveLength(1);
});

/** scheduler の盤面(1回の poll で拾い、走らなかった pickup は盤面の spawn の失敗の記録と後始末に落ちる)。 */
function schedulerOn(b: Board) {
  const worker = new ScriptedWorker(b.clock);
  const slot = new Slot();
  const containers = fakeContainers();
  const resolve = () => b.ws;
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: () => new Promise((done) => setImmediate(() => done([]))),
    db: b.db,
    clock: b.clock,
    slot,
    worker,
    containers,
    onSpawnFailed: spawnFailureHandler({ db: b.db, clock: b.clock, slot, resolve, pollNow: () => scheduler.pollNow() }, containers),
    onRecordContainerFailed: () => {},
    onPickupStopped: queueReturnHandler({ db: b.db, clock: b.clock, slot, resolve, pollNow: () => scheduler.pollNow() }, containers, { defaultWorkspaceName: b.ws.name }),
    taskExecutionCandidates: implicitTaskExecutionCandidates(b.db),
    workspacesDir: b.base,
    workspace: b.ws,
    resolveWorkspace: resolve,
  });
  onTestFinished(() => scheduler.stop());
  return worker;
}

it("盤面の pickup は、失われた event が効いたまま在る `task/<id>` を workspace の Quarantine にせず、その task の走らなかった pickup の失敗(cancel だけの question)にする(ADR 0392 決定2)", async () => {
  const b = await board("lost-but-present-scheduler");
  const task = await commitThrough(b, work(b, "root"), "root.txt");
  await giveUp(b, task.id);
  const value = lostButPresent(b, task.id);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const worker = schedulerOn(b);

  await b.clock.advance(HOURLY);
  await vi.waitFor(() => expect(kindsOf(b, task)).toContain("spawn_failed"));
  await vi.waitFor(() => expect(openQuestionOf(b, task)).toBeDefined());

  expect(listEvents(b.db, task.id).find(({ kind }) => kind === "spawn_failed")!.payload).toMatchObject({ message: expect.stringContaining(`refs/heads/task/${task.id} is at ${value}`) });
  expect(openQuestionOf(b, task)!.question_items).toEqual([expect.objectContaining({ options: ["abandon"] })]);
  expect(accepted(b)).toBe(true);
  expect(worker.started).toEqual([]);
});

it("祖先の `task/<id>` が失われた event の効いたまま在れば、`start_work` は拒み、cancel だけの failure question を書き始めた task でなく祖先に立てる(ADR 0392 決定2)", async () => {
  const b = await board("lost-but-present-ancestor");
  const parent = await commitThrough(b, work(b, "parent"), "parent.txt");
  await giveUp(b, parent.id);
  const value = lostButPresent(b, parent.id);
  const h = work(b, "write it myself", { parent_id: parent.id, assignee: HUMAN_ACTOR_ID });

  expect(await startWorkThroughHumanDoor(doorDeps(b), h.id, () => b.clock.now(), "webui")).toMatchObject({
    ok: false,
    failure: { error: expect.stringContaining(`refs/heads/task/${parent.id} is at ${value}, but the task branch of task ${parent.id} was recorded lost`) },
  });

  expect(openQuestionOf(b, h)).toBeUndefined();
  expect(openQuestionOf(b, parent)!.question_items).toEqual([expect.objectContaining({ options: ["abandon"] })]);
  expect(createdShas(b, h)).toEqual([]);
  expect(accepted(b)).toBe(true);
});

it("失われた event が効いたまま `task/<H>` が在れば、`start_work` は拒み、`task_branch_created` を書かず、H に ref と値を名指す cancel だけの failure question を1つ立て、workspace を Quarantine しない(ADR 0392 決定2)", async () => {
  const b = await board("lost-but-present-start-work");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const at = () => b.clock.now();
  await startWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui");
  commitWork(realpathSync(workbenchPath(b.base, { task: h.id })), "mine.txt", "mine\n");
  expect((await takeInWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui")).ok).toBe(true);
  await giveUp(b, h.id);
  rmSync(workbenchPath(b.base, { task: h.id }), { recursive: true, force: true });
  const value = lostButPresent(b, h.id);
  const created = createdShas(b, h);

  for (let i = 0; i < 2; i++) {
    expect(await startWorkThroughHumanDoor(doorDeps(b), h.id, at, "webui")).toMatchObject({ ok: false, failure: { error: expect.stringContaining(`refs/heads/task/${h.id} is at ${value}`) } });
  }

  expect(createdShas(b, h)).toEqual(created);
  expect(accepted(b)).toBe(true);
  const questions = listChildren(b.db, h.id).filter((child) => child.type === "question" && child.status === "todo");
  expect(questions).toHaveLength(1);
  expect(questions[0]!.question_items).toEqual([expect.objectContaining({ options: ["abandon"] })]);
  expect(questions[0]!.purpose).toContain(`refs/heads/task/${h.id} is at ${value}`);
});

it("失われた event の無い解放済みの checkout は今どおり消え、残したことを刻まない(ADR 0369 決定7、ADR 0393 決定1)", async () => {
  const b = await board("released-removed");
  const task = work(b, "task");
  const place = await pickUp(b, task);
  commitWork(place.path, "task.txt", "task\n");

  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now());

  expect(existsSync(place.path)).toBe(false);
  expect(keptEvents(b.db)).toEqual([]);
});

// ADR 0407 決定1: 効いている失われた event を持つ task は着地が終わったと読む —— 種類によらず収束の候補に入らず、失われたブランチを git で読まない。
// 形は #3582 の読み手の表の行。remote-backed の盤面で、失わせるのは盤面の口(基準も一緒に動く)で、event は give-up が書く形を手で刻む。

type RemoteBoard = { db: Db; clock: FakeClock; workspace: WorkspaceConfig; github: FakeGitHubClient; landing: Landing };

async function remoteBoard(name: string): Promise<RemoteBoard> {
  const { workspace } = await makeLandingWorkspace(name);
  const { db, clock } = await openBoard();
  const github = new FakeGitHubClient();
  return { db, clock, workspace, github, landing: createLanding({ defaultAgentName: "tako", db, clock, workspace, github }) };
}

/** setup のみ: 盤面の口で `task/<id>` を消し、give-up と同じ `task_branch_lost` を消した tip で刻む。 */
function loseThroughBoard(c: RemoteBoard, task: Task): void {
  const ref = `refs/heads/task/${task.id}`;
  const sha = git(c.workspace.path, "rev-parse", ref);
  boardRefWriter(c.db, c.workspace)(ref, "", () => git(c.workspace.path, "update-ref", "-d", ref));
  appendEvent(c.db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_branch_lost", sha }, at: c.clock.now() });
}

/** 収束が PR #1 を開き、その後に盤面の経路で根に commit を載せた(まだ push していない)根。 */
async function prRootWithUnpushedCommit(c: RemoteBoard): Promise<Task> {
  const root = await completeThroughTaskCheckout(c.db, c.clock, c.workspace, landingWork(c.db, c.clock), "feature.txt", "ready\n");
  await c.landing.converge();
  expect(getTask(c.db, root.id)!.pr_number).toBe(1);
  await commitThroughTaskCheckout(c.db, c.clock, c.workspace, root, "late.txt", "not pushed yet\n");
  return root;
}

type LoseOnRemote = (c: RemoteBoard) => Promise<void>;

const loseHandoffOnly: LoseOnRemote = async (c) => {
  const task = landingWork(c.db, c.clock);
  const place = await prepareAtPickup(c.db, c.workspace, task);
  recordTaskCheckoutTip(c.db, place, task.id);
  releaseWorkspace(c.db, place, finish(c.db, c.clock, task), c.clock.now(), true, undefined, undefined, true);
  loseThroughBoard(c, task);
};
const loseDead: LoseOnRemote = async (c) =>
  loseThroughBoard(c, await completeThroughTaskCheckout(c.db, c.clock, c.workspace, landingWork(c.db, c.clock), "dead.txt", "lost\n"));
const loseTransparentByAncestor: LoseOnRemote = async (c) => {
  const parent = landingWork(c.db, c.clock);
  const child = await completeThroughTaskCheckout(c.db, c.clock, c.workspace, attachUnsettledChild(c.db, c.clock, parent.id), "child.txt", "child\n");
  await completeThroughTaskCheckout(c.db, c.clock, c.workspace, getTask(c.db, parent.id)!, "parent.txt", "parent\n");
  // fixture の dial は `external` で外の merge を観測しないので、親の内容が届いた記録は手で書く(#3582 の実測)
  appendEvent(c.db, { taskId: parent.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "landing_finished", pr_number: 1, basis: "content" }, at: c.clock.now() });
  loseThroughBoard(c, child);
  loseThroughBoard(c, getTask(c.db, parent.id)!);
};

/** [形の名前, 盤面の名前, 失わせ方] —— #3582 の読み手の表の行。 */
const LOST_SHAPES: Array<[string, string, LoseOnRemote]> = [
  ["handoff だけ", "handoff-only", loseHandoffOnly],
  ["死んだ", "dead", loseDead],
  ["祖先の記録で透明", "transparent-by-ancestor", loseTransparentByAncestor],
  ["PR open で push 前の commit あり", "pr-open-unpushed", async (c) => loseThroughBoard(c, await prRootWithUnpushedCommit(c))],
  [
    "PR merged",
    "pr-merged",
    async (c) => {
      loseThroughBoard(c, await prRootWithUnpushedCommit(c));
      c.github.scriptMergedOutside(1);
    },
  ],
  [
    "PR closed",
    "pr-closed",
    async (c) => {
      loseThroughBoard(c, await prRootWithUnpushedCommit(c));
      c.github.scriptClosedOutside(1);
    },
  ],
];

it.each(LOST_SHAPES)("失われた event が効いている done の work(%s)は収束の候補に入らず、昇格失敗の question も `unknown revision` も出ない(ADR 0407 決定1)", async (_, slug, lose) => {
  const c = await remoteBoard(`lost-not-a-candidate-${slug}`);
  await lose(c);
  const lost = listEventsOfKinds(c.db, ["task_branch_lost"]).map(({ task_id }) => task_id!);

  const { result: verdicts, reads } = await gitReadsOf(lost, async () => [...(await c.landing.converge()), ...(await c.landing.converge())]);

  expect(reads).toEqual([]);
  expect(verdicts.filter(({ taskId }) => lost.includes(taskId))).toEqual([]);
  expect(lost.flatMap((id) => promotionFailures(c.db, id))).toEqual([]);
  expect(JSON.stringify([verdicts, listBoard(c.db)])).not.toContain("unknown revision");
});

it.each([
  ["handoff だけ", "handoff-only", loseHandoffOnly, null],
  ["死んだ", "dead", loseDead, "branch_lost"],
  ["祖先の記録で透明", "transparent-by-ancestor", loseTransparentByAncestor, null],
] as const)("行の着地の状態: 失われた event が効いている done の work は、死んだときだけ `branch_lost` を出す(%s)(ADR 0407 帰結、ADR 0265 Status 追記)", async (_, slug, lose, expected) => {
  const c = await remoteBoard(`lost-landing-state-${slug}`);
  await lose(c);
  const lost = listEventsOfKinds(c.db, ["task_branch_lost"]).map(({ task_id }) => getTask(c.db, task_id!)!);
  // 祖先の記録で透明な形の親は自分の `landing_finished` を先に出す
  const own = lost.filter((task) => listEventsOfKinds(c.db, ["landing_finished"]).every(({ task_id }) => task_id !== task.id));

  expect(own.map((task) => landingState(c.db, task))).toEqual(own.map(() => expected));
});

it("死んだ PR の根の下の完了した子は帰り先なしで、着地の根にも着地を待つ完了タスクにもならず、昇格失敗の question も立たない(ADR 0407 決定1・3、ADR 0380 決定3)", async () => {
  const b = await board("dead-pr-root-no-return-child");
  const root = work(b, "root");
  const child = await completeThrough(b, work(b, "child", { parent_id: root.id }), "child.txt");
  // 子の merge back の後に根が自分の commit を積む —— 子のブランチからは根の tip が届かず、根は give-up で失われて死ぬ
  const done = await completeThrough(b, root, "root.txt");
  recordPrOpened(b.db, done, 1, git(b.ws.path, "rev-parse", `task/${root.id}`), b.clock.now(), { merge: "escalate" }, false);
  await giveUp(b, root.id);
  expect(accepted(b)).toBe(true);

  const { result: verdicts, reads } = await gitReadsOf([root.id], () => landingFor(b).converge());

  expect(lineageOf(b, child)).toEqual(NO_RETURN);
  expect(reads).toEqual([]);
  expect(verdicts.map(({ taskId }) => taskId)).not.toContain(child.id);
  expect(openLandingQuestions(b, child)).toEqual([]);
  expect(taskIdsAwaitingLandingInWorkspace(b.db, () => b.ws, b.ws.name)).toEqual([]);
  expect(landingState(b.db, getTask(b.db, child.id)!)).toBeNull();
});

it("PR の閉じた根が失われても、その下の子を塞ぐ根の読み(`blockingRootOf`)は失われたブランチを git で読まない —— 系譜が失われた根へ帰らない(ADR 0407 決定1、ADR 0380 決定3、ADR 0265 決定6)", async () => {
  const b = await board("closed-lost-root-blocks");
  const root = await prRoot(b, "closed", "escalate", 1);
  appendEvent(b.db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "pr_close_observed", pr_number: 1 }, at: b.clock.now() });
  const child = work(b, "child", { parent_id: root.id });
  await giveUp(b, root.id);

  const { result, reads } = await gitReadsOf([root.id], () => blockingRootOf(b.db, () => b.ws)(getTask(b.db, child.id)!));

  expect(reads).toEqual([]);
  expect(result).toBeNull();
});

it("失われた PR の根の下の子孫は、開いた PR の根に外されずに系譜の読みへ渡る —— 透明な根を飛ばして保護ブランチへ帰る子は自分で根になって着地する(ADR 0407 決定1・3、ADR 0380 決定3)", async () => {
  const b = await seededBoard("lost-pr-root-descendant");
  const root = work(b, "root");
  seedThroughBoard(b, root.id, git(b.ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "created here, never edited"));
  completeTask(b.db, root, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  recordPrOpened(b.db, getTask(b.db, root.id)!, 1, git(b.ws.path, "rev-parse", `task/${root.id}`), b.clock.now(), { merge: "escalate" }, false);
  const child = await completeUndelivered(b, work(b, "child", { parent_id: root.id }), "child.txt");
  await giveUp(b, root.id);
  expect(accepted(b)).toBe(true);

  const verdicts = await landingFor(b).converge();

  expect(verdicts.find(({ taskId }) => taskId === child.id)?.verdict).toEqual({ kind: "landed", form: "local_merge_question" });
});

/** 人間が `task/<id>` を消し、届かなくなった commit を gc で失わせる。`alsoOnFork` なら push 済みの出元 repo のブランチとその写しも消す —— 取り戻せない。 */
function loseByHand(c: RemoteBoard, task: Task, alsoOnFork = false): void {
  const ref = `refs/heads/task/${task.id}`;
  if (alsoOnFork) git(c.workspace.path, "update-ref", "-d", `refs/remotes/head-repo/task/${task.id}`);
  for (const repo of alsoOnFork ? [c.workspace.path, c.workspace.head_repo!] : [c.workspace.path]) {
    git(repo, "update-ref", "-d", ref);
    git(repo, "reflog", "expire", "--expire=now", "--all");
    git(repo, "gc", "--quiet", "--prune=now");
  }
}

/** workspace の Quarantine を立て、盤面の印を読む受理(`c.landing` を渡す)で give-up と答える。 */
function giveUpOnRemote(c: RemoteBoard) {
  if (!quarantineQuestion(c.db, "workspace", c.workspace.name)) quarantineWorkspace(c.db, c.workspace.name, new Error("a human deleted task branches"), c.clock.now());
  return submitAnswer(
    { db: c.db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db: c.db, workspace: c.workspace, landing: c.landing }) },
    quarantineQuestion(c.db, "workspace", c.workspace.name)!,
    [GIVE_UP],
    undefined,
    () => c.clock.now(),
    "webui",
  );
}

/** 収束が次に PR を作る要求の最中(作成を返す前)に `during` を1度走らせ、その結果(通れば undefined、拒まれればその error)を返す口。 */
function duringNextPrCreation(c: RemoteBoard, during: () => Promise<unknown>): () => unknown {
  const create = c.github.createPullRequest.bind(c.github);
  let outcome: unknown = "not run";
  let pending: (() => Promise<unknown>) | undefined = during;
  c.github.createPullRequest = async (input) => {
    const act = pending;
    pending = undefined;
    if (act) outcome = await act().then(() => undefined, (err: unknown) => err);
    return create(input);
  };
  return () => outcome;
}

it("収束の回の途中で give-up が通った根は、同じ回で撃たれない —— 根ごとに着地の終わりの述語を読み直す(ADR 0407 決定1)", async () => {
  const c = await remoteBoard("given-up-mid-pass");
  const first = await completeThroughTaskCheckout(c.db, c.clock, c.workspace, landingWork(c.db, c.clock), "first.txt", "first\n");
  const lost = await completeThroughTaskCheckout(c.db, c.clock, c.workspace, landingWork(c.db, c.clock), "lost.txt", "lost\n");
  const outcome = duringNextPrCreation(c, () => {
    loseByHand(c, lost);
    return giveUpOnRemote(c);
  });

  const { result: verdicts, reads } = await gitReadsOf([lost.id], () => c.landing.converge());

  expect(outcome()).toBeUndefined();
  expect(taskBranchLostInForce(c.db, lost.id)).toBeDefined();
  expect(verdicts.find(({ taskId }) => taskId === first.id)?.verdict).toMatchObject({ kind: "landed", form: "pull_request_opened" });
  expect(verdicts.map(({ taskId }) => taskId)).not.toContain(lost.id);
  expect(reads).toEqual([]);
  expect(promotionFailures(c.db, lost.id)).toEqual([]);
  expect(JSON.stringify([verdicts, listBoard(c.db)])).not.toContain("unknown revision");
});

it("収束が根の PR を作っている間(push から記録まで)は処理中の印を持ち、その根を失わせる give-up は何も書かずに拒まれる —— 作り終えた後の give-up は通る(ADR 0407 決定2、ADR 0236)", async () => {
  const c = await remoteBoard("give-up-during-pr-creation");
  const root = await completeThroughTaskCheckout(c.db, c.clock, c.workspace, landingWork(c.db, c.clock), "root.txt", "root\n");
  const outcome = duringNextPrCreation(c, () => {
    loseByHand(c, root, true);
    return giveUpOnRemote(c);
  });

  await c.landing.converge();

  expect(outcome()).toBeInstanceOf(DomainError);
  expect(String(outcome())).toContain(`the board is opening the PR of task ${root.id} right now — answer again in a moment`);
  expect(lostEvents(c.db)).toEqual([]);
  expect(quarantineQuestion(c.db, "workspace", c.workspace.name)).toBeDefined();

  await giveUpOnRemote(c);

  expect(quarantineQuestion(c.db, "workspace", c.workspace.name)).toBeUndefined();
  expect(taskBranchLostInForce(c.db, root.id)).toBeDefined();
});
