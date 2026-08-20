import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openHumanCredential, resolvePublicOrigins, resolveTokenFile } from "./auth.js";
import { boardStatePaths } from "./board-state.js";
import { ClaudeTranslationClient } from "./claude-translation-client.js";
import { resolveCliAuthExpiry } from "./cli-auth.js";
import { SystemClock } from "./clock.js";
import {
  DEFAULT_AGENT_NAME,
  DEFAULT_AUDITOR_NAME,
  DEFAULT_WORKSPACE_NAME,
} from "./defaults.js";
import { loadGitHubAuth } from "./github-auth.js";
import { parseGlossary } from "./glossary.js";
import type { VapidConfig } from "./push.js";
import { startServer } from "./server.js";
import { buildServerOptions, declaredRegistryMode } from "./server-options.js";
import type { TranslationClient } from "./translate.js";
import { resolveWorkspacesBaseDir, workspacesBaseDirSource } from "./workspace.js";

const port = Number(process.env.PORT ?? 4589);
// /mcp's own 127.0.0.1-only port (issue #37) — kept off `port` so
// `tailscale serve <port>` never also publishes MCP tool calls
const mcpPort = Number(process.env.MCP_PORT ?? port + 1);
const registryDir = process.env.TIDEPOOL_REGISTRY;
const workspaceName = process.env.TIDEPOOL_WORKSPACE ?? DEFAULT_WORKSPACE_NAME;
// ADR 0018: base directory a path-omitting workspace entry derives from.
const workspacesDir = resolveWorkspacesBaseDir(process.env.TIDEPOOL_WORKSPACES_DIR);
// ADR 0082 決定2: 同じ env の値から出所も導く(登録の門が着地先に添えて見せる)。
const workspacesDirSource = workspacesBaseDirSource(process.env.TIDEPOOL_WORKSPACES_DIR);
// ADR 0012 / issue #36: TIDEPOOL_AGENT is a pointer to the board's default
// agent, not "the one worker" — an unspecified assignee resolves here, but a
// pre-set delegation to a different registry name overrides it per task
const defaultAgentName = process.env.TIDEPOOL_AGENT ?? DEFAULT_AGENT_NAME;
// issue #15 layer 2 / CONTEXT.md's Auditor: same shape as TIDEPOOL_AGENT
// above, a pointer to the board's independent-review agent.
const auditorName = process.env.TIDEPOOL_AUDITOR ?? DEFAULT_AUDITOR_NAME;

// this board's own CONTEXT.md (issue #47): resolved against the module's own
// file location, not process.cwd(), so it finds the checkout regardless of
// where the process was launched from — same posture as server.ts's static
// `root` (dirname(fileURLToPath(import.meta.url)) + "..").
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ADR 0040 / issue #149: 盤面自身の状態パスは**1箇所で読む**。DB と worker-logs は
// これまで使う場所(startServer 呼び出し / workerFactory)で env を読んでいたが、
// 重なりガードが同じ値を見る以上、綴りが2つあると守る対象と実際の置き場が黙って
// ずれる。既定は cwd 相対のまま残す(ADR 0040: cwd 全体が保護対象になった今、
// 既定を動かしても罠の表面積は縮まらない)。
const dbPath = process.env.TIDEPOOL_DB ?? "board.sqlite";
const logDir = process.env.TIDEPOOL_WORKER_LOGS ?? "worker-logs";
const apiTokenFile = resolveTokenFile(process.env.TIDEPOOL_API_TOKEN_FILE);
// env 未設定 = 盤面に GitHub 識別情報が無い(ADR 0024)ので守る対象も無い。
// **githubAuth の有無ではなく env の有無で見る**: mode が 600 でなくて識別情報が
// 立たなかった場合でも、平文のファイルはそこに在る。
const githubTokenFile = process.env.TIDEPOOL_GITHUB_TOKEN_FILE;
const boardState = boardStatePaths({
  dbPath,
  workerLogDir: logDir,
  apiTokenFile,
  githubTokenFile,
  // 5点目の「盤面の実行 checkout」は2つの綴りを持つ(ADR 0040): 既定の状態パスが
  // 相対で解決される先は cwd、`public/` を実際に配信するのは server.ts が
  // モジュールの位置から導く checkout(= repoRoot)。リポジトリ外から起動すれば
  // 両者は一致しないので、cwd だけ守ると配信元が無防備になる。
  cwd: process.cwd(),
  servedRoot: repoRoot,
});

