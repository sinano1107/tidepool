# meta-review の判断の行への異議は worker の行と同じく学習に流れ、修理は主題の修理子が対象に限って直し、Behavior は meta-review にも注入される

2026-10-19 の triage / grilling(issue #1915)で決定。meta-review の判断の行(`decision_logged` / `task_completed`)への異議は今も打てるが、
commit で立つものがどれも meta-review に届かなかった —— 修理子は work で主題 verb を持たず、Behavior candidate は宛先の agent が別の仕事を
するときに注入され、routing の材料には異議の節が無く、routing の行への異議は memory の材料に載っていた。実測と `file:line` は #1915 の
コメントに置く。ADR 0278 で判断1つが対象を名指す型つきの行になったので、修理の単位を「行が名指す対象」で引ける。

## 決定

1. **meta-review の判断の行への異議は、worker の行と同じく帰責され、RCA と Behavior の起草が立つ。** 学習を材料の経路だけで閉じない ——
   meta-review は自分で Behavior を書けない(ADR 0120 決定1(c))ので、材料だけでは同じ判断ミスに恒久の教訓が残らない。主題つきの task の
   行から起草する candidate(Board call の起草も RCA の `propose_from_objection` も)の scope は盤面全体(null)—— meta-review は
   workspace を持たない仕事であり、既定 workspace に落とすのは置き場の取り違えである。
2. **主題つきの meta-review の spawn に Behavior の節を注入する** —— 走る agent 宛てか全員宛ての、盤面全体の approved な Behavior /
   Exemplar。ADR 0180 決定2 が worker の記憶の節を組まない理由(scope の解決と案内する verb)は材料の節の話で、指針の節は別に置ける。
   **注入の節に載った Behavior / Exemplar を `read_memory_entries` で読んだら `read` に数える。** 材料の節のエントリは今どおり `seen`。
   線は「指針として注入されたか」で引く。ADR 0122 追記(#1225)の前提「meta-review は spawn 注入を受けない」はここで変わり、cause
   `memory` が meta-review の行にも届く(#1927 の答え)。
3. **memory meta-review の判断の行への異議は `memory_repair` の修理子が直す。** verb は memory meta-review の読み口と書き込み verb
   (define / fold / move / invalidate / propose)を、異議された行が名指す対象に限ったもの —— 書き込みの行の修理(逆操作・置き換え・移動、
   ADR 0252 決定4)とは行の種類で盤面が verb を登録し分ける(ADR 0278 決定1 と同じ形)。同じ task に両方の行の異議があれば修理子は
   1本で、verb は和。対象を名指さない行(完了の行、自由文の `log_decision` の行)への異議は修理子を立てず、帰責と RCA と起草だけが立つ。
4. **routing meta-review の判断の行への異議は第5の type `routing_repair` の修理子が直す。** 性質(repo に書けない・系譜に透明・cascade で
   残る・親の状態を問わず立つ・Executor を写す・組み込みが取れる・学習器の側)は memory_repair と同じで、関数の共有で写す。verb は
   routing の読み口と提案 verb を、異議された行が名指す対象に限る —— 提案は op で対象に写る(ADR 0278 決定5)。セルを名指す行には、
   そのセルの行への提案(`row` / `add_tier` / `interview`)を許す —— セルへの op は無く、セルは行の段ごとの観測だから。成果は提案 question
   なので人間の承認を経るが、異議のコメント1回で周期を待たずに直り、変更が提案の経路(pin・evidence)で記録に残る。
5. **次周期の Items to judge に、窓で異議された同主題の判断の行が名指す対象(生きているもの)を足す。** 両主題。修理子が直した場合は
   その書き込みが店の変更として既に項目なので、これは修理子が直さなかったときの安全網である。
6. **routing の材料に「Objected decisions」の節を足し、Objected decisions と `list_precedents` の行は、行の task が meta-review なら
   読み手と同じ主題のときだけ載せる。** worker・修理子の行は今どおり memory の読み手に載り、主題を持たない読み手(Interview の root)は
   全件。
7. **次周期の「未決着」の門に、同主題の meta-review の open な子(修理子・RCA)と、その子の下の open な提案 question を足す。** 理由は
   ADR 0165 決定1 と同じ —— 修理子の結果は次の review が読む材料で、読まずに次の判断を始めさせない。RCA は述語を1本にするために含める。

## 退けた案

- **学習を材料の経路だけで閉じる(起草しない・RCA を立てない)** —— sweep の推奨。meta-review だけが ADR 0083 の学習の輪の外に残る。
  ADR 0180 決定2 の仕組み上の理由を決定と読んでいた。
- **work の修理子のまま** —— 主題 verb は主題の task にしか登録されない(ADR 0122 決定2)ので、方向コメントを実行できない。
- **memory と routing の修理子を1つの type に統合する** —— 性質が一致しても目的が違えば別 type、共有は関数で(ADR 0272 決定2)。
- **異議で meta-review を即時に登録し直す** —— ADR 0123 / ADR 0166 決定6 が退けた経路。
- **修理子を立てず次周期の Items だけ** —— 周期を待ち、異議のコメントと settings の二度手間(ADR 0252 が退けた理由と同じ)。
- **routing には修理子を立てない** —— 直接書く verb が無いことは何も妨げず、揃えて壊れるものが無い。
- **#1927 を「meta-review の読みは材料」で閉じる** —— 決定2 で前提が変わる。

## 帰結

- 盤面全体で起草した candidate が一木の門(ADR 0178)に当たれば、起草の失敗と同じ扱い(ADR 0164 の撃ち直しと打ち切り)。
- routing の `row` / `promote` / `demote` の提案は evidence を取らないので好みの異議も提案にできる。`agent_tier` / `tier_description` /
  `add_tier` は evidence 必須のまま。
- 追記する ADR: 0120 決定2・0165 決定1(門)、0122 決定2・追記(#1225)、0180 決定2、0252 決定5、0272 決定1〜3、0278 決定6。
- 統合レビュー / RCA の型つきの行への異議は範囲外 —— ブランチを持ち、work の修理子が意味を持つ。
