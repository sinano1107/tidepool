import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { BOARD_ACTOR_ID } from "./actor-id.js";
import type { Db } from "./db.js";
import { appendEvent, latestEventOfTask, type ResourceStop, type TaskCheckoutWriteObservation } from "./events.js";
import {
  boardReadTree,
  boardViewStatus,
  boardWriteTree,
  displayWorktreePath,
  git,
  gitWithInput,
  ownWorktreeStatus,
  type SparsePolicy,
  type WorktreeChange,
  WorktreeStatusError,
  withBoardGit,
  workerRepoGit,
} from "./git.js";
import {
  type GitHubAuth,
  originRepo,
} from "./github-auth.js";
import {
  assertOwnGitDirectory,
  checkoutPickupPredicates,
  conventionCheckoutPath,
  examineePickupPredicates,
  gonePlaceReason,
  isRemoteBacked,
  type PickupPredicate,
  type PlaceFire,
  pathIsRegistryClone,
  protectedBranch,
  protectedBranchRef,
  resolvablePosedHead,
  roomPickupPredicates,
  safeRealpath,
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
import { SANDBOX_SHADOW_PATHS } from "./sandbox.js";
import { isSettled } from "./task-status.js";
import {
  carriesReadOnly,
  getTask,
  interviewRoomPath,
  interviewRootIdOf,
  issueRefPlaceholder,
  readableInterviewRooms,
  registerFailureQuestion,
  type Task,
  taskCheckoutPath,
} from "./tasks.js";
import { isBoardDbRefusal } from "./unhandled-rejection-floor.js";
import { WorkerTreeGitTimeoutError } from "./worker-tree-git-timeout.js";


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

/** Where a task runs (`taskRunPlace`): its task checkout (ADR 0356 決定1).
 *  `reads` are the places outside it opened for reading only, in their real spelling — an Interview root's real
 *  environment and the rooms it may open, or the rooms a review under an Interview root reads. Empty for every other task.
 *  They are places, not paths, so the pickup can bring a remote-backed one to its rest position the same way as the run place
 *  (issue #2223).
 *  `namedPlace` is the named place the task checkout was made from and is released into (ADR 0356 決定1・2) — the
 *  workspace, or the interview room for an Interview root and its examinees: `path` is the task checkout and `name` the
 *  named place's. */
export type RunPlace = WorkspaceConfig & { reads: WorkspaceConfig[]; namedPlace?: WorkspaceConfig };

/** task の checkout で走る場所(ADR 0356 決定1)。 */
type TaskCheckoutPlace = RunPlace & { namedPlace: WorkspaceConfig };

export const isTaskCheckout = (place: WorkspaceConfig): place is TaskCheckoutPlace => (place as RunPlace).namedPlace !== undefined;

/** worker の形で走る process は全部 task の checkout で走る(ADR 0356 決定1)—— 名前の場所に当てる門・解放・写しは無い。 */
function assertTaskCheckout(place: WorkspaceConfig, taskId: string): asserts place is TaskCheckoutPlace {
  if (!isTaskCheckout(place)) throw new Error(`task ${taskId} does not run in a task checkout (${place.path})`);
}

/** 盤面が repo の間で撃つ fetch の共通の旗: FETCH_HEAD に在り処を残さず、submodule を辿らず、auto-gc を撃たない(ADR 0276 決定1 / ADR 0356 決定5)。 */
const FETCH_FLAGS = ["--quiet", "--no-auto-gc", "--no-write-fetch-head", "--no-recurse-submodules"] as const;

export { protectedBranch, protectedBranchRef } from "./pickup-predicates.js";

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
 *  集合は停止の門(tasks.ts の `openedPlaceNamesSql`)が数える名前と同じ —— 受験者は面接室(fetch 元、ADR 0356 決定1)と出題の head、root は
 *  `workspace` 列の実環境と読む面接室と自分の面接室、root 配下の review は実環境と読む面接室、他は実環境。番地は記録があれば event の綴り、
 *  無ければ規約の番地。読む面接室は記録されたものだけなので、面接室の一覧は記録分岐だけを通る。root 自身の面接室は最後に撃つ —— 未記録なら
 *  作る分岐の `mkdir -p` が走るので、読む場所が落ちた root は自分の面接室を作らずに止まる。一覧の組み立ても撃つのと同じ場所の失敗として、
 *  最初に落ちた場所で `PickupGateError` を投げる。 */
export async function pickupGate(db: Db, workspace: WorkspaceConfig, task: Task, workspacesBaseDir: string, registry?: RegistrySource, live?: () => boolean) {
  const room = (rootId: string) => ({
    name: rootId,
    path: interviewRoomPath(db, rootId) ?? conventionCheckoutPath(rootId, workspacesBaseDir),
    predicates: () => roomPickupPredicates(db, rootId, workspacesBaseDir, registry),
  });
  const real = { ...workspace, predicates: () => checkoutPickupPredicates(workspace, registry) };
  const reads = roomsReadBy(db, task).map((read) => room(read.name));
  const rootId = interviewRootIdOf(db, task);
  const places =
    rootId === undefined
      ? [real, ...reads]
      : task.type === "interview"
        ? [real, ...reads, room(rootId)]
        // 出題の head が先 —— 面接室が記録に無い受験者に面接室の作る分岐(`mkdir -p`)を撃たない
        : [{ ...room(rootId), predicates: () => [...examineePickupPredicates(db, task, rootId, workspacesBaseDir), ...roomPickupPredicates(db, rootId, workspacesBaseDir, registry)] }];
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
 *  —— root 配下の review は実環境で走り root の面接室と開ける面接室を読みだけ開く(`roomsReadBy`)。開く前の対(開く場所の列挙)は
 *  `pickupGate`、それが通った後に走る場所が開くので、ここは開いた後しか返せない。 */
export function taskRunPlace(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id" | "parent_id">, workspace: WorkspaceConfig): RunPlace {
  const named = taskNamedPlace(db, task, workspace);
  const path = taskCheckoutPath(db, task.id);
  if (path === undefined) throw new PlaceNotOpenError(`the task checkout of ${task.id} is not open`);
  const reads = interviewRole(db, task) === "root" ? [workspace, ...roomsReadBy(db, task)] : roomsReadBy(db, task);
  return { ...named, path, reads: reads.map(inRealSpelling), namedPlace: named };
}

/** Interview での役(ADR 0273 決定1・2 / ADR 0276): `interview` type の root か、その受験者。work・review は undefined。 */
function interviewRole(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id">): "root" | "examinee" | undefined {
  if (interviewRootIdOf(db, task) === undefined) return undefined;
  return task.type === "interview" ? "root" : "examinee";
}

/** task の checkout を作り、解放で着ける名前の場所(ADR 0356 決定1): task の workspace、interview の root と受験者は面接室。 */
export function taskNamedPlace(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id">, workspace: WorkspaceConfig): WorkspaceConfig {
  const rootId = interviewRootIdOf(db, task);
  if (rootId === undefined) return workspace;
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

/** sandbox が読みだけ開く path: 読む場所と、task の checkout が alternates で借りる名前の場所の objects(ADR 0356 決定2)。
 *  綴りは alternates の中身でなく名前の場所から引く —— worker が書き換えた alternates で読みの面を広げさせない。 */
export function runPlaceReadPaths(place: RunPlace): string[] {
  const borrowed = isTaskCheckout(place) && existsSync(join(place.path, ".git", "objects", "info", "alternates")) ? [namedObjects(place.namedPlace)] : [];
  return [...place.reads.map((read) => read.path), ...borrowed];
}

/** task の checkout の番地に repo を作れない —— 名前の場所の性質ではなく host 側の失敗で、quarantine にしない(ADR 0356 決定2)。 */
export class TaskCheckoutHostError extends Error {}

/** ADR 0356 決定2: pickup ごとに task の checkout を作る。番地は基点 + task id + pickup の event id(ADR 0353 と同じ鍵)なので、
 *  前の session が残した checkout は動かさず再利用もしない。objects は名前の場所から alternates で借り、タスクブランチだけを
 *  fetch して checkout する。Interview の場所は alternates を使わず複製で、自分のブランチだけを引くので兄弟の答案は見えない
 *  (ADR 0356 決定2)。root の番地は面接室(基点 + root id)の外 —— 面接室の内側に checkout を置かない(ADR 0276 決定1)。
 *  開いた event は repo ができた後に書く(ADR 0329)。 */
function openTaskCheckout(db: Db, named: WorkspaceConfig, task: Task, workspacesBaseDir: string, now: Date): void {
  const pickup = latestEventOfTask(db, task.id, "task_picked_up");
  if (!pickup) throw new Error(`task ${task.id} has no pickup to key its task checkout`);
  const branch = taskBranch(task.id);
  // 名前の場所の objects が引けないのは名前の場所の性質 —— host 側の失敗に包まず、呼び手の quarantine へ
  const objects = interviewRole(db, task) === undefined ? namedObjects(named) : undefined;
  let path: string;
  try {
    const at = join(conventionCheckoutPath(interviewRole(db, task) === "root" ? `${task.id}.checkout` : task.id, workspacesBaseDir), String(pickup.id));
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
  appendEvent(db, {
    taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", at: now,
    payload: { kind: "task_checkout_opened", path, ...(completionTreeGateApplies(task) && { completion_gate: "recorded_tip" as const }) },
  });
}

/** ADR 0356 決定2 / ADR 0359 決定5: worker の repo が読めない。完了の解放では観測、todo に戻る解放では task の失敗になる。 */
export class TaskCheckoutUnreadableError extends Error {}

/** ADR 0243 決定1: 書く前に値を知る。ADR 0356 決定3: upload-pack は worker の repo の中で走るが protected config しか読まない。 */
function readWorkerTip({ namedPlace, path: checkout }: TaskCheckoutPlace, taskId: string): string {
  if (!placeHasRepository(checkout)) throw new TaskCheckoutUnreadableError(`the task checkout at ${checkout} has no git repository`);
  const ref = `refs/heads/${taskBranch(taskId)}`;
  let sha: string | undefined;
  try {
    sha = workerRepoGit(namedPlace.path, "ls-remote", checkout, ref).split("\n").map((line) => line.split("\t")).find(([, name]) => name === ref)?.[0];
  } catch (cause) {
    if (cause instanceof WorkerTreeGitTimeoutError) throw cause; // ADR 0357 決定2: 呼び手が worker の repo の故障として扱う
    throw new TaskCheckoutUnreadableError(`the task checkout at ${checkout} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  if (!sha) throw new TaskCheckoutUnreadableError(`the task checkout at ${checkout} has no branch ${taskBranch(taskId)}`);
  return sha;
}

/** task の checkout のタスクブランチの tip を、ref を書かずに名前の場所の objects へ引く(ADR 0356 決定3)。sha は先に `ls-remote` で知る
 *  (ADR 0243 決定1: 書く前に値を知る)—— upload-pack は worker の repo の中で走るが protected config しか読まない。 */
function fetchWorkerTip(place: TaskCheckoutPlace, taskId: string, completedReview = false): string {
  const { namedPlace, path: checkout } = place;
  const ref = `refs/heads/${taskBranch(taskId)}`;
  // 名前の場所の側の故障を worker の repo のせいにしない —— ここで落ちれば素の失敗(呼び手の quarantine)
  git(namedPlace.path, "rev-parse", "--git-dir");
  const sha = readWorkerTip(place, taskId);
  try {
    workerRepoGit(namedPlace.path, "fetch", ...FETCH_FLAGS, checkout, ref);
    git(namedPlace.path, "cat-file", "-e", `${sha}^{commit}`);
  } catch (cause) {
    // 完了済み review の即時の転送の失敗は盤面側の書き込み失敗と区別できず、唯一の写しを消さない(#3053)。
    // ADR 0357 決定2: 上限超過は呼び手が worker の repo の故障として扱う
    if (completedReview || cause instanceof WorkerTreeGitTimeoutError) throw cause;
    throw new TaskCheckoutUnreadableError(`the task checkout at ${checkout} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
  return sha;
}

/** ADR 0359 決定1: worker の tip が名前の場所のタスクブランチになるまで完了の門を通さない。 */
export function recordTaskCheckoutTip(db: Db, place: RunPlace, taskId: string): void {
  assertTaskCheckout(place, taskId);
  const { namedPlace } = place;
  const tip = fetchWorkerTip(place, taskId);
  const ref = `refs/heads/${taskBranch(taskId)}`;
  const old = refValues(git(namedPlace.path, "for-each-ref", "--count=1", REF_SNAPSHOT_FORMAT, ref)).get(ref) ?? "";
  // ADR 0243 決定2 / ADR 0359 決定4: この書き込みの旧値だけを確かめ、帯域外の値を基準に取り込まない
  const expected = recordedRef(db, namedPlace.name, ref);
  if (old.startsWith("symref=") || !baselineAllows(expected, old)) {
    throw new RefsMovedError(`workspace ${namedPlace.name}: ${ref} is not the recorded direct ref (expected ${expected ?? "absent"}, found ${old || "absent"})`);
  }
  if (old === tip) return;
  boardRefWriter(db, namedPlace)(ref, tip, () => git(namedPlace.path, "update-ref", "--no-deref", ref, tip, old));
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

export function taskBranch(taskId: string): string {
  return `task/${taskId}`;
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

/** 出題の写し(ADR 0273 決定3): root の task の checkout の作業ツリーを盤面の view で面接室の objects に tree にし(ADR 0356 決定3・6)、
 *  面接室の保護ブランチの head を親にした盤面名義の commit にして ref を1本置き、その sha を返す。root の `.git` は読まない ——
 *  worker の config・index・hooks は写しに効かない。ignore されたファイルと shadow 残骸は写らない(新しい clone と同じ)。ref は受験者が
 *  fetch する元(ADR 0276 決定1)で、却下された出題の写しも object として残す。 */
export function commitRoomCopy(db: Db, place: RunPlace, taskId: string): string {
  assertTaskCheckout(place, taskId);
  const room = place.namedPlace;
  // view の index の種は worker の tip —— session の最中なのでサンドボックスの shadow 残骸がまだある。tree rule と同じ集合を外す(ADR 0069)
  const tip = fetchWorkerTip(place, taskId);
  const tree = boardWriteTree(place.path, tip, room.path, taskCheckoutSparse(place), taskCheckoutRemnants(place, tip));
  // 受験者の git の履歴に載るので、盤面の語を持たない件名(ADR 0273 決定1)
  const head = git(room.path, "commit-tree", tree, "-p", git(room.path, "rev-parse", protectedBranchRef(room)), "-m", "Add the project files");
  const ref = `refs/keep-around/${head}`;
  boardRefWriter(db, room)(ref, head, () => git(room.path, "update-ref", ref, head));
  return head;
}

/** 「無い」は `rev-parse --verify --quiet` の exit 1 だけ —— 他の失敗は投げる(ADR 0242 決定3)。 */
export function taskBranchExists(workspace: WorkspaceConfig, taskId: string): boolean {
  try {
    git(workspace.path, "rev-parse", "--verify", "--quiet", `refs/heads/${taskBranch(taskId)}`);
    return true;
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return false;
  }
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
  const sparse = checkoutSparsePolicy(workspace, db);
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

/** ADR 0351 決定3 / ADR 0356 決定5: 作成も口を通す plumbing —— 無い行に fork 元の sha を予告する。名前の場所では checkout しない。
 *  受験者は系譜を持たず、面接室の出題の head から切る(ADR 0276 決定1)。 */
function createTaskBranch(db: Db, workspace: WorkspaceConfig, task: Task): void {
  if (taskBranchExists(workspace, task.id)) return;
  const ref = `refs/heads/${taskBranch(task.id)}`;
  const sha = interviewRole(db, task) === "examinee"
    ? resolvablePosedHead(db, workspace, task)
    : git(workspace.path, "rev-parse", `${lineageTaskBranch(db, workspace, task) ?? protectedBranchRef(workspace)}^{commit}`);
  boardRefWriter(db, workspace)(ref, sha, () => git(workspace.path, "update-ref", ref, sha, ""));
}

/** sparse snapshot: 盤面が settings.json を隠す前の人間の sparse-checkout(ADR 0293 決定1)。pattern ファイルの無い
 *  有効な sparse は git にとって全実体化と同じなので「無効」に畳む。 */
type SparseSnapshot = { mode: "disabled"; pattern: string | null } | { mode: "cone" | "no-cone"; pattern: string };

function sparsePatternPath(workspace: WorkspaceConfig): string {
  return resolve(workspace.path, git(workspace.path, "rev-parse", "--git-path", "info/sparse-checkout"));
}

function storedSparseSnapshot(db: Db, workspace: WorkspaceConfig): SparseSnapshot | undefined {
  const row = db
    .prepare("SELECT sparse_snapshot FROM workspace_state WHERE name = ?")
    .get(workspace.name) as { sparse_snapshot: string | null } | undefined;
  return row?.sparse_snapshot ? (JSON.parse(row.sparse_snapshot) as SparseSnapshot) : undefined;
}

/** 盤面しか書かない除外の行(ADR 0293 決定2)。旧い機構の `!.claude/settings.json` は印と読まない(決定7)。 */
const BOARD_SETTINGS_LINE = "!/.claude/settings.json";

const configEnabled = (workspace: WorkspaceConfig, key: string) =>
  git(workspace.path, "config", "--type=bool", "--default=false", "--get", key) === "true";

function readSparsePolicy(workspace: WorkspaceConfig): SparsePolicy | undefined {
  const patternPath = sparsePatternPath(workspace);
  return existsSync(patternPath) && configEnabled(workspace, "core.sparseCheckout")
    ? { pattern: readFileSync(patternPath, "utf8").split("\n").filter((line) => line !== BOARD_SETTINGS_LINE).join("\n"), cone: configEnabled(workspace, "core.sparseCheckoutCone") }
    : undefined;
}

const sparsePolicyFromSnapshot = (snapshot: SparseSnapshot): SparsePolicy | undefined =>
  snapshot.mode === "disabled" ? undefined : { pattern: snapshot.pattern, cone: snapshot.mode === "cone" };

function storedSparsePolicy(db: Db, key: string): SparsePolicy | null | undefined {
  const row = db.prepare("SELECT policy FROM workspace_sparse_policies WHERE name = ?").pluck().get(key) as string | undefined;
  return row === undefined ? undefined : JSON.parse(row) as SparsePolicy | null;
}

const settingsExcluded = (pattern?: string): string => `${(pattern ?? "/*").trimEnd()}\n${BOARD_SETTINGS_LINE}\n`;

function checkoutSparsePolicy(workspace: WorkspaceConfig, db?: Db): SparsePolicy | undefined {
  if (!db) return undefined;
  const pin = storedSparsePolicy(db, workspace.name);
  const snapshot = storedSparseSnapshot(db, workspace);
  if (!snapshot) return pin ?? undefined;
  // ADR 0293 決定3: only the board's stored settings exclusion may add to the pinned policy.
  const base = pin === undefined ? sparsePolicyFromSnapshot(snapshot) : pin;
  return { pattern: settingsExcluded(base?.pattern), cone: false };
}

function describeChanges(changes: WorktreeChange[], separator: string): string {
  return changes.map(({ path, status }) => `${status} ${displayWorktreePath(path)}`).join(separator);
}

/** DB の写しを失った checkout に盤面の行が残っていれば、その行を外した pattern を non-cone の写しと読む(ADR 0293 決定7)。
 *  無効な sparse の行は死んでいるので読まない。探りの失敗(checkout が無い・git repository でない)は「印なし」。
 *  `adopt` は写しとして使う側 —— 隠すか戻すときだけ log に残し、印の問いでは残さない。 */
function snapshotFromBoardLine(workspace: WorkspaceConfig, adopt = false): SparseSnapshot | undefined {
  let lines: string[];
  try {
    if (!configEnabled(workspace, "core.sparseCheckout")) return undefined;
    lines = readFileSync(sparsePatternPath(workspace), "utf8").split("\n");
  } catch {
    return undefined;
  }
  if (!lines.includes(BOARD_SETTINGS_LINE)) return undefined;
  if (adopt) {
    console.error(
      `[workspace] ${workspace.name}: no sparse snapshot is stored, but the board's ${BOARD_SETTINGS_LINE} line is left ` +
        "in the sparse-checkout; taking the other lines as the human's non-cone patterns (cone mode is not restored)",
    );
  }
  return { mode: "no-cone", pattern: lines.filter((line) => line !== BOARD_SETTINGS_LINE).join("\n") };
}

/** 「盤面が settings.json を隠している最中か」の印 —— 写し、無ければ残った盤面の行。S bit は読まない(ADR 0293 決定3)。 */
export function projectSettingsHiddenByBoard(db: Db, workspace: WorkspaceConfig): boolean {
  // ADR 0356 決定2: task の checkout は写しを持たない —— 盤面が作り解放で消すので、戻すものが無い
  const snapshot = isTaskCheckout(workspace) ? undefined : storedSparseSnapshot(db, workspace);
  return (snapshot ?? snapshotFromBoardLine(workspace)) !== undefined;
}

/** task の checkout を読む view の sparse(#3035): 盤面が settings.json を隠したなら、その不在を削除と読まない。人間の pin は名前の場所のもの。 */
function taskCheckoutSparse(place: WorkspaceConfig): SparsePolicy | undefined {
  // worker の走った repo では git を撃たない(ADR 0356 決定3)。worker が書ける file なので通常 file だけを読む —— FIFO で止まらない(ADR 0357)
  const patternPath = join(place.path, ".git", "info", "sparse-checkout");
  try {
    if (!lstatSync(patternPath).isFile() || !readFileSync(patternPath, "utf8").split("\n").includes(BOARD_SETTINGS_LINE)) return undefined;
  } catch {
    return undefined;
  }
  return { pattern: settingsExcluded(), cone: false };
}

/** Keep shared project settings (ADR 0158) in Git but out of the worker's physical checkout:
 *  the human's own sparse patterns plus one non-cone exclusion line (ADR 0293 決定2), so the
 *  worker never sees more than the human's checkout does. The worker's Git env preserves the
 *  sparse S bit despite the sandbox's settings stub (ADR 0037 機構2); sparse-checkout alone cannot. */
export function excludeWorkspaceProjectSettings(db: Db, workspace: WorkspaceConfig): void {
  // 写しは DB に無いときだけ撮る —— 回収前の2本目が盤面の形を人間の状態として写さない(ADR 0293 決定1)。
  // 残った盤面の行から読んだ写しも DB に写す —— この session の回収が worker の書いた pattern を読み直さない(決定7)
  // ADR 0356 決定2: task の checkout は盤面が作って解放で消すので、写しを撮らず盤面の行だけを書く
  let snapshot = isTaskCheckout(workspace) ? { mode: "disabled" as const, pattern: null } : storedSparseSnapshot(db, workspace);
  if (!snapshot) {
    snapshot = snapshotFromBoardLine(workspace, true);
    if (!snapshot) {
      const patternPath = sparsePatternPath(workspace);
      const pattern = existsSync(patternPath) ? readFileSync(patternPath, "utf8") : null;
      snapshot =
        pattern === null || !configEnabled(workspace, "core.sparseCheckout")
          ? { mode: "disabled", pattern }
          : { mode: configEnabled(workspace, "core.sparseCheckoutCone") ? "cone" : "no-cone", pattern };
    }
    db.prepare(
      `INSERT INTO workspace_state (name, sparse_snapshot) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET sparse_snapshot = excluded.sparse_snapshot`,
    ).run(workspace.name, JSON.stringify(snapshot));
  }
  gitWithInput(settingsExcluded(sparsePolicyFromSnapshot(snapshot)?.pattern), workspace.path, "sparse-checkout", "set", "--no-cone", "--stdin");
  if (lstatSync(join(workspace.path, ".claude", "settings.json"), { throwIfNoEntry: false })) {
    throw new Error(
      `workspace ${workspace.name}: could not exclude .claude/settings.json: it has uncommitted changes, which sparse-checkout keeps in the tree — commit or revert them`,
    );
  }
  // このファイルだけを見る: tracked な settings.json を持つ repo はすべてここを通るので(ADR 0346 決定2)、無関係な untracked で止めない
  if (git(workspace.path, "diff-index", "--cached", "--name-only", "HEAD", "--", ".claude/settings.json") !== "") {
    throw new Error(
      `workspace ${workspace.name}: .claude/settings.json has staged changes, which hiding it would leave in the index — commit or unstage them`,
    );
  }
}

/** Put the human's sparse-checkout back from the snapshot when no worker owns the checkout, and
 *  let git itself write the mode (cone lives in config.worktree — ADR 0293 決定4). The snapshot
 *  is dropped only after git succeeded and no tracked settings are missing; a failure throws for the caller to quarantine. */
export function materializeWorkspaceProjectSettings(db: Db, workspace: WorkspaceConfig): void {
  const snapshot = storedSparseSnapshot(db, workspace) ?? snapshotFromBoardLine(workspace, true);
  if (!snapshot) return;
  const patternPath = sparsePatternPath(workspace);
  if (snapshot.mode === "disabled") {
    git(workspace.path, "sparse-checkout", "disable");
    // disable は盤面の pattern を残す —— 人間のファイルがあればそれに、無ければ消す
    if (snapshot.pattern === null) rmSync(patternPath, { force: true });
    else writeFileSync(patternPath, snapshot.pattern);
  } else {
    // set は session 中に外された sparse も有効に戻す(reapply は無効な checkout を拒む)。set は pattern を書き直すので、
    // 人間のファイルをそのまま書き戻してから mode ごと git に当てさせる
    gitWithInput(snapshot.pattern, workspace.path, "sparse-checkout", "set", "--no-cone", "--stdin");
    writeFileSync(patternPath, snapshot.pattern);
    git(workspace.path, "sparse-checkout", "reapply", snapshot.mode === "cone" ? "--cone" : "--no-cone");
  }
  // ADR 0293 決定6: Git can report success while assume-unchanged leaves the human's settings absent.
  if (git(workspace.path, "ls-files", "-d", "--", ".claude/settings.json") !== "") {
    throw new Error(
      `workspace ${workspace.name}: .claude/settings.json was not restored. In the workspace, run ` +
        "`git update-index --no-assume-unchanged --no-skip-worktree -- .claude/settings.json` and " +
        "`git checkout -- .claude/settings.json` to clear the index flags and restore it, then retry workspace recovery",
    );
  }
  dropSparseSnapshot(db, workspace.name);
}

const dropSparseSnapshot = (db: Db, key: string) =>
  db.prepare("UPDATE workspace_state SET sparse_snapshot = NULL WHERE name = ?").run(key);

/** Recover a sparse exclusion left by a previous board process — each listed workspace whose name
 *  still has a snapshot, or whose checkout still carries the board's line (ADR 0293 決定3 / 決定7),
 *  then every other key with a snapshot: an interview room (issue #2379).
 *  The caller must first prove that the old container set is empty;
 *  otherwise restoring settings would expose them to a process that survived the restart. */
export function restoreWorkspaceProjectSettingsAtBoot(
  db: Db,
  listWorkspaces: () => WorkspaceConfig[],
  now: Date,
): void {
  let workspaces: WorkspaceConfig[];
  try {
    workspaces = listWorkspaces();
  } catch (err) {
    console.error(
      "[workspace] could not enumerate registered workspaces for project-settings recovery; " +
        `shared project settings may remain hidden (${String(err)})`,
    );
    return;
  }
  const registered = new Set(workspaces.map((workspace) => workspace.name));
  const places = [...workspaces];
  const keys = db.prepare("SELECT name FROM workspace_state WHERE sparse_snapshot IS NOT NULL").pluck().all() as string[];
  for (const key of keys.filter((key) => !registered.has(key))) {
    const place = recordedPlaceOf(db, key);
    if (!place) {
      console.error(`[workspace] ${key}: a sparse snapshot is stored, but no interview room is recorded under it; leaving it`);
      continue;
    }
    // 写しは checkout が開いた後にしか書かれない —— 無ければ人間が記録の checkout を消した形で、戻すものが無い(ADR 0276 決定4)
    if (!placeHasRepository(place.path)) {
      dropSparseSnapshot(db, key);
      console.error(`[workspace] ${key}: the checkout at ${place.path} is gone; dropping its sparse snapshot`);
      continue;
    }
    places.push(place);
  }
  for (const workspace of places) {
    try {
      materializeWorkspaceProjectSettings(db, workspace);
    } catch (err) {
      if (isBoardDbRefusal(err)) throw err; // ADR 0342 決定4: quarantine も同じ器に書くので、書かずに底へ
      quarantineWorkspace(db, workspace.name, err, now);
    }
  }
}

/** 写しの鍵を registry 外の場所へ解く: 面接室(名前 = 鍵 = root id、ADR 0273 決定8)。受験者は task の checkout で走るので写しを持たない(ADR 0356 決定2)。 */
function recordedPlaceOf(db: Db, key: string): WorkspaceConfig | undefined {
  return recordedInterviewRoom(db, key);
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
  const snapshot = pin === undefined ? storedSparseSnapshot(db, workspace) : undefined;
  // ADR 0356 決定3: an existing checkout without a pin may already carry worker-written rules.
  const policy = snapshot ? sparsePolicyFromSnapshot(snapshot) : first && pin === undefined ? readSparsePolicy(workspace) : undefined;
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

/** ADR 0351 決定7: 行の寿命は workspace の寿命 —— 削除の扉が基準と sparse の写しの行ごと消す。残すと同名を別 path で登録し直したとき
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

function readRef(workspace: WorkspaceConfig, ref: string): string {
  try {
    return git(workspace.path, "rev-parse", "--verify", "--quiet", ref);
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
 *  tracked は worker の index でなく名前の場所のタスクブランチの tip で読む(ADR 0356 決定3)。 */
function taskCheckoutRemnants(place: TaskCheckoutPlace, tip: string): string[] {
  return SANDBOX_SHADOW_PATHS.filter((path) => {
    const stat = lstatSync(join(place.path, path), { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size !== 0) return false;
    return git(place.namedPlace.path, "ls-tree", "--name-only", tip, "--", path) === "";
  });
}

/** task の checkout の worktree を、名前の場所のタスクブランチの tip に対して盤面の view だけで読む(ADR 0356 決定3)。shadow 残骸は除く。 */
function taskCheckoutChanges(place: TaskCheckoutPlace, tip: string): WorktreeChange[] {
  const remnants = new Set(taskCheckoutRemnants(place, tip));
  return boardViewStatus(place.path, tip, place.namedPlace.path, taskCheckoutSparse(place)).filter(({ path }) => !remnants.has(path));
}

/** ADR 0359 決定1: task の checkout の観測が落ちれば門を通さない。work は全部 task の checkout で走る(ADR 0356 決定1)。 */
export function completionTreePaths(workspace: WorkspaceConfig, taskId: string): string[] {
  assertTaskCheckout(workspace, taskId);
  const tip = git(workspace.namedPlace.path, "rev-parse", "--verify", `refs/heads/${taskBranch(taskId)}`);
  return taskCheckoutChanges(workspace, tip).map(({ path }) => path);
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
function observeCheckoutAfterCompletion(place: TaskCheckoutPlace, taskId: string, recorded: string | undefined): TaskCheckoutWriteObservation | undefined {
  try {
    const workerTip = readWorkerTip(place, taskId);
    if (!recorded) return;
    if (workerTip !== recorded) return { observation: "committed", worker_tip: workerTip };
    const paths = taskCheckoutChanges(place, recorded).map(({ path }) => path);
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
 *  the caller skips the workspace step entirely, not just resolution. */
export type WorkspaceResolver = (taskWorkspace: string | null) => WorkspaceConfig;

export function buildWorkspaceResolver(
  resolveWorkspace: WorkspaceResolver | undefined,
  workspace: WorkspaceConfig | undefined,
): WorkspaceResolver | undefined {
  return resolveWorkspace ?? (workspace && (() => workspace));
}

/** The shared shape behind every async, board-driven use of a task's
 *  execution workspace (issue #26 / ADR 0009: pickup, release, watchdog,
 *  restart) — `resolve` throwing `UnknownWorkspaceError` (registry drift)
 *  never escapes to the caller; it quarantines the name in its place and the
 *  caller treats the workspace step as absent for this cycle. A human's own
 *  synchronous request (registration, a quarantine/merge answer) is not this
 *  seam — those fail fast with a DomainError instead (ADR 0009). `onStop` は止めた資源を pickup の呼び手へ渡す(ADR 0274)。 */
export function resolveOrQuarantine(
  db: Db,
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  taskWorkspace: string | null,
  now: Date,
  onStop?: (stop: ResourceStop) => void,
): WorkspaceConfig | undefined {
  try {
    return resolve(taskWorkspace);
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    const stop = quarantineWorkspace(db, err.workspaceName, err, now);
    onStop?.(stop);
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

/** 解放の名前の場所の側の後半: タスクブランチの行を畳み、完了なら帰り先へ merge back し、休止位置へ戻す。 */
function settleBranches(db: Db, workspace: WorkspaceConfig, task: Task, mergeBack: boolean, githubAuth: GitHubAuth | undefined, tokenFailure: unknown, recordedTip?: string): void {
  // ADR 0359 決定2・4: 完了の基準比較が済んだ ref を読み直して、帯域外の値を基準に畳んだり merge back に運んだりしない
  if (recordedTip === undefined) {
    const taskRef = `refs/heads/${taskBranch(task.id)}`;
    // ADR 0351 決定2: 退避したタスクブランチの行を現在値へ畳む
    updateBaseline(db, workspace, (values) => values.set(taskRef, readRef(workspace, taskRef)));
  }
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

/** ADR 0356 決定2 / ADR 0359 決定2・5: 名前の場所を決着させてから `task_checkout_released` を刻み、checkout を消す。
 *  刻みがあれば削除だけを撃つ。削除の失敗は後始末の再実行が撃ち直す。 */
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
  const checkout = place.path;
  if (latestEventOfTask(db, task.id, "task_checkout_released")?.payload.path !== checkout) {
    if (!settleTaskCheckout(db, place, task, now, mergeBack, githubAuth, tokenFailure, completed)) return;
    // ADR 0276 決定4: 決着した受験者の最後の checkout は記録として残る —— 消さず、解放済みとも刻まない(再実行は同じ決着を撃ち直す)
    const current = getTask(db, task.id)!;
    if (interviewRole(db, current) === "examinee" && isSettled(current.status)) return;
    appendEvent(db, { taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind: "task_checkout_released", path: checkout }, at: now });
  }
  rmSync(checkout, { recursive: true, force: true, maxRetries: 3 });
  try {
    rmdirSync(dirname(checkout));
  } catch (err) {
    // 同じ task の残した checkout が並ぶ親は残す
    if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
  }
}

/** 解放の削除より前の全部。tip と WIP が名前の場所の ref になり名前の場所の側が済めば true、失敗を記録したら false。 */
function settleTaskCheckout(
  db: Db,
  place: TaskCheckoutPlace,
  task: Task,
  now: Date,
  mergeBack: boolean,
  githubAuth: GitHubAuth | undefined,
  tokenFailure: unknown,
  completed: boolean,
): boolean {
  const { namedPlace, path: checkout } = place;
  const taskRef = `refs/heads/${taskBranch(task.id)}`;
  // ADR 0359 決定2: 門の掛かる完了は、名前の場所に既に記録された tip を運ぶ
  const gated = completed && completionTreeGateApplies(task);
  let wipTree: { base: string; tree: string } | undefined;
  let observation: TaskCheckoutWriteObservation | undefined;
  try {
    if (gated) {
      // ADR 0359 決定3・4: 名前の場所の帯域外の値と比べず、checkout の観測と基準比較を独立に行う
      const candidates = baselineValues(recordedRef(db, namedPlace.name, taskRef));
      const current = readRef(namedPlace, taskRef);
      const recorded = candidates.length === 1 ? candidates[0] : candidates.find((tip) => tip === current);
      observation = observeCheckoutAfterCompletion(place, task.id, recorded);
      // ADR 0359 決定1: 旧版の完了では tip が記録にあるとは限らない。確認できなければ checkout を残す
      const opened = latestEventOfTask(db, task.id, "task_checkout_opened")?.payload;
      if (opened?.path !== checkout || opened.completion_gate !== "recorded_tip") {
        if (!recorded || observation?.observation === "committed" || observation?.observation === "unreadable") {
          throw new Error(
            `The task completed under an earlier board version and its recorded tip could not be verified against the task checkout at ${checkout}. ` +
            "Inspect the retained checkout and restore the intended completion tip before answering.",
          );
        }
      }
    } else {
      const tip = fetchWorkerTip(place, task.id, completed);
      const recorded = readRef(namedPlace, taskRef);
      const base = recorded !== "" && isAncestor(namedPlace, tip, recorded) ? recorded : tip;
      let tree: string;
      try {
        tree = boardWriteTree(checkout, base, namedPlace.path, taskCheckoutSparse(place), taskCheckoutRemnants(place, base));
      } catch (cause) {
        if (completed) throw cause; // 完了済み review の即時の退避の失敗は盤面側の書き込み失敗と区別できず、唯一の写しを消さない(#3053)
        throw new TaskCheckoutUnreadableError(`the worktree of the task checkout at ${checkout} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
      }
      wipTree = { base, tree };
    }
  } catch (err) {
    if (isBoardDbRefusal(err)) throw err; // ADR 0342 決定4: quarantine も同じ器に書くので、書かずに底へ
    // ADR 0357 決定2: 上限超過は worker の repo の故障 —— 名前の場所を quarantine しない
    if (!(err instanceof TaskCheckoutUnreadableError || err instanceof WorkerTreeGitTimeoutError)) {
      quarantineWorkspace(db, namedPlace.name, err, now);
      return false;
    }
    if (!completed) {
      failTaskOnRelease(db, task, checkout, err, now);
      return false;
    }
    // ADR 0359 決定5: review の完了でも checkout が読めなければ観測を残して解放する
    observation = { observation: "unreadable", reason: err.message };
  }
  // ADR 0345 決定1: `task_checkout_released` を刻む前に止まっても、同じ checkout の観測を重ねない
  if (observation && latestEventOfTask(db, task.id, "task_checkout_written_after_completion")?.payload.path !== checkout) {
    appendEvent(db, {
      taskId: task.id, actorId: BOARD_ACTOR_ID, origin: "board",
      payload: { kind: "task_checkout_written_after_completion", path: checkout, ...observation }, at: now,
    });
  }
  try {
    if (wipTree) {
      const { base, tree } = wipTree;
      const tip = tree === git(namedPlace.path, "rev-parse", `${base}^{tree}`) ? base : git(namedPlace.path, "commit-tree", tree, "-p", base, "-m", wipSubject(task));
      const old = readRef(namedPlace, taskRef);
      if (old !== tip) boardRefWriter(db, namedPlace)(taskRef, tip, () => git(namedPlace.path, "update-ref", taskRef, tip, old));
    }
    // ADR 0064 決定5 / ADR 0356 決定4: 基準は名前の場所だけが持ち、task の checkout の ref の移動は読まない。HEAD も比べる ——
    // 盤面は名前の場所の HEAD を動かさない(ADR 0356 決定1)ので、session の間の HEAD の移動は人間の書き込み(ADR 0351)
    const verifiedRefs = compareAndFoldBaseline(db, namedPlace, gated ? [] : [taskRef], "during the session");
    const recordedTip = gated ? verifiedRefs.get(taskRef) : undefined;
    if (gated) {
      if (!recordedTip) throw new Error(`workspace ${namedPlace.name}: the recorded task ref ${taskRef} is missing`);
      // ADR 0359 決定3: worker の観測で index を作らなかった場合も、名前の場所の tree が壊れていれば checkout を残す
      if (observation?.observation === "committed" || observation?.observation === "unreadable") {
        git(namedPlace.path, "ls-tree", "-r", "--format=%(objectmode)", recordedTip);
      } else {
        git(namedPlace.path, "cat-file", "-e", `${recordedTip}^{tree}`);
      }
    }
    settleBranches(db, namedPlace, task, mergeBack, githubAuth, tokenFailure, recordedTip);
  } catch (err) {
    if (isBoardDbRefusal(err)) throw err; // ADR 0342 決定4: quarantine も同じ器に書くので、書かずに底へ
    quarantineWorkspace(db, namedPlace.name, err, now);
    return false;
  }
  return true;
}

/** ADR 0356 決定2: 残った task の checkout を failure question が言う文 —— 中身はタスクブランチに無く、retry は新しい checkout で走る。 */
export const KEPT_TASK_CHECKOUT = {
  beyondBranch: "what it holds beyond the task branch is not on the task branch.",
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
      `${reason}\n\nThe board kept the task checkout at ${path}: ${KEPT_TASK_CHECKOUT.beyondBranch}`,
      now,
      KEPT_TASK_CHECKOUT.retry,
    );
  })();
}

/** ADR 0356 決定5: merge back advances the target ref without switching branches. A conflict leaves
 *  the checkout in place and reports the same repair options to teardown and quarantine acceptance (ADR 0239 帰結 / ADR 0240 決定4). */
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
function isAncestor(workspace: WorkspaceConfig, ancestor: string, descendant: string): boolean {
  try {
    git(workspace.path, "merge-base", "--is-ancestor", ancestor, descendant);
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
