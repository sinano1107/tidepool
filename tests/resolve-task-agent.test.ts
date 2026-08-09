import { describe, expect, it } from "vitest";
import { resolveTaskAgent } from "../src/tasks.js";

describe("resolveTaskAgent の実行対象契約(CONTEXT.md の Auditor)", () => {
  it("work/review の実行先を解決し、実行先を持たない question は拒否する", () => {
    expect(resolveTaskAgent({ type: "work", assignee: null }, "tako", "auditor")).toBe("tako");
    expect(resolveTaskAgent({ type: "review", assignee: null }, "tako", "auditor")).toBe(
      "auditor",
    );
    expect(resolveTaskAgent({ type: "work", assignee: "fugu" }, "tako", "auditor")).toBe("fugu");
    expect(() =>
      resolveTaskAgent({ type: "question", assignee: "fugu" }, "tako", "auditor"),
    ).toThrow("question tasks have no execution agent");
  });
});
