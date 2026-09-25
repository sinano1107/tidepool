import { execFileSync } from "node:child_process";
import { isIP } from "node:net";
import { basename } from "node:path";
import { parse as parseTwemoji } from "@twemoji/parser";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_AUDITOR_NAME } from "./defaults.js";
import { TIERS } from "./execution-setting.js";
import {
  authedGitBounded,
  GIT_NETWORK_TIMEOUT_MS,
  type GitHubAuth,
  originRepo,
} from "./github-auth.js";
import { PROVIDER_VALUES, type Provider } from "./provider.js";

/** An agent definition file: `agents/<name>.md` in the registry clone.
 *  Frontmatter carries the machine-stamped version and the authority profile
 *  reference; the markdown body is the agent's system prompt. */
export interface AgentDefinition {
  name: string;
  version: string;
  authority: string;
  /** The one line of prose a roster entry shows a delegating agent (issue
   *  #43 / ADR 0014): "when this agent is the right delegate", not a genre
   *  label. Required — an agent registered without one has no way to be
   *  picked from a roster, same hygiene as issue #41's assignable_to. */
  description: string;
  /** この agent が走ってよい Provider(CONTEXT.md の Provider / ADR 0110 決定1)。
   *  **正規化された entry の配列**であり、agent.md 側の3つの綴り(省略 / 単一
   *  文字列 / 配列)は `normalizeProviderEntries` が1つのこの形へ畳む —— 読み手
   *  (selector・門・spawn)が綴りの分岐を持たないための正規形である。
   *  省略の意味は「盤面が知る Provider のうち、正準経路がこの agent の宣言
   *  (`skills`)を満たすものを advisor なしの床の構成で」(ADR 0116 決定1)で、
   *  ADR 0097 決定1 の「必須」は ADR 0110 決定1 で撤回された。
   *
   *  値の列挙と検証は registry 側(`PROVIDER_VALUES` / `assertValidAgentDefinition`)、
   *  値が意味するもの(エンドポイント・env 名・モデル表記)はアダプタ側の定数
   *  (ADR 0005)。名前は自由文字列のまま持つ — 列挙・組み合わせの違反は読み込みを
   *  倒さず、登録と pickup の門が拒否/隔離する(ADR 0097 決定3)。 */
  provider: readonly AgentProviderEntry[];
  /** 既定の要求ティア(CONTEXT.md「要求」/ ADR 0110 決定1): この agent の
   *  セッションが既定でどの品質ティアを要求するか。省略 → 盤面既定
   *  (`BOARD_DEFAULT_TIER`)。「常に上位で」と言いたい Auditor のような役割の
   *  ための1行であり、model 名ではない —— 具体の model / effort は pickup 時に
   *  selector が盤面の表から選ぶ。ここでは `provider` と同じく自由文字列のまま
   *  持ち、列挙の検査は登録と pickup の門(`assertValidAgentDefinition`)が行う。 */
  tier?: string;
  /** ピン留めが退役した後も agent.md に残っている値の名前(ADR 0110 決定1)。
   *  `model` / `effort`(実行設定へ移った)と、トップレベルの `advisor`(entry の
   *  性質になった、ADR 0116 決定2)。**読み込みでは倒さない** —— 手で commit された違反が
   *  registry 全体を煉瓦にしないよう、拒否するのは登録と pickup の門である
   *  (`provider` の列挙違反と同じ扱い、ADR 0097 決定3)。 */
  retiredFields: readonly string[];
  /** Visual identity emoji for this agent (issue #52), shown by the board
   *  UI's AgentChip. Absent → the UI falls back to hashed initials. Loader
   *  checks only structural validity — a single Twemoji-covered grapheme
   *  (ADR 0026) — never semantics ("prefer sea creatures" stays a registry
   *  README convention, unenforceable by schema). */
  icon?: string;
  /** Skill allowlist (issue #56 / ADR 0025): the skills this agent may use in
   *  a worker session — the implementation counterpart of the `skills` in
   *  CONTEXT.md's Worker definition (agent = base AI + skills + instructions +
   *  authority profile). Required — omission is a load error (省略=無制限 の
   *  footgun is refused, issue #41's line); unrestricted is the explicit sole
   *  `["*"]`, all-denied is the empty list. The loader validates only the
   *  grammar of the vocabulary (`assertValidSkillAllowlist`), never the
   *  inventory — an allowlist is a reference, not a claim of stock (ADR 0023):
   *  a plugin-name typo or a workspace-absent individual name is inert, since
   *  an agent crosses many workspaces. Enforcement (the complement deny) lives
   *  in the adapter (ADR 0005). */
  skills: string[];
  systemPrompt: string;
  /** 組み込み agent の印(ADR 0117 決定2)。`parseAgentFile` は決して立てない ——
   *  立てるのは `loadRegistry` が名前の不在を見て synthesize する1箇所だけで、
   *  同名の registry ファイルがあればそれが勝ち、印は付かない(shadowing)。
   *  表示の built-in / shadows built-in はこの印から読み取り時に導出され、
   *  保存されない。 */
  builtin?: true;
}

/** An authority profile: `authority/<profile>.yaml` in the registry clone.
 *  `guidance` is prose injected into the agent's system prompt at spawn, and
 *  it is read literally: name the act and forbid it, and readers quote the
 *  clause back and escalate. Offer it instead as one example of a category
 *  ("irreversible or outward-facing") and the category call becomes the
 *  reader's — under the production `standard` wording the clause did not
 *  surface at all, and the one reader that did weigh it called it backwards
 *  ("gitignored, so I can just delete them"). Issue #489's 2026-08-25
 *  re-measurement, in `docs/real-environment-trial.md`, has the conditions and
 *  the counts. However it is written, guidance is never a floor (ADR 0013 /
 *  0035, CONTEXT.md 「床(Floor)」): a boundary that must hold goes in the two
 *  allowlists below or in a protected workspace, where the act converts to an
 *  approval question with no model in the path (ADR 0002 / 0013). Not in a
 *  flag — `risk` is a declaration the registrant makes, and `review` an opt-in
 *  to observation that widens nothing (CONTEXT.md 「Risk flag」/「Review flag」).
 *  `assignable_to` (issue #11) is a machine-enforced delegation allowlist —
 *  confused-deputy prevention: a decompose child assigned outside this list
 *  converts to an approval question rather than registering (ADR 0002).
 *  `allowed_workspaces` (issue #11) is its spatial analogue: a decompose
 *  child explicitly targeting a workspace outside this list converts the
 *  same way. A profile loaded from the registry (via `authorityProfileSchema`
 *  below) always carries all three machine-read fields explicitly — omission
 *  is a load error (issue #41: "absent means unrestricted" was a silent
 *  footgun for registry authors; ADR 0079 決定1 extends the same line to
 *  `merge`). Unrestricted must instead be spelled out with the wildcard
 *  `"*"`, which `outsideAuthority` (tasks.ts) reads as "no restriction". The
 *  fields stay optional on this TS type only because `AuthorityProfile`
 *  values are also hand-built in code paths that never go through the
 *  registry loader — the read-only reviewer floor (`REVIEWER_AUTHORITY_PROFILE`
 *  below, ADR 0013) and per-task `resolveAuthority` overrides in tests —
 *  where omission legitimately still means unrestricted / inert; issue #41 and
 *  ADR 0079 are registry-side profile hygiene only, not a change to that
 *  code-side shape.
 *  `merge` (issue #11, three-valued since ADR 0079) declares **which surface
 *  the human's merge decision lives on**: `escalate` the board's question
 *  surface, `auto_if_ci_green` the profile's own authority (unattended once CI
 *  passes, never for a risky task), `external` GitHub's own PR surface — the
 *  board opens the PR and neither asks nor observes (ADR 0079 決定2). */
