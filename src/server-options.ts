import { execFileSync } from "node:child_process";
import { platform } from "node:process";
import { resolveExecutionAgent, UnknownAgentError } from "./agent.js";
import {
  type AgentAdmin,
  createAgent,
  deleteAgent,
  listAgentViews,
  updateAgent,
} from "./agent-create.js";
import type { HumanCredential } from "./auth.js";
import type { BoardStatePath } from "./board-state.js";
import { containerRuntimeFor } from "./cgroup-container.js";
import { createClaudeCliAuthCheck, createMoonshotCliAuthCheck } from "./claude-cli-auth.js";
import { ClaudeDraftClient } from "./claude-draft-client.js";
import {
  ClaudeCodeWorker,
  type ClaudeWorkerOptions,
  enumerateHostSkills,
  probeToolSurfaceCapability,
} from "./claude-worker.js";
import type { Clock } from "./clock.js";
import { createCodexAppServerProbe } from "./codex-app-server.js";
import {
  CODEX_CLI_VERSION,
  CodexWorker,
  createCodexCapabilityCheck,
} from "./codex-worker.js";
import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import type { DraftClient } from "./draft.js";
import { GhCliClient } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import {
  createProfile,
  deleteProfile,
  listProfileViews,
  type ProfileAdmin,
  updateProfile,
} from "./profile-create.js";
import { type VapidConfig, WebPushClient } from "./push.js";
import {
  type AuthorityProfile,
  assertValidProvider,
  canonicalHarness,
  InvalidAgentProviderError,
  loadRegistry,
  ownEntry,
  type Provider,
  type RegistryCandidates,
  type RegistryMode,
  type RegistryReachability,
  type RegistrySource,
  type RosterAgent,
  refreshRegistry,
} from "./registry.js";
import { checkSandboxCapability } from "./sandbox.js";
import type { ServerOptions, WorkerFactory } from "./server.js";
import { resolveTaskAgent, type Task } from "./tasks.js";
import type { ProviderUsageResource } from "./throttle.js";
import type { TranslationClient } from "./translate.js";
import type { WatchdogConfig } from "./watchdog.js";

import { CanonicalWorkerRouter, type WorkerAdapter } from "./worker.js";
import type { WorkerContainers } from "./worker-container.js";
import {
  listRegisteredWorkspaces,
  resolveExecutionWorkspace,
  type WorkspaceConfig,
  type WorkspacesBaseDirSource,
} from "./workspace.js";
import {
  createWorkspace,
  deleteWorkspace,
  listWorkspaceViews,
  publishWorkspace,
  updateWorkspace,
  type WorkspaceAdmin,
} from "./workspace-create.js";

/** 盤面の watchdog(#9 / CONTEXT.md の Watchdog)を本番で成立させる時間リミット。
 *  **コード定数であってホストごとの設定ではない** — ADR 0037 と同じ軸で、盤面の
 *  不変条件(唯一の slot が誰にも回収されずに握られたままにならない)を
 *  `/etc/default/tidepool` の綴りに委ねない。
 *
 *  すべての値は分単位に量子化される: WATCHDOG_TICK が 60秒なので、それ未満の差は
 *  1 tick に丸められる。
 *
 *  - `work` = 90分。adapter が spawn 時に立てる `CLAUDE_STREAM_IDLE_TIMEOUT_MS` が
 *    10分(#33 / anthropics/claude-code#69238 の回避 —— 以前はホストの
 *    `/etc/default/tidepool` にあり、#33 で adapter へ移した。値も適用範囲も
 *    変えていない: advisor の有無に依らず**全セッション**に掛かる)なので、byte-idle 由来の
 *    ストールは CLI 側が拾う。拾えないのはループに入ったセッション —— バイトを
 *    出し続けるので idle 検知が効かず、watchdog だけが backstop になる。kill は
 *    失敗 question(retry / abandon)+ push に落ちる回復可能な事象なので、夜の
 *    8時間のうち最大90分の損失に抑える側へ倒す。
 *  - `review` = 45分。読んで判断する仕事で、work のような長い実装ループを持たない。
 *  - `question` は**意図的に無い**。watchdog が見るのは slot のタスクだけだが
 *    (watchdog.ts の tick は `slot.currentTaskId` と `in_progress` で門番する)、
 *    pickup の抽出そのものが `t.type <> 'question'` で question を外している
 *    (tasks.ts の `nextSlotTask`)。`in_progress` を立てるのは `pickupTask`
 *    だけなので、**watchdog が question 型のタスクを見ることは起こり得ない**。
 *    したがってここに値を書いても死んだ設定にしかならず、しかも「watchdog が
 *    question も governs する」という誤った含意を残す。question は人間タスクと
 *    して slot の外で回答される(CONTEXT.md の Held)。
 *  - `grace` = 60秒 = 1 tick。畳み込み停止から強制回収までの猶予で、watchdog.ts の
 *    比較は `>=` なので次の tick で回収が出る。
 *  - `reclaimTimeout` は既定のまま(watchdog.ts の `RECLAIM_TIMEOUT`)。ここに
 *    書かないのは判断が1つも無いからであり、置き場所が無いからではない。 */
