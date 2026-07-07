import { Router, json } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { advanceLogCursor, getLogCursor, listEvents, listLog } from "./events.js";
import {
  answerQuestion,
  DomainError,
  getTask,
  listBoard,
  moveTask,
  presentTask,
  registerTask,
  type Task,
} from "./tasks.js";
import {
  activeTriageSession,
  addScratchpadLine,
  commitTriage,
  listScratchpad,
  raiseObjection,
  recordDisplayedEntries,
  startTriage,
  touchTriage,
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

export function createApiRouter(
  db: Db,
  clock: Clock,
  onQueueHeadChanged: () => void,
): Router {
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
  router.post("/tasks/:id/answer", (req, res) => {
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
      const session = activeTriageSession(db);
      const { question, parentUnblocked } = answerQuestion(
        db,
        task,
        parsed.data.answer,
        clock.now(),
        session?.id,
      );
      if (session) touchTriage(db, clock.now());
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
