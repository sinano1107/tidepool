import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { DomainError } from "../src/domain-error.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { namePickupPredicates } from "../src/pickup-predicates.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, getTask, registerTask, type Task } from "../src/tasks.js";
import { commitRoomCopy, ensureTaskBranch, firePickupPredicates, mergeTaskToProtected, openExamineeCheckout, prepareWorkspaceAtPickup, quarantineWorkspace, refValues, releaseWorkspace, taskRunPlace, type WorkspaceConfig, workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, openTestInterviewRoom, poseAccepted, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 盤面自身の ref の書き込みは口(ADR 0243 決定4)を通り、基準の行は書いた値の1値に畳まれる(ADR 0351 決定3、#2950)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-03T00:00:00.000Z");

/** 基準の行(鍵は checkout の鍵)を refname → 値 で。 */
function baseline(db: Db, key: string): Map<string, string> {
  return refValues(db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(key) as string);
}

function work(db: Db, title: string) {
  return registerTask(db, { type: "work", title, purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
}

function interviewRoot(db: Db, workspace: WorkspaceConfig, now: Date) {
  const target = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
  return registerTask(db, { type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: workspace.name, interview_targets: [target] }, now, ...HUMAN_WEBUI);
}

/** 行の値が今の ref の値の1値であること。 */
function expectRowsCurrent(db: Db, key: string, ws: WorkspaceConfig, refs: string[]): void {
  const row = baseline(db, key);
  for (const ref of refs) expect([ref, row.get(ref)]).toEqual([ref, git(ws.path, "rev-parse", ref)]);
}

it("remote-backed の完了の後始末の merge back の fetch の後、基準の refs/remotes/origin/<protected> の行は fetch 先の1値で、休止位置の ff も違反と読まれない(#2459 項目1)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("gate-release");
  const db = openDb(":memory:");
  const task = work(db, "release with merge back");
  await prepareWorkspaceAtPickup(db, workspace, task);
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  commitWork(workspace.path, "work.txt", "work\n");

  releaseWorkspace(db, workspace, task, NOW, true, undefined, undefined, true);

  expect(workspaceNeedsHuman(db, workspace.name)).toBe(false);
  expectRowsCurrent(db, workspace.name, workspace, ["refs/remotes/origin/main", "refs/heads/main"]);
  db.close();
});

it("ensureTaskBranch の後、基準にタスクブランチの行(fork 元の sha)と HEAD の行(symref)が予告どおりの1値で入り、再開は HEAD の行を戻す(ADR 0351 決定3 / ADR 0345 決定2)", async () => {
  const ws = await makeWorkspace("gate-task-branch");
  const db = openDb(":memory:");
  const first = work(db, "leaves a baseline");
  await prepareWorkspaceAtPickup(db, ws, first);
  releaseWorkspace(db, ws, first, NOW);
  const next = work(db, "forks from main");
  const branch = `refs/heads/task/${next.id}`;

  ensureTaskBranch(db, ws, next);

  expect(baseline(db, ws.name).get(branch)).toBe(git(ws.path, "rev-parse", "main"));
  expect(baseline(db, ws.name).get("HEAD")).toBe(`symref=${branch}`);

  // 再開: ブランチは在り、HEAD だけが休止位置から戻る
  commitWork(ws.path, "wip.txt", "wip\n");
  releaseWorkspace(db, ws, next, NOW);
  expect(baseline(db, ws.name).get("HEAD")).toBe("symref=refs/heads/main");
  ensureTaskBranch(db, ws, next);

  expect(baseline(db, ws.name).get("HEAD")).toBe(`symref=${branch}`);
  db.close();
});

it("Interview の root の pickup が読む実環境の fetch・休止位置の ff の後、その実環境の基準の行は1値で現在値と一致する(ADR 0351 決定3)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("gate-read-place");
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const earlier = work(db, "leaves a baseline on the real workspace");
  await prepareWorkspaceAtPickup(db, workspace, earlier);
  releaseWorkspace(db, workspace, earlier, clock.now());
  cancelTaskDirectly(db, earlier, null, clock.now(), {}, "webui");
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  const root = interviewRoot(db, workspace, clock.now());
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
    workspace,
    resolveWorkspace: () => workspace,
    workspacesDir: await tempDir("gate-read-place-rooms-"),
  });

  await clock.advance(HOURLY);
  await vi.waitFor(() => expect(worker.started.map((t) => t.id)).toEqual([root.id]));
  scheduler.stop();

  expect(git(workspace.path, "rev-parse", "main")).toBe(git(workspace.path, "rev-parse", "refs/remotes/origin/main"));
  expectRowsCurrent(db, workspace.name, workspace, ["refs/remotes/origin/main", "refs/heads/main"]);
  db.close();
});

