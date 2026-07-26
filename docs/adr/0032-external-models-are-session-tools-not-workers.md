# 外部モデルはセッション内の道具であり worker ではない

外部モデル(OpenRouter 経由の安価・多系統モデル)を盤面に取り込むにあたり、registry に agent として定義し assignee にする案(worker 化)と、worker session 内の MCP ツールとして使う案を比較し、道具側を選んだ(2026-07-27 の grilling)。OpenRouter MCP の呼び出しはテキストイン・テキストアウトの白紙呼び出しであり(公式ツール一覧にファイル操作・実行系は存在しない — 実物のドキュメントで確認済み)、Worker の義務 — workspace への着地、branch discipline、slot-release tree rule、decision log、escalation の安全弁、handoff doc — のどれも果たせない。義務を免除した「二級 Worker」を作れば Worker の語が2つの意味を持ち始める。外注は ADR 0010 の線の「労力の分割」であり、説明責任は発注した worker に全部残る。

## Considered Options

worker 化: OpenRouter API を直接叩く新しい worker runtime(claude-worker の兄弟)を実装し、slot・watchdog・branch discipline を通す案。外注先は escalation できず(question を登録できない)安全弁を欠き、Worker の義務のほぼ全てを免除する必要があるため棄却。将来外部モデルをハーネス(Claude Code 相当)ごと動かす選択肢が生まれれば、その時は普通の worker 化として再検討できる — 本 ADR が禁じるのは「テキスト呼び出しの worker 扱い」であって外部モデル自体ではない。

## Consequences

- 外注能力の門は agent opt-in(registry の frontmatter フィールド、Advisor と同型)∧ workspace の外部送信可(external-send、既定禁止・fail-closed)の AND。成立するセッションにだけ盤面が MCP 設定を注入する — 権限は instructions への信頼ではなく道具の有無で構造的に強制される
- プライバシーは二層: 「送信の可否」は盤面(workspace マーカー)が持ち、「送信後の扱い」(保持・学習利用)は OpenRouter アカウント設定(no-training / ZDR 縛り)が持つ。後者を盤面に取り込むことはできない — 呼び出された時点で内容は先方に渡っており、盤面が制御できるのは送信の手前だけ
- 名義は盤面保有の単一キー(ADR 0024 の「単一名義」と同型)だが、GitHub と異なり worker session がキーを保持する — 呼ぶのは worker 自身であるため。キーは専用・クレジット上限付きで、漏洩・暴走の損害は上限までで構造的に閉じる。7日失効キーは無人運用では安全層ではなく週次の故障源になるため使わない
- 面接の順位表・外注の従量費は v1 では盤面の第一級データにならない(面接はセッション内で完結し、費用はセッション内で `get-credits` / `get-generation` により自己検分できる — 盤面に残るのは decision log の散文のみ)。永続化・観測は痛みが観測されてから足す
- 指示書(面接手順・検収規則・運用知見)は skill として配布し、registry の agent 定義とは独立に改善する — Condensation の対象になり得る
