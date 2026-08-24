import { execFile, spawn as nodeSpawn } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { resolveAgentOrQuarantine, resolveExecutionAgent } from "./agent.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import { agentGitIdentityEnv } from "./claude-worker.js";
import { quarantineCliAuthForProvider } from "./cli-auth.js";
import type { Clock } from "./clock.js";
import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload } from "./events.js";
import { loadRegistry, type RegistrySource } from "./registry.js";
import { DEFAULT_AUDITOR_NAME, resolveTaskAgent, type Task } from "./tasks.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import {
  quarantineWorkspace,
  resolveExecutionWorkspace,
  resolveOrQuarantine,
  resolveWorkspacesBaseDir,
} from "./workspace.js";

const BOARD_VERBS = [
  "get_current_task",
  "list_agents",
  "complete_task",
  "log_decision",
  "decompose",
  "escalate",
] as const;
export const CODEX_CLI_VERSION = "codex-cli 0.147.0";
const CODEX_HOOKS = ["SubagentStart", "PreToolUse"] as const;
const CODEX_PERMISSIONS = ["tidepool-work", "tidepool-review"] as const;
const SYSTEM_SKILLS = ["imagegen", "openai-docs", "plugin-creator", "skill-creator", "skill-installer"];
const SECRET_ENV = [
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

export type CodexSpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal: NodeJS.Signals): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
};

const defaultSpawn: CodexSpawnFn = (command, args, options) =>
  nodeSpawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });

export interface CodexWorkerOptions {
  db: Db;
  clock: Clock;
  registry: RegistrySource;
  agent: string;
  auditorName?: string;
  workspace: string;
  workspacesDir?: string;
  mcpUrl: string;
  logDir: string;
  /** Board-owned shared ChatGPT login/cache, isolated from the operator's Codex config. */
  codexHome: string;
  /** Version already established by the Harness preflight; production pins 0.147.0. */
  cliVersion: string;
  boardState?: BoardStatePath[];
  spawn?: CodexSpawnFn;
}

export interface CodexCapabilityObservation {
  cliVersion: string;
  mcpTools: readonly string[];
  skills: readonly string[];
  hooks: readonly string[];
  permissions: readonly string[];
}

export type CodexCapabilityProbe = () => Promise<CodexCapabilityObservation>;

function actualCodexCapability(): Promise<CodexCapabilityObservation> {
  return new Promise((resolve, reject) => {
    execFile("codex", ["--version"], (error, stdout) => {
      if (error) reject(error);
      else resolve({
        cliVersion: stdout.trim(),
        // The version pin makes #195's measured surface the compatibility
        // contract; these four lists are the Board-generated config checked
        // below, not claims inferred from a newer CLI.
        mcpTools: BOARD_VERBS,
        skills: [],
        hooks: CODEX_HOOKS,
        permissions: CODEX_PERMISSIONS,
      });
    });
  });
}

/** Version pin + measured #195 surface contract. Any drift closes Codex only. */
export async function checkCodexCapability(
  probe: CodexCapabilityProbe = actualCodexCapability,
): Promise<ContainmentCapability> {
  let observed: CodexCapabilityObservation;
  try {
    observed = await probe();
  } catch (error) {
    return { available: false, reason: `Codex containment preflight could not run: ${String(error)}` };
  }
  const mismatch = (
    [
      ["version", [CODEX_CLI_VERSION], [observed.cliVersion]],
      ["MCP tool", BOARD_VERBS, observed.mcpTools],
      ["skill", [], observed.skills],
      ["hook", CODEX_HOOKS, observed.hooks],
      ["permission", CODEX_PERMISSIONS, observed.permissions],
    ] as const
  ).find(([, expected, actual]) => JSON.stringify(expected) !== JSON.stringify(actual));
  return mismatch
    ? {
        available: false,
        reason:
          `Codex containment preflight ${mismatch[0]} mismatch: expected ` +
          `${JSON.stringify(mismatch[1])}, observed ${JSON.stringify(mismatch[2])}`,
      }
    : { available: true };
}

function toml(value: unknown): string {
  return JSON.stringify(value);
}

function taskPrompt(task: Task, systemPrompt: string, authority: string): string {
  return `${systemPrompt}\n\n## Authority\n\n${authority}\n\n` +
    "Use only the tidepool MCP verbs to report board decisions and completion. " +
    "Board verbs are main-thread only; if a subagent needs one, call it from the main thread.\n\n" +
    `First call get_current_task for task ${task.id}, then complete this task: ${task.title}\n\n` +
    `Purpose: ${task.purpose}\nCompletion criteria: ${task.completion_criteria}`;
}

function permissionConfig(task: Task, domains: readonly string[]): string[] {
  const name = task.type === "review" ? "tidepool-review" : "tidepool-work";
  const parent = task.type === "review" ? ":read-only" : ":workspace";
  const filesystem = task.type === "review"
    ? '{":minimal"="read",":workspace_roots"={"."="read"}}'
    : '{":minimal"="read",":workspace_roots"={"."="write"},":tmpdir"="write"}';
  const allowed = [...domains, "127.0.0.1"]
    .map((domain) => `${toml(domain)}="allow"`)
    .join(",");
  return [
    `default_permissions=${toml(name)}`,
    `permissions.${name}.extends=${toml(parent)}`,
    `permissions.${name}.filesystem=${filesystem}`,
    `permissions.${name}.network={enabled=true,domains={${allowed}}}`,
  ];
}

