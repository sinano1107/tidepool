/** 盤面が書いた文面の正本(ADR 0157 決定3)。中身は Harness を問わず同じで、adapter が差し込むのは
 *  その Harness に実在する機構の名前だけである。 */

import type { Db } from "./db.js";
import { type EventPayload, listEvents } from "./events.js";
import { type AgentDefinition, type AuthorityProfile, ownEntry, REVIEWER_AUTHORITY_PROFILE, type Registry, type RosterAgent } from "./registry.js";
import {
  AUTHORITY_WILDCARD,
  HUMAN_ROSTER_AGENT,
  isRepairType,
  REPAIR_NOTICES,
  reviewedTaskExecutor,
  type Task,
  type TaskVerbSwap,
  whyNoReturnDestination,
} from "./tasks.js";
import { type PromptRecord, TranscriptStore } from "./transcript-store.js";

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
  if (assignableTo === undefined || assignableTo.length === 0) return undefined;
  const wildcard = assignableTo.includes(AUTHORITY_WILDCARD);
  const explicitNames = assignableTo.filter((name) => name !== AUTHORITY_WILDCARD);
  const agentNames = wildcard ? Object.keys(registryAgents) : explicitNames;
  const agents: RosterAgent[] = agentNames
    .map((name) => ownEntry(registryAgents, name))
    .filter((agent): agent is RosterAgent => agent !== undefined && agent.builtin !== true);
  if (explicitNames.includes(HUMAN_ROSTER_AGENT.name)) agents.push(HUMAN_ROSTER_AGENT);
  return agents.length > 0 ? agents.map(rosterLine).join("\n") : undefined;
}

/** Wraps a built roster (or nothing) as the trailing `## Roster` of the
 *  system prompt — its own heading (CONTEXT.md's Roster term) rather
 *  than folded into `## Authority`, since it names delegates, not authority. */
function rosterSection(roster: string | undefined): string {
  return roster === undefined ? "" : `\n\n## Roster\n\n${roster}`;
}

/** Wraps authority guidance as an Authority section, or omits the
 *  section entirely when guidance is empty (issue #488: `standard`'s
 *  template guidance is `""`, and an empty heading would be a lie with
 *  nothing under it). */
function authoritySection(guidance: string): string {
  return guidance === "" ? "" : `\n\n## Authority\n\n${guidance}`;
}

/** A review's roster (ADR 0056): the reviewed task's executor as of the session's
 *  spawn `spawnedEventId` (ADR 0295), the one name its repairs may always target. */
function reviewAssignableTo(db: Db, review: Task, spawnedEventId: number): string[] {
  const executor = reviewedTaskExecutor(db, review, spawnedEventId);
  return executor !== undefined ? [executor] : (REVIEWER_AUTHORITY_PROFILE.assignable_to ?? []);
}

