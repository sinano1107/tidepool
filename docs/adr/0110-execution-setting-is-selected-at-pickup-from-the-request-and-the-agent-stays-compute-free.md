# 実行設定は pickup 時に要求から選ばれ、agent 定義は計算資源を持たない

**Status 追記: 決定1 の省略の定義(「盤面が資格情報を持つ全 Provider を床の構成で」)は ADR 0116 決定1・3 で置き換え** —— 省略は「正準経路が宣言(skills)を満たす全 Provider」の静的な集合になり、資格情報は entry 集合の定義ではなく決定3 の除外条件「Provider 認証」に帰属する。advisor は entry の性質だけで、トップレベルの `advisor` は退役(ADR 0116 決定2)。

2026-09-10 の grilling(issue #238 / #357)で決定。観測された痛みは「tidepool の開発を tidepool に任せる」— `/implement-tidepool`
が issue ごとに決めているモデル / effort / review 強度に、agent 単位で model を固定する今の盤面には置き場が無い。
検討記録(ChatGPT との設計会話の第3版 HTML)は ADR 0083 を読まずに作られており、その再提案の扱いは ADR 0083 追記3 に置く。
測定・実装の割り付けは #238 の spec issue に置く。

## 決定

1. **agent の安定した役割と、各実行の計算資源を分ける。** agent.md は役割(担当範囲・判断の優先順位・制約・skill へのポインタ、
   ADR 0083 決定12)に加えて、`provider`(任意、entry の配列)、entry ごとの `advisor`(真偽)、`tier`(任意、既定の要求ティア)
   だけを持つ。`model` / `effort` / pin は持たない。ADR 0097 の「provider 宣言は必須」は撤回する — 省略の意味が「特定の1つ」では
   なく「盤面が資格情報を持つ全 Provider を床の構成で」になり、隠れた既定が無いので書き忘れと意図の区別という論拠が消えた。
   経路依存の能力(advisor)は entry 単位で検査し、黙って落とさない線は維持する。

2. **task は要求2列を持つ: 必要品質(ティア: 廉価 / 主力 / 上位)と優先順位(quality / cost / speed)。** 制約は task に置かない —
   外部送信可は workspace、予算窓と温存は盤面(Throttle / Spend-down)。入口は人間の Register、decompose の ChildSpec、
   triage の3つ。未指定と既定選択は記録上区別する(要求ティアは難易度の申告として学習の文脈変数になる)。

3. **selector は pickup 時に決定論で (provider, model, effort, advisor model) を1つ選ぶ。** 入力は要求・盤面設定の表
   (provider × ティア → alias または model と既定 effort、advisor model は「上位ティアの champion、main が上位なら同一」の規則で
   導出)・Policy の除外(Throttle オフセット、Spend-down、Provider 認証)・Provider 順位。全 entry が除外されて初めて skipped。
   選んだ値と出所(task 要求 / agent の tier / 盤面既定)を `worker_spawned` に刻む。ADR 0005 の「常に明示ピン留め」は維持し、
   fallback の出所が adapter 定数から盤面の表へ移る。advisor の組み合わせ(main 以上のティア)は盤面が spawn 前に検証する —
   headless の CLI は不正な組み合わせを exit ではなく advisor 無しで起動する。

4. **学習器は shadow から始め、昇格は routing meta-review の判断 + 人間承認 question。** セルは観測された具体 id での
   (provider, model, effort, advisor)。事前分布は表(観測1件分の重み、ノブは露出しない)、盤面全体の事後分布が各 workspace の
   事前分布(階層プーリング)。受理率は pin で条件づけ(intention-to-treat)、費用は session 合計(advisor の帰属は要らない)、
   相談回数は費用の3値帰属と配分評価(ADR 0111)にのみ使う。昇格後もデータの無いセルでは表と一致し、work task にしか触れない
   (review の設定は表のみ)。これは実験用ではなく製品の形 — Memory の candidate → approved と同じ、人間が承認する信頼の過程。
   新セルは「観測された未知の id」か「人間が足した行」で、Interview(ADR 0111)の発火事象になる。

5. **Provider をまたぐ選択も selector の仕事。** 「Claude は温存、Codex に流す」は待ちではなく他所へ行くこと。Policy という
   新しいエンティティは作らず、既存(Throttle / Spend-down)+ 新設2つ(Provider 順位・優先順位の既定)の盤面設定で表す。
   入口は settings タブと管理MCP(自然言語は Claude Code session が人間名義で設定に写す。盤面に NL 解釈は持たない)。

6. **外部モデルは Provider として候補に入る。** 候補集合は「盤面が spawn できる Provider」で変わらず、OpenRouter 等は Codex CLI /
   Claude Code の向き先として Provider になる(ADR 0096 の Kimi と同型)。**#139 のセッション内外注は退役**する — 盤面観測が無く
   (decision log の散文のみ)、説明責任をセッション内に飲み込み、Provider ごとに1経路の線に第2の経路を足す。部分を安いモデルに
   任せたいなら decompose して別 Provider の agent に assign する。

## 退けた案

- **task に具体モデル名を刻む** — Assignee は pickup で解決されるので登録時に Provider が確定しない。要求(ティア)と解決(具体値)を
  分け、学習は解決された具体値で行う。
- **統計層を最初から本番で選ばせる(一様事前分布で workspace ごとに探索)** — 一様分布も「Haiku が Fable と同確率」という主張で、
  代金は異議と人間の時間。モデル能力は workspace 固有でないので移転できるものを捨てる。
- **agent ごとの上限 / 下限** — Throttle が窓を守り、出所が記録される。痛みが出たら profile の1フィールド。
- **advisor の model を agent.md に固定** — main が動くと組み合わせの妥当性が変わる(advisor は main 以上のティア)。
- **「設定したが使われなかった advisor」を advisor なしと同一視** — 相談回数は事後変数で、易しい task ほど呼ばれない。合流させると
  両セルの受理率が歪む。
- **pickup 時に Board call(LLM)で選ぶ** — 選択理由が散文になり、shadow との比較が「LLM vs 学習器」になる。難しさの判断は登録者が
  要求ティアで済ませている。
