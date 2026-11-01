# 閉じた session の stream 由来の欄は1つの読み手から作り、出所は live の pipe か記録済みの transcript、session の窓を記録の上で閉じる位置は1つの規則で読む

**Status 追記: 決定1 の「分類(ADR 0309)は呼び手が足す」は ADR 0338 で、読み手の出力のうち帰結に要る事実を呼び手が束にして渡す形になった(2026-11-01、issue #2791)** —— 決定3(帰結は live の呼び手だけが撃つ)は変わらない。

2026-10-27 の triage → grilling(issue #2632、#2600 / ADR 0315 の族の根)で決定。session を閉じる関数は ADR 0315 決定1 で1本になったが、
`worker_exited` の stream 由来の欄(消費・model の差し替え・拒否・advisor・最後の発話・CLI の報告した失敗)を作るのは adapter の
メモリ上の観測だけで、起動時の復旧は同じ bytes が transcript にあるのに読まず、欄を null に固定していた。記録の上で session の窓を閉じる
位置の規則も読み手ごとに違っていた(exit のポインタ / 次の spawn / 最後の pickup の後の決着 kind / transcript ファイルの存在)。
実測・読み手の表・`file:line` は #2632 と #2633 のコメントに置く。

## 決定

1. **stream 由来の欄は、Harness ごとに1つの純粋な読み手(行の列 → 観測)から作る。出所は2つのままにする** —— live の adapter は
   今までどおり pipe から1行ずつ食わせ、起動時の復旧は記録済みの transcript を食わせる。payload のうち stream 由来の部分は
   どちらも同じ読み手の出力で、process の事実(exit code・signal・読み切り)と probe(Codex の `usage_recheck`、ADR 0261)と
   分類(ADR 0309)は呼び手が足す。1本にするのは**写し**であって**出所**ではない —— live も transcript を読み返す形は、確定点
   (ADR 0201)を transcript の close まで動かし、走ってから記録の器が書けなくなった session(ADR 0149 追記1)でメモリが持っていた
   消費を捨てる。
2. **復旧の `worker_exited` は、読み手が出すものを全部埋める。** 欠測で残るのは transcript に無いものだけ —— exit code・signal・
   読み切り(false のまま)・`usage_recheck`・分類・所要時間。ADR 0315 決定2 の「消費は欠測、最後の発話と CLI の報告した失敗は
   埋めない」はこの決定で反転する —— あの線は「復旧は stream を読まない」前提で引かれたもので、読み手が1つになった後に
   表示専用の欄だけ null にするのは意図的な分岐を1つ足すことになり、埋めて壊れる読み手は無い(判定は読まない、ADR 0104 決定2 /
   ADR 0184 決定3)。transcript が無い・読めない session は欠測のまま閉じる —— session が終わった事実は変わらず、読み手は exit の
   有無で開く。閉じないと起動のたびに同じ session を報告し続ける(#2633 で観測)。
3. **読み手は観測を返すだけで、帰結は live の呼び手だけが撃つ。** CLI 認証失敗の quarantine、行の拒否の通知、failure question と
   cap の後始末、tool surface の検査(stream の途中で session を止める)は live の観測から撃つものであり、復旧は撃たない
   (ADR 0315 決定6 の続きを決めるのは failure question のまま)。
4. **session の窓を記録の上で閉じる位置は1つの規則で読み、記録の事実にはしない。** session の終わり(回収済み観測、ADR 0109 決定2)は
   記録に event が無く、読み手は exit の記録で代用してきた —— その代用の規則を1つにする。規則は「その spawn を指す `worker_exited` → 無ければ spawn の
   窓にある process を持たない決着(`spawn_failed` / `record_container_unwritable`、ADR 0118 決定1 の never-ran)→ 無ければ同じ task
   の次の `worker_spawned`」で、exit と never-ran の決着が両方あれば exit を優先する。session の窓(Episode の投影・学習器・決定ログの
   anchor)、後始末の決着の導出、起動時の復旧、明示の backfill がこの1つを読む。後始末の決着は主語が pickup なので(`pickup_stopped`
   は spawn より前にしか書かれない)、「最後の pickup に spawn が無い」枝を自分で持ち、spawn がある枝で never-ran の述語を共有する。
   never-ran の spawn は閉じない —— exit も Episode も書かず、一時領域も消さない(#2633、ADR 0315 Status 追記)。
5. **投影器(Episode)は別の読み手のまま。** 出力が違い(行動列と session の総量)、`worker_exited.usage` が正本で Episode が参照する
   向き(ADR 0297)を逆転させない。行の parser は既に共有している。

## 退けた案

- **live も transcript を読み返して payload を作る(出所も1つ)** —— 決定1。
- **`session_closed`(理由: 観測した / 観測していない / never-ran)を1 event 足す** —— 決着の event の種類から導けるものの写しで、書き手が
  3経路増える。ADR 0113 決定3(経路を列に持たず1点で導く)と ADR 0274 が退けた「経路を表す永続事実」と同じ向きで退ける。
  `worker_exited` が exit の観測と境界を兼ねる歪みは、読み手の規則を1つにすれば解ける。限界は同じ: spawn 直後、非同期の spawn
  失敗が届く前に盤面が落ちた session は、どちらの形でも走った session と区別できない。
- **stream の観測(差し替え・拒否・advisor・subagent)を `usage` の外へ出し、result 行の無い session でも残す** —— 主題が違う
  (ADR 0215 決定3 の置き場の反転)。別 issue で決める(#2632 のコメント)。result 行の無い session では復旧の再生でも
  これらは残らない —— 狭い窓(result 行は書けたが exit の記録の前に落ちた)でだけ消費一式が埋まり、広い窓(session の途中で
  落ちた)で埋まるのは最後の発話と CLI の報告した失敗だけである。

## 帰結

- CONTEXT.md の Worker session(復旧が閉じるときに読むもの、窓を閉じる位置の規則)。
- ADR 0315 決定2 に Status 追記(欄の範囲の反転)、Status 追記の「判定の形は #2632 で決める」は本 ADR 決定4 を指す。
- 記録の形の変更は無い(欄は増えず、既存の欄が埋まるだけ)。実装は2 slice: 窓を閉じる位置の規則(#2633)→ 読み手と復旧の
  再生(#2632)。
