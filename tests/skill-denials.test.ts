import { describe, expect, it } from "vitest";
import { computeSkillDenials } from "../src/claude-worker.js";

/** ADR 0025 point 3: the only enforcement primitive is per-skill deny, so the
 *  adapter denies the complement of the allowlist against the CLI-enumerated
 *  full set. `computeSkillDenials` is that set algebra, pure and isolated —
 *  the vendor ping (enumeration) and the flag plumbing are tested separately.
 *  The `@workspace`/`@host` split is a difference against the checkout's own
 *  skills (the third argument). */
describe("computeSkillDenials", () => {
  it("['*'] は allow-all — 何も deny しない", () => {
    expect(computeSkillDenials(["*"], ["code-review", "tdd", "plug:deploy"], ["tdd"])).toEqual([]);
  });

  it("空リストは全禁止 — 列挙された全 skill を deny する", () => {
    expect(computeSkillDenials([], ["code-review", "tdd", "plug:deploy"], ["tdd"])).toEqual([
      "code-review",
      "tdd",
      "plug:deploy",
    ]);
  });

  it("個別名は完全一致で許可し、それ以外を deny する", () => {
    expect(computeSkillDenials(["code-review"], ["code-review", "tdd", "grilling"], [])).toEqual([
      "tdd",
      "grilling",
    ]);
  });

  it("@workspace は checkout の skill だけを許可し、ホスト由来(user + plugin)を deny する", () => {
    const enumerated = ["tdd", "code-review", "plug:deploy", "user-skill"];
    const workspace = ["tdd", "code-review"];
    expect(computeSkillDenials(["@workspace"], enumerated, workspace)).toEqual([
      "plug:deploy",
      "user-skill",
    ]);
  });

  it("@host はホスト由来(列挙 − workspace)だけを許可し、workspace の skill を deny する", () => {
    const enumerated = ["tdd", "plug:deploy", "user-skill"];
    const workspace = ["tdd"];
    expect(computeSkillDenials(["@host"], enumerated, workspace)).toEqual(["tdd"]);
  });

  it("'名前:*' の plugin glob はその plugin の全 skill を許可し、それ以外を deny する", () => {
    const enumerated = ["myplugin:deploy", "myplugin:test", "other:x", "tdd"];
    expect(computeSkillDenials(["myplugin:*"], enumerated, [])).toEqual(["other:x", "tdd"]);
  });

  it("語を組み合わせられ、実在しない参照は inert(deny を増やさない・許可を増やさない)", () => {
    const enumerated = ["code-review", "tdd", "plug:deploy"];
    const allowlist = ["code-review", "does-not-exist", "otherplugin:*"];
    expect(computeSkillDenials(allowlist, enumerated, [])).toEqual(["tdd", "plug:deploy"]);
  });
});
