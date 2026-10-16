import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, getTask, poseProbe, registerTask, type Task } from "../src/tasks.js";
import { RecordContainerError } from "../src/transcript-store.js";
import { prepareWorkspaceAtPickup, releaseWorkspace, resolveTaskBranchLineage, type WorkspaceConfig, workspaceNeedsHuman } from "../src/workspace.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeRemoteBackedWorkspace, makeWorkspace } from "./harness.js";
import { tempDir } from "./temp-dir.js";

// pin の子の checkout(ADR 0263 決定5・6 / ADR 0111 追記12)。分岐の土台と、決着した pin の子のブランチを外すこと。

vi.setConfig({ testTimeout: GIT_FIXTURE_TEST_TIMEOUT });

const NOW = new Date("2026-10-15T00:00:00.000Z");
const opusHigh = { provider: "anthropic", model: "claude-opus-5-5", effort: "high", tier: "standard" };
const sonnetHigh = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "high", tier: "economy" };
const haikuNull = { provider: "anthropic", model: "claude-haiku-4-5", effort: null, tier: "economy" };
const POSE = { title: "add a parser", probe: "write a parser for the config format", completion_criteria: "the parser handles every sample", rubric: "tests pass, no new dependency" };

/** Interview を登録して出題し、pin の子を返す。head は既定で今の main。 */
function posed(db: Db, workspace: WorkspaceConfig, targets: object[] = [opusHigh], head = git(workspace.path, "rev-parse", "main")): Task[] {
  const root = registerTask(db, { type: "review", title: "interview", purpose: "the original task", completion_criteria: "every target scored", workspace: workspace.name, interview_targets: targets as never }, NOW, ...HUMAN_WEBUI);
  return poseProbe(db, root, POSE, "auditor", NOW, "worker", head);
}

/** 先に走った task の答案が載ったブランチ(その task の pickup と commit の跡)。 */
function answeredBranch(workspace: WorkspaceConfig, taskId: string): string {
  git(workspace.path, "checkout", "-b", `task/${taskId}`, "main");
  commitWork(workspace.path, `${taskId}.txt`, "an answer\n");
  git(workspace.path, "checkout", "main");
  return git(workspace.path, "rev-parse", `task/${taskId}`);
}

