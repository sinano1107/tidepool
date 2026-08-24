import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeWorker } from "../src/claude-worker.js";
import { openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { startServer, type TidepoolServer } from "../src/server.js";
import { Slot } from "../src/slot.js";
import { DEFAULT_AUDITOR_NAME, registerTask } from "../src/tasks.js";
import type { WorkerAdapter } from "../src/worker.js";
import type { ContainerSpawn } from "../src/worker-container.js";
import {
  FakeClock,
  FakeContainerRuntime,
  fakeContainers,
  healthyUsageText,
  ScriptedWorker,
} from "./fakes.js";
import { api, HOUR, makeWorkspace, TEST_CREDENTIAL } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

const dirs: string[] = [];
let server: TidepoolServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const spawn: ContainerSpawn = () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  return {
    stdout,
    stderr,
    kill() {},
    on() {},
  };
};

it("assignee 未指定の review を pickup すると、pickup と spawn の両イベントが Auditor に帰属する(issue #223)", async () => {
  const workspace = await makeWorkspace(dirs, "review-pickup-attribution");
  const registryDir = await makeRegistry({
    "agents/tako.md": `---
name: tako
description: Default agent
version: 1.0.0
authority: standard
provider: anthropic
skills:
  - "*"
---
You are Tako.
`,
    "agents/fugu.md": `---
name: fugu
description: Independent auditor
version: 1.0.0
authority: standard
provider: anthropic
skills:
  - "*"
---
You are Fugu.
`,
    "workspaces.yaml": `tidepool:\n  path: ${workspace.path}\n`,
  });
  dirs.push(registryDir);
  const boardDir = await mkdtemp(join(tmpdir(), "tidepool-review-attribution-"));
  const logDir = await mkdtemp(join(tmpdir(), "tidepool-worker-logs-"));
  dirs.push(boardDir, logDir);
  const clock = new FakeClock();

  server = await startServer({
    dbPath: join(boardDir, "board.sqlite"),
    port: 0,
    mcpPort: 0,
    credential: TEST_CREDENTIAL,
    clock,
    auditorName: "fugu",
    containerRuntime: new FakeContainerRuntime(spawn),
    worker: ({ db, containers }): WorkerAdapter => {
      const worker = new ClaudeCodeWorker({
        db,
        clock,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "tako",
        auditorName: "fugu",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:1/mcp",
        logDir,
        containers,
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
  const review = (
    await api(baseUrl, "POST", "/api/tasks", {
      type: "review",
      title: "independent review",
      purpose: "audit independently",
      completion_criteria: "record findings",
    })
  ).json;

  await clock.advance(HOUR);

  const events = (await api(baseUrl, "GET", `/api/tasks/${review.id}/events`)).json;
  expect(
    events
      .filter((event: any) => ["task_picked_up", "worker_spawned"].includes(event.kind))
      .map((event: any) => ({ kind: event.kind, worker_id: event.worker_id })),
  ).toEqual([
    { kind: "task_picked_up", worker_id: "fugu" },
    { kind: "worker_spawned", worker_id: "fugu" },
  ]);
});

it("startScheduler を直接構築しても、省略された Auditor は既定ポインタへ解決される(issue #223)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const scheduler = startScheduler({ db, clock, slot: new Slot(), worker, containers: fakeContainers() });
  const review = registerTask(
    db,
    {
      type: "review",
      title: "review with the implicit Auditor",
      purpose: "preserve attribution outside the server composition root",
      completion_criteria: "pickup is attributed to the default Auditor pointer",
    },
    clock.now(),
  );

  await clock.advance(HOURLY);

  const pickedUp = listEvents(db, review.id).find((event) => event.kind === "task_picked_up");
  scheduler.stop();
  db.close();
  expect(pickedUp?.worker_id).toBe(DEFAULT_AUDITOR_NAME);
});
