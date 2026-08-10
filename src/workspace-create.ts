import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { GitHubClient } from "./github.js";
import { authedGit, type GitHubAuth } from "./github-auth.js";
import {
  assertValidReviewAllowedCommands,
  assertValidWorkspaceName,
  loadRegistry,
  ownEntry,
  type RegistrySource,
  type WorkspaceEntry,
} from "./registry.js";
import { commitToRegistry, refreshRegistryForWrite } from "./registry-write.js";
import {
  conventionCheckoutPath,
  git,
  originUrl,
  resolvesToRegistryClone,
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
  /** どの registry clone を検証・一覧・書き込みに使うか、そのクローンが remote
   *  正本を持つか(ADR 0052 決定1)の組 — 必ず一緒に運ばれるので1つの型にした
   *  (issue #210 レビュー — AgentAdminDeps / ProfileAdminDeps と共有する
   *  Data Clumps だった)。 */
  registry: RegistrySource;
  workspacesBaseDir: string;
  /** ADR 0040 / issue #149: the board's own state paths (fixed for the whole
   *  process), threaded in by the composition root. The creation gate refuses
   *  a workspace that would intersect one of them. Absent → nothing to protect
   *  (a caller outside main.ts, e.g. a test); the pickup-side floor
   *  (claude-worker.ts) still catches whatever gets registered anyway —
   *  including the registry-edit PR path, which never passes this gate. */
  boardState?: BoardStatePath[];
  /** The board's GitHub identity (ADR 0024) for the registry push (ADR 0052
   *  決定1: 失敗は致命 — #210) and clone/repository calls, absent when no
   *  secrets file is configured — clones then run unauthenticated, the same
   *  fail-closed posture as the optional `github` client below. */
  githubAuth?: GitHubAuth;
}

export interface CreateWorkspaceDeps extends WorkspaceAdminDeps {
  /** Absent (no board GitHub identity, ADR 0024) → the create mode, the one
   *  verb that must call GitHub's API, refuses; register/clone still work. */
  github?: GitHubClient;
}

export type CreateWorkspaceFn = (input: CreateWorkspaceInput) => Promise<void>;
export type UpdateWorkspaceFn = (input: UpdateWorkspaceInput) => Promise<void>;

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
export async function createWorkspace(input: CreateWorkspaceInput, deps: CreateWorkspaceDeps): Promise<void> {
  refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
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
  commitWorkspaceEntry(deps, input.name, entry, `add workspace ${input.name} via WebUI`);
}

/** The edit half of the WebUI's workspace admin (issue #57 phase 3): only
 *  `notes`, `protected` and `review_allowed_commands` (ADR 0061) are editable
 *  — changing `path`/`repo`/`branch` re-points the entry at a different real
 *  checkout, which stays a manual edit (the registry is a git repository).
 *  A partial patch throughout: an absent field is untouched, which is what
 *  lets the confirmation gate below judge the payload alone. */
export interface UpdateWorkspaceInput {
  name: string;
  /** Provided → set; empty string → remove the field. */
  notes?: string;
  protected?: boolean;
  /** ADR 0035's review write-floor lift, editable from the human doors since
   *  ADR 0061 (the create door deliberately stays out of it — 決定3). Provided
   *  → set; the empty array removes the key, absence being the canonical "no
   *  commands", the same shape as `protected` below. */
  review_allowed_commands?: string[];
  /** Consent to every dangerous value in this payload, not to unprotecting
   *  alone (ADR 0061 決定1) — one boolean, the refusal's reason codes say
   *  what it bought. */
  confirm?: boolean;
}

/** Machine-readable reason codes `dangerousWorkspaceValues` can return — the
 *  workspace twin of profile-create's `DangerousValueReason`, stable strings
 *  a door's refusal enumerates rather than prose (ADR 0061 決定1). */
export type DangerousWorkspaceValueReason = "unprotect" | "review_allowed_commands_set";

/** Pure judgment of which values in *this payload* widen what agents may do
 *  (ADR 0061 決定2): removing protection, and setting the review write-floor
 *  lift to a non-empty list. It never reads the entry being edited — the
 *  update is a partial patch, so a field the human did not touch is simply
 *  absent, and the empty array (clearing the list) moves in the safe
 *  direction and asks nothing. */
function dangerousWorkspaceValues(
  input: Pick<UpdateWorkspaceInput, "protected" | "review_allowed_commands">,
): DangerousWorkspaceValueReason[] {
  const reasons: DangerousWorkspaceValueReason[] = [];
  if (input.protected === false) reasons.push("unprotect");
  if (input.review_allowed_commands?.length) reasons.push("review_allowed_commands_set");
  return reasons;
}

/** A payload carrying dangerous values arrived without `confirm` (issue #57,
 *  generalized by ADR 0061 決定1 from "removing protection" to "every
 *  dangerous value in this payload"). Enforcement lives here in the domain,
 *  once: the API maps this to a 409 with `dangerous_values`, the management
 *  MCP to a tool error — and both bodies enumerate the reason codes, so the
 *  message carries them too rather than only the structured field. */
