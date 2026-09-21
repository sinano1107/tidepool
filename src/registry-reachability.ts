import type { Db } from "./db.js";
import { quarantineUnlessClear, registerQuarantine } from "./quarantine.js";
import type { RegistryReachabilityCheck } from "./registry.js";

/** The open Confirmation question is the durable half of this board-wide
 *  quarantine: recovery alone never resumes pickup without human acknowledgement. */
export function quarantineRegistryReachability(db: Db, reason: string, now: Date): void {
  registerQuarantine(db, "registryReachability", null, reason, now);
}

/** Candidate-time fail-closed gate. An open question short-circuits the live
 *  check so repair cannot silently resume pickup before a human confirms it. */
export function registryReachabilityPickupBlocked(
  db: Db,
  reachability: RegistryReachabilityCheck,
  now: Date,
): Promise<boolean> {
  return quarantineUnlessClear(
    db,
    "registryReachability",
    null,
    async () => {
      const result = await reachability();
      return result.available
        ? { available: true }
        : { available: false, reason: result.reason ?? "registry remote is unreachable" };
    },
    now,
  );
}
