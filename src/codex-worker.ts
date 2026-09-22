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
import { type BoardCall, readOutput } from "./board-call.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import { agentGitIdentityEnv, PREMISE_BREACH_PROTOCOL } from "./claude-worker.js";
import type { Clock } from "./clock.js";
import { CODEX_APP_SERVER_VERSION, callAppServer, codexCommandThrough } from "./codex-app-server.js";
import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { appendEvent, type EventPayload } from "./events.js";
import type { ExecutionSetting } from "./execution-setting.js";
import {
  buildMemoryInjection,
  isMetaReviewOf,
  MEMORY_META_REVIEW_VERBS,
  recordMemoryInjection,
  WORKER_MEMORY_VERBS,
} from "./memory.js";
import type { ContainerSpawn, ProcessContainers } from "./process-container.js";
import { loadRegistry, type RegistrySource } from "./registry.js";
import { DEFAULT_AUDITOR_NAME, resolveTaskAgent, type Task } from "./tasks.js";
import type { WorkerAdapter, WorkerExit } from "./worker.js";
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
/** 盤面が開ける feature —— 既定拒否の例外(ADR 0135 決定1)。ここに名前の無い feature は
 *  closedSurfaceConfig() が `=false` で閉じる。vendor が版の途中で足した名前は snapshot に無いので
 *  `=false` も渡らないが、その版へ pin を上げる前に featureDrift() が preflight を倒す。
 *  feature ごとに vendor source を読んだ表と `file:line` は #571 のコメント。 */
const OPEN_FEATURES = [
  // サンドボックスの egress を濾す proxy —— 閉じると濾しが消える。#453 から明示で開けている
  "network_proxy",
  // subagent から盤面 verb を deny する門が hook —— 宣言は hookConfig() が出す(ADR 0130 決定1)
  "hooks",
  // 床が hook の門へ移り、閉じる根拠が無くなった(ADR 0134 決定1)
  "multi_agent",
  // 閉じると shell tool 自体が Disabled になり、unified_exec も道連れに落ちる
  "shell_tool",
  // code mode の session provider —— pin 同梱の gpt-5.6 系は metadata が code_mode_only と読め、
  // 閉じると Direct への fallback が無い(source 読み、runtime は #762)
  "code_mode_host",
  // 閉じると ShellCommand へ降格するだけ —— 必須機能の実装の切り替え(ADR 0135 決定2)
  "unified_exec",
  // remote compaction の V2 / V1 の選択。閉じても local compaction にはならない
  "remote_compaction_v2",
  // thread ごとの login shell 環境 snapshot —— 実装の切り替え
  "shell_snapshot",
  // ModelClient の転送圧縮 —— 実装の切り替え
  "enable_request_compression",
] as const;
/** `=false` が届かない名前(ADR 0135 決定4)。vendor の `apply_map` が手書きの skip list で
 *  `disable()` の前に読み飛ばすため、閉じても `features list` は true を返し続ける。stage `removed` で
 *  読む箇所は無い —— 面ではないが、導出から除かないと snapshot と食い違う。 */
const UNSETTABLE_FEATURES = [
  "tui_app_server",
  "tool_search_always_defer_mcp_tools",
  "resize_all_images",
  "item_ids",
  "terminal_resize_reflow",
] as const;
/** `codex features list` の全量(name → effective state)の写し。stage 列は含めない —— 面は state。
 * CODEX_CLI_VERSION に**従属する**期待値で、pin を上げたら下の手順で採り直す。採り直さない限り
 * feature 差分で preflight が倒れ続けるので、pin 更新時の読み直しをこの定数がコードで強制する
 * (ADR 0108 追記、issue #532)。
 *
 * 採取条件(pin の版で実測。採り直しも必ず pin と同じ版で): venue は Lima VM `tidepool`
 * (Linux aarch64 musl) —— preflight が走るのはそちら。Mac(darwin arm64)の出力と1行も違わず、
 * CODEX_HOME が新規の空でもログイン済みでも同一(auth 非依存)。`skillConfig()` の有無でも同一なので
 * 採取時は付けていない(probe は付ける)。`-c` は closedSurfaceConfig() と同じ導出 —— どちらかを
 * 動かしたらこの定数も動く。
 *
 * pin を上げるときは、採り直しに加えて vendor source で2点を読み直す(ADR 0135 決定5): model metadata が
 * features に勝つ欄(今日は `multi_agent_version` —— ADR 0134、`tool_mode` —— #762)と、`apply_map` の
 * 読み飛ばし(UNSETTABLE_FEATURES が増減しうる)。
 *
 * ```bash
 * CODEX_HOME=$(mktemp -d)
 * OPEN=(<OPEN_FEATURES の全名>)
 * UNSETTABLE=(<UNSETTABLE_FEATURES の全名>)
 * SKIP=" ${OPEN[*]} ${UNSETTABLE[*]} "
 * ARGS=(-c features.network_proxy=true)
 * while read -r name; do
 *   case "$SKIP" in *" $name "*) continue;; esac
 *   ARGS+=(-c "features.$name=false")
 * done < <(codex features list | awk '{print $1}')
 * ARGS+=(-c 'web_search="disabled"' -c tools.web_search=false -c project_doc_max_bytes=0)
 * codex features list "${ARGS[@]}" | awk '{print $1, $NF}'
 * ```
 */
