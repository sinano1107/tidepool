import { json, type Response, Router } from "express";
import { z } from "zod";
import { UnknownAgentError } from "./agent.js";
import {
  type AgentAdmin,
  InvalidAgentIconError,
  UnknownAuthorityProfileError,
} from "./agent-create.js";
import { boardHalts } from "./board-halt.js";
import type { BoardStatePath } from "./board-state.js";
import { type CliAuthCheck, quarantineCliAuthFailure } from "./cli-auth.js";
import type { Clock } from "./clock.js";
import type { ContainmentCheck } from "./containment.js";
import type { Db } from "./db.js";
import {
  getDisplayLanguage,
  SUPPORTED_DISPLAY_LANGUAGES,
  setDisplayLanguage,
} from "./display-language.js";
import type { ChildDraftContext, DraftClient } from "./draft.js";
import { advanceLogCursor, getLogCursor, listEvents, listLog } from "./events.js";
import { type GitHubClient, OPEN_ISSUES_LIMIT } from "./github.js";
import {
  addIssueCommentThroughHumanDoor,
  assertAssigneeKnown,
  assertWorkspaceKnown,
  type GateFailure,
  humanCancelDefaults,
  pollIfParentUnblocked,
  registerThroughHumanDoor,
  submitAnswer,
} from "./human-verbs.js";
import { IssueContentCache, type Live } from "./issue-view.js";
import { getPaceOffsets, isValidOffset, setPaceOffsets } from "./pace-offsets.js";
import { isPaused, setPaused } from "./pause.js";
import { dangerousValues, type ProfileAdmin } from "./profile-create.js";
import { removePushSubscription, savePushSubscription } from "./push.js";
import { getQuietHours, HH_MM_PATTERN, setBoardTimezone, setQuietHours } from "./quiet-hours.js";
import {
  authorityProfileSchema,
  InvalidAgentNameError,
  InvalidAllowedDomainError,
  InvalidAuthorityProfileNameError,
  InvalidReviewAllowedCommandError,
  InvalidSkillAllowlistError,
  InvalidWorkspaceNameError,
  type RegistryCandidates,
  type RegistryReachabilityCheck,
} from "./registry.js";
import { RepoAccessMissingError } from "./repo-access.js";
import { clearSpendDown, getSpendDown, setSpendDown } from "./spend-down.js";
import {
  type BoardTask,
  cancelTaskDirectly,
  completeTask,
  DomainError,
  editTask,
  getTask,
  HANDOFF_FIELDS,
  HUMAN_WORKER_ID,
  listBoard,
  listChildren,
  listQueue,
  listYourTasks,
  moveTask,
  presentTask,
  type Task,
} from "./tasks.js";
import { getThrottleState, isFablePickupBlocked } from "./throttle.js";
import type { TranslationClient } from "./translate.js";
import {
  TranslationTargetError,
  translateHandoff,
  translateLogEntry,
  translateQuestion,
} from "./translation.js";
import { listTranslationUsage } from "./translation-cache.js";
import {
  activeTriageSession,
  addScratchpadLine,
  closeTriageSessionOnly,
  commitTriage,
  consumePendingDump,
  listPendingDumps,
  listScratchpad,
  raiseObjection,
  recordDisplayedEntries,
  startTriage,
  TriageError,
  triagePreview,
} from "./triage.js";
import {
  buildWorkspaceResolver,
  UnknownWorkspaceError,
  type WorkspaceConfig,
} from "./workspace.js";
import {
  BoardStateOverlapError,
  CheckoutHasOriginError,
  GitHubIdentityMissingError,
  NotAGitRepositoryError,
  RegistrySelfPublishError,
  RegistrySelfUnprotectError,
  type WorkspaceAdmin,
  WorkspaceAlreadyPublishedError,
  WorkspaceConfirmationRequiredError,
} from "./workspace-create.js";

// question は人間向け HTTP API の範囲外(issue #38) — question タスクは
// MCP の escalate ツールか tidepool 内部経路(watchdog・quarantine・merge・
// decompose)からしか生まれない。それらは registerTask を直接呼ぶため、
// このスキーマでの絞り込みの影響を受けない。
const registerTaskSchema = z.object({
  type: z.enum(["work", "review"]),
  // the three content fields are optional at the schema so the issue-backed
  // form (issue #49: a github_issue_number instead of content) can omit
  // them — the same permissive-shape posture as `question` below: the
  // content/reference exclusivity, the workspace requirement, and the
  // work-only rule all live in the domain (assertGithubRef), so callers get
  // a domain error either way
  title: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
  completion_criteria: z.string().min(1).optional(),
  github_issue_number: z.number().int().positive().optional(),
  parent_id: z.string().optional(),
  assignee: z.string().optional(),
  workspace: z.string().optional(),
  risk_flag: z.boolean().optional(),
  review_flag: z.boolean().optional(),
  // human decompose (ADR 0047 decision 7): the reason is required for a
  // `parent_id` child and checked at the shared human door; roots do not need one.
  decompose_reason: z.string().optional(),
  // shape stays permissive: the 1-4-item / 2-4-options + recommendation
  // invariants are enforced in the domain so callers get a domain error
  question: z
    .array(
      z.object({
        title: z.string().min(1),
        detail: z.string().min(1).optional(),
        options: z.array(z.string()),
        recommendation: z.string(),
      }),
    )
    .optional(),
});

function gateFailureStatus(kind: GateFailure["kind"]): 400 | 404 | 422 | 502 | 503 {
  switch (kind) {
    case "invalid":
      return 400;
    case "not_found":
      return 404;
    case "issue_rejected":
      return 422;
    case "issue_unavailable":
      return 502;
    case "inspection_unavailable":
      return 503;
  }
}

// the edit payload (issue #130): a strict subset of registerTaskSchema — only
// the editable fields, and strict so an attempt to edit an immutable field
// (type / parent_id / github_issue_number) is a 400 rather than a silent drop
// (CONTEXT.md's Edit: those are 編集不可). The issue-backed content/workspace
// immutability and the risk invariant live in the domain (editTask), so a
// caller gets a domain error there — this file's usual split.
const editTaskSchema = z.strictObject({
  title: z.string().min(1).optional(),
  purpose: z.string().min(1).optional(),
  completion_criteria: z.string().min(1).optional(),
  assignee: z.string().optional(),
  workspace: z.string().optional(),
  risk_flag: z.boolean().optional(),
  review_flag: z.boolean().optional(),
});

// the direct-cancel payload (issue #130): reason is optional (理由の記入は任意)
const cancelTaskSchema = z.object({
  reason: z.string().min(1).optional(),
});

const draftTaskSchema = z.object({
  dump: z.string().min(1),
  // human decompose (issue #129): drafting a child from an "add child"
  // screen — present, the draft is given parent/sibling context; absent,
  // this is a plain root draft, unchanged
  parent_id: z.string().optional(),
  decompose_reason: z.string().optional(),
});

// the approval half of the registration gate (issue #49 設計点4): posting
// the AI-suggested comment is the human's own click in the UI — the board
// never posts a suggestion on its own
const issueCommentSchema = z.object({
  workspace: z.string().min(1),
  github_issue_number: z.number().int().positive(),
  body: z.string().min(1),
});