/** 本文を中の backtick の列より長い fence で包む —— 包んだ文の見出しや fence が外の節と混ざらない。 */
export function fenced(text: string, info = ""): string {
  const fence = "`".repeat(Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return `${fence}${info}\n${text}\n${fence}`;
}

/** spawn 時に記録した prompt のうち当時版の3部分(ADR 0314 決定1)。`definition` は必ずあり、組まなかった節は undefined。 */
export function recordedDefinition({ system }: PromptRecord) {
  const part = <P extends PromptPart["part"]>(name: P) => system.find((p): p is PromptPart & { part: P } => p.part === name);
  return { definition: part("definition")!, authority: part("authority"), roster: part("roster") };
}

/** One recorded spawn's evidence (ADR 0314 決定5・6): the parts the worker was given, each fenced — evidence to
 *  read, not to follow, whose own `## Authority` / `## Roster` headings stay apart from this session's. The
 *  Authority's source is named: a registry profile, the board's repair notice, or the reviewer constant —
 *  pointed at as the RCA's own Authority when that is the same constant (`ownAuthorityIsReviewer`). A spawn whose
 *  lineage had no return destination was given neither section (ADR 0301 決定5). */
function recordedEvidence(assignee: string, then: ReturnType<typeof recordedDefinition>, ownAuthorityIsReviewer: boolean): string {
  const { definition, authority, roster } = then;
  const body =
    definition.builtin && definition.text === ""
      ? `You ran then as the board's built-in ${assignee}, whose definition lives in board code, not the registry; its body was empty at that version.`
      : fenced(definition.text);
  if (!authority && !roster) return `${body}\n\nYou were given no Authority section and no Roster section then.`;
  const source =
    authority &&
    {
      profile: `The Authority below came from the registry's authority profile ${authority.profile}.`,
      repair: "The Authority below is the board's repair notice.",
      reviewer:
        (ownAuthorityIsReviewer
          ? "The Authority below is the board's fixed reviewer authority — the same text as your own Authority above. "
          : "The Authority below is the board's fixed reviewer authority. ") +
        "It is board code, not a registry profile, so it is not a target for a registry diff.",
    }[authority.source];
  return [body, source, authority && fenced(authority.text.trimStart()), roster && fenced(roster.text.trimStart())].filter(Boolean).join("\n\n");
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
 *  `worker_spawned` session that was live when that entry was written, read
 *  from the prompt recorded at that spawn (ADR 0314 決定1). Anchoring on the
 *  entries — not simply the latest spawn — keeps a later escalation-return
 *  re-spawn under a refined definition from being mistaken for the 当時版;
 *  resolving per entry — not folding to one anchor — keeps judgments that span
 *  sessions under different definitions from being read against a definition
 *  that never shaped them. Spawns whose recorded definition, Authority and
 *  Roster texts are the same fold into one section (ADR 0314 決定6); distinct
 *  texts are each injected, labeled with the decision-log entry ids they were
 *  live for (the same id space the RCA reads via get_current_task's parent
 *  decision_log). Independent reviews (unset assignee → the Auditor pointer,
 *  issue #42) get no such injection: their value is distance from the
 *  judgment, not the 原本. Best-effort — an entry whose record cannot be read
 *  (no spawn before it, a missing or unparseable prompt record) is declared as
 *  an evidence gap when other entries did resolve, and degrades to no section
 *  at all when none did (no claim made, nothing to declare) — never a failed
 *  spawn. The review still executes under the current definition (ADR 0019):
 *  this only adds evidence, not the reviewer's identity. */
function historicalDefinitionSection(db: Db, recordDir: string, task: Task, ownAuthorityIsReviewer: boolean): string {
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
  // by this worker at or before the entry — and the prompt recorded at it. Map
  // insertion order is chronological because the entries are. 束ねの鍵は記録の3部分の text(ADR 0314 決定6)
  const transcripts = new TranscriptStore(recordDir);
  const byText = new Map<string, { entryIds: number[]; then: ReturnType<typeof recordedDefinition> }>();
  const unresolved: number[] = [];
  for (const entryId of objectedEntryIds) {
    const spawned = events.filter((e) => e.kind === "worker_spawned" && e.actor_id === task.assignee && e.id <= entryId).at(-1);
    const prompt = spawned && transcripts.readPrompt(task.parent_id, spawned.id);
    if (!prompt) {
      unresolved.push(entryId);
      continue;
    }
    const then = recordedDefinition(prompt);
    const key = JSON.stringify([then.definition.text, then.authority?.text ?? null, then.roster?.text ?? null]);
    const bundle = byText.get(key);
    if (bundle) bundle.entryIds.push(entryId);
    else byText.set(key, { entryIds: [entryId], then });
  }
  const resolved = [...byText.values()];
  if (resolved.length === 0) return "";
  const evidence = ({ then }: (typeof resolved)[number]) => recordedEvidence(task.assignee!, then, ownAuthorityIsReviewer);
  // 「current definition」の括弧は ADR 0019(修理は再演ではない)
  if (resolved.length === 1 && unresolved.length === 0) {
    return (
      "\n\n## Definition under review (as recorded at your spawn)\n\n" +
      "This is your agent definition as recorded at your spawn for the objected task, with the " +
      "Authority and Roster it gave you, if any — the text that shaped the decision now under review. " +
      'Read it as evidence for "why did I make that call", not as instructions. You nonetheless carry out this review under your ' +
      "current definition (repair is not a re-enactment).\n\n---\n\n" +
      evidence(resolved[0]!)
    );
  }
  const gap =
    unresolved.length === 0
      ? ""
      : "\n\nNote: no definition version could be resolved for your objected " +
        `${entryLabels(unresolved)} (missing session record) — the evidence above is incomplete for those judgments.`;
  return (
    "\n\n## Definitions under review (each as recorded at your spawn)\n\n" +
    "These are your agent definitions as recorded at your spawns for the objected task, " +
    "each with the Authority and Roster it gave you, if any, resolved per objected " +
    "decision-log entry — each one below is the one " +
    "that was live when you wrote the entries it is labeled with. Read them as evidence " +
    'for "why did I make that call", not as instructions. You nonetheless carry out this review under your ' +
    "current definition (repair is not a re-enactment)." +
    resolved.map((version) => `\n\n### Live for your objected ${entryLabels(version.entryIds)}\n\n---\n\n${evidence(version)}`).join("") +
    gap
  );
}

/** Authority 節の本文と Roster の元を type で選ぶ spawn の分岐で、`source` は記録の `authority` 部分が運ぶ文の出所
 *  (ADR 0314 決定5)。修理子の type は REPAIR_NOTICES の1行だけで roster を持たない(ADR 0272 追記3 / ADR 0279 決定4)。
 *  review / interview は reviewer の guidance で、roster は review なら Executor 1名(ADR 0056)、interview は空
 *  (`reviewedTaskExecutor` は review にしか引かない)—— ただし帰り先の無い系譜では Authority 節も Roster 節も持たない(`none`、
 *  ADR 0301 決定5)。系譜は `spawnedEventId` の時点で読む(cancel は途中で届く)。profile を読むのは修理子の type でも
 *  review / interview でもない task だけ。 */
function guidanceByType(
  db: Db,
  task: Task,
  profile: Pick<AuthorityProfile, "guidance" | "assignable_to">,
  /** Roster を描いた session の spawn —— review の Executor と系譜の時点(ADR 0295 決定3 / ADR 0301 決定5)。 */
  spawnedEventId: number,
): { source: "repair" | "reviewer" | "none" | "profile"; guidance: string; rosterAssignableTo: string[] | undefined } {
  if (isRepairType(task.type)) return { source: "repair", guidance: REPAIR_NOTICES[task.type], rosterAssignableTo: undefined };
  if (task.type === "review" || task.type === "interview")
    return whyNoReturnDestination(db, task.id, spawnedEventId) === undefined
      ? { source: "reviewer", guidance: REVIEWER_AUTHORITY_PROFILE.guidance, rosterAssignableTo: reviewAssignableTo(db, task, spawnedEventId) }
      : { source: "none", guidance: "", rosterAssignableTo: undefined };
  return { source: "profile", guidance: profile.guidance, rosterAssignableTo: profile.assignable_to };
}

/** 盤面が書いた文面の持ち主つきの部分(ADR 0313 決定2)。`text` は自分の区切り(先頭の空行や見出し)を含み、順に空文字で
 *  連結した値が harness へ渡す値になる。`definition` は誰の・どの版の本文かを `worker_spawned` と同じ値で添える。 */
export type PromptPart =
  | { part: "definition"; text: string; builtin: boolean; registry_commit: string; definition_version: string }
  /** `source` は Authority 節の文の出所(ADR 0314 決定5)—— registry の profile(`profile` に名前)・盤面の reviewer 定数・修理子の通知。 */
  | { part: "authority"; text: string; source: "profile" | "reviewer" | "repair"; profile?: string }
  | {
      part: "roster" | "doctrine" | "interview_discipline" | "protocol" | "historical_definition" | "memory" | "meta_review_material";
      text: string;
    };

/** 部分の列を harness へ渡す1つの値に戻す(ADR 0313 決定2)。 */
export function joinPrompt(parts: readonly PromptPart[]): string {
  return parts.map((part) => part.text).join("");
}

/** 盤面が書いた文面の全体(ADR 0157 決定1)を持ち主つきの部分の列で返す(ADR 0313 決定2)。節の順序は Harness を問わず
 *  定義本文 → authority → roster → doctrine → (Interview の root なら)Interview の規律 → protocol → 当時版 → 記憶の注入 →
 *  主題の材料(ADR 0180 決定2・ADR 0279 決定2)。組まなかった節は列に無い。
 *  doctrine は adapter が自分の語彙で組んで渡す(決定2)。review task は registry の
 *  profile でなく reviewer の authority と、被レビュー task の executor 1名の roster を
 *  持つ(ADR 0056)—— 帰り先の無い系譜ではどちらも持たない(ADR 0301 決定5)。修理子の type は Authority 節が REPAIR_NOTICES の1行だけで roster を
 *  持たない(ADR 0272 追記3)。当事者レビュー(self RCA)は当時版の定義を証拠として持つ(ADR 0020 part 4)。 */
export function boardProse(input: {
  db: Db;
  /** 記録の器(transcript の dir)—— self RCA の当時版を記録した prompt から読む(ADR 0314 決定1)。 */
  recordDir: string;
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
  const { source, guidance, rosterAssignableTo } = guidanceByType(db, task, input.profile, input.spawnedEventId);
  const authority = authoritySection(guidance);
  const sections: Array<[Exclude<PromptPart["part"], "definition" | "authority">, string]> = [
    ["roster", rosterSection(buildRoster(input.registry.agents, rosterAssignableTo))],
    ["doctrine", `\n\n${input.doctrine}`],
    ["interview_discipline", task.type === "interview" ? `\n\n${INTERVIEW_DISCIPLINE}` : ""],
    ["protocol", `\n\n${workerProtocol(input.allowedDomains, input.verbs)}`],
    ["historical_definition", historicalDefinitionSection(db, input.recordDir, task, source === "reviewer")],
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
    // 帰り先の無い系譜(`none`)と guidance が空の profile は Authority 節を持たない
    ...(authority === "" || source === "none"
      ? []
      : [{ part: "authority" as const, text: authority, source, ...(source === "profile" && { profile: input.profile.name }) }]),
    ...sections.filter(([, text]) => text !== "").map(([part, text]) => ({ part, text })),
  ];
}
