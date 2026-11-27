import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { appendEvent } from "../src/events.js";
import { CheckoutUnreadableError, WorktreeStatusError } from "../src/git.js";
import {
  api,
  bootTidepool,
  callAsTask,
  checkoutOf,
  commitWork,
  expectCompletionReclaimed,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  makeWorkspace,
  questions,
  registerWork,
  seedOtherTaskBranch,
  servedQuarantineQuestion,
  sessionId,
  type Tidepool,
} from "./harness.js";

// ADR 0424 決定1・2: complete_task は worker に直せる失敗だけを直し方を言って拒み、直せない失敗は failure question を登録して session を回収する。
// 振る舞いはサーバ境界で1度ずつ言う(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// 実の stack では狙って起こせない、完了の門が tip を記録した後の検査の失敗だけを投げる口 —— 既定は素通し
const hook = vi.hoisted(() => ({ view: undefined as Error | undefined, delta: undefined as Error | undefined }));
vi.mock("../src/git.js", async (importOriginal) => {
  const git = await importOriginal<typeof import("../src/git.js")>();
  const boardViewStatus = ((...args: Parameters<typeof git.boardViewStatus>) => {
    if (hook.view) throw hook.view;
    return git.boardViewStatus(...args);
  }) as typeof git.boardViewStatus;
  return { ...git, boardViewStatus };
});
vi.mock("../src/sandbox.js", async (importOriginal) => {
  const sandbox = await importOriginal<typeof import("../src/sandbox.js")>();
  const treeDeltaEntries = ((...args: Parameters<typeof sandbox.treeDeltaEntries>) => {
    if (hook.delta) throw hook.delta;
    return sandbox.treeDeltaEntries(...args);
  }) as typeof sandbox.treeDeltaEntries;
  return { ...sandbox, treeDeltaEntries };
});

let t: Tidepool | undefined;
afterEach(async () => {
  Object.assign(hook, { view: undefined, delta: undefined });
  await t?.stop();
  t = undefined;
});

/** worker が task の checkout に commit した走行中の work。 */
async function committedWork(name: string) {
  const ws = await makeWorkspace(name);
  const board = (t = await bootTidepool({ workspace: ws }));
  const task = await registerWork(board, "finish the work");
  await board.clock.advance(HOUR);
  const checkout = checkoutOf(board.db, task.id);
  commitWork(checkout, "work.txt", "work\n");
  return { ws, board, task, checkout };
}

it("worker が自分の .git を消した complete_task は、読めない理由と直し方を名指して拒み、session は続き、done にも資源の停止にもならない(ADR 0424 決定1)", async () => {
  const { ws, board, task, checkout } = await committedWork("complete-unreadable-checkout");
  rmSync(join(checkout, ".git"), { recursive: true });

  const res = await callAsTask(board, task.id, "complete_task", { handoff: FULL_HANDOFF });

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain(`the task checkout at ${checkout} has no git repository`);
  expect(res.content[0].text).toContain("Restore your task branch and call complete_task again, or escalate.");
  expect(board.containers.forceReclaims).toEqual([]);
  expect((await api(board.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
  expect((await questions(board)).filter((question) => question.parent_id === task.id)).toEqual([]);
  expect(await servedQuarantineQuestion(board, "workspace", ws.name)).toBeUndefined();
});

it("記録の上で task の checkout が開いていなければ、complete_task は素の protocol error でなく failure question を登録して回収し、後始末は解放する場所を自分で解く(ADR 0424 決定2)", async () => {
  const { ws, board, task } = await committedWork("complete-place-not-open");
  const session = String(sessionId(board.db, task.id));
  board.containers.hold(task.id);
  // 開いた event より後の pickup: この session の task の checkout は記録の上で開いていない
  appendEvent(board.db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_picked_up" }, at: board.clock.now() });

  const res = await callAsTask(board, task.id, "complete_task", { handoff: FULL_HANDOFF });

  await expectCompletionReclaimed(board, task.id, session, res, `the task checkout of ${task.id} is not open`, ws.name);
});

it.each([
  ["the worktree status", () => new WorktreeStatusError("fatal: the worktree cannot be listed"), "fatal: the worktree cannot be listed"],
  ["the task checkout", () => new CheckoutUnreadableError("the task checkout cannot be read: the worktree cannot be listed"), "the task checkout cannot be read: the worktree cannot be listed"],
] as const)("完了の門が tip を記録した後の検査で %s を読めなければ、complete_task は総称の文でなく直し方を言って拒み、session は続く(ADR 0424 決定1)", async (_, cause, fragment) => {
  const { ws, board, task } = await committedWork("complete-check-worker-stage");
  hook.view = cause();

  const res = await callAsTask(board, task.id, "complete_task", { handoff: FULL_HANDOFF });

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain(fragment);
  expect(res.content[0].text).toContain("Restore your task branch and call complete_task again, or escalate.");
  expect(board.containers.forceReclaims).toEqual([]);
  expect((await api(board.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
  expect(await servedQuarantineQuestion(board, "workspace", ws.name)).toBeUndefined();
});

it("完了の門が tip を記録した後の検査で名前の場所の側が落ちれば、complete_task は拒まず、失敗の文を載せた failure question を登録して回収する(ADR 0424 決定2・3)", async () => {
  const { ws, board, task } = await committedWork("complete-check-named-place");
  const session = String(sessionId(board.db, task.id));
  board.containers.hold(task.id);
  hook.delta = new Error("the named workspace cannot diff the recorded tip");

  const res = await callAsTask(board, task.id, "complete_task", { handoff: FULL_HANDOFF });
  hook.delta = undefined;

  await expectCompletionReclaimed(board, task.id, session, res, "the named workspace cannot diff the recorded tip", ws.name);
});

it("他の task のブランチの commit を merge した tip の complete_task は、回収せず自分の commit だけで作り直す手を言って拒み、session は続く(ADR 0417 決定3 / ADR 0424 決定1)", async () => {
  const { ws, board, task, checkout } = await committedWork("complete-other-task-commits");
  const other = await registerWork(board, "the other root");
  seedOtherTaskBranch(board.db, ws, other.id);
  git(checkout, "fetch", "--quiet", ws.path, `task/${other.id}`);
  git(checkout, "merge", "--quiet", "--no-ff", "-m", "take in the other task", "FETCH_HEAD");

  const res = await callAsTask(board, task.id, "complete_task", { handoff: FULL_HANDOFF });

  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain(`the task branch tip contains commits of task/${other.id}`);
  expect(res.content[0].text).toContain("Rebuild the task branch with only your own commits");
  expect(board.containers.forceReclaims).toEqual([]);
  expect((await api(board.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("in_progress");
});
