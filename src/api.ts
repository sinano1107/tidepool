import { Router, json } from "express";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Db } from "./db.js";
import { listEvents } from "./events.js";
import { getTask, listTasks, moveTask, registerTask, type Task } from "./tasks.js";

const registerTaskSchema = z.object({
  type: z.enum(["work", "question", "review"]),
  title: z.string().min(1),
  purpose: z.string().min(1),
  completion_criteria: z.string().min(1),
  parent_id: z.string().optional(),
});

const moveTaskSchema = z.object({
  after: z.string().nullable(),
});

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
    res.status(201).json(registerTask(db, parsed.data, clock.now()));
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
    const moved = moveTask(db, task, after, clock.now());
    onQueueHeadChanged();
    res.json(moved);
  });

  router.get("/tasks", (_req, res) => {
    res.json(listTasks(db));
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
    res.json(task);
  });

  return router;
}
