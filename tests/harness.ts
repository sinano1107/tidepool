import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.js";
import { FakeClock, ScriptedWorker } from "./fakes.js";

export const HOUR = 60 * 60 * 1000;

export interface Tidepool {
  baseUrl: string;
  clock: FakeClock;
  worker: ScriptedWorker;
  stop: () => Promise<void>;
}

/** Boot the whole monolith in-process: temp SQLite, real HTTP on an ephemeral port.
 *  Only the worker is swapped for a scripted fake, at the WorkerAdapter seam. */
export async function bootTidepool(): Promise<Tidepool> {
  const dir = await mkdtemp(join(tmpdir(), "tidepool-test-"));
  const clock = new FakeClock();
  const worker = new ScriptedWorker();
  const server = await startServer({
    dbPath: join(dir, "board.sqlite"),
    port: 0,
    clock,
    worker,
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    clock,
    worker,
    stop: async () => {
      await server.stop();
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
