import { z } from "zod";
import { type Row, rowOf, type Verdict } from "./claude-cli-conformance.js";
import { type CodexAppServerProbeResult, type compatibilityCheck, modelListResponse, whyRowUnlisted } from "./codex-app-server.js";
import { codexTokenUsage, observedAgentsMdLayer, parseJsonl, readCodexUsage, readTurnFailure } from "./codex-worker.js";
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
  /** skill の閉鎖の行の観測。script が `SKILL_CLOSURE_MARKERS` の skill を置いた workspace と使い捨ての `CODEX_HOME` で撃つ。 */
  skillClosure: () => Promise<SkillClosureObservation>;
}

export interface SkillClosureObservation {
  /** 盤面の検査(`codexWorkspaceContainment`)の答え —— 閉じた設定の下で有効と報告された skill が無ければ成り立つ。 */
  capability: ContainmentCapability;
  /** その検査が閉じた設定の下で撃った `skills/list` の生の result。 */
  skillsList: unknown;
  /** `skills.config` を外した exec の最初の request の body —— skill が request に載ることの対照。 */
  openRequest: string;
  /** 盤面の `skills.config` を当てた exec の最初の request の body。 */
  closedRequest: string;
  /** 置いた読めない SKILL.md(`description` 無し・frontmatter 無し)の実体の path。 */
  unreadablePaths: readonly string[];
  /** 偽の endpoint が受けた request のどれかに `Authorization` header があったか。 */
  authorizationSent: boolean;
}

/** skill の閉鎖の行で script が SKILL.md と exec の prompt に書き、判定が request の body で探す marker。 */
export const SKILL_CLOSURE_MARKERS = {
  /** 読める skill(description と本文に書く)。閉じなければ request に載る。 */
  readable: {
    flat: "TIDEPOOL_CONFORMANCE_SKILL_FLAT",
    nested: "TIDEPOOL_CONFORMANCE_SKILL_NESTED",
    linked: "TIDEPOOL_CONFORMANCE_SKILL_LINKED",
    ancestor: "TIDEPOOL_CONFORMANCE_SKILL_ANCESTOR",
    codexHome: "TIDEPOOL_CONFORMANCE_SKILL_CODEX_HOME",
  },
  /** exec の prompt —— 捕まえた body がその exec の request であることの印。 */
  prompt: "TIDEPOOL_CONFORMANCE_SKILL_CLOSURE_PROMPT",
} as const;

/** 到達の2行が sandbox の中から撃つ curl(ADR 0256 決定3)。CONNECT の応答の見出しを stdout に出し、
 *  最後の行に CONNECT とその先の HTTP の status を書く。 */
export const egressCurl = (host: string): string[] => [
  "curl", "-sS", "-o", "/dev/null", "-D", "-", "--max-time", "20",
  "-w", "http_connect=%{http_connect} http_code=%{http_code}\n",
  `https://${host}/`,
];

/** 種の行の照合に混ぜる、どの版の一覧にも無い model id。 */
const UNKNOWN_MODEL = "codex-conformance-no-such-model";

/** `skills/list` の entry の `skills[]` と `errors[]` の path。盤面の `skillsListResponse` は `errors[]` を読まないので、ここで読む。 */
const skillsListEntries = z.object({
  data: z.array(
    z.object({
      skills: z.array(z.object({ path: z.string() })),
      errors: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  ),
});

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
  [
    "skill closure",
    async (obs) => {
      // ADR 0259 決定2・3 と #1972: skills/list が exec の読み込む skill をすべて返し、path の enabled=false で閉じること
      const { capability, skillsList, openRequest, closedRequest, unreadablePaths, authorizationSent } = await obs.skillClosure();
      const { readable, prompt } = SKILL_CLOSURE_MARKERS;
      // 盤面の CODEX_HOME のログインが偽の endpoint へ出ていない(使い捨ての CODEX_HOME で撃った)こと
      if (authorizationSent) return fail("a request to the fake Responses endpoint carried an Authorization header");
      const uncaptured = Object.entries({ open: openRequest, closed: closedRequest }).filter(([, body]) => !body.includes(prompt));
      if (uncaptured.length > 0) return fail(`the ${uncaptured.map(([label]) => label).join(" / ")} exec's captured request lacks the prompt ${prompt}`);
      // 対照: 閉じなければ載ること。載らない版では、閉じた側に無いことが閉鎖を示さない
      const unshown = Object.values(readable).filter((marker) => !openRequest.includes(marker));
      if (unshown.length > 0) return fail(`without skills.config the request lacks ${unshown.join(", ")}, so their absence under closure proves nothing`);
      if (!capability.available) return fail(capability.reason);
      const leaked = Object.values(readable).filter((marker) => closedRequest.includes(marker));
      if (leaked.length > 0) return fail(`under the board's skills.config the request still carries ${leaked.join(", ")}`);
      // request は skill を `- name: description (file: path)` で載せ、本文は載せない —— 読めない skill は path で探す
      const loadedUnreadable = unreadablePaths.filter((path) => openRequest.includes(path) || closedRequest.includes(path));
      if (loadedUnreadable.length > 0) return fail(`exec loads ${loadedUnreadable.join(", ")}, which skills/list cannot read`);
      // marker を置いていない skill(system skill など)も含め、閉じた request に skill の行が1つも残らない
      if (closedRequest.includes("(file: ")) return fail("under the board's skills.config the request still lists a skill with a (file: …) locator");
      const entries = skillsListEntries.parse(skillsList).data;
      const errored = entries.flatMap((entry) => entry.errors.map((error) => error.path));
      if (!sameSet(errored, unreadablePaths)) {
        return fail(`skills/list errors[] names [${errored.join(", ")}] instead of the placed ${unreadablePaths.join(", ")}`);
      }
      const listed = new Set(entries.flatMap((entry) => entry.skills.map((skill) => skill.path)));
      const listedAndErrored = errored.filter((path) => listed.has(path));
      if (listedAndErrored.length > 0) return fail(`skills/list reports ${listedAndErrored.join(", ")} in both errors[] and skills[]`);
      return {
        pass: true,
        detail: `${Object.keys(readable).length} skills reach the request only without skills.config; ${errored.length} unreadable skills only in errors[]`,
      };
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
        const completed = events.filter((event) => readCodexUsage(event) !== null).at(-1);
        const usage = readCodexUsage(completed);
        if (!usage) return fail("no turn.completed line with readable usage");
        const tokens = `tokens in ${usage.input_tokens} / cached ${usage.cached_input_tokens} / cache write ${usage.cache_write_input_tokens} / out ${usage.output_tokens}`;
        // worker と同じ正規化で判定する —— 欠測(null)になる報告は seed row でも不合格(#2426)
        return codexTokenUsage(completed) ? { pass: true, detail: `turn.completed; ${tokens}` } : fail(`turn.completed usage is not a measurement; ${tokens}`);
      }),
    );
  }
  return rows;
}
