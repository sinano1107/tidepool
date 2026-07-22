# チームとロールは保存されるエンティティではなく導出ビュー — レビュアーのルーティングはタスク単位の指名のみ

issue #84(workspace 配下のチーム/ロール設計)の grilling(2026-07-22)で決定。出発点は「自動生成される完了時レビュー子が常に盤面全体で1つの Auditor ポインタに解決される硬さ」で、最小案は workspace エントリへの役割ポインタ(`auditor:` 等)の追加だった。grilling の結論は、最小案を含む**すべての新しい保存構造を作らない**こと。

**チームの正体は assignable_to グラフの導出ビュー。** 「オーケストレーター(decompose を専門性とする普通の agent — ADR 0017 の線: 専門性が定義の差として現れる正当なケース)を根とする委譲部分木」がチームであり、下階層のオーケストレーターも配下の agent がそれぞれの assignable_to を持つことで自然に表現される。「誰が誰に振れるか」の正本は assignable_to のみで、team エンティティ・ロール語彙・割り振り型のいずれも registry のデータとして持たない — 持てば `assignable_to` / `allowed_workspaces` と意味が重複し、「誰がどこで何をできるか」を語る場所が2つになる(issue #84 論点4 の失敗モード)。割り振りの賢さ(専門性マッチ・負荷分散など)はオーケストレーターの判断(instructions の散文 + roster)が担い、構造が保証するのは運搬(指名フィールド)と関所(権限検査)だけ。委譲はすべて盤面経由なので、チームの実際の稼働は呼び出しグラフとして追加機構なしで監査できる。

**Workspace は場所でありチームではない。** チーム(委譲の木)は workspace(場所)と直交し、複数 workspace を跨いでよい。チームを持たない workspace も正当 — registry がその実例で、誰の本拠地でもなく、全チームの review から改善提案(registry-edit の decompose)が越境して届く共有の場所である。「チームごとに異なるレビュー要求」は auditor のプロンプトの条件分岐にはならない: repo 全員に当てはまる知識は CLAUDE.md、役割×場所の知識(この repo のレビュー手法)は workspace skill × agent の skill allowlist(ADR 0025)の交差、agent 本人の観点は agent 定義、と3層で吸収済み。

**レビュアーのルーティングは場所キーではなくタスクキー。** workspace 役割ポインタは、レビュー観点の違いのうち「タスクの性質に付く分」(同一 workspace 内のコード変更/文書/設計検討)を原理的に表現できず、棄却したメタファー(workspace = チーム)への逆戻りでもある。将来のルーティングの穴は **`review_by`**: review_flag への同乗としてレビュアーを指名でき(#62 の拡張)、乗り物の性質をそのまま相続する — 登録時宣言のみ・不変・**非伝播**(子のレビュー要否と宛先は、その子の性質を見た decompose 登録者が子ごとに宣言する)。指名は委譲として登録者の assignable_to で検査され、外なら承認 question に変換(既存の関所と同型)。フォールバックは2段のみ: タスク指名 → 盤面 Auditor。

**実装は2人目の reviewer 出現まで先送り。** レビュアー編成は事前設計の対象ではなく Condensation の出力である(原則6 Observed pain・Probation model): 単一 auditor で運用を始め、レビュー品質への異議・fix-forward の繰り返しを meta-review が「新 reviewer agent の定義」という registry diff として蒸留した日に、`review_by` を #62 の拡張として実装する。単一 auditor の間、指名には意味がないため今日作るものは何もない。

Considered options:

- **workspace エントリに役割ポインタ(`auditor:` / `default_agent:` — issue の最小案)** — ルーティングキーが場所になり、同一 workspace 内でタスクの性質が異なるケース(issue 論点1)を表現できない。チームは場所と直交すると決めた以上、キーの取り違え。
- **チーム/ロール語彙を registry のデータとして持つ** — 正本が増え、profile との食い違いという新しい不整合面を作る(論点4)。導出ビューなら WebUI が同じ絵を正本ゼロで描ける。
- **`runs_in`(assignee の場所制約)の導入** — 「特定の agent は特定の workspace でしか起動しない」要望は workspace = チームという解消済みメタファーの残滓だった。守るべき穴も実質ない(人間は全権、agent 発は assignable_to × allowed_workspaces の二重関所を既に通過し、残る誤配置は権限違反ではなく判断ミスで、roster の散文と異議 → meta-review の既存ループが統治する)。ハード制約にすると誰も registry を持たない編成で registry-edit タスクが実行不能になる副作用もある。誤配置の痛みが観測されたら profile 側に足す。
- **観点別 reviewer agent を最初から複数設計** — 原則6(Observed pain over speculation)違反。編成は Condensation の出力として育てる。
