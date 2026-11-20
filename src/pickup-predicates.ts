/** Two-phase place checks shared by pickup, release and prose (ADR 0329 決定10〜14). */
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { BoardStateOverlapError, type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { Db } from "./db.js";
import { git, readCheckoutOrigin } from "./git.js";
import { remoteTrackingRef, workspaceNetworkDestination } from "./github-auth.js";
import { placeHasRepository, recordedPlace } from "./recorded-place.js";
import { repositoryLabel, sameRepository } from "./repo-access.js";
import { auditedPosedEventId, getTask, interviewRole, interviewRoomPath, interviewRootIdOf, latestPosedProbe, posedProbe, type Task, unsettledOpenersOf } from "./tasks.js";
import type { WorkspaceConfig } from "./workspace.js";

/** 在り処のディレクトリが消えた記録された面接室の出口(ADR 0277 追記 決定2 / ADR 0373 決定11 —— 手の `git init` は選択肢に替わった)。 */
const GONE_ROOM_EXITS = "restore it there, cancel the task that opens it, or answer `run with an empty room` to have the board re-create it empty";

const GONE_POSED_PLACE_EXITS = "restore it there or cancel the task that opens it";

/** 開いた event の無い場所で、repo が既にあるときだけ当たる項の頭。予告の解除だけの上乗せも同じ句で条件を言う。 */
export const IF_REPOSITORY_PRESENT = "if a repository is already present, ";

/** spec #3273 text A12: ref を動かさない直し方(ADR 0373 決定16)—— 条件を言う文(受理の拒否・pickup の理由・Quarantine の検査の一覧)の後に足す。
 *  どの文も人間に branch を作らせない。休止の2つ(H9・H10)は項の説明に載る —— 説明は検査の一覧と、落ちた項として拒否と理由に1度ずつ出る。 */
export const discardUncommitted = (them = "them") =>
  ` Discard ${them} with \`git restore --staged --worktree .\` then \`git clean -fd\` until \`git status --porcelain\` is empty ` +
  "(`git clean -ffd` for a nested repository, `git worktree remove --force <path>` for a linked worktree inside the tree).";
const PUSH_LOCAL_COMMITS = " Push those commits to origin from your own clone. If the branches stay diverged, cancel the tasks, delete the workspace and register it again.";
const FIX_BRANCH_IN_REGISTRY = " Fix `branch` in the registry entry.";

/** workspace 側が渡す記録を書かない操作 —— 一覧は workspace の実装へ依存しない。 */
export type PlaceFire = {
  fetch: (place: WorkspaceConfig) => Promise<void>;
  park: (place: WorkspaceConfig) => void;
};

/** 一覧の1項: 後半を撃つ呼び手は操作の context を必ず渡す。 */
export type PickupPredicate = { describe: string } & (
  | { phase: "before-open"; check: () => void }
  | { phase: "after-open"; place: WorkspaceConfig; check: (fire: PlaceFire) => void | Promise<void> }
);

/** ADR 0023: `branch` is a reference resolved fresh at every use, same
 *  posture as `resolveExecutionWorkspace` itself — never pinned to what a
 *  task branch actually forked from. */
export function protectedBranch(workspace: WorkspaceConfig): string {
  return workspace.branch ?? "main";
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

/** ADR 0360 決定3・5: 記録の tree を読むときは、同名のタグを解決しない完全な ref を使う。 */
export function exactProtectedBranchRef(workspace: WorkspaceConfig): string {
  const branch = protectedBranch(workspace);
  return isRemoteBacked(workspace) ? remoteTrackingRef(branch) : `refs/heads/${branch}`;
}

/** The registry's declared ref for read-only projections, which do not raise Quarantine. */
export function declaredProtectedBranchRef(workspace: WorkspaceConfig): string {
  const branch = protectedBranch(workspace);
  return declaresWorkspaceRepo(workspace) ? remoteTrackingRef(branch) : branch;
}

function declaresWorkspaceRepo(workspace: WorkspaceConfig): boolean {
  return workspace.repo !== undefined;
}

/** 述語を撃つ checkout の種類: registry の workspace(読む場所を含む)、面接室、開いた event の無い面接室(未生の HEAD を通す)。 */
export type CheckoutKind = "workspace" | "room" | "unborn room";

/** 実体のある checkout に撃つ述語 —— 実環境の workspace と読む場所、開いた面接室。`scope` は説明の頭に付く場所の名指し。 */
export function checkoutPickupPredicates(place: WorkspaceConfig, fixedPoints?: BoardStatePath[], kind: CheckoutKind = "workspace", scope = ""): PickupPredicate[] {
  return [
    // 名前の場所と固定点の交差は最初に見る —— 後の項(`.git` の検査)の文が registry clone の拒否を隠さない。
    // 固定点を持たない呼び手(予告の一覧)にも項は並ぶ
    {
      phase: "before-open",
      describe: `${scope}it overlaps none of the board's fixed points — the board's own state paths and checkout, and the registry clone.`,
      check: () => {
        const overlap = fixedPoints && boardStateOverlap(place.path, fixedPoints);
        if (overlap) throw new BoardStateOverlapError(overlap.reason);
      },
    },
    { phase: "before-open", describe: `${scope}its \`.git\` is a directory — not a linked worktree or submodule.`, check: () => assertOwnGitDirectory(place.path) },
    {
      phase: "before-open",
      describe: `${scope}the declared \`repo:\` agrees with the repository remembered in the baseline, if it has one.`,
      check: () => place.checkRememberedRepo?.(place),
    },
    {
      phase: "before-open",
      describe: `${scope}it has an \`origin\` remote exactly when it declares a remote source of truth (\`repo\`), and both point to the same repository.`,
      check: () => assertRemoteDeclarationMatchesClone(place),
    },
    ...afterOpenPredicates(place, scope, kind),
  ];
}

function afterOpenPredicates(place: WorkspaceConfig, scope: string, kind: CheckoutKind): PickupPredicate[] {
  const unbornRoom = kind === "unborn room";
  // 予告の実環境は設定を持たないので、既定名や remote の有無を答えにしない(ADR 0329 決定10)。
  const branch = place.path ? `protected branch \`${protectedBranch(place)}\`` : "configured protected branch";
  const remoteRef = place.path && declaresWorkspaceRepo(place) ? `\`${declaredProtectedBranchRef(place)}\`` : "its remote-tracking ref";
  const prefix = `${scope}${IF_REPOSITORY_PRESENT}`;
  return [
    {
      phase: "after-open", place,
      describe: `${prefix}the remote ${branch} can be fetched (no-op without a remote source of truth).`,
      check: async (fire) => { if (placeHasRepository(place.path)) await fire.fetch(place); },
    },
    {
      phase: "after-open", place,
      describe: `${prefix}the ${branch} can be checked out; when remote-backed, the local branch can fast-forward to ${remoteRef} without ahead or diverged commits.` +
        (unbornRoom ? " An unborn HEAD passes: the opening step supplies `main` with an empty commit." : "") +
        // ADR 0373 決定16 / spec #3273 text A12(H10・H9): 面接室の保護ブランチは registry に無く、remote も持たない
        (kind !== "workspace" ? "" : ` If the branch is missing:${FIX_BRANCH_IN_REGISTRY} If local commits are ahead of or diverged from origin:${PUSH_LOCAL_COMMITS}`),
      check: (fire) => {
        if (!placeHasRepository(place.path)) return;
        if (unbornRoom) {
          try { git(place.path, "rev-parse", "--verify", "--quiet", "HEAD"); }
          catch (err) {
            if ((err as { status?: number })?.status === 1) return;
            throw err;
          }
        }
        fire.park(place);
      },
    },
  ];
}

/** 面接室の述語(ADR 0329 決定4)。出題済みなら、読み手は出題の head を面接室から fetch する(ADR 0361 決定1)ので、記録された面接室で
 *  その head が引けることも項に並び、空の面接室で走らせる出口は予告しない(ADR 0329 決定5)。 */
export function roomPickupPredicates(db: Db, rootId: string, workspacesBaseDir: string, fixedPoints?: BoardStatePath[]): PickupPredicate[] {
  const head = latestPosedProbe(db, rootId)?.head;
  const predicates = recordedRoomPredicates(db, rootId, workspacesBaseDir, fixedPoints, {
    recorded: (path) => `a git repository exists at the recorded room ${path} — the board does not recreate it: ${head ? GONE_POSED_PLACE_EXITS : GONE_ROOM_EXITS}.`,
    create: "the board can create this interview room's directory under its workspaces base directory (`mkdir -p` succeeds and leaves a directory there).",
  });
  const recorded = recordedPlace(db, rootId);
  if (head === undefined || !recorded) return predicates;
  const room = { name: rootId, path: recorded.path };
  return [
    ...predicates,
    {
      phase: "before-open",
      describe: `the posed head ${head} resolves in the interview room — ${GONE_POSED_PLACE_EXITS}.`,
      check: () => {
        if (!placeHasRepository(room.path)) throw new Error(gonePlaceReason(rootId, room.path));
        if (resolvedCommit(room, head) === undefined) throw new Error(`the posed head ${head} cannot be resolved in the interview room ${rootId} at ${room.path}`);
      },
    },
  ];
}

/** (task, 面接室) の項(ADR 0329 決定4 の Status 追記、issue #3136): 準備がその task たちのために面接室から fetch するものが、
 *  fetch の要る閉包(`--depth` を付けないので履歴全体)まで面接室にある。task たちの sha は1回の `rev-list` で歩く —— 共有する履歴を
 *  1度しか歩かない。文は記録だけから組み(予告は git を撃たない)、何を fetch するかは検査の中で引く。fetch するものの無い task は項を持たない。 */
export function taskRoomPickupPredicates(db: Db, tasks: Task[], rootId: string, workspacesBaseDir: string): PickupPredicate[] {
  const needs = tasks.flatMap((task) => roomFetchOf(db, task, rootId) ?? []);
  if (needs.length === 0) return [];
  const room = roomPlace(db, rootId, workspacesBaseDir);
  const what = needs.map((need) => need.what).join("; ");
  return [
    {
      phase: "before-open",
      describe: `every object reachable from ${what} is present in the interview room — ${GONE_POSED_PLACE_EXITS}.`,
      check: () => {
        // 面接室の repo が無ければ git の生のエラー(や外側の repo での解決)ではなく、面接室が消えた理由で止まる
        if (!placeHasRepository(room.path)) throw new Error(gonePlaceReason(rootId, room.path));
        const shas = new Set<string>();
        for (const need of needs) {
          const rev = need.rev(room);
          if (rev === undefined) continue;
          const sha = resolvedCommit(room, rev);
          if (sha === undefined) throw new Error(`${need.what} cannot be resolved in the interview room ${rootId} at ${room.path}`);
          shas.add(sha);
        }
        const missing = missingObjects(room, [...shas]);
        if (missing.length > 0) throw new Error(`objects reachable from ${what} (${[...shas].join(", ")}) are missing from the interview room ${rootId} at ${room.path}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`);
      },
    },
  ];
}

/** 準備が task のためにその面接室から fetch するもの: 面接室で走る task(受験者・root)は自分のタスクブランチ(ADR 0356 決定2)
 *  —— 無ければ受験者は fork 元の出題の head(準備がそこから切る、ADR 0276 決定1)。root はブランチがある記録された面接室だけで、
 *  記録された面接室に root のブランチが無ければ閉包の項は無い(未記録なら場所の項の「作る」分岐が当たる)。面接室を読む task は
 *  `readHeadOf` の出題の head(出題前は無い)。 */
function roomFetchOf(db: Db, task: Task, rootId: string): { what: string; rev: (room: WorkspaceConfig) => string | undefined } | undefined {
  const branch = `refs/heads/${taskBranch(task.id)}`;
  // 他の面接室を読む root・受験者は、この面接室では読み手
  const role = interviewRootIdOf(db, task) === rootId ? interviewRole(db, task) : undefined;
  if (role === "examinee") {
    const posed = posedHeadOf(db, task);
    return {
      what: `the task branch \`${taskBranch(task.id)}\` of the examinee ${task.id}, or the posed head ${posed} it forks from while that branch is absent`,
      rev: (room) => (taskBranchExists(room, task.id) ? branch : posed),
    };
  }
  if (role === "root") {
    if (interviewRoomPath(db, rootId) === undefined) return undefined;
    return { what: `the task branch \`${taskBranch(task.id)}\` of ${task.id} when that branch is present`, rev: (room) => (taskBranchExists(room, task.id) ? branch : undefined) };
  }
  const head = readHeadOf(db, task, rootId);
  return head === undefined ? undefined : { what: `the posed head ${head} that ${task.id} reads`, rev: () => head };
}

/** 読む面接室の出題の head(ADR 0361 決定1 の Status 追記): review の鎖が監査を通るなら、その監査が見た出題(却下の後に出し直した root の旧い head
 *  —— 異議の RCA は監査と同じ環境を読む)。他は root の最新の出題で、出し直しは前の監査の決着の後なので監査する head と同じ
 *  (ADR 0273 決定3)。出題前の root は undefined(環境が無く checkout は空)。項と読み専用の checkout の準備が同じ答えを使う。 */
export function readHeadOf(db: Db, task: Pick<Task, "id" | "type" | "parent_id">, rootId: string): string | undefined {
  for (let reader: Pick<Task, "id" | "type" | "parent_id"> | undefined = task; reader?.type === "review"; reader = reader.parent_id === null ? undefined : getTask(db, reader.parent_id)) {
    const posedId = auditedPosedEventId(db, reader.id);
    if (posedId === undefined) continue;
    const posed = posedProbe(db, posedId);
    if (posed.root_id === rootId) return posed.head;
  }
  return latestPosedProbe(db, rootId)?.head;
}

export function taskBranch(taskId: string): string {
  return `task/${taskId}`;
}

/** `taskBranch` の逆: `task/<id>` の id。 */
export function taskIdOfBranch(branch: string): string {
  return branch.slice("task/".length);
}

/** 「無い」は `rev-parse --verify --quiet` の exit 1 だけ —— 他の失敗は投げる(ADR 0242 決定3)。ref を剥かない —— tip の commit が
 *  欠けた ref は「ある」と読み、項の `resolvedCommit` が引けないで止める(準備はその ref を fetch する)。 */
export function taskBranchExists(workspace: WorkspaceConfig, taskId: string): boolean {
  try {
    git(workspace.path, "rev-parse", "--verify", "--quiet", `refs/heads/${taskBranch(taskId)}`);
    return true;
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return false;
  }
}

/** sha たちから辿れる object のうち、その場所に欠けたもの。欠けは exit 0 の `?<oid>` 行で読み、他の失敗は投げる
 *  (ADR 0242 決定3、`resolvedCommit` と同じ線)。`--quiet` で `?` 行だけを出す。 */
function missingObjects(place: WorkspaceConfig, shas: string[]): string[] {
  if (shas.length === 0) return [];
  const out = git(place.path, "rev-list", "--objects", "--quiet", "--missing=print", "--end-of-options", ...shas);
  return out.split("\n").flatMap((line) => (line.startsWith("?") ? [line.slice(1)] : []));
}

/** 名前に掛かる項すべて(ADR 0329 決定4 の Status 追記): 名前の場所そのものの項(実環境なら解決した `place`、面接室なら記録から)と、
 *  面接室なら名前を開く未決着の task ごとの (task, 面接室) の項。決着した task は開く pickup が無いので掛からない。 */
export function namePickupPredicates(
  db: Db,
  name: string,
  place: WorkspaceConfig,
  workspacesBaseDir: string,
  fixedPoints?: BoardStatePath[],
): { own: PickupPredicate[]; openers: PickupPredicate[] } {
  if (getTask(db, name)?.type !== "interview") return { own: checkoutPickupPredicates(place, fixedPoints), openers: [] };
  return {
    own: roomPickupPredicates(db, name, workspacesBaseDir, fixedPoints),
    openers: taskRoomPickupPredicates(db, unsettledOpenersOf(db, name), name, workspacesBaseDir),
  };
}

/** 記録された場所(面接室)の2分岐(ADR 0329 決定1): event があれば repo がある(作り直さない)、無ければ番地を作れる —— 作る前に repo が
 *  既にあれば、開いた後の checkout と同じ述語が当たる。 */
function recordedRoomPredicates(
  db: Db,
  rootId: string,
  workspacesBaseDir: string,
  fixedPoints: BoardStatePath[] | undefined,
  text: { recorded: (path: string) => string; create: string },
): PickupPredicate[] {
  const recorded = recordedPlace(db, rootId);
  const place = { name: rootId, path: recorded?.path ?? conventionCheckoutPath(rootId, workspacesBaseDir) };
  if (recorded) {
    return [
      {
        phase: "before-open",
        describe: text.recorded(place.path),
        check: () => {
          if (!placeHasRepository(place.path)) throw new Error(gonePlaceReason(rootId, place.path));
        },
      },
      ...checkoutPickupPredicates(place, fixedPoints, "room"),
    ];
  }
  return [
    { phase: "before-open", describe: text.create, check: () => void mkdirSync(place.path, { recursive: true }) },
    // 未生の HEAD を通すのは開いた event の無い場所だけ —— 最初の開きが `main` に空コミットを補う。記録された面接室の未生の HEAD は
    // 補わない(手の `git init` の出口は `run with an empty room` に替わった、ADR 0373 決定11)
    ...checkoutPickupPredicates(place, fixedPoints, "unborn room").map((predicate): PickupPredicate => predicate.phase === "after-open" ? predicate : ({
      ...predicate,
      describe: `${IF_REPOSITORY_PRESENT}${predicate.describe}`,
      check: () => {
        if (placeHasRepository(place.path)) predicate.check();
      },
    })),
  ];
}

/** ADR 0378 決定6〜8: an edited declaration cannot silently switch between local and remote. */
export function isRemoteBacked(workspace: WorkspaceConfig): boolean {
  return workspaceNetworkDestination(workspace) !== undefined;
}

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

/** 面接室の番地: 記録があれば event の綴り、無ければ規約の番地。 */
export function roomPlace(db: Db, rootId: string, workspacesBaseDir: string): WorkspaceConfig {
  return { name: rootId, path: interviewRoomPath(db, rootId) ?? conventionCheckoutPath(rootId, workspacesBaseDir) };
}

/** 開く手順と読む門が同じ理由で記録の欠落を止める。 */
export function gonePlaceReason(rootId: string, path: string): string {
  return `the interview room ${rootId} recorded at ${path} has no git repository — the interview room's repository is gone`;
}

export function conventionCheckoutPath(name: string, workspacesBaseDir: string): string {
  return join(workspacesBaseDir, name);
}

/** 受験者の出題の head。出題の event は受験者 → 対象 → root から引く(ADR 0267 決定5)。出題し直した root は最後の出題(ADR 0273 決定3) */
function posedHeadOf(db: Db, task: Task): string {
  return db
    .prepare(
      `SELECT json_extract(e.payload, '$.head') FROM events e JOIN interview_targets it ON it.task_id = e.task_id
       WHERE it.id = ? AND e.kind = 'decision_logged' AND json_extract(e.payload, '$.interview_probe') IS NOT NULL
       ORDER BY e.id DESC LIMIT 1`,
    )
    .pluck()
    .get(task.interview_target_id) as string;
}

/** 引けない head から黙って今の head へ逃げない —— 投げて受験者の pickup の失敗(面接室の quarantine)に落とす。 */
export function resolvablePosedHead(db: Db, workspace: WorkspaceConfig, task: Task): string {
  const head = posedHeadOf(db, task);
  const resolved = resolvedCommit(workspace, head);
  if (resolved !== undefined) return resolved;
  throw new Error(
    `workspace ${workspace.name}: the protected branch head the probe recorded for ${task.id} (${head}) ` +
      "cannot be resolved in this checkout, so its branch is not forked",
  );
}

/** sha がその場所で commit に引ければ sha、引けなければ undefined。 */
export function resolvedCommit(place: WorkspaceConfig, sha: string): string | undefined {
  try {
    return git(place.path, "rev-parse", "--verify", "--quiet", `${sha}^{commit}`);
  } catch (err) {
    // 「引けない」は exit 1 だけ —— 他の失敗はそのまま投げる(ADR 0242 決定3、taskBranchExists と同じ)
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return undefined;
  }
}

/** The effective URL observed by the registration and publish doors. */
export function originUrl(checkoutPath: string): string | undefined {
  try {
    return git(checkoutPath, "remote", "get-url", "origin");
  } catch {
    return undefined;
  }
}

export class OriginRepositoryMismatchError extends Error {}

function originRepairInstruction(verb: "add" | "set-url", repo: string, displayed: string): string {
  const command = `git remote ${verb}${repo.startsWith("-") ? " --" : ""} origin`;
  // ADR 0378 決定4: redacting a non-GitHub declaration can change the value required by the gate.
  if (!sameRepository(repo, displayed) || /[\r\n]/.test(displayed)) {
    return `use the exact private \`repo:\` value from the registry entry with \`${command}\``;
  }
  const argument = /^[\w@%+=:,./-]+$/.test(displayed) ? displayed : `'${displayed.replaceAll("'", "'\\''")}'`;
  const ticks = (argument.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(ticks + 1);
  return `run ${fence}${command} ${argument}${fence}`;
}

/** ADR 0378 決定3・4: compare the raw origin at both pickup and Quarantine acceptance. */
export function assertRemoteDeclarationMatchesClone(workspace: WorkspaceConfig): void {
  const { name, path, repo } = workspace;
  const origin = readCheckoutOrigin(path, "first");
  if (origin === null) throw new OriginRepositoryMismatchError(`workspace ${name}: could not read its checkout's origin in ${path}`);
  if (sameRepository(repo, origin)) return;
  if (repo === undefined) {
    throw new OriginRepositoryMismatchError(`workspace ${name} declares no remote source of truth (no repo) but its checkout has an 'origin' remote. In ${path}, run \`git config --remove-section remote.origin\`.`);
  }
  const declared = repositoryLabel(repo, { preserveSshUser: true });
  if (origin === undefined) {
    throw new OriginRepositoryMismatchError(`workspace ${name} declares a remote source of truth (repo: ${declared}) but its checkout has no 'origin' remote. In ${path}, ${originRepairInstruction("add", repo, declared)}.`);
  }
  const configured = repositoryLabel(origin, { preserveSshUser: true });
  throw new OriginRepositoryMismatchError(`workspace ${name} declares repo ${declared}, but its checkout's origin is ${configured}. In ${path}, ${originRepairInstruction("set-url", repo, declared)}. To move the workspace to another repository, delete it and register it again.`);
}

export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
