# Codex の上限到達による中断は exit の直後に読み直した使用量で認め、読み直しの結果は exit の記録に残す

2026-10-15 の triage / grilling(issue #1979)で決定。ADR 0104 決定5 と ADR 0145 決定5 の「Codex の上限到達の形は未観測
なので建てない」を置き換える。pin した codex-cli 0.147.0 のソースを読むと、上限の拒否は CLI の内側では構造化された種別
(`UsageLimitExceeded`)を持つが、`exec --json` が JSONL に写すときに捨てられ、`turn.failed` には文言しか残らない。
形は binary に焼き込まれて決まっているので、実使用の exit を待っても新しい事実は出ない —— 残っていたのは観測ではなく、
文言しか無い出口で何を確定証拠とするかの決定だった。調べの詳細は #1979 にある。

## 決定

1. **証拠は exit の側ではなく、同じ Harness の使用量の面から取る。** 報告なき exit を見た時点で app-server の使用量を
   読み直す。Codex は走り出した後の証拠が文言しか無いので Harness の構造化された面で代える、という行の拒否(ADR 0184
   決定3)と同じ解き方で、窓が満杯かはサーバの言い分であって盤面の推測ではない。文言は読まない(ADR 0104 決定2 /
   ADR 0188 決定1 のまま)。
2. **認める条件は「`turn.failed` の行がある」かつ「どれかの窓が `usedPercent >= 100`」。** 満杯の線は Throttle の 100%
   キャップと同じにする —— 中断が失敗でないのは Throttle が catch-up まで止めるからで、分類と再開の門が食い違えば、
   戻した行がすぐ spawn されてまた断られる。`turn.failed` は行の有無だけを見る(上限の拒否は必ず turn を失敗で終える)。
   1ターンを走り切って verb を呼ばずに exit した session は、窓がたまたま満杯でも上限の被害者ではない。
3. **読み直すのは Codex adapter である。** `turn.failed` の有無は vendor の出力の形で adapter が知っている(ADR 0005)。
   満杯なら Claude と同じく `onCapInterrupted` を先に撃ってから exit を渡し、盤面は provider を見ない(ADR 0188 決定5)。
4. **読み直しは分類にだけ使い、Throttle の状態には書かない**(ADR 0104 決定3 / ADR 0008)。再開は次の pickup の観測に任せる。
5. **読み直しの結果は `worker_exited` に1欄で残す** —— 満杯だった窓(名前・`usedPercent`・`resetsAt`)、どの窓も満杯で
   なかった、読めなかった理由、の3つ。読み直さなかった session には欄が無い。Claude の 429 と違い決め手が transcript に
   残らないので、どこかに残さなければ中断の根拠が消える。`cap_interrupted` には足さない: 後始末の遷移で書かれ、その時点の
   盤面が持つ経路の事実は status だけである(ADR 0113 決定3)。
6. **読めなければ今日と同じ failure question に落とし、確かめられなかったことと理由を1行添える。** 認証切れの Quarantine は
   次の pickup の観測が立てる。

## 退けた案

- **worker を app-server で走らせ `codexErrorInfo` を受ける** —— transcript(ADR 0149)・封じ込め・preflight が `exec` 前提で、
  OpenAI が production 非サポートとする面に主経路を載せる。
- **pin した版の固定文と照合する** —— 決定1 の「文言は読まない」に正面から反する。
- **failure question のまま** —— Spend-down を窓の頭から撃つ使い方(ADR 0260)では、retry 一択の問いが日常になる。
- **満杯をサーバの `rateLimitReachedType` でも認める** —— Throttle が読まないので、それだけが立つ形で空回りする。個人プランでは
  窓の満杯として現れる。追跡は #2001。
- **証拠を `cap_interrupted` に載せる** —— 決定5。

## 帰結

- CONTEXT.md「上限到達による中断」の Codex の記述を書き直した。
- 実装は #1979 のコメント。
