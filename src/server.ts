import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApiRouter } from "./api.js";
import type { Clock } from "./clock.js";
import { openDb } from "./db.js";
import { createMcpRouter } from "./mcp.js";
import { startScheduler } from "./scheduler.js";
import { Slot } from "./slot.js";
import type { WorkerAdapter } from "./worker.js";

export interface ServerOptions {
  dbPath: string;
  port: number;
  clock: Clock;
  worker: WorkerAdapter;
}

export interface TidepoolServer {
  port: number;
  stop: () => Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<TidepoolServer> {
  const db = openDb(options.dbPath);
  const slot = new Slot();
  const app = express();
  app.use("/api", createApiRouter(db, options.clock));
  app.use("/mcp", createMcpRouter({ db, slot, clock: options.clock }));
  app.use(express.static(join(dirname(fileURLToPath(import.meta.url)), "..", "public")));
  const scheduler = startScheduler({ db, clock: options.clock, slot, worker: options.worker });

  const listener = await new Promise<import("node:http").Server>((resolve) => {
    const l = app.listen(options.port, "127.0.0.1", () => resolve(l));
  });

  return {
    port: (listener.address() as AddressInfo).port,
    stop: () =>
      new Promise((resolve, reject) => {
        scheduler.stop();
        listener.close((err) => (err ? reject(err) : resolve()));
        db.close();
      }),
  };
}
