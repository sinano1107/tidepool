# RCA 子と修理子は材料の異議を記録に持ち、第2回はその異議群を覆う RCA だけを待って証拠にする

2026-09-28 の grilling(issue #1124、ADR 0170 の派生)で決定。帰責の単位は異議群(entry × 束ねた session)になったが(ADR 0170)、
第2回の帰責が決着を待ち findings を証拠にする RCA 子は task 全体から引いていた —— RCA 子と異議群を結ぶ印が無く、目印は題の接頭辞
だけだったため。同じ task に2つの異議群が並ぶと、前の異議群の第2回が後の RCA の決着まで撃たれず、両方の findings が互いの入力に混ざり、
前の RCA の reviewer の起草 verb は「最後の異議群が未帰責」で拒まれる(ADR 0170 決定5 が受け入れた形)。RCA 子は異議群ごとではなく
commit(session × task)ごとに立ち、1本が同じ session の複数の異議群を覆う。今の実装の walk-through は #1124 のコメントに置く。

## 決定

1. **RCA 子と修理子は、材料にした異議 event の id 列を登録の記録(`task_registered`)に持つ。** 帰責 event が持つ欄と同じ形で、
   異議群との照合も同じ「異議群の最初の異議 id を含むか」。題の接頭辞は表示のままで、識別には使わない。tasks 表には列を足さない ——
   登録の事実なので `integration_review` と同じく event 側に置く。
2. **第2回が決着を待ち、`rca_findings` にする RCA 子は、その異議群を覆うものだけ。** self RCA は worker ごとの entry だけを材料に
   するので、session で照合するより狭く正確 —— 別 worker の self RCA の findings は入らない。修理子の登録 event(「当時の decision log
   の切れ目」、ADR 0168)も同じ記録で引く。
3. **RCA の起草 verb(`propose_from_objection`)は、自分の RCA が覆う異議群の判定を読む。** ADR 0170 決定2 の「entry を1つの値で
   読む読み手」の列挙からこの verb を外し、決定5 はこの決定で置き換える —— review 子の文脈を持つので1つの値で読む読み手ではない。
   材料に無い entry(同じ task で別 session に異議されたもの)は拒む: RCA が調べた異議から起草するための verb で、倒すと決定2 の
   読み手が verb の中に半分残る。

## 退けた案

- **印を持たせず 1〜3 を受け入れる** —— 帰責の単位を異議群に揃えた後に残る唯一の task 単位。既存挙動の確実な欠陥なので観測は待たない。
- **triage session の id を印にする** —— 異議群の定義(entry × session)には合うが、self RCA が覆わない別 worker の entry まで一致する。
- **tasks 表の列** —— 大半のタスクで null になる列を、登録の事実のために足す。
- **材料外の entry は最後の異議群の判定に倒す** —— 決定3 の理由のとおり。
