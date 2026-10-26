# 人間の停止は session を単位に帰責され、判事と RCA は判断ログと行動列に照らし、RCA の材料は停止そのものである —— 帰責の単位は観測の単位

**Status 追記: 決定4 の「材料 id 欄」「材料にした event の id」は登録の欄 `opened_on_event_ids` を指す(issue #2577 で `objection_event_ids` から改名)** —— 起草 verb は `propose_from_material`(引数 `material_id`)、帰責の `entries` は `wrong_memory_entries`。

2026-10-25 の triage → grilling(issue #2553、#2549 / ADR 0308 決定4 の前提から分離)で決定。ADR 0308 は人間の停止の理由を「学習の材料であり
扉でもある」と置いたが、学習の鎖(帰責 → RCA → candidate → meta-review → 承認)は入口から出口まで**判断ログの行**を鍵にしており
(異議群 = entry × triage session、ADR 0170; RCA の材料と所見は行、ADR 0171 / 0278)、停止は行を指さない。issue の案 (a)「判事が
session の判断ログを読んで原因の行を名指す」は、行の鍵という code の形を「学習は行に宛てるもの」と読み替えたもので、それを決めた
ADR は無い —— 「行ごと」は異議が行に打たれるからに過ぎない。もう1つ、停止は証拠が「やったこと」にある最初の学習入力である:
理由は「workspace の外のファイルを消していた」のような挙動で、規則を破る worker はそれを `log_decision` に書かない。挙動の記録は
transcript から盤面が投影する行動列(Episode、ADR 0083 決定8)だが、帰責の判事も RCA も読んでいなかった。実測(Pi / VM の session
ごとの tool 呼び出し数、`file:line`)は #2553 のコメントに置く。

## 決定

1. **帰責の単位は観測の単位。** 異議は行に打たれるから行(異議群)ごと、人間の停止は session に打たれるから session(停止)ごと。
   **停止の帰責**は理由が解けた停止1つに判定1つ(event、鍵は停止 event の id)で、行を名指さない。帰責が付くのは worker への観測だけなので、
   扉は**人間の停止の出口(failure question)だけ**: 停止承認付き cancel は下の task を要らなくした判断であって worker への観測ではなく、
   その reason は材料(ADR 0308 決定1 の欄・history)にとどまる。ADR 0083 決定7 の「異議だけ」は、人間の負の観測が異議しか
   無かった時点の形で、停止はその2つ目。cause の語彙と `memory` の `entries`(読んだ記憶の内側)は ADR 0115 / 0166 のまま。
2. **判事と RCA は、停止と理由(人間の証言、ADR 0308 決定1 の欄)を、その session の記録 —— 判断ログ全体(切れ目無し)・読んだ記憶・
   agent 定義の当時版・行動列 —— に照らす。** 行動列は無条件に読むものなので注入で届け、verb にしない(ADR 0180 の線): tool 名・
   引数の先頭・失敗の印・判断ログの行の位置の印。Episode が無い・読めない session は欄を null にして告げ、それでも撃つ(配分評価の
   `actions` null と同じ)。件数の上限は置かない —— 置くなら停止に近い側を残すが、数は観測されてから。
3. **撃つのは sweep だけ。** 門は「理由が解けていて(event の reason、または理由 question が回答済み)、session が閉じていて、判定が
   無い停止」。回答の verb も停止の verb も撃たない(ADR 0169 決定1)。撃ち直し・打ち切り・Retry / Dismiss は第2回・起草と同じ機構で、
   鍵は停止 event の id。理由が未回答のあいだは扉は開かない。
4. **立つもの。** RCA 向きの cause(`uncertain` を含む)なら self RCA(その session の worker)と auditor RCA が付帯子に立ち、**材料は
   停止 event 1つ**(登録 event の材料 id 欄に置く —— ADR 0171 決定1 の欄は「材料にした event の id」と読む)。所見はその1つを覆う1つ
   (`complete_rca` の形のまま)。RCA の起草 verb は材料の停止を指して書き、第2回は停止を材料にした RCA の所見だけを証拠にする
   (ADR 0120 決定1(a)(c) / ADR 0171 決定2・3 と同形)。同じ停止では後の判定(第2回)が有効で、history・学習器・meta-review・case の
   読み手はそれを読む(ADR 0170 決定1 と同形)。修理子は立てない —— 止めた task の次は人間の retry / abandon が決める。RCA は task の状態に依らず立つ(Held でも、abandon で
   cancelled になっても —— 異議の RCA と同じ、ADR 0268)が、付帯子なので failure question が開いている間は Held で走れない。
   **同じ session に異議と停止の両方があれば帰責も RCA も両方立つ** —— 観測が2つなら帰責は2つで、第2回はそれぞれ自分の材料を覆う
   RCA の所見だけを読む(ADR 0171 決定2)。RCA の重複(self + auditor が1組増える)はこの場面の代償として受け入れ、痛みが観測されたら畳む。`preference` は理由の文言から Board call が起草する(ADR 0120 決定1(b))。
   `requirement_change` / `environment` / `memory` / `agent_definition` / `workspace_document` は異議と同じ列(ADR 0115 決定3・4)。
5. **読み手。** routing 学習器は停止の帰責の `capability` を負の信号に数える(ADR 0170 決定3 の列に停止が並ぶ)。停止の帰責 event は
   memory meta-review の材料。停止由来の candidate の case は session の判断ログ + 停止の行(理由つき、ADR 0308 決定3 の行)で、
   行動列は描かない。task の history の停止の行に cause と evidence を足す(ADR 0166 決定6 の人間の面)。`list_precedents` は広げない。
6. **受験者の停止には帰責を付けない。** 受験者の行が異議を受けないのと同じ理由(ADR 0268 決定1)。止めた受験者は採点されず、次は
   人間の retry / abandon(abandon は対象を外す行為、ADR 0249)。他の型は全部扉が開く。
7. **理由 question は自由記述だけ。** 提案肢(`suspicious behavior` / `work no longer needed`)は実装の写し(PR #2550)で決定ではなく、
   前者は判事に何も伝えない。`stop_reason` 種の項目は**選択肢 0 個・推奨なし**で、答えは required-text の自由記述 —— 「項目 2〜4 肢 + 推奨は肢の1つ」の門に
   種別の例外を1つ足す(quarantine の例外は項目 0 個であって肢 0 個ではない、ADR 0218 決定6。別の例外)。

## 退けた形

- **判事が原因の行を名指し、停止を異議群として投影する(issue の (a))**: 行の鍵は異議の形の写しで、行の無い session で崩れる。
- **盤面が合成の異議を行に打つ**: 人間が打っていない異議が記録に増える(ADR 0083 決定7 の自己申告の線)。
- **`capability` でも理由の文言から直接起草**: 起草経路が3本目になる(ADR 0120 の退けた案と同じ)。
- **提案肢を cause の入口にする**: 人間に cause を選ばせる(ADR 0115 決定2 が注意予算で退けた線)。
- **停止承認付き cancel の reason も扉にする**: 判事を1回余計に撃つだけで安いが、観測でないものを帰責する。cancel の reason に挙動の観察が
  書かれるのが観測されたら開け直す(挙動を見て止めた人間には停止 → abandon の出口がある)。
- **行動列の件数に上限**: 実測は最大 33 件で、長い session は未観測。
- **異議された行がある session では停止の帰責を撃たない**: 異議した行と無関係な挙動で止めたときの学習が落ちる。
- **判定は両方、RCA は同じ session に既にあれば立てない**: 停止の `uncertain` を確定させる所見が来ない(第2回は自分の材料を覆う RCA
  だけを読む)。異議の commit と sweep は別の transaction でどちらが先か決まらず、登録済み RCA の材料は書き換えない。節約量は未観測。

## 追記(2026-10-26 の grilling、issue #2593 / ADR 0312)

決定5 の「停止の帰責 event は memory meta-review の材料」は、周期を開くだけでなく節に描くことまで含む —— 1停止1行(窓の上限までの
最新の判定)で、cause `memory` の `wrong_memory_entries` は Items to judge に入る(ADR 0312 決定3・4・6・7)。routing の行への停止も
routing の材料。`list_precedents` は広げない(行は注入だけで届く、ADR 0180 決定2)。
