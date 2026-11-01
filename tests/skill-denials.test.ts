import { describe, expect, it } from "vitest";
import { resolveSkillAllowlist } from "../src/skill-allowlist.js";

/** ADR 0025 point 3 / ADR 0335 決定1: the only enforcement primitive is per-skill deny, so the adapter denies
 *  the CLI-enumerated set minus what the allowlist permits. Each entry resolves to one of two positively known
 *  sets — what the checkout carries (the scan) and what the harness bundles (the neutral-cwd ping minus every
 *  `.claude/skills` entry name) — and a name in neither stays closed under every entry form. Pure set algebra;
 *  the pings and the flag plumbing are tested at the spawn adapter. */
describe("resolveSkillAllowlist", () => {
  const checkout = (carried: string[], entries: string[] = carried) => ({ carried, entries });

  it("@host は同梱集合だけを許可し、checkout の skill・user 層・plugin の名前を deny する", () => {
    const enumerated = ["tdd", "dataviz", "user-skill", "plug:deploy"];
    expect(resolveSkillAllowlist(["@host"], enumerated, checkout(["tdd"]), ["dataviz", "debug"])).toEqual({
      deny: ["tdd", "user-skill", "plug:deploy"],
      permitted: ["dataviz"],
      host: ["dataviz", "debug"],
    });
  });

  it("同梱と同名の entry が checkout にあると、その名前は @host から外れ @workspace に入る", () => {
    const resolve = (allowlist: string[]) =>
      resolveSkillAllowlist(allowlist, ["dataviz", "debug"], checkout(["dataviz"]), ["dataviz", "debug"]);
    expect(resolve(["@host"])).toEqual({ deny: ["dataviz"], permitted: ["debug"], host: ["debug"] });
    expect(resolve(["@workspace"])).toEqual({ deny: ["debug"], permitted: ["dataviz"], host: ["debug"] });
  });

  it.each([
    ["@workspace", ["ext", "debug"]],
    ["@host", ["tdd", "ext"]],
    ["ext", ["tdd", "ext", "debug"]],
    ["*", ["ext"]],
  ])("checkout の外を指す link の名前は %s でも deny に残る", (entry, deny) => {
    const outsideLink = checkout(["tdd"], ["ext", "tdd"]);
    expect(resolveSkillAllowlist([entry], ["tdd", "ext", "debug"], outsideLink, ["debug"]).deny).toEqual(deny);
  });

  it("user 層の名前は '*' でも deny に残り、'*' は運ぶ ∪ 同梱を許可する", () => {
    expect(resolveSkillAllowlist(["*"], ["tdd", "user-skill", "debug"], checkout(["tdd"]), ["debug"])).toEqual({
      deny: ["user-skill"],
      permitted: ["tdd", "debug"],
      host: ["debug"],
    });
  });

  it("空リストは列挙された全 skill を deny する", () => {
    expect(resolveSkillAllowlist([], ["tdd", "debug"], checkout(["tdd"]), ["debug"])).toEqual({
      deny: ["tdd", "debug"],
      permitted: [],
      host: ["debug"],
    });
  });

  it("deny と許可の順序は列挙の順に従う", () => {
    expect(resolveSkillAllowlist(["mid", "zeta"], ["zeta", "alpha", "mid"], checkout([]), ["mid", "alpha", "zeta"])).toEqual({
      deny: ["alpha"],
      permitted: ["zeta", "mid"],
      host: ["mid", "alpha", "zeta"],
    });
  });

  it("個別名は完全一致で許可し、実在しない参照は inert(deny も許可も増やさない)", () => {
    const enumerated = ["code-review", "tdd", "grilling"];
    expect(resolveSkillAllowlist(["code-review", "does-not-exist"], enumerated, checkout(["tdd"]), ["code-review", "grilling"]).deny).toEqual([
      "tdd",
      "grilling",
    ]);
  });

  it("'名前:*' の glob は前方一致の名前を許可する(運ぶ・同梱に無い名前は開かない)", () => {
    const enumerated = ["myplugin:deploy", "myplugin:test", "other:x"];
    expect(resolveSkillAllowlist(["myplugin:*"], enumerated, checkout([]), ["myplugin:deploy", "other:x"]).deny).toEqual([
      "myplugin:test",
      "other:x",
    ]);
  });
});
