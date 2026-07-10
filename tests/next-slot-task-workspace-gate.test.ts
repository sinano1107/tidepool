import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { nextSlotTask, registerTask } from "../src/tasks.js";

function quarantine(db: ReturnType<typeof openDb>, name: string): void {
  db.prepare(
    `INSERT INTO workspace_state (name, needs_human) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET needs_human = 1`,
  ).run(name);
}

describe("nextSlotTask の per-task workspace ゲート", () => {
  it("quarantine 済み workspace の todo タスクは飛ばされ、他 workspace の todo タスクが返る", () => {
    const db = openDb(":memory:");
    quarantine(db, "prod");
    const stuck = registerTask(
      db,
      {
        type: "work",
        title: "stuck in prod",
        purpose: "p",
        completion_criteria: "c",
        workspace: "prod",
      },
      new Date(0),
    );
    const runnable = registerTask(
      db,
      {
        type: "work",
        title: "runs in sandbox",
        purpose: "p",
        completion_criteria: "c",
        workspace: "sandbox",
      },
      new Date(1),
    );

    const head = nextSlotTask(db, "sandbox");
    expect(head?.id).toBe(runnable.id);
    expect(head?.id).not.toBe(stuck.id);
  });

  it("task.workspace が null なら盤面既定名で quarantine 判定される", () => {
    const db = openDb(":memory:");
    quarantine(db, "sandbox");
    registerTask(
      db,
      { type: "work", title: "inherits default", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );

    expect(nextSlotTask(db, "sandbox")).toBeUndefined();
  });

  it("defaultWorkspaceName を渡さない(workspaceless board)ときはゲートが働かない", () => {
    const db = openDb(":memory:");
    quarantine(db, "sandbox");
    const task = registerTask(
      db,
      { type: "work", title: "no workspace tracking", purpose: "p", completion_criteria: "c" },
      new Date(0),
    );

    expect(nextSlotTask(db)?.id).toBe(task.id);
  });
});
