# memory 提案の決着は履歴として読み、memory 提案の reject は理由を必須にする

2026-09-27 の grilling(issue #1027)で決定。#954 で meta-review が candidate を `rejected` で引退させられるようになり、
`rejected` の書き手が人間と meta-review の2つになった。しかし記憶の一覧は理由コードしか返さないので、次の周期の Auditor は
両者を区別できない。spec #949 は、自分の引退は繰り返さず、人間の reject は理由を読んで選び直すことを求めている。
調べると、欠けていたのは区別だけではなかった。人間が reject に添えた comment は question にしか残らない。approved Behavior の
無効化提案(invalidate op)の reject と、陳腐化による決着は、記憶の側に跡を残さない。現状のコード調査は #1027 のコメントに置く。

## 決定

1. **memory 提案の決着は、routing と同じ形の履歴として memory meta-review が読む。** 過去の memory 提案を全期間、提案・回答・
   修正値・comment・陳腐化の理由つきで返す読み口を足す。提案の表は持たず、question と event から読み出し時に組む
   (`read_routing_settings` の先例、spec #916)。人間の面には出さない。人間は question そのものを見られる。
2. **無効化済みのエントリは、無効化の書き手の印を読み出し時に持つ。** event が既に刻んでいる印(回答なら question、書き込みなら
   書き手の activity、ADR 0151 決定3)をそのまま載せる。投影の列は足さない。Auditor は2つの一覧を突き合わせる推論を
   せずに、自分の引退と人間の reject を区別でき、question から決定1の履歴へたどれる。人間の面(settings)もこの印を表示する。
   今の表示は、人間が退けていない candidate まで「rejected」と見せている。
3. **memory 提案の reject は comment を必須にする。** 空の reject は、読む Auditor にとって「人間が退けた」以外の情報がなく、
   選び直しの材料にならない。門は reject の domain 関数に置き、どの扉(WebUI・管理 MCP)から来ても効くようにする。
   ほかの reject 経路(routing / registry 提案、pending-child 承認)は読み手が違いうるので、この ADR の外で見直す(#1030)。

## 退けた案

- **書き手の区別だけを一覧に載せる** —— spec の「reason が読める」を満たさない。何が退けられたかは分かっても、なぜかが
  分からなければ選び直せない。
- **candidate の一覧に提案の履歴を相乗りさせる** —— invalidate op の提案が指すのは approved エントリで、candidate ではない。
  kind・状態の filter とページも提案の軸と噛み合わない。routing が既存の read に相乗りできたのは読み口が1つだったからである。
- **無効化の書き手を投影の列に持つ** —— event が正本で、印は既にそこにある。一覧は後継の文言を既に読み出し時に組んでいる。

## 追記(2026-10-01 の triage / grilling、issue #1030)

決定3 の理由必須は、提案 question と承認 question の reject すべてに広がった(ADR 0179 決定1・2)。門の置き場も reject の
domain 関数から回答の domain 関数の1か所へ移る(ADR 0179 決定4)。
