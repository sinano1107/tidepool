# task type の override は authority の散文と roster にも及ぶ

issue #218 のグリリングで決定。ADR 0013 の「read-only は review という**行為**の性質であって行為者の性質ではない」という override は、MCP verb 層(`attributedAuthority`)と CLI ツール層(`reviewToolDenials` / `spawnTools`)には届いていたが、**system prompt の組み立てには届いていなかった** — `claude-worker.ts` の `## Authority` は `resolveExecutionAgent` が agent 名から引いた registry の profile をそのまま注入し、`task.type` を一切見ていなかった。

結果、`REVIEWER_AUTHORITY_PROFILE.guidance`(「You are reviewing read-only. Never fix directly — findings become repair tasks.」)は**エージェントに読ませるつもりで書かれ、読み手が1人もいない文字列**だった。同時に、review タスクのレビュアーは system prompt では registry profile の `assignable_to` から作られた roster を渡され「この人たちに委譲できる」と告げられながら、MCP 層では(ADR 0013 の免除に当たる1人を除いて)全員が承認 question に落ちていた。同じ盤面の2つの roster 面が食い違っていた。

**決定: prompt 層も同じ task-type 解決を通す。** `REVIEWER_AUTHORITY_PROFILE` を単一の正本として mcp.ts から共有し、review タスクでは `## Authority` の散文もこの定数から出る。registry の profile の散文は review タスクには現れない。

この決定が issue の挙げた懸念 —— 「監査者に固有の権限上の但し書きを registry 側から言う手段が無くなる」 —— に答えるのは **ADR 0017** である。エージェントの専門性の散文は agent 定義本文(`definition.systemPrompt`)が運び、それは task type に関わらず無条件で注入され続ける。`profile.guidance` は authority の散文であり、**床と一致していなければ prompt が嘘をつく**。auditor 固有の言葉は agent.md 本文に書く。

**roster は ADR 0013 の免除の1名を名指す。** `assignable_to: []` をそのまま `buildRoster` に渡せば roster セクションは消えるが、それではレビュアーは唯一の合法な委譲先を知らないまま置かれる。spawn 時に `reviewedTaskExecutor`(ADR 0054)を解いて roster の唯一の行にすることで、prompt の roster と `list_agents` の `direct` マークが完全に一致する。ADR 0014 が `list_agents` の中で守った「マークと実際の挙動が乖離しない単一ソース」を、prompt 側の面にも広げたことになる。roster 行の形は `名前 — description` のまま無傷 —— 「**なぜ**この名前か」は roster の形ではなく guidance の散文が言う(そのため guidance に「Assign a repair to the worker in your roster: they executed the task you are reviewing.」の1文を足す)。

roster の入力が registry だけでなく event log にも依ることになるのは自覚のうえの代償である。これは新しい依存ではなく ADR 0054 が既に `list_agents` に持ち込んだものを、同じ事実の別の読み口に揃えただけである。

Consequences:

- **executor が registry から drift したとき、guidance は空の roster を指す。** `buildRoster` は registry に無い名前を黙ってスキップするので roster セクションが消え、「roster のその worker へ」という文が指す先を失う。実害は無い —— その名前宛ての子登録は登録時の `unknown agent` 即拒否(ADR 0012)で止まるので、レビュアーは存在しない宛先へ修理を投げられない。
- **ルート review(独立監査)には免除自体が無い。** `reviewedTaskExecutor` は `parent_id` を要求するため、親を持たない review では roster が空になる。これも嘘にはならない —— 常時許可される宛先が実際に存在しないからである。修理タスクの宛先を未指定にすれば既定エージェントへ流れ、明示すれば承認 question に落ちる。
- **`assigneeNeedsApproval` 側は変えない。** 免除は既に `reviewedTaskExecutor` を直接見ており、prompt の roster 差し替えは表示側の合わせ込みにすぎない。上書きした profile オブジェクトの `assignable_to` を書き換えて検査に渡す、という形は取らない(検査の正本を2つにしないため)。

Considered options:

- **spawn 側に `task.type` だけを見る散文定数を置く**(`reviewToolDenials` / `spawnTools` の隣)— 床の実装物が全部 claude-worker.ts に集まりモジュール間結合は増えないが、同じ文言の正本が mcp.ts と claude-worker.ts の2箇所になる。ADR 0014 が `list_agents` で守った単一ソースの逆を行く。
- **auditor 用 registry profile の guidance に read-only の散文を書く**(実装変更ゼロ)— 板全体の教義を registry へ複写することであり、ADR 0017 が消した drift そのもの。致命的なのは self RCA で、そこでは元エージェントの profile で prompt が組まれるため、auditor の profile に何を書いても届かない。
- **roster を空のままにする** — 実装は最小で roster の入力は registry に閉じるが、レビュアーは唯一使える委譲先を知らされない。`list_agents` を引けば分かるが、引くとは限らない(ADR 0014 が push 半分を作った理由そのもの)。
- **roster 行に「= 被レビュータスクの実行者」と注記する** — `名前 — description` の一様な形(ADR 0014)を崩し、roster に authority の意味論を混ぜることになる。同じ内容は guidance の1文で言える。