export interface AuthorityProfile {
  name: string;
  guidance: string;
  assignable_to?: string[];
  allowed_workspaces?: string[];
  merge?: MergeDial;
}

/** The reviewer profile (ADR 0013 / issue #15 layer 2): read-only is a
 *  property of the `review` task type, not of whoever executes it, so this
 *  code constant overrides whatever authority profile the executing agent
 *  would otherwise carry — the one place in the authority model where task
 *  type overrides profile. A code constant, not a registry entry, so the
 *  enforcement floor itself sits outside what Condensation's registry-edit
 *  loop could ever propose a diff against. `allowed_workspaces: []` blocks
 *  every explicit workspace target; `assignable_to: []` blocks every
 *  explicit assignee except the one structural exception decomposeTask
 *  carves out for a review's own repair children (the reviewed task's own
 *  assignee — ADR 0013). The same "task type overrides profile" line reaches
 *  both spawn layers: ADR 0056's system-prompt assembly imports this exact
 *  profile for `## Authority`, while the CLI harness's `reviewToolDenials`
 *  (claude-worker.ts) reads `task.type` directly because the deny needs to
 *  exist before spawn resolves an authority profile — same task-type-not-agent
 *  principle, adapter-side enforcement primitive (ADR 0005). */
export const REVIEWER_AUTHORITY_PROFILE: AuthorityProfile = {
  name: "reviewer",
  guidance:
    "You are reviewing read-only. Never fix directly — findings become repair tasks.\n" +
    "Assign a repair to the worker in your roster: they executed the task you are reviewing.",
  assignable_to: [],
  allowed_workspaces: [],
};

/** The merge dial's values, one source for both the schema below and every TS
 *  union that spells them (same shape as MERGE_QUESTION_OPTIONS in tasks.ts) —
 *  a fourth value must not need a fourth edit. */
export const MERGE_DIAL_VALUES = ["escalate", "auto_if_ci_green", "external"] as const;
export type MergeDial = (typeof MERGE_DIAL_VALUES)[number];

/** The provider enumeration lives in provider.ts (a leaf, see there); this is
 *  the import surface every other module keeps using. */
export { PROVIDER_VALUES, type Provider } from "./provider.js";

/** 正規化された Provider entry(ADR 0110 決定1): 「この Provider で、advisor は
 *  あり / なし」の1件。advisor が entry 単位なのは、経路依存の能力だからである
 *  (ADR 0097 決定3)—— agent が複数の Provider を持つと、advisor は agent の
 *  性質ではなく「その経路で走るときの性質」になる。`name` は自由文字列のまま
 *  (列挙の検査は門)。 */
export interface AgentProviderEntry {
  name: string;
  advisor: boolean;
}

/** agent.md の3つの綴りを1つの正規形へ畳む(ADR 0110 決定1)。**登録の verb と
 *  parse が同じこの1本を通る** —— 2箇所で畳めば、フォームから来た定義と手で
 *  commit された定義が別の形になり、門が別々の判定に至る。
 *
 *  - 省略 → 盤面が知る Provider(`PROVIDER_VALUES` の宣言順)のうち、正準経路が
 *    `skills` を満たすものを advisor なしの床の構成で(ADR 0116 決定1)。適合0なら
 *    空の列になり、門が「宣言を満たす経路が無い」として拒む
 *  - 単一文字列 → advisor なしの長さ1の entry
 *  - 配列 → 要素は文字列または `{name, advisor?}`。advisor は entry にだけ書く
 *    (ADR 0116 決定2) */
export function normalizeProviderEntries(
  provider: unknown,
  skills: readonly string[],
): AgentProviderEntry[] {
  if (provider === undefined || provider === null || provider === "") {
    return PROVIDER_VALUES.filter((name) => routeSatisfiesSkills(name, skills)).map((name) => ({
      name,
      advisor: false,
    }));
  }
  const written = Array.isArray(provider) ? provider : [provider];
  return written.map((entry) =>
    typeof entry === "string"
      ? { name: entry, advisor: false }
      : { name: (entry as AgentProviderEntry).name, advisor: (entry as { advisor?: boolean }).advisor ?? false },
  );
}

/** The local execution harness selected by a canonical Provider route (ADR
 *  0098). This is board-owned routing state, never registry frontmatter. */
export type Harness = "claude-code" | "codex";

/** 正準経路の能力表(ADR 0098 / ADR 0116 決定1)。登録の門と省略の展開が同じこの表を
 *  読む。`skills` は「非空の skill allowlist を提供するか」(Codex は v1 で持たない)。 */
const CANONICAL_ROUTES: Record<Provider, { harness: Harness; advisor: boolean; skills: boolean }> = {
  anthropic: { harness: "claude-code", advisor: true, skills: true },
  moonshot: { harness: "claude-code", advisor: false, skills: true },
  openai: { harness: "codex", advisor: false, skills: false },
};

function routeSatisfiesSkills(provider: Provider, skills: readonly string[]): boolean {
  return skills.length === 0 || CANONICAL_ROUTES[provider].skills;
}

/** Provider -> Harness is a total, one-to-one-at-use mapping with no fallback
 *  (ADR 0098). A second Harness for a Provider is a new recorded decision. */
export function canonicalHarness(provider: Provider): Harness {
  return CANONICAL_ROUTES[provider].harness;
}

/** The provider select's options (value + display label) for the settings
 *  surface, served over GET /api/agents so the WebUI never hard-codes the
 *  enumeration and drifts from PROVIDER_VALUES — the same server-supplied
 *  wiring as the authority select's candidates (issue #71). The label prose
 *  lives here, not in the client bundle: what a provider *is* is server-side
 *  knowledge (ADR 0005's line). */
export const PROVIDER_OPTIONS: readonly { value: Provider; label: string }[] = [
  { value: "anthropic", label: "anthropic — Claude models, Anthropic billing" },
  { value: "moonshot", label: "moonshot — Kimi models, Moonshot Platform billing" },
  { value: "openai", label: "openai — Codex models, OpenAI billing" },
];

