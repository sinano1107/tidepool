import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { namePickupPredicates } from "../src/pickup-predicates.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, getTask, registerTask, type Task } from "../src/tasks.js";
import { boardRefWriter, catchUpTaskBranch, commitRoomCopy, firePickupPredicates, mergeTaskToProtected, quarantineWorkspace, recordTaskCheckoutTip, refValues, releaseWorkspace, type WorkspaceConfig, workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { CLEAN_LANDING_INTAKE, checkoutTaskBranch, commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace, openTestInterviewRoom, pickUpInterviewRoot, poseAccepted, prepareAtPickup, quarantineQuestion } from "./harness.js";
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

const BLOCKED_COMMANDS = ["post-checkout", "reference-transaction", "gpg"];

function installHookAndSigningProbes(ws: WorkspaceConfig): string {
  const hooks = join(ws.path, ".git", "custom-hooks");
  mkdirSync(hooks);
  for (const name of BLOCKED_COMMANDS) {
    writeFileSync(join(hooks, name), '#!/bin/sh\ntouch "$0.ran"\nexit 1\n', { mode: 0o755 });
  }
  git(ws.path, "config", "core.hooksPath", hooks);
  git(ws.path, "config", "commit.gpgsign", "true");
  git(ws.path, "config", "gpg.program", join(hooks, "gpg"));
  return hooks;
}

function expectHooksAndSigningInactive(hooks: string): void {
  for (const name of BLOCKED_COMMANDS) expect(existsSync(join(hooks, `${name}.ran`)), name).toBe(false);
}

// 旧: タスクブランチが名前の場所で checkout されていて、catch-up は worktree をその tip に追従させた
it.each([false, true])("catch-up advances the task branch ref in the named place without moving its HEAD or worktree (shallow: %s, ADR 0356 決定1・5 / ADR 0411 決定5)", async (shallow) => {
  const source = await makeWorkspace("gate-catch-up");
  const ws = { ...source };
  if (shallow) {
    commitWork(source.path, "shallow-base.txt", "the fork point\n");
    ws.path = await tempDir("gate-catch-up-shallow-");
    git(source.path, "clone", "--depth=1", `file://${source.path}`, ws.path);
    git(ws.path, "remote", "remove", "origin");
  }
  const db = openDb(":memory:");
  try {
    const task = work(db, "catch up");
    git(ws.path, "branch", `task/${task.id}`);
    commitWork(ws.path, "upstream.txt", "from main\n");
    if (shallow) {
      // ADR 0411 決定5: shallow な名前の場所は pickup で止まる。登録済みの shallow な workspace には pickup を通らない人間の扉が届くので、
      // merge-tree の隔離 view は shallow の境界を引き継ぐ —— task の commit は名前の場所で直に積む
      git(ws.path, "checkout", "--quiet", `task/${task.id}`);
      commitWork(ws.path, "task.txt", "from the task\n");
      git(ws.path, "checkout", "--quiet", "main");
    } else {
      const place = await prepareAtPickup(db, ws, task);
      commitWork(place.path, "task.txt", "from the task\n");
      releaseWorkspace(db, place, task, NOW);
    }
    const head = git(ws.path, "rev-parse", "HEAD");

    catchUpTaskBranch(db, ws, task.id, await tempDir("tidepool-task-checkouts-"));

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(head);
    expect(git(ws.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(ws.path, "task.txt"))).toBe(false);
    expect(git(ws.path, "show", `task/${task.id}:upstream.txt`)).toBe("from main");
    expect(git(ws.path, "show", `task/${task.id}:task.txt`)).toBe("from the task");
  } finally {
    db.close();
  }
});

it("merge back and parking ignore repo-local hooks, signing and merge drivers (ADR 0356 決定5)", async () => {
  const ws = await makeWorkspace("gate-merge-back-config");
  const db = openDb(":memory:");
  try {
    commitWork(ws.path, ".gitattributes", "shared.txt merge=probe\n");
    const shared = (first: string, last: string) => `${first}\na\nb\nc\nd\ne\n${last}\n`;
    commitWork(ws.path, "shared.txt", shared("base", "base"));
    const parent = work(db, "parent");
    const child = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, NOW, ...HUMAN_WEBUI);
    git(ws.path, "branch", `task/${child.id}`);
    checkoutTaskBranch(db, ws, parent.id);
    commitWork(ws.path, "shared.txt", shared("parent", "base"));
    git(ws.path, "checkout", "main");
    const place = await prepareAtPickup(db, ws, child);
    commitWork(place.path, "shared.txt", shared("base", "child"));
    recordTaskCheckoutTip(db, place, child.id);

    const hooks = installHookAndSigningProbes(ws);
    writeFileSync(join(hooks, "merge-driver"), '#!/bin/sh\ntouch "$0.ran"\nexit 1\n', { mode: 0o755 });
    git(ws.path, "config", "merge.probe.driver", `"${join(hooks, "merge-driver")}"`);

    releaseWorkspace(db, place, child, NOW, true, undefined, undefined, true);

    expect(existsSync(join(hooks, "merge-driver.ran"))).toBe(false);
    expectHooksAndSigningInactive(hooks);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "show", `task/${parent.id}:shared.txt`)).toBe(shared("parent", "child").trimEnd());
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(ws.path, "status", "--porcelain")).toBe("");
  } finally {
    db.close();
  }
});

