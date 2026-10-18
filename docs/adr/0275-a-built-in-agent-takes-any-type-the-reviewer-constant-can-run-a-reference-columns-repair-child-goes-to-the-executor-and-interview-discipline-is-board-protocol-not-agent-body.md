# 組み込み agent が取れる type は reviewer 定数の授権で走れる type、参照の列の修理子は走らせた agent へ、Interview の規律は agent の本文ではなく盤面のプロトコル

2026-10-18 の grilling(issue #2209 —— #2175 の `/implement` の前に浮いた問い)で決定。Interview の root(組み込みの Interviewer
`suzumedai`)が記憶の店に書いた行への異議から立つ `memory_repair` の修理子は、既定 agent に落ちて記録に残らなかった。束ねが
assignee を写す条件 `type === "work"` は決定ではなく code の写しで、ADR 0237 決定1 が写さないとしたのは空の参照だけである。
ADR 0272 決定4「組み込み agent は取れない」は理由を書かず ADR 0228 を指すだけで、ADR 0228 の3つの理由(merge ダイヤル・PR・
work で役に立つ場面)は work の授権の話で `memory_repair` には当たらない —— 床と verb は type から決まり、着地はダイヤルを読まない。
そして suzumedai の本文の各行を CONTEXT.md「Memory」の2つの検査(固定性・残余性)に当て直すと、全行に持ち主(verb の説明か type の
注入)があり、観点ではなくプロトコルだった。プロトコルが agent の本文にあると、人間が root に名指した別の agent には届かず黙って
劣化する —— ADR 0017 が deckhand で潰した形である。実測(verb の集合、着地、Executor の記録、動く箇所)は #2209 のコメントに置く。

## 決定

1. **組み込み agent が取れる type は、reviewer 定数の授権で走れる type —— review / interview / memory_repair。** `memory_repair` は
   記憶の店にだけ書き、ブランチも PR も着地のダイヤルも持たない(ADR 0272 決定3・6)。ADR 0228 決定1 の「review 専用」を広げ、
   決定2(名前は1つの定義に解決)は変えない。shadow 削除の扉と quarantine 解除の依存(ADR 0228 決定3・4)は `work` だけを数える ——
   `memory_repair` は組み込みへ落ちても走る。ADR 0272 決定2 が review type に乗せなかった4つの食い違いは3つになるが、残り3つ
   (RCA の見分け・未設定 assignee の解決先・`review_tier`)で type の分離は立つ。
2. **修理子の assignee は、列が名前ならその列、列が参照なら走らせた agent。** 列が名前を持てば type を問わず写す(ADR 0237 決定1 の
   「work なら」を外す —— work / memory_repair の列は pickup が焼くので常に名前、review / interview は人間が名指したとき)。列が
   空の参照(Auditor / Interviewer ポインタ)なら、異議された task の最後の `worker_spawned` の名前(Executor)を写す —— pickup が
   列に書いたはずの名前で、参照は pickup で終わる(ADR 0233 決定1)ので束ねの時点のポインタは解き直さない。エントリの書き手も
   写さない(書き手を名指すのは self RCA、ADR 0237 決定1)。写した名前は今どおり門に通し、通らなければ空 + `assignee_not_copied`。
3. **Interview の規律は盤面が運ぶ。** session を通して守るもの(段の境目を測る probe、面接室で自己完結、観測できる rubric、匿名化と
   過不足)は `interview` type の spawn 注入が、verb を呼ぶ瞬間に要るもの(rubric どおりの採点、名を推測しない、壊れていたら
   `report_broken_probe`、答案ごとの決め手)は verb の説明が持つ —— ADR 0017 / ADR 0180 の線。suzumedai の本文は空になる。
   ADR 0269 決定1・決定4・追記1 と ADR 0273 決定1 の「本文が持つ」を改める。「盤面は検査しない」はそのまま。
4. **suzumedai は残す。** 本文は空、`TIDEPOOL_INTERVIEWER` の既定のまま。残る理由は Behavior の宛先を1つに固定すること(ADR 0269
   決定3)だけ —— fugu に畳むと Interview で学んだ Behavior が監査の session に注入され、逆も起きる。名前 = 専門性(ADR 0019)の
   専門性は本文ではなく、その名前に溜まる学びである。

## 退けた形

- **既定 agent に落として記録に残す** —— ADR 0237 が work で退けた「専門から外れた agent が直す」を、学びの宛先である名前にだけ
  適用する形。記録無し(今の code)は劣化経路が見えない。
- **束ねの時点でポインタを解き直す / 異議されたエントリの `worker_id` を写す** —— 前者は差し替え後の agent に行く。後者は root では
  同じ名前になるが、修理子と self RCA の規則を分けた線を崩す。
- **観点を注入へ移す(#2209 の案1)** —— 規律が観点なら ADR 0017 の置き場を逆にする。規律がプロトコルだと分かったので、移すのは
  適用であって反転ではない。そして注入は `memory_repair` の子には届かず、修理子に観点を届けるのは決定1 の側である。
- **規律を全部注入に寄せる** —— verb の説明と同じ文が2箇所に載り drift する(ADR 0010)。
- **組み込みを消して既定を fugu に** —— Behavior の宛先が混ざる。

## 帰結

- #567(本文の存在価値)の測る対象は再び無い。#2192 が足す匿名化の段落は本文ではなく注入へ(文は同じ)。ADR 0270 の履歴表は
  旧本文を残し、現在の本文は空文字列(fugu と同じ hash)。
- 実装は3つ: 束ね(#2175)、組み込みが `memory_repair` を取れる門と扉の数え(別 issue、high)、規律の移設(別 issue、#2192 の後)。
