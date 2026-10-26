# meta-review の材料は event の kind ごとに1度だけ定義し、due の件数と注入する節は同じ述語を読む —— 材料・産物・文脈の3種

**Status 追記: 決定1 の「due はその count の和」は due を開く event の数であり、節の行数ではない(issue #2609)。** 節は部分ごとに対象へ畳む —— 同じ停止の初回と第2回は1行(決定6・7)、本文が同じ鎖のエントリの作成と無効化は1行、candidate の作成は文脈の部分(生きている candidate)に出て 店の変更の行にならず、shadow 行は窓の全件を数えて diverged だけ列挙する。不変条件は「その kind の event が1つ窓にあれば due が開き、 その部分の行か件数に現れる」のままで、件数と行数の一致は不変条件に入れない。人間が status で読む「前回からの材料の件数」も同じ数(次の回を 開く event の数)で、spec #2595 User Story 16 の「節に載る材料と同じ数」はこの読みに改める。対象の鍵で distinct に数える案は、鎖・candidate・ diverged の畳みが残るので中途半端として退け、行を組んで数える案は ADR 0300 帰結(履歴に比例して読まない)が退ける。

**Status 追記: 決定5 の異議つき判断の行は、Episode のマーカーでなく event から選ぶ —— 決定7 の停止の行と同形(issue #2609)。** 窓の `objection_attributed` の `entry_id` が指す log entry が行で、異議を打てる4種(判断・完了・前提破れ・記憶の書き込み)のどれでも載る —— 帰責は種類を問わず撃たれるので、材料になる行の集合はそれに揃える(完了の行への異議を学習の入力に数える ADR 0083 の線)。Episode は 判断より前に読んだ / 見た記憶の計算にだけ使い、投影が無ければその2欄は null(既に nullable)、session の spawn が無い行は spawn の id と agent も null。これで「due が数えたのにどの部分にも出ない帰責」—— 投影の無い・未完の session の判断、完了の行・前提破れの行への帰責 —— が無くなる。異議の帰責に投影の門を足す案は、投影の障害を学習の遅れに変えるので退けた。ADR 0252 決定5 の「書き込みの記録は Episode の マーカーになり」は記録の説明で、行の選び方ではない。

2026-10-26 の triage → grilling(issue #2593、#2572 / #2592 の族の根)で決定。ADR 0180 決定1 は「材料 = due が数えた集合そのもの」と
置いたが、code は due を「event の kind × 窓」、節の各部分を「読み口の verb の行」で別々に選んでいて、一致していたのは店の変更だけだった。
停止の帰責は due が数えるのに節に無く(#2572)、routing の行への帰責は memory の due が数えて routing の節にだけ載り(#2592)、
異議つき判断の行は帰責の無い `objection_raised` でも載るのに due は `objection_attributed` しか数えなかった。kind を1つ足すたび・絞りを
1つ足すたびに2箇所を揃える手作業で、落ちた跡が族になった。実測と `file:line` は #2593 のコメントに置く。

## 決定

1. **材料の述語は event の kind ごとに1組。** 1組は「due が数える where・行を受け取る読み手の主題・描く部分」で、due はその count の和、
   節はその組の行。主題の `material` の kind 一覧を型で部分の写像に閉じ(kind を足して描く部分を書かなければ compile が落ちる)、
   「その kind の event が1つだけ窓にある → due が開き、その部分の行か件数に現れる」のテストを、memory の kind 全件と routing の帰責2 kind に
   置く(routing の残りの kind は写像の型だけ —— shadow 行の窓は #2594 で決めてから)。行の**形**は
   今までどおり読み口の verb と同じ(ADR 0180 決定2 の注入の線は選び方を言っていない)。
2. **部分は3種。** **材料** = 窓で切り due が数える(店の変更・帰責つき異議・停止の帰責)。**産物** = 窓で切るが due が数えない
   (決着した提案 —— review 自身の判断への人間の回答で、次の周期を開く証拠ではない、ADR 0151 決定1。名指す candidate / エントリが
   Items to judge になるのは ADR 0278 決定5 のまま、他の材料で開いた周期で判断する)。**文脈** = 窓で切らない(生きている candidate・
   枝の一覧・routing の今の表)。不変条件は「due の kind はどれも材料の部分を持ち、材料の部分はどれも due の kind から組む」。
3. **読み手の主題の絞り(ADR 0279 決定6)は述語に入り、due も主題ごとに絞る。** memory の due は主題が memory / 無しの行の帰責を、
   routing の due は routing の行の帰責(`objection_attributed` と `stop_attributed`)を数え、routing の節は "Objected decisions" に
   加えて "Stops attributed" を持つ(描画は memory と共有、routing の Items to judge は変えない)。
4. **cause `memory` の帰責(異議・停止)は、行の主題を問わず memory の読み手にも載る。** 名指すのは記憶のエントリで、記憶側の閉路は
   memory meta-review が閉じる(ADR 0166 決定5)。`wrong_memory_entries` は memory の Items to judge に入る。routing の行は両方に出る ——
   routing では判断の再掲のため、memory ではエントリのため。
5. **異議つき判断の行は `objection_attributed` だけで選ぶ。** 帰責の無い異議は cause も `wrong_memory_entries` も持たず Items を産まない。
   未帰責の entry は第2回の帰責(ADR 0168 決定1 の撃ち直しの経路)で `objection_attributed` を得て入る。`list_precedents` は同じ行関数
   なので同じになる(ADR 0168 決定3 の Precedent の句はこれに合わせて読む)。
6. **行に載せる判定(cause / `wrong_memory_entries`)は窓の上限 `material_watermark` までの最新。** 注入時と完了時の Items to judge の
   再計算が同じ集合になる。上限を越えた第2回は自分の event で次の周期を開く。
7. **停止の帰責の行**は task・spawn・停止 event・人間の理由・cause・evidence・`wrong_memory_entries`・round で、Episode に依らず event から
   組む(Episode の無い session がある、ADR 0310 決定2)。読んだ / 見た記憶の集合は載せない —— 帰責の門が `wrong_memory_entries` を
   読んだ集合の内側に既に縛っている。記録の鍵は `stop_attributed_event_ids`(ADR 0311 決定4)。

## 退けた案

- **決着した提案も due に数える** —— ADR 0151 決定1 が #936 の実測つきで退けた自己給餌。
- **絞りを外して全部 memory に載せる(ADR 0279 決定6 を戻す)** —— routing の判断の行を routing の Items で再掲する理由は生きている。
- **routing の Items に `memory_entry` を足す** —— 主題 verb を主題の task にしか登録しない線(ADR 0122 決定2)を越える。
- **未帰責の行を材料の部分に残す** —— due が数えない行が材料に1つ増え、不変条件に例外ができる。
- **routing の shadow 行まで同時に「event 1つ → 行1つ」へ直す** —— pickup / exit のどちらで切るかは学習器の outcome の読み方に絡む別の
  判断で、派生 issue #2594 に出す。routing は本 ADR では型の写像と帰責2 kind の行レベルのテストまで。

## 帰結

- 追記する ADR: 0120 決定2(材料の列挙は kind の写像へ)、0180 決定1・2・追記 #1239、0279 決定6(due も絞る)、0310 決定5(節に描く)、
  0168 決定3(Precedent の句)。
