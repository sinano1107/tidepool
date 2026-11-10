import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { appendEvent, listEvents } from "../src/events.js";
import { completeTask, getTask, pickupTask, registerTask, type Task } from "../src/tasks.js";
import {
  commitRoomCopy,
  completionTreePaths,
  excludeWorkspaceProjectSettings,
  type RunPlace,
  recordedInterviewRoom,
  recordTaskCheckoutTip,
  releaseWorkspace,
  type WorkspaceConfig,
  workspaceNeedsHuman,
} from "../src/workspace.js";
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
  openTestInterviewRoom,
  pickUpInterviewRoot,
  prepareAtPickup,
  questions,
  queueWork,
  servedQuarantineQuestion,
  type Tidepool,
  WORKER_SPAWNED,
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

/** 両 settings を隠した task の checkout で、`.claude/settings.json` の path にディレクトリを置いた形(#3111)。`workspace` は名前の場所
 *  —— Interview の root なら面接室。 */
async function directoryAtHiddenSettings(name: string, role: "work" | "interview root" = "work") {
  const real = await makeWorkspace(name);
  db = openDb(":memory:");
  let task: Task;
  let workspace: WorkspaceConfig;
  let place: RunPlace;
  if (role === "work") {
    await shareBothSettings(real.path);
    const registered = registerTask(db, { type: "work", title: "work", purpose: "why", completion_criteria: "done" }, new Date(0), ...HUMAN_WEBUI);
    task = pickupTask(db, registered, "deckhand", new Date(0))!;
    workspace = real;
    place = await prepareAtPickup(db, workspace, task);
  } else {
    task = registerTask(db, {
      type: "interview", title: "interview", hypothesis: "h", tier: "standard", workspace: real.name,
      interview_targets: [{ provider: "anthropic", model: "claude-opus-5-5", effort: "high" }],
    }, new Date(0), ...HUMAN_WEBUI);
    openTestInterviewRoom(db, task);
    await shareBothSettings(recordedInterviewRoom(db, task.id)!.path);
    ({ room: workspace, place } = await pickUpInterviewRoot(db, task, real));
  }
  excludeWorkspaceProjectSettings(place, task.id, [".claude/settings.json", ".claude/settings.local.json"]);
  const recorded = git(workspace.path, "rev-parse", `task/${task.id}:.claude/settings.json`);
  mkdirSync(join(place.path, ".claude", "settings.json", "x"), { recursive: true });
  writeFileSync(join(place.path, ".claude", "settings.json", "x", "file"), "inside\n");
  return { workspace, task, place, recorded };
}

it("隠した settings の path にディレクトリがあっても、非完了の解放は task を倒さず、WIP は記録の blob を運ぶ(ADR 0360 Status 追記、#3111)", async () => {
  const { workspace, task, place, recorded } = await directoryAtHiddenSettings("settings-directory-wip");
  writeFileSync(join(place.path, "half-done.txt"), "work in flight\n");

  releaseWorkspace(db!, place, task, new Date(0));

  expect(listEvents(db!, task.id).filter(({ kind }) => kind === "task_checkout_release_failed")).toEqual([]);
  expect(git(workspace.path, "diff", "--name-status", "main", `task/${task.id}`)).toBe("A\thalf-done.txt");
  expect(git(workspace.path, "rev-parse", `task/${task.id}:.claude/settings.json`)).toBe(recorded);
});

it("隠した settings の path にディレクトリがあっても、完了の門はその path も配下も名指さない(ADR 0360 Status 追記、#3111)", async () => {
  const { task, place } = await directoryAtHiddenSettings("settings-directory-gate");
  writeFileSync(join(place.path, "half-done.txt"), "work in flight\n");

  expect(completionTreePaths(db!, place, task.id)).toEqual(["half-done.txt"]);
});

it("隠した settings の path にディレクトリがあっても、完了後の観測は読めると記録し、その path を名指さない(ADR 0360 Status 追記、#3111)", async () => {
  const { task, place } = await directoryAtHiddenSettings("settings-directory-after-completion");
  recordTaskCheckoutTip(db!, place, task.id);
  completeTask(db!, task, FULL_HANDOFF, "worker", new Date(0), "worker");
  writeFileSync(join(place.path, "late.txt"), "written after completion\n");

  releaseWorkspace(db!, place, getTask(db!, task.id)!, new Date(0), true, undefined, undefined, true);

  expect(listEvents(db!, task.id).map(({ payload }) => payload).filter(({ kind }) => kind === "task_checkout_written_after_completion")).toEqual([
    { kind: "task_checkout_written_after_completion", path: place.path, observation: "uncommitted", paths: ["late.txt"] },
  ]);
});

