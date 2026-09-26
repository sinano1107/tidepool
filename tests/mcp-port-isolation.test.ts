import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { startServer, type TidepoolServer } from "../src/server.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { TranscriptStore } from "../src/transcript-store.js";
import { FakeClock, FakeContainerRuntime, ScriptedWorker } from "./fakes.js";
import { AUTH_HEADERS, TEST_CREDENTIAL, tempDir } from "./harness.js";

let server: TidepoolServer | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
});

it("/mcp は web/api ポートでは待ち受けず、mcpPort 専用ポートでのみ待ち受ける(issue #37)", async () => {
  const dir = await tempDir("tidepool-mcp-port-");
  const bootClock = new FakeClock();
  const db = openDb(join(dir, "board.sqlite"));
  server = await startServer({
    db,
    taskExecutionCandidates: implicitTaskExecutionCandidates(db),
    port: 0,
    mcpPort: 0,
    clock: bootClock,
    credential: TEST_CREDENTIAL,
    worker: () => new ScriptedWorker(bootClock),
    containerRuntime: new FakeContainerRuntime(),
    transcripts: new TranscriptStore(dir),
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
