# 採点できる答案が残らない Interview は人間の答えと同時に終わり、root は採点を終えるまで完了できない

2026-10-14 の grilling(issue #1892)で決定。ADR 0245 で分解済みの Interview の root は `decompose` を失い、起きた root に
残る手は採点・完了・escalate だけになった。ところが done の pin の子が1つも無いまま root が起きる経路が3つ残っていた
(全対象の failure question を abandon、全対象の承認 question を reject、前提の破綻の question を abandon)。そこで起きた
root には AI の判断の余地が無く、escalation の答えは何も cancel しないので、人間は答えたうえで root を直接 cancel する
ことになる。root に注入される board doctrine も、外したはずの `decompose` を指していた。経路の照合は #1892 のコメントに置く。

## 決定

1. **人間の abandon / reject の答えのあと、root に done の pin の子も未決着の子も残らなければ、盤面がその場で root を
   cancel する。** 出自はその question。0 にしたのは人間の答えなので、「この Interview を終える」は既に決まっている —— 盤面は
   それを写すだけで、root を起こさない。状態は done でなく cancelled(何も測っていない)。question の文は登録時に兄弟の
   行方を知らないので、「他の対象が残っていなければ Interview も終わる」と条件付きで書く。
2. **pin の子の前提の破綻の question を abandon すると、done の兄弟が居ても root ごと cancel する。** abandon は「probe が
   壊れていた」と人間が認めた答えで、破綻は全対象に共通する(ADR 0245 決定2)。壊れた probe の答案を採点すると、学習器が
   同じセルの観測として数える。登録し直すのは人間(ADR 0245 決定3)。
3. **board doctrine の分解の文は、分解の verb を外す判定と同じ1本から導く。** 「pin の子かどうか」で切り替えていたため、
   分解済みの root に存在しない verb を指す文が載った。verb の無い task には「分けない」の既存の文が載る。
4. **done の pin の子に採点の無いものが残るあいだ、root は完了できない。** 採点は rubric を満たさない側(rejected)でも記録
   できるので、採点できない答案は無い。進めない事情は escalate で上げる。

決定3・4 で root への指示は全部仕組みが持つ —— 「採点してから完了せよ」を文面に頼らない。

## 退けた案

- **root を起こさず、盤面が「終える / 登録し直す」の question を立てる** —— 直前に答えた人間にもう一度同じ判断を求め、
  question の種類が1つ増える。
- **root を起こし、文面で「採点 0 のまま完了」または「escalate」を指示する** —— 判断の余地の無い作業に slot を使う。
  escalate は答えても何も cancel しないので、人間の手が1つ増える。
- **分解済みの root 専用の doctrine の文を足す** —— 文が仕組みと別の判定を持つ限り、またずれる。
