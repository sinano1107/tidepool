import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, getEvent, listEvents } from "../src/events.js";
import { EXTRACTOR_VERSION, listEpisodes } from "../src/precedent.js";
import { closeUnclosedSessions } from "../src/session-close.js";
import { pickupTask, registerTask } from "../src/tasks.js";
import { HUMAN_WEBUI, QUIET_EXIT, toolCall, WORKER_SPAWNED } from "./harness.js";
import { tempDir } from "./temp-dir.js";

const at = new Date("2026-10-27T00:00:00Z");

/** setup: 盤面が落ちた後の記録 —— task を1つ pickup し、spawn を `sessions` 個刻み、各 session の transcript と stderr を記録の dir に置く。 */
async function board(sessions = 1) {
  const db = openDb(":memory:");
  onTestFinished(() => { db.close(); });
  const logDir = await tempDir("tidepool-close-logs-");
  const tmpDir = await tempDir("tidepool-close-tmp-");
  const task = pickupTask(db, registerTask(db, { type: "work", title: "parser", purpose: "parse", completion_criteria: "works" }, at, ...HUMAN_WEBUI), "deckhand", at)!;
  const spawns: number[] = [];
  for (let n = 0; n < sessions; n++) {
    const id = appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
    writeFileSync(join(logDir, `${task.id}.${id}.stream.jsonl`), toolCall(1, "Bash", null).join("\n"));
    writeFileSync(join(logDir, `${task.id}.${id}.stderr.log`), "warming up\nlost the board\n");
    spawns.push(id);
  }
  const close = (watermark = maxEventId(db)) => closeUnclosedSessions(db, { logDir, tmpDir, watermark, now: at });
  const exits = () => listEvents(db, task.id).filter((e) => e.kind === "worker_exited");
  return { db, logDir, tmpDir, task, spawns, close, exits };
}

const maxEventId = (db: Db) => (db.prepare("SELECT MAX(id) AS id FROM events").get() as { id: number }).id;
const episodeOf = (db: Db, spawned: number) => listEpisodes(db, {}).find((e) => e.workerSpawnedEventId === spawned);

it("exit の記録が無い session は、観測していない印の exit で閉じ、Episode がその exit を指す", async () => {
  const b = await board();

  b.close();

  const [exited] = b.exits();
  expect(exited?.payload).toEqual({
    kind: "worker_exited",
    exit_observed: false,
    exit_code: null,
    signal: null,
    stderr_tail: "warming up\nlost the board",
    reported_error: null,
    last_message: null,
    worker_spawned_event_id: b.spawns[0],
    output_closed: false,
    usage: null,
  });
  expect(exited?.actor_id).toBe("deckhand");
  expect(episodeOf(b.db, b.spawns[0]!)).toMatchObject({ workerExitedEventId: exited!.id });
  expect(episodeOf(b.db, b.spawns[0]!)!.actions.map((a) => a.tool)).toEqual(["Bash"]);
});

it("閉じた session の task の一時領域だけを消し、他の task の一時領域は残す(issue #1955)", async () => {
  const b = await board();
  const own = [join(b.tmpDir, `tidepool-claude-${b.task.id}-abc`), join(b.tmpDir, `tidepool-codex-${b.task.id}-def`)];
  const other = join(b.tmpDir, "tidepool-claude-other-task-ghi");
  for (const dir of [...own, other]) mkdirSync(dir);

  b.close();

  expect(own.filter(existsSync)).toEqual([]);
  expect(existsSync(other)).toBe(true);
});

it("exit はあるが Episode の無い session は投影だけ補い、2つ目の exit を書かない", async () => {
  const b = await board();
  const exited = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: b.spawns[0]!, output_closed: true, usage: null } });

  b.close();

  expect(b.exits().map((e) => e.id)).toEqual([exited]);
  expect(episodeOf(b.db, b.spawns[0]!)).toMatchObject({ workerExitedEventId: exited });
});