// the issue-number picker's query (issue #67): workspace is the only input —
// no search term/paging, same "one call per selection" posture as the fetch
// itself
const githubIssuesQuerySchema = z.object({
  workspace: z.string().min(1),
});

// the shape stays close to CreateWorkspaceInput itself; the name rules
// (charset, uniqueness) live in the domain (assertValidWorkspaceName) so
// callers get a domain error, not a schema error, on a bad name — this file's
// usual split
const createWorkspaceCommon = z.object({
  name: z.string().min(1),
  notes: z.string().min(1).optional(),
  protected: z.boolean().optional(),
});
const createWorkspaceSchema = z.discriminatedUnion("mode", [
  createWorkspaceCommon.extend({ mode: z.literal("register"), path: z.string().min(1) }),
  createWorkspaceCommon.extend({ mode: z.literal("clone"), repo: z.string().min(1) }),
  createWorkspaceCommon.extend({ mode: z.literal("create") }),
]);

// notes allows "" here (unlike creation's min(1)): the empty string is the
// edit form's way of removing the field (UpdateWorkspaceInput's contract)
const updateWorkspaceSchema = z.object({
  notes: z.string().optional(),
  protected: z.boolean().optional(),
  // ADR 0061: the array shape only — the grammar (assertValidReviewAllowedCommands)
  // lives in the domain, so a malformed prefix comes back as a domain error,
  // this file's usual split. Absent → untouched; `[]` removes the key.
  review_allowed_commands: z.array(z.string()).optional(),
  allowed_domains: z.array(z.string()).optional(),
  confirm: z.boolean().optional(),
});

// ADR 0066 決定8: publish は confirm を要求しない(ADR 0061 の「危険な値」族では
// なく、エージェントの権限を広げない)。宛先の綴りの検証も置かない — 打ち間違いは
// 人間の入力の範疇で、権限が無ければ push が落ちる(ADR 0066 決定2)
const publishWorkspaceSchema = z.object({ repo: z.string().min(1) });

// the shape mirrors CreateAgentInput directly; name/authority validity and
// icon shape live in the domain (assertValidAgentName / assertKnownAuthority
// / assertValidIcon) so callers get a domain error, not a schema error
const createAgentSchema = z.object({
  name: z.string().min(1),
  authority: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  model: z.string().optional(),
  effort: z.string().optional(),
  // `advisor` is an open CLI-owned model vocabulary (ADR 0042). This boundary
  // carries its spelling but deliberately does not attempt validation here.
  advisor: z.string().optional(),
  // skill allowlist (issue #56 / ADR 0025): required — the array shape only;
  // the vocabulary grammar (assertValidSkillAllowlist) and inventory-agnostic
  // treatment live in the domain, so callers get a domain error, not a schema
  // one, same as name/authority/icon above. The WebUI's picker that fills this
  // in is issue #54.
  skills: z.array(z.string()),
  // no min(1): ADR 0017's empty-specialty default agent has an empty body,
  // and the empty string is that regular form, not a missing value (issue #75)
  systemPrompt: z.string(),
});

// the edit form resubmits every field but `name`, which comes from the URL
// (issue #71, same split as updateWorkspaceSchema)
const updateAgentSchema = createAgentSchema.omit({ name: true });

// the profile save payload (issue #77): every authority-profile field, reused
// straight from the registry's own schema so the two never drift, plus `name`
// (picks the file) and `confirmDangerous` — a request-envelope flag, not a
// profile field, so it is stripped before the value reaches the domain verb.
// The strictObject stays strict through .extend(), so an unknown key is a 400.
const createProfileSchema = authorityProfileSchema.extend({
  name: z.string().min(1),
  confirmDangerous: z.boolean().optional(),
});

// edit resubmits every field but `name` (from the URL), same split as agents;
// confirmDangerous rides along because a dangerous value can enter on edit too
const updateProfileSchema = createProfileSchema.omit({ name: true });

/** The #77 confirmation contract, enforced at the server boundary (ADR 0027):
 *  a save payload carrying any dangerous value (issue #76's `dangerousValues`)
 *  must also carry `confirmDangerous: true`. Without it, 409 with the stable
 *  reason codes phase 3's dialog reads directly — a body distinct from the
 *  busy-clone 409 by its `confirm_required` flag (same shape as the unprotect
 *  409). Returns true once it has sent the 409, so the caller returns without
 *  saving; the check is a pure function of the payload, so create and edit
 *  share it. */
function rejectUnconfirmedDanger(
  res: Response,
  profile: Parameters<typeof dangerousValues>[0],
  confirmDangerous: boolean | undefined,
): boolean {
  const reasons = dangerousValues(profile);
  if (reasons.length === 0 || confirmDangerous) return false;
  res.status(409).json({
    error: "profile contains dangerous values; resubmit with confirmDangerous: true",
    confirm_required: true,
    dangerous_values: reasons,
  });
  return true;
}

const moveTaskSchema = z.object({
  after: z.string().nullable(),
});

const completeTaskSchema = z.object({
  handoff: z.partialRecord(z.enum(HANDOFF_FIELDS), z.string()).optional(),
});

// one answer per question item, in item order (issue #30) — the domain
// enforces the length match against the question's own item count so callers
// get a domain error, not a schema error, on a partial submission
const answerSchema = z.object({
  answers: z.array(z.string().min(1)).min(1),
  triage: z.boolean().optional(),
  // the steering channel for a reject's reason (issue #40) — never required
  // (silence is fine on approve, and a reject often needs no more than the
  // option name), carried through verbatim onto the question_answered event
  comment: z.string().min(1).optional(),
});

const cursorSchema = z.object({
  last_read: z.number().int().nonnegative(),
});

// the standard browser PushSubscription.toJSON() shape (issue #14) —
// expirationTime is never used, so it's accepted but dropped
const pushSubscribeSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
});

const pushUnsubscribeSchema = z.object({
  endpoint: z.string().min(1),
});

const quietHoursSchema = z.object({
  start: z.string().regex(HH_MM_PATTERN),
  end: z.string().regex(HH_MM_PATTERN),
});

// ペースオフセット (ADR 0030): 3ウィンドウとも必須。値域の意味論(0–100 の
// 整数 pt)は pace-offsets.ts の isValidOffset そのものを使う — 二重定義しない
const paceOffsetValue = z.number().refine(isValidOffset, {
  message: "offset must be an integer between 0 and 100",
});
const paceOffsetsSchema = z.object({
  session: paceOffsetValue,
  week: paceOffsetValue,
  fable: paceOffsetValue,
});

// the board timezone (issue #63 / ADR 0022) — a separate sender from
// quiet-hours' start/end: this one is auto-reported by the browser at PWA
// launch, not human-configured, so it gets its own endpoint rather than
// riding along with POST /settings/quiet-hours.
const timezoneSchema = z.object({
  tz: z.string().min(1),
});

