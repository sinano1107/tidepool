# slot は容量であり身元ではない: assignee は spawn の瞬間に解決し、解決失敗は quarantine へ落とす

issue #36 のグリリングで、pickup が事前割当 assignee を無視して起動時固定の worker id で上書きする実装(walking skeleton の遺物)を設計として否定した。slot は用語集どおり「エージェント・インフラの概念でありタスクモデルの概念ではない」— 容量(concurrency = 1)の制約であって身元の制約ではない。slot は human 宛て以外のすべてのタスク(未指定含む)を取り、**どのエージェントとして実行するかは spawn の瞬間に task.assignee から registry 解決する**(未指定 = 既定 agent への参照、ADR 0011。per-use 解決は ADR 0009 と同じ規約)。「盤面に構成された唯一の worker」という概念は存在しない — `TIDEPOOL_AGENT` は既定 agent のポインタに格下げされる。これで assignee の3値が揃う: null = 既定への参照、エージェント名 = その agent として実行、human = slot の外(issue #13 の your tasks)。

assignee の解決失敗は ADR 0009 の2群処理に揃える: 登録時(人間の同期リクエスト)は DomainError → 4xx で即拒否。pickup 時(盤面の自律経路)は **quarantine を agent 名へ一般化**して落とす — 該当 agent 名を needs-human とマークし、その名前宛てのタスクの pickup を止め(キュービューでは `skipped`)、Tidepool 名義の確認型 question を生成する(1 agent 名につき最大1枚)。解除検証は「その名前が registry に復活している、またはその名前宛ての未着手タスクがもう存在しない」(registry の修理とタスクの付け替え、どちらの修理でも通る)。

Considered options:

- **起動時固定の1 worker が全タスクを実行し、pickup が assignee を上書き(従来実装)** — human 宛て work タスクが slot に奪われ、他エージェント宛ての委譲記録が黙って executor 名義に化ける。「記録は何も消えない」の原則に反する。
- **「設定済み worker 宛て + 未指定」だけ pickup し、他エージェント宛ては待たせる** — slot に「持ち主」という身元を持ち込み、Slot の定義に反する。他エージェント宛てが出口のない停止になる。「設定済み worker」自体が実装の遺物であってドメインの概念ではない。
- **解決失敗を黙って skip** — なぜ止まったかが人間に届かず、解除への道が構造に埋め込まれない放置状態を作る。workspace の解決失敗は既に quarantine(封じ込め + 確認型 question)で扱われており、対称に拡張するほうが機構も概念も増えない。
