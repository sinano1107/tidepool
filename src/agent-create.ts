import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { UnknownAgentError } from "./agent.js";
import type { GitHubAuth } from "./github-auth.js";
import {
  type AgentDefinition,
  type AgentProviderEntry,
  assertValidAgentDefinition,
  assertValidAgentName,
  assertValidSkillAllowlist,
  isBuiltInAgentName,
  isSingleTwemojiGrapheme,
  loadRegistry,
  normalizeProviderEntries,
  ownEntry,
  type Registry,
  type RegistrySource,
  UnknownAuthorityProfileError,
} from "./registry.js";
import {
  commitToRegistry,
  DeletionBlockedError,
  type DeletionBlockedReason,
  DeletionConfirmationRequiredError,
  refreshRegistryForWrite,
} from "./registry-write.js";

/** The WebUI's agent-creation verb (issue #70, #54 phase 1): every field an
 *  agent definition carries except `version` — that one is machine-stamped
 *  (create → "1"), never caller-supplied, so the input type simply doesn't
 *  have it. */
export interface CreateAgentInput {
  name: string;
  authority: string;
  description: string;
  /** The provider declaration (ADR 0097 決定1) — required like the registry
   *  field it lands in; the enum, the tier and the advisor combination are all
   *  checked against `assertValidAgentDefinition` before anything is written. */
  provider: string;
  icon?: string;
  /** 既定の要求ティア(ADR 0110 決定1)。省略 → 盤面既定。model / effort は
   *  もう受け取らない —— 実行設定は pickup 時に盤面の表から選ばれる。 */
  tier?: string;
  /** advisor を持つか(ADR 0110 決定1: 真偽値であって model 名ではない)。 */
  advisor?: boolean;
  /** The skill allowlist (issue #56 / ADR 0025), threaded through wholesale
   *  like every other field: `skills` is a required frontmatter field, so a
   *  file the verb writes without it would fail the next `loadRegistry`. The
   *  WebUI's skill picker that fills this in is issue #54; the verb only has
   *  to carry the value through. */
  skills: string[];
  systemPrompt: string;
}

/** The input names an authority profile absent from the registry (issue #70,
 *  parent #54: the WebUI only offers picking an existing profile — a typo'd
 *  or stale name must not produce an agent no worker could ever spawn as).
 *  Defined in registry.js (issue #76): the same "no such profile" condition
 *  is also thrown by profile-create.ts's updateProfile, re-exported here so
 *  existing imports of this module keep working. */
export { UnknownAuthorityProfileError };

/** 組み込み agent に編集の扉は無い(ADR 0117 決定2): 定義は盤面の code にあり、
 *  registry のファイルではない。ここを通すと、編集フォームの保存が**静かに**
 *  同名の shadow エントリを書くことになる —— shadow は作成の扉が告げた上でだけ
 *  生まれる。削除側の `built_in` 理由と同じ拒否で、どちらも「無い」ではない。 */
export class BuiltInAgentNotEditableError extends Error {
  constructor(public readonly agentName: string) {
    super(`agent "${agentName}" is built-in and cannot be edited — create a same-named registry entry to shadow it`);
    this.name = "BuiltInAgentNotEditableError";
  }
}

/** The input's icon fails ADR 0026's structural check (a single
 *  Twemoji-covered emoji grapheme). Caught at the entrance, not left to the
 *  loader: a file written with an invalid icon would make every subsequent
 *  `loadRegistry` throw — one bad create must not brick the whole board. */
export class InvalidAgentIconError extends Error {
  constructor(public readonly icon: string) {
    super(`invalid agent icon "${icon}": must be a single Twemoji-covered emoji grapheme`);
    this.name = "InvalidAgentIconError";
  }
}

function assertValidIcon(icon: string | undefined): void {
  if (icon !== undefined && !isSingleTwemojiGrapheme(icon)) {
    throw new InvalidAgentIconError(icon);
  }
}

/** What every agent-admin verb needs: which registry clone to write
 *  `agents/<name>.md` into and commit — threaded in by the composition root,
 *  never read from env here (same shape as WorkspaceAdminDeps). */
