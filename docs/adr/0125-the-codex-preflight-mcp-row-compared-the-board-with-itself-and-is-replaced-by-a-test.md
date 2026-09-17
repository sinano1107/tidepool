# Codex preflight の MCP 行は盤面を盤面と照合していたので消し、宣言と面の一致は test が固定する

2026-09-17 の grilling(issue #645)で決定。Codex の containment preflight の `MCP tool` 行は、観測値を Codex CLI からではなく
**盤面自身の MCP endpoint の `listTools()`** から取り、盤面の定数 `BOARD_VERBS` と `JSON.stringify` で照合していた。ADR 0098 /
0108 / 0124 が「declared-vs-observed の表」と呼ぶ表の中で、この行だけが declared-vs-declared である。#195 契約3項(Codex の
tool 面の exact-match)は実装されていない。Lima VM の実測(memory verb の追加で `src/mcp.ts` の登録順と `BOARD_VERBS` の並びが
ずれ、Codex route の worker が1つも起動しない)と現状の `file:line` は issue #645 のコメントに置く。

## 決定

1. **`MCP tool` 行は preflight から消す。** 封じ込め能力は「このホストで worker の封じ込めが成立しているか」を答える検査
   (CONTEXT.md)で、この行が捕まえるのは `src/mcp.ts` に verb を足して `BOARD_VERBS` を直し忘れた**コード対コードの不整合**
   である。task 無しの MCP 面は code から決定的に決まり、人間面の自己検査(ADR 0036)が runtime にある理由 —— 組み上がった
   配線は静的に分からない —— がここには無い。CI で捕まる不整合を VM 実測まで持ち越し、その間 Codex route が黙って止まる
   代償だけが残っていた。順序で縛るか集合で照合するか、欠落側だけ見るかという問い(ADR 0039 決定3 / ADR 0108 決定1 との
   関係)は、行が消えることで問い自体が消える。なお ADR 0039 決定3 が欠落側を外した理由(MCP 断が封じ込め不成立に化ける)は
   この行には元々当てはまらなかった —— 盤面の server が落ちていれば probe 自体が throw して `could not run` に倒れる。
2. **守る不変条件は「spawn が Codex に宣言する `enabled_tools` の集合 == 同じ task で盤面の server が出す verb の集合」で、
   MCP 境界 + spawn 引数の seam の test が固定する。** work task と memory meta-review task(ADR 0122 決定2 の差分)の両方で
   述べる。照合は集合 —— 片方は登録順、片方は盤面の並びで、どちらの順序も意味を持たない。`BOARD_VERBS` は test のために
   export しない(ADR 0107 決定5)。既存の「宣言が何か」を逐語で述べる test は別の振る舞いなので残す。
3. **Codex のツール面は今日、盤面が何も観測していない**、と記す。代償統制は `CODEX_CLI_VERSION` の pin と `enabled_tools` の
   宣言(#195 で「未列挙 verb を model surface に出さない」を実測)だけである。Claude 側が MCP 軸を過剰側だけ見る(ADR 0108)
   のに Codex 側に MCP 行が無いのはこのためで、Codex の tool 面を観測する行を足すかは観測(VM 実測)を待つ派生 issue に置く。

## 退けた案

- **runtime の行を残して集合照合に直す / test と両方置く** —— 行が測っているものは変わらず、backstop としての価値は CI が
  同じ不整合を先に捕まえる以上無い。
- **並べ替え1行で閉じる** —— 次に `src/mcp.ts` へ verb を足した人が同じ罠を踏む。#633 が `propose_from_objection` を
  `BOARD_VERBS` から外すと今回のずれは偶然消えるが、罠は残る。
- **期待値を登録から導く(#663 (b))** —— 決定2 の test が集合を固定すれば手打ちの罠は CI で閉じ、導出の動機は test の写し
  3本の削減だけになる。前提が変わった旨を #663 に戻し、ここでは決めない。
