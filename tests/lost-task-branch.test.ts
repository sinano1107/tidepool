import { realpathSync, rmSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents, listEventsOfKinds, type TaskScopedPayload } from "../src/events.js";
import { completeThroughHumanDoor, quarantineChecks, startWorkThroughHumanDoor, submitAnswer, takeInWorkThroughHumanDoor } from "../src/human-verbs.js";
import { closedRootOf, contentLeftBehindLocally, landingState, taskIdsAwaitingLandingInWorkspace } from "../src/landing.js";
import { completeTask, editTask, fillEmptyWorkspace, getTask, listChildren, type RegisterTaskInput, registerTask, type Task, taskBranchLostInForce } from "../src/tasks.js";
import { workbenchPath } from "../src/workbench.js";
import { boardRefWriter, quarantineWorkspace, recordTaskCheckoutTip, releaseWorkspace, resolveTaskBranchLineage, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, makeWorkspace, prepareAtPickup, quarantineQuestion, recordTaskBranchCreated, settleReviews } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 失われたタスクブランチを系譜が記録で読む(ADR 0375 決定1・2、ADR 0380 決定1・3、spec #3273 group H、#3297)。domain 層の釘(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const GIVE_UP = "give up the lost refs and restore the baseline";

type Board = { db: Db; clock: FakeClock; ws: WorkspaceConfig; base: string };

async function board(name: string): Promise<Board> {
  return { db: openDb(":memory:"), clock: new FakeClock(), ws: await makeWorkspace(name), base: await tempDir("tidepool-task-checkouts-") };
}

function work(b: Board, title: string, extra: Partial<RegisterTaskInput> = {}): Task {
  const workspace = extra.parent_id ? undefined : b.ws.name;
  return registerTask(b.db, { type: "work", title, purpose: "why", completion_criteria: "done", workspace, ...extra }, b.clock.now(), ...HUMAN_WEBUI);
}

/** 盤面の経路で拾い(系譜の帰り先から fork、未着手の祖先も固定)、`file` があれば commit し、完了して後始末の merge back まで通す。 */
async function completeThrough(b: Board, task: Task, file?: string, settle = true): Promise<Task> {
  const place = await prepareAtPickup(b.db, b.ws, task, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });
  if (file !== undefined) commitWork(place.path, file, `${file}\n`);
  recordTaskCheckoutTip(b.db, place, task.id);
  completeTask(b.db, getTask(b.db, task.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  if (settle) settleReviews(b.db, b.clock.now());
  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now(), true, undefined, undefined, true);
  return getTask(b.db, task.id)!;
}

/** 盤面の経路で拾って `file` を commit し、完了するが merge back はまだ届けない(完了の後始末の前)。 */
async function completeUndelivered(b: Board, task: Task, file: string): Promise<Task> {
  const place = await prepareAtPickup(b.db, b.ws, task, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });
  commitWork(place.path, file, `${file}\n`);
  recordTaskCheckoutTip(b.db, place, task.id);
  completeTask(b.db, getTask(b.db, task.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  settleReviews(b.db, b.clock.now());
  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now());
  return getTask(b.db, task.id)!;
}

/** 盤面の経路で拾い、`file` を commit して、完了せずに解放する —— 未決着の task が `task/<id>` に成果を持つ。 */
async function commitThrough(b: Board, task: Task, file: string): Promise<Task> {
  const place = await prepareAtPickup(b.db, b.ws, task, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });
  commitWork(place.path, file, `${file}\n`);
  releaseWorkspace(b.db, place, getTask(b.db, task.id)!, b.clock.now());
  return getTask(b.db, task.id)!;
}

