import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { BoardCall, BoardCallSpec } from "../src/board-call.js";
import { BOARD_CALL_ONE_TURN_FLAGS } from "../src/claude-board-call-runner.js";
import { createClaudeModelProbe } from "../src/claude-cli-auth.js";
import {
  boardCallOneTurnArgs,
  type ConformanceObservations,
  judgeConformance,
  MCP_JSON_SERVER,
  mcpJsonControlSpec,
  workerOneTurnArgs,
} from "../src/claude-cli-conformance.js";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import { execThrough, skillEnumerationSpec } from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import { LANGUAGE_AND_OUTPUT_STYLE_PINNED } from "../src/sandbox.js";
import { composeTerminalScreen } from "../src/usage.js";
import { boardCallStream, CLI_ENVELOPE_USAGE } from "./fakes.js";
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

/** language の問いに1ターンで答えた stream-json の result 行。 */
const answered = (answer: string) =>
  `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer, ...CLI_ENVELOPE_USAGE })}\n`;

/** init 行1本の stdout。 */
const initWith = (mcpServers: Array<{ name: string; status: string }>) =>
  `${JSON.stringify({ type: "system", subtype: "init", mcp_servers: mcpServers })}\n`;
const MCP_JSON_LISTED = initWith([{ name: MCP_JSON_SERVER, status: "connected" }]);

