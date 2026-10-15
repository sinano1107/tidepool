import { expect, it, vi } from "vitest";
import { type Db, openDb } from "../src/db.js";
import { listEvents } from "../src/events.js";
import { completeTask, poseProbe, registerTask, type Task } from "../src/tasks.js";
import { prepareWorkspaceAtPickup, releaseWorkspace, resolveTaskBranchLineage, type WorkspaceConfig, workspaceNeedsHuman } from "../src/workspace.js";
import { commitWork, FULL_HANDOFF, GIT_FIXTURE_TEST_TIMEOUT, git, HUMAN_WEBUI, makeWorkspace } from "./harness.js";

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

it("pin の子の新しいブランチは、出題の後に main が進んでも、出題が記録した保護ブランチの head から分岐する", async () => {
  const workspace = await makeWorkspace("pin-posed-head");
  const db = openDb(":memory:");
  const [child] = posed(db, workspace);
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

it("ref の無い決着した pin の子を祖先に持つ task の lineage は投げない", async () => {
  const workspace = await makeWorkspace("pin-lineage-without-ref");
  const db = openDb(":memory:");
  const [child] = posed(db, workspace) as [Task];
  const settled = completeTask(db, child, FULL_HANDOFF, "tako", NOW, "worker");
  const repair = registerTask(db, { type: "work", title: "repair", purpose: "fix the answer", completion_criteria: "fixed", parent_id: settled.id }, NOW, ...HUMAN_WEBUI);

  expect(() => resolveTaskBranchLineage(db, workspace, repair)).not.toThrow();
  db.close();
});
