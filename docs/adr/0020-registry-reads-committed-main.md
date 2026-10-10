# registry はコミット済み main から読む — spawn は版を観測記録し、self RCA には当時版を注入する

2026-07-15 の grilling(ADR 0019 と同セッション)で決定。従来 `src/registry.ts` はワーキングツリーを `readFileSync` していた。branch discipline により registry チェックアウトの HEAD は registry-edit タスクのブランチへ移動するため、ワーキングツリー読みは「人間の merge を通っていない内容が spawn に効く」抜け道だった(保護 workspace の床の破れ)。また worker session は「どの版の定義で走ったか」をどこにも記録せず、ADR 0001 の "commit hash = strict agent version" は概念だけで観測がなかった — RCA は当時のプロンプトという第一級の証拠を、git log のタイムスタンプ推定という考古学でしか得られなかった。

決定は3点:

1. **registry の読み取り(agent 定義・authority・workspaces.yaml)はコミット済み main の内容に固定する**(`git show main:...` 相当。ワーキングツリーは決して読まない)。main は**コード定数** — ADR 0013 と同型で、「どのブランチを信頼して読むか」は強制床の一部であり、床をそれが守るデータ(workspaces.yaml の branch フィールド、issue #27)に置くと自己参照で bootstrap が壊れる。origin/HEAD と main の不一致を検出したら既存の workspace quarantine に落とす。
2. **worker session は spawn 時に読んだ registry main の commit hash を記録する。**「焼き込まない」哲学の例外ではない — 焼き込み禁止が対象とするのは将来の解決を縛る参照であり、これは後から導出不可能な**歴史的事実の観測**(Displayed イベント・「self = 確定値」と同じ側)。読み取りが main 固定なので、記録した hash と実際に読まれた内容は定義上一致する(dirty フラグは不要)。
3. **当事者レビュー(self RCA)の spawn には、盤面が記録 hash から当時の agent 定義本文を注入する**(ADR 0017 の「プロトコルは盤面が注入する」の延長)。レビュアーは read-only・workspace 内で完結したまま — review の cwd はレビュー対象の workspace であり、registry チェックアウトの場所というホスト固有知識を散文に漏らさない(ADR 0018 の向き)。注入は当事者レビューのみ: 独立レビューの対象は成果物、meta-review はログ全体で、当時の定義を証拠として必要とするのは「なぜ自分はあの判断をしたか」を書く RCA だけ。

帰結:

- **registry 変更の正規経路は2本**: agent 発 = registry-edit タスク → PR → 人間 merge。人間発 = WebUI → 盤面がローカル main へ直接コミットして push(issue #54 の直接コミット設計はこの床と両立する — 保護 workspace の床が要求するのは「人間の明示的な意思決定を通ること」であって PR という形式ではなく、WebUI 操作は人間の明示行為そのもの。自分が今行った操作の diff を自分で merge する無情報の儀式は課さない)。禁じられる第3の経路は帯域外の手編集(ssh + エディタ)で、コミットされない限り**構造的に無効** — 読み取り規律そのものが防壁になり、禁止の執行を規約に頼る必要が薄れる。
- GitHub branch protection は agent の push を弾く床として維持し、盤面の専用アカウント(issue #50)を bypass に置く。
- 人間がローカル編集を試すにも commit が必要になるが、それは保護 workspace の建前どおりの手順(試運転のショートカットを塞ぐのはむしろ整合的)。

## 追記: 当時版は objected entry ごとに解決する(2026-07-22 の grilling、issue #87)

決定3は「当時版」を単数として書いたが、objected 判断が複数の worker session(escalation 復帰・retry による再 spawn)にまたがり、各 session が異なる版で走っていた場合、単数は成立しない。当初実装は最も早い objected entry を anchor に1版へ畳んでいた — 決定的だが、一部の判断を「それを形作っていない定義」に照らして読ませる静かな歪みで、この ADR が escalation 復帰の再 spawn に対して防いだものと同種。

精密化: **当時版は objected entry ごとに解決する**(その entry が書かれた時点で live だった session の記録 hash)。全 entry が1版に解決される通常ケースは従来と同一の注入。複数版に解決されるときは各版を注入し、それぞれが live だった entry id をラベルする — entry→版の相関は盤面には自明で RCA 本人には復元不能な計算だから。一部の entry の版が解決できない(記録欠測・到達不能 commit)ときは、解決できた版を注入した上で欠落を1行申告する。0件解決は従来どおりセクションなし(主張がなければ申告も不要)。earliest / latest の anchor 選択問題は、畳み込みをやめた時点で消滅。スキーマ変更なし、events のみで導出 — この ADR の性質は変わらない。

追記時の considered options: **(worker, 版)ごとの RCA 分割** — 1人の worker の判断連鎖を1つの文脈で読むことに当事者レビューの価値があり、版で裂くと連鎖が切れる。**版間 diff の注入** — 証拠(原本)と解釈(diff の意味づけ)の線を越える、RCA 本人の仕事の先取り。

## 追記: 当時版は本文に加えて当時の authority の散文と Roster を含む(2026-10-10 の grilling、issue #1741)

決定3は注入を「当時の agent 定義本文」と名指したが、Authority 節(#7)と Roster 節(#43)はこの ADR より前から本文と同じ system prompt の層に入っていた。profile を検討して退けた記録は無い。判断の原因が guidance の一文や Roster の欠員にあるとき、RCA は見ていないものを名指せず、その見落としは記録にも残らない —— CONTEXT.md の Review が改善提案に含める「authority profile の変更」の元を、RCA は読めなかった。

精密化:

1. **当時版は本文と、当時の Authority 節・Roster 節を含む。** 本文と同じ commit から、objected entry ごとに解決し、同じ版の束に並べる(上の追記の形のまま)。
2. **節は描画の再現であり、原本ではない。** 当時の commit の registry を今日の描画コードで組み直す。registry 由来の文面(guidance・description・`*` の展開先)は当時のとおりで、組み込み Auditor や `human` の description・見出しのような code 定数の部分は今日の値になる —— RCA が diff を書ける対象は registry 側なので、正確さが要る部分は正確である。この食い違いは prompt では申告しない(読み手の判断が変わらない)。見出しは profile 名(改善提案の宛先)を出し、registry commit の hash は出さない —— RCA の cwd に registry は無く、hash を使う読み口も無い。同じ理由で、複数版の見出しからも hash を外し entry id のラベルだけにする。
3. **組み直しは schema を通さない。** 当時の spawn は当時の schema で全ファイルを読めていたので、今日読めないのは形の変化である。本文と同じく必要な欄だけを読み、profile が読めない版は本文を注入した上で欠落を1行申告する。その commit の registry に無い名前は黙って飛ばす(spawn 時の Roster もそうだった)が、名前があって description が読めない行は申告する —— 黙って消すと「Roster にいなかった」と読まれる。
4. **当時と今で必ず同じ部分は指すだけにする。** 被レビュー task が review だった(当時の Authority は ADR 0013 の reviewer 定数 —— ADR 0056)場合、組み直した文面は RCA 自身の Authority と同一なので、その旨を1行書いて自分の節を指す。Roster(当時の被レビュー task の executor)は今と違うので組み直す。当時の担当が組み込み agent に解決されていた(その名前の定義がその commit の registry に無い —— `loadRegistry` の上書き規則と同じ判定)場合も同じ規則で、本文の位置に組み込みだった旨を1行書き、Roster は組み直す。

独立レビューに注入しない線は変わらない。

追記時の considered options: **profile を読む verb を足す** —— 必ず読むべき証拠を規律頼みにする(ADR 0180 の線)。**yaml の原本を丸ごと** —— `allowed_workspaces` や `merge` のように worker が文面として読んでいない値が混ざり、それらの門に当たった事実は既に event log にある。**spawn 時に描画済みの節を `worker_spawned` に記録する** —— 文面は完全に一致するが、`*` の Roster を毎 spawn の event に載せ、上の追記の「events のみで導出、スキーマ変更なし」を外れる。**frontmatter の他の欄(tier・skills・provider)も入れる** —— worker に文面として届いていない。

Considered options:

- **ワーキングツリー読みを維持し、dirty フラグを記録する**(当初案) — 記録は正直になるが、床の破れ(未 merge 内容が spawn に効く)はそのまま残る。
- **checkout HEAD を読む** — HEAD はタスクブランチに動くため、読み取りが「今どのブランチにいるか」という偶然に依存する。
- **origin/HEAD(git ネイティブの default branch)に追従する** — clone 時に固定され GitHub 側の変更に自動追従しない。静かに古い値を読む罠は main 固定より悪い。registry は盤面自身の資源であり、規約(main)を課せる立場。
- **参照ブランチを workspaces.yaml の branch フィールド(issue #27)に置く** — 床が、その床が守るはずのデータの中に入る + 自己参照。#27 自体は一般 workspace の保護ブランチ設定としてこの決定と無干渉に生きる。
