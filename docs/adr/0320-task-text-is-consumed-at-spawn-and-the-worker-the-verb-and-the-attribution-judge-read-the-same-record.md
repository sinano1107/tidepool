# task の文面は spawn で消費され、worker・`get_current_task`・帰責の判事は同じ記録を読む

**Status 追記: task 本文の記録上の所在と argv の受け渡しは ADR 0326 で改訂** —— 両 Harness の user turn は stdin、Codex は盤面の文も1つの user turn に含める。決定3 の判事は user turn 全体ではなく記録した task 固有の部分を読み、spawn で消費した文面を共有する線は保つ(2026-10-29、issue #2692)。

**Status 追記: 決定1 が外に置いた親の文脈(RCA 子が読む `parent`)は ADR 0321 で決着 —— RCA 子は材料の session の記録の `user` を、他の子は自分の pickup で凍結した文面を読む。帰結「verb での IssueGoneError の経路は消える」は slot の task に限らず子の `parent` でも成り立つ(2026-10-28 の grilling、issue #2663)**

2026-10-28 の triage → grilling(issue #2662、#2658 の副産物)で決定。停止の帰責の判事(ADR 0310 決定2)と異議の判事(ADR 0115)は
cause を「task が求めたこと」に照らして付ける(`capability` は task が求めた水準に判断が届かなかったこと、`task_ambiguity` /
`missing_information` は文面の書き手の取りこぼし)のに、入力に task の文面(title / purpose / 完了基準)が無く、purpose が命じた
とおり signal file を待った worker を `capability` と読むか、決められず `uncertain` に倒していた。無いのは決定ではなく写し ——
ADR 0310 決定2 の列挙にも #2553 の記録にも、文面を足す行も退ける行も無い。一方、worker が文面を受け取る口は harness で違って
いた: Codex は user turn に展開済みの文面を持ち(ADR 0124 決定1 の形)、Claude は「まず `get_current_task` を呼べ」だけで、verb は
呼ぶたびに issue を再展開していた。再展開も決定ではない —— ADR 0016 が決めた使用の瞬間は spawn と UI 表示で、glossary も
「title / purpose / 完了基準の消費は spawn 時」と置いている。実測と `file:line` は #2662 のコメントに置く。

## 決定

1. **task の文面は spawn で消費され、session のあいだ変わらない。** pickup gate が展開した title / purpose / 完了基準を Slot が
   session のあいだ持ち、`get_current_task` はその文面を返す —— issue を読み直さず、stored の task でも行を読み直さない。親の
   文脈(RCA 子が読む `parent`)は親の task の文面で、この決定の外(派生 issue)。
2. **Claude の user turn は Codex と同じ文面を持つ。** ADR 0124 決定1「user prompt に残すのは最初に呼ぶ verb、title、purpose、
   completion criteria」の形に揃え、両 harness が1つの関数で組む。記録した prompt(ADR 0313)の `user` が、worker が受け取った
   task の文面の版の刻印になる。
3. **帰責の判事の入力に task の文面が並ぶ。** 停止と異議の両方で、起草の入力は継承で持つ。出所は当時版・盤面の文と同じ記録の
   `user` を逐語で、記録が読めなければ null と告げる(ADR 0314 決定2 の形)。判事は、task が頼んだとおりの行動を worker の落ち度と
   読まない。
4. **verb から文面は外さない。** compaction 後の worker と subagent の復帰口であり、user turn が compaction の要約に逐語で残るかは
   両 harness で未測。

## 退けた形

- **sweep 時に issue を展開して判事に渡す** —— 版の刻印が無く、worker が従った文とずれる(ADR 0291 の退けた形、ADR 0314 決定1)。
- **`tasks` 行から** —— issue-backed task の行は `#N` の placeholder しか持たない。
- **transcript の `get_current_task` 応答を判事が読む** —— 再展開を残したまま判事だけ追う形で、ページに割れた purpose を結合し直す
  読み手が要る。凍結すれば記録の `user` で足りる。
- **記録に `task` 欄を別に足す** —— 記録は「渡した prompt 一式」(ADR 0313 決定1)で、worker に渡していない文を持たせない。

## 帰結

- session 中に issue に付いたコメント・編集はその session に届かない。届ける決定は元々無く、必要になったら読み手を決めてから開く。
- session 中に issue が閉じられても verb は気づかない(verb での IssueGoneError の経路は消える)。PR を開く段で気づく。
- user turn は argv で CLI に渡り(Linux の 1 引数の上限 128 KiB)、issue のスレッド全体が purpose に入る。上限を超える issue が
  観測されたら stdin へ移す —— 両 CLI とも受ける(`claude --input-format`、`codex exec` は prompt 引数なしで stdin)。
