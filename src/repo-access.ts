/** ADR 0093 決定8: 到達に失敗した瞬間に、その repo の installation token を仲介が
 *  出せるかだけを確かめ、出せなければ「App を install する」1手を人間に渡す —— その
 *  seam と案内。あわせて repo の表示(`repositoryLabel`)・同一性(`parseGitHubRepo` / `sameRepository`)と、
 *  宣言の repo が資格情報を持つかの判定(ADR 0406)を置く。 */

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
 *  人間向けの面なので英語(GLOSSARY.md / 表示言語の正文は常に英語)。 */
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

/** Strip embedded credentials and URL secrets: the user part, password, query and fragment of a URL, and the
 *  password, query and fragment of the scp form. A Git repair command needs the SSH login. */
export function repositoryLabel(repo: string, { preserveSshUser = false } = {}): string {
  const origin = repo.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(origin)) {
    try {
      const url = new URL(origin);
      const sshUser = preserveSshUser && url.protocol === "ssh:" && url.username ? `${url.username}@` : "";
      if (preserveSshUser && !url.password && !url.search && !url.hash && (!url.username || sshUser)) return repo;
      return `${url.protocol}//${sshUser}${url.host}${url.pathname}`;
    } catch {
      return "an unparseable repository URL";
    }
  }
  if (!SCP_FORM.test(origin)) return preserveSshUser ? repo : origin;
  if (preserveSshUser && !carriesCredential(origin)) return repo;
  // ADR 0406 決定3: 表示は判定が拒む部分(`@` の前の password・query・fragment)を持たない。修理の命令に要る ssh のログイン名は残す
  const [, user, rest] = origin.match(/^(?:([^:/@]*)(?::[^/]*)?@)?([^?#]*)/)!;
  return preserveSshUser && user ? `${user}@${rest}` : rest!;
}

// scheme の無い値は、最初の `/` より前に `:` があれば scp 形 `[user@]host:path`(git がローカル path と分ける読み)
const SCP_FORM = /^[^/]*:/;

/** ADR 0406 決定3: 宣言の repo(`repo` / `head_repo`)の値が資格情報を持つか —— registry の読み込みと publish・clone・register の
 *  扉が使う1つの判定。どの scheme でも password・query・fragment、ssh 以外の scheme の user 部分を秘密と読む(GitHub は
 *  `https://<token>@github.com/…` を user 部分だけで token として受ける)。ssh のログイン名とローカル path は通す。 */
export function carriesCredential(repo: string): boolean {
  const value = repo.trim();
  const schemed = value.match(/^(?<scheme>[a-z][a-z\d+.-]*):\/\/(?<authority>[^/?#]*)/i)?.groups;
  if (schemed) {
    const { scheme, authority } = schemed as { scheme: string; authority: string };
    const userinfo = authority.slice(0, Math.max(authority.lastIndexOf("@"), 0));
    return /[?#]/.test(value) || userinfo.includes(":") || (userinfo !== "" && scheme.toLowerCase() !== "ssh");
  }
  // scp 形では、最初の `/` より前の `@` の手前の `:` が password
  return SCP_FORM.test(value) && (/[?#]/.test(value) || /^[^/]*:[^/]*@/.test(value));
}

/** ADR 0406 決定1: 宣言の repo になる値が資格情報を持つので拒んだ。文は扉ごとに組み、値は `repositoryLabel` を通したものだけを出す。 */
export class RepoCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoCredentialError";
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
  const match = url?.trim().match(GITHUB_REPO_RE);
  return match ? { owner: match[1]!.toLowerCase(), name: match[2]!.toLowerCase() } : undefined;
}

// ADR 0378 決定4: HTTPS の userinfo と末尾の / も repo の同一性に影響しない。
const GITHUB_REPO_RE =
  /^(?:(?:https:\/\/(?:[^\s/@]+@)?|ssh:\/\/git@)github\.com\/|git@github\.com:)?([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** ADR 0378 決定4: GitHub identity ignores URL spelling; other repositories compare as written. */
export function sameRepository(first: string | undefined, second: string | undefined): boolean {
  if (first === second) return true;
  const a = parseGitHubRepo(first);
  const b = parseGitHubRepo(second);
  return a !== undefined && b !== undefined && a.owner === b.owner && a.name === b.name;
}
