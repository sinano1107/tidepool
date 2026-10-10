# 組み込み agent は review 専用であり、work は組み込みへ落ちない

2026-10-10 の grilling(issue #1623)で決定。組み込みの `fugu` を assignee にした work タスクは、ADR 0013 の reviewer 定数を
自分の profile として走っていた。merge ダイヤルを持たないので PR は盤面に問われず `external` と同じ面に着地し(#1623)、
Authority 節には「read-only。直すな」が入る(#1736)。ADR 0117 決定1 は組み込みの profile を reviewer 定数のままにしたが、
それは組み込みが review しか走らないという前提に立っていて、work を拒む門はどこにも無かった。経路は2つある —— 人間が
work を `fugu` に登録する、そして work の付いた shadow エントリを消す(ADR 0117 決定2 の例外で扉が通す)。測定と経路は
#1623 に置く。

## 決定

1. **組み込み agent は review 専用で、work の assignee にならない。** 判定は名前ではなく解決の結果を見る —— assignee の
   検査(登録・Edit・decompose)は、解決した先が組み込みで type が review でなければ拒む。既定 agent の指し先も同じで、
   組み込みに解決されるなら盤面は起動しない(ADR 0117 決定3 の「既定 agent は registry に残る」を検査にする)。
2. **名前は type によらず1つの定義に解決する。** shadow している間、その名前は registry の普通の agent で work も実行する。
   review は組み込み・work は shadow という振り分けはしない。
3. **shadow エントリの削除の扉は、work の参照を普通の agent と同じく数える。** 数えるのは work の未決着タスクと着地を
   待つ完了タスク(ADR 0217 決定4 の集合)。review の参照と Auditor ポインタは ADR 0117 決定2 のまま例外に残す ——
   review は組み込みへ落ちても壊れない。
4. **扉の外で shadow が消え、work が組み込みに落ちたら、解決の失敗と同じく agent 名の quarantine に落とす。** 解除の
   検査は、組み込みを「registry に戻った」に数えない —— 数えれば修理なしに解除され、次の tick でまた落ちる。修理は
   エントリを戻すか、その work を付け替えることである(ADR 0217 決定3・4 の線)。

ADR 0217 決定3 が区別した「解決できてダイヤルを持たない profile」は、組み込みについては生じなくなる。`case undefined` に
届くのは registry の無い盤面(実 PR を開かない)だけで、その面は `outside_board` のまま残す。ADR 0217 の帰結が別 issue に
回した枝はここで閉じる。

## Considered options

- **組み込みに work を許し、work 用の profile を別の code 定数として持たせる(`merge: escalate`、guidance は空)** ——
  triage と grilling の最初の推奨。根拠は「組み込みかどうかは置き場所の違いで、できることの違いではない」だったが、
  それは決まった線ではなかった。組み込みの fugu が work で役に立つ場面を列挙すると空(本文は空、skills は
  `@workspace`、委譲できない —— 既定 agent の劣化版)で、使った実績も無い。
- **reviewer 定数に `merge` を足す** —— ADR 0013 の定数は盤面の強制装置で授権ではない。review は PR を開かないので
  足した値は review の経路で一度も読まれない。
- **同名の shadow と組み込みを type で振り分ける** —— 名前は識別子(assignee / review_by / worker_id / Behavior の宛先)で、
  type で指す先が変わると記録が誰のものか機械にも区別できない(ADR 0117 が退けた「同名の2体を区別する」と同じ)。既定
  レビュアーを shadow で手直しする道も消える。
- **shadow の削除は許し、残った work は実行時の quarantine に任せる** —— quarantine は名前単位なので、その名前の review も
  すべて止まる。扉で防げる事故を盤面全体の review 停止に変える。
