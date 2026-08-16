# 記憶は記録の派生索引であり、承認状態を持ち、外部の記憶ライブラリは入れない

2026-08-16〜17 の grilling(長期記憶)で決定。出発点は「agent が"社員"ではなく"文房具"になっており、
改善の手段が agent への指示文の逐一修正 = prompt engineering しかない」という痛みである。これは非技術者が
片手間にできる作業ではない。したがって長期記憶の主目標は **人間が prompt を書かずに agent が育つこと**
であり、記憶の retrieval はその手段(meta-review が読む材料)であって目的ではない。Condensation
(CONTEXT.md「Swell / Condensation」)は構想だけあり、v1 では meta-review は手動登録タスクにとどまっていた。

## 決定

1. **Memory(記憶)は盤面の記録 — events と worker transcript — から派生した索引であり、新しい知識源ではない。**
   記録に無いことは記憶にも無い。ADR 0045 の「生きた記憶は存在せず、親の知識は記録が全て」は維持される —
   worker が引くのは過去の**記録**であって過去の**セッション**ではない。
2. **種別は Knowledge(事実。承認不要、出所必須)と Behavior(振る舞い。承認必須)の2つ。** Precedent
   (過去の判断 + outcome + 機械観測された行動列)は記録からの投影であり、Behavior を起草するときの材料。
   検討中の案では Knowledge / Experience / Judgment / Human Review の4種を立てていたが、人間のレビュー結果は独立種では
   なく Precedent の属性(outcome の一部)であり、Experience と Judgment は Behavior に畳む。
3. **承認の線は「どのファイルに住むか」ではなく「記憶エントリの状態」に引く。** エントリは `candidate` /
   `approved` を持ち、worker に注入・retrieval されるのは approved のみ。承認は condensation の question
   (人間承認)を通る。これにより「振る舞いの変更は人間承認」(overview の Condensation の線)を守りながら、
   蒸留された振る舞いを agent.md や workspace の CLAUDE.md へベタ書きして肥大させずに済む — 記憶は
   コンパクトに保ち、関連分だけを注入する(トークンと性能のコスパが線引きの理由)。
4. **承認は文言に対して行う。** approved エントリは不変で、統合(consolidation)で書き換えるときは統合後の
   1件を新たな承認 question として出す(承認の陳腐化を防ぐ。頻度は meta-review の周期に束ねる)。
5. **削除は無く、無効化のみ**(bi-temporal: もう真ではない、の追記)。**すべてのエントリは event id または
   commit に遡れる。記憶は決裁権を広げない** — 記憶を読んで変わるのは権限内判断の質だけで、位置づけは
   advisor と同じ(CONTEXT.md「Advisor」)。
6. **スコープは workspace(+盤面全体の少数)。agent ごとに隔離した記憶は作らない** — 同じ workspace の事実を
   agent ごとに再発見するのは無駄。Precedent は (workspace, agent) で引け、各 episode に当時の agent 定義の
   commit hash を刻む(RCA が当時版を証拠に読む ADR 0020 と同じ理由)。
7. **学習の入力は異議(objection)と完了エントリへの異議だけ**(風呂敷を広げない)。正の信号は「表示済み・
   異議なし」から機械導出する(Displayed イベントが分母)。自己申告は混ぜない — write-path 統計純度の線。
8. **Precedent には `decision_logged` に紐づく機械観測の行動列を含める** — worker transcript
   (`stream.jsonl`、盤面側にあり worker は読めない)から抽出した tool 名・触ったパス・実行コマンド・トークン。
   「言ったこと」と「やったこと」の照合はここで行う。これが「decision log は agent の自己申告である」問題への
   tidepool 流の答えであり、semantica の `record_decision` も申告 API である以上、外部ライブラリでは解けない。
   v1 の抽出は生のまま(決定論的処理、LLM 不要)、意味付けは meta-review の仕事。
9. **数値閾値は使わない。** 「1回のレビューから恒久ルールを作らない」を守る手段は3段 — 異議ごとに既存の
   fix-forward RCA(review layer 2)が **candidate** を書く / 周期的な meta-review(盤面設定、既定は週次)が
   candidate 群を読み繰り返しの有無を**判断で**見て approved 提案を起草する / 最終ガードは人間承認。閾値は
   曖昧で最適化が難しく、採用したくない。人間の明示指示(「今後は常に X」)は権限者の発言なので1回で候補化
   してよいが、書き手は AI なので承認 question は経由する。新しいトリガは周期の1つだけ。
10. **読み書き**: spawn 時に approved を relevance で注入(トークン上限、盤面設定)+ worker が MCP tool で
    pull。引いた記憶とそれに従った事実は decision log に機械記録する(advisor 相談の記録と同型)。Precedent は
    盤面が投影し agent は書かない。Knowledge は worker の明示 tool と人間が書く。
