/** 盤面が書いた文面の正本(ADR 0157 決定3)。中身は Harness を問わず同じで、adapter が差し込むのは
 *  その Harness に実在する機構の名前だけである。 */

import type { Db } from "./db.js";
import { type EventPayload, type EventRow, listEvents } from "./events.js";
import {
  type AgentAtCommit,
  type AgentDefinition,
  type AuthorityProfile,
  builtInBodyAt,
  ownEntry,
  REVIEWER_AUTHORITY_PROFILE,
  type Registry,
  type RegistryAtCommit,
  type RosterAgent,
  registryAtCommit,
} from "./registry.js";
import {
  AUTHORITY_WILDCARD,
  getTask,
  HUMAN_ROSTER_AGENT,
  isRepairType,
  REPAIR_NOTICES,
  reviewedTaskExecutor,
  type Task,
  type TaskVerbSwap,
  whyNoReturnDestination,
} from "./tasks.js";

/** doctrine の Harness の語のスロット(ADR 0157 決定3)。「委譲先の語」と「Workflow 段落の有無」の2つだけ。
 *  task ごとに変わるのは別の引数 `verbs`(task ごとの verb の差し替え —— ADR 0245 決定2 / ADR 0253 決定5)で、Harness の語ではない。 */
interface DoctrineVocabulary {
  delegate: string;
  workflow: boolean;
}

const NOT_SPLIT = `This task is not split: complete it in this session. If it is
larger than one session can finish, finish what you can and state in the
handoff what remains.`;

const POSE_PROBE = `This task is not split by you: pose its probe with the tidepool
MCP's pose_probe instead, and once its audit accepts the probe the board
registers one child per target.`;

/** Interview の root の session すべてに盤面が運ぶ規律(ADR 0275 決定3 / ADR 0017・0180 の線): session を通して守るものだけ。
 *  verb を呼ぶ瞬間に要るもの(採点)は complete_interview の説明が持つ。agent の本文によらない —— 人間が root に名指した
 *  別の agent にも届く(ADR 0269 決定2)。doctrine には入れない(ADR 0247 決定3: doctrine は Interview と書かない)。 */
const INTERVIEW_DISCIPLINE = `## Interview discipline

Composing the environment:
- Compose the environment in your working directory, the interview room, not in the real environment you read: an anonymised reproduction of the work the probe needs, not a copy of the real environment. Each target solves the probe in its own fresh checkout of the room as it stands when you pose the probe.
- Put in exactly what the probe needs and nothing more: no board vocabulary, no file that describes the board or how it works, and no name that points at the real environment. A target that can tell it is being measured, or that leans on material the probe does not need, measures the environment, not the target.
- Do not list in .gitignore anything you want the targets to have: ignored files never reach their environment.

Writing the probe and rubric:
- Aim at the tier's quality bar. A probe every target passes, or every target fails, measures nothing; pick work whose outcome separates a target that meets the bar from one that does not.
- Make the probe self-contained in the environment you composed. A target that fails because the probe was ambiguous measures the probe, not the target.
- Write the rubric as observable criteria: what a passing answer does, what a failing one does, which shortfalls disqualify and which are minor. Prefer checks a second scorer would apply the same way.`;