const FEATURE_STATES = {
  apply_patch_freeform: "false",
  apply_patch_streaming_events: "false",
  apps: "false",
  apps_mcp_path_override: "false",
  artifact: "false",
  auth_elicitation: "false",
  browser_use: "false",
  browser_use_external: "false",
  browser_use_full_cdp_access: "false",
  chronicle: "false",
  code_mode: "false",
  code_mode_buffered_exec: "false",
  code_mode_host: "true",
  code_mode_only: "false",
  codex_git_commit: "false",
  collaboration_modes: "false",
  computer_use: "false",
  concurrent_reasoning_summaries: "false",
  current_time_reminder: "false",
  default_mode_request_user_input: "false",
  deferred_executor: "false",
  deferred_tool_world_state: "false",
  elevated_windows_sandbox: "false",
  enable_fanout: "false",
  enable_mcp_apps: "false",
  enable_request_compression: "true",
  exec_permission_approvals: "false",
  executed_tool_call_metadata: "false",
  executor_capability_discovery: "false",
  experimental_windows_sandbox: "false",
  external_agent_memory_import: "false",
  external_migration: "false",
  fast_mode: "false",
  goals: "false",
  guardian_approval: "false",
  guardianv2: "false",
  hooks: "true",
  image_detail_original: "false",
  image_generation: "false",
  image_resize_notice: "false",
  in_app_browser: "false",
  in_app_updates: "false",
  item_ids: "true",
  js_repl: "false",
  js_repl_tools_only: "false",
  local_thread_store_compression: "false",
  mcp_2026_07_28: "false",
  memories: "false",
  mentions_v2: "false",
  multi_agent: "true",
  multi_agent_mode: "false",
  multi_agent_v2: "false",
  network_proxy: "true",
  non_prefixed_mcp_tool_names: "false",
  personality: "false",
  plugin_hooks: "false",
  plugin_sharing: "false",
  plugins: "false",
  prevent_idle_sleep: "false",
  realtime_conversation: "false",
  recommended_plugins: "false",
  remote_compaction_v2: "true",
  remote_control: "false",
  remote_models: "false",
  remote_plugin: "false",
  request_permissions_tool: "false",
  request_rule: "false",
  resize_all_images: "true",
  respect_system_proxy: "false",
  responses_websockets: "false",
  responses_websockets_v2: "false",
  rollout_budget: "false",
  runtime_metrics: "false",
  search_tool: "false",
  secret_auth_storage: "false",
  shell_snapshot: "true",
  shell_tool: "true",
  shell_zsh_fork: "false",
  skill_env_var_dependency_prompt: "false",
  skill_mcp_dependency_install: "false",
  skill_search: "false",
  sqlite: "false",
  standalone_web_search: "false",
  steer: "false",
  terminal_resize_reflow: "true",
  terminal_visualization_instructions: "false",
  token_budget: "false",
  tool_call_mcp_elicitation: "false",
  tool_search: "false",
  tool_search_always_defer_mcp_tools: "true",
  tool_suggest: "false",
  tui_app_server: "true",
  unavailable_dummy_tools: "false",
  undo: "false",
  unified_exec: "true",
  unified_exec_zsh_fork: "false",
  use_agent_identity: "false",
  use_legacy_landlock: "false",
  use_linux_sandbox_bwrap: "false",
  view_image: "false",
  web_search_cached: "false",
  web_search_request: "false",
  workspace_dependencies: "false",
  workspace_owner_usage_nudge: "false",
} as const;
/** 型が縛るのは「開ける名前と `=false` が届かない名前だけが true」。採り直しで他の名前が転んでいれば、
 *  テストではなくコンパイルが先に落ちる。`& Record<string, …>` は featureDrift() が string で引くため。 */