// the board display language (issue #46, tightened by #115): one setting
// read by both this issue's draft-prompt language instruction and
// display-time translation (ADR 0015, issue #47) — validated against
// SUPPORTED_DISPLAY_LANGUAGES, the board's single source of truth for
// legal values. Anything not an exact match (including case variants like
// "japanese") is rejected at this write boundary, so nothing downstream
// needs to normalize or fuzzy-match a language string.
const displayLanguageSchema = z.object({
  language: z.enum(SUPPORTED_DISPLAY_LANGUAGES),
});

// display-time translation (issue #47 / ADR 0015): a discriminated union over
// the 3 UX surfaces (CONTEXT.md's toggles) — triage log skim (log_entry,
// covering both a decision-log line and a completion report by event id),
// question card, handoff expansion. Option labels and task title are never a
// target (out of scope by design, not merely unimplemented).
const translateRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log_entry"), event_id: z.number().int() }),
  z.object({ type: z.literal("question"), task_id: z.string().min(1) }),
  z.object({ type: z.literal("handoff"), task_id: z.string().min(1) }),
]);

/** IANA name existence check: an unknown zone throws inside the
 *  Intl.DateTimeFormat constructor itself (issue #63) — no separate
 *  allowlist to keep in sync with the runtime's own tz database. */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// the human's own pause toggle (CONTEXT.md's Pause, issue #34) — never
// exposed via MCP (the same human-steering-channel posture as answering and
// reordering)
const pauseSchema = z.object({
  paused: z.boolean(),
});

// Spend-down (ADR 0030 / issue #128) — pause と同じ人間専用の盤面状態。
// window: null が手動取り消し。
const spendDownSchema = z.object({
  window: z.enum(["session", "week"]).nullable(),
});

const objectionSchema = z.object({
  entry_id: z.number().int().positive(),
  comment: z.string().min(1),
});

const scratchpadSchema = z.object({
  line: z.string().min(1),
});

// z.coerce: route params always arrive as strings — coercing here keeps the
// numeric-id validation on the same zod/treeifyError footing as every body
// schema in this file, rather than a hand-rolled Number() check.
const pendingDumpIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

const displayedSchema = z.object({
  entry_ids: z.array(z.number().int().positive()).min(1),
});

const closeSchema = z.object({
  close_only: z.boolean().default(false),
  scratchpad: z
    .array(
      z.object({
        id: z.number().int().positive(),
        disposition: z.enum(["meta_review", "task", "register", "discard"]),
      }),
    )
    .default([]),
});

function queueHeadId(db: Db): string | null {
  const head = db
    .prepare("SELECT id FROM tasks WHERE status = 'todo' ORDER BY sort_key LIMIT 1")
    .get() as { id: string } | undefined;
  return head?.id ?? null;
}

export interface ApiRouterDeps {
  db: Db;
  clock: Clock;
  onQueueHeadChanged: () => void;
  /** Just-in-time usage observation in flight; absent for API-only tests. */
  throttleRevalidating?: () => boolean;
  /** The board's workspace path — where `gh` runs for the merge dial's live
   *  CI check (issue #11). Absent → a merge-decision "merge" answer can't
   *  check CI and is rejected. */
  workspace?: WorkspaceConfig;
  /** Resolves a task's execution workspace against the registry (issue #26 /
   *  ADR 0009), read fresh every call — used to verify a quarantine
   *  Confirmation question's workspace by name, whatever workspace it names.
   *  Absent → quarantine answers verify only against the board's single
   *  fixed `workspace` (pre-#26 behavior). */
  resolveWorkspace?: (taskWorkspace: string | null) => WorkspaceConfig;
  /** The GitHub-facing seam (issue #19), reused here for the merge dial's
   *  CI-check-then-merge (issue #11). Absent → same as no workspace. */
  github?: GitHubClient;
  /** Retries a failed PR promotion from a failure question (issue #66). */
  retryPrPromotion?: (task: Task) => Promise<void>;
  /** Assignee/workspace name candidates for the registration screen (issue
   *  #12), resolved from the agent registry by the caller (main.ts) — the
   *  API layer never touches the filesystem/git registry loader itself.
   *  A provider, not a snapshot: it is called per request so an agent or
   *  workspace created through the settings surface (issue #72/#57) shows up
   *  on the register screen without a server restart. Absent → no registry
   *  configured, so no candidates to suggest. */
  registryCandidates?: () => RegistryCandidates | undefined;
  /** The LLM draft seam (issue #12). Absent → /tasks/draft reports the LLM
   *  as unreachable. */
  draftClient?: DraftClient;
  /** The board's default agent name (ADR 0012 / issue #36), mirroring
   *  `workspace?.name` above — gates `/api/queue`'s `skipped` display on
   *  agent-name quarantine the same way `workspace` gates it on workspace
   *  quarantine. Absent → no agent tracking exists, so the gate is skipped
   *  entirely (nextSlotTask's own shape). */
  defaultAgentName?: string;
  /** Whether an agent name is currently registered (read fresh against the
   *  registry by the caller, main.ts) — one half of a quarantine Confirmation
   *  question's clearance check (CONTEXT.md's Quarantine): the other half is
   *  "no more todo tasks depend on it", checked here regardless. Absent → only
   *  that second half can ever clear an agent quarantine (no registry
   *  configured at all). */
  agentRegistered?: (name: string) => boolean;
  /** 封じ込め能力ゲートの回答側の半分(ADR 0033 / ADR 0036): 確認 question の
   *  回答は鵜呑みにせず、受理の直前に能力検査を走らせ直す(workspace quarantine が
   *  tree の清潔さを実際に確かめるのと同じ「検証つき解除」)。**ここは fs 半分
   *  だけでなく合成後の検査を受け取る** — 認証側が壊れたまま立った question を
   *  fs 側の成立だけで解除できてしまってはならない。
   *  Absent → そのゲートを持たない盤面。 */
  containment?: ContainmentCheck;
  /** ADR 0052: re-runs refresh before accepting a registry quarantine answer. */
  registryReachability?: RegistryReachabilityCheck;
  /** ADR 0070: re-runs the auth probe before accepting a cliAuth answer. */
  cliAuth?: CliAuthCheck;
  /** The public half of the board's VAPID keypair (issue #14) — the WebUI
   *  needs this to call `pushManager.subscribe`. Absent → push is not
   *  configured on this board at all. */
  vapidPublicKey?: string;
  /** The board's Auditor pointer (CONTEXT.md / issue #15 layer 2), threaded to
   *  `/api/queue`'s `skipped` display: a `review` task's unset assignee gates
   *  on this pointer's quarantine instead of `defaultAgentName` (issue #42,
   *  `listQueue`'s own `typeAwareDefaultAgentSql`). Same shape as
   *  `defaultAgentName` above — absent, this gate is skipped for the review
   *  rows that would have fallen back to it. */
  auditorName?: string;
  /** The settings surface's workspace verbs (issue #57), threaded in by
   *  main.ts with the registry clone / base dir / GitHub deps already bound —
   *  the API layer never touches the registry clone itself. Absent (or a verb
   *  absent — tests fake them singly) → not configured, the route reports
   *  503. */
  workspaceAdmin?: Partial<WorkspaceAdmin>;
  /** The settings surface's agent verbs (issue #71), workspaceAdmin's twin —
   *  threaded in by main.ts with the registry clone already bound. Absent (or
   *  a verb absent — tests fake them singly) → not configured, the route
   *  reports 503. */
  agentAdmin?: Partial<AgentAdmin>;
  /** The settings surface's profile verbs (issue #77), agentAdmin's twin —
   *  threaded in by main.ts with the registry clone already bound. The route
   *  layer runs the real `dangerousValues` gate on top of these (ADR 0027:
   *  the confirmation contract is fixed at the server boundary). Absent (or a
   *  verb absent — tests fake them singly) → not configured, the route reports
   *  503. */
  profileAdmin?: Partial<ProfileAdmin>;
  /** The skills picker's candidate source (issue #106 / ADR 0025 点4), bound by
   *  main.ts to the adapter's neutral-cwd `/usage` ping (claude-worker.ts's
   *  `enumerateHostSkills`). Returns the host's enumerated `@host` skills, or
   *  null on a failed probe. Absent → no CLI to enumerate against; GET /api/
   *  skills degrades to an empty candidate set (never 503 — see the route). */
  hostSkills?: () => Promise<string[] | null>;
  /** Agent names whose registry model is fable (ADR 0030), read fresh per
   *  request — the queue view marks only their tasks skipped while the fable
   *  line is over pace. Absent → no registry, fable skip never shows. */
  fableAgents?: () => string[];
  /** The display-time translation seam (issue #47 / ADR 0015). Absent →
   *  POST /api/translate reports the LLM as unreachable, same 503 posture as
   *  no draftClient configured. */
  translationClient?: TranslationClient;
  /** Whether an explicitly named workspace is protected (CONTEXT.md's
   *  protected workspace / ADR 0013), threaded straight to human decompose's
   *  own call into decomposeTask (issue #129) — same resource-side invariant
   *  the MCP `decompose` tool's own `isProtectedWorkspace` already enforces
   *  for an agent's decompose. Absent → no workspace is protected. */
  isProtectedWorkspace?: (name: string) => boolean;
  /** ADR 0040 / issue #149: the board's own state paths (fixed for the whole
   *  process), bound by main.ts. submitAnswer re-runs the
   *  overlap check against them before it accepts a repair confirmation —
   *  a clean tree is not a repair when the workspace still intersects the
   *  board's own state. Absent → no state paths to protect (a board booted
   *  without them, e.g. most test boards). */
  boardState?: BoardStatePath[];
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const {
    db,
    clock,
    onQueueHeadChanged,
    throttleRevalidating = () => false,
    workspace,
    resolveWorkspace,
    github,
    retryPrPromotion,
    registryCandidates,
    draftClient,
    defaultAgentName,
    agentRegistered,
    containment,
    registryReachability,
    cliAuth,
    vapidPublicKey,
    auditorName,
    workspaceAdmin,
    agentAdmin,
    profileAdmin,
    hostSkills,
    translationClient,
    fableAgents,
    isProtectedWorkspace,
    boardState,
  } = deps;
  const router = Router();
  router.use(json());
  // one cache per router = per process (the API is booted once per board)
  const issueContent = new IssueContentCache();

