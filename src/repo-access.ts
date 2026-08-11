/** ADR 0067: 到達に失敗した瞬間に、いま到達したい repo 宛ての招待1枚だけを受諾して
 *  直す —— その1手を成す seam と、直せなかったときの人間向けの案内。 */

import type { GitHubClient, RepoPermission, RepoSlug } from "./github.js";

/** WRITE 以上か(ADR 0067 決定3)。合格条件を「見える」ではなく「書ける」に置くのが
 *  この issue の芯である —— `read` の招待は受諾も clone も通してしまい、失敗は PR 昇格
 *  という遠い場所に出る(実測4)。`null`(見えない)も当然 false。 */
function canWrite(permission: RepoPermission | null): boolean {
  return permission === "WRITE" || permission === "MAINTAIN" || permission === "ADMIN";
}

/** ADR 0067 決定1 の seam: **いま到達したい repo** 宛ての pending 招待だけを受諾し、
 *  repo 側の権限を返す。受信箱の掃除はしない —— 一致しない招待は受諾も辞退もしない。
 *
 *  範囲をこの1枚に絞るのは、任意の第三者からの招待を無条件に受ければ盤面の到達範囲が
 *  盤面の知らない理由で黙って広がるからである。3つの扉(登録の門 / pickup の失敗 /
 *  quarantine の解除)すべてがこの同じ規則を共有する。 */
export async function ensureRepoAccess(
  github: GitHubClient,
  ref: RepoSlug,
): Promise<{ permission: RepoPermission | null; accepted: boolean }> {
  const permission = await github.getRepositoryPermission(ref);
  // 既に書けるなら受信箱は読まない —— 正常時に呼び出しを増やさない側の線でもある
  if (canWrite(permission)) return { permission, accepted: false };
  const wanted = `${ref.owner}/${ref.name}`.toLowerCase();
  const invitations = await github.listRepositoryInvitations();
  const mine = invitations.filter((i) => i.fullName.toLowerCase() === wanted);
  if (mine.length === 0) return { permission, accepted: false };
  for (const invitation of mine) await github.acceptRepositoryInvitation(invitation.id);
  return { permission: await github.getRepositoryPermission(ref), accepted: true };
}

/** 直せなかったときに人間へ渡す一手(ADR 0067 決定4)。一行コマンドが主でリンクが従 ——
 *  実測6 により、未 collaborator なら招待が出て、READ の collaborator なら即時に昇格
 *  するので、**1つのコマンドが両方の状況を直す**。
 *
 *  人間向けの面なので英語(CONTEXT.md / 表示言語の正文は常に英語)。`login` は
 *  `gh api user --jq .login` の実測値であって定数ではない —— ずれると人間は違う相手を
 *  招待することになる。 */
export function repoAccessGuidance(
  ref: RepoSlug,
  login: string,
  permission: RepoPermission | null,
): string {
  const repo = `${ref.owner}/${ref.name}`;
  // 見えない側は「無い」と「見えていない」を区別できない(実測7)ので両方を言う
  const diagnosis =
    permission === null
      ? `${repo} either does not exist or is not visible to ${login}`
      : `${login} only has ${permission} on ${repo} — not enough to push or open a pull request`;
  return (
    `${diagnosis}. Grant write access with:\n\n` +
    `  gh api -X PUT repos/${repo}/collaborators/${login} -f permission=push\n\n` +
    `or from https://github.com/${repo}/settings/access`
  );
}

/** 修復の結果: 受諾が起きたか(= 撃ち直す価値があるか)と、まだ書けないなら人間へ
 *  渡す案内。`guidance` が null なら書けるようになっている。 */
export interface RepoAccessRepair {
  accepted: boolean;
  guidance: string | null;
}

/** 3つの扉(登録の門 / pickup の失敗 / quarantine の解除)が共有する一手: 招待1枚で
 *  直せるなら直し、それでも書けなければ人間向けの案内を返す。書けるようになったなら
 *  `guidance` は null である。
 *
 *  `login()` は落ちたときにしか撃たない —— 正常時のネットワーク呼び出しを1つも
 *  増やさないのがこの issue の不変条件だからである。 */
export async function repairRepoAccess(
  github: GitHubClient,
  ref: RepoSlug,
): Promise<RepoAccessRepair> {
  const { permission, accepted } = await ensureRepoAccess(github, ref);
  if (canWrite(permission)) return { accepted, guidance: null };
  return { accepted, guidance: repoAccessGuidance(ref, await github.login(), permission) };
}

/** 登録の門の拒否(ADR 0067 決定3): その repo に WRITE が無いので clone を撃たない。
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
 *  probe も受諾も発火せず今日の生エラーのままである。
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
