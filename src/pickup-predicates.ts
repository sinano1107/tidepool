/** Two-phase place checks shared by pickup, release and prose (ADR 0329 決定10〜14). */
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { BoardStateOverlapError, type BoardStatePath, boardStateOverlap } from "./board-state.js";
import type { Db } from "./db.js";
import { git, readCheckoutRemote } from "./git.js";
import { networkDestination, remoteTrackingRef, workspaceNetworkDestination } from "./github-auth.js";
import { placeHasRepository, recordedPlace } from "./recorded-place.js";
import { repositoryLabel, sameRepository } from "./repo-access.js";
import { auditedPosedEventId, getTask, interviewRole, interviewRoomPath, interviewRootIdOf, isRca, latestPosedProbe, posedProbe, type Task, unsettledOpenersOf } from "./tasks.js";
import type { WorkspaceConfig } from "./workspace.js";

/** 面接室の Quarantine の、項が落ちた RCA を倒す回答(ADR 0385 決定2)。項の出口の文と受理と表示が同じ1つを読む。 */
export const CANCEL_THE_RCAS = "cancel the RCAs that need missing objects";

/** ADR 0385 決定1: 項の出口は、項の持ち主を倒せる人間の扉 —— 受験者・review の鎖は Interview の root の cancel で倒れる。 */
const cancelInterview = (rootId: string) => `cancel the Interview ${rootId}`;

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
      describe: `${scope}the declared \`repo:\` agrees with the repository remembered in the baseline, if it has one, and the declared \`head_repo:\` with the head repo recorded by the workspace settings.`,
      check: () => place.checkRememberedRepo?.(place),
    },
    {
      phase: "before-open",
      describe: `${scope}it has an \`origin\` remote exactly when it declares a remote source of truth (\`repo\`), and both point to the same repository.`,
      check: () => assertRemoteDeclarationMatchesClone(place),
    },
    {
      phase: "before-open",
      describe: `${scope}it has a \`${HEAD_REPO_REMOTE}\` remote exactly when it declares a head repo (\`head_repo\`), and both point to the same repository.`,
      check: () => assertHeadRemoteMatchesDeclaration(place),
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
  // ADR 0277 追記 決定2 / ADR 0373 決定11: 出題前の面接室は盤面に空で作り直させる出口も持つ(手の `git init` は選択肢に替わった)
  const goneExits = head ? `restore it there or ${cancelInterview(rootId)}` : `restore it there, ${cancelInterview(rootId)}, or answer \`run with an empty room\` to have the board re-create it empty`;
  const predicates = recordedRoomPredicates(db, rootId, workspacesBaseDir, fixedPoints, {
    recorded: (path) => `a git repository exists at the recorded room ${path} — the board does not recreate it: ${goneExits}.`,
    create: "the board can create this interview room's directory under its workspaces base directory (`mkdir -p` succeeds and leaves a directory there).",
  });
  const recorded = recordedPlace(db, rootId);
  if (head === undefined || !recorded) return predicates;
  const room = { name: rootId, path: recorded.path };
  return [
    ...predicates,
    {
      phase: "before-open",
      describe: `the posed head ${head} resolves in the interview room — ${goneExits}.`,
      check: () => {
        if (!placeHasRepository(room.path)) throw new Error(gonePlaceReason(rootId, room.path));
        if (resolvedCommit(room, head) === undefined) throw new Error(`the posed head ${head} cannot be resolved in the interview room ${rootId} at ${room.path}`);
      },
    },
  ];
}

/** (task, 面接室) の項(ADR 0329 決定4 の Status 追記、issue #3136): 準備がその task たちのために面接室から fetch するものが、
 *  fetch の要る閉包(`--depth` を付けないので履歴全体)まで面接室にある。項は出口ごとに分け、異議の RCA は1つずつ項を持つ —— 回答が
 *  どの RCA の項が落ちたかを読む(`rca`、ADR 0385 決定1・2)。`rev-list` は項ごとに1回で、同じ項の task たちの共有する履歴を1度しか
 *  歩かない(項を跨いだ共有は項の数だけ歩く)。文は記録だけから組み(予告は git を撃たない)、何を fetch するかは検査の中で引く。
 *  面接室が何も提供しない task は項を持たない(`roomProvisionOf`、ADR 0386 決定1・2)。 */
