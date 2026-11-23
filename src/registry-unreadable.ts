import type { Db } from "./db.js";
import { quarantineUnlessClear } from "./quarantine.js";
import type { RegistryAvailabilityCheck } from "./registry.js";

/** Candidate-time fail-closed gate. The open Confirmation question is the durable
 *  half of this board-wide quarantine: it short-circuits the live check so repair
 *  cannot silently resume pickup before a human confirms it. */
export function registryUnreadablePickupBlocked(
  db: Db,
  reachability: RegistryAvailabilityCheck,
  now: () => Date,
): Promise<boolean> {
  return quarantineUnlessClear(
    db,
    "registryUnreadable",
    null,
    async () => {
      const result = await reachability();
      return result.available
        ? { available: true }
        : { available: false, reason: result.reason ?? "registry check failed" };
    },
    now,
  );
}
