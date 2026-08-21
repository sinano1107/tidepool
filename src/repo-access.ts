/** ADR 0093 決定8: 到達に失敗した瞬間に、その repo の installation token を仲介が
 *  出せるかだけを確かめ、出せなければ「App を install する」1手を人間に渡す —— その
 *  seam と案内。 */

import type { GitHubClient, RepoSlug } from "./github.js";
import { GITHUB_APP_SLUG } from "./github-login.js";

/** 直せなかったときに人間へ渡す一手(ADR 0093 決定8)。install のリンク1本が主で、
 *  仲介が言った理由(HTTP status + error code)が従である。
 *
 *  診断を2つ並べるのは、仲介から見て**区別できない**からである: App が install されて
 *  いない repo は user token に見えず、存在しない repo と同じ 404 に合流する(#419 の
 *  訂正コメント)。「書けるか」の門(ADR 0067 決定3)は仲介側にあるので、push を持たない
 *  人がログインしている形もここに落ちる。
 *
 *  人間向けの面なので英語(CONTEXT.md / 表示言語の正文は常に英語)。 */
function repoAccessGuidance(ref: RepoSlug, reason: string): string {
  const repo = `${ref.owner}/${ref.name}`;
  return (
    `the tidepool App is not installed on ${repo}, or you cannot push to it — ` +
    `the two are indistinguishable here. Install the App on the repository ` +
    `(only a repository admin can install it):\n\n` +
    `  https://github.com/apps/${GITHUB_APP_SLUG}/installations/new\n\n` +
    reason
  );
}

/** 修復の結果: まだ到達できないなら人間へ渡す案内。`guidance` が null なら、その repo
 *  の installation token を仲介が出せている = 盤面は書ける。 */
export interface RepoAccessRepair {
  guidance: string | null;
}

/** 3つの扉(登録の門 / pickup の失敗 / quarantine の解除)が共有する一手: いま到達したい
 *  repo の token を仲介に求め、出なければ人間向けの案内を返す(ADR 0093 決定8)。
 *
 *  盤面自身が直せる手は無くなった —— install も権限も GitHub 側の人間の操作である。
 *  撃つのは失敗経路だけで、正常時のネットワーク呼び出しは1つも増えない(ADR 0067 決定2)。 */
export async function repairRepoAccess(
  github: GitHubClient,
  ref: RepoSlug,
): Promise<RepoAccessRepair> {
  const reason = await github.tokenRefusal(ref);
  return { guidance: reason === null ? null : repoAccessGuidance(ref, reason) };
}

/** 登録の門の拒否(ADR 0067 決定3): その repo の token を仲介が出せないので clone を撃たない。
 *  read しか取れない repo を workspace にできなくなるが、read だけで完結する
 *  workspace という概念は作らない —— 監査の発見も修理タスクになり、成果は PR で
 *  着地するので push が要る。案内をそのまま message に載せるので、3枚の扉はこの
 *  1つの文字列を出すだけでよい。 */
export class RepoAccessMissingError extends Error {
  constructor(guidance: string) {
    super(guidance);
    this.name = "RepoAccessMissingError";
  }
}

/** github.com の repo を指す URL から `owner/name` を取り出す。**github.com 以外は
 *  `undefined`** で、それがそのまま「これは GitHub か」の門になる(ADR 0067 決定1):
 *  `clone` の入力欄は「anything git clone accepts」なので、非 GitHub の remote では
 *  probe が発火せず今日の生エラーのままである。
 *
 *  ADR 0052 が拒んだのは URL の**綴りの照合**(ssh / https / ホスト名の別名を別物と
 *  読む誤検出)であって、owner/name の抽出は exact な操作なのでその族ではない。 */
export function parseGitHubRepo(url: string | undefined): RepoSlug | undefined {
  const match = url?.match(GITHUB_REPO_RE);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
}

// 受ける綴りは4つ: `https://github.com/o/r(.git)` / `ssh://git@github.com/o/r` /
// `git@github.com:o/r.git` / `o/r`。接頭辞ごと省けるので bare な `o/r` も同じ式で
// 落ちる —— ローカルパスは先頭の `/` と余分な区切りで弾かれる。
const GITHUB_REPO_RE =
  /^(?:(?:https:\/\/|ssh:\/\/git@)github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/;
