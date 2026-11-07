import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, getTask, pickupTask, registerTask, type Task, type TaskType } from "../src/tasks.js";
import {
  completionTreeGateApplies,
  completionTreePaths,
  ensureTaskBranch,
  prepareWorkspaceAtPickup,
  quarantineWorkspace,
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
  quarantineQuestion,
} from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

/** 完了経路の後始末が tree rule の代わりに走らせる**検査**(ADR 0109 決定3)。
 *  退避するかしないかを決めるのは `completionTreeGateApplies` の述語ひとつで、
 *  掛かる範囲(work タスク)では汚れは成果ではなく残存プロセスの露見である。 */

const NOW = new Date("2026-09-10T00:00:00.000Z");
async function pickedUpSession(type: TaskType = "work"): Promise<{
  db: Db;
  task: Task;
  ws: WorkspaceConfig;
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
  await prepareWorkspaceAtPickup(db, ws, task);
  return { db, task, ws };
}

/** 完了経路の後始末そのもの(`runTeardown` が組み立てる引数と同じ形)—— work タスクの
 *  完了だけが merge-back まで進む。 */
function releaseAfterCompletion(db: Db, ws: WorkspaceConfig, task: Task): void {
  releaseWorkspace(db, ws, task, NOW, task.type === "work", undefined, undefined, true);
}

const treeIsDirty = (workspace: WorkspaceConfig) => completionTreePaths(workspace).length > 0;

it("完了の門は worker の index や info/exclude で隠した変更を読み、.gitignore は尊重する(ADR 0356 決定3)", async () => {
  const { db, ws } = await pickedUpSession();
  try {
    commitWork(ws.path, ".gitignore", "ignored.txt\n");
    writeFileSync(join(ws.path, "ignored.txt"), "generated\n");
    expect(completionTreePaths(ws, db)).toEqual([]);

    git(ws.path, "update-index", "--assume-unchanged", "--", "README.md");
    writeFileSync(join(ws.path, "README.md"), "hidden tracked change\n");
    expect(git(ws.path, "status", "--porcelain")).toBe("");
    expect(completionTreePaths(ws, db)).toEqual(["README.md"]);

    writeFileSync(join(ws.path, ".git/info/exclude"), "hidden.txt\n");
    writeFileSync(join(ws.path, "hidden.txt"), "hidden untracked change\n");
    expect(git(ws.path, "status", "--porcelain")).toBe("");
    expect(completionTreePaths(ws, db)).toEqual(["README.md", "hidden.txt"]);
  } finally {
    db.close();
  }
});

