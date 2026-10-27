# routing の shadow 行は pickup の event に乗り、review は行単位の outcome でなく実績を読み、routing の材料の kind はどれも部分に現れる event だけを数える

2026-10-28 の triage → grilling(issue #2594、#2593 の派生)で決定。ADR 0312 決定1 は routing の shadow 行の窓を本 issue に送った。
code は shadow 行を pickup の窓に1回だけ載せ、due は `worker_exited` を数えていたので、pickup と exit が窓をまたぐと「due が数えた
のに節に無い」が起きた。routing の残りの kind にも同じ形の隙間(review 自身の exit、既知のセルの exit、行でない設定の変更、
行の無い種のセル)があった。実測と `file:line` は #2594 のコメントに置く。

## 決定

1. **shadow 行は pickup の event `task_picked_up` に乗る。** 行の `event_watermark` は pickup がその event の id を書く(呼び順の偶然
   でなく書き手が結ぶ)。節と読み口の窓は event と同じ `(after, upTo]`。全行数・候補が2行以上あった行数も同じ軸。
2. **routing review が shadow 行から読むのは集計で、行単位の outcome ではない。** 昇格の読みは推薦したセルの実績(ADR 0181 決定6)、
   降格の読みは乖離した行で走った学習器のセルの実績 —— どちらも行が pickup 時点で運ぶ。session の outcome は pickup 時点ではまだ
   無く、exit でも決まらず(受理は統合レビューの完了、却下は帰責)、着地は event でなく導出である。節の shadow 行から `outcome` 欄を
   外し(ADR 0312 決定1 の「verb と同じ形」の例外 —— 走行中の行が `excluded` と読まれる誤読を消す)、行単位の outcome は
   `list_routing_shadow` で読む。ADR 0180 追記 #1239 の「shadow 行の outcome が運ぶ」は「実績が運ぶ」と読み替える。
3. **routing の材料の kind はどれも、部分に現れる event だけを where で数える。** `task_picked_up` は work 側・受験者以外(shadow 行を
   書く pickup)。`worker_exited` は work 側・受験者以外で、部分は初観測のセルと「この窓で閉じた本番 session の数」。
   `execution_settings_changed` は `setting = 'row'`(他の変更は文脈の「今の表と設定」に出る)。`interview_scored` は受理の採点
   (root の完了と同じ transaction)。帰責の2 kind と `allocation_reviewed` は変えない。work 側の線は学習器の観測の領域
   (ADR 0272 決定4 追記 / ADR 0110 決定4 Status 追記)で、ADR 0151 決定3(同主題の自身の産物)より広い。
4. **窓で切る部分が今の状態で行を落とすのは、同じ event が別の部分に現れるか、due の where も同じ条件を持つときだけ。** 種のセルは
   どちらも満たさなかった: 表に行の無い (セル, 段) の種を落としていたが、Interview の対象は表に無いセルが前提(ADR 0199 決定5)
   なので主経路が隠れていた。種のセルは同じ段に行があるかを問わず部分と `list_routing_cells` に出し(段が消えていれば
   `tier_retired`)、節での (セル, 段) の最新の種は `upTo` 以下で選ぶ(停止の行の ADR 0312 決定6 と同形)。項目は今までどおり
   (provider, model, effort) が今の表にある行で段は問わない(ADR 0278 追記5)—— 別の段に同じ model の行があれば、その行を測った段へ
   移す判断が項目になり、Interview の結果が表に戻る閉路が繋がる。spec #2190 の「読み手は行のある (セル, 段) の種だけを読む」は
   学習器に狭まる。
5. **受け入れた隙間は2つ(#2650 / #2651 に起票)。** 学習器の分岐が落ちて shadow 行を書けなかった pickup(due は開くが行が無い)と、人間の扉で起こした初回の
   登録が pickup の await 中に落ちた行(spawn が次の窓に落ち、行は `worker_spawned_event_id: null` で載る —— 未起動と未達を同じ
   null が指す)。盤面の登録は poll の先頭で pickup と交わらない。

## 退けた案

- **outcome を変える event を kind に列挙し、行を再掲する** —— `episodeOutcome` の入力の一覧を写像にもう1度書く二重定義。#2593 が消した形。
- **outcome の着地を盤面が event に記録する** —— 受理は導出(ADR 0111 決定1)で、導出の記録は写しになる。
- **exit で切る** —— outcome は exit でも決まらない。**spawn で切る** —— spawn に届かなかった pickup が乖離率の分母から落ちる。
- **`worker_exited` の where に「そのセルの最初の exit」を入れる** —— poll ごとの due の判定で、窓の exit ごとに全 exit を spawn の payload と
  join して走査する(kind の索引は #1031 で未着手)。件数で満たすほうが where は event の性質だけで済む。
- **行が消えたら Interview を中止する** —— 対象は表に無いセルが前提で、向きが逆。
- **隙間を ADR の例外として列挙する** —— 2箇所を手で揃える同期を文書の形で戻す。決定4 の規則と不変条件のテストで塞ぐ。

## 帰結

- 追記する ADR: 0312(決定1 の例外と、本 issue へ送った窓の決着)、0180 追記 #1239(outcome → 実績)、0181 決定6(降格の読み)、
  0273 決定7(種の読み口)。spec #2190 にコメント。