export function taskRoomPickupPredicates(db: Db, tasks: Task[], rootId: string, workspacesBaseDir: string): RoomOpenerPredicate[] {
  const items = new Map<string, { exit: string; rca?: string; examinee?: true; needs: RoomProvision[] }>();
  for (const task of tasks) {
    const need = roomProvisionOf(db, task, rootId);
    if (!need) continue;
    const rca = isRca(db, task.id) ? task.id : undefined;
    const exit = rca ? `answer \`${CANCEL_THE_RCAS}\`` : cancelInterview(interviewOwnerOf(db, task));
    const item = items.get(rca ?? exit) ?? { exit, ...(rca && { rca }), needs: [] };
    item.needs.push(need);
    if (need.examinee) item.examinee = true;
    items.set(rca ?? exit, item);
  }
  const room = roomPlace(db, rootId, workspacesBaseDir);
  return [...items.values()].map(({ exit, rca, examinee, needs }) => {
    const what = needs.map((need) => need.what).join("; ");
    return {
      ...(rca && { rca }),
      ...(examinee && { examinee }),
      phase: "before-open",
      describe: `every object reachable from ${what} is present in the interview room — restore it there or ${exit}.`,
      check: () => {
        // 面接室の repo が無ければ git の生のエラー(や外側の repo での解決)ではなく、面接室が消えた理由で止まる
        if (!placeHasRepository(room.path)) throw new Error(gonePlaceReason(rootId, room.path));
        const shas = new Set<string>();
        for (const need of needs) {
          const rev = providedRev(room, need);
          const sha = resolvedCommit(room, rev);
          if (sha === undefined) throw new Error(`${need.what} cannot be resolved in the interview room ${rootId} at ${room.path}`);
          shas.add(sha);
        }
        const missing = missingObjects(room, [...shas]);
        if (missing.length > 0) throw new Error(`objects reachable from ${what} (${[...shas].join(", ")}) are missing from the interview room ${rootId} at ${room.path}: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ` and ${missing.length - 5} more` : ""}`);
      },
    };
  });
}

/** (task, 面接室) の項の1つ。`rca` は項の持ち主の異議の RCA —— 回答が落ちた項から倒す RCA を読む(ADR 0385 決定2)。`examinee` は
 *  その面接室の受験者を含む項 —— 並びの先頭に来る(ADR 0386 決定4)。 */
type RoomOpenerPredicate = PickupPredicate & { rca?: string; examinee?: true };

/** 名前に掛かる項の1つ。`own` は名前の場所そのものの項 —— 解除の門が面接室そのものの項(ADR 0385 決定6)や倒す RCA の項(`rca`、
 *  決定2)を外す印。 */
type NamePredicate = RoomOpenerPredicate & { own?: true };

const asOwn = (predicate: PickupPredicate): NamePredicate => ({ ...predicate, own: true });

/** 面接室の項の並び(ADR 0386 決定4): その面接室の受験者を含む項 → 面接室そのものの項 → 残りの task の項。pickup の門・解除の門・
 *  Quarantine の本文がこれを読む。(task, 面接室) の項は面接室の repo が無ければ面接室が消えた理由で止まるので、未記録の面接室に
 *  「作る」項(`mkdir -p`)を撃たない(ADR 0329 追記 決定7)。 */
export function roomPredicatesInOrder(db: Db, rootId: string, tasks: Task[], workspacesBaseDir: string, fixedPoints?: BoardStatePath[]): NamePredicate[] {
  const items = taskRoomPickupPredicates(db, tasks, rootId, workspacesBaseDir);
  const own = roomPickupPredicates(db, rootId, workspacesBaseDir, fixedPoints).map(asOwn);
  return [...items.filter((item) => item.examinee), ...own, ...items.filter((item) => !item.examinee)];
}

/** 項の持ち主を倒せる Interview の root(ADR 0385 決定1): review の鎖を root か受験者まで登り、受験者は対象の root。鎖が RCA を通るのは
 *  RCA の下の RCA だけで(Interview の系譜は帰り先を持たず、RCA の下に work・完了時レビュー・人間の review 子は立たない —— ADR 0301 決定2)、
 *  RCA の項は呼び手が先に回答の出口へ分ける。 */
export function interviewOwnerOf(db: Db, task: Task): string {
  let owner = task;
  while (owner.type === "review") owner = getTask(db, owner.parent_id!)!;
  return interviewRootIdOf(db, owner)!;
}