/** The providers whose server side implements the advisor capability (ADR
 *  0097 決定3): an agent that declares an advisor on a provider absent from
 *  this list is an invalid definition, not a masked one. Deliberately one
 *  small constant, not a generalized capability model — vendor knowledge
 *  belongs to the adapter (ADR 0005), and the #445 spawn adapter is the one
 *  that consumes/extends this list as it learns each provider's shape. */
export const PROVIDERS_WITH_ADVISOR: readonly Provider[] = PROVIDER_VALUES.filter(
  (provider) => CANONICAL_ROUTES[provider].advisor,
);

/** 組み込み agent の定義(CONTEXT.md「組み込み agent」/ ADR 0117 決定1): 盤面の
 *  code が frontmatter 相当を運び、registry にファイルを持たない。名前は Auditor
 *  ポインタの既定と**同じ1つの定数**から組む —— 組み込みの名前と既定の指し先は
 *  drift できない。`provider` は省略の展開そのもの(ADR 0116 決定1)で、非空の
 *  `skills` を満たす正準経路だけが残る。`authority` は ADR 0013 の reviewer 定数の
 *  名前だが、profile map は引かれない(`resolveExecutionAgent` の1分岐)——
 *  組み込みは授権を増やさないので、profile を registry にも map にも生やさない。
 *  `version` は registry の刻印ではないので固定文字列で、spawn 記録の
 *  `definition_version` がこれを運ぶ(当時版は registry commit に無い、ADR 0020)。 */
const BUILT_IN_AUDITOR_SKILLS = ["@workspace"];
const BUILT_IN_AUDITOR: AgentDefinition = {
  name: DEFAULT_AUDITOR_NAME,
  version: "built-in",
  authority: REVIEWER_AUTHORITY_PROFILE.name,
  description: "Reviews work independently against its completion criteria.",
  provider: normalizeProviderEntries(undefined, BUILT_IN_AUDITOR_SKILLS),
  retiredFields: [],
  icon: "🐡",
  skills: BUILT_IN_AUDITOR_SKILLS,
  systemPrompt: "",
  builtin: true,
};

/** その名前を組み込みが持っているか(ADR 0117 決定2)。registry に同名の
 *  エントリがあるかどうかとは独立 —— 「shadow している」を言えるのは、この
 *  述語と loaded map の印の2つが揃ったときだけである。 */
export function isBuiltInAgentName(name: string): boolean {
  return name === BUILT_IN_AUDITOR.name;
}

/** 定義が成立していない(ADR 0097 決定3 / ADR 0110 決定1): provider が列挙の外、
 *  advisor を提供しない正準経路に advisor が宣言されている、ティアが列挙の外、
 *  あるいは退役したピン留めが残っている。定義を受け入れる門 —— 登録
 *  (agent-create.ts)と pickup 解決(agent.ts の resolveExecutionAgent)—— で
 *  投げ、**読み込みでは投げない**: 手で commit された違反は registry 全体を
 *  煉瓦にせず、その agent 1体を隔離する。 */
export class InvalidAgentDefinitionError extends Error {
  constructor(
    public readonly agentName: string,
    reason: string,
  ) {
    super(`agent ${agentName}: ${reason}`);
    this.name = "InvalidAgentDefinitionError";
  }
}

/** 門が見る定義の断面。登録の verb は人間が送ったフォームの値を、pickup 解決は
 *  読み込み済みの `AgentDefinition` を、それぞれこの形で渡す。 */
export interface AgentDefinitionCheck {
  /** 正規化済みの entry 配列(ADR 0110 決定1)。登録の verb は
   *  `normalizeProviderEntries` を通した値を渡す —— 門が綴りの分岐を持たない。 */
  provider: readonly AgentProviderEntry[];
  tier?: string;
  skills?: readonly string[];
  retiredFields?: readonly string[];
}

/** 定義が成立しているかの検査(ADR 0097 決定1/3 / ADR 0110 決定1)—— 登録の verb
 *  と pickup 解決が**同じ1つの assertion** を通ることで、2つの門が別々の判定に
 *  ずれることがない。空白だけの値の正規化は parse 側(`isWritten`)に寄せてある
 *  ので、手で書かれたファイルと フォームから来た値が同じ判定に至る。 */
export function assertValidAgentDefinition(
  agentName: string,
  definition: AgentDefinitionCheck,
): void {
  const { provider: entries, tier, skills = [], retiredFields = [] } = definition;
  if (retiredFields.length > 0) {
    throw new InvalidAgentDefinitionError(
      agentName,
      `agent.md no longer carries the execution setting: ${retiredFields.join(" / ")} (ADR 0110 決定1). ` +
        "model and effort are chosen at pickup from the board's provider × tier table, and advisor is a " +
        "property of a provider entry whose model is derived from that same table (ADR 0116 決定2) — " +
        `declare a tier (${TIERS.join(" / ")}) and/or write the advisor on its entry, e.g. ` +
        "`provider: [{ name: anthropic, advisor: true }]`, instead",
    );
  }
  if (entries.length === 0) {
    throw new InvalidAgentDefinitionError(
      agentName,
      "no provider entry is left — a written empty list, or an omitted provider whose declaration no canonical " +
        "route satisfies, leaves no route this agent could ever run on (ADR 0116 決定1)",
    );
  }
  if (tier !== undefined && !(TIERS as readonly string[]).includes(tier)) {
    throw new InvalidAgentDefinitionError(
      agentName,
      `unknown tier "${tier}" (expected one of ${TIERS.join(" / ")}) — ADR 0110 決定1`,
    );
  }
  // entry 単位(ADR 0110 決定1): advisor も skill も**その経路**の性質なので、
  // 1つの entry が成立しないなら定義全体が成立しない —— 成立しない entry を
  // 黙って外して残りで走らせるのは、ADR 0097 決定3 が拒んだ「黙って落とす」である。
  for (const { name, advisor } of entries) {
    if (!(PROVIDER_VALUES as readonly string[]).includes(name)) {
      throw new InvalidAgentDefinitionError(
        agentName,
        `unknown provider "${name}" (expected one of ${PROVIDER_VALUES.join(" / ")})`,
      );
    }
    const route = CANONICAL_ROUTES[name as Provider];
    if (advisor && !route.advisor) {
      throw new InvalidAgentDefinitionError(
        agentName,
        `canonical route "${name} -> ${route.harness}" does not offer an advisor — a definition declaring one does not stand (ADR 0098)`,
      );
    }
    if (!routeSatisfiesSkills(name as Provider, skills)) {
      throw new InvalidAgentDefinitionError(
        agentName,
        `canonical route "${name} -> ${route.harness}" does not offer skills in v1 — ` +
          "a definition declaring a non-empty allowlist does not stand (ADR 0098)",
      );
    }
  }
}

