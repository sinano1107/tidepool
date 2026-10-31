# 盤面の git のネットワーク呼び出しは総時間でなく「転送が止まった時間」で切り、無界の面は持たない

2026-10-31〜11-01 の grilling(issue #2731 —— ADR 0330 の残余)で決定。盤面の git のネットワーク書き込みのうち clone・publish の push・registry の
push は上限の無い `authedGit` で同期に走り、接続が black-hole すれば盤面の実行の糸が永久に止まって ADR 0036 の復旧経路(人間面)も応答しない。
ADR 0330 が足した上限は Node の `timeout`(総時間 30 秒、超過で SIGTERM)で、clone と publish には合わない —— 所要時間が repo の大きさで決まる
一括転送を総時間で切ると、大きい repo は再試行のたび 0 から送り直して永久に clone できない(tidepool 自身の pack は 79 MiB で、30 秒には持続
約 21 Mbit/s が要る)。しかも Node の `timeout` は git の親だけを殺し、socket を握った `git-remote-http` が孤児で残る(実測)。git には curl の
stall 検出(`http.lowSpeedLimit` / `http.lowSpeedTime`)があり、接続前の無音・応答途中の無音・push 先の hook の hang の 3 つの形を自力で中断し、
健全な遅い転送は切らず、中断後に宛先を残さないことを loopback の `git http-backend` 相手に実測した。表と `file:line` は #2731 のコメントに置く。

## 決定

1. **git のネットワーク呼び出しの上限は「転送が止まった時間」で掛ける。** `runAuthedGit` が `-c http.lowSpeedLimit=1 -c http.lowSpeedTime=<秒>` を
   足し、`GIT_NETWORK_TIMEOUT_MS` のあいだ 1 byte も動かなければ git 自身が切る。動いている転送は大きさに依らず完走する。対象は git の全呼び手 ——
   probe(fetch / ls-remote)、着地の push、clone、publish の push、registry の push —— で、数は `GIT_NETWORK_TIMEOUT_MS` 1 つのまま(ADR 0330 決定2)。
   `gh` と仲介は総時間、git は止まった時間として同じ数を読む: 根拠はどちらも「black-hole した接続を無界に待ってはならない」の 1 つで、道具ごとに
   その道具自身の中断を使うだけである。`lowSpeedLimit` を 1 にするのは「無音」の定義にして 2 つ目の数を作らないため。
2. **総時間の安全網は置かない。** Node の `timeout` は `runAuthedGit` から消える。stall で止まらず総時間でだけ止まる故障を 1 つも挙げられない ——
   ssh 綴りの URL は `http.*` が効かないが名義(credential helper)も効かないので別の欠陥(#2794)、1 byte/s 以上を永久に流す相手は GitHub の故障の
   形ではなく、健全だが巨大な転送に総時間を置けば「遅い」が「永久に不可能」になる。
3. **無界の面は持たない。** `authedGit` の export を削り、`runAuthedGit` の上限は必須引数にする。ADR 0330 決定4「上限は 1 箇所で効かせる」の
   fail-closed 側で、無界でないと壊れる運用は 1 つも無い。
4. **中断の文は盤面が付け直す。** git 自身の中断(curl 28)を `runAuthedGit` が見分け、どの verb が何秒の無音で切れたかを人間が読める 1 文に直す。
   #2726 の「`timed out after N ms`」の約束を stall に移す。push の中断の stderr は `Everything up-to-date` で終わる(実測)ので、生の stderr を
   成功の印に読まない。

## 退けた形

- **3 つにも 30 秒の総時間**(issue 本文の案) —— 大きい repo を永久に clone できない形を決定として残す。
- **clone / publish だけ別の総時間** —— ADR 0330 が退けた「資源ごとの数」で、片方だけ動かしたときに理由が割れる。
- **stall と総時間の併置** —— 2 つ目の数になり、止める故障を挙げられない(決定2)。
- **clone の非同期化** —— hang の問いではない。clone の同期は決定でなく写しで(ADR 0330 決定3 は ref 書き込みの決定、ADR 0066 決定5 は publish の
  決定)、健全な長い転送の間の盤面の凍結は別の設計の問い(#2793)。

## 帰結

- 上限は http(s) の性質で、非 http の remote には効かない。ssh 綴りの GitHub URL が clone / publish に通ること自体が #2794 の主題。
- 中断してもサーバ側の push は完走しうる(実測: 中断の約 57 秒後に ref が動く)。ADR 0330 決定3 の畳みと publish の up-to-date の再送がそれを引き受け、
  新しい機構は足さない。
- #2773 の経路は増えない: git 自身の中断は clone の宛先を消す。
- ADR 0330 の「probe の有界 30 秒の凍結を受容する」は「無音 30 秒」に読み替わる —— pickup の probe(registry と保護ブランチの fetch)も健全に動いている限り完走し、凍結は転送の長さになる(#2793 と同じ性質)。
- `authedGitBounded` の ETIMEDOUT の書き換えと、その釘の文は決定4 の文に変わる。`http.lowSpeedTime` は整数秒なので釘の最短は 1 秒。
- 実装は 1 slice。#2731 のコメントが spec。
