import { expect, it } from "vitest";
import { whyInvalidSkillAllowlist } from "../src/skill-allowlist.js";

it("skill allowlists accept the five forms and all-denied, rejecting malformed lists without consulting inventory", () => {
  for (const skills of [[], ["*"], ["@workspace", "@host"], ["unknown-plugin:*"], ["unknown-skill", "unknown-plugin:skill"]]) {
    expect(whyInvalidSkillAllowlist(skills)).toBeUndefined();
  }
  for (const entry of ["foo*", "*bar", "pre*fix"]) {
    expect(whyInvalidSkillAllowlist([entry])).toBe('a "*" may appear only as "*" alone or a "<name>:*" glob');
  }
  for (const skills of [["*", "skill"], ["skill", "*"]]) {
    expect(whyInvalidSkillAllowlist(skills)).toBe('the "*" wildcard must be the only entry');
  }
  for (const entry of ["@world", "@wrokspace"]) {
    expect(whyInvalidSkillAllowlist([entry])).toBe("unknown scope (only @workspace / @host)");
  }
  expect(whyInvalidSkillAllowlist([""])).toBe("empty skill name");
});
