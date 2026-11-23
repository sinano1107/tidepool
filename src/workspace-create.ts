import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { HUMAN_ACTOR_ID } from "./actor-id.js";
import { BoardStateOverlapError, type BoardStatePath, boardStateOverlap } from "./board-state.js";
import { type Clock, SystemClock } from "./clock.js";
import type { Db } from "./db.js";
import type { EventOrigin } from "./events.js";
import { GhVersionError } from "./gh-cli-version.js";
import { git, readCheckoutRemote } from "./git.js";
import { forkPrCredentialRefusal, type GitHubClient, type RepoSlug } from "./github.js";
import {
  authedClone,
  authedPush,
  GIT_NETWORK_TIMEOUT_MS,
  type GitHubAuth,
  githubKey,
  HEAD_REPO_REMOTE,
  isRelativeLocalPath,
  networkDestination,
  originValue,
  remoteTrackingRef,
  repoKey,
} from "./github-auth.js";
import {
  assertOwnGitDirectory,
  conventionCheckoutPath,
  exactProtectedBranchRef,
  originUrl,
  protectedBranch,
} from "./pickup-predicates.js";
import { openQuarantineQuestion, openQuarantineQuestions, parseWorkspaceContainmentValue, type QuarantineKind } from "./quarantine.js";
import {
  assertValidAllowedDomains,
  assertValidReviewAllowedCommands,
  assertValidWorkspaceName,
  loadRegistry,
  ownEntry,
  type RegistrySource,
  type WorkspaceEntry,
} from "./registry.js";
import {
  commitToRegistry,
  DeletionBlockedError,
  type DeletionBlockedReason,
  DeletionConfirmationRequiredError,
  refreshRegistryForWrite,
} from "./registry-write.js";
import { parseGitHubRepo, RepoAccessMissingError, repairRepoAccess, repositoryLabel, sameRepository } from "./repo-access.js";
import { recordedSettingsDisposition } from "./sandbox.js";
import { settleQuestionAsObserved } from "./tasks.js";
import type { LiveCheckoutSignal } from "./wire-contract.js";
import { BOARD_BRANCHES } from "./workbench.js";
import {
  announceHeadRepo,
  announcePublishedRepo,
  assertRememberedHeadRepo,
  assertRememberedRepo,
  dropWorkspaceState,
  entryCheckoutPath,
  holdsBaseline,
  holdsWorkspaceState,
  humanContentWorkbenchLeft,
  leftoverStateExit,
  openHumanContentWorkbench,
  openIntakeQuestionId,
  refValues,
  removeHumanContentWorkbench,
  resolveExecutionWorkspace,
  UnknownWorkspaceError,
  type WorkspaceConfig,
  type WorkspaceRegistryProtection,
  type WorkspacesBaseDirSource,
  workspaceDeletionMessage,
  workspaceProtectionReader,
  writeBoardRefs,
} from "./workspace.js";

/** The WebUI's workspace-creation verbs (issue #57): three entrances, one
 *  resulting Workspace — the mode is a circumstance of creation, not a kind
 *  (GLOSSARY.md's Workspace). Human-only; agents keep going through
 *  registry-edit tasks instead (2026-07-14 grilling). */
export type CreateWorkspaceInput = {
  name: string;
  notes?: string;
  /** Setting protection at creation needs no confirmation step — adding it
   *  only ever moves in the safe direction (issue #57; removal is the edit
   *  flow's confirmed action). */
  protected?: boolean;
} & (
  | {
      mode: "register";
      /** The existing checkout on this host — the one mode that records an
       *  explicit, host-specific path (ADR 0018 keeps board-created entries
       *  convention-derived instead). */
      path: string;
      /** この checkout が「人間の生きた dev checkout」に見えたとき(issue #383)の
       *  同意。`createWorkspace` に危険な値(ADR 0061 決定1)の門は今日1つも無いので、
       *  このフラグが意味するのはこの信号族**だけ**である。ADR 0088 の族ではない —
       *  この信号はエージェントの権限を1ミリも広げず、守っているのは人間の作業ツリー
       *  のほうである。 */
      confirm?: boolean;
    }
  | {
      mode: "clone";
      /** What `git clone` accepts — recorded on the entry as provenance. */
      repo: string;
    }
  | {
      /** The name doubles as the new GitHub repository's name — the shared
       *  charset assertValidWorkspaceName enforces is safe for both. */
      mode: "create";
    }
);

/** What every workspace-admin verb needs: which registry clone to commit to,
 *  and the base directory path-omitting entries derive from (ADR 0018) —
 *  both threaded in by the composition root, never read from env here. */
export interface WorkspaceAdminDeps {
  /** どの registry clone を検証・一覧・書き込みに使うか、そのクローンが remote
   *  正本を持つか(ADR 0052 決定1)の組 — 必ず一緒に運ばれるので1つの型にした
   *  (issue #210 レビュー — AgentAdminDeps / ProfileAdminDeps と共有する
   *  Data Clumps だった)。 */
  registry: RegistrySource;
  workspacesBaseDir: string;
  /** ADR 0040 / issue #149: the board's own state paths (fixed for the whole
   *  process), threaded in by the composition root. The creation gate refuses
   *  a workspace that would intersect one of them. Absent → nothing to protect
   *  (a caller outside main.ts, e.g. a test); the pickup-side floor
   *  (the named-place pickup predicate, ADR 0377 決定4) still catches whatever gets registered anyway —
   *  including the registry-edit PR path, which never passes this gate. */
  boardState?: BoardStatePath[];
  /** The board's GitHub identity (ADR 0024) for the registry push (ADR 0052
   *  決定1: 失敗は致命 — #210) and clone/repository calls, absent when no
   *  secrets file is configured — clones then run anonymously under the same
   *  floor (ADR 0339 決定2), the same fail-closed posture as the optional
   *  `github` client below. */
  githubAuth?: GitHubAuth;
}

/** 共通の dep に、**GitHub へ出ていく workspace 動詞**が要るものを1つ足した組:
 *  `clone`(ADR 0067 決定2 の登録の門)と `publish`(決定8)がこれを共有する。 */
export interface WorkspaceGitHubDeps extends WorkspaceAdminDeps {
  /** Absent(盤面が GitHub 身元を持たない、ADR 0024)→ ADR 0067 の到達性 probe は
   *  撃たれず、clone は匿名で撃ち(ADR 0339 決定2)、publish は push が落ちる
   *  だけになる。`create` は GitHub に一切出ないので、そもそもこれを読まない
   *  (ADR 0066 決定1)。 */
  github?: GitHubClient;
}

/** publish の dep: push が写しを動かすので、走っている session の基準へ写しを予告する盤面の db を足す(ADR 0243 /
 *  ADR 0066 決定4)。 */
export interface PublishWorkspaceDeps extends WorkspaceGitHubDeps {
  db: Db;
  clock?: Clock;
}

/** 返すのは着地した checkout のパス(ADR 0082 決定1)。MCP の `create_workspace`
 *  は1回の呼び出しで登録まで進むので、「見せてから決める」形が無い —— 決めた後に
 *  どこへ落ちたかを返すことがその代わりである。 */
export type CreateWorkspaceFn = (input: CreateWorkspaceInput) => Promise<string>;
export type UpdateWorkspaceFn = (input: UpdateWorkspaceInput) => Promise<void>;
/** 返すのは送った範囲と次の手順の文(issue #3563)。 */
export type PublishWorkspaceFn = (input: PublishWorkspaceInput) => Promise<string>;
/** 返すのは**残る** checkout の場所(ADR 0087 決定4): 消えるのは registry エントリ
 *  だけなので、応答はホスト上に残った checkout を名指しする。参照検査の事実を
 *  第2引数で受ける形は `DeleteAgentFn` と同じ。 */
export type DeleteWorkspaceFn = (
  input: DeleteWorkspaceInput,
  refs: WorkspaceDeletionReferences,
) => Promise<string>;

/** The settings surface's workspace verbs as one bundle (issue #57): they
 *  exist together or not at all (a registry is configured, or none is), so
 *  the composition root binds them once and the layers in between thread one
 *  dep, not three. */
