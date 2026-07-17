import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { resolveAgentOrQuarantine, resolveExecutionAgent } from "./agent.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload } from "./events.js";
import {
  loadRegistry,
  ownEntry,
  type AgentDefinition,
  type Registry,
  type RosterAgent,
} from "./registry.js";
import { AUTHORITY_WILDCARD, DEFAULT_AUDITOR_NAME, HUMAN_ROSTER_AGENT, type Task } from "./tasks.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import {
  resolveExecutionWorkspace,
  resolveOrQuarantine,
  resolveWorkspacesBaseDir,
} from "./workspace.js";

/** The process boundary the adapter is tested at: everything vendor-specific
 *  (the claude CLI, its flags) flows through this one call. */
export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string },
) => {
  stdout: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): void;
  /** issue #32: the adapter's own exit observation point (promoted out of
   *  defaultSpawn's former console.error-only handler) — usage/cost recording
   *  needs to happen here, at the process boundary, not buried in a fake. */
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

// the CLI defines this as a closed 5-value set; unlike --model (an open,
// ever-growing set of aliases/full names) it's safe and worth validating
// here — the adapter is where vendor-specific knowledge belongs (ADR 0005)
const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

/** Shared by boot-time default validation and every per-task spawn — one
 *  check, not a copy at each call site. */
function assertKnownEffort(definition: AgentDefinition): void {
  if (definition.effort !== undefined && !EFFORT_LEVELS.includes(definition.effort)) {
    throw new Error(`unknown effort level: ${definition.effort}`);
  }
}

// injected into every spawned session's system prompt (issue #31 / ADR
// 0010), regardless of agent or profile — a board-wide doctrine copied into
// each authority profile would drift, and "Agent tool"/"Workflow tool" are
// vendor vocabulary the adapter translates the board's line into (ADR 0005)
const BOARD_DOCTRINE = `## Board doctrine

Work that needs independent completion criteria, separate authority, its own
risk, or survival across sessions must not be routed to the Agent tool —
that is delegation smuggled past the board. Register that split with the
tidepool MCP's decompose instead.

The Agent tool may only be used for labor-splitting that does not divide
accountability (exploration, parallel research, mechanical edits): you carry
full accountability for its output as the parent task. If another registry
agent's capability is needed, use decompose with an assignee, not the Agent
tool.

The Workflow tool is off-limits in task sessions: a workflow script is a
decompose plan that never reached the board. If you find yourself wanting to
write one, register that split with the tidepool MCP's decompose instead.`;

// ADR 0017: the worker protocol (rules of the road for a board worker) is a
// board-wide doctrine, so it lives here and is injected into every session —
// not copied into each agent definition, where it would drift the same way
// BOARD_DOCTRINE would. Only the cross-cutting posture lives here: the MCP
// tool descriptions already carry each verb's semantics, and "call
// get_current_task first" already rides the `-p` prompt below — re-listing
// either here would just relocate the drift ADR 0017 removes. The canonical
// default agent is therefore an empty-body definition (tako) — it carries no
// specialty prose, and this section supplies the protocol every worker shares.
const WORKER_PROTOCOL = `## Rules of the road

Do the work in the current working directory. It is the task's workspace.

The tidepool MCP verbs are your only channel back to the board. Invent no side
channels: no direct edits to the board, no unrecorded decisions. If it is not
in an MCP verb, it did not happen.

Escalating is never wrong; guessing outside your authority is. When a decision
is outside your authority or you hit a dead end, escalate rather than guess.`;

/** One roster line's text (issue #43 / ADR 0014): "name — description",
 *  shared by every entry — a registry agent's `AgentDefinition` or the
 *  fixed `HUMAN_ROSTER_AGENT` alike, since both are `RosterAgent`s. */
function rosterLine(agent: RosterAgent): string {
  return `${agent.name} — ${agent.description}`;
}

