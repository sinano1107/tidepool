import { Router, json } from "express";
import { z } from "zod";
import { verifyAgentRepaired } from "./agent.js";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { DraftClient } from "./draft.js";
import { advanceLogCursor, appendEvent, getLogCursor, listEvents, listLog } from "./events.js";
import { type GitHubClient, IssueGoneError } from "./github.js";
import { IssueContentCache, type LiveBoardTask } from "./issue-view.js";
import { isPaused, setPaused } from "./pause.js";
import { removePushSubscription, savePushSubscription } from "./push.js";
import { getQuietHours, HH_MM_PATTERN, setQuietHours } from "./quiet-hours.js";
import { InvalidWorkspaceNameError, type RegistryCandidates } from "./registry.js";
import {
  answerQuestion,
  type BoardTask,
  completeTask,
  DomainError,
  getTask,
  HANDOFF_FIELDS,
  hasUnfinishedChildren,
  HUMAN_WORKER_ID,
  listBoard,
  listQueue,
  listYourTasks,
  moveTask,
  presentTask,
  registerTask,
  type Task,
} from "./tasks.js";
import { isPickupBlocked } from "./throttle.js";
import {
  buildWorkspaceResolver,
  UnknownWorkspaceError,
  verifyWorkspaceClean,
  type WorkspaceConfig,
} from "./workspace.js";
import { RegistryCloneBusyError } from "./registry-write.js";
import {
  RegistrySelfUnprotectError,
  UnprotectNeedsConfirmationError,
  type WorkspaceAdmin,
} from "./workspace-create.js";
import {
  activeTriageSession,
  addScratchpadLine,
  commitTriage,
  listScratchpad,
  raiseObjection,
  recordDisplayedEntries,
  stageFrontInsert,
  startTriage,
  triageActivity,
  triagePreview,
  TriageError,
} from "./triage.js";

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

const draftTaskSchema = z.object({
  dump: z.string().min(1),
});

// the approval half of the registration gate (issue #49 設計点4): posting
// the AI-suggested comment is the human's own click in the UI — the board
// never posts a suggestion on its own
const issueCommentSchema = z.object({
  workspace: z.string().min(1),
  github_issue_number: z.number().int().positive(),
  body: z.string().min(1),
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
  confirm: z.boolean().optional(),
});

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

// the human's own pause toggle (CONTEXT.md's Pause, issue #34) — never
// exposed via MCP (the same human-steering-channel posture as answering and
// reordering)
const pauseSchema = z.object({
  paused: z.boolean(),
});

const objectionSchema = z.object({
  entry_id: z.number().int().positive(),
  comment: z.string().min(1),
});

const scratchpadSchema = z.object({
  line: z.string().min(1),
});

const displayedSchema = z.object({
  entry_ids: z.array(z.number().int().positive()).min(1),
});

