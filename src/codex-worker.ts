import { execFile } from "node:child_process";
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
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveAgentOrQuarantine, resolveExecutionAgent } from "./agent.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import { agentGitIdentityEnv, PREMISE_BREACH_PROTOCOL } from "./claude-worker.js";
import type { Clock } from "./clock.js";
import {
  CODEX_APP_SERVER_VERSION,
  defaultCommand,
  parseResponses,
  respondedTo,
  resultOf,
} from "./codex-app-server.js";
import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload } from "./events.js";
import { type ExecutionSetting, resolveExecutionSetting } from "./execution-setting.js";
import {
  buildMemoryInjection,
  isMetaReviewOf,
  MEMORY_META_REVIEW_VERBS,
  recordMemoryInjection,
  WORKER_MEMORY_VERBS,
} from "./memory.js";
import { loadRegistry, type RegistrySource } from "./registry.js";
import { DEFAULT_AUDITOR_NAME, resolveTaskAgent, type Task } from "./tasks.js";
import type { WorkerAdapter } from "./worker.js";
import type { ContainerSpawn, WorkerContainers } from "./worker-container.js";
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
  "declare_premise_breach",
  "continue_decomposition",
  "redecompose",
  "record_knowledge",
  "define_memory_branch",
  "browse_memory",
  "search_memory",
  "read_memory",
  "propose_from_objection",
] as const;
export const CODEX_CLI_VERSION = CODEX_APP_SERVER_VERSION;
/** 盤面 verb を選ぶ matcher。spawn の設定と preflight の期待値は同じここから来る。 */
const BOARD_HOOK_MATCHER = "mcp__tidepool__.*";
/** ADR 0124 決定4: probe 専用の1行。`codex debug prompt-input` は推論リクエストを
 *  送らないので、この marker がモデルに届くことはない。 */
export const CODEX_DEVELOPER_MARKER = "tidepool-containment-probe: developer layer canary";
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
  // ADR 0129 決定2: Codex route の「subagent から盤面 verb 禁止」の床はこの feature を閉じること
  "multi_agent",
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

export type CodexSpawnFn = ContainerSpawn;

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
  /** Board-owned worker-session container supervisor (ADR 0099). */
  containers: WorkerContainers;
  boardState?: BoardStatePath[];
  /** ADR 0118: `spawn()` が失敗した pickup を受ける盤面側の一撃(`spawnFailureHandler` 製)。 */
  onSpawnFailed?: (taskId: string, failure: { error_code: string | null; message: string }) => void;
}

/** Codex に登録された hook のうち、盤面が宣言と突き合わせる5項目。`trustStatus` は含めない ——
 *  session flags 由来の hook は常に `untrusted` で、走る前提は exec 側の bypass flag が持つ。 */
export interface CodexHookRegistration {
  event: string;
  matcher: string | null;
  enabled: boolean;
  source: string;
  command: string | null;
}

/** 盤面が Codex に登録されていることを要求する hook —— spawn が渡す宣言と同じ1つの形。 */
function expectedCodexHooks(hookPath: string): CodexHookRegistration[] {
  return [{
    event: "preToolUse",
    matcher: BOARD_HOOK_MATCHER,
    enabled: true,
    source: "sessionFlags",
    command: hookPath,
  }];
}

/** `hooks/list` の `result` から、登録を cwd を跨いで並びのまま取り出す(ADR 0130 決定3)。
 *  vendor の応答の形が変わったときに落ちる場所はここ1つ。 */
export function observedHooks(result: unknown): CodexHookRegistration[] {
  const { data } = result as { data: Array<{ hooks: Array<Record<string, unknown>> }> };
  return data.flatMap((entry) => entry.hooks).map((hook) => ({
    event: hook.eventName as string,
    matcher: (hook.matcher ?? null) as string | null,
    enabled: hook.enabled as boolean,
    source: hook.source as string,
    command: (hook.command ?? null) as string | null,
  }));
}

export interface CodexCapabilityObservation {
  cliVersion: string;
  skills: readonly string[];
  hooks: readonly CodexHookRegistration[];
  permissions: readonly string[];
  closedFeatures: readonly string[];
  /** 盤面が `developer_instructions` で渡した marker のうち、developer item に載ったもの。 */
  developerMarkers: readonly string[];
}

export type CodexCapabilityProbe = () => Promise<CodexCapabilityObservation>;

