import { randomUUID } from "node:crypto";
import { isClaudeModelAlias } from "./claude-model-alias.js";
import type { Db } from "./db.js";
import { DEFAULT_AUDITOR_NAME } from "./defaults.js";
import { DomainError } from "./domain-error.js";
import { whyInvalidEffort } from "./effort.js";
import { appendEvent, type EventOrigin, type EventPayload, getEvent, type InterviewOutcome, type InterviewProbe, latestEventOfTask, type ResolvedFromDefault, type TaskScopedPayload, taskDecisionLog } from "./events.js";
import type { AddTierAmendment, ExecutionSettingRow, RoutingRowChange } from "./execution-setting.js";
import type { GitHubClient, Issue, IssueRef } from "./github.js";
import type { MemoryAmendment } from "./memory.js";
import { whyNotPositiveInteger } from "./positive-integer.js";
import { PROVIDER_VALUES, type Provider } from "./provider.js";
import { type QuestionColumns, type QuestionKind, questionColumns, questionKindOf } from "./question-kind.js";
import type { MergeDial, RosterAgent } from "./registry.js";
import { normalizeText, whyBlank } from "./required-text.js";
import type { TaskExecutionCandidates } from "./scheduler.js";
import { isSettled, type TaskStatus, unsettledSql } from "./task-status.js";
import { assertKnownTier, liveTierId, PRIORITIES, type Priority, proposalTierNames, type Tier, type TierId } from "./tier.js";
import {
  completionReviewFires,
  type ReviewSubject,
  whyExecutionRequestIsInert,
  whyNoCompletionReview,
  whyReviewFlagIsInert,
} from "./webui-rules.js";
import { BOARD_WORKER_ID, HUMAN_WORKER_ID, NON_AGENT_WORKER_IDS } from "./worker-id.js";

/** The one roster entry `human` gets (issue #43 / ADR 0014): human carries
 *  no registry definition, but CONTEXT.md's Roster still surfaces it as a
 *  delegable worker. A single `RosterAgent` value, not a string and a
 *  separately-built object — claude-worker.ts's push roster formats it into
 *  a "name — description" line, mcp.ts's `list_agents` pull returns it
 *  as-is, and both draw from this one source so they can't drift apart.
 *  English, like every other value that reaches an agent's own system
 *  prompt or tool output — Japanese in this file is for humans reading the
 *  source (comments, ADRs), never for text an agent session consumes.
 *  This English rule covers scaffolding (board/agent-authored text) only;
 *  human-authored payload (task titles, answers, objections, scratchpad)
 *  stays in whatever language the human wrote — see ADR 0015. */
// The description said "as a question task" — a factual error (issue #116): a
// human-assignee task lands as a *work* task in the your-tasks list, not as a
// question. Corrected, and given the attention-budget hint the #116 grilling
// asked for: the assignable_to gate guards human attention, not permission, so
// the roster line itself should steer agents to delegate sparingly.
export const HUMAN_ROSTER_AGENT: RosterAgent = {
  name: HUMAN_WORKER_ID,
  description:
    "delegate to a human — runs outside the slot in their own task list; " +
    "human attention is scarce, delegate only what genuinely needs a human",
};

/** Fallback for the board's Auditor pointer (CONTEXT.md) when no
 *  configuration overrides it — the pointer "常に値を持ち「未設定」という状態
 *  はない" (ADR 0013's issue #15 grilling notes). The shared literal lives in
 *  defaults.ts so boot and pre-boot registry seeding cannot drift. */
export type TaskType = "work" | "question" | "review";

/** 盤面の解決(`presentTask` / `boardRows`)を通っていない値の、型だけの目印(ADR 0220)。実行時には存在しない。
 *  `Task` と `TaskRow` が持ち、解決の出力(`BoardRow` / `BoardTask`)だけが `Omit` で外す。 */
declare const storedRow: unique symbol;
/** 値のどこか(配列の中・入れ子の欄)に目印があれば true。`keyof` で見るので spread・キャストでも残る。 */
type StoredIn<T> = T extends readonly (infer U)[]
  ? StoredIn<U>
  : T extends object
    ? typeof storedRow extends keyof T
      ? true
      : { [K in keyof T]-?: StoredIn<T[K]> }[keyof T]
    : false;
/** 読み手へ出す口の引数の型: 目印を持つ値は `never` になって拒まれる。 */
export type Unstored<T> = T & (true extends StoredIn<T> ? never : unknown);

export interface Task {
  readonly [storedRow]?: true;
  id: string;
  type: TaskType;
  status: TaskStatus;
  assignee: string | null;
  /** Where this task runs (issue #11): a registry workspace name, or null to
   *  inherit the parent's (CONTEXT.md: workspace is first-class, children
   *  inherit by default). */
  workspace: string | null;
  /** For an issue-backed task (issue #49, ADR 0016), these are never the
   *  task's real content — real content is never snapshotted, only resolved
   *  live from the referenced GitHub issue (`github_issue_number`) at each
   *  use (spawn, UI display, PR title — see TaskContentSource). Until then,
   *  rowToTask fills these with the same "#N" placeholder issue #49's own
   *  spec calls for the UI to show before a first successful fetch, so every
   *  synchronous reader (decision log, notifications, console messages)
   *  keeps working without itself becoming async. */
  title: string;
  purpose: string;
  completion_criteria: string;
  risk_flag: number;
  review_flag: number;
  review_by: string[] | null;
  review_tier: Tier | null;
  /** The task's execution request (CONTEXT.md「要求」, ADR 0110 決定2): the
   *  required quality tier, or null when the registrant stated none — the
   *  selector then falls back to the agent's `tier` and the board default,
   *  and records which of the three decided (`worker_spawned.source.tier`).
   *  Null is "unstated", never "the default was chosen". */
  tier: Tier | null;
  /** The other half of the request: how tied candidates are ordered
   *  (CONTEXT.md「要求」). Stored only — the selector does not read it while
   *  an agent speaks a single Provider and there is nothing to order. */
  priority: Priority | null;
  parent_id: string | null;
  /** Decision-log entry this decomposed child rests on; null outside a decomposition decision. */
  based_on_decision: number | null;
  /** 開いている前提の破綻が指す分解判断(ADR 0121)。閉じていれば null。 */
  premise_breach_decision: number | null;
  sort_key: number;
  handoff_doc: string | null;
  /** The PR opened for this task's completed work (issue #11), or null if
   *  none opened yet (no workspace/github configured, or the task carries no
   *  handoff-worthy change). Set once by recordPrOpened, never by the MCP
   *  layer directly. */
  pr_number: number | null;
  question_items: QuestionItem[] | null;
  /** One answer per item, in item order — set only when every item has been
   *  answered (issue #30): the submission is atomic, so a partial-answer
   *  state is never stored. */
  question_answer: string[] | null;
  /** The reject-reason steering channel (issue #40): one per submission (not
   *  per item), optional — set only alongside question_answer, by
   *  answerQuestion. Never set via MCP or the JSON API directly. */
  question_answer_comment: string | null;
  /** System-internal only (ADR 0006) — never set via MCP or the JSON API. */
  question_cancel_option: string | null;
  /** System-internal only (ADR 0121 / ADR 0245 決定2・5): the decision this premise-breach question
   *  stands in for — its abandon scope stays decision-wide even for an Interview pin child. */
  question_breached_decision: number | null;
  /** System-internal only (ADR 0251): the reason an Interview root reported its probe broken. */
  question_broken_probe_reason: string | null;
  /** System-internal only (issue #11): a pending-child approval question's
   *  would-be child, materialized by answerQuestion only on an "approve"
   *  answer. */
  question_pending_child: PendingChildSpec | null;
  /** Board-internal only (ADR 0120 決定4 / issue #620): 提案を運ぶ question の種別つき提案と pin。
   *  この欄を持つ question は親を塞がない付帯子(awaitedChildSql)。 */
  question_proposal: QuestionProposal | null;
  /** System-internal only (issue #11): the PR number a merge-decision
   *  question is standing in for — set only by registerMergeQuestion, from
   *  the landing surface (recordPrOpened, and the auto-merge poll's CI-red
   *  and surface-changed paths), read only by submitAnswer to gate the actual
   *  merge on a live CI check. Never set via MCP or the JSON API. */
  question_pending_merge_pr: number | null;
  /** System-internal only (ADR 0053): the completed work task whose
   *  purely-local task branch awaits a human merge/hold decision. */
  question_pending_local_merge_task_id: string | null;
  /** System-internal only (issue #66): the completed work task whose failed
   *  PR promotion this failure question can retry. */
  question_pending_pr_promotion_task_id: string | null;
  /** System-internal only (ADR 0137 決定2): the Quarantine kind this
   *  Confirmation question stands in for and the value it is keyed on (null
   *  for a board-wide kind that names nothing). Typed as an open string here
   *  because the vocabulary lives in the Quarantine module, which depends on
   *  this one and never the reverse. Never set via MCP or the JSON API. */
  question_quarantine_kind: string | null;
  question_quarantine_value: string | null;
  /** System-internal only (ADR 0075): warned configured-expiry epoch. */
  question_cli_auth_expiry_warning: number | null;
  /** Issue-backed task reference (issue #49, ADR 0016): the GitHub issue
   *  number this task is a live reference to, or null for an ordinary task.
   *  `workspace` doubles as the repo half of the reference for such a task. */
  github_issue_number: number | null;
  /** Board-internal only (ADR 0120 決定2 / issue #618): the subject this task
   *  is the periodic meta-review for, or null for an ordinary task. Never
   *  written from MCP / the JSON API. */
  meta_review_subject: "memory" | "routing" | null;
  /** Interview の子の pin(ADR 0199 決定3): root の対象の行の id。出題(poseProbe)だけが書く。 */
  interview_target_id: number | null;
  created_at: string;
}

/** The content shared by every task-registration shape (ChildSpec,
 *  PendingChildSpec, RegisterTaskInput) — kept as one type so a field added to
 *  all three in lockstep (as risk_flag/assignee/workspace each were, issue
 *  #11) only needs declaring once. */
export interface TaskContent {
  title: string;
  purpose: string;
  completion_criteria: string;
}

/** 提案 question の種別つき提案(ADR 0120 決定4 / ADR 0150 決定1)。 */
export type QuestionProposal<T extends TierRef = TierId> = MemoryProposal | RoutingProposal<T> | RegistryProposal<T>;

/** memory の提案。pin = replaces / target / 既存の後継の版と candidate の状態。 */
export type MemoryProposal = {
  kind: "memory";
  /** version は candidate なら null(版は承認 event の id)。invalidate では空。 */
  replaces: Array<{ id: number; version: number | null }>;
} & (
  | { op: "approve" | "consolidate"; candidate_id: number }
  /** 既存の approved の Behavior / Exemplar を後継に名指す統合(ADR 0160 決定2)。 */
  | { op: "consolidate"; successor: { id: number; version: number } }
  | { op: "invalidate"; target: { id: number; version: number }; reason: "capability" | "environment" | "requirement_change" }
);

/** 提案が段を指す値(ADR 0200 決定2 / issue #1436): 盤面に焼くのは段の id(既定の `TierId`)で、改名は提案を崩さない。
 *  外へ見せる口と承認の書き込みは、いまの名前へ引いた形(`Tier`)を読む(`proposalTierNames`)。 */
export type TierRef = TierId | Tier;
type RowAt<T extends TierRef> = Omit<ExecutionSettingRow, "tier"> & { tier: T };

/** 表の1行の tier / effort を置き換える提案(issue #918)。pin = 提案時点のその行の全欄。 */
export interface RoutingRowProposal<T extends TierRef = TierId> {
  kind: "routing";
  op: "row";
  /** 行の鍵(ADR 0200 決定5)。承認はこの行を編集する。 */
  row: Pick<ExecutionSettingRow, "provider" | "model" | "effort">;
  change: Omit<RoutingRowChange, "tier"> & { tier?: T };
  pin: RowAt<T>;
}

/** 段を足して行を移す提案(issue #1424 / ADR 0200 決定8)。pin = 移す行の全欄と、提案時点の一覧で `position` の隣にいる段
 *  (添字 `position - 1` と `position`、端なら null)。 */
export interface RoutingAddTierProposal<T extends TierRef = TierId> {
  kind: "routing";
  op: "add_tier";
  tier: { name: Tier; description: string; position: number };
  row: Pick<ExecutionSettingRow, "provider" | "model" | "effort">;
  evidence: number[];
  pin: { row: RowAt<T>; below: TierNeighbour<T> | null; above: TierNeighbour<T> | null };
}
/** 段の同一性と説明(段を足す提案の隣の段の pin)。焼くのは id、外へ見せるのは名前。 */
export type TierNeighbour<T extends TierRef = TierId> = (T extends TierId ? { id: TierId } : { name: Tier }) & { description: string };

/** 段の説明の書き換えの提案(ADR 0200 決定7)。根拠は床を task の申告が決めた worker_spawned の event id、pin = 説明のいまの文面。 */
export interface TierDescriptionProposal<T extends TierRef = TierId> {
  kind: "routing";
  op: "tier_description";
  tier: T;
  description: string;
  evidence: number[];
  pin: { description: string };
}

/** routing の提案(ADR 0150 決定1): 表の1行、段の追加、段の説明、または学習器の昇格 / 降格。昇格 / 降格の pin はフラグの現在値。 */
export type RoutingProposal<T extends TierRef = TierId> =
  | RoutingRowProposal<T>
  | RoutingAddTierProposal<T>
  | TierDescriptionProposal<T>
  | { kind: "routing"; op: "promote" | "demote"; pin: { promoted: boolean } };

/** agent の既定 tier を1段下げる提案(issue #920 / ADR 0150 決定1・5)。承認は registry へ commit する。pin = agent の tier の
 *  現在値と、根拠(`worker_spawned` の event id)の episode が走った表の行。 */
export interface RegistryProposal<T extends TierRef = TierId> {
  kind: "registry";
  op: "agent_tier";
  agent: string;
  to: T;
  pin: { tier: T; rows: Array<Pick<RowAt<T>, "provider" | "model" | "tier" | "effort">> };
  evidence: number[];
}

/** 提案の approve に添える修正値(ADR 0150 決定2・ADR 0152 決定2): 行の提案は tier / effort、tier の提案は下げ先、段の追加は名前・説明・位置、段の説明の提案は文面、memory は文言と宛先。 */
export type ProposalAmendment = RoutingRowChange | { to: Tier } | AddTierAmendment | { description: string } | MemoryAmendment;

export interface PendingChildSpec extends TaskContent {
  review_by?: string[];
  review_tier?: string;
  /** The decision-log entry this child would have rested on had it registered
   *  normally — carried through so an approved child keeps the same
   *  provenance as an ordinary decomposed sibling. */
  based_on_decision?: number;
  /** Whether the child itself carries risk — checked against the parent's
   *  *current* risk flag at approval time (not a decompose-time snapshot) to
   *  decide whether this approval propagates risk upward at all. */
  risk_flag?: boolean;
  /** The assignee originally requested at decompose time, honored as-is on
   *  materialization regardless of which reason(s) triggered this question. */
  assignee?: string;
  /** The workspace originally requested at decompose time, honored as-is on
   *  materialization regardless of which reason(s) triggered this question. */
  workspace?: string;
  /** The review flag originally requested at decompose time, honored as-is
   *  on materialization regardless of which reason(s) triggered this
   *  question (ADR 0021: the flag itself never triggers a question, but a
   *  child converted for another reason — risk/assignee/workspace — must not
   *  lose it in transit). */
  review_flag?: boolean;
  /** The execution request originally written at decompose time, honored
   *  as-is on materialization — a child converted for another reason
   *  (risk/assignee/workspace) must not lose the tier its parent asked for,
   *  same line as `review_flag` above. */
  tier?: string;
  priority?: string;
}

/** The SQLite shape of a task: items/answer/pending-child are JSON TEXT
 *  columns, and — unlike domain `Task` — the three content columns are
 *  genuinely nullable (issue #49, ADR 0016): an issue-backed task's row
 *  really has no stored content, only rowToTask fills the placeholder in for
 *  domain code. The JSON parsing and the placeholder-fill both stay at this
 *  boundary. */
export type TaskRow = Omit<
  Task,
  "question_items" | "question_answer" | "question_pending_child" | "question_proposal" | "title" | "purpose" | "completion_criteria" | "review_by"
> & {
  tier_id: number | null;
  review_tier_id: number | null;
  review_by: string | null;
  question_items: string | null;
  question_answer: string | null;
  question_pending_child: string | null;
  question_proposal: string | null;
  title: string | null;
  purpose: string | null;
  completion_criteria: string | null;
};

function parseJson<T>(json: string | null): T | null {
  return json === null ? null : JSON.parse(json);
}

/** The "#N" placeholder for an issue-backed task's unresolved content (issue
 *  #49's own spec, §6: the UI shows this before its first successful fetch).
 *  Every synchronous domain reader (decision log, notifications, console
 *  messages) sees this instead of real content — only
 *  TaskContentSource.expand(), called at the actual use-moments (spawn, UI
 *  display, PR title), ever resolves the real title/purpose/completion_criteria. */
export function issueRefPlaceholder(githubIssueNumber: number): string {
  return `#${githubIssueNumber}`;
}

/** The one shape every content-nullable row reader shares: fill an
 *  issue-backed row's null title/purpose/completion_criteria with the
 *  placeholder so domain code never sees a null. rowToTask, registerTask,
 *  listBoard, and listQueue all need exactly this. */
function fillContentPlaceholder<
  T extends {
    title: string | null;
    purpose: string | null;
    completion_criteria: string | null;
    github_issue_number: number | null;
  },
>(row: T): T & { title: string; purpose: string; completion_criteria: string } {
  return {
    ...row,
    title: row.title ?? issueRefPlaceholder(row.github_issue_number!),
    purpose: row.purpose ?? issueRefPlaceholder(row.github_issue_number!),
    completion_criteria: row.completion_criteria ?? issueRefPlaceholder(row.github_issue_number!),
  };
}

/** 要求の段は id で持ち(ADR 0200 決定2)、Task は名前で返す —— 行を Task に写す読み口は、この列を足して SELECT し、
 *  id の列は写像で落とす(`rowToTask` / `toBoardTask`)。`t` は tasks の別名。 */
export function taskTierNamesSql(t: string): string {
  return `(SELECT name FROM tiers WHERE id = ${t}.tier_id) AS tier, (SELECT name FROM tiers WHERE id = ${t}.review_tier_id) AS review_tier`;
}

export function rowToTask({ tier_id: _tierId, review_tier_id: _reviewTierId, ...row }: TaskRow): Task {
  return {
    ...fillContentPlaceholder(row),
    review_by: parseJson<string[]>(row.review_by),
    question_items: parseJson<QuestionItem[]>(row.question_items),
    question_answer: parseJson<string[]>(row.question_answer),
    question_pending_child: parseJson<PendingChildSpec>(row.question_pending_child),
    question_proposal: parseJson<QuestionProposal>(row.question_proposal),
  };
}

/** One question in a bundle (issue #30): a single-item bundle is the
 *  degenerate case of the same shape (CONTEXT.md's Question), not a second
 *  form. `detail` holds implications specific to this item — the shared
 *  situation goes on the question task's `purpose` instead, so a triage
 *  reader isn't re-reading the same context once per item. */
export interface QuestionItem {
  title: string;
  detail?: string;
  options: string[];
  recommendation: string;
}

/** RegisterTaskInput's content is the one place TaskContent's three fields
 *  aren't all required (issue #49, ADR 0016): absent for an issue-backed
 *  task (registerTask persists null; TaskContentSource resolves it live at
 *  use time), required otherwise — enforced by assertGithubRef, not the
 *  type system. */
export interface RegisterTaskInput extends Partial<TaskContent> {
  /** Internal provenance for reviews generated by completeTask (ADR 0111). */
  integration_review?: boolean;
  /** Board-internal only (ADR 0171 決定1): the objection events a triage commit's repair / RCA child took as its material. */
  objection_event_ids?: number[];
  /** Board-internal only (ADR 0237): the repair assignee refused by the registration gate. */
  assignee_not_copied?: { name: string; reason: string };
  review_by?: string[];
  review_tier?: string;
  type: TaskType;
  parent_id?: string;
  /** CONTEXT.md's risk flag — declares external effect at registration. */
  risk_flag?: boolean;
  /** CONTEXT.md's review flag — opts this task into on-completion review
   *  (layer 1) at registration time (issue #12). */
  review_flag?: boolean;
  /** Pre-assigns the task to a specific worker at registration (issue #11). */
  assignee?: string;
  /** Registers the task against a specific workspace (issue #11). Absent →
   *  inherits the parent's (or null at the root). */
  workspace?: string;
  /** 1-4 question items (issue #30) — a single-item array is the degenerate
   *  case, not a distinct shape. */
  question?: QuestionItem[];
  /** System-internal only (ADR 0246 決定2): the question's kind and its payload, written to the kind's columns by
   *  `questionColumns`. Absent → an escalation. Never set via MCP or the JSON API — only the board's own
   *  registrations (watchdog, landing, quarantine, decompose, proposals …) pass a kind. A cancel option
   *  (failure / premise breach) must be one of the question's options. */
  question_kind?: QuestionKind;
  /** Board-internal only (ADR 0120 決定2 / issue #618): この task が主題の周期 meta-review であること。
   *  MCP / JSON API からは書けない —— registerMetaReview だけが渡す。 */
  meta_review_subject?: "memory" | "routing";
  /** Decision-log entry (event id) this task rests on — set by decompose. */
  based_on_decision?: number;
  /** Issue-backed task reference (issue #49, ADR 0016): the GitHub issue
   *  number this task is a live reference to. Absent for an ordinary task. */
  github_issue_number?: number;
  /** CONTEXT.md「要求」 — the required quality tier and the priority that
   *  orders that tier's candidates (ADR 0110 決定2 / ADR 0114). Typed as open strings, not the
   *  enums, because every door keeps its schema permissive and lets this
   *  layer say once which values exist (`assertExecutionRequest`); a narrower
   *  type here would only move that statement into each door's zod schema. */
  tier?: string;
  priority?: string;
  /** Interview の対象の一覧(ADR 0199 決定3): root review だけが持つ。人間の登録の扉が渡す。 */
  interview_targets?: InterviewTarget[];
  /** Interview の子の pin(対象の行の id)。出題が渡す(ADR 0253 決定1)。 */
  interview_target_id?: number;
}

/** Interview の対象(CONTEXT.md「Interview」/ ADR 0199 決定2): (provider, model, effort, tier)。表の行でなくてよく、advisor は
 *  名指さない。effort の null は「無い」という値(ADR 0218 決定5)。名前で喋る形で、盤面は段を id で持つ。 */
