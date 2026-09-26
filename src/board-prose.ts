/** 盤面が書いた文面の正本(ADR 0157 決定3)。中身は Harness を問わず同じで、adapter が差し込むのは
 *  その Harness に実在する機構の名前だけである。 */

import type { Db } from "./db.js";
import { type EventPayload, listEvents } from "./events.js";
import {
  type AgentDefinition,
  type AuthorityProfile,
  agentBodyAtCommit,
  ownEntry,
  REVIEWER_AUTHORITY_PROFILE,
  type Registry,
  type RosterAgent,
} from "./registry.js";
import { AUTHORITY_WILDCARD, HUMAN_ROSTER_AGENT, reviewedTaskExecutor, type Task } from "./tasks.js";

/** doctrine のスロット(ADR 0157 決定3)。スロットは「委譲先の語」と「Workflow 段落の有無」の2つだけ。
 *  `delegateAtLineEnd` は委譲先の語の同じスロットで、行末に掛かる位置の綴りである —— Claude の文面は
 *  バイト単位で不変(#695)で、そこだけ語の途中で折り返している。 */
export interface DoctrineVocabulary {
  delegate: string;
  delegateAtLineEnd: string;
  workflow: boolean;
}

// injected into every spawned session's system prompt (issue #31 / ADR
// 0010), regardless of agent or profile — a board-wide doctrine copied into
// each authority profile would drift, and "Agent tool"/"Workflow tool" are
// vendor vocabulary the adapter translates the board's line into (ADR 0005)
export function boardDoctrine({ delegate, delegateAtLineEnd, workflow }: DoctrineVocabulary): string {
  const Delegate = delegate[0]!.toUpperCase() + delegate.slice(1);
  return `## Board doctrine

Work that needs independent completion criteria, separate authority, its own
risk, or survival across sessions must not be routed to ${delegate} —
that is delegation smuggled past the board. Register that split with the
tidepool MCP's decompose instead.

${Delegate} may only be used for labor-splitting that does not divide
accountability (exploration, parallel research, mechanical edits): you carry
full accountability for its output as the parent task. If another registry
agent's capability is needed, use decompose with an assignee, not ${delegateAtLineEnd}.
${workflow ? `
The Workflow tool is off-limits in task sessions: a workflow script is a
decompose plan that never reached the board. If you find yourself wanting to
write one, register that split with the tidepool MCP's decompose instead.
` : ""}
Board verbs (the tidepool MCP tools) are main-thread only: a subagent's call
is denied by the harness, not by an attacker. If a subagent reports that
denial, make the call yourself from the main thread.`;
}
// ^ the denial this paragraph teaches recovery from is SUBAGENT_BOARD_VERB_DENY
// (src/sandbox.ts) — its "main-thread only" wording, this paragraph, and the
// canary's BOARD_HOOK_WORDING move together.

/** 前提の破綻と自タスク外の発見の2文(ADR 0121)。 */
const PREMISE_BREACH_PROTOCOL =
  "When the premise of the decomposition decision your task rests on turns out to be false, " +
  "declare a premise breach rather than working around it or escalating it. " +
  "A finding outside your task's scope is not your task: record the decision not to act on it " +
  "with `log_decision`, and never decompose it into a child.";

// ADR 0017: the worker protocol (rules of the road for a board worker) is a
// board-wide doctrine, so it lives here and is injected into every session —
// not copied into each agent definition, where it would drift the same way
// the board doctrine would. The MCP tool descriptions already carry each verb's
// semantics, and "call get_current_task first" already rides each adapter's
// task prompt — re-listing either here would just relocate the drift ADR 0017
// removes. The board-language rule lives on the write verbs' own tool
// descriptions, not here (ADR 0015, 2026-08-21 addendum) — a front-loaded
// instruction here was losing to a task's own non-English payload. The
// canonical default agent is therefore an empty-body definition (tako) — it
// carries no specialty prose, and this section supplies the protocol every
// worker shares.
const WORKER_PROTOCOL = `## Rules of the road

Do the work in the current working directory. It is the task's workspace.

The tidepool MCP verbs are your only channel back to the board. Invent no side
channels: no direct edits to the board, no unrecorded decisions. If it is not
in an MCP verb, it did not happen.

Commit your work before completing: \`complete_task\` refuses a dirty tree, and the commit body is where you say what changed and why.

Escalating is never wrong; guessing outside your authority is. When a decision
is outside your authority or you hit a dead end, escalate rather than guess.

${PREMISE_BREACH_PROTOCOL}

This may be a resumed task session: if the task history shows prior-session traces, inspect the task branch with \`git log\` before starting work.`;

function workerProtocol(allowedDomains: string[] | undefined): string {
  const network = allowedDomains?.length
    ? `Network egress is deny-by-default. This session may reach only: ${allowedDomains.join(", ")}. Do not retry downloads from any other domain.`
    : "Network egress is deny-by-default. This session cannot fetch from any external domain. Do not retry external downloads.";
  return `${WORKER_PROTOCOL}\n\n${network}`;
}

