# workspace 名は使う瞬間に registry から解決し、path を pin しない

実行側の複数 workspace 対応(issue #26)で、`task.workspace`(null は盤面既定への参照)から path への解決を「使う瞬間に毎回 registry を読む」規約に統一した — pickup、slot release(releasing 動詞・watchdog・restart 中断処理)、quarantine 解除の検証、PR 配線(auto-merge poll 含む)、登録時のバリデーションのすべてで。pickup 時に解決した path をタスクに記録して以後それを使う、という pinning はしない。理由: worker(`ClaudeCodeWorker.start`)が既に per-pickup の registry 再読込で「registry 更新は次タスクから効く」という規約を持っており、盤面側もこれに揃えることで解決ルールが1つになる。slot = 1 なので実行中タスクは高々1つであり、実行中にその workspace の path を registry 上で書き換えるのは人間の意図的操作 — mid-task drift を機械で守るために pinning の複雑さ(restart 経路のための永続化を含む)を払う価値はない。

解決失敗(registry に存在しない名前)の扱いは2群に分かれる: 盤面が自律的に動く非同期経路(pickup・release・watchdog・restart・auto-merge poll)は fail-closed にその名前を quarantine 機構へ落とす(`needs_human` + Tidepool 名義の確認型 question — 解除検証は「registry に名前が存在し、かつツリーがクリーン」)。人間の同期リクエスト(question への回答、登録 API)は DomainError → 4xx で即返し、その場で直せるようにする。quarantine の契機が tree rule 失敗から「workspace が実行不能と判明したとき」一般へ広がったのはこの決定による(CONTEXT.md の Quarantine 参照)。

Considered options:

- **boot 時に全 workspace を解決してキャッシュ** — 実装最小だが、workspaces.yaml に workspace を追加しても再起動までタスクを流せず、worker 側の per-pickup 再読込と規約が割れる。
- **pickup 時に解決した path をタスクに pin し、release/watchdog は pin を使う** — 実行中の registry 編集にも一貫するが、restart 中断処理(boot 時の failTask)のために pin の永続化が必要になり、repo を移設した場合はむしろ古い path を掴み続ける。守りたい事故(mid-task drift)は slot = 1 と registry が人間管理であることから実質発生しない。
- **未知名を quarantine ではなくタスク単位の failure question(retry / abandon)にする** — retry しても registry が直っていなければ即再失敗し、同じ workspace の他タスクにも同じ question が乱立する。実行不能は workspace の性質でありタスクの性質ではないので、workspace 単位の封じ込め(1 workspace につき確認は最大1枚)が正しい粒度。
