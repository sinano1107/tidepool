# worker の封じ込めはハーネス内蔵サンドボックスで行う: 拘束されるのは AI の手であってハーネスではない

issue #60 のグリリング(2026-07-28)で決定。ADR 0013 追記が post-v1 に送った「OS サンドボックスによる完全封じ込め」の実装方式。

**守る資産の定義**: AI のツール実行の視界と書き込みを workspace に閉じること。ハーネス(claude CLI 自身)や AI が正当に起動したツールチェーン(npm 等)の動作基盤(セッション記録・キャッシュ)は封じる対象ではない。work セッションの既存統治(branch discipline・slot-release tree rule・stream-json 監査)が守るのは workspace リポジトリという狭い資産と事後検出だけで、ホストに対して worker はユーザーアカウントの全権限で走っていた — 対象は review だけでなく**全 worker セッション**とし、プロファイルを2種持つ(review = 読みのみ、work = 読み + workspace 内書き)。

方式は **Claude Code 内蔵の sandboxed Bash**(macOS Seatbelt / Linux bubblewrap + socat)+ 既存の headless permission 層の複合とする。外側から `claude` プロセスごと OS サンドボックスで包む案(`@anthropic-ai/sandbox-runtime`)は行為者を区別できない — ハーネスが動くために `~/.claude`(credential 含む)を許可する必要があり、その許可が AI にも開く。内蔵サンドボックスはハーネス非拘束・AI の Bash だけ拘束という、守る資産の定義そのものの形をしている。

実機実験(2026-07-28、CLI v2.1.220)で確定した事実が設計を規定する:

1. headless auto モードは **cwd 外の読み取りを permission 層で既に塞いでいる**(Read ツールも Bash の `cat` も)。ただしコマンド解析ベースのヒューリスティックで、難読化で抜けうる。サンドボックスの価値は「開いた穴を閉じる」ではなく「ソフトな壁を OS の `Operation not permitted` に格上げする」こと
2. permission ルールの **deny は allow に常勝**し、workspace は `~/` 配下にあるため `Read(~/**)` の deny は workspace 自身を壊す — permission 層の deny は使わない。Read ツールは既存の cwd 封じ込めに任せ、OS 硬化は Bash sandbox が担う役割分担
3. skill 本文の注入はハーネスの仕事でサンドボックスの影響を受けない。skill の補助ファイルは Bash 経由の読みだけが生きており(Read は現状でも cwd 外不可)、`allowRead` の再許可は OS レベルで機能する

プロファイルの形(コード定数 — ADR 0013 の「床はデータの状態に依存しない」を維持):

- 共通: `denyRead: ["~/"]`、`allowRead: [workspace.path, 許可された skill のディレクトリ…]`、`allowUnsandboxedCommands: false`(サンドボックス内で失敗したコマンドを裸で自動再実行するベンダー既定の fail-open ハッチを閉じる)
- skill の再許可は**ホスト skill ルート全体ではなく、agent の skill allowlist に載る skill のディレクトリだけ**を spawn 時に組む。ルート全体を開くと、allowlist で拒否された skill の本文が `cat` で読めて手動でなぞれる — 「許可リストは入口を開けておくかどうかを決める」(issue #132)の意味論を Bash が迂回する。allowlist が運ぶのは skill 名でありパスではない — 名前 → パスの写像・サニタイズ・「skill ルート配下限定」の不変条件はコード側が持ち、registry をどう書いても到達面は skill ルートの外に出られない
- review: `allowWrite: []`(セッション一時領域のみ)。issue #59 の `--disallowedTools` パターン列挙は早期に明示的に断る UX として残し、列挙漏れ(`dd`、リダイレクト等)の最後の砦が OS になる
- work: `allowWrite: [workspace.path]`(+一時領域)

**fail-closed**: サンドボックスが成立しない環境(bubblewrap 不在、AppArmor 干渉等)では worker を裸で走らせない。起動時 + pickup 時の能力検査で不成立を検出したら agent タスクの pickup を停止し、Tidepool 名義の確認型 question を立てる(既存 quarantine と同じ検証つき解除 — 回答時に能力検査を再実行してから受理)。「CLI が設定を黙って無視する」将来リスクへは、デプロイ時の一度きり e2e スモーク(canary 読み取りが OS 拒否されることの確認)を充て、CLI 更新時に再実行する。macOS(開発機)と Pi(本番)の両方で常時有効 — 片方だけ裸だと dev/prod の挙動乖離がテストされないまま残る。

ネットワークはこの決定では触らない(現状のまま開放)。読める範囲が workspace + 許可 skill に閉じた時点で持ち出せる物はほぼ「もともとモデルに渡る内容」に一致し、ドメイン列挙の追従コストと正当タスクの失敗形が勝る。review プロファイルの Bash ネットワーク遮断(read-only + 書き込み不可の下でネットワークが要る正当な作業はほぼ無い)は将来の強化候補。

Considered options:

- **`@anthropic-ai/sandbox-runtime` でプロセス全体を包む** — OS 境界がツール種別を問わず全部にかかるが、行為者を区別できず `~/.claude/.credentials.json` を AI に開く。macOS 側は Apple 非推奨の sandbox-exec 依存。
- **permission ルールだけで読みを封じる** — deny-wins のため「`~/` を deny、workspace を allow」が表現できない(実験2)。表現できてもヒューリスティック層のまま。
- **ホスト skill ルート全体を `allowRead`**(当初案)— 実装は最も単純だが、拒否された skill の本文が読める穴を許す。許可 skill だけの列挙は常にこれ以下の露出で、追加コストは spawn 時の写像だけ。
- **fail-open(サンドボックス不成立でも走らせる)** — 「サンドボックスされているつもりで裸」は機構不在より悪い(誤った安心)。参考: Codex CLI も強制不能時はコマンド拒否に倒す。
- **(参考)他ハーネスの水準** — Codex CLI の OS サンドボックスは書き込みとネットワークのみで読み取りは全ディスク可。Hermes Agent はプロセス単位サンドボックスを持たずコンテナ backend で代替。読みのパス粒度封じ込めは Claude Code 内蔵機構だけが提供する。
