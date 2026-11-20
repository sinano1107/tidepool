import { existsSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents, listEventsOfKinds } from "../src/events.js";
import type { GitHubAuth } from "../src/github-auth.js";
import { completeThroughHumanDoor, startWorkThroughHumanDoor } from "../src/human-verbs.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, editTask, getTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { markTeardown, runTeardown, teardownStep } from "../src/teardown.js";
import { workbenchPath } from "../src/workbench.js";
import {
  boardRefWriter,
  completeHumanWork,
  holdsBaseline,
  prepareHumanWork,
  quarantineWorkspace,
  recordTaskCheckoutTip,
  takeWorkspaceInFlightKey,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, leaveBaseline, makeRemoteBackedWorkspace, makeWorkspace, prepareAtPickup, quarantineQuestion, sessionId, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";
import { answer } from "./workbench-fixture.js";

// ADR 0374 決定1〜4・6〜11 / spec #3273 group C(#3293): 人間担当の work の書き始める(`start_work`)と完了の扉。domain 層の釘(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

type Board = { db: Db; clock: FakeClock; ws: WorkspaceConfig; base: string };

async function board(name: string): Promise<Board> {
  return { db: openDb(":memory:"), clock: new FakeClock(), ws: await makeWorkspace(name), base: await tempDir("tidepool-task-checkouts-") };
}

function work(b: Board, title: string, extra: { parent_id?: string; workspace?: string; assignee?: string } = {}): Task {
  const workspace = extra.parent_id ? undefined : b.ws.name;
  return registerTask(b.db, { type: "work", title, purpose: "why", completion_criteria: "done", workspace, ...extra }, b.clock.now(), ...HUMAN_WEBUI);
}

const deps = ({ db, ws, base }: Board) => ({ db, pollNow: () => {}, workspace: ws, workspacesDir: base });

async function startWork(b: Board, task: Task) {
  return startWorkThroughHumanDoor(deps(b), task.id, () => b.clock.now(), "webui");
}

async function complete(b: Board, task: Task, handoff: Partial<typeof FULL_HANDOFF> | undefined = FULL_HANDOFF) {
  return completeThroughHumanDoor(deps(b), task.id, handoff, () => b.clock.now(), "webui");
}

const refused = (error: string) => ({ ok: false, failure: { kind: "domain_error", error } });

/** 名前の場所の全 ref(HEAD を含む)と作業ツリーの状態 —— 盤面が名前の場所に書いていないことの観測。 */
const namedPlace = (ws: WorkspaceConfig) => [git(ws.path, "symbolic-ref", "HEAD"), git(ws.path, "for-each-ref"), git(ws.path, "status", "--porcelain")];

const kinds = (db: Db, taskId: string) => listEvents(db, taskId).map((e) => e.kind);

const humanWorkbench = (b: Board, task: Task) => workbenchPath(b.base, { task: task.id });

/** agent の子を拾い、task の checkout を開く(pickup の準備 —— 未着手の祖先を固定する)。 */
async function pickedAgentChild(b: Board, parent: Task) {
  const { db, clock, ws, base } = b;
  const task = pickupTask(db, work(b, "child", { parent_id: parent.id }), "deckhand", clock.now())!;
  const place = await prepareAtPickup(db, ws, task, { now: clock.now(), workspacesBaseDir: base, defaultWorkspaceName: ws.name });
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  return { task, place };
}

/** 拾った子の task の checkout で `file` を書いて完了させ、後始末(merge back)まで通す。 */
async function finishAgentChild(b: Board, { task, place }: Awaited<ReturnType<typeof pickedAgentChild>>, file: string, body: string): Promise<Task> {
  const { db, clock, ws } = b;
  commitWork(place.path, file, body);
  recordTaskCheckoutTip(db, place, task.id);
  completeTask(db, task, FULL_HANDOFF, "worker", clock.now(), "worker");
  markTeardown(db, task.id, clock.now());
  const slot = new Slot();
  slot.occupy(task.id, sessionId(db, task.id));
  slot.enterTeardown();
  await runTeardown({ db, clock, slot, resolve: () => ws, pollNow: () => {} }, task.id, teardownStep(db, task.id));
  return getTask(db, task.id)!;
}

const completedAgentChild = async (b: Board, parent: Task, file: string, body: string) => finishAgentChild(b, await pickedAgentChild(b, parent), file, body);

/** 扉を準備の fetch(token の取得)で待たせ、その await の間に `during` を走らせてから続けさせる —— 最後の await の後の読みの観測。 */
async function duringPreparation<T>(door: (githubAuth: GitHubAuth) => Promise<T>, during: () => void): Promise<T> {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const reached = new Promise<void>((resolve) => (held = resolve));
  const result = door({ ensureToken: () => (held(), hold), env: () => process.env } as unknown as GitHubAuth);
  await reached;
  during();
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

it("その workspace の Quarantine が開いている間、start_work と完了は text C1a で拒まれ task に何も書かない —— 回答の後は通る(#3155 の追加要件)", async () => {
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

it("start_work と完了は workspace の in-flight の鍵を取り、別の回答か操作が検査中なら text B5 で拒まれる(pin B12)", async () => {
  const b = await board("start-work-in-flight");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startWork(b, h);
  const other = work(b, "not started yet", { assignee: HUMAN_ACTOR_ID });
  const release = takeWorkspaceInFlightKey(b.db, b.ws.name)!;
  const busy = refused(`another answer or operation for workspace ${b.ws.name} is being checked — try again once it has finished.`);

  expect(await startWork(b, other)).toEqual(busy);
  expect(await complete(b, h)).toEqual(busy);
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

it("agent の親の下の人間担当の子は task/<親> の今の値から切られる(pin C20)", async () => {
  const b = await board("agent-parent");
  const parent = pickupTask(b.db, work(b, "plan"), "deckhand", b.clock.now())!;
  const place = await prepareAtPickup(b.db, b.ws, parent, { now: b.clock.now(), workspacesBaseDir: b.base });
  commitWork(place.path, "plan.txt", "plan\n");
  recordTaskCheckoutTip(b.db, place, parent.id);
  const h = work(b, "write it myself", { parent_id: parent.id, assignee: HUMAN_ACTOR_ID });

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

it("子孫だけが走った H(タスクブランチあり・作業台なし)は取り込まずに完了し、兄弟の session が走っていても H の merge back を撃つ(pin C7、#3418 のレビューの形 2)", async () => {
  const b = await board("complete-children-only");
  const root = work(b, "plan");
  const h = work(b, "integrate it", { parent_id: root.id, assignee: HUMAN_ACTOR_ID });
  const child = await completedAgentChild(b, h, "child.txt", "child\n");
  const sibling = pickupTask(b.db, work(b, "sibling", { parent_id: root.id }), "deckhand", b.clock.now())!;
  await prepareAtPickup(b.db, b.ws, sibling, { now: b.clock.now(), workspacesBaseDir: b.base, defaultWorkspaceName: b.ws.name });

  expect(branchEvents(b.db, root.id).map((e) => (e as { sha: string }).sha)).toEqual([git(b.ws.path, "rev-parse", "main")]);
  expect(git(b.ws.path, "merge-base", `task/${h.id}`, `task/${root.id}`)).toBe(git(b.ws.path, "rev-parse", "main"));
  expect(git(b.ws.path, "rev-parse", `task/${child.id}^`)).toBe(git(b.ws.path, "rev-parse", "main"));

  expect((await complete(b, h)).ok).toBe(true);

  expect(getTask(b.db, h.id)!.status).toBe("done");
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
    (githubAuth) => completeThroughHumanDoor({ ...deps(b), githubAuth }, h.id, FULL_HANDOFF, () => b.clock.now(), "webui"),
    () => git(b.ws.path, "update-ref", `refs/heads/task/${h.id}`, git(b.ws.path, "commit-tree", "-p", `task/${h.id}`, "-m", "moved", `task/${h.id}^{tree}`)),
  );

  expect(!result.ok && result.failure.error).toMatch(new RegExp(`^task/${h.id} has moved on since your tip`));
  expect(getTask(b.db, h.id)!.status).toBe("todo");
});

it("準備の fetch を待つ間に cancel された H には、start_work も完了も扉の門を掛け直して何も書かない(Edit・cancel は in-flight の鍵を取らない)", async () => {
  const b = await board("gate-after-await");
  const started = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  await startedWithCommit(b, started);
  const fresh = work(b, "not started yet", { assignee: HUMAN_ACTOR_ID });
  const branch = git(b.ws.path, "rev-parse", `task/${started.id}`);

  const startResult = await duringPreparation(
    (githubAuth) => startWorkThroughHumanDoor({ ...deps(b), githubAuth }, fresh.id, () => b.clock.now(), "webui"),
    () => cancelTaskDirectly(b.db, getTask(b.db, fresh.id)!, null, b.clock.now(), {}, "webui"),
  );
  const completeResult = await duringPreparation(
    (githubAuth) => completeThroughHumanDoor({ ...deps(b), githubAuth }, started.id, FULL_HANDOFF, () => b.clock.now(), "webui"),
    () => cancelTaskDirectly(b.db, getTask(b.db, started.id)!, null, b.clock.now(), {}, "webui"),
  );

  expect(startResult).toEqual(refused("a settled task cannot be started"));
  expect(completeResult).toEqual(refused("a settled task cannot be completed"));
  expect(kinds(b.db, fresh.id)).not.toContain("task_work_started");
  expect(git(b.ws.path, "for-each-ref", `refs/heads/task/${fresh.id}`)).toBe("");
  expect([getTask(b.db, started.id)!.status, git(b.ws.path, "rev-parse", `task/${started.id}`), takenIn(b.db)]).toEqual(["cancelled", branch, []]);
});

it("done の後に作業台の tip が読んだものから動いていれば、作業台を残して text C7 を返す(pin C11)", async () => {
  const b = await board("complete-kept");
  const h = work(b, "write it myself", { assignee: HUMAN_ACTOR_ID });
  const path = await startedWithCommit(b, h);
  await prepareHumanWork(b.db, b.ws, h, "complete", { workspacesBaseDir: b.base, now: b.clock.now(), resolveRegistered: undefined, defaultWorkspaceName: b.ws.name });

  const notice = completeHumanWork(b.db, b.ws, getTask(b.db, h.id)!, b.base, { actorId: HUMAN_ACTOR_ID, origin: "webui" }, b.clock.now(), () => {
    completeTask(b.db, getTask(b.db, h.id)!, FULL_HANDOFF, HUMAN_ACTOR_ID, b.clock.now(), "webui");
    commitWork(path, "late.txt", "arrived after the read\n");
  });

  expect(notice).toBe(`completed. Commits reached the workbench at ${path} after the board read it and were not taken in; the workbench is kept. The task is done, so they do not enter through it.`);
  expect([getTask(b.db, h.id)!.status, existsSync(join(path, "late.txt"))]).toEqual(["done", true]);
  expect(() => git(b.ws.path, "show", `task/${h.id}:late.txt`)).toThrow();
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

it("書き始めた H の task/<H> への子の merge back の conflict は H 自身の作業台で受け、その Quarantine の回答は人間の書きかけの commit も取り込む —— 回答までは H の完了も拒まれる(pin C20・C6)", async () => {
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

it("子が走った後に assignee を human に替えた根は、タスクブランチを持つので完了に handoff の6欄が要り、取り込まずに閉じて子の成果は task/<根> に残る(#3418 のレビューの形 1a —— 着地は #3295)", async () => {
  const b = await board("root-switched-to-human");
  const root = work(b, "plan");
  await completedAgentChild(b, root, "child.txt", "child\n");
  editTask(b.db, getTask(b.db, root.id)!, { assignee: HUMAN_ACTOR_ID }, b.clock.now(), "webui");
  const branch = git(b.ws.path, "rev-parse", `task/${root.id}`);

  expect(!(await complete(b, root, {})).ok).toBe(true);
  expect((await complete(b, root)).ok).toBe(true);

  expect([git(b.ws.path, "rev-parse", `task/${root.id}`), git(b.ws.path, "show", `task/${root.id}:child.txt`), takenIn(b.db)]).toEqual([branch, "child", []]);
});
