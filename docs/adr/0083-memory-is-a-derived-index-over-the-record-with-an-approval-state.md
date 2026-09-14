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

## 追記(2026-08-18 の grilling、issue #356)

**Precedent の episode 単位は worker session であり、最小粒度は tool 呼び出し1回、`decision_logged` は行動列の中の
マーカー(位置を持つ注釈)であって軸ではない。** decision の粒度は agent の申告頻度でばらつくので、decision を軸にすると
「言ったこと vs やったこと」の照合が申告の疎密に歪む — tool 呼び出し単位なら列は申告に依らず完全で、「直前の
decision からここまで」の窓は保存時の決定ではなく読み出し時のスライスになる。turn の本文は写さない: transcript が
逐語の正本として残るので、各行動は transcript 行への参照を持つだけでよい(派生は薄く、原文は1箇所)。

**decision と transcript の結合キーは盤面が発行する event id** — `log_decision` の応答にその id を載せ、transcript
の tool_result に写ったものを照合する(自己申告ではなく盤面発行のキーが transcript に写るだけで、events は書き換えない)。
出現順や文言一致に頼る対応付けは同一性を保てない(subagent 由来の decision・retry による transcript の欠落・応答経路の
非対称で列がずれ、文言一致でフィルタしていれば誤結合が「一致した」ように見える)。event id を持たない旧記録だけ
順序 + 文言 + 時刻単調性のヒューリスティックで結び、結合の種別を刻む。欠測は理由コードとして明示し、
「空 = 何もしなかった」と区別する。前提として、盤面 verb は親スレッド専用(ADR 0010 追記)であり、transcript は
worker session ごとに1本残る。

## 追記 2(2026-08-20 の grilling、issue #356 — フィクスチャ取得 #386 の実測を受けて)

**ヒューリスティック結合は作らない。** 上の追記が「event id を持たない旧記録だけ順序 + 文言 + 時刻単調性で結ぶ」と
した線は撤回する。その対象になる記録は、スライス A(`log_decision` が event id を返す)より前に開発用の盤面が書いた
transcript だけで、対応する必要がない。結合は event id の完全一致の1種類しか存在せず、event id を持たない
`decision_logged` は結合を試みず欠測理由(`no_event_id`)を持つマーカーとして残る — 「欠測は理由コードで明示し、
空と区別する」の線はそのまま。Episode の同一性は `worker_spawned` の event id で、それをファイル名に持たない
transcript は backfill の走査対象にしない(数えて報告はする)。

**行動行はトークンを持たない。** 同一 `message.id` を持つ複数の assistant 行(thinking / text / tool_use が別行に割れる)
は同じ `usage` を繰り返し持ち(実測)、さらにそれを message 単位で親スレッドだけ合算しても result 行の session 合計と
一致しない(output 138 対 1255、input / cache も不一致)— stream の assistant 行の `usage` は message 開始時のスナップ
ショットであって行動単位の消費ではない。行動単位で意味を持つ数が無いものを派生表に写すと後で足して使われるので、
行動行が持つのは transcript 行への参照だけとし、session 単位の消費は `worker_exited.usage` を正本として参照する。
意味のある読み方が見つかれば投影器の版を上げて足せばよい(派生は作り直せる)。

