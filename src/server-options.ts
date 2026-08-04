import { platform } from "node:process";
import { resolveExecutionAgent, UnknownAgentError } from "./agent.js";
import { type AgentAdmin, createAgent, listAgentViews, updateAgent } from "./agent-create.js";
import type { HumanCredential } from "./auth.js";
import type { BoardStatePath } from "./board-state.js";
import { ClaudeDraftClient } from "./claude-draft-client.js";
import { enumerateHostSkills, probeToolSurfaceCapability } from "./claude-worker.js";
import type { Clock } from "./clock.js";
import type { DraftClient } from "./draft.js";
import { GhCliClient } from "./github.js";
import type { GitHubAuth } from "./github-auth.js";
import {
  createProfile,
  listProfileViews,
  type ProfileAdmin,
  updateProfile,
} from "./profile-create.js";
import { type VapidConfig, WebPushClient } from "./push.js";
import {
  type AuthorityProfile,
  loadRegistry,
  ownEntry,
  type RegistryCandidates,
  type RosterAgent,
} from "./registry.js";
import { checkSandboxCapability } from "./sandbox.js";
import type { ServerOptions, WorkerFactory } from "./server.js";
import type { TranslationClient } from "./translate.js";
import type { WatchdogConfig } from "./watchdog.js";
import {
  listRegisteredWorkspaces,
  resolveExecutionWorkspace,
  type WorkspaceConfig,
} from "./workspace.js";
import {
  createWorkspace,
  listWorkspaceViews,
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
 *  - `work` = 90分。`/etc/default/tidepool` の `CLAUDE_STREAM_IDLE_TIMEOUT_MS` が
 *    10分(#33 / anthropics/claude-code#69238 の回避)なので、byte-idle 由来の
 *    ストールは CLI 側が拾う。拾えないのはループに入ったセッション —— バイトを
 *    出し続けるので idle 検知が効かず、watchdog だけが backstop になる。kill は
 *    失敗 question(retry / abandon)+ push に落ちる回復可能な事象なので、夜の
 *    8時間のうち最大90分の損失に抑える側へ倒す。
 *  - `review` = 45分。読んで判断する仕事で、work のような長い実装ループを持たない。
 *  - `question` は**意図的に無い**。`Partial<Record<TaskType, number>>` の口は
 *    「キーを書かない = 監視しない」で、人間の回答を待つタスクを時限で殺すのは
 *    端的に誤りである(そもそも question は slot の外で回答される)。
 *  - `grace` = 60秒 = 1 tick。SIGTERM から SIGKILL までの猶予で、watchdog.ts の
 *    比較は `>=` なので次の tick で SIGKILL が出る。 */
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
  /** registry が無ければ LoggingWorker、あれば実 CLI worker。`mkdirSync` を伴う
   *  ので合成 root 側で作る(この関数を I/O から切り離しておくため)。 */
  worker: WorkerFactory;
  /** agent registry のローカルクローン。未設定 → registry 由来の口はすべて不在。 */
  registryDir: string | undefined;
  /** この盤面が実行に使う workspace 名。 */
  workspaceName: string;
  /** ADR 0018: path を省いた workspace エントリが解決される基底ディレクトリ。 */
  workspacesDir: string;
  /** ADR 0012 / issue #36: assignee 未設定のタスクが解決される既定 agent。 */
  defaultAgentName: string;
  /** issue #15 layer 2 / CONTEXT.md の Auditor。 */
  auditorName: string;
  /** ADR 0040 / issue #149: 盤面自身の状態パス(プロセスで固定の5点)。 */
  boardState: BoardStatePath[];
  /** ADR 0024 / issue #50: 盤面の GitHub 識別情報。ファイルの読み取りは合成 root
   *  側の I/O なので、ここには解決済みの値だけが来る。未設定 → GitHub 機能は
   *  すべて fail-closed で off。 */
  githubAuth: GitHubAuth | undefined;
  /** issue #14: VAPID の3点セット。「3つ揃うか、1つも無いか」のゲートは env を
   *  読む合成 root 側にあり、ここは push クライアントと公開鍵の**両方**をこの
   *  1つから導く — 2つの口が別々の判定を持つと黙ってずれる。 */
  vapid: VapidConfig | undefined;
  /** issue #47 / ADR 0015: 表示時翻訳。盤面自身の CONTEXT.md を読んで作るので
   *  合成 root 側で組む。 */
  translationClient: TranslationClient;
}

/** The board's own view of the workspace (branch discipline + tree rule):
 *  the same registry entry the worker runs in, resolved to its path. */
function workspaceConfig(board: BoardComposition): WorkspaceConfig | undefined {
  if (!board.registryDir) return undefined;
  return resolveExecutionWorkspace(
    loadRegistry(board.registryDir),
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
    resolveExecutionWorkspace(loadRegistry(registryDir), workspaceName, taskWorkspace, workspacesDir);
}

/** ADR 0040 の boot 一斉検査の対象: 登録済み workspace 全件。他の resolver たちと
 *  同じく registry から fresh に読み直す(ADR 0009)。registry なし → workspace と
 *  いう概念自体が無い。 */
function registeredWorkspaces(board: BoardComposition): WorkspaceConfig[] {
  if (!board.registryDir) return [];
  return listRegisteredWorkspaces(loadRegistry(board.registryDir), board.workspacesDir);
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
    Object.values(loadRegistry(registryDir).agents)
      .filter((agent) => agent.model?.toLowerCase().includes("fable"))
      .map((agent) => agent.name);
}

/** Resolves the executing task's own agent's authority profile (ADR 0012 /
 *  issue #36), read fresh against the registry every call from the task's own
 *  `assignee` (null → the board's default agent, `TIDEPOOL_AGENT`) — the
 *  delegation-aware successor to a single board-wide fixed profile, which
 *  every task shared regardless of who it was actually assigned to. An
 *  assignee the registry no longer knows (drift since the owning task's own
 *  session spawned) falls back to unrestricted here rather than throwing —
 *  the spawn-time gate (ClaudeCodeWorker.start) is what quarantines that.
 *  Without a registry, no agent's authority is knowable at all — unrestricted. */
function authorityResolver(
  board: BoardComposition,
): ((assignee: string | null) => AuthorityProfile | undefined) | undefined {
  const { registryDir, defaultAgentName } = board;
  if (!registryDir) return undefined;
  return (assignee) => {
    try {
      return resolveExecutionAgent(loadRegistry(registryDir), defaultAgentName, assignee).profile;
    } catch (err) {
      if (!(err instanceof UnknownAgentError)) throw err;
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
  return (name) => ownEntry(loadRegistry(registryDir).agents, name) !== undefined;
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
  return (name) => ownEntry(loadRegistry(registryDir).workspaces, name)?.protected === true;
}

/** The pull half of the roster (issue #43 / ADR 0014), read fresh against the
 *  registry — same pattern as agentRegisteredChecker. Without a registry
 *  there's nothing to list beyond list_agents's own fixed `human` line. */
function listAgentsResolver(board: BoardComposition): (() => RosterAgent[]) | undefined {
  const { registryDir } = board;
  if (!registryDir) return undefined;
  return () =>
    Object.values(loadRegistry(registryDir).agents).map((agent) => ({
      name: agent.name,
      description: agent.description,
    }));
}

/** Assignee/workspace candidates for the registration screen (issue #12).
 *  Without a registry there's nothing to suggest from. */
function registryCandidates(board: BoardComposition): RegistryCandidates | undefined {
  if (!board.registryDir) return undefined;
  const registry = loadRegistry(board.registryDir);
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
  const { registryDir, githubAuth, boardState } = board;
  if (!registryDir) return undefined;
  // ADR 0040: 登録の門。床は pickup 側にあるが、正確な検査なので門で弾いてよい
  const deps = { registryDir, workspacesBaseDir: board.workspacesDir, githubAuth, boardState };
  return {
    create: (input) => createWorkspace(input, { ...deps, github }),
    list: () => listWorkspaceViews(deps),
    update: (input) => updateWorkspace(input, deps),
  };
}

/** The settings surface's agent verbs (issue #71), workspaceAdmin's twin:
 *  bound to this board's registry clone — the API layer only ever sees the
 *  finished callbacks. Without a registry there is nowhere to administer
 *  agents at all. */
function agentAdmin(board: BoardComposition): AgentAdmin | undefined {
  const { registryDir, githubAuth } = board;
  if (!registryDir) return undefined;
  const deps = { registryDir, githubAuth };
  return {
    create: (input) => createAgent(input, deps),
    list: () => listAgentViews(deps),
    update: (input) => updateAgent(input, deps),
    // registry-global, not per-agent (issue #71) — read directly here, same
    // posture as registryCandidates()/agentRegisteredChecker() above
    authorityProfiles: () => Object.keys(loadRegistry(registryDir).authority),
  };
}

/** The settings surface's profile verbs (issue #77), agentAdmin's twin: bound
 *  to this board's registry clone. The API layer runs the confirmation gate;
 *  these verbs only persist. Without a registry there is nowhere to administer
 *  profiles at all. */
function profileAdmin(board: BoardComposition): ProfileAdmin | undefined {
  const { registryDir, githubAuth } = board;
  if (!registryDir) return undefined;
  const deps = { registryDir, githubAuth };
  return {
    create: (input) => createProfile(input, deps),
    list: () => listProfileViews(deps),
    update: (input) => updateProfile(input, deps),
  };
}

/** 盤面1台ぶんの ServerOptions を組み立てる。**口の一覧を持つ唯一の場所**であり、
 *  そのために存在する(ADR 0041 / issue #172): main.ts は top-level await の
 *  スクリプトで、import した瞬間に盤面が起動する — 組み立てが向こうにある限り、
 *  本番がどの口を配線しているかをテストから観測する手段が無い。
 *
 *  ADR 0027 の線には触れない: server 境界の**上**にある合成の検査であって、
 *  境界の下に新しいテスト層を作る話ではない。 */
export function buildServerOptions(board: BoardComposition): ServerOptions {
  // ADR 0024 / issue #50: token が無ければ識別情報も無く、GitHub 機能は
  // すべて fail-closed で off(以下の `github` が undefined になる)。
  const github = board.githubAuth && new GhCliClient(board.githubAuth);
  return {
    dbPath: board.dbPath,
    credential: board.credential,
    port: board.port,
    mcpPort: board.mcpPort,
    clock: board.clock,
    worker: board.worker,
    workspace: workspaceConfig(board),
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
    watchdog: WATCHDOG,
  };
}