const workspaceEntrySchema = z.object({
  /** Absent → regulation-derived at resolution time (ADR 0018): base
   *  directory (`TIDEPOOL_WORKSPACES_DIR`) + workspace name, computed at
   *  `resolveExecutionWorkspace` (workspace.ts), never baked in here. Entries
   *  the board writes itself (clone / new-repo creation modes) stay host-
   *  independent this way — a push from one host's clone can't commit the
   *  other host's absolute path. Explicit `path` stays for hand-placed
   *  checkouts (the registry itself, existing-path registration mode). */
  path: z.string().optional(),
  /** **この workspace のリモート正本の宣言**(ADR 0052 決定3 / issue #211)。以前は
   *  「手でセットアップするための clone URL」という散文だったが、機械が読む
   *  フィールドへ昇格した —— あり = remote 正本を持つ、無し = purely-local。
   *
   *  宣言を持つ workspace では、タスクブランチの fork 元も slot 解放後の休止位置も
   *  リモート側の保護ブランチ(`refs/remotes/origin/<branch>`)を基準に取り、pickup
   *  の直前に fetch される。clone を覗いて remote の有無で推測することはしない ——
   *  推測はリモートが失われた瞬間に「merge が spawn に効かない」旧挙動へ静かに戻る
   *  道であり、宣言と実態のずれ(どちら向きでも)は quarantine に落ちる。
   *
   *  盤面が読むのは有無だけで、値(clone URL)は人間向けの provenance のまま ——
   *  URL の綴り(ssh / https)で実態と突き合わせることはしない。 */
  repo: z.string().optional(),
  notes: z.string().optional(),
  /** Protected workspace (issue #15 layer 2 / ADR 0013): a decompose child
   *  targeting this workspace converts to an approval question unconditionally,
   *  regardless of the registering worker's authority profile. v1's only use is
   *  the registry itself — "changes to it always need human approval" is a
   *  resource-side invariant, independent of any profile's allowed_workspaces. */
  protected: z.boolean().optional(),
  /** The protected branch this workspace's tasks fork from and PR onto
   *  (issue #27 / ADR 0023): task-branch fork point, PR base, and direct-
   *  write-ban target, all one field. Absent → "main". A reference, not a
   *  pinned fork fact — resolved fresh against the registry at every use
   *  moment (ensureTaskBranch, PR open), never baked into a task row. */
  branch: z.string().optional(),
  /** Host-independent command prefixes a review session may run despite the
   *  `--permission-mode manual` write floor (issue #144 / ADR 0035). Absent →
   *  empty. The board mechanically turns each into a `Bash(<prefix>*)` token
   *  for `--allowedTools` at spawn time (claude-worker.ts) — the registry
   *  carries the command, never the CLI's spelling, the same split as the
   *  skill allowlist's names-not-paths rule (ADR 0033).
   *
   *  This is the one registry field that *widens* a session's permissions —
   *  the only one whose value lifts the review write floor itself. Its gate is
   *  the human surface's credential (ADR 0036) plus an explicit confirmation
   *  of the dangerous value, not a pull request (ADR 0061 — correcting this
   *  comment's earlier claim that a protected workspace's human merge was the
   *  gate: human-authored registry changes commit straight to the protected
   *  branch and never see a PR). `assertValidReviewAllowedCommands` guards the
   *  grammar so a spelling can't reach past what that human read. */
  review_allowed_commands: z.array(z.string()).optional(),
  /** Domains this workspace's worker sessions may reach through the sandbox
   *  network proxy (issue #321 / ADR 0072). Absent keeps egress closed. */
  allowed_domains: z.array(z.string()).optional(),
});

/** A workspace entry in `workspaces.yaml`: where tasks run (name → path on
 *  the host), plus provenance for setting the checkout up by hand. */
export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export interface Registry {
  /** HEAD commit hash of the clone — the provenance stamp recorded on spawn. */
  commit: string;
  agents: Record<string, AgentDefinition>;
  authority: Record<string, AuthorityProfile>;
  workspaces: Record<string, WorkspaceEntry>;
}

/** One roster line's worth of an `AgentDefinition` (issue #43 / ADR 0014):
 *  a delegating agent only ever needs the name and the "when to delegate
 *  here" prose, never the vendor fields (`model`/`effort`, ADR 0005's line).
 *  Named so the pull half's plumbing (McpDeps/ServerOptions/BootOptions,
 *  each threading a registry → mcp.ts list of these) carries one shared
 *  type instead of repeating the same anonymous `{ name; description }`
 *  shape at every layer. */
export interface RosterAgent {
  name: string;
  description: string;
}

/** Assignee/workspace name candidates for the registration screen (issue
 *  #12), resolved from the registry by the caller (main.ts) — the API/server
 *  layers never touch the filesystem/git registry loader themselves. */
export interface RegistryCandidates {
  assignees: string[];
  workspaces: string[];
  /** Assignee name → icon (issue #52), for agents that have one configured.
   *  An assignee absent from this map has no icon — the board UI's
   *  AgentChip falls back to hashed initials for it. */
  icons: Record<string, string>;
}

/** ADR 0026: an agent icon must be a single Twemoji-covered emoji grapheme —
 *  parsing it must yield exactly one entity spanning the whole string. Two
 *  emoji, trailing text, or an emoji outside Twemoji's coverage all fail
 *  this the same way (fewer/more entities, or entity indices short of the
 *  full length). */
export function isSingleTwemojiGrapheme(value: string): boolean {
  const entities = parseTwemoji(value);
  if (entities.length !== 1) return false;
  const [entity] = entities;
  return entity!.indices[0] === 0 && entity!.indices[1] === value.length;
}

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
export const SKILL_SCOPES = new Set(["@workspace", "@host"]);

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

/** An agent's `skills` frontmatter breaks ADR 0025's allowlist grammar. The
 *  entrance-guard twin of InvalidAgentIconError (agent-create.ts): thrown by
 *  the loader and re-checked before a WebUI write so a malformed allowlist
 *  can't brick the next `loadRegistry`. */
export class InvalidSkillAllowlistError extends Error {
  constructor(public readonly entry: string, reason: string) {
    super(`invalid skill allowlist entry "${entry}": ${reason}`);
    this.name = "InvalidSkillAllowlistError";
  }
}

/** Grammar-only validation of a skill allowlist (issue #56 / ADR 0025) — never
 *  inventory: an allowlist is a reference, not a claim of stock (ADR 0023), so
 *  a plugin-name typo or a workspace-absent individual name is inert, checked
 *  only for shape. The vocabulary is five forms: the sole `"*"` (unrestricted,
 *  valid only alone), the `@workspace`/`@host` scope words, a `名前:*` plugin
 *  glob, and an exact individual name (`skill` or `plugin:skill`). A `*` may
 *  appear only as the bare wildcard or a glob suffix; a bare `[]` (all-denied)
 *  is valid. */
