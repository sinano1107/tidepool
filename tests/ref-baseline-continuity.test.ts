import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { quarantineChecks } from "../src/human-verbs.js";
import { conventionCheckoutPath } from "../src/pickup-predicates.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, getTask, registerTask, type Task } from "../src/tasks.js";
import { queueReturnHandler } from "../src/watchdog.js";
import {
  boardRefWriter,
  commitRoomCopy,
  openExamineeCheckout,
  openInterviewRoom,
  quarantineWorkspace,
  recordTaskCheckoutTip,
  releaseWorkspace,
  taskBranchExists,
  taskRunPlace,
  type WorkspaceConfig,
} from "../src/workspace.js";
import { FakeClock, FakeGitHubClient, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { commitWork, dropBoardBeforeFold, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, poseAccepted, prepareAtPickup, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 基準は切れない(ADR 0351 決定2): 行のある pickup は全撮りの代わりに比べ、release はタスクブランチの行を畳み、2値行は ref が持つ側に畳む(#2953)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-03T00:00:00.000Z");

function work(db: Db, title: string, parentId?: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done", parent_id: parentId }, NOW, ...HUMAN_WEBUI);
}

/** session 中に `move` で ref を動かしてから解放した結果の quarantine の本文 —— 基準の行がその ref をどの値で持つかを解放の比較で読む。 */
async function releaseAfter(db: Db, ws: WorkspaceConfig, move: () => void): Promise<string | undefined> {
  const task = work(db, "reads the baseline back");
  const place = await prepareAtPickup(db, ws, task);
  move();
  releaseWorkspace(db, place, task, NOW);
  return quarantineQuestion(db, "workspace", ws.name)?.purpose;
}

/** 1件を拾って commit し、完了の後始末で休止位置へ戻した workspace。 */
async function restedAfterCompletion(name: string) {
  const ws = await makeWorkspace(name);
  const db = openDb(":memory:");
  const done = work(db, "completes");
  const place = await prepareAtPickup(db, ws, done);
  commitWork(place.path, "done.txt", "done\n");
  recordTaskCheckoutTip(db, place, done.id);
  completeTask(db, done, FULL_HANDOFF, "worker", NOW, "worker");
  releaseWorkspace(db, place, done, NOW, false, undefined, undefined, true);
  expect(quarantineQuestion(db, "workspace", ws.name)).toBeUndefined();
  return { ws, db, done };
}

it("通常の完走の後に休止中の main へ載った帯域外の commit は、次の pickup の比較が refs/heads/main を名指す workspace quarantine で止め、repo アクセスの案内を付けず、task を位置を変えずに todo へ戻す(ADR 0351 決定2 / ADR 0274 / ADR 0067 決定2)", async () => {
  const { ws, db, done } = await restedAfterCompletion("rest-out-of-band-main");
  cancelTaskDirectly(db, done, null, NOW, {}, "webui");
  // GitHub を正本に宣言した場所: 準備の失敗なら修復の問い合わせが撃たれ、仲介の断りが案内として本文に載る
  git(ws.path, "remote", "add", "origin", "https://github.com/acme/widget.git");
  const declared = { ...ws, repo: "https://github.com/acme/widget" };
  const github = new FakeGitHubClient();
  const refusal = "the GitHub token broker refused a token for acme/widget (HTTP 404: repo_unreachable)";
  github.scriptUnreachable("acme/widget", refusal);
  commitWork(ws.path, "by-hand.txt", "committed on main while the checkout rested\n");
  const moved = git(ws.path, "rev-parse", "main");
  const next = work(db, "would build on the out-of-band commit");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const containers = fakeContainers();
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    db,
    clock,
    slot,
    worker,
    containers,
    github,
    onSpawnFailed: () => {},
    onRecordContainerFailed: () => {},
    onPickupStopped: queueReturnHandler({ db, clock, slot, resolve: () => declared, pollNow: () => scheduler.pollNow() }, containers),
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspace: declared,
    resolveWorkspace: () => declared,
    workspacesDir: await tempDir("rest-out-of-band-main-rooms-"),
  });

  await clock.advance(HOURLY);
  await vi.waitFor(() => expect(getTask(db, next.id)!.status === "todo" && quarantineQuestion(db, "workspace", ws.name)).toBeTruthy());
  scheduler.stop();

  const purpose = quarantineQuestion(db, "workspace", ws.name)!.purpose;
  expect(purpose).toContain(`now: ${moved} refs/heads/main`);
  expect(purpose).not.toContain(refusal);
  expect(github.repoAccessCalls).toBe(0);
  expect(getTask(db, next.id)).toMatchObject({ status: "todo", sort_key: next.sort_key });
  expect(listEvents(db, next.id).filter((e) => e.kind === "pickup_stopped")).toHaveLength(1);
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
  const parentPlace = await prepareAtPickup(db, ws, parent);
  commitWork(parentPlace.path, "parent.txt", "parent\n");
  releaseWorkspace(db, parentPlace, parent, NOW);
  const ref = move(ws, parent);
  const head = git(ws.path, "symbolic-ref", "HEAD");
  const child = work(db, "forks from the ancestor", parent.id);

  await expect(prepareAtPickup(db, ws, child)).rejects.toThrow(new RegExp(`(was|now): \\S+ ${ref}`));

  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe(head);
  expect(taskBranchExists(ws, child.id)).toBe(false);
  db.close();
});

// 旧: 次の pickup は名前の場所の HEAD をタスクブランチへ乗せた
it("休止中に何も動かなければ、次の pickup は通り、task の checkout がタスクブランチに乗って名前の場所は保護ブランチに居る(ADR 0351 決定2 / ADR 0356 決定1)", async () => {
  const { ws, db } = await restedAfterCompletion("rest-nothing-moved");
  const next = work(db, "next");

  const place = await prepareAtPickup(db, ws, next);

  expect(git(place.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${next.id}`);
  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  db.close();
});

it("remote-backed で休止中に remote の main だけが進めば、次の pickup は通り、fetch・休止位置の後の基準は fetch 先の1値だけを持つ —— 予告の前の値へ戻すと解放が名指す(ADR 0351 決定2・3)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("rest-remote-advanced");
  const db = openDb(":memory:");
  const earlier = work(db, "leaves a baseline");
  releaseWorkspace(db, await prepareAtPickup(db, workspace, earlier), earlier, NOW);
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  const before = git(workspace.path, "rev-parse", "main");

  const purpose = await releaseAfter(db, workspace, () => {
    expect(git(workspace.path, "rev-parse", "main")).toBe(git(workspace.path, "rev-parse", "refs/remotes/origin/main"));
    git(workspace.path, "update-ref", "refs/heads/main", before);
    git(workspace.path, "update-ref", "refs/remotes/origin/main", before);
  });

  expect(purpose).toContain(`now: ${before} refs/heads/main`);
  expect(purpose).toContain(`now: ${before} refs/remotes/origin/main`);
  db.close();
});

it.each([
  ["書く前に落ちた(ref は予告の前の値)", false],
  ["書いた後に落ちた(ref は予告した値)", true],
])("予告と畳みの間で%s2値行が残った pickup は通り、行は ref が持つ側の1値になる —— 予告のもう一方の値へ動かすと解放が名指す(ADR 0351 決定4 / ADR 0243 決定5)", async (_, written) => {
  const { ws, db } = await restedAfterCompletion("rest-announced-row");
  const ref = "refs/heads/keep";
  const sha = git(ws.path, "rev-parse", "main");
  const reopen = dropBoardBeforeFold(db);
  expect(() => boardRefWriter(db, ws)(ref, sha, () => (written ? git(ws.path, "update-ref", ref, sha) : undefined))).toThrow("the board dropped");
  reopen();

  const purpose = await releaseAfter(db, ws, () => (written ? git(ws.path, "update-ref", "-d", ref) : git(ws.path, "update-ref", ref, sha)));

  expect(purpose).toContain(written ? `was: ${sha} ${ref}` : `now: ${sha} ${ref}`);
  db.close();
});

it("session 中に予告と畳みの間で落ちて2値行が残っても、release の比較は通り、行は ref が持つ側の1値になる —— 休止中にもう一方の値へ動かすと次の pickup が名指す(ADR 0351 決定4)", async () => {
  const ws = await makeWorkspace("release-announced-row");
  const db = openDb(":memory:");
  const task = work(db, "runs");
  const place = await prepareAtPickup(db, ws, task);
  const ref = "refs/heads/keep";
  const sha = git(ws.path, "rev-parse", "main");
  const reopen = dropBoardBeforeFold(db);
  expect(() => boardRefWriter(db, ws)(ref, sha, () => git(ws.path, "update-ref", ref, sha))).toThrow("the board dropped");
  reopen();

  releaseWorkspace(db, place, task, NOW);
  expect(quarantineQuestion(db, "workspace", ws.name)).toBeUndefined();
  // 行が ref の持つ側(sha)の1値なら、予告のもう一方(無い)へ戻すと次の pickup が名指す
  git(ws.path, "update-ref", "-d", ref);

  await expect(prepareAtPickup(db, ws, work(db, "next"))).rejects.toThrow(`was: ${sha} ${ref}`);
  db.close();
});

it.each([
  ["行が無い", () => {}],
  ["ref_snapshot が NULL の行がある", (db: Db, ws: WorkspaceConfig) => db.prepare("INSERT INTO workspace_state (name) VALUES (?)").run(ws.name)],
] as const)("%s pickup は最初の撮りをして通り、撮った ref のその後の動きは解放が名指す(ADR 0351 決定2)", async (_, seed) => {
  const ws = await makeWorkspace("first-take");
  const db = openDb(":memory:");
  git(ws.path, "tag", "before-the-board");
  seed(db, ws);

  const purpose = await releaseAfter(db, ws, () => {
    git(ws.path, "tag", "-f", "before-the-board", git(ws.path, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "by hand"));
  });

  expect(purpose).toContain(`now: ${git(ws.path, "rev-parse", "before-the-board")} refs/tags/before-the-board`);
  db.close();
});

// 旧: pickup を経ずに名前の場所でタスクブランチへ checkout した workspace を解放した
it("基準の行が無い名前の場所の release は、今日どおり違反で workspace quarantine に落ちる(ADR 0064 決定6 / ADR 0356 決定4)", async () => {
  const ws = await makeWorkspace("release-without-row");
  const db = openDb(":memory:");
  const task = work(db, "baseline lost");
  const place = await prepareAtPickup(db, ws, task);
  db.exec("DELETE FROM workspace_state");

  releaseWorkspace(db, place, task, NOW);

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
  await prepareAtPickup(db, room, root);
  const [examinee] = pose ? (poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", commitRoomCopy(db, room)) as [Task]) : [];
  releaseWorkspace(db, room, root, NOW);
  expect(quarantineQuestion(db, "workspace", root.id)).toBeUndefined();
  return { db, ws, root, room, base: dirname(room.path), examinee };
}

it("在り処が消えて手で `git init` し直した面接室を、受理の後に開き直す root の pickup は止まらない —— 未生の HEAD を補う空コミットは口を通る(ADR 0351 決定3 / ADR 0329 決定13)", async () => {
  const { db, ws, root, room, base } = await restedRoom("reopen-unborn-room", false);
  rmSync(room.path, { recursive: true, force: true });
  git(dirname(room.path), "init", "--quiet", room.path);
  // 受理の検査(ADR 0351 決定4 の撮り直しまで)を撃つ —— question は立てない: 開き直しの後の解放が quarantine を立てないことを読む
  await quarantineChecks({ db }).workspace!(root.id);

  openInterviewRoom(db, root, base, NOW);
  await prepareAtPickup(db, taskRunPlace(db, root, ws), root);

  expect(git(room.path, "log", "-1", "--format=%s", "main")).toBe("Initial commit");
  releaseWorkspace(db, taskRunPlace(db, root, ws), root, NOW);
  expect(quarantineQuestion(db, "workspace", root.id)).toBeUndefined();
});

it("HEAD が orphan の branch にあって main が既に在る記録済みの面接室を開き直すと、空コミットは main を上書きせずに落ち、面接室の quarantine の理由になる(ADR 0351 決定3)", async () => {
  const { db, root, room, base } = await restedRoom("reopen-orphan-room", false);
  const main = git(room.path, "rev-parse", "main");
  git(room.path, "checkout", "-q", "--orphan", "elsewhere");

  expect(() => openInterviewRoom(db, root, base, NOW)).toThrow("refs/heads/main");

  expect(git(room.path, "rev-parse", "main")).toBe(main);
  expect(git(room.path, "symbolic-ref", "HEAD")).toBe("refs/heads/elsewhere");
});

it("盤面が一度も開いていない受験者の checkout の在り処に repo があるまま面接室の名前の quarantine を受理しても、その受験者の最初の pickup は止まらない(ADR 0351 決定2)", async () => {
  const { db, ws, root, base, examinee } = await restedRoom("unopened-examinee-accept", true);
  const leftover = conventionCheckoutPath(examinee!.id, base);
  git(base, "init", "--quiet", "--initial-branch=main", leftover);
  git(leftover, "commit", "--quiet", "--allow-empty", "-m", "left here before the board opened it");
  quarantineWorkspace(db, root.id, new Error("repaired by hand"), NOW);
  await quarantineChecks({ db, workspacesDir: base }).workspace!(root.id);

  openExamineeCheckout(db, examinee!, base, NOW);
  const checkout = taskRunPlace(db, examinee!, ws);
  await prepareAtPickup(db, checkout, examinee!);

  expect(git(checkout.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${examinee!.id}`);
});