export const WATCHDOG: WatchdogConfig = {
  timeLimits: { work: 90 * 60_000, review: 45 * 60_000 },
  grace: 60_000,
};

/** 盤面1台を組み立てるための入力。**ServerOptions のキーではない** — env から
 *  解決したスカラと、合成 root(main.ts)でしか作れない副作用込みの部品だけを
 *  受け取り、ServerOptions の口の一覧はこのモジュールが単独で持つ(ADR 0041)。
 *
 *  registry 由来の口がすべて `registryDir` 1つに掛かっているのがこの盤面の形で、
 *  未設定なら「registry という概念自体が無い盤面」— 各口が個別に既定へ落ちる。 */
export interface BoardComposition {
  dbPath: string;
  port: number;
  /** `/mcp` 自身のポート(issue #37)。worker が叩く MCP URL もここから作る。 */
  mcpPort: number;
  /** ADR 0036 / issue #153: 人間面の credential。平文は main.ts が一度表示する
   *  だけで、盤面はハッシュしか持たない。 */
  credential: HumanCredential;
  clock: Clock;
  /** agent registry のローカルクローン。未設定 → registry 由来の口はすべて不在。 */
  registryDir: string | undefined;
  /** ADR 0052: declares the registry source without inspecting the clone. */
  registryMode: RegistryMode;
  /** worker の stream-json トランスクリプトと spawn 時 MCP config の置き場。
   *  ディレクトリの作成そのものはホストの副作用なので合成 root 側に残る。 */
  logDir: string;
  /** issue #33 判断8 / ADR 0043: advisor の緊急マスク。**盤面ホストの運用設定**で
   *  あって registry には置かない —— エージェントの定義ではなく、experimental な
   *  機能を全員に配る代償として「agent.md を1枚も触らずに止める」ための口。 */
  advisorDisabled: boolean;
  /** この盤面が実行に使う workspace 名。 */
  workspaceName: string;
  /** ADR 0018: path を省いた workspace エントリが解決される基底ディレクトリ。 */
  workspacesDir: string;
  /** ADR 0082 決定2: 上の値が `TIDEPOOL_WORKSPACES_DIR` 由来か既定か。登録の門が
   *  着地先に添えて見せるので、env を読む合成 root から届く。 */
  workspacesDirSource: WorkspacesBaseDirSource;
  /** ADR 0012 / issue #36: assignee 未設定のタスクが解決される既定 agent。 */
  defaultAgentName: string;
  /** issue #15 layer 2 / CONTEXT.md の Auditor。 */
  auditorName: string;
  /** ADR 0040 / issue #149: 盤面自身の状態パス(プロセスで固定の5点)。 */
  boardState: BoardStatePath[];
  /** ADR 0097 決定4 / issue #445: Moonshot Platform キーの置き場(mode 600 の
   *  状態ファイル、平文は盤面の env に載せない)。アダプタが spawn 時にだけ読む。 */
  moonshotApiKeyFile: string;
  /** ADR 0098: isolated Board-owned Codex login/cache/config root. */
  codexHome: string;
  /** ADR 0098: absolute Codex executable; the live preflight proves it exists. */
  codexExecutable: string;
  /** ADR 0024 / issue #50: 盤面の GitHub 識別情報。ファイルの読み取りは合成 root
   *  側の I/O なので、ここには解決済みの値だけが来る。未設定 → GitHub 機能は
   *  すべて fail-closed で off。 */
  githubAuth: GitHubAuth | undefined;
  /** `TIDEPOOL_GITHUB_TOKEN_FILE` そのもの(ADR 0093 決定5)。`githubAuth` は
   *  起動時に解決した結果なので、起動後のログインを映せない —— settings の
   *  「ログイン済みか」は毎回このパスを検査し直す。 */
  githubTokenFile: string | undefined;
  /** issue #14: VAPID の3点セット。「3つ揃うか、1つも無いか」のゲートは env を
   *  読む合成 root 側にあり、ここは push クライアントと公開鍵の**両方**をこの
   *  1つから導く — 2つの口が別々の判定を持つと黙ってずれる。 */
  vapid: VapidConfig | undefined;
  /** issue #47 / ADR 0015: 表示時翻訳。盤面自身の CONTEXT.md を読んで作るので
   *  合成 root 側で組む。 */
  translationClient: TranslationClient;
  /** ADR 0075: optional token expiry; absent disables only advance warning. */
  cliAuthExpiresAt: Date | undefined;
}

/** Fallback when no registry clone is configured: logs the pickup so a human
 *  can drive the MCP verbs by hand. */
