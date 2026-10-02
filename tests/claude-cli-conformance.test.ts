import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClaudeModelProbe } from "../src/claude-cli-auth.js";
import { type ConformanceObservations, judgeConformance } from "../src/claude-cli-conformance.js";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import { openDb } from "../src/db.js";
import { composeTerminalScreen } from "../src/usage.js";
import { PI_USAGE_CAPTURE_2_1_221 } from "./fixtures/usage-pi-2.1.221.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

// 実 CLI の出力の記録(ADR 0186 決定7 の適合試験は、これを盤面自身の読み取り関数に食わせる)
const WORKER_STREAM = fixture("worker-session-2.1.237.stream.jsonl");
const CAP_429_STREAM = fixture("worker-session-cap-429.stream.jsonl");
// Claude CLI 2.1.286 が未知の model id に返した envelope の形(2026-10-01 実測、#1249)
const ROW_REFUSAL_ENVELOPE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 404,
  total_cost_usd: 0,
  modelUsage: {},
});
const PI_CAPTURED_AT = new Date("2026-08-14T00:00:00.000Z");

/** 6つの面がどれも今の盤面の読み取り関数で読める観測。 */
function passingObservations(): ConformanceObservations {
  return {
    initLine: async () => WORKER_STREAM,
    resultLine: async () => WORKER_STREAM,
    unknownModel: () =>
      createClaudeModelProbe(async () => ({ exitCode: 1, stdout: ROW_REFUSAL_ENVELOPE }))(
        "claude-conformance-no-such-model",
      ),
    usageScreen: () => composeTerminalScreen(PI_USAGE_CAPTURE_2_1_221, 200, 50),
    draft: () =>
      new ClaudeDraftClient({
        db: openDb(":memory:"),
        exec: async () =>
          JSON.stringify({ result: JSON.stringify({ title: "t", purpose: "p", completion_criteria: "c" }) }),
      }).draftTask("water the greenhouse", "English"),
    translation: () =>
      new ClaudeTranslationClient({
        exec: async () =>
          JSON.stringify({
            result: "盤面",
            total_cost_usd: 0.000586,
            usage: { input_tokens: 506, output_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
      }).translate("the board", "Japanese"),
  };
}

it("6つの面がどれも盤面の読み取り関数で読めれば、全行が合格で試験は通る", async () => {
  const { rows, ok } = await judgeConformance(passingObservations(), PI_CAPTURED_AT);

  expect(rows.map((row) => [row.surface, row.pass])).toEqual([
    ["init line", true],
    ["result line usage", true],
    ["unknown model id → row refusal", true],
    ["usage screen", true],
    ["draft client", true],
    ["translation client", true],
  ]);
  expect(ok).toBe(true);
});

it("1つの面が崩れたら、その面の行だけが不合格になり試験は落ちる", async () => {
  // 上限到達で止まった session の result 行は is_error で、盤面は usage として読まない
  const { rows, ok } = await judgeConformance(
    { ...passingObservations(), resultLine: async () => CAP_429_STREAM },
    PI_CAPTURED_AT,
  );

  expect(rows.filter((row) => !row.pass).map((row) => row.surface)).toEqual(["result line usage"]);
  expect(ok).toBe(false);
});

it("観測が投げても(spawn の失敗)、その面を不合格にして残りの面の表を出す", async () => {
  const { rows, ok } = await judgeConformance(
    {
      ...passingObservations(),
      usageScreen: async () => {
        throw new Error("spawn claude ENOENT");
      },
    },
    PI_CAPTURED_AT,
  );

  expect(rows).toHaveLength(6);
  const failed = rows.filter((row) => !row.pass);
  expect(failed.map((row) => row.surface)).toEqual(["usage screen"]);
  expect(failed[0]!.detail).toContain("spawn claude ENOENT");
  expect(ok).toBe(false);
});
