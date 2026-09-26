import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import {
  excludeWorkspaceProjectHooks,
  materializeWorkspaceProjectSettings,
  prepareWorkspaceAtPickup,
  releaseWorkspace,
  workspaceNeedsHuman,
} from "../src/workspace.js";
import { FakeContainerRuntime } from "./fakes.js";
import { bootTidepool, commitWork, git, makeWorkspace, type Tidepool } from "./harness.js";

let db: Db | undefined;
let tidepool: Tidepool | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  await tidepool?.stop();
  tidepool = undefined;
});

it("hooks settings は slot 解放中も sparse のまま親子の WIP に混ぜず、worker 回収後に戻せる", async () => {
  const workspace = await makeWorkspace("sparse-hooks");
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
  expect(() => readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toThrow();

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
  expect(() => readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toThrow();
  materializeWorkspaceProjectSettings(workspace);
  expect(readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toBe(settings);
});

it("再起動は前 process が残した sparse settings を human side へ戻す", async () => {
  const workspace = await makeWorkspace("sparse-hooks-restart");
  await mkdir(join(workspace.path, ".claude"), { recursive: true });
  const settings = JSON.stringify({ hooks: { PostToolUse: [] } });
  await writeFile(join(workspace.path, ".claude", "settings.json"), settings);
  git(workspace.path, "add", ".claude/settings.json");
  git(workspace.path, "commit", "-m", "share project hooks");
  excludeWorkspaceProjectHooks(workspace);

  tidepool = await bootTidepool({
    workspace,
    boardState: { paths: [], listWorkspaces: () => [workspace] },
  });

  expect(readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toBe(settings);
});

it("再起動時に前 worker の不在を証明できなければ sparse settings を戻さない", async () => {
  const workspace = await makeWorkspace("sparse-hooks-restart-unsafe");
  await mkdir(join(workspace.path, ".claude"), { recursive: true });
  await writeFile(
    join(workspace.path, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PostToolUse: [] } }),
  );
  git(workspace.path, "add", ".claude/settings.json");
  git(workspace.path, "commit", "-m", "share project hooks");
  excludeWorkspaceProjectHooks(workspace);
  const containers = new FakeContainerRuntime();
  containers.scriptPreflight("a container from a previous run is still populated");

  tidepool = await bootTidepool({
    workspace,
    containerRuntime: containers,
    boardState: { paths: [], listWorkspaces: () => [workspace] },
  });

  expect(() => readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toThrow();
});
