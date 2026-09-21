import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import type { ContainerSpawn } from "../src/process-container.js";
import { startServer, type TidepoolServer } from "../src/server.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import type { WorkerAdapter } from "../src/worker.js";
import { FakeClock, FakeContainerRuntime, healthyUsageText } from "./fakes.js";
import {
  api,
  bootTidepool,
  HOUR,
  makeWorkspace,
  managementMcpClient,
  mcpClient,
  queueWork,
  registerWork,
  TEST_CREDENTIAL,
  type Tidepool,
} from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

/** ADR 0107 決定1 の盤面境界 —— 4つの入口が要求2列を**受け取る**ことと、不正値が
 *  その入口の失敗の綴り(400 / toolError)になることだけを言う。「どの値が正しいか」
 *  はドメイン層が1度だけ言う(決定3)ので、入口ごとに enum を書き直さない。 */

let t: Tidepool;
afterEach(() => t?.stop());

it("人間の Register(JSON API)は要求2列を受け取る", async () => {
  t = await bootTidepool();
  const res = await api(t.baseUrl, "POST", "/api/tasks", {
    type: "work",
    title: "wire the sensor",
    purpose: "readings",
    completion_criteria: "a live number",
    tier: "frontier",
    priority: "cost",
  });
  expect(res.status).toBe(201);
  expect(res.json).toMatchObject({ tier: "frontier", priority: "cost" });
});

it("JSON API の不正な要求は 400 —— ドメインの拒否が人間面の失敗に写る(退役した speed も不正値)", async () => {
  t = await bootTidepool();
  const register = async (request: Record<string, string>) =>
    (await api(t.baseUrl, "POST", "/api/tasks", { type: "work", title: "t", purpose: "p", completion_criteria: "c", ...request })).status;
  expect(await register({ tier: "platinum" })).toBe(400);
  expect(await register({ priority: "speed" })).toBe(400);
});

it("編集面は要求2列を受け取らない(#543 の範囲外 —— 未知キーは 400)", async () => {
  t = await bootTidepool();
  const task = await registerWork(t, "editable");
  expect((await api(t.baseUrl, "PATCH", `/api/tasks/${task.id}`, { tier: "frontier" })).status).toBe(400);
});

it("管理MCP の register_task は要求2列を受け取り、不正値は toolError になる", async () => {
  t = await bootTidepool();
  const client = await managementMcpClient(t.baseUrl);
  const ok: any = await client.callTool({
    name: "register_task",
    arguments: {
      type: "work",
      title: "triaged work",
      purpose: "p",
      completion_criteria: "c",
      tier: "standard",
      priority: "cost",
      review_by: ["security"],
      review_tier: "frontier",
    },
  });
  expect(ok.isError ?? false).toBe(false);

  const bad: any = await client.callTool({
    name: "register_task",
    arguments: { type: "work", title: "t", purpose: "p", completion_criteria: "c", priority: "speed" },
  });
  expect(bad.isError).toBe(true);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "triaged work")).toMatchObject({
    tier: "standard",
    priority: "cost",
    review_by: ["security"],
    review_tier: "frontier",
  });
});

it("decompose の ChildSpec は要求2列を受け取り、不正値は toolError になる", async () => {
  t = await bootTidepool();
  const parent = await registerWork(t, "parent");
  await t.clock.advance(HOUR); // parent picked up into the slot
  const client = await mcpClient(t.mcpBaseUrl, parent.id);
  const ok: any = await client.callTool({
    name: "decompose",
    arguments: {
      reason: "the hard half deserves a stronger model",
      children: [
        {
          title: "the hard half",
          purpose: "p",
          completion_criteria: "c",
          tier: "frontier",
          priority: "cost",
        },
      ],
    },
  });
  expect(ok.isError ?? false).toBe(false);

  for (const child of [{ tier: "platinum" }, { priority: "speed" }]) {
    const bad: any = await client.callTool({
      name: "decompose",
      arguments: {
        reason: "another split",
        children: [{ title: "x", purpose: "p", completion_criteria: "c", ...child }],
      },
    });
    expect(bad.isError).toBe(true);
  }
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "the hard half")).toMatchObject({
    tier: "frontier",
    priority: "cost",
  });
  expect(board.find((x: any) => x.title === "x")).toBeUndefined();
});

