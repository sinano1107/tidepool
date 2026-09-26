import { expect, it } from "vitest";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import { CODEX_CLI_VERSION, CodexWorker } from "../src/codex-worker.js";
import { openDb } from "../src/db.js";
import type { PtyFn } from "../src/process-container.js";
import { LoggingWorker } from "../src/server-options.js";
import { TranscriptStore } from "../src/transcript-store.js";
import type { WorkerAdapter } from "../src/worker.js";
import { containerHarness, FakeClock, passthroughContainers, ScriptedWorker } from "./fakes.js";
import { tempDir } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

/** 公開 contract の共通テスト(ADR 0099 決定1)。**adapter が持つ終了の語彙は
 *  畳み込み停止だけ**であり、raw signal 名は seam に一度も現れない — 合図の選択は
 *  Harness の性質なので実装の中に沈む。ここで測るのはその形が全 adapter で同じ
 *  であることであり、fake だけで閉じる(ADR 0027: 実 CLI は起こさない)。 */
function workerAdapterContract(name: string, build: () => Promise<WorkerAdapter>): void {
  it(`${name}: 既定エージェント名を名乗る`, async () => {
    const worker = await build();
    expect(worker.id.length).toBeGreaterThan(0);
  });

  it(`${name}: 知らない / 既に終わった task への畳み込み停止は no-op`, async () => {
    const worker = await build();
    expect(() => worker.gracefulStop("no-such-task")).not.toThrow();
  });

  it(`${name}: 使用量の観測は text か、観測できなければ null を返す(fail-closed)`, async () => {
    const worker = await build();
    const usage = await worker.checkUsage();
    expect(usage === null || typeof usage === "string").toBe(true);
  });
}

/** 実 PTY を起こさずに「観測できなかった」を返す(ADR 0028 の fail-closed)。 */
const deadPty: PtyFn = () => ({
  onData: () => {},
  write: () => {},
  kill: () => {},
  onExit: (listener) => setTimeout(listener, 0),
});

workerAdapterContract("ScriptedWorker", async () => new ScriptedWorker(new FakeClock()));

workerAdapterContract("LoggingWorker", async () => new LoggingWorker());

workerAdapterContract("ClaudeCodeWorker", async () => {
  const registryDir = await makeRegistry();
  const logDir = await tempDir("tidepool-contract-logs-");
  return new ClaudeCodeWorker({
    db: openDb(":memory:"),
    clock: new FakeClock(),
    registry: { dir: registryDir, mode: "purely-local" },
    agent: "deckhand",
    workspace: "tidepool",
    mcpUrl: "http://127.0.0.1:4589/mcp",
    logDir,
    transcripts: new TranscriptStore(logDir),
    pty: deadPty,
    ...containerHarness(passthroughContainers()),
  });
});

workerAdapterContract("CodexWorker", async () => {
  const registryDir = await makeRegistry();
  const codexHome = await tempDir("tidepool-contract-codex-home-");
  const logDir = await tempDir("tidepool-contract-codex-logs-");
  return new CodexWorker({
    db: openDb(":memory:"),
    clock: new FakeClock(),
    registry: { dir: registryDir, mode: "purely-local" },
    agent: "deckhand",
    workspace: "tidepool",
    mcpUrl: "http://127.0.0.1:4589/mcp",
    transcripts: new TranscriptStore(logDir),
    codexHome,
    cliVersion: CODEX_CLI_VERSION,
    executable: "/opt/tidepool/bin/codex",
    ...containerHarness(passthroughContainers()),
  });
});
