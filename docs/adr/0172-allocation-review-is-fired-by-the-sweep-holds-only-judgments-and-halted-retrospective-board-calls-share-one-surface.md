# 配分評価も結果の不在で sweep が撃ち、注釈は判断だけを持ち、打ち切った振り返り Board call は3用途で1つの面に並ぶ

2026-09-28 の grilling(issue #1062、ADR 0164 の派生)で決定。ADR 0164 は起草と第2回の帰責を「結果の不在で拾って盤面が撃ち直す」と置き、
配分評価は含めなかった —— 失われるのは分布の標本1つで、`unevaluated: board_call_failed` として記録にも残るため。だが振り返り Board call
3用途のうち1つだけが撃ち直さない非対称が残り、`unevaluated` を読む読み手は無い(分布も学習器も読み飛ばし、meta-review は期限判定の
材料に数えるだけ)。入力は event と完了後に変わらない task の列から組めるので、撃ち直しても同じ入力になる。今の実装の walk-through と
`file:line` は #1062 のコメントに置く。

## 決定

1. **配分評価も sweep の対象にする。** 対象は「統合点レビューに `task_completed` があり(書き手は問わない —— 品質判定が固定された
   事実だけが条件、ADR 0111)、被レビュー task に worker session があり、その review を指す `allocation_reviewed` が無い」もの。
   評価する session は **review の `task_completed` より前の最新の `worker_spawned`** に固定する —— 撃ち直しの時点で task が再 spawn
   されていても、扉が読んだのと同じ session を問う。1つの review から注釈は1件まで(in-flight の集合は ADR 0164 決定1 と同じ)。
   撃つのは sweep だけで、review 完了の扉は撃たない(ADR 0169 決定1 と同じ理由)。
2. **記録は判断だけを持つ。** `allocation_reviewed` から `unevaluated` を外す。撃てなかった(client なし・表の行なし・throttle)は
   何も書かず次の機会を待ち、session の無い被レビュー task は「宛先のいない起草」(ADR 0164 決定2)と同じく何も書かず対象外。
   撃って失敗したときだけ失敗 event(review task の id と理由)を残す —— `memory_draft_failed` と同じ形。
3. **撃って3回失敗したら打ち切り、一覧は3用途で1つ。** 打ち切りの行と Retry / Dismiss は ADR 0164 決定5 のまま、配分評価の行は
   review task・被レビュー task・最後の失敗理由を見せる。Dismiss = この episode は評価しない。**一覧の置き場所は Memory 面から、
   振り返り Board call のティア設定の隣へ移す** —— 一覧の主語は「失敗し続けた振り返り Board call」であり、routing の判断を Memory の
   下に置くと名前と中身がずれる。未公表なので path の互換は保たない。
4. **`unevaluated` の偏りを routing meta-review に読ませる案は採らない。** 読み手が無く、標本は同じ session を問い直せば得られる。
   結果として throttle が続く期間は `allocation_reviewed` からは routing meta-review の期限が来なくなる(`worker_exited` からは来る)。

## 退けた案

- **撃ち直さず今のまま** —— #1049 の時点の判断で、機構ができた今は据え置く理由が無い。揃えて壊れるものが挙がらない。
- **`no_session` だけ最終値の注釈として残す** —— sweep の述語が `worker_spawned` の有無を見ればよく、注釈で代用する理由が無い。
- **`unevaluated` 3値を残したまま `board_call_failed` だけ撃ち直す** —— 失敗を判断として見せる(ADR 0168 決定3 と食い違う)。
- **扉を即時性の最適化として残す** —— ADR 0169 が退けた案。配分評価の読み手(週次の meta-review・pickup 時の学習器)に即時性が
  要る観測は無く、review 完了は親の解放でもあるので次の poll はすぐ来る。
- **一覧を Memory 面のまま3種目を足す / 配分評価には面を作らない** —— 前者は名前と中身のずれ、後者は ADR 0164 が退けた
  「打ち切りをどこにも出さない」に戻る。失敗し続ける行は語彙の不一致など機構の故障の兆候でもある。
- **worker 完了の統合点レビューに限る** —— 今の範囲は扉の配線が決めた偶然で、決定ではない。
