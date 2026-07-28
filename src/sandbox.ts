import { spawnSync } from "node:child_process";
import type { Db } from "./db.js";
import { BOARD_WORKER_ID, registerTask, type Task } from "./tasks.js";

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
 *  `--disable-slash-commands` shape) opens nothing.
 *
 *  Honest scope note: `allowRead` is recursive and always contains the
 *  workspace itself, so a *workspace* skill's directory is readable whatever
 *  this returns — the per-skill confinement is only enforceable over the host
 *  half (`~/.claude/skills`, `~/.claude/plugins`), which is also the half ADR
 *  0033 was written about (a workspace's own files are inside the containment
 *  boundary by definition). The workspace entries are kept because the mapping
 *  is one rule, not two, and a future workspace layout outside the session cwd
 *  would need them — but they buy no permission today. */
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

/** The one process boundary the capability check runs at: did this command
 *  exit 0? Injected so the check's platform logic is tested without a real
 *  bwrap (same fake-injection posture as SpawnFn/PtyFn — ADR 0027). */
export type RunOkFn = (command: string, args: string[]) => boolean;

export type SandboxCapability = { available: true } | { available: false; reason: string };

/** macOS: the Seatbelt profile a no-op run needs. `(allow default)` grants
 *  everything — this asks "can a sandbox be entered at all", not "does this
 *  profile confine", which is the workers' own settings' job. */
const SEATBELT_PROBE = ["-p", "(version 1)(allow default)", "/usr/bin/true"];
/** Linux: a minimal bwrap that still exercises the parts that actually break —
 *  an unprivileged user namespace and a bind mount. bwrap being *installed* is
 *  not the question (ADR 0033 調査時の既知問題: AppArmor / userns 無効化で入って
 *  いても動かない), so the probe runs it. */
const BWRAP_PROBE = ["--ro-bind", "/", "/", "--dev", "/dev", "--", "/bin/true"];
/** socat has no no-op subcommand; `-V` prints its version and exits 0. The
 *  sandbox's network proxy is spawned through it, so its absence is fatal. */
const SOCAT_PROBE = ["-V"];

/** ADR 0033's fail-closed gate: is the harness sandbox actually usable on this
 *  host right now? Never "is the dependency installed" — a bwrap blocked by
 *  AppArmor or a kernel with user namespaces disabled is installed and useless,
 *  and that is the failure this check exists for. An unsupported platform
 *  reports unavailable rather than being probed: "sandboxed as far as we know"
 *  is the one state ADR 0033 refuses. */
export function checkSandboxCapability(
  platform: NodeJS.Platform,
  runOk: RunOkFn = defaultRunOk,
): SandboxCapability {
  if (platform === "darwin") {
    return runOk("/usr/bin/sandbox-exec", SEATBELT_PROBE)
      ? { available: true }
      : {
          available: false,
          reason:
            "the macOS Seatbelt sandbox could not be entered: /usr/bin/sandbox-exec failed to run",
        };
  }
  if (platform === "linux") {
    if (!runOk("bwrap", BWRAP_PROBE)) {
      return {
        available: false,
        reason:
          "bubblewrap (bwrap) could not create a sandbox — install it (apt install bubblewrap), " +
          "or check that unprivileged user namespaces and AppArmor allow it on this host",
      };
    }
    if (!runOk("socat", SOCAT_PROBE)) {
      return {
        available: false,
        reason: "socat is missing — the Linux sandbox's network proxy cannot start (apt install socat)",
      };
    }
    return { available: true };
  }
  return {
    available: false,
    reason: `worker sandboxing is not supported on platform "${platform}"`,
  };
}

/** Bounded like every other probe in this codebase (SKILL_ENUM_TIMEOUT_MS,
 *  USAGE_TIMEOUT_MS): a wedged binary must not stall a pickup poll. A timeout
 *  reads as "not usable", the fail-closed side. */
const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;

const defaultRunOk: RunOkFn = (command, args) => {
  try {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      timeout: CAPABILITY_PROBE_TIMEOUT_MS,
    });
    return result.error === undefined && result.status === 0;
  } catch {
    // a spawn that throws outright (ENOENT on some platforms) is the same
    // answer as a non-zero exit
    return false;
  }
};

/** ADR 0033's fail-closed stop, the host-wide sibling of quarantineWorkspace /
 *  quarantineAgent: an unusable sandbox halts pickup for the whole board (the
 *  sandbox is a property of the host, so there is no narrower resource to halt)
 *  and stands a Tidepool-registered Confirmation question saying why. One
 *  question at a time — a board that cannot sandbox produces the same fact
 *  every poll, and re-registering it hourly would bury the log. */
export function quarantineSandbox(db: Db, reason: string, now: Date): void {
  const title = "worker sandbox is unusable — pickup is stopped";
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose:
        `${reason}. ` +
        "No agent task is picked up while this stands: a worker that believes it is " +
        "sandboxed but is not is worse than no sandbox at all, so the board refuses to " +
        "run one bare (ADR 0033). Repair the host, then answer — the board re-runs the " +
        "capability check before it accepts the answer, and any answer text is kept as " +
        "a repair note.",
      completion_criteria: "the host's worker sandbox is repaired by hand",
      question: [{ title, options: ["repaired by hand"], recommendation: "repaired by hand" }],
      quarantine_sandbox: true,
    },
    now,
    BOARD_WORKER_ID,
  );
}

/** The open sandbox Confirmation question, if one stands. Its presence is half
 *  the gate: like a workspace quarantine, a repaired host does not resume
 *  pickup on its own — a human's confirmation is the only door out, so a
 *  transient breakage can never quietly un-halt the board with nobody having
 *  looked. */
export function openSandboxQuestion(db: Db): { id: string } | undefined {
  return db
    .prepare(
      `SELECT id FROM tasks WHERE question_quarantine_sandbox IS NOT NULL AND status = 'todo'`,
    )
    .get() as { id: string } | undefined;
}

/** The pickup gate (ADR 0033): true while no worker may be spawned. Registers
 *  the Confirmation question as a side effect the first time the check fails —
 *  and only then, since a standing question short-circuits ahead of it. */
export function sandboxPickupBlocked(
  db: Db,
  capability: () => SandboxCapability,
  now: Date,
): boolean {
  if (openSandboxQuestion(db)) return true;
  const result = capability();
  if (result.available) return false;
  quarantineSandbox(db, result.reason, now);
  return true;
}
