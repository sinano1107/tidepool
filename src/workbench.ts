import { join } from "node:path";
import { boardViewStatus, isAncestor, workerRepoGit } from "./git.js";

// 作業台(Workbench)の鍵・持ち主・寿命の判定を1か所に置く(ADR 0382、#3352 の追記 1〜3)。入口は判定を自分で書かず、これを呼ぶ。

/** 作業台の番地の段(`CHECKOUT_LAYOUT.workbench`)。 */
export const WORKBENCH_SEGMENT = "@workbench";

/** 作業台で盤面が名前の場所の branch を引き直す名前空間 `refs/heads/board/*`(ADR 0371 決定7)—— 保護ブランチはここと重ならない。 */
export const BOARD_BRANCHES = "board";

/** 運ばれる側の名前の中で番地に置けない文字の綴り —— `/` は段を、`@` は区切りを、`%` は URL の形の remote で git が解く綴りを作る。
 *  `+` は逃がしの頭なので自分も逃がす(1対1)。 */
const LEAF_ESCAPES: Record<string, string> = { "+": "++", "/": "+s", "@": "+a", "%": "+p" };

/** ADR 0382 決定1: (書く先 `task/<id>`, 運ばれる側) の作業台の番地 —— 基点 / `@workbench` / `<id>@<運ばれる側>`。運ばれる側の名前
 *  (`task/<id>`・`origin/<protected>` など)は `LEAF_ESCAPES` で `/` も `@` も `%` も持たない1対1の綴りにするので、どの葉も1つの段で
 *  互いに入れ子にならず、人間の clone が `ssh://` の形で remote にしても同じ在り処を指す(ADR 0371 決定9)。task id は盤面全体で一意
 *  なので workspace は要らない。`@` は名前の規則にも task id(UUID)にも無いので、workspace の名前・面接室(root id)・task の checkout
 *  (`<id>`・`<id>.checkout`・`<id>.reads`)のどれの番地にもならない。worker の sandbox が開くのは自分の task の checkout・task temp・
 *  読み専用の checkout だけで、基点もこの段も root にならない。
 *  shortcut: 書く先は `task/<id>` で運ばれる側を持つ鍵だけ —— 保護ブランチの書く先と運ばれる側の無い鍵はその入口を足す slice が足す。 */
export const workbenchPath = (base: string, target: string, carried: string): string =>
  join(base, WORKBENCH_SEGMENT, `${target.slice("task/".length)}@${carried.replace(/[+/@%]/g, (c) => LEAF_ESCAPES[c]!)}`);

/** 盤面が読んだ作業台: 在り処、書く先の branch とその名前の場所での今の値、作業台の書く先の branch の tip(無ければ undefined —— 作りかけ)、
 *  tip の閉包と名前の場所の objects を引ける repo(盤面所有の写し)。 */
export type WorkbenchRead = { at: string; target: string; targetSha: string; tip: string | undefined; objects: string };

/** 入口の運ばれる側の今の値と、それが作業台の鍵に入っているか(ADR 0382 決定1・3)。 */
export type WorkbenchCarried = { sha: string; inKey: boolean };

/** 持ち主の判定: 取り込むものが無い / この入口のもの / この入口のものでない(盤面の手へ)/ 拒む。 */
export type WorkbenchOwner = { kind: "nothing" } | { kind: "mine" } | { kind: "board" } | { kind: "refuse"; reason: string };

/** ADR 0382 決定2・3: 作業台の tip の持ち主。tip が書く先に含まれれば取り込むものは無い —— ただし人間の作業が残っていれば拒む。
 *  含まれなければ、鍵に運ばれる側が入っているか運ばれる側の無い入口ならその入口のもの、鍵に運ばれる側の無い作業台では tip が入口の
 *  運ばれる側を含むときだけその入口のもの。`carried` が undefined なのは運ばれる側の無い入口。 */
export function workbenchOwner(read: WorkbenchRead, carried: WorkbenchCarried | undefined): WorkbenchOwner {
  const { tip, objects } = read;
  if (tip === undefined || inTarget(read, tip)) {
    const left = humanWorkLeft(read);
    return left.length === 0 ? { kind: "nothing" } : { kind: "refuse", reason: `the workbench at ${read.at} has nothing new on ${read.target}, but ${left.join("; ")}. Then answer again.` };
  }
  if (!carried || carried.inKey || isAncestor({ path: objects }, carried.sha, tip, workerRepoGit)) return { kind: "mine" };
  return { kind: "board" };
}

/** ADR 0382 決定2・5: 「人間の作業が残っていない」の述語 —— 作業ツリーが tip と同じ、HEAD が書く先の branch、`board/*` 以外の branch と
 *  stash に書く先に無い commit が無い。残っているものを、直し方を添えて並べる(空なら残っていない)。tip が書く先に含まれることは呼び手が
 *  先に確かめる。書く先の branch が無ければ作業ツリーは比べる tip が無いので見ない。
 *  shortcut: stash は `refs/stash`(一番上)だけを見る —— 一番上が書く先に入った stash の下の段は数えない。 */
function humanWorkLeft(read: WorkbenchRead): string[] {
  const { at, target, tip, objects } = read;
  const left: string[] = [];
  if (tip !== undefined && boardViewStatus(at, tip, objects).length > 0) left.push(`it has uncommitted changes — commit them on ${target} or discard them`);
  if (!headOn(at, target)) left.push(`its HEAD is not on ${target} — check out ${target} there`);
  const strays = workerRepoGit(at, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/stash")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ") as [string, string])
    .filter(([sha, ref]) => ref !== `refs/heads/${target}` && !ref.startsWith(`refs/heads/${BOARD_BRANCHES}/`) && !inTarget(read, sha))
    .map(([, ref]) => (ref === "refs/stash" ? "the stash" : ref.slice("refs/heads/".length)));
  if (strays.length > 0) left.push(`${strays.join(", ")} ${strays.length > 1 ? "hold" : "holds"} commits that ${target} does not have — merge them into ${target}, or delete them`);
  return left;
}

/** `sha` が書く先の今の値に含まれる —— 写しに無い object は名前の場所にも無いので含まれない。 */
function inTarget({ objects, targetSha }: WorkbenchRead, sha: string): boolean {
  try {
    workerRepoGit(objects, "cat-file", "-e", sha);
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err;
    return false;
  }
  return isAncestor({ path: objects }, sha, targetSha, workerRepoGit);
}

function headOn(at: string, target: string): boolean {
  try {
    return workerRepoGit(at, "symbolic-ref", "-q", "HEAD") === `refs/heads/${target}`;
  } catch (err) {
    if ((err as { status?: number } | null)?.status !== 1) throw err; // 1 は detached
    return false;
  }
}
