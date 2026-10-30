/** pickup の門の純粋な前半 —— 場所の種類(実環境の workspace・面接室・受験者の checkout)ごとの述語の一覧(ADR 0329 追記 決定6)。
 *  pickup はこれを撃ってから不純な段(開いた event・fetch・休止位置・タスクブランチ・ref の基準)へ進み、workspace quarantine の解除は
 *  名前に掛かる場所の一覧を全部撃ち直し、予告の文は同じ一覧の説明を番号付きで並べる。解除だけの上乗せ(clean tree・状態 path との
 *  重なり・repo アクセスの修復・merge-back のやり直し)は一覧に入れない。予告(quarantine.ts)が読むので workspace.ts の下に置く。 */
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";
import { git } from "./git.js";
import { placeHasRepository, type RecordedPlaceKind, recordedPlace } from "./recorded-place.js";
import type { RegistrySource } from "./registry.js";
import { getTask, interviewRoomPath, latestPosedProbe, type Task, unsettledExaminees } from "./tasks.js";
import type { WorkspaceConfig } from "./workspace.js";

/** 在り処のディレクトリが消えた記録された面接室の出口(ADR 0277 追記 決定2)。 */
const GONE_ROOM_EXITS = "restore it there, cancel the task that opens it, or create it by hand (`git init` there) to run with an empty room";

const GONE_POSED_PLACE_EXITS = "restore it there or cancel the task that opens it";

/** 開いた event の無い場所で、repo が既にあるときだけ当たる項の頭。予告の解除だけの上乗せも同じ句で条件を言う。 */
export const IF_REPOSITORY_PRESENT = "if a repository is already present, ";

/** 一覧の1項: 人間向けの説明と、落ちれば今日の pickup と同じ理由で投げる検査。 */
export type PickupPredicate = { describe: string; check: () => void };

/** 実体のある checkout に撃つ述語 —— 実環境の workspace と読む場所、開いた面接室と受験者の checkout。`scope` は説明の頭に付く場所の名指し。 */
export function checkoutPickupPredicates(place: WorkspaceConfig, registry?: RegistrySource, scope = ""): PickupPredicate[] {
  return [
    { describe: `${scope}its \`.git\` is a directory — not a linked worktree or submodule.`, check: () => assertOwnGitDirectory(place.path) },
    {
      describe: `${scope}its declarations as the registry and as a workspace agree, when it is the board's own registry clone.`,
      check: () => assertRegistryRoleAgrees(place, registry),
    },
    {
      describe: `${scope}it has an \`origin\` remote exactly when it declares a remote source of truth (\`repo\`).`,
      check: () => assertRemoteDeclarationMatchesClone(place),
    },
  ];
}

/** 面接室の述語(ADR 0329 決定4)。出題済みで受験者が未決着なら、空の面接室で走らせる出口は出題の head の述語で通らない(決定5)。 */
export function roomPickupPredicates(db: Db, rootId: string, workspacesBaseDir: string, registry?: RegistrySource): PickupPredicate[] {
  const posed = unsettledExaminees(db, rootId).length > 0 && latestPosedProbe(db, rootId) !== null;
  return recordedPlacePredicates(db, rootId, "interview_room_opened", rootId, workspacesBaseDir, registry, {
    recorded: (path) => `a git repository exists at the recorded room ${path} — the board does not recreate it: ${posed ? GONE_POSED_PLACE_EXITS : GONE_ROOM_EXITS}.`,
    create: "the board can create this interview room's directory under its workspaces base directory (`mkdir -p` succeeds and leaves a directory there).",
    scope: "",
  });
}

/** 受験者の checkout の述語(ADR 0329 決定4): 面接室と同じ2分岐と、出題の head が面接室で引けること。 */
export function examineePickupPredicates(db: Db, examinee: Task, rootId: string, workspacesBaseDir: string, registry?: RegistrySource): PickupPredicate[] {
  const room = { name: rootId, path: interviewRoomPath(db, rootId) ?? conventionCheckoutPath(rootId, workspacesBaseDir) };
  const scope = `for the examinee checkout of ${examinee.id}, `;
  return [
    ...recordedPlacePredicates(db, examinee.id, "examinee_checkout_opened", rootId, workspacesBaseDir, registry, {
      recorded: (path) => `a git repository exists at the recorded examinee checkout ${examinee.id} at ${path} — the board does not recreate it: ${GONE_POSED_PLACE_EXITS}.`,
      create: `the board can create the examinee checkout directory for ${examinee.id} under its workspaces base directory (\`mkdir -p\` succeeds).`,
      scope,
    }),
    {
      describe: `${scope}the posed head ${posedHeadOf(db, examinee)} resolves in the interview room — ${GONE_POSED_PLACE_EXITS}.`,
      check: () => {
        // 面接室の repo が無ければ git の生のエラー(や外側の repo での解決)ではなく、面接室が消えた理由で止まる
        if (!placeHasRepository(room.path)) throw new Error(gonePlaceReason(rootId, room.path, "interview_room_opened"));
        resolvablePosedHead(db, room, examinee);
      },
    },
  ];
}