it("local landing follows HEAD without executing a repo-local smudge command (ADR 0356 決定5)", async () => {
  const ws = await makeWorkspace("gate-landing-filter");
  const db = openDb(":memory:");
  try {
    const task = work(db, "land a filtered path");
    const place = await prepareAtPickup(db, ws, task);
    commitWork(place.path, ".gitattributes", "landed.txt filter=probe\n");
    commitWork(place.path, "landed.txt", "landed content\n");
    recordTaskCheckoutTip(db, place, task.id);
    releaseWorkspace(db, place, task, NOW, false, undefined, undefined, true);
    const other = work(db, "land a divergent change first");
    const otherPlace = await prepareAtPickup(db, ws, other);
    commitWork(otherPlace.path, "other.txt", "other content\n");
    recordTaskCheckoutTip(db, otherPlace, other.id);
    releaseWorkspace(db, otherPlace, other, NOW, false, undefined, undefined, true);
    mergeTaskToProtected(db, ws, other.id, CLEAN_LANDING_INTAKE);

    const hooks = installHookAndSigningProbes(ws);
    const script = join(ws.path, ".git", "smudge-probe");
    writeFileSync(script, '#!/bin/sh\ntouch "$0.ran"\ncat\n', { mode: 0o755 });
    git(ws.path, "config", "filter.probe.smudge", `"${script}"`);
    git(ws.path, "config", "core.splitIndex", "true");
    git(ws.path, "update-index", "--split-index");

    const { landed } = mergeTaskToProtected(db, ws, task.id, CLEAN_LANDING_INTAKE);

    expect(existsSync(`${script}.ran`)).toBe(false);
    expectHooksAndSigningInactive(hooks);
    expect(git(ws.path, "rev-parse", "HEAD")).toBe(landed);
    expect(git(ws.path, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(ws.path, "landed.txt"), "utf8")).toBe("landed content\n");
    expect(readFileSync(join(ws.path, "other.txt"), "utf8")).toBe("other content\n");
  } finally {
    db.close();
  }
});

it("local landing restores the old worktree when Git cannot lock the protected ref (ADR 0356 決定5)", async () => {
  const ws = await makeWorkspace("gate-landing-ref-lock");
  const db = openDb(":memory:");
  try {
    const task = work(db, "land with a blocked ref");
    const before = git(ws.path, "rev-parse", "HEAD");
    const place = await prepareAtPickup(db, ws, task);
    commitWork(place.path, "landed.txt", "landed content\n");
    recordTaskCheckoutTip(db, place, task.id);
    releaseWorkspace(db, place, task, NOW, false, undefined, undefined, true);
    const lock = join(ws.path, ".git", "refs", "heads", "main.lock");
    writeFileSync(lock, "");

    expect(() => mergeTaskToProtected(db, ws, task.id, CLEAN_LANDING_INTAKE)).toThrow("cannot lock ref");

    expect(git(ws.path, "rev-parse", "HEAD")).toBe(before);
    expect(git(ws.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(ws.path, "landed.txt"))).toBe(false);
    rmSync(lock);
    expect(mergeTaskToProtected(db, ws, task.id, CLEAN_LANDING_INTAKE).landed).toBe(git(ws.path, "rev-parse", "HEAD"));
  } finally {
    db.close();
  }
});

