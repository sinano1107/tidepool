# review の書き込み床は permission 層(`--permission-mode manual`)が担う

issue #144 のグリリング(2026-07-29)で決定。ADR 0033 の追記が「OS には降ろせない」と結論した review の書き込み床を、どの層でどう建てるかの決定。

**床に数えるのはモデル判断を通らない経路だけ**という原則を先に置く。現行の `auto` モードの判定は CLI 内蔵の **LLM 分類器**である(CLI 自身の文言:"auto mode … uses an AI classifier" / "The classifier is an LLM that reads these rules as part of its system prompt")。分類器はモデルの判断であり、モデルの判断は床ではない — issue #144 の実測でも、base64 パイプの1回目はモデル自身が難読化を理由に全面拒否して permission 層に到達せず、何が塞がれるのかが測れなかった。`manual` は分類器を通らず、permission ルール + コマンド構造解析という決定的な経路になる。したがって review の書き込み床の本体は `manual` に置く。work は `auto` のまま(`reviewToolDenials` と同じ `task.type` 分岐)—— work は書けなければならない。

## 実測が規定した事実(2026-07-29、macOS 2.1.220 / Pi 2.1.207)

判定はすべて stream-json の `tool_result`(`is_error`)とファイルシステムの状態で行った。モデルの語りは判定に使っていない。詳細な表は issue #144 のコメントにある。

1. **OS サンドボックスは permission 層を無効化する。** CLI の `sandbox.autoAllowBashIfSandboxed`(既定 `true`)が「サンドボックス内の Bash は承認不要」を意味するため、ADR 0033 の settings を渡した瞬間 `manual` の Bash 床は丸ごと消える(`echo x > f` が通る)。`sandbox.enabled: true` だけで起きる。**`autoAllowBashIfSandboxed: false` を review プロファイルに載せることが、この決定の成立条件である。** macOS と Pi(bwrap)の両方で、既定では床なし・`false` では床ありを確認した。
2. **MCP verbs は素の `manual` では塞がる。** 盤面への唯一の channel が `--allowedTools` なしでは全部承認待ちになり、review は一切完了できない。綴りは**サーバ単位の `mcp__tidepool`**(本番 mcp-config の server キーと同名)で通り、6 verb すべてが実際に実行されることをサーバ側のマーカーで確認した。
3. **`--allowedTools` の存在は `manual` を strict に反転させない。** allowlist に `Bash(npm test*)` だけを載せた状態でも `git status` / `git diff` / `cat` / `grep` と `Read` ツールは素通しのまま。「正当な読み取りコマンドを全部列挙する」コストは発生しない。**`Skill` ツールも素通しする** —— ADR 0025 の complement-deny(`computeSkillDenials`)は review タスクにも走るので、`Skill` が承認要求側だったら review は許可されたはずの skill を全部失うことになるが、そうならないことを確認した(allow に足す必要はない)。
4. **迂回耐性。** リダイレクト(`echo x > f`)は `Output redirection to '…' was blocked.`、`sh -c '… > f'` と `printf … | sh` と `echo <base64> | base64 -d | sh` は `This command requires approval` —— headless では誰も承認できないので拒否。ファイルは1つもできない。列挙で塞げなかったリダイレクトとインタプリタが、ここで初めて決定的に塞がる。
5. **deny は allow に常勝する**(ADR 0033 実験2 が `manual` 下でも成立)。`Bash(rm*)` を allow と deny の両方に載せた状態で `rm` は拒否された。
6. **allow は接頭辞の外へ漏れない。** `Bash(npm test*)` で `npm test -- <file>` と `npm test 2>&1 | tail -5` は通り、`npx vitest run <file>` は承認要求になる。2語の接頭辞もパイプラインも期待どおり働く。

## 層の分担

ADR 0033 の OS サンドボックスと併用する。ただし独立した4層ではない —— 上の事実1のとおり、**サンドボックスの auto-allow を切って初めて permission 層が生きる**。この依存が層の順序である。

