import type { Db } from "./db.js";
import type { RegistryReachabilityCheck } from "./registry.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

export const REGISTRY_REACHABILITY_QUESTION_TITLE =
  "registry remote is unreachable — pickup is stopped";

/** The open Confirmation question is the durable half of this board-wide
 *  quarantine: recovery alone never resumes pickup without human acknowledgement. */
export function openRegistryReachabilityQuestion(db: Db): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM tasks
       WHERE question_quarantine_registry IS NOT NULL AND status = 'todo'`,
    )
    .get() as { id: string } | undefined;
}

export function quarantineRegistryReachability(db: Db, reason: string, now: Date): void {
  if (openRegistryReachabilityQuestion(db)) return;
  registerTask(
    db,
    {
      type: "question",
      title: REGISTRY_REACHABILITY_QUESTION_TITLE,
      purpose:
        `${reason}. No agent task is picked up while this stands because every spawn depends ` +
        "on the registry source of truth. Repair access to the registry remote, then answer — " +
        "the board refreshes it again before accepting the answer, and keeps any answer text as " +
        "a repair note (ADR 0052).",
      completion_criteria: "the registry remote main is reachable again",
      question: [
        {
          title: REGISTRY_REACHABILITY_QUESTION_TITLE,
          options: ["repaired by hand"],
          recommendation: "repaired by hand",
        },
      ],
      quarantine_registry: true,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

/** Candidate-time fail-closed gate. An open question short-circuits the live
 *  check so repair cannot silently resume pickup before a human confirms it. */
export async function registryReachabilityPickupBlocked(
  db: Db,
  reachability: RegistryReachabilityCheck,
  now: Date,
): Promise<boolean> {
  if (openRegistryReachabilityQuestion(db)) return true;
  const result = await reachability();
  if (result.available) return false;
  quarantineRegistryReachability(db, result.reason ?? "registry remote is unreachable", now);
  return true;
}
