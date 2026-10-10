import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { startServer, type TidepoolServer } from "../src/server.js";
import { implicitTaskExecutionCandidates } from "../src/server-options.js";
import { pickupTask, registerTask } from "../src/tasks.js";
import { TranscriptStore } from "../src/transcript-store.js";
import { ensureTaskBranch, UnknownWorkspaceError, type WorkspaceConfig } from "../src/workspace.js";
import { FakeClock, FakeContainerRuntime, pinnedCliVersions, ScriptedWorker } from "./fakes.js";
import { api, bootTidepool, defaultingTo, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace, registerWork, TEST_CREDENTIAL, type Tidepool } from "./harness.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let server: TidepoolServer | undefined;
let t: Tidepool | undefined;
afterEach(async () => {
  await server?.stop();
  server = undefined;
  await t?.stop();
  t = undefined;
});

// ADR 0233: 既定への参照は pickup で終わる —— retry の再 pickup も最初の pickup で解決した先に従う
it("既定 workspace a・既定 agent a-agent で pickup したタスクは、既定を b・b-agent に差し替えて再起動した盤面でも、retry で a・a-agent のまま再 pickup され、a の既存のタスクブランチを checkout する", async () => {
  const a = await makeWorkspace("retry-pinned-a");
  const b = await makeWorkspace("retry-pinned-b");
  t = await bootTidepool({ workspace: a, resolveWorkspace: defaultingTo(a, b), workerId: "a-agent" });
  const task = await registerWork(t, "unspecified work");
  writeFileSync(join(a.path, "stuck.txt"), "interrupted mid-write\n");
  await t.stopServer();

  t = await bootTidepool({ dir: t.dir, workspace: b, resolveWorkspace: defaultingTo(b, a), workerId: "b-agent" });
  const failure = (await api(t.baseUrl, "GET", "/api/tasks")).json.find(
    (x: any) => x.type === "question" && x.parent_id === task.id,
  );
  await api(t.baseUrl, "POST", `/api/tasks/${failure.id}/answer`, { answers: ["retry"] });

  expect(t.worker.started.map(({ id, workspace, assignee }) => ({ id, workspace, assignee }))).toEqual([
    { id: task.id, workspace: a.name, assignee: "a-agent" },
  ]);
  expect(git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${task.id}`);
  expect(git(a.path, "log", "--format=%s", "HEAD")).toContain(`WIP: task ${task.id}`);
  expect(git(b.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(git(b.path, "branch", "--list", `task/${task.id}`)).toBe("");
});

describe("restart 割り込みの failTask が task.workspace を解決する", () => {
  it("再起動時に in_progress のまま残ったタスクは、自身の workspace の checkout で tree rule を実行する", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const registry: Record<string, WorkspaceConfig> = { sandbox, prod };
    const boardDir = await tempDir("tidepool-board-");
    const dbPath = join(boardDir, "board.sqlite");

    // simulate a restart-interrupted task: in_progress, its task branch
    // already checked out on prod, uncommitted work left mid-flight
    const seedDb = openDb(dbPath);
    const clock0 = new FakeClock();
    const task = registerTask(
      seedDb,
      { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock0.now(),
      ...HUMAN_WEBUI,
    );
    const picked = pickupTask(seedDb, task, "deckhand", clock0.now())!;
    ensureTaskBranch(seedDb, prod, picked);
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(prod.path, "stuck.txt"), "interrupted mid-write\n"),
    );
    seedDb.close();

    const bootClock = new FakeClock();
    const db = openDb(dbPath);
    server = await startServer({
      db,
      taskExecutionCandidates: implicitTaskExecutionCandidates(db),
      port: 0,
      mcpPort: 0,
      clock: bootClock,
      // issue #153: 人間面の credential は省略できない(このテストは HTTP を
      // 叩かないが、盤面が無認証で立つ口は塞いである)
      credential: TEST_CREDENTIAL,
      worker: () => new ScriptedWorker(bootClock),
      containerRuntime: new FakeContainerRuntime(),
      transcripts: new TranscriptStore(boardDir),
      checkHarnessCliVersion: pinnedCliVersions,
      workspace: sandbox,
      resolveWorkspace: (name) => {
        const ws = registry[name ?? "sandbox"];
        if (!ws) throw new UnknownWorkspaceError(name ?? "sandbox");
        return ws;
      },
    });

    expect(git(prod.path, "status", "--porcelain")).toBe("");
    expect(git(prod.path, "log", "--format=%s", `task/${task.id}`)).toContain(
      `WIP: task ${task.id}`,
    );
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });
});