const commitSchema = z.object({
  scratchpad: z
    .array(
      z.object({
        id: z.number().int().positive(),
        disposition: z.enum(["meta_review", "task", "discard"]),
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
  /** Assignee/workspace name candidates for the registration screen (issue
   *  #12), resolved from the agent registry by the caller (main.ts) — the
   *  API layer never touches the filesystem/git registry loader itself.
   *  Absent → no registry configured, so no candidates to suggest. */
  registryCandidates?: RegistryCandidates;
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
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const {
    db,
    clock,
    onQueueHeadChanged,
    workspace,
    resolveWorkspace,
    github,
    registryCandidates,
    draftClient,
    defaultAgentName,
    agentRegistered,
    vapidPublicKey,
    auditorName,
    workspaceAdmin,
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
    try {
      // an explicitly named workspace must exist in the registry (issue #26)
      // — this is the human's own synchronous request, so an unknown name
      // fails fast with a 400 rather than quarantining (ADR 0009); absent a
      // real registry (single fixed `workspace` or none at all), every name
      // is accepted, same as execution-time resolution's fallback
      if (parsed.data.workspace !== undefined) {
        const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
        if (resolve) {
          try {
            resolve(parsed.data.workspace);
          } catch (err) {
            if (!(err instanceof UnknownWorkspaceError)) throw err;
            throw new DomainError(`unknown workspace: ${parsed.data.workspace}`);
          }
        }
      }
      // the agent-name generalization of the workspace check above (ADR 0012
      // / issue #36): an explicitly named assignee must exist in the
      // registry, rejected fast with a 400 rather than registering silently
      // and only surfacing as a pickup-time quarantine. `human` is never a
      // registry agent (CONTEXT.md's Assignee: it names the slot-external
      // facet, not a spawnable identity) so it's exempt — same "absent a real
      // registry, every name is accepted" fallback when `agentRegistered`
      // isn't configured.
      if (
        parsed.data.assignee !== undefined &&
        parsed.data.assignee !== HUMAN_WORKER_ID &&
        agentRegistered &&
        !agentRegistered(parsed.data.assignee)
      ) {
        throw new DomainError(`unknown agent: ${parsed.data.assignee}`);
      }
      // the registration gate (issue #49 設計点4): an issue-backed
      // registration is the human's own synchronous request (ADR 0009) —
      // verify the referenced issue exists and is open before anything is
      // stored, failing fast instead of quarantining or registering a task
      // whose reference is already dead. Boards without a GitHub seam or
      // workspace tracking skip the gate entirely (the check is one-time,
      // never an invariant — ADR 0016).
      if (parsed.data.github_issue_number !== undefined && github && parsed.data.workspace) {
        const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
        if (resolve) {
          let issue;
          try {
            issue = await github.getIssue({
              // resolve cannot throw here: the workspace-known check above
              // already resolved this same name
              path: resolve(parsed.data.workspace).path,
              number: parsed.data.github_issue_number,
            });
          } catch (err) {
            if (err instanceof IssueGoneError) throw new DomainError(err.message);
            // 一時的失敗: retryable, so neither 4xx nor a placeholder
            // registration — the human tries again when GitHub is back
            res.status(502).json({ error: "could not fetch the referenced issue" });
            return;
          }
          // the LLM half of the gate: can the three content fields be
          // derived from this issue? A failing verdict carries the drafted
          // fix (an issue comment) for the UI to show — posting it is the
          // human's approval, never this endpoint's (issue #49 設計点4)
          if (draftClient) {
            let inspection;
            try {
              inspection = await draftClient.inspectIssue(issue);
            } catch {
              // same posture as /tasks/draft: an unreachable LLM is a 503,
              // and the gate stays fail-fast rather than waving the task in
              res.status(503).json({ error: "LLM inspection failed" });
              return;
            }
            if (!inspection.ok) {
              res.status(422).json({
                error: "the referenced issue fails the registration gate",
                missing: inspection.missing,
                suggested_comment: inspection.suggested_comment,
              });
              return;
            }
          }
        }
      }
      res.status(201).json(registerTask(db, parsed.data, clock.now()));
    } catch (err) {
      if (err instanceof DomainError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
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
    const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
    if (!github || !resolve) {
      res.status(503).json({ error: "GitHub or workspace tracking not configured" });
      return;
    }
    let path: string;
    try {
      // the human's own synchronous request — an unknown name fails fast
      // with a 400 (ADR 0009), same as registration's workspace check
      path = resolve(parsed.data.workspace).path;
    } catch (err) {
      if (!(err instanceof UnknownWorkspaceError)) throw err;
      res.status(400).json({ error: `unknown workspace: ${parsed.data.workspace}` });
      return;
    }
    try {
      await github.addIssueComment(
        { path, number: parsed.data.github_issue_number },
        parsed.data.body,
      );
    } catch {
      res.status(502).json({ error: "could not post the comment to the issue" });
      return;
    }
    res.status(201).json({});
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
      res.status(201).json(await workspaceAdmin.create(parsed.data));
    } catch (err) {
      // the human's own synchronous request fails fast (ADR 0009): a bad name
      // is the caller's 400; a busy registry clone is a 409 the idempotent
      // flow retries later; anything else is an external step failing — 502,
      // and the retry reuses whatever orphan it left behind (issue #57)
      if (err instanceof InvalidWorkspaceNameError) {
        res.status(400).json({ error: err.message });
      } else if (err instanceof RegistryCloneBusyError) {
        res.status(409).json({ error: err.message });
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
      res.json(await workspaceAdmin.update({ name: req.params.name, ...parsed.data }));
    } catch (err) {
      if (err instanceof UnknownWorkspaceError) {
        res.status(404).json({ error: err.message });
      } else if (err instanceof UnprotectNeedsConfirmationError) {
        // machine-readable flag (issue #57 / #55's shape). The WebUI never
        // takes this path — it confirms up front and sends confirm: true in
        // one request; this 409 is the floor for direct API callers
        res.status(409).json({ error: err.message, confirm_required: true });
      } else if (err instanceof RegistrySelfUnprotectError) {
        // 403, not 409: no resubmission can ever make this pass (ADR 0013)
        res.status(403).json({ error: err.message });
      } else if (err instanceof RegistryCloneBusyError) {
        res.status(409).json({ error: err.message });
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
      const draft = await draftClient.draftTask(parsed.data.dump);
      res.json(draft);
    } catch (err) {
      // deliberate departure from this file's usual DomainError-only-maps-to-4xx
      // rule: any failure surfacing through the DraftClient seam — timeout,
      // outage, or a bug in the (future) real adapter — is the same
      // "unreachable" signal as no client configured. AC3 (issue #12) is that
      // draft failures never block registration, only push the user to the
      // plain form, so every draftTask() failure gets 503 here, not 500.
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
    // a todo moved to the top is "run now" — an explicit immediate-poll
    // trigger even when it already sat at the head; a non-todo move is a
    // display move and can never change the todo queue head
    if ((after === null && moved.status === "todo") || queueHeadId(db) !== headBefore) {
      onQueueHeadChanged();
    }
    res.json(moved);
  });

  // answering lives on the WebUI JSON API only, never MCP: it is the human
  // steering channel (CONTEXT.md: escalation is answered by the 上位者)
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
      // a merge-decision question's "merge" answer (issue #11) must not
      // resolve the question until CI is actually green, checked live right
      // now — otherwise a stale approval could merge a build that has since
      // gone red, and once resolved the question offers no way to retry
      const mergePr = task.question_pending_merge_pr;
      // a merge-decision question is always length-1 (CONTEXT.md's
      // Confirmation question — this one carries a real 2-way choice, not a
      // confirmation, but the bundle is still a single item)
      const wantsMerge = mergePr !== null && parsed.data.answers[0] === "merge";
      if (wantsMerge) {
        if (!github) {
          throw new DomainError("no GitHub/workspace configured — cannot check CI or merge");
        }
        // resolved against the question's own workspace (issue #26 / ADR
        // 0009: registerMergeQuestion carries the originating work task's
        // workspace) rather than just the board's default
        const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
        if (!resolve) {
          throw new DomainError("no GitHub/workspace configured — cannot check CI or merge");
        }
        let mergeWorkspace: WorkspaceConfig;
        try {
          mergeWorkspace = resolve(task.workspace);
        } catch (err) {
          if (!(err instanceof UnknownWorkspaceError)) throw err;
          throw new DomainError(
            `no workspace configured for "${err.workspaceName}" — cannot check CI or merge`,
          );
        }
        const status = await github.getCiStatus({ path: mergeWorkspace.path, number: mergePr! });
        if (status !== "success") {
          throw new DomainError(`CI is not green yet (status: ${status}) — cannot merge`);
        }
        // the external merge runs before the question is committed answered
        // (same ordering as openHandoffPr's PR-creation-then-recordPrOpened):
        // if this throws, the question stays open to retry — committing the
        // answer first would strand it "answered" with no merge and no retry
        await github.mergePullRequest({ path: mergeWorkspace.path, number: mergePr! });
      }
      // a quarantine Confirmation question's answer (issue #21) is never
      // taken on faith: the board verifies the workspace's tree is actually
      // clean before treating it as a repair confirmation — a dirty tree
      // rejects the answer outright, leaving the question open
      const quarantineWs = task.question_quarantine_workspace;
      if (quarantineWs !== null) {
        // resolved by name, not the task's own workspace field (quarantine
        // is a workspace-scoped question, not a task-scoped one) — this is a
        // human's synchronous request, so an unresolvable name fails fast
        // with a DomainError rather than quarantining again (ADR 0009)
        const resolve = buildWorkspaceResolver(resolveWorkspace, workspace);
        let target: WorkspaceConfig;
        try {
          if (!resolve) throw new UnknownWorkspaceError(quarantineWs);
          target = resolve(quarantineWs);
        } catch (err) {
          if (!(err instanceof UnknownWorkspaceError)) throw err;
          throw new DomainError(
            `no workspace configured for "${quarantineWs}" — cannot verify repair`,
          );
        }
        try {
          verifyWorkspaceClean(target);
        } catch (err) {
          throw new DomainError(err instanceof Error ? err.message : String(err));
        }
      }
      // the agent-name generalization of the workspace branch above (ADR
      // 0012 / issue #36): never taken on faith either — clears only if the
      // registry has the name back, or no more todo work depends on it
      const quarantineAgentName = task.question_quarantine_agent;
      if (quarantineAgentName !== null) {
        try {
          verifyAgentRepaired(db, quarantineAgentName, agentRegistered?.(quarantineAgentName) ?? false);
        } catch (err) {
          throw new DomainError(err instanceof Error ? err.message : String(err));
        }
      }
      // an answer during an open triage session is activity (defers the
      // auto-commit) and stages the unblock instead of moving the queue
      const session = triageActivity(db, clock.now());
      const { question, parentUnblocked, pickupResumed } = answerQuestion(
        db,
        task,
        parsed.data.answers,
        clock.now(),
        session && ((taskId) => stageFrontInsert(db, session.id, taskId)),
        parsed.data.comment,
      );
      if (wantsMerge) {
        appendEvent(db, {
          taskId: task.id,
          workerId: HUMAN_WORKER_ID,
          payload: { kind: "pr_merged", pr_number: mergePr! },
          at: clock.now(),
        });
      }
      // an answer that unblocked the parent, or resumed a quarantined
      // workspace's pickup (issue #21), put something pickable at the head —
      // "run now" either way
      if (parentUnblocked || pickupResumed) onQueueHeadChanged();
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
      const done = completeTask(db, task, parsed.data.handoff, HUMAN_WORKER_ID, clock.now());
      if (done.parent_id) {
        const parent = getTask(db, done.parent_id);
        if (parent && parent.status === "todo" && !hasUnfinishedChildren(db, parent.id)) {
          onQueueHeadChanged();
        }
      }
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
      const draft = await draftClient.draftHandoff(parsed.data.dump);
      const missing = HANDOFF_FIELDS.filter((f) => !draft[f]?.trim());
      res.json({ ...draft, missing });
    } catch (err) {
      // same "any failure = unreachable" 503 fallback /tasks/draft uses
      // (AC3: a draft failure never blocks completion, only the assist)
      res.status(503).json({ error: err instanceof Error ? err.message : "draft failed" });
    }
  });

  // the decision log: events narrowed to human-facing kinds, oldest first,
  // plus the human's read position
  router.get("/log", (_req, res) => {
    res.json({ entries: listLog(db, workspace?.name), cursor: getLogCursor(db) });
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

  router.get("/pause", (_req, res) => {
    res.json({ paused: isPaused(db) });
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
    if (!session) {
      res.json({ session: null, queue: null, scratchpad: null });
      return;
    }
    res.json({
      session,
      queue: triagePreview(db, session.id),
      scratchpad: listScratchpad(db, session.id),
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

  router.post("/triage/commit", (req, res) => {
    const parsed = commitSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    try {
      const session = commitTriage(db, clock.now(), parsed.data.scratchpad);
      // committing re-opens pickup and is itself the "run now" trigger
      onQueueHeadChanged();
      res.json(session);
    } catch (err) {
      if (err instanceof TriageError) {
        res.status(409).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  router.get("/registry/candidates", (_req, res) => {
    res.json(registryCandidates ?? { assignees: [], workspaces: [], icons: {} });
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
  const presentLive = (tasks: BoardTask[]): Promise<LiveBoardTask[]> =>
    Promise.all(
      tasks.map((task) =>
        issueContent.present(task, github, displayWorkspacePath(task.workspace), clock.now()),
      ),
    );

  router.get("/tasks", async (_req, res) => {
    res.json(await presentLive(listBoard(db)));
  });

  // the persistent your-tasks list (issue #13): every unsettled human-
  // assignee task, never the execution queue's business
  router.get("/your-tasks", (_req, res) => {
    res.json(listYourTasks(db));
  });

  // the queue view (#10): unlike the board, a todo task pickup can't reach
  // right now — Swell throttle or the human's own Pause (issue #34), the
  // same board-wide "nothing starts" shape — shows here as skipped
  router.get("/queue", async (_req, res) => {
    res.json(
      await presentLive(
        listQueue(
          db,
          isPickupBlocked(db, clock.now()) || isPaused(db),
          workspace?.name,
          defaultAgentName,
          auditorName,
        ),
      ),
    );
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