export interface AgentAdminDeps {
  /** どの registry clone を検証・一覧・書き込みに使うか、そのクローンが remote
   *  正本を持つか(ADR 0052 決定1)の組 — 必ず一緒に運ばれるので1つの型にした
   *  (issue #210 レビュー — WorkspaceAdminDeps / ProfileAdminDeps /
   *  ClaudeWorkerOptions と共有する Data Clumps だった)。検証がこの `mode` に
   *  対して行われ、その直後に切る worktree も同じ ref から fork するので、
   *  両者が食い違うことはない。 */
  registry: RegistrySource;
  /** The board's GitHub identity (ADR 0024) for the registry push (ADR 0052
   *  決定1: 失敗は致命 — #210), absent when no secrets file is configured —
   *  same shape as WorkspaceAdminDeps. */
  githubAuth?: GitHubAuth;
}

/** ADR 0020's agent half: write `agents/<name>.md` to the registry — a
 *  WebUI-initiated registry change is the human's explicit act. */
export async function createAgent(input: CreateAgentInput, deps: AgentAdminDeps): Promise<void> {
  // 入口で fetch してから読む(ADR 0052 決定2/4): fetch できなければ push もでき
  // ず、その編集は最初から成立していない — workspace-create と同じ二段検査
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  assertValidAgentName(registry, input.name);
  assertKnownAuthority(registry, input.authority);
  assertValidIcon(input.icon);
  assertValidSkillAllowlist(input.skills);
  const definition = normalizedDefinition(input);
  assertValidAgentDefinition(input.name, definition);
  commitAgentFile(deps, { ...definition, retiredFields: [], version: "1" }, `create agent ${input.name} via WebUI`);
}

/** The edit half (issue #70): the same fields as creation — the form
 *  resubmits the whole definition and the file is rewritten wholesale
 *  (hand-written frontmatter comments are the accepted cost of an agent
 *  entering UI management; the systemPrompt body is kept verbatim). `name`
 *  picks the existing agent, and `version` stays machine-stamped: the last
 *  numeric segment of the stored version + 1. */
export type UpdateAgentInput = CreateAgentInput;

export async function updateAgent(input: UpdateAgentInput, deps: AgentAdminDeps): Promise<void> {
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const existing = ownEntry(registry.agents, input.name);
  if (!existing) throw new UnknownAgentError(input.name);
  if (existing.builtin) throw new BuiltInAgentNotEditableError(input.name);
  assertKnownAuthority(registry, input.authority);
  assertValidIcon(input.icon);
  assertValidSkillAllowlist(input.skills);
  // no-change 編集はコミットなしの成功(workspace-create.ts の porcelain
  // チェックと同じ狙い)— version はここで見ない: 刻印だけが動く「編集」は
  // 存在せず、実効フィールドが同じ再送で刻印だけ進めない
  // 検査するのは**提出された定義**だけで、保存されている側の退役フィールドは
  // 通行止めにしない(ADR 0110 決定1 が拒むのは「登録される値」であって、既に
  // git にある行ではない)。手で commit された旧い agent.md はこの門を通した
  // 編集で `retiredFields: []` として書き直され、盤面から直せる —— 塞ぐと、
  // pickup で quarantine される定義の唯一の修復経路が registry repo の手編集
  // だけになる。人間面の credential(ADR 0036)を通った編集であり、フォームは
  // 定義を丸ごと提出するので、黙って直したことにはならない。
  const definition = normalizedDefinition(input);
  assertValidAgentDefinition(input.name, definition);
  if (!sameEffectiveFields(existing, definition)) {
    commitAgentFile(
      deps,
      { ...definition, retiredFields: [], version: bumpVersion(existing.version) },
      `update agent ${input.name} via WebUI`,
    );
  }
}

/** フォームの入力を registry の正規形へ(ADR 0110 決定1)。フォームは単一
 *  provider + advisor チェックボックスのまま = 長さ1の entry で、綴りを畳むのは
 *  parse と共有する1本(`normalizeProviderEntries`)である。チェックボックスは
 *  書かれた entry にだけ畳む —— 省略の展開は常に advisor なし(ADR 0116 決定1/2)。 */
function normalizedDefinition(
  input: CreateAgentInput,
): Omit<AgentDefinition, "version" | "retiredFields"> {
  return {
    ...input,
    provider: normalizeProviderEntries(
      input.advisor === true ? [{ name: input.provider, advisor: true }] : input.provider,
      input.skills,
    ),
  };
}

/** version 以外の全フィールド(編集フォームが送るもの)の一致。systemPrompt
 *  は保存される正規形(trim 済み — serializeAgentFile 参照)で比較する。 */
function sameEffectiveFields(
  existing: AgentDefinition,
  input: Omit<AgentDefinition, "version" | "retiredFields">,
): boolean {
  return (
    existing.authority === input.authority &&
    existing.description === input.description &&
    sameProviderEntries(existing.provider, input.provider) &&
    existing.icon === input.icon &&
    existing.tier === input.tier &&
    sameSkills(existing.skills, input.skills) &&
    existing.systemPrompt === input.systemPrompt.trim()
  );
}

