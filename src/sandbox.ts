import type { Task } from "./tasks.js";

/** The CLI's own `sandbox` settings block (vendor shape, hence confined to this
 *  adapter-side module — ADR 0005). Key names and their semantics were read off
 *  the installed CLI (2.1.220) and confirmed by running it, not from memory. */
export interface SandboxSettings {
  sandbox: {
    enabled: true;
    /** ADR 0033: the vendor's fail-open hatch — a command that fails inside the
     *  sandbox is otherwise re-run bare. Closing it is what makes the OS wall
     *  the floor rather than a suggestion. */
    allowUnsandboxedCommands: false;
    filesystem: {
      denyRead: string[];
      allowRead: string[];
      denyWrite?: string[];
      allowWrite: string[];
    };
  };
}

/** ADR 0033: the containment target is "the AI's tool-execution sight and
 *  writes", not the toolchain's operating base. `git` will not run at all
 *  without its global config (confirmed: `fatal: unable to access
 *  '~/.gitconfig': Operation not permitted` under a bare `denyRead: ["~/"]`),
 *  so these two paths are re-allowed for reading. Deliberately read-only and
 *  deliberately two entries: config, never credentials — the board's GitHub
 *  identity is injected per call and never rides the worker (ADR 0024). */
const TOOLCHAIN_READ = ["~/.gitconfig", "~/.config/git"];

/** The skill roots a permitted skill name is mapped into. ADR 0033's invariant
 *  lives here, in code: an allowlist carries skill *names*, never paths, so the
 *  name → path mapping and its "under a skill root, always" confinement are the
 *  board's, not the registry's. `~` is expanded by the CLI itself. */
const USER_SKILL_ROOT = "~/.claude/skills";
const WORKSPACE_SKILL_SUBDIR = ".claude/skills";
/** The wildcard case's plugin allowance: with `skills: ["*"]` nothing is
 *  denied, so opening the plugin cache wholesale bypasses no allowlist. A
 *  finite allowlist never gets this — see `skillReadPaths`. */
const PLUGIN_ROOT = "~/.claude/plugins";

/** A skill name safe to map into a path: no separator, no `..`, no leading dot.
 *  Plugin-prefixed names (`plugin:skill`) are excluded by the same rule — their
 *  directory lives under a version-stamped plugin cache path the board cannot
 *  derive from the name alone, so a finite allowlist re-allows nothing for
 *  them. Under-permission, never over: a plugin skill's body still rides the
 *  system prompt (ADR 0033 fact 3); only its auxiliary files stay unreadable. */
const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One root + one name → the path, or nothing. Belt and braces over
 *  `SAFE_SKILL_NAME`: the joined path must still start with the root, so no
 *  spelling of a name can climb out of the skill root. Kept string-only (no
 *  `node:path`) because roots may be `~`-relative — the CLI expands those. */
function underRoot(root: string, name: string): string | undefined {
  if (!SAFE_SKILL_NAME.test(name)) return undefined;
  const path = `${root}/${name}`;
  return path.startsWith(`${root}/`) ? path : undefined;
}

/** The `allowRead` skill share (ADR 0033): the directories of exactly the
 *  skills the agent's allowlist permits — never the skill root wholesale, which
 *  would let a denied skill's body be `cat`-ed and hand-replayed, routing around
 *  "an allowlist decides whether the door is open" (issue #132).
 *
 *  `"all"` (the `["*"]` agent) is the one case that does open the roots: with
 *  nothing denied there is no allowlist to route around. An empty list (the
 *  `--disable-slash-commands` shape) opens nothing. */
export function skillReadPaths(
  permittedSkills: string[] | "all",
  workspacePath: string,
): string[] {
  const workspaceRoot = `${workspacePath}/${WORKSPACE_SKILL_SUBDIR}`;
  if (permittedSkills === "all") return [workspaceRoot, USER_SKILL_ROOT, PLUGIN_ROOT];
  const paths: string[] = [];
  for (const name of permittedSkills) {
    for (const root of [workspaceRoot, USER_SKILL_ROOT]) {
      const path = underRoot(root, name);
      if (path !== undefined) paths.push(path);
    }
  }
  return paths;
}

export interface SandboxSettingsInput {
  /** ADR 0013: read-only is a property of the `review` task type, not of the
   *  agent executing it — so the write half is keyed on this alone. */
  taskType: Task["type"];
  workspacePath: string;
  /** ADR 0025's allowlist resolved against the CLI's own enumeration: the skill
   *  names this session may actually use, or `"all"` for the unrestricted
   *  (`["*"]`) agent. */
  permittedSkills: string[] | "all";
}

/** ADR 0033's two profiles as one code constant (ADR 0013: the floor lives in
 *  code, never in registry data).
 *
 *  The asymmetry between the read and write halves is the CLI's, confirmed by
 *  running it (2.1.220): `allowRead` takes precedence over `denyRead`, so
 *  "deny the home tree, re-allow the workspace" expresses the read floor
 *  directly. `allowWrite` does **not** take precedence over `denyWrite` — a
 *  `denyWrite: ["~/"]` + `allowWrite: [workspace]` pair leaves the workspace
 *  unwritable, so the write halves are built the other way around:
 *
 *  - work: no `denyWrite` at all. The sandbox's own default already confines
 *    writes to the session's cwd — `/tmp` and the rest of the home tree are
 *    refused without tidepool naming them.
 *  - review: `denyWrite: [workspace]` on top of that default, which is what
 *    actually makes the session read-only. (ADR 0033 originally recorded this
 *    as `allowWrite: []`; that shape does not deny workspace writes — the
 *    ADR's mechanism sentence was corrected to match the measurement.) */
export function buildSandboxSettings(input: SandboxSettingsInput): SandboxSettings {
  const { taskType, workspacePath, permittedSkills } = input;
  const readOnly = taskType === "review";
  return {
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      filesystem: {
        denyRead: ["~/"],
        allowRead: [workspacePath, ...TOOLCHAIN_READ, ...skillReadPaths(permittedSkills, workspacePath)],
        ...(readOnly ? { denyWrite: [workspacePath] } : {}),
        allowWrite: readOnly ? [] : [workspacePath],
      },
    },
  };
}
