# 1段目の拒否は CLI の通知の文面で読み、CLI の行の読み手は同じ面の実物から書く

2026-11-25 の triage → grilling(issue #1615)で決定。ADR 0215 決定3 は「拒否そのもの(同じ model で続いた1段目も)」を
分類の逐語で記録すると決め、読み手は root の assistant 行の `message.stop_reason: "refusal"` を見ていた。その形は対話モードの
保存 transcript(2.1.294)で見たもので、`-p` の stream-json でも同じだと仮定していた。固定版 2.1.286 の worker で1段目の拒否が
起き(#3809 の測定の途中)、仮定は外れた: stream-json の assistant 行のうち API の応答から流れる行は content block ごとの
途中経過で、`stop_reason` は null である(repo の実物の fixture もそうだった)。値を持つのは CLI が合成した行だけである。拒否された応答は stream に流れず、出るのは
`system/informational` の通知1行と合成の user 行だけで、分類は載らない。記録には何も残らず、worker が報告なく exit したとき
人間に届いたのは `last_message` の散文だけだった。実物の行と binary の読みは #1615 のコメントに置く。

## 決定

1. **1段目の拒否は通知の文面で読む。** `system/informational` 行のうち `level` が `notice` で、本文が CLI の定数の文
   (「… safeguards stopped the response above · continuing once with that noted」)で終わるものを拒否1件と読み、`refusals` に
   分類 null で出た順に足す。worker session と答えを取りに行く Board call の両方に当てる(ADR 0323 決定2 の「同じ行の読み手」の
   まま)。構造化された証拠だけを認める線(ADR 0070 / ADR 0104 決定2)は、Provider のエラー文から挙動を分ける分類を推測しない
   という決定で、ここには当たらない —— 文面は固定した版(ADR 0186)の CLI に埋まった定数で、盤面はこの記録で分岐しない
   (ADR 0215 決定3)。subagent の通知は親の stdout に出ない(binary の読み)ので、読んだ拒否は root のものである。
2. **差し替え先が無い拒否は、CLI が合成した assistant 行で読む。** 既存の読み手(root の assistant 行の `stop_reason:
   "refusal"` と `stop_details.category`)を残す。固定版の binary の読みでは、この終わり方でだけ CLI が `message.model:
   "<synthetic>"` の行を `stop_reason: "refusal"` つきで流す。実物は未観測である。
3. **報告なき exit の failure question 文に、拒否の1行を足す。** 差し替えの1行(ADR 0215 決定5)と同じ並びで、件数と分類を
   載せる。同じ task を retry すれば同じ内容でまた止まりうるので、retry か abandon かを決める人間の材料になる。Precedent は
   `informational` を「知っていて捨てる行」に足す(差し替えの行と同じ扱い)。
4. **CLI の行の読み手は、同じ面(`-p` の stream-json)の実物の行から書く。** 別の面(対話モードの保存 transcript など)で見た形
   からは書かない。実物が無い読み手は、固定版 binary の読みであることを読み手と fixture に明記する —— binary の読みは実測では
   ない。機構は足さない。

## 退けた案

- **`informational` の通知を解釈せず全部逐語で載せる** —— 拒否と無関係の通知が10種類以上あり(hook の出力、agent の model
  制限、streaming の再試行など)、failure question 文と記録に混ざる。
- **1段目は stream では記録できないと決め、読み手を消す** —— 報告なき exit の人間が拒否を知る経路が散文の偶然だけになる。
- **文面の照合を適合試験の機械判定に入れる** —— 拒否は狙って起こせない。決定1 の文面が残っているかは、版を上げる手順書の
  「Not covered」の節に、binary を文面で探す1手順として置く(ADR 0186 決定7 が再現できない面に定めた扱い)。

## 帰結

- ADR 0215 決定3・5、ADR 0323 決定2・3 に Status 追記で指す。記録の形(`worker_exited.refusals`、`board_calls.refusals`)は
  変わらない —— 1段目の拒否は分類 null の1件になる。
- 版を上げるときは `docs/claude-cli-version-bump.md` の「Not covered」に従い、決定1 の文面を新しい binary で確かめ直す。
- 未観測のまま残るもの(差し替え先が無い拒否の行、差し替えの行の全欄、`--max-turns 1` の Board call での1段目の続行)の
  照合は、差し替え先が無い拒否の行を #1614 が、残りを #3854 が持つ。
