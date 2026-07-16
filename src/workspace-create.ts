import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import type { GitHubClient } from "./github.js";
import { assertValidWorkspaceName, loadRegistry, type WorkspaceEntry } from "./registry.js";
import { git, TIDEPOOL_GIT_IDENTITY } from "./workspace.js";

/** The WebUI's workspace-creation verbs (issue #57): three entrances, one
 *  resulting Workspace — the mode is a circumstance of creation, not a kind
 *  (CONTEXT.md's Workspace). Human-only; agents keep going through
 *  registry-edit tasks instead (2026-07-14 grilling). */
export type CreateWorkspaceInput = {
  name: string;
  notes?: string;
  /** Setting protection at creation needs no confirmation step — adding it
   *  only ever moves in the safe direction (issue #57; removal is the edit
   *  flow's confirmed action). */
  protected?: boolean;
} & (
  | {
      mode: "register";
      /** The existing checkout on this host — the one mode that records an
       *  explicit, host-specific path (ADR 0018 keeps board-created entries
       *  convention-derived instead). */
      path: string;
    }
  | {
      mode: "clone";
      /** What `git clone` accepts — recorded on the entry as provenance. */
      repo: string;
    }
  | {
      /** The name doubles as the new GitHub repository's name — the shared
       *  charset assertValidWorkspaceName enforces is safe for both. */
      mode: "create";
    }
);

export interface CreateWorkspaceDeps {
  /** The board's registry clone — where the new entry is committed. */
  registryDir: string;
  /** resolveWorkspacesBaseDir's output (ADR 0018), threaded in by the
   *  composition root — never read from env here. */
  workspacesBaseDir: string;
  github: GitHubClient;
}

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
function assertRegistryCloneReady(registryDir: string): void {
  const head = git(registryDir, "rev-parse", "--abbrev-ref", "HEAD");
  if (head !== "main") {
    throw new RegistryCloneBusyError(registryDir, `HEAD is on '${head}', not 'main'`);
  }
  if (git(registryDir, "status", "--porcelain") !== "") {
    throw new RegistryCloneBusyError(registryDir, "the working tree is dirty");
  }
}

export interface CreateWorkspaceResult {
  /** The registry commit reached the remote. False is non-fatal (issue #57):
   *  the board reads its local clone, so the entry already works — the push
   *  catches up with the next successful one. */
  pushed: boolean;
}

/** The orchestration as its consumers see it (api.ts / server.ts): the
 *  composition root binds the deps here once, everyone downstream gets one
 *  callback. */
export type CreateWorkspaceFn = (input: CreateWorkspaceInput) => Promise<CreateWorkspaceResult>;

/** Orchestrates one workspace creation: external effects first, the registry
 *  commit strictly last (issue #57) — a mid-way failure leaves only orphans
 *  the registry never knew about, never a half-registered entry. */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  deps: CreateWorkspaceDeps,
): Promise<CreateWorkspaceResult> {
  assertRegistryCloneReady(deps.registryDir);
  const registry = loadRegistry(deps.registryDir);
  assertValidWorkspaceName(registry, input.name);
  const entry = await buildEntry(input, deps);
  if (input.notes !== undefined) entry.notes = input.notes;
  if (input.protected) entry.protected = true;
  commitWorkspaceEntry(deps.registryDir, input.name, entry);
  return { pushed: pushRegistry(deps.registryDir) };
}

/** Each mode's external half, ordered so the registry commit stays last.
 *  The create mode is the clone mode with one extra step in front: ensure
 *  the repository exists (reusing a same-name one — idempotent retry), then
 *  both funnel into the same checkout-and-describe path. */
async function buildEntry(
  input: CreateWorkspaceInput,
  deps: CreateWorkspaceDeps,
): Promise<WorkspaceEntry> {
  if (input.mode === "register") return { path: input.path };
  if (input.mode === "clone") return cloneAndDescribe(input.name, input.repo, deps);
  const existing = await deps.github.getRepository(input.name);
  const repository = existing ?? (await deps.github.createRepository(input.name));
  return cloneAndDescribe(input.name, repository.url, deps);
}

/** The clone mode's external half: a checkout at the convention-derived
 *  location (ADR 0018 — the entry never records the path). */
function cloneAndDescribe(name: string, repo: string, deps: CreateWorkspaceDeps): WorkspaceEntry {
  const dir = join(deps.workspacesBaseDir, name);
  // idempotent retry (issue #57): a checkout already at the convention-derived
  // location is a completed step — the orphan a previous attempt left when it
  // failed before the registry commit — not a conflict
  if (!existsSync(dir)) git(deps.workspacesBaseDir, "clone", repo, dir);
  // a fresh clone's HEAD is the upstream default branch — recorded when it
  // isn't "main" so branch discipline and the PR base start out right
  // (issue #27); "main" stays implicit (protectedBranch's default)
  const defaultBranch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  return defaultBranch === "main" ? { repo } : { repo, branch: defaultBranch };
}

/** Best-effort push of the registry commit (issue #57: push failure is a
 *  warning, never a rollback — the local clone is what the board reads). */
function pushRegistry(registryDir: string): boolean {
  try {
    git(registryDir, "push", "origin", "main");
    return true;
  } catch (err) {
    console.warn("[workspace-create] registry push failed (non-fatal):", err);
    return false;
  }
}

/** Appends the entry to workspaces.yaml and commits it under the board's own
 *  identity (ADR 0020: a WebUI-initiated registry change is the human's
 *  explicit act — the board commits it to local main directly). The yaml
 *  Document API keeps the hand-edited file's comments and formatting. */
function commitWorkspaceEntry(registryDir: string, name: string, entry: WorkspaceEntry): void {
  // re-checked here, not just at the entrance: the external steps in between
  // (clone, repository creation) are slow, and a registry-edit task moving
  // the clone's HEAD meanwhile must not get the board's commit on its branch.
  // This same guarantee (on main + clean) is also what lets the write below
  // read the working tree without violating ADR 0020's committed-main rule.
  assertRegistryCloneReady(registryDir);
  const file = join(registryDir, "workspaces.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));
  doc.set(name, entry);
  writeFileSync(file, doc.toString());
  git(registryDir, "add", "workspaces.yaml");
  git(registryDir, ...TIDEPOOL_GIT_IDENTITY, "commit", "-m", `add workspace ${name} via WebUI`);
}
