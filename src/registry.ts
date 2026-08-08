import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { parse as parseTwemoji } from "@twemoji/parser";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { authedGitBounded, type GitHubAuth } from "./github-auth.js";

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
  /** Advisor capability (issue #33 / CONTEXT.md の Advisor): the model this
   *  agent's worker sessions may consult at decision points. Absent → no
   *  advisor at all (機構としての既定は無効 — the adapter then spawns with the
   *  advisor tool explicitly disabled, ADR 0042). Sibling of `model`/`effort`
   *  and free string for the same reason: the valid set is open (aliases *and*
   *  full model ids) and, unlike either of those, an alias's meaning is
   *  **host-CLI-version dependent** — vendor knowledge that a registry schema
   *  cannot hold without going stale (ADR 0005 / ADR 0042). */
  advisor?: string;
  /** Visual identity emoji for this agent (issue #52), shown by the board
   *  UI's AgentChip. Absent → the UI falls back to hashed initials. Loader
   *  checks only structural validity — a single Twemoji-covered grapheme
   *  (ADR 0026) — never semantics ("prefer sea creatures" stays a registry
   *  README convention, unenforceable by schema). */
  icon?: string;
  /** Skill allowlist (issue #56 / ADR 0025): the skills this agent may use in
   *  a worker session — the implementation counterpart of the `skills` in
   *  CONTEXT.md's Worker definition (agent = base AI + skills + instructions +
   *  authority profile). Required — omission is a load error (省略=無制限 の
   *  footgun is refused, issue #41's line); unrestricted is the explicit sole
   *  `["*"]`, all-denied is the empty list. The loader validates only the
   *  grammar of the vocabulary (`assertValidSkillAllowlist`), never the
   *  inventory — an allowlist is a reference, not a claim of stock (ADR 0023):
   *  a plugin-name typo or a workspace-absent individual name is inert, since
   *  an agent crosses many workspaces. Enforcement (the complement deny) lives
   *  in the adapter (ADR 0005). */
  skills: string[];
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
  /** Host-independent command prefixes a review session may run despite the
   *  `--permission-mode manual` write floor (issue #144 / ADR 0035). Absent →
   *  empty. The board mechanically turns each into a `Bash(<prefix>*)` token
   *  for `--allowedTools` at spawn time (claude-worker.ts) — the registry
   *  carries the command, never the CLI's spelling, the same split as the
   *  skill allowlist's names-not-paths rule (ADR 0033).
   *
   *  This is the one registry field that *widens* a session's permissions, so
   *  its gate is the human merge a protected workspace requires (issue #15
   *  layer 2). `assertValidReviewAllowedCommands` guards the grammar so a
   *  spelling can't reach past what that human read. */
  review_allowed_commands: z.array(z.string()).optional(),
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

/** The skill allowlist's unrestricted spelling (issue #56 / ADR 0025): the
 *  sole `["*"]` means every resolved skill is allowed (no deny, no ping).
 *  A domain sibling of `AUTHORITY_WILDCARD` (tasks.ts) — the same glyph, a
 *  different axis (専門性 vs 権限), kept apart so the skill grammar owns its
 *  own vocabulary. */
export const SKILL_WILDCARD = "*";

/** The origin-scope words of the skill allowlist (issue #56 / ADR 0025): a
 *  closed `{@workspace, @host}` set, not a `名前:*` glob — `@workspace:*`
 *  would be grammatically indistinguishable from "a plugin literally named
 *  workspace", so scope typos would become undetectable. Any other `@`-prefixed
 *  entry is a typo and rejected. */
export const SKILL_SCOPES = new Set(["@workspace", "@host"]);

/** A `名前:*` plugin glob (ADR 0025): a non-empty plugin name with no `*`/`@`
 *  of its own, then a literal `:*`. Together with the bare `SKILL_WILDCARD`
 *  these are the only two shapes a `*` may appear in. */
const PLUGIN_GLOB_PATTERN = /^[^*@:]+:\*$/;

