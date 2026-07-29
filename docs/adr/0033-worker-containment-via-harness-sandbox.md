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
- skill 再許可の唯一の例外は `skills: ["*"]` の agent — 拒否される skill が存在しないので、この場合だけ skill ルート(workspace / user / plugin キャッシュ)をまとめて開く。allowlist が無いところに迂回路は作れない
- review: `allowWrite: []`。issue #59 の `--disallowedTools` パターン列挙は早期に明示的に断る UX として残る
- work: `allowWrite: [workspace.path]`
- 共通: `failIfUnavailable: true`(サンドボックスが**起動できなかった**ときの fail-open ハッチ。`allowUnsandboxedCommands` とは別経路 — 前者は「サンドボックス内で失敗したコマンドの裸での再実行」、これは「サンドボックスがそもそも立たなかったセッション」。ベンダー既定は false = 警告して裸で走る)

**追記(#60 実装時、実機で測り直した結果)。この決定が実際に届けるのは読みの床であり、review の書き込み床は OS には降りない。**

読み側は設計どおり成立する。CLI 実挙動(macOS 2.1.220 / Pi 2.1.207)で `allowRead` は `denyRead` に**勝つ**ので、「`~/` を deny、workspace と許可 skill を再許可」がそのまま床になる。

書き側は2つの測定で形が変わった。(1) `allowWrite` は `denyWrite` に**勝たない** — `denyWrite: ["~/"]` + `allowWrite: [workspace.path]` は workspace すら書けなくなる。もっともサンドボックスの既定が既に cwd 外への書き込みを拒否する(`/tmp` も home 配下も拒否)ので、work にこの組は不要である。(2) review を read-only にするはずだった `denyWrite: [workspace.path]` は、**Linux(bwrap)backend では成立しない**。bwrap は CLI 自身の project 相対の保護パス(`.gitconfig`、`.git/config.lock` 等)のマウントポイントを project の中に作る必要があり、workspace が read-only だとそれができずサンドボックスが起動しない — セッションの全コマンドが `bwrap: Can't create file at <workspace>/.gitconfig: Read-only file system` で死ぬ(本番 Pi で確認)。backend のアーキテクチャであってバージョンの不具合ではない。

macOS だけ `denyWrite` を効かせる案は採らない — 上の「片方だけ裸だと dev/prod の挙動乖離が残る」の裏返しで、**本番が弱い側になる**形はさらに悪い。したがって review の書き込み床は ADR 0013 追記(issue #59)のツール層 deny + slot-release tree rule のまま —「書けないが覗ける、覗けば残る」— に留まる。ただし CLI 既定の project 保護は `.git/config`・`.git/hooks` 等を依然拒否するので、残る隙間は「作業ツリーのファイルを書き換えられる」に狭まっている。

**この隙間はその後 ADR 0035(issue #144)が permission 層(`--permission-mode manual`)で埋めた。同 ADR は本 ADR のサンドボックスにも影響する — `sandbox.enabled: true` は CLI の `autoAllowBashIfSandboxed`(既定 `true`)経由で permission 層を無効化するため、review プロファイルは `autoAllowBashIfSandboxed: false` を併せ持つ必要がある。**

ツールチェーンの動作基盤は封じる対象ではない(上記「守る資産の定義」)という線は、`allowRead` に `~/.gitconfig` と `~/.config/git` を置くことで具体化する — `denyRead: ["~/"]` だけでは `git` が `fatal: unable to access '~/.gitconfig': Operation not permitted` で一切動かない。credential ではなく config であり、worker は GitHub credential をそもそも持たない(ADR 0024)。`~/.npm` は書かない — CLI が自前でマスク済み home に bind するため(サンドボックス内の `ls -a $HOME` は `.claude`・`.gitconfig`・`.npm` を見せる)、名指しは露出を増やすだけで何も買わない。

床を workspace 側から広げられる経路が1つあり、盤面側のガードで塞いだ。CLI は per-task の `--settings` とは別に **workspace 自身の `.claude/settings.json` の `sandbox` ブロックも読んで merge する**(実測 2.1.220: `enabled: false` は `--settings` が勝つが、`filesystem.allowRead` はマージされて効く。`--setting-sources user` でも `--setting-sources ""` でも止まらない)。work セッションは自分の checkout に書けるので、放置すると「セッション N で床を広げ、N+1 で抜ける」2セッション経路になる — しかも slot-release の tree rule がその設定ファイルを親切にコミットしてしまう。したがって spawn 時に checkout の `.claude/settings.json` / `settings.local.json` を検査し、`sandbox` ブロックを持つ workspace は quarantine して spawn しない。これは床そのものではなく床の**ガード**であり、床は依然コード定数である(ADR 0013)。パースできない設定ファイルは fail-closed 側に倒す — CLI の reader がこちらの `JSON.parse` より寛容な可能性があり、「判定できなかった」が「問題なし」と読まれてはならない。

拒否の見え方は platform で異なる。macOS(Seatbelt)は `Operation not permitted`、Linux(bwrap)は denyRead を tmpfs の被せで実装するため `No such file or directory` になる。e2e スモークはどちらも「拒否」として扱う。

**fail-closed**: サンドボックスが成立しない環境(bubblewrap 不在、AppArmor 干渉等)では worker を裸で走らせない。起動時 + pickup 時の能力検査で不成立を検出したら agent タスクの pickup を停止し、Tidepool 名義の確認型 question を立てる(既存 quarantine と同じ検証つき解除 — 回答時に能力検査を再実行してから受理)。「CLI が設定を黙って無視する」将来リスクへは、デプロイ時の一度きり e2e スモーク(canary 読み取りが OS 拒否されることの確認)を充て、CLI 更新時に再実行する。macOS(開発機)と Pi(本番)の両方で常時有効 — 片方だけ裸だと dev/prod の挙動乖離がテストされないまま残る。

ネットワークはこの決定では触らない(現状のまま開放)。読める範囲が workspace + 許可 skill に閉じた時点で持ち出せる物はほぼ「もともとモデルに渡る内容」に一致し、ドメイン列挙の追従コストと正当タスクの失敗形が勝る。review プロファイルの Bash ネットワーク遮断(read-only + 書き込み不可の下でネットワークが要る正当な作業はほぼ無い)は将来の強化候補。**この段落の「現状のまま開放」という前提は bind に関して #146 の実測で覆った — 下の追記を参照。**

**追記(#146、2026-07-29 実測)。ベンダーのネットワーク既定は loopback への `listen` を拒否しており、「現状のまま開放」は bind に関して事実ではなかった。その下ではどちらのプロファイルの worker も in-process サーバーを立てるテストを1本も回せない。**

実測(macOS 2.1.220、本物の tidepool checkout に対する実 CLI + 実スイートの実行結果):

| 実行条件 | 結果 |
|---|---|
| review プロファイルの emit でフル `npm test` | 93 file failed / 59 passed。失敗 399 tests のうち **379 件(95%)が単一シグネチャ** `TypeError: Cannot read properties of null (reading 'port')` — `src/server.ts` の `app.listen(0, "127.0.0.1")` が拒否され `listener.address()` が null を返す |
| 同・単独ファイル実行 | `bootTidepool` を呼ぶファイルは単独でも 100% 再現 — 並列度・負荷は無関係 |
| **work** プロファイルで boot テスト1本 | 同一シグネチャで失敗。review 固有ではなく **worker 全体**(2プロファイルの settings 差は `allowWrite` と `autoAllowBashIfSandboxed` だけで、ネットワーク要素に差は無い) |
| review プロファイル + `network: { allowLocalBinding: true }`(1行追加、読み取り床は無変更) | **152 file / 858 tests 全 green** |

**原因は読み取り床ではない。** `denyRead: ["~/"]` も `allowRead` もこの失敗には無関係で、`allowRead` への追加は何も直さない。病巣はネットワーク既定であり、`sandbox.network.allowLocalBinding` はインストール済み CLI(2.1.220)に実在するキーで、意味論は上の実測で確認した。

したがって **両プロファイルに `network: { allowLocalBinding: true }` をコード定数で足す**(床はデータに依存しない — ADR 0013)。プロファイル差をつけない理由は ADR 0034 が既に書いている:「worker が自前のサーバーを loopback に立てて叩くのは正当な作業(npm test / webui-e2e が in-process でサーバーを起動する)」であり、これは review 固有の要件ではない。review にテスト実行を期待することは ADR 0035 の「read-only は行為の性質」の線を壊さない — 任意コード実行を許しても書き込み半径はサンドボックスが workspace 内に閉じ、残余は slot-release tree rule が回収する(ADR 0035「層の分担」)。

**測ったのは `listen` であって、宛先としての人間面ではない。** `allowLocalBinding` は「自分でポートを開けてよいか」の許可であり、「どこへ繋いでよいか」の許可ではない。したがって worker の Bash から人間面 `/api` に到達できるか — 言い換えれば**サンドボックス内の loopback がホストの loopback と同じ世界か** — は本追記では測っておらず、ADR 0034 が「実機実験で確定する変数」に挙げたフィルタ極性の分岐((ii) loopback 既定 deny + allowlist / (i) 狭い deny-list へのフォールバック)は**未確定のままである**。そこは #140 / ADR 0034 の領分で、「bind は許すが人間ポート宛は塞ぐ」は両立しうる形として残る。

ここで「macOS には netns が無いのだから sandbox 内 loopback = ホスト loopback だ」と推論してはならない — ADR 0034 の「netns は macOS に存在せず」は *OS レイヤ*案(netns / pf / nftables)の却下理由であって、**ハーネス**のサンドボックスが loopback に何を与えるかは別の層の話である。本キーが macOS でも実在して効くこと自体が、ハーネス側に OS の netns とは独立した loopback 制御があることを示している。

CLI 更新でベンダー既定や本キーの意味論が静かに変わるのは検出しないと分からない(設定ファイルの検証失敗は `-p` 下で黙って無視される)。したがって deploy-pi のサンドボックス e2e スモークの **work プロファイル側に bind canary を1本足す** — `network` ブロックは2プロファイル共有なので、`denyRead`/`allowRead` と同じく「共有の床は 3a が測る」という既存の整理にそのまま乗る。

Considered options:

- **`@anthropic-ai/sandbox-runtime` でプロセス全体を包む** — OS 境界がツール種別を問わず全部にかかるが、行為者を区別できず `~/.claude/.credentials.json` を AI に開く。macOS 側は Apple 非推奨の sandbox-exec 依存。
- **permission ルールだけで読みを封じる** — deny-wins のため「`~/` を deny、workspace を allow」が表現できない(実験2)。表現できてもヒューリスティック層のまま。
- **ホスト skill ルート全体を `allowRead`**(当初案)— 実装は最も単純だが、拒否された skill の本文が読める穴を許す。許可 skill だけの列挙は常にこれ以下の露出で、追加コストは spawn 時の写像だけ。
- **fail-open(サンドボックス不成立でも走らせる)** — 「サンドボックスされているつもりで裸」は機構不在より悪い(誤った安心)。参考: Codex CLI も強制不能時はコマンド拒否に倒す。
- **(参考)他ハーネスの水準** — Codex CLI の OS サンドボックスは書き込みとネットワークのみで読み取りは全ディスク可。Hermes Agent はプロセス単位サンドボックスを持たずコンテナ backend で代替。読みのパス粒度封じ込めは Claude Code 内蔵機構だけが提供する。
