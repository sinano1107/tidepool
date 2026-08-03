import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Task } from "./tasks.js";

/** The CLI's own settings shape for a worker session (vendor shape, hence
 *  confined to this adapter-side module — ADR 0005). Key names and their
 *  semantics were read off the installed CLI (2.1.220) and confirmed by running
 *  it, not from memory.
 *
 *  Not `SandboxSettings`: ADR 0037 added two members that live *outside* the
 *  `sandbox` block, because the escapes they close are outside the sandbox too —
 *  a hook runs in the harness, not in the confined Bash. The artifact the board
 *  writes is still called the sandbox settings file (`<task>.sandbox.json`), so
 *  `buildSandboxSettings` keeps its name — ADRs 0033/0035/0037 and several
 *  issues cite it, and a rename would quietly break those references. */
export interface WorkerSessionSettings {
  /** ADR 0037: hooks declared by the workspace's own `.claude/settings.json`
   *  run harness-side — outside the very sandbox this file builds — so a `work`
   *  session that can write its checkout can execute arbitrary commands off the
   *  floor. Measured (2.1.220 / Pi 2.1.207): this stops project hooks firing, a
   *  workspace's own `disableAllHooks: false` does not cancel it (the flag tier
   *  wins), and a hook hot-loaded *mid-session* is stopped too — which is what
   *  makes it reach the one-session escalation a spawn-time check cannot.
   *  The workspace's skills (`@workspace` scope) and CLAUDE.md survive, which
   *  `--setting-sources user` would have taken down with it (ADR 0025). */
  disableAllHooks: true;
  /** ADR 0037's second layer, and the one the sandbox cannot provide: the
   *  sandbox confines Bash alone, so the Write/Edit tools reach
   *  `.claude/settings.json` straight through `filesystem.denyWrite`
   *  (measured — it was written). See `SETTINGS_TOOL_DENY`. */
  permissions: { deny: string[] };
  sandbox: {
    enabled: true;
    /** ADR 0033: the vendor's fail-open hatch — a command that fails inside the
     *  sandbox is otherwise re-run bare. Closing it is what makes the OS wall
     *  the floor rather than a suggestion. */
    allowUnsandboxedCommands: false;
    /** The *other* fail-open hatch, and a different code path from the one
     *  above: `allowUnsandboxedCommands` governs re-running a command that
     *  failed inside the sandbox, this governs a sandbox that never started at
     *  all. The vendor default is false — "a warning is shown and commands run
     *  unsandboxed", which is precisely the state ADR 0033 refuses
     *  (「サンドボックスされているつもりで裸」は機構不在より悪い). With it true
     *  the session exits at startup instead, and the board sees a failed spawn. */
    failIfUnavailable: true;
    /** ADR 0035: the CLI treats a sandboxed Bash command as pre-approved
     *  (`autoAllowBashIfSandboxed`, vendor default true) — the OS is the guard,
     *  so the permission layer steps aside. That is fine while a session runs
     *  in `auto`, which self-approves anyway, but review's write floor *is* the
     *  permission layer (`--permission-mode manual`), and the sandbox's own
     *  write allowance covers the whole workspace. Left at the default, turning
     *  review to `manual` would buy nothing: measured on both macOS 2.1.220 and
     *  the Pi's 2.1.207, `echo x > f` succeeds with the sandbox on and is
     *  refused with this false. Present on review only — a work session must be
     *  able to write, and under `manual`-less `auto` this flag would only make
     *  its writes wait for an approval nobody is there to give. */
    autoAllowBashIfSandboxed?: false;
    filesystem: {
      denyRead: string[];
      allowRead: string[];
      allowWrite: string[];
      /** ADR 0037. **File-level entries only** — see `settingsDenyWrite`. */
      denyWrite: string[];
    };
    /** ADR 0033's #146 addendum. The vendor's network defaults refuse a
     *  *listen* on loopback — ADR 0033's original 「ネットワークは現状のまま開放」
     *  was measured false for bind (macOS 2.1.220). Without this key
     *  `app.listen(0, "127.0.0.1")` is refused and `listener.address()` returns
     *  null: 93 of tidepool's own test files — every one that boots the server
     *  in-process — died that way under the review profile, and the same
     *  signature reproduced under work, so it is a worker-wide fact and not a
     *  review-specific one. Both profiles therefore carry it, which is also
     *  what ADR 0034 already holds: a worker standing up its own loopback
     *  server and calling it is legitimate work (npm test / webui-e2e).
     *  This key is an allowance to *bind*, not an allowance to reach a
     *  destination — whether a worker's Bash can reach the human-facing `/api`
     *  is untouched here and stays #140 / ADR 0034's question. */
    network: {
      allowLocalBinding: true;
      /** The proxy filters on the `CONNECT` host string, not the address it
       *  resolves to — so a name pattern here does not reach traffic to an
       *  IP literal or to a name that merely *resolves into* a denied range.
       *  See `DENIED_TAILNET_DOMAINS` for what tidepool puts in this key and
       *  why. */
      deniedDomains: string[];
    };
  };
}

