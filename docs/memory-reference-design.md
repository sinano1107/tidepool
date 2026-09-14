# Memory の参照設計(既存 OSS からの当てはめ)

ADR 0083 決定11「外部ライブラリは依存に入れないが、読み書きのロジックと構造化は既存 OSS を参照する」の
参照先を1本にまとめた記録(issue #355、建設順 0)。読み手は #357(Memory ストア)と #358(Condensation
ループ)を実装する agent と、それを grilling する人間。OSS の事実の一覧は `docs/agent-memory-oss-survey.md`
にあり、この文書はその続きで、**機構ごと**に「借りる点 / 借りない点 / tidepool への当てはめ」を書く。

前提として決まっていること(再提案しない): 外部ライブラリは依存に入れない(決定11)/ OSS の memory type
分類学(episodic / semantic / procedural…)は持ち込まない(決定11)/ agent ごとに隔離した記憶は作らず
Behavior の宛先で絞る(決定6、追記3)/ Knowledge の状態は2値(追記3)/ 削除は無く無効化のみ(決定5)/
INDEX は保存物ではなく派生(追記3)/ 数値閾値は使わない(決定9)/ 取り込みは hook ではなく盤面側の後処理
(決定8)/ Experience と Judgment は Behavior に畳む(決定2)。

一次資料はすべて 2026-09-14 に README / docs / ソース / 論文から取った。ソースは commit に pin してある
(節ごとに記す)。**一次資料に無い主張は「未確認」と書く。** issue 本文・コメントの記述で一次資料と食い違った
ものは各節の冒頭に「訂正」として残す。

当てはめの語彙は CONTEXT.md「Memory」のもの: 種別 = Knowledge / Behavior / Precedent、状態 = candidate /
approved、読み口 = spawn 注入(最上位 INDEX + 関連 leaf)/ MCP pull(枝を降りる)/ meta-review が読む
(Precedent はエントリではなく投影であり、worker に注入も pull もされない — 決定10)。

## 1. retrieval スコア — Generative Agents、agentmemory

