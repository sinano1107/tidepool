/** Claude CLI の版上げの適合試験(ADR 0186 決定7 / issue #1275)。このホストの `claude` の
 *  実物の出力を、盤面自身の Board call の口から取って盤面自身の読み取り関数で判定し、面ごとの
 *  合否を Markdown の表で出す(種の anthropic 行が走るかも、ADR 0187 決定4)。1つでも不合格なら exit 1。
 *
 *  サブスクリプションの認証が要るので CI では回さない。Lima VM で `Delegate=yes` の scope の
 *  中から走らせる(手順は docs/claude-cli-version-bump.md)。口の版の門(ADR 0186 決定3)には
 *  常に一致を返す検査を渡して外す —— 試すのはまだ固定していない版であり、門を外す印の無い
 *  注文(result 行・404 の probe・使用量画面・下書き・翻訳)も撃つからである。
 *
 *  使い方: systemd-run --user --scope -p Delegate=yes -- npx tsx scripts/claude-cli-conformance.ts */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { createBoardCalls, readOutput } from "../src/board-call.js";
import { containerRuntimeFor } from "../src/cgroup-container.js";
import { cliAuthCommandThrough, createClaudeModelProbe } from "../src/claude-cli-auth.js";
import { judgeConformance, judgeSeedRows } from "../src/claude-cli-conformance.js";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import {
  boardCallEnv,
  checkUsageThrough,
  execThrough,
  pinnedModelFlags,
  toolSurfaceProbeSpec,
} from "../src/claude-worker.js";
import { SystemClock } from "../src/clock.js";
import { ProcessContainers } from "../src/process-container.js";
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
const scratch = mkdtempSync(join(tmpdir(), "tidepool-conformance-"));

// init 行は封じ込めの probe と同じ注文で撃つ(neutral cwd で撃つのも同じ)
const probeStdout = () =>
  call(toolSurfaceProbeSpec(scratch), readOutput).then((output) => {
    if (output === null) throw new Error("the Board call produced no answer (limit, spawn failure, or no container)");
    return output.stdout;
  });

// result 行は、モデルの1ターンを実際に走らせた stream-json から読む —— `/usage` ping は
// ターンを起こさない(cost 0)ので、worker が読む usage の形を試せない
const oneTurnStdout = () =>
  execThrough(call, "conformance result line")(
    "claude",
    [
      "-p",
      "Reply with the single word OK.",
      "--output-format",
      "stream-json",
      "--verbose",
      ...pinnedModelFlags("haiku", "low"),
      "--max-turns",
      "1",
      "--safe-mode",
    ],
    boardCallEnv(),
  );

const { rows } = await judgeConformance(
  {
    initLine: probeStdout,
    resultLine: oneTurnStdout,
    unknownModel: () =>
      createClaudeModelProbe(cliAuthCommandThrough(call, "conformance model probe"))("claude-conformance-no-such-model"),
    usageScreen: () => checkUsageThrough(call, scratch),
    draft: () =>
      new ClaudeDraftClient({ exec: execThrough(call, "conformance task draft") }).draftTask(
        "Water the greenhouse tomatoes every morning before 9am.",
        "English",
      ),
    translation: () =>
      new ClaudeTranslationClient({ exec: execThrough(call, "conformance translation") }).translate(
        "The board retires a settled tree.",
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
