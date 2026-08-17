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
  type RegistrySource,
  UnknownAuthorityProfileError,
} from "./registry.js";
import { commitToRegistry, refreshRegistryForWrite } from "./registry-write.js";
import { AUTHORITY_WILDCARD } from "./tasks.js";

/** The WebUI's profile-creation verb (issue #76, #55 phase 1): the schema's
 *  four fields, reused straight from `authorityProfileSchema` (registry.ts)
 *  so the two never drift — `name` picks the file, never written into it
 *  (same as parseAuthorityFile). Unlike agents, profiles carry no
 *  machine-stamped version. */
export type CreateProfileInput = z.infer<typeof authorityProfileSchema> & {
  name: string;
  /** 危険な値への人間の明示同意(ADR 0061 決定1)— workspace の `confirm` と
   *  同じく入力に同乗する。profile の4フィールドではないので、ファイルには
   *  書かれない(serializeProfileFile は4キーしか読まない)。 */
  confirmDangerous?: boolean;
};

/** Machine-readable reason codes `dangerousValues` can return — stable
 *  strings a downstream consumer (phase 2's API contract) matches on rather
 *  than parsing prose. */
export type DangerousValueReason =
  | "merge_auto_if_ci_green"
  | "assignable_to_wildcard"
  | "allowed_workspaces_wildcard";

/** Pure judgment of whether a profile's values grant broad power (issue #76):
 *  `merge: auto_if_ci_green` (unattended merge) and either list carrying the
 *  wildcard (unrestricted delegation/workspace access). The enumeration counts
 *  values that widen the board's **unattended** outward effect — which is why
 *  `merge: external` is deliberately absent (ADR 0079 決定5). This layer only
 *  reports — `assertConfirmed` below is what turns a verdict into a refusal.
 *  Every field is optional because an absent one was not written by the human,
 *  so it never enters the judgment (issue #266 / ADR 0086) — create passes all
 *  three and is unchanged. */
export function dangerousValues(
  input: Partial<Pick<CreateProfileInput, "assignable_to" | "allowed_workspaces" | "merge">>,
): DangerousValueReason[] {
  const reasons: DangerousValueReason[] = [];
  if (input.merge === "auto_if_ci_green") reasons.push("merge_auto_if_ci_green");
  if (input.assignable_to?.includes(AUTHORITY_WILDCARD)) reasons.push("assignable_to_wildcard");
  if (input.allowed_workspaces?.includes(AUTHORITY_WILDCARD)) {
    reasons.push("allowed_workspaces_wildcard");
  }
  return reasons;
}

/** 危険な値を載せたペイロードが `confirmDangerous` なしで届いた(ADR 0061 決定1
 *  が workspace で採った形を profile へ:執行はドメイン側に1つだけ置き、API は
 *  409 `confirm_required` に、管理MCP は registryToolError に写す)。理由コードは
 *  構造化フィールドと本文の両方で運ぶ — MCP 側は本文しか読めない。 */
export class ProfileConfirmationRequiredError extends Error {
  constructor(
    name: string,
    public readonly reasons: DangerousValueReason[],
  ) {
    super(
      `authority profile "${name}" contains dangerous values (${reasons.join(", ")}); human confirmation is required`,
    );
    this.name = "ProfileConfirmationRequiredError";
  }
}

/** 危険な値の門。判定は**ペイロードだけ**を見る(ADR 0061 決定2)ので、編集では
 *  マージ前のパッチを渡す — 触っていない値は現れず、確認は人間が実際に危険な値を
 *  書いた瞬間にだけ出る。 */
function assertConfirmed(input: UpdateProfileInput): void {
  const reasons = dangerousValues(input);
  if (reasons.length > 0 && input.confirmDangerous !== true) {
    throw new ProfileConfirmationRequiredError(input.name, reasons);
  }
}

/** What every profile-admin verb needs: which registry clone to write
 *  `authority/<name>.yaml` into and commit — threaded in by the composition
 *  root, same shape as AgentAdminDeps. */
export interface ProfileAdminDeps {
  /** どの registry clone を検証・一覧・書き込みに使うか、そのクローンが remote
   *  正本を持つか(ADR 0052 決定1)の組 — 必ず一緒に運ばれるので1つの型にした
   *  (issue #210 レビュー — AgentAdminDeps と共有する Data Clumps だった)。 */
  registry: RegistrySource;
  /** The board's GitHub identity (ADR 0024) for the registry push (ADR 0052
   *  決定1: 失敗は致命 — #210), absent when no secrets file is configured —
   *  same shape as AgentAdminDeps. */
  githubAuth?: GitHubAuth;
}

/** ADR 0020's profile half: write `authority/<name>.yaml` to the registry —
 *  a WebUI-initiated registry change is the human's explicit act. */
