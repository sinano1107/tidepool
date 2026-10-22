import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { resolveAgentOrQuarantine, resolveExecutionAgent } from "./agent.js";
import { type BoardCall, readOutput } from "./board-call.js";
import { boardDoctrine, boardProse } from "./board-prose.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import { readLines, readStderrTail, settleOnOutputClose } from "./child-stream.js";
import { agentGitIdentityEnv } from "./claude-worker.js";
import type { Clock } from "./clock.js";
import {
  CODEX_APP_SERVER_VERSION,
  type CodexAppServerProbe,
  type CodexCliCommand,
  callAppServer,
  codexCommandThrough,
} from "./codex-app-server.js";
import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { DEFAULT_AUDITOR_NAME, DEFAULT_INTERVIEWER_NAME } from "./defaults.js";
import { appendEvent, type EventPayload, type ResourceStop, type TokenUsage } from "./events.js";
import type { ExecutionSetting } from "./execution-setting.js";
import { git } from "./git.js";
import type { CodexWorkspaceCheck } from "./harness-containment.js";
import {
  buildMemoryInjection,
  buildMetaReviewMaterial,
  type InjectionQuery,
  memoryPromptSection,
  memoryRepairVerbs,
  recordMemoryInjection,
  recordMetaReviewMaterial,
} from "./memory.js";
import { META_REVIEW_SUBJECTS, WORKER_MEMORY_VERBS } from "./meta-review.js";
import { projectWhenTranscriptCloses } from "./precedent.js";
import type { ContainerSpawn, ProcessContainers } from "./process-container.js";
import { registerQuarantine, workspaceContainmentValue } from "./quarantine.js";
import { loadRegistry, type RegistrySource } from "./registry.js";
import { routingRepairVerbs } from "./routing-review.js";


import { carriesReadOnly, isSubjectReaderRca, metaReviewSubjectOf, type PickupStopped, resolveTaskAgent, type Task, type TaskVerbSwap, taskVerbSwap } from "./tasks.js";


