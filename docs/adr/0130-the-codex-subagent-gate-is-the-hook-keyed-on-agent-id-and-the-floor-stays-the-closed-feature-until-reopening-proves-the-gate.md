# Codex の subagent 門は hook が `agent_id` で持ち、床は閉じた feature が開け直しの受け入れで門を証明するまで残る

**Status 追記: 決定2 は [ADR 0134](0134-the-codex-subagent-floor-is-the-hook-gate-because-model-metadata-overrode-the-closed-feature.md) が supersede(2026-09-20)。** 床は決定1 の hook の門だけになり、閉じた feature は残らない。決定2 が #730 に預けた開け直しの受け入れ観測は、その grilling の中で取れている。決定1・3・4 は不変。

2026-09-17 の grilling(issue #725)で決定。issue は「PreToolUse の matcher `mcp__tidepool__.*` が実物に当たらず、subagent
からの盤面 verb を止める門が fail-open している」と観測を報告し、ADR 0129 決定2 はその観測を根拠に床を `multi_agent` を閉じる
ことへ移した。vendor source(`rust-v0.147.0`)を登録 → 選択 → stdin まで読み、Lima VM で盤面抜きの `codex exec`(spawn フラグは
実物と同一、stdio の MCP server)を走らせた結果、matcher は当たり、subagent の PreToolUse には必ず `agent_id` が載り、その
`turn_id` は `SubagentStart` のものと同一だった —— v1 / v2、0.147.0 / 0.154.0 のどれでも同じ形。issue の「0回」は再現せず、
交絡(`installBoardHook` は preflight と spawn の両方で hook を書き直すので、`CODEX_HOME` を共有する別 process が記録行の無い
template で上書きしうる)を疑う。実測の表と `file:line` は #725 のコメントに置く。前提: 人間は Codex route で subagent を
開け直す意図を持つ(Claude 経路と CONTEXT.md の Subagent の線に揃える)。

## 決定

1. **門は hook が持ち、subagent の識別は `agent_id` 1本に畳む。** `SubagentStart` の登録、`turn_id` を溜める state file、
   `TIDEPOOL_SUBAGENT_STATE` は消す。vendor は PreToolUse の stdin に `agent_id` を載せる契約を明文で持ち
   (`SubagentCommandInputFields`)、実測でも main thread は key ごと出ず subagent は必ず載った。state を書ける前提と
   「state が無い」の fail-closed 分岐は、識別子が1つで足りる以上、重複である。
2. **床は ADR 0129 決定2 のまま `multi_agent` を閉じて置き、開け直しは派生 issue #730 が持つ。** #730 は feature key
   (v1 / v2)と `agents.max_concurrent_threads_per_session` の値、CLI pin の更新順序を決め、Lima VM で subagent を1つ立てて
   盤面 verb が deny される受け入れ観測(ADR 0126 の形、`needs-info`)を持つ。門の選択(matcher が実物の呼び出しを選ぶこと)は
   model 呼び出し無しには観測できないので、その観測はここに住む。
3. **preflight の `hook` 行は `probeHook`(合成入力をスクリプトに流す自己検査)から、`codex app-server` の `hooks/list` に
   よる登録の観測に置き換える。** 見るのは event・matcher 文字列・enabled・source(session flags)。登録は観測できても選択は
   観測できない、という線を preflight の説明に残す。スクリプトの fail-closed は vitest の seam で足りる。
4. **`--dangerously-bypass-hook-trust` は spawn 引数 seam の宣言テストに載せる。** `hooks/list` は session flags 由来の hook を
   `untrusted` と返し、exec 側の hook はこの flag があって初めて走る。盤面自身の文字列の回帰止めであって観測ではない
   (ADR 0129 決定4 と同じ位置づけ)。

## 退けた案

- **hook 一式を消し、開け直すときに再導出する** —— 開け直す意図がある以上、門は今日証明できた形で残すほうが手戻りが無い。
- **`SubagentStart` を保険として残す** —— 同じ `turn_id` を二重に見るだけで、識別の独立性を足さない。
- **CI に real-model の e2e を足して選択を固定する** —— ChatGPT 認証を CI に持ち込む別問題。
- **v1 / v2 をこの ADR で決める** —— 門は両方で同じ形なので、選択は pin の更新と一緒に開け直しの issue で決める。