export class LoggingWorker implements WorkerAdapter {
  readonly id = "logging-worker";
  start(task: Task): void {
    console.log(`[worker] picked up ${task.id}: ${task.title}`);
  }
  gracefulStop(taskId: string): void {
    console.log(`[worker] would ask ${taskId} to stop and fold its work up`);
  }
  /** No registry means no real adapter behind this — report a well-under-
   *  threshold reading so pickup logging is never fail-closed by a check
   *  this placeholder cannot actually perform. */
  async checkUsage(): Promise<string | null> {
    return (
      "Current session\n0% used\nResets 12:00am (UTC)\n" +
      "Current week (all models)\n0% used\nResets Jan 1 at 12:00am (UTC)\n"
    );
  }
}

/** 実 CLI worker 1台ぶんの `ClaudeWorkerOptions`。**口の一覧を持つ唯一の場所**で
 *  あり、`buildServerOptions` と同じ理由でここに在る(ADR 0043 / issue #33)。
 *
 *  ADR 0041 はこの層を「#172 の類ではない」と除外していた。その根拠は当時の任意
 *  フィールドが `spawn` / `pty` / `enumerateSkills` —— **不在 = 実物を使う**という
 *  テスト用の注入 seam —— だけだったことにある。`advisorDisabled` はその類では
 *  ない: 機能そのものであり、渡し忘れたときの壊れ方は fail-open(緊急マスクが
 *  効かないまま、盤面のどこも赤くならない)。したがって網羅の観測をこの層まで
 *  伸ばす —— 一覧をここへ出さなければ、テストが見るのはテスト自身が書いた複製に
 *  しかならない(ADR 0041 §1 / §4)。
 *
 *  `db` / `clock` は WorkerFactory がスケジューラから受け取る実行時の依存なので
 *  合成の入力とは別に取る。 */
export function buildWorkerOptions(
  board: BoardComposition & { registryDir: string },
  session: { db: Db; clock: Clock; containers: WorkerContainers },
): ClaudeWorkerOptions {
  return {
    db: session.db,
    clock: session.clock,
    // ADR 0099 決定2: 盤面が1つだけ持つ worker 容器の supervisor。adapter は
    // その中へ spawn し、watchdog は同じ帳簿へ force / reclaimed を撃つ。
    containers: session.containers,
    // ADR 0052 決定1: spawn がどの ref を読むか。ここに載っていなければ worker は
    // 既定へ落ちるしかなく、盤面側の resolver だけをリモートへ移しても
    // 「人間の merge を通った内容が spawn に効く」は成立しない。
    // 組を書き下す2箇所目にして最後(理由は `registrySource` の doc comment)
    registry: { dir: board.registryDir, mode: board.registryMode },
    agent: board.defaultAgentName,
    auditorName: board.auditorName,
    workspace: board.workspaceName,
    workspacesDir: board.workspacesDir,
    mcpUrl: `http://127.0.0.1:${board.mcpPort}/mcp`,
    logDir: board.logDir,
    cliVersion: () => execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
    // ADR 0040: 床そのもの — 重なっている workspace では spawn せず quarantine
    boardState: board.boardState,
    // issue #33 判断8: 不在が「マスクされていない」を意味する口なので、渡し忘れは
    // 静かに fail-open する。上の網羅テストが見張っているのはまさにこれ。
    advisorDisabled: board.advisorDisabled,
    // ADR 0097 決定4: Moonshot キーの置き場。アダプタが spawn 時にだけ読む
    moonshotApiKeyFile: board.moonshotApiKeyFile,
  };
}

/** registry が無ければ LoggingWorker、あれば実 CLI worker(issue #33 / ADR 0043
 *  でこの分岐ごと合成側へ移した)。`ServerOptions.worker` はこれで埋まるので、
 *  合成 root から渡されるのは env 由来のスカラだけになる。 */
export function buildWorkerFactory(board: BoardComposition): WorkerFactory {
  const { registryDir } = board;
  const resolveHarness = harnessResolver(board);
  if (!registryDir || !resolveHarness) return () => new LoggingWorker();
  return ({ db, clock, containers }) => {
    const registry = { dir: registryDir, mode: board.registryMode } as const;
    return new CanonicalWorkerRouter({
      id: board.defaultAgentName,
      resolveHarness,
      adapters: {
        "claude-code": new ClaudeCodeWorker(
          buildWorkerOptions({ ...board, registryDir }, { db, clock, containers }),
        ),
        codex: new CodexWorker({
          db,
          clock,
          containers,
          registry,
          agent: board.defaultAgentName,
          auditorName: board.auditorName,
          workspace: board.workspaceName,
          workspacesDir: board.workspacesDir,
          mcpUrl: `http://127.0.0.1:${board.mcpPort}/mcp`,
          logDir: board.logDir,
          codexHome: board.codexHome,
          executable: board.codexExecutable,
          cliVersion: CODEX_CLI_VERSION,
          boardState: board.boardState,
        }),
      },
    });
  };
}

