import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeWorker, type SpawnFn } from "../src/claude-worker.js";
import { startServer, type TidepoolServer } from "../src/server.js";
import type { WorkerAdapter } from "../src/worker.js";
import { FakeClock, healthyUsageText } from "./fakes.js";
import { api, HOUR, makeWorkspace, TEST_CREDENTIAL } from "./harness.js";
import { makeRegistry } from "./registry-fixture.js";

const dirs: string[] = [];
let server: TidepoolServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const spawn: SpawnFn = () => {
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
    worker: ({ db }): WorkerAdapter => {
      const worker = new ClaudeCodeWorker({
        db,
        clock,
        registry: { dir: registryDir, mode: "purely-local" },
        agent: "tako",
        auditorName: "fugu",
        workspace: "tidepool",
        mcpUrl: "http://127.0.0.1:1/mcp",
        logDir,
        spawn,
      });
      return {
        id: worker.id,
        start: (task) => worker.start(task),
        kill: (taskId, signal) => worker.kill(taskId, signal),
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
