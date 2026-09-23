import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import { CodexWorker } from "../src/codex-worker.js";
import { executionSettingsFor } from "../src/execution-setting.js";
import type { Provider } from "../src/registry.js";
import type { WorkerFactory } from "../src/server.js";
import { moveTask } from "../src/tasks.js";
import { FakeContainerRuntime, healthyOpenai, healthyUsageText, recordingSpawn } from "./fakes.js";
import {
  api,
  bootTidepool,
  FULL_HANDOFF,
  git,
  HOUR,
  mcpClient,
  questions,
  queueWork,
  type Tidepool,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

/** ADR 0145(issue #805)。最終 verb なしに root が exit した session は、exit の瞬間に
 *  failure question を立てて後始末へ入る —— タスク種別の時間制限まで枠を握らない。 */

let t: Tidepool;
const dirs: string[] = [];
afterEach(async () => {
  await t?.stop();
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
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

  t.worker.exitWith(task.id, { exit_code: 0, signal: null, stderr_tail: null });
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

  t.worker.exitWith(task.id, { exit_code: null, signal: "SIGSEGV", stderr_tail: "error: config rejected" });
  await settle();

  const [question] = await exitedWithoutReport();
  expect(question.purpose).toContain("signal SIGSEGV");
  expect(question.purpose).not.toContain("exit code");
  expect(question.purpose).toContain("error: config rejected");
});

it("容器が空になった観測の前は枠を握ったままで、観測のあとで解放される", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const task = queueWork(t, "leaves a child behind");
  const next = queueWork(t, "next in line");
  t.containers.hold(task.id);
  await t.clock.advance(HOUR);

  t.worker.exitWith(task.id, { exit_code: 1, signal: null, stderr_tail: null });
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

  t.worker.exitWith(task.id, { exit_code: 0, signal: null, stderr_tail: null });
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

  t.worker.exitWith(task.id, { exit_code: null, signal: "SIGTERM", stderr_tail: null });
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

  t.worker.exitWith(task.id, { exit_code: 0, signal: null, stderr_tail: null });
  await settle();

  expect(await exitedWithoutReport()).toHaveLength(1);
});

it("retry の回答で task は queue 先頭へ戻り、abandon の回答で cancel される", async () => {
  t = await bootTidepool({ watchdog: WATCHDOG });
  const retried = queueWork(t, "retried");
  const abandoned = queueWork(t, "abandoned");
  const busy = queueWork(t, "busy");
  await t.clock.advance(HOUR);
  t.worker.exitWith(retried.id, { exit_code: 0, signal: null, stderr_tail: null });
  await settle();
  t.worker.exitWith(abandoned.id, { exit_code: 0, signal: null, stderr_tail: null });
  await settle();
  expect(started()).toEqual([retried.id, abandoned.id, busy.id]);
  // retry の回答より前に先頭へ置いた task —— 先頭復帰なら retried がこれを追い越す
  const later = moveTask(t.db, queueWork(t, "later"), null, t.clock.now());

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

const tempDir = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

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
    workerAdapter: (deps) => {
      const worker = build(deps);
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

async function bootClaude() {
  const registryDir = await makeRegistry();
  dirs.push(registryDir);
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
  dirs.push(registryDir);
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
