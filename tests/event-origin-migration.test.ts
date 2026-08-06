import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { appendEvent } from "../src/events.js";
import { registerTask } from "../src/tasks.js";

it("origin 列のない旧 board を再オープンすると、既存イベントは webui 経路として記録される(issue #190)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-event-origin-migrate-"));
  const dbPath = join(dir, "board.sqlite");
  const legacy = openDb(dbPath);
  const task = registerTask(
    legacy,
    { type: "work", title: "existing task", purpose: "p", completion_criteria: "c" },
    new Date(0),
  );
  appendEvent(legacy, {
    taskId: task.id,
    workerId: "human",
      origin: "webui",
    payload: { kind: "decision_logged", line: "existing event" },
    at: new Date(1),
  });

  // このテスト自身が新スキーマで走る将来も、origin だけが無かった旧 board を再現する。
  const columns = legacy.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
  if (columns.some((column) => column.name === "origin")) {
    legacy.exec("ALTER TABLE events DROP COLUMN origin");
  }
  legacy.close();

  const migrated = openDb(dbPath);
  const origins = migrated.prepare("SELECT origin FROM events ORDER BY id").all() as Array<{
    origin: string;
  }>;

  expect(origins).toEqual([{ origin: "webui" }, { origin: "webui" }]);
  expect(() =>
    migrated
      .prepare(
        "INSERT INTO events (task_id, worker_id, origin, kind, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(task.id, "human", "unknown", "decision_logged", "{}", new Date(2).toISOString()),
  ).toThrow(/CHECK constraint failed/);
  migrated.close();
});
