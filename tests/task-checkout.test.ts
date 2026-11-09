import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { permissionConfig } from "../src/codex-worker.js";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { buildSandboxSettings } from "../src/sandbox.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { cancelTaskDirectly, completeTask, getTask, listChildren, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { completionTreePaths, RefsMovedError, recordTaskCheckoutTip, releaseWorkspace, runPlaceReadPaths, taskForkSource, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, prepareAtPickup, quarantineQuestion } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// task の checkout(ADR 0356): work / review の worker は名前の場所でなく、pickup ごとに作って解放で消す自分の repo で走る。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });
const NOW = new Date("2026-11-07T00:00:00.000Z");
let db: Db;
afterEach(() => db?.close());

function register(type: "work" | "review" = "work", parent_id?: string): Task {
  return registerTask(db, { type, title: type, purpose: "why", completion_criteria: "done", parent_id }, NOW, ...HUMAN_WEBUI);
}

async function pickedUp(name: string, type: "work" | "review" = "work") {
  const named = await makeWorkspace(name);
  db = openDb(":memory:");
  const task = register(type);
  const place = await prepareAtPickup(db, named, task);
  return { named, task, place, branch: `task/${task.id}` };
}

const objectsOf = (named: WorkspaceConfig) => realpathSync(join(named.path, ".git", "objects"));
const subjects = (named: WorkspaceConfig, ref: string) => git(named.path, "log", "--format=%s", ref).split("\n");

