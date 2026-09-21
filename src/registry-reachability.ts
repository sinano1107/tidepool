import type { Db } from "./db.js";
import { quarantineUnlessClear } from "./quarantine.js";
import type { RegistryReachabilityCheck } from "./registry.js";

/** Candidate-time fail-closed gate. The open Confirmation question is the durable
 *  half of this board-wide quarantine: it short-circuits the live check so repair
 *  cannot silently resume pickup before a human confirms it. */
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