/** Builds the push half of the roster (issue #43 / ADR 0014): the spawned
 *  agent's own `assignable_to` resolved against the registry into
 *  "name — description" lines, one per direct delegate. Cost is
 *  proportional to the allowlist, not the registry — `*` expands to every
 *  registry agent (an author's deliberate cost/permission tradeoff), and
 *  `human` (never a registry agent) draws `HUMAN_ROSTER_AGENT` only when
 *  explicitly listed. Absent/empty `assignable_to` → undefined (nothing to
 *  push). Names drifted out of the registry are silently skipped, same
 *  fail-closed spirit as the rest of this file's registry-drift handling. */
function buildRoster(registry: Registry, assignableTo: string[] | undefined): string | undefined {
  if (assignableTo === undefined || assignableTo.length === 0) return undefined;
  const wildcard = assignableTo.includes(AUTHORITY_WILDCARD);
  const explicitNames = assignableTo.filter((name) => name !== AUTHORITY_WILDCARD);
  const agentNames = wildcard ? Object.keys(registry.agents) : explicitNames;
  const agents: RosterAgent[] = agentNames
    .map((name) => ownEntry(registry.agents, name))
    .filter((agent): agent is AgentDefinition => agent !== undefined);
  if (explicitNames.includes(HUMAN_ROSTER_AGENT.name)) agents.push(HUMAN_ROSTER_AGENT);
  return agents.length > 0 ? agents.map(rosterLine).join("\n") : undefined;
}

/** Wraps a built roster (or nothing) as the trailing `## Roster` section of
 *  the system prompt — its own heading (CONTEXT.md's Roster term) rather
 *  than folded into `## Authority`, since it names delegates, not authority. */
function rosterSection(roster: string | undefined): string {
  return roster === undefined ? "" : `\n\n## Roster\n\n${roster}`;
}

// always explicit: the CLI remembers the host's last model/effort choice,
// and a flip in some unrelated directory must not leak into runs (ADR
// 0005) — shared by every `claude` CLI spawn site so the pinning rule has
// one shape, not one copy per call site
export function pinnedModelFlags(model: string, effort: string): string[] {
  return ["--model", model, "--effort", effort];
}

type WorkerExitedUsage = Extract<EventPayload, { kind: "worker_exited" }>["usage"];

/** The stream-json CLI's own final `result` event shape (vendor-specific,
 *  hence kept private to this adapter — ADR 0005) — only the fields
 *  worker_exited needs. */
interface StreamResultEvent {
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

/** Fail-closed like the rest of this file's vendor-shape handling
 *  (`checkUsage`'s try/catch, the quarantine-on-drift paths in `start()`): a
 *  `result` line whose `usage`/`total_cost_usd` don't match the expected
 *  shape is treated as no result at all, never cast through blind and left
 *  to throw later inside a stdout "data" handler. */
function isStreamResultEvent(value: unknown): value is StreamResultEvent {
  if (typeof value !== "object" || value === null) return false;
  const { total_cost_usd, usage } = value as Record<string, unknown>;
  if (typeof total_cost_usd !== "number") return false;
  if (typeof usage !== "object" || usage === null) return false;
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } =
    usage as Record<string, unknown>;
  return (
    typeof input_tokens === "number" &&
    typeof output_tokens === "number" &&
    typeof cache_read_input_tokens === "number" &&
    typeof cache_creation_input_tokens === "number"
  );
}

function parseResultLine(line: string): StreamResultEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as { type?: unknown };
    if (parsed.type !== "result") return null;
    return isStreamResultEvent(parsed) ? parsed : null;
  } catch {
    // a line split mid-chunk or genuinely malformed output — the last
    // *complete* result line already seen wins, so this just isn't one
    return null;
  }
}

/** Translates the CLI's vendor-shaped result event into the board's own
 *  worker_exited usage vocabulary (ADR 0005 / issue #32): total_cost_usd
 *  becomes estimated_cost_usd, no CLI field names leak past this point. */