/** Version pin + measured #195 surface contract. Any drift closes Codex only. */
export async function checkCodexCapability(
  probe: CodexCapabilityProbe,
  hookPath: string,
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
      ["skill", [], observed.skills],
      ["hook", expectedCodexHooks(hookPath), observed.hooks],
      ["permission", CODEX_PERMISSIONS, observed.permissions],
      ["closed feature", CLOSED_FEATURES, observed.closedFeatures],
      ["developer instructions", [CODEX_DEVELOPER_MARKER], observed.developerMarkers],
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

/** ADR 0124 決定1・2: 盤面が書いた文面 —— task に固有でない背景知識 —— は
 *  `developer_instructions` に載せる。Codex は次の part(`<skills_instructions>`)との間に
 *  区切りを入れないので、終端の空行は文面の一部である。 */
function developerInstructions(memorySection: string | null, systemPrompt: string, authority: string): string {
  return `${memorySection ? `${memorySection}\n\n` : ""}${systemPrompt}\n\n## Authority\n\n${authority}\n\n` +
    "Use only the tidepool MCP verbs to report board decisions and completion. " +
    "Board verbs are main-thread only; if a subagent needs one, call it from the main thread.\n\n" +
    `${PREMISE_BREACH_PROTOCOL}\n\n`;
}

/** user turn に残るのは、その task に固有の指示だけ(ADR 0124 決定1)。 */
function taskPrompt(task: Task): string {
  return `First call get_current_task for task ${task.id}, then complete this task: ${task.title}\n\n` +
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
    ...CLOSED_FEATURES.map((feature) => `features.${feature}=false`),
    'web_search="disabled"',
    "tools.web_search=false",
    "project_doc_max_bytes=0",
  ];
}

function boardHookPath(codexHome: string): string {
  return join(codexHome, "tidepool-hooks", "main-thread-mcp.mjs");
}

/** Board-owned hook: deny a Tidepool MCP call that carries a subagent identifier.
 * The main thread omits `agent_id` entirely, so presence of the key — not its truthiness —
 * is the gate. Parsing failures deny too; an unenforced hook must never fail open. */
function installBoardHook(codexHome: string): string {
  const hook = boardHookPath(codexHome);
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(
    hook,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const deny = reason => process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:reason}}));
