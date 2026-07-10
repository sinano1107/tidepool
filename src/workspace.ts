import { execFileSync } from "node:child_process";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

export { BOARD_WORKER_ID } from "./tasks.js";

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

/** Quarantine resolution's verification gate (issue #21, CONTEXT.md): the
 *  board never takes a repair confirmation on faith. Any failure to observe
 *  a clean tree — dirty, or not even a usable git repository — is treated
 *  the same, fail-closed, same posture as the tree rule's own dirty-after-
 *  WIP-commit check. */
export function verifyWorkspaceClean(workspace: WorkspaceConfig): void {
  let status: string;
  try {
    status = git(workspace.path, "status", "--porcelain");
  } catch (err) {
    throw new Error(
      `workspace ${workspace.name} is not a usable git repository: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (status !== "") {
    throw new Error(`workspace ${workspace.name} still has uncommitted changes`);
  }
}

export function workspaceNeedsHuman(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT needs_human FROM workspace_state WHERE name = ?")
    .get(name) as { needs_human: number } | undefined;
  return row?.needs_human === 1;
}

/** Tree-rule failure containment (quarantine, CONTEXT.md): mark the workspace
 *  needs-human (its tasks stay out of the slot) and put the repair in front of
 *  the human as a 1-choice Confirmation question (issue #21) — the answer
 *  isn't a choice between outcomes, it's a confirmation that repair happened,
 *  verified before it clears needs-human (see answerQuestion in tasks.ts). */
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
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  // 1 workspace = at most 1 open Confirmation question (CONTEXT.md's
  // Quarantine): a re-fire before the human answers just adds to the record
  // of why, on the question already standing.
  const existing = db
    .prepare(
      `SELECT id FROM tasks WHERE question_quarantine_workspace = ? AND status = 'todo'`,
    )
    .get(workspace.name) as { id: string } | undefined;
  if (existing) {
    appendEvent(db, {
      taskId: existing.id,
      workerId: BOARD_WORKER_ID,
      payload: { kind: "quarantine_refired", cause: causeMessage },
      at: now,
    });
    return;
  }
  registerTask(
    db,
    {
      type: "question",
      title: `workspace ${workspace.name} needs human attention`,
      purpose:
        `the slot-release tree rule failed on ${workspace.path}: ${causeMessage}. ` +
        "Tasks in this workspace stay out of the slot until it is repaired. " +
        "Answering confirms the repair — the board verifies the tree is " +
        "clean before it resumes pickup; any answer text is kept as a repair note.",
      completion_criteria: "the workspace is repaired by hand",
      question: {
        options: ["repaired by hand"],
        recommendation: "repaired by hand",
      },
      quarantine_workspace: workspace.name,
    },
    now,
    BOARD_WORKER_ID,
  );
}

/** Every slot release runs the tree rule and falls back to quarantine on its
 *  failure — the shared shape behind the releasing MCP verbs (complete,
 *  escalate, decompose) and the watchdog/restart failure path alike (#9). */
export function releaseWorkspace(
  db: Db,
  workspace: WorkspaceConfig,
  taskId: string,
  now: Date,
): void {
  try {
    releaseTree(workspace, taskId);
  } catch (err) {
    quarantineWorkspace(db, workspace, err, now);
  }
}