it("pickup は規約の番地(基点 / task id / pickup の event id)に task の checkout を開き、名前の場所の HEAD と tree は動かない(ADR 0356 決定1・2)", async () => {
  const named = await makeWorkspace("task-checkout-open");
  db = openDb(":memory:");
  const task = register();
  const base = await tempDir("tidepool-task-checkouts-");
  const place = await prepareAtPickup(db, named, task, { workspacesBaseDir: base });
  const branch = `task/${task.id}`;
  const pickup = listEvents(db, task.id).filter((e) => e.kind === "task_picked_up").at(-1)!;

  expect(place.path).toBe(realpathSync(join(base, task.id, String(pickup.id))));
  expect(realpathSync(place.path)).not.toBe(realpathSync(named.path));
  expect(readFileSync(join(place.path, ".git", "objects", "info", "alternates"), "utf8").trim()).toBe(objectsOf(named));
  expect(git(place.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/${branch}`);
  expect(git(place.path, "rev-parse", "HEAD")).toBe(git(named.path, "rev-parse", "main"));
  expect(git(named.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(git(named.path, "status", "--porcelain")).toBe("");
  const opened = listEvents(db, task.id).filter((e) => e.kind === "task_checkout_opened");
  expect(opened.map((e) => e.payload)).toEqual([{ kind: "task_checkout_opened", path: place.path, completion_gate: "recorded_tip" }]);
});

it("worker の .git/config の filter.clean は解放で走らず、WIP は未 commit の内容を持つ(ADR 0356 決定3)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-filter");
  const marker = join(await tempDir("tidepool-filter-marker-"), "ran");
  git(place.path, "config", "filter.x.clean", `touch ${marker}; cat`);
  writeFileSync(join(place.path, ".gitattributes"), "* filter=x\n");
  writeFileSync(join(place.path, "work.txt"), "uncommitted\n");

  releaseWorkspace(db, place, task, NOW);

  expect(existsSync(marker)).toBe(false);
  expect(git(named.path, "show", `${branch}:work.txt`)).toBe("uncommitted");
});

it("assume-unchanged の変更と info/exclude で隠した untracked は解放の WIP に載り、worktree の .gitignore が無視するものは載らない(ADR 0356 決定3)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-hidden");
  writeFileSync(join(place.path, ".gitignore"), "ignored.txt\n");
  commitWork(place.path, ".gitignore", "ignored.txt\n");
  writeFileSync(join(place.path, "README.md"), "changed behind assume-unchanged\n");
  git(place.path, "update-index", "--assume-unchanged", "README.md");
  mkdirSync(join(place.path, ".git", "info"), { recursive: true });
  writeFileSync(join(place.path, ".git", "info", "exclude"), "excluded.txt\n");
  writeFileSync(join(place.path, "excluded.txt"), "hidden by info/exclude\n");
  writeFileSync(join(place.path, "ignored.txt"), "declared ignored\n");
  // 完了の門(tip を引いてから読む)は隠した2つを名指す
  recordTaskCheckoutTip(db, place, task.id);
  expect(completionTreePaths(db, place, task.id).sort()).toEqual(["README.md", "excluded.txt"]);

  releaseWorkspace(db, place, task, NOW);

  expect(git(named.path, "show", `${branch}:README.md`)).toBe("changed behind assume-unchanged");
  expect(git(named.path, "show", `${branch}:excluded.txt`)).toBe("hidden by info/exclude");
  expect(git(named.path, "ls-tree", "--name-only", branch, "--", "ignored.txt")).toBe("");
});

it("解放の後、task の checkout は無く、名前の場所のタスクブランチは worker の commit の上に WIP を持ち、名前の場所には何も残らない(ADR 0356 決定2)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-release");
  commitWork(place.path, "work.txt", "work\n");
  const workerTip = git(place.path, "rev-parse", "HEAD");
  writeFileSync(join(place.path, "wip.txt"), "in progress\n");
  writeFileSync(join(place.path, ".gitignore"), "build/\n");
  mkdirSync(join(place.path, "build"));
  writeFileSync(join(place.path, "build", "out.js"), "generated\n");

  releaseWorkspace(db, place, task, NOW);

  expect(existsSync(place.path)).toBe(false);
  expect(existsSync(dirname(place.path))).toBe(false);
  expect(git(named.path, "rev-parse", `${branch}^`)).toBe(workerTip);
  expect(subjects(named, branch)[0]).toBe(`WIP: task ${task.id} — work`);
  expect(git(named.path, "status", "--porcelain", "--ignored", "--untracked-files=all")).toBe("");
  expect(git(named.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
});

it("worker がタスクブランチを消した checkout の解放は task の失敗で、checkout を残し名前の場所を quarantine しない(ADR 0356 決定2)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-branch-gone");
  const before = git(named.path, "rev-parse", branch);
  git(place.path, "checkout", "--quiet", "-b", "elsewhere");
  git(place.path, "branch", "-D", branch);

  releaseWorkspace(db, place, task, NOW);

  expect(existsSync(join(place.path, ".git"))).toBe(true);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(git(named.path, "rev-parse", branch)).toBe(before);
  const failed = listEvents(db, task.id).find((e) => e.kind === "task_checkout_release_failed");
  expect(failed?.payload).toMatchObject({ path: place.path, reason: expect.stringContaining(`has no branch ${branch}`) });
  const [question] = listChildren(db, task.id);
  expect(question).toMatchObject({ type: "question", question_cancel_option: "abandon" });
  expect(getTask(db, task.id)?.status).toBe("todo");

  // 倒された session(failure question が既に開いている)には足さない
  releaseWorkspace(db, place, task, NOW);
  expect(listChildren(db, task.id)).toHaveLength(1);
});

it("worker が自分の .git を消した checkout の解放は task の失敗で、残りを消さず名前の場所を quarantine しない(ADR 0356 決定2)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-git-gone");
  const before = git(named.path, "rev-parse", branch);
  writeFileSync(join(place.path, "unfinished.txt"), "work the board can no longer read\n");
  rmSync(join(place.path, ".git"), { recursive: true });

  releaseWorkspace(db, place, task, NOW);

  expect(readFileSync(join(place.path, "unfinished.txt"), "utf8")).toBe("work the board can no longer read\n");
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(git(named.path, "rev-parse", branch)).toBe(before);
  expect(listEvents(db, task.id).find((e) => e.kind === "task_checkout_release_failed")?.payload).toMatchObject({ path: place.path });
  expect(listChildren(db, task.id)).toEqual([expect.objectContaining({ type: "question", question_cancel_option: "abandon" })]);
});

it("cancelled の解放で読めない checkout は、唯一の写しを残して question を立てない(ADR 0359 派生)", async () => {
  const { named, task, place } = await pickedUp("task-checkout-cancelled");
  const survivingFile = join(place.path, "unfinished.txt");
  writeFileSync(survivingFile, "only surviving copy\n");
  rmSync(join(place.path, ".git"), { recursive: true });
  cancelTaskDirectly(db, task, null, NOW, {}, "webui");

  releaseWorkspace(db, place, getTask(db, task.id)!, NOW);

  expect(getTask(db, task.id)?.status).toBe("cancelled");
  expect(readFileSync(survivingFile, "utf8")).toBe("only surviving copy\n");
  expect(listEvents(db, task.id).filter(({ kind }) => kind.startsWith("task_checkout_")).map(({ kind }) => kind)).toEqual([
    "task_checkout_opened",
    "task_checkout_release_failed",
  ]);
  expect(listChildren(db, task.id)).toEqual([]);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
});

it("名前の場所の ref を書けなければ完了の門は拒み、lock を外して完了すると merge back する(ADR 0359 決定1)", async () => {
  const named = await makeWorkspace("task-checkout-gate-observation");
  db = openDb(":memory:");
  const parent = register();
  git(named.path, "branch", `task/${parent.id}`, "main");
  const child = pickupTask(db, register("work", parent.id), "deckhand", NOW)!;
  const place = await prepareAtPickup(db, named, child);
  commitWork(place.path, "child.txt", "child\n");
  const lock = join(named.path, ".git", "refs", "heads", "task", `${child.id}.lock`);
  writeFileSync(lock, "");

  expect(() => recordTaskCheckoutTip(db, place, child.id)).toThrow(/cannot lock ref/);
  expect(git(named.path, "ls-tree", "--name-only", `task/${child.id}`)).not.toContain("child.txt");
  expect(getTask(db, child.id)?.status).toBe("in_progress");
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(existsSync(join(place.path, ".git"))).toBe(true);

  rmSync(lock);
  recordTaskCheckoutTip(db, place, child.id);
  completeTask(db, child, FULL_HANDOFF, "worker", NOW, "worker");
  releaseWorkspace(db, place, getTask(db, child.id)!, NOW, true, undefined, undefined, true);
  expect(git(named.path, "show", `task/${parent.id}:child.txt`)).toBe("child");
  expect(existsSync(place.path)).toBe(false);
});

it("fork 元は根なら保護ブランチ、子なら親の work branch の sha で、pickup がタスクブランチを切った sha と同じ(ADR 0362 決定2 / ADR 0053)", async () => {
  const named = await makeWorkspace("task-checkout-fork-source");
  db = openDb(":memory:");
  const parent = register();
  git(named.path, "switch", "-c", `task/${parent.id}`);
  commitWork(named.path, "parent.txt", "parent\n");
  git(named.path, "switch", "main");
  const child = pickupTask(db, register("work", parent.id), "deckhand", NOW)!;
  const root = register();

  await prepareAtPickup(db, named, child);
  await prepareAtPickup(db, named, root);

  expect(taskForkSource(db, named, child)).toBe(git(named.path, "rev-parse", `task/${parent.id}`));
  expect(git(named.path, "rev-parse", `task/${child.id}`)).toBe(taskForkSource(db, named, child));
  expect(taskForkSource(db, named, root)).toBe(git(named.path, "rev-parse", "main"));
  expect(git(named.path, "rev-parse", `task/${root.id}`)).toBe(taskForkSource(db, named, root));
});

it("完了の門をやり直すと、先に引いた commit ではなく現在の worker tip を記録する(ADR 0359 決定1)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-gate-rewind");
  const base = git(place.path, "rev-parse", "HEAD");
  commitWork(place.path, "first-attempt.txt", "superseded\n");
  recordTaskCheckoutTip(db, place, task.id);
  expect(git(named.path, "rev-parse", branch)).toBe(git(place.path, "rev-parse", "HEAD"));

  git(place.path, "reset", "--hard", base);
  recordTaskCheckoutTip(db, place, task.id);

  expect(git(named.path, "rev-parse", branch)).toBe(base);
});

it("完了の門は人間が進めた名前の場所のタスクブランチを上書きしない(ADR 0351 決定1 / ADR 0359 決定4)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-gate-human-ref");
  const ref = `refs/heads/${branch}`;
  git(named.path, "switch", branch);
  commitWork(named.path, "human.txt", "human work\n");
  const humanTip = git(named.path, "rev-parse", "HEAD");
  git(named.path, "switch", "main");

  expect(() => recordTaskCheckoutTip(db, place, task.id)).toThrow(RefsMovedError);

  expect(git(named.path, "rev-parse", ref)).toBe(humanTip);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(existsSync(place.path)).toBe(true);
});

it("完了の門は同じ SHA を指す symbolic ref を通じて別のブランチを書かない(ADR 0081 / ADR 0359 決定4)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-gate-symref");
  const ref = `refs/heads/${branch}`;
  const before = git(named.path, "rev-parse", "main");
  commitWork(place.path, "worker.txt", "worker work\n");
  git(named.path, "symbolic-ref", ref, "refs/heads/main");

  expect(() => recordTaskCheckoutTip(db, place, task.id)).toThrow(RefsMovedError);

  expect(git(named.path, "symbolic-ref", ref)).toBe("refs/heads/main");
  expect(git(named.path, "rev-parse", "main")).toBe(before);
});

it("session の間に名前の場所の HEAD を人間が動かせば、解放は保護ブランチへ黙って戻さず quarantine に落ちる(ADR 0351 / ADR 0356 決定1)", async () => {
  const { named, task, place } = await pickedUp("task-checkout-human-switch");
  git(named.path, "switch", "--quiet", "-c", "human-branch");

  releaseWorkspace(db, place, task, NOW);

  expect(quarantineQuestion(db, "workspace", named.name)?.purpose).toContain("symref=refs/heads/human-branch HEAD");
  expect(git(named.path, "symbolic-ref", "HEAD")).toBe("refs/heads/human-branch");
});

it("再開は残した checkout を再利用せず、新しい番地に作り直す(ADR 0356 決定2)", async () => {
  const { named, task, place } = await pickedUp("task-checkout-resume");
  git(place.path, "checkout", "--quiet", "-b", "elsewhere");
  git(place.path, "branch", "-D", `task/${task.id}`);
  releaseWorkspace(db, place, task, NOW);

  const resumed = await prepareAtPickup(db, named, getTask(db, task.id)!);

  expect(resumed.path).not.toBe(place.path);
  expect(existsSync(join(place.path, ".git"))).toBe(true);
  expect(git(resumed.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${task.id}`);
});

/** scheduler の pickup を1回撃つ。worker は start されず、spawn の失敗(host 側の停止)の一撃だけを数える。 */
async function scheduledPickup(named: WorkspaceConfig, workspacesDir: string) {
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const spawnFailures: string[] = [];
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    workspacesDir,
    converge: async () => [],
    db,
    clock,
    slot: new Slot(),
    worker,
    containers: fakeContainers(),
    onSpawnFailed: (taskId) => spawnFailures.push(taskId),
    onRecordContainerFailed: () => {},
    onPickupStopped: () => {},
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspace: named,
    resolveWorkspace: () => named,
  });
  await clock.advance(HOURLY);
  await vi.waitFor(() => expect(quarantineQuestion(db, "workspace", named.name) !== undefined || spawnFailures.length > 0).toBe(true));
  scheduler.stop();
  expect(worker.started).toEqual([]);
  return spawnFailures;
}

