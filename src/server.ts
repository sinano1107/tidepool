import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { AgentAdmin } from "./agent-create.js";
import { createApiRouter } from "./api.js";
import { createHumanSurfaceAuth, type HumanCredential } from "./auth.js";
import type { Clock } from "./clock.js";
import { type Db, openDb } from "./db.js";
import type { DraftClient } from "./draft.js";
import type { GitHubClient } from "./github.js";
import { createMcpRouter, promoteHandoffPr } from "./mcp.js";
import { checkPendingAutoMerges } from "./merge.js";
import type { ProfileAdmin } from "./profile-create.js";
import { createNotificationTick, type PushClient } from "./push.js";
import type { AuthorityProfile, RegistryCandidates, RosterAgent } from "./registry.js";
import { type SandboxCapability, sandboxPickupBlocked } from "./sandbox.js";
import { startScheduler } from "./scheduler.js";
import { Slot } from "./slot.js";
import { DEFAULT_AUDITOR_NAME, getTask } from "./tasks.js";
import type { TranslationClient } from "./translate.js";
import { autoCommitStaleTriage } from "./triage.js";
import { failTask, startWatchdog, type WatchdogConfig } from "./watchdog.js";
import type { WorkerAdapter } from "./worker.js";
import { buildWorkspaceResolver, type WorkspaceConfig } from "./workspace.js";
import type { WorkspaceAdmin } from "./workspace-create.js";

/** The real adapter needs the board's own db and clock, which are created in
 *  here — so the worker arrives as a factory fed with them. */
export type WorkerFactory = (deps: { db: Db; clock: Clock }) => WorkerAdapter;

