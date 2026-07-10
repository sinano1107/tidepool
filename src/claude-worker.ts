import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { loadRegistry, type Registry } from "./registry.js";
import type { Task } from "./tasks.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import { quarantineWorkspace, resolveExecutionWorkspace, UnknownWorkspaceError } from "./workspace.js";

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
  exec?: ExecFn;
}

/** Request/response process boundary for one-shot CLI calls (unlike the
 *  streaming SpawnFn above) — used by checkUsage's `/usage` JIT poll
 *  (ADR 0008, measured 663ms, $0, no model call). */
export type ExecFn = (command: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (command, args) =>
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
    this.resolve(loadRegistry(options.registryDir));
  }

  /** Resolve this worker's agent, authority profile and (issue #26 / ADR
   *  0009) the given task's own execution workspace against a loaded
   *  registry, or throw the config mistake by name. `workspaceName` defaults
   *  to this worker's configured default — the constructor's boot-time
   *  validation call relies on that default. */
  private resolve(registry: Registry, workspaceName: string = this.options.workspace) {
    const workspace = resolveExecutionWorkspace(registry, workspaceName, null);
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
    // task.workspace (issue #26 / ADR 0009) takes precedence over this
    // worker's configured default — resolved fresh against the registry
    // every pickup, never pinned to a path. An unknown name is registry
    // drift, not a config mistake (unlike an unknown agent/authority below):
    // it fails closed into quarantine rather than throwing out of start() —
    // defense in depth alongside the scheduler's own pre-pickup gate, which
    // is what ordinarily catches this before start() is ever called.
    let resolved: ReturnType<typeof this.resolve>;
    try {
      resolved = this.resolve(registry, task.workspace ?? this.options.workspace);
    } catch (err) {
      if (!(err instanceof UnknownWorkspaceError)) throw err;
      quarantineWorkspace(this.options.db, err.workspaceName, err, this.options.clock.now());
      return;
    }
    const { workspace, agent, profile } = resolved;
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
      ]);
      const parsed: unknown = JSON.parse(stdout);
      const result = (parsed as { result?: unknown }).result;
      return typeof result === "string" ? result : null;
    } catch {
      return null;
    }
  }
}