export const CODEX_FEATURE_SNAPSHOT: Readonly<
  {
    [K in keyof typeof FEATURE_STATES]: K extends
      | (typeof OPEN_FEATURES)[number]
      | (typeof UNSETTABLE_FEATURES)[number]
      ? "true"
      : "false";
  } & Record<string, "true" | "false">
> = FEATURE_STATES;
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
  containers: ProcessContainers;
  boardState?: BoardStatePath[];
  /** ADR 0118: `spawn()` が失敗した pickup を受ける盤面側の一撃(`spawnFailureHandler` 製)。 */
  onSpawnFailed?: (taskId: string, failure: { error_code: string | null; message: string }) => void;
  /** ADR 0145: root process の exit を受ける盤面側の一撃。報告なき exit かどうかの判定は盤面側が持つ。 */
  onWorkerExited?: (taskId: string, exit: WorkerExit) => void;
}

/** Codex に登録された hook のうち、盤面が宣言と突き合わせる項目 —— ADR 0130 決定3 の4つ
 *  (event・matcher・enabled・source)に、#731 が `command` を足したもの。`trustStatus` は含めない
 *  —— session flags 由来の hook は常に `untrusted` で、走る前提は exec 側の bypass flag が持つ。 */
export interface CodexHookRegistration {
  event: string;
  matcher: string | null;
  enabled: boolean;
  source: string;
  command: string | null;
}

/** `hooks/list` の `result` から、登録と vendor 診断(`errors[]` / `warnings[]`、#734)を
 *  cwd を跨いで並びのまま取り出す(ADR 0130 決定3)。
 *  vendor の応答の形が変わったら、読み替えを直す場所はここ1つ —— 形の崩れは preflight の
 *  `hook mismatch` か、読めずに投げた `could not run` として出る(どちらも fail-closed)。 */
export function observedHooks(
  result: unknown,
): Pick<CodexCapabilityObservation, "hooks" | "hookDiagnostics"> {
  const { data } = result as {
    data: Array<{
      hooks: Array<Record<string, unknown>>;
      errors?: Array<{ message: string; path: string }>;
      warnings?: string[];
    }>;
  };
  return {
    hooks: data.flatMap((entry) => entry.hooks).map((hook) => ({
      event: hook.eventName as string,
      matcher: (hook.matcher ?? null) as string | null,
      enabled: hook.enabled as boolean,
      source: hook.source as string,
      command: (hook.command ?? null) as string | null,
    })),
    hookDiagnostics: data.flatMap((entry) => [
      // 診断は照合に使わない —— 欄が欠けても判定を変えないよう、無い形は空として読む
      ...(entry.errors ?? []).map((error) => `error: ${error.message} (${error.path})`),
      ...(entry.warnings ?? []).map((warning) => `warning: ${warning}`),
    ]),
  };
}

export interface CodexCapabilityObservation {
  cliVersion: string;
  skills: readonly string[];
  hooks: readonly CodexHookRegistration[];
  features: Readonly<Record<string, string>>;
  /** 盤面が `developer_instructions` で渡した marker のうち、developer item に載ったもの。 */
  developerMarkers: readonly string[];
  /** `hooks/list` の vendor 診断。照合には使わず、hook 不一致の理由文に写すだけ(#734)。 */
  hookDiagnostics: readonly string[];
}

