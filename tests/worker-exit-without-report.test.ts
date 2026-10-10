import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import { CodexWorker } from "../src/codex-worker.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import type { Provider } from "../src/provider.js";
import type { WorkerFactory } from "../src/server.js";
import { moveTask } from "../src/tasks.js";
import { FakeContainerRuntime, healthyOpenai, recordingSpawn, withHealthyUsage } from "./fakes.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  git,
  HOUR,
  HUMAN_WEBUI,
  mcpClient,
  QUIET_EXIT,
  questions,
  queueWork,
  type Tidepool,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";
import { tempDir } from "./temp-dir.js";

/** ADR 0145(issue #805)。最終 verb なしに root が exit した session は、exit の瞬間に
 *  failure question を立てて後始末へ入る —— タスク種別の時間制限まで枠を握らない。 */

let t: Tidepool;
afterEach(async () => {
  await t?.stop();
});

const MIN = 60 * 1000;
const WATCHDOG = { timeLimits: { work: 90 * MIN }, grace: 30 * MIN, reclaimTimeout: 5 * MIN };

/** 後始末は回収済み観測の後ろ = microtask の先にある。 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const started = () => t.worker.started.map((task) => task.id);

const exitedWithoutReport = async () =>
  (await questions(t)).filter((q: any) => q.title.startsWith("worker exited without reporting:"));

const status = async (id: string) => (await api(t.baseUrl, "GET", `/api/tasks/${id}`)).json.status;

it("最終 verb なしに exit 0 した session は、時間制限を待たずに failure question を1枚立てて枠を空ける —— 文面は時間制限にも回収にも触れない", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "exits quietly");
  const next = queueWork(t, "next in line");
  await t.clock.advance(HOUR);
  expect(started()).toEqual([task.id]);

  t.worker.exitWith(task.id, QUIET_EXIT);
  await settle();

  const [question, ...more] = await exitedWithoutReport();
  expect(more).toEqual([]);
  expect(question.title).toBe("worker exited without reporting: exits quietly");
  expect(question.question_items[0].options).toEqual(["retry", "abandon"]);
  expect(question.question_items[0].recommendation).toBe("retry");
  expect(question.purpose).toContain(task.id);
  expect(question.purpose).toContain("exit code 0");
  expect(question.purpose).toContain("No self-report is possible.");
  expect(question.purpose).not.toMatch(/time limit|reclaimed/i);
  expect(await status(task.id)).toBe("blocked");
  expect(started()).toEqual([task.id, next.id]);
});

it("signal で死んだ session は signal を、stderr が空でなければその末尾を文面に載せる", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "crashes");
  await t.clock.advance(HOUR);

  t.worker.exitWith(task.id, { ...QUIET_EXIT, exit_code: null, signal: "SIGSEGV", stderr_tail: "error: config rejected" });
  await settle();

  const [question] = await exitedWithoutReport();
  expect(question.purpose).toContain("signal SIGSEGV");
  expect(question.purpose).not.toContain("exit code");
  expect(question.purpose).toContain("error: config rejected");
});

it("CLI が報告した失敗の文は、見出し付きで stderr 末尾の前に逐語で載る(ADR 0188)", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "refused");
  await t.clock.advance(HOUR);

  t.worker.exitWith(task.id, {
    ...QUIET_EXIT,
    exit_code: 1,
    stderr_tail: "models cache unreadable",
    reported_error: "API error status 400: model is not available",
  });
  await settle();

  const [question] = await exitedWithoutReport();
  expect(question.purpose).toBe(
    `the worker for task "refused" (${task.id}) exited (exit code 1) without a final report — ` +
      "it did not complete, decompose, or escalate. No self-report is possible." +
      "\n\nerror reported by the CLI:\nAPI error status 400: model is not available" +
      "\n\nstderr tail:\nmodels cache unreadable" +
      '\n\n"retry" restarts this task from scratch at the queue head. "abandon" cancels this task and its remaining work.',
  );
});

it("worker の最後の発話は、見出し付きで CLI が報告した失敗の前に逐語で載る(ADR 0189)", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "cancelled");
  await t.clock.advance(HOUR);

  t.worker.exitWith(task.id, {
    ...QUIET_EXIT,
    exit_code: 1,
    reported_error: "API error status 429: rate limited",
    last_message: "tidepool_complete was cancelled by the MCP server.\nStopping here.",
  });
  await settle();

  const [question] = await exitedWithoutReport();
  expect(question.purpose).toBe(
    `the worker for task "cancelled" (${task.id}) exited (exit code 1) without a final report — ` +
      "it did not complete, decompose, or escalate. No self-report is possible." +
      "\n\nlast message from the worker:\ntidepool_complete was cancelled by the MCP server.\nStopping here." +
      "\n\nerror reported by the CLI:\nAPI error status 429: rate limited" +
      '\n\n"retry" restarts this task from scratch at the queue head. "abandon" cancels this task and its remaining work.',
  );
});

it("CLI が差し替えた model は、見出し付きで1回ずつ `from → to` の行で載り、差し替えが無ければ節ごと出ない(ADR 0215 決定5)", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const swapped = queueWork(t, "swapped");
  const plain = queueWork(t, "plain");
  await t.clock.advance(HOUR);

  t.worker.exitWith(swapped.id, {
    ...QUIET_EXIT,
    stderr_tail: "warn: retrying request",
    model_swaps: [
      { from: "claude-fable-5-1", to: "claude-opus-4-8", scope: "session", category: "cyber" },
      { from: "claude-opus-4-8", to: "claude-opus-5", scope: "local", category: null },
    ],
  });
  await settle();
  t.worker.exitWith(plain.id, { ...QUIET_EXIT, model_swaps: [] });
  await settle();

  const purposeOf = async (title: string) =>
    (await exitedWithoutReport()).find((q: any) => q.title === `worker exited without reporting: ${title}`).purpose;
  expect(await purposeOf("swapped")).toBe(
    `the worker for task "swapped" (${swapped.id}) exited (exit code 0) without a final report — ` +
      "it did not complete, decompose, or escalate. No self-report is possible." +
      "\n\nstderr tail:\nwarn: retrying request" +
      "\n\nmodels swapped in by the CLI:\nclaude-fable-5-1 → claude-opus-4-8\nclaude-opus-4-8 → claude-opus-5" +
      '\n\n"retry" restarts this task from scratch at the queue head. "abandon" cancels this task and its remaining work.',
  );
  expect(await purposeOf("plain")).not.toContain("swapped in");
});

it("CLI が失敗を報告しなかった exit の文面は、その節を持たない(ADR 0188)", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "quiet");
  await t.clock.advance(HOUR);

  t.worker.exitWith(task.id, { ...QUIET_EXIT, exit_code: 1, stderr_tail: "boom" });
  await settle();

  const [question] = await exitedWithoutReport();
  expect(question.purpose).toBe(
    `the worker for task "quiet" (${task.id}) exited (exit code 1) without a final report — ` +
      "it did not complete, decompose, or escalate. No self-report is possible." +
      "\n\nstderr tail:\nboom" +
      '\n\n"retry" restarts this task from scratch at the queue head. "abandon" cancels this task and its remaining work.',
  );
});

it("容器が空になった観測の前は枠を握ったままで、観測のあとで解放される", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "leaves a child behind");
  const next = queueWork(t, "next in line");
  t.containers.hold(task.id);
  await t.clock.advance(HOUR);

  t.worker.exitWith(task.id, { ...QUIET_EXIT, exit_code: 1 });
  await settle();

  expect(await exitedWithoutReport()).toHaveLength(1);
  // 強制回収は adapter が撃った1本だけ(重ねない)
  expect(t.containers.forceReclaims).toEqual([task.id]);
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown.taskId).toBe(task.id);
  await t.clock.advance(MIN);
  expect(started()).toEqual([task.id]);

  t.containers.fireEmpty(task.id);
  await settle();
  expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
  expect(started()).toEqual([task.id, next.id]);
});

it("最終 verb が着地したあとの exit では、この question は立たない", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "reports properly");
  // 後始末がまだ終わっていない(枠を握っている)間に exit が届く
  t.containers.hold(task.id);
  await t.clock.advance(HOUR);
  const client = await mcpClient(t.mcpBaseUrl, task.id);
  try {
    await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  } finally {
    await client.close();
  }

  t.worker.exitWith(task.id, QUIET_EXIT);
  await settle();

  expect(await status(task.id)).not.toBe("in_progress");
  expect(await exitedWithoutReport()).toEqual([]);
});

it("watchdog が畳み込み停止を送達したあとの exit では、この question は立たず、梯子の底で watchdog の question が1枚だけ立つ", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "runs too long");
  t.containers.hold(task.id);
  await t.clock.advance(HOUR);
  await t.clock.advance(90 * MIN); // 畳み込み停止
  expect(t.worker.gracefulStops).toEqual([task.id]);

  t.worker.exitWith(task.id, { ...QUIET_EXIT, exit_code: null, signal: "SIGTERM" });
  await settle();
  expect(await questions(t)).toEqual([]);

  // 猶予が過ぎて watchdog の強制回収 → 回収済み観測
  await t.clock.advance(30 * MIN);
  t.containers.fireEmpty(task.id);
  await settle();
  expect((await questions(t)).map((q: any) => q.title)).toEqual(["watchdog killed task: runs too long"]);
});

it("watchdog に殺されて retry された run が次の tick より先に exit しても、前の run の停止記録に紛れず question が立つ", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "retried");
  await t.clock.advance(HOUR);
  await t.clock.advance(90 * MIN); // 畳み込み停止
  await t.clock.advance(30 * MIN); // 強制回収 → 回収済み観測
  await settle();
  const [killed] = await questions(t);
  await api(t.baseUrl, "POST", `/api/tasks/${killed.id}/answer`, { answers: ["retry"] });
  expect(started()).toEqual([task.id, task.id]);

  t.worker.exitWith(task.id, QUIET_EXIT);
  await settle();

  expect(await exitedWithoutReport()).toHaveLength(1);
});

// ── watchdog kill の question は、観測された root の exit を添える(ADR 0191) ─────────

const TALKATIVE_EXIT = {
  ...QUIET_EXIT,
  exit_code: null,
  signal: "SIGTERM",
  last_message: "still bisecting the flaky test",
  reported_error: "API error status 529: overloaded",
  stderr_tail: "warn: retrying request",
};

const SECTIONS =
  "\n\nlast message from the worker:\nstill bisecting the flaky test" +
  "\n\nerror reported by the CLI:\nAPI error status 529: overloaded" +
  "\n\nstderr tail:\nwarn: retrying request";

const RETRY_OR_ABANDON =
  '\n\n"retry" restarts this task from scratch at the queue head. "abandon" cancels this task and its remaining work.';

const RECLAIMED_PURPOSE =
  `the task hit its work time limit (${90 * MIN}ms) and its container was ` +
  `reclaimed (graceful stop, then force reclaim after ${30 * MIN}ms grace). No self-report is possible.`;

const TIMEOUT_PURPOSE =
  `the task hit its work time limit (${90 * MIN}ms) and its container was force-reclaimed, ` +
  `but the board could not observe the container going empty within ${5 * MIN}ms. No self-report is possible.`;

const watchdogKilled = async () =>
  (await questions(t)).filter((q: any) => q.title.startsWith("watchdog killed task:"));

it("畳み込み停止のあとの exit が持つ最後の発話・CLI の失敗・stderr 末尾は、回収済み観測の question に見出し付き・この順で載る", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "runs too long");
  t.containers.hold(task.id);
  await t.clock.advance(HOUR);
  await t.clock.advance(90 * MIN); // 畳み込み停止

  t.worker.exitWith(task.id, TALKATIVE_EXIT);
  await settle();
  await t.clock.advance(30 * MIN); // 強制回収
  t.containers.fireEmpty(task.id);
  await settle();

  const [question] = await watchdogKilled();
  expect(question.purpose).toBe(RECLAIMED_PURPOSE + SECTIONS + RETRY_OR_ABANDON);
});

it("exit が来ないまま回収 timeout に落ちた question は節を持たない", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "never exits");
  t.containers.hold(task.id);
  await t.clock.advance(HOUR);
  await t.clock.advance(90 * MIN); // 畳み込み停止
  await t.clock.advance(30 * MIN); // 強制回収
  await t.clock.advance(5 * MIN); // 回収 timeout

  const [question] = await watchdogKilled();
  expect(question.purpose).toBe(TIMEOUT_PURPOSE + RETRY_OR_ABANDON);
});

it("root は exit したが容器が空にならず回収 timeout に落ちた question にも、exit の3つが載る", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "leaves a grandchild");
  t.containers.hold(task.id);
  await t.clock.advance(HOUR);
  await t.clock.advance(90 * MIN); // 畳み込み停止

  t.worker.exitWith(task.id, TALKATIVE_EXIT);
  await settle();
  await t.clock.advance(30 * MIN); // 強制回収
  await t.clock.advance(5 * MIN); // 回収 timeout

  const [question] = await watchdogKilled();
  expect(question.purpose).toBe(TIMEOUT_PURPOSE + SECTIONS + RETRY_OR_ABANDON);
});

it("watchdog に殺されて retry された run の question に、前の run の exit は載らない", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "retried");
  await t.clock.advance(HOUR);
  await t.clock.advance(90 * MIN); // 畳み込み停止
  t.worker.exitWith(task.id, TALKATIVE_EXIT);
  await settle();
  await t.clock.advance(30 * MIN); // 強制回収 → 回収済み観測
  await settle();
  const [killed] = await watchdogKilled();
  await api(t.baseUrl, "POST", `/api/tasks/${killed.id}/answer`, { answers: ["retry"] });
  expect(started()).toEqual([task.id, task.id]);

  // 2本目の run は exit しないまま時間制限に達し、強制回収で空になる
  await t.clock.advance(90 * MIN);
  await t.clock.advance(30 * MIN);
  await settle();

  const [question] = (await watchdogKilled()).filter((q: any) => q.id !== killed.id);
  expect(question.purpose).toBe(RECLAIMED_PURPOSE + RETRY_OR_ABANDON);
});

it("決着したタスクの遅れた exit は、枠を継いだタスクの梯子を書き換えず、question も枠の解放も起こさない —— 継いだタスクの question にも載らない", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const first = queueWork(t, "first");
  const second = queueWork(t, "second");
  const third = queueWork(t, "third");
  t.containers.hold(second.id);
  await t.clock.advance(HOUR);
  await t.clock.advance(90 * MIN); // first の畳み込み停止
  t.worker.exitWith(first.id, TALKATIVE_EXIT);
  await settle();
  await t.clock.advance(30 * MIN); // 強制回収 → 回収済み観測 → 枠は second へ
  await settle();
  expect(started()).toEqual([first.id, second.id]);
  await t.clock.advance(90 * MIN); // second の畳み込み停止
  expect(t.worker.gracefulStops).toEqual([first.id, second.id]);

  // second の梯子の途中で first の exit が遅れて届く
  t.worker.exitWith(first.id, TALKATIVE_EXIT);
  await settle();
  expect(await exitedWithoutReport()).toEqual([]);
  expect(await watchdogKilled()).toHaveLength(1);
  expect(started()).toEqual([first.id, second.id]);

  await t.clock.advance(30 * MIN); // second の強制回収
  t.containers.fireEmpty(second.id);
  await settle();
  expect(t.worker.gracefulStops).toEqual([first.id, second.id]);
  const [question] = (await watchdogKilled()).filter((q: any) => q.title === "watchdog killed task: second");
  expect(question.purpose).toBe(RECLAIMED_PURPOSE + RETRY_OR_ABANDON);
  expect(started()).toEqual([first.id, second.id, third.id]);
});

it("retry の回答で task は queue 先頭へ戻り、abandon の回答で cancel される", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const retried = queueWork(t, "retried");
  const abandoned = queueWork(t, "abandoned");
  const busy = queueWork(t, "busy");
  await t.clock.advance(HOUR);
  t.worker.exitWith(retried.id, QUIET_EXIT);
  await settle();
  t.worker.exitWith(abandoned.id, QUIET_EXIT);
  await settle();
  expect(started()).toEqual([retried.id, abandoned.id, busy.id]);
  // retry の回答より前に先頭へ置いた task —— 先頭復帰なら retried がこれを追い越す
  const later = moveTask(t.db, queueWork(t, "later"), null, t.clock.now(), ...HUMAN_WEBUI);

  const byTitle = Object.fromEntries((await exitedWithoutReport()).map((q: any) => [q.title, q]));
  await api(t.baseUrl, "POST", `/api/tasks/${byTitle["worker exited without reporting: abandoned"].id}/answer`, { answers: ["abandon"] });
  expect(await status(abandoned.id)).toBe("cancelled");
  await api(t.baseUrl, "POST", `/api/tasks/${byTitle["worker exited without reporting: retried"].id}/answer`, { answers: ["retry"] });

  const client = await mcpClient(t.mcpBaseUrl, busy.id);
  try {
    await client.callTool({ name: "complete_task", arguments: { handoff: FULL_HANDOFF } });
  } finally {
    await client.close();
  }
  await settle();
  expect(started()).toEqual([retried.id, abandoned.id, busy.id, retried.id]);
  expect(await status(later.id)).toBe("todo");
});

// ── 実 adapter: 両 adapter で同じ結果になる ──────────────────────────────────
// adapter の exit handler を fake の容器機構の上で走らせる。process の exit はテストが撃つ。

/** 実 adapter を盤面に載せる。checkUsage だけは健全な固定値にする(pty を起こさない)。 */
async function bootWithAdapter(
  build: (deps: Parameters<WorkerFactory>[0]) => ClaudeCodeWorker | CodexWorker,
  provider: Provider = "anthropic",
) {
  const proc = recordingSpawn();
  t = await bootTidepool({
    watchdog: WATCHDOG,
    // 盤面が pickup で選ぶ実行設定の provider を adapter に揃える
    taskExecutionCandidates: (task) =>
      executionSettingsFor(t.db, { provider: [{ name: provider, advisor: false }], tier: undefined }, task),
    openaiUsage: healthyOpenai,
    containerRuntime: new FakeContainerRuntime(proc.spawn),
    workerAdapter: (deps) => withHealthyUsage(build(deps), deps.clock),
  });
  return proc;
}

