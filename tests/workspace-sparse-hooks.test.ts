import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import {
  excludeWorkspaceProjectHooks,
  prepareWorkspaceAtPickup,
  releaseWorkspace,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import { commitWork, git, makeWorkspace } from "./harness.js";

const dirs: string[] = [];
let db: Db | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

it("hooks settings は worker 中だけ sparse にし、親子の WIP に混ぜず human side へ戻す", async () => {
  const workspace = await makeWorkspace(dirs, "sparse-hooks");
  await mkdir(join(workspace.path, ".claude"), { recursive: true });
  const settings = JSON.stringify({ hooks: { PostToolUse: [] } });
  await writeFile(join(workspace.path, ".claude", "settings.json"), settings);
  git(workspace.path, "add", ".claude/settings.json");
  git(workspace.path, "commit", "-m", "share project hooks");
  db = openDb(":memory:");
  const now = new Date("2026-09-04T00:00:00.000Z");
  const parent = registerTask(
    db,
    {
      type: "work",
      title: "parent work",
      purpose: "provide a child fork source",
      completion_criteria: "parent work is committed",
    },
    now,
  );

  await prepareWorkspaceAtPickup(db, workspace, parent, {});
  excludeWorkspaceProjectHooks(workspace);
  commitWork(workspace.path, "parent.txt", "parent work\n");
  releaseWorkspace(db, workspace, parent, now);
  expect(readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toBe(settings);

  const child = registerTask(
    db,
    {
      type: "work",
      parent_id: parent.id,
      title: "child work",
      purpose: "continue from the parent",
      completion_criteria: "child WIP is preserved",
    },
    now,
  );
  await prepareWorkspaceAtPickup(db, workspace, child, {});
  excludeWorkspaceProjectHooks(workspace);
  expect(readFileSync(join(workspace.path, "parent.txt"), "utf8")).toBe("parent work\n");
  writeFileSync(join(workspace.path, "child.txt"), "child work\n");
  releaseWorkspace(db, workspace, child, now);

  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(workspaceNeedsHuman(db, workspace.name)).toBe(false);
  expect(git(workspace.path, "diff", "--name-only", `task/${parent.id}..task/${child.id}`)).toBe(
    "child.txt",
  );
  expect(git(workspace.path, "show", `task/${child.id}:.claude/settings.json`)).toBe(settings);
  expect(readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toBe(settings);
});