export function assertValidSkillAllowlist(skills: string[]): void {
  for (const entry of skills) {
    if (entry === SKILL_WILDCARD) {
      if (skills.length !== 1) {
        throw new InvalidSkillAllowlistError(entry, 'the "*" wildcard must be the only entry');
      }
      continue;
    }
    if (entry.startsWith("@")) {
      if (!SKILL_SCOPES.has(entry)) {
        throw new InvalidSkillAllowlistError(entry, "unknown scope (only @workspace / @host)");
      }
      continue;
    }
    if (entry.includes("*") && !isPluginGlob(entry)) {
      throw new InvalidSkillAllowlistError(entry, 'a "*" may appear only as "*" alone or a "名前:*" glob');
    }
    if (entry === "") {
      throw new InvalidSkillAllowlistError(entry, "empty skill name");
    }
  }
}

/** A workspace's `review_allowed_commands` breaks ADR 0035's grammar. Same
 *  entrance-guard role as InvalidSkillAllowlistError above: thrown by the
 *  loader and re-checked before a human-door write (ADR 0061) so a malformed
 *  value can't brick the next `loadRegistry`. */
export class InvalidReviewAllowedCommandError extends Error {
  constructor(public readonly entry: string, reason: string) {
    super(`invalid review_allowed_commands entry "${entry}": ${reason}`);
    this.name = "InvalidReviewAllowedCommandError";
  }
}

/** Grammar-only validation of `review_allowed_commands` (issue #144 / ADR
 *  0035) — never inventory, the same line as the skill allowlist above: a
 *  prefix naming a command this host does not have is inert, not an error.
 *
 *  What the grammar is actually for is narrower than "well-formed". This is
 *  the one registry field that *widens* a review session's permissions, and
 *  its gate is a human reading the value — in the registry PR when an agent
 *  authored it, in the human surface's confirmation dialog when a person did
 *  (ADR 0061; the earlier "only gate is a human reading the registry PR" left
 *  the human-authored path out, which commits straight to the protected branch
 *  and never opens a PR). Every rule below exists so that what the human read
 *  is what the CLI receives — the dialog's enumeration as much as the diff's:
 *
 *  - **no comma** — `--allowedTools` is comma-joined (claude-worker.ts), so
 *    `"npm test,rm -rf /"` reads as one allowance in the diff and arrives as
 *    two at the CLI. The injection this closes is the whole reason the field
 *    is validated at all.
 *  - **no newline or control character** — same smuggling, one layer down: an
 *    entry that renders as one line in a diff must not carry a second.
 *  - **no `*`, `(`, `)`** — the registry carries a *command prefix*, not the
 *    CLI's pattern spelling; the board adds `Bash(…*)` itself. Letting an
 *    entry bring its own syntax would put the CLI's grammar into registry data
 *    (ADR 0033's names-not-paths rule, restated for commands).
 *  - **non-empty, no leading/trailing space** — an empty or space-padded entry
 *    becomes `Bash(*)` or `Bash( foo*)`: the first opens everything, the
 *    second silently matches nothing. Both are worse than a loud rejection. */
export function assertValidReviewAllowedCommands(commands: string[]): void {
  for (const entry of commands) {
    if (entry === "") {
      throw new InvalidReviewAllowedCommandError(entry, "empty command prefix");
    }
    if (entry.includes(",")) {
      throw new InvalidReviewAllowedCommandError(
        entry,
        "a comma would inject an extra --allowedTools token past the registry review",
      );
    }
    if (/[\u0000-\u001f\u007f]/.test(entry)) {
      throw new InvalidReviewAllowedCommandError(entry, "control characters are not allowed");
    }
    if (/[*()]/.test(entry)) {
      throw new InvalidReviewAllowedCommandError(
        entry,
        'the CLI pattern spelling is the board\'s to add — write the command prefix alone (e.g. "npm test")',
      );
    }
    if (entry !== entry.trim()) {
      throw new InvalidReviewAllowedCommandError(entry, "leading or trailing whitespace");
    }
  }
}

/** A workspace domain allowlist entry is not valid registry grammar. */
export class InvalidAllowedDomainError extends Error {
  constructor(public readonly entry: string, reason: string) {
    super(`invalid allowed_domains entry "${entry}": ${reason}`);
    this.name = "InvalidAllowedDomainError";
  }
}

function isIpLiteralHost(domain: string): boolean {
  if (isIP(domain) !== 0) return true;
  try {
    return isIP(new URL(`http://${domain}`).hostname) !== 0;
  } catch {
    return false;
  }
}

/** Grammar-only validation of workspace-scoped egress domains (ADR 0072). */
export function assertValidAllowedDomains(domains: string[]): void {
  for (const entry of domains) {
    if (entry === "") throw new InvalidAllowedDomainError(entry, "empty domain");
    if (entry === "*") {
      throw new InvalidAllowedDomainError(entry, "bare wildcard is not allowed");
    }
    const domain = entry.startsWith("*.") ? entry.slice(2) : entry;
    // ADR 0139 decision 3: an IP does not name an operator.
    if (isIpLiteralHost(domain)) {
      throw new InvalidAllowedDomainError(entry, "IP literals are not allowed");
    }
    if (entry.includes(":") || entry.includes("/")) {
      throw new InvalidAllowedDomainError(entry, "expected a domain name");
    }
    const labels = domain.split(".");
    if (
      domain.length > 253 ||
      labels.some(
        (label) =>
          !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label),
      ) ||
      (entry.includes("*") && !entry.startsWith("*."))
    ) {
      throw new InvalidAllowedDomainError(entry, "expected a domain name");
    }
  }
}

const agentFrontmatterSchema = z.looseObject({
  version: z.coerce.string(),
  authority: z.string(),
  description: z.string(),
  // 3つの綴り(省略 / 単一文字列 / entry 配列、ADR 0110 決定1)をそのまま受け、
  // 正規化は `normalizeProviderEntries` が1箇所で行う。要素の中身は自由文字列の
  // まま —— 列挙の検査は門であって読み込みではない(ADR 0097 決定3)。
  provider: z
    .union([
      z.string(),
      z.array(
        z.union([z.string(), z.looseObject({ name: z.string(), advisor: z.boolean().optional() })]),
      ),
    ])
    .nullish(),
  // 自由文字列のまま(`provider` と同じ理由 — 列挙の検査は門であって読み込みでは
  // ない、ADR 0097 決定3)。値の集合は ADR 0110 の3ティア。
  // nullish: 値の無い `tier:` の1行(YAML では null)で registry 読み取り全体を
  // 倒さない —— 空白だけの値と同じく「書かれていない」として扱う。
  tier: z.string().nullish(),
  icon: z
    .string()
    .refine(isSingleTwemojiGrapheme, {
      message: "icon must be a single Twemoji-covered emoji grapheme",
    })
    .optional(),
  skills: z.array(z.string()),
});

