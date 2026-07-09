import { Router, json } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { advanceLogCursor, appendEvent, getLogCursor, listEvents, listLog } from "./events.js";
import type { GitHubClient } from "./github.js";
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
import type { WorkspaceConfig } from "./workspace.js";
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
  // shape stays permissive: the 2-4-options + recommendation invariant is
  // enforced in the domain so callers get a domain error
  question: z
    .object({ options: z.array(z.string()), recommendation: z.string() })
    .optional(),
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
  /** The GitHub-facing seam (issue #19), reused here for the merge dial's
   *  CI-check-then-merge (issue #11). Absent → same as no workspace. */
  github?: GitHubClient;
}

export function createApiRouter(deps: ApiRouterDeps): Router {
  const { db, clock, onQueueHeadChanged, workspace, github } = deps;
  const router = Router();
  router.use(json());

  router.post("/tasks", (req, res) => {
    const parsed = registerTaskSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: z.treeifyError(parsed.error) });
      return;
    }
    try {
      res.status(201).json(registerTask(db, parsed.data, clock.now()));
    } catch (err) {
      if (err instanceof DomainError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
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
        if (!github || !workspace) {
          throw new DomainError("no GitHub/workspace configured — cannot check CI or merge");
        }
        const status = await github.getCiStatus({ path: workspace.path, number: mergePr! });
        if (status !== "success") {
          throw new DomainError(`CI is not green yet (status: ${status}) — cannot merge`);
        }
      }
      // an answer during an open triage session is activity (defers the
      // auto-commit) and stages the unblock instead of moving the queue
      const session = triageActivity(db, clock.now());
      const { question, parentUnblocked } = answerQuestion(
        db,
        task,
        parsed.data.answer,
        clock.now(),
        session && ((taskId) => stageFrontInsert(db, session.id, taskId)),
      );
      if (wantsMerge) {
        await github!.mergePullRequest({ path: workspace!.path, number: mergePr! });
        appendEvent(db, {
          taskId: task.id,
          workerId: HUMAN_WORKER_ID,
          payload: { kind: "pr_merged", pr_number: mergePr! },
          at: clock.now(),
        });
      }
      // an answer that unblocked the parent put it at the head — "run now"
      if (parentUnblocked) onQueueHeadChanged();
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

  router.get("/tasks", (_req, res) => {
    res.json(listBoard(db));
  });

  // the queue view (#10): unlike the board, a todo task pickup can't reach
  // right now (Swell throttle) shows here as skipped
  router.get("/queue", (_req, res) => {
    res.json(listQueue(db, isPickupBlocked(db, clock.now())));
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
