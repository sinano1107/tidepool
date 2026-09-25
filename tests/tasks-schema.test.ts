import { expect, it } from "vitest";
import { openDb } from "../src/db.js";

it("fresh 盤面の tasks は human 担当 × in_progress の行を CHECK で拒む(issue #972)", () => {
  const db = openDb(":memory:");
  const task = db.prepare(
    "INSERT INTO tasks (id, type, status, assignee, title, purpose, completion_criteria, sort_key, created_at) VALUES (?, 'work', ?, ?, 't', 'p', 'c', 1, '2026-09-25T00:00:00.000Z')",
  );
  task.run("h", "todo", "human");
  task.run("a", "in_progress", "deckhand");
  expect(() => task.run("x", "in_progress", "human")).toThrow(/CHECK/);
  db.close();
});
