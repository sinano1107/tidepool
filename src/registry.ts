import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { parse as parseTwemoji } from "@twemoji/parser";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** An agent definition file: `agents/<name>.md` in the registry clone.
 *  Frontmatter carries the machine-stamped version and the authority profile
 *  reference; the markdown body is the agent's system prompt. */
export interface AgentDefinition {
  name: string;
  version: string;
  authority: string;
  /** The one line of prose a roster entry shows a delegating agent (issue
   *  #43 / ADR 0014): "when this agent is the right delegate", not a genre
   *  label. Required — an agent registered without one has no way to be
   *  picked from a roster, same hygiene as issue #41's assignable_to. */
  description: string;
  /** Base-AI model for this agent (CONTEXT.md: agent = base AI + skills +
   *  instructions + authority profile). Absent → the adapter's default. */
  model?: string;
  /** Reasoning effort for this agent's sessions. Absent → the adapter's
   *  default. Free string here — the closed set of valid values (if any)
   *  is vendor knowledge that belongs to the adapter, not this registry
   *  (ADR 0005). */
  effort?: string;
  /** Visual identity emoji for this agent (issue #52), shown by the board
   *  UI's AgentChip. Absent → the UI falls back to hashed initials. Loader
   *  checks only structural validity — a single Twemoji-covered grapheme
   *  (ADR 0026) — never semantics ("prefer sea creatures" stays a registry
   *  README convention, unenforceable by schema). */
  icon?: string;
  systemPrompt: string;
}

/** An authority profile: `authority/<profile>.yaml` in the registry clone.
 *  `guidance` is prose injected into the agent's system prompt at spawn.
 *  `assignable_to` (issue #11) is a machine-enforced delegation allowlist —
 *  confused-deputy prevention: a decompose child assigned outside this list
 *  converts to an approval question rather than registering (ADR 0002).
 *  `allowed_workspaces` (issue #11) is its spatial analogue: a decompose
 *  child explicitly targeting a workspace outside this list converts the
 *  same way. A profile loaded from the registry (via `authorityProfileSchema`
 *  below) always carries both fields explicitly — omission is a load error
 *  (issue #41: "absent means unrestricted" was a silent footgun for registry
 *  authors). Unrestricted must instead be spelled out with the wildcard
 *  `"*"`, which `outsideAuthority` (tasks.ts) reads as "no restriction". The
 *  fields stay optional on this TS type only because `AuthorityProfile`
 *  values are also hand-built in code paths that never go through the
 *  registry loader — the read-only reviewer floor (`REVIEWER_AUTHORITY_PROFILE`
 *  in mcp.ts, ADR 0013) and per-task `resolveAuthority` overrides in tests —
 *  where omission legitimately still means unrestricted; issue #41 is
 *  registry-side profile hygiene only, not a change to that code-side shape.
 *  `merge` (issue #11) is the authority dial over merging a task's PR —
 *  "merge is the start of external effect": `escalate` always asks a human
 *  first; `auto_if_ci_green` merges unattended once CI passes, but only for a
 *  task that carries no risk (a risky task always asks, regardless of the
 *  dial). Absent means no automatic merge decision at all — a PR opens and
 *  nothing more happens (today's pre-#11 baseline), same "absent is inert"
 *  shape as the other two fields once loaded from code rather than the
 *  registry. */
export interface AuthorityProfile {
  name: string;
  guidance: string;
  assignable_to?: string[];
  allowed_workspaces?: string[];
  merge?: "escalate" | "auto_if_ci_green";
}

const workspaceEntrySchema = z.object({
  /** Absent → regulation-derived at resolution time (ADR 0018): base
   *  directory (`TIDEPOOL_WORKSPACES_DIR`) + workspace name, computed at
   *  `resolveExecutionWorkspace` (workspace.ts), never baked in here. Entries
   *  the board writes itself (clone / new-repo creation modes) stay host-
   *  independent this way — a push from one host's clone can't commit the
   *  other host's absolute path. Explicit `path` stays for hand-placed
   *  checkouts (the registry itself, existing-path registration mode). */
  path: z.string().optional(),
  repo: z.string().optional(),
  notes: z.string().optional(),
  /** Protected workspace (issue #15 layer 2 / ADR 0013): a decompose child
   *  targeting this workspace converts to an approval question unconditionally,
   *  regardless of the registering worker's authority profile. v1's only use is
   *  the registry itself — "changes to it always need human approval" is a
   *  resource-side invariant, independent of any profile's allowed_workspaces. */
  protected: z.boolean().optional(),
  /** The protected branch this workspace's tasks fork from and PR onto
   *  (issue #27 / ADR 0023): task-branch fork point, PR base, and direct-
   *  write-ban target, all one field. Absent → "main". A reference, not a
   *  pinned fork fact — resolved fresh against the registry at every use
   *  moment (ensureTaskBranch, PR open), never baked into a task row. */
  branch: z.string().optional(),
});