export interface ServerOptions {
  dbPath: string;
  port: number;
  /** `/mcp`'s own port, always bound to 127.0.0.1 (issue #37): kept off
   *  `port` so `tailscale serve` can publish web/`/api`/static files without
   *  also exposing MCP tool calls to the rest of the tailnet. */
  mcpPort: number;
  /** ADR 0036 / issue #153: 人間面(静的資産・`/api`・そこに mount される
   *  管理MCP)を守る単一の盤面秘密のハッシュ源。**省略可にはしない** — 「口が
   *  空いていれば無認証」は本番が事故で裸になる形であり、この不変条件を
   *  ホストごとの設定に委ねないのが ADR 0036 のスコープ判断そのもの。
   *  Worker MCP(`mcpPort` 側)には掛からない。 */
  credential: HumanCredential;
  clock: Clock;
  worker: WorkerFactory;
  /** The board's workspace: a git checkout the branch discipline and the
   *  slot-release tree rule act on. Absent → a workspaceless board (e.g. a
   *  human-driven one): no branch rule runs. */
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call. Absent → every task runs against the
   *  board's single fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** Per-task-type absolute time limits (#9). Absent → no watchdog runs. */
  watchdog?: WatchdogConfig;
  /** The GitHub-facing seam (issue #19): a work task's completion is promoted
   *  to a PR through here. Absent → no PR is ever opened. */
  github?: GitHubClient;
  /** This board's one configured worker's authority profile (issue #11) — the
   *  n=1 board runs a single worker at a time (ADR-adjacent design principle
   *  #8), so this is one fixed profile rather than a per-task registry
   *  lookup. Absent → assignable_to is unrestricted. Superseded by
   *  `resolveAuthority` below when both are given. */
  authority?: AuthorityProfile;
  /** Resolves the executing task's own agent's authority profile (ADR 0012 /
   *  issue #36), read fresh every call from `task.assignee` (null → the
   *  board's default agent) — the delegation-aware successor to the single
   *  fixed `authority` above, which every task shared regardless of who it
   *  was actually assigned to. Absent → falls back to `authority`. */
  resolveAuthority?: (assignee: string | null) => AuthorityProfile | undefined;
  /** Assignee/workspace candidates for the registration screen (issue #12) —
   *  a provider called per request so settings-surface creations surface
   *  without a restart. Absent → no registry configured, no suggestions. */
  registryCandidates?: () => RegistryCandidates | undefined;
  /** The LLM draft seam (issue #12). Absent → the draft endpoint reports the
   *  LLM as unreachable, and the WebUI falls back to the plain form. */
  draftClient?: DraftClient;
  /** Whether an agent name is currently registered (ADR 0012 / issue #36),
   *  read fresh against the registry by the caller — one half of an agent
   *  quarantine Confirmation question's clearance check (api.ts). Absent →
   *  only "no more todo tasks depend on it" can ever clear it. */
  agentRegistered?: (name: string) => boolean;
  /** The Web Push-facing seam (issue #14): a question task's registration is
   *  promoted to an immediate push through here, outside quiet hours. Absent
   *  → no push is ever sent, questions simply accumulate unnotified. */
  push?: PushClient;
  /** The public half of the board's VAPID keypair (issue #14), exposed to the
   *  WebUI via /api/push/vapid-public-key. Absent → the WebUI can't subscribe. */
  vapidPublicKey?: string;
  /** The board's Auditor pointer (CONTEXT.md / issue #15 layer 2) — same
   *  shape as the default agent (`worker.id` below): the fallback a `review`
   *  task's unset `assignee` resolves to, at pickup (scheduler), spawn
   *  (claude-worker.ts via `resolveExecutionAgent`), and MCP attribution
   *  (mcp.ts) alike, in place of the default agent (issue #42). Absent →
   *  `DEFAULT_AUDITOR_NAME` — CONTEXT.md's Auditor never reads as unset,
   *  resolved once here rather than by each consumer separately. */
  auditorName?: string;
  /** Whether an explicitly named workspace is protected (CONTEXT.md's
   *  protected workspace / ADR 0013), read fresh against the registry by the
   *  caller — a decompose child naming a protected workspace converts to an
   *  approval question unconditionally (mcp.ts), regardless of the
   *  registering worker's authority profile. Absent → no workspace is
   *  protected. */
  isProtectedWorkspace?: (name: string) => boolean;
  /** Agent names whose registry model is fable (ADR 0030), read fresh by
   *  the scheduler's fable line and the queue view. Absent → no registry
   *  configured, so the fable line can't attribute tasks and skips nothing. */
  fableAgents?: () => string[];
  /** The pull half of the roster (issue #43 / ADR 0014), read fresh against
   *  the registry by the caller — same pattern as `agentRegistered`. Absent
   *  → no registry configured, so `list_agents` reports only `human`. */
  listAgents?: () => RosterAgent[];
  /** The settings surface's workspace verbs (issue #57), bound to the
   *  registry clone / base dir / GitHub client by main.ts. Absent → no
   *  registry configured; the /api/workspaces routes report 503. */
  workspaceAdmin?: Partial<WorkspaceAdmin>;
  /** The settings surface's agent verbs (issue #71), workspaceAdmin's twin —
   *  bound to the registry clone by main.ts. Absent → no registry configured;
   *  the /api/agents routes report 503. */
  agentAdmin?: Partial<AgentAdmin>;
  /** The settings surface's profile verbs (issue #77), agentAdmin's twin —
   *  bound to the registry clone by main.ts. Absent → no registry configured;
   *  the /api/profiles routes report 503. */
  profileAdmin?: Partial<ProfileAdmin>;
  /** The skills picker's candidate source (issue #106 / ADR 0025 点4), bound by
   *  main.ts to the adapter's neutral-cwd /usage ping. Absent → GET /api/skills
   *  degrades to an empty candidate set (never 503). */
  hostSkills?: () => Promise<string[] | null>;
  /** The display-time translation seam (issue #47 / ADR 0015). Absent →
   *  POST /api/translate reports the LLM as unreachable. */
  translationClient?: TranslationClient;
  /** ADR 0033 の fail-closed ゲート: このホストで worker サンドボックスが実際に
   *  使えるか。boot 時と pickup ごと、そして quarantine の回答受理時に読み直す。
   *  Absent → 実プロセスを持たないテスト盤面の既定(そこに spawn される実 CLI は
   *  そもそも無い); main.ts は常に実検査を渡す。 */
  sandboxCapability?: () => SandboxCapability;
}

