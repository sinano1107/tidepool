# issue 展開の一時的失敗は、pickup で GitHub を読む task をその poll から外して次の head へ進み、成功を挟まず10分続けば確認 question を立てる —— task の性質の門は head の歩きの中に置き、例外を飲まず verdict を返す

2026-10-30 の triage → grilling(issue #2704)で決定。issue-backed task の展開が `IssueGoneError` 以外で投げると、pickup の門は null を返し
poll は `SUCCEEDED` で終わっていた。後ろの通常 task は見られず(head-of-line blocking)、上限も question も無く、しかも本体に入った後の
return なので ADR 0294 の連続失敗の計測を**戻し**、開いた `pollFailure` question を観測で決着させていた —— 信号に入らないどころか信号を
消す側だった。親の文面の経路(ADR 0321 決定5)も同じ形。ADR 0016 の「Throttle と同じ fail-closed」は書いた時点(2026-07-13)の Throttle
(盤面全体の skip、ADR 0030)に忠実で、Throttle が entry 単位の除外になった ADR 0110(2026-09-10)に issue-backed の経路だけ追随して
いなかった。code の読みと `file:line`、除外の集合の SQL、テストの釘は #2704 のコメントに置く。

## 決定

1. **一時的失敗は環境事象(天候)のままである。** 門に届く時点で使用量の読み(anthropic)と Registry reachability(仲介の token + git fetch)
   は通っているので、残る失敗は GitHub API 面(`gh`)だけの障害か `gh` の破損。1回目は skip し人間を呼ばない。`gh` の破損は決定3 の時間の線で拾う。
2. **skip の単位は poll ではなく「pickup で GitHub を読む task」の集合である。** issue-backed task と、issue-backed の親を持ち pickup で
   親の文面を live で読む子。最初の失敗がどちらの経路でも、この poll の残りからその集合を外し、通常 task だけを候補に次の head へ進む。
   同じ poll で2つ目の `gh` を撃たない —— 失敗は task の性質でなく API の性質である。registry drift で門が止めた head は、その head だけ
   外して `stopped` を引き直し、次の head へ進む。
3. **展開の成功を挟まず失敗が10分以上続けば、Tidepool 名義の確認 question を1枚立てる。** Quarantine 族を借りる(ADR 0112 の借り方): kind は
   `issueExpansion`、門の役は持たせない(除外が機構、question は信号)。受理の検査は最後に失敗した参照(workspace, issue 番号)の再展開で、
   `IssueGoneError` 以外で投げれば本文つきで拒む。本体の展開が1つ通れば回答なしで決着する(ADR 0184 決定5 の形)。`IssueGoneError` は
   API が答えた証拠なので成功に数える(確定的失敗の failure question は従来どおり)。計測は memory、10分の線と回数を条件にしない理由は
   ADR 0294 決定2 と同じ。question が断言するのは、いつから・何回・最初と最新の例外本文・最後に止めた task の id だけ。
4. **ADR 0294 の「成功」の定義は触らない。** GitHub を読む task を全部外して本体を終えた poll は投げていないので成功であり、`pollFailure`
   question を観測決着させるのは正しい。2つの計測を1本にすると片方の回復がもう片方を消す —— 今回の欠陥そのもの。
5. **task の性質の門は head の歩き(heads ループ)の中に置く。poll 全体の return は盤面全体の資源にだけ許す。** 今回の4出口(2関数 × 一時的
   失敗 / drift)はすべてループの後ろに置かれた task 単位の門で、置き場所のせいで poll 全体の出口しか持てなかった。Registry reachability
   の検査は poll で1回に memo 化し、issue 展開・親の文面と一緒にループの末尾へ置く —— CONTEXT.md「Registry reachability」が頼る順序
   (Throttle の観測 → registry → issue)は変えない。
6. **門は例外を飲まず verdict(通す / この head を外す+理由 / poll を止める+理由)を返し、除外・計測・log はループの1箇所が行う。** 門が
   自分で catch して null を返すと、その失敗はどの会計からも消える。
7. **読み口は2つ。** `GET /api/queue` に `lastPollFailure` の兄弟行 `lastIssueExpansionFailure`(いつ・例外本文・task id)を持ち、WebUI の
   同じ場所に描く。queue の Pickable head は、streak が開いている間は決定2 の集合を skipped に見せる —— 除外は poll 内の memory なので近似
   (次の poll は1度は試す)だが、pickup の述語と表示が同じ引数を1つの式から出す線(ADR 0110 決定3)を保つ。

## 退けた形

- **poll 全体の skip のまま** —— Throttle の fail-closed の交換「失うのは回復可能な待ち時間だけ」は、除外が最も狭い単位で待ちが有界なときに
  しか成り立たない。この経路は無界・無音で、交換の条件を満たしていなかった。
- **1回目で question** —— 天候に question が立つ(ADR 0294 が退けたのと同じ)。通常 task の fetch 失敗(workspace の Quarantine)に揃える
  逆方向は別 issue。
- **`pollFailed` の streak に混ぜる** —— 通常 task が1つ拾われれば成功で計測が戻るので、通常 task が流れる盤面では永久に立たない。
- **回数で立てる** —— 契機の連打で数秒に2回起きる(ADR 0294 決定2)。
- **受理に poll 本体の撃ち直し** —— 通常 task を拾って GitHub を触らずに終わると検証なしで受理になる。
- **head ごとに `gh` を撃ち直す(entry 除外と同形)** —— issue-backed が N 本並べば死んだ API に N 回撃つ。

## 帰結

- ADR 0016 の「Throttle と同じ fail-closed」は ADR 0110 以降の entry 除外の形で読む(追記)。ADR 0321 決定5 の「その cycle の pickup を skip」は
  決定2 の集合の除外に変わる(追記)。ADR 0294 の計測に兄弟が1本増える(追記)。
- CONTEXT.md に「環境事象」の定義が立つ: 人間を呼ばずに skip してよい条件は、除外が最も狭い単位であること・待ちが有界であること(再開時刻か
  時間の線)・成功に数えないこと。#2382(壊れた registry の分類)はこの定義に照らす。
- `gh` の呼び出しに timeout が無く hang すれば poll が戻らない件は別機構なので派生 issue。門の並びを export にする seam の問い(#665)は
  verdict 型の導入と独立で、blocked-by にしない。
- 実装は1 slice。#2704 のコメントが spec。