export interface InterviewTarget {
  provider: string;
  model: string;
  effort: string | null;
  tier: Tier;
}

/** 対象を登録する扉の検査(ADR 0199 決定3): 行を書く扉と同じ述語 —— 既知の Provider、anthropic の alias の拒否
 *  (ADR 0182 決定1)、(provider, model, effort) ごとの effort の語彙(ADR 0216 / 0218)、盤面の段。4欄一致の対象は
 *  2つ置けない(ADR 0249 決定2)。UNIQUE 制約では effort の null 同士が別の値になるので、ここで比べる。 */
export function assertInterviewTargets(db: Db, input: Pick<RegisterTaskInput, "type" | "parent_id" | "interview_targets">): void {
  if (input.interview_targets === undefined) return;
  if (input.type !== "review" || input.parent_id !== undefined) throw new DomainError("only a root review task (an Interview) carries interview_targets");
  if (input.interview_targets.length === 0) throw new DomainError("an Interview names at least one target");
  const seen = new Set<string>();
  for (const { provider, model, effort, tier } of input.interview_targets) {
    const target = JSON.stringify({ provider, model, effort, tier });
    if (seen.has(target)) throw new DomainError(`target ${target} appears more than once: an Interview's targets are not duplicated`);
    seen.add(target);
    if (!(PROVIDER_VALUES as readonly string[]).includes(provider)) throw new DomainError(`unknown provider "${provider}" — one of ${PROVIDER_VALUES.join(", ")}`);
    if (provider === "anthropic" && isClaudeModelAlias(model)) {
      throw new DomainError(`"${model}" is a Claude CLI alias whose target moves with CLI updates; an Interview target takes a concrete model id (e.g. claude-opus-5-5)`);
    }
    const effortProblem = whyInvalidEffort(provider, model, effort);
    if (effortProblem) throw new DomainError(effortProblem);
    assertKnownTier(db, "tier", tier);
  }
}

export interface TaskVerbSwap {
  withheld: readonly ("decompose" | "redecompose" | "complete_task")[];
  added: readonly ("pose_probe" | "complete_interview" | "report_broken_probe")[];
}

/** task ごとの verb の差し替え(ADR 0122 決定2): 登録しない verb と足す verb。worker MCP の登録・Codex の宣言・doctrine が同じここを引く。
 *  Interview の木では分解の verb を両方伏せ(ADR 0245 決定1 / ADR 0253 決定5)、root は complete_task も伏せて、出題前は出題の verb を、
 *  出題済みは採点完了の verb と、報告したことが無ければ probe の破綻の報告の verb を足す(ADR 0253 決定4 / ADR 0251 決定1・2)。 */
export function taskVerbSwap(db: Db, taskId: string): TaskVerbSwap {
  if (getTask(db, taskId)?.interview_target_id != null) return { withheld: ["decompose", "redecompose"], added: [] };
  if (interviewTargets(db, taskId) !== null) {
    const withheld = ["decompose", "redecompose", "complete_task"] as const;
    if (interviewProbe(db, taskId) === null) return { withheld, added: ["pose_probe"] };
    return { withheld, added: brokenProbeReported(db, taskId) ? ["complete_interview"] : ["complete_interview", "report_broken_probe"] };
  }
  return { withheld: [], added: [] };
}

/** Interview の root の対象の一覧(段は名前)。対象を持たない task は null。 */
export function interviewTargets(db: Db, taskId: string): InterviewTarget[] | null {
  const rows = targetRows(db, taskId).map(({ id: _, ...target }) => target);
  return rows.length ? rows : null;
}

/** 対象の行(一覧の順)。出題と走れるかの検査は pin の子が持つ行の id を要る。 */
function targetRows(db: Db, taskId: string): Array<InterviewTarget & { id: number }> {
  return db
    .prepare("SELECT id, provider, model, effort, (SELECT name FROM tiers WHERE id = tier_id) AS tier FROM interview_targets WHERE task_id = ? ORDER BY id")
    .all(taskId) as Array<InterviewTarget & { id: number }>;
}

/** Interview の対象の (provider, model, effort)。 */
export type TargetKey = { provider: Provider; model: string; effort: string | null };

/** 4欄一致の行が表に無い対象(ADR 0199 決定2)。 */
const UNROWED_TARGET_SQL = `NOT EXISTS (SELECT 1 FROM execution_settings e
  WHERE e.provider = it.provider AND e.model = it.model AND e.effort IS it.effort AND e.tier_id = it.tier_id)`;

/** Interview の木の task の id(どの Interview でも): root(対象の一覧を持つ)と pin の子。`IN (...)` に入れる SELECT。 */
export const INTERVIEW_TREE_SQL = "SELECT task_id FROM interview_targets UNION SELECT id FROM tasks WHERE interview_target_id IS NOT NULL";

/** pin の子の対象が表の行でなければその鍵、pin が無いか行なら undefined。行の対象の拒否は行の Quarantine に乗る(ADR 0184)。 */
export function unrowedTarget(db: Db, task: Pick<Task, "interview_target_id">): TargetKey | undefined {
  if (task.interview_target_id === null) return undefined;
  return db.prepare(`SELECT provider, model, effort FROM interview_targets it WHERE id = ? AND ${UNROWED_TARGET_SQL}`).get(task.interview_target_id) as TargetKey | undefined;
}

/** 断られた行でない対象の question の Quarantine の種類(quarantine.ts の表の2行。依存はあちら → こちらなので綴りで持つ)。 */
const REFUSED_TARGET_KINDS: readonly string[] = ["interviewTarget", "interviewTargetEffort"];

/** その question の2つの出口のうち、修理の確認でない方(ADR 0199 決定4)。 */
export const DROP_TARGET_OPTION = "do not measure this target";

/** 断られた行でない対象の question への「この対象は測らない」か —— 検査も Quarantine の解除も無く、子を cancel する。 */
export function dropsRefusedTarget(kind: QuestionKind, answer: string | undefined): boolean {
  return kind.kind === "quarantine" && REFUSED_TARGET_KINDS.includes(kind.quarantine) && answer === DROP_TARGET_OPTION;
}

/** 行でない対象を pin した未決着の子と、その対象。 */
export function unrowedPinChildren(db: Db): Array<{ task: Task; target: TargetKey }> {
  const rows = db
    .prepare(
      `SELECT t.id, it.provider, it.model, it.effort FROM tasks t JOIN interview_targets it ON it.id = t.interview_target_id
       WHERE ${unsettledSql("t.status")} AND ${UNROWED_TARGET_SQL} ORDER BY t.sort_key`,
    )
    .all() as Array<TargetKey & { id: string }>;
  return rows.map(({ id, ...target }) => ({ task: getTask(db, id)!, target }));
}

/** 既定 agent が走らせられない対象を名指して拒む(ADR 0253 決定3): pin の Provider が既定 agent の entry に無いか、advisor の
 *  entry で advisor を導出できない(ADR 0208)対象は、spawn の候補が空で走れない。判定は pickup と同じ候補の口に assignee 未指定の
 *  pin の子を渡す(registry の無い盤面の暗黙の entry を含む)。登録の扉と出題が引き、`remedy` は呼び手が直し方を足す。 */
export function assertTargetsRunnable(db: Db, rootId: string, candidates: TaskExecutionCandidates, agentName = "the default agent", remedy = ""): void {
  for (const { id, ...target } of targetRows(db, rootId)) {
    if (candidates({ type: "work", assignee: null, tier: null, priority: null, review_tier: null, interview_target_id: id }).length > 0) continue;
    throw new DomainError(
      `target ${JSON.stringify(target)} cannot run as ${agentName}: its provider is not among ${agentName}'s providers, ` +
        `or ${agentName} has an advisor that cannot be derived for this model under the board's advisor ceiling${remedy}`,
    );
  }
}

/** Every question carries 1-4 items (issue #30) — a quarantine question may carry none, when only a table edit settles
 *  it (ADR 0218 決定6) — each with 2-4 options plus a
 *  recommendation among them, whichever door it enters by (escalate, or a
 *  tidepool-internal registerTask call — watchdog/quarantine/merge/decompose;
 *  the JSON API refuses `type: "question"` outright, issue #38) — the answer
 *  view offers the options first, free text only as an override. The degraded
 *  free-text-only question is reserved for the watchdog's auto-escalation
 *  safety valve (#17).
 *
 *  An item's option floor relaxes to 1 only for an actual quarantine
 *  Confirmation question (issue #21, CONTEXT.md) — a `quarantine` kind, which
 *  only the Quarantine module's registration ever does: it asks for a
 *  completion confirmation, not a choice, and a fake second option would be
 *  filler with no effect of its own. This is deliberately keyed on that field
 *  rather than the registering `workerId` (e.g. `=== BOARD_WORKER_ID`): a
 *  worker's id is operator-configured and could collide with BOARD_WORKER_ID
 *  by accident, which would otherwise let an ordinary agent question sneak
 *  past the 2-4 floor. A question kind is never reachable from MCP or the JSON
 *  API (unlike an assignee/worker id), so this floor can't be gamed the same
 *  way — an agent's question is always a real 2-4-way choice. */
function assertQuestionSpec(input: RegisterTaskInput): void {
  const kind = input.question_kind;
  const cancelOption = kind?.kind === "failure" || kind?.kind === "premise_breach" ? kind.cancel_option : undefined;
  if (input.type !== "question") {
    if (input.question) throw new DomainError("only a question task carries options");
    if (cancelOption) throw new DomainError("only a question task carries a cancel option");
    return;
  }
  const items = input.question;
  // 表の編集でだけ決着する Quarantine の question は項目を持たない(ADR 0218 決定6)
  const takesNoAnswer = kind?.kind === "quarantine" && items?.length === 0;
  if (!takesNoAnswer && (!items || items.length < 1 || items.length > 4)) {
    throw new DomainError("a question carries 1 to 4 items");
  }
  const minOptions = kind?.kind === "quarantine" ? 1 : 2;
  for (const item of items) {
    if (whyBlank(item.title)) throw new DomainError("a question item carries a title");
    if (item.detail !== undefined && whyBlank(item.detail)) throw new DomainError("a supplied question detail cannot be blank");
    if (item.options.length < minOptions || item.options.length > 4) {
      throw new DomainError(`a question item carries ${minOptions} to 4 options`);
    }
    if (item.options.some(whyBlank)) throw new DomainError("question options cannot be blank");
    if (whyBlank(item.recommendation) || !item.options.includes(item.recommendation)) {
      throw new DomainError(
        "a question item carries the registrant's recommendation, one of its options",
      );
    }
  }
  if (cancelOption !== undefined) {
    if (!items[0]!.options.includes(cancelOption)) {
      throw new DomainError("a cancel option must be one of the question's options");
    }
    // the abandon cascade (answerQuestion) walks up from the question's own
    // parent, so a cancel option is meaningless without one
    if (!input.parent_id) {
      throw new DomainError("a cancel option requires a parent task");
    }
  }
}

/** ADR 0110 決定2 / CONTEXT.md「要求」: the two request columns hold an enum
 *  each, stated **once**, here. Every door (JSON API, 管理MCP, worker MCP's
 *  decompose) keeps its own schema permissive and lets a bad value arrive as
 *  a DomainError from this layer — spelling the enum per door would mean
 *  three places to update when the vocabulary moves. An unstated column is
 *  not a bad value: null is the request's absence. */
function assertExecutionRequest(
  db: Db,
  input: Pick<RegisterTaskInput, "type" | "tier" | "priority" | "review_tier">,
): void {
  // review task の要求は review_tier だけ(ADR 0111 追記10)
  for (const field of ["tier", "priority"] as const) {
    const reason = input[field] !== undefined && whyExecutionRequestIsInert(input);
    if (reason) throw new DomainError(`${field} would have no effect — ${reason}`);
  }
  // 段は盤面の一覧(ADR 0200 決定2): 一覧に無い名前は、いまの一覧を添えて拒む
  if (input.review_tier !== undefined) assertKnownTier(db, "review_tier", input.review_tier);
  if (input.tier !== undefined) assertKnownTier(db, "tier", input.tier);
  if (input.priority !== undefined && !(PRIORITIES as readonly string[]).includes(input.priority)) {
    throw new DomainError(`unknown priority "${input.priority}" — one of ${PRIORITIES.join(", ")}`);
  }
}

/** ADR 0016: unlike an ordinary task's workspace — empty until pickup
 *  writes the default's name (ADR 0233) — an issue-backed task's workspace is a
 *  confirmed value, required at registration, because it's the repo half of
 *  the identity of the issue it points at (a swapped default must never
 *  silently repoint it at another repo's same-numbered issue). */
function assertGithubRef(input: RegisterTaskInput): void {
  if (input.github_issue_number !== undefined) {
    const reason = whyNotPositiveInteger(input.github_issue_number);
    if (reason) throw new DomainError(reason);
    // CONTEXT.md defines the issue-backed task as a *work* task (issue #49
    // 設計点8) — the restriction is the definition's, not any one door's
    if (input.type !== "work") {
      throw new DomainError("an issue-backed task must be a work task");
    }
    if (!input.workspace) {
      throw new DomainError("an issue-backed task requires a workspace at registration");
    }
    // exclusivity, not just a workspace requirement (ADR 0016: "盤面には参照
    // だけを保存し、内容は使用の瞬間に展開する" — content is never
    // snapshotted, so an issue-backed task must carry none of the three).
    if (
      input.title !== undefined ||
      input.purpose !== undefined ||
      input.completion_criteria !== undefined
    ) {
      throw new DomainError("an issue-backed task carries no stored content");
    }
  } else if ([input.title, input.purpose, input.completion_criteria].some((value) => value === undefined || whyBlank(value))) {
    throw new DomainError(
      "a task requires title, purpose, and completion_criteria unless it is issue-backed",
    );
  }
}

/** The duplicate half of the registration gate (issue #104): while an
 *  unsettled issue-backed task holds the same reference (workspace name +
 *  issue number), registering another is refused — a duplicate is the same
 *  work twice, and whichever PR merges first closes the issue, turning the
 *  other into a dead reference and a manufactured failure question. Settled
 *  (done/cancelled — the task's own status, not its tree's) references never
 *  block: an abandon-then-retry re-registration is legitimate. Board-local
 *  by design — it needs no GitHub seam, so it holds on seam-less boards too,
 *  and the API gate reuses it as its cheap first check before the costly
 *  fetch + LLM inspection. */
export function assertNoUnsettledIssueRef(db: Db, workspace: string, issueNumber: number): void {
  const dup = db
    .prepare(
      `SELECT id FROM tasks
       WHERE workspace = ? AND github_issue_number = ?
         AND ${unsettledSql("status")}
       LIMIT 1`,
    )
    .get(workspace, issueNumber) as { id: string } | undefined;
  if (dup) {
    throw new DomainError(
      `issue #${issueNumber} in workspace ${workspace} is already referenced by unsettled task ${dup.id}`,
    );
  }
}

/** ADR 0087 決定2 の参照検査が数えるもの: この名前を参照する未決着(done/cancelled でない)
 *  タスクの件数。agent は `assignee` に加えて、将来の review assignee を予約する `review_by` も
 *  同じ参照として数える。workspace は `workspace` に加えて、決着で着地し直す完了した work の祖先の
 *  workspace も数える(ADR 0234 決定1)。削除の扉はこの件数を人間に返す —— 先に cancel か
 *  再割当をするのが筋だからである。 */
export function countUnsettledTasksReferencing(
  db: Db,
  column: "assignee" | "workspace",
  name: string,
): number {
  if (column === "workspace") return countUnsettledTasksReferencingWorkspace(db, name);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE (assignee = ? OR EXISTS (SELECT 1 FROM json_each(tasks.review_by) WHERE value = ?))
         AND ${unsettledSql("status")}`,
    )
    .get(name, name) as { n: number };
  return row.n;
}

/** 完了タスクが一度着地した(PR を開いた、local merge question が立った、着地する内容が無かった)SQL 述語。
 *  着地を待つ完了タスクの数えと、workspace の削除の扉が数える線は、これを共有する。 */
function taskHasLandedSql(taskRef: string): string {
  return `(EXISTS (SELECT 1 FROM events
                    WHERE task_id = ${taskRef} AND kind IN ('pr_opened', 'nothing_to_land'))
           OR EXISTS (SELECT 1 FROM tasks WHERE question_pending_local_merge_task_id = ${taskRef}))`;
}

/** ADR 0234 決定1: 未決着タスクは自身の workspace に加えて、決着したときに着地し直す(収束 —— ADR 0241)
 *  完了した work の祖先の workspace も参照する。着地しない Interview の子(pin を持つ work)は祖先に数えない(ADR 0199)。その祖先すべてから一度に子孫をたどり、各タスクを一度だけ数える。 */
function countUnsettledTasksReferencingWorkspace(db: Db, name: string): number {
  const row = db
    .prepare(
      `WITH RECURSIVE under_relanding(id) AS (
         SELECT p.id FROM tasks p
          WHERE p.workspace = @name AND p.type = 'work' AND p.status = 'done' AND p.interview_target_id IS NULL
            AND (p.pr_number IS NOT NULL OR NOT ${taskHasLandedSql("p.id")})
         UNION
         SELECT c.id FROM tasks c JOIN under_relanding r ON c.parent_id = r.id)
       SELECT COUNT(*) AS n FROM tasks
        WHERE (workspace = @name OR id IN (SELECT id FROM under_relanding)) AND ${unsettledSql("status")}`,
    )
    .get({ name }) as { n: number };
  return row.n;
}

/** 組み込みを shadow するエントリの削除の扉が数える参照(ADR 0228 決定3): この名前を
 *  `assignee` に持つ未決着の work。review は組み込みへ落ちても壊れないので数えない。 */
export function countUnsettledWorkAssignedTo(db: Db, name: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks
       WHERE assignee = ? AND type = 'work' AND ${unsettledSql("status")}`,
    )
    .get(name) as { n: number };
  return row.n;
}

/** Derives an issue-backed task's three content fields from its live GitHub
 *  issue (issue #49, ADR 0016): title and purpose come straight from the
 *  issue's own title and body, completion_criteria is a fixed template
 *  deferring to the issue body rather than a field the issue doesn't have —
 *  none of the three is ever stored, this runs fresh at every use (spawn and
 *  UI display). */
function deriveTaskContentFromIssue(issue: Issue): TaskContent {
  return {
    title: issue.title,
    purpose:
      issue.comments.length === 0
        ? issue.body
        : `${issue.body}\n\n## Issue comments\n\n${issue.comments.join("\n\n")}`,
    completion_criteria: "See the issue content above for completion criteria.",
  };
}

/** A task's content, resolved on demand (issue #49, ADR 0016's live 参照):
 *  an ordinary task's content is already known and resolves at once; an
 *  issue-backed task's expand() awaits a live GitHub fetch instead. Callers
 *  must expand() *before* entering a db.transaction() — better-sqlite3's
 *  transactions run synchronously and cannot await mid-flight.
 *
 *  Design notes for future revisits, not current obligations:
 *  - This class is essentially a named wrapper around
 *    `() => Promise<TaskContent>` — a plain function type plus two factory
 *    functions would work identically. The class form is kept only for the
 *    name's discoverability; if it ever accretes state or a third concern,
 *    prefer flattening it back to functions over growing it.
 *  - If reference kinds ever multiply beyond GitHub issues (a PR-backed or
 *    external-ticket-backed task), reconsider modeling Task's content as a
 *    discriminated union ({kind:"stored",...} | {kind:"issueRef",...})
 *    instead of flat nullable columns + this resolver: the union makes
 *    "reference and snapshotted content coexist" unrepresentable at the type
 *    level (the exclusivity assertGithubRef/the DB CHECK enforce by hand
 *    today), at the cost of forcing every one of the ~40 synchronous readers
 *    to branch — a ripple judged not worth it at the current single-kind
 *    scale (2026-07 review of issue #49). */
export class TaskContentSource {
  private constructor(private readonly resolve: () => Promise<TaskContent>) {}

  static stored(content: TaskContent): TaskContentSource {
    return new TaskContentSource(() => Promise.resolve(content));
  }

  static liveIssue(github: GitHubClient, ref: IssueRef): TaskContentSource {
    return new TaskContentSource(async () => deriveTaskContentFromIssue(await github.getIssue(ref)));
  }

  expand(): Promise<TaskContent> {
    return this.resolve();
  }
}

/** The one branch point between a task's two content sources (issue #49):
 *  every use-moment (spawn, UI display, PR title) goes through here instead
 *  of checking `github_issue_number` itself, so a new use-moment can't
 *  forget the issue-backed case and silently serve the "#N" placeholder.
 *  `workspacePath` is a thunk because resolving a workspace has side effects
 *  (resolveOrQuarantine can quarantine a name) — an ordinary task must never
 *  trigger them, so it's only invoked on the issue-backed branch. Falling
 *  back to the stored placeholder when GitHub or the workspace is
 *  unavailable keeps a seam-less board working; ADR 0016's failure taxonomy
 *  is layered on by the callers that need it — the scheduler's pickup gate
 *  (temporary → cycle skip, IssueGoneError → failure question) and the UI's
 *  stale/unavailable cache (issue-view.ts). */
export function contentSourceFor(
  task: Pick<Task, "title" | "purpose" | "completion_criteria" | "github_issue_number">,
  github: GitHubClient | undefined,
  workspacePath: () => string | undefined,
): TaskContentSource {
  const stored = TaskContentSource.stored({
    title: task.title,
    purpose: task.purpose,
    completion_criteria: task.completion_criteria,
  });
  if (task.github_issue_number == null || !github) return stored;
  const path = workspacePath();
  if (path === undefined) return stored;
  return TaskContentSource.liveIssue(github, { path, number: task.github_issue_number });
}

/** A review field that would do nothing in the task's post-change state is refused (ADR 0111 追記8): the
 *  verdict is webui-rules', the same rule completion and the WebUI's fields read. `reviewTier` is checked at
 *  registration only (Edit cannot change it, #1552); a review task's own review_tier is the tier it runs at
 *  (execution-setting.ts reads it only for type review), not a completion-review request. */
function assertReviewFieldsTakeEffect(
  state: ReviewSubject,
  reviewBy: string[] | null | undefined,
  reviewTier?: string,
): void {
  const refuse = (field: string, reason: string | undefined): void => {
    if (reason) throw new DomainError(`${field} would have no effect — ${reason}`);
  };
  if (state.review_flag) refuse("review_flag", whyReviewFlagIsInert(state));
  if (reviewBy?.length) refuse("review_by", whyNoCompletionReview(state));
  if (reviewTier !== undefined && state.type !== "review") refuse("review_tier", whyNoCompletionReview(state));
}

