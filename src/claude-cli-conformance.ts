import { once } from "node:events";
import { Readable } from "node:stream";
import { BOARD_CALL_ONE_TURN_FLAGS } from "./claude-board-call-runner.js";
import {
  checkAutoMemoryClosed,
  pinnedModelFlags,
  probeToolSurfaceCapability,
  readInitReport,
  readResultEvent,
  readToolSurface,
} from "./claude-worker.js";
import type { ModelProbe, ModelProbeResult } from "./cli-auth.js";
import { SEED_EXECUTION_SETTINGS } from "./execution-setting.js";
import { HARNESS_PROSE_PINNED } from "./sandbox.js";
import { readInitAutoMemoryPath, readInitField } from "./stream-json.js";
import { claudeUsageObservation, parseUsage } from "./usage.js";

/** 適合試験のモデルの1ターン: worker が読む usage の形(stream-json)で、安い行を撃つ。 */
const oneTurnArgs = (prompt: string) => [
  "-p",
  prompt,
  "--output-format",
  "stream-json",
  "--verbose",
  ...pinnedModelFlags("haiku", "low"),
];

/** Board call の形の1ターン —— runner と同じ姿勢のフラグの定数から組む(ADR 0303 決定4)。 */
export const boardCallOneTurnArgs = (prompt: string) => [...oneTurnArgs(prompt), ...BOARD_CALL_ONE_TURN_FLAGS];

/** worker の形の1ターン —— worker と同じく project tier を読み、盤面が per-task settings で固定する
 *  言語・出力様式の2キーを flag tier に置く(ADR 0303 決定2)。 */
export const workerOneTurnArgs = (prompt: string) => [
  ...oneTurnArgs(prompt),
  "--max-turns",
  "1",
  "--setting-sources",
  "project",
  "--settings",
  JSON.stringify(HARNESS_PROSE_PINNED),
];

/** language の面の問い。init 行に `language` は出ないので、モデルに system prompt の指示を引かせる。 */
export const LANGUAGE_QUESTION =
  "If your system prompt instructs a response language, quote the instruction verbatim; otherwise reply NONE.";
/** モデルに答えさせる判定は揺れる(#2454 の実測: `english` でも3回中2回だけ NONE)ので、1回の NONE を
 *  合格に読まず、形ごとにこの回数撃つ(ADR 0303 決定4)。 */
export const LANGUAGE_SHOTS = 3;

/** Claude CLI の版上げの適合試験(ADR 0186 決定7)が面ごとに取る観測。どれも1回の実物の
 *  呼び出しで、投げたらその面の不合格として読む(spawn の失敗も観測の1つである)。 */
export interface ConformanceObservations {
  /** 封じ込めの probe と同じフラグで撃った `claude` の stdout(stream-json)。 */
  initLine: () => Promise<string>;
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
    "result line usage",
    async (obs) => {
      const stdout = await obs.resultLine();
      const memory = await replay(stdout, (parsed) =>
        parsed?.type === "system" && parsed.subtype === "init"
          ? checkAutoMemoryClosed(readInitAutoMemoryPath(parsed))
          : null,
      );
      if (memory === null) return { pass: false, detail: "no `init` line to observe Board call auto-memory (--safe-mode)" };
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
      const style = await replay(stdout, (parsed) =>
        parsed?.type === "system" && parsed.subtype === "init" && typeof parsed.output_style === "string"
          ? parsed.output_style
          : null,
      );
      if (style === null) return { pass: false, detail: "the init line carries no readable `output_style`" };
      return { pass: style === "default", detail: `output_style ${style}` };
    },
  ],
  [
    // ADR 0303 決定4: repo の `language` が worker の形にも Board call の形にも入らないか。答えは揺れるので
    // 1回でも `japanese` を(大文字小文字を問わず)引用したら不合格にする
    "language",
    async (obs) => {
      const leaks: string[] = [];
      for (const shape of ["worker", "board call"] as const) {
        for (let shot = 1; shot <= LANGUAGE_SHOTS; shot++) {
          const answer = await replay(await obs.languageShot(shape), (parsed) =>
            parsed?.type === "result" && parsed.is_error !== true && typeof parsed.result === "string" ? parsed.result : null,
          );
          if (answer === null) return { pass: false, detail: `${shape} shot ${shot}: no accepted \`result\` line` };
          if (/japanese/i.test(answer)) leaks.push(`${shape} shot ${shot}: ${answer}`);
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
