# 失われたと数えるのは「無い」と分かった ref だけ —— 在るか無いか分からなければ回答を拒み、origin の「無い」は GitHub の object の照会で知る

2026-11-24 の triage と grilling(issue #3607。#3562 の仕様レビューの派生)で決定。

ADR 0373 決定5 の give-up は、戻す先の object が無い ref を失われたと数える。ADR 0380 決定4 は、remote-backed なら数える前に origin から取りに行き、origin に届かなければ拒むと決めた。spec #3273 はこれを「2回の `ls-remote` probe の間で落ちた fetch は、origin に無い」と近似し、その窓での誤読は受け入れていた。

実測では、origin が sha を持ったまま fetch だけが stall すると、give-up が受理されて取り消せない `lost_refs_accepted` を書いた。窓は「probe の間に origin が落ちる」よりずっと広い。probe が通る間に fetch だけが落ちる失敗は全部入る —— stall、転送中の切断、5xx、手元の hop2 の失敗、容量不足。手元の判定(`cat-file -e`)も、読めない dir や切れた alternates を「無い」と読んでいた。実測と code の読みは #3607 に置く。

1. **失われたと数えるのは、「無い」と積極的に分かった ref だけである。** 在るか無いか分からない失敗では、何も書かずに回答を拒む。give-up と `restore the baseline` の両方に当たる。上書きの選択肢は足さない —— origin が在ると言う内容を捨てる道を常設すれば、取り消せない記録を誤って書く入口を作り直すことになる。
2. **手元の「無い」とは、git が object を引けず、ほかに何も報告しないことである。** 何かを報告すれば「分からない」になる —— 読めない、alternates の先が無い、loose が壊れている。手元を読む3つの読み手(失われたかの判定・取りに行く対象・keep-around に持つ値)は同じ判定を使う。壊れた loose へ戻す `restore the baseline` は、通る側から拒む側に変わる。ADR 0398 決定3・4 とは食い違わない。読むのは戻す先の数個の sha だけで費用は repo に比例せず、気づいたときに盤面にできること(書かずに止まる)がある。
3. **GitHub の origin と出元 repo の「無い」は、fetch が失敗した後の GitHub の object の照会で知る。**
   - 「無い」と数えるのは、照会が型を問わず「その repo にその id の object は無い」と答え、同じ答えの中で対照の object を読めたときだけである。
   - 照会が「在る」と答えれば、取れなかったのは届き方の失敗で、回答を拒む。
   - 照会自体が失敗すれば「届かない」で、回答を拒む。
   - git の文は読まない(spec が ADR 0376 決定1 から借りた規則は守られる)。2回の probe は外す —— 照会1回で「届くか」と「在るか」の両方が分かる。
4. **照会できない origin では、取れなければ常に「分からない」である。** GitHub でない origin(ADR 0339 の local path と loopback)と、GitHub の身元を持たない盤面がこれに当たる。その ref は give-up では諦められず、出口は削除の扉 → 再登録である。
5. **書き込みの同期区間(spec #3273 の受理の 7b)は、非同期の段の照会が「無い」と答えた sha だけを失われたと数える。** 照会していない sha が手元に無ければ、答え直させる。例: await の間に人間が動かした ref。3値の読みは、最初の書き込みより前にすべて済ませる。
6. **拒否文は、壊れているものごとに分ける。** 届かない(今の B4c)、在るのに取れない、手元で分からない、照会できない origin、の4つである。直す手が違う —— 待つ、fetch の原因を直す、名前の場所を直す、削除の扉を通る。

## Considered Options

- **spec のまま受け入れる** —— 窓は前提より広い。取り消せない記録の側へ倒れる。
- **stall だけを「届かない」に回す** —— 切断・5xx・手元の失敗が窓に残る。
- **git の文を読む** —— 相手で文が違う。手元の bare は `not our ref`、GitHub は `couldn't find remote ref` を返す。
- **REST の commit の照会** —— GitHub が持つ annotated tag や tree の object にも「無い」(422)と答える。
- **GitHub でない local path の origin を直接読む** —— fixture のために、checkout でない path で git を撃つ新しい呼び出しを本番に足すことになる。

## Consequences

- ADR 0373 決定5 の「object が無い」と、ADR 0380 決定4 の「origin に届かない」の読みが変わる。spec #3273 の "Unreachable versus not on origin"(2回の probe)と pin B24 の probe の行は、この ADR が置き換える。
- 限界: 照会が「在る」と答えるのに fetch では取れない object(force-push で外れた commit、network の別の repo にだけある commit)があれば、その ref は give-up では諦められず、出口は削除の扉になる。この形はまだ測っていない。盤面の App の身元で照会したときの答え方も測っていない。どちらも #3743 で確かめる。
- 保留中の設計 #3535 の項4「読めなければ届かなかったと読み、記録せずに数える」は、この ADR と食い違う。