it("pickup の fetch が名前の場所の objects の破損で落ちれば名前の場所を quarantine し、番地に repo を作れないのは quarantine しない host 側の停止(ADR 0356 決定2)", async () => {
  const named = await makeWorkspace("task-checkout-broken-source");
  db = openDb(":memory:");
  register();
  const blob = git(named.path, "rev-parse", "main:README.md");
  rmSync(join(named.path, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
  expect(await scheduledPickup(named, await tempDir("tidepool-task-checkouts-"))).toEqual([]);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeDefined();
  db.close();

  const healthy = await makeWorkspace("task-checkout-unwritable");
  db = openDb(":memory:");
  const task = register();
  const base = await tempDir("tidepool-task-checkouts-");
  writeFileSync(join(base, task.id), "a file where the task's directory goes\n");
  expect(await scheduledPickup(healthy, base)).toEqual([task.id]);
  expect(quarantineQuestion(db, "workspace", healthy.name)).toBeUndefined();
  expect(listEvents(db, task.id).find((e) => e.kind === "spawn_failed")?.payload).toMatchObject({ message: expect.stringContaining("cannot be created") });
  expect(git(healthy.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

it("登録前から名前の場所の info/exclude が隠す人間のファイルは、休止の clean 検査を落とさない —— 名前の場所は自分の git で読む(ADR 0356 決定3)", async () => {
  const named = await makeWorkspace("task-checkout-human-exclude");
  db = openDb(":memory:");
  writeFileSync(join(named.path, ".git", "info", "exclude"), ".env\n");
  writeFileSync(join(named.path, ".env"), "SECRET=human\n");
  const first = register();
  const place = await prepareAtPickup(db, named, first);
  releaseWorkspace(db, place, first, NOW);

  await prepareAtPickup(db, named, register());

  expect(readFileSync(join(named.path, ".env"), "utf8")).toBe("SECRET=human\n");
});

it("task の checkout の中の ref の移動は解放で quarantine にならず、休止中の名前の場所の ref の移動は pickup で止まる(ADR 0356 決定4 / ADR 0351)", async () => {
  const { named, task, place } = await pickedUp("task-checkout-refs");
  git(place.path, "tag", "worker-tag");
  git(place.path, "branch", "scratch");

  releaseWorkspace(db, place, task, NOW);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();

  git(named.path, "tag", "human-tag");
  const failure = await prepareAtPickup(db, named, register()).catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(RefsMovedError);
  expect((failure as Error).message).toContain("refs/tags/human-tag");
});

it("子は名前の場所の親のブランチから fork し、子の done の解放が親のブランチを進め、親の再開の checkout はその tip に立つ(ADR 0356 決定6)", async () => {
  const named = await makeWorkspace("task-checkout-lineage");
  db = openDb(":memory:");
  const parent = register();
  const parentPlace = await prepareAtPickup(db, named, parent);
  commitWork(parentPlace.path, "parent.txt", "parent\n");
  releaseWorkspace(db, parentPlace, parent, NOW);
  const parentTip = git(named.path, "rev-parse", `task/${parent.id}`);

  const child = register("work", parent.id);
  const childPlace = await prepareAtPickup(db, named, child);
  expect(git(childPlace.path, "rev-parse", "HEAD")).toBe(parentTip);
  commitWork(childPlace.path, "child.txt", "child\n");
  // 完了の門が tip を名前の場所へ引く(`completionGatedPlace` の前半)
  recordTaskCheckoutTip(db, childPlace, child.id);
  completeTask(db, child, FULL_HANDOFF, "worker", NOW, "worker");
  releaseWorkspace(db, childPlace, getTask(db, child.id)!, NOW, true, undefined, undefined, true);
  const advanced = git(named.path, "rev-parse", `task/${parent.id}`);
  expect(git(named.path, "show", `${advanced}:child.txt`)).toBe("child");

  const resumed = await prepareAtPickup(db, named, getTask(db, parent.id)!);
  expect(git(resumed.path, "rev-parse", "HEAD")).toBe(advanced);
});

it("削除の途中で落ちた解放の再実行は記録から削除だけを撃つ —— 半分消えた tree から2つ目の WIP を積まず、済んだ後の再実行は何もしない(ADR 0356 決定2 / ADR 0345)", async () => {
  const { named, task, place, branch } = await pickedUp("task-checkout-rerun");
  writeFileSync(join(place.path, "wip.txt"), "in progress\n");
  const parent = join(place.path, "..");
  chmodSync(parent, 0o555);
  try {
    expect(() => releaseWorkspace(db, place, task, NOW)).toThrow();
  } finally {
    chmodSync(parent, 0o755);
  }
  const afterCrash = git(named.path, "rev-parse", branch);
  expect(git(named.path, "show", `${branch}:wip.txt`)).toBe("in progress");
  // 削除が tree の一部だけを消して .git を残した形
  rmSync(join(place.path, "wip.txt"));
  rmSync(join(place.path, "README.md"));
  expect(existsSync(join(place.path, ".git"))).toBe(true);

  releaseWorkspace(db, place, task, NOW);
  expect(git(named.path, "rev-parse", branch)).toBe(afterCrash);
  expect(existsSync(place.path)).toBe(false);
  expect(existsSync(parent)).toBe(false);

  releaseWorkspace(db, place, task, NOW);
  expect(git(named.path, "rev-parse", branch)).toBe(afterCrash);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
});

it("review は lineage の fork 元から名前の場所に作った task/<reviewId> の task の checkout で走り、名前の場所の HEAD は動かない(ADR 0356 決定1)", async () => {
  const named = await makeWorkspace("task-checkout-review");
  db = openDb(":memory:");
  const work = register();
  const workPlace = await prepareAtPickup(db, named, work);
  commitWork(workPlace.path, "work.txt", "work\n");
  releaseWorkspace(db, workPlace, work, NOW);

  const review = register("review", work.id);
  const place = await prepareAtPickup(db, named, review);

  expect(git(named.path, "rev-parse", `task/${review.id}`)).toBe(git(named.path, "rev-parse", `task/${work.id}`));
  expect(git(place.path, "symbolic-ref", "HEAD")).toBe(`refs/heads/task/${review.id}`);
  expect(git(named.path, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

it.each(["work", "review"] as const)("%s の sandbox は alternates を消しても名前の場所の objects を読みだけ開く(ADR 0356 決定2 / ADR 0360 決定2)", async (type) => {
  const { named, place } = await pickedUp(`task-checkout-posture-${type}`, type);
  const alternates = join(place.path, ".git", "objects", "info", "alternates");
  const objects = readFileSync(alternates, "utf8").trim();
  expect(objects).toBe(objectsOf(named));
  // alternates が解けること: 名前の場所の base commit を task の checkout の git が読める
  git(place.path, "cat-file", "-e", `${git(named.path, "rev-parse", "main")}^{commit}`);
  rmSync(alternates);
  const reads = runPlaceReadPaths(place);
  expect(reads).toEqual([objectsOf(named)]);

  const sandbox = buildSandboxSettings({ taskType: type, workspacePath: place.path, readPaths: reads, taskTemp: "/tmp/t", configDir: "/tmp/c", lib64: false });
  expect(sandbox.sandbox.filesystem.allowRead).toEqual(expect.arrayContaining([place.path, objects]));
  expect(sandbox.sandbox.filesystem.allowWrite).not.toContain(objects);
  expect(sandbox.sandbox.filesystem.allowWrite).toEqual(type === "work" ? [place.path, "/tmp/t"] : ["/tmp/t"]);

  const filesystem = permissionConfig(type, place.path, "/tmp/t", "/usr/bin/codex", [], reads).find((line) => line.includes(".filesystem="))!;
  expect(filesystem).toContain(`${JSON.stringify(objects)}="read"`);
  expect(filesystem).toContain(`${JSON.stringify(place.path)}=${JSON.stringify(type === "work" ? "write" : "read")}`);
  if (type === "work") expect(filesystem).toContain(`${JSON.stringify(join(place.path, ".git"))}="write"`);
});
