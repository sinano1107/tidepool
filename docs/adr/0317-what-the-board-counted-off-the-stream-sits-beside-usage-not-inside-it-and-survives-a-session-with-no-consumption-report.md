# 盤面が stream から数えた事実は消費の報告と独立に worker_exited の直下に置き、報告の無い session でも残す

**Status 追記: 決定5 の欄ごとの null と決定6 の欄そのものの null の文は [ADR 0432](0432-recovery-that-could-not-read-a-transcript-marks-the-exit-and-a-board-call-input-drops-what-cannot-be-observed-and-explains-only-what-it-holds.md) 決定2・4 で置き換わる(2026-11-27、issue #3898)** —— 3欄は入力のまとまり `output_observations` になり、Claude で exit が無いか復旧が transcript を読めなかった(`stream_read: false`)ときまとまりごと null、Codex では入力から外す。prompt の説明は入力がその値を持つときだけ出す。

**Status 追記: 決定1 の「報告の無い session でも残す」は worker session の線で、答えを取りに行く Board call には当てない([ADR 0323](0323-an-answer-fetching-board-call-reads-its-stream-and-records-the-swap-beside-its-usage-row.md) 決定4、issue #2661)** —— Board call の行は usage を報告した呼び出しだけが持ち(ADR 0299 決定3)、差し替えと拒否はその行の隣の列に置く。

2026-10-27 の triage → grilling(issue #2637、#2632 / ADR 0316 が退けた案)で決定。`worker_exited.usage` は CLI の消費の報告(result 行)が
無ければ丸ごと null で、ADR 0215 決定3 / ADR 0214 決定4 がその中に置いた model の差し替え・root の拒否・advisor の相談と失敗は、
kill・cap 中断(`is_error` の result 行は報告として受理しない)・盤面の crash の session で、stream で観測されていたのに記録に残らなかった。
ADR 0215 決定5 が「報告なき exit の failure question に差し替えの1行を足す」と決めた、まさにその kill の場面で行が出ない。読み手の表と
`file:line` は #2637 のコメントに置く。

## 決定

1. **`worker_exited` の欄の置き場は出所で切る。** `usage` は CLI の消費の報告の写し(token・推定ドル・model 別内訳)で、報告が無ければ
   null のまま。盤面が stream から数えた事実 —— 差し替え(`model_swaps`)・拒否(`refusals`)・advisor(`advisor`)—— は `last_message` /
   `reported_error`(ADR 0188 / 0189)と同じく直下に置き、報告の有無と独立に常に書く。ADR 0215 決定3 の置き場はこれで反転する ——
   あの決定の理由「advisor と同居」は同居先ごと動かせば保たれ、「judge に新しい経路なし」は決定3 で足す。Codex は今と同じ値(`[]` /
   `[]` / null)を直下に置く。復旧(ADR 0316 決定1)は live と同じ読み手なので、result 行の無い transcript からもこれらが埋まる。
2. **`AdvisorRecord` は割らず丸ごと直下へ出す。** `model`(result 行の `iterations`)と `usage`(result 行の `modelUsage`)は報告が
   無ければ null で、どちらも既存の「報告されなかった / 測れない」の意味に収まる。相談と失敗の列は埋まる。record 自体の null は
   今のまま「相談も失敗も観測されなかった」(ADR 0214 決定2)。
3. **配分評価の judge の入力(`AllocationReviewInput`)に3欄を名指しで足す。** `usage` 丸ごとに乗せていた経路の代わりで、同じ event から
   1欄ずつ渡す。ADR 0214 決定4 の「新しい経路を足さない」は別のマーカー種別や別の event を指し、入力の形が変わるだけなので当たらない。
   `exited` の payload を丸ごと渡す形は、judge に読ませる理由の無い欄(exit code・stderr・event id)まで prompt に入るので採らない。
4. **subagent の model はこの決定の対象外。** `worker_exited` に欄は無く(ADR 0287 決定5)、失われているのではなく元から書いていない。
   記録そのものは transcript と Episode の行動行(`subagent` フラグ・subagent 自身の消費)にあり、作業内容を見せる UI が何を引くかは
   その UI の issue で決める(#2644)。

## 退けた案

- **据え置き、report の無い session は諦める** —— 学習器は差し替えられた session を kill と capability の帰責で `rejected` に数え、
  failure question の差し替えの行は kill で消える。events.ts の advisor の注釈は「`usage` が生き残れない場面でも残るよう外に置く」と
  書いており、入れ子がその意図を破っていた。
- **AdvisorRecord を stream の半分と result 行の半分に割る** —— 決定2。advisor の記録が2か所になり、ADR 0214 決定1 の「同じ記録」が崩れる。
- **judge に足さない** —— ADR 0215 決定3 が judge に届くことを前提にしたのを黙って外す。

## 帰結

- ADR 0215 決定3 と ADR 0214 決定4 に Status 追記。ADR 0215 決定5 の failure question の行は `usage` を経由せず直下の欄から写す。
- CONTEXT.md の Worker session(stream から数えた事実は消費の報告と独立に残る)。
- 記録の形の変更は欄の移動(`usage` の中 → 直下)。リリース前なので migration は書かない。実装は1 slice、#2637 のコメントが spec。

## 追記(2026-11-26 の triage、issue #3857)

決定3 は3欄を同じ event から1欄ずつ渡すと決めたが、値の意味は運ばなかった。Codex は差し替えと拒否を観測しないので常に `[]` を書き(決定1)、
`worker_exited` の無い session も入力で `[]` になる。judge にはどちらも「観測して無かった」と区別できず、拒否で止まった session が
`capability` に寄りうる。prompt は `usage` / `actions` / `advisor.usage` の null だけを説明し、3欄の意味には触れていなかった。

5. **judge の入力の `model_swaps` / `refusals` は、盤面がその session の stream を読んでいないとき null にする。** 読んでいないのは
   Harness が codex のときと `worker_exited` が無いときで、`actions` と同じく値の有無ではなく出所で決める(ADR 0083 追記10)。
   記録の側(決定1)は変えない —— 空を「無かった」と読み違えるのは judge だけで、学習器と failure question 文は空で害が無い。
   `advisor` は対象外: Codex の実行設定に advisor は載らない(ADR 0098)ので、null に曖昧さが無い。
6. **prompt は judge に渡す欄の null の意味を、欄ごとに書く。** 欄そのものの null(観測していない)と、`refusals` の要素の null
   (分類が届かなかった拒否1回)・`model_swaps` の要素の欄の null(CLI が報告しなかった)・Claude の `advisor` の null(親 thread で
   相談も失敗も観測されなかった)を分けて書く。

退けた案: **記録の側で Codex に null を書く** —— 決定1 を覆し3つの読み手と型を変えるが、読み違えるのは judge だけ。**prompt に Codex の
文を足すだけ** —— `actions` が入力の null で表している「観測していない」と同じ事実を、欄ごとに別の言い方で運ぶことになる。

復旧が transcript の無い session を閉じたときは、Claude でも記録の `[]` が「読んでいない」を意味するが、記録に stream を読めたかが残らず
入力では見分けられない。記録の側の問いとして #3898 に分ける。