import { tierNames } from "./tier.js";
import { RecordContainerError, type TranscriptStore } from "./transcript-store.js";
import { RECLAIM_TIMEOUT } from "./watchdog.js";
import type { WorkerAdapter, WorkerExit } from "./worker.js";
import {
  quarantineWorkspace,
  resolveExecutionWorkspace,
  resolveOrQuarantine,
  resolveWorkspacesBaseDir,
  taskRunPlace,
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
  // code mode の session provider —— gpt-5.6 系は metadata が code_mode_only で、runtime も code mode で走る
  // (`code_mode=false` でも、#762 で観測)。閉じると Direct への fallback が無い
  "code_mode_host",
  // 閉じると ShellCommand へ降格するだけ —— 必須機能の実装の切り替え(ADR 0135 決定2)
  "unified_exec",
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
 * CODEX_HOME が新規の空でもログイン済みでも同一(auth 非依存)。`skills.config` の有無でも同一なので
 * 採取時は付けていない(probe は付ける)。`-c` は closedSurfaceConfig() と同じ導出 —— どちらかを
 * 動かしたらこの定数も動く。
 *
 * pin を上げるときは、採り直しに加えて vendor source を読み直す: model metadata の最悪値読み(ADR 0255 決定3)と、
 * `apply_map` の読み飛ばし(ADR 0135 決定4。UNSETTABLE_FEATURES が増減しうる)。手順は
 * docs/codex-cli-version-bump.md の「Re-read the Codex source」の段。
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
  agent_message_board: "false",
  analytics_plan_history: "false",
  api_key_cyber_access_programs: "false",
  api_key_model_discovery: "false",
  apply_patch_freeform: "false",
  apply_patch_preserve_line_endings: "false",
  apply_patch_streaming_events: "false",
  apps: "false",
  apps_mcp_path_override: "false",
  artifact: "false",
  async_compaction: "false",
  auth_elicitation: "false",
  background_paginated_rollout_migration: "false",
  bedrock_setup_wizard: "false",
  browser_annotation_api: "false",
  browser_use: "false",
  browser_use_external: "false",
  browser_use_full_cdp_access: "false",
  chronicle: "false",
  cli_daybreak: "false",
  code_mode: "false",
  code_mode_buffered_exec: "false",
  code_mode_host: "true",
  code_mode_host_grpc: "false",
  code_mode_interrupt: "false",
  code_mode_only: "false",
  code_mode_only_strict_3p_tools: "false",
  code_mode_prewarm: "false",
  code_mode_tool_description_first: "false",
  code_mode_tool_search: "false",
  codex_apps_mcp_2026_07_28: "false",
  codex_git_commit: "false",
  collaboration_modes: "false",
  compaction_image_budget: "false",
  computer_use: "false",
  concurrent_reasoning_summaries: "false",
  content_item_kinds: "false",
  context_management: "false",
  credential_masking: "false",
  current_time_reminder: "false",
  cwd_relative_turn_diffs: "false",
  daemon_auto_start: "false",
  default_mode_request_user_input: "false",
  defer_mailbox_preemption: "false",
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
  guardian_conversation_history_tools: "false",
  guardian_enhanced_node_repl_transcripts: "false",
  guardian_ext: "false",
  guardian_node_repl_transcript_images: "false",
  guardian_reuse_parent_compaction: "false",
  guardian_root_handoff_context: "false",
  guardian_trust_orchestrator_connectors: "false",
  guardianv2: "false",
  "guardianv2.thread_context": "false",
  guardianv2_decisions_comparison: "false",
  hooks: "true",
  image_detail_original: "false",
  image_generation: "false",
  image_resize_notice: "false",
  in_app_browser: "false",
  in_app_chat: "false",
  in_app_dictation: "false",
  in_app_local_automation: "false",
  in_app_updates: "false",
  in_app_voice: "false",
  incremental_tools: "false",
  instant_interrupt: "false",
  item_ids: "true",
  js_repl: "false",
  js_repl_tools_only: "false",
  local_thread_store_compression: "false",
  local_thread_store_shared_compression: "false",
  login_shell_package_path: "false",
  mcp_2026_07_28: "false",
  mcp_oauth_refresh_coordination: "false",
  memories: "false",
  mentions_v2: "false",
  model_catalog_in_context: "false",
  multi_agent: "true",
  multi_agent_mode: "false",
  multi_agent_v2: "false",
  multi_agent_v2_dynamic_tools: "false",
  network_proxy: "true",
  non_prefixed_mcp_tool_names: "false",
  nonfatal_clock_read_errors: "false",
  omit_app_server_notification_media: "false",
  output_token_replay: "false",
  personality: "false",
  plugin_hooks: "false",
  plugin_sharing: "false",
  plugins: "false",
  powershell_shell_version: "false",
  prefer_mxc: "false",
  prevent_idle_sleep: "false",
  psp: "false",
  realtime_conversation: "false",
  reasoning_effort_override: "false",
  recommended_plugins: "false",
  remote_compaction_v2: "false",
  remote_control: "false",
  remote_models: "false",
  remote_plugin: "false",
  request_permissions_tool: "false",
  request_rule: "false",
  resize_all_images: "true",
  respect_system_proxy: "false",
  responses_websockets: "false",
  responses_websockets_v2: "false",
  retain_client_developer_messages: "false",
  retain_client_tool_outputs: "false",
  rollout_budget: "false",
  runtime_metrics: "false",
  search_tool: "false",
  secret_auth_storage: "false",
  send_async_message: "false",
  send_message_to_user_async: "false",
  shell_snapshot: "true",
  shell_snapshot_v2: "false",
  shell_tool: "true",
  shell_zsh_fork: "false",
  skill_env_var_dependency_prompt: "false",
  skill_mcp_dependency_install: "false",
  skill_search: "false",
  skip_host_skill_discovery: "false",
  sleep_tool: "false",
  sqlite: "false",
  stable_environment_tools: "false",
  standalone_web_search: "false",
  steer: "false",
  step_model_switching: "false",
  subagent_default_context_limits: "false",
  system_proxy_fallback: "false",
  terminal_resize_reflow: "true",
  terminal_visualization_instructions: "false",
  token_budget: "false",
  tool_call_mcp_elicitation: "false",
  tool_search: "false",
  tool_search_always_defer_mcp_tools: "true",
  tool_suggest: "false",
  transcript_v2: "false",
  tui_app_server: "true",
  ultrafast_mode: "false",
  unavailable_dummy_tools: "false",
  unbounded_connection_retries: "false",
  undo: "false",
  unified_exec: "true",
  unified_exec_tty: "false",
  unified_exec_zsh_fork: "false",
  unified_image_budget: "false",
  use_agent_identity: "false",
  use_legacy_landlock: "false",
  use_linux_sandbox_bwrap: "false",
  use_xaa: "false",
  view_image: "false",
  web_search_cached: "false",
  web_search_request: "false",
  windows_sandbox_service: "false",
  workspace_dependencies: "false",
  workspace_owner_usage_nudge: "false",
  worktrees: "false",
  write_stdin_approval: "false",
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
  /** ADR 0201 決定2: root の exit から出力の読み切りを待つ上限。watchdog の回収 timeout と同じ値を
   *  盤面が渡す(新しい設定値ではない)。不在は watchdog と同じ既定。 */
  reclaimTimeout?: number;
  registry: RegistrySource;
  agent: string;
  auditorName?: string;
  interviewerName?: string;
  workspace: string;
  workspacesDir?: string;
  mcpUrl: string;
  /** ADR 0149: session ごとの transcript を開く盤面側の器。`containers` と同じく省略できない。 */
  transcripts: TranscriptStore;
  /** Board-owned shared ChatGPT login/cache, isolated from the operator's Codex config. */
  codexHome: string;
  /** Version already established by the Harness preflight; production pins `CODEX_CLI_VERSION`. */
  cliVersion: string;
  /** Absolute executable established by the same preflight; spawn never relies on PATH. */
  executable: string;
  /** Board-owned worker-session container supervisor (ADR 0099). */
  containers: ProcessContainers;
  /** ADR 0259 決定2・3: 起動時の skill の列挙と観測が通る Board call の口。 */
  boardCall: BoardCall;
  boardState?: BoardStatePath[];
  /** ADR 0118: `spawn()` が失敗した pickup を受ける盤面側の一撃(`spawnFailureHandler` 製)。 */
  onSpawnFailed?: (taskId: string, failure: { error_code: string | null; message: string }) => void;
  /** ADR 0266 決定4: transcript の open が記録の器に書けなかった pickup を受ける盤面側の一撃(`recordContainerHaltHandler` 製)。 */
  onRecordContainerFailed?: (taskId: string, err: RecordContainerError) => void;
  /** ADR 0274: 資源の Quarantine が spawn の前に pickup を止めた —— 盤面側の一撃(`queueReturnHandler` 製)が先頭へ戻す。 */
  onPickupStopped?: (taskId: string, payload: PickupStopped) => void;
  /** ADR 0145: root process の exit を受ける盤面側の一撃。報告なき exit かどうかの判定は盤面側が持つ。 */
  onWorkerExited?: (taskId: string, exit: WorkerExit) => void;
  /** ADR 0261 決定1・4: `turn.failed` の行を見た exit の直後に読み直す使用量の口(盤面の `openaiUsage` と同じ probe)。
   *  分類にだけ使い、Throttle の状態には書かない。 */
  usageProbe?: CodexAppServerProbe;
  /** ADR 0261 決定3: 上限到達による中断の盤面側の一撃(`capInterruptionHandler` 製)。Claude と同じく exit より先に撃つ。 */
  onCapInterrupted?: (taskId: string, reclaimed: Promise<void>) => void;
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
 *  `hook mismatch` か、読めずに投げた `failed` として出る(どちらも fail-closed)。 */
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

// cwd ごとの entry の `errors[]` は読まない —— 読めなかった skill は返らないので、閉じる対象にも観測にも現れない。
// これは版に従属する前提(#1972 が 0.147.0 で実測)で、版上げの適合試験の skill の閉鎖の行が確かめる(#1940)
const skillsListResponse = z.object({
  data: z.array(
    z.object({
      cwd: z.string(),
      skills: z.array(z.object({ name: z.string(), path: z.string(), enabled: z.boolean() })),
    }),
  ),
});

/** 要求した cwd ごとの entry の skill。形が崩れた応答も、要求した cwd の entry が無い応答も投げる —— 空の応答を
 *  「skill 無し」と読んで閉じたことにしない。どちらも列挙・観測の失敗として spawn_failed に倒れる(ADR 0259 決定6)。 */
function skillsAt(result: unknown, cwds: readonly string[]) {
  const { data } = skillsListResponse.parse(result);
  return cwds.flatMap((cwd) => {
    const entry = data.find((candidate) => candidate.cwd === cwd);
    if (!entry) throw new Error(`skills/list returned no entry for ${cwd}`);
    return entry.skills;
  });
}

/** `skills/list` の `result` から、返った skill の path を cwd を跨いで重ねずに取り出す(ADR 0259 決定2)。scope は見ない。 */
export function listedSkillPaths(result: unknown, cwds: readonly string[]): string[] {
  return [...new Set(skillsAt(result, cwds).map((skill) => skill.path))];
}

/** 閉じた設定を当てた `skills/list` の `result` から、まだ有効と報告された skill を `name (path)` で拾う(ADR 0259 決定3)。 */
export function enabledSkills(result: unknown, cwds: readonly string[]): string[] {
  return skillsAt(result, cwds).filter((skill) => skill.enabled).map((skill) => `${skill.name} (${skill.path})`);
}

export interface CodexCapabilityObservation {
  cliVersion: string;
  skills: readonly string[];
  hooks: readonly CodexHookRegistration[];
  features: Readonly<Record<string, string>>;
  /** 盤面が `developer_instructions` で渡した marker のうち、developer item に載ったもの。 */
  developerMarkers: readonly string[];
  /** user item に載った AGENTS.md の層。盤面は何も置かないので空が期待値(ADR 0148)。 */
  agentsMdLayer: readonly string[];
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

/** Version pin + measured #195 surface contract. Any drift closes Codex only.
 *  `pinnedVersion` は version 行の差し替え口で、渡すのは版上げの適合試験だけ(#1385)。 */
export async function checkCodexCapability(
  probe: CodexCapabilityProbe,
  hookPath: string,
  pinnedVersion = CODEX_CLI_VERSION,
): Promise<ContainmentCapability> {
  let observed: CodexCapabilityObservation;
  try {
    observed = await probe();
  } catch (error) {
    return { available: false, reason: `Codex containment preflight failed: ${String(error)}` };
  }
  const mismatch = (
    [
      ["version", [pinnedVersion], [observed.cliVersion]],
      ["skill", [], observed.skills],
      // 盤面が Codex に登録されていることを要求する hook —— spawn が渡す宣言と同じ1つの形
      [
        "hook",
        [{ event: "preToolUse", matcher: BOARD_HOOK_MATCHER, enabled: true, source: "sessionFlags", command: hookPath }],
        observed.hooks,
      ],
      ["developer instructions", [CODEX_DEVELOPER_MARKER], observed.developerMarkers],
      ["agents.md", [], observed.agentsMdLayer],
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

/** ADR 0157 決定2・3: Codex の委譲先は subagent。Workflow tool に当たる機構は無いので禁止の段落は出さない。
 *  最終段落に続く `fork_turns` の1文は Codex 固有の追記(ADR 0134 決定4)。`verbs` は task ごとの verb の差し替え(ADR 0247 決定3 / ADR 0253 決定5)。 */
function codexDoctrine(verbs: TaskVerbSwap): string {
  return `${boardDoctrine({ delegate: "a subagent", workflow: false }, verbs)} ` +
    "Spawn subagents with fork_turns: \"none\"; this session keeps no rollout, so forking the parent thread's history always fails.";
}

/** user turn に残るのは、その task に固有の指示だけ(ADR 0124 決定1)。 */
function taskPrompt(task: Task): string {
  return `First call get_current_task for task ${task.id}, then complete this task: ${task.title}\n\n` +
    `Purpose: ${task.purpose}\nCompletion criteria: ${task.completion_criteria}`;
}

export function permissionConfig(
  taskType: Task["type"],
  workspace: string,
  taskTemp: string,
  executable: string,
  allowedDomains: readonly string[],
  /** ADR 0273 決定2: cwd の外で読みだけ開ける checkout —— interview の root の実環境と開ける面接室。 */
  readPaths: readonly string[] = [],
): string[] {
  const review = carriesReadOnly(taskType);
  const name = review ? "tidepool-review" : "tidepool-work";
  const parent = review ? ":read-only" : ":workspace";
  const access = review ? "read" : "write";
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
    ...Object.fromEntries(readPaths.map((path) => [path, "read"])),
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

/** 許可ドメインへの egress を濾す proxy を起こす1行。これが無いと permission profile の network は何も解決しない
 *  (0.163.0 で実測、#696)。worker の spawn と、それを写す試験(適合試験の到達の行・面接室 canary)が同じここから取る。 */
export const NETWORK_PROXY_CONFIG = "features.network_proxy=true";
/** 閉じる名前は導出する(ADR 0135 決定1): snapshot の全名 − 開ける名前 − `=false` が届かない名前。
 *  既定が false のものにも明示的に `=false` を渡す。開ける側を `-c` に書かないのは、それが版の宣言に
 *  当たるからである(ADR 0134 決定2)。 */
export function closedSurfaceConfig(): string[] {
  const stays = new Set<string>([...OPEN_FEATURES, ...UNSETTABLE_FEATURES]);
  return [
    NETWORK_PROXY_CONFIG,
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

/** ChatGPT 認証だけを使う(ADR 0098 決定3)。spawn と、版上げの適合試験の skill の閉鎖の行の exec が読む。 */
export const FORCED_LOGIN_METHOD = 'forced_login_method="chatgpt"';

/** worker の `codex exec` の flag のうち hook に依らないもの。spawn と、版上げの適合試験の skill の閉鎖の行の exec が読む。 */
export const WORKER_EXEC_FLAGS = ["--ephemeral", "--ignore-user-config", "--ignore-rules", "--strict-config"] as const;

/** 列挙した path をすべて閉じる `skills.config`(ADR 0259 決定2)。scope は問わない。 */
function closedSkillsConfig(paths: readonly string[]): string {
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
  /** ADR 0273 決定2: interview の root が読みだけ開ける checkout。 */
  readPaths?: readonly string[];
  taskTemp: string;
  executable: string;
  /** `closedSkillsConfig()` の1行 —— Codex 自身の列挙から作る(ADR 0259 決定2)。 */
  skills: string;
  hook: string;
}): string[] {
  return [
    `model_reasoning_effort=${toml(input.effort)}`,
    `developer_instructions=${toml(input.developerInstructions)}`,
    ...permissionConfig(input.taskType, input.workspace, input.taskTemp, input.executable, input.allowedDomains, input.readPaths),
    ...closedSurfaceConfig(),
    FORCED_LOGIN_METHOD,
    `mcp_servers.tidepool.url=${toml(input.mcpUrl)}`,
    `mcp_servers.tidepool.enabled_tools=${toml(input.enabledTools)}`,
    "mcp_servers.tidepool.required=true",
    // ADR 0129 決定1: 答える人の居ない exec では承認の問いは Cancel にしかならない。verb の権限は盤面側が縛る
    'mcp_servers.tidepool.default_tools_approval_mode="approve"',
    // ADR 0134 決定3: この key は版に依らず効く —— 絞るのではなく本数の意味を固定する
    "agents.max_concurrent_threads_per_session=3",
    input.skills,
    ...hookConfig(input.hook),
  ];
}

export function configArgs(config: readonly string[]): string[] {
  return config.flatMap((entry) => ["-c", entry]);
}

// 封じ込め能力 preflight の上限。失敗側が tool-surface probe と同じ封じ込め能力の不成立
// なので値も同じにする。
const CODEX_PREFLIGHT_LIMIT_MS = 60_000;
const PREFLIGHT_KIND = "Codex containment preflight";

/** preflight の1回を Board call の口に通す(ADR 0136 決定2)。cwd は検査ごとの使い捨てのディレクトリで、
 *  workspace の checkout ではない(ADR 0259 決定4)ので、回収済み観測は待たない(ADR 0136 決定5)。 */
async function runFile(
  call: BoardCall,
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  const output = await call(
    {
      kind: PREFLIGHT_KIND,
      harness: "codex",
      command,
      args: [...args],
      cwd: options.cwd,
      env: options.env,
      limitMs: CODEX_PREFLIGHT_LIMIT_MS,
    },
    readOutput,
  );
  if (!output) throw new Error(`${command} ${args[0]} did not complete (limit, spawn failure, or no container)`);
  if (output.exitCode !== 0) {
    throw new Error(`${command} ${args[0]} exited ${output.exitCode}${output.stderr ? `: ${output.stderr.trim()}` : ""}`);
  }
  return output.stdout;
}

/** `cwds` には workspace の実体の path を、キャッシュは使わずに読み直す(ADR 0259 決定2)。 */
function skillsListRequest(workspace: string) {
  return { method: "skills/list", params: { cwds: [workspace], forceReload: true } };
}

/** workspace の skill を Codex 自身に列挙させ、返った path をすべて閉じる1行を返す(ADR 0259 決定2)。
 *  app-server は `command` が空の新しい cwd で起こす(ADR 0206)。失敗は投げる(決定6)。 */
async function enumerateSkills(
  command: CodexCliCommand,
  executable: string,
  env: NodeJS.ProcessEnv,
  workspace: string,
): Promise<string> {
  const [listed] = await callAppServer(command, executable, env, [], [skillsListRequest(workspace)]);
  return closedSkillsConfig(listedSkillPaths(listed, [workspace]));
}

/** 列挙・観測そのものの失敗の文面(ADR 0259 決定6)。worker の起動の spawn_failed と回答時の拒否が同じ文で言う。 */
const SKILL_CHECK_FAILED =
  "Codex skills/list failed while the board enumerated or observed this workspace's skills, " +
  "so it could not decide or confirm which skills are closed";

/** (codex, workspace) の組の検査(ADR 0259 決定1・3・5): 列挙した skill を閉じた spawn の設定を `--strict-config` で
 *  当てた `skills/list` が、すべて `enabled: false` と答えるか。worker の起動は本文だけ marker の spawn の設定(ADR 0259 追記)で、回答時の検査は
 *  placeholder の設定で、版上げの適合試験の skill の閉鎖の行(#1940)は観測の生の result ごと、同じこれを撃つ。
 *  列挙・観測そのものの失敗は投げる(決定6)。 */
export async function codexWorkspaceContainment(options: {
  call: BoardCall;
  executable: string;
  env: NodeJS.ProcessEnv;
  /** 実体の path(realpath 済み)。 */
  workspace: string;
  config: (skills: string) => string[];
}): Promise<{ skills: string; capability: ContainmentCapability; observed: unknown }> {
  const through = (kind: string) => codexCommandThrough(options.call, kind, CODEX_PREFLIGHT_LIMIT_MS);
  const skills = await enumerateSkills(through("Codex skill enumeration"), options.executable, options.env, options.workspace);
  const config = options.config(skills);
  const [observed] = await callAppServer(
    through("Codex skill observation"),
    options.executable,
    options.env,
    ["--strict-config", ...configArgs(config)],
    [skillsListRequest(options.workspace)],
  );
  const enabled = enabledSkills(observed, [options.workspace]);
  return {
    skills,
    observed,
    capability: enabled.length === 0
      ? { available: true }
      : {
          available: false,
          reason:
            `Under the board's closed skills.config, Codex still reports these skills enabled: ${enabled.join(", ")}. ` +
            "The board disabled every skill path that skills/list returned for this workspace, so it cannot close " +
            "these itself — find where Codex loads them from and remove or disable them there",
        },
  };
}

/** Resolve once at composition time. Worker spawn uses the returned absolute path,
 * so a narrower child PATH cannot turn an observed CLI into ENOENT.
 * 見つかった場合に返すのは symlink を解いた実体のパス —— sandbox が exec するのは実体なので、
 * `permissionConfig()` が read を与える `dirname()` も実体側でなければ届かない(issue #646)。 */
export function resolveCodexExecutable(searchPath = process.env.PATH ?? ""): { executable: string; onPath: boolean } {
  const directories = searchPath.split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = resolve(directory, "codex");
    try {
      accessSync(candidate, fsConstants.X_OK);
      return { executable: realpathSync(candidate), onPath: true };
    } catch {
      // Keep searching the declared PATH.
    }
  }
  // Preserve the absolute-path invariant even when absent. `onPath: false` makes
  // the preflight name the absence instead of this synthetic path (#683).
  return { executable: resolve(directories[0] ?? "/usr/local/bin", "codex"), onPath: false };
}

/** `codex debug prompt-input` の出力から、`<skills_instructions>` の `### Available skills` に
 *  載った skill 名を集める。節が無ければ `[]` —— 期待値も `[]` なので、パースの静かな失敗は
 *  skill を有効にした実物 fixture のテストだけが捕まえる(issue #699)。 */
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

/** ADR 0148 決定2: `codex debug prompt-input` の出力から、**user role の item に属する
 *  AGENTS.md の層**(`# AGENTS.md instructions` で始まる part)を集める。global の形も
 *  project の形(`… for <path>`)も同じ接頭辞なので、ファイル名を知らずに層ごと捕まえる。
 *  写すのは見出し行だけ —— 本文は Quarantine の理由文では読めず、出どころは見出しで足りる。 */
export function observedAgentsMdLayer(promptInput: string): string[] {
  const messages = JSON.parse(promptInput) as Array<{
    role?: string;
    content?: Array<{ text?: string }>;
  }>;
  return messages
    .filter((message) => message.role === "user")
    .flatMap((message) => message.content ?? [])
    .map((part) => part.text ?? "")
    .filter((text) => text.startsWith("# AGENTS.md instructions"))
    .map((text) => text.split("\n", 1)[0]!);
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
  // ADR 0142 決定4: 未知キーはここで app-server の失敗として投げ、`failed` に倒れる
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
const [workspace, taskTemp, outside, homeOutside, access] = process.argv.slice(2);
const workspaceFile = workspace + "/.tidepool-codex-permission-canary";
const taskFile = taskTemp + "/task-canary";
// 検査の失敗は理由を1行 stderr に書いてから落ちる —— 番号の意味を言うのはこの文だけ (#710)。
// 37 だけは外側 catch で例外本体を出す。macOS の pipe では console.error が非同期なので同期で書く
const fail = (code, why) => {
  fs.writeSync(2, why + "\\n");
  process.exit(code);
};
try {
  // 読めることの証明は listing が throw しないことだけ —— workspace の中身に前提を置かない (#708)
  fs.readdirSync(workspace);
  for (const [path, code] of [[outside, 32], [homeOutside, 40]]) {
    try { fs.readFileSync(path, "utf8"); } catch { continue; }
    fail(code, "canary could read a file outside the workspace: " + path);
  }
  if (access === "write") {
    fs.writeFileSync(workspaceFile, "ok");
    fs.unlinkSync(workspaceFile);
  } else {
    try {
      fs.writeFileSync(workspaceFile, "breach");
      fail(33, "review profile could write to the workspace");
    } catch {}
  }
  fs.writeFileSync(taskFile, "ok");
  if (cp.spawnSync(process.execPath, ["-e", "process.exit(0)"]).status !== 0) fail(34, "canary could not spawn node");
  if (cp.spawnSync("git", ["--version"]).status !== 0) fail(35, "canary could not run git");
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
          peer.on("error", () => fail(38, "canary could not connect to a unix socket in the task temp"));
        });
      }));
    });
    request.on("error", () => fail(39, "canary could not reach its own localhost TCP server"));
  });
  setTimeout(() => fail(36, "canary did not finish within the 3s watchdog"), 3000);
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
): Promise<void> {
  const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "tidepool-codex-outside-")));
  // `:slash_tmp` の deny は tmpdir() 側、`:root` の deny は homedir() 側が測る(Linux、issue #712)
  const homeOutsideDir = realpathSync(mkdtempSync(join(homedir(), ".tidepool-codex-outside-")));
  const outside = join(outsideDir, "secret");
  const homeOutside = join(homeOutsideDir, "secret");
  const canary = join(taskTemp, `${taskType}-permission-canary.cjs`);
  try {
    // 書き込みも try の内側: 途中で投げても $HOME に使い捨てディレクトリを残さない
    writeFileSync(outside, "must remain unreadable");
    writeFileSync(homeOutside, "must remain unreadable");
    writeFileSync(canary, PERMISSION_CANARY);
    await runFile(
      call,
      executable,
      [
        "sandbox",
        "-P", `tidepool-${taskType}`,
        "-C", workspace,
        ...configArgs(permissionConfig(taskType, workspace, taskTemp, executable, [])),
        process.execPath,
        canary,
        workspace,
        taskTemp,
        outside,
        homeOutside,
        taskType === "review" ? "read" : "write",
      ],
      { cwd: workspace, env },
    );
  } finally {
    rmSync(outsideDir, { recursive: true, force: true });
    rmSync(homeOutsideDir, { recursive: true, force: true });
  }
}

