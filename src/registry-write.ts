import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authedGit, type GitHubAuth } from "./github-auth.js";
import { REGISTRY_BRANCH, type RegistryMode, refreshRegistry, registryRef } from "./registry.js";
import { git, TIDEPOOL_GIT_IDENTITY } from "./workspace.js";

/** ADR 0052 決定4: registry 書き込みの入口の fetch は致命 — fetch できなければ
 *  push もできず、push 成功が「効いた」の定義である以上、その編集は最初から
 *  成立していない。 */
export class RegistryFetchFailedError extends Error {
  constructor(reason: string) {
    super(`registry could not be refreshed before the write: ${reason}`);
    this.name = "RegistryFetchFailedError";
  }
}

/** 3つの admin verb(agent/profile/workspace)がコミットより前に呼ぶ、書き込み
 *  入口の refresh 点(ADR 0052 決定2)。purely-local な盤面には fetch する先が
 *  無いので何もしない。registry の refresh はこの3点だけでタイマーは無い(決定2)
 *  ので、ここで読んだ remote-tracking ref の値は原則動かない —— `loadRegistry`
 *  が検証した内容と `commitToRegistry` が worktree を fork する内容は一致する。
 *  ただし `createWorkspace` の create/clone モードはこの間に外部処理(GitHub
 *  リポジトリ作成・clone)を await で挟むため、その間に別の書き込みが先に着地
 *  すれば ref は動きうる —— その場合は worktree がより新しい内容から fork する
 *  だけで、着地時の fast-forward 検査(`commitToRegistry`)が壊れた状態を防ぐ。 */
export function refreshRegistryForWrite(
  registryDir: string,
  registryMode: RegistryMode,
  auth: GitHubAuth | undefined,
): void {
  if (registryMode !== "remote-backed") return;
  const reachability = refreshRegistry(registryDir, auth);
  if (!reachability.available) {
    throw new RegistryFetchFailedError(reachability.reason ?? "registry remote is unreachable");
  }
}

/** ADR 0052 決定1: push(または purely-local での着地)の成功が「効いた」の定義
 *  ——失敗はここで投げる。issue #57 が非致命とした根拠(「盤面はローカル clone を
 *  読むのだから、エントリは既に効いている」)は S1 で読み取りがリモートへ移った
 *  ことで消えたため、その判断は撤回される。フローは冪等なので人間はリトライできる。 */
export class RegistryPushFailedError extends Error {
  constructor(reason: string) {
    super(`registry commit could not be landed: ${reason}`);
    this.name = "RegistryPushFailedError";
  }
}

/** ADR 0052 決定6: `write` を使い捨ての detached worktree — registry の現在の
 *  tip から切ったもの — の中だけで実行し、commit してから着地させる。registry
 *  クローン自身の working tree には一切触れない。ローカル `main` の位置も HEAD の
 *  位置も書き込みに関係しなくなり、`assertRegistryCloneReady` が守っていたものは
 *  何も無くなる(読み取りは元から working tree を見ない)。
 *
 *  `write` が何も変更しなければ(no-change 編集)着地せず、コミットも積まない —
 *  既存の admin verb が持つ no-op-resubmit の形をそのまま踏襲する。
 *
 *  着地は remote-backed なら push、purely-local(push 先が無い)ならローカル
 *  ブランチへの fast-forward-only な ref 更新 —— どちらも worktree を切った時点
 *  からの前進を要求する。fork してから着地するまでの間に base が動いていれば
 *  (別の書き込みが先に着地した)双方とも拒否するので、並行書き込みは黙って
 *  上書きされず、致命の再試行可能な失敗になる(issue #57 の冪等性)。 */
export function commitToRegistry(
  registryDir: string,
  registryMode: RegistryMode,
  auth: GitHubAuth | undefined,
  write: (worktreeDir: string) => void,
  message: string,
): void {
  // プロセス死で残った前回の worktree 管理情報の掃除(issue #210 やること4) —
  // 掃除してから add しないと、同じパスが使用中と誤認されることがある
  git(registryDir, "worktree", "prune");
  const base = registryRef(registryMode);
  const baseSha = git(registryDir, "rev-parse", base);
  const worktreeDir = mkdtempSync(join(tmpdir(), "tidepool-registry-wt-"));
  try {
    git(registryDir, "worktree", "add", "--detach", worktreeDir, base);
    write(worktreeDir);
    if (git(worktreeDir, "status", "--porcelain") === "") return;
    git(worktreeDir, "add", "-A");
    git(worktreeDir, ...TIDEPOOL_GIT_IDENTITY, "commit", "-m", message);
    land(registryDir, registryMode, worktreeDir, baseSha, auth);
  } finally {
    // ベストエフォート: ここで投げると、push/CAS が投げた本当の失敗を隠してしまう。
    // 消し損ねた分は次回の呼び出しの冒頭の `worktree prune` が拾う。
    try {
      git(registryDir, "worktree", "remove", "--force", worktreeDir);
    } catch (err) {
      console.warn(`[registry-write] worktree cleanup failed (non-fatal): ${worktreeDir}`, err);
    }
  }
}

function land(
  registryDir: string,
  registryMode: RegistryMode,
  worktreeDir: string,
  baseSha: string,
  auth: GitHubAuth | undefined,
): void {
  try {
    if (registryMode === "remote-backed") {
      authedGit(auth, worktreeDir, "push", "origin", `HEAD:${REGISTRY_BRANCH}`);
    } else {
      const newSha = git(worktreeDir, "rev-parse", "HEAD");
      // update-ref は working tree/index を素通りする — clone 自身がその
      // ブランチを指し clean なら、着地の前に見ておいて、着地後に揃える
      // (/code-review 指摘: 揃えないと、その checkout で次に走る commit が
      // 今回の着地を静かに削除してしまう)
      const syncCheckout = isCleanCheckoutOfBranch(registryDir, REGISTRY_BRANCH);
      git(registryDir, "update-ref", `refs/heads/${REGISTRY_BRANCH}`, newSha, baseSha);
      if (syncCheckout) git(registryDir, "reset", "--hard", newSha);
    }
  } catch (err) {
    throw new RegistryPushFailedError(String(err));
  }
}

/** clone 自身が `branch` を checkout していて、かつ dirty でないか。purely-local
 *  な着地(`update-ref`)の後に working tree/index を揃えてよいかの判定 — dirty
 *  だった、または他ブランチ(registry-edit タスク中など)に居た場合は触れない。
 *  その状態はこの書き込みより前から在ったかもしれず、黙って捨てる先例を
 *  作らないため。detached HEAD(このモジュール自身の worktree 書き込み中を
 *  含む一時状態)も false — symbolic-ref が非0で落ちる。 */
function isCleanCheckoutOfBranch(registryDir: string, branch: string): boolean {
  let head: string;
  try {
    head = git(registryDir, "symbolic-ref", "--quiet", "HEAD");
  } catch {
    return false;
  }
  return head === `refs/heads/${branch}` && git(registryDir, "status", "--porcelain") === "";
}