it("remote-backed の完了の後始末の merge back の fetch の後、基準の refs/remotes/origin/<protected> の行は fetch 先の1値で、休止位置の ff も違反と読まれない(#2459 項目1)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("gate-release");
  const db = openDb(":memory:");
  const task = work(db, "release with merge back");
  const place = await prepareAtPickup(db, workspace, task);
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  commitWork(place.path, "work.txt", "work\n");
  recordTaskCheckoutTip(db, place, task.id);
  const hooks = installHookAndSigningProbes(workspace);

  releaseWorkspace(db, place, task, NOW, true, undefined, undefined, true);

  expect(workspaceNeedsHuman(db, workspace.name)).toBe(false);
  expectHooksAndSigningInactive(hooks);
  expectRowsCurrent(db, workspace.name, workspace, ["refs/remotes/origin/main", "refs/heads/main"]);
  expect(readFileSync(join(workspace.path, "merged.txt"), "utf8")).toBe("landed on the remote\n");
  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  db.close();
});

it("parking can recreate a missing local protected branch from origin (ADR 0356 決定5)", async () => {
  const { workspace: ws, publish } = await makeRemoteBackedWorkspace("gate-missing-local-protected");
  const db = openDb(":memory:");
  try {
    git(ws.path, "checkout", "-b", "other");
    git(ws.path, "branch", "-D", "main");
    publish("remote.txt", "new remote content\n", "new remote commit");
    const task = work(db, "uses the remote fork source");

    releaseWorkspace(db, await prepareAtPickup(db, ws, task), task, NOW);

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
    expect(git(ws.path, "rev-parse", "main")).toBe(git(ws.path, "rev-parse", "origin/main"));
    expect(git(ws.path, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(ws.path, "remote.txt"), "utf8")).toBe("new remote content\n");
  } finally {
    db.close();
  }
});

it("fetch leaves loose objects unpacked and never runs pre-auto-gc (ADR 0356 決定5)", async () => {
  const { workspace: ws, publish } = await makeRemoteBackedWorkspace("gate-fetch-no-gc");
  const db = openDb(":memory:");
  try {
    const loose = [];
    git(ws.path, "checkout", "-b", "gc-fixture");
    for (let i = 0; loose.length < 2; i++) {
      const blob = `auto-gc fixture ${i}\n`;
      const sha = createHash("sha1").update(`blob ${blob.length}\0${blob}`).digest("hex");
      if (!sha.startsWith("17")) continue;
      const input = join(ws.path, `gc-${i}.txt`);
      writeFileSync(input, blob);
      git(ws.path, "add", input);
      loose.push(join(ws.path, ".git", "objects", "17", sha.slice(2)));
    }
    git(ws.path, "commit", "-m", "reachable auto-gc fixtures");
    git(ws.path, "checkout", "main");
    git(ws.path, "config", "gc.auto", "1");
    git(ws.path, "config", "maintenance.autoDetach", "false");
    git(ws.path, "config", "gc.autoDetach", "false");
    const marker = join(ws.path, ".git", "gc-ran");
    writeFileSync(join(ws.path, ".git", "hooks", "pre-auto-gc"), '#!/bin/sh\ntouch .git/gc-ran\nexit 1\n', { mode: 0o755 });
    git(ws.path, "-c", "maintenance.auto=true", "gc", "--auto");
    expect(existsSync(marker)).toBe(true);
    const boardMarker = join(ws.path, ".git", "board-gc-ran");
    writeFileSync(join(ws.path, ".git", "hooks", "pre-auto-gc"), '#!/bin/sh\ntouch .git/board-gc-ran\nexit 1\n', { mode: 0o755 });
    publish("remote.txt", "new remote content\n", "new remote commit");

    await prepareAtPickup(db, ws, work(db, "fetch without auto-gc"));

    expect(loose.every((path) => existsSync(path))).toBe(true);
    expect(existsSync(boardMarker)).toBe(false);
    expect(git(ws.path, "show", "main:remote.txt")).toBe("new remote content");
  } finally {
    db.close();
  }
});