function harnessResolver(board: BoardComposition): ((task: Task) => ReturnType<typeof canonicalHarness>) | undefined {
  if (!board.registryDir) return undefined;
  return (task) => {
    const registry = loadBoardRegistry(board);
    const name = resolveTaskAgent(task, board.defaultAgentName, board.auditorName);
    const agent = resolveExecutionAgent(registry, board.defaultAgentName, name);
    return canonicalHarness(agent.definition.provider as Provider);
  };
}

function usageResourceResolver(
  board: BoardComposition,
): ((task: Task) => { provider: Provider; model: string | null }) | undefined {
  if (!board.registryDir) return undefined;
  return (task) => {
    const registry = loadBoardRegistry(board);
    const name = resolveTaskAgent(task, board.defaultAgentName, board.auditorName);
    const agent = resolveExecutionAgent(registry, board.defaultAgentName, name);
    return {
      provider: agent.definition.provider as Provider,
      model: agent.definition.model ?? null,
    };
  };
}

function agentsUsingHarnessesResolver(
  board: BoardComposition,
): ((harnesses: readonly ReturnType<typeof canonicalHarness>[]) => string[]) | undefined {
  if (!board.registryDir) return undefined;
  return (harnesses) =>
    Object.values(loadBoardRegistry(board).agents)
      .filter((agent) => {
        try {
          assertValidProvider(agent.name, agent.provider, agent.advisor, agent.skills);
          return harnesses.includes(canonicalHarness(agent.provider as Provider));
        } catch (error) {
          if (error instanceof InvalidAgentProviderError) return false;
          throw error;
        }
      })
      .map((agent) => agent.name);
}

/** One spelling for every registry-derived composition seam: mode is resolved
 *  once at the root and no resolver is allowed to fall back to local main.
 *  呼び出し側はどれも先に `registryDir` を検査しているが、その絞り込みはここまで
 *  流れてこないので、型を閉じるためだけの throw を置く。 */
function loadBoardRegistry(board: BoardComposition) {
  if (!board.registryDir) throw new Error("no registry configured");
  return loadRegistry(board.registryDir, board.registryMode);
}

/** ADR 0052 決定3 の宣言そのもの: `TIDEPOOL_REGISTRY` を設定した盤面は remote
 *  正本を持つ。**clone を覗かない** — remote の有無を見て切り替えると、remote が
 *  失われた瞬間に「merge が spawn に効かない」旧挙動へ静かに戻り、どこも赤く
 *  ならない(ADR 0052 が名指しで却下した道)。
 *
 *  `purely-local` を env で選ばせないのは意図的である。それは盤面を静かに壊せる
 *  スイッチになり、Pi で誤って立てれば ADR 0052 が直した穴がそのまま戻る —— 却下
 *  した推測と同じ形の footgun を、今度は設定として作ることになる。純ローカル盤面
 *  (`workspace.ts` の `guardRegistryDefaultBranch` が認める構成)は、テストが
 *  `BoardComposition` を直接組んで宣言する経路で表現できており、そちらが要ると
 *  分かるまで本番の口は開けない。 */
export function declaredRegistryMode(registryDir: string | undefined): RegistryMode {
  return registryDir ? "remote-backed" : "purely-local";
}

/** この盤面が読み書きする registry を1つの `RegistrySource` として。**組を組み立てる
 *  唯一の場所**である —— `RegistrySource` 自身の doc comment が「必ず一緒に運ばれる
 *  ので1つの型にまとめる」と言っているのに、合成 root が `{ dir, mode }` を各所で
 *  書き下すと型を作った意味が薄れる(/code-review Standards 軸の指摘)。registry が
 *  無ければ registry という概念自体が無い盤面なので undefined —— 呼び出し側の
 *  `registryDir` ゲートはこの不在の検査そのものに置き換わる。
 *
 *  `buildWorkerOptions` だけはここを通らない: あちらの `board` は型で
 *  `registryDir: string` に絞られており、`ClaudeWorkerOptions.registry` は任意では
 *  ない口なので、undefined を許す面と噛み合わない。 */
function registrySource(board: BoardComposition): RegistrySource | undefined {
  return board.registryDir ? { dir: board.registryDir, mode: board.registryMode } : undefined;
}

/** ADR 0052 決定2 の**起動時**の refresh 点。`buildServerOptions` の先頭で、
 *  registry を1文字も読む前に撃つ。
 *
 *  順序がこの関数の本体である。合成 root は `workspace`(workspaceConfig)と
 *  draft の candidates を**その場で**読むので、refresh を後ろに置くと —— 例えば
 *  `startServer` の中に置くと —— remote-tracking ref が欠けた盤面では読みのほうが
 *  先に落ち、fail-open が働く前に起動が終わる。`git remote remove` は tracking ref
 *  も一緒に消すため、これは机上の話ではない: quarantine question 自身が人間に促す
 *  修理(remote の張り直し)の直後がまさにその状態であり、そこで起動を拒むと
 *  ADR 0036 が復旧経路と定めた人間面ごと開かなくなる。
 *
 *  決定4 の fail-open: 失敗しても騒ぐだけで、起動は拒まず quarantine も立てない
 *  (床は pickup ゲートの1枚)。fetch が失敗し**かつ** ref も無ければ直後の読みが
 *  throw するが、それは「registry が読めない盤面は起動しない」という ADR 0052
 *  以前からの姿勢であって、ここが決めていることではない —— この関数が変えるのは
 *  「諦める前に1回 fetch を試す」ことと、git の生のエラーより先に理由が journal に
 *  出ることである。 */
