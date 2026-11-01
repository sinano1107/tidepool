# Board call の回収 timeout の帳簿は観測の時点に置き、pickup の門と読み口がそれを読む —— 回収済み観測の不成立は記録と独立に pickup を待たせる memory を持つ

2026-11-02 の grilling(issue #2859、#2855 の実装で見えた形)で決定。ADR 0342 決定5 は「記録に書けたことを前提にする process memory の印」を
書き込みの後ろへ動かし、board-call の `report` の帳簿(`unreclaimed`)もその列挙に入れた。決定5 の理由 ——「先に置くと rollback の後に
再試行も鳴り直しも起きない」「決定6 の再実行の門が効く前提」—— は、投げた手を撃ち直す runner があることを前提にしている。worker session の
回収 timeout にはそれがある(`recordThen` → runner → `failedTeardown` の行と残りの手、受理が撃ち直す)。Board call の `report` には無い:
容器ごとに1度しか撃たず、`quarantineContainment` が盤面のバグ(B)で投げれば床で log になり、行も帳簿も残らない。Containment quarantine の
解除の門は帳簿の id だけ容器を読み直すので、生きた容器を見ずに開く。行が無いので pickup も止まらない。印には2種あり、決定5 はそれを1語で
数えた: 書けたことの印(`settled` / `recorded` / `reported`)は書き込みに従属するが、帳簿は「回収 timeout まで空を観測できなかった容器」という
盤面の観測で、門に「どの容器を読み直すか」を教える唯一の場所である。#2876(slot を持たない session、ADR 0344)と本件(task を持たない容器)が
共有する前提は、「(B) の行き先が壊れたものの性質ではなく観測点(後始末の step か)で鍵付けされている」こと。実測と手順は #2859 のコメントに置く。

## 決定

1. **回収済み観測の不成立は、記録と独立に pickup を待たせる memory を持つ —— worker session では slot、Board call では帳簿。** 記録
   (Containment quarantine の question)が唯一の安全装置である単位を残さない。範囲はこの1箇所: #2837 の追記が console に残した
   「後始末の外の (B)」の他の2箇所は第2の網を持つ(cliAuth probe は worker の 401 が ADR 0331 決定4 で資源の停止に落ち、
   `restoreProjectSettings` は起動時の restore が直す)ので延ばさない。
2. **board-call の帳簿は観測の時点に置く —— `report` の書き込みの前。** ADR 0342 決定5 の列挙から帳簿を外す。印の2種のうち、書けたことの印は
   書き込みの後のまま。watchdog の `pending` も列挙に残す —— runner が残りの手ごと撃ち直すので、後ろに置いても事実は行と手に残る
   (ADR 0254 決定3 の run 内の述語のまま)。帳簿の持ち主は観測者のまま2つ(watchdog の `pending`・口の `unreclaimed`)で、容器機構へは
   寄せない —— この欠陥は順序で起き、2帳簿は原因ではない。
3. **pickup の門と「今なぜ pickup が起きないか」の読み口が帳簿を読む。** 門は slot → 停止の列挙 → 封じ込め能力の後ろで合成済みの
   `pendingReclaim` を読み、名指された容器があれば pickup を待たせる。読み口は後始末の欄の隣に1欄を足し、門と同じ一句を載せる。停止の
   列挙(`halts`)には入れない —— 後始末と同じ「停止ではないが pickup を待たせているもの」(ADR 0109 決定2)で、人間が残存を手で殺せば
   容器の再読みで自然に解ける。question が開いている間は question とこの欄の両方が出る(把握して受け入れた重複、api.ts の後始末の欄と同じ)。

## 退けた形

- **console のまま、帳簿だけ書き込みの前へ**(triage の推奨) —— 門は閉じるが、容器が生きたまま他に Containment question が立たなければ
  pickup は無期限に走り、ADR 0136 決定1 / ADR 0099 決定4 の不変条件が何も止まらずに破れる。緩めないと壊れる運用が無い。
- **人間が撃ち直せる停止の行** —— 鍵が task id でない(`failedTeardown` は task 鍵)。再起動を跨げば platform supervisor が容器ごと殺すので、
  撃ち直すものも残らない。
- **`ProcessContainers` が `forcedAt` を持ち、門は容器機構だけを読む** —— timeout の測り手が3つ目になる。watchdog の `pending` は slot の
  述語(`heldForContainment` / `acceptReclaimed`)なので消えない。

## 派生

- Status 追記: ADR 0342 決定5。
- GLOSSARY.md の容器と盤面全体の停止の項。
- 実装は1 slice、#2859 のコメントが spec。#2855 の assert「帳簿に載せず `pendingReclaim()` が undefined」は変える決定の釘なので当て直す。
- #2383(`void Promise.reject` → console.error)は独立のまま。
