# 資源の停止で worker が1度も走らなかった pickup は、同じ後始末を通って todo の先頭へ戻り、process を持たない復帰は一撃を1本で共有する

2026-10-18 の grilling(issue #2002)で決定。pickup のあと worker を起動する前に Quarantine を登録して返る枝が、adapter と
scheduler に散っていた —— (Harness, workspace) の組の不成立(Codex の非同期の観測、Claude の同期の検査)、盤面の状態パスとの
重なり、registry drift、pickup 時の workspace の準備の失敗、agent 名の未解決、Git 共有された settings の除外・復元の失敗。どれも拾った task を `in_progress` のまま slot に
残し、cancel は断られ、空くのは watchdog の種別の時間制限か再起動だけだった。slot は1つ(ADR 0001)なので、ADR 0259 決定1 の
「同じ workspace の別の Harness の task も流れ続ける」は成り立っていなかった。ADR 0118 は同じ wedge を同期 throw と spawn の失敗に
ついて解いたが、quarantine の枝は scheduler のコメントが「watchdog か人間が来るまで」と正当化したまま残っていた。実測の表と経路の
調査は #2002 の本文と sweep のコメントに置く。

## 決定

1. **資源の停止で worker が1度も走らなかった pickup は、failure question を立てず task を `todo` の先頭へ戻す。** 契機を問わずすべての枝に
   当てる。retry / abandon の判断が無く(1ターンも走っていない)、資源はもう Quarantine とその question を持っている —— 行の拒否が
   断られた session を先頭へ戻すのと同じ理由である(ADR 0184 決定4)。ADR 0118 決定2 の族(failure question)と分かれるのは、失敗が
   task に帰属しうるか資源に帰属するかの線で、観測点の数ではない。戻った task は、組の停止なら次の pickup が残った行(別の Harness
   の行)で選び直し、workspace / agent の停止なら修復まで候補から外れる —— どちらも同じ枝をくり返さない。
2. **刻む event は1つの kind で、payload に止めた資源の種類・値・理由を持つ。** `cap_interrupted` / `row_refused` /
   `record_container_unwritable` が kind で分かれているのは、戻したあとの扱い(Throttle の再開・行の Quarantine・盤面の停止)が
   違うからで、ここではどの枝も後の扱いが同じである。`spawn_failed` は流用しない —— ADR 0259 決定6 は列挙そのものの失敗だけに
   結び、流用すれば同じ原因で question が2枚立つ。
3. **復帰は後始末を通るが、後始末は worker が触っていない checkout に触れない。** 先頭復帰と後始末の印を1 transaction に置き、
   空の容器へ強制回収を撃ち、回収済み観測を経て後始末を走らせる(ADR 0118 決定3 / ADR 0184 決定4 の形)。盤面は流れ続けるので、
   次に同じ workspace を拾うのは別の task でありうる —— 準備が task ブランチに checkout した後で止まった pickup は、休止位置を
   飛ばせば checkout が次の pickup まで孤児の task ブランチに居座り、ADR 0052 決定7 が休止位置を置いた理由(人間の誤読)に当たる
   ので、退避・tree rule・休止位置を通す。**checkout が休止位置から動く前に止まった pickup(準備の checkout より前の失敗、
   registry drift)では、後始末は退避も tree rule も休止位置も撃たず、slot 解放と pickup の契機だけを通す** —— 退避の冒頭の
   「ブランチに居ない → 拒否」は worker が走った session の違反検出であり、触られていない checkout に当てると、止めた本当の
   理由の隣に `is on 'main', not 'task/<id>' — refusing to commit` という偽の理由を同じ Quarantine に積む(#2229 の実測)。
   後始末がこの区別を知る鍵は**記録**から導く: その task の最後の pickup の後に盤面が刻んだ決着の event が process を持たない
   pickup の種類(`pickup_stopped` / `record_container_unwritable`(ADR 0266)/ `spawn_failed`(ADR 0118 決定5))なら、
   その session は process を1つも持たなかった(ADR 0118 決定1)。そのうえで HEAD が task ブランチに無ければ checkout は
   動いていない。workspace の名前が解決できなければ(drift)戻す checkout そのものが無く、解決し直して Quarantine を
   撃ち直さない —— 同じ観測で2度撃たない。ADR 0113 決定3 の「status から1点で導く」には、この導出が2点目として加わる
   (process を持たなかった session の status は `todo` で、エスカレーション・分解と同じ値になるため)。導いた事実は
   再起動を跨ぐ —— 一撃がメモリで後始末に渡す形(#2231 の drift の `TeardownStep.workspace: null`)は起動時の復旧で失われ、
   復旧が同じ Quarantine を撃ち直す(#2228 の実測)。2026-10-19 の grilling(#2229)で書き直した決定。同じ導出は**完了した session**にも当たる(2026-10-19 の triage、#2259 の実測): session を `done` へ決着させる verb(`complete_task`・`complete_audit`・`complete_interview`)はどれも verb の前の門で workspace を解決しており(解決できなければ門がそこで Quarantine を撃っている)、門を通らずに `done` へ決着させる verb は `runReleasingVerb` が記録ごと拒む —— だから後始末は `done` から「門が既に観測した」と導ける。完了した session の後始末が再起動の復旧で走るとき、解決できない名前は門が既に観測した drift なので解決し直して撃ち直さず、tree rule を当てない。門を持たない決着(エスカレーション・分解)は後始末自身が最初の観測者で、後始末は1度しか走らないので重複しない。後始末の途中で人間がその task を直接 cancel して status が `cancelled` になっても、この導出は変わらない(2026-10-19 の triage、#2257 の実測): process を1つも持たなかった session は status でなく記録から読むので、`todo` は鍵に入らない。止めた資源の question が開いている間は直接 cancel の門(issue #130)が拒むが、question を先に回答すると門は通り、`cancelled` をエスカレーションと同じ「released」に読んだ後始末が、修理直後の触っていない checkout に `refusing to commit` の新しい Quarantine を立てた。後始末中の直接 cancel を拒む門は足さない —— エスカレーションの後始末中の cancel は今日も通って害が無く、人間の cancel はホストの事情で覆る決着ではない(ADR 0109 決定4 の逆向き)。
4. **process を1つも持たなかった pickup の先頭復帰は、一撃を1本で共有する。** 盤面の記録の器の停止(ADR 0266 決定3)もこの一撃を
   通り、後始末を通る。ADR 0266 の決定は「先頭へ戻す」までで、後始末を省いたのは実装の形(#2095)だった —— 省けた理由「同じ task が
   続ける」は、人間が停止中に列を並べ替えれば崩れる。刻む event は経路ごとのまま(決定2 の kind と `record_container_unwritable`)。
5. **pickup が書いた assignee は戻すときに消さない。** 消しても次の pickup は同じ既定 agent に解決し直す(ADR 0233 決定1)。欄に
   入るのは agent であって Provider ではなく、「今動く Provider で走る」は agent が複数 Provider を宣言していれば候補の選び直しで
   得られる。宣言が1つの agent の task を別の Harness で走らせることは別の agent で走らせることで、人間の付け替え(ADR 0233 決定5)
   に残す。

## 退けた案

- **組の停止の2枝だけ直す** —— 残りの枝に同じ wedge が残る。待つ理由は ADR 0118 がすでに外しており、残っていたのは決定ではなく
  scheduler のコメントだった。
- **ADR 0266 の実装の形(先頭復帰 → slot 解放の直撃、後始末なし)に揃える** —— 「盤面が止まる」前提つきの省略で、流れ続ける盤面に
  写すと休止位置の決定を黙って外す。
- **`spawn_failed` と failure question(ADR 0118 決定2 の族に入れる)** —— 判断の無い question が立ち、資源の question と2枚になる。
- **戻すときに assignee を空へ戻す** —— 効果が無く(同じ既定に解決し直す)、先例3本(cap / 行の拒否 / 記録の器)と食い違う。
- **止まった段階を `pickup_stopped` の payload に書く**(#2229)—— 再起動は跨ぐが、ADR 0113 決定3 が退けた「経路を表す永続事実」を
  1つ足す。決着の event の種類と checkout の実物から導けるので要らない。
- **process を1つも持たなかった session すべてで退避と tree rule を省く**(#2229)—— checkout に乗った後で止まる枝(Git 共有された
  settings の除外失敗)は sparse-checkout の失敗で tree を dirty にして止まりうる。そこで退避を省けば休止位置への checkout が dirty
  tree の上で走る。その枝の挙動は測っておらず、別 issue で測る。
