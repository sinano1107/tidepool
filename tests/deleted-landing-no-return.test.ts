import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { HUMAN_ACTOR_ID } from "../src/actor-id.js";
import type { Db } from "../src/db.js";
import { startWorkThroughHumanDoor } from "../src/human-verbs.js";
import { createLanding, type Landing, landingState } from "../src/landing.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { questionKindOf } from "../src/question-kind.js";
import { startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { getTask, hasTaskBranch, listBoard, listChildren, logDecision, registerTask, type Task } from "../src/tasks.js";
import { commitTriage, raiseObjection, startTriage } from "../src/triage.js";
import { queueReturnHandler, spawnFailureHandler } from "../src/watchdog.js";
import { refreshProtectedBranch, resolveTaskBranchLineage, type WorkspaceConfig } from "../src/workspace.js";
import { createWorkspace, deleteWorkspace } from "../src/workspace-create.js";
import { FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeLandingWorkspace, makeRemoteBackedWorkspace } from "./harness.js";
import {
  attachUnsettledChild,
  boardEvents,
  commitThroughTaskCheckout,
  deletionReaders,
  fetchHeldAtToken,
  finish,
  giveHeadRepo,
  landingWork,
  mergeOnGitHub,
  openBoard,
  pushPrHead,
  recordPrOpenedOutsideConvergence,
  registeredReef,
  settleRepairNotMergedBack,
  tearDownRepair,
} from "./landing-fixture.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0421 決定3・5 と Status 追記(#3895): 削除の扉が着地を終えた task は、終わりの記録より前に自身が保護ブランチへの到達の記録を持たなければ
// 帰り先の無い系譜の3つ目に数える。系譜の読みは、着地済みの祖先のブランチが名前の場所に無ければ飛ばす。domain 層の釘(ADR 0107)。

/** `reef` に登録した checkout で PR #1 を開いた根の盤面。`window` なら registry は remote-backed で、`door` は registry の refresh の token の
 *  await(扉の唯一の await)で `during` を撃ってから削除を通す —— 出元 repo の宣言は registry の commit を要るので、その盤面の根の PR は
 *  head を持たない。`window` でなければ出元 repo を持ち、根の PR の head は push してある。 */
async function reefBoard(merge: "external" | "escalate", { window: held = false } = {}) {
  const { db, clock } = await openBoard();
  const { workspace: old } = held ? await makeRemoteBackedWorkspace("reef-old") : await makeLandingWorkspace("reef-old");
  const reef = await registeredReef(old, { remoteBacked: held });
  if (!held) giveHeadRepo(db, reef, old.head_repo!);
  const github = new FakeGitHubClient();
  const workspace = reef.resolve("reef");
  const landing = createLanding({ defaultAgentName: "tako", db, clock, resolveWorkspace: reef.resolve, github });
  const work = landingWork(db, clock, "reef");
  await commitThroughTaskCheckout(db, clock, workspace, work, "feature.txt", "ready\n");
  const root = finish(db, clock, work);
  const head = held ? undefined : pushPrHead(github, workspace, root.id, 1);
  recordPrOpenedOutsideConvergence(db, root, 1, clock.now(), { authority: { merge }, head, workspace });
  const { window, githubAuth } = fetchHeldAtToken();
  const door = async (during = () => {}) => {
    const deleting = deleteWorkspace({ name: "reef", confirm: true }, { ...reef.admin, db, githubAuth, ...deletionReaders(db, reef.resolve, landing) });
    if (held) {
      await window.entered;
      during();
      window.open();
    }
    await deleting;
  };
  /** 削除の後に `reef` を登録し直す: `fresh` は同じ repo の fresh clone(根のブランチが無い)、`other` は別の repo に向けた同じ checkout(在る)。 */
  const reRegister = async (shape: "fresh" | "other") => {
    let moved: WorkspaceConfig;
    if (shape === "fresh") {
      const path = await tempDir("tidepool-reef-fresh-");
      git(path, "clone", "--quiet", old.repo!, ".");
      if (old.head_repo !== undefined) git(path, "remote", "add", "head-repo", old.head_repo);
      rmSync(old.path, { recursive: true, force: true });
      moved = { ...old, path };
    } else {
      const { workspace: other } = await makeRemoteBackedWorkspace("reef-other");
      git(old.path, "remote", "set-url", "origin", other.repo!);
      if (old.head_repo !== undefined) git(old.path, "remote", "remove", "head-repo");
      moved = { ...old, repo: other.repo, head_repo: undefined };
    }
    await createWorkspace({ name: "reef", mode: "register", path: moved.path, confirm: true }, { ...reef.admin, db, githubAuth });
    if (moved.head_repo !== undefined) giveHeadRepo(db, reef, moved.head_repo);
    return reef.resolve("reef");
  };
  return { db, clock, reef, workspace, github, landing, root, door, reRegister };
}

/** scheduler の poll(収束を撃つ)を1回回す。 */
async function poll(c: { db: Db; clock: Awaited<ReturnType<typeof openBoard>>["clock"]; reef: Awaited<ReturnType<typeof reefBoard>>["reef"]; landing: Landing; github: FakeGitHubClient }) {
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
  vi.spyOn(console, "error").mockImplementation(() => {});
  await scheduler.rerunPoll();
  return worker;
}

const workChild = (db: Db, clock: { now(): Date }, parentId: string, assignee?: string) =>
  registerTask(db, { type: "work", title: "repair", purpose: "p", completion_criteria: "c", parent_id: parentId, assignee }, clock.now(), ...HUMAN_WEBUI);
const deletedReason = (task: Task) => `the landing of "${task.title}" (${task.id}) ended when its workspace's registration was deleted, before its content reached the protected branch, so no repair can land`;
const openQuestionsOf = (db: Db, task: Task) => listChildren(db, task.id).filter(({ type, status }) => type === "question" && status === "todo");

it.each([
  ["同じ repo の fresh clone(根のブランチが無い)", "fresh"],
  ["別の repo に向けた同じ checkout(根のブランチが在る)", "other"],
] as const)("%s で登録し直しても、削除で着地が終わった根の下には work の子も異議の work の修理子も立たず、人間担当の work は書き始められず、registry の commit を待つ間に立った子の pickup の出口は cancel で、RCA と記憶の修理子は立つ", async (_shape, shape) => {
  const c = await reefBoard("external", { window: true });
  let child!: Task;
  let human!: Task;
  await c.door(() => {
    child = attachUnsettledChild(c.db, c.clock, c.root.id);
    human = workChild(c.db, c.clock, c.root.id, HUMAN_ACTOR_ID);
  });
  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe("workspace_deleted");
  await c.reRegister(shape);

  expect(() => workChild(c.db, c.clock, c.root.id)).toThrow(`no work task grows here: ${deletedReason(c.root)}`);
  const started = await startWorkThroughHumanDoor({ db: c.db, pollNow: () => {}, resolveWorkspace: c.reef.resolve, workspacesDir: join(c.reef.admin.workspacesBaseDir, "workbenches") }, human.id, () => c.clock.now(), "webui");
  expect(started).toEqual({ ok: false, failure: { kind: "domain_error", error: `cannot start work: ${deletedReason(c.root)}.` } });

  // 判断の行への異議: work の修理子は立たず、帰責の RCA は立つ(ADR 0301 決定3)
  const entry = logDecision(c.db, c.root, "ship this implementation", "worker", c.clock.now(), "worker");
  startTriage(c.db, c.clock.now());
  raiseObjection(c.db, entry, "redo it", c.clock.now());
  const before = listChildren(c.db, c.root.id).map(({ id }) => id);
  commitTriage(c.db, c.clock.now());
  const grown = listChildren(c.db, c.root.id).filter(({ id }) => !before.includes(id));
  expect(grown.map(({ type, title }) => [type, title.split(":")[0]])).toEqual([
    ["review", "rca (self)"],
    ["review", "rca (auditor)"],
  ]);
  const memoryRepair = registerTask(c.db, { type: "memory_repair", title: "memory repair", purpose: "p", completion_criteria: "c", parent_id: c.root.id }, c.clock.now(), ...HUMAN_WEBUI);
  expect(getTask(c.db, memoryRepair.id)!.status).toBe("todo");

  const worker = await poll(c);

  // 既に在る子は素の git エラーも workspace の Quarantine も立てず、その task の失敗で止まり、出口は cancel だけ
  expect(worker.started.map(({ id }) => id)).not.toContain(child.id);
  expect(openQuarantineQuestion(c.db, "workspace", "reef")).toBeUndefined();
  expect(hasTaskBranch(c.db, child.id)).toBe(false);
  const [failure] = openQuestionsOf(c.db, child);
  expect(questionKindOf(failure!)).toMatchObject({ kind: "failure", cancel_option: "abandon" });
  expect(failure!.question_items?.[0]?.options).toEqual(["abandon"]);
  expect(failure!.purpose).toContain(`task ${child.id} has no branch to return to: the landing of "${c.root.title}" (${c.root.id}) ended when its workspace's registration was deleted`);
  expect(failure!.purpose).not.toContain("lost refs");
});

/** PR #1 の根と、その下で merge back まで済んで収束が push した done の子。根の PR は GitHub で merge された。`observed` では盤面が外の merge を
 *  観測したが収束はまだ着地を終えていない —— 削除の扉は根も子も終え、根だけが到達の記録(`pr_merge_observed`)を持つ。`landed` では収束が
 *  内容で根の着地を終えた(`landing_finished`)。 */
async function mergedRootAndChild(kind: "observed" | "landed" = "observed") {
  const c = await reefBoard(kind === "observed" ? "escalate" : "external");
  const child = await settleRepairNotMergedBack(c.db, c.clock, c.workspace, c.root.id);
  tearDownRepair(c.db, c.clock, c.workspace, child);
  await c.landing.converge();
  await mergeOnGitHub(c.workspace, c.root.id);
  c.github.scriptMergedOutside(1);
  if (kind === "observed") await c.landing.tick("outside_merge");
  else {
    await refreshProtectedBranch(c.db, c.workspace, undefined, () => c.clock.now());
    await c.landing.converge();
  }
  expect(landingState(c.db, getTask(c.db, c.root.id)!)).toBe(kind === "observed" ? "merge_observed" : "landed");
  return { ...c, child: getTask(c.db, child.id)! };
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
  await c.door();
  const fresh = await c.reRegister("fresh");
  const added = workChild(c.db, c.clock, c.root.id);

  const worker = await poll(c);

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

  const worker = await poll(c);

  expect(worker.started).toEqual([]);
  expect(hasTaskBranch(c.db, added.id)).toBe(false);
  expect(getTask(c.db, openQuarantineQuestion(c.db, "workspace", "reef")!.id)!.purpose).toContain(`was: ${rootTip} refs/heads/task/${c.root.id}`);
});

it("着地済みの祖先のブランチが名前の場所で読めなければ、系譜の読みは「無い」と読んで飛ばさずに投げる(ADR 0427 決定1)", async () => {
  const c = await mergedRootAndChild("landed");
  await c.door();
  const fresh = await c.reRegister("fresh");
  const added = workChild(c.db, c.clock, c.root.id);
  mkdirSync(join(fresh.path, ".git", "refs", "heads", "task"), { recursive: true });
  writeFileSync(join(fresh.path, ".git", "refs", "heads", "task", c.root.id), "not a sha\n");

  expect(() => resolveTaskBranchLineage(c.db, fresh, added, "refs/remotes/origin/main")).toThrow(`git could not read a ref (warning: ignoring broken ref refs/heads/task/${c.root.id})`);
});