function sameProviderEntries(
  existing: readonly AgentProviderEntry[],
  input: readonly AgentProviderEntry[],
): boolean {
  return (
    existing.length === input.length &&
    existing.every(
      (entry, i) => entry.name === input[i]!.name && entry.advisor === input[i]!.advisor,
    )
  );
}

/** Order-sensitive list equality for the skill allowlist: the file is
 *  rewritten wholesale, so a reordering is a real edit worth a version bump
 *  (nothing downstream treats the allowlist as an unordered set). */
function sameSkills(existing: string[], input: string[]): boolean {
  return existing.length === input.length && existing.every((s, i) => s === input[i]);
}

/** tier の提案の承認が書く前に見た registry の tier が、提案の pin と違う(issue #920)。agent が消えた / 組み込みに戻った
 *  ときも同じ —— どれも「承認した前提がもう無い」で、回答の側は question を観測で決着させる。 */
export class AgentTierMismatchError extends Error {
  constructor(agentName: string, expected: string, actual: string | undefined) {
    super(`agent "${agentName}" no longer has tier ${expected} in the registry (it is ${actual ?? "unset or gone"})`);
    this.name = "AgentTierMismatchError";
  }
}

export interface ChangeAgentTierInput {
  name: string;
  /** 提案が pin した tier。書き込み前の fetch の後の registry がこの値でなければ書かない。 */
  expectTier: string;
  to: string;
  message: string;
}

/** tier の提案への approve の書き込み(issue #920 / ADR 0150 決定5): 入口で fetch し、tier が pin のままなら
 *  frontmatter の `tier:` と `version:` の行だけを書き換えて着地させる。フォームの編集と違いファイルを丸ごと書き直さない
 *  —— 手書きの行やコメントは提案の対象ではない。返り値は着地した commit。 */
export async function changeAgentTier(input: ChangeAgentTierInput, deps: AgentAdminDeps): Promise<string> {
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const existing = ownEntry(loadRegistry(deps.registry.dir, deps.registry.mode).agents, input.name);
  if (!existing || existing.builtin || existing.tier !== input.expectTier) {
    throw new AgentTierMismatchError(input.name, input.expectTier, existing?.tier);
  }
  return commitToRegistry(
    deps.registry,
    deps.githubAuth,
    (worktreeDir) => {
      const file = join(worktreeDir, "agents", `${input.name}.md`);
      const version = JSON.stringify(bumpVersion(existing.version));
      writeFileSync(
        file,
        readFileSync(file, "utf8").replace(/^---\n[\s\S]*?\n---\n/, (frontmatter) =>
          frontmatter.replace(/^tier:.*$/m, `tier: ${input.to}`).replace(/^version:.*$/m, `version: ${version}`),
        ),
      );
    },
    input.message,
  );
}

/** One agent as the settings surface's edit form needs it (issue #70):
 *  the full definition, systemPrompt included — the form resubmits every
 *  field, so the view must carry every field.
 *
 *  **フォームの形であって定義の形ではない**(ADR 0110 決定1): `provider` は
 *  単一の select、`advisor` はチェックボックスのままで、複数 entry の表示・編集は
 *  spec #541 の Out of Scope。複数 entry の agent(手書きの agent.md だけが持てる)
 *  は名前を並べて見せ、そのまま保存しようとすれば門が列挙違反として拒む ——
 *  黙って先頭 entry だけを残して書き戻すことはしない。 */
export interface AgentView extends Omit<AgentDefinition, "provider"> {
  provider: string;
  advisor: boolean;
  /** 同名の組み込みを shadow している registry エントリか(ADR 0117 決定2)。
   *  `builtin`(定義の側の印)との2つで、表示は機械の解決をそのまま映す ——
   *  **読み取り時に導出**され、保存されない。 */
  shadowsBuiltIn?: true;
}

export function listAgentViews(deps: AgentAdminDeps): AgentView[] {
  return Object.values(loadRegistry(deps.registry.dir, deps.registry.mode).agents).map(
    (definition) => ({
      ...definition,
      provider: definition.provider.map((entry) => entry.name).join(", "),
      advisor: definition.provider.every((entry) => entry.advisor),
      ...(definition.builtin !== true && isBuiltInAgentName(definition.name) && { shadowsBuiltIn: true as const }),
    }),
  );
}

