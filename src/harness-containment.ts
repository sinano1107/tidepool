import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { quarantineUnlessClear } from "./quarantine.js";
import type { Harness } from "./registry.js";
import { workspaceSettingsDisposition } from "./sandbox.js";

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

/** 組の検査の入口(ADR 0259 決定1・5): この workspace の checkout で、この Harness の worker を封じ込められるか。
 *  worker の起動と、workspace の封じ込めの question への回答時の検査が、同じこれを呼ぶ。 */
export function workspaceContainment(harness: Harness, workspacePath: string): ContainmentCapability {
  // ponytail: Codex の skill の列挙と観測は #1967 が足す。それまで Codex の組は常に成立する
  if (harness === "codex") return { available: true };
  // 隠せない設定ファイルの拒否は ADR 0033 / ADR 0035 / ADR 0158
  const { overriding } = workspaceSettingsDisposition(workspacePath);
  if (overriding.length === 0) return { available: true };
  return {
    available: false,
    reason:
      `workspace carries unsafe .claude/${overriding.join(", .claude/")}: it is unreadable, ` +
      "or it is a local or untracked settings file that is invalid JSON or declares " +
      "sandbox/permissions/hooks — the board can hide " +
      "only a Git-tracked .claude/settings.json, so make the file readable or remove it " +
      "(or those blocks) from this checkout",
  };
}
