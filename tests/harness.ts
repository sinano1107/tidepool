import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DraftClient } from "../src/draft.js";
import type { AuthorityProfile, RegistryCandidates } from "../src/registry.js";
import { startServer } from "../src/server.js";
import type { WatchdogConfig } from "../src/watchdog.js";
import type { WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, FakeGitHubClient, ScriptedWorker } from "./fakes.js";

export { HOURLY as HOUR } from "../src/scheduler.js";

export interface Tidepool {
  baseUrl: string;
  clock: FakeClock;
  worker: ScriptedWorker;
  github: FakeGitHubClient;
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
  /** Assignee/workspace candidates for the registration screen (issue #12). */
  registryCandidates?: RegistryCandidates;
  /** The LLM draft seam (issue #12). Absent (the default) — same as no LLM
   *  configured, matching the "LLM outage" fallback path. */
  draftClient?: DraftClient;
}

/** Boot the whole monolith in-process: temp SQLite, real HTTP on an ephemeral port.
 *  The worker and the GitHubClient are swapped for scripted fakes, at the
 *  WorkerAdapter and GitHubClient seams. */
export async function bootTidepool(options: BootOptions = {}): Promise<Tidepool> {
  const dir = options.dir ?? (await mkdtemp(join(tmpdir(), "tidepool-test-")));
  const clock = new FakeClock();
  const worker = new ScriptedWorker();
  const github = new FakeGitHubClient();
  const server = await startServer({
    dbPath: join(dir, "board.sqlite"),
    port: 0,
    clock,
    worker: () => worker,
    workspace: options.workspace,
    resolveWorkspace: options.resolveWorkspace,
    watchdog: options.watchdog,
    github,
    authority: options.authority,
    registryCandidates: options.registryCandidates,
    draftClient: options.draftClient,
  });
  let stopped = false;
  const stopServer = async () => {
    if (!stopped) await server.stop();
    stopped = true;
  };
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    clock,
    worker,
    github,
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