// 旧: ensureTaskBranch が名前の場所の HEAD をタスクブランチへ動かし、基準の HEAD 行は pickup と休止の間で往復した(ADR 0345 決定2)
it("pickup の後、基準にタスクブランチの行(fork 元の sha)が予告どおりの1値で入り、HEAD の行は再開を跨いでも保護ブランチを指す(ADR 0351 決定3 / ADR 0356 決定1)", async () => {
  const ws = await makeWorkspace("gate-task-branch");
  const db = openDb(":memory:");
  const first = work(db, "leaves a baseline");
  releaseWorkspace(db, await prepareAtPickup(db, ws, first), first, NOW);
  const next = work(db, "forks from main");
  const branch = `refs/heads/task/${next.id}`;

  const place = await prepareAtPickup(db, ws, next);

  expect(baseline(db, ws.name).get(branch)).toBe(git(ws.path, "rev-parse", "main"));
  expect(baseline(db, ws.name).get("HEAD")).toBe("symref=refs/heads/main");

  // 再開: ブランチは在り、解放が着けた WIP の tip の1値に畳まれている。HEAD の行は動かない
  writeFileSync(join(place.path, "wip.txt"), "wip\n");
  releaseWorkspace(db, place, next, NOW);
  expect(baseline(db, ws.name).get(branch)).toBe(git(ws.path, "rev-parse", branch));
  await prepareAtPickup(db, ws, next);

  expect(baseline(db, ws.name).get(branch)).toBe(git(ws.path, "rev-parse", branch));
  expect(baseline(db, ws.name).get("HEAD")).toBe("symref=refs/heads/main");
  db.close();
});

it("Interview の root の pickup が読む実環境の fetch・休止位置の ff の後、その実環境の基準の行は1値で現在値と一致する(ADR 0351 決定3)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("gate-read-place");
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const earlier = work(db, "leaves a baseline on the real workspace");
  releaseWorkspace(db, await prepareAtPickup(db, workspace, earlier), earlier, clock.now());
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
  releaseWorkspace(db, await prepareAtPickup(db, workspace, earlier), earlier, NOW);
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  const published = git(workspace.path, "ls-remote", "origin", "refs/heads/main").split("\t")[0];
  // pickup の継続の門が休止位置の ff の直後に閉じる(#1973)—— タスクブランチを作る前の基準を読む
  const live = () => git(workspace.path, "rev-parse", "main") !== published;

  await prepareAtPickup(db, workspace, work(db, "parks first"), { live });

  expect(git(workspace.path, "rev-parse", "main")).toBe(published);
  expectRowsCurrent(db, workspace.name, workspace, ["refs/heads/main", "refs/remotes/origin/main"]);
  db.close();
});

it("pickup の fetch の後に休止位置が落ちても、基準の refs/remotes/origin/<protected> の行は fetch 先の1値で現在値と一致する(#2459 項目2・3)", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("gate-pickup");
  const db = openDb(":memory:");
  const earlier = work(db, "leaves a baseline");
  releaseWorkspace(db, await prepareAtPickup(db, workspace, earlier), earlier, NOW);
  publish("merged.txt", "landed on the remote\n", "merge on the remote");
  // ADR 0356 決定5: checkout hook は走らないので、履歴の分岐で ff を塞ぐ —— 分岐させる local の commit は盤面が口で書く(基準に入る)
  commitWork(workspace.path, "local.txt", "local commit\n");
  const local = git(workspace.path, "rev-parse", "main");
  git(workspace.path, "reset", "--quiet", "--hard", "main~1");
  boardRefWriter(db, workspace)("refs/heads/main", local, () => git(workspace.path, "reset", "--quiet", "--hard", local));

  await expect(prepareAtPickup(db, workspace, work(db, "never runs"))).rejects.toThrow("cannot fast-forward");

  expectRowsCurrent(db, workspace.name, workspace, ["refs/remotes/origin/main"]);
  db.close();
});

