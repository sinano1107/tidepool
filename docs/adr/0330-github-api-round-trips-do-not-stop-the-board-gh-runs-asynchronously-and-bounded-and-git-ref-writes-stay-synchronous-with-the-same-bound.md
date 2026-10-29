# GitHub API 面の往復は盤面の実行を止めない —— `gh` は非同期で有界に撃ち、git の ref 書き込みは ADR 0243 どおり同期のまま同じ上限だけ掛ける

2026-10-30 の triage → grilling(issue #2726 —— ADR 0328 の派生)で決定。盤面の `gh` 呼び出し(issue の読み・PR の作成・状態・検索・comment)は
`execFileSync` で上限が無く、hang すれば盤面の process の唯一の実行の糸が永久に止まり、poll は `inFlight` のまま、ADR 0036 が復旧経路と定めた
人間面(WebUI・管理 MCP)まで応答しなくなる。上限を足すだけでは 1 回 30 秒の凍結が残り、着地の tick は PR を全件ループして 1 件ごとに撃つので、
障害中は N × 30 秒ずつ人間面が消える。決定と写しを分けると、「上限は `GIT_NETWORK_TIMEOUT_MS` の側」は ADR 0067 決定6 の決定、「git の ref
書き込みは同期」は ADR 0243 が依る決定(盤面が死んでも push は完走する)、「`gh` が同期」は誰も決めていない写しだった。code の読みと `file:line`、
error の形の実測、テストの釘は #2726 のコメントに置く。

## 決定

1. **GitHub API 面(`gh`)の往復は盤面の実行を止めない。** `gh` は非同期の子 process として撃ち、その間も人間面・poll・着地は動く。`GitHubClient`
   は既に全 method が Promise で呼び手は await 済み、各 `gh` の直前に仲介(token broker)への非同期往復があるので、人間の verb が割り込む窓は
   今日と同じ種類のもの(#973 の transaction 内再読、ADR 0236 決定3「印は await の後に見る」が既に前提にしている)。
2. **上限は要る —— 非同期の代わりではない。** 上限が無ければ poll は `inFlight` のまま戻らず、ADR 0328 決定2 の除外は読みが返ることを前提に
   している。上限は `GIT_NETWORK_TIMEOUT_MS` を共有する(ADR 0067 決定6)—— 数の根拠(実ネットワーク往復であって、ローカル binary の 5 秒の
   側ではない)は同期・非同期で変わらない。定数の注の「同期だから」は「無界に待ってはならない(同期なら実行の糸、非同期なら poll を止める)」
   に直す。上限超過は到達不能 = 一時的失敗(untyped)で `IssueGoneError` にしない —— pickup では ADR 0328 の除外と計測に、着地では既存の失敗
   経路に乗る。
3. **git の ref 書き込みは同期のまま、着地の push にも同じ上限を掛ける。** ADR 0243 は「盤面が死んでも子の push は完走する」に依るので push は
   同期(`RefWriter` の `write`)。上限で途中で殺しても、口は実 ref を読んで基準を畳む(`writeBoardRefs`)ので予告/畳みは成立する。
4. **上限は 1 箇所で効かせる。** `gh` の wrapper 1 つ、git は `runAuthedGit`(「credentials take effect in exactly one place」と同じ線)。
   呼び出しごとに `timeout:` を書き足す点修正にしない。

## 退けた形

- **上限だけ(issue 本文の案)** —— 復旧経路が障害中に N × 30 秒ずつ消える形を決定として残す。
- **git も非同期** —— ADR 0243 と衝突し、`runAuthedGit` の同期の呼び手(registry / workspace の probe)が全部動く。得るのは probe の 30 秒だけ。
- **`gh` に別の定数** —— 「片方だけ動かしたときに理由が割れる」を自ら作る。

## 決めないこと・帰結

- probe(fetch / ls-remote)の同期・有界 30 秒の凍結は受容する —— 障害中の pickup 1 回につき最長 30 秒で、復旧経路は消えない。
- clone・publish の push・registry の push の無界は残余 —— clone の所要時間は repo の大きさで変わり 30 秒で切ってよいかが独自の問いなので
  派生 issue(#2731、high)。
- ADR 0067 決定6 の「既存の `GhCliClient` の呼び出しは上限を持たない」はこの ADR で閉じる(追記)。
- 実装は 1 slice。#2726 のコメントが spec。
