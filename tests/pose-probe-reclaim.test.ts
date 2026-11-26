import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import { BOARD_ACTOR_ID } from "../src/actor-id.js";
import { appendEvent } from "../src/events.js";
import { getTask } from "../src/tasks.js";
import { commitRoomCopy, recordedInterviewRoom, taskRunPlaceForBoard } from "../src/workspace.js";
import {
  api,
  bootTidepool,
  callAsTask,
  checkoutOf,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  makeWorkspace,
  questions,
  servedQuarantineQuestion,
  sessionId,
  type Tidepool,
} from "./harness.js";

// ADR 0424 決定2・3: pose_probe が root に直せない失敗を見たら、盤面が failure question を登録して session を後始末へ回収する。
// 資源の停止は verb で登録せず、後始末が観測者のまま。振る舞いはサーバ境界で1度ずつ言う(ADR 0107)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

// 実の stack では狙って起こせない失敗だけを投げる口 —— 既定は素通し。host の失敗と面接室への書き込みの失敗は worker-tip-copy.test.ts が実の状態で起こす
const UNHOOKED = { alternates: false, posable: undefined, record: undefined };
const hook = vi.hoisted(() => ({ alternates: false, posable: undefined as Error | undefined, record: undefined as Error | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const existsSync = ((path: string) => (hook.alternates && String(path).endsWith("/objects/info/alternates")) || fs.existsSync(path)) as typeof fs.existsSync;
  return { ...fs, default: { ...fs, existsSync }, existsSync };
});
vi.mock("../src/tasks.js", async (importOriginal) => {
  const tasks = await importOriginal<typeof import("../src/tasks.js")>();
  const poseProbe = ((...args: Parameters<typeof tasks.poseProbe>) => {
    if (hook.record) throw hook.record;
    return tasks.poseProbe(...args);
  }) as typeof tasks.poseProbe;
  const assertPosable = ((...args: Parameters<typeof tasks.assertPosable>) => {
    if (hook.posable) throw hook.posable;
    return tasks.assertPosable(...args);
  }) as typeof tasks.assertPosable;
  return { ...tasks, poseProbe, assertPosable };
});

let t: Tidepool | undefined;
afterEach(async () => {
  Object.assign(hook, UNHOOKED);
  await t?.stop();
  t = undefined;
});

const POSE = { title: "probe", probe: "solve it", completion_criteria: "solved", rubric: "correct" };
const INTERVIEW = { type: "interview", title: "interview", hypothesis: "h", tier: "frontier", interview_targets: [{ provider: "anthropic", model: "claude-opus-4-6", effort: "high" }] };

/** 拾われた Interview の root。容器は hold して、後始末を回収済み観測の後ろに止める。 */
async function pickedRoot(name: string) {
  const board = await bootTidepool({ workspace: await makeWorkspace(name) });
  t = board;
  const root = (await api(board.baseUrl, "POST", "/api/tasks", INTERVIEW)).json;
  const session = String(sessionId(board.db, root.id));
  board.containers.hold(root.id);
  return { board, root, session, room: recordedInterviewRoom(board.db, root.id)!.path, checkout: checkoutOf(board.db, root.id) };
}

/** pose_probe の応答が session の終わりで、`fragment` を載せた failure question が立ち、出題・監査・資源の停止が無い。
 *  後始末は回収済み観測の後ろなので、ここまでの quarantine の無さは verb が登録しないことを言う。最後に容器を空けて後始末を待つ。 */
async function expectReclaimed(board: Tidepool, rootId: string, session: string, res: any, fragment: string): Promise<void> {
  expect(res.isError).toBe(true);
  expect(res.content[0].text).toContain("this session is over");
  expect(board.containers.forceReclaims).toEqual([session]);
  const failure = (await questions(board)).find((question) => question.parent_id === rootId && question.question_cancel_option === "abandon" && question.status === "todo");
  expect(failure.title).toContain("pose_probe");
  expect(failure.purpose).toContain(fragment);
  expect(failure.question_items.map((item: any) => item.options)).toEqual([["retry", "abandon"]]);
  expect((await api(board.baseUrl, "GET", `/api/tasks/${rootId}/events`)).json.filter((event: { kind: string }) => event.kind === "decision_logged")).toEqual([]);
  expect((await api(board.baseUrl, "GET", "/api/tasks")).json.filter((task: any) => task.type === "review")).toEqual([]);
  expect(await servedQuarantineQuestion(board, "workspace", rootId)).toBeUndefined();
  board.containers.fireEmpty(session);
  await vi.waitFor(async () => expect((await api(board.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined(), { timeout: GIT_FIXTURE_TEST_TIMEOUT });
}

it("面接室の object が壊れていれば、pose_probe は自分で quarantine せずに failure question を登録して回収し、後始末が面接室を quarantine する —— question は2枚(ADR 0424 決定2・3 の前提)", async () => {
  const { board, root, session, room, checkout } = await pickedRoot("pose-reclaim-damaged-room");
  // 前の出題の写しを面接室に置き、worktree がその tree を再現したまま、面接室の側のその tree を壊す(#3814 の形)
  writeFileSync(join(checkout, "notes.txt"), "not committed\n");
  const first = commitRoomCopy(board.db, taskRunPlaceForBoard(board.db, getTask(board.db, root.id)!, undefined)!, root.id);
  // commit の日付は秒の粒度 —— 同じ秒だと出題し直しは1回目と同じ commit を借りて運ぶものが無い
  await new Promise((resolve) => setTimeout(resolve, 1050 - (Date.now() % 1000)));
  const tree = git(room, "rev-parse", `${first}^{tree}`);
  const loose = join(room, ".git", "objects", tree.slice(0, 2), tree.slice(2));
  rmSync(loose);
  writeFileSync(loose, "not zlib");

  const res = await callAsTask(board, root.id, "pose_probe", POSE);

  await expectReclaimed(board, root.id, session, res, tree);
  expect(await servedQuarantineQuestion(board, "workspace", root.id)).toBeDefined();
  expect((await questions(board)).filter((question) => question.status === "todo")).toHaveLength(2);
});

it("記録の上で root の task の checkout が開いていなければ、pose_probe は素の protocol error でなく failure question を登録して回収し、後始末は解放する場所を自分で解く(ADR 0424 決定2)", async () => {
  const { board, root, session } = await pickedRoot("pose-reclaim-place-not-open");
  // 開いた event より後の pickup: この session の task の checkout は記録の上で開いていない
  appendEvent(board.db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_picked_up" }, at: board.clock.now() });

  const res = await callAsTask(board, root.id, "pose_probe", POSE);

  await expectReclaimed(board, root.id, session, res, `the task checkout of ${root.id} is not open`);
});

it.each([
  ["an untyped throw from the posable check", () => {
    hook.posable = new Error("the posable check could not read the record");
    return "the posable check could not read the record";
  }],
  ["the staging gate's alternates invariant", () => {
    hook.alternates = true;
    return "borrows other objects through objects/info/alternates";
  }],
  ["a room-side read of the protected head", (room: string) => {
    const head = git(room, "rev-parse", "refs/heads/main");
    const loose = join(room, ".git", "objects", head.slice(0, 2), head.slice(2));
    rmSync(loose);
    writeFileSync(loose, "not zlib");
    return head;
  }],
  ["the record transaction's CONSTRAINT", () => {
    hook.record = new Database.SqliteError("UNIQUE constraint failed: events.id", "SQLITE_CONSTRAINT_UNIQUE");
    return "UNIQUE constraint failed: events.id";
  }],
  ["the record transaction's BUSY", () => {
    hook.record = new Database.SqliteError("database is locked", "SQLITE_BUSY");
    return "database is locked";
  }],
] as const)("pose_probe は %s を拒まず、失敗の文を載せた failure question を登録して回収し、出題・監査・資源の停止を記録しない(ADR 0424 決定2・3)", async (_, cause) => {
  const { board, root, session, room } = await pickedRoot("pose-reclaim-unfixable");
  const fragment = cause(room);

  const res = await callAsTask(board, root.id, "pose_probe", POSE);
  Object.assign(hook, UNHOOKED);

  await expectReclaimed(board, root.id, session, res, fragment);
});
