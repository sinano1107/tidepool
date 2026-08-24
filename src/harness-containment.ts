import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import type { Harness } from "./registry.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

export type HarnessContainmentCheck = (harness: Harness) => Promise<ContainmentCapability>;

export function quarantinedHarnesses(db: Db): Harness[] {
  return (db
    .prepare(
      `SELECT question_quarantine_harness AS harness
       FROM tasks
       WHERE question_quarantine_harness IS NOT NULL AND status = 'todo'`,
    )
    .all() as Array<{ harness: Harness }>).map((row) => row.harness);
}

/** Persist the narrowest safe stop: one Confirmation per Harness, never a
 * board-wide halt. Another canonical route remains eligible in the same poll. */
export async function harnessContainmentPickupBlocked(
  db: Db,
  harness: Harness,
  check: HarnessContainmentCheck,
  now: Date,
): Promise<boolean> {
  const existing = db
    .prepare(
      `SELECT id FROM tasks
       WHERE question_quarantine_harness = ? AND status = 'todo'`,
    )
    .get(harness);
  if (existing) return true;

  const capability = await check(harness);
  if (capability.available) return false;
  const title = `${harness} Harness containment is not established`;
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose:
        `${capability.reason}. Agents whose canonical route uses ${harness} stay out of the ` +
        "slot until it is repaired. Answering confirms the repair; the board re-runs the same " +
        "Harness check before accepting the answer.",
      completion_criteria: `the ${harness} Harness containment is repaired by hand`,
      question: [{ title, options: ["repaired by hand"], recommendation: "repaired by hand" }],
      quarantine_harness: harness,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
  return true;
}
