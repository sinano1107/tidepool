# Board call の読み手が知る語は prompt の文と入力の中身だけで、欄の説明は入力の型に鍵で結んで1か所に置く

2026-10-29 の triage → grilling(issue #2681、#2675 / PR #2680 の code review で出た族の根)で決定。振り返り Board call の読み手(帰責の
判事・Behavior の起草)が知るものは、3行の system prompt と設定の層を全部落とした環境(ADR 0303 決定1)の下では **user prompt の文と
JSON の入力**だけである。その入力欄の説明を2つの client が別々に綴り(4本の prompt)、入力の形が変わるたびに手で両方を直して
#2672 で両方とも直し損ねた。同時に prompt は CONTEXT.md の語(roster / Authority / auditor / Interview root / tier / 「harness 同梱の
skill」)を定義せずに使い、worker に注入する文も定義していないので読み手にはどこからも届かない。語ごとの照合表と `file:line`、
変わる釘の一覧は #2681 のコメントに置く。

## 決定

1. **欄の説明は入力の型の欄に鍵で結んだ record に1か所で置き、prompt は欄名で挿す。** `satisfies Record<keyof <入力の型>, string>` の
   形で、欄を足す・消す・改名すると compile で落ちる。入れ子(`agent_definition` の `body` / `authority` / `roster`、`authority.source`、
   `actions.calls[]` / `actions.decisions[]` の要素)も入れ子の型に同じ形で結ぶ。識別にしか使わない欄(`registry_commit` / `builtin`)も
   文を持つ。既存の共有文(`LOG_ROW_RULE` / `RCA_FINDINGS_RULE` / `OBJECTION_HUMAN_STOP_RULE` / `OBJECTION_WRITTEN_RULE` /
   `OBJECTION_ACTOR_RULE`)はその欄の record の値になり、名前は引用のため残す。ADR 0322 追記「読み手向けの写しは1箇所で、面ごとに
   書かない」を prompt の文へ延長する。置く位置は prompt ごとに自由(判事の `task` は cause の定義の隣、ADR 0320 決定3 の実装)。
2. **「欄が何か」は共有し、「null のときどうするか」は読み手ごとに書く。** 判事の「judge from the rest」は cause を立てない指示、起草の
   「null when not recorded」は型の注記で、違いは意図されたもの。
3. **読み手に届く盤面の語の定義は、record の文にだけある。** CONTEXT.md の語を名前だけで使わない。入力の中身が意味を語る語
   (`board_text` の `## Interview discipline` の節)は定義を省く。条件にだけ使う語(Interview root)は消して節の有無で言う。roster /
   Authority は `agent_definition` の入れ子の文で定義し、`authority.source` は3値(`profile` / `reviewer` / `repair`)とも書く。tier は配分
   評価の prompt が持つ「quality floor」の汎用の半文を `TIER_DEFINITION_RULE` の前に置く。
4. **`rca_findings[].review` の self / auditor は誰に割り当てたかの事実だけを書く(#2675 の文のまま)。** 当事者レビュー / 独立レビューの
   価値は渡さない —— 重みを書かなくても「self にしか書けない」は self を重く読ませ、どちらを重く読むかを決めた ADR は無い。決めるなら
   2本の所見が食い違った停止の判定の観測が先で、その観測は判事の判断の質と同じく #1880 に乗る。

## 退けた形

- **素の文の定数**(`*_RULE` と同形)—— prompt 同士の乖離は消えるが、型が変わっても文を直す強制が無い(#2672 の直し漏れはこの種)。
- **zod の schema の `.describe()` から描く** —— 型と文は結べるが prompt の並びを schema の並びに縛り、判事の `task` を cause の隣に置けない。
- **worker 向け prose(doctrine / protocol)の定義を指す** —— 注入する文に語の定義は無く、指す先が無い。

## 帰結

- 「harness 同梱の skill に従ったなら environment」の判定に要るのは語の定義でなく、どの skill が harness 同梱かという事実で、判事に届く
  欄が無い。本 grilling では決めず派生 issue に置く。
