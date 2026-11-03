import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { quarantineChecks } from "../src/human-verbs.js";
import { conventionCheckoutPath } from "../src/pickup-predicates.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, registerTask, type Task } from "../src/tasks.js";
import {
  boardRefWriter,
  commitRoomCopy,
  openExamineeCheckout,
  openInterviewRoom,
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
  refValues,
  releaseWorkspace,
  taskBranchExists,
  taskRunPlace,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { commitWork, dropBoardBeforeFold, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, poseAccepted, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 基準は切れない(ADR 0351 決定2): 行のある pickup は全撮りの代わりに比べ、release はタスクブランチの行を畳み、2値行は ref が持つ側に畳む(#2953)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-03T00:00:00.000Z");

function work(db: Db, title: string, parentId?: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done", parent_id: parentId }, NOW, ...HUMAN_WEBUI);
}

function row(db: Db, key: string): string | null | undefined {
  return db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(key) as string | null | undefined;
}

/** checkout の今の全 ref を基準の行と同じ形で(HEAD は指し先)。 */
function currentRefSet(path: string): Map<string, string> {
  return refValues(`symref=${git(path, "symbolic-ref", "HEAD")} HEAD\n${git(path, "for-each-ref", "--format=%(objectname) %(refname)")}`);
}

/** 1件を拾って commit し、完了の後始末で休止位置へ戻した workspace。 */
async function restedAfterCompletion(name: string) {
  const ws = await makeWorkspace(name);
  const db = openDb(":memory:");
  const done = work(db, "completes");
  await prepareWorkspaceAtPickup(db, ws, done);
  commitWork(ws.path, "done.txt", "done\n");
  completeTask(db, done, FULL_HANDOFF, "worker", NOW, "worker");
  releaseWorkspace(db, ws, done, NOW, false, undefined, undefined, true);
  expect(quarantineQuestion(db, "workspace", ws.name)).toBeUndefined();
  return { ws, db, done };
}

it("通常の完走の後に休止中の main へ載った不明な commit は、次の pickup が refs/heads/main を名指す workspace quarantine で止め、worker を起こさない(ADR 0351 決定2)", async () => {
  const { ws, db, done } = await restedAfterCompletion("rest-unknown-main");
  cancelTaskDirectly(db, done, null, NOW, {}, "webui");
  commitWork(ws.path, "by-hand.txt", "committed on main while the checkout rested\n");
  const moved = git(ws.path, "rev-parse", "main");
  const next = work(db, "would build on the unknown commit");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: () => {},
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspace: ws,
    resolveWorkspace: () => ws,
    workspacesDir: await tempDir("rest-unknown-main-rooms-"),
  });

  await clock.advance(HOURLY);
  await vi.waitFor(() => expect(quarantineQuestion(db, "workspace", ws.name)).toBeDefined());
  scheduler.stop();

  expect(quarantineQuestion(db, "workspace", ws.name)!.purpose).toContain(`now: ${moved} refs/heads/main`);
  expect(worker.started).toEqual([]);
  expect(taskBranchExists(ws, next.id)).toBe(false);
  db.close();
});

it.each([
  [
    "祖先のタスクブランチが動く",
    (ws: WorkspaceConfig, parent: Task) => {
      const ref = `refs/heads/task/${parent.id}`;
      git(ws.path, "update-ref", ref, git(ws.path, "commit-tree", `${ref}^{tree}`, "-p", ref, "-m", "by hand"));
      return ref;
    },
  ],
  [
    "タグが増える",
    (ws: WorkspaceConfig) => {
      git(ws.path, "tag", "v1");
      return "refs/tags/v1";
    },
  ],
  [
    "ブランチが消える",
    (ws: WorkspaceConfig, parent: Task) => {
      git(ws.path, "branch", "-D", `task/${parent.id}`);
      return `refs/heads/task/${parent.id}`;
    },
  ],
] as const)("休止中に%sと、次の pickup はその ref を名指して止まり、checkout を動かさない(ADR 0351 決定2 / ADR 0064 決定1)", async (_, move) => {
  const ws = await makeWorkspace("rest-moved-ref");
  const db = openDb(":memory:");
  const parent = work(db, "ancestor");
  await prepareWorkspaceAtPickup(db, ws, parent);
  commitWork(ws.path, "parent.txt", "parent\n");
  releaseWorkspace(db, ws, parent, NOW);
  const ref = move(ws, parent);
  const head = git(ws.path, "symbolic-ref", "HEAD");
  const child = work(db, "forks from the ancestor", parent.id);

  await expect(prepareWorkspaceAtPickup(db, ws, child)).rejects.toThrow(new RegExp(`(was|now): \\S+ ${ref}`));

  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe(head);
  expect(taskBranchExists(ws, child.id)).toBe(false);
  db.close();
});

it("休止中に何も動かなければ、次の pickup は通ってタスクブランチへ乗る(ADR 0351 決定2)", async () => {
  const { ws, db } = await restedAfterCompletion("rest-nothing-moved");
  const next = work(db, "next");

  await prepareWorkspaceAtPickup(db, ws, next);

  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${next.id}`);
  expect(refValues(row(db, ws.name)!)).toEqual(currentRefSet(ws.path));
  db.close();
});

it("remote-backed で休止中に remote の main だけが進めば、次の pickup は通り、fetch・休止位置の後の基準は全行が1値で現在値と一致する(ADR 0351 決定2・3)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("rest-remote-advanced");
  const db = openDb(":memory:");
  const earlier = work(db, "leaves a baseline");
  await prepareWorkspaceAtPickup(db, workspace, earlier);
  releaseWorkspace(db, workspace, earlier, NOW);
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  const next = work(db, "next");

  await prepareWorkspaceAtPickup(db, workspace, next);

  expect(git(workspace.path, "rev-parse", "main")).toBe(git(workspace.path, "rev-parse", "refs/remotes/origin/main"));
  expect(row(db, workspace.name)).not.toContain("|");
  expect(refValues(row(db, workspace.name)!)).toEqual(currentRefSet(workspace.path));
  db.close();
});

it.each([
  ["書く前に落ちた(ref は予告の前の値)", false],
  ["書いた後に落ちた(ref は予告した値)", true],
])("予告と畳みの間で%s2値行が残った pickup は通り、行は ref が持つ側の1値になる(ADR 0351 決定4 / ADR 0243 決定5)", async (_, written) => {
  const { ws, db } = await restedAfterCompletion("rest-announced-row");
  const ref = "refs/heads/keep";
  const sha = git(ws.path, "rev-parse", "main");
  const reopen = dropBoardBeforeFold(db);
  expect(() => boardRefWriter(db, ws)(ref, sha, () => (written ? git(ws.path, "update-ref", ref, sha) : undefined))).toThrow("the board dropped");
  reopen();
  expect(refValues(row(db, ws.name)!).get(ref)).toBe(`|${sha}`);

  await prepareWorkspaceAtPickup(db, ws, work(db, "next"));

  expect(refValues(row(db, ws.name)!).get(ref)).toBe(written ? sha : undefined);
  expect(row(db, ws.name)).not.toContain("|");
  db.close();
});

it("session 中に予告と畳みの間で落ちて2値行が残っても、release の比較は通り、行は ref が持つ側の1値になる(ADR 0351 決定4)", async () => {
  const ws = await makeWorkspace("release-announced-row");
  const db = openDb(":memory:");
  const task = work(db, "runs");
  await prepareWorkspaceAtPickup(db, ws, task);
  const ref = "refs/heads/keep";
  const sha = git(ws.path, "rev-parse", "main");
  const reopen = dropBoardBeforeFold(db);
  expect(() => boardRefWriter(db, ws)(ref, sha, () => git(ws.path, "update-ref", ref, sha))).toThrow("the board dropped");
  reopen();

  releaseWorkspace(db, ws, task, NOW);

  expect(quarantineQuestion(db, "workspace", ws.name)).toBeUndefined();
  expect(refValues(row(db, ws.name)!).get(ref)).toBe(sha);
  expect(row(db, ws.name)).not.toContain("|");
  db.close();
});

it.each([
  ["行が無い", () => {}],
  ["ref_snapshot が NULL の行がある", (db: Db, ws: WorkspaceConfig) => db.prepare("INSERT INTO workspace_state (name) VALUES (?)").run(ws.name)],
] as const)("%s pickup は最初の撮りをして通る(ADR 0351 決定2)", async (_, seed) => {
  const ws = await makeWorkspace("first-take");
  const db = openDb(":memory:");
  git(ws.path, "tag", "before-the-board");
  seed(db, ws);
  const task = work(db, "first pickup");

  await prepareWorkspaceAtPickup(db, ws, task);

  expect(refValues(row(db, ws.name)!)).toEqual(currentRefSet(ws.path));
  db.close();
});

it("基準の行が無い workspace の release は、今日どおり違反で workspace quarantine に落ちる(ADR 0064 決定6)", async () => {
  const ws = await makeWorkspace("release-without-row");
  const db = openDb(":memory:");
  const task = work(db, "never prepared");
  git(ws.path, "checkout", "-q", "-b", `task/${task.id}`);

  releaseWorkspace(db, ws, task, NOW);

  expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain("now: ");
  db.close();
});

/** 面接室を開いて root を1度拾って解放した盤面。`pose` なら出題した受験者も返す(受験者の checkout はまだ開かない)。 */
async function restedRoom(name: string, pose: boolean) {
  const db = openDb(":memory:");
  const ws = await makeWorkspace(name);
  const target = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: ws.name, interview_targets: [target] }, NOW, ...HUMAN_WEBUI);
  const base = await tempDir(`${name}-rooms-`);
  openInterviewRoom(db, root, base, NOW);
  const room = taskRunPlace(db, root, ws);
  await prepareWorkspaceAtPickup(db, room, root);
  const [examinee] = pose ? (poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", commitRoomCopy(db, room)) as [Task]) : [];
  releaseWorkspace(db, room, root, NOW);
  expect(quarantineQuestion(db, "workspace", root.id)).toBeUndefined();
  return { db, ws, root, room, base: dirname(room.path), examinee };
}

it("在り処が消えて手で `git init` し直した面接室を、受理の後に開き直す root の pickup は止まらない —— 未生の HEAD を補う空コミットは口を通る(ADR 0351 決定3 / ADR 0329 決定13)", async () => {
  const { db, ws, root, room, base } = await restedRoom("reopen-unborn-room", false);
  rmSync(room.path, { recursive: true, force: true });
  git(dirname(room.path), "init", "--quiet", room.path);
  quarantineWorkspace(db, root.id, new Error("the interview room's repository is gone"), NOW);
  await quarantineChecks({ db }).workspace!(root.id);

  openInterviewRoom(db, root, base, NOW);
  await prepareWorkspaceAtPickup(db, taskRunPlace(db, root, ws), root);

  expect(git(room.path, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
  expect(refValues(row(db, root.id)!)).toEqual(currentRefSet(room.path));
});

it("盤面が一度も開いていない受験者の checkout の在り処に repo があるまま面接室の名前の quarantine を受理しても、その受験者の最初の pickup は止まらない(ADR 0351 決定2)", async () => {
  const { db, ws, root, base, examinee } = await restedRoom("unopened-examinee-accept", true);
  const leftover = conventionCheckoutPath(examinee!.id, base);
  git(base, "init", "--quiet", "--initial-branch=main", leftover);
  git(leftover, "commit", "--quiet", "--allow-empty", "-m", "left here before the board opened it");
  quarantineWorkspace(db, root.id, new Error("repaired by hand"), NOW);
  await quarantineChecks({ db, workspacesDir: base }).workspace!(root.id);
  expect(row(db, examinee!.id)).toBeDefined();

  openExamineeCheckout(db, examinee!, base, NOW);
  const checkout = taskRunPlace(db, examinee!, ws);
  await prepareWorkspaceAtPickup(db, checkout, examinee!);

  expect(git(checkout.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${examinee!.id}`);
  expect(refValues(row(db, examinee!.id)!)).toEqual(currentRefSet(checkout.path));
});
