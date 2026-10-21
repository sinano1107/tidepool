import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import { type ConformanceObservations, judgeConformance, judgeSeedRows } from "../src/codex-cli-conformance.js";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

/** `model/list` の Model の `supportedReasoningEfforts`(codex-cli 0.147.0 の生成 schema の形)。 */
const efforts = (...values: string[]) =>
  values.map((reasoningEffort) => ({ reasoningEffort, description: `${reasoningEffort} reasoning` }));
const FIVE = ["low", "medium", "high", "xhigh", "max"];

// 盤面の App Server probe の答え。models は 2026-10-21 に Lima VM `tidepool` の codex-cli 0.147.0 で読んだ
// `model/list`(includeHidden: true)の id と effort そのもの(#1409 の表と同じ並び)
const OBSERVED: CodexAppServerProbeResult = {
  status: "observed",
  provider: "openai",
  cliVersion: "codex-cli 0.147.0",
  plan: "plus",
  windows: [
    { name: "primary", model: null, usedPercent: 25, durationMs: 18_000_000, resetsAt: "1970-01-01T05:00:01.000Z" },
    { name: "secondary", model: null, usedPercent: 40, durationMs: 604_800_000, resetsAt: "1970-01-08T00:00:01.000Z" },
  ],
  models: new Map([
    ["gpt-reserve", FIVE],
    ["gpt-5.6-sol", [...FIVE, "ultra"]],
    ["gpt-5.6-terra", [...FIVE, "ultra"]],
    ["gpt-5.6-luna", FIVE],
    ["codex-auto-review", FIVE],
    // 0.147.0 の一覧に gpt-6-astra は無い(#696)—— 合格の観測にするため足してある
    ["gpt-6-astra", FIVE],
  ]),
};

// 2026-10-21 に Lima VM `tidepool` で採った実物(fixture の名前の版で):
// - model-list: codex-cli 0.147.0 の `model/list`(includeHidden: false)の result
// - egress-curl: `codex sandbox -P tidepool-work` に permissionConfig() と features.network_proxy=true を渡し、
//   中から `egressCurl()` の curl を撃った stdout + stderr。0.147.0 は許可ドメインもリスト外も reset(ADR 0256)、
//   0.151.0 は許可ドメインが 200・リスト外が 403。allowed は set-cookie の行だけ落としてある
// - prompt-input-project-doc: codex-cli 0.147.0 を使い捨ての CODEX_HOME(AGENTS.md のマーカー入り)と AGENTS.md を置いた
//   workspace で、`project_doc_max_bytes=0` を付けずに撃ったもの。workspace のパスだけ無害な固定値へ置換してある
const passing = (): ConformanceObservations => ({
  compatibility: async () => ({ ok: true, cliVersion: "codex-cli 0.147.0" }),
  appServer: async () => OBSERVED,
  preflight: async () => ({ available: true }),
  visibleModels: async () => JSON.parse(fixture("codex-model-list-0.147.0.json")),
  allowedDomain: async () => fixture("codex-egress-curl-0.151.0-allowed.txt"),
  unlistedDomain: async () => fixture("codex-egress-curl-0.151.0-blocked.txt"),
  // 実物の 0.147.0 で、global の AGENTS.md だけが見出しで載った形(ADR 0148 の実測)
  promptInput: async () => fixture("codex-prompt-input-global-agents-md.json"),
});

it("各面の観測が盤面の読み取りを通れば、9面すべてが合格で ok", async () => {
  const { rows, ok } = await judgeConformance(passing());

  expect(rows.map((row) => [row.surface, row.pass])).toEqual([
    ["--version / App Server schema", true],
    ["usage (account/rateLimits/read)", true],
    ["authentication", true],
    ["containment preflight", true],
    ["model/list → openai seed rows", true],
    ["effort vocabulary", true],
    ["allowed domain reached", true],
    ["unlisted domain → 403 blocked-by-allowlist", true],
    ["AGENTS.md layer", true],
  ]);
  expect(ok).toBe(true);
});

