import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { loadRegistry, refreshRegistry } from "../src/registry.js";
import { HOURLY, startScheduler } from "../src/scheduler.js";
import { Slot } from "../src/slot.js";
import { listBoard, registerTask, type Task } from "../src/tasks.js";
import type { KillSignal, WorkerAdapter } from "../src/worker.js";
import { FakeClock, healthyUsageText, ScriptedWorker } from "./fakes.js";
import { makeRegistry } from "./registry-fixture.js";

async function remoteRegistryWithUnfetchedMerge(): Promise<string> {
  const registryDir = await makeRegistry();
  const remote = await mkdtemp(join(tmpdir(), "tidepool-registry-remote-"));
  const publisher = await mkdtemp(join(tmpdir(), "tidepool-registry-publisher-"));
  execFileSync("git", ["init", "--bare", "-b", "main"], { cwd: remote });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: registryDir });
  execFileSync("git", ["push", "-u", "origin", "main"], { cwd: registryDir });
  execFileSync("git", ["clone", remote, publisher]);
  await writeFile(
    join(publisher, "agents", "deckhand.md"),
    `---\nname: deckhand\ndescription: Definition merged on remote\nversion: 0.4.0\nauthority: standard\nskills:\n  - "*"\n---\nRemote definition.\n`,
  );
  execFileSync("git", ["add", "agents/deckhand.md"], { cwd: publisher });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "merged registry change",
    ],
    { cwd: publisher },
  );
  execFileSync("git", ["push", "origin", "main"], { cwd: publisher });
  return registryDir;
}

it("次の pickup は registry を refresh してから remote main の定義で spawn する(ADR 0052)", async () => {
  const registryDir = await remoteRegistryWithUnfetchedMerge();
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const spawnedVersions: string[] = [];
  const worker: WorkerAdapter = {
    id: "deckhand",
    start(_task: Task) {
      spawnedVersions.push(loadRegistry(registryDir, "remote-backed").agents.deckhand!.version);
    },
    kill(_taskId: string, _signal: KillSignal) {},
    async checkUsage() {
      return healthyUsageText(clock.now());
    },
  };
  const scheduler = startScheduler({
    db,
    clock,
    slot: new Slot(),
    worker,
    registryReachability: () => refreshRegistry(registryDir),
  });
  registerTask(
    db,
    {
      type: "work",
      title: "use the merged registry definition",
      purpose: "prove the pickup refreshes the registry cache",
      completion_criteria: "the spawned worker observes version 0.4.0",
    },
    clock.now(),
  );

  await clock.advance(HOURLY);

  expect(spawnedVersions).toEqual(["0.4.0"]);
  scheduler.stop();
});

it("registry に到達できない間は盤面全体の pickup を止め、確認 question を1枚だけ立てる(ADR 0052)", async () => {
  const db = openDb(":memory:");
  const clock = new FakeClock();
  const worker = new ScriptedWorker(clock);
  const scheduler = startScheduler({
    db,
    clock,
    slot: new Slot(),
    worker,
    registryReachability: async () => ({
      available: false,
      reason: "origin is unreachable",
    }),
  });
  registerTask(
    db,
    {
      type: "work",
      title: "first queued task",
      purpose: "must wait for the registry source of truth",
      completion_criteria: "runs after repair",
    },
    clock.now(),
  );
  registerTask(
    db,
    {
      type: "work",
      title: "second queued task",
      purpose: "proves the stop is board-wide",
      completion_criteria: "runs after repair",
    },
    clock.now(),
  );

  await clock.advance(HOURLY * 3);

  const questions = listBoard(db).filter((task) => task.type === "question");
  expect({ started: worker.started, questionTitles: questions.map((task) => task.title) }).toEqual({
    started: [],
    questionTitles: ["registry remote is unreachable — pickup is stopped"],
  });
  scheduler.stop();
});