function toUsage(result: StreamResultEvent): WorkerExitedUsage {
  return {
    input_tokens: result.usage.input_tokens,
    output_tokens: result.usage.output_tokens,
    cache_read_tokens: result.usage.cache_read_input_tokens,
    cache_creation_tokens: result.usage.cache_creation_input_tokens,
    estimated_cost_usd: result.total_cost_usd,
  };
}

export interface ClaudeWorkerOptions {
  db: Db;
  clock: Clock;
  /** Local clone of the agent registry repository. */
  registryDir: string;
  /** Agent name in the registry (`agents/<name>.md`). */
  agent: string;
  /** The board's Auditor pointer (CONTEXT.md / issue #15 layer 2), same shape
   *  as `agent` above — the fallback a `review` task's unset `assignee`
   *  resolves to at spawn (issue #42), instead of `agent`. Absent →
   *  `DEFAULT_AUDITOR_NAME` (the pointer always resolves — CONTEXT.md's
   *  Auditor). */
  auditorName?: string;
  /** Workspace name in the registry's workspaces.yaml — where tasks run. */
  workspace: string;
  /** ADR 0018: base directory a workspace entry's path derives from when the
   *  entry omits `path`. Absent → `resolveWorkspacesBaseDir`'s own fallback
   *  (`~/tidepool-workspaces`). */
  workspacesDir?: string;
  /** The board's MCP endpoint, e.g. http://127.0.0.1:4589/mcp. */
  mcpUrl: string;
  /** Where stream-json transcripts and spawn-time MCP configs land. */
  logDir: string;
  spawn?: SpawnFn;
  /** issue #81 / ADR 0028: the PTY boundary checkUsage scrapes /usage at.
   *  Injected so the scrape orchestration runs without a real PTY in tests. */
  pty?: PtyFn;
}

/** Request/response process boundary for one-shot CLI calls (unlike the
 *  streaming SpawnFn above) — the claude-draft-client's JIT draft poll runs
 *  through it (ADR 0008). checkUsage moved off this to the PTY boundary below
 *  (issue #81 / ADR 0028), since `/usage` only renders under a TTY. */
export type ExecFn = (command: string, args: string[]) => Promise<string>;

export const defaultExec: ExecFn = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** The interactive-TUI process boundary checkUsage scrapes at (issue #81 /
 *  ADR 0028): a PTY, so `claude`'s /usage panel renders as it would under a
 *  real terminal. Everything vendor-specific (node-pty, the interactive CLI
 *  flags) flows through this one call — faked in tests so the scrape
 *  orchestration runs without a real PTY (ADR 0027). */
export type PtyProcess = {
  onData(listener: (data: string) => void): void;
  /** Bytes to the CLI's stdin: a submitted line ends in ENTER; shutdown is
   *  CTRL_C sent twice. */
  write(data: string): void;
  kill(signal?: string): void;
  onExit(listener: () => void): void;
};

export type PtyFn = (
  command: string,
  args: string[],
  opts: { cwd: string; cols: number; rows: number },
) => PtyProcess;