/** 面接室がその task の準備に提供するもの(ADR 0386 決定1)。受験者と root は自分のタスクブランチ `branch`(ADR 0356 決定2)と、
 *  無いときに準備がそこから切る元 `source` —— 受験者は出題の head(ADR 0276 決定1)、root は面接室の保護ブランチ(Interview の root は親を
 *  持たない root task で(`assertInterviewFields`)、`lineageTaskBranch` が辿る系譜が無い。面接室は新しく作る repo —— ADR 0273 決定1。
 *  切る sha と完了の門の fork 元が同じ出所、ADR 0362 決定2)。読み手はブランチを持たず、`source` は `readHeadOf` の出題の head。
 *  `examinee` はこの面接室の受験者 —— 項の並び(ADR 0386 決定4)と切る元の文が読む。文は記録だけから組む。 */
type RoomProvision = { what: string; branch?: string; source: (room: WorkspaceConfig) => string; examinee?: true };

/** 項と準備が読む1つの答え。他の面接室を読む root・受験者はこの面接室では読み手。未記録の面接室の root は何も提供しない —— 面接室を開く段が
 *  保護ブランチに空の commit を補うので、門の時点で切る元を問えない(ADR 0386 決定2)。出題前の面接室の読み手も何も読まない。 */
export function roomProvisionOf(db: Db, task: Task, rootId: string): RoomProvision | undefined {
  const branch = taskBranch(task.id);
  const role = interviewRootIdOf(db, task) === rootId ? interviewRole(db, task) : undefined;
  if (role === "examinee") {
    const posed = posedHeadOf(db, task);
    return { what: `the task branch \`${branch}\` of the examinee ${task.id}, or the posed head ${posed} it forks from while that branch is absent`, branch, source: () => posed, examinee: true };
  }
  if (role === "root") {
    if (interviewRoomPath(db, rootId) === undefined) return undefined;
    return { what: `the task branch \`${branch}\` of ${task.id}, or the interview room's protected branch it forks from while that branch is absent`, branch, source: exactProtectedBranchRef };
  }
  const head = readHeadOf(db, task, rootId);
  return head === undefined ? undefined : { what: `the posed head ${head} that ${task.id} reads`, source: () => head };
}

/** 面接室が今その task に提供する rev: ブランチがあればそれ、無ければ切る元か読む head。項はこれの閉包を門の時点で検査し、準備はブランチを
 *  立てた後にこれを fetch する。 */