/** review_by is a set of names: naming the same reviewer twice is refused, not silently folded (CONTEXT.md "Review", #1512). */
function assertReviewByDistinct(reviewBy: string[] | undefined): void {
  if (reviewBy?.some(whyBlank)) throw new DomainError("review_by names cannot be blank");
  const dup = reviewBy?.find((name, i) => reviewBy.indexOf(name) !== i);
  if (dup !== undefined) {
    throw new DomainError(`review_by names the same reviewer twice: "${dup}" — each reviewer is named once`);
  }
}

/** New tasks always join the queue tail: sort_key = max + 1. */
export function registerTask(
  db: Db,
  input: RegisterTaskInput,
  now: Date,
  workerId: string,
  origin: EventOrigin,
): Task {
  input = { ...input };
  for (const field of ["title", "purpose", "completion_criteria", "tier", "review_tier", "priority"] as const) {
    if (input[field] !== undefined) input[field] = normalizeText(input[field]);
  }
  if (input.review_by) input.review_by = input.review_by.map(normalizeText);
  if (input.question) {
    input.question = input.question.map((item) => ({
      ...item,
      title: normalizeText(item.title),
      ...(item.detail !== undefined && { detail: normalizeText(item.detail) }),
      options: item.options.map(normalizeText),
      recommendation: normalizeText(item.recommendation),
    }));
  }
  const kind = input.question_kind;
  if (kind?.kind === "failure" || kind?.kind === "premise_breach") {
    input.question_kind = { ...kind, cancel_option: normalizeText(kind.cancel_option) };
  }
  assertQuestionSpec(input);
  assertGithubRef(input);
  assertExecutionRequest(db, input);
  assertReviewFieldsTakeEffect(input, input.review_by, input.review_tier);
  assertReviewByDistinct(input.review_by);
  assertInterviewTargets(db, input);
  // assertGithubRef above guarantees workspace whenever the ref is present
  if (input.github_issue_number !== undefined && input.workspace) {
    assertNoUnsettledIssueRef(db, input.workspace, input.github_issue_number);
  }
  const { maxKey } = db
    .prepare("SELECT COALESCE(MAX(sort_key), 0) AS maxKey FROM tasks")
    .get() as { maxKey: number };
  // stored is nullable (issue #49); the in-memory Task returned to the
  // caller never is — an issue-backed task gets the same "#N" placeholder
  // rowToTask fills in on every later read, so registerTask's own return
  // isn't a special case in what it hands back.
  const content = fillContentPlaceholder({
    title: input.title ?? null,
    purpose: input.purpose ?? null,
    completion_criteria: input.completion_criteria ?? null,
    github_issue_number: input.github_issue_number ?? null,
  });
  const task: Task = {
    id: randomUUID(),
    type: input.type,
    status: "todo",
    assignee: input.assignee ?? null,
    workspace: input.workspace ?? null,
    title: content.title,
    purpose: content.purpose,
    completion_criteria: content.completion_criteria,
    risk_flag: input.risk_flag ? 1 : 0,
    review_flag: input.review_flag ? 1 : 0,
    review_by: input.review_by?.length ? input.review_by : null,
    review_tier: input.review_tier ?? null,
    // assertExecutionRequest above has already closed these to the board's tiers and the priorities
    tier: input.tier ?? null,
    priority: (input.priority as Priority | undefined) ?? null,
    parent_id: input.parent_id ?? null,
    based_on_decision: input.based_on_decision ?? null,
    premise_breach_decision: null,
    sort_key: maxKey + 1,
    handoff_doc: null,
    pr_number: null,
    question_items: input.question ?? null,
    question_answer: null,
    question_answer_comment: null,
    ...questionColumns(input.question_kind ?? { kind: "escalation" }),
    github_issue_number: input.github_issue_number ?? null,
    meta_review_subject: input.meta_review_subject ?? null,
    interview_target_id: input.interview_target_id ?? null,
    created_at: now.toISOString(),
  };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, type, status, assignee, workspace, title, purpose, completion_criteria,
         risk_flag, review_flag, review_by, review_tier_id, tier_id, priority, parent_id, based_on_decision, sort_key, handoff_doc, pr_number,
         question_items, question_answer, question_answer_comment, question_cancel_option, question_breached_decision, question_broken_probe_reason,
         question_pending_child, question_proposal, question_pending_merge_pr, question_pending_local_merge_task_id, question_pending_pr_promotion_task_id, question_quarantine_kind,
         question_quarantine_value, question_cli_auth_expiry_warning, github_issue_number, meta_review_subject, interview_target_id, created_at)
       VALUES (@id, @type, @status, @assignee, @workspace, @title, @purpose, @completion_criteria,
         @risk_flag, @review_flag, @review_by, ${liveTierId("@review_tier")}, ${liveTierId("@tier")}, @priority, @parent_id, @based_on_decision, @sort_key, @handoff_doc, @pr_number,
         @question_items, @question_answer, @question_answer_comment, @question_cancel_option, @question_breached_decision, @question_broken_probe_reason,
         @question_pending_child, @question_proposal, @question_pending_merge_pr, @question_pending_local_merge_task_id, @question_pending_pr_promotion_task_id, @question_quarantine_kind,
         @question_quarantine_value, @question_cli_auth_expiry_warning, @github_issue_number, @meta_review_subject, @interview_target_id, @created_at)`,
    ).run({
      ...task,
      review_by: task.review_by && JSON.stringify(task.review_by),
      // the stored row keeps title/purpose/completion_criteria genuinely
      // null for an issue-backed task (ADR 0016: never snapshotted) — only
      // `task`, the in-memory value handed back to the caller, carries the
      // "#N" placeholder.
      title: input.title ?? null,
      purpose: input.purpose ?? null,
      completion_criteria: input.completion_criteria ?? null,
      question_items: task.question_items && JSON.stringify(task.question_items),
      question_pending_child:
        task.question_pending_child && JSON.stringify(task.question_pending_child),
      question_proposal: task.question_proposal && JSON.stringify(task.question_proposal),
    });
    for (const target of input.interview_targets ?? []) {
      db.prepare(`INSERT INTO interview_targets (task_id, provider, model, effort, tier_id) VALUES (?, ?, ?, ?, ${liveTierId("?")})`).run(
        task.id, target.provider, target.model, target.effort, target.tier,
      );
    }
    appendEvent(db, {
      taskId: task.id,
      workerId,
      origin,
      payload: {
        kind: "task_registered",
        type: task.type,
        title: task.title,
        ...(input.integration_review && { integration_review: true }),
        ...(input.objection_event_ids && { objection_event_ids: input.objection_event_ids }),
        ...(input.assignee_not_copied && { assignee_not_copied: input.assignee_not_copied }),
        ...(input.based_on_decision !== undefined && {
          based_on_decision: input.based_on_decision,
        }),
      },
      at: now,
    });
  })();
  return task;
}


export const HANDOFF_FIELDS = [
  "outcome",
  "deliverables",
  "decision_refs",
  "dead_ends",
  "resume_context",
  "known_issues",
] as const;
type HandoffField = (typeof HANDOFF_FIELDS)[number];
export type HandoffDoc = Record<HandoffField, string>;

const HANDOFF_HEADINGS: Record<HandoffField, string> = {
  outcome: "Outcome vs completion criteria",
  deliverables: "Deliverable locations",
  decision_refs: "Key decision-log references",
  dead_ends: "Dead ends tried",
  resume_context: "Context needed to resume",
  known_issues: "Known issues not worth a task",
};

function renderHandoffMarkdown(handoff: Partial<HandoffDoc>): string {
  return HANDOFF_FIELDS.filter((f) => handoff[f] !== undefined && !whyBlank(handoff[f]))
    .map((f) => `## ${HANDOFF_HEADINGS[f]}\n\n${handoff[f]}`)
    .join("\n\n");
}

const HANDOFF_HEADING_SET: ReadonlySet<string> = new Set(Object.values(HANDOFF_HEADINGS));

/** `field (heading), field (heading), …` for the six handoff fields — the source
 *  for both complete_task tool descriptions, so they can't drift from
 *  HANDOFF_FIELDS / HANDOFF_HEADINGS (issue #1084). */
export function describeHandoffFields(): string {
  return HANDOFF_FIELDS.map((f) => `${f} (${HANDOFF_HEADINGS[f]})`).join(", ");
}

/** The structural inverse of renderHandoffMarkdown (issue #47): only the
 *  rendered blob is stored on a task row (the per-field HandoffDoc is never
 *  persisted separately), so display-time translation of a handoff doc must
 *  recover its `## heading` / body sections mechanically rather than ask the
 *  model to preserve them — the headings are board scaffolding (ADR 0015's
 *  precision addendum), never sent to a translation call. Only a line whose
 *  text matches one of HANDOFF_HEADINGS' own fixed strings counts as a
 *  boundary — a bare `/^## /` would misfire on free-form agent prose (a
 *  markdown subheading in resume_context, a `## ` shell comment inside a
 *  fenced code block), splitting the body and sending a body line to the
 *  translator as if it were scaffolding. */
export function splitHandoffMarkdown(doc: string): Array<{ heading: string; body: string }> {
  const sections: Array<{ heading: string; body: string[] }> = [];
  for (const line of doc.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading && HANDOFF_HEADING_SET.has(heading[1]!)) {
      sections.push({ heading: heading[1]!, body: [] });
    } else if (sections.length > 0) {
      sections[sections.length - 1]!.body.push(line);
    }
  }
  return sections.map((s) => ({ heading: s.heading, body: s.body.join("\n").trim() }));
}

/** Hand the queue head to a worker: in_progress + event, atomically. The
 *  default reference ends here (ADR 0233): each name in `fill` — the caller's
 *  resolution of a default — is written onto its column only while that
 *  column is empty, so a set name is never overwritten (ADR 0012 / issue
 *  #36). The event records which columns were filled and with what, since
 *  registration records neither. `workerId` is the event's attribution.
 *
 *  `task` is the head the scheduler chose before awaiting real I/O (issue
 *  #972): if a human door cancelled it or handed it to `human` meanwhile, the
 *  row no longer matches and the pickup is abandoned (null, no event). The
 *  execution setting and the event's attribution were resolved from `task`,
 *  so a row whose assignee — or named workspace — changed in that window is
 *  abandoned too (issue #973). The fills test the row, not `task`, so a
 *  workspace named in that window onto an empty one is kept. */
export function pickupTask(db: Db, task: Task, workerId: string, now: Date, fill: ResolvedFromDefault = {}): Task | null {
  return db.transaction(() => {
    const { changes } = db
      .prepare(
        `UPDATE tasks SET status = 'in_progress' WHERE id = @id AND status = 'todo' AND assignee IS NOT @human
           AND assignee IS @assignee AND (@workspace IS NULL OR workspace = @workspace)`,
      )
      .run({ id: task.id, human: HUMAN_WORKER_ID, assignee: task.assignee, workspace: task.workspace });
    if (changes === 0) return null;
    const filled: ResolvedFromDefault = {};
    for (const column of ["assignee", "workspace"] as const) {
      const name = fill[column];
      if (name && db.prepare(`UPDATE tasks SET ${column} = ? WHERE id = ? AND ${column} IS NULL`).run(name, task.id).changes) {
        filled[column] = name;
      }
    }
    appendEvent(db, {
      taskId: task.id,
      workerId,
      origin: "board",
      payload: { kind: "task_picked_up", ...(Object.keys(filled).length > 0 && { resolved_from_default: filled }) },
      at: now,
    });
    return getTask(db, task.id)!;
  })();
}

/** Work tasks may not complete without a full handoff doc; question/review
 *  tasks need none, but one supplied is stored, not dropped (nothing may
 *  degrade recording). The doc lands as markdown on the task row, written
 *  once. A `human`-assignee task is exempt regardless of type (issue #13):
 *  actionable follow-up belongs to a *new* task, not this doc, so a physical/
 *  approval task carries no agent session to hand off from — the doc stays
 *  fully optional, same as question/review.
 *
 *  ADR 0111: root work and risk children are mandatory integration points;
 *  ordinary children opt into individual review through review_flag.
 *  Human tasks, questions and reviews are outside this rule. */
export function completeTask(
  db: Db,
  task: Task,
  handoff: Partial<HandoffDoc> | undefined,
  workerId: string,
  now: Date,
  origin: EventOrigin,
): Task {
  // ADR 0253 決定5: Interview の root は扉を問わず採点完了でだけ終わる —— 子0のまま完了する経路もここで閉じる
  if (interviewTargets(db, task.id) !== null) {
    throw new DomainError(
      `an Interview root does not complete with complete_task: ${interviewProbe(db, task.id) === null ? "pose its probe with pose_probe first" : POSED_INTERVIEW_EXITS}`,
    );
  }
  return finishTask(db, task, handoff, workerId, now, origin);
}

/** 完了の処理の本体: completeTask と採点完了(completeInterview)が通る。 */
function finishTask(
  db: Db,
  task: Task,
  handoff: Partial<HandoffDoc> | undefined,
  workerId: string,
  now: Date,
  origin: EventOrigin,
): Task {
  if (task.type === "work" && task.assignee !== HUMAN_WORKER_ID) {
    const missing = HANDOFF_FIELDS.filter((f) => handoff?.[f] === undefined || whyBlank(handoff[f]));
    if (missing.length > 0) {
      throw new DomainError(
        `a work task cannot complete without a full handoff doc; missing: ${missing.join(", ")}`,
      );
    }
    handoff = Object.fromEntries(HANDOFF_FIELDS.map((field) => [field, normalizeText(handoff![field]!)]));
  }
  // completion criteria cover the decomposition tree: a parent completes only
  // after every child it waits for settles (復帰型 — the resumed session
  // integrates, then completes)
  if (hasUnfinishedChildren(db, task.id)) {
    throw new DomainError("a task with unfinished children cannot complete");
  }
  const rendered = handoff ? renderHandoffMarkdown(handoff) : "";
  const handoffDoc = rendered === "" ? null : rendered;
  db.transaction(() => {
    db.prepare("UPDATE tasks SET status = 'done', handoff_doc = ? WHERE id = ?").run(
      handoffDoc,
      task.id,
    );
    appendEvent(db, {
      taskId: task.id,
      workerId,
      origin,
      payload: {
        kind: "task_completed",
        handoff_present: handoffDoc !== null,
        result: handoff?.outcome?.trim() || null,
      },
      at: now,
    });
    if (completionReviewFires(task)) {
      for (const assignee of task.review_by?.length ? task.review_by : [undefined]) {
        registerTask(
          db,
          {
            type: "review",
            integration_review: true,
            assignee,
            review_tier: task.review_tier ?? undefined,
            title: `review: ${task.title}`,
            purpose: `read-only review of "${task.title}"'s deliverable against its completion criteria`,
            completion_criteria:
              "findings are read-only — issues land as repair tasks for the original assignee",
            parent_id: task.id,
            // Inherit the subject's workspace so the review runs where its deliverable lives.
            workspace: task.workspace ?? undefined,
          },
          now,
          // 盤面の規則が立てる(ADR 0194 決定3)—— 完了させた agent の名義ではない
          BOARD_WORKER_ID,
          "board",
        );
      }
    }
  })();
  return getTask(db, task.id)!;
}

/** Place a task right after `after`, or at the top of the board when `after`
 *  is null. sort_key orders the whole board, so any task may move — for a todo
 *  task a move to the top is "run now", never a separate execution path.
 *  Human steering channel: reachable from the WebUI JSON API only, never MCP. */
export function moveTask(
  db: Db,
  task: Task,
  after: Task | null,
  now: Date,
  workerId: string,
  origin: EventOrigin,
): Task {
  const sortKey = fractionalKeyAfter(db, task, after);
  db.transaction(() => {
    db.prepare("UPDATE tasks SET sort_key = ? WHERE id = ?").run(sortKey, task.id);
    appendEvent(db, {
      taskId: task.id,
      workerId,
      origin,
      payload: { kind: "task_moved", after: after?.id ?? null },
      at: now,
    });
  })();
  return getTask(db, task.id)!;
}

/** 上限到達による中断(CONTEXT.md / ADR 0104 決定1・決定4): 走っていたタスクを
 *  `todo` の先頭へ戻し、中断の事実を盤面名義で1件刻む。失敗ではないので
 *  failure question(`registerFailureQuestion`)は立たず、失敗統計も生まれない —— 再開の門は次の pickup の
 *  Throttle である。先頭復帰そのものは retry 回答と同じ `moveTask` の一撃。
 *  行の拒否(ADR 0184 決定4)と盤面の記録の器が書けない pickup(ADR 0266 決定3)も同じ一撃で、刻む event だけが違う。 */
export function returnToQueueHead(
  db: Db,
  task: Task,
  payload: Extract<EventPayload, { kind: "cap_interrupted" | "row_refused" | "record_container_unwritable" }>,
  now: Date,
): void {
  db.transaction(() => {
    returnToQueue(db, task, payload, now);
    moveTask(db, task, null, now, BOARD_WORKER_ID, "board");
  })();
}

/** 走っていたタスクを位置を変えずに `todo` へ戻し、理由を盤面名義で刻む。行でない Interview の対象の拒否(ADR 0199 決定4)は
 *  先頭へ戻さない —— 対象の question が開いているあいだ pickup されない。 */
export function returnToQueue(db: Db, task: Task, payload: Extract<EventPayload, { kind: "cap_interrupted" | "row_refused" | "record_container_unwritable" }>, now: Date): void {
  db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(task.id);
  appendEvent(db, { taskId: task.id, workerId: BOARD_WORKER_ID, origin: "board", payload, at: now });
}

function fractionalKeyAfter(db: Db, task: Task, after: Task | null): number {
  if (after === null) {
    const { minKey } = db
      .prepare("SELECT COALESCE(MIN(sort_key), 0) AS minKey FROM tasks")
      .get() as { minKey: number };
    return minKey - 1;
  }
  const next = db
    .prepare("SELECT sort_key FROM tasks WHERE sort_key > ? AND id <> ? ORDER BY sort_key LIMIT 1")
    .get(after.sort_key, task.id) as { sort_key: number } | undefined;
  return next === undefined ? after.sort_key + 1 : (after.sort_key + next.sort_key) / 2;
}

interface EscalateInput {
  /** The shared situation behind every item in this bundle (issue #30) —
   *  becomes the registered question task's `purpose`. */
  context: string;
  /** 1-4 question items, whichever door escalate enters by. */
  questions: QuestionItem[];
  /** System-internal only — absent from the MCP tool schema and the JSON API: the failure question's and the
   *  premise breach's cancel option (ADR 0006 / 0121), or a broken-probe report's reason (ADR 0251), meaningful only
   *  for a single-item bundle. */
  question_kind?: Extract<QuestionKind, { kind: "failure" | "premise_breach" | "broken_probe" }>;
}

/** Escalation: a question child carrying a bundle of 1-4 items, each with
 *  2-4 choices and the registrant's recommendation (enforced at registration,
 *  like every question) — a single-item bundle is the degenerate case of the
 *  same shape (issue #30), not a distinct one. The parent returns to `todo`
 *  (blocked is derived from the unfinished question, never stored) and the slot
 *  is freed by the caller. The registered task's own `title` is the bundle's
 *  first item's — for the common single-item case this is exactly the
 *  question's own title, same as before the bundle existed. */
export function escalateTask(
  db: Db,
  parent: Task,
  input: EscalateInput,
  workerId: string,
  now: Date,
  origin: EventOrigin,
): Task {
  let question: Task;
  // 受験者の failure と escalation の答えとコメントはその対象にだけ届く、と人間に言う(ADR 0263 決定9)。前提の破綻は自分の文を持つ
  const onlyThisTarget = parent.interview_target_id !== null && input.question_kind?.kind !== "premise_breach";
  db.transaction(() => {
    question = registerTask(
      db,
      {
        type: "question",
        title: input.questions[0]!.title,
        purpose: onlyThisTarget ? `${input.context}${ONLY_THIS_TARGET_NOTICE}` : input.context,
        completion_criteria: "a human answer is recorded",
        parent_id: parent.id,
        question: input.questions,
        question_kind: input.question_kind,
      },
      now,
      workerId,
      origin,
    );
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(parent.id);
    appendEvent(db, {
      taskId: parent.id,
      workerId,
      origin,
      payload: { kind: "task_escalated", question_id: question.id },
      at: now,
    });
  })();
  return question!;
}

/** The unfinished-descendants sweep shared by both cancel paths (ADR 0006 /
 *  issue #130): collect the target and every one of its unfinished descendants
 *  and mark each cancelled, appending `payload` (built by the caller to name
 *  why — an abandon answer or a human's direct cancel) to each. `done`
 *  descendants are left untouched (nothing degrades a completed record);
 *  `cancelled` counts as finished for the blocked derivation, which is what
 *  lets the cancelled tree's own parent return to `todo` and pick up work
 *  again. The plan is discarded wholesale rather than branch-by-branch — no
 *  dependency edges exist between siblings to reason about, so a partial
 *  cancel can't be more correct than a full one. Returns the id of the event
 *  that cancelled `rootTaskId` itself (undefined when it was already settled) —
 *  the observation a target question's settlement cites (issue #1992). */
