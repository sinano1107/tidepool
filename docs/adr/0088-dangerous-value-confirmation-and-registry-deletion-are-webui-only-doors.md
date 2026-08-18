# 危険な値の確認と registry リソースの削除は WebUI 専用の扉

issue #267(出自: #229 のグリリング)を issue #205 のグリリング(2026-08-18)で決着。管理MCP は人間の
義手(ADR 0032)だが、worker の handoff / objection / タスク本文は**人間の目を経由しないまま人間の対話
エージェントが読む素材**であり、そこに仕込まれた指示がエージェント自身の `confirm_dangerous: true` として
人間名義の registry 変更に着地しうる。歯止めは prose(`MANAGEMENT_MCP_INSTRUCTIONS`)だけで、prose は
床ではない。

## 決定

**非対称にする。** 管理MCP は非危険な registry 編集(作成・編集のうち危険な値を含まないもの)を持ち続け、
**危険な値の確認**(CONTEXT.md「危険な値」の理由コードすべて)と **registry リソースの削除**(ADR 0087)は
WebUI 専用の扉とする。MCP の `create_*` / `update_*` は `confirm_dangerous` 引数を持たず、危険な値を含む
ペイロードはドメインの門(ADR 0061 決定1 / ADR 0086 の `*ConfirmationRequiredError`)がそのまま拒み、
tool error が「WebUI の設定画面で確認して保存せよ」と案内する。削除の verb は MCP に置かない。

新しい機構は要らない —— 判定 `dangerousValues` はドメイン側に一元化済み(ADR 0061)で、MCP 側が確認を
受け取れなくなるだけで門が閉まる。CONTEXT.md の 管理MCP の WebUI 専用リストに2つを足す。

## 残余(2026-08-18 の再グリリングで受容)

これはツール面の門であって credential の床ではない。token は MCP の仕組みとしては LLM に渡らない —— ヘッダの
注入はクライアント(Claude Code)の外部機構で、LLM が受け取るのはツール構成だけである。残るのは、対話エージェントが
**自分の Bash / Read でクライアント設定(`~/.claude.json`、または環境変数)を読み**、人間面の credential を抜いて
`/api` を手組みで叩く経路であり、これは ADR 0036 が既に名指しした「クライアント側の平文複製は読み取り床に依存する」
そのものである。危険な値に固有ではなく `/api` の全動詞(question 回答・cancel・registry 編集・削除)に等しく
開いているので、危険な値だけを第2の秘密(人間が毎回タイプする確認用 PIN)で守っても線は閉じない —— 引くなら
「不可逆な操作すべてに人間の手でしか出せない秘密を」であり、注入の観測ゼロの今日には大きすぎる。したがって受容し、
prose の抑止(「token を読むな」)も足さない(prose は床ではない、を根拠に扉を動かした直後に prose を足さない)。
再検討のトリガーは、対話エージェントが credential を読んで `/api` を叩いた事例が観測されたとき、または worker と
対話エージェントを同じホストに同居させるとき(#151)。

## Considered options

- **現状維持(prose のみ)** —— 経路が塞がらない。フィールド単位で外す案は ADR 0061 が却下済み(`merge:
  auto_if_ci_green` が同じ扉から立つ)。
- **registry 管理を丸ごと WebUI 専用に** —— guidance の1文字修正まで WebUI に追いやり、#266 の確認摩耗と
  同じ摩擦を別の形で作る。危険な値と削除だけが不可逆に近い影響を持つので、線はそこに引く。
