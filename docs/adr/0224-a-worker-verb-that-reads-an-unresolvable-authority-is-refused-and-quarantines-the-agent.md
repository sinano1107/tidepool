# authority を読めない worker の verb は拒まれ、agent を quarantine に落とす

2026-10-09 の grilling(issue #1649、発端は #1631 のレビュー)で決定。worker の MCP verb が実行中タスクの assignee の
authority profile を registry から解決できないとき(spawn 後に agent が消えた・定義が壊れた)、盤面は `assignable_to` と
`allowed_workspaces` を無制限として扱っていた(fail-open)。spawn の門は quarantine に落とすが、spawn 後の registry の変化は
その門を通らない。調べた経路は #1649 に置く。

## 決定

1. **authority を読む worker の verb は、profile が解決できなければ拒み、agent 名の quarantine を立てる。** 対象は分解・
   再分解・roster の一覧の3つ。読めない決裁権を無制限とも最も狭いとも推測しない。ADR 0217 決定3 の理由 —— 欠陥は
   registry にあるので、求める判断は registry の修理であり、その形は既存の agent 名の quarantine —— が、着地と同じく
   ここにも当てはまる。拒否は domain error なので slot は保たれ、authority を読まない完了と escalate は通る。
2. **roster の一覧も拒む。** 書き込まない verb だが、印を付けずに返すと worker は「全員に直接振れる」と読み、続く分解が
   拒まれて読みと書きの答えが食い違う。authority を読む呼び出しを1つの規則に揃える。
3. **拒否の文面は事実と修理の依頼済みを告げ、escalate を求めない。** escalate は修理の依頼と同じ問いを人間にもう1枚
   立てるだけである。次に何をするかは作業の状況に依るので worker に任せる。
4. **agent 名の quarantine の解除は、その名前宛ての未決着タスクを数える。** 未着手だけを数えると、実行中の worker が立てた
   quarantine は registry を直さずに解除でき、次の呼び出しでまた落ちる —— ADR 0217 決定4 が着地を待つ完了タスクを
   数えに加えたのと同じ理由である。数える集合は削除の扉と同じになる。

## Considered options

- **最も狭い authority として扱い、子をすべて承認 question に変換する(fail-closed)** — ADR 0217 が退けた「merge
  question に倒す」と同じ型で、人間に「この子を承認するか」を問い、registry の修理にならない。
- **今の fail-open をテストで釘付けする** — spawn 後の registry の変化が決裁権の門を外すことを認める。
