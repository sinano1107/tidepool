# 記憶の修理子は第4の task type `memory_repair` で、親の状態を問わず記憶の書き込みの行から立ち、「成果が残る」は行の成果の帰り先で判定する

2026-10-17 の triage / grilling(issue #2150)で決定。ADR 0268 決定3 は修理子を「直す成果が盤面に残る task だけ」に立てるとし、
実装はそれを task の状態(cancelled)と種類(Interview の root)で判定した。ADR 0268 決定4 の cascade も「帰り先のブランチが死ぬ成果を
持つか」を型(work)で代用している。ところが記憶の書き込み(ADR 0252)の成果は task のブランチではなく記憶の店にあり、cancel で消えず、
root も書く。その行への異議は帰責と RCA だけ立ち、記憶の修理 verb に届く経路(修理子)が無いまま誤った書き込みが注入され続ける。
走行中の task の記憶の行に立った修理子も、親の cancel で記憶を直さずに倒れる。実測と `file:line` は #2150 のコメントに置く。

## 決定

1. **「成果が残る」は task ではなく行の成果の帰り先で判定する。** 判断の行の成果はブランチに帰るので、cancelled の work の祖先を挟む
   task(ADR 0271 決定1)と Interview の root では修理子を立てない(今どおり)。記憶の書き込みの行の成果は記憶の店に残るので、親が
   何であれ修理子が立ち、cascade でも倒れない。ADR 0268 決定3・決定4 の文言はそのままで、近似していた判定を文言に揃える。
2. **記憶の修理子は第4の task type `memory_repair`。** 修理子は常に行の種類で分ける —— 判断の行は work の修理子1本、記憶の行は
   `memory_repair` の修理子1本(ADR 0252 決定4 の「異議された task ごとに1本」を改める)。1つの task に両方の異議があれば子が2本立つ。
   review type に乗せなかったのは、要る性質(repo に書けない・lineage に透明・cascade で残る・root と cancelled の床の下に通る)は
   一致しても目的が違い、今日の時点で4つ食い違うから —— RCA の見分け(review 型 + 異議群を覆う子)に誤認される、未設定 assignee の
   解決先(review は Auditor、修理子は既定 agent)、組み込み agent は review だけ走らせる(ADR 0228)、review は `review_tier` で走る。
   CONTEXT.md が type を権限モデルと定義する以上、別の権限面は別の type である。共有できる性質は型を共有せず、関数の共有(composition)で写す。
3. **権限面。** 道具は review と同じ deny(Edit / Write / NotebookEdit と Bash の書き込み系)。verb は work の面から分解系
   (`decompose` / `redecompose` / `continue_decomposition` / `declare_premise_breach`)と新規書き込み(`record_knowledge` /
   `define_memory_branch`)を外し、記憶の修理 verb 5本(ADR 0252 決定4)を **type で**持つ(今の「修理できるエントリの有無」ではなく)。
   新規書き込みを外すのは、修理の射程が異議された書き込みの触ったエントリに限るためで、置き換えは `replace_memory` が担う。
4. **実行の設定は work の修理子と同じ。** assignee は異議された task の assignee を焼き、取れなければ既定 agent に落として記録に残す
   (ADR 0237)。組み込み agent は取れない。tier / priority は work と同じ扱いで、`review_tier` には乗せない。
5. **完了時レビューは立てず、着地は待つ。** 修理子の書き込み自体が異議の対象で(ADR 0252 決定4)、直す道は次の異議。着地は ADR 0092
   のとおり型を問わず未決着の付帯子を待つ —— ブランチに流れ込まない成果で着地を止めない形は、痛みが観測されてから(帰結)。
6. **lineage と木の位置は review と同じ。** ブランチを持たず、親のブランチがあればそれを読み口にし、workspace は親から継ぐ。cascade は
   残り、Interview の root の下にも cancelled の床(ADR 0271 決定2)の下にも通る —— どちらも拒むのは work だけ。受験者の下は今どおり
   question 以外拒む(受験者は記憶を書かない、ADR 0268 決定2)。

## 退けた形

- **床と cascade に「記憶の行を材料に持つ work」の例外を置く** —— work の面は repo に書けるので、root(review)の下では lineage が
  review を飛ばして保護ブランチ基点になり、worker がコードも触れば PR を開きうる(ADR 0268 が #1886 / #2108 で潰した形)。
- **親の無い work** —— `get_current_task` は親の history を運ぶので、親を切ると異議された判断の文脈が消える。
- **review type の付帯子に記憶の修理 verb を持たせる** —— 決定2 の4つの食い違い。
- **盤面が逆操作を自動適用する** —— 異議は方向コメント(「移せ」「書き直せ」もある)で、逆操作に限定できない。
- **親が死んでいるときだけ記憶専用の子に逃がす** —— 同じ記憶の修理が親の状態で work / memory_repair に分かれ、生きた系譜の記憶の
  修理だけがコードを触れる面で走る。
- **cancelled / root の記憶は人間が settings で直す** —— ADR 0252 が退けた形(ADR 0163 決定2 の手順を人間が手で踏む)。

## 帰結

- ADR 0252 決定4、ADR 0268 決定3・4、ADR 0271 決定1・2 に追記する。ADR 0046「修理子は異議された task の子」は変わらない。
- 「生きた根の着地を memory_repair が待つこと」が痛むかは #2150 の派生 issue(verify:production)で観測する。
- #2163(帰り先が死んだ系譜の族)の述語の一般形では、記憶の行の帰り先は店で常に生きている。
- Interview の root の下の `memory_repair` の書き込みは、root 自身の書き込みと同じく受験者の視界に無い集合に入る(ADR 0264 決定3 の
  延長 —— 直すのは root の書き込みで、直した本文も root の判断の産物)。今の述語は書き手の task が root か Interview の木の出所かで
  見るので、修理子の task をそこに足す。

## 追記(2026-10-18 の triage、issue #2179)

決定4 の「実行の設定は work の修理子と同じ」は**学習器(ADR 0110 決定4)まで含む** —— 昇格後の行の選択、pickup ごとの shadow 行、
episode の3つで、memory_repair は work と同じ側に立つ。実装は3箇所とも `work` だけを見ていて、memory_repair は review と同じ側
(常に表の先頭行、shadow 行も episode も無し)に落ちていた。review を学習器から外す理由は判定者を一定に保つこと(ADR 0111
決定3)で、memory_repair は判定者ではない。ADR 0110 決定4 の「work task にしか触れない」は第4の type が無い時点の文で、対比は
review だけである。組み込み agent の影の門と watchdog の時間リミットは既に work と memory_repair を1つの側として扱っている。

episode の形は新しくならない。work の修理子は flag 無しの非 root の子で完了時レビューを持たず、memory_repair も持たない(決定5)
ので、どちらの episode も `accepted` にはならず、capability の帰責があれば `rejected`、無ければ `excluded` である(ADR 0115 決定5)。

退けた形: **学習器から外す** —— 外す理由を新しく立てる必要があるが、記録にも機構にも無い。

## 追記2(2026-10-18 の grilling、issue #2209 / ADR 0275)

決定4 の「組み込み agent は取れない」は撤回 —— ADR 0228 の3つの理由は work の授権の話で memory_repair に当たらず、組み込みは
review / interview / memory_repair を取れる(ADR 0275 決定1)。決定2 の4つの食い違いは3つ(RCA の見分け・未設定 assignee の解決先・
`review_tier`)になり、type の分離はそのまま立つ。追記1 の「組み込み agent の影の門は work と memory_repair を1つの側として扱う」は、
memory_repair が組み込みへ落ちても走るので `work` だけに戻る(学習器の側は変わらない)。修理子の assignee は列が名前なら列、参照なら
Executor(ADR 0275 決定2)。#2175 の grilling で決まった分も記す: 親の無い memory_repair は `registerTask` が拒む(退けた形「親の無い
work」と同じ理由)、登録名義は work の修理子と同じ HUMAN 名義 + commit の origin(ADR 0194 決定3)、root の列は参照で写すものが無い
(→ Executor)。