/** 面接室(行あり、休止位置)と、出題された未決着の受験者の task の checkout(面接室から開いた)。受験者は pickup の状態にしない
 *  —— 走行中の session があると受理が拒む。 */
async function roomWithPickedExaminee() {
  const db = openDb(":memory:");
  const workspace = await makeWorkspace("gate-examinee-real");
  const root = interviewRoot(db, workspace, NOW);
  openTestInterviewRoom(db, root);
  const { room, place: rootPlace } = await pickUpInterviewRoot(db, root, workspace);
  const head = commitRoomCopy(db, rootPlace, root.id);
  const [examinee] = poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", head) as [Task];
  releaseWorkspace(db, rootPlace, root, NOW);
  const checkout = await prepareAtPickup(db, room, examinee);
  const roomRow = () => db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(root.id);
  const examineeRow = () => db.prepare("SELECT 1 FROM workspace_state WHERE name = ?").get(examinee.id);
  return { db, root, room, examinee, checkout, roomRow, examineeRow, roomBefore: roomRow() };
}

// 旧: 受理の後半が受験者の checkout を休止させ、受験者 id の行が変わった(#2948 / ADR 0276 決定3)。ADR 0356 決定4 の後は基準は面接室だけが持つ
it("面接室の名前への受理の後半は面接室だけを撃ち、受験者 id の行は無く、面接室(root id)の行は変わらない(#2948 / ADR 0356 決定4)", async () => {
  const { db, root, room, roomRow, examineeRow, roomBefore } = await roomWithPickedExaminee();
  // 受理と同じ名前の項の後半だけを撃つ —— 誤った鍵の書き込みを、受理のほかの段の書き込みと混ぜずに読む(旧: 受理が最後に面接室の行を撮り直した、ADR 0351 決定4)
  const predicates = namePickupPredicates(db, root.id, room, dirname(room.path));
  const openers = predicates.filter((p) => !p.own);

  await firePickupPredicates(db, room, predicates, "after-open", { now: () => NOW });

  expect(openers.filter((p) => p.phase === "after-open")).toEqual([]);
  expect(examineeRow()).toBeUndefined();
  expect(roomRow()).toBe(roomBefore);
  db.close();
});

// 旧: 受験者の再開の pickup の after-open が checkout を休止させ、受験者 id の行が変わった(#2948)。ADR 0356 決定2・4 の後は再開も面接室を準備して作り直す
it("受験者の解放と再開の pickup は受験者 id の行を作らず、面接室(root id)の行も変えない(#2948 / ADR 0356 決定4)", async () => {
  const { db, room, examinee, checkout, roomRow, examineeRow, roomBefore } = await roomWithPickedExaminee();

  releaseWorkspace(db, checkout, examinee, NOW);
  await prepareAtPickup(db, room, examinee);

  expect(examineeRow()).toBeUndefined();
  expect(roomRow()).toBe(roomBefore);
  db.close();
});

// 旧: workspace quarantine の受理は、検査がすべて成立した後に基準を撮り直した(ADR 0351 決定4、#2951)。ADR 0373 決定1 の後、受理は全 ref が
// 基準と同じことを確かめるだけで撮り直さない —— 動いた ref は `repaired by hand` が拒み、`restore the baseline` が戻す。

/** 開いている workspace quarantine の question に人間が答える(human-verbs の回答の経路)。 */
function answerQuarantine(db: Db, ws: WorkspaceConfig, text = "repaired by hand") {
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  return submitAnswer({ db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db, workspace: ws }) }, question, [text], undefined, () => NOW, "webui");
}

