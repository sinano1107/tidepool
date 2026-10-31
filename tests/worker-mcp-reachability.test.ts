import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { claudeMcpReachabilityThrough } from "../src/claude-worker.js";
import { codexMcpReachabilityThrough } from "../src/codex-worker.js";
import { ProcessContainers } from "../src/process-container.js";
import { registerQuarantine } from "../src/quarantine.js";
import { probeWorkerMcpReachability } from "../src/worker-mcp-reachability.js";
import { containerHarness, FakeClock, FakeContainerRuntime, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, servedQuarantineQuestion, type Tidepool } from "./harness.js";

// ADR 0331 決定8: 解放の検証の probe。盤面は probe ごとに使い捨ての id を発行し、その id を `?probe=` に載せた listener の
// URL で Harness の probe を撃ち、終わったら id を無効にする —— 投げても timeout でも

const MCP_URL = "http://127.0.0.1:4000/mcp";

it("probe の間だけ id が開いていて、URL の ?probe= がその id、終われば無効になる", async () => {
  const ids = new Set<string>();
  const seen: Array<{ harness: string; url: string; open: boolean }> = [];
  const result = await probeWorkerMcpReachability(ids, MCP_URL, "claude-code", async (harness, url) => {
    const id = new URL(url).searchParams.get("probe")!;
    seen.push({ harness, url, open: ids.has(id) });
    return { available: true };
  });
  expect(result).toEqual({ available: true });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.harness).toBe("claude-code");
  expect(seen[0]!.url).toMatch(/^http:\/\/127\.0\.0\.1:4000\/mcp\?probe=.+/);
  expect(seen[0]!.open).toBe(true);
  expect(ids.size).toBe(0);
});

it("probe が投げても id は無効になる", async () => {
  const ids = new Set<string>();
  await expect(
    probeWorkerMcpReachability(ids, MCP_URL, "codex", async () => {
      throw new Error("spawn exploded");
    }),
  ).rejects.toThrow("spawn exploded");
  expect(ids.size).toBe(0);
});

// ── Claude の probe(Board call の口を recordingSpawn で駆動)──────────────────

/** Claude の probe を1回撃ち、spawn を待って、その時点の argv と probe 名義の設定ファイルの中身を読む(終われば一時 dir は消える)。 */
async function startClaudeProbe(clock = new FakeClock()) {
  const spawn = recordingSpawn();
  const { boardCall } = containerHarness(new ProcessContainers(new FakeContainerRuntime(spawn.spawn)), clock);
  const ids = new Set<string>();
  const result = probeWorkerMcpReachability(ids, MCP_URL, "claude-code", (_, url) => claudeMcpReachabilityThrough(boardCall)(url));
  await vi.waitFor(() => expect(spawn.calls).toHaveLength(1));
  const { args, cwd } = spawn.calls[0]!;
  const fileAfter = (flag: string) => args[args.indexOf(flag) + 1]!;
  return {
    spawn,
    ids,
    result,
    args,
    cwd,
    settingsPath: fileAfter("--settings"),
    settings: JSON.parse(readFileSync(fileAfter("--settings"), "utf8")),
    mcpConfig: JSON.parse(readFileSync(fileAfter("--mcp-config"), "utf8")),
    openWhileRunning: [...ids],
  };
}

it("Claude の probe は一時 dir の sandbox の profile を --settings で、listener の ?probe= URL を --mcp-config で、--strict-mcp-config と一緒に運ぶ", async () => {
  const probe = await startClaudeProbe();
  expect(probe.spawn.calls[0]!.command).toBe("claude");
  expect(probe.args).toContain("--strict-mcp-config");
  // profile は実 session と同じ生成器(buildSandboxSettings)で、一時 dir を workspace にしたもの
  expect(dirname(probe.settingsPath)).toBe(probe.cwd);
  expect(probe.settings.sandbox.enabled).toBe(true);
  expect(probe.settings.sandbox.failIfUnavailable).toBe(true);
  expect(probe.settings.sandbox.filesystem.allowWrite).toContain(probe.cwd);
  expect(probe.settings.sandbox.network.allowedDomains).toEqual([]);
  expect(probe.mcpConfig).toEqual({
    mcpServers: { tidepool: { type: "http", url: `${MCP_URL}?probe=${probe.openWhileRunning[0]}` } },
  });
  probe.spawn.emitExit(0, null);
  await probe.result;
  expect(existsSync(probe.cwd)).toBe(false);
});

/** 台本の init 行(`mcp_servers` だけを差し替える)を書いて exit させ、Claude の probe の答えを返す。 */
async function claudeProbeAnswers(stdout: string) {
  const probe = await startClaudeProbe();
  probe.spawn.processes[0]!.stdout.write(stdout);
  probe.spawn.emitExit(0, null);
  return probe.result;
}
const initLine = (mcpServers: unknown) => `${JSON.stringify({ type: "system", subtype: "init", tools: [], mcp_servers: mcpServers })}\n`;

it("init 行の tidepool が connected なら成立", async () => {
  expect(await claudeProbeAnswers(initLine([{ name: "tidepool", status: "connected", source: "dynamic" }]))).toEqual({ available: true });
});

