import { execFileSync } from "node:child_process";
import type { Db } from "./db.js";
import { registerTask } from "./tasks.js";

/** The board's workspace: registry name + path of a real git checkout. The
 *  branch discipline and the slot-release tree rule (issue #8) act on it —
 *  enforced by tidepool itself, never entrusted to the worker. */
export interface WorkspaceConfig {
  name: string;
  path: string;
}

/** The protected branch: no task ever works on it directly. */
const MAIN_BRANCH = "main";

function git(cwd: string, ...args: string[]): string {
  // stderr captured, not inherited: git narrates checkouts on stderr and the
  // board's console is not the place for it
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

export function taskBranch(taskId: string): string {
  return `task/${taskId}`;
}

/** Branch discipline at pickup: work never happens on main. A fresh task gets
 *  a new branch off main; a resumed task (e.g. returning from escalation) just
 *  checks its own branch out again, WIP intact. */
export function ensureTaskBranch(workspace: WorkspaceConfig, taskId: string): void {
  const branch = taskBranch(taskId);
  try {
    git(workspace.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    git(workspace.path, "branch", branch, MAIN_BRANCH);
  }
  git(workspace.path, "checkout", branch);
}

/** The slot-release tree rule: whatever the session left behind is stashed as
 *  a WIP commit on the task branch, and the tree is verified clean before the
 *  slot goes free. Mechanical, on every release — completion, escalation or
 *  failure alike — so nothing rests on the agent having tidied up. */
export function releaseTree(workspace: WorkspaceConfig, taskId: string): void {
  // the WIP commit lands on the task branch or nowhere: a session that
  // wandered off its branch (e.g. onto main) must not have its leavings
  // committed there — refusing here is what makes the main-write ban
  // structural, and the refusal lands in the quarantine path
  const head = git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD");
  if (head !== taskBranch(taskId)) {
    throw new Error(
      `workspace ${workspace.name} is on '${head}', not '${taskBranch(taskId)}' — refusing to commit`,
    );
  }
  git(workspace.path, "add", "-A");
  if (git(workspace.path, "status", "--porcelain") !== "") {
    git(
      workspace.path,
      "-c",
      "user.name=tidepool",
      "-c",
      "user.email=tidepool@board",
      "commit",
      "-m",
      `WIP: task ${taskId}`,
    );
  }
  if (git(workspace.path, "status", "--porcelain") !== "") {
    throw new Error(`workspace ${workspace.name} still dirty after WIP commit`);
  }
}

export function workspaceNeedsHuman(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT needs_human FROM workspace_state WHERE name = ?")
    .get(name) as { needs_human: number } | undefined;
  return row?.needs_human === 1;
}

/** Worker id the board acts under when it enforces its own rules: the tree
 *  rule's failures are the board's to report, never pinned on the agent. */
export const BOARD_WORKER_ID = "tidepool";

/** Tree-rule failure containment (quarantine): mark the workspace needs-human
 *  (its tasks stay out of the slot) and put the repair in front of the human
 *  as a question task. Clearing the mark is by hand for now — the recovery
 *  wiring is a later slice, like the watchdog (#9). */
export function quarantineWorkspace(
  db: Db,
  workspace: WorkspaceConfig,
  cause: unknown,
  now: Date,
): void {
  db.prepare(
    `INSERT INTO workspace_state (name, needs_human) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET needs_human = 1`,
  ).run(workspace.name);
  registerTask(
    db,
    {
      type: "question",
      title: `workspace ${workspace.name} needs human attention`,
      purpose:
        `the slot-release tree rule failed on ${workspace.path}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}. ` +
        "Tasks in this workspace stay out of the slot until it is repaired.",
      completion_criteria: "the workspace is repaired by hand",
      question: {
        options: ["repaired by hand", "abandon this workspace"],
        recommendation: "repaired by hand",
      },
    },
    now,
    BOARD_WORKER_ID,
  );
}
