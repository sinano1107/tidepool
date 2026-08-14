import { describe, expect, it } from "vitest";
import { dangerousValues } from "../src/profile-create.js";

describe("dangerousValues: 危険値判定の純関数(issue #76 — 判定のみ、書き込みはブロックしない)", () => {
  it("安全な値(escalate、ワイルドカードなし)では空配列", () => {
    expect(
      dangerousValues({
        assignable_to: ["deckhand", "tako"],
        allowed_workspaces: ["tidepool"],
        merge: "escalate",
      }),
    ).toEqual([]);
  });

  it("merge: external も安全 — 盤面の無人動作をゼロにする値なので確認は増えない(ADR 0079 決定5)", () => {
    expect(
      dangerousValues({
        assignable_to: ["deckhand"],
        allowed_workspaces: ["tidepool"],
        merge: "external",
      }),
    ).toEqual([]);
  });

  it("merge: auto_if_ci_green は危険理由として検知される", () => {
    expect(
      dangerousValues({
        assignable_to: ["deckhand"],
        allowed_workspaces: ["tidepool"],
        merge: "auto_if_ci_green",
      }),
    ).toContain("merge_auto_if_ci_green");
  });

  it("assignable_to の \"*\" は危険理由として検知される", () => {
    expect(
      dangerousValues({
        assignable_to: ["*"],
        allowed_workspaces: ["tidepool"],
        merge: "escalate",
      }),
    ).toContain("assignable_to_wildcard");
  });

  it("allowed_workspaces の \"*\" は危険理由として検知される", () => {
    expect(
      dangerousValues({
        assignable_to: ["deckhand"],
        allowed_workspaces: ["*"],
        merge: "escalate",
      }),
    ).toContain("allowed_workspaces_wildcard");
  });

  it("複数の危険値は理由がすべて集まる", () => {
    expect(
      dangerousValues({
        assignable_to: ["*"],
        allowed_workspaces: ["*"],
        merge: "auto_if_ci_green",
      }),
    ).toEqual(
      expect.arrayContaining([
        "merge_auto_if_ci_green",
        "assignable_to_wildcard",
        "allowed_workspaces_wildcard",
      ]),
    );
  });
});
