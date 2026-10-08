import { expect, it } from "vitest";
import { whyInvalidSkillAllowlist } from "../src/skill-allowlist.js";

it("skill allowlists accept the five forms and all-denied, rejecting malformed lists without consulting inventory", () => {
  for (const skills of [[], ["*"], ["@workspace", "@host"], ["unknown-plugin:*"], ["unknown-skill", "unknown-plugin:skill"]]) {
    expect(whyInvalidSkillAllowlist(skills)).toBeUndefined();
  }
  expect(whyInvalidSkillAllowlist(["foo*"])).toBe('a "*" may appear only as "*" alone or a "<name>:*" glob');
  for (const skills of [["*", "skill"], ["skill", "*"]]) {
    expect(whyInvalidSkillAllowlist(skills)).toBe('the "*" wildcard must be the only entry');
  }
  expect(whyInvalidSkillAllowlist(["@world"])).toBe("unknown scope (only @workspace / @host)");
  expect(whyInvalidSkillAllowlist([""])).toBe("empty skill name");
});
