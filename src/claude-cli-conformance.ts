import { once } from "node:events";
import { Readable } from "node:stream";
import type { BoardCallSpec } from "./board-call.js";
import { BOARD_CALL_ONE_TURN_FLAGS } from "./claude-board-call-runner.js";
import { readResultEvent } from "./claude-stream-reader.js";
import {
  checkAutoMemoryClosed,
  pinnedModelFlags,
  probeToolSurfaceCapability,
  readInitReport,
  readToolSurface,
  skillEnumerationSpec,
} from "./claude-worker.js";
import type { ModelProbe, ModelProbeResult } from "./cli-auth.js";
import { SEED_EXECUTION_SETTINGS } from "./execution-setting.js";
import { LANGUAGE_AND_OUTPUT_STYLE_PINNED } from "./sandbox.js";
import { readInitAutoMemoryPath, readInitField, readInitMcpServers, readInitOutputStyle } from "./stream-json.js";
import { claudeUsageObservation, parseUsage } from "./usage.js";

/** 適合試験のモデルの1ターン: worker が読む usage の形(stream-json)で、安い行を撃つ。 */
const oneTurnArgs = () => [
  "-p",
  "--output-format",
  "stream-json",
  "--verbose",
  ...pinnedModelFlags("haiku", "low"),
];

/** Board call の形の1ターン —— runner と同じ姿勢のフラグの定数から組む(ADR 0303 決定4)。 */
export const boardCallOneTurnArgs = () => [
  "-p", ...pinnedModelFlags("haiku", "low"), ...BOARD_CALL_ONE_TURN_FLAGS,
];

/** worker の形の1ターン —— `worker-shaped` の姿勢で撃ち(worker と同じく project tier を読む、ADR 0341 決定2)、
 *  盤面が per-task settings で固定する言語・出力様式の2キーを flag tier に置く(ADR 0303 決定2)。 */
export const workerOneTurnArgs = (systemPromptFile: string) => [
  ...oneTurnArgs(),
  "--append-system-prompt-file", systemPromptFile,
  "--max-turns",
  "1",
  "--settings",
  JSON.stringify(LANGUAGE_AND_OUTPUT_STYLE_PINNED),
];

/** `.mcp.json` の面(ADR 0341 決定6)の fixture が置く stdio server の名前。 */
export const MCP_JSON_SERVER = "conformance-mcp-json";

/** `.mcp.json` の面の対照: skill 列挙の ping から strict だけを外した形 —— server が載ることが fixture の生きている証拠。
 *  姿勢の欄は ping のまま残る(口は読まない)。 */
export const mcpJsonControlSpec = (cwd: string): BoardCallSpec => {
  const ping = skillEnumerationSpec(cwd, false);
  return { ...ping, kind: "conformance .mcp.json control", args: ping.args.filter((arg) => arg !== "--strict-mcp-config") };
};

/** language の面の問い。init 行に `language` は出ないので、モデルに system prompt の指示を引かせる。 */
export const LANGUAGE_QUESTION =
  "If your system prompt instructs a response language, quote the instruction verbatim; otherwise reply NONE.";
/** モデルに答えさせる判定は揺れる(#2454 の実測: `english` でも3回中2回だけ NONE)ので、1回の NONE を
 *  合格に読まず、形ごとにこの回数撃つ(ADR 0303 決定4)。 */
const LANGUAGE_SHOTS = 3;

/** Claude CLI の版上げの適合試験(ADR 0186 決定7)が面ごとに取る観測。どれも1回の実物の
 *  呼び出しで、投げたらその面の不合格として読む(spawn の失敗も観測の1つである)。 */
