import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { protectedBranch } from "./pickup-predicates.js";
import { quarantineUnlessClear } from "./quarantine.js";
import type { Harness } from "./registry.js";
import { PROJECT_SETTINGS_PATHS, type RecordedSettings } from "./sandbox.js";
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

/** 組の検査(ADR 0259 決定1・5): この workspace で、この Harness の worker を封じ込められるか。Harness ごとに
 *  1つあり、worker の起動と workspace の封じ込めの question への回答時の検査が、同じそれを呼ぶ。Claude はこれ —— 名前の場所
 *  `namedPlace` の `ref` の tree(記録、`recordedSettingsDisposition`)に盤面が隠せない形があるか(ADR 0360 決定1)。直す先は回答が
 *  読み直す保護ブランチ(決定3)。Codex は skill の列挙と観測(`codexWorkspaceContainment`)—— 回答時は `CodexWorkspaceCheck` の形で受け取る。 */
export function claudeWorkspaceContainment(recorded: RecordedSettings, ref: string, namedPlace: WorkspaceConfig): ContainmentCapability {
  const shape = recorded.unhideable;
  if (!shape) return { available: true };
  return {
    available: false,
    reason:
      `the recorded tree of ${ref} in the named place ${namedPlace.path} has ${shape.path} as a ${shape.type}, not a directory — ` +
      `the board cannot hide ${PROJECT_SETTINGS_PATHS.join(" or ")} behind it from the worker's CLI, ` +
      `so commit ${shape.path} as a directory on ${protectedBranch(namedPlace)}`,
  };
}

/** 回答時の (codex, workspace) の検査。Board call の口から組む(`createCodexWorkspaceCheck`)。 */
export type CodexWorkspaceCheck = (workspace: WorkspaceConfig) => Promise<ContainmentCapability>;
