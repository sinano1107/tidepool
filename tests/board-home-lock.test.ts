import { afterEach, expect, it, vi } from "vitest";
import { BoardHomeLockedError, resolveBoardPlaces } from "../src/board-home.js";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { api, bootTidepool, HOUR, questions, queueWork, type Tidepool, WORKER_SPAWNED } from "./harness.js";

let t: Tidepool | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

/** 1つ目の盤面に、走行中の task と閉じていない session を置く —— 2つ目の盤面の起動時の復旧が壊しうる形(ADR 0436 の動機)。 */
async function boardWithARunningSession(): Promise<{ board: Tidepool; taskId: string }> {
  const board = await bootTidepool();
  const task = queueWork(board, "running when a second board starts");
  await board.clock.advance(HOUR);
  await vi.waitFor(() => expect(board.worker.started.map((x) => x.id)).toEqual([task.id]));
  appendEvent(board.db, { taskId: task.id, actorId: board.worker.id, origin: "board", at: board.clock.now(), payload: WORKER_SPAWNED });
  return { board, taskId: task.id };
}

const served = async (board: Tidepool, taskId: string) => ({
  tasks: (await api(board.baseUrl, "GET", "/api/tasks")).json,
  events: (await api(board.baseUrl, "GET", `/api/tasks/${taskId}/events`)).json,
});

// ADR 0436 決定2: 家の lock が2つ目の process を拒む —— 取れなければ何も書かずに終わり、待たない
it("同じ盤面の家で2つ目の盤面を起動すると、家のパスを言う名前の付いたエラーで拒まれ、1つ目の task・session・events は変わらない", async () => {
  const { board, taskId } = await boardWithARunningSession();
  t = board;
  const before = await served(board, taskId);

  const refused = await bootTidepool({ dir: board.dir }).catch((err: unknown) => err);

  expect(refused).toBeInstanceOf(BoardHomeLockedError);
  expect((refused as Error).message).toContain(board.dir);
  expect(await served(board, taskId)).toEqual(before);
});

it("拒まれた2つ目のあと、1つ目を止めれば同じ盤面の家で起動し直せ、中断した task は restart interrupted になる", async () => {
  const { board, taskId } = await boardWithARunningSession();
  await expect(bootTidepool({ dir: board.dir })).rejects.toThrow(BoardHomeLockedError);
  await board.stopServer();

  t = await bootTidepool({ dir: board.dir });

  expect((await questions(t)).map((q) => q.title)).toEqual(["restart interrupted task: running when a second board starts"]);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${taskId}`)).json.status).toBe("blocked");
});

// ADR 0436 の spec(#3964): lock は startServer の途中の失敗でも外れる。形は tests/restart.test.ts の「後始末の印が書けなかった起動」
it("起動が途中で失敗したあと、同じ盤面の家で起動し直せる", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "interrupted by restart");
  await t.clock.advance(HOUR);
  await t.stopServer();
  const { dbPath } = resolveBoardPlaces({ TIDEPOOL_HOME: t.dir });
  const seed = openDb(dbPath);
  seed.exec("CREATE TRIGGER mark_fails BEFORE UPDATE OF teardown_started_at ON tasks BEGIN SELECT RAISE(ABORT, 'mark failed'); END");
  seed.close();
  await expect(bootTidepool({ dir: t.dir })).rejects.toThrow("mark failed");
  const repair = openDb(dbPath);
  repair.exec("DROP TRIGGER mark_fails");
  repair.close();

  t = await bootTidepool({ dir: t.dir });

  expect((await questions(t)).map((q) => q.title)).toEqual([`restart interrupted task: ${task.title}`]);
});