/** 形の正しい placeholder の spawn 設定(ADR 0142 決定2)。preflight の strict parse と回答時の組の検査が問うのは、
 *  parse と skill の閉じ方だけ —— task に依る値は placeholder でよい。 */
function placeholderSpawnConfig(
  taskType: Task["type"],
  input: Pick<Parameters<typeof spawnConfig>[0], "workspace" | "allowedDomains" | "taskTemp" | "executable" | "skills" | "hook">,
): string[] {
  return spawnConfig({
    taskType,
    effort: "high",
    developerInstructions: CODEX_DEVELOPER_MARKER,
    mcpUrl: "http://127.0.0.1/mcp",
    enabledTools: BOARD_VERBS,
    ...input,
  });
}

async function actualCodexCapability(options: {
  executable: string;
  codexHome: string;
  call: BoardCall;
}): Promise<CodexCapabilityObservation> {
  const { call } = options;
  // 作ったディレクトリはどれも finally で消す —— 途中の mkdtemp / realpath が投げても先に作った分を残さない
  const created: string[] = [];
  const disposableDir = (prefix: string) => {
    const dir = mkdtempSync(prefix);
    created.push(dir);
    return realpathSync(dir);
  };
  try {
    const taskTemp = disposableDir(join(tmpdir(), "tidepool-codex-preflight-"));
    // ADR 0259 決定4: どの workspace の checkout も cwd にしない —— 問うのはホストの性質だけ
    const emptyCwd = disposableDir(join(tmpdir(), "tidepool-codex-preflight-cwd-"));
    // permission canary と strict parse の placeholder が workspace に見立てる、使い捨ての空の git repo。
    // 実物の checkout と同じく homedir() の下に置き、Linux の `:root` の deny の下で canary を走らせる(issue #712)
    const workspace = disposableDir(join(homedir(), ".tidepool-codex-preflight-workspace-"));
    const env = workerEnv(options.executable, options.codexHome, taskTemp, "tidepool");
    git(workspace, "init");
    const cliVersion = (await runFile(call, options.executable, ["--version"], { cwd: emptyCwd, env })).trim();
    // ADR 0259 決定2: 閉じる skill は worker と同じく Codex 自身の列挙から
    const skills = await enumerateSkills(
      codexCommandThrough(call, PREFLIGHT_KIND, CODEX_PREFLIGHT_LIMIT_MS),
      options.executable,
      env,
      emptyCwd,
    );
    const config = [...closedSurfaceConfig(), skills];
    const promptInput = await runFile(
      call,
      options.executable,
      // marker は prompt-input にだけ渡す —— 実測したのはこの面だけ(ADR 0124 の測定)
      ["debug", "prompt-input", ...configArgs([...config, `developer_instructions=${toml(CODEX_DEVELOPER_MARKER)}`]), "containment canary"],
      { cwd: emptyCwd, env },
    );
    const features = await runFile(
      call,
      options.executable,
      ["features", "list", ...configArgs(config)],
      { cwd: emptyCwd, env },
    );
    // 先頭 field が name、末尾 field が state。stage 列は空白を含みうる(under development)ので数えない。
    const observedFeatures = Object.fromEntries(
      features.trim().split("\n").map((line) => {
        const fields = line.trim().split(/\s+/);
        return [fields[0] ?? "", fields.at(-1) ?? ""] as const;
      }),
    );
    await probePermission(call, options.executable, workspace, taskTemp, "work", env);
    await probePermission(call, options.executable, workspace, taskTemp, "review", env);
    const hook = installBoardHook(options.codexHome);
    return {
      cliVersion,
      skills: observedSkills(promptInput),
      developerMarkers: observedDeveloperMarkers(promptInput),
      agentsMdLayer: observedAgentsMdLayer(promptInput),
      ...await probeHookRegistration(call, options.executable, env, (taskType) =>
        placeholderSpawnConfig(taskType, {
          workspace,
          allowedDomains: [],
          taskTemp,
          executable: options.executable,
          skills,
          hook,
        })),
      features: observedFeatures,
    };
  } finally {
    for (const dir of created) rmSync(dir, { recursive: true, force: true });
  }
}