/** Is this allowlist entry a `名前:*` plugin glob? (issue #56 / ADR 0025) One
 *  definition of the glob shape, shared by the loader's grammar check here and
 *  the adapter's match (claude-worker.ts) so the two can't drift — the adapter
 *  only ever sees validated entries, so it strips the trailing `*` for prefix
 *  matching once this says yes. */
export function isPluginGlob(entry: string): boolean {
  return PLUGIN_GLOB_PATTERN.test(entry);
}

/** An agent's `skills` frontmatter breaks ADR 0025's allowlist grammar. The
 *  entrance-guard twin of InvalidAgentIconError (agent-create.ts): thrown by
 *  the loader and re-checked before a WebUI write so a malformed allowlist
 *  can't brick the next `loadRegistry`. */
export class InvalidSkillAllowlistError extends Error {
  constructor(public readonly entry: string, reason: string) {
    super(`invalid skill allowlist entry "${entry}": ${reason}`);
    this.name = "InvalidSkillAllowlistError";
  }
}

/** Grammar-only validation of a skill allowlist (issue #56 / ADR 0025) — never
 *  inventory: an allowlist is a reference, not a claim of stock (ADR 0023), so
 *  a plugin-name typo or a workspace-absent individual name is inert, checked
 *  only for shape. The vocabulary is five forms: the sole `"*"` (unrestricted,
 *  valid only alone), the `@workspace`/`@host` scope words, a `名前:*` plugin
 *  glob, and an exact individual name (`skill` or `plugin:skill`). A `*` may
 *  appear only as the bare wildcard or a glob suffix; a bare `[]` (all-denied)
 *  is valid. */
export function assertValidSkillAllowlist(skills: string[]): void {
  for (const entry of skills) {
    if (entry === SKILL_WILDCARD) {
      if (skills.length !== 1) {
        throw new InvalidSkillAllowlistError(entry, 'the "*" wildcard must be the only entry');
      }
      continue;
    }
    if (entry.startsWith("@")) {
      if (!SKILL_SCOPES.has(entry)) {
        throw new InvalidSkillAllowlistError(entry, "unknown scope (only @workspace / @host)");
      }
      continue;
    }
    if (entry.includes("*") && !isPluginGlob(entry)) {
      throw new InvalidSkillAllowlistError(entry, 'a "*" may appear only as "*" alone or a "名前:*" glob');
    }
    if (entry === "") {
      throw new InvalidSkillAllowlistError(entry, "empty skill name");
    }
  }
}

/** A workspace's `review_allowed_commands` breaks ADR 0035's grammar. Same
 *  entrance-guard role as InvalidSkillAllowlistError above. */
class InvalidReviewAllowedCommandError extends Error {
  constructor(public readonly entry: string, reason: string) {
    super(`invalid review_allowed_commands entry "${entry}": ${reason}`);
    this.name = "InvalidReviewAllowedCommandError";
  }
}

/** Grammar-only validation of `review_allowed_commands` (issue #144 / ADR
 *  0035) — never inventory, the same line as the skill allowlist above: a
 *  prefix naming a command this host does not have is inert, not an error.
 *
 *  What the grammar is actually for is narrower than "well-formed". This is
 *  the one registry field that *widens* a review session's permissions, and
 *  its only gate is a human reading the registry PR. Every rule below exists
 *  so that what the human read is what the CLI receives:
 *
 *  - **no comma** — `--allowedTools` is comma-joined (claude-worker.ts), so
 *    `"npm test,rm -rf /"` reads as one allowance in the diff and arrives as
 *    two at the CLI. The injection this closes is the whole reason the field
 *    is validated at all.
 *  - **no newline or control character** — same smuggling, one layer down: an
 *    entry that renders as one line in a diff must not carry a second.
 *  - **no `*`, `(`, `)`** — the registry carries a *command prefix*, not the
 *    CLI's pattern spelling; the board adds `Bash(…*)` itself. Letting an
 *    entry bring its own syntax would put the CLI's grammar into registry data
 *    (ADR 0033's names-not-paths rule, restated for commands).
 *  - **non-empty, no leading/trailing space** — an empty or space-padded entry
 *    becomes `Bash(*)` or `Bash( foo*)`: the first opens everything, the
 *    second silently matches nothing. Both are worse than a loud rejection. */
