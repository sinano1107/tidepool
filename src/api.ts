import { Router, json } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { listEvents } from "./events.js";
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
      const { question, parentUnblocked } = answerQuestion(db, task, parsed.data.answer, clock.now());
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
