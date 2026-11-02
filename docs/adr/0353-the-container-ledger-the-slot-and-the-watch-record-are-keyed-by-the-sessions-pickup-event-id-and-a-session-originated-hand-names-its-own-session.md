# 容器の帳簿・枠・WatchRecord の鍵は session の pickup event id であり、session 起点の一撃は自分の session を名指す —— 記録は spawn event id のまま

2026-11-02 の grilling(issue #2919、#2556 の族)で決定。GLOSSARY「容器」は worker session 1つぶんの入れ物、「Slot」を握るのは
task でなく session(ADR 0109 決定2)で、session は容器を開いた瞬間(pickup)に始まる。しかし帳簿(`ProcessContainers`)・枠(`Slot`)・
watchdog の `WatchRecord` はどれも **task id** で持ち、session 起点の一撃(transcript の失敗、sandbox の失敗、init 行の検査、
`settleOnOutputClose`、prompt の送信失敗、Claude と Codex で計8箇所)は `forceReclaim(task.id)` で「その task の**今の**容器」を引く。
同じ task が retry で再 pickup された後に古い session の一撃が届くと、走っている次の session を強制回収して failure question を立て、
記録の tx が投げれば task id の `failedTeardown` が走っている session の梯子を止める(#2919 の triage で実測)。exit だけが #2880 で
`ownsPickup`(spawn id と最後の pickup id の比較)の門を得ていた。8箇所が共有する前提は「一撃は task id で今の session を名指す」で、
#2556 はこれを盤面側の門の語彙と書いたが、根は門(効き方)でなく帳簿と枠の鍵(付与)である。実測の表・呼び口の列挙・`file:line` は
#2919 と #2556 のコメントに置く。

## 決定

1. **容器の帳簿・枠・`WatchRecord` の鍵は、session の pickup event id である。** session の同一性は `task_picked_up` の event id ——
   容器を開くより先に存在し、spawn に辿り着かなかった never-ran の session も持つ(`liveSession` が既に同じ値で生死を見ている)。
   session 起点の一撃は自分の session id で撃ち、死んだ session の `forceReclaim` は帳簿に無い id への no-op(既存の契約)になる ——
   8箇所に門を置かずに構造で閉じる。`WatchRecord` の (task id, pickup 時刻) の鍵も同じ id に乗り、同時刻の pickup の衝突(#2556)は消える。
   Board call の容器 id(接頭辞付き)とは衝突しない。
2. **「まだ決着していない session か」は、枠の session id との一致で問う。** `unsettledTask` は session id を取り、枠の主・後始末中で
   ない・`in_progress` に「枠の session がその session か」を足す。exit の `ownsPickup` も同じ述語に乗せ、門で記録を読み直さない ——
   `spawnedAfterLatestPickup` は記録の読み手(`spawnOfCurrentPickup`、session の窓)のものとして残す。`Slot` は task id の読み手
   (tick・停止・verb の門)が多いので task id を残し、session id を並べて持つ。
3. **一撃は自分の session id を運び、adapter は `start` の引数で受け取る。** transcript の失敗・spawn の失敗・pickup の停止の一撃は
   pickup event id を引数に持つ。adapter は `task_picked_up` を読み直して再構成しない —— id の持ち主は pickup を書いた scheduler で、
   scheduler を通さず adapter を直接走らせる呼び手は自分で与える。`TranscriptFailure` の spawn id は `transcript_failed` event の記録用に残る。
4. **記録と停止の行の鍵は変えない。** exit・Episode・transcript・`unclosedSession`(ADR 0344 決定1)は spawn event id、`failedTeardown`
   は task id のまま。規則は「盤面の memory(帳簿・枠・`WatchRecord`)は pickup id、記録は spawn id、橋は `spawnOfCurrentPickup`」。
   ADR 0344 決定1 が spawn id を選んだ理由(never-ran が持てない)は pickup id なら消えるが、行の受理は記録から閉じ直すので記録の鍵で
   引く方が読み手が1つ減る。
5. **枠の主でない session の transcript の失敗は event だけを書き、その書き込みが盤面のバグで投げたら spawn event id の
   `unclosedSession` である。** `sessionCloseSteps` の印を付け、受理の撃ち直しが event を書く。再起動を跨げば ADR 0344 決定3 と同じ損失。
   同じ session の決着後に届いた失敗は ADR 0149 決定4 のまま event だけ(#2874 の問いは両方の枝に当たる)。

## 退けた形

- **8箇所の一撃に `spawnedAfterLatestPickup` の門を置く** —— 述語の写しが8つになり、次に adapter 側へ非同期が入れば同じ形が開く
  (#2556 が既に書いている)。点修正として試すと通る(#2919 のコメント)が、鍵の食い違いは残る。
- **adapter が `open` の返す容器オブジェクトを握って直接 `forceReclaim()` を撃つ** —— `ProcessContainers.forceReclaim` が唯一の
  呼び口で、`forced` の帳簿(回収済み観測の不成立の読み)を外れる。
- **`unclosedSession` の値も pickup id に揃える** —— 決定4 のとおり、記録から閉じ直す受理の読み手が増えるだけで、壊れるものを挙げられない。

## 派生

- Status 追記: ADR 0099 決定2、ADR 0109 決定2、ADR 0136 決定3・10、ADR 0149 決定3・4、ADR 0309 帰結、ADR 0344 決定1。
- GLOSSARY: Worker session(同一性)、容器(id)、Slot、Transcript(枠の主でない session の失敗)。
- `liveSession` は変えない —— spawn 前の継続の門で、pickup id のほかに status と後始末の印も読む。
- 読みのみの副産物: cgroup の容器名は `container-<id>` なので、同じ task の再 pickup が前の session の残骸と同名にならなくなる。
- 実装は族の根 #2556 から `/to-spec` → `/to-tickets`。#2919 はその実測1例。