/** ADR 0033: the containment target is "the AI's tool-execution sight and
 *  writes", not the toolchain's operating base. `git` will not run at all
 *  without its global config (confirmed: `fatal: unable to access
 *  '~/.gitconfig': Operation not permitted` under a bare `denyRead: ["~/"]`),
 *  so these two paths are re-allowed for reading. Deliberately read-only and
 *  deliberately two entries: config, never credentials — the board's GitHub
 *  identity is injected per call and never rides the worker (ADR 0024).
 *
 *  Deliberately *not* here: `~/.npm`. The CLI binds it into the masked home on
 *  its own (verified on the Pi — `ls -a $HOME` inside a sandboxed session shows
 *  `.claude`, `.gitconfig`, `.npm`), so naming it would add exposure and buy
 *  nothing. */
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

/** ADR 0036: floor entry, not the primary mechanism (that's the human-surface
 *  credential) — but independently justified by #150, where an
 *  unauthenticated context-vault sits on the same Pi's tailnet. tidepool's
 *  side of the auth story doesn't close that hole; this deny does.
 *
 *  Name patterns, not CIDR: `deniedDomains: ["100.64.0.0/10"]` does not block
 *  a request to a name that resolves into that range (measured 2026-07-29),
 *  so ADR 0034's "deny the whole CGNAT range" is only expressible as a name
 *  pattern — `*.ts.net` here.
 *
 *  `*.ts.net` alone also measured false (2026-07-29, issue #152): MagicDNS's
 *  bare short name (`raspberrypi`, no `.ts.net` suffix) reached the proxy's
 *  `CONNECT` step and got tunneled through (`200 Connection Established`)
 *  while the fully-qualified name got `403 blocked-by-allowlist`. There's no
 *  shared suffix across short names to pattern-match on, so the known one is
 *  enumerated — same posture as `TOOLCHAIN_READ`. */
const DENIED_TAILNET_DOMAINS = ["*.ts.net", "raspberrypi"];

/** The workspace-side settings files the CLI merges into a session's settings.
 *  Both live inside the checkout, so a `work` session can write them — which is
 *  what ADR 0037 closes and what `floorOverridingSettings` guards behind it. One
 *  list, because the two are the same fact about the CLI's merge order. */
const PROJECT_SETTINGS_FILES = ["settings.json", "settings.local.json"];

/** ADR 0037's OS-layer half: the sandbox confines Bash, so this is what stops a
 *  `work` session redirecting into its own settings and re-defining the floor
 *  for the *next* Bash call (project settings hot-reload mid-session — the
 *  escalation `floorOverridingSettings`, a spawn-time check, cannot reach).
 *
 *  **File-level entries, never the `.claude` directory.** Measured on the
 *  production Pi (2.1.207): `denyWrite: [<ws>/.claude]` leaves bwrap unable to
 *  create its own mount points underneath (`bwrap: Can't create file at
 *  .../.claude/commands: Read-only file system`) and the sandbox never starts —
 *  the same backend constraint that ruled out `denyWrite: [workspace]` for
 *  review's write floor above. Naming the two files instead starts cleanly on
 *  both backends and still closes the `rm -rf .claude` → symlink escape: bwrap
 *  binds a stub over each denied path, which makes the parent undeletable
 *  whether or not the file exists, and Seatbelt refuses an `rm -rf` of a parent
 *  containing a protected file. */
