import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApiRouter } from "./api.js";
import type { Clock } from "./clock.js";
import { type Db, openDb } from "./db.js";
import type { DraftClient } from "./draft.js";
import type { GitHubClient } from "./github.js";
import { createMcpRouter } from "./mcp.js";
import { checkPendingAutoMerges } from "./merge.js";
import { createNotificationTick, type PushClient } from "./push.js";
import type { AuthorityProfile, RegistryCandidates } from "./registry.js";
import { startScheduler } from "./scheduler.js";
import { Slot } from "./slot.js";
import { getTask } from "./tasks.js";
import { autoCommitStaleTriage } from "./triage.js";
import { failTask, startWatchdog, type WatchdogConfig } from "./watchdog.js";
import type { WorkerAdapter } from "./worker.js";
import { buildWorkspaceResolver, type WorkspaceConfig } from "./workspace.js";

/** The real adapter needs the board's own db and clock, which are created in
 *  here — so the worker arrives as a factory fed with them. */
export type WorkerFactory = (deps: { db: Db; clock: Clock }) => WorkerAdapter;

export interface ServerOptions {
  dbPath: string;
  port: number;
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
  /** Assignee/workspace candidates for the registration screen (issue #12).
   *  Absent → no registry configured, so the WebUI gets no suggestions. */
  registryCandidates?: RegistryCandidates;
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
}

export interface TidepoolServer {
  port: number;
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
  const worker = options.worker({ db, clock: options.clock });
  const scheduler = startScheduler({
    db,
    clock: options.clock,
    slot,
    worker,
    workspace: options.workspace,
    resolveWorkspace: options.resolveWorkspace,
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
  app.use(
    "/api",
    createApiRouter({
      db,
      clock: options.clock,
      onQueueHeadChanged: () => scheduler.pollNow(),
      workspace: options.workspace,
      resolveWorkspace: options.resolveWorkspace,
      github: options.github,
      registryCandidates: options.registryCandidates,
      draftClient: options.draftClient,
      defaultAgentName: worker.id,
      agentRegistered: options.agentRegistered,
      vapidPublicKey: options.vapidPublicKey,
    }),
  );
  app.use(
    "/mcp",
    createMcpRouter({
      db,
      slot,
      clock: options.clock,
      workspace: options.workspace,
      resolveWorkspace: options.resolveWorkspace,
      github: options.github,
      authority: options.authority,
      resolveAuthority: options.resolveAuthority,
      defaultAgentName: worker.id,
      agentRegistered: options.agentRegistered,
    }),
  );
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  app.use(express.static(join(root, "public")));
  // the WebUI is the design-synced UI kit: screens come straight from the kit
  // (single source, the /kit mock stays runnable), tokens and the compiled
  // component bundle from the design-system mirror at the repo root
  app.use("/kit", express.static(join(root, "ui_kits", "tidepool-webui")));
  app.use("/tokens", express.static(join(root, "tokens")));
  app.get("/styles.css", (_req, res) => res.sendFile(join(root, "styles.css")));
  app.get("/_ds_bundle.js", (_req, res) => res.sendFile(join(root, "_ds_bundle.js")));

  const listener = await new Promise<import("node:http").Server>((resolve) => {
    const l = app.listen(options.port, "127.0.0.1", () => resolve(l));
  });

  return {
    port: (listener.address() as AddressInfo).port,
    stop: () =>
      new Promise((resolve, reject) => {
        stopTriageWatchdog();
        stopAutoMergePoll?.();
        stopNotificationPoll();
        watchdog?.stop();
        scheduler.stop();
        listener.close((err) => (err ? reject(err) : resolve()));
        db.close();
      }),
  };
}