it("pickup の休止位置の ff の後、基準の保護ブランチの行は ff 先の1値で現在値と一致する(#2459 項目3)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("gate-pickup-park");
  const db = openDb(":memory:");
  const earlier = work(db, "leaves a baseline");
  await prepareWorkspaceAtPickup(db, workspace, earlier);
  releaseWorkspace(db, workspace, earlier, NOW);
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  const published = git(workspace.path, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
  // pickup の継続の門が休止位置の ff の直後に閉じる(#1973)—— タスクブランチを作る前の基準を読む
  const live = () => git(workspace.path, "rev-parse", "main") !== published;

  await prepareWorkspaceAtPickup(db, workspace, work(db, "parks first"), { live });

  expect(git(workspace.path, "rev-parse", "main")).toBe(published);
  expectRowsCurrent(db, workspace.name, workspace, ["refs/heads/main", "refs/remotes/origin/main"]);
  db.close();
});

it("pickup の fetch の後に休止位置が落ちても、基準の refs/remotes/origin/<protected> の行は fetch 先の1値で現在値と一致する(#2459 項目2・3)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("gate-pickup");
  const db = openDb(":memory:");
  const earlier = work(db, "leaves a baseline");
  await prepareWorkspaceAtPickup(db, workspace, earlier);
  releaseWorkspace(db, workspace, earlier, NOW);
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  // clean 検査と fetch の後、休止位置への checkout が呼ぶ hook で ff を塞ぐ(ADR 0351 決定5)。
  writeFileSync(join(workspace.path, ".git/hooks/post-checkout"), '#!/bin/sh\nprintf "left untracked on the host\\n" > merged.txt\n', { mode: 0o755 });

  await expect(prepareWorkspaceAtPickup(db, workspace, work(db, "never runs"))).rejects.toThrow("cannot fast-forward");

  expectRowsCurrent(db, workspace.name, workspace, ["refs/remotes/origin/main"]);
  db.close();
});

/** 面接室(行あり、休止位置)と、出題された未決着の受験者の checkout(行あり、自分のタスクブランチの上)。受験者は pickup の状態にしない
 *  —— 走行中の session があると受理が拒む。 */
async function roomWithPickedExaminee() {
  const db = openDb(":memory:");
  const workspace = await makeWorkspace("gate-examinee-real");
  const root = interviewRoot(db, workspace, NOW);
  openTestInterviewRoom(db, root);
  const room = taskRunPlace(db, root, workspace);
  await prepareWorkspaceAtPickup(db, room, root);
  const head = commitRoomCopy(db, room);
  const [examinee] = poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", head) as [Task];
  releaseWorkspace(db, room, root, NOW);
  openExamineeCheckout(db, examinee, dirname(room.path), NOW);
  const checkout = taskRunPlace(db, examinee, workspace);
  await prepareWorkspaceAtPickup(db, checkout, examinee);
  expect(baseline(db, examinee.id).get("HEAD")).toBe(`symref=refs/heads/task/${examinee.id}`);
  const roomRow = () => db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(root.id);
  return { db, root, room, examinee, checkout, roomRow, roomBefore: roomRow() };
}

