# workspace エントリはホスト非依存 — path は規約導出が既定

`workspaces.yaml` はコミットされる共有ファイル(Mac の開発クローンと Pi の本番クローン)なのに、`path` はホスト固有の絶対パスで、「各クローンで手調整する」が従来の運用だった(基点自体が違う: Mac は `~/tidepool-workspaces`、Pi は `/mnt/ssd/tidepool-workspaces`)。workspace 作成機能(issue #57)で盤面自身が registry にコミットを積み始めると、この運用は破綻する — 機械がどちらかのホストの絶対パスをコミットするたび、必ずもう一方のクローンを壊す。

決定: **`path` を省略可能にし、省略時は盤面設定(基点ディレクトリの環境変数 `TIDEPOOL_WORKSPACES_DIR`)+ workspace 名から解決の瞬間に導出する。** 盤面が作るエントリ(clone / 新規作成モード)は path を書かない — エントリはホスト非依存になり、Pi からの push が Mac のクローンを壊さない。明示 `path` は手動配置のチェックアウト(registry 自身、既存パス登録モード)のために残る。導出は ADR 0009 の解決点(`resolveExecutionWorkspace`)で行う — 「使用の瞬間に解決し、値を焼き込まない」という既存の線の延長。

Considered options:

- **絶対パスをコミットし続ける** — 人間だけが書いていた時代の「各クローンで手調整」を機械の自動コミットと同居させることになり、恒常的なコンフリクトを生む。
- **ホストごとの override ファイル(gitignore された local yaml)** — 導出で足りるものに新しいファイル種別とマージ規則を持ち込む。基点1つの環境変数のほうが小さい。