export function providedRev(room: WorkspaceConfig, { branch, source }: RoomProvision): string {
  return branch !== undefined && branchExists(room, branch) ? `refs/heads/${branch}` : source(room);
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

export function taskBranchExists(workspace: WorkspaceConfig, taskId: string): boolean {
  return branchExists(workspace, taskBranch(taskId));
}

/** 「無い」は `rev-parse --verify --quiet` の exit 1 だけ —— 他の失敗は投げる(ADR 0242 決定3)。ref を剥かない —— tip の commit が
 *  欠けた ref は「ある」と読み、項の `resolvedCommit` が引けないで止める(準備はその ref を fetch する)。 */
function branchExists(workspace: WorkspaceConfig, branch: string): boolean {
  try {
    git(workspace.path, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
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
 *  面接室なら名前を開く未決着の task ごとの (task, 面接室) の項を、面接室の項の並び(ADR 0386 決定4)で。決着した task は開く pickup が
 *  無いので掛からない。 */
export function namePickupPredicates(db: Db, name: string, place: WorkspaceConfig, workspacesBaseDir: string, fixedPoints?: BoardStatePath[]): NamePredicate[] {
  if (getTask(db, name)?.type !== "interview") return checkoutPickupPredicates(place, fixedPoints).map(asOwn);
  return roomPredicatesInOrder(db, name, unsettledOpenersOf(db, name), workspacesBaseDir, fixedPoints);
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

/** 面接室で走る task(受験者・root)のタスクブランチを切る sha —— 面接室が提供する切る元(ADR 0386 決定1)。引けない切る元から黙って
 *  今の head へ逃げない —— 投げて pickup の失敗(面接室の quarantine)に落とす。 */
export function roomForkSource(db: Db, room: WorkspaceConfig, task: Task): string {
  const provision = roomProvisionOf(db, task, room.name);
  const source = provision?.source(room);
  const resolved = source === undefined ? undefined : resolvedCommit(room, source);
  if (resolved !== undefined) return resolved;
  const what = provision?.examinee ? `the protected branch head the probe recorded for ${task.id}` : `the fork source of ${task.id}`;
  throw new Error(`workspace ${room.name}: ${what} (${source}) cannot be resolved in this checkout, so its branch is not forked`);
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

export class RemoteRepositoryMismatchError extends Error {}

function remoteRepairInstruction(
  verb: "add" | "set-url",
  repo: string,
  displayed: string,
  { remote, field }: { remote: string; field: string } = { remote: "origin", field: "repo" },
): string {
  const command = `git remote ${verb}${repo.startsWith("-") ? " --" : ""} ${remote}`;
  // ADR 0378 決定4: redacting a non-GitHub declaration can change the value required by the gate.
  if (!sameRepository(repo, displayed) || /[\r\n]/.test(displayed)) {
    return `use the exact private \`${field}:\` value from the registry entry with \`${command}\``;
  }
  const argument = /^[\w@%+=:,./-]+$/.test(displayed) ? displayed : `'${displayed.replaceAll("'", "'\\''")}'`;
  const ticks = (argument.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(ticks + 1);
  return `run ${fence}${command} ${argument}${fence}`;
}

/** ADR 0378 決定3・4: compare the raw origin at both pickup and Quarantine acceptance. */
export function assertRemoteDeclarationMatchesClone(workspace: WorkspaceConfig): void {
  const { name, path, repo } = workspace;
  const origin = readCheckoutRemote(path, "first");
  if (origin === null) throw new RemoteRepositoryMismatchError(`workspace ${name}: could not read its checkout's origin in ${path}`);
  if (sameRepository(repo, origin)) return;
  if (repo === undefined) {
    throw new RemoteRepositoryMismatchError(`workspace ${name} declares no remote source of truth (no repo) but its checkout has an 'origin' remote. In ${path}, run \`git config --remove-section remote.origin\`.`);
  }
  const declared = repositoryLabel(repo, { preserveSshUser: true });
  if (origin === undefined) {
    throw new RemoteRepositoryMismatchError(`workspace ${name} declares a remote source of truth (repo: ${declared}) but its checkout has no 'origin' remote. In ${path}, ${remoteRepairInstruction("add", repo, declared)}.`);
  }
  const configured = repositoryLabel(origin, { preserveSshUser: true });
  throw new RemoteRepositoryMismatchError(`workspace ${name} declares repo ${declared}, but its checkout's origin is ${configured}. In ${path}, ${remoteRepairInstruction("set-url", repo, declared)}. To move the workspace to another repository, delete it and register it again.`);
}

/** The checkout's remote for the declared PR head repo (ADR 0395 決定2); origin stays the declared `repo`. */
export const HEAD_REPO_REMOTE = "head-repo";

/** ADR 0395 決定2 / ADR 0378 決定3・4: the head repo remote is compared like origin — present exactly when declared, and the same
 *  repository. */
export function assertHeadRemoteMatchesDeclaration(workspace: WorkspaceConfig): void {
  const { name, path, head_repo: declared } = workspace;
  const remote = readCheckoutRemote(path, "first", HEAD_REPO_REMOTE);
  if (remote === null) throw new RemoteRepositoryMismatchError(`workspace ${name}: could not read its checkout's '${HEAD_REPO_REMOTE}' remote in ${path}`);
  if (remote === undefined && declared === undefined) return;
  if (declared === undefined) {
    throw new RemoteRepositoryMismatchError(`workspace ${name} declares no head repo (no head_repo) but its checkout has a '${HEAD_REPO_REMOTE}' remote. In ${path}, run \`git config --remove-section remote.${HEAD_REPO_REMOTE}\`.`);
  }
  const label = repositoryLabel(declared, { preserveSshUser: true });
  // `owner/name` is a local path to git: the repair names the URL the board would reach (ADR 0339 決定4)
  const url = networkDestination(declared, path).url;
  const repair = (verb: "add" | "set-url") =>
    remoteRepairInstruction(verb, url, repositoryLabel(url, { preserveSshUser: true }), { remote: HEAD_REPO_REMOTE, field: "head_repo" });
  if (remote === undefined) {
    throw new RemoteRepositoryMismatchError(`workspace ${name} declares head repo ${label} but its checkout has no '${HEAD_REPO_REMOTE}' remote. In ${path}, ${repair("add")}.`);
  }
  if (sameRepository(declared, remote)) return;
  const configured = repositoryLabel(remote, { preserveSshUser: true });
  throw new RemoteRepositoryMismatchError(`workspace ${name} declares head repo ${label}, but its checkout's '${HEAD_REPO_REMOTE}' remote is ${configured}. In ${path}, ${repair("set-url")}.`);
}

export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