// ADR 0028 empirical parameters. The scrape orchestration (checkUsage below)
// is unit-tested against a fake PTY, but these literal values are not — they
// were tuned by driving the real interactive CLI on both macOS (2.1.212) and
// the production Pi board (2.1.207), 2026-07-17. Re-confirm on a fresh host.
//
// Wait for this before sending /usage (never a fixed sleep): the input box
// shows a rotating `Try "…"` placeholder once it is drawn. Unlike the mode
// footer ("? for shortcuts" vs "shift+tab to cycle", which differs by the
// host's permission mode) or the safe-mode banner (which renders too early,
// before the box accepts input), the placeholder is common to every host and
// marks the prompt itself. Matched space-insensitively (see `squash`).
export const PROMPT_READY_MARKER = 'Try "';
// The interactive input box silently drops a slash command typed the instant
// it renders, so we let it settle before sending /usage. This is not a blind
// startup sleep — the prompt marker above is still the gate; this is the box's
// input-init window, found empirically (2000ms was the reliable floor on
// macOS; 2500 also cleared the slower Pi with margin).
const USAGE_PROMPT_SETTLE_MS = 2_500;
// The /usage panel is captured once both header lines have rendered; these
// double as the acceptance-criteria markers (Current session / Current week).
const PANEL_MARKERS = ["Current session", "Current week"];
// Once the panel's headers appear, each row's % and reset line can still
// arrive in a later chunk (the panel renders top-to-bottom over several
// writes). Wait for the render to go quiet before capturing so a chunk
// boundary can't split a number off the header we keyed on. Comfortably
// shorter than the gap before the panel re-renders with its usage breakdown,
// so we capture the first complete render, not the breakdown.
const PANEL_QUIET_MS = 500;
// Fail closed if the panel has not rendered within this budget (measured
// end-to-end ~3.4s on macOS, ~7s on the Pi, so 15s is generous headroom).
const USAGE_TIMEOUT_MS = 15_000;
// Wide enough that "Current session …" never wraps at 80 columns (ADR 0028).
const PTY_COLS = 200;
const PTY_ROWS = 50;
// stdin control bytes: submit a line, and Ctrl-C (sent twice for a clean
// interactive shutdown).
const ENTER = "\r";
const CTRL_C = "\x03";

// Force the fullscreen TUI renderer regardless of the host's own setting: the
// classic renderer lays words out with cursor-position moves rather than
// spaces, so once ANSI is stripped the panel collapses to "Currentsession
// 36%used" and parseUsage (#80) can't read it. The fullscreen renderer emits
// real spaces, keeping the raw parseable. Passed via --settings, which is
// honored even under --safe-mode (verified on the Pi board). This is the one
// piece of state checkUsage pins rather than inheriting from the host.
const USAGE_TUI_SETTINGS = JSON.stringify({ tui: "fullscreen" });

// Strip ANSI/OSC escapes and all whitespace. The CLI positions words with
// cursor-move escapes, not spaces, so a marker like "Current session" is never
// a contiguous substring of the raw stream; matching against this squashed
// view ("Currentsession") is robust across renderers and terminal widths. The
// captured raw is still returned verbatim — this view is only for matching.
function squash(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b[@-_][0-9;?]*[A-Za-z]?/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/\s+/g, "");
}

/** Space-insensitive (but case-sensitive) substring match against the squashed
 *  PTY stream. Case matters on purpose: `PROMPT_READY_MARKER` squashes to
 *  `Try"`, and keeping the capital T is what stops it matching a squashed
 *  `Retry "…"` (`…etry"…`). A spurious match would only fail closed anyway —
 *  parseUsage (#80) returns null on a capture that isn't a real panel. */
function seen(buffer: string, marker: string): boolean {
  return squash(buffer).includes(squash(marker));
}

function hasUsagePanel(buffer: string): boolean {
  return PANEL_MARKERS.every((marker) => seen(buffer, marker));
}

const defaultSpawn: SpawnFn = (command, args, opts) => {
  const child = nodeSpawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "inherit"] });
  // an unlistened "error" (e.g. the claude binary missing) would crash the
  // whole board process; slot recovery for a dead session is the watchdog
  // slice (#9), so here we only keep the failure visible
  child.on("error", (err) => console.error(`[worker] failed to spawn ${command}:`, err));
  // exit observation (worker_exited event) is the adapter's job now (issue
  // #32) — child already exposes .on("exit", ...) structurally, nothing more
  // to wire here
  return child;
};

const nodeRequire = createRequire(import.meta.url);

/** The real PTY boundary (issue #81 / ADR 0028): node-pty renders the
 *  interactive /usage panel under a TTY. node-pty is a native module and the
 *  only real-PTY path — kept out of automated tests (ADR 0027) and required
 *  lazily so the fake-injected suite never needs it built. */
