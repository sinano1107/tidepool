import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { claudeExitFields, claudeStreamObservation, observeClaudeLine } from "../src/claude-stream-reader.js";
import { codexExitFields, codexStreamObservation, observeCodexLine, parseJsonl } from "../src/codex-stream-reader.js";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventPayload, getEvent, listEvents } from "../src/events.js";
import { EXTRACTOR_VERSION, listEpisodes } from "../src/precedent.js";
import { quarantineExcludedProviders } from "../src/quarantine.js";
import { closeUnclosedSessions } from "../src/session-close.js";
import { parseStreamLine } from "../src/stream-json.js";
import { listBoard, pickupTask, registerTask } from "../src/tasks.js";
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
  const close = (watermark = Number.MAX_SAFE_INTEGER) => closeUnclosedSessions(db, { logDir, tmpDir, watermark, now: at });
  const exits = () => listEvents(db, task.id).filter((e) => e.kind === "worker_exited");
  return { db, logDir, tmpDir, task, spawns, close, exits };
}

const episodeOf = (db: Db, spawned: number) => listEpisodes(db, {}).find((e) => e.workerSpawnedEventId === spawned);

it("exit の記録が無い session は、観測していない印の exit で閉じ、Episode がその exit を指す", async () => {
  const b = await board();

  b.close();

  const [exited] = b.exits();
  expect(exited?.payload).toEqual({
    kind: "worker_exited", advisor: null, model_swaps: [], refusals: [],
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
  const exited = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: { kind: "worker_exited", advisor: null, model_swaps: [], refusals: [], ...QUIET_EXIT, worker_spawned_event_id: b.spawns[0]!, output_closed: true, usage: null } });

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
  appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: { kind: "worker_exited", advisor: null, model_swaps: [], refusals: [], ...QUIET_EXIT, worker_spawned_event_id: b.spawns[0]!, output_closed: true, usage: null } });

  b.close();

  expect(episodeOf(b.db, b.spawns[0]!)).toBeUndefined();
});

it("transcript の無い session は stream 由来の欄を欠測にして閉じ、2度目の起動では閉じ直さず記録もしない(ADR 0316 決定2)", async () => {
  const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => { silenced.mockRestore(); });
  const b = await board();
  const lost = spawnOnAnotherTask(b.db);
  const lostExits = () => listEvents(b.db, getEvent(b.db, lost)!.task_id!).filter((e) => e.kind === "worker_exited");

  b.close();
  b.close();

  expect(lostExits().map((e) => e.payload)).toEqual([
    expect.objectContaining({ exit_observed: false, worker_spawned_event_id: lost, usage: null, reported_error: null, last_message: null }),
  ]);
  expect(silenced).not.toHaveBeenCalled();
  expect(episodeOf(b.db, b.spawns[0]!)).toBeDefined();
  expect(episodeOf(b.db, lost)).toBeUndefined();
});

it("transcript はあるが読めない session は欄を欠測にして閉じ、投影の失敗は記録して流す", async () => {
  const silenced = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => { silenced.mockRestore(); });
  const b = await board(0);
  const spawned = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
  mkdirSync(join(b.logDir, `${b.task.id}.${spawned}.stream.jsonl`));

  b.close();

  expect(b.exits().map((e) => e.payload)).toEqual([expect.objectContaining({ exit_observed: false, usage: null, reported_error: null, last_message: null })]);
  expect(silenced).toHaveBeenCalledWith(expect.stringContaining(`${spawned}`), expect.anything());
});

