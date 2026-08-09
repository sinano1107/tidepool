import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { authedGitBounded, GIT_NETWORK_TIMEOUT_MS, type GitHubAuth } from "./github-auth.js";
import {
  ownEntry,
  REGISTRY_BRANCH,
  type Registry,
  type RegistrySource,
  remoteTrackingRef,
  type WorkspaceEntry,
} from "./registry.js";
import { BOARD_WORKER_ID, getTask, registerTask, type Task } from "./tasks.js";

export { BOARD_WORKER_ID } from "./tasks.js";

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
}

/** The protected branch: no task ever works on it directly. */
const MAIN_BRANCH = "main";

/** ADR 0018: the base directory a workspace entry's path derives from when
 *  the entry omits `path`. `configured` is `TIDEPOOL_WORKSPACES_DIR` as read
 *  by the caller (env access stays at the board's config edge, not here) —
 *  absent → `~/tidepool-workspaces` (the Pi's systemd unit sets
 *  `/mnt/ssd/tidepool-workspaces` explicitly). */
export function resolveWorkspacesBaseDir(configured: string | undefined): string {
  return configured ?? join(homedir(), "tidepool-workspaces");
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
 *  slot 解放後の休止位置の追従先)。 */
function protectedBranchRef(workspace: WorkspaceConfig): string {
  const branch = protectedBranch(workspace);
  return isRemoteBacked(workspace) ? remoteTrackingRef(branch) : branch;
}

/** The board's own git identity: the author on the tree rule's WIP commits
 *  (releaseTree) and on the registry commits the WebUI flows make (issue #57,
 *  workspace-create.ts) — one authorship for everything tidepool itself
 *  commits. The email is the #50 machine user's GitHub noreply (issue #53 /
 *  ADR 0024 point 4): the board's mechanical execution shows up under the same
 *  tidepool-bot account its GitHub operations do, extending the "board acts as
 *  Tidepool, not as a person" line (quarantine/watchdog questions already
 *  register under this name) onto git author. */
export const TIDEPOOL_GIT_IDENTITY = [
  "-c",
  "user.name=tidepool",
  "-c",
  "user.email=306969821+tidepool-bot@users.noreply.github.com",
] as const;

/** Shared by every board-driven git call (here and workspace-create.ts).
 *  stderr captured, not inherited: git narrates checkouts on stderr and the
 *  board's console is not the place for it. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();
}

/** A task's `workspace` (or the board's default) names a workspace absent
 *  from the registry — registry drift (issue #26). */
export class UnknownWorkspaceError extends Error {
  constructor(public readonly workspaceName: string) {
    super(`unknown workspace: ${workspaceName}`);
  }
}

/** ADR 0009: `task.workspace` is a reference to a registry name, resolved
 *  fresh against the registry every time it's used, never pinned to a path.
 *  Null inherits the board's default (CONTEXT.md's Workspace). `workspacesBaseDir`
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
  };
}

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
  }));
}

export function taskBranch(taskId: string): string {
  return `task/${taskId}`;
}

function taskBranchExists(workspace: WorkspaceConfig, taskId: string): boolean {
  try {
    git(workspace.path, "rev-parse", "--verify", "--quiet", `refs/heads/${taskBranch(taskId)}`);
    return true;
  } catch {
    return false;
  }
}

/** ADR 0053: the nearest work branch in the task's live lineage, or undefined
 *  when the protected branch is the bottom of that lineage. */
export function lineageTaskBranch(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
): string | undefined {
  if (task.type === "review") {
    return task.parent_id && taskBranchExists(workspace, task.parent_id)
      ? taskBranch(task.parent_id)
      : undefined;
  }

  const ancestors: Task[] = [];
  for (let parent = task.parent_id ? getTask(db, task.parent_id) : undefined; parent; ) {
    ancestors.unshift(parent);
    parent = parent.parent_id ? getTask(db, parent.parent_id) : undefined;
  }

  let candidate: string | undefined;
  for (const ancestor of ancestors) {
    if (ancestor.type !== "work") continue;
    const branch = taskBranch(ancestor.id);
    const base = candidate ?? protectedBranchRef(workspace);
    if (
      (ancestor.status !== "done" && ancestor.status !== "cancelled") ||
      Number(git(workspace.path, "rev-list", "--count", `${base}..${branch}`)) > 0
    ) {
      candidate = branch;
    }
  }
  return candidate;
}

/** Branch discipline at pickup: work never happens on the protected branch.
 *  A fresh task forks from its live lineage; a resumed task only checks its
 *  existing branch out again, WIP intact. */
