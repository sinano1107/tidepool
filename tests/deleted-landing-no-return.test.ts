import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "../src/actor-id.js";
import type { Db } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { startWorkThroughHumanDoor, submitAnswer } from "../src/human-verbs.js";
import { createLanding, type Landing, landingState } from "../src/landing.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { questionKindOf } from "../src/question-kind.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { getTask, hasTaskBranch, listBoard, listChildren, logDecision, registerTask, type Task } from "../src/tasks.js";
import { commitTriage, listLog, raiseObjection, startTriage } from "../src/triage.js";
import { queueReturnHandler, spawnFailureHandler } from "../src/watchdog.js";
import { refreshProtectedBranch, resolveTaskBranchLineage, type WorkspaceConfig } from "../src/workspace.js";
import { createWorkspace, deleteWorkspace } from "../src/workspace-create.js";
import { FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace } from "./harness.js";
import {
  attachUnsettledChild,
  boardEvents,
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
  type RegisteredReef,
  recordPrOpenedOutsideConvergence,
  reefWithPrRootAndChild,
  registeredReef,
  reRegister,
} from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0421 決定3・5 と Status 追記(#3895): 削除の扉が着地を終えた task は、終わりの記録より前に自身が保護ブランチへの到達の記録を持たなければ
// 帰り先の無い系譜の3つ目に数える。系譜の読みは、着地済みの祖先のブランチが名前の場所に無ければ飛ばす。domain 層の釘(ADR 0107)。

/** remote-backed の registry に登録した `reef` で PR #1 を開いた `external` の根(head は持たない —— 出元 repo の宣言は registry の commit を
 *  要る)。`door` は registry の refresh の token の await(扉の唯一の await)で `during` を撃ってから削除を通す。`register` は削除の後に
 *  `reef` を登録し直す: `fresh` は同じ repo の fresh clone(根のブランチが無い)、`other` は別の repo に向けた同じ checkout(在る)。 */
async function reefAwaitingRegistry() {
  const { db, clock } = await openBoard();
  const { workspace: old } = await makeRemoteBackedWorkspace("reef-old");
  const reef = await registeredReef(old, { remoteBacked: true });
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github });
  const work = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, reef.resolve("reef"), work, "feature.txt", "ready\n");
  const root = finish(db, clock, work);
  recordPrOpenedOutsideConvergence(db, root, 1, clock.now(), { authority: { merge: "external" }, workspace: old });
  const { window, githubAuth } = fetchHeldAtToken();
  const door = async (during: () => void) => {
    const deleting = deleteWorkspace({ name: "reef", confirm: true }, { ...reef.admin, db, githubAuth, ...deletionReaders(db, reef.resolve, landing) });
    await window.entered;
    during();
    window.open();
    await deleting;
  };
  const register = async (shape: "fresh" | "other") => {
    let path = old.path;
    if (shape === "fresh") {
      path = await tempDir("tidepool-reef-fresh-");
      git(path, "clone", "--quiet", old.repo!, ".");
      rmSync(old.path, { recursive: true, force: true });
    } else git(old.path, "remote", "set-url", "origin", (await makeRemoteBackedWorkspace("reef-other")).workspace.repo!);
    await createWorkspace({ name: "reef", mode: "register", path, confirm: true }, { ...reef.admin, db, githubAuth });
  };
  return { db, clock, reef, github, landing, root, door, register };
}

/** `reefWithPrRootAndChild` の checkout の fresh clone に、削除の扉 → 登録の扉で `reef` を登録し直す。 */
async function reRegisterOnFreshClone(c: Awaited<ReturnType<typeof reefWithPrRootAndChild>>) {
  const old = c.workspace;
  const path = await tempDir("tidepool-reef-fresh-");
  git(path, "clone", "--quiet", old.repo!, ".");
  git(path, "remote", "add", "head-repo", old.head_repo!);
  await reRegister(c.db, c.reef, { ...old, path }, () => rmSync(old.path, { recursive: true, force: true }), c.landing);
  return c.reef.resolve("reef");
}