async function bootRefresh(board: BoardComposition): Promise<void> {
  const registryDir = remoteBackedRegistryDir(board);
  if (!registryDir) return;
  const reachability = await refreshRegistry(registryDir, board.githubAuth);
  if (reachability.available) return;
  console.error(
    "[registry] startup refresh failed; the board is starting anyway and the next pickup " +
      `will stop the board if this stands: ${reachability.reason ?? "registry remote is unreachable"}`,
  );
}

/** fetch する先を持つ盤面の registry clone、無ければ undefined。**宣言だけで
 *  決まる** —— clone を覗かないのが ADR 0052 決定3 の線であり、3つの refresh 点が
 *  同じ1つの判定を共有するための場所でもある。 */
function remoteBackedRegistryDir(board: BoardComposition): string | undefined {
  return board.registryMode === "remote-backed" ? board.registryDir : undefined;
}

/** ADR 0052 決定2 の pickup / 回答時の refresh 点。remote 正本を宣言していない
 *  盤面には fetch する先が無いので、口ごと不在になる(ADR 0041)。 */
function registryReachabilityCheck(
  board: BoardComposition,
): (() => Promise<RegistryReachability>) | undefined {
  const registryDir = remoteBackedRegistryDir(board);
  if (!registryDir) return undefined;
  return () => refreshRegistry(registryDir, board.githubAuth);
}

/** The board's own view of the workspace (branch discipline + tree rule):
 *  the same registry entry the worker runs in, resolved to its path. */
function workspaceConfig(board: BoardComposition): WorkspaceConfig | undefined {
  if (!board.registryDir) return undefined;
  return resolveExecutionWorkspace(
    loadBoardRegistry(board),
    board.workspaceName,
    null,
    board.workspacesDir,
  );
}

/** Resolves any task's execution workspace against the registry (issue #26 /
 *  ADR 0009): read fresh every call, never pinned to a path at pickup. Absent
 *  → every task runs against the single `workspaceConfig()` above (no
 *  registry configured at all). */
function workspaceResolver(
  board: BoardComposition,
): ((taskWorkspace: string | null) => WorkspaceConfig) | undefined {
  const { registryDir, workspaceName, workspacesDir } = board;
  if (!registryDir) return undefined;
  return (taskWorkspace) =>
    resolveExecutionWorkspace(loadBoardRegistry(board), workspaceName, taskWorkspace, workspacesDir);
}

/** ADR 0040 の boot 一斉検査の対象: 登録済み workspace 全件。他の resolver たちと
 *  同じく registry から fresh に読み直す(ADR 0009)。registry なし → workspace と
 *  いう概念自体が無い。 */
function registeredWorkspaces(board: BoardComposition): WorkspaceConfig[] {
  if (!board.registryDir) return [];
  return listRegisteredWorkspaces(loadBoardRegistry(board), board.workspacesDir);
}

/** fable モデルに解決される agent 名の集合 (ADR 0030)、毎 poll registry から
 *  読み直す。CLI の --model は開かれた文字列("fable" でも "claude-fable-5"
 *  でも通る)なので、部分一致で fable 系と判定する。default agent が fable
 *  なら assignee 未設定のタスクもここに含まれる名前へ解決される(SQL 側の
 *  COALESCE)。registry なし → fable 判定は不可能、skip なし。 */
function fableAgentsResolver(board: BoardComposition): (() => string[]) | undefined {
  const { registryDir } = board;
  if (!registryDir) return undefined;
  return () =>
    Object.values(loadBoardRegistry(board).agents)
      .filter((agent) => agent.model?.toLowerCase().includes("fable"))
      .map((agent) => agent.name);
}

/** 指定された provider を喋ると宣言された agent 名の集合 (ADR 0097 決定2 /
 *  issue #446)、毎 poll registry から読み直す — 認証が失効した provider の
 *  agent だけが scheduler の資源単位 skip に落ちる。default agent が該当
 *  provider なら assignee 未設定のタスクもその名前へ解決される(SQL 側の
 *  COALESCE — fable 線と同じ形)。registry なし → provider は分からず skip
 *  なし。 */
