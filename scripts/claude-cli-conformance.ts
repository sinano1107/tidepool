/** Claude CLI の版上げの適合試験(ADR 0186 決定7 / issue #1275)。このホストの `claude` の
 *  実物の出力を、盤面自身の Board call の口から取って盤面自身の読み取り関数で判定し、面ごとの
 *  合否を Markdown の表で出す。1つでも不合格なら exit 1。
 *
 *  サブスクリプションの認証が要るので CI では回さない。Lima VM で `Delegate=yes` の scope の
 *  中から走らせる(手順は docs/claude-cli-version-bump.md)。版の門は通さない —— 試すのは
 *  まだ固定していない版である。
 *
 *  使い方: systemd-run --user --scope -p Delegate=yes -- npx tsx scripts/claude-cli-conformance.ts */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { createBoardCalls, readOutput } from "../src/board-call.js";
import { containerRuntimeFor } from "../src/cgroup-container.js";
import { cliAuthCommandThrough, createClaudeModelProbe } from "../src/claude-cli-auth.js";
import { judgeConformance } from "../src/claude-cli-conformance.js";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import {
  boardCallEnv,
  checkUsageThrough,
  execThrough,
  TOOL_SURFACE_PROBE_ARGS,
  TOOL_SURFACE_PROBE_TIMEOUT_MS,
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
});
const scratch = mkdtempSync(join(tmpdir(), "tidepool-conformance-"));

// init 行と result 行は封じ込めの probe と同じ1本の `/usage` ping から読む(neutral cwd で撃つのも同じ)
let probeRun: Promise<string> | undefined;
const probeStdout = () =>
  (probeRun ??= call(
    {
      kind: "conformance tool-surface probe",
      command: "claude",
      args: TOOL_SURFACE_PROBE_ARGS,
      cwd: scratch,
      env: boardCallEnv(),
      limitMs: TOOL_SURFACE_PROBE_TIMEOUT_MS,
    },
    readOutput,
  ).then((output) => {
    if (output === null) throw new Error("the Board call produced no answer (limit, spawn failure, or no container)");
    return output.stdout;
  }));

const { rows, ok } = await judgeConformance(
  {
    initLine: probeStdout,
    resultLine: probeStdout,
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

console.log("| surface | result | detail |\n|---|---|---|");
for (const row of rows) console.log(`| ${row.surface} | ${row.pass ? "合格" : "不合格"} | ${row.detail.replaceAll("|", "\\|")} |`);
process.exit(ok ? 0 : 1);
