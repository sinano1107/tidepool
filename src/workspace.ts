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
import type { Db } from "./db.js";
import { appendEvent, latestEventOfTask, type ReadCheckout, type ResourceStop, type TaskCheckoutWriteObservation } from "./events.js";
import {
  boardReadTree,
  boardViewStatus,
  boardWriteTree,
  diffTreeEntries,
  displayWorktreePath,
  git,
  gitlinkChanges,
  gitWithInput,
  gitWithoutHistoryOverrides,
  outOfSpace,
  ownWorktreeStatus,
  type SparsePolicy,
  stagingHostStep,
  TaskCheckoutHostError,
  TaskCheckoutUnreadableError,
  type WorktreeChange,
  WorktreeStatusError,
  withBoardGit,
  workerRepoGit,
  workerRepoGitUntil,
} from "./git.js";
import {
  type GitHubAuth,
  originRepo,
} from "./github-auth.js";
import {
  assertOwnGitDirectory,
  checkoutPickupPredicates,
  conventionCheckoutPath,
  exactProtectedBranchRef,
  gonePlaceReason,
  isRemoteBacked,
  type PickupPredicate,
  type PlaceFire,
  pathIsRegistryClone,
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
import { openQuarantineQuestion, registerResourceStop } from "./quarantine.js";
import { placeHasRepository, recordedPlace } from "./recorded-place.js";
import {
  fetchBranchCopy,
  fetchCommit,
  ownEntry,
  REGISTRY_BRANCH,
  type RefWriter,
  type Registry,
  type RegistrySource,
  type WorkspaceEntry,
} from "./registry.js";
import { PROJECT_SETTINGS_PATHS, recordedSettingsDisposition, SANDBOX_STUB_PATHS } from "./sandbox.js";
import { isSettled } from "./task-status.js";
import {
  carriesReadOnly,
  getTask,
  interviewRole,
  interviewRoomPath,
  interviewRootIdOf,
  issueRefPlaceholder,
  readableInterviewRooms,
  registerFailureQuestion,
  sessionReadCheckouts,
  type Task,
  taskCheckoutPath,
} from "./tasks.js";
import { isBoardDbRefusal } from "./unhandled-rejection-floor.js";
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
   *  (main.ts's fixed single-workspace fallback, test fixtures). */
  branch?: string;
  /** ADR 0052 決定3 / issue #211: この workspace が**リモートの正本を持つ**という
   *  宣言(`workspaces.yaml` の `repo`)。あり = remote-backed、無し = purely-local。
   *  値そのものは clone URL だが、盤面が読むのは有無だけである —— 「宣言であって
   *  推測ではない」ため、clone を覗いて remote の有無で切り替えることはしない
   *  (remote が失われた瞬間に「merge が spawn に効かない」旧挙動へ静かに戻る道を
   *  残さない)。`branch` と同じく registry から毎回読み直され、registry の外で
   *  組まれた `WorkspaceConfig`(main.ts の単一 workspace fallback、テスト fixture)
   *  では不在 = purely-local の宣言になる。 */
  repo?: string;
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

/** ADR 0329: repo を作ってから開いた event を残す。記録済みの面接室は作り直さず、未生の HEAD だけ空コミットで補う。 */
export function openInterviewRoom(db: Db, root: Task, workspacesBaseDir: string, now: Date): void {
  const recorded = recordedPlace(db, root.id);
  if (recorded && !recorded.hasRepository) throw new Error(gonePlaceReason(root.id, recorded.path));
  let path = recorded?.path;
  if (path === undefined) {
    const at = conventionCheckoutPath(root.id, workspacesBaseDir);
    mkdirSync(at, { recursive: true });
    path = realpathSync(at);
    git(path, "init", "--quiet", "--initial-branch=main");
    initialRoomCommit(path, root.id);
    appendEvent(db, { taskId: root.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "interview_room_opened", path }, at: now });
  }
  reopenUnbornRoom(db, { name: root.id, path });
}

function initialRoomCommit(path: string, rootId: string): void {
  if (readRef({ name: rootId, path }, "HEAD") !== "") return;
  // ADR 0329 決定13: 未生の HEAD だけ main へ向け直す —— 人間の init.defaultBranch に依らない。
  git(path, "symbolic-ref", "HEAD", "refs/heads/main");
  // 受験者の履歴に載るので、盤面の語を持たない件名(ADR 0273 決定1)
  git(path, "commit", "--quiet", "--allow-empty", "-m", "Initial commit");
}

/** 手の `git init` で作り直された記録済みの面接室の未生の HEAD を補う。ADR 0351 決定3: 開き直しは基準の行を持つので口を通す ——
 *  書く前に値を知るため commit を先に作る(ADR 0243 決定1)。`main` は作るだけ —— HEAD が orphan の branch にあって `main` が既に
 *  在れば書き込みが落ち、面接室の quarantine に返る(在る `main` を上書きしない)。 */
function reopenUnbornRoom(db: Db, room: WorkspaceConfig): void {
  if (readRef(room, "HEAD") !== "") return;
  // 受験者の履歴に載るので、盤面の語を持たない件名(ADR 0273 決定1)
  const commit = git(room.path, "commit-tree", git(room.path, "write-tree"), "-m", "Initial commit");
  writeBoardRefs(db, room, [["HEAD", symrefValue("refs/heads/main")], ["refs/heads/main", commit]], () => {
    git(room.path, "update-ref", "refs/heads/main", commit, "");
    // ADR 0329 決定13: 未生の HEAD だけ main へ向け直す —— 人間の init.defaultBranch に依らない。
    git(room.path, "symbolic-ref", "HEAD", "refs/heads/main");
  });
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
export async function pickupGate(db: Db, workspace: WorkspaceConfig, task: Task, workspacesBaseDir: string, registry?: RegistrySource, live?: () => boolean) {
  // (task, 面接室) の項は場所の項の後 —— 受験者だけは先(下)
  const room = (rootId: string, fetchedFirst = false) => ({
    ...roomPlace(db, rootId, workspacesBaseDir),
    predicates: () => {
      const own = roomPickupPredicates(db, rootId, workspacesBaseDir, registry);
      const fetched = taskRoomPickupPredicates(db, [task], rootId, workspacesBaseDir);
      return fetchedFirst ? [...fetched, ...own] : [...own, ...fetched];
    },
  });
  const real = { ...workspace, predicates: () => checkoutPickupPredicates(workspace, registry) };
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
export async function firePickupPredicates(
  db: Db,
  place: WorkspaceConfig,
  predicates: PickupPredicate[],
  phase: PickupPredicate["phase"],
  board: PickupPrep & { fresh?: boolean } = {},
): Promise<void> {
  const fire: PlaceFire = {
    fetch: async (target) => {
      await ensureWorkspaceToken(target, board.githubAuth, { fresh: board.fresh });
      if (board.live?.() === false) return;
      if (isRemoteBacked(target)) fetchBranchCopy(target.path, board.githubAuth, protectedBranch(target), boardRefWriter(db, target));
    },
    park: (target) => parkOnProtectedBranch(db, target),
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
  /** 基点 / 鍵(task id、root は `<id>.checkout`)/ pickup の event id */
  task: { at: (base: string, key: string, pickup: number) => join(conventionCheckoutPath(key, base), String(pickup)), parents: 1 },
  /** 基点 / `<task id>.reads` / pickup の event id / 読む面接室の名前(root id) */
  read: { at: (base: string, taskId: string, pickup: number, rootId: string) => join(conventionCheckoutPath(`${taskId}.reads`, base), String(pickup), rootId), parents: 2 },
} as const;

export { TaskCheckoutHostError } from "./git.js";

/** ADR 0356 決定2: pickup ごとに task の checkout を作る。番地は基点 + task id + pickup の event id(ADR 0353 と同じ鍵)なので、
 *  前の session が残した checkout は動かさず再利用もしない。objects は名前の場所から alternates で借り、タスクブランチだけを
 *  fetch して checkout する。Interview の場所は alternates を使わず複製で、自分のブランチだけを引くので兄弟の答案は見えない
 *  (ADR 0356 決定2)。root の番地は面接室(基点 + root id)の外 —— 面接室の内側に checkout を置かない(ADR 0276 決定1)。
 *  開いた event は repo ができた後に書く(ADR 0329)。 */
function openTaskCheckout(db: Db, named: WorkspaceConfig, task: Task, workspacesBaseDir: string, now: Date): void {
  const pickup = latestEventOfTask(db, task.id, "task_picked_up");
  if (!pickup) throw new Error(`task ${task.id} has no pickup to key its task checkout`);
  const branch = taskBranch(task.id);
  const role = interviewRole(db, task);
  // 名前の場所の objects が引けないのは名前の場所の性質 —— host 側の失敗に包まず、呼び手の quarantine へ
  const objects = role === undefined ? namedObjects(named) : undefined;
  let path: string;
  try {
    const at = CHECKOUT_LAYOUT.task.at(workspacesBaseDir, role === "root" ? `${task.id}.checkout` : task.id, pickup.id);
    mkdirSync(at, { recursive: true });
    path = realpathSync(at);
    git(path, "init", "--quiet", "--template=", "--initial-branch=main");
    if (objects !== undefined) {
      mkdirSync(join(path, ".git", "objects", "info"), { recursive: true });
      writeFileSync(join(path, ".git", "objects", "info", "alternates"), `${objects}\n`);
    }
  } catch (cause) {
    throw new TaskCheckoutHostError(`the task checkout of ${task.id} cannot be created: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  // reflog にも名前の場所の在り処を残さない —— 受験者に面接室の在り処(root id)を運ばない(ADR 0276 決定1)
  git(path, "-c", "core.logAllRefUpdates=false", "fetch", ...FETCH_FLAGS, named.path, `refs/heads/${branch}:refs/heads/${branch}`);
  // alternates 越しの fetch は objects の欠けを見ないので、欠けた blob で落ちる plumbing で tree を出す(porcelain の checkout は黙って欠く)
  git(path, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
  git(path, "read-tree", "-u", "--reset", "HEAD");
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
    throw new TaskCheckoutHostError(`the read checkout of the interview room ${room.name} for ${taskId} cannot be created: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
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

const unreadable = (checkout: string, why: string, cause?: unknown) =>
  new TaskCheckoutUnreadableError(`the task checkout at ${checkout} cannot be read: ${why}`, cause === undefined ? undefined : { cause });

/** 盤面が worker の `.git` を読む1つの有界の段: 読む checkout と、段全体の上限の時刻(ADR 0364 決定3 / ADR 0357 決定1)。 */
type WorkerRead = { checkout: string; deadline: number };

const workerRead = (checkout: string): WorkerRead => ({ checkout, deadline: Date.now() + WORKER_TREE_GIT_TIMEOUT_MS });

function assertBeforeDeadline({ deadline }: WorkerRead): void {
  if (Date.now() > deadline) throw new WorkerGitCopyTimeoutError(WORKER_TREE_GIT_TIMEOUT_MS);
}

/** ADR 0364 決定1: worker の `.git` の `rel` を lstat し、あれば `kind` であることを確かめる(symlink を辿らない)。 */
function workerEntry({ checkout }: WorkerRead, rel: string, kind: "directory" | "regular file"): boolean {
  const stat = lstatSync(join(checkout, rel), { throwIfNoEntry: false });
  if (stat && !(kind === "directory" ? stat.isDirectory() : stat.isFile())) throw unreadable(checkout, `${rel} is not a ${kind}`);
  return stat !== undefined;
}

const WORKER_FILE_CHUNK = 1 << 16;

/** ADR 0364 決定1・3: lstat で regular と確かめた file を symlink を辿らずに開き(FIFO は open しない)、段の上限の時刻まで chunk ごとに
 *  読む —— sparse file はサイズでなく時間で縛り、空の file の数でも上限を越えない。Linux では開いた実体が checkout の下にあることも
 *  確かめる: 途中の dir の lstat と open の間に symlink へ差し替えられても辿った先を読まない(盤面が worker を拾う host は Linux だけ、
 *  ADR 0100 決定6)。`use` が false で読み止める。 */
function readWorkerFile(read: WorkerRead, rel: string, use: (chunk: Buffer) => boolean | void): void {
  const { checkout } = read;
  assertBeforeDeadline(read);
  if (!workerEntry(read, rel, "regular file")) throw unreadable(checkout, `${rel} is missing`);
  const fd = openSync(join(checkout, rel), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw unreadable(checkout, `${rel} is not a regular file`);
    if (process.platform === "linux" && !readlinkSync(`/proc/self/fd/${fd}`).startsWith(`${checkout}/`)) throw unreadable(checkout, `${rel} resolves outside the task checkout`);
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
function findWorkerLine(read: WorkerRead, rel: string, pick: (line: string) => string | undefined): string | undefined {
  let rest = "";
  let found: string | undefined;
  readWorkerFile(read, rel, (chunk) => {
    const lines = (rest + chunk.toString("latin1")).split("\n");
    rest = lines.pop()!;
    found = lines.map(pick).find((hit) => hit !== undefined);
    if (rest.length > WORKER_FILE_CHUNK) throw unreadable(read.checkout, `${rel} has a line longer than ${WORKER_FILE_CHUNK} bytes`);
    return found === undefined;
  });
  return found ?? pick(rest);
}

/** 写す段の失敗は worker の repo の故障に包む。上限超過と host の失敗は型のまま(ADR 0357 決定2 / ADR 0364 決定2)。 */
function asWorkerRepoFailure(checkout: string, cause: unknown): Error {
  if (cause instanceof TaskCheckoutUnreadableError || cause instanceof WorkerTreeGitTimeoutError || cause instanceof TaskCheckoutHostError) return cause;
  return unreadable(checkout, cause instanceof Error ? cause.message : String(cause), cause);
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** ADR 0243 決定1: 書く前に値を知る。ADR 0364 決定1: tip は `refs/heads/task/<id>` の file、無ければ `packed-refs` の行(worker の
 *  `gc` は正当に pack する)—— git に worker の `.git` を開かせない。symref は worker の repo の故障。 */
function readWorkerTip(read: WorkerRead, taskId: string): string {
  const { checkout } = read;
  const ref = `refs/heads/${taskBranch(taskId)}`;
  let sha: string | undefined;
  try {
    const dotGit = lstatSync(join(checkout, ".git"), { throwIfNoEntry: false });
    if (!dotGit) throw new TaskCheckoutUnreadableError(`the task checkout at ${checkout} has no git repository`);
    if (!dotGit.isDirectory()) throw unreadable(checkout, ".git is not a directory");
    // ADR 0364 決定1: packed-refs もリポジトリ定義の一部 —— loose の ref があっても種類を確かめる
    const packed = workerEntry(read, ".git/packed-refs", "regular file");
    const parents = ref.split("/").slice(0, -1).map((_, i, parts) => `.git/${parts.slice(0, i + 1).join("/")}`);
    if (parents.every((dir) => workerEntry(read, dir, "directory")) && workerEntry(read, `.git/${ref}`, "regular file")) {
      sha = findWorkerLine(read, `.git/${ref}`, (line) => line);
      if (!OID.test(sha ?? "")) throw unreadable(checkout, `${ref} is not a direct ref`);
    } else if (packed) {
      sha = findWorkerLine(read, ".git/packed-refs", (line) => {
        const [oid, name] = line.split(" ");
        return name === ref && OID.test(oid ?? "") ? oid : undefined;
      });
    }
  } catch (cause) {
    throw asWorkerRepoFailure(checkout, cause);
  }
  if (!sha) throw new TaskCheckoutUnreadableError(`the task checkout at ${checkout} has no branch ${taskBranch(taskId)}`);
  return sha;
}

/** 写しの tmp に書けない —— worker でも名前の場所でもない host の失敗(ADR 0364 決定2、pickup と同じ線)。 */
const copyHostError = (cause: unknown) =>
  new TaskCheckoutHostError(`the board cannot make its copy of the task checkout's git files: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });

function hostStep<T>(step: () => T): T {
  try {
    return step();
  } catch (cause) {
    throw copyHostError(cause);
  }
}

const ZERO_CHUNK = Buffer.alloc(WORKER_FILE_CHUNK);

/** checkout の `rel` の byte を写しの `to` へ。hardlink は inode を worker と共有するので使わない(ADR 0364 決定1)。0 だけの chunk は
 *  書かずに穴にする —— byte は同じで、sparse file が tmp を実体で埋めない(`core.compression=0` の pack は正当に 0 の連なりを持つ)。 */
function copyWorkerFile(read: WorkerRead, rel: string, to: string): void {
  const out = hostStep(() => openSync(to, "wx"));
  try {
    let position = 0;
    readWorkerFile(read, rel, (chunk) => {
      if (!chunk.equals(ZERO_CHUNK.subarray(0, chunk.length))) hostStep(() => writeSync(out, chunk, 0, chunk.length, position));
      position += chunk.length;
    });
    hostStep(() => ftruncateSync(out, position));
  } finally {
    closeSync(out);
  }
}

/** 写して検証する段(ADR 0364 決定1): checkout の loose と `.pack` だけを `raw` へ写し(`.idx` は作り直す、`info/alternates` は辿らない)、
 *  tip の閉包を1つの pack にして `verified` で `index-pack --strict` する —— 欠けは rev-list / pack-objects が、zlib の破損は
 *  pack-objects が、中身と名前の不一致は worker の byte を持たない `verified` の検査が落とす。名前の場所の objects を借りる役は
 *  名前の場所の ref から届く閉包を pack に入れない。ref は `verified` にだけ書く。git も file の写しも段の1つの上限の中(決定3)。 */
function copyAndVerifyWorkerTip(place: TaskCheckoutPlace, read: WorkerRead, raw: string, verified: string, sha: string, ref: string, format: string): void {
  const { checkout, deadline } = read;
  const looseName = new RegExp(`^[0-9a-f]{${format === "sha256" ? 62 : 38}}$`);
  try {
    if (workerEntry(read, ".git/objects", "directory")) {
      for (const dir of readdirSync(join(checkout, ".git", "objects")).filter((name) => /^[0-9a-f]{2}$/.test(name))) {
        workerEntry(read, `.git/objects/${dir}`, "directory");
        hostStep(() => mkdirSync(join(raw, "objects", dir)));
        for (const file of readdirSync(join(checkout, ".git", "objects", dir)).filter((name) => looseName.test(name))) {
          copyWorkerFile(read, `.git/objects/${dir}/${file}`, join(raw, "objects", dir, file));
        }
      }
      if (workerEntry(read, ".git/objects/pack", "directory")) {
        for (const file of readdirSync(join(checkout, ".git", "objects", "pack")).filter((name) => name.endsWith(".pack"))) {
          copyWorkerFile(read, `.git/objects/pack/${file}`, join(raw, "objects", "pack", file));
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
    const failure = asWorkerRepoFailure(checkout, cause);
    throw failure !== cause && outOfSpace(raw, cause) ? copyHostError(cause) : failure;
  }
}

/** ADR 0364 決定1・2: worker の tip を検証済みの盤面所有の repo として開く。 */
function withVerifiedWorkerTip<T>(place: TaskCheckoutPlace, taskId: string, use: (sha: string, repo: string, ref: string) => T): T {
  const { namedPlace, path: checkout } = place;
  const ref = `refs/heads/${taskBranch(taskId)}`;
  // 名前の場所の側の故障を worker の repo のせいにしない —— ここで落ちれば素の失敗(呼び手の quarantine)
  const format = git(namedPlace.path, "rev-parse", "--show-object-format");
  const alternates = place.borrowsNamedObjects ? `${namedObjects(namedPlace)}\n` : undefined;
  // ADR 0364 決定3: tip の読みから閉包の検証までが1つの有界の段
  const read = workerRead(checkout);
  const sha = readWorkerTip(read, taskId);
  // ADR 0364 決定1: 写しは盤面 process の tmp —— worker は書けない(task temp でも checkout の中でもない)
  const dir = hostStep(() => mkdtempSync(join(tmpdir(), "tidepool-worker-tip-")));
  try {
    const [raw, verified] = [join(dir, "raw"), join(dir, "verified")];
    for (const repo of [raw, verified]) {
      hostStep(() => {
        git(dir, "init", "--bare", "--quiet", "--template=", `--object-format=${format}`, repo);
        if (alternates) writeFileSync(join(repo, "objects", "info", "alternates"), alternates);
      });
    }
    copyAndVerifyWorkerTip(place, read, raw, verified, sha, ref, format);
    return use(sha, verified, ref);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** task の checkout のタスクブランチの tip を、ref を書かずに名前の場所の objects へ引く。 */
function fetchWorkerTip(place: TaskCheckoutPlace, taskId: string): string {
  return withVerifiedWorkerTip(place, taskId, (sha, repo, ref) => {
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
  const tip = fetchWorkerTip(place, taskId);
  const ref = `refs/heads/${taskBranch(taskId)}`;
  const old = readRefSnapshotValue(namedPlace, ref);
  // ADR 0243 決定2 / ADR 0359 決定4: この書き込みの旧値だけを確かめ、帯域外の値を基準に取り込まない
  const expected = recordedRef(db, namedPlace.name, ref);
  if (old.startsWith("symref=") || !baselineAllows(expected, old)) {
    throw new RefsMovedError(`workspace ${namedPlace.name}: ${ref} is not the recorded direct ref (expected ${expected ?? "absent"}, found ${old || "absent"})`);
  }
  if (old !== tip) boardRefWriter(db, namedPlace)(ref, tip, () => git(namedPlace.path, "update-ref", "--no-deref", ref, tip, old));
  return tip;
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
  return withVerifiedWorkerTip(place, taskId, (tip, verified) => {
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
    const base = candidate ?? protectedBranchRef(workspace);
    if (!isSettled(ancestor.status)) {
      candidate = branch;
      continue;
    }
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
): string | undefined {
  return resolveTaskBranchLineage(db, workspace, task).branch;
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
    tip = git(workspace.path, "rev-parse", "--verify", protectedBranchRef(workspace));
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
  return interviewRole(db, task) === "examinee"
    ? resolvablePosedHead(db, workspace, task)
    : git(workspace.path, "rev-parse", `${lineageTaskBranch(db, workspace, task) ?? exactProtectedBranchRef(workspace)}^{commit}`);
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

/** ADR 0093: workspace を fetch する前に、その checkout の `origin` 宛ての
 *  installation token を用意する。取得(ネットワーク)と注入(同期)を分けるのは
 *  ADR 0066 決定5 と同じ理由で、fetch そのものを同期に保つためである —— 宣言
 *  (`repo`)ではなく `origin` から決めるのは、token が repo 単位で、fetch が実際に
 *  触る remote と宛先が一致していなければならないからである(`repo` は人間向けの
 *  provenance でもあって綴りの一致を要求しない: ADR 0052)。
 *
 *  仲介の不達はここで投げ、呼び出し元の quarantine がそのまま受ける。 */
export async function ensureWorkspaceToken(
  workspace: WorkspaceConfig,
  auth: GitHubAuth | undefined,
  options: { fresh?: boolean } = {},
): Promise<void> {
  if (!isRemoteBacked(workspace)) return;
  await auth?.ensureToken(originRepo(workspace.path), options);
}

/** ADR 0241 決定1: 収束が merge 済みの根を保護ブランチと比べる前に、保護ブランチの写しを進める —— 写しは pickup と
 *  後始末の fetch でしか動かず、merge の直後はまだ merge された内容を持たない。走っている session の基準の下で写しを
 *  動かすので、原本の sha を先に知ってから口を通して書く(ADR 0243 決定3)。失敗は投げる(呼び手の根の失敗になる)。 */
export async function refreshProtectedBranch(db: Db, workspace: WorkspaceConfig, auth: GitHubAuth | undefined): Promise<void> {
  if (!isRemoteBacked(workspace)) return;
  await ensureWorkspaceToken(workspace, auth);
  fetchBranchCopy(workspace.path, auth, protectedBranch(workspace), boardRefWriter(db, workspace));
}

/** ADR 0242 決定1: merge の門が比べる GitHub の head が手元に無ければ、origin から sha で取る。sha の fetch は `refs/` に
 *  何も書かない(FETCH_HEAD だけ)ので口は要らない。失敗は投げる。 */
export async function fetchCommitIfMissing(workspace: WorkspaceConfig, sha: string, auth: GitHubAuth | undefined): Promise<void> {
  try {
    git(workspace.path, "cat-file", "-e", `${sha}^{commit}`);
    return;
  } catch {}
  await ensureWorkspaceToken(workspace, auth);
  fetchCommit(workspace.path, auth, sha);
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
  },
): Promise<void> {
  prepareRefBaseline(db, workspace);
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
      prepareRefBaseline(db, read.place);
    } catch (err) {
      if (isBoardDbRefusal(err)) throw err;
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

/** 基準の HEAD 行の値: 指し先、detached なら sha。`symbolic-ref -q` の非零は 1 が detached で、他は道具の失敗。 */
function headValue(workspace: WorkspaceConfig): string {
  try {
    return symrefValue(git(workspace.path, "symbolic-ref", "-q", "HEAD"));
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return git(workspace.path, "rev-parse", "HEAD");
  }
}

/** ADR 0351 決定2: 全撮りは盤面がまだ持ったことのない checkout の pickup(行が無いか NULL)と quarantine の受理
 *  (`retakeRefBaselines`、決定4)だけが撮り、それ以外は盤面自身が書いた ref の行だけが書く前の予告と書いた後の畳みで更新される
 *  (`writeBoardRefs`)、比較が2値行を畳む(`compareAndFoldBaseline`)。 */
function snapshotRefs(db: Db, workspace: WorkspaceConfig): void {
  writeSnapshot(db, workspace.name, currentRefs(workspace));
}

function prepareRefBaseline(db: Db, workspace: WorkspaceConfig): void {
  const key = workspace.name;
  const first = storedRefs(db, key) === "";
  if (!first) compareAndFoldBaseline(db, workspace, [], "while the checkout rested since the last session");
  const pin = storedSparsePolicy(db, key);
  if (pin !== undefined && !first) return;
  // ADR 0356 決定3: an existing checkout without a pin may already carry worker-written rules.
  const policy = first && pin === undefined ? readSparsePolicy(workspace) : undefined;
  db.transaction(() => {
    if (first) snapshotRefs(db, workspace);
    if (pin === undefined) db.prepare("INSERT INTO workspace_sparse_policies (name, policy) VALUES (?, ?)").run(key, JSON.stringify(policy ?? null));
  })();
}

function writeSnapshot(db: Db, key: string, refs: string): void {
  db.prepare(
    `INSERT INTO workspace_state (name, ref_snapshot) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET ref_snapshot = excluded.ref_snapshot`,
  ).run(key, refs);
}

/** ADR 0351 決定4: quarantine の受理は検査がすべて成立した後に、名前に掛かる場所それぞれの基準を自分の checkout から撮り直す ——
 *  基準は名前の場所だけが持つ(ADR 0356 決定4)。撮り直すのは盤面が既に基準を持つ場所だけ —— まだ持ったことのない場所
 *  (開いていない面接室の在り処に repo がある)は最初の開きの build が口を通らずに書くので、その後の最初の
 *  pickup が最初の撮りをする(決定2)。repo の無い場所も撮らない。全部読んでから書くので、読みが落ちれば行は変わらない。 */
export function retakeRefBaselines(db: Db, places: WorkspaceConfig[]): void {
  const held = places.filter((place) => placeHasRepository(place.path) && storedRefs(db, place.name) !== "");
  const rows = new Map(held.map((place) => [place.name, currentRefs(place)]));
  db.transaction(() => {
    for (const [key, refs] of rows) writeSnapshot(db, key, refs);
  })();
}

/** ADR 0351 決定7: 行の寿命は workspace の寿命 —— 削除の扉が基準と sparse の pin の行ごと消す。残すと同名を別 path で登録し直したとき
 *  旧 checkout の基準と比べる。面接室と受験者の行は消されない checkout のものなので、ここを通らない(ADR 0276 決定4)。 */
export function dropWorkspaceState(db: Db, name: string): void {
  db.transaction(() => {
    db.prepare("DELETE FROM workspace_state WHERE name = ?").run(name);
    db.prepare("DELETE FROM workspace_sparse_policies WHERE name = ?").run(name);
  })();
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

/** 基準の比較で動いた ref が見つかった —— 呼び手はどれも workspace quarantine に落とし、pickup は repo アクセスの案内を付けない
 *  (fetch の失敗ではない —— 案内は repo アクセスの失敗の瞬間だけのもの、ADR 0067 決定2)。 */
export class RefsMovedError extends Error {}

/** ADR 0064 の不変条件の1つの比較器で、通れば2値行を畳む(ADR 0351 決定2・4): `except` 以外の ref がすべて基準の値のままであることを要求する ——
 *  移動・削除・新規作成のいずれも違反で、削除が最も静かな破壊であるからこそ「動いたものだけを見る」綴りは選ばない(ADR 0064 決定2)。
 *  release は自分で書く ref を除き、pickup と門の掛かる完了の解放は何も除かない(ADR 0359 決定2・4)。通れば、落ちて残った2値行を ref が持つ側に畳む(ADR 0351 決定4)。
 *
 *  メッセージは**動いた ref を名指しする**。quarantine の確認 question の本文に載り、
 *  人間の修理手順がそのまま読める形になる。予告中の行は2値のまま載る。 */
function compareAndFoldBaseline(db: Db, workspace: WorkspaceConfig, except: readonly string[], when: string): ReadonlyMap<string, string> {
  const before = refValues(storedRefs(db, workspace.name));
  const after = refValues(currentRefs(workspace));
  const moved = [...new Set([...before.keys(), ...after.keys()])].filter(
    (ref) => !except.includes(ref) && !baselineAllows(before.get(ref), after.get(ref)),
  );
  if (moved.length > 0) {
    throw new RefsMovedError(
      `workspace ${workspace.name}: refs${except.length > 0 ? ` other than ${except.join(" and ")}` : ""} changed ${when} — ` +
        [
          ...moved.filter((ref) => before.has(ref)).map((ref) => `was: ${before.get(ref)} ${ref}`),
          ...moved.filter((ref) => after.has(ref)).map((ref) => `now: ${after.get(ref)} ${ref}`),
        ].join(", "),
    );
  }
  const announced = [...before].filter(([ref, value]) => baselineValues(value).length > 1 && !except.includes(ref));
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
      throw asWorkerRepoFailure(checkout, err);
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
    const workerTip = readWorkerTip(workerRead(place.path), taskId);
    if (!recorded) return;
    if (workerTip !== recorded) return { observation: "committed", worker_tip: workerTip };
    const paths = taskCheckoutChanges(db, place, taskId, recorded).map(({ path }) => path);
    if (paths.length > 0) return { observation: "uncommitted", paths };
  } catch (err) {
    // ADR 0359 決定5: view の上限超過も、完了済みの解放では「読めない」観測
    if (!(err instanceof TaskCheckoutUnreadableError || err instanceof WorktreeStatusError || err instanceof WorkerTreeGitTimeoutError)) throw err;
    return { observation: "unreadable", reason: err.message };
  }
}

/** ADR 0052 決定7 / ADR 0356 決定5: the resting checkout shows the protected branch's current tree.
 *  A remote-backed place follows origin only by fast-forward, preserving ahead or diverged commits for repair. */
function parkOnProtectedBranch(db: Db, workspace: WorkspaceConfig): void {
  const branch = protectedBranch(workspace);
  try {
    // 盤面は名前の場所の HEAD を動かさない(ADR 0356 決定1)が、人間の修理(ADR 0239 帰結の `merge -s ours`、ADR 0351 決定1・4)や origin にしか無い
    // 保護ブランチは HEAD を保護ブランチの外に置く
    if (headValue(workspace) !== symrefValue(`refs/heads/${branch}`)) checkoutThroughGate(db, workspace, branch);
  } catch (cause) {
    if (isBoardDbRefusal(cause)) throw cause; // ADR 0342 決定4: 包むと判定が届かない
    throw new Error(`workspace ${workspace.name}: protected branch '${branch}' cannot be checked out: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (!isRemoteBacked(workspace)) return;
  const ref = protectedBranchRef(workspace);
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
  return registerResourceStop(db, "workspace", workspaceName, cause instanceof Error ? cause.message : String(cause), now);
}

/** Whether a workspace entry's checkout is the board's own registry clone,
 *  compared by realpath so a symlinked temp dir or mount point can't split the
 *  two spellings of the same directory. A path-omitting entry compares by its
 *  convention-derived location (ADR 0018). Shared by the self-unprotect floor
 *  (workspace-create.ts) and the default-branch guard below. */
export function resolvesToRegistryClone(
  entry: WorkspaceEntry,
  name: string,
  registryDir: string,
  workspacesBaseDir: string,
): boolean {
  return pathIsRegistryClone(entryCheckoutPath(entry, name, workspacesBaseDir), registryDir);
}

/** The registry clone is itself a tracked workspace (a protected entry whose
 *  path resolves to the clone). Undefined when the clone isn't a tracked
 *  workspace at all — nothing to quarantine. */
function registryWorkspaceName(
  registry: Registry,
  registryDir: string,
  workspacesBaseDir: string,
): string | undefined {
  for (const [name, entry] of Object.entries(registry.workspaces)) {
    if (resolvesToRegistryClone(entry, name, registryDir, workspacesBaseDir)) return name;
  }
  return undefined;
}

/** ADR 0020 part 2: `main` is the code-constant branch the board reads the
 *  registry from, but it must still be the repository's real default branch.
 *  When the clone's `origin/HEAD` (git's native notion of the default branch)
 *  no longer resolves to `origin/main`, reading `main` would silently read a
 *  branch that isn't the default — the "quietly reads a stale/wrong value"
 *  trap the ADR rejects. Detect it and drop the registry workspace into the
 *  existing quarantine so a human repairs the clone before any spawn trusts
 *  `main`. A clone with no `origin/HEAD` at all (no remote configured — a
 *  purely local board) is not a mismatch: there is no remote default to
 *  disagree with, so it passes untouched. */
export function guardRegistryDefaultBranch(
  db: Db,
  registry: Registry,
  registryDir: string,
  workspacesBaseDir: string,
  now: Date,
): void {
  let target: string;
  try {
    target = git(registryDir, "symbolic-ref", "refs/remotes/origin/HEAD");
  } catch {
    return; // no origin/HEAD — no remote default to disagree with
  }
  const expected = `refs/remotes/origin/${REGISTRY_BRANCH}`;
  if (target === expected) return;
  const name = registryWorkspaceName(registry, registryDir, workspacesBaseDir);
  if (!name) return; // the registry clone isn't a tracked workspace — nothing to quarantine
  quarantineWorkspace(
    db,
    name,
    new Error(`registry default branch is '${target}', not '${expected}'`),
    now,
  );
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
function settleBranches(db: Db, workspace: WorkspaceConfig, task: Task, mergeBack: boolean, githubAuth: GitHubAuth | undefined, tokenFailure: unknown, recordedTip?: string): void {
  // merge-back の帰り先はこの fetch の結果で決まる。token は呼び出し元が
  // `ensureWorkspaceToken` で温めてある(ADR 0093)。温められなかったときは、その
  // 失敗を fetch が落ちたのと同じ位置で投げる —— WIP は既に退避済みで、行き先は
  // 同じ quarantine(ADR 0052)。呼び出し元で投げると slot が解放されない。
  if (mergeBack) {
    if (tokenFailure !== undefined) throw tokenFailure;
    // ADR 0351 決定3: 基準は切れないので、後始末の fetch も口を通す
    if (isRemoteBacked(workspace)) fetchBranchCopy(workspace.path, githubAuth, protectedBranch(workspace), boardRefWriter(db, workspace));
  }
  const target = mergeBack && lineageTaskBranch(db, workspace, task);
  if (target) mergeBackInto(db, workspace, target, task.id, "then answer", recordedTip);
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
      if (!bringTaskCheckout(db, place, task, now, completed, gated)) return;
    } catch (err) {
      if (isBoardDbRefusal(err)) throw err; // ADR 0342 決定4: quarantine も同じ器に書くので、書かずに底へ
      quarantineWorkspace(db, namedPlace.name, err, now);
      return;
    }
  }
  try {
    // ADR 0064 決定5 / ADR 0356 決定4: 基準は名前の場所だけが持ち、task の checkout の ref の移動は読まない。HEAD も比べる ——
    // 盤面は名前の場所の HEAD を動かさない(ADR 0356 決定1)ので、session の間の HEAD の移動は人間の書き込み(ADR 0351)
    const verifiedRefs = compareAndFoldBaseline(db, namedPlace, gated || released ? [] : [taskRef], "during the session");
    if (!gated && !released) {
      // ADR 0351 決定2: 退避したタスクブランチの行を現在値へ畳む
      updateBaseline(db, namedPlace, (values) => values.set(taskRef, readRef(namedPlace, taskRef)));
    }
    // ADR 0359 決定2・4: 基準比較が済んだ ref を読み直して、帯域外の値を merge back に運ばない。
    const verifiedTip = gated ? verifiedRefs.get(taskRef) : undefined;
    if (gated && !verifiedTip) throw new Error(`workspace ${namedPlace.name}: the recorded task ref ${taskRef} is missing`);
    settleBranches(db, namedPlace, task, mergeBack, githubAuth, tokenFailure, verifiedTip);
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

export function taskCheckoutWasReleased(db: Db, taskId: string, checkout: string): boolean {
  return latestEventOfTask(db, taskId, "task_checkout_released")?.payload.path === checkout;
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

/** ADR 0369 決定1〜3: 済まなかった解放の「運ぶ」だけをやり直す(workspace の Quarantine の受理の検査)。後の段は撃たない ——
 *  session の間の ref の比較はやり直さず、merge back は受理がこの後にやり直す。名前の場所の事情の失敗は呼び手へ投げる ——
 *  Quarantine は既に開いていて、登録し直すと理由が消える。worker の repo の故障は後始末と同じく task の失敗にして返る。 */
export function redoOwedRelease(db: Db, place: TaskCheckoutPlace, task: Task, now: Date, completed: boolean): void {
  if (bringTaskCheckout(db, place, task, now, completed, completed && completionTreeGateApplies(task))) removeReleasedTaskCheckout(db, task.id);
}

/** ADR 0369 決定7: tip と WIP が名前の場所のタスクブランチに着けば `task_checkout_released` を刻んで true、worker の repo の故障を
 *  task の失敗に記録したら false。名前の場所の事情の失敗は投げる —— 後始末は Quarantine に、受理のやり直しは回答の拒否にする。 */
function bringTaskCheckout(
  db: Db,
  place: TaskCheckoutPlace,
  task: Task,
  now: Date,
  completed: boolean,
  gated: boolean,
): boolean {
  const { namedPlace, path: checkout } = place;
  const taskRef = `refs/heads/${taskBranch(task.id)}`;
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
      const tip = fetchWorkerTip(place, task.id);
      evacuationBaseRef = readRefSnapshotValue(namedPlace, taskRef);
      if (evacuationBaseRef.startsWith("symref=")) {
        throw new RefsMovedError(`workspace ${namedPlace.name}: expected a direct task ref, found ${evacuationBaseRef} ${taskRef}`);
      }
      const base = evacuationBaseRef !== "" && isAncestor(namedPlace, tip, evacuationBaseRef) ? evacuationBaseRef : tip;
      const exclude = boardViewExcludes(db, place, task.id, base);
      const baseTree = git(namedPlace.path, "rev-parse", `${base}^{tree}`);
      wipTip = boardWriteTree(checkout, base, namedPlace.path, (tree, repo) =>
        tree === baseTree ? base : fetchStagedTree(namedPlace, repo, tree, base, wipSubject(task), "the WIP commit"), exclude);
    }
  } catch (err) {
    // ADR 0357 決定2: 上限超過は worker の repo の故障 —— 名前の場所を quarantine しない。ADR 0364 決定2: 写しの host の失敗は
    // 決着していない task の失敗、完了済みなら唯一の写しを消さずに止める器が quarantine しか無い(#3053)
    if (!(err instanceof TaskCheckoutUnreadableError || err instanceof WorkerTreeGitTimeoutError || (err instanceof TaskCheckoutHostError && !completed))) throw err;
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
    if (old !== evacuationBaseRef) throw releaseRefMoved(namedPlace, taskRef, evacuationBaseRef, old);
    if (old !== tip) {
      boardRefWriter(db, namedPlace)(taskRef, tip, () => git(namedPlace.path, "update-ref", "--no-deref", taskRef, tip, old));
      const current = readRefSnapshotValue(namedPlace, taskRef);
      if (current !== tip) throw releaseRefMoved(namedPlace, taskRef, tip, current);
    }
  }
  if (gated) {
    // ADR 0369 決定7: tree を先に読み、最後に今のタスクブランチが門の tip を持つことを確かめる。
    if (recorded) gitWithoutHistoryOverrides(namedPlace.path, "ls-tree", "-r", "--format=%(objectmode)", recorded);
    const current = readRefSnapshotValue(namedPlace, taskRef);
    if (!recorded || !current || current.startsWith("symref=")) throw releaseRefMoved(namedPlace, taskRef, recorded, current);
    if (recorded !== current) {
      if (!isAncestor(namedPlace, recorded, current, gitWithoutHistoryOverrides)) throw releaseRefMoved(namedPlace, taskRef, recorded, current);
      const latest = readRefSnapshotValue(namedPlace, taskRef);
      if (latest !== current) throw releaseRefMoved(namedPlace, taskRef, recorded, latest);
    }
  }
  // ADR 0276 決定4: 決着した受験者の最後の checkout は記録として残る —— 消さず、解放済みとも刻まない。
  const settled = getTask(db, task.id)!;
  if (interviewRole(db, settled) !== "examinee" || !isSettled(settled.status)) {
    appendEvent(db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_released", path: checkout }, at: now });
  }
  return true;
}

function releaseRefMoved(workspace: WorkspaceConfig, ref: string, expected: string | undefined, current: string): RefsMovedError {
  return new RefsMovedError(`workspace ${workspace.name}: refs changed during the session — was: ${expected || "absent"} ${ref}, now: ${current || "absent"} ${ref}`);
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

/** ADR 0356 決定5: merge back advances the target ref without switching branches. A conflict reports the same repair options
 *  to teardown and quarantine acceptance (ADR 0239 帰結 / ADR 0240 決定4). */
function mergeBackInto(
  db: Db,
  workspace: WorkspaceConfig,
  target: string,
  taskId: string,
  thenAnswer: "then answer" | "then answer again",
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
  if (sha === undefined) {
    throw new Error(
      `${source} does not merge cleanly into '${target}' — either merge it there by hand in workspace ` +
        `${workspace.name} and commit, or, to discard it, record it there with \`git merge -s ours ${source}\`; ` +
        thenAnswer,
    );
  }
  advanceBranch(db, workspace, ref, oldTip, sha);
}

/** ADR 0240 決定4: 内容が帰り先(lineage が指す祖先のタスクブランチ)に届いていない done の work と、その帰り先。
 *  新しい行から並べる —— 子孫の内容を先に子へ運んでから、子を親へ運ぶ。読めなければ投げる(fail-closed)。
 *  shortcut: その workspace の done の子をすべて読む。回答のたびなので、遅くなれば着地の終わった木を SQL で外す。 */
function undeliveredMergeBacks(
  db: Db,
  workspace: WorkspaceConfig,
  defaultWorkspaceName: string | undefined,
): Array<{ taskId: string; target: string }> {
  const rows = db
    .prepare(
      `SELECT id FROM tasks
        WHERE type = 'work' AND status = 'done' AND parent_id IS NOT NULL AND COALESCE(workspace, ?) = ?
        ORDER BY rowid DESC`,
    )
    .all(defaultWorkspaceName ?? null, workspace.name) as Array<{ id: string }>;
  return rows.flatMap(({ id }) => {
    if (!taskBranchExists(workspace, id)) return [];
    const target = lineageTaskBranch(db, workspace, getTask(db, id)!);
    return target && branchMergeEffect(workspace, target, taskBranch(id)).changesCandidate ? [{ taskId: id, target }] : [];
  });
}

/** ADR 0240 決定4: workspace の quarantine の受理の検査がやり直す merge back。届いていない done の work が無ければ何もしない
 *  (ネットワークにも出ない)。あれば、走っている session(後始末が未了のものを含む)が無いことを読んでから(ADR 0064)、
 *  保護ブランチの fetch(`refreshProtectedBranch`)→ 帰り先へ merge back → 休止位置へ
 *  戻す、を踏む。どの書き込みも口を通り、基準の行は書いた値に
 *  畳まれる(ADR 0243 決定4)。conflict は中断状態を残さないので、休止位置へ戻して出口の文のまま投げる。 */
export async function redoMergeBacks(
  db: Db,
  workspace: WorkspaceConfig,
  defaultWorkspaceName: string | undefined,
  auth: GitHubAuth | undefined,
): Promise<void> {
  if (undeliveredMergeBacks(db, workspace, defaultWorkspaceName).length === 0) return;
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
  try {
    // 1つ運ぶたびに読み直す —— 子孫を運んだ子は、親へ運ぶ内容を新しく持つ
    for (;;) {
      const [next] = undeliveredMergeBacks(db, workspace, defaultWorkspaceName);
      if (!next) break;
      mergeBackInto(db, workspace, next.target, next.taskId, "then answer again");
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

/** `ancestor` が `descendant` に含まれているか = ff で運べるか。git の述語系コマンドは
 *  「答えが no」も非零で返すので、答え(1)と**道具の失敗**(128 等)を終了コードで分ける ——
 *  後者を no と読み替えると、壊れた checkout が「コンフリクト」という嘘の理由で人間に届く。 */
function isAncestor(workspace: WorkspaceConfig, ancestor: string, descendant: string, readGit = git): boolean {
  try {
    readGit(workspace.path, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return false;
  }
}

/** ADR 0105 決定2: catch the task branch up to the protected ref with the task branch as first parent.
 *  ADR 0356 決定5: a checked-out branch's worktree follows its ref. */
export function catchUpTaskBranch(db: Db, workspace: WorkspaceConfig, taskId: string): void {
  const branch = taskBranch(taskId);
  const ref = `refs/heads/${branch}`;
  const protectedRef = protectedBranchRef(workspace);
  if (isAncestor(workspace, protectedRef, ref)) return;
  const taskSha = git(workspace.path, "rev-parse", ref);
  const merged = mergeCommit(workspace, taskSha, protectedRef, `Merge ${protectedRef} into ${branch}`);
  if (merged === undefined) {
    throw new Error(
      `workspace ${workspace.name}: ${protectedRef} does not merge cleanly into '${branch}' — ` +
        "resolve it by hand, then retry PR promotion",
    );
  }
  advanceBranch(db, workspace, ref, taskSha, merged);
}

/** ADR 0103 決定4: 自動では合わない、と分かっただけの状態。タスクブランチも保護
 *  ブランチも無傷なので、これは回答の拒否であって隔離ではない。 */
function landingConflict(workspace: WorkspaceConfig, branch: string, task: string): Error {
  return new Error(
    `workspace ${workspace.name}: ${task} does not merge cleanly into '${branch}' — ` +
      "resolve it by hand, then answer the landing question again",
  );
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
 *  保護ブランチに置いた commit を返す —— 回答はこれを執行の記録として根に刻む(ADR 0289 決定1)。 */
export function mergeTaskToProtected(db: Db, workspace: WorkspaceConfig, taskId: string): string {
  if (isRemoteBacked(workspace)) {
    throw new Error(`workspace ${workspace.name} is remote-backed, not purely-local`);
  }
  const branch = protectedBranch(workspace);
  const ref = `refs/heads/${branch}`;
  const protectedSha = git(workspace.path, "rev-parse", ref);
  const recorded = recordedRef(db, workspace.name, ref);
  if (!baselineAllows(recorded, protectedSha)) {
    throw new OutOfBandProtectedBranchError(workspace.name, branch, recorded, protectedSha);
  }

  const task = taskBranch(taskId);
  const landed = isAncestor(workspace, ref, task)
    ? git(workspace.path, "rev-parse", `refs/heads/${task}`)
    : mergeCommit(workspace, protectedSha, `refs/heads/${task}`, `Merge ${task} into ${branch}`);
  if (landed === undefined) throw landingConflict(workspace, branch, task);
  // ADR 0064 決定4 / ADR 0356 決定5: a human landing may race with a session, so follow only if HEAD is on this ref.
  advanceBranch(db, workspace, ref, protectedSha, landed);
  return landed;
}
