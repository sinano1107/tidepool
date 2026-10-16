# Interview の pin の子の前提の破綻は書き手を起こさず人間に問い、人間は Interview を測り直せる

2026-10-14 の triage / grilling(issue #1899)で決定。Interview の pin の子が前提の破綻を宣言し、それが agent の書いた
分解判断への初回なら、ADR 0121 のとおり root が早期統合復帰する。ところが ADR 0245 決定3 で `redecompose` を失った root
に残る手は `continue_decomposition` と escalate だけで、probe が壊れていると判断しても escalate しかない。escalation の答えは
何も cancel せず、root はもう一度起きても打つ手が無いので、人間は答えたうえで root を直接 cancel する —— ADR 0247 が3経路で
消した「人間の手が1つ増える」と同じ形が残っていた。さらに、cancel したあと登録し直す人間には、何が壊れていたかを新しい
root へ渡す道が無く、probe を書く新しい root(ADR 0111 決定6)は同じ probe を書きうる。経路の照合は #1899 のコメントに置く。

## 決定

1. **Interview の pin の子の前提の破綻は、書き手と回数によらず初回から Tidepool 名義の question にする。** root は起こさない
   (ADR 0121 の早期統合復帰の例外)。0121 が退けた「宣言のたびに人間の question を燃やす」を Interview で覆す理由は3つ:
   root は帰結の半分しか完了できない(終える・測り直すは cancel と登録で、どちらも人間の行為)ので、起こしても誤宣言の
   ふるいにしかならない。Interview は人間が承認して登録したもので件数が少ない。誤った続行は壊れた probe の答案を採点させ、
   学習器の材料を汚す。
2. **question の選択肢は continue / abandon / retry。** retry は今の Interview を abandon と同じく root ごと cancel し
   (ADR 0247 決定2)、同じ対象の一覧・目的で新しい Interview を人間名義で登録する。対象は登録時の一覧をそのまま写す ——
   途中で外れた対象も、壊れた probe のせいだった可能性がある。新しい Interview は別の root なので、probe を回答前に確定
   するのは Interview 1件につき1回(ADR 0245 決定3)のまま。repeat の宣言や人間 decompose の経路も同じ question なので、
   ADR 0247 決定2 の abandon にも retry が並ぶ。
3. **retry は、旧い root の id、盤面が確定した probe と rubric、破綻の理由、人間の答えのコメント(任意)を、新しい root の
   history に盤面名義で見せる。** 新しい root には親が無く、自分の history しか読まない。purpose と対象は人間が直せない ——
   直したいなら測る問いが変わるので、abandon して登録し直す。
4. **question の context には、破綻の理由と帰結の文に加えて、盤面が確定した probe と rubric を載せる。** 判断するのが
   root でなく人間になったので、probe を見ずに答えさせない。推奨は他の前提の破綻の question と同じ continue。
5. **`declare_premise_breach` の説明文は変えない。** pin の子に注入する文は Interview であることを書かない(ADR 0245 決定2)。
   子の振る舞い(slot を空けて待つ)はどちらの経路でも同じ。

決定3・4 の「盤面が確定した probe と rubric」は #1901 が作る —— 今の probe は型の無い判断ログの1行で、盤面は引けない。

## 退けた案

- **root に「破綻を人間に回す」verb を足す** —— root の続行の余地は残るが、決定1 の理由でふるいの価値が無い。
- **breach の開いた Interview の root の escalate を、盤面が premise_breach question に読み替える** —— escalate の意味が状況で
  隠れて分岐し、ADR 0121 の「escalation の宛先は常に人間の自由な問い」が濁る。
- **root 自身に abandon させる** —— ADR 0121 決定1 の「破棄だけして再分解しない形は作らない」と、cancel は人間の判断という
  線に反する。
- **abandon だけ残し、人間が登録し直すときに旧い Interview を名指す欄を足す** —— 人間の手が答えと登録の2つになる。
- **retry で purpose や対象の effort / tier も直せる(ADR 0150 決定2 の修正値を広げる)** —— 対象が変われば測り直しでなく
  別の Interview になり、修正値の仕組みを提案でない question に広げる代わりに得るものが目的欄の正確さだけ。
- **probe の行の代わりに、宣言した子の purpose と分解判断の行を載せる** —— 分解判断の行に rubric が入る保証は無く、#1901 の
  後も保証されない。#1901 に blocked-by を張って待つ。

## 追記(2026-10-15、issue #1410 / ADR 0199 追記)

決定2 の「登録時の一覧をそのまま写す」から、断られた Interview の対象の question で「この対象は測らない」と答えた対象は除く
—— Provider の拒否は probe と独立した理由である。

## 追記2(2026-10-16 の grilling、issue #2099 / ADR 0267)

決定1・2(pin の子の前提の破綻の question)は ADR 0267 で消えた —— 受験者は分解判断に乗らないので宣言できず、probe の不備は
escalation で1対象ぶん人間に届く。retry は出題済みの root の面に常時ある人間の verb と、採点段階の報告(ADR 0251)に残り、
決定3(新しい root に渡すもの)はそのまま。理由は宣言の文ではなく人間のコメントになる。
