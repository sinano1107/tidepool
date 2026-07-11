import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** An agent definition file: `agents/<name>.md` in the registry clone.
 *  Frontmatter carries the machine-stamped version and the authority profile
 *  reference; the markdown body is the agent's system prompt. */
export interface AgentDefinition {
  name: string;
  version: string;
  authority: string;
  /** Base-AI model for this agent (CONTEXT.md: agent = base AI + skills +
   *  instructions + authority profile). Absent → the adapter's default. */
  model?: string;
  /** Reasoning effort for this agent's sessions. Absent → the adapter's
   *  default. Free string here — the closed set of valid values (if any)
   *  is vendor knowledge that belongs to the adapter, not this registry
   *  (ADR 0005). */
  effort?: string;
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
  path: z.string(),
  repo: z.string().optional(),
  notes: z.string().optional(),
  /** Protected workspace (issue #15 layer 2 / ADR 0013): a decompose child
   *  targeting this workspace converts to an approval question unconditionally,
   *  regardless of the registering worker's authority profile. v1's only use is
   *  the registry itself — "changes to it always need human approval" is a
   *  resource-side invariant, independent of any profile's allowed_workspaces. */
  protected: z.boolean().optional(),
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

/** Assignee/workspace name candidates for the registration screen (issue
 *  #12), resolved from the registry by the caller (main.ts) — the API/server
 *  layers never touch the filesystem/git registry loader themselves. */
export interface RegistryCandidates {
  assignees: string[];
  workspaces: string[];
}

const agentFrontmatterSchema = z.looseObject({
  version: z.coerce.string(),
  authority: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
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
    model: meta.model,
    effort: meta.effort,
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