function cancelUnsettledSubtree(
  db: Db,
  rootTaskId: string,
  workerId: string,
  now: Date,
  payload: TaskScopedPayload,
  origin: EventOrigin,
): number | undefined {
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree(id) AS (
         SELECT ?
         UNION
         SELECT c.id FROM tasks c JOIN subtree s ON c.parent_id = s.id
       )
       SELECT subtree.id FROM subtree JOIN tasks ON tasks.id = subtree.id
       WHERE ${unsettledSql("tasks.status")}`,
    )
    .all(rootTaskId) as Array<{ id: string }>;
  let rootEventId: number | undefined;
  db.transaction(() => {
    for (const { id } of rows) {
      // a cancelled declarer holds nothing — the cancel is the record that ends its breach
      db.prepare("UPDATE tasks SET status = 'cancelled', premise_breach_decision = NULL WHERE id = ?").run(id);
      const eventId = appendEvent(db, { taskId: id, workerId, origin, payload, at: now });
      if (id === rootTaskId) rootEventId = eventId;
    }
  })();
  return rootEventId;
}

/** Cancel a task and every unfinished descendant via an abandon answer (ADR
 *  0006), or an Interview root via the answer that ended it (ADR 0247): the
 *  question the answer came from is named on every cancelled task. Internal
 *  only — answerQuestion is the sole caller; no MCP or JSON API surface. */
function cancelTask(
  db: Db,
  task: Task,
  originQuestionId: string,
  workerId: string,
  now: Date,
  origin: EventOrigin,
): number | undefined {
  return cancelUnsettledSubtree(db, task.id, workerId, now, {
    kind: "task_cancelled",
    origin_question_id: originQuestionId,
  }, origin);
}

/** What open quarantines stop, folded by `quarantine.ts`'s `quarantineStops`
 *  from each table row's scope (ADR 0137 決定6): execution workspaces, and the
 *  agent names an assignee-scoped row resolves to. Passed in because the
 *  dependency runs quarantine.ts → this module, never back (ADR 0137 決定1). */
export interface ResourceStops {
  workspaces: string[];
  assignees: string[];
}

/** The pointers the direct-cancel question gate's quarantine half resolves an
 *  unset workspace/assignee against (issue #130), same fallbacks the pickup
 *  gate uses (ADR 0009 / issue #36 / issue #42), plus what open quarantines
 *  stop. Absent `quarantined` → no quarantine gates any cancel. */
export interface CancelDefaults {
  defaultWorkspaceName?: string;
  defaultAgentName?: string;
  auditorName?: string;
  quarantined?: ResourceStops;
}

/** The direct-cancel question gate (issue #130, CONTEXT.md's Cancel): while a
 *  Tidepool-registered question whose subject lies in the cancelled subtree
 *  remains open, direct cancel is refused. Otherwise the question would be
 *  stranded and its answer-only state transition broken. Two families qualify:
 *
 *   - a **failure question** with `question_cancel_option` (watchdog kill or
 *     issue-backed deterministic failure) whose failed task lies in the
 *     subtree. Abandon cancels its abandon scope, so direct cancel would
 *     strand the question. PR-promotion failures are excluded: their target
 *     is already done and they carry no cancel option.
 *   - a **quarantine Confirmation** whose resource is used by a subtree task:
 *     the task's workspace or resolved assignee is in `defaults.quarantined`. */
function assertNoGatingQuestion(db: Db, taskId: string, defaults: CancelDefaults): void {
  const subtree = subtreeSql("@root");
  const failure = db
    .prepare(
      `${subtree}
       SELECT 1 FROM tasks q
       WHERE q.type = 'question' AND q.status = 'todo'
         AND q.question_cancel_option IS NOT NULL
         AND q.parent_id IN (SELECT id FROM subtree) LIMIT 1`,
    )
    .get({ root: taskId });
  if (failure) {
    throw new DomainError(
      "cannot directly cancel while an open Tidepool question with a cancel option (a failure or premise breach question) " +
        "stands over this subtree — answer it first; that answer is the only gate",
    );
  }
  const fallback = typeAwareDefaultAgentSql("x.type", "@defaultAgentName", "@auditorName");
  const quarantine = db
    .prepare(
      `${subtree}
       SELECT 1 FROM tasks x
       WHERE x.id IN (SELECT id FROM subtree)
         AND (COALESCE(x.workspace, @defaultWorkspaceName) IN (SELECT value FROM json_each(@workspaces))
           OR COALESCE(x.assignee, ${fallback}) IN (SELECT value FROM json_each(@assignees)))
       LIMIT 1`,
    )
    .get({
      root: taskId,
      defaultWorkspaceName: defaults.defaultWorkspaceName ?? null,
      defaultAgentName: defaults.defaultAgentName ?? null,
      auditorName: defaults.auditorName ?? null,
      workspaces: JSON.stringify(defaults.quarantined?.workspaces ?? []),
      assignees: JSON.stringify(defaults.quarantined?.assignees ?? []),
    });
  if (quarantine) {
    throw new DomainError(
      "cannot directly cancel while an open quarantine confirmation stands over this subtree's " +
        "resource — answer it first; that answer is the only gate",
    );
  }
}

/** The human's direct cancel (issue #130, CONTEXT.md's Cancel): the second
 *  cancel path beside abandon. Its scope line is wider than edit's (ADR 0198,
 *  `assertDirectlyCancellableScope` — human-authored or a board-registered
 *  root other than a question, unsettled, not in_progress), the target and
 *  its unfinished descendants go cancelled together (道連れ), the reason is optional and kept on every cancelled task's
 *  event. It is refused while a Tidepool question with the subtree as its
 *  subject is still open (`assertNoGatingQuestion`). No "delete" exists — this
 *  is always a cancel, and the record is never erased. A refused Interview
 *  target's question left with nothing to run it settles in the same
 *  transaction (`settleUnrunnableTargetQuestions`, issue #1992). */
export function cancelTaskDirectly(
  db: Db,
  task: Task,
  reason: string | null,
  now: Date,
  defaults: CancelDefaults,
  origin: EventOrigin,
): void {
  assertDirectlyCancellableScope(db, task);
  assertNoGatingQuestion(db, task.id, defaults);
  db.transaction(() => {
    const cancelEventId = cancelUnsettledSubtree(db, task.id, HUMAN_WORKER_ID, now, {
      kind: "task_cancelled_directly",
      reason,
    }, origin);
    if (cancelEventId !== undefined) settleUnrunnableTargetQuestions(db, task.id, cancelEventId, now);
  })();
}

/** The six pure preconditions an answer submission must clear before any
 *  caller may run a side effect on its behalf (issue #111): type is
 *  "question", status is still "todo", the answer count matches the
 *  question's item count, every answer is non-blank, for a fixed-choice question every answer is one
 *  of its item's declared options, and an answer `needsComment` lists
 *  carries a non-blank comment (ADR 0179). `answerQuestion` below calls this
 *  first as its own self-defense (a direct caller, e.g. a test, gets the
 *  same rejection it always has); see its call site in human-verbs.ts
 *  for why this must also run there, before any side effect. Returns the
 *  normalized answers those callers use for side effects and persistence. */
export function assertAnswerable(question: Task, answers: string[], comment: string | undefined): string[] {
  if (question.type !== "question") {
    throw new DomainError("only a question task can be answered");
  }
  if (question.status !== "todo") {
    throw new DomainError(`a ${question.status} question cannot be answered`);
  }
  const items = question.question_items!;
  // 項目の無い question は表の編集でだけ決着する Quarantine(ADR 0218 決定6)。項目数の食い違いより先に、答えの道が無いと言う
  if (items.length === 0) {
    throw new DomainError("this question takes no answer: it closes on its own once the repair it names is made");
  }
  if (answers.length !== items.length) {
    throw new DomainError(
      `this question carries ${items.length} item(s), but ${answers.length} answer(s) were submitted`,
    );
  }
  if (answers.some(whyBlank)) throw new DomainError("answers cannot be blank");
  answers = answers.map(normalizeText);
  if (isFixedChoiceQuestion(question)) {
    for (let i = 0; i < items.length; i++) {
      if (!items[i]!.options.includes(answers[i]!)) {
        throw new DomainError(
          `answer "${answers[i]}" is not one of item ${i}'s options: ${items[i]!.options.join(", ")}`,
        );
      }
    }
  }
  const needs = needsComment(question).filter((option) => answers.includes(option));
  if (needs.length > 0 && (comment === undefined || whyBlank(comment))) {
    throw new DomainError(`answering ${needs.join(" / ")} to this question requires a non-blank comment: why, or for a defer what is still undecided`);
  }
  return answers;
}

/** 着地 question(PR マージ・ローカル着地)か。push の遷移先(buildQuestionPushPayload)が使う(ADR 0190)。 */
export function isLandingQuestion(task: QuestionColumns<TierRef>): boolean {
  switch (questionKindOf(task).kind) {
    case "pr_merge":
    case "local_merge":
      return true;
    case "escalation":
    case "failure":
    case "premise_breach":
    case "broken_probe":
    case "approval":
    case "pr_promotion_retry":
    case "proposal":
    case "quarantine":
    case "cli_auth_expiry_warning":
      return false;
  }
}

/** 選択肢にない回答を断る固定選択肢の question か。門(assertAnswerable)と読み口(questionAnnotations の `free_text`)が使う(issue #1309)。
 *
 *  A system-registered question with a real external side effect (merge,
 *  PR promotion, pending-child materialization, retry-vs-abandon) commits
 *  to a fixed choice — a typo must not silently settle one as though it
 *  were an option (issue #105: a "retry" typo on a PR promotion failure
 *  question used to settle it with no retry and no recorded abandon
 *  either). This deliberately leaves two documented exceptions untouched:
 *  an agent's own escalate question, whose free-text override is a real
 *  feature (escalate.test.ts), and a Confirmation question (quarantine
 *  resolution), which takes any answer text as a repair note (CONTEXT.md's
 *  Quarantine) — neither carries this kind of consequence. */
export function isFixedChoiceQuestion(question: QuestionColumns<TierRef>): boolean {
  switch (questionKindOf(question).kind) {
    case "failure":
    case "premise_breach":
    case "broken_probe":
    case "approval":
    case "pr_merge":
    case "local_merge":
    case "pr_promotion_retry":
    case "proposal":
      return true;
    case "escalation":
    case "quarantine":
    case "cli_auth_expiry_warning":
      return false;
  }
}

/** この question で理由の comment が要る選択肢(ADR 0179 決定1〜4)。門(assertAnswerable)と読み口(questionAnnotations)が使う。 */
export function needsComment(question: QuestionColumns<TierRef>): string[] {
  const kind = questionKindOf(question);
  switch (kind.kind) {
    case "proposal":
      return kind.proposal.kind === "memory" ? ["reject", "defer"] : ["reject"];
    case "approval":
      return ["reject"];
    case "escalation":
    case "failure":
    case "premise_breach":
    case "broken_probe":
    case "pr_merge":
    case "local_merge":
    case "pr_promotion_retry":
    case "quarantine":
    case "cli_auth_expiry_warning":
      return [];
  }
}

/** The human steering channel: answer a question from the WebUI. One answer
 *  per item, in item order — the submission is atomic (issue #30): a length
 *  mismatch is refused outright and nothing is persisted, so a partial-answer
 *  state never exists. Each answer is either a picked option or a free-text
 *  override, either way a plain string. The question completes only once
 *  every item is answered; only a parent this answer actually unblocks
 *  returns to the queue head.
 *
 *  `stageUnblock` defers the head move: when given (an open triage session),
 *  the answer is just as durable but the unblocked parent is handed to the
 *  callback instead of moving — the queue only changes at triage commit.
 *
 *  Every system-internal special case below (abandon, quarantine
 *  confirmation, pending-child approval) is reachable only through a
 *  length-1 question (CONTEXT.md's Confirmation question / ADR 0006), so each
 *  reads `answers[0]` — the degenerate case of the same bundle shape, not a
 *  second code path.
 *
 *  Abandon (ADR 0006 / 0048): when the sole answer matches the declared
 *  cancel option, cancel the failed task's subtree plus unfinished sibling
 *  subtrees from the same decomposition decision. Without such provenance,
 *  only the failed task's subtree is cancelled. Its parent returns to the
 *  queue head only when no unfinished children it waits for remain, as before.
 *  An Interview pin child's abandon never moves the root to the head (ADR 0245
 *  決定5); the root is cancelled instead when the answer was a premise breach's,
 *  or when no done pin child and no unsettled child remain (ADR 0247 決定1・2) —
 *  a pin child's approval question rejected last ends the root the same way.
 *
 *  Quarantine resolution (ADR 0137 決定3・4): a Confirmation question (declared
 *  by `question_quarantine_kind`, system-internal) takes any answer at all as a
 *  repair confirmation — the caller has already run that kind's check and
 *  refused the answer if it failed (see human-verbs.ts). The open question is
 *  the quarantine's only state, so settling it is the release; every kind
 *  records the same `quarantine_released`. */
export function answerQuestion(
  db: Db,
  question: Task,
  answers: string[],
  now: Date,
  stageUnblock: ((taskId: string) => void) | undefined,
  /** The reject-reason steering channel (issue #40): one per submission
   *  (not per item). Required — non-blank — only for the options
   *  `needsComment` lists for this question (ADR 0179); optional for every
   *  other answer. Carried verbatim onto the
   *  `question_answered` event; omitted from the event payload entirely
   *  when absent, rather than stored as null, so an unanswered comment
   *  leaves the event shape exactly as it was before this existed. */
  comment: string | undefined,
  /** 提案の approve に添えた修正値(ADR 0150 決定2・ADR 0152 決定2)。検査は呼び手(submitAnswer)が済ませ、ここは comment と
   *  同じく event に運ぶだけ。修正つきの回答は推奨どおりに数えない。 */
  amendment: ProposalAmendment | undefined,
  origin: EventOrigin,
  /** retry が写す対象を既定 agent が走らせられるかの判定の口(ADR 0253 決定3)。Absent → 登録の扉と同じく検査しない。 */
  runnable?: { candidates: TaskExecutionCandidates; agentName?: string },
): Task {
  answers = assertAnswerable(question, answers, comment);
  const items = question.question_items!;
  const answer = answers[0]!;
  db.transaction(() => {
    db.prepare(
      "UPDATE tasks SET status = 'done', question_answer = ?, question_answer_comment = ? WHERE id = ?",
    ).run(JSON.stringify(answers), comment ?? null, question.id);
    // the recommender is whoever registered the question — carried on the
    // answer event so per-agent acceptance rates need no join
    appendEvent(db, {
      taskId: question.id,
      workerId: HUMAN_WORKER_ID,
      origin,
      payload: {
        kind: "question_answered",
        answers: answers.map((a, i) => ({
          answer: a,
          recommendation_accepted: a === items[i]!.recommendation && amendment === undefined,
        })),
        recommended_by: getRegistrant(db, question.id),
        ...(comment !== undefined && { comment }),
        ...(amendment !== undefined && { amendment }),
      },
      at: now,
    });

    const kind = questionKindOf(question);
    // awaitedChildSql がこの question を付帯子と判定すれば親はこの回答を待っていないので先頭へ戻さない(ADR 0049 / ADR 0120 決定3)
    const blockedParent = () => {
      const blockedParentId = questionBlocking(db, question.id);
      return blockedParentId ? getTask(db, blockedParentId) : undefined;
    };
    let unblockTarget: Task | undefined;
    switch (kind.kind) {
      case "quarantine":
        if (dropsRefusedTarget(kind, answer)) {
          dropInterviewTarget(db, question, now, origin);
          return;
        }
        appendEvent(db, {
          taskId: question.id,
          workerId: HUMAN_WORKER_ID,
          origin,
          payload: { kind: "quarantine_released", quarantine: kind.quarantine, value: kind.value },
          at: now,
        });
        return;
      case "failure":
      case "premise_breach": {
        const breach = kind.kind === "premise_breach";
        // 固定選択肢の question は出した選択肢でしか答えられず、retry を出すのは Interview の破綻の question だけ(ADR 0248 決定2)。
        // 失敗 question の "retry" は再実行の意味なので、種類で絞る
        const retry = breach && answer === "retry";
        if (answer !== kind.cancel_option && !retry) {
          unblockTarget = blockedParent();
          break;
        }
        const failed = getTask(db, question.parent_id!)!;
        const plan = failed.parent_id ? getTask(db, failed.parent_id) : undefined;
        let rootCancel: { rootId: string; eventId: number | undefined } | undefined;
        if (plan) {
          for (const id of abandonScopeIds(db, failed.id, breach)) {
            cancelTask(db, getTask(db, id)!, question.id, HUMAN_WORKER_ID, now, origin);
          }
          if (failed.interview_target_id === null) unblockTarget = plan;
          // pin の子の失敗は分解判断を破棄しないので、親は先頭へ戻さない(ADR 0245 決定5)。破綻した probe か、
          // 採点できる答案も未決着の子も残らない Interview は、この答えで終える(ADR 0247 決定1・2)
          else if (breach || interviewLeftEmpty(db, plan.id)) rootCancel = { rootId: plan.id, eventId: cancelTask(db, plan, question.id, HUMAN_WORKER_ID, now, origin) };
          if (retry) retryInterview(db, plan, premiseBreachReason(db, failed.id), comment, now, origin, runnable);
        } else {
          rootCancel = { rootId: failed.id, eventId: cancelTask(db, failed, question.id, HUMAN_WORKER_ID, now, origin) };
        }
        // retry の新しい root が登録された後で引く —— 先に引けば、写った対象の question が retry の直後に閉じる(ADR 0199 追記)
        if (rootCancel?.eventId !== undefined) settleUnrunnableTargetQuestions(db, rootCancel.rootId, rootCancel.eventId, now);
        break;
      }
      case "approval": {
        // pending-child approval question (issue #11): the child (out-of-
        // authority on risk and/or assignee) was never registered at decompose
        // time. "approve" materializes it now, for real, and — only if it
        // actually carries risk beyond its parent — raises the parent's own
        // risk flag to match (upward propagation). A "reject" answer leaves it
        // unregistered.
        const pending = kind.pending_child;
        if (answer === "approve") {
          registerTask(
            db,
            { type: "work", ...pending, parent_id: question.parent_id! },
            now,
            HUMAN_WORKER_ID,
            origin,
          );
          // "beyond its parent" is evaluated against the parent's current risk
          // flag, not a decompose-time snapshot: a second, unrelated (e.g.
          // assignee-only) approval on an already-risky parent propagates
          // nothing new and must not re-fire the audit event.
          if (raisesParentRisk(pending, getTask(db, question.parent_id!)!)) {
            db.prepare("UPDATE tasks SET risk_flag = 1 WHERE id = ?").run(question.parent_id);
            appendEvent(db, {
              taskId: question.parent_id!,
              workerId: HUMAN_WORKER_ID,
              origin,
              payload: { kind: "risk_flag_raised", origin_question_id: question.id },
              at: now,
            });
          }
        }
        unblockTarget = blockedParent();
        break;
      }
      case "broken_probe": {
        if (answer === "continue") {
          unblockTarget = blockedParent();
          break;
        }
        // abandon も retry も Interview を終える(ADR 0251 決定2 / ADR 0248 決定2・3)。子は全部決着済みで root は起こさない
        const root = getTask(db, question.parent_id!)!;
        cancelTask(db, root, question.id, HUMAN_WORKER_ID, now, origin);
        if (answer === "retry") retryInterview(db, root, kind.reason, comment, now, origin, runnable);
        break;
      }
      case "escalation":
      case "pr_merge":
      case "local_merge":
      case "pr_promotion_retry":
      case "proposal":
      case "cli_auth_expiry_warning":
        unblockTarget = blockedParent();
        break;
      default:
        kind satisfies never;
    }

    if (
      unblockTarget &&
      unblockTarget.status === "todo" &&
      !hasUnfinishedChildren(db, unblockTarget.id)
    ) {
      if (stageUnblock) stageUnblock(unblockTarget.id);
      else moveTask(db, unblockTarget, null, now, HUMAN_WORKER_ID, origin);
    }
  })();
  return getTask(db, question.id)!;
}

/** retry(ADR 0248 決定2・3 / ADR 0251 決定2): cancel した Interview と同じ欄・対象の一覧で新しい root を人間名義で登録し、破綻した
 *  probe と破綻の理由(pin の子の宣言か root の報告)を盤面名義の event で新しい root の history に渡す。写した対象が走れなければ
 *  人間の登録の扉と同じ判定で拒み、回答ごと巻き戻す(ADR 0253 決定3)。 */
function retryInterview(
  db: Db,
  previousRoot: Task,
  reason: string,
  comment: string | undefined,
  now: Date,
  origin: EventOrigin,
  runnable: { candidates: TaskExecutionCandidates; agentName?: string } | undefined,
): void {
  const { probe, rubric } = interviewProbe(db, previousRoot.id)!;
  const root = registerTask(
    db,
    {
      type: previousRoot.type,
      title: previousRoot.title,
      purpose: previousRoot.purpose,
      completion_criteria: previousRoot.completion_criteria,
      workspace: previousRoot.workspace ?? undefined,
      review_tier: previousRoot.review_tier ?? undefined,
      interview_targets: retriedTargets(db, previousRoot.id),
    },
    now,
    HUMAN_WORKER_ID,
    origin,
  );
  if (runnable) {
    assertTargetsRunnable(db, root.id, runnable.candidates, runnable.agentName, ' — fix the default agent\'s entry and answer "retry" again, or answer "abandon" and register the Interview again');
  }
  appendEvent(db, {
    taskId: root.id,
    workerId: BOARD_WORKER_ID,
    origin: "board",
    payload: {
      kind: "interview_retried",
      previous_root_id: previousRoot.id,
      probe,
      rubric,
      reason,
      ...(comment !== undefined && { comment }),
    },
    at: now,
  });
}

/** 断られた行でない対象の question への「この対象は測らない」(ADR 0199 決定4・追記): その対象を pin した未決着の子だけを、この
 *  question を出自に cancel する。兄弟も親も動かさないが、採点できる答案も未決着の子も残らない Interview はこの答えで終える
 *  (ADR 0247 決定1)。 */
function dropInterviewTarget(db: Db, question: Task, now: Date, origin: EventOrigin): void {
  // この question が止めている子
  const children = (
    db
      .prepare(
        `SELECT t.id FROM tasks t JOIN interview_targets it ON it.id = t.interview_target_id
         WHERE ${unsettledSql("t.status")} AND ${UNROWED_TARGET_SQL}
           AND @value = ${refusedTargetValueSql("@kind")}`,
      )
      .pluck()
      .all({ kind: question.question_quarantine_kind, value: question.question_quarantine_value }) as string[]
  ).map((id) => getTask(db, id)!);
  for (const child of children) cancelTask(db, child, question.id, HUMAN_WORKER_ID, now, origin);
  for (const rootId of new Set(children.map((child) => child.parent_id!))) {
    if (interviewLeftEmpty(db, rootId)) cancelTask(db, getTask(db, rootId)!, question.id, HUMAN_WORKER_ID, now, origin);
  }
}

/** 対象 `it` の、断られた対象の question の値の綴り(quarantine.ts の `tableRowValue` / `tableRowEffortValue`、effort の鍵だけ effort まで)。 */
const refusedTargetValueSql = (kindRef: string) =>
  `it.provider || '/' || it.model || CASE ${kindRef} WHEN 'interviewTargetEffort' THEN '/' || COALESCE(it.effort, '') ELSE '' END`;

/** 断られた対象の question の主題が盤面に残らなくなったときの門(ADR 0199 追記、issue #1992): cancel された Interview の root の
 *  対象の鍵の question のうち、その対象を走らせうる未決着の Interview —— その対象を pin した未決着の子か、まだその対象の子を持たない
 *  未決着の root —— が残らないものを、その root の cancel の event を観測として盤面名義に決着させる。別の鍵の question は
 *  この扉の観測ではないので触らない。 */
