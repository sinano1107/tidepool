import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openHumanCredential, resolvePublicOrigins, resolveTokenFile } from "./auth.js";
import { boardStatePaths } from "./board-state.js";
import { ClaudeTranslationClient } from "./claude-translation-client.js";
import { ClaudeCodeWorker } from "./claude-worker.js";
import { SystemClock } from "./clock.js";
import { loadGitHubAuth } from "./github-auth.js";
import { parseGlossary } from "./glossary.js";
import type { VapidConfig } from "./push.js";
import { startServer, type WorkerFactory } from "./server.js";
import { buildServerOptions } from "./server-options.js";
import { DEFAULT_AUDITOR_NAME, type Task } from "./tasks.js";
import type { TranslationClient } from "./translate.js";
import type { KillSignal, WorkerAdapter } from "./worker.js";
import { resolveWorkspacesBaseDir } from "./workspace.js";

/** Fallback when no registry clone is configured: logs the pickup so a human
 *  can drive the MCP verbs by hand. */
class LoggingWorker implements WorkerAdapter {
  readonly id = "logging-worker";
  start(task: Task): void {
    console.log(`[worker] picked up ${task.id}: ${task.title}`);
  }
  kill(taskId: string, signal: KillSignal): void {
    console.log(`[worker] would send ${signal} to ${taskId}`);
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

const port = Number(process.env.PORT ?? 4589);
// /mcp's own 127.0.0.1-only port (issue #37) — kept off `port` so
// `tailscale serve <port>` never also publishes MCP tool calls
const mcpPort = Number(process.env.MCP_PORT ?? port + 1);
const registryDir = process.env.TIDEPOOL_REGISTRY;
const workspaceName = process.env.TIDEPOOL_WORKSPACE ?? "sandbox";
// ADR 0018: base directory a path-omitting workspace entry derives from.
const workspacesDir = resolveWorkspacesBaseDir(process.env.TIDEPOOL_WORKSPACES_DIR);
// ADR 0012 / issue #36: TIDEPOOL_AGENT is a pointer to the board's default
// agent, not "the one worker" — an unspecified assignee resolves here, but a
// pre-set delegation to a different registry name overrides it per task
const defaultAgentName = process.env.TIDEPOOL_AGENT ?? "tako";
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

/** TIDEPOOL_REGISTRY points at a local clone of the agent registry repository
 *  (`npm run start:live` supplies the conventional one); setting it swaps the
 *  logging placeholder for the real Claude Code worker. */
function workerFactory(): WorkerFactory {
  if (!registryDir) return () => new LoggingWorker();
  mkdirSync(logDir, { recursive: true });
  return ({ db, clock }) =>
    new ClaudeCodeWorker({
      db,
      clock,
      registryDir,
      agent: defaultAgentName,
      auditorName,
      workspace: workspaceName,
      workspacesDir,
      mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
      logDir,
      // ADR 0040: 床そのもの — 重なっている workspace では spawn せず quarantine
      boardState,
    });
}

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
    worker: workerFactory(),
    registryDir,
    workspaceName,
    workspacesDir,
    defaultAgentName,
    auditorName,
    boardState,
    // ADR 0024 / issue #50: the board's GitHub identity is the machine-user
    // token in this mode-600 secrets file — no file, no identity. The token
    // itself never enters process.env: workers inherit that wholesale.
    githubAuth: loadGitHubAuth(githubTokenFile),
    vapid: vapidConfig(),
    translationClient: translationClientFactory(),
  }),
);
console.log(`tidepool listening on http://127.0.0.1:${server.port}`);
console.log(`  /mcp listening on http://127.0.0.1:${server.mcpPort}/mcp`);
