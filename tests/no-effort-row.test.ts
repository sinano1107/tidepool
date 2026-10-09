import { afterEach, expect, it } from "vitest";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import { FakeContainerRuntime, healthyOpenai, healthyUsageText, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, HOUR, queueWork, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

/** effort「無い」の行(ADR 0218 決定5 / issue #1658): CLI が effort を捨てる model の行は、--effort 無しで spawn し、
 *  worker_spawned の effort を null で記録する。 */

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

it("effort「無い」の行で走る worker は --effort 無しで spawn され、worker_spawned の effort は null", async () => {
  const proc = recordingSpawn();
  const registryDir = await makeRegistry();
  const logDir = await tempDir("no-effort-row-logs-");
  t = await bootTidepool({
    taskExecutionCandidates: (task) => executionSettingsFor(t.db, { provider: [{ name: "anthropic", advisor: false }], tier: undefined }, task),
    openaiUsage: healthyOpenai,
    containerRuntime: new FakeContainerRuntime(proc.spawn),
    workerAdapter: (deps) => {
      const worker = new ClaudeCodeWorker({ ...deps, registry: { dir: registryDir, mode: "purely-local" }, agent: "deckhand", workspace: "tidepool", mcpUrl: "http://127.0.0.1:1/mcp", logDir });
      return {
        id: "adapter",
        start: (task, setting) => worker.start(task, setting),
        gracefulStop: (id) => worker.gracefulStop(id),
        checkUsage: async () => healthyUsageText(t.clock.now()),
      };
    },
  });
  const haiku = { provider: "anthropic", tier: "economy", model: "claude-haiku-4-5-20251001", effort: null, price_in: 1, price_out: 5 };
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "row", row: haiku })).status).toBe(200);
  expect((await api(t.baseUrl, "POST", "/api/settings/execution", { setting: "delete_row", provider: "anthropic", model: "claude-sonnet-5-5", effort: "high" })).status).toBe(200);

  const task = queueWork(t, "runs on the no-effort row");
  await t.clock.advance(HOUR);

  // 先頭の spawn は使用量の probe —— worker の spawn は行の model を pin した呼び出し
  const spawn = proc.calls.find((call) => call.args.includes("claude-haiku-4-5-20251001"));
  expect(spawn!.args).not.toContain("--effort");
  const events = (await api(t.baseUrl, "GET", `/api/tasks/${task.id}/events`)).json as Array<{ kind: string; payload: { effort?: string | null } }>;
  expect(events.find((e) => e.kind === "worker_spawned")?.payload.effort).toBeNull();
});