/** ADR 0020: the branch the board reads the registry from is a code constant,
 *  not registry data. "Which branch do we trust to read from" is part of the
 *  protected-workspace floor (same shape as ADR 0013's reviewer floor); putting
 *  it in the data it guards (workspaces.yaml's branch field, issue #27) would be
 *  self-referential and break bootstrap. The working tree is never read — branch
 *  discipline moves the checkout's HEAD onto a registry-edit task branch, so a
 *  working-tree read would let unmerged content take effect on spawn. */
export const REGISTRY_BRANCH = "main";

/** ADR 0052 決定3: この盤面の registry が remote 正本を持つか。**宣言であって
 *  推測ではない** — clone を覗いて切り替えると、remote が失われた瞬間に ADR 0052
 *  が直した壊れ方(merge が spawn に効かない)へ静かに戻る。既定値を持たせない
 *  のも同じ理由で、`loadRegistry` の引数を必須にしてある。 */
export type RegistryMode = "remote-backed" | "purely-local";

/** `registryDir` と `registryMode` は必ず一緒に運ばれる(issue #210 レビュー —
 *  `AgentAdminDeps` / `ProfileAdminDeps` / `WorkspaceAdminDeps` /
 *  `ClaudeWorkerOptions` の4つが両方を持つ Data Clumps だった)。どの clone を
 *  読み書きするかは「パス」と「そのパスが remote 正本を持つか」の組でしか
 *  意味を持たないので、1つの型にまとめる。 */
export interface RegistrySource {
  dir: string;
  mode: RegistryMode;
}

/** リモート側のブランチを指す remote-tracking ref の**綴り**。ADR 0052 のもとで
 *  「リモートの正本を読む」は registry の役(`registryRef` の下)と workspace の役
 *  (`protectedBranchRef`)の2箇所に現れるが、綴りそのものは1つでなければならない
 *  —— 2つ持つと、片方だけを直したときに黙ってずれる(/code-review Standards 軸の
 *  指摘)。どちらの ref を読むかの判断は各役の宣言が持ち、ここは綴りだけを持つ。 */
export function remoteTrackingRef(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

/** `mode` が指す、盤面が registry を読み書きする1つの ref — remote-tracking
 *  main（remote-backed)か、ローカル main そのもの(purely-local)。`loadRegistry`
 *  の読みと `registry-write.ts` の書き込みが同じ関数を呼ぶことで、両者が同じ
 *  ref を指す(`refreshRegistryForWrite` が支えたい不変条件そのもの)ことを
 *  2箇所の複製ではなく1箇所の共有で保証する。 */
export function registryRef(mode: RegistryMode): string {
  return mode === "remote-backed" ? remoteTrackingRef(REGISTRY_BRANCH) : REGISTRY_BRANCH;
}

export interface RegistryReachability {
  available: boolean;
  reason?: string;
}
export type RegistryReachabilityCheck = () => Promise<RegistryReachability>;

// stderr piped (not inherited), same as workspace.ts's `git()`: git narrates a
// missing ref on stderr, and the board's console is not the place for it — the
// message still rides the thrown error for callers that want it (agentBodyAtCommit
// swallows it by design).
const GIT_STDIO: ["ignore", "pipe", "pipe"] = ["ignore", "pipe", "pipe"];

/** 盤面が registry の remote-tracking ref を更新する**唯一の関数**(ADR 0052 決定2)。
 *  **非同期である**: 仲介から installation token を取る往復が中に入る(ADR 0093
 *  決定2)。fetch そのものは今も `execFileSync` の同期呼び出しで、非同期なのは
 *  token の取得だけである。起動時の refresh(`bootRefresh`)もこの await を連れて
 *  `buildServerOptions` の先頭に留まるので、「registry を1文字も読む前に撃つ」
 *  という順序は変わらない。
 *
 *  **`tidepool-board[bot]` 名義で撃つ**(ADR 0093 / CONTEXT.md の GitHub identity:
 *  「盤面が執行する操作は読み取り・書き込み・merge を問わずすべてこの名義」)。
 *  registry は private なので認証が要り、しかも `authedGit` の credential 引数は
 *  ホストに設定済みの helper を**先にクリアする** —— つまりこの1行は「認証を足す」
 *  だけでなく「人間の `gh` ログインに寄りかからない」ことを同時に成立させる。
 *  ホストに人間の helper が居ると認証なしでも fetch が通ってしまうため、実機で
 *  成功したことはこの条件の証拠にならない(issue #209 の実測)。
 *
 *  `auth` 不在は「盤面が GitHub 身元を持たない」の宣言であり、書き込み側の
 *  push(`registry-write.ts` の `commitToRegistry`)と同じく bare な git に
 *  委ねる。private な remote ならそこで失敗し、レジストリ到達性の quarantine が
 *  人間を呼ぶ。
 *
 *  token の取得を try の**内側**に置くのがこの関数の要点である(ADR 0093 決定7):
 *  仲介の不達・user token の失効・5xx はここで「registry が refresh できなかった」
 *  1つの答えに畳まれ、既存の到達性 quarantine がそのまま受ける —— 新しい失敗の
 *  語彙は盤面側に現れない。
 *
 *  Failure is returned as data so the caller can quarantine or warn instead of
 *  throwing. */
export async function refreshRegistry(
  dir: string,
  auth: GitHubAuth | undefined,
): Promise<RegistryReachability> {
  try {
    const repo = originRepo(dir);
    await auth?.ensureToken(repo);
    authedGitBounded(
      auth,
      dir,
      repo,
      GIT_NETWORK_TIMEOUT_MS,
      "fetch",
      "--quiet",
      "origin",
      REGISTRY_BRANCH,
    );
    return { available: true };
  } catch (err) {
    return {
      available: false,
      reason: `the registry remote main could not be refreshed (${String(err)})`,
    };
  }
}

/** Read one committed file's content at `ref` — `git show ref:path`. The board
 *  reads the registry from the committed branch, never the working tree. */
function gitShowFile(dir: string, ref: string, path: string): string {
  return execFileSync("git", ["show", `${ref}:${path}`], { cwd: dir, stdio: GIT_STDIO }).toString();
}

/** The committed registry files at `commit`, path → content, read in a fixed
 *  number of git spawns whatever the file count (issue #983): one `ls-tree`
 *  lists the blobs, one `cat-file --batch` streams them all. Only direct
 *  children of `agents/` (`.md`) and `authority/` (`.yaml`) plus
 *  `workspaces.yaml` are kept; a missing directory contributes nothing — the
 *  "absent is empty, not an error" shape `readdirSync` had. */
function readRegistryFiles(dir: string, commit: string): Map<string, string> {
  const listing = execFileSync(
    "git",
    ["ls-tree", "-r", "-z", commit, "--", "agents", "authority", "workspaces.yaml"],
    { cwd: dir, stdio: GIT_STDIO },
  ).toString();
  const blobs: { path: string; sha: string }[] = [];
  for (const entry of listing.split("\0")) {
    // `<mode> <type> <sha>\t<path>`
    const match = entry.match(
      /^\d+ blob ([0-9a-f]+)\t(agents\/[^/]+\.md|authority\/[^/]+\.yaml|workspaces\.yaml)$/,
    );
    if (match) blobs.push({ sha: match[1]!, path: match[2]! });
  }
  const files = new Map<string, string>();
  const out = execFileSync("git", ["cat-file", "--batch"], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    input: `${blobs.map((b) => b.sha).join("\n")}\n`,
  });
  // 出力は `<sha> blob <size>\n<content>\n` の繰り返し。本文は文字数でなく
  // バイト数で切る(マルチバイトの本文では両者がずれる)
  let offset = 0;
  for (const { path } of blobs) {
    const headerEnd = out.indexOf(0x0a, offset);
    const size = Number(out.toString("utf8", offset, headerEnd).split(" ")[2]);
    files.set(path, out.toString("utf8", headerEnd + 1, headerEnd + 1 + size));
    offset = headerEnd + 1 + size + 1;
  }
  return files;
}

