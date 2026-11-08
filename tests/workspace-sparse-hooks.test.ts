import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, getTask, registerTask } from "../src/tasks.js";
import { completionTreePaths, excludeWorkspaceProjectSettings, releaseWorkspace, workspaceNeedsHuman } from "../src/workspace.js";
import {
  bootClaudeOn,
  checkoutOf,
  claudeSpawnOf,
  commitWork,
  FULL_HANDOFF,
  GIT_FIXTURE_TEST_TIMEOUT,
  git,
  HOUR,
  HUMAN_WEBUI,
  makeWorkspace,
  prepareAtPickup,
  questions,
  queueWork,
  servedQuarantineQuestion,
  type Tidepool,
} from "./harness.js";
import { tempDir } from "./temp-dir.js";

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let db: Db | undefined;
let t: Tidepool | undefined;

afterEach(async () => {
  db?.close();
  db = undefined;
  await t?.stop();
  t = undefined;
});

it("完了の門は sparse settings の意図した欠落と、index で隠した tracked な変更を区別する(ADR 0293 / ADR 0356 決定3)", async () => {
  const workspace = await makeWorkspace("sparse-completion");
  db = openDb(":memory:");
  await mkdir(join(workspace.path, ".claude"));
  commitWork(workspace.path, ".claude/settings.json", "{}\n");
  const now = new Date(0);
  const task = registerTask(db, { type: "work", title: "work", purpose: "why", completion_criteria: "done" }, now, ...HUMAN_WEBUI);
  // ADR 0356 決定2: settings.json を隠すのは名前の場所でなく、盤面が作った task の checkout の sparse-checkout
  const place = await prepareAtPickup(db, workspace, task);
  excludeWorkspaceProjectSettings(place, task.id, [".claude/settings.json"]);

  expect(git(place.path, "sparse-checkout", "list").split("\n")).toEqual(["/*", "!/.claude/settings.json"]);
  expect(completionTreePaths(place, task.id)).toEqual([]);
  expect(existsSync(join(place.path, ".claude/settings.json"))).toBe(false);
  git(place.path, "update-index", "--skip-worktree", "--", "README.md");
  writeFileSync(join(place.path, "README.md"), "changed\n");
  expect(completionTreePaths(place, task.id)).toEqual(["README.md"]);

  git(place.path, "update-index", "--no-skip-worktree", "--", "README.md");
  git(place.path, "checkout", "HEAD", "--", "README.md");
  writeFileSync(join(place.path, "unfinished.txt"), "unrelated work in progress\n");
  releaseWorkspace(db, place, task, now);
  expect(workspaceNeedsHuman(db, workspace.name)).toBe(false);
  expect(git(workspace.path, "log", "-1", "--format=%s", `task/${task.id}`)).toContain(`WIP: task ${task.id}`);
  expect(git(workspace.path, "show", `task/${task.id}:unfinished.txt`)).toBe("unrelated work in progress");
  expect(git(workspace.path, "show", `task/${task.id}:.claude/settings.json`)).toBe("{}");
  expect(readFileSync(join(workspace.path, ".claude/settings.json"), "utf8")).toBe("{}\n");
});