  router.post("/tasks", async (req, res) => {
    const parsed = registerTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    // human-verbs is the canonical registration door shared by the WebUI and
    // the future management MCP; this route owns only HTTP status mapping.
    const result = await registerThroughHumanDoor(
      {
        db,
        workspace,
        resolveWorkspace,
        github,
        draftClient,
        agentRegistered,
        isProtectedWorkspace,
      },
      parsed.data,
      () => clock.now(),
      "webui",
    );
    if (!result.ok) {
      const { kind, ...body } = result.failure;
      res.status(gateFailureStatus(kind)).json(body);
      return;
    }
    res.status(201).json(result.task);
  });

  // Appends a human-approved comment to a GitHub issue (issue #49 設計点4:
  // 不足サジェスト → UI 提示 → 人間が承認 → issue にコメント追記). The
  // gate's fix lands on the issue, never on the board (ADR 0016: GitHub
  // stays the sole source of truth) — after this, the UI re-POSTs /tasks
  // and the gate re-reads the issue including the new comment.
  router.post("/issue-comments", async (req, res) => {
    const parsed = issueCommentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    const result = await addIssueCommentThroughHumanDoor(
      { github, workspace, resolveWorkspace },
      parsed.data,
    );
    if (!result.ok) {
      switch (result.failure.kind) {
        case "invalid":
          res.status(400).json({ error: result.failure.error });
          return;
        case "not_configured":
          res.status(503).json({ error: result.failure.error });
          return;
        case "unknown_workspace":
          res.status(400).json({ error: result.failure.error });
          return;
        case "github_failed":
          res.status(502).json({ error: result.failure.error });
          return;
      }
    }
    res.status(201).json({});
  });

  // The issue-number picker's data source (issue #67): the workspace's own
  // open issues, so a human confirms a number by reading "#N — title"
  // instead of typing a bare integer. GET, so it never quarantines the
  // workspace (display's own posture) — an unresolvable name is instead a
  // fail-fast 400 (ADR 0009, same as /issue-comments above), and a GitHub
  // failure a 502.
  router.get("/github-issues", async (req, res) => {
    const parsed = githubIssuesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
    if (!github || !resolve) {
      res.status(503).json({ error: "GitHub or workspace tracking not configured" });
      return;
    }
    let path: string;
    try {
      path = resolve(parsed.data.workspace).path;
    } catch (err) {
      if (!(err instanceof UnknownWorkspaceError)) throw err;
      res.status(400).json({ error: `unknown workspace: ${parsed.data.workspace}` });
      return;
    }
    try {
      const issues = await github.listIssues({ path });
      res.json({ issues, truncated: issues.length === OPEN_ISSUES_LIMIT });
    } catch {
      res.status(502).json({ error: "could not fetch open issues" });
    }
  });