export function ensureTaskBranch(db: Db, workspace: WorkspaceConfig, task: Task): void {
  const branch = taskBranch(task.id);
  if (!taskBranchExists(workspace, task.id)) {
    git(
      workspace.path,
      "branch",
      branch,
      lineageTaskBranch(db, workspace, task) ?? protectedBranchRef(workspace),
    );
  }
  git(workspace.path, "checkout", branch);
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

/** ADR 0052 決定2 の pickup 直前の refresh を workspace 側にも(issue #211 やること4)。
 *  remote 正本を宣言した workspace だけが fetch する —— 宣言の無い workspace には
 *  fetch する先が無い。
 *
 *  **machine user 名義で撃つ**(ADR 0024): workspace の remote も private でありうる
 *  し、`authedGit` の credential 引数はホストに設定済みの helper を先にクリアする ——
 *  「人間の `gh` ログインに寄りかからない」がここでも同時に成立する。上限つきの面を
 *  使うのは、詰まった接続が同期呼び出しで event loop ごと止めてはならないからである
 *  (`GIT_NETWORK_TIMEOUT_MS`)。
 *
 *  失敗は投げる —— 呼び出し元(pickup / completion release)がその workspace を
 *  quarantine する。registry の到達不能と違って盤面全体は止めない: これは特定
 *  workspace の性質なので、資源単位の原則がそのまま適用できる(ADR 0052 決定5)。 */
function refreshWorkspace(workspace: WorkspaceConfig, auth: GitHubAuth | undefined): void {
  if (!isRemoteBacked(workspace)) return;
  authedGitBounded(
    auth,
    workspace.path,
    GIT_NETWORK_TIMEOUT_MS,
    "fetch",
    "--quiet",
    "origin",
    protectedBranch(workspace),
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

/** pickup が checkout に対して行うことの全体(issue #211): 宣言どうし・宣言と実態を
 *  突き合わせ、remote 正本を宣言していれば refresh し、それからブランチ規律を敷く。
 *
 *  1つの関数にまとめてあるのは、どれが失敗しても行き先が同じ —— その workspace の
 *  quarantine —— だからである(scheduler 側の try/catch 1つが全部受ける)。順序は
 *  意味を持つ: 宣言のずれを先に見るので、remote を持たない clone に対する fetch の
 *  生のエラーではなく「宣言がずれている」という読める理由が人間に届く。 */
export function prepareWorkspaceAtPickup(
  db: Db,
  workspace: WorkspaceConfig,
  task: Task,
  board: { githubAuth?: GitHubAuth; registry?: RegistrySource },
): void {
  assertRegistryRoleAgrees(workspace, board.registry);
  assertRemoteDeclarationMatchesClone(workspace);
  refreshWorkspace(workspace, board.githubAuth);
  ensureTaskBranch(db, workspace, task);
}

/** The slot-release tree rule: whatever the session left behind is stashed as
 *  a WIP commit on the task branch, and the tree is verified clean before the
 *  slot goes free. Mechanical, on every release — completion, escalation or
 *  failure alike — so nothing rests on the agent having tidied up. */
export function releaseTree(workspace: WorkspaceConfig, taskId: string): void {
  // the WIP commit lands on the task branch or nowhere: a session that
  // wandered off its branch (e.g. onto main) must not have its leavings
  // committed there — refusing here is what makes the main-write ban
  // structural, and the refusal lands in the quarantine path
  const head = git(workspace.path, "rev-parse", "--abbrev-ref", "HEAD");
  if (head !== taskBranch(taskId)) {
    throw new Error(
      `workspace ${workspace.name} is on '${head}', not '${taskBranch(taskId)}' — refusing to commit`,
    );
  }
  git(workspace.path, "add", "-A");
  if (git(workspace.path, "status", "--porcelain") !== "") {
    git(workspace.path, ...TIDEPOOL_GIT_IDENTITY, "commit", "-m", `WIP: task ${taskId}`);
  }
  if (git(workspace.path, "status", "--porcelain") !== "") {
    throw new Error(`workspace ${workspace.name} still dirty after WIP commit`);
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
 *  `releaseWorkspace` が受ける)。 */
function parkOnProtectedBranch(workspace: WorkspaceConfig): void {
  const branch = protectedBranch(workspace);
  git(workspace.path, "checkout", branch);
  if (!isRemoteBacked(workspace)) return;
  const ref = protectedBranchRef(workspace);
  // identity を渡すのは ff が commit を作らない場合でも git が要求しうるため —
  // 盤面が打つ git はすべて Tidepool 名義という線(issue #53)をここでも切らない
  git(workspace.path, ...TIDEPOOL_GIT_IDENTITY, "merge", "--ff-only", ref);
  if (git(workspace.path, "rev-parse", "HEAD") === git(workspace.path, "rev-parse", ref)) return;
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

export function workspaceNeedsHuman(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT needs_human FROM workspace_state WHERE name = ?")
    .get(name) as { needs_human: number } | undefined;
  return row?.needs_human === 1;
}

/** Tree-rule failure containment (quarantine, CONTEXT.md): mark the workspace
 *  needs-human (its tasks stay out of the slot) and put the repair in front of
 *  the human as a 1-choice Confirmation question (issue #21) — the answer
 *  isn't a choice between outcomes, it's a confirmation that repair happened,
 *  verified before it clears needs-human (see answerQuestion in tasks.ts).
 *  Name-only (issue #26 / ADR 0009): the trigger can be a tree-rule failure
 *  (path known, folded into `cause`'s message) or an unknown workspace name
 *  encountered at resolution time (no path to know) — both quarantine the
 *  same way, keyed on the name alone. */
export function quarantineWorkspace(
  db: Db,
  workspaceName: string,
  cause: unknown,
  now: Date,
): void {
  db.prepare(
    `INSERT INTO workspace_state (name, needs_human) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET needs_human = 1`,
  ).run(workspaceName);
  const causeMessage = cause instanceof Error ? cause.message : String(cause);
  // 1 workspace = at most 1 open Confirmation question (CONTEXT.md's
  // Quarantine): a re-fire before the human answers just adds to the record
  // of why, on the question already standing.
  const existing = db
    .prepare(
      `SELECT id FROM tasks WHERE question_quarantine_workspace = ? AND status = 'todo'`,
    )
    .get(workspaceName) as { id: string } | undefined;
  if (existing) {
    appendEvent(db, {
      taskId: existing.id,
      workerId: BOARD_WORKER_ID,
      origin: "board",
      payload: { kind: "quarantine_refired", cause: causeMessage },
      at: now,
    });
    return;
  }
  const title = `workspace ${workspaceName} needs human attention`;
  registerTask(
    db,
    {
      type: "question",
      title,
      purpose:
        `${causeMessage}. ` +
        "Tasks in this workspace stay out of the slot until it is repaired. " +
        "Answering confirms the repair — the board verifies the tree is " +
        "clean before it resumes pickup; any answer text is kept as a repair note.",
      completion_criteria: "the workspace is repaired by hand",
      question: [{ title, options: ["repaired by hand"], recommendation: "repaired by hand" }],
      quarantine_workspace: workspaceName,
    },
    now,
    BOARD_WORKER_ID,
    "board",
  );
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
function pathIsRegistryClone(checkoutPath: string, registryDir: string): boolean {
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
 *  (scheduler pickup, mcp release, watchdog/restart failTask): prefer the
 *  registry-backed resolver when configured, else fall back to a fixed
 *  single workspace (pre-#26 shape, and still today's shape for a caller
 *  with no registry at all). Undefined means no workspace tracking exists —
 *  the caller skips the workspace step entirely, not just resolution. */
export function buildWorkspaceResolver(
  resolveWorkspace: ((taskWorkspace: string | null) => WorkspaceConfig) | undefined,
  workspace: WorkspaceConfig | undefined,
): ((taskWorkspace: string | null) => WorkspaceConfig) | undefined {
  return resolveWorkspace ?? (workspace && (() => workspace));
}

/** The shared shape behind every async, board-driven use of a task's
 *  execution workspace (issue #26 / ADR 0009: pickup, release, watchdog,
 *  restart) — `resolve` throwing `UnknownWorkspaceError` (registry drift)
 *  never escapes to the caller; it quarantines the name in its place and the
 *  caller treats the workspace step as absent for this cycle. A human's own
 *  synchronous request (registration, a quarantine/merge answer) is not this
 *  seam — those fail fast with a DomainError instead (ADR 0009). */
export function resolveOrQuarantine(
  db: Db,
  resolve: (taskWorkspace: string | null) => WorkspaceConfig,
  taskWorkspace: string | null,
  now: Date,
): WorkspaceConfig | undefined {
  try {
    return resolve(taskWorkspace);
  } catch (err) {
    if (!(err instanceof UnknownWorkspaceError)) throw err;
    quarantineWorkspace(db, err.workspaceName, err, now);
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
): void {
  try {
    releaseTree(workspace, task.id);
    if (mergeBack) refreshWorkspace(workspace, githubAuth);
    const target = mergeBack && lineageTaskBranch(db, workspace, task);
    if (target) {
      git(workspace.path, "checkout", target);
      git(workspace.path, ...TIDEPOOL_GIT_IDENTITY, "merge", taskBranch(task.id));
    }
    parkOnProtectedBranch(workspace);
  } catch (err) {
    quarantineWorkspace(db, workspace.name, err, now);
  }
}

/** ADR 0053 decision 3: apply an approved landing decision for a purely-local
 *  task. The protected branch may only move by fast-forward; divergence means
 *  an out-of-band write changed the base while the decision was pending. */
export function mergeTaskToProtected(workspace: WorkspaceConfig, taskId: string): void {
  if (isRemoteBacked(workspace)) {
    throw new Error(`workspace ${workspace.name} is remote-backed, not purely-local`);
  }
  git(workspace.path, "checkout", protectedBranch(workspace));
  git(
    workspace.path,
    ...TIDEPOOL_GIT_IDENTITY,
    "merge",
    "--ff-only",
    taskBranch(taskId),
  );
}