export async function createProfile(input: CreateProfileInput, deps: ProfileAdminDeps): Promise<void> {
  // 入口で fetch してから読む(ADR 0052 決定2/4) — agent-create.ts と同じ二段検査
  refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  assertValidAuthorityProfileName(registry, input.name);
  // 名前の綴りは confirm では買えないので、確認より前に弾く(ADR 0061 根拠5)
  assertConfirmed(input);
  commitProfileFile(deps, input, `create authority profile ${input.name} via WebUI`);
}

/** The edit half (issue #76, partial since issue #266 / ADR 0086): a patch
 *  over the existing profile. `name` picks it; every other field is optional
 *  and **absent means untouched** — that is what keeps the pure-payload
 *  danger judgment from asking about a value the human never wrote. An empty
 *  value is a value (`guidance: ""` saves the empty string, `[]` means "to
 *  nobody" / "nowhere"). The file is still rewritten wholesale from the merged
 *  profile with all four keys (hand-written YAML comments are the accepted
 *  cost of a profile entering UI management — same tradeoff as updateAgent).
 *  Unlike agents, profiles carry no version to bump. */
export type UpdateProfileInput = Partial<CreateProfileInput> & { name: string };

export async function updateProfile(input: UpdateProfileInput, deps: ProfileAdminDeps): Promise<void> {
  refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const existing = ownEntry(registry.authority, input.name);
  if (!existing) throw new UnknownAuthorityProfileError(input.name);
  // 存在しない名前が confirm より先に出る理由は create 側の名前検査と同じ —
  // 確認で買えないものは確認より前に弾く(ADR 0061 根拠5)
  assertConfirmed(input);
  const merged = mergePatch(existing, input);
  // no-change 編集はコミットなしの成功(updateAgent の sameEffectiveFields と
  // 同じ狙い)— 空パッチもここに着地する。配列フィールドは中身の一致で比較する
  // (参照比較は常に不一致)
  if (!sameEffectiveFields(existing, merged)) {
    commitProfileFile(deps, merged, `update authority profile ${input.name} via WebUI`);
  }
}

/** パッチを既存エントリに重ねて、4フィールド揃った profile にする(ADR 0086
 *  決定1)。既存側の `??` は registry.ts の TS optional を埋めるだけで、schema を
 *  通ったエントリでは発火しない — 万一のときは人間に聞く `escalate` 側へ落ちる。 */
function mergePatch(existing: AuthorityProfile, patch: UpdateProfileInput): CreateProfileInput {
  return {
    name: patch.name,
    guidance: patch.guidance ?? existing.guidance,
    assignable_to: patch.assignable_to ?? existing.assignable_to ?? [],
    allowed_workspaces: patch.allowed_workspaces ?? existing.allowed_workspaces ?? [],
    merge: patch.merge ?? existing.merge ?? "escalate",
  };
}

/** One authority profile as the settings surface's edit form needs it
 *  (issue #76): the full profile, `listAgentViews`'s twin. */
export type ProfileView = AuthorityProfile;

export function listProfileViews(deps: ProfileAdminDeps): ProfileView[] {
  return Object.values(loadRegistry(deps.registry.dir, deps.registry.mode).authority);
}

export type CreateProfileFn = (input: CreateProfileInput) => Promise<void>;
export type UpdateProfileFn = (input: UpdateProfileInput) => Promise<void>;

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

/** 既存エントリと、パッチをマージした後の完全な profile の一致。`name` は
 *  比較しない — updateProfile はそもそも既存名の profile を編集する。 */
function sameEffectiveFields(existing: AuthorityProfile, input: CreateProfileInput): boolean {
  return (
    existing.guidance === input.guidance &&
    sameStringArray(existing.assignable_to ?? [], input.assignable_to) &&
    sameStringArray(existing.allowed_workspaces ?? [], input.allowed_workspaces) &&
    existing.merge === input.merge
  );
}

/** `AuthorityProfile` → `authority/<name>.yaml` の中身(name は書かない —
 *  ファイル名由来)。parseAuthorityFile が同じフィールドを読み戻す。machine が
 *  読む3フィールドはどれも常に書かれる — merge も含め省略の口は無い(ADR 0079
 *  決定1: 省略 = 意味を持つ、という footgun を作らない)。 */
function serializeProfileFile(profile: CreateProfileInput): string {
  return stringifyYaml({
    guidance: profile.guidance,
    assignable_to: profile.assignable_to,
    allowed_workspaces: profile.allowed_workspaces,
    merge: profile.merge,
  });
}

/** Writes `authority/<name>.yaml` inside a disposable worktree and lands it
 *  under the board's own identity (ADR 0020 / ADR 0052 決定6) — the
 *  profile-admin's commitAgentFile. */
function commitProfileFile(deps: ProfileAdminDeps, profile: CreateProfileInput, message: string): void {
  commitToRegistry(
    deps.registry,
    deps.githubAuth,
    (worktreeDir) => {
      const file = join("authority", `${profile.name}.yaml`);
      writeFileSync(join(worktreeDir, file), serializeProfileFile(profile));
    },
    message,
  );
}
