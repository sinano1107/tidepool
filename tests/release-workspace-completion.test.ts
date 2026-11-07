import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, getTask, listChildren, pickupTask, registerTask, type Task, type TaskType } from "../src/tasks.js";
import {
  completionTreeGateApplies,
  completionTreePaths,
  fetchTaskCheckoutTip,
  quarantineWorkspace,
  type RunPlace,
  releaseWorkspace,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import {
  commitWork,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HUMAN_WEBUI,
  makeWorkspace,
  prepareAtPickup,
  quarantineQuestion,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// ADR 0359: 門が記録した tip を完了の解放で運び、worker の checkout では報告後の書き込みを観測する。

const NOW = new Date("2026-09-10T00:00:00.000Z");
async function pickedUpSession(type: TaskType = "work"): Promise<{
  db: Db;
  task: Task;
  ws: WorkspaceConfig;
  place: RunPlace;
}> {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("sandbox");
  const registered = registerTask(
    db,
    { type, title: "one", purpose: "why", completion_criteria: "done" },
    NOW,
    ...HUMAN_WEBUI,
  );
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  const place = await prepareAtPickup(db, ws, task);
  return { db, task, ws, place };
}

/** 完了の門の前半(`assertWorkTreeCommitted`): worker の tip を名前の場所のタスクブランチにする。 */
const gateFetch = (db: Db, place: RunPlace, task: Task) => fetchTaskCheckoutTip(db, place, task.id);

/** 完了経路の後始末そのもの(`runTeardown` が組み立てる引数と同じ形)—— work タスクの
 *  完了だけが merge-back まで進む。 */
function releaseAfterCompletion(db: Db, place: RunPlace, task: Task): void {
  releaseWorkspace(db, place, task, NOW, task.type === "work", undefined, undefined, true);
}

const treeIsDirty = (place: RunPlace, task: Task) => completionTreePaths(place, task.id).length > 0;

async function completedChild() {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("completed-child");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  const parentBranch = `task/${parent.id}`;
  git(ws.path, "branch", parentBranch, "main");
  const registered = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, NOW, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  const place = await prepareAtPickup(db, ws, task);
  commitWork(place.path, "child.txt", "child work\n");
  const tip = git(place.path, "rev-parse", "HEAD");
  gateFetch(db, place, task);
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  return { db, ws, task: getTask(db, task.id)!, place, tip, parentBranch };
}

const writeObservations = (db: Db, task: Task) =>
  listEvents(db, task.id).map(({ payload }) => payload).filter(({ kind }) => kind === "task_checkout_written_after_completion");

it("完了報告後の commit は観測し、merge back は完了の門が記録した tip を運ぶ(ADR 0359 決定2・3)", async () => {
  const { db, task, ws, place, tip, parentBranch } = await completedChild();
  try {
    commitWork(place.path, "after-done.txt", "late commit\n");
    const workerTip = git(place.path, "rev-parse", "HEAD");

    releaseAfterCompletion(db, place, task);

    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(tip);
    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    expect(git(ws.path, "ls-tree", "--name-only", parentBranch, "--", "after-done.txt")).toBe("");
    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "committed", worker_tip: workerTip },
    ]);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it("完了報告後に worker の .git が無くなっても記録の tip を運び、checkout を削除する(ADR 0359 決定2・3)", async () => {
  const { db, task, ws, place, parentBranch } = await completedChild();
  try {
    rmSync(join(place.path, ".git"), { recursive: true });

    releaseAfterCompletion(db, place, task);

    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    const observation = { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining("has no git repository") };
    expect(writeObservations(db, task)).toEqual([observation]);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(existsSync(place.path)).toBe(false);

    const events = listEvents(db, task.id);
    releaseAfterCompletion(db, place, task);
    expect(listEvents(db, task.id)).toEqual(events);
  } finally {
    db.close();
  }
});

it("観測の後に merge back が失敗しても、解放の再実行で同じ観測を重ねない(ADR 0345 決定1)", async () => {
  const { db, task, ws, place, parentBranch } = await completedChild();
  try {
    writeFileSync(join(place.path, "late.txt"), "written after completion\n");
    const lock = join(ws.path, ".git", "refs", "heads", `${parentBranch}.lock`);
    writeFileSync(lock, "");

    releaseAfterCompletion(db, place, task);

    expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain("cannot lock ref");
    expect(writeObservations(db, task)).toHaveLength(1);
    expect(existsSync(place.path)).toBe(true);
    expect(listEvents(db, task.id).some(({ kind }) => kind === "task_checkout_released")).toBe(false);

    rmSync(lock);
    releaseAfterCompletion(db, place, task);

    expect(writeObservations(db, task)).toHaveLength(1);
    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it("完了後に名前の場所のタスクブランチが動けば、worker の書き込みとはせず quarantine する(ADR 0359 決定4)", async () => {
  const { db, task, ws, place, parentBranch } = await completedChild();
  try {
    const ref = `refs/heads/task/${task.id}`;
    git(ws.path, "update-ref", ref, "main");

    releaseAfterCompletion(db, place, task);

    expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain(`now: ${git(ws.path, "rev-parse", "main")} ${ref}`);
    expect(writeObservations(db, task)).toEqual([]);
    expect(git(ws.path, "ls-tree", "--name-only", parentBranch, "--", "child.txt")).toBe("");
    expect(existsSync(place.path)).toBe(true);
  } finally {
    db.close();
  }
});

it("完了の門は worker の index や info/exclude で隠した変更を読み、.gitignore は尊重する(ADR 0356 決定3)", async () => {
  const { db, task, place } = await pickedUpSession();
  try {
    commitWork(place.path, ".gitignore", "ignored.txt\n");
    gateFetch(db, place, task);
    writeFileSync(join(place.path, "ignored.txt"), "generated\n");
    expect(completionTreePaths(place, task.id, db)).toEqual([]);

    git(place.path, "update-index", "--assume-unchanged", "--", "README.md");
    writeFileSync(join(place.path, "README.md"), "hidden tracked change\n");
    expect(git(place.path, "status", "--porcelain")).toBe("");
    expect(completionTreePaths(place, task.id, db)).toEqual(["README.md"]);

    mkdirSync(join(place.path, ".git", "info"), { recursive: true });
    writeFileSync(join(place.path, ".git/info/exclude"), "hidden.txt\n");
    writeFileSync(join(place.path, "hidden.txt"), "hidden untracked change\n");
    expect(git(place.path, "status", "--porcelain")).toBe("");
    expect(completionTreePaths(place, task.id, db)).toEqual(["README.md", "hidden.txt"]);
  } finally {
    db.close();
  }
});

it("worker が設定した fsmonitor は完了の門・退避・次の pickup で実行しない(ADR 0356 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    const script = join(place.path, ".git", "fsmonitor-probe");
    const marker = join(place.path, ".git", "fsmonitor-ran");
    writeFileSync(script, '#!/bin/sh\ntouch "$(dirname "$0")/fsmonitor-ran"\nexit 1\n', { mode: 0o755 });
    git(place.path, "config", "core.fsmonitor", script);
    git(place.path, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(treeIsDirty(place, task)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(place.path, "work.txt"), "work in progress\n");
    releaseWorkspace(db, place, task, NOW);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "show", `task/${task.id}:work.txt`)).toBe("work in progress");

    const next = registerTask(db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
    await prepareAtPickup(db, ws, next);
    expect(existsSync(marker)).toBe(false);
  } finally {
    db.close();
  }
});

// 旧: 完了の門は作業ツリーを HEAD に戻した後も worker の index の staged な変更を読んだ(ADR 0084 決定1)。盤面は worker の index を
// 読まず、退避と同じ作業ツリーだけを読む —— staged だけの内容は WIP にも門にも現れない
it("完了の門は worker の index を読まず、作業ツリーを tip に戻した staged だけの変更を名指さない —— 退避が積むものと同じを読む(ADR 0356 決定3)", async () => {
  const { db, task, place } = await pickedUpSession();
  try {
    const path = join(place.path, "README.md");
    const original = git(place.path, "show", "HEAD:README.md");
    writeFileSync(path, "a staged edit\n");
    git(place.path, "add", "README.md");
    writeFileSync(path, `${original}\n`);

    expect(completionTreePaths(place, task.id, db)).toEqual([]);
  } finally {
    db.close();
  }
});

// 旧: 門は populated な submodule の中の未 commit の内容も読んだ。盤面は worker の入れ子の repo で git を撃たず(ADR 0356 決定3)、submodule は gitlink だけで読む
it("the gate reads a submodule by its gitlink only, without running Git in the worker's nested repo or its filters (ADR 0356 決定3)", async () => {
  const { db, task, place } = await pickedUpSession();
  try {
    const source = await makeWorkspace("nested-module-source");
    commitWork(source.path, ".gitattributes", "README.md filter=probe\n");
    git(place.path, "-c", "protocol.file.allow=always", "submodule", "add", source.path, "module with space");
    git(place.path, "commit", "-m", "add a submodule");
    gateFetch(db, place, task);
    const submodule = join(place.path, "module with space");
    const marker = join(place.path, ".git", "submodule-filter-ran");
    const script = join(place.path, ".git", "submodule-filter");
    writeFileSync(script, '#!/bin/sh\ntouch "$(dirname "$0")/submodule-filter-ran"\ncat\n', { mode: 0o755 });
    git(submodule, "config", "filter.probe.clean", `"${script}"`);
    const readme = join(submodule, "README.md");
    const modified = readFileSync(readme);
    modified[0] = 0x78;
    writeFileSync(readme, modified);
    utimesSync(readme, new Date(0), new Date(0));
    git(submodule, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(completionTreePaths(place, task.id, db)).toEqual([]);
    expect(existsSync(marker)).toBe(false);
    git(submodule, "config", "--unset", "filter.probe.clean");
    git(submodule, "add", "README.md");
    git(submodule, "commit", "-m", "advance the submodule tip");
    expect(git(submodule, "status", "--porcelain")).toBe("");
    expect(completionTreePaths(place, task.id, db)).toEqual(["module with space"]);
  } finally {
    db.close();
  }
});

// 旧: 完了の merge back は ignored の生成物と入れ子 repo を消してから帰った(ADR 0352 決定1・2)
it("完了の merge back は ignored の生成物と入れ子 repo を名前の場所へ運ばず、それらは task の checkout ごと消え、次のタスクは新しい checkout で clean に始まる(ADR 0356 決定2)", async () => {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("ignored-completion");
  commitWork(ws.path, ".gitignore", "node_modules/\n");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  git(ws.path, "branch", `task/${parent.id}`, "main");
  const registered = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, NOW, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  const place = await prepareAtPickup(db, ws, task);
  commitWork(place.path, ".gitignore", "node_modules/\nbuild/\n");
  mkdirSync(join(place.path, "build", "nested"), { recursive: true });
  git(join(place.path, "build", "nested"), "init", "-q");
  writeFileSync(join(place.path, "build", "nested", "out.txt"), "generated\n");
  mkdirSync(join(place.path, "node_modules"));
  writeFileSync(join(place.path, "node_modules", "cache"), "shared ignore rule\n");
  gateFetch(db, place, task);
  expect(treeIsDirty(place, task)).toBe(false);
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");

  releaseAfterCompletion(db, place, getTask(db, task.id)!);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(existsSync(place.path)).toBe(false);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(ws.path, "status", "--porcelain", "--ignored")).toBe("");
  expect(git(ws.path, "show", `task/${parent.id}:.gitignore`)).toContain("build/");

  const next = registerTask(db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  const pickedUpNext = pickupTask(db, next, "deckhand", NOW)!;
  const nextPlace = await prepareAtPickup(db, ws, pickedUpNext);

  expect(git(nextPlace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${next.id}`);
  expect(treeIsDirty(nextPlace, pickedUpNext)).toBe(false);
});

// 旧: pickup のタスクブランチへの checkout は、離れる main だけが無視する生成物を名前の場所から消した(ADR 0352 決定1)
it("pickup は名前の場所の ignored の生成物を消さず、task の checkout にも運ばない(ADR 0356 決定1・7)", async () => {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("ignored-pickup");
  commitWork(ws.path, ".gitignore", "build/\n");
  mkdirSync(join(ws.path, "build"));
  writeFileSync(join(ws.path, "build", "out.txt"), "generated at rest\n");
  const task = registerTask(db, { type: "work", title: "resume", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);

  const place = await prepareAtPickup(db, ws, task);

  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(readFileSync(join(ws.path, "build", "out.txt"), "utf8")).toBe("generated at rest\n");
  expect(existsSync(join(place.path, "build"))).toBe(false);
  expect(treeIsDirty(place, task)).toBe(false);
});

it("完了報告後の未コミットの書き込みは退避せず、記録の tip を merge back する(ADR 0359 決定3)", async () => {
  const { db, task, ws, place, tip, parentBranch } = await completedChild();
  try {
    writeFileSync(join(place.path, "after-the-report.txt"), "written after completion\n");

    releaseAfterCompletion(db, place, task);

    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "uncommitted", paths: ["after-the-report.txt"] },
    ]);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(tip);
    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    expect(git(ws.path, "ls-tree", "--name-only", parentBranch, "--", "after-the-report.txt")).toBe("");
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it("完了と解放の間に別の理由で workspace が Quarantine になっても、観測を記録して merge back する(ADR 0350 決定1 / ADR 0359 決定3)", async () => {
  const { db, task, ws, place, tip, parentBranch } = await completedChild();
  try {
    writeFileSync(join(place.path, "late.txt"), "written after completion\n");
    quarantineWorkspace(db, ws.name, new Error("unrelated workspace failure"), NOW);
    const question = quarantineQuestion(db, "workspace", ws.name)!;

    releaseAfterCompletion(db, place, task);

    expect(quarantineQuestion(db, "workspace", ws.name)).toMatchObject({ id: question.id, purpose: question.purpose });
    expect(listEvents(db, question.id).some(({ kind }) => kind === "quarantine_refired")).toBe(false);
    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "uncommitted", paths: ["late.txt"] },
    ]);
    expect(git(ws.path, "rev-parse", `task/${task.id}`)).toBe(tip);
    expect(git(ws.path, "show", `${parentBranch}:child.txt`)).toBe("child work");
    expect(git(ws.path, "ls-tree", "--name-only", parentBranch, "--", "late.txt")).toBe("");
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});

it("汚れが shadow 残骸の3条件だけを満たすなら、task の checkout ごと通常どおり完了する(ADR 0069 / ADR 0356 決定3)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, "deliverable.txt", "the real work\n");
  gateFetch(db, place, task);
  // ADR 0069 の3条件(既知パス・untracked・0バイト)—— サンドボックスの影であって
  // セッションの遺物ではない
  mkdirSync(join(place.path, ".claude"), { recursive: true });
  writeFileSync(join(place.path, ".claude", "agents"), "");

  releaseAfterCompletion(db, place, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(existsSync(place.path)).toBe(false);
});

it.each([false, true])("名前の場所の記録の tree が壊れたら、門では拒み、解放では quarantine する (done=%s)", async (completed) => {
  const { db, task, ws, place } = await pickedUpSession();
  try {
    commitWork(place.path, "deliverable.txt", "the real work\n");
    gateFetch(db, place, task);
    if (completed) completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    const tree = git(ws.path, "rev-parse", `task/${task.id}^{tree}`);
    rmSync(join(ws.path, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

    if (completed) {
      releaseAfterCompletion(db, place, getTask(db, task.id)!);
      expect(workspaceNeedsHuman(db, ws.name)).toBe(true);
      expect(existsSync(join(place.path, ".git"))).toBe(true);
      expect(writeObservations(db, task)).toEqual([]);
    } else {
      expect(() => completionTreePaths(place, task.id, db)).toThrow();
      expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    }
  } finally {
    db.close();
  }
});

it("完了以外の解放では、着地後の書き込みが従来どおり WIP としてタスクブランチに退避され、再開の checkout はその WIP に立つ(ADR 0356 決定2)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, ".gitignore", "build/\nnode_modules/\n");
  for (const dir of ["build", "node_modules"]) {
    mkdirSync(join(place.path, dir));
    writeFileSync(join(place.path, dir, "cache"), "generated\n");
  }
  writeFileSync(join(place.path, "half-done.txt"), "work in flight\n");

  // escalate / decompose は完了経路ではない —— 退避が生まれる従来の解放
  releaseWorkspace(db, place, task, NOW);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).toContain("WIP");
  expect(git(ws.path, "show", `task/${task.id}:half-done.txt`)).toBe("work in flight");
  expect(git(ws.path, "ls-tree", "--name-only", `task/${task.id}`).split("\n")).toEqual([".gitignore", "README.md", "half-done.txt"]);
  const wip = git(ws.path, "rev-parse", `task/${task.id}`);

  const resumed = await prepareAtPickup(db, ws, task);

  expect(git(resumed.path, "rev-parse", "HEAD")).toBe(wip);
  expect(treeIsDirty(resumed, task)).toBe(false);
  expect(existsSync(join(resumed.path, "build"))).toBe(false);
  expect(existsSync(join(resumed.path, "node_modules"))).toBe(false);
});

// 旧: ignored の生成物を削除できなければ checkout を動かさず workspace Quarantine に落ちた(ADR 0352 / ADR 0069 決定4)
it("task の checkout を削除できなければ解放は quarantine に包まず投げ、後始末の再実行が消す(ADR 0356 決定2)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, ".gitignore", "build/\n");
  gateFetch(db, place, task);
  const build = join(place.path, "build");
  mkdirSync(build);
  writeFileSync(join(build, "out.txt"), "generated\n");
  chmodSync(build, 0o555);
  try {
    expect(() => releaseAfterCompletion(db, place, task)).toThrow();

    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(existsSync(join(build, "out.txt"))).toBe(true);
  } finally {
    chmodSync(build, 0o755);
  }

  releaseAfterCompletion(db, place, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(existsSync(place.path)).toBe(false);
});

it("review の完了でも退避する —— 完了の門を持たない解放の WIP はタスクブランチに留まる", async () => {
  const { db, task, ws, place } = await pickedUpSession("review");
  writeFileSync(join(place.path, "reviewer-leavings.txt"), "notes\n");

  // 門が verb の手前で clean を要求していない範囲では、後始末時の汚れを
  // 「報告後に書かれたもの」とは言えない
  expect(completionTreeGateApplies(task)).toBe(false);
  releaseAfterCompletion(db, place, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "show", `task/${task.id}:reviewer-leavings.txt`)).toBe("notes");
});

it.each(["repository", "task branch"])("review の完了後に %s が無ければ観測を記録して checkout を削除する(ADR 0359 決定5)", async (missing) => {
  const { db, task, ws, place } = await pickedUpSession("review");
  try {
    completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
    const branch = `task/${task.id}`;
    const tip = git(ws.path, "rev-parse", branch);
    writeFileSync(join(place.path, "reviewer-leavings.txt"), "notes\n");
    if (missing === "repository") {
      rmSync(join(place.path, ".git"), { recursive: true });
    } else {
      git(place.path, "switch", "-c", "elsewhere");
      git(place.path, "branch", "-D", branch);
    }

    releaseAfterCompletion(db, place, getTask(db, task.id)!);

    expect(writeObservations(db, task)).toEqual([
      { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining(`has no ${missing === "repository" ? "git repository" : "branch"}`) },
    ]);
    expect(git(ws.path, "rev-parse", branch)).toBe(tip);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(listChildren(db, task.id)).toEqual([]);
    expect(existsSync(place.path)).toBe(false);
  } finally {
    db.close();
  }
});
