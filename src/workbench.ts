import { join } from "node:path";
import { boardViewStatus, git, gitAnswers, isAncestor, workerRepoGit } from "./git.js";

// 作業台(Workbench)の鍵・持ち主・寿命の判定を1か所に置く(ADR 0382、#3352 の追記 1〜3)。入口は判定を自分で書かず、これを呼ぶ。

/** 作業台の番地の段(`CHECKOUT_LAYOUT.workbench`)。 */
const WORKBENCH_SEGMENT = "@workbench";

/** 作業台で盤面が名前の場所の branch を引き直す名前空間 `refs/heads/board/*`(ADR 0371 決定7)—— 保護ブランチはここと重ならない。 */
export const BOARD_BRANCHES = "board";

/** 運ばれる側の名前の中で番地に置けない文字の綴り —— `/` は段を、`@` は区切りを、`%` は URL の形の remote で git が解く綴りを作る。
 *  `+` は逃がしの頭なので自分も逃がす(1対1)。 */
const LEAF_ESCAPES: Record<string, string> = { "+": "++", "/": "+s", "@": "+a", "%": "+p" };

/** 作業台の書く先: task のブランチ `task/<id>`(id で)か、workspace の保護ブランチ(workspace の名前で)。 */
export type WorkbenchTarget = { task: string } | { workspace: string };

/** ADR 0382 決定1: (書く先, 運ばれる側) の作業台の番地 —— 基点 / `@workbench` / 葉。書く先 `task/<id>` の葉は `<id>@<運ばれる側>`
 *  (task id は盤面全体で一意なので workspace は要らない)、workspace の保護ブランチを書く先にする葉は `@<workspace>@<運ばれる側>`
 *  (ADR 0382 決定4 の local 着地)。運ばれる側の無い鍵(`carried` が undefined)は `@<workspace>` だけの葉 —— 人間自身の内容の作業台
 *  (ADR 0382 決定4、`take in` と purely-local の封じ込めの回答が共有する)。運ばれる側の名前
 *  (`task/<id>`・`origin/<protected>` など)は `LEAF_ESCAPES` で `/` も `@` も `%` も持たない1対1の綴りにし、workspace の名前も task id
 *  (UUID)も `@` を持たないので、どの葉も1つの段で互いに入れ子にならず、人間の clone が `ssh://` の形で remote にしても同じ在り処を指す
 *  (ADR 0371 決定9)。`@` は名前の規則にも task id にも無いので、workspace の名前・面接室(root id)・task の checkout
 *  (`<id>`・`<id>.checkout`・`<id>.reads`)のどれの番地にもならない。worker の sandbox が開くのは自分の task の checkout・task temp・
 *  読み専用の checkout だけで、基点もこの段も root にならない。 */
export const workbenchPath = (base: string, target: WorkbenchTarget, carried?: string): string =>
  join(
    base,
    WORKBENCH_SEGMENT,
    `${"task" in target ? target.task : `@${target.workspace}`}${carried === undefined ? "" : `@${carried.replace(/[+/@%]/g, (c) => LEAF_ESCAPES[c]!)}`}`,
  );

/** 盤面が読んだ作業台: 在り処、書く先の branch とその名前の場所での今の値、作業台の書く先の branch の tip(無ければ undefined —— 作りかけ)、
 *  tip の閉包と名前の場所の objects を引ける repo(盤面所有の検証済みの写し。tip が無ければ名前の場所)。 */
export type WorkbenchRead = { at: string; target: string; targetSha: string; tip: string | undefined; verified: string };

/** 入口の運ばれる側の今の値と、それが作業台の鍵に入っているか(ADR 0382 決定1・3)。 */
export type WorkbenchCarried = { sha: string; inKey: boolean };

/** 持ち主の判定: 取り込むものが無い / この入口のもの(tip が入口の運ばれる側を欠くか)/ この入口のものでない(盤面の手へ)/ 拒む。 */
export type WorkbenchOwner = { kind: "nothing" } | { kind: "mine"; lacksCarried: boolean } | { kind: "board" } | { kind: "refuse"; reason: string };

/** ADR 0382 決定2・3: 作業台の tip の持ち主。tip が書く先に含まれれば取り込むものは無い —— ただし人間の作業が残っていれば拒む。
 *  含まれなければ、鍵に運ばれる側が入っているか運ばれる側の無い入口ならその入口のもの、鍵に運ばれる側の無い作業台では tip が入口の
 *  運ばれる側を含むときだけその入口のもの。`carried` が undefined なのは運ばれる側の無い入口。`boardMove` は入口が盤面の手を持つか ——
 *  ADR 0382 決定6: 書く先の branch の無い作業台(作りかけ)は、盤面の手のある入口では取り込むものが無く、無い入口では拒む(人間が入れたと
 *  思う commit を「無い」として落とさない)。 */
