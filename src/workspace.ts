import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BOARD_ACTOR_ID } from "./actor-id.js";
import type { Db } from "./db.js";
import { appendEvent, type ResourceStop } from "./events.js";
import { git, gitWithEnv, gitWithInput } from "./git.js";
import {
  authedGitBounded,
  GIT_NETWORK_TIMEOUT_MS,
  type GitHubAuth,
  originRepo,
} from "./github-auth.js";
import { openQuarantineQuestion, registerQuarantine } from "./quarantine.js";
import {
  fetchBranchCopy,
  fetchCommit,
  ownEntry,
  REGISTRY_BRANCH,
  type RefWriter,
  type Registry,
  type RegistrySource,
  remoteTrackingRef,
  type WorkspaceEntry,
} from "./registry.js";
import { SANDBOX_SHADOW_PATHS } from "./sandbox.js";
import { isSettled } from "./task-status.js";
import {
  carriesReadOnly,
  examineeCheckoutPath,
  getTask,
  interviewRoomPath,
  interviewRootIdOf,
  issueRefPlaceholder,
  readableInterviewRooms,
  type Task,
} from "./tasks.js";

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

/** Where a task runs (`taskRunPlace`): its workspace, the interview room for an Interview root, or an examinee's own checkout.
 *  `reads` are the places outside it opened for reading only, in their real spelling — an Interview root's real
 *  environment and the rooms it may open, or the rooms a review under an Interview root reads. Empty for every other task.
 *  They are places, not paths, so the pickup can bring a remote-backed one to its rest position the same way as the run place
 *  (issue #2223).
 *  `snapshot_key` keys the ADR 0064 ref snapshot when it is not `name` — an examinee's checkout, named after its room
 *  (ADR 0276 決定3). */
export type RunPlace = WorkspaceConfig & { reads: WorkspaceConfig[]; snapshot_key?: string };

/** The protected branch: no task ever works on it directly. */
const MAIN_BRANCH = "main";

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

/** ADR 0023: `branch` is a reference resolved fresh at every use, same
 *  posture as `resolveExecutionWorkspace` itself — never pinned to what a
 *  task branch actually forked from. */
export function protectedBranch(workspace: WorkspaceConfig): string {
  return workspace.branch ?? MAIN_BRANCH;
}

/** ADR 0052 決定3: この workspace が remote の正本を持つと**宣言している**か。
 *  clone を覗く関数ではない —— `repo` の有無だけを読む。 */
export function isRemoteBacked(workspace: WorkspaceConfig): boolean {
  return workspace.repo !== undefined;
}

/** 盤面が保護ブランチを**参照として**読むときの1つの ref —— remote 正本を宣言した
 *  workspace ではリモート側の remote-tracking ref、そうでなければローカルの同名
 *  ブランチ(`registryRef(mode)` の workspace 側の対、綴りは `remoteTrackingRef` を
 *  共有する)。
 *
 *  `protectedBranch` の返す**名前**とは役が違う: PR の base や直接書き込み禁止の
 *  対象はリモートのブランチ名そのものなので今も名前を使い、「今この保護ブランチは
 *  どのコミットか」を訊く側だけがこの ref を使う(タスクブランチの fork 元、
 *  slot 解放後の休止位置の追従先、完了時の未着地 commit 比較)。 */
