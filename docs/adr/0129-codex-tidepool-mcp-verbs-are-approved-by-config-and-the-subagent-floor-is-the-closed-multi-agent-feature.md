# Codex の tidepool MCP verb は承認モード approve で開け、subagent の床は multi_agent を閉じることで置く

**Status 追記: 決定2 は [ADR 0134](0134-the-codex-subagent-floor-is-the-hook-gate-because-model-metadata-overrode-the-closed-feature.md) が supersede(2026-09-20)。** 床は hook の門に移り、`multi_agent` は `CLOSED_FEATURES` から外れた —— 決定2 の閉じは model の metadata に上書きされており、置いた日から効いていなかった(#730 の実測)。決定1・3・4 は不変。

2026-09-17 の grilling(issue #724)で決定。Codex route の worker は tidepool MCP の verb をすべて `user cancelled MCP tool call`
で落とし、task が `in_progress` のまま残っていた。根は Codex の MCP tool 承認(`AppToolApproval`、既定 `Auto`)で、annotations の
無い tool は承認要求に倒れ、`codex exec` には答える人が居ないので Cancel になる。`--ask-for-approval never` が MCP を自動承認する
のは permission profile が Disabled / External か Managed で全ディスク書込のときだけで、`:root deny` の盤面の profile では最初から
閉じていた。承認経路が参照する hook は `PermissionRequest` であって盤面の `PreToolUse` hook ではなく、hook は承認の前段で
走る別物である。さらに Codex の subagent 機能 `multi_agent` は 0.147.0 で Stable かつ既定 on で、盤面は閉じていない —— 承認が
通った瞬間、fail-open な PreToolUse の門(issue #725)だけが subagent からの board verb を止める形になる。実測の逐語と
`file:line`、vendor source の参照は #724 のコメントに置く。

## 決定

1. **`mcp_servers.tidepool.default_tools_approval_mode="approve"` を spawn 設定に足す。** 答える人の居ない exec で承認ゲートが
   取れる値は approve と Cancel の2つしかなく、Cancel が守っていたのは worker の完走そのものだった —— ゲートはここでは床だった
   ことが無い。面は `mcp_servers.tidepool` に閉じ、Codex 組み込みツールの承認は変えない。verb の権限は盤面側(authority profile /
   MCP router、呼び出し時の DomainError)が縛るので、CLI 側で開けても権限モデルは緩まない —— Claude 経路が `--allowedTools`
   でサーバ単位に無条件 allow している線(ADR 0035 / 0038)の写しであり、Claude より広くはならない。
2. **Codex route の「subagent から盤面 verb 禁止」の床は、`multi_agent` を `CLOSED_FEATURES` に足して subagent 機能そのものを
   閉じることで置く。** ADR 0098 決定7 はこの床を出荷条件にしており、PreToolUse hook は実環境で当たっておらず(#725)観測もされて
   いないのに対し、閉じた feature は封じ込め能力の preflight が `codex features list` で実物を観測する。hook と `probeHook` は
   この変更では触らず、その生死(証明された門の後ろで subagent を再び開けるか、hook ごと消すか)は #725 の主語に移す。
   ADR 0010 追記の「PreToolUse hook で拒否」は Claude 経路の記述として不変。
3. **線は観測した軸(tidepool server の tool 承認)に閉じる。** 理由 —— 答える人の居ない exec では Codex の承認の問いは Cancel に
   しかならない —— は一般の形で書くが、network / skill / `request_permissions` など他の承認軸へは主張を延ばさない(未観測)。
4. **この文字列が vendor の既定とどう噛むかは、モデル呼び出し無しには盤面から観測できない**、と記す。置く統制は `--strict-config`
   (未知キーで起動拒否 = parse の fail-closed)、`CODEX_CLI_VERSION` の pin(意味の固定)、spawn 引数 seam の宣言テスト(盤面
   自身の文字列の回帰止めで、観測とは呼ばない)、派生 issue での Lima VM 完走確認(ADR 0126)の4つ。承認モードは #701
   「Codex のツール面は盤面が観測していない」に未観測の宣言として並ぶ。`ToolAnnotations` は宣言しない —— `approve` の下では
   承認に効かず、今日それを読む consumer は無い。

## 退けた案

- **`Auto` のまま全 verb に `ToolAnnotations` を付ける** —— 結果が vendor の `Auto` ヒューリスティックに依存し、ADR 0127 / 0128
  と同じ形で割れる。
- **`writes`** —— `complete_task` は read-only でないので question に落ち、headless では死んでいる。
- **`PermissionRequest` hook を登録して main thread なら allow** —— `CODEX_HOOKS` に新イベントが増え、#725 と同じ
  「matcher が当たるか未観測」を持ち込む。
- **#724 を #725 に塞がせる / 単独で着地して窓を受け入れる** —— 前者は順序で守る合意であって機構でなく、後者は出荷条件の床を
  一時的に外す。feature を閉じれば機構で、かつ観測される。