/** session の間に名前の場所に兄弟のブランチが作られ、解放が `refs/heads/sibling` を名指して quarantine に落ちた workspace。
 *  旧: worker が名前の場所で兄弟のブランチを作った —— ADR 0356 決定4 の後、worker の ref の移動は task の checkout の中で
 *  基準に届かないので、名前の場所の ref を動かすのは worker 以外の手。 */
async function quarantinedBySibling(name: string) {
  const ws = await makeWorkspace(name);
  const db = openDb(":memory:");
  const task = work(db, "a sibling branch appears in the named place");
  const place = await prepareAtPickup(db, ws, task);
  git(ws.path, "branch", "sibling");
  releaseWorkspace(db, place, task, NOW);
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  expect(question.purpose).toContain("refs/heads/sibling");
  return { ws, db, question, answer: (text?: string) => answerQuarantine(db, ws, text) };
}

it("違反で名指された ref が残る間、`repaired by hand` はそれを名指して拒み、基準の行は変わらない(ADR 0373 決定1)", async () => {
  const { ws, db, question, answer } = await quarantinedBySibling("retake-on-accept");
  const before = baseline(db, ws.name);

  await expect(answer()).rejects.toThrow("refs/heads/sibling. The board does not accept moved refs.");

  expect(getTask(db, question.id)!.status).toBe("todo");
  expect(baseline(db, ws.name)).toEqual(before);
  expect(baseline(db, ws.name).has("refs/heads/sibling")).toBe(false);
  db.close();
});

