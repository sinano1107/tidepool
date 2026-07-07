# Tidepool — ubiquitous language

このファイルは用語集であり、仕様書ではない。実装詳細は書かない。背景の全体像は context-vault の `projects/tidepool` を参照。

## Task(タスク)

ボード上の作業単位。すべての作業・質問・レビューはタスクである(「Everything is a task」)。

- **type**: `work` / `question` / `review` のいずれか。
- **parent/child(親子関係)**: 子タスクは親タスクの作業の結果としてのみ生まれる(decompose-completion、escalation)。
- **blocked**: 「未完了(`done`/`cancelled` 以外)の子を持つ」状態。親子関係から機械的に導出される。独立した blocking エッジは存在しない。

## Status(ステータス)

`todo` / `in_progress` / `blocked` / `done` / `cancelled` の5つ。`skipped` はステータスではなく `todo` 上の表示用モディファイア(キュービューのみ)。

## Risk flag(リスクフラグ)

タスクが外部への影響(不可逆な効果)を持つことを登録時に宣言する真偽値マーカー。親の risk を超える子(親=なし、子=あり)の登録はそれ自体が決裁権外でありエスカレーションになる。承認されると親の risk も「あり」へ引き上げられる(上方伝播)。注意配分では機械観測された事実が主入力であり、宣言された risk は副次入力にとどまる(誤分類によって監査から逃れることはできない)。

## Review flag(レビューフラグ)

完了時レビュー(review タスクの自動生成)へのタスク単位の opt-in。必須ではない。子のレビューは既定で親に委譲される(分解された作業の品質は統合点で判断するのが最良)が、親の完了前に外部影響を持つ子 — risk flag で識別される — は個別にレビューされる。

## Escalation(エスカレーション)

決裁権(decision authority)の外にある判断を上位者に委ねること。実体は question タスクの登録であり、親タスクが `blocked` になる。上方向のエスカレーションは決して制限されない(安全弁)。決裁権外の操作要求は、拒否されるのではなくエスカレーション(承認 question)へ変換される。

## Worker(ワーカー)

タスクの assignee になれる主体。人間とエージェントの総称。エージェント = ベース AI + skills + instructions + authority profile。人間は全権限を持つ worker。

## Slot(スロット)

システム全体で唯一の実行枠(concurrency = 1)。エージェント・インフラの概念であり、タスクモデルの概念ではない(人間タスクはスロットの外で並行する)。

## Slot-release tree rule

スロットが解放されるとき(完了・エスカレーション・watchdog 失敗のいずれでも)、作業ツリーを WIP コミットで退避しクリーンに戻すことが機械的に保証される、という規律。エージェントの善意には依存しない。

## Workspace(ワークスペース)

タスクが実行される場所を指す第一級エンティティ(名前 → Pi 上のパス)。子タスクは親の workspace を既定で継承する。

## Handoff doc(ハンドオフドキュメント)

work タスク完了時に必須の引き継ぎ文書。行動可能な情報はタスクになり、doc は文脈のみを運ぶ。question / review タスクには不要。

## Usage limit(使用量リミット)

アカウント単位(エージェント単位ではない)の実行制約。リミット到達は「失敗」ではなく自動回復する環境事象であり、エスカレーションや失敗統計を汚さない。キュー上では `skipped` として現れる。

## Swell / Condensation

Swell = 外部からの周期的なタスク流入・処理サイクル。Condensation = ログが meta-review 層で蒸留され、具体的な diff(instruction / authority の変更)として戻ってくる内部自己調整ループ。