- **OS サンドボックス(ADR 0033)** — 読み取り視界とネットワーク、および allow で開けたコマンドの書き込み半径。`npm test` のような任意コード実行を許しても、書き込みは workspace 内に閉じる。
- **permission 層(`manual`)** — 書き込み床の本体。リダイレクト・インタプリタ・ラッパを含む副作用系の決定的拒否。
- **`--disallowedTools`(ADR 0013 追記 / issue #59)** — **役割が変わる**。「列挙で塞ぐ床」ではない(それは失敗した)。**allow で開けられる範囲の上限**であり、明確な拒否の宣言である。registry 側の allow がどれだけ雑でも `git commit` / `git push` / `rm` は開かない。ただし**上限が覆うのは列挙されたものだけ**である —— インタプリタもラッパも列挙されていないので、registry に `sh -c` と書けば文法検証を通り実際に開く。これは穴ではなく線引きで、列挙で塞ぐ試みが失敗した以上、`review_allowed_commands` に対する一般の門は機械ではなく保護 workspace の人間 merge である。
- **slot-release tree rule** — 残余の汚れの機械的回収。

`manual` はホスト能力に依存しないので、ADR 0033 の能力検査・quarantine に新しい資源は生えない。

## 明示 allow の2本

**実測待ちにせず、決定的な permission 層に allow を置く**。「観測されただけの既定挙動」に床の成立を依存させないのは、`auto` の分類器を床から退けたのと同じ理屈である。

1. **MCP verbs** — `mcp__tidepool` をサーバ単位で allow する。verb の権限は盤面側(authority profile / MCP router)が縛るので、CLI 側で開けても権限モデルは緩まない。事実2のとおり allow が無いと review は完全に死ぬので、デプロイ時 canary に「MCP verb が通る」行を持つ。
2. **`review_allowed_commands`** — registry の `workspaces.yaml` に置くホスト非依存のコマンド接頭辞列(省略時は空)。盤面が spawn 時に `Bash(<prefix>*)` へ機械変換して `--allowedTools` に折り込む。review spawn にのみ効く。permission を**広げる**設定なので、保護 workspace である registry の人間 merge が門になる(agent の skill allowlist と同じ線)。文法検証はカンマ・括弧・`*`・空文字・制御文字を拒否する —— `--allowedTools` はカンマ結合なので、エントリ内のカンマは人間が review したつもりの範囲を越えて allow トークンを注入できる。**門についての記述は ADR 0061 で訂正された(下記追記)。**

## 床を workspace 側から持ち上げる経路(実測で見つかった実バグ)

CLI は checkout 自身の `.claude/settings.local.json` の `permissions.allow` を merge し、それが `manual` の床を持ち上げる(`sh -c '… > f'` が通った)。`.claude/settings.json`(project tier)の `permissions` と、両ファイルの `permissions.defaultMode` は効かない —— 効くのは local tier の `allow` だけである。`auto` の下では分類器がどのみち自己承認していたので無害だったが、`manual` では permission 層が床そのものなので直撃する。work セッションは自分の checkout に書けるため、放置すれば #60 が `allowRead` で塞いだのと同じ「セッション N で床を広げ、N+1 で抜ける」2セッション経路になる。

対処は既存ガードの拡張である。`floorOverridingSettings`(src/sandbox.ts)は checkout 側 settings の `sandbox` キーだけを offending として返していたが、`permissions` キーも返す。fail-closed の形も検査対象ファイルも変えない。これは床そのものではなく床の**ガード**であり、床は依然コード定数である(ADR 0013)。

## この決定が届けない範囲

`review_allowed_commands` に `npm test` を入れても、review セッションが実際にテストを通せるとは限らない。ADR 0033 の読み取り封じ込め(`denyRead: ["~/"]`)の下では tidepool 自身のスイートは 150 file 中 93 file が落ちる(サンドボックス外は 840 tests 全 green)。permission 層の問題ではなく読み取り床との衝突であり、この決定の範囲外である(issue #146 に切り出した)。したがって v1 では**スキーマと配線だけを入れ、registry には値を入れない** —— 通らないものを allow に並べて「開けた」という誤った安心を作らない。

**追記(#146 で解決)**: 原因は読み取り床ではなく、サンドボックスのネットワーク既定が loopback への `listen` を拒否していたことだった(review 固有でもなく work プロファイルでも同じく落ちる)。修理は両プロファイルの `network: { allowLocalBinding: true }` で、review プロファイルの emit では 152 file / 858 tests が全 green になった(macOS 2.1.220)— 詳細は ADR 0033 の #146 追記。registry への値の投入は依然この決定の範囲外(ホストごとの登録判断)である。

## Considered options

- **deny パターンを足す**(`dd`、`truncate`、`python*`、`node*`、`perl*` 等)— `--disallowedTools` は `Bash(<prefix>*)` の前置一致なので、**リダイレクト(`>`)はコマンドではなく原理的にパターンを書けない**。インタプリタとラッパは無限にある。塞げないまま「列挙した」という誤った安心だけが増える。ADR 0033 が「列挙漏れの最後の砦が OS になる」と書いたのがこの穴で、その OS 側が建てられなかった(ADR 0033 追記)。
- **`Bash` ごと deny** — review の仕事そのものが読むこと(`git diff` / `grep` / `npm test`)なので成立しない。
- **`--disallowedTools Bash` + `--allowedTools "Bash(git diff*)"` の allowlist** — 事実5のとおり deny は allow に常勝するため表現できない。
- **`dontAsk`** — Bash 自体が落ちるので review に使えない。
- **`auto` のまま OS 側を強化する** — `denyWrite: [workspace]` は Linux(bwrap)backend で成立しない(ADR 0033 追記、本番 Pi で確認)。macOS だけ効かせる案は本番が弱い側になるため ADR 0033 の dev/prod 乖離原則が禁じる。
- **workspace 側 settings のガードを広げず ADR に残余として書く** — `permissions.allow` の経路は work セッションが自力で作れるので、review が封じ込めるはずの当の行為者が床を外せることになる。#60 で同じ形を塞いだ判断と揃えない理由がない。

## 追記(#229 / ADR 0061 —— 「門は人間 merge」の訂正)

この ADR が2箇所で書く「門は保護 workspace の人間 merge である」(層の分担の `--disallowedTools` 節、
明示 allow の2本目)と、`src/registry.ts` の doc comment 2箇所(フィールド定義と
`assertValidReviewAllowedCommands`)が書く「its only gate is a human reading the registry PR」は、
**人間発の経路を勘定に入れていない不正確な記述であり、書かれた時点で既に不正確だった。**

registry 変更の正規経路は2本ある —— agent 発(registry-edit タスク → PR → 人間 merge)と、人間発
(WebUI / 管理MCP → 盤面がリモートの保護ブランチへ**直接コミット**、ADR 0052)。PR が門になるのは前者
だけである。「PR が門」が事実だったのは、このフィールドにたまたま人間発の経路が無かったからにすぎず、
**設計された門ではなく経路の不在**だった。

ADR 0061 はその不在を埋め、門を明示する —— **人間面が要求する credential(ADR 0036)と、危険な値に対する
明示の確認**。文法検証の役割はこの訂正で弱まらず、むしろ広がる:「人間が読んだものが CLI に届く」が守る
対象に、確認ダイアログの理由コード列挙が加わる。

**この ADR の主題(床は permission 層に立つ)は無傷である。** 訂正されたのは、床を持ち上げる唯一の
フィールドを何が守るかについての記述だけで、床そのものはいまも `--permission-mode manual` にある。
