# 前の盤面が閉じ切らなかった session は次の起動時の復旧が閉じ、観測していない exit は印を持つ exit の記録で表す

**Status 追記: 決定1 の復旧の session ごとの catch は、盤面 DB の拒否以外の throw を log して流さず `unclosedSession` の行を立てて起動を続ける。決定3 の「同じ task に後の spawn があれば exit の記録は書かず投影だけ」は撤回 —— 窓が次の spawn を越えない規則(ADR 0316 決定4 Status 追記)で理由が消えたので、復旧は `exit_observed: false` の exit と投影を書く。一時領域の削除だけは、その task の spawn が watermark より後に無いときに限る([ADR 0344](0344-a-session-closing-write-that-throws-is-an-unclosed-session-halt-keyed-by-the-session-not-the-slot-and-boot-recovery-closes-a-session-that-has-a-later-spawn.md) 決定2・5、2026-11-01、issue #2876)。**

**Status 追記: 決定1 の復旧の session ごとの catch は盤面 DB の拒否の署名を飲まず再 throw し、起動を拒む([ADR 0342](0342-a-record-write-the-board-db-refuses-ends-the-process-from-the-floor-and-a-board-bug-in-a-teardown-step-is-a-failed-teardown.md) 決定4、2026-11-01、issue #2837)。**

**Status 追記: 決定3 の対象から、process を1つも持たなかった session(ADR 0118 決定1、`spawn_failed` / `record_container_unwritable` で閉じた spawn)は除く(issue #2633)** —— 復旧が exit も Episode も書かない。判定の形は [ADR 0316](0316-the-stream-derived-fields-of-a-closed-session-come-from-one-reader-fed-live-or-from-the-transcript-and-a-sessions-window-is-closed-on-the-record-by-one-rule.md) 決定4(窓を閉じる位置の1つの規則、位置で対にする)。

**Status 追記2: 決定2 の「盤面が持たない値(消費)は欠測、CLI の報告した失敗と最後の発話は埋めない」は [ADR 0316](0316-the-stream-derived-fields-of-a-closed-session-come-from-one-reader-fed-live-or-from-the-transcript-and-a-sessions-window-is-closed-on-the-record-by-one-rule.md) 決定2 で反転(issue #2632)** —— 復旧は記録済みの transcript を live と同じ読み手で読み、stream 由来の欄を全部埋める。欠測のまま残るのは exit code・signal・読み切り・`usage_recheck`・分類・所要時間。印(`exit_observed`)と「復旧の記録の時刻は起動の時刻」はそのまま。

2026-10-27 の triage → grilling(issue #2600、#2570 の派生)で決定。session を閉じる仕事 —— `worker_exited` を書く、Episode を投影する、
task の一時領域を消す —— は Claude / Codex adapter の終了処理にしか無く、盤面が session の途中か投影の前に落ちると誰もやり直さなかった。
欠けた session は routing 学習器・memory meta-review の Precedent・停止の帰責(ADR 0310 の門は `worker_exited` を見る)から抜け、
task の一時領域は残る(#1955)。Lima VM の実測(盤面を `kill -9`、孤児の挙動、再起動後の記録、末尾行を切った投影)と `file:line` は
#2600 のコメントに置く。

## 決定

1. **起動時の復旧に「session を閉じる」仕事を1つ置く。** adapter の終了処理と同じ3つを同じ順(exit の記録 → 一時領域の削除 → 投影)で、
   前提検査が「前の盤面の process は残っていない」を証明した後、後始末の復旧(ADR 0109 決定5 / ADR 0254 決定2)より前に同期で走らせる。
   走る点は後始末の復旧と同じ2点 —— 前提検査の通った起動列と、Harness Containment の確認回答の受理。後始末の復旧の中には置かない:
   そちらは印の無い session(`worker_exited` の後、transcript の close の前に落ちた窓)を拾えず、末尾の pickup の契機が帰責の sweep を
   Episode の無いまま撃つ。
2. **盤面が観測していない exit は、`worker_exited` に「exit を観測していない」印の欄を1つ足して表す。** 新しい kind は作らない ——
   session の窓(`sessionWindow`)・停止の帰責の門・学習器・配分評価は `worker_exited` の有無で開くので、同じ kind なら読み手を広げずに
   全部開く。null の組み合わせ(exit code も signal も無い)だけで言わせない —— payload を名前で読む人間と判事が解釈を要する。印は
   復旧だけが書き、adapter は書かない(欄が無い = 観測した)。盤面が持たない値(exit code・signal・消費)は欠測、読み切りは false
   (ADR 0201 の「読み切る前に終わった」はそのまま当たる)、stderr の末尾は盤面側に残る記録から埋め、CLI の報告した失敗と最後の発話は
   埋めない —— transcript が記録の正本(ADR 0149)で、行動列は Episode が運ぶ。
   所要時間も導かない(欠測)—— 復旧の記録の時刻は起動の時刻で、session の終わりではない。読み手(学習器の所要時間、routing
   meta-review の材料)は exit の記録の時刻からではなく、この印で欠測を知る。
3. **対象は、対応する `worker_exited` の無い `worker_spawned` のうち、起動時点の最大 event id 以下のもの。** task の状態では選ばない ——
   停止や watchdog で後始末の印が付いた後に落ちた session は status が決着していても exit の記録は無い。起動時点の watermark は、受理の門
   から走る復旧が、走行中の別 Harness の session(spawn 済みで exit 前)に偽の exit を書かないための線である。
   同じ task に後の spawn があれば exit の記録は書かず、投影だけする —— session の窓は次の spawn で既に閉じていて(`sessionWindow`)、
   後から id の大きい exit を書くと窓が次の session に重なる。再起動中断では失敗の記録(起動列の failure question)が exit の記録より
   先になる —— ADR 0145 の「exit の瞬間に失敗を記録」の順はこの経路だけ逆で、窓の読み手はどちらの順にも依らない。
4. **投影は、どの投影器の版でも Episode の無い spawn だけ、1件ずつ失敗を記録して流す。** 全走査の backfill(`backfillEpisodes`)は
   明示の操作のまま残し、起動では撃たない —— 冪等判定より先に transcript を読むので起動ごとに全件読み直し、版を上げた起動は全件を
   同期で再投影する。transcript が無い・読めない session は記録の dir が後から失われた印(ADR 0314 決定2)で、起動を落とさない。
5. **task の一時領域は、閉じた session の task ごとに消す。** 一時領域の置き場を丸ごと掃くことはしない —— 同じホストに盤面が複数立つ
   (開発 VM の形)と、他の盤面の走っている session の socket と設定を消す。
6. **続きを決めるのは復旧ではなく、既存の failure question の retry / abandon のまま。** 再起動中断は「self-report なき終了」の失敗で
   (ADR 0001 / ADR 0145 決定2)、人間が retry と答えれば同じ task branch に新しい session が立つ。復旧が足すのは死んだ session の
   記録を閉じることだけ。閉じた記録の読み方は既存のまま —— 停止の帰責は人間の停止がある session にだけ開き(停止は盤面が生きている
   間に記録され、材料はそこまで揃っている)、学習器は受理も capability 帰責も無い session を `excluded` に数える。

## 退けた案

- **再起動で失われた session を言う新しい kind** —— `worker_exited` の有無で開く読み手を全部広げる。
- **`output_closed` を3値にする** —— 読み切りの有無とは別の事実(盤面がその場に居なかった)を同じ欄に畳む。
- **一時領域の置き場を起動時に全掃除する** —— 決定5。
- **孤児(盤面が落ちた後も走り続ける worker)の予防をここで決める** —— 別の機構(監督者が誰か)で、別 issue(#2630)。
- **閉じる処理を記録(exit の事実 + transcript)から導く1本にし、usage も transcript から取り直す** —— 根の設計で、この issue の後も残る
  損失(観測していない exit の usage・refusal・model swap が null)を塞ぐ。族の根の issue(#2632)で決める。本 ADR は
  その最初の slice で、閉じる関数は live と復旧で1本にする(写しを4つにしない)。

## 帰結

- CONTEXT.md の Worker session(終わりを観測できなかった session の閉じ方)と後始末(再起動中断の文)の項。
- ADR 0083 追記10(投影の呼び手に復旧が加わる)、ADR 0109 決定5 / ADR 0254 決定2(復旧に1段増える)、ADR 0145 決定2(再起動中断にも
  exit の記録が付く)、ADR 0310 決定1(門は復旧の記録でも開く)に Status 追記。
- 記録の形の変更は additive(欄1つ)。実装は1 slice、#1955 を畳む。#2600 のコメントが spec。
