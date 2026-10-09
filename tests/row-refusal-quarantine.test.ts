import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CLAUDE_CLI_VERSION } from "../src/claude-cli-version.js";
import { ClaudeDraftClient } from "../src/claude-draft-client.js";
import { ClaudeTranslationClient } from "../src/claude-translation-client.js";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import type { ModelProbe, ModelProbeResult } from "../src/cli-auth.js";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import { openDb } from "../src/db.js";
import { applyExecutionSettingsChange, executionSettingsFor } from "../src/execution-setting.js";
import type { Provider } from "../src/provider.js";
import { registerQuarantine, tableRowValue } from "../src/quarantine.js";
import { FakeContainerRuntime, healthyOpenai, healthyUsageText, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, HOUR, questions, queueWork, registerQuestion, registerWork, type Tidepool } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

/** 行の拒否(CONTEXT.md / ADR 0184、issue #1258)。Claude CLI を喋る Provider が spawn 時の行の
 *  model id を 404 で断った session は、行の Quarantine を1枚立て、失敗にならずに queue の先頭へ戻る。 */

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

/** 後始末は回収済み観測の後ろ = microtask の先にある。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** moonshot(Claude CLI 2.1.286)が未知の id に返した result envelope の形(2026-10-01 実測、#1249)。 */
const REFUSED_404 = `${JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 404, total_cost_usd: 0, modelUsage: {} })}\n`;

/** CLI の版が model の最低版に届かない拒否の result 行(ADR 0187)。2.1.285 以降の実物の result 行は観測して
 *  いない —— 2.1.286 の result 行の schema から組み立てた(#1267)。`result` の文は 2.1.241 で debug 出力に実測した
 *  API の本文。 */
const VERSION_TOO_OLD = `${JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: true,
  api_error_status: 400,
  api_error_code: "claude_code_version_too_old",
  api_error: "claude_code_version_too_old",
  result:
    "Claude Code 2.1.241 does not support this model; version 2.1.251 or newer is required. " +
    "Run 'claude update', or update the Claude desktop app, then try again.",
  total_cost_usd: 0,
  modelUsage: {},
})}\n`;