export interface ConformanceObservations {
  /** 封じ込めの probe と同じフラグで撃った `claude` の stdout(stream-json)。 */
  initLine: () => Promise<string>;
  /** `.mcp.json`(`MCP_JSON_SERVER` の stdio server 1本、起動で marker を書く)を置いた neutral cwd で、skill 列挙の ping
   *  (`workerShaped`)と対照(`mcpJsonControlSpec`)を撃った stdout。`started` は worker の形のあと、対照の前に読んだ marker の有無。 */
  mcpJson: () => Promise<{ control: string; workerShaped: string; started: boolean }>;
  /** Board call と同じ cwd / フラグ(`boardCallOneTurnArgs`)でモデルの1ターンを走らせた stdout(init / result 行を含む)。 */
  resultLine: () => Promise<string>;
  /** 封じ込めの probe と同じ注文を、`.claude/settings.json` に既定でない `outputStyle` を置いた neutral cwd で撃った stdout。 */
  outputStyleLine: () => Promise<string>;
  /** `.claude/settings.json` に `{"language":"japanese"}` を置いた neutral cwd で、`LANGUAGE_QUESTION` を
   *  worker の形(`workerOneTurnArgs`)か Board call の形(`boardCallOneTurnArgs`)で1回撃った stdout。 */
  languageShot: (shape: "worker" | "board call") => Promise<string>;
  /** 存在しない model id での行の probe の判定。 */
  unknownModel: () => Promise<ModelProbeResult>;
  /** 使用量画面の合成済みテキスト(`checkUsage` の答え)。 */
  usageScreen: () => Promise<string | null>;
  /** 下書きの client の1回。解決すれば client 自身の読みが通った。 */
  draft: () => Promise<unknown>;
  /** 翻訳の client の1回。 */
  translation: () => Promise<unknown>;
}

/** 記録された stdout を、盤面の init 行の読み手と同じ「最後に読めた行が勝つ」で読む。 */
async function replay<T>(stdout: string, project: (parsed: Record<string, unknown> | null) => T | null) {
  const stream = Readable.from([stdout]);
  const read = readInitReport(stream, project);
  await once(stream, "end");
  return read();
}

export type Verdict = { pass: boolean; detail: string };
export type Row = Verdict & { surface: string };