const defaultPty: PtyFn = (command, args, opts) => {
  // node-pty's IPty already satisfies PtyProcess (onData/onExit/write/kill);
  // the seam exists to isolate the require, not to re-wrap identical methods.
  const nodePty = nodeRequire("node-pty") as {
    spawn(
      file: string,
      args: string[],
      options: { cwd: string; cols: number; rows: number; name: string },
    ): PtyProcess;
  };
  return nodePty.spawn(command, args, {
    cwd: opts.cwd,
    cols: opts.cols,
    rows: opts.rows,
    name: "xterm-256color",
  });
};

/** The real WorkerAdapter: spawns a headless Claude Code session per task.
 *  Vendor knowledge (spawn recipe, stream-json, agent definition format) stays
 *  inside this module — the board only sees the WorkerAdapter seam. */
export class ClaudeCodeWorker implements WorkerAdapter {
  readonly id: string;
  private readonly options: ClaudeWorkerOptions;
  private readonly spawn: SpawnFn;
  private readonly pty: PtyFn;
  /** logDir pinned to an absolute path: the spawned CLI resolves relative
   *  paths against its own cwd (the workspace), not against the board. */
  private readonly logDir: string;
  /** Live child processes by task id, for the watchdog's kill() (#9). A
   *  finished process removes itself so a stale entry never outlives it. */
  private readonly running = new Map<string, { kill(signal: NodeJS.Signals): void }>();
  /** ADR 0018: resolved once at construction, same "config edge" posture as
   *  the rest of `options` — env access itself stays in main.ts. */
  private readonly workspacesDir: string;

  constructor(options: ClaudeWorkerOptions) {
    this.id = options.agent;
    this.options = options;
    this.spawn = options.spawn ?? defaultSpawn;
    this.pty = options.pty ?? defaultPty;
    this.logDir = resolve(options.logDir);
    this.workspacesDir = resolveWorkspacesBaseDir(options.workspacesDir);
    // fail at boot, not at first pickup: a misconfigured registry must refuse
    // to start the board rather than wedge the first task
    this.validateDefaults(loadRegistry(options.registryDir));
  }

  /** Boot-time validation only: the configured default workspace/agent/
   *  authority/effort must all resolve against the registry, or the
   *  misconfiguration is thrown by name — a board must refuse to start
   *  rather than wedge the first task. Per-task resolution (task.workspace,
   *  task.assignee) happens fresh in `start()` below (issue #26 / ADR 0009,
   *  ADR 0012 / issue #36) — drift there quarantines instead of throwing. */
  private validateDefaults(registry: Registry): void {
    resolveExecutionWorkspace(registry, this.options.workspace, null, this.workspacesDir);
    const agent = resolveExecutionAgent(registry, this.options.agent, null);
    assertKnownEffort(agent.definition);
  }

