# advisor の相談は助言が返った呼び出しだけを数え、失敗した呼び出しは逐語で同じ記録に残す

2026-10-08 の grilling(issue #1524)で決定。盤面は `server_tool_use(name: "advisor")` を相談1回と数えていたが、
#1425 の VM 実測で、呼び出しのあと `advisor_tool_result_error`(`too_many_requests` / `unavailable`)が返り、
exit 0 で完走する session を2本見た。この session の `worker_exited.usage.advisor` は「相談1回・model 不明」になり、
ADR 0042 が事後の唯一の防壁とする「相談が観測されなければ null、比率の低下で未 attach が統計に現れる」が、
失敗の分だけ鈍る。同じ述語で置く Precedent のマーカー経由で、配分評価の相談回数も同じだけ膨らむ。stream の形と
今の実装の walk-through は #1524 のコメントに置く。

## 決定

1. **相談1回 = 結果が成功の型(`advisor_redacted_result`)で返った呼び出し。** 結果の行1本で決まり、呼び出しの行と
   対にする状態は要らない。`worker_exited.usage.advisor.consultations` と Precedent の advisor マーカーは同じ述語に乗せ、
   配分評価の2つの相談回数(`usage` と `actions`)は一致し続ける。観測した2つの型のどちらでもない結果は、相談にも失敗にも
   数えない。
2. **失敗した呼び出し(`advisor_tool_result_error`)は `AdvisorRecord` に `error_code` の逐語の列として残す。** 出た順、
   `error_code` の無い失敗は null。欄は常に置く。失敗だけの session でも record は非 null(`consultations: 0`)になる ——
   失敗は advisor が付いていた証拠なので、null は「付いていない」か「相談しなかった」に戻り、ADR 0042 の観測はむしろ
   鋭くなる。
3. **盤面は `error_code` で分岐しない。** だから盤面の語に写さず逐語で持つ(`spawn_failed.error_code` / `stderr_tail` と
   同じ。`RowRefusalCause` が写すのは分岐するから)。Throttle などの入力にするかは観測が無いので決めない(#1540)。
4. **配分評価には新しい経路を足さない。** Board call は `usage` を丸ごと受け取るので、record の欄が届く。失敗のマーカー種別は
   作らない。

## 退けた案

- **呼び出しを数えたまま(今の形)** —— 失敗は advisor が判断に影響した証拠にならず、`AdvisorRecord` の「実際にしたこと」と
  null の正当化(影響しなかった session をまとめる)の両方に反する。
- **呼び出しから失敗を引く** —— vendor が失敗の綴りを変えると、失敗がまた黙って相談に数えられる。成功の綴りが変われば
  相談が全部0になり、ADR 0042 の比率の低下で見える。壊れ方が見える側を選ぶ。
- **`error_code` を盤面の語(rate_limited / unavailable / other)に写す** —— 値の集合を2つしか観測しておらず、写した先で
  分岐する読み手も無い。