11. **実装は盤面の SQLite に自前(FTS + 埋め込み、TS 内)。外部の記憶ライブラリ(semantica / mem0 /
    agentmemory / cognee / Graphiti 等)は依存に入れない。** 固有部分(承認状態・出所・スコープ)が本体で、
    どの OSS もそれを持たず、検索は薄い。OSS の価値だった圧縮・統合は tidepool では meta-review タスク
    (agent が読んで書く)が担うのでライブラリの consolidation ロジックは要らない。Python サイドカーは許容範囲
    (Pi での動作は今後捨ててよい)だが、今は不要。
    **ただし読み書きのロジックと構造化は研究レベルの主題であり、設計は既存 OSS を参照する** — 依存に入れない
    ことと設計を自分で発明することは別。参照先: retrieval スコア(relevance × recency × importance —
    Generative Agents 系、agentmemory の decay)、注入の2層(Letta/MemGPT の core / archival)、事実の時間性と
    出所(Graphiti の episode → fact edge、`valid_at / invalid_at`; semantica の PROV-O)、統合(Letta の
    dreaming、agentmemory の consolidate/reflect、claude-mem の観測→要約)。持ち込まないもの: OSS の
    memory type 分類学(episodic/semantic/procedural…)— tidepool の種別は Knowledge / Behavior / Precedent と
    承認状態で足りる。retrieval の質は設計では決まらないので、評価に要る事実(引いた前例が使われた率、
    異議率への影響)を最初から events に載せる。
12. **agent.md は担当範囲(引き受ける仕事 / 引き受けない仕事)+ 判断の優先順位 + 制約 + 従うワークフロー
    skill へのポインタ、にとどまる。** ペルソナ(「あなたは敏腕○○です」)は書かない — 一貫した性能向上を示さず
    悪化する場合もあるという報告があり、載せる理由がない。repo 固有の事実は Knowledge、「前に X で失敗したから
    Y」は Behavior、手順は skills へ。ワークフロー skill(複数 skill を組み合わせる meta skill)の**置き場は作者の
    判断に任せる**(workspace / plugin / どこでも) — 盤面から skill を作成する想定は現状なく、skill 機構自体が依存を
    厳密に検証せず利用時の LLM に読ませる形であり、allowlist の名前は参照であって在庫の主張ではない(ADR 0023)
    ので、どこに置いても・無い場所でも無害に不発になる。参照は agent.md のポインタと authority / skills allowlist
    から行う。skill に知識のない人への UX/UI 的配慮は後回し。「skill X に則って作業して」と agent.md に書くことは
    許す(手順のベタ書きではなくポインタ1行)。ワークフローに従うことの
    機械的な強制は無い — 盤面が skill 本文を spawn 時に流し込む機構は作らない(progressive disclosure を壊し、
    ポインタと二重になる)。従ったかどうかは決定8の transcript 観測で見え、逸脱は異議 → Behavior で直る
    (fix-forward の線)。運用が始まったら「agent.md が育つ速さ」自体が Memory が機能しているかの指標になる —
    agent.md を頻繁に触っているなら Memory に吸わせ損ねている。

## 建設順

(0) `/research` で決定11の参照設計を1本のリポジトリ内 markdown にまとめる(#355)→ (1) Precedent 投影(transcript
からの観測抽出を含む、#356)→ (2) Memory ストア + 状態 + spawn 注入 / MCP pull(#357)→ (3) RCA → candidate、周期
meta-review → 承認 question(#358)。

## 先送り

1タップの 👍 信号(観測された痛みが出るまで)/ 承認 question の自然言語提案 UI(当面は diff 表示)/ 記憶ブラウザ
(統計ダッシュボードと同じく meta-review 自体を検証する必要が出たとき)/ Takotsubo(Memory を外部へ出す器 —
future-ideas)/ Knowledge の git 併用(CLAUDE.md は人間が書くものに戻す)。

## 退けた案

(OSS 各候補の事実は `docs/agent-memory-oss-survey.md` にまとめてある。)

- **semantica を長期記憶 + decision intelligence 層として採用する** — bi-temporal + PROV-O + LLM 不要抽出を
  1プロセスで持つ点は魅力だが、MCP は stdio のみ、graph はプロセス単一の singleton で `conversation_id /
  user_id` は分離ではなく metadata filter、記憶形(store / search)の tool は無く、TS パッケージも無い。
  「decision log の自己申告問題を解く」ようにも見えたが、`record_decision` 自体が申告 API(決定8)。思想は借り、
  ライブラリは入れない。
- **agentmemory / mem0 TS oss / cognee をサイドカーに** — それぞれ TS・出所・監査・スコープのどれかを持つが
  fit は 6〜7割で、残り(承認状態・events への出所)は自前になる。薄い検索のために依存を1つ抱える価値が無い。
- **Heuristic を memory に持たず registry の agent.md / workspace CLAUDE.md への instruction diff としてのみ
  扱う**(本 ADR に至る議論の途中まで採っていた線)— ファイルが育ち続け、毎セッション全量注入される。承認の線を状態に引き直した
  (決定3)ことで、承認の不変条件を守ったままコンパクトに保てる。
- **数値閾値で candidate → approved を判定する** — 決定9。
- **盤面が spawn 時に必須 skill の本文を注入する** — 決定12。
- **完了時レビューに accept / reject の二択 UI を足す** — 既存の異議一本で始め、正の信号は Displayed から導出
  (決定7)。