const events = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}/events`)).json as any[];

/** 実 Claude adapter を fake の容器機構の上で盤面に載せる(worker-exit-without-report.test.ts と同じ形)。 */
async function bootClaude(options: { provider?: Provider; modelProbes?: Partial<Record<Provider, ModelProbe>> } = {}) {
  const provider = options.provider ?? "anthropic";
  const proc = recordingSpawn();
  const registryDir = await makeRegistry();
  const logDir = await tempDir("row-refusal-logs-");
  const moonshotApiKeyFile = join(logDir, "moonshot-api-key");
  writeFileSync(moonshotApiKeyFile, "sk-moonshot-test-key\n", { mode: 0o600 });
  t = await bootTidepool({
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, { provider: [{ name: provider, advisor: false }], tier: undefined }, task),
    openaiUsage: healthyOpenai,
    modelProbes: options.modelProbes,
    containerRuntime: new FakeContainerRuntime(proc.spawn),
    workerAdapter: (deps) => {
      const worker = new ClaudeCodeWorker({
        ...deps,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "deckhand",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:1/mcp",
        logDir,
        moonshotApiKeyFile,
      });
      return {
        id: "adapter",
        start: (task, setting) => worker.start(task, setting),
        gracefulStop: (id) => worker.gracefulStop(id),
        checkUsage: async () => healthyUsageText(t.clock.now()),
      };
    },
  });
  return proc;
}

/** economy ティアに2行ある盤面で、先頭の行(種の claude-sonnet-5-5)の session が `resultLine` で終わる。 */
async function refuseFirstOfTwoRows(resultLine: string) {
  const proc = await bootClaude();
  // 同じ economy ティアに2行目(高いので先頭は種の claude-sonnet-5-5)
  applyExecutionSettingsChange(
    t.db,
    { setting: "row", row: { provider: "anthropic", tier: "economy", model: "claude-sonnet-5", effort: "high", price_in: 3, price_out: 15 } },
    "webui",
    t.clock.now(),
  );
  const refused = queueWork(t, "refused task");
  await t.clock.advance(HOUR);
  // 走っている間に別のタスクを先頭へ置く —— 断られたタスクがその前へ戻ることを見るため
  const other = queueWork(t, "queued after");
  await api(t.baseUrl, "POST", `/api/tasks/${other.id}/move`, { after: null });

  proc.processes[0]!.stdout.write(resultLine);
  proc.emitExit(1, null);
  await settle();
  return refused;
}

it("404 で終わった session は行の Quarantine を1枚立て、failure question も cap_interrupted も無く先頭へ戻り、次の pickup は同じティアの別の行で走る", async () => {
  const refused = await refuseFirstOfTwoRows(REFUSED_404);

  const [question, ...more] = await questions(t);
  expect(more).toEqual([]);
  expect(question.title).toBe("execution-setting row anthropic / claude-sonnet-5-5 cannot run on this board");
  expect(question.question_items[0].options).toEqual(["the row can run again"]);
  const [registered] = await events(question.id);
  expect({ worker: registered.worker_id, origin: registered.origin }).toEqual({ worker: "tidepool", origin: "board" });

  const timeline = await events(refused.id);
  const spawned = timeline.filter((e) => e.kind === "worker_spawned");
  expect(timeline.find((e) => e.kind === "row_refused")).toMatchObject({
    worker_id: "tidepool",
    origin: "board",
    payload: { provider: "anthropic", model: "claude-sonnet-5-5", worker_spawned_event_id: spawned[0].id, cause: "api_404" },
  });
  expect(timeline.map((e) => e.kind)).not.toContain("cap_interrupted");
  // 先頭へ戻ったので、先頭へ動かした other より先に、同じティアの別の行で拾い直される
  expect(spawned.map((e) => e.payload.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5"]);
});

it("CLI の版の古さで終わった session も行の Quarantine を1枚立てて先頭へ戻り、question は原因を名指す(ADR 0187)", async () => {
  const refused = await refuseFirstOfTwoRows(VERSION_TOO_OLD);

  const [question, ...more] = await questions(t);
  expect(more).toEqual([]);
  // 文面そのものは domain の seam(quarantine.test.ts)が言う。ここは証拠の種類が question まで届くことだけ
  expect(question.purpose).toContain("This board's Claude Code CLI is older than this model requires");

  const timeline = await events(refused.id);
  const spawned = timeline.filter((e) => e.kind === "worker_spawned");
  expect(timeline.find((e) => e.kind === "row_refused")?.payload).toMatchObject({
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    cause: "cli_version_too_old",
  });
  expect(timeline.map((e) => e.kind)).not.toContain("cap_interrupted");
  expect(spawned.map((e) => e.payload.model)).toEqual(["claude-sonnet-5-5", "claude-sonnet-5"]);
});

it("同じ行への2度目の観測は question を増やさず、開いている question に再発火を刻む", async () => {
  const proc = await bootClaude();
  queueWork(t, "second observation");
  await t.clock.advance(HOUR);
  // 1度目の観測で開いた Quarantine が、走っている session の途中に既にある
  registerQuarantine(t.db, "tableRow", tableRowValue("anthropic", "claude-sonnet-5-5"), "first observation", t.clock.now());

  proc.processes[0]!.stdout.write(REFUSED_404);
  proc.emitExit(1, null);
  await settle();

  const [question, ...more] = await questions(t);
  expect(more).toEqual([]);
  expect((await events(question.id)).map((e) => e.kind)).toContain("quarantine_refired");
});

it("moonshot の session も同じ経路を通る —— 帰属は spawn 時の (provider, model)", async () => {
  const proc = await bootClaude({ provider: "moonshot" });
  const refused = queueWork(t, "kimi refused");
  await t.clock.advance(HOUR);

  proc.processes[0]!.stdout.write(REFUSED_404);
  proc.emitExit(1, null);
  await settle();

  expect((await questions(t)).map((q) => q.title)).toEqual([
    "execution-setting row moonshot / kimi-k3[1m] cannot run on this board",
  ]);
  expect((await events(refused.id)).find((e) => e.kind === "row_refused")?.payload).toMatchObject({
    provider: "moonshot",
    model: "kimi-k3[1m]",
  });
});

/** 唯一の economy 行が断られた盤面。回答時の probe は `results` を順に返す。 */
async function refuseOnlyRow(results: ModelProbeResult[]) {
  const probedModels: string[] = [];
  const proc = await bootClaude({
    modelProbes: { anthropic: async (model) => (probedModels.push(model), results.shift()!) },
  });
  const refused = queueWork(t, "only row refused");
  await t.clock.advance(HOUR);
  proc.processes[0]!.stdout.write(REFUSED_404);
  proc.emitExit(1, null);
  await settle();
  const [question] = await questions(t);
  return {
    probedModels,
    question,
    queueStatus: async () =>
      ((await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[]).find((row) => row.id === refused.id)?.status,
    answer: () => api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["the row can run again"] }),
  };
}

it("要求ティアの行がすべて外れた task は skipped で、回答は probe が 404 なら拒まれて question が開いたまま、通れば行が候補に戻って拾い直される", async () => {
  const board = await refuseOnlyRow([{ status: "refused", reason: "API returned 404 for this model id" }, { status: "runs" }]);
  expect(await board.queueStatus()).toBe("skipped");

  const still404 = await board.answer();
  expect({ status: still404.status, error: still404.json.error }).toEqual({
    status: 409,
    error: "anthropic / claude-sonnet-5-5 still cannot run: API returned 404 for this model id",
  });
  expect((await questions(t)).map((q) => q.status)).toEqual(["todo"]);
  expect(await board.queueStatus()).toBe("skipped");

  expect((await board.answer()).status).toBe(200);
  await settle();
  expect(board.probedModels).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
  // 行が候補に戻ったので skipped が解ける(枠は、行が外れている間に拾われた周期の meta-review が握っている)
  expect(await board.queueStatus()).toBe("todo");
});

it("回答時の probe が 401 なら、行の回答は拒まれて Provider 認証の確認が立つ", async () => {
  const board = await refuseOnlyRow([{ status: "unauthorized", reason: "API returned 401" }]);

  expect((await board.answer()).status).toBe(409);
  expect((await questions(t)).map((q) => q.title)).toEqual([
    board.question.title,
    "anthropic authentication is unavailable — pickup of anthropic-speaking agents is stopped",
  ]);
});

/** openai の行の照合(ADR 0184 決定3、issue #1260)。Codex は spawn 後の証拠が文言しか無いので、盤面は
 *  App Server の `model/list` を使用量と同じ往復で読み、表の openai の行すべてを一覧と照合する。 */

/** pin の版(codex-cli 0.147.0)が includeHidden: true で返した id と `supportedReasoningEfforts`(#1260 / #1409 の実測)。
 *  種の `gpt-6-astra` は無く、`gpt-5.5` は `max` を広告しない。 */
const UP_TO_MAX = ["low", "medium", "high", "xhigh", "max"];
const MEASURED_OPENAI_MODELS = new Map([
  ["gpt-5.6-sol", [...UP_TO_MAX, "ultra"]],
  ["gpt-5.6-terra", [...UP_TO_MAX, "ultra"]],
  ["gpt-5.6-luna", UP_TO_MAX],
  ["gpt-5.5", ["low", "medium", "high", "xhigh"]],
  ["gpt-reserve", UP_TO_MAX],
  ["codex-auto-review", UP_TO_MAX],
]);

/** openai だけを喋る agent の盤面。`probe` は観測のたびに呼ばれ、回答時の読み直しも同じ口を通る。 */
async function bootOpenai(probe: (now: Date) => Promise<CodexAppServerProbeResult>) {
  t = await bootTidepool({
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, { provider: [{ name: "openai", advisor: false }], tier: undefined }, task),
    openaiUsage: probe,
  });
}

const listingProbe = (models: Map<string, string[]>) => async (now: Date) => ({ ...(await healthyOpenai(now)), models });

it("一覧に無い openai の行は選ばれていてもいなくても Quarantine され、1行に1枚の question が立ち、同じ poll の task は一覧にある行で走る", async () => {
  await bootOpenai(listingProbe(MEASURED_OPENAI_MODELS));
  // 同じ economy ティアの先頭(安い)に一覧に無い行を置く —— 選ばれた行が外れる側
  applyExecutionSettingsChange(
    t.db,
    { setting: "row", row: { provider: "openai", tier: "economy", model: "gpt-5.4-mini", effort: "high", price_in: 1, price_out: 4 } },
    "webui",
    t.clock.now(),
  );
  const task = queueWork(t, "economy codex task");

  await t.clock.advance(HOUR);

  expect((await questions(t)).map((q) => q.title).sort()).toEqual([
    "execution-setting row openai / gpt-5.4-mini cannot run on this board",
    // 種の frontier 行は pin の版の一覧に無く、選ばれていなくても最初の openai の観測で外れる(#696)
    "execution-setting row openai / gpt-6-astra cannot run on this board",
  ]);
  expect(t.worker.started.map((started) => started.id)).toEqual([task.id]);
  expect(t.worker.startedSettings.map((setting) => setting.model)).toEqual(["gpt-5.6-terra"]);
});

// provider 全体の fail-closed は provider-scheduler.test.ts の観測不能の釘が言う。ここは表に一覧外の行
// があっても行の Quarantine が立たないことだけ
it("一覧が読めない観測は、表に一覧外の行があっても行の Quarantine を立てない", async () => {
  await bootOpenai(async () => ({
    status: "unobservable",
    provider: "openai",
    cliVersion: "codex-cli 0.147.0",
    reason: "App Server response drift: Error: model/list failed: models manager unavailable",
  }));
  // 種の行に頼らず、一覧に無い行をこのテスト自身で置く
  applyExecutionSettingsChange(
    t.db,
    { setting: "row", row: { provider: "openai", tier: "economy", model: "gpt-5.4-mini", effort: "high", price_in: 1, price_out: 4 } },
    "webui",
    t.clock.now(),
  );
  queueWork(t, "unreadable list");

  await t.clock.advance(HOUR);

  expect(await questions(t)).toEqual([]);
});

it("openai の行の question への回答は一覧を読み直し、id が載っていなければ拒まれて question は開いたまま、載れば受理される", async () => {
  let models = MEASURED_OPENAI_MODELS;
  await bootOpenai(async (now) => listingProbe(models)(now));
  queueWork(t, "observes the list");
  await t.clock.advance(HOUR);
  const [question] = await questions(t);
  expect(question.title).toBe("execution-setting row openai / gpt-6-astra cannot run on this board");
  const answer = () => api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["the row can run again"] });

  const unlisted = await answer();
  expect({ status: unlisted.status, error: unlisted.json.error }).toEqual({
    status: 409,
    error:
      "openai / gpt-6-astra still cannot run: the Codex App Server model list (codex-cli 0.147.0, hidden models included) " +
      "does not include this model id",
  });
  expect((await questions(t)).map((q) => q.status)).toEqual(["todo"]);

  models = new Map([...MEASURED_OPENAI_MODELS, ["gpt-6-astra", UP_TO_MAX]]);
  expect((await answer()).status).toBe(200);
});

/** 行の effort の照合(ADR 0218 決定2、issue #1656)。一覧にある model が行の effort を広告しなければ、
 *  その行だけが (provider, model, effort) の Quarantine になる。 */

/** gpt-5.5 の2行を足す —— 1つのティアに同じ model は1行なので、high は economy の先頭(最安)、max は standard。 */
function addGpt55Rows() {
  for (const [effort, tier] of [["high", "economy"], ["max", "standard"]] as const) {
    applyExecutionSettingsChange(
      t.db,
      { setting: "row", row: { provider: "openai", tier, model: "gpt-5.5", effort, price_in: 0.5, price_out: 4 } },
      "webui",
      t.clock.now(),
    );
  }
}

it("一覧が gpt-5.5 に max を広告しないとき、gpt-5.5 / max の行だけが Quarantine になり、同じ poll の task は gpt-5.5 / high で走る", async () => {
  await bootOpenai(listingProbe(MEASURED_OPENAI_MODELS));
  addGpt55Rows();
  const task = queueWork(t, "economy codex task");

  await t.clock.advance(HOUR);

  expect((await questions(t)).map((q) => [q.title, q.question_quarantine_kind]).sort()).toEqual([
    ["execution-setting row openai / gpt-5.5 / max cannot run on this board", "tableRowEffort"],
    // 一覧に無い model は今までどおり (provider, model) の Quarantine で、effort は照合しない
    ["execution-setting row openai / gpt-6-astra cannot run on this board", "tableRow"],
  ]);
  expect(t.worker.started.map((started) => started.id)).toEqual([task.id]);
  expect(t.worker.startedSettings.map((setting) => [setting.model, setting.effort])).toEqual([["gpt-5.5", "high"]]);
});

// 1鍵につき1枚(再発火は既存の question に刻む)は種類の表の総なめ(quarantine.test.ts)が言う
it("effort の Quarantine の question は行を (provider, model, effort) で名指し、CLI の版と一覧の観測を書いて表の修正を先に促す", async () => {
  await bootOpenai(listingProbe(MEASURED_OPENAI_MODELS));
  addGpt55Rows();
  queueWork(t, "observes the list");
  await t.clock.advance(HOUR);

  const effortQuestions = (await questions(t)).filter((q) => q.question_quarantine_kind === "tableRowEffort");
  expect(effortQuestions).toHaveLength(1);
  const [question] = effortQuestions;
  expect(question.question_quarantine_value).toBe("openai/gpt-5.5/max");
  expect(question.purpose).toBe(
    "the Codex App Server model list (codex-cli 0.147.0, hidden models included) does not advertise effort max for " +
      "this model id. This board's model list does not advertise this effort for this model — with this Codex CLI " +
      "version and this account. The board does not know why. This row is out of pickup and Board calls while this " +
      "stands; other rows keep running, including this model's rows at other efforts.\n\nRepair one of two ways:\n\n" +
      "1. Fix the table: in the settings tab, change this row's effort or delete the row. This question then closes " +
      "on its own.\n2. If the effort is right, update tidepool or restore the account, then answer — the board reads " +
      "the model list again and accepts the answer only if it advertises this effort for this model.",
  );
  expect(question.question_items[0]).toMatchObject({ title: "Can openai / gpt-5.5 / max run again?", options: ["the row can run again"] });
});

it("一覧が読めない観測は、一覧が広告しない effort の行があっても effort の Quarantine を立てない", async () => {
  let observed = false;
  await bootOpenai(async (now) => {
    if (!observed) return { status: "unobservable", provider: "openai", cliVersion: "codex-cli 0.147.0", reason: "model/list failed" };
    return listingProbe(MEASURED_OPENAI_MODELS)(now);
  });
  addGpt55Rows();
  queueWork(t, "unreadable list");

  await t.clock.advance(HOUR);
  expect(await questions(t)).toEqual([]);

  // 同じ盤面で一覧が読めれば照合する —— 上の空は行が無いせいではない
  observed = true;
  await t.clock.advance(HOUR);
  expect((await questions(t)).map((q) => q.question_quarantine_value)).toContain("openai/gpt-5.5/max");
});

it("effort の Quarantine 中の行の effort を直すと、question は回答なしで盤面名義に決着する", async () => {
  await bootOpenai(listingProbe(MEASURED_OPENAI_MODELS));
  addGpt55Rows();
  queueWork(t, "observes the list");
  await t.clock.advance(HOUR);
  const question = (await questions(t)).find((q) => q.question_quarantine_kind === "tableRowEffort")!;

  const edited = await api(t.baseUrl, "POST", "/api/settings/execution", {
    setting: "row",
    key: { provider: "openai", model: "gpt-5.5", effort: "max" },
    row: { provider: "openai", tier: "standard", model: "gpt-5.5", effort: "xhigh", price_in: 0.5, price_out: 4 },
  });
  expect(edited.status).toBe(200);

  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({ status: "done", question_answer: null });
  expect((await events(question.id)).find((e) => e.kind === "quarantine_released")?.payload).toMatchObject({
    quarantine: "tableRowEffort",
    value: "openai/gpt-5.5/max",
  });
});

it("effort の Quarantine の question への回答は一覧を読み直し、effort が広告されていなければ拒まれて question は開いたまま、広告されれば受理される", async () => {
  let models = MEASURED_OPENAI_MODELS;
  await bootOpenai(async (now) => listingProbe(models)(now));
  addGpt55Rows();
  queueWork(t, "observes the list");
  await t.clock.advance(HOUR);
  const question = (await questions(t)).find((q) => q.question_quarantine_kind === "tableRowEffort")!;
  const answer = () => api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["the row can run again"] });

  const unadvertised = await answer();
  expect({ status: unadvertised.status, error: unadvertised.json.error }).toEqual({
    status: 409,
    error:
      "openai / gpt-5.5 / max still cannot run: the Codex App Server model list (codex-cli 0.147.0, hidden models " +
      "included) does not advertise effort max for this model id",
  });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");

  models = new Map([...MEASURED_OPENAI_MODELS, ["gpt-5.5", UP_TO_MAX]]);
  expect((await answer()).status).toBe(200);
});

/** 非ゼロ終了の stdout に envelope を載せて reject する exec(Claude CLI の one-shot が断られたときの形)。 */
const refusingExec = (envelope: string) => async (): Promise<string> => {
  throw Object.assign(new Error("claude exited with status 1"), { stdout: envelope });
};

const rowQuarantines = async () =>
  (await questions(t)).filter((q) => q.title.startsWith("execution-setting row")).map((q) => [q.title, q.purpose.split(". ")[0]]);

const SONNET_ROW = "execution-setting row anthropic / claude-sonnet-5-5 cannot run on this board";

it("AI 下書きの3用途は、表の行で撃った Board call が断られると行の Quarantine を立て、行が断られたと読める理由で今と同じ失敗応答を返す(ADR 0202)", async () => {
  t = await bootTidepool({
    // client の db は盤面と別にしてある —— 立った Quarantine で行が外れず、3用途がそれぞれ同じ行で断られる配線を通る
    // (盤面と同じ db なら2つ目以降は撃つ前に「すべて Quarantine 中」で撃てなかったになる、ADR 0202 決定4)
    draftClient: new ClaudeDraftClient({ db: openDb(":memory:"), exec: refusingExec(REFUSED_404) }),
    workspace: { name: "tidepool", path: "/workspaces/tidepool" },
  });
  t.github.scriptIssue(189, { title: "issue", body: "body", comments: [] });
  const human = await registerWork(t, "mount the sensor", undefined, "human");
  const refusal = "the anthropic provider refused the execution-setting row anthropic / claude-sonnet-5-5: API error 404 for this model id";

  const task = await api(t.baseUrl, "POST", "/api/tasks/draft", { dump: "draft this" });
  const handoff = await api(t.baseUrl, "POST", `/api/tasks/${human.id}/complete/draft`, { dump: "mounted it" });
  const issue = await api(t.baseUrl, "POST", "/api/tasks", { type: "work", github_issue_number: 189, workspace: "tidepool" });

  expect([task, handoff, issue].map((r) => [r.status, r.json.error])).toEqual([
    [503, refusal],
    [503, refusal],
    [503, `${refusal} See server logs for full details.`],
  ]);
  expect(await rowQuarantines()).toEqual([[SONNET_ROW, "The task draft Board call ended with API error 404 for this model id"]]);
  const [question] = await questions(t);
  expect((await events(question.id)).filter((e) => e.kind === "quarantine_refired").map((e) => e.payload.cause)).toEqual([
    `The handoff draft Board call for task ${human.id} ended with API error 404 for this model id`,
    "The issue inspection Board call ended with API error 404 for this model id",
  ]);
});

it("表示時翻訳が 404 を受けても、行の Quarantine は立たない(ADR 0202 帰結)", async () => {
  t = await bootTidepool({ translationClient: new ClaudeTranslationClient({ exec: refusingExec(REFUSED_404) }) });
  const source = registerQuestion(t, {
    title: "repair decision",
    purpose: "Can the repair proceed?",
    completion_criteria: "answered",
    question: [{ title: "Proceed?", options: ["yes", "no"], recommendation: "yes" }],
  });

  const response = await api(t.baseUrl, "POST", "/api/translate", { type: "question", task_id: source.id });

  expect(response.status).toBe(503);
  expect(await rowQuarantines()).toEqual([]);
});

// ── 起動時の照合(ADR 0218 決定6 / #1659): anthropic / moonshot の行を CLI の組み込みの規則に照らす ──

/** 扉を通らずに入った行(古い release が残した形)を DB に直接書き、同じ DB で起動し直す。 */
async function rebootWithRowsPastTheDoor(rows: Array<{ model: string; effort: string | null; tier: string }>) {
  t = await bootTidepool();
  for (const row of rows) {
    t.db
      .prepare(
        "INSERT INTO execution_settings (provider, tier_id, model, effort, price_in, price_out) VALUES ('anthropic', (SELECT id FROM tiers WHERE name = ?), ?, ?, 1, 5)",
      )
      .run(row.tier, row.model, row.effort);
  }
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });
}

const PAST_THE_DOOR = [
  { model: "claude-haiku-4-5-20251001", effort: "high", tier: "economy" },
  { model: "claude-opus-4-5-20251101", effort: "max", tier: "standard" },
  { model: "claude-sonnet-5-5", effort: null, tier: "standard" },
];

const openEffortQuestions = async () =>
  (await questions(t)).filter((q) => q.status === "todo" && q.question_quarantine_kind === "tableRowEffort");

it("起動時、扉を通らずに入った行で書いた effort のとおりに走らないものは effort の Quarantine になり、題は行を名指し、本文は版の組み込みの規則と書くべき値を名指す", async () => {
  await rebootWithRowsPastTheDoor(PAST_THE_DOOR);

  const opened = await openEffortQuestions();
  expect(opened.map((q) => [q.title, q.question_items])).toEqual([
    ["execution-setting row anthropic / claude-haiku-4-5-20251001 / high does not run with the effort it names", []],
    ["execution-setting row anthropic / claude-opus-4-5-20251101 / max does not run with the effort it names", []],
    ["execution-setting row anthropic / claude-sonnet-5-5 / no effort does not run with the effort it names", []],
  ]);
  expect(opened[0].purpose).toBe(
    `Claude CLI ${CLAUDE_CLI_VERSION}'s built-in model rules do not run this row with the effort it names: ` +
      "claude-haiku-4-5-20251001 takes no effort under the claude CLI's built-in model rules; write no effort (null). " +
      "This row is out of pickup and Board calls while this stands; other rows keep running, including this model's " +
      "rows at other efforts.\n\nRepair: in the settings tab, change this row's effort or delete the row. This " +
      "question then closes on its own — no answer settles it.",
  );
  expect(opened[1].purpose).toContain("runs as high under the claude CLI's built-in model rules; write high.");
  expect(opened[2].purpose).toContain("effort must be one of low / medium / high / xhigh / max.");
  for (const q of opened) expect(q.purpose).not.toMatch(/cannot run|observ/i);
});

