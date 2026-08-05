import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";

it("旧 board の task_registered から分解判断を backfill し、判断を持たないタスクは null のままにする", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-decision-migrate-"));
  const dbPath = join(dir, "board.sqlite");

  const legacy = openDb(dbPath);
  const decisionChild = registerTask(
    legacy,
    {
      type: "work",
      title: "decision child",
      purpose: "purpose",
      completion_criteria: "criteria",
      based_on_decision: 48,
    },
    new Date(1),
  );
  const independentChild = registerTask(
    legacy,
    {
      type: "work",
      title: "independent child",
      purpose: "purpose",
      completion_criteria: "criteria",
    },
    new Date(2),
  );
  // Recreate an old board where only the canonical task_registered event
  // retains the task's provenance.
  legacy.exec("ALTER TABLE tasks DROP COLUMN based_on_decision");
  legacy.close();

  const migrated = openDb(dbPath);
  const rows = migrated
    .prepare("SELECT id, based_on_decision FROM tasks ORDER BY sort_key")
    .all() as Array<{ id: string; based_on_decision: number | null }>;

  expect(rows).toEqual([
    { id: decisionChild.id, based_on_decision: 48 },
    { id: independentChild.id, based_on_decision: null },
  ]);
  migrated.close();
});