it("面接室の名前への受理の後半が受験者の checkout を休止させると受験者 id の行が変わり、面接室(root id)の行は変わらない(#2948)", async () => {
  const { db, root, room, examinee, roomRow, roomBefore } = await roomWithPickedExaminee();
  // 受理と同じ名前の項の後半だけを撃つ —— 受理は最後に面接室の行を撮り直す(ADR 0351 決定4)ので、そこまで撃つと誤った鍵の書き込みが消える
  const { own, examinees } = namePickupPredicates(db, root.id, room, dirname(room.path));

  await firePickupPredicates(db, room, [...own, ...examinees], "after-open");

  expect(baseline(db, examinee.id).get("HEAD")).toBe("symref=refs/heads/main");
  expect(roomRow()).toBe(roomBefore);
  db.close();
});

it("受験者の再開の pickup の after-open が checkout を休止させると受験者 id の行が変わり、面接室(root id)の行は変わらない(#2948)", async () => {
  const { db, examinee, checkout, roomRow, roomBefore } = await roomWithPickedExaminee();
  // pickup の継続の門が休止の直後に閉じる(#1973)—— タスクブランチを作る前の基準を読む
  const live = () => git(checkout.path, "rev-parse", "--abbrev-ref", "HEAD") !== "main";

  await prepareWorkspaceAtPickup(db, checkout, examinee, { live });

  expect(baseline(db, examinee.id).get("HEAD")).toBe("symref=refs/heads/main");
  expect(roomRow()).toBe(roomBefore);
  db.close();
});

// ADR 0351 決定4: workspace quarantine の受理は、検査がすべて成立した後に基準を撮り直す(#2951)。

/** checkout の今の全 ref を基準の行と同じ形で(HEAD は指し先)。 */
function currentRefSet(path: string): Map<string, string> {
  return refValues(`symref=${git(path, "symbolic-ref", "HEAD")} HEAD\n${git(path, "for-each-ref", "--format=%(objectname) %(refname)")}`);
}

/** 開いている workspace quarantine の question に人間が答える(human-verbs の回答の経路)。 */
function answerQuarantine(db: Db, ws: WorkspaceConfig) {
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  return submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ db, workspace: ws }) }, question, ["repaired by hand"], undefined, () => NOW, "webui");
}

/** 拾って解放するとき worker が兄弟のブランチを作り、`refs/heads/sibling` を名指して quarantine に落ちた workspace。 */
async function quarantinedBySibling(name: string) {
  const ws = await makeWorkspace(name);
  const db = openDb(":memory:");
  const task = work(db, "wanders onto a sibling branch");
  await prepareWorkspaceAtPickup(db, ws, task);
  git(ws.path, "branch", "sibling");
  releaseWorkspace(db, ws, task, NOW);
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  expect(question.purpose).toContain("refs/heads/sibling");
  return { ws, db, question, answer: () => answerQuarantine(db, ws) };
}

it("受理の後、基準の行は違反で名指された ref を含む今の全 ref の1値と一致する(ADR 0351 決定4)", async () => {
  const { ws, db, question, answer } = await quarantinedBySibling("retake-on-accept");

  await answer();

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(baseline(db, ws.name)).toEqual(currentRefSet(ws.path));
  expect(baseline(db, ws.name).get("refs/heads/sibling")).toBe(git(ws.path, "rev-parse", "sibling"));
  db.close();
});