it("起動を重ねても、1行につき開いた起動時の照合の question は1枚のまま", async () => {
  await rebootWithRowsPastTheDoor(PAST_THE_DOOR);
  await t.stopServer();
  t = await bootTidepool({ dir: t.dir });

  expect((await openEffortQuestions()).map((q) => q.question_quarantine_value)).toEqual([
    "anthropic/claude-haiku-4-5-20251001/high",
    "anthropic/claude-opus-4-5-20251101/max",
    "anthropic/claude-sonnet-5-5/",
  ]);
});

it("種の表で起動した盤面には、起動時の照合の question は1枚も立たない", async () => {
  t = await bootTidepool();
  expect(await openEffortQuestions()).toEqual([]);
});

it("起動時の照合の question は、行の effort を表で直すと回答なしで決着し、回答は受けない", async () => {
  await rebootWithRowsPastTheDoor([{ model: "claude-opus-4-5-20251101", effort: "max", tier: "standard" }]);
  const [question] = await openEffortQuestions();

  const answered = await api(t.baseUrl, "POST", `/api/tasks/${question.id}/answer`, { answers: ["it runs now"] });
  expect({ status: answered.status, error: answered.json.error }).toEqual({
    status: 409,
    error: "this question carries 0 item(s), but 1 answer(s) were submitted",
  });
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json.status).toBe("todo");

  const edited = await api(t.baseUrl, "POST", "/api/settings/execution", {
    setting: "row",
    key: { provider: "anthropic", model: "claude-opus-4-5-20251101", effort: "max" },
    row: { provider: "anthropic", tier: "standard", model: "claude-opus-4-5-20251101", effort: "high", price_in: 1, price_out: 5 },
  });
  expect(edited.status).toBe(200);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${question.id}`)).json).toMatchObject({ status: "done", question_answer: null });
});
