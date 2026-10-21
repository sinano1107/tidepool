import { type Row, rowOf, type Verdict } from "./claude-cli-conformance.js";
import { type CodexAppServerProbeResult, type compatibilityCheck, modelListResponse, whyRowUnlisted } from "./codex-app-server.js";
import { observedAgentsMdLayer, parseJsonl, readTurnFailure, readUsage } from "./codex-worker.js";
import type { ContainmentCapability } from "./containment.js";
import { EFFORT_LEVELS } from "./effort.js";
import { SEED_EXECUTION_SETTINGS } from "./execution-setting.js";

/** Codex CLI の版上げの適合試験(ADR 0186 決定7 / issue #1385)が面ごとに取る観測。どれも実物の呼び出しで、
 *  投げたらその面の不合格として読む(Claude 側の `ConformanceObservations` と同じ読み)。 */
export interface ConformanceObservations {
  /** 盤面の互換性検査(`--version` と app-server の method・schema)の答え。 */
  compatibility: () => ReturnType<typeof compatibilityCheck>;
  /** 盤面の App Server probe の答え(使用量・認証・`model/list`)。 */
  appServer: () => Promise<CodexAppServerProbeResult>;
  /** 封じ込めの preflight の答え。 */
  preflight: () => Promise<ContainmentCapability>;
  /** 隠れた model を含めない `model/list`(includeHidden: false)の result。 */
  visibleModels: () => Promise<unknown>;
  /** 盤面と同じ permission profile の `codex sandbox` から、許可ドメインへ `egressCurl` を撃った stdout + stderr。 */
  allowedDomain: () => Promise<string>;
  /** 同じ形でリスト外へ撃った stdout + stderr。 */
  unlistedDomain: () => Promise<string>;
  /** マーカーの `$CODEX_HOME/AGENTS.md` と workspace の `AGENTS.md` を置き、`project_doc_max_bytes=0` で撃った
   *  `codex debug prompt-input` の stdout。 */
  promptInput: () => Promise<string>;
}

/** 到達の2行が sandbox の中から撃つ curl(ADR 0256 決定3)。CONNECT の応答の見出しを stdout に出し、
 *  最後の行に CONNECT とその先の HTTP の status を書く。 */
export const egressCurl = (host: string): string[] => [
  "curl", "-sS", "-o", "/dev/null", "-D", "-", "--max-time", "20",
  "-w", "http_connect=%{http_connect} http_code=%{http_code}\n",
  `https://${host}/`,
];

/** 種の行の照合に混ぜる、どの版の一覧にも無い model id。 */
const UNKNOWN_MODEL = "codex-conformance-no-such-model";

const openaiSeedRows = () => SEED_EXECUTION_SETTINGS.filter((row) => row.provider === "openai");
const fail = (detail: string): Verdict => ({ pass: false, detail });
const lastLine = (output: string) => output.trim().split("\n").at(-1)?.trim() || "no output";
const sameSet = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

