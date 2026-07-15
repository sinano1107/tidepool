# workspace の branch は参照であり fork 事実ではない

workspace ごとの保護ブランチ設定(issue #27)で、`workspaces.yaml` エントリの `branch`(省略時 main)は3役を1フィールドで兼ねる — タスクブランチの fork 元、PR の base、直接書き込み禁止の保護対象。実行中に entry の branch が編集されると、fork 元と完了時の PR base が食い違い得る(main で fork したタスクの PR が develop base で開き、差分ノイズが乗る)。

決定: **branch も ADR 0009 の参照として扱い、使用の瞬間に毎回 registry から解決する。タスクブランチが実際にどこから切られたかという fork 事実は、記録もしないし PR base の根拠にもしない。** 理由は3つ: (1) 実行中に branch が変わる現実的なシナリオは既定ブランチの移行(master → main 類)であり、毎回解決は新ブランチへ正しく PR するが、fork 事実固定はもう存在しない旧ブランチへ PR を試みて失敗する。(2) 毎回解決の失敗モードは「差分ノイズの乗った PR が可視の状態で開く」であり、GitHub UI の base 付け替えで修復できる — 静かには壊れない。そしてどちらの案でも保護ブランチへの直接書き込み禁止(branch discipline / slot-release tree rule)は破れない。(3) 誤設定の行き来で fork 事実が勝つケースは registry 著者の運用事故であり、機構で守る対象ではない。

Considered options:

- **fork 事実を記録して PR base に使う** — git はブランチの fork 親を記録しないため事後観測は不可能(fork 時点で複数ブランチが同一コミットを指せば区別できない)。観測するなら `ensureTaskBranch` が fork する瞬間の記録しかなく、ADR 0020 型の「歴史的事実の観測」として正当化はできるが、盤面は再起動するので永続化(schema 変更)が要り、しかもブランチ移行シナリオで誤動作する。
- **pickup 時に task 行へ焼き込む** — ADR 0009 の「値を焼き込まない」原則に例外を作る。fork/base の一致は機械保証されるが、コストと引き換えに守れるのは運用事故ケースだけ。