/** Claude の stream-json: init・差し替え・advisor の相談・拒否・最後の発話・CLI の報告した失敗・result 行。 */
const CLAUDE_RESULT = JSON.stringify({
  type: "result",
  result: "done",
  total_cost_usd: 0.2999,
  usage: {
    input_tokens: 4,
    output_tokens: 31,
    cache_read_input_tokens: 61644,
    cache_creation_input_tokens: 13114,
    iterations: [{ type: "advisor_message", model: "claude-opus-5" }],
  },
  modelUsage: {
    "claude-sonnet-5": { inputTokens: 4, outputTokens: 31, cacheReadInputTokens: 61644, cacheCreationInputTokens: 13114, costUSD: 0.0968847 },
    "claude-opus-5": { inputTokens: 38484, outputTokens: 313, cacheReadInputTokens: 0, cacheCreationInputTokens: 38484, costUSD: 0.200245 },
  },
});
const CLAUDE_STREAM = [
  JSON.stringify({ type: "system", subtype: "init", model: "claude-sonnet-5" }),
  JSON.stringify({ type: "system", subtype: "model_refusal_fallback", original_model: "claude-sonnet-5", fallback_model: "claude-haiku-5", scope: "local", api_refusal_category: "cyber" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "server_tool_use", id: "s1", name: "advisor", input: {} }, { type: "advisor_tool_result", tool_use_id: "s1", content: { type: "advisor_redacted_result" } }] } }),
  JSON.stringify({ type: "assistant", message: { id: "m1", stop_reason: "refusal", stop_details: { category: "cyber" }, content: [] } }),
  JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5", content: [{ type: "text", text: "parser done" }] } }),
  JSON.stringify({ type: "result", is_error: true, api_error_status: 500, result: "Overloaded" }),
  CLAUDE_RESULT,
];
/** Codex の JSONL: 最後の発話・`turn.failed`・`turn.completed` の usage。 */
const CODEX_STREAM = [
  JSON.stringify({ type: "thread.started", thread_id: "t1" }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "parsed" } }),
  JSON.stringify({ type: "turn.failed", error: { message: "stream disconnected" } }),
  JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 7 } }),
];

/** live の adapter と同じ形で、読み手に1行ずつ食わせる。 */
function liveClaude(lines: string[]) {
  const observed = claudeStreamObservation();
  for (const line of lines) observeClaudeLine(observed, parseStreamLine(line));
  return claudeExitFields(observed);
}
function liveCodex(lines: string[]) {
  const observed = codexStreamObservation();
  for (const line of lines) observeCodexLine(observed, parseJsonl(line));
  return codexExitFields(observed);
}

it.each([false, true])("Claude の読み手は消費の報告が無くても stream の観測を残す(is_error: %s)", (errorResult) => {
  const lines = CLAUDE_STREAM.filter((line) => JSON.parse(line).type !== "result");
  lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "advisor_tool_result", tool_use_id: "s2", content: { type: "advisor_tool_result_error", error_code: "unavailable" } }] } }));
  if (errorResult) lines.push(JSON.stringify({ ...JSON.parse(CLAUDE_RESULT), is_error: true, api_error_status: 429 }));

  expect(liveClaude(lines)).toMatchObject({
    usage: null,
    model_swaps: [{ from: "claude-sonnet-5", to: "claude-haiku-5", scope: "local", category: "cyber" }],
    refusals: ["cyber"],
    advisor: { model: null, consultations: 1, failed_calls: ["unavailable"], usage: null },
  });
});

it("Claude の読み手は行の列から usage 一式・CLI の報告した失敗・最後の発話を作る", () => {
  expect(liveClaude(CLAUDE_STREAM)).toEqual({
    advisor: { model: "claude-opus-5", consultations: 1, usage: { input_tokens: 38484, output_tokens: 313, estimated_cost_usd: 0.200245 }, failed_calls: [] },
    model_swaps: [{ from: "claude-sonnet-5", to: "claude-haiku-5", scope: "local", category: "cyber" }],
    refusals: ["cyber"],
    usage: {
      input_tokens: 4,
      output_tokens: 31,
      cache_read_tokens: 61644,
      cache_creation_tokens: 13114,
      estimated_cost_usd: 0.2999,
      models: {
        "claude-sonnet-5": { input_tokens: 4, output_tokens: 31, cache_read_tokens: 61644, cache_creation_tokens: 13114, estimated_cost_usd: 0.0968847 },
        "claude-opus-5": { input_tokens: 38484, output_tokens: 313, cache_read_tokens: 0, cache_creation_tokens: 38484, estimated_cost_usd: 0.200245 },
      },
    },
    reported_error: "API error status 500: Overloaded",
    last_message: "parser done",
  });
});