/** 人間が `task/<id>` を消し、届かなくなった commit を gc で失わせ、workspace の Quarantine に give-up で答える。 */
async function giveUp(b: Board, ...taskIds: string[]) {
  for (const id of taskIds) git(b.ws.path, "update-ref", "-d", `refs/heads/task/${id}`);
  git(b.ws.path, "reflog", "expire", "--expire=now", "--all");
  git(b.ws.path, "gc", "--quiet", "--prune=now");
  quarantineWorkspace(b.db, b.ws.name, new Error("a human deleted task branches"), b.clock.now());
  return submitAnswer(
    { db: b.db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db: b.db, workspace: b.ws, workspacesDir: b.base }) },
    quarantineQuestion(b.db, "workspace", b.ws.name)!,
    [GIVE_UP],
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

const lineageOf = (b: Board, task: Task) => resolveTaskBranchLineage(b.db, b.ws, getTask(b.db, task.id)!);
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

it("done の親のブランチが失われ子のブランチが残る: handoff だけの親(失われた sha = 作成時の sha)は透明で、子は次の数える祖先へ帰る(ADR 0380 決定1・3、pin H7・H9)", async () => {
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

  await giveUp(b, parent.id);

  expect(accepted(b)).toBe(true);
  expect(lineageOf(b, child)).toEqual({ branch: `task/${grandparent.id}`, outlivedForkSource: false });
});

/** 生きている根 R(自分の commit を持つ)→ 死ぬ D → 無事な M → C。C と M は完了して merge back が届き、D は自分の commit を積んで完了したが R へは届いていない。
 *  D のブランチを失わせて give-up で答えた盤面。 */
async function deadTaskUnderLivingRoot(name: string) {
  const b = await board(name);
  const root = await commitThrough(b, work(b, "living root"), "root.txt");
  const dead = work(b, "dead", { parent_id: root.id });
  const healthy = work(b, "healthy", { parent_id: dead.id });
  const child = await completeThrough(b, work(b, "child", { parent_id: healthy.id }), "child.txt");
  await completeThrough(b, healthy, "healthy.txt");
  const place = await prepareAtPickup(b.db, b.ws, dead, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });
  commitWork(place.path, "dead.txt", "dead\n");
  completeTask(b.db, getTask(b.db, dead.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
  releaseWorkspace(b.db, place, getTask(b.db, dead.id)!, b.clock.now());
  completeTask(b.db, getTask(b.db, root.id)!, FULL_HANDOFF, "worker", b.clock.now(), "worker");
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

it("別の workspace に固定された子孫は死んだ祖先を数えない(ADR 0372 決定4、ADR 0380 決定2、pin H9)", async () => {
  const { b, child } = await deadTaskUnderLivingRoot("dead-ancestor-other-workspace");
  const elsewhere = work(b, "elsewhere", { parent_id: child.id });
  fillEmptyWorkspace(b.db, elsewhere.id, "elsewhere");

  expect(resolveTaskBranchLineage(b.db, { ...b.ws, name: "elsewhere" }, getTask(b.db, elsewhere.id)!)).toEqual({ branch: undefined, outlivedForkSource: false });
});

it("merge back の数え直しは、失われた event が効いている task のブランチを、人間の値で残っていても帰り先へ運ばない(ADR 0380 決定3)", async () => {
  const b = await board("lost-child-moved");
  const parent = await commitThrough(b, work(b, "parent"), "parent.txt");
  const child = work(b, "child", { parent_id: parent.id });
  const place = await prepareAtPickup(b.db, b.ws, child, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });
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
  expect(git(b.ws.path, "rev-parse", `task/${child.id}`)).toBe(moved);
  expect(git(b.ws.path, "rev-parse", `task/${parent.id}`)).toBe(parentTip);
});

it("死んだ task に残るレビュー(RCA)は保護ブランチを読み、失われた ref が人間の値で残っていても git で読まない(ADR 0380 決定3、pin H16)", async () => {
  const b = await board("dead-task-review");
  const dead = await completeThrough(b, work(b, "dead"), "dead.txt");
  const review = registerTask(b.db, { type: "review", title: "rca", purpose: "p", completion_criteria: "c", parent_id: dead.id }, b.clock.now(), BOARD_ACTOR_ID, "board");
  // 人間が失われた ref を別の commit へ動かした —— give-up はその ref を今の値で基準に入れる
  git(b.ws.path, "update-ref", `refs/heads/task/${dead.id}`, git(b.ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "a human moved the lost ref here"));

  await giveUp(b);

  expect(taskBranchLostInForce(b.db, dead.id)).toBeDefined();
  expect(lineageOf(b, review)).toEqual({ branch: undefined, outlivedForkSource: false });
});

/** 根 R の下に、編集のあった done の D と、その子 C(ブランチが残る)。R の記録 `kind` は D の完了の `after` に刻む。D のブランチを失わせて give-up で答える。 */
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
  await giveUp(b, dead.id);
  return lineageOf(b, child);
}

