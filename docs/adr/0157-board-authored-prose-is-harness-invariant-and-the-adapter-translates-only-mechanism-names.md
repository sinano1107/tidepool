# 盤面が書いた文面の中身は Harness 不変で、adapter が翻訳するのは実在する機構の名前だけである

2026-09-26 の grilling(issue #695)で決定。ADR 0124 は盤面が書いた文面の**層**を Harness ごとに揃えたが、**中身**は
揃っていなかった —— Codex worker には Board doctrine・Rules of the road の大半・network egress の行・Roster・当時版の
agent 定義・review task の authority 差し替えが届かず、空の guidance でも `## Authority` 見出しが立ち、Memory 注入節の
位置も Claude と逆だった。どの差にも決定の記録は無く(#695 の調査)、review の authority と空見出しは worker に嘘を
言い、network の行は #763 で sandbox が実際に強制する制約を伏せていた。現状の実装調査と `file:line` は #695 のコメントに置く。

## 決定

1. **盤面が書いた文面の中身は Harness を問わず同じである。** Board doctrine、Rules of the road、network egress、Roster、
   当時版定義、task type による authority 差し替え(ADR 0056)、空 guidance での見出し省略(#488)、Memory 注入節 ——
   Claude 経路が持つものはすべて Codex 経路にも届く。節の順序も同一(定義本文 → authority → roster → doctrine →
   protocol → 当時版 → Memory)。Codex の Memory 節が先頭にあったのは spec #586 C の「taskPrompt の先頭」を
   ADR 0124 で層を移したときに引き継いだ位置で、決定ではない。
2. **adapter が翻訳するのは、その Harness に実在する機構の名前だけである**(ADR 0005 の線)。Claude の「the Agent tool」は
   Codex では「a subagent」。**存在しない機構への禁止文は落とす** —— Codex に Workflow tool に当たる機構は無いので、
   Workflow 禁止の段落は Codex には出ない。一般化した文(「オーケストレーション機能」)も置かない —— 指す機構が無い文は
   worker に読めず、線は decompose の段落(独立した完了基準・別 authority・固有 risk・セッション跨ぎの生存)が既に引いている。
3. **文面の正本は adapter の外に1つ置き、ベンダー語彙をスロットにする。** `PREMISE_BREACH_PROTOCOL`(ADR 0121)と同じ
   形で、スロットは「委譲先の語」と「Workflow 段落の有無」の2つだけ。ADR 0134 決定4 の `fork_turns: "none"` の1文は
   Codex 固有の追記として doctrine 最終段落に続く。「main-thread only」の文は共通部に残る(Claude の canary の文言が
   これと一緒に動く)。
4. **揃える前の観測を選り分ける欄は作らない**(ADR 0124 決定5 と同じ)。

## 退けた案

- **3・6・7(network・review authority・空見出し)だけ直し、1・2・4・5 は痛みの観測を待つ** —— 差は引き継ぎの結果であって
  決定の結果ではなく、ADR 0124 が同じ非対称に対して退けた線。門(hook)は「盤面 verb を呼ばせない」までしか守れず、
  subagent に説明責任ごと投げる密輸は文面でしか止まらない(ADR 0134)。
- **Codex adapter に翻訳済みの別文面を持つ** —— 各 adapter は閉じるが、文言の正本が2つになる。ADR 0017 が消した drift そのもの。
- **Workflow 段落を subagent の再帰禁止に置き換える** —— ADR 0134 決定3 が孫を盤面の宣言する上限で開けた決定と衝突する。
