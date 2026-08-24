import { execFile, execFileSync, spawn as nodeSpawn } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  chmodSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
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
const CLOSED_FEATURES = [
  "apps",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "goals",
  "image_generation",
  "in_app_browser",
  "memories",
  "plugins",
  "recommended_plugins",
  "remote_plugin",
  "skill_mcp_dependency_install",
  "skill_search",
  "tool_suggest",
  "view_image",
  "workspace_dependencies",
] as const;
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
  /** Absolute executable established by the same preflight; spawn never relies on PATH. */
  executable: string;
  boardState?: BoardStatePath[];
  spawn?: CodexSpawnFn;
}

export interface CodexCapabilityObservation {
  cliVersion: string;
  mcpTools: readonly string[];
  skills: readonly string[];
  hooks: readonly string[];
  permissions: readonly string[];
  closedFeatures: readonly string[];
}

export type CodexCapabilityProbe = () => Promise<CodexCapabilityObservation>;

/** Version pin + measured #195 surface contract. Any drift closes Codex only. */
export async function checkCodexCapability(
  probe: CodexCapabilityProbe,
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
      ["closed feature", CLOSED_FEATURES, observed.closedFeatures],
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

function tomlInline(value: Record<string, unknown>): string {
  return `{${Object.entries(value)
    .map(([key, entry]) =>
      `${toml(key)}=${entry && typeof entry === "object" ? tomlInline(entry as Record<string, unknown>) : toml(entry)}`
    )
    .join(",")}}`;
}

function taskPrompt(task: Task, systemPrompt: string, authority: string): string {
  return `${systemPrompt}\n\n## Authority\n\n${authority}\n\n` +
    "Use only the tidepool MCP verbs to report board decisions and completion. " +
    "Board verbs are main-thread only; if a subagent needs one, call it from the main thread.\n\n" +
    `First call get_current_task for task ${task.id}, then complete this task: ${task.title}\n\n` +
    `Purpose: ${task.purpose}\nCompletion criteria: ${task.completion_criteria}`;
}

function permissionConfig(
  taskType: Task["type"],
  workspace: string,
  taskTemp: string,
  executable: string,
): string[] {
  const name = taskType === "review" ? "tidepool-review" : "tidepool-work";
  const parent = taskType === "review" ? ":read-only" : ":workspace";
  const access = taskType === "review" ? "read" : "write";
  const filesystem = {
    ":root": "deny",
    ":minimal": "read",
    ":slash_tmp": "deny",
    ":workspace_roots": { ".": access },
    [workspace]: access,
    [taskTemp]: "write",
    [dirname(process.execPath)]: "read",
    [dirname(executable)]: "read",
    "/Library/Developer/CommandLineTools/usr/bin": "read",
    "/System/Library/OpenSSL": "read",
  };
  const network = {
    enabled: true,
    domains: { "127.0.0.1": "allow" },
    unix_sockets: { [taskTemp]: "allow" },
    allow_local_binding: true,
  };
  return [
    `default_permissions=${toml(name)}`,
    `permissions.${name}.extends=${toml(parent)}`,
    `permissions.${name}.workspace_roots=${tomlInline({ [taskTemp]: true })}`,
    `permissions.${name}.filesystem=${tomlInline(filesystem)}`,
    `permissions.${name}.network=${tomlInline(network)}`,
  ];
}

function closedSurfaceConfig(): string[] {
  return [
    "features.network_proxy=true",
    "features.hooks=true",
    ...CLOSED_FEATURES.map((feature) => `features.${feature}=false`),
    'web_search="disabled"',
    "tools.web_search=false",
    "project_doc_max_bytes=0",
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
  const paths = SYSTEM_SKILLS.map((name) =>
    join(codexHome, "skills", ".system", name, "SKILL.md")
  );
  for (const root of [
    join(workspace, ".agents", "skills"),
    join(workspace, ".codex", "skills"),
    join(homedir(), ".agents", "skills"),
  ]) {
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) paths.push(join(root, entry.name, "SKILL.md"));
      }
    } catch {
      // A workspace need not declare skills.
    }
  }
  return `skills.config=[${paths.map((path) => `{path=${toml(path)},enabled=false}`).join(",")}]`;
}

function configArgs(config: readonly string[]): string[] {
  return config.flatMap((entry) => ["-c", entry]);
}

function runFile(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ""}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Resolve once at composition time. Worker spawn uses the returned absolute path,
 * so a narrower child PATH cannot turn an observed CLI into ENOENT. */
export function resolveCodexExecutable(searchPath = process.env.PATH ?? ""): string {
  const directories = searchPath.split(delimiter).filter(Boolean);
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = resolve(directory, "codex");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching the declared PATH.
    }
  }
  // Preserve the absolute-path invariant even when absent. The live preflight
  // will persist a Codex-only quarantine after the human surface is listening.
  return resolve(directories[0] ?? "/usr/local/bin", "codex");
}

