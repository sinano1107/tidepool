import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { boardViewStatus, boardWriteTree } from "../src/git.js";
import { completeTask, getTask, listChildren, pickupTask, registerFailureQuestion, registerTask, type TaskType } from "../src/tasks.js";
import { WorkerTreeGitTimeoutError } from "../src/worker-tree-git-timeout.js";
import { commitRoomCopy, completionTreePaths, recordTaskCheckoutTip, releaseWorkspace } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  callAsTask,
  checkoutOf,
  commitWork,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  pickedInterviewRoot,
  poseAccepted,
  prepareAtPickup,
  quarantineQuestion,
  questions,
  registerWork,
  servedQuarantineQuestion,
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

/** `path` を FIFO に置き換え、その path を返す。 */
function mkfifo(path: string): string {
  rmSync(path, { force: true });
  execFileSync("mkfifo", [path]);
  return path;
}

async function pickedUp(name: string, type: TaskType = "work") {
  const named = await makeWorkspace(name);
  db = openDb(":memory:");
  const registered = registerTask(db, { type, title: type, purpose: "why", completion_criteria: "done" }, NOW, ...HUMAN_WEBUI);
  const task = pickupTask(db, registered, "deckhand", NOW)!;
  const place = await prepareAtPickup(db, named, task);
  return { db, named, task, place };
}

/** FIFO を読みに開いて止まっている git が残っていない: 読み手が居なければ非 blocking の書き込みの open は ENXIO で落ちる。
 *  signal を受けた group が exit し終えるのを先に待ち、確かめるのは1度だけ —— open が通ると止まっていた読み手を解き放つので、
 *  撃ち直す待ち方では孤児が見えなくなる。 */
async function expectNoReader(fifo: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 200));
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
  const fifo = mkfifo(join(ws.path, ".gitignore"));

  const status = thrown(() => boardViewStatus(ws.path, head, ws.path));
  expect(status).toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(status).toMatchObject({ subcommand: "status", timeoutMs: 1000 });
  await expectNoReader(fifo);

  const stash = thrown(() => boardWriteTree(ws.path, head, ws.path));
  expect(stash).toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(stash).toMatchObject({ subcommand: "add", timeoutMs: 1000 });
  await expectNoReader(fifo);
});