it("Codex の読み手は行の列から正規化した usage・`turn.failed` の文・最後の発話を作る", () => {
  expect(liveCodex(CODEX_STREAM)).toEqual({
    usage: { input_tokens: 50, output_tokens: 7, cache_read_tokens: 40, cache_creation_tokens: 10, estimated_cost_usd: null },
    advisor: null, model_swaps: [], refusals: [],
    reported_error: "stream disconnected",
    last_message: "parsed",
  });
});

it("Codex の読み手は消費の報告が無くても空の stream 観測を常に返す", () => {
  expect(liveCodex([])).toEqual({ usage: null, model_swaps: [], refusals: [], advisor: null, reported_error: null, last_message: null });
});

it.each([
  ["claude-code", CLAUDE_STREAM, liveClaude],
  ["codex", CODEX_STREAM, liveCodex],
] as const)("%s: 復旧は transcript を live と同じ読み手で読み、stream 由来の欄を live と同じに埋める —— exit の事実と `usage_recheck` は欠測(ADR 0316 決定1・2)", async (harness, lines, live) => {
  const b = await board(0);
  // 末尾の行は改行で終わらない —— live の flush と同じく1行として読む
  const spawned = spawnWith(b, harness, lines.join("\n"));

  b.close();

  const [exited] = b.exits();
  expect(exited?.payload).toEqual({
    kind: "worker_exited",
    exit_observed: false,
    exit_code: null,
    signal: null,
    stderr_tail: null,
    worker_spawned_event_id: spawned,
    output_closed: false,
    ...live(lines),
  });
});

it("result 行の無い transcript では usage は欠測、最後の発話は埋まる", async () => {
  const b = await board(0);
  spawnWith(b, "claude-code", CLAUDE_STREAM.filter((line) => line !== CLAUDE_RESULT).join("\n"));

  b.close();

  expect(b.exits()[0]?.payload).toMatchObject({
    exit_observed: false, usage: null, last_message: "parser done",
    model_swaps: [{ from: "claude-sonnet-5", to: "claude-haiku-5", scope: "local", category: "cyber" }],
    refusals: ["cyber"],
    advisor: { model: null, consultations: 1, failed_calls: [], usage: null },
  });
});

it("復旧は stream の帰結を撃たない —— 認証失敗・上限到達・行の拒否の result 行があっても quarantine も question も立たない(ADR 0316 決定3)", async () => {
  const b = await board(0);
  const spawned = spawnWith(
    b,
    "claude-code",
    [401, 429, 404].map((status) => JSON.stringify({ type: "result", subtype: "error", is_error: true, api_error_status: status })).join("\n"),
  );

  b.close();

  expect(listBoard(b.db).filter((task) => task.type === "question")).toEqual([]);
  expect(quarantineExcludedProviders(b.db)).toEqual([]);
  expect(listEvents(b.db, b.task.id).filter((e) => e.id > spawned).map((e) => e.kind)).toEqual(["worker_exited"]);
});

it("watermark より後の spawn には触れない —— 走行中の別の盤面の session", async () => {
  const b = await board();
  const watermark = b.spawns.at(-1)!;
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
  const watermark = appendEvent(b.db, {
    taskId: b.task.id,
    actorId: "deckhand",
    origin: "board",
    at,
    payload: kind === "spawn_failed" ? { kind, error_code: "ENOENT", message: "spawn claude ENOENT" } : { kind, path: b.logDir, reason: "EACCES" },
  });
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

/** その harness の spawn を1つ刻み、transcript を置く。 */
function spawnWith(b: Awaited<ReturnType<typeof board>>, harness: Extract<EventPayload, { kind: "worker_spawned" }>["harness"], transcript: string): number {
  const id = appendEvent(b.db, { taskId: b.task.id, actorId: "deckhand", origin: "board", at, payload: { ...WORKER_SPAWNED, harness } });
  writeFileSync(join(b.logDir, `${b.task.id}.${id}.stream.jsonl`), transcript);
  return id;
}

/** 別の task に transcript の無い spawn を1つ刻む。 */
function spawnOnAnotherTask(db: Db): number {
  const task = pickupTask(db, registerTask(db, { type: "work", title: "other", purpose: "other", completion_criteria: "works" }, at, ...HUMAN_WEBUI), "deckhand", at)!;
  return appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", at, payload: WORKER_SPAWNED });
}
