import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { Slot } from "../src/slot.js";
import { completeTask, getTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import { markTeardown, runTeardown, teardownStep } from "../src/teardown.js";
import { workbenchPath } from "../src/workbench.js";
import { recordTaskCheckoutTip, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, unusedLanding } from "./fakes.js";
import { checkoutTaskBranch, commitWork, FULL_HANDOFF, git, HUMAN_WEBUI, makeWorkspace, prepareAtPickup, quarantineQuestion, sessionId, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 作業台の試験の場(spec #3273 group A): merge back が conflict する子と、その workspace の Quarantine への回答。

export type Board = { db: Db; clock: FakeClock; ws: WorkspaceConfig; base: string; parent: Task };

/** 未決着の親の work と、その `task/<親>` に `work.txt` の内容を持つ purely-local の workspace。task の checkout の基点 `base` は
 *  解放と受理が同じものを読む —— 作業台はその下に開く。 */
export async function boardWithParent(): Promise<Board> {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const ws = await makeWorkspace("workbench");
  const base = await tempDir("tidepool-task-checkouts-");
  const registered = registerTask(db, { type: "work", title: "parent", purpose: "why", completion_criteria: "done" }, clock.now(), ...HUMAN_WEBUI);
  checkoutTaskBranch(db, ws, registered.id);
  commitWork(ws.path, "work.txt", "from the parent\n");
  git(ws.path, "checkout", "main");
  return { db, clock, ws, base, parent: getTask(db, registered.id)! };
}

/** 親の子を登録し、そのタスクブランチを main から切る —— 2つ目の子のブランチは最初の pickup の前に切る(後から名前の場所に書くと、
 *  休止の間に ref が動いたと読まれる)。 */
export function childOf({ db, clock, ws, parent }: Board): Task {
  const registered = registerTask(db, { type: "work", title: "child", purpose: "why", completion_criteria: "done", parent_id: parent.id }, clock.now(), ...HUMAN_WEBUI);
  git(ws.path, "branch", `task/${registered.id}`, "main");
  return registered;
}

/** 親の子(`child`、既定は新しく `childOf`)を main から切り(親の `work.txt` を持たない)、task の checkout で `file`(既定は `work.txt`)を書いて完了させる。`release` が後始末を撃つ ——
 *  既定は完了の後始末の runner で、merge back が conflict して workspace の Quarantine が立つ。 */
export async function completedChild(b: Board, { child, file = "work.txt", body = "from the child\n", work, release }: { child?: Task; file?: string; body?: string; work?: (checkout: string, task: Task) => void; release?: (place: Awaited<ReturnType<typeof prepareAtPickup>>, task: Task) => void } = {}) {
  const { db, clock, ws, base } = b;
  const registered = child ?? childOf(b);
  const task = pickupTask(db, registered, "deckhand", clock.now())!;
  const place = await prepareAtPickup(db, ws, task, { now: clock.now(), workspacesBaseDir: base });
  appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: WORKER_SPAWNED, at: clock.now() });
  commitWork(place.path, file, body);
  work?.(place.path, task);
  recordTaskCheckoutTip(db, place, task.id);
  completeTask(db, task, FULL_HANDOFF, "worker", clock.now(), "worker");
  if (release) {
    release(place, getTask(db, task.id)!);
  } else {
    markTeardown(db, task.id, clock.now());
    const slot = new Slot();
    slot.occupy(task.id, sessionId(db, task.id));
    slot.enterTeardown();
    await runTeardown({ db, clock, slot, resolve: () => ws, pollNow: () => {} }, task.id, teardownStep(db, task.id));
  }
  return getTask(db, task.id)!;
}

/** 子の merge back を解放が conflict させ、Quarantine を立てた盤面。 */
export async function conflicted(options?: Parameters<typeof completedChild>[1]) {
  const b = await boardWithParent();
  const child = await completedChild(b, options);
  const target = `task/${b.parent.id}`;
  const source = `task/${child.id}`;
  return { ...b, child, target, source, workbench: () => realpathSync(workbenchPath(b.base, { task: b.parent.id }, source)) };
}

export type Conflicted = Awaited<ReturnType<typeof conflicted>>;

/** 開いた workspace の Quarantine に人間が答える(回答の経路、作業台の基点は解放と同じ)。 */
export function answer({ db, clock, ws, base }: Omit<Board, "parent">) {
  const question = quarantineQuestion(db, "workspace", ws.name)!;
  return submitAnswer(
    { db, pollNow: () => {}, landing: unusedLanding, quarantineChecks: quarantineChecks({ quarantineResolvers: {}, db, workspace: ws, workspacesDir: base }) },
    question,
    ["repaired by hand"],
    undefined,
    () => clock.now(),
    "webui",
  );
}

/** 作業台の書く先の branch の上で子を merge し、conflict を両方の行で解いて commit する(人間の手)。 */
export function resolveInWorkbench(workbench: string, source: string): void {
  expect(() => git(workbench, "merge", `board/${source}`)).toThrow();
  writeFileSync(join(workbench, "work.txt"), "from the parent\nfrom the child\n");
  git(workbench, "add", "work.txt");
  git(workbench, "commit", "--no-edit");
}

/** 名前の場所の全 ref(HEAD を含む)。 */