const SURFACES: Array<[string, (obs: ConformanceObservations) => Promise<Verdict>]> = [
  [
    "--version / App Server schema",
    async (obs) => {
      const result = await obs.compatibility();
      return result.ok
        ? { pass: true, detail: `${result.cliVersion}; account / rate-limit / model-list schemas conform` }
        : fail(result.reason);
    },
  ],
  [
    "usage (account/rateLimits/read)",
    async (obs) => {
      const result = await obs.appServer();
      if (result.status !== "observed") return fail(`${result.status}: ${result.reason}`);
      return { pass: true, detail: result.windows.map((window) => `${window.name} ${window.usedPercent}%`).join(", ") };
    },
  ],
  [
    "authentication",
    async (obs) => {
      const result = await obs.appServer();
      if (result.status === "unobservable") return fail(`unobservable: ${result.reason}`);
      return { pass: true, detail: result.status === "observed" ? `signed in (${result.plan})` : `unauthorized: ${result.reason}` };
    },
  ],
  [
    "containment preflight",
    async (obs) => {
      const capability = await obs.preflight();
      return capability.available ? { pass: true, detail: "holds" } : fail(capability.reason);
    },
  ],
  [
    "model/list → openai seed rows",
    async (obs) => {
      const result = await obs.appServer();
      if (result.status !== "observed") return fail(`${result.status}: ${result.reason}`);
      // 盤面の登録の照合と同じく effort も照らす(ADR 0218 決定2)
      const unlisted = openaiSeedRows().flatMap(({ model, effort }) => {
        const why = whyRowUnlisted(result, model, effort ?? undefined);
        return why ? [`${model}: ${why.reason}`] : [];
      });
      if (unlisted.length > 0) return fail(unlisted.join("; "));
      // 存在しない id は行の拒否の理由として読める(ADR 0184 決定3)
      const unknown = whyRowUnlisted(result, UNKNOWN_MODEL);
      return unknown
        ? { pass: true, detail: `${openaiSeedRows().length} seed models listed; an unknown id reads as: ${unknown.reason}` }
        : fail(`the model list includes ${UNKNOWN_MODEL}`);
    },
  ],
  [
    "effort vocabulary",
    async (obs) => {
      const { data } = modelListResponse.parse(await obs.visibleModels());
      if (data.length === 0) return fail("model/list returned no visible model");
      const drift = data.flatMap(({ id, supportedReasoningEfforts }) => {
        // ADR 0216 決定2: `ultra` は effort に数えない
        const advertised = supportedReasoningEfforts.map((option) => option.reasoningEffort).filter((effort) => effort !== "ultra");
        return sameSet(advertised, EFFORT_LEVELS) ? [] : [`${id} advertises ${advertised.join(" / ")}`];
      });
      return drift.length > 0
        ? fail(`${drift.join("; ")}; the board's vocabulary is ${EFFORT_LEVELS.join(" / ")}`)
        : { pass: true, detail: `${data.length} visible models advertise ${EFFORT_LEVELS.join(" / ")}` };
    },
  ],
  [
    "allowed domain reached",
    async (obs) => {
      const output = await obs.allowedDomain();
      const status = output.match(/^http_connect=(\d{3}) http_code=(\d{3})$/m);
      return { pass: status?.[1] === "200" && status[2] !== "000", detail: lastLine(output) };
    },
  ],
  [
    "unlisted domain → 403 blocked-by-allowlist",
    async (obs) => {
      const output = await obs.unlistedDomain();
      const closed = /^http_connect=403 /m.test(output) && /^x-proxy-error:\s*blocked-by-allowlist\s*$/im.test(output);
      return { pass: closed, detail: closed ? "CONNECT 403, x-proxy-error: blocked-by-allowlist" : lastLine(output) };
    },
  ],
  [
    "AGENTS.md layer",
    async (obs) => {
      // ADR 0148 / #890: global の層の見出しが1つだけ載り、workspace の AGENTS.md は載らない
      const expected = ["# AGENTS.md instructions"];
      const layer = observedAgentsMdLayer(await obs.promptInput());
      return JSON.stringify(layer) === JSON.stringify(expected)
        ? { pass: true, detail: "the global heading only; the workspace AGENTS.md stays out" }
        : fail(`expected ${JSON.stringify(expected)}, observed ${JSON.stringify(layer)}`);
    },
  ],
];

/** 面ごとの合否。面は順に1つずつ観測する —— 実物の `codex` を同時に起こさない。 */
export async function judgeConformance(obs: ConformanceObservations): Promise<{ rows: Row[]; ok: boolean }> {
  const rows: Row[] = [];
  for (const [surface, judge] of SURFACES) rows.push(await rowOf(surface, () => judge(obs)));
  return { rows, ok: rows.every((row) => row.pass) };
}

/** 種の openai 行ごとに `exec --json` の最小の1ターンを撃ち(ADR 0187 決定4)、worker の出力の読み取りで読む:
 *  `turn.failed` が無く、`turn.completed` の usage が読めたときだけ合格。1行ずつ順に撃つ。 */
export async function judgeSeedRows(
  execTurn: (row: { model: string; effort: string | null }) => Promise<string>,
): Promise<Row[]> {
  const rows: Row[] = [];
  for (const { model, effort } of openaiSeedRows()) {
    rows.push(
      await rowOf(`seed row ${model}`, async () => {
        const events = (await execTurn({ model, effort })).split("\n").map(parseJsonl);
        const failure = events.map(readTurnFailure).filter((message) => message !== null).at(-1);
        if (failure !== undefined) return fail(`turn.failed: ${failure}`);
        const usage = events.map(readUsage).filter((read) => read !== null).at(-1);
        return usage
          ? { pass: true, detail: `turn.completed; tokens in ${usage.input_tokens} / cached ${usage.cached_input_tokens} / cache write ${usage.cache_write_input_tokens} / out ${usage.output_tokens}` }
          : fail("no turn.completed line with readable usage");
      }),
    );
  }
  return rows;
}