const visibleModelList = () =>
  JSON.parse(fixture("codex-model-list-0.147.0.json")) as {
    data: Array<{ id: string; supportedReasoningEfforts: Array<{ reasoningEffort: string }> }>;
  };

it.each<[string, string, Partial<ConformanceObservations>, string]>([
  [
    "生成 schema がずれた",
    "--version / App Server schema",
    { compatibility: async () => ({ ok: false, cliVersion: "codex-cli 0.151.0", reason: "required App Server method or response schema drifted" }) },
    "schema drifted",
  ],
  [
    "preflight が成り立たない",
    "containment preflight",
    { preflight: async () => ({ available: false, reason: "Codex containment preflight feature mismatch: code_mode (expected false, observed true)" }) },
    "feature mismatch",
  ],
  [
    "種の openai 行の model が一覧に無い(0.147.0 の gpt-6-astra)",
    "model/list → openai seed rows",
    {
      appServer: async () => ({
        ...OBSERVED,
        models: new Map([...OBSERVED.models].filter(([id]) => id !== "gpt-6-astra")),
      }),
    },
    "gpt-6-astra: the Codex App Server model list (codex-cli 0.147.0, hidden models included) does not include this model id",
  ],
  [
    "種の openai 行の model は一覧にあるが、行の effort を広告しない(盤面の登録の照合と同じ、ADR 0218 決定2)",
    "model/list → openai seed rows",
    {
      appServer: async () => ({
        ...OBSERVED,
        models: new Map([...OBSERVED.models].map(([id, values]) => [id, id === "gpt-5.6-sol" ? ["low", "medium"] : values])),
      }),
    },
    "gpt-5.6-sol: the Codex App Server model list (codex-cli 0.147.0, hidden models included) does not advertise effort high for this model id",
  ],
  [
    "隠れていない model が語彙の値を欠く(隠れた gpt-5.5 が 0.147.0 で max を欠いた形)",
    "effort vocabulary",
    {
      visibleModels: async () => {
        const list = visibleModelList();
        list.data[2]!.supportedReasoningEfforts = efforts("low", "medium", "high", "xhigh");
        return list;
      },
    },
    "gpt-5.6-luna advertises low / medium / high / xhigh",
  ],
  [
    "隠れていない model が語彙の外の値を広告する",
    "effort vocabulary",
    {
      visibleModels: async () => {
        const list = visibleModelList();
        list.data[0]!.supportedReasoningEfforts.push(...efforts("minimal"));
        return list;
      },
    },
    "gpt-5.6-sol advertises low / medium / high / xhigh / max / minimal",
  ],
  [
    "許可ドメインが reset される(0.147.0)",
    "allowed domain reached",
    { allowedDomain: async () => fixture("codex-egress-curl-0.147.0-reset.txt") },
    "Connection reset by peer",
  ],
  [
    "許可したはずのドメインが 403 で閉じる",
    "allowed domain reached",
    { allowedDomain: async () => fixture("codex-egress-curl-0.151.0-blocked.txt") },
    "CONNECT tunnel failed, response 403",
  ],
  [
    "リスト外が reset される(0.147.0)—— 403 で閉じたことにはならない",
    "unlisted domain → 403 blocked-by-allowlist",
    { unlistedDomain: async () => fixture("codex-egress-curl-0.147.0-reset.txt") },
    "Connection reset by peer",
  ],
  [
    "リスト外に届いた(許可の一覧が効いていない)",
    "unlisted domain → 403 blocked-by-allowlist",
    { unlistedDomain: async () => fixture("codex-egress-curl-0.151.0-allowed.txt") },
    "http_connect=200",
  ],
  [
    "global の AGENTS.md が載らない",
    "AGENTS.md layer",
    { promptInput: async () => fixture("codex-prompt-input-no-marker.json") },
    "observed []",
  ],
  [
    "workspace の AGENTS.md が project_doc_max_bytes=0 を越えて載る",
    "AGENTS.md layer",
    { promptInput: async () => fixture("codex-prompt-input-project-doc-0.147.0.json") },
    "# AGENTS.md instructions for /home/board/workspace",
  ],
])("%s: その面だけが不合格で、ok は false", async (_case, surface, changed, detail) => {
  const { rows, ok } = await judgeConformance({ ...passing(), ...changed });

  expect(rows.filter((row) => !row.pass).map((row) => row.surface)).toEqual([surface]);
  expect(rows.find((row) => row.surface === surface)!.detail).toContain(detail);
  expect(ok).toBe(false);
});