export interface WorkspaceAdmin {
  create: CreateWorkspaceFn;
  list: () => WorkspaceListView;
  update: UpdateWorkspaceFn;
  /** ADR 0066 決定2/8: purely-local → remote-backed の遷移を与える4つ目の動詞。 */
  publish: PublishWorkspaceFn;
  /** ADR 0087 / issue #205 の削除の扉(WebUI 専用 — ADR 0088)。 */
  delete: DeleteWorkspaceFn;
  /** ADR 0371 決定6: purely-local の保護ブランチへ人間の commit を取り込む作業台を開く(`open_workbench`)。返すのは text A14。 */
  openWorkbench: OpenWorkbenchFn;
}

type OpenWorkbenchFn = (input: { name: string }, origin: EventOrigin) => Promise<string>;

/** `open_workbench` の扉(ADR 0371 決定6): registry に登録された workspace の名前だけを受ける —— 面接室も登録されていないので通らない
 *  (spec #3273 group A、#3184)。判定と執行は `openHumanContentWorkbench` が持ち、呼んだ人間が question の登録者になる。 */
export async function openWorkspaceWorkbench(input: { name: string }, origin: EventOrigin, deps: WorkspaceAdminDeps & { db: Db; clock?: Clock }): Promise<string> {
  // ADR 0373 決定13 の確認は名前を引くたびに registry を読み直す —— pickup の口と同じ
  const resolveRegistered = (name: string | null) =>
    resolveExecutionWorkspace(loadRegistry(deps.registry.dir, deps.registry.mode), input.name, name, deps.workspacesBaseDir);
  return openHumanContentWorkbench(deps.db, resolveRegistered(input.name), deps.workspacesBaseDir, { actorId: HUMAN_ACTOR_ID, origin }, () => (deps.clock ?? new SystemClock()).now(), {
    resolveRegistered,
    fixedPoints: deps.boardState,
  });
}

/** publish の2つ目の拒否(ADR 0066 決定5 / issue #285): 盤面が GitHub 身元
 *  (ADR 0024)を持たないので push できない。要求するのは `github` クライアントでは
 *  なく `githubAuth` である —— publish が GitHub に出るのは git の push 1本だけで、
 *  API は ADR 0067 の probe(あれば撃つ)にしか使わない。
 *
 *  ADR 0066 決定1 以降、create モードはこのエラーを投げない(GitHub に一切出ない)。 */
export class GitHubIdentityMissingError extends Error {
  constructor() {
    super("publish needs the board's GitHub identity (TIDEPOOL_GITHUB_TOKEN_FILE) to push");
    this.name = "GitHubIdentityMissingError";
  }
}

export { BoardStateOverlapError } from "./board-state.js";

/** Where this creation's checkout will actually live — the one path the gate
 *  judges. `register` records an explicit host path; `clone` and `create` both
 *  land at the convention-derived location (ADR 0018), which does not exist
 *  yet at gate time (boardStateOverlap resolves the deepest existing ancestor
 *  and joins the rest lexically — ADR 0040). */
function intendedCheckoutPath(input: CreateWorkspaceInput, deps: WorkspaceAdminDeps): string {
  return input.mode === "register"
    ? input.path
    : conventionCheckoutPath(input.name, deps.workspacesBaseDir);
}

/** Orchestrates one workspace creation: external effects first, the registry
 *  commit strictly last (issue #57) — a mid-way failure leaves only orphans
 *  the registry never knew about, never a half-registered entry. */
export async function createWorkspace(input: CreateWorkspaceInput, deps: WorkspaceGitHubDeps & { db: Db }): Promise<string> {
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  assertValidWorkspaceName(registry, input.name);
  // ADR 0401 決定5: 削除の途中で残った行の上に登録すると、次の pickup がその行を新しい checkout の基準として比べる
  if (holdsWorkspaceState(deps.db, input.name)) throw new LeftoverWorkspaceStateError(input.name, leftoverStateExit(input.name, deps.registry));
  const path = intendedCheckoutPath(input, deps);
  // ADR 0040: before any external effect — a refused registration must not
  // leave a clone or a GitHub repository behind.
  if (deps.boardState) {
    const overlap = boardStateOverlap(path, deps.boardState);
    if (overlap) throw new BoardStateOverlapError(overlap.reason);
  }
  const cloned = input.mode === "clone" && !existsSync(path);
  const entry = await buildEntry(input, deps);
  if (entry.branch !== undefined && (entry.branch === BOARD_BRANCHES || entry.branch.startsWith(`${BOARD_BRANCHES}/`))) {
    // この呼び出しが作った clone は消す —— 残すと次の登録が孤児として流用し、同じ理由で拒まれ続けて名前が塞がる
    if (cloned) rmSync(path, { recursive: true, force: true });
    throw new BoardNamedProtectedBranchError(input.name, entry.branch);
  }
  // issue #383: 「人間の生きた dev checkout」の信号は `rev-parse` の**後**(git
  // リポジトリでないパスは NotAGitRepositoryError が勝つ)、registry コミットの
  // **前**。`entry.repo` は registerExistingCheckout が既に済ませた origin の観測
  // なので、clone 入口の提案はそれを読み直さずに合成できる。
  if (input.mode === "register" && input.confirm !== true) {
    const reasons = liveCheckoutSignals(input.path);
    const landing =
      reasons.length === 0 || entry.repo === undefined ? null : conventionCheckoutPath(input.name, deps.workspacesBaseDir);
    const settingsWarning = unhideableSettingsWarning({ ...entry, name: input.name, path: input.path });
    if (settingsWarning) reasons.push("claude_settings_unhideable");
    if (reasons.length > 0) {
      // 提案が登録しようとしている当のパスを指すなら提案ではない —— 人間が既に
      // 規約どおりの場所にある checkout を register で拾っている場合に起きる
      throw new LiveCheckoutSignalsError(
        input.path,
        reasons,
        landing !== null && resolve(landing) !== resolve(input.path) ? landing : null,
        settingsWarning,
      );
    }
  }
  if (input.notes !== undefined) entry.notes = input.notes;
  if (input.protected) entry.protected = true;
  commitWorkspaceEntry(deps, input.name, entry, `add workspace ${input.name} via WebUI`);
  return path;
}

/** ADR 0401 決定5: registry に無い名前に盤面の行が残っている —— 削除が途中で止まった。 */
export class LeftoverWorkspaceStateError extends Error {
  constructor(name: string, exit: string) {
    super(`workspace "${name}" cannot be registered: the board still holds state from an earlier workspace with that name. ${exit}.`);
    this.name = "LeftoverWorkspaceStateError";
  }
}

/** spec #3273(ADR 0371 決定7): 作業台で盤面が引き直す `refs/heads/board/*` と重なる保護ブランチ —— `board` か `board/` の下。 */
export class BoardNamedProtectedBranchError extends Error {
  constructor(name: string, branch: string) {
    super(`workspace "${name}" would have the protected branch '${branch}', but a protected branch cannot be named board or start with board/: the board keeps its own refs there in a workbench`);
    this.name = "BoardNamedProtectedBranchError";
  }
}

/** A partial patch to workspace Settings, `head_repo` included (ADR 0395 決定2). `path`, `repo` and `branch` are registry edits. */
export interface UpdateWorkspaceInput {
  name: string;
  /** Provided → set; empty string → remove the field. */
  notes?: string;
  protected?: boolean;
  /** ADR 0035's review write-floor lift, editable from the human doors since
   *  ADR 0061 (the create door deliberately stays out of it — 決定3). Provided
   *  → set; the empty array removes the key, absence being the canonical "no
   *  commands", the same shape as `protected` below. */
  review_allowed_commands?: string[];
  /** ADR 0072's workspace-scoped network egress lift. Empty removes it. */
  allowed_domains?: string[];
  /** ADR 0395 決定2: the PR head repo as `owner/name`. Provided → checked and set (a dangerous value); empty string → removed. */
  head_repo?: string;
  /** ADR 0395 決定4: additional paths that require a human merge. Empty removes the declaration. */
  human_merge_paths?: string[];
  /** Declaration the Settings edit was based on. Kept through the confirmation retry. */
  expected_human_merge_paths?: string[];
  /** Consent to every dangerous value in this payload, not to unprotecting
   *  alone (ADR 0061 決定1) — one boolean, the refusal's reason codes say
   *  what it bought. */
  confirm?: boolean;
}

