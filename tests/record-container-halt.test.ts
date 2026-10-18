import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { boardHalts } from "../src/board-halt.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { quarantineChecks, submitAnswer } from "../src/human-verbs.js";
import { openQuarantineQuestion } from "../src/quarantine.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { Slot } from "../src/slot.js";
import { completeTask, getRegistrant, getTask, listBoard, poseProbe, registerTask, type Task } from "../src/tasks.js";
import { recordContainerHaltHandler } from "../src/watchdog.js";
import { BOARD_WORKER_ID } from "../src/worker-id.js";
import { taskRunPlace } from "../src/workspace.js";
import { FakeClock, fakeContainers, noRetrospectiveCalls, ScriptedWorker, unusedLanding } from "./fakes.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, openTestInterviewRoom } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// 盤面の記録の器が書けないことは盤面全体の停止で、踏んだ受験者は todo の先頭へ戻る(ADR 0266 決定3、#2094)。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const opusHigh = { provider: "anthropic", model: "claude-opus-5-5", effort: "high" };
const sonnetHigh = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" };

/** 答案を持って決着した受験者1人と、これから拾われる受験者1人。器の dir は消してある。 */
async function brokenContainer(name: string) {
  const workspace = await makeWorkspace(name);
  const recordDir = join(await tempDir(`tidepool-${name}-records-`), "worker-logs");
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const root = registerTask(db, { type: "interview", title: "interview", hypothesis: "the targets write the parser", tier: "standard", workspace: workspace.name, interview_targets: [opusHigh, sonnetHigh] as never }, clock.now(), ...HUMAN_WEBUI);
  // 受験者は root の面接室で走る(ADR 0273 決定1)—— root の pickup が作る面接室を先に開く
  openTestInterviewRoom(db, root);
  const room = taskRunPlace(db, root, workspace);
  const [done, picked] = poseProbe(db, root, { title: "add a parser", probe: "write a parser", completion_criteria: "the parser works", rubric: "tests pass" }, "auditor", clock.now(), "worker", git(room.path, "rev-parse", "main")) as [Task, Task];
  git(room.path, "checkout", "-b", `task/${done.id}`, "main");
  commitWork(room.path, "answer.txt", "an answer\n");
  git(room.path, "checkout", "main");
  completeTask(db, done, FULL_HANDOFF, "tako", clock.now(), "worker");
  const worker = new ScriptedWorker(clock);
  const slot = new Slot();
  const scheduler = startScheduler({
    retrospectiveCalls: noRetrospectiveCalls,
    converge: async () => [],
    db,
    clock,
    slot,
    worker,
    containers: fakeContainers(),
    onSpawnFailed: () => {},
    onRecordContainerFailed: recordContainerHaltHandler({ db, clock, slot }),
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    workspace,
    recordDir,
  });
  return { workspace, room, recordDir, db, clock, worker, slot, scheduler, done, picked };
}

it("器が書けずに pickup の準備が落ちると、盤面全体が Tidepool 名義の question 1枚で止まり、踏んだ受験者は失敗にならず todo の先頭へ戻って slot が空く", async () => {
  const { workspace, recordDir, db, clock, worker, slot, scheduler, done, picked } = await brokenContainer("record-container-halts");
  const path = join(recordDir, `${done.id}.bundle`);

  await clock.advance(HOURLY);

  expect(worker.started).toEqual([]);
  expect(boardHalts(db)).toEqual([{ kind: "recordContainer" }]);
  expect(slot.currentTaskId).toBeNull();
  const questions = listBoard(db).filter((t) => t.type === "question");
  expect(questions.map((q) => q.id)).toEqual([openQuarantineQuestion(db, "recordContainer", null)!.id]);
  const question = getTask(db, questions[0]!.id)!;
  expect(getRegistrant(db, question.id)).toBe(BOARD_WORKER_ID);
  expect(question.purpose).toContain(`task ${done.id}`);
  expect(question.purpose).toContain(path);
  expect(question.purpose).toContain("ENOENT");
  expect(question.purpose).toContain("writing a file to that directory");
  const returned = getTask(db, picked.id)!;
  expect(returned.status).toBe("todo");
  expect(returned.sort_key).toBe(Math.min(...listBoard(db).map((t) => t.sort_key)));
  const unwritable = listEvents(db, picked.id).filter((e) => e.kind === "record_container_unwritable");
  expect(unwritable.map((e) => e.payload)).toEqual([{ kind: "record_container_unwritable", path, reason: expect.stringContaining("ENOENT") }]);
  expect(listBoard(db).filter((t) => t.type === "question" && t.parent_id === picked.id)).toEqual([]);

  // 停止が立っている間は、踏んだ task も他の task も pickup されない
  registerTask(db, { type: "work", title: "production work", purpose: "ship", completion_criteria: "shipped", workspace: workspace.name }, clock.now(), ...HUMAN_WEBUI);
  await clock.advance(HOURLY);
  expect(worker.started).toEqual([]);
  scheduler.stop();
});

it("器がまだ書けなければ回答は拒まれて停止が残り、書けるようになれば受理されて、受験者は既に切られた自分のブランチのまま走る", async () => {
  const { room, recordDir, db, clock, worker, scheduler, done, picked } = await brokenContainer("record-container-release");
  await clock.advance(HOURLY);
  const branch = git(room.path, "rev-parse", `task/${picked.id}`);
  const question = getTask(db, openQuarantineQuestion(db, "recordContainer", null)!.id)!;
  const answer = () =>
    submitAnswer(
      { db, pollNow: scheduler.pollNow, landing: unusedLanding, quarantineChecks: quarantineChecks({ db, recordDir }) },
      question,
      ["repaired by hand"],
      undefined,
      () => clock.now(),
      "webui",
    );

  await expect(answer()).rejects.toThrow(`the board's record container ${recordDir} still cannot be written`);
  expect(boardHalts(db)).toEqual([{ kind: "recordContainer" }]);
  expect(getTask(db, question.id)!.status).toBe("todo");

  mkdirSync(recordDir);
  await answer();
  await vi.waitFor(() => expect(worker.started.map((t) => t.id)).toEqual([picked.id]));

  expect(boardHalts(db)).toEqual([]);
  expect(readdirSync(recordDir)).toEqual([`${done.id}.bundle`]);
  expect(git(room.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${picked.id}`);
  expect(git(room.path, "rev-parse", "HEAD")).toBe(branch);
  scheduler.stop();
});