/** One roster line's text (issue #43 / ADR 0014): "name — description",
 *  shared by every entry — a registry agent's `AgentDefinition` or the
 *  fixed `HUMAN_ROSTER_AGENT` alike, since both are `RosterAgent`s. */
function rosterLine(agent: RosterAgent): string {
  return `${agent.name} — ${agent.description}`;
}

/** Builds the push half of the roster (issue #43 / ADR 0014): the spawned
 *  agent's own `assignable_to` resolved against the registry into
 *  "name — description" lines, one per direct delegate. Cost is
 *  proportional to the allowlist, not the registry — `*` expands to every
 *  registry agent (an author's deliberate cost/permission tradeoff), and
 *  `human` (never a registry agent) draws `HUMAN_ROSTER_AGENT` only when
 *  explicitly listed. Absent/empty `assignable_to` → undefined (nothing to
 *  push). Names drifted out of the registry are silently skipped, same
 *  fail-closed spirit as the rest of this file's registry-drift handling. */
function buildRoster(registry: Registry, assignableTo: string[] | undefined): string | undefined {
  if (assignableTo === undefined || assignableTo.length === 0) return undefined;
  const wildcard = assignableTo.includes(AUTHORITY_WILDCARD);
  const explicitNames = assignableTo.filter((name) => name !== AUTHORITY_WILDCARD);
  const agentNames = wildcard ? Object.keys(registry.agents) : explicitNames;
  const agents: RosterAgent[] = agentNames
    .map((name) => ownEntry(registry.agents, name))
    .filter((agent): agent is AgentDefinition => agent !== undefined);
  if (explicitNames.includes(HUMAN_ROSTER_AGENT.name)) agents.push(HUMAN_ROSTER_AGENT);
  return agents.length > 0 ? agents.map(rosterLine).join("\n") : undefined;
}

/** Wraps a built roster (or nothing) as the trailing `## Roster` section of
 *  the system prompt — its own heading (CONTEXT.md's Roster term) rather
 *  than folded into `## Authority`, since it names delegates, not authority. */
function rosterSection(roster: string | undefined): string {
  return roster === undefined ? "" : `\n\n## Roster\n\n${roster}`;
}

/** Wraps authority guidance as the `## Authority` section, or omits the
 *  section entirely when guidance is empty (issue #488: `standard`'s
 *  template guidance is `""`, and an empty heading would be a lie with
 *  nothing under it). */
function authoritySection(guidance: string): string {
  return guidance === "" ? "" : `\n\n## Authority\n\n${guidance}`;
}

/** "entry #3" / "entries #3, #5" — decision-log event ids, the same id space
 *  the RCA reads via get_current_task's parent decision_log (issue #87). */
function entryLabels(ids: number[]): string {
  return `${ids.length === 1 ? "entry" : "entries"} ${ids.map((id) => `#${id}`).join(", ")}`;
}


/** ADR 0020 part 4: a party review (self RCA) is a review task with a
 *  concrete assignee — the historical worker, baked as a fact (CONTEXT.md's
 *  Review: "self = 確定値") — hanging off the objected task (parent). Its
 *  evidence is the agent definition as it stood *when each objected decision
 *  was made*: 当時版 is resolved per objected log entry (issue #87) — the
 *  `worker_spawned` session (the strict agent version, ADR 0001) that was
 *  live when that entry was written, read from the committed registry at its
 *  hash. Anchoring on the entries — not simply the latest spawn — keeps a
 *  later escalation-return re-spawn under a refined definition from being
 *  mistaken for the 当時版; resolving per entry — not folding to one anchor —
 *  keeps judgments that span sessions under different versions from being
 *  read against a definition that never shaped them. Entries all resolving
 *  to one version (the common case) produce the original single section,
 *  byte for byte; distinct versions are each injected, labeled with the
 *  decision-log entry ids they were live for (the same id space the RCA
 *  reads via get_current_task's parent decision_log). Independent reviews
 *  (unset assignee → the Auditor pointer, issue #42) get no such injection:
 *  their value is distance from the judgment, not the 原本. Best-effort — an
 *  entry whose version cannot be resolved (a kill left no record, an
 *  unreachable commit) is declared as an evidence gap when other versions
 *  did resolve, and degrades to no section at all when none did (no claim
 *  made, nothing to declare) — never a failed spawn. The review still
 *  executes under the current definition (ADR 0019): this only adds
 *  evidence, not the reviewer's identity. */