function settingsDenyWrite(workspacePath: string): string[] {
  return PROJECT_SETTINGS_FILES.map((name) => `${workspacePath}/.claude/${name}`);
}

/** ADR 0037's tool-layer half. `settingsDenyWrite` above only reaches Bash — the
 *  sandbox governs nothing else — and a `work` session's Write tool went
 *  straight through it to `.claude/settings.json` (measured, 2.1.220). This is
 *  the deterministic refusal for that path; `auto`'s classifier is a model
 *  judgment and was talked past by an ordinary-sounding request.
 *
 *  **Workspace-relative on purpose**, unlike the absolute paths above: deny is
 *  matched against the tool call's literal `file_path` argument, so a worker
 *  that symlinks `.claude` away still submits `.claude/settings.json` and is
 *  still refused. Same reason the list is one code constant for every workspace.
 *
 *  **One spelling, `Edit(path)`, and it is not a choice.** There is no
 *  per-tool enumeration to be exhaustive about: `Edit(path)` is the sole entry
 *  point to the CLI's file-permission check and covers every file-editing tool,
 *  `Write(path)` is never consulted, and `MultiEdit` is not a tool at all. 2.1.220
 *  says both by name at startup ("is not matched by file permission checks —
 *  only Edit(path) rules are", "matches no known tool"). Measured 2026-08-03
 *  with an identical neutral payload: `Edit`-only refused the **Write** tool
 *  deterministically (`File is in a directory that is denied by your permission
 *  settings.`, new file not created); `Write`+`MultiEdit` with no `Edit` left
 *  the deny layer silent and only the `auto` classifier objected — a model
 *  judgment, which ADR 0033 refuses to call a floor; an empty deny wrote both
 *  files. Adding the inert spellings back would buy nothing and print six
 *  warnings into every worker session's log, four of which instruct the reader
 *  to undo them.
 *
 *  Because that coverage is the vendor's claim rather than a rule tidepool can
 *  enumerate, and the CLI warns about a rule that matches nothing but never
 *  about coverage that has quietly narrowed, `hook-canary.sh` re-measures the
 *  refusal on every deploy. That canary is this constant's real guard.
 *
 *  What keeps the list short in the first place is that a worker cannot write
 *  these files at all, which shuts the whole family of harness-side keys
 *  (`hooks`, `env`, `apiKeyHelper`, `statusLine`, …) at the root rather than one
 *  key at a time — **for the workspace's own two files, which is the whole of
 *  what this closes.** The entries name paths, so the *user* tier
 *  (`~/.claude/settings.json`) is untouched and out of ADR 0037's scope; that
 *  belongs to #151, where the `work` profile's tool layer has no sandbox floor
 *  at all. Anyone reaching for it would take the shorter road anyway — under
 *  #151 the Read tool reaches `~/.claude/.credentials.json` directly, without
 *  widening any floor first. */
const SETTINGS_TOOL_DENY = PROJECT_SETTINGS_FILES.map((name) => `Edit(.claude/${name})`);

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

