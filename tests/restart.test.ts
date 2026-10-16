import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { getTask, listBoard } from "../src/tasks.js";
import { FakeContainerRuntime } from "./fakes.js";
import { api, bootTidepool, GIT_FIXTURE_TEST_TIMEOUT, git, HOUR, makeWorkspace, questions, queueWork, type Tidepool } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let t: Tidepool;
afterEach(() => t?.stop());

it("a restart drops the interrupted task into the same failure-escalation path as a watchdog kill, freeing the slot", async () => {
  t = await bootTidepool();
  const first = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "interrupted by restart",
      purpose: "occupies the slot across a restart",
      completion_criteria: "n/a",
    })
  ).json;
  const second = (
    await api(t.baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "must keep waiting",
      purpose: "would be a second in_progress task",
      completion_criteria: "n/a",
    })
  ).json;
  // first task picked up at its own registration (ADR 0119 決定2)

  // restart the monolith on the same SQLite file
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });

  // the leftover in_progress task is escalated immediately at boot, no tick needed
  const list = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(list.find((x: any) => x.id === first.id).status).toBe("blocked");
  expect(list.find((x: any) => x.type === "question")).toBeDefined();

  // the slot was freed at boot, so the boot poll (ADR 0119 決定4) hands the second task over
  expect(t.worker.started.map((x: any) => x.id)).toEqual([second.id]);
});

// ADR 0119 決定4: 起動完了は pickup の契機である —— 毎時のティックは起動直後には走らない
it("todo を持つ盤面で起動すると、tick を進めずに pickup される", async () => {
  t = await bootTidepool();
  const waiting = queueWork(t, "waiting across a restart");
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir });
  // 起動完了の poll は fire-and-forget なので、boot の返りの後ろにある
  await new Promise((resolve) => setImmediate(resolve));

  expect(t.worker.started.map((x) => x.id)).toEqual([waiting.id]);
});

const watchdog = { timeLimits: { work: 90 * 60 * 1000 }, grace: 30 * 60 * 1000, reclaimTimeout: 5 * 60 * 1000 };

/** 再起動中断の後始末(issue #1936): 未 commit の変更を残して `in_progress` のまま盤面が落ち、
 *  容器機構の前提検査が落ちた起動で立ち上がる —— 前の盤面の process が残っていないことは証明されていない。 */
async function interruptedThenBootWithFailedPreflight(harnessContainment?: () => Promise<{ available: true }>) {
  const ws = await makeWorkspace("sandbox");
  t = await bootTidepool({ workspace: ws, watchdog, harnessContainment });
  const task = queueWork(t, "interrupted by restart");
  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([task.id]));
  writeFileSync(join(ws.path, "wip.txt"), "unfinished work\n");
  await t.stopServer();

  const runtime = new FakeContainerRuntime();
  runtime.scriptPreflight("previous session may still be alive");
  t = await bootTidepool({ dir: t.dir, workspace: ws, containerRuntime: runtime, watchdog, harnessContainment });
  return { ws, task, runtime };
}

it("前提検査が落ちた起動では、再起動中断の workspace を書かずに failure question を立てて後始末へ入れる(issue #1936)", async () => {
  const { ws, task } = await interruptedThenBootWithFailedPreflight();

  expect(git(ws.path, "status", "--porcelain")).toContain("wip.txt");
  expect(git(ws.path, "log", "--format=%s", `task/${task.id}`)).not.toContain("WIP");
  expect((await questions(t)).map((q) => q.title)).toContain(`restart interrupted task: ${task.title}`);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toMatchObject({ taskId: task.id, settlement: "released" });
});

it("前提検査が戻ってから Harness Containment question への確認回答を受理すると、再起動中断の tree rule が走って枠が空く(issue #1936)", async () => {
  const { ws, task, runtime } = await interruptedThenBootWithFailedPreflight(async () => ({ available: true }) as const);
  const next = queueWork(t, "waits for the slot");
  const confirmations = await vi.waitFor(async () => {
    const found = (await questions(t)).filter((q) => q.question_quarantine_kind === "harnessContainment");
    expect(found).toHaveLength(2);
    return found;
  });

  runtime.scriptPreflight(); // 修理済み
  for (const question of confirmations) {
    expect((await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] })).status).toBe(200);
  }
  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(t.worker.started.map((x) => x.id)).toEqual([next.id]));

  expect(git(ws.path, "show", `task/${task.id}:wip.txt`)).toBe("unfinished work");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
});

// `harnessContainment` を持たない盤面は Containment question の修理を検査できず、回答を拒む ——
// そこで tree rule を持つ門は、前提検査の通る次の起動の復旧である
it("Harness 封じ込めを持たない盤面では、前提検査の通る次の起動が再起動中断の tree rule を走らせ、failure question は2枚目を立てない(issue #1936)", async () => {
  const { ws, task } = await interruptedThenBootWithFailedPreflight();
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir, workspace: ws, watchdog });

  expect(git(ws.path, "show", `task/${task.id}:wip.txt`)).toBe("unfinished work");
  expect(git(ws.path, "status", "--porcelain")).toBe("");
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
  expect((await questions(t)).filter((q) => q.title.startsWith("restart interrupted task"))).toHaveLength(1);
});

it("後始末の印が書けなかった起動は、再起動中断の failure question も残さない —— タスクは in_progress のまま(issue #1936)", async () => {
  t = await bootTidepool();
  const task = queueWork(t, "interrupted by restart");
  await t.clock.advance(HOUR);
  await t.stopServer();
  const seed = openDb(join(t.dir, "board.sqlite"));
  seed.exec(
    "CREATE TRIGGER mark_fails BEFORE UPDATE OF teardown_started_at ON tasks BEGIN SELECT RAISE(ABORT, 'mark failed'); END",
  );
  seed.close();

  await expect(bootTidepool({ dir: t.dir })).rejects.toThrow("mark failed");

  const db = openDb(join(t.dir, "board.sqlite"));
  expect(getTask(db, task.id)?.status).toBe("in_progress");
  expect(listBoard(db).filter((x) => x.type === "question")).toEqual([]);
  db.close();
});
