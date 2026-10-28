# 子の `parent` の文面は子自身の pickup で凍結し、RCA 子は材料の session が spawn で受け取った文面を記録から読む

**Status 追記: 決定1・2 の記録の `user` は ADR 0326 決定4 の task 固有の部分として読む** —— Codex の user turn 全体に含まれる盤面の文を親の文面に混ぜず、材料の session が受け取った task 本文を逐語で読む線を保つ(2026-10-29、issue #2692)。

2026-10-28 の triage → grilling(issue #2663、ADR 0320 決定1 が決定の外に置いた「親の文脈」)で決定。`get_current_task` の envelope の
`parent` の文面(title / purpose / 完了基準)は、親が issue-backed なら子が verb を呼ぶたびに issue を再展開していた。停止・異議の
帰責の判事は材料の session の記録の `user`(ADR 0320 決定3)に照らすのに、同じ停止を調べる RCA 子は RCA 時点の issue(停止後に人間が
付けたコメントを含む —— worker は issue に書けない)を「task が求めたこと」として読む。`parent` の読み手は RCA 子だけでなく、
`parent_id` を持つ6種の子全部で、他の5種には親の文面に照らして裁く読み手がいない。code の読みと `file:line` は #2663 のコメントに置く。

## 決定

1. **RCA 子の `parent` の文面は、材料の session が spawn で受け取った文面を記録から読む。** 材料(停止 / 異議の行)ごとに
   その session の `worker_spawned` を引き、記録の `user` を逐語で載せる —— 判事の `task` と self RCA の定義の証拠節(ADR 0314 決定1)と
   同じ記録。親が issue-backed かどうかで分けない(stored の親も Edit で文面が変わりうる)。
2. **形は1本の text で、常に列。** `user` を3欄に parse しない(再構成を文面に対して作ることになる、ADR 0314 の退けた形)。
   列の要素は text と、それが live だった材料(entry id / 停止 id)の列。text が同じ spawn は1要素に畳む(定義の証拠節と同形、
   ADR 0314 決定6)。spawn はあるが記録が読めない材料は、同じ列に text 無しで欠落を申告する(ADR 0314 決定2 の形)。
3. **RCA 以外の子の `parent` の文面は、子自身の pickup で展開して Slot が持ち、session 中は変わらない。** ADR 0016 の「使用の瞬間 =
   spawn」に親の文面も揃える。issue を磨けば次の spawn に届く(ADR 0016 の根拠)のは変わらず、session 中に親の issue が閉じられても
   verb は気づかない —— ADR 0320 帰結の文が子の `parent` でも成り立つ。
4. **材料の session が無い RCA 子(実行前の親の下の auditor RCA、ADR 0292)は決定3 の経路に落ちる。** 帰責が付くのは worker への
   観測だけ(ADR 0310 決定1)なので、揃えるべき判事がいない。ADR 0314 決定2 の「欄の空は記録の dir が後から失われた印」は当たらない
   —— 記録は失われたのでなく、最初から要らなかった。worker の session が無かったことを1行添える。
5. **子の pickup で親の issue が閉じていても文面は載せ、無くても子は止めない。** closed の issue は文面(title / body / comments)が
   読めるので3欄を載せ、not_found だけ3欄が無い。issue の番号と状態(open / closed / not_found)は3欄と同じ `parent` object の兄弟欄
   `issue` に構造で置く —— 散文の「issue #N is closed」では、`parent` に番号が無い以上、読み手が同じ対象かを推測することになる。
   一時的失敗は自分の issue と同じくその cycle の pickup を skip。親の issue が閉じたことは子の失敗ではない —— 親の計画が死んだなら
   cancel の cascade が倒し(ADR 0271)、issue だけが閉じたなら PR を開く段で盤面が気づく(ADR 0320 帰結)。自分の issue の pickup gate
   (closed → failure question)は変えない —— そちらは「task が死んだ」の判定で、別の問い。

## 退けた形

- **RCA 子も今の issue を読み、判事とのずれを受け入れる** —— ADR 0320 が判事側で閉じた穴を RCA 側に残す。停止の理由は停止 event と
  行動列で届くので、停止後の issue のコメントを RCA が読む必要は見つからなかった。
- **RCA 以外の子も親の書き手の session の記録から読む** —— 「親の書き手が見た文」で揃うが、人間の分解の子は null になり、読み手がいない。
- **親の issue が死んだ子に failure question** —— 宛先が親の生死に依らない RCA 子(ADR 0271)を親の issue の都合で止める。
- **closed の親の文面を捨てる** —— 文面は手元にある。merge 後に人間が登録する review 子や、not planned で閉じた親の下で生き残る RCA 子が文面を失う。
- **実行前の親の RCA 子は null + 申告** —— 人間の分解が task に合っているかを見る RCA が task の文を持たない。

## 帰結

- ADR 0320 帰結「verb での IssueGoneError の経路は消える」は slot の task に限らず、子の `parent` でも成り立つ(Status 追記)。
- 親の展開のための GitHub 呼び出しが、issue-backed の親を持つ子の pickup で1回増える(決定3 の経路を通る子だけ)。
- 実装は1 slice。#2663 のコメントが spec。
