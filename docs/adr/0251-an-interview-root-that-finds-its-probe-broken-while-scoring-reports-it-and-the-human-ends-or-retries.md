# 採点の段階で probe が壊れていたと気づいた Interview の root は報告し、人間の答え1つで終えるか測り直す

2026-10-14 の triage / grilling(issue #1902)で決定。分解済みの Interview の root が採点の段階(pin の子が全部決着した
あとの統合復帰)で probe が壊れていたと気づいても、手は「全部 rejected で採点して完了」と escalate しかなかった。前者は
壊れた probe の答案を対象の実績として学習器に入れ、後者は答えても何も cancel しないので、人間は答えたうえで root を直接
cancel する —— ADR 0247 / 0248 が消した「人間の手が1つ増える」形が残っていた。子は done なので ADR 0248 の前提の破綻の
question は立たない。さらに `score_interview` の採点はその場で学習器に入るので、途中まで採点してから気づいた root を
cancel しても採点は残っていた。経路と学習器の読み口の実測は #1902 のコメントに置く。

## 決定

1. **分解済みの Interview の root は、probe の破綻を理由つきで報告できる。** 盤面は root の agent 名義の question を立て、
   root はその答えを待つ。question が存在するのは root の判断による(ADR 0194 決定1)。前提の破綻とは別のもの —— あちらは
   子が宣言して分解判断の書き手が判断し、こちらは書き手自身が申し出て人間が判断する。分解前の root には probe が無いので
   報告できない。
2. **選択肢は continue / abandon / retry で、推奨は root が abandon か retry から選ぶ。** continue は root を起こして採点に
   戻し、同じ Interview への2度目の報告は受け付けない(なお不服なら escalate —— 上方向は制限しない)。abandon と retry は
   ADR 0248 決定2・3 と同じで、retry の新しい root に見せる破綻の理由は root の書いた理由になる。
3. **question の context は、root の理由、盤面が確定した probe と rubric、done の pin の子への参照。** 答案の本文は写さない ——
   子を開けば読める。probe と rubric は #1901 が作る(ADR 0248 決定4 と同じ待ち)。
4. **学習器が数える Interview の採点は、root が done になった Interview のものだけ。** 採点は root の完了で確定する。報告の
   前に付けた採点も、人間が root を直接 cancel した Interview の採点も、学習器に入らない。代わりに、走っている Interview の
   採点は meta-review の集計にまだ現れない。
5. **ADR 0247 決定4 の「進めない事情は escalate で上げる」は、probe の破綻については決定1 の報告に置き換える。**

## 退けた案

- **分解済みの Interview の root の escalate を、盤面が abandon / retry の question に読み替える** —— ADR 0248 で退けた形。
  escalate の意味が状況で隠れて分岐する。
- **root は escalate で知らせ、人間に Interview の root を測り直す直接の扉を足す** —— 人間の手が答えと扉の2つになる。
- **前提の破綻の question を使い回す** —— その question の親は宣言した子で、abandon の範囲も子から決まる。root が親の形
  では意味が合わない。
- **推奨を continue に固定する(ADR 0248 決定4 に揃える)** —— あちらは盤面名義で判断の材料を持たない。ここには壊れて
  いると判断した agent がいる。
- **1件でも採点した root には報告させない** —— 「採点の前に probe を見直せ」を文面に頼る(ADR 0247 の「指示は仕組みが
  持つ」に反する)。途中で気づいた root は残りを採点するしかない。
- **abandon / retry で盤面が採点済みの子に取り消しの event を書く** —— 仕組みが増え、直接 cancel の経路を覆わない。

ADR 0248 は「root に破綻を人間に回す verb を足す」を退けたが、理由は子が既に破綻を見つけていて root がふるいにしか
ならないことだった。採点の段階で答案を rubric に当てるのは root が初めてで、気づけるのは root だけである。