function agentsSpeakingProvidersResolver(
  board: BoardComposition,
): ((providers: readonly Provider[]) => string[]) | undefined {
  const { registryDir } = board;
  if (!registryDir) return undefined;
  return (providers) =>
    Object.values(loadBoardRegistry(board).agents)
      // registry 側の provider は自由文字列のまま(ADR 0097 決定3 — 読み込みを
      // 倒さない)なので、ここでは文字列として突き合わせる
      .filter((agent) => (providers as readonly string[]).includes(agent.provider))
      .map((agent) => agent.name);
}

function agentsUsingUsageResourcesResolver(
  board: BoardComposition,
): ((resources: readonly ProviderUsageResource[]) => string[]) | undefined {
  if (!board.registryDir) return undefined;
  return (resources) =>
    Object.values(loadBoardRegistry(board).agents)
      .filter((agent) =>
        resources.some(
          (resource) =>
            resource.provider === agent.provider && resource.model === (agent.model ?? null),
        ),
      )
      .map((agent) => agent.name);
}

/** Resolves the executing task's own agent's authority profile (ADR 0012 /
 *  issue #36), read fresh against the registry every call from the task's own
 *  `assignee` (null → the board's default agent, `TIDEPOOL_AGENT`) — the
 *  delegation-aware successor to a single board-wide fixed profile, which
 *  every task shared regardless of who it was actually assigned to. An
 *  assignee the registry no longer knows (drift since the owning task's own
 *  session spawned) or whose definition no longer stands (InvalidAgentProviderError,
 *  ADR 0097) falls back to unrestricted here rather than throwing —
 *  the spawn-time gate (ClaudeCodeWorker.start) is what quarantines that.
 *  Without a registry, no agent's authority is knowable at all — unrestricted. */
function authorityResolver(
  board: BoardComposition,
): ((assignee: string | null) => AuthorityProfile | undefined) | undefined {
  const { registryDir, defaultAgentName } = board;
  if (!registryDir) return undefined;
  return (assignee) => {
    try {
      return resolveExecutionAgent(loadBoardRegistry(board), defaultAgentName, assignee).profile;
    } catch (err) {
      if (!(err instanceof UnknownAgentError) && !(err instanceof InvalidAgentProviderError)) {
        throw err;
      }
      return undefined;
    }
  };
}

/** Whether an agent name is currently registered (ADR 0012 / issue #36), read
 *  fresh against the registry — one half of an agent quarantine Confirmation
 *  question's clearance check (api.ts). Without a registry, no name is ever
 *  "back" — only "no more todo tasks depend on it" can clear it. */
function agentRegisteredChecker(board: BoardComposition): ((name: string) => boolean) | undefined {
  const { registryDir } = board;
  if (!registryDir) return undefined;
  // ownEntry, not `in`: `in` walks the prototype chain, so a name like
  // "toString" would clear an agent quarantine without any repair (issue #69)
  return (name) => ownEntry(loadBoardRegistry(board).agents, name) !== undefined;
}

/** Whether an explicitly named workspace is protected (issue #15 layer 2 /
 *  ADR 0013), read fresh against the registry — a decompose child naming a
 *  protected workspace converts to an approval question unconditionally
 *  (mcp.ts), and a task executing against one always asks before merging its
 *  PR (tasks.ts's recordPrOpened), regardless of the registering/executing
 *  worker's authority profile. Without a registry, no workspace is ever
 *  protected. */
function protectedWorkspaceChecker(
  board: BoardComposition,
): ((name: string) => boolean) | undefined {
  const { registryDir } = board;
  if (!registryDir) return undefined;
  // ownEntry for consistency with issue #69's sweep — a prototype hit would
  // already answer "not protected", but bare bracket access on registry
  // records is the exact pattern the sweep exists to remove
  return (name) => ownEntry(loadBoardRegistry(board).workspaces, name)?.protected === true;
}

/** The pull half of the roster (issue #43 / ADR 0014), read fresh against the
 *  registry — same pattern as agentRegisteredChecker. Without a registry
 *  there's nothing to list beyond list_agents's own fixed `human` line. */
function listAgentsResolver(board: BoardComposition): (() => RosterAgent[]) | undefined {
  const { registryDir } = board;
  if (!registryDir) return undefined;
  return () =>
    Object.values(loadBoardRegistry(board).agents).map((agent) => ({
      name: agent.name,
      description: agent.description,
    }));
}

/** Assignee/workspace candidates for the registration screen (issue #12).
 *  Without a registry there's nothing to suggest from. */
function registryCandidates(board: BoardComposition): RegistryCandidates | undefined {
  if (!board.registryDir) return undefined;
  const registry = loadBoardRegistry(board);
  const icons: Record<string, string> = {};
  for (const agent of Object.values(registry.agents)) {
    if (agent.icon !== undefined) icons[agent.name] = agent.icon;
  }
  return {
    assignees: [...Object.keys(registry.agents), "human"],
    workspaces: Object.keys(registry.workspaces),
    icons,
  };
}

/** DraftClient (issue #12's brain-dump-to-fields LLM draft), wired to the
 *  real Claude CLI (issue #25) only when a registry is configured — same
 *  registryDir gate as the worker factory. Without it there's no worker
 *  either, so the board runs the LoggingWorker with drafting off too. */