function observedSkills(promptInput: string): string[] {
  const messages = JSON.parse(promptInput) as Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
  const instructions = messages
    .flatMap((message) => message.content ?? [])
    .map((item) => item.text ?? "")
    .find((text) => text.includes("<skills_instructions>"));
  if (!instructions) return [];
  const available = instructions
    .split("### Available skills\n", 2)[1]
    ?.split("</skills_instructions>", 1)[0];
  return available ? [...available.matchAll(/^- ([^:\n]+):/gm)].map((match) => match[1]!) : [];
}

async function probeMcpTools(mcpUrl: string): Promise<string[]> {
  const client = new Client({ name: "tidepool-codex-containment", version: "0.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
  }
}

function probeHook(codexHome: string, taskTemp: string): string[] {
  const hook = installBoardHook(codexHome);
  const state = join(taskTemp, "hook-state.json");
  writeFileSync(state, "[]", { mode: 0o600 });
  const env = { ...process.env, TIDEPOOL_SUBAGENT_STATE: state };
  execFileSync(process.execPath, [hook], {
    env,
    input: JSON.stringify({ hook_event_name: "SubagentStart", turn_id: "sub", agent_id: "a" }),
  });
  const denied = JSON.parse(execFileSync(process.execPath, [hook], {
    env,
    input: JSON.stringify({
      hook_event_name: "PreToolUse",
      turn_id: "sub",
      tool_name: "mcp__tidepool__complete_task",
    }),
    encoding: "utf8",
  })) as { hookSpecificOutput?: { permissionDecision?: string } };
  if (denied.hookSpecificOutput?.permissionDecision !== "deny") {
    throw new Error("Codex Board hook did not deny a subagent Board verb");
  }
  return [...CODEX_HOOKS];
}

const PERMISSION_CANARY = `
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const cp = require("node:child_process");
const [workspace, taskTemp, outside, access] = process.argv.slice(2);
const workspaceFile = workspace + "/.tidepool-codex-permission-canary";
const taskFile = taskTemp + "/task-canary";
try {
  const readable = fs.readFileSync(workspace + "/package.json", "utf8");
  if (!readable) process.exit(31);
  try {
    fs.readFileSync(outside, "utf8");
    process.exit(32);
  } catch {}
  if (access === "write") {
    fs.writeFileSync(workspaceFile, "ok");
    fs.unlinkSync(workspaceFile);
  } else {
    try {
      fs.writeFileSync(workspaceFile, "breach");
      process.exit(33);
    } catch {}
  }
  fs.writeFileSync(taskFile, "ok");
  if (cp.spawnSync(process.execPath, ["-e", "process.exit(0)"]).status !== 0) process.exit(34);
  if (cp.spawnSync("git", ["--version"]).status !== 0) process.exit(35);
  const tcp = http.createServer((_request, response) => response.end("ok"));
  tcp.listen(0, "127.0.0.1", () => {
    const request = http.get("http://127.0.0.1:" + tcp.address().port, (response) => {
      response.resume();
      response.on("end", () => tcp.close(() => {
        const socket = taskTemp + "/canary.sock";
        const unix = net.createServer();
        unix.listen(socket, () => {
          const peer = net.connect(socket, () => {
            peer.end();
            unix.close(() => process.exit(0));
          });
          peer.on("error", () => process.exit(38));
        });
      }));
    });
    request.on("error", () => process.exit(39));
  });
  setTimeout(() => process.exit(36), 3000);
} catch (error) {
  console.error(error);
  process.exit(37);
}
`;

async function probePermission(
  executable: string,
  workspace: string,
  taskTemp: string,
  taskType: "work" | "review",
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "tidepool-codex-outside-")));
  const outside = join(outsideDir, "secret");
  const canary = join(taskTemp, `${taskType}-permission-canary.cjs`);
  writeFileSync(outside, "must remain unreadable");
  writeFileSync(canary, PERMISSION_CANARY);
  try {
    await runFile(
      executable,
      [
        "sandbox",
        "-P", `tidepool-${taskType}`,
        "-C", workspace,
        ...configArgs(permissionConfig(taskType, workspace, taskTemp, executable)),
        process.execPath,
        canary,
        workspace,
        taskTemp,
        outside,
        taskType === "review" ? "read" : "write",
      ],
      { cwd: workspace, env },
    );
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
  }
}