it("強制回収した session の解放が上限で止まれば、question を足さず名前の場所を quarantine せず、checkout を残す(ADR 0357 決定2)", async () => {
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

/** worker の入力の読みを止める FIFO: `.git/packed-refs` は ls-remote の upload-pack を、worker の commit が足した blob の
 *  loose object は fetch の object の転送だけを(ref の広告は commit までしか読まない)、`.gitignore` は view を止める。 */
const stall = {
  "ls-remote": (checkout: string) => mkfifo(join(checkout, ".git", "packed-refs")),
  fetch: (checkout: string) => {
    commitWork(checkout, "notes.txt", "review notes\n");
    const sha = git(checkout, "rev-parse", "HEAD:notes.txt");
    return mkfifo(join(checkout, ".git", "objects", sha.slice(0, 2), sha.slice(2)));
  },
  view: (checkout: string) => mkfifo(join(checkout, ".gitignore")),
} as const;

it.each(["ls-remote", "fetch"] as const)("worker の .git の FIFO で止まった %s の upload-pack も上限で落とし、子の git を残さない(ADR 0357 決定1)", async (stage) => {
  const { db, task, place } = await pickedUp(`worker-tree-fifo-${stage}`);
  const fifo = stall[stage](place.path);

  const expiry = thrown(() => recordTaskCheckoutTip(db, place, task.id));
  expect(expiry).toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(expiry).toMatchObject({ subcommand: stage });
  await expectNoReader(fifo);
});

it.each([
  ["work", "ls-remote"],
  ["work", "view"],
  ["review", "ls-remote"],
  ["review", "fetch"],
  ["review", "view"],
] as const)("完了済み %s の解放で %s が上限で止まれば「読めない」観測で、quarantine も question も無い(ADR 0359 決定3・5)", async (type, stage) => {
  const { db, named, task, place } = await pickedUp(`worker-tree-completed-${type}-${stage}`, type);
  if (type === "work") recordTaskCheckoutTip(db, place, task.id);
  completeTask(db, task, FULL_HANDOFF, "worker", NOW, "worker");
  stall[stage](place.path);

  releaseWorkspace(db, place, getTask(db, task.id)!, NOW, type === "work", undefined, undefined, true);

  expect(writeObservations(db, task.id)).toEqual([
    { kind: "task_checkout_written_after_completion", path: place.path, observation: "unreadable", reason: expect.stringContaining(`\`git ${stage === "view" ? (type === "work" ? "status" : "add") : stage}\` on the worker's tree did not finish within 1 s`) },
  ]);
  expect(quarantineQuestion(db, "workspace", named.name)).toBeUndefined();
  expect(questionsOf(db, task.id)).toEqual([]);
  expect(existsSync(place.path)).toBe(false);
});

// 旧: task の checkout でない場所(#3031 の前の受験者の checkout)でも完了経路の検査は上限超過を `[]` に飲まなかった。ADR 0356 決定1 の
// 後は受験者も task の checkout で走り、task の checkout でない場所の完了経路の検査は site を持たない(ADR 0359 派生)—— 何も読まずに投げる
it("task の checkout でない場所の完了経路の検査は worker の tree を読まずに投げる(ADR 0356 決定1 / ADR 0359)", async () => {
  const ws = await makeWorkspace("worker-tree-room");
  const fifo = mkfifo(join(ws.path, ".gitignore"));

  const failure = thrown(() => completionTreePaths(ws, "t1"));
  expect(failure).not.toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(failure).toMatchObject({ message: `task t1 does not run in a task checkout (${ws.path})` });
  await expectNoReader(fifo);
});

/** 面接室を開いて root を拾った姿: root の task の checkout は面接室から開く(ADR 0356 決定1)。 */
async function pickedRoot(name: string) {
  db = openDb(":memory:");
  return { db, ...(await pickedInterviewRoot(db, name, NOW)) };
}

it("root の .gitignore が FIFO なら出題の写しは上限超過の型で投げ、面接室に出題の head を置かず git を残さない(ADR 0357 決定1 / #3031)", async () => {
  const { db, root, room, place } = await pickedRoot("worker-tree-pose-copy");
  const fifo = mkfifo(join(place.path, ".gitignore"));

  const expiry = thrown(() => commitRoomCopy(db, place, root.id));

  expect(expiry).toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(expiry).toMatchObject({ subcommand: "add" });
  expect(git(room.path, "for-each-ref", "refs/keep-around")).toBe("");
  await expectNoReader(fifo);
});

it("未決着の受験者の解放が上限で止まれば task の失敗として checkout を残し、面接室を quarantine しない(ADR 0357 決定2 / ADR 0356 決定2)", async () => {
  const { db, root, room, place } = await pickedRoot("worker-tree-examinee-release");
  const [examinee] = poseAccepted(db, root, { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" }, "auditor", NOW, "worker", commitRoomCopy(db, place, root.id));
  releaseWorkspace(db, place, root, NOW);
  const checkout = await prepareAtPickup(db, room, examinee!);
  mkfifo(join(checkout.path, ".gitignore"));

  releaseWorkspace(db, checkout, getTask(db, examinee!.id)!, NOW);

  expect(quarantineQuestion(db, "workspace", root.id)).toBeUndefined();
  expect(existsSync(join(checkout.path, ".git"))).toBe(true);
  expect(listEvents(db, examinee!.id).find(({ kind }) => kind === "task_checkout_release_failed")?.payload).toMatchObject({
    path: checkout.path,
    reason: expect.stringContaining("`git add` on the worker's tree did not finish within 1 s"),
  });
});

it("FIFO の .gitignore を残した Interview の root の pose_probe は拒まず session を強制回収で決着させ、出題を記録せず、面接室を quarantine しない(ADR 0357 決定2 / #3031)", async () => {
  const ws = await makeWorkspace("worker-tree-pose");
  const board = await bootTidepool({ workspace: ws });
  t = board;
  const root = (await api(board.baseUrl, "POST", "/api/tasks", { type: "interview", title: "interview", hypothesis: "h", tier: "frontier", interview_targets: [{ provider: "anthropic", model: "claude-opus-4-6", effort: "high" }] })).json;
  await board.clock.advance(HOUR);
  mkfifo(join(checkoutOf(board.db, root.id), ".gitignore"));

  const res = await callAsTask(board, root.id, "pose_probe", { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" });

  expect(res.isError).toBe(true);
  expect(board.containers.forceReclaims).toEqual([String(sessionId(board.db, root.id))]);
  await vi.waitFor(async () => expect((await api(board.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined(), { timeout: GIT_FIXTURE_TEST_TIMEOUT });
  const failure = (await questions(board)).find((question) => question.parent_id === root.id);
  expect(failure.title).toMatch(/`git \S+` on the worker's tree did not finish within 1 s/);
  expect(failure.purpose).toContain("while copying the probe's environment");
  expect(listEvents(board.db, root.id).filter(({ payload }) => payload.kind === "decision_logged")).toEqual([]);
  expect(await servedQuarantineQuestion(board, "workspace", root.id)).toBeUndefined();
});

it("root が自分の .git を消した pose_probe は、読めない理由と出口を名指す tool error で拒まれ、session は続き、出題も quarantine も無い(complete_task と同じ形、#3031)", async () => {
  const ws = await makeWorkspace("worker-tree-pose-unreadable");
  const board = await bootTidepool({ workspace: ws });
  t = board;
  const root = (await api(board.baseUrl, "POST", "/api/tasks", { type: "interview", title: "interview", hypothesis: "h", tier: "frontier", interview_targets: [{ provider: "anthropic", model: "claude-opus-4-6", effort: "high" }] })).json;
  await board.clock.advance(HOUR);
  const checkout = checkoutOf(board.db, root.id);
  rmSync(join(checkout, ".git"), { recursive: true });

  const res = await callAsTask(board, root.id, "pose_probe", { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" });

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain(`the task checkout at ${checkout} has no git repository`);
  expect(res.content[0].text).toContain("Restore your task branch and call pose_probe again, or escalate");
  expect(board.containers.forceReclaims).toEqual([]);
  expect((await api(board.baseUrl, "GET", `/api/tasks/${root.id}`)).json.status).toBe("in_progress");
  expect(listEvents(board.db, root.id).filter(({ payload }) => payload.kind === "decision_logged")).toEqual([]);
  expect(await servedQuarantineQuestion(board, "workspace", root.id)).toBeUndefined();
});

it("FIFO の .gitignore を残した work の complete_task は拒まず session を強制回収で決着させ、failure question が command と上限を名指す(ADR 0357 決定2)", async () => {
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
  // 続く解放も同じ tree で上限に当たるが枠は空く
  await vi.waitFor(async () => expect((await api(board.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined(), { timeout: GIT_FIXTURE_TEST_TIMEOUT });
  const failure = (await questions(board)).find((question) => question.parent_id === task.id);
  expect(failure).toMatchObject({ question_cancel_option: "abandon" });
  expect(failure.title).toMatch(/`git \S+` on the worker's tree did not finish within 1 s/);
  expect((await api(board.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).not.toBe("done");
  // 資源の停止を登録しないことはこの seam にだけ現れる
  expect(await servedQuarantineQuestion(board, "workspace", ws.name)).toBeUndefined();
});

it("特別でない tracked な path の FIFO では git は即座に落ち、今日の形で投げる(ADR 0357 決定3)", async () => {
  const ws = await makeWorkspace("worker-tree-fifo-plain");
  const head = git(ws.path, "rev-parse", "HEAD");
  mkfifo(join(ws.path, "README.md"));

  const failure = thrown(() => boardWriteTree(ws.path, head, ws.path));
  expect(failure).not.toBeInstanceOf(WorkerTreeGitTimeoutError);
  expect(failure).toMatchObject({ status: expect.any(Number) });
});
