import { spawn as nodeSpawn } from "node:child_process";
import { createWriteStream, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { loadRegistry, type Registry } from "./registry.js";
import type { Task } from "./tasks.js";
import type { WorkerAdapter } from "./worker.js";

/** The process boundary the adapter is tested at: everything vendor-specific
 *  (the claude CLI, its flags) flows through this one call. */
export type SpawnFn = (
  command: string,
  args: string[],
  opts: { cwd: string },
) => { stdout: NodeJS.ReadableStream };

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

  constructor(options: ClaudeWorkerOptions) {
    this.id = options.agent;
    this.options = options;
    this.spawn = options.spawn ?? defaultSpawn;
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
    return { workspace, agent, profile };
  }

  start(task: Task): void {
    // loaded per pickup so a registry update takes effect on the next task
    const registry = loadRegistry(this.options.registryDir);
    const { workspace, agent, profile } = this.resolve(registry);
    // the ?task= param is the attribution the MCP router checks against the
    // slot — a stray call from a stale process fails that check and is refused
    const mcpConfigPath = join(this.options.logDir, `${task.id}.mcp.json`);
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
    child.stdout.pipe(createWriteStream(join(this.options.logDir, `${task.id}.stream.jsonl`)));
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
}
