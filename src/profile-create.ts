import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { z } from "zod";
import type { GitHubAuth } from "./github-auth.js";
import {
  type AuthorityProfile,
  assertValidAuthorityProfileName,
  authorityProfileSchema,
  loadRegistry,
  ownEntry,
  type RegistryMode,
  UnknownAuthorityProfileError,
} from "./registry.js";
import {
  assertRegistryCloneReady,
  pushRegistry,
  type RegistryCommitResult,
} from "./registry-write.js";
import { AUTHORITY_WILDCARD } from "./tasks.js";
import { git, TIDEPOOL_GIT_IDENTITY } from "./workspace.js";

/** The WebUI's profile-creation verb (issue #76, #55 phase 1): the schema's
 *  four fields, reused straight from `authorityProfileSchema` (registry.ts)
 *  so the two never drift — `name` picks the file, never written into it
 *  (same as parseAuthorityFile). Unlike agents, profiles carry no
 *  machine-stamped version. */
export type CreateProfileInput = z.infer<typeof authorityProfileSchema> & { name: string };

/** Machine-readable reason codes `dangerousValues` can return — stable
 *  strings a downstream consumer (phase 2's API contract) matches on rather
 *  than parsing prose. */
export type DangerousValueReason =
  | "merge_auto_if_ci_green"
  | "assignable_to_wildcard"
  | "allowed_workspaces_wildcard";

/** Pure judgment of whether a profile's values grant broad power (issue #76):
 *  `merge: auto_if_ci_green` (unattended merge) and either list carrying the
 *  wildcard (unrestricted delegation/workspace access). This layer only
 *  reports — it never blocks a write; enforcing confirmation on a dangerous
 *  profile is phase 2's API contract. */
export function dangerousValues(
  input: Pick<CreateProfileInput, "assignable_to" | "allowed_workspaces" | "merge">,
): DangerousValueReason[] {
  const reasons: DangerousValueReason[] = [];
  if (input.merge === "auto_if_ci_green") reasons.push("merge_auto_if_ci_green");
  if (input.assignable_to.includes(AUTHORITY_WILDCARD)) reasons.push("assignable_to_wildcard");
  if (input.allowed_workspaces.includes(AUTHORITY_WILDCARD)) {
    reasons.push("allowed_workspaces_wildcard");
  }
  return reasons;
}

/** What every profile-admin verb needs: which registry clone to write
 *  `authority/<name>.yaml` into and commit — threaded in by the composition
 *  root, same shape as AgentAdminDeps. */
export interface ProfileAdminDeps {
  registryDir: string;
  /** ADR 0052 決定1: 検証と一覧が読む正本。読みだけがリモートへ移り、書き込みは
   *  まだローカル main へコミットする(#210)。 */
  registryMode: RegistryMode;
  /** The board's GitHub identity (ADR 0024) for the best-effort registry
   *  push, absent when no secrets file is configured — same shape as
   *  AgentAdminDeps. */
  githubAuth?: GitHubAuth;
}

/** ADR 0020's profile half: write `authority/<name>.yaml` to the registry
 *  clone and commit it to local main directly — a WebUI-initiated registry
 *  change is the human's explicit act. */
export async function createProfile(
  input: CreateProfileInput,
  deps: ProfileAdminDeps,
): Promise<RegistryCommitResult> {
  // 入口で検査してから読む: dirty tree の registry を検証の根拠にしない
  // (ADR 0020 の committed-main 読み取り規律 — agent-create.ts と同じ二段検査)
  assertRegistryCloneReady(deps.registryDir);
  const registry = loadRegistry(deps.registryDir, deps.registryMode);
  assertValidAuthorityProfileName(registry, input.name);
  commitProfileFile(deps.registryDir, input, `create authority profile ${input.name} via WebUI`);
  return { pushed: pushRegistry(deps.registryDir, deps.githubAuth) };
}

/** The edit half (issue #76): the form resubmits the whole profile and the
 *  file is rewritten wholesale (hand-written YAML comments are the accepted
 *  cost of a profile entering UI management — same tradeoff as
 *  updateAgent). `name` picks the existing profile; unlike agents, profiles
 *  carry no version to bump. */
export type UpdateProfileInput = CreateProfileInput;

export async function updateProfile(
  input: UpdateProfileInput,
  deps: ProfileAdminDeps,
): Promise<RegistryCommitResult> {
  assertRegistryCloneReady(deps.registryDir);
  const registry = loadRegistry(deps.registryDir, deps.registryMode);
  const existing = ownEntry(registry.authority, input.name);
  if (!existing) throw new UnknownAuthorityProfileError(input.name);
  // no-change 編集はコミットなしの成功(updateAgent の sameEffectiveFields と
  // 同じ狙い)— 配列フィールドは中身の一致で比較する(参照比較は常に不一致)
  if (!sameEffectiveFields(existing, input)) {
    commitProfileFile(deps.registryDir, input, `update authority profile ${input.name} via WebUI`);
  }
  return { pushed: pushRegistry(deps.registryDir, deps.githubAuth) };
}

/** One authority profile as the settings surface's edit form needs it
 *  (issue #76): the full profile, `listAgentViews`'s twin. */
export type ProfileView = AuthorityProfile;

export function listProfileViews(deps: ProfileAdminDeps): ProfileView[] {
  return Object.values(loadRegistry(deps.registryDir, deps.registryMode).authority);
}

export type CreateProfileFn = (input: CreateProfileInput) => Promise<RegistryCommitResult>;
export type UpdateProfileFn = (input: UpdateProfileInput) => Promise<RegistryCommitResult>;

/** The settings surface's profile verbs as one bundle, AgentAdmin's twin
 *  (issue #76): they exist together or not at all, so the composition root
 *  binds them once. No analogue to AgentAdmin.authorityProfiles() — profiles
 *  have no further "candidates" list of their own. */
export interface ProfileAdmin {
  create: CreateProfileFn;
  list: () => ProfileView[];
  update: UpdateProfileFn;
}

function sameStringArray(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** 全フィールド(編集フォームが送るもの)の一致。`name` は比較しない —
 *  updateProfile はそもそも既存名の profile を編集するので常に一致する。 */
function sameEffectiveFields(existing: AuthorityProfile, input: UpdateProfileInput): boolean {
  return (
    existing.guidance === input.guidance &&
    sameStringArray(existing.assignable_to ?? [], input.assignable_to) &&
    sameStringArray(existing.allowed_workspaces ?? [], input.allowed_workspaces) &&
    existing.merge === input.merge
  );
}

/** `AuthorityProfile` → `authority/<name>.yaml` の中身(name は書かない —
 *  ファイル名由来)。parseAuthorityFile が同じフィールドを読み戻す。merge は
 *  省略時キー自体を出さない — ラウンドトリップで undefined のまま。 */
function serializeProfileFile(profile: AuthorityProfile): string {
  const meta: Record<string, unknown> = {
    guidance: profile.guidance,
    assignable_to: profile.assignable_to,
    allowed_workspaces: profile.allowed_workspaces,
  };
  if (profile.merge !== undefined) meta.merge = profile.merge;
  return stringifyYaml(meta);
}

/** Writes `authority/<name>.yaml` and commits it under the board's own
 *  identity (ADR 0020) — the profile-admin's commitAgentFile. */
function commitProfileFile(registryDir: string, profile: AuthorityProfile, message: string): void {
  const file = join("authority", `${profile.name}.yaml`);
  writeFileSync(join(registryDir, file), serializeProfileFile(profile));
  git(registryDir, "add", file);
  git(registryDir, ...TIDEPOOL_GIT_IDENTITY, "commit", "-m", message);
}
