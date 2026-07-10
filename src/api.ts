import { Router, json } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import type { DraftClient } from "./draft.js";
import { advanceLogCursor, appendEvent, getLogCursor, listEvents, listLog } from "./events.js";
import type { GitHubClient } from "./github.js";
import type { RegistryCandidates } from "./registry.js";
import {
  answerQuestion,
  DomainError,
  getTask,
  HUMAN_WORKER_ID,
  listBoard,
  listQueue,
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

const registerTaskSchema = z.object({
  type: z.enum(["work", "question", "review"]),
  title: z.string().min(1),
  purpose: z.string().min(1),
  completion_criteria: z.string().min(1),
  parent_id: z.string().optional(),
  assignee: z.string().optional(),
  workspace: z.string().optional(),
  risk_flag: z.boolean().optional(),
  review_flag: z.boolean().optional(),
  // shape stays permissive: the 2-4-options + recommendation invariant is
  // enforced in the domain so callers get a domain error
  question: z
    .object({ options: z.array(z.string()), recommendation: z.string() })
    .optional(),
});

const draftTaskSchema = z.object({
  dump: z.string().min(1),
});

const moveTaskSchema = z.object({
  after: z.string().nullable(),
});

const answerSchema = z.object({
  answer: z.string().min(1),
});

const cursorSchema = z.object({
  last_read: z.number().int().nonnegative(),
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
  } = deps;
  const router = Router();
  router.use(json());

  router.post("/tasks", (req, res) => {
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
      res.status(201).json(registerTask(db, parsed.data, clock.now()));
    } catch (err) {
      if (err instanceof DomainError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
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
      const wantsMerge = mergePr !== null && parsed.data.answer === "merge";
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
      // an answer during an open triage session is activity (defers the
      // auto-commit) and stages the unblock instead of moving the queue
      const session = triageActivity(db, clock.now());
      const { question, parentUnblocked, pickupResumed } = answerQuestion(
        db,
        task,
        parsed.data.answer,
        clock.now(),
        session && ((taskId) => stageFrontInsert(db, session.id, taskId)),
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

  // the decision log: events narrowed to human-facing kinds, oldest first,
  // plus the human's read position
  router.get("/log", (_req, res) => {
    res.json({ entries: listLog(db), cursor: getLogCursor(db) });
  });

  router.post("/log/cursor", (req, res) => {
    const parsed = cursorSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    res.json({ cursor: advanceLogCursor(db, parsed.data.last_read) });
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
    res.json(registryCandidates ?? { assignees: [], workspaces: [] });
  });

  router.get("/tasks", (_req, res) => {
    res.json(listBoard(db));
  });

  // the queue view (#10): unlike the board, a todo task pickup can't reach
  // right now (Swell throttle) shows here as skipped
  router.get("/queue", (_req, res) => {
    res.json(listQueue(db, isPickupBlocked(db, clock.now()), workspace?.name));
  });

  router.get("/tasks/:id/events", (req, res) => {
    res.json(listEvents(db, req.params.id));
  });

  router.get("/tasks/:id", (req, res) => {
    const task = getTask(db, req.params.id);
    if (!task) {
      res.status(404).json({ error: "task not found" });
      return;
    }
    res.json(presentTask(db, task));
  });

  return router;
}