/** scheduler の poll(収束を撃つ)を `times` 回回し、worker と console.error の spy を返す。 */
async function poll(c: { db: Db; clock: Awaited<ReturnType<typeof openBoard>>["clock"]; reef: Pick<RegisteredReef, "resolve" | "admin">; landing: Landing; github: FakeGitHubClient }, times = 1) {
  const containers = fakeContainers();
  const slot = new Slot();
  const worker = new ScriptedWorker(c.clock);
  const teardown = { db: c.db, clock: c.clock, slot, resolve: c.reef.resolve, pollNow: () => scheduler.pollNow() };
  const scheduler = startScheduler({
    db: c.db, clock: c.clock, slot, worker, containers, workspace: c.reef.resolve("reef"), github: c.github,
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
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  for (let i = 0; i < times; i++) await scheduler.rerunPoll();
  return { worker, errors };
}

const workChild = (db: Db, clock: { now(): Date }, parentId: string, assignee?: string) =>
  registerTask(db, { type: "work", title: "repair", purpose: "p", completion_criteria: "c", parent_id: parentId, assignee }, clock.now(), ...HUMAN_WEBUI);
const deletedReason = (task: Task) => `${deletedCause(task)}, so no repair can land`;
const openQuestionsOf = (db: Db, task: Task) => listChildren(db, task.id).filter(({ type, status }) => type === "question" && status === "todo");

/** `task` の pickup が、workspace の Quarantine でなく、出口が cancel だけのその task の失敗で止まり、理由が `cause` を言うこと。 */
function expectCancelOnlyFailure(db: Db, task: Task, cause: string) {
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
  expect(hasTaskBranch(db, task.id)).toBe(false);
  const [failure] = openQuestionsOf(db, task);
  expect(questionKindOf(failure!)).toMatchObject({ kind: "failure", cancel_option: "abandon" });
  expect(failure!.question_items?.[0]?.options).toEqual(["abandon"]);
  expect(failure!.purpose).toContain(`task ${task.id} has no branch to return to: ${cause}. Cancel task ${task.id}.`);
}

const deletedCause = (task: Task) => `the landing of "${task.title}" (${task.id}) ended when its workspace's registration was deleted, before its content reached the protected branch`;

it.each([
  ["同じ repo の fresh clone(根のブランチが無い)", "fresh"],
  ["別の repo に向けた同じ checkout(根のブランチが在る)", "other"],
] as const)("%s で登録し直しても、削除で着地が終わった根の下には work の子も異議の work の修理子も立たず、人間担当の work は書き始められず、registry の commit を待つ間に立った work の子と人間の review 子の pickup の出口は cancel で、RCA と記憶の修理子は立つ", async (_shape, shape) => {
  const c = await reefAwaitingRegistry();
  let child!: Task;
  let review!: Task;
  let human!: Task;
  await c.door(() => {
    child = attachUnsettledChild(c.db, c.clock, c.root.id);
    review = registerTask(c.db, { type: "review", title: "second opinion", purpose: "p", completion_criteria: "c", parent_id: c.root.id }, c.clock.now(), ...HUMAN_WEBUI);
    human = workChild(c.db, c.clock, c.root.id, HUMAN_ACTOR_ID);
  });
  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe("workspace_deleted");
  await c.register(shape);

  expect(() => workChild(c.db, c.clock, c.root.id)).toThrow(`no work task grows here: ${deletedReason(c.root)}`);
  const started = await startWorkThroughHumanDoor({ db: c.db, pollNow: () => {}, resolveWorkspace: c.reef.resolve, workspacesDir: join(c.reef.admin.workspacesBaseDir, "workbenches") }, human.id, () => c.clock.now(), "webui");
  expect(started).toEqual({ ok: false, failure: { kind: "domain_error", error: `cannot start work: ${deletedReason(c.root)}.` } });

  // 判断の行への異議: work の修理子は立たず、帰責の RCA は立つ(ADR 0301 決定3)
  const entry = logDecision(c.db, c.root, "ship this implementation", "worker", c.clock.now(), "worker");
  startTriage(c.db, c.clock.now());
  raiseObjection(c.db, entry, "redo it", c.clock.now());
  const before = listChildren(c.db, c.root.id).map(({ id }) => id);
  commitTriage(c.db, c.clock.now());
  expect(listLog(c.db).find(({ id }) => id === entry)?.no_work_repair).toBe(true);
  const grown = listChildren(c.db, c.root.id).filter(({ id }) => !before.includes(id));
  expect(grown.map(({ type, title }) => [type, title.split(":")[0]])).toEqual([
    ["review", "rca (self)"],
    ["review", "rca (auditor)"],
  ]);
  const memoryRepair = registerTask(c.db, { type: "memory_repair", title: "memory repair", purpose: "p", completion_criteria: "c", parent_id: c.root.id }, c.clock.now(), ...HUMAN_WEBUI);
  expect(getTask(c.db, memoryRepair.id)!.status).toBe("todo");

  const { worker } = await poll(c, 2);

  // 既に在る work の子と人間の review 子は、素の git エラーも workspace の Quarantine も立てず、その task の失敗で止まり、出口は cancel だけ
  expect(worker.started.map(({ id }) => id)).not.toContain(child.id);
  expect(worker.started.map(({ id }) => id)).not.toContain(review.id);
  expectCancelOnlyFailure(c.db, child, deletedCause(c.root));
  expectCancelOnlyFailure(c.db, review, deletedCause(c.root));
});

it("ブランチを失って死んだ祖先の下に既に在る work の子も、pickup は workspace の Quarantine でなくその task の失敗で止まり、出口は cancel だけ", async () => {
  const c = await reefWithPrRootAndChild();
  const child = attachUnsettledChild(c.db, c.clock, c.root.id);
  // give-up はこの子を倒すので、失われた event だけを盤面の書く形で置く —— 失われた sha が作成時と違い、到達の記録も無いので根は死んでいる
  const sha = git(c.workspace.path, "rev-parse", `task/${c.root.id}`);
  appendEvent(c.db, { taskId: c.root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_branch_lost", sha }, at: c.clock.now() });

  await poll(c);

  expectCancelOnlyFailure(c.db, child, `the work of "${c.root.title}" (${c.root.id}) was lost with its task branch when the lost refs were given up`);
});

/** `reefWithPrRootAndChild` の根の PR は GitHub で merge された。`observed` では盤面が外の merge を観測したが収束はまだ着地を終えていない ——
 *  削除の扉は根も子も終え、根だけが到達の記録(`pr_merge_observed`)を持つ。`landed` では収束が内容で根の着地を終えた(`landing_finished`)。 */
async function mergedRootAndChild(kind: "observed" | "landed" = "observed") {
  const c = await reefWithPrRootAndChild(kind === "observed" ? "escalate" : "external");
  await mergeOnGitHub(c.workspace, c.root.id);
  c.github.scriptMergedOutside(1);
  if (kind === "observed") await c.landing.tick("outside_merge");
  else {
    await refreshProtectedBranch(c.db, c.workspace, undefined, () => c.clock.now());
    await c.landing.converge();
  }
  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe(kind === "observed" ? "merge_observed" : "landed");
  return c;
}

it("削除の前に自身の到達の記録を持つ根は帰り先の無い系譜に数えず修理が立ち、その記録を継がない done の子は数える", async () => {
  const c = await mergedRootAndChild();

  await c.door();

  expect(landingState(c.db, getTask(c.db, c.child.id)!)).toBe("workspace_deleted");
  expect(getTask(c.db, workChild(c.db, c.clock, c.root.id).id)!.status).toBe("todo");
  expect(() => workChild(c.db, c.clock, c.child.id)).toThrow(`no work task grows here: ${deletedReason(c.child)}`);
});

it.each([
  ["収束が着地を終えた根", "landed"],
  ["削除の前に merge の観測を持つ根", "observed"],
] as const)("fresh clone で登録し直した名前で、%s の下に足した子は拾われて保護ブランチから分かれ、失われた event は書かれない", async (_root, kind) => {
  const c = await mergedRootAndChild(kind);
  const fresh = await reRegisterOnFreshClone(c);
  const added = workChild(c.db, c.clock, c.root.id);

  const { worker, errors } = await poll(c);

  expect(errors).not.toHaveBeenCalled();
  expect(worker.started.map(({ id }) => id)).toEqual([added.id]);
  expect(openQuarantineQuestion(c.db, "workspace", "reef")).toBeUndefined();
  expect(git(fresh.path, "rev-parse", `task/${added.id}`)).toBe(git(fresh.path, "rev-parse", "refs/remotes/origin/main"));
  expect([c.root, c.child, added].flatMap(({ id }) => boardEvents(c.db, id, "task_branch_lost"))).toEqual([]);
  expect(listBoard(c.db).filter((t) => t.type === "question" && t.status === "todo")).toEqual([]);
});

it("着地が終わっていない着地済みの祖先のブランチが名前の場所に無い場合は、今どおり基準との比較が先に止める", async () => {
  const c = await mergedRootAndChild();
  const added = workChild(c.db, c.clock, c.root.id);
  const rootTip = git(c.workspace.path, "rev-parse", `task/${c.root.id}`);
  git(c.workspace.path, "branch", "-D", `task/${c.root.id}`);

  const { worker } = await poll(c);

  expect(worker.started).toEqual([]);
  expect(hasTaskBranch(c.db, added.id)).toBe(false);
  expect(getTask(c.db, openQuarantineQuestion(c.db, "workspace", "reef")!.id)!.purpose).toContain(`was: ${rootTip} refs/heads/task/${c.root.id}`);
});

/** `place` の packed-refs に `ref` の壊れた行を並びの位置に置く —— for-each-ref の名指しの読みは、探す範囲の頭のこの行を黙って飛ばす。 */
function breakPackedRef(place: WorkspaceConfig, ref: string): void {
  const packed = join(place.path, ".git", "packed-refs");
  const [header, ...lines] = readFileSync(packed, "utf8").split("\n").filter(Boolean);
  const sorted = [...lines, `zzzz ${ref}`].sort((a, b) => (a.split(" ")[1]! < b.split(" ")[1]! ? -1 : 1));
  writeFileSync(packed, `${[header, ...sorted].join("\n")}\n`);
}

it.each([
  ["壊れた loose ref", "loose"],
  ["packed-refs の壊れた行", "packed"],
] as const)("着地済みの祖先のブランチが名前の場所で%sで読めなければ、系譜の読みは「無い」と読んで飛ばさずに投げる(ADR 0427 決定1)", async (_form, form) => {
  const c = await mergedRootAndChild("landed");
  const fresh = await reRegisterOnFreshClone(c);
  const added = workChild(c.db, c.clock, c.root.id);
  const ref = `refs/heads/task/${c.root.id}`;
  if (form === "loose") {
    mkdirSync(join(fresh.path, ".git", "refs", "heads", "task"), { recursive: true });
    writeFileSync(join(fresh.path, ".git", ref), "not a sha\n");
  } else breakPackedRef(fresh, ref);

  expect(() => resolveTaskBranchLineage(c.db, fresh, added, "refs/remotes/origin/main")).toThrow(
    form === "loose" ? `fatal: git show-ref: bad ref ${ref}` : `fatal: unexpected line in .git/packed-refs: zzzz ${ref}`,
  );
});

it("着地済みの祖先のブランチが名前の場所に在るかを読む前に、系譜の読みは基準と比べる(ADR 0370 決定1)", async () => {
  const c = await mergedRootAndChild("landed");
  const fresh = await reRegisterOnFreshClone(c);
  const added = workChild(c.db, c.clock, c.root.id);

  expect(() =>
    resolveTaskBranchLineage(c.db, fresh, added, "refs/remotes/origin/main", {
      beforeRefRead: () => {
        throw new Error("compared before reading the ancestor's branch");
      },
    }),
  ).toThrow("compared before reading the ancestor's branch");
});

it("purely-local の名前で local 着地を執行した根の下に、根のブランチが無い checkout で登録し直した後に足した子は、拾われて保護ブランチから分かれる", async () => {
  const { db, clock } = await openBoard();
  const old = await makeWorkspace("reef-local");
  const reef = await registeredReef(old);
  const github = new FakeGitHubClient();
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github: null });
  const root = await completeThroughTaskCheckout(db, clock, reef.resolve("reef"), landingWork(db, clock, "reef"), "feature.txt", "ready\n");
  await expect(convergeOn(landing, root.id)).resolves.toMatchObject({ form: "local_merge_question" });
  const question = getTask(db, openLocalMergeQuestions(db, root.id)[0]!.id)!;
  await submitAnswer({ db, pollNow: () => {}, landing, resolveWorkspace: reef.resolve, workspacesDir: await tempDir("tidepool-task-checkouts-") }, question, ["merge"], undefined, () => clock.now(), "webui");
  // 削除で基準の行が消えた後に、根のブランチを持たない checkout として登録し直す
  await reRegister(db, reef, old, () => git(old.path, "branch", "-D", `task/${root.id}`), landing);
  const added = workChild(db, clock, root.id);

  const { worker, errors } = await poll({ db, clock, reef, landing, github });

  expect(errors).not.toHaveBeenCalled();
  expect(worker.started.map(({ id }) => id)).toEqual([added.id]);
  expect(openQuarantineQuestion(db, "workspace", "reef")).toBeUndefined();
  expect(git(old.path, "rev-parse", `task/${added.id}`)).toBe(git(old.path, "rev-parse", "main"));
});