async function bootClaude() {
  const registryDir = await makeRegistry();
  const logDir = await tempDir("exit-without-report-logs-");
  return bootWithAdapter(
    (deps) =>
      new ClaudeCodeWorker({
        ...deps,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "deckhand",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:1/mcp",
        logDir,
      }),
  );
}

async function bootCodex() {
  const workspace = await tempDir("exit-without-report-codex-ws-");
  git(workspace, "init", "-b", "main");
  const registryDir = await makeRegistry({
    "agents/codex-agent.md":
      "---\nname: codex-agent\ndescription: Codex agent\nversion: 1.2.3\nauthority: standard\n" +
      "provider: openai\nskills: []\n---\nYou are the Codex worker.",
    "workspaces.yaml": `work:\n  path: ${workspace}\n`,
  });
  const codexHome = await tempDir("exit-without-report-codex-home-");
  return bootWithAdapter(
    ({ db, clock, containers, onSpawnFailed, onWorkerExited, transcripts }) =>
      new CodexWorker({
        db,
        clock,
        containers,
        onSpawnFailed,
        onWorkerExited,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "codex-agent",
        workspace: "work",
        workspacesDir: tmpdir(),
        mcpUrl: "http://127.0.0.1:1/mcp",
        transcripts,
        codexHome,
        cliVersion: "codex-cli 0.147.0",
        executable: "/opt/tidepool/bin/codex",
      }),
    "openai",
  );
}

