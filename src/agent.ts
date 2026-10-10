import type { Db } from "./db.js";
import { countTasksAwaitingLanding } from "./landing.js";
import { openQuarantineQuestion, quarantineAgent } from "./quarantine.js";
import {
  type AgentDefinition,
  type AuthorityProfile,
  assertValidAgentDefinition,
  InvalidAgentDefinitionError,
  isUnresolvableAgentError,
  ownEntry,
  REVIEWER_AUTHORITY_PROFILE,
  type Registry,
  UnknownAgentError,
} from "./registry.js";
import { unsettledSql } from "./task-status.js";
import { type TaskType, typeAwareDefaultAgentSql } from "./tasks.js";
import type { Tier } from "./tier.js";

/** An assignee (or the board's default) resolved against the registry —
 *  the agent's own definition and its authority profile together, since spawn
 *  needs both in the same moment (claude-worker.ts). Mirrors
 *  workspace.ts's WorkspaceConfig. */
export interface ResolvedAgent {
  name: string;
  definition: AgentDefinition;
  profile: AuthorityProfile;
}

/** CONTEXT.md's Assignee: `task.assignee` is a reference to a registry agent
 *  name, resolved fresh against the registry every time it's used (spawn,
 *  quarantine clearance) — null inherits the board's default agent, never
 *  pinned. Mirrors workspace.ts's resolveExecutionWorkspace.
 *
 *  Resolution also re-runs the definition gates (ADR 0097 決定1/3 / ADR 0110
 *  決定1): a definition whose provider or tier is outside the enumeration, that
 *  combines an advisor with a provider that doesn't offer one, or that still
 *  pins a retired model / effort, is a broken resource,
 *  not a spawnable agent — InvalidAgentDefinitionError, which the pickup path
 *  (resolveAgentOrQuarantine) fails closed into the same agent-name
 *  quarantine as registry drift. The loader deliberately does not reject
 *  these (a violating file still parses) so the violation stops the one
 *  agent instead of the whole registry read. A definition naming an authority
 *  profile the registry does not have is the same broken resource (issue
 *  #1648): only resolution looks the profile up, so it is not one of the
 *  shared gates, but it fails into the same error and quarantine. */
export function resolveExecutionAgent(
  registry: Registry,
  defaultAgentName: string,
  taskAssignee: string | null,
  /** 盤面の段の名前(ADR 0200 決定2): agent.md の `tier` を検査する一覧。 */
  tiers: readonly Tier[],
  /** 解決するタスクの type。既定 agent の起動検査は work として解決する。 */
  taskType: TaskType,
): ResolvedAgent {
  const name = taskAssignee ?? defaultAgentName;
  const definition = ownEntry(registry.agents, name);
  if (!definition) throw new UnknownAgentError(name);
  assertValidAgentDefinition(name, definition, tiers);
  // 組み込みは review 専用(ADR 0228 決定1/4): 名前ではなく解決の結果を見るので、
  // shadow している間の work はここを通らない。扉の外で work が組み込みに落ちたら
  // 解決の失敗として agent 名の quarantine に乗せる。
  if (definition.builtin && taskType !== "review") {
    throw new InvalidAgentDefinitionError(
      name,
      `the built-in agent runs reviews only, but a ${taskType} task resolved to it; ` +
        `restore a registry entry named ${name} or reassign that task`,
    );
  }
  // 組み込み(ADR 0117 決定1)だけは profile を registry から引かない —— 種まきは
  // auditor の profile を書かず、組み込みは授権を増やさないので、床そのものである
  // ADR 0013 の定数を直に返す(registry の authority map には注入しない: 注入すると
  // profile 一覧・削除・authority select に、編集も削除もできない行が生える)。
  // 組み込みは review しか走らないので、merge ダイヤルを持たないこの profile が
  // 着地の面に読まれることはない(ADR 0228)。
  const profile = definition.builtin
    ? REVIEWER_AUTHORITY_PROFILE
    : ownEntry(registry.authority, definition.authority);
  if (!profile) throw new InvalidAgentDefinitionError(name, `unknown authority profile "${definition.authority}"`);
  return { name, definition, profile };
}

