import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";

/** shadow 行の表(spec #541「学習器(shadow)」)。読み手は routing meta-review で
 *  まだ無いので、行の形は schema 層が SQL で言う(ADR 0107 決定1 (iii))。 */
it("学習器の shadow 行は pickup ごとの {task_id, 推薦したセル, 実際のセル, 出所} で、出所は prior / data の2値", async () => {
  const db = openDb(join(await mkdtemp(join(tmpdir(), "tidepool-learner-shadow-")), "board.sqlite"));
  db.prepare(
    "INSERT INTO tasks (id, type, status, title, purpose, completion_criteria, sort_key, created_at) VALUES ('t1', 'work', 'todo', 't', 'p', 'c', 1, '2026-09-13T00:00:00.000Z')",
  ).run();
  const insert = db.prepare(
    "INSERT INTO learner_shadow (task_id, cell_recommended, cell_actual, source, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const cell = JSON.stringify({ provider: "anthropic", model: "opus", effort: "high", advisor: null });
  insert.run("t1", cell, cell, "prior", "2026-09-13T00:00:01.000Z");
  insert.run("t1", cell, cell, "data", "2026-09-13T01:00:00.000Z");
  expect(db.prepare("SELECT task_id, cell_recommended, cell_actual, source, created_at FROM learner_shadow ORDER BY id").all()).toEqual([
    { task_id: "t1", cell_recommended: cell, cell_actual: cell, source: "prior", created_at: "2026-09-13T00:00:01.000Z" },
    { task_id: "t1", cell_recommended: cell, cell_actual: cell, source: "data", created_at: "2026-09-13T01:00:00.000Z" },
  ]);
  expect(() => insert.run("t1", cell, cell, "guess", "2026-09-13T02:00:00.000Z")).toThrow(/CHECK/);
  expect(() => insert.run("missing", cell, cell, "prior", "2026-09-13T02:00:00.000Z")).toThrow(/FOREIGN KEY/);
  db.close();
});
