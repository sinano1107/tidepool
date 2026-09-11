# 異議は学習する前に帰責され、cause の語彙は配分評価と共有する

2026-09-11 の grilling(issue #554)で決定。ADR 0083 は学習の入力を異議だけに絞り(決定7)、異議ごとに fix-forward RCA が
Behavior candidate を書く(決定9)と置いた。spec #541 は異議を routing 学習器の outcome(受理 / 異議 / Displayed)に数える。
しかし異議には「変数名はこちらが好み」「後から要件を変えた」「文脈を渡し損ねていた」「仕様に反した」が同じ重さで並び、全部を
worker の失敗として Behavior と実行設定の学習に流すと、記憶も学習器のセルも汚れる。一方で、異議そのものは観測であり、
記録の形は変えない —— 「判断種別の注釈で、観測と混ぜない」(ADR 0111 決定4)の線をそのまま異議に延ばす。

## 決定

1. **帰責(Attribution)は異議されたエントリごとの判断種別の注釈で、保存する値は `cause` 1つ。** 語彙は配分評価(ADR 0111
   決定4)と共有し、異議でしか見えない2値を足す: `capability` / `task_ambiguity` / `missing_information` / `environment` に
   `preference` / `requirement_change`。持ち主(worker / 登録者 / 人間 / 環境)は列ではなく cause からの読み方である。影響
   (cosmetic / rework / 不可逆)の軸は持たず散文の evidence にとどめる —— それで振る舞いを変える消費者がまだ無い。
   配分評価と帰責は同じ episode に別々に並び、契機(review 完了 / 異議)と単位(session / エントリ)が違い、語彙だけを共有する。

2. **帰責は Board call が、異議が束ねられる commit 時、RCA の前に付ける。** 入力は異議されたエントリ・steering・当時の
   decision log。self RCA は自己申告なので帰責の書き手にしない(ADR 0083 決定7)。人間が steering 時に選ぶ案は注意予算を使う
   ので退けた。判定できなければ `uncertain` で従来どおり RCA を立て、RCA 群の決着後に第2の Board call が findings を証拠に
   確定させる —— `uncertain` は最終値にならない。人間の上書きの扉は誤判定が観測されてから。

3. **commit 時に立つものは cause の集合で決まる。** RCA を要する cause(`capability` / `task_ambiguity` /
   `missing_information` / `uncertain`)が1つでもあれば従来どおり 修理 + self RCA(該当エントリの worker 分)+ auditor RCA。
   `preference` は修理 + Board call が steering の文言から Behavior candidate を直接起草する(人間の明示指示は1回で候補化、書き手
   は AI なので承認 question は経由 —— ADR 0083 決定9 そのまま。宛先 worker / 全員も文言から判断、既定は worker)。
   `requirement_change` / `environment` は修理だけ。self RCA は「なぜ自分はそう判断したか」を問うので、worker に落ち度が無い
   cause では問いが空である。

4. **学習の行き先は cause から導出し、ADR 0083 決定9 の第1段だけを改める。** `capability` → Behavior、宛先 worker /
   `task_ambiguity` → Behavior、宛先は登録者(agent のとき。人間登録なら書かない)/ `missing_information` → 欠けていた事実を
   Knowledge(出所は異議 event)+ 登録者が agent なら Behavior / `preference` → Behavior / `requirement_change`・
   `environment` → 書かない。「異議ごとに candidate」は「帰責が学習に向く異議ごとに」になる。繰り返しの判断(meta-review)と
   人間承認の2段は不変。回避可能性は cause が含意し、一般化可能性は meta-review の仕事なので、列にしない。

5. **routing 学習器は outcome の生の記録を変えず、帰責で条件づける。** `preference` / `requirement_change` / `environment` の
   異議は実行設定セルの負の信号に数えない —— 配分評価の cause で環境要因を除くのと同じ機構に乗る(spec #541 に1行足す)。
   「worker の評価」「maturity」は概念として立てない。異議率(Displayed が分母)の定義も動かさない。

## 退けた案

- **帰責を RCA の後に置く** —— findings を証拠に読めるが、1異議 = self + auditor の2 session を好みの異議にも払う。
  証拠が足りないときだけ後段に回す(決定2)。
- **candidate は常に書き、帰責を添えて meta-review が捨てる** —— 「要件が変わったとき、…」という Behavior は書きようが
  なく、書けば meta-review の読み物が汚れる。門は起草時に引く。
- **異議用に別の cause 語彙を立てる** —— 「なぜ外れたか」の分類が2本あると必ず漂流する。