  start(task: Task): void {
    // loaded per pickup so a registry update takes effect on the next task
    const registry = loadRegistry(this.options.registryDir);
    // task.workspace (issue #26 / ADR 0009) and task.assignee (ADR 0012 /
    // issue #36) both take precedence over this worker's configured
    // defaults — resolved fresh against the registry every pickup, never
    // pinned. An unknown name in either is registry drift, not a config
    // mistake: resolveOrQuarantine/resolveAgentOrQuarantine fail it closed
    // into quarantine rather than throwing out of start() — defense in depth
    // alongside the scheduler's own pre-pickup gate, which is what
    // ordinarily catches this before start() is ever called.
    const workspace = resolveOrQuarantine(
      this.options.db,
      (taskWorkspace) =>
        resolveExecutionWorkspace(registry, this.options.workspace, taskWorkspace, this.workspacesDir),
      task.workspace,
      this.options.clock.now(),
    );
    if (!workspace) return;
    // a review task's unset assignee resolves to the Auditor pointer, not
    // this worker's configured default agent (issue #42 / CONTEXT.md's
    // Auditor: independent review's value is its distance from the original
    // judgment, so it must never fall back to the same agent that did the
    // work) — every other type keeps resolving to `this.options.agent`.
    const defaultAgentName =
      task.type === "review" ? this.options.auditorName ?? DEFAULT_AUDITOR_NAME : this.options.agent;
    const agent = resolveAgentOrQuarantine(
      this.options.db,
      (taskAssignee) => resolveExecutionAgent(registry, defaultAgentName, taskAssignee),
      task.assignee,
      this.options.clock.now(),
    );
    if (!agent) return;
    const { definition, profile } = agent;
    assertKnownEffort(definition);
    // the ?task= param is the attribution the MCP router checks against the
    // slot — a stray call from a stale process fails that check and is refused
    const mcpConfigPath = join(this.logDir, `${task.id}.mcp.json`);
    writeFileSync(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          tidepool: { type: "http", url: `${this.options.mcpUrl}?task=${task.id}` },
        },
      }),
    );
    const prompt =
      `You are picking up tidepool task ${task.id}. ` +
      "Call get_current_task first, then work it to completion through the tidepool MCP verbs.";
    const child = this.spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        // headless sessions cannot answer prompts. auto keeps the classifier
        // safety layer while self-approving routine actions; authority is
        // enforced by the profile guidance and the board's domain verbs
        "--permission-mode",
        "auto",
        // dynamic orchestration is a category ban for workers, not a dial
        // (ADR 0010 addendum / issue #31): a workflow script is a decompose
        // plan that never reached the board. Confirmed against the
        // installed CLI (v2.1.207) that "Workflow" is the tool name exposed
        // to a headless session
        "--disallowedTools",
        "Workflow",
        ...pinnedModelFlags(definition.model ?? "sonnet", definition.effort ?? "medium"),
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        // who the agent is (registry definition body) and what its authority
        // sounds like (profile guidance prose), stitched at spawn time
        "--append-system-prompt",
        `${definition.systemPrompt}\n\n## Authority\n\n${profile.guidance}${rosterSection(buildRoster(registry, profile.assignable_to))}\n\n${BOARD_DOCTRINE}\n\n${WORKER_PROTOCOL}`,
      ],
      { cwd: workspace.path },
    );
    // the whole stream-json session is kept verbatim: the audit trail of what
    // the agent actually did, not just what it wrote back to the board
    child.stdout.pipe(createWriteStream(join(this.logDir, `${task.id}.stream.jsonl`)));
    // teed alongside the file write (issue #32): tracks the latest
    // stream-json `result` line so worker_exited can report usage/cost at
    // exit without re-reading the file back off disk
    let lastResult: StreamResultEvent | null = null;
    let buffered = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        lastResult = parseResultLine(line) ?? lastResult;
      }
    });
    this.running.set(task.id, child);
    appendEvent(this.options.db, {
      taskId: task.id,
      // attributed to whichever agent actually got spawned (ADR 0012 / issue
      // #36) — not this worker's configured default, which a pre-set
      // delegation may override
      workerId: agent.name,
      payload: {
        kind: "worker_spawned",
        registry_commit: registry.commit,
        definition_version: definition.version,
      },
      at: this.options.clock.now(),
    });
    // usage is settled at process exit — after task_completed via MCP, not
    // before (issue #32) — so kill/crash sessions still get a worker_exited
    // with usage: null rather than losing the exit fact entirely
    child.on("exit", (code, signal) => {
      this.running.delete(task.id);
      // the final stdout chunk may not end in "\n" (stream simply closes
      // mid-line), which would otherwise strand the last result line in
      // `buffered` forever and read as a false "missing usage" — same
      // status as an actual kill, which it isn't
      lastResult = parseResultLine(buffered) ?? lastResult;
      // this diagnostic used to live in defaultSpawn (console.error only);
      // promoted here alongside the worker_exited write so an operator
      // tailing logs still sees a crash, not just the audit record (issue #32)
      if (code !== 0) console.error(`[worker] claude exited with ${signal ?? code}`);
      appendEvent(this.options.db, {
        taskId: task.id,
        workerId: agent.name,
        payload: {
          kind: "worker_exited",
          exit_code: code,
          signal,
          usage: lastResult ? toUsage(lastResult) : null,
        },
        at: this.options.clock.now(),
      });
    });
  }

  kill(taskId: string, signal: KillSignal): void {
    this.running.get(taskId)?.kill(signal);
  }

  /** Scrapes the interactive /usage panel over a PTY (issue #81 / ADR 0028).
   *  The panel renders only under a TTY, and only the interactive session
   *  keeps the OAuth subscription auth that draws the % figures (`--bare`
   *  drops to API billing and the panel disappears). Runs in the board's own
   *  cwd (unlike start(), which pins cwd to the task's workspace) with
   *  --safe-mode so the board repo's CLAUDE.md/skills/MCP never leak into the
   *  probe. Auth/tokens are never touched — refresh is left to the CLI's own
   *  startup (ADR 0028's core constraint). Returns the captured raw text
   *  verbatim; ANSI stripping and extraction are parseUsage's job (#80). Any
   *  failure — spawn error, early exit, or timeout — resolves null so the
   *  scheduler fails closed, and the session is always torn down (Ctrl-C×2
   *  then kill) so no orphan is left behind. `--settings` pins the fullscreen
   *  renderer (see USAGE_TUI_SETTINGS) so the panel stays parseable regardless
   *  of the host's own TUI setting.
   *
   *  The old exec probe carried an ADR 0005 runaway *cost* ceiling
   *  (--model haiku/--max-turns/--max-budget-usd). That's gone: the
   *  interactive /usage panel makes no model call under subscription auth, so
   *  there is no cost to cap — runaway is bounded instead by time
   *  (USAGE_TIMEOUT_MS → SIGKILL). */
  async checkUsage(): Promise<string | null> {
    let session: PtyProcess;
    try {
      const settingsPath = join(this.logDir, "usage-tui-settings.json");
      writeFileSync(settingsPath, USAGE_TUI_SETTINGS);
      session = this.pty("claude", ["--safe-mode", "--settings", settingsPath], {
        cwd: process.cwd(),
        cols: PTY_COLS,
        rows: PTY_ROWS,
      });
    } catch {
      return null;
    }

    return new Promise<string | null>((resolve) => {
      let buffer = "";
      let promptSeen = false;
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      let panelTimer: ReturnType<typeof setTimeout> | undefined;

      const finish = (result: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(settleTimer);
        clearTimeout(panelTimer);
        try {
          // Ctrl-C×2 nudges the interactive session to exit cleanly, then
          // SIGKILL as the backstop so a CLI that catches/ignores the default
          // hangup can never orphan (ADR 0028's "no orphan" is the hard
          // acceptance criterion, so make it uncatchable rather than trust the
          // TUI's signal handling).
          session.write(CTRL_C + CTRL_C);
          session.kill("SIGKILL");
        } catch {
          // already gone (e.g. finishing from onExit) — nothing left to do
        }
        resolve(result);
      };

      const timer = setTimeout(() => finish(null), USAGE_TIMEOUT_MS);

      session.onExit(() => finish(hasUsagePanel(buffer) ? buffer : null));

      session.onData((data) => {
        buffer += data;
        // pattern-wait for the prompt (never a fixed sleep), then let the box
        // settle before sending /usage once — a command typed the instant the
        // box renders is dropped (ADR 0028).
        if (!promptSeen && seen(buffer, PROMPT_READY_MARKER)) {
          promptSeen = true;
          settleTimer = setTimeout(() => session.write(`/usage${ENTER}`), USAGE_PROMPT_SETTLE_MS);
        }
        if (hasUsagePanel(buffer)) {
          // capture once the panel stops rendering (debounce), so a chunk
          // boundary can't strand a %/reset row we haven't buffered yet
          clearTimeout(panelTimer);
          panelTimer = setTimeout(() => finish(buffer), PANEL_QUIET_MS);
        }
      });
    });
  }
}