/** ADR 0087 決定1 の agent 半分: `agents/<name>.md` を committed main から除去する。
 *  過去タスクが読む agent 本文は commit 指定(ADR 0020 / `agentBodyAtCommit`)なので、
 *  HEAD から消えても履歴参照は壊れない。 */
export interface DeleteAgentInput {
  name: string;
  /** 人間の明示同意(ADR 0087)。無いと門が拒む。 */
  confirm?: boolean;
}

/** 参照検査に要る**盤面側**の事実(ADR 0087 決定2/3)。registry からは読めない
 *  ので deps に同乗させる —— 束ねるのは API 層(db・既定 agent 名・Auditor 名を
 *  既に持つ唯一の場所)で、判定と執行はこの verb の中に1箇所だけ置く。 */
export interface AgentDeletionReferences {
  /** この agent を assignee に持つ未決着タスクの件数。 */
  unsettledTaskCount: number;
  /** 盤面の既定 agent 名(ADR 0012)。一致すれば消せない —— 既定はポインタなので、
   *  指し先を消せば assignee 未指定のタスクが全部止まる。 */
  defaultAgentName?: string;
  /** 盤面の Auditor 名(CONTEXT.md「Auditor」、既定 `fugu` — ADR 0089)。一致すれば
   *  消せない —— 「消せない資源」は列挙ではなく盤面のポインタが指す先という規則で、
   *  Auditor は既定 agent / 既定 workspace と同型の第3のポインタである
   *  (ADR 0087 決定3 訂正 / issue #376)。既定 agent と違い optional ではない ——
   *  Auditor ポインタは常に値を持ち「未設定」が無い(CONTEXT.md)ので、解決側と
   *  同じく必ず名前が入る。 */
  auditorName: string;
}

export async function deleteAgent(
  input: DeleteAgentInput,
  deps: AgentAdminDeps & AgentDeletionReferences,
): Promise<void> {
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const existing = ownEntry(registry.agents, input.name);
  if (!existing) throw new UnknownAgentError(input.name);
  // 組み込みは registry のエントリではないので、参照の検査に進まない(ADR 0117
  // 決定2): 「消せない」が答えのすべてであり、Auditor ポインタを他所へ向けても
  // 未決着タスクが decay しても、この理由は変わらない
  if (existing.builtin) {
    throw new DeletionBlockedError("agent", input.name, [{ code: "built_in" }]);
  }
  // 確認では買えない拒否が先(ADR 0061 根拠5 と同じ順序)。profile の
  // `assignable_to` に名前が並んでいるだけは参照ではない(ADR 0087 決定2)
  const reasons: DeletionBlockedReason[] = [];
  // 組み込みを shadow しているエントリだけは、ポインタの指す先でも参照されていても
  // 消せる —— CONTEXT.md「削除」が「消せない」と数え上げた全体に対する唯一の例外で
  // ある(ADR 0117 決定2。ADR 0117 が名指すのは ADR 0087 決定3 だが、緩むのは決定2 の
  // 未決着タスク検査も同じで、根拠も同じ「消えても壊れない」である): 消えれば名前は
  // 組み込みへ落ちるだけで、`assignee: fugu` も `review_by: ["fugu"]` も解決し続ける
  // —— ただし work タスクの授権は組み込みの reviewer profile へ**狭まる**(ADR 0013)。
  // `board_default` は緩めない —— 既定 agent は registry に残る(ADR 0117 決定3)。
  const shadowsBuiltIn = isBuiltInAgentName(input.name);
  if (deps.unsettledTaskCount > 0 && !shadowsBuiltIn) {
    reasons.push({ code: "unsettled_tasks", count: deps.unsettledTaskCount });
  }
  if (deps.defaultAgentName === input.name) reasons.push({ code: "board_default" });
  if (deps.auditorName === input.name && !shadowsBuiltIn) reasons.push({ code: "board_auditor" });
  if (reasons.length > 0) throw new DeletionBlockedError("agent", input.name, reasons);
  if (input.confirm !== true) throw new DeletionConfirmationRequiredError("agent", input.name);
  commitToRegistry(
    deps.registry,
    deps.githubAuth,
    (worktreeDir) => {
      unlinkSync(join(worktreeDir, "agents", `${input.name}.md`));
    },
    `delete agent ${input.name} via WebUI`,
  );
}

export type CreateAgentFn = (input: CreateAgentInput) => Promise<void>;
/** 削除だけが2引数なのは、参照検査の事実が registry ではなく**盤面**の側にある
 *  ためである(ADR 0087 決定2/3)。合成 root は registry 由来の deps を束ね、
 *  API 層が db・既定 agent 名・Auditor 名から `refs` を足す —— 判定はどちらでも
 *  なく verb の中で1回だけ起きる。 */
