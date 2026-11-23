import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { exactProtectedBranchRef, protectedBranch } from "./pickup-predicates.js";
import { quarantineUnlessClear } from "./quarantine.js";
import type { Harness } from "./registry.js";
import { PROJECT_SETTINGS_PATHS, recordedSettingsDisposition } from "./sandbox.js";
import type { Task } from "./tasks.js";
import type { WorkspaceConfig } from "./workspace.js";

export type HarnessContainmentCheck = (harness: Harness) => Promise<ContainmentCapability>;

export class UnhideableTaskSettingsError extends Error {}

/** Persist the narrowest safe stop: one Confirmation per Harness, never a
 * board-wide halt. Another canonical route remains eligible in the same poll. */
export function harnessContainmentPickupBlocked(
  db: Db,
  harness: Harness,
  check: HarnessContainmentCheck,
  now: () => Date,
): Promise<boolean> {
  return quarantineUnlessClear(db, "harnessContainment", harness, () => check(harness), now);
}

/** 組の検査(ADR 0259 決定1・5): この workspace で、この Harness の worker を封じ込められるか。Harness ごとに
 *  1つあり、worker の起動と workspace の封じ込めの question への回答時の検査が、同じそれを呼ぶ。Claude はこれ —— 名前の場所
 *  `namedPlace` の保護ブランチの tree(記録、`recordedSettingsDisposition`)に盤面が隠せない形があるか(ADR 0360 決定1・3)。
 *  Codex は skill の列挙と観測(`codexWorkspaceContainment`)—— 回答時は `CodexWorkspaceCheck` の形で受け取る。 */
export function claudeWorkspaceContainment(namedPlace: WorkspaceConfig): ContainmentCapability {
  const branch = protectedBranch(namedPlace);
  const ref = exactProtectedBranchRef(namedPlace);
  const shape = recordedSettingsDisposition(namedPlace.path, ref).unhideable;
  if (!shape) return { available: true };
  return {
    available: false,
    reason:
      `the recorded tree of ${ref} in the named place ${namedPlace.path} has ${shape.path} as a ${shape.type}, not a directory — ` +
      `the board cannot hide ${PROJECT_SETTINGS_PATHS.join(" or ")} behind it from the worker's CLI, ` +
      `so commit ${shape.path} as a directory on ${branch}`,
  };
}

/** ADR 0360 決定3 / ADR 0379 決定5: 面接室には人間の書き手が居ないので、Interview の root と受験者は保護ブランチに当て直さず常に task の失敗。 */
export const rereadsProtectedTip = (task: Pick<Task, "type" | "interview_target_id">): boolean => task.type !== "interview" && task.interview_target_id === null;

/** 組の停止か task の失敗か(ADR 0360 決定3 / ADR 0379 決定3・7、両 Harness の唯一の分け): task の tree が落ちた後、保護ブランチの tip でも
 *  落ちれば組を止める理由を返す。通ったか、当て直さなかった(undefined)なら task の失敗で undefined。 */
export const pairStopReason = (protectedTip: ContainmentCapability | undefined): string | undefined =>
  protectedTip && !protectedTip.available ? protectedTip.reason : undefined;

/** 回答時の (codex, workspace) の検査。Board call の口から組む(`createCodexWorkspaceCheck`)。`workspace.path` は検査する tree の checkout —— 回答は
 *  保護ブランチの tip か取り込む tip の使い捨ての checkout を渡す(ADR 0379 決定1)。 */
export type CodexWorkspaceCheck = (workspace: WorkspaceConfig) => Promise<ContainmentCapability>;
