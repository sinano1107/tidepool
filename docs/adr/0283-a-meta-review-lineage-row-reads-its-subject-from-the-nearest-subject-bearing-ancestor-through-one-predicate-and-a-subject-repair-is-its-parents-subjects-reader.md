# meta-review の系譜の行の主題は1本の述語(自身の列、無ければ最も近い主題つきの祖先)で読み、主題の修理子は親の主題の読み手である

2026-10-20 の grilling(issue #2339 —— #2317 / #2314 / #2333 の族の根)で決定。meta-review の子(主題の修理子 `memory_repair` /
`routing_repair`、RCA、その子孫)は自分の列に `meta_review_subject` を持たない。ADR 0279 決定6 だけが行の主題を「自身の列、無ければ
最も近い主題つきの祖先」で読み、同じ問いを立てる他の3箇所 —— 行から学んだ記憶の置き場(決定1)、異議の束ねの門(決定3)、spawn 注入と
読み口(決定2)—— は自身の列で止まり、子の行が既定 workspace の普通の worker の行として扱われていた: 教訓が既定 workspace に落ち、
修理子・RCA の判断の行に保護ブランチから fork する work の修理子が立ち、修理子が既定 workspace の worker INDEX を受ける。実測と
`file:line` は #2339 / #2317 / #2314 のコメントに置く。

## 決定

1. **行の主題を読む述語は1本** —— task 自身の列、無ければ最も近い主題つきの祖先の列(ADR 0279 決定6 の読み)。「この行はどの主題に
   載るか / この task は誰の読み手か」を問う箇所はすべてこれで読む: 行から学んだ記憶の置き場(Board call の起草と RCA の
   `propose_from_objection`、ADR 0279 決定1)、異議の束ねの門(決定3)、spawn 注入の分岐(決定2)、Precedent の絞り(決定6)。
   「この task は meta-review か」を問う箇所(主題 verb の登録と門、完了 verb、材料の節と窓)は自身の列のまま —— 問いが違う。
   根拠は ADR 0279 決定1 の「meta-review は workspace を持たない仕事」が、workspace を親から継ぐ子(ADR 0272 決定6)にそのまま当たること。
2. **meta-review の系譜の判断の行への異議は work の修理子を立てない。** 主題の修理子・RCA とその子孫の、対象を名指さない行(自由文・
   完了の行)と RCA の型つきの所見の行が対象で、帰責・RCA・起草は今どおり立つ。記憶の書き込みの行は今どおり親を問わず `memory_repair`。
   ADR 0279 帰結の「RCA の型つきの行は範囲外 —— ブランチを持ち、work の修理子が意味を持つ」は work の祖先を持つ RCA に限る ——
   meta-review の下の RCA はブランチを持たず、そこに立つ work は保護ブランチから fork する(ADR 0272 が退けた「review の下で lineage が
   review を飛ばして保護ブランチ基点になる」形)。
3. **主題の修理子は親の主題の読み手。** spawn 注入は meta-review と同じ指針の節(盤面全体の、走る agent 宛てか全員宛ての approved な
   Behavior / Exemplar を行で —— ADR 0279 決定2、読んだら `read`)、読み口は meta-review の読み口(`read_memory_entries` を書き込みの行の
   修理子にも登録する。判断の行の修理子は既に持つ)。worker の pull verb(`browse_memory` / `search_memory` / `read_memory`)は主題つきの
   系譜の修理子には登録しない。`routing_repair` の節も空から指針の節になる。祖先に meta-review の無い `memory_repair` は今どおり task の
   workspace の worker INDEX と pull verb。

## 退けた案

- **揃えない箇所を残す** —— 残す理由が無い。
- **RCA の行を門の例外にして帰結の除外を守る** —— 述語を1本にした直後に例外を足し、直すブランチの無い work を意図として残す。
- **注入の分岐だけ行の主題で読み、worker INDEX と pull verb を scope null で組む** —— `memoryScope` に worker でも meta-review でもない
  第3の形の道を足し、盤面全体に置いた教訓は関連度の検索に当たらなければ行に出ない(指針の節は全件を行で出す)。
- **既定 workspace の worker の形のまま** —— 既定 workspace の記憶が混ざり、どの workspace が既定かで視界が変わる。ADR 0272 決定3
  「work の面から外す」は worker の系譜を見て決めた文で、主題つきの系譜の修理子が worker の pull verb を持つのは写しであって決定ではない。

## 帰結

- 追記する ADR: 0279 決定1・2・3・帰結、0272 決定3、0122 決定2。Codex の `enabledTools` の宣言(MCP の登録と集合で一致する)は同じ差を写す。
- pickup は workspace の空の列に既定名を焼く(review は実測、修理子型は読んだだけ)が、主題つきの系譜では置き場も読み口もその列を読まなくなる。
- #2317 / #2314 / #2333 は #2339 の spec 1本で着地する。
