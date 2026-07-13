# roster は push+pull のハイブリッドで配り、能力は分類学ではなく散文で伝える

issue #43 のグリリングで、decompose する agent に「どの名前が有効な委譲先か」を届ける経路がない問題(profile.guidance への手書き頼み)を設計した。骨格は **push+pull のハイブリッド**: spawn 時に呼び出し元の `assignable_to` を解決した roster(直接委譲できる相手)を system prompt に注入し、registry 全体は `list_agents` MCP ツールで必要時に照会する。push のコストは registry のサイズではなく**委譲許可リストのサイズ**に比例する — least privilege で書かれた profile のセッションは registry が何十件に育っても薄いまま、`*`(無制限)は全展開されて意図的に高くつく。コストが権限の広さに比例し、それを制御するのが registry の著者、というインセンティブの向きが正しい。pull の discoverability は `assignee` フィールドの説明文に入れる定数サイズの誘導1行が担う。

roster の1行は **`名前 — description`** のみ。description は agent frontmatter の必須フィールド(欠落はロードエラー — issue #41 の `assignable_to` 明示必須化と同じ衛生)で、「いつ委譲先として適するか」を registry の著者が書く1行の散文。読み手は人間ではなく LLM であり、ルーティング精度は分類学より自然文が高い。`model` / `effort` などベンダー固有の語彙は roster に決して載せない — 有効値の閉集合はベンダー知識で adapter に属し(ADR 0005)、別ベンダーのモデルが読むと誤解を誘発する。tier(高コスト/コスパ型)の伝達が必要なときも description の散文が担う。

`list_agents` は呼び出しごとに registry を再読込し、decompose の検査と同一の `outsideAuthority` で各行に `委譲可` / `要承認` をマークする — マークと実際の挙動が乖離しない単一ソース。

Considered options:

- **`assignee` を `z.enum` で動的生成しスキーマ強制** — 権限外 assignee の指定は「エラー」ではなく「承認 question への変換」というドメイン操作(tasks.ts)であり、enum で形式的に封じると escalation の道まで塞ぐ。存在しない名前の実害は `unknown agent` 即エラー(ADR 0012 / issue #36)で既に防がれている。
- **ジャンル分類(enum)/ タグで得意分野を表す** — 分類学の保守が必要で、境界例(「レビューもできる developer」)で破綻し、ジャンル追加が registry スキーマ変更になる。LLM の読み手には散文と差がないかむしろ劣る。
- **中立 tier フィールド新設 / adapter でベンダー値を中立ラベルへ翻訳** — 小さいとはいえ新しい分類学、またはベンダー×世代の対応表という新しい保守。委譲判断に要るのは絶対 tier ではなく相対トレードオフで、それは「いつ委譲すべきか」の文と不可分 — 散文で済む。
- **profile.guidance への自動追記** — guidance は人間が書く authority の散文であり、機械生成物の混入は層の混同。roster は spawn 時の組み立て(claude-worker)に置く。
- **push のみ / pull のみ** — push のみは `*` 以外の agent が「存在するが権限外」の相手を知れず escalation の判断材料を失う。pull のみは分解の計画段階(チームに誰がいるか)で roster が手元になく、呼ばれない事故もある。