export interface WorkerSessionSettingsInput {
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
 *  **The read half is the floor this change actually delivers**, on both
 *  platforms and for both profiles: `allowRead` takes precedence over
 *  `denyRead` (confirmed by running the CLI), so "deny the home tree, re-allow
 *  the workspace" expresses it directly and a workspace-external read becomes
 *  an OS refusal — ADR 0033 line 11's whole point.
 *
 *  **The write half deliberately does not use `denyWrite` to build a floor —
 *  only to punch two holes in one.** ADR 0037 added `denyWrite` for the two
 *  settings files (`settingsDenyWrite`); everything below is about the shape
 *  that was rejected, `denyWrite` covering the *workspace*, and it stays
 *  rejected. Both facts come from the same backend constraint, which is why
 *  ADR 0037's entries have to be file-level: name the `.claude` directory and
 *  bwrap fails to start for exactly the reason in point 2. Two measurements,
 *  in order:
 *
 *  1. `allowWrite` does *not* take precedence over `denyWrite` (macOS 2.1.220),
 *     so the natural "deny `~/`, re-allow the workspace" shape leaves the
 *     workspace unwritable. It isn't needed anyway — the sandbox's own default
 *     already confines writes to the session cwd, refusing `/tmp` and the rest
 *     of the home tree without tidepool naming anything.
 *  2. `denyWrite: [workspace]` — the shape that *would* have made a review
 *     session read-only at the OS layer — cannot work on the Linux (bwrap)
 *     backend at all (confirmed on the production Pi, 2.1.207). bwrap has to
 *     create mount points inside the project for the CLI's own project-relative
 *     protected paths (`.gitconfig`, `.git/config.lock`, …), which a read-only
 *     workspace makes impossible: the sandbox never starts and *every* command
 *     in the session dies with `bwrap: Can't create file at
 *     <workspace>/.gitconfig: Read-only file system`. That is the backend's
 *     architecture, not a version bug.
 *
 *  So review carries `allowWrite: []` and no workspace-wide `denyWrite`. A
 *  macOS-only `denyWrite` was rejected on ADR 0033 line 22's dev/prod parity:
 *  production must never be the weaker side, and a rule that runs only on the
 *  dev machine is exactly that.
 *
 *  **Where review's write floor actually lives (ADR 0035 / issue #144), and how
 *  the layers divide.** Not four independent walls — the first one steps aside
 *  for the second unless told not to:
 *
 *  1. This sandbox — read visibility, network, and the write *radius* of
 *     whatever the permission layer does allow (an `npm test` may run arbitrary
 *     code; its writes still can't leave the workspace).
 *  2. The permission layer (`--permission-mode manual`, claude-worker.ts) — the
 *     write floor proper: redirections, interpreters and wrappers, the shapes
 *     issue #59's enumeration could never reach. **Live only because
 *     `autoAllowBashIfSandboxed: false` above stops layer 1 from waving Bash
 *     past it.**
 *  3. `--disallowedTools` (ADR 0013 追記 / issue #59) — no longer "the floor by
 *     enumeration" (that failed); now the *ceiling* on what a registry's
 *     `review_allowed_commands` can open, since deny always beats allow.
 *  4. The slot-release tree rule — mechanical recovery of whatever residue
 *     remains.
 *
 *  The CLI's own default project protections still refuse `.git/config`,
 *  `.git/hooks` and friends underneath all of it. */
export function buildSandboxSettings(input: WorkerSessionSettingsInput): WorkerSessionSettings {
  const { taskType, workspacePath, permittedSkills } = input;
  const readOnly = taskType === "review";
  return {
    // ADR 0037: not keyed on the profile — a hook fires harness-side whichever
    // kind of worker is running, and the floor never depends on data (ADR 0013).
    disableAllHooks: true,
    // ADR 0037: the tool-layer half of the same ban, likewise on both profiles.
    permissions: { deny: [...SETTINGS_TOOL_DENY] },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      // ADR 0035: review's write floor is the permission layer, and the
      // sandbox would otherwise wave Bash past it entirely.
      ...(readOnly && { autoAllowBashIfSandboxed: false as const }),
      filesystem: {
        denyRead: ["~/"],
        allowRead: [
          workspacePath,
          ...TOOLCHAIN_READ,
          ...skillReadPaths(permittedSkills, workspacePath),
        ],
        allowWrite: readOnly ? [] : [workspacePath],
        // ADR 0037: on both profiles, and file-level for a reason — see
        // settingsDenyWrite. review cannot write anyway, but the floor does not
        // ask which profile is running (ADR 0013).
        denyWrite: settingsDenyWrite(workspacePath),
      },
      // ADR 0033 追記 / issue #146: not keyed on the profile — a worker of
      // either type has to be able to run the suite it is judging.
      // ADR 0036 / issue #152: same for the tailnet deny — floor, not the
      // primary mechanism, but independent of task type.
      network: { allowLocalBinding: true, deniedDomains: [...DENIED_TAILNET_DOMAINS] },
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

/** 封じ込め能力(CONTEXT.md)の**片方の半分**: is the harness sandbox actually
 *  usable on this host right now? もう半分(自分の人間面が無認証リクエストを
 *  拒むか — ADR 0036 / issue #154)は containment.ts が持ち、両者を束ねた1つの
 *  答えが pickup ゲートを引く。ここは fs 側だけを答える。
 *
 *  Never "is the dependency installed" — a bwrap blocked by
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
 *  reads as "not usable", the fail-closed side. Exported because the
 *  containment capability's other half (containment.ts) is bounded the same
 *  way — two halves of one gate, so one number rather than two that a comment
 *  claims are equal. */
export const CAPABILITY_PROBE_TIMEOUT_MS = 5_000;

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

/** The settings keys that define a worker session's floor rather than its
 *  conveniences — `sandbox` for the OS layer (ADR 0033), `permissions` for the
 *  permission layer review's write floor now rests on (ADR 0035). A checkout
 *  naming either is claiming authorship of the floor, which is the board's
 *  alone. */
const FLOOR_DEFINING_KEYS = ["sandbox", "permissions"];

/** The floor's one data-dependent guard, and deliberately a guard rather than
 *  part of the floor (ADR 0013:「床はデータの状態に依存しない」— the profile
 *  itself stays a code constant above).
 *
 *  Measured on 2.1.220: the CLI reads `sandbox` out of the *workspace's* own
 *  `.claude/settings.json` and merges it with the per-task `--settings` this
 *  module builds. `sandbox.enabled: false` loses to `--settings` (the flag tier
 *  wins), but `sandbox.filesystem.allowRead` **merges** — and since `allowRead`
 *  beats `denyRead`, a workspace can re-open anything it names. Neither
 *  `--setting-sources user` nor `--setting-sources ""` stops it.
 *
 *  A `work` session can write its own checkout, so left alone this is a
 *  two-session escalation: widen the floor in session N, walk out in N+1 (and
 *  the slot-release tree rule would helpfully commit the file). The board's
 *  answer is to refuse the spawn instead — a workspace that redefines the
 *  sandbox is a broken resource, quarantined like any other (the caller does
 *  that; this returns the offending file names).
 *
 *  `permissions` joins `sandbox` as a guarded key once review runs under
 *  `--permission-mode manual` (ADR 0035). Measured on 2.1.220: a
 *  `permissions.allow` entry in the checkout's `settings.local.json` lifts the
 *  manual write floor (`sh -c '… > f'` went through), while the same key in
 *  `settings.json` and `permissions.defaultMode` in either file do not. The
 *  guard covers both files and the whole `permissions` block regardless —
 *  which tier and which sub-key the CLI honours is vendor behaviour that can
 *  change under us, and this guard exists precisely so a change there is not a
 *  silent floor loss. Under `auto` this was harmless (the classifier
 *  self-approved anyway); under `manual` the permission layer *is* the floor,
 *  so the same two-session escalation applies.
 *
 *  Fail-closed on a file it cannot parse: the CLI's own reader may accept more
 *  than `JSON.parse` does, and "we couldn't tell" must not read as "clean". A
 *  settings file carrying neither key is left alone — hooks, env and the rest
 *  of a project's ordinary settings are none of this guard's business. */
export function floorOverridingSettings(workspacePath: string): string[] {
  const offending: string[] = [];
  for (const name of PROJECT_SETTINGS_FILES) {
    let raw: string;
    try {
      raw = readFileSync(join(workspacePath, ".claude", name), "utf8");
    } catch {
      continue; // absent (or unreadable directory) — nothing to merge
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        FLOOR_DEFINING_KEYS.some((key) => key in parsed)
      ) {
        offending.push(name);
      }
    } catch {
      offending.push(name);
    }
  }
  return offending;
}
