# skill アクセスは agent frontmatter の許可リスト — 強制は spawn 前列挙の補集合 deny

2026-07-15 の grilling(issue #56)で決定。workspace checkout に置かれた skill は全エージェントに等しく見え、さらに検証で、ホストユーザーの skill(`~/.claude/skills/`)や plugin の skill も worker session に素通りしていることが判明した(本 spawn は `--safe-mode` なしの workspace cwd 実行のため)。CONTEXT.md の Worker 定義「エージェント = ベース AI + skills + instructions + authority profile」の skills に、実装の対応物を与える。

決定:

1. **`skills` は agent frontmatter の必須フィールド(許可リスト)。** authority profile ではない — skill は「何を知っているか」(専門性、ADR 0017 の軸)であり「何に影響を及ぼしてよいか」(権限)ではない。profile は複数エージェントに共有される部品なので、そこへ skill 集合を入れると「同じ権限で違う専門」が profile を分裂させる。省略は読み込みエラー、無制限は明示の `["*"]`(issue #41 の線 — 省略に意味を持たせない)。
2. **語彙は5種**: `"*"`(単独時のみ)/ `"@workspace"`(その workspace の checkout の skill 全部)/ `"@host"`(ホスト環境の skill 全部 = ユーザーレベル + plugin)/ `"plugin名:*"`(特定 plugin の全 skill)/ 個別名(完全一致、plugin skill は `plugin名:skill名`)。glob は「`*` 単独」と「`名前:*`」の2形だけ。`@` で始まるエントリは `{workspace, host}` の閉集合でバリデーションする(`workspace:*` 形式だと「workspace という名の plugin」と文法上区別できず、スコープ語の typo が検出不能になる)。plugin 名の typo や workspace に実在しない個別名は inert — **許可リストは参照であって在庫の主張ではない**(ADR 0023 と同じ線)。agent は複数 workspace を渡るので「この workspace に無い」は正常な状態。
3. **強制は adapter(ClaudeCodeWorker)の補集合 deny。** 実物 CLI(2.1.210)での検証: per-skill deny `--disallowedTools "Skill(名前)"` は効く(未文書だが動作確認済み)。一方、許可リストを「全 deny + 個別 allow」では組めない(deny が常に allow に勝ち、しかも worker は `--permission-mode auto` で走るため allow はそもそも制限として機能しない)。使える強制プリミティブは deny のみ — よって「見えている skill の全集合 − 許可集合」を deny で並べる。
4. **全集合はゼロトークン ping で CLI 自身に列挙させる。** spawn 直前に workspace cwd で `claude -p "/usage" --output-format stream-json --verbose` を走らせると、init イベントの `skills` に CLI が解決した全 skill(workspace + ユーザーレベル + plugin 接頭辞付き)が載り、`/usage` はローカル処理のため cost 0・num_turns 0・約2秒で自然終了する(検証済み)。発見ロジック(project/user/plugin)を tidepool 側で複製しないので drift しない。checkUsage と同じガードレール(`--model haiku --max-turns 1 --max-budget-usd 0.01`)を付けるが、`--safe-mode` は観測対象の skill を消すので付けない。`@workspace`/`@host` の分離は checkout の `.claude/skills/` 走査(この1ディレクトリに限れば発見ロジック複製のリスクはほぼない)との差分で行う。
5. **ping が不要な形はスキップする。** `["*"]` は deny なし(ping 不要)、`[]` は `--disable-slash-commands` 一発(ping 不要)。有限リストの agent の spawn にだけ約2秒が乗る。
6. **ping 失敗は spawn 失敗。** deny リストが組めないまま進む形は一切作らない(たまに効かないアクセス制御は制御ではない)。既存の失敗系(retry / swell throttle、ADR 0007)に乗せる。`--disable-slash-commands` での degrade 強行は「約束した装備が黙って消えた」セッションを生み、失敗が観測不能になるので採らない。
7. **deckhand(→ tako、issue #51)は `["@workspace"]`。** エージェントの職能が、バージョン管理され PR レビューを通る面に閉じる — workspace に skill を足すこと自体が「全 agent への職能付与」として可視化される。ホスト skill の素通りは設計意図ではなく偶然の産物だったので、既定 agent の定義で明示的に閉じる。

帰結:

- 列挙 ping と本 spawn の間に skill が増える TOCTOU の窓は、同一ホスト・数秒として受容する。
- WebUI の skill ピッカー(有効 skill 一覧からの選択)は issue #54 の agent 編集画面に属する。review spawn のツール層 deny(issue #59)は同じ「spawn 時ハーネスフラグ」の族で、実装は相乗りできる。
- Claude Code 自身の agent frontmatter にも `skills:` フィールドがあるが、意味論はプリロード(装備 — 起動時に内容を注入)であってアクセス制御ではない。同名でも別物。装備は必要になったときの別機能として分離しておく。

Considered options:

- **authority profile に置く** — 既存の機械強制リスト(assignable_to / allowed_workspaces / merge)は全部 profile にあり一貫して見えるが、skill は権限ではなく専門性の軸。profile の共有と skill 集合が絡み合う。
- **deny リスト方式** — 列挙不要で機械強制は完全だが、「このエージェントに何ができるか」が定義から読めず、許可制の意図と逆。
- **省略 = 全許可 / 全禁止** — 前者は issue #41 で潰した footgun そのもの。後者は fail-closed だが、「frontmatter だけの正規形 agent」(ADR 0017)が暗黙に skill を失う。
- **fs 全走査で列挙** — user/plugin/marketplace の発見ロジックを tidepool 側に複製することになり drift する。CLI 自身の init 報告が正。
- **checkUsage との統合** — cwd(盤面 vs workspace)・`--safe-mode`(usage ping は漏れ防止に必要、列挙は漏れこそが観測対象)・鮮度(定期 poll vs spawn 直前)の3点が噛み合わず、同居できない。
