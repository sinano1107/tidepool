import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, type EventRow } from "../src/events.js";
import { backfillEpisodes, listEpisodes, projectAndPersist } from "../src/precedent.js";

const FIXTURE_TASK = "6b4c0b23-289e-4f9f-ade1-995fb27f3c0e";
const SPAWNED_EVENT_ID = 5;

const fixture = (name: string) =>
  readFileSync(join(import.meta.dirname, "fixtures", `worker-session-2.1.237.${name}`), "utf8");

/** #386 のフィクスチャをそのまま持つ盤面。events は id ごと写す(投影の結合は
 *  盤面が発行した event id の完全一致なので、採番が変わると意味が変わる)。
 *  workspace / assignee は events には無いので tasks 行から解決される。 */
function seedBoard(): Db {
  const db = openDb(":memory:");
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, type, status, assignee, workspace, title, purpose, completion_criteria,
       risk_flag, review_flag, sort_key, created_at)
     VALUES (?, 'work', 'done', ?, ?, 'fixture', 'fixture', 'fixture', 0, 0, 1, '2026-08-20T05:50:48.374Z')`,
  );
  insertTask.run(FIXTURE_TASK, "tako", "sandbox");
  insertTask.run("609d9475-0191-4a7f-b5bf-5b939695315a", "tidepool", "sandbox");
  const insertEvent = db.prepare(
    "INSERT INTO events (id, task_id, worker_id, origin, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const e of JSON.parse(fixture("events.json")) as EventRow[]) {
    insertEvent.run(e.id, e.task_id, e.worker_id, e.origin, e.kind, JSON.stringify(e.payload), e.created_at);
  }
  return db;
}

function writeTranscript(dir: string, name: string): string {
  const path = join(dir, name);
  writeFileSync(path, fixture("stream.jsonl"));
  return path;
}

const logDir = () => mkdtempSync(join(tmpdir(), "tidepool-precedent-"));

it("投影した Episode は (workspace, agent) で時系列に引け、行動列 / マーカー / registry_commit を持つ", () => {
  const db = seedBoard();
  const dir = logDir();
  projectAndPersist(db, {
    workerSpawnedEventId: SPAWNED_EVENT_ID,
    transcriptPath: writeTranscript(dir, `${FIXTURE_TASK}.${SPAWNED_EVENT_ID}.stream.jsonl`),
  });

  const episodes = listEpisodes(db, { workspace: "sandbox", agent: "tako" });
  expect(episodes).toHaveLength(1);
  const [episode] = episodes;
  expect(episode!.registryCommit).toBe("85c5bbb987ce03e6bce0b46f64ac6c511e3e69e2");
  expect(episode!.claudeCodeVersion).toBe("2.1.237");
  expect(episode!.actions.map((a) => a.tool)).toEqual([
    "mcp__tidepool__get_current_task",
    "Write",
    "mcp__tidepool__log_decision",
    "Agent",
    "Bash",
    "mcp__tidepool__log_decision",
    "mcp__tidepool__log_decision",
    "Bash",
    "mcp__tidepool__complete_task",
  ]);
  expect(episode!.actions[3]!.subagentUsage).toEqual({
    total_tokens: 26998,
    tool_uses: 1,
    duration_ms: 6256,
  });
  expect(episode!.markers.map((m) => [m.kind, m.position])).toEqual([
    ["decision", 2],
    ["advisor", 5],
    ["decision", 5],
    ["decision", 6],
    ["commit", 8],
  ]);
  // 別の agent / workspace では引けない
  expect(listEpisodes(db, { agent: "shako" })).toEqual([]);
  expect(listEpisodes(db, { workspace: "other" })).toEqual([]);
});

it("同じ session を同じ extractor_version で二度投影しても Episode は増えない", () => {
  const db = seedBoard();
  const dir = logDir();
  const transcriptPath = writeTranscript(dir, `${FIXTURE_TASK}.${SPAWNED_EVENT_ID}.stream.jsonl`);
  const first = projectAndPersist(db, { workerSpawnedEventId: SPAWNED_EVENT_ID, transcriptPath });
  const second = projectAndPersist(db, { workerSpawnedEventId: SPAWNED_EVENT_ID, transcriptPath });

  expect(first).toBeTypeOf("number");
  expect(second).toBeNull();
  expect(listEpisodes(db, {})).toHaveLength(1);
  expect(listEpisodes(db, {})[0]!.actions).toHaveLength(9);
});

it("backfill は <taskId>.<worker_spawned event id>.stream.jsonl だけを投影し、旧形式は投影せず件数だけ報告する(ADR 0083 追記 2)", () => {
  const db = seedBoard();
  const dir = logDir();
  writeTranscript(dir, `${FIXTURE_TASK}.stream.jsonl`);
  // 走査対象ですらない隣人(同じセッションの stderr)は skip 件数にも入らない
  writeFileSync(join(dir, `${FIXTURE_TASK}.5.stderr.log`), "");

  expect(backfillEpisodes(db, dir)).toEqual({ projected: 0, skipped: 1 });
  expect(listEpisodes(db, {})).toEqual([]);
});

it("backfill は冪等で、worker_exited 時の投影と同じ Episode を出す", () => {
  const dir = logDir();
  writeTranscript(dir, `${FIXTURE_TASK}.${SPAWNED_EVENT_ID}.stream.jsonl`);

  const backfilled = seedBoard();
  expect(backfillEpisodes(backfilled, dir)).toEqual({ projected: 1, skipped: 0 });
  expect(backfillEpisodes(backfilled, dir)).toEqual({ projected: 0, skipped: 0 });
  expect(listEpisodes(backfilled, {})).toHaveLength(1);

  const atExit = seedBoard();
  projectAndPersist(atExit, {
    workerSpawnedEventId: SPAWNED_EVENT_ID,
    transcriptPath: join(dir, `${FIXTURE_TASK}.${SPAWNED_EVENT_ID}.stream.jsonl`),
  });
  expect(listEpisodes(backfilled, {})).toEqual(listEpisodes(atExit, {}));
});

it("decision マーカーの outcome は読み出し時に entry_id で結ばれる(投影のあとに届く事実なので焼かない)", () => {
  const db = seedBoard();
  const dir = logDir();
  projectAndPersist(db, {
    workerSpawnedEventId: SPAWNED_EVENT_ID,
    transcriptPath: writeTranscript(dir, `${FIXTURE_TASK}.${SPAWNED_EVENT_ID}.stream.jsonl`),
  });
  // 投影のあとに人間が読み、そのうち1件に異議を出す
  const at = new Date("2026-08-21T00:00:00.000Z");
  for (const entryId of [6, 7, 8]) {
    appendEvent(db, {
      taskId: FIXTURE_TASK,
      workerId: "human",
      origin: "webui",
      payload: { kind: "log_entry_displayed", entry_id: entryId, session_id: 1 },
      at,
    });
  }
  appendEvent(db, {
    taskId: FIXTURE_TASK,
    workerId: "human",
    origin: "webui",
    payload: { kind: "objection_raised", entry_id: 7, comment: "2回目は要らない", session_id: 1 },
    at,
  });
  appendEvent(db, {
    taskId: FIXTURE_TASK,
    workerId: "tidepool",
    origin: "board",
    payload: { kind: "pr_merged", pr_number: 42 },
    at,
  });

  const [episode] = listEpisodes(db, { workspace: "sandbox", agent: "tako" });
  const decisions = episode!.markers.filter((m) => m.kind === "decision");
  expect(decisions.map((m) => [m.eventId, m.line, m.displayed, m.objections])).toEqual([
    [6, "kept the note to three bullets", true, []],
    [7, "kept the note to three bullets", true, ["2回目は要らない"]],
    [8, "subagent reported notes.md word count as 62", true, []],
  ]);
  expect(episode!.prMerged).toBe(42);
  expect(episode!.completed).toEqual({
    result:
      "Created notes.md with 3 bullets on tide pools; logged 3 decisions (2 identical); used 1 subagent and 1 advisor consult.",
    handoffPresent: true,
  });
  expect(episode!.exitCode).toBe(0);
});