/** Split a `---\nfrontmatter\n---\nbody` document into its two halves, or null
 *  when the frontmatter fence is absent. One regex shared by the agent-file
 *  parser and the historical-body read (ADR 0020 part 4), so the split is
 *  spelled once. */
function splitFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  return match ? { frontmatter: match[1]!, body: match[2]! } : null;
}

/** The system-prompt body of an agent definition as it stood at a given commit
 *  (ADR 0020 part 4) — `git show <commit>:agents/<name>.md` with the frontmatter
 *  stripped. Best-effort: returns undefined when the commit or file is gone
 *  (e.g. a kill left no worker_spawned hash, or the definition post-dates it) or
 *  the file has no parseable body, so a self-RCA spawn degrades to no injected
 *  evidence rather than failing the spawn. Deliberately does not run the full
 *  frontmatter schema — an older, differently-shaped definition is still valid
 *  evidence for "why did I decide", and this read must not reject it. */
export function agentBodyAtCommit(
  dir: string,
  commit: string,
  agentName: string,
): string | undefined {
  let raw: string;
  try {
    raw = gitShowFile(dir, commit, `agents/${agentName}.md`);
  } catch {
    return undefined;
  }
  return splitFrontmatter(raw)?.body.trim();
}

/** 空白だけ・null・キー不在をまとめて「書かれていない」とする(登録の門が
 *  かつて `normalizeAdvisor` で行っていた正規化を、両方の門が同じ判定に至る
 *  よう parse の側に1つだけ置いた)。 */