/** Machine-readable reason codes `dangerousWorkspaceValues` can return — the
 *  workspace twin of profile-create's `DangerousValueReason`, stable strings
 *  a door's refusal enumerates rather than prose (ADR 0061 決定1). */
export type DangerousWorkspaceValueReason =
  | "unprotect"
  | "review_allowed_commands_set"
  | "allowed_domains_set"
  | "human_merge_paths_removed"
  | "head_repo_set";

/** ADR 0061 決定2: omitted fields are untouched. ADR 0395 決定4: removing
 *  any declared human merge path widens what can land unattended. */
function dangerousWorkspaceValues(
  input: UpdateWorkspaceInput,
  declaredMergePaths: readonly string[],
): DangerousWorkspaceValueReason[] {
  const reasons: DangerousWorkspaceValueReason[] = [];
  if (input.protected === false) reasons.push("unprotect");
  if (input.review_allowed_commands?.length) reasons.push("review_allowed_commands_set");
  if (input.allowed_domains?.length) reasons.push("allowed_domains_set");
  if (input.human_merge_paths !== undefined) {
    const nextPaths = new Set(input.human_merge_paths);
    if (declaredMergePaths.some((path) => !nextPaths.has(path))) reasons.push("human_merge_paths_removed");
  }
  // ADR 0395 決定2: replacing the head repo goes through the gate; removing it moves to the closed side
  if (input.head_repo) reasons.push("head_repo_set");
  return reasons;
}

/** ADR 0395 決定2: a head repo value the door refuses — no confirmation buys it. */
export class HeadRepoRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeadRepoRejectedError";
  }
}

/** The head repo's parent, read from GitHub with the head repo's own token (#3558). Unreadable → refused. */
async function readHeadRepoParent(value: string, github: GitHubClient | undefined): Promise<{ head: RepoSlug; parent: RepoSlug | null }> {
  const head = parseGitHubRepo(value);
  if (!head) throw new HeadRepoRejectedError(`head repo ${repositoryLabel(value)} must be a GitHub repository written as owner/name.`);
  const label = githubKey(head);
  const unreadable = (why: string) =>
    new HeadRepoRejectedError(`the parent of head repo ${label} could not be read from GitHub, so it is refused (${why}). Install the App on its owner and try again.`);
  if (!github) throw unreadable("the board has no GitHub identity");
  try {
    return { head, parent: await github.repositoryParent(head) };
  } catch (err) {
    // ADR 0402 決定3: 版の不一致は App の不足ではない —— 名指して拒む
    if (err instanceof GhVersionError) throw new HeadRepoRejectedError(err.message);
    throw unreadable(err instanceof Error ? err.message : String(err));
  }
}

/** ADR 0395 決定2: head repo ≠ the declared `repo`, ≠ the registry's repo, and its parent = the declared `repo`. */
function assertHeadRepoFits(name: string, entry: WorkspaceEntry, { head, parent }: { head: RepoSlug; parent: RepoSlug | null }, registryDir: string, path: string): void {
  const label = githubKey(head);
  if (entry.repo === undefined) throw new HeadRepoRejectedError(`workspace "${name}" declares no repo, so it cannot have a head repo; publish it first.`);
  if (sameRepository(label, entry.repo)) throw new HeadRepoRejectedError(`head repo ${label} is workspace "${name}"'s own repo; it must be a fork of it.`);
  const registry = workspaceProtectionReader(registryDir)({ repo: label }, path);
  if (registry?.reason === "registry_repository") {
    throw new HeadRepoRejectedError(`head repo ${label} is the registry's repository; it must be a fork of workspace "${name}"'s repo.`);
  }
  if (registry?.reason === "unreadable_registry_origin") {
    throw new HeadRepoRejectedError(`the origin of the registry clone cannot be read, so head repo ${label} cannot be told apart from the registry's repository; repair the registry checkout first.`);
  }
  const parentLabel = parent && githubKey(parent);
  if (parentLabel === null || !sameRepository(parentLabel, entry.repo)) {
    throw new HeadRepoRejectedError(`head repo ${label} is not a fork of ${repositoryLabel(entry.repo)}: GitHub reports its parent as ${parentLabel ?? "none (it is no fork)"}.`);
  }
}

/** Points the checkout's head repo remote at `url`, or removes it. Not `git remote remove`: ADR 0066 決定5 の Status 追記(#3197) ——
 *  it also drops remote-tracking refs and `branch.*.remote`. */
function pointHeadRemote(path: string, url: string | undefined): void {
  const present = readCheckoutRemote(path, "first", HEAD_REPO_REMOTE) !== undefined;
  if (url === undefined) {
    if (present) git(path, "config", "--remove-section", `remote.${HEAD_REPO_REMOTE}`);
  } else {
    git(path, "remote", present ? "set-url" : "add", HEAD_REPO_REMOTE, url);
  }
}

/** ADR 0395 決定2 with ADR 0391 決定1〜3's order: announce `[before, next]`, then the remote and the registry commit with no await in
 *  between; the check folds the row once the declaration and the remote agree. A death midway leaves a row the check folds by itself
 *  (before the registry commit: back, once the remote is put back as its mismatch text says; after it: forward). */
function writeHeadRepo(db: Db, workspace: WorkspaceConfig, next: string | undefined, now: () => Date, commit: () => void): void {
  const { name, path } = workspace;
  // setting does not pass over a head repo edited outside the door (ADR 0373 決定13 の線); removal moves to the closed side and is
  // the exit the check's texts name, so it is not gated (#3560)
  if (next !== undefined) assertRememberedHeadRepo(db, workspace, now());
  const before = readCheckoutRemote(path, "first", HEAD_REPO_REMOTE) ?? undefined;
  announceHeadRepo(db, workspace, next);
  try {
    pointHeadRemote(path, next === undefined ? undefined : networkDestination(next, path).url);
    commit();
  } catch (err) {
    const failures: unknown[] = [];
    for (const step of [() => pointHeadRemote(path, before), () => assertRememberedHeadRepo(db, workspace, now())]) {
      try {
        step();
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 0) {
      const text = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));
      throw new Error(`setting the head repo of workspace ${name} failed: ${text(err)}; rolling it back failed: ${failures.map(text).join("; ")}`, { cause: err });
    }
    throw err;
  }
  assertRememberedHeadRepo(db, { ...workspace, head_repo: next }, now());
}

/** A payload carrying dangerous values arrived without `confirm` (issue #57,
 *  generalized by ADR 0061 決定1 from "removing protection" to "every
 *  dangerous value in this payload"). Enforcement lives here in the domain,
 *  once: the API maps this to a 409 with `dangerous_values`, the management
 *  MCP to a tool error — and both bodies enumerate the reason codes, so the
 *  message carries them too rather than only the structured field. */
export class WorkspaceConfirmationRequiredError extends Error {
  constructor(
    name: string,
    public readonly reasons: DangerousWorkspaceValueReason[],
  ) {
    super(
      `workspace "${name}" edit contains dangerous values (${reasons.join(", ")}); resubmit with confirm: true`,
    );
    this.name = "WorkspaceConfirmationRequiredError";
  }
}

export class WorkspaceMergePathsChangedError extends Error {
  constructor(name: string) {
    super(`workspace "${name}" human merge paths changed. Reload Settings and review your edit.`);
  }
}

function assertMergePathsUnchanged(name: string, expected: readonly string[], declared: unknown): void {
  if (!Array.isArray(declared) || declared.length !== expected.length || declared.some((path, index) => path !== expected[index])) {
    throw new WorkspaceMergePathsChangedError(name);
  }
}

/** ADR 0381 決定1・4: protection computed from the declaration applies permanently, or waits for a registry clone repair. */
export class WorkspaceRegistryUnprotectError extends Error {
  constructor(name: string, protection: WorkspaceRegistryProtection) {
    let message: string;
    switch (protection.reason) {
      case "registry_repository":
        message = `workspace "${name}" shares the registry's repository (${repositoryLabel(protection.repo)}), so it is always protected; this cannot be bought with a confirmation.`;
        break;
      case "unreadable_registry_origin":
        message = `the origin of the registry clone cannot be read, so workspace "${name}" is treated as protected; repair the registry checkout first.`;
        break;
    }
    super(message);
    this.name = "WorkspaceRegistryUnprotectError";
  }
}