export function workbenchOwner(read: WorkbenchRead, carried: WorkbenchCarried | undefined, boardMove: boolean): WorkbenchOwner {
  const { tip, verified } = read;
  if (tip === undefined && !boardMove) {
    return { kind: "refuse", reason: `the workbench at ${read.at} has no ${read.target} branch, so the board cannot tell what to take in. Open it again, then answer again.` };
  }
  if (tip === undefined || inTarget(read, tip)) {
    const left = humanWorkLeft(read);
    return left.length === 0 ? { kind: "nothing" } : { kind: "refuse", reason: `the workbench at ${read.at} has nothing new on ${read.target}, but ${left.join("; ")}. Then answer again.` };
  }
  if (!carried) return { kind: "mine", lacksCarried: false };
  const lacksCarried = !isAncestor({ path: verified }, carried.sha, tip, workerRepoGit);
  return carried.inKey || !lacksCarried ? { kind: "mine", lacksCarried } : { kind: "board" };
}

/** ADR 0382 決定2・5: 「人間の作業が残っていない」の述語 —— 作業ツリーが tip と同じで merge の途中でない、HEAD が書く先の branch、
 *  `board/*` 以外の branch と stash のどの段にも書く先に無い commit が無い。残っているものを、直し方を添えて並べる(空なら残っていない)。
 *  tip が書く先に含まれることは呼び手が先に確かめる。書く先の branch が無い作りかけ(init の後の HEAD は `main`)は、比べる tip も
 *  居るべき branch も無いので作業ツリーと HEAD を見ない —— 人間の commit は branch と stash が数える。 */
function humanWorkLeft(read: WorkbenchRead): string[] {
  const { at, target, tip } = read;
  const left: string[] = [];
  if (gitAnswers(() => workerRepoGit(at, "rev-parse", "--quiet", "--verify", "MERGE_HEAD"))) left.push(`a merge is in progress — commit it on ${target} or run \`git merge --abort\``);
  if (tip !== undefined) {
    if (boardViewStatus(at, tip, read.verified).length > 0) left.push(`it has uncommitted changes — commit them on ${target} or discard them`);
    if (!headOn(at, target)) left.push(`its HEAD is not on ${target} — check out ${target} there`);
  }
  const strays = workerRepoGit(at, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/stash")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ") as [string, string])
    .filter(([, ref]) => ref !== `refs/heads/${target}` && !ref.startsWith(`refs/heads/${BOARD_BRANCHES}/`))
    // stash は reflog の段ごとに1つ —— `refs/stash` は一番上の段しか指さない
    .filter(([sha, ref]) => (ref === "refs/stash" ? workerRepoGit(at, "reflog", "show", "--format=%H", "refs/stash").split("\n") : [sha]).some((commit) => !inTarget(read, commit)))
    .map(([, ref]) => (ref === "refs/stash" ? "the stash" : ref.slice("refs/heads/".length)));
  if (strays.length > 0) left.push(`${strays.join(", ")} ${strays.length > 1 ? "hold" : "holds"} commits that ${target} does not have — merge them into ${target}, or delete them`);
  return left;
}

/** ADR 0382 決定4: 作業台の tip が持つ、`excluded`(書く先の今の値と答えている task の tip)のどれにも無い commit を含む task のブランチ ——
 *  数えるブランチ(名前 → sha)は呼び手が渡す。tip の commit は盤面所有の検証済みの写し `verified` の中で数え(ADR 0371 決定4 —— 人間の
 *  commit は名前の場所にまだ無い)、task のブランチに載るものだけを名前の場所 `named` に1度問う(そこにはある)。
 *  shortcut: 数えるブランチの sha を argv で渡す —— 1つの workspace の task が数千を超えて argv の上限に近づけば `--stdin` で渡す。 */
export function foreignTaskBranches(verified: string, named: string, tip: string, excluded: string[], branches: Map<string, string>): string[] {
  if (branches.size === 0) return [];
  const beyond = (...more: string[]) => workerRepoGit(verified, "rev-list", tip, ...[...excluded, ...more].map((sha) => `^${sha}`)).split("\n").filter(Boolean);
  const onNoTaskBranch = new Set(beyond(...branches.values()));
  const foreign = beyond().filter((commit) => !onNoTaskBranch.has(commit));
  if (foreign.length === 0) return [];
  // 複数の `--contains` はどれかを含む ref を並べる
  const containing = git(named, "for-each-ref", "--format=%(refname:strip=2)", ...foreign.map((commit) => `--contains=${commit}`), "refs/heads/task/");
  return containing.split("\n").filter((branch) => branches.has(branch));
}

/** `sha` が書く先の今の値に含まれる —— 写しに無い object は名前の場所にも無いので含まれない。 */
const inTarget = ({ verified, targetSha }: WorkbenchRead, sha: string): boolean =>
  gitAnswers(() => workerRepoGit(verified, "cat-file", "-e", sha)) && isAncestor({ path: verified }, sha, targetSha, workerRepoGit);

/** HEAD が書く先の branch を指す symref か —— `symbolic-ref -q` の 1 は detached。 */
function headOn(at: string, target: string): boolean {
  let head = "";
  return gitAnswers(() => (head = workerRepoGit(at, "symbolic-ref", "-q", "HEAD"))) && head === `refs/heads/${target}`;
}