it("a worker cannot hide a tracked deletion by changing sparse rules after pickup (ADR 0356 決定3)", async () => {
  const workspace = await makeWorkspace("sparse-policy-pin");
  const dbPath = join(await tempDir("sparse-policy-db-"), "board.sqlite");
  db = openDb(dbPath);
  const now = new Date(0);
  commitWork(workspace.path, "human-omitted.txt", "human sparse policy\n");
  git(workspace.path, "sparse-checkout", "set", "--no-cone", "/*", "!/human-omitted.txt");
  const task = registerTask(db, { type: "work", title: "work", purpose: "why", completion_criteria: "done" }, now, ...HUMAN_WEBUI);
  const place = await prepareAtPickup(db, workspace, task);
  expect(existsSync(join(workspace.path, "human-omitted.txt"))).toBe(false);
  expect(completionTreePaths(place, task.id)).toEqual([]);
  completeTask(db, task, FULL_HANDOFF, "worker", now, "worker");

  // ADR 0356 決定3: worker が task の checkout に書いた sparse(盤面の行を真似ても)は view に効かない
  git(place.path, "sparse-checkout", "set", "--no-cone", "/*", "!/.claude/settings.json", "!/README.md");
  expect(git(place.path, "status", "--porcelain")).toBe("");
  expect(completionTreePaths(place, task.id)).toEqual(["README.md"]);

  db.close();
  db = openDb(dbPath);
  releaseWorkspace(db, place, getTask(db, task.id)!, now, false, undefined, undefined, true);
  expect(listEvents(db, task.id).map(({ payload }) => payload).filter(({ kind }) => kind === "task_checkout_written_after_completion")).toEqual([
    { kind: "task_checkout_written_after_completion", path: place.path, observation: "uncommitted", paths: ["README.md"] },
  ]);
  expect(workspaceNeedsHuman(db, workspace.name)).toBe(false);
  expect(existsSync(place.path)).toBe(false);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

// 旧: 名前の場所で隠した settings を slot 解放中も sparse のまま保ち、worker 回収後に写しから戻した(ADR 0293)
it("hooks settings は task の checkout でだけ隠れ、親子の WIP に混ざらず、名前の場所の settings は触られない(ADR 0356 決定2)", async () => {
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
    ...HUMAN_WEBUI,
  );

  const parentPlace = await prepareAtPickup(db, workspace, parent);
  excludeWorkspaceProjectSettings(parentPlace, parent.id, [".claude/settings.json"]);
  expect(existsSync(join(parentPlace.path, ".claude", "settings.json"))).toBe(false);
  commitWork(parentPlace.path, "parent.txt", "parent work\n");
  releaseWorkspace(db, parentPlace, parent, now);
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
    ...HUMAN_WEBUI,
  );
  const childPlace = await prepareAtPickup(db, workspace, child);
  excludeWorkspaceProjectSettings(childPlace, child.id, [".claude/settings.json"]);
  expect(readFileSync(join(childPlace.path, "parent.txt"), "utf8")).toBe("parent work\n");
  writeFileSync(join(childPlace.path, "child.txt"), "child work\n");
  releaseWorkspace(db, childPlace, child, now);

  expect(git(workspace.path, "status", "--porcelain")).toBe("");
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  expect(workspaceNeedsHuman(db, workspace.name)).toBe(false);
  expect(git(workspace.path, "diff", "--name-only", `task/${parent.id}..task/${child.id}`)).toBe(
    "child.txt",
  );
  expect(git(workspace.path, "show", `task/${child.id}:.claude/settings.json`)).toBe(settings);
  expect(readFileSync(join(workspace.path, ".claude", "settings.json"), "utf8")).toBe(settings);
});

it("tracked な settings.local.json を持つ task branch の worker は止まらずに走り、session 中の task の checkout には両 settings が無く、解放後の task branch の tree には残る(ADR 0360 決定1)", async () => {
  const workspace = await makeWorkspace("sparse-local-settings");
  await mkdir(join(workspace.path, ".claude"));
  await writeFile(join(workspace.path, ".claude", "settings.json"), "{}\n");
  await writeFile(join(workspace.path, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash(*)"]}}\n');
  git(workspace.path, "add", "-f", ".claude");
  git(workspace.path, "commit", "-m", "share both settings");
  const booted = await bootClaudeOn(workspace);
  t = booted.t;
  const task = queueWork(t, "work beside local settings", workspace.name);

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(claudeSpawnOf(booted.proc, task.id)).toBeDefined());
  const checkout = checkoutOf(t.db, task.id);
  expect(existsSync(join(checkout, ".claude", "settings.json"))).toBe(false);
  expect(existsSync(join(checkout, ".claude", "settings.local.json"))).toBe(false);
  expect(await questions(t)).toEqual([]);

  booted.proc.emitExit(0, null);
  await vi.waitFor(() => expect(existsSync(checkout)).toBe(false));
  expect(git(workspace.path, "show", `task/${task.id}:.claude/settings.json`)).toBe("{}");
  expect(git(workspace.path, "show", `task/${task.id}:.claude/settings.local.json`)).toBe('{"permissions":{"allow":["Bash(*)"]}}');
});

it("隠すものが無い spawn でも guard は走る: 隠しが効かなかった task の checkout(settings の path に dangling な link)は workspace の quarantine に落ちて spawn しない(ADR 0360 決定2)", async () => {
  const workspace = await makeWorkspace("sparse-guard");
  const booted = await bootClaudeOn(workspace, {
    beforeStart: (db, taskId) => {
      const checkout = checkoutOf(db, taskId);
      mkdirSync(join(checkout, ".claude"));
      symlinkSync("../nowhere.json", join(checkout, ".claude", "settings.local.json"));
    },
  });
  t = booted.t;
  const task = queueWork(t, "work in a mis-realised checkout", workspace.name);

  await t.clock.advance(HOUR);
  const stop = await vi.waitFor(async () => {
    const question = await servedQuarantineQuestion(t!, "workspace", workspace.name);
    expect(question).toBeDefined();
    return question;
  });
  expect(stop.purpose).toContain("could not exclude .claude/settings.local.json");
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`)).toBeUndefined();
  expect(claudeSpawnOf(booted.proc, task.id)).toBeUndefined();
});