const REACHED: TaskScopedPayload[] = [
  { kind: "local_merge_executed", sha: "0".repeat(40) },
  { kind: "pr_merged", pr_number: 1 },
  { kind: "pr_merge_observed", pr_number: 1 },
  { kind: "landing_finished", pr_number: 1, basis: "merge" },
];
const NOT_REACHED: TaskScopedPayload[] = [{ kind: "nothing_to_land", base: "0".repeat(40) }, { kind: "pr_close_observed", pr_number: 1 }];

it.each(REACHED)("数える祖先が完了の後に `$kind` を持てば、編集のあった失われた task は透明 —— 子は保護ブランチへ帰る(ADR 0380 決定1、pin H12)", async (record) => {
  expect(await lostUnderRootRecord(`landed-${record.kind}`, record, true)).toEqual({ branch: undefined, outlivedForkSource: false });
});

it.each(NOT_REACHED)("`$kind` は保護ブランチに届いた記録に数えない —— 編集のあった失われた task は死んで、子は帰り先なし(spec #3273 group H)", async (record) => {
  expect(await lostUnderRootRecord(`not-landed-${record.kind}`, record, true)).toEqual(NO_RETURN);
});

it("失われた task 自身が完了の後に保護ブランチに届いた記録を持てば透明(ADR 0380 決定1、pin H12)", async () => {
  expect(await lostUnderRootRecord("landed-self", REACHED[0]!, true, "self")).toEqual({ branch: undefined, outlivedForkSource: false });
});

it("完了の前の着地の記録では透明にならない(ADR 0380 決定1、pin H12)", async () => {
  expect(await lostUnderRootRecord("landed-before-completion", REACHED[3]!, false)).toEqual(NO_RETURN);
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
  return submitAnswer(
    { db: b.db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db: b.db, workspace: b.ws, workspacesDir: b.base }) },
    quarantineQuestion(b.db, "workspace", b.ws.name)!,
    ["repaired by hand"],
    undefined,
    () => b.clock.now(),
    "webui",
  );
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
  expect(closedRootOf(b.db, () => b.ws)(getTask(b.db, child.id)!)).toBeNull();
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

it("帰り先の done の親が死んだ H の取り込みと完了は、`start_work` を案内せずに拒む —— 固定は決着した祖先を作り直さない(ADR 0372 決定3、ADR 0380 決定3)", async () => {
  const b = await board("dead-human-return");
  const parent = await completeThrough(b, work(b, "parent"), "parent.txt");
  const h = await startedHuman(b, parent);
  // H が切られた後に親のブランチが進んだ —— その tip は H から届かず、失われると親は死ぬ
  const ref = `refs/heads/task/${parent.id}`;
  const edited = git(b.ws.path, "commit-tree", `${ref}^{tree}`, "-p", ref, "-m", "after the child forked");
  boardRefWriter(b.db, b.ws)(ref, edited, () => git(b.ws.path, "update-ref", ref, edited));
  await giveUp(b, parent.id);

  for (const [verb, result] of await refusedHumanDoors(b, h)) {
    expect(result).toEqual({
      ok: false,
      failure: { kind: "domain_error", error: `cannot ${verb}: task/${parent.id}, the branch this task returns into, was lost when the lost refs were given up.` },
    });
  }
});