/** Board-owned hook: remember subagent turns, then deny only their Tidepool MCP calls.
 * Parsing/state failures deny too; an unenforced hook must never fail open. */
function installBoardHook(codexHome: string): string {
  const hookDir = join(codexHome, "tidepool-hooks");
  const hook = join(hookDir, "main-thread-mcp.mjs");
  mkdirSync(hookDir, { recursive: true });
  writeFileSync(
    hook,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const state = process.env.TIDEPOOL_SUBAGENT_STATE;
const deny = reason => process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:reason}}));
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (!state) throw new Error("missing hook state");
  if (input.hook_event_name === "SubagentStart") {
    const turns = JSON.parse(readFileSync(state, "utf8"));
    if (!input.turn_id || !input.agent_id || !Array.isArray(turns)) throw new Error("invalid SubagentStart");
    writeFileSync(state, JSON.stringify([...new Set([...turns, input.turn_id])]));
  } else if (input.hook_event_name === "PreToolUse" && String(input.tool_name).startsWith("mcp__tidepool__")) {
    const turns = JSON.parse(readFileSync(state, "utf8"));
    if (!Array.isArray(turns)) throw new Error("invalid hook state");
    if (input.agent_id || turns.includes(input.turn_id)) deny("Tidepool board verbs are main-thread only");
  }
} catch (error) { deny("Tidepool hook failed closed: " + String(error)); }
`,
  );
  chmodSync(hook, 0o700);
  return hook;
}

function skillConfig(codexHome: string, workspace: string): string {
  const paths = SYSTEM_SKILLS.map((name) => join(codexHome, "skills", ".system", name));
  for (const root of [
    join(workspace, ".agents", "skills"),
    join(workspace, ".codex", "skills"),
    join(homedir(), ".agents", "skills"),
  ]) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) paths.push(join(root, entry.name));
      }
    } catch {
      // A workspace need not declare skills.
    }
  }
  return `skills.config=[${paths.map((path) => `{path=${toml(path)},enabled=false}`).join(",")}]`;
}

function workerEnv(
  codexHome: string,
  taskTemp: string,
  hookState: string,
  agentName: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    PATH: [dirname(process.execPath), "/Library/Developer/CommandLineTools/usr/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    XDG_CONFIG_HOME: join(taskTemp, "xdg"),
    TMPDIR: taskTemp,
    npm_config_cache: join(taskTemp, "npm-cache"),
    npm_config_userconfig: "/dev/null",
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    TIDEPOOL_SUBAGENT_STATE: hookState,
    ...agentGitIdentityEnv(agentName),
  };
  for (const name of SECRET_ENV) delete env[name];
  return env;
}

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

function readUsage(value: unknown): CodexUsage | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { type?: unknown; usage?: Record<string, unknown> };
  const usage = event.type === "turn.completed" ? event.usage : undefined;
  return usage && [usage.input_tokens, usage.cached_input_tokens, usage.output_tokens].every(Number.isFinite)
    ? usage as unknown as CodexUsage
    : null;
}

function isAuthFailure(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const message = String((value as { message?: unknown }).message ?? "").toLowerCase();
  return message.includes("authentication") || message.includes("unauthorized") || message.includes("401");
}

/** The OpenAI vendor adapter. The board selects it only for `provider: openai`. */
export class CodexWorker implements WorkerAdapter {
  readonly id: string;
  private readonly spawn: CodexSpawnFn;
  private readonly logDir: string;
  private readonly workspacesDir: string;
  private readonly running = new Map<string, { kill(signal: NodeJS.Signals): void }>();

  constructor(private readonly options: CodexWorkerOptions) {
    this.id = options.agent;
    this.spawn = options.spawn ?? defaultSpawn;
    this.logDir = resolve(options.logDir);
    this.workspacesDir = resolveWorkspacesBaseDir(options.workspacesDir);
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(options.codexHome, { recursive: true });
  }

  start(task: Task): void {
    const registry = loadRegistry(this.options.registry.dir, this.options.registry.mode);
    const workspace = resolveOrQuarantine(
      this.options.db,
      (name) => resolveExecutionWorkspace(registry, this.options.workspace, name, this.workspacesDir),
      task.workspace,
      this.options.clock.now(),
    );
    if (!workspace) return;
    const overlap = this.options.boardState && boardStateOverlap(workspace.path, this.options.boardState);
    if (overlap) {
      quarantineWorkspace(this.options.db, workspace.name, new Error(overlap.reason), this.options.clock.now());
      return;
    }
    const assignee = resolveTaskAgent(task, this.options.agent, this.options.auditorName ?? DEFAULT_AUDITOR_NAME);
    const agent = resolveAgentOrQuarantine(
      this.options.db,
      (name) => resolveExecutionAgent(registry, this.options.agent, name),
      assignee,
      this.options.clock.now(),
    );
    if (!agent) return;
    if (agent.definition.provider !== "openai") {
      throw new Error(`CodexWorker refuses provider ${agent.definition.provider}; no Harness fallback (ADR 0098)`);
    }
    const taskTemp = mkdtempSync(join(tmpdir(), `tidepool-codex-${task.id}-`));
    const hook = installBoardHook(this.options.codexHome);
    const hookState = join(dirname(hook), `${task.id}-${basename(taskTemp)}.subagent-turns.json`);
    writeFileSync(hookState, "[]", { mode: 0o600 });
    const config = [
      `model_reasoning_effort=${toml(agent.definition.effort ?? "medium")}`,
      ...permissionConfig(task, workspace.allowed_domains ?? []),
      "features.network_proxy=true",
      "features.plugins=false",
      "features.tool_search=false",
      "features.apps=false",
      "features.hooks=true",
      'web_search="disabled"',
      "tools.web_search=false",
      "tools.view_image=false",
      "project_doc_max_bytes=0",
      'forced_login_method="chatgpt"',
      `mcp_servers.tidepool.url=${toml(this.options.mcpUrl)}`,
      `mcp_servers.tidepool.enabled_tools=${toml(BOARD_VERBS)}`,
      "mcp_servers.tidepool.required=true",
      skillConfig(this.options.codexHome, workspace.path),
      `hooks.SubagentStart=[{hooks=[{type="command",command=${toml(hook)}}]}]`,
      `hooks.PreToolUse=[{matcher="mcp__tidepool__.*",hooks=[{type="command",command=${toml(hook)}}]}]`,
    ];
    const child = this.spawn(
      "codex",
      [
        "--ask-for-approval", "never",
        "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--strict-config", "--dangerously-bypass-hook-trust",
        "-C", workspace.path,
        "-m", agent.definition.model ?? "gpt-5.6-sol",
        ...config.flatMap((entry) => ["-c", entry]),
        taskPrompt(task, agent.definition.systemPrompt, agent.profile.guidance),
      ],
      {
        cwd: workspace.path,
        env: workerEnv(this.options.codexHome, taskTemp, hookState, agent.name),
      },
    );
    const spawned = appendEvent(this.options.db, {
      taskId: task.id,
      workerId: agent.name,
      origin: "board",
      payload: {
        kind: "worker_spawned",
        registry_commit: registry.commit,
        definition_version: agent.definition.version,
        advisor: null,
        harness: "codex",
        cli_version: this.options.cliVersion,
      },
      at: this.options.clock.now(),
    });
    const transcript = join(this.logDir, `${task.id}.${spawned}.stream.jsonl`);
    const stderrPath = join(this.logDir, `${task.id}.${spawned}.stderr.log`);
    writeFileSync(transcript, "");
    writeFileSync(stderrPath, "");
    let stdout = "";
    let stderr = "";
    let usage: CodexUsage | null = null;
    let authFailed = false;
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      appendFileSync(transcript, text);
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event: unknown = JSON.parse(line);
          usage = readUsage(event) ?? usage;
          authFailed ||= isAuthFailure(event);
        } catch {
          // The verbatim transcript is the durable evidence; malformed lines carry no usage.
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      appendFileSync(stderrPath, text);
    });
    this.running.set(task.id, child);
    child.on("error", (error) => {
      this.running.delete(task.id);
      appendEvent(this.options.db, {
        taskId: task.id,
        workerId: agent.name,
        origin: "board",
        payload: {
          kind: "spawn_failed",
          error_code: (error as NodeJS.ErrnoException).code ?? null,
          message: error.message,
        },
        at: this.options.clock.now(),
      });
    });
    child.on("exit", (code, signal) => {
      this.running.delete(task.id);
      if (stdout) {
        try {
          const event: unknown = JSON.parse(stdout);
          usage = readUsage(event) ?? usage;
          authFailed ||= isAuthFailure(event);
        } catch {
          // Kept verbatim above.
        }
      }
      if (authFailed) quarantineCliAuthForProvider(this.options.db, "openai", this.options.clock.now());
      const tail = stderr.trim().split("\n").slice(-20).join("\n") || null;
      const normalized: Extract<EventPayload, { kind: "worker_exited" }>["usage"] = usage
        ? {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_tokens: usage.cached_input_tokens,
            cache_creation_tokens: 0,
            estimated_cost_usd: null,
            advisor: null,
          }
        : null;
      appendEvent(this.options.db, {
        taskId: task.id,
        workerId: agent.name,
        origin: "board",
        payload: {
          kind: "worker_exited",
          exit_code: code,
          signal,
          stderr_tail: tail,
          worker_spawned_event_id: spawned,
          usage: normalized,
        },
        at: this.options.clock.now(),
      });
    });
  }

  kill(taskId: string, signal: KillSignal): void {
    this.running.get(taskId)?.kill(signal);
  }

  async checkUsage(): Promise<string | null> {
    return null;
  }
}
