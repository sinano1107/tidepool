import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { quarantineUnlessClear } from "./quarantine.js";
import type { Harness } from "./registry.js";
import { workspaceSettingsDisposition } from "./sandbox.js";
import type { WorkspaceConfig } from "./workspace.js";

export type HarnessContainmentCheck = (harness: Harness) => Promise<ContainmentCapability>;

/** Persist the narrowest safe stop: one Confirmation per Harness, never a
 * board-wide halt. Another canonical route remains eligible in the same poll. */
export function harnessContainmentPickupBlocked(
  db: Db,
  harness: Harness,
  check: HarnessContainmentCheck,
  now: Date,
): Promise<boolean> {
  return quarantineUnlessClear(db, "harnessContainment", harness, () => check(harness), now);
}

/** 組の検査(ADR 0259 決定1・5): この workspace の checkout で、この Harness の worker を封じ込められるか。Harness ごとに
 *  1つあり、worker の起動と workspace の封じ込めの question への回答時の検査が、同じそれを呼ぶ。Claude はこれ、Codex は
 *  skill の列挙と観測(`codexWorkspaceContainment`)—— 回答時は `CodexWorkspaceCheck` の形で受け取る。 */
export function claudeWorkspaceContainment(workspacePath: string): ContainmentCapability {
  // 隠せない設定ファイルの拒否は ADR 0033 / ADR 0035 / ADR 0158。中身でなく置き場所で止め、止まるのは読めないものだけ(ADR 0346 決定2)
  const { overriding } = workspaceSettingsDisposition(workspacePath);
  if (overriding.length === 0) return { available: true };
  return {
    available: false,
    reason:
      `workspace carries .claude/${overriding.join(", .claude/")}, which is unreadable ` +
      "(a directory, a file without read permission, or a path that cannot be looked up) — " +
      "the board hides only readable Git-tracked settings files, so remove it or make it a readable file",
  };
}

/** 回答時の (codex, workspace) の検査。Board call の口から組む(`createCodexWorkspaceCheck`)。 */
export type CodexWorkspaceCheck = (workspace: WorkspaceConfig) => Promise<ContainmentCapability>;