/** 名前に掛かる場所すべての一覧(ADR 0329 決定4): 名前の場所そのもの(実環境なら解決した `place`、面接室なら記録から)と、面接室なら
 *  未決着の受験者ごとの checkout。決着した受験者の checkout は開く pickup が無いので掛からない。 */
export function namePickupPredicates(
  db: Db,
  name: string,
  place: WorkspaceConfig,
  workspacesBaseDir: string,
  registry?: RegistrySource,
): { own: PickupPredicate[]; examinees: PickupPredicate[] } {
  if (getTask(db, name)?.type !== "interview") return { own: checkoutPickupPredicates(place, registry), examinees: [] };
  return {
    own: roomPickupPredicates(db, name, workspacesBaseDir, registry),
    examinees: unsettledExaminees(db, name).flatMap((examinee) => examineePickupPredicates(db, examinee, name, workspacesBaseDir, registry)),
  };
}

/** 記録された場所の2分岐(ADR 0329 決定1): event があれば repo がある(作り直さない)、無ければ番地を作れる —— 作る前に repo が
 *  既にあれば、開いた後の checkout と同じ述語が当たる。 */
function recordedPlacePredicates(
  db: Db,
  taskId: string,
  kind: RecordedPlaceKind,
  name: string,
  workspacesBaseDir: string,
  registry: RegistrySource | undefined,
  text: { recorded: (path: string) => string; create: string; scope: string },
): PickupPredicate[] {
  const recorded = recordedPlace(db, taskId, kind);
  const place = { name, path: recorded?.path ?? conventionCheckoutPath(taskId, workspacesBaseDir) };
  if (recorded) {
    return [
      {
        describe: text.recorded(place.path),
        check: () => {
          if (!placeHasRepository(place.path)) throw new Error(gonePlaceReason(taskId, place.path, kind));
        },
      },
      ...checkoutPickupPredicates(place, registry, text.scope),
    ];
  }
  return [
    { describe: text.create, check: () => void mkdirSync(place.path, { recursive: true }) },
    ...checkoutPickupPredicates(place, registry, `${text.scope}${IF_REPOSITORY_PRESENT}`).map(({ describe, check }) => ({
      describe,
      check: () => {
        if (placeHasRepository(place.path)) check();
      },
    })),
  ];
}

/** ADR 0052 決定3: この workspace が remote の正本を持つと**宣言している**か。
 *  clone を覗く関数ではない —— `repo` の有無だけを読む。 */
export function isRemoteBacked(workspace: WorkspaceConfig): boolean {
  return workspace.repo !== undefined;
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

/** 開く手順と読む門が同じ理由で記録の欠落を止める。 */
export function gonePlaceReason(taskId: string, path: string, kind: RecordedPlaceKind): string {
  const place = kind === "interview_room_opened" ? "interview room" : "examinee checkout";
  return `the ${place} ${taskId} recorded at ${path} has no git repository — the ${place}'s repository is gone`;
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

/** 引けない head から黙って今の head へ逃げない —— 投げて受験者の checkout を開く失敗(面接室の quarantine)に落とす。 */
export function resolvablePosedHead(db: Db, workspace: WorkspaceConfig, task: Task): string {
  const head = posedHeadOf(db, task);
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

export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The same comparison for a checkout path that is **already resolved** — what a
 *  `WorkspaceConfig` carries (issue #211's pickup-time crosscheck). The entry-shaped
 *  face (`resolvesToRegistryClone` in workspace.ts) stands in front of it for the callers that still hold an entry and a
 *  base dir (ADR 0018's derivation). */
export function pathIsRegistryClone(checkoutPath: string, registryDir: string): boolean {
  return safeRealpath(checkoutPath) === safeRealpath(registryDir);
}
