import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";

it("旧 board の triage 状態を移行し、scratchpad 行をセッションから独立させる", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-triage-migrate-"));
  const dbPath = join(dir, "board.sqlite");
  const legacy = openDb(dbPath);
  const { lastInsertRowid } = legacy
    .prepare("INSERT INTO triage_sessions (started_at, last_activity_at) VALUES (?, ?)")
    .run(new Date(0).toISOString(), new Date(0).toISOString());

  const sessionColumns = legacy.prepare("PRAGMA table_info(triage_sessions)").all() as Array<{
    name: string;
  }>;
  if (sessionColumns.some((column) => column.name === "closed_by")) {
    legacy.exec("ALTER TABLE triage_sessions DROP COLUMN closed_by");
  }
  if (sessionColumns.some((column) => column.name === "timeout_notified")) {
    legacy.exec("ALTER TABLE triage_sessions DROP COLUMN timeout_notified");
  }
  const scratchpadColumns = legacy
    .prepare("PRAGMA table_info(triage_scratchpad)")
    .all() as Array<{ name: string }>;
  if (scratchpadColumns.some((column) => column.name === "session_id")) {
    legacy
      .prepare("INSERT INTO triage_scratchpad (session_id, line) VALUES (?, ?)")
      .run(Number(lastInsertRowid), "持ち越す行");
  } else {
    legacy.prepare("INSERT INTO triage_scratchpad (line) VALUES (?)").run("持ち越す行");
  }
  if (!scratchpadColumns.some((column) => column.name === "session_id")) {
    legacy.exec(
      "ALTER TABLE triage_scratchpad ADD COLUMN session_id INTEGER REFERENCES triage_sessions(id)",
    );
    legacy.prepare("UPDATE triage_scratchpad SET session_id = ?").run(Number(lastInsertRowid));
  }
  legacy.close();

  for (let opening = 0; opening < 2; opening++) {
    const migrated = openDb(dbPath);
    const migratedSessionColumns = migrated
      .prepare("PRAGMA table_info(triage_sessions)")
      .all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>;
    const migratedScratchpadColumns = migrated
      .prepare("PRAGMA table_info(triage_scratchpad)")
      .all() as Array<{ name: string }>;

    expect(migratedSessionColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "closed_by", type: "TEXT" }),
        expect.objectContaining({
          name: "timeout_notified",
          type: "INTEGER",
          notnull: 1,
          dflt_value: "0",
        }),
      ]),
    );
    expect(migratedScratchpadColumns.map((column) => column.name)).toEqual(["id", "line"]);
    expect(migrated.prepare("SELECT * FROM triage_scratchpad").all()).toEqual([
      { id: 1, line: "持ち越す行" },
    ]);
    migrated.close();
  }
});