export function protectedBranchRef(workspace: WorkspaceConfig): string {
  const branch = protectedBranch(workspace);
  return isRemoteBacked(workspace) ? remoteTrackingRef(branch) : branch;
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

export class GitDirNotADirectoryError extends Error {
  constructor(path: string) {
    super(`${join(path, ".git")} is not a directory — linked worktrees and submodules cannot be workspaces`);
    this.name = "GitDirNotADirectoryError";
  }
}

export class NoOwnGitDirError extends Error {
  constructor(path: string, toplevel: string) {
    super(`${path} has no .git of its own — it is a subdirectory of the repository at ${toplevel} and cannot be a workspace`);
    this.name = "NoOwnGitDirError";
  }
}

/** ADR 0146: workspace の checkout は `.git` をディレクトリに持つ。`.git` が存在して
 *  ディレクトリでない checkout(linked worktree・submodule)は stat の形だけで拒む。
 *  `.git` が無いパスは、git が外側の repo の作業ツリーとして解決するとき(部分ディレクトリ、
 *  ADR 0146 追記 / issue #1964)だけ拒む —— 放せば git 操作が親 repo 全体に効く。
 *  どの repo にも属さないパスは何もせず、今日どおり各門の git 側の失敗で落ちる。作業ツリーを
 *  持たない bare repo も素通りし、今日の扱いのまま。pickup・修理確認・登録の3つの門がこの1つを共有する。 */
export function assertOwnGitDirectory(path: string): void {
  const stat = statSync(join(path, ".git"), { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new GitDirNotADirectoryError(path);
  if (stat) return;
  let toplevel: string;
  try {
    toplevel = git(path, "rev-parse", "--show-toplevel");
  } catch {
    return;
  }
  throw new NoOwnGitDirError(path, toplevel);
}

/** ADR 0009: `task.workspace` is a reference to a registry name, resolved
 *  fresh against the registry every time it's used, never pinned to a path.
 *  Null — a task never picked up, since pickup writes the default's name
 *  (ADR 0233) — inherits the board's default (CONTEXT.md's Workspace). `workspacesBaseDir`
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

/** ADR 0273 決定1: 面接室を root の pickup で開く —— 盤面の規約の基点の下に root の id の名前で作り、在り処を root の event に残してから
 *  `git init` と盤面名義の空コミットを置く。在り処が git の手順より先に残るので、git の途中で落ちた面接室も
 *  次の pickup は残った repo の続きから作る。registry には載せない。消さない(消す扉も無い)。 */
export function openInterviewRoom(db: Db, root: Task, workspacesBaseDir: string, now: Date): void {
  const path = interviewRoomPath(db, root.id) ?? recordOpened(db, root.id, "interview_room_opened", workspacesBaseDir, now);
  // 既存の repo への init は何も変えない(HEAD も残る)
  git(path, "init", "--quiet", "--initial-branch=main");
  // 受験者の git の履歴に載るので、盤面の語を持たない件名(ADR 0273 決定1)
  if (readRef({ name: root.id, path }, "HEAD") === "") git(path, "commit", "--quiet", "--allow-empty", "-m", "Initial commit");
}

/** ADR 0276 決定1: 受験者の checkout を pickup で開く —— 面接室の外(規約の基点の下の受験者の id)に作り、在り処を受験者の event に
 *  残してから(面接室と同じ順: git の途中で落ちても次の pickup がこの在り処で引ける)、出題の head を面接室で引き、`git init` して
 *  面接室からその head だけを fetch し `main` にする(`clone` は root のブランチごと運ぶ)。タスクブランチは準備が `main` から切る。
 *  再開(タスクブランチがある)は何もしない —— 自分の WIP も ignored の生成物も残る。消さない(面接室と同じ、ADR 0276 決定4)。 */
export function openExamineeCheckout(db: Db, examinee: Task, workspacesBaseDir: string, now: Date): void {
  const rootId = interviewRootIdOf(db, examinee);
  if (rootId === undefined) throw new Error(`${examinee.id} is not an examinee of an Interview`);
  const room = recordedInterviewRoom(db, rootId);
  if (!room) throw new Error(`the interview room of ${rootId} is not open`);
  const opened = examineeCheckoutPath(db, examinee.id);
  // repo の無い在り処(前の pickup が init の前に落ちた)で rev-parse を撃つと「無い」ではなく失敗になる
  if (opened !== undefined && existsSync(join(opened, ".git")) && taskBranchExists({ ...room, path: opened }, examinee.id)) return;
  const path = opened ?? recordOpened(db, examinee.id, "examinee_checkout_opened", workspacesBaseDir, now);
  const head = resolvablePosedHead(db, room, examinee);
  git(path, "init", "--quiet", "--initial-branch=main");
  // FETCH_HEAD は fetch 元(面接室の在り処 = root の id)を書くので書かせない —— 受験者の `.git` に面接室を残さない(ADR 0276 決定1)
  git(path, "fetch", "--quiet", "--no-write-fetch-head", room.path, head);
  // 未生の `main` に ref だけ書くと index が空のまま残る —— checkout で作業ツリーごと置く
  git(path, "checkout", "--quiet", "-B", MAIN_BRANCH, head);
}

/** 面接室・受験者の checkout の在り処を規約の基点の下の task の id に作り、実体の綴りで task の event に残す —— cwd・sandbox の読み・
 *  root に渡す在り処が同じ綴りになる(issue #1954)。git の手順より先に残すので、git の途中で落ちても次の pickup がこの在り処で引ける。
 *  mkdir で落ちれば event は無い —— quarantine の回答の検査は event でなく基点と task の id から番地を導く。 */
function recordOpened(db: Db, taskId: string, kind: "interview_room_opened" | "examinee_checkout_opened", workspacesBaseDir: string, now: Date): string {
  const at = conventionCheckoutPath(taskId, workspacesBaseDir);
  mkdirSync(at, { recursive: true });
  const path = realpathSync(at);
  appendEvent(db, { taskId, actorId: BOARD_ACTOR_ID, origin: "board", payload: { kind, path }, at: now });
  return path;
}

/** 在り処が残った面接室を走る場所として(ADR 0273 決定1・8)。名前は root の id で、quarantine・封じ込めの組・ref の基準はこの名前で立つ。 */
export function recordedInterviewRoom(db: Db, rootId: string): WorkspaceConfig | undefined {
  const path = interviewRoomPath(db, rootId);
  return path === undefined ? undefined : { name: rootId, path };
}

/** 読む場所のうち、在り処に repo の無い記録された面接室(ADR 0277 追記 決定1)。名前が開いた event を持つ root の id なら面接室で、
 *  述語は起動時の sparse snapshot の掃除と同じ `.git` の有無。盤面は面接室を消さないので、外で消されたものである。 */
export function readOnlyRoomWithoutRepo(db: Db, reads: readonly WorkspaceConfig[]): WorkspaceConfig | undefined {
  return reads.find((read) => interviewRoomPath(db, read.name) !== undefined && !existsSync(join(read.path, ".git")));
}

/** task が走る場所(ADR 0273 決定1・8 / ADR 0276 決定1・3): interview の root は面接室、受験者は自分の checkout(名前は面接室の
 *  root id、ref の基準の鍵だけ受験者の id)、他は task の workspace。許可ドメインと層は呼び手が
 *  実環境の `workspace` から読み、root は実環境と開ける面接室を読みだけ開く。付帯子の review は親の読みの面を継ぐ(ADR 0273 決定4)
 *  —— review の親をたどって Interview の root に着く review(監査、root や監査の行への異議の RCA、人間登録の review 子)は、実環境で
 *  走り root の面接室と開ける面接室を読みだけ開く。門の側の対(開く場所の名前)は tasks.ts の `openedPlaceNamesSql`。 */
export function taskRunPlace(db: Db, task: Pick<Task, "id" | "type" | "interview_target_id" | "parent_id">, workspace: WorkspaceConfig): RunPlace {
  const rootId = interviewRootIdOf(db, task);
  if (rootId === undefined) {
    let parent = task.type === "review" && task.parent_id !== null ? getTask(db, task.parent_id) : undefined;
    while (parent?.type === "review" && parent.parent_id !== null) parent = getTask(db, parent.parent_id);
    if (parent?.type !== "interview") return { ...workspace, reads: [] };
    const room = recordedInterviewRoom(db, parent.id);
    return { ...workspace, reads: [...(room ? [room] : []), ...readableInterviewRooms(db, parent.id)].map(inRealSpelling) };
  }
  if (task.type !== "interview") {
    const place = examineeRunPlace(db, task.id, rootId);
    if (!place) throw new PlaceNotOpenError(`the checkout of ${task.id} is not open`);
    return place;
  }
  const room = recordedInterviewRoom(db, rootId);
  if (!room) throw new PlaceNotOpenError(`the interview room of ${rootId} is not open`);
  return { ...room, reads: [workspace, ...readableInterviewRooms(db, rootId)].map(inRealSpelling) };
}

/** 受験者の走る場所(ADR 0276 決定1・3): 自分の checkout、名前は面接室の root id、ref の基準の鍵だけ受験者の id。開いていなければ undefined。 */
function examineeRunPlace(db: Db, examineeId: string, rootId: string): RunPlace | undefined {
  const path = examineeCheckoutPath(db, examineeId);
  return path === undefined ? undefined : { name: rootId, path, reads: [], snapshot_key: examineeId };
}

/** 読む場所を実体の綴りで —— sandbox の読みの path と cwd・root に渡す在り処が同じ綴りになる(issue #1954)。 */
const inRealSpelling = (place: WorkspaceConfig): WorkspaceConfig => ({ ...place, path: safeRealpath(place.path) });

/** ADR 0018 in one place: an entry's own `path`, or — when it omits one — the
 *  convention-derived location under the base dir. Every consumer that has to
 *  know where a workspace's checkout lives goes through this, so the rule never
 *  gets a second spelling (the board-state overlap gate judges a *prospective*
 *  entry with `conventionCheckoutPath` below, which is the same rule with no
 *  entry to consult yet). */
export function entryCheckoutPath(
  entry: WorkspaceEntry,
  name: string,
  workspacesBaseDir: string,
): string {
  return entry.path ?? conventionCheckoutPath(name, workspacesBaseDir);
}

export function conventionCheckoutPath(name: string, workspacesBaseDir: string): string {
  return join(workspacesBaseDir, name);
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
  try {
    return git(workspace.path, "merge-tree", "--write-tree", left, right);
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

/** 出題の写し(ADR 0273 決定3): 面接室の作業ツリーを一時 index で tree にし、保護ブランチの head を親にした盤面名義の commit にして
 *  ref を1本置き、その sha を返す。root の session の HEAD・作業ツリー・本物の index には触れない(ADR 0064)。ignore されたファイルと
 *  shadow 残骸は写らない(新しい clone と同じ)。ref は受験者が fetch する元(ADR 0276 決定1)で、却下された出題の写しも object として残す。 */
export function commitRoomCopy(db: Db, room: WorkspaceConfig): string {
  const dir = mkdtempSync(join(tmpdir(), "tidepool-room-index-"));
  let tree: string;
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    // session の最中なのでサンドボックスの shadow 残骸がまだある —— tree rule と dirty 判定と同じ集合を外す(ADR 0069)
    gitWithEnv(env, room.path, "add", "--all", "--", ".", ...shadowRemnants(room).map((path) => `:(exclude,literal)${path}`));
    tree = gitWithEnv(env, room.path, "write-tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

/** Branch discipline at pickup: work never happens on the protected branch.
 *  A fresh task forks from its live lineage — an examinee, with no lineage, from its own checkout's `main`, which is the
 *  head its probe recorded (ADR 0276 決定1); a resumed task only checks its existing branch out again, WIP intact. */
export function ensureTaskBranch(db: Db, workspace: WorkspaceConfig, task: Task): void {
  const branch = taskBranch(task.id);
  if (!taskBranchExists(workspace, task.id)) {
    git(workspace.path, "branch", branch, lineageTaskBranch(db, workspace, task) ?? protectedBranchRef(workspace));
  }
  git(workspace.path, "checkout", branch);
}

/** 引けない head から黙って今の head へ逃げない —— 投げて受験者の checkout を開く失敗(面接室の quarantine)に落とす。 */
function resolvablePosedHead(db: Db, workspace: WorkspaceConfig, task: Task): string {
  // 出題の event は受験者 → 対象 → root から引く(ADR 0267 決定5)。出題し直した root は最後の出題(ADR 0273 決定3)
  const head = db
    .prepare(
      `SELECT json_extract(e.payload, '$.head') FROM events e JOIN interview_targets it ON it.task_id = e.task_id
       WHERE it.id = ? AND e.kind = 'decision_logged' AND json_extract(e.payload, '$.interview_probe') IS NOT NULL
       ORDER BY e.id DESC LIMIT 1`,
    )
    .pluck()
    .get(task.interview_target_id) as string;
  try {
    return git(workspace.path, "rev-parse", "--verify", "--quiet", `${head}^{commit}`);
  } catch (err) {
    // 「引けない」は exit 1 だけ —— 他の失敗はそのまま投げる(ADR 0242 決定3、taskBranchExists と同じ)
    if ((err as { status?: number } | null)?.status !== 1) throw err;
  }
  throw new Error(
    `workspace ${workspace.name}: the protected branch head the probe recorded for ${task.id} (${head}) ` +
      "cannot be resolved in this checkout, so its branch is not forked",
  );
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
    .get(snapshotKey(workspace)) as { sparse_snapshot: string | null } | undefined;
  return row?.sparse_snapshot ? (JSON.parse(row.sparse_snapshot) as SparseSnapshot) : undefined;
}

/** 盤面しか書かない除外の行(ADR 0293 決定2)。旧い機構の `!.claude/settings.json` は印と読まない(決定7)。 */
const BOARD_SETTINGS_LINE = "!/.claude/settings.json";

const configEnabled = (workspace: WorkspaceConfig, key: string) =>
  git(workspace.path, "config", "--type=bool", "--default=false", "--get", key) === "true";

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
  return (storedSparseSnapshot(db, workspace) ?? snapshotFromBoardLine(workspace)) !== undefined;
}

/** Keep shared project settings (ADR 0158) in Git but out of the worker's physical checkout:
 *  the human's own sparse patterns plus one non-cone exclusion line (ADR 0293 決定2), so the
 *  worker never sees more than the human's checkout does. Non-cone sparse-checkout leaves the
 *  index and status clean, so branch changes and the slot-release tree rule need no special case. */
export function excludeWorkspaceProjectSettings(db: Db, workspace: WorkspaceConfig): void {
  // 写しは DB に無いときだけ撮る —— 回収前の2本目が盤面の形を人間の状態として写さない(ADR 0293 決定1)。
  // 残った盤面の行から読んだ写しも DB に写す —— この session の回収が worker の書いた pattern を読み直さない(決定7)
  let snapshot = storedSparseSnapshot(db, workspace);
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
    ).run(snapshotKey(workspace), JSON.stringify(snapshot));
  }
  const base = snapshot.mode === "disabled" ? "/*\n" : snapshot.pattern;
  gitWithInput(`${base.trimEnd()}\n${BOARD_SETTINGS_LINE}\n`, workspace.path, "sparse-checkout", "set", "--no-cone", "--stdin");
  if (lstatSync(join(workspace.path, ".claude", "settings.json"), { throwIfNoEntry: false })) {
    throw new Error(`workspace ${workspace.name}: could not exclude .claude/settings.json`);
  }
  if (git(workspace.path, "status", "--porcelain") !== "") {
    throw new Error(`workspace ${workspace.name}: sparse settings exclusion left a dirty tree`);
  }
}

/** Put the human's sparse-checkout back from the snapshot when no worker owns the checkout, and
 *  let git itself write the mode (cone lives in config.worktree — ADR 0293 決定4). The snapshot
 *  is dropped only after git succeeded; a failure throws for the caller to quarantine. */
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
  dropSparseSnapshot(db, snapshotKey(workspace));
}

const dropSparseSnapshot = (db: Db, key: string) =>
  db.prepare("UPDATE workspace_state SET sparse_snapshot = NULL WHERE name = ?").run(key);

/** Recover a sparse exclusion left by a previous board process — each listed workspace whose name
 *  still has a snapshot, or whose checkout still carries the board's line (ADR 0293 決定3 / 決定7),
 *  then every other key with a snapshot: an examinee's checkout or an interview room (issue #2379).
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
      console.error(`[workspace] ${key}: a sparse snapshot is stored, but no examinee checkout or interview room is recorded under it; leaving it`);
      continue;
    }
    // 写しは checkout が開いた後にしか書かれない —— 無ければ人間が記録の checkout を消した形で、戻すものが無い(ADR 0276 決定4)
    if (!existsSync(join(place.path, ".git"))) {
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
      quarantineWorkspace(db, workspace.name, err, now);
    }
  }
}

/** 写しの鍵を registry 外の走る場所へ解く: 受験者の checkout(名前は面接室の root id、鍵は受験者の id —— ADR 0276 決定3)、
 *  無ければ面接室(名前 = 鍵 = root id)。quarantine はどちらも root id に立つ(ADR 0273 決定8)。 */
function recordedPlaceOf(db: Db, key: string): WorkspaceConfig | undefined {
  const task = getTask(db, key);
  const rootId = task && interviewRootIdOf(db, task);
  return (rootId === undefined ? undefined : examineeRunPlace(db, key, rootId)) ?? recordedInterviewRoom(db, key);
}

/** この checkout が実際に持っている `origin` の URL、無ければ undefined。**実態**を
 *  訊く1つの問いで、`repo` の宣言と突き合わせる側(下の
 *  `assertRemoteDeclarationMatchesClone`)と、既存 checkout の登録時に宣言を焼く側
 *  (`workspace-create.ts` の `registerExistingCheckout`)が同じ関数で訊く ——
 *  2箇所が別々に訊くと、登録が自分で作った宣言を pickup が「ずれている」と読む余地が
 *  残る(/code-review Standards 軸の指摘)。git repository でないパスも「remote 無し」
 *  として同じ undefined に落ちる。 */
export function originUrl(checkoutPath: string): string | undefined {
  try {
    return git(checkoutPath, "remote", "get-url", "origin");
  } catch {
    return undefined;
  }
}

/** ADR 0052 決定3 の対偶(issue #211 やること5): 宣言は clone を覗いた推測ではないので、
 *  宣言と実態がずれていたら**どこかが赤くならなければならない**。
 *
 *  ずれは両向きに害がある。宣言があって remote が無い側は fetch も fork も撃てない。
 *  宣言が無くて remote がある側のほうが危険で、黙って通れば fork 元はローカルの保護
 *  ブランチのままなので、merge 済みの成果が見えない地点からタスクが始まり続け、症状は
 *  「PR が毎回コンフリクトする」という遠い場所に出る。
 *
 *  突き合わせるのは `origin` の**有無だけ**である。URL の綴り(ssh / https / ホスト名の
 *  別名)を照合しても同じリモートを別物と読む誤検出しか増えず、`repo` は人間向けの
 *  provenance でもあるため厳密な一致を要求できない。 */
function assertRemoteDeclarationMatchesClone(workspace: WorkspaceConfig): void {
  const hasOrigin = originUrl(workspace.path) !== undefined;
  if (isRemoteBacked(workspace) === hasOrigin) return;
  throw new Error(
    isRemoteBacked(workspace)
      ? `workspace ${workspace.name} declares a remote source of truth (repo: ${workspace.repo}) ` +
        "but its checkout has no 'origin' remote"
      : `workspace ${workspace.name} declares no remote source of truth (no repo) ` +
        "but its checkout has an 'origin' remote",
  );
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
): Promise<void> {
  if (!isRemoteBacked(workspace)) return;
  await auth?.ensureToken(originRepo(workspace.path));
}

/** ADR 0052 決定2 の pickup 直前の refresh を workspace 側にも(issue #211 やること4)。
 *  remote 正本を宣言した workspace だけが fetch する —— 宣言の無い workspace には
 *  fetch する先が無い。
 *
 *  **`tidepool-board[bot]` 名義で撃つ**(ADR 0093): workspace の remote も private であり
 *  うるし、`authedGit` の credential 引数はホストに設定済みの helper を先にクリア
 *  する ——「人間の `gh` ログインに寄りかからない」がここでも同時に成立する。上限
 *  つきの面を使うのは、詰まった接続が同期呼び出しで event loop ごと止めてはならない
 *  からである(`GIT_NETWORK_TIMEOUT_MS`)。
 *
 *  token を要求する repo は**宣言(`repo`)ではなく checkout の `origin`** から
 *  決める。installation token は repo 単位なので、fetch が実際に触る remote と
 *  token の宛先は同じでなければならない —— `repo` は人間向けの provenance でも
 *  あって綴りの一致を要求しない(ADR 0052)ので、宣言から導くと別の repo 宛ての
 *  token を持って行きうる。
 *
 *  **同期のまま**なのは呼び出し元の都合である: `releaseWorkspace` は watchdog の
 *  tick(`setInterval` のコールバック)からも来る。したがって token の取得だけを
 *  `ensureWorkspaceToken` に分け、fetch する2つの経路がその手前で必ず撃つ ——
 *  温まっていなければここが fail-closed に落ちる(`GitHubAuth.env`)。
 *
 *  失敗は投げる —— 呼び出し元(pickup / completion release)がその workspace を
 *  quarantine する。仲介の不達もここに落ちる(ADR 0093 決定7)。registry の到達
 *  不能と違って盤面全体は止めない: これは特定 workspace の性質なので、資源単位の
 *  原則がそのまま適用できる(ADR 0052 決定5)。 */
function refreshWorkspace(workspace: WorkspaceConfig, auth: GitHubAuth | undefined): void {
  if (!isRemoteBacked(workspace)) return;
  authedGitBounded(auth, workspace.path, originRepo(workspace.path), GIT_NETWORK_TIMEOUT_MS, "fetch", "--quiet", "origin", protectedBranch(workspace));
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

/** issue #211 やること6: registry clone は「registry の正本」(合成 root が1回解決する
 *  `RegistryMode`)と「workspace」(`workspaces.yaml` の `repo`)の**両方**の役を持つので
 *  宣言を2つ持つ。1本化はできない —— workspace エントリを読むには先に registry を読む
 *  必要があり循環する —— ので、pickup の瞬間に突き合わせる。
 *
 *  上の `assertRemoteDeclarationMatchesClone` では捕まらない食い違いがある: 双方の
 *  宣言が clone の実態とは一致していて、互いにだけ食い違っている場合(remote を持たない
 *  clone を registry として remote-backed と宣言した、など)である。 */
function assertRegistryRoleAgrees(
  workspace: WorkspaceConfig,
  registry: RegistrySource | undefined,
): void {
  if (!registry || !pathIsRegistryClone(workspace.path, registry.dir)) return;
  const asRegistry = registry.mode === "remote-backed";
  if (asRegistry === isRemoteBacked(workspace)) return;
  throw new Error(
    `workspace ${workspace.name} is the board's own registry clone and its two declarations ` +
      `disagree: as the registry it declares '${registry.mode}', as a workspace it declares ` +
      (isRemoteBacked(workspace) ? `a remote source of truth (repo: ${workspace.repo})` : "none"),
  );
}

/** pickup の鮮度の段(issue #211 / issue #2223): 宣言どうし・宣言と実態を突き合わせ、remote 正本を宣言していれば refresh し、
 *  休止位置(ADR 0052 決定7)へ追従させる。走る場所と、読む場所(`RunPlace.reads`)のうち remote 正本を持つものに当てる:
 *  盤面が読む正本は pickup 直前の remote の保護ブランチ(ADR 0052 決定1・2)で、読むだけの場所でも同じである。
 *
 *  1つの関数にまとめてあるのは、どれが失敗しても行き先が同じ —— その場所の quarantine —— だからである(scheduler 側の
 *  try/catch 1つが全部受ける)。順序は意味を持つ: 宣言のずれを先に見るので、remote を持たない clone に対する fetch の
 *  生のエラーではなく「宣言がずれている」という読める理由が人間に届く。 */
export async function freshenPlaceAtPickup(place: WorkspaceConfig, board: PickupPrep): Promise<void> {
  assertOwnGitDirectory(place.path);
  assertRegistryRoleAgrees(place, board.registry);
  assertRemoteDeclarationMatchesClone(place);
  await ensureWorkspaceToken(place, board.githubAuth);
  if (board.live?.() === false) return;
  refreshWorkspace(place, board.githubAuth);
  parkOnProtectedBranch(place, outsideTheGate);
}

/** pickup の準備に要る盤面の deps。`live` は pickup の継続の門(#1973、`liveSession`): token の await の後に閉じていれば
 *  git に進まずに戻る —— 呼び手は戻った後に同じ門を読む。 */
type PickupPrep = { githubAuth?: GitHubAuth; registry?: RegistrySource; live?: () => boolean };

/** 走る場所の pickup の準備: 鮮度の段の上にブランチ規律と ref の基準を積む。読む場所には当てない —— タスクブランチも基準も
 *  走る場所だけのもの(実環境に root のブランチを立てない、ADR 0273 決定2)。 */
export async function prepareWorkspaceAtPickup(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
  board: PickupPrep = {},
): Promise<void> {
  await freshenPlaceAtPickup(workspace, board);
  if (board.live?.() === false) return;
  ensureTaskBranch(db, workspace, task);
  // ADR 0064 決定5: fetch と休止位置の**後**でなければならない —— `refreshWorkspace` が `refs/remotes` を、休止位置の ff が
  // 保護ブランチを動かすので、前に撮ると盤面自身の書き込みが違反として立つ
  snapshotRefs(db, workspace);
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
 *  可動部(付け替え・削除・新規作成)は行差分に残る。 */
function currentRefs(workspace: WorkspaceConfig): string {
  return git(
    workspace.path,
    "for-each-ref",
    "--format=%(if)%(symref)%(then)symref=%(symref)%(else)%(objectname)%(end) %(refname)",
  );
}

/** 基準の行の鍵: 走る場所の名前。受験者の checkout だけは名前(面接室の root id)を兄弟と共有するので受験者の id(ADR 0276 決定3)。
 *  鍵は型で強いていない —— 受験者の走る場所は `taskRunPlace` だけが作る。準備・解放・盤面の ref の口を `RunPlace` に締めると、
 *  受験者でない WorkspaceConfig の呼び手(テストの約40箇所と後始末・MCP の型)が全部変わる。 */
function snapshotKey(workspace: WorkspaceConfig): string {
  return (workspace as RunPlace).snapshot_key ?? workspace.name;
}

/** ADR 0064 決定5: worker に checkout を手渡した瞬間の全 ref を基準として焼く。
 *  撮るのは pickup の1回だけで、ここから先は盤面自身が書いた ref の行だけが
 *  書く前の予告と書いた後の畳みで更新される(`writeBoardRefs`)。 */
function snapshotRefs(db: Db, workspace: WorkspaceConfig): void {
  db.prepare(
    `INSERT INTO workspace_state (name, ref_snapshot) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET ref_snapshot = excluded.ref_snapshot`,
  ).run(snapshotKey(workspace), currentRefs(workspace));
}

function storedRefs(db: Db, workspaceName: string): string {
  const row = db
    .prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?")
    .get(workspaceName) as { ref_snapshot: string | null } | undefined;
  // 未設定に分岐は書かない(ADR 0064 決定6): 空文字は現在の ref 集合と一致しないので
  // 自然に違反へ落ちる —— pickup を経ない解放経路が将来足されても検査は黙って消えない
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

/** 基準の行の値が、今の ref の値を「動いていない」と読むか。基準を読む2つの側(解放時の比較 —— ADR 0064 決定2、
 *  着地の帯域外判定 —— ADR 0103 決定1)はどちらもこれで解く: 予告中の行は2値のどちらとも一致で通す(ADR 0243 決定2)。
 *  行が無いことと ref が無いことは、どちらも空文字として突き合わせる。 */
function baselineAllows(recorded: string | undefined, actual: string | undefined): boolean {
  return (recorded ?? "").split("|").includes(actual ?? "");
}

/** 盤面自身の記録が持つ `ref` の値、記録に行が無ければ undefined。行の**有無**を
 *  呼び出し側に返すのは、着地の帯域外判定(ADR 0103 決定1)が「記録に無い」を不一致
 *  として扱いつつ、人間へ返す理由をそこで書き分けるためである。 */
function recordedRef(db: Db, workspaceName: string, ref: string): string | undefined {
  return refValues(storedRefs(db, workspaceName)).get(ref);
}

/** ADR 0064 の不変条件そのもの: **タスクブランチは worker の唯一の可変 ref である**。
 *  自分のタスクブランチを両側から落として、残りの ref がすべて基準の値のままであることを要求する ——
 *  移動・削除・新規作成のいずれも違反で、削除が最も静かな破壊であるからこそ「動いた
 *  ものだけを見る」綴りは選ばない(決定2)。
 *
 *  メッセージは**動いた ref を名指しする**。quarantine の確認 question の本文に載り、
 *  人間の修理手順がそのまま読める形になる。予告中の行は2値のまま載る。 */
function assertOnlyTaskBranchMoved(db: Db, workspace: WorkspaceConfig, taskId: string): void {
  const except = `refs/heads/${taskBranch(taskId)}`;
  const before = refValues(storedRefs(db, snapshotKey(workspace)));
  const after = refValues(currentRefs(workspace));
  const moved = [...new Set([...before.keys(), ...after.keys()])].filter(
    (ref) => ref !== except && !baselineAllows(before.get(ref), after.get(ref)),
  );
  if (moved.length === 0) return;
  throw new Error(
    `workspace ${workspace.name}: refs other than ${except} changed during the session — ` +
      [
        ...moved.filter((ref) => before.has(ref)).map((ref) => `was: ${before.get(ref)} ${ref}`),
        ...moved.filter((ref) => after.has(ref)).map((ref) => `now: ${after.get(ref)} ${ref}`),
      ].join(", "),
  );
}

/** 基準を書き換える。基準を持たない workspace(一度も拾われていない)には何もしない —— 行を作らず、次の pickup が
 *  全体を撮る。保存値の綴りは常に「`for-each-ref` のソート済み出力」= **refname 順**である(ADR 0064 決定6)。 */
function updateBaseline(db: Db, workspace: WorkspaceConfig, edit: (values: Map<string, string>) => void): boolean {
  const stored = db
    .prepare("SELECT ref_snapshot FROM workspace_state WHERE name = ?")
    .get(snapshotKey(workspace)) as { ref_snapshot: string | null } | undefined;
  if (!stored?.ref_snapshot) return false;
  const values = refValues(stored.ref_snapshot);
  edit(values);
  db.prepare("UPDATE workspace_state SET ref_snapshot = ? WHERE name = ?").run(
    [...values]
      .filter(([, value]) => value !== "")
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([ref, value]) => `${value} ${ref}`)
      .join("\n"),
    snapshotKey(workspace),
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

/** ADR 0243 の口: 盤面が ref を書くときはここを通る(休止中の着地の `merge --ff-only` のように checkout ごと動かす書き込みも)。書く前に基準のその行を
 *  `<old>|<new>` に予告し、`write()` を撃ち、ref を読み返して `new` なら `{new}`、違えば `{old}` に畳む —— 読み返した
 *  値そのものを基準に入れることは無い(決定2)。`write()` が投げても畳んでから投げ直す。予告と畳みの間で盤面が
 *  落ちれば2値の行が残り、次の pickup の全撮りが消すまでどちらの値も違反と読まれない(決定5)。
 *
 *  `write()` は同期に限る —— 予告→書く→畳むが1つの同期区間になり、盤面の他の書き込みと交差しない。token の取得
 *  (仲介への往復)は呼び手が予告の前に済ませる。 */
export function writeBoardRefs(
  db: Db,
  workspace: WorkspaceConfig,
  writes: ReadonlyArray<readonly [ref: string, newSha: string]>,
  write: () => void,
): void {
  const before = new Map<string, string>();
  const announced = updateBaseline(db, workspace, (values) => {
    for (const [ref, newSha] of writes) {
      before.set(ref, values.get(ref) ?? "");
      values.set(ref, `${before.get(ref)}|${newSha}`);
    }
  });
  if (!announced) {
    write();
    return;
  }
  const fold = () =>
    updateBaseline(db, workspace, (values) => {
      for (const [ref, newSha] of writes) values.set(ref, readRef(workspace, ref) === newSha ? newSha : before.get(ref)!);
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

/** 1つの workspace の基準に束ねた1本の口(`writeBoardRefs` の1本の形)。 */
export function boardRefWriter(db: Db, workspace: WorkspaceConfig): RefWriter {
  return (ref, newSha, write) => writeBoardRefs(db, workspace, [[ref, newSha]], write);
}

/** 口を通さずに書く。pickup の鮮度の段の休止位置だけが使う —— 口に通すのは #2459。 */
const outsideTheGate: RefWriter = (_ref, _newSha, write) => write();

/** ADR 0069 の3条件 —— **既知パス・untracked・0 バイト**をすべて満たすファイルだけが
 *  「セッションの遺物ではないと確定的に識別できるもの」である。tree rule の退避除外と
 *  完了の門(ADR 0084)の dirty 判定は同じ集合を見なければならない —— 2箇所に綴りが
 *  分かれれば、片方だけが残骸を数えて無実の拒否や取りこぼしが生まれる。 */
function shadowRemnants(workspace: WorkspaceConfig): string[] {
  return SANDBOX_SHADOW_PATHS.filter((path) => {
    const stat = lstatSync(join(workspace.path, path), { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size !== 0) return false;
    return git(workspace.path, "ls-files", "--cached", "--", path) === "";
  });
}

/** shadow 残骸(ADR 0069 の3条件)を除いた「作業ツリーに残っている未コミットの変更」の
 *  観測。**綴りはこの1つである**(ADR 0084 決定3): 門の dirty 判定も完了経路の検査も
 *  ここを読む —— 判定を2箇所に複製すると、片方だけが残骸を数えて無実の拒否か取りこぼしが
 *  生まれる。
 *
 *  `--untracked-files=all` は必須である: 既定の porcelain は丸ごと untracked な
 *  ディレクトリを `?? .claude/` の1行に畳むので、残骸の除外がパス一致で効かなくなり
 *  `.claude/agents` だけの残骸が dirty に数えられる。
 *
 *  **観測できなければ投げる。** 飲むかどうかは呼び手の判断であり、経路ごとに違う。 */
function uncommittedChanges(workspace: WorkspaceConfig): string[] {
  const remnants = new Set<string>(shadowRemnants(workspace));
  return git(workspace.path, "status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter((line) => line !== "" && !remnants.has(line.slice(3)));
}

/** shadow 残骸(ADR 0069 の3条件)を消す。tree rule の退避も完了経路の検査も、判定の
 *  **手前**で同じ削除を走らせる —— これを省くとサンドボックス下の解放が全部 quarantine に
 *  落ちる。 */
function removeShadowRemnants(workspace: WorkspaceConfig): void {
  for (const path of shadowRemnants(workspace)) {
    rmSync(join(workspace.path, path), { force: true });
  }
}

/** ADR 0084 の完了の門が読む「作業ツリーに未コミットの変更が残っているか」。tree rule と
 *  同じ基準(上記)で、こちらは**何も変えない**。
 *
 *  **観測に失敗したら `false` を返す**(ADR 0084 決定2): git repository 自体が壊れている
 *  workspace で「commit してから呼び直せ」は worker に実行不能なことを求める指示になる。
 *  握り潰しをここに置くのは、飲むのを**観測に限る**ためである —— 呼び出し側のロジックの
 *  失敗まで一緒に飲むと、門が理由なく開く。黙って開くわけでもない: 直後の解放で tree rule
 *  が同じ git に躓き、quarantine が人間に届く。**その網は完了経路には無い**(tree rule が
 *  検査に置き換わる)ので、そちらは飲まない —— `assertNothingWrittenAfterCompletion`。 */
export function treeIsDirty(workspace: WorkspaceConfig): boolean {
  try {
    return uncommittedChanges(workspace).length > 0;
  } catch {
    return false;
  }
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

/** The slot-release tree rule: whatever the session left behind is stashed as
 *  a WIP commit on the task branch, and the tree is verified clean before the
 *  slot goes free. Mechanical, on every release — completion, escalation or
 *  failure alike — so nothing rests on the agent having tidied up. */
export function releaseTree(workspace: WorkspaceConfig, task: Task): void {
  const taskId = task.id;
  assertOnTaskBranch(workspace, taskId);
  removeShadowRemnants(workspace);
  git(workspace.path, "add", "-A");
  if (git(workspace.path, "status", "--porcelain") !== "") {
    git(workspace.path, "commit", "-m", wipSubject(task));
  }
  if (git(workspace.path, "status", "--porcelain") !== "") {
    throw new Error(`workspace ${workspace.name} still dirty after WIP commit`);
  }
}

/** the WIP commit lands on the task branch or nowhere: a session that wandered
 *  off its branch (e.g. onto main) must not have its leavings committed there —
 *  refusing here is what makes the main-write ban structural, and the refusal
 *  lands in the quarantine path. 完了経路の後始末(下記)も同じ位置でこれを読む ——
 *  そこでは何もコミットしないが、自分のブランチに居ないまま「done」と報告した
 *  session の成果は、どこへ merge-back すればよいのかも分からない(#234 ケース1)。 */
function assertOnTaskBranch(workspace: WorkspaceConfig, taskId: string): void {
  const head = git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD");
  if (head !== taskBranch(taskId)) {
    throw new Error(
      `workspace ${workspace.name} is on '${head}', not '${taskBranch(taskId)}' — refusing to commit`,
    );
  }
}

/** HEAD がこの task のブランチに乗っているか(ADR 0274 決定3)。読めない checkout は乗っていない —— 盤面がそこへ checkout できていない。 */
export function onTaskBranch(workspace: WorkspaceConfig, taskId: string): boolean {
  try {
    return git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD") === taskBranch(taskId);
  } catch {
    return false;
  }
}

/** ADR 0084 の完了の門が掛かる述語(work タスクかつ workspace が needs-human でない)。
 *  ADR 0109 決定3 が「退避しない」範囲も**同じ述語**である —— 門が verb の手前で clean を
 *  要求している範囲でだけ、後始末時の汚れは成果ではなく残存プロセスの露見だと言える。 */
export function completionTreeGateApplies(db: Db, task: Task, workspace: WorkspaceConfig): boolean {
  return task.type === "work" && !workspaceNeedsHuman(db, workspace.name);
}

/** 完了経路の後始末が tree rule の代わりに走らせる**検査**(ADR 0109 決定3)。
 *
 *  完了の門(ADR 0084)が verb の手前で clean を要求している以上、後始末の時点で
 *  ツリーに現れる変更は成果ではなく「done と報告した**後**に書かれたもの」——
 *  すなわち残存プロセスの露見である。退避すればそれが WIP になり、次の一手である
 *  merge-back が祖先ブランチへ運んでしまうので、退避せず投げて quarantine に落とす。
 *
 *  読む綴りは門と同じ1つ(`uncommittedChanges` / ADR 0084 決定3)で、shadow 残骸の削除も
 *  tree rule と同じ手前の位置で走る。**観測の失敗は飲まない**: 門の側の握り潰しが安全なのは
 *  直後の解放で tree rule が同じ git に躓いて quarantine が人間に届くからであり、完了経路
 *  ではその tree rule がこの検査に置き換わっていて網が無い(ADR 0109 決定3)。 */
function assertNothingWrittenAfterCompletion(workspace: WorkspaceConfig, task: Task): void {
  assertOnTaskBranch(workspace, task.id);
  removeShadowRemnants(workspace);
  if (uncommittedChanges(workspace).length > 0) {
    // 完了報告の後の書き込みは session の成果物ではない —— 後始末は session の持ち物(ADR 0109)
    throw new Error(
      `workspace ${workspace.name} was written to after task ${task.id} reported done — ` +
        "the completion gate required a clean tree before the verb, so these changes are not " +
        "the session's deliverable but a process that outlived its own report",
    );
  }
}

/** ADR 0052 決定7: 「クリーンに戻す」には**休止位置**も含まれる —— 退避のあと checkout を
 *  保護ブランチへ戻し、remote 正本を宣言した workspace ではリモートへ追従させてから戻す。
 *
 *  理由は盤面の正しさではなく**人間の誤読**である。盤面はもう checkout の位置を読まない
 *  (fork 元も読み取りもリモートの ref)が、人間はホスト上でその checkout を覗く。最後に
 *  走ったタスクのブランチが居座った clone は、覗いた人間に「今この workspace はこう
 *  なっている」と嘘をつく(#210 のグリリング中、実際に一度その誤読が起きた)。
 *
 *  追従は **ff-only** で撃つ。`checkout -B <protected> <remote ref>` なら常に成功するが、
 *  それは帯域外の手作業でローカルに載ったコミットを黙って捨てる —— quarantine すべき
 *  食い違いを、無かったことにする形で通してしまう。
 *
 *  **成立の判定は ff コマンドの成否ではなく位置の一致で行う**(/code-review Spec 軸の
 *  指摘)。ローカルがリモートより**先行しているだけ**のとき `merge --ff-only` は
 *  「もう最新」として exit 0 で通るが、その休止位置は嘘である —— そこに載っているのは
 *  push されていないローカル専用のコミットで、リモートを見ている人間の理解と食い違う。
 *  決定7 が求めるのは「追従していること」なので、ff のあと HEAD がリモートの ref と
 *  同じコミットを指していることまで要求する。分岐(両側に差がある)は merge 自身が
 *  弾き、先行はこの検査が弾く。どちらも投げて quarantine に落とす(呼び出し元の
 *  `releaseWorkspace` と pickup の鮮度の段 `freshenPlaceAtPickup` が受ける)。
 *
 *  ff は呼び手が渡す `writeRef` で書く: 後始末と受理のやり直しは口(ADR 0243 決定4)、pickup の鮮度の段だけが
 *  `outsideTheGate` を明示して渡す(#2459)。 */
function parkOnProtectedBranch(workspace: WorkspaceConfig, writeRef: RefWriter): void {
  const branch = protectedBranch(workspace);
  git(workspace.path, "checkout", branch);
  if (!isRemoteBacked(workspace)) return;
  const ref = protectedBranchRef(workspace);
  const remoteSha = git(workspace.path, "rev-parse", ref);
  // identity を渡すのは ff が commit を作らない場合でも git が要求しうるため —
  // 盤面が打つ git はすべて Tidepool 名義という線(issue #53)をここでも切らない
  writeRef(`refs/heads/${branch}`, remoteSha, () => git(workspace.path, "merge", "--ff-only", remoteSha));
  if (git(workspace.path, "rev-parse", "HEAD") === remoteSha) return;
  throw new Error(
    `workspace ${workspace.name}: local '${branch}' is ahead of ${ref} — out-of-band local ` +
      "commits were never pushed, so parking here would show a state the remote does not have",
  );
}

/** Quarantine resolution's verification gate (issue #21, CONTEXT.md): the
 *  board never takes a repair confirmation on faith. Any failure to observe
 *  a clean tree — dirty, or not even a usable git repository — is treated
 *  the same, fail-closed, same posture as the tree rule's own dirty-after-
 *  WIP-commit check. */
export function verifyWorkspaceClean(workspace: WorkspaceConfig): void {
  assertOwnGitDirectory(workspace.path);
  let status: string;
  try {
    status = git(workspace.path, "status", "--porcelain");
  } catch (err) {
    throw new Error(
      `workspace ${workspace.name} is not a usable git repository: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (status !== "") {
    throw new Error(`workspace ${workspace.name} still has uncommitted changes`);
  }
}

/** ADR 0137 決定3: the open Confirmation question is the only state. */
export function workspaceNeedsHuman(db: Db, name: string): boolean {
  return openQuarantineQuestion(db, "workspace", name) !== undefined;
}

/** Tree-rule failure containment (quarantine, CONTEXT.md): put the repair in
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
  registerQuarantine(db, "workspace", workspaceName, reason, now);
  return { quarantine: "workspace", value: workspaceName, reason };
}

export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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

/** The same comparison for a checkout path that is **already resolved** — what a
 *  `WorkspaceConfig` carries (issue #211's pickup-time crosscheck). The entry-shaped
 *  face above stands in front of it for the callers that still hold an entry and a
 *  base dir (ADR 0018's derivation). */
export function pathIsRegistryClone(checkoutPath: string, registryDir: string): boolean {
  return safeRealpath(checkoutPath) === safeRealpath(registryDir);
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

/** Every slot release runs the tree rule and falls back to quarantine on its
 *  failure — the shared shape behind the releasing MCP verbs and the
 *  watchdog/restart failure path alike (#9). Work completion alone may merge
 *  the task back into the ancestor branch selected from its live lineage (ADR
 *  0053); escalation, decomposition, and failure leave the WIP on the task
 *  branch. Parking (ADR 0052 decision 7) stays in the same try because every
 *  failure in this sequence has the same quarantine destination. */
export function releaseWorkspace(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
  now: Date,
  mergeBack = false,
  githubAuth?: GitHubAuth,
  tokenFailure?: unknown,
  /** 完了経路の後始末か(ADR 0109 決定3)。門が掛かる範囲では退避ではなく検査を
   *  走らせる —— 掛からない範囲(review の完了・escalate・decompose)は従来どおり
   *  退避する: そこでの WIP はタスクブランチに留まり、merge-back に載らない。 */
  completed = false,
): void {
  try {
    if (completed && completionTreeGateApplies(db, task, workspace)) {
      assertNothingWrittenAfterCompletion(workspace, task);
    } else {
      releaseTree(workspace, task);
    }
    // ADR 0064 決定5: 盤面自身が他の ref を書き始める**前**でなければならない ——
    // 順序を誤ると盤面が自分の不変条件を踏んで自分を quarantine する
    assertOnlyTaskBranchMoved(db, workspace, task.id);
    // merge-back の帰り先はこの fetch の結果で決まる。token は呼び出し元が
    // `ensureWorkspaceToken` で温めてある(ADR 0093)。温められなかったときは、その
    // 失敗を fetch が落ちたのと同じ位置で投げる —— WIP は既に退避済みで、行き先は
    // 同じ quarantine(ADR 0052)。呼び出し元で投げると slot が解放されない。
    if (mergeBack) {
      if (tokenFailure !== undefined) throw tokenFailure;
      refreshWorkspace(workspace, githubAuth);
    }
    const target = mergeBack && lineageTaskBranch(db, workspace, task);
    if (target) mergeBackInto(db, workspace, target, task.id, "then answer");
    parkOnProtectedBranch(workspace, boardRefWriter(db, workspace));
  } catch (err) {
    quarantineWorkspace(db, workspace.name, err, now);
  }
}

/** 後始末の merge back の一歩 —— 帰り先を checkout し、届いていなければ ff 先か merge commit を先に作って、口を通して
 *  `merge --ff-only` で checkout ごと進める(ADR 0243 決定4)。conflict は merge-tree の段階で分かり、checkout は帰り先の
 *  tip のまま何も残さない —— 出口を2つ示して投げる(ADR 0239 帰結)。それ以外の失敗(dirty なツリーを ff が拒む等)は
 *  git の理由のまま投げる。workspace の quarantine の受理の検査も同じ一歩を踏む(ADR 0240 決定4)。出口の文の結びだけが
 *  呼び手で違う —— 後始末の文はまだ答えていない quarantine の question に載る。 */
function mergeBackInto(
  db: Db,
  workspace: WorkspaceConfig,
  target: string,
  taskId: string,
  thenAnswer: "then answer" | "then answer again",
): void {
  const source = taskBranch(taskId);
  const ref = `refs/heads/${target}`;
  git(workspace.path, "checkout", target);
  if (isAncestor(workspace, source, ref)) return;
  const sha = isAncestor(workspace, ref, source)
    ? git(workspace.path, "rev-parse", `refs/heads/${source}`)
    : mergeCommit(workspace, ref, `refs/heads/${source}`, `Merge ${source} into ${target}`);
  if (sha === undefined) {
    throw new Error(
      `${source} does not merge cleanly into '${target}' — either merge it there by hand in workspace ` +
        `${workspace.name} and commit, or, to discard it, record it there with \`git merge -s ours ${source}\`; ` +
        thenAnswer,
    );
  }
  boardRefWriter(db, workspace)(ref, sha, () => git(workspace.path, "merge", "--ff-only", sha));
}

/** ADR 0240 決定4: 内容が帰り先(lineage が指す祖先のタスクブランチ)に届いていない done の work と、その帰り先。
 *  新しい行から並べる —— 子孫の内容を先に子へ運んでから、子を親へ運ぶ。読めなければ投げる(fail-closed)。
 *  ponytail: その workspace の done の子をすべて読む。回答のたびなので、遅くなれば着地の終わった木を SQL で外す。 */
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
 *  保護ブランチの fetch(後始末の fetch と違い口を通る形 —— `refreshProtectedBranch`)→ 帰り先へ merge back → 休止位置へ
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
    parkOnProtectedBranch(workspace, boardRefWriter(db, workspace));
  } catch (parkError) {
    if (!failure) throw parkError;
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

/** ADR 0105 決定2: a root that outlived a squash/rebase-landed fork source
 *  catches its task branch up to the protected ref without touching HEAD,
 *  the index, or the worktree. Parent order preserves the task branch as the
 *  first-parent history and records the protected ref as the second parent. */
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
  boardRefWriter(db, workspace)(ref, merged, () => git(workspace.path, "update-ref", ref, merged, taskSha));
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
  const fastForward = isAncestor(workspace, ref, task);
  const landed = fastForward
    ? git(workspace.path, "rev-parse", `refs/heads/${task}`)
    : mergeCommit(workspace, protectedSha, `refs/heads/${task}`, `Merge ${task} into ${branch}`);
  if (landed === undefined) throw landingConflict(workspace, branch, task);
  // 着地は人間面から入るので、同じ workspace で**別のタスクが走っている最中**に来る
  // (ADR 0064 決定4 が挙げる並行そのもの)。checkout はその worker の作業ツリーを
  // 奪い、走っているセッションは自分のタスクブランチの外で終わって tree rule に撃たれる
  // —— HEAD が保護ブランチに無ければ ref だけを進める。`update-ref` に旧 sha を添えるのは
  // 安価な CAS で、記録との突き合わせから書き込みまでの隙に保護ブランチが動いていれば
  // ここで落ちる(同じ workspace への2枚の着地回答が競えば、負けた側が回答の拒否で落ちる)。
  //
  // 枝は DB の走っている行ではなく HEAD の位置で選ぶ: 保護ブランチを checkout している worker の下で `update-ref` を
  // 撃てば、index と作業ツリーが古い位置に取り残され、着地が運んだ変更が幻の削除として見える(#1872 の実測)。
  // HEAD が保護ブランチにあれば、走っている session の有無によらず checkout ごと ff する —— 被る WIP があれば ff が
  // 拒んで何も動かさず、その理由がそのまま人間へ返る(quarantine ではない —— ADR 0103 決定4)
  const write = boardRefWriter(db, workspace);
  if (git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD") !== branch) {
    write(ref, landed, () =>
      fastForward
        ? git(workspace.path, "fetch", ".", `${task}:${branch}`)
        : git(workspace.path, "update-ref", ref, landed, protectedSha),
    );
  } else write(ref, landed, () => git(workspace.path, "merge", "--ff-only", landed));
  return landed;
}
