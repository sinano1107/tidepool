import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAgentOrQuarantine, resolveExecutionAgent } from "./agent.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
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
) => { stdout: NodeJS.ReadableStream; kill(signal: NodeJS.Signals): void };

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

// always explicit: the CLI remembers the host's last model/effort choice,
// and a flip in some unrelated directory must not leak into runs (ADR
// 0005) — shared by every `claude` CLI spawn site so the pinning rule has
// one shape, not one copy per call site
export function pinnedModelFlags(model: string, effort: string): string[] {
  return ["--model", model, "--effort", effort];
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
        ...pinnedModelFlags(definition.model ?? "sonnet", definition.effort ?? "medium"),
        "--mcp-config",
        mcpConfigPath,
        "--strict-mcp-config",
        // who the agent is (registry definition body) and what its authority
        // sounds like (profile guidance prose), stitched at spawn time
        "--append-system-prompt",
        `${definition.systemPrompt}\n\n## Authority\n\n${profile.guidance}`,
      ],
      { cwd: workspace.path },
    );
    // the whole stream-json session is kept verbatim: the audit trail of what
    // the agent actually did, not just what it wrote back to the board
    child.stdout.pipe(createWriteStream(join(this.logDir, `${task.id}.stream.jsonl`)));
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