/** ADR 0137 決定3: the open Confirmation question is the only state. */
export function agentNeedsHuman(db: Db, name: string): boolean {
  return openQuarantineQuestion(db, "agent", name) !== undefined;
}

/** The agent-name generalization of workspace.ts's resolveOrQuarantine (ADR
 *  0012 / issue #36): `resolve` throwing `UnknownAgentError` (registry drift)
 *  or `InvalidAgentDefinitionError` (a definition that no longer stands, ADR
 *  0097 決定1/3) never escapes to the caller — it quarantines the name in its
 *  place and the caller treats agent resolution as failed for this cycle.
 *  Both ride the one existing agent-name quarantine; no new quarantine kind. */
export function resolveAgentOrQuarantine(
  db: Db,
  resolve: (taskAssignee: string | null) => ResolvedAgent,
  taskAssignee: string | null,
  now: Date,
): ResolvedAgent | undefined {
  try {
    return resolve(taskAssignee);
  } catch (err) {
    if (!isUnresolvableAgentError(err)) throw err;
    quarantineAgent(db, err.agentName, err, now);
    return undefined;
  }
}

/** Quarantine resolution's verification gate for an agent name (CONTEXT.md's
 *  Quarantine, ADR 0012 / issue #36) — never taken on faith. Clearance holds
 *  either the registry has the name back (`agentExists`), or there is no more
 *  unsettled work left depending on it and no completed task awaiting landing
 *  on its profile — both are legitimate repairs (registry repair, or settling /
 *  reassigning those tasks once nothing completed still waits to land), and
 *  either makes the quarantine moot. Unsettled is `unsettledSql` (shared with the
 *  delete door), so a task still running under the name counts too (ADR 0224
 *  決定4). `resolution` is resolved by the caller, fresh against the registry
 *  (`"absent"` when no registry is configured at all — in which case only the
 *  "no more unsettled tasks" path can ever clear it). The built-in never counts
 *  as "back" (ADR 0228 決定4): a name resolving to it is not repaired, and while
 *  it does, only work counts as a dependent. */
export function verifyAgentRepaired(
  db: Db,
  agentName: string,
  resolution: "registry" | "built-in" | "absent",
  defaultAgentName?: string,
  auditorName?: string,
): void {
  if (resolution === "registry") return;
  const fallback = typeAwareDefaultAgentSql("type", "@defaultAgentName", "@auditorName");
  // 名前が組み込みに解決される間、review は組み込みが走らせられるので依存に数えない(ADR 0228 決定4)
  const dependentTypes = resolution === "built-in" ? "type = 'work'" : "type != 'question'";
  const stillUnsettled = db
    .prepare(`SELECT 1 FROM tasks WHERE ${dependentTypes} AND ${unsettledSql("status")}
              AND COALESCE(assignee, ${fallback}) = @agentName LIMIT 1`)
    .get({ agentName, defaultAgentName: defaultAgentName ?? null, auditorName: auditorName ?? null });
  if (stillUnsettled) {
    throw new Error(
      `agent ${agentName} is not back in the registry and still has unsettled tasks assigned`,
    );
  }
  // done のタスクは Edit で付け替えられないので、その profile を読んで着地を待つものが
  // 残る限り、registry を直さずに解除しても次の着地でまた落ちる(ADR 0217 決定4)
  const awaitingLanding = countTasksAwaitingLanding(db, agentName, defaultAgentName, auditorName);
  if (awaitingLanding > 0) {
    throw new Error(
      `agent ${agentName} is not back in the registry and still has ${awaitingLanding} ` +
        "completed task(s) awaiting landing on its profile",
    );
  }
}
