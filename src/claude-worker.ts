import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAgentOrQuarantine, resolveExecutionAgent } from "./agent.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload } from "./events.js";
import { loadRegistry, type AgentDefinition, type Registry } from "./registry.js";
import { DEFAULT_AUDITOR_NAME, type Task } from "./tasks.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import { resolveExecutionWorkspace, resolveOrQuarantine } from "./workspace.js";

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
  /** The board's MCP endpoint, e.g. http://127.0.0.1:4589/mcp. */
  mcpUrl: string;
  /** Where stream-json transcripts and spawn-time MCP configs land. */
  logDir: string;
  spawn?: SpawnFn;
  exec?: ExecFn;
}

/** Request/response process boundary for one-shot CLI calls (unlike the
 *  streaming SpawnFn above) — used by checkUsage's `/usage` JIT poll
 *  (ADR 0008, measured 663ms, $0, no model call). */
export type ExecFn = (command: string, args: string[]) => Promise<string>;

export const defaultExec: ExecFn = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

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

/** The real WorkerAdapter: spawns a headless Claude Code session per task.
 *  Vendor knowledge (spawn recipe, stream-json, agent definition format) stays
 *  inside this module — the board only sees the WorkerAdapter seam. */
export class ClaudeCodeWorker implements WorkerAdapter {
  readonly id: string;
  private readonly options: ClaudeWorkerOptions;
  private readonly spawn: SpawnFn;
  private readonly exec: ExecFn;
  /** logDir pinned to an absolute path: the spawned CLI resolves relative
   *  paths against its own cwd (the workspace), not against the board. */
  private readonly logDir: string;
  /** Live child processes by task id, for the watchdog's kill() (#9). A
   *  finished process removes itself so a stale entry never outlives it. */
  private readonly running = new Map<string, { kill(signal: NodeJS.Signals): void }>();

  constructor(options: ClaudeWorkerOptions) {
    this.id = options.agent;
    this.options = options;
    this.spawn = options.spawn ?? defaultSpawn;
    this.exec = options.exec ?? defaultExec;
    this.logDir = resolve(options.logDir);
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
    resolveExecutionWorkspace(registry, this.options.workspace, null);
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
      (taskWorkspace) => resolveExecutionWorkspace(registry, this.options.workspace, taskWorkspace),
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
        `${definition.systemPrompt}\n\n## Authority\n\n${profile.guidance}\n\n${BOARD_DOCTRINE}`,
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

  /** --model/--max-turns/--max-budget-usd are a hard ceiling against a
   *  runaway session, not an expected path: ADR 0008 measured this call at
   *  $0 with zero model turns, but a misbehaving CLI must fail loud (and
   *  cheap) rather than run away — checkUsage() then just sees it as a
   *  failure and reports null (fail-closed). Confirmed against the installed
   *  CLI (v2.1.205) and the CLI reference: --max-turns exists but is omitted
   *  from --help. */
  async checkUsage(): Promise<string | null> {
    try {
      const stdout = await this.exec("claude", [
        "-p",
        "/usage",
        "--output-format",
        "json",
        "--model",
        "haiku",
        "--max-turns",
        "1",
        "--max-budget-usd",
        "0.01",
        // this call runs with the board's own cwd (unlike start(), which
        // pins cwd to the task's workspace) — --safe-mode keeps the board
        // repo's own CLAUDE.md/skills/MCP config from leaking into a trivial
        // /usage ping. Auth/model/tools/permissions are unaffected (unlike
        // --bare, which would force API-key-only auth)
        "--safe-mode",
      ]);
      const parsed: unknown = JSON.parse(stdout);
      const result = (parsed as { result?: unknown }).result;
      return typeof result === "string" ? result : null;
    } catch {
      return null;
    }
  }
}