function settleUnrunnableTargetQuestions(db: Db, cancelledRootId: string, observedEventId: number, now: Date): void {
  const unrunnable = db
    .prepare(
      `SELECT q.id, q.question_quarantine_kind AS quarantine, q.question_quarantine_value AS value FROM tasks q
       WHERE q.type = 'question' AND q.status = 'todo' AND q.question_quarantine_kind IN (SELECT value FROM json_each(@kinds))
         AND EXISTS (
           SELECT 1 FROM interview_targets it
           WHERE it.task_id = @root AND q.question_quarantine_value = ${refusedTargetValueSql("q.question_quarantine_kind")})
         AND NOT EXISTS (
           SELECT 1 FROM interview_targets it JOIN tasks root ON root.id = it.task_id
           LEFT JOIN tasks child ON child.interview_target_id = it.id
           WHERE ${UNROWED_TARGET_SQL} AND q.question_quarantine_value = ${refusedTargetValueSql("q.question_quarantine_kind")}
             AND (${unsettledSql("child.status")} OR (child.id IS NULL AND ${unsettledSql("root.status")})))`,
    )
    .all({ kinds: JSON.stringify(REFUSED_TARGET_KINDS), root: cancelledRootId }) as Array<{ id: string; quarantine: string; value: string }>;
  for (const { id, ...released } of unrunnable) {
    settleQuestionAsObserved(db, id, { kind: "quarantine_released", ...released, observed_event_id: observedEventId }, now);
  }
}

/** retry が写す対象(ADR 0248 決定2・追記): 登録時の一覧から、断られた対象の question への「この対象は測らない」で外した対象だけを除く
 *  —— abandon / reject で外れた対象は写す。 */
function retriedTargets(db: Db, rootId: string): InterviewTarget[] {
  const children = listChildren(db, rootId);
  return targetRows(db, rootId)
    .filter(({ id }) => {
      const child = children.find((task) => task.interview_target_id === id);
      return !(child && refusedTargetQuestionOf(db, child));
    })
    .map(({ id: _, ...target }) => target);
}

/** 採点できる答案(done の pin の子)も未決着の子も残っていない Interview の root か(ADR 0247 決定1)。 */
function interviewLeftEmpty(db: Db, rootId: string): boolean {
  return db
    .prepare(`SELECT 1 FROM tasks WHERE parent_id = ? AND ((interview_target_id IS NOT NULL AND status = 'done') OR ${unsettledSql("status")}) LIMIT 1`)
    .get(rootId) === undefined;
}

/** The scope shared by abandon and held (ADR 0048): the failed task itself,
 *  plus siblings from the same decision only when the failed task has one.
 *  An Interview pin child's failure scope stops at itself (ADR 0245 決定5); its
 *  premise-breach scope (`breachSql` true) keeps the siblings (決定2).
 *  The explicit IS NOT NULL guard prevents the SQL analogue of null === null. */
function abandonScopeSql(failedRef: string, candidateRef: string, breachSql: string): string {
  return `(
    ${unsettledSql(`${candidateRef}.status`)}
    AND (
      ${candidateRef}.id = ${failedRef}.id
      OR (
        ${failedRef}.based_on_decision IS NOT NULL
        AND ${candidateRef}.parent_id = ${failedRef}.parent_id
        AND ${candidateRef}.id <> ${failedRef}.id
        AND ${candidateRef}.based_on_decision = ${failedRef}.based_on_decision
        AND (${failedRef}.interview_target_id IS NULL OR ${breachSql})
      )
    )
  )`;
}

/** Declare a premise breach (ADR 0121): the decomposition decision this child rests
 *  on is false. Holds the declarer's abandon scope until the decision's author judges.
 *  Not a failure — the task stays unsettled and the caller frees the slot. */
export function declarePremiseBreach(
  db: Db,
  task: Task,
  reason: string,
  workerId: string,
  now: Date,
  origin: EventOrigin,
): Task | undefined {
  if (task.type !== "work" || task.based_on_decision === null) {
    throw new DomainError(
      "only a child of a decomposition decision can declare a premise breach — " +
        "a root task or an attached child escalates instead",
    );
  }
  const decision = task.based_on_decision;
  let question: Task | undefined;
  db.transaction(() => {
    const { prior } = db
      .prepare(
        "SELECT COUNT(*) AS prior FROM events WHERE kind = 'premise_breached' AND json_extract(payload, '$.based_on_decision') = ?",
      )
      .get(decision) as { prior: number };
    appendEvent(db, {
      taskId: task.id,
      workerId,
      origin,
      payload: { kind: "premise_breached", line: reason, based_on_decision: decision },
      at: now,
    });
    db.prepare("UPDATE tasks SET status = 'todo', premise_breach_decision = ? WHERE id = ?").run(decision, task.id);
    // Interview の pin の子、書き手が人間、または同じ判断への2度目以降 —— 人間が判断する(ADR 0248 決定1)
    const interview = task.interview_target_id !== null;
    if (!interview && getEvent(db, decision)?.worker_id !== HUMAN_WORKER_ID && prior === 0) return;
    const posed = interview ? interviewProbe(db, task.parent_id!)! : undefined;
    question = escalateTask(
      db,
      task,
      {
        context:
          `${reason}\n\n` +
          (posed ? `The posed probe: ${posed.probe}\nIts rubric: ${posed.rubric}\n\n` : "") +
          `"continue" keeps the decomposition decision and resumes this task. ` +
          abandonConsequence(db, task, true) +
          // continue のコメントは宣言者にも届けない(ADR 0263 決定8)。この purpose ごと受験者の history から伏せる
          (interview ? ` A comment given with "continue" reaches no target of this Interview; to fix the probe, answer "retry".` : ""),
        questions: [
          {
            title: `premise breach: ${task.title}`,
            options: interview ? ["continue", "abandon", "retry"] : ["continue", "abandon"],
            recommendation: "continue",
          },
        ],
        question_kind: { kind: "premise_breach", cancel_option: "abandon", breached_decision: decision },
      },
      BOARD_WORKER_ID,
      now,
      "board",
    );
    resolvePremiseBreach(db, task.id, "question", BOARD_WORKER_ID, now, "board");
  })();
  return question;
}

/** The id of the child of `parentId` whose premise breach is open — the precondition of both
 *  parent verbs, and the refusal of plain decompose. */
function openPremiseBreachChildId(db: Db, parentId: string): string | undefined {
  const row = db
    .prepare("SELECT id FROM tasks WHERE parent_id = ? AND premise_breach_decision IS NOT NULL LIMIT 1")
    .get(parentId) as { id: string } | undefined;
  return row?.id;
}

function requireOpenPremiseBreachChildId(db: Db, parentId: string): string {
  const id = openPremiseBreachChildId(db, parentId);
  if (id === undefined) throw new DomainError("no child of this task has an open premise breach");
  return id;
}

/** 続行(ADR 0121): 親の判断を判断ログ1行に置き、held を解く。親は blocked の todo に戻る。 */
export function continueDecomposition(
  db: Db,
  parent: Task,
  line: string,
  workerId: string,
  now: Date,
  origin: EventOrigin,
): void {
  const declarerId = requireOpenPremiseBreachChildId(db, parent.id);
  db.transaction(() => {
    logDecision(db, parent, line, workerId, now, origin);
    resolvePremiseBreach(db, declarerId, "continue", workerId, now, origin);
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(parent.id);
  })();
}

/** 再分解(ADR 0121): 破綻した判断の未決着の子を cancel し、新しい decompose を1 transaction で行う。 */
export function redecompose(
  db: Db,
  parent: Task,
  input: DecomposeInput,
  workerId: string,
  now: Date,
  authority: AuthorityContext | undefined,
  isProtectedWorkspace: ((name: string) => boolean) | undefined,
  origin: EventOrigin,
): Task[] {
  // ADR 0245 決定3: Interview の root は作り直さない
  if (interviewTargets(db, parent.id) !== null) {
    throw new DomainError(
      "an Interview is not redecomposed: a broken probe is the human's premise-breach question to settle (continue, abandon or retry)",
    );
  }
  const declarerId = requireOpenPremiseBreachChildId(db, parent.id);
  return db.transaction(() => {
    for (const id of abandonScopeIds(db, declarerId, true)) {
      cancelUnsettledSubtree(db, id, workerId, now, { kind: "task_cancelled", origin_breach_task_id: declarerId }, origin);
    }
    resolvePremiseBreach(db, declarerId, "redecompose", workerId, now, origin);
    return decomposeTask(db, parent, input, workerId, now, authority, isProtectedWorkspace, origin);
  })();
}

function resolvePremiseBreach(
  db: Db,
  declarerId: string,
  outcome: Extract<EventPayload, { kind: "premise_breach_resolved" }>["outcome"],
  workerId: string,
  now: Date,
  origin: EventOrigin,
): void {
  db.prepare("UPDATE tasks SET premise_breach_decision = NULL WHERE id = ?").run(declarerId);
  appendEvent(db, {
    taskId: declarerId,
    workerId,
    origin,
    payload: { kind: "premise_breach_resolved", outcome },
    at: now,
  });
}

const INTERVIEW_FAILURE_END_CONSEQUENCE = "If no other target of this Interview is done or still unsettled, the Interview ends too.";
/** 受験者の failure と escalation の question の context の末尾に盤面が足す、人間だけが読む文(ADR 0263 決定9)。受験者の history は外す。 */
const ONLY_THIS_TARGET_NOTICE = "\n\nThe answer and comment reach only this target of the Interview.";

/** Canonical English abandon consequence baked into failure questions
 *  (ADR 0015 / 0048) and breach questions (ADR 0121, `breach`). It states the decision-discard
 *  rule and count only when unfinished same-decision siblings are in the abandon scope; an Interview pin child's
 *  wording says instead that the Interview ends (breach, alongside retry: ADR 0248) or may end (failure) (ADR 0247). */
export function abandonConsequence(db: Db, task: Task, breach = false): string {
  // derived from the cancel/held scope so the wording cannot drift
  const siblingCount = abandonScopeIds(db, task.id, breach).filter((id) => id !== task.id).length;
  const siblings = `${siblingCount} unfinished ${siblingCount === 1 ? "sibling" : "siblings"} from the same decomposition decision`;
  // ADR 0247 決定1・2: pin の子の abandon は Interview を終えうる。失敗は兄弟の行方を登録時に知らないので条件付き
  if (task.interview_target_id !== null) {
    return breach
      ? `"abandon" ends this Interview — it cancels this task's remaining work${siblingCount > 0 ? ` plus ${siblings}` : ""} ` +
          `and the Interview itself, so no answer to this probe is scored. "retry" ends it the same way and registers a new Interview ` +
          `in your name with the same targets and purpose; its root reads this probe, its rubric, this reason and your comment before posing a new probe.`
      : `"abandon" cancels this task and its remaining work. ${INTERVIEW_FAILURE_END_CONSEQUENCE}`;
  }
  return siblingCount > 0
    ? `"abandon" discards this decomposition decision — this task's remaining work plus ${siblings} — ` +
        `and returns the parent to the queue head to replan.`
    : `"abandon" cancels this task and its remaining work.`;
}

/** The ids in `failedId`'s abandon scope, shared by the abandon cascade, redecompose, and abandon's wording. */
function abandonScopeIds(db: Db, failedId: string, breach: boolean): string[] {
  return (
    db
      .prepare(
        `SELECT candidate.id
         FROM tasks candidate JOIN tasks failed ON failed.id = ?
         WHERE ${abandonScopeSql("failed", "candidate", breach ? "1" : "0")}`,
      )
      .all(failedId) as Array<{ id: string }>
  ).map(({ id }) => id);
}

/** Record an in-authority decision as one log line and move on. The log is the
 *  events table itself (human-facing kinds), never a separate entity. */
export function logDecision(
  db: Db,
  task: Task,
  line: string,
  workerId: string,
  now: Date,
  origin: EventOrigin,
): number {
  if (whyBlank(line)) throw new DomainError("a decision requires a line");
  line = normalizeText(line);
  return appendEvent(db, {
    taskId: task.id,
    workerId,
    origin,
    payload: { kind: "decision_logged", line },
    at: now,
  });
}

/** 出題済みの Interview の root の出口(ADR 0251 決定5): 拒否文は escalate でなくこの2つを指す。 */
const POSED_INTERVIEW_EXITS = "score every done answer with complete_interview, or report the probe broken with report_broken_probe";

/** 出題(ADR 0253 決定1・3): Interview の root が題・probe・完了基準・rubric を一度に書く。1つの transaction で、型つきの欄を持つ
 *  判断ログの1件と、一覧の対象ごとに pin の子を一覧の順に1つ入れ、root を blocked にする。子は全部同じ出題の値で、assignee は
 *  未指定(既定 agent)、workspace は親から、登録者は root の agent。決裁権の検査は通らない —— root が子ごとに選ぶものが無い。 */
export function poseProbe(db: Db, root: Task, input: InterviewProbe, workerId: string, now: Date, origin: EventOrigin, head?: string): Task[] {
  const targets = targetRows(db, root.id);
  if (!targets.length) throw new DomainError("only an Interview root poses a probe");
  if (interviewProbe(db, root.id) !== null) {
    throw new DomainError(`this Interview's probe is already posed and is not posed again: ${POSED_INTERVIEW_EXITS}`);
  }
  const probe = { ...input };
  for (const field of ["title", "probe", "completion_criteria", "rubric"] as const) {
    if (whyBlank(probe[field])) throw new DomainError(`a probe requires a ${field}`);
    probe[field] = normalizeText(probe[field]);
  }
  return db.transaction(() => {
    const decisionId = appendEvent(db, {
      taskId: root.id,
      workerId,
      origin,
      payload: {
        kind: "decision_logged",
        line: `Posed the Interview probe "${probe.title}". Probe: ${probe.probe} Completion criteria: ${probe.completion_criteria} Rubric: ${probe.rubric}`,
        interview_probe: probe,
        head,
      },
      at: now,
    });
    const children = targets.map(({ id, tier }) =>
      registerTask(
        db,
        {
          type: "work",
          title: probe.title,
          purpose: probe.probe,
          completion_criteria: probe.completion_criteria,
          tier,
          workspace: root.workspace ?? undefined,
          parent_id: root.id,
          based_on_decision: decisionId,
          interview_target_id: id,
        },
        now,
        workerId,
        origin,
      ),
    );
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(root.id);
    return children;
  })();
}

/** Interview の root の出題の型つきの欄(ADR 0253 決定1)。出題前・Interview でない task は null。 */
function interviewProbe(db: Db, rootId: string): InterviewProbe | null {
  for (const { payload } of taskDecisionLog(db, rootId)) {
    if (payload.kind === "decision_logged" && payload.interview_probe) return payload.interview_probe;
  }
  return null;
}

/** 採点完了(ADR 0253 決定4 / ADR 0199 / ADR 0181 決定4): 出題済みの Interview の root が、決着した pin の子のうち done の子
 *  全部をちょうど1回ずつ採点し、findings の handoff(outcome 必須)と一度に渡す。1つの transaction で各子に採点の注釈を書き、
 *  今の完了の処理で root を done にする。どの拒否でも何も書かない。 */
export function completeInterview(
  db: Db,
  root: Task,
  { scores, handoff }: { scores: Array<{ child_id: string; outcome: InterviewOutcome }>; handoff: Partial<HandoffDoc> | undefined },
  workerId: string,
  now: Date,
  origin: EventOrigin,
): Task {
  if (interviewTargets(db, root.id) === null) throw new DomainError("only an Interview root completes with complete_interview");
  if (interviewProbe(db, root.id) === null) throw new DomainError("this Interview has no probe to score yet: pose it with pose_probe first");
  if (handoff?.outcome === undefined || whyBlank(handoff.outcome)) throw new DomainError("complete_interview requires the findings in handoff.outcome");
  const pins = new Map(listChildren(db, root.id).flatMap((child) => (child.interview_target_id === null ? [] : [[child.id, child] as const])));
  const scored = new Set<string>();
  for (const { child_id } of scores) {
    const child = pins.get(child_id);
    if (!child) throw new DomainError(`${child_id} is not a child of this Interview`);
    if (child.status !== "done") throw new DomainError(`${child_id} is not done: only a done child is scored`);
    if (scored.has(child_id)) throw new DomainError(`${child_id} is scored more than once: score each done child exactly once`);
    scored.add(child_id);
  }
  const unscored = [...pins.values()].filter((child) => child.status === "done" && !scored.has(child.id)).map(({ id }) => id);
  if (unscored.length > 0) throw new DomainError(`score every done child exactly once; unscored: ${unscored.join(", ")}`);
  // 未決着の子が残る root は、finishTask の拒否で同じ transaction ごと巻き戻る
  return db.transaction(() => {
    for (const { child_id, outcome } of scores) {
      appendEvent(db, { taskId: child_id, workerId, origin, payload: { kind: "interview_scored", outcome }, at: now });
    }
    return finishTask(db, root, handoff, workerId, now, origin);
  })();
}

/** probe の破綻の報告(ADR 0251 決定1〜3): 出題済みの Interview の root が、理由と推奨(abandon / retry)をつけて人間に問う。
 *  escalate と同じく root の agent 名義の question を立てて root を blocked にする。報告は Interview 1件につき1回。 */
export function reportBrokenProbe(
  db: Db,
  root: Task,
  { reason, recommendation }: { reason: string; recommendation: "abandon" | "retry" },
  workerId: string,
  now: Date,
  origin: EventOrigin,
): Task {
  if (interviewTargets(db, root.id) === null) throw new DomainError("only an Interview root reports a broken probe");
  const posed = interviewProbe(db, root.id);
  if (posed === null) throw new DomainError("this Interview has no probe yet: pose it with pose_probe first");
  if (brokenProbeReported(db, root.id)) {
    throw new DomainError(
      "this Interview's probe was already reported broken once and the human answered continue: score every done answer with complete_interview, or escalate if you still disagree",
    );
  }
  const answers = listChildren(db, root.id).filter((child) => child.interview_target_id !== null && child.status === "done");
  return escalateTask(
    db,
    root,
    {
      context:
        `${reason}\n\nThe posed probe: ${posed.probe}\nIts rubric: ${posed.rubric}\n` +
        `The done answers (open each to read it): ${answers.map(({ id }) => id).join(", ")}\n\n` +
        `"continue" wakes this Interview's root to score every done answer and complete. "abandon" ends this Interview. ` +
        `"retry" ends it the same way and registers a new Interview with the same targets and purpose, showing its root the broken probe and this reason.`,
      questions: [{ title: `broken probe: ${root.title}`, options: ["continue", "abandon", "retry"], recommendation }],
      question_kind: { kind: "broken_probe", reason },
    },
    workerId,
    now,
    origin,
  );
}

/** この Interview の root が probe の破綻を報告したことがあるか(答えの後も含む)。 */
function brokenProbeReported(db: Db, rootId: string): boolean {
  return db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND question_broken_probe_reason IS NOT NULL LIMIT 1").get(rootId) !== undefined;
}

export interface ChildSpec extends TaskContent {
  review_by?: string[];
  review_tier?: string;
  /** Declares this child has external effect (CONTEXT.md's risk flag). A
   *  child riskier than its parent is out of the registering worker's
   *  authority: decomposeTask converts it into an approval question rather
   *  than registering it (ADR 0002 / issue #11). */
  risk_flag?: boolean;
  /** Pre-assigns the child to a specific worker. Outside the registering
   *  worker's authority profile's `assignable_to` (confused-deputy
   *  prevention), this too converts to an approval question (issue #11). */
  assignee?: string;
  /** Targets the child at a specific workspace. Outside the registering
   *  worker's authority profile's `allowed_workspaces`, this too converts to
   *  an approval question (issue #11). Absent → inherits the parent's. */
  workspace?: string;
  /** Opts this child into on-completion review (layer 1), same as
   *  RegisterTaskInput's own field — the registrant declares it, human or
   *  agent, with no authority check either way (ADR 0021: review flag opt-in
   *  sits outside the authority checks above, unlike risk_flag/assignee/
   *  workspace). */
  review_flag?: boolean;
  /** The child's own execution request (CONTEXT.md「要求」): the decomposing
   *  parent's judgement about how hard this slice is, carried into the
   *  child's own pickup. Same open-string posture as RegisterTaskInput. */
  tier?: string;
  priority?: string;
}

/** The registering worker's authority, resolved by the caller (the MCP layer)
 *  against the board's one configured profile (issue #11) — decomposeTask
 *  itself stays free of any registry/file-loading dependency. */
interface AuthorityContext {
  assignable_to?: string[];
  allowed_workspaces?: string[];
  /** The merge dial (issue #11, three-valued since ADR 0079 — see registry.ts):
   *  `escalate` makes recordPrOpened register a merge-decision question for
   *  every PR; `auto_if_ci_green` queues it for the unattended poll (landing.ts);
   *  `external` leaves it to GitHub. Undefined stays possible on this code-side
   *  type — a hand-built profile (the reviewer floor, ADR 0013) carries no dial
   *  — and is inert like `external`. */
  merge?: MergeDial;
}

/** Options fixed by the server for a merge-decision question (issue #11) —
 *  answerQuestion recognizes this exact pair via question_pending_merge_pr,
 *  same shape as the pending-child mechanism's fixed options. */
export const MERGE_QUESTION_OPTIONS = ["merge", "hold"] as const;

export const PR_PROMOTION_FAILURE_OPTIONS = ["retry", "abandon promotion"] as const;

/** Registers the merge-decision question every merge escalation shares
 *  (the `escalate` dial, and `auto_if_ci_green`'s risky-task and CI-failure
 *  fallbacks) — only the title/purpose/recommendation differ per caller. Always
 *  under the board's name: the board's rule raises it, whoever opened the PR
 *  (ADR 0194 決定3).
 *  Exported so landing.ts's CI-failure fallback shares this exact shape too,
 *  rather than redeclaring it (they must never drift apart). */
export function registerMergeQuestion(
  db: Db,
  task: Task,
  prNumber: number,
  purpose: string,
  recommendation: (typeof MERGE_QUESTION_OPTIONS)[number],
  now: Date,
): void {
  const title = `merge PR #${prNumber}: ${task.title}`;
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose,
      completion_criteria: "a human decides whether to merge",
      question: [{ title, options: [...MERGE_QUESTION_OPTIONS], recommendation }],
      question_kind: { kind: "pr_merge", pr: prNumber },
      // carries the originating work task's execution workspace (issue #26 /
      // ADR 0009), so submitAnswer's live CI check and the auto-merge
      // poll both resolve the right registry entry, not just the board's
      // default — a plain top-level question with no parent would otherwise
      // never inherit it
      workspace: task.workspace ?? undefined,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
}