function assertValidReviewAllowedCommands(commands: string[]): void {
  for (const entry of commands) {
    if (entry === "") {
      throw new InvalidReviewAllowedCommandError(entry, "empty command prefix");
    }
    if (entry.includes(",")) {
      throw new InvalidReviewAllowedCommandError(
        entry,
        "a comma would inject an extra --allowedTools token past the registry review",
      );
    }
    if (/[\u0000-\u001f\u007f]/.test(entry)) {
      throw new InvalidReviewAllowedCommandError(entry, "control characters are not allowed");
    }
    if (/[*()]/.test(entry)) {
      throw new InvalidReviewAllowedCommandError(
        entry,
        'the CLI pattern spelling is the board\'s to add — write the command prefix alone (e.g. "npm test")',
      );
    }
    if (entry !== entry.trim()) {
      throw new InvalidReviewAllowedCommandError(entry, "leading or trailing whitespace");
    }
  }
}

const agentFrontmatterSchema = z.looseObject({
  version: z.coerce.string(),
  authority: z.string(),
  description: z.string(),
  model: z.string().optional(),
  effort: z.string().optional(),
  advisor: z.string().optional(),
  icon: z
    .string()
    .refine(isSingleTwemojiGrapheme, {
      message: "icon must be a single Twemoji-covered emoji grapheme",
    })
    .optional(),
  skills: z.array(z.string()),
});

/** ADR 0020: the branch the board reads the registry from is a code constant,
 *  not registry data. "Which branch do we trust to read from" is part of the
 *  protected-workspace floor (same shape as ADR 0013's reviewer floor); putting
 *  it in the data it guards (workspaces.yaml's branch field, issue #27) would be
 *  self-referential and break bootstrap. The working tree is never read — branch
 *  discipline moves the checkout's HEAD onto a registry-edit task branch, so a
 *  working-tree read would let unmerged content take effect on spawn. */
export const REGISTRY_BRANCH = "main";

/** ADR 0052 決定3: この盤面の registry が remote 正本を持つか。**宣言であって
 *  推測ではない** — clone を覗いて切り替えると、remote が失われた瞬間に ADR 0052
 *  が直した壊れ方(merge が spawn に効かない)へ静かに戻る。既定値を持たせない
 *  のも同じ理由で、`loadRegistry` の引数を必須にしてある。 */
export type RegistryMode = "remote-backed" | "purely-local";

export interface RegistryReachability {
  available: boolean;
  reason?: string;
}
export type RegistryReachabilityCheck = () => Promise<RegistryReachability>;

/** この盤面で唯一ネットワークへ出る git 呼び出しの上限。`execFileSync` は同期
 *  なので、black-hole した接続を無制限に待つと event loop ごと止まり、ADR 0036
 *  が復旧経路と定めた人間面まで応答しなくなる —— fail-closed より悪い状態
 *  (containment.ts)。timeout は「到達不能」= fail-closed 側に読む。
 *
 *  他の probe(`CAPABILITY_PROBE_TIMEOUT_MS` = 5秒)より桁が大きいのは、あれが
 *  ローカルのバイナリを叩くのに対しこちらは実ネットワーク往復だからで、同じ数を
 *  共有すると正常な fetch を落とす。 */
export const REGISTRY_FETCH_TIMEOUT_MS = 30_000;