/** The update door's deps: the board db remembers the head repo, and `github` reads its parent (ADR 0395 決定2). */
export interface UpdateWorkspaceDeps extends WorkspaceAdminDeps {
  db: Db;
  github?: GitHubClient;
  clock?: Clock;
}

export async function updateWorkspace(input: UpdateWorkspaceInput, deps: UpdateWorkspaceDeps): Promise<void> {
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  // the one GitHub read comes before the registry read, so nothing awaits between that read and the commit (ADR 0066 決定5 の線)
  const head = input.head_repo ? await readHeadRepoParent(input.head_repo, deps.github) : undefined;
  // ADR 0395 決定6 / #3564: the task-branch send is a push to the head repo like landing's, so it asks the same refusal. Read here,
  // before the registry read, on the parent: assertHeadRepoFits refuses a parent other than the declared repo. `path` is gh's cwd only
  const withheld = head?.parent && deps.github
    ? await forkPrCredentialRefusal(deps.github, { name: input.name, path: deps.registry.dir, repo: githubKey(head.parent) }, githubKey(head.head))
    : null;
  // ADR 0093: the head repo's token for the task branch push (sendTaskBranches) is warmed here too, before the registry read
  if (head) await deps.githubAuth?.ensureToken(githubKey(head.head));
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const entry = ownEntry(registry.workspaces, input.name);
  if (!entry) throw new UnknownWorkspaceError(input.name);
  // ADR 0395 決定4: a confirmation covers only the paths in the declaration the human reviewed.
  const expected = input.human_merge_paths === undefined ? undefined : input.expected_human_merge_paths;
  const declared = entry.human_merge_paths ?? [];
  if (expected !== undefined) assertMergePathsUnchanged(input.name, expected, declared);
  if (input.protected === false) {
    const path = entryCheckoutPath(entry, input.name, deps.workspacesBaseDir);
    const protection = workspaceProtectionReader(deps.registry.dir)(entry, path);
    if (protection && protection.reason !== "flag") {
      throw new WorkspaceRegistryUnprotectError(input.name, protection);
    }
  }
  // grammar before confirmation, for the same reason as the protection floor: a
  // malformed prefix is not something a confirm can buy, and the value the
  // human read must be the one the CLI receives (ADR 0061 根拠5)
  if (input.review_allowed_commands !== undefined) {
    assertValidReviewAllowedCommands(input.review_allowed_commands);
  }
  if (input.allowed_domains !== undefined) {
    assertValidAllowedDomains(input.allowed_domains);
  }
  const path = entryCheckoutPath(entry, input.name, deps.workspacesBaseDir);
  if (head) assertHeadRepoFits(input.name, entry, head, deps.registry.dir, path);
  const dangerous = dangerousWorkspaceValues(input, declared);
  if (dangerous.length > 0 && input.confirm !== true) {
    throw new WorkspaceConfirmationRequiredError(input.name, dangerous);
  }
  const next: WorkspaceEntry = { ...entry };
  if (input.notes !== undefined) {
    if (input.notes === "") delete next.notes;
    else next.notes = input.notes;
  }
  if (input.protected !== undefined) {
    // absence is the canonical "not protected" — mirrors creation, which
    // never writes `protected: false`
    if (input.protected) next.protected = true;
    else delete next.protected;
  }
  if (input.review_allowed_commands !== undefined) {
    if (input.review_allowed_commands.length === 0) delete next.review_allowed_commands;
    else next.review_allowed_commands = input.review_allowed_commands;
  }
  if (input.allowed_domains !== undefined) {
    if (input.allowed_domains.length === 0) delete next.allowed_domains;
    else next.allowed_domains = input.allowed_domains;
  }
  if (input.human_merge_paths !== undefined) {
    if (input.human_merge_paths.length === 0) delete next.human_merge_paths;
    else next.human_merge_paths = input.human_merge_paths;
  }
  const commit = () => commitWorkspaceEntry(deps, input.name, next, `update workspace ${input.name} via WebUI`, expected);
  if (input.head_repo === undefined) {
    commit();
    return;
  }
  // the parsed `owner/name`, never the spelling sent: a URL may carry credentials into the registry and the list views
  if (head) next.head_repo = githubKey(head.head);
  else delete next.head_repo;
  const now = () => (deps.clock ?? new SystemClock()).now();
  const workspace = { name: input.name, path, repo: entry.repo, head_repo: entry.head_repo };
  writeHeadRepo(deps.db, workspace, next.head_repo, now, commit);
  if (next.head_repo === undefined) return;
  if (withheld) throw new HeadRepoTaskBranchesNotSentError(input.name, next.head_repo, `no task branch was sent to it: ${withheld}`);
  sendTaskBranches(deps.db, { ...workspace, head_repo: next.head_repo }, next.head_repo, deps.githubAuth);
}

/** 出元 repo へ送れなかったタスクブランチ。issue #3563: 宣言は残っていて、同じ値をもう一度通せば送り直す —— API は 502 に `saved` を付ける。 */
export class HeadRepoTaskBranchesNotSentError extends Error {
  constructor(name: string, headRepo: string, detail: string) {
    super(`The head repo ${headRepo} of workspace ${name} was saved, but ${detail} Set the same head repo again to send them.`);
    this.name = "HeadRepoTaskBranchesNotSentError";
  }
}

/** ADR 0395 決定3: 出元 repo が宣言されたとき `task/*` を出元 repo へ送る。1本ずつ送る —— 分岐したタスクブランチが1本あっても、
 *  他のタスクブランチの送り直しを毎回塞がないよう atomic にしない。写しは送れたタスクブランチの `refs/remotes/head-repo/task/*` だけで、
 *  巻き戻しは出元 repo の写しを読む(ADR 0376 決定3)。issue #3563: 失敗しても宣言は残る。同じ sha が既に
 *  あるタスクブランチは up-to-date で通るので、同じ値をもう一度通す撃ち直しは冪等。 */