/** merge question は PR 番号しか持たないので、着地するタスクは「同じ workspace で
 *  その PR を開いたタスク」で引く(PR 番号は repo 内でしか一意でない)。`recordPrOpened`
 *  が `pr_number` を書いてから question を立てるので、開いている question には必ず対応
 *  する行がある。 */
export function taskIdForPr(db: Db, prNumber: number, workspace: string | null): string {
  const row = db
    .prepare("SELECT id FROM tasks WHERE pr_number = ? AND workspace IS ?")
    .get(prNumber, workspace) as { id: string } | undefined;
  // 引けないなら門を素通りさせず止める(fail-closed — ADR 0092 決定5 は UI に依らず盤面が守る)
  if (!row) throw new DomainError(`cannot merge: no task in this workspace opened PR #${prNumber}`);
  return row.id;
}

/** 観測決着の1つの綴り: `status='todo'` 限定の UPDATE で question を閉じ、盤面名義の
 *  観測 event を1件だけ残す。`answerQuestion` を通さないので `question_answered` も
 *  決定ログも立たない —— 誰も決めていないものを決定として読み戻させないため。
 *  既に閉じた question を二度目の観測が再スタンプしないのも同じ1本で守る。観測 event は
 *  既定で question に、PR の決着なら `recordOn`(PR を開いた根)に刻み(ADR 0265 決定1)、根が既に
 *  決着を持っていれば null で刻まない —— question だけを閉じる。 */
export function settleQuestionAsObserved(
  db: Db,
  questionId: string,
  payload: TaskScopedPayload,
  now: Date,
  recordOn: string | null = questionId,
): void {
  db.transaction(() => {
    const { changes } = db
      .prepare("UPDATE tasks SET status = 'done' WHERE id = ? AND status = 'todo'")
      .run(questionId);
    if (changes === 0 || recordOn === null) return;
    appendEvent(db, {
      taskId: recordOn,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload,
      at: now,
    });
  })();
}

/** Queues a completed low-risk task's PR for the auto_if_ci_green poll (issue
 *  #11) — recordPrOpened's low-risk branch is the only writer; the landing
 *  module (landing.ts) is the only reader/deleter. */
function queuePendingAutoMerge(db: Db, taskId: string, prNumber: number): void {
  db.prepare("INSERT INTO pending_auto_merges (task_id, pr_number) VALUES (?, ?)").run(
    taskId,
    prNumber,
  );
}

/** The task's PR number — set when the board opens its PR, and when landing finds one already on the
 *  task branch (ADR 0241 決定4). Callers pair it with the event that says how the PR was met. */
export function recordPrNumber(db: Db, taskId: string, prNumber: number): void {
  db.prepare("UPDATE tasks SET pr_number = ? WHERE id = ?").run(prNumber, taskId);
}

/** Records that a completed task's work opened a PR (issue #11): pr_number is
 *  set once, paired with a pr_opened event — the invariant lives here, not in
 *  the MCP layer's PR side effect, per ADR 0002. The merge dial then decides
 *  what happens next: `escalate` always asks a human before merging, via a
 *  merge-decision question whose "merge" answer submitAnswer gates on a
 *  live CI check (never performed here — this module stays free of any
 *  GitHubClient dependency). `auto_if_ci_green` asks the same way for a task
 *  that carries risk (never silently auto-merges a risky change, regardless
 *  of the dial); a low-risk task instead queues for the unattended CI poll
 *  (landing.ts). `external` leaves the merge to GitHub's own PR surface: the PR
 *  opens and the board takes no further action — a declared inertness, not a
 *  residual one, so it is spelled as its own case below (ADR 0079).
 *  A task executing against a protected workspace
 *  (CONTEXT.md / ADR 0013) always asks, same as `escalate`, overriding
 *  whatever dial (including none) the executing worker's profile carries —
 *  "PR to a protected workspace always needs a human merge" is a
 *  resource-side invariant, independent of the dial. */
export function recordPrOpened(
  db: Db,
  task: Task,
  prNumber: number,
  sha: string,
  workerId: string,
  now: Date,
  authority: AuthorityContext | undefined,
  isProtected: boolean | undefined,
  origin: EventOrigin,
): void {
  db.transaction(() => {
    recordPrNumber(db, task.id, prNumber);
    appendEvent(db, {
      taskId: task.id,
      workerId,
      origin,
      payload: { kind: "pr_opened", pr_number: prNumber, sha },
      at: now,
    });
    const ask = (purpose: string) =>
      registerMergeQuestion(db, task, prNumber, purpose, "merge", now);
    const landing = landingSurface(isProtected, authority?.merge, task.risk_flag);
    switch (landing.surface) {
      case "merge_question":
        ask(
          {
            protected:
              `"${task.title}" completed and opened PR #${prNumber} against a protected ` +
              `workspace — always needs a human merge, regardless of the merge dial. Merge it now?`,
            dial: `"${task.title}" completed and opened PR #${prNumber}. Merge it now?`,
            risk:
              `"${task.title}" completed and opened PR #${prNumber}, but carries risk — ` +
              `auto_if_ci_green never auto-merges a risky task. Merge it now?`,
          }[landing.reason],
        );
        break;
      case "auto_merge_queue":
        queuePendingAutoMerge(db, task.id, prNumber);
        break;
      case "outside_board":
        break;
    }
  })();
}

/** 着地の面の判定(ADR 0217 決定1): PR を開く時点の recordPrOpened と、無人 merge の
 *  poll(landing.ts)の両方がこれを呼ぶ。着地の面は人間の merge 判断が住む場所で、3つある
 *  (ADR 0079 決定1): 盤面の merge question / 無人 merge キュー / 盤面の外(`external` の
 *  PR 面)。question 面へ倒れる理由(保護・ダイヤル・risk)は3つあるが面は1つで、違うのは
 *  question 本文に書く理由だけなので `reason` で返す。保護はダイヤルに依らない資源側の
 *  不変条件なので最初に読む。`external` は宣言された不作為(ADR 0079 決定2)で、盤面の外。
 *  ダイヤル無し(undefined)に届くのは registry の無い盤面(profile を解決しない)だけで、
 *  同じく盤面の外 —— 組み込みの reviewer profile は work を走らせないので届かない(ADR 0228)。 */
export function landingSurface(
  isProtected: boolean | undefined,
  merge: MergeDial | undefined,
  riskFlag: number,
):
  | { surface: "merge_question"; reason: "protected" | "dial" | "risk" }
  | { surface: "auto_merge_queue" }
  | { surface: "outside_board" } {
  if (isProtected) return { surface: "merge_question", reason: "protected" };
  switch (merge) {
    case "escalate":
      return { surface: "merge_question", reason: "dial" };
    case "auto_if_ci_green":
      return riskFlag
        ? { surface: "merge_question", reason: "risk" }
        : { surface: "auto_merge_queue" };
    case "external":
    case undefined:
      return { surface: "outside_board" };
  }
}

/** The explicit "unrestricted" marker an assignable_to/allowed_workspaces
 *  allowlist can carry (issue #41) — a registry profile must spell this out
 *  rather than get it by omitting the field. */
export const AUTHORITY_WILDCARD = "*";

/** A requested value is out of authority only when it's explicitly stated
 *  (an unstated value never itself needs approval) and the profile actually
 *  restricts it (no allowlist configured means unrestricted, same as an
 *  allowlist carrying the explicit wildcard AUTHORITY_WILDCARD — issue #41: a
 *  registry profile must spell out "unrestricted" rather than get it by
 *  omission, but the meaning is unchanged). Shared by the assignable_to and
 *  allowed_workspaces checks in decomposeTask — risk_flag's check is its own
 *  shape (compared against the parent's flag, not a list). */
function outsideAuthority(value: string | undefined, allowlist: string[] | undefined): boolean {
  return (
    value !== undefined &&
    allowlist !== undefined &&
    !allowlist.includes(AUTHORITY_WILDCARD) &&
    !allowlist.includes(value)
  );
}

/** The one executor a review task's `assignable_to` can never restrict (ADR
 *  0013 / 0054): the reviewed task's own executor — a review's repair
 *  children may always target them, since that's part of what a review *is*,
 *  not a delegation the reviewer happens to hold. Exported so callers that
 *  need to predict decomposeTask's own verdict (mcp.ts's `list_agents`, issue
 *  #43 / ADR 0014) share this exact lookup rather than reimplementing it and
 *  risking drift from decomposeTask's actual check below. */
export function reviewedTaskExecutor(db: Db, task: Task): string | undefined {
  if (task.type !== "review" || !task.parent_id) return undefined;
  const reviewed = getTask(db, task.parent_id);
  if (!reviewed) return undefined;
  if (reviewed.assignee !== null) return reviewed.assignee;
  return (
    latestEventOfTask(db, task.parent_id, "task_completed") ?? latestEventOfTask(db, task.parent_id, "task_picked_up")
  )?.worker_id;
}

/** Whether assigning `name` from `task` would need a human approval question
 *  rather than registering outright — the single source decomposeTask's own
 *  per-child check below and mcp.ts's `list_agents` roster marking (issue
 *  #43 / ADR 0014) both call, so the two can never diverge: the ADR 0013
 *  reviewed-executor exemption first, then the plain `assignable_to` check. */
export function assigneeNeedsApproval(
  db: Db,
  task: Task,
  name: string | undefined,
  authority: AuthorityContext | undefined,
): boolean {
  if (name !== undefined && name === reviewedTaskExecutor(db, task)) return false;
  return outsideAuthority(name, authority?.assignable_to);
}

/** Options fixed by the server for a pending-child approval question (issue
 *  #11) — not a caller-supplied QuestionSpec, so answerQuestion recognizes
 *  this exact pair rather than a free-form escalation. */
const PENDING_CHILD_OPTIONS = ["approve", "reject"] as const;

interface DecomposeInput {
  reason: string;
  children: ChildSpec[];
}

/** Decomposition: one decision splits the remaining work into child tasks.
 *  One atomic call — the reason lands as a decision-log entry, the children
 *  join the queue tail in order, and the parent returns to `todo` (derived
 *  blocked) until every child is done. It then becomes pickable again in
 *  plain queue order — no head jump (ADR 0003) — to integrate and complete
 *  for real: completion is recorded only once the whole criteria are met. */
export function decomposeTask(
  db: Db,
  parent: Task,
  input: DecomposeInput,
  workerId: string,
  now: Date,
  authority: AuthorityContext | undefined,
  /** Whether an explicitly named workspace is protected (CONTEXT.md's
   *  protected workspace / ADR 0013), resolved by the caller against the
   *  registry. A protected target converts unconditionally, regardless of
   *  the registering worker's `allowed_workspaces` — "changes to it always
   *  need human approval" is a resource-side invariant independent of any
   *  profile. Absent → no workspace is protected. */
  isProtectedWorkspace: ((name: string) => boolean) | undefined,
  origin: EventOrigin,
): Task[] {
  // ADR 0245 決定1: pin の子の下は分けない(人間の扉も redecompose もここを通る)
  if (parent.interview_target_id !== null) {
    throw new DomainError("this task is not split: complete it as one task and state in its handoff what remains");
  }
  // ADR 0253 決定1・5: Interview の root は分けない —— 出題で進む
  if (interviewTargets(db, parent.id) !== null) {
    throw new DomainError(
      interviewProbe(db, parent.id) === null
        ? "an Interview root is not decomposed: pose its probe with pose_probe and the board registers one child per target"
        : `an Interview root is not decomposed: ${POSED_INTERVIEW_EXITS}`,
    );
  }
  if (openPremiseBreachChildId(db, parent.id) !== undefined) {
    throw new DomainError("a child's premise breach is open — the decomposition's author judges it first (redecompose or continue_decomposition)");
  }
  input = {
    ...input,
    children: input.children.map((child) => {
      child = { ...child };
      for (const field of ["title", "purpose", "completion_criteria", "tier", "review_tier", "priority"] as const) {
        if (child[field] !== undefined) child[field] = normalizeText(child[field]);
      }
      if (child.review_by) child.review_by = child.review_by.map(normalizeText);
      return child;
    }),
  };
  if (input.children.length === 0) {
    throw new DomainError("a decomposition carries at least one child task");
  }
  // before anything registers: a child whose request is a bad value must not
  // survive as a pending_child on an approval question, where it would only
  // throw at the moment a human clicks approve (registerTask validates the
  // *question*, not the spec it carries).
  for (const child of input.children) {
    assertGithubRef({ type: "work", ...child });
    assertExecutionRequest(db, { type: "work", ...child });
    assertReviewFieldsTakeEffect({ type: "work", parent_id: parent.id, ...child }, child.review_by, child.review_tier);
    assertReviewByDistinct(child.review_by);
  }
  if (whyBlank(input.reason)) {
    throw new DomainError("a decomposition requires a reason");
  }
  const children: Task[] = [];
  db.transaction(() => {
    const decisionId = logDecision(db, parent, input.reason, workerId, now, origin);
    for (const child of input.children) {
      const reasons: string[] = [];
      if (raisesParentRisk(child, parent)) {
        reasons.push("carries risk beyond the parent's declared risk");
      }
      // A review's repair children may target the reviewed task's own
      // executor regardless of the reviewer profile's assignable_to (ADR
      // 0013) — assigneeNeedsApproval carries that exemption, shared with
      // mcp.ts's list_agents so the two can never diverge (issue #43).
      if (assigneeNeedsApproval(db, parent, child.assignee, authority)) {
        reasons.push(`assigns to "${child.assignee}", outside ${workerId}'s assignable_to`);
      }
      for (const reviewer of child.review_by ?? []) {
        if (outsideAuthority(reviewer, authority?.assignable_to)) {
          reasons.push(`assigns review to "${reviewer}", outside ${workerId}'s assignable_to`);
        }
      }
      if (outsideAuthority(child.workspace, authority?.allowed_workspaces)) {
        reasons.push(
          `targets workspace "${child.workspace}", outside ${workerId}'s allowed_workspaces`,
        );
      }
      if (child.workspace !== undefined && isProtectedWorkspace?.(child.workspace)) {
        reasons.push(`targets protected workspace "${child.workspace}"`);
      }
      // an unstated workspace inherits the parent's (CONTEXT.md): it was
      // already authorized when the parent landed there, so this is a
      // default fill-in, never itself a reason for a question
      const workspace = child.workspace ?? parent.workspace ?? undefined;
      if (reasons.length > 0) {
        const questionTitle = `authorize child registration: ${child.title}`;
        registerTask(
          db,
          {
            type: "question",
            title: questionTitle,
            purpose:
              `"${child.title}" ${reasons.join("; ")} — outside ${workerId}'s authority to ` +
              `register unapproved. ${child.purpose}`,
            completion_criteria: "a human approves or rejects the child registration",
            parent_id: parent.id,
            question: [
              { title: questionTitle, options: [...PENDING_CHILD_OPTIONS], recommendation: "approve" },
            ],
            question_kind: { kind: "approval", pending_child: {
              title: child.title,
              purpose: child.purpose,
              completion_criteria: child.completion_criteria,
              risk_flag: child.risk_flag,
              assignee: child.assignee,
              workspace,
              review_flag: child.review_flag,
              review_by: child.review_by,
              review_tier: child.review_tier,
              tier: child.tier,
              priority: child.priority,
              based_on_decision: decisionId,
            } },
            based_on_decision: decisionId,
          },
          now,
          workerId,
          origin,
        );
        continue;
      }
      children.push(
        registerTask(
          db,
          { type: "work", ...child, workspace, parent_id: parent.id, based_on_decision: decisionId },
          now,
          workerId,
          origin,
        ),
      );
    }
    db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(parent.id);
  })();
  return children;
}

/** Whether `parentId` already carries a child an agent registered (issue
 *  #129): an agent's only path to registering a child at all is the
 *  `decompose` MCP tool, so "a child whose own `task_registered` event was
 *  attributed to neither the human nor the board" and "an agent has already
 *  exercised its one decompose judgment here" are the same fact — no separate provenance
 *  marker is needed. Any status counts (even a since-cancelled agent child
 *  still means the judgment was made); this is deliberately permanent, not
 *  reset if that child later settles. A board-named child (failure question,
 *  premise-breach question, RCA review) is the board's rule, not an agent's
 *  decompose judgment, so it does not count (ADR 0194 決定5). */
function hasAgentRegisteredChild(db: Db, parentId: string): boolean {
  const placeholders = [...NON_AGENT_WORKER_IDS].map(() => "?").join(", ");
  const row = db
    .prepare(
      `SELECT 1 FROM tasks t
       JOIN events e ON e.task_id = t.id AND e.kind = 'task_registered'
       WHERE t.parent_id = ? AND e.worker_id NOT IN (${placeholders})
       LIMIT 1`,
    )
    .get(parentId, ...NON_AGENT_WORKER_IDS);
  return row !== undefined;
}

/** Whether `taskId`'s text carries the human's words (ADR 0211): the
 *  human authored it, or its registration record carries objection material
 *  (ADR 0171) — an RCA review is board-named yet carries the human's direction
 *  comments in its purpose. */
export function carriesHumanWords(db: Db, taskId: string): boolean {
  const registered = latestEventOfTask(db, taskId, "task_registered")!;
  return getTextAuthor(db, taskId) === HUMAN_WORKER_ID || !!registered.payload.objection_event_ids?.length;
}

/** The status half of the human-decompose gate (issue #129), split out so the
 *  edit and direct-cancel scope lines (issue #130, ADR 0198) and the human completion door
 *  (issue #964) share the unsettled clause: `task` must be unsettled and not
 *  in_progress. A `human`-assignee task never enters the slot, so it stays
 *  `todo` until settled and only the settled clause bites it (issue #972). The
 *  `verb` names the action in the error for its caller. */
export function assertUnsettledNotInProgress(task: Task, verb: string): void {
  if (isSettled(task.status)) {
    throw new DomainError(`a settled task cannot be ${verb}`);
  }
  if (task.status === "in_progress") {
    throw new DomainError(`an in-progress task cannot be ${verb}`);
  }
}

/** The human-decompose gate (issue #129, CONTEXT.md's Decompose: "線は
 *  「agent の判断がまだ存在しないところ」"). A human may add a child to
 *  `parent` only when all three hold: `parent` is unsettled, `parent` is not
 *  in_progress, and `parent` carries no child an agent has already registered
 *  via its own decompose judgment. Outside this line, rearranging an
 *  agent-decomposed tree belongs to the objection route: the original assignee
 *  runs the repair child and, if the original task is unsettled, replans on
 *  integration return after the children it awaits settle, reading the repair's
 *  steering. The repair is attached, so objected decomposition children keep
 *  running (ADR 0237). Direct rearrangement here would erase the fix-forward
 *  signal that route depends on. */
function assertHumanDecomposable(db: Db, parent: Task): void {
  assertUnsettledNotInProgress(parent, "decomposed by a human");
  if (hasAgentRegisteredChild(db, parent.id)) {
    throw new DomainError(
      "a task an agent has already decomposed cannot be decomposed by a human — " +
        "rearranging it is the objection route's job",
    );
  }
}

/** The edit scope gate (issue #130, CONTEXT.md's Edit): the task must be
 *  human-authored (agent-authored children, including approved ones, are out of scope; the
 *  objection → repair route handles dissatisfaction with it; a
 *  board-registered task's text is the board's own instruction, ADR 0198
 *  決定4), unsettled, and not in_progress. */
function assertHumanEditableScope(db: Db, task: Task): void {
  if (getTextAuthor(db, task.id) !== HUMAN_WORKER_ID) {
    throw new DomainError(
      "only a human-authored task can be edited — agent-authored and board-authored tasks are out of scope",
    );
  }
  assertUnsettledNotInProgress(task, "edited");
}

/** The direct-cancel scope gate (ADR 0198 / 0211, CONTEXT.md's Cancel): the task must
 *  be human-authored or a root other than a question, unsettled, and not
 *  in_progress. An agent registers only children (decompose children,
 *  escalate questions), so a root the human did not register is the board's —
 *  no worker id comparison is needed. A board-named question settles by its
 *  answer, and a board-named attached child (completion review, RCA review)
 *  is an input the rules require, so both stay out. Approved children retain
 *  their agent's decomposition judgment and also stay out (ADR 0211). */
function assertDirectlyCancellableScope(db: Db, task: Task): void {
  const inScope = getTextAuthor(db, task.id) === HUMAN_WORKER_ID || (task.parent_id === null && task.type !== "question");
  if (!inScope) {
    throw new DomainError(
      "only a human-authored task or a board-registered root other than a question can be directly cancelled — " +
        "an agent-authored child (including an approved child), a board-named attached child, and a board-named question are out of scope",
    );
  }
  assertUnsettledNotInProgress(task, "cancelled");
}

/** Human decompose (issue #129): the same mechanics as agent decompose
 *  (`decomposeTask` — one decision, children queue at the tail, the parent
 *  returns to `todo` and blocks on the derived-unfinished-children rule until
 *  they all settle) with the registering worker fixed to `human` and no
 *  authority restrictions (CONTEXT.md's Worker: "人間は全権限を持つ
 *  worker") — `outsideAuthority`'s own "no allowlist configured means
 *  unrestricted" reading already gives this for free by passing `authority:
 *  undefined`, so no separate bypass is needed. The reason is required, just
 *  as it is for the MCP tool, because every human decompose is a decision. */
export function humanDecomposeTask(
  db: Db,
  parent: Task,
  input: { reason: string; children: ChildSpec[] },
  now: Date,
  isProtectedWorkspace: ((name: string) => boolean) | undefined,
  origin: EventOrigin,
): Task[] {
  // ADR 0253 決定5 / ADR 0111 決定6: probe の著者は常に agent
  if (interviewTargets(db, parent.id) !== null) throw new DomainError("a human does not split an Interview root — the root's agent poses the probe");
  assertHumanDecomposable(db, parent);
  return decomposeTask(
    db,
    parent,
    input,
    HUMAN_WORKER_ID,
    now,
    undefined,
    isProtectedWorkspace,
    origin,
  );
}

/** The fields a human may overwrite on a registered task (issue #130,
 *  CONTEXT.md's Edit). Deliberately a subset of RegisterTaskInput: `type`,
 *  `parent_id`, and `github_issue_number` are absent because they are not
 *  editable (a type change is a permission-model swap; a parent relink is the
 *  objection route's tree surgery; the issue reference is the burned-in
 *  identity). The API schema rejects those keys outright; this type is the
 *  domain-side statement of the same closed set. */
export interface EditTaskInput {
  title?: string;
  purpose?: string;
  completion_criteria?: string;
  assignee?: string;
  workspace?: string;
  risk_flag?: boolean;
  review_flag?: boolean;
  /** Replaces the list; `[]` clears it back to the board Auditor (issue #1498). */
  review_by?: string[];
}

