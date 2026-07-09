# Tidepool — ubiquitous language

このファイルは用語集であり、仕様書ではない。実装詳細は書かない。背景の全体像は context-vault の `projects/tidepool` を参照。

## Task(タスク)

ボード上の作業単位。すべての作業・質問・レビューはタスクである(「Everything is a task」)。

- **type**: `work` / `question` / `review` のいずれか。
- **parent/child(親子関係)**: 子タスクは親タスクの作業の結果としてのみ生まれる(decompose、escalation)。
- **blocked**: 「未完了(`done`/`cancelled` 以外)の子を持つ」状態。親子関係から機械的に導出される。独立した blocking エッジは存在しない。

## Status(ステータス)

`todo` / `in_progress` / `blocked` / `done` / `cancelled` の5つ。`skipped` はステータスではなく `todo` 上の表示用モディファイア(キュービューのみ)。`held` もステータスではなく導出される表示状態(Held 参照)。

## Cancel(キャンセル)

人間の判断による作業の放棄。完了基準を満たさないまま終端し、記録は消さない。blocked の導出上は done と同じ完了扱い(cancelled の子は親を塞がない)— これが放棄後に親が再計画へ復帰できる根拠。v1 で cancel に至る唯一の経路は failure question への「abandon」回答であり、失敗タスクのサブツリーと計画の残り(親の未完了子孫、巻き込まれた未回答 question を含む)が一括で cancel され、親が先頭復帰して再計画する(計画ごと破棄 — 子は1つの判断に基づくため、1子の放棄は計画全体を無効にする)。

## Held(保留)

祖先に未回答の question がある間、その配下のタスクが slot に入らない導出状態(保存されない)。blocked が下(未完了の子)から塞ぐのに対し、held は上(人間の判断待ち)から凍結する。question 自身は held の影響を受けない — 人間タスクとして slot の外で回答可能。一般の question は自分の親のサブツリーを、cancel を持ち得る failure question は失敗タスクの親のサブツリー(兄弟含む)を held にする。

## Risk flag(リスクフラグ)

タスクが外部への影響(不可逆な効果)を持つことを登録時に宣言する真偽値マーカー。親の risk を超える子(親=なし、子=あり)の登録はそれ自体が決裁権外でありエスカレーションになる。承認されると親の risk も「あり」へ引き上げられる(上方伝播)。注意配分では機械観測された事実が主入力であり、宣言された risk は副次入力にとどまる(誤分類によって監査から逃れることはできない)。

## Review(レビュー)

read-only の判定行為。レビュアーは決して直さない — 発見は修理タスクになり、改善提案は具体的な diff(instruction / authority profile / テンプレートの変更)として人間への承認 question に登録される(散文の反省文は禁止)。トリガーは3層あるが、どの層も同じ review タスク type である:

1. **完了時レビュー** — review flag で opt-in されたタスクの完了時に自動生成。対象はそのタスクの成果物
2. **fix-forward レビュー** — 異議による修理の際の根本原因分析
3. **Meta-review(メタレビュー)** — ログ全体を対象に、繰り返される escalation(→ 権限を広げ委譲)や fix-forward(→ 権限を狭める)のパターンを蒸留する。Condensation ループの担い手。v1 では自動走査はなく、手動登録されたタスクとして始まる — scratchpad の meta-review 振り分けはその入口

## Review flag(レビューフラグ)

完了時レビュー(layer 1)へのタスク単位の opt-in。必須ではない。子のレビューは既定で親に委譲される(分解された作業の品質は統合点で判断するのが最良)が、親の完了前に外部影響を持つ子 — risk flag で識別される — は個別にレビューされる。

## Escalation(エスカレーション)

決裁権(decision authority)の外にある判断を上位者に委ねること。実体は question タスクの登録であり、親タスクが `blocked` になる。上方向のエスカレーションは決して制限されない(安全弁)。決裁権外の操作要求は、拒否されるのではなくエスカレーション(承認 question)へ変換される。

## Decompose(分解)

残りの作業を子タスク群に分ける1つの判断。分解の理由は decision log のエントリとして残り、生まれた全子タスクがそのエントリに基づく。親は全子が完了するまで blocked となり、その後復帰して統合を行い、完了基準の全体が満たされたことを確認してから完了する(統合復帰)。未完了の子を持つタスクは完了できない — 完了基準はツリー全体を覆う。

- _Avoid_: register_child_task(初期の呼称)

## Decision log(判断ログ)

権限内判断の1行記録と完了報告が時系列に流れる、人間向けの流し読みビュー。独立したエンティティではなくイベント履歴への絞り込みであり、未読カーソル(前進のみ)を持つ。完了エントリ(完了基準に対する結果1行 + ハンドオフドキュメントへの参照)は通常の判断行と視覚的に区別されて流れる。

## Triage session(トリアージセッション)

朝の操舵の入口となる一本道フロー(質問 → ログ流し読み → キュー確認)の1回分。セッション中はタスク pickup が停止し、回答・異議・scratchpad は即時永続化されるが、キューへの効果(unblock された親の先頭挿入 = **front-insert**)はセッションにステージされ、コミットで一括適用される。コミットは即時ポーリングを発火する。放置はタイムアウトで自動コミットされる(放置がシステムを止め続けない)。