/** 9つの面がどれも今の盤面の読み取り関数で読める観測。 */
function passingObservations(): ConformanceObservations {
  return {
    mcpJson: async () => ({ control: MCP_JSON_LISTED, workerShaped: initWith([]), started: false }),
    initLine: async () => WORKER_STREAM,
    resultLine: async () => WORKER_STREAM,
    outputStyleLine: async () => WORKER_STREAM,
    languageShot: async () => answered("NONE"),
    unknownModel: () =>
      createClaudeModelProbe(async () => ({ exitCode: 1, stdout: ROW_REFUSAL_ENVELOPE }))(
        "claude-conformance-no-such-model",
      ),
    usageScreen: () => composeTerminalScreen(PI_USAGE_CAPTURE_2_1_221, 200, 50),
    draft: () =>
      new ClaudeDraftClient({
        db: openDb(":memory:"),
        exec: async () =>
          boardCallStream({ ...CLI_ENVELOPE_USAGE, result: JSON.stringify({ title: "t", purpose: "p", completion_criteria: "c" }) }),
      }).draftTask("water the greenhouse", "English"),
    translation: () =>
      new ClaudeTranslationClient({
        exec: async () =>
          boardCallStream({
            result: JSON.stringify({ items: [{ id: 0, text: "盤面" }] }),
            total_cost_usd: 0.000586,
            usage: { input_tokens: 506, output_tokens: 16, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
      }).translate(["the board"], "Japanese"),
  };
}

it("9つの面がどれも盤面の読み取り関数で読めれば、全行が合格で試験は通る", async () => {
  const { rows, ok } = await judgeConformance(passingObservations(), PI_CAPTURED_AT);

  expect(rows.map((row) => [row.surface, row.pass])).toEqual([
    ["init line", true],
    ["workspace .mcp.json", true],
    ["result line usage", true],
    ["output style", true],
    ["language", true],
    ["unknown model id → row refusal", true],
    ["usage screen", true],
    ["draft client", true],
    ["translation client", true],
  ]);
  expect(ok).toBe(true);
  expect(rows.find((row) => row.surface === "result line usage")!.detail).toContain("auto-memory closed");
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

it("Board call の init 行が無ければ、auto-memory が閉じているとはみなさない", async () => {
  const { rows, ok } = await judgeConformance(
    { ...passingObservations(), resultLine: async () => WORKER_STREAM.split("\n").slice(1).join("\n") },
    PI_CAPTURED_AT,
  );

  const failed = rows.filter((row) => !row.pass);
  expect(failed.map((row) => row.surface)).toEqual(["result line usage"]);
  expect(failed[0]!.detail).toContain("init");
  expect(ok).toBe(false);
});

it.each([
  [{ auto: "/home/board/.claude/projects/tidepool/memory/" }, "/home/board/.claude/projects/tidepool/memory/"],
  [{ auto: 42 }, "42"],
  [{ auto: null }, "null"],
  [{ auto: { directory: "/unexpected" } }, '{"directory":"/unexpected"}'],
  [["/unexpected"], '["/unexpected"]'],
  ["/unexpected", '"/unexpected"'],
  [null, "null"],
])("Board call の memory_paths %j は不合格になり、観測値を detail に残す", async (memoryPaths, detail) => {
  const [init, ...rest] = WORKER_STREAM.split("\n");
  const stdout = [JSON.stringify({ ...JSON.parse(init!), memory_paths: memoryPaths }), ...rest].join("\n");
  const { rows, ok } = await judgeConformance(
    { ...passingObservations(), resultLine: async () => stdout },
    PI_CAPTURED_AT,
  );

  const failed = rows.filter((row) => !row.pass);
  expect(failed.map((row) => row.surface)).toEqual(["result line usage"]);
  expect(failed[0]!.detail).toContain(detail);
  // 理由は観測値の文字列しか受け取らず、入れ物ごと読めない形と `auto` の値を区別できない
  expect(failed[0]!.detail).not.toContain("carries `auto`");
  expect(ok).toBe(false);
});

// ADR 0341 決定6: 対照が server を載せないなら fixture が死んでいる —— worker の形の空を合格に読まない
it.each([
  ["対照が server を載せない", { control: initWith([]), workerShaped: initWith([]), started: false }, "fixture"],
  ["対照の init 行が無い", { control: "", workerShaped: initWith([]), started: false }, "fixture"],
  ["worker の形が server を載せる", { control: MCP_JSON_LISTED, workerShaped: MCP_JSON_LISTED, started: true }, MCP_JSON_SERVER],
  ["worker の形で server が起動した", { control: MCP_JSON_LISTED, workerShaped: initWith([]), started: true }, "started"],
  ["worker の形の init 行が無い", { control: MCP_JSON_LISTED, workerShaped: "", started: false }, "worker-shaped"],
])("workspace .mcp.json の面は%sとき不合格になる", async (_, observed, detail) => {
  const { rows } = await judgeConformance({ ...passingObservations(), mcpJson: async () => observed }, PI_CAPTURED_AT);

  const failed = rows.filter((row) => !row.pass);
  expect(failed.map((row) => row.surface)).toEqual(["workspace .mcp.json"]);
  expect(failed[0]!.detail).toContain(detail);
});

it("workspace .mcp.json の対照は skill 列挙の ping から --strict-mcp-config だけを外した形で、worker の形は ping そのもの", () => {
  const ping = skillEnumerationSpec("/fixture", false);
  const control = mcpJsonControlSpec("/fixture");

  expect(ping.args).toContain("--strict-mcp-config");
  expect(control.args).toEqual(ping.args.filter((arg) => arg !== "--strict-mcp-config"));
  expect(control.args[control.args.indexOf("--setting-sources") + 1]).toBe("project");
  expect(control.cwd).toBe("/fixture");
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

  expect(rows).toHaveLength(9);
  const failed = rows.filter((row) => !row.pass);
  expect(failed.map((row) => row.surface)).toEqual(["usage screen"]);
  expect(failed[0]!.detail).toContain("spawn claude ENOENT");
  expect(ok).toBe(false);
});

it("Board call の形の1ターンは runner と同じフラグの定数から組む —— runner に足したフラグが試験の argv にも現れる(ADR 0303 決定4)", () => {
  const args = boardCallOneTurnArgs();
  expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
  expect(args).toContain("--verbose");
  expect(args.slice(-BOARD_CALL_ONE_TURN_FLAGS.length)).toEqual([...BOARD_CALL_ONE_TURN_FLAGS]);
});

it("worker の形の1ターンは project tier を読み、盤面の定数で language / outputStyle を固定する", async () => {
  const specs: BoardCallSpec[] = [];
  const capture = (async (spec: BoardCallSpec) => (specs.push(spec), null)) as BoardCall;
  // 設定の層は姿勢が運ぶ(ADR 0341 決定2)—— 口へ出る最終の argv で読む
  await execThrough(capture, "conformance language (worker)", "/cwd", "worker-shaped")("claude", workerOneTurnArgs("/session/system.txt"), {}).catch(() => {});
  const { args } = specs[0]!;
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("project");
  expect(args.filter((arg) => arg === "--setting-sources")).toHaveLength(1);
  expect(JSON.parse(args[args.indexOf("--settings") + 1]!)).toEqual(LANGUAGE_AND_OUTPUT_STYLE_PINNED);
  expect(args).toContain("--append-system-prompt-file");
  expect(args).toContain("/session/system.txt");
});

it("output style の面は init 行の output_style が既定でなければ、または読めなければ不合格になる", async () => {
  const [init, ...rest] = WORKER_STREAM.split("\n");
  const withStyle = (style: unknown) => [JSON.stringify({ ...JSON.parse(init!), output_style: style }), ...rest].join("\n");
  for (const [stdout, detail] of [
    [withStyle("Explanatory"), "Explanatory"],
    [withStyle(undefined), "output_style"],
  ] as const) {
    const { rows, ok } = await judgeConformance({ ...passingObservations(), outputStyleLine: async () => stdout }, PI_CAPTURED_AT);
    const failed = rows.filter((row) => !row.pass);
    expect(failed.map((row) => row.surface)).toEqual(["output style"]);
    expect(failed[0]!.detail).toContain(detail);
    expect(ok).toBe(false);
  }
});

it("language の面は形ごとに3回撃ち、1回でも答えに japanese(大文字小文字を問わない)が含まれれば不合格になる", async () => {
  const shots: string[] = [];
  const { rows, ok } = await judgeConformance(
    {
      ...passingObservations(),
      languageShot: async (shape) => {
        shots.push(shape);
        const nth = shots.filter((s) => s === shape).length;
        return answered(shape === "board call" && nth === 3 ? "Always respond in Japanese." : "NONE");
      },
    },
    PI_CAPTURED_AT,
  );

  expect(shots.filter((s) => s === "worker")).toHaveLength(3);
  expect(shots.filter((s) => s === "board call")).toHaveLength(3);
  const failed = rows.filter((row) => !row.pass);
  expect(failed.map((row) => row.surface)).toEqual(["language"]);
  expect(failed[0]!.detail).toContain("board call");
  expect(failed[0]!.detail).toContain("Always respond in Japanese.");
  expect(ok).toBe(false);
});

it("language の面は result 行の答えが読めなければ不合格になる —— 答えの無い1回を合格に読まない", async () => {
  const { rows, ok } = await judgeConformance(
    { ...passingObservations(), languageShot: async () => WORKER_STREAM.split("\n")[0]! },
    PI_CAPTURED_AT,
  );

  expect(rows.filter((row) => !row.pass).map((row) => row.surface)).toEqual(["language"]);
  expect(ok).toBe(false);
});

it.each([
  ["Always respond in english", true],
  ["常に日本語で回答してください", false],
])("language の面は答え %j を、日本語の指示の引用でなければ合格に読む(worker の形は盤面の english を引用しうる)", async (answer, pass) => {
  const { rows } = await judgeConformance(
    { ...passingObservations(), languageShot: async () => answered(answer) },
    PI_CAPTURED_AT,
  );

  expect(rows.find((row) => row.surface === "language")!.pass).toBe(pass);
});