/** A workspace entry in `workspaces.yaml`: where tasks run (name → path on
 *  the host), plus provenance for setting the checkout up by hand. */
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export interface Registry {
  /** HEAD commit hash of the clone — the provenance stamp recorded on spawn. */
  commit: string;
  agents: Record<string, AgentDefinition>;
  authority: Record<string, AuthorityProfile>;
  workspaces: Record<string, WorkspaceEntry>;
}

/** One roster line's worth of an `AgentDefinition` (issue #43 / ADR 0014):
 *  a delegating agent only ever needs the name and the "when to delegate
 *  here" prose, never the vendor fields (`model`/`effort`, ADR 0005's line).
 *  Named so the pull half's plumbing (McpDeps/ServerOptions/BootOptions,
 *  each threading a registry → mcp.ts list of these) carries one shared
 *  type instead of repeating the same anonymous `{ name; description }`
 *  shape at every layer. */
export interface RosterAgent {
  name: string;
  description: string;
}

/** Assignee/workspace name candidates for the registration screen (issue
 *  #12), resolved from the registry by the caller (main.ts) — the API/server
 *  layers never touch the filesystem/git registry loader themselves. */
export interface RegistryCandidates {
  assignees: string[];
  workspaces: string[];
  /** Assignee name → icon (issue #52), for agents that have one configured.
   *  An assignee absent from this map has no icon — the board UI's
   *  AgentChip falls back to hashed initials for it. */
  icons: Record<string, string>;
}

/** ADR 0026: an agent icon must be a single Twemoji-covered emoji grapheme —
 *  parsing it must yield exactly one entity spanning the whole string. Two
 *  emoji, trailing text, or an emoji outside Twemoji's coverage all fail
 *  this the same way (fewer/more entities, or entity indices short of the
 *  full length). */
export function isSingleTwemojiGrapheme(value: string): boolean {
  const entities = parseTwemoji(value);
  if (entities.length !== 1) return false;
  const [entity] = entities;
  return entity!.indices[0] === 0 && entity!.indices[1] === value.length;
}

const agentFrontmatterSchema = z.looseObject({
  version: z.coerce.string(),
  authority: z.string(),
  description: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  icon: z
    .string()
    .refine(isSingleTwemojiGrapheme, {
      message: "icon must be a single Twemoji-covered emoji grapheme",
    })
    .optional(),
});

/** ADR 0020: the branch the board reads the registry from is a code constant,
 *  not registry data. "Which branch do we trust to read from" is part of the
 *  protected-workspace floor (same shape as ADR 0013's reviewer floor); putting
 *  it in the data it guards (workspaces.yaml's branch field, issue #27) would be
 *  self-referential and break bootstrap. The working tree is never read — branch
 *  discipline moves the checkout's HEAD onto a registry-edit task branch, so a
 *  working-tree read would let unmerged content take effect on spawn. */
export const REGISTRY_BRANCH = "main";

// stderr piped (not inherited), same as workspace.ts's `git()`: git narrates a
// missing ref on stderr, and the board's console is not the place for it — the
// message still rides the thrown error for callers that want it (agentBodyAtCommit
// swallows it by design).
const GIT_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/** Read one committed file's content at `ref` — `git show ref:path`. The board
 *  reads the registry from the committed branch, never the working tree. */
function gitShowFile(dir: string, ref: string, path: string): string {
  return execFileSync("git", ["show", `${ref}:${path}`], { cwd: dir, stdio: GIT_STDIO }).toString();
}

/** The paths of the entries directly under `subdir` at `ref` (e.g.
 *  `agents/deckhand.md`). A missing directory yields no entries — the same
 *  "absent is empty, not an error" shape `readdirSync` had on a present-but-
 *  empty directory. */
function gitListDir(dir: string, ref: string, subdir: string): string[] {
  const out = execFileSync("git", ["ls-tree", "--name-only", ref, `${subdir}/`], {
    cwd: dir,
    stdio: GIT_STDIO,
  })
    .toString()
    .trim();
  return out === "" ? [] : out.split("\n");
}