it("App Server probe が観測不能なら、それを読む使用量・認証・model/list の3面が理由ごと不合格", async () => {
  const reason = "App Server response drift: Error: account and rate-limit plans contradict each other";
  const { rows } = await judgeConformance({
    ...passing(),
    appServer: async () => ({ status: "unobservable", provider: "openai", cliVersion: "codex-cli 0.147.0", reason }),
  });

  const failed = rows.filter((row) => !row.pass);
  expect(failed.map((row) => row.surface)).toEqual([
    "usage (account/rateLimits/read)",
    "authentication",
    "model/list → openai seed rows",
  ]);
  for (const row of failed) expect(row.detail).toContain(reason);
});

it("失効(unauthorized)は認証の状態として読めたので認証の面は合格、使用量の面は不合格", async () => {
  const { rows } = await judgeConformance({
    ...passing(),
    appServer: async () => ({
      status: "unauthorized",
      provider: "openai",
      cliVersion: "codex-cli 0.147.0",
      reason: "Codex credential is no longer usable: account/read reports no account",
    }),
  });

  expect(rows.find((row) => row.surface === "authentication")).toMatchObject({ pass: true, detail: expect.stringContaining("unauthorized") });
  expect(rows.find((row) => row.surface === "usage (account/rateLimits/read)")!.pass).toBe(false);
});

it("観測が投げた面はその面の不合格として読み、ほかの面は観測を続ける", async () => {
  const { rows } = await judgeConformance({
    ...passing(),
    preflight: async () => {
      throw new Error("spawn codex ENOENT");
    },
  });

  expect(rows.find((row) => row.surface === "containment preflight")).toEqual({
    surface: "containment preflight",
    pass: false,
    detail: "threw: spawn codex ENOENT",
  });
  expect(rows.filter((row) => !row.pass)).toHaveLength(1);
});

it("種の openai 行ごとに exec --json の1ターンを盤面の出力の読み取りで読み、完了だけを合格にする(ADR 0187 決定4)", async () => {
  const turns: Record<string, string> = {
    // 実物の codex-cli 0.147.0 の worker session(`turn.completed` の usage で終わる)
    "gpt-5.6-terra": fixture("worker-session-codex-0.147.0.stream.jsonl"),
    // 一覧に無い model の 400 は `turn.failed` で終わる(#1256 の形)
    "gpt-5.6-sol": [
      { type: "thread.started", thread_id: "t" },
      { type: "turn.started" },
      {
        type: "turn.failed",
        error: {
          message:
            '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-5.6-sol\' model is not supported when using Codex with a ChatGPT account."}}',
        },
      },
    ].map((event) => JSON.stringify(event)).join("\n"),
    // 認証の無い CLI は error event だけを出して1ターンも走らない
    "gpt-6-astra": fixture("codex-auth-failure.jsonl"),
  };
  const asked: Array<{ model: string; effort: string | null }> = [];

  const rows = await judgeSeedRows(async (row) => {
    asked.push(row);
    return turns[row.model]!;
  });

  expect(asked).toEqual([
    { model: "gpt-5.6-terra", effort: "high" },
    { model: "gpt-5.6-sol", effort: "high" },
    { model: "gpt-6-astra", effort: "high" },
  ]);
  expect(rows).toEqual([
    { surface: "seed row gpt-5.6-terra", pass: true, detail: "turn.completed; tokens in 96991 / cached 79616 / out 584" },
    { surface: "seed row gpt-5.6-sol", pass: false, detail: expect.stringContaining("turn.failed: ") },
    { surface: "seed row gpt-6-astra", pass: false, detail: "no turn.completed line with readable usage" },
  ]);
  expect(rows[1]!.detail).toContain("is not supported when using Codex with a ChatGPT account");
});