try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.hook_event_name !== "PreToolUse") throw new Error("unexpected hook event " + input.hook_event_name);
  if (String(input.tool_name).startsWith("mcp__tidepool__") && "agent_id" in input) deny("Tidepool board verbs are main-thread only");
} catch (error) { deny("Tidepool hook failed closed: " + String(error)); }
`,
  );
  chmodSync(hook, 0o700);
  return hook;
}

/** 門の宣言。spawn が Codex に渡す設定と、preflight が登録を観測するときの設定は同じここから。 */
function hookConfig(hook: string): string[] {
  return [
    "features.hooks=true",
    `hooks.PreToolUse=[{matcher=${toml(BOARD_HOOK_MATCHER)},hooks=[{type="command",command=${toml(hook)}}]}]`,
  ];
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
 * so a narrower child PATH cannot turn an observed CLI into ENOENT.
 * 見つかった場合に返すのは symlink を解いた実体のパス —— sandbox が exec するのは実体なので、
 * `permissionConfig()` が read を与える `dirname()` も実体側でなければ届かない(issue #646)。 */
export function resolveCodexExecutable(searchPath = process.env.PATH ?? ""): string {
  const directories = searchPath.split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = resolve(directory, "codex");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return realpathSync(candidate);
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

/** ADR 0124 決定4: `codex debug prompt-input` の出力から、**developer role の item に
 *  属する part のうち marker と完全一致するもの**を集める。組み込み prompt 自体が
 *  developer item なので、role の存在ではなく逐語の一致だけが層への到達を言う。 */
export function observedDeveloperMarkers(promptInput: string): string[] {
  const messages = JSON.parse(promptInput) as Array<{
    role?: string;
    content?: Array<{ text?: string }>;
  }>;
  return messages
    .filter((message) => message.role === "developer")
    .flatMap((message) => message.content ?? [])
    .map((part) => part.text ?? "")
    .filter((text) => text === CODEX_DEVELOPER_MARKER);
}

/** 盤面が渡した hook を Codex が実際に**登録**したかを、使用量 probe と同じ app-server 面の
 *  `hooks/list` で読む(ADR 0130 決定3)。stdin は応答が揃うまで開けたままにする —— EOF で
 *  打ち切ると応答は来ない。
 *
 *  これは**登録**の観測であって**選択**の観測ではない。matcher が実物の呼び出しを選ぶことは
 *  開けた走行でしか観測できず、その受け入れは #730 が持つ。この行を「選択も見ている」と
 *  読んで #730 の受け入れ観測を省いてはならない。 */
async function probeHookRegistration(
  executable: string,
  env: NodeJS.ProcessEnv,
  hook: string,
): Promise<CodexHookRegistration[]> {
  const input = [
    {
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "tidepool", version: "0.0.0" }, capabilities: {} },
    },
    { method: "initialized" },
    { id: 2, method: "hooks/list", params: { cwds: [] } },
  ].map((request) => JSON.stringify(request)).join("\n") + "\n";
  const observed = await defaultCommand(
    executable,
    ["app-server", ...configArgs(hookConfig(hook))],
    { env, input, until: respondedTo([1, 2]) },
  );
  if (observed.exitCode !== 0) {
    throw new Error(
      `hooks/list probe failed: ${observed.stderr.trim() || `Codex exited ${observed.exitCode}`}`,
    );
  }
  return observedHooks(resultOf(parseResponses(observed.stdout), 2, "hooks/list"));
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
  // 読めることの証明は listing が throw しないことだけ —— workspace の中身に前提を置かない (#708)
  fs.readdirSync(workspace);
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
}): Promise<CodexCapabilityObservation> {
  const taskTemp = realpathSync(mkdtempSync(join(tmpdir(), "tidepool-codex-preflight-")));
  const workspace = realpathSync(options.workspace);
  const env = workerEnv(options.executable, options.codexHome, taskTemp, "tidepool");
  const config = [
    ...closedSurfaceConfig(),
    skillConfig(options.codexHome, workspace),
  ];
  try {
    const cliVersion = (await runFile(options.executable, ["--version"], { env })).trim();
    const promptInput = await runFile(
      options.executable,
      // marker は prompt-input にだけ渡す —— 実測したのはこの面だけ(ADR 0124 の測定)
      ["debug", "prompt-input", ...configArgs([...config, `developer_instructions=${toml(CODEX_DEVELOPER_MARKER)}`]), "containment canary"],
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
      skills: observedSkills(promptInput),
      developerMarkers: observedDeveloperMarkers(promptInput),
      hooks: await probeHookRegistration(options.executable, env, installBoardHook(options.codexHome)),
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
}): () => Promise<ContainmentCapability> {
  return () => checkCodexCapability(
    () => actualCodexCapability(options),
    boardHookPath(options.codexHome),
  );
}

function workerEnv(
  executable: string,
  codexHome: string,
  taskTemp: string,
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
  private readonly containers: WorkerContainers;
  private readonly logDir: string;
  private readonly workspacesDir: string;
  private readonly running = new Map<string, { kill(signal: NodeJS.Signals): void }>();

  constructor(private readonly options: CodexWorkerOptions) {
    this.id = options.agent;
    this.containers = options.containers;
    this.logDir = resolve(options.logDir);
    this.workspacesDir = resolveWorkspacesBaseDir(options.workspacesDir);
    mkdirSync(this.logDir, { recursive: true });
    mkdirSync(options.codexHome, { recursive: true });
  }

  start(task: Task, chosen?: ExecutionSetting): void {
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

    // resolveExecutionAgent already enforces this at pickup; keep the adapter's
    // vendor boundary explicit so a future direct caller cannot silently mask it.
    if (agent.definition.skills.length > 0) {
      throw new Error("CodexWorker v1 refuses a non-empty skill allowlist (ADR 0098)");
    }
    // ADR 0005 の明示ピン留めは Codex 側でも同じ強さで効く。model と effort の
    // 既定は adapter ごとに書かず、Claude 側と同じ1つの解決関数を通す。盤面が
    // 選んだ設定があればそれを使う(#544 —— spawn 側の再解決は除外の文脈を持たない)。
    const setting = chosen ?? resolveExecutionSetting(this.options.db, agent.definition, task);
    if (!setting) {
      throw new Error(`agent ${agent.name}: no Provider entry to run on (ADR 0110 決定1)`);
    }
    if (setting.provider !== "openai") {
      throw new Error(`CodexWorker refuses provider ${setting.provider}; no Harness fallback (ADR 0098)`);
    }
    const taskTemp = realpathSync(mkdtempSync(join(tmpdir(), `tidepool-codex-${task.id}-`)));
    const hook = installBoardHook(this.options.codexHome);
    const taskMcpUrl = new URL(this.options.mcpUrl);
    taskMcpUrl.searchParams.set("task", task.id);
    const memory = buildMemoryInjection(this.options.db, task, workspace.name, agent.name);
    const config = [
      `model_reasoning_effort=${toml(setting.effort)}`,
      `developer_instructions=${toml(developerInstructions(memory.section, agent.definition.systemPrompt, agent.profile.guidance))}`,
      ...permissionConfig(task.type, workspace.path, taskTemp, this.options.executable),
      ...closedSurfaceConfig(),
      'forced_login_method="chatgpt"',
      `mcp_servers.tidepool.url=${toml(taskMcpUrl.toString())}`,
      // ADR 0122 決定2: MCP の登録と同じ差を写す。宣言と盤面の面が集合として一致することは
      // tests/codex-worker.test.ts が固定する(ADR 0125 決定2)
      `mcp_servers.tidepool.enabled_tools=${toml(
        isMetaReviewOf(this.options.db, task.id, "memory")
          ? [...BOARD_VERBS.filter((verb) => !(WORKER_MEMORY_VERBS as readonly string[]).includes(verb)), ...MEMORY_META_REVIEW_VERBS]
          : BOARD_VERBS,
      )}`,
      "mcp_servers.tidepool.required=true",
      // ADR 0129 決定1: 答える人の居ない exec では承認の問いは Cancel にしかならない。verb の権限は盤面側が縛る
      'mcp_servers.tidepool.default_tools_approval_mode="approve"',
      skillConfig(this.options.codexHome, workspace.path),
      ...hookConfig(hook),
    ];
    const child = this.containers.open(task.id).spawn(
      this.options.executable,
      [
        "--ask-for-approval", "never",
        "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules",
        "--strict-config", "--dangerously-bypass-hook-trust",
        "-C", workspace.path,
        "-m", setting.model,
        ...config.flatMap((entry) => ["-c", entry]),
        taskPrompt(task),
      ],
      {
        cwd: workspace.path,
        env: workerEnv(this.options.executable, this.options.codexHome, taskTemp, agent.name),
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
        // openai の正準経路は advisor を提供しない(ADR 0098)ので、選ばれた
        // 実行設定に advisor は決して載らない
        advisor: null,
        provider: setting.provider,
        model: setting.model,
        effort: setting.effort,
        source: setting.source,
        harness: "codex",
        cli_version: this.options.cliVersion,
      },
      at: this.options.clock.now(),
    });
    recordMemoryInjection(this.options.db, task.id, agent.name, spawned, memory, this.options.clock.now());
    const transcript = join(this.logDir, `${task.id}.${spawned}.stream.jsonl`);
    const stderrPath = join(this.logDir, `${task.id}.${spawned}.stderr.log`);
    writeFileSync(transcript, "");
    writeFileSync(stderrPath, "");
    let stdout = "";
    let stderr = "";
    let usage: CodexUsage | null = null;
    const observe = (event: unknown) => {
      usage = readUsage(event) ?? usage;
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
      const errno = error as NodeJS.ErrnoException;
      // "error" は spawn 専用ではない(kill の失敗も撃つ)—— 走っている session を落とさず、
      // worker が1度も走らなかった事実も書かない(Claude adapter と同じ、ADR 0118)
      if (!errno.syscall?.startsWith("spawn")) {
        console.error(`[codex-worker] error on task ${task.id}:`, error);
        return;
      }
      this.running.delete(task.id);
      const failure = { error_code: errno.code ?? null, message: error.message };
      appendEvent(this.options.db, {
        taskId: task.id,
        workerId: agent.name,
        origin: "board",
        payload: { kind: "spawn_failed", ...failure },
        at: this.options.clock.now(),
      });
      this.options.onSpawnFailed?.(task.id, failure);
    });
    child.on("exit", (code, signal) => {
      this.running.delete(task.id);
      consumeJsonl(stdout, "", observe, true);
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
      // ADR 0109 決定4: root の exit は容器に残るものが孤児である証拠 —— usage と
      // transcript を書いた後に強制回収を撃つ。Harness 非依存に、盤面 supervisor 経由。
      this.containers.forceReclaim(task.id);
    });
  }

  /** Codex folds up on SIGINT; force/reclaimed belong to WorkerContainers. */
  gracefulStop(taskId: string): void {
    this.running.get(taskId)?.kill("SIGINT");
  }

  async checkUsage(): Promise<string | null> {
    return null;
  }
}