it("pin の子の新しいブランチは、出題の後に main が進んでも、受験者が分解判断に乗らなくても、対象 → root の出題が記録した保護ブランチの head から分岐する", async () => {
  const workspace = await makeWorkspace("pin-posed-head");
  const db = openDb(":memory:");
  const [examinee] = posed(db, workspace);
  // 受験者は分解判断に乗らない(ADR 0267 決定1・5)
  db.prepare("UPDATE tasks SET based_on_decision = NULL WHERE id = ?").run(examinee!.id);
  const child = getTask(db, examinee!.id);
  const posedHead = git(workspace.path, "rev-parse", "main");
  commitWork(workspace.path, "later.txt", "main moved on after the probe was posed\n");

  await prepareWorkspaceAtPickup(db, workspace, child!, { now: new Date(0) });

  expect(git(workspace.path, "rev-parse", `task/${child!.id}`)).toBe(posedHead);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${child!.id}`);
  db.close();
});

it("failure の retry で再開する pin の子は、既存のブランチのまま走る", async () => {
  const workspace = await makeWorkspace("pin-retry-resumes");
  const db = openDb(":memory:");
  const [child] = posed(db, workspace);
  await prepareWorkspaceAtPickup(db, workspace, child!, { now: new Date(0) });
  commitWork(workspace.path, "wip.txt", "the first session's work\n");
  const wip = git(workspace.path, "rev-parse", "HEAD");
  git(workspace.path, "checkout", "main");

  await prepareWorkspaceAtPickup(db, workspace, child!, { now: new Date(0) });

  expect(git(workspace.path, "rev-parse", "HEAD")).toBe(wip);
  expect(git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`task/${child!.id}`);
  db.close();
});

it("出題が記録した head を checkout で引けなければ、pickup の準備はその理由で投げ、ブランチを切らない", async () => {
  const workspace = await makeWorkspace("pin-unresolvable-head");
  const db = openDb(":memory:");
  const unknown = "0123456789abcdef0123456789abcdef01234567";
  const [child] = posed(db, workspace, [opusHigh], unknown);

  await expect(prepareWorkspaceAtPickup(db, workspace, child!, { now: new Date(0) })).rejects.toThrow(
    `the protected branch head the probe recorded for ${child!.id} (${unknown}) cannot be resolved in this checkout`,
  );
  expect(git(workspace.path, "branch", "--list", `task/${child!.id}`)).toBe("");
  db.close();
});

it("pin の子の pickup の準備は、決着した pin の子(別の Interview のものも)のブランチを外して head を記録し、決着していない pin の子と pin の子でない task のブランチは残す —— ref の検査は違反を立てない", async () => {
  const workspace = await makeWorkspace("pin-settled-branches");
  const db = openDb(":memory:");
  const [done, pending, picked] = posed(db, workspace, [opusHigh, sonnetHigh, haikuNull]) as [Task, Task, Task];
  const [earlier] = posed(db, workspace) as [Task];
  const work = registerTask(db, { type: "work", title: "production work", purpose: "ship", completion_criteria: "shipped", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  const heads = Object.fromEntries([done, pending, earlier, work].map(({ id }) => [id, answeredBranch(workspace, id)]));
  for (const task of [done, earlier, work]) completeTask(db, task, FULL_HANDOFF, "tako", NOW, "worker");

  await prepareWorkspaceAtPickup(db, workspace, picked, { now: new Date(0) });

  const branches = git(workspace.path, "for-each-ref", "--format=%(refname:short)", "refs/heads/task/").split("\n");
  expect(branches.sort()).toEqual([`task/${pending.id}`, `task/${picked.id}`, `task/${work.id}`].sort());
  for (const removed of [done, earlier]) {
    expect(listEvents(db, removed.id).filter((e) => e.kind === "task_branch_removed").map((e) => e.payload)).toEqual([{ kind: "task_branch_removed", head: heads[removed.id] }]);
  }
  releaseWorkspace(db, workspace, picked, NOW);
  expect(workspaceNeedsHuman(db, workspace.name)).toBe(false);
  db.close();
});

/** 決着した pin の子1人(答案つき)と、これから拾われる pin の子1人。 */
async function settledSibling(name: string) {
  const workspace = await makeWorkspace(name);
  const recordDir = await tempDir(`tidepool-${name}-records-`);
  const db = openDb(":memory:");
  const [done, picked] = posed(db, workspace, [opusHigh, sonnetHigh]) as [Task, Task];
  const head = answeredBranch(workspace, done.id);
  completeTask(db, done, FULL_HANDOFF, "tako", NOW, "worker");
  return { workspace, recordDir, db, done, picked, head };
}

it("決着した pin の子の答案は、外す前に盤面の記録の器へ bundle で写され、event は head と写した先を持つ", async () => {
  const { workspace, recordDir, db, done, picked, head } = await settledSibling("pin-answer-copy");

  await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) });

  const path = join(recordDir, `${done.id}.bundle`);
  expect(git(workspace.path, "bundle", "list-heads", path)).toBe(`${head} refs/heads/task/${done.id}`);
  expect(listEvents(db, done.id).filter((e) => e.kind === "task_branch_removed").map((e) => e.payload)).toEqual([{ kind: "task_branch_removed", head, path }]);
  db.close();
});

it.each([
  ["loose", false],
  ["pack に入った", true],
])("ブランチを外した pickup の準備の後、答案(%s)は HEAD の reflog からも到達できない object からも読めない", async (_, packed) => {
  const { workspace, recordDir, db, done, picked, head } = await settledSibling("pin-answer-cleanup");
  if (packed) git(workspace.path, "repack", "-a", "-d");

  await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) });

  const reflog = git(workspace.path, "reflog", "show", "--no-abbrev", "HEAD");
  expect(reflog).not.toContain(done.id);
  expect(reflog).not.toContain(head);
  expect(() => git(workspace.path, "cat-file", "-e", head)).toThrow();
  expect(git(workspace.path, "fsck", "--unreachable")).toBe("");
  db.close();
});

it("掃除は本番の task のブランチ自身の reflog とそこからだけ辿れる commit、index の blob、fetch した object を残す", async () => {
  const { workspace, publish } = await makeRemoteBackedWorkspace("pin-cleanup-keeps");
  const recordDir = await tempDir("tidepool-pin-cleanup-keeps-records-");
  const db = openDb(":memory:");
  const [done, picked] = posed(db, workspace, [opusHigh, sonnetHigh]) as [Task, Task];
  answeredBranch(workspace, done.id);
  completeTask(db, done, FULL_HANDOFF, "tako", NOW, "worker");
  const work = registerTask(db, { type: "work", title: "production work", purpose: "ship", completion_criteria: "shipped", workspace: workspace.name }, NOW, ...HUMAN_WEBUI);
  git(workspace.path, "checkout", "-b", `task/${work.id}`, "main");
  commitWork(workspace.path, "kept.txt", "kept\n");
  commitWork(workspace.path, "discarded.txt", "reset away\n");
  const discarded = git(workspace.path, "rev-parse", "HEAD");
  git(workspace.path, "reset", "--hard", "HEAD~1");
  git(workspace.path, "checkout", "main");
  const workReflog = git(workspace.path, "reflog", "show", `task/${work.id}`).split("\n").length;
  writeFileSync(join(workspace.path, "staged.txt"), "staged, never committed\n");
  git(workspace.path, "add", "staged.txt");
  const staged = git(workspace.path, "rev-parse", ":staged.txt");
  publish("merged.txt", "merged on the remote\n", "a human merge");

  await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) });

  expect(git(workspace.path, "reflog", "show", `task/${work.id}`).split("\n").length).toBe(workReflog);
  for (const object of [discarded, staged]) {
    expect(() => git(workspace.path, "cat-file", "-e", object)).not.toThrow();
  }
  expect(git(workspace.path, "log", "-1", "--format=%s", "origin/main")).toBe("a human merge");
  db.close();
});

it("外すものの無い pin の子の pickup の準備は HEAD の reflog を減らさない", async () => {
  const workspace = await makeWorkspace("pin-nothing-to-remove");
  const recordDir = await tempDir("tidepool-pin-nothing-to-remove-records-");
  const db = openDb(":memory:");
  const [, picked] = posed(db, workspace, [opusHigh, sonnetHigh]) as [Task, Task];
  git(workspace.path, "checkout", "-b", "scratch");
  git(workspace.path, "checkout", "main");
  const before = git(workspace.path, "reflog", "show", "HEAD").split("\n").length;

  await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) });

  // pickup 自身の checkout の1行だけ増える
  expect(git(workspace.path, "reflog", "show", "HEAD").split("\n").length).toBe(before + 1);
  db.close();
});

it("盤面の記録の器に書けなければ、ブランチを外さず器の失敗として投げ、器が直れば次の pickup の準備が同じ手順をやり直す", async () => {
  const { workspace, recordDir, db, done, picked, head } = await settledSibling("pin-record-container-fails");
  const missing = join(recordDir, "gone");
  const path = join(missing, `${done.id}.bundle`);

  const failed = await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir: missing, now: new Date(0) }).catch((err: unknown) => err);

  expect(failed).toBeInstanceOf(RecordContainerError);
  expect(failed).toMatchObject({ taskId: done.id, path, reason: expect.stringContaining("ENOENT") });
  expect(git(workspace.path, "rev-parse", `task/${done.id}`)).toBe(head);
  expect(listEvents(db, done.id).filter((e) => e.kind === "task_branch_removed")).toEqual([]);

  mkdirSync(missing);
  await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir: missing, now: new Date(0) });

  expect(git(workspace.path, "bundle", "list-heads", path)).toBe(`${head} refs/heads/task/${done.id}`);
  expect(git(workspace.path, "branch", "--list", `task/${done.id}`)).toBe("");
  db.close();
});

it("答案の bundle が git 側の理由で作れなければ、準備の他の失敗と同じ例外で投げ、ブランチを外さない", async () => {
  const { workspace, recordDir, db, done, picked, head } = await settledSibling("pin-bundle-git-fails");
  // 答案の blob を壊す —— commit は読めるので出題の head との比較は通り、bundle の pack だけが落ちる
  const blob = git(workspace.path, "rev-parse", `${head}:${done.id}.txt`);
  rmSync(join(workspace.path, ".git", "objects", blob.slice(0, 2), blob.slice(2)));

  const failed = await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) }).catch((err: unknown) => err);

  expect(failed).not.toBeInstanceOf(RecordContainerError);
  expect((failed as Error).message).toContain("bundle create");
  expect(git(workspace.path, "for-each-ref", "--format=%(objectname)", `refs/heads/task/${done.id}`)).toBe(head);
  expect(readdirSync(recordDir)).toEqual([]);
  db.close();
});

it("commit の無い決着した pin の子(head が出題の head)は写さず、event は head だけ持つ", async () => {
  const workspace = await makeWorkspace("pin-no-answer-copy");
  const recordDir = await tempDir("tidepool-pin-no-answer-copy-records-");
  const db = openDb(":memory:");
  const [done, picked] = posed(db, workspace, [opusHigh, sonnetHigh]) as [Task, Task];
  git(workspace.path, "branch", `task/${done.id}`, "main");
  const head = git(workspace.path, "rev-parse", "main");
  completeTask(db, done, FULL_HANDOFF, "tako", NOW, "worker");

  await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) });

  expect(readdirSync(recordDir)).toEqual([]);
  expect(listEvents(db, done.id).filter((e) => e.kind === "task_branch_removed").map((e) => e.payload)).toEqual([{ kind: "task_branch_removed", head }]);
  expect(git(workspace.path, "branch", "--list", `task/${done.id}`)).toBe("");
  db.close();
});

it("出題の head の祖先に留まる決着した pin の子(出題の head から commit が無い)は写さず、ブランチを外す", async () => {
  const workspace = await makeWorkspace("pin-behind-posed-head");
  const recordDir = await tempDir("tidepool-pin-behind-posed-head-records-");
  const db = openDb(":memory:");
  const behind = git(workspace.path, "rev-parse", "main");
  commitWork(workspace.path, "later.txt", "main moved on before the probe was posed\n");
  const [done, picked] = posed(db, workspace, [opusHigh, sonnetHigh]) as [Task, Task];
  git(workspace.path, "branch", `task/${done.id}`, behind);
  completeTask(db, done, FULL_HANDOFF, "tako", NOW, "worker");

  await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) });

  expect(readdirSync(recordDir)).toEqual([]);
  expect(listEvents(db, done.id).filter((e) => e.kind === "task_branch_removed").map((e) => e.payload)).toEqual([{ kind: "task_branch_removed", head: behind }]);
  expect(git(workspace.path, "branch", "--list", `task/${done.id}`)).toBe("");
  db.close();
});

it("写しを書いた後でブランチを外す前に落ちても、次の pickup の準備が同じ手順をやり直す", async () => {
  const { workspace, recordDir, db, done, picked, head } = await settledSibling("pin-redo-after-copy");
  const lock = join(workspace.path, ".git", "refs", "heads", "task", `${done.id}.lock`);
  writeFileSync(lock, "");

  await expect(prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) })).rejects.toThrow();
  expect(git(workspace.path, "rev-parse", `task/${done.id}`)).toBe(head);

  rmSync(lock);
  await prepareWorkspaceAtPickup(db, workspace, picked, { recordDir, now: new Date(0) });

  expect(git(workspace.path, "bundle", "list-heads", join(recordDir, `${done.id}.bundle`))).toBe(`${head} refs/heads/task/${done.id}`);
  expect(git(workspace.path, "branch", "--list", `task/${done.id}`)).toBe("");
  expect(() => git(workspace.path, "cat-file", "-e", head)).toThrow();
  db.close();
});

it("ref の無い決着した pin の子を祖先に持つ task の lineage は投げない", async () => {
  const workspace = await makeWorkspace("pin-lineage-without-ref");
  const db = openDb(":memory:");
  const [child] = posed(db, workspace) as [Task];
  const settled = completeTask(db, child, FULL_HANDOFF, "tako", NOW, "worker");
  const repair = registerTask(db, { type: "work", title: "repair", purpose: "fix the answer", completion_criteria: "fixed", parent_id: settled.id }, NOW, ...HUMAN_WEBUI);

  expect(() => resolveTaskBranchLineage(db, workspace, repair)).not.toThrow();
  db.close();
});
