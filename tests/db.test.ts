import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { getThrottleState, isPickupBlocked, reportThrottle } from "../src/throttle.js";

it("throttle_state の旧スキーマ(state/utilization)を持つ既存 board は、再オープン時に新スキーマ(throttled)へ移行される(ADR 0008)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-db-migrate-"));
  const dbPath = join(dir, "board.sqlite");

  // a board created before ADR 0008, left mid-throttle under #10's old schema
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE throttle_state (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      state      TEXT NOT NULL CHECK (state IN ('rejected', 'allowed_warning')),
      resets_at  TEXT,
      utilization REAL
    );
  `);
  legacy.prepare("INSERT INTO throttle_state (id, state, resets_at) VALUES (1, 'rejected', NULL)").run();
  legacy.close();

  const db = openDb(dbPath);

  // must be writable/readable under the new single-`throttled` shape without
  // tripping the old CHECK/NOT NULL constraints
  reportThrottle(db, { throttled: true, resetsAt: null, windows: { session: null, week: null, fable: null } }, new Date());
  expect(isPickupBlocked(db, new Date())).toBe(true);
  db.close();
});

it("ADR 0030 以前の throttle_state(throttled/resets_at のみ)は再オープン時にウィンドウ列が追加され、既存行は「未観測」として読める", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-db-migrate-0030-"));
  const dbPath = join(dir, "board.sqlite");

  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE throttle_state (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      throttled  INTEGER NOT NULL,
      resets_at  TEXT
    );
  `);
  legacy
    .prepare("INSERT INTO throttle_state (id, throttled, resets_at) VALUES (1, 1, '2026-07-22T13:00:00.000Z')")
    .run();
  legacy.close();

  const db = openDb(dbPath);

  // the pre-0030 row survives, its windows reading as unobserved until the
  // next JIT poll overwrites them
  expect(getThrottleState(db)).toEqual({
    throttled: true,
    resetsAt: "2026-07-22T13:00:00.000Z",
    observedAt: null,
    windows: { session: null, week: null, fable: null },
  });
  reportThrottle(db, {
    throttled: false,
    resetsAt: null,
    windows: {
      session: { throttled: false, resumeAt: null },
      week: { throttled: false, resumeAt: null },
      fable: null,
    },
  }, new Date("2026-07-22T14:00:00.000Z"));
  expect(getThrottleState(db).windows.session).toEqual({ throttled: false, resumeAt: null });
  db.close();
});

function legacyTasksDdl() {
  return `
    CREATE TABLE tasks (
      id                  TEXT PRIMARY KEY,
      type                TEXT NOT NULL,
      status              TEXT NOT NULL,
      assignee            TEXT,
      workspace           TEXT,
      title               TEXT NOT NULL,
      purpose             TEXT NOT NULL,
      completion_criteria TEXT NOT NULL,
      risk_flag           INTEGER NOT NULL DEFAULT 0,
      review_flag         INTEGER NOT NULL DEFAULT 0,
      parent_id           TEXT REFERENCES tasks(id),
      sort_key            REAL NOT NULL,
      handoff_doc         TEXT,
      pr_number           INTEGER,
      -- superseded by question_items (issue #30); still physically present
      -- on any board that only ever got additive ALTER TABLE migrations
      question_options        TEXT,
      question_recommendation TEXT,
      question_answer         TEXT,
      created_at          TEXT NOT NULL
    );
    CREATE TABLE events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT NOT NULL REFERENCES tasks(id),
      worker_id  TEXT NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `;
}

it("tasks の旧スキーマ(title 等 NOT NULL、issue #30 で廃止済みの question_options/question_recommendation カラム)を持つ既存 board は、再オープン時に新スキーマへ移行され、廃止カラムは落ち既存データは保持される(issue #49)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-db-migrate-"));
  const dbPath = join(dir, "board.sqlite");

  const legacy = new Database(dbPath);
  legacy.pragma("foreign_keys = OFF");
  legacy.exec(legacyTasksDdl());
  legacy
    .prepare(
      "INSERT INTO tasks (id,type,status,title,purpose,completion_criteria,sort_key,created_at) VALUES ('t1','work','todo','T1','P1','C1',1.0,'now')",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO tasks (id,type,status,title,purpose,completion_criteria,parent_id,sort_key,created_at) VALUES ('t2','work','todo','T2','P2','C2','t1',2.0,'now')",
    )
    .run();
  legacy
    .prepare(
      "INSERT INTO events (task_id, worker_id, kind, payload, created_at) VALUES ('t1','w','created','{}','now')",
    )
    .run();
  legacy.close();

  const db = openDb(dbPath);

  const cols = (db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(
    (c) => c.name,
  );
  expect(cols).not.toContain("question_options");
  expect(cols).not.toContain("question_recommendation");
  expect(cols).toContain("question_items");

  expect(db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual({ c: 2 });
  expect(db.prepare("SELECT parent_id FROM tasks WHERE id = 't2'").get()).toEqual({
    parent_id: "t1",
  });
  expect(db.prepare("SELECT COUNT(*) c FROM events").get()).toEqual({ c: 1 });
  expect(db.pragma("foreign_key_check")).toEqual([]);
  db.close();
});

it("tasks の再構築移行が中断してできた不完全な tasks_post_issue_49 が残っていても、再オープン時に一掃されて移行がやり直される", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-db-migrate-"));
  const dbPath = join(dir, "board.sqlite");

  const legacy = new Database(dbPath);
  legacy.pragma("foreign_keys = OFF");
  legacy.exec(legacyTasksDdl());
  legacy
    .prepare(
      "INSERT INTO tasks (id,type,status,title,purpose,completion_criteria,sort_key,created_at) VALUES ('t1','work','todo','T1','P1','C1',1.0,'now')",
    )
    .run();
  // a prior crashed migration attempt: the throwaway rebuild table exists
  // but the run never got as far as dropping/renaming it into place
  legacy.exec("CREATE TABLE tasks_post_issue_49 AS SELECT * FROM tasks");
  legacy.close();

  const db = openDb(dbPath);

  expect(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
      name: string;
    }>).map((t) => t.name),
  ).not.toContain("tasks_post_issue_49");
  expect(db.prepare("SELECT COUNT(*) c FROM tasks").get()).toEqual({ c: 1 });
  expect(db.pragma("foreign_key_check")).toEqual([]);
  db.close();
});
