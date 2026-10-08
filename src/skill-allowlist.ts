/** The skill allowlist's unrestricted spelling (issue #56 / ADR 0025): the
 *  sole `["*"]` means every resolved skill is allowed (no deny, no ping).
 *  A domain sibling of `AUTHORITY_WILDCARD` (tasks.ts) — the same glyph, a
 *  different axis (専門性 vs 権限), kept apart so the skill grammar owns its
 *  own vocabulary. */
export const SKILL_WILDCARD = "*";

/** The origin-scope words of the skill allowlist (issue #56 / ADR 0025): a
 *  closed `{@workspace, @host}` set, not a `名前:*` glob — `@workspace:*`
 *  would be grammatically indistinguishable from "a plugin literally named
 *  workspace", so scope typos would become undetectable. Any other `@`-prefixed
 *  entry is a typo and rejected. */
const SKILL_SCOPES = new Set(["@workspace", "@host"]);

/** A `名前:*` plugin glob (ADR 0025): a non-empty plugin name with no `*`/`@`
 *  of its own, then a literal `:*`. Together with the bare `SKILL_WILDCARD`
 *  these are the only two shapes a `*` may appear in. */
const PLUGIN_GLOB_PATTERN = /^[^*@:]+:\*$/;

/** Is this allowlist entry a `名前:*` plugin glob? (issue #56 / ADR 0025) One
 *  definition of the glob shape, shared by the loader's grammar check here and
 *  the adapter's match (claude-worker.ts) so the two can't drift — the adapter
 *  only ever sees validated entries, so it strips the trailing `*` for prefix
 *  matching once this says yes. */
export function isPluginGlob(entry: string): boolean {
  return PLUGIN_GLOB_PATTERN.test(entry);
}

/** First grammar violation, retaining the entry for the registry error. */
export function findSkillAllowlistError(skills: readonly string[]): { entry: string; reason: string } | undefined {
  for (const entry of skills) {
    if (entry === SKILL_WILDCARD) {
      if (skills.length !== 1) return { entry, reason: 'the "*" wildcard must be the only entry' };
      continue;
    }
    if (entry.startsWith("@")) {
      if (!SKILL_SCOPES.has(entry)) return { entry, reason: "unknown scope (only @workspace / @host)" };
      continue;
    }
    if (entry.includes("*") && !isPluginGlob(entry)) {
      return { entry, reason: 'a "*" may appear only as "*" alone or a "<name>:*" glob' };
    }
    if (entry === "") return { entry, reason: "empty skill name" };
  }
  return undefined;
}

/** Grammar only: unknown individual/plugin names are inert references. */
export function whyInvalidSkillAllowlist(skills: readonly string[]): string | undefined {
  return findSkillAllowlistError(skills)?.reason;
}