it("`restore the baseline` の後の pickup は、違反で名指された ref を比較で名指さずに通る(ADR 0373 決定3)", async () => {
  const { ws, db, answer } = await quarantinedBySibling("retake-then-pickup");
  await answer("restore the baseline");
  const next = work(db, "after the answer");

  const place = await prepareAtPickup(db, ws, next);

  expect(git(place.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${next.id}`);
  expect(git(ws.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  db.close();
});

// 旧: 名前の場所での手の merge が受理され、基準にその位置が入った(ADR 0351 決定4)。ADR 0371 決定1・2 の後は作業台で merge して答え(pin A6)、
// 名前の場所での手の merge は動いた ref として拒まれる(ADR 0373 決定1)
it("ADR 0239 帰結の手の `git merge -s ours` を quarantine 中の名前の場所で行ってから答えると、`repaired by hand` はその branch を名指して拒み、基準は変わらない(ADR 0373 決定1)", async () => {
  const ws = await makeWorkspace("retake-merge-ours");
  const db = openDb(":memory:");
  const landing = work(db, "lands");
  const landingPlace = await prepareAtPickup(db, ws, landing);
  commitWork(landingPlace.path, "repair.txt", "base\n");
  releaseWorkspace(db, landingPlace, landing, NOW);
  const repair = registerTask(db, { type: "work", title: "repair", purpose: "why", completion_criteria: "done", parent_id: landing.id }, NOW, ...HUMAN_WEBUI);
  const repairPlace = await prepareAtPickup(db, ws, repair);
  commitWork(repairPlace.path, "repair.txt", "fixed\n");
  releaseWorkspace(db, repairPlace, repair, NOW);
  // 修理が分かれた後に帰り先が同じファイルを書く —— 修理の merge back が conflict する
  const resumedLanding = await prepareAtPickup(db, ws, landing);
  commitWork(resumedLanding.path, "repair.txt", "conflicting\n");
  releaseWorkspace(db, resumedLanding, landing, NOW);
  const resumedRepair = await prepareAtPickup(db, ws, repair);
  completeTask(db, repair, FULL_HANDOFF, "worker", NOW, "worker");
  releaseWorkspace(db, resumedRepair, getTask(db, repair.id)!, NOW, true);
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  expect(question.purpose).toContain(`task/${repair.id} does not merge cleanly`);
  const before = baseline(db, ws.name);
  git(ws.path, "checkout", `task/${landing.id}`);
  git(ws.path, "merge", "-s", "ours", "--no-edit", `task/${repair.id}`);
  const merged = git(ws.path, "rev-parse", `task/${landing.id}`);

  await expect(answerQuarantine(db, ws)).rejects.toThrow(`now: ${merged} refs/heads/task/${landing.id}`);

  expect(getTask(db, question.id)!.status).toBe("todo");
  expect(baseline(db, ws.name)).toEqual(before);
  db.close();
});

// 旧: `repaired by hand` で答えた —— ADR 0373 決定1 の後は残った兄弟の branch で比較が先に拒むので、違いを運ぶ `restore the baseline` で clean の検査まで届かせる
it("検査が落ちて回答が拒否されたとき、基準の行は変わらない(ADR 0373 決定1・3)", async () => {
  const { ws, db, answer } = await quarantinedBySibling("retake-refused");
  const row = () => db.prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?").pluck().get(ws.name);
  const before = row();
  writeFileSync(join(ws.path, "stray.txt"), "written while quarantined\n");

  await expect(answer("restore the baseline")).rejects.toThrow("still has uncommitted changes");

  expect(row()).toBe(before);
  db.close();
});

// 旧: 未決着の受験者の行もその checkout から撮り直した(ADR 0276 決定3)。ADR 0356 決定4 の後は受験者の task の checkout に基準は無い。
// 旧: 面接室の行は撮り直した(ADR 0351 決定4)—— ADR 0373 決定1 の後は比べるだけ
it("面接室の名前への受理は面接室だけを比べる —— 面接室で動いた ref は名指して拒み、受験者の task の checkout の ref は名指さず、どの行にも入らない(ADR 0373 決定1・7 / ADR 0356 決定4)", async () => {
  const { db, root, room, checkout, examineeRow } = await roomWithPickedExaminee();
  const before = baseline(db, root.id);
  git(checkout.path, "branch", "examinee-repair");
  git(room.path, "branch", "room-repair");

  const refused = quarantineChecks({ quarantineResolvers: {}, db }).workspace!(root.id, undefined, "webui").then(() => "accepted", (err: Error) => err.message);
  const message = await refused;
  git(room.path, "branch", "-D", "room-repair");
  await quarantineChecks({ quarantineResolvers: {}, db }).workspace!(root.id, undefined, "webui");

  expect(message).toContain("refs/heads/room-repair");
  expect(message).not.toContain("examinee-repair");
  expect(baseline(db, root.id)).toEqual(before);
  expect(baseline(db, root.id).has("refs/heads/examinee-repair")).toBe(false);
  expect(examineeRow()).toBeUndefined();
  db.close();
});

// 旧: 受理が帯域外の保護ブランチを基準に入れ、着地はそれを帯域外と読まなかった(ADR 0351 決定4)。ADR 0373 決定1 の後は `repaired by hand` が拒み、
// `restore the baseline` が保護ブランチを戻してから着地する
it("purely-local で quarantine 中に帯域外に動いた保護ブランチは `repaired by hand` が名指して拒み、`restore the baseline` の後の着地は帯域外と読まない(ADR 0373 決定1・3)", async () => {
  const ws = await makeWorkspace("retake-out-of-band-main");
  const db = openDb(":memory:");
  const task = work(db, "lands after the answer");
  const place = await prepareAtPickup(db, ws, task);
  commitWork(place.path, "feature.txt", "ready\n");
  releaseWorkspace(db, place, task, NOW);
  quarantineWorkspace(db, ws.name, new Error("GitHub token acquisition failed"), NOW);
  git(ws.path, "update-ref", "refs/heads/main", git(ws.path, "commit-tree", "main^{tree}", "-p", "main", "-m", "out of band"));

  await expect(answerQuarantine(db, ws)).rejects.toThrow("refs/heads/main. The board does not accept moved refs.");
  await answerQuarantine(db, ws, "restore the baseline");

  expect(() => mergeTaskToProtected(db, ws, task.id, CLEAN_LANDING_INTAKE)).not.toThrow();
  db.close();
});
