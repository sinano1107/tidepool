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

/** The checkout's side of the resolution (issue #56 / ADR 0335 決定1), shared by both Harnesses: `carried` is what
 *  the checkout carries, `entries` is every name the checkout side claims, which the bundled set is subtracted by.
 *  Claude: `carried` = dirs (or links to a dir inside the checkout — issue #2774) directly under `.claude/skills`,
 *  `entries` = every name there whatever it points at. Codex (ADR 0337 決定2): `carried` = `repo`-scope skills whose
 *  realpath is inside the checkout with a unique name, `entries` = every `repo`-scope name. */
export type CheckoutSkills = { carried: string[]; entries: string[] };

/** The skill allowlist resolved (ADR 0025 point 3 / ADR 0335 決定1): every entry resolves to one of the two
 *  positively known sets — `@workspace` → what the checkout carries, `@host` → the bundled set minus every
 *  checkout entry name (a same-named checkout skill wins in the CLI, and the CLI's loading rules are not copied
 *  here, so over-subtracting is the fail-closed side), `*` → both, a name or `名前:*` → its match in the
 *  enumeration. Permitted = the union ∩ (carried ∪ host), so a name in neither set — a link pointing outside the
 *  checkout, a user-tier or plugin name, an unknown source — stays closed under every entry form; deny =
 *  enumerated − permitted, the only enforcement primitive being per-skill deny. Entries are already
 *  grammar-validated (registry.ts). Both lists follow the enumeration order; `host` is the effective `@host` set
 *  the spawn records (ADR 0335 決定3). */
export function resolveSkillAllowlist(
  allowlist: string[],
  enumerated: string[],
  checkout: CheckoutSkills,
  bundled: string[],
): { deny: string[]; permitted: string[]; host: string[] } {
  const entries = new Set(checkout.entries);
  const host = bundled.filter((skill) => !entries.has(skill));
  const carried = new Set(checkout.carried);
  const hostSet = new Set(host);
  const permits = (entry: string, skill: string) => {
    if (entry === SKILL_WILDCARD) return true;
    if (entry === "@workspace") return carried.has(skill);
    if (entry === "@host") return hostSet.has(skill);
    // "plug:*" → prefix "plug:"; isPluginGlob is the one shared definition of that shape
    if (isPluginGlob(entry)) return skill.startsWith(entry.slice(0, -1));
    return entry === skill;
  };
  const permitted = enumerated.filter(
    (skill) => (carried.has(skill) || hostSet.has(skill)) && allowlist.some((entry) => permits(entry, skill)),
  );
  const allowed = new Set(permitted);
  return { deny: enumerated.filter((skill) => !allowed.has(skill)), permitted, host };
}
