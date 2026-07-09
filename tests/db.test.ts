import Database from "better-sqlite3";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { isPickupBlocked, reportThrottle } from "../src/throttle.js";

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
  reportThrottle(db, { throttled: true, resetsAt: null });
  expect(isPickupBlocked(db, new Date())).toBe(true);
  db.close();
});
