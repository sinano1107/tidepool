import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentAdmin } from "../src/agent-create.js";
import { type Db, openDb } from "../src/db.js";
import type { DraftClient } from "../src/draft.js";
import type { ProfileAdmin } from "../src/profile-create.js";
import type { AuthorityProfile, RegistryCandidates, RosterAgent } from "../src/registry.js";
import { startServer } from "../src/server.js";
import { BOARD_WORKER_ID, type RegisterTaskInput, registerTask, type Task } from "../src/tasks.js";
import type { TranslationClient } from "../src/translate.js";
import type { WatchdogConfig } from "../src/watchdog.js";
import type { WorkspaceConfig } from "../src/workspace.js";
import type { WorkspaceAdmin } from "../src/workspace-create.js";
import { FakeClock, FakeGitHubClient, FakePushClient, ScriptedWorker } from "./fakes.js";

export { HOURLY as HOUR } from "../src/scheduler.js";

export interface Tidepool {
  baseUrl: string;
  /** `/mcp`'s own base URL (issue #37) — separate from `baseUrl` now that
   *  `/mcp` lives on its own port, off the one `tailscale serve` would
   *  publish. */
  mcpBaseUrl: string;
  clock: FakeClock;
  worker: ScriptedWorker;
  github: FakeGitHubClient;
  push: FakePushClient;
  dir: string;
  /** Shut down the process only, keeping the SQLite file — for restart tests. */
  stopServer: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface BootOptions {
  /** Existing board dir to reboot on — for restart tests. */
  dir?: string;
  /** The board's workspace: a real git checkout the tree rule acts on. */
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009). Absent → every task runs against the single `workspace`
   *  above. */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** Per-task-type absolute time limits (#9). */
  watchdog?: WatchdogConfig;
  /** This board's one worker's authority profile (issue #11). */
  authority?: AuthorityProfile;
  /** Resolves the executing task's own agent's authority profile (ADR 0012 /
   *  issue #36), read fresh every call from `task.assignee` (null → the
   *  board's default agent). Takes precedence over the static `authority`
   *  above when both are given. Absent → falls back to `authority`. */
  resolveAuthority?: (assignee: string | null) => AuthorityProfile | undefined;
  /** Whether an agent name is currently registered (ADR 0012 / issue #36),
   *  read fresh against the registry — used both for registration-time
   *  validation and an agent quarantine Confirmation question's clearance
   *  check. Absent → no registry configured, so any name is accepted at
   *  registration and only "no more todo tasks depend on it" can clear a
   *  quarantine. */
  agentRegistered?: (name: string) => boolean;
  /** Assignee/workspace candidates for the registration screen (issue #12).
   *  A static snapshot (the common case) or a per-request provider — the
   *  latter lets a test prove the endpoint re-reads each call (issue #78). */
  registryCandidates?: RegistryCandidates | (() => RegistryCandidates | undefined);
  /** The LLM draft seam (issue #12). Absent (the default) — same as no LLM
   *  configured, matching the "LLM outage" fallback path. */
  draftClient?: DraftClient;
  /** The display-time translation seam (issue #47). Absent (the default) —
   *  same "unreachable" posture as no draftClient configured. */
  translationClient?: TranslationClient;
  /** The board's Auditor pointer (issue #15 layer 2). Absent → falls back to
   *  `DEFAULT_AUDITOR_NAME` inside `commitTriage` itself. */
  auditorName?: string;
  /** Whether an explicitly named workspace is protected (issue #15 layer 2 /
   *  ADR 0013). Absent → no workspace is protected. */
  isProtectedWorkspace?: (name: string) => boolean;
  /** The pull half of the roster (issue #43 / ADR 0014). Absent → `list_agents`
   *  reports only the fixed `human` line. */
  listAgents?: () => RosterAgent[];
  /** The settings surface's workspace verbs (issue #57) — endpoint tests
   *  fake the one verb they exercise (hence Partial); the orchestration
   *  itself has its own real-git coverage (tests/create-workspace.test.ts,
   *  tests/update-workspace.test.ts). */
  workspaceAdmin?: Partial<WorkspaceAdmin>;
  /** The settings surface's agent verbs (issue #71), workspaceAdmin's twin —
   *  endpoint tests fake the one verb they exercise; the orchestration
   *  itself has its own coverage (tests/create-agent.test.ts,
   *  tests/update-agent.test.ts). */
  agentAdmin?: Partial<AgentAdmin>;
  /** The settings surface's profile verbs (issue #77), agentAdmin's twin —
   *  endpoint tests fake the one verb they exercise; the orchestration itself
   *  has its own coverage (tests/create-profile.test.ts). */
  profileAdmin?: Partial<ProfileAdmin>;
  /** The skills picker's candidate source (issue #106 / ADR 0025 点4) — faked
   *  here so GET /api/skills is exercised without a real `claude` CLI (ADR
   *  0027). Absent → the route degrades to an empty candidate set. */
  hostSkills?: () => Promise<string[] | null>;
}

/** The server wants a per-request candidates provider; a test may pass one
 *  directly (to prove re-reads) or a plain snapshot for convenience. */
function normalizeCandidates(
  candidates: BootOptions["registryCandidates"],
): (() => RegistryCandidates | undefined) | undefined {
  if (typeof candidates === "function") return candidates;
  if (candidates === undefined) return undefined;
  return () => candidates;
}

/** Boot the whole monolith in-process: temp SQLite, real HTTP on an ephemeral port.
 *  The worker and the GitHubClient are swapped for scripted fakes, at the
 *  WorkerAdapter and GitHubClient seams. */
export async function bootTidepool(options: BootOptions = {}): Promise<Tidepool> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "tidepool-test-")));
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const github = new FakeGitHubClient();
  const push = new FakePushClient();
  const server = await startServer({
    dbPath: join(dir, "board.sqlite"),
    port: 0,
    mcpPort: 0,
    clock,
    worker: () => worker,
    workspace: options.workspace,
    resolveWorkspace: options.resolveWorkspace,
    watchdog: options.watchdog,
    github,
    authority: options.authority,
    resolveAuthority: options.resolveAuthority,
    agentRegistered: options.agentRegistered,
    // the server takes a per-request provider now; a test may pass one
    // directly, otherwise wrap the static snapshot
    registryCandidates: normalizeCandidates(options.registryCandidates),
    draftClient: options.draftClient,
    translationClient: options.translationClient,
    push,
    auditorName: options.auditorName,
    isProtectedWorkspace: options.isProtectedWorkspace,
    listAgents: options.listAgents,
    workspaceAdmin: options.workspaceAdmin,
    agentAdmin: options.agentAdmin,
    profileAdmin: options.profileAdmin,
    hostSkills: options.hostSkills,
  });
  let stopped = false;
  const stopServer = async () => {
    if (!stopped) await server.stop();
    stopped = true;
  };
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    mcpBaseUrl: `http://127.0.0.1:${server.mcpPort}`,
    clock,
    worker,
    github,
    push,
    dir,
    stopServer,
    stop: async () => {
      await stopServer();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Real MCP client over streamable HTTP, attributed to a task via ?task=. */
export async function mcpClient(baseUrl: string, taskId?: string): Promise<Client> {
  const url = new URL(`${baseUrl}/mcp`);
  if (taskId !== undefined) url.searchParams.set("task", taskId);
  const client = new Client({ name: "tidepool-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(url));
  return client;
}

export async function api(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** Marks an agent name needs-human directly in `agent_state`, bypassing
 *  `quarantineAgent`'s own question-registration side effect — for tests that
 *  want to drive just the pickup/queue gate SQL (ADR 0012 / issue #36), not
 *  the whole quarantine-registration flow (that flow has its own coverage in
 *  tests/quarantine-agent.test.ts and tests/quarantine-confirm-agent.test.ts). */
export function quarantineAgentRow(db: Db, name: string): void {
  db.prepare(
    `INSERT INTO agent_state (name, needs_human) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET needs_human = 1`,
  ).run(name);
}

/** A real git checkout for tree-rule/branch-discipline/quarantine tests —
 *  stderr captured, not inherited, same as workspace.ts's own `git`. */
export function git(dir: string, ...args: string[]): string {
  return execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir },
  )
    .toString()
    .trim();
}

/** A fresh temp git checkout named `name`, one commit deep. The path is
 *  pushed onto the caller's own `dirs` array so its own `afterEach` cleans it
 *  up — this helper only creates, never tracks cleanup itself. */
export async function makeWorkspace(dirs: string[], name: string): Promise<WorkspaceConfig> {
  const path = await mkdtemp(join(tmpdir(), `tidepool-${name}-`));
  dirs.push(path);
  git(path, "init", "-b", "main");
  await writeFile(join(path, "README.md"), "workspace\n");
  git(path, "add", "-A");
  git(path, "commit", "-m", "initial");
  return { name, path };
}

export async function registerWork(
  t: Tidepool,
  title: string,
  workspace?: string,
  reviewFlag?: boolean,
): Promise<any> {
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title,
    purpose: `purpose of ${title}`,
    completion_criteria: `criteria of ${title}`,
    ...(workspace !== undefined && { workspace }),
    ...(reviewFlag !== undefined && { review_flag: reviewFlag }),
  });
  return res.json;
}

/** Fabricates a question task directly against the board's own DB file,
 *  mirroring how tidepool's internal callers (watchdog/quarantine/merge/
 *  decompose) register one. The human-facing `/api/tasks` door refuses
 *  `type: "question"` outright (issue #38), so tests that need a question
 *  fixture go through this seam instead — a second connection to the same
 *  SQLite file is safe under WAL (`openDb`'s own mode). */
export function registerQuestion(t: Tidepool, input: Omit<RegisterTaskInput, "type">): Task {
  const db = openDb(join(t.dir, "board.sqlite"));
  try {
    return registerTask(db, { ...input, type: "question" }, t.clock.now(), BOARD_WORKER_ID);
  } finally {
    db.close();
  }
}

/** The 6-field handoff doc, filled in with placeholder content — shared by
 *  every test that just needs *a* valid handoff to complete a work task. */
export const FULL_HANDOFF = {
  outcome: "done as specified",
  deliverables: "n/a",
  decision_refs: "n/a",
  dead_ends: "n/a",
  resume_context: "n/a",
  known_issues: "n/a",
};
