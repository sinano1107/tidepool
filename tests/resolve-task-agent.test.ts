import { describe, expect, it } from "vitest";
import { resolveTaskAgent } from "../src/tasks.js";

describe("resolveTaskAgent の実行対象契約(CONTEXT.md の Auditor)", () => {
  it("work/review の実行先を解決し、実行先を持たない question は拒否する", () => {
    const resolve = (task: { type: "work" | "review" | "question"; assignee: string | null }) =>
      resolveTaskAgent(task, "tako", "auditor", "interviewer");
    expect(resolve({ type: "work", assignee: null })).toBe("tako");
    expect(resolve({ type: "review", assignee: null })).toBe("auditor");
    expect(resolve({ type: "work", assignee: "fugu" })).toBe("fugu");
    expect(() => resolve({ type: "question", assignee: "fugu" })).toThrow("question tasks have no execution agent");
  });
});
