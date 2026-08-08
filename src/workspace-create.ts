import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { GitHubClient } from "./github.js";
import { authedGit, type GitHubAuth } from "./github-auth.js";
import {
  assertValidWorkspaceName,
  loadRegistry,
  ownEntry,
  type RegistryMode,
  type WorkspaceEntry,
} from "./registry.js";
import {
  assertRegistryCloneReady,
  pushRegistry,
  type RegistryCommitResult,
} from "./registry-write.js";
import {
  conventionCheckoutPath,
  git,
  resolvesToRegistryClone,
  TIDEPOOL_GIT_IDENTITY,
  UnknownWorkspaceError,
} from "./workspace.js";

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

/** What every workspace-admin verb needs: which registry clone to commit to,
 *  and the base directory path-omitting entries derive from (ADR 0018) —
 *  both threaded in by the composition root, never read from env here. */
export interface WorkspaceAdminDeps {
  registryDir: string;
  /** ADR 0052 決定1: workspaces.yaml の検証と一覧が読む正本。読みだけがリモート
   *  へ移り、書き込みはまだローカル main へコミットする(#210)。 */
  registryMode: RegistryMode;
  workspacesBaseDir: string;
  /** ADR 0040 / issue #149: the board's own state paths (fixed for the whole
   *  process), threaded in by the composition root. The creation gate refuses
   *  a workspace that would intersect one of them. Absent → nothing to protect
   *  (a caller outside main.ts, e.g. a test); the pickup-side floor
   *  (claude-worker.ts) still catches whatever gets registered anyway —
   *  including the registry-edit PR path, which never passes this gate. */
  boardState?: BoardStatePath[];
  /** The board's GitHub identity (ADR 0024), absent when no secrets file is
   *  configured — registry pushes and clones then run unauthenticated, the
   *  same fail-closed posture as the optional `github` client below. */
  githubAuth?: GitHubAuth;
}

export interface CreateWorkspaceDeps extends WorkspaceAdminDeps {
  /** Absent (no board GitHub identity, ADR 0024) → the create mode, the one
   *  verb that must call GitHub's API, refuses; register/clone still work. */
  github?: GitHubClient;
}

export type CreateWorkspaceFn = (input: CreateWorkspaceInput) => Promise<RegistryCommitResult>;
export type UpdateWorkspaceFn = (input: UpdateWorkspaceInput) => Promise<RegistryCommitResult>;

/** The settings surface's workspace verbs as one bundle (issue #57): they
 *  exist together or not at all (a registry is configured, or none is), so
 *  the composition root binds them once and the layers in between thread one
 *  dep, not three. */
export interface WorkspaceAdmin {
  create: CreateWorkspaceFn;
  list: () => WorkspaceView[];
  update: UpdateWorkspaceFn;
}

/** The create mode was requested while the board has no GitHub identity
 *  (ADR 0024's fail-closed absence): creating a repository is the one
 *  workspace verb that must call GitHub's API, so it refuses — register and
 *  clone still work. */
export class GitHubIdentityMissingError extends Error {
  constructor() {
    super("workspace create mode needs the board's GitHub identity (TIDEPOOL_GITHUB_TOKEN_FILE)");
    this.name = "GitHubIdentityMissingError";
  }
}

/** The registration gate's refusal (ADR 0040 / issue #149): the checkout this
 *  entry would point at intersects one of the board's own state paths. issue
 *  #121 refused a registration-time check for *injectivity* because that is a
 *  human convention and the check would be inaccurate — this one is path
 *  containment, which is exact, and it guards a floor, so the gate may refuse
 *  it outright. The floor itself still lives at pickup (claude-worker.ts): a
 *  registry-edit PR never passes through here. */
export class BoardStateOverlapError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "BoardStateOverlapError";
  }
}

/** Where this creation's checkout will actually live — the one path the gate
 *  judges. `register` records an explicit host path; `clone` and `create` both
 *  land at the convention-derived location (ADR 0018), which does not exist
 *  yet at gate time (boardStateOverlap resolves the deepest existing ancestor
 *  and joins the rest lexically — ADR 0040). */
function intendedCheckoutPath(input: CreateWorkspaceInput, deps: WorkspaceAdminDeps): string {
  return input.mode === "register"
    ? input.path
    : conventionCheckoutPath(input.name, deps.workspacesBaseDir);
}

/** Orchestrates one workspace creation: external effects first, the registry
 *  commit strictly last (issue #57) — a mid-way failure leaves only orphans
 *  the registry never knew about, never a half-registered entry. */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  deps: CreateWorkspaceDeps,
): Promise<RegistryCommitResult> {
  assertRegistryCloneReady(deps.registryDir);
  const registry = loadRegistry(deps.registryDir, deps.registryMode);
  assertValidWorkspaceName(registry, input.name);
  // ADR 0040: before any external effect — a refused registration must not
  // leave a clone or a GitHub repository behind.
  if (deps.boardState) {
    const overlap = boardStateOverlap(intendedCheckoutPath(input, deps), deps.boardState);
    if (overlap) throw new BoardStateOverlapError(overlap.reason);
  }
  const entry = await buildEntry(input, deps);
  if (input.notes !== undefined) entry.notes = input.notes;
  if (input.protected) entry.protected = true;
  commitWorkspaceEntry(
    deps.registryDir,
    input.name,
    entry,
    `add workspace ${input.name} via WebUI`,
  );
  return { pushed: pushRegistry(deps.registryDir, deps.githubAuth) };
}

/** The edit half of the WebUI's workspace admin (issue #57 phase 3): only
 *  `notes` and `protected` are editable — changing `path`/`repo`/`branch`
 *  re-points the entry at a different real checkout, which stays a manual
 *  edit (the registry is a git repository). */
