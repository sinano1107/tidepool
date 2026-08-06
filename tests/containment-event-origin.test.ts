import { expect, it } from "vitest";
import { quarantineContainment } from "../src/containment.js";
import { openDb } from "../src/db.js";

it("封じ込め失敗で盤面が登録する確認 question は board 経路として記録される(issue #190)", () => {
  const db = openDb(":memory:");

  quarantineContainment(db, "the host cannot confine workers", new Date(0));

  const event = db
    .prepare("SELECT origin FROM events WHERE kind = 'task_registered'")
    .get() as { origin: string };
  expect(event.origin).toBe("board");
});
