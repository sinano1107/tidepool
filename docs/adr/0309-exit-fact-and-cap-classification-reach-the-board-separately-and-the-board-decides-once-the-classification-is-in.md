# exit の事実と上限到達の分類は別々に盤面へ届き、盤面は分類が揃ってから報告なき exit を決める

2026-10-25 の triage(issue #2547、#2536 の spec レビューから派生)で決定。ADR 0261 決定3 は Codex の使用量の読み直しを adapter に置き、
「満杯なら `onCapInterrupted` を先に撃ってから exit を渡す」とした。盤面の報告なき exit の一撃(ADR 0145)は exit を見た瞬間に
failure question を立てるので、分類を exit より先に届ける以外に非同期の読み直しを差し込む場所が無かった。帰結として **exit という
事実の通知が読み直し(Board call の上限で最大 15 秒)の後ろに回り**、3つの隙間が開いた —— 停止の梯子の底が exit の逐語を持たずに
question を書く(ADR 0191 決定4 の「exit は必ず先に観測済み」が Codex で偽になる)、梯子の底の failure question(`task_escalated`)が
`worker_exited` より前に書かれて session の窓(Precedent / learner / 記憶の投影)の内側に入る、そして同じ task の次の session に旧
exit が届く(成立には probe の残り時間内の人間の retry 回答が要る —— 静的に確定、未観測)。共有していた前提は「adapter が exit の事実と
分類を1本の通知に畳み、盤面は exit の瞬間に決める」こと。静的な照合と `file:line` は #2547 のコメントに置く。

## 決定

1. **adapter は exit を観測したら即時に盤面へ渡し、上限到達の分類は同じ通知の別の引数として渡す。** 分類は解決済みの値(Claude: result
   envelope の 429、ADR 0104)でも、まだ解決していない Promise(Codex: 使用量の読み直し、ADR 0261 決定1・2)でもよい。cap を exit より
   先に撃つ契約(ADR 0261 決定3 の後段、ADR 0104 の `onCapInterrupted`)は廃止し、両 adapter が同じ形で渡す —— 回収済み観測を Promise で
   渡す既存の形と同型。
2. **盤面は exit を観測した時点で記録(watchdog の記憶の `exit`)だけを置き、分類が揃うまで決めない。** 揃った時点で今日の遅い呼び出しと
   同じ門を再観測する —— slot の主・後始末中か・status。満杯なら上限到達による中断の後始末(ADR 0113)、それ以外は報告なき exit の
   failure question(ADR 0145)。停止の送達記録がある exit は今日どおり梯子が受けるが、満杯の分類だけは停止より優先する(exit の原因は
   停止ではない —— 今日の cap の一撃も停止を見ない)。人間の停止(後始末に入っている)はすべてに優先する。待ちの間 slot は握ったままなので、
   同じ task の次の session は構造的に始まらない。
3. **分類の Promise は `worker_exited` を書いた後に解決する。** 盤面の決定が書く event(failure question の `task_escalated`、後始末の印)は
   必ず `worker_exited` の後ろに来る —— session の窓は `worker_exited` の id で閉じる。読み直しの結果の欄は ADR 0261 決定5 のまま。
4. **分類の Promise は reject しない。** 読めなかったことは「読めなかった」という値である(ADR 0261 決定6)。

## 退けた案

- **盤面が止めた session では読み直さない(adapter が畳み込み停止を覚える)** —— 今日到達できる1経路だけを塞ぐ点修正で、「exit の瞬間に
  決める」前提が残り、次に非同期の分類が要る adapter で同じ隙間が開く。
- **梯子の底で exit を待つ** —— 盤面に「読み直し中」の状態と継続を足すが、exit の通知を遅らせる根は残る。
- **梯子の底の question に「逐語は `worker_exited` を見よ」と添える** —— 欠落を読み手に押し付けるだけ。

## 帰結

ADR 0261 決定3 の後段と ADR 0145 決定1 の「exit を観測した時点で」は本 ADR に置き換え、Status 追記で指す。ADR 0191 決定4 の前提は Codex でも
真に戻る。盤面側の一撃が task id で話し session の同一性を照合しない語彙の食い違い(ADR 0109 決定2)は #2556。
