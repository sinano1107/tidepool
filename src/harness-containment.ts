import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { openQuarantines, quarantineUnlessClear } from "./quarantine.js";
import type { Harness } from "./registry.js";

export type HarnessContainmentCheck = (harness: Harness) => Promise<ContainmentCapability>;

export function quarantinedHarnesses(db: Db): Harness[] {
  return openQuarantines(db, "harnessContainment").map((q) => q.value as Harness);
}

/** Persist the narrowest safe stop: one Confirmation per Harness, never a
 * board-wide halt. Another canonical route remains eligible in the same poll. */
export function harnessContainmentPickupBlocked(
  db: Db,
  harness: Harness,
  check: HarnessContainmentCheck,
  now: Date,
): Promise<boolean> {
  return quarantineUnlessClear(db, "harnessContainment", harness, () => check(harness), now);
}