function sendTaskBranches(db: Db, workspace: WorkspaceConfig, headRepo: string, auth: GitHubAuth | undefined): void {
  const branches = [...refValues(git(workspace.path, "for-each-ref", "--format=%(objectname) %(refname:lstrip=2)", "refs/heads/task/"))];
  const writes = branches.map(([branch, sha]) => [remoteTrackingRef(branch, HEAD_REPO_REMOTE), sha] as const);
  const failures: string[] = [];
  writeBoardRefs(db, workspace, writes, () => {
    // shortcut: N synchronous pushes — an unreachable fork holds the board for up to N stall bounds (ADR 0334), upgrade if task branches pile up
    for (const [branch, sha] of branches) {
      try {
        authedPush(auth, workspace, GIT_NETWORK_TIMEOUT_MS, [[branch, sha]], HEAD_REPO_REMOTE);
      } catch (err) {
        failures.push(`${branch} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  });
  if (failures.length > 0) throw new HeadRepoTaskBranchesNotSentError(workspace.name, headRepo, `these task branches were not sent to it: ${failures.join("; ")}.`);
}

/** ADR 0087 決定1/4 の workspace 半分: registry エントリだけを committed main から
 *  除去する。ホスト上の checkout(決着後も残るタスクブランチ = 差分の恒久記録を
 *  含む)と GitHub 側のリポジトリは触らない —— 返すのは残る checkout の場所である。 */
export interface DeleteWorkspaceInput {
  name: string;
  /** 人間の明示同意(ADR 0087)。無いと門が拒む。 */
  confirm?: boolean;
}

/** 参照検査に要る**盤面側**の事実(ADR 0087 決定2/3)。agent 側の
 *  `AgentDeletionReferences` の双子で、束ねるのは API 層である。 */
export interface WorkspaceDeletionReferences {
  /** この workspace を持つ未決着タスクの件数。 */
  unsettledTaskCount: number;
  /** この workspace で着地を待つ完了タスクの id(ADR 0226)。 */
  awaitingLandingTaskIds: string[];
  /** 盤面の既定 workspace 名。一致すれば消せない —— 既定はポインタである。 */
  defaultWorkspaceName?: string;
}

export async function deleteWorkspace(
  input: DeleteWorkspaceInput,
  deps: WorkspaceAdminDeps & WorkspaceDeletionReferences & { db: Db; clock?: Clock },
): Promise<string> {
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const entry = ownEntry(registry.workspaces, input.name);
  if (!entry) throw new UnknownWorkspaceError(input.name);
  const reasons: DeletionBlockedReason[] = [];
  if (deps.unsettledTaskCount > 0) {
    const intake = openIntakeQuestionId(deps.db, input.name);
    reasons.push({ code: "unsettled_tasks", count: deps.unsettledTaskCount, ...(intake !== undefined && { intake_question: intake }) });
  }
  const awaiting = deps.awaitingLandingTaskIds;
  if (awaiting.length > 0) reasons.push({ code: "tasks_awaiting_landing", count: awaiting.length, task_ids: awaiting });
  if (deps.defaultWorkspaceName === input.name) reasons.push({ code: "board_default" });
  // ADR 0373 決定14: 見つかっている違反を 削除 → 再登録 → `repaired by hand` で比べずに通さない —— 基準の行を持つ間だけ拒む
  const [openQuarantine] = openQuarantinesNaming(deps.db, input.name);
  if (openQuarantine && holdsBaseline(deps.db, input.name)) reasons.push({ code: "open_quarantine", question_id: openQuarantine.id });
  // checkout の場所はエントリを消す前に読む —— 消した後の registry からは
  // `path` も規約パスの根拠も引けない
  const named = resolveExecutionWorkspace(registry, input.name, input.name, deps.workspacesBaseDir);
  const checkout = named.path;
  const workbenchLeft = humanContentWorkbenchLeft(named, deps.workspacesBaseDir);
  if (workbenchLeft !== undefined) reasons.push({ code: "human_content_workbench", ...workbenchLeft });
  if (reasons.length > 0) throw new DeletionBlockedError("workspace", input.name, reasons);
  if (input.confirm !== true) throw new DeletionConfirmationRequiredError("workspace", input.name);
  commitToRegistry(
    deps.registry,
    deps.githubAuth,
    (worktreeDir) => {
      const file = join(worktreeDir, "workspaces.yaml");
      const doc = parseDocument(readFileSync(file, "utf8"));
      doc.delete(input.name);
      writeFileSync(file, doc.toString());
    },
    workspaceDeletionMessage(input.name),
  );
  // 行の無い名前の削除は、開いていた Quarantine を観測で閉じて event に残す(ADR 0373 決定14)。閉じるものは行を消すのと同じ transaction で
  // 読み直す —— 拒否の検査の後に立ったもの(この名前の B9 など)も残さない
  deps.db.transaction(() => {
    dropWorkspaceState(deps.db, input.name);
    const now = (deps.clock ?? new SystemClock()).now();
    for (const { id, kind, value } of openQuarantinesNaming(deps.db, input.name)) {
      settleQuestionAsObserved(deps.db, id, { kind: "quarantine_released", quarantine: kind, value }, now);
    }
  })();
  removeHumanContentWorkbench(named, deps.workspacesBaseDir);
  return checkout;
}

/** その名前を名指す開いた Quarantine(workspace と封じ込めの組)。 */
function openQuarantinesNaming(db: Db, name: string): Array<{ id: string; kind: Extract<QuarantineKind, "workspace" | "workspaceContainment">; value: string }> {
  const workspace = openQuarantineQuestion(db, "workspace", name);
  const containment = [...openQuarantineQuestions(db, "workspaceContainment")]
    .filter(([value]) => parseWorkspaceContainmentValue(value!).workspace === name)
    .map(([value, id]) => ({ id, kind: "workspaceContainment" as const, value: value! }));
  return [...(workspace ? [{ id: workspace.id, kind: "workspace" as const, value: name }] : []), ...containment];
}

/** ADR 0066 決定2 の入力: publish するのはどの workspace か、宛先の repo URL はどこか。
 *  宛先は**毎回人間が打つ値**であり、盤面は所有者も綴りも検証しない —— 打ち間違いは
 *  人間の入力の範疇で、権限が無ければ push が落ちるだけである。 */
export interface PublishWorkspaceInput {
  name: string;
  repo: string;
}

/** publish の1つ目の拒否(ADR 0066 決定5): エントリが既に `repo` を持つ。この拒否が
 *  リトライの意味も確定させる —— 成功した publish の再送は「もう remote 正本がある」
 *  であって、宛先の差し替えではない(それは registry の手編集)。 */
export class WorkspaceAlreadyPublishedError extends Error {
  constructor(name: string, repo: string) {
    super(`workspace "${name}" already declares a remote source of truth (repo: ${repo})`);
    this.name = "WorkspaceAlreadyPublishedError";
  }
}

/** publish の3つ目の拒否(ADR 0066 決定5): エントリは `repo` を持たないのに
 *  checkout には `origin` が在る。それは帯域外の手作業が作った ADR 0052 のずれ状態で
 *  あり、pickup でどのみち quarantine に落ちる —— publish が上書きして辻褄を合わせる
 *  形は採らない。**巻き戻しの線もここで引かれる**: 自分が `remote add` した場合しか
 *  `remote.origin` の節を外さないので、publish が足していない remote は決して消えない。
 *  節の中身が `remote add` の書いたキーだけなのもこの拒否による —— 前からあったキーは
 *  `remote get-url` を通してここで拒まれる(#3197)。 */
export class CheckoutHasOriginError extends Error {
  constructor(name: string, origin: string, path: string) {
    // ADR 0373 決定16 / spec #3273 text A12(H12 → F4): ref を動かさない直し方を言う
    super(
      `workspace "${name}" declares no remote source of truth but its checkout already has an 'origin' (${origin}). In ${path}, run \`git config --remove-section remote.origin\`.`,
    );
    this.name = "CheckoutHasOriginError";
  }
}

/** publish の4つ目の拒否: 送る保護ブランチが checkout に無い。 */
export class ProtectedBranchMissingError extends Error {
  constructor(name: string, branch: string, path: string) {
    super(`workspace "${name}" cannot be published: its protected branch ${branch} does not exist in its checkout (${path}). Create ${branch} there, then publish again.`);
    this.name = "ProtectedBranchMissingError";
  }
}

/** ADR 0066 決定2 の扉: purely-local な workspace に remote 正本を与える。
 *  `git remote add origin` → 盤面が組んだ URL へ `git push <sha>:<保護ブランチ>` → 写しの `update-ref` → registry エントリへ `repo`。
 *  `task/*` は送らない —— 出元 repo の宣言が出元 repo へ送る(ADR 0395 決定3 の段2)。返すのは送った範囲と次の手順の文。
 *  checkout は動かさない(ADR 0064 の「走っているセッションの作業ツリーを奪わない」)。 */
export async function publishWorkspace(input: PublishWorkspaceInput, deps: PublishWorkspaceDeps): Promise<string> {
  await refreshRegistryForWrite(deps.registry, deps.githubAuth);
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const entry = ownEntry(registry.workspaces, input.name);
  if (!entry) throw new UnknownWorkspaceError(input.name);
  const { name } = input;
  const now = () => (deps.clock ?? new SystemClock()).now();
  const path = entryCheckoutPath(entry, name, deps.workspacesBaseDir);
  assertRememberedRepo(deps.db, { name, path, repo: entry.repo }, now());
  if (entry.repo !== undefined) throw new WorkspaceAlreadyPublishedError(input.name, entry.repo);
  if (!deps.githubAuth) throw new GitHubIdentityMissingError();
  const existing = originUrl(path);
  if (existing !== undefined) throw new CheckoutHasOriginError(input.name, existing, path);
  // ADR 0067 決定8: ADR 0066 決定5 が名指しした最頻の人為ミス「repo は作ったが App を
  // install し忘れた」を、push が落ちる**前に**名指しする。位置は `remote add` の手前で
  // なければならない —— 拒んだとき、巻き戻す痕跡がそもそも作られない側に立つ。
  await assertRepoAccess(input.repo, deps.github);
  // ADR 0093: token の**取得**(ネットワーク)は同期区間の手前で済ませる。以降の
  // `authedPush` は温まったキャッシュから同期に注入するだけなので、下の「await は
  // 1つも無い」が保てる。宛先はまだ origin として存在しないので URL から導く。
  await deps.githubAuth.ensureToken(repoKey(input.repo));
  // ── ここから下に `await` は1つも無い(ADR 0066 決定5)。`authedPush` も
  // `commitToRegistry` も `execFileSync` なので、await を挟まなければ publish 全体が
  // イベントループに対して不可分になり、pickup が中間状態(clone に remote があるのに
  // 宣言が無い = ADR 0052 の quarantine 事由)を観測できない ──
  // probe の往復の間に人間面から同じエントリの編集(notes など)が landed していたら、
  // 上で読んだ写しは既に古い —— そのまま書くと相手の編集を黙って巻き戻す。publish の
  // 対象は**既に登録済み**の workspace なので、`createWorkspace` の「途中失敗が残すのは
  // registry が知らない孤児だけ」という根拠はここでは引き継げない(ADR 0066 決定5)。
  const fresh = ownEntry(loadRegistry(deps.registry.dir, deps.registry.mode).workspaces, input.name);
  if (!fresh) throw new UnknownWorkspaceError(input.name);
  const dir = entryCheckoutPath(fresh, name, deps.workspacesBaseDir);
  assertRememberedRepo(deps.db, { name, path: dir, repo: fresh.repo }, now());
  if (fresh.repo !== undefined) throw new WorkspaceAlreadyPublishedError(input.name, fresh.repo);
  if (dir !== path) throw new Error(`workspace ${name}'s checkout path changed during publish; try again`);
  const declaration = { name, path: dir, repo: input.repo };
  // ADR 0395 決定3: 送るのは保護ブランチだけ —— `task/*` は出元 repo の宣言が出元 repo へ送る。**push の直前に**読んだ値を
  // `<sha>:<ref>` でそのまま押し、その写しを口に予告する(ADR 0243 / ADR 0066 決定4): tip を読み直す push だと、押した写しが予告と食い違う。
  // 無ければ `remote add` の手前で落ちる —— refspec の無い push を撃たない
  const branch = protectedBranch({ ...declaration, branch: fresh.branch });
  let sha: string;
  try {
    sha = git(dir, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    throw new ProtectedBranchMissingError(name, branch, dir);
  }
  const branches = [[branch, sha] as const];
  const writes = branches.map(([branch, sha]) => [remoteTrackingRef(branch), sha] as const);
  // ADR 0066 決定5 の Status 追記(#3197): 巻き戻しの戻す先は、書く前に checkout にあった写しの値。基準の行は使わない —— 落ちて
  // 残った行は次の比較まで残り(ADR 0351 決定4)、次の予告はその上に重なる(ADR 0373 決定3・5)ので、行からは戻す先が1つに決まらない
  const readCopies = () => refValues(git(dir, "for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes/origin/"));
  const priorCopies = readCopies();
  const { githubAuth } = deps;
  // 巻き戻しも口の内側に置く —— 畳みは写しを戻した後の ref を読み返して2択で畳む(ADR 0243 決定2)
  const publish = () => {
    git(dir, "remote", "add", "origin", input.repo);
    try {
      // タグはドメイン上の意味を持たないので送らない(ADR 0066 決定6)。
      // 写しは push の成功を見て authedPush が書く(ADR 0052 Status 追記、#2827)—— 巻き戻しはこれを書く前の値へ戻す(ADR 0066 決定5 の Status 追記、#3197)
      authedPush(githubAuth, declaration, GIT_NETWORK_TIMEOUT_MS, branches);
      commitWorkspaceEntry(
        deps,
        input.name,
        { ...fresh, repo: input.repo },
        `publish workspace ${input.name} via WebUI`,
      );
    } catch (err) {
      // 巻き戻すのは**自分が足したものだけ**(上の CheckoutHasOriginError が
      // その線を引いている)。最も起きる人為ミスは「repo は作ったが App を install し
      // 忘れた」で、経路は remote add(成功)→ push(失敗)→ registry コミット未実行。
      // registry コミットが落ちた場合もここへ来る: 宣言の無い workspace に origin が
      // 残るほうが ADR 0052 のずれそのものであり、再送は同一 ref の push なので
      // up-to-date で通る。
      // ADR 0066 決定5 の Status 追記(#3197): `remote remove` は publish の前からあった写し・origin/HEAD・`branch.*.remote` も
      // 消すので、`remote add` が書いた節を外し、写しを書く前の値へ戻す。手順は1つが落ちても残りを撃つ
      const failures: unknown[] = [];
      const attempt = (step: () => unknown) => {
        try {
          step();
        } catch (failure) {
          failures.push(failure);
        }
      };
      attempt(() => git(dir, "config", "--remove-section", "remote.origin"));
      let copies: ReadonlyMap<string, string> | undefined;
      attempt(() => {
        copies = readCopies();
      });
      for (const [ref] of writes) {
        const prior = priorCopies.get(ref);
        // 前の値のままの写しには撃たない —— 無い名前の `update-ref -d` も、残った写しとの D/F の衝突では落ちる
        if (copies !== undefined && copies.get(ref) === prior) continue;
        attempt(() => (prior === undefined ? git(dir, "update-ref", "-d", ref) : git(dir, "update-ref", ref, prior)));
      }
      // ADR 0391 決定3: the remembered repo folds by the check's own rule —— back to the value before the announcement only once origin is gone
      attempt(() => assertRememberedRepo(deps.db, { name, path: dir, repo: fresh.repo }, now()));
      if (failures.length > 0) {
        const text = (failure: unknown) => (failure instanceof Error ? failure.message : String(failure));
        throw new Error(`publish of workspace ${input.name} failed: ${text(err)}; rolling it back failed: ${failures.map(text).join("; ")}`, { cause: err });
      }
      throw err;
    }
    // ADR 0066 決定5: outside the rollback —— rolling back after the registry commit would leave a declared `repo:` with no origin, the drift itself
    assertRememberedRepo(deps.db, declaration, now());
  };
  writeBoardRefs(deps.db, { name: input.name, path: dir }, writes, publish, () => announcePublishedRepo(deps.db, declaration));
  const label = repositoryLabel(input.repo);
  return `Published workspace ${name}: sent its protected branch ${branch} to origin (${label}); task branches were not sent. ` +
    `Next, fork ${label} and set the fork as this workspace's head repo in the workspace settings; that sends the task branches to the fork.`;
}

/** Each mode's external half, ordered so the registry commit stays last. */
async function buildEntry(
  input: CreateWorkspaceInput,
  deps: WorkspaceGitHubDeps,
): Promise<WorkspaceEntry> {
  if (input.mode === "register") return registerExistingCheckout(input.path);
  if (input.mode === "clone") {
    await assertRepoAccess(input.repo, deps.github);
    await deps.githubAuth?.ensureToken(repoKey(input.repo));
    return cloneAndDescribe(input.name, input.repo, deps);
  }
  return createLocalCheckout(input.name, deps);
}

/** ADR 0087 決定5: 規約パスに既にある checkout が、この作成の要求と整合しない。
 *  流用は「前回失敗の孤児」を済んだ手順として引き継ぐためのものであって、中身を
 *  見ない流用は削除済み workspace の残骸を同名の別 repo として静かに採用する。
 *  拒否は場所を名指しする —— 人間は register モードで拾うか、帯域外で片付ける。 */
export class OrphanCheckoutMismatchError extends Error {
  constructor(path: string, reason: string) {
    super(
      `${path} already holds a checkout that does not match this creation (${reason}) — register it with the register mode, or move it aside by hand`,
    );
    this.name = "OrphanCheckoutMismatchError";
  }
}

/** 非 GitHub の clone 入力が相対 path(ADR 0339 決定5: clone は盤面所有の HOME から撃つので、相対 path は別の場所に解ける)。 */
export class RelativeClonePathError extends Error {
  constructor(repo: string) {
    super(`clone source ${repo} is a relative path — give the local repository as an absolute path`);
    this.name = "RelativeClonePathError";
  }
}

/** 既存ディレクトリを流用してよいかの1箇所の判定(ADR 0087 決定5)。`wanted` は
 *  clone モードの要求 repo、create モードでは undefined(= origin を持たないこと
 *  が整合の条件)。盤面の clone の `origin` は盤面が組んだ URL(ADR 0339 決定4)で、GitHub は入力の綴りに依らず
 *  https になる —— 両方が GitHub に解けるときは repo key で、解けないときは綴りのまま比べる(ADR 0052 の「綴りで
 *  repo を区別しない」)。同じ入力の再送はここを通る。読む origin は insteadOf を当てる前の値 —— 盤面の網に出る git が
 *  読むのと同じ1つの読み方(ADR 0339 決定4)。 */
function assertReusableOrphan(dir: string, wanted: string | undefined): void {
  const origin = originValue(dir);
  if (sameRepository(origin, wanted)) return;
  throw new OrphanCheckoutMismatchError(
    dir,
    `its 'origin' is ${origin ?? "absent"}, expected ${wanted ?? "none"}`,
  );
}

/** ADR 0066 決定1 の create モードの外部半分: GitHub に一切出ず、規約由来の場所
 *  (ADR 0018)に `git init -b main` + 初期コミットで checkout を作る。
 *
 *  `-b main` は明示が必須である — ホストの `init.defaultBranch` は盤面の管理下に
 *  なく、`master` の環境では初期ブランチ名が保護ブランチの既定(`main`)とずれて
 *  pickup がタスクブランチの fork 元を引けずに落ちる。初期コミットが要るのは
 *  同じ理由で、空リポジトリには `main` が存在しない。`repo` を書かないため、生まれる
 *  workspace は構造的に purely-local である(ADR 0052 決定3)。 */
function createLocalCheckout(name: string, deps: WorkspaceGitHubDeps): WorkspaceEntry {
  const dir = conventionCheckoutPath(name, deps.workspacesBaseDir);
  // idempotent retry (issue #57): 規約どおりの場所に既にある checkout は、前回
  // registry コミット直前で失敗した孤児 —— 済んだ手順として流用する(clone
  // モードの cloneAndDescribe と同じ形)
  // create が作る checkout は purely-local なので、`origin` を持つ残骸は別物である
  if (existsSync(dir)) assertReusableOrphan(dir, undefined);
  else {
    // git init creates any missing directories itself, mkdir first is redundant
    git(deps.workspacesBaseDir, "init", "-b", "main", dir);
    git(dir, "commit", "--allow-empty", "-m", "initial commit");
  }
  return {};
}

/** 盤面がこれから git でその repo へ出ていく直前に、その repo の installation token を
 *  仲介が出せることを1回だけ確かめる(ADR 0067 決定2 の登録の門 = `clone`、決定8 の
 *  `publish`。修復の中身は ADR 0093 決定8)。
 *  撃たないのは2つの場合で、どちらも通す:
 *
 *  - `github` 不在 —— 盤面が GitHub 身元(ADR 0024)を持たないので probe を撃つ相手
 *    そのものが無い。ここは通す側で、git 呼び出しは匿名で撃ち、private なら落ちる(ADR 0339 決定2)
 *  - 非 GitHub の URL —— `clone` の入力欄も `publish` の宛先欄も「anything git が
 *    受ける綴り」であり、`parseGitHubRepo` の `undefined` がそのままこの門になる
 *    (決定1)
 *
 *  `create` モードは GitHub に一切出ない(ADR 0066 決定1)ので呼ばない。`register`
 *  モードにも置かない(決定3 の非対称): 既にホスト上にある checkout の登録に probe を
 *  足すと、登録の門が全モードでネットワークを要求することになる。 */
async function assertRepoAccess(repo: string, github: GitHubClient | undefined): Promise<void> {
  const ref = parseGitHubRepo(repo);
  if (!github || !ref) return;
  const { guidance } = await repairRepoAccess(github, ref);
  if (guidance) throw new RepoAccessMissingError(guidance);
}

/** The registration gate refused a `register` path that is not a git
 *  repository (ADR 0066 決定7): `repo` is written as an **observation made at
 *  registration time** (ADR 0052 決定3), and an object that cannot be observed
 *  must not get a written declaration in its place. */
export class NotAGitRepositoryError extends Error {
  constructor(path: string) {
    super(`${path} is not a git repository`);
    this.name = "NotAGitRepositoryError";
  }
}

/** 登録の門の hooks 信号の読み手で、盤面で settings の JSON を読む唯一の場所(ADR 0346 決定3)。
 *  `sandbox` / `permissions` の有無は見ない。壊れた JSON と object でない値は信号にしない。読むのは通常ファイルだけ ——
 *  link は辿らないので、FIFO を指す link で門が止まらない(#2935)。 */
function settingsDeclareHooks(path: string): boolean {
  const file = join(path, ".claude", "settings.json");
  try {
    if (!lstatSync(file).isFile()) return false;
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && "hooks" in parsed;
  } catch {
    return false;
  }
}

/** 人間の checkout の index が `.claude/settings.json` を知っているか。読めなければ知らない。 */
function settingsTracked(path: string): boolean {
  try {
    return git(path, "ls-files", "--", ".claude/settings.json") !== "";
  } catch {
    return false;
  }
}

/** `.claude/settings.json` の置き場所に何かあるか —— link を辿らず、ENOENT 以外の失敗(`.claude` が通常ファイルの ENOTDIR、EACCES)も在る。 */
function settingsPlaced(path: string): boolean {
  try {
    lstatSync(join(path, ".claude", "settings.json"));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** ADR 0354 決定3: checkout の `.claude/agents` が実ディレクトリで、直下に通常ファイルの `*.md` が1つ以上あるか。
 *  中身も tracked かも見ない。link は辿らない(#2935)ので、ADR 0069 の 0-byte shadow file(通常ファイル)や
 *  ディレクトリへの link では立たない。再帰もしない —— 読まれる定義は直下だけ。 */
function hasSubagentDefinitions(path: string): boolean {
  const dir = join(path, ".claude", "agents");
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    return readdirSync(dir, { withFileTypes: true }).some((e) => e.isFile() && e.name.endsWith(".md"));
  } catch {
    return false;
  }
}

/** 登録対象の checkout に「生きた dev checkout らしさ」の信号があるか(issue #383)。
 *
 *  `settings.local.json` の検査は `git status` の冗長ではない —— このファイルは
 *  gitignore されるので untracked としても現れない。未追跡の `settings.json` も同じ理由で
 *  独立に要る(issue #686 — ignore されていなければ `uncommitted_changes` と両方立つが、
 *  抑制しない)。読み手は2つに分かれる(ADR 0346 決定3): `settings.json` の置き場所(tracked か未追跡か)は人間の checkout の
 *  作業ツリーと index を読む `settingsPlaced` / `settingsTracked`、中身は門の信号の `settingsDeclareHooks` だけが読む。worker 向けの
 *  判定は記録を読む別物(ADR 0360 決定1)。`settings.local.json` は独立に、link を辿らない `lstat` で存在だけを見る。
 *  `.claude/agents` の subagent 定義は `hasSubagentDefinitions` が在否だけを見る(ADR 0354 決定3)。 */
function liveCheckoutSignals(path: string): LiveCheckoutSignal[] {
  const reasons: LiveCheckoutSignal[] = [];
  // --no-optional-locks: 門が人間の生きた作業ツリーの index.lock を取らない
  // (守ろうとしているものを触りにいかない)
  try {
    if (git(path, "--no-optional-locks", "status", "--porcelain") !== "") {
      reasons.push("uncommitted_changes");
    }
  } catch {
    // 作業ツリーを持たないパス(bare repo は `rev-parse --git-dir` を通ってここへ
    // 来る)。「読めなかった」を「きれい」と読ませない —— fail-closed だが、この門は拒まないので
    // 人間が見て納得すれば従来どおり登録される。素の例外を投げれば 502(盤面の
    // 故障)に化け、呼び出し側の入力の問題を盤面のせいにしてしまう
    reasons.push("worktree_unreadable");
  }
  // link を辿らない —— dangling な link も在る(#2935)。`.claude` が通常ファイルの ENOTDIR は従来どおり無い
  try {
    lstatSync(join(path, ".claude", "settings.local.json"));
    reasons.push("claude_settings_local");
  } catch {}
  const tracked = settingsTracked(path);
  if (tracked && settingsDeclareHooks(path)) reasons.push("claude_settings_hooks");
  if (!tracked && settingsPlaced(path)) reasons.push("claude_settings_untracked");
  if (hasSubagentDefinitions(path)) reasons.push("claude_subagents");
  return reasons;
}

function unhideableSettingsWarning(workspace: WorkspaceConfig): string | undefined {
  try {
    const { unhideable } = recordedSettingsDisposition(workspace.path, exactProtectedBranchRef(workspace));
    if (unhideable) {
      return `The protected branch has ${unhideable.path} as a ${unhideable.type}. Claude tasks in this workspace that inherit this shape will stop at pickup.`;
    }
  } catch {
    // ADR 0360 決定5: ref が無い場合や読めない場合も、観測できた既存の信号で登録を進める。
    return undefined;
  }
}

/** 登録の門が観測した信号を人間へ**提示**する(issue #383 — 拒否ではない)。同意した
 *  再送(`confirm: true`)は従来どおり登録する。
 *
 *  メッセージは信号コードと clone 入口の提案を1箇所で綴る唯一の場所である —— API の
 *  409 がこれを読み、管理MCP も警告の一行を共有する。clone 入口の提案は作業ツリーの信号に対するもの。 */
export class LiveCheckoutSignalsError extends Error {
  constructor(
    path: string,
    public readonly reasons: LiveCheckoutSignal[],
    public readonly cloneLanding: string | null,
    public readonly settingsWarning?: string,
  ) {
    super(
      `Review the registration warnings for ${path} (${reasons.join(", ")})` +
        (cloneLanding === null
          ? "; register it anyway with confirm: true"
          : `; the clone entrance would give the board its own checkout at ${cloneLanding} instead — register this path anyway with confirm: true`) +
        ". Workers receive only committed content: ignored files in this checkout (such as .claude/settings.local.json, .env, and node_modules) do not reach them." +
        (settingsWarning ? `\n${settingsWarning}` : ""),
    );
    this.name = "LiveCheckoutSignalsError";
  }
}

/** The register mode's half: the entry records the explicit host path, plus the
 *  checkout's own `origin` URL as its **remote-source-of-truth declaration**
 *  (ADR 0052 決定3 / issue #211). Reading it here is what makes the declaration a
 *  declaration at all — the clone/create modes get it for free because they were
 *  handed the URL, and the board must not be left inferring it from the clone at
 *  every use (the fallback ADR 0052 rejected by name).
 *
 *  No remote → no `repo`: a checkout that is nobody's clone is a legitimate,
 *  purely-local workspace, and writing `repo` anyway would manufacture exactly
 *  the declaration/reality mismatch that pickup quarantines.
 *
 *  **The path must be a git repository at all** (ADR 0066 決定7 — the previous
 *  justification for skipping this, "a checkout can be placed after the entry",
 *  is withdrawn). The check is just `git -C <path> rev-parse --git-dir`'s
 *  success, same shape as ADR 0040's overlap gate: the gate refuses, the floor
 *  stays at pickup. Without it, registering an unobservable path would write
 *  the "no repo" default not as an observation but as a guess — and a human
 *  placing a remote-backed clone there later would make declaration and
 *  reality disagree, the exact mismatch pickup quarantines. */
function registerExistingCheckout(path: string): WorkspaceEntry {
  // ADR 0146: rev-parse より前 —— gitdir の指し先が無ければ rev-parse が先に落ち、
  // 「git リポジトリでない」という違う理由が人間に届く
  assertOwnGitDirectory(path);
  try {
    git(path, "rev-parse", "--git-dir");
  } catch {
    throw new NotAGitRepositoryError(path);
  }
  const repo = originUrl(path);
  return repo === undefined ? { path } : { path, repo };
}

/** The clone mode's external half: a checkout at the convention-derived
 *  location (ADR 0018 — the entry never records the path). */
function cloneAndDescribe(name: string, repo: string, deps: WorkspaceGitHubDeps): WorkspaceEntry {
  if (isRelativeLocalPath(repo)) throw new RelativeClonePathError(repo);
  const dir = conventionCheckoutPath(name, deps.workspacesBaseDir);
  // idempotent retry (issue #57): a checkout already at the convention-derived
  // location is a completed step — the orphan a previous attempt left when it
  // failed before the registry commit — not a conflict
  // a private repo's clone needs the App's installation token too (ADR 0093) —
  // same injection path as every other board-driven git network call. clone に
  // はまだ checkout が無いので、宛先は clone する URL そのものが名指す(token は
  // `buildEntry` が先に温めてある)。
  // 流用してよいのは `origin` が要求 repo と一致するときだけ(ADR 0087 決定5)
  if (existsSync(dir)) assertReusableOrphan(dir, repo);
  else authedClone(deps.githubAuth, repo, resolve(dir), GIT_NETWORK_TIMEOUT_MS);
  // a fresh clone's HEAD is the upstream default branch — recorded when it
  // isn't "main" so branch discipline and the PR base start out right
  // (issue #27); "main" stays implicit (protectedBranch's default)
  const defaultBranch = git(dir, "rev-parse", "--abbrev-ref", "HEAD");
  return defaultBranch === "main" ? { repo } : { repo, branch: defaultBranch };
}

/** A workspace entry as the settings surface shows it, with computed protection. */
export interface WorkspaceView extends WorkspaceEntry {
  name: string;
  protected: boolean;
  protectionReason?: WorkspaceRegistryProtection["reason"];
}

/** The list read with the base directory as an attribute of the list itself
 *  (ADR 0082 決定1): the client composes `<base>/<name>` for the preview and
 *  for a path-omitting entry's row. That is display, not a second resolution —
 *  the rule is one join and the name carries no separator. */
export interface WorkspaceListView {
  workspaces: WorkspaceView[];
  workspacesBaseDir: { path: string; source: WorkspacesBaseDirSource };
}

/** `source` rides in as an argument rather than on `WorkspaceAdminDeps`: it is
 *  the one thing only this verb needs, and the deps bundle is "what every
 *  workspace-admin verb needs". */
export function listWorkspaceViews(
  deps: WorkspaceAdminDeps,
  source: WorkspacesBaseDirSource,
): WorkspaceListView {
  const registry = loadRegistry(deps.registry.dir, deps.registry.mode);
  const readProtection = workspaceProtectionReader(deps.registry.dir);
  return {
    workspaces: Object.entries(registry.workspaces).map(([name, entry]) => {
      const path = entryCheckoutPath(entry, name, deps.workspacesBaseDir);
      const protection = readProtection(entry, path);
      return {
        ...entry,
        name,
        protected: protection !== undefined,
        ...(protection && protection.reason !== "flag" && { protectionReason: protection.reason }),
      };
    }),
    workspacesBaseDir: { path: deps.workspacesBaseDir, source },
  };
}

/** Appends the entry to workspaces.yaml inside a disposable worktree and
 *  lands it under the board's own identity (ADR 0020 / ADR 0052 決定6). The
 *  yaml Document API keeps the hand-edited file's comments and formatting.
 *  Reads the file from the worktree, not the registry clone's own working
 *  tree — the clone's checkout is a cache the write never depends on, so the
 *  content this merges into is always the one the worktree actually forked
 *  from. A no-change edit (the same notes resubmitted) is a successful no-op
 *  — `commitToRegistry` skips landing when `write` leaves the tree clean. */
function commitWorkspaceEntry(
  deps: WorkspaceAdminDeps,
  name: string,
  entry: WorkspaceEntry,
  message: string,
  expectedMergePaths?: readonly string[],
): void {
  commitToRegistry(
    deps.registry,
    deps.githubAuth,
    (worktreeDir) => {
      const file = join(worktreeDir, "workspaces.yaml");
      const doc = parseDocument(readFileSync(file, "utf8"));
      if (expectedMergePaths !== undefined) {
        const current = ownEntry(doc.toJS() as Record<string, WorkspaceEntry>, name);
        if (!current) throw new UnknownWorkspaceError(name);
        assertMergePathsUnchanged(name, expectedMergePaths, current.human_merge_paths ?? []);
      }
      doc.set(name, entry);
      writeFileSync(file, doc.toString());
    },
    message,
  );
}