## Objection(異議)

ログ流し読みにおける唯一の明示アクション。沈黙 = 承認であり、異議には方向コメント(steering)が必須。個々のログエントリへの注釈として即時永続化され、コミット時に「異議のあったタスクごとに1つの修理タスク(repair task)」へ束ねられる。

## Displayed(表示済み)

ログエントリが実際に人間の視界に入ったこと自体を記録するイベント。異議率の分母は表示済みエントリのみ — 未読は承認でも否認でもなく未観測。

## Scratchpad(スクラッチパッド)

全トリアージ画面で共有される書き捨て面。行は即時永続化され、コミット画面で meta-review / 通常タスク / 破棄に振り分けられる(disposition)。振り分けられなかった行は失われず、次のセッションが引き取る。meta-review 振り分けは review layer 3(meta-review)の手動登録入口であり、review タスク type を用いる — 独自の type ではない。

## Worker(ワーカー)

タスクの assignee になれる主体。人間とエージェントの総称。エージェント = ベース AI + skills + instructions + authority profile。人間は全権限を持つ worker。

## Slot(スロット)

システム全体で唯一の実行枠(concurrency = 1)。エージェント・インフラの概念であり、タスクモデルの概念ではない(人間タスクはスロットの外で並行する)。

## Slot-release tree rule

スロットが解放されるとき(完了・エスカレーション・watchdog 失敗のいずれでも)、作業ツリーを WIP コミットで退避しクリーンに戻すことが機械的に保証される、という規律。エージェントの善意には依存しない。WIP コミットはタスクブランチ(branch discipline 参照)以外には決して着地しない — セッションが自分のブランチを離れていた場合、規律はコミットを拒否し quarantine に落ちる。

## Watchdog(ウォッチドッグ)

タスク種別ごとの絶対時間リミットを持つプロセス内の監視機構(v1 に無活動検知はない — pickup からの経過時間のみを見る)。リミット超過で SIGTERM → 猶予 → SIGKILL の順にエージェントを回収し、slot-release tree rule を経て、tidepool 名義の failure question(retry / abandon の2択、推奨は retry)を生成する。retry は失敗タスクを先頭復帰させ、abandon は計画ごと破棄する(Cancel 参照)。自動リトライは存在しない — リトライ判断は常に人間の30秒の回答(throttle は実行中タスクに触れないため、この原則に例外はない — Throttle 参照)。サーバー再起動による中断も同じ経路に落ちる(ADR 0001: graceful drain は作らない)。

## Branch discipline(ブランチ規律)

workspace への書き込みは常にタスクブランチ(`task/<taskId>`)上で行われ、main への直接書き込みは全エージェントの権限外として構造的に禁止される、という規律。pickup 時に Tidepool がブランチを作成・checkout し(既存ブランチへの復帰は checkout のみ)、slot-release tree rule と対になって main を保護する。

## Quarantine(隔離)

Slot-release tree rule 自体が失敗した(コンフリクトや破損など)ときの封じ込め。該当 workspace が needs-human とマークされ、その workspace を使うタスクの pickup が全停止し、修理を求める question タスクが生成される。エージェントの失敗ではなく盤面自身の判断であるため、question はエージェントではなく Tidepool 自身の名義で登録される。解除は現状ボードへの手動介入のみ(自動復帰は将来スライス)。

## Workspace(ワークスペース)

タスクが実行される場所を指す第一級エンティティ(名前 → Pi 上のパス)。子タスクは親の workspace を既定で継承する。needs-human(quarantine 参照)は workspace 単位の状態。

## Handoff doc(ハンドオフドキュメント)

work タスク完了時に必須の引き継ぎ文書。行動可能な情報はタスクになり、doc は文脈のみを運ぶ。question / review タスクには不要。

## Throttle(スロットル)

アカウント単位(エージェント単位ではない)の予防的な絞り。使用量(Usage limit = Anthropic 側のアカウント制約そのもの)を Tidepool 自身の閾値で監視し、session / week いずれかのウィンドウの使用率が閾値以上と観測されている間、新規タスクの pickup を skip する。この単一状態を **throttled** と呼ぶ(旧 rejected / allowed_warning の2状態は廃止)。

- 閾値判断は Tidepool 自前のもの — Anthropic 側の警告イベントには依存しない。閾値到達は「失敗」ではなく環境事象であり、エスカレーションや失敗統計を汚さない
- 実行中のタスクには決して触れない — throttled が観測されても走っているタスクは完走する
- リセット時刻を過ぎれば人間を介さず自動的に pickup が再開する。これはタスクのリトライではないため、Watchdog の「自動リトライは存在しない」原則の例外にはならない
- 使用率が観測不能な間も throttled として扱う(fail-closed — 守るのは不可逆な予算、失うのは回復可能なアイドル時間)
- throttled の間の todo タスクはキュービューでは `skipped` として現れる(ボードには出ない — Status 参照)

## Swell / Condensation

Swell = 外部からの周期的なタスク流入・処理サイクル。Condensation = ログが meta-review 層(= review layer 3)で蒸留され、具体的な diff(instruction / authority の変更)として戻ってくる内部自己調整ループ。