  router.post("/workspaces", async (req, res) => {
    const parsed = createWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!workspaceAdmin?.create) {
      res.status(503).json({ error: "workspace creation not configured" });
      return;
    }
    try {
      await workspaceAdmin.create(parsed.data);
      res.status(201).json({});
    } catch (err) {
      // the human's own synchronous request fails fast (ADR 0009): a bad name
      // is the caller's 400; anything else — including a fetch/push that
      // failed to land (ADR 0052 決定1: that means the edit never happened,
      // issue #57 の非致命は撤回)— is an external step failing, 502, and the
      // retry reuses whatever orphan it left behind (issue #57)
      // 400 の3つ: 名前が使えない(#68)、指した checkout が盤面自身の状態パスと
      // 重なる(ADR 0040 / issue #149)、register の対象が git リポジトリでない
      // (ADR 0066 決定7)。どれも出し直せば通り得る呼び出し側の入力の問題であって、
      // 盤面の故障(502)でも未設定(503)でもない
      // ADR 0067: repo アクセスの不足も同じ族 —— 盤面は壊れておらず、案内の一行を
      // 実行して出し直せば通る。message には既に3要素の案内が載っている
      if (
        err instanceof InvalidWorkspaceNameError ||
        err instanceof BoardStateOverlapError ||
        err instanceof RepoAccessMissingError ||
        err instanceof NotAGitRepositoryError
      ) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  router.get("/workspaces", (_req, res) => {
    if (!workspaceAdmin?.list) {
      res.status(503).json({ error: "workspace settings not configured" });
      return;
    }
    res.json(workspaceAdmin.list());
  });

  router.patch("/workspaces/:name", async (req, res) => {
    const parsed = updateWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!workspaceAdmin?.update) {
      res.status(503).json({ error: "workspace settings not configured" });
      return;
    }
    try {
      await workspaceAdmin.update({ name: req.params.name, ...parsed.data });
      res.json({});
    } catch (err) {
      if (err instanceof UnknownWorkspaceError) {
        res.status(404).json({ error: err.message });
      } else if (
        err instanceof InvalidReviewAllowedCommandError ||
        err instanceof InvalidAllowedDomainError
      ) {
        // 400, not 409: no confirmation can buy malformed allowlist grammar
        // (ADR 0061 根拠5 / ADR 0072 決定2).
        res.status(400).json({ error: err.message });
      } else if (err instanceof WorkspaceConfirmationRequiredError) {
        // machine-readable flag plus the reason codes the dialog enumerates
        // (ADR 0061 決定1 — the same body shape as the profile 409). The WebUI
        // takes this path too (issue #265): it sends the plain body first,
        // shows this 409's reasons in a dialog, and resends with confirm:
        // true once the human accepts — same round trip a direct API caller
        // gets, no client-side pre-judgment of danger (ADR 0027)
        res.status(409).json({ error: err.message, confirm_required: true, dangerous_values: err.reasons });
      } else if (err instanceof RegistrySelfUnprotectError) {
        // 403, not 409: no resubmission can ever make this pass (ADR 0013)
        res.status(403).json({ error: err.message });
      } else {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  // ADR 0066 決定2 の扉。PATCH ではなく専用の POST なのは、これが編集ではなく
  // **状態遷移**だからである(決定3): purely-local → remote-backed が起きた瞬間に
  // fork 元も休止位置も着地の形も同時に切り替わる。
  router.post("/workspaces/:name/publish", async (req, res) => {
    const parsed = publishWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!workspaceAdmin?.publish) {
      res.status(503).json({ error: "workspace settings not configured" });
      return;
    }
    try {
      await workspaceAdmin.publish({ name: req.params.name, repo: parsed.data.repo });
      res.json({});
    } catch (err) {
      if (err instanceof UnknownWorkspaceError) {
        res.status(404).json({ error: err.message });
      } else if (
        // 出し直せば通り得る呼び出し側の入力・状態の問題(create の扉と同じ読み):
        // 別の宛先を選び直す / 帯域外の origin を手で直す / 案内の一行を実行する
        err instanceof WorkspaceAlreadyPublishedError ||
        err instanceof CheckoutHasOriginError ||
        err instanceof RepoAccessMissingError
      ) {
        res.status(400).json({ error: err.message });
      } else if (err instanceof RegistrySelfPublishError) {
        // 403: unprotect の自己拒否と同じく、出し直しでは決して通らない(ADR 0013)
        res.status(403).json({ error: err.message });
      } else if (err instanceof GitHubIdentityMissingError) {
        // 上の未設定ゲートと同じ族 — 盤面が GitHub 身元を持たない(ADR 0024)
        res.status(503).json({ error: err.message });
      } else {
        // push が落ちた、registry がランドしなかった(ADR 0052 決定1)—— 外部の一手
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  router.post("/agents", async (req, res) => {
    const parsed = createAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!agentAdmin?.create) {
      res.status(503).json({ error: "agent creation not configured" });
      return;
    }
    try {
      await agentAdmin.create(parsed.data);
      res.status(201).json({});
    } catch (err) {
      // same posture as /workspaces' create: the human's own synchronous
      // request fails fast on a bad input (400), anything else — including a
      // fetch/push that failed to land — is 502 (ADR 0052 決定1)
      if (
        err instanceof InvalidAgentNameError ||
        err instanceof UnknownAuthorityProfileError ||
        err instanceof InvalidAgentIconError ||
        err instanceof InvalidSkillAllowlistError
      ) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  // the settings surface's one-round-trip GET (issue #71): bundles the
  // edit-form list with the authority select's candidates here at the route
  // layer — `AgentAdmin.list` itself keeps phase 1's shape (issue #70)
  router.get("/agents", (_req, res) => {
    if (!agentAdmin?.list) {
      res.status(503).json({ error: "agent settings not configured" });
      return;
    }
    res.json({
      agents: agentAdmin.list(),
      authorityProfiles: agentAdmin.authorityProfiles?.() ?? [],
    });
  });

  // The skills picker's candidate source (issue #106 / ADR 0025 点4): the host's
  // `@host` skills, enumerated fresh per request (no cache) by the adapter's
  // neutral-cwd /usage ping. Deliberately NOT 503 when unconfigured or on a
  // failed probe, unlike the agents/workspaces/profiles settings routes above:
  // this only *assists* input, so it degrades — `{ skills: [], degraded: true }`
  // and the picker still works on the scope words + free entry. (Contrast the
  // spawn-time enumeration, where a failed probe fails the spawn closed — the
  // strictness there is access control, which does not apply to input assist.)
  router.get("/skills", async (_req, res) => {
    const enumerated = hostSkills ? await hostSkills() : null;
    res.json(
      enumerated === null ? { skills: [], degraded: true } : { skills: enumerated, degraded: false },
    );
  });

  router.patch("/agents/:name", async (req, res) => {
    const parsed = updateAgentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!agentAdmin?.update) {
      res.status(503).json({ error: "agent settings not configured" });
      return;
    }
    try {
      await agentAdmin.update({ name: req.params.name, ...parsed.data });
      res.json({});
    } catch (err) {
      if (err instanceof UnknownAgentError) {
        res.status(404).json({ error: err.message });
      } else if (
        err instanceof UnknownAuthorityProfileError ||
        err instanceof InvalidAgentIconError ||
        err instanceof InvalidSkillAllowlistError
      ) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  router.post("/profiles", async (req, res) => {
    const parsed = createProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!profileAdmin?.create) {
      res.status(503).json({ error: "profile settings not configured" });
      return;
    }
    // confirmDangerous is a request-envelope flag (issue #77), never a profile
    // field — strip it before the value reaches the domain verb
    const { confirmDangerous, ...profile } = parsed.data;
    if (rejectUnconfirmedDanger(res, profile, confirmDangerous)) return;
    try {
      await profileAdmin.create(profile);
      res.status(201).json({});
    } catch (err) {
      if (err instanceof InvalidAuthorityProfileNameError) {
        res.status(400).json({ error: err.message });
      } else {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  // GET returns the full profile (every edit-form field) — the /agents route's
  // twin, but with no `authorityProfiles` candidate list to bundle (profiles
  // have no candidates of their own; the select over them lives on /agents)
  router.get("/profiles", (_req, res) => {
    if (!profileAdmin?.list) {
      res.status(503).json({ error: "profile settings not configured" });
      return;
    }
    res.json({ profiles: profileAdmin.list() });
  });

  router.patch("/profiles/:name", async (req, res) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!profileAdmin?.update) {
      res.status(503).json({ error: "profile settings not configured" });
      return;
    }
    const { confirmDangerous, ...fields } = parsed.data;
    const profile = { name: req.params.name, ...fields };
    if (rejectUnconfirmedDanger(res, profile, confirmDangerous)) return;
    try {
      await profileAdmin.update(profile);
      res.json({});
    } catch (err) {
      if (err instanceof UnknownAuthorityProfileError) {
        res.status(404).json({ error: err.message });
      } else {
        res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  router.post("/tasks/draft", async (req, res) => {
    const parsed = draftTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!draftClient) {
      res.status(503).json({ error: "LLM draft client not configured" });
      return;
    }
    try {
      let context: ChildDraftContext | undefined;
      if (parsed.data.parent_id !== undefined) {
        const parent = getTask(db, parsed.data.parent_id);
        if (!parent) {
          res.status(404).json({ error: "parent task not found" });
          return;
        }
        // resolves an issue-backed parent's *live* content (ADR 0016: the
        // board never special-cases an issue-backed parent — CONTEXT.md's
        // Decompose point 6), same short-TTL cache/resolver GET routes use
        const live = await issueContent.present(
          presentTask(db, parent),
          github,
          displayWorkspacePath(parent.workspace),
          clock.now(),
        );
        context = {
          parentTitle: live.title,
          parentPurpose: live.purpose,
          parentCompletionCriteria: live.completion_criteria,
          siblingTitles: listChildren(db, parent.id).map((c) => c.title),
          decomposeReason: parsed.data.decompose_reason,
        };
      }
      const draft = await draftClient.draftTask(parsed.data.dump, getDisplayLanguage(db), context);
      res.json(draft);
    } catch (err) {
      // deliberate departure from this file's usual DomainError-only-maps-to-4xx
      // rule: any failure surfacing through the DraftClient seam — timeout,
      // outage, or a bug in the (future) real adapter — is the same
      // "unreachable" signal as no client configured. AC3 (issue #12) is that
      // draft failures never block registration, only push the user to the
      // plain form, so every draftTask() failure gets 503 here, not 500.
      quarantineCliAuthFailure(db, err, clock.now());
      res.status(503).json({ error: err instanceof Error ? err.message : "draft failed" });
    }
  });

  router.post("/tasks/:id/move", (req, res) => {
    const parsed = moveTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    const task = getTask(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    let after: Task | null = null;
    if (parsed.data.after !== null) {
      const found = getTask(db, parsed.data.after);
      if (!found) {
        res.status(404).json({ error: "after task not found" });
        return;
      }
      after = found;
    }
    const headBefore = queueHeadId(db);
    const moved = moveTask(db, task, after, clock.now());
    // "run now" is specifically a todo already at the head, moved to the
    // head again — an explicit immediate-poll trigger (issue #82 follow-up).
    // Promoting a *different* task to the head is pure reordering: it
    // never itself forces a pickup attempt, waiting instead for the next
    // natural trigger (the running task finishing, or the hourly tick) —
    // otherwise every reorder, drag included, would silently double as a
    // pickup request.
    if (after === null && moved.status === "todo" && headBefore === task.id) {
      onQueueHeadChanged();
    }
    res.json(moved);
  });

  // edit a registered task's unconsumed fields (issue #130). The scope line
  // (human-registered, unsettled, not in_progress), the issue-backed
  // immutability, and the risk invariant all live in editTask — this route
  // adds only the assignee/workspace registry rechecks, the same ones
  // registration runs (CONTEXT.md's Edit: "登録時と同じ検査を再実行"), since
  // they need the injected registry seams. An immutable field in the body was
  // already rejected by the strict schema above.
  router.patch("/tasks/:id", async (req, res) => {
    const parsed = editTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    const task = getTask(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    try {
      // assignee registry recheck (ADR 0012 / issue #36), same as registration:
      // an explicitly named assignee must resolve in the registry. `human` is
      // exempt (never a registry agent); an empty string means "unset — resolve
      // to the board default" (editTask normalizes it to null), so it's exempt
      // too; and absent a real registry every name is accepted.
      if (parsed.data.assignee) {
        assertAssigneeKnown(agentRegistered, parsed.data.assignee);
      }
      // workspace recheck (issue #26 / ADR 0009), same as registration: an
      // explicitly named workspace must exist in the registry (empty = unset,
      // exempt, same as assignee above).
      if (parsed.data.workspace) {
        assertWorkspaceKnown(parsed.data.workspace, resolveWorkspace, workspace);
      }
      const edited = editTask(db, task, parsed.data, clock.now(), "webui");
      res.json((await presentLive([presentTask(db, edited)]))[0]);
    } catch (err) {
      if (err instanceof DomainError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // the human's direct cancel (issue #130, CONTEXT.md's Cancel): the second
  // cancel path beside abandon. Same scope line as edit, the target and its
  // unfinished descendants go cancelled together (道連れ), reason optional. An
  // open Tidepool-registered question that has the subtree as its subject
  // gates it — the domain (cancelTaskDirectly) enforces all of this; the route
  // passes the default workspace/agent pointers the quarantine half of the
  // gate resolves against.
  router.post("/tasks/:id/cancel", (req, res) => {
    const parsed = cancelTaskSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    const task = getTask(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    try {
      cancelTaskDirectly(
        db,
        task,
        parsed.data.reason ?? null,
        clock.now(),
        humanCancelDefaults(workspace, defaultAgentName, auditorName),
        "webui",
      );
      // cancelling can unblock the target's parent (its last unsettled child is
      // now cancelled — settled), so give the queue head a chance to advance,
      // same trigger the /complete route uses (CONTEXT.md: cancelled の親を
      // 塞がない導出は既存機構をそのまま使う).
      pollIfParentUnblocked(db, task, onQueueHeadChanged);
      res.json(presentTask(db, getTask(db, task.id)!));
    } catch (err) {
      if (err instanceof DomainError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // human-verbs is the canonical implementation shared by the WebUI and the
  // future management MCP (ADR 0032 / issue #188). This route owns only the
  // HTTP boundary: input validation, lookup, and status/response mapping.
  router.post("/tasks/:id/answer", async (req, res) => {
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    const task = getTask(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    try {
      const question = await submitAnswer(
        {
          db,
          onQueueHeadChanged,
          workspace,
          resolveWorkspace,
          github,
          retryPrPromotion,
          agentRegistered,
          containment,
          registryReachability,
          cliAuth,
          boardState,
        },
        task,
        parsed.data.answers,
        parsed.data.comment,
        () => clock.now(),
        "webui",
        parsed.data.triage,
      );
      res.json(presentTask(db, question));
    } catch (err) {
      if (err instanceof DomainError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // the human-facing completion route (issue #13): agents complete via MCP's
  // complete_task, but a human's own task has no worker session to call it
  // from. A `human`-assignee task carries no handoff requirement
  // (completeTask's own exemption) — an orphan task closes with an empty
  // body, one tap. When completion unblocks a parent still sitting at its
  // own queue position (no head jump, unlike answerQuestion's escalation
  // re-prioritization — this is plain parent/child derivation), the
  // immediate poll fires the same way a freed slot does elsewhere. Gated to
  // `assignee === human` only (code review, issue #13): an agent-assigned
  // task must keep completing through complete_task's slot-scoped path (PR
  // opening, tree-rule release) — this route is never a shortcut around it.
  // Not gated on "blocks a parent" too: AC4's orphan human task must stay
  // completable through this same route.
  router.post("/tasks/:id/complete", (req, res) => {
    const parsed = completeTaskSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    const task = getTask(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    if (task.assignee !== HUMAN_WORKER_ID) {
      res.status(409).json({
        error: "only a human-assignee task can be completed here — agents complete via MCP's complete_task",
      });
      return;
    }
    try {
      const done = completeTask(
        db,
        task,
        parsed.data.handoff,
        HUMAN_WORKER_ID,
        clock.now(),
        "webui",
      );
      pollIfParentUnblocked(db, done, onQueueHeadChanged);
      res.json(presentTask(db, done));
    } catch (err) {
      if (err instanceof DomainError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // the handoff-draft route (issue #13): same propose-don't-commit shape as
  // /tasks/draft — drafts the 6-field doc from a free-text/voice dump but
  // never completes the task itself; the human reviews/edits, then calls
  // /complete separately. `missing` names the fields the dump didn't cover
  // (HANDOFF_FIELDS minus what the LLM filled in) as a warning only — the
  // human task's completion never enforces them (completeTask's exemption).
  // Gated to `assignee === human` (code review, issue #13), same reasoning
  // and same "not also blocking a parent" carve-out as /complete above.
  router.post("/tasks/:id/complete/draft", async (req, res) => {
    const parsed = draftTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    const task = getTask(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    if (task.assignee !== HUMAN_WORKER_ID) {
      res.status(409).json({ error: "only a human-assignee task can draft a handoff here" });
      return;
    }
    if (!draftClient) {
      res.status(503).json({ error: "LLM draft client not configured" });
      return;
    }
    try {
      const draft = await draftClient.draftHandoff(parsed.data.dump, getDisplayLanguage(db));
      const missing = HANDOFF_FIELDS.filter((f) => !draft[f]?.trim());
      res.json({ ...draft, missing });
    } catch (err) {
      // same "any failure = unreachable" 503 fallback /tasks/draft uses
      // (AC3: a draft failure never blocks completion, only the assist)
      quarantineCliAuthFailure(db, err, clock.now());
      res.status(503).json({ error: err instanceof Error ? err.message : "draft failed" });
    }
  });

  // display-time translation (issue #47 / ADR 0015): canonical text stays
  // English on every board surface — this derives a translated view at read
  // time, never stored back onto the task/event. Cache-first (translation.ts's
  // translateSource): a re-request for the same source+language never calls
  // the LLM twice. Any TranslationClient failure gets the same "outage" 503
  // /tasks/draft uses — a target that simply doesn't resolve (unknown id,
  // wrong task type, no content) is a 404 instead, since it's a request
  // problem, not an LLM outage.
  router.post("/translate", async (req, res) => {
    const parsed = translateRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!translationClient) {
      res.status(503).json({ error: "translation client not configured" });
      return;
    }
    const language = getDisplayLanguage(db);
    try {
      const target = parsed.data;
      let outcome;
      if (target.type === "log_entry") {
        outcome = await translateLogEntry(db, translationClient, target.event_id, language, clock.now());
      } else if (target.type === "question") {
        outcome = await translateQuestion(db, translationClient, target.task_id, language, clock.now());
      } else {
        outcome = await translateHandoff(db, translationClient, target.task_id, language, clock.now());
      }
      res.json(outcome);
    } catch (err) {
      if (err instanceof TranslationTargetError) {
        res.status(404).json({ error: err.message });
        return;
      }
      quarantineCliAuthFailure(db, err, clock.now());
      res.status(503).json({ error: err instanceof Error ? err.message : "translation failed" });
    }
  });

  // every generated (non-cached) translation's token usage (issue #47's
  // "record it the same way worker sessions do, make it observable") — a
  // read path parallel to GET /api/tasks/:id/events surfacing worker_exited
  // usage, since translation calls aren't tied to any one task/worker session.
  router.get("/translate/usage", (_req, res) => {
    res.json({ records: listTranslationUsage(db) });
  });

  // the decision log: events narrowed to human-facing kinds, oldest first,
  // plus the human's read position
  router.get("/log", (_req, res) => {
    const cursor = getLogCursor(db);
    const entries = listLog(db, workspace?.name).map((entry) => ({
      ...entry,
      // A human-authored entry remains in the log and can still be objected
      // to, but it is never new information to that same single human.
      unread: entry.worker_id !== HUMAN_WORKER_ID && entry.id > cursor,
    }));
    res.json({ entries, cursor });
  });

  router.post("/log/cursor", (req, res) => {
    const parsed = cursorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    res.json({ cursor: advanceLogCursor(db, parsed.data.last_read) });
  });

  router.get("/push/vapid-public-key", (_req, res) => {
    res.json({ publicKey: vapidPublicKey ?? null });
  });

  router.post("/push/subscribe", (req, res) => {
    const parsed = pushSubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    savePushSubscription(db, {
      endpoint: parsed.data.endpoint,
      p256dh: parsed.data.keys.p256dh,
      auth: parsed.data.keys.auth,
    });
    res.status(201).json({ ok: true });
  });

  router.delete("/push/subscribe", (req, res) => {
    const parsed = pushUnsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    removePushSubscription(db, parsed.data.endpoint);
    res.json({ ok: true });
  });

  router.get("/settings/quiet-hours", (_req, res) => {
    res.json(getQuietHours(db));
  });

  router.post("/settings/quiet-hours", (req, res) => {
    const parsed = quietHoursSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    setQuietHours(db, parsed.data);
    res.json(getQuietHours(db));
  });

  router.get("/settings/pace-offsets", (_req, res) => {
    res.json(getPaceOffsets(db));
  });

  // ADR 0030: 不正値はこの入口で弾く — 範囲外の値が判定式に入ると strict
  // 比較が黙って崩れる(旧 TIDEPOOL_USAGE_THRESHOLD の NaN fail-open の教訓)
  router.post("/settings/pace-offsets", (req, res) => {
    const parsed = paceOffsetsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    setPaceOffsets(db, parsed.data);
    // どの window を変えたか・値が実際に変わったかによらず、保存成功後は即時再評価
    // する。古い offset で立った throttle_state を tick 待ちにすると、緩和後も最大
    // 1時間 pickup と表示が止まり続ける(issue #296)。
    onQueueHeadChanged();
    res.json(getPaceOffsets(db));
  });

  router.get("/settings/timezone", (_req, res) => {
    res.json({ tz: getQuietHours(db).tz });
  });

  router.post("/settings/timezone", (req, res) => {
    const parsed = timezoneSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (!isValidTimezone(parsed.data.tz)) {
      res.status(400).json({ error: `unknown timezone: ${parsed.data.tz}` });
      return;
    }
    setBoardTimezone(db, parsed.data.tz);
    res.json({ tz: getQuietHours(db).tz });
  });

  router.get("/settings/display-language", (_req, res) => {
    res.json({ language: getDisplayLanguage(db), options: SUPPORTED_DISPLAY_LANGUAGES });
  });

  router.post("/settings/display-language", (req, res) => {
    const parsed = displayLanguageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    setDisplayLanguage(db, parsed.data.language);
    res.json({ language: getDisplayLanguage(db) });
  });

  // Spend-down は pause と同じ「盤面状態」応答に同乗する — UI の露出面が同格
  // (ADR 0030: settings ではなく盤面状態としての表示・操作面)
  function spendDownJson(): { window: string; activatedAt: string } | null {
    const state = getSpendDown(db);
    return state && { window: state.window, activatedAt: state.activatedAt.toISOString() };
  }

  // 盤面全体の停止は列挙が1回で答える(ADR 0068 決定3)。`throttle` は資源単位の
  // 表示(windows / fable 詳細)に要る完全な形のまま残る — halts の throttle
  // entry と一部重複するが、把握して受け入れた重複である
  router.get("/pause", (_req, res) => {
    const { resetsAt: resumesAt, ...throttle } = getThrottleState(db);
    res.json({
      halts: boardHalts(db, throttleRevalidating),
      throttle: { ...throttle, resumesAt, revalidating: throttleRevalidating() },
      spendDown: spendDownJson(),
    });
  });

  router.post("/spend-down", (req, res) => {
    const parsed = spendDownSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    if (parsed.data.window === null) {
      clearSpendDown(db);
    } else {
      setSpendDown(db, parsed.data.window, clock.now());
    }
    // 有効化(今すぐ残りを燃やせ)も取り消しも即時再評価 — 取り消し側を tick 待ち
    // にすると、spend-down 時代の throttle_state が最大1時間 UI に残る
    // (ADR 0028「fail-closed は可視化とセット」の可視化の延長)
    onQueueHeadChanged();
    res.json({ spendDown: spendDownJson() });
  });

  router.post("/pause", (req, res) => {
    const parsed = pauseSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    // resuming is the one explicit "run now" trigger pause carries
    // (CONTEXT.md's Pause) — pausing itself fires nothing
    const resuming = isPaused(db) && !parsed.data.paused;
    setPaused(db, parsed.data.paused);
    if (resuming) onQueueHeadChanged();
    res.json({ paused: parsed.data.paused });
  });

  router.post("/triage/start", (_req, res) => {
    res.status(201).json(startTriage(db, clock.now()));
  });

  router.get("/triage", (_req, res) => {
    const session = activeTriageSession(db);
    res.json({
      session: session ?? null,
      queue: triagePreview(db, session?.id, defaultAgentName, auditorName),
      scratchpad: listScratchpad(db),
    });
  });

  router.post("/triage/scratchpad", (req, res) => {
    const parsed = scratchpadSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    try {
      res.status(201).json(addScratchpadLine(db, parsed.data.line, clock.now()));
    } catch (err) {
      if (err instanceof TriageError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/triage/objection", (req, res) => {
    const parsed = objectionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    try {
      const id = raiseObjection(db, parsed.data.entry_id, parsed.data.comment, clock.now());
      res.status(201).json({ id });
    } catch (err) {
      if (err instanceof TriageError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.post("/triage/displayed", (req, res) => {
    const parsed = displayedSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    try {
      recordDisplayedEntries(db, parsed.data.entry_ids, clock.now());
      res.status(201).json({});
    } catch (err) {
      if (err instanceof TriageError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // The server's half of Commit (ADR 0065 decision 2): apply scratchpad
  // dispositions and close an open session. The read cursor is the other
  // half — the client advances it separately via /log/cursor, never here.
  router.post("/triage/close", (req, res) => {
    const parsed = closeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    try {
      const result = parsed.data.close_only
        ? closeTriageSessionOnly(db, clock.now())
        : commitTriage(db, clock.now(), parsed.data.scratchpad);
      // Only closing an open session re-opens pickup. A sessionless triage
      // never stopped it, so its terminal commit is not a "run now" trigger.
      if (result.outcome === "closed_now") onQueueHeadChanged();
      res.json(result);
    } catch (err) {
      if (err instanceof TriageError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  // Register's pending-dump queue (issue #61): populated by the triage
  // commit's `register` disposition, consumed by DELETE below — either after
  // a task is registered from the line (client-driven) or an explicit
  // discard. No PATCH/update: a pending dump is either still waiting or gone.
  router.get("/pending-dumps", (_req, res) => {
    res.json(listPendingDumps(db));
  });

  router.delete("/pending-dumps/:id", (req, res) => {
    const parsed = pendingDumpIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    consumePendingDump(db, parsed.data.id);
    res.json({ ok: true });
  });

  router.get("/registry/candidates", (_req, res) => {
    res.json(registryCandidates?.() ?? { assignees: [], workspaces: [], icons: {} });
  });

  // UI display is one of ADR 0016's use-moments: issue-backed rows expand
  // live through the short-TTL cache. A GET must stay side-effect-free, so
  // workspace resolution here never quarantines (resolveOrQuarantine is for
  // board-driven async work, not viewing) — an unresolvable name just leaves
  // the row unexpanded.
  const displayResolver = buildWorkspaceResolver(resolveWorkspace, workspace);
  const displayWorkspacePath = (taskWorkspace: string | null) => (): string | undefined => {
    try {
      return displayResolver?.(taskWorkspace).path;
    } catch (err) {
      if (err instanceof UnknownWorkspaceError) return undefined;
      throw err;
    }
  };
  const presentLive = <T extends BoardTask>(tasks: T[]): Promise<Array<Live<T>>> =>
    Promise.all(
      tasks.map((task) =>
        issueContent.present(task, github, displayWorkspacePath(task.workspace), clock.now()),
      ),
    );

  router.get("/tasks", async (_req, res) => {
    res.json(await presentLive(listBoard(db, defaultAgentName, auditorName)));
  });

  // the persistent your-tasks list (issue #13): every unsettled human-
  // assignee task, never the execution queue's business. Live-expanded like
  // every other board read口 (issue #301) — an issue-backed human task must
  // show the issue's own title, not the "#N" placeholder.
  router.get("/your-tasks", async (_req, res) => {
    res.json(await presentLive(listYourTasks(db)));
  });

  // the queue view (#10): an envelope (ADR 0068 決定3) — `halts` says why the
  // board is quiet, `tasks` carries the rows, and a row's `skipped` is its own
  // resource-scoped reason alone. Both come from the same read at the same
  // instant, so no gap between two fetches can make them disagree.
  router.get("/queue", async (_req, res) => {
    res.json({
      halts: boardHalts(db, throttleRevalidating),
      tasks: await presentLive(
        listQueue(
          db,
          workspace?.name,
          defaultAgentName,
          auditorName,
          // fable 線の超過中は fable モデルのタスクだけが skipped に見える
          // (ADR 0030) — 資源単位の絞りなので行に現れる
          isFablePickupBlocked(db, clock.now()) && fableAgents ? fableAgents() : undefined,
        ),
      ),
    });
  });

  router.get("/tasks/:id/events", (req, res) => {
    res.json(listEvents(db, req.params.id));
  });

  router.get("/tasks/:id", async (req, res) => {
    const task = getTask(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json((await presentLive([presentTask(db, task)]))[0]);
  });

  return router;
}