function draftClientFactory(board: BoardComposition): DraftClient | undefined {
  if (!board.registryDir) return undefined;
  return new ClaudeDraftClient({ candidates: registryCandidates(board) });
}

/** The settings surface's workspace verbs (issue #57), bound to this board's
 *  registry clone, base dir (ADR 0018) and GitHub client — the API layer only
 *  ever sees the finished callbacks. Without a registry there is nowhere to
 *  administer workspaces at all. */
function workspaceAdmin(
  board: BoardComposition,
  github: ServerOptions["github"],
): WorkspaceAdmin | undefined {
  const registry = registrySource(board);
  if (!registry) return undefined;
  // ADR 0040: 登録の門。床は pickup 側にあるが、正確な検査なので門で弾いてよい
  const deps = {
    registry,
    workspacesBaseDir: board.workspacesDir,
    githubAuth: board.githubAuth,
    boardState: board.boardState,
  };
  return {
    create: (input) => createWorkspace(input, { ...deps, github }),
    list: () => listWorkspaceViews(deps, board.workspacesDirSource),
    update: (input) => updateWorkspace(input, deps),
    // ADR 0066 決定2 / ADR 0067 決定8: push は `githubAuth` で撃ち、宛先への到達性
    // probe は `github` があるときだけ撃つ —— どちらも上の deps と同じ組である
    publish: (input) => publishWorkspace(input, { ...deps, github }),
    // ADR 0087: 参照検査の事実(件数・既定名)は API 層が足す —— registry 側の
    // deps だけをここで束ねる
    delete: (input, refs) => deleteWorkspace(input, { ...deps, ...refs }),
  };
}

/** The settings surface's agent verbs (issue #71), workspaceAdmin's twin:
 *  bound to this board's registry clone — the API layer only ever sees the
 *  finished callbacks. Without a registry there is nowhere to administer
 *  agents at all. */
function agentAdmin(board: BoardComposition): AgentAdmin | undefined {
  const registry = registrySource(board);
  if (!registry) return undefined;
  const deps = { registry, githubAuth: board.githubAuth };
  return {
    create: (input) => createAgent(input, deps),
    list: () => listAgentViews(deps),
    update: (input) => updateAgent(input, deps),
    delete: (input, refs) => deleteAgent(input, { ...deps, ...refs }),
    // registry-global, not per-agent (issue #71) — read directly here, same
    // posture as registryCandidates()/agentRegisteredChecker() above
    authorityProfiles: () => Object.keys(loadBoardRegistry(board).authority),
  };
}

/** The settings surface's profile verbs (issue #77), agentAdmin's twin: bound
 *  to this board's registry clone. The API layer runs the confirmation gate;
 *  these verbs only persist. Without a registry there is nowhere to administer
 *  profiles at all. */
function profileAdmin(board: BoardComposition): ProfileAdmin | undefined {
  const registry = registrySource(board);
  if (!registry) return undefined;
  const deps = { registry, githubAuth: board.githubAuth };
  return {
    create: (input) => createProfile(input, deps),
    list: () => listProfileViews(deps),
    update: (input) => updateProfile(input, deps),
    delete: (input) => deleteProfile(input, deps),
  };
}

/** 盤面1台ぶんの ServerOptions を組み立てる。**口の一覧を持つ唯一の場所**であり、
 *  そのために存在する(ADR 0041 / issue #172): main.ts は top-level await の
 *  スクリプトで、import した瞬間に盤面が起動する — 組み立てが向こうにある限り、
 *  本番がどの口を配線しているかをテストから観測する手段が無い。
 *
 *  ADR 0027 の線には触れない: server 境界の**上**にある合成の検査であって、
 *  境界の下に新しいテスト層を作る話ではない。 */