**subagent の活動は親 stream に出る**(実測、`parent_tool_use_id` 付き)— `events.ts` の「subagent の活動は親 stream に
出ない」という注記は、主語を「subagent 発の advisor 相談」に狭めて直す(その狭い主張は 2026-08-04 / issue #33 で測定済みであり、2.1.237 のフィクスチャでは再検証していない — 測定の記録は消さない)。
加えて subagent の lifecycle 行(`task_notification`)は subagent 自身の消費(tokens / tool 回数 / 所要時間)を運ぶので、
subagent を起動した行動行に添付する。「合算は親スレッドのみ」の線は変えず、添付は合算外の観測である。

**構造マーカーは3つ** — compaction 境界、`vcs_state_changed`(commit)、advisor 相談。subagent の lifecycle は行動行と
`parent_tool_use_id` で既に表現されるので重ねない。**欠測統計は3値**(解釈した / 既知だが解釈しない / 未知)— rate limit
や thinking token の通知のような「知っていて捨てる」行を未知に混ぜると、形式変更の信号が常時のノイズに埋もれる。
**版は3つ刻む** — `registry_commit`、投影器の版、transcript を書いた CLI の版(init 行)。未知行の増減が投影器の変更か
CLI の変更かを分ける手がかりがこれしかない。

**CLI の版の下限を盤面の門にはしない。** tool 名の変化(`Task` → `Agent`、ただし init の `tools` には `Task` が残る)を
受けて版の下限で quarantine する案を検討し、退けた。綴りの消失は既存のツール面 probe が捕まえ、行の形の変化は上の
欠測統計と CLI 版の刻印に観測として出る。Precedent は派生で作り直せるので、投影の取りこぼしは走らせて危険な状態では
ない。版番号は代理変数であり、この盤面はホストの性質を版ではなく実挙動で測る(ADR 0042 と同じ線)。抽出表は `Task` /
`Agent` の両名を subagent 起動として持つ。

## 追記 3(2026-09-10 の grilling、issue #357 / #238 — 長期記憶と実行設定の選択を突き合わせて)

**Behavior は宛先を持つ。** 決定6 の「agent ごとに隔離した記憶は作らない」は維持する(隔離 = ACL は、共有事実の再発見と
agent 引退時の知識の消失を招く)。ただし Behavior は agent.md の「判断の優先順位」の圧縮形(決定12)なので、
**誰の判断に効くか**(agent 名 or 全員)を1列持ち、起草元の Precedent から継ぐ。全員が読めるが注入は宛先で絞る —
これで「agent ごとの記憶」は隔離なしに成立する。Knowledge には宛先を付けない。ADR 0019 の転生(新名)で旧名宛ての
Behavior が孤立するのは正しい挙動(専門性が変わった)。

**エントリは `path` を持ち、INDEX は保存物ではなく派生の純粋目次。** context-vault の規約(README は子ごとに1行、
それ以上は書かない)と同じ線で、ある prefix の子の title を並べたものが INDEX であり、要約の生成・更新という仕事は
発生しない。決定10 の2層は「spawn 時 = 最上位 INDEX + 関連 leaf(トークン上限内)/ MCP pull = 枝を降りる」に対応する。
合成要約は「目次だけでは辿れない」が観測されてから meta-review の仕事として足す。path の付け替えは無効化 + 新エントリ。

**session 記録に memory 側の観測列を足す**(決定10 の「引いた記憶の機械記録」に、当時のストアの snapshot 識別子と
注入した entry・token 量を加える)。実行設定の選択(ADR 0110)を事後に評価するとき、知識条件を隠れた変数にしないため。
結合はこの記録だけであり、Memory と実行設定の選択は独立に建てられる。

**user memory(vault 等の外部ストア)は Memory の外。** Memory は盤面の記録から派生した索引(決定1)であり、外部
ストアは記録ではない。worker に読ませたければ tool allowlist / domain allowlist の門の話で、記憶の種別にはしない。

退けた案: Knowledge に第3の状態(provisional)を足す — 「誤った推論が事実になる」懸念は出所の種別(commit / event id
への参照 = 事実、worker の decision への参照 = 推論)で表し、注入時にその種別を見せる。状態は2値のまま、承認 question
の量(人間の注意予算)を増やさない。/ 行動規則を Memory に置かず instructions へ書き戻す — 本 ADR が退けた案の再提案で、
Condensation が Behavior を**起草**し Memory が**保持**する分担で両立する(置き場の話ではない)。

## 追記 4(2026-09-14 の grilling、issue #597 — #592 の注入を動かして)

**枝(prefix)は Definition(定義)を持ちうる — その下に何を保存するかを書き手が宣言する1行で、中身の要約ではない。**
追記3 が先例に引いた context-vault の規約は "one-line description per child" であり、title だけを並べる目次はその引用に
忠実でなかった。#592 の注入は上限超過で leaf 本文を落とすと枝の**名前**しか残らず、`build/` の1語から中身は当てられない。
要約との線は不変条件で引く: **定義はその枝の下にどの leaf があっても真である** — leaf の追加・無効化で偽になる文は要約で、
合成要約の線(追記3、「目次だけでは辿れない」が観測されてから)はそのまま残る。定義も枝が担当範囲を失えば陳腐化し、無効化で直す。

**Definition はエントリの第3の種別**(`definition`、その枝の path に置く)。新しいエンティティにすると、スコープ・書き手・
英語正文 + 原文・無効化 + 後継 id・watermark 再生・rebuild を一式作り直すことになる。エントリなら全部がそのまま効き、
「INDEX は保存物ではなく派生」(追記3)は撤回でなく精密化で済む — 派生の目次の行が「子の名前 + Definition」になるだけで、
目次を生成・更新する仕事はやはり発生しない。承認は課さない(Knowledge と同じく書いた瞬間に approved): 定義が左右するのは
事実の置き場であって agent の判断でも権限でもなく(決定5)、承認 question の量も増やさない。出所は書き手の宣言そのものなので
Knowledge の「出所ちょうど1つ」は課さない。書き手は worker(明示 verb)と人間。定義の無い枝への書き込みは拒否せず INDEX で
未定義と見せる — 本番はまだエントリがゼロで、拒否すると agent の記憶が1件も無い盤面で人間が先に分類体系を書くことになり、
本 ADR の主目標(人間に prompt engineering を課さない)に反する。スコープはエントリと同じ2つで、同じ枝で重なれば
workspace が勝ち、盤面全体は影に入るが店には残る。worker は影の定義に気づかないし気づく必要が無い — それは他の workspace で
その枝が何を受け持つかであり、両方を見る必要があるのは矛盾を見る人間と meta-review だけ。

**spawn 注入の本体は Definition つき INDEX で、関連 leaf は残りの上限で上位数件。** 役割が違う — 定義は「何がどこにあるか」、
関連 leaf は「今の task に効く事実」を運ぶ。関連 leaf をゼロにして全部 pull させる案は決定10 の「関連度で注入」を捨てるので
退けた。削り順は固定のまま形を組み直す: leaf 本文 → INDEX を深い階層から浅く → 関連 leaf を順位の下から1件ずつ → 最上位
INDEX は超えても残す。件数半減は退けた(長い leaf 1件で短い leaf がまとめて落ちる)。何を落としたかは節の末尾に印を出す —
切り捨てを worker が知らない状態を作らない。#592 で落とした3段目「INDEX を浅く」と `memory_injected` の深さ欄は、
注入が全階層の定義を運ぶようになったことで意味が戻るので復活する。記録は既存の entries(id + 版)に Definition も並べ、
`index_depth` を足す。

**記憶構造の健全性は meta-review の周期検査の職務**(決定9 の周期、#358)。項目は 未定義の枝 / 要約化した定義 / 定義に合わない
leaf / 枝を跨ぐ重複 / 子が1つの枝・深すぎる枝 / workspace と盤面全体の定義の矛盾。Knowledge 級の修正(定義の起草・改訂、
`path_moved` + 後継 id)は直接適用して決定ログに流し、人間は異議で戻す — 承認 question は Behavior のときだけ。詳細は派生 issue。

`docs/memory-reference-design.md` §6「索引の行は id + title(+ path)だけ」と「件数を半分」は本追記で改訂される(研究記録なので
本文は直さない)。実装の測定と walk-through は #597 のコメントに置く。

## 追記 5(2026-09-14、issue #593 の実装着手時)

**人間が settings / 管理MCP から書く Knowledge の出所は、自身の作成 event。** 決定2 の「出所必須」は agent の書き込みに
対する検証であり、人間の書き込みには参照すべき盤面の event も commit も無いことが多い — spec #586 F と #593 の書き込み欄は
原文 + 英語の2欄だけで、出所欄を足すと人間に「どの記録の事実か」を書かせることになる。人間の宣言はそれ自体が盤面の記録
(`memory_entry_created`、書き手 human)なので、Definition(追記4)と同じく出所 = 自身の作成 event、種別 = 事実とする。
worker の `record_knowledge` の「出所ちょうど1つ」は変えない。
