import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { UnknownAgentError } from "./agent.js";
import type { GitHubAuth } from "./github-auth.js";
import {
  type AgentDefinition,
  assertValidAgentName,
  assertValidSkillAllowlist,
  isSingleTwemojiGrapheme,
  loadRegistry,
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
  icon?: string;
  model?: string;
  effort?: string;
  advisor?: string;
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
  commitAgentFile(
    deps,
    { ...input, advisor: normalizeAdvisor(input.advisor), version: "1" },
    `create agent ${input.name} via WebUI`,
  );
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
  assertKnownAuthority(registry, input.authority);
  assertValidIcon(input.icon);
  assertValidSkillAllowlist(input.skills);
  // no-change 編集はコミットなしの成功(workspace-create.ts の porcelain
  // チェックと同じ狙い)— version はここで見ない: 刻印だけが動く「編集」は
  // 存在せず、実効フィールドが同じ再送で刻印だけ進めない
  const normalizedInput = { ...input, advisor: normalizeAdvisor(input.advisor) };
  if (!sameEffectiveFields(existing, normalizedInput)) {
    commitAgentFile(
      deps,
      { ...normalizedInput, version: bumpVersion(existing.version) },
      `update agent ${input.name} via WebUI`,
    );
  }
}

/** An empty advisor means the capability is absent, not a blank model name. */
function normalizeAdvisor(advisor: string | undefined): string | undefined {
  return advisor?.trim() || undefined;
}

/** version 以外の全フィールド(編集フォームが送るもの)の一致。systemPrompt
 *  は保存される正規形(trim 済み — serializeAgentFile 参照)で比較する。 */
function sameEffectiveFields(existing: AgentDefinition, input: UpdateAgentInput): boolean {
  return (
    existing.authority === input.authority &&
    existing.description === input.description &&
    existing.icon === input.icon &&
    existing.model === input.model &&
    existing.effort === input.effort &&
    existing.advisor === input.advisor &&
    sameSkills(existing.skills, input.skills) &&
    existing.systemPrompt === input.systemPrompt.trim()
  );
}

/** Order-sensitive list equality for the skill allowlist: the file is
 *  rewritten wholesale, so a reordering is a real edit worth a version bump
 *  (nothing downstream treats the allowlist as an unordered set). */
function sameSkills(existing: string[], input: string[]): boolean {
  return existing.length === input.length && existing.every((s, i) => s === input[i]);
}

/** One agent as the settings surface's edit form needs it (issue #70):
 *  the full definition, systemPrompt included — the form resubmits every
 *  field, so the view must carry every field. */
export type AgentView = AgentDefinition;

export function listAgentViews(deps: AgentAdminDeps): AgentView[] {
  return Object.values(loadRegistry(deps.registry.dir, deps.registry.mode).agents);
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
 *  ので deps に同乗させる —— 束ねるのは API 層(db と既定 agent 名を既に持つ
 *  唯一の場所)で、判定と執行はこの verb の中に1箇所だけ置く。 */
export interface AgentDeletionReferences {
  /** この agent を assignee に持つ未決着タスクの件数。 */
  unsettledTaskCount: number;
  /** 盤面の既定 agent 名(ADR 0012)。一致すれば消せない —— 既定はポインタなので、
   *  指し先を消せば assignee 未指定のタスクが全部止まる。 */
  defaultAgentName?: string;
}

export async function deleteAgent(
  input: DeleteAgentInput,
  deps: AgentAdminDeps & AgentDeletionReferences,
): Promise<void> {
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  if (!ownEntry(registry.agents, input.name)) throw new UnknownAgentError(input.name);
  // 確認では買えない拒否が先(ADR 0061 根拠5 と同じ順序)。profile の
  // `assignable_to` に名前が並んでいるだけは参照ではない(ADR 0087 決定2)
  const reasons: DeletionBlockedReason[] = [];
  if (deps.unsettledTaskCount > 0) {
    reasons.push({ code: "unsettled_tasks", count: deps.unsettledTaskCount });
  }
  if (deps.defaultAgentName === input.name) reasons.push({ code: "board_default" });
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
 *  API 層が db と既定 agent 名から `refs` を足す —— 判定はどちらでもなく verb の
 *  中で1回だけ起きる。 */
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
  const meta: Record<string, string | string[]> = {
    version: definition.version,
    authority: definition.authority,
    description: definition.description,
    // required (ADR 0025): always written, even the empty list — a file
    // without it fails the next loadRegistry
    skills: definition.skills,
  };
  if (definition.icon !== undefined) meta.icon = definition.icon;
  if (definition.model !== undefined) meta.model = definition.model;
  if (definition.effort !== undefined) meta.effort = definition.effort;
  if (definition.advisor !== undefined) meta.advisor = definition.advisor;
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
