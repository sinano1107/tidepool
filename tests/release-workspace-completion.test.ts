import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, getTask, pickupTask, registerTask, type Task, type TaskType } from "../src/tasks.js";
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

/** 完了経路の後始末が tree rule の代わりに走らせる**検査**(ADR 0109 決定3)。
 *  退避するかしないかを決めるのは `completionTreeGateApplies` の述語ひとつで、
 *  掛かる範囲(work タスク)では汚れは成果ではなく残存プロセスの露見である。
 *  ADR 0356 の後、worker は task の checkout で走り、完了の門は先に worker の tip を名前の場所へ引く。 */

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

it("完了の門は作業ツリーを HEAD に戻した後も staged な変更を読む(ADR 0084 決定1)", async () => {
  const { db, task, place } = await pickedUpSession();
  try {
    const path = join(place.path, "README.md");
    const original = git(place.path, "show", "HEAD:README.md");
    writeFileSync(path, "a staged edit\n");
    git(place.path, "add", "README.md");
    writeFileSync(path, `${original}\n`);

    expect(completionTreePaths(place, task.id, db)).toEqual(["README.md"]);
  } finally {
    db.close();
  }
});

it("the gate sees dirty submodules without executing their Git filters (ADR 0356 決定3)", async () => {
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

    expect(completionTreePaths(place, task.id, db)).toEqual(["module with space"]);
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

it("完了の報告の後に書かれたものは成果ではない —— WIP も merge-back も無く workspace が quarantine に落ちる", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, "deliverable.txt", "the real work\n");
  gateFetch(db, place, task);
  const mainBefore = git(ws.path, "rev-parse", "main");
  // 決着を報告した後に、まだ生きていた process が書く
  writeFileSync(join(place.path, "after-the-report.txt"), "written by a process that outlived\n");

  expect(completionTreeGateApplies(task)).toBe(true);
  releaseAfterCompletion(db, place, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(true);
  expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain(`written to after task ${task.id} reported done`);
  // 退避されていない: WIP コミットは無く、汚れは task の checkout に人間の修理材料として残る(ADR 0356 決定2)
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).not.toContain("WIP");
  expect(git(place.path, "status", "--porcelain")).not.toBe("");
  // merge-back も走っていない —— 報告後の書き込みが祖先ブランチへ運ばれることはない
  expect(git(ws.path, "rev-parse", "main")).toBe(mainBefore);
});

it("完了と解放の間に別の理由で workspace が Quarantine になっても、報告後の書き込みを退避しない(ADR 0350 決定1)", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, "deliverable.txt", "the real work\n");
  gateFetch(db, place, task);
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  writeFileSync(join(place.path, "late.txt"), "written after completion\n");
  quarantineWorkspace(db, ws.name, new Error("unrelated workspace failure"), NOW);
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  const mainBefore = git(ws.path, "rev-parse", "main");

  releaseAfterCompletion(db, place, getTask(db, task.id)!);

  expect(quarantineQuestion(db, "workspace", ws.name)?.id).toBe(question.id);
  expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain("unrelated workspace failure");
  expect(listEvents(db, question.id).flatMap((e) => e.payload.kind === "quarantine_refired" ? [e.payload.reason] : [])).toEqual([expect.stringContaining(`written to after task ${task.id} reported done`)]);
  expect(git(ws.path, "log", "--format=%s", "--all")).not.toContain("WIP: task");
  expect(git(ws.path, "rev-parse", "main")).toBe(mainBefore);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(place.path, "status", "--porcelain")).toBe("?? late.txt");
});

it("汚れが shadow 残骸の3条件だけを満たすなら、通常どおり完了する", async () => {
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

it("観測そのものが失敗したら完了経路は clean に倒さず quarantine に落ちる —— 門の握り潰しはここには無い", async () => {
  const { db, task, ws, place } = await pickedUpSession();
  commitWork(place.path, "deliverable.txt", "the real work\n");
  gateFetch(db, place, task);
  // ADR 0356 決定3: the board reads the tip's tree from the named place. Leave the tip resolvable but break that tree.
  const tree = git(ws.path, "rev-parse", `task/${task.id}^{tree}`);
  rmSync(join(ws.path, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

  // 門(ADR 0084 決定2)は観測の失敗を clean に倒す —— 直後の解放で tree rule が
  // 同じ git に躓いて quarantine が人間に届くからである
  expect(treeIsDirty(place, task)).toBe(false);
  // 完了経路にはその網が無い(tree rule が検査に置き換わっている)ので、飲まない
  releaseAfterCompletion(db, place, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(true);
  // 検査で止まっている: task の checkout は消えていない
  expect(existsSync(join(place.path, ".git"))).toBe(true);
});

it("完了以外の解放では、着地後の書き込みが従来どおり WIP としてタスクブランチに退避され、再開の checkout はその WIP に立つ", async () => {
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