/** Split a `---\nfrontmatter\n---\nbody` document into its two halves, or null
 *  when the frontmatter fence is absent. One regex shared by the agent-file
 *  parser and the historical-body read (ADR 0020 part 4), so the split is
 *  spelled once. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  return match ? { frontmatter: match[1]!, body: match[2]! } : null;
}

/** The system-prompt body of an agent definition as it stood at a given commit
 *  (ADR 0020 part 4) — `git show <commit>:agents/<name>.md` with the frontmatter
 *  stripped. Best-effort: returns undefined when the commit or file is gone
 *  (e.g. a kill left no worker_spawned hash, or the definition post-dates it) or
 *  the file has no parseable body, so a self-RCA spawn degrades to no injected
 *  evidence rather than failing the spawn. Deliberately does not run the full
 *  frontmatter schema — an older, differently-shaped definition is still valid
 *  evidence for "why did I decide", and this read must not reject it. */
export function agentBodyAtCommit(
  dir: string,
  commit: string,
  agentName: string,
): string | undefined {
  let raw: string;
  try {
    raw = gitShowFile(dir, commit, `agents/${agentName}.md`);
  } catch {
    return undefined;
  }
  return splitFrontmatter(raw)?.body.trim();
}

function parseAgentFile(name: string, raw: string): AgentDefinition {
  const split = splitFrontmatter(raw);
  if (!split) {
    throw new Error(`agent ${name}: missing frontmatter`);
  }
  const { frontmatter, body } = split;
  const meta = agentFrontmatterSchema.parse(parseYaml(frontmatter));
  return {
    name,
    version: meta.version,
    authority: meta.authority,
    description: meta.description,
    model: meta.model,
    effort: meta.effort,
    icon: meta.icon,
    systemPrompt: body.trim(),
  };
}

// closed schema: an escalation-rights field cannot exist even by
// misconfiguration — upward escalation is never restricted (issue #7).
// assignable_to/allowed_workspaces are required, not optional: a registry
// author must spell out "*" for unrestricted rather than get it by omission
// (issue #41).
export const authorityProfileSchema = z.strictObject({
  guidance: z.string(),
  assignable_to: z.array(z.string()),
  allowed_workspaces: z.array(z.string()),
  merge: z.enum(["escalate", "auto_if_ci_green"]).optional(),
});

/** No authority profile in the registry carries this name — thrown both when
 *  an agent's `authority` field references one that doesn't exist
 *  (agent-create.ts) and when editing a profile by a name the registry
 *  doesn't have (profile-create.ts, issue #76): the same "profile absent"
 *  condition, one class. */
export class UnknownAuthorityProfileError extends Error {
  constructor(public readonly profileName: string) {
    super(`unknown authority profile: ${profileName}`);
    this.name = "UnknownAuthorityProfileError";
  }
}

const workspacesSchema = z.record(z.string(), workspaceEntrySchema);

function parseAuthorityFile(name: string, raw: string): AuthorityProfile {
  const profile = authorityProfileSchema.parse(parseYaml(raw));
  return {
    name,
    guidance: profile.guidance,
    assignable_to: profile.assignable_to,
    allowed_workspaces: profile.allowed_workspaces,
    merge: profile.merge,
  };
}

/** Issue #68 / ADR 0018: the charset a registry-entry name (workspace or
 *  agent, issue #70) must stay inside to be safe as a directory name
 *  (regulation-derived `path`), a GitHub repository name (clone / new-repo
 *  creation modes), and the file name `agents/<name>.md`. */
const REGISTRY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** `.` and `..` pass the charset above but are reserved by every filesystem
 *  (self / parent directory) — an entry named either would derive a path
 *  that escapes its intended base directory. */
const RESERVED_REGISTRY_NAMES = new Set([".", ".."]);

const NAME_CHARSET_REASON =
  "must contain only letters, digits, '-', '_', '.' and not be '.' or '..'";

/** A candidate workspace name fails the entry gate the creation modes
 *  (issue #57 phase 2) will use: reused inside an existing registry, or
 *  outside the charset both a directory name and a GitHub repo name accept. */
export class InvalidWorkspaceNameError extends Error {
  constructor(
    public readonly workspaceName: string,
    reason: string,
  ) {
    super(`invalid workspace name "${workspaceName}": ${reason}`);
    this.name = "InvalidWorkspaceNameError";
  }
}

/** Pure entry-gate validation for a new workspace name (issue #68), ahead of
 *  the orchestration (clone / new-repo creation, phase 2) that will actually
 *  register it. Checks uniqueness against `registry` and the shared charset —
 *  safe for both a directory name and a GitHub repository name. */