export interface TidepoolServer {
  port: number;
  mcpPort: number;
  stop: () => Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<TidepoolServer> {
  const db = openDb(options.dbPath);
  const slot = new Slot();
  // a restart interrupts any running task (ADR 0001): it drops into the same
  // failure-escalation path as a watchdog kill, so the slot never wedges past
  // a restart (#9) — no graceful-drain machinery exists or is needed
  const interrupted = db
    .prepare("SELECT id FROM tasks WHERE status = 'in_progress'")
    .get() as { id: string } | undefined;
  if (interrupted) {
    const task = getTask(db, interrupted.id)!;
    failTask(
      db,
      task,
      `restart interrupted task: ${task.title}`,
      "the server restarted while this task was in progress; no self-report is " +
        "possible (ADR 0001: a restart never drains gracefully).",
      buildWorkspaceResolver(options.resolveWorkspace, options.workspace),
      options.clock.now(),
    );
  }
  const app = express();
  // ADR 0036 / issue #153: 人間面の credential。**app への登録より前**に置くのが
  // 射程の担保 — 以降 `app` に何が生えても(将来の管理MCP mount を含む)、この
  // 1本を通らずに到達できるルートは存在しない。bootstrap だけが手前に立つ。
  // **`mcpApp` には絶対に掛けない**: 掛けると全 worker が死ぬ。
  const auth = createHumanSurfaceAuth(options.credential);
  app.use(auth.bootstrap);
  app.use(auth.require);
  // credential の**後**に置く: 無認証リクエストは 415 ではなく 401 で落ちる
  app.use(auth.requireJsonContentType);
  const worker = options.worker({ db, clock: options.clock });
  // resolved here for this board's actual wiring, same as `worker.id` below
  // — CONTEXT.md's Auditor never reads as unset (issue #42). Consumers built
  // directly rather than through startServer (e.g. a unit test constructing
  // McpDeps by hand) still carry their own `?? DEFAULT_AUDITOR_NAME` fallback
  // (mcp.ts's attributedWorkerId, claude-worker.ts's start()) — same
  // defense-in-depth `defaultAgentName ?? HUMAN_WORKER_ID` already relies on.
  const auditorName = options.auditorName ?? DEFAULT_AUDITOR_NAME;
  // ADR 0033: 起動時にも一度検査する — pickup 時だけだと、依存を失ったまま再起動
  // した盤面は次の poll(最大1時間後)まで「止まっている理由」を出さない。
  // 副作用は pickup ゲートと同一の関数なので、question は多くとも1枚に収まる。
  const { sandboxCapability } = options;
  // 戻り値は捨てる — boot 時点では止める相手(pickup poll)がまだ走っておらず、
  // 欲しいのは副作用の question だけ。実際の停止は同じ関数を呼ぶ pickup ゲート。
  if (sandboxCapability) void sandboxPickupBlocked(db, sandboxCapability, options.clock.now());
  const scheduler = startScheduler({
    db,
    clock: options.clock,
    slot,
    worker,
    workspace: options.workspace,
    resolveWorkspace: options.resolveWorkspace,
    auditorName,
    github: options.github,
    fableAgents: options.fableAgents,
    sandboxCapability,
  });
  // an abandoned triage session may not pause pickup forever: the watchdog
  // auto-commits it past the timeout, and the commit is a "run now" trigger
  const stopTriageWatchdog = options.clock.setInterval(() => {
    if (autoCommitStaleTriage(db, options.clock.now())) scheduler.pollNow();
  }, 60 * 1000);
  const watchdog = options.watchdog
    ? startWatchdog({
        db,
        clock: options.clock,
        slot,
        worker,
        workspace: options.workspace,
        resolveWorkspace: options.resolveWorkspace,
        config: options.watchdog,
      })
    : undefined;
  // the auto_if_ci_green poll (issue #11): independent of the scheduler's
  // pickup poll, since it watches external CI state rather than the queue.
  // A no-op tick while pending_auto_merges is empty, same shape as the
  // triage watchdog above.
  const autoMergeWorkspaceResolver = buildWorkspaceResolver(
    options.resolveWorkspace,
    options.workspace,
  );
  const stopAutoMergePoll =
    autoMergeWorkspaceResolver && options.github
      ? options.clock.setInterval(() => {
          void checkPendingAutoMerges(
            db,
            options.github!,
            autoMergeWorkspaceResolver,
            options.clock.now(),
          );
        }, 60 * 1000)
      : undefined;
  // question push notifications (issue #14): a poll rather than a hook at
  // every registerTask call site, same shape as the two polls above. Tracks
  // the quiet-hours boundary itself so crossing it folds everything
  // accumulated overnight into one morning digest instead of a push per
  // question (createNotificationTick).
  const notificationTick = createNotificationTick(db, options.push, options.clock.now());
  const stopNotificationPoll = options.clock.setInterval(() => {
    void notificationTick.run(options.clock.now());
  }, 60 * 1000);
  // one deps object for both MCP-side promotion paths: the MCP router's
  // completion-time attempt and the answer route's synchronous retry (issue
  // #66) — the retry is the same promotion under the same identity, so the
  // two must not drift apart field by field
  const mcpDeps = {
    db,
    slot,
    clock: options.clock,
    workspace: options.workspace,
    resolveWorkspace: options.resolveWorkspace,
    github: options.github,
    authority: options.authority,
    resolveAuthority: options.resolveAuthority,
    defaultAgentName: worker.id,
    auditorName,
    agentRegistered: options.agentRegistered,
    isProtectedWorkspace: options.isProtectedWorkspace,
    listAgents: options.listAgents,
  };
  app.use(
    "/api",
    createApiRouter({
      db,
      clock: options.clock,
      onQueueHeadChanged: () => scheduler.pollNow(),
      workspace: options.workspace,
      resolveWorkspace: options.resolveWorkspace,
      github: options.github,
      retryPrPromotion: (task) => promoteHandoffPr(mcpDeps, task),
      registryCandidates: options.registryCandidates,
      draftClient: options.draftClient,
      defaultAgentName: worker.id,
      agentRegistered: options.agentRegistered,
      sandboxCapability,
      vapidPublicKey: options.vapidPublicKey,
      auditorName,
      workspaceAdmin: options.workspaceAdmin,
      agentAdmin: options.agentAdmin,
      profileAdmin: options.profileAdmin,
      hostSkills: options.hostSkills,
      translationClient: options.translationClient,
      fableAgents: options.fableAgents,
      isProtectedWorkspace: options.isProtectedWorkspace,
    }),
  );
  // its own app/port (issue #37): `/mcp` never shares `port`, so publishing
  // `port` via `tailscale serve` can never also expose MCP tool calls
  const mcpApp = express();
  mcpApp.use("/mcp", createMcpRouter(mcpDeps));
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  app.use(express.static(join(root, "public")));
  // the WebUI is the design-synced UI kit: screens come straight from the kit
  // (single source, the /kit mock stays runnable), tokens and the compiled
  // component bundle from the design-system mirror at the repo root
  app.use("/kit", express.static(join(root, "ui_kits", "tidepool-webui")));
  app.use("/tokens", express.static(join(root, "tokens")));
  // sendFile with the `root` option (not a pre-joined absolute path): Express's
  // `send` then dotfile-checks only the URL's relative segment, so a board booted
  // from a checkout under a dot-directory (a git worktree in `.claude/…`) still
  // serves these. A pre-joined absolute path gets the whole path dotfile-checked
  // and `dotfiles: 'ignore'` 404s it (issue #108) — same `root`-option path
  // express.static above already relies on.
  app.get("/styles.css", (_req, res) => res.sendFile("styles.css", { root }));
  app.get("/_ds_bundle.js", (_req, res) => res.sendFile("_ds_bundle.js", { root }));

  const listener = await new Promise<import("node:http").Server>((resolve) => {
    const l = app.listen(options.port, "127.0.0.1", () => resolve(l));
  });
  const mcpListener = await new Promise<import("node:http").Server>((resolve) => {
    const l = mcpApp.listen(options.mcpPort, "127.0.0.1", () => resolve(l));
  });

  return {
    port: (listener.address() as AddressInfo).port,
    mcpPort: (mcpListener.address() as AddressInfo).port,
    stop: () =>
      new Promise((resolve, reject) => {
        stopTriageWatchdog();
        stopAutoMergePoll?.();
        stopNotificationPoll();
        watchdog?.stop();
        scheduler.stop();
        listener.close((err) => {
          if (err) return reject(err);
          mcpListener.close((err2) => (err2 ? reject(err2) : resolve()));
        });
        db.close();
      }),
  };
}
