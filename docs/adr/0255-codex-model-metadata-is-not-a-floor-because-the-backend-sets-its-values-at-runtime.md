# Codex の model metadata は床に数えない —— 値は版 pin でなく backend が実行時に決める

2026-10-14 の grilling(issue #760)で決定。ADR 0135 決定5 は「閉じた」の証拠を pin 単位の source 読みと受け入れの worker run
1本に置き、model の metadata が features に勝つ軸(ADR 0134、#762)も pin を上げるときの読み直しに預けた。前提は、metadata が
pin 同梱の `models.json` にあることだった。vendor source(`rust-v0.147.0`)を読むと、ChatGPT 認証(ADR 0098)の Codex は
backend の model 一覧を取得して同梱の一覧を置き換え、応答に新しい etag が載れば session の途中でも取り直す —— pin が固定するのは
**どの欄が読まれるか**だけで、**欄の値**は提供元が pin と無関係に動かす。同梱と remote の値はすでに食い違っている(operator 側の
cache の `shell_type`)。読みの `file:line`・欄ごとの分類・実測は #760 のコメントに置く。

## 決定

1. **metadata が届く軸では、feature の閉じを床に数えない。ADR 0135 決定5 を supersede する。** 値を提供元の server が決める以上、
   盤面から見て決定的な機構ではなく、床の定義(CONTEXT.md「床」)に入らない。feature は既定拒否の導出(ADR 0135 決定1〜4)の
   とおり閉じ続ける —— 閉じても害は無く、metadata が届かない軸ではそれが床である。
2. **metadata で開きうる面には、metadata に依らない床を要求する。** 床は hook の門・permission profile・サンドボックスのいずれか。
   subagent の軸で ADR 0134 が取った形の一般化である。
3. **版ごとの vendor source の読みは最悪値読みにする。** その版が読む metadata の欄をすべて数え上げ、各欄が取りうる最も開いた値で
   何が開くか、そこに決定2 の床が掛かるかを読む。今の値でなく取りうる値を読むので、提供元が値を変えても読みは古くならない。
   手順の置き場は #1940。
4. **検索経由の tool 公開(`supports_search_tool`)は受け入れる。** 盤面 verb を含む MCP tool が prompt に直接出ず、検索で見つけて
   呼ぶ形になるが、到達先は増えず、hook の門は公開の形に依らず実行経路で走る(source 読み)。形の観測は #701 に預ける。
5. **0.147.0 で床が未確認なのは `tool_mode`(code mode)の軸だけである。** code mode の中から呼ばれた盤面 verb と shell に門と
   permission profile が掛かるかは #762 が観測する。

## 退けた案

- **値を pin に戻す(vendor の `model_catalog_json` で同梱の写しを静的 catalog として渡す)** —— 同梱の値がすでに subagent v2 と
  `code_mode_only` なので、決定2 の床の要求は消えない。足すのは「将来黙って変わらない」ことだけで、最悪値読みの下では封じ込めを
  増やさない。代わりに提供元の metadata の修正が届かなくなり、catalog に無い model は fallback の metadata(`apply_patch` も無い)
  で走り、盤面が写しを保守する。
- **実効の metadata を preflight で照合する** —— session の途中の etag で preflight の後に値が変わるので、観測と runtime の間の窓が
  閉じない。封じ込めに無関係な欄の変更でも Codex が止まる。
