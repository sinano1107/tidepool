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
3. **復帰は後始末を通る。** 先頭復帰と後始末の印を1 transaction に置き、空の容器へ強制回収を撃ち、回収済み観測を経て tree rule・
   休止位置・slot 解放を走らせる(ADR 0118 決定3 / ADR 0184 決定4 の形)。盤面は流れ続けるので、次に同じ workspace を拾うのは
   別の task でありうる —— 休止位置を飛ばせば checkout は次の pickup まで孤児の task ブランチに居座り、ADR 0052 決定7 が休止位置を
   置いた理由(人間の誤読)に当たる。半分だけ準備された checkout で tree rule が投げても、行き先は既に開いている workspace の
   Quarantine で、slot は解放される。
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