export class WorkspaceConfirmationRequiredError extends Error {
  constructor(
    name: string,
    public readonly reasons: DangerousWorkspaceValueReason[],
  ) {
    super(
      `workspace "${name}" edit contains dangerous values (${reasons.join(", ")}); resubmit with confirm: true`,
    );
    this.name = "WorkspaceConfirmationRequiredError";
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


export async function updateWorkspace(input: UpdateWorkspaceInput, deps: WorkspaceAdminDeps): Promise<void> {
  refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const entry = ownEntry(registry.workspaces, input.name);
  if (!entry) throw new UnknownWorkspaceError(input.name);
  // the self-refusal outranks confirmation — checked first so a confirmed
  // request gets the honest "never here", not another confirm loop. It also
  // ignores the entry's current flag: the floor must not depend on the very
  // state it protects
  if (
    input.protected === false &&
    resolvesToRegistryClone(entry, input.name, deps.registry.dir, deps.workspacesBaseDir)
  ) {
    throw new RegistrySelfUnprotectError(input.name);
  }
  // grammar before confirmation, for the same reason as the self-refusal: a
  // malformed prefix is not something a confirm can buy, and the value the
  // human read must be the one the CLI receives (ADR 0061 根拠5)
  if (input.review_allowed_commands) assertValidReviewAllowedCommands(input.review_allowed_commands);
  const dangerous = dangerousWorkspaceValues(input);
  if (dangerous.length > 0 && input.confirm !== true) {
    throw new WorkspaceConfirmationRequiredError(input.name, dangerous);
  }
  const next: WorkspaceEntry = { ...entry };
  if (input.notes !== undefined) {
    if (input.notes === "") delete next.notes;
    else next.notes = input.notes;
  }
  if (input.protected !== undefined) {
    // absence is the canonical "not protected" — mirrors creation, which
    // never writes `protected: false`
    if (input.protected) next.protected = true;
    else delete next.protected;
  }
  if (input.review_allowed_commands !== undefined) {
    if (input.review_allowed_commands.length === 0) delete next.review_allowed_commands;
    else next.review_allowed_commands = input.review_allowed_commands;
  }
  commitWorkspaceEntry(deps, input.name, next, `update workspace ${input.name} via WebUI`);
}

/** Each mode's external half, ordered so the registry commit stays last.
 *  The create mode is the clone mode with one extra step in front: ensure
 *  the repository exists (reusing a same-name one — idempotent retry), then
 *  both funnel into the same checkout-and-describe path. */
async function buildEntry(
  input: CreateWorkspaceInput,
  deps: CreateWorkspaceDeps,
): Promise<WorkspaceEntry> {
  if (input.mode === "register") return registerExistingCheckout(input.path);
  if (input.mode === "clone") return cloneAndDescribe(input.name, input.repo, deps);
  if (!deps.github) throw new GitHubIdentityMissingError();
  const existing = await deps.github.getRepository(input.name);
  const repository = existing ?? (await deps.github.createRepository(input.name));
  return cloneAndDescribe(input.name, repository.url, deps);
}

/** The register mode's half: the entry records the explicit host path, plus the
 *  checkout's own `origin` URL as its **remote-source-of-truth declaration**
 *  (ADR 0052 決定3 / issue #211). Reading it here is what makes the declaration a
 *  declaration at all — the clone/create modes get it for free because they were
 *  handed the URL, and the board must not be left inferring it from the clone at
 *  every use (the fallback ADR 0052 rejected by name).
 *
 *  No remote → no `repo`: a checkout that is nobody's clone is a legitimate,
 *  purely-local workspace, and writing `repo` anyway would manufacture exactly
 *  the declaration/reality mismatch that pickup quarantines. A path that isn't a
 *  git repository at all lands here too — the registration gate has never
 *  validated that (a checkout can be placed after the entry), so the absent
 *  declaration is the honest one to write. */
function registerExistingCheckout(path: string): WorkspaceEntry {
  const repo = originUrl(path);
  return repo === undefined ? { path } : { path, repo };
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
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  return Object.entries(registry.workspaces).map(([name, entry]) => ({
    ...entry,
    name,
    registrySelf: resolvesToRegistryClone(entry, name, deps.registry.dir, deps.workspacesBaseDir),
  }));
}

/** Appends the entry to workspaces.yaml inside a disposable worktree and
 *  lands it under the board's own identity (ADR 0020 / ADR 0052 決定6). The
 *  yaml Document API keeps the hand-edited file's comments and formatting.
 *  Reads the file from the worktree, not the registry clone's own working
 *  tree — the clone's checkout is a cache the write never depends on, so the
 *  content this merges into is always the one the worktree actually forked
 *  from. A no-change edit (the same notes resubmitted) is a successful no-op
 *  — `commitToRegistry` skips landing when `write` leaves the tree clean. */
function commitWorkspaceEntry(
  deps: WorkspaceAdminDeps,
  name: string,
  entry: WorkspaceEntry,
  message: string,
): void {
  commitToRegistry(
    deps.registry,
    deps.githubAuth,
    (worktreeDir) => {
      const file = join(worktreeDir, "workspaces.yaml");
      const doc = parseDocument(readFileSync(file, "utf8"));
      doc.set(name, entry);
      writeFileSync(file, doc.toString());
    },
    message,
  );
}
