# Codex preflight の permission 行は盤面を盤面と照合していたので消し、fs サンドボックスの問いは canary だけが答える

2026-09-21 の grilling(issue #728)で決定。Codex の containment preflight の mismatch 表には `permission` 行が残っていたが、その観測値は Codex CLI からではなく盤面の定数 `CODEX_PERMISSIONS` の写しで、期待値も同じ定数だった —— ADR 0125 決定1 が `MCP tool` 行について述べたのと同じ declared-vs-declared である。hook 行は #731 で `hooks/list` の実の登録に置き換わっており(ADR 0130 決定3)、表で観測の入っていない行はこれが最後だった。permission の面そのものは `work` / `review` 両 profile の sandbox canary が実行して測っており、失敗は throw から `could not run` に倒れるので fail-open ではない。恒真なのは表の行だけである。現状の `file:line` は issue #728 に置く。

## 決定

1. **`permission` 行は preflight の表から消し、観測値の `permissions` 欄も消す。** permission canary が答えるのは CONTEXT.md「Containment capability」の「その Harness を fs サンドボックスに入れられるか」で、表が答える「面が宣言どおりか」とは別の問いである。canary は宣言と観測を突き合わせない —— 盤面が書いた profile の下で実行して、通るか落ちるかの1ビットを返す。これを表の行の形にしても行の意味は変わらず、表に「観測されているように見えるもの」が1つ増えるだけである。
2. **canary の検査は throw のまま表の外に置く。** 不成立の理由文は今日 `could not run: … exited <code>` の形で exit code まで届く(#768 以降)。封じ込め破れ(32 / 33)も「実行できなかった」と読める文面になる点は、canary の理由文の問題として #710 に残し、この決定の範囲に入れない。

## Considered options

- **canary の結果を観測値として表へ通す(通った profile の一覧)** —— 破れと実行不能(timeout・spawn 失敗)を exit code で分けない限り、VM の負荷による timeout が `permission mismatch` を名乗る。分けたとしても観測は宣言の写しとの比較ではなく1ビットのままで、区別の価値は理由文の側(#710)にあって表の側には無い。
- **行を残し、fixture が表の形をしていられることを理由にする** —— test の都合で runtime の表に恒真の行を置く理由にはならない。