// injected into every spawned session's system prompt (issue #31 / ADR
// 0010), regardless of agent or profile — a board-wide doctrine copied into
// each authority profile would drift, and "Agent tool"/"Workflow tool" are
// vendor vocabulary the adapter translates the board's line into (ADR 0005).
// decompose を伏せた task は decompose を指す文を差し替える: 出題の verb を足した task(出題前の Interview の root)は出題を指し、
// それ以外(Interview の pin の子と出題済みの root —— ADR 0245 決定2 / ADR 0247 決定3)は 1 session で完了せよと言う。後者は
// Interview であることを書かない
export function boardDoctrine({ delegate, workflow }: DoctrineVocabulary, verbs: TaskVerbSwap): string {
  const split = !verbs.withheld.includes("decompose");
  const delegateAtSentenceStart = delegate[0]!.toUpperCase() + delegate.slice(1);
  // Claude の文面はバイト単位で不変(#695)で、2段落目の末尾だけ委譲先の語の最後の空白で折り返している
  const delegateAtLineEnd = delegate.replace(/ (?=\S+$)/, "\n");
  return `## Board doctrine

Work that needs independent completion criteria, separate authority, its own
risk, or survival across sessions must not be routed to ${delegate} —
that is delegation smuggled past the board. ${split ? `Register that split with the
tidepool MCP's decompose instead.` : verbs.added.includes("pose_probe") && !verbs.probeAccepted ? POSE_PROBE : NOT_SPLIT}

${delegateAtSentenceStart} may only be used for labor-splitting that does not divide
accountability (exploration, parallel research, mechanical edits): you carry
full accountability for its output as the parent task.${split ? ` If another registry
agent's capability is needed, use decompose with an assignee, not ${delegateAtLineEnd}.` : ""}
${workflow ? `
The Workflow tool is off-limits in task sessions: a workflow script is a
${split ? "decompose plan" : "delegation"} that never reached the board.${split ? ` If you find yourself wanting to
write one, register that split with the tidepool MCP's decompose instead.` : ""}
` : ""}
Board verbs (the tidepool MCP tools) are main-thread only: a subagent's call
is denied by the harness, not by an attacker. If a subagent reports that
denial, make the call yourself from the main thread.`;
}
// ^ the denial this paragraph teaches recovery from is SUBAGENT_BOARD_VERB_DENY
// (src/sandbox.ts) — its "main-thread only" wording, this paragraph, and the
// canary's BOARD_HOOK_WORDING move together.

/** 前提の破綻の宣言の1文 —— その verb を伏せた task(修理子の type、ADR 0272 決定3 / ADR 0279 決定4)の文面からは落とす。 */
const PREMISE_BREACH_SENTENCE =
  "When the premise of the decomposition decision your task rests on turns out to be false, " +
  "declare a premise breach rather than working around it or escalating it. ";

/** 自タスク外の発見の1文(ADR 0121)。前提の破綻の1文と並べて置く。 */
const OUTSIDE_SCOPE_SENTENCE =
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
const workerProtocolText = (premiseBreach: boolean) => `## Rules of the road

Do the work in the current working directory. It is the task's workspace.

The tidepool MCP verbs are your only channel back to the board. Invent no side
channels: no direct edits to the board, no unrecorded decisions. If it is not
in an MCP verb, it did not happen.

Commit your work before completing: \`complete_task\` refuses a dirty tree, and the commit body is where you say what changed and why.

Escalating is never wrong; guessing outside your authority is. When a decision
is outside your authority or you hit a dead end, escalate rather than guess.

${premiseBreach ? PREMISE_BREACH_SENTENCE : ""}${OUTSIDE_SCOPE_SENTENCE}

This may be a resumed task session: if the task history shows prior-session traces, inspect the task branch with \`git log\` before starting work.`;

function workerProtocol(allowedDomains: string[] | undefined, verbs: TaskVerbSwap): string {
  const protocol = workerProtocolText(!verbs.withheld.includes("declare_premise_breach"));
  const network = allowedDomains?.length
    ? `Network egress is deny-by-default. This session may reach only: ${allowedDomains.join(", ")}. Do not retry downloads from any other domain.`
    : "Network egress is deny-by-default. This session cannot fetch from any external domain. Do not retry external downloads.";
  return `${protocol}\n\n${network}`;
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
 *  fail-closed spirit as the adapters' registry-drift handling — and so are
 *  names resolving to the built-in agent, which never runs delegated work
 *  (ADR 0235; a shadowing entry is an ordinary agent and stays). */
function buildRoster(
  registryAgents: Record<string, RosterAgent & { builtin?: true }>,
  assignableTo: string[] | undefined,
): string | undefined {
  const agents = rosterAgents(registryAgents, assignableTo);
  return agents.length > 0 ? agents.map(rosterLine).join("\n") : undefined;
}

/** The roster's agents, before they become lines (see `buildRoster`). */
function rosterAgents(
  registryAgents: Record<string, RosterAgent & { builtin?: true }>,
  assignableTo: string[] | undefined,
): RosterAgent[] {
  if (assignableTo === undefined || assignableTo.length === 0) return [];
  const wildcard = assignableTo.includes(AUTHORITY_WILDCARD);
  const explicitNames = assignableTo.filter((name) => name !== AUTHORITY_WILDCARD);
  const agentNames = wildcard ? Object.keys(registryAgents) : explicitNames;
  const agents: RosterAgent[] = agentNames
    .map((name) => ownEntry(registryAgents, name))
    .filter((agent): agent is RosterAgent => agent !== undefined && agent.builtin !== true);
  if (explicitNames.includes(HUMAN_ROSTER_AGENT.name)) agents.push(HUMAN_ROSTER_AGENT);
  return agents;
}

/** Wraps a built roster (or nothing) as a Roster section — by default the
 *  trailing `## Roster` of the system prompt, or the 当時版's nested `heading` —
 *  its own heading (CONTEXT.md's Roster term) rather
 *  than folded into `## Authority`, since it names delegates, not authority. */
function rosterSection(roster: string | undefined, heading = "## Roster"): string {
  return roster === undefined ? "" : `\n\n${heading}\n\n${roster}`;
}

/** Wraps authority guidance as an Authority section (`## Authority` unless the
 *  当時版 passes its nested `heading`), or omits the
 *  section entirely when guidance is empty (issue #488: `standard`'s
 *  template guidance is `""`, and an empty heading would be a lie with
 *  nothing under it). */
function authoritySection(guidance: string, heading = "## Authority"): string {
  return guidance === "" ? "" : `\n\n${heading}\n\n${guidance}`;
}

/** A review's roster (ADR 0056): the reviewed task's executor as of the session's
 *  spawn `spawnedEventId` (ADR 0295), the one name its repairs may always target. */
function reviewAssignableTo(db: Db, review: Task, spawnedEventId: number): string[] {
  const executor = reviewedTaskExecutor(db, review, spawnedEventId);
  return executor !== undefined ? [executor] : (REVIEWER_AUTHORITY_PROFILE.assignable_to ?? []);
}

/** One 当時版 version's evidence (ADR 0020 part 4, #1741 addendum): the body,
 *  then the Authority and Roster sections that spawn rendered, rebuilt from the
 *  registry at that commit under `level` headings nested in the 当時版 section.
 *  The objected task's type and lineage at that spawn pick the branch, shared with spawn (`guidanceByType`):
 *  a review's / interview's Authority was the reviewer constant — pointed at rather than repeated when the
 *  RCA's own Authority is that same text (`ownAuthorityIsReviewer`), rendered otherwise — or nothing at all where its
 *  lineage had no return destination then (ADR 0301 決定5). */
function versionEvidence(
  db: Db,
  level: string,
  assignee: string,
  agent: AgentAtCommit & { body: string },
  registry: RegistryAtCommit,
  objected: Task,
  spawnedEventId: number,
  ownAuthorityIsReviewer: boolean,
): string {
  const body =
    agent.builtin && agent.body === ""
      ? `You ran then as the board's built-in ${assignee}, whose definition lives in board code, not the registry; its body was empty at that version.`
      : agent.body;
  const profile = agent.authority === undefined ? undefined : ownEntry(registry.authority, agent.authority);
  const then = guidanceByType(db, objected, profile, spawnedEventId);
  if (then === undefined) {
    const missing =
      agent.authority === undefined
        ? "your definition named no readable authority profile"
        : `the authority profile ${agent.authority} could not be read`;
    return (
      `${body}\n\nNote: ${missing} at that commit — ` +
      "the Authority and Roster you were given then are missing from this evidence."
    );
  }
  if (then.source === "none") return `${body}\n\nYou were given no Authority section and no Roster section then.`;
  const { label, guidance } = {
    profile: { label: `profile ${agent.authority}`, guidance: then.guidance },
    repair: { label: "the board's repair notice", guidance: then.guidance },
    reviewer: {
      label: "the board's reviewer authority",
      guidance:
        (ownAuthorityIsReviewer ? "The board's fixed reviewer authority — the same text as your own `## Authority` above. " : `${then.guidance}\n\nThis is the board's fixed reviewer authority. `) +
        "It is board code, not a registry profile, so it is not a target for a registry diff.",
    },
  }[then.source];
  return (
    body +
    authoritySection(guidance, `${level} Authority as it stood then (${label})`) +
    rosterSection(buildRoster(rosterSourceAt(registry), then.rosterAssignableTo), `${level} Roster as it stood then (${label})`)
  );
}

/** The 当時版 Roster's source: the registry's agents at that commit. A name whose description is
 *  unreadable stays listed: dropping it would read as "not in your roster". */
function rosterSourceAt(registry: RegistryAtCommit): Record<string, RosterAgent> {
  return Object.fromEntries(
    Object.entries(registry.agents).map(([name, { description }]) => [
      name,
      { name, description: description ?? "(description could not be read at that commit)" },
    ]),
  );
}

/** One 当時版 version (ADR 0020 part 4): the registry at the spawn's commit and the agent's entry in it —
 *  a built-in's body is not in the registry commit and is read by the recorded content hash from the
 *  board's history (ADR 0270 決定3). undefined when the commit is unreachable, the agent is absent, or
 *  its body cannot be read. */
function versionAt(
  registryDir: string,
  assignee: string,
  commit: string,
  version: string,
): { agent: AgentAtCommit & { body: string }; registry: RegistryAtCommit } | undefined {
  const registry = registryAtCommit(registryDir, commit);
  const atCommit = registry && ownEntry(registry.agents, assignee);
  const body = atCommit?.builtin ? builtInBodyAt(assignee, version) : atCommit?.body;
  return registry && atCommit && body !== undefined ? { agent: { ...atCommit, body }, registry } : undefined;
}

/** 帰責の judge に渡す当時版の束(ADR 0291 決定1・2): self RCA の注入と同じ読み口で spawn の (registry_commit,
 *  definition_version) から引く本文と、spawn が描いた Authority の散文・Roster の行(session の task の type と spawn の時点の系譜で
 *  選ぶ —— spawn と同じ `guidanceByType`。帰り先の無い系譜では空。profile はその commit のもの)、それに組み込みかどうか。 */
export interface AgentDefinitionThen {
  registry_commit: string;
  builtin: boolean;
  body: string;
  authority: { guidance: string; assignable_to: string[] };
  roster: RosterAgent[];
}

/** `spawned` の session の当時版の束。本文か、要る profile が引けなければ null。 */
export function agentDefinitionThen(db: Db, registryDir: string, spawned: EventRow): AgentDefinitionThen | null {
  const { registry_commit, definition_version } = spawned.payload as Extract<EventPayload, { kind: "worker_spawned" }>;
  const at = versionAt(registryDir, spawned.actor_id, registry_commit, definition_version);
  if (!at) return null;
  const profile = at.agent.authority === undefined ? undefined : ownEntry(at.registry.authority, at.agent.authority);
  const then = guidanceByType(db, getTask(db, spawned.task_id!)!, profile, spawned.id);
  if (!then) return null;
  const assignable_to = then.rosterAssignableTo ?? [];
  return {
    registry_commit,
    builtin: at.agent.builtin === true,
    body: at.agent.body,
    authority: { guidance: then.guidance, assignable_to },
    roster: rosterAgents(rosterSourceAt(at.registry), assignable_to),
  };
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
 *  to one version (the common case) produce a single section; distinct
 *  versions are each injected, labeled with the decision-log entry ids they
 *  were live for (the same id space the RCA reads via get_current_task's
 *  parent decision_log), never the hash the RCA has no way to read. Each
 *  version carries the Authority and Roster that spawn rendered (#1741
 *  addendum). Independent reviews
 *  (unset assignee → the Auditor pointer, issue #42) get no such injection:
 *  their value is distance from the judgment, not the 原本. Best-effort — an
 *  entry whose version cannot be resolved (a kill left no record, an
 *  unreachable commit) is declared as an evidence gap when other versions
 *  did resolve, and degrades to no section at all when none did (no claim
 *  made, nothing to declare) — never a failed spawn. The review still
 *  executes under the current definition (ADR 0019): this only adds
 *  evidence, not the reviewer's identity. */
function historicalDefinitionSection(db: Db, registryDir: string, task: Task, ownAuthorityIsReviewer: boolean): string {
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
        .filter((entryId) => byId.get(entryId)?.actor_id === task.assignee),
    ),
  ].sort((a, b) => a - b);
  // per entry: the spawn live when it was written — the latest worker_spawned
  // by this worker at or before the entry. Map insertion order is
  // chronological because the entries are. 束ねの鍵は (registry_commit, definition_version)
  // —— 同じ commit でも盤面だけが更新された組み込みの spawn は別の版(ADR 0270 決定3)
  const byVersion = new Map<string, Array<{ entryId: number; spawnedEventId: number }>>();
  const unresolved: number[] = [];
  for (const entryId of objectedEntryIds) {
    const spawned = events
      .filter(
        (e) => e.kind === "worker_spawned" && e.actor_id === task.assignee && e.id <= entryId,
      )
      .at(-1);
    if (!spawned) {
      unresolved.push(entryId);
      continue;
    }
    const { registry_commit, definition_version } = spawned.payload as Extract<
      EventPayload,
      { kind: "worker_spawned" }
    >;
    const key = JSON.stringify([registry_commit, definition_version]);
    byVersion.set(key, [...(byVersion.get(key) ?? []), { entryId, spawnedEventId: spawned.id }]);
  }
  const objected = getTask(db, task.parent_id)!;
  type Version = { spawnedEventId: number } & NonNullable<ReturnType<typeof versionAt>>;
  const evidence = (level: string, { agent, registry, spawnedEventId }: Version) =>
    versionEvidence(db, level, task.assignee!, agent, registry, objected, spawnedEventId, ownAuthorityIsReviewer);
  // 同じ版でも spawn ごとに Roster が違いうる(Executor は spawn の時点で読む —— ADR 0295)ので、版の中では
  // 各 spawn で描いた証拠が同じ entry だけを1節に畳む(ADR 0270 追記)
  const drawn = new Map<string, { entryIds: number[] } & Version>();
  for (const [key, entries] of byVersion) {
    const [commit, version]: [string, string] = JSON.parse(key);
    const at = versionAt(registryDir, task.assignee, commit, version);
    if (at === undefined) {
      unresolved.push(...entries.map((entry) => entry.entryId));
      continue;
    }
    for (const { entryId, spawnedEventId } of entries) {
      const drawnKey = JSON.stringify([key, evidence("####", { ...at, spawnedEventId })]);
      const bundle = drawn.get(drawnKey);
      if (bundle) bundle.entryIds.push(entryId);
      else drawn.set(drawnKey, { entryIds: [entryId], spawnedEventId, ...at });
    }
  }
  const resolved = [...drawn.values()].sort((a, b) => a.entryIds[0]! - b.entryIds[0]!);
  if (resolved.length === 0) return "";
  // 「current definition」の括弧は ADR 0019(修理は再演ではない)
  if (resolved.length === 1 && unresolved.length === 0) {
    return (
      "\n\n## Definition under review (as it stood when you ran the objected task)\n\n" +
      `This is your agent definition ${
        resolved[0]!.agent.builtin
          ? "as the board's code carried it at the version you were spawned under"
          : "recorded at the commit you were spawned from"
      }, with the ` +
      "Authority and Roster it gave you, if any — " +
      "the version that shaped the decision now under review. Read it as evidence for " +
      '"why did I make that call". You nonetheless carry out this review under your ' +
      "current definition (repair is not a re-enactment).\n\n---\n\n" +
      evidence("###", resolved[0]!)
    );
  }
  // no-spawn entries and unreachable-commit entries land in two phases above,
  // so their interleaving can drift from entry order — restore it once here
  unresolved.sort((a, b) => a - b);
  const gap =
    unresolved.length === 0
      ? ""
      : "\n\nNote: no definition version could be resolved for your objected " +
        `${entryLabels(unresolved)} (missing session record, unreachable commit, ` +
        "or a built-in version this board does not know) — the evidence above is incomplete for those judgments.";
  return (
    "\n\n## Definitions under review (as they stood when you made each objected decision)\n\n" +
    "These are your agent definition bodies recorded at the commits you were spawned " +
    `from${resolved.some((entry) => entry.agent.builtin) ? " (for a board built-in, as the board's code carried it at the version you were spawned under)" : ""}, ` +
    "each with the Authority and Roster it gave you, if any, resolved per objected " +
    "decision-log entry — each version below is the one " +
    "that was live when you wrote the entries it is labeled with. Read them as evidence " +
    'for "why did I make that call". You nonetheless carry out this review under your ' +
    "current definition (repair is not a re-enactment)." +
    resolved
      .map(
        (version) =>
          `\n\n### Live for your objected ${entryLabels(version.entryIds)}\n\n---\n\n${evidence("####", version)}`,
      )
      .join("") +
    gap
  );
}

/** Authority 節の本文と Roster の元を type で選ぶ。spawn・帰責の当時版・self RCA の当時版が共有する唯一の分岐で、`source` は
 *  当時版の見出しが名指す文の出所。修理子の type は REPAIR_NOTICES の1行だけで roster を持たない(ADR 0272 追記3 / ADR 0279 決定4)。
 *  review / interview は reviewer の guidance で、roster は review なら Executor 1名(ADR 0056)、interview は空
 *  (`reviewedTaskExecutor` は review にしか引かない)—— ただし帰り先の無い系譜では Authority 節も Roster 節も持たない(`none`、
 *  ADR 0301 決定5)。系譜は `spawnedEventId` の時点で読む(cancel は途中で届く)。profile を読むのは修理子の type でも
 *  review / interview でもない task だけで、そこで profile が無ければ undefined。 */
function guidanceByType(
  db: Db,
  task: Task,
  profile: Pick<AuthorityProfile, "guidance" | "assignable_to"> | undefined,
  /** Roster を描いた session の spawn —— review の Executor と系譜の時点(ADR 0295 決定3 / ADR 0301 決定5)。 */
  spawnedEventId: number,
): { source: "repair" | "reviewer" | "none" | "profile"; guidance: string; rosterAssignableTo: string[] | undefined } | undefined {
  if (isRepairType(task.type)) return { source: "repair", guidance: REPAIR_NOTICES[task.type], rosterAssignableTo: undefined };
  if (task.type === "review" || task.type === "interview")
    return whyNoReturnDestination(db, task.id, spawnedEventId) === undefined
      ? { source: "reviewer", guidance: REVIEWER_AUTHORITY_PROFILE.guidance, rosterAssignableTo: reviewAssignableTo(db, task, spawnedEventId) }
      : { source: "none", guidance: "", rosterAssignableTo: undefined };
  return profile && { source: "profile", guidance: profile.guidance, rosterAssignableTo: profile.assignable_to };
}

/** 盤面が書いた文面の持ち主つきの部分(ADR 0313 決定2)。`text` は自分の区切り(先頭の空行や見出し)を含み、順に空文字で
 *  連結した値が harness へ渡す値になる。`definition` は誰の・どの版の本文かを `worker_spawned` と同じ値で添える。 */
export type PromptPart =
  | { part: "definition"; text: string; builtin: boolean; registry_commit: string; definition_version: string }
  | {
      part: "authority" | "roster" | "doctrine" | "interview_discipline" | "protocol" | "historical_definition" | "memory" | "meta_review_material";
      text: string;
    };

/** 盤面が書いた文面の全体(ADR 0157 決定1)を持ち主つきの部分の列で返す(ADR 0313 決定2)。節の順序は Harness を問わず
 *  定義本文 → authority → roster → doctrine → (Interview の root なら)Interview の規律 → protocol → 当時版 → 記憶の注入 →
 *  主題の材料(ADR 0180 決定2・ADR 0279 決定2)。組まなかった節は列に無い。
 *  doctrine は adapter が自分の語彙で組んで渡す(決定2)。review task は registry の
 *  profile でなく reviewer の authority と、被レビュー task の executor 1名の roster を
 *  持つ(ADR 0056)—— 帰り先の無い系譜ではどちらも持たない(ADR 0301 決定5)。修理子の type は Authority 節が REPAIR_NOTICES の1行だけで roster を
 *  持たない(ADR 0272 追記3)。当事者レビュー(self RCA)は当時版の定義を証拠として持つ(ADR 0020 part 4)。 */
export function boardProse(input: {
  db: Db;
  registryDir: string;
  registry: Registry;
  task: Task;
  /** この文面で起こす session の `worker_spawned` の id(ADR 0295 決定3)。 */
  spawnedEventId: number;
  definition: Pick<AgentDefinition, "systemPrompt" | "version" | "builtin">;
  profile: AuthorityProfile;
  doctrine: string;
  allowedDomains: string[] | undefined;
  /** task ごとの verb の差し替え(adapter が doctrine を組んだのと同じ値)。 */
  verbs: TaskVerbSwap;
  memory: { section: string | null };
  material: { section: string } | null;
}): PromptPart[] {
  const { db, task } = input;
  const { source, guidance, rosterAssignableTo } = guidanceByType(db, task, input.profile, input.spawnedEventId)!;
  const sections: Array<[Exclude<PromptPart["part"], "definition">, string]> = [
    ["authority", authoritySection(guidance)],
    ["roster", rosterSection(buildRoster(input.registry.agents, rosterAssignableTo))],
    ["doctrine", `\n\n${input.doctrine}`],
    ["interview_discipline", task.type === "interview" ? `\n\n${INTERVIEW_DISCIPLINE}` : ""],
    ["protocol", `\n\n${workerProtocol(input.allowedDomains, input.verbs)}`],
    ["historical_definition", historicalDefinitionSection(db, input.registryDir, task, source === "reviewer")],
    ["memory", input.memory.section ? `\n\n${input.memory.section}` : ""],
    ["meta_review_material", input.material?.section ? `\n\n${input.material.section}` : ""],
  ];
  return [
    {
      part: "definition",
      text: input.definition.systemPrompt,
      builtin: input.definition.builtin === true,
      registry_commit: input.registry.commit,
      definition_version: input.definition.version,
    },
    ...sections.filter(([, text]) => text !== "").map(([part, text]) => ({ part, text })),
  ];
}