export interface UpdateWorkspaceInput {
  name: string;
  /** Provided → set; empty string → remove the field. */
  notes?: string;
  protected?: boolean;
  confirm?: boolean;
}

/** Removing protection was requested without the confirmation step (issue
 *  #57, same shape as #55): adding `protected` is frictionless because it
 *  only moves in the safe direction — removal is the one edit that widens
 *  what agents can do, so it never happens on a single unconfirmed click. */
export class UnprotectNeedsConfirmationError extends Error {
  constructor(name: string) {
    super(`removing protection from workspace "${name}" requires confirmation`);
    this.name = "UnprotectNeedsConfirmationError";
  }
}

/** The one unprotect no confirmation can buy (issue #57 / ADR 0013): the
 *  entry pointing at the board's own registry clone. "Changes to the registry
 *  always need human approval" is the floor everything else stands on —
 *  removing it must never be within one click's (or one curl's) reach. */
export class RegistrySelfUnprotectError extends Error {
  constructor(name: string) {
    super(
      `workspace "${name}" is the board's own registry clone — its protection cannot be removed here`,
    );
    this.name = "RegistrySelfUnprotectError";
  }
}


export async function updateWorkspace(
  input: UpdateWorkspaceInput,
  deps: WorkspaceAdminDeps,
): Promise<RegistryCommitResult> {
  assertRegistryCloneReady(deps.registryDir);
  const registry = loadRegistry(deps.registryDir, deps.registryMode);
  const entry = ownEntry(registry.workspaces, input.name);
  if (!entry) throw new UnknownWorkspaceError(input.name);
  const next: WorkspaceEntry = { ...entry };
  if (input.notes !== undefined) {
    if (input.notes === "") delete next.notes;
    else next.notes = input.notes;
  }
  if (input.protected !== undefined) {
    if (input.protected) {
      next.protected = true;
    } else {
      // the self-refusal outranks confirmation — checked first so a confirmed
      // request gets the honest "never here", not another confirm loop. It
      // also ignores the entry's current flag: the floor must not depend on
      // the very state it protects
      if (resolvesToRegistryClone(entry, input.name, deps.registryDir, deps.workspacesBaseDir)) {
        throw new RegistrySelfUnprotectError(input.name);
      }
      if (entry.protected === true && input.confirm !== true) {
        throw new UnprotectNeedsConfirmationError(input.name);
      }
      // absence is the canonical "not protected" — mirrors creation, which
      // never writes `protected: false`
      delete next.protected;
    }
  }
  commitWorkspaceEntry(
    deps.registryDir,
    input.name,
    next,
    `update workspace ${input.name} via WebUI`,
  );
  return { pushed: pushRegistry(deps.registryDir, deps.githubAuth) };
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
  if (!deps.github) throw new GitHubIdentityMissingError();
  const existing = await deps.github.getRepository(input.name);
  const repository = existing ?? (await deps.github.createRepository(input.name));
  return cloneAndDescribe(input.name, repository.url, deps);
}

/** The clone mode's external half: a checkout at the convention-derived
 *  location (ADR 0018 — the entry never records the path). */
function cloneAndDescribe(name: string, repo: string, deps: CreateWorkspaceDeps): WorkspaceEntry {
  const dir = conventionCheckoutPath(name, deps.workspacesBaseDir);
  // idempotent retry (issue #57): a checkout already at the convention-derived
  // location is a completed step — the orphan a previous attempt left when it
  // failed before the registry commit — not a conflict
  // a private repo's clone needs the machine-user token too (ADR 0024) —
  // same injection path as every other board-driven git network call
  if (!existsSync(dir)) authedGit(deps.githubAuth, deps.workspacesBaseDir, "clone", repo, dir);
  // a fresh clone's HEAD is the upstream default branch — recorded when it
  // isn't "main" so branch discipline and the PR base start out right
  // (issue #27); "main" stays implicit (protectedBranch's default)
  const defaultBranch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  return defaultBranch === "main" ? { repo } : { repo, branch: defaultBranch };
}

/** One workspace entry as the settings surface shows it (issue #57 phase 3):
 *  the entry's own fields plus which name it is and whether it is the board's
 *  own registry clone — the one whose protection the UI never offers to
 *  remove (updateWorkspace enforces the same floor server-side). */
export interface WorkspaceView extends WorkspaceEntry {
  name: string;
  registrySelf: boolean;
}

export function listWorkspaceViews(deps: WorkspaceAdminDeps): WorkspaceView[] {
  const registry = loadRegistry(deps.registryDir, deps.registryMode);
  return Object.entries(registry.workspaces).map(([name, entry]) => ({
    ...entry,
    name,
    registrySelf: resolvesToRegistryClone(entry, name, deps.registryDir, deps.workspacesBaseDir),
  }));
}

/** Appends the entry to workspaces.yaml and commits it under the board's own
 *  identity (ADR 0020: a WebUI-initiated registry change is the human's
 *  explicit act — the board commits it to local main directly). The yaml
 *  Document API keeps the hand-edited file's comments and formatting. */
function commitWorkspaceEntry(
  registryDir: string,
  name: string,
  entry: WorkspaceEntry,
  message: string,
): void {
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
  // a no-change edit (the same notes resubmitted) is a successful no-op, not
  // a "nothing to commit" git failure surfacing as a 502
  if (git(registryDir, "status", "--porcelain") !== "") {
    git(registryDir, ...TIDEPOOL_GIT_IDENTITY, "commit", "-m", message);
  }
}
