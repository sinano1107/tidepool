import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { startServer, type TidepoolServer } from "../src/server.js";
import { FakeClock, FakeContainerRuntime, ScriptedWorker } from "./fakes.js";
import { AUTH_HEADERS, TEST_CREDENTIAL } from "./harness.js";

let server: TidepoolServer | undefined;
let dir: string | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

it("/mcp は web/api ポートでは待ち受けず、mcpPort 専用ポートでのみ待ち受ける(issue #37)", async () => {
  dir = await mkdtemp(join(tmpdir(), "tidepool-mcp-port-"));
  const bootClock = new FakeClock();
  server = await startServer({
    dbPath: join(dir, "board.sqlite"),
    port: 0,
    mcpPort: 0,
    clock: bootClock,
    credential: TEST_CREDENTIAL,
    worker: () => new ScriptedWorker(bootClock),
    containerRuntime: new FakeContainerRuntime(),
  });

  // credential を提示したうえで 404 であること(issue #153): 無認証の 401 は
  // 「/mcp が人間ポートに mount されていない」を何も証明しない — 認証を通した先で
  // 初めて「そこにルートが無い」が主張になる
  const webRes = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
    method: "POST",
    headers: { ...AUTH_HEADERS, "content-type": "application/json" },
    body: "{}",
  });
  expect(webRes.status).toBe(404);

  const client = new Client({ name: "tidepool-test", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.mcpPort}/mcp`)),
  );
  await client.close();
});
