import { once } from "node:events";
import { Readable } from "node:stream";
import { probeToolSurfaceCapability, readInitReport, readResultEvent, readToolSurface } from "./claude-worker.js";
import type { ModelProbeResult } from "./cli-auth.js";
import { readInitField } from "./stream-json.js";
import { claudeUsageObservation, parseUsage } from "./usage.js";

/** Claude CLI の版上げの適合試験(ADR 0186 決定7)が面ごとに取る観測。どれも1回の実物の
 *  呼び出しで、投げたらその面の不合格として読む(spawn の失敗も観測の1つである)。 */
export interface ConformanceObservations {
  /** 封じ込めの probe と同じフラグで撃った `claude` の stdout(stream-json)。 */
  initLine: () => Promise<string>;
  /** result 行を含む stream-json の stdout。 */
  resultLine: () => Promise<string>;
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

type Verdict = { pass: boolean; detail: string };

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
      const result = await replay(await obs.resultLine(), readResultEvent);
      if (result === null) return { pass: false, detail: "no accepted `result` line (missing, is_error, or a usage shape the board cannot read)" };
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = result.usage;
      return {
        pass: true,
        detail: `cost ${result.total_cost_usd}, tokens in ${input_tokens} / out ${output_tokens} / cache read ${cache_read_input_tokens} / cache write ${cache_creation_input_tokens}`,
      };
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

/** 面ごとの合否。面は順に1つずつ観測する —— 実物の `claude` を同時に起こさない。 */
export async function judgeConformance(
  obs: ConformanceObservations,
  now: Date,
): Promise<{ rows: Array<Verdict & { surface: string }>; ok: boolean }> {
  const rows: Array<Verdict & { surface: string }> = [];
  for (const [surface, judge] of SURFACES) {
    try {
      rows.push({ surface, ...(await judge(obs, now)) });
    } catch (err) {
      rows.push({ surface, pass: false, detail: `threw: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return { rows, ok: rows.every((row) => row.pass) };
}
