/** Claude CLI の版上げの適合試験(ADR 0186 決定7 / issue #1275)。このホストの `claude` の
 *  実物の出力を、盤面自身の Board call の口から取って盤面自身の読み取り関数で判定し、面ごとの
 *  合否を Markdown の表で出す(種の anthropic 行が走るかも、ADR 0187 決定4)。1つでも不合格なら exit 1。
 *
 *  サブスクリプションの認証が要るので CI では回さない。Lima VM で `Delegate=yes` の scope の
 *  中から走らせる(手順は docs/claude-cli-version-bump.md)。口の版の門(ADR 0186 決定3)には
 *  常に一致を返す検査を渡して外す —— 試すのはまだ固定していない版であり、門を外す印の無い
 *  注文(`.mcp.json` の面の skill 列挙の ping とその対照・result 行・language の1ターン・404 の probe・使用量画面・
 *  下書き・翻訳)も撃つからである。
 *
 *  使い方: systemd-run --user --scope -p Delegate=yes -- npx tsx scripts/claude-cli-conformance.ts */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { type BoardCallSpec, createBoardCalls, readOutput } from "../src/board-call.js";
import { containerRuntimeFor } from "../src/cgroup-container.js";
import { cliAuthCommandThrough, createClaudeModelProbe } from "../src/claude-cli-auth.js";
import {
  boardCallShotSpec,
  judgeConformance,
  judgeSeedRows,
  LANGUAGE_QUESTION,
  MCP_JSON_SERVER,
  mcpJsonControlSpec,
  workerShotSpec,
} from "../src/claude-cli-conformance.js";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import { checkUsageThrough, execThrough, skillEnumerationSpec, toolSurfaceProbeSpec } from "../src/claude-worker.js";
import { SystemClock } from "../src/clock.js";
import { openDb } from "../src/db.js";
import { ProcessContainers } from "../src/process-container.js";
import { promptInput, workerPromptRecord } from "../src/transcript-store.js";
import { RECLAIM_TIMEOUT } from "../src/watchdog.js";

const containers = new ProcessContainers(containerRuntimeFor(platform));
const preflight = containers.preflight();
if (!preflight.available) {
  console.error(preflight.reason);
  process.exit(1);
}
const { call } = createBoardCalls({
  containers,
  clock: new SystemClock(),
  reclaimTimeout: RECLAIM_TIMEOUT,
  onReclaimTimeout: (reason) => console.warn(reason),
  checkCliVersion: async () => ({ available: true }),
  onCliVersionMismatch: () => {},
});
/** neutral cwd。`settings` を渡せば、その repo の `.claude/settings.json` を置く(ADR 0303 決定4)。 */
const neutralCwd = (settings?: object) => {
  const dir = mkdtempSync(join(tmpdir(), "tidepool-conformance-"));
  if (settings) {
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings));
  }
  return dir;
};
const scratch = neutralCwd();
const outputStyleCwd = neutralCwd({ outputStyle: "Explanatory" });
const languageCwd = neutralCwd({ language: "japanese" });
// ADR 0341 決定6: `.mcp.json` に stdio server 1本 —— 起動すると marker を書き、initialize と tools/list にだけ答える
const mcpJsonCwd = neutralCwd();
const mcpJsonMarker = join(mcpJsonCwd, "server-started");
writeFileSync(
  join(mcpJsonCwd, "server.cjs"),
  `require("node:fs").appendFileSync(process.argv[2], "started\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const result = method === "initialize"
    ? { protocolVersion: params.protocolVersion, capabilities: {}, serverInfo: { name: "conformance", version: "0" } }
    : { tools: [] };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
});
`,
);
writeFileSync(
  join(mcpJsonCwd, ".mcp.json"),
  JSON.stringify({
    mcpServers: { [MCP_JSON_SERVER]: { type: "stdio", command: process.execPath, args: [join(mcpJsonCwd, "server.cjs"), mcpJsonMarker] } },
  }),
);

const outputOf = (spec: BoardCallSpec) =>
  call(spec, readOutput).then((output) => {
    if (output === null) throw new Error("the Board call produced no answer (limit, spawn failure, or no container)");
    return output;
  });
const stdoutOf = (spec: BoardCallSpec) => outputOf(spec).then((output) => output.stdout);
// モデルの1ターンは、答えを取りに行く呼び出し(execThrough)と同じく非ゼロ終了を投げる —— その面の不合格になる
const shotStdout = (spec: BoardCallSpec) =>
  outputOf(spec).then((output) => {
    if (output.exitCode !== 0) throw new Error(`the ${spec.kind} turn exited ${output.exitCode}\n${output.stderr}`);
    return output.stdout;
  });
// init 行は封じ込めの probe と同じ注文で撃つ(neutral cwd で撃つのも同じ)
const probeStdout = (cwd: string) => stdoutOf(toolSurfaceProbeSpec(cwd));

// result 行は、モデルの1ターンを実際に走らせた stream-json から読む —— `/usage` ping は
// ターンを起こさない(cost 0)ので、worker が読む usage の形を試せない
const oneTurnStdout = () =>
  shotStdout(boardCallShotSpec({ kind: "conformance result line", cwd: process.cwd(), input: "Reply with the single word OK." }));

const languageShot = (shape: "worker" | "board call") => {
  const input = promptInput(workerPromptRecord("claude-code", [], LANGUAGE_QUESTION));
  const file = join(scratch, "language-system.txt");
  writeFileSync(file, input.system);
  const order = { kind: `conformance language (${shape})`, cwd: languageCwd, input: input.user };
  return shotStdout(shape === "worker" ? workerShotSpec({ ...order, systemPromptFile: file }) : boardCallShotSpec(order));
};

const { rows } = await judgeConformance(
  {
    initLine: () => probeStdout(scratch),
    // worker の形を先に撃ち、対照が server を起動する前に marker を読む
    mcpJson: async () => {
      const workerShaped = await stdoutOf(skillEnumerationSpec(mcpJsonCwd, { awaitReclaimed: false }));
      const workerShapedStarted = existsSync(mcpJsonMarker);
      const control = await stdoutOf(mcpJsonControlSpec(mcpJsonCwd));
      return { workerShaped, workerShapedStarted, control, controlStarted: existsSync(mcpJsonMarker) };
    },
    resultLine: oneTurnStdout,
    outputStyleLine: () => probeStdout(outputStyleCwd),
    languageShot,
    unknownModel: () =>
      createClaudeModelProbe(cliAuthCommandThrough(call, "conformance model probe"))("claude-conformance-no-such-model"),
    usageScreen: () => checkUsageThrough(call, scratch),
    draft: () =>
      new ClaudeDraftClient({ db: openDb(":memory:"), exec: execThrough(call, "conformance task draft") }).draftTask(
        "Water the greenhouse tomatoes every morning before 9am.",
        "English",
      ),
    translation: () =>
      new ClaudeTranslationClient({ exec: execThrough(call, "conformance translation") }).translate(
        ["The board retires a settled tree."],
        "Japanese",
      ),
  },
  new Date(),
);

// 種の anthropic 行は、盤面が回答時の再検査に使うのと同じ probe で撃つ(ADR 0187 決定4)
const table = [
  ...rows,
  ...(await judgeSeedRows(createClaudeModelProbe(cliAuthCommandThrough(call, "conformance seed row probe")))),
];

console.log("| surface | result | detail |\n|---|---|---|");
for (const row of table) console.log(`| ${row.surface} | ${row.pass ? "合格" : "不合格"} | ${row.detail.replaceAll("|", "\\|")} |`);
process.exit(table.every((row) => row.pass) ? 0 : 1);