export function createCodexCapabilityCheck(options: {
  executable: string;
  /** `resolveCodexExecutable` の結果。false なら probe を起こさない。 */
  onPath?: boolean;
  codexHome: string;
  call: BoardCall;
  /** version 行の差し替え口(`checkCodexCapability`)。盤面は渡さない。 */
  pinnedVersion?: string;
}): () => Promise<ContainmentCapability> {
  if (options.onPath === false) {
    return async () => ({ available: false, reason: "Codex containment preflight failed: codex was not found on PATH when the board started" });
  }
  return () => checkCodexCapability(
    () => actualCodexCapability(options),
    boardHookPath(options.codexHome),
    options.pinnedVersion,
  );
}

/** 回答時の (codex, workspace) の検査(ADR 0259 決定5)。worker の起動と同じ検査を placeholder の spawn 設定で撃ち、
 *  列挙・観測の失敗も不成立として返す —— 回答は拒まれ、question は開いたまま残る。 */
export function createCodexWorkspaceCheck(options: {
  executable: string;
  codexHome: string;
  call: BoardCall;
}): CodexWorkspaceCheck {
  return async (target) => {
    const taskTemp = realpathSync(mkdtempSync(join(tmpdir(), "tidepool-codex-workspace-check-")));
    try {
      const workspace = realpathSync(target.path);
      const { capability } = await codexWorkspaceContainment({
        call: options.call,
        executable: options.executable,
        env: workerEnv(options.executable, options.codexHome, taskTemp, "tidepool"),
        workspace,
        config: (skills) =>
          placeholderSpawnConfig("work", {
            workspace,
            allowedDomains: target.allowed_domains ?? [],
            taskTemp,
            executable: options.executable,
            skills,
            hook: boardHookPath(options.codexHome),
          }),
      });
      return capability;
    } catch (error) {
      return { available: false, reason: `${SKILL_CHECK_FAILED}: ${String(error)}` };
    } finally {
      rmSync(taskTemp, { recursive: true, force: true });
    }
  };
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

/** `turn.completed.usage` のうち盤面が読む 4 欄。`cached_input_tokens` と `cache_write_input_tokens` は
 *  `input_tokens` の内数(codex-rs 0.147.0)。`reasoning_output_tokens` は読まない(#2423)。 */
interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
}

