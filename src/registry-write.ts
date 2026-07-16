import { git } from "./workspace.js";

/** The registry clone can't take the board's direct-to-main commit right now
 *  (ADR 0020): HEAD is off main (a registry-edit task branch is checked out)
 *  or the tree is dirty. Fail-fast and let the human retry — the creation
 *  flow is idempotent (issue #57). */
export class RegistryCloneBusyError extends Error {
  constructor(registryDir: string, reason: string) {
    super(`registry clone at ${registryDir} cannot take a commit: ${reason}`);
    this.name = "RegistryCloneBusyError";
  }
}

/** ADR 0020's write half presumes main: checked before any external effect
 *  (not just before the final commit), so a predictable failure never leaves
 *  orphan clones or repositories behind. */
export function assertRegistryCloneReady(registryDir: string): void {
  const head = git(registryDir, "rev-parse", "--abbrev-ref", "HEAD");
  if (head !== "main") {
    throw new RegistryCloneBusyError(registryDir, `HEAD is on '${head}', not 'main'`);
  }
  if (git(registryDir, "status", "--porcelain") !== "") {
    throw new RegistryCloneBusyError(registryDir, "the working tree is dirty");
  }
}

/** What every registry-writing verb (create, update) reports back. */
export interface RegistryCommitResult {
  /** The registry commit reached the remote. False is non-fatal (issue #57):
   *  the board reads its local clone, so the entry already works — the push
   *  catches up with the next successful one. */
  pushed: boolean;
}

/** Best-effort push of the registry commit (issue #57: push failure is a
 *  warning, never a rollback — the local clone is what the board reads). */
export function pushRegistry(registryDir: string): boolean {
  try {
    git(registryDir, "push", "origin", "main");
    return true;
  } catch (err) {
    console.warn("[registry-write] registry push failed (non-fatal):", err);
    return false;
  }
}