一次資料: Park et al. 2023, arXiv 2304.03442 §4.1–4.2(https://arxiv.org/html/2304.03442)、
公式実装 `reverie/backend_server/persona/cognitive_modules/retrieve.py` / `reflect.py` /
`memory_structures/scratch.py`(https://github.com/joonspk-research/generative_agents 、commit `fe05a71`)。
agentmemory `src/state/hybrid-search.ts`、`src/functions/{lessons,reflect,retention,consolidation-pipeline}.ts`
(https://github.com/rohitg00/agentmemory 、commit `e04ba88`)。

**訂正**: 論文の式は積ではなく **min-max 正規化後の重み付き和** — "score = α_recency · recency +
α_importance · importance + α_relevance · relevance … all αs are set to 1"。issue の「relevance × recency ×
importance」は通称であって式ではない。

事実:

- **recency** は「最後に retrieval された時刻」からの指数減衰(論文: decay 0.995、ゲーム内時間)。コードは
  `last_accessed` で昇順に並べた**リスト位置**を指数にし(`recency_decay ** i`)、既定 0.99、persona の
  `scratch.json` で 0.995。retrieval されたノードは `last_accessed` を現在時刻に更新する。
- **importance** は生成時に LLM が 1–10 で採点(prompt: "rate the likely poignancy")。
- **relevance** は埋め込みの cosine。
- コードの重みは論文と違う: `gw = [0.5 recency, 3 relevance, 2 importance]`(`[1,1,1]` はコメントアウト)。
- **reflection** の発火は importance の累積が閾値 150 を超えたとき(`importance_trigger_max`)。反省文は
  「(because of 1, 2, 8, 15)」の形で根拠ノード id を持ち(`evidence` → `filling`)、記憶ストリームに戻る。
- **agentmemory の主 recall 経路に時間項は無い**: BM25 0.4 + vector 0.6 + graph 0.3 の RRF(k = 60)、複数
  stream 一致に +5% の bonus、session ごと最大 3 件の多様化。減衰は別の4機構に分かれている — lesson / insight
  の confidence の週次線形減衰(`confidence - decayRate × weeks`、床 0.05、`≤ 0.1` かつ強化 0 回で
  **soft-delete**)、consolidation の strength の 30 日ごと ×0.9、retention score の `exp(−λΔt)`
  (λ = 0.01)+ 参照回数 boost。lesson / insight の recall だけ `confidence × relevance × recencyBoost`。half-life
  という parametrize は無い(未記載)。

借りる点:

- 3軸の**分解**(関連 / 新しさ / 重み)は読み手が結果を説明するのに使える語彙。式に固定しない。
- 「引かれた」を記憶側の事実として残す(`last_accessed` の更新)。tidepool ではこれが session 記録の
  memory 観測列(追記3)と decision log への機械記録(決定10)であり、エントリの列ではなく events に載る。
- 反省文が根拠 id を持つ形(GA の evidence、agentmemory の `sourceMemoryIds`)は、meta-review が起草する
  approved 提案が candidate id と Precedent の episode id を出所として持つ形と同じ。
- FTS + 埋め込みの融合は RRF(k = 60、agentmemory と ai-memory が同じ定数。Graphiti の `rrf` は
  `rank_const=1` が既定で、値は揃っていない)。定数は1つで、設定に出さない(ADR 0110 決定4 と同じ「ノブを
  露出しない」線)。

借りない点:

- **importance の LLM 採点** — 書き手の自己申告であり、決定7(自己申告を混ぜない)に反する。tidepool で
  「重み」に当たるものは outcome(Displayed / 異議 / 帰責)から機械導出され、それは ranking の項ではなく
  meta-review の入力である。
- **減衰定数・閾値**(0.995、150、`≤ 0.1` で soft-delete) — 決定9 と決定5。tidepool の「新しさ」は減衰では
  なく無効化の2値で表す(節3)。
- agentmemory の「同じ文言を再保存すると強化」— 自己申告の回数を信号にしている。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Knowledge approved / Behavior approved | spawn 注入 | 関連度(FTS + 埋め込みの RRF)で leaf を並べ、宛先と path prefix で絞り、トークン上限で切る。recency / importance の項は持たない |
| 同上 | MCP pull | 同じ関連度で query に答える。結果に「引いた」記録が events に残る |
| Precedent | meta-review が読む | スコアで並べない。(workspace, agent) と時刻で `listEpisodes` する既存の読み口 |

candidate はどちらの読み口にも出ない(決定3)。

## 2. 注入の2層 — MemGPT / Letta

一次資料: Packer et al. 2023, arXiv 2310.08560v2 §2(https://arxiv.org/abs/2310.08560)。Letta docs
https://docs.letta.com/v1-sdk/memory/memory-blocks 、`/v1-sdk/memory/context-hierarchy` 、
`/v1-sdk/memory/archival-memory` 、`/concepts/memfs` 、`/agent-sdk/memory` 。letta-code
`src/agent/memory-format.ts`、`src/agent/prompts/letta_root_memfs.md`、`src/tools/impl/memory.ts`
(https://github.com/letta-ai/letta-code 、commit `e5924db`)。

事実:

- MemGPT の main context は「system instructions(読み取り専用)/ working context(固定長の読み書き
  ブロック、function call でのみ書ける)/ FIFO queue(先頭に evict 済み message の再帰要約)」、external
  context は recall storage(message DB)と archival storage(任意長テキスト)。移動は LLM の function call
  で、70% で memory pressure 警告、100% で evict + 再帰要約。archival の検索は cosine(pgvector)、ページ送り。
- Letta の memory block は `label / description / value / limit`(文字数)で「always visible — 常に context に
  あり retrieval 不要」、推奨 < 50k 文字・< 20 block。archival は「pin できず tool で query する」
  (`archival_memory_search(query, tags, page)`)。
- MemFS: 記憶は agent の git repo の Markdown。`system/` 配下は毎ターン system prompt に載り、それ以外は
  「**file tree 自体は常に system prompt にあり、ディレクトリ名とファイル名が道標になる**」。既定で vector
  index は無い。v2 layout(`memory-format.ts`、docs 未記載)では root の `MEMORY.md` が frontmatter 無しの
  目次で、「子ディレクトリは自分の `MEMORY.md` を持つときだけ記憶」「深いファイルを開く前にその目次を読め」。
- 書き込み tool(`memory` の `str_replace / insert / delete / rename / create`、`memory_apply_patch`)は
  `reason` 必須で、その文字列を commit message に git commit する。dreaming は節4。

借りる点:

- **常駐部分は小さく上限付き**(block の `limit`、`< 20 block`)。tidepool の盤面設定のトークン上限がこれ。
- **tree が道標** = 追記3 の「INDEX は派生の純粋目次で、spawn 時は最上位 INDEX + 関連 leaf、pull で枝を
  降りる」そのもの。MemFS v2 の「子の `MEMORY.md` を読んでから開く」は pull の手順の書き方として借りる。
- block の `description`(「読み書きの判断に使う主情報」)は、tidepool ではエントリの `title` + `path` が
  担う。目次の1行はこの2つだけで足りる。
- archival の**ページ送り**は pull tool の引数に持つ。

借りない点:

- agent が常駐部分を自分で書き換える(`str_replace` + `reason` + commit)— Behavior は承認必須(決定3)、
  approved は不変(決定4)。Knowledge の書き込み tool は**追加**のみで、既存を編集しない(無効化 + 新エントリ)。
- memory pressure / evict / 再帰要約 — worker の context 管理は CLI の仕事で、盤面は FIFO を持たない。
- agent ごとの repo(決定6)。「`system/` に置くかどうか」を書き手が決める tier 制 — tidepool の常駐は
  状態(approved)と関連度で決まり、置き場所(path)は絞り込みにしか使わない。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Knowledge / Behavior approved | spawn 注入(`--append-system-prompt`) | 最上位 INDEX(全 prefix の子 title)+ 関連 leaf。Behavior は宛先で絞る。上限は盤面設定 |
| 同上 | MCP pull | 3つの動詞に分ける: prefix の目次を見る(ls 相当)/ query で探す(search)/ id で読む(read)。ページ送りあり |
| Knowledge candidate → approved | worker の書き込み tool | 追加のみ、出所と path 必須。Letta の `reason` に当たるものは出所の event id |
| Precedent | — | 注入も pull もしない |

## 3. 事実の時間性と出所 — Graphiti、semantica

一次資料: Graphiti `graphiti_core/edges.py`(`EntityEdge`)、`nodes.py`(`EpisodicNode`)、
`utils/maintenance/edge_operations.py`(`resolve_edge_contradictions`)、`models/edges/edge_db_queries.py`
(https://github.com/getzep/graphiti 、commit `c035afb7`)、README、docs
https://help.getzep.com/graphiti/core-concepts/adding-episodes 。Zep 論文 arXiv 2501.13956 §2.1–2.2.3。
semantica `semantica/provenance/{schemas,manager}.py`、`kg/temporal_model.py`、`kg/temporal_reasoning.py`、
`context/context_graph.py`(`state_at`)、`context/decision_models.py`、`semantica_mcp/mcp/schemas.py`
(https://github.com/semantica-agi/semantica 、commit `63cd6989`)。

事実:

- Graphiti の `EntityEdge` は4つの時刻を持つ: `created_at`(基底)、`valid_at`「事実が真になった時」、
  `invalid_at`「真でなくなった時」、`expired_at`「invalidate された時」(source の説明文は "node was
  invalidated" と書いてあるが edge の欄)。Zep 論文がこれを2軸に分ける: T = 事象の時間(`valid / invalid`)、
  T′ = 取り込みの時間(`created / expired`)。
- 出所は双方向: `EntityEdge.episodes`(episode uuid の列)と `EpisodicNode.entity_edges`。episode → entity
  は `MENTIONS` edge。README: "Everything traces back to episodes"。
- 矛盾は削除せず `edge.invalid_at = 新 edge.valid_at`、`expired_at = now`(`resolve_edge_contradictions`)。
  区間が重ならなければ触らない。**矛盾の検出は LLM**(`contradicted_facts`)で、bulk 取り込みでは走らない。
- `valid_at / invalid_at` の値は抽出 prompt が LLM に決めさせる("If the fact is ongoing … set valid_at to
  the timestamp of the episode")。
- semantica `ProvenanceEntry` は PROV-O に写像する: `entity_id → prov:Entity`、`activity_id → prov:Activity`、
  `agent_id / agent_type → prov:Agent`、`derived_from_id → prov:wasDerivedFrom`、`used_entities → prov:used`、
  `invalidated* → prov:Invalidation`(「tombstone、hard delete ではない」)。`confidence` / `credibility` の欄も
  ある。`BiTemporalFact` は `valid_from / valid_until / recorded_at / superseded_at`。ただし `state_at()` は
  `ContextGraph` の method で **valid 軸しか見ない**(`recorded_at / superseded_at` は参照しない)。
- semantica の `Decision` は `category, scenario, reasoning, outcome, confidence, decision_maker, valid_from,
  valid_until`(options の欄は無い)。`record_decision` は申告 API(ADR 0083 決定8 のとおり)。

借りる点:

- **2軸の区別**。tidepool のエントリは「事象の時間」= 出所(event id / commit)の時刻、「取り込みの時間」=
  エントリを作った event / 無効化した event の時刻。**どちらも events なので取り込み軸はただで手に入る** —
  盤面はあらゆる記憶の変更を event として追記するだけでよく、時刻の列をエントリに持つ必要が無い。
- **矛盾は無効化 + 新エントリ**で、旧エントリの無効化 event が新エントリの id を持つ(Graphiti の
  `invalid_at = 新 edge.valid_at`、semantica の `supersedes`)。決定4「統合後の1件を新たな承認 question に」の
  記録形がこれ。
- **出所の型**(PROV-O の entity / activity / agent): tidepool は出所を「何から(event id / commit)」「どの
  活動で(worker tool / 人間 / RCA / meta-review)」「誰が(agent 名 / human)」の3つで持ち、出所の種別
  (事実 = commit / event id への参照、推論 = worker の decision への参照 — 追記3)は「何から」の分類。
- `state_at` に当たるものは追記3 の「当時のストアの snapshot 識別子」。**識別子は memory 系 event の
  watermark(その時点の最大 event id)でよい** — エントリの変更がすべて events なら、任意時点の approved
  集合は events を watermark まで再生して復元できる。

借りない点:

- LLM による矛盾検出(取り込み時) — 抽出は決定論(決定8)。矛盾に気づくのは異議・meta-review・人間で、
  無効化の書き手はその3者。
- `confidence` / `credibility` の欄(Knowledge は2値、追記3)。
- entity graph としての保持、`Decision` を記憶の1種にすること(決定8)。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Knowledge(両状態) | 注入 / pull の両方 | 出所必須。注入時は出所の**種別**を見せる(追記3)。無効化済みは両読み口に出ない |
| Behavior approved | 注入 / pull | 出所 = 起草元 candidate id + Precedent の episode id(+ 異議 event id)。統合の新エントリは旧エントリ id を出所に持ち、旧は「X に置換」で無効化 |
| Precedent | meta-review が読む | Episode は既に `registryCommit` と event id を刻む(ADR 0020 と同じ理由)。追加は不要 |

## 4. 統合(consolidation)— Letta dreaming、agentmemory、claude-mem(+ Munder Difflin の検証門)

一次資料: Letta docs https://docs.letta.com/configuration/memory(「Memory & dreaming」)、
`/agent-sdk/memory`、letta-code `src/cli/helpers/memory-reminder.ts`、`src/agent/subagents/builtin/reflection.md`
(commit `e5924db`)。agentmemory `src/functions/consolidation-pipeline.ts`、`reflect.ts`、
`src/prompts/consolidation.ts`(commit `e04ba88`)。claude-mem `src/sdk/prompts.ts`(`buildSummaryPrompt`)、
`src/cli/handlers/summarize.ts`(https://github.com/thedotmack/claude-mem 、commit `40be934`、v13.24.23)。
Munder Difflin は節9。

事実:

- Letta の dreaming は「背景 subagent が最近の会話を読み、教訓を統合して記憶を更新する」。発火は
  `trigger: "step-count" | "compaction-event" | "off"`(既定 25 step、コード既定は compaction-event)、
  `behavior: "reminder" | "auto-launch"`。「**Agent reviews before applying** … does not ask you for approval」。
  subagent(`reflection.md`)は `Bash, Edit` で `system/` のファイルを作成・削除・移動でき、普通の git で
  commit する。`/doctor` が配置・重複・token を監査する。
- agentmemory の `memory_consolidate` は **LLM 必須**(無ければ skip)。semantic 段の prompt は「2+ episode に
  出る事実だけ」、procedural 段は「2+ 回観測された手順だけ」、既存の事実は `confidence = max(既存, 新)`。
  `memory_reflect` は concept cluster ごとに LLM で insight を出し、同一文言なら `confidence += 0.1 × (1 − c)`
  で強化、新規は `sourceMemoryIds / sourceLessonIds` を持つ。tool 説明の "episodic" 段はコードに無い。
- claude-mem の summary は Stop hook で LLM(Haiku)が `request / investigated / learned / completed /
  next_steps / notes` を書く「checkpoint」。観測→要約の流れは節5。

借りる点:

- **統合の出力は根拠 id を持つ**(agentmemory `sourceMemoryIds`、GA evidence)。meta-review の approved 提案は
  「どの candidate 群を、どの Precedent を根拠に、どの approved を置換するか」を id で持ち、承認 question は
  それを diff で見せる(#358「当面は diff 表示」)。
- **統合前の原文は消えない**。Letta は git、Munder Difflin は backup、tidepool は events(決定5)。
- Letta の `/doctor`(配置・重複・token の監査)は「記憶ブラウザ」の先送り(ADR 0083 先送り)の中身として
  覚えておく — 統計ダッシュボードと同じく、meta-review 自体を検証する必要が出たとき。
- Munder Difflin の **verify-don't-trust**(節9): LLM の書き換えを適用する前に機械で検査する。tidepool の
  門は人間承認だが、question を登録する前の機械検査は安い — 引用した出所がすべて存在する / 置換対象が
  すべて approved で無効化されていない / 宛先が registry にある agent 名 / path が整形式。閾値ではなく整合性。

借りない点:

- **compaction を契機にする**(Letta)— 新しいトリガは周期の1つだけ(決定9)。
- **agent が自分でレビューして承認無しに適用**(Letta の "does not ask you for approval"、Munder Difflin の
  自動 swap)— Behavior は人間承認(決定3)。
- **「2+ 回」の数値規則**(agentmemory)— 繰り返しの有無は meta-review が判断で見る(決定9)。
- confidence の加算・max — 状態は2値。
- LLM 無しで走らない統合 — tidepool の統合は meta-review **task**(agent が読んで書く)なので LLM は
  使うが、それは worker session であってストアのロジックではない(決定11)。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Behavior candidate → approved | meta-review が candidate 群と Precedent を読む | 提案は根拠 id 付き、question は旧 → 新の diff。登録前に整合性検査 |
| Behavior approved → approved(統合) | 同上 | 新エントリを candidate として question に出し、承認で旧を「X に置換」で無効化。旧文言は events に残る |
| Knowledge | 人間 / worker tool / meta-review | 統合は「新 Knowledge(出所 = 旧エントリ id)+ 旧の無効化」。承認 question は要らない(Knowledge は承認不要)。誰が書けるかは #357 で決める |
| Precedent | — | 統合しない。派生は作り直せる(投影器の版) |

## 5. 観測抽出 — claude-mem の transcript → observation(投影器に何を足すか)

一次資料: claude-mem `plugin/hooks/hooks.json`、`src/cli/adapters/claude-code.ts`、
`src/cli/handlers/{observation,summarize,session-end}.ts`、`src/services/worker/ClaudeProvider.ts`、
`src/sdk/{prompts,parser,hardened-options}.ts`、`src/services/sqlite/SessionStore.ts`、
`src/utils/tag-stripping.ts`、`src/shared/SettingsDefaultsManager.ts`(commit `40be934`)、docs
https://docs.claude-mem.ai/architecture/hooks 。比較対象として ai-memory(節7)の `capture_policy.rs`。
tidepool 側は `src/precedent.ts`(`projectEpisode`、`TOOL_ARG_FIELD`、`STRUCTURAL_MARKER_SUBTYPE`、
`IGNORED_TYPES`)。

事実:

- claude-mem は hook 7本(`SessionStart` は `startup|resume|clear|compact` で発火、`UserPromptSubmit`、
  `PostToolUse` は全 tool、`PreToolUse` は Read のみ、`Stop`、`SessionEnd`、`Setup`)。**`PreCompact` は
  登録していない**。`PostToolUse` の入力は `tool_name / tool_input / tool_response / tool_use_id /
  transcript_path / agent_id`。
- 観測は tool 呼び出し1回ごとに **LLM(既定 Haiku 4.5、tool 無し)** が圧縮して `type / title / subtitle /
  facts[] / narrative / concepts[] / files_read[] / files_modified[]` を返す(`<skip_summary reason="noise" />`
  で捨てることもある)。`type` は固定語彙(bugfix / feature / refactor / change / discovery / decision /
  security_alert / security_note / sensitive)、`concepts` も固定語彙。入力は 16,000 文字で頭 60% / 尾 30% に
  切る。既定で `ListMcpResourcesTool, SlashCommand, Skill, TodoWrite, AskUserQuestion` は観測しない。
- `Stop` で transcript の最後の assistant turn を読み、summary を書く(節4)。subagent の Stop は捨てる。
- `<private>…</private>` 等のタグを保存時に剥がす。`tool_uses` 表に生の入出力を 64 KB 上限で持つ。
- ai-memory(hook 経由)は Claude Code の tool 結果に成否の欄が無いので outcome を **Unknown** にする
  (`capture_policy.rs`: "neither the event nor arbitrary response JSON proves an outcome")。

tidepool の投影器(#356、実装済み)との対応:

| claude-mem | tidepool `projectEpisode` | 差 |
| --- | --- | --- |
| hook が tool ごとに POST | 盤面が `worker_exited` 時に transcript を読む(決定8) | 取り込み経路は借りない |
| LLM が観測を圧縮 | 決定論。tool 名 + `TOOL_ARG_FIELD` の引数 + `is_error` + transcript uuid | v1 は生のまま(決定8)。意味付けは meta-review |
| `files_read` / `files_modified` | Read と Write / Edit / NotebookEdit の path が別行にある | **読み出し時の派生で作れる**(tool 名で分ける)。列は足さない |
| `tool_response` 64 KB | `failed` の1ビット + transcript 行参照 | transcript が正本(追記)。写さない |
| skip tool 一覧 | 無し。全行を数える(interpreted / ignored / unknown) | 借りない — 黙って捨てると形式変更が見えない(追記2) |
| outcome Unknown(ai-memory) | `tool_result.is_error` を読む | 盤面側の後処理だから取れる。決定8 の利点の実例 |
| `PreCompact` 無し / `compact` で再注入 | `compact_boundary` マーカー(綴りは**想定**、フィクスチャ未確認) | 調査した hook 系はどれも stream-json の compaction の綴りを証明しない。未知行カウンタで見る(追記2)のまま |
| Stop の summary(request / learned / next_steps) | `task_completed`(result + handoff の有無)| LLM の要約は要らない。完了報告は既に event |
| `<private>` の除去 | 該当なし | transcript は盤面側にあり worker は読めない。Knowledge 書き込み tool の中身は別の問い(#357) |

借りる点(投影器に**足す**候補、いずれも派生の読み方であって列ではない):

- 読み出し時の `files_read / files_modified / commands` の集約(tool 名で分ける)。meta-review が Episode を
  読むときの要約であって、保存はしない。
- `decision` マーカー前後のスライスに「触った path の集合」を付けて返す読み口。claude-mem の `timeline`
  (anchor の前後 N 件)と同じ形で、tidepool は既に `position` を持つ。

借りない点: hook 取り込み、LLM 圧縮、skip 一覧、固定語彙の `type`(Behavior / Knowledge の種別で足りる)、
tool_response の複写。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Precedent | RCA(review layer 2)と meta-review が読む | 読み出し時の集約(path / command / 失敗)。worker には注入も pull もしない(決定10)。worker が自分の過去 Episode を pull できるかは #357 で決める |

## 6. 階層ナビゲーション — claude-mem の index、Letta の memory block / MemFS、OpenViking の L0 / L1 / L2

一次資料: claude-mem `src/services/context/formatters/AgentFormatter.ts`、`src/services/context/ContextBudget.ts`、
`src/servers/mcp-server.ts`、docs https://docs.claude-mem.ai/progressive-disclosure 、README(commit
`40be934`)。Letta は節2。OpenViking `docs/en/concepts/03-context-layers.md`、`07-retrieval.md`、
`openviking/retrieve/hierarchical_retriever.py`(https://github.com/volcengine/OpenViking 、commit
`2d774d8`、v0.4.19)。

**訂正**: claude-mem の `smart_outline` は**コードの構造 outline**(tree-sitter、`smart_search / smart_unfold`
と並ぶ)であって記憶の索引ではない。記憶の索引は `SessionStart` の注入と `search → timeline →
get_observations` の3層。

事実:

- claude-mem が `SessionStart` で注入するのは1行1観測の索引 `ID TIME TYPE TITLE`(既定 50 件、session 10 本、
  summary は `S<id> <request>`)+ 凡例 + "Fetch details: get_observations([IDs])"。上限は hook stdout の
  **10,000 文字**(超えるとファイルに落ちて stub になる)。`fitContextToBudget` は「narrative → 前回 summary →
  session 数を半分 → 観測数を半分」の順で削る。docs の「~10x token savings」は README の主張で測定の一次資料は
  無い(未確認)。
- MCP は `search`(索引、id を返す)→ `timeline(anchor, depth_before, depth_after)` → `get_observations(ids)`
  → `get_tool_uses(ids)`(生の入出力)。
- Letta MemFS: tree が常駐、`MEMORY.md` が目次(節2)。
- OpenViking: L0 = `.abstract.md`(256 文字)、L1 = `.overview.md`(4,000 文字)、L2 = 原本。**L0 / L1 は
  ディレクトリ単位の sidecar で LLM が下から上へ生成**する(ファイルごとには作らない)。検索は全域 vector で
  起点ディレクトリを決め、優先度 queue で `final_score = α × embedding + (1 − α) × parent_score`(α = 1.0
  既定)で再帰、topk が 3 round 変わらなければ止める。API は `abstract(uri) → overview(uri) → read(uri)`。

借りる点:

- **索引の行は id + title(+ path)だけ**。claude-mem の `ID TIME TYPE TITLE` から TIME と TYPE を落とす —
  tidepool の目次は「prefix の子の title を並べたもの」(追記3)で、時刻は events、種別は path で分かる。
- **上限に収める削り順を固定**する: leaf 本文 → 関連 leaf の件数を半分 → 目次の深さを浅く、の順。
  上限は盤面設定、順序はコード(ノブにしない)。
- **id で読む tool** — pull の read は entry id で、注入した目次と pull の search が返す id と同じ id。
- claude-mem の `get_tool_uses`(生の入出力に降りる第4層)は Precedent の transcript uuid 参照と同型。
  読み手は meta-review。

借りない点:

- LLM 生成の L0 / L1 sidecar — 合成要約は「目次だけでは辿れない」が観測されてから meta-review の仕事として
  足す(追記3)。
- OpenViking の score propagation の定数と収束 round、claude-mem の観測数の既定 — ノブ。
- `timeline`(時刻の近傍)を記憶の読み口にすること — 記憶は時系列ではなく path と関連度で引く。時系列は
  Precedent(Episode の位置)の読み方。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Knowledge / Behavior approved | spawn 注入 | 最上位 INDEX(id + title)+ 関連 leaf。固定の削り順で上限に収める |
| 同上 | MCP pull | ls(prefix の目次)/ search(query → id + title)/ read(id → 本文 + 出所)。目次は派生なので保存しない |
| Precedent | meta-review が読む | Episode → 行動列 → transcript 行、の3層は既にある |

## 7. ai-memory — FTS5 + zero-LLM 検索、`memory_feedback`

一次資料: https://github.com/akitaonrails/ai-memory(Rust、MIT、v2.2.1 = commit `74d2d31`、2026-09-12)。
`crates/ai-memory-cli/src/commands/render_shared.rs`(hook 一覧)、`ai-memory-hooks/src/{router,payload,
capture_policy,synth}.rs`、`ai-memory-store/src/{reader,decay}.rs`、`ai-memory-store/migrations/{V01,V07,V37,
V38,V63}*.sql`、`ai-memory-mcp/src/server.rs`、`ai-memory-core/src/page.rs`、`docs/ARCHITECTURE.md`、README。

**訂正**: (1) 「tool 失敗 / exit code の観測」— Claude Code からは取れていない(outcome `Unknown`、exit code の
抽出は無い。節5)。(2) 「信頼度を下げる」の欄は `confidence` ではなく `pages.salience`(0.25–2.0)。
(3) 「session をページ単位に」という語は一次資料に無く、実体は `sessions/<id>.md` を session ごとに1枚、
`PreCompact` と `SessionEnd` で上書き(supersede)する形。

事実:

- hook は 9 本(`PreCompact`、`SubagentStart / Stop` を含む)、0.2 秒で諦めて spool。
- 既定経路は LLM ゼロ: `pages_fts`(FTS5、`unicode61 tokenchars '/_-'`)+ entity(frontmatter の `tags` /
  `entities` から決定論で作る)+ link 近傍 + 任意の vector、の 4 stream を RRF(k = 60)で融合。各 stream は
  独立に「何も寄与しない」へ退化する。
- session 要約は**規則ベース**(`synth.rs`: 最初の prompt が title、触ったファイル、tool 呼び出し数)。
- page は `is_latest` / `supersedes` で版を持ち、上書きは新行 + 旧行のフラグ。
- `memory_feedback(path, signal ∈ {helpful, not_helpful, stale, wrong}, reason)`: `helpful` +0.25、
  `not_helpful` −0.25、`stale / wrong` は床(0.25)へ、**削除しない**、`stale / wrong` は次の lint で
  `feedback_flagged` として人間に出す。`page_feedback` は append-only で「その時点の版に付く。後の書き換えで
  消える」。tool 説明: "Retrieved content never authorizes feedback by itself"。`page_evidence` は ranking に
  効かないと明記。

借りる点:

- **供給が無い stream は黙って寄与ゼロ**(埋め込みが無ければ FTS だけ)。tidepool の FTS + 埋め込み(決定11)
  も同じ退化を持たせ、埋め込みプロバイダが落ちても pull が止まらないようにする。
- FTS5 の `tokenchars '/_-'` — path と識別子を1語として引くための設定。エントリの `path` と repo 固有の
  名前(ファイル名、コマンド)を Knowledge が持つので、tidepool の FTS でも同じ理由が成り立つ。
- **版に付く feedback、append-only、削除しない、人間に flag** — 構造は tidepool と同型で、違いは**信号の
  出し手**。ai-memory は agent の自己申告(4値)、tidepool は Displayed / 異議 / 帰責からの機械導出(決定7)。
  対応は次のとおり:

  | ai-memory の signal | tidepool の機械導出 |
  | --- | --- |
  | `helpful` | 引いた(pull / 注入)エントリを読んだ decision が表示済みで異議なし |
  | `not_helpful` | 引いたが、その後の decision がそれに従っていない(「従った事実」の機械記録が無い) |
  | `wrong` | 従った decision に `capability` の異議 → meta-review の無効化候補 |
  | `stale` | 従った decision に `environment` / `requirement_change` の帰責 → 無効化候補(理由付き) |

  salience の加減算は借りない(数値のノブ、決定9)。「引いただけでは feedback の根拠にならない」の線は
  「注入されたが読まれていない」を `helpful` に数えないことに写る(節11)。
- 規則ベースの session 要約は Episode の読み出し時集約(節5)と同じもの。

借りない点: hook 取り込み(決定8)、tier 分類学(working / episodic / semantic / procedural — 決定11)、
salience の数値、`memory_lint` の LLM 矛盾検出、`memory_delete_page`。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Knowledge / Behavior approved | pull(search) | FTS5 の tokenizer 設定、stream の独立退化、RRF k = 60 |
| 同上 | 無効化の候補 | 上の対応表を meta-review の入力にする。無効化は人間 / meta-review の判断で、自動では落とさない |
| Precedent | — | 規則ベース要約は読み出し時の派生 |

## 8. OpenViking — 段階的取得、retrieval trajectory、`memory_diff`

一次資料: https://github.com/volcengine/OpenViking(Python + Rust、**本体 AGPLv3**、`crates/ov_cli` と
`examples` は Apache-2.0、v0.4.19、commit `2d774d8`)。`docs/en/concepts/{03-context-layers,04-viking-uri,
07-retrieval,08-session,06-extraction}.md`、`openviking_cli/retrieve/types.py`(`QueryResult`、
`ThinkingTrace`、`TraceEventType`)、`openviking/retrieve/context_assembler/ledger.py`、
`openviking/session/memory/experience_lineage.py`、`openviking/session/compressor_v3.py`(`_make_memory_diff`)、
`openviking/server/mcp_endpoint.py`、`docs/en/api/19-agent-evolution.md`。

**訂正**: 「retrieval trajectory を残し、記憶内容の失敗と検索失敗を区別する考え方」は一次資料に**無い**
(未確認)。OpenViking で "trajectory" は agent の**タスク実行**の軌跡(memory type `trajectories`)を指す。
近いものは3つあり、いずれも「記憶が間違っていた vs 見つからなかった」の区別は定義していない。

事実:

- L0 / L1 / L2 と階層検索は節6。
- **検索の来歴(永続化しない)**: `QueryResult { query, matched_contexts, searched_directories,
  thinking_trace }`。`ThinkingTrace` は `search_directory_start / result`、`embedding_scores`、`rerank_scores`、
  `candidate_selected / excluded`、`directory_queued` の event 列で、`include_provenance=True` のときだけ応答に
  載る。書き出すコードは無い。「その後 agent がどれを開いたか」も持たない。
- **served ledger**(`.recall_log.json`): session 内で既に渡した URI と turn を持ち、再提示を抑える。query も
  候補も持たない。
- **読んだ experience の系譜**(`collect_read_experience_uris`): commit された message 列の tool 呼び出しを
  走査し、`read` 系 tool が `completed` で `…/memories/experiences` 配下を読んだものを集め、抽出した
  trajectory に tag として刻む。API `GET /agent-evolution/experiences/trajectories?experience_uri=` と
  `/outcomes` で「その experience を読んだ trajectory と結末(success / failure / partial / unknown /
  unfinished)」が引ける。
- **trajectory → experience** は `session.commit()` の非同期段で LLM が行う(cases → trajectories →
  experiences、`ExtractLoop`)。experience は `supersedes` で旧を自動削除。
- **`memory_diff.json`** は commit ごとに `operations.adds / updates(before, after) / deletes(deleted_content)`
  + `skipped_operations(reason_code)` + `summary` を archive に書く(「監査と rollback のため」)。
- サーバ側 LLM が既存記憶との dedup で merge / delete を決める。MCP `forget` は不可逆削除。

借りる点:

- **「読んだ記憶 → 結末」の系譜を tool 呼び出しの走査で決定論的に作る**(`collect_read_experience_uris`)。
  tidepool では pull / read の tool 呼び出しが transcript に写り、盤面が発行した entry id が `tool_result` に
  写るので、Episode の行動列から「decision マーカー D より前に entry E を読んだ」が完全一致で引ける — decision
  と event id の結合(追記)と同じ機構。これが決定10「引いた記憶とそれに従った事実の機械記録」の実装形で、
  自己申告の列は要らない。
- **検索の来歴を残す**(query / 候補 / 選ばれた・落ちた理由)。OpenViking は応答に載せるだけだが、tidepool は
  pull を event にする(節11)。「記憶が間違っていた vs 見つからなかった」の区別は OpenViking には無いので、
  tidepool で定義する(節11)。
- **統合の前後差分**は tidepool では events の watermark 間の差分そのもの。`skipped_operations` の
  `reason_code` は投影器の欠測理由コードと同じ流儀で、統合の提案が退けた candidate に理由を付ける形に写す。

借りない点:

- LLM 生成の L0 / L1、trajectory → experience の LLM 抽出(Precedent は決定論、意味付けは meta-review)。
- **agent 主導の merge / delete**、`forget`(決定5)。
- **Experience 層**(コメントの「Precedent → Behavior の間に承認不要・強制力なしの層」)— 決定2 が Experience
  を Behavior に畳み、決定3 が「承認前は注入・retrieval しない」と引いた線の再提案になる。「以前こうした /
  こうすると上手くいった」は Precedent(投影)と Behavior candidate(起草)で表せ、worker がそれを読めるかは
  #357 の「Precedent の pull」の問いで、第3の種別は要らない。
- AGPLv3 なので依存としても不可(決定11 とは独立の理由)。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Knowledge / Behavior approved | MCP pull / read | pull と read の tool 呼び出しが Episode の行動行になり、entry id が `tool_result` に写る。「従った」はマーカー前のスライスで引く |
| Behavior candidate → approved | meta-review | 退けた candidate に理由コード。統合の差分は events |
| Precedent | meta-review が読む | 「読んだ entry → decision → outcome」の系譜が Episode から引ける |

## 9. Munder Difflin — 正本と索引の分離、条件付き書き換え

一次資料: https://github.com/chaitanyagiri/munder-difflin(TypeScript / Electron、MIT、v0.4.6、commit
`417d8de`、2026-09-11)。`src/main/memory.ts`(MemPalace 索引)、`src/main/reflect.ts`(`MemoryReflector`、
`condense`、`verify`、`atomicWrite`)、`src/main/hiddenClaude.ts`、`HIVE.md`、README、CHANGELOG。

**訂正**: 「recent は原文保持、古い部分だけ」の境界は**時刻ではなく件数**(`## ` 節の新しい K 件、既定
`recentKeep = 12`)。発火は size(128 KiB の 50%)か節数(50)の閾値で、`config.ts` に "Thresholds DECIDED by
god 2026-06-06"。

事実:

- 正本は agent ごとの `memory.md`(agent が末尾に追記)。索引は MemPalace(Chroma)で、`mtime` が変わった
  ファイルを 10 分ごとに `mempalace mine`(dedup するので再 mine は安全)。README: "the semantic memory index
  … markdown memory works without it"。明示の rebuild コマンドは無い(mtime + dedup で足りる)。
- `condense`: backup(`hive/backups/<stamp>/<id>/memory.md`)→ Haiku で (A) 現 condensed + (B) 追い出す節 →
  JSON `{condensed, hoist[]}`(hoist = pinned へ昇格する行)→ 3領域(pinned / condensed / recent)を組み直す →
  `verify` → temp + fsync + rename。
- `verify` の 8 検査: 領域が揃う / 200 byte 超 / condensed が空でない / **旧の 95% 未満**(縮まなければ失敗)/
  **pinned の行が1行も落ちていない** / hoist の merge が揃う / recent の件数一致 / **recent の各節が末尾空白を
  除いて同一**。失敗すれば原本は無傷で `condense-abort` を log.jsonl に残す。
- LLM は `bypassPermissions` で走り、**人間の門は無い**。CHANGELOG 0.3.8: 「memory condensation had never once
  succeeded: a long run of condense-abort … each failed attempt still writing a full backup first」— 門が
  設計どおり効いていた実例。
- 事実単位の出所・承認 UI は無い(未記載)。

借りる点:

- **索引は捨てられる派生**。tidepool は3段の派生を持つ — events(正本)→ エントリ(派生、投影と同じく
  作り直せる)→ FTS / 埋め込み索引(エントリからの派生)→ INDEX(path からの派生)。どの段も上の段から
  再構築でき、rebuild は「索引を消して作り直す」1操作。埋め込みモデルを変えたら索引だけ作り直せばよい。
- **verify-don't-trust**を統合提案の整合性検査に(節4)。特に「pinned が1行も落ちない」は「承認済みの
  文言は不変(決定4)」の機械版 — 統合提案が置換する approved エントリはすべて列挙されていなければならず、
  列挙に無い approved は触らない。「縮まなければ失敗」は借りない(統合の目的は圧縮ではなく繰り返しの判断)。
- **失敗を記録として残す**(`condense-abort` + 理由)。tidepool は question の登録拒否を event にする
  (欠測理由と同じ流儀)。

借りない点:

- `memory.md` を正本にする(events + transcript が正本、決定1)。agent の自由追記(Knowledge は tool、
  Behavior は承認)。
- size / 件数の閾値と周期(決定9。meta-review は周期のみ)。
- LLM の書き換えを人間無しで適用(決定3)。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Knowledge / Behavior approved | 索引(FTS / 埋め込み) | 派生で作り直せる。`extractor_version` と同じく索引の版を持つ |
| Behavior approved → approved(統合) | 承認 question | 置換対象の完全列挙、出所の存在、宛先・path の整合性を登録前に検査。失敗は event |
| Precedent | — | 投影の版と同じ話 |

## 10. LWC / llm-wiki-cli — 正本 SQLite と投影、changeset、出所の3値(2026-09-14 の追加調査で足した節)

一次資料: https://github.com/JanYork/llm-wiki-cli(Rust、Apache-2.0、v0.18.5 = 2026-09-12、HEAD `11e869f`
2026-09-13、54★)。`src/store/schema.rs`(`bootstrap_schema`)、`src/store/migrations.rs`(`changesets`)、
`src/store/types.rs`(`LINT_ISSUES_SQL`、`TOKENIZER_ID`)、`src/store/temporal_memory.rs`、`src/changeset.rs`
(`commit` / `discard`)、`src/store/content_search.rs`(`page_put`)、`src/cli/definitions.rs`、`src/mcp.rs`、
`src/tokenize.rs`、README、`docs/agent-workflow.md`、`skills/using-lwc/SKILL.md`。

**訂正**(前の版の候補リストと README の言い回しに対して): (1) "Node bindings" ではなく、npm パッケージは
checksum 付きのビルド済みバイナリを落とす launcher。(2) 「changeset は人間がレビューするまで見えない」と
書いたが、commit に**人間の門は無い** — README の "reviewed and validated" は agent が `changeset show` /
`lint` で見ることを指し、commit は agent が打つ。人間は「sources を選び、目的を述べ、問い、答えと投影された
Markdown をレビューする」役(README)。(3) 「読み取り専用 MCP」は厳密には違い、4 tool のうち `lwc_discussion` は
書く。page / source の書き込み経路が MCP に無い、が正確。

事実:

- **SQLite が正本、Markdown / FTS5 / graph は作り直せる投影**。rebuild は動詞として存在する: `materialize`
  (Markdown・index・log を店から再生成、追跡ファイルだけ置換)、`reindex`(FTS を transaction で消して再構築)、
  `compact`。graph 層(Grafeo / SurrealDB)は任意で、同じく再構築可能。
- **source は不変の snapshot**: `content_hash`(SHA-256)で UNIQUE、同一 bytes の再追加は既存 id を返す。
  `origin` はファイルパス。同じ path の再観測は新 source + `source_path_revisions` で系譜になり、`source status`
  が `current / superseded` と `modified / missing` を返す。URL や git commit からの取り込みは無い。
  `source remove` は「引用する page が無いときだけ」。
- **page は source を引用し、出所を宣言する**: `page_sources(page_slug, source_id)` + `page_provenance ∈
  {user-provided, agent-observed, hypothesis}`。lint `uncited_page`「引用も明示の出所も無い」は **Error で
  commit を止める**。既定 schema: "Never invent a source ID for non-source knowledge"。引用は page → source
  の粒度で、span / 引用文の記録は無い(未記載)。
- **changeset**: `.lwc/changesets/<name>.db` の疎な overlay(live を複製しない)。状態は `draft / committed /
  rolled_back` の3値。`commit` の検査は順に: 空 / store 不一致 / **touched entity の fingerprint が live で
  変わっていたら `changeset_conflict` で fail-closed** / DB 整合性 / lint の Error が1つでもあれば
  `changeset_lint_failed`(`--allow-lint-issues` で強行可)。commit は checksum 付きの逆 patch を書き、
  `rollback` は「後に live の書き込みが無いときだけ」復元。`discard` は draft ファイルを消し、中身は残らない。
  **changeset の外でも `page put` は直接書ける**(規約として「複数 entity の更新は changeset で」)。
- lint が見るのは構造だけ: `dangling_link`、`orphan_page`、`uncited_page`、`shallow_ingest`(取り込み完了なのに
  派生 page が無く理由も無い)。"Semantic contradictions and stale claims remain the Agent's responsibility"。
- **page に版は無い**: `page put` は in-place `UPDATE`、履歴は `operations` ログと changeset の逆 patch と
  checkpoint(backup)だけ。矛盾の表も無く、規約「黙って片方を選ばず矛盾を記録せよ」と任意の graph relation
  (`CONTRADICTS / SUPERSEDES`、`--provenance --source --reason --confidence` 付き)がある。
- **temporal memory は別系**(`lwc remember`): event は append-only、訂正は新 event + `supersedes /
  contradicts / resolves` の relation で表し、`resolves` の無い `contradicts` は `unresolved_conflict` として
  retention の削除から守られる。ただし「通常の期限切れ履歴は削除される」。
- **LWC 自体は LLM を呼ばない**("no built-in LLM calls")。page を書くのは外の agent で、ingest は queue
  (`ingest next` が最古の job を claim して不変 source + 有界の Wiki 文脈を返す → `analyze` → `complete` は
  「引用付き source 要約 + 引用付き非 source page、または派生 page 無しの明示理由」を要求)。
- **FTS5 は contentless で自前 tokenizer**(`cjk-bigram@1/bounded-terms`: CJK は隣接 bigram + 単字、Latin は
  小文字英数)。tokenizer id を `meta` に刻み、open 時に照合する。埋め込みは無い(非目標)。
- **MCP は 4 tool**(`lwc_explore(query, projectPath, mode, scope, maxDocuments ≤ 20, maxFiles ≤ 20)` /
  `lwc_codegraph` / `lwc_inspect` / `lwc_discussion`)。`lwc_explore` は合計 60,000 文字・page ごと 15,000 文字で
  切り、`truncated` フラグを返す。予算は文字数で token ではない。CLI 側は page-first の `search` →
  `span get / expand` で広げる。
- **feedback**: `weight set <page|source> --value {-2,-1,1,2} --reason --provenance` と `weight feedback --query
  --signal relevant|irrelevant`(query は 64 文字 fingerprint で保存、一致する候補だけ並べ替える)。規約
  "Never infer weights from clicks, rank position, page length, directory depth, or a single unverified answer"。
  temporal event には `memory feedback --signal useful|not-useful`。stale の欄は無い。
- README に LongMemEval-S の自己計測(Recall@5 95.11%、「untuned baseline、公式スコアではない」)。

借りる点:

- **rebuild を動詞にする**(`materialize` / `reindex`)。節9 の3段の派生(events → エントリ → 索引 → INDEX)を
  作り直す操作を管理MCP / settings に1つ置く。索引の版(tokenizer id)を店に刻んで open 時に照合する — 投影器の
  `extractor_version` と同じ流儀で、索引にも版を持たせる。
- **書き込み時の整合性検査を Error にして止める**(`uncited_page`)。Knowledge の書き込み tool は出所の無い
  エントリを**拒否**する(決定2「出所必須」の機械版)。承認 question の登録検査(節4・節9)も同じ位置。
- **同一 entity の revision 衝突は fail-closed**(`changeset_conflict`)。承認 question は置換する各 approved
  エントリの版(承認 event id)を持ち、人間が承認した瞬間にそのどれかが無効化・置換されていれば承認を失敗
  させて question を作り直す。「承認は文言に対して」(決定4)を版で守る。
- **「派生 page 無し」に明示理由を要求する**(`no_derived_pages_reason`)。RCA が candidate を書かない場合
  (帰責が `requirement_change` / `environment`)は理由 = cause が既にあり、meta-review が candidate を退ける
  場合の理由コード(節8)と同じ流儀。
- **機械は構造、意味は agent**という分担の明文化。tidepool も lint 相当(出所・宛先・path・版)は盤面、矛盾と
  陳腐化の判断は meta-review / 人間。
- **CJK の tokenizer**。tidepool の Knowledge / Behavior は日本語で書かれうる(UI コピーは日本語、agent 向け
  テキストは英語)。SQLite FTS5 の既定 `unicode61` は CJK を分かち書きしないので、組み込みの `trigram` tokenizer
  か LWC 式の bigram 前処理が要る。**#357 で実測して決める**(どちらも一次資料で tidepool 相当の文で試して
  いない)。
- **fingerprint で保存する query**(生の query を持たない)は、pull の記録(節11)に task 本文が写るのを避ける
  選択肢として覚えておく。ただし tidepool は「記憶が間違っていた vs 見つからなかった」の再実行(節11)に生の
  query が要るので、既定は生で持つ。

借りない点:

- **commit に人間の門が無い** — Behavior は人間承認(決定3)。LWC の changeset は「agent の作業単位の原子性」で
  あって承認ではなく、tidepool の candidate はそれとは別に**状態**として存在する。
- **page の in-place UPDATE、履歴無し、discard で消える、期限切れ event の削除** — 決定5(削除は無く無効化のみ)、
  決定4(approved は不変)。tidepool の changeset に当たるものは events で、破棄された提案も event として残る。
- **changeset の外の直接書き込み** — tidepool に「規約として changeset を使え」という道は無く、Knowledge の
  追加 tool と承認 question の2経路しか無い。
- **手動の retrieval weight(−2〜2)と relevant / irrelevant の自己申告** — 決定7・決定9。tidepool の並べ替え
  信号は Displayed / 異議 / 帰責からの機械導出だけ(節7 の対応表)。
- **agent が Wiki page を LLM で合成する**形 — tidepool の Knowledge は事実の1件で、合成は meta-review の
  仕事(合成要約は観測されてから — 追記3)。
- 出所の3値(`user-provided / agent-observed / hypothesis`)をそのまま — tidepool は出所の**種別**を参照先の
  型(commit / event id = 事実、decision = 推論)から導く(追記3)。`hypothesis` に当たる「出所の無い推論」は
  Knowledge として書けない(出所必須)。

### tidepool での当てはめ

| 種別 × 状態 | 読み口 | 借りたもの |
| --- | --- | --- |
| Knowledge candidate → approved | worker の書き込み tool | 出所の無い書き込みは拒否(lint Error の位置)。索引の版を店に刻む |
| Behavior candidate → approved / approved の統合 | 承認 question | 置換対象の版を question に焼き、承認時に fail-closed。退けた candidate に理由コード |
| Knowledge / Behavior approved | 索引(FTS) | CJK tokenizer の要否を #357 で実測。rebuild は1動詞 |
| 同上 | MCP pull | 文字数ではなく token で切り、切ったことをフラグで返す(`truncated`)|
| Precedent | — | 該当なし(LWC の temporal memory は agent の自己申告の event で、投影ではない) |

## 11. retrieval 評価に要る事実(#357 の events 設計が読む節)

ADR 0083 決定11「評価に要る事実(引いた前例が使われた率、異議率への影響)を最初から events に載せる」の
列挙。窓と outcome の定義は `docs/learner-reference-design.md` と共有し、第2の定義を作らない: session の窓は
「spawn より後、exit または次の spawn より前」、異議は帰責で条件づけ(`preference` / `requirement_change` /
`environment` は負に数えない — ADR 0115 決定5)、分母は Displayed(決定7)。

### 既にある事実

| 事実 | 出所 |
| --- | --- |
| decision が表示された | `log_entry_displayed`(entry_id) |
| decision への異議とその帰責 | `objection_raised`(entry_id, comment)、`objection_attributed`(cause, round) |
| decision の位置と行動列 | Precedent(`decision` マーカーの `position`、`actions`)|
| session の実行設定・agent 版 | `worker_spawned`(provider / model / effort / advisor / registry_commit / source) |
| session の消費 | `worker_exited.usage` |
| 配分評価 | `allocation_reviewed` |
| 受理 | `task_completed` + 統合点レビュー(`acceptedSql`)|

### 足す事実(すべて events、エントリの列にしない)

1. **spawn 時の注入記録**(追記3 の memory 観測列): ストアの snapshot 識別子(memory 系 event の watermark)、
   注入した entry id とその版(承認 event id)、注入した INDEX の深さ、注入トークン数。「注入されたが読まれ
   ていない」と「pull で読んだ」を分けるため、注入と pull は別の記録。
2. **pull の記録**(worker の MCP tool 呼び出しごと): 動詞(ls / search / read)、query または prefix、
   返した entry id の列、snapshot 識別子。search は**候補と落ちた理由**まで(OpenViking の `ThinkingTrace`
   相当: 関連度で切った / 宛先で外れた / 無効化済み / 上限で溢れた)。tool_result に写る entry id が
   Episode との結合キーになる(節8)。
3. **「従った」の機械記録**: 自己申告の列は作らない。Precedent の行動列で decision マーカー D より前に
   ある pull / read の行動行が持つ entry id の集合が「D が読めた記憶」。注入分は 1. の記録で D 以前に確定
   している。
4. **記憶の変更の events**: 作成(種別 / path / 出所 / 出所の種別 / 宛先 / 書き手)、承認(question id)、
   無効化(理由コードと根拠の event id。語彙は #357 で決める — 節7 の対応表のとおり帰責の cause に写せる
   ものは cause の語彙を使い、置換と path の付け替えは別の値)。これで snapshot の再生と
   統合前後の差分(節8)が出る。
5. **統合提案の登録拒否**(整合性検査の失敗、節9)と、meta-review が退けた candidate の理由コード。

### この事実から出る問い

- **引いた記憶が使われた率**: 注入 / pull された entry のうち、D 以前に読まれた(3.)ものの割合。entry ごと・
  session ごと。注入されただけの entry は分子に入れない(ai-memory の "retrieved content never authorizes
  feedback" に対応する線)。
- **異議率への影響**: D の集合を「記憶を読んだ / 読んでいない」で割り、Displayed を分母に、帰責で条件づけた
  異議率を比べる。entry ごとには「その entry を読んだ D の異議率」が無効化候補の入力(節7 の対応表)。
- **記憶が間違っていた vs 見つからなかった**(OpenViking に無かった区別を tidepool で定義する):
  異議された D について、(a) D 以前に読んだ entry があり `capability` の帰責 → 記憶が間違っていた候補、
  (b) 読んだ entry が無く、snapshot 識別子の時点の approved 集合に対して task の要求で search を**再実行**して
  関連 entry が出る → 見つからなかった(注入 / pull の失敗)、(c) 再実行しても出ない → 記憶に無かった
  (Knowledge / Behavior の候補起草の入力)。(b) が snapshot 識別子の存在理由で、事後に同じ条件で検索を
  再現できなければ (a) と (b) は分けられない。
- **注入のコスト**: 1. のトークン数と `worker_exited.usage` の比。上限の盤面設定を動かす根拠。
- **agent.md が育つ速さ**(決定12 の指標): registry の commit 履歴から出る(`registry_commit` の変化)。
  events には足さない。

## 探索中に見つけた候補(名前と1行だけ)

- MemPalace — Munder Difflin が索引に使う CLI(`mempalace mine / search / wake-up`)。Chroma 上の派生索引。
- Sleep-time compute(arXiv 2504.13171)— Letta が dreaming の名で製品化した論文。
- `@letta-ai/memfs-search` / QMD — MemFS に後付けする keyword / semantic 検索 mod。
- Zep 論文(arXiv 2501.13956)— Graphiti の bi-temporal と reranker の説明はこちらが一次資料。
- Funes(https://github.com/huggingface/funes 、Rust、Apache-2.0)— Claude Code / Codex の transcript JSONL を
  逐語のまま Lance に入れ BM25 + vector で引く。LLM 不要、agent / session / turn まで遡れる。「transcript 自体を
  agent に検索させる」点が Precedent 投影と違い、#357 の「worker が Precedent を pull できるか」の比較対象。
- Firekeep(https://github.com/kapella-hub/FirekeepHQ 、Python + Neo4j / Qdrant / Redis、BUSL-1.1)— 記憶の
  read / write をすべて構造化 trace に、skill / procedure は人間レビュー後に有効化、対立する記憶は両論を並べる。
  ライセンスとスタックで依存は不可、設計参照のみ。
- Hindsight(https://github.com/vectorize-io/hindsight 、MIT、Postgres + pgvector / 組み込み pg0、論文 arXiv
  2512.12818)— world facts / experiences / observations / mental models を分け、observation は根拠の逐語引用と
  proof count を持つ。「出所の種別 = 事実 / 推論」の参照先として節3 に並べられる。retain は LLM 抽出。
- 論文のみ: Eywa(arXiv 2605.30771、不変の証拠を先に保存して事実を派生)、MemRepair(arXiv 2605.17444、検証
  失敗を捨てずに第一級の書き込みに — 決定7 と同じ向き)。設計エッセイ hidekazu-konishi.com「AI Agent Memory
  Design Guide」は procedure の `status: candidate | active | deprecated` に独立に到達している(語彙の参照のみ)。

## 触らない線

- 依存を1つも足さない(決定11)。AGPLv3 の OpenViking は設計参照のみ。
- 種別は Knowledge / Behavior / Precedent、状態は2値。OSS の tier / type / salience / confidence は持ち込まない。
- 数値のノブ(減衰、閾値、加減算)は設定にも定数にも置かない。置くのは RRF の k = 60 と、削り順のような
  **順序**だけ。
- 取り込みは盤面側の後処理、投影は決定論。LLM が書くのは meta-review / RCA の task の中だけ。
- 記憶の変更はすべて events。エントリに時刻・回数・重みの列を持たせない。
- 決めていないこと(#357 / #358 で決める): worker が Precedent(自分や他 agent の Episode)を pull できる
  か / Knowledge の統合の書き手 / Knowledge 書き込み tool に載る秘密の扱い / pull の search が候補と落ちた
  理由をどこまで返すか。