export function readCodexUsage(value: unknown): CodexUsage | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { type?: unknown; usage?: Record<string, unknown> };
  const usage = event.type === "turn.completed" ? event.usage : undefined;
  return usage &&
    [usage.input_tokens, usage.cached_input_tokens, usage.cache_write_input_tokens, usage.output_tokens].every(Number.isFinite)
    ? usage as unknown as CodexUsage
    : null;
}

/** Codex の usage を盤面の語彙に写す唯一の入口(#2410)。欄が欠けるか引き算が負なら欠測(null) ——
 *  0 で埋めず、負を 0 に丸めない(#534)。入力 0 も欠測: codex は usage の報告を受け取らないと
 *  `Usage::default()`(全欄 0)を書く(#2426)。 */
export function codexTokenUsage(value: unknown): TokenUsage | null {
  const usage = readCodexUsage(value);
  if (!usage || usage.input_tokens === 0) return null;
  const input = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
  return input < 0
    ? null
    : {
        input_tokens: input,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cached_input_tokens,
        cache_creation_tokens: usage.cache_write_input_tokens,
        estimated_cost_usd: null,
      };
}

/** ADR 0188: `turn.failed` の message を逐語で(入れ子の JSON は解かない)。`error` event は
 *  再試行のたびにも流れるので代用しない —— `turn.failed` が自分で代用している。 */