it.each([
  ["failed", [{ name: "tidepool", status: "failed" }], "as failed"],
  ["未知の文字列", [{ name: "tidepool", status: "needs-auth" }], "as needs-auth"],
  ["tidepool の要素が無い", [{ name: "other", status: "connected" }], "lists no `tidepool` server"],
])("init 行の tidepool が %s なら不成立 —— 理由に観測値", async (_, servers, observed) => {
  const result = await claudeProbeAnswers(initLine(servers));
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain(observed);
});

it.each([
  ["JSON でない", "not json\n"],
  ["tidepool の status が文字列でない", initLine([{ name: "tidepool", status: null }])],
  ["mcp_servers が配列でない", initLine({ tidepool: "connected" })],
])("init 行が読めなければ不成立(%s)", async (_, stdout) => {
  const result = await claudeProbeAnswers(stdout);
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain("no readable init report");
});

it("Claude の probe の timeout(Board call の上限)は不成立", async () => {
  const clock = new FakeClock();
  const probe = await startClaudeProbe(clock);
  await clock.advance(60_000);
  expect((await probe.result).available).toBe(false);
  expect(probe.ids.size).toBe(0);
});

// ── Codex の probe ──────────────────────────────────────────────────────────

async function startCodexProbe(clock = new FakeClock()) {
  const spawn = recordingSpawn();
  const { boardCall } = containerHarness(new ProcessContainers(new FakeContainerRuntime(spawn.spawn)), clock);
  const codexHome = mkdtempSync(join(tmpdir(), "tidepool-codex-home-"));
  onTestFinished(() => rmSync(codexHome, { recursive: true, force: true }));
  const ids = new Set<string>();
  const probe = codexMcpReachabilityThrough({ executable: "/opt/tidepool/bin/codex", codexHome, call: boardCall });
  const result = probeWorkerMcpReachability(ids, MCP_URL, "codex", (_, url) => probe(url));
  await vi.waitFor(() => expect(spawn.calls).toHaveLength(1));
  return { spawn, ids, result, args: spawn.calls[0]!.args, openWhileRunning: [...ids] };
}

it("Codex の probe は worker と同じ -c mcp_servers.tidepool.* を required=true と listener の ?probe= URL で運ぶ", async () => {
  const probe = await startCodexProbe();
  expect(probe.spawn.calls[0]!.command).toBe("/opt/tidepool/bin/codex");
  expect(probe.args.slice(0, 4)).toEqual(["--ask-for-approval", "never", "exec", "--json"]);
  expect(probe.args).toContain(`mcp_servers.tidepool.url=${JSON.stringify(`${MCP_URL}?probe=${probe.openWhileRunning[0]}`)}`);
  expect(probe.args).toContain("mcp_servers.tidepool.required=true");
  probe.spawn.emitExit(1, null);
  await probe.result;
});

it("Codex の probe は thread.started を観測すれば成立", async () => {
  const probe = await startCodexProbe();
  probe.spawn.processes[0]!.stdout.write(`${JSON.stringify({ type: "thread.started", thread_id: "t-1" })}\n`);
  expect(await probe.result).toEqual({ available: true });
});

it("Codex の probe が thread.started 無しに exit すれば不成立 —— 理由に stderr", async () => {
  const probe = await startCodexProbe();
  probe.spawn.processes[0]!.stderr.write("Error: required MCP servers failed to initialize: tidepool\n");
  probe.spawn.emitExit(1, null);
  const result = await probe.result;
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain("required MCP servers failed to initialize: tidepool");
});

it("Codex の probe の timeout(Board call の上限)は不成立", async () => {
  const clock = new FakeClock();
  const probe = await startCodexProbe(clock);
  await clock.advance(60_000);
  const result = await probe.result;
  expect(result.available).toBe(false);
  expect(result.available === false && result.reason).toContain("did not complete");
});

// ── 盤面: 止まっている間の pickup と、回答の受理(ADR 0331 決定7・8)──────────────────────

let t: Tidepool | undefined;
afterEach(() => t?.stop());

it("Worker MCP 到達性の回答は probe が繋がらなければ観測値つきで拒まれて question が開いたまま、繋がれば受理される。probe は bind した扉を使い捨ての帰属で叩く", async () => {
  let reachable = false;
  const probed: Array<{ harness: string; url: string; door: number }> = [];
  const board = await bootTidepool({
    workerMcpReachability: async (harness, url) => {
      // probe の間、その帰属で扉の initialize が通る(router と同じ id の集合)
      const door = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
      });
      probed.push({ harness, url, door: door.status });
      return reachable ? { available: true } : { available: false, reason: "a Claude worker reports the board's Worker MCP `tidepool` as failed" };
    },
  });
  t = board;
  registerQuarantine(board.db, "workerMcpReachability", "claude-code", "this Claude worker session reports `tidepool` as failed", board.clock.now());
  const question = await servedQuarantineQuestion(board, "workerMcpReachability", "claude-code");

  const answer = () => api(board.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["repaired by hand"] });
  const refused = await answer();
  expect(refused.status).toBe(409);
  expect(refused.json.error).toContain("as failed");
  expect((await api(board.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");

  reachable = true;
  expect((await answer()).status).toBe(200);
  expect((await api(board.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).not.toBe("todo");
  // probe は bind した Worker MCP の扉を、Harness ごとの使い捨ての帰属で叩く
  expect(probed.map(({ harness, door }) => [harness, door])).toEqual([["claude-code", 200], ["claude-code", 200]]);
  for (const { url } of probed) expect(url).toMatch(new RegExp(`^${board.mcpBaseUrl}/mcp\\?probe=.+`));
});
