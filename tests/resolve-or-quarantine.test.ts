import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { listBoard } from "../src/tasks.js";
import {
  resolveOrQuarantine,
  UnknownWorkspaceError,
  workspaceNeedsHuman,
  type WorkspaceConfig,
} from "../src/workspace.js";

describe("resolveOrQuarantine", () => {
  it("resolve が解決できるときはその WorkspaceConfig をそのまま返し、quarantine は起きない", () => {
    const db = openDb(":memory:");
    const ws: WorkspaceConfig = { name: "sandbox", path: "/home/pi/work/sandbox" };
    const resolved = resolveOrQuarantine(db, () => ws, "sandbox", new Date(0));
    expect(resolved).toEqual(ws);
    expect(listBoard(db)).toEqual([]);
  });

  it("resolve が UnknownWorkspaceError を投げるときは、その名前を quarantine して undefined を返す", () => {
    const db = openDb(":memory:");
    const resolve = () => {
      throw new UnknownWorkspaceError("ghost");
    };
    const resolved = resolveOrQuarantine(db, resolve, "ghost", new Date(0));
    expect(resolved).toBeUndefined();
    expect(workspaceNeedsHuman(db, "ghost")).toBe(true);
    const question = listBoard(db).find((t) => t.type === "question");
    expect(question?.question_quarantine_workspace).toBe("ghost");
  });
});
