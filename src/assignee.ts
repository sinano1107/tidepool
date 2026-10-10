import { DomainError } from "./domain-error.js";
import type { TaskType } from "./tasks.js";
import { whyAssigneeCannotTake } from "./webui-rules.js";
import { HUMAN_WORKER_ID } from "./worker-id.js";

export interface AssigneeDeps {
  agentRegistered?: (name: string) => boolean;
  resolvesToBuiltIn?: (name: string) => boolean;
}

/** 人間の登録・Edit、worker の decompose、triage の修理子が共有する assignee の門。組み込みは review 専用で、
 *  判定は名前ではなく解決の結果を見る —— shadow している間は通る(ADR 0228 決定1)。 */
export function assertAssigneeCanTake(
  deps: AssigneeDeps,
  assignee: string | undefined,
  type: TaskType,
): void {
  if (assignee === undefined || assignee === HUMAN_WORKER_ID) return;
  if (deps.agentRegistered && !deps.agentRegistered(assignee)) {
    throw new DomainError(`unknown agent: ${assignee}`);
  }
  const reason = whyAssigneeCannotTake(assignee, type, deps.resolvesToBuiltIn?.(assignee) === true);
  if (reason) throw new DomainError(reason);
}
