import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { BOARD_ACTOR_ID, HUMAN_ACTOR_ID } from "./actor-id.js";
import { BoardStateOverlapError, type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, type EventOrigin, type IntakeEntry, type KeptValue, latestEventOfTask, type ReadCheckout, type ResourceStop, type TaskCheckoutWriteObservation } from "./events.js";
import { sessionHaltQuestion } from "./failed-teardown.js";
import {
  boardReadTree,
  boardViewStatus,
  boardWriteTree,
  CheckoutHostError,
  CheckoutUnreadableError,
  diffTreeEntries,
  displayWorktreePath,
  GitOutOfSpaceError,
  GitToolError,
  git,
  gitAnswers,
  gitListing,
  gitlinkChanges,
  gitReporting,
  gitWithInput,
  gitWithoutHistoryOverrides,
  isAncestor,
  ListingUnreadableError,
  outOfSpace,
  ownWorktreeStatus,
  readCheckoutRemote,
  type SparsePolicy,
  stagedGitlinkChanges,
  stagingHostStep,
  stashEntries,
  type WorktreeChange,
  WorktreeStatusError,
  withBoardGit,
  workerRepoGit,
  workerRepoGitUntil,
} from "./git.js";
import type { GitHubClient, RepoSlug } from "./github.js";
import {
  comparedRepo,
  type GitHubAuth,
  type GitRemote,
  HEAD_REPO_REMOTE,
  isRelativeLocalPath,
  landingHeadRepo,
  networkDestination,
  RemoteLacksObjectError,
  remoteTrackingRef,
  workspaceNetworkDestination,
} from "./github-auth.js";
import {
  assertHeadRemoteMatchesDeclaration,
  assertNotShallow,
  assertOwnGitDirectory,
  assertRemoteDeclarationMatchesClone,
  checkoutPickupPredicates,
  conventionCheckoutPath,
  discardUncommitted,
  exactProtectedBranchRef,
  gonePlaceReason,
  isRemoteBacked,
  type PickupPredicate,
  type PlaceFire,
  protectedBranch,
  protectedBranchRef,
  providedRev,
  RemoteRepositoryMismatchError,
  roomForkSource,
  roomPickupPredicates,
  roomPlace,
  roomPredicatesInOrder,
  roomProvisionOf,
  ShallowRepositoryError,
  safeRealpath,
  taskBranch,
  taskBranchExists,
  taskIdOfBranch,
  taskRoomPickupPredicates,
} from "./pickup-predicates.js";
import {
  endSentence,
  GIVE_UP_THE_LOST_REFS,
  openQuarantineQuestion,
  openQuarantineQuestions,
  parseWorkspaceContainmentValue,
  RESTORE_THE_BASELINE,
  registerResourceStop,
  workspaceContainmentValue,
} from "./quarantine.js";
import { placeHasRepository, recordedPlace } from "./recorded-place.js";
import {
  fetchBranchCopy,
  fetchCommit,
  type Harness,
  ownEntry,
  type RefWriter,
  type Registry,
  type RegistrySource,
  registryRef,
  remoteBranchSha,
  type WorkspaceEntry,
} from "./registry.js";
import { repairRepoAccess, repositoryLabel, sameRepository } from "./repo-access.js";
import { humanOnlyPathChanges, PROJECT_SETTINGS_PATHS, recordedSettingsDisposition, SANDBOX_STUB_PATHS } from "./sandbox.js";
import { isSettled } from "./task-status.js";
import {
  ancestorsFromTop,
  ancestorsSql,
  carriesReadOnly,
  countedAncestors,
  derivedWorkspace,
  derivedWorkspaceSql,
  fellLostBranchAttachments,
  fillEmptyWorkspace,
  getTask,
  hasStartedWork,
  hasTaskBranch,
  hasTaskBranchInForce,
  holdsFirstCaptures,
  interviewRole,
  interviewRoomPath,
  interviewRootIdOf,
  issueRefPlaceholder,
  keepsCheckoutAsRecord,
  landedForLineage,
  type NoReturnAncestor,
  nearestFilledAncestor,
  noReturnAncestors,
  noReturnCause,
  openLocalMergeQuestionIds,
  readableInterviewRooms,
  registerFailureQuestion,
  registerTask,
  releaseOwedBy,
  retireLandingDecisions,
  sessionReadCheckouts,
  sessionRealEnvironmentCheckout,
  settledNoReturnAncestorOfReview,
  stopForRepoDisagreement,
  subtreeSql,
  type Task,
  type TaskType,
  taskBranchLostAfterCheckoutOpened,
  taskBranchLostInForce,
  taskCheckoutPath,
  taskCheckoutWasReleased,
  tasksOwingReleaseOn,
  tasksReleasedOn,
  teardownUnfinishedUnder,
} from "./tasks.js";
import { BOARD_BRANCHES, foreignTaskBranches, humanWorkLeft, WorkbenchGitError, type WorkbenchOwner, type WorkbenchRead, workbenchAnswer, workbenchCommands, workbenchOwner, workbenchPath } from "./workbench.js";
import { WORKER_TREE_GIT_TIMEOUT_MS, WorkerGitCopyTimeoutError, WorkerTreeGitTimeoutError } from "./worker-tree-git-timeout.js";


/** The board's workspace: registry name + path of a real git checkout. The
 *  branch discipline and the slot-release tree rule (issue #8) act on it —
 *  enforced by tidepool itself, never entrusted to the worker. */
export interface WorkspaceConfig {
  name: string;
  path: string;
  /** The protected branch (issue #27 / ADR 0023): lineage bottom, PR base,
   *  and direct-write-ban target, all one field. Absent → "main" —
   *  the pre-#27 shape for a `WorkspaceConfig` built outside the registry
   *  (test fixtures). */
  branch?: string;
  /** ADR 0378 決定1: the registry declares the network destination in `repo`. An absent value declares a purely-local workspace. */
  repo?: string;
  /** ADR 0395 決定2: the declared PR head repo (a fork of `repo`). */
  head_repo?: string;
  /** ADR 0378 決定7・8: board operations recheck the live declaration before using its destination. */
  checkRememberedRepo?: (place: WorkspaceConfig) => Pick<WorkspaceConfig, "path" | "repo" | "head_repo">;
  /** ADR 0399 決定3: a destination read also checks the declared repo and the head repo recorded for the task it carries against the
   *  rechecked declaration —— only destination reads, never the pickup predicate that rechecks the remembered repo. */
  checkDeclaredRepo?: (current: Pick<WorkspaceConfig, "name" | "path" | "repo" | "head_repo">) => void;
  /** Command prefixes a review session may run despite the `manual` write
   *  floor (issue #144 / ADR 0035), passed through from the registry entry the
   *  same way `branch` is. Absent → none: a `WorkspaceConfig` built outside the
   *  registry widens nothing. */
  review_allowed_commands?: string[];
  /** Workspace-scoped sandbox egress domains (ADR 0072). Absent opens none. */
  allowed_domains?: string[];
  human_merge_paths?: string[];
}

/** Where a task runs: its task checkout (ADR 0356 決定1) — the spawn view (`taskRunPlace`) or the view the board's gates and
 *  teardown act on (`taskRunPlaceForBoard`).
 *  `reads` are the places outside it opened for reading only, in their real spelling — the rooms an Interview root may open
 *  (plus its real environment, in the spawn view only — the sandbox reads it, the gates and teardown do not: ADR 0363 決定1〜3 の
 *  Status 追記), or the rooms a review under an Interview root reads. Empty for every other task.
 *  They are places, not paths, so the pickup can bring a remote-backed one to its rest position the same way as the run place
 *  (issue #2223).
 *  `namedPlace` is the named place the task checkout was made from and is released into (ADR 0356 決定1・2) — the
 *  workspace, or the interview room for an Interview root and its examinees: `path` is the task checkout and `name` the
 *  named place's. */
export type RunPlace = (WorkspaceConfig & { reads: WorkspaceConfig[]; namedPlace?: never }) | TaskCheckoutPlace;

/** task の checkout で走る場所(ADR 0356 決定1)。どの type でも閉包を全部持つ複製で、名前の場所の objects を借りない(ADR 0411 決定1)。 */
export type TaskCheckoutPlace = WorkspaceConfig & { reads: WorkspaceConfig[]; namedPlace: WorkspaceConfig };

function isTaskCheckout(place: WorkspaceConfig): place is TaskCheckoutPlace {
  return (place as Partial<TaskCheckoutPlace>).namedPlace !== undefined;
}

/** worker の形で走る process は全部 task の checkout で走る(ADR 0356 決定1)—— 名前の場所に当てる門・解放・写しは無い。 */
function assertTaskCheckout(place: WorkspaceConfig, taskId: string): asserts place is TaskCheckoutPlace {
  if (!isTaskCheckout(place)) throw new Error(`task ${taskId} does not run in a task checkout (${place.path})`);
}

/** 盤面が repo の間で撃つ fetch の共通の旗: FETCH_HEAD に在り処を残さず、submodule を辿らず、auto-gc を撃たない(ADR 0276 決定1 / ADR 0356 決定5)。 */
const FETCH_FLAGS = ["--quiet", "--no-auto-gc", "--no-write-fetch-head", "--no-recurse-submodules"] as const;

export { protectedBranch, protectedBranchRef, taskBranch, taskBranchExists } from "./pickup-predicates.js";

/** ADR 0018: the base directory a workspace entry's path derives from when
 *  the entry omits `path`. `configured` is `TIDEPOOL_WORKSPACES_DIR` as read
 *  by the caller (env access stays at the board's config edge, not here) —
 *  absent → `~/tidepool-workspaces`, the development machine's default. A
 *  production host sets it (see the deploy-pi skill); ADR 0082 決定4 keeps the
 *  value that host uses out of here, since a source comment asserting a
 *  deployment fact goes silently false the moment the deployment changes. */
export function resolveWorkspacesBaseDir(configured: string | undefined): string {
  return configured ?? join(homedir(), "tidepool-workspaces");
}

/** ADR 0082 決定2: where the base dir above came from. The path alone cannot
 *  tell "a host that meant this" from "a host that set nothing" — the
 *  registration gate shows both, so the same env value answers both questions
 *  here rather than growing a second spelling of `??` at the display end. */
export type WorkspacesBaseDirSource = "configured" | "default";

export function workspacesBaseDirSource(configured: string | undefined): WorkspacesBaseDirSource {
  return configured === undefined ? "default" : "configured";
}

/** A task's `workspace` (or the board's default) names a workspace absent
 *  from the registry — registry drift (issue #26). */
export class UnknownWorkspaceError extends Error {
  /** `registry`: 名前を引いた registry —— B9 の文が削除の扉の commit を探す先(ADR 0401 決定5)。 */
  constructor(public readonly workspaceName: string, public readonly registry?: RegistrySource) {
    super(`unknown workspace: ${workspaceName}`);
  }
}

/** An Interview task's place (its room, or an examinee's own checkout) has no opened event: the board never got as far as making it. */
export class PlaceNotOpenError extends Error {}

/** ADR 0009: the workspace name is resolved fresh against the registry.
 *  ADR 0372 決定1: callers pass the column or the name derived from an ancestor.
 *  Null means both are empty, so the board's default applies. `workspacesBaseDir`
 *  is `resolveWorkspacesBaseDir`'s output, threaded in rather than read from
 *  env here (ADR 0018) — this stays a pure function of its arguments. */
export function resolveExecutionWorkspace(
  registry: Registry,
  defaultWorkspaceName: string,
  taskWorkspace: string | null,
  workspacesBaseDir: string,
): WorkspaceConfig {
  const name = taskWorkspace ?? defaultWorkspaceName;
  const entry = ownEntry(registry.workspaces, name);
  if (!entry) throw new UnknownWorkspaceError(name, registry.source);
  // the "main" default lives solely in protectedBranch — entry.branch passes
  // through as-is (possibly absent) rather than getting normalized here too
  const path = entryCheckoutPath(entry, name, workspacesBaseDir);
  return {
    name,
    path,
    branch: entry.branch,
    repo: entry.repo,
    head_repo: entry.head_repo,
    review_allowed_commands: entry.review_allowed_commands,
    allowed_domains: entry.allowed_domains,
    human_merge_paths: entry.human_merge_paths,
  };
}

/** ADR 0329: repo を作ってから開いた event を残す。記録済みの面接室は作り直さない —— 作り直すのは `run with an empty room` だけ(ADR 0373 決定11)。 */
export function openInterviewRoom(db: Db, root: Task, workspacesBaseDir: string, now: Date): void {
  const recorded = recordedPlace(db, root.id);
  if (recorded && !recorded.hasRepository) throw new Error(gonePlaceReason(root.id, recorded.path));
  let path = recorded?.path;
  if (path === undefined) {
    const at = conventionCheckoutPath(root.id, workspacesBaseDir);
    mkdirSync(at, { recursive: true });
    path = realpathSync(at);
    initRoom(path, root.id);
    appendEvent(db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "interview_room_opened", path }, at: now });
  }
}

/** 面接室の repo を作る —— 最初の開きと `run with an empty room` が同じ形で作る。branch は明示する(素の `git init` は VM と Pi で `master`)。 */
function initRoom(path: string, rootId: string): void {
  git(path, "init", "--quiet", "--initial-branch=main");
  initialRoomCommit(path, rootId);
}

/** ADR 0373 決定11: `run with an empty room` —— 面接室の基準の行と sparse の pin を消してから、最初の開きと同じに作り直す。行が無いので
 *  作り直しは口を通らず、次の pickup が最初の撮りをする(ADR 0351 決定2)。開いた event は元のまま在り処を指す。 */
export function recreateEmptyRoom(db: Db, room: WorkspaceConfig): void {
  dropWorkspaceState(db, room.name);
  mkdirSync(room.path, { recursive: true });
  initRoom(room.path, room.name);
}

function initialRoomCommit(path: string, rootId: string): void {
  if (readRef({ name: rootId, path }, "HEAD") !== "") return;
  // ADR 0329 決定13: 未生の HEAD だけ main へ向け直す —— 人間の init.defaultBranch に依らない。
  git(path, "symbolic-ref", "HEAD", "refs/heads/main");
  // 受験者の履歴に載るので、盤面の語を持たない件名(ADR 0273 決定1)
  git(path, "commit", "--quiet", "--allow-empty", "-m", "Initial commit");
}

/** 在り処が残った面接室を走る場所として(ADR 0273 決定1・8)。名前は root の id で、quarantine・封じ込めの組・ref の基準はこの名前で立つ。 */
export function recordedInterviewRoom(db: Db, rootId: string): WorkspaceConfig | undefined {
  const path = interviewRoomPath(db, rootId);
  return path === undefined ? undefined : { name: rootId, path };
}

/** ADR 0433 決定5: host の失敗(disk が満ちた git を含む)は段の型(名前の場所の側・pickup の門)に包み直さず、そのまま段ごとの host の線へ
 *  届ける —— 包む手は `hostFailure(cause) ?? 包んだ型` と書く。 */
const hostFailure = (cause: unknown): CheckoutHostError | undefined => (cause instanceof CheckoutHostError ? cause : undefined);

/** ADR 0329 決定10: 落ちた項の説明と場所を pickup / 解除で共有する。作るのは `of` だけ。 */
export class PickupGateError extends Error {
  private constructor(readonly place: WorkspaceConfig, cause: unknown, describe?: string) {
    super(`${cause instanceof Error ? cause.message : String(cause)}${describe ? `\n\nThe check that failed: ${describe}` : ""}`, { cause });
  }

  /** ADR 0399 決定5: 根の記録と宣言の食い違いは場所の失敗でなく根の止まり —— 包まずにそのまま返し、どの呼び手にも素で届く。ADR 0433 決定5:
   *  host の失敗も場所の失敗ではない —— 包まずに返す。 */
  static of(place: WorkspaceConfig, cause: unknown, describe?: string): PickupGateError | DeclaredRepoMismatchError | CheckoutHostError {
    return cause instanceof DeclaredRepoMismatchError ? cause : (hostFailure(cause) ?? new PickupGateError(place, cause, describe));
  }
}

/** pickup の門(ADR 0329 追記 決定7・8): task が開く場所すべてを、走る場所を開く**前**に種類付きで列挙し、種類ごとの一覧を撃つ。
 *  集合は停止の門(tasks.ts の `openedPlaceNamesSql`)が数える名前に含まれる(停止の門は受験者の `workspace` 列の実環境も数える、
 *  ADR 0368 決定3)—— 受験者は面接室(fetch 元、ADR 0356 決定1)、root は
 *  `workspace` 列の実環境と読む面接室と自分の面接室、root 配下の review は実環境と読む面接室、他は実環境。番地は記録があれば event の綴り、
 *  無ければ規約の番地。面接室には場所の項とこの task の (task, 面接室) の項を撃つ(ADR 0329 決定4 の Status 追記)。
 *  読む面接室は記録されたものだけなので、面接室の一覧は記録分岐だけを通る。root 自身の面接室は最後に撃つ —— 未記録なら
 *  作る分岐の `mkdir -p` が走るので、読む場所が落ちた root は自分の面接室を作らずに止まる。一覧の組み立ても撃つのと同じ場所の失敗として、
 *  最初に落ちた場所で `PickupGateError` を投げる(根の記録と宣言の食い違いは素の `DeclaredRepoMismatchError`、ADR 0399 決定5)。 */
export async function pickupGate(db: Db, workspace: WorkspaceConfig, task: Task, workspacesBaseDir: string, now: () => Date, fixedPoints?: BoardStatePath[], live?: () => boolean) {
  workspace = withRememberedRepoCheck(db, workspace, now);
  // ADR 0386 決定4: 面接室の項は解除の門・本文と同じ並び —— 受験者の (task, 面接室) の項だけは場所の項より先
  const room = (rootId: string) => ({
    ...roomPlace(db, rootId, workspacesBaseDir),
    predicates: () => roomPredicatesInOrder(db, rootId, [task], workspacesBaseDir, fixedPoints),
  });
  const real = { ...workspace, predicates: () => checkoutPickupPredicates(workspace, fixedPoints) };
  const reads = roomsReadBy(db, task).map((read) => room(read.name));
  const rootId = interviewRootIdOf(db, task);
  const places =
    rootId === undefined
      ? [real, ...reads]
      : task.type === "interview"
        ? [real, ...reads, room(rootId)]
        : [room(rootId)];
  const checks = [];
  for (const { predicates, ...place } of places) {
    if (live?.() === false) return checks;
    try {
      const list = predicates();
      fireBeforeOpenPredicates(place, list, live);
      checks.push({ place, predicates: list });
    } catch (err) {
      if (err instanceof PickupGateError) throw err;
      throw PickupGateError.of(place, err);
    }
  }
  return checks;
}

/** spec #3273 の受理の順の前半(ADR 0329 決定14): 名前に掛かる前半の項 → 名前の場所の clean(`clean` のとき)。workspace の Quarantine の
 *  受理と、同じ条件で merge back を撃ち直す積み残しの retry(ADR 0371 決定10)が掛ける。 */
export async function checkAcceptanceFirstHalf(db: Db, place: WorkspaceConfig, predicates: PickupPredicate[], clean: boolean): Promise<void> {
  fireBeforeOpenPredicates(place, predicates);
  if (clean) verifyWorkspaceClean(db, place);
}

/** 開く前の項は同期で撃てる —— 同期の呼び手(着地の最初の撮り、ADR 0399 決定7)も await を挟まずに pickup と同じ項を撃つ。 */
export function fireBeforeOpenPredicates(place: WorkspaceConfig, predicates: PickupPredicate[], live?: () => boolean): void {
  for (const predicate of predicates) {
    if (live?.() === false) return;
    if (predicate.phase !== "before-open") continue;
    try {
      predicate.check();
    } catch (err) {
      throw PickupGateError.of(place, err, predicate.describe);
    }
  }
}

/** ADR 0329 決定10・14: 同じ項を pickup と解除で撃ち、token の鮮度だけは呼び手が決める。後半の書き込みは口(ADR 0351 決定3)で、
 *  鍵は項の場所の名前。 */
export async function firePickupPredicates(
  db: Db,
  place: WorkspaceConfig,
  predicates: PickupPredicate[],
  phase: PickupPredicate["phase"],
  board: PickupPrep & { fresh?: boolean; now: () => Date },
): Promise<void> {
  if (phase === "before-open") return fireBeforeOpenPredicates(place, predicates, board.live);
  const fire: PlaceFire = {
    fetch: async (target) => {
      target = withRememberedRepoCheck(db, target, board.now);
      await ensureWorkspaceToken(target, board.githubAuth, { fresh: board.fresh });
      if (board.live?.() === false) return;
      if (isRemoteBacked(target)) fetchBranchCopy(target, board.githubAuth, protectedBranch(target), boardRefWriter(db, target));
    },
    park: (target) => parkOnProtectedBranch(db, withRememberedRepoCheck(db, target, board.now)),
  };
  for (const predicate of predicates) {
    if (board.live?.() === false) return;
    if (predicate.phase !== "after-open") continue;
    try {
      await predicate.check(fire);
    } catch (err) {
      throw PickupGateError.of(predicate.place, err, predicate.describe);
    }
  }
}

/** task が読みだけ開く面接室(ADR 0273 決定4・9): root は開ける面接室、review の親を review の鎖で辿って Interview の root に着く
 *  review(監査、root や監査の行への異議の RCA、人間登録の review 子)は root の面接室と開ける面接室。どれも記録された在り処。 */
function roomsReadBy(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id" | "parent_id">): WorkspaceConfig[] {
  const rootId = interviewRootIdOf(db, task);
  if (rootId !== undefined) return task.type === "interview" ? readableInterviewRooms(db, rootId) : [];
  let parent = task.type === "review" && task.parent_id !== null ? getTask(db, task.parent_id) : undefined;
  while (parent?.type === "review" && parent.parent_id !== null) parent = getTask(db, parent.parent_id);
  if (parent?.type !== "interview") return [];
  const room = recordedInterviewRoom(db, parent.id);
  return [...(room ? [room] : []), ...readableInterviewRooms(db, parent.id)];
}

/** task が走る場所(ADR 0356 決定1): この session の task の checkout。名前の場所は task の workspace、interview の root と受験者は
 *  面接室(名前は root id —— quarantine と封じ込めの組の単位、ADR 0273 決定8 / ADR 0276 決定3)。許可ドメインと層は呼び手が
 *  実環境の `workspace` から読み、root は実環境と開ける面接室を読みだけ開く。付帯子の review は親の読みの面を継ぐ(ADR 0273 決定4)
 *  —— root 配下の review は実環境で走り root の面接室と開ける面接室を読みだけ開く。読む面接室は面接室の path でなく、pickup が開いた
 *  event に記録したこの session の読み専用の checkout(ADR 0361 決定1)で、名前は面接室の root id のまま。開く前の対(開く場所の列挙)は
 *  `pickupGate`、それが通った後に走る場所が開くので、ここは開いた後しか返せない。 */
export function taskRunPlace(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id" | "parent_id" | "workspace">, workspace: WorkspaceConfig): TaskCheckoutPlace {
  const place = taskRunPlaceForBoard(db, task, () => workspace);
  // ADR 0426 決定2: root の sandbox は実環境の読み専用の checkout を開く。
  const real = task.type === "interview" && sessionRealEnvironmentCheckout(db, task.id);
  return real ? { ...place, reads: [real, ...place.reads] } : place;
}

/** 盤面の門(完了の門・`pose_probe`)と後始末が当たる走る場所(ADR 0363 決定1〜3 の Status 追記): 実環境を解くのは名前の場所が
 *  task の workspace の task だけで、`resolve` はそのときだけ呼ぶ(drift の `UnknownWorkspaceError` は呼び手へ)。spawn の sandbox
 *  の読み(root の実環境)は足さない —— それは `taskRunPlace`。Interview の root と受験者の名前の場所は記録にある面接室なので
 *  `resolve` に依らず、undefined を返さない(面接室か task の checkout が開いていなければ `PlaceNotOpenError`)。それ以外で
 *  `resolve` が無ければ undefined(ADR 0084 決定2)。 */
export function taskRunPlaceForBoard(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id" | "parent_id" | "workspace">, resolve: WorkspaceResolver): TaskCheckoutPlace;
export function taskRunPlaceForBoard(
  db: Db,
  task: Pick<Task, "id" | "type" | "interview_target_id" | "parent_id" | "workspace">,
  resolve: WorkspaceResolver | undefined,
): TaskCheckoutPlace | undefined;
export function taskRunPlaceForBoard(
  db: Db,
  task: Pick<Task, "id" | "type" | "interview_target_id" | "parent_id" | "workspace">,
  resolve: WorkspaceResolver | undefined,
): TaskCheckoutPlace | undefined {
  const room = interviewRoomOf(db, task);
  const named = room ?? resolve?.(task.workspace);
  if (!named) return undefined;
  const path = taskCheckoutPath(db, task.id);
  if (path === undefined) throw new PlaceNotOpenError(`the task checkout of ${task.id} is not open`);
  return { ...named, path, reads: sessionReadCheckouts(db, task.id).map(inRealSpelling), namedPlace: named };
}

/** task の checkout を作り、解放で着ける名前の場所(ADR 0356 決定1): task の workspace、interview の root と受験者は面接室。 */
export function taskNamedPlace(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id">, workspace: WorkspaceConfig): WorkspaceConfig {
  return interviewRoomOf(db, task) ?? workspace;
}

/** Interview の root と受験者の名前の場所 —— 記録された面接室。他の task は undefined。 */
function interviewRoomOf(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id">): WorkspaceConfig | undefined {
  const rootId = interviewRootIdOf(db, task);
  if (rootId === undefined) return undefined;
  const room = recordedInterviewRoom(db, rootId);
  if (!room) throw new PlaceNotOpenError(`the interview room of ${rootId} is not open`);
  return room;
}

/** 読む場所を実体の綴りで —— sandbox の読みの path と cwd・root に渡す在り処が同じ綴りになる(issue #1954)。 */
const inRealSpelling = (place: WorkspaceConfig): WorkspaceConfig => ({ ...place, path: safeRealpath(place.path) });

/** 名前の場所の objects の実体の綴り。借りる先は盤面所有の写しだけ —— 作業台の tip の検証後の写し(ADR 0411 決定2)、運んだ後の確かめの
 *  使い捨ての repo、出題の写しの検証後の写しと、ref が tip より先にある解放の WIP の検証後の写し(どちらも stage の後、ADR 0412 決定2)。symlink を解くのは、alternates と確かめが張る loose の dir への
 *  symlink を登録の綴りの link に依らせないため —— sandbox の読みの path と綴りを揃える理由(ADR 0356 決定2)は ADR 0411 決定1 で無くなった。
 *  引けなければ素の失敗で、呼び手が名前の場所の側として扱う。 */
function namedObjects(named: WorkspaceConfig): string {
  return realpathSync(git(named.path, "rev-parse", "--path-format=absolute", "--git-path", "objects"));
}

/** ADR 0411 決定1: sandbox は名前の場所の objects を開かない —— task の checkout は閉包を全部持つ。 */
export function runPlaceReadPaths(place: RunPlace): string[] {
  return place.reads.map((read) => read.path);
}

/** 盤面が pickup ごとに作る checkout の番地(ADR 0356 決定2 / ADR 0361 決定1): 番地と、解放が消す空になった親の段数を1か所で持つ。 */
const CHECKOUT_LAYOUT = {
  /** 基点 / 鍵(task id、root は `<id>.checkout`)/ pickup の event id。`base` は在り処から基点へ戻る逆 */
  task: { at: (base: string, key: string, pickup: number) => join(conventionCheckoutPath(key, base), String(pickup)), parents: 1, base: (checkout: string) => dirname(dirname(checkout)) },
  /** 基点 / `<task id>.reads` / pickup の event id / 読む面接室の名前(root id) */
  read: { at: (base: string, taskId: string, pickup: number, rootId: string) => join(conventionCheckoutPath(`${taskId}.reads`, base), String(pickup), rootId), parents: 2 },
  /** ADR 0426 決定2: 実環境の名前は面接室の root id と別の名前空間。 */
  realEnvironment: { at: (base: string, taskId: string, pickup: number) => join(conventionCheckoutPath(`${taskId}.real-environment`, base), String(pickup)), parents: 1 },
  /** 基点 / `@workbench` / (書く先, 運ばれる側) の葉(ADR 0382 決定1、番地の不変条件は `workbenchPath`)。保護ブランチの葉は workspace を持つ。
   *  運ばれる側の無い鍵は人間自身の内容の作業台(ADR 0382 決定4) */
  workbench: {
    at: (base: string, named: WorkspaceConfig, target: string, carried?: string) =>
      workbenchPath(base, target === protectedBranch(named) ? { workspace: named.name } : { task: taskIdOfBranch(target) }, carried),
    parents: 1,
  },
  /** 基点 / `@containment-check` / 検査ごとの id(ADR 0379 決定2)。`@` は workspace の名前にも task id にも無いので、workspace・面接室・task の
   *  checkout・読み専用の checkout・作業台のどの番地にもならず、どの worker の sandbox も開かない。spawn の2段目は in-flight の鍵の外で走るので検査ごとに別の番地 */
  containmentCheck: { at: (base: string) => join(base, "@containment-check", randomUUID()), parents: 1 },
} as const;

export { CheckoutHostError } from "./git.js";

/** ADR 0356 決定2: 番地 `at` に自分の git directory を空の template から作り、`from`(既定は名前の場所)の `source`(ref の名前か sha)だけを
 *  ローカルの `branch` へ fetch して checkout する。名前の場所の objects は借りない複製で、引いたものの閉包を全部持つ(ADR 0411 決定1・2・7)。`config` は init の直後に置く git config(作業台の `receive.denyCurrentBranch=updateInstead`、
 *  ADR 0371 決定9)。番地を作れないのは host 側の失敗(`description` が文の主語)。fetch の失敗は `fetchFailure` が包み(無ければ素のまま)、
 *  tree の展開の失敗は素のまま。返すのは実体の綴りの在り処。 */
function makeCheckout({ at, named, from = named.path, source, branch, description, config = {}, fetchFailure }: {
  at: string;
  named: WorkspaceConfig;
  from?: string;
  source: string;
  branch: string;
  description: string;
  config?: Record<string, string>;
  fetchFailure?: (cause: unknown) => unknown;
}): string {
  let path: string;
  try {
    mkdirSync(at, { recursive: true });
    path = realpathSync(at);
    git(path, "init", "--quiet", "--template=", "--initial-branch=main");
    for (const [key, value] of Object.entries(config)) git(path, "config", key, value);
  } catch (cause) {
    throw new CheckoutHostError(`${description} cannot be created: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  // reflog にも名前の場所の在り処を残さない —— 受験者に面接室の在り処(root id)を運ばない(ADR 0276 決定1)。
  // `branch` が未生の main(init の current branch)でも fetch できるよう --update-head-ok
  // ADR 0364 決定2・3: 盤面所有の写しから読む人間の byte は `fetchFromBoardCopy` と同じく有界
  const boundedOnBoardCopy = from === named.path ? git : workerRepoGit;
  // ADR 0411 決定1・5: 複製は閉包の全部を受け取る —— 完了の門と同じ strict な fsck(warning も拒む)を受け取るときに当て、門で checkout の故障に
  // なる object を名前の場所の側で止める
  try {
    boundedOnBoardCopy(path, "-c", "core.logAllRefUpdates=false", ...STRICT_FETCH, "fetch", ...FETCH_FLAGS, "--update-head-ok", from, `${source}:refs/heads/${branch}`);
  } catch (cause) {
    throw fetchFailure ? fetchFailure(cause) : cause;
  }
  git(path, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  boundedOnBoardCopy(path, "read-tree", "-u", "--reset", "HEAD");
  return path;
}

/** ADR 0411 決定1・5 と追記: 名前の場所から閉包を受け取る fetch の strict な検査(fsck の warning も拒む)—— 完了の門と同じ検査を受け取るときに当てる。 */
const STRICT_FETCH = ["-c", "fetch.fsckObjects=true"] as const;

/** ADR 0411 決定3・5: 名前の場所の `what`(branch の名前)の閉包を受け取れない —— 名前の場所の側の拒否。`made` は作れなかったもの。shallow は
 *  その文のまま(`git fetch --unshallow` を言う)。 */
const namedClosureUnreadable = (named: WorkspaceConfig, what: string, made: string, cause: unknown) =>
  hostFailure(cause) ??
  new NamedPlaceFetchError(
    `workspace ${named.name}: ${cause instanceof ShallowRepositoryError ? cause.message : `${what} in the named workspace does not read whole, so the board cannot make ${made} from it: ${gitFailureText(cause)}`}`,
    { cause },
  );

/** 検査の間だけ disk にある checkout。`remove` は検査のどの出口でも呼ぶ。 */
type ThrowawayCheckout = { path: string; remove: () => void };

/** ADR 0379 決定2: 封じ込めの検査が列挙させる使い捨ての checkout —— task の checkout と同じ作り手で、同じ基点の下に、閉包を全部持つ複製で
 *  作る(ADR 0411 決定7)。名前の場所には何も書かない。`from` は `source` を引く repo(既定は名前の場所)。作れなければ作りかけを残さず投げる ——
 *  名前の場所にある `source` の閉包を受け取れない fetch は名前の場所の側(ADR 0411 追記、pickup と同じ)、名前の場所に無い `source` は素のまま。 */
function openThrowawayCheckout(named: WorkspaceConfig, base: string, source: string, from?: string): ThrowawayCheckout {
  const at = CHECKOUT_LAYOUT.containmentCheck.at(base);
  const remove = () => removeBoardCheckout(at, CHECKOUT_LAYOUT.containmentCheck.parents);
  const branch = protectedBranch(named);
  try {
    const fetchFailure = (cause: unknown) =>
      gitAnswers(() => git(named.path, "rev-parse", "--verify", "--quiet", source)) ? namedClosureUnreadable(named, branch, `the throwaway checkout of ${branch}`, cause) : cause;
    return { path: makeCheckout({ at, named, from, source, branch, description: `the throwaway checkout of ${branch}`, ...(from === undefined && { fetchFailure }) }), remove };
  } catch (err) {
    try {
      remove();
    } catch {
      // 作れなかった理由を消さない
    }
    throw err;
  }
}

/** 開いた使い捨ての checkout を `use` に渡し、どの出口でも消す。 */
async function inThrowawayCheckout<T>({ path, remove }: ThrowawayCheckout, use: (path: string) => Promise<T>): Promise<T> {
  try {
    return await use(path);
  } finally {
    remove();
  }
}

/** ADR 0379 決定1〜3: 保護ブランチの tip の使い捨ての checkout で `use` を走らせる。 */
export const withProtectedTipCheckout = <T>(named: WorkspaceConfig, base: string, use: (path: string) => Promise<T>): Promise<T> =>
  inThrowawayCheckout(openThrowawayCheckout(named, base, exactProtectedBranchRef(named)), use);

/** ADR 0356 決定2: pickup ごとに task の checkout を作る。番地は基点 + task id + pickup の event id(ADR 0353 と同じ鍵)なので、
 *  前の session が残した checkout は動かさず再利用もしない。どの type でもタスクブランチだけを引いた複製で、閉包を全部持つ(ADR 0411 決定1)
 *  —— Interview の役は兄弟の答案を見ない。閉包が読めない名前の場所では fetch が落ち、呼び手の quarantine へ(ADR 0411 決定5)。root の番地は面接室
 *  (基点 + root id)の外 —— 面接室の内側に checkout を置かない(ADR 0276 決定1)。開いた event は repo ができた後に書く(ADR 0329)。
 *  ADR 0414 決定1・2・6: どの役でも task の checkout と読み専用の checkout を全部作ってから固定(`fixing.fix`)を書き、作れないか固定が
 *  落ちればこの呼び出しが作った checkout を全部消す。 */
function openTaskCheckout(
  db: Db,
  named: WorkspaceConfig,
  task: Task,
  workspacesBaseDir: string,
  now: Date,
  fixing: { fix: (forkSource: string | undefined) => void; defaultWorkspaceName: string | undefined; realEnvironment: WorkspaceConfig | undefined },
): void {
  const pickup = latestEventOfTask(db, task.id, "task_picked_up");
  if (!pickup) throw new Error(`task ${task.id} has no pickup to key its task checkout`);
  const role = interviewRole(db, task);
  const at = CHECKOUT_LAYOUT.task.at(workspacesBaseDir, role === "root" ? `${task.id}.checkout` : task.id, pickup.id);
  const branch = taskBranch(task.id);
  const description = `the task checkout of ${task.id}`;
  // 面接室が提供するものの閉包は pickup の門の (task, 面接室) の項が先に確かめている。門の後に面接室から fetch する・tree を展開するのに
  // 落ちたら、この checkout でも下の読み専用の checkout でも、fetch 元の面接室の性質としてその task の項の文で面接室の名前で止まる
  // (ADR 0386 決定3 / ADR 0276 決定3)
  const itemOf = (room: WorkspaceConfig) => taskRoomPickupPredicates(db, [task], room.name, workspacesBaseDir)[0]?.describe;
  // ADR 0414 決定1・2・6: 複製(task の checkout と読み専用の checkout 全部)を先に作り、通ってから固定を書く —— 固定が書く `task/<id>` は
  // checkout が受け取った commit。解けない切る元は番地を作る前に `roomForkSource` の文のまま投げる(決定7)
  const { source, forkSource } = role === undefined ? copySourceBeforeFixing(db, named, task, () => now, fixing.defaultWorkspaceName) : roomCopySource(db, named, task);
  const real = fixing.realEnvironment && restingReadSource(db, fixing.realEnvironment);
  const readCopies = roomsReadBy(db, task).map((room) => ({ room, at: CHECKOUT_LAYOUT.read.at(workspacesBaseDir, task.id, pickup.id, room.name) }));
  const copies = [{ at, parents: CHECKOUT_LAYOUT.task.parents }, ...readCopies.map((copy) => ({ at: copy.at, parents: CHECKOUT_LAYOUT.read.parents }))];
  let path: string;
  let reads: ReadCheckout[];
  let realEnvironment: ReadCheckout | undefined;
  try {
    try {
      path = makeCheckout({ at, named, source, branch, description });
    } catch (err) {
      // 番地を作れないのは host 側の失敗のまま(ADR 0356 決定2)。面接室の外の fetch の失敗は名前の場所の側で、呼び手が今までどおり
      // 名前の場所の Quarantine にする(ADR 0411 決定5 / ADR 0414 決定5)
      if (role === undefined || err instanceof CheckoutHostError) throw err;
      throw PickupGateError.of(named, err, itemOf(named));
    }
    // 読み手の出題の head も面接室が提供する答え(ADR 0386 決定1)—— 出題前は無い
    reads = readCopies.map(({ room, at: readAt }) => {
      const read = roomProvisionOf(db, task, room.name);
      return openReadCheckout(readAt, room, read && providedRev(room, read), task.id, { kind: "room" }, itemOf(room));
    });
    if (real) {
      const realAt = CHECKOUT_LAYOUT.realEnvironment.at(workspacesBaseDir, task.id, pickup.id);
      realEnvironment = openReadCheckout(realAt, real.place, real.head, task.id, { kind: "workspace", copies }, real.describe);
    }
    fixing.fix(forkSource);
  } catch (err) {
    // 作りかけも番地で消す(読み専用の checkout は fetch の前に番地を作る)
    for (const copy of copies) {
      try {
        removeBoardCheckout(copy.at, copy.parents);
      } catch {
        // 作れなかった理由を消さない
      }
    }
    throw err;
  }
  appendEvent(db, {
    taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", at: now,
    payload: {
      kind: "task_checkout_opened", path,
      ...(completionTreeGateApplies(task) && { completion_gate: "recorded_tip" as const }),
      ...(reads.length > 0 && { reads }),
      ...(realEnvironment && { real_environment: realEnvironment }),
    },
  });
}

/** ADR 0426 決定1: 追従後の基準で休止位置の値を確かめ、ref が後から動いても同じ commit を fetch する。 */
function restingReadSource(db: Db, place: WorkspaceConfig): { place: WorkspaceConfig; head: string; describe: string } {
  const describe = `the protected branch \`${protectedBranch(place)}\` and its whole history can be fetched and checked out from the resting workspace.`;
  try {
    assertNotShallow(place.path);
    const ref = exactProtectedBranchRef(place);
    let revision = ref;
    if (holdsBaseline(db, place.name)) {
      const refs = compareAndFoldBaseline(db, place, "after parking for the Interview checkout");
      const value = refs.get(ref) ?? "";
      const target = symrefTarget(value);
      revision = target === undefined ? value : (refs.get(target) ?? "");
      if (!revision) throw new Error(`workspace ${place.name}: ${ref} does not resolve at the resting position`);
    }
    const head = gitWithoutHistoryOverrides(place.path, "rev-parse", "--verify", `${revision}^{commit}`);
    return { place, head, describe };
  } catch (err) {
    throw PickupGateError.of(place, err, describe);
  }
}

/** 読み専用の checkout —— 面接室の出題の head(ADR 0361 決定1)か、実環境の休止位置の head(ADR 0426 決定1・2)だけを fetch した複製。
 *  番地を作れないのは host 側の失敗。fetch・展開の失敗は fetch 元の性質として項の文 `describe` で包む(ADR 0386 決定3)。 */
function openReadCheckout(
  at: string, place: WorkspaceConfig, head: string | undefined, taskId: string,
  read: { kind: "room" } | { kind: "workspace"; copies: Array<{ at: string; parents: number }> }, describe: string | undefined,
): ReadCheckout {
  const real = read.kind === "workspace";
  let path: string;
  try {
    if (real) {
      // 基点の symlink は解く。盤面が checkout 用に足した段は、既存の別の場所を開かないようにする。
      const key = dirname(at);
      const parent = join(realpathSync(dirname(key)), basename(key));
      mkdirSync(parent, { recursive: true });
      if (!lstatSync(parent).isDirectory()) throw new Error(`${parent} must be a directory and may not be a symbolic link`);
      path = join(parent, basename(at));
      // ADR 0426 決定2: この pickup が作った空の checkout だけを開き、失敗時に消す。
      mkdirSync(path);
      read.copies.push({ at: path, parents: CHECKOUT_LAYOUT.realEnvironment.parents });
    } else {
      mkdirSync(at, { recursive: true });
      path = realpathSync(at);
    }
    git(path, "init", "--quiet", "--template=", "--initial-branch=main");
  } catch (cause) {
    const source = real ? "real environment" : "interview room";
    throw new CheckoutHostError(`the read checkout of the ${source} ${place.name} for ${taskId} cannot be created: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (head !== undefined) {
    try {
      // 未生の main へ直接 fetch するので --update-head-ok。reflog にも面接室の在り処を残さない(ADR 0276 決定1 と同じ)
      // ADR 0426 決定1: 実環境の休止位置と閉包だけを運び、tag は追従しない。
      git(path, "-c", "core.logAllRefUpdates=false", ...(real ? STRICT_FETCH : []), "fetch", ...FETCH_FLAGS, ...(real ? ["--no-tags"] : []), "--update-head-ok", place.path, `${head}:refs/heads/main`);
      git(path, "read-tree", "-u", "--reset", "HEAD");
    } catch (err) {
      throw PickupGateError.of(place, err, describe);
    }
  }
  return { name: place.name, path };
}

/** ADR 0365 決定2: 出題の写しの tree が面接室の保護ブランチの head から gitlink を足す・進める —— 文は verb の側で書く。 */
export class RoomCopyGitlinkError extends Error {
  constructor(readonly paths: string[]) {
    super(`the probe's environment adds or advances a submodule (gitlink): ${paths.join(", ")}`);
  }
}

/** ADR 0433 決定4: 盤面が名前の場所の状態を観測して投げる失敗 —— 名前の場所を直せば通る。fetch の失敗(`NamedPlaceFetchError`)の読み手は
 *  子の型だけを読む: 文の整形と拒否が違う。 */
export class NamedPlaceSideError extends Error {}

/** ADR 0364 決定2 / ADR 0411 決定3: 盤面所有の写しから名前の場所へ tip を fetch する段と、検証済みの写しで名前の場所の値と比べる段の失敗 ——
 *  名前の場所の側(解放なら quarantine、verb は資源の停止を登録せず回収する、ADR 0424 決定2・3)。 */
export class NamedPlaceFetchError extends NamedPlaceSideError {}

/** ADR 0411 決定2・3: 作業台の tip の検証を通った写し(名前の場所の objects を借りる、`judgeWorkbench`)で名前の場所の値と比べる手 `compare` を
 *  撃つ —— 終了コードのある git の道具の失敗は名前の場所の側、ほか(上限超過・host の失敗・起動できない git・型のある失敗)はそのまま。 */
function comparedWithNamedPlace<T>(named: WorkspaceConfig, compare: () => T): T {
  try {
    return compare();
  } catch (cause) {
    // 起動できなかった・cwd が無い git(終了コードが無い)は包まない
    if (!(cause instanceof GitToolError) || typeof cause.status !== "number") throw cause;
    throw new NamedPlaceFetchError(`workspace ${named.name}: the board cannot compare the workbench's tip with the named workspace: ${cause.message}`, { cause });
  }
}

/** 盤面が信じない checkout(task の checkout と作業台)を文の主語で名指す —— 主語は呼び手が決める。 */
type UntrustedSubject = { checkout: string; noun: string };

const unreadable = ({ checkout, noun }: UntrustedSubject, why: string, cause?: unknown) =>
  new CheckoutUnreadableError(`${noun} at ${checkout} cannot be read: ${why}`, cause === undefined ? undefined : { cause });

/** 盤面が信じない `.git` を読む1つの有界の段: 読む checkout とその主語、段全体の上限の時刻(ADR 0364 決定3 / ADR 0357 決定1)。 */
type UntrustedRead = UntrustedSubject & { deadline: number };

const untrustedRead = ({ path, noun }: Pick<UntrustedCheckout, "path" | "noun">): UntrustedRead => ({ checkout: path, noun, deadline: Date.now() + WORKER_TREE_GIT_TIMEOUT_MS });

function assertBeforeDeadline({ deadline }: UntrustedRead): void {
  if (Date.now() > deadline) throw new WorkerGitCopyTimeoutError(WORKER_TREE_GIT_TIMEOUT_MS);
}

/** ADR 0364 決定1: worker の `.git` の `rel` を lstat し、あれば `kind` であることを確かめる(symlink を辿らない)。 */
function untrustedEntry(read: UntrustedRead, rel: string, kind: "directory" | "regular file"): boolean {
  const stat = lstatSync(join(read.checkout, rel), { throwIfNoEntry: false });
  if (stat && !(kind === "directory" ? stat.isDirectory() : stat.isFile())) throw unreadable(read, `${rel} is not a ${kind}`);
  return stat !== undefined;
}

const WORKER_FILE_CHUNK = 1 << 16;

/** ADR 0364 決定1・3: lstat で regular と確かめた file を symlink を辿らずに開き(FIFO は open しない)、段の上限の時刻まで chunk ごとに
 *  読む —— sparse file はサイズでなく時間で縛り、空の file の数でも上限を越えない。Linux では開いた実体が checkout の下にあることも
 *  確かめる: 途中の dir の lstat と open の間に symlink へ差し替えられても辿った先を読まない(盤面が worker を拾う host は Linux だけ、
 *  ADR 0100 決定6)。`use` が false で読み止める。 */
function readUntrustedFile(read: UntrustedRead, rel: string, use: (chunk: Buffer) => boolean | void): void {
  const { checkout } = read;
  assertBeforeDeadline(read);
  if (!untrustedEntry(read, rel, "regular file")) throw unreadable(read, `${rel} is missing`);
  const fd = openSync(join(checkout, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw unreadable(read, `${rel} is not a regular file`);
    if (process.platform === "linux" && !readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${checkout}/`)) throw unreadable(read, `${rel} resolves outside ${read.noun}`);
    const buffer = Buffer.allocUnsafe(WORKER_FILE_CHUNK);
    for (let n = readSync(fd, buffer); n > 0; n = readSync(fd, buffer)) {
      if (use(buffer.subarray(0, n)) === false) return;
      assertBeforeDeadline(read);
    }
  } finally {
    closeSync(fd);
  }
}

/** worker の text file の行のうち `pick` が値を返す最初のもの。行の長さは縛る —— 改行の無い sparse file でメモリを埋めない。 */
function findUntrustedLine(read: UntrustedRead, rel: string, pick: (line: string) => string | undefined): string | undefined {
  let rest = "";
  let found: string | undefined;
  readUntrustedFile(read, rel, (chunk) => {
    const lines = (rest + chunk.toString("latin1")).split("\n");
    rest = lines.pop()!;
    found = lines.map(pick).find((hit) => hit !== undefined);
    if (rest.length > WORKER_FILE_CHUNK) throw unreadable(read, `${rel} has a line longer than ${WORKER_FILE_CHUNK} bytes`);
    return found === undefined;
  });
  return found ?? pick(rest);
}

/** 写す段の失敗は信じない checkout(task の checkout か作業台)の故障に包む。上限超過と host の失敗は型のまま(ADR 0357 決定2 / ADR 0364 決定2)
 *  —— disk が満ちた git は写しの host の失敗の文で包み直す(ADR 0433 決定5)。 */
function asUntrustedFailure(subject: UntrustedSubject, cause: unknown): Error {
  if (cause instanceof GitOutOfSpaceError) return copyHostError(subject.noun, cause);
  if (cause instanceof CheckoutUnreadableError || cause instanceof WorkerTreeGitTimeoutError || cause instanceof CheckoutHostError) return cause;
  return unreadable(subject, cause instanceof Error ? cause.message : String(cause), cause);
}

/** 読んだ checkout に branch が無い —— 作業台では作りかけ(ADR 0382 決定6)。 */
class BranchMissingError extends CheckoutUnreadableError {}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** ADR 0243 決定1: 書く前に値を知る。ADR 0364 決定1: tip は `refs/heads/task/<id>`(作業台なら書く先と同じ名前の branch、ADR 0371 決定1・4)の
 *  file、無ければ `packed-refs` の行(worker の `gc` は正当に pack する)—— git に worker の `.git` を開かせない。symref は worker の
 *  repo の故障。読んだ ref も返す —— 呼び手が同じ綴りを作り直さない。 */
function readUntrustedTip(read: UntrustedRead, branch: string): { sha: string; ref: string } {
  const { checkout } = read;
  const ref = `refs/heads/${branch}`;
  let sha: string | undefined;
  try {
    const dotGit = lstatSync(join(checkout, ".git"), { throwIfNoEntry: false });
    if (!dotGit) throw new CheckoutUnreadableError(`${read.noun} at ${checkout} has no git repository`);
    if (!dotGit.isDirectory()) throw unreadable(read, ".git is not a directory");
    // ADR 0364 決定1: packed-refs もリポジトリ定義の一部 —— loose の ref があっても種類を確かめる
    const packed = untrustedEntry(read, ".git/packed-refs", "regular file");
    const parents = ref.split("/").slice(0, -1).map((_, i, parts) => `.git/${parts.slice(0, i + 1).join("/")}`);
    if (parents.every((dir) => untrustedEntry(read, dir, "directory")) && untrustedEntry(read, `.git/${ref}`, "regular file")) {
      sha = findUntrustedLine(read, `.git/${ref}`, (line) => line);
      if (!OID.test(sha ?? "")) throw unreadable(read, `${ref} is not a direct ref`);
    } else if (packed) {
      sha = findUntrustedLine(read, ".git/packed-refs", (line) => {
        const [oid, name] = line.split(" ");
        return name === ref && OID.test(oid ?? "") ? oid : undefined;
      });
    }
  } catch (cause) {
    throw asUntrustedFailure(read, cause);
  }
  if (!sha) throw new BranchMissingError(`${read.noun} at ${checkout} has no branch ${branch}`);
  return { sha, ref };
}

/** 写しの tmp に書けない —— worker でも名前の場所でもない host の失敗(ADR 0364 決定2、pickup と同じ線)。 */
const copyHostError = (noun: string, cause: unknown) =>
  new CheckoutHostError(`the board cannot make its copy of ${noun}'s git files: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });

function hostStep<T>(noun: string, step: () => T): T {
  try {
    return step();
  } catch (cause) {
    throw copyHostError(noun, cause);
  }
}

const ZERO_CHUNK = Buffer.alloc(WORKER_FILE_CHUNK);

/** checkout の `rel` の byte を写しの `to` へ。hardlink は inode を worker と共有するので使わない(ADR 0364 決定1)。0 だけの chunk は
 *  書かずに穴にする —— byte は同じで、sparse file が tmp を実体で埋めない(`core.compression=0` の pack は正当に 0 の連なりを持つ)。 */
function copyUntrustedFile(read: UntrustedRead, rel: string, to: string): void {
  const out = hostStep(read.noun, () => openSync(to, "wx"));
  try {
    let position = 0;
    readUntrustedFile(read, rel, (chunk) => {
      if (!chunk.equals(ZERO_CHUNK.subarray(0, chunk.length))) hostStep(read.noun, () => writeSync(out, chunk, 0, chunk.length, position));
      position += chunk.length;
    });
    hostStep(read.noun, () => ftruncateSync(out, position));
  } finally {
    closeSync(out);
  }
}

/** `from` の `objects`(行ごとの object)を `to` の objects/pack に1つの pack にして `to` で `index-pack --strict` し、pack の path(拡張子なし)を返す。 */
function packAndIndex(deadline: number, from: string, to: string, objects: string): string {
  const packBase = join(to, "objects", "pack", "pack");
  const pack = `${packBase}-${workerRepoGitUntil(deadline, from, ["pack-objects", "--quiet", packBase], objects && `${objects}\n`)}`;
  // pack-objects の idx は `from` の loose の名前(worker が付けたもの)を信じる —— 捨てて中身から作り直す
  for (const derived of [".idx", ".rev"]) rmSync(`${pack}${derived}`, { force: true });
  workerRepoGitUntil(deadline, to, ["index-pack", "--strict", `${pack}.pack`]);
  return pack;
}

/** 写して検証する段(ADR 0364 決定1): checkout の loose と `.pack` だけを `raw` へ写し(`.idx` は作り直す、`info/alternates` は辿らない)、
 *  tip の閉包を1つの pack にして `verified` で `index-pack --strict` する —— 欠けは rev-list / pack-objects が、zlib の破損は
 *  pack-objects が、中身と名前の不一致は worker の byte を持たない `verified` の検査が落とす。ref は `verified` にだけ書く。git も file の写しも段の1つの上限の中(決定3)。 */
function copyAndVerifyUntrustedTip(read: UntrustedRead, raw: string, verified: string, sha: string, ref: string, format: string): void {
  const { checkout, deadline } = read;
  const looseName = new RegExp(`^[0-9a-f]{${format === "sha256" ? 62 : 38}}$`);
  try {
    if (untrustedEntry(read, ".git/objects", "directory")) {
      for (const dir of readdirSync(join(checkout, ".git", "objects")).filter((name) => /^[0-9a-f]{2}$/.test(name))) {
        untrustedEntry(read, `.git/objects/${dir}`, "directory");
        hostStep(read.noun, () => mkdirSync(join(raw, "objects", dir)));
        for (const file of readdirSync(join(checkout, ".git", "objects", dir)).filter((name) => looseName.test(name))) {
          copyUntrustedFile(read, `.git/objects/${dir}/${file}`, join(raw, "objects", dir, file));
        }
      }
      if (untrustedEntry(read, ".git/objects/pack", "directory")) {
        for (const file of readdirSync(join(checkout, ".git", "objects", "pack")).filter((name) => name.endsWith(".pack"))) {
          copyUntrustedFile(read, `.git/objects/pack/${file}`, join(raw, "objects", "pack", file));
          workerRepoGitUntil(deadline, raw, ["index-pack", join(raw, "objects", "pack", file)]);
        }
      }
    }
    // ADR 0411 決定1・2: task の checkout も作業台も閉包が全部写しの中で解けること —— 受験者が sha を言い当てても兄弟の答案は記録に入らない
    const objects = workerRepoGitUntil(deadline, raw, ["rev-list", "--objects", sha]);
    packAndIndex(deadline, raw, verified, objects);
    workerRepoGitUntil(deadline, verified, ["update-ref", ref, sha]);
  } catch (cause) {
    const failure = asUntrustedFailure(read, cause);
    throw failure !== cause && outOfSpace(raw, cause) ? copyHostError(read.noun, cause) : failure;
  }
}

/** 盤面が git を撃たずに tip を読む checkout —— task の checkout(ADR 0364 決定1)と作業台(ADR 0371 決定4)。在り処、作った元の
 *  名前の場所、文の主語。どちらも名前の場所の objects を借りない(ADR 0411 決定1・2)。 */
type UntrustedCheckout = { path: string; namedPlace: WorkspaceConfig; noun: string };

const TASK_CHECKOUT = "the task checkout";

/** task の checkout を、主語を添えて信じない checkout として。 */
const untrustedTaskCheckout = (place: TaskCheckoutPlace): UntrustedCheckout => ({ ...place, noun: TASK_CHECKOUT });

/** 盤面所有の使い捨ての bare repo を `repo` に作り、objects を `borrowed` の順に借りる。 */
function initBoardCopy(repo: string, format: string, borrowed: string[] = []): void {
  git(dirname(repo), "init", "--bare", "--quiet", "--template=", `--object-format=${format}`, repo);
  if (borrowed.length > 0) borrowObjects(repo, borrowed);
}

/** 盤面所有の bare repo `repo` に objects を `borrowed` の順に借りさせる。 */
const borrowObjects = (repo: string, borrowed: string[]) => writeFileSync(join(repo, "objects", "info", "alternates"), `${borrowed.join("\n")}\n`);

/** ADR 0412 決定2 / ADR 0423 決定4: stage と commit の後、親を辿る fetch のために検証済みの写し `verified` に
 *  名前の場所の objects を借りさせる。objects を引けなければ素の失敗(名前の場所の側)、alternates を書けなければ host の失敗。 */
function borrowNamedAfterStage(verified: string, named: WorkspaceConfig): void {
  const objects = namedObjects(named);
  stagingHostStep(() => borrowObjects(verified, [objects]));
}

/** 信じない checkout の tip を検証済みの写しに読んだもの: tip、写し(`verified`)、写しの ref、checkout の自前の object の写し(`own` ——
 *  運んだ後の確かめが数え、入れ直しがそこから組む、ADR 0388 決定1・2)。 */
type VerifiedTip = { tip: string; verified: string; tipRef: string; own: string };

/** ADR 0364 決定1・2: checkout の `branch` の tip を検証済みの盤面所有の repo として開く。 */
function withVerifiedUntrustedTip<T>(place: UntrustedCheckout, branch: string, use: (read: VerifiedTip) => T): T {
  const { namedPlace } = place;
  // 名前の場所の側の故障を worker の repo のせいにしない —— ここで落ちれば素の失敗(呼び手の quarantine)
  const format = git(namedPlace.path, "rev-parse", "--show-object-format");
  // ADR 0364 決定3: tip の読みから閉包の検証までが1つの有界の段
  const read = untrustedRead(place);
  const { sha, ref } = readUntrustedTip(read, branch);
  // ADR 0364 決定1: 写しは盤面 process の tmp —— worker は書けない(task temp でも checkout の中でもない)
  const dir = hostStep(place.noun, () => mkdtempSync(join(tmpdir(), "tidepool-untrusted-tip-")));
  try {
    const [raw, verified] = [join(dir, "raw"), join(dir, "verified")];
    for (const repo of [raw, verified]) hostStep(place.noun, () => initBoardCopy(repo, format));
    copyAndVerifyUntrustedTip(read, raw, verified, sha, ref, format);
    return use({ tip: sha, verified, tipRef: ref, own: raw });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 信じない checkout を確かめの文の主語として。 */
const subjectOf = ({ path, noun }: Pick<UntrustedCheckout, "path" | "noun">): UntrustedSubject => ({ checkout: path, noun });

/** ADR 0417 決定1: worker の tip の他の task の検査 —— 作業台の入口の `EntryChecks.otherTasks` と同じく省略できない。拒否文でなく、当たったときの
 *  扱い `refuse`(他の task のブランチと tip を受けて投げる)と、数える task の範囲を持つ。 */
type WorkerTipOtherTasks = { range: TaskRange; refuse: (branches: string[], tip: string) => never };

/** worker の tip を受ける唯一の口: task の checkout の `task/<id>` の tip を、ref を書かずに名前の場所の objects へ引き、他の task のブランチの
 *  commit を持てば `otherTasks.refuse` で投げ、持たなければ検証済みの写しを開いたまま `use` に渡す。ADR 0417 決定2: 数えないのは `current`
 *  (`task/<id>` の今の値)と、保護ブランチ・帰り先の今の値にある commit。数える場所は運び終えた名前の場所 —— 検証済みの写しに名前の場所の
 *  objects を借りさせない(ADR 0412 決定2)。数える手の失敗は、上限超過を除いて名前の場所の側。 */
function receiveWorkerTip<T>(db: Db, place: TaskCheckoutPlace, task: Task, current: string, otherTasks: WorkerTipOtherTasks, use: (read: VerifiedTip) => T): T {
  const checkout = untrustedTaskCheckout(place);
  const { namedPlace } = place;
  return withVerifiedUntrustedTip(checkout, taskBranch(task.id), (read) => {
    const { tip, verified, tipRef, own } = read;
    carryIntoNamed(namedPlace, subjectOf(checkout), { source: verified, ref: tipRef, own, tip, description: "the task branch tip" });
    // #3824 の spec: 帰り先は系譜の解決(`lineageTaskBranch`)が答えるブランチの値。無い・読めなければ足さない —— 数える側に倒れる
    const returnValue = () => {
      try {
        const lineage = lineageTaskBranch(db, namedPlace, task, exactProtectedBranchRef(namedPlace));
        return lineage && git(namedPlace.path, "rev-parse", "--verify", `refs/heads/${lineage}`);
      } catch {
        return undefined;
      }
    };
    let branches: string[];
    try {
      const excluded = [current, ...taskWriteExcluded(namedPlace, returnValue)].filter(Boolean);
      branches = otherTaskBranches(db, namedPlace, namedPlace.path, tip, excluded, otherTasks.range);
    } catch (cause) {
      // ADR 0357 決定2: worker の tip を辿る有界の rev-list の上限超過は worker の repo の故障
      if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
      const why = cause instanceof Error ? cause.message : String(cause);
      throw hostFailure(cause) ?? new NamedPlaceFetchError(`workspace ${namedPlace.name}: the board cannot count other tasks' commits in the task branch tip ${tip}: ${why}`, { cause });
    }
    if (branches.length > 0) otherTasks.refuse(branches, tip);
    return use(read);
  });
}

/** 運んだ場所の自前の object の盤面所有の写し `own`、運んだ `tip`、文の名前。`borrowing` は名前の場所の objects を借りる写し(`own` か、その
 *  借りる先)で、確かめはその借りを外して数える —— 写しは使い捨てで、`own` の dir には書いてよい。`staged` は staging repo が書いた commit
 *  (退避の WIP と出題の写し)で、集合はその commit と tree の閉包 —— 運ぶ commit が名前の場所に既にあっても数え、親の履歴は辿らない(ADR 0425 決定2)。
 *  staging repo は commit を名前の場所を借りる前に自分で書く(`commitStagedTree` → `borrowNamedAfterStage`)ので、commit は自前にある。 */
type CarriedCopy = { own: string; tip: string; description: string; borrowing?: string; staged?: boolean };

/** 名前の場所へ運ぶ1つの段の入力: 引く元の盤面所有の repo `source` とその `ref`、確かめる写し。 */
type Carry = CarriedCopy & { source: string; ref: string };

/** ADR 0425 決定1〜4: 名前の場所へ運ぶ唯一の段 —— 門の取り込み、退避の tip と WIP、作業台の取り込み、出題の写しがここを通る。fetch が名前の場所の
 *  側で落ちれば(上限超過は worker の故障、ADR 0357 決定2 / ADR 0423 決定4。host の失敗は段ごとの host の線、ADR 0433 決定5 / ADR 0441 決定1 ——
 *  どちらも入れ直さない)、集合のうち名前の場所で読めない写しを入れ直してから1度だけ撃ち
 *  直す —— 運ぶ手が読む tree・commit の損傷で入れ直しの前に落ちない。撃ち直しも落ちれば今どおり運ぶ段の失敗。運んだ後の確かめは今どおり1回。 */
function carryIntoNamed(named: WorkspaceConfig, from: UntrustedSubject, { source, ref, ...copy }: Carry): void {
  const fetch = () => fetchFromBoardCopy(named, source, ref, copy.tip, copy.description);
  try {
    fetch();
  } catch (first) {
    if (!(first instanceof NamedPlaceFetchError) || !reinsertDamaged(named, from, copy, first)) throw first;
    try {
      fetch();
    } catch (second) {
      if (!(second instanceof NamedPlaceFetchError)) throw second;
      throw new NamedPlaceFetchError(`${endSentence(second.message)} Before the board reinserted what did not read whole there: ${first.message}`, { cause: second });
    }
  }
  ensureCarriedWhole(named, from, copy);
}

/** 運ぶ段の失敗 —— `tip` が名前の場所で読めない。 */
const notWhole = (named: WorkspaceConfig, { tip, description }: CarriedCopy, why: string, cause?: unknown) =>
  hostFailure(cause) ?? new NamedPlaceFetchError(`workspace ${named.name}: ${description} ${tip} does not read whole in the named workspace: ${why}`, cause === undefined ? undefined : { cause });

/** 名前の場所で集合を読む用意: 集合の id、名前の場所の objects、pack を先に読む repo(`reader`)と loose の dir だけを見せる repo(`probe`)、
 *  その repo で `asked` を pack に組み中身が名前と合わない id を返す手。 */
type CarriedReading = { ids: string[]; objects: string; format: string; reader: string; probe: string; misnamedIn: (repo: string, asked: string[]) => string[] };

/** ADR 0388 決定1 / ADR 0398 決定1: `borrowing` の借りを外して `own` の集合を数え、名前の場所を読む使い捨ての repo を組む。repo は呼ぶたびに
 *  新しい dir に組む —— 1つの運びで2回読む(fetch が落ちた後と運んだ後)。段ごとに帰責する(ADR 0364 決定2): 写しを数える手の失敗は `from`
 *  の故障、写しの tmp の失敗は host の失敗。集合が空なら undefined。 */
function readCarried(named: WorkspaceConfig, from: UntrustedSubject, copy: CarriedCopy): CarriedReading | undefined {
  const { own, tip, borrowing = own, staged } = copy;
  hostStep(from.noun, () => rmSync(join(borrowing, "objects", "info", "alternates"), { force: true }));
  let listed: string;
  try {
    listed = workerRepoGit(own, "rev-list", "--objects", "--missing=print", ...(staged ? ["--no-walk", tip] : [tip]));
  } catch (cause) {
    // `own` は worker が書いた byte の写し —— 辿れなければ worker の repo の故障(上限超過も、ADR 0357 決定2)
    throw asUntrustedFailure(from, cause);
  }
  const ids = listed.split("\n").filter((line) => line && !line.startsWith("?")).map((line) => line.split(" ")[0]!);
  if (ids.length === 0) return undefined;
  let objects: string;
  let format: string;
  try {
    objects = namedObjects(named);
    format = git(named.path, "rev-parse", "--show-object-format");
  } catch (cause) {
    throw notWhole(named, copy, cause instanceof Error ? cause.message : String(cause), cause);
  }
  const dir = hostStep(from.noun, () => mkdtempSync(join(own, "named-")));
  // pack-objects は一時 file を撃った repo の objects/pack に書く —— 名前の場所には書かず、その objects だけを借りる使い捨ての repo で読む
  const reader = join(dir, "carried");
  // 名前の場所の loose の dir だけを見せる使い捨ての repo —— 確かめと退避が使い回す。dir への symlink なので、退避で移した loose は次の読みに見えない
  const probe = join(dir, "loose");
  // index-pack は同じ id の object を持つ repo では照合のために読み直す —— 何も持たない repo で撃つ
  const blank = join(dir, "blank");
  hostStep(from.noun, () => {
    initBoardCopy(reader, format, [objects]);
    initBoardCopy(blank, format);
    initBoardCopy(probe, format);
    for (const fanout of new Set(looseIds(objects, ids).map((id) => id.slice(0, 2)))) symlinkSync(join(objects, fanout), join(probe, "objects", fanout));
  });
  // 上限を持つ読み —— 運んだ後の確かめでは ADR 0423 決定5、fetch が落ちた後の判定では決定4(記録の byte と確かめていない集合を1度に辿る)。
  // どちらも上限超過は worker の故障で、損傷を見つけたことにはならず入れ直しに進まない
  const misnamedIn = (repo: string, asked: string[]) => misnamedObjects(Date.now() + WORKER_TREE_GIT_TIMEOUT_MS, repo, join(repo, "read"), asked, blank);
  return { ids, objects, format, reader, probe, misnamedIn };
}

/** ADR 0425 決定1 / ADR 0408 決定1: fetch が落ちた後、集合のうち名前の場所で読めない id だけ(壊れた loose、読めない pack の写し、`first` が
 *  名指す欠け)を `own` から入れ直し、その壊れた loose を退ける —— 閉包の全部の pack にはしない。fetch が落ちた後は運ぶはずの新しい object も
 *  欠けているので、欠けは fetch が名指したものだけ数える(閉包の中の欠けた祖先の commit で fetch は落ちる、作業台の取り込みで実測)—— 損傷と
 *  関係の無い失敗で worker の object を名前の場所に書かない。入れ直した id があれば true。撃ち直す fetch のために `borrowing` の借りは戻す。 */
function reinsertDamaged(named: WorkspaceConfig, from: UntrustedSubject, copy: CarriedCopy, first: NamedPlaceFetchError): boolean {
  const alternates = join(copy.borrowing ?? copy.own, "objects", "info", "alternates");
  const borrowed = hostStep(from.noun, () => (existsSync(alternates) ? readFileSync(alternates) : undefined));
  try {
    const reading = readCarried(named, from, copy);
    if (!reading) return false;
    const { ids, objects, reader, probe, misnamedIn } = reading;
    let damaged: string[];
    try {
      const loose = unreadableBy((asked) => misnamedIn(probe, asked), looseIds(objects, ids));
      const missing = missingIn(reader, ids);
      const fetchStderr = stderrOf(first.cause);
      const held = ids.filter((id) => !loose.includes(id) && !missing.has(id));
      damaged = [...loose, ...ids.filter((id) => !loose.includes(id) && missing.has(id) && fetchStderr.includes(id)), ...unreadableBy((asked) => misnamedIn(reader, asked), held)];
    } catch (cause) {
      // ADR 0423 決定4: 上限超過は worker の故障 —— 入れ直しに進まない
      if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
      if (outOfSpace(reader, cause)) throw copyHostError(from.noun, cause);
      // 読めない id を名指せなければ入れ直すものが無い —— 最初の失敗のまま
      return false;
    }
    if (damaged.length === 0) return false;
    verifyOwnObjects(from, copy.own, damaged);
    const failure = reinsertAndMoveAside(from, copy.own, reading, damaged);
    if (failure !== undefined) {
      throw hostFailure(failure) ?? new NamedPlaceFetchError(`${endSentence(first.message)} Reinserting what did not read whole there failed: ${failure instanceof Error ? failure.message : String(failure)}`, { cause: failure });
    }
    return true;
  } finally {
    if (borrowed !== undefined) hostStep(from.noun, () => writeFileSync(alternates, borrowed));
  }
}

/** ADR 0388 決定1・2 / ADR 0398 決定1 / ADR 0408 決定1: 名前の場所へ運んだ直後に、`tip` から自前の object だけをたどって届く、運んだ場所の自前の object
 *  —— `own` を名前の場所の objects を借りずに辿り、`?` の付かないもの —— が名前の場所で読めることを、名前の場所の loose を全部と git が選ぶ
 *  pack 側の写しを pack に組み、object ごとに中身の名前を照合して確かめる(`rev-list` は zlib の破損を、pack-objects は別の中身の loose を素通しする)。task の checkout も作業台も借りないので
 *  集合は tip の閉包の全部(ADR 0411 決定2・4)、staging repo の commit では commit と tree の閉包(ADR 0425 決定2)。読めなければ `own` から入れ直して確かめ直す —— fetch は commit を
 *  既に持つ場所へ何も送らない。揃わなければ運ぶ段の失敗で、読めない object を名指す。 */
function ensureCarriedWhole(named: WorkspaceConfig, from: UntrustedSubject, copy: CarriedCopy): void {
  const reading = readCarried(named, from, copy);
  if (!reading) return;
  const { ids, objects, reader, probe, misnamedIn } = reading;
  // ADR 0408 決定1: 最初の確かめと確かめ直しの1つの判定 —— 名前の場所に loose を持つ集合の id はその loose を全部、loose だけを見せる repo で
  // 読み(git 2.53 以降の blob の stream の読み手は loose を pack より先に開く)、集合の全部を pack を先に読む repo で読む。
  const unreadable = (): unknown => {
    try {
      // 退避で移した loose は数え直しで落ちる
      const loose = looseIds(objects, ids);
      let misnamed = loose.length === 0 ? [] : misnamedIn(probe, loose);
      if (misnamed.length === 0) misnamed = misnamedIn(reader, ids);
      return misnamed.length === 0 ? undefined : new MisnamedObjects(misnamed);
    } catch (cause) {
      if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
      if (outOfSpace(reader, cause)) throw copyHostError(from.noun, cause);
      return cause;
    }
  };
  const first = unreadable();
  if (first === undefined) return;
  verifyOwnObjects(from, copy.own, ids);
  const reinsertFailure = reinsertAndMoveAside(from, copy.own, reading, ids);
  const last = reinsertFailure === undefined ? unreadable() : first;
  if (last === undefined) return;
  const why = reinsertFailure === undefined ? "" : `, and reinserting it failed: ${reinsertFailure instanceof Error ? reinsertFailure.message : String(reinsertFailure)}`;
  const bad = last instanceof MisnamedObjects ? last.ids : unreadableIds(reader, ids, last);
  throw notWhole(named, copy, `${bad.join(", ") || "an object it holds"} is missing or corrupt there${why}`, reinsertFailure ?? last);
}

/** ADR 0388 決定2: `ids` を `own` から名前の場所へ入れ直し、その loose のうち読めないものを退ける。落ちた手の失敗を返す(上限超過と容量切れは投げる)。 */
function reinsertAndMoveAside(from: UntrustedSubject, own: string, { objects, format, probe, misnamedIn }: CarriedReading, ids: string[]): unknown {
  try {
    reinsertOwnObjects(objects, format, own, ids.join("\n"));
  } catch (cause) {
    // ADR 0357 決定2: 入れ直しの pack は worker の byte の写しから組む —— 上限超過は worker の repo の故障
    if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
    return cause;
  }
  try {
    moveAsideDamagedLoose(objects, (asked) => misnamedIn(probe, asked), ids);
  } catch (cause) {
    if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
    if (outOfSpace(own, cause)) throw copyHostError(from.noun, cause);
    return cause;
  }
  return undefined;
}

/** ADR 0388 決定2 / ADR 0364 決定2: 入れ直しに要る object は運んだ場所の byte の写し `own` から組む —— `own` は ADR 0364 の `index-pack --strict` を通った写しではなく、
 *  入れ直しの手は写しと名前の場所の両方を読むので、どちらの byte で落ちたかを言えない。先に写しの中だけで pack に組み(読めない byte で
 *  落ちる)、object ごとに中身の名前を照合する(別の中身を置いた名前が落ちる)。どちらも `from` の故障で、この後の入れ直しの
 *  失敗は名前の場所の側。写しの tmp の容量切れは host の失敗。 */
function verifyOwnObjects(from: UntrustedSubject, own: string, ids: string[]): void {
  let misnamed: string[];
  try {
    misnamed = misnamedObjects(Date.now() + WORKER_TREE_GIT_TIMEOUT_MS, own, join(own, "own"), ids);
  } catch (cause) {
    if (!(cause instanceof WorkerTreeGitTimeoutError) && outOfSpace(own, cause)) throw copyHostError(from.noun, cause);
    throw asUntrustedFailure(from, cause);
  }
  if (misnamed.length > 0) throw unreadable(from, new MisnamedObjects(misnamed).message);
}

/** 中身が名前と合わない object(ADR 0398 決定1)。 */
class MisnamedObjects extends Error {
  constructor(readonly ids: string[]) {
    super(`objects ${ids.join(", ")} hold contents that do not hash to their names`);
  }
}

/** `ids` を `repo` で `base` の pack に組み、中身から index し直して、中身が名前と合わない id を返す。pack-objects の idx は読んだ loose の
 *  名前を信じるので、同じ offset の頼んだ名前と中身の名前を object ごとに比べる —— 名前の集合では、入れ替わった loose も名前が揃う。index-pack は
 *  `at` で撃つ。`--strict` は付けない(繋がりは借りている object に届く。入れ替わった loose では同じ中身の entry が2つある)。 */
function misnamedObjects(deadline: number, repo: string, base: string, ids: string[], at = repo): string[] {
  const pack = `${base}-${workerRepoGitUntil(deadline, repo, ["pack-objects", "--quiet", base], `${ids.join("\n")}\n`)}`;
  try {
    renameSync(`${pack}.idx`, `${pack}.asked`);
    rmSync(`${pack}.rev`, { force: true });
    workerRepoGitUntil(deadline, at, ["index-pack", `${pack}.pack`]);
    const byOffset = (idx: string) =>
      new Map(workerRepoGitUntil(deadline, at, ["show-index"], readFileSync(idx)).split("\n").map((line) => line.split(" ", 2) as [string, string]));
    const contents = byOffset(`${pack}.idx`);
    return [...byOffset(`${pack}.asked`)].filter(([offset, id]) => contents.get(offset) !== id).map(([, id]) => id);
  } finally {
    // 同じ中身の pack は同じ名前になる —— 残った中身の idx を、次の照合が頼んだ名前として読まない
    for (const ext of [".pack", ".idx", ".asked", ".rev"]) rmSync(`${pack}${ext}`, { force: true });
  }
}

const DAMAGED_PREFIX = "tidepool-damaged-";

/** 名前の場所の `objects` での `id` の loose の path。 */
const looseOf = (objects: string, id: string) => join(objects, id.slice(0, 2), id.slice(2));

/** `ids` のうち、名前の場所の `objects` に今 loose の file を持つもの。 */
const looseIds = (objects: string, ids: string[]) => ids.filter((id) => existsSync(looseOf(objects, id)));

/** ADR 0388 決定2 / ADR 0398 決定1: 入れ直しの後、集合の id の名前の場所の loose のうち、loose として読めないものと中身が名前と合わない
 *  ものを、objects の下の残す dir へ移す(消さない —— 人間が調べられる。入れ直しの残りの掃除は触らない)。読み手には loose を pack より先に開くものがある —— git 2.56 の `cat-file -p` は小さい
 *  object の pack の stream を断り、header の読める loose の stream を開くので、body を切り詰めた loose が入れ直した pack を覆う(source の
 *  `odb/streaming.c` / `packfile.c` / `odb/source-loose.c` を読んだ。git 2.53.0 でも観測した、ADR 0408)。`readLoose` —— 名前の場所の loose の
 *  dir だけを見せる確かめの repo で pack に組み、中身が名前と合わない id を返す —— で読めない loose を移す。 */
function moveAsideDamagedLoose(objects: string, readLoose: (asked: string[]) => string[], ids: string[]): void {
  const bad = unreadableBy(readLoose, looseIds(objects, ids));
  if (bad.length === 0) return;
  const damaged = mkdtempSync(join(objects, DAMAGED_PREFIX));
  for (const id of bad) renameSync(looseOf(objects, id), join(damaged, id));
}

/** `read`(`asked` を pack に組み、中身が名前と合わない id を返す)で読めない `ids` —— `read` が落ちれば、落ちた object を stderr の id で外して
 *  組み直す(外すたびに1つ以上減るので終わる)。stderr が `ids` を名指さなければ落ちたまま投げる。 */
function unreadableBy(read: (asked: string[]) => string[], ids: string[]): string[] {
  const bad: string[] = [];
  let pending = ids;
  while (pending.length > 0) {
    try {
      return [...bad, ...read(pending)];
    } catch (cause) {
      if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
      const stderr = stderrOf(cause);
      const named = pending.filter((id) => stderr.includes(id));
      if (named.length === 0) throw cause;
      bad.push(...named);
      pending = pending.filter((id) => !named.includes(id));
    }
  }
  return bad;
}

/** `ids` のうち `reader` で `cat-file --batch-check` が missing と言うもの(欠けと zlib の破損)。 */
function missingIn(reader: string, ids: string[]): Set<string> {
  const checked = workerRepoGitUntil(Date.now() + WORKER_TREE_GIT_TIMEOUT_MS, reader, ["cat-file", "--batch-check"], `${ids.join("\n")}\n`);
  return new Set(checked.split("\n").filter((line) => line.endsWith(" missing")).map((line) => line.split(" ")[0]!));
}

/** 名前の場所で読めない object: `cat-file --batch-check` が missing と言うもの(欠けと zlib の破損)と、中身を読んで落ちた手の stderr が
 *  名指すもの(body を切り詰めた loose は header が読めて batch-check を通る)。どちらも集合の id に限る。 */
function unreadableIds(reader: string, ids: string[], failure: unknown): string[] {
  const stderr = stderrOf(failure);
  let missing = new Set<string>();
  try {
    missing = missingIn(reader, ids);
  } catch {
    // 名指せなくても拒む理由は変わらない —— stderr の id で言う
  }
  return ids.filter((id) => missing.has(id) || stderr.includes(id));
}

const REINSERT_PREFIX = "tidepool-reinsert-";

/** ADR 0388 決定2: 入れ直し —— `own` の object を pack にして名前の場所の objects に置く。pack-objects と `index-pack --strict` は名前の場所の
 *  objects の下の使い捨ての repo(借りる先は `own`、次に名前の場所)で撃つ: pack-objects の一時 file は撃った repo の objects/pack にでき
 *  (実測、git 2.47)、tmp の fs では名前の場所へ rename できない。名前の場所で index-pack を撃つと、同じ id の壊れた loose との照合が読めずに
 *  落ちる(実測)。`.idx` を最後に置く(git は `.idx` のある pack だけを読む)。 */
function reinsertOwnObjects(objects: string, format: string, own: string, ids: string): void {
  // 盤面が入れ直しの途中で落ちて残った repo を消す —— 生きている入れ直しは上限の内に終わる
  for (const name of readdirSync(objects).filter((entry) => entry.startsWith(REINSERT_PREFIX))) {
    const stale = join(objects, name);
    if (Date.now() - lstatSync(stale).mtimeMs > WORKER_TREE_GIT_TIMEOUT_MS) rmSync(stale, { recursive: true, force: true });
  }
  const incoming = mkdtempSync(join(objects, REINSERT_PREFIX));
  try {
    initBoardCopy(incoming, format, [join(own, "objects"), objects]);
    const pack = packAndIndex(Date.now() + WORKER_TREE_GIT_TIMEOUT_MS, incoming, incoming, ids);
    for (const ext of [".pack", ".rev", ".idx"]) {
      if (existsSync(`${pack}${ext}`)) renameSync(`${pack}${ext}`, join(objects, "pack", `${basename(pack)}${ext}`));
    }
  } finally {
    rmSync(incoming, { recursive: true, force: true });
  }
}

/** ADR 0364 決定2・3 / ADR 0367 決定5: worker の byte を読む fetch は、盤面所有の repo からでも有界。 */
function fetchFromBoardCopy(namedPlace: WorkspaceConfig, repo: string, ref: string, sha: string, description: string): void {
  try {
    workerRepoGit(namedPlace.path, "fetch", ...FETCH_FLAGS, repo, ref);
    git(namedPlace.path, "cat-file", "-e", `${sha}^{commit}`);
  } catch (cause) {
    // ADR 0357 決定2: 上限超過は worker の repo の故障。ADR 0433 決定5: disk が満ちた失敗は段ごとの host の線
    if (cause instanceof WorkerTreeGitTimeoutError) throw cause;
    throw hostFailure(cause) ?? new NamedPlaceFetchError(`workspace ${namedPlace.name}: ${description} ${sha} cannot be fetched into the named workspace: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** ADR 0423 決定3: 親に書く正確な object の型を名前の場所で確かめる。ls-tree や ^{tree} はタグを剥がして読む。 */
function assertRecordedParentCommit(named: WorkspaceConfig, parent: string): void {
  if (git(named.path, "--no-replace-objects", "cat-file", "-t", parent) !== "commit") {
    throw new NamedPlaceSideError(`workspace ${named.name}: recorded parent ${parent} is not a commit`);
  }
}

/** ADR 0423 決定3: 親は呼び手が名前の場所で確かめた値。commit-tree -p は親を開くので、staging repo では親を開かず commit を書く。 */
function commitStagedTree(repo: string, tree: string, parent: string, subject: string): string {
  return stagingHostStep(() => {
    // ADR 0071: 盤面の author と committer は localGitEnv が同じ名義にする。
    const ident = git(repo, "var", "GIT_AUTHOR_IDENT");
    const message = subject.endsWith("\n") ? subject : `${subject}\n`;
    const content = `tree ${tree}\nparent ${parent}\nauthor ${ident}\ncommitter ${ident}\n\n${message}`;
    const commit = workerRepoGitUntil(Date.now() + WORKER_TREE_GIT_TIMEOUT_MS, repo, ["hash-object", "-t", "commit", "-w", "--stdin"], content);
    workerRepoGit(repo, "update-ref", "--no-deref", "HEAD", commit);
    return commit;
  });
}

/** ADR 0359 決定1: worker の tip が名前の場所のタスクブランチになるまで完了の門を通さない。ADR 0412 決定4: 門の `check` は記録した tip と、
 *  同じ写しで worktree を読む view(`changedPaths`)を受ける —— 検証は1回で、view が比べる相手は記録した tip。 */
export function recordTaskCheckoutTip(db: Db, place: RunPlace, taskId: string): string;
export function recordTaskCheckoutTip<T>(db: Db, place: RunPlace, taskId: string, check: (tip: string, changedPaths: () => string[]) => T): T;
export function recordTaskCheckoutTip(db: Db, place: RunPlace, taskId: string, check?: (tip: string, changedPaths: () => string[]) => unknown): unknown {
  assertTaskCheckout(place, taskId);
  const { namedPlace } = place;
  const branch = taskBranch(taskId);
  const ref = `refs/heads/${branch}`;
  // ADR 0243 決定2 / ADR 0359 決定4: この書き込みの旧値だけを確かめ、帯域外の値を基準に取り込まない
  const old = taskRefAsRecorded(db, namedPlace, ref, "during the session");
  // ADR 0417 決定3: 他の task の commit を持つ tip は ref を書く前に拒む。`base` は書く先の今の値と tip の merge-base(session の間に
  // `task/<id>` が進んでいれば、今の値は worker の checkout に無い)
  const refuse = (branches: string[], tip: string): never => {
    const base = git(namedPlace.path, "merge-base", old, tip);
    throw new DomainError(
      branches.map((other) => `the task branch tip contains commits of ${otherTaskClause(db, other)}`).join(" ") +
        ` Rebuild the task branch with only your own commits — note their shas, \`git reset --hard ${base}\`, then \`git cherry-pick\` each of them — and call complete_task again. If your work needs that task's changes, escalate instead of copying them.`,
    );
  };
  // 比べてから worker の repo を読む —— 動いた ref を worker の repo の故障の陰に隠さない
  return receiveWorkerTip(db, place, getTask(db, taskId)!, old, { range: "every task", refuse }, (read) => {
    const { tip } = read;
    if (old !== tip) boardRefWriter(db, namedPlace)(ref, tip, () => git(namedPlace.path, "update-ref", "--no-deref", ref, tip, old));
    return check ? check(tip, () => taskCheckoutChanges(db, place, taskId, read).map(({ path }) => path)) : tip;
  });
}

/** 作業台を開く(ADR 0371 決定7・9 / ADR 0382 決定5): 鍵の作業台に人間の作業が残っていなければ(作りかけを含む)消して
 *  書く先の ref から作り直し、残っていればそのまま使う —— 開いた question は数えない。読めない作業台は消さずに `WorkbenchUnreadableError`
 *  を、ほかの失敗(上限超過を含む)は消さずにそのまま投げる。task の checkout と同じ作り手で作るので hook は無く、`updateInstead` だけを足して人間の clone からの push を受ける。
 *  人間の branch は書く先と同じ名前で checkout され、全部を展開する(sparse にしない)。開くたびに `board/*` を引き直す。`carried` が無いのは
 *  人間自身の内容の作業台。返すのは実体の綴りの在り処と、使い続ける作業台の持ち主の判定。 */
function openWorkbench(named: WorkspaceConfig, base: string, target: string, carried?: Carried): { path: string; owner: WorkbenchOwner } {
  const at = workbenchAt(named, base, target, carried);
  // 開くのは盤面の手 —— 作りかけは作り直す(ADR 0382 決定5・6)
  const owner: WorkbenchOwner = placeHasRepository(at) ? judgeOnDisk(named, at, target, carried) : { kind: "nothing" };
  if (owner.kind === "nothing") rmSync(at, { recursive: true, force: true, maxRetries: 3 });
  const made = !existsSync(at);
  const path = made ? makeWorkbench(named, at, target) : realpathSync(at);
  repointOpened(named, path, made, carried);
  return { path, owner };
}

/** disk にある作業台を盤面の手のある入口として判定する(帰責は `readingWorkbench`)。 */
function judgeOnDisk(named: WorkspaceConfig, at: string, target: string, carried?: Carried, inKey = true): WorkbenchOwner {
  return readingWorkbench(at, () => judgeWorkbench(named, workbenchPlace(named, realpathSync(at)), target, { carried, boardMove: true, inKey }, (judged) => judged));
}

/** 盤面の手のある入口が disk の作業台を読む手の帰責 —— 作業台そのものの読みの失敗だけを `WorkbenchUnreadableError` にする。上限超過・
 *  host・名前の場所の側の失敗は、開き直しで直りうるので素のまま。 */
function readingWorkbench<T>(at: string, read: () => T): T {
  try {
    return read();
  } catch (cause) {
    if (cause instanceof CheckoutUnreadableError || cause instanceof WorktreeStatusError) throw new WorkbenchUnreadableError(at, cause);
    throw cause;
  }
}

/** 開く手が既にある作業台を読めない —— 盤面は消さないので、人間が消すまで開き直しても同じ(作り直しの失敗とは直し方が違う)。 */
class WorkbenchUnreadableError extends Error {
  constructor(readonly at: string, cause: unknown) {
    super(cause instanceof WorkbenchGitError ? cause.gitMessage : cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

const workbenchPlace = (named: WorkspaceConfig, path: string): UntrustedCheckout => ({ path, namedPlace: named, noun: "the workbench" });

/** `at` の作業台が disk にあれば、実体の綴りで読む入口。無ければ undefined。 */
const workbenchOnDisk = (named: WorkspaceConfig, at: string): UntrustedCheckout | undefined => (placeHasRepository(at) ? workbenchPlace(named, realpathSync(at)) : undefined);

/** ADR 0382 決定2・6: 入口の鍵の作業台を読み、持ち主を判定する(`workbenchOwner`)。tip は ADR 0364 と同じ手で検証済みの写しに読み、
 *  `use` は判定と写しを受ける。書く先の branch が無い作業台(作りかけ)は写しを作らずに判定する —— 盤面の手のある入口(`boardMove`)では
 *  人間の作業が残っていなければ取り込むものは無く、無い入口では拒む。`carried` が無いのは人間自身の内容の作業台。 */
function judgeWorkbench<T>(
  named: WorkspaceConfig,
  place: UntrustedCheckout,
  target: string,
  { carried, boardMove, inKey = true, again }: { carried?: Carried; boardMove: boolean; inKey?: boolean; again?: string },
  use: (owner: WorkbenchOwner, read?: VerifiedTip, judged?: WorkbenchRead) => T,
): T {
  const targetSha = git(named.path, "rev-parse", "--verify", `refs/heads/${target}`);
  const sha = carried && carriedSha(named, carried);
  const readOf = (tip: string | undefined, verified: string): WorkbenchRead => ({ at: place.path, target, targetSha, tip, verified });
  const judge = (tip: string | undefined, verified: string) => workbenchOwner(readOf(tip, verified), sha ? { sha, inKey } : undefined, { boardMove, again });
  try {
    return withVerifiedUntrustedTip(place, target, (read) => {
      // ADR 0411 決定2: 検証を通った盤面所有の写しにだけ名前の場所の objects を借りさせる —— 人間の作業台は借りない
      const owner = comparedWithNamedPlace(named, () => {
        borrowObjects(read.verified, [namedObjects(named)]);
        return judge(read.tip, read.verified);
      });
      return use(owner, read, readOf(read.tip, read.verified));
    });
  } catch (err) {
    if (!(err instanceof BranchMissingError)) throw err;
    return use(judge(undefined, named.path), undefined, readOf(undefined, named.path));
  }
}

/** ADR 0411 決定2・5: 作業台は書く先の閉包を全部持つ複製 —— 閉包を受け取れない名前の場所(shallow を含む)からは作らず、名前の場所の側として
 *  拒む。番地を作れない・受け取った後に tree を展開できないのは、host と作業台の側の失敗のまま。 */
function makeWorkbench(named: WorkspaceConfig, at: string, target: string, { source, branch }: CopySource = { source: `refs/heads/${target}`, branch: target }): string {
  const unreadable = (cause: unknown) => namedClosureUnreadable(named, branch, "the workbench", cause);
  try {
    // shallow な名前の場所からの fetch は境界の ref を黙って拒み(git 2.47 の実測)、作りかけが別の git の失敗で落ちる —— 先に名指す
    try {
      assertNotShallow(named.path);
    } catch (cause) {
      throw unreadable(cause);
    }
    const config = { "receive.denyCurrentBranch": "updateInstead" };
    return makeCheckout({ at, named, source, branch: target, description: `the workbench for ${target}`, config, fetchFailure: unreadable });
  } catch (err) {
    // ADR 0382 決定5: 作りかけを残さない —— 書く先の branch まで着いた作りかけは作業ツリーが tip と違い、人間の作業と見分けられずに残り続ける
    rmSync(at, { recursive: true, force: true, maxRetries: 3 });
    throw err;
  }
}

/** ADR 0414 決定4: 作業台を開く扉が準備(基準の比較か最初の撮り)より前に撃つ shallow の確かめ —— 文は作業台を作る手の名前の場所の側の拒否と
 *  同じ(ADR 0411 決定5、`head` が文の頭)。git が答えない名前の場所は今どおり準備が扱う(決定5)。前から disk にある作業台 `workbench` の
 *  `board/*` は、名前の場所の側で落ちた引き直し(`repointBoardRefs` の段A)と同じく消す。 */
function refuseShallowBeforePreparation(named: WorkspaceConfig, workbench: string, head = ""): void {
  try {
    assertNotShallow(named.path);
  } catch (cause) {
    if (!(cause instanceof ShallowRepositoryError)) return;
    if (placeHasRepository(workbench)) deleteRefs(workbench, `refs/heads/${BOARD_BRANCHES}/`);
    throw new DomainError(`${head}workspace ${named.name}: ${cause.message}`);
  }
}

/** 開くたびに `board/*` を引き直す。この呼び出しで作った作業台(`made`)の引き直しが落ちれば、消してから投げる —— 開けなかったと言う扉の後に
 *  作業台を残さない(ADR 0382 決定5)。 */
function repointOpened(named: WorkspaceConfig, path: string, made: boolean, carried?: Carried): void {
  try {
    repointBoardRefs(named, path, carried);
  } catch (err) {
    if (made) rmSync(path, { recursive: true, force: true, maxRetries: 3 });
    throw err;
  }
}

/** 作業台を開けなかった扉の文を `stop` で閉じる。名前の場所の側の拒否(ADR 0411 決定3・5)は開き直しでは直らないので、その文をそのまま言い、
 *  開き直しも作業台を消すことも誘わない。ほかは開けなかった理由と扉の答え直し `retry`(`subject` が文の頭)。 */
function couldNotOpenWorkbench(err: unknown, retry: string, { subject = "The board", stop = "." } = {}): string {
  if (err instanceof NamedPlaceFetchError) return `${err.message.replace(/\.$/, "")}${stop}`;
  return `${subject} could not open the workbench (${err instanceof Error ? err.message : String(err)}); ${retry}${stop}`;
}

/** 落ちた git の stderr(無ければ空)。 */
const stderrOf = (cause: unknown) => String((cause as { stderr?: unknown } | null)?.stderr ?? "");

/** 落ちた git の文 —— stderr があればそれ(command line は object を名指さない)、無ければ失敗の文。 */
const gitFailureText = (cause: unknown) => stderrOf(cause).trim() || (cause instanceof Error ? cause.message : String(cause));

/** ADR 0382 決定3・5: 人間担当の work 自身の作業台 (workspace, `task/<H>`) を開く —— 作り直さず、disk に repo が無いときだけ `copy` から作る。
 *  既定は `task/<H>`(取り込んでいない commit は戻らない、ADR 0374 決定2)、最初の `start_work` は固定より前に読む fork 元の commit
 *  (ADR 0414 決定2)。開くたびに `board/*` を引き直す。返すのは実体の綴りの在り処と、今作ったか。 */
function openHumanWorkWorkbench(named: WorkspaceConfig, base: string, target: string, copy?: CopySource): { path: string; opened: boolean } {
  const at = workbenchAt(named, base, target);
  const opened = !placeHasRepository(at);
  if (opened) rmSync(at, { recursive: true, force: true, maxRetries: 3 });
  const path = opened ? makeWorkbench(named, at, target, copy) : realpathSync(at);
  repointOpened(named, path, opened);
  return { path, opened };
}

/** ADR 0374 決定2: task の読みが運ぶ人間担当の work 自身の作業台 —— disk にある間だけ、実体の綴りの在り処(完了の dialog の text C4 も
 *  これを言う)と、task が未決着の間だけ、そこへ移るコマンドと clone の remote に足すコマンド(`workbenchCommands`)。`done` の後に
 *  残った作業台(text C7)は何も取り込まないので、push を誘わない。 */
export function humanWorkbenchDisplay(base: string, task: Task): { workbench: string | null; workbench_commands?: string[] } {
  const at = workbenchPath(base, { task: task.id });
  if (!placeHasRepository(at)) return { workbench: null };
  const path = realpathSync(at);
  return { workbench: path, ...(!isSettled(task.status) && { workbench_commands: workbenchCommands(path) }) };
}

/** spec #3273 group C(Surfaces): 人間担当の work の分解の応答に足す1行 —— 作業台の tip が持つ、`task/<H>` に無い commit の数を言う。
 *  無いか、作業台が disk に無いか書く先の branch が無ければ undefined。tip は ADR 0364 の手で検証済みの写しに読む。 */
export function notTakenInWarning(named: WorkspaceConfig, base: string, taskId: string): string | undefined {
  const target = taskBranch(taskId);
  const place = workbenchOnDisk(named, workbenchAt(named, base, target));
  if (place === undefined) return undefined;
  const count = judgeWorkbench(named, place, target, { boardMove: true }, (owner, read, judged) =>
    owner.kind === "mine" && read && judged ? Number(workerRepoGit(read.verified, "rev-list", "--count", read.tip, `^${judged.targetSha}`)) : 0,
  );
  if (count === 0) return undefined;
  return `the children fork from ${target}, and ${count} commit${count === 1 ? "" : "s"} in the workbench at ${place.path} ${count === 1 ? "is" : "are"} not taken in yet.`;
}

/** ADR 0382 決定3: 子の merge back の conflict を、書く先の人間担当の work 自身の作業台で受けるか —— 書き始め済み(`task_work_started`)で
 *  `done` の前だけ。それ以外は子ごとの作業台。 */
function humanWorkReceives(db: Db, target: string): boolean {
  const owner = target.startsWith("task/") ? getTask(db, taskIdOfBranch(target)) : undefined;
  return owner !== undefined && owner.assignee === HUMAN_ACTOR_ID && !isSettled(owner.status) && hasStartedWork(db, owner.id);
}

/** ADR 0371 決定7: 作業台の `refs/heads/board/*` を名前の場所の branch の今の値に引き直す —— 人間がそこへ書いたものは上書きされて
 *  消え、人間の branch と作業ツリーは動かさない。盤面が読むのは書く先の branch の tip だけ。 */
function repointBoardRefs(named: WorkspaceConfig, workbench: string, carried?: Carried): void {
  const boardRefs = `refs/heads/${BOARD_BRANCHES}/`;
  // git は checkout 中の branch へ fetch しないので、HEAD が `board/*` に居れば同じ commit で切り離す(tree も index も動かさない)
  if (headValue({ name: named.name, path: workbench }).startsWith(symrefValue(boardRefs))) {
    git(workbench, "update-ref", "--no-deref", "HEAD", git(workbench, "rev-parse", "HEAD"));
  }
  // `board/origin/<protected>` は盤面が origin から読んだばかりの保護ブランチ —— 追いつきの conflict が merge させる相手(text A2)。
  // 名前の場所の origin の他の写しは引かない —— 写し `refs/remotes/origin/task/<root>` は盤面が最後に push した値で、GitHub の head ではない
  // (ADR 0376 決定3)。`board/origin/task/<root>` を持つのは、鍵が GitHub の head を運ぶ作業台だけ —— その head は名前の場所のどの ref でもない
  // (写しは最後に push した値のまま)ので sha で引く(ADR 0376 決定4、text D1)
  const tracking = remoteTrackingRef(protectedBranch(named));
  const refspecs = [
    `+refs/heads/*:${INCOMING_REFS}*`,
    ...(isRemoteBacked(named) ? [`+${tracking}:${INCOMING_REFS}${shortRef(tracking)}`] : []),
    ...(typeof carried === "object" ? [`+${carried.sha}:${INCOMING_REFS}${shortRef(carried.ref)}`] : []),
  ];
  try {
    // ADR 0411 決定3・5 と追記(#3763): 段A —— 名前の場所から盤面だけの名前空間へ、作業台を作る fetch と同じ strict な検査で object ごと受け取る。
    // 落ちれば名前の場所の側で、古い `board/*` は消す(名前の場所の今の値に見えたまま残さない —— 次に開く手が引き直して同じ拒否を言う)。
    // shallow な名前の場所は境界の ref を黙って落とすので先に名指す
    try {
      assertNotShallow(named.path);
      git(workbench, ...STRICT_FETCH, "fetch", ...FETCH_FLAGS, named.path, ...refspecs);
    } catch (cause) {
      deleteRefs(workbench, boardRefs);
      const why = cause instanceof ShallowRepositoryError ? cause.message : `the board cannot give the named workspace's branches to the workbench as \`${boardBranch("*")}\`: ${gitFailureText(cause)}. The board opens no workbench for workspace ${named.name} until every branch of the named workspace at ${named.path} reads whole and passes that check.`;
      throw hostFailure(cause) ?? new NamedPlaceFetchError(`workspace ${named.name}: ${why}`, { cause });
    }
    // 段B —— 受け取った値を作業台の中で `board/*` へ移す。ここの失敗(人間の linked worktree が `board/*` に居る、残った lock)は作業台の側
    git(workbench, "fetch", ...FETCH_FLAGS, "--prune", ".", `+${INCOMING_REFS}*:${boardRefs}*`);
  } finally {
    deleteRefs(workbench, INCOMING_REFS);
  }
}

/** 引き直しが名前の場所から受け取る、盤面だけが使う名前空間 —— 段Bが `board/*` へ移し、どの出口でも消す。 */
const INCOMING_REFS = "refs/tidepool-incoming/";

/** `repo` の `prefix` の下の ref を1つずつ消す —— 消せない ref があっても残りを消す(読めなければ何もしない)。 */
function deleteRefs(repo: string, prefix: string): void {
  let refs: string[];
  try {
    refs = git(repo, "for-each-ref", "--format=%(refname)", prefix).split("\n").filter(Boolean);
  } catch {
    return;
  }
  for (const ref of refs) {
    try {
      git(repo, "update-ref", "-d", ref);
    } catch {}
  }
}

/** ADR 0371 決定7: 取り込みの拒否は `board/*` を引き直してから投げる。 */
function repointingOnRefusal<T>(named: WorkspaceConfig, workbench: string, intake: () => T, carried?: Carried): T {
  try {
    return intake();
  } catch (err) {
    try {
      repointBoardRefs(named, workbench, carried);
    } catch (repoint) {
      // 引き直せなくても拒否の理由を人間に返す —— 次の拒否か開く手が引き直す。名前の場所の側で落ちれば `board/*` は消えたので、拒否の文が誘う
      // `board/*` の merge は届かない —— 拒否の型のまま、その理由を足す
      if ((repoint instanceof NamedPlaceFetchError || hostFailure(repoint)) && err instanceof Error) err.message = `${endSentence(err.message)} ${(repoint as Error).message}`;
    }
    throw err;
  }
}

/** 取り込んだと言う文の頭(text C6 と、取り込みの後に作業台を消せなかった文)。 */
const tookIn = (target: string, { tip, commit }: { tip: string; commit: string }) => `took ${tip} in as ${commit} on ${target}.`;

/** spec #3273 の入口の表の後 / text C6: 作業台を残す取り込みの後、作業台の書く先の branch を読んだ tip からの CAS で包む commit へ進め、
 *  `board/*` を引き直して text C6 を返す。包む commit は人間の tip の tree を持つので作業ツリーは clean のまま。間に push が着いていれば
 *  進めずにそう言う。すでに包む commit に居れば(答え直しの前に進めていた、ADR 0401 決定4)進めずに進んだと読む。ref も event も書いた後
 *  なので、作業台の失敗では拒まない。`board/*` を名前の場所の側で引き直せなければ、進めずにその理由を言う。 */
function advanceKeptWorkbench(named: WorkspaceConfig, workbench: string, target: string, { tip, commit }: { tip: string; commit: string }, carried?: Carried): string {
  // 包む commit は名前の場所にしか無い —— `board/*` を引き直して object ごと作業台に届けてから進める(ADR 0411 決定2)
  try {
    repointBoardRefs(named, workbench, carried);
  } catch (err) {
    // 名前の場所の側で引き直せなければ包む commit は作業台に届かない —— 進めず、`board/*` の merge を誘わずにその拒否を言う
    if (err instanceof NamedPlaceFetchError || hostFailure(err)) return `took ${tip} in as ${commit} on ${target}. ${(err as Error).message}`;
  }
  let advanced = false;
  try {
    // ADR 0401 決定4: 死の前に包む commit へ進めた作業台(答え直し)は進んだまま
    if (workerRepoGit(workbench, "rev-parse", `refs/heads/${target}`) !== commit) workerRepoGit(workbench, "update-ref", `refs/heads/${target}`, commit, tip);
    advanced = true;
  } catch {}
  return (
    `${tookIn(target, { tip, commit })} In a clone, fetch the workbench and fast-forward to \`${boardBranch(target)}\` before you write on.` +
    (advanced ? "" : ` Merge \`${boardBranch(target)}\` into your branch before the next take-in.`)
  );
}

/** 取り込みの手が受け取る束: 作業台の基点、入口、`workbench_taken_in` に残す回答者と、書く瞬間に読む時刻(#3384: 取り込みの前に await を挟む呼び手がある)。 */
export type IntakeContext = { workbenchBase: string; entry: IntakeEntry; answerer: Answerer; now: () => Date };

/** 取り込みの event の actor —— 回答者か呼び手(spec #3273 の識別子の表 / pin A5)。 */
export type Answerer = { actorId: string; origin: EventOrigin };

/** ref の短い名前(`refs/heads/x` → `x`、`refs/remotes/origin/x` → `origin/x`)と、作業台でそれを引き直す `board/` の下の名前。 */
const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
const boardBranch = (short: string) => `${BOARD_BRANCHES}/${short}`;

/** 運ばれる側: 名前の場所の ref か、盤面が origin から読んだばかりの値をその名前で運ぶもの(ADR 0376 決定1・3 —— GitHub の head は名前の場所の
 *  ref に書かない。写し `refs/remotes/origin/task/<root>` は最後に push した値のまま)。鍵と `board/*` の名前は `ref` から、値は `sha` から。 */
type Carried = string | { ref: string; sha: string; label?: string };
const carriedRef = (carried: Carried) => (typeof carried === "string" ? carried : carried.ref);
const carriedSha = (named: WorkspaceConfig, carried: Carried) => (typeof carried === "string" ? git(named.path, "rev-parse", "--verify", carried) : carried.sha);

/** (書く先, 運ばれる側) の作業台の在り処(ADR 0382 決定1)—— 開く手・取り込む手・印を読む手が同じ綴りで引く。 */
const workbenchAt = (named: WorkspaceConfig, base: string, target: string, carried?: Carried) =>
  CHECKOUT_LAYOUT.workbench.at(base, named, target, carried && shortRef(carriedRef(carried)));

/** 人間の clone から同じことをする手(spec #3273 text の `{clone}`)。 */
const fromOwnClone = (target: string, ref: string) =>
  `(or, in your own clone with the workbench as a remote: fetch it, \`git merge <remote>/${ref}\`, and push ${target} to it)`;

/** ADR 0371 決定2〜5: 作業台の書く先の branch の tip を1度だけ読み、盤面所有の写しの中で取り込みの検査をすべて通してから、`use` に
 *  検証済みの写しと書く先の値を渡す —— 写しは `use` が返ると消える。拒否は ref も記録も書かない。tip がこの入口のものでなければ(ADR 0382 決定2)
 *  取り込むものが無く undefined。`carried` は tip が祖先に持つべき、merge で運ばれる側の ref(`refs/heads/*` か `refs/remotes/*`)で、人間自身の
 *  内容の作業台には無い。祖先のほかに履歴は、他の task のブランチの commit を持つ tip だけを入口が宣言した範囲で拒む(ADR 0382 決定4 と追記(#3769)
 *  —— `-s ours` も cherry-pick も、どの task のブランチにも無い commit の merge も通る)。`checks` は入口に固有の検査。 */
function inspectWorkbenchTip<T>(
  db: Db,
  named: WorkspaceConfig,
  place: UntrustedCheckout,
  target: string,
  carried: Carried | undefined,
  { approved, otherTasks, humanContent = false, admit, checkedTip, inKey, humanWork, returnValue, beforeWrite }: EntryChecks,
  use: (read: VerifiedTip, old: string) => T,
): T | undefined {
  const old = approved ?? git(named.path, "rev-parse", "--verify", `refs/heads/${target}`);
  const inputs = [{ branch: target, sha: old, label: target }];
  if (carried) {
    const branch = shortRef(carriedRef(carried));
    inputs.push({ branch, sha: carriedSha(named, carried), label: (typeof carried === "object" && carried.label) || branch });
  }
  const at = place.path;
  const again = humanWork?.again ?? "answer again";
  try {
    return judgeWorkbench(named, place, target, { carried, boardMove: !humanContent && !humanWork, inKey, again }, (owner, read) => {
      // ADR 0382 決定6: 人間担当の work の扉は作りかけ(書く先の branch が無い作業台)を disk から消えた作業台と同じに拒む(text C2e)
      if (owner.kind === "refuse") throw new IntakeRefusedError(humanWork && !read ? humanWork.gone : owner.reason);
      // ADR 0371 決定6: 検査した tree だけを書く —— 検査の間に動いた tip も、取り込むものが無くなった作業台も、検査していない
      if (checkedTip !== undefined && (owner.kind !== "mine" || read?.tip !== checkedTip)) throw new IntakeRefusedError(checkedTipMoved(at, target, checkedTip));
      if (owner.kind !== "mine" || !read) return undefined;
      admit?.();
      const { tip, verified } = read;
      const copy = { ...named, path: verified };
      // ADR 0411 決定3: 名前の場所の値と比べる手だけを名前の場所の側に包む —— 人間の作業ツリーの読みと拒否は包まない
      const withNamed = <V>(compare: () => V) => comparedWithNamedPlace(named, compare);
      const missing = withNamed(() => inputs.find(({ sha }) => !isAncestor(copy, sha, tip, workerRepoGit)));
      if (missing) {
        const merge = boardBranch(missing.branch);
        // spec #3273 text C2a: 人間担当の work の tip が欠くのは、子の成果が届いた `task/<H>`
        if (humanWork && missing.branch === target) {
          throw new IntakeRefusedError(`${target} has moved on since your tip (work of its children arrived). In the workbench at ${at}, on ${target}, run \`git merge ${merge}\` ${fromOwnClone(target, merge)}, then ${again}.`);
        }
        throw new IntakeRefusedError(`the workbench at ${at} is not ready: ${target} there does not contain ${missing.label} (\`${merge}\`). Run \`git merge ${merge}\` there ${fromOwnClone(target, merge)}, then ${again}.`);
      }
      const branches = withNamed(() => otherTaskBranches(db, named, verified, tip, [...inputs.map(({ sha }) => sha), ...(otherTasks.alsoExcluded?.() ?? [])], otherTasks.range));
      if (branches.length > 0) throw new IntakeRefusedError(otherTasks.refusalFor(branches, at));
      if (boardViewStatus(at, tip, verified).length > 0) {
        throw new IntakeRefusedError(`the workbench at ${at} has uncommitted changes — commit or discard them, then ${again}.`);
      }
      // ADR 0371 決定5 / ADR 0362 決定2 / ADR 0365 決定2: 完了の門と同じ検査を、入力の tip のどれとも違う entry にだけ —— 比べる相手は fork 元
      // との merge-base でなく入力の tip。運ばれてきただけの変更は人間の書いたものではない
      // ADR 0374 決定6: 人間が merge した帰り先の値も入力の tip —— そこから入った変更を人間の変更に数えない(pin C18)
      const merged = returnValue !== undefined && withNamed(() => isAncestor(copy, returnValue, tip, workerRepoGit)) ? [{ sha: returnValue }] : [];
      const [first, ...rest] = withNamed(() => [...inputs, ...merged].map(({ sha }) => diffTreeEntries(verified, sha, tip, { workerTree: true })));
      const differing = first!.filter(({ path }) => rest.every((delta) => delta.some((other) => other.path === path)));
      const refuse = (paths: string[], what: string, route = "") => {
        if (paths.length > 0) throw new IntakeRefusedError(`the tip of the workbench at ${at} changes ${paths.map(displayWorktreePath).join(", ")}, which ${what}; take that change out and commit, then ${again}.${route}`);
      };
      // ADR 0371 決定6: 人間自身の内容の入口は、書き込む tree が隠せない形を持てば(人間が変えたかに依らず)拒む
      const { unhideable } = recordedSettingsDisposition(verified, tip, workerRepoGit);
      refuse(unhideable && (humanContent || differing.some(({ path }) => path === unhideable.path)) ? [unhideable.path] : [], "is a shape the board cannot hide");
      // ADR 0371 決定5: 人間しか書けない path は purely-local の保護ブランチへ人間自身の内容を入れる入口だけが通す
      if (!humanContent) refuse(humanOnlyPathChanges(differing), "is written only by a human", humanOnlyPathRoute(db, named));
      refuse(gitlinkChanges(differing), "is a gitlink");
      beforeWrite?.(read);
      return use(read, old);
    });
  } catch (err) {
    // 上限超過の文は worker の tree を名指す —— 人間には作業台の在り処で言う
    if (err instanceof WorkerTreeGitTimeoutError) throw new IntakeRefusedError(err.about(`the workbench at ${at}`), { cause: err });
    throw err;
  }
}

/** 取り込みの検査が拒んだ —— 人間が作業台で直せる理由で、文はそのまま人間に届く。 */
class IntakeRefusedError extends Error {}

/** 検査した tip が取り込む時点の作業台の tip でない —— 検査していない tree は書かない。 */
const checkedTipMoved = (at: string, target: string, tip: string) =>
  `${target} in the workbench at ${at} is no longer ${tip}, the tip the board checked, so nothing was taken in. Answer again to check the tip it has now.`;

/** ADR 0371 決定4: 検査を通った tip を包む commit(第1親が書く先の値、第2親が人間の tip、tree は人間の tip)を作り、書く先の ref を旧値の CAS で
 *  口から書いて `workbench_taken_in` を残し、取り込んだ tip と包む commit を返す。 */
function takeInWorkbench(
  db: Db,
  named: WorkspaceConfig,
  place: UntrustedCheckout,
  target: string,
  carried: Carried | undefined,
  { entry, answerer, now }: IntakeContext,
  checks: EntryChecks,
): { tip: string; commit: string } | undefined {
  const ref = `refs/heads/${target}`;
  return inspectWorkbenchTip(db, named, place, target, carried, checks, ({ tip, verified, tipRef, own }, old) => {
    carryIntoNamed(named, subjectOf(place), { source: verified, ref: tipRef, own, tip, description: "the workbench tip" });
    const commit = git(named.path, "commit-tree", `${tip}^{tree}`, "-p", old, "-p", tip, "-m", `Take in ${target} from the workbench`);
    advanceBranch(db, named, ref, old, commit);
    appendEvent(db, { taskId: null, ...answerer, at: now(), payload: { kind: "workbench_taken_in", workspace: named.name, target: ref, tip, commit, entry } });
    return { tip, commit };
  });
}

/** ADR 0382 決定4 の数える task の範囲: local 着地と `task/*` へ書く入口(追記、#3769)はすべての task(決着済み・cancel 済みを含む)、
 *  `take in` と封じ込めの回答は未決着か着地待ち(hold を含む)の task。 */
type TaskRange = "every task" | "unsettled or landing-waiting";

/** ADR 0382 決定4(#3352 の追記4)と追記(#3769): 作業台の tip が持つ、`excluded`(入口の入力の tip と、入口が足す帰り先・保護ブランチの今の値)の
 *  どれにも無い commit を含む task のブランチのうち、`range` の task のもの —— 入口は範囲と足す値を渡す。着地の済んだ task の commit は保護ブランチの
 *  今の値にある(保護ブランチへ書く入口では書く先、`task/*` へ書く入口では足す値)ので、範囲に入っても拒まない。worker の tip(ADR 0417)は
 *  名前の場所へ運んだ後に名前の場所で数える —— `verified` に名前の場所を渡す(検証済みの写しに objects を借りさせない、ADR 0412 決定2)。 */
function otherTaskBranches(db: Db, named: WorkspaceConfig, verified: string, tip: string, excluded: string[], range: TaskRange): string[] {
  const branches = refValues(git(named.path, "for-each-ref", "--format=%(objectname) %(refname:strip=2)", "refs/heads/task/"));
  if (range === "unsettled or landing-waiting") {
    for (const branch of [...branches.keys()]) if (!unsettledOrLandingWaiting(db, taskIdOfBranch(branch))) branches.delete(branch);
  }
  return foreignTaskBranches(verified, named.path, tip, excluded, branches);
}

/** ADR 0382 決定4: 未決着か着地待ち(hold は着地待ち)の task。done の task の内容は帰り先を辿って根の着地でだけ保護ブランチに入るので、
 *  祖先に cancel のあるものは着地を待たない。盤面の知らない名前の `task/*` は task ではない。 */
function unsettledOrLandingWaiting(db: Db, id: string): boolean {
  const task = getTask(db, id);
  if (task === undefined || task.status === "cancelled") return false;
  if (!isSettled(task.status)) return true;
  return !underCancel(db, id);
}

/** 祖先に cancel された task がある。 */
const underCancel = (db: Db, id: string) =>
  db.prepare(`${ancestorsSql("?")} SELECT 1 FROM tasks WHERE id IN (SELECT id FROM ancestors) AND status = 'cancelled'`).get(id) !== undefined;

/** 他の task の commit を持つ tip の拒否文の結び: 運ばれる側 `carried` だけを merge し直す手(local 着地と、運ばれる側のある `task/*` へ書く入口)。
 *  `drops` はやり直しが落とすもの。 */
const mergeOnlyCarried = (target: string, carried: string, again: string, drops = "your merge") =>
  `Start ${target} in the workbench over with \`git reset --hard ${boardBranch(target)}\` — this drops ${drops} there too — then merge only ` +
  `\`${boardBranch(carried)}\`, resolve its conflict again and ${again}.`;

/** ADR 0382 追記(#3769): `task/*` へ書く入口の他の task の検査 —— 範囲はすべての task。入力の tip のほかに、保護ブランチの今の値(remote-backed では
 *  盤面が読んだ origin の値 —— 着地した task の commit はそこにある)と、`returnValue` が読む帰り先の今の値(人間はそれを merge する、ADR 0374 決定6。
 *  tip が含むかに依らない)の commit も数えない。拒否文の結びは、運ばれる側の無い入口では自分の commit だけを残す手を、ある入口では `carried` だけを
 *  merge し直す手を言う(`dropsOwnWork` は人間担当の work 自身の作業台で子を受ける入口 —— 書きかけの commit も落ちる)。 */
function taskWriteOtherTasks(
  db: Db,
  named: WorkspaceConfig,
  { target, again, carried, dropsOwnWork = false, returnValue }: { target: string; again: string; carried?: string; dropsOwnWork?: boolean; returnValue?: () => string | undefined },
): EntryChecks["otherTasks"] {
  const closing =
    carried === undefined
      ? `To keep only your own commits, start ${target} in the workbench over with \`git reset --hard ${boardBranch(target)}\` and commit them again — \`git cherry-pick\` copies a change you still want without its history — then ${again}.`
      : mergeOnlyCarried(target, carried, again, dropsOwnWork ? "your merge and your own commits not taken in yet" : undefined);
  const refusalFor = (branches: string[], at: string) =>
    branches.map((branch) => `the tip of the workbench at ${at} contains commits of ${otherTaskClause(db, branch)}`).join(" ") + ` ${closing}`;
  return { range: "every task", refusalFor, alsoExcluded: () => taskWriteExcluded(named, returnValue) };
}

/** ADR 0382 追記(#3769) / ADR 0417 決定2: `task/*` へ書く手が入力の tip のほかに数えない、保護ブランチの今の値(remote-backed では盤面が読んだ
 *  origin の値)と、`returnValue` が読む帰り先の今の値。 */
const taskWriteExcluded = (named: WorkspaceConfig, returnValue?: () => string | undefined): string[] =>
  [git(named.path, "rev-parse", "--verify", exactProtectedBranchRef(named)), returnValue?.()].filter((sha) => sha !== undefined);

/** 他の task の commit を持つ tip の拒否文の、ブランチ `branch` を名指して盤面がその成果を運ぶか(cancel 済みなら運ばない)を言う句。 */
function otherTaskClause(db: Db, branch: string): string {
  const id = taskIdOfBranch(branch);
  const cancelled = getTask(db, id)?.status === "cancelled" || underCancel(db, id);
  return `${branch}, ${cancelled ? "which was cancelled, so the board does not carry its work." : "and the board carries a task's work itself — a child's by its merge back, a root's by its landing."}`;
}

/** spec #3273 の受理の 11: merge back の前に、その子を運ぶ鍵の作業台が取り込める tip を持てば先に取り込む(ADR 0382 決定1)。 */
function takeInMergeBack(db: Db, named: WorkspaceConfig, { taskId, target }: { taskId: string; target: string }, intake: IntakeContext) {
  const humanWork = humanWorkReceives(db, target);
  // ADR 0382 追記(#3769): 人間担当の work 自身の作業台の tip は書きかけも運び、そこには帰り先の merge がありうる。帰り先が読めなければ(帰り先なし、
  // ref が無い)足さない —— 数える側に倒れて取り込みの拒否になり、merge back の受理を git の失敗で落とさない
  const returnValue = () => {
    try {
      return returnBranchOf(db, named, getTask(db, taskIdOfBranch(target))!, "complete", intake.now()).sha;
    } catch {
      return undefined;
    }
  };
  const otherTasks = taskWriteOtherTasks(db, named, { target, again: "answer again", carried: taskBranch(taskId), dropsOwnWork: humanWork, returnValue: humanWork ? returnValue : undefined });
  return takeInExistingWorkbench(db, named, target, `refs/heads/${taskBranch(taskId)}`, intake, { checks: { otherTasks }, humanWork });
}

/** ADR 0376 決定8: 昇格の retry は追いつきの前に、(`task/<root>`, origin の保護ブランチ) の作業台が取り込める tip を持てば先に取り込み、
 *  作業台を残したならその text C6 を、消せなかったならそう言う文を返す。運ばれる側は origin の保護ブランチ(text A2)。 */
export function takeInCatchUp(db: Db, workspace: WorkspaceConfig, taskId: string, intake: IntakeContext): string | undefined {
  const [target, carried] = [taskBranch(taskId), exactProtectedBranchRef(workspace)];
  const otherTasks = taskWriteOtherTasks(db, workspace, { target, again: "answer again", carried: shortRef(carried) });
  return takeInExistingWorkbench(db, workspace, target, carried, intake, { checks: { otherTasks } })?.kept;
}

/** ADR 0382 決定1: preserve the workbench key and its `board/origin/task/*` alias for work already in progress. */
const outsideHeadRef = (taskId: string) => remoteTrackingRef(taskBranch(taskId));
const outsideHead = (taskId: string, head: string, label?: string): Carried => ({ ref: outsideHeadRef(taskId), sha: head, label });

/** ADR 0376 決定4・7・8: 昇格の retry と、外の push が落とした内容の merge question への `merge` は、追いつきより前に、
 *  (`task/<root>`, GitHub の head) の作業台が取り込める tip を持てば先に取り込み、
 *  取り込んだなら、作業台を残したときの text C6 か消せなかったときの文を返す。tip が今読んだ head を欠けば、`board/origin/task/<root>` をその head へ引き直して拒む。 */
export function takeInOutsideHead(db: Db, workspace: WorkspaceConfig, taskId: string, head: string, label: string, intake: IntakeContext): { kept: string | undefined } | undefined {
  const target = taskBranch(taskId);
  const otherTasks = taskWriteOtherTasks(db, workspace, { target, again: "answer again", carried: shortRef(outsideHeadRef(taskId)) });
  return takeInExistingWorkbench(db, workspace, target, outsideHead(taskId, head, label), intake, { checks: { otherTasks } });
}

/** 入口に固有の検査。`approved` は書く先の値として使う ADR 0103 の突き合わせが認めた値(その後に動いた値は CAS が拒む)。`otherTasks` は
 *  ADR 0382 決定4 と追記(#3769): どの入口も宣言する、数える task の範囲と、その task の commit を持つ tip の拒否文(ブランチと作業台の在り処を受ける)、
 *  入力の tip のほかに数えない値。`humanContent` は
 *  人間自身の内容の入口(`take in`)—— 盤面の手が無く、人間しか書けない path を通し、書き込む tree が隠せない形を持てば拒む。
 *  `admit` は tip がこの入口のものと判ったときだけ掛ける入口の条件(拒むなら投げる)。`checkedTip` は書く前に組の検査を通した tip で、
 *  読んだ tip がこれでなければ拒む(ADR 0371 決定6)。 */
type EntryChecks = {
  approved?: string;
  /** 省略できない(ADR 0382 追記、#3769)—— 入口を足せば範囲を書かなければ型で落ちる。`alsoExcluded` は入力の tip のほかに数えない値で、tip を数えるときだけ読む。 */
  otherTasks: { range: TaskRange; refusalFor: (branches: string[], at: string) => string; alsoExcluded?: () => string[] };
  humanContent?: boolean;
  admit?: () => void;
  checkedTip?: string;
  /** 鍵に運ばれる側が入っているか(ADR 0382 決定3: 人間担当の work 自身の作業台は子の入口を鍵に持たない)。既定は入っている。 */
  inKey?: boolean;
  /** 人間担当の work 自身の入口(ADR 0374 決定5〜7、ADR 0382 決定3・6): 盤面の手が無い。`again` は拒否文の答え直し、`gone` は作りかけの拒否文。 */
  humanWork?: { again: string; gone: string };
  /** 内容の検査だけに数える入力の tip —— tip がそれを含むときだけ(ADR 0374 決定6 の帰り先の値)。 */
  returnValue?: string;
  /** 検査を全部通った tip を書く直前に掛ける入口の検査(拒むなら投げる)。 */
  beforeWrite?: (read: VerifiedTip) => void;
};

/** 鍵の作業台があれば取り込み、包む commit と、作業台を残したか消せなかったときの文を返す(取り込むものが無ければ undefined)。拒否は
 *  `board/*` を引き直してから投げる。取り込んだ後の片付けは `settleTakenInWorkbench`。 */
function takeInExistingWorkbench(
  db: Db,
  named: WorkspaceConfig,
  target: string,
  carried: Carried,
  intake: IntakeContext,
  /** `checks` は入口に固有の検査。`humanWork` は ADR 0382 決定3: 書く先の人間担当の work 自身の作業台で受ける —— 鍵に運ばれる側は入らず、
   *  `done` まで消さない(決定5)。 */
  { checks, humanWork = false }: { checks: EntryChecks; humanWork?: boolean },
): { commit: string; kept: string | undefined } | undefined {
  const place = workbenchOnDisk(named, humanWork ? workbenchAt(named, intake.workbenchBase, target) : workbenchAt(named, intake.workbenchBase, target, carried));
  if (place === undefined) return undefined;
  const taken = repointingOnRefusal(named, place.path, () => takeInWorkbench(db, named, place, target, carried, intake, { ...checks, inKey: !humanWork }), carried);
  if (taken === undefined) return undefined;
  if (humanWork) return { commit: taken.commit, kept: advanceKeptWorkbench(named, place.path, target, taken, carried) };
  return { commit: taken.commit, kept: settleTakenInWorkbench(named, place, target, carried, taken, false) };
}

/** ADR 0382 決定5 / ADR 0401 決定4: 鍵の作業台の取り込みの後の片付け —— 取り込みの直後(`taken` は取り込んだ tip と包む commit)と、
 *  取り込みで着地した後・記録の前に死んだ盤面の答え直し(`reanswer`。`taken` は着地の commit の第2親とその commit で、着地の merge(第2親が
 *  task の tip)と第2親の無い着地は取り込みではないので無い —— ADR 0418 決定3)が共有する。tip が取り込んだまま(取り込んだ tip か、答え直しでは進めた後の包む commit)で人間の作業が残っていなければ消し、
 *  残っていれば残してその branch を包む commit へ進め、text C6 を返す。読めなければ、最初の回答は残して進める。答え直しは、死の後に人間が
 *  commit していれば(持ち主 `mine`)残してそう言い、取り込みでない着地・ほかへ動いた tip・読めない作業台は何もせず残す。投げない —— ref も event
 *  も書いた後なので拒まない(ADR 0401 決定1 の (3))。 */
function settleTakenInWorkbench(
  named: WorkspaceConfig,
  place: UntrustedCheckout,
  target: string,
  carried: Carried,
  taken: { tip: string; commit: string } | undefined,
  reanswer: boolean,
): string | undefined {
  let judged: { owner: WorkbenchOwner; tip: string | undefined };
  try {
    judged = judgeWorkbench(named, place, target, { carried, boardMove: true }, (owner, read) => ({ owner, tip: read?.tip }));
  } catch {
    return reanswer || taken === undefined ? undefined : advanceKeptWorkbench(named, place.path, target, taken, carried);
  }
  const { owner, tip } = judged;
  if (reanswer && owner.kind === "mine") return notTakenInKept(place.path);
  if (taken === undefined) return undefined;
  const takenIn = tip === taken.tip || (reanswer && tip === taken.commit);
  if (reanswer && !takenIn) return undefined;
  if (owner.kind !== "nothing" || !takenIn) return advanceKeptWorkbench(named, place.path, target, taken, carried);
  return removeWrittenWorkbench(place.path, tookIn(target, taken));
}

/** `intake` question の選択肢(spec #3273 の識別子の表)。 */
export const INTAKE_OPTIONS = ["take in", "close"] as const;

/** その workspace の開いた `intake` question の id。 */
export function openIntakeQuestionId(db: Db, name: string): string | undefined {
  const row = db
    .prepare("SELECT id FROM tasks WHERE type = 'question' AND status = 'todo' AND question_intake_workspace = ? ORDER BY rowid LIMIT 1")
    .get(name) as { id: string } | undefined;
  return row?.id;
}

/** spec #3273 text D6(ADR 0376 決定12): remote-backed の workspace で人間しか書けない path を入れる道。 */
const originRoute = (named: WorkspaceConfig) =>
  ` Put the change into origin's ${protectedBranch(named)} — a fast-forward push from your own clone, or a merge of your own PR. ` +
  `Never push from ${named.path}. Tasks that have already forked do not get it; it takes effect from the next fork.`;

/** spec #3273 text A7c の出口: 人間しか書けない path を入れる道 —— purely-local なら開いた `intake` question か `open_workbench`、
 *  remote-backed なら text D6。 */
function humanOnlyPathRoute(db: Db, named: WorkspaceConfig): string {
  if (isRemoteBacked(named)) return originRoute(named);
  const question = openIntakeQuestionId(db, named.name);
  return question
    ? ` To change a human-only path, use the intake question ${question} of workspace ${named.name}.`
    : ` To change a human-only path, open a workbench for ${named.name} (\`open_workbench\`).`;
}

/** spec #3273 への上書き(ADR 0382 決定4): 人間自身の内容の作業台が書く先に無い commit をすでに持つとき、それと捨て方を言う句(text A13・A14)。 */
const heldCommitsClause = (owner: WorkbenchOwner, branch: string) =>
  owner.kind === "mine"
    ? ` The workbench already holds commits that ${branch} does not have; to start over from the board's value, run \`git reset --hard ${boardBranch(branch)}\` there.`
    : "";

/** spec #3273 text B8 の remote-backed の文。 */
const pushFixToOrigin = (branch: string) => ` Push the fix to origin's ${branch} from your own clone, then answer.`;

/** spec #3273 text B8 の purely-local の文。 */
const commitFixInWorkbench = (path: string, branch: string) => ` The board opened the workbench at ${path}: commit the fix there on ${branch}, then answer.`;

/** 作業台が無いときの出口 —— 封じ込めの回答は作業台を開かない(無ければ検査だけ)ので、開き直す手は `open_workbench`。 */
const openWorkbenchExit = (branch: string) => `open it with \`open_workbench\`, commit the fix there on ${branch}, then answer`;

/** 人間自身の内容の作業台が書く先の branch とともに disk にある。 */
const holdsTargetBranch = (at: string, branch: string) =>
  placeHasRepository(at) && readingWorkbench(at, () => workbenchAnswer(at, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`) !== undefined);

/** ADR 0373 決定9: 組の停止が開く作業台 —— 開くのは鍵ごとに冪等で、書く先の branch のある作業台は作り直さない(無視された file も人間のもの)。
 *  作りかけは開く手の規則で作り直す。返すのは修理の道の文(text B8、ADR 0382 決定4 の句)。開けなければそう言う(fail-closed)。 */
function containmentStopRoute(db: Db, named: WorkspaceConfig, base: string, now: Date): string {
  const branch = protectedBranch(named);
  try {
    if (isRemoteBacked(withRememberedRepoCheck(db, named, () => now))) return pushFixToOrigin(branch);
    const at = CHECKOUT_LAYOUT.workbench.at(base, named, branch);
    let opened: { path: string; owner: WorkbenchOwner };
    if (holdsTargetBranch(at, branch)) {
      opened = { path: realpathSync(at), owner: judgeOnDisk(named, at, branch) };
      repointBoardRefs(named, opened.path);
    } else opened = openWorkbench(named, base, branch);
    return `${commitFixInWorkbench(opened.path, branch)}${heldCommitsClause(opened.owner, branch)}`;
  } catch (err) {
    return ` ${couldNotOpenWorkbench(err, openWorkbenchExit(branch))}`;
  }
}

/** ADR 0373 決定9: (Harness, workspace) の組を止める唯一の口 —— purely-local の workspace なら人間自身の内容の作業台を開いて、組の Quarantine を
 *  登録し、止めた資源を返す。remote-backed の workspace と面接室の名前には作業台を開かない。理由には修理の道を足す(text B8、Codex は text G1)。 */
export function stopContainmentPair(db: Db, harness: Harness, named: WorkspaceConfig, reason: string, base: string, now: Date): ResourceStop {
  const stop = (text: string) => registerResourceStop(db, "workspaceContainment", workspaceContainmentValue(harness, named.name), text, now);
  if (isInterviewRoomName(db, named.name)) return stop(reason);
  const route = containmentStopRoute(db, named, base, now);
  return stop(`${endSentence(reason)}${harness === "codex" ? ifTheSkillIsTracked(route) : route}`);
}

/** ADR 0371 決定6 / ADR 0382 決定5: `open_workbench` —— purely-local の workspace の人間自身の内容の作業台 (workspace, 保護ブランチ) を開き、
 *  workspace に `intake` question を1つ立てる。question が開いていて作業台が書く先の branch とともに disk にあれば `board/*` の引き直しのほかは何も変えず(pin A13)、
 *  同じ question を名指す。そうでなければ開く手の規則で開く —— question が開いていて作業台が disk に無いか作りかけなら作り直す。
 *  remote-backed の workspace は拒む(text A9)。基準の行が無ければ、開く前に最初の撮りをする(ADR 0383 決定2、`captureFirstBaseline`)。
 *  question の登録者は呼び手。返すのは text A14。`board` は pickup の最初の撮りと同じ確認が引く registry の口と盤面の固定点。 */
export async function openHumanContentWorkbench(
  db: Db,
  workspace: WorkspaceConfig,
  base: string,
  caller: Answerer,
  now: () => Date,
  board: { resolveRegistered: WorkspaceResolver | undefined; fixedPoints?: BoardStatePath[] },
): Promise<string> {
  const branch = protectedBranch(workspace);
  if (isRemoteBacked(withRememberedRepoCheck(db, workspace, now))) {
    throw new DomainError(`workspace ${workspace.name} is remote-backed, so ${branch} is changed on origin.${originRoute(workspace)}`);
  }
  const at = CHECKOUT_LAYOUT.workbench.at(base, workspace, branch);
  if (!holdsBaseline(db, workspace.name)) await captureFirstBaseline(db, workspace, at, { ...board, now });
  let question = openIntakeQuestionId(db, workspace.name);
  let opened: { path: string; owner: WorkbenchOwner };
  try {
    // 書く先の branch の確かめも作業台に撃つ git —— 読めなければ question が閉じているときと同じ文(#3587)
    if (question !== undefined && holdsTargetBranch(at, branch)) {
      opened = { path: realpathSync(at), owner: judgeOnDisk(workspace, at, branch) };
      // 開くたびに `board/*` を引き直す —— 前の引き直しが名前の場所の側で落ちて消えた `board/*` を、名前の場所の拒否として言い直す(ADR 0411 決定5)
      repointBoardRefs(workspace, opened.path);
    } else opened = openWorkbench(workspace, base, branch);
  } catch (err) {
    if (err instanceof WorkbenchUnreadableError) throw new DomainError(`the board cannot read the workbench at ${err.at} (${err.message}); remove it by hand, then open it again.`);
    throw new DomainError(couldNotOpenWorkbench(err, "open it again", { subject: "the board" }));
  }
  const { path, owner } = opened;
  const held = heldCommitsClause(owner, branch);
  if (question === undefined) {
    // spec #3273 text A13
    const title = `take in commits for ${branch} of workspace ${workspace.name}`;
    question = registerTask(
      db,
      {
        type: "question",
        title,
        purpose:
          `You opened the workbench at ${path}. Commit on ${branch} there ${fromOwnClone(branch, boardBranch(branch))}. ` +
          `\`take in\`: the board checks the tip and writes it to ${branch}. \`close\`: closes this question and takes nothing in; the workbench stays on disk.${held}`,
        completion_criteria: "a human takes the workbench's commits in or closes the question",
        question: [{ title, options: [...INTAKE_OPTIONS], recommendation: INTAKE_OPTIONS[0] }],
        question_kind: { kind: "intake", workspace: workspace.name },
        workspace: workspace.name,
      },
      now(),
      caller.actorId,
      caller.origin,
    ).id;
  }
  // spec #3273 text A14
  return `opened the workbench at ${path} for ${branch} of workspace ${workspace.name}; answer question ${question} when your commits are there.${held}`;
}

/** 基準の行の無い名前の最初の撮りを止めている Quarantine —— その種類と値、止めている workspace の名前、開いている question。 */
type FirstCaptureHold = { quarantine: "workspace" | "workspaceContainment"; value: string; workspace: string; question: string };

/** ADR 0373 決定13 追記: 基準の行の無い名前 `name` の最初の撮りを止めている Quarantine —— その名前自身の Quarantine と、
 *  基準の行を持つ面接室でない名前の Quarantine(workspace・組の封じ込め)。無ければ undefined。 */
function firstCaptureHold(db: Db, name: string): FirstCaptureHold | undefined {
  const own = openQuarantineQuestion(db, "workspace", name);
  if (own) return { quarantine: "workspace", value: name, workspace: name, question: own.id };
  const open = [
    ...[...openQuarantineQuestions(db, "workspace")].map(([value, question]): FirstCaptureHold => ({ quarantine: "workspace", value: value!, workspace: value!, question })),
    ...[...openQuarantineQuestions(db, "workspaceContainment")].map(([value, question]): FirstCaptureHold => ({
      quarantine: "workspaceContainment",
      value: value!,
      workspace: parseWorkspaceContainmentValue(value!).workspace,
      question,
    })),
  ];
  return open.find((held) => holdsFirstCaptures(db, held.workspace));
}

/** ADR 0383 決定1・2: 基準の行の無い名前の `open_workbench` は、pickup の最初の撮りと同じ準備を通ってから撮る —— 基準の行を持つ名前の
 *  Quarantine が開いている間の待ち(ADR 0373 決定13 追記。この名前自身の Quarantine の間も pickup と同じく進まない)、pickup が開く前に
 *  掛ける項、決定13 の確認と全撮り(`prepareRefBaseline`)。判定は pickup と同じ関数が持つ。落ちれば止めた Quarantine を名指して拒み
 *  (text C1a の形)、作業台も question も開かない。registry が読めない落ち方は Quarantine を立てず、その理由を言う。Quarantine の待ちの後、撮る前に
 *  shallow な名前の場所を拒む(ADR 0414 決定4、`workbench` は開く作業台の番地)。 */
async function captureFirstBaseline(
  db: Db,
  workspace: WorkspaceConfig,
  workbench: string,
  board: { resolveRegistered: WorkspaceResolver | undefined; fixedPoints?: BoardStatePath[]; now: () => Date },
): Promise<void> {
  refuseWhileHeld(db, workspace.name, "open a workbench");
  // ADR 0414 決定4: shallow の確かめは撮るより前 —— 拒んだ扉は基準の行を残さない
  refuseShallowBeforePreparation(workspace, workbench);
  const { now } = board;
  const named = withRememberedRepoCheck(db, workspace, now);
  await preparedOrRefused(db, workspace, "open a workbench", { now }, async () => {
    fireBeforeOpenPredicates(named, checkoutPickupPredicates(named, board.fixedPoints));
    prepareRefBaseline(db, named, { resolveRegistered: board.resolveRegistered, now });
  });
}

/** spec #3273 text C1a: 盤面の行為 `verb` を止めている Quarantine を名指して拒む。 */
const quarantinedRefusal = (verb: string, name: string, question: string) =>
  new DomainError(`cannot ${verb}: workspace ${name} is quarantined — answer question ${question} first.`);

/** その workspace の Quarantine が開いている間は拒む(#3155 の追加要件)。基準の行の無い名前は、基準の行を持つ名前の Quarantine の間も
 *  待つ(ADR 0373 決定13 追記 —— `firstCaptureHold` は自分の Quarantine を先に見る)。text C1a。 */
function refuseWhileHeld(db: Db, name: string, verb: string): void {
  const own = openQuarantineQuestion(db, "workspace", name);
  const held = holdsBaseline(db, name) ? own && { workspace: name, question: own.id } : firstCaptureHold(db, name);
  if (held) throw quarantinedRefusal(verb, held.workspace, held.question);
}

/** ADR 0067 決定2 の pickup 側の扉(修復の中身は ADR 0093 決定8)。pickup の門と準備が落ちた瞬間に**1回だけ**、その repo の token を
 *  仲介が出せるかを訊き、出せなければ install の案内を quarantine の理由に連ねる。pickup と人間担当の work の扉の準備が共有する。
 *
 *  訊かない条件は2つで、どちらも今日どおり quarantine に落ちる: `github` 不在(盤面が GitHub 身元を持たない)と、`repo` が github.com を
 *  指していない(非 GitHub の remote / remote 正本の宣言そのものが無い)。撃ち直しはしない —— install も push 権限も GitHub 側の人間の
 *  操作であり、盤面がこの場で直せる手は無い。`live` は pickup の継続の門(#1973): 失敗が届いた時点か修復の問い合わせの後に session が
 *  終わっていれば、問い合わせも quarantine もせず undefined —— 資源の事実は次の pickup が同じ準備でやり直す。 */
export async function quarantineWithRepoAccessGuidance(
  db: Db,
  github: GitHubClient | undefined,
  workspace: WorkspaceConfig,
  err: unknown,
  now: () => Date,
  live: () => boolean = () => true,
): Promise<ResourceStop | undefined> {
  if (!live()) return undefined;
  const pickupCause = err instanceof PickupGateError ? err.cause : err;
  // ADR 0377 決定4: keep the fixed-point refusal when a workspace also has repo drift.
  if (pickupCause instanceof BoardStateOverlapError) return quarantineWorkspace(db, workspace.name, err, now());
  // ADR 0378 決定3・6〜8: a different origin or declared repo is a local repair. A token probe cannot change the result.
  if (pickupCause instanceof RemoteRepositoryMismatchError || pickupCause instanceof WorkspaceRepoMismatchError) {
    return quarantineWorkspace(db, workspace.name, err, now());
  }
  // 宣言そのものが無い(`isRemoteBacked` が偽)workspace も、非 GitHub の remote と同じ `undefined` に落ちる —— どちらもこの扉を持たない
  let ref: RepoSlug | undefined;
  try {
    ref = workspaceNetworkDestination(workspace)?.github;
  } catch (cause) {
    if (!(cause instanceof WorkspaceRepoMismatchError || cause instanceof RemoteRepositoryMismatchError)) throw cause;
    return quarantineWorkspace(db, workspace.name, cause, now());
  }
  let guidance: string | null = null;
  // 仲介の断りも到達失敗も `tokenRefusal` が理由の文字列に畳むので、ここは投げない
  if (github && ref) guidance = (await repairRepoAccess(github, ref)).guidance;
  if (!live()) return undefined;
  // 案内は元の原因を**置き換えず**に連結する —— なぜ落ちたか(生の git のエラー)と何をすれば直るかは別の情報で、どちらも人間の1つの question に載る
  const cause = guidance ? new Error(`${err instanceof Error ? err.message : String(err)}\n\n${guidance}`) : err;
  return quarantineWorkspace(db, workspace.name, cause, now());
}

/** text C1a: `prepare`(pickup と同じ準備)の失敗を pickup と同じ workspace の Quarantine にして、止めた Quarantine を名指して拒む。
 *  基準の違反は落ちた場所の名前で止め、ほかは repo アクセスの修復案内を添える(scheduler の pickup と同じ枝)。registry が読めない落ち方は
 *  Quarantine を立てずにその理由を、盤面の側の checkout が作れない落ち方は名前の場所を止めずにその理由を言う。 */
async function preparedOrRefused(
  db: Db,
  workspace: WorkspaceConfig,
  verb: string,
  board: { now: () => Date; github?: GitHubClient },
  prepare: () => Promise<void>,
): Promise<void> {
  const stopped = (stop: ResourceStop) => quarantinedRefusal(verb, stop.value!, openQuarantineQuestion(db, "workspace", stop.value)!.id);
  try {
    await prepare();
  } catch (err) {
    if (err instanceof FirstCaptureRefusedError) throw stopped(err.stop);
    if (err instanceof FirstCaptureRegistryReadError) throw new DomainError(`cannot ${verb}: the board could not read the registry (${err.message}).`);
    if (err instanceof CheckoutHostError) throw new DomainError(`cannot ${verb}: ${err.message}`);
    const place = err instanceof PickupGateError ? err.place : workspace;
    if (err instanceof RefsMovedError || (err instanceof PickupGateError && err.cause instanceof RefsMovedError)) {
      throw stopped(quarantineWorkspace(db, place.name, err, board.now()));
    }
    throw stopped((await quarantineWithRepoAccessGuidance(db, board.github, place, err, board.now))!);
  }
}

/** 人間担当の work の扉の準備の材料 —— pickup の準備と同じもの(読む場所は門が組む)に、門の固定点と修復案内の GitHub client。 */
export type HumanWorkPreparation = Omit<PickupPreparation, "reads" | "live"> & { fixedPoints?: BoardStatePath[]; github?: GitHubClient };

/** ADR 0374 決定2・6: `start_work` と、タスクブランチを持つ人間担当の work の完了の準備 —— その workspace の Quarantine の間は拒み、
 *  pickup と同じ門・fetch・基準の比較か最初の撮りを通す。落ちれば pickup と同じ Quarantine を立てて text C1a で拒む。 */
export async function prepareHumanWork(db: Db, workspace: WorkspaceConfig, task: Task, verb: string, board: HumanWorkPreparation): Promise<void> {
  refuseWhileHeld(db, workspace.name, verb);
  await preparedOrRefused(db, workspace, verb, board, async () => {
    const reads = await pickupGate(db, workspace, task, board.workspacesBaseDir, board.now, board.fixedPoints);
    await preparePickupPlace(db, workspace, task, { ...board, reads });
  });
}

/** ADR 0374 決定2・3: 書き始める(`start_work`)—— shallow の確かめと準備を通し、作業台を開いて(`board/*` の受け取りまで)から1つの固定の
 *  瞬間(自分の空の列、タスクブランチを持たない未決着の work の祖先を上から、その時点の系譜から `task/<H>`。各 task の列・ref・event は
 *  一緒に書く)、`board/*` を引き直して `task_work_started` を残す(順は ADR 0414 決定1〜4)。2回目以降は同じ在り処を返して `board/*` を
 *  引き直し、disk から消えた作業台は `task/<H>` から開き直す。名前の場所の作業ツリーも HEAD も動かさない。固定の失敗は準備の失敗と同じに
 *  扱い(pickup はタスクブランチの作成の失敗も同じ Quarantine にする)、この呼び出しが作った作業台を消す。作業台を開けない失敗は名前の場所を
 *  止めずに拒む。返すのは作業台の在り処。ADR 0390 決定1・2: 準備の後の同じ同期区間で、系譜の帰り先の持ち主が解放を負えば
 *  何も書かずに拒む(系譜を読む git の失敗は固定の失敗と同じに扱う)。 */
export async function startHumanWork(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
  caller: Answerer,
  board: HumanWorkPreparation,
  /** 最後の await の後に扉の門を掛け直し、今の行を返す(拒むなら投げる)—— 準備の fetch の間に Edit や cancel が行を替えうる。 */
  recheck: () => Task,
): Promise<string> {
  const verb = "start work";
  const target = taskBranch(task.id);
  const couldNotOpen = (err: unknown) => new DomainError(`cannot ${verb}: ${couldNotOpenWorkbench(err, "start work again", { subject: "the board" })}`);
  // ADR 0414 決定4: shallow の確かめは Quarantine の待ちの後、準備(基準の比較か最初の撮り)より前 —— pickup と同じ順。完了と取り込みが
  // 共有する準備には入れない(shallow になった名前の場所にも今どおり届く、#3788)
  refuseWhileHeld(db, workspace.name, verb);
  refuseShallowBeforePreparation(workspace, workbenchAt(workspace, board.workspacesBaseDir, target), `cannot ${verb}: `);
  await prepareHumanWork(db, workspace, task, verb, board);
  task = recheck();
  let refusal: DomainError | undefined;
  let workbench: { path: string; opened: boolean } | undefined;
  await preparedOrRefused(db, workspace, verb, board, async () => {
    // ADR 0390 決定2: 固定の瞬間(`fixTaskAndUnstartedAncestors`)まで await は無い。系譜を読む git の失敗は Quarantine に畳み、拒否はこの外で投げる(中で投げても畳まれる)
    refusal = returnOwnerRefusal(db, workspace, lineageTaskBranch(db, workspace, task, board.now), verb);
    if (refusal) return;
    // ADR 0414 決定1・2: 作業台(`board/*` の受け取りまで)を先に作り、通ってから固定を書く —— 名前の場所の側で落ちる扉は固定を何も書かない
    const copy = copySourceBeforeFixing(db, workspace, task, board.now, board.defaultWorkspaceName);
    try {
      workbench = openHumanWorkWorkbench(workspace, board.workspacesBaseDir, target, copy);
    } catch (err) {
      // 作業台を開けないのは人間が壊した作業台か host の事情 —— 名前の場所を止めず、開き直しを案内する(text C2b の開けない形と同じ)。
      // 名前の場所の側の拒否はその文のまま(ADR 0411 決定5)、Quarantine にしない
      refusal = couldNotOpen(err);
      return;
    }
    const now = board.now();
    try {
      fixTaskAndUnstartedAncestors(db, workspace, task, board.defaultWorkspaceName, now, { forkSource: copy.forkSource, fillOwnColumn: true });
    } catch (err) {
      // ADR 0414 決定2: この呼び出しが作った作業台だけ消す —— 前から disk にある作業台は人間の commit を持ちうる
      try {
        if (workbench.opened) rmSync(workbench.path, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // 固定が落ちた理由を消さない
      }
      throw err;
    }
  });
  if (refusal) throw refusal;
  const { path, opened } = workbench!;
  // ADR 0414 決定3: 固定の後に `task/<H>` と固定した祖先のブランチを `board/*` へ足す —— ここで落ちるのは作業台と host の側だけで、今の「開けない」拒否
  try {
    repointOpened(workspace, path, opened);
  } catch (err) {
    throw couldNotOpen(err);
  }
  if (!hasStartedWork(db, task.id)) appendEvent(db, { taskId: task.id, ...caller, at: board.now(), payload: { kind: "task_work_started" } });
  return path;
}

/** spec #3273 text C8: 作業台の無い人間担当の work の取り込み。 */
export const NO_WORKBENCH = "this task has no workbench — run start_work first.";

/** spec #3273 text A8b / C8: 作業台の tip が書く先に含まれ、取り込むものが無い。 */
const nothingToTakeIn = (target: string, path: string) => `nothing to take in: ${target} in the workbench at ${path} is the value the board already has.`;

/** spec #3273 text C2e(`verb` は答え直す行為)。 */
const workbenchGone = (at: string, target: string, verb: string) =>
  `the workbench of this task is gone from ${at}; commits that were not taken in are lost. Run start_work to open it again from ${target}, then ${verb} again.`;

/** ADR 0374 決定6〜11 / spec #3273 group C: タスクブランチを持つ人間担当の work の完了の、準備の後の同期区間 —— 検査 → `task/<H>` を書く →
 *  `done`(`finish`)→ H の1件の merge back。作業台があれば取り込みを先に(tip が `task/<H>` に含まれれば取り込まない)、無ければ取り込まない。
 *  検査: 系譜の帰り先の持ち主が解放を負っていない(ADR 0390 決定1〜3)、子孫の後始末が済んでいる(text C2c)、書き始めたのに作業台が disk に無くない(C2e)、取り込みの検査(帰り先の値も入力の tip、`task/<H>`
 *  の今の値を含む —— C2a、未 commit —— C2d)、帰り先(系譜で決まる。根は保護ブランチ)へ clean に merge できる(C2b。できなければ帰り先の値を
 *  作業台に引き、作業台が無ければ `task_work_started` を書かずに開く)。ref は await を挟まずに読むので、最後の await の後に動いた ref も見る。
 *  拒否は task に何も書かない。`done` の後の merge back の失敗は積み残しで、後始末と同じく workspace の Quarantine を立てる。`done` では
 *  作業台を消す —— 読んだ後に tip が動いていれば残し、text C7 を返す。消せなければそう言う文を返す。ディレクトリがもう無ければ、消せたときと同じく
 *  文を返さない。 */
export function completeHumanWork(db: Db, named: WorkspaceConfig, task: Task, base: string, caller: Answerer, now: Date, finish: () => void): string | undefined {
  const target = taskBranch(task.id);
  const ref = `refs/heads/${target}`;
  const at = workbenchAt(named, base, target);
  const { lineage, ref: returnRef, name: returnName, sha: returnSha } = returnBranchOf(db, named, task, "complete", now);
  const refusal = returnOwnerRefusal(db, named, lineage, "complete");
  if (refusal) throw refusal;
  const unfinished = teardownUnfinishedUnder(db, task.id);
  if (unfinished) throw new DomainError(`task ${unfinished.id} "${unfinished.title}" under this task is still being torn down — complete again once it has finished.`);
  const place = workbenchOnDisk(named, at);
  if (!place && hasStartedWork(db, task.id)) throw new DomainError(workbenchGone(at, target, "complete"));
  const assertMerges = (tip: string, repo: WorkspaceConfig) => {
    if (isAncestor(repo, returnSha, tip) || writeMergeTree(repo, returnSha, tip) !== undefined) return;
    const conflict = `${target} does not merge cleanly into '${returnName}'.`;
    const merge = boardBranch(shortRef(returnRef));
    let opened: { path: string; opened: boolean };
    try {
      opened = openHumanWorkWorkbench(named, base, target);
    } catch (err) {
      throw new DomainError(`${conflict} ${couldNotOpenWorkbench(err, "complete again and it opens it again")}`);
    }
    const where = opened.opened ? `The board opened the workbench at ${opened.path} for it.` : `In the workbench at ${opened.path}`;
    throw new DomainError(`${conflict} ${where}, on ${target}, run \`git merge ${merge}\` and resolve the conflict ${fromOwnClone(target, merge)}, then complete again.`);
  };
  let taken: { tip: string; commit: string } | undefined;
  try {
    if (place) {
      taken = repointingOnRefusal(named, place.path, () =>
        takeInWorkbench(db, named, place, target, undefined, { workbenchBase: base, entry: "complete_task", answerer: caller, now: () => now }, {
          humanWork: { again: "complete again", gone: workbenchGone(at, target, "complete") },
          otherTasks: taskWriteOtherTasks(db, named, { target, again: "complete again", returnValue: () => returnSha }),
          returnValue: returnSha,
          beforeWrite: ({ tip, verified }) => assertMerges(tip, { ...named, path: verified }),
        }),
      );
    }
    // tip が `task/<H>` に含まれる(取り込むものが無い)か作業台が無い —— 書く値は `task/<H>` の今の値
    if (!taken) assertMerges(git(named.path, "rev-parse", "--verify", ref), named);
  } catch (err) {
    throwHumanWorkRefusal(err);
  }
  finish();
  if (lineage) {
    try {
      mergeBackInto(db, named, base, lineage, task.id, "release");
    } catch (err) {
      quarantineWorkspace(db, named.name, err, now);
    }
  }
  // ADR 0401 決定1 の (3): `done` の後は在り処を読み直さない —— 取り込みの前に読んだ作業台を使い回す。読み直せば作業台が消えたときに記録を
  // 書いた後で素の例外を投げ、扉は出口の文でなく例外を見せる
  if (!place) return undefined;
  return removeDoneWorkbench(named, place, target, taken?.tip);
}

/** ADR 0390 決定1〜3: 系譜の帰り先 `lineage`(`lineageTaskBranch` の値)のタスクブランチの持ち主が解放を負う間の拒否 —— 根(帰り先が
 *  保護ブランチ)と帰り先なしには持ち主が無い。拒まなければ undefined。 */
function returnOwnerRefusal(db: Db, named: WorkspaceConfig, lineage: string | undefined, verb: "complete" | "start work"): DomainError | undefined {
  const owner = lineage === undefined ? undefined : getTask(db, taskIdOfBranch(lineage))!;
  const owed = owner && releaseOwedBy(db, owner);
  if (!owner || !owed) return undefined;
  // ADR 0390 決定3: 人間の回答待ちならその question を名指す。解放待ちは解放をやり直す workspace の Quarantine(子は帰り先と同じ workspace)を、
  // session と後始末は枠の主の session の行(落ちた後始末・閉じ切らなかった session)を待つ。後始末の印がある間は梯子の底の封じ込めの確認も
  // 待ちうるが、その question は盤面全体の鍵で能力検査も立てる(ADR 0033)—— 持ち主の保留は watchdog の記憶にしか無く、ここでは確かめられない
  const question =
    owed === "pending"
      ? openQuarantineQuestion(db, "workspace", named.name)
      : (sessionHaltQuestion(db, owner.id) ?? (owed === "teardown" ? openQuarantineQuestion(db, "containment", null) : undefined));
  return new DomainError(
    `task ${owner.id} "${owner.title}", whose branch this task returns to, is still running or being torn down — ${verb} again once it has finished.${question ? ` Answer question ${question.id} first.` : ""}`,
  );
}

/** ADR 0374 決定8: H の帰り先 —— `parent_id` でなく系譜で決まり、非根は系譜の `task/<P>`、根は保護ブランチ —— の ref・名前・今の値。
 *  ADR 0374 決定6: その値は取り込みと完了の内容の検査の入力の tip でもある。 */
function returnBranchOf(db: Db, named: WorkspaceConfig, task: Task, verb: "take in" | "complete", now: Date): { lineage: string | undefined; ref: string; name: string; sha: string } {
  // ADR 0380 決定3: 帰り先なしを保護ブランチと読まない
  const taken = noReturnAncestor(db, named, task);
  if (taken?.kind === "deleted") throw new DomainError(`cannot ${verb}: ${noReturnCause(taken)}, so this task has no branch to return into.`);
  if (taken) throw new DomainError(lostBranchRefusal(verb, `${taskBranch(taken.ancestor.id)}, the branch this task returns into,`, !isSettled(taken.ancestor.status)));
  const lineage = lineageTaskBranch(db, named, task, () => now);
  const ref = lineage ? `refs/heads/${lineage}` : exactProtectedBranchRef(named);
  return { lineage, ref, name: lineage ?? protectedBranch(named), sha: git(named.path, "rev-parse", "--verify", ref) };
}

/** 人間担当の work の扉の取り込みの失敗のうち、人間が作業台で直せる拒否と名前の場所の側の失敗(文が名前の場所を名指す、ADR 0359 決定4 と同じく
 *  拒むだけ)を回答の拒否にする —— 盤面のほかの失敗は素のまま投げる。 */
function throwHumanWorkRefusal(err: unknown): never {
  const refusal = [IntakeRefusedError, CheckoutUnreadableError, WorktreeStatusError, WorkerTreeGitTimeoutError, CheckoutHostError, NamedPlaceFetchError].some((kind) => err instanceof kind);
  if (refusal) throw new DomainError((err as Error).message);
  throw err;
}

/** ADR 0374 決定5〜7 / spec #3273 group C: 完了を伴わない取り込み(`take_in_work`)の、準備の後の同期区間 —— 作業台の tip を `task/<H>` へ
 *  取り込み、作業台を残してその branch を包む commit へ進め(`advanceKeptWorkbench`)、text C6 を返す。handoff も `done` も merge back も
 *  無く、子孫の後始末が済んでいなくても拒まない。拒否(text C8・C2e・C2a・C2d、作りかけは ADR 0382 決定6 で C2e)は task に何も書かない。 */
export function takeInHumanWork(db: Db, named: WorkspaceConfig, task: Task, base: string, caller: Answerer, now: Date): string {
  const target = taskBranch(task.id);
  const at = workbenchAt(named, base, target);
  const gone = workbenchGone(at, target, "take in");
  // ADR 0374 決定8: 作業台の在り処は disk で読む —— 完了の扉の帰り先との conflict の拒否が開いた作業台は `task_work_started` を持たない
  if (!placeHasRepository(at)) throw new DomainError(hasStartedWork(db, task.id) ? gone : NO_WORKBENCH);
  const place = workbenchPlace(named, realpathSync(at));
  let taken: { tip: string; commit: string };
  try {
    // ADR 0374 決定7: 取り込むものが無い拒否も、拒否として `board/*` を引き直す
    taken = repointingOnRefusal(named, place.path, () => {
      // ADR 0374 決定6: 人間が merge した帰り先の値も入力の tip —— 完了と同じ
      const returnValue = returnBranchOf(db, named, task, "take in", now).sha;
      const intaken = takeInWorkbench(db, named, place, target, undefined, { workbenchBase: base, entry: "take_in_work", answerer: caller, now: () => now }, {
        humanWork: { again: "take in again", gone },
        otherTasks: taskWriteOtherTasks(db, named, { target, again: "take in again", returnValue: () => returnValue }),
        returnValue,
      });
      if (!intaken) throw new DomainError(nothingToTakeIn(target, place.path));
      return intaken;
    });
  } catch (err) {
    throwHumanWorkRefusal(err);
  }
  return advanceKeptWorkbench(named, place.path, target, taken);
}

/** 読んだ後に作業台へ届いた commit を取り込まずに作業台を残した、と言う文。 */
const notTakenInKept = (path: string) => `Commits reached the workbench at ${path} after the board read it and were not taken in; the workbench is kept.`;

/** spec #3273 group C: `done` の後に人間担当の work 自身の作業台の中身を読み直し(在り処は取り込みの前に読んだ `place` のまま)、取り込んだ
 *  tip のまま人間の作業が残っていなければ消す。ディレクトリがもう無ければ、判定せずに消せたときと同じく文を返さない。
 *  tip が読んだものから動いていれば(取り込まなかったときは `task/<H>` に含まれなくなっていれば)残して text C7、ほかに残っているもの
 *  (stash、書く先に無い commit を持つ branch、HEAD の位置、未 commit の変更)や読めない作業台も残して、それを言う。消せない作業台も
 *  そう言う(`removeWrittenWorkbench`)。`done` の後なので拒まない。 */
function removeDoneWorkbench(named: WorkspaceConfig, place: UntrustedCheckout, target: string, takenTip: string | undefined): string | undefined {
  // ADR 0401 決定1 の (3): 消えた作業台は消せたのと同じに終える。`.git` だけ消えてディレクトリが残れば、判定に進んで読めずに残したと言う
  if (!existsSync(place.path)) return undefined;
  let judged: { moved: boolean; left: string[] };
  try {
    judged = judgeWorkbench(named, place, target, { boardMove: true }, (owner, read, workbench) => ({
      moved: owner.kind === "mine" || (takenTip !== undefined && read !== undefined && read.tip !== takenTip),
      // 残った branch と stash の commit が書く先にあるかは名前の場所の値と比べる手(ADR 0411 決定3)
      left: owner.kind === "nothing" ? [] : comparedWithNamedPlace(named, () => humanWorkLeft(workbench!)),
    }));
  } catch (err) {
    if (err instanceof NamedPlaceFetchError) return `completed. ${endSentence(err.message)} The workbench at ${place.path} is kept.`;
    return `completed. The board could not read the workbench at ${place.path} (${err instanceof Error ? err.message : String(err)}), so it is kept.`;
  }
  if (judged.moved) {
    return `completed. ${notTakenInKept(place.path)} The task is done, so they do not enter through it.`;
  }
  if (judged.left.length > 0) return `completed. The workbench at ${place.path} is kept: ${judged.left.join("; ")}. The task is done, so nothing enters through it.`;
  return removeWrittenWorkbench(place.path, "completed.");
}

/** ADR 0371 決定2〜6 / ADR 0382 決定4〜6: `intake` question への `take in` —— 人間自身の内容の作業台の tip を保護ブランチへ取り込む。
 *  条件は local 着地の `merge` と同じ(保護ブランチが基準と一致、workspace の Quarantine が開いていない)に、tip が保護ブランチに含まれれば
 *  拒み(text A8b)、未決着か着地待ち(hold を含む)の task のブランチの commit を持つ tip を拒み(祖先だけ —— cancel した task のブランチと
 *  cherry-pick は通る、text A8c)、書き込む tree が隠せない形を持てば拒む。purely-local であることは答えるときに確かめ直す(text A8d)。
 *  人間しか書けない path は通す。作業台は取り込みの後も消さず(ADR 0382 決定5)、その branch を包む commit へ進める(`advanceKeptWorkbench`)。
 *  返すのは text C6。拒否は ref も記録も書かない。 */
export function takeInHumanContentWorkbench(db: Db, workspace: WorkspaceConfig, intake: Omit<IntakeContext, "entry">): string {
  const branch = protectedBranch(workspace);
  const at = CHECKOUT_LAYOUT.workbench.at(intake.workbenchBase, workspace, branch);
  const shown = existsSync(at) ? realpathSync(at) : at;
  if (isRemoteBacked(withRememberedRepoCheck(db, workspace, intake.now))) {
    throw new Error(
      `workspace ${workspace.name} is remote-backed now, so ${branch} is changed on origin.${originRoute(workspace)} Commits you made in the workbench at ${shown} ` +
        "are not taken in: fetch them from the workbench into your own clone and carry them from there. Answer `close`.",
    );
  }
  assertWorkspaceNotQuarantined(db, workspace);
  const approved = humanContentTargetValue(db, workspace);
  if (!placeHasRepository(at)) {
    throw new Error(`the workbench at ${at} is gone; commits that were not taken in are lost. Open it again with \`open_workbench\` for ${workspace.name}, then answer again.`);
  }
  return takeInHumanContent(db, workspace, at, { ...intake, entry: "intake_question" }, {
    approved,
    nothingNew: (path) => nothingToTakeIn(branch, path),
  })!;
}

/** spec #3273 text A8a: workspace の Quarantine が開いている間、人間自身の内容は取り込まない。 */
function assertWorkspaceNotQuarantined(db: Db, workspace: WorkspaceConfig): void {
  const quarantine = openQuarantineQuestion(db, "workspace", workspace.name);
  if (quarantine) throw new Error(`workspace ${workspace.name} is quarantined — answer question ${quarantine.id} first.`);
}

/** 人間自身の内容の入口が書く先の値として使う、基準と一致する保護ブランチの値。 */
function humanContentTargetValue(db: Db, workspace: WorkspaceConfig): string {
  // ADR 0383 決定2: `open_workbench` が撮るので答える時点では行がある —— 無いのは盤面 DB の直接の書き換えだけで、帯域外の移動とは読まない
  if (!holdsBaseline(db, workspace.name)) {
    throw new Error(`the board holds no baseline for workspace ${workspace.name}, so it cannot check ${protectedBranch(workspace)} — open the workbench again (\`open_workbench\`), then answer again.`);
  }
  return protectedValueAsRecorded(db, workspace);
}

/** ADR 0382 決定4: 人間自身の内容の入口(`take in` と封じ込めの回答)に共通の検査。 */
function humanContentChecks(db: Db, branch: string, checks: Pick<EntryChecks, "approved" | "admit" | "checkedTip">): EntryChecks {
  // spec #3273 text A8c(作業台の在り処を言う —— 文の規則)
  const refusalFor = (branches: string[], tipAt: string) =>
    branches.map((name) => `the tip of the workbench at ${tipAt} contains commits of ${name}, and that task's work enters ${branch} only through its landing — ${landingExit(db, name)}.`).join(" ") +
    ` To take in only your own commits, start ${branch} in the workbench over with \`git reset --hard ${boardBranch(branch)}\`, commit them again and answer again.`;
  return { ...checks, otherTasks: { range: "unsettled or landing-waiting", refusalFor }, humanContent: true };
}

/** ADR 0382 決定4: `take in` と封じ込めの回答が共有する取り込み —— 人間自身の内容の作業台の tip を保護ブランチへ入れ、作業台を残して text C6 を返す。
 *  取り込むものが無ければ、`nothingNew` があればその文で拒み、無ければ undefined。 */
function takeInHumanContent(
  db: Db,
  workspace: WorkspaceConfig,
  at: string,
  intake: IntakeContext,
  { nothingNew, ...checks }: Pick<EntryChecks, "approved" | "admit" | "checkedTip"> & { nothingNew?: (path: string) => string },
): string | undefined {
  const branch = protectedBranch(workspace);
  const place = workbenchPlace(workspace, realpathSync(at));
  const taken = repointingOnRefusal(workspace, place.path, () => {
    const intaken = takeInWorkbench(db, workspace, place, branch, undefined, intake, humanContentChecks(db, branch, checks));
    if (!intaken && nothingNew) throw new Error(nothingNew(place.path));
    return intaken;
  });
  return taken && advanceKeptWorkbench(workspace, place.path, branch, taken);
}

/** 封じ込めの回答が取り込む作業台の在り処と、取り込む tip に掛ける入口の条件: workspace の Quarantine(text A8a)と基準の行の無い名前を拒む。 */
const containmentIntake = (db: Db, workspace: WorkspaceConfig, base: string) => {
  const branch = protectedBranch(workspace);
  const admit = () => {
    assertWorkspaceNotQuarantined(db, workspace);
    humanContentTargetValue(db, workspace);
  };
  return { branch, at: CHECKOUT_LAYOUT.workbench.at(base, workspace, branch), admit };
};

/** ADR 0371 決定6 / ADR 0382 決定4: purely-local の組の回答の取り込み。`take in` と同じ手順で、取り込む tip があるときだけ
 *  workspace の Quarantine(text A8a)と基準の行の無い名前を拒み、書き込む tree が隠せない形を持てば書く前に拒み、人間しか書けない path は通す。
 *  作業台が disk に無いか取り込むものが無ければ undefined —— 回答は検査だけをする(text A8b の拒否ではない、ADR 0373 決定7)。
 *  書く先の branch が無い作業台は開き直して答え直すよう拒む(ADR 0382 決定6)。`checkedTip` は `checkContainmentIntake` が検査した tip で、
 *  作業台がそれを持たなくなっていれば拒む。返すのは text C6。 */
export function takeInContainmentRepair(db: Db, workspace: WorkspaceConfig, intake: Omit<IntakeContext, "entry">, checkedTip?: string): string | undefined {
  const { branch, at, admit } = containmentIntake(db, workspace, intake.workbenchBase);
  if (!placeHasRepository(at)) {
    if (checkedTip !== undefined) throw new Error(checkedTipMoved(at, branch, checkedTip));
    return undefined;
  }
  return takeInHumanContent(db, workspace, at, { ...intake, entry: "containment_quarantine" }, { admit, checkedTip });
}

/** ADR 0371 決定6 / ADR 0379 決定1: Codex の検査は Board call を待つので、取り込みを検査の前後に割る —— 取り込みと同じ検査を通した tip の tree を、
 *  検証済みの写しから使い捨ての checkout に展開して `check` に渡す(包む commit は人間の tip の tree を持つので、名前の場所に候補の commit を作らない)。
 *  取り込むものが無ければ undefined。検査の後は `takeInContainmentRepair` に tip を渡して書く。 */
export async function checkContainmentIntake(
  db: Db,
  workspace: WorkspaceConfig,
  workbenchBase: string,
  check: (path: string) => Promise<ContainmentCapability>,
): Promise<{ tip: string; capability: ContainmentCapability } | undefined> {
  const { branch, at, admit } = containmentIntake(db, workspace, workbenchBase);
  const place = workbenchOnDisk(workspace, at);
  if (place === undefined) return undefined;
  const checks = humanContentChecks(db, branch, { admit });
  const prepared = repointingOnRefusal(workspace, place.path, () =>
    inspectWorkbenchTip(db, workspace, place, branch, undefined, checks, ({ tip, verified, tipRef }) => ({
      tip,
      checkout: openThrowawayCheckout(workspace, workbenchBase, tipRef, verified),
    })));
  return prepared && { tip: prepared.tip, capability: await inThrowawayCheckout(prepared.checkout, check) };
}

/** spec #3273 text B8: 組の検査の拒否に足す、直す先の文 —— 名前の場所で commit すると workspace の Quarantine が立つ。remote-backed は origin の道で、
 *  作業台が残っていれば text A8e まで言う。 */
export function containmentRepairRoute(workspace: WorkspaceConfig, base: string): string {
  const branch = protectedBranch(workspace);
  if (isRemoteBacked(workspace)) return containmentWorkbenchNotTakenIn(workspace, base) || pushFixToOrigin(branch);
  const at = CHECKOUT_LAYOUT.workbench.at(base, workspace, branch);
  return placeHasRepository(at) ? commitFixInWorkbench(realpathSync(at), branch) : ` No workbench is open: ${openWorkbenchExit(branch)}.`;
}

/** spec #3273 text G1: (codex, workspace) の理由と拒否に足す道 —— 盤面は skill の出所を判別しないので条件つきで言う(ADR 0379 決定6)。 */
const ifTheSkillIsTracked = (route: string) => ` If the skill is tracked in the repository:${route}`;

/** text G1 の回答の拒否に足す文。 */
export const codexContainmentRepairRoute = (workspace: WorkspaceConfig, base: string): string => ifTheSkillIsTracked(containmentRepairRoute(workspace, base));

/** spec #3273 text A8e: purely-local の間に開いた作業台が残る workspace が remote-backed になっていれば、その回答のどの拒否にも足す文。無ければ空。 */
export function containmentWorkbenchNotTakenIn(workspace: WorkspaceConfig, base: string): string {
  const branch = protectedBranch(workspace);
  const at = CHECKOUT_LAYOUT.workbench.at(base, workspace, branch);
  if (!isRemoteBacked(workspace) || !placeHasRepository(at)) return "";
  return `${pushFixToOrigin(branch)} Commits you made in the workbench at ${realpathSync(at)} are not taken in: fetch them from the workbench into your own clone and carry them from there.`;
}

/** ADR 0373 決定7・10: 封じ込めの Quarantine の受理の比較 —— pickup と同じ比較器で全 ref を基準と比べ、違えば workspace の Quarantine を立てて拒む
 *  (text B6)。基準は撮り直さない。基準の行が無い名前は比べず行も作らない(repo でない場所も読まない)。 */
export function compareContainmentRefs(db: Db, workspace: WorkspaceConfig, now: Date): void {
  compareOrRefuse(db, workspace, "while the containment Quarantine was open", (err) => {
    quarantineWorkspace(db, workspace.name, err, now);
    return new Error(`${err.message}. Answer the workspace Quarantine (question ${openQuarantineQuestion(db, "workspace", workspace.name)!.id}) first.`);
  });
}

/** ADR 0373 決定1・7: workspace の Quarantine の受理の比較 —— pickup と同じ比較器で名前の場所(面接室の名前なら面接室)の全 ref を基準と比べ、
 *  通れば2値行を畳み、違えば text B2 で拒む。基準は撮り直さない。基準の行が無い名前は比べず行も作らない。repo の無い場所は読まない ——
 *  外側の repo を読まず、前半の項がその場所を拒む(spec #3273 の受理の 3)。 */
export function compareAcceptanceRefs(db: Db, workspace: WorkspaceConfig): void {
  if (!placeHasRepository(workspace.path)) return;
  // Quarantine が開く前に動いた ref(その移動が Quarantine を立てた)にも当たる時の言い方
  compareOrRefuse(db, workspace, "since the board's baseline", (err) => new RefsMovedError(
    `${err.message}. The board does not accept moved refs. Answer \`${RESTORE_THE_BASELINE}\` to put them back; the values it removes stay under ` +
      "`refs/keep-around/<sha>`, and to keep that content you merge or cherry-pick it in a workbench afterwards.",
  ));
}

/** Quarantine の受理の比較の形(ADR 0373 決定7・10): 基準の行が無い名前は比べず、pickup と同じ比較器で比べ、違えば `refuse` の返す拒否を投げる。 */
function compareOrRefuse(db: Db, workspace: WorkspaceConfig, when: string, refuse: (moved: RefsMovedError) => Error): void {
  if (!holdsBaseline(db, workspace.name)) return;
  try {
    compareAndFoldBaseline(db, workspace, when);
  } catch (err) {
    if (!(err instanceof RefsMovedError)) throw err;
    throw refuse(err);
  }
}

/** 削除の扉が人間自身の内容の作業台に見つけたもの: 作業台の在り処、書く先の branch、読めなければ読めなかった場所(作業台か名前の場所)と理由。 */
export type HumanContentWorkbenchLeft = { workbench: string; branch: string; unreadable?: { place: string; error: string } };

/** ADR 0382 決定5: workspace の削除の扉 —— 人間自身の内容の作業台に取り込まれていない人間の作業(書く先に無い commit、作業ツリーの変更、
 *  別の branch や stash)があればそれを、無ければ undefined を返す。名前の場所が読めなければ判定できないので、名前の場所を名指す ——
 *  作業台を消せとは言わない。読めない作業台も拒む。 */
export function humanContentWorkbenchLeft(named: WorkspaceConfig, base: string): HumanContentWorkbenchLeft | undefined {
  const branch = protectedBranch(named);
  const at = CHECKOUT_LAYOUT.workbench.at(base, named, branch);
  if (!placeHasRepository(at)) return undefined;
  const workbench = realpathSync(at);
  const unreadable = (place: string, err: unknown): HumanContentWorkbenchLeft => {
    return { workbench, branch, unreadable: { place, error: err instanceof Error ? err.message : String(err) } };
  };
  try {
    git(named.path, "rev-parse", "--verify", `refs/heads/${branch}`);
  } catch (err) {
    return unreadable(named.path, err);
  }
  let owner: WorkbenchOwner;
  try {
    // 消すのは盤面の手 —— 作りかけは取り込むものが無い(ADR 0382 決定6)
    owner = judgeOnDisk(named, workbench, branch);
  } catch (err) {
    // ADR 0382 決定2: 読めない作業台はどの入口でも拒む —— 帰責は開く扉と同じ手で分け、ほか(上限超過・host・名前の場所への素の git)は
    // 出し直しで通りうるので、参照の拒否(409)にしない
    if (err instanceof WorkbenchUnreadableError) return unreadable(err.at, err);
    if (err instanceof NamedPlaceFetchError) return unreadable(named.path, err);
    // 上限超過の文は worker の tree を名指す —— 人間には作業台の在り処で言う
    if (err instanceof WorkerTreeGitTimeoutError) throw new Error(err.about(`the workbench at ${workbench}`), { cause: err });
    throw err;
  }
  return owner.kind === "nothing" ? undefined : { workbench, branch };
}

/** ADR 0382 決定5: 削除の門と確認を通った workspace の、人間自身の内容の作業台を registry の commit より前に消す(取り込まれていない作業が無いことは
 *  `humanContentWorkbenchLeft` が確かめた)。失敗は投げる —— entry も行もまだ消えていない。 */
export function removeHumanContentWorkbench(named: WorkspaceConfig, base: string): void {
  const at = CHECKOUT_LAYOUT.workbench.at(base, named, protectedBranch(named));
  if (existsSync(at)) removeBoardCheckout(at, CHECKOUT_LAYOUT.workbench.parents);
}

/** text A8c の出口(ADR 0371 決定6 / ADR 0382 決定4: task の内容は着地でだけ保護ブランチに入る): そのブランチの内容が着地する根 —— 祖先の
 *  一番上 —— の開いた着地 question があれば `merge` を、無ければまだ着地していないことを言う。 */
function landingExit(db: Db, branch: string): string {
  const id = taskIdOfBranch(branch);
  const root = (db.prepare(`${ancestorsSql("?")} SELECT id FROM tasks WHERE id IN (SELECT id FROM ancestors) AND parent_id IS NULL`).get(id) as { id: string } | undefined)?.id ?? id;
  const [question] = openLocalMergeQuestionIds(db, root);
  return question ? `answer \`merge\` on question ${question}` : "it has not landed yet";
}

/** ADR 0018 in one place: an entry's own `path`, or — when it omits one — the
 *  convention-derived location under the base dir. Every consumer that has to
 *  know where a workspace's checkout lives goes through this, so the rule never
 *  gets a second spelling (the board-state overlap gate judges a *prospective*
 *  entry with `conventionCheckoutPath` in pickup-predicates.ts, which is the same rule with no
 *  entry to consult yet). */
export function entryCheckoutPath(
  entry: WorkspaceEntry,
  name: string,
  workspacesBaseDir: string,
): string {
  return entry.path ?? conventionCheckoutPath(name, workspacesBaseDir);
}

export type WorkspaceRegistryProtection =
  | { reason: "registry_repository"; repo: string }
  | { reason: "unreadable_registry_origin" };

type WorkspaceProtection = WorkspaceRegistryProtection | { reason: "flag" };

/** ADR 0381 決定1・2: protected = the flag, or the declared `repo` reaches the registry clone's repository. The checkout
 *  is never read: `path` is only the base a relative declaration resolves against, as its network destination does.
 *  Create one reader per operation so a list reads the registry's origin at most once. */
export function workspaceProtectionReader(registryDir: string): (entry: WorkspaceEntry, path: string) => WorkspaceProtection | undefined {
  let registryOrigin: { value: string | undefined | null } | undefined;
  return (entry, path) => {
    if (entry.repo !== undefined) {
      const declared = networkDestination(entry.repo, path);
      registryOrigin ??= { value: readCheckoutRemote(registryDir) };
      const repo = registryOrigin.value;
      if (repo === null) return { reason: "unreadable_registry_origin" };
      if (repo !== undefined) {
        if (sameRepository(declared.url, networkDestination(repo.trim(), registryDir).url)) {
          return { reason: "registry_repository", repo };
        }
      }
    }
    return entry.protected === true ? { reason: "flag" } : undefined;
  };
}

/** Every registered workspace resolved to its checkout (ADR 0040's boot sweep).
 *  The one full-registry enumeration — the name-keyed resolvers above answer
 *  "where does *this* task run", this answers "what is there to check at all".
 *  Never throws for a name it enumerated itself: the keys and the lookup come
 *  from the same registry object. */
export function listRegisteredWorkspaces(
  registry: Registry,
  workspacesBaseDir: string,
): WorkspaceConfig[] {
  return Object.entries(registry.workspaces).map(([name, entry]) => ({
    name,
    path: entryCheckoutPath(entry, name, workspacesBaseDir),
    branch: entry.branch,
    repo: entry.repo,
    head_repo: entry.head_repo,
    review_allowed_commands: entry.review_allowed_commands,
    allowed_domains: entry.allowed_domains,
    human_merge_paths: entry.human_merge_paths,
  }));
}

/** `merge-tree`'s one answer-shaped failure: undefined means conflict; every
 *  other nonzero exit remains an honest tool failure. */
function writeMergeTree(
  workspace: WorkspaceConfig,
  left: string,
  right: string,
): string | undefined {
  const [leftTip, rightTip] = git(workspace.path, "rev-parse", `${left}^{commit}`, `${right}^{commit}`).split("\n");
  try {
    // ADR 0356 決定5: merge-tree can run a repository's custom merge driver even though it leaves the worktree alone.
    return withBoardGit(workspace.path, (view, gitDir) => {
      // pickup・登録・作業台は shallow な名前の場所を拒む(ADR 0411 決定5)。解放の merge back(session の途中で shallow になった名前の場所)と
      // 追いつき(`catchUpTaskBranch`)はまだ届く(#3788)—— 隔離 view に shallow の境界を引き継ぐ
      const shallow = git(workspace.path, "rev-parse", "--path-format=absolute", "--git-path", "shallow");
      if (existsSync(shallow)) writeFileSync(join(gitDir, "shallow"), readFileSync(shallow));
      return view(["merge-tree", "--write-tree", leftTip!, rightTip!]).trim();
    });
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return undefined;
  }
}

/** ADR 0103 決定3 / ADR 0243 決定4: `firstParent` と `secondParent` の merge commit を、ref を書く**前に**作る —— index も
 *  worktree も HEAD も使わずに結果ツリーだけを作り(`merge-tree --write-tree`、git ≥ 2.38)、親をこの順に持つ Tidepool 名義の
 *  commit にする。undefined は conflict で、中断状態はどこにも残らない。 */
function mergeCommit(
  workspace: WorkspaceConfig,
  firstParent: string,
  secondParent: string,
  message: string,
): string | undefined {
  const tree = writeMergeTree(workspace, firstParent, secondParent);
  return tree && git(workspace.path, "commit-tree", tree, "-p", firstParent, "-p", secondParent, "-m", message);
}

/** ADR 0105: the content effect of merging `source` into `candidate`.
 *  History convergence stays as the cheap first answer; divergent history
 *  needs merge-tree so squash/rebase landing reads the same as a merge commit.
 *  Exit 1 is Git's conflict answer (the candidate would change), while every
 *  other failure remains a tool failure. */
export function branchMergeEffect(
  workspace: WorkspaceConfig,
  candidate: string,
  source: string,
): { changesCandidate: boolean; historyConverged: boolean } {
  const historyConverged =
    Number(git(workspace.path, "rev-list", "--count", `${candidate}..${source}`)) === 0;
  if (historyConverged) return { changesCandidate: false, historyConverged };
  const mergedTree = writeMergeTree(workspace, candidate, source);
  return {
    changesCandidate:
      mergedTree === undefined ||
      mergedTree !== git(workspace.path, "rev-parse", `${candidate}^{tree}`),
    historyConverged,
  };
}

/** 盤面がこれから push するタスクブランチの commit(ADR 0231 決定4)。push の前に読む —— PR を作った後で読めずに
 *  落ちれば、開いた PR が記録に残らない。 */
export function taskBranchTip(workspace: WorkspaceConfig, taskId: string): string {
  return git(workspace.path, "rev-parse", `refs/heads/${taskBranch(taskId)}`);
}

/** 出題の写し(ADR 0273 決定3): root の作業ツリーを面接室の保護ブランチの head を親にした盤面名義の commit にし、
 *  受験者が fetch する ref を置く(ADR 0276 決定1)。ADR 0367 決定1: tip の検証と tree の検査は面接室へ運ぶ前に済ませる。 */
export function commitRoomCopy(db: Db, place: RunPlace, taskId: string): string {
  assertTaskCheckout(place, taskId);
  const room = place.namedPlace;
  return withVerifiedUntrustedTip(untrustedTaskCheckout(place), taskBranch(taskId), ({ tip, verified }) => {
    const parent = git(room.path, "rev-parse", "--verify", exactProtectedBranchRef(room));
    const exclude = boardViewExcludes(db, place, taskId, tip, verified);
    return boardWriteTree(place.path, tip, verified, (tree, repo) => {
      assertRecordedParentCommit(room, parent);
      // ADR 0365 決定2: 受験者が populate できない gitlink を足す・進める tree は、面接室へ運ぶ前に拒む。
      const gitlinks = stagedGitlinkChanges({ at: room.path, ref: parent }, { at: repo, ref: tree });
      if (gitlinks.length > 0) throw new RoomCopyGitlinkError(gitlinks);
      // ADR 0273 決定1: 受験者の git の履歴に載るので、盤面の語を持たない件名。
      const head = commitStagedTree(repo, tree, parent, "Add the project files");
      // ADR 0388 決定1: 面接室の借りは tip の写しから外し、staging repo と写しの自前の store で数える。
      borrowNamedAfterStage(verified, room);
      carryIntoNamed(room, { checkout: place.path, noun: TASK_CHECKOUT }, { source: repo, ref: "HEAD", own: repo, tip: head, staged: true, description: "the probe's environment", borrowing: verified });
      const ref = `refs/keep-around/${head}`;
      boardRefWriter(db, room)(ref, head, () => git(room.path, "update-ref", ref, head));
      return head;
    }, exclude);
  });
}

/** 修理子の type は review と同じく lineage に透明(ADR 0272 決定6 / ADR 0279 決定4)。
 *  interview の root もブランチを持たない —— 書けるのは面接室だけ(ADR 0273 決定2)。 */
const transparentToLineage = (type: TaskType): boolean => carriesReadOnly(type) || type === "interview";

/** ADR 0372 決定3: 自分のタスクブランチを切る task の pickup は、同じ workspace に導出される未決着の work の祖先のうち
 *  `task_branch_created` を持たないものを上から固定する —— 空の列に workspace を書き、祖先自身の系譜から ref を作り、event を残す。
 *  導出は「列 → 列が埋まった最も近い祖先 → 既定」(`nearestFilledAncestor`、上で固定した祖先の列もその場で読む)。review の pickup は
 *  lineage に透明なので固定しない。人間担当の祖先も固定する(ADR 0374 決定3)—— 完了の扉が `task/<H>` の merge back を撃つ。
 *  固定の瞬間は `start_work` と pickup がこの1つを呼ぶ: 祖先を上から、最後に task 自身。`fillOwnColumn` は task 自身の空の列も埋めるか
 *  (`start_work`。出所は祖先を埋めた後に読む)。 */
function fixTaskAndUnstartedAncestors(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
  defaultWorkspaceName: string | undefined,
  now: Date,
  { forkSource, fillOwnColumn = false }: { forkSource?: string; fillOwnColumn?: boolean },
): void {
  const ancestors = transparentToLineage(task.type) ? [] : ancestorsFromTop(db, task).filter((ancestor) => fixedAncestorName(db, workspace, ancestor, defaultWorkspaceName));
  // ADR 0414 決定9: 型付きの拒否は書く前に全員を上から確かめる —— 下で拒んでも上の ref・event・列を残さない(event は append-only)。
  // ADR 0428 決定1・2: 在る ref を採る根拠は基準 —— 最初の作成も作り直しも、基準に在る値なら event を補える。
  const baseline = refValues(storedRefs(db, workspace.name));
  const current = taskRefsAtFixing(workspace);
  for (const member of [...ancestors, task]) {
    const ref = `refs/heads/${taskBranch(member.id)}`;
    const actual = current.get(ref);
    if (actual === undefined) {
      // ADR 0427 決定1: 一覧が黙って飛ばす行き先の無い symref と、ref が無い場合を区別する。
      if (gitAnswers(() => gitListing(workspace.path, ["symbolic-ref", "--quiet", "--no-recurse", ref]))) {
        throw new ListingUnreadableError(`git could not read ${ref} before the task branch was fixed: the symbolic ref has no resolved value.`);
      }
      continue;
    }
    const expected = baseline.get(ref);
    if (!baselineAllows(expected, actual.value)) {
      throw taskRefMoved(workspace, ref, "before the task branch was fixed", expected, actual.value);
    }
  }
  // 列の出所だけは書く時に読む —— 上で埋めた祖先の列が下の祖先の出所になる(ADR 0372 決定1・3)。
  // 下の祖先の fork 元の読みは帰り先なしで投げない(#3878): 帰り先を奪う決着した祖先の下に未決着の work は残らない —— give-up は session
  // の終わりを待ち、死んだ祖先の下を倒す(ADR 0380 決定2)。cancel は道連れにし、登録の床は拒む(決定5)。task 自身のブランチが在れば
  // 固定の前の系譜の読みは飛ぶので、それには頼らない
  for (const ancestor of ancestors) {
    const checkedSha = current.get(`refs/heads/${taskBranch(ancestor.id)}`)?.sha;
    createTaskBranch(db, workspace, { ...ancestor, workspace: workspace.name }, now, { checkedSha, filledFrom: filledFrom(db, ancestor) });
  }
  const checkedSha = current.get(`refs/heads/${taskBranch(task.id)}`)?.sha;
  createTaskBranch(db, workspace, task, now, { checkedSha, filledFrom: fillOwnColumn ? filledFrom(db, task) : undefined, forkSource });
}

/** ADR 0372 決定3: 同じ固定の瞬間に `workspace` で固定する祖先なら、列に書く名前(導出の値)。固定しない祖先なら undefined。 */
function fixedAncestorName(db: Db, workspace: WorkspaceConfig, ancestor: Task, defaultWorkspaceName: string | undefined): string | undefined {
  const name = ancestor.workspace ?? nearestFilledAncestor(db, ancestor.parent_id)?.workspace ?? defaultWorkspaceName;
  const unfixed = name === workspace.name && ancestor.type === "work" && !isSettled(ancestor.status) && !hasTaskBranchInForce(db, ancestor.id);
  return unfixed ? name : undefined;
}

/** ADR 0372 決定2 の `column_filled_from`: 空の列を固定が埋める出所 —— 列が埋まった最も近い祖先の id、無ければ `default`。列が埋まって
 *  いれば undefined(固定は埋まった列を書き換えない)。 */
function filledFrom(db: Db, task: Pick<Task, "workspace" | "parent_id">): string | undefined {
  return task.workspace === null ? (nearestFilledAncestor(db, task.parent_id)?.id ?? "default") : undefined;
}

/** ADR 0380 決定3: 帰り先なし —— 数える祖先に、効いている失われた event を持ち透明でない祖先がいる(死んだ祖先。間に無事な祖先を挟んでも)。
 *  spec #3273 group H: 未決着の失われた祖先も、作り直されるまで帰り先なし。ADR 0421 決定3: 削除の扉が着地を終えた到達の記録の無い祖先も。
 *  帰り先を奪う最初の祖先とその種類を返し、無ければ undefined。記録だけで読み、git を当てない。
 *  ADR 0414 決定2: 固定の前の読み(`beforeFixing`)では、同じ瞬間の固定が作り直す未決着の祖先は帰り先を奪わない。 */
export function noReturnAncestor(db: Db, workspace: WorkspaceConfig, task: Pick<Task, "type" | "parent_id">, { beforeFixing = false } = {}): NoReturnAncestor | undefined {
  if (transparentToLineage(task.type)) return undefined;
  return noReturnAncestors(db, workspace.name, task).find(({ ancestor }) => !beforeFixing || isSettled(ancestor.status));
}

/** spec #3273 group H(pin C21): 失われたタスクブランチ `branch` で人間の扉が拒む文。`recreate` は `start_work` の固定が作り直せる
 *  (未決着の task —— ADR 0372 決定3 の固定は未決着の祖先だけを作る)ときだけ案内する。 */
export function lostBranchRefusal(verb: string, branch: string, recreate: boolean): string {
  return `cannot ${verb}: ${branch} was lost when the lost refs were given up${recreate ? ` — run start_work to create it again, then ${verb} again` : ""}.`;
}

/** ADR 0053 / ADR 0105: the live integration branch plus the lineage fact a
 *  root needs when a squash/rebase-landed fork source left history divergent.
 *  ADR 0380 決定3: 答えは祖先のブランチ・保護ブランチ(`branch` が undefined)・帰り先なし(`noReturn`)の3つ。 */
export function resolveTaskBranchLineage(
  db: Db,
  workspace: WorkspaceConfig,
  task: Pick<Task, "type" | "parent_id">,
  /** 保護ブランチの ref か、ref を読むときに覚えた repo を確かめる clock(ADR 0404 決定6)。 */
  protectedRefOrClock: string | (() => Date),
  {
    beforeRefRead,
    beforeFixing,
  }: {
    /** 最初の ref の読みの直前に1度だけ呼ぶ(着地の比較、ADR 0370 決定1)。ref を読まない lineage では呼ばない。 */
    beforeRefRead?: () => void;
    /** 同じ瞬間の固定がまだ書かれていない読み(ADR 0414 決定2)—— 固定の導出が最後に当てる既定。 */
    beforeFixing?: { defaultWorkspaceName: string | undefined };
  } = {},
): { branch: string | undefined; outlivedForkSource: boolean; noReturn?: true } {
  const readingRefs = () => {
    beforeRefRead?.();
    beforeRefRead = undefined;
  };
  let protectedRef: string | undefined;
  const readProtectedRef = () =>
    (protectedRef ??= typeof protectedRefOrClock === "string" ? protectedRefOrClock : protectedBranchRef(withRememberedRepoCheck(db, workspace, protectedRefOrClock)));
  if (transparentToLineage(task.type)) {
    // ADR 0380 決定3: 失われた親のブランチは git で読まない —— 死んだ task に残る RCA は保護ブランチを読む
    if (task.parent_id && taskBranchLostInForce(db, task.parent_id)) return { branch: undefined, outlivedForkSource: false };
    if (task.parent_id) readingRefs();
    return {
      branch:
        task.parent_id && taskBranchExists(workspace, task.parent_id)
          ? taskBranch(task.parent_id)
          : undefined,
      outlivedForkSource: false,
    };
  }

  // ADR 0414 決定2: 固定の前の読みは、固定した後と同じ答えを返す —— ref も作る祖先はそこまでの候補と同じ commit になり、
  // event だけを補う祖先は固定が採る ref の値で数える(ADR 0428 決定1)。
  if (noReturnAncestor(db, workspace, task, { beforeFixing: beforeFixing !== undefined })) return { branch: undefined, outlivedForkSource: false, noReturn: true };
  let candidate: string | undefined;
  let outlivedForkSource = false;
  for (const ancestor of lineageAncestors(db, workspace, task, beforeFixing)) {
    const branch = taskBranch(ancestor.id);
    if (!isSettled(ancestor.status)) {
      candidate = branch;
      continue;
    }
    const base = candidate ?? readProtectedRef();
    readingRefs();
    // ADR 0421 決定5: 着地が終わった着地済みの祖先のブランチが名前の場所に無ければ読まずに飛ばす —— 内容は保護ブランチに在り、失われた event も
    // 書かない。在るかは比べた後に読み(ADR 0370 決定1)、読めない ref は「無い」と読まない(ADR 0427 決定1)
    if (landedForLineage(db, ancestor.id) && !taskBranchPresent(workspace, ancestor.id)) continue;
    const effect = branchMergeEffect(workspace, base, branch);
    if (effect.changesCandidate) candidate = branch;
    else if (!effect.historyConverged) outlivedForkSource = true;
  }
  return { branch: candidate, outlivedForkSource };
}

/** `task/<id>` が名前の場所に在るか —— ADR 0427 決定1 の読み: 読めない ref があれば投げ、「無い」と読まない。`taskBranchExists` は
 *  `rev-parse --verify --quiet` の exit 1 を「無い」と読む旧い読みで、壊れた ref も「無い」と答える。
 *  #3826: for-each-ref は探す範囲の頭にある壊れた packed-refs の行を黙って飛ばす(2.47.0 で測った)—— show-ref はどの位置でも落ちる
 *  (`humanWorkLeft` と同じ読み)。パターンは名前の末尾で照合するので付けずに全部を並べる。 */
function taskBranchPresent(workspace: WorkspaceConfig, taskId: string): boolean {
  const ref = `refs/heads/${taskBranch(taskId)}`;
  return gitListing(workspace.path, ["show-ref"]).split("\n").some((line) => line.endsWith(` ${ref}`));
}

/** ADR 0372 決定4 / ADR 0380 決定3: 系譜に数える祖先から、残る失われた祖先は git を当てずに外す。固定の前の読み(ADR 0414 決定2)では、
 *  同じ瞬間に固定する祖先で `task/<id>` が在れば、その値を固定が採るので数える(ADR 0428 決定1)。 */
function lineageAncestors(db: Db, workspace: WorkspaceConfig, task: Pick<Task, "parent_id">, beforeFixing?: { defaultWorkspaceName: string | undefined }): Task[] {
  const counted = countedAncestors(db, workspace.name, task).filter((ancestor) => !taskBranchLostInForce(db, ancestor.id));
  if (!beforeFixing) return counted;
  const ids = new Set(counted.map(({ id }) => id));
  const adopted = (ancestor: Task) =>
    fixedAncestorName(db, workspace, ancestor, beforeFixing.defaultWorkspaceName) !== undefined && taskBranchExists(workspace, ancestor.id);
  return ancestorsFromTop(db, task).filter((ancestor) => ids.has(ancestor.id) || adopted(ancestor));
}

/** ADR 0053: the nearest work branch in the task's live lineage, or undefined —— the protected branch is the bottom of that lineage, or it has
 *  no return (ADR 0380 決定3). Its callers (merge back at release and at the acceptance's redo, the closed root, the human doors' wait
 *  for the return branch's owner —— ADR 0390 決定1) skip both: they act only on an ancestor's branch. A caller that would read undefined as the protected branch uses `resolveTaskBranchLineage`. */
export function lineageTaskBranch(
  db: Db,
  workspace: WorkspaceConfig,
  task: Pick<Task, "type" | "parent_id">,
  protectedRefOrClock: string | (() => Date),
): string | undefined {
  return resolveTaskBranchLineage(db, workspace, task, protectedRefOrClock).branch;
}

/** 名前の場所の HEAD を保護ブランチへ戻す1手。ADR 0345 決定2: HEAD の行に予告して畳む。ADR 0356 決定5: 人間の checkout で
 *  ignored の削除は撃たない(ADR 0352 の削除は worker が走った checkout のものだった)。 */
function checkoutThroughGate(db: Db, workspace: WorkspaceConfig, branch: string): void {
  const ref = `refs/heads/${branch}`;
  const oldTip = git(workspace.path, "rev-parse", "--verify", "HEAD");
  let tip: string;
  const writes: Array<[string, string]> = [["HEAD", symrefValue(ref)]];
  try {
    tip = git(workspace.path, "rev-parse", "--verify", "--quiet", ref);
  } catch (err) {
    if ((err as { status?: number }).status !== 1 || !isRemoteBacked(workspace) || branch !== protectedBranch(workspace)) throw err;
    // ADR 0356 決定5: preserve checkout's creation of a missing local protected branch from origin.
    tip = git(workspace.path, "rev-parse", "--verify", remoteTrackingRef(branch));
    writes.push([ref, tip]);
  }
  writeBoardRefs(db, workspace, writes, () => {
    writeWithWorktree(db, workspace, oldTip, tip, () => {
      if (writes.length > 1) git(workspace.path, "update-ref", ref, tip, "");
      git(workspace.path, "symbolic-ref", "HEAD", ref);
    });
  });
}

/** ADR 0356 決定5: advancing a checked-out branch and following it are one ref-gate step. */
function advanceBranch(db: Db, workspace: WorkspaceConfig, ref: string, oldTip: string, tip: string): void {
  const follows = headValue(workspace) === symrefValue(ref);
  boardRefWriter(db, workspace)(ref, tip, () => {
    const write = () => git(workspace.path, "update-ref", ref, tip, oldTip);
    if (follows) writeWithWorktree(db, workspace, oldTip, tip, write);
    else write();
  });
}

/** ADR 0356 決定5: check worktree overwrites before the ref write and roll back if the ref write fails. */
function writeWithWorktree(db: Db, workspace: WorkspaceConfig, oldTip: string, tip: string, write: () => void): void {
  if (oldTip === tip) {
    write();
    return;
  }
  const sparse = storedSparsePolicy(db, workspace.name) ?? undefined;
  boardReadTree(workspace.path, oldTip, tip, sparse);
  try {
    write();
  } catch (cause) {
    try {
      boardReadTree(workspace.path, tip, oldTip, sparse);
    } catch (rollback) {
      throw new AggregateError([cause, rollback], `${String(cause)}; worktree rollback failed: ${String(rollback)}`);
    }
    throw cause;
  }
}

/** 帰り先の無い系譜の task の fork 元を問われた —— その task の失敗で、出口は cancel(ADR 0421 決定3)。名前の場所は quarantine しない。
 *  登録の床と人間の扉が先に拒むので、届くのは削除の扉が着地を終える前に登録された task だけである。 */
export class NoReturnLineageError extends Error {
  constructor(task: Pick<Task, "id">, taken: NoReturnAncestor) {
    super(`task ${task.id} has no branch to return to: ${noReturnCause(taken)}. Cancel task ${task.id}.`);
  }
}

/** タスクブランチを切る sha(ADR 0053)。面接室で走る受験者と root は、面接室が提供する切る元から切る(ADR 0386 決定1 / ADR 0276 決定1)。
 *  ADR 0362 決定2: 作成と完了の門が同じ出所を読む。 */
export function taskForkSource(db: Db, workspace: WorkspaceConfig, task: Task, now: () => Date): string {
  if (interviewRole(db, task) !== undefined) return roomForkSource(db, workspace, task);
  return lineageForkSource(db, workspace, task, now).sha;
}

/** 系譜から切る fork 元(ADR 0053)—— 読んだ branch の名前(祖先のタスクブランチか保護ブランチ)とその commit。`beforeFixing` は
 *  `resolveTaskBranchLineage` と同じ。 */
function lineageForkSource(db: Db, workspace: WorkspaceConfig, task: Task, now: () => Date, beforeFixing?: { defaultWorkspaceName: string | undefined }): { branch: string; sha: string } {
  // ADR 0421 決定3: 系譜に透明な review でも、宛先がブランチに依存するものは帰り先の無い系譜で走らせない
  const review = settledNoReturnAncestorOfReview(db, task);
  if (review) throw new NoReturnLineageError(task, review);
  const checked = withRememberedRepoCheck(db, workspace, now);
  const base = exactProtectedBranchRef(checked);
  const lineage = resolveTaskBranchLineage(db, workspace, task, base, { beforeFixing });
  // ADR 0380 決定3: 帰り先なしの task の fork 元は問われない(spec #3273 group H)—— 保護ブランチから切らない
  if (lineage.noReturn) throw new NoReturnLineageError(task, noReturnAncestor(db, workspace, task, { beforeFixing: beforeFixing !== undefined })!);
  return { branch: lineage.branch ?? protectedBranch(checked), sha: git(workspace.path, "rev-parse", `${lineage.branch ?? base}^{commit}`) };
}

/** ADR 0414 決定2: 固定より前に作る複製(作業台・task の checkout)の元 `source` —— タスクブランチを持つ task はそのブランチ、無ければ固定より
 *  前に読む fork 元の commit。`branch` は元を読んだ branch(閉包を受け取れない拒否が名指す)。`forkSource` は固定が `task/<id>` に書く commit
 *  (複製が受け取った値)で、タスクブランチを持つ task には無い。 */
type CopySource = { source: string; branch: string; forkSource?: string };

/** ADR 0414 決定7: 面接室で走る task(受験者・root)の複製の元は面接室が提供するもの(ADR 0386 決定1)—— タスクブランチがあればそれ、
 *  無ければ切る元を面接室で解いた commit で、固定はそれを `task/<id>` に書く。解けなければ `roomForkSource` の文で投げる。 */
function roomCopySource(db: Db, room: WorkspaceConfig, task: Task): Omit<CopySource, "branch"> {
  if (taskBranchExists(room, task.id)) return { source: `refs/heads/${taskBranch(task.id)}` };
  const sha = roomForkSource(db, room, task);
  return { source: sha, forkSource: sha };
}

function copySourceBeforeFixing(db: Db, named: WorkspaceConfig, task: Task, now: () => Date, defaultWorkspaceName: string | undefined): CopySource {
  const own = taskBranch(task.id);
  if (taskBranchExists(named, task.id)) return { source: `refs/heads/${own}`, branch: own };
  const { branch, sha } = lineageForkSource(db, named, task, now, { defaultWorkspaceName });
  return { source: sha, branch, forkSource: sha };
}

/** ADR 0351 決定3 / ADR 0356 決定5: 作成も口を通す plumbing —— 無い行に fork 元の sha を予告する。名前の場所では checkout しない。
 *  ADR 0372 決定2: ref を書いた後に `task_branch_created` を残す。`filledFrom` は同じ固定が空の列に `task.workspace` を書くときの出所で、
 *  列と event は1つの transaction で書く。ADR 0428 決定1: 基準と照合した時点で ref が在れば、そのとき確かめた sha で event だけを補う。
 *  `forkSource` は複製が先に受け取った fork 元の commit(ADR 0414 決定2)—— 無ければここで読む。 */
function createTaskBranch(db: Db, workspace: WorkspaceConfig, task: Task, now: Date, { checkedSha, filledFrom, forkSource }: { checkedSha: string | undefined; filledFrom?: string; forkSource?: string }): void {
  const ref = `refs/heads/${taskBranch(task.id)}`;
  let sha = checkedSha;
  if (sha === undefined) {
    const source = forkSource ?? taskForkSource(db, workspace, task, () => now);
    // 固定の確かめの後で置かれた symref の指し先には書かない。
    boardRefWriter(db, workspace)(ref, source, () => git(workspace.path, "update-ref", "--no-deref", ref, source, ""));
    sha = source;
  } else if (hasTaskBranchInForce(db, task.id)) return;
  // ADR 0273 決定8: 面接室で切る task も列の実環境の名前を残す
  const name = task.workspace ?? workspace.name;
  db.transaction(() => {
    if (filledFrom !== undefined) fillEmptyWorkspace(db, task.id, name);
    appendEvent(db, {
      taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", at: now,
      payload: { kind: "task_branch_created", sha, workspace: name, ...(filledFrom !== undefined && { column_filled_from: filledFrom }) },
    });
    // ADR 0399 決定3: 面接室の受験者は面接室にしか届かず着地しないので記録しない
    if (interviewRootIdOf(db, task) === undefined) recordDeclaredRepo(db, task.id, workspace);
  })();
}

function sparsePatternPath(workspace: WorkspaceConfig): string {
  return resolve(workspace.path, git(workspace.path, "rev-parse", "--git-path", "info/sparse-checkout"));
}

/** ADR 0360 決定1・2: spawn は外す settings の entry 1つにつき除外の行を1つ書く。 */
const boardSparsePattern = (hide: string[]) => ["/*", ...hide.map((path) => `!/${path}`), ""].join("\n");

const configEnabled = (workspace: WorkspaceConfig, key: string) =>
  git(workspace.path, "config", "--type=bool", "--default=false", "--get", key) === "true";

function readSparsePolicy(workspace: WorkspaceConfig): SparsePolicy | undefined {
  const patternPath = sparsePatternPath(workspace);
  return existsSync(patternPath) && configEnabled(workspace, "core.sparseCheckout")
    ? { pattern: readFileSync(patternPath, "utf8"), cone: configEnabled(workspace, "core.sparseCheckoutCone") }
    : undefined;
}

function storedSparsePolicy(db: Db, key: string): SparsePolicy | null | undefined {
  const row = db.prepare("SELECT policy FROM workspace_sparse_policies WHERE name = ?").pluck().get(key) as string | undefined;
  return row === undefined ? undefined : JSON.parse(row) as SparsePolicy | null;
}

function describeChanges(changes: WorktreeChange[], separator: string): string {
  return changes.map(({ path, status }) => `${status} ${displayWorktreePath(path)}`).join(separator);
}

/** 盤面の view が運ばない path(ADR 0360 Status 追記、#3111): `tip`(view の index の種か、種より先にある名前の場所の ref、ADR 0412 決定3)から
 *  導く hidden settings と、ADR 0069 の shadow 残骸。`verifiedTipRepo` があれば `tip` は検証済みの写しから読む。
 *  出題の写し・非完了の退避・完了の門・完了後の観測は同じこの集合を外す —— 綴りが割れれば門が名指すものを退避が運ばない。入れ子の repo は
 *  view 自身が外す(ADR 0365 決定3)。 */
function boardViewExcludes(db: Db, place: TaskCheckoutPlace, taskId: string, tip: string, verifiedTipRepo?: string): string[] {
  // ADR 0360 決定1・2: Claude の spawn だけが settings を隠す。今回の pickup で Codex が走ったなら通常どおり変更を読む。
  const spawn = latestEventOfTask(db, taskId, "worker_spawned");
  const codexPickup = spawn?.payload.harness === "codex" && spawn.id > (latestEventOfTask(db, taskId, "task_picked_up")?.id ?? 0);
  const tipRepo = verifiedTipRepo ?? place.namedPlace.path;
  const readGit = verifiedTipRepo === undefined ? git : workerRepoGit;
  const hide = codexPickup ? [] : recordedSettingsDisposition(tipRepo, tip, readGit).hide;
  const remnants = taskCheckoutRemnants(place.path, (path) => readGit(tipRepo, "ls-tree", "--name-only", tip, "--", path) !== "");
  return [...hide, ...remnants];
}

/** Keep the recorded settings entries `hide` (ADR 0360 決定1) in Git but out of the worker's physical checkout by
 *  writing the task checkout's own sparse-checkout before spawn. The checkout is board-made and recreated at every
 *  pickup, so there is no human sparse state to copy or restore (ADR 0356 決定2、ADR 0293 追記、issue #3032). The
 *  worker's Git env preserves the sparse S bit despite the sandbox's settings stub (ADR 0037 機構2); sparse-checkout
 *  alone cannot. */
export function excludeWorkspaceProjectSettings(place: RunPlace, taskId: string, hide: string[]): void {
  assertTaskCheckout(place, taskId);
  if (hide.length > 0) gitWithInput(boardSparsePattern(hide), place.path, "sparse-checkout", "set", "--no-cone", "--stdin");
  // ADR 0360 決定2: 隠したか否かに依らず盤面自身の実体化を確かめる —— 残れば CLI が読む(ADR 0346 決定1)ので spawn しない
  for (const path of PROJECT_SETTINGS_PATHS) {
    if (!lstatSync(join(place.path, path), { throwIfNoEntry: false })) continue;
    throw new Error(
      hide.includes(path)
        ? `workspace ${place.name}: could not exclude ${path}: still in the task checkout after sparse-checkout`
        : `workspace ${place.name}: ${path} is in the task checkout but not in the recorded tree, so the board has nothing to exclude it with`,
    );
  }
}

/** ADR 0378 決定1: warm the token for the declared repo before a synchronous fetch. */
export async function ensureWorkspaceToken(
  workspace: WorkspaceConfig,
  auth: GitHubAuth | undefined,
  options: { fresh?: boolean } = {},
): Promise<void> {
  const key = workspaceNetworkDestination(workspace)?.key;
  await auth?.ensureToken(key, options);
}

/** ADR 0241 決定1: 収束が merge 済みの根を保護ブランチと比べる前に、保護ブランチの写しを進める —— 写しは pickup と
 *  後始末の fetch でしか動かず、merge の直後はまだ merge された内容を持たない。走っている session の基準の下で写しを
 *  動かすので、原本の sha を先に知ってから口を通して書く(ADR 0243 決定3)。失敗は投げる(呼び手の根の失敗になる)。 */
export async function refreshProtectedBranch(db: Db, workspace: WorkspaceConfig, auth: GitHubAuth | undefined, now: () => Date): Promise<void> {
  workspace = withRememberedRepoCheck(db, workspace, now);
  if (!isRemoteBacked(workspace)) return;
  await ensureWorkspaceToken(workspace, auth);
  fetchBranchCopy(workspace, auth, protectedBranch(workspace), boardRefWriter(db, workspace));
}

async function ensureHeadRepoToken(workspace: WorkspaceConfig, auth: GitHubAuth | undefined, options: { fresh?: boolean } = {}): Promise<void> {
  // 宣言の無い出元 repo は token が無くても名指して止める —— `auth?.` は引数を評価しない
  const key = landingHeadRepo(workspace).key;
  await auth?.ensureToken(key, options);
}

/** ADR 0376 決定1 / ADR 0395 決定1: PR の無いタスクブランチの出元 repo の head を、上限つき・認証つきの `ls-remote` 1回で読む。exit 0 で行が無ければ
 *  「読めて、無い」で undefined、非ゼロは「読めなかった」で投げる。写しを進める fetch(`fetchBranchCopy`)は使わない —— 無いブランチを
 *  失敗にし、最後に push した値として読む写し(決定3)を書き換える。 */
export async function readTaskBranchHead(db: Db, workspace: WorkspaceConfig, auth: GitHubAuth | undefined, branch: string, now: () => Date): Promise<string | undefined> {
  workspace = withRememberedRepoCheck(db, workspace, now);
  await ensureHeadRepoToken(workspace, auth);
  return remoteBranchSha(workspace, auth, branch, HEAD_REPO_REMOTE);
}

/** ADR 0242 決定1: GitHub の head が手元に無ければ sha で取る。token の取得と、交渉用に ref を読む同期の fetch を分ける
 *  (ADR 0370 決定1)。ADR 0395 決定1: 出元 repo から取り、fetch は `refs/` に何も書かない(FETCH_HEAD だけ)。 */
export function prepareFetchCommitIfMissing(db: Db, workspace: WorkspaceConfig, sha: string, auth: GitHubAuth | undefined, now: () => Date): Promise<() => void> | undefined {
  try {
    git(workspace.path, "cat-file", "-e", `${sha}^{commit}`);
    return;
  } catch {}
  const checked = withRememberedRepoCheck(db, workspace, now);
  return ensureHeadRepoToken(checked, auth).then(() => () => fetchCommit(checked, auth, sha, HEAD_REPO_REMOTE));
}

/** pickup の準備に要る盤面の deps。`live` は pickup の継続の門(#1973、`liveSession`): token の await の後に閉じていれば
 *  git に進まずに戻る —— 呼び手は戻った後に同じ門を読む。 */
type PickupPrep = { githubAuth?: GitHubAuth; live?: () => boolean };

/** pickup の準備: 開く場所すべての ref の基準と鮮度を確かめ、走る場所だけにタスクブランチを立てる
 *  (実環境に root のブランチを立てない、ADR 0273 決定2)。
 *  ADR 0351 決定2: 基準は切れない —— 行が無いか NULL なら最初の撮り、あれば盤面が書く前に除外無しで比べる。以後の書き込みは口が畳む。
 *  比較は読む場所の後半(`reads`、ADR 0329 決定10・11)より前 —— 走る場所の違反は読む場所を書く前に止まる。 */
export async function prepareWorkspaceAtPickup(db: Db, workspace: WorkspaceConfig, task: Task, board: PickupPreparation): Promise<void> {
  // ADR 0411 決定5: task の checkout は閉包を全部持つ複製 —— shallow な名前の場所は、基準の比較か最初の撮り・origin の fetch・タスクブランチの
  // 作成・checkout の作成より前に止める
  assertNotShallow(workspace.path);
  await preparePickupPlace(db, workspace, task, board);
  if (board.live?.() === false) return;
  // ADR 0356 決定1・2: タスクブランチは名前の場所(面接室を含む)の ref として作るだけで、worker は fetch した task の checkout で走る
  const now = board.now();
  const realEnvironment = task.type === "interview" ? board.realEnvironment : undefined;
  if (task.type === "interview" && !realEnvironment) throw new CheckoutHostError(`the real environment for ${task.id} was not supplied at pickup`);
  openTaskCheckout(db, workspace, task, board.workspacesBaseDir, now, {
    defaultWorkspaceName: board.defaultWorkspaceName,
    fix: (forkSource) => fixTaskAndUnstartedAncestors(db, workspace, task, board.defaultWorkspaceName, now, { forkSource }),
    realEnvironment,
  });
}

type PickupPreparation = PickupPrep & {
  reads?: ReadonlyArray<{ place: WorkspaceConfig; predicates: PickupPredicate[] }>;
  /** ADR 0426 決定1: root が読む、pickup の門を通った実環境。 */
  realEnvironment?: WorkspaceConfig;
  /** task の checkout の番地の基点と、開いた event の時刻(ADR 0356 決定2)。時刻は準備の await の後、書く同期区間ごとに読む(#3384)。 */
  workspacesBaseDir: string;
  now: () => Date;
  /** registry の名前を引く口(ADR 0373 決定13 の最初の撮りの確認が引く)。省けない —— 撮る呼び手が渡し忘れれば確認が黙って消える。
   *  undefined は registry の無い盤面で、確認は掛からない。 */
  resolveRegistered: WorkspaceResolver | undefined;
  /** 未着手の祖先の導出が最後に当てる既定(ADR 0372 決定1・3)。undefined は既定の無い盤面。 */
  defaultWorkspaceName: string | undefined;
};

/** pickup の準備のうちタスクブランチを作る前まで —— 基準の比較か最初の撮り、休止中の変更、読む場所、開いた後の項(remote-backed は
 *  origin の保護ブランチの fetch)。`start_work` と人間担当の work の完了も同じ準備を通す(ADR 0374 決定2・6)。 */
async function preparePickupPlace(db: Db, workspace: WorkspaceConfig, task: Task, board: PickupPreparation): Promise<void> {
  // ADR 0401 決定7: 比較が予告中の行を畳む前に読む —— 畳んだ後は途中で止まった移動の証拠が残らない
  const stalledMoveNote = stalledCheckoutMoveNote(db, workspace);
  prepareRefBaseline(db, workspace, board);
  const rootId = interviewRootIdOf(db, task);
  // ADR 0351 決定5: 走る名前の場所だけ、後半が書く前に休止中の変更を読む。shadow の例外は無い。
  // ADR 0356 決定3: 名前の場所(面接室を含む)は自分の git で読む —— 盤面の view は worker が走った checkout のもので、人間の登録前の
  // `info/exclude` を永久の quarantine にしない
  const changes = ownWorktreeStatus(workspace.path);
  if (changes.length > 0) {
    throw PickupGateError.of(workspace, new Error(
      `workspace ${workspace.name} has uncommitted changes while resting: ${describeChanges(changes, "\n")} — a process ${stalledMoveNote ? "may have written" : "wrote"} them after the board moved the checkout.${stalledMoveNote}${discardUncommitted()}`,
    ));
  }
  for (const read of board.reads ?? []) {
    if (safeRealpath(read.place.path) === safeRealpath(workspace.path)) continue;
    // ADR 0351 決定6: 読む場所も後半が書く前に比べ、違反は読む場所の名前で止める。
    try {
      prepareRefBaseline(db, read.place, board);
    } catch (err) {
      if (err instanceof FirstCaptureRefusedError || err instanceof FirstCaptureRegistryReadError) throw err;
      throw PickupGateError.of(read.place, err);
    }
    await firePickupPredicates(db, read.place, read.predicates, "after-open", board);
    if (board.live?.() === false) return;
  }
  const predicates = rootId === undefined ? checkoutPickupPredicates(workspace) : roomPickupPredicates(db, rootId, "");
  await firePickupPredicates(db, workspace, predicates, "after-open", board);
}

/** ADR 0064 決定1: この checkout が今持っている **`refs/*` 全部**。タグも stash も
 *  remote-tracking ref も含む —— 列挙は黙って古くなるので、範囲を名前で切らない。
 *  `for-each-ref` の出力は refname 順に並んでいるので、そのまま1本のテキストとして
 *  持てる(決定6)。比較は行の集合差分で撮るので順序そのものには依らないが、
 *  決定2 が要求する「動いた ref の名指し」が行差分でそのまま取れるのはこの形ゆえで
 *  あり、盤面の書き込みの予告と畳みも同じ refname 順を保つ(`writeBoardRefs`)。
 *
 *  ADR 0081: symref の行だけは解決値ではなく**指し先**を持つ。`for-each-ref` の
 *  既定は symref を解決値で出すので、盤面が `origin/main` を1本書くと `origin/HEAD`
 *  の行まで動き、盤面の書き込みの口(ADR 0243)が名指しした1行しか畳まないぶんが
 *  取り残されて無実の quarantine になる。指し先で数えれば行は不変で、symref 自身の
 *  可動部(付け替え・削除・新規作成)は行差分に残る。
 *
 *  ADR 0345 決定2: `for-each-ref` は HEAD を出さないので1行足す。`HEAD` は `refs/` より前に並ぶので refname 順のまま。 */
const REF_SNAPSHOT_FORMAT = "--format=%(if)%(symref)%(then)symref=%(symref)%(else)%(objectname)%(end) %(refname)";

function taskRefsAtFixing(workspace: WorkspaceConfig): Map<string, { value: string; sha: string }> {
  // ADR 0427 決定1: for-each-ref が先頭の壊れた packed-refs の行を黙って飛ばす形は show-ref で止める(#3826)。
  gitListing(workspace.path, ["show-ref"]);
  const refs = gitListing(workspace.path, ["for-each-ref", "--format=%(objectname) %(symref) %(refname)", "refs/heads/task/"]);
  return new Map(refs.split("\n").filter(Boolean).map((line) => {
    const [sha, target, ref] = line.split(" ") as [string, string, string];
    return [ref, { value: target ? symrefValue(target) : sha, sha }];
  }));
}

function readRefSnapshotValue(workspace: WorkspaceConfig, ref: string): string {
  return refValues(git(workspace.path, "for-each-ref", "--count=1", REF_SNAPSHOT_FORMAT, ref)).get(ref) ?? "";
}

function currentRefs(workspace: WorkspaceConfig): string {
  const refs = git(workspace.path, "for-each-ref", REF_SNAPSHOT_FORMAT);
  return `${headValue(workspace)} HEAD${refs && `\n${refs}`}`;
}

/** 基準の symref の行の値(ADR 0081: 解決値でなく指し先)。 */
function symrefValue(target: string): string {
  return `symref=${target}`;
}

/** 基準の行の値が symref なら指し先、そうでなければ undefined(`symrefValue` の逆)。 */
function symrefTarget(value: string): string | undefined {
  return value.startsWith("symref=") ? value.slice("symref=".length) : undefined;
}

/** 書き込み後の HEAD の tip: HEAD の値、symref なら指し先の値。値の出所は呼び手が決める。 */
function tipAfter(valueAfter: (ref: string) => string): string {
  const head = valueAfter("HEAD");
  const target = symrefTarget(head);
  return target === undefined ? head : valueAfter(target);
}

/** 基準の HEAD 行の値: 指し先、detached なら sha。`symbolic-ref -q` の非零は 1 が detached で、他は道具の失敗。 */
function headValue(workspace: WorkspaceConfig): string {
  try {
    return symrefValue(git(workspace.path, "symbolic-ref", "-q", "HEAD"));
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return git(workspace.path, "rev-parse", "HEAD");
  }
}

/** ADR 0373 決定13: 最初の撮りの確認に落ちた —— 落ちた workspace の Quarantine はもう立っていて、`stop` がそれを名指す。
 *  撮りに来た task(や着地)はこの停止で待つ(spec #3273)。 */
export class FirstCaptureRefusedError extends Error {
  constructor(readonly stop: ResourceStop) {
    super(stop.reason);
  }
}

/** ADR 0373 決定13: 最初の撮りの確認が registry を読めなかった —— 引けない名前に数えず、task 自身の registry の読みの失敗と同じく
 *  走らなかった pickup の失敗にする(どの名前の Quarantine でもない)。 */
export class FirstCaptureRegistryReadError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

function prepareRefBaseline(db: Db, workspace: WorkspaceConfig, board: { resolveRegistered: WorkspaceResolver | undefined; now: () => Date }): void {
  const key = workspace.name;
  const first = !holdsBaseline(db, key);
  const declaration = withRememberedRepoCheck(db, workspace, board.now).checkRememberedRepo(workspace);
  if (!first) compareAndFoldBaseline(db, workspace, "while the checkout rested since the last session");
  else if (board.resolveRegistered && !isInterviewRoomName(db, key)) confirmBaselinesBeforeFirstCapture(db, board.resolveRegistered, board.now());
  const pin = storedSparsePolicy(db, key);
  if (pin !== undefined && !first) return;
  // ADR 0356 決定3: an existing checkout without a pin may already carry worker-written rules.
  const policy = first && pin === undefined ? readSparsePolicy(workspace) : undefined;
  db.transaction(() => {
    if (first) {
      writeSnapshot(db, key, currentRefs(workspace));
      writeRememberedRepo(db, key, encodeWorkspaceRepo(declaration));
    }
    if (pin === undefined) db.prepare("INSERT INTO workspace_sparse_policies (name, policy) VALUES (?, ?)").run(key, JSON.stringify(policy ?? null));
  })();
}

/** ADR 0370 決定1: 着地が名前の場所の ref を読む前の比較 —— pickup と同じ比較器で全 ref を基準と比べ、動いていれば `RefsMovedError`。
 *  基準の行が無い名前は、pickup が開く前に掛ける項(固定点 `fixedPoints` との交差を含む)を撃ってから `prepareRefBaseline` で最初の
 *  撮りをする(ADR 0383 決定2 の Status 追記 / ADR 0399 決定7 —— 最初に触れる入口はどれも同じ項を通る。ADR 0373 決定13 の確認は
 *  `prepareRefBaseline` が掛ける)。項は同期で撃ち、撮るまで await を挟まない。落ちた項は `PickupGateError`(覚えた repo の食い違いは
 *  自分で Quarantine を立てる `WorkspaceRepoMismatchError` のまま、根の記録と宣言の食い違いは素の `DeclaredRepoMismatchError`)。
 *  撮れない間は、止めている Quarantine を持つ `FirstCaptureRefusedError` を投げる(決定13 追記の待ち)。 */
export function compareRefsBeforeLanding(
  db: Db,
  workspace: WorkspaceConfig,
  board: { resolveRegistered: WorkspaceResolver | undefined; fixedPoints?: BoardStatePath[]; now: Date },
): void {
  if (holdsBaseline(db, workspace.name)) {
    compareAndFoldBaseline(db, workspace, "before landing read them");
    return;
  }
  const held = firstCaptureHold(db, workspace.name);
  if (held) throw new FirstCaptureRefusedError({ quarantine: held.quarantine, value: held.value, reason: `workspace ${held.workspace} is quarantined` });
  const now = () => board.now;
  const named = withRememberedRepoCheck(db, workspace, now);
  try {
    fireBeforeOpenPredicates(named, checkoutPickupPredicates(named, board.fixedPoints));
  } catch (err) {
    // 覚えた repo の項は自分で Quarantine を立てる —— 着地へは今までどおり素の `WorkspaceRepoMismatchError` で返す
    throw err instanceof PickupGateError && err.cause instanceof WorkspaceRepoMismatchError ? err.cause : err;
  }
  prepareRefBaseline(db, named, { resolveRegistered: board.resolveRegistered, now });
}

/** 面接室の名前(鍵は root id)。 */
function isInterviewRoomName(db: Db, name: string): boolean {
  return getTask(db, name)?.type === "interview";
}

/** ADR 0373 決定13: registry の名前の最初の撮りの前に、基準の行を持つ workspace(面接室を除く)が全部引けて基準どおりであることを
 *  確かめる —— `workspaces.yaml` の手編集の改名が比べずに基準をやり直さない。比較はいつもの比較器で、通れば2値行を畳む。引けないのは
 *  registry に名前が無いときだけで、registry が読めない失敗は `FirstCaptureRegistryReadError` で投げる(数えない)。落ちた名前の Quarantine を立てて投げる。 */
function confirmBaselinesBeforeFirstCapture(db: Db, resolveRegistered: WorkspaceResolver, now: Date): void {
  const names = db.prepare("SELECT name FROM workspace_state WHERE ref_snapshot <> '' ORDER BY name").pluck().all() as string[];
  for (const name of names.filter((name) => !isInterviewRoomName(db, name))) {
    let place: WorkspaceConfig;
    try {
      place = resolveRegistered(name);
    } catch (err) {
      if (!(err instanceof UnknownWorkspaceError)) throw new FirstCaptureRegistryReadError(err);
      throw new FirstCaptureRefusedError(quarantineWorkspace(db, name, err, now));
    }
    try {
      compareAndFoldBaseline(db, place, "while the checkout rested since the last session");
    } catch (err) {
      // 読めない checkout も基準どおりとは言えない —— 違いと同じくその名前で止める
      throw new FirstCaptureRefusedError(quarantineWorkspace(db, name, err, now));
    }
  }
}

/** ADR 0378 決定6・10: writing refs preserves the remembered repository on an existing row. */
function writeSnapshot(db: Db, key: string, refs: string): void {
  db.prepare(
    `INSERT INTO workspace_state (name, ref_snapshot) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET ref_snapshot = excluded.ref_snapshot`,
  ).run(key, refs);
}

// ADR 0378 決定6: SQL NULL means unlearned; JSON null is a learned purely-local declaration.
function encodeWorkspaceRepo({ path, repo }: Pick<WorkspaceConfig, "path" | "repo">): string {
  return JSON.stringify(repo !== undefined && isRelativeLocalPath(repo) ? networkDestination(repo, path).url : repo ?? null);
}

function readRememberedRepo(db: Db, name: string): string | null | undefined {
  return db.prepare("SELECT remembered_repo FROM workspace_state WHERE name = ? AND ref_snapshot <> ''").pluck().get(name) as string | null | undefined;
}

function writeRememberedRepo(db: Db, name: string, value: string | null): void {
  db.prepare("UPDATE workspace_state SET remembered_repo = ? WHERE name = ?").run(value, name);
}

/** ADR 0391 決定1: publish announces a held baseline's repo before it writes anything; the check folds it (ADR 0391 決定3).
 *  The ADR's `予告の前の値|宛先` is stored as the JSON array `[before, destination]`: an array cannot be mistaken for the 1-value
 *  JSON string or null, and a local path may contain `|` or any other separator. */
export function announcePublishedRepo(db: Db, workspace: WorkspaceConfig): void {
  const { name } = workspace;
  const before = readRememberedRepo(db, name);
  if (before === undefined) return;
  writeRememberedRepo(db, name, JSON.stringify([rememberedValues(before ?? "null")[0], JSON.parse(encodeWorkspaceRepo(workspace))]));
}

/** The remembered values of a learned row: one, or `[before, destination]` while a publish is announced (ADR 0391 決定1). */
function rememberedValues(saved: string): (string | null)[] {
  const value = JSON.parse(saved) as string | null | (string | null)[];
  return Array.isArray(value) ? value : [value];
}

/** A remote predicate (ADR 0378 決定3 for origin, ADR 0395 決定2 for the head repo) as a yes/no: does the checkout's remote agree
 *  with the declaration? */
function remoteAgrees(assertMatches: (workspace: WorkspaceConfig) => void, workspace: WorkspaceConfig): boolean {
  try {
    assertMatches(workspace);
    return true;
  } catch (err) {
    if (err instanceof RemoteRepositoryMismatchError) return false;
    throw err;
  }
}

export class WorkspaceRepoMismatchError extends DomainError {}

/** ADR 0378 決定6〜8: a disagreement is a workspace stop even when the caller ignores a failed network read. */
export function assertRememberedRepo(db: Db, workspace: WorkspaceConfig, now: Date): void {
  const { name, path, repo } = workspace;
  const saved = readRememberedRepo(db, name);
  if (saved === undefined) return;
  if (saved === null) {
    writeRememberedRepo(db, name, encodeWorkspaceRepo(workspace));
    return;
  }
  const values = rememberedValues(saved);
  const destination = (value: string | null | undefined) => value == null ? undefined : networkDestination(value, path).url;
  // ADR 0391 決定2: while announced, either value agrees with the declaration
  const agreed = values.findIndex((value) => sameRepository(destination(value), destination(repo)));
  if (agreed >= 0) {
    // ADR 0391 決定3: fold only once origin agrees too — a remote-backed registry clone can show a stale declaration
    if (values.length > 1 && remoteAgrees(assertRemoteDeclarationMatchesClone, workspace)) writeRememberedRepo(db, name, JSON.stringify(values[agreed]));
    return;
  }
  // ADR 0391 決定2: an announced row names the value before the announcement
  const remembered = values[0] ?? undefined;
  const reason = remembered === undefined
    ? `workspace ${name} was registered as purely-local, but its registry entry now declares repo ${repositoryLabel(repo!)}. Remove \`repo:\`; to give the workspace a remote, publish it.`
    : repo === undefined
      ? `workspace ${name} was registered for repo ${repositoryLabel(remembered)}, but its registry entry no longer declares one. Put \`repo:\` back and answer.`
      : `workspace ${name} was registered for repo ${repositoryLabel(remembered)}, but its registry entry now says ${repositoryLabel(repo)}. Put \`repo:\` back and answer. To move the workspace to another repository, delete it afterwards and register it again.`;
  const mismatch = new WorkspaceRepoMismatchError(reason);
  // Workspace Quarantine adds its own punctuation after the reason.
  quarantineWorkspace(db, name, reason.slice(0, -1), now);
  throw mismatch;
}

function readRememberedHeadRepo(db: Db, name: string): (string | null)[] {
  const saved = db.prepare("SELECT remembered_head_repo FROM workspace_state WHERE name = ?").pluck().get(name) as string | null | undefined;
  return saved == null ? [null] : rememberedValues(saved);
}

function writeRememberedHeadRepo(db: Db, name: string, value: string | null): void {
  db.prepare(
    `INSERT INTO workspace_state (name, remembered_head_repo) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET remembered_head_repo = excluded.remembered_head_repo`,
  ).run(name, value);
}

/** Which remembered head repo the declaration agrees with, or -1. */
function agreedHeadRepo(values: (string | null)[], declared: string | undefined): number {
  return values.findIndex((value) => value === null ? declared === undefined : declared !== undefined && sameRepository(value, declared));
}

/** ADR 0391 決定1 の形を出元 repo に: the update door announces `[before, next]` before it touches the checkout or the registry,
 *  so a door that dies midway leaves a row the check folds back by itself, or stops the workspace on forward (ADR 0415 決定2).
 *  `before` is the remembered value the current declaration agrees with, else the remembered one — a declaration edited outside the
 *  door never becomes `before`. The row is made when the workspace has none yet. */
export function announceHeadRepo(db: Db, workspace: WorkspaceConfig, next: string | undefined): void {
  const values = readRememberedHeadRepo(db, workspace.name);
  const before = values[agreedHeadRepo(values, workspace.head_repo)] ?? values[0] ?? null;
  writeRememberedHeadRepo(db, workspace.name, JSON.stringify([before, next ?? null]));
}

/** Folds the row to the one remembered value `value`. */
function keepRememberedHeadRepo(db: Db, name: string, value: string | null): void {
  writeRememberedHeadRepo(db, name, value === null ? null : JSON.stringify(value));
}

/** ADR 0415 決定2: the check met a head repo change the door did not finish, and has already stopped the workspace. */
export class UnfinishedHeadRepoChangeError extends WorkspaceRepoMismatchError {}

/** ADR 0415 決定1・3: the fold that may delete copies — only the update door and the workspace Quarantine's acceptance call it. On an
 *  unfinished change whose remote agrees with the declaration, it deletes the copies and keeps the "next" value, and returns the
 *  value before the change and how many copies it deleted; undefined when there was nothing to finish. */
export function finishHeadRepoChange(db: Db, workspace: WorkspaceConfig): { previous: string | null; deleted: number } | undefined {
  const { name, head_repo: declared } = workspace;
  const values = readRememberedHeadRepo(db, name);
  const agreed = agreedHeadRepo(values, declared);
  // ADR 0415 決定1: the declaration agrees with "next" and not with "before" (agreedHeadRepo returns the first match)
  if (agreed <= 0) return undefined;
  assertHeadRemoteMatchesDeclaration(workspace);
  // ADR 0376 決定3 / ADR 0395 決定2: copies belong to the old fork until this change is committed.
  const prefix = remoteTrackingRef("", HEAD_REPO_REMOTE);
  const refs = [...new Set([
    ...git(workspace.path, "for-each-ref", "--format=%(refname)", prefix).split("\n").filter(Boolean),
    ...[...refValues(storedRefs(db, name)).keys()].filter((ref) => ref.startsWith(prefix)),
  ])];
  if (refs.length > 0) writeBoardRefs(db, workspace, refs.map((ref) => [ref, ""]), () => {
    for (const ref of refs) git(workspace.path, "update-ref", "--no-deref", "-d", ref);
  });
  keepRememberedHeadRepo(db, name, values[agreed]!);
  return { previous: values[0] ?? null, deleted: refs.length };
}

/** ADR 0395 決定2: the declared head repo must be the one the door remembered — compared on every destination decision and in the
 *  pickup predicate like the remembered repo (ADR 0378 決定6〜8). #3560: nothing remembered never learns — a head repo added outside
 *  the door is a workspace stop, with or without a baseline. The exits name the door's removal, which this check does not gate. */
export function assertRememberedHeadRepo(db: Db, workspace: WorkspaceConfig, now: Date): void {
  const { name, head_repo: declared } = workspace;
  const values = readRememberedHeadRepo(db, name);
  const agreed = agreedHeadRepo(values, declared);
  if (agreed > 0) {
    // ADR 0415 決定2: an unfinished change (as in finishHeadRepoChange). A reader neither folds nor touches a ref — it stops the
    // workspace once; an answer or the door finishes the change
    const previous = values[0];
    const reason = declared === undefined
      ? `workspace ${name}'s removal of head repo ${repositoryLabel(previous!)} is not finished. Answer, and the board deletes the checkout's copies from it and finishes the removal; or set the head repo again in the workspace settings.`
      : previous === null
        ? `workspace ${name}'s change of head repo to ${repositoryLabel(declared)} is not finished. Answer, and the board finishes the change; or clear the head repo in the workspace settings.`
        : `workspace ${name}'s change of head repo to ${repositoryLabel(declared)} is not finished. Answer, and the board deletes the checkout's copies from the previous head repo and finishes the change; or put the head repo back or clear it in the workspace settings.`;
    // Workspace Quarantine adds its own punctuation after the reason.
    quarantineWorkspace(db, name, reason.slice(0, -1), now);
    throw new UnfinishedHeadRepoChangeError(reason);
  }
  if (agreed >= 0) {
    // ADR 0391 決定3 / ADR 0415 決定1: a fold that only writes the row needs no human, once the checkout's head repo remote agrees too
    if (values.length > 1 && remoteAgrees(assertHeadRemoteMatchesDeclaration, workspace)) keepRememberedHeadRepo(db, name, values[agreed]!);
    return;
  }
  const remembered = values[0] ?? null;
  const reason = remembered === null
    ? `workspace ${name} declares head repo ${repositoryLabel(declared!)}, but the board never recorded one for it. Clear the head repo in the workspace settings, or remove \`head_repo:\` by hand, and answer; then set it there to use it.`
    : declared === undefined
      ? `workspace ${name} was given head repo ${repositoryLabel(remembered)}, but its registry entry no longer declares one. Put \`head_repo:\` back by hand and answer; then clear it in the workspace settings to drop it.`
      : `workspace ${name} was given head repo ${repositoryLabel(remembered)}, but its registry entry now says ${repositoryLabel(declared)}. Put \`head_repo:\` back by hand, or clear the head repo in the workspace settings, and answer; then set it there to change it.`;
  const mismatch = new WorkspaceRepoMismatchError(reason);
  // Workspace Quarantine adds its own punctuation after the reason.
  quarantineWorkspace(db, name, reason.slice(0, -1), now);
  throw mismatch;
}

export function withRememberedRepoCheck<T extends WorkspaceConfig>(
  db: Db,
  workspace: T,
  now: () => Date,
  resolveCurrent?: (name: string) => WorkspaceConfig,
): T & Required<Pick<WorkspaceConfig, "checkRememberedRepo">> {
  return {
    ...workspace,
    checkRememberedRepo: workspace.checkRememberedRepo ?? ((place: WorkspaceConfig) => {
      // ADR 0066 決定5 / ADR 0378 決定7: a token lookup can span publish's synchronous update, so check the current declaration.
      const current = resolveCurrent?.(place.name) ?? place;
      assertRememberedRepo(db, current, now());
      assertRememberedHeadRepo(db, current, now());
      if (current.path !== place.path) {
        // ADR 0399 決定3・5: 登録し直しで repo も変わった根には、一般の path の拒否より両方の repo を名指す。
        place.checkDeclaredRepo?.(current);
        throw new RemoteRepositoryMismatchError(`workspace ${place.name}: the registered checkout path changed during the operation. Retry with the current entry.`);
      }
      // ADR 0378 決定3: an earlier pickup predicate only checked the declaration it was given.
      if (current.repo !== place.repo) assertRemoteDeclarationMatchesClone(current);
      if (current.head_repo !== place.head_repo) assertHeadRemoteMatchesDeclaration(current);
      return current;
    }),
  };
}

/** A declaration's `field` in the form the record keeps and compares (ADR 0378 決定4), null when it is not declared (for `repo`,
 *  purely-local). */
function recordedForm(declaration: Pick<WorkspaceConfig, "path" | "repo" | "head_repo">, field: "repo" | "head_repo" = "repo"): string | null {
  const value = declaration[field];
  return value === undefined ? null : comparedRepo(networkDestination(value, declaration.path));
}

/** ADR 0399 決定1: pickup records the declared repo where the task branch is made, after fetch reached the declaration.
 *  A lost branch's rebuild (ADR 0392) keeps the recorded value. */
export function recordDeclaredRepo(db: Db, taskId: string, workspace: Pick<WorkspaceConfig, "path" | "repo">): void {
  db.prepare("UPDATE tasks SET declared_repo = ? WHERE id = ? AND declared_repo IS NULL").run(JSON.stringify(recordedForm(workspace)), taskId);
}

/** ADR 0399 決定1: the first landing write after publish replaces only a purely-local record (JSON null), once. */
export function recordPublishedDeclaredRepo(db: Db, taskId: string, repo: Pick<ReturnType<typeof networkDestination>, "key" | "url">): void {
  db.prepare("UPDATE tasks SET declared_repo = ? WHERE id = ? AND declared_repo = 'null'").run(JSON.stringify(comparedRepo(repo)), taskId);
}

/** ADR 0399 決定1: the one writer of a root's head repo —— `headRepo` is the fork its first push of `task/<id>` reached, or the fork
 *  a PR on that branch was found on. Written once and never overwritten. The destination is read in the comparison's synchronous
 *  section (ADR 0399 決定3 / ADR 0378 決定7). */
export function recordHeadRepo(db: Db, taskId: string, headRepo: Pick<ReturnType<typeof networkDestination>, "key" | "url">): void {
  db.prepare("UPDATE tasks SET head_repo = ? WHERE id = ? AND head_repo IS NULL").run(comparedRepo(headRepo), taskId);
}

/** ADR 0399 決定3: the one comparison of a task's records with the current declaration. Declared repo: no record —— a task without a
 *  row included —— disagrees (fail-closed), a purely-local record agrees with any declaration, a different kind disagrees, the same kind
 *  compares by ADR 0378 決定4. Head repo: a record must equal the declared head repo; no record disagrees only for a root with a
 *  recorded PR under a declaration with a repo. Returns the stop naming both in that form, or undefined when they agree. */
export function declaredRepoDisagreement(db: Db, taskId: string, current: Pick<WorkspaceConfig, "name" | "path" | "repo" | "head_repo">): string | undefined {
  const row = db.prepare("SELECT declared_repo, head_repo, pr_number FROM tasks WHERE id = ?").get(taskId) as
    | { declared_repo: string | null; head_repo: string | null; pr_number: number | null }
    | undefined;
  const recorded = row?.declared_repo == null ? undefined : (JSON.parse(row.declared_repo) as string | null);
  const declared = recordedForm(current);
  const stop = (was: string, declares: string) =>
    `${taskBranch(taskId)} cannot be carried: ${was}, but workspace ${current.name} now ${declares}, so the board does not carry it there.`;
  if (recorded !== null && recorded !== declared) {
    const declares = declared === null ? "declares no repo (purely-local)" : `declares repo ${repositoryLabel(declared)}`;
    return stop(recorded === undefined ? "the board has no record of the repo it was picked up for" : `the board recorded repo ${repositoryLabel(recorded)} for it`, declares);
  }
  const headRepo = recordedForm(current, "head_repo");
  const declaresHead = headRepo === null ? "declares no head repo" : `declares head repo ${repositoryLabel(headRepo)}`;
  const pushed = row?.head_repo ?? null;
  if (pushed !== null) return pushed === headRepo ? undefined : stop(`it was pushed to head repo ${repositoryLabel(pushed)}`, declaresHead);
  const prNumber = row?.pr_number ?? null;
  // ADR 0399 Status 追記: without a declared repo the board reaches no GitHub, so a missing record guards nothing there
  if (prNumber === null || current.repo === undefined) return undefined;
  return stop(`the board has no record of the head repo its PR #${prNumber} was pushed from`, declaresHead);
}

export class DeclaredRepoMismatchError extends DomainError {}

/** ADR 0399 決定1・3: a prior task branch records that preparation reached the repo. A pickup stopped before then can still try for the first time. */
export function pickupRepoCheck(db: Db, task: Task, now: () => Date, resolveRegistered: WorkspaceResolver | undefined) {
  if (interviewRootIdOf(db, task) !== undefined || !hasTaskBranch(db, task.id)) return undefined;
  return (workspace: WorkspaceConfig) => withDeclaredRepoCheck(db, withRememberedRepoCheck(db, workspace, now, resolveRegistered), task.id);
}

/** The pickup entrance's outcome: the task is not compared (Interview tasks, a task without a task branch —— the first cut is #3924), it
 *  is compared (`entered` holds the comparison), or it stopped —— its disagreement question was written, or its name drifted. */
export type PickupEntrance = { outcome: "not compared" } | { outcome: "compared"; entered: EnteredPlace } | { outcome: "stopped" };
/** The entrance's comparison, carried to each place a pickup uses (`enteredAt`). */
export type EnteredPlace = Pick<WorkspaceConfig, "name"> & Required<Pick<WorkspaceConfig, "checkRememberedRepo" | "checkDeclaredRepo">>;

/** ADR 0419 決定1・3: the pickup entrance. A compared task (`pickupRepoCheck`) gets the comparison its issue reads and its preparation
 *  use —— it compares again at every destination read (ADR 0399 決定3) —— or, when its record disagrees with the declaration, the entrance
 *  writes its one stop: no network, no record, no workspace Quarantine. The before-open predicates of every place the pickup gate opens
 *  run first, so a place measured broken without the network stops as that place (`PickupGateError`); a diverged main needs the fetch
 *  and is measured by a later pickup (#3922). A task not compared is not resolved here. */
export async function pickupEntrance(
  db: Db,
  task: Task,
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  workspacesBaseDir: string,
  now: () => Date,
  fixedPoints?: BoardStatePath[],
): Promise<PickupEntrance> {
  const guard = pickupRepoCheck(db, task, now, resolve);
  if (!guard) return { outcome: "not compared" };
  const place = resolveOrQuarantine(db, resolve, derivedWorkspace(db, task), now());
  if (!place) return { outcome: "stopped" };
  // ADR 0419 決定1 / #3922: the gate's places carry no comparison, so a Quarantine's repair guidance cannot turn into the task's stop
  await pickupGate(db, withRememberedRepoCheck(db, place, now, resolve), task, workspacesBaseDir, now, fixedPoints);
  const entered = guard(place);
  const disagreement = declaredRepoDisagreement(db, task.id, { ...entered.checkRememberedRepo(entered), name: entered.name });
  if (disagreement === undefined) return { outcome: "compared", entered };
  stopForRepoDisagreement(db, task, place.name, disagreement, now());
  return { outcome: "stopped" };
}

/** `place`, looked up where it is used, with the entrance's comparison —— the comparison comes only from the entrance. */
export function enteredAt(entered: EnteredPlace, place: WorkspaceConfig): WorkspaceConfig {
  return { ...place, checkRememberedRepo: entered.checkRememberedRepo, checkDeclaredRepo: entered.checkDeclaredRepo };
}

/** ADR 0399 決定3 / ADR 0378 決定7: every destination read for `taskId` compares its declared repo and head repo records with the
 *  rechecked declaration, in the same synchronous section as the read and before the network. It runs after the remembered-repo
 *  check, so a hand-edited `repo:` stays the workspace's stop (ADR 0378 決定6・8). */
export function withDeclaredRepoCheck<T extends WorkspaceConfig>(db: Db, workspace: T, taskId: string): T & Required<Pick<WorkspaceConfig, "checkDeclaredRepo">> {
  return {
    ...workspace,
    checkDeclaredRepo: (current) => {
      const disagreement = declaredRepoDisagreement(db, taskId, current);
      if (disagreement) throw new DeclaredRepoMismatchError(disagreement);
    },
  };
}

/** ADR 0351 決定7: 行の寿命は workspace の寿命 —— 削除の扉が基準と sparse の pin の行ごと消す。残すと同名を別 path で登録し直したとき
 *  旧 checkout の基準と比べる。面接室の行を消すのは `run with an empty room` だけ(ADR 0373 決定11)。 */
export function dropWorkspaceState(db: Db, name: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM workspace_state WHERE name = ?").run(name);
    db.prepare("DELETE FROM workspace_sparse_policies WHERE name = ?").run(name);
  })();
}

/** その名前の行が残っているか —— 撮りを持たない行(出元 repo を覚えただけ)も数える(ADR 0401 決定5)。 */
export function holdsWorkspaceState(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM workspace_state WHERE name = ?").get(name) !== undefined;
}

/** 名前が registry に無いのに行が残るときの原因と出口(ADR 0401 決定5)。登録の扉の拒否と B9 が共有する。削除の扉の commit を
 *  registry の ref で探し、見つかればその sha を、無ければ(手編集)条件つきで戻す先を言う。`registry` が無い呼び手も条件つき。 */
export function leftoverStateExit(name: string, registry: RegistrySource | undefined): string {
  const deletion = registry && doorDeletionCommit(name, registry);
  const cause = deletion
    ? `A deletion of "${name}" stopped midway: registry commit ${deletion} removed the entry, but the board kept its state`
    : `The board found no registry commit from the deletion door for "${name}"; the entry was likely removed or renamed by hand`;
  const restore = deletion
    ? `as it was in workspaces.yaml at ${deletion}^`
    : "as it was before it was removed (in workspaces.yaml at the parent of the commit that removed it, if it was committed)";
  // 覚えた repo と違う宣言は戻した後の2回目の拒否になる(ADR 0378 決定10)
  return `${cause}. To clear it, in order: put the entry back in the registry under that name ${restore}, with its repo and head_repo as well as its path (a repo other than the one the board remembers is refused again); accept the open Quarantine question for "${name}", if any; delete the workspace through the deletion door; register it again (under a new name to rename it)`;
}

/** 削除の扉が registry に打つ commit の message。扉の書き込みと `doorDeletionCommit` の探索が同じ綴りを読む。 */
export function workspaceDeletionMessage(name: string): string {
  return `delete workspace ${name} via WebUI`;
}

/** 名前の top-level の行を最後に変えた commit が削除の扉の commit ならその sha。後の再登録・手編集・revert があれば古い削除を名指さない。
 *  git が読めなければ条件つきの文へ落とす —— B9 の Quarantine を立てる前に投げない。 */
function doorDeletionCommit(name: string, { dir, mode }: RegistrySource): string | undefined {
  try {
    // 名前の規則(英数字・`-`・`_`・`.`、registry の読みも課す)で正規表現に効くのは `.` だけ
    const keyLine = `^${name.replaceAll(".", "\\.")}:`;
    const [sha, subject] = git(dir, "log", "-1", "--format=%H%n%s", "-G", keyLine, registryRef(mode), "--", "workspaces.yaml").split("\n");
    return subject === workspaceDeletionMessage(name) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** 盤面がその名前の基準の行を持つか(ADR 0373 決定13・14)。 */
export function holdsBaseline(db: Db, name: string): boolean {
  return storedRefs(db, name) !== "";
}

function storedRefs(db: Db, workspaceName: string): string {
  const row = db
    .prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?")
    .get(workspaceName) as { ref_snapshot: string | null } | undefined;
  // 行無しと NULL は空文字: 解放では比較が違反として止まる(ADR 0064 決定6)。pickup・作業台を開く操作・着地で最初に触れるときと
  // Quarantine の受理は「まだ基準を持ったことがない」と読む(ADR 0351 決定2 / ADR 0370 決定1 / ADR 0383 決定2)。
  return row?.ref_snapshot ?? "";
}

/** `"<値> <refname>"` の行の集まりを refname → 値 に。値は objectname、symref の行では `symref=<指し先>`、盤面が
 *  予告している行では `<old>|<new>`(ADR 0243 決定1)。無い側は空文字で綴る —— 作成の予告は `|<new>` になる。 */
export function refValues(snapshot: string): Map<string, string> {
  return new Map(
    snapshot
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => [line.slice(line.indexOf(" ") + 1), line.slice(0, line.indexOf(" "))]),
  );
}

/** 基準の行の値が持つ値の集まり: 1値、予告中なら `<old>|<new>` の2値(ADR 0243 決定1)。 */
function baselineValues(recorded: string | undefined): string[] {
  return (recorded ?? "").split("|");
}

/** 基準の行の値が、今の ref の値を「動いていない」と読むか。基準を読む側(pickup と解放の比較 —— ADR 0351 決定2 /
 *  ADR 0064 決定2、着地の帯域外判定 —— ADR 0103 決定1)はどれもこれで解く: 予告中の行は2値のどちらとも一致で通す(ADR 0243 決定2)。
 *  行が無いことと ref が無いことは、どちらも空文字として突き合わせる。 */
function baselineAllows(recorded: string | undefined, actual: string | undefined): boolean {
  return baselineValues(recorded).includes(actual ?? "");
}

/** 盤面自身の記録が持つ `ref` の値、記録に行が無ければ undefined。行の**有無**を
 *  呼び出し側に返すのは、着地の帯域外判定(ADR 0103 決定1)が「記録に無い」を不一致
 *  として扱いつつ、人間へ返す理由をそこで書き分けるためである。 */
function recordedRef(db: Db, workspaceName: string, ref: string): string | undefined {
  return refValues(storedRefs(db, workspaceName)).get(ref);
}

/** 基準の比較で動いた ref が見つかった —— pickup と解放は workspace quarantine に落とし(pickup は repo アクセスの案内を付けない ——
 *  fetch の失敗ではなく、案内は repo アクセスの失敗の瞬間だけのもの、ADR 0067 決定2)、完了の門は資源の停止を登録せず session を回収し
 *  (ADR 0424 決定2・3)、受理のやり直しは回答の拒否として投げる。 */
export class RefsMovedError extends Error {}

/** ADR 0064 の不変条件の1つの比較器で、通れば2値行を畳む(ADR 0351 決定2・4): ref がすべて基準の値のままであることを要求する ——
 *  移動・削除・新規作成のいずれも違反で、削除が最も静かな破壊であるからこそ「動いたものだけを見る」綴りは選ばない(ADR 0064 決定2)。
 *  どの呼び手も何も除かない —— 解放も自分で書いた ref を書いた値で畳んでから比べる(ADR 0359 決定2・4 / ADR 0373 決定12)。通れば、落ちて残った2値行を ref が持つ側に畳む(ADR 0351 決定4)。
 *
 *  メッセージは**動いた ref を名指しする**。quarantine の確認 question の本文に載り、
 *  人間の修理手順がそのまま読める形になる。予告中の行は2値のまま載る。 */
function compareAndFoldBaseline(db: Db, workspace: WorkspaceConfig, when: string): ReadonlyMap<string, string> {
  const before = refValues(storedRefs(db, workspace.name));
  const after = refValues(currentRefs(workspace));
  const moved = [...new Set([...before.keys(), ...after.keys()])].filter((ref) => !baselineAllows(before.get(ref), after.get(ref)));
  if (moved.length > 0) {
    throw new RefsMovedError(
      `workspace ${workspace.name}: refs changed ${when} — ` +
        [
          ...moved.filter((ref) => before.has(ref)).map((ref) => `was: ${before.get(ref)} ${ref}`),
          ...moved.filter((ref) => after.has(ref)).map((ref) => `now: ${after.get(ref)} ${ref}`),
        ].join(", "),
    );
  }
  const announced = [...before].filter(([, value]) => baselineValues(value).length > 1);
  if (announced.length > 0) updateBaseline(db, workspace, (values) => announced.forEach(([ref]) => values.set(ref, after.get(ref) ?? "")));
  return after;
}

/** 基準を書き換える。基準を持たない checkout(盤面がまだ持ったことがない)には何もしない —— 行を作らず、盤面がその名前に最初に
 *  触れる時点(pickup・作業台を開く・着地の収束)が全体を撮る(ADR 0351 決定2 / ADR 0373 決定7 の Status 追記 / ADR 0383 決定2)。保存値の綴りは常に「`currentRefs` の出力」= **refname 順**である(ADR 0064 決定6)。 */
function updateBaseline(db: Db, workspace: WorkspaceConfig, edit: (values: Map<string, string>) => void): boolean {
  const stored = db
    .prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?")
    .get(workspace.name) as { ref_snapshot: string | null } | undefined;
  if (!stored?.ref_snapshot) return false;
  const values = refValues(stored.ref_snapshot);
  edit(values);
  db.prepare("UPDATE workspace_state SET ref_snapshot = ? WHERE name = ?").run(
    [...values]
      .filter(([, value]) => value !== "")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([ref, value]) => `${value} ${ref}`)
      .join("\n"),
    workspace.name,
  );
  return true;
}

function readRef(workspace: WorkspaceConfig, ref: string, readGit = git): string {
  try {
    return readGit(workspace.path, "rev-parse", "--verify", "--quiet", ref);
  } catch {
    return "";
  }
}

/** 畳みの読み返し: 基準の行と同じ綴りで読む。HEAD だけ別なのは指し先で数えるから(ADR 0081)—— `readRef` の sha は未生の HEAD を見分ける呼び手が使う。 */
function readCheckoutValue(workspace: WorkspaceConfig, ref: string): string {
  if (ref !== "HEAD") return readRef(workspace, ref);
  try {
    return headValue(workspace);
  } catch {
    return "";
  }
}

/** ADR 0243 の口: 盤面が ref を書くときはここを通る(ADR 0356 決定5 の worktree の追従も含む)。書く前に基準のその行を
 *  `<old>|<new>` に予告し、`write()` を撃ち、ref を読み返して `new` なら `{new}`、違えば `{old}` に畳む —— 読み返した
 *  値そのものを基準に入れることは無い(決定2)。`write()` が投げても畳んでから投げ直す。予告と畳みの間で盤面が
 *  落ちれば2値の行が残り、どちらの値も違反と読まれない(決定5)—— 次の比較が ref の持つ側に畳む(ADR 0351 決定4)。
 *
 *  `write()` は同期に限る —— 予告→書く→畳むが1つの同期区間になり、盤面の他の書き込みと交差しない。token の取得
 *  (仲介への往復)は呼び手が予告の前に済ませる。
 *
 *  `alsoAnnounce` は refs の予告と同じ transaction で撃つ別の予告 —— publish の覚えた repo(ADR 0391 決定1)。畳みは呼び手が持つ。 */
export function writeBoardRefs(
  db: Db,
  workspace: WorkspaceConfig,
  writes: ReadonlyArray<readonly [ref: string, newValue: string]>,
  write: () => void,
  alsoAnnounce?: () => void,
): void {
  const before = new Map<string, string>();
  // ADR 0391 決定1: publish's remembered repo is announced in the same DB write as the refs, before `write()` —— a refused announcement ends before any trace exists
  const announced = db.transaction(() => {
    alsoAnnounce?.();
    return updateBaseline(db, workspace, (values) => {
      for (const [ref, newValue] of writes) {
        const previous = values.get(ref) ?? "";
        before.set(ref, previous);
        const candidates = baselineValues(previous);
        // ADR 0243 決定5: a retry keeps the existing announcement if it already covers this write.
        if (candidates.length === 1 || !candidates.includes(newValue)) values.set(ref, `${previous}|${newValue}`);
      }
    });
  })();
  if (!announced) {
    write();
    return;
  }
  const fold = () =>
    updateBaseline(db, workspace, (values) => {
      for (const [ref, newValue] of writes) values.set(ref, readCheckoutValue(workspace, ref) === newValue ? newValue : before.get(ref)!);
    });
  try {
    write();
  } catch (err) {
    // 畳みの失敗で書き込みの失敗を置き換えない —— 畳めなかった行は2値のまま残り、落ちた盤面と同じに読まれる
    try {
      fold();
    } catch (foldErr) {
      console.warn(`[workspace] ${workspace.name}: folding the announced baseline failed after the write failed`, foldErr);
    }
    throw err;
  }
  fold();
}

const inFlightNames = new WeakMap<Db, Set<string>>();

/** ADR 0373 決定8: 名前の場所の ref を書く回答と操作が共有する in-flight の鍵 —— 鍵は workspace の名前1つで、盤面(DB)ごとに持つ。
 *  取れれば放す関数を、検査中の別の回答か操作が持っていれば null を返す。 */
export function takeWorkspaceInFlightKey(db: Db, name: string): (() => void) | null {
  const held = inFlightNames.get(db) ?? new Set<string>();
  inFlightNames.set(db, held);
  if (held.has(name)) return null;
  held.add(name);
  return () => held.delete(name);
}

/** 戻す先: 基準と違う ref ごとに基準の値(予告中の行は予告の前の値)、空文字は消す。基準の行が無い名前は比べずに空 —— 戻す先が無い(ADR 0373 決定7)。 */
function restoreTargets(db: Db, workspace: WorkspaceConfig): { current: Map<string, string>; targets: Map<string, string> } {
  const stored = storedRefs(db, workspace.name);
  const baseline = refValues(stored);
  const current = stored === "" ? new Map<string, string>() : refValues(currentRefs(workspace));
  const targets = new Map<string, string>();
  for (const ref of new Set([...baseline.keys(), ...current.keys()])) {
    if (!baselineAllows(baseline.get(ref), current.get(ref))) targets.set(ref, baselineValues(baseline.get(ref))[0]!);
  }
  return { current, targets };
}

function isSha(value: string): boolean {
  return value !== "" && symrefTarget(value) === undefined;
}

/** ADR 0373 決定4: 書き戻しが `ref` の今の値 `value` から keep-around に持ちうる sha —— symref の行(HEAD を含む)は名前なので持たず、`refs/stash` は reflog の各件。 */
function keepAroundCandidates(workspace: WorkspaceConfig, ref: string, value: string): string[] {
  if (!isSha(value)) return [];
  if (ref !== "refs/stash") return [value];
  try {
    return stashEntries(workspace.path);
  } catch (err) {
    // ADR 0409 決定4: 並べられない件は在るか無いか分からない sha と同じ —— 書かずに拒み、text T3 の形で reflog を名指す
    const reported = String((err as { stderr?: unknown }).stderr ?? "").trim() || (err instanceof Error ? err.message : String(err));
    throw new Error(`could not read the reflog of refs/stash in ${workspace.path} (${reported}). Nothing was written; fix what git reports there, then answer again.`, { cause: err });
  }
}

/** ADR 0409 決定4: 戻す先と keep-around に持ちうる値のすべてを手元で読む。1つでも在るか無いか分からなければ、何も書かずに拒む(text T3)。
 *  `present` は sha ごとの答え、`missing` は戻す先の object が手元に無い ref —— 失われたか(ADR 0409 決定1)はまだ決めていない。 */
function readRestore(db: Db, workspace: WorkspaceConfig) {
  const { current, targets } = restoreTargets(db, workspace);
  const keepable = new Map([...targets.keys()].map((ref) => [ref, keepAroundCandidates(workspace, ref, current.get(ref) ?? "")]));
  const shas = new Set([...[...targets.values()].filter(isSha), ...[...keepable.values()].flat()]);
  const present = new Map([...shas].map((sha) => [sha, knownPresence(workspace, sha)]));
  const missing = [...targets].filter(([, value]) => isSha(value) && !present.get(value));
  return { current, targets, keepable, present, missing };
}

/** ADR 0380 決定4 / ADR 0395 決定1・3 / ADR 0409 決定3: 手元に無い戻す先の sha を取りに行き、相手が `not our ref` と答えた sha(lacking)の集合を返す
 *  (purely-local では undefined)。タスクブランチの sha は出元 repo から、取れなければ答えを問わず origin から取り、両方が無いと答えたときだけ集合に入る。
 *  ほかの sha は origin から取る。それ以外の失敗はすべて「分からない」として何も書かずに拒む(text T2)。 */
export async function fetchLostTargets(db: Db, place: WorkspaceConfig, auth: GitHubAuth | undefined): Promise<ReadonlySet<string> | undefined> {
  if (!isRemoteBacked(place)) return undefined;
  // ADR 0409 決定4: token を待つ前に全部を読み、分からなければその場で拒む —— この読みは早く拒むためだけで、失われたかはまだ決めない
  const { missing } = readRestore(db, place);
  const protectedName = protectedBranch(place);
  const taskRef = (ref: string) => ref !== `refs/heads/${protectedName}` && ref !== remoteTrackingRef(protectedName) &&
    (ref.startsWith("refs/heads/task/") || ref.startsWith(remoteTrackingRef("task/")) || ref.startsWith(remoteTrackingRef("", HEAD_REPO_REMOTE)));
  // 記憶した repo の食い違い(ADR 0378 決定6〜8: 食い違いは workspace の停止)は届かなさにも取れなさにも包まない
  const passThrough = (err: unknown) => err instanceof WorkspaceRepoMismatchError || err instanceof RemoteRepositoryMismatchError;
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
  const locationOf = (remote: GitRemote) => remote === HEAD_REPO_REMOTE
    ? place.head_repo === undefined ? "the head repo" : `head repo ${repositoryLabel(place.head_repo)}`
    : "origin";
  const warmed = new Set<GitRemote>();
  const warm = async (remote: GitRemote, shas: string[]) => {
    if (warmed.has(remote)) return;
    try {
      await (remote === HEAD_REPO_REMOTE ? ensureHeadRepoToken : ensureWorkspaceToken)(place, auth, { fresh: true });
    } catch (err) {
      if (passThrough(err)) throw err;
      const location = locationOf(remote);
      throw new Error(`could not reach ${location} to look for ${shas.join(", ")} (${reason(err)}). Nothing was written; answer again once ${location} is reachable.`);
    }
    warmed.add(remote);
  };
  // 取れれば undefined、落ちればその失敗
  const fetchFrom = (remote: GitRemote, sha: string): unknown => {
    try {
      fetchCommit(place, auth, sha, remote);
      return undefined;
    } catch (err) {
      if (passThrough(err)) throw err;
      return err;
    }
  };
  const saysLacking = (err: unknown, sha: string) => err instanceof RemoteLacksObjectError && err.sha === sha;
  const notSaidLackingError = (remote: GitRemote, sha: string, err: unknown) => {
    const location = locationOf(remote);
    // ADR 0409 決定5 / ADR 0395 決定2: 出元 repo が答えないままなら、出口は出元 repo の差し替え
    const exit = remote === HEAD_REPO_REMOTE ? ", or change the workspace's head repo." : ".";
    return new Error(`fetching ${sha} from ${location} failed (${reason(err)}), and ${location} did not say it lacks it. Nothing was written; answer again once the fetch can succeed${exit}`);
  };
  const lacking = new Set<string>();
  for (const remote of ["origin", HEAD_REPO_REMOTE] as const) {
    const headRepo = remote === HEAD_REPO_REMOTE;
    // ADR 0409 決定4 の読み (2): 前の段で届いた sha(origin から取った同じ sha、根の head が運んできた子の tip)は取り直さず、そのための token も待たない
    const wanted = [...new Set(missing.filter(([ref]) => taskRef(ref) === headRepo).map(([, sha]) => sha))].filter((sha) => !knownPresence(place, sha));
    if (wanted.length === 0) continue;
    await warm(remote, wanted);
    for (const sha of wanted) {
      if (knownPresence(place, sha)) continue;
      const failure = fetchFrom(remote, sha);
      if (failure === undefined) continue;
      if (headRepo) {
        // ADR 0409 決定3: 出元 repo は差し替えうる(ADR 0395 決定2)—— 取れなければ答えを問わず origin にも聞く
        await warm("origin", [sha]);
        const fromOrigin = fetchFrom("origin", sha);
        if (fromOrigin === undefined) continue;
        if (!saysLacking(fromOrigin, sha)) throw notSaidLackingError("origin", sha, fromOrigin);
      }
      if (!saysLacking(failure, sha)) throw notSaidLackingError(remote, sha, failure);
      lacking.add(sha);
    }
  }
  return lacking;
}

/** ADR 0373 決定3・4: 基準と違う ref を全部基準の値へ書き戻し(基準に無い ref は消す)、外す値を `refs/keep-around/<sha>` に持ち続ける。
 *  受理の 7b(spec #3273)の1つの同期区間で、比べ直すところから書くまでに await を挟まない。予告中の行は ref がどの値とも違うときだけ予告の前の値へ戻す。
 *  戻す先の object が1つでも無ければ何も書かずに拒む。持ち続けるのは ref が持っていた sha だけ —— symref の行(HEAD を含む)は名前なので
 *  戻すだけ、object の無い値は持てない、`refs/stash` は reflog の各件。clean だった tree は書いた後の HEAD に揃え、dirty なら拒む。
 *  `baseline_restored` は書けた分を残す —— 途中で落ちても書き戻しと一緒に残る。外した値を返し、違いが無ければ何も書かずに空を返す。
 *  `lacking`(remote-backed、`fetchLostTargets` の答え): 相手が無いと答えた sha。省略は purely-local で、手元に無い sha をそのまま失われたと数える。
 *  `giveUpAnswer`(give-up に答えている workspace の Quarantine の `question`、ADR 0373 決定5): object の無い ref は拒まずに今の値で基準に入れ(ref が無ければ
 *  行を消す。失われた `task/<id>` は今の値を keep-around へ移して ref と行を消す —— ADR 0392 決定1)、`lost_refs_accepted` と失われた `task/<id>` ごとの `task_branch_lost` を書き戻しより先に残し、同じ transaction で付帯子を倒し、
 *  失われた task を指す開いた着地の question とキューの行を引退させる(ADR 0375 決定1・4・9、ADR 0407 決定2 —— 着地の終わりは失われた event から読み、
 *  記録は書かない)。その transaction の直前の同じ同期区間で `refuseIfInFlight` を失われる task に当て、処理中の印があるか収束がこの workspace の根を
 *  着地させていれば何も書かずに拒む(ADR 0407 決定2 とその追記、ADR 0288 決定2 と同じ形)。give-up で失われた ref が無ければ、
 *  今の checkout に保護ブランチが無ければ、何も書かずに拒む。 */
export function restoreBaseline(
  db: Db,
  workspace: WorkspaceConfig,
  now: Date,
  lacking?: ReadonlySet<string>,
  giveUpAnswer?: { question: string; refuseIfInFlight: (lostTaskIds: string[]) => void },
): KeptValue[] {
  const giveUp = giveUpAnswer !== undefined;
  // ADR 0409 決定4: 読みは最初の書き込みと B4a・B3・B4b のどの拒否よりも前に全部済ませる —— 分からない sha が残る間は取り消せない側へ案内しない
  const { current, targets, keepable, present, missing } = readRestore(db, workspace);
  // ADR 0409 決定4: remote-backed では、非同期の段で「無い」と分かった sha だけを失われたと数える —— ほかが手元に無いのは await の間に消えた
  const vanished = lacking && missing.find(([, sha]) => !lacking.has(sha));
  if (vanished) {
    throw new Error(`the restore target ${vanished[1]} of ${vanished[0]} went missing in ${workspace.path} while the board was answering. Nothing was written; answer again.`);
  }
  // 残った手元に無い ref は、どれも無いと分かっている(ADR 0409 決定1)
  const lost = missing;
  const lostTask = (ref: string) => (ref.startsWith("refs/heads/task/") ? getTask(db, taskIdOfBranch(ref.slice("refs/heads/".length))) : undefined);
  // ADR 0393 決定3: give-up は開きの後に失われた event を刻むので、disk に在る最後の session の checkout は消されずに残る
  const keptOnGiveUp = (ref: string) => {
    const task = lostTask(ref);
    const checkout = task && taskCheckoutPath(db, task.id);
    return checkout && existsSync(checkout) ? ` ${KEPT_TASK_CHECKOUT.onGiveUp(checkout)}` : "";
  };
  if (giveUp) {
    if (lost.length === 0) throw new Error(`no ref of workspace ${workspace.name} is lost — answer \`${RESTORE_THE_BASELINE}\`.`);
    // ADR 0392 決定1: 失われた event を書く `task/<id>` は決着を問わず消す —— 今の値は書き戻しが keep-around で持ち続ける
    for (const [ref] of lost) {
      if (lostTask(ref) && current.has(ref)) targets.set(ref, "");
      else targets.delete(ref);
    }
    // ADR 0373 決定5: 書き戻しの前に保護ブランチの ref が在ることを明示で確かめる —— purely-local では後半の休止がそれを読まず、空の `git init` が通ってしまう(#3242)
    const branch = protectedBranch(workspace);
    if (!current.has(`refs/heads/${branch}`)) {
      throw new Error(
        `${workspace.path} has no '${branch}' branch. Nothing was written. Put a commit on ${branch} there (re-clone the repository, or commit on ${branch}), then answer again.`,
      );
    }
  } else if (lost.length > 0) {
    throw new Error(
      `${lost.map(([ref, sha]) => `cannot restore ${ref} to ${sha}: that commit no longer exists in ${workspace.path}.${keptOnGiveUp(ref)}`).join("\n")} Nothing was written. ` +
        `If these are lost for good, answer \`${GIVE_UP_THE_LOST_REFS}\`.`,
    );
  }
  if (targets.size > 0) verifyWorkspaceClean(db, workspace);
  const kept: KeptValue[] = [...targets.keys()].flatMap((ref) => keepable.get(ref)!.filter((sha) => present.get(sha)).map((sha) => ({ ref, sha })));
  if (giveUp) {
    giveUpAnswer.refuseIfInFlight(lost.flatMap(([ref]) => lostTask(ref)?.id ?? []));
    db.transaction(() => {
      // 記録が git の書き込みより先でよいのは、失われたと数えるのが基準の sha の object の不在で、ref の今の値を読まないから —— 書き戻しの前に
      // 落ちても記録は偽にならない。失われた `task/<id>` の行をここで消すので、人間の値で残った ref は違反のまま、次に通る回答は
      // `restore the baseline` だけで、それが落ちなかった give-up と同じ終わりへ書く(#3624)。行に今の値を入れると `repaired by hand` が通る
      updateBaseline(db, workspace, (values) => lost.forEach(([ref]) => values.set(ref, lostTask(ref) ? "" : (current.get(ref) ?? ""))));
      appendEvent(db, {
        taskId: null,
        actorId: BOARD_ACTOR_ID,
        origin: "board",
        payload: { kind: "lost_refs_accepted", workspace: workspace.name, lost: lost.map(([ref, sha]) => ({ ref, sha })) },
        at: now,
      });
      // ADR 0375 決定1・9: 失われた `task/<id>` ごとに task へ event を残す —— 後の段で回答が拒まれても残る
      const lostTasks = lost.flatMap(([ref, sha]) => {
        const task = lostTask(ref);
        if (!task) return [];
        appendEvent(db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_branch_lost", sha }, at: now });
        return [task.id];
      });
      // ADR 0407 決定2: ブランチの無い task の着地の question には答えようが無い —— 根かどうかによらず閉じ、閉じた理由を question 自身に刻む
      for (const id of lostTasks) retireLandingDecisions(db, id, now, { stamp: { kind: "task_branch_lost_observed" } });
      // 透明か死んだかは同じ回答の兄弟の event も読むので、倒すのは全部を刻んだ後(ADR 0375 決定4・9)
      fellLostBranchAttachments(db, lostTasks, giveUpAnswer.question, now);
    })();
  }
  if (targets.size === 0) return [];
  // 終わりの状態で書く: 人間が作った `refs/keep-around/<その sha>` は消さずに残る。持ち続ける ref が先、削除は書き込みより先(人間が作った
  // `refs/heads/a/b` を消してからでないと基準の `refs/heads/a` を書けない)、HEAD とその指し先は最後 —— 途中で落ちても HEAD は元の tip に居て、
  // tree の巻き戻しが合う。HEAD が指していた branch の削除は HEAD を書いた後
  const headTargets = [symrefTarget(current.get("HEAD") ?? ""), symrefTarget(targets.get("HEAD") ?? "")];
  const restores = [...targets].filter(([ref]) => !kept.some(({ sha }) => ref === `refs/keep-around/${sha}`));
  const last = (ref: string) => ref === "HEAD" || headTargets.includes(ref);
  const writes = new Map([
    ...kept.map(({ sha }) => [`refs/keep-around/${sha}`, sha] as const),
    ...restores.filter(([ref, value]) => !last(ref) && value === ""),
    ...restores.filter(([ref, value]) => !last(ref) && value !== ""),
    ...restores.filter(([ref, value]) => last(ref) && ref !== "HEAD" && value !== ""),
    ...restores.filter(([ref]) => ref === "HEAD"),
    ...restores.filter(([ref, value]) => last(ref) && ref !== "HEAD" && value === ""),
  ]);
  const tipRestored = tipAfter((ref) => writes.get(ref) ?? current.get(ref) ?? "");
  const tipBefore = readRef(workspace, "HEAD");
  const written = new Set<string>();
  try {
    writeBoardRefs(db, workspace, [...writes], () => {
      const write = () => {
        for (const [ref, value] of writes) {
          const target = symrefTarget(value);
          // --no-deref: symref の行を書き換え・消しても指し先の branch に書き抜けない
          if (value === "") git(workspace.path, "update-ref", "--no-deref", "-d", ref);
          else if (target !== undefined) git(workspace.path, "symbolic-ref", ref, target);
          else git(workspace.path, "update-ref", "--no-deref", ref, value);
          written.add(ref);
        }
      };
      if (tipBefore !== "" && isSha(tipRestored)) writeWithWorktree(db, workspace, tipBefore, tipRestored, write);
      else write();
    });
  } finally {
    if (written.size > 0) {
      appendEvent(db, {
        taskId: null,
        actorId: BOARD_ACTOR_ID,
        origin: "board",
        payload: {
          kind: "baseline_restored",
          workspace: workspace.name,
          restored: restores.map(([ref]) => ref).filter((ref) => written.has(ref)),
          kept: kept.filter(({ sha }) => written.has(`refs/keep-around/${sha}`)),
        },
        at: now,
      });
    }
  }
  return kept;
}

/** spec #3273 text B11: 書き戻しが外して keep-around に残した値の1行。 */
export const keptValueNotice = ({ ref, sha }: KeptValue): string => `${ref} was ${sha}, kept as refs/keep-around/${sha}`;

/** ADR 0409 決定2: 手元の「無い」は git が `missing` と答えて何も報告しないことだけ。型を答えれば、何か報告していても在る。replace ref は在る object を
 *  黙って `missing` と見せ、lazy fetch は読みを網に出すので、どちらも切って読む。T3 が sha を名指せるよう sha ごとに読み、分からなければ拒む(text T3)。 */
function knownPresence(workspace: WorkspaceConfig, sha: string): boolean {
  let line: string;
  let stderr: string;
  try {
    ({ stdout: line, stderr } = gitReporting(workspace.path, ["cat-file", "--batch-check"], { GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" }, `${sha}\n`));
    line = line.trim();
    stderr = stderr.trim();
  } catch (err) {
    [line, stderr] = ["", ((err as { stderr?: string }).stderr ?? String(err)).trim()];
  }
  if (line === `${sha} missing` && stderr === "") return false;
  if (line.startsWith(`${sha} `) && line !== `${sha} missing`) return true;
  throw new Error(`could not tell whether ${sha} is in ${workspace.path} (${stderr || line}). Nothing was written; fix what git reports there, then answer again.`);
}

/** 1つの workspace の基準に束ねた1本の口(`writeBoardRefs` の1本の形)。 */
export function boardRefWriter(db: Db, workspace: WorkspaceConfig): RefWriter {
  return (ref, newValue, write) => writeBoardRefs(db, workspace, [[ref, newValue]], write);
}

/** ADR 0069 の3条件 —— **既知パス・untracked・0 バイト**をすべて満たすファイルだけが
 *  「セッションの遺物ではないと確定的に識別できるもの」である。tree rule の退避除外と
 *  完了の門(ADR 0084)の dirty 判定は同じ集合を見なければならない —— 2箇所に綴りが
 *  分かれれば、片方だけが残骸を数えて無実の拒否や取りこぼしが生まれる。
 *  tracked は盤面が読む tip の tree で決める(ADR 0356 決定3 / ADR 0367 決定1)。 */
function taskCheckoutRemnants(checkout: string, isTracked: (path: string) => boolean): string[] {
  return SANDBOX_STUB_PATHS.filter((path) => {
    let stat: Stats | undefined;
    try {
      stat = lstatSync(join(checkout, path), { throwIfNoEntry: false });
    } catch (err) {
      // 祖先がディレクトリでない path(worker が `.claude` をファイルにした形)に 0 byte の stub は置けない(ADR 0069 の既知パス)
      if ((err as NodeJS.ErrnoException).code === "ENOTDIR") return false;
      // ADR 0367 決定1: 既知の残骸を探すために worker の worktree を読む手も stage と同じ帰責。
      throw asUntrustedFailure({ checkout, noun: TASK_CHECKOUT }, err);
    }
    return stat?.isFile() && stat.size === 0 && !isTracked(path);
  });
}

/** task の checkout の worktree を、worker の tip に対して盤面の view だけで読む(ADR 0356 決定3)。view は tip を写して検証した写しを借りる
 *  (ADR 0412 決定1)。運ばない path は除く。 */
function taskCheckoutChanges(db: Db, place: TaskCheckoutPlace, taskId: string, { tip, verified }: VerifiedTip): WorktreeChange[] {
  return boardViewStatus(place.path, tip, verified, boardViewExcludes(db, place, taskId, tip, verified));
}

/** ADR 0084: 退避コミットの subject にタスクの title を添える —— 完了の門が入った後に
 *  WIP が残るのは完了**以外**の解放だけなので、履歴を読む人間には「どのタスクの
 *  途中なのか」が id だけでは足りない。本文の起草はしない(盤面は LLM を焚かない)。
 *
 *  issue-backed タスクの stored title は `#N` プレースホルダのままである(本物は
 *  `TaskContentSource.expand()` が使用の瞬間に解決する)。ここは同期の機械処理なので
 *  GitHub を叩かず、プレースホルダのときは素の形に落ちる。 */
function wipSubject(task: Task): string {
  const bare = `WIP: task ${task.id}`;
  const placeholder =
    task.github_issue_number !== null && task.title === issueRefPlaceholder(task.github_issue_number);
  return placeholder ? bare : `${bare} — ${task.title}`;
}

/** ADR 0350 決定1: 完了の門は work タスクに掛かり、workspace の Quarantine では変わらない。
 *  ADR 0359 決定3: 同じ範囲で、完了の解放は未コミットの変更を退避せず報告後の書き込みとして観測する。 */
export function completionTreeGateApplies(task: Task): boolean {
  return task.type === "work";
}

/** ADR 0359 決定3: worker の checkout は観測だけに使う。着地は名前の場所の記録から進める。 */
function observeCheckoutAfterCompletion(db: Db, place: TaskCheckoutPlace, taskId: string, recorded: string | undefined): TaskCheckoutWriteObservation | undefined {
  try {
    const workerTip = readUntrustedTip(untrustedRead(untrustedTaskCheckout(place)), taskBranch(taskId)).sha;
    if (!recorded) return;
    if (workerTip !== recorded) return { observation: "committed", worker_tip: workerTip };
    // ADR 0412 決定5: 写しを作る —— 完了の後に worker が壊した repo と写しの上限超過は「読めない」観測
    return withVerifiedUntrustedTip(untrustedTaskCheckout(place), taskBranch(taskId), (read): TaskCheckoutWriteObservation | undefined => {
      // 2つの読みの間に動いた tip を、記録との差分として読まない
      if (read.tip !== recorded) return { observation: "committed", worker_tip: read.tip };
      const paths = taskCheckoutChanges(db, place, taskId, read).map(({ path }) => path);
      return paths.length > 0 ? { observation: "uncommitted", paths } : undefined;
    });
  } catch (err) {
    // ADR 0359 決定5: view の上限超過も、完了済みの解放では「読めない」観測
    if (!(err instanceof CheckoutUnreadableError || err instanceof WorktreeStatusError || err instanceof WorkerTreeGitTimeoutError)) throw err;
    return { observation: "unreadable", reason: err.message };
  }
}

/** ADR 0052 決定7 / ADR 0356 決定5: the resting checkout shows the protected branch's current tree.
 *  A remote-backed place follows origin only by fast-forward, preserving ahead or diverged commits for repair. */
function parkOnProtectedBranch(db: Db, workspace: WorkspaceConfig): void {
  const branch = protectedBranch(workspace);
  const remoteBacked = isRemoteBacked(workspace);
  try {
    // 盤面は名前の場所の HEAD を動かさない(ADR 0356 決定1)が、origin にしか無い保護ブランチは HEAD を保護ブランチの外に置く —— 人間が動かした
    // HEAD は受理の比較が拒む(ADR 0373 決定1)
    if (headValue(workspace) !== symrefValue(`refs/heads/${branch}`)) checkoutThroughGate(db, workspace, branch);
  } catch (cause) {
    throw hostFailure(cause) ?? new NamedPlaceSideError(`workspace ${workspace.name}: protected branch '${branch}' cannot be checked out: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (!remoteBacked) return;
  const ref = remoteTrackingRef(branch);
  const remoteSha = git(workspace.path, "rev-parse", ref);
  const localRef = `refs/heads/${branch}`;
  const localSha = git(workspace.path, "rev-parse", localRef);
  try {
    if (localSha === remoteSha) return;
    if (isAncestor(workspace, localSha, remoteSha)) {
      advanceBranch(db, workspace, localRef, localSha, remoteSha);
      return;
    }
    if (!isAncestor(workspace, remoteSha, localSha)) throw new Error("the local and remote histories diverged");
  } catch (cause) {
    throw hostFailure(cause) ?? new NamedPlaceSideError(`workspace ${workspace.name}: protected branch '${branch}' cannot fast-forward to ${ref}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  throw new NamedPlaceSideError(
    `workspace ${workspace.name}: local '${branch}' is ahead of ${ref} — out-of-band local ` +
      "commits were never pushed, so parking here would show a state the remote does not have",
  );
}

/** Quarantine resolution's verification gate (issue #21, GLOSSARY.md): the
 *  board never takes a repair confirmation on faith. Any failure to observe
 *  a clean tree — dirty, or not even a usable git repository — is treated
 *  the same, fail-closed, same posture as the pickup's resting check on the
 *  named place (ADR 0351 決定5). */
export function verifyWorkspaceClean(db: Db, workspace: WorkspaceConfig): void {
  assertOwnGitDirectory(workspace.path);
  let status: WorktreeChange[];
  try {
    // ADR 0356 決定3: 名前の場所(面接室を含む)は自分の git で読む
    status = ownWorktreeStatus(workspace.path);
  } catch (err) {
    throw new Error(
      `workspace ${workspace.name} is not a usable git repository: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (status.length > 0) {
    throw new Error(`workspace ${workspace.name} still has uncommitted changes.${stalledCheckoutMoveNote(db, workspace)}${discardUncommitted()}`);
  }
}

/** ADR 0401 決定7 (#3199): 予告中の行が HEAD の tip を今の tip から動かすなら、盤面自身の checkout の移動が `read-tree` の後 ref を書く
 *  前に止まったかもしれない —— その目標を名指す注記。HEAD から tip を辿る道は `restoreBaseline` と同じ `tipAfter` で、値は予告の行の
 *  目標(再予告で3値以上なら最後の値 —— `writeBoardRefs` が足す)、予告の無い行は今の値。checkout されていない ref の予告
 *  (`task/<id>` の作成)は木を動かさないので注記しない。 */
function stalledCheckoutMoveNote(db: Db, workspace: WorkspaceConfig): string {
  const baseline = refValues(storedRefs(db, workspace.name));
  if (![...baseline.values()].some((value) => baselineValues(value).length > 1)) return "";
  const target = tipAfter((ref) => {
    const values = baselineValues(baseline.get(ref));
    return values.length > 1 ? values.at(-1)! : readCheckoutValue(workspace, ref);
  });
  if (!isSha(target) || target === readRef(workspace, "HEAD")) return "";
  // 木ごと比べる: index だけ(`--cached`)では移動の上に書かれた未 stage の変更が通り、続く捨てる操作に消される。read-tree が足した file は
  // index に載るので `??` には出ない
  return ` The board's own checkout move may have stopped part-way: its target is ${target}. If \`git diff ${target}\` prints nothing and ` +
    "`git status --porcelain` shows no `??` line, that is what happened — do not commit them.";
}

/** ADR 0137 決定3: the open Confirmation question is the only state. */
export function workspaceNeedsHuman(db: Db, name: string): boolean {
  return openQuarantineQuestion(db, "workspace", name) !== undefined;
}

/** Tree-rule failure containment (quarantine, GLOSSARY.md): put the repair in
 *  front of the human as a 1-choice Confirmation question (issue #21) — its
 *  tasks stay out of the slot while it is open. The answer isn't a choice
 *  between outcomes, it's a confirmation that repair happened, verified before
 *  it is accepted (see submitAnswer in human-verbs.ts).
 *  Name-only (issue #26 / ADR 0009): the trigger can be a tree-rule failure
 *  (path known, folded into `cause`'s message) or an unknown workspace name
 *  encountered at resolution time (no path to know) — both quarantine the
 *  same way, keyed on the name alone. 返すのは止めた資源 —— pickup を止めた呼び手が `pickup_stopped` に刻む(ADR 0274)。 */
export function quarantineWorkspace(
  db: Db,
  workspaceName: string,
  cause: unknown,
  now: Date,
): ResourceStop {
  const reason = cause instanceof Error ? cause.message : String(cause);
  // spec #3273 text B9: 基準の行を持つ名前が引けない間は、どの workspace も最初の撮りをしない(ADR 0373 決定13)。出口は登録の扉の拒否と同じ文(ADR 0401 決定5)
  const baselineHeldSentence = cause instanceof UnknownWorkspaceError && holdsBaseline(db, workspaceName)
    ? `. The board holds a baseline for "${workspaceName}", so no workspace captures a first baseline until it resolves again. ${leftoverStateExit(workspaceName, cause.registry)}`
    : "";
  return registerResourceStop(db, "workspace", workspaceName, `${reason}${baselineHeldSentence}`, now);
}

/** The one fallback shape shared by every board-driven workspace consumer
 *  (scheduler pickup, mcp release, watchdog/restart teardown): prefer the
 *  registry-backed resolver when configured, else fall back to a fixed
 *  single workspace (pre-#26 shape, and still today's shape for a caller
 *  with no registry at all). Undefined means no workspace tracking exists —
 *  a task whose named place is its workspace skips the workspace step
 *  entirely, not just resolution; an Interview root and its examinees still
 *  act on the recorded interview room (ADR 0363 決定1〜3 の Status 追記). */
export type WorkspaceResolver = (taskWorkspace: string | null) => WorkspaceConfig;

export function buildWorkspaceResolver(
  resolveWorkspace: WorkspaceResolver | undefined,
  workspace: WorkspaceConfig | undefined,
): WorkspaceResolver | undefined {
  return resolveWorkspace ?? (workspace && (() => workspace));
}

/** The shared shape behind every async, board-driven use of a task's
 *  execution workspace (issue #26 / ADR 0009: pickup, release, watchdog,
 *  restart, landing) — `resolve` throwing `UnknownWorkspaceError` (registry drift)
 *  never escapes to the caller; it quarantines the name in its place and the
 *  caller treats the workspace step as absent for this cycle. A human's own
 *  synchronous request (registration, a quarantine/merge answer) is not this
 *  seam — those fail fast with a DomainError instead (ADR 0009). `onStop` は止めた資源を pickup の呼び手へ渡す(ADR 0274)。
 *  ADR 0363 決定2: worker の verb は呼ばない —— 走った後の drift の観測者は後始末、session の後に PR が待つ間は landing の
 *  2 つの poll で(ADR 0366 決定4)、verb は資源の停止を登録しない(拒むか回収する、ADR 0424 決定2・3)。 */
export function resolveOrQuarantine(
  db: Db,
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  taskWorkspace: string | null,
  now: Date,
  onStop?: (stop: ResourceStop) => void,
): WorkspaceConfig | undefined {
  return resolveUnlessDrifted(resolve, taskWorkspace, (err) => {
    const stop = quarantineWorkspace(db, err.workspaceName, err, now);
    onStop?.(stop);
  });
}

/** 名前が registry に無い(drift)ときだけ `onDrift` に渡して undefined を返す。他の失敗は投げる。drift を登録するか・拒むかは
 *  呼び手が決める —— 登録するのは観測者の3人: 走る前の pickup の門、走った後の後始末、session の後に PR が待つ間の landing の
 *  2 つの poll(ADR 0363 決定2 / ADR 0366 決定4)。worker の verb は登録しない(拒むか回収する、ADR 0424 決定2・3)。 */
export function resolveUnlessDrifted(
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  taskWorkspace: string | null,
  onDrift: (err: UnknownWorkspaceError) => void = () => {},
): WorkspaceConfig | undefined {
  try {
    return resolve(taskWorkspace);
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    onDrift(err);
    return undefined;
  }
}

/** The releasing MCP verbs and teardown share this workspace release path.
 *  Work completion may merge the recorded tip into the ancestor branch
 *  selected from its live lineage (ADR 0053 decision 2 / ADR 0359 decision 2). */
export function releaseWorkspace(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
  now: Date,
  mergeBack = false,
  githubAuth?: GitHubAuth,
  tokenFailure?: unknown,
  /** ADR 0359 決定2・5: 完了の解放は門が掛かる範囲で記録を運び、読めない checkout を観測にする。 */
  completed = false,
): void {
  assertTaskCheckout(workspace, task.id);
  releaseTaskCheckout(db, workspace, task, now, mergeBack, githubAuth, tokenFailure, completed);
}

/** 完了なら帰り先へ merge back し、名前の場所を休止位置へ戻す。 */
function settleBranches(db: Db, workspace: WorkspaceConfig, task: Task, now: () => Date, mergeBack: boolean, githubAuth: GitHubAuth | undefined, tokenFailure: unknown, workbenchBase: string, recordedTip?: string): void {
  workspace = withRememberedRepoCheck(db, workspace, now);
  // merge-back の帰り先はこの fetch の結果で決まる。token は呼び出し元が
  // `ensureWorkspaceToken` で温めてある(ADR 0093)。温められなかったときは、その
  // 失敗を fetch が落ちたのと同じ位置で投げる —— WIP は既に退避済みで、行き先は
  // 同じ quarantine(ADR 0052)。呼び出し元で投げると slot が解放されない。
  if (mergeBack) {
    if (tokenFailure !== undefined) throw tokenFailure;
    // ADR 0351 決定3: 基準は切れないので、後始末の fetch も口を通す
    if (isRemoteBacked(workspace)) fetchBranchCopy(workspace, githubAuth, protectedBranch(workspace), boardRefWriter(db, workspace));
  }
  const target = mergeBack && lineageTaskBranch(db, workspace, task, now);
  if (target) mergeBackInto(db, workspace, workbenchBase, target, task.id, "release", recordedTip);
  parkOnProtectedBranch(db, workspace);
}

/** ADR 0369 決定7: 成果が名前の場所のタスクブランチに着いたら `task_checkout_released` を刻む。
 *  名前の場所の後半が落ちても、刻みがあれば最後に checkout を消す。 */
function releaseTaskCheckout(
  db: Db,
  place: TaskCheckoutPlace,
  task: Task,
  now: Date,
  mergeBack: boolean,
  githubAuth: GitHubAuth | undefined,
  tokenFailure: unknown,
  completed: boolean,
): void {
  const { namedPlace, path: checkout } = place;
  const taskRef = `refs/heads/${taskBranch(task.id)}`;
  const gated = completed && completionTreeGateApplies(task);
  // 決着より前に消す: 決着の失敗を覆わず、消せなければ何も書かずに投げて後始末の再実行が消し直す
  releaseReadCheckouts(db, task.id);
  const released = taskCheckoutWasReleased(db, task.id, checkout);
  if (!released) {
    try {
      if (!bringTaskCheckout(db, place, task, now, completed, "during the session")) return;
    } catch (err) {
      quarantineWorkspace(db, namedPlace.name, err, now);
      return;
    }
  }
  try {
    // ADR 0064 決定5 / ADR 0356 決定4: 基準は名前の場所だけが持ち、task の checkout の ref の移動は読まない。HEAD も比べる ——
    // 盤面は名前の場所の HEAD を動かさない(ADR 0356 決定1)ので、session の間の HEAD の移動は人間の書き込み(ADR 0351)
    // ADR 0373 決定12: 退避の行は書いた値で畳まれている(`writeBoardRefs`)—— タスクブランチも除かずに比べる
    const verifiedRefs = compareAndFoldBaseline(db, namedPlace, "during the session");
    // ADR 0359 決定2・4: 基準比較が済んだ ref を読み直して、帯域外の値を merge back に運ばない。
    const verifiedTip = gated ? verifiedRefs.get(taskRef) : undefined;
    if (gated && !verifiedTip) throw new Error(`workspace ${namedPlace.name}: the recorded task ref ${taskRef} is missing`);
    // 作業台は task の checkout と同じ基点の下(spec #3273 の番地)
    settleBranches(db, namedPlace, task, () => now, mergeBack, githubAuth, tokenFailure, CHECKOUT_LAYOUT.task.base(checkout), verifiedTip);
  } catch (err) {
    quarantineWorkspace(db, namedPlace.name, err, now);
  }
  removeReleasedTaskCheckout(db, task.id, now);
}

/** ADR 0369 決定7: drift で名前を解けなくても、運び終えた session の checkout は消せる。
 *  ADR 0393 決定1: 開きの後に失われた event が刻まれていれば消さない —— 残したことは1回だけ刻む(ADR 0393 決定3)。 */
export function removeReleasedTaskCheckout(db: Db, taskId: string, now: Date): void {
  const checkout = taskCheckoutPath(db, taskId);
  if (checkout === undefined || !taskCheckoutWasReleased(db, taskId, checkout)) return;
  if (taskBranchLostAfterCheckoutOpened(db, taskId)) {
    recordTaskCheckoutKept(db, taskId, checkout, now);
    return;
  }
  removeBoardCheckout(checkout, CHECKOUT_LAYOUT.task.parents);
}

/** ADR 0393 決定3: disk に在る checkout だけを、同じ path に未だ刻んでいなければ残したと刻む。 */
function recordTaskCheckoutKept(db: Db, taskId: string, path: string, now: Date): void {
  if (!existsSync(path) || latestEventOfTask(db, taskId, "task_checkout_kept")?.payload.path === path) return;
  appendEvent(db, { taskId, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_kept", path }, at: now });
}

/** この session の読み専用の checkout を消す(冪等)。issue #3105 の spec: 記録の価値の無い派生物なので、決着が落ちて task の checkout を
 *  唯一の写しとして残す解放(ADR 0356 決定2)でも、解放を飛ばす後始末(ADR 0363 決定4)でも消す。 */
export function releaseReadCheckouts(db: Db, taskId: string): void {
  for (const read of sessionReadCheckouts(db, taskId)) removeBoardCheckout(read.path, CHECKOUT_LAYOUT.read.parents);
  const real = sessionRealEnvironmentCheckout(db, taskId);
  if (real) removeBoardCheckout(real.path, CHECKOUT_LAYOUT.realEnvironment.parents);
}

/** 外への書き込み(ref・event・`done`)の後に作業台を消す —— 投げない(ADR 0401 決定1 の (3): 書いた後の拒否は出口を名指せない)。
 *  消せなければ(作業台自身でも、空になった親の rmdir でも)残ったものはそのままに、済んだことを言う文 `settled` に在り処と原因を足した文を返す。
 *  削除は途中で止まりうるので、人間の作業を残したとは言わない。 */
function removeWrittenWorkbench(path: string, settled: string): string | undefined {
  try {
    removeBoardCheckout(path, CHECKOUT_LAYOUT.workbench.parents);
    return undefined;
  } catch (err) {
    return `${settled} The board could not remove the workbench at ${path} (${err instanceof Error ? err.message : String(err)}); remove what is left of it by hand.`;
  }
}

/** 盤面が作った checkout を消し、`parents` 段までの空になった親も消す。同じ task の残した checkout が並ぶ親は残す。 */
function removeBoardCheckout(path: string, parents: number): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
  for (let dir = dirname(path), i = 0; i < parents; i++, dir = dirname(dir)) {
    try {
      rmdirSync(dir);
    } catch (err) {
      if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    }
  }
}

/** ADR 0369 決定1〜3: workspace の Quarantine の受理の検査が、着け先が `place` の済まなかった解放の「運ぶ」だけをやり直す。後の段は
 *  撃たない —— session の間の ref の比較はやり直さず、merge back は受理がこの後にやり直し、checkout はその後で消す。名前の場所の
 *  事情の失敗は呼び手へ投げる —— Quarantine は既に開いていて、登録し直すと理由が消える。worker の repo の故障は後始末と同じく
 *  task の失敗にして続ける。決着が完了かは `completed` が後始末と同じく記録から導く。
 *  運ぶと `task/<id>` は子の merge back より前へ戻りうる —— 受理はこの後で merge back をやり直して戻すので、この順を崩さない。 */
export function redoOwedReleases(
  db: Db,
  place: WorkspaceConfig,
  defaultWorkspaceName: string | undefined,
  now: Date,
  completed: (task: Task) => boolean,
): void {
  for (const task of tasksOwingReleaseOn(db, place.name, defaultWorkspaceName)) {
    bringTaskCheckout(db, taskRunPlaceForBoard(db, task, () => place), task, now, completed(task), "out of band");
  }
}

/** ADR 0369 決定7: 着け先が `name` の、解放済みでまだ残る最後の session の checkout を消す —— 消せずに投げても、次の回答が消し直す。
 *  開きの後に失われた event が刻まれた task の checkout は消さずに残す(ADR 0393 決定1)。 */
export function removeReleasedTaskCheckoutsOn(db: Db, name: string, defaultWorkspaceName: string | undefined, now: Date): void {
  for (const task of tasksReleasedOn(db, name, defaultWorkspaceName)) removeReleasedTaskCheckout(db, task.id, now);
}

/** ADR 0369 決定7: tip と WIP が名前の場所のタスクブランチに着けば `task_checkout_released` を刻んで true、worker の repo の故障を
 *  task の失敗に記録したら false。名前の場所の事情の失敗は投げる —— 後始末は Quarantine に、受理のやり直しは回答の拒否にする。 */
function bringTaskCheckout(
  db: Db,
  place: TaskCheckoutPlace,
  task: Task,
  now: Date,
  completed: boolean,
  /** タスクブランチの移動を告げる文の時(後始末は「session の間」、受理のやり直しは帯域外)。 */
  when: string,
): boolean {
  const { namedPlace, path: checkout } = place;
  const taskRef = `refs/heads/${taskBranch(task.id)}`;
  // ADR 0393 決定2 / ADR 0392 決定3: 失われた event が効いていれば門の有無より前に、`task/<id>` を書かず解放の失敗にして checkout を残す ——
  // give-up が ref と基準の行を消した後は、門の側が投げて回答が拒まれ続ける
  const lost = taskBranchLostInForce(db, task.id);
  if (lost) {
    const reason = `${taskRef} was lost (its commit ${lost.payload.sha} no longer existed in ${namedPlace.path} when the lost refs were given up), so the board did not write it from the task checkout.`;
    db.transaction(() => {
      // ADR 0393 決定3: disk に在る checkout だけを名指す
      failTaskOnRelease(db, task, checkout, new Error(reason), now, existsSync(checkout));
      recordTaskCheckoutKept(db, task.id, checkout, now);
    })();
    return false;
  }
  const gated = completed && completionTreeGateApplies(task);
  let recorded: string | undefined;
  let tipLookupFailure: unknown;
  let evacuationBaseRef = "";
  let wipTip: string | undefined;
  let observation: TaskCheckoutWriteObservation | undefined;
  try {
    if (gated) {
      // ADR 0359 決定3・4: 名前の場所の帯域外の値と比べず、checkout の観測と基準比較を独立に行う
      const candidates = baselineValues(recordedRef(db, namedPlace.name, taskRef));
      const opened = latestEventOfTask(db, task.id, "task_checkout_opened")?.payload;
      const gateRecordedTip = opened?.path === checkout && opened.completion_gate === "recorded_tip";
      if (candidates.length === 1) {
        recorded = candidates[0];
      } else {
        // ADR 0359 決定3: 名前の場所が読めなくても、worker の repo が読めないことは観測する。
        try {
          const current = readRefSnapshotValue(namedPlace, taskRef);
          recorded = candidates.find((tip) => tip === current);
          if (recorded === undefined && gateRecordedTip && current && !current.startsWith("symref=")) {
            // ADR 0369 決定7: 予告の新値から探し、今の ref が門の tip を含むことを確かめる。
            recorded = candidates.reverse().find((tip) =>
              tip && readRef(namedPlace, `${tip}^{commit}`, gitWithoutHistoryOverrides) && isAncestor(namedPlace, tip, current, gitWithoutHistoryOverrides));
          }
        } catch (err) {
          tipLookupFailure = err;
        }
      }
      observation = observeCheckoutAfterCompletion(db, place, task.id, recorded);
      // ADR 0359 決定1: 旧版の完了では tip が記録にあるとは限らない。確認できなければ checkout を残す
      if (!gateRecordedTip && tipLookupFailure === undefined &&
        (!recorded || observation?.observation === "committed" || observation?.observation === "unreadable")) {
        throw new NamedPlaceSideError(
          `The task completed under an earlier board version and its recorded tip could not be verified against the task checkout at ${checkout}. ` +
          "Inspect the retained checkout and restore the intended completion tip before answering.",
        );
      }
    } else {
      // ADR 0373 決定12: 書く前に基準の行と突き合わせる(門と同じ手)
      evacuationBaseRef = taskRefAsRecorded(db, namedPlace, taskRef, when);
      // 比べてから worker の repo を読む —— 動いた ref を worker の repo の故障の陰に隠さない
      // ADR 0417 決定4: 他の task の commit を持つ tip からは `task/<id>` を書かない
      const refuse = (branches: string[]): never => {
        throw new OtherTaskCommitsError(`the tip of the task checkout contains commits of ${branches.join(", ")}, so the board did not write ${taskRef} from it — the board carries a task's work itself.`);
      };
      wipTip = receiveWorkerTip(db, place, task, evacuationBaseRef, { range: "every task", refuse }, ({ tip, verified }) => {
        // ADR 0412 決定2・3: 種は worker の tip、ref は WIP の親。ref が先にあれば、外す path は ref から導き、その entry は ref の値
        const ahead = evacuationBaseRef !== "" && evacuationBaseRef !== tip && isAncestor(namedPlace, tip, evacuationBaseRef);
        const base = ahead ? evacuationBaseRef : tip;
        const exclude = boardViewExcludes(db, place, task.id, base, ahead ? undefined : verified);
        const baseTree = git(namedPlace.path, "--no-replace-objects", "rev-parse", "--verify", `${base}^{tree}`);
        return boardWriteTree(checkout, tip, verified, (tree, repo) => {
          if (tree === baseTree) return base;
          if (ahead) assertRecordedParentCommit(namedPlace, base);
          const head = commitStagedTree(repo, tree, base, wipSubject(task));
          if (ahead) borrowNamedAfterStage(verified, namedPlace);
          // ADR 0388 決定1 / ADR 0367 Status 追記: staging repo の自前の store で確かめの対象を数える
          carryIntoNamed(namedPlace, { checkout, noun: TASK_CHECKOUT }, { source: repo, ref: "HEAD", own: repo, tip: head, staged: true, description: "the WIP commit" });
          return head;
        }, exclude, ahead ? { ref: base, at: namedPlace.path } : undefined);
      });
    }
  } catch (err) {
    // ADR 0417 決定4: 決着済みでも観測にして消さない —— checkout は読める唯一の写し。question は `failTaskOnRelease` が決着済みには立てない
    if (err instanceof OtherTaskCommitsError) {
      failTaskOnRelease(db, task, checkout, err, now);
      return false;
    }
    // ADR 0357 決定2: 上限超過は worker の repo の故障 —— 名前の場所を quarantine しない。ADR 0364 決定2: 写しの host の失敗は
    // 決着していない task の失敗、完了済みなら唯一の写しを消さずに名前の場所の失敗として投げる(#3053)
    if (!(err instanceof CheckoutUnreadableError || err instanceof WorkerTreeGitTimeoutError || (err instanceof CheckoutHostError && !completed))) throw err;
    if (!completed) {
      failTaskOnRelease(db, task, checkout, err, now);
      return false;
    }
    // ADR 0359 決定5 / ADR 0367 決定3: 門の無い完了でも checkout が読めなければ観測を残して解放する
    observation = { observation: "unreadable", reason: err.message };
  }
  // ADR 0345 決定1: `task_checkout_released` を刻む前に止まっても、同じ checkout の観測を重ねない
  if (observation && latestEventOfTask(db, task.id, "task_checkout_written_after_completion")?.payload.path !== checkout) {
    appendEvent(db, {
      taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board",
      payload: { kind: "task_checkout_written_after_completion", path: checkout, ...observation }, at: now,
    });
  }
  if (tipLookupFailure !== undefined) throw tipLookupFailure;
  const tip = wipTip;
  if (tip) {
    const old = readRefSnapshotValue(namedPlace, taskRef);
    if (old !== evacuationBaseRef) throw taskRefMoved(namedPlace, taskRef, when, evacuationBaseRef, old);
    if (old !== tip) {
      boardRefWriter(db, namedPlace)(taskRef, tip, () => git(namedPlace.path, "update-ref", "--no-deref", taskRef, tip, old));
      const current = readRefSnapshotValue(namedPlace, taskRef);
      if (current !== tip) throw taskRefMoved(namedPlace, taskRef, when, tip, current);
    }
  }
  if (gated) {
    // ADR 0369 決定7: tree を先に読み、最後に今のタスクブランチが門の tip を持つことを確かめる。
    if (recorded) gitWithoutHistoryOverrides(namedPlace.path, "ls-tree", "-r", "--format=%(objectmode)", recorded);
    const current = readRefSnapshotValue(namedPlace, taskRef);
    if (!recorded || !current || current.startsWith("symref=")) throw taskRefMoved(namedPlace, taskRef, when, recorded, current);
    if (recorded !== current) {
      if (!isAncestor(namedPlace, recorded, current, gitWithoutHistoryOverrides)) throw taskRefMoved(namedPlace, taskRef, when, recorded, current);
      const latest = readRefSnapshotValue(namedPlace, taskRef);
      if (latest !== current) throw taskRefMoved(namedPlace, taskRef, when, recorded, latest);
    }
  }
  // ADR 0276 決定4: 決着した受験者の最後の checkout は記録として残る —— 消さず、解放済みとも刻まない。
  if (!keepsCheckoutAsRecord(db, getTask(db, task.id)!)) {
    appendEvent(db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_released", path: checkout }, at: now });
  }
  return true;
}

/** ADR 0417 決定4: 退避が他の task のブランチの commit を持つ tip を見つけた。 */
class OtherTaskCommitsError extends Error {}

/** 盤面が `task/<id>` を書く前に、今の値が基準の行の値の直の ref であることを確かめて返す。違えば比較器と同じ `was: … / now: …` の形で名指す。 */
function taskRefAsRecorded(db: Db, namedPlace: WorkspaceConfig, ref: string, when: string): string {
  const current = readRefSnapshotValue(namedPlace, ref);
  const expected = recordedRef(db, namedPlace.name, ref);
  if (current.startsWith("symref=") || !baselineAllows(expected, current)) throw taskRefMoved(namedPlace, ref, when, expected, current);
  return current;
}

function taskRefMoved(workspace: WorkspaceConfig, ref: string, when: string, expected: string | undefined, current: string): RefsMovedError {
  return new RefsMovedError(`workspace ${workspace.name}: refs changed ${when} — was: ${expected || "absent"} ${ref}, now: ${current || "absent"} ${ref}`);
}

/** ADR 0356 決定2: 残った task の checkout を failure question が言う文 —— 中身はタスクブランチに無く、retry は新しい checkout で走る。 */
export const KEPT_TASK_CHECKOUT = {
  // ADR 0393 決定3: タスクブランチが失われた場面でも正しい文
  beyondBranch: "what it holds beyond the task branch (all of it, if the task branch was lost) is not on the task branch.",
  at: (path: string): string => `The board kept the task checkout at ${path}: ${KEPT_TASK_CHECKOUT.beyondBranch}`,
  retry: `"retry" picks this task up again at the queue head in a new task checkout; if its task branch was lost, the board makes it again from the fork source. `,
  // ADR 0393 決定3: 残したことの告知と、give-up の前の予告 —— 決着した task に retry は無いので言わない
  kept: (path: string, settled: boolean): string =>
    `The board kept the task checkout at ${path} and no longer touches it; you may delete it.${settled ? "" : ` ${KEPT_TASK_CHECKOUT.retry.trimEnd()}`}`,
  onGiveUp: (path: string): string => `The task checkout at ${path} stays even if you give up the lost refs.`,
} as const;

function hasOpenFailureQuestion(db: Db, taskId: string): boolean {
  return db
    .prepare(
      `SELECT 1 FROM tasks WHERE type = 'question' AND status = 'todo' AND parent_id = ?
         AND question_cancel_option IS NOT NULL AND question_breached_decision IS NULL`,
    )
    .get(taskId) !== undefined;
}

/** ADR 0356 決定2: 解放で worker の repo を読めなかった —— または ADR 0417 決定4: 退避が他の task のブランチの commit を持つ tip を見つけた。
 *  checkout を残して event に在り処と理由を刻み、`todo` に戻る決着なら
 *  failure question を立てる —— 既に立っている(倒された session)なら足さない。`namesCheckout` が偽なら question は在り処を名指さない。 */
function failTaskOnRelease(db: Db, task: Task, path: string, err: unknown, now: Date, namesCheckout = true): void {
  const reason = err instanceof Error ? err.message : String(err);
  db.transaction(() => {
    appendEvent(db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_release_failed", path, reason }, at: now });
    const current = getTask(db, task.id)!;
    if (current.status === "done" || current.status === "cancelled" || hasOpenFailureQuestion(db, task.id)) return;
    registerFailureQuestion(
      db,
      current,
      `task checkout could not be released: ${current.title}`,
      namesCheckout ? `${reason}\n\n${KEPT_TASK_CHECKOUT.at(path)}` : reason,
      now,
      KEPT_TASK_CHECKOUT.retry,
    );
  })();
}

/** ADR 0356 決定5: merge back advances the target ref without switching branches. A conflict opens the workbench under `workbenchBase`
 *  for both teardown and quarantine acceptance (ADR 0373 決定9). */
function mergeBackInto(
  db: Db,
  workspace: WorkspaceConfig,
  workbenchBase: string,
  target: string,
  taskId: string,
  raisedBy: "release" | "acceptance",
  recordedTip?: string,
): void {
  const source = taskBranch(taskId);
  const ref = `refs/heads/${target}`;
  const oldTip = git(workspace.path, "rev-parse", ref);
  const sourceTip = recordedTip ?? git(workspace.path, "rev-parse", `refs/heads/${source}`);
  if (isAncestor(workspace, sourceTip, oldTip)) return;
  const sha = isAncestor(workspace, oldTip, sourceTip)
    ? sourceTip
    : mergeCommit(workspace, oldTip, sourceTip, `Merge ${source} into ${target}`);
  if (sha === undefined) throw mergeBackConflict(workspace, workbenchBase, source, target, raisedBy, humanWorkReceives(db, target));
  advanceBranch(db, workspace, ref, oldTip, sha);
}

/** ADR 0371 決定7・11 / ADR 0373 決定9: merge back の conflict は作業台を開き、その在り処・そこで打つ merge・tip の条件・答え直しを言う
 *  (spec #3273 text A1)。開けなければその理由を言い、答え直しが開き直す(text A7d)。解放の理由は句点で閉じない —— Quarantine の本文が
 *  理由の後に句点を打つ。受理の拒否は文のまま人間に届く。 */
function mergeBackConflict(workspace: WorkspaceConfig, base: string, source: string, target: string, raisedBy: "release" | "acceptance", humanWork: boolean): Error {
  const exit = (merge: string) =>
    `To discard ${source}'s work instead, record that with \`git merge -s ours ${merge}\`. ` + (raisedBy === "release" ? "Then answer" : "Then answer again.");
  return new NamedPlaceSideError(workbenchConflict(workspace, base, { subject: source, carried: `refs/heads/${source}`, target, exit, humanWork }, raisedBy === "release" ? "" : "."));
}

/** text A1 / A2 の共通の形: (書く先, 運ばれる側) の作業台を開き、その在り処・そこで打つ merge・tip の条件を言って `exit` で終える。開けなければ
 *  その理由を言い、答え直しが開き直す(text A7d、`stop` で閉じる)。`carried` は運ばれる側の ref(`board/` の下にはその短い名前)、`subject` は
 *  文の主語。 */
function workbenchConflict(
  workspace: WorkspaceConfig,
  base: string,
  { subject, carried, target, exit, humanWork = false }: { subject: string; carried: string; target: string; exit: (merge: string) => string; humanWork?: boolean },
  stop: string,
): string {
  const conflict = `${subject} does not merge cleanly into '${target}'.`;
  const opened = openWorkbenchOrSayWhy(workspace, base, target, carried, conflict, stop, humanWork);
  if (typeof opened === "string") return opened;
  const source = shortRef(carried);
  const merge = boardBranch(source);
  return (
    `${conflict} The board opened the workbench at ${opened.path} for it${lacksCarried(opened.owner) ? `; its tip does not contain ${source}` : ""}. There, on ${target}, run \`git merge ${merge}\` and resolve the conflict ` +
    `${fromOwnClone(target, merge)}. ${tipCondition(target, source)} ${exit(merge)}`
  );
}

/** spec #3273 の ADR 0382 の上書きの「文」: 盤面の手が conflict し、作業台の tip が書く先に含まれない(人間の commit がある)—— その tip は
 *  運ばれる側を含まない。人間担当の work 自身の作業台では、子を含まない tip は盤面の手の側に判定される(鍵に子が入らない)。 */
const lacksCarried = (owner: WorkbenchOwner) => (owner.kind === "mine" && owner.lacksCarried) || owner.kind === "board";

/** spec #3273 text の `{tip}`。 */
const tipCondition = (target: string, source: string) =>
  `Your tip must contain both ${target} as the board has it now (\`${boardBranch(target)}\`) and ${source}, with nothing uncommitted.`;

/** 拒否の中で作業台を開く(ADR 0371 決定7)。開けなければ、在り処を言わない拒否文(text A7d)を返す —— `lead` は場面の文、`stop` で閉じる。 */
function openWorkbenchOrSayWhy(workspace: WorkspaceConfig, base: string, target: string, carried: Carried, lead: string, stop: string, humanWork = false): { path: string; owner: WorkbenchOwner } | string {
  try {
    if (!humanWork) return openWorkbench(workspace, base, target, carried);
    // ADR 0382 決定3: 書き始めた人間担当の work には自身の作業台で —— 子の入口は鍵に入らない
    const { path } = openHumanWorkWorkbench(workspace, base, target);
    return { path, owner: judgeOnDisk(workspace, path, target, carried, false) };
  } catch (err) {
    if (err instanceof WorkbenchUnreadableError) return `${lead} The board cannot read the workbench at ${err.at} (${err.message}); remove it by hand, then answer again${stop}`;
    return `${lead} ${couldNotOpenWorkbench(err, "answer again and it opens it again", { stop })}`;
  }
}

/** ADR 0376 決定4 / ADR 0395 決定1: 出元 repo の `task/<root>`(PR が在ればその head)に盤面の知らない commit がある —— head が local の `task/<root>` の祖先で
 *  ない。そのとき盤面は merge も push もせず、(`task/<root>`, GitHub の head) の作業台を開いて `board/origin/task/<root>` をその head に置き、
 *  中身を見るコマンド・そこで打つ merge・tip の条件・答え直す回答を言う(spec #3273 text D1。開けなければ A7d)。clean に merge できるかは
 *  問わない。head が祖先なら undefined。 */
export function outsideCommitsStop(workspace: WorkspaceConfig, workbenchBase: string, taskId: string, head: string): PromotionStopError | undefined {
  const target = taskBranch(taskId);
  if (isAncestor(workspace, head, `refs/heads/${target}`)) return undefined;
  const carried = outsideHead(taskId, head);
  const repo = repositoryLabel(workspace.head_repo!);
  const found = `Head repo ${repo}'s ${target} holds commits the board did not push (${head}).`;
  const opened = openWorkbenchOrSayWhy(workspace, workbenchBase, target, carried, found, ".");
  if (typeof opened === "string") return new PromotionStopError(opened);
  const source = shortRef(carriedRef(carried));
  const merge = boardBranch(source);
  return new PromotionStopError(
    `${found} See them with \`git log --stat ${target}..${merge}\` in the workbench at ${opened.path}. The board does not merge outside commits itself: ` +
      `there, on ${target}, run \`git merge ${merge}\` ${fromOwnClone(target, merge)}. ${tipCondition(target, `${target} on head repo ${repo} (\`${merge}\`)`)} Then answer \`retry\`.`,
  );
}

/** spec #3273 の入口の表 "Refused once"(ADR 0382 の上書き): `pr_merge` の拒否が、人間に伝えた GitHub の head を (`task/<root>`, GitHub の head)
 *  の作業台に残す印。`refs/heads/` の外に置くので、引き直しの `--prune` で消えず、人間が merge する `board/origin/task/<root>` とも、取り込みが
 *  人間の作業として数える branch とも分かれる。書くのはその拒否だけ。 */
const REFUSED_ONCE = "refs/board/refused-once";

const outsideHeadWorkbench = (workspace: WorkspaceConfig, base: string, taskId: string) => workbenchAt(workspace, base, taskBranch(taskId), outsideHeadRef(taskId));

/** 印の値(無ければ undefined)。作業台を開く前に読む —— 開き直しは人間の作業の無い作業台を作り直し、印ごと消す。 */
export function refusedOnceHead(workspace: WorkspaceConfig, base: string, taskId: string): string | undefined {
  const at = outsideHeadWorkbench(workspace, base, taskId);
  if (!placeHasRepository(at)) return undefined;
  return workerRepoGit(realpathSync(at), "for-each-ref", "--format=%(objectname)", REFUSED_ONCE) || undefined;
}

/** push が済んだ印を消す —— 同じ head へもう一度動かされれば、もう一度拒む。 */
export function clearRefusedOnce(workspace: WorkspaceConfig, base: string, taskId: string): void {
  const at = outsideHeadWorkbench(workspace, base, taskId);
  if (placeHasRepository(at)) workerRepoGit(realpathSync(at), "update-ref", "-d", REFUSED_ONCE);
}

/** ADR 0376 決定7 / ADR 0371 決定10: 記録済みの PR の head が盤面の外で巻き戻された・書き換えられた —— `merge` を拒み、(`task/<root>`, GitHub の
 *  head) の作業台を開いて `board/origin/task/<root>` をその head に置き、印をその head にして、戻す・捨てる手順を言う(spec #3273 text A4a・A4b。
 *  開けなければ A7d)。`lacks` は text A4 / A4d の `<branches>` の句。`answerOn` は拒否が question を立て直したときの、次に答える question
 *  (ADR 0394 決定3)—— 無ければ同じ question に答え直す。 */
export function outsidePushRefusal(
  workspace: WorkspaceConfig,
  base: string,
  taskId: string,
  { prNumber, head, headBranch, rewound, lacks, answerOn }: { prNumber: number; head: string; headBranch?: string; rewound: boolean; lacks: string; answerOn?: string },
): string {
  const target = taskBranch(taskId);
  const carried = outsideHead(taskId, head);
  const location = headBranch ? ` (${headBranch})` : "";
  const lead = `PR #${prNumber}'s head${location} was ${rewound ? "moved" : "rewritten"} outside the board to ${head}, which ${lacks}.`;
  const opened = openWorkbenchOrSayWhy(workspace, base, target, carried, lead, ".");
  if (typeof opened === "string") return opened;
  workerRepoGit(opened.path, "update-ref", REFUSED_ONCE, head);
  const source = shortRef(carriedRef(carried));
  const merge = boardBranch(source);
  const discard = `\`git merge -s ours --no-commit ${merge}\`, \`git read-tree -u --reset ${merge}\`, \`git commit\``;
  const place = `${lead} The board opened the workbench at ${opened.path}.`;
  const again = answerOn === undefined ? "again" : `on question ${answerOn}`;
  return rewound
    ? `${place} Answer \`merge\` ${again} and the board pushes that content back. To discard it instead, first run there, on ${target}: ${discard} ` +
        `(or the same in your own clone, then push ${target} to the workbench); then answer \`merge\` ${again}.`
    : `${place} There, on ${target}, either keep that content with \`git merge ${merge}\` ${fromOwnClone(target, merge)}, or discard it with ${discard}. ` +
        `${tipCondition(target, `${headBranch ?? "the PR's observed head"} (\`${merge}\`)`)} Then answer \`merge\` ${again}: the board takes your merge in and pushes it, and CI runs on the result.`;
}

/** ADR 0376 決定6: PR の記録が無い根の巻き戻し —— 出元 repo の head が、盤面が最後に push した値の真の祖先。値は写し
 *  `refs/remotes/head-repo/task/<root>` から、盤面自身が push の成功を見て書いた値として読む(決定3 / ADR 0395 決定1・3)。
 *  そのとき盤面は push せず、作業台も開かず、出元 repo への操作2つ(落とされた commit を push し直す / ブランチを消す)を言う
 *  (spec #3273 text D2。`foundPr` は記録の無い見つけた PR)。ADR 0376 決定2: 写しが読めなければ止めない。写しと分かれた head は巻き戻しでは
 *  なく、盤面の知らない commit として `outsideCommitsStop` が受ける。巻き戻しでなければ undefined。 */
export function rewindStop(workspace: WorkspaceConfig, taskId: string, head: string, foundPr?: number): PromotionStopError | undefined {
  const branch = taskBranch(taskId);
  const lastPushed = readRef(workspace, remoteTrackingRef(branch, HEAD_REPO_REMOTE));
  if (lastPushed === "" || lastPushed === head || !isAncestor(workspace, head, lastPushed)) return undefined;
  const target = `head repo ${repositoryLabel(workspace.head_repo!)}'s ${branch}`;
  return new PromotionStopError(
    `${target} was rewound outside the board: it is at ${head} and no longer contains ${lastPushed}, which the board pushed. ` +
      `The board does not push over a rewind. Either push the dropped commits back to ${target} (a fast-forward from ${head} to ${lastPushed}; ` +
      `those commits are in the board's checkout at ${workspace.path} — fetch them from there into your clone, and never push from there), ` +
      `or delete ${target} and the board re-creates it${foundPr === undefined ? "" : ` — deleting it closes PR #${foundPr}`}. Then answer \`retry\`.`,
  );
}

/** ADR 0240 決定4: 内容が帰り先(lineage が指す祖先のタスクブランチ)に届いていない done の work と、その帰り先。`root` があれば
 *  その分解ツリーの中だけ(ADR 0371 決定10)。新しい行から並べる —— 子孫の内容を先に子へ運んでから、子を親へ運ぶ。読めなければ投げる(fail-closed)。
 *  shortcut: その workspace の done の子をすべて読む。回答のたびなので、遅くなれば着地の終わった木を SQL で外す。 */
function undeliveredMergeBacks(
  db: Db,
  workspace: WorkspaceConfig,
  defaultWorkspaceName: string | undefined,
  root: string | undefined,
  now: () => Date,
): Array<{ taskId: string; target: string }> {
  const rows = db
    .prepare(
      `${subtreeSql("?")} SELECT id FROM tasks
        WHERE type = 'work' AND status = 'done' AND parent_id IS NOT NULL AND COALESCE(${derivedWorkspaceSql("tasks")}, ?) = ?
          AND (? IS NULL OR id IN (SELECT id FROM subtree))
        ORDER BY rowid DESC`,
    )
    .all(root ?? null, defaultWorkspaceName ?? null, workspace.name, root ?? null) as Array<{ id: string }>;
  return rows.flatMap(({ id }) => {
    // ADR 0380 決定3: 失われた ref は git で読まない —— give-up が消す(ADR 0392 決定1)ので、在っても task の成果ではない
    if (taskBranchLostInForce(db, id) || !taskBranchExists(workspace, id)) return [];
    const target = lineageTaskBranch(db, workspace, getTask(db, id)!, now);
    return target && branchMergeEffect(workspace, target, taskBranch(id)).changesCandidate ? [{ taskId: id, target }] : [];
  });
}

/** ADR 0240 決定4: workspace の quarantine の受理の検査がやり直す merge back(積み残しの retry は `root` の分解ツリーの分だけ、
 *  ADR 0371 決定10)。届いていない done の work が無ければ何もしない
 *  (ネットワークにも出ない)。あれば、走っている session(後始末が未了のものを含む)が無いことを読んでから(ADR 0064)、
 *  保護ブランチの fetch(`refreshProtectedBranch`)→ 帰り先へ merge back → 休止位置へ
 *  戻す、を踏む。どの書き込みも口を通り、基準の行は書いた値に
 *  畳まれる(ADR 0243 決定4)。conflict は中断状態を残さないので、休止位置へ戻して出口の文のまま投げる。 */
export async function redoMergeBacks(
  db: Db,
  workspace: WorkspaceConfig,
  defaultWorkspaceName: string | undefined,
  auth: GitHubAuth | undefined,
  /** 作業台の基点(ADR 0373 決定9)と、取り込みの event に残す回答者と時刻(spec #3273 の識別子の表 / pin A5)。 */
  intake: IntakeContext,
  /** 積み残しの retry(ADR 0371 決定10): 撃ち直す根の分解ツリーと、撃ち直す前に掛ける受理の前半(受理は自分の順で先に掛け済み)。 */
  retry?: { root: string; firstHalf: () => Promise<void> },
  /** fetch の await の後、ref を読む前の比較(ADR 0370 決定1 / ADR 0373 決定7)。 */
  compareRefs?: () => void,
): Promise<string[]> {
  const root = retry?.root;
  if (undeliveredMergeBacks(db, workspace, defaultWorkspaceName, root, intake.now).length === 0) return [];
  await retry?.firstHalf();
  const running = db
    .prepare(
      `SELECT 1 FROM tasks WHERE COALESCE(${derivedWorkspaceSql("tasks")}, ?) = ? AND (status = 'in_progress' OR teardown_started_at IS NOT NULL)`,
    )
    .get(defaultWorkspaceName ?? null, workspace.name);
  if (running) {
    throw new Error(`a session or its teardown is still running in workspace ${workspace.name} — answer again once it has finished`);
  }
  await refreshProtectedBranch(db, workspace, auth, intake.now);
  compareRefs?.();
  // どの拒否でも休止位置へ戻す。先に落ちた理由(出口の文か git の理由)を休止の失敗より優先し、休止の失敗は運び終えたときだけ投げる
  let failure: { error: unknown } | undefined;
  // 作業台を残した取り込みの text C6 と、作業台を消せなかった取り込みの文
  const kept: string[] = [];
  try {
    // 1つ運ぶたびに読み直す —— 子孫を運んだ子は、親へ運ぶ内容を新しく持つ。ADR 0382 決定2: 人間の tip を持つ作業台を盤面の手の merge より
    // 先に取り込む —— 盤面が先に書く先を進めると、その tip は書く先の今の値を欠いて拒まれる
    next: for (;;) {
      const pending = undeliveredMergeBacks(db, workspace, defaultWorkspaceName, root, intake.now);
      if (pending.length === 0) break;
      for (const candidate of pending) {
        const taken = takeInMergeBack(db, workspace, candidate, intake);
        if (taken === undefined) continue;
        if (taken.kept !== undefined) kept.push(taken.kept);
        continue next;
      }
      mergeBackInto(db, workspace, intake.workbenchBase, pending[0]!.target, pending[0]!.taskId, "acceptance");
    }
  } catch (error) {
    failure = { error };
  }
  try {
    parkOnProtectedBranch(db, workspace);
  } catch (parkError) {
    if (!failure) throw parkError;
  }
  if (failure) throw failure.error;
  return kept;
}

/** ADR 0103 決定1: 着地の時点で保護ブランチが**盤面自身の記録から外れて**動いていた
 *  ことの証拠。着地経路で quarantine を引き起こす失敗はこれ**だけ**であり(決定4)、
 *  呼び出し元はこの型で「資源の封じ込め」と「回答の拒否」を見分ける。 */
export class OutOfBandProtectedBranchError extends Error {
  constructor(workspaceName: string, branch: string, recorded: string | undefined, actual: string) {
    super(
      `workspace ${workspaceName}: protected branch '${branch}' moved out of band — ` +
        (recorded === undefined
          ? "the board has no recorded position for it"
          : `the board recorded it at ${recorded}`) +
        ` and it now sits at ${actual}`,
    );
  }
}

/** 昇格の失敗の question の本文と retry の拒否にそのまま使う文(ADR 0371 決定11)—— 人間の次の手まで言い切っている。追いつきの conflict
 *  (H6、text A2。作業台を開けなければ A7d)、origin の盤面の知らない commit(text D1)、巻き戻し(text D2)。 */
export class PromotionStopError extends Error {}

/** ADR 0105 決定2: catch the task branch up to the protected ref with the task branch as first parent.
 *  ADR 0356 決定5: a checked-out branch's worktree follows its ref.
 *  ADR 0382 決定1: a conflict opens the (workspace, task branch, protected branch) workbench under `workbenchBase`. */
export function catchUpTaskBranch(db: Db, workspace: WorkspaceConfig, taskId: string, workbenchBase: string, answer: "retry" | "merge" = "retry"): void {
  const branch = taskBranch(taskId);
  const ref = `refs/heads/${branch}`;
  const protectedRef = protectedBranchRef(workspace);
  if (isAncestor(workspace, protectedRef, ref)) return;
  const taskSha = git(workspace.path, "rev-parse", ref);
  const merged = mergeCommit(workspace, taskSha, protectedRef, `Merge ${protectedRef} into ${branch}`);
  if (merged === undefined) {
    // 捨てる文は無い —— もう1つの出口は `abandon promotion` のまま(text A2)。`merge` の中の追いつきは `merge` を言い直させる(text A3 の形)
    const exit = () => (answer === "merge" ? "Then answer `merge` again." : "Then answer `retry`.");
    // 鍵は取り込み(`takeInCatchUp`)と同じ綴りの ref から
    throw new PromotionStopError(workbenchConflict(workspace, workbenchBase, { subject: protectedBranch(workspace), carried: exactProtectedBranchRef(workspace), target: branch, exit }, "."));
  }
  advanceBranch(db, workspace, ref, taskSha, merged);
}

/** ADR 0103 決定1: 保護ブランチの今の値が盤面の記録と一致すれば返し、一致しなければ(記録に行が無い場合も)帯域外として投げる ——
 *  local 着地と `take in` が書く先の値として使う。 */
function protectedValueAsRecorded(db: Db, workspace: WorkspaceConfig): string {
  const branch = protectedBranch(workspace);
  const ref = `refs/heads/${branch}`;
  const protectedSha = git(workspace.path, "rev-parse", ref);
  const recorded = recordedRef(db, workspace.name, ref);
  if (!baselineAllows(recorded, protectedSha)) throw new OutOfBandProtectedBranchError(workspace.name, branch, recorded, protectedSha);
  return protectedSha;
}

/** ADR 0401 決定4 / ADR 0418 決定2: task の tip(`tip`、省略時は今の `task/<id>`)が保護ブランチ(`protectedSha`、省略時は今の値)に含まれていれば、
 *  この根を持ち込んだ commit —— first-parent の列の上で tip を初めて含む commit、tip 自身が列の上にあれば tip。含まれていなければ undefined。含まれるかは内容(ADR 0105)でなく履歴で読む
 *  —— 別の根が同じ変更を運んでもこの根の着地ではない(ADR 0289 決定3)。列の先頭は他の根の commit でありうる(ADR 0289 決定1)。
 *  ADR 0401 帰結: `task/<id>` が無ければ含まれていると読まない。git が読めなければ投げる。ADR 0401 追記(#3647): hold は question が問うた tip を渡す。 */
export function localLandingCommit(
  workspace: WorkspaceConfig,
  taskId: string,
  tip = `refs/heads/${taskBranch(taskId)}`,
  protectedSha = git(workspace.path, "rev-parse", `refs/heads/${protectedBranch(workspace)}`),
): string | undefined {
  if (!taskBranchExists(workspace, taskId)) return undefined;
  if (!isAncestor(workspace, tip, protectedSha)) return undefined;
  const tipSha = git(workspace.path, "rev-parse", tip);
  const revList = (...args: string[]) => git(workspace.path, "rev-list", ...args, `${tipSha}..${protectedSha}`).split("\n").filter(Boolean);
  // `--first-parent` と `--ancestry-path` を併せると、task の tip が第2親の先にある取り込みの commit を落とす —— 子孫を別に引いて列と突き合わせる
  const descendants = new Set(revList("--ancestry-path"));
  const oldest = revList("--first-parent").filter((commit) => descendants.has(commit)).at(-1);
  // 列の上の最古の子孫の第1親が tip(または子孫が無い)なら、tip 自身が列の上にある
  return oldest === undefined || git(workspace.path, "rev-parse", `${oldest}^1`) === tipSha ? tipSha : oldest;
}

/** ADR 0401 決定4: 取り込みで着地した後に残った鍵の作業台を、取り込みの後と同じ手(`settleTakenInWorkbench`)で片付ける。読めない作業台は
 *  残す —— 着地はもう保護ブランチにあるので拒まない。 */
function settleLandedWorkbench(named: WorkspaceConfig, base: string, target: string, carried: string, landed: string): string | undefined {
  try {
    const place = workbenchOnDisk(named, workbenchAt(named, base, target, carried));
    if (place === undefined) return undefined;
    // ADR 0418 決定3: 包む commit は (書く先の旧値, 取り込んだ tip) —— 第2親が task の tip なら着地の merge で、第2親の無い着地(tip 自身)とともに取り込みではない
    let second: string | undefined;
    gitAnswers(() => (second = git(named.path, "rev-parse", "--verify", "--quiet", `${landed}^2`)));
    const taken = second === undefined || second === git(named.path, "rev-parse", carried) ? undefined : { tip: second, commit: landed };
    return settleTakenInWorkbench(named, place, target, carried, taken, true);
  } catch {
    return undefined;
  }
}

/** ADR 0053 決定3 / ADR 0103: 承認された purely-local の着地を実行する。
 *
 *  帯域外の判定は ff の成否ではなく**盤面自身の記録との突き合わせ**で下す(決定1)。
 *  盤面が自分で進めた保護ブランチは口の畳みで記録に入っている(ADR 0243)ので記録と一致し、一致しない
 *  位置は帯域外の書き込みだけが作る —— ff が黙って飲み込んでいた巻き戻しもこれで
 *  捕まる。記録に行が無い場合も不一致として扱う(ADR 0064 決定6 と同じ fail-closed)。
 *
 *  記録と一致していれば、非 ff は同一 workspace の正当な直列進行である(決定2)。ff できる場合も含め、盤面は
 *  Tidepool 名義の真の merge commit(第1親が保護ブランチの旧値)で着地させる(ADR 0418 決定1)。タスクブランチは**決して
 *  書き換えない** —— 差分の恒久記録であり系譜判定の土台である(ADR 0053 根拠1)。
 *
 *  保護ブランチに置いた commit を返す —— 回答はこれを執行の記録として根に刻む(ADR 0289 決定1)。作業台を残した取り込みなら、その text C6 も、
 *  作業台を消せなかったならそう言う文も返す。 */
export function mergeTaskToProtected(db: Db, workspace: WorkspaceConfig, taskId: string, intake: Omit<IntakeContext, "entry">): { landed: string; kept: string | undefined } {
  if (isRemoteBacked(withRememberedRepoCheck(db, workspace, intake.now))) {
    throw new Error(`workspace ${workspace.name} is remote-backed, not purely-local`);
  }
  const branch = protectedBranch(workspace);
  const ref = `refs/heads/${branch}`;
  const protectedSha = protectedValueAsRecorded(db, workspace);

  const task = taskBranch(taskId);
  // ADR 0401 決定4: 保護ブランチを動かした後・記録の前に死んだ着地の答え直しは ref も event も書かず、この根を持ち込んだ commit を返す
  // (取り込みの後に残った作業台は片付けうる)
  const included = localLandingCommit(workspace, taskId, `refs/heads/${task}`, protectedSha);
  if (included !== undefined) return { landed: included, kept: settleLandedWorkbench(workspace, intake.workbenchBase, branch, `refs/heads/${task}`, included) };
  // ADR 0382 決定4: 決着済み・cancel 済みを含むすべての task のブランチの commit を作業台の tip に許さない —— 答えている task の tip にある
  // commit は数えない。ADR 0371 決定2・4: 作業台に人間の merge があれば、この回答がそれを取り込み、包む commit が着地
  const refusalFor = (branches: string[], at: string) =>
    `the tip of the workbench at ${at} contains commits of ${branches.join(", ")}, and a task's work enters ${branch} only through its own landing. ` +
    mergeOnlyCarried(branch, task, "answer again");
  const taken = takeInExistingWorkbench(db, workspace, branch, `refs/heads/${task}`, { ...intake, entry: "landing_merge" }, {
    checks: { approved: protectedSha, otherTasks: { range: "every task", refusalFor } },
  });
  if (taken !== undefined) return { landed: taken.commit, kept: taken.kept };
  // #3646 の仕様の完了条件4(landing-4「task のブランチが無ければ、保護ブランチに含まれていると読まない」が固定): ブランチが消えていれば、
  // merge-tree の手前の失敗でなく task のブランチを名指す git の文で拒む
  git(workspace.path, "cat-file", "-e", task);
  // ADR 0418 決定1: ff できる場合も ff しない —— 第1親が旧値の merge commit で、保護ブランチの first-parent の列を着地の並びにする
  const landed = mergeCommit(workspace, protectedSha, `refs/heads/${task}`, `Merge ${task} into ${branch}`);
  if (landed === undefined) {
    // ADR 0103 決定4: 合わないと分かっただけ —— 回答の拒否であって隔離ではない。捨てる文は無い、もう1つの出口は `hold`(text A3)
    const exit = () => "Then answer `merge` again.";
    throw new Error(workbenchConflict(workspace, intake.workbenchBase, { subject: task, carried: `refs/heads/${task}`, target: branch, exit }, "."));
  }
  // ADR 0064 決定4 / ADR 0356 決定5: a human landing may race with a session, so follow only if HEAD is on this ref.
  advanceBranch(db, workspace, ref, protectedSha, landed);
  return { landed, kept: undefined };
}

/** boot 時の一斉検査(ADR 0040)。登録済みの全 workspace に pickup と同じ検査を
 *  掛け、該当を最初から needs-human にする — 「WebUI から実行時に登録できる」以上
 *  boot 一点では取りこぼすので、これは**床ではなく早く騒ぐ側**であり、床は
 *  pickup 側にある(名前の場所は pickup の述語 —— ADR 0377 決定4、task の checkout は spawn の検査)。
 *
 *  **起動そのものは拒まない**: 起動拒否は「人間面は開いたままが復旧経路」
 *  (ADR 0036 の fail-open)と衝突する。列挙自体の失敗(registry の yaml が壊れて
 *  いる、clone が読めない)も同じ線で握り潰してログに落とす — 検査ができなかった
 *  ことで盤面が起動しなくなるほうが、直す手段を人間から奪う。 */
export function sweepBoardStateOverlap(
  db: Db,
  paths: BoardStatePath[],
  listWorkspaces: () => WorkspaceConfig[],
  now: Date,
): void {
  let workspaces: WorkspaceConfig[];
  try {
    workspaces = listWorkspaces();
  } catch (err) {
    // overlap sweep は ADR 0040 の一斉検査
    console.error(
      "[board-state] could not enumerate registered workspaces for the board-state overlap sweep; " +
        `pickup still checks where each task runs (its workspace, or an Interview's room) as it is picked up (${String(err)})`,
    );
    return;
  }
  for (const workspace of workspaces) {
    const overlap = boardStateOverlap(workspace.path, paths);
    if (overlap) quarantineWorkspace(db, workspace.name, new Error(overlap.reason), now);
  }
}
