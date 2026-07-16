import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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
function isSingleTwemojiGrapheme(value: string): boolean {
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

function parseAgentFile(path: string): AgentDefinition {
  const name = basename(path, ".md");
  const raw = readFileSync(path, "utf8");
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const [, frontmatter, body] = match ?? [];
  if (frontmatter === undefined || body === undefined) {
    throw new Error(`agent ${name}: missing frontmatter`);
  }
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
const authorityProfileSchema = z.strictObject({
  guidance: z.string(),
  assignable_to: z.array(z.string()),
  allowed_workspaces: z.array(z.string()),
  merge: z.enum(["escalate", "auto_if_ci_green"]).optional(),
});

const workspacesSchema = z.record(z.string(), workspaceEntrySchema);

function parseAuthorityFile(path: string): AuthorityProfile {
  const name = basename(path, ".yaml");
  const profile = authorityProfileSchema.parse(parseYaml(readFileSync(path, "utf8")));
  return {
    name,
    guidance: profile.guidance,
    assignable_to: profile.assignable_to,
    allowed_workspaces: profile.allowed_workspaces,
    merge: profile.merge,
  };
}

/** Issue #68 / ADR 0018: the charset a workspace name must stay inside to be
 *  safe as both a directory name (regulation-derived `path`) and a GitHub
 *  repository name (clone / new-repo creation modes, phase 2). */
const WORKSPACE_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** `.` and `..` pass the charset above but are reserved by every filesystem
 *  (self / parent directory) — a workspace named either would derive a path
 *  that escapes its intended base directory. */
const RESERVED_WORKSPACE_NAMES = new Set([".", ".."]);

/** A candidate workspace name fails the entry gate the creation modes
 *  (issue #57 phase 2) will use: reused inside an existing registry, or
 *  outside the charset both a directory name and a GitHub repo name accept. */
export class InvalidWorkspaceNameError extends Error {
  constructor(
    public readonly workspaceName: string,
    reason: string,
  ) {
    super(`invalid workspace name "${workspaceName}": ${reason}`);
  }
}

/** Pure entry-gate validation for a new workspace name (issue #68), ahead of
 *  the orchestration (clone / new-repo creation, phase 2) that will actually
 *  register it. Checks uniqueness against `registry` and the shared charset —
 *  safe for both a directory name and a GitHub repository name. */
export function assertValidWorkspaceName(registry: Registry, name: string): void {
  if (RESERVED_WORKSPACE_NAMES.has(name) || !WORKSPACE_NAME_PATTERN.test(name)) {
    throw new InvalidWorkspaceNameError(
      name,
      "must contain only letters, digits, '-', '_', '.' and not be '.' or '..'",
    );
  }
  if (Object.hasOwn(registry.workspaces, name)) {
    throw new InvalidWorkspaceNameError(name, "a workspace with this name already exists");
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

export function loadRegistry(dir: string): Registry {
  const agents: Record<string, AgentDefinition> = {};
  for (const file of readdirSync(join(dir, "agents"))) {
    if (!file.endsWith(".md")) continue;
    const agent = parseAgentFile(join(dir, "agents", file));
    agents[agent.name] = agent;
  }
  const authority: Record<string, AuthorityProfile> = {};
  for (const file of readdirSync(join(dir, "authority"))) {
    if (!file.endsWith(".yaml")) continue;
    const profile = parseAuthorityFile(join(dir, "authority", file));
    authority[profile.name] = profile;
  }
  const workspaces = workspacesSchema.parse(
    parseYaml(readFileSync(join(dir, "workspaces.yaml"), "utf8")),
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
  return { commit, agents, authority, workspaces };
}
