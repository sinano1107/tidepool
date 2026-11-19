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
  rmdirSync,
  rmSync,
  type Stats,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BOARD_ACTOR_ID } from "./actor-id.js";
import { type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { ContainmentCapability } from "./containment.js";
import type { Db } from "./db.js";
import { DomainError } from "./domain-error.js";
import { appendEvent, type EventOrigin, type IntakeEntry, type KeptValue, latestEventOfTask, type ReadCheckout, type ResourceStop, type TaskCheckoutWriteObservation } from "./events.js";
import {
  boardReadTree,
  boardViewStatus,
  boardWriteTree,
  CheckoutHostError,
  CheckoutUnreadableError,
  diffTreeEntries,
  displayWorktreePath,
  git,
  gitAnswers,
  gitlinkChanges,
  gitWithInput,
  gitWithoutHistoryOverrides,
  isAncestor,
  outOfSpace,
  ownWorktreeStatus,
  readCheckoutOrigin,
  type SparsePolicy,
  stagingHostStep,
  type WorktreeChange,
  WorktreeStatusError,
  withBoardGit,
  workerRepoGit,
  workerRepoGitUntil,
} from "./git.js";
import {
  authedLsRemote,
  GIT_NETWORK_TIMEOUT_MS,
  type GitHubAuth,
  isRelativeLocalPath,
  networkDestination,
  remoteTrackingRef,
  workspaceNetworkDestination,
} from "./github-auth.js";
import {
  assertOwnGitDirectory,
  assertRemoteDeclarationMatchesClone,
  checkoutPickupPredicates,
  conventionCheckoutPath,
  exactProtectedBranchRef,
  gonePlaceReason,
  isRemoteBacked,
  OriginRepositoryMismatchError,
  type PickupPredicate,
  type PlaceFire,
  protectedBranch,
  protectedBranchRef,
  readHeadOf,
  resolvablePosedHead,
  roomPickupPredicates,
  roomPlace,
  safeRealpath,
  taskBranch,
  taskBranchExists,
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
  type WorkspaceEntry,
} from "./registry.js";
import { repositoryLabel, sameRepository } from "./repo-access.js";
import { humanOnlyPathChanges, PROJECT_SETTINGS_PATHS, recordedSettingsDisposition, SANDBOX_STUB_PATHS } from "./sandbox.js";
import { isSettled } from "./task-status.js";
import {
  ancestorsSql,
  carriesReadOnly,
  getTask,
  holdsFirstCaptures,
  interviewRole,
  interviewRoomPath,
  interviewRootIdOf,
  issueRefPlaceholder,
  keepsCheckoutAsRecord,
  readableInterviewRooms,
  registerFailureQuestion,
  registerTask,
  sessionReadCheckouts,
  subtreeSql,
  type Task,
  taskCheckoutPath,
  taskCheckoutWasReleased,
  tasksOwingReleaseOn,
  tasksReleasedOn,
} from "./tasks.js";
import { isBoardDbRefusal } from "./unhandled-rejection-floor.js";
import { BOARD_BRANCHES, foreignTaskBranches, type WorkbenchOwner, workbenchOwner, workbenchPath } from "./workbench.js";
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
  /** ADR 0378 決定7・8: board operations recheck the live declaration before using its destination. */
  checkRememberedRepo?: (place: WorkspaceConfig) => Pick<WorkspaceConfig, "path" | "repo">;
  /** Command prefixes a review session may run despite the `manual` write
   *  floor (issue #144 / ADR 0035), passed through from the registry entry the
   *  same way `branch` is. Absent → none: a `WorkspaceConfig` built outside the
   *  registry widens nothing. */
  review_allowed_commands?: string[];
  /** Workspace-scoped sandbox egress domains (ADR 0072). Absent opens none. */
  allowed_domains?: string[];
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

/** task の checkout で走る場所(ADR 0356 決定1)。 */
export type TaskCheckoutPlace = WorkspaceConfig & { reads: WorkspaceConfig[]; namedPlace: WorkspaceConfig; borrowsNamedObjects: boolean };

function isTaskCheckout(place: WorkspaceConfig): place is TaskCheckoutPlace {
  const checkout = place as Partial<TaskCheckoutPlace>;
  return checkout.namedPlace !== undefined && typeof checkout.borrowsNamedObjects === "boolean";
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
  constructor(public readonly workspaceName: string) {
    super(`unknown workspace: ${workspaceName}`);
  }
}

/** An Interview task's place (its room, or an examinee's own checkout) has no opened event: the board never got as far as making it. */
export class PlaceNotOpenError extends Error {}

/** ADR 0009: `task.workspace` is a reference to a registry name, resolved
 *  fresh against the registry every time it's used, never pinned to a path.
 *  Null — a task never picked up, since pickup writes the default's name
 *  (ADR 0233) — inherits the board's default (GLOSSARY.md's Workspace). `workspacesBaseDir`
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
  if (!entry) throw new UnknownWorkspaceError(name);
  // the "main" default lives solely in protectedBranch — entry.branch passes
  // through as-is (possibly absent) rather than getting normalized here too
  const path = entryCheckoutPath(entry, name, workspacesBaseDir);
  return {
    name,
    path,
    branch: entry.branch,
    repo: entry.repo,
    review_allowed_commands: entry.review_allowed_commands,
    allowed_domains: entry.allowed_domains,
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

/** ADR 0329 決定10: 落ちた項の説明と場所を pickup / 解除で共有する。 */
export class PickupGateError extends Error {
  constructor(readonly place: WorkspaceConfig, cause: unknown, describe?: string) {
    super(`${cause instanceof Error ? cause.message : String(cause)}${describe ? `\n\nThe check that failed: ${describe}` : ""}`, { cause });
  }
}

/** pickup の門(ADR 0329 追記 決定7・8): task が開く場所すべてを、走る場所を開く**前**に種類付きで列挙し、種類ごとの一覧を撃つ。
 *  集合は停止の門(tasks.ts の `openedPlaceNamesSql`)が数える名前に含まれる(停止の門は受験者の `workspace` 列の実環境も数える、
 *  ADR 0368 決定3)—— 受験者は面接室(fetch 元、ADR 0356 決定1)、root は
 *  `workspace` 列の実環境と読む面接室と自分の面接室、root 配下の review は実環境と読む面接室、他は実環境。番地は記録があれば event の綴り、
 *  無ければ規約の番地。面接室には場所の項とこの task の (task, 面接室) の項を撃つ(ADR 0329 決定4 の Status 追記)。
 *  読む面接室は記録されたものだけなので、面接室の一覧は記録分岐だけを通る。root 自身の面接室は最後に撃つ —— 未記録なら
 *  作る分岐の `mkdir -p` が走るので、読む場所が落ちた root は自分の面接室を作らずに止まる。一覧の組み立ても撃つのと同じ場所の失敗として、
 *  最初に落ちた場所で `PickupGateError` を投げる。 */
export async function pickupGate(db: Db, workspace: WorkspaceConfig, task: Task, workspacesBaseDir: string, fixedPoints?: BoardStatePath[], live?: () => boolean) {
  workspace = withRememberedRepoCheck(db, workspace);
  // (task, 面接室) の項は場所の項の後 —— 受験者だけは先(下)
  const room = (rootId: string, fetchedFirst = false) => ({
    ...roomPlace(db, rootId, workspacesBaseDir),
    predicates: () => {
      const own = roomPickupPredicates(db, rootId, workspacesBaseDir, fixedPoints);
      const fetched = taskRoomPickupPredicates(db, [task], rootId, workspacesBaseDir);
      return fetchedFirst ? [...fetched, ...own] : [...own, ...fetched];
    },
  });
  const real = { ...workspace, predicates: () => checkoutPickupPredicates(workspace, fixedPoints) };
  const reads = roomsReadBy(db, task).map((read) => room(read.name));
  const rootId = interviewRootIdOf(db, task);
  const places =
    rootId === undefined
      ? [real, ...reads]
      : task.type === "interview"
        ? [real, ...reads, room(rootId)]
        // 受験者の (task, 面接室) の項が先 —— 面接室が記録に無い受験者に面接室の作る分岐(`mkdir -p`)を撃たない
        : [room(rootId, true)];
  const checks = [];
  for (const { predicates, ...place } of places) {
    if (live?.() === false) return checks;
    try {
      const list = predicates();
      await firePickupPredicates(db, place, list, "before-open", { live });
      checks.push({ place, predicates: list });
    } catch (err) {
      if (isBoardDbRefusal(err)) throw err; // ADR 0342 決定4: 包むと判定が届かない
      if (err instanceof PickupGateError) throw err;
      throw new PickupGateError(place, err);
    }
  }
  return checks;
}

/** ADR 0329 決定10・14: 同じ項を pickup と解除で撃ち、token の鮮度だけは呼び手が決める。後半の書き込みは口(ADR 0351 決定3)で、
 *  鍵は項の場所の名前。 */
/** spec #3273 の受理の順の前半(ADR 0329 決定14): 名前に掛かる前半の項 → 名前の場所の clean(`clean` のとき)。workspace の Quarantine の
 *  受理と、同じ条件で merge back を撃ち直す積み残しの retry(ADR 0371 決定10)が掛ける。 */
export async function checkAcceptanceFirstHalf(db: Db, place: WorkspaceConfig, predicates: PickupPredicate[], clean: boolean): Promise<void> {
  await firePickupPredicates(db, place, predicates, "before-open");
  if (clean) verifyWorkspaceClean(place);
}

export async function firePickupPredicates(
  db: Db,
  place: WorkspaceConfig,
  predicates: PickupPredicate[],
  phase: PickupPredicate["phase"],
  board: PickupPrep & { fresh?: boolean } = {},
): Promise<void> {
  const fire: PlaceFire = {
    fetch: async (target) => {
      target = withRememberedRepoCheck(db, target);
      await ensureWorkspaceToken(target, board.githubAuth, { fresh: board.fresh });
      if (board.live?.() === false) return;
      if (isRemoteBacked(target)) fetchBranchCopy(target, board.githubAuth, protectedBranch(target), boardRefWriter(db, target));
    },
    park: (target) => parkOnProtectedBranch(db, withRememberedRepoCheck(db, target)),
  };
  for (const predicate of predicates) {
    if (board.live?.() === false) return;
    if (predicate.phase !== phase) continue;
    try {
      if (predicate.phase === "before-open") predicate.check();
      else await predicate.check(fire);
    } catch (err) {
      if (isBoardDbRefusal(err)) throw err; // ADR 0342 決定4: 包むと判定が届かない
      throw new PickupGateError(predicate.phase === "after-open" ? predicate.place : place, err, predicate.describe);
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
  // interview type は root(ADR 0273 決定1)。root が実環境を読みだけ開くのは spawn の sandbox の読みのため —— 門も解放も読まない
  // (ADR 0363 決定1〜3 の Status 追記)
  return task.type === "interview" ? { ...place, reads: [inRealSpelling(workspace), ...place.reads] } : place;
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
  return { ...named, path, reads: sessionReadCheckouts(db, task.id).map(inRealSpelling), namedPlace: named, borrowsNamedObjects: room === undefined };
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

/** 名前の場所の objects の実体の綴り —— task の checkout の alternates と sandbox の読みの path が同じ綴りになる(ADR 0356 決定2)。 */
function namedObjects(named: WorkspaceConfig): string {
  return realpathSync(git(named.path, "rev-parse", "--path-format=absolute", "--git-path", "objects"));
}

/** ADR 0360 決定2: sandbox は名前の場所の objects を、Interview の役が借用を許すときだけ開く。 */
export function runPlaceReadPaths(place: RunPlace): string[] {
  const borrowed = isTaskCheckout(place) && place.borrowsNamedObjects ? [namedObjects(place.namedPlace)] : [];
  return [...place.reads.map((read) => read.path), ...borrowed];
}

/** 盤面が pickup ごとに作る checkout の番地(ADR 0356 決定2 / ADR 0361 決定1): 番地と、解放が消す空になった親の段数を1か所で持つ。 */
const CHECKOUT_LAYOUT = {
  /** 基点 / 鍵(task id、root は `<id>.checkout`)/ pickup の event id。`base` は在り処から基点へ戻る逆 */
  task: { at: (base: string, key: string, pickup: number) => join(conventionCheckoutPath(key, base), String(pickup)), parents: 1, base: (checkout: string) => dirname(dirname(checkout)) },
  /** 基点 / `<task id>.reads` / pickup の event id / 読む面接室の名前(root id) */
  read: { at: (base: string, taskId: string, pickup: number, rootId: string) => join(conventionCheckoutPath(`${taskId}.reads`, base), String(pickup), rootId), parents: 2 },
  /** 基点 / `@workbench` / (書く先, 運ばれる側) の葉(ADR 0382 決定1、番地の不変条件は `workbenchPath`)。保護ブランチの葉は workspace を持つ。
   *  運ばれる側の無い鍵は人間自身の内容の作業台(ADR 0382 決定4) */
  workbench: {
    at: (base: string, named: WorkspaceConfig, target: string, carried?: string) =>
      workbenchPath(base, target === protectedBranch(named) ? { workspace: named.name } : { task: target.slice("task/".length) }, carried),
    parents: 1,
  },
  /** 基点 / `@containment-check` / 検査ごとの id(ADR 0379 決定2)。`@` は workspace の名前にも task id にも無いので、workspace・面接室・task の
   *  checkout・読み専用の checkout・作業台のどの番地にもならず、どの worker の sandbox も開かない。spawn の2段目は in-flight の鍵の外で走るので検査ごとに別の番地 */
  containmentCheck: { at: (base: string) => join(base, "@containment-check", randomUUID()), parents: 1 },
} as const;

export { CheckoutHostError } from "./git.js";

/** ADR 0356 決定2: 番地 `at` に自分の git directory を空の template から作り、`from`(既定は名前の場所)の `source`(ref の名前か sha)だけを
 *  ローカルの `branch` へ fetch して checkout する。`borrow` なら objects は名前の場所から alternates で借り、借りなければ複製 ——
 *  引いたものの閉包しか持たない。`config` は init の直後に置く git config(作業台の `receive.denyCurrentBranch=updateInstead`、
 *  ADR 0371 決定9)。番地を作れないのは host 側の失敗(`description` が文の主語)、fetch と tree の展開の失敗は素のまま。
 *  返すのは実体の綴りの在り処。 */
function makeCheckout({ at, named, from = named.path, source, branch, borrow, description, config = {} }: {
  at: string;
  named: WorkspaceConfig;
  from?: string;
  source: string;
  branch: string;
  borrow: boolean;
  description: string;
  config?: Record<string, string>;
}): string {
  // 名前の場所の objects が引けないのは名前の場所の性質 —— host 側の失敗に包まず、呼び手の quarantine へ
  const objects = borrow ? namedObjects(named) : undefined;
  let path: string;
  try {
    mkdirSync(at, { recursive: true });
    path = realpathSync(at);
    git(path, "init", "--quiet", "--template=", "--initial-branch=main");
    if (objects !== undefined) {
      mkdirSync(join(path, ".git", "objects", "info"), { recursive: true });
      writeFileSync(join(path, ".git", "objects", "info", "alternates"), `${objects}\n`);
    }
    for (const [key, value] of Object.entries(config)) git(path, "config", key, value);
  } catch (cause) {
    throw new CheckoutHostError(`${description} cannot be created: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  // reflog にも名前の場所の在り処を残さない —— 受験者に面接室の在り処(root id)を運ばない(ADR 0276 決定1)。
  // `branch` が未生の main(init の current branch)でも fetch できるよう --update-head-ok
  // ADR 0364 決定2・3: 盤面所有の写しから読む人間の byte は `fetchFromBoardCopy` と同じく有界
  const boundedOnBoardCopy = from === named.path ? git : workerRepoGit;
  boundedOnBoardCopy(path, "-c", "core.logAllRefUpdates=false", "fetch", ...FETCH_FLAGS, "--update-head-ok", from, `${source}:refs/heads/${branch}`);
  // alternates 越しの fetch は objects の欠けを見ないので、欠けた blob で落ちる plumbing で tree を出す(porcelain の checkout は黙って欠く)
  git(path, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  boundedOnBoardCopy(path, "read-tree", "-u", "--reset", "HEAD");
  return path;
}

/** 検査の間だけ disk にある checkout。`remove` は検査のどの出口でも呼ぶ。 */
type ThrowawayCheckout = { path: string; remove: () => void };

/** ADR 0379 決定2: 封じ込めの検査が列挙させる使い捨ての checkout —— task の checkout と同じ作り手で、同じ基点の下に、名前の場所の objects を
 *  借りて作る。名前の場所には何も書かない。`from` は `source` を引く repo(既定は名前の場所)。作れなければ作りかけを残さず投げる。 */
function openThrowawayCheckout(named: WorkspaceConfig, base: string, source: string, from?: string): ThrowawayCheckout {
  const at = CHECKOUT_LAYOUT.containmentCheck.at(base);
  const remove = () => removeBoardCheckout(at, CHECKOUT_LAYOUT.containmentCheck.parents);
  const branch = protectedBranch(named);
  try {
    return { path: makeCheckout({ at, named, from, source, branch, borrow: true, description: `the throwaway checkout of ${branch}` }), remove };
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
 *  前の session が残した checkout は動かさず再利用もしない。タスクブランチだけを checkout し、objects は名前の場所から借りる。
 *  Interview の場所は借りずに複製で、自分のブランチだけを引くので兄弟の答案は見えない(ADR 0356 決定2)。root の番地は面接室
 *  (基点 + root id)の外 —— 面接室の内側に checkout を置かない(ADR 0276 決定1)。開いた event は repo ができた後に書く(ADR 0329)。 */
function openTaskCheckout(db: Db, named: WorkspaceConfig, task: Task, workspacesBaseDir: string, now: Date): void {
  const pickup = latestEventOfTask(db, task.id, "task_picked_up");
  if (!pickup) throw new Error(`task ${task.id} has no pickup to key its task checkout`);
  const role = interviewRole(db, task);
  const at = CHECKOUT_LAYOUT.task.at(workspacesBaseDir, role === "root" ? `${task.id}.checkout` : task.id, pickup.id);
  const branch = taskBranch(task.id);
  const path = makeCheckout({ at, named, source: `refs/heads/${branch}`, branch, borrow: role === undefined, description: `the task checkout of ${task.id}` });
  // 読み手の出題の head と、門の時点のタスクブランチ(受験者は無ければ fork 元の出題の head)の閉包が面接室にあることは、pickup の門の
  // (task, 面接室) の項(taskRoomPickupPredicates)が先に確かめている。門の後に欠けたものは上のタスクブランチの fetch か下の読み専用の
  // checkout の fetch で落ち、後者は fetch 元の面接室の性質として面接室の名前で止まる(ADR 0276 決定3)
  const reads = roomsReadBy(db, task).map((room) =>
    openReadCheckout(CHECKOUT_LAYOUT.read.at(workspacesBaseDir, task.id, pickup.id, room.name), room, readHeadOf(db, task, room.name), task.id));
  appendEvent(db, {
    taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", at: now,
    payload: {
      kind: "task_checkout_opened", path,
      ...(completionTreeGateApplies(task) && { completion_gate: "recorded_tip" as const }),
      ...(reads.length > 0 && { reads }),
    },
  });
}

/** ADR 0361 決定1: 読み専用の checkout —— `git init` に面接室から出題の head だけを fetch した複製(alternates なし、ADR 0356 決定2 の
 *  Interview の線)。読み手に届くのは出題の head の tree だけで、root と受験者のブランチは引けない。番地を作れないのは host 側の失敗、
 *  fetch の失敗は fetch 元の面接室の性質。 */
function openReadCheckout(at: string, room: WorkspaceConfig, head: string | undefined, taskId: string): ReadCheckout {
  let path: string;
  try {
    mkdirSync(at, { recursive: true });
    path = realpathSync(at);
    git(path, "init", "--quiet", "--template=", "--initial-branch=main");
  } catch (cause) {
    throw new CheckoutHostError(`the read checkout of the interview room ${room.name} for ${taskId} cannot be created: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (head !== undefined) {
    try {
      // 未生の main へ直接 fetch するので --update-head-ok。reflog にも面接室の在り処を残さない(ADR 0276 決定1 と同じ)
      git(path, "-c", "core.logAllRefUpdates=false", "fetch", ...FETCH_FLAGS, "--update-head-ok", room.path, `${head}:refs/heads/main`);
      git(path, "read-tree", "-u", "--reset", "HEAD");
    } catch (err) {
      throw new PickupGateError(room, err, `the posed head ${head} can be fetched from the interview room into the read checkout.`);
    }
  }
  return { name: room.name, path };
}

/** ADR 0365 決定2: 出題の写しの tree が面接室の保護ブランチの head から gitlink を足す・進める —— 文は verb の側で書く。 */
export class RoomCopyGitlinkError extends Error {
  constructor(readonly paths: string[]) {
    super(`the probe's environment adds or advances a submodule (gitlink): ${paths.join(", ")}`);
  }
}

/** ADR 0364 決定2: 盤面所有の写しから名前の場所へ tip を fetch する段の失敗 —— 名前の場所の側(解放なら quarantine、verb なら拒むだけ)。 */
export class NamedPlaceFetchError extends Error {}

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

/** 写す段の失敗は信じない checkout(task の checkout か作業台)の故障に包む。上限超過と host の失敗は型のまま(ADR 0357 決定2 / ADR 0364 決定2)。 */
function asUntrustedFailure(subject: UntrustedSubject, cause: unknown): Error {
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

/** 写して検証する段(ADR 0364 決定1): checkout の loose と `.pack` だけを `raw` へ写し(`.idx` は作り直す、`info/alternates` は辿らない)、
 *  tip の閉包を1つの pack にして `verified` で `index-pack --strict` する —— 欠けは rev-list / pack-objects が、zlib の破損は
 *  pack-objects が、中身と名前の不一致は worker の byte を持たない `verified` の検査が落とす。名前の場所の objects を借りる役は
 *  名前の場所の ref から届く閉包を pack に入れない。ref は `verified` にだけ書く。git も file の写しも段の1つの上限の中(決定3)。 */
function copyAndVerifyUntrustedTip(place: UntrustedCheckout, read: UntrustedRead, raw: string, verified: string, sha: string, ref: string, format: string): void {
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
    // ADR 0364 決定1: Interview の2役は閉包が全部写しの中で解けること —— 受験者が sha を言い当てても兄弟の答案は記録に入らない
    const objects = workerRepoGitUntil(deadline, raw, ["rev-list", "--objects", sha, ...(place.borrowsNamedObjects ? ["--not", "--alternate-refs"] : [])]);
    const packBase = join(verified, "objects", "pack", "pack");
    const pack = `${packBase}-${workerRepoGitUntil(deadline, raw, ["pack-objects", "--quiet", packBase], objects && `${objects}\n`)}`;
    // pack-objects の idx は worker が付けた loose の名前を信じる —— 捨てて中身から作り直す
    for (const derived of [".idx", ".rev"]) rmSync(`${pack}${derived}`, { force: true });
    workerRepoGitUntil(deadline, verified, ["index-pack", "--strict", `${pack}.pack`]);
    workerRepoGitUntil(deadline, verified, ["update-ref", ref, sha]);
  } catch (cause) {
    const failure = asUntrustedFailure(read, cause);
    throw failure !== cause && outOfSpace(raw, cause) ? copyHostError(read.noun, cause) : failure;
  }
}

/** 盤面が git を撃たずに tip を読む checkout —— task の checkout(ADR 0364 決定1)と作業台(ADR 0371 決定4)。在り処、作った元の
 *  名前の場所、その objects を借りるか、文の主語。 */
type UntrustedCheckout = { path: string; namedPlace: WorkspaceConfig; borrowsNamedObjects: boolean; noun: string };

const TASK_CHECKOUT = "the task checkout";

/** task の checkout を、主語を添えて信じない checkout として。 */
const untrustedTaskCheckout = (place: TaskCheckoutPlace): UntrustedCheckout => ({ ...place, noun: TASK_CHECKOUT });

/** ADR 0364 決定1・2: checkout の `branch` の tip を検証済みの盤面所有の repo として開く。 */
function withVerifiedUntrustedTip<T>(place: UntrustedCheckout, branch: string, use: (sha: string, repo: string, ref: string) => T): T {
  const { namedPlace } = place;
  // 名前の場所の側の故障を worker の repo のせいにしない —— ここで落ちれば素の失敗(呼び手の quarantine)
  const format = git(namedPlace.path, "rev-parse", "--show-object-format");
  const alternates = place.borrowsNamedObjects ? `${namedObjects(namedPlace)}\n` : undefined;
  // ADR 0364 決定3: tip の読みから閉包の検証までが1つの有界の段
  const read = untrustedRead(place);
  const { sha, ref } = readUntrustedTip(read, branch);
  // ADR 0364 決定1: 写しは盤面 process の tmp —— worker は書けない(task temp でも checkout の中でもない)
  const dir = hostStep(place.noun, () => mkdtempSync(join(tmpdir(), "tidepool-untrusted-tip-")));
  try {
    const [raw, verified] = [join(dir, "raw"), join(dir, "verified")];
    for (const repo of [raw, verified]) {
      hostStep(place.noun, () => {
        git(dir, "init", "--bare", "--quiet", "--template=", `--object-format=${format}`, repo);
        if (alternates) writeFileSync(join(repo, "objects", "info", "alternates"), alternates);
      });
    }
    copyAndVerifyUntrustedTip(place, read, raw, verified, sha, ref, format);
    return use(sha, verified, ref);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** task の checkout の `branch` の tip を、ref を書かずに名前の場所の objects へ引く。 */
function fetchUntrustedTip(place: UntrustedCheckout, branch: string): string {
  return withVerifiedUntrustedTip(place, branch, (sha, repo, ref) => {
    fetchFromBoardCopy(place.namedPlace, repo, ref, sha, "the task branch tip");
    return sha;
  });
}

/** ADR 0364 決定2・3 / ADR 0367 決定5: worker の byte を読む fetch は、盤面所有の repo からでも有界。 */
function fetchFromBoardCopy(namedPlace: WorkspaceConfig, repo: string, ref: string, sha: string, description: string): void {
  try {
    workerRepoGit(namedPlace.path, "fetch", ...FETCH_FLAGS, repo, ref);
    git(namedPlace.path, "cat-file", "-e", `${sha}^{commit}`);
  } catch (cause) {
    if (cause instanceof WorkerTreeGitTimeoutError) throw cause; // ADR 0357 決定2: 上限超過は worker の repo の故障
    throw new NamedPlaceFetchError(`workspace ${namedPlace.name}: ${description} ${sha} cannot be fetched into the named workspace: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

function fetchStagedTree(namedPlace: WorkspaceConfig, repo: string, tree: string, parent: string, subject: string, description: string): string {
  const sha = stagingHostStep(() => {
    const commit = workerRepoGit(repo, "commit-tree", tree, "-p", parent, "-m", subject);
    workerRepoGit(repo, "update-ref", "--no-deref", "HEAD", commit);
    return commit;
  });
  fetchFromBoardCopy(namedPlace, repo, "HEAD", sha, description);
  return sha;
}

/** ADR 0359 決定1: worker の tip が名前の場所のタスクブランチになるまで完了の門を通さない。 */
export function recordTaskCheckoutTip(db: Db, place: RunPlace, taskId: string): string {
  assertTaskCheckout(place, taskId);
  const { namedPlace } = place;
  const branch = taskBranch(taskId);
  const ref = `refs/heads/${branch}`;
  // ADR 0243 決定2 / ADR 0359 決定4: この書き込みの旧値だけを確かめ、帯域外の値を基準に取り込まない
  const old = taskRefAsRecorded(db, namedPlace, ref, "during the session");
  // 比べてから worker の repo を読む —— 動いた ref を worker の repo の故障の陰に隠さない
  const tip = fetchUntrustedTip(untrustedTaskCheckout(place), branch);
  if (old !== tip) boardRefWriter(db, namedPlace)(ref, tip, () => git(namedPlace.path, "update-ref", "--no-deref", ref, tip, old));
  return tip;
}

/** 作業台を開く(ADR 0371 決定7・9 / ADR 0382 決定5): 鍵の作業台に人間の作業が残っていなければ(作りかけを含む)消して
 *  書く先の ref から作り直し、残っていればそのまま使う —— 開いた question は数えない。読めない作業台は消さずに `WorkbenchUnreadableError`
 *  を、ほかの失敗(上限超過を含む)は消さずにそのまま投げる。task の checkout と同じ作り手で作るので hook は無く、`updateInstead` だけを足して人間の clone からの push を受ける。
 *  人間の branch は書く先と同じ名前で checkout され、全部を展開する(sparse にしない)。開くたびに `board/*` を引き直す。`carried` が無いのは
 *  人間自身の内容の作業台。返すのは実体の綴りの在り処と、使い続ける作業台の持ち主の判定。 */
function openWorkbench(named: WorkspaceConfig, base: string, target: string, carried?: string): { path: string; owner: WorkbenchOwner } {
  const at = CHECKOUT_LAYOUT.workbench.at(base, named, target, carried && shortRef(carried));
  // 開くのは盤面の手 —— 作りかけは作り直す(ADR 0382 決定5・6)
  const owner: WorkbenchOwner = placeHasRepository(at) ? judgeOnDisk(named, at, target, carried) : { kind: "nothing" };
  if (owner.kind === "nothing") rmSync(at, { recursive: true, force: true, maxRetries: 3 });
  const path = existsSync(at) ? realpathSync(at) : makeWorkbench(named, at, target);
  repointBoardRefs(named, path);
  return { path, owner };
}

/** disk にある作業台を盤面の手のある入口として判定する。作業台そのものの読みの失敗だけを `WorkbenchUnreadableError` にする —— 上限超過・
 *  host・名前の場所の側の失敗は、開き直しで直りうるので素のまま。 */
function judgeOnDisk(named: WorkspaceConfig, at: string, target: string, carried?: string): WorkbenchOwner {
  try {
    return judgeWorkbench(named, workbenchPlace(named, realpathSync(at)), target, { carried, boardMove: true }, (judged) => judged);
  } catch (cause) {
    if (cause instanceof CheckoutUnreadableError || cause instanceof WorktreeStatusError) throw new WorkbenchUnreadableError(at, cause);
    throw cause;
  }
}

/** 開く手が既にある作業台を読めない —— 盤面は消さないので、人間が消すまで開き直しても同じ(作り直しの失敗とは直し方が違う)。 */
class WorkbenchUnreadableError extends Error {
  constructor(readonly at: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

const workbenchPlace = (named: WorkspaceConfig, path: string): UntrustedCheckout => ({ path, namedPlace: named, borrowsNamedObjects: true, noun: "the workbench" });

/** 作業台の書く先の branch の tip を検証済みの写しに読んだもの: tip、写し、写しの ref。 */
type WorkbenchTip = { tip: string; verified: string; tipRef: string };

/** ADR 0382 決定2・6: 入口の鍵の作業台を読み、持ち主を判定する(`workbenchOwner`)。tip は ADR 0364 と同じ手で検証済みの写しに読み、
 *  `use` は判定と写しを受ける。書く先の branch が無い作業台(作りかけ)は写しを作らずに判定する —— 盤面の手のある入口(`boardMove`)では
 *  人間の作業が残っていなければ取り込むものは無く、無い入口では拒む。`carried` が無いのは人間自身の内容の作業台。 */
function judgeWorkbench<T>(
  named: WorkspaceConfig,
  place: UntrustedCheckout,
  target: string,
  { carried, boardMove }: { carried?: string; boardMove: boolean },
  use: (owner: WorkbenchOwner, read?: WorkbenchTip) => T,
): T {
  const targetSha = git(named.path, "rev-parse", "--verify", `refs/heads/${target}`);
  const carriedSha = carried && git(named.path, "rev-parse", "--verify", carried);
  const judge = (tip: string | undefined, verified: string) =>
    workbenchOwner({ at: place.path, target, targetSha, tip, verified }, carriedSha ? { sha: carriedSha, inKey: true } : undefined, { boardMove });
  try {
    return withVerifiedUntrustedTip(place, target, (tip, verified, tipRef) => use(judge(tip, verified), { tip, verified, tipRef }));
  } catch (err) {
    if (!(err instanceof BranchMissingError)) throw err;
    return use(judge(undefined, named.path));
  }
}

function makeWorkbench(named: WorkspaceConfig, at: string, target: string): string {
  try {
    return makeCheckout({ at, named, source: `refs/heads/${target}`, branch: target, borrow: true, description: `the workbench for ${target}`, config: { "receive.denyCurrentBranch": "updateInstead" } });
  } catch (err) {
    // ADR 0382 決定5: 作りかけを残さない —— 書く先の branch まで着いた作りかけは作業ツリーが tip と違い、人間の作業と見分けられずに残り続ける
    rmSync(at, { recursive: true, force: true, maxRetries: 3 });
    throw err;
  }
}

/** ADR 0371 決定7: 作業台の `refs/heads/board/*` を名前の場所の branch の今の値に引き直す —— 人間がそこへ書いたものは上書きされて
 *  消え、人間の branch と作業ツリーは動かさない。盤面が読むのは書く先の branch の tip だけ。 */
function repointBoardRefs(named: WorkspaceConfig, workbench: string): void {
  const boardRefs = `refs/heads/${BOARD_BRANCHES}/`;
  // git は checkout 中の branch へ fetch しないので、HEAD が `board/*` に居れば同じ commit で切り離す(tree も index も動かさない)
  if (headValue({ name: named.name, path: workbench }).startsWith(symrefValue(boardRefs))) {
    git(workbench, "update-ref", "--no-deref", "HEAD", git(workbench, "rev-parse", "HEAD"));
  }
  // `board/origin/<protected>` は盤面が origin から読んだばかりの保護ブランチ —— 追いつきの conflict が merge させる相手(text A2)。
  // origin の他の ref は引かない —— 開いただけの作業台が `pr_merge` の拒否の印 `board/origin/task/<root>` を付けない(spec #3273 の
  // "Refused once")。その印も次の引き直しの `--prune` が消す(消えた印は拒否をもう1度起こすだけ)
  const tracking = remoteTrackingRef(protectedBranch(named));
  const protectedFromOrigin = isRemoteBacked(named) ? [`+${tracking}:refs/heads/${boardBranch(shortRef(tracking))}`] : [];
  git(workbench, "fetch", ...FETCH_FLAGS, "--prune", named.path, `+refs/heads/*:${boardRefs}*`, ...protectedFromOrigin);
}

/** ADR 0371 決定7: 取り込みの拒否は `board/*` を引き直してから投げる —— 盤面 DB の拒否は回答の拒否に包まず底へ、引き直しもしない(ADR 0342 決定4)。 */
function repointingOnRefusal<T>(named: WorkspaceConfig, workbench: string, intake: () => T): T {
  try {
    return intake();
  } catch (err) {
    if (isBoardDbRefusal(err)) throw err;
    try {
      repointBoardRefs(named, workbench);
    } catch {
      // 引き直せなくても拒否の理由を人間に返す —— 次の拒否か開く手が引き直す
    }
    throw err;
  }
}

/** spec #3273 の入口の表の後 / text C6: 作業台を残す取り込みの後、作業台の書く先の branch を読んだ tip からの CAS で包む commit へ進め、
 *  `board/*` を引き直して text C6 を返す。包む commit は人間の tip の tree を持つので作業ツリーは clean のまま。間に push が着いていれば
 *  進めずにそう言う。ref も event も書いた後なので、作業台の失敗では拒まない。 */
function advanceKeptWorkbench(named: WorkspaceConfig, workbench: string, target: string, { tip, commit }: { tip: string; commit: string }): string {
  let advanced = false;
  try {
    workerRepoGit(workbench, "update-ref", `refs/heads/${target}`, commit, tip);
    advanced = true;
  } catch {}
  try {
    repointBoardRefs(named, workbench);
  } catch {}
  return (
    `took ${tip} in as ${commit} on ${target}. In a clone, fetch the workbench and fast-forward to \`${boardBranch(target)}\` before you write on.` +
    (advanced ? "" : ` Merge \`${boardBranch(target)}\` into your branch before the next take-in.`)
  );
}

/** 取り込みの手が受け取る束: 作業台の基点、入口、`workbench_taken_in` に残す回答者と時刻。 */
export type IntakeContext = { workbenchBase: string; entry: IntakeEntry; answerer: Answerer; now: Date };

/** 取り込みの event の actor —— 回答者か呼び手(spec #3273 の識別子の表 / pin A5)。 */
export type Answerer = { actorId: string; origin: EventOrigin };

/** ref の短い名前(`refs/heads/x` → `x`、`refs/remotes/origin/x` → `origin/x`)と、作業台でそれを引き直す `board/` の下の名前。 */
const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
const boardBranch = (short: string) => `${BOARD_BRANCHES}/${short}`;

/** 人間の clone から同じことをする手(spec #3273 text の `{clone}`)。 */
const fromOwnClone = (target: string, ref: string) =>
  `(or, in your own clone with the workbench as a remote: fetch it, \`git merge <remote>/${ref}\`, and push ${target} to it)`;

/** ADR 0371 決定2〜5: 作業台の書く先の branch の tip を1度だけ読み、盤面所有の写しの中で取り込みの検査をすべて通してから、`use` に
 *  検証済みの写しと書く先の値を渡す —— 写しは `use` が返ると消える。拒否は ref も記録も書かない。tip がこの入口のものでなければ(ADR 0382 決定2)
 *  取り込むものが無く undefined。`carried` は tip が祖先に持つべき、merge で運ばれる側の ref(`refs/heads/*` か `refs/remotes/*`)で、人間自身の
 *  内容の作業台には無い。祖先のほかに履歴は制限しない(`-s ours` も cherry-pick も別の ref の merge も通る)。`checks` は入口に固有の検査。 */
function inspectWorkbenchTip<T>(
  db: Db,
  named: WorkspaceConfig,
  place: UntrustedCheckout,
  target: string,
  carried: string | undefined,
  { approved, otherTasks, humanContent = false, admit, checkedTip }: EntryChecks,
  use: (read: WorkbenchTip, old: string) => T,
): T | undefined {
  const ref = `refs/heads/${target}`;
  const inputs = [ref, ...(carried ? [carried] : [])].map((full) => ({
    branch: shortRef(full),
    sha: full === ref && approved !== undefined ? approved : git(named.path, "rev-parse", "--verify", full),
  }));
  const old = inputs[0]!.sha;
  const at = place.path;
  try {
    return judgeWorkbench(named, place, target, { carried, boardMove: !humanContent }, (owner, read) => {
      if (owner.kind === "refuse") throw new Error(owner.reason);
      // ADR 0371 決定6: 検査した tree だけを書く —— 検査の間に動いた tip も、取り込むものが無くなった作業台も、検査していない
      if (checkedTip !== undefined && (owner.kind !== "mine" || read?.tip !== checkedTip)) throw new Error(checkedTipMoved(at, target, checkedTip));
      if (owner.kind !== "mine" || !read) return undefined;
      admit?.();
      const { tip, verified } = read;
      const copy = { ...named, path: verified };
      const missing = inputs.find(({ sha }) => !isAncestor(copy, sha, tip, workerRepoGit));
      if (missing) {
        const merge = boardBranch(missing.branch);
        throw new Error(`the workbench at ${at} is not ready: ${target} there does not contain ${missing.branch} (\`${merge}\`). Run \`git merge ${merge}\` there ${fromOwnClone(target, merge)}, then answer again.`);
      }
      if (otherTasks) {
        const branches = otherTaskBranches(db, named, verified, tip, inputs.map(({ sha }) => sha), otherTasks.range);
        if (branches.length > 0) throw new Error(otherTasks.refusalFor(branches, at));
      }
      if (boardViewStatus(at, tip, verified).length > 0) {
        throw new Error(`the workbench at ${at} has uncommitted changes — commit or discard them, then answer again.`);
      }
      // ADR 0371 決定5 / ADR 0362 決定2 / ADR 0365 決定2: 完了の門と同じ検査を、入力の tip のどれとも違う entry にだけ —— 比べる相手は fork 元
      // との merge-base でなく入力の tip。運ばれてきただけの変更は人間の書いたものではない
      const [first, ...rest] = inputs.map(({ sha }) => diffTreeEntries(verified, sha, tip, { workerTree: true }));
      const differing = first!.filter(({ path }) => rest.every((delta) => delta.some((other) => other.path === path)));
      const refuse = (paths: string[], what: string, route = "") => {
        if (paths.length > 0) throw new Error(`the tip of the workbench at ${at} changes ${paths.map(displayWorktreePath).join(", ")}, which ${what}; take that change out and commit, then answer again.${route}`);
      };
      // ADR 0371 決定6: 人間自身の内容の入口は、書き込む tree が隠せない形を持てば(人間が変えたかに依らず)拒む
      const { unhideable } = recordedSettingsDisposition(verified, tip, workerRepoGit);
      refuse(unhideable && (humanContent || differing.some(({ path }) => path === unhideable.path)) ? [unhideable.path] : [], "is a shape the board cannot hide");
      // ADR 0371 決定5: 人間しか書けない path は purely-local の保護ブランチへ人間自身の内容を入れる入口だけが通す
      if (!humanContent) refuse(humanOnlyPathChanges(differing), "is written only by a human", humanOnlyPathRoute(db, named));
      refuse(gitlinkChanges(differing), "is a gitlink");
      return use(read, old);
    });
  } catch (err) {
    // 上限超過の文は worker の tree を名指す —— 人間には作業台の在り処で言う
    if (err instanceof WorkerTreeGitTimeoutError) throw new Error(err.about(`the workbench at ${at}`), { cause: err });
    throw err;
  }
}

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
  carried: string | undefined,
  { entry, answerer, now }: IntakeContext,
  checks: EntryChecks = {},
): { tip: string; commit: string } | undefined {
  const ref = `refs/heads/${target}`;
  return inspectWorkbenchTip(db, named, place, target, carried, checks, ({ tip, verified, tipRef }, old) => {
    fetchFromBoardCopy(named, verified, tipRef, tip, "the workbench tip");
    const commit = git(named.path, "commit-tree", `${tip}^{tree}`, "-p", old, "-p", tip, "-m", `Take in ${target} from the workbench`);
    advanceBranch(db, named, ref, old, commit);
    appendEvent(db, { taskId: null, ...answerer, at: now, payload: { kind: "workbench_taken_in", workspace: named.name, target: ref, tip, commit, entry } });
    return { tip, commit };
  });
}

/** ADR 0382 決定4 の数える task の範囲: local 着地はすべての task(決着済み・cancel 済みを含む)、`take in` と封じ込めの回答は未決着か
 *  着地待ち(hold を含む)の task。 */
type TaskRange = "every task" | "unsettled or landing-waiting";

/** ADR 0382 決定4(#3352 の追記4): 作業台の tip が持つ、`excluded`(書く先の今の値と答えている task の tip)のどれにも無い commit を含む
 *  task のブランチのうち、`range` の task のもの —— 入口は範囲だけを渡す。着地の済んだ task の commit は書く先にあるので、範囲に入っても拒まない。 */
function otherTaskBranches(db: Db, named: WorkspaceConfig, verified: string, tip: string, excluded: string[], range: TaskRange): string[] {
  const branches = refValues(git(named.path, "for-each-ref", "--format=%(objectname) %(refname:strip=2)", "refs/heads/task/"));
  if (range === "unsettled or landing-waiting") {
    for (const branch of [...branches.keys()]) if (!unsettledOrLandingWaiting(db, branch.slice("task/".length))) branches.delete(branch);
  }
  return foreignTaskBranches(verified, named.path, tip, excluded, branches);
}

/** ADR 0382 決定4: 未決着か着地待ち(hold は着地待ち)の task。done の task の内容は帰り先を辿って根の着地でだけ保護ブランチに入るので、
 *  祖先に cancel のあるものは着地を待たない。盤面の知らない名前の `task/*` は task ではない。 */
function unsettledOrLandingWaiting(db: Db, id: string): boolean {
  const task = getTask(db, id);
  if (task === undefined || task.status === "cancelled") return false;
  if (!isSettled(task.status)) return true;
  return db.prepare(`${ancestorsSql("?")} SELECT 1 FROM tasks WHERE id IN (SELECT id FROM ancestors) AND status = 'cancelled'`).get(id) === undefined;
}

/** spec #3273 の受理の 11: merge back の前に、その子を運ぶ鍵の作業台が取り込める tip を持てば先に取り込む(ADR 0382 決定1)。 */
const takeInMergeBack = (db: Db, named: WorkspaceConfig, { taskId, target }: { taskId: string; target: string }, intake: IntakeContext) =>
  takeInExistingWorkbench(db, named, target, `refs/heads/${taskBranch(taskId)}`, intake);

/** ADR 0376 決定8: 昇格の retry は追いつきの前に、(`task/<root>`, origin の保護ブランチ) の作業台が取り込める tip を持てば先に取り込み、
 *  作業台を残したならその text C6 を返す。運ばれる側は origin の保護ブランチ(text A2)。 */
export const takeInCatchUp = (db: Db, workspace: WorkspaceConfig, taskId: string, intake: IntakeContext): string | undefined =>
  takeInExistingWorkbench(db, workspace, taskBranch(taskId), exactProtectedBranchRef(workspace), intake)?.kept;

/** 入口に固有の検査。`approved` は書く先の値として使う ADR 0103 の突き合わせが認めた値(その後に動いた値は CAS が拒む)。`otherTasks` は
 *  ADR 0382 決定4: 数える task の範囲と、その task の commit を持つ tip の拒否文(ブランチと作業台の在り処を受ける)。`humanContent` は
 *  人間自身の内容の入口(`take in`)—— 盤面の手が無く、人間しか書けない path を通し、書き込む tree が隠せない形を持てば拒む。
 *  `admit` は tip がこの入口のものと判ったときだけ掛ける入口の条件(拒むなら投げる)。`checkedTip` は書く前に組の検査を通した tip で、
 *  読んだ tip がこれでなければ拒む(ADR 0371 決定6)。 */
type EntryChecks = {
  approved?: string;
  otherTasks?: { range: TaskRange; refusalFor: (branches: string[], at: string) => string };
  humanContent?: boolean;
  admit?: () => void;
  checkedTip?: string;
};

/** 鍵の作業台があれば取り込み、包む commit と、作業台を残したときの text C6 を返す(取り込むものが無ければ undefined)。拒否は `board/*` を
 *  引き直してから投げる。ADR 0382 決定5: 取り込んだ後、tip が取り込んだままで人間の作業が残っていなければ作業台を消し、残すなら
 *  その branch を包む commit へ進める(`advanceKeptWorkbench`)。 */
function takeInExistingWorkbench(
  db: Db,
  named: WorkspaceConfig,
  target: string,
  carried: string,
  intake: IntakeContext,
  checks?: EntryChecks,
): { commit: string; kept: string | undefined } | undefined {
  const workbench = CHECKOUT_LAYOUT.workbench.at(intake.workbenchBase, named, target, shortRef(carried));
  if (!placeHasRepository(workbench)) return undefined;
  const place = workbenchPlace(named, realpathSync(workbench));
  const taken = repointingOnRefusal(named, workbench, () => takeInWorkbench(db, named, place, target, carried, intake, checks));
  if (taken === undefined) return undefined;
  let done = false;
  try {
    done = judgeWorkbench(named, place, target, { carried, boardMove: true }, (owner, read) => owner.kind === "nothing" && read?.tip === taken.tip);
  } catch {
    // 読めなければ残す —— ref も event も書いた後なので拒まない
  }
  if (!done) return { commit: taken.commit, kept: advanceKeptWorkbench(named, place.path, target, taken) };
  removeBoardCheckout(place.path, CHECKOUT_LAYOUT.workbench.parents);
  return { commit: taken.commit, kept: undefined };
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
const openWorkbenchExit = (branch: string) => `open it with \`open_workbench\`, commit the fix there on ${branch}, then answer.`;

/** 人間自身の内容の作業台が書く先の branch とともに disk にある。 */
const holdsTargetBranch = (at: string, branch: string) =>
  placeHasRepository(at) && gitAnswers(() => workerRepoGit(at, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`));

/** ADR 0373 決定9: 組の停止が開く作業台 —— 開くのは鍵ごとに冪等で、書く先の branch のある作業台は作り直さない(無視された file も人間のもの)。
 *  作りかけは開く手の規則で作り直す。返すのは修理の道の文(text B8、ADR 0382 決定4 の句)。開けなければそう言う(fail-closed)—— 盤面 DB の
 *  拒否だけは底へ(ADR 0342 決定4)。 */
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
    if (isBoardDbRefusal(err)) throw err;
    return ` The board could not open the workbench (${err instanceof Error ? err.message : String(err)}); ${openWorkbenchExit(branch)}`;
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
 *  workspace に `intake` question を1つ立てる。question が開いていて作業台が書く先の branch とともに disk にあれば何も変えず(pin A13)、
 *  同じ question を名指す。そうでなければ開く手の規則で開く —— question が開いていて作業台が disk に無いか作りかけなら作り直す。
 *  remote-backed の workspace は拒む(text A9)。基準の行が無ければ、開く前に最初の撮りをする(ADR 0383 決定2、`captureFirstBaseline`)。
 *  question の登録者は呼び手。返すのは text A14。`board` は pickup の最初の撮りと同じ確認が引く registry の口と盤面の固定点。 */
export async function openHumanContentWorkbench(
  db: Db,
  workspace: WorkspaceConfig,
  base: string,
  caller: Answerer,
  now: Date,
  board: { resolveRegistered: WorkspaceResolver | undefined; fixedPoints?: BoardStatePath[] },
): Promise<string> {
  const branch = protectedBranch(workspace);
  if (isRemoteBacked(withRememberedRepoCheck(db, workspace, () => now))) {
    throw new DomainError(`workspace ${workspace.name} is remote-backed, so ${branch} is changed on origin.${originRoute(workspace)}`);
  }
  if (!holdsBaseline(db, workspace.name)) await captureFirstBaseline(db, workspace, { ...board, now });
  const at = CHECKOUT_LAYOUT.workbench.at(base, workspace, branch);
  let question = openIntakeQuestionId(db, workspace.name);
  const leaveAlone = question !== undefined && holdsTargetBranch(at, branch);
  let opened: { path: string; owner: WorkbenchOwner };
  try {
    opened = leaveAlone ? { path: realpathSync(at), owner: judgeOnDisk(workspace, at, branch) } : openWorkbench(workspace, base, branch);
  } catch (err) {
    if (err instanceof WorkbenchUnreadableError) throw new DomainError(`the board cannot read the workbench at ${err.at} (${err.message}); remove it by hand, then open it again.`);
    if (isBoardDbRefusal(err)) throw err;
    throw new DomainError(`the board could not open the workbench (${err instanceof Error ? err.message : String(err)}); open it again.`);
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
      now,
      caller.actorId,
      caller.origin,
    ).id;
  }
  // spec #3273 text A14
  return `opened the workbench at ${path} for ${branch} of workspace ${workspace.name}; answer question ${question} when your commits are there.${held}`;
}

/** ADR 0383 決定1・2: 基準の行の無い名前の `open_workbench` は、pickup の最初の撮りと同じ準備を通ってから撮る —— 基準の行を持つ名前の
 *  Quarantine が開いている間の待ち(ADR 0373 決定13 追記。この名前自身の Quarantine の間も pickup と同じく進まない)、pickup が開く前に
 *  掛ける項、決定13 の確認と全撮り(`prepareRefBaseline`)。判定は pickup と同じ関数が持つ。落ちれば止めた Quarantine を名指して拒み
 *  (text C1a の形)、作業台も question も開かない。registry が読めない落ち方は Quarantine を立てず、その理由を言う。 */
async function captureFirstBaseline(
  db: Db,
  workspace: WorkspaceConfig,
  board: { resolveRegistered: WorkspaceResolver | undefined; fixedPoints?: BoardStatePath[]; now: Date },
): Promise<void> {
  const quarantined = (name: string, question: string) => new DomainError(`cannot open a workbench: workspace ${name} is quarantined — answer question ${question} first.`);
  const stopped = (stop: ResourceStop) => quarantined(stop.value!, openQuarantineQuestion(db, "workspace", stop.value)!.id);
  const own = openQuarantineQuestion(db, "workspace", workspace.name);
  if (own) throw quarantined(workspace.name, own.id);
  const held = [
    ...[...openQuarantineQuestions(db, "workspace")].map(([value, id]) => [value!, id] as const),
    ...[...openQuarantineQuestions(db, "workspaceContainment")].map(([value, id]) => [parseWorkspaceContainmentValue(value!).workspace, id] as const),
  ].find(([name]) => holdsFirstCaptures(db, name));
  if (held) throw quarantined(...held);
  const named = withRememberedRepoCheck(db, workspace, () => board.now);
  try {
    await firePickupPredicates(db, named, checkoutPickupPredicates(named, board.fixedPoints), "before-open");
  } catch (err) {
    if (!(err instanceof PickupGateError)) throw err;
    throw stopped(quarantineWorkspace(db, err.place.name, err, board.now));
  }
  try {
    prepareRefBaseline(db, named, board);
  } catch (err) {
    if (isBoardDbRefusal(err)) throw err;
    if (err instanceof FirstCaptureRefusedError) throw stopped(err.stop);
    if (err instanceof FirstCaptureRegistryReadError) throw new DomainError(`cannot open a workbench: the board could not read the registry (${err.message}).`);
    throw stopped(quarantineWorkspace(db, workspace.name, err, board.now));
  }
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
  if (isRemoteBacked(withRememberedRepoCheck(db, workspace, () => intake.now))) {
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
    nothingNew: (path) => `nothing to take in: ${branch} in the workbench at ${path} is the value the board already has.`,
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
  if (!placeHasRepository(at)) return undefined;
  const place = workbenchPlace(workspace, realpathSync(at));
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
  return placeHasRepository(at) ? commitFixInWorkbench(realpathSync(at), branch) : ` No workbench is open: ${openWorkbenchExit(branch)}`;
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
  if (!holdsBaseline(db, workspace.name)) return;
  try {
    compareAndFoldBaseline(db, workspace, "while the containment Quarantine was open");
  } catch (err) {
    if (!(err instanceof RefsMovedError)) throw err;
    quarantineWorkspace(db, workspace.name, err, now);
    throw new Error(`${err.message}. Answer the workspace Quarantine (question ${openQuarantineQuestion(db, "workspace", workspace.name)!.id}) first.`);
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
    if (isBoardDbRefusal(err)) throw err;
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
    owner = judgeWorkbench(named, workbenchPlace(named, workbench), branch, { boardMove: true }, (judged) => judged);
  } catch (err) {
    return unreadable(workbench, err);
  }
  return owner.kind === "nothing" ? undefined : { workbench, branch };
}

/** ADR 0382 決定5: 削除が成立した workspace の、人間自身の内容の作業台を消す(取り込まれていない作業が無いことは `humanContentWorkbenchLeft` が確かめた)。 */
export function removeHumanContentWorkbench(named: WorkspaceConfig, base: string): void {
  const at = CHECKOUT_LAYOUT.workbench.at(base, named, protectedBranch(named));
  if (existsSync(at)) removeBoardCheckout(at, CHECKOUT_LAYOUT.workbench.parents);
}

/** text A8c の出口(ADR 0371 決定6 / ADR 0382 決定4: task の内容は着地でだけ保護ブランチに入る): そのブランチの内容が着地する根 —— 祖先の
 *  一番上 —— の開いた着地 question があれば `merge` を、無ければまだ着地していないことを言う。 */
function landingExit(db: Db, branch: string): string {
  const id = branch.slice("task/".length);
  const root = (db.prepare(`${ancestorsSql("?")} SELECT id FROM tasks WHERE id IN (SELECT id FROM ancestors) AND parent_id IS NULL`).get(id) as { id: string } | undefined)?.id ?? id;
  const row = db
    .prepare("SELECT id FROM tasks WHERE type = 'question' AND status = 'todo' AND question_pending_local_merge_task_id = ? ORDER BY rowid LIMIT 1")
    .get(root) as { id: string } | undefined;
  return row ? `answer \`merge\` on question ${row.id}` : "it has not landed yet";
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
      registryOrigin ??= { value: readCheckoutOrigin(registryDir) };
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
    review_allowed_commands: entry.review_allowed_commands,
    allowed_domains: entry.allowed_domains,
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
  return withVerifiedUntrustedTip(untrustedTaskCheckout(place), taskBranch(taskId), (tip, verified) => {
    const parent = git(room.path, "rev-parse", protectedBranchRef(room));
    if (!place.borrowsNamedObjects) {
      // ADR 0364 決定1: 兄弟の答案を tip の検証に借りない。検証後は写しの親を読むために面接室の objects を借りる。
      const objects = namedObjects(room);
      stagingHostStep(() => writeFileSync(join(verified, "objects", "info", "alternates"), `${objects}\n`));
    }
    const exclude = boardViewExcludes(db, place, taskId, tip, verified);
    return boardWriteTree(place.path, tip, verified, (tree, repo) => {
      // ADR 0365 決定2: 受験者が populate できない gitlink を足す・進める tree は、面接室へ運ぶ前に拒む。
      const gitlinks = gitlinkChanges(diffTreeEntries(repo, `${parent}^{tree}`, tree, { workerTree: true }));
      if (gitlinks.length > 0) throw new RoomCopyGitlinkError(gitlinks);
      // ADR 0273 決定1: 受験者の git の履歴に載るので、盤面の語を持たない件名。
      const head = fetchStagedTree(room, repo, tree, parent, "Add the project files", "the probe's environment");
      const ref = `refs/keep-around/${head}`;
      boardRefWriter(db, room)(ref, head, () => git(room.path, "update-ref", ref, head));
      return head;
    }, exclude);
  });
}

/** ADR 0053 / ADR 0105: the live integration branch plus the lineage fact a
 *  root needs when a squash/rebase-landed fork source left history divergent. */
export function resolveTaskBranchLineage(
  db: Db,
  workspace: WorkspaceConfig,
  task: Pick<Task, "type" | "parent_id">,
  protectedRef?: string,
): { branch: string | undefined; outlivedForkSource: boolean } {
  // 修理子の type は review と同じく lineage に透明(ADR 0272 決定6 / ADR 0279 決定4)
  // interview の root もブランチを持たない —— 書けるのは面接室だけ(ADR 0273 決定2)
  if (carriesReadOnly(task.type) || task.type === "interview") {
    return {
      branch:
        task.parent_id && taskBranchExists(workspace, task.parent_id)
          ? taskBranch(task.parent_id)
          : undefined,
      outlivedForkSource: false,
    };
  }

  const ancestors: Task[] = [];
  for (let parent = task.parent_id ? getTask(db, task.parent_id) : undefined; parent; ) {
    ancestors.unshift(parent);
    parent = parent.parent_id ? getTask(db, parent.parent_id) : undefined;
  }

  let candidate: string | undefined;
  let outlivedForkSource = false;
  for (const ancestor of ancestors) {
    if (ancestor.type !== "work") continue;
    const branch = taskBranch(ancestor.id);
    if (!isSettled(ancestor.status)) {
      candidate = branch;
      continue;
    }
    const base = candidate ?? (protectedRef ??= protectedBranchRef(withRememberedRepoCheck(db, workspace)));
    const effect = branchMergeEffect(workspace, base, branch);
    if (effect.changesCandidate) candidate = branch;
    else if (!effect.historyConverged) outlivedForkSource = true;
  }
  return { branch: candidate, outlivedForkSource };
}

/** ADR 0053: the nearest work branch in the task's live lineage, or undefined
 *  when the protected branch is the bottom of that lineage. */
export function lineageTaskBranch(
  db: Db,
  workspace: WorkspaceConfig,
  task: Pick<Task, "type" | "parent_id">,
  protectedRef?: string,
): string | undefined {
  return resolveTaskBranchLineage(db, workspace, task, protectedRef).branch;
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

/** タスクブランチを切る sha(ADR 0053)。受験者は系譜を持たず、面接室の出題の head から切る(ADR 0276 決定1)。
 *  ADR 0362 決定2: 作成と完了の門が同じ出所を読む。 */
export function taskForkSource(db: Db, workspace: WorkspaceConfig, task: Task): string {
  if (interviewRole(db, task) === "examinee") return resolvablePosedHead(db, workspace, task);
  const base = exactProtectedBranchRef(withRememberedRepoCheck(db, workspace));
  const source = lineageTaskBranch(db, workspace, task, base) ?? base;
  return git(workspace.path, "rev-parse", `${source}^{commit}`);
}

/** ADR 0351 決定3 / ADR 0356 決定5: 作成も口を通す plumbing —— 無い行に fork 元の sha を予告する。名前の場所では checkout しない。 */
function createTaskBranch(db: Db, workspace: WorkspaceConfig, task: Task): void {
  if (taskBranchExists(workspace, task.id)) return;
  const ref = `refs/heads/${taskBranch(task.id)}`;
  const sha = taskForkSource(db, workspace, task);
  boardRefWriter(db, workspace)(ref, sha, () => git(workspace.path, "update-ref", ref, sha, ""));
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

/** 盤面の view が運ばない path(ADR 0360 Status 追記、#3111): view の index の種 `tip` から導く hidden settings と、ADR 0069 の shadow 残骸。
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
export async function refreshProtectedBranch(db: Db, workspace: WorkspaceConfig, auth: GitHubAuth | undefined): Promise<void> {
  workspace = withRememberedRepoCheck(db, workspace);
  if (!isRemoteBacked(workspace)) return;
  await ensureWorkspaceToken(workspace, auth);
  fetchBranchCopy(workspace, auth, protectedBranch(workspace), boardRefWriter(db, workspace));
}

/** ADR 0242 決定1: merge の門が比べる GitHub の head が手元に無ければ、origin から sha で取る。sha の fetch は `refs/` に
 *  何も書かない(FETCH_HEAD だけ)ので口は要らない。失敗は投げる。 */
export async function fetchCommitIfMissing(db: Db, workspace: WorkspaceConfig, sha: string, auth: GitHubAuth | undefined): Promise<void> {
  try {
    git(workspace.path, "cat-file", "-e", `${sha}^{commit}`);
    return;
  } catch {}
  workspace = withRememberedRepoCheck(db, workspace);
  await ensureWorkspaceToken(workspace, auth);
  fetchCommit(workspace, auth, sha);
}

/** pickup の準備に要る盤面の deps。`live` は pickup の継続の門(#1973、`liveSession`): token の await の後に閉じていれば
 *  git に進まずに戻る —— 呼び手は戻った後に同じ門を読む。 */
type PickupPrep = { githubAuth?: GitHubAuth; live?: () => boolean };

/** pickup の準備: 開く場所すべての ref の基準と鮮度を確かめ、走る場所だけにタスクブランチを立てる
 *  (実環境に root のブランチを立てない、ADR 0273 決定2)。
 *  ADR 0351 決定2: 基準は切れない —— 行が無いか NULL なら最初の撮り、あれば盤面が書く前に除外無しで比べる。以後の書き込みは口が畳む。
 *  比較は読む場所の後半(`reads`、ADR 0329 決定10・11)より前 —— 走る場所の違反は読む場所を書く前に止まる。 */
export async function prepareWorkspaceAtPickup(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
  board: PickupPrep & {
    reads?: ReadonlyArray<{ place: WorkspaceConfig; predicates: PickupPredicate[] }>;
    /** task の checkout の番地の基点と、開いた event の時刻(ADR 0356 決定2)。 */
    workspacesBaseDir: string;
    now: Date;
    /** registry の名前を引く口(ADR 0373 決定13 の最初の撮りの確認が引く)。省けない —— 撮る呼び手が渡し忘れれば確認が黙って消える。
     *  undefined は registry の無い盤面で、確認は掛からない。 */
    resolveRegistered: WorkspaceResolver | undefined;
  },
): Promise<void> {
  prepareRefBaseline(db, workspace, board);
  const rootId = interviewRootIdOf(db, task);
  // ADR 0351 決定5: 走る名前の場所だけ、後半が書く前に休止中の変更を読む。shadow の例外は無い。
  // ADR 0356 決定3: 名前の場所(面接室を含む)は自分の git で読む —— 盤面の view は worker が走った checkout のもので、人間の登録前の
  // `info/exclude` を永久の quarantine にしない
  const changes = ownWorktreeStatus(workspace.path);
  if (changes.length > 0) {
    throw new PickupGateError(workspace, new Error(
      `workspace ${workspace.name} has uncommitted changes while resting: ${describeChanges(changes, "\n")} — a process wrote them after the board moved the checkout`,
    ));
  }
  for (const read of board.reads ?? []) {
    if (safeRealpath(read.place.path) === safeRealpath(workspace.path)) continue;
    // ADR 0351 決定6: 読む場所も後半が書く前に比べ、違反は読む場所の名前で止める。
    try {
      prepareRefBaseline(db, read.place, board);
    } catch (err) {
      if (isBoardDbRefusal(err) || err instanceof FirstCaptureRefusedError || err instanceof FirstCaptureRegistryReadError) throw err;
      throw new PickupGateError(read.place, err);
    }
    await firePickupPredicates(db, read.place, read.predicates, "after-open", board);
    if (board.live?.() === false) return;
  }
  const predicates = rootId === undefined ? checkoutPickupPredicates(workspace) : roomPickupPredicates(db, rootId, "");
  await firePickupPredicates(db, workspace, predicates, "after-open", board);
  if (board.live?.() === false) return;
  // ADR 0356 決定1・2: タスクブランチは名前の場所(面接室を含む)の ref として作るだけで、worker は fetch した task の checkout で走る
  createTaskBranch(db, workspace, task);
  openTaskCheckout(db, workspace, task, board.workspacesBaseDir, board.now);
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

function prepareRefBaseline(db: Db, workspace: WorkspaceConfig, board: { resolveRegistered: WorkspaceResolver | undefined; now: Date }): void {
  const key = workspace.name;
  const first = !holdsBaseline(db, key);
  const declaration = withRememberedRepoCheck(db, workspace, () => board.now).checkRememberedRepo(workspace);
  if (!first) compareAndFoldBaseline(db, workspace, "while the checkout rested since the last session");
  else if (board.resolveRegistered && !isInterviewRoomName(db, key)) confirmBaselinesBeforeFirstCapture(db, board.resolveRegistered, board.now);
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
      if (isBoardDbRefusal(err)) throw err;
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

/** ADR 0378 決定10: publish changes a held baseline's repo alongside its registry entry, and can roll back the exact prior value. */
export function rememberPublishedRepo(db: Db, workspace: WorkspaceConfig): () => void {
  const { name } = workspace;
  const before = readRememberedRepo(db, name);
  if (before === undefined) return () => {};
  writeRememberedRepo(db, name, encodeWorkspaceRepo(workspace));
  return () => writeRememberedRepo(db, name, before);
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
  const remembered = (JSON.parse(saved) as string | null) ?? undefined;
  const destination = (value: string | undefined) => value === undefined ? undefined : networkDestination(value, path).url;
  if (sameRepository(destination(remembered), destination(repo))) return;
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

export function withRememberedRepoCheck<T extends WorkspaceConfig>(
  db: Db,
  workspace: T,
  now = () => new Date(),
  resolveCurrent?: (name: string) => WorkspaceConfig,
): T & Required<Pick<WorkspaceConfig, "checkRememberedRepo">> {
  return {
    ...workspace,
    checkRememberedRepo: workspace.checkRememberedRepo ?? ((place: WorkspaceConfig) => {
      // ADR 0066 決定5 / ADR 0378 決定7: a token lookup can span publish's synchronous update, so check the current declaration.
      const current = resolveCurrent?.(place.name) ?? place;
      assertRememberedRepo(db, current, now());
      if (current.path !== place.path) {
        throw new OriginRepositoryMismatchError(`workspace ${place.name}: the registered checkout path changed during the operation. Retry with the current entry.`);
      }
      // ADR 0378 決定3: an earlier pickup predicate only checked the declaration it was given.
      if (current.repo !== place.repo) assertRemoteDeclarationMatchesClone(current);
      return current;
    }),
  };
}

/** ADR 0351 決定4: quarantine の受理は検査がすべて成立した後に、名前に掛かる場所それぞれの基準を自分の checkout から撮り直す ——
 *  基準は名前の場所だけが持つ(ADR 0356 決定4)。撮り直すのは盤面が既に基準を持つ場所だけ —— まだ持ったことのない場所
 *  (開いていない面接室の在り処に repo がある)は最初の開きの build が口を通らずに書くので、その後の最初の
 *  pickup が最初の撮りをする(決定2)。repo の無い場所も撮らない。全部読んでから書くので、読みが落ちれば行は変わらない。 */
export function retakeRefBaselines(db: Db, places: WorkspaceConfig[]): void {
  const held = places.filter((place) => placeHasRepository(place.path) && holdsBaseline(db, place.name));
  const rows = new Map(held.map((place) => [place.name, currentRefs(place)]));
  db.transaction(() => {
    for (const [key, refs] of rows) writeSnapshot(db, key, refs);
  })();
}

/** ADR 0351 決定7: 行の寿命は workspace の寿命 —— 削除の扉が基準と sparse の pin の行ごと消す。残すと同名を別 path で登録し直したとき
 *  旧 checkout の基準と比べる。面接室の行を消すのは `run with an empty room` だけ(ADR 0373 決定11)。 */
export function dropWorkspaceState(db: Db, name: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM workspace_state WHERE name = ?").run(name);
    db.prepare("DELETE FROM workspace_sparse_policies WHERE name = ?").run(name);
  })();
}

/** 盤面がその名前の基準の行を持つか(ADR 0373 決定13・14)。 */
export function holdsBaseline(db: Db, name: string): boolean {
  return storedRefs(db, name) !== "";
}

function storedRefs(db: Db, workspaceName: string): string {
  const row = db
    .prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?")
    .get(workspaceName) as { ref_snapshot: string | null } | undefined;
  // 行無しと NULL は空文字: 解放と着地は分岐を書かずに違反へ落ち(ADR 0064 決定6 —— pickup を経ない解放経路が足されても
  // 検査は黙って消えない)、pickup と受理だけがこれを「まだ持ったことがない」と読む(ADR 0351 決定2)
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
 *  fetch の失敗ではなく、案内は repo アクセスの失敗の瞬間だけのもの、ADR 0067 決定2)、完了の門は worker を拒むだけで(ADR 0359 決定4 /
 *  ADR 0373 決定12)、受理のやり直しは回答の拒否として投げる。 */
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

/** 基準を書き換える。基準を持たない checkout(盤面がまだ持ったことがない)には何もしない —— 行を作らず、最初の pickup が
 *  全体を撮る(ADR 0351 決定2)。保存値の綴りは常に「`currentRefs` の出力」= **refname 順**である(ADR 0064 決定6)。 */
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
 *  (仲介への往復)は呼び手が予告の前に済ませる。 */
export function writeBoardRefs(
  db: Db,
  workspace: WorkspaceConfig,
  writes: ReadonlyArray<readonly [ref: string, newValue: string]>,
  write: () => void,
): void {
  const before = new Map<string, string>();
  const announced = updateBaseline(db, workspace, (values) => {
    for (const [ref, newValue] of writes) {
      const previous = values.get(ref) ?? "";
      before.set(ref, previous);
      const candidates = baselineValues(previous);
      // ADR 0243 決定5: a retry keeps the existing announcement if it already covers this write.
      if (candidates.length === 1 || !candidates.includes(newValue)) values.set(ref, `${previous}|${newValue}`);
    }
  });
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
      if (isBoardDbRefusal(foldErr)) throw foldErr; // ADR 0342 決定4: 盤面 DB の拒否は書き込みの失敗の陰に隠さない
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

/** 戻す先の object が無い ref(ADR 0373 決定5)。 */
function lostTargets(workspace: WorkspaceConfig, targets: ReadonlyMap<string, string>): [ref: string, sha: string][] {
  return [...targets].filter(([, value]) => isSha(value) && !objectExists(workspace, value));
}

/** spec #3273 の受理の 7a(ADR 0380 決定4): remote-backed の workspace で、object の無い戻す先の sha を origin から取る —— ref は書かない。
 *  失われたかは取った後の 7b(`restoreBaseline`)が object の有無だけで決める。origin に届かなければ拒む: 先に有界の `ls-remote` で probe し、
 *  取れなかった sha ごとにもう1度 probe する —— 2度の probe が通った間に落ちた fetch だけが「origin に無い」。git のメッセージは読まない(ADR 0376 決定1)。 */
export async function fetchLostTargets(db: Db, place: WorkspaceConfig, auth: GitHubAuth | undefined): Promise<void> {
  if (!isRemoteBacked(place)) return;
  const missing = [...new Set(lostTargets(place, restoreTargets(db, place).targets).map(([, sha]) => sha))];
  if (missing.length === 0) return;
  // 盤面 DB の拒否(ADR 0342 決定4)と記憶した repo の食い違い(ADR 0378 決定6〜8: 食い違いは workspace の停止)は届かなさに包まない
  const passThrough = (err: unknown) => isBoardDbRefusal(err) || err instanceof WorkspaceRepoMismatchError || err instanceof OriginRepositoryMismatchError;
  const unreachable = (shas: string[], err: unknown) => {
    if (passThrough(err)) return err;
    return new Error(`could not reach origin to look for ${shas.join(", ")} (${err instanceof Error ? err.message : String(err)}). Nothing was written; answer again once origin is reachable.`);
  };
  // ADR 0380 決定4: 認証の失敗も通信の失敗と同じく「origin に届かない」
  await ensureWorkspaceToken(place, auth, { fresh: true }).catch((err: unknown) => {
    throw unreachable(missing, err);
  });
  const probe = (shas: string[]) => {
    try {
      authedLsRemote(auth, place, GIT_NETWORK_TIMEOUT_MS, "HEAD");
    } catch (err) {
      throw unreachable(shas, err);
    }
  };
  probe(missing);
  for (const sha of missing) {
    // 先に届いた根の head が運んできた子の tip は取り直さない
    if (objectExists(place, sha)) continue;
    try {
      fetchCommit(place, auth, sha);
    } catch (err) {
      if (passThrough(err)) throw err;
      probe([sha]);
    }
  }
}

/** ADR 0373 決定3・4: 基準と違う ref を全部基準の値へ書き戻し(基準に無い ref は消す)、外す値を `refs/keep-around/<sha>` に持ち続ける。
 *  受理の 7b(spec #3273)の1つの同期区間で、比べ直すところから書くまでに await を挟まない。予告中の行は ref がどの値とも違うときだけ予告の前の値へ戻す。
 *  戻す先の object が1つでも無ければ何も書かずに拒む。持ち続けるのは ref が持っていた sha だけ —— symref の行(HEAD を含む)は名前なので
 *  戻すだけ、object の無い値は持てない、`refs/stash` は reflog の各件。clean だった tree は書いた後の HEAD に揃え、dirty なら拒む。
 *  `baseline_restored` は書けた分を残す —— 途中で落ちても書き戻しと一緒に残る。外した値を返し、違いが無ければ何も書かずに空を返す。
 *  `giveUp`(ADR 0373 決定5): object の無い ref は拒まずに今の値で基準に入れ(ref が無ければ行を消す)、`lost_refs_accepted` を書き戻しより先に
 *  残す。失われた ref が無ければ、今の checkout に保護ブランチが無ければ、何も書かずに拒む。 */
export function restoreBaseline(db: Db, workspace: WorkspaceConfig, now: Date, giveUp = false): KeptValue[] {
  const { current, targets } = restoreTargets(db, workspace);
  const lost = lostTargets(workspace, targets);
  if (giveUp) {
    if (lost.length === 0) throw new Error(`no ref of workspace ${workspace.name} is lost — answer \`${RESTORE_THE_BASELINE}\`.`);
    for (const [ref] of lost) targets.delete(ref);
    // ADR 0373 決定5: 書き戻しの前に保護ブランチの ref が在ることを明示で確かめる —— purely-local では後半の休止がそれを読まず、空の `git init` が通ってしまう(#3242)
    const branch = protectedBranch(workspace);
    if (!current.has(`refs/heads/${branch}`)) {
      throw new Error(
        `${workspace.path} has no '${branch}' branch. Nothing was written. Put a commit on ${branch} there (re-clone the repository, or commit on ${branch}), then answer again.`,
      );
    }
  } else if (lost.length > 0) {
    throw new Error(
      `${lost.map(([ref, sha]) => `cannot restore ${ref} to ${sha}: that commit no longer exists in ${workspace.path}`).join("\n")} Nothing was written. ` +
        `If these are lost for good, answer \`${GIVE_UP_THE_LOST_REFS}\`.`,
    );
  }
  if (targets.size > 0) verifyWorkspaceClean(workspace);
  if (giveUp) {
    db.transaction(() => {
      updateBaseline(db, workspace, (values) => lost.forEach(([ref]) => values.set(ref, current.get(ref) ?? "")));
      appendEvent(db, {
        taskId: null,
        actorId: BOARD_ACTOR_ID,
        origin: "board",
        payload: { kind: "lost_refs_accepted", workspace: workspace.name, lost: lost.map(([ref, sha]) => ({ ref, sha })) },
        at: now,
      });
    })();
  }
  if (targets.size === 0) return [];
  const kept: KeptValue[] = [...targets.keys()].flatMap((ref) => {
    const value = current.get(ref) ?? "";
    if (!isSha(value)) return [];
    // reflog の無い refs/stash(update-ref で作った)でも今の値は持つ
    const shas = new Set([value, ...(ref === "refs/stash" ? git(workspace.path, "log", "-g", "--format=%H", ref).split("\n").filter(Boolean) : [])]);
    return [...shas].filter((sha) => objectExists(workspace, sha)).map((sha) => ({ ref, sha }));
  });
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
  const valueAfter = (ref: string) => writes.get(ref) ?? current.get(ref) ?? "";
  const headAfter = valueAfter("HEAD");
  const headAfterTarget = symrefTarget(headAfter);
  const tipAfter = headAfterTarget === undefined ? headAfter : valueAfter(headAfterTarget);
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
      if (tipBefore !== "" && isSha(tipAfter)) writeWithWorktree(db, workspace, tipBefore, tipAfter, write);
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

function objectExists(workspace: WorkspaceConfig, sha: string): boolean {
  try {
    git(workspace.path, "cat-file", "-e", sha);
    return true;
  } catch {
    return false;
  }
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

/** task の checkout の worktree を、名前の場所のタスクブランチの tip に対して盤面の view だけで読む(ADR 0356 決定3)。運ばない path は除く。 */
function taskCheckoutChanges(db: Db, place: TaskCheckoutPlace, taskId: string, tip: string): WorktreeChange[] {
  return boardViewStatus(place.path, tip, place.namedPlace.path, boardViewExcludes(db, place, taskId, tip));
}

/** ADR 0359 決定1: task の checkout の観測が落ちれば門を通さない。work は全部 task の checkout で走る(ADR 0356 決定1)。 */
export function completionTreePaths(db: Db, workspace: WorkspaceConfig, taskId: string, recordedTip?: string): string[] {
  assertTaskCheckout(workspace, taskId);
  const tip = recordedTip ?? git(workspace.namedPlace.path, "rev-parse", "--verify", `refs/heads/${taskBranch(taskId)}`);
  return taskCheckoutChanges(db, workspace, taskId, tip).map(({ path }) => path);
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
    const paths = taskCheckoutChanges(db, place, taskId, recorded).map(({ path }) => path);
    if (paths.length > 0) return { observation: "uncommitted", paths };
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
    // 盤面は名前の場所の HEAD を動かさない(ADR 0356 決定1)が、人間の修理(ADR 0239 帰結の `merge -s ours`、ADR 0351 決定1・4)や origin にしか無い
    // 保護ブランチは HEAD を保護ブランチの外に置く
    if (headValue(workspace) !== symrefValue(`refs/heads/${branch}`)) checkoutThroughGate(db, workspace, branch);
  } catch (cause) {
    if (isBoardDbRefusal(cause)) throw cause; // ADR 0342 決定4: 包むと判定が届かない
    throw new Error(`workspace ${workspace.name}: protected branch '${branch}' cannot be checked out: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
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
    if (isBoardDbRefusal(cause)) throw cause; // ADR 0342 決定4: 包むと判定が届かない
    throw new Error(`workspace ${workspace.name}: protected branch '${branch}' cannot fast-forward to ${ref}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  throw new Error(
    `workspace ${workspace.name}: local '${branch}' is ahead of ${ref} — out-of-band local ` +
      "commits were never pushed, so parking here would show a state the remote does not have",
  );
}

/** Quarantine resolution's verification gate (issue #21, GLOSSARY.md): the
 *  board never takes a repair confirmation on faith. Any failure to observe
 *  a clean tree — dirty, or not even a usable git repository — is treated
 *  the same, fail-closed, same posture as the pickup's resting check on the
 *  named place (ADR 0351 決定5). */
export function verifyWorkspaceClean(workspace: WorkspaceConfig): void {
  assertOwnGitDirectory(workspace.path);
  let status: WorktreeChange[];
  try {
    // ADR 0356 決定3: 名前の場所(面接室を含む)は自分の git で読む
    status = ownWorktreeStatus(workspace.path);
  } catch (err) {
    if (isBoardDbRefusal(err)) throw err;
    throw new Error(
      `workspace ${workspace.name} is not a usable git repository: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (status.length > 0) {
    throw new Error(`workspace ${workspace.name} still has uncommitted changes`);
  }
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
  // spec #3273 text B9: 基準の行を持つ名前が引けない間は、どの workspace も最初の撮りをしない(ADR 0373 決定13)
  const baselineHeldSentence = cause instanceof UnknownWorkspaceError && holdsBaseline(db, workspaceName)
    ? `. The board holds a baseline for "${workspaceName}", so no workspace captures a first baseline until it resolves again: put the entry back in the registry under that name. To remove the workspace, delete it through the deletion door after this question is closed; to rename it, delete it and register it under the new name`
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
 *  2 つの poll で(ADR 0366 決定4)、verb は拒むだけ。 */
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
 *  2 つの poll(ADR 0363 決定2 / ADR 0366 決定4)。worker の verb は拒むだけ。 */
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
function settleBranches(db: Db, workspace: WorkspaceConfig, task: Task, mergeBack: boolean, githubAuth: GitHubAuth | undefined, tokenFailure: unknown, workbenchBase: string, recordedTip?: string): void {
  workspace = withRememberedRepoCheck(db, workspace);
  // merge-back の帰り先はこの fetch の結果で決まる。token は呼び出し元が
  // `ensureWorkspaceToken` で温めてある(ADR 0093)。温められなかったときは、その
  // 失敗を fetch が落ちたのと同じ位置で投げる —— WIP は既に退避済みで、行き先は
  // 同じ quarantine(ADR 0052)。呼び出し元で投げると slot が解放されない。
  if (mergeBack) {
    if (tokenFailure !== undefined) throw tokenFailure;
    // ADR 0351 決定3: 基準は切れないので、後始末の fetch も口を通す
    if (isRemoteBacked(workspace)) fetchBranchCopy(workspace, githubAuth, protectedBranch(workspace), boardRefWriter(db, workspace));
  }
  const target = mergeBack && lineageTaskBranch(db, workspace, task);
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
      if (isBoardDbRefusal(err)) throw err; // ADR 0342 決定4: quarantine も同じ器に書くので、書かずに底へ
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
    settleBranches(db, namedPlace, task, mergeBack, githubAuth, tokenFailure, CHECKOUT_LAYOUT.task.base(checkout), verifiedTip);
  } catch (err) {
    if (isBoardDbRefusal(err)) throw err; // ADR 0342 決定4: quarantine も同じ器に書くので、書かずに底へ
    quarantineWorkspace(db, namedPlace.name, err, now);
  }
  removeReleasedTaskCheckout(db, task.id);
}

/** ADR 0369 決定7: drift で名前を解けなくても、運び終えた session の checkout は消せる。 */
export function removeReleasedTaskCheckout(db: Db, taskId: string): void {
  const checkout = taskCheckoutPath(db, taskId);
  if (checkout !== undefined && taskCheckoutWasReleased(db, taskId, checkout)) {
    removeBoardCheckout(checkout, CHECKOUT_LAYOUT.task.parents);
  }
}

/** この session の読み専用の checkout を消す(冪等)。issue #3105 の spec: 記録の価値の無い派生物なので、決着が落ちて task の checkout を
 *  唯一の写しとして残す解放(ADR 0356 決定2)でも、解放を飛ばす後始末(ADR 0363 決定4)でも消す。 */
export function releaseReadCheckouts(db: Db, taskId: string): void {
  for (const read of sessionReadCheckouts(db, taskId)) removeBoardCheckout(read.path, CHECKOUT_LAYOUT.read.parents);
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

/** ADR 0369 決定7: 着け先が `name` の、解放済みでまだ残る最後の session の checkout を消す —— 消せずに投げても、次の回答が消し直す。 */
export function removeReleasedTaskCheckoutsOn(db: Db, name: string, defaultWorkspaceName: string | undefined): void {
  for (const task of tasksReleasedOn(db, name, defaultWorkspaceName)) removeReleasedTaskCheckout(db, task.id);
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
        throw new Error(
          `The task completed under an earlier board version and its recorded tip could not be verified against the task checkout at ${checkout}. ` +
          "Inspect the retained checkout and restore the intended completion tip before answering.",
        );
      }
    } else {
      // ADR 0373 決定12: 書く前に基準の行と突き合わせる(門と同じ手)
      evacuationBaseRef = taskRefAsRecorded(db, namedPlace, taskRef, when);
      // 比べてから worker の repo を読む —— 動いた ref を worker の repo の故障の陰に隠さない
      const tip = fetchUntrustedTip(untrustedTaskCheckout(place), taskBranch(task.id));
      const base = evacuationBaseRef !== "" && isAncestor(namedPlace, tip, evacuationBaseRef) ? evacuationBaseRef : tip;
      const exclude = boardViewExcludes(db, place, task.id, base);
      const baseTree = git(namedPlace.path, "rev-parse", `${base}^{tree}`);
      wipTip = boardWriteTree(checkout, base, namedPlace.path, (tree, repo) =>
        tree === baseTree ? base : fetchStagedTree(namedPlace, repo, tree, base, wipSubject(task), "the WIP commit"), exclude);
    }
  } catch (err) {
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
    if (old !== evacuationBaseRef) throw releaseRefMoved(namedPlace, taskRef, when, evacuationBaseRef, old);
    if (old !== tip) {
      boardRefWriter(db, namedPlace)(taskRef, tip, () => git(namedPlace.path, "update-ref", "--no-deref", taskRef, tip, old));
      const current = readRefSnapshotValue(namedPlace, taskRef);
      if (current !== tip) throw releaseRefMoved(namedPlace, taskRef, when, tip, current);
    }
  }
  if (gated) {
    // ADR 0369 決定7: tree を先に読み、最後に今のタスクブランチが門の tip を持つことを確かめる。
    if (recorded) gitWithoutHistoryOverrides(namedPlace.path, "ls-tree", "-r", "--format=%(objectmode)", recorded);
    const current = readRefSnapshotValue(namedPlace, taskRef);
    if (!recorded || !current || current.startsWith("symref=")) throw releaseRefMoved(namedPlace, taskRef, when, recorded, current);
    if (recorded !== current) {
      if (!isAncestor(namedPlace, recorded, current, gitWithoutHistoryOverrides)) throw releaseRefMoved(namedPlace, taskRef, when, recorded, current);
      const latest = readRefSnapshotValue(namedPlace, taskRef);
      if (latest !== current) throw releaseRefMoved(namedPlace, taskRef, when, recorded, latest);
    }
  }
  // ADR 0276 決定4: 決着した受験者の最後の checkout は記録として残る —— 消さず、解放済みとも刻まない。
  if (!keepsCheckoutAsRecord(db, getTask(db, task.id)!)) {
    appendEvent(db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_released", path: checkout }, at: now });
  }
  return true;
}

/** 盤面が `task/<id>` を書く前に、今の値が基準の行の値の直の ref であることを確かめて返す。違えば比較器と同じ `was: … / now: …` の形で名指す。 */
function taskRefAsRecorded(db: Db, namedPlace: WorkspaceConfig, ref: string, when: string): string {
  const current = readRefSnapshotValue(namedPlace, ref);
  const expected = recordedRef(db, namedPlace.name, ref);
  if (current.startsWith("symref=") || !baselineAllows(expected, current)) throw releaseRefMoved(namedPlace, ref, when, expected, current);
  return current;
}

function releaseRefMoved(workspace: WorkspaceConfig, ref: string, when: string, expected: string | undefined, current: string): RefsMovedError {
  return new RefsMovedError(`workspace ${workspace.name}: refs changed ${when} — was: ${expected || "absent"} ${ref}, now: ${current || "absent"} ${ref}`);
}

/** ADR 0356 決定2: 残った task の checkout を failure question が言う文 —— 中身はタスクブランチに無く、retry は新しい checkout で走る。 */
export const KEPT_TASK_CHECKOUT = {
  beyondBranch: "what it holds beyond the task branch is not on the task branch.",
  at: (path: string): string => `The board kept the task checkout at ${path}: ${KEPT_TASK_CHECKOUT.beyondBranch}`,
  retry: `"retry" picks this task up again at the queue head in a new task checkout made from its task branch. `,
} as const;

/** ADR 0356 決定2: 解放で worker の repo を読めなかった。checkout を残して event に在り処と理由を刻み、`todo` に戻る決着なら
 *  failure question を立てる —— 既に立っている(倒された session)なら足さない。 */
function failTaskOnRelease(db: Db, task: Task, path: string, err: unknown, now: Date): void {
  const reason = err instanceof Error ? err.message : String(err);
  db.transaction(() => {
    appendEvent(db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_release_failed", path, reason }, at: now });
    const current = getTask(db, task.id)!;
    if (current.status === "done" || current.status === "cancelled") return;
    const open = db
      .prepare(
        `SELECT 1 FROM tasks WHERE type = 'question' AND status = 'todo' AND parent_id = ?
           AND question_cancel_option IS NOT NULL AND question_breached_decision IS NULL`,
      )
      .get(task.id);
    if (open) return;
    registerFailureQuestion(
      db,
      current,
      `task checkout could not be released: ${current.title}`,
      `${reason}\n\n${KEPT_TASK_CHECKOUT.at(path)}`,
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
  if (sha === undefined) throw mergeBackConflict(workspace, workbenchBase, source, target, raisedBy);
  advanceBranch(db, workspace, ref, oldTip, sha);
}

/** ADR 0371 決定7・11 / ADR 0373 決定9: merge back の conflict は作業台を開き、その在り処・そこで打つ merge・tip の条件・答え直しを言う
 *  (spec #3273 text A1)。開けなければその理由を言い、答え直しが開き直す(text A7d)。解放の理由は句点で閉じない —— Quarantine の本文が
 *  理由の後に句点を打つ。受理の拒否は文のまま人間に届く。 */
function mergeBackConflict(workspace: WorkspaceConfig, base: string, source: string, target: string, raisedBy: "release" | "acceptance"): Error {
  const exit = (merge: string) =>
    `To discard ${source}'s work instead, record that with \`git merge -s ours ${merge}\`. ` + (raisedBy === "release" ? "Then answer" : "Then answer again.");
  return new Error(workbenchConflict(workspace, base, { subject: source, carried: `refs/heads/${source}`, target, exit }, raisedBy === "release" ? "" : "."));
}

/** text A1 / A2 の共通の形: (書く先, 運ばれる側) の作業台を開き、その在り処・そこで打つ merge・tip の条件を言って `exit` で終える。開けなければ
 *  その理由を言い、答え直しが開き直す(text A7d、`stop` で閉じる)。`carried` は運ばれる側の ref(`board/` の下にはその短い名前)、`subject` は
 *  文の主語。 */
function workbenchConflict(
  workspace: WorkspaceConfig,
  base: string,
  { subject, carried, target, exit }: { subject: string; carried: string; target: string; exit: (merge: string) => string },
  stop: string,
): string {
  const conflict = `${subject} does not merge cleanly into '${target}'.`;
  let opened: { path: string; owner: WorkbenchOwner };
  try {
    opened = openWorkbench(workspace, base, target, carried);
  } catch (err) {
    if (err instanceof WorkbenchUnreadableError) return `${conflict} The board cannot read the workbench at ${err.at} (${err.message}); remove it by hand, then answer again${stop}`;
    return `${conflict} The board could not open the workbench (${err instanceof Error ? err.message : String(err)}); answer again and it opens it again${stop}`;
  }
  const source = shortRef(carried);
  const merge = boardBranch(source);
  return (
    `${conflict} The board opened the workbench at ${opened.path} for it${opened.owner.kind === "mine" && opened.owner.lacksCarried ? `; its tip does not contain ${source}` : ""}. There, on ${target}, run \`git merge ${merge}\` and resolve the conflict ` +
    `${fromOwnClone(target, merge)}. Your tip must contain both ${target} as the board has it now (\`${boardBranch(target)}\`) and ${source}, ` +
    `with nothing uncommitted. ${exit(merge)}`
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
): Array<{ taskId: string; target: string }> {
  const rows = db
    .prepare(
      `${subtreeSql("?")} SELECT id FROM tasks
        WHERE type = 'work' AND status = 'done' AND parent_id IS NOT NULL AND COALESCE(workspace, ?) = ?
          AND (? IS NULL OR id IN (SELECT id FROM subtree))
        ORDER BY rowid DESC`,
    )
    .all(root ?? null, defaultWorkspaceName ?? null, workspace.name, root ?? null) as Array<{ id: string }>;
  return rows.flatMap(({ id }) => {
    if (!taskBranchExists(workspace, id)) return [];
    const target = lineageTaskBranch(db, workspace, getTask(db, id)!);
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
): Promise<string[]> {
  const root = retry?.root;
  if (undeliveredMergeBacks(db, workspace, defaultWorkspaceName, root).length === 0) return [];
  await retry?.firstHalf();
  const running = db
    .prepare(
      `SELECT 1 FROM tasks WHERE COALESCE(workspace, ?) = ? AND (status = 'in_progress' OR teardown_started_at IS NOT NULL)`,
    )
    .get(defaultWorkspaceName ?? null, workspace.name);
  if (running) {
    throw new Error(`a session or its teardown is still running in workspace ${workspace.name} — answer again once it has finished`);
  }
  await refreshProtectedBranch(db, workspace, auth);
  // どの拒否でも休止位置へ戻す。先に落ちた理由(出口の文か git の理由)を休止の失敗より優先し、休止の失敗は運び終えたときだけ投げる
  let failure: { error: unknown } | undefined;
  // 作業台を残した取り込みの text C6
  const kept: string[] = [];
  try {
    // 1つ運ぶたびに読み直す —— 子孫を運んだ子は、親へ運ぶ内容を新しく持つ。ADR 0382 決定2: 人間の tip を持つ作業台を盤面の手の merge より
    // 先に取り込む —— 盤面が先に書く先を進めると、その tip は書く先の今の値を欠いて拒まれる
    next: for (;;) {
      const pending = undeliveredMergeBacks(db, workspace, defaultWorkspaceName, root);
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
    if (!failure || isBoardDbRefusal(parkError)) throw parkError; // ADR 0342 決定4: 盤面 DB の拒否は先の理由の陰に隠さない
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

/** 追いつきの conflict(H6)。ADR 0371 決定11: 開いた作業台の在り処・そこで打つ merge・tip の条件・答え直しを言う文(text A2、作業台を
 *  開けなければ A7d)で、作業台を開いた昇格の失敗の question の本文と retry の拒否にそのまま使う。 */
export class CatchUpConflictError extends Error {}

/** ADR 0105 決定2: catch the task branch up to the protected ref with the task branch as first parent.
 *  ADR 0356 決定5: a checked-out branch's worktree follows its ref.
 *  ADR 0382 決定1: a conflict opens the (workspace, task branch, protected branch) workbench under `workbenchBase`. */
export function catchUpTaskBranch(db: Db, workspace: WorkspaceConfig, taskId: string, workbenchBase: string): void {
  const branch = taskBranch(taskId);
  const ref = `refs/heads/${branch}`;
  const protectedRef = protectedBranchRef(workspace);
  if (isAncestor(workspace, protectedRef, ref)) return;
  const taskSha = git(workspace.path, "rev-parse", ref);
  const merged = mergeCommit(workspace, taskSha, protectedRef, `Merge ${protectedRef} into ${branch}`);
  if (merged === undefined) {
    // 捨てる文は無い —— もう1つの出口は `abandon promotion` のまま(text A2)
    const exit = () => "Then answer `retry`.";
    // 鍵は取り込み(`takeInCatchUp`)と同じ綴りの ref から
    throw new CatchUpConflictError(workbenchConflict(workspace, workbenchBase, { subject: protectedBranch(workspace), carried: exactProtectedBranchRef(workspace), target: branch, exit }, "."));
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

/** ADR 0053 決定3 / ADR 0103: 承認された purely-local の着地を実行する。
 *
 *  帯域外の判定は ff の成否ではなく**盤面自身の記録との突き合わせ**で下す(決定1)。
 *  盤面が自分で進めた保護ブランチは口の畳みで記録に入っている(ADR 0243)ので記録と一致し、一致しない
 *  位置は帯域外の書き込みだけが作る —— ff が黙って飲み込んでいた巻き戻しもこれで
 *  捕まる。記録に行が無い場合も不一致として扱う(ADR 0064 決定6 と同じ fail-closed)。
 *
 *  記録と一致していれば、非 ff は同一 workspace の正当な直列進行である(決定2):
 *  盤面が Tidepool 名義の真の merge commit で追いつかせる。タスクブランチは**決して
 *  書き換えない** —— 差分の恒久記録であり系譜判定の土台である(ADR 0053 根拠1)。
 *
 *  保護ブランチに置いた commit を返す —— 回答はこれを執行の記録として根に刻む(ADR 0289 決定1)。作業台を残した取り込みなら、その text C6 も返す。 */
export function mergeTaskToProtected(db: Db, workspace: WorkspaceConfig, taskId: string, intake: Omit<IntakeContext, "entry">): { landed: string; kept: string | undefined } {
  if (isRemoteBacked(withRememberedRepoCheck(db, workspace))) {
    throw new Error(`workspace ${workspace.name} is remote-backed, not purely-local`);
  }
  const branch = protectedBranch(workspace);
  const ref = `refs/heads/${branch}`;
  const protectedSha = protectedValueAsRecorded(db, workspace);

  const task = taskBranch(taskId);
  // ADR 0382 決定4: 決着済み・cancel 済みを含むすべての task のブランチの commit を作業台の tip に許さない —— 答えている task の tip にある
  // commit は数えない。ADR 0371 決定2・4: 作業台に人間の merge があれば、この回答がそれを取り込み、包む commit が着地
  const refusalFor = (branches: string[], at: string) =>
    `the tip of the workbench at ${at} contains commits of ${branches.join(", ")}, and a task's work enters ${branch} only through its own landing. ` +
    `Start ${branch} in the workbench over with \`git reset --hard ${boardBranch(branch)}\` — this drops your merge there too — then merge only ` +
    `\`${boardBranch(task)}\`, resolve its conflict again and answer again.`;
  const taken = takeInExistingWorkbench(db, workspace, branch, `refs/heads/${task}`, { ...intake, entry: "landing_merge" }, {
    approved: protectedSha,
    otherTasks: { range: "every task", refusalFor },
  });
  if (taken !== undefined) return { landed: taken.commit, kept: taken.kept };
  const landed = isAncestor(workspace, ref, task)
    ? git(workspace.path, "rev-parse", `refs/heads/${task}`)
    : mergeCommit(workspace, protectedSha, `refs/heads/${task}`, `Merge ${task} into ${branch}`);
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