it("root の checkout で隠した settings の path にディレクトリがあっても、出題の写しは通り、写しの settings は記録の blob のまま(ADR 0360 Status 追記、#3111)", async () => {
  const { workspace: room, task: root, place, recorded } = await directoryAtHiddenSettings("settings-directory-room-copy", "interview root");
  commitWork(place.path, "probe.txt", "the environment\n");

  const head = commitRoomCopy(db!, place, root.id);

  expect(git(room.path, "rev-parse", `${head}:.claude/settings.json`)).toBe(recorded);
  expect(git(room.path, "rev-parse", `${head}:probe.txt`)).not.toBe("");
});

it.each([
  ["settings を track しない tip、Claude の spawn", [], "claude", [".claude/settings.json", ".claude/settings.local.json"]],
  ["settings.json だけを track する tip、Claude の spawn", [".claude/settings.json"], "claude", [".claude/settings.local.json"]],
  ["settings を track しない tip、Codex の spawn", [], "codex", [".claude/settings.json", ".claude/settings.local.json"]],
] as const)("%s: track しない settings の path の 0 byte の stub は shadow 残骸として完了の門が名指さず、WIP にも入らない(ADR 0069、#3111)", async (_, tracked, harness, stubs) => {
  const workspace = await makeWorkspace("settings-stub-remnant");
  db = openDb(":memory:");
  mkdirSync(join(workspace.path, ".claude"));
  for (const path of tracked) commitWork(workspace.path, path, "{}\n");
  const task = registerTask(db, { type: "work", title: "work", purpose: "why", completion_criteria: "done" }, new Date(0), ...HUMAN_WEBUI);
  const place = await prepareAtPickup(db, workspace, task);
  if (harness === "codex") appendEvent(db, { taskId: task.id, actorId: "deckhand", origin: "board", payload: { ...WORKER_SPAWNED, harness }, at: new Date(0) });
  else excludeWorkspaceProjectSettings(place, task.id, [...tracked]);
  // settingsDenyWrite は tip に settings があっても無くても両 path に stub を bind する
  mkdirSync(join(place.path, ".claude"), { recursive: true });
  for (const path of stubs) writeFileSync(join(place.path, path), "");
  writeFileSync(join(place.path, "half-done.txt"), "work in flight\n");

  expect(completionTreePaths(db, place, task.id)).toEqual(["half-done.txt"]);

  releaseWorkspace(db, place, task, new Date(0));

  expect(git(workspace.path, "diff", "--name-status", "main", `task/${task.id}`)).toBe("A\thalf-done.txt");
});

it("track しない settings の path に中身のあるファイルがあれば、完了の門は変更として名指す(ADR 0069、#3111)", async () => {
  const workspace = await makeWorkspace("settings-untracked-content");
  db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "work", purpose: "why", completion_criteria: "done" }, new Date(0), ...HUMAN_WEBUI);
  const place = await prepareAtPickup(db, workspace, task);
  mkdirSync(join(place.path, ".claude"));
  writeFileSync(join(place.path, ".claude", "settings.local.json"), '{"env":{"WORKER":"1"}}\n');

  expect(completionTreePaths(db, place, task.id)).toEqual([".claude/settings.local.json"]);
});

it("task の checkout の `.claude` が通常のファイルなら、完了の門はそれを名指し、非完了の解放は task を倒さず WIP に運ぶ(ADR 0069、#3111)", async () => {
  const workspace = await makeWorkspace("claude-regular-file");
  db = openDb(":memory:");
  const task = registerTask(db, { type: "work", title: "work", purpose: "why", completion_criteria: "done" }, new Date(0), ...HUMAN_WEBUI);
  const place = await prepareAtPickup(db, workspace, task);
  writeFileSync(join(place.path, ".claude"), "not a directory\n");

  expect(completionTreePaths(db, place, task.id)).toEqual([".claude"]);

  releaseWorkspace(db, place, task, new Date(0));

  expect(listEvents(db, task.id).filter(({ kind }) => kind === "task_checkout_release_failed")).toEqual([]);
  expect(git(workspace.path, "diff", "--name-status", "main", `task/${task.id}`)).toBe("A\t.claude");
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