for (const [harness, boot] of [["Claude", bootClaude], ["Codex", bootCodex]] as const) {
  it(`${harness} adapter: 最終 verb なしに exit 0 した session は failure question を1枚立てて枠を空ける`, async () => {
    const proc = await boot();
    const task = queueWork(t, "exits quietly");
    await t.clock.advance(HOUR);
    expect(proc.calls).toHaveLength(1);

    proc.processes[0]!.stderr.write("last words\n");
    proc.emitExit(0, null);
    await settle();

    const [question, ...more] = await exitedWithoutReport();
    expect(more).toEqual([]);
    expect(question.title).toBe("worker exited without reporting: exits quietly");
    expect(question.purpose).toContain("exit code 0");
    expect(question.purpose).toContain("last words");
    expect(question.purpose).not.toMatch(/time limit|reclaimed/i);
    expect(await status(task.id)).toBe("blocked");
    expect((await api(t.baseUrl, "GET", "/api/queue")).json.teardown).toBeUndefined();
  });
}

it("Claude adapter: 上限到達による中断で exit した session には、この question は立たない", async () => {
  const proc = await bootClaude();
  const task = queueWork(t, "capped");
  await t.clock.advance(HOUR);

  proc.processes[0]!.stdout.write(readFileSync(join(import.meta.dirname, "fixtures", "worker-session-cap-429.stream.jsonl"), "utf8"));
  proc.emitExit(1, null);
  await settle();

  expect(await questions(t)).toEqual([]);
  // queue 先頭へ戻り、そのまま拾い直される
  expect(await status(task.id)).toBe("in_progress");
  expect(proc.calls).toHaveLength(2);
});

it("Claude adapter: tool surface drift で回収された session は、Containment quarantine の確認 question とこの failure question の2枚を立てる", async () => {
  const proc = await bootClaude();
  queueWork(t, "drifted");
  await t.clock.advance(HOUR);

  proc.processes[0]!.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", tools: ["Bash", "Read", "CronCreate"], mcp_servers: [] })}\n`);
  proc.emitExit(null, "SIGKILL");
  await settle();

  expect((await questions(t)).map((q: any) => q.title).sort()).toEqual([
    "worker containment is not established — pickup is stopped",
    "worker exited without reporting: drifted",
  ]);
});
