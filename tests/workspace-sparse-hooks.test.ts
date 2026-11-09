import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { registerTask } from "../src/tasks.js";
import { completionTreePaths, excludeWorkspaceProjectSettings, releaseWorkspace, workspaceNeedsHuman } from "../src/workspace.js";
import {
  api,
  bootClaudeOn,
  callAsTask,
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

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

let db: Db | undefined;
let t: Tidepool | undefined;

async function shareBothSettings(path: string): Promise<void> {
  await mkdir(join(path, ".claude"));
  await writeFile(join(path, ".claude", "settings.json"), "{}\n");
  await writeFile(join(path, ".claude", "settings.local.json"), "{}\n");
  git(path, "add", "-f", ".claude");
  git(path, "commit", "-m", "share both settings");
}

afterEach(async () => {
  db?.close();
  db = undefined;
  await t?.stop();
  t = undefined;
});

it("complete_task accepts the absent tracked settings after the worker removes its sparse file (ADR 0360 決定2)", async () => {
  const workspace = await makeWorkspace("removed-sparse-completion");
  await shareBothSettings(workspace.path);
  const booted = await bootClaudeOn(workspace);
  t = booted.t;
  const task = queueWork(t, "finish with both settings hidden", workspace.name);

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(claudeSpawnOf(booted.proc, task.id)).toBeDefined());
  const checkout = checkoutOf(t.db, task.id);
  expect(existsSync(join(checkout, ".claude", "settings.json"))).toBe(false);
  expect(existsSync(join(checkout, ".claude", "settings.local.json"))).toBe(false);
  await unlink(join(checkout, ".git", "info", "sparse-checkout"));

  const result = await callAsTask(t, task.id, "complete_task", { handoff: FULL_HANDOFF });

  expect(result, JSON.stringify(result.content)).not.toHaveProperty("isError", true);
  expect((await api(t.baseUrl, "GET", `/api/tasks/${task.id}`)).json.status).toBe("done");
});

it("完了の門には index で隠した tracked な変更も見える(ADR 0356 決定3)", async () => {
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
  expect(completionTreePaths(db, place, task.id)).toEqual([]);
  expect(existsSync(join(place.path, ".claude/settings.json"))).toBe(false);
  git(place.path, "update-index", "--skip-worktree", "--", "README.md");
  writeFileSync(join(place.path, "README.md"), "changed\n");
  expect(completionTreePaths(db, place, task.id)).toEqual(["README.md"]);
});

it.each([
  [".claude/settings.json", ""],
  [".claude/settings.json", '{"env":{"WORKER":"1"}}\n'],
  [".claude/settings.local.json", ""],
  [".claude/settings.local.json", '{"env":{"WORKER":"1"}}\n'],
])("隠した %s に %j が置かれても完了の門は名指さず、WIP は記録の blob を運ぶ(ADR 0360 決定2、#3075)", async (hidden, content) => {
  const workspace = await makeWorkspace("sparse-stub");
  db = openDb(":memory:");
  await shareBothSettings(workspace.path);
  const task = registerTask(db, { type: "work", title: "work", purpose: "why", completion_criteria: "done" }, new Date(0), ...HUMAN_WEBUI);
  const place = await prepareAtPickup(db, workspace, task);
  excludeWorkspaceProjectSettings(place, task.id, [".claude/settings.json", ".claude/settings.local.json"]);
  const recorded = git(workspace.path, "rev-parse", `task/${task.id}:${hidden}`);
  // sandbox の stub(0 byte)も worker の中身も、worker の git env では S bit のまま clean に見える(ADR 0293 追記)
  mkdirSync(join(place.path, ".claude"), { recursive: true });
  writeFileSync(join(place.path, hidden), content);

  expect(completionTreePaths(db, place, task.id)).toEqual([]);

  writeFileSync(join(place.path, "half-done.txt"), "work in flight\n");
  releaseWorkspace(db, place, task, new Date(0));

  expect(git(workspace.path, "log", "-1", "--format=%s", `task/${task.id}`)).toContain("WIP");
  expect(git(workspace.path, "rev-parse", `task/${task.id}:${hidden}`)).toBe(recorded);
});

it("forged sparse rules cannot hide a README deletion from completion or WIP (ADR 0360 決定2)", async () => {
  const workspace = await makeWorkspace("sparse-policy-pin");
  commitWork(workspace.path, "human-omitted.txt", "human sparse policy\n");
  git(workspace.path, "sparse-checkout", "set", "--no-cone", "/*", "!/human-omitted.txt");
  const booted = await bootClaudeOn(workspace);
  t = booted.t;
  const task = queueWork(t, "try to hide a README deletion", workspace.name);

  await t.clock.advance(HOUR);
  await vi.waitFor(() => expect(claudeSpawnOf(booted.proc, task.id)).toBeDefined());
  const checkout = checkoutOf(t.db, task.id);
  git(checkout, "sparse-checkout", "set", "--no-cone", "/*", "!/.claude/settings.json", "!/.claude/settings.local.json", "!/README.md");
  expect(existsSync(join(checkout, "README.md"))).toBe(false);
  expect(git(checkout, "status", "--porcelain")).toBe("");

  const result = await callAsTask(t, task.id, "complete_task", { handoff: FULL_HANDOFF });

  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain("commit them on the task branch first");
  expect(result.content[0].text.split("\n").slice(1)).toEqual(["- README.md"]);
  booted.proc.emitExit(0, null);
  await vi.waitFor(() => expect(existsSync(checkout)).toBe(false));
  expect(git(workspace.path, "diff", "--name-status", "main", `task/${task.id}`)).toBe("D\tREADME.md");
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

it("非完了の解放では、worker が sparse file を消しても両 settings を WIP に残す(ADR 0360 決定1・2)", async () => {
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

  await unlink(join(checkout, ".git", "info", "sparse-checkout"));
  await writeFile(join(checkout, "unfinished.txt"), "work in progress\n");
  booted.proc.emitExit(0, null);

  await vi.waitFor(() => expect(existsSync(checkout)).toBe(false));
  expect(git(workspace.path, "diff", "--name-status", "main", `task/${task.id}`)).toBe("A\tunfinished.txt");
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
  expect(stop.purpose).toContain(".claude/settings.local.json is in the task checkout but not in the recorded tree");
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`)).toBeUndefined();
  expect(claudeSpawnOf(booted.proc, task.id)).toBeUndefined();
});

it("記録の settings.json を隠しても効かなかった task の checkout(変更中の tracked file は sparse が消さない)は workspace の quarantine に落ちて spawn しない(ADR 0360 決定2)", async () => {
  const workspace = await makeWorkspace("sparse-hide-failed");
  await mkdir(join(workspace.path, ".claude"));
  commitWork(workspace.path, ".claude/settings.json", "{}\n");
  const booted = await bootClaudeOn(workspace, {
    beforeStart: (db, taskId) => writeFileSync(join(checkoutOf(db, taskId), ".claude", "settings.json"), '{"hooks":{}}\n'),
  });
  t = booted.t;
  const task = queueWork(t, "work in a checkout the hide misses", workspace.name);

  await t.clock.advance(HOUR);
  const stop = await vi.waitFor(async () => {
    const question = await servedQuarantineQuestion(t!, "workspace", workspace.name);
    expect(question).toBeDefined();
    return question;
  });
  expect(stop.purpose).toContain("could not exclude .claude/settings.json: still in the task checkout after sparse-checkout");
  expect(await servedQuarantineQuestion(t, "workspaceContainment", `claude-code/${workspace.name}`)).toBeUndefined();
  expect(claudeSpawnOf(booted.proc, task.id)).toBeUndefined();
});
