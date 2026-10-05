/** 読み手の MCP 応答上限の canary(ADR 0195 決定7 / issue #1391)。盤面の予算いっぱいの応答を返す一時的な stdio MCP を
 *  立て、このホストの `claude -p` と `codex exec` に1回ずつ呼ばせ、モデルが受け取った本文に中央と末尾の目印が逐語で
 *  残るかを Markdown の表で出す。1つでも不合格なら exit 1。
 *
 *  サブスクリプションの認証が要るので CI では回さない(手順は docs/claude-cli-version-bump.md)。Codex は一時的な
 *  CODEX_HOME に `auth.json` だけを写して回し、実際の設定は読みも書きもしない。
 *
 *  使い方: npx tsx scripts/reader-cap-canary.ts
 *  (`serve <目印のファイル>` は子として立つ MCP の口で、人間は打たない) */
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, globSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { boardCallEnv, pinnedModelFlags } from "../src/claude-worker.js";
import { SEED_EXECUTION_SETTINGS } from "../src/execution-setting.js";
import {
  buildCanaryPayload,
  CANARY_SERVER,
  CANARY_TOOL,
  judgeReceived,
  readClaudeReceived,
  readCodexReceived,
} from "../src/reader-cap-canary.js";

if (process.argv[2] === "serve") {
  // 子の MCP: stdout は stdio の transport なので何も書かない。目印は呼び出しごとに親が渡したファイルへ足す
  const markersFile = process.argv[3]!;
  const server = new McpServer({ name: CANARY_SERVER, version: "0.0.0" });
  server.registerTool(CANARY_TOOL, { description: "Returns one canary JSON document. Call it once." }, async () => {
    const { text, middle, tail } = buildCanaryPayload();
    appendFileSync(markersFile, `${JSON.stringify({ middle, tail })}\n`);
    return { content: [{ type: "text", text }] };
  });
  await server.connect(new StdioServerTransport());
} else {
  const scratch = mkdtempSync(join(tmpdir(), "tidepool-reader-cap-"));
  /** 子の MCP は、この script 自身を同じ node と tsx の loader で立てる。 */
  const serve = (markersFile: string) => {
    writeFileSync(markersFile, "");
    return { command: process.execPath, args: [...process.execArgv, import.meta.filename, "serve", markersFile] };
  };
  const PROMPT = `Call the ${CANARY_TOOL} tool exactly once, then reply with the single word DONE.`;
  const run = (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
    try {
      return execFileSync(bin, args, { cwd: scratch, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      console.error(`${bin} failed: ${err instanceof Error ? err.message : String(err)}`);
      return (err as { stdout?: string }).stdout ?? "";
    }
  };

  // Claude Code: 安いモデルで、この canary の MCP だけを載せる
  const claudeMarkers = join(scratch, "claude-markers.jsonl");
  const mcpConfig = join(scratch, "claude-mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [CANARY_SERVER]: serve(claudeMarkers) } }));
  const claudeStdout = run(
    "claude",
    [
      "-p",
      PROMPT,
      ...pinnedModelFlags("haiku", "low"),
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--allowedTools",
      `mcp__${CANARY_SERVER}__${CANARY_TOOL}`,
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "3",
      "--no-session-persistence",
    ],
    boardCallEnv(),
  );
  writeFileSync(join(scratch, "claude.stream.jsonl"), claudeStdout);

  // Codex: 上限はモデルの metadata で決まる(ADR 0195 決定7)ので、盤面の種の openai economy 行のモデルで測る。
  // 一時的な CODEX_HOME で回し、rollout はそこに残る
  const codexModel = SEED_EXECUTION_SETTINGS.find((row) => row.provider === "openai" && row.tier === "economy")!.model;
  const codexHome = mkdtempSync(join(tmpdir(), "tidepool-reader-cap-codex-"));
  copyFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(codexHome, "auth.json"));
  const codexMarkers = join(scratch, "codex-markers.jsonl");
  const codexServer = serve(codexMarkers);
  run(
    "codex",
    [
      "exec",
      "-m",
      codexModel,
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "-c",
      `mcp_servers.${CANARY_SERVER}.command=${JSON.stringify(codexServer.command)}`,
      "-c",
      `mcp_servers.${CANARY_SERVER}.args=${JSON.stringify(codexServer.args)}`,
      "-c",
      `mcp_servers.${CANARY_SERVER}.tools.${CANARY_TOOL}.approval_mode="approve"`,
      PROMPT,
    ],
    { ...process.env, CODEX_HOME: codexHome },
  );
  const rollout = globSync(join(codexHome, "sessions/**/rollout-*.jsonl"))[0];

  const rows = [
    { reader: "claude -p (haiku)", bin: "claude", markersFile: claudeMarkers, received: readClaudeReceived(claudeStdout) },
    {
      reader: `codex exec (${codexModel})`,
      bin: "codex",
      markersFile: codexMarkers,
      received: rollout === undefined ? null : readCodexReceived(readFileSync(rollout, "utf8")),
    },
  ];
  console.error(`records kept in ${scratch} and ${codexHome}`);
  console.log("| reader | version | middle marker | tail marker | result | detail |\n|---|---|---|---|---|---|");
  let ok = true;
  for (const row of rows) {
    // 2回呼ばれたら、最後の受け取りを最後の目印と突き合わせる
    const calls = readFileSync(row.markersFile, "utf8").split("\n").filter(Boolean);
    const verdict =
      calls.length === 0
        ? { pass: false, middle: false, tail: false, detail: "the reader never called the canary tool" }
        : judgeReceived(row.received, JSON.parse(calls.at(-1)!));
    const detail = calls.length > 1 ? `${verdict.detail} (called ${calls.length} times; last call judged)` : verdict.detail;
    const version = execFileSync(row.bin, ["--version"], { encoding: "utf8" }).trim();
    const mark = (present: boolean) => (present ? "present" : "missing");
    console.log(
      `| ${row.reader} | ${version} | ${mark(verdict.middle)} | ${mark(verdict.tail)} | ${verdict.pass ? "合格" : "不合格"} | ${detail} |`,
    );
    ok &&= verdict.pass;
  }
  process.exit(ok ? 0 : 1);
}
