import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import type { ModelProbe, ModelProbeResult } from "../src/cli-auth.js";
import type { CodexAppServerProbeResult } from "../src/codex-app-server.js";
import { applyExecutionSettingsChange, executionSettingsFor } from "../src/execution-setting.js";
import { registerQuarantine, tableRowValue } from "../src/quarantine.js";
import type { Provider } from "../src/registry.js";
import { FakeContainerRuntime, healthyOpenai, healthyUsageText, recordingSpawn } from "./fakes.js";
import { api, bootTidepool, HOUR, questions, queueWork, type Tidepool, tempDir } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

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

it("404 で終わった session は行の Quarantine を1枚立て、failure question も cap_interrupted も無く先頭へ戻り、次の pickup は同じティアの別の行で走る", async () => {
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

  proc.processes[0]!.stdout.write(REFUSED_404);
  proc.emitExit(1, null);
  await settle();

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
    payload: { provider: "anthropic", model: "claude-sonnet-5-5", worker_spawned_event_id: spawned[0].id },
  });
  expect(timeline.map((e) => e.kind)).not.toContain("cap_interrupted");
  // 先頭へ戻ったので、先頭へ動かした other より先に、同じティアの別の行で拾い直される
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

/** pin の版(codex-cli 0.147.0)が includeHidden: true で返した id(#1260 の実測)。種の `gpt-6-astra` は無い。 */
const MEASURED_OPENAI_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-reserve", "codex-auto-review"];

/** openai だけを喋る agent の盤面。`probe` は観測のたびに呼ばれ、回答時の読み直しも同じ口を通る。 */
async function bootOpenai(probe: (now: Date) => Promise<CodexAppServerProbeResult>) {
  t = await bootTidepool({
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, { provider: [{ name: "openai", advisor: false }], tier: undefined }, task),
    openaiUsage: probe,
  });
}

const listing = (models: string[]) => async (now: Date) => ({ ...(await healthyOpenai(now)), models });

it("一覧に無い openai の行は選ばれていてもいなくても Quarantine され、1行に1枚の question が立ち、同じ poll の task は一覧にある行で走る", async () => {
  await bootOpenai(listing(MEASURED_OPENAI_MODELS));
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

it("一覧が読めない観測は行の Quarantine を立てず、openai の候補を provider 全体で外す", async () => {
  await bootOpenai(async () => ({
    status: "unobservable",
    provider: "openai",
    cliVersion: "codex-cli 0.147.0",
    reason: "App Server response drift: Error: model/list failed: models manager unavailable",
  }));
  const task = queueWork(t, "unreadable list");

  await t.clock.advance(HOUR);

  expect(await questions(t)).toEqual([]);
  expect(t.worker.started).toEqual([]);
  const queue = (await api(t.baseUrl, "GET", "/api/queue")).json.tasks as any[];
  expect(queue.find((row) => row.id === task.id)?.status).toBe("skipped");
});

it("openai の行の question への回答は一覧を読み直し、id が載っていなければ拒まれて question は開いたまま、載れば受理される", async () => {
  let models = MEASURED_OPENAI_MODELS;
  await bootOpenai(async (now) => listing(models)(now));
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

  models = [...MEASURED_OPENAI_MODELS, "gpt-6-astra"];
  expect((await answer()).status).toBe(200);
});
