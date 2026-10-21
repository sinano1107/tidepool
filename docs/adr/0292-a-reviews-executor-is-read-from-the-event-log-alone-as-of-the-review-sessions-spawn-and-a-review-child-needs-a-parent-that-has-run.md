# review の Executor は event log だけから、その review session の spawn の時点で読み、実行の事実の無い親に review 子は付かない

2026-10-21 の grilling(issue #2369、兄弟 #2366)で決定。ADR 0054 は Executor を event log の事実と定めながら「`assignee` 列に
値があれば両者は一致する」として列を先に読んでいた。だが Edit(issue #130、ADR 0054 より前からある扉)は実行済みの task が
`todo` に戻った窓(escalate・decompose・queue 復帰)で列を書き換え、review の spawn が描いた Roster と、後で同じ関数を今の値で
呼ぶ読み手 —— live の免除と `list_agents` の `direct` 印、self RCA に注入する当時版、帰責 judge に渡す当時版 —— が割れる。
再現と読み手の全件は #2369 に置く。

## 決定

1. **Executor は `assignee` 列を読まない。** 被レビュー task の `task_completed` を書いた worker、無ければ最後に `task_picked_up` した
   worker(ADR 0054 の順序そのまま)。ADR 0054 の「列に値があればそのまま返す」の一文を改める —— 列は前を向いた値で Edit で動き、
   実行の事実の写しではない。
2. **review が問う Executor は、その review session の spawn の時点のもの。** 親の event を review の最新 `worker_spawned` の位置で
   区切って読み、spawn の Roster・免除・`direct` 印・当時版(self RCA の注入と帰責の入力)はすべてこの1つの読みを共有する。
   付帯子は親を塞がない(ADR 0049)ので、review の走行中に親が別の worker に pickup されうるが、読みは動かない。review が
   escalate から戻って再 spawn すれば、区切りと Roster が一緒に動く。描画と記録の順序は adapter を問わず `worker_spawned` を先に
   追記し、その id を区切りに描く(ADR 0149 決定2 の順序の中で、描画は event の後・spawn の前)。
3. **Executor が引けない親(`task_completed` も `task_picked_up` も無い)に review 子は登録できない。** domain の `registerTask` が
   扉を問わず拒む(ADR 0290 決定2 の形)。review は親の結果に付く付帯子(ADR 0049)で、結果の無い親には付く先が無い。人間
   assignee の task は pickup 無しで完了する(`task_completed` だけが残る)ので、述語は pickup でなく決定1 の読みそのもの。盤面自身の
   付帯子(完了時レビュー・RCA・監査)は必ず実行の後に立つので、この形を作れるのは人間の扉だけだった。将来のレビューの予約は Review flag / `review_by`。

## Considered options

- **spawn 記録に Executor の欄を写す** —— event log がすでに持つ事実の写しで、ADR 0110 決定3 の「commit から戻せない事実」
  には当たらない。区切って読めば同じ値が出る。
- **review 子がいる間は assignee の Edit を拒む** —— 表示の事実のために人間の扉を凍らせるうえ、pickup の fill が列を書く
  経路を塞げない。
- **event があれば event、無ければ列** —— 実行前の review 子にだけ予定の名を免除に残すが、当時版がその列を今読むので
  この1辺に食い違いが戻る。決定3 でこの辺そのものを消した。
- **実行前の review 子を許し、Roster 空・免除無しで走らせる** —— 見るものの無い review に slot と課金を使う。

## 帰結

- ADR 0054 の決定の列の一文は本 ADR が改める(0054 に追記)。CONTEXT.md の Executor・Roster・付帯子を正す。
- 当時版の Authority / Roster は spawn と同じ type の分岐で描く線(ADR 0020 part 4 / #1741 追記、ADR 0272 追記3、ADR 0291 決定2)
  はそのまま。#2366(修理子の self RCA に profile と roster を描く)はその線の code の写し漏れで、決定2 の共有で消える。
- 「レビュー対象タスクの assignee と同じ宛先は常に許可」を親の pickup 無しで釘にしていたテストは、pickup 済みの Executor
  で釘を打ち直す。Interview の root の Roster(空)は変わらない。
- 異議された task の修理子の宛先(列を先に読む、ADR 0275 決定2)は「誰が直すか」の別の問いで、本 ADR は触らない(派生 issue)。
