# meta-review は人間の回答を待ち、memory の提案には「決めない」の回答 defer がある

2026-09-28 の grilling(issue #1046)で決定。ADR 0120 決定2 は「同主題に open な提案 question があれば次の meta-review を
飛ばす」と置いたが理由を書かず、1 run の提案数に上限が無いことと合わさって、人間が1件答えないだけで同主題の学習が
止まり、その間 candidate は積み上がる。組み合わせを検討し、門は残して理由を確定し、人間の側に「決めない」を足す。
観測と `file:line` は issue #1046 のコメントに置く。

## 決定

1. **門は残す。理由は、人間の回答が次の review の判断材料だから。** reject の理由(ADR 0159)も defer の理由も、次の
   review が選び直すために読むもので、回答を待たずに次の判断を始めさせない。従として、前の束に答えるまで次の束を
   人間の前に出さない背圧。同じ entry への重複提案の防止は pin の重複拒否が既に担っており、門の理由ではない。
   規則は memory / routing の両主題に共通。
2. **1 run の提案数に上限は置かない。** completion criteria は前回以降の candidate と店の変更を漏れなく処分することで、
   件数で切ると据え置きの理由が「枠が埋まった」になり判断でなくなる。提案の多さは異議の多さの写しで、絞る場所は
   人間の reject の理由。
3. **memory の提案 question に3つ目の回答 `defer` を足す。** question は閉じ、店には何もしない(candidate も replaces も
   そのまま —— 陳腐化で observed になったときと同じ形)。comment は reject と同じく必須で、次の review が読む。
   approve は文言の保証、reject は candidate の引退で、人間に「まだ決めない」を表す手が無く、門を残す以上それは
   人間が詰まりを解くための reject を強いる(ADR 0120 決定4 が避けた形)。routing の提案には足さない ——
   reject しても行は残り、保留との差が無い。
4. **提案 question の detail の末尾に固定の1文を置く**: この question が open な間は同主題の次の meta-review が
   登録されない。両主題の提案 question に載せ(門が両主題に効くので)、memory の提案ではさらに「判断できないなら
   defer で戻せる」と続ける。人間の操作が変わるのは答えを先送りにしている場面で、そのとき読んでいるのは question の本文。飛ばした事実の event や settings の表示は足さない(ADR 0120 の「材料が無ければ
   event も残さない」を保つ)。

## 退けた案

- **open な question があっても回し、pin 済みの entry を避けて提案する** —— 次の review が回答を読まずに判断を始める。
- **open な question が周期を超えて放置されたら回す** —— 判断の材料を時刻で代替する(ADR 0120 の退けた案と同じ筋)。
- **defer で consolidate の起草 candidate を引退させる** —— defer と reject の差が店の上で消え、理由コード `rejected` が
  「人間が退けた」に読める。起草 candidate を同じ replaces で再提案できない穴は陳腐化でも同じで、issue #1054 が持つ。
