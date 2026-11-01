# 盤面 DB が書きを拒んだ記録の書き込みは床から process を終え、後始末の step の中の盤面のバグは落ちた後始末である —— memory の印は書き込みの後

**Status 追記: 決定1 の「後始末の step の中なら ADR 0112 の落ちた後始末」のうち、session の `writes` の束の手は後始末の外(枠の移動の後)にも届くので、その throw は別名の停止 `unclosedSession` になる。決定6 の残りは枠ではなく session ごとに持ち、枠の解放で消えない。再入の門は `failedTeardown` / `unclosedSession` の行で、読むのは枠の主の session の行([ADR 0344](0344-a-session-closing-write-that-throws-is-an-unclosed-session-halt-keyed-by-the-session-not-the-slot-and-boot-recovery-closes-a-session-that-has-a-later-spawn.md) 決定1〜4、2026-11-01、issue #2876)。**

**Status 追記: 決定6 の落ちた後始末の残りは、question が開いている間に届いた手(遅れた exit の書く step・後始末・回収済み観測)も運ぶ —— 投げた手の後ろに届いた順で並び、撃つのは投げた手が先(2026-11-01、issue #2857)。**

2026-11-01 の grilling(issue #2837、#2822 / #2804 / #2805 の triage sweep で見えた族の根)で決定。記録を書く処理(`appendEvent`・
question の登録・quarantine・`closeSession`・`markTeardown`)が投げたとき、行き先が箇所ごとに割れていた —— timer / stream listener の
同期 throw は `uncaughtException` で落ち、`void` の鎖の throw は床(ADR 0294 決定4)に落ちて log だけで slot を握り続け、2箇所では
梯子が進んで偽の Containment question が立つ。族の20箇所が共有する前提は2つ: **投げた書き込みの底が2つあり、底が分類しない**こと、
**process memory の印が記録より先に進む**こと。箇所ごとの catch の有無は症状である。実測(better-sqlite3 の `err.code` の署名、起動が
既存 DB に無条件の書き込みをしないこと)と箇所の表は #2837 のコメントに置く。

## 決定

1. **族の対象は、盤面 DB(記録の器の一面)が書きを拒むこと(A)である。** 署名は SQLite の `SQLITE_FULL` / `IOERR` / `READONLY` /
   `CANTOPEN` / `CORRUPT` / `NOTADB` の6つで、全箇所に同時に当たり、人間が直すまで続く。失敗 event も停止の行も question も同じ器に
   書くので、記録に頼る行き先は (A) では成り立たない。記録を書く経路の中の盤面のバグ(B —— `CONSTRAINT_*`・`TypeError`・`!` の外れ。
   `BUSY` / `LOCKED` も単一 process の WAL で起きるならこちら)は既存の決定の適用で、新しい決定は要らない: 後始末の step の中なら
   ADR 0112 の落ちた後始末、spawn 前の窓なら ADR 0294 決定3。後始末は GLOSSARY の定義どおり**決着から**で、ADR 0112 の実装が
   `runTeardown` の catch だけに掛かっていたのは写しの範囲の問題である。
2. **(A) の行き先は process の終了である。** 原因(SQLite の code・投げた操作・task id)を stderr に固定の1行で出し、通常の 1 と別の
   exit code で終える。人間が器を直して立て直し(ADR 0318 決定3)、起動時の掃き出しと ADR 0315 の復旧が閉じる。器が書けない間、盤面は
   起動の掃き出しか最初の書き込み(pickup の `UPDATE`)で同じ終わり方をする —— 起動は既存 DB に無条件の書き込みをしないので、
   `in_progress` 行の無い盤面は起動が通る。先行の検査は足さない(ADR 0266 決定3 の線、書き込みそのものが検査)。盤面全体の停止の列挙には入れない —— 列挙は生きている盤面の pickup を止める状態の集合で、process の
   終わりはそこに無い。反対側の ADR の前提は (A) に当たらない: ADR 0294 決定1「盤面を落とさない」は次の poll が自分で直る例外の話、
   ADR 0036 / 0294 決定4「人間面が開いたままなのが復旧経路」は人間の verb も全部書き込みなので面が開いていても操作できず、走っている
   worker の verb も失敗して token を燃やし、梯子も書けないので止められない。cgroup ごと殺せる終了だけがきれいに止まる。ADR 0112 が
   退けた「次の起動でも同じ所で落ちる」は (A) では望む振る舞い(同 決定3「直るまで動かないのが正しい」)。
3. **底は2つとも分類して終える。** `installUnhandledRejectionFloor` が (A) の署名を読み、当たれば決定2 の終了、外れれば今日どおり log。
   `uncaughtException` にも受け手を置き、(A) なら同じ1行と exit code、それ以外は Node の既定と同じく error を出して code 1 で終える ——
   続行はしない。ADR 0294 決定4 が同期の底を登録しなかった理由(状態が壊れうるので続行できない)は、必ず終える受け手には当たらない。
   これで (A) は経路に依らず同じ終わり方になり、箇所は個別の catch 無しに揃う —— ADR 0294 決定4 と同じ「site の注意でなく機構」の
   理路。書き手側の扉(記録を書く1関数)は退ける(退けた形)。
4. **fire-and-forget の境界の catch は (A) を飲まず再 throw する。** 境界とは、投げた例外を底へ渡さずに自分で受けて続ける catch のこと
   —— 起動時の復旧の session ごとの catch、cliAuth の probe、poll 失敗の行の guard、retrospective の sweep がその例で、`pollNow` の
   `.catch(console.error)` のような鎖の末尾の catch、人間の verb の HTTP の error handler と worker の verb の MCP tool error の
   wrapper も含む —— 残すと worker の verb が tool error を返し続け、escalate も書けず、時間制限の梯子が (A) に当たるまで token を
   燃やす(決定2 が memory の停止を退けた理由そのもの)。どれも1つの判定 helper を通す。列挙は実装 issue が持つ(数はこの grilling
   では測っていない)。起動時の復旧が (A) に当たれば起動を拒む形にここで入る。
5. **記録に書けたことを前提にする process memory の印(settled / recorded / reported / pending / 帳簿)は、その書き込みの tx が返った後に
   置く。** 先に置くと rollback の後に再試行も鳴り直しも起きず、行の無い回収を報せる。決定6 の再実行の門が効く前提でもある。
6. **(B) の後始末の step の持ち主は watchdog の runner 1本である。** 分類の `.then` の3箇所、`runTeardown` の呼び口、spawn 前の窓の一撃
   (`afterPoll` の `onSpawnFailed`、adapter の `spawnFailed`)は、throw を受けて ADR 0112 の failedTeardown を立てる runner を通す。
   adapter の鎖の中の書き込み(`closeSession`・資源の停止の登録)は、書く内容の持ち主を adapter に残したまま(ADR 0338 決定4)、書く行為を
   束の中の step として盤面へ渡し、runner がその step を撃つ —— 盤面が撃ち直せない step を残すと、受理が再起動まで通らない。
   受理の再実行は、process が生きていれば memory に残る同じ step、再起動を跨げば起動時の掃き出しが step を置き換えるので後始末の
   再実行のまま。再入の門は failedTeardown の行(ADR 0112 決定4)で、決定5 が印を後ろへ動かしても tick ごとの再 throw にはならない。ADR 0112 決定3 の対象は `runTeardown` から「投げた後始末の step」に
   広がる。ADR 0309 決定4「分類の Promise は reject しない」は値の読みの契約で、鎖の中の記録の書き込みは対象外になる。

## 退けた形

- **process memory に停止を持ち、人間面を生かす** —— (A) では人間面も worker も梯子も書けず、止められない worker が token を燃やす。
  #2383 が誤りと起票した「unhandled rejection で盤面へ上げる」の正しい版に見えるが、止める手段が無い。
- **記録を書く扉を1つ作り、そこで受ける** —— 生の `.run(` が 69 箇所 20 file、transaction 72、better-sqlite3 に全体の error hook は無い。
  底は2つ(床と `uncaughtException`)しかないので、底で揃える。
- **失敗 event を書いて続ける** —— (A) ではその event も書けない。
- **境界の catch を lint で縛る** —— 境界は数えられる数で、helper 1つを通す規則で足りる。数が増えて漏れが観測されたら lint の問い。

## 派生

- Status 追記: ADR 0294 決定4・5、ADR 0112 決定1・3、ADR 0309 決定4、ADR 0266 決定3・4、ADR 0149 決定4、ADR 0336 決定3、ADR 0315 決定1、
  ADR 0331 決定1。
- 実装の切り方は spec #2852 と、その ticket(#2853〜#2857)。#2822 と #2036 は runner の ticket に畳む。
- 起動時の掃き出しの文面「the server restarted」は (A) の終了に少しずれる —— 「盤面の process が終わった」への一般化は text-only の
  派生 issue。