// ADR 0043 / issue #33: worker options の口の一覧も server-options.ts が持つ。
// ここに残るのはホストの副作用だけ —— ディレクトリの作成そのもの。registry 未設定
// なら実 worker は立たないので(合成側が LoggingWorker に落ちる)作る必要もない。
if (registryDir) mkdirSync(logDir, { recursive: true });

// issue #33 判断8: advisor のグローバル kill switch。registry ではなく**ホストの
// 運用設定**に置く —— エージェントの定義ではなく、experimental な機能を全員に配る
// 代償としての緊急マスクであり、advisor 側の障害・仕様変更時に agent.md を1枚も
// 触らずに全 worker を止めるための口。既定は off。
const advisorDisabled = process.env.TIDEPOOL_DISABLE_ADVISOR === "1";

/** CONTEXT.md's own `## Term(日本語)` pairs (issue #47), parsed once at boot
 *  for the translation client's prompt. Absent/unreadable CONTEXT.md → no
 *  glossary guidance rather than a boot failure — the glossary sharpens
 *  translation quality, it isn't required for the feature to function. */
function boardGlossary(): ReturnType<typeof parseGlossary> {
  try {
    return parseGlossary(readFileSync(join(repoRoot, "CONTEXT.md"), "utf8"));
  } catch {
    return [];
  }
}

/** TranslationClient (issue #47 / ADR 0015's display-time translation),
 *  wired to the real Claude CLI. Unlike the draft client, this needs no
 *  registry — only the `claude` CLI and the board's own CONTEXT.md — so it's
 *  always configured, never gated. */
function translationClientFactory(): TranslationClient {
  return new ClaudeTranslationClient({ glossary: boardGlossary() });
}

/** Web Push (issue #14): all three VAPID env vars must be set together, or
 *  push stays off — a partial configuration would silently drop every send.
 *  The single value both the push client and the API's vapidPublicKey option
 *  are derived from, so the "all three or none" gate is never checked twice. */
function vapidConfig(): VapidConfig | undefined {
  const subject = process.env.TIDEPOOL_VAPID_SUBJECT;
  const publicKey = process.env.TIDEPOOL_VAPID_PUBLIC_KEY;
  const privateKey = process.env.TIDEPOOL_VAPID_PRIVATE_KEY;
  if (!subject || !publicKey || !privateKey) return undefined;
  return { subject, publicKey, privateKey };
}

// ADR 0036 / issue #153: 人間面の credential。盤面が持つのはハッシュだけで、
// 平文は生成した瞬間に一度表示されるだけ — process.env には**載せない**
// (claude-worker.ts の spawn は `{ ...process.env }` を worker に渡す)。
// cookie はオリジン単位なので、盤面は自分が公開されている URL を知っている必要が
// ある(自力では導出できない)。Pi なら tailnet の公開 URL をここに設定する。
const { credential, messages } = openHumanCredential({
  tokenFile: apiTokenFile,
  origins: resolvePublicOrigins(process.env.TIDEPOOL_PUBLIC_ORIGINS, port),
});
for (const message of messages) {
  if (message.level === "error") console.error(message.text);
  else console.log(message.text);
}

// ADR 0041 / issue #172: ここは env とホストの副作用だけを引き受ける殻で、
// **ServerOptions の口の一覧は持たない** —— 一覧を持てば、任意フィールドを1つ
// 渡し忘れても型もテストも何も言わない(watchdog が本番で一度も走っていなかった
// のがその形)。口の一覧は server-options.ts が単独で持ち、テストがそれを観測する。
const server = await startServer(
  buildServerOptions({
    dbPath,
    port,
    mcpPort,
    credential,
    clock: new SystemClock(),
    registryDir,
    registryMode: declaredRegistryMode(registryDir),
    logDir,
    advisorDisabled,
    workspaceName,
    workspacesDir,
    workspacesDirSource,
    defaultAgentName,
    auditorName,
    boardState,
    // ADR 0024 / issue #50: the board's GitHub identity is the machine-user
    // token in this mode-600 secrets file — no file, no identity. The token
    // itself never enters process.env: workers inherit that wholesale.
    githubAuth: loadGitHubAuth(githubTokenFile),
    vapid: vapidConfig(),
    translationClient: translationClientFactory(),
    cliAuthExpiresAt: resolveCliAuthExpiry(process.env.TIDEPOOL_CLAUDE_TOKEN_EXPIRES_AT),
  }),
);
console.log(`tidepool listening on http://127.0.0.1:${server.port}`);
console.log(`  /mcp listening on http://127.0.0.1:${server.mcpPort}/mcp`);
