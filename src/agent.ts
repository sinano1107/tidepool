import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import {
  type AgentDefinition,
  type AuthorityProfile,
  assertValidProvider,
  InvalidAgentProviderError,
  ownEntry,
  type Registry,
} from "./registry.js";
import { BOARD_WORKER_ID, registerTask } from "./tasks.js";

/** An assignee (or the board's default) resolved against the registry —
 *  the agent's own definition and its authority profile together, since spawn
 *  needs both in the same moment (claude-worker.ts). Mirrors
 *  workspace.ts's WorkspaceConfig. */
export interface ResolvedAgent {
  name: string;
  definition: AgentDefinition;
  profile: AuthorityProfile;
}

/** A task's `assignee` (or the board's default agent name) names an agent
 *  absent from the registry — the agent-name generalization of
 *  UnknownWorkspaceError (ADR 0012 / issue #36). */
export class UnknownAgentError extends Error {
  constructor(public readonly agentName: string) {
    super(`unknown agent: ${agentName}`);
  }
}

/** CONTEXT.md's Assignee: `task.assignee` is a reference to a registry agent
 *  name, resolved fresh against the registry every time it's used (spawn,
 *  quarantine clearance) — null inherits the board's default agent, never
 *  pinned. Mirrors workspace.ts's resolveExecutionWorkspace.
 *
 *  Resolution also re-runs the provider gates (ADR 0097 決定1/3): a
 *  definition whose provider is outside the enumeration, or that combines an
 *  advisor with a provider that doesn't offer one, is a broken resource,
 *  not a spawnable agent — InvalidAgentProviderError, which the pickup path
 *  (resolveAgentOrQuarantine) fails closed into the same agent-name
 *  quarantine as registry drift. The loader deliberately does not reject
 *  these (a violating file still parses) so the violation stops the one
 *  agent instead of the whole registry read. */
export function resolveExecutionAgent(
  registry: Registry,
  defaultAgentName: string,
  taskAssignee: string | null,
): ResolvedAgent {
  const name = taskAssignee ?? defaultAgentName;
  const definition = ownEntry(registry.agents, name);
  if (!definition) throw new UnknownAgentError(name);
  assertValidProvider(name, definition.provider, definition.advisor);
  const profile = ownEntry(registry.authority, definition.authority);
  if (!profile) throw new Error(`unknown authority profile: ${definition.authority}`);
  return { name, definition, profile };
}

export function agentNeedsHuman(db: Db, name: string): boolean {
  const row = db.prepare("SELECT needs_human FROM agent_state WHERE name = ?").get(name) as
    | { needs_human: number }
    | undefined;
  return row?.needs_human === 1;
}

/** The agent-name generalization of workspace.ts's quarantineWorkspace (ADR
 *  0012 / issue #36): mark the agent name needs-human (its tasks stay out of
 *  the slot) and put the repair in front of the human as a 1-choice
 *  Confirmation question — same shape, same "1 resource, at most 1 open
 *  question" dedup (CONTEXT.md's Quarantine). */
export function quarantineAgent(db: Db, agentName: string, cause: unknown, now: Date): void {
  db.prepare(
    `INSERT INTO agent_state (name, needs_human) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET needs_human = 1`,
  ).run(agentName);
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  const existing = db
    .prepare(`SELECT id FROM tasks WHERE question_quarantine_agent = ? AND status = 'todo'`)
    .get(agentName) as { id: string } | undefined;
  if (existing) {
    appendEvent(db, {
      taskId: existing.id,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "quarantine_refired", cause: causeMessage },
      at: now,
    });
    return;
  }
  const title = `agent ${agentName} needs human attention`;
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose:
        `${causeMessage}. ` +
        "Tasks assigned to this agent stay out of the slot until it is repaired. " +
        "Answering confirms the repair — the board verifies before it resumes " +
        "pickup; any answer text is kept as a repair note.",
      completion_criteria: "the agent is repaired by hand",
      question: [{ title, options: ["repaired by hand"], recommendation: "repaired by hand" }],
      quarantine_agent: agentName,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

/** The agent-name generalization of workspace.ts's resolveOrQuarantine (ADR
 *  0012 / issue #36): `resolve` throwing `UnknownAgentError` (registry drift)
 *  or `InvalidAgentProviderError` (a definition that no longer stands, ADR
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
    if (!(err instanceof UnknownAgentError) && !(err instanceof InvalidAgentProviderError)) {
      throw err;
    }
    quarantineAgent(db, err.agentName, err, now);
    return undefined;
  }
}

/** Quarantine resolution's verification gate for an agent name (CONTEXT.md's
 *  Quarantine, ADR 0012 / issue #36) — never taken on faith. Clearance holds
 *  either the registry has the name back (`agentExists`), or there is no more
 *  todo work left depending on it — both are legitimate repairs (registry
 *  repair, or reassigning the pending tasks away), and either makes the
 *  quarantine moot. `agentExists` is resolved by the caller (fresh against
 *  the registry, or `false` when no registry is configured at all — in which
 *  case only the "no more pending tasks" path can ever clear it). */
export function verifyAgentRepaired(db: Db, agentName: string, agentExists: boolean): void {
  if (agentExists) return;
  const stillPending = db
    .prepare("SELECT 1 FROM tasks WHERE assignee = ? AND status = 'todo' LIMIT 1")
    .get(agentName);
  if (stillPending) {
    throw new Error(
      `agent ${agentName} is not back in the registry and still has pending tasks assigned`,
    );
  }
}