it("受理の後の pickup は、違反で名指された ref を比較で名指さずに通る(ADR 0351 決定2・4)", async () => {
  const { ws, db, answer } = await quarantinedBySibling("retake-then-pickup");
  await answer();
  const next = work(db, "after the answer");

  await prepareWorkspaceAtPickup(db, ws, next);

  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${next.id}`);
  db.close();
});

it("ADR 0239 帰結の手の `git merge -s ours` を quarantine 中の checkout で行ってから受理すると、基準にその merge 後の位置が入る(ADR 0351 決定4)", async () => {
  const ws = await makeWorkspace("retake-merge-ours");
  const db = openDb(":memory:");
  const landing = work(db, "lands");
  await prepareWorkspaceAtPickup(db, ws, landing);
  commitWork(ws.path, "repair.txt", "base\n");
  releaseWorkspace(db, ws, landing, NOW);
  const repair = registerTask(db, { type: "work", title: "repair", purpose: "why", completion_criteria: "done", parent_id: landing.id }, NOW, ...HUMAN_WEBUI);
  await prepareWorkspaceAtPickup(db, ws, repair);
  commitWork(ws.path, "repair.txt", "fixed\n");
  releaseWorkspace(db, ws, repair, NOW);
  // 修理が分かれた後に帰り先が同じファイルを書く —— 修理の merge back が conflict する
  await prepareWorkspaceAtPickup(db, ws, landing);
  commitWork(ws.path, "repair.txt", "conflicting\n");
  releaseWorkspace(db, ws, landing, NOW);
  await prepareWorkspaceAtPickup(db, ws, repair);
  completeTask(db, repair, FULL_HANDOFF, "worker", NOW, "worker");
  releaseWorkspace(db, ws, getTask(db, repair.id)!, NOW, true);
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  expect(question.purpose).toContain(`task/${repair.id} does not merge cleanly`);
  git(ws.path, "checkout", `task/${landing.id}`);
  git(ws.path, "merge", "-s", "ours", "--no-edit", `task/${repair.id}`);
  const merged = git(ws.path, "rev-parse", `task/${landing.id}`);

  await answerQuarantine(db, ws);

  expect(getTask(db, question.id)!.status).toBe("done");
  expect(baseline(db, ws.name).get(`refs/heads/task/${landing.id}`)).toBe(merged);
  expect(baseline(db, ws.name)).toEqual(currentRefSet(ws.path));
  db.close();
});

it("検査が落ちて回答が拒否されたとき、基準の行は変わらない(ADR 0351 決定4)", async () => {
  const { ws, db, answer } = await quarantinedBySibling("retake-refused");
  const row = () => db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(ws.name);
  const before = row();
  writeFileSync(join(ws.path, "stray.txt"), "written while quarantined\n");

  await expect(answer()).rejects.toThrow(DomainError);

  expect(row()).toBe(before);
  db.close();
});

it("面接室の名前への受理は面接室の行と未決着の受験者の行をそれぞれの checkout から撮り直し、受験者の値は面接室の行に入らない(ADR 0351 決定4)", async () => {
  const { db, root, room, examinee, checkout } = await roomWithPickedExaminee();
  git(room.path, "branch", "room-repair");
  git(checkout.path, "branch", "examinee-repair");

  await quarantineChecks({ db }).workspace!(root.id);

  expect(baseline(db, root.id)).toEqual(currentRefSet(room.path));
  expect(baseline(db, root.id).has("refs/heads/room-repair")).toBe(true);
  expect(baseline(db, examinee.id)).toEqual(currentRefSet(checkout.path));
  expect(baseline(db, examinee.id).has("refs/heads/examinee-repair")).toBe(true);
  expect([...baseline(db, root.id).keys()].filter((ref) => ref.includes("examinee-repair") || ref.includes(examinee.id))).toEqual([]);
  db.close();
});

it("purely-local で quarantine 中に帯域外に動いた保護ブランチは、受理の後の着地で帯域外と読まれない(ADR 0351 決定4)", async () => {
  const ws = await makeWorkspace("retake-out-of-band-main");
  const db = openDb(":memory:");
  const task = work(db, "lands after the answer");
  await prepareWorkspaceAtPickup(db, ws, task);
  commitWork(ws.path, "feature.txt", "ready\n");
  releaseWorkspace(db, ws, task, NOW);
  quarantineWorkspace(db, ws.name, new Error("GitHub token acquisition failed"), NOW);
  git(ws.path, "update-ref", "refs/heads/main", git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "out of band"));

  await answerQuarantine(db, ws);

  expect(() => mergeTaskToProtected(db, ws, task.id)).not.toThrow();
  db.close();
});
