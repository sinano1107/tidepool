import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { boardViewStatus, boardWriteTree } from "../src/git.js";
import { completeTask, getTask, listChildren, pickupTask, registerFailureQuestion, registerTask, type TaskType } from "../src/tasks.js";
import { WorkerTreeGitTimeoutError } from "../src/worker-tree-git-timeout.js";
import { completionTreePaths, recordTaskCheckoutTip, releaseWorkspace } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  callAsTask,
  checkoutOf,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  prepareAtPickup,
  quarantineQuestion,
  questions,
  registerWork,
  sessionId,
  type Tidepool,
} from "./harness.js";

// ADR 0357: 盤面が worker の tree に撃つ git は有界で、上限で止まった手は観測の失敗と型で分ける。
vi.mock("../src/worker-tree-git-timeout.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/worker-tree-git-timeout.js")>(),
  WORKER_TREE_GIT_TIMEOUT_MS: 1000,
}));
vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-11-08T00:00:00.000Z");
let db: Db | undefined;
let t: Tidepool | undefined;
afterEach(async () => {
  db?.close();
  await t?.stop();
});

const mkfifo = (path: string) => execFileSync("mkfifo", [path]);

async function pickedUp(name: string, type: TaskType = "work") {
  const named = await makeWorkspace(name);
  db = openDb(":memory:");
  const registered = registerTask(db, { type, title: type, purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  const place = await prepareAtPickup(db, named, task);
  return { db, named, task, place };
}

/** FIFO を読みに開いて止まっている git が残っていない: 読み手が居なければ非 blocking の書き込みの open は ENXIO で落ちる。 */
function expectNoReader(fifo: string): void {
  let code: string | undefined;
  try {
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch (err) {
    code = (err as NodeJS.ErrnoException).code;
  }
  expect(code).toBe("ENXIO");
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  throw new Error("expected a throw");
}

it("root の .gitignore が FIFO なら view の status と退避の add -A は上限超過の型で投げ、git を残さない(ADR 0357 決定1・3)", async () => {
  const ws = await makeWorkspace("worker-tree-fifo-gitignore");
  const head = git(ws.path, "rev-parse", "HEAD");
  const fifo = join(ws.path, ".gitignore");
  rmSync(fifo, { force: true });
  mkfifo(fifo);

  const status = thrown(() => boardViewStatus(ws.path, head, ws.path));
  expect(status).toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(status).toMatchObject({ subcommand: "status", timeoutMs: 1000 });
  expectNoReader(fifo);

  const stash = thrown(() => boardWriteTree(ws.path, head, ws.path));
  expect(stash).toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(stash).toMatchObject({ subcommand: "add", timeoutMs: 1000 });
  expectNoReader(fifo);
});

it("worker の .git の FIFO で止まった upload-pack も上限で落とし、子の git を残さない(ADR 0357 決定1)", async () => {
  const { db, task, place } = await pickedUp("worker-tree-fifo-packed-refs");
  const fifo = join(place.path, ".git", "packed-refs");
  mkfifo(fifo);

  expect(thrown(() => recordTaskCheckoutTip(db, place, task.id))).toBeInstanceOf(WorkerTreeGitTimeoutError);
  expectNoReader(fifo);
});

it("倒された session の解放が上限で止まれば、question を足さず名前の場所を quarantine せず、checkout を残す(ADR 0357 決定2)", async () => {
  const { db, named, task, place } = await pickedUp("worker-tree-felled-release");
  mkfifo(join(place.path, ".gitignore"));
  registerFailureQuestion(db, task, "board git timed out", "the gate's view status did not finish", NOW);

  releaseWorkspace(db, place, getTask(db, task.id)!, NOW);

  expect(listChildren(db, task.id)).toHaveLength(1);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(existsSync(join(place.path, ".git"))).toBe(true);
  expect(listEvents(db, task.id).find(({ kind }) => kind === "task_checkout_release_failed")?.payload).toMatchObject({
    path: place.path,
    reason: expect.stringContaining("`git add` on the worker's tree did not finish within 1 s"),
  });
});

const questionsOf = (db: Db, taskId: string) => listChildren(db, taskId).filter(({ type }) => type === "question");

const writeObservations = (db: Db, taskId: string) =>
  listEvents(db, taskId).map(({ payload }) => payload).filter(({ kind }) => kind === "task_checkout_written_after_completion");

/** worker の入力の読みを止める FIFO: `.git/packed-refs` は ls-remote / fetch の upload-pack を、`.gitignore` は view を止める。 */
const stall = { "ls-remote": [".git", "packed-refs"], view: [".gitignore"] } as const;

it.each([
  ["work", "ls-remote"],
  ["work", "view"],
  ["review", "ls-remote"],
  ["review", "view"],
] as const)("完了済み %s の解放で %s が上限で止まれば「読めない」観測で、quarantine も question も無い(ADR 0359 決定3・5)", async (type, stage) => {
  const { db, named, task, place } = await pickedUp(`worker-tree-completed-${type}-${stage}`, type);
  if (type === "work") recordTaskCheckoutTip(db, place, task.id);
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  mkfifo(join(place.path, ...stall[stage]));

  releaseWorkspace(db, place, getTask(db, task.id)!, NOW, type === "work", undefined, undefined, true);

  expect(writeObservations(db, task.id)).toEqual([
    { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining("did not finish within 1 s") },
  ]);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(questionsOf(db, task.id)).toEqual([]);
  expect(existsSync(place.path)).toBe(false);
});

it("task の checkout でない場所でも、完了経路の検査は上限超過を `[]` に飲まない(ADR 0357 決定3)", async () => {
  const ws = await makeWorkspace("worker-tree-room");
  mkfifo(join(ws.path, ".gitignore"));

  expect(thrown(() => completionTreePaths(ws, "t1"))).toBeInstanceOf(WorkerTreeGitTimeoutError);
});

it("FIFO の .gitignore を残した work の complete_task は拒まず session を倒し、failure question が command と上限を名指す(ADR 0357 決定2)", async () => {
  const ws = await makeWorkspace("worker-tree-gate");
  const board = await bootTidepool({ workspace: ws });
  t = board;
  const task = await registerWork(board, "leave a fifo behind");
  await board.clock.advance(HOUR);
  const checkout = checkoutOf(board.db, task.id);
  mkfifo(join(checkout, ".gitignore"));

  const res = await callAsTask(board, task.id, "complete_task", { handoff: FULL_HANDOFF });

  expect(res.isError).toBe(true);
  expect(res.content[0].text).not.toContain("commit them on the task branch first");
  expect(res.content[0].text).not.toContain("Retry complete_task");
  expect(board.containers.forceReclaims).toEqual([String(sessionId(board.db, task.id))]);
  // 続く解放も同じ tree で上限に当たるが、question は足さず checkout を残して枠を空ける
  await vi.waitFor(async () => expect((await api(board.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined(), { timeout: GIT_FIXTURE_TEST_TIMEOUT });
  const [failure, ...more] = await questions(board);
  expect(more).toEqual([]);
  expect(failure).toMatchObject({ parent_id: task.id, question_cancel_option: "abandon" });
  expect(failure.title).toContain("`git status` on the worker's tree did not finish within 1 s");
  expect((await api(board.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).not.toBe("done");
  expect(existsSync(join(checkout, ".git"))).toBe(true);
  expect(quarantineQuestion(board.db, "workspace", ws.name)).toBeUndefined();
});

it("特別でない tracked な path の FIFO では git は即座に落ち、今日の形で投げる(ADR 0357 決定3)", async () => {
  const ws = await makeWorkspace("worker-tree-fifo-plain");
  const head = git(ws.path, "rev-parse", "HEAD");
  rmSync(join(ws.path, "README.md"));
  mkfifo(join(ws.path, "README.md"));

  const failure = thrown(() => boardWriteTree(ws.path, head, ws.path));
  expect(failure).not.toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(failure).toMatchObject({ status: expect.any(Number) });
});