function isWritten(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/** agent.md に残っている退役フィールド。`model` / `effort` は実行設定へ移り
 *  (ADR 0110 決定1)、トップレベルの `advisor` は entry の性質になった(ADR 0116
 *  決定2)—— どれも黙って無視すると「書いたのに効かない値」になるので、門が名前を
 *  挙げて拒否する。スキーマは looseObject なので、値の形を問わず読み込みは倒れない。 */
function retiredExecutionFields(raw: unknown): string[] {
  const meta = (raw ?? {}) as Record<string, unknown>;
  return ["model", "effort", "advisor"].filter((name) => isWritten(meta[name]));
}

function parseAgentFile(name: string, raw: string): AgentDefinition {
  const split = splitFrontmatter(raw);
  if (!split) {
    throw new Error(`agent ${name}: missing frontmatter`);
  }
  const { frontmatter, body } = split;
  const parsed = parseYaml(frontmatter);
  const meta = agentFrontmatterSchema.parse(parsed);
  // grammar-only (ADR 0025): the schema guarantees `skills` is a string array;
  // this rejects malformed vocabulary before the definition is trusted.
  assertValidSkillAllowlist(meta.skills);
  return {
    name,
    version: meta.version,
    authority: meta.authority,
    description: meta.description,
    provider: normalizeProviderEntries(meta.provider, meta.skills),
    tier: isWritten(meta.tier) ? (meta.tier as string) : undefined,
    retiredFields: retiredExecutionFields(parsed),
    icon: meta.icon,
    skills: meta.skills,
    systemPrompt: body.trim(),
  };
}

// closed schema: an escalation-rights field cannot exist even by
// misconfiguration — upward escalation is never restricted (issue #7).
// assignable_to/allowed_workspaces are required, not optional: a registry
// author must spell out "*" for unrestricted rather than get it by omission
// (issue #41).
export const authorityProfileSchema = z.strictObject({
  guidance: z.string(),
  assignable_to: z.array(z.string()),
  allowed_workspaces: z.array(z.string()),
  merge: z.enum(MERGE_DIAL_VALUES),
});

/** No authority profile in the registry carries this name — thrown both when
 *  an agent's `authority` field references one that doesn't exist
 *  (agent-create.ts) and when editing a profile by a name the registry
 *  doesn't have (profile-create.ts, issue #76): the same "profile absent"
 *  condition, one class. */
export class UnknownAuthorityProfileError extends Error {
  constructor(public readonly profileName: string) {
    super(`unknown authority profile: ${profileName}`);
    this.name = "UnknownAuthorityProfileError";
  }
}

const workspacesSchema = z.record(z.string(), workspaceEntrySchema);

/** Grammar check across a parsed workspaces.yaml (ADR 0035). Runs at load, the
 *  same moment `parseAgentFile` checks a skill allowlist: a malformed widening
 *  must fail the registry read loudly, never reach a spawn quietly. */
function assertValidWorkspaces(workspaces: z.infer<typeof workspacesSchema>): void {
  for (const entry of Object.values(workspaces)) {
    assertValidReviewAllowedCommands(entry.review_allowed_commands ?? []);
    assertValidAllowedDomains(entry.allowed_domains ?? []);
  }
}

function parseAuthorityFile(name: string, raw: string): AuthorityProfile {
  const profile = authorityProfileSchema.parse(parseYaml(raw));
  return {
    name,
    guidance: profile.guidance,
    assignable_to: profile.assignable_to,
    allowed_workspaces: profile.allowed_workspaces,
    merge: profile.merge,
  };
}

/** Issue #68 / ADR 0018: the charset a registry-entry name (workspace or
 *  agent, issue #70) must stay inside to be safe as a directory name
 *  (regulation-derived `path`), a GitHub repository name (clone / new-repo
 *  creation modes), and the file name `agents/<name>.md`. */
const REGISTRY_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** `.` and `..` pass the charset above but are reserved by every filesystem
 *  (self / parent directory) — an entry named either would derive a path
 *  that escapes its intended base directory. */
const RESERVED_REGISTRY_NAMES = new Set([".", ".."]);

const NAME_CHARSET_REASON =
  "must contain only letters, digits, '-', '_', '.' and not be '.' or '..'";

/** A candidate workspace name fails the entry gate the creation modes
 *  (issue #57 phase 2) will use: reused inside an existing registry, or
 *  outside the charset both a directory name and a GitHub repo name accept. */
export class InvalidWorkspaceNameError extends Error {
  constructor(
    public readonly workspaceName: string,
    reason: string,
  ) {
    super(`invalid workspace name "${workspaceName}": ${reason}`);
    this.name = "InvalidWorkspaceNameError";
  }
}

/** Pure entry-gate validation for a new workspace name (issue #68), ahead of
 *  the orchestration (clone / new-repo creation, phase 2) that will actually
 *  register it. Checks uniqueness against `registry` and the shared charset —
 *  safe for both a directory name and a GitHub repository name. */
export function assertValidWorkspaceName(registry: Registry, name: string): void {
  if (RESERVED_REGISTRY_NAMES.has(name) || !REGISTRY_NAME_PATTERN.test(name)) {
    throw new InvalidWorkspaceNameError(name, NAME_CHARSET_REASON);
  }
  if (Object.hasOwn(registry.workspaces, name)) {
    throw new InvalidWorkspaceNameError(name, "a workspace with this name already exists");
  }
}

/** A candidate agent name fails the entry gate the WebUI's agent-creation
 *  verb (issue #70) uses: reused inside an existing registry, or outside the
 *  charset a file name `agents/<name>.md` safely accepts. */
export class InvalidAgentNameError extends Error {
  constructor(
    public readonly agentName: string,
    reason: string,
  ) {
    super(`invalid agent name "${agentName}": ${reason}`);
    this.name = "InvalidAgentNameError";
  }
}

/** Pure entry-gate validation for a new agent name (issue #70), the agent
 *  twin of assertValidWorkspaceName above: same charset (safe as the file
 *  name `agents/<name>.md`), same reserved names, uniqueness against the
 *  registry's agents. */
export function assertValidAgentName(registry: Registry, name: string): void {
  if (RESERVED_REGISTRY_NAMES.has(name) || !REGISTRY_NAME_PATTERN.test(name)) {
    throw new InvalidAgentNameError(name, NAME_CHARSET_REASON);
  }
  // 組み込みのエントリは不在として扱う(ADR 0117 決定2): 気に入った名前で自作の
  // Auditor を持てるよう、作成の扉は同名を拒まない —— 拒む代わりに shadow を告げる
  const existing = ownEntry(registry.agents, name);
  if (existing && existing.builtin !== true) {
    throw new InvalidAgentNameError(name, "an agent with this name already exists");
  }
}

/** A candidate authority profile name fails the entry gate the WebUI's
 *  profile-creation verb (issue #76) uses: reused inside an existing
 *  registry, or outside the charset a file name `authority/<name>.yaml`
 *  safely accepts. */
export class InvalidAuthorityProfileNameError extends Error {
  constructor(
    public readonly profileName: string,
    reason: string,
  ) {
    super(`invalid authority profile name "${profileName}": ${reason}`);
    this.name = "InvalidAuthorityProfileNameError";
  }
}

/** Pure entry-gate validation for a new authority profile name (issue #76),
 *  the third twin of assertValidWorkspaceName/assertValidAgentName: same
 *  charset (safe as the file name `authority/<name>.yaml`), same reserved
 *  names, uniqueness against the registry's profiles. */
export function assertValidAuthorityProfileName(registry: Registry, name: string): void {
  if (RESERVED_REGISTRY_NAMES.has(name) || !REGISTRY_NAME_PATTERN.test(name)) {
    throw new InvalidAuthorityProfileNameError(name, NAME_CHARSET_REASON);
  }
  if (Object.hasOwn(registry.authority, name)) {
    throw new InvalidAuthorityProfileNameError(name, "an authority profile with this name already exists");
  }
}

/** Bracket access with an Object.hasOwn guard (issue #69): registry records
 *  are plain objects, so a key like "toString" would otherwise hit
 *  Object.prototype and dodge the fail-closed unknown-name guarantees (ADR
 *  0009 / 0012). Every registry-record lookup by untrusted name goes through
 *  here — the guarantee lives in one place. */
export function ownEntry<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Load the registry from its declared committed source (ADR 0020 / ADR 0052)
 *  — remote-tracking main for a remote-backed board, local main for a
 *  purely-local board, and never the working tree. Every content read and the
 *  provenance `commit` come from the one commit the ref resolves to first, so
 *  they agree by construction.
 *
 *  `mode` に既定値を置かない。既定があると、渡し忘れた呼び出しが**静かに**
 *  ローカル main へ落ちる —— remote 正本を宣言した盤面でも spawn の入力だけが
 *  古いまま、どこも赤くならない。ADR 0052 決定3 が推測を却下した理由と同じ形の
 *  フォールバックなので、必須にして tsc に全呼び出しを名指しさせる
 *  (containment.ts の「省略 = 無制限という footgun は作らない」と同じ線)。 */
export function loadRegistry(dir: string, mode: RegistryMode): Registry {
  // ref を先に1つの commit へ解決し、以降はその commit だけを読む
  const commit = execFileSync("git", ["rev-parse", registryRef(mode)], {
    cwd: dir,
    stdio: GIT_STDIO,
  })
    .toString()
    .trim();
  const files = readRegistryFiles(dir, commit);
  const agents: Record<string, AgentDefinition> = {};
  const authority: Record<string, AuthorityProfile> = {};
  for (const [path, raw] of files) {
    if (path.startsWith("agents/")) {
      const agent = parseAgentFile(basename(path, ".md"), raw);
      agents[agent.name] = agent;
    } else if (path.startsWith("authority/")) {
      const profile = parseAuthorityFile(basename(path, ".yaml"), raw);
      authority[profile.name] = profile;
    }
  }
  // 名前の解決は registry が先、無ければ組み込み(ADR 0117 決定2 の shadowing)。
  // ここで1つの map に畳むので、下流(assignee 候補・review_by 検査・roster・
  // spawn)は名前の解決では分岐を持たない。唯一の分岐は profile の解決
  // (`resolveExecutionAgent`)—— 組み込みの profile は registry に無いので、
  // そこだけが印を読む。
  if (!Object.hasOwn(agents, BUILT_IN_AUDITOR.name)) agents[BUILT_IN_AUDITOR.name] = BUILT_IN_AUDITOR;
  const workspacesYaml = files.get("workspaces.yaml");
  if (workspacesYaml === undefined) throw new Error(`workspaces.yaml is missing at ${commit}`);
  const workspaces = workspacesSchema.parse(parseYaml(workspacesYaml));
  assertValidWorkspaces(workspaces);
  return { commit, agents, authority, workspaces };
}