/** issue #130: the one risk edit the spec names as machine-refused — a
 *  **demotion** that would break the upward-propagation invariant "parent risk
 *  ≥ approved child risk" (CONTEXT.md's Risk flag: "risk ありの未決着子を持つ
 *  親を risk なしへ下げる編集は拒否"). Clearing a task's risk while it still has
 *  an unsettled risk-bearing child would drop the parent below an already-
 *  approved child. The promotion direction (raising a child above a non-risk
 *  parent) is deliberately NOT refused here: the spec names only the demotion,
 *  and CONTEXT.md's Risk flag keeps declared risk a *secondary* input to
 *  attention allocation ("誤分類によって監査から逃れることはできない"), so a
 *  human's edit-time promotion needs no re-escalation. Only called when the
 *  flag actually flips off. */
function assertRiskDemotionKeepsInvariant(db: Db, task: Task): void {
  const riskyChild = db
    .prepare(
      `SELECT 1 FROM tasks WHERE parent_id = ? AND risk_flag = 1
         AND ${unsettledSql("status")} LIMIT 1`,
    )
    .get(task.id);
  if (riskyChild) {
    throw new DomainError(
      "cannot clear the risk flag while an unsettled child still carries risk — " +
        "the parent's risk must stay at least its approved children's",
    );
  }
}

/** Edit a registered task's unconsumed fields in place (issue #130,
 *  CONTEXT.md's Edit). The scope line (`assertHumanEditableScope`):
 *  human-authored, unsettled, not in_progress — narrower than direct
 *  cancel's (ADR 0198).
 *  Values are consumed at spawn / pickup / completion, so a rewrite before
 *  then makes no broken in-between state (the issue's Purpose). An edit is an
 *  **append event, never a silent overwrite** — one `task_edited` per changed
 *  field carries the pre-edit value into history forever (write-path
 *  statistical purity). Unchanged fields emit nothing.
 *
 *  Issue-backed content and workspace are immutable here (their source of
 *  truth is the GitHub issue / the burned-in reference identity — CONTEXT.md);
 *  the assignee/workspace/reviewer registry-resolution recheck is the caller's, mirror
 *  of registration (see api.ts), since it needs the injected registry seams. */
export function editTask(
  db: Db,
  task: Task,
  input: EditTaskInput,
  now: Date,
  origin: EventOrigin,
): Task {
  assertHumanEditableScope(db, task);
  input = { ...input };
  if (input.review_by) input.review_by = input.review_by.map(normalizeText);
  assertReviewFieldsTakeEffect(
    {
      type: task.type,
      parent_id: task.parent_id,
      assignee: input.assignee === undefined ? task.assignee : input.assignee,
      review_flag: input.review_flag ?? task.review_flag,
      risk_flag: input.risk_flag ?? task.risk_flag,
    },
    input.review_by ?? task.review_by,
  );
  assertReviewByDistinct(input.review_by);
  for (const field of ["title", "purpose", "completion_criteria"] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (whyBlank(value)) throw new DomainError("task content fields cannot be empty");
    input[field] = normalizeText(value);
  }
  const issueBacked = task.github_issue_number !== null;
  if (issueBacked) {
    if (
      input.title !== undefined ||
      input.purpose !== undefined ||
      input.completion_criteria !== undefined
    ) {
      throw new DomainError(
        "an issue-backed task's content is not editable — its source of truth is the GitHub issue",
      );
    }
    if (input.workspace !== undefined) {
      throw new DomainError(
        "an issue-backed task's workspace is not editable — it is the burned-in identity of the reference",
      );
    }
  }
  if (input.risk_flag === false && task.risk_flag === 1) {
    assertRiskDemotionKeepsInvariant(db, task);
  }
  // one row per field that actually changes value; `from`/`to` are stringified
  // (booleans → "true"/"false") so the event payload is one flat shape across
  // text, nullable, and boolean fields. An unchanged submission (same value)
  // is a no-op — no event. The `field` doubles as the (hardcoded, never
  // input-derived) column name in the UPDATE below. An empty assignee/
  // workspace string means "unset — resolve to the board default" (CONTEXT.md's
  // Assignee/Workspace), so it is normalized to null, same "" ⇢ default the
  // registration door omits the field for.
  const flag = (v: number): string => (v ? "true" : "false");
  const changes: Array<{ field: string; from: string | null; to: string | null; value: string | number | null }> = [];
  for (const field of ["title", "purpose", "completion_criteria"] as const) {
    const next = input[field];
    if (next !== undefined && next !== task[field]) {
      changes.push({ field, from: task[field], to: next, value: next });
    }
  }
  for (const field of ["assignee", "workspace"] as const) {
    if (input[field] === undefined) continue;
    const next = input[field] || null;
    if (next !== task[field]) changes.push({ field, from: task[field], to: next, value: next });
  }
  for (const field of ["risk_flag", "review_flag"] as const) {
    const next = input[field];
    if (next !== undefined && (next ? 1 : 0) !== task[field]) {
      changes.push({ field, from: flag(task[field]), to: flag(next ? 1 : 0), value: next ? 1 : 0 });
    }
  }
  // review_by: the stored JSON text is both the column value and the event's
  // from/to; an empty list means "no reviewer named" and is stored as null
  const stored = (v: string[] | null): string | null => (v?.length ? JSON.stringify(v) : null);
  if (input.review_by !== undefined) {
    const [from, to] = [stored(task.review_by), stored(input.review_by)];
    if (from !== to) changes.push({ field: "review_by", from, to, value: to });
  }
  db.transaction(() => {
    for (const c of changes) {
      db.prepare(`UPDATE tasks SET ${c.field} = ? WHERE id = ?`).run(c.value, task.id);
      appendEvent(db, {
        taskId: task.id,
        workerId: HUMAN_WORKER_ID,
        origin,
        payload: { kind: "task_edited", field: c.field, from: c.from, to: c.to },
        at: now,
      });
    }
  })();
  return getTask(db, task.id)!;
}

/** The one SQL shape of the derived-blocked rule (CONTEXT.md): an unsettled
 *  child the parent waits for — either part of a decomposition decision or an
 *  escalation question. `parentRef` is the SQL expression holding the
 *  parent's id. */
function unfinishedChildSql(parentRef: string): string {
  return `EXISTS (SELECT 1 FROM tasks c
            WHERE c.parent_id = ${parentRef}
              AND ${unsettledSql("c.status")}
              AND ${awaitedChildSql("c")})`;
}

/** 早期統合復帰(ADR 0121): 子の前提の破綻が開いていて、待っている未決着の子がすべてその
 *  破綻の abandon の範囲に入る親。pickup の blocked の門だけが読む例外で、blocked の導出は変えない。 */
function earlyIntegrationReturnSql(parentRef: string): string {
  return `EXISTS (SELECT 1 FROM tasks d
            WHERE d.parent_id = ${parentRef} AND d.premise_breach_decision IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM tasks c
                WHERE c.parent_id = ${parentRef}
                  AND ${unsettledSql("c.status")}
                  AND ${awaitedChildSql("c")}
                  AND NOT ${abandonScopeSql("d", "c", "1")}))`;
}

/** Just the child-side half of that rule (ADR 0049): "is this row a child its
 *  parent waits for?". `blockingSql` applies it to the row itself to name the
 *  parent it is holding up, so the predicate has one home rather than a copy
 *  per read口. `rowRef` is the SQL alias of the child row. */
function awaitedChildSql(rowRef: string): string {
  // 提案を運ぶ question は付帯子(ADR 0120 決定3): 適用は盤面が行うので親は見届けない
  return `(${rowRef}.based_on_decision IS NOT NULL OR (${rowRef}.type = 'question' AND ${rowRef}.question_proposal IS NULL))`;
}

/** The parent this row is holding up, or NULL — `listYourTasks` and `questionBlocking` share it. */
function blockingSql(rowRef: string): string {
  return `CASE WHEN ${awaitedChildSql(rowRef)} THEN ${rowRef}.parent_id END`;
}

/** あるタスクを根とする子孫全体(根自身を含む)の CTE。`rootRef` は根の id を持つ SQL 式
 *  (`?` か名前つきパラメータ)。着地の門と直接 cancel の question gate、triage の異議
 *  勘定、積み残しが同じ「系譜をたどる」形を共有する。`skipCancelled` なら cancelled の
 *  タスクとその下へは降りない(根自身は残す)—— 積み残しが abandon で捨てられた判断の内側を
 *  運ばない(ADR 0239 決定1)。 */
export function subtreeSql(rootRef: string, skipCancelled = false): string {
  return `WITH RECURSIVE subtree(id) AS (
      SELECT ${rootRef}
      UNION
      SELECT c.id FROM tasks c JOIN subtree s ON c.parent_id = s.id${skipCancelled ? " WHERE c.status <> 'cancelled'" : ""})`;
}

/** 着地の門(ADR 0092 決定1): 着地するタスクの子孫全体に付いた、未決着の付帯子の数。
 *  付帯子は型で列挙せず `awaitedChildSql` の補集合で取る(ADR 0049)— 完了時レビューも
 *  異議修理も RCA も等しく数え、新しい種類の子が生えても黙って古くならない。範囲が
 *  直下でなく子孫全体なのは、決着済み分解子への修理も、その修理に付いたレビューも、
 *  系譜経由で着地する枝へ merge back されるから(ADR 0053)— 着地する枝へ流れ込むもの
 *  すべてが門の対象。 */
export function countUnsettledAttachedChildren(db: Db, taskId: string): number {
  const { n } = db
    .prepare(
      `${subtreeSql("?")}
       SELECT COUNT(*) AS n FROM tasks c JOIN subtree s ON c.parent_id = s.id
        WHERE ${unsettledSql("c.status")} AND NOT ${awaitedChildSql("c")}`,
    )
    .get(taskId) as { n: number };
  return n;
}

/** Resolve the execution agent for a task that can enter the slot
 * (CONTEXT.md's Assignee/Auditor). Questions are answered by a human and have
 * no execution agent; accepting one here would hide a broken execution path. */
export function resolveTaskAgent(
  task: Pick<Task, "type" | "assignee">,
  defaultAgentName: string,
  auditorName: string,
): string {
  if (task.type === "question") throw new Error("question tasks have no execution agent");
  return task.assignee ?? (task.type === "review" ? auditorName : defaultAgentName);
}

/** The type-aware execution fallback pointer the assignee gates COALESCE an
 *  unset assignee to (issue #42 / #242 / CONTEXT.md's Auditor): a question has
 *  no executor, an unset review resolves to the Auditor pointer, and an unset
 *  work task resolves to the board's default agent. Absent pointers evaluate
 *  to NULL, which the gates' COALESCE/`=` already treats as "no fallback,
 *  gate only an explicit assignee" — no separate null-guard needed here. */
export function typeAwareDefaultAgentSql(
  taskTypeRef: string,
  defaultAgentRef: string,
  auditorRef: string,
): string {
  return `CASE WHEN ${taskTypeRef} = 'question' THEN NULL
               WHEN ${taskTypeRef} = 'review' THEN ${auditorRef}
               ELSE ${defaultAgentRef} END`;
}

/** 「このタスクは資源単位の停止で止まっている」の唯一の SQL(ADR 0137 決定6)。
 *  `nextSlotTask` の pickup 述語と `listQueue` の skipped 表示が共有し、乖離させない。
 *  workspace は `task.workspace ?? 既定`(既定が無い盤面では門ごと効かない、ADR 0009)、
 *  assignee は `task.assignee ?? 型に応じた既定` を、呼び出し側が束ねた
 *  `@stoppedWorkspaces` / `@stoppedAssignees` と比べる。EXISTS なので NULL は偽に落ちる。 */
function stoppedSql(taskRef: string, fallback: string): string {
  return `((@defaultWorkspaceName IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(@stoppedWorkspaces)
             WHERE value = COALESCE(${taskRef}.workspace, @defaultWorkspaceName)))
           OR EXISTS (SELECT 1 FROM json_each(@stoppedAssignees)
             WHERE value = COALESCE(${taskRef}.assignee, ${fallback})))`;
}

/** Held (CONTEXT.md, ADR 0006 / 0048): while a question is unanswered, keep
 *  everything its abandon answer could cancel out of the slot. A general
 *  question still holds its parent's children downward. A failure question
 *  holds the failed task's descendants plus each unfinished same-decision
 *  sibling itself and its descendants — no siblings for an Interview pin
 *  child's failure question, though its premise-breach question keeps them
 *  (ADR 0245 決定2・5). Seeding siblings themselves prevents pickup
 *  immediately before the answer. Questions stay answerable outside
 *  the slot and are excluded from held presentation. The set is derived only. */
const HELD_IDS_CTE = `
  held_ids(id) AS (
    SELECT candidate.id
    FROM tasks q
    JOIN tasks failed ON failed.id = q.parent_id
    JOIN tasks candidate ON (
      (q.question_cancel_option IS NULL AND candidate.parent_id = q.parent_id)
      OR (
        q.question_cancel_option IS NOT NULL
        AND (
          candidate.parent_id = failed.id
          OR (
            candidate.id <> failed.id
            AND ${abandonScopeSql("failed", "candidate", "q.question_breached_decision IS NOT NULL")}
          )
        )
      )
    )
    WHERE q.type = 'question' AND q.status = 'todo'
    UNION
    SELECT candidate.id
    FROM tasks declarer JOIN tasks candidate ON ${abandonScopeSql("declarer", "candidate", "1")}
    WHERE declarer.premise_breach_decision IS NOT NULL
    UNION
    SELECT c.id FROM tasks c JOIN held_ids h ON c.parent_id = h.id
  )
`;

/** `idRef` is the SQL expression holding the candidate task's id. */
function heldSql(idRef: string): string {
  return `${idRef} IN (SELECT id FROM held_ids WHERE id NOT IN
            (SELECT id FROM tasks WHERE type = 'question'))`;
}

/** Settled tree (CONTEXT.md's Board, issue #35): walks every tree down from
 *  its root, tagging each task with that root's id and whether the task
 *  itself is unsettled (not done/cancelled). A root's tree only fully
 *  retreats from the board once none of its descendants are unsettled — a
 *  root going `done` does not by itself qualify, since layer 1/2 review
 *  children (`completeTask`'s auto-generated review, an objection's RCA
 *  review) start `todo` under an already-`done` root (issue #35 comment). */
const SETTLED_TREE_CTE = `
  tree_status(id, root_id, unsettled) AS (
    SELECT id, id, CASE WHEN ${unsettledSql("status")} THEN 1 ELSE 0 END
    FROM tasks WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, t.root_id, CASE WHEN ${unsettledSql("c.status")} THEN 1 ELSE 0 END
    FROM tasks c JOIN tree_status t ON c.parent_id = t.id
  ),
  unsettled_roots(root_id) AS (
    SELECT DISTINCT root_id FROM tree_status WHERE unsettled = 1
  )
`;

/** `idRef` is the SQL expression holding the candidate task's id. */
function settledTreeSql(idRef: string): string {
  return `${idRef} IN (SELECT id FROM tree_status
            WHERE root_id NOT IN (SELECT root_id FROM unsettled_roots))`;
}

export function hasUnfinishedChildren(db: Db, taskId: string): boolean {
  const { blocked } = db
    .prepare(`SELECT ${unfinishedChildSql("?")} AS blocked`)
    .get(taskId) as { blocked: number };
  return blocked === 1;
}

/** How a task appears on the board: `blocked` derived from unfinished
 *  children, `held` from an ancestor's unanswered question. Presentation
 *  only — the stored status stays one of the four persisted values. `blocked`
 *  takes precedence when both apply: it names the more local reason. */
export type BoardTask = Omit<Task, "status" | "question_proposal" | typeof storedRow> & {
  /** 提案の段はいまの名前(issue #1436)。 */
  question_proposal: QuestionProposal<Tier> | null;
  /** Every integration review generated at completion is done (ADR 0111). */
  accepted: boolean;
  status: TaskStatus | "blocked" | "held" | "skipped";
  raw_assignee?: string | null;
  /** Who registered the task — read off its own `task_registered` event,
   *  not a stored column (issue #261: tasks carry no registrant of their
   *  own, same read-time-resolution precedent as push.ts's
   *  listUnnotifiedHumanTasks). registerTask always writes exactly one such
   *  event, so the join is one-to-one. */
  registrant?: string;
};

/** Who registered `taskId` — its own `task_registered` event's worker id.
 *  registerTask always writes exactly one, so an existing task always has one. */
export function getRegistrant(db: Db, taskId: string): string {
  return latestEventOfTask(db, taskId, "task_registered")!.worker_id;
}

/** 文面の書き手(CONTEXT.md の Registrant / ADR 0197): 分解判断に乗る task ならその分解判断の書き手、
 *  無ければ登録者。承認で実体化した子は登録者が human でも、書き手は分解した agent。 */
export function getTextAuthor(db: Db, taskId: string): string {
  const decision = getTask(db, taskId)!.based_on_decision;
  return decision === null ? getRegistrant(db, taskId) : getEvent(db, decision)!.worker_id;
}

/** Whether materializing `child` under `parent` raises the parent's risk
 *  (issue #11's upward propagation) — the child carries risk the parent does
 *  not. Approval evaluates it against the parent's current flag. */
export function raisesParentRisk(child: { risk_flag?: boolean }, parent: Pick<Task, "risk_flag">): boolean {
  return !!child.risk_flag && !parent.risk_flag;
}

/** 承認 question(`question_pending_child` を持つ question)の注釈(issue #757)。
 *  approve で親の risk が上がるかは approve 時と同じ判定を現在の親に当てる ——
 *  判定は盤面側、WebUI は描画だけ(`landingAnnotation` と同じ分担)。 */
export function approvalAnnotation(
  db: Db,
  task: QuestionColumns<TierRef> & Pick<Task, "parent_id">,
): { raises_parent_risk: boolean } | null {
  const kind = questionKindOf(task);
  switch (kind.kind) {
    case "approval":
      return { raises_parent_risk: raisesParentRisk(kind.pending_child, getTask(db, task.parent_id!)!) };
    case "escalation":
    case "failure":
    case "premise_breach":
    case "broken_probe":
    case "pr_merge":
    case "local_merge":
    case "pr_promotion_retry":
    case "proposal":
    case "quarantine":
    case "cli_auth_expiry_warning":
      return null;
  }
}

/** question が塞いでいる親の id、塞がなければ null(issue #935)— `listYourTasks` の
 *  `blocking` と同じく awaitedChildSql を行自身に当てる。付帯子の提案 question は null。 */
export function questionBlocking(db: Db, taskId: string): string | null {
  return db
    .prepare(`SELECT ${blockingSql("tasks")} FROM tasks WHERE id = ?`)
    .pluck()
    .get(taskId) as string | null;
}

/** The single-task view: the same assembly as `listBoard`, filtered to one id
 *  and without the list's cancelled/settled filter (issue #1208). The names
 *  resolve an unset assignee exactly as `listBoard` does. */
export function presentTask(
  db: Db,
  task: Pick<Task, "id">,
  defaultAgentName?: string,
  auditorName: string = DEFAULT_AUDITOR_NAME,
) {
  const [row] = boardRows(
    db,
    "",
    [{ defaultAgentName: defaultAgentName ?? null, auditorName, id: task.id }],
    "tasks.id = @id",
  );
  return toBoardTask(db, row!);
}

/** Registration records the generated review set so independent audits and RCA
 *  children cannot change this integration point's acceptance (ADR 0111).
 *  The learner's acceptance outcome reads this same derivation (spec #541:
 *  acceptance is derived, not a status, so its definition is not copied).
 *  Reviews generated before #546 have no marker; their registration immediately
 *  followed the parent's completion event with the same provenance and canonical
 *  content, which is enough to recognize them without mutating the append-only log. */
export function acceptedSql(taskId: string): string {
  return `COALESCE((SELECT MIN(review.status = 'done') FROM tasks review
    JOIN events registered ON registered.task_id = review.id AND registered.kind = 'task_registered'
    WHERE review.parent_id = ${taskId} AND (
      json_extract(registered.payload, '$.integration_review') = 1 OR (
        json_type(registered.payload, '$.integration_review') IS NULL
        AND review.title LIKE 'review: %'
        AND review.purpose = 'read-only review of "' || substr(review.title, 9) || '"''s deliverable against its completion criteria'
        AND review.completion_criteria = 'findings are read-only — issues land as repair tasks for the original assignee'
        AND EXISTS (
          SELECT 1 FROM events completed
          WHERE completed.id = registered.id - 1
            AND completed.task_id = ${taskId}
            AND completed.kind = 'task_completed'
            AND completed.worker_id = registered.worker_id
            AND completed.origin = registered.origin
            AND completed.created_at = registered.created_at
        )
      )
    )), 0)`;
}

type BoardRow = Omit<TaskRow, "status" | typeof storedRow> & {
  accepted: number;
  status: TaskStatus | "blocked" | "held" | "skipped";
  raw_assignee: string | null;
  registrant: string;
};

/** The shared shape behind `listBoard`/`listQueue`/`presentTask`/`listYourTasks`: the same CTE
 *  and the same blocked/held derivation, with room for one extra `CASE` branch
 *  injected before the fallback so a view can layer on one more display-only
 *  state. `where` defaults to the list's unsettled filter; the single-task view
 *  replaces it with its id. `extraSelect` appends columns a read口 carries of
 *  its own (`listYourTasks`'s `blocking`). */
function boardRows(
  db: Db,
  extraCase: string,
  params: unknown[] = [],
  where = `status <> 'cancelled' AND NOT ${settledTreeSql("tasks.id")}`,
  extraSelect = "",
): BoardRow[] {
  const fallback = typeAwareDefaultAgentSql("tasks.type", "@defaultAgentName", "@auditorName");
  return db
    .prepare(
      `WITH RECURSIVE ${HELD_IDS_CTE}, ${SETTLED_TREE_CTE}
       SELECT tasks.*, ${taskTierNamesSql("tasks")}, tasks.assignee AS raw_assignee, registered.worker_id AS registrant,
         ${acceptedSql("tasks.id")} AS accepted,
         CASE WHEN tasks.type = 'question' THEN '${HUMAN_WORKER_ID}'
              ELSE COALESCE(tasks.assignee, ${fallback}) END AS assignee,
         CASE WHEN status = 'todo' AND ${unfinishedChildSql("tasks.id")} THEN 'blocked'
              WHEN status = 'todo' AND ${heldSql("tasks.id")} THEN 'held'
              ${extraCase}
              ELSE status END AS status${extraSelect}
       FROM tasks
       JOIN events registered ON registered.task_id = tasks.id AND registered.kind = 'task_registered'
       WHERE ${where}
       ORDER BY sort_key`,
    )
    .all(...params) as BoardRow[];
}