it("管理MCP の decompose_task は要求2列を受け取り、不正値は toolError になる(issue #659)", async () => {
  t = await bootTidepool();
  const parent = queueWork(t, "modernize tide data");
  const client = await managementMcpClient(t.baseUrl);
  // 不正値を先に —— 成功した分解は parent を blocked にするので、後続の拒否が
  // ティアではなく parent の状態で起きてしまう。
  const bad: any = await client.callTool({
    name: "decompose_task",
    arguments: {
      task_id: parent.id,
      reason: "a split with an unknown tier",
      children: [{ title: "x", purpose: "p", completion_criteria: "c", tier: "platinum" }],
    },
  });
  expect(bad.isError).toBe(true);

  const ok: any = await client.callTool({
    name: "decompose_task",
    arguments: {
      task_id: parent.id,
      reason: "the hard half deserves a stronger model",
      children: [
        {
          title: "the hard half",
          purpose: "p",
          completion_criteria: "c",
          tier: "frontier",
          priority: "cost",
        },
      ],
    },
  });
  expect(ok.isError ?? false).toBe(false);
  await client.close();

  const board = (await api(t.baseUrl, "GET", "/api/tasks")).json;
  expect(board.find((x: any) => x.title === "the hard half")).toMatchObject({
    tier: "frontier",
    priority: "cost",
  });
});

/* ------------------------------------------------------------------ *
 * 要求のある task が実際にその設定で spawn され、出所が刻まれること。
 * ScriptedWorker は spawn しないので、この1本だけ実 adapter を挿した盤面を建てる
 * (先例: tests/review-pickup-attribution.test.ts)。
 * ------------------------------------------------------------------ */

const dirs: string[] = [];
let server: TidepoolServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const spawn: ContainerSpawn = () => ({
  stdout: new PassThrough(),
  stderr: new PassThrough(),
  kill() {},
  on() {},
});

it("要求のある task はその要求のモデルで spawn され、worker_spawned の出所は task(ADR 0110 決定3)", async () => {
  const workspace = await makeWorkspace(dirs, "task-execution-request");
  const registryDir = await makeRegistry({
    "agents/tako.md": `---
name: tako
description: Default agent
version: 1.0.0
authority: standard
provider: anthropic
tier: economy
skills:
  - "*"
---
You are Tako.
`,
    "workspaces.yaml": `tidepool:\n  path: ${workspace.path}\n`,
  });
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-task-request-"));
  const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
  dirs.push(registryDir, boardDir, logDir);
  const clock = new FakeClock();

  const boardDb = openDb(join(boardDir, "board.sqlite"));
  server = await startServer({
    db: boardDb,
    taskExecutionCandidates: implicitTaskExecutionCandidates(boardDb),
    port: 0,
    mcpPort: 0,
    credential: TEST_CREDENTIAL,
    clock,
    containerRuntime: new FakeContainerRuntime(spawn),
    worker: ({ db, containers, boardCall }): WorkerAdapter => {
      const worker = new ClaudeCodeWorker({
        db,
        clock,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "tako",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:1/mcp",
        logDir,
        containers,
        boardCall,
      });
      return {
        id: worker.id,
        start: (task) => worker.start(task),
        gracefulStop: (taskId) => worker.gracefulStop(taskId),
        checkUsage: async () => healthyUsageText(clock.now()),
      };
    },
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  const task = (
    await api(baseUrl, "POST", "/api/tasks", {
      type: "work",
      title: "the hard one",
      purpose: "p",
      completion_criteria: "c",
      tier: "frontier",
    })
  ).json;
  await clock.advance(HOUR);

  const events = (await api(baseUrl, "GET", `/api/tasks/${task.id}/events`)).json;
  // agent は economy を宣言しているが、task の要求が勝つ
  expect(events.find((e: any) => e.kind === "worker_spawned").payload).toMatchObject({
    model: "fable",
    source: { tier: "task", provider: "only" },
  });
});
