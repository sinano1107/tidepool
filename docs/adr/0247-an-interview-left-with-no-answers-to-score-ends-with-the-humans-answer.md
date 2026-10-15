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

## 追記(2026-10-14 の triage / grilling、issue #1899)

決定2 の question は、ADR 0248 で pin の子の前提の破綻すべて(初回を含む)の question になり、abandon の隣に retry が並ぶ。
retry も root ごと cancel するのは abandon と同じで、そのうえで盤面が同じ対象の Interview を人間名義で登録する。決定2 の
「登録し直すのは人間(ADR 0245 決定3)」は retry の答えに移った。

## 追記(2026-10-14 の triage / grilling、issue #1902)

決定4 の「進めない事情は escalate で上げる」は、probe が壊れていたという事情については ADR 0251 の probe の破綻の報告に
置き換わった。決定2 の「done の答案を採点しない」は、ADR 0251 決定4 で「cancelled の Interview の採点は学習器が数えない」
に広がった —— 報告の前に付けた採点も入らない。

## 追記3(2026-10-14 の triage / grilling、issue #1901 / ADR 0253)

決定4 の「採点の無い done の子が残るあいだ root は完了できない」は、`complete_task` の拒否ではなく採点完了の verb の形で
保たれる —— root は done の子全部の採点と完了を1回で渡す(ADR 0253 決定4)。決定1 の「全対象の承認 question を reject」の
経路は無くなった: 盤面が立てる pin の子は決裁権の外に出ないので、承認 question にならない。

## 追記4(2026-10-15、issue #1410 / ADR 0199 追記)

決定1 の「人間の abandon / reject の答え」に、断られた Interview の対象の question への「この対象は測らない」も含める。
