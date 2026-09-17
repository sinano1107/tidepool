# 実装 issue は merge で閉じ、実環境の症状が消えたことの確認は派生 issue が持つ

2026-09-17、#598 / #645 の実機 venue 確認のあとで決定。どちらの issue も PR の `Closes #<n>` により
merge と同時に閉じており、`docs/agents/workflow.md` の「Closing the originating issue」が要求していた
venue 確認の前だった。規則と実態の食い違いは、#645 が閉じたあとも Codex route の worker が1本も
起動していないと分かって表面化した(実測は #598 のコメント、残っていた別原因は #706)。

## 決定

1. **実装 issue は merge で閉じる。** spec が契約で、CI がそれを覆う。PR の `Closes #<n>` が close の
   機構であり、人間の追加確認を close の条件にしない。人間に残るのは merge の判断だけ。

2. **主語が実環境で観測された症状である issue も、merge で閉じる。** ただしその場合、**症状が消えた
   ことの確認は派生 issue が持つ**。元 issue を開けたまま確認を待たない —— merge が言えるのは「原因と
   睨んだものを直した」までで、症状が消えたことではない。その差を、閉じた issue の open 状態ではなく
   独立した行で表す。**その行は `/implement-tidepool` の filing step が、PR を開く前に立てる** ——
   立てる主体を決めないと、実装が滑らかに終わるほど確認の行が生まれず、決定2 は意図であって規則に
   ならない。

3. **確認の派生 issue は、観測が入るまで `needs-info`**(ADR 0102 の線)。production だけが見せられる
   確認なら `verify:production` を付ける —— ラベルが載るのはその派生 issue であって、元の実装 issue
   ではない。

## 退けた案

- **venue 確認まで元 issue を開けておく(現行の `workflow.md` —— 本 ADR で改訂)** —— 人間の確認待ちが close の
  ボトルネックになる。ADR 0029 が人間の受け入れ確認を廃止したのと同じ理由で、同じ方向。
- **merge で閉じ、確認は諦める** —— #645 がその実例になりかけた。「worker が起動できない」という報告に
  対し、原因と睨んだ照合行を消した事実だけが残り、症状が消えていないことが誰の持ち物でもなくなる。
- **PR に `Closes` を書かず人間が閉じる** —— 規則は守れるが、確認の手間は減らない。決定1 が減らしたい
  ものそのもの。

## Consequences

- `workflow.md` の「Where a human is required」から「Closing the originating issue」が消え、人間に残るのは
  **seam の合意**と**merge** の2つになる。`/implement-tidepool` の停止点(open PR まで)は変わらない。
- `triage-labels.md` の `verify:production` は、元の実装 issue ではなく確認の派生 issue に載る。
  「`verify:*` の無い open issue は未着手の作業」という open set の読み方は変わらない。
- 症状を主語とする issue の close は「直したはず」を意味する。閉じた issue は観測の記録ではないので、
  観測は派生 issue かコメントの実測から読む。