/** 期待と観測の差だけを言う(全量は並べない —— 面の全行を並べた表は Quarantine 画面では読めない)。 */
function featureDrift(observed: Readonly<Record<string, string>>): string[] {
  const names = [...new Set([...Object.keys(CODEX_FEATURE_SNAPSHOT), ...Object.keys(observed)])].sort();
  return names
    .filter((name) => CODEX_FEATURE_SNAPSHOT[name] !== observed[name])
    .map((name) =>
      `${name} (expected ${CODEX_FEATURE_SNAPSHOT[name] ?? "absent"}, observed ${observed[name] ?? "absent"})`
    );
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
      // 盤面が Codex に登録されていることを要求する hook —— spawn が渡す宣言と同じ1つの形
      [
        "hook",
        [{ event: "preToolUse", matcher: BOARD_HOOK_MATCHER, enabled: true, source: "sessionFlags", command: hookPath }],
        observed.hooks,
      ],
      ["developer instructions", [CODEX_DEVELOPER_MARKER], observed.developerMarkers],
    ] as const
  ).find(([, expected, actual]) => JSON.stringify(expected) !== JSON.stringify(actual));
  if (mismatch) {
    return {
      available: false,
      reason:
        `Codex containment preflight ${mismatch[0]} mismatch: expected ` +
        `${JSON.stringify(mismatch[1])}, observed ${JSON.stringify(mismatch[2])}` +
        (mismatch[0] === "hook" && observed.hookDiagnostics.length > 0
          ? `; vendor diagnostics: ${observed.hookDiagnostics.join("; ")}`
          : ""),
    };
  }
  const drift = featureDrift(observed.features);
  return drift.length > 0
    ? { available: false, reason: `Codex containment preflight feature mismatch: ${drift.join(", ")}` }
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
    "Board verbs are main-thread only; if a subagent needs one, call it from the main thread. " +
    "Spawn subagents with fork_turns: \"none\"; this session keeps no rollout, so forking the parent thread's history always fails.\n\n" +
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
  allowedDomains: readonly string[],
): string[] {
  const name = taskType === "review" ? "tidepool-review" : "tidepool-work";
  const parent = taskType === "review" ? ":read-only" : ":workspace";
  const access = taskType === "review" ? "read" : "write";
  const dotGit = join(workspace, ".git");
  const filesystem = {
    ":root": "deny",
    ":minimal": "read",
    ":slash_tmp": "deny",
    ":workspace_roots": { ".": access },
    [workspace]: access,
    // issue #849: Linux の sandbox は書ける root 直下の .git を ro で重ねるので、書ける側は明示して書けるようにする。
    // hooks と config は Claude 側の床と同じく読むだけ(ADR 0033)。macOS ではこの入れ子の read が効かないが、
    // ネイティブ macOS は worker を拾わない(ADR 0100 決定6)ので床の問いは Linux にしか立たない(#860)
    ...(access === "write" && {
      [dotGit]: "write",
      [join(dotGit, "hooks")]: "read",
      [join(dotGit, "config")]: "read",
    }),
    [taskTemp]: "write",
    [dirname(process.execPath)]: "read",
    [dirname(executable)]: "read",
    "/Library/Developer/CommandLineTools/usr/bin": "read",
    "/System/Library/OpenSSL": "read",
  };
  const network = {
    enabled: true,
    // ADR 0072 決定1: workspace の allowed_domains。文法は registry が検証済み
    domains: Object.fromEntries([...allowedDomains, "127.0.0.1"].map((domain) => [domain, "allow"])),
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

/** 閉じる名前は導出する(ADR 0135 決定1): snapshot の全名 − 開ける名前 − `=false` が届かない名前。
 *  既定が false のものにも明示的に `=false` を渡す。開ける側を `-c` に書かないのは、それが版の宣言に
 *  当たるからである(ADR 0134 決定2)。 */
function closedSurfaceConfig(): string[] {
  const stays = new Set<string>([...OPEN_FEATURES, ...UNSETTABLE_FEATURES]);
  return [
    "features.network_proxy=true",
    ...Object.keys(CODEX_FEATURE_SNAPSHOT)
      .filter((name) => !stays.has(name))
      .map((name) => `features.${name}=false`),
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

/** worker の spawn に渡す設定の組み立て。preflight は同じここから placeholder で組み、
 *  `--strict-config` の app-server に読ませる(ADR 0142 決定2)。 */
function spawnConfig(input: {
  taskType: Task["type"];
  effort: string;
  developerInstructions: string;
  mcpUrl: string;
  enabledTools: readonly string[];
  workspace: string;
  allowedDomains: readonly string[];
  taskTemp: string;
  executable: string;
  codexHome: string;
  hook: string;
}): string[] {
  return [
    `model_reasoning_effort=${toml(input.effort)}`,
    `developer_instructions=${toml(input.developerInstructions)}`,
    ...permissionConfig(input.taskType, input.workspace, input.taskTemp, input.executable, input.allowedDomains),
    ...closedSurfaceConfig(),
    'forced_login_method="chatgpt"',
    `mcp_servers.tidepool.url=${toml(input.mcpUrl)}`,
    `mcp_servers.tidepool.enabled_tools=${toml(input.enabledTools)}`,
    "mcp_servers.tidepool.required=true",
    // ADR 0129 決定1: 答える人の居ない exec では承認の問いは Cancel にしかならない。verb の権限は盤面側が縛る
    'mcp_servers.tidepool.default_tools_approval_mode="approve"',
    // ADR 0134 決定3: この key は版に依らず効く —— 絞るのではなく本数の意味を固定する
    "agents.max_concurrent_threads_per_session=3",
    skillConfig(input.codexHome, input.workspace),
    ...hookConfig(input.hook),
  ];
}

function configArgs(config: readonly string[]): string[] {
  return config.flatMap((entry) => ["-c", entry]);
}

// 封じ込め能力 preflight の上限。失敗側が tool-surface probe と同じ封じ込め能力の不成立
// なので値も同じにする。
const CODEX_PREFLIGHT_LIMIT_MS = 60_000;
const PREFLIGHT_KIND = "Codex containment preflight";

/** preflight の1回を Board call の口に通す(ADR 0136 決定2)。workspace を cwd にする
 *  呼び出し(`cwd` を渡すのはそれだけ)は回収済み観測のあとに返す —— 残存がその workspace で
 *  次に起きる worker と同居しない(決定5)。 */
async function runFile(
  call: BoardCall,
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  const output = await call(
    {
      kind: PREFLIGHT_KIND,
      command,
      args: [...args],
      cwd: options.cwd ?? process.cwd(),
      env: options.env,
      limitMs: CODEX_PREFLIGHT_LIMIT_MS,
      awaitReclaimed: options.cwd !== undefined,
    },
    readOutput,
  );
  if (!output) throw new Error(`${command} ${args[0]} did not complete (limit, spawn failure, or no container)`);
  if (output.exitCode !== 0) {
    throw new Error(`${command} ${args[0]} exited ${output.exitCode}${output.stderr ? `: ${output.stderr.trim()}` : ""}`);
  }
  return output.stdout;
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

export function observedSkills(promptInput: string): string[] {
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
 *  `hooks/list` で読む(ADR 0130 決定3)。
 *
 *  これは**登録**の観測であって**選択**の観測ではない。matcher が実物の呼び出しを選ぶことは
 *  開けた走行でしか観測できず、その受け入れは #730 が持つ。この行を「選択も見ている」と
 *  読んで #730 の受け入れ観測を省いてはならない。
 *
 *  同じ起動で spawn の設定を `--strict-config` で読ませ、review 種別は initialize だけの
 *  起動をもう1本足す —— 綴りの誤りはここで throw になる(ADR 0142 決定4)。 */
async function probeHookRegistration(
  call: BoardCall,
  executable: string,
  env: NodeJS.ProcessEnv,
  config: (taskType: Task["type"]) => string[],
): Promise<ReturnType<typeof observedHooks>> {
  const command = codexCommandThrough(call, PREFLIGHT_KIND, CODEX_PREFLIGHT_LIMIT_MS);
  // ADR 0142 決定4: 未知キーはここで app-server の失敗として投げ、`could not run` に倒れる
  const [listed] = await callAppServer(command, executable, env, ["--strict-config", ...configArgs(config("work"))], [
    { method: "hooks/list", params: { cwds: [] } },
  ]);
  await callAppServer(command, executable, env, ["--strict-config", ...configArgs(config("review"))], []);
  return observedHooks(listed);
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
  call: BoardCall,
  executable: string,
  workspace: string,
  taskTemp: string,
  taskType: "work" | "review",
  env: NodeJS.ProcessEnv,
  allowedDomains: readonly string[],
): Promise<void> {
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "tidepool-codex-outside-")));
  const outside = join(outsideDir, "secret");
  const canary = join(taskTemp, `${taskType}-permission-canary.cjs`);
  writeFileSync(outside, "must remain unreadable");
  writeFileSync(canary, PERMISSION_CANARY);
  try {
    await runFile(
      call,
      executable,
      [
        "sandbox",
        "-P", `tidepool-${taskType}`,
        "-C", workspace,
        ...configArgs(permissionConfig(taskType, workspace, taskTemp, executable, allowedDomains)),
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
  allowedDomains: readonly string[];
  call: BoardCall;
}): Promise<CodexCapabilityObservation> {
  const { call } = options;
  const taskTemp = realpathSync(mkdtempSync(join(tmpdir(), "tidepool-codex-preflight-")));
  const workspace = realpathSync(options.workspace);
  const env = workerEnv(options.executable, options.codexHome, taskTemp, "tidepool");
  const config = [
    ...closedSurfaceConfig(),
    skillConfig(options.codexHome, workspace),
  ];
  try {
    const cliVersion = (await runFile(call, options.executable, ["--version"], { env })).trim();
    const promptInput = await runFile(
      call,
      options.executable,
      // marker は prompt-input にだけ渡す —— 実測したのはこの面だけ(ADR 0124 の測定)
      ["debug", "prompt-input", ...configArgs([...config, `developer_instructions=${toml(CODEX_DEVELOPER_MARKER)}`]), "containment canary"],
      { cwd: workspace, env },
    );
    const features = await runFile(
      call,
      options.executable,
      ["features", "list", ...configArgs(config)],
      { cwd: workspace, env },
    );
    // 先頭 field が name、末尾 field が state。stage 列は空白を含みうる(under development)ので数えない。
    const observedFeatures = Object.fromEntries(
      features.trim().split("\n").map((line) => {
        const fields = line.trim().split(/\s+/);
        return [fields[0] ?? "", fields.at(-1) ?? ""] as const;
      }),
    );
    await probePermission(call, options.executable, workspace, taskTemp, "work", env, options.allowedDomains);
    await probePermission(call, options.executable, workspace, taskTemp, "review", env, options.allowedDomains);
    const hook = installBoardHook(options.codexHome);
    return {
      cliVersion,
      skills: observedSkills(promptInput),
      developerMarkers: observedDeveloperMarkers(promptInput),
      ...await probeHookRegistration(call, options.executable, env, (taskType) =>
        // 問うのは parse だけ —— 値は形の正しい placeholder(ADR 0142 決定2)
        spawnConfig({
          taskType,
          effort: "high",
          developerInstructions: CODEX_DEVELOPER_MARKER,
          mcpUrl: "http://127.0.0.1/mcp",
          enabledTools: BOARD_VERBS,
          workspace,
          allowedDomains: options.allowedDomains,
          taskTemp,
          executable: options.executable,
          codexHome: options.codexHome,
          hook,
        })),
      features: observedFeatures,
    };
  } finally {
    rmSync(taskTemp, { recursive: true, force: true });
  }
}

export function createCodexCapabilityCheck(options: {
  executable: string;
  codexHome: string;
  workspace: string;
  allowedDomains: readonly string[];
  call: BoardCall;
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
  private readonly containers: ProcessContainers;
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

  start(task: Task, setting: ExecutionSetting): void {
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
    if (setting.provider !== "openai") {
      throw new Error(`CodexWorker refuses provider ${setting.provider}; no Harness fallback (ADR 0098)`);
    }
    const taskTemp = realpathSync(mkdtempSync(join(tmpdir(), `tidepool-codex-${task.id}-`)));
    const hook = installBoardHook(this.options.codexHome);
    const taskMcpUrl = new URL(this.options.mcpUrl);
    taskMcpUrl.searchParams.set("task", task.id);
    const memory = buildMemoryInjection(this.options.db, task, workspace.name, agent.name);
    const config = spawnConfig({
      taskType: task.type,
      effort: setting.effort,
      developerInstructions: developerInstructions(memory.section, agent.definition.systemPrompt, agent.profile.guidance),
      mcpUrl: taskMcpUrl.toString(),
      // ADR 0122 決定2: MCP の登録と同じ差を写す。宣言と盤面の面が集合として一致することは
      // tests/codex-worker.test.ts が固定する(ADR 0125 決定2)
      enabledTools: isMetaReviewOf(this.options.db, task.id, "memory")
        ? [...BOARD_VERBS.filter((verb) => !(WORKER_MEMORY_VERBS as readonly string[]).includes(verb)), ...MEMORY_META_REVIEW_VERBS]
        : BOARD_VERBS,
      workspace: workspace.path,
      allowedDomains: workspace.allowed_domains ?? [],
      taskTemp,
      executable: this.options.executable,
      codexHome: this.options.codexHome,
      hook,
    });
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
      this.options.onWorkerExited?.(task.id, { exit_code: code, signal, stderr_tail: tail });
    });
  }

  /** Codex folds up on SIGINT; force/reclaimed belong to ProcessContainers. */
  gracefulStop(taskId: string): void {
    this.running.get(taskId)?.kill("SIGINT");
  }

  async checkUsage(): Promise<string | null> {
    return null;
  }
}
