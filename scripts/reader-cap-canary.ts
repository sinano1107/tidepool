/** 読み手の MCP 応答上限の canary(ADR 0195 決定7 / issue #1391)。盤面の予算いっぱいの応答を返す一時的な stdio MCP を
 *  立て、このホストの `claude -p` と `codex exec` に1回ずつ呼ばせ、モデルが受け取った本文に中央と末尾の目印が逐語で
 *  残るかを Markdown の表で出す。全行が合格のときだけ exit 0(観測なしも門を満たさない)。
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
  GIVEN_CODE,
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
  const canaryServerSpec = (markersFile: string) => {
    writeFileSync(markersFile, "");
    return { command: process.execPath, args: [...process.execArgv, import.meta.filename, "serve", markersFile] };
  };
  // Claude Code は tool の結果がそのまま文脈に入る。Codex の code mode は exec のコードを逐語で指定して形を固定する
  const CLAUDE_PROMPT = `Call the ${CANARY_TOOL} tool exactly once, then reply with the single word DONE.`;
  const CODEX_PROMPT = `Run exactly this code with the exec tool, once, without changing it: \`${GIVEN_CODE}\` Then reply with the single word DONE.`;
  const run = (bin: string, args: string[], env: NodeJS.ProcessEnv) => {
    try {
      return { stdout: execFileSync(bin, args, { cwd: scratch, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`${bin} failed: ${message}`);
      const { stdout, stderr, status } = err as { stdout?: string; stderr?: string; status?: number | null };
      const summary = typeof status === "number" ? `${bin} exited with status ${status}` : message;
      return { stdout: stdout ?? "", failure: { stderr: stderr ?? "", summary } };
    }
  };

  // Claude Code: 安いモデルで、この canary の MCP だけを載せる
  const claudeMarkers = join(scratch, "claude-markers.jsonl");
  const mcpConfig = join(scratch, "claude-mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [CANARY_SERVER]: canaryServerSpec(claudeMarkers) } }));
  const claude = run(
    "claude",
    [
      "-p",
      CLAUDE_PROMPT,
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
  writeFileSync(join(scratch, "claude.stream.jsonl"), claude.stdout);

  // Codex: 上限はモデルの metadata で決まる(ADR 0195 決定7)ので、盤面の種の openai 行のモデルを1行ずつ測る。
  // 一時的な CODEX_HOME で回し、rollout はそこに残る
  const codexHome = mkdtempSync(join(tmpdir(), "tidepool-reader-cap-codex-"));
  copyFileSync(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json"), join(codexHome, "auth.json"));
  const codexRows = SEED_EXECUTION_SETTINGS.filter((row) => row.provider === "openai").map(({ model }) => {
    const markersFile = join(scratch, `codex-${model}-markers.jsonl`);
    const server = canaryServerSpec(markersFile);
    const before = new Set(globSync(join(codexHome, "sessions/**/rollout-*.jsonl")));
    const { failure } = run(
      "codex",
      [
        "exec",
        "-m",
        model,
        "-s",
        "read-only",
        "--skip-git-repo-check",
        "-c",
        `mcp_servers.${CANARY_SERVER}.command=${JSON.stringify(server.command)}`,
        "-c",
        `mcp_servers.${CANARY_SERVER}.args=${JSON.stringify(server.args)}`,
        "-c",
        `mcp_servers.${CANARY_SERVER}.tools.${CANARY_TOOL}.approval_mode="approve"`,
        CODEX_PROMPT,
      ],
      { ...process.env, CODEX_HOME: codexHome },
    );
    const rollout = globSync(join(codexHome, "sessions/**/rollout-*.jsonl")).find((path) => !before.has(path));
    return {
      reader: `codex exec (${model})`,
      bin: "codex",
      markersFile,
      failure,
      ...(rollout === undefined ? { received: null } : readCodexReceived(readFileSync(rollout, "utf8"))),
    };
  });

  const rows = [
    { reader: "claude -p (haiku)", bin: "claude", markersFile: claudeMarkers, failure: claude.failure, received: readClaudeReceived(claude.stdout) },
    ...codexRows,
  ];
  console.error(`records kept in ${scratch} and ${codexHome}`);
  console.log("| reader | version | middle marker | tail marker | result | detail |\n|---|---|---|---|---|---|");
  let ok = true;
  for (const row of rows) {
    const calls = readFileSync(row.markersFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const verdict = judgeReceived(row.received, calls, row);
    const version = execFileSync(row.bin, ["--version"], { encoding: "utf8" }).trim();
    const mark = (present: boolean) => (present ? "present" : "missing");
    console.log(`| ${row.reader} | ${version} | ${mark(verdict.middle)} | ${mark(verdict.tail)} | ${verdict.result} | ${verdict.detail} |`);
    ok &&= verdict.result === "合格";
  }
  process.exit(ok ? 0 : 1);
}