export function readTurnFailure(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const event = value as { type?: unknown; error?: { message?: unknown } };
  const message = event.type === "turn.failed" ? event.error?.message : undefined;
  return typeof message === "string" ? message : null;
}

/** ADR 0261 決定2: `turn.failed` の行か —— 行の有無だけを見て、文は読まない。 */
function isTurnFailure(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { type?: unknown }).type === "turn.failed";
}

/** ADR 0261 決定2・6: どれかの窓が Throttle の 100% キャップに届いていれば満杯。読めなければ理由を持つ。 */
async function recheckUsage(probe: CodexAppServerProbe, now: Date): Promise<NonNullable<WorkerExit["usage_recheck"]>> {
  try {
    const observed = await probe(now);
    if (observed.status !== "observed") return { result: "unreadable", reason: observed.reason };
    const full = observed.windows.filter((window) => window.usedPercent >= 100);
    return full.length === 0
      ? { result: "not_full" }
      : {
          result: "full",
          windows: full.map((window) => ({ name: window.name, used_percent: window.usedPercent, resets_at: window.resetsAt })),
        };
  } catch (error) {
    return { result: "unreadable", reason: String(error) };
  }
}

/** ADR 0189: worker の発話は `item.completed` の `agent_message`(空の text は前の発話を残す)。 */
function readAgentMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const item = (value as { type?: unknown; item?: { type?: unknown; text?: unknown } }).item;
  const completed = (value as { type?: unknown }).type === "item.completed" && item?.type === "agent_message";
  return completed && typeof item.text === "string" && item.text !== "" ? item.text : null;
}

/** JSONL の1行を読む。空行も壊れた行も null —— 逐語の transcript が残る証拠で、
 *  壊れた行は正規化した usage も認証の事実も運ばない。 */