/** 提案の段は id で持つので、外へ見せる前にいまの名前へ引く(issue #1436)。 */
function toBoardTask(db: Db, { tier_id: _tierId, review_tier_id: _reviewTierId, ...row }: BoardRow) {
  const proposal = parseJson<QuestionProposal>(row.question_proposal);
  return {
    ...fillContentPlaceholder(row),
    accepted: row.accepted === 1,
    review_by: parseJson<string[]>(row.review_by),
    question_items: parseJson<QuestionItem[]>(row.question_items),
    question_answer: parseJson<string[]>(row.question_answer),
    question_pending_child: parseJson<PendingChildSpec>(row.question_pending_child),
    question_proposal: proposal && proposalTierNames(db, proposal),
  };
}

/** The whole board in one query — the list view derives blocked/held in SQL
 *  rather than issuing one probe per row. */
export function listBoard(
  db: Db,
  defaultAgentName?: string,
  auditorName: string = DEFAULT_AUDITOR_NAME,
): BoardTask[] {
  return boardRows(db, "", [{ defaultAgentName: defaultAgentName ?? null, auditorName }]).map((row) => toBoardTask(db, row));
}

/** The queue view (issue #10): the board plus `skipped`, a todo-pickable task
 *  frozen by **a reason of its own** — its execution workspace or agent under
 *  quarantine (issue #26 / ADR 0012), its agent's provider under authentication
 *  quarantine (ADR 0097 決定2), or every one of its entries excluded (ADR 0110
 *  決定3). Board-wide halts are not row properties and never reach here: the queue read's
 *  envelope answers them once with `boardHalts` (ADR 0068 決定4). `skipped` is
 *  display-only and queue-view-only (CONTEXT.md's Quarantine) — it never
 *  reaches `listBoard`/`presentTask`, so the board keeps showing plain `todo`
 *  while the condition holds. `defaultWorkspaceName` mirrors `nextSlotTask`'s own pickup
 *  gate (issue #26 / ADR 0009: `task.workspace ?? the board's default`) —
 *  absent, no workspace tracking exists and the gate is skipped entirely.
 *  `defaultAgentName`/`auditorName` resolve an unset assignee the same
 *  type-aware way (`typeAwareDefaultAgentSql`, issue #42 / CONTEXT.md's
 *  Auditor) before it is matched against `stopped.assignees`; an absent
 *  pointer leaves the rows that would have fallen back to it ungated. A `human`-assignee
 *  task never appears here at all (issue #13): it lives outside the
 *  execution queue entirely, in the your-tasks list (`listYourTasks`), not
 *  merely marked skipped within it. */
export function listQueue(
  db: Db,
  defaultWorkspaceName?: string,
  defaultAgentName?: string,
  auditorName?: string,
  /** 資源単位の skip で候補から外れる workspace / assignee 名 — 開いた quarantine
   *  (ADR 0137 決定6)。`nextSlotTask` の `stopped` と同じ1つの式(`quarantineStops`)
   *  から渡す。該当タスクだけが skipped 表示になる。Absent → 何も skip しない。 */
  stopped?: ResourceStops,
  /** 実行設定の entry がすべて除外されている task(ADR 0110 決定3 / issue #544)。
   *  SQL の後で当てるのは、判定に task の要求ティアが要るから —— agent 名では
   *  引けない。`nextSlotTask` の `excludedTaskIds` と同じ1つの式
   *  (scheduler.ts の `pickupExclusions` + selector)から渡す。 */
  isSkipped?: (task: BoardTask) => boolean,
): BoardTask[] {
  const fallback = typeAwareDefaultAgentSql("tasks.type", "@defaultAgentName", "@auditorName");
  const rows = boardRows(
    db,
    `WHEN status = 'todo' AND type <> 'question' AND ${stoppedSql("tasks", fallback)} THEN 'skipped'`,
    [
      {
        defaultWorkspaceName: defaultWorkspaceName ?? null,
        defaultAgentName: defaultAgentName ?? null,
        auditorName: auditorName ?? null,
        stoppedWorkspaces: JSON.stringify(stopped?.workspaces ?? []),
        stoppedAssignees: JSON.stringify(stopped?.assignees ?? []),
      },
    ],
  );
  return rows
    .filter((row) => row.assignee !== HUMAN_WORKER_ID)
    .map((row) => toBoardTask(db, row))
    .map((task) =>
      task.status === "todo" && isSkipped?.(task) ? { ...task, status: "skipped" as const } : task,
    );
}

/** How a your-tasks row appears (issue #301): `blocking` names the parent this
 *  row is holding up — the ADR 0049 predicate applied to the row itself — or
 *  null when it holds up nobody. Presentation of this read口 only, not a column
 *  on `Task`: it decides which completion door the human surface opens (one tap
 *  vs. the handoff dialog). */
type YourTask = BoardTask & { blocking: string | null };

/** The your-tasks list (issue #13): every unsettled `human`-assignee task,
 *  the persistent home the Assignee/Slot glossary entries promise them — they
 *  never enter the execution queue (`listQueue`) or the slot (`nextSlotTask`)
 *  at all. Ordered by `sort_key` like every other board view. Rows are the
 *  board's derivation (issue #1221); which rows appear is the *stored*
 *  assignee — a question resolves to `human` but is not a your-task (#1220). */
export function listYourTasks(db: Db): YourTask[] {
  const rows = boardRows(
    db,
    "",
    // 保存値が human の行だけなので既定 agent へは落ちない —— SQL が参照する名前を埋めるだけ
    [{ defaultAgentName: null, auditorName: null }],
    `tasks.assignee = '${HUMAN_WORKER_ID}' AND ${unsettledSql("tasks.status")}`,
    `, ${blockingSql("tasks")} AS blocking`,
  ) as Array<BoardRow & { blocking: string | null }>;
  return rows.map((row) => ({ ...toBoardTask(db, row), blocking: row.blocking }));
}

export function getTask(db: Db, id: string): Task | undefined {
  const row = db.prepare(`SELECT *, ${taskTierNamesSql("tasks")} FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
  return row && rowToTask(row);
}

/** The task most recently registered under `parentId` — registration always
 *  assigns a new max(sort_key), so "latest" is just the highest sort_key
 *  among the parent's children. Used by the human decompose API route (issue
 *  #129) to report back whichever landed: a plain work child, or (when
 *  decomposeTask's own risk/protected-workspace machinery intervened) the
 *  pending-child approval question it registered instead — either way, the
 *  same single-Task response shape the plain registration door already has. */
export function latestChild(db: Db, parentId: string): Task | undefined {
  const row = db
    .prepare(`SELECT *, ${taskTierNamesSql("tasks")} FROM tasks WHERE parent_id = ? ORDER BY sort_key DESC LIMIT 1`)
    .get(parentId) as TaskRow | undefined;
  return row && rowToTask(row);
}

/** The type-specific fields a settled child contributes to history: a done
 *  question's answer, a done work's handoff doc verbatim, or why a cancelled
 *  child was cancelled (exactly one `origin_*` key). HistoryChildContext
 *  inherits this shape so replacing the old settled-only bundle cannot drop
 *  a field. */
interface SettledChildContext {
  title: string;
  status: "done" | "cancelled";
  handoff_doc?: string | null;
  /** A done question's bundle (issue #30), one per item, in item order. */
  items?: QuestionItem[];
  answer?: string[] | null;
  /** The reject-reason steering channel (issue #40) — carried alongside
   *  `answer` so a resumed parent reads why, not just what. */
  comment?: string | null;
  /** `cause` は断られた行でない対象の question で cancel された子だけ: その子の `row_refused` の証拠の種類。 */
  origin_question?: { title: string; answer: string[] | null; comment: string | null; cause?: Extract<EventPayload, { kind: "row_refused" }>["cause"] };
  /** 再分解が破棄した子(ADR 0121): 前提の破綻を宣言した子と、その理由。 */
  origin_breach?: { title: string; reason: string };
  /** 人間が直接 cancel した子: その reason(任意なので無ければ null)。 */
  origin_direct_cancel?: { reason: string | null };
}

type HistoryChildContext = Omit<TaskContent, "purpose"> &
  Omit<SettledChildContext, "title" | "status"> & {
    /** Interview の pin の子が読む自分の前提の破綻の question だけ無い(ADR 0253 決定2)。 */
    purpose?: string;
    status: BoardTask["status"];
    you?: true;
    /** Interview の子だけ: complete_interview の採点が名指す id。 */
    id?: string;
    /** この子が宣言して、まだ閉じていない前提の破綻の理由(ADR 0121)。 */
    premise_breach?: string;
  };

interface DecisionHistoryEntry {
  decision: string;
  children: HistoryChildContext[];
}

type TaskHistoryEntry =
  | DecisionHistoryEntry
  | { completion: string | null }
  /** retry が登録した Interview の root だけ(ADR 0248 決定3): 測り直す前の root と、その壊れた probe・rubric・破綻の理由・人間のコメント。 */
  | { retry_of: Omit<Extract<EventPayload, { kind: "interview_retried" }>, "kind"> }
  | { child_outside_the_decomposition: HistoryChildContext };

/** taskHistoryRows の1行: `id` は行の境目の event、`decision` は行が属する decision の event。 */
export type HistoryRow = { id: number; decision?: number; entry: TaskHistoryEntry };

/** 隣り合う同じ decision の行の子をまとめ、decision ごとの history の形に戻す。行の entry は書き換えない。 */
export function joinHistory(rows: readonly Omit<HistoryRow, "id">[]): TaskHistoryEntry[] {
  const out: TaskHistoryEntry[] = [];
  let previous: number | undefined;
  for (const { decision, entry } of rows) {
    const last = out.at(-1);
    if (decision !== undefined && decision === previous && last && "children" in last && "children" in entry) last.children.push(...entry.children);
    else out.push("children" in entry ? { ...entry, children: [...entry.children] } : entry);
    previous = decision;
  }
  return out;
}

/** 1つの task の worker が読む history(event の順)を、decision の子ごとに分けた行の列(ADR 0195: 兄弟の handoff 群が応答予算を超えても続きで読めるように)。
 *  子を持つ decision は子1件ごとに `{ decision, children: [子] }` の行になり、`id` はその子の登録 event。子の無い decision・完了・
 *  分解外の子・retry が登録した Interview の root の `retry_of`(ADR 0248 決定3)は1行で、`id` はそれぞれの event。`readingChildId` は親の
 *  history を読む子: その子に `you` を付ける(受験者から見える親は examineeParent がこれから組む)。Interview の pin の子
 *  自身の history は、前提の破綻の question の purpose(context)と continue のコメントを載せず(ADR 0263 決定8)、failure と escalation の
 *  question は盤面が人間に足した「この対象にだけ届く」と failure の Interview の帰結の一文だけを外す(ADR 0253 決定2 / issue #1932 / ADR 0263 決定9)。 */
export function taskHistoryRows(db: Db, taskId: string, readingChildId?: string): HistoryRow[] {
  type WorkingDecision = {
    decision: string;
    children: Array<{ eventId: number; child: HistoryChildContext }>;
  };
  const timeline: Array<
    | { eventId: number; kind: "decision"; value: WorkingDecision }
    | { eventId: number; kind: "entry"; value: TaskHistoryEntry }
  > = [];
  const decisions = new Map<number, WorkingDecision>();
  for (const event of taskDecisionLog(db, taskId)) {
    if (event.payload.kind === "decision_logged") {
      const decision = { decision: event.payload.line, children: [] };
      decisions.set(event.id, decision);
      timeline.push({ eventId: event.id, kind: "decision", value: decision });
    } else if (event.payload.kind === "task_completed") {
      timeline.push({
        eventId: event.id,
        kind: "entry",
        value: {
          completion: event.payload.result,
        },
      });
    }
  }
  const retried = latestEventOfTask(db, taskId, "interview_retried");
  if (retried) {
    const { kind: _, ...retry_of } = retried.payload;
    timeline.push({ eventId: retried.id, kind: "entry", value: { retry_of } });
  }
  const pinChild = getTask(db, taskId)?.interview_target_id != null;
  for (const child of listChildren(db, taskId)) {
    const registered = latestEventOfTask(db, child.id, "task_registered");
    if (!registered) continue;
    const { based_on_decision } = registered.payload;
    const examineeBreach = pinChild && child.question_breached_decision !== null;
    const context: HistoryChildContext = {
      title: child.title,
      // pin の子の前提の破綻の question の context は rubric と Interview の帰結を持つので、宣言者には答えだけを見せる
      // (ADR 0253 決定2 / ADR 0245 決定2)。人間は question の context を読む(ADR 0248 決定4)
      ...(!examineeBreach && { purpose: pinChild ? examineePurpose(child) : child.purpose }),
      completion_criteria: child.completion_criteria,
      status: presentTask(db, child).status,
      ...(child.id === readingChildId && { you: true as const }),
      // Interview の子は採点のために id を持つ。誰がどの model で走ったかは載せない(伏せた handoff、ADR 0199)
      ...(child.interview_target_id !== null && { id: child.id }),
      ...(child.premise_breach_decision !== null && { premise_breach: premiseBreachReason(db, child.id) }),
      ...(child.status === "done" && child.type === "work"
        ? { handoff_doc: child.handoff_doc }
        : {}),
      ...(child.status === "done" && child.type === "question"
        ? {
            items: child.question_items ?? [],
            answer: child.question_answer,
            // 前提の破綻への continue のコメントは probe の補足なので受験者に届けない(ADR 0263 決定8)
            comment: examineeBreach ? null : child.question_answer_comment,
          }
        : {}),
      ...(child.status === "cancelled" ? cancelOrigin(db, child.id) : {}),
    };
    const decision =
      based_on_decision === undefined ? undefined : decisions.get(based_on_decision);
    if (decision) {
      decision.children.push({ eventId: registered.id, child: context });
    } else {
      timeline.push({
        eventId: registered.id,
        kind: "entry",
        value: { child_outside_the_decomposition: context },
      });
    }
  }
  return timeline
    .sort((a, b) => a.eventId - b.eventId)
    .flatMap((item): HistoryRow[] => {
      if (item.kind === "entry") return [{ id: item.eventId, entry: item.value }];
      const { decision, children } = item.value;
      if (children.length === 0) return [{ id: item.eventId, decision: item.eventId, entry: { decision, children: [] } }];
      return children
        .sort((a, b) => a.eventId - b.eventId)
        .map(({ eventId, child }) => ({ id: eventId, decision: item.eventId, entry: { decision, children: [child] } }));
    });
}

/** 受験者から見える親(ADR 0263 決定3・4): 本番の1子の分解と同じ見え方。欄は出題の値で handoff は無く、history は1つの子の
 *  登録だけを言う出題の行1つで、子は読み手自身の行だけ(採点の `id` は載せない)。root の他の行・兄弟・`retry_of` は載せない。 */
export function examineeParent(db: Db, reader: Task) {
  const rootId = reader.parent_id!;
  const { title, probe, completion_criteria } = interviewProbe(db, rootId)!;
  const rows = taskHistoryRows(db, rootId, reader.id).flatMap((row) => {
    const [own] = "children" in row.entry ? row.entry.children : [];
    if (!own?.you) return [];
    const { id: _, ...child } = own;
    return [{ ...row, entry: { decision: "Registered one child to do this task.", children: [child] } }];
  });
  return { context: { id: rootId, title, purpose: probe, completion_criteria, handoff_doc: null }, rows };
}

/** 受験者が読む自分の question の purpose: 盤面が人間に足した文(この対象にだけ届く、failure の Interview の帰結)だけを末尾から外す。 */
function examineePurpose({ purpose, question_cancel_option }: Task): string {
  if (purpose.endsWith(ONLY_THIS_TARGET_NOTICE)) purpose = purpose.slice(0, -ONLY_THIS_TARGET_NOTICE.length);
  return question_cancel_option !== null && purpose.endsWith(` ${INTERVIEW_FAILURE_END_CONSEQUENCE}`)
    ? purpose.slice(0, -INTERVIEW_FAILURE_END_CONSEQUENCE.length - 1)
    : purpose;
}

/** A cancelled task's `task_cancelled` event names the abandon question that
 *  discarded its decomposition decision (ADR 0006 / 0048), or the premise breach a
 *  redecompose acted on (ADR 0121); without one it was a human's direct cancel,
 *  whose reason `task_cancelled_directly` keeps — the single hop back is the
 *  entire "why" a resumed parent needs. */
function cancelOrigin(
  db: Db,
  taskId: string,
): Pick<SettledChildContext, "origin_question" | "origin_breach" | "origin_direct_cancel"> {
  const payload = latestEventOfTask(db, taskId, "task_cancelled")?.payload;
  if (!payload) {
    const { reason } = latestEventOfTask(db, taskId, "task_cancelled_directly")!.payload;
    return { origin_direct_cancel: { reason } };
  }
  if ("origin_breach_task_id" in payload) {
    const declarer = getTask(db, payload.origin_breach_task_id)!;
    return { origin_breach: { title: declarer.title, reason: premiseBreachReason(db, declarer.id) } };
  }
  const question = getTask(db, payload.origin_question_id)!;
  const answer = { answer: question.question_answer, comment: question.question_answer_comment };
  if (!REFUSED_TARGET_KINDS.includes(question.question_quarantine_kind ?? "")) return { origin_question: { title: question.title, ...answer } };
  // 断られた対象の question の題は model を名指すので、統合復帰の history には伏せた文と証拠の種類だけを見せる(伏せた handoff、
  // ADR 0199 / ADR 0253)。spawn 前に止まっていた子には証拠が無い
  const cause = latestEventOfTask(db, taskId, "row_refused")?.payload.cause;
  return { origin_question: { title: "the provider refused this child's Interview target", ...answer, ...(cause && { cause }) } };
}

/** その子を「この対象は測らない」で cancel した、断られた対象の question。 */
function refusedTargetQuestionOf(db: Db, child: Task): Task | undefined {
  const cancelled = child.status === "cancelled" ? latestEventOfTask(db, child.id, "task_cancelled")?.payload : undefined;
  const question = cancelled && "origin_question_id" in cancelled ? getTask(db, cancelled.origin_question_id) : undefined;
  return question && REFUSED_TARGET_KINDS.includes(question.question_quarantine_kind ?? "") ? question : undefined;
}

/** そのタスクの最新の前提の破綻の理由。 */
function premiseBreachReason(db: Db, taskId: string): string {
  return latestEventOfTask(db, taskId, "premise_breached")!.payload.line;
}

/** Every direct child of `parentId`, any status, in board order (issue #129's
 *  sibling-title list for the human draft). taskHistoryRows deliberately reorders
 *  these by their registration event ids instead. */
export function listChildren(db: Db, parentId: string): Task[] {
  const rows = db
    .prepare(`SELECT *, ${taskTierNamesSql("tasks")} FROM tasks WHERE parent_id = ? ORDER BY sort_key`)
    .all(parentId) as TaskRow[];
  return rows.map(rowToTask);
}

/** The queue head the slot may take: lowest-sort_key todo that is
 *  agent-executable. Blocked is derived from parent/child alone — a task with
 *  an unfinished child it waits for never enters the slot — and questions never enter it
 *  either: they are human tasks, answered outside the slot (WebUI). Slot is
 *  capacity, not identity (ADR 0012 / issue #36): every assignee but `human`
 *  takes the same slot — `human` is the one assignee that always sits outside
 *  it (issue #13's your tasks), never resolved against the registry at all.
 *
 *  `stopped.workspaces` is matched against the task's own execution workspace
 *  (issue #26 / ADR 0009: `task.workspace ?? defaultWorkspaceName`) — a
 *  quarantined todo is skipped in favor of the next runnable one, so
 *  quarantine halts only the workspace it's on, never the whole board.
 *  Absent `defaultWorkspaceName` (a workspaceless board) skips the workspace
 *  gate entirely, same as no workspace tracking existing.
 *
 *  `stopped.assignees` is matched against `task.assignee ??` the type-aware
 *  fallback (ADR 0012 / issue #36 / issue #42 / CONTEXT.md's Auditor): an
 *  unset review resolves to `auditorName`, an unset work task to
 *  `defaultAgentName` — `typeAwareDefaultAgentSql` picks the pointer per row
 *  by `t.type`. An absent pointer leaves the rows that would have fallen back
 *  to it ungated. */
export function nextSlotTask(
  db: Db,
  defaultWorkspaceName?: string,
  defaultAgentName?: string,
  auditorName?: string,
  /** 資源単位の skip で候補から外れる workspace / assignee 名 —— 開いた quarantine
   *  (ADR 0137 決定6)。該当タスクだけが候補から外れ、他のタスクは流れ続ける。
   *  Absent → 何も外さない。 */
  stopped?: ResourceStops,
  /** モデル固有の窓が超過中のタスクそのもの(ADR 0110 決定3)。要求ティアが
   *  task ごとに違う以上、**agent 単位の除外では広すぎる** —— 同じ agent の
   *  要求なしタスクは別のモデルで走るのに、先頭の1本が窓に当たっただけで
   *  一緒に止まる(「全 entry が除外されて初めて skipped」に反する)。
   *  provider 全体の窓は今も agent 単位(`stopped`)—— そちらは
   *  その agent のどのタスクも走れないので、広さが実態と一致する。 */
  excludedTaskIds?: string[],
): Task | undefined {
  const fallback = typeAwareDefaultAgentSql("t.type", "@defaultAgentName", "@auditorName");
  const row = db
    .prepare(
      `WITH RECURSIVE ${HELD_IDS_CTE}
       SELECT t.*, ${taskTierNamesSql("t")} FROM tasks t
       WHERE t.status = 'todo'
         AND t.type <> 'question'
         AND t.assignee IS NOT @humanWorkerId
         AND (NOT ${unfinishedChildSql("t.id")} OR ${earlyIntegrationReturnSql("t.id")})
         AND NOT ${heldSql("t.id")}
         AND NOT ${stoppedSql("t", fallback)}
         AND (@excludedTaskIds IS NULL
           OR t.id NOT IN (SELECT value FROM json_each(@excludedTaskIds)))
       ORDER BY t.sort_key LIMIT 1`,
    )
    .get({
      defaultWorkspaceName: defaultWorkspaceName ?? null,
      defaultAgentName: defaultAgentName ?? null,
      auditorName: auditorName ?? null,
      humanWorkerId: HUMAN_WORKER_ID,
      stoppedWorkspaces: JSON.stringify(stopped?.workspaces ?? []),
      stoppedAssignees: JSON.stringify(stopped?.assignees ?? []),
      excludedTaskIds: excludedTaskIds?.length ? JSON.stringify(excludedTaskIds) : null,
    }) as TaskRow | undefined;
  return row && rowToTask(row);
}
