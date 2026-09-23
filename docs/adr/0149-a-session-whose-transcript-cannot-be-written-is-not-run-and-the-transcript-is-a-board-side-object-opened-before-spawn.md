# transcript を取れない session は走らせず、transcript は盤面側の器として spawn より先に開く

2026-09-23 の grilling(issue #909)で決定。worker の transcript / stderr の write stream(Claude)と `'data'` handler 内の `appendFileSync`(Codex)はどちらも書き込み失敗を扱っておらず、logDir の消失・権限・`ENOSPC` で盤面のプロセスごと落ちうる(#908 のテストで ENOENT の形を観測、本番は未観測)。現状調査と `file:line` は issue #909 のコメントに置く。

## 決定

1. **transcript は stream と stderr の2本で1単位であり、盤面はこれを取れない session を走らせない。** 記録(イベント履歴と worker transcript、CONTEXT.md「Memory」)は Precedent の原文であり(ADR 0083 追記)、欠けたまま走った仕事は後から監査できない。stderr を診断ログとして切り離す案は、「半分だけ記録が欠けた session」を成立させ、人間がどちらが欠けたかを知る手段を持たない。「ログを捨てて続ける」は選択肢に無い。

2. **記録の口は spawn より先に開き、開けなければ `spawn_failed` に落とす。** 順序は `worker_spawned` → transcript の同期 open → spawn になる。ファイル名に `worker_spawned` の event id が要る(ADR 0083 追記2)ので `worker_spawned` が spawn より先になるが、その event が運ぶ事実は process の有無に依らず真で、非同期の spawn 失敗では既にこの並びが起きている。open 失敗は ADR 0118 の族(process を1つも持たなかった session)そのものであり、決定5「どちらの観測点も `spawn_failed` を書く」にそのまま乗る。logDir が無くても作り直さない — 過去の transcript が失われた事実を隠すことになる(Codex adapter の constructor にある logDir の mkdir も外す — codexHome 側の mkdir は対象外)。

3. **走ってから書けなくなった session は、その場で強制回収する。** 畳み込みの猶予は「記録されない作業を続ける時間」そのものである。ADR 0109 決定4 が行儀のよい exit を待たない理由と同じ向きで、主語は違う(あちらは verb が着地した後の残存)。

4. **証拠は `transcript_failed` event、記録は理由つきの failure question で、経路は ADR 0118 と同じ後始末の型である。** adapter が観測した瞬間に event を書き、question(retry / abandon、推奨 retry)を立て、行を `todo` にして markTeardown → 強制回収 → 後始末。後始末の印があるので ADR 0145 の「self-report なき exit」handler は skip し、question が2枚にならない。question が断言するのは3つ — どの task の worker が・transcript が書けなくなったので盤面が止めた・error code とどちらのファイルか。原因の推測には触れない。理由を運ぶのは観測した adapter であり、原因を知らない handler に文面を書かせない(ADR 0112 決定4)。`worker_exited` の signal だけでは足りない — ADR 0145 の question が立ち、人間は理由を知らずに retry して同じ失敗を踏む。session が既に決着して後始末に入った後に届いた失敗は event だけを書く — 止めるものが無く、「盤面が止めた」が偽になる。

5. **transcript は盤面側の session ごとの器であり、adapter は pipe するだけ。** 容器(ADR 0099 決定2)と同じ立て付けで、開く順序と失敗方針が1箇所に住み、Harness ごとに違う形で壊れる余地を残さない。Codex adapter は `appendFileSync` をやめて pipe に変え、パース用の `'data'` tee は残す。

6. **skill 列挙の `.then` の中から `launch()` を呼ぶ経路の同期 throw も `spawn_failed` の観測点に配線する。** 決定2 の open 失敗がこの経路を通るので、配線しなければ決定2 が成立しない。方針は ADR 0118 が決め済みで、新しい決定ではない。

## 退けた案

- **stderr は診断ログとして書けなくても続ける** — 決定1。
- **仮名で open してから rename し、event の順序を保つ** — 守る価値のない順序のために機構が1つ増える(決定2)。
- **畳み込み停止 → 猶予 → 強制回収の梯子** — 決定3。
- **上限到達による中断と同型の環境事象(question なし、`todo` 先頭へ)** — 再開の門(throttle に相当するもの)が無く、次の pickup が同じ失敗を踏んで回る。
- **記録の dir を6つ目の資源として quarantine / 盤面全体の停止にする** — ADR 0118 決定4 が「question の積み上がりが観測されるまで」退けた gate 形で、今も未観測。観測は派生 issue が受ける。
- **adapter ごとに `'error'` / try-catch を足して同じ callback を呼ぶ** — 方針が2箇所に住む(決定5)。
- **#718(codex-app-server の stdin)を同じ issue で直す** — Board call の側で主語が違い、その issue 自身が観測待ちを選んでいる。