async function actualCodexCapability(options: {
  executable: string;
  codexHome: string;
  workspace: string;
  mcpUrl: string;
}): Promise<CodexCapabilityObservation> {
  const taskTemp = realpathSync(mkdtempSync(join(tmpdir(), "tidepool-codex-preflight-")));
  const workspace = realpathSync(options.workspace);
  const hookState = join(taskTemp, "subagent-turns.json");
  writeFileSync(hookState, "[]", { mode: 0o600 });
  const env = workerEnv(options.executable, options.codexHome, taskTemp, hookState, "tidepool");
  const config = [
    ...closedSurfaceConfig(),
    skillConfig(options.codexHome, workspace),
  ];
  try {
    const cliVersion = (await runFile(options.executable, ["--version"], { env })).trim();
    const promptInput = await runFile(
      options.executable,
      ["debug", "prompt-input", ...configArgs(config), "containment canary"],
      { cwd: workspace, env },
    );
    const features = await runFile(
      options.executable,
      ["features", "list", ...configArgs(config)],
      { cwd: workspace, env },
    );
    const disabled = new Map(
      features.trim().split("\n").map((line) => {
        const fields = line.trim().split(/\s+/);
        return [fields[0], fields.at(-1)] as const;
      }),
    );
    await probePermission(options.executable, workspace, taskTemp, "work", env);
    await probePermission(options.executable, workspace, taskTemp, "review", env);
    return {
      cliVersion,
      mcpTools: await probeMcpTools(options.mcpUrl),
      skills: observedSkills(promptInput),
      hooks: probeHook(options.codexHome, taskTemp),
      permissions: [...CODEX_PERMISSIONS],
      closedFeatures: CLOSED_FEATURES.filter((feature) => disabled.get(feature) === "false"),
    };
  } finally {
    rmSync(taskTemp, { recursive: true, force: true });
  }
}

export function createCodexCapabilityCheck(options: {
  executable: string;
  codexHome: string;
  workspace: string;
  mcpUrl: string;
}): () => Promise<ContainmentCapability> {
  return () => checkCodexCapability(() => actualCodexCapability(options));
}

function workerEnv(
  executable: string,
  codexHome: string,
  taskTemp: string,
  hookState: string,
  agentName: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CODEX_HOME: codexHome,
    PATH: [dirname(executable), dirname(process.execPath), "/Library/Developer/CommandLineTools/usr/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
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

function consumeJsonl(
  buffered: string,
  chunk: string,
  observe: (event: unknown) => void,
  flush = false,
): string {
  const lines = (buffered + chunk).split("\n");
  const remainder = flush ? "" : (lines.pop() ?? "");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      observe(JSON.parse(line));
    } catch {
      // The verbatim transcript is the durable evidence; malformed lines
      // carry no normalized usage or auth fact.
    }
  }
  if (flush && lines.length === 0 && buffered.trim()) {
    try {
      observe(JSON.parse(buffered));
    } catch {}
  }
  return remainder;
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
    // resolveExecutionAgent already enforces this at pickup; keep the adapter's
    // vendor boundary explicit so a future direct caller cannot silently mask it.
    if (agent.definition.skills.length > 0) {
      throw new Error("CodexWorker v1 refuses a non-empty skill allowlist (ADR 0098)");
    }
    const taskTemp = realpathSync(mkdtempSync(join(tmpdir(), `tidepool-codex-${task.id}-`)));
    const hook = installBoardHook(this.options.codexHome);
    const hookState = join(dirname(hook), `${task.id}-${basename(taskTemp)}.subagent-turns.json`);
    writeFileSync(hookState, "[]", { mode: 0o600 });
    const taskMcpUrl = new URL(this.options.mcpUrl);
    taskMcpUrl.searchParams.set("task", task.id);
    const config = [
      `model_reasoning_effort=${toml(agent.definition.effort ?? "medium")}`,
      ...permissionConfig(task.type, workspace.path, taskTemp, this.options.executable),
      ...closedSurfaceConfig(),
      'forced_login_method="chatgpt"',
      `mcp_servers.tidepool.url=${toml(taskMcpUrl.toString())}`,
      `mcp_servers.tidepool.enabled_tools=${toml(BOARD_VERBS)}`,
      "mcp_servers.tidepool.required=true",
      skillConfig(this.options.codexHome, workspace.path),
      `hooks.SubagentStart=[{hooks=[{type="command",command=${toml(hook)}}]}]`,
      `hooks.PreToolUse=[{matcher="mcp__tidepool__.*",hooks=[{type="command",command=${toml(hook)}}]}]`,
    ];
    const child = this.spawn(
      this.options.executable,
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
        env: workerEnv(
          this.options.executable,
          this.options.codexHome,
          taskTemp,
          hookState,
          agent.name,
        ),
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
    const observe = (event: unknown) => {
      usage = readUsage(event) ?? usage;
      authFailed ||= isAuthFailure(event);
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      appendFileSync(transcript, text);
      stdout = consumeJsonl(stdout, text, observe);
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
      consumeJsonl(stdout, "", observe, true);
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
