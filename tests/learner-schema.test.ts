import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";

/** shadow 行の表(spec #541「学習器(shadow)」)。読み手は routing meta-review で
 *  まだ無いので、行の形は schema 層が SQL で言う(ADR 0107 決定1 (iii))。 */
it("学習器の shadow 行は pickup ごとの {task_id, 推薦したセル, 実際のセル, selector の出所, 推薦の根拠} で、根拠は prior / data の2値", async () => {
  const db = openDb(join(await mkdtemp(join(tmpdir(), "tidepool-learner-shadow-")), "board.sqlite"));
  db.prepare(
    "INSERT INTO tasks (id, type, status, title, purpose, completion_criteria, sort_key, created_at) VALUES ('t1', 'work', 'todo', 't', 'p', 'c', 1, '2026-09-13T00:00:00.000Z')",
  ).run();
  const insert = db.prepare(
    "INSERT INTO learner_shadow (task_id, cell_recommended, cell_actual, source, basis, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const cell = JSON.stringify({ provider: "anthropic", model: "opus", effort: "high", advisor: null });
  const source = JSON.stringify({ tier: "board", provider: "only" });
  insert.run("t1", cell, cell, source, "prior", "2026-09-13T00:00:01.000Z");
  insert.run("t1", cell, cell, source, "data", "2026-09-13T01:00:00.000Z");
  expect(db.prepare("SELECT task_id, cell_recommended, cell_actual, source, basis, created_at FROM learner_shadow ORDER BY id").all()).toEqual([
    { task_id: "t1", cell_recommended: cell, cell_actual: cell, source, basis: "prior", created_at: "2026-09-13T00:00:01.000Z" },
    { task_id: "t1", cell_recommended: cell, cell_actual: cell, source, basis: "data", created_at: "2026-09-13T01:00:00.000Z" },
  ]);
  expect(() => insert.run("t1", cell, cell, source, "guess", "2026-09-13T02:00:00.000Z")).toThrow(/CHECK/);
  expect(() => insert.run("missing", cell, cell, source, "prior", "2026-09-13T02:00:00.000Z")).toThrow(/FOREIGN KEY/);
  db.close();
});