function historicalDefinitionSection(db: Db, registryDir: string, task: Task): string {
  if (task.type !== "review" || task.assignee === null || task.parent_id === null) return "";
  const events = listEvents(db, task.parent_id);
  const byId = new Map(events.map((e) => [e.id, e]));
  // the objected log entries this worker wrote (each objection_raised annotates
  // one entry on this same task), earliest first
  const objectedEntryIds = [
    ...new Set(
      events
        .filter((e) => e.kind === "objection_raised")
        .map((e) => (e.payload as Extract<EventPayload, { kind: "objection_raised" }>).entry_id)
        .filter((entryId) => byId.get(entryId)?.worker_id === task.assignee),
    ),
  ].sort((a, b) => a - b);
  // per entry: the spawn live when it was written — the latest worker_spawned
  // by this worker at or before the entry. Map insertion order is
  // chronological because the entries are.
  const byCommit = new Map<string, number[]>();
  const unresolved: number[] = [];
  for (const entryId of objectedEntryIds) {
    const spawned = events
      .filter(
        (e) => e.kind === "worker_spawned" && e.worker_id === task.assignee && e.id <= entryId,
      )
      .at(-1);
    if (!spawned) {
      unresolved.push(entryId);
      continue;
    }
    const { registry_commit } = spawned.payload as Extract<
      EventPayload,
      { kind: "worker_spawned" }
    >;
    byCommit.set(registry_commit, [...(byCommit.get(registry_commit) ?? []), entryId]);
  }
  const resolved: Array<{ commit: string; entryIds: number[]; body: string }> = [];
  for (const [commit, entryIds] of byCommit) {
    const body = agentBodyAtCommit(registryDir, commit, task.assignee);
    if (body === undefined) unresolved.push(...entryIds);
    else resolved.push({ commit, entryIds, body });
  }
  if (resolved.length === 0) return "";
  if (resolved.length === 1 && unresolved.length === 0) {
    return (
      "\n\n## Definition under review (as it stood when you ran the objected task)\n\n" +
      "This is your agent definition recorded at the commit you were spawned from — " +
      "the version that shaped the decision now under review. Read it as evidence for " +
      '"why did I make that call". You nonetheless carry out this review under your ' +
      "current definition (ADR 0019: repair is not a re-enactment).\n\n---\n\n" +
      resolved[0]!.body
    );
  }
  // no-spawn entries and unreachable-commit entries land in two phases above,
  // so their interleaving can drift from entry order — restore it once here
  unresolved.sort((a, b) => a - b);
  const gap =
    unresolved.length === 0
      ? ""
      : "\n\nNote: no definition version could be resolved for your objected " +
        `${entryLabels(unresolved)} (missing session record or ` +
        "unreachable commit) — the evidence above is incomplete for those judgments.";
  return (
    "\n\n## Definitions under review (as they stood when you made each objected decision)\n\n" +
    "These are your agent definition bodies recorded at the commits you were spawned " +
    "from, resolved per objected decision-log entry — each version below is the one " +
    "that was live when you wrote the entries it is labeled with. Read them as evidence " +
    'for "why did I make that call". You nonetheless carry out this review under your ' +
    "current definition (ADR 0019: repair is not a re-enactment)." +
    resolved
      .map(
        ({ commit, entryIds, body }) =>
          `\n\n### As of registry commit ${commit.slice(0, 7)} — live for your objected ` +
          `${entryLabels(entryIds)}\n\n---\n\n${body}`,
      )
      .join("") +
    gap
  );
}

/** 盤面が書いた文面の全体(ADR 0157 決定1)。節の順序は Harness を問わず
 *  定義本文 → authority → roster → doctrine → protocol → 当時版 → Memory。
 *  doctrine は adapter が自分の語彙で組んで渡す(決定2)。review task は registry の
 *  profile でなく reviewer の authority と、被レビュー task の executor 1名の roster を
 *  持つ(ADR 0056)。当事者レビュー(self RCA)は当時版の定義を証拠として持つ(ADR 0020 part 4)。 */
export function boardProse(input: {
  db: Db;
  registryDir: string;
  registry: Registry;
  task: Task;
  systemPrompt: string;
  profile: AuthorityProfile;
  doctrine: string;
  allowedDomains: string[] | undefined;
  memorySection: string | null;
}): string {
  const { db, task } = input;
  const authorityProfile = task.type === "review" ? REVIEWER_AUTHORITY_PROFILE : input.profile;
  const reviewExecutor = task.type === "review" ? reviewedTaskExecutor(db, task) : undefined;
  const rosterAssignableTo =
    task.type === "review" && reviewExecutor !== undefined
      ? [reviewExecutor]
      : authorityProfile.assignable_to;
  return `${input.systemPrompt}${authoritySection(authorityProfile.guidance)}${rosterSection(buildRoster(input.registry, rosterAssignableTo))}\n\n${input.doctrine}\n\n${workerProtocol(input.allowedDomains)}${historicalDefinitionSection(db, input.registryDir, task)}${input.memorySection ? `\n\n${input.memorySection}` : ""}`;
}