export function parseJsonl(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** The OpenAI vendor adapter. The board selects it only for `provider: openai`. */
export class CodexWorker implements WorkerAdapter {
  readonly id: string;
  private readonly containers: ProcessContainers;
  private readonly workspacesDir: string;
  private readonly running = new Map<string, { kill(signal: NodeJS.Signals): void }>();

  constructor(private readonly options: CodexWorkerOptions) {
    this.id = options.agent;
    this.containers = options.containers;
    this.workspacesDir = resolveWorkspacesBaseDir(options.workspacesDir);
    mkdirSync(options.codexHome, { recursive: true });
  }

  start(task: Task, setting: ExecutionSetting, query?: InjectionQuery): Promise<void> | undefined {
    const registry = loadRegistry(this.options.registry.dir, this.options.registry.mode);
    // ADR 0274: 資源の Quarantine で spawn まで届かなかった pickup は盤面が先頭へ戻す
    const stopped = (stop: ResourceStop) => this.options.onPickupStopped?.(task.id, { kind: "pickup_stopped", ...stop });
    const workspace = resolveOrQuarantine(
      this.options.db,
      (name) => resolveExecutionWorkspace(registry, this.options.workspace, name, this.workspacesDir),
      task.workspace,
      this.options.clock.now(),
      stopped,
    );
    if (!workspace) return;
    // 走る場所(ADR 0273 決定1・8 / ADR 0276 決定1): interview の root は面接室、受験者は自分の checkout。検査・cwd・封じ込めの組はこちら、層と記憶は実環境
    const place = taskRunPlace(this.options.db, task, workspace);
    const overlap = this.options.boardState && boardStateOverlap(place.path, this.options.boardState);
    if (overlap) {
      stopped(quarantineWorkspace(this.options.db, place.name, new Error(overlap.reason), this.options.clock.now()));
      return;
    }
    const assignee = resolveTaskAgent(
      task,
      this.options.agent,
      this.options.auditorName ?? DEFAULT_AUDITOR_NAME,
      this.options.interviewerName ?? DEFAULT_INTERVIEWER_NAME,
    );
    const agent = resolveAgentOrQuarantine(
      this.options.db,
      (name) => resolveExecutionAgent(registry, this.options.agent, name, tierNames(this.options.db), task.type),
      assignee,
      this.options.clock.now(),
      stopped,
    );
    if (!agent) return;

    // resolveExecutionAgent already enforces this at pickup; keep the adapter's
    // vendor boundary explicit so a future direct caller cannot silently mask it.
    // 2つの拒否はどちらも ADR 0098(Codex v1 の正準経路、Harness の fallback なし)
    if (agent.definition.skills.length > 0) {
      throw new Error("CodexWorker v1 refuses a non-empty skill allowlist");
    }
    if (setting.provider !== "openai") {
      throw new Error(`CodexWorker refuses provider ${setting.provider}; no Harness fallback`);
    }
    const memory = buildMemoryInjection(this.options.db, task, workspace.name, agent.name, query);
    // ADR 0180 決定2・追記 #1239 / ADR 0279 決定2: meta-review は INDEX の代わりに指針の節を受け、主題の材料の節がその後ろに続く
    const material = buildMetaReviewMaterial(this.options.db, task.id, Object.values(registry.agents));
    // 実体の綴りで filesystem 表・skills/list・-C を書く(issue #864)。無い checkout はここで投げ、pickup が spawn_failed に落とす
    const workspacePath = realpathSync(place.path);
    const hook = installBoardHook(this.options.codexHome);
    const subject = metaReviewSubjectOf(this.options.db, task.id); // 自身の列: 問いは「この task は meta-review か」で、行の主題ではない(ADR 0283 決定1)
    const verbs = taskVerbSwap(this.options.db, task.id);
    const withheld: readonly string[] = verbs.withheld;
    const taskMcpUrl = new URL(this.options.mcpUrl);
    taskMcpUrl.searchParams.set("task", task.id);
    const input = {
      taskType: task.type,
      // openai の行は「無い」を取らない —— 書く入口が拒む(ADR 0218 決定5)
      effort: setting.effort!,
      // 封じ込めの観測は本文だけを marker に差し替えた spawn の設定を当てる。本文は `worker_spawned` の id を
      // Executor の区切りに持つので、event の後で描いて差し替える(ADR 0259 追記 / ADR 0295 決定4)
      developerInstructions: CODEX_DEVELOPER_MARKER,
      mcpUrl: taskMcpUrl.toString(),
      // ADR 0122 決定2 / ADR 0245 決定1・3 / ADR 0253 決定4・5 / ADR 0268 決定2 / ADR 0271 決定2 / ADR 0272 決定3 / ADR 0279 決定4 / ADR 0281 / ADR 0283 決定3・追記1: MCP の登録と同じ差を写す(主題の修理子と行の主題を持つ RCA の pull verb の伏せは taskVerbSwap、read_memory_entries は memoryRepairVerbs / routingRepairVerbs / isSubjectReaderRca から来る)。宣言と盤面の面が集合として一致することは
      // tests/codex-worker.test.ts が固定する(ADR 0125 決定2)
      enabledTools: [
        ...(subject
          ? [...BOARD_VERBS.filter((verb) => !(WORKER_MEMORY_VERBS as readonly string[]).includes(verb)), ...META_REVIEW_SUBJECTS[subject].verbs]
          : [
              ...BOARD_VERBS,
              ...(task.type === "memory_repair"
                ? memoryRepairVerbs(this.options.db, task.id)
                : task.type === "routing_repair"
                  ? routingRepairVerbs(this.options.db, task.id)
                  : isSubjectReaderRca(this.options.db, task.id)
                    ? ["read_memory_entries"]
                    : []),
            ]
        ).filter((verb) => !withheld.includes(verb)),
        ...verbs.added,
      ],
      workspace: workspacePath,
      allowedDomains: workspace.allowed_domains ?? [],
      readPaths: place.reads.map((read) => read.path),
      executable: this.options.executable,
      hook,
    };
    const taskTemp = realpathSync(mkdtempSync(join(tmpdir(), `tidepool-codex-${task.id}-`)));
    // 削除の失敗で session の後始末を止めない(issue #705)
    const removeTaskTemp = () => {
      try {
        rmSync(taskTemp, { recursive: true, force: true });
      } catch (error) {
        console.error(`[codex-worker] could not remove ${taskTemp}:`, error);
      }
    };
    // ADR 0118: worker が1度も走らなかった pickup の観測点(skill の列挙・観測、spawn までの同期 throw、spawn の error)は同じ形で記録する
    let recorded = false;
    const spawnFailed = (failure: { error_code: string | null; message: string }) => {
      // 配線の途中で投げたあとに spawn の error が来ても、記録は1度だけ
      if (recorded) return;
      recorded = true;
      removeTaskTemp();
      appendEvent(this.options.db, {
        taskId: task.id,
        workerId: agent.name,
        origin: "board",
        payload: { kind: "spawn_failed", ...failure },
        at: this.options.clock.now(),
      });
      this.options.onSpawnFailed?.(task.id, failure);
    };
    const env = workerEnv(this.options.executable, this.options.codexHome, taskTemp, agent.name);
    // ADR 0259 決定2・3・6: spawn の前に Codex 自身の列挙で skill を閉じ、閉じた設定の下で観測する。ここから先は
    // scheduler の catch の外なので、失敗は自分で spawn_failed に落とす(Claude adapter の skill 列挙と同じ形)
    return (async () => {
      let checked: Awaited<ReturnType<typeof codexWorkspaceContainment>>;
      try {
        checked = await codexWorkspaceContainment({
          call: this.options.boardCall,
          executable: this.options.executable,
          env,
          workspace: workspacePath,
          config: (skills) => spawnConfig({ ...input, taskTemp, skills }),
        });
      } catch (error) {
        spawnFailed({
          error_code: null,
          message: `${SKILL_CHECK_FAILED}; the worker was not spawned (no fail-open): ${String(error)}`,
        });
        return;
      }
      if (!checked.capability.available) {
        removeTaskTemp();
        // 閉じきれないのはこの checkout の Codex だけなので、止めるのは (codex, workspace) の組(ADR 0259 決定1・3)
        const stop = { quarantine: "workspaceContainment", value: workspaceContainmentValue("codex", place.name), reason: checked.capability.reason } as const;
        registerQuarantine(this.options.db, stop.quarantine, stop.value, stop.reason, this.options.clock.now());
        stopped(stop);
        return;
      }
      // ADR 0149 決定2: `worker_spawned` → transcript の同期 open → spawn(Claude adapter と同じ順)
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
          tier_id: setting.tier_id,
          source: setting.source,
          harness: "codex",
          cli_version: this.options.cliVersion,
        },
        at: this.options.clock.now(),
      });
      recordMemoryInjection(this.options.db, task.id, agent.name, spawned, memory, this.options.clock.now());
      if (material) recordMetaReviewMaterial(this.options.db, task.id, agent.name, spawned, material, this.options.clock.now());
      // ADR 0124 決定1・2 / ADR 0157 決定1: 盤面が書いた文面は Claude と同じ正本から、この spawn の id で組む(ADR 0295 決定4)。
      // Codex は次の part(`<skills_instructions>`)との間に区切りを入れないので、終端の空行は文面の一部である
      const developerInstructions = `${boardProse({
        db: this.options.db,
        registryDir: this.options.registry.dir,
        registry,
        task,
        spawnedEventId: spawned,
        systemPrompt: agent.definition.systemPrompt,
        profile: agent.profile,
        doctrine: codexDoctrine(verbs),
        verbs,
        allowedDomains: workspace.allowed_domains,
        memorySection: memoryPromptSection(memory, material),
      })}\n\n`;
      const transcript = this.options.transcripts.open(task.id, spawned);
      const child = this.containers.open(task.id).spawn(
        this.options.executable,
        [
          "--ask-for-approval", "never",
          "exec", "--json", ...WORKER_EXEC_FLAGS, "--dangerously-bypass-hook-trust",
          "-C", workspacePath,
          "-m", setting.model,
          ...configArgs(spawnConfig({ ...input, developerInstructions, taskTemp, skills: checked.skills })),
          taskPrompt(task),
        ],
        { cwd: workspacePath, env },
      );
      child.stdout.pipe(transcript.stream);
      child.stderr.pipe(transcript.stderr);
      let usage: TokenUsage | null = null;
      let reportedError: string | null = null;
      let lastMessage: string | null = null;
      // ADR 0261 決定2: 読み直しの条件は `turn.failed` の行の有無だけ —— 文(reported_error)は読まない
      let turnFailed = false;
      const observe = (event: unknown) => {
        usage = codexTokenUsage(event) ?? usage;
        reportedError = readTurnFailure(event) ?? reportedError;
        turnFailed ||= isTurnFailure(event);
        lastMessage = readAgentMessage(event) ?? lastMessage;
      };
      const flushStdout = readLines(child.stdout, (line) => observe(parseJsonl(line)));
      const finishStderrTail = readStderrTail(child.stderr);
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
        spawnFailed({ error_code: errno.code ?? null, message: error.message });
      });
      // ADR 0201: 確定点は exit でなく root の出力の読み切り(see settleOnOutputClose)。
      const settle = (code: number | null, signal: NodeJS.Signals | null, outputClosed: boolean) => {
        this.running.delete(task.id);
        flushStdout();
        const exit: WorkerExit = {
          exit_code: code,
          signal,
          stderr_tail: finishStderrTail(),
          reported_error: reportedError,
          last_message: lastMessage,
        };
        const probe = this.options.usageProbe;
        if (!turnFailed || !probe) return record(exit, outputClosed);
        void recheckUsage(probe, this.options.clock.now()).then((usage_recheck) => record({ ...exit, usage_recheck }, outputClosed));
      };
      const record = (exit: WorkerExit, outputClosed: boolean) => {
        const normalized: Extract<EventPayload, { kind: "worker_exited" }>["usage"] = usage
          ? {
              ...usage,
              advisor: null,
              model_swaps: [],
              refusals: [],
            }
          : null;
        appendEvent(this.options.db, {
          taskId: task.id,
          workerId: agent.name,
          origin: "board",
          payload: {
            kind: "worker_exited",
            ...exit,
            worker_spawned_event_id: spawned,
            output_closed: outputClosed,
            usage: normalized,
          },
          at: this.options.clock.now(),
        });
        removeTaskTemp();
        // ADR 0261 決定3: Claude と同じ順 —— 中断を先に撃てば、続く exit は後始末中として盤面に読まれる。
        // 回収済み観測が読み直しの間に届いていても `reclaimed()` は解決する
        if (exit.usage_recheck?.result === "full") this.options.onCapInterrupted?.(task.id, this.containers.reclaimed(task.id));
        this.options.onWorkerExited?.(task.id, exit);
        // ADR 0083 追記10: Claude adapter と同じく worker_exited を書いたあとに Precedent を投影する。
        projectWhenTranscriptCloses(this.options.db, transcript.stream, {
          workerSpawnedEventId: spawned,
          transcriptPath: transcript.streamPath,
          taskId: task.id,
        });
      };
      // ADR 0109 決定4: root の exit は容器に残るものが孤児である証拠 —— 読み切りを待たずに
      // 強制回収を撃つ(ADR 0201 決定1)。Harness 非依存に、盤面 supervisor 経由。
      settleOnOutputClose(child, this.options.clock, this.options.reclaimTimeout ?? RECLAIM_TIMEOUT, () => this.containers.forceReclaim(task.id), settle);
    })().catch((error) => {
      // ponytail: spawn が同期で投げると開いた transcript の2本の fd は閉じない(Claude adapter と同じ
      // 稀な経路)。積み上がりが観測されたらここで destroy する。
      // ADR 0149 決定6: scheduler の catch の外なので、検査のあとの同期 throw(quarantine の登録、spawn まで、
      // spawn のあとの配線)はすべて spawn_failed に落とす —— 未処理の reject にしない。transcript が開けない
      // 器の失敗だけは盤面全体の停止へ渡す(ADR 0266 決定4)
      this.running.delete(task.id);
      if (error instanceof RecordContainerError) {
        removeTaskTemp();
        this.options.onRecordContainerFailed?.(task.id, error);
        return;
      }
      spawnFailed({
        error_code: (error as NodeJS.ErrnoException).code ?? null,
        message: error instanceof Error ? error.message : String(error),
      });
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