export function assertValidWorkspaceName(registry: Registry, name: string): void {
  if (RESERVED_REGISTRY_NAMES.has(name) || !REGISTRY_NAME_PATTERN.test(name)) {
    throw new InvalidWorkspaceNameError(name, NAME_CHARSET_REASON);
  }
  if (Object.hasOwn(registry.workspaces, name)) {
    throw new InvalidWorkspaceNameError(name, "a workspace with this name already exists");
  }
}

/** A candidate agent name fails the entry gate the WebUI's agent-creation
 *  verb (issue #70) uses: reused inside an existing registry, or outside the
 *  charset a file name `agents/<name>.md` safely accepts. */
export class InvalidAgentNameError extends Error {
  constructor(
    public readonly agentName: string,
    reason: string,
  ) {
    super(`invalid agent name "${agentName}": ${reason}`);
    this.name = "InvalidAgentNameError";
  }
}

/** Pure entry-gate validation for a new agent name (issue #70), the agent
 *  twin of assertValidWorkspaceName above: same charset (safe as the file
 *  name `agents/<name>.md`), same reserved names, uniqueness against the
 *  registry's agents. */
export function assertValidAgentName(registry: Registry, name: string): void {
  if (RESERVED_REGISTRY_NAMES.has(name) || !REGISTRY_NAME_PATTERN.test(name)) {
    throw new InvalidAgentNameError(name, NAME_CHARSET_REASON);
  }
  if (Object.hasOwn(registry.agents, name)) {
    throw new InvalidAgentNameError(name, "an agent with this name already exists");
  }
}

/** A candidate authority profile name fails the entry gate the WebUI's
 *  profile-creation verb (issue #76) uses: reused inside an existing
 *  registry, or outside the charset a file name `authority/<name>.yaml`
 *  safely accepts. */
export class InvalidAuthorityProfileNameError extends Error {
  constructor(
    public readonly profileName: string,
    reason: string,
  ) {
    super(`invalid authority profile name "${profileName}": ${reason}`);
    this.name = "InvalidAuthorityProfileNameError";
  }
}

/** Pure entry-gate validation for a new authority profile name (issue #76),
 *  the third twin of assertValidWorkspaceName/assertValidAgentName: same
 *  charset (safe as the file name `authority/<name>.yaml`), same reserved
 *  names, uniqueness against the registry's profiles. */
export function assertValidAuthorityProfileName(registry: Registry, name: string): void {
  if (RESERVED_REGISTRY_NAMES.has(name) || !REGISTRY_NAME_PATTERN.test(name)) {
    throw new InvalidAuthorityProfileNameError(name, NAME_CHARSET_REASON);
  }
  if (Object.hasOwn(registry.authority, name)) {
    throw new InvalidAuthorityProfileNameError(name, "an authority profile with this name already exists");
  }
}

/** Bracket access with an Object.hasOwn guard (issue #69): registry records
 *  are plain objects, so a key like "toString" would otherwise hit
 *  Object.prototype and dodge the fail-closed unknown-name guarantees (ADR
 *  0009 / 0012). Every registry-record lookup by untrusted name goes through
 *  here — the guarantee lives in one place. */
export function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Load the registry from committed `main` (ADR 0020) — never the working tree.
 *  Every read (agent definitions, authority profiles, workspaces.yaml) and the
 *  provenance `commit` come from the same ref, so the recorded hash and the
 *  content actually read agree by construction (no dirty flag needed). */
export function loadRegistry(dir: string): Registry {
  const ref = REGISTRY_BRANCH;
  const agents: Record<string, AgentDefinition> = {};
  for (const path of gitListDir(dir, ref, "agents")) {
    if (!path.endsWith(".md")) continue;
    const agent = parseAgentFile(basename(path, ".md"), gitShowFile(dir, ref, path));
    agents[agent.name] = agent;
  }
  const authority: Record<string, AuthorityProfile> = {};
  for (const path of gitListDir(dir, ref, "authority")) {
    if (!path.endsWith(".yaml")) continue;
    const profile = parseAuthorityFile(basename(path, ".yaml"), gitShowFile(dir, ref, path));
    authority[profile.name] = profile;
  }
  const workspaces = workspacesSchema.parse(parseYaml(gitShowFile(dir, ref, "workspaces.yaml")));
  const commit = execFileSync("git", ["rev-parse", ref], { cwd: dir, stdio: GIT_STDIO })
    .toString()
    .trim();
  return { commit, agents, authority, workspaces };
}