// stderr piped (not inherited), same as workspace.ts's `git()`: git narrates a
// missing ref on stderr, and the board's console is not the place for it — the
// message still rides the thrown error for callers that want it (agentBodyAtCommit
// swallows it by design).
const GIT_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/** 盤面が registry の remote-tracking ref を更新する**唯一の関数**(ADR 0052 決定2)。
 *  `execFileSync` なので同期である —— 起動時の refresh は `buildServerOptions` が
 *  自分で registry を読むより前に撃たなければ意味がなく、そこは同期の文脈だから。
 *  非同期の面が要る口(`RegistryReachabilityCheck` は `ContainmentCheck` と型を
 *  揃えてある)は呼び出し側が `async () => refreshRegistry(...)` で包む —— 1回の
 *  fetch に輸出名を2つ与えると、ADR と CONTEXT.md が「refresh」1語で呼ぶものの
 *  語彙が割れる。
 *
 *  **machine user 名義で撃つ**(ADR 0024 / CONTEXT.md の GitHub identity:
 *  「盤面が執行する操作は読み取り・書き込み・merge を問わずすべてこの名義」)。
 *  registry は private なので認証が要り、しかも `authedGit` の credential 引数は
 *  ホストに設定済みの helper を**先にクリアする** —— つまりこの1行は「認証を足す」
 *  だけでなく「人間の `gh` ログインに寄りかからない」ことを同時に成立させる。
 *  ホストに人間の helper が居ると認証なしでも fetch が通ってしまうため、実機で
 *  成功したことはこの条件の証拠にならない(issue #209 の実測)。
 *
 *  `auth` 不在は「盤面が GitHub 身元を持たない」の宣言であり、push(`pushRegistry`)
 *  と同じく bare な git に委ねる。private な remote ならそこで失敗し、レジストリ
 *  到達性の quarantine が人間を呼ぶ。
 *
 *  Failure is returned as data so the caller can quarantine or warn instead of
 *  throwing. */
export function refreshRegistry(
  dir: string,
  auth: GitHubAuth | undefined,
): RegistryReachability {
  try {
    authedGitBounded(
      auth,
      dir,
      REGISTRY_FETCH_TIMEOUT_MS,
      "fetch",
      "--quiet",
      "origin",
      REGISTRY_BRANCH,
    );
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: `the registry remote main could not be refreshed (${String(err)})`,
    };
  }
}

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
  // grammar-only (ADR 0025): the schema guarantees `skills` is a string array;
  // this rejects malformed vocabulary before the definition is trusted.
  assertValidSkillAllowlist(meta.skills);
  return {
    name,
    version: meta.version,
    authority: meta.authority,
    description: meta.description,
    model: meta.model,
    effort: meta.effort,
    advisor: meta.advisor,
    icon: meta.icon,
    skills: meta.skills,
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

/** Grammar check across a parsed workspaces.yaml (ADR 0035). Runs at load, the
 *  same moment `parseAgentFile` checks a skill allowlist: a malformed widening
 *  must fail the registry read loudly, never reach a spawn quietly. */
function assertValidWorkspaces(workspaces: z.infer<typeof workspacesSchema>): void {
  for (const entry of Object.values(workspaces)) {
    assertValidReviewAllowedCommands(entry.review_allowed_commands ?? []);
  }
}

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

/** Load the registry from its declared committed source (ADR 0020 / ADR 0052)
 *  — remote-tracking main for a remote-backed board, local main for a
 *  purely-local board, and never the working tree. Every content read and the
 *  provenance `commit` use the same ref, so they agree by construction.
 *
 *  `mode` に既定値を置かない。既定があると、渡し忘れた呼び出しが**静かに**
 *  ローカル main へ落ちる —— remote 正本を宣言した盤面でも spawn の入力だけが
 *  古いまま、どこも赤くならない。ADR 0052 決定3 が推測を却下した理由と同じ形の
 *  フォールバックなので、必須にして tsc に全呼び出しを名指しさせる
 *  (containment.ts の「省略 = 無制限という footgun は作らない」と同じ線)。 */
export function loadRegistry(dir: string, mode: RegistryMode): Registry {
  const ref =
    mode === "remote-backed" ? `refs/remotes/origin/${REGISTRY_BRANCH}` : REGISTRY_BRANCH;
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
  assertValidWorkspaces(workspaces);
  const commit = execFileSync("git", ["rev-parse", ref], { cwd: dir, stdio: GIT_STDIO })
    .toString()
    .trim();
  return { commit, agents, authority, workspaces };
}