it("同じ task に後の spawn がある session は exit を書かず投影だけ —— 窓を次の session に重ねない", async () => {
  const b = await board(2);
  const live = join(b.tmpDir, `tidepool-claude-${b.task.id}-live`);
  mkdirSync(live);

  b.close(b.spawns[1]! - 1);

  expect(b.exits()).toEqual([]);
  expect(episodeOf(b.db, b.spawns[0]!)).toMatchObject({ workerExitedEventId: null });
  expect(existsSync(live)).toBe(true);
});

it("古い投影器の版の Episode を持つ session は選ばない", async () => {
  const b = await board();
  b.db
    .prepare("INSERT INTO episodes (worker_spawned_event_id, extractor_version, task_id, agent, lines) VALUES (?, ?, ?, 'deckhand', '{}')")
    .run(b.spawns[0], `${EXTRACTOR_VERSION}-old`, b.task.id);
  appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: { kind: "worker_exited", ...QUIET_EXIT, worker_spawned_event_id: b.spawns[0]!, output_closed: true, usage: null } });

  b.close();

  expect(episodeOf(b.db, b.spawns[0]!)).toBeUndefined();
});

it("transcript の無い session は記録して流し、他の session は投影する", async () => {
  const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => { silenced.mockRestore(); });
  const b = await board();
  const lost = spawnOnAnotherTask(b.db);

  b.close();

  expect(silenced).toHaveBeenCalledWith(expect.stringContaining(`${lost}`), expect.anything());
  expect(episodeOf(b.db, b.spawns[0]!)).toBeDefined();
  expect(episodeOf(b.db, lost)).toBeUndefined();
});

it("watermark より後の spawn には触れない —— 走行中の別の盤面の session", async () => {
  const b = await board();
  const watermark = maxEventId(b.db);
  const running = spawnOnAnotherTask(b.db);

  b.close(watermark);

  expect(listEvents(b.db, getEvent(b.db, running)!.task_id!).filter((e) => e.kind === "worker_exited")).toEqual([]);
  expect(b.exits()).toHaveLength(1);
});

it.each([
  ["spawn_failed", false],
  ["spawn_failed", true],
  ["record_container_unwritable", false],
  ["record_container_unwritable", true],
] as const)("process を持たなかった session(%s、後の spawn: %s)は閉じない —— exit も Episode も一時領域の削除も無く、2度の起動でも記録しない(ADR 0316 決定4 / #2633)", async (kind, laterSpawn) => {
  const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => { silenced.mockRestore(); });
  const b = await board(0);
  const neverRan = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  // spawn の失敗は transcript を開いた後(空の stream が残る)、記録の器の失敗は transcript が無い
  if (kind === "spawn_failed") writeFileSync(join(b.logDir, `${b.task.id}.${neverRan}.stream.jsonl`), "");
  appendEvent(b.db, {
    taskId: b.task.id,
    actorId: "deckhand",
    origin: "board",
    at,
    payload: kind === "spawn_failed" ? { kind, error_code: "ENOENT", message: "spawn claude ENOENT" } : { kind, path: b.logDir, reason: "EACCES" },
  });
  const watermark = maxEventId(b.db);
  if (laterSpawn) appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  const temp = join(b.tmpDir, `tidepool-claude-${b.task.id}-never`);
  mkdirSync(temp);

  b.close(watermark);
  b.close(watermark);

  expect(b.exits()).toEqual([]);
  expect(episodeOf(b.db, neverRan)).toBeUndefined();
  expect(existsSync(temp)).toBe(true);
  expect(silenced).not.toHaveBeenCalled();
});

/** 別の task に transcript の無い spawn を1つ刻む。 */
function spawnOnAnotherTask(db: Db): number {
  const task = pickupTask(db, registerTask(db, { type: "work", title: "other", purpose: "other", completion_criteria: "works" }, at, ...HUMAN_WEBUI), "deckhand", at)!;
  return appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
}