const SURFACES: Array<[string, (obs: ConformanceObservations, now: Date) => Promise<Verdict>]> = [
  [
    "init line",
    async (obs) => {
      const stdout = await obs.initLine();
      const surface = await probeToolSurfaceCapability(() => replay(stdout, readToolSurface));
      const skills = await replay(stdout, (parsed) => readInitField(parsed, "skills"));
      if (!surface.available) return { pass: false, detail: surface.reason };
      if (skills === null) return { pass: false, detail: "the init line carries no readable `skills`" };
      return { pass: true, detail: `tools / mcp_servers / memory_paths as declared, ${skills.length} skills` };
    },
  ],
  [
    // ADR 0341 決定6: worker の形が依る vendor 挙動(strict が `.mcp.json` の server を立てない)を版上げの門で測る。
    // 対照が載せなければ fixture の失敗で、worker の形の空を合格に読まない
    "workspace .mcp.json",
    async (obs) => {
      const { control, workerShaped, started } = await obs.mcpJson();
      const listed = await replay(control, readInitMcpServers);
      if (!listed?.some(({ name }) => name === MCP_JSON_SERVER)) {
        return {
          pass: false,
          detail: `fixture failure: the control (no \`--strict-mcp-config\`) lists no \`${MCP_JSON_SERVER}\` in init \`mcp_servers\`, so the worker-shaped row proves nothing`,
        };
      }
      const servers = await replay(workerShaped, readInitMcpServers);
      if (servers === null) return { pass: false, detail: "worker-shaped: the init line carries no readable `mcp_servers`" };
      if (servers.length > 0 || started) {
        return {
          pass: false,
          detail: `worker-shaped: mcp_servers [${servers.map(({ name }) => name).join(", ")}], server ${started ? "started" : "not started"}`,
        };
      }
      return { pass: true, detail: `the control lists \`${MCP_JSON_SERVER}\`; worker-shaped lists none and the server never started` };
    },
  ],
  [
    "result line usage",
    async (obs) => {
      const stdout = await obs.resultLine();
      const memory = await replay(stdout, (parsed) =>
        parsed?.type === "system" && parsed.subtype === "init"
          ? checkAutoMemoryClosed(readInitAutoMemoryPath(parsed))
          : null,
      );
      if (memory === null) return { pass: false, detail: "no `init` line to observe Board call auto-memory (`BOARD_CALL_ONE_TURN_FLAGS`)" };
      if (!memory.available) return { pass: false, detail: memory.reason };
      const result = await replay(stdout, readResultEvent);
      if (result === null) return { pass: false, detail: "no accepted `result` line (missing, is_error, or a usage shape the board cannot read)" };
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = result.usage;
      return {
        pass: true,
        detail: `auto-memory closed; cost ${result.total_cost_usd}, tokens in ${input_tokens} / out ${output_tokens} / cache read ${cache_read_input_tokens} / cache write ${cache_creation_input_tokens}`,
      };
    },
  ],
  [
    // ADR 0303 決定4: 盤面の `outputStyle: "default"` が repo の値に勝つか。キーが改名されれば黙って効かなくなるので、
    // 読めない `output_style` も不合格に読む
    "output style",
    async (obs) => {
      const stdout = await obs.outputStyleLine();
      const style = await replay(stdout, readInitOutputStyle);
      if (style === null) return { pass: false, detail: "the init line carries no readable `output_style`" };
      return { pass: style === "default", detail: `output_style ${style}` };
    },
  ],
  [
    // ADR 0303 決定4: repo の `language` が worker の形にも Board call の形にも入らないか。答えは揺れるので
    // 1回でも `japanese`(大文字小文字を問わず)か `日本語` を答えに含めたら不合格にする —— 漏れた指示に引かれて日本語で答える回も拾う
    "language",
    async (obs) => {
      const leaks: string[] = [];
      for (const shape of ["worker", "board call"] as const) {
        for (let shot = 1; shot <= LANGUAGE_SHOTS; shot++) {
          const answer = await replay(await obs.languageShot(shape), (parsed) => {
            const { result } = (readResultEvent(parsed) ?? {}) as { result?: unknown };
            return typeof result === "string" ? result : null;
          });
          if (answer === null) return { pass: false, detail: `${shape} shot ${shot}: no accepted \`result\` line` };
          if (/japanese|日本語/i.test(answer)) leaks.push(`${shape} shot ${shot}: ${answer}`);
        }
      }
      return leaks.length > 0
        ? { pass: false, detail: leaks.join("; ") }
        : { pass: true, detail: `no japanese in ${LANGUAGE_SHOTS} shots each of worker / board call` };
    },
  ],
  [
    "unknown model id → row refusal",
    async (obs) => {
      const result = await obs.unknownModel();
      return { pass: result.status === "refused", detail: result.status === "runs" ? "runs" : `${result.status}: ${result.reason}` };
    },
  ],
  [
    "usage screen",
    async (obs, now) => {
      const screen = await obs.usageScreen();
      if (screen === null) return { pass: false, detail: "the usage TUI produced no panel" };
      const observation = claudeUsageObservation(parseUsage(screen, now));
      return {
        pass: observation.status !== "unobservable",
        detail: observation.reason ?? `${observation.windows.length} windows read`,
      };
    },
  ],
  ["draft client", async (obs) => (await obs.draft(), { pass: true, detail: "drafted" })],
  ["translation client", async (obs) => (await obs.translation(), { pass: true, detail: "translated" })],
];

/** 1面の観測を行にする。投げたらその面の不合格として読む。Codex の適合試験も同じ読みで使う。 */
export async function rowOf(surface: string, judge: () => Promise<Verdict>): Promise<Row> {
  try {
    return { surface, ...(await judge()) };
  } catch (err) {
    return { surface, pass: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 面ごとの合否。面は順に1つずつ観測する —— 実物の `claude` を同時に起こさない。 */
export async function judgeConformance(
  obs: ConformanceObservations,
  now: Date,
): Promise<{ rows: Row[]; ok: boolean }> {
  const rows: Row[] = [];
  for (const [surface, judge] of SURFACES) rows.push(await rowOf(surface, () => judge(obs, now)));
  return { rows, ok: rows.every((row) => row.pass) };
}

/** 種の anthropic 行ごとに、盤面が回答時の再検査に使う model probe をこの版で撃つ(ADR 0187 決定4)。
 *  走ったときだけ合格 —— 判定は probe の答えそのものである。1行ずつ順に撃つ。 */
export async function judgeSeedRows(probe: ModelProbe): Promise<Row[]> {
  const rows: Row[] = [];
  for (const { provider, model } of SEED_EXECUTION_SETTINGS) {
    if (provider !== "anthropic") continue;
    rows.push(
      await rowOf(`seed row ${model}`, async () => {
        const result = await probe(model);
        return result.status === "runs"
          ? { pass: true, detail: "runs" }
          : { pass: false, detail: `${result.status}: ${result.reason}` };
      }),
    );
  }
  return rows;
}