it("worker が設定した fsmonitor は完了の門・退避・次の pickup で実行しない(ADR 0356 決定3)", async () => {
  const { db, task, ws } = await pickedUpSession();
  try {
    const script = join(ws.path, ".git", "fsmonitor-probe");
    const marker = join(ws.path, ".git", "fsmonitor-ran");
    writeFileSync(script, '#!/bin/sh\ntouch "$(dirname "$0")/fsmonitor-ran"\nexit 1\n', { mode: 0o755 });
    git(ws.path, "config", "core.fsmonitor", script);
    git(ws.path, "status", "--porcelain");
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    expect(treeIsDirty(ws)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    writeFileSync(join(ws.path, "work.txt"), "work in progress\n");
    releaseWorkspace(db, ws, task, NOW);
    expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(git(ws.path, "show", `task/${task.id}:work.txt`)).toBe("work in progress");

    const next = registerTask(db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
    await prepareWorkspaceAtPickup(db, ws, next);
    expect(existsSync(marker)).toBe(false);
  } finally {
    db.close();
  }
});

it("完了の門は作業ツリーを HEAD に戻した後も staged な変更を読む(ADR 0084 決定1)", async () => {
  const { db, ws } = await pickedUpSession();
  try {
    const path = join(ws.path, "README.md");
    const original = git(ws.path, "show", "HEAD:README.md");
    writeFileSync(path, "a staged edit\n");
    git(ws.path, "add", "README.md");
    writeFileSync(path, `${original}\n`);

    expect(completionTreePaths(ws, db)).toEqual(["README.md"]);
  } finally {
    db.close();
  }
});

it("the gate sees dirty submodules without executing their Git filters (ADR 0356 決定3)", async () => {
  const { db, ws } = await pickedUpSession();
  try {
    const source = await makeWorkspace("nested-module-source");
    commitWork(source.path, ".gitattributes", "README.md filter=probe\n");
    git(ws.path, "-c", "protocol.file.allow=always", "submodule", "add", source.path, "module with space");
    git(ws.path, "commit", "-m", "add a submodule");
    const submodule = join(ws.path, "module with space");
    const marker = join(ws.path, ".git", "submodule-filter-ran");
    const script = join(ws.path, ".git", "submodule-filter");
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

    expect(completionTreePaths(ws, db)).toEqual(["module with space"]);
    expect(existsSync(marker)).toBe(false);
    git(submodule, "config", "--unset", "filter.probe.clean");
    git(submodule, "add", "README.md");
    git(submodule, "commit", "-m", "advance the submodule tip");
    expect(git(submodule, "status", "--porcelain")).toBe("");
    expect(completionTreePaths(ws, db)).toEqual(["module with space"]);
  } finally {
    db.close();
  }
});

it("完了の merge back は ignored の生成物と入れ子 repo を消してから帰り、次のタスクは clean に始まる(ADR 0352 決定1・2)", async () => {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("ignored-completion");
  commitWork(ws.path, ".gitignore", "node_modules/\n");
  const parent = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  git(ws.path, "branch", `task/${parent.id}`, "main");
  const registered = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, NOW, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  await prepareWorkspaceAtPickup(db, ws, task);
  commitWork(ws.path, ".gitignore", "node_modules/\nbuild/\n");
  mkdirSync(join(ws.path, "build", "nested"), { recursive: true });
  git(join(ws.path, "build", "nested"), "init", "-q");
  writeFileSync(join(ws.path, "build", "nested", "out.txt"), "generated\n");
  mkdirSync(join(ws.path, "node_modules"));
  writeFileSync(join(ws.path, "node_modules", "cache"), "shared ignore rule\n");
  expect(treeIsDirty(ws)).toBe(false);
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");

  releaseAfterCompletion(db, ws, getTask(db, task.id)!);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(existsSync(join(ws.path, "build"))).toBe(false);
  expect(existsSync(join(ws.path, "node_modules"))).toBe(false);
  expect(git(ws.path, "show", `task/${parent.id}:.gitignore`)).toContain("build/");

  const next = registerTask(db, { type: "work", title: "next", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  await prepareWorkspaceAtPickup(db, ws, pickupTask(db, next, "deckhand", NOW)!);

  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${next.id}`);
  expect(treeIsDirty(ws)).toBe(false);
});

it("pickup のタスクブランチへの checkout は、離れる main だけが無視する生成物も消す(ADR 0352 決定1)", async () => {
  const db = openDb(":memory:");
  const ws = await makeWorkspace("ignored-pickup");
  const task = registerTask(db, { type: "work", title: "resume", purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  git(ws.path, "branch", `task/${task.id}`, "main");
  commitWork(ws.path, ".gitignore", "build/\n");
  mkdirSync(join(ws.path, "build"));
  writeFileSync(join(ws.path, "build", "out.txt"), "generated at rest\n");

  ensureTaskBranch(db, ws, task);

  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect(existsSync(join(ws.path, "build"))).toBe(false);
  expect(treeIsDirty(ws)).toBe(false);
});

it("完了の報告の後に書かれたものは成果ではない —— WIP も merge-back も無く workspace が quarantine に落ちる", async () => {
  const { db, task, ws } = await pickedUpSession();
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  const mainBefore = git(ws.path, "rev-parse", "main");
  // 決着を報告した後に、まだ生きていた process が書く
  writeFileSync(join(ws.path, "after-the-report.txt"), "written by a process that outlived\n");

  expect(completionTreeGateApplies(task)).toBe(true);
  releaseAfterCompletion(db, ws, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(true);
  expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain(`written to after task ${task.id} reported done`);
  // 退避されていない: WIP コミットは無く、汚れはそのまま人間の修理材料として残る
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).not.toContain("WIP");
  expect(git(ws.path, "status", "--porcelain")).not.toBe("");
  // merge-back も走っていない —— 報告後の書き込みが祖先ブランチへ運ばれることはない
  expect(git(ws.path, "rev-parse", "main")).toBe(mainBefore);
});

it("完了と解放の間に別の理由で workspace が Quarantine になっても、報告後の書き込みを退避しない(ADR 0350 決定1)", async () => {
  const { db, task, ws } = await pickedUpSession();
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  writeFileSync(join(ws.path, "late.txt"), "written after completion\n");
  quarantineWorkspace(db, ws.name, new Error("unrelated workspace failure"), NOW);
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  const mainBefore = git(ws.path, "rev-parse", "main");

  releaseAfterCompletion(db, ws, getTask(db, task.id)!);

  expect(quarantineQuestion(db, "workspace", ws.name)?.id).toBe(question.id);
  expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain("unrelated workspace failure");
  expect(listEvents(db, question.id).flatMap((e) => e.payload.kind === "quarantine_refired" ? [e.payload.reason] : [])).toEqual([expect.stringContaining(`written to after task ${task.id} reported done`)]);
  expect(git(ws.path, "log", "--format=%s", "--all")).not.toContain("WIP: task");
  expect(git(ws.path, "rev-parse", "main")).toBe(mainBefore);
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect(git(ws.path, "status", "--porcelain")).toBe("?? late.txt");
});

it("汚れが shadow 残骸の3条件だけを満たすなら、削除された上で通常どおり完了する", async () => {
  const { db, task, ws } = await pickedUpSession();
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  // ADR 0069 の3条件(既知パス・untracked・0バイト)—— サンドボックスの影であって
  // セッションの遺物ではない
  mkdirSync(join(ws.path, ".claude"), { recursive: true });
  writeFileSync(join(ws.path, ".claude", "agents"), "");

  releaseAfterCompletion(db, ws, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

it("観測そのものが失敗したら完了経路は clean に倒さず quarantine に落ちる —— 門の握り潰しはここには無い", async () => {
  const { db, task, ws } = await pickedUpSession();
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  // ADR 0356 決定3: the board no longer reads status config. Leave HEAD resolvable but break the tree it observes.
  const tree = git(ws.path, "rev-parse", "HEAD^{tree}");
  rmSync(join(ws.path, ".git", "objects", tree.slice(0, 2), tree.slice(2)));

  // 門(ADR 0084 決定2)は観測の失敗を clean に倒す —— 直後の解放で tree rule が
  // 同じ git に躓いて quarantine が人間に届くからである
  expect(treeIsDirty(ws)).toBe(false);
  // 完了経路にはその網が無い(tree rule が検査に置き換わっている)ので、飲まない
  releaseAfterCompletion(db, ws, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(true);
  // 検査で止まっている: 休止位置へも戻っていない
  expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
});

it("完了以外の解放では、着地後の書き込みが従来どおり WIP としてタスクブランチに退避される", async () => {
  const { db, task, ws } = await pickedUpSession();
  commitWork(ws.path, ".gitignore", "build/\nnode_modules/\n");
  for (const dir of ["build", "node_modules"]) {
    mkdirSync(join(ws.path, dir));
    writeFileSync(join(ws.path, dir, "cache"), "generated\n");
  }
  writeFileSync(join(ws.path, "half-done.txt"), "work in flight\n");

  // escalate / decompose は完了経路ではない —— 退避が生まれる従来の解放
  releaseWorkspace(db, ws, task, NOW);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).toContain("WIP");
  expect(git(ws.path, "show", `task/${task.id}:half-done.txt`)).toBe("work in flight");
  expect(git(ws.path, "ls-tree", "--name-only", `task/${task.id}`).split("\n")).toEqual([".gitignore", "README.md", "half-done.txt"]);
  expect(existsSync(join(ws.path, "build"))).toBe(false);
  expect(existsSync(join(ws.path, "node_modules"))).toBe(false);
  const wip = git(ws.path, "rev-parse", `task/${task.id}`);

  await prepareWorkspaceAtPickup(db, ws, task);

  expect(git(ws.path, "rev-parse", "HEAD")).toBe(wip);
  expect(treeIsDirty(ws)).toBe(false);
  expect(existsSync(join(ws.path, "build"))).toBe(false);
  expect(existsSync(join(ws.path, "node_modules"))).toBe(false);
});

it("ignored の生成物を削除できなければ、checkout を動かさず workspace Quarantine に落ちる(ADR 0352 / ADR 0069 決定4)", async () => {
  const { db, task, ws } = await pickedUpSession();
  commitWork(ws.path, ".gitignore", "build/\n");
  const build = join(ws.path, "build");
  mkdirSync(build);
  writeFileSync(join(build, "out.txt"), "generated\n");
  chmodSync(build, 0o555);
  try {
    releaseAfterCompletion(db, ws, task);

    expect(quarantineQuestion(db, "workspace", ws.name)?.purpose).toContain("failed to remove build/out.txt");
    expect(git(ws.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
    expect(existsSync(join(build, "out.txt"))).toBe(true);
  } finally {
    chmodSync(build, 0o755);
  }
});

it("review の完了でも退避する —— 完了の門を持たない解放の WIP はタスクブランチに留まる", async () => {
  const { db, task, ws } = await pickedUpSession("review");
  writeFileSync(join(ws.path, "reviewer-leavings.txt"), "notes\n");

  // 門が verb の手前で clean を要求していない範囲では、後始末時の汚れを
  // 「報告後に書かれたもの」とは言えない
  expect(completionTreeGateApplies(task)).toBe(false);
  releaseAfterCompletion(db, ws, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "show", `task/${task.id}:reviewer-leavings.txt`)).toBe("notes");
});
