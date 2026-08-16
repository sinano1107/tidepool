# AI エージェント長期記憶 OSS の調査(2026-08-16 時点)

ADR 0083(長期記憶)の grilling で行った調査の記録。結論(自前ストア + 設計は OSS を参照)は ADR 側にあり、
この doc は**事実の一覧**として残す — 次に記憶層を見直すとき、同じ調査をやり直さないため。
事実はすべて 2026-08-16 に GitHub API / README / 公式 docs から取った。「未記載」= 一次資料が見つからなかった。
星の数・版・最終リリースは調査日時点の値で、すぐ古くなる。

## 前提修正(調査前の思い込みが4つ古かった)

1. **mem0 の OpenMemory MCP はもう無い。** 2026-07-29 に monorepo から削除(https://github.com/mem0ai/mem0/commit/ea2ee075)。
   mem0 の MCP は**ホスト版のみ**(`https://mcp.mem0.ai/mcp`、Platform API key 必須)。graph memory も v2.0.0(2026-04-16)で
   OSS から外れ Platform 限定になった。
2. **Letta は再編された。** `letta-ai/letta` はランディングページで、V1 の Python サーバは非サポートの `archive` ブランチ。
   実体は `letta-ai/letta-code` — **TypeScript**、ファイル + git 保存、公式 MCP サーバなし。
3. **Zep Community Edition は廃止**(コードは `legacy/` へ)。Zep は Cloud / BYOC のみ
   (https://blog.getzep.com/announcing-a-new-direction-for-zeps-open-source-strategy/)。
4. **semantica の Claude Code plugin は `plugins/.claude-plugin/`** にあり、中身は `plugin.json` + 共有の
   `plugins/skills/`(17 個の SKILL.md: causal, change, decision, deduplicate, embed, explain, export, extract, ingest,
   ontology, policy, provenance, query, reason, temporal, validate, visualize)+ `plugins/agents/`(decision-advisor,
   explainability, kg-assistant)+ hooks(構文チェック)。**`.mcp.json` は無く**、MCP は別配線(`claude mcp add semantica python -m mcp`)。

## プロジェクト別メモ

**semantica**(https://github.com/semantica-agi/semantica)— Python ≥3.8、MIT、8.1k★、v0.6.5(2026-08-11)。依存は重い
(torch / transformers / spacy / faiss)。保存: in-memory networkx の `ContextGraph` を JSON へ永続化(`SEMANTICA_KG_PATH`)、
vector store は faiss / qdrant / weaviate / milvus / pinecone / pgvector / sqlite-vec / inmemory、RDF は埋め込み Oxigraph、任意で
Neo4j / FalkorDB / AGE / Neptune、`ProvenanceManager(storage_path="./audit.db")`。外部 DB なし単一プロセス: 可。
**既定で LLM 不要**(spaCy / transformer 抽出。LLM は extras)。MCP: **stdio のみ2本、HTTP/SSE 無し** — 配布物の
`semantica-mcp`(12 tool: `extract_entities, extract_relations, record_decision, query_decisions, find_precedents,
get_causal_chain, add_entity, add_relationship, run_reasoning, get_graph_analytics, export_graph, get_graph_summary`)と
repo ルートの `mcp/`(17 tool、`extract_all, analyze_decision_impact, search_graph, abductive_reasoning, get_provenance` を追加。
**wheel に入っていない**)— https://raw.githubusercontent.com/semantica-agi/semantica/main/mcp/README.md。
**記憶形(store / search)の tool は無く**、graph はプロセス単一の singleton。スコープ: `AgentContext.store(conversation_id, user_id)`
は**分離ではなく metadata filter**、agent_id / namespace 無し。書き込み: 明示(`store`, `record_decision`, `add_entity`)。
検索: vector + keyword + graph 走査 + **bi-temporal**(`BiTemporalFact`, `state_at()`, Allen 区間)。来歴: W3C PROV-O
(`track_entity(source=...)`, `get_lineage`)、判断は graph ノード、`get_provenance` tool。人間 UI: Knowledge Explorer
(`semantica-explorer`, :5174)— graph / 判断の閲覧であり、記憶エントリのキュレーションではない。TS SDK: 無し。

**mem0**(https://github.com/mem0ai/mem0)— Python + TS SDK、Apache-2.0、63k★、Python v2.0.18 / TS `ts-v3.1.6`(2026-08-11)。
Python 既定: 埋め込み Qdrant(`/tmp/qdrant`)+ SQLite 履歴 `~/.mem0/history.db` → 外部 DB なし可、ただし**既定で OpenAI の
LLM + embedder 必須**(`gpt-5-mini`, `text-embedding-3-small`; anthropic / ollama 等に差し替え可)。MCP: ホスト版のみ
(`add_memory, search_memories, get_memories, get_memory, update_memory, delete_memory, delete_all_memories, delete_entities,
list_entities, list_events, get_event_status` — https://docs.mem0.ai/platform/mem0-mcp)。スコープ: `user_id / agent_id / run_id`
+ `actor_id` がネイティブ。書き込み: LLM 抽出(`infer=True`)または**逐語 `infer=False`**。検索: vector + BM25 ハイブリッド +
entity boost。graph 無し、bi-temporal 無し。来歴: payload に `hash, created_at, updated_at, actor_id, role, metadata` —
**元メッセージ / event id の組み込みは無し**(metadata に自前で載せる)。記憶ごとの履歴テーブル(old / new / event)。
キュレーション UI: self-host の `server/` dashboard(FastAPI + Next.js、Postgres / pgvector 必要)。**TS OSS SDK** `mem0ai/oss`
(npm 3.1.6): 既定 vector store `memory` を better-sqlite3 で永続化、履歴 SQLite、25+ vector store、`infer` フラグ、graph 無し —
https://raw.githubusercontent.com/mem0ai/mem0/main/mem0-ts/src/oss/src/config/defaults.ts。

**Letta(letta-code)**(https://github.com/letta-ai/letta-code)— TypeScript / Node 22+、Apache-2.0、3.0k★(旧 `letta` は
24k★でアーカイブ)、v0.30.23(2026-08-16)。保存: ローカル backend `~/.letta/lc-local-backend` = JSON / JSONL、記憶 = agent ごとの
**Markdown の git repo(MemFS)**(https://docs.letta.com/concepts/memfs/index.md)。DB なし、LLM 既定なし(`/connect` で任意)、
**既定で vector index なし**(任意 mod `@letta-ai/memfs-search`)。MCP: **公式サーバなし**(Letta は MCP client)。コミュニティ
`oculairmedia/Letta-MCP-server` は V1 / Cloud REST のラッパ。スコープ: agent 単位(ファイルシステム sandbox)+ 会話単位。
user / namespace のプリミティブ無し。書き込み: agent の tool `memory`(str_replace / insert / delete / rename / create + `reason`)、
`memory_apply_patch / insert / replace / rethink`、書き込みごとに git commit、背景の "dreaming" 統合。検索: prompt 内の file tree +
grep / read。graph / temporal 無し。来歴: git 履歴 + tool の `reason`、fact 単位の source id 無し。人間: Markdown を直接編集、
desktop app の memory viewer。TS SDK: `@letta-ai/letta-agent-sdk` 0.7.1、`@letta-ai/letta-client` 1.12.1。

**Graphiti**(https://github.com/getzep/graphiti)— Python ≥3.10、Apache-2.0、30k★、v0.29.3(2026-07-27)。保存: Neo4j /
FalkorDB / Neptune / Kuzu(非推奨)。**埋め込み FalkorDB Lite はライブラリでは動く**(`graphiti-core[falkordblite]`、Py 3.12+)が、
**MCP サーバはネットワーク上の neo4j | falkordb のみ**。既定で OpenAI 必須(`gpt-5.5`, `text-embedding-3-small`)、抽出に LLM 必須。
MCP(`mcp_server/`、HTTP :8000/mcp または stdio): `add_memory, add_triplet, search_nodes, search_memory_facts, summarize_saga,
build_communities, get_episode_entities, delete_entity_edge, delete_episode, get_entity_edge, get_episodes, clear_graph, get_status`。
スコープ: 全 episode / node / edge に `group_id`。user / session は無し(自前で組む)。書き込み: episode からの LLM 抽出 + 明示
`add_triplet`。検索: semantic + BM25 + graph BFS のハイブリッド、**bi-temporal**(`valid_at / invalid_at / expired_at`、削除ではなく
無効化)。来歴: `EntityEdge.episodes` = 元 episode UUID、`remove_episode` はカスケード。監査ログ・UI 無し(Neo4j Browser / FalkorDB UI)。
TS SDK 無し(MCP / REST のみ)。

**Zep Cloud** — ホスト / BYOC、独自 graph engine。MCP `https://api.getzep.com/mcp`(OAuth 2.1): `search_graph, get_user_summary,
get_subgraph, get_node_neighbors, list_episodes, add_memory` + `*_in` / `list_graphs` の standalone graph 変種。対象は認証 identity で
固定(https://help.getzep.com/memory-mcp-server.md)。users / threads / graphs、ABAC / RBAC がネイティブ。LLM 抽出、明示
`add_fact_triple`。bi-temporal、episode は逐語保存し fact は episode に紐づく、node / edge の update / delete API、enterprise の
監査ログ、dashboard の graph 可視化。TS SDK `@getzep/zep-cloud` 3.28.0。

**cognee**(https://github.com/topoteretes/cognee)— Python 3.10–3.14(+ Rust crate、TS bindings)、Apache-2.0、30k★、v1.5.0
(2026-08-15)。既定 **SQLite + LanceDB + Kuzu の全ローカルファイル** → 外部 DB なし可。既定 LLM + embeddings は OpenAI(`gpt-5-mini`,
`text-embedding-3-large`)、MCP は `LLM_PROVIDER=mcp-sampling` 可。MCP(`cognee-mcp/`、stdio / SSE / HTTP): 登録 tool は
`remember, recall, forget`(+ `visualize_graph_ui, upload_file_ui, open_cognee_workspace, list_datasets_json,
list_dataset_data_json, get_client_info_json, create_dataset_json`)。旧 `cognify / search / prune / delete` は未登録。スコープ:
datasets + users / tenants / roles がネイティブ、`ENABLE_BACKEND_ACCESS_CONTROL=true` で user + dataset ごとに graph / vector DB を
物理分離、`session_id` cache。書き込み: `remember` = add + cognify(LLM)または session cache(抽出なし)。検索: vector + graph
ハイブリッド、temporal は抽出した timestamp 経由(bi-temporal ではない)。来歴: 元ファイルへの `mentions` edge、provenance API /
可視化(https://docs.cognee.ai/guides/memory-provenance)、soft / hard delete、UI は `cognee-cli -ui`。**TS**: `@cognee/cognee-ts` 0.2.0
(cognee-rs への Neon bindings、ローカル runtime)。

**LangMem**(https://github.com/langchain-ai/langmem)— Python ライブラリ(in-process、サーバではない)、MIT、1.6k★、PyPI 0.0.30
(2025-10-27)、MCP 無し。保存 = LangGraph `BaseStore`(InMemory / Postgres / SQLite)。namespace tuple でスコープ。書き込み:
`manage_memory` / `search_memory` tool + 背景 LLM 抽出(LangChain の任意モデル)。vector のみ。来歴 = created_at / namespace / key、
source id 無し、UI 無し。JS 版無し(LangGraph.js に SQLite store 無し)。

**agentmemory**(https://github.com/rohitg00/agentmemory)— TypeScript、Apache-2.0、27k★、v0.9.28(2026-07-19)。full mode =
Node + pin された Rust `iii-engine` バイナリ(SQLite `state_store.db` + in-memory vector index)、standalone MCP mode = 単一プロセス、
JSON ファイル。**LLM 不要**(BM25、任意でローカル MiniLM 埋め込み)。MCP: 既定 54 tool。core 層 `memory_save, memory_recall,
memory_consolidate, memory_smart_search, memory_sessions, memory_diagnose, memory_lesson_save, memory_reflect`、他に `memory_audit,
memory_governance_delete, memory_verify, memory_timeline, memory_graph_query…`。スコープ: `project`、`TEAM_ID / USER_ID / AGENT_ID`、
`AGENTMEMORY_AGENT_SCOPE=shared|isolated`、リクエストごとの `agentId`。書き込み: 主に Claude Code の hook 12 本による自動 + 明示
`memory_save`。検索: BM25 + vector + graph の RRF、timeline、decay。bi-temporal 無し。来歴: 観測ごとの不変 origin channel、
`memory_verify` が元観測を引用、`memory_audit`、governance delete、git snapshot。viewer UI :3113。TS ネイティブ、REST :3111。

**Anthropic memory tool**(`memory_20250818`、GA — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)—
client 側のファイル tool(`/memories` 配下の `view / create / str_replace / insert / delete / rename`)。**保存・スコープ・来歴は自前実装**。
TS: `@anthropic-ai/sdk` の `betaMemoryTool` + `BetaLocalFilesystemMemoryTool`。MCP ではない。Managed Agents の `/v1/memory_stores`
(beta)は不変の `memory_versions` を持つ — Anthropic 側で監査が組み込みなのはこれだけ。**Claude Code auto-memory**
(https://code.claude.com/docs/en/memory): `~/.claude/projects/<proj>/memory/MEMORY.md` + トピックファイル、git repo 単位、agent が
Write / Edit で書く、人間は `/memory`。来歴は frontmatter の `modified` のみ。無効化は `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`。
Agent SDK は `settingSources` に関わらず読み込む。

**その他の MCP サーバ**: `@modelcontextprotocol/server-memory`(TS、JSONL ファイル、MIT。tool `create_entities, create_relations,
add_observations, delete_entities, delete_observations, delete_relations, read_graph, search_nodes, open_nodes`。namespace / 来歴
無し。npm 2026.7.4)。`mcp-memory-service`(Python、sqlite-vec 既定、Apache-2.0、v11.8.0 2026-08-09。**https://codeberg.org/doobidoo/mcp-memory-service
へ移転**、GitHub は 404 で星は確認不能。tag スコープ、`X-Agent-ID` 自動 tag、dashboard :8000)。`basic-memory`(Python、Markdown +
SQLite index、AGPL-3.0、3.7k★、v0.22.1。multi-project、note tool)。`claude-mem`(TS の Claude Code plugin、SQLite + Chroma、
Apache-2.0、91k★、v13.15.0 2026-08-10。hook で取り込み、MCP `search, timeline, get_observations`、project 単位、web viewer)。

## 比較表

| Project | Lang | Storage / no-ext-DB | License · stars · last rel | MCP server / tools | Scoping | Write model | Retrieval | Provenance / human curation | TS |
|---|---|---|---|---|---|---|---|---|---|
| semantica | Py | networkx+JSON, faiss/sqlite-vec · **Y**, no LLM needed | MIT · 8.1k · 0.6.5 08-11 | stdio only; graph/decision tools, **no add/search memory** | metadata filters only | explicit | vec+kw+graph+**bi-temporal** | PROV-O lineage, `get_provenance`; Explorer UI (graph, not curation) | none |
| mem0 | Py+TS | Qdrant-embedded+SQLite (Py) / better-sqlite3 (TS) · **Y**; OpenAI default | Apache · 63k · 08-11 | **hosted only** (11 tools) | user/agent/run/actor native | LLM extract or `infer=False` | vec+BM25 | history table; **no source id**; dashboard (needs Postgres) | **Y** (`mem0ai/oss`) |
| Letta (letta-code) | TS | Markdown+git files · **Y**, no LLM default, no vector idx | Apache · 3.0k · 0.30.23 08-16 | **none official** | per-agent, per-conversation | agent tools (git commit each) + dreaming | file read/grep | git history; edit files, desktop viewer | **Y** |
| Graphiti | Py | Neo4j/FalkorDB(+Lite embedded, lib only); OpenAI default | Apache · 30k · 0.29.3 07-27 | HTTP/stdio, 13 tools; **needs networked DB** | `group_id` | LLM extract + `add_triplet` | hybrid+graph+**bi-temporal** | edge→episode UUIDs; delete APIs; no UI/audit | none |
| Zep Cloud | hosted | proprietary · N | SaaS · CE dead | hosted, 12 tools | users/threads/graphs native | LLM extract + triples | hybrid+bi-temporal | episodes verbatim, node/edge edit, audit (ent.), dashboard | **Y** |
| cognee | Py(+Rust/TS) | SQLite+LanceDB+Kuzu · **Y**; OpenAI default | Apache · 30k · 1.5.0 08-15 | stdio/SSE/HTTP; `remember/recall/forget` | datasets+users/tenants, isolated DBs | LLM cognify or session cache | vec+graph, temporal (not bi) | mentions→source file, provenance API; CLI UI | **Y** (`@cognee/cognee-ts`) |
| LangMem | Py lib | LangGraph store (SQLite ok) · Y in-process | MIT · 1.6k · 0.0.30 2025-10 | **none** | namespace tuples | tools + LLM extraction | vector | none; no UI | none |
| agentmemory | TS(+Rust) | SQLite+in-mem vec / JSON standalone · **Y**, no LLM | Apache · 27k · 0.9.28 07-19 | 54 tools (`memory_save/recall/audit/verify…`) | project/team/user/agent, isolated mode | hooks auto + explicit | BM25+vec+graph RRF | origin channel, `memory_verify`, `memory_audit`; viewer UI | **Y** |
| Anthropic memory tool | any | your storage · Y | API tool | not MCP | yours | agent file edits | none | yours | **Y** (SDK helper) |
| CC auto-memory | — | Markdown files per repo | built-in | no | per project | agent Write/Edit | file read | `modified` only; `/memory` | Agent SDK |
| server-memory | TS | JSONL · Y | MIT · monorepo 90k · 2026.7 | 9 KG tools | none (1 file) | explicit | search_nodes | none | **Y** |
| mcp-memory-service | Py | sqlite-vec · Y | Apache · n/a (Codeberg) · 11.8.0 08-09 | yes | tags/agent-id | explicit+hooks | vec | dashboard | none |
| basic-memory | Py | Markdown+SQLite · Y | AGPL · 3.7k · 0.22.1 06-13 | yes, note tools | projects | explicit | search | git-friendly files | none |
| claude-mem | TS | SQLite+Chroma · Y | Apache · 91k · 13.15 08-10 | `search/timeline/get_observations` | per project | hooks auto | hybrid | viewer UI | **Y** |

## tidepool の制約に対する適合(選定ではなく事実の整理)

制約: ホストは TS 単一プロセス / worker は MCP で tool に届く Claude Code セッション / (workspace, agent) でスコープ /
すべての記憶が元イベントに遡れる / 人間がレビュー・キュレーションできる / Mac・Linux サーバ(Pi ではない)。

- **TS 単一プロセス**: TS ネイティブ + 埋め込み保存は mem0 `mem0ai/oss`(better-sqlite3、`infer=false`)、agentmemory、letta-code、
  cognee-ts(Rust bindings)、server-memory、claude-mem。Python のみ(semantica、Graphiti、LangMem、cognee-py、basic-memory、
  mcp-memory-service)は subprocess / MCP / REST 経由。semantica の MCP は stdio のみなので worker ごとの子プロセスか自前ブリッジになる。
- **worker が MCP で届く**: store + search の MCP を同梱するのは Graphiti(ネットワーク DB 必須)、cognee、agentmemory、
  mcp-memory-service、basic-memory、server-memory、mem0(ホスト版のみ)。MCP 無し: Letta、LangMem、Anthropic memory tool。
  semantica の MCP tool は graph / 判断形(`add_entity`, `record_decision`, `search_graph`)で記憶形ではなく、記憶形の tool 面は
  ホスト側で作る必要がある。
- **(workspace, agent) スコープがネイティブ**: mem0(`user_id` + `agent_id`)、cognee(tenant / user / dataset、物理分離)、
  agentmemory(project + agentId、isolated mode)、Zep(users / graphs)、Graphiti(`group_id` 1次元のみ、key を合成)、Letta(agent のみ)。
  semantica は singleton graph 上の metadata filter で分離保証なし。LangMem は namespace 規約。server-memory / CC auto-memory は無し。
- **元イベントへの遡及**: 組み込みが強いのは Graphiti / Zep(fact → episode UUID、bi-temporal)、agentmemory(origin channel +
  `memory_verify` の引用)、semantica(PROV-O lineage、`source`)、cognee(`mentions` → 元ファイル)、Managed Agents の memory_versions。
  弱い / 無い: mem0(編集履歴はあるが source id 無し — metadata に載せる)、Letta(git commit + `reason`、message id 無し)、LangMem、
  server-memory、CC auto-memory。
- **人間のレビュー / キュレーション**: UI があるのは mem0(dashboard、Postgres 必要)、agentmemory(:3113 viewer、audit + governance
  delete)、cognee(CLI UI)、mcp-memory-service(dashboard)、semantica(Knowledge Explorer — graph / 判断の閲覧で、記憶単位の
  キュレーションではない)、Zep(dashboard、API で編集)。ファイル系(Letta MemFS、basic-memory、CC auto-memory)は Markdown + git で
  設計上人間が編集できる。Graphiti / server-memory は API / DB のみ。
- **Mac / Linux サーバ**: semantica の torch / transformers、cognee の LanceDB / Kuzu のサイズ懸念が消える。全候補が macOS / Linux
  x86 / arm64 で動く。agentmemory だけ pin された Rust バイナリを同梱、Graphiti MCP は FalkorDB / Neo4j プロセスが隣に要る。
- **書き込みの LLM 依存**: LLM 不要 — semantica、agentmemory、Letta、server-memory、mem0(`infer=false`)。抽出に LLM 必須 —
  Graphiti、cognee(session 無しの `remember`)、LangMem 背景、mem0 既定(OpenAI。anthropic も可)。
- **semantica の位置**: bi-temporal fact + PROV-O 来歴 + LLM 不要抽出を外部 DB なしの1プロセスに持つ唯一の Python 候補。
  ただし出荷状態では agent / workspace の分離、記憶形の MCP tool、HTTP MCP、TS パッケージが無く、Claude Code plugin は
  skills / agents / hooks のみ。

## この調査からの帰結(ADR 0083)

固有部分(承認状態・events への出所・スコープ)はどの OSS も持たず、検索は薄い。よって依存には入れず、盤面の SQLite に自前で
持ち、**設計だけを借りる**: retrieval スコア(relevance × recency × importance — Generative Agents 系、agentmemory の decay)、
注入の2層(Letta / MemGPT の core / archival)、事実の時間性と出所(Graphiti の episode → fact edge と `valid_at / invalid_at`、
semantica の PROV-O)、統合(Letta の dreaming、agentmemory の consolidate / reflect、claude-mem の観測 → 要約)。参照設計の集約は
issue #355。制約に最も近かったのは agentmemory(TS、来歴 / 監査、スコープ。ただし hook 前提の取り込み)と cognee(分離 dataset、
来歴、HTTP MCP。ただし既定は LLM 抽出)で、どちらも fit は 6〜7割。
