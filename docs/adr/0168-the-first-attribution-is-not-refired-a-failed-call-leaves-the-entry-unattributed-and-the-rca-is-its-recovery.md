# 初回の帰責は撃ち直さず、撃てなかった・失敗した entry は未帰責のまま RCA に倒し、記録は判断だけを持つ

2026-09-28 の grilling(issue #1063、ADR 0164 の派生)で決定。ADR 0164 は起草と第2回の帰責を「結果の不在で拾って盤面が撃ち直す」と
置いた。初回の帰責の失敗はそこに含めず、`uncertain` + 散文の evidence を `objection_attributed` に書いて RCA を立てる従来の倒し方の
ままだった(ADR 0115 決定2)。撃ち直しの機構ができた今、初回も撃ち直すのか、失敗を判断の `uncertain` と分けるのかを決める。
今の実装の walk-through と `file:line` は #1063 のコメントに置く。

## 決定

1. **初回の帰責は撃ち直さない。** 撃ち直しは「結果が無くても下流が待てる」帰責のための機構で、初回はそれを満たさない ——
   初回の結果は commit がその場で使う(cause の集合で RCA を立てるかが決まり、修理子と RCA 子を同じ transaction で登録する。
   commit は人間の1つの行為で、待てない)。結果が無い entry は判断の `uncertain` と同じく RCA を要する側に倒し、commit は
   従来どおり 修理 + self RCA + auditor RCA を立てる。RCA の決着後の第2回(ADR 0164 決定1 の撃ち直しつき)が、findings を
   証拠に足した初回の撃ち直しでもある —— 失敗した entry は必ずここへ流れるので、学習入力は失われない。
2. **記録は ADR 0164 決定3 と同じ形にする。** 撃てなかった(client なし・表の行なし・throttle、および設計上撃たない close-only /
   timeout)は何も書かない。撃って失敗したときだけ失敗 event を残す —— 第2回の失敗と同じ kind で、`entry_id` / `round` /
   `reason` を持つ(`memory_draft_failed` と同じ形)。`objection_attributed` には判断だけを置く。
3. **「初回の帰責が無い」は `uncertain` と同じに読む。** RCA を立てる門、第2回の門、第2回の撃ち直しの対象(ADR 0164 決定1)の
   3箇所で、`uncertain` の初回と未帰責の entry を同じ集合に入れる。Precedent と人間の一覧の cause は未帰責では空になる ——
   失敗を判断として見せない。

## 退けた案

- **初回も撃ち直し、帰責が着地してから RCA を立てる** —— RCA の登録が commit から出て、entry ごとに「異議済み・未帰責」の
  無期限の状態(throttle の長さ + 最大3回×1時間 + 人間)が増える。同じ task の entry が別々に着地すると、task ごと1本で対を
  焼き込む auditor RCA を2本目立てるか登録済み task を書き換えるかになり、初回の Dismiss の意味(RCA を立てない / 今立てる)
  も要る。浮くのは最終 cause が学習に向かない(`preference` / `requirement_change` / `environment`)ときの RCA 2 session だけで、
  `capability` 型には RCA の着手が1時間以上遅れる。
- **失敗は `uncertain` のままにし、evidence の接頭辞で区別する** —— memory meta-review は `objection_attributed` を材料に読み、
  Precedent は cause を投影するので、どちらも失敗を「judge が判断できなかった」と読む。規則の食い違いを説明で温存することになる。
- **初回と第2回で失敗 event の kind を分ける** —— 同じ問いの同じ失敗で、違うのは round だけ。

実装は #1064(ADR 0164 の spec)に相乗りする —— 同じ sweep の述語と同じ失敗 event を触るため。

## 追記(2026-09-28 のトリアージ、issue #1083)

**決定2 の「撃てなかった」には容器の前提の不成立(ADR 0136 決定7)も入る。** 決定2 の括弧は ADR 0164 決定3 と同じ形に
するという原則の例示で、容器が抜けていたのは列挙漏れである —— 意図した非対称ではない。初回の失敗 event は撃ち直しに数えず、
未帰責の entry はどちらでも RCA に倒れるので、揃えて変わるのは「撃ってもいない呼び出しが失敗として残る」ことだけである。
初回の帰責は第2回・起草と同じく容器の前提を撃つ前に見て、不成立なら何も書かない。
