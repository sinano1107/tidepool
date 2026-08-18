import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authedGit, type GitHubAuth } from "./github-auth.js";
import { REGISTRY_BRANCH, type RegistrySource, refreshRegistry, registryRef } from "./registry.js";
import { git } from "./workspace.js";

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
export function refreshRegistryForWrite(registry: RegistrySource, auth: GitHubAuth | undefined): void {
  if (registry.mode !== "remote-backed") return;
  const reachability = refreshRegistry(registry.dir, auth);
  if (!reachability.available) {
    throw new RegistryFetchFailedError(reachability.reason ?? "registry remote is unreachable");
  }
}

/** ADR 0087 の削除の扉が、確認なしの要求に返す拒否。3つの admin モジュール
 *  (agent / profile / workspace)で共有する —— 削除は資源によらず同じ1つの理由
 *  で確認を要求するので、資源ごとにクラスを分ける意味が無い。危険な値の確認
 *  (ADR 0061 決定1)と同じく執行はドメインの verb 内に1箇所、API は 409
 *  `confirm_required` に写す。理由コードは WebUI の確認ダイアログがそのまま
 *  列挙できるよう、危険な値と同じ「安定文字列」の流儀で運ぶ。 */
export type DeletionResource = "agent" | "workspace" | "authority profile";

export class DeletionConfirmationRequiredError extends Error {
  /** 危険な値の 409 と同じ形の理由コード配列にするための1要素 —— WebUI の
   *  `useDangerousSave` は `dangerous_values` を配列として読むので、削除も同じ
   *  器に載せれば確認ダイアログを作り直さずに済む。 */
  readonly reasons: string[];
  constructor(
    resource: DeletionResource,
    public readonly resourceName: string,
  ) {
    super(`deleting ${resource} "${resourceName}" requires human confirmation`);
    this.name = "DeletionConfirmationRequiredError";
    this.reasons = [`delete_${resource === "authority profile" ? "profile" : resource}`];
  }
}

/** 確認では買えない削除の拒否(ADR 0087 決定2/3): 参照中・盤面の既定。理由は
 *  件数や agent 名という**明細つき**で返る必要があるので、危険な値の裸の文字列
 *  ではなく判別可能なオブジェクトの列にする。盤面自身の registry clone だけは
 *  別クラス(`RegistrySelfDeleteError` — 出し直しでも状況が変わっても決して通ら
 *  ないので 403、`RegistrySelfUnprotectError` と同じ扱い)。 */
export type DeletionBlockedReason =
  | { code: "unsettled_tasks"; count: number }
  | { code: "board_default" }
  | { code: "referenced_by_agents"; agents: string[] };

export class DeletionBlockedError extends Error {
  constructor(
    resource: DeletionResource,
    resourceName: string,
    public readonly reasons: DeletionBlockedReason[],
  ) {
    super(`${resource} "${resourceName}" cannot be deleted: ${reasons.map(describeReason).join("; ")}`);
    this.name = "DeletionBlockedError";
  }
}