export async function buildServerOptions(board: BoardComposition): Promise<ServerOptions> {
  // ADR 0052 決定2: **registry を読む前に**起動時 refresh を撃つ。下の resolver
  // 群のうち `workspace` と draft の candidates はその場で読むので、順序が要件。
  await bootRefresh(board);
  // ADR 0024 / issue #50: token が無ければ識別情報も無く、GitHub 機能は
  // すべて fail-closed で off(以下の `github` が undefined になる)。
  const github = board.githubAuth && new GhCliClient(board.githubAuth);
  const workspace = workspaceConfig(board);
  const openaiUsage = createCodexAppServerProbe({
    executable: board.codexExecutable,
    codexHome: board.codexHome,
  });
  const codexContainment = workspace && createCodexCapabilityCheck({
    executable: board.codexExecutable,
    codexHome: board.codexHome,
    workspace: workspace.path,
    mcpUrl: `http://127.0.0.1:${board.mcpPort}/mcp`,
  });
  const claudeContainment = async (): Promise<ContainmentCapability> => {
    const sandbox = checkSandboxCapability(platform);
    return sandbox.available ? probeToolSurfaceCapability() : sandbox;
  };
  return {
    dbPath: board.dbPath,
    credential: board.credential,
    port: board.port,
    mcpPort: board.mcpPort,
    clock: board.clock,
    worker: buildWorkerFactory(board),
    workspace,
    resolveWorkspace: workspaceResolver(board),
    github,
    workspaceAdmin: workspaceAdmin(board, github),
    agentAdmin: agentAdmin(board),
    profileAdmin: profileAdmin(board),
    resolveAuthority: authorityResolver(board),
    agentRegistered: agentRegisteredChecker(board),
    isProtectedWorkspace: protectedWorkspaceChecker(board),
    listAgents: listAgentsResolver(board),
    // pass the provider itself, not a boot-time snapshot: the register screen's
    // candidates must reflect agents/workspaces created live through settings
    registryCandidates: () => registryCandidates(board),
    draftClient: draftClientFactory(board),
    translationClient: board.translationClient,
    // issue #14: 3点セットが揃わなければ push は off。公開鍵も同じ1つから導く
    // ので、「送れないのに購読だけできる」状態が構造的に作れない。
    push: board.vapid && new WebPushClient(board.vapid),
    vapidPublicKey: board.vapid?.publicKey,
    auditorName: board.auditorName,
    // the skills picker's candidate source (issue #106): the real `claude` CLI's
    // neutral-cwd enumeration — always available on a real host, faked in tests
    hostSkills: enumerateHostSkills,
    fableAgents: fableAgentsResolver(board),
    agentsSpeakingProviders: agentsSpeakingProvidersResolver(board),
    agentsUsingUsageResources: agentsUsingUsageResourcesResolver(board),
    openaiUsage,
    resolveUsageResource: usageResourceResolver(board),
    agentsUsingHarnesses: agentsUsingHarnessesResolver(board),
    resolveHarness: harnessResolver(board),
    harnessContainment: board.registryDir
      ? (harness) => harness === "codex"
        ? (codexContainment?.() ?? Promise.resolve({
            available: false as const,
            reason: "no execution workspace is configured for the Codex preflight",
          }))
        : claudeContainment()
      : undefined,
    registryReachability: registryReachabilityCheck(board),
    cliAuth: createClaudeCliAuthCheck(),
    // OpenAI is derived from the same App Server probe in server.ts; this
    // record supplies the Claude-harness Provider probes.
    providerCliAuth: { moonshot: createMoonshotCliAuthCheck(board.moonshotApiKeyFile) },
    cliAuthExpiresAt: board.cliAuthExpiresAt,
    // ADR 0093 / issue #211: remote 正本を宣言した workspace の pickup 直前の fetch は
    // `tidepool-board[bot]` 名義で撃つ。落とすと private な remote の workspace が黙って
    // quarantine に落ち続ける(fail-closed だが理由が「認証が無い」になる)。
    githubAuth: board.githubAuth,
    // ADR 0093 決定5: settings が「ログイン済みか」を毎回読み直す先。
    githubTokenFile: board.githubTokenFile,
    // ADR 0052 決定3 / issue #211: registry clone が workspace としても登録されている
    // ときの「2つの宣言」の突き合わせ先。registry が無い盤面には食い違う相手が無い。
    registry: registrySource(board),
    // ADR 0040 / issue #149: boot 時の一斉検査(該当を最初から needs-human に
    // するだけで、起動は拒まない)と、quarantine 解除の検証が撃ち直す先。
    // registryDir が無ければ workspace という概念自体が無いので列挙も無い。
    boardState: { paths: board.boardState, listWorkspaces: () => registeredWorkspaces(board) },
    // 封じ込め能力の fail-closed ゲート(ADR 0033 / issue #60、ADR 0036 / issue
    // #154、ADR 0039 / issue #164)。ここが唯一の実検査の配線点 — テスト盤面は
    // 封じ込める実プロセスを持たないので、このゲート自体を持たない。人間面の
    // 自己検査は startServer が実ポートを知った後に自分で足す。
    //
    // ツール面の問いは**関数のまま**渡す(結果のスナップショットではない): 検査は
    // 起動時・pickup ごと・quarantine の回答受理時に撃ち直され、解除の検証がその
    // 再実行に依っている(ADR 0039 決定3)。
    containment: {
      sandboxCapability: () => checkSandboxCapability(platform),
      toolSurface: () => probeToolSurfaceCapability(),
    },
    // ADR 0099 決定2/5: どの容器機構でこのホストの worker を封じるか。選ぶ場所が
    // 合成 root なのは、platform の判定が env の判定と同じ層だから — 上の
    // `checkSandboxCapability(platform)` と同じ1行の並びである。実測した機構が
    // 無い platform は fail-closed な機構を受け取り、boot 時の前提検査が pickup を
    // 止める(macOS の実測は #465)。
    containerRuntime: containerRuntimeFor(platform),
    watchdog: WATCHDOG,
  };
}
