import { mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listBoard, pickupTask, registerTask, type Task, type TaskType } from "../src/tasks.js";
import {
  completionTreeGateApplies,
  prepareWorkspaceAtPickup,
  releaseWorkspace,
  treeIsDirty,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import { commitWork, git, makeWorkspace } from "./harness.js";

/** 完了経路の後始末が tree rule の代わりに走らせる**検査**(ADR 0109 決定3)。
 *  退避するかしないかを決めるのは `completionTreeGateApplies` の述語ひとつで、
 *  掛かる範囲(work タスク)では汚れは成果ではなく残存プロセスの露見である。 */

const NOW = new Date("2026-09-10T00:00:00.000Z");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function pickedUpSession(type: TaskType = "work"): Promise<{
  db: Db;
  task: Task;
  ws: WorkspaceConfig;
}> {
  const db = openDb(":memory:");
  const ws = await makeWorkspace(dirs, "sandbox");
  const registered = registerTask(
    db,
    { type, title: "one", purpose: "why", completion_criteria: "done" },
    NOW,
  );
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  await prepareWorkspaceAtPickup(db, ws, task, {});
  return { db, task, ws };
}

/** 完了経路の後始末そのもの(`runTeardown` が組み立てる引数と同じ形)—— work タスクの
 *  完了だけが merge-back まで進む。 */
function releaseAfterCompletion(db: Db, ws: WorkspaceConfig, task: Task): void {
  releaseWorkspace(db, ws, task, NOW, task.type === "work", undefined, undefined, true);
}

/** 隔離の確認 question の本文(CONTEXT.md の Quarantine)、無ければ undefined。 */
const quarantineReason = (db: Db): string | undefined =>
  listBoard(db).find((t) => t.question_quarantine_kind === "workspace")?.purpose;

it("完了の報告の後に書かれたものは成果ではない —— WIP も merge-back も無く workspace が quarantine に落ちる", async () => {
  const { db, task, ws } = await pickedUpSession();
  commitWork(ws.path, "deliverable.txt", "the real work\n");
  const mainBefore = git(ws.path, "rev-parse", "main");
  // 決着を報告した後に、まだ生きていた process が書く
  writeFileSync(join(ws.path, "after-the-report.txt"), "written by a process that outlived\n");

  expect(completionTreeGateApplies(db, task, ws)).toBe(true);
  releaseAfterCompletion(db, ws, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(true);
  expect(quarantineReason(db)).toContain(`written to after task ${task.id} reported done`);
  // 退避されていない: WIP コミットは無く、汚れはそのまま人間の修理材料として残る
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).not.toContain("WIP");
  expect(git(ws.path, "status", "--porcelain")).not.toBe("");
  // merge-back も走っていない —— 報告後の書き込みが祖先ブランチへ運ばれることはない
  expect(git(ws.path, "rev-parse", "main")).toBe(mainBefore);
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
  // **汚れの観測だけ**が落ちる workspace。checkout も rev-parse も通るので、飲まれた
  // ときは解放が最後まで走り切ってしまう —— 「飲まない」を測れる形はこれである
  git(ws.path, "config", "--local", "status.relativePaths", "notabool");

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
  writeFileSync(join(ws.path, "half-done.txt"), "work in flight\n");

  // escalate / decompose は完了経路ではない —— 退避が生まれる従来の解放
  releaseWorkspace(db, ws, task, NOW);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "log", "--oneline", `task/${task.id}`)).toContain("WIP");
  expect(git(ws.path, "show", `task/${task.id}:half-done.txt`)).toBe("work in flight");
});

it("review の完了でも退避する —— 完了の門を持たない解放の WIP はタスクブランチに留まる", async () => {
  const { db, task, ws } = await pickedUpSession("review");
  writeFileSync(join(ws.path, "reviewer-leavings.txt"), "notes\n");

  // 門が verb の手前で clean を要求していない範囲では、後始末時の汚れを
  // 「報告後に書かれたもの」とは言えない
  expect(completionTreeGateApplies(db, task, ws)).toBe(false);
  releaseAfterCompletion(db, ws, task);

  expect(workspaceNeedsHuman(db, ws.name)).toBe(false);
  expect(git(ws.path, "show", `task/${task.id}:reviewer-leavings.txt`)).toBe("notes");
});