function describeReason(reason: DeletionBlockedReason): string {
  if (reason.code === "unsettled_tasks") {
    return `${reason.count} unsettled task(s) still reference it`;
  }
  if (reason.code === "board_default") return "it is the board's default";
  return `authority of agent(s): ${reason.agents.join(", ")}`;
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
 *  クローン自身の working tree は書き込みの間ずっと無関係のまま —— ローカル
 *  `main` の位置も HEAD の位置も書き込みの成否に関係しなくなり、
 *  `assertRegistryCloneReady` が守っていたものは何も無くなる(読み取りは元から
 *  working tree を見ない)。purely-local な着地だけは、clone 自身がその
 *  ブランチを指しているとき例外的に working tree/index へ触れる —
 *  `syncCheckoutIfOnBranch` 参照(ベストエフォートの後始末であって、書き込みの
 *  成立条件ではない)。
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
  registry: RegistrySource,
  auth: GitHubAuth | undefined,
  write: (worktreeDir: string) => void,
  message: string,
): void {
  // プロセス死で残った前回の worktree 管理情報の掃除(issue #210 やること4) —
  // 掃除してから add しないと、同じパスが使用中と誤認されることがある
  git(registry.dir, "worktree", "prune");
  const base = registryRef(registry.mode);
  const baseSha = git(registry.dir, "rev-parse", base);
  const worktreeDir = mkdtempSync(join(tmpdir(), "tidepool-registry-wt-"));
  try {
    git(registry.dir, "worktree", "add", "--detach", worktreeDir, base);
    write(worktreeDir);
    if (git(worktreeDir, "status", "--porcelain") === "") return;
    git(worktreeDir, "add", "-A");
    git(worktreeDir, "commit", "-m", message);
    land(registry, worktreeDir, baseSha, auth);
  } finally {
    // ベストエフォート: ここで投げると、push/CAS が投げた本当の失敗を隠してしまう。
    // 消し損ねた分は次回の呼び出しの冒頭の `worktree prune` が拾う。
    try {
      git(registry.dir, "worktree", "remove", "--force", worktreeDir);
    } catch (err) {
      console.warn(`[registry-write] worktree cleanup failed (non-fatal): ${worktreeDir}`, err);
    }
  }
}

function land(registry: RegistrySource, worktreeDir: string, baseSha: string, auth: GitHubAuth | undefined): void {
  try {
    if (registry.mode === "remote-backed") {
      authedGit(auth, worktreeDir, "push", "origin", `HEAD:${REGISTRY_BRANCH}`);
    } else {
      const newSha = git(worktreeDir, "rev-parse", "HEAD");
      git(registry.dir, "update-ref", `refs/heads/${REGISTRY_BRANCH}`, newSha, baseSha);
      syncCheckoutIfOnBranch(registry.dir, REGISTRY_BRANCH, baseSha, newSha);
    }
  } catch (err) {
    throw new RegistryPushFailedError(String(err));
  }
}

/** update-ref は working tree/index を素通りする — clone 自身がその
 *  ブランチを指しているなら、着地後に `read-tree -m -u <base> <new>`(2-tree
 *  マージ)で working tree/index を揃える(/code-review 指摘: 揃えないと、
 *  その checkout で次に走る commit が今回の着地を静かに削除してしまう)。
 *
 *  事前に clean かどうかを判定して丸ごとスキップする形は採らない —— それだと
 *  「今回の着地と衝突しない dirty」まで一律で古いままにしてしまう
 *  (/code-review 再指摘)。`read-tree -m -u` は base→new の差分に触れていない
 *  ローカルの未コミット変更(index にも working tree にも)を保持したまま
 *  反映し、ローカル編集が着地内容と衝突する場合(または衝突する untracked
 *  ファイルがある場合)だけ working tree を一切変更せずに失敗する —— 実測済み。
 *  失敗はベストエフォート: 着地(ref の更新)自体は既に成立しているので、
 *  揃え損ねても書き込みの成否には影響しない(read-tree の失敗はここで
 *  catch して警告するだけ — 呼び出し元の `land` まで投げない。投げてしまうと
 *  「ref の更新は成功したのに致命エラーとして報告される」という、決定1が
 *  一致させたいはずの「着地成功 = 効いた」を自ら壊す)。clone が detached
 *  HEAD、または registry-edit タスクのブランチなど別ブランチを指している
 *  場合は symbolic-ref か branch 比較で弾かれ、何もしない —— このモジュール
 *  自身が切る使い捨て worktree は clone とは別ディレクトリなので、clone 側の
 *  HEAD をこの関数が detached にすることはない。 */
function syncCheckoutIfOnBranch(registryDir: string, branch: string, baseSha: string, newSha: string): void {
  let head: string;
  try {
    head = git(registryDir, "symbolic-ref", "--quiet", "HEAD");
  } catch {
    return;
  }
  if (head !== `refs/heads/${branch}`) return;
  try {
    git(registryDir, "read-tree", "-m", "-u", baseSha, newSha);
  } catch (err) {
    console.warn(`[registry-write] checkout sync skipped (non-fatal): ${registryDir}`, err);
  }
}
