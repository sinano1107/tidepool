import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { loadRegistry, type Registry } from "./registry.js";
import type { Task } from "./tasks.js";
import { reportThrottle, type ThrottleEvent } from "./throttle.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";

/** #10 (要検証): the exact stream-json/exit shape a real rate-limited session
 *  emits has not been observed against a real 429 — this parses the
 *  documented Anthropic error taxonomy (`rate_limit_error`, a Unix-epoch-
 *  seconds `resets_at`) out of any line that carries it. Confirm this against
 *  a real limit-death before trusting it in production.
 *
 *  `allowed_warning` detection is deliberately NOT implemented here: unlike
 *  `rejected` (grounded in the documented error type above), there is no
 *  known signal for "allowed, but near the limit" to pattern-match against —
 *  guessing one would be worse than leaving the gap explicit. Observe a real
 *  near-limit session's stream-json before adding this. */
function parseThrottleEvent(line: string): ThrottleEvent | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const error = (msg as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const { type, resets_at: resetsAt } = error as { type?: unknown; resets_at?: unknown };
  if (type !== "rate_limit_error") return null;
  return {
    state: "rejected",
    resetsAt: typeof resetsAt === "number" ? new Date(resetsAt * 1000) : null,
  };
}

/** The process boundary the adapter is tested at: everything vendor-specific
 *  (the claude CLI, its flags) flows through this one call. */
export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string },
) => { stdout: NodeJS.ReadableStream; kill(signal: NodeJS.Signals): void };

// the CLI defines this as a closed 5-value set; unlike --model (an open,
// ever-growing set of aliases/full names) it's safe and worth validating
// here — the adapter is where vendor-specific knowledge belongs (ADR 0005)
const EFFORT_LEVELS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export interface ClaudeWorkerOptions {
  db: Db;
  clock: Clock;
  /** Local clone of the agent registry repository. */
  registryDir: string;
  /** Agent name in the registry (`agents/<name>.md`). */
  agent: string;
  /** Workspace name in the registry's workspaces.yaml — where tasks run. */
  workspace: string;
  /** The board's MCP endpoint, e.g. http://127.0.0.1:4589/mcp. */
  mcpUrl: string;
  /** Where stream-json transcripts and spawn-time MCP configs land. */
  logDir: string;
  spawn?: SpawnFn;
}

const defaultSpawn: SpawnFn = (command, args, opts) => {
  const child = nodeSpawn(command, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "inherit"] });
  // an unlistened "error" (e.g. the claude binary missing) would crash the
  // whole board process; slot recovery for a dead session is the watchdog
  // slice (#9), so here we only keep the failure visible
  child.on("error", (err) => console.error(`[worker] failed to spawn ${command}:`, err));
  child.on("exit", (code, signal) => {
    if (code !== 0) console.error(`[worker] ${command} exited with ${signal ?? code}`);
  });
  return child;
};

/** The real WorkerAdapter: spawns a headless Claude Code session per task.
 *  Vendor knowledge (spawn recipe, stream-json, agent definition format) stays
 *  inside this module — the board only sees the WorkerAdapter seam. */
export class ClaudeCodeWorker implements WorkerAdapter {
  readonly id: string;
  private readonly options: ClaudeWorkerOptions;
  private readonly spawn: SpawnFn;
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
    this.logDir = resolve(options.logDir);
    // fail at boot, not at first pickup: a misconfigured registry must refuse
    // to start the board rather than wedge the first task
    this.resolve(loadRegistry(options.registryDir));
  }

  /** Resolve this worker's agent, authority profile and workspace against a
   *  loaded registry, or throw the config mistake by name. */
  private resolve(registry: Registry) {
    const workspace = registry.workspaces[this.options.workspace];
    if (!workspace) throw new Error(`unknown workspace: ${this.options.workspace}`);
    const agent = registry.agents[this.options.agent];
    if (!agent) throw new Error(`unknown agent: ${this.options.agent}`);
    const profile = registry.authority[agent.authority];
    if (!profile) throw new Error(`unknown authority profile: ${agent.authority}`);
    if (agent.effort !== undefined && !EFFORT_LEVELS.includes(agent.effort)) {
      throw new Error(`unknown effort level: ${agent.effort}`);
    }
    return { workspace, agent, profile };
  }

  start(task: Task): void {
    // loaded per pickup so a registry update takes effect on the next task
    const registry = loadRegistry(this.options.registryDir);
    const { workspace, agent, profile } = this.resolve(registry);
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
        // always explicit: the CLI remembers the host's last model/effort
        // choice, and a flip in some unrelated directory must not leak into
        // runs (ADR 0005)
        "--model",
        agent.model ?? "sonnet",
        "--effort",
        agent.effort ?? "medium",
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        // who the agent is (registry definition body) and what its authority
        // sounds like (profile guidance prose), stitched at spawn time
        "--append-system-prompt",
        `${agent.systemPrompt}\n\n## Authority\n\n${profile.guidance}`,
      ],
      { cwd: workspace.path },
    );
    // the whole stream-json session is kept verbatim: the audit trail of what
    // the agent actually did, not just what it wrote back to the board
    child.stdout.pipe(createWriteStream(join(this.logDir, `${task.id}.stream.jsonl`)));
    // a second, independent reader off the same stream (issue #10): rate-limit
    // events are account-level facts the adapter reports directly, the same
    // pattern as the worker_spawned event below (ADR 0002: fire-and-forget)
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        const event = parseThrottleEvent(line);
        if (event) reportThrottle(this.options.db, event);
      }
    });
    this.running.set(task.id, child);
    appendEvent(this.options.db, {
      taskId: task.id,
      workerId: this.id,
      payload: {
        kind: "worker_spawned",
        registry_commit: registry.commit,
        definition_version: agent.version,
      },
      at: this.options.clock.now(),
    });
  }

  kill(taskId: string, signal: KillSignal): void {
    this.running.get(taskId)?.kill(signal);
  }
}