export type DeleteAgentFn = (
  input: DeleteAgentInput,
  refs: AgentDeletionReferences,
) => Promise<void>;
export type UpdateAgentFn = (input: UpdateAgentInput) => Promise<void>;

/** The settings surface's agent verbs as one bundle, WorkspaceAdmin's twin
 *  (issue #70): they exist together or not at all (a registry is configured,
 *  or none is), so the composition root binds them once. */
export interface AgentAdmin {
  create: CreateAgentFn;
  list: () => AgentView[];
  update: UpdateAgentFn;
  /** ADR 0087 / issue #205 の削除の扉(WebUI 専用 — ADR 0088)。 */
  delete: DeleteAgentFn;
  /** The authority select's candidates — the registry's existing profile
   *  names (issue #71) — a sibling of `list`, not a reshape of it: GET
   *  /api/agents bundles the two into one round trip at the route layer, but
   *  `list` itself keeps phase 1's shape (issue #70) since nothing about
   *  exposing it over HTTP requires changing what it returns. */
  authorityProfiles: () => string[];
  /** tier の提案への approve の書き込み(issue #920)。着地した commit を返す。 */
  changeTier: (input: ChangeAgentTierInput) => Promise<string>;
}

function assertKnownAuthority(registry: Registry, profileName: string): void {
  if (!Object.hasOwn(registry.authority, profileName)) {
    throw new UnknownAuthorityProfileError(profileName);
  }
}

/** The machine stamp's edit half (issue #70): "0.3.1" → "0.3.2", "3" → "4" —
 *  the last run of digits + 1, whatever surrounds it. A version with no
 *  digits at all (hand-authored drift) restarts at "1": the stamp must
 *  always advance, never return the same string. */
function bumpVersion(version: string): string {
  if (!/\d/.test(version)) return "1";
  return version.replace(/(\d+)(?=\D*$)/, (n) => String(Number(n) + 1));
}

/** `AgentDefinition` → the `agents/<name>.md` file format `parseAgentFile`
 *  (registry.ts) reads back: frontmatter carries every field but the name
 *  (that's the filename) and the body is the system prompt verbatim. Optional
 *  fields are omitted, not serialized as null — round-trip keeps them
 *  undefined. */
function serializeAgentFile(definition: AgentDefinition): string {
  const meta: Record<string, string | boolean | (string | AgentProviderEntry)[]> = {
    version: definition.version,
    authority: definition.authority,
    description: definition.description,
    // advisor なしの長さ1の entry は単一文字列の綴りで書き戻す(ADR 0110 決定1)。
    // advisor は entry にだけ書く(ADR 0116 決定2)
    provider:
      definition.provider.length === 1 && !definition.provider[0]!.advisor
        ? definition.provider[0]!.name
        : definition.provider.map((entry) =>
            entry.advisor ? { name: entry.name, advisor: true } : entry.name,
          ),
    // required (ADR 0025): always written, even the empty list — a file
    // without it fails the next loadRegistry
    skills: definition.skills,
  };
  if (definition.icon !== undefined) meta.icon = definition.icon;
  if (definition.tier !== undefined) meta.tier = definition.tier;
  // 外側の空白は trim して書く: parseAgentFile が body.trim() で読む以上、
  // 保存できるのは trim 済みの正規形だけ — 書き込み側も同じ正規形に揃える
  // ことでラウンドトリップと no-change 判定(sameEffectiveFields)が一致する
  return `---\n${stringifyYaml(meta)}---\n${definition.systemPrompt.trim()}\n`;
}

/** Writes `agents/<name>.md` inside a disposable worktree and lands it under
 *  the board's own identity (ADR 0020 / ADR 0052 決定6) — the workspace
 *  admin's commitWorkspaceEntry, for agents. Checkout-independent: the write
 *  itself never depends on the registry clone's own checkout — landing may
 *  additionally sync it back in line as a courtesy (registry-write.ts's
 *  `syncCheckoutIfOnBranch`), never as a requirement. */
function commitAgentFile(deps: AgentAdminDeps, definition: AgentDefinition, message: string): void {
  commitToRegistry(
    deps.registry,
    deps.githubAuth,
    (worktreeDir) => {
      const file = join("agents", `${definition.name}.md`);
      writeFileSync(join(worktreeDir, file), serializeAgentFile(definition));
    },
    message,
  );
}
