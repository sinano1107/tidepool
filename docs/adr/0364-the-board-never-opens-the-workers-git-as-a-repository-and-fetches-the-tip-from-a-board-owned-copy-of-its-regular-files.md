# 盤面は worker の `.git` をリポジトリとして開かない —— regular file だけを盤面所有の repo に写し、tip はそこから fetch する

**Status 追記: 決定2 の「verb なら ADR 0359 決定4 の拒むだけ」は、worker が直せない名前の場所の側と host の失敗では failure question を登録して session を回収する形に変わる([ADR 0424](0424-an-agent-verb-refuses-only-what-the-agent-can-fix-otherwise-the-board-registers-a-failure-question-and-reclaims-the-session.md) 決定2・3、2026-11-26、issue #3861)。**

**Status 追記: 決定2 の「上限超過は worker の repo の故障のまま」は、記録の byte と確かめていない byte を1度に辿る手(fetch・入れ直し・履歴の比較)の決定として保つ。記録の byte だけで読める部分は上限なしの手に分ける([ADR 0423](0423-a-bounded-git-call-reads-bytes-not-yet-verified-into-the-record-and-what-reads-only-the-record-runs-unbounded.md) 決定3・4、2026-11-26、issue #3855)。**

**Status 追記: 決定1 の「work / review は写しの alternates を名前の場所に向ける」と、決定2 の検証の段の帰責の追記(#3495 の確かめ直し、#3501 の入れ直しへ進める分岐)は要らなくなる —— task の checkout と作業台は複製で、検証は4つの役とも閉包が全部写しの中で解けることを要求し、帰責は落ちた手でなく段で決まる。作業台は、検証を通った盤面所有の写しに名前の場所を借りさせて比べる([ADR 0411](0411-task-checkouts-and-workbenches-do-not-borrow-the-named-places-objects-they-are-copies-holding-their-whole-closure-and-blame-follows-the-stage.md) 決定1〜3、2026-11-24、issue #3734)。**

**Status 追記: 決定2 の検証の段の帰責 —— 名前の場所を借りる役で `index-pack --strict` が落ち、worker の byte を名前の場所を借りずに確かめ直して揃い(中身から作った id が pack に入れた object を全部覆う)、名前の場所が pack の外の object を読めなければ、名前の場所の失敗である(2026-11-22、issue #3495)。**

**Status 追記: 検証の段で、名前の場所が解けない除外側の link を checkout の自前の store が満たすとき(新しい tree が直に指す自前の object)は、拒まずに ADR 0388 決定2 の入れ直しへ進める([ADR 0398](0398-the-board-guards-what-the-carried-place-made-and-not-the-named-places-outside-damage-before-or-after-carrying.md) 決定1、2026-11-21、issue #3501)。**

**Status 追記: 名前の場所へ fetch した直後に、checkout が自前で持つ tip の閉包の object が名前の場所で欠けも破損も無く読めることを確かめる。名前の場所に commit が既にあって object だけが欠けているとき fetch は何も送らないので、欠けは検証済みの写しの pack を名前の場所で直に `index-pack --strict` して補う。決定1 の除外(`--not --alternate-refs`)は変えない([ADR 0388](0388-carrying-into-the-named-place-is-done-only-when-the-objects-the-carried-place-holds-read-whole-there-and-later-outside-damage-is-not-guarded.md) 決定1・2・3、2026-11-21、issue #3222)。**

**Status 追記: 決定1 の不変条件「記録に入る object は、名前の場所に既にあるか、worker が自分の checkout の `objects/` に regular file として書いたもののみ」に項が足される —— 人間が作業台に書いた object と、取り込みで盤面が作る包む commit も記録に入る。作業台の tip も同じ手(regular file を盤面所有の repo に写し、検証してから fetch)で読む([ADR 0371](0371-a-human-writes-in-a-workbench-the-board-opens-and-the-board-takes-its-tip-in-through-the-answers-that-already-exist.md) 決定2・4、2026-11-15、issue #3178)。**

**Status 追記: 決定2 の3段の帰責は tip の転送だけでなく WIP の退避にも当たる —— view は worktree を盤面所有の repo に stage し、名前の場所へは同じ fetch で運ぶ([ADR 0367](0367-the-wip-evacuation-is-attributed-by-stage-the-worktree-is-staged-in-a-board-owned-repo-and-fetched-into-the-named-place.md) 決定1・5、2026-11-10、issue #3141)。**

**Status 追記: 決定1 の閉包の検証(到達可能性)は gitlink の参照先を見ない —— git の到達可能性は gitlink を辿らないので、参照先がどこにも無い gitlink でも閉包は解ける。記録の外を指す entry は完了の門が fork 元との差で拒み、入れ子の repo の中身は運ばない([ADR 0365](0365-the-record-closes-within-one-repo-and-the-completion-gate-rejects-a-tip-that-adds-or-advances-a-gitlink-from-the-fork-source.md)、2026-11-09、issue #3052)。**

**Status 追記: 入れ子の `.git` も worker が書いたリポジトリ定義で、view の `add -A` / `status` は gitlink の値を決めるためにそれを開いていた(#3097 の棚卸しが「変更なし」とした行)。view は入れ子の repo を除き、gitlink の値は記録から読む([ADR 0365](0365-the-record-closes-within-one-repo-and-the-completion-gate-rejects-a-tip-that-adds-or-advances-a-gitlink-from-the-fork-source.md) 決定3、2026-11-09、issue #3117)。**

2026-11-09 の grilling(issue #3097、#3084 のレビューの派生)で決定。ADR 0360 決定2 の後も、盤面が worker の repo に撃つ手が1つ残っていた ——
解放・完了の門・出題の写しが tip を引く `ls-remote` / `fetch` で、local path への fetch は送り側の `upload-pack` を **worker の `.git` の中で、
非 sandbox の盤面ユーザーとして**走らせる。ADR 0356 決定3 が保証したのは `upload-pack` の入力のうち config 1つ(protected config)で、git が
「この `.git` は何か」を解く残りの入力 —— **リポジトリ定義**: `.git` が dir か `gitdir:` file か symlink か、`objects/` と `refs/` と ref file が
regular か symlink か、`objects/info/alternates`、`packed-refs` —— は全部 worker が書ける(work の床は `.git` = write、ADR 0033)。worker が
ポインタを書けば、盤面ユーザーの `upload-pack` がそれを辿り、盤面が読めて worker が読めない object store(他 workspace の名前の場所・registry
clone・盤面自身の repo)の object を名前の場所へ送り、`cat-file -e` が通るので外部 sha が `task/<id>` として記録され merge back が祖先へ運ぶ
(Mac の一時 repo で alternates 追記・`gitdir:`・ref symlink の3形とも成立)。読み取り隔離だけでなく記録の信頼に当たる。書き手側で閉じる形は
ポインタ3種だけを拒む denylist で(worker の `git commit` は `objects/` と `refs/` を書かねばならない)、symlink の作成は path では拒めない。
実測の表・盤面が checkout の `.git` に触る箇所の棚卸し・`file:line` は #3097 のコメントに置く。

## 決定

1. **盤面は spawn の後、task の checkout の `.git` を git にリポジトリとして開かせない。** 読むのは allowlist の regular file だけ(`lstat` で
   regular を確かめ、symlink を辿らずに開く): `refs/heads/task/<id>` の file、無ければ `packed-refs` の行(worker の `gc` は正当に pack する)、
   `objects/[0-9a-f]{2}/` の loose、`objects/pack/` の `.pack`(`.idx` は写さず作り直す)。途中の dir(`.git`・`refs/heads/task`・
   `objects/xx`・`objects/pack`)も `lstat` で dir であることを確かめ、完了の門は worker が生きている最中に読むので、Linux では open した
   file の実体(`/proc/self/fd`)が checkout の下にあることも確かめる(盤面が worker を拾う host は Linux だけ、ADR 0100 決定6)。盤面所有の
   使い捨ての `.git` に byte で写し(hardlink は inode を worker と共有する)、**tip の閉包の全 object の内容と到達可能性を写しの中で検証して
   から、名前の場所はその盤面所有の repo から fetch する**(fetch の旗は今日のまま)。写しの alternates は work / review(名前の場所の
   objects を借りる役)だけ名前の場所に向け、複製で走る Interview の2役は閉包が全部写しの中で解けることを要求する —— 受験者が sha を
   言い当てても兄弟の答案は記録に入らない(ADR 0276 決定1 を記録側でも保つ。面接室は小さい、ADR 0356 決定2)。symref・symlink・`.git` が
   dir でない形・閉包が解けない / 内容が合わない形は worker の repo の故障。不変条件: **記録に入る object は、名前の場所に既にあるか、
   worker が自分の checkout の `objects/` に regular file として書いたもののみ**。4つの役とも同じ1つの手。共有の「checkout が消えた」述語
   (面接室・名前の場所も使う)は触らず、写す段が自分で確かめる。tip が fork 元と無関係な commit でもよいのは今日どおり —— worker が読める
   object だけで作れる。
2. **帰責は段で分ける。** checkout の file を盤面の repo に写し tip が解けることを確かめる段の失敗は worker の repo の故障(決着していない
   task なら task の失敗、`done` なら ADR 0359 決定3 の観測)。盤面の repo から名前の場所へ fetch し ref を書く段の失敗は名前の場所の側
   (解放なら quarantine、verb なら ADR 0359 決定4 の拒むだけ)。#3061 の「読めたのに書けない」が worker の故障になる共通 catch はこの
   分割で消える。**写しを作る host の失敗**(tmp の `mkdtemp` / `init` / ENOSPC)は第3の段で、worker でも名前の場所でもない —— pickup の
   `TaskCheckoutHostError` と同じ線で、決着していない task なら task の失敗(retry 推奨、checkout は残す)、完了済みなら今日どおり名前の場所の
   quarantine で checkout を残す(唯一の写しを消さずに止める器が他に無い、#3053)。verb の時点では名前の場所の側と同じく拒むだけ(ADR 0359 決定4)。ADR 0357 決定2 の上限超過は worker の repo の故障のまま。
3. **有界の対象は path の持ち主でなく byte の出所。** ADR 0357 決定1 の「cwd か引数が task の checkout の git」は、決定1 の後は「worker が
   書いた byte を読む git」—— 写しの中の検証(`pack-objects` / `index-pack --strict`)と、盤面所有の写しからの fetch を含む。file の写しも同じ上限の中に
   置く —— サイズでは縛れない(sparse file は disk をほぼ使わずに byte copy だけを膨らませる)ので時間で縛り、超過は決定2 の worker の repo の
   故障。正当な写しは小さい: `git gc` は `repack -l` で alternates 側を pack に入れず、面接室は小さい。`lstat` 先行で FIFO は open しない。

## 退けた形

- **ポインタ3種を sandbox / permission で拒む** —— ADR 0356 が退けた「層の行ごとに reset」と同じ denylist で、symlink の作成は path で拒めない。
- **`upload-pack` を worker の sandbox の中で走らせる**(読み手の目で読む)—— Harness ごとの機構に依り、#3061 の帰責は解けない。
- **fetch の前にリポジトリ定義を検査する** —— ポインタの種類の denylist で、検査と fetch の間に窓が残る。
- **実 worker の Lima 測定を待つ** —— 直す形が測定結果で変わらない。釘は Git 境界の harness で3形に外部 object が届かないこと。

## 派生

- Status 追記: ADR 0356 決定3、ADR 0357 決定1・2、ADR 0360 決定2。GLOSSARY.md: 「task の checkout」の盤面が撃つ手の行を直す。
- #3061 は決定2 に畳む(別 ADR を立てない)。#895(人間が書く名前の場所の `.git` symlink)は持ち主が違うので畳まない。実装は1 slice、
  #3097 のコメントが spec。
