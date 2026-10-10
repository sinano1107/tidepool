import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { getTask, pickupTask, registerTask } from "../src/tasks.js";
import { failTask } from "../src/watchdog.js";
import { ensureTaskBranch, workspaceNeedsHuman } from "../src/workspace.js";
import { FakeClock } from "./fakes.js";
import { defaultingTo, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace } from "./harness.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

describe("watchdog の failTask が task.workspace を解決する", () => {
  it("失敗した task 自身の workspace の checkout で tree rule を実行する", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const db = openDb(":memory:");
    const clock = new FakeClock();

    const task = registerTask(
      db,
      { type: "work", title: "prod work", purpose: "p", completion_criteria: "c", workspace: "prod" },
      clock.now(),
      ...HUMAN_WEBUI,
    );
    const picked = pickupTask(db, task, "deckhand", clock.now())!;
    ensureTaskBranch(db, prod, picked);
    await import("node:fs").then((fs) =>
      fs.writeFileSync(join(prod.path, "stuck.txt"), "stuck work\n"),
    );
    await import("node:fs").then((fs) => fs.writeFileSync(join(prod.path, ".bashrc"), ""));

    failTask(
      db,
      getTask(db, task.id)!,
      "watchdog killed task",
      "hit its time limit",
      defaultingTo(sandbox, prod),
      clock.now(),
    );

    expect(git(prod.path, "status", "--porcelain")).toBe("");
    expect(git(prod.path, "log", "--format=%s", `task/${task.id}`)).toContain(
      `WIP: task ${task.id}`,
    );
    expect(
      git(prod.path, "ls-tree", "-r", "--name-only", `task/${task.id}`).split("\n"),
    ).not.toContain(".bashrc");
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  });

  // ADR 0233: 既定への参照は pickup で終わる —— 再起動の中断処理もこの経路を通る
  it("workspace 未指定で既定 prod に pickup したタスクは、既定を sandbox に差し替えた resolver でも prod の checkout で後始末し、sandbox を quarantine に落とさない", async () => {
    const sandbox = await makeWorkspace("sandbox");
    const prod = await makeWorkspace("prod");
    const db = openDb(":memory:");
    const clock = new FakeClock();

    const task = registerTask(
      db,
      { type: "work", title: "default work", purpose: "p", completion_criteria: "c" },
      clock.now(),
      ...HUMAN_WEBUI,
    );
    const picked = pickupTask(db, task, "deckhand", clock.now(), { workspace: "prod" })!;
    ensureTaskBranch(db, prod, picked);
    writeFileSync(join(prod.path, "stuck.txt"), "interrupted mid-write\n");

    failTask(
      db,
      getTask(db, task.id)!,
      "interrupted by restart",
      "the board restarted",
      defaultingTo(sandbox, prod),
      clock.now(),
    );

    expect(git(prod.path, "status", "--porcelain")).toBe("");
    expect(git(prod.path, "log", "--format=%s", `task/${task.id}`)).toContain(`WIP: task ${task.id}`);
    expect(git(sandbox.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(workspaceNeedsHuman(db, "sandbox")).toBe(false);
  });
});
