# 盤面が書いた文面は Harness を問わず task 本文より上の層に置き、Codex では `developer_instructions` がその層である

2026-09-17 の grilling(issue #598)で決定。#592(PR #596)の議論で、Codex adapter が agent 定義本文・authority・Memory
注入節を **user prompt** に置き、Claude adapter が同じものを `--append-system-prompt`(system 層)に置いていることが
指摘された。この置き場所の違いに理由の記録が無く(ADR・#453・PR #502 のいずれにも無い)、spec #586 C は既存の形を
引き継いだだけだった。実測(0.147.0、ChatGPT 認証での request 捕捉、`codex debug prompt-input`、課金された呼び出し
1回)と Codex CLI ソース(`rust-v0.147.0`)の読み取り結果は issue #598 のコメントに置く。

## 決定

1. **盤面が書いた文面は task 本文より上の層に置く。** 「上の層」とは Harness がモデルに対してより強い拘束として扱う層で、
   機構は Harness ごとに異なってよい(ADR 0098 決定7 の線)が、配置の意味は共通である。上に置くのは agent 定義本文・
   authority・盤面の doctrine・Memory 注入節など、**その task に固有でない背景知識**。user prompt に残すのは
   **その task に固有の指示** —— 最初に呼ぶ verb、title、purpose、completion criteria。

2. **Codex ではその層は `developer_instructions` である。** `-c developer_instructions=...` は `--strict-config` で受理され、
   `role: "developer"` の item の先頭 part に逐語で載る。Codex 自身の組み込み prompt と同じ側で、AGENTS.md と
   `<environment_context>`(どちらも `role: "user"`)と `codex exec` の prompt 引数(末尾の user turn)より前に置かれる。
   `--ignore-user-config` は `-c` を落とさず、ChatGPT 認証の経路で剥がされる分岐も無い。

3. **組み込み prompt を置換する鍵(`instructions` / `model_instructions_file`)は worker session では使わない。**
   どちらも Codex の組み込み prompt(Working with the user / Editing constraints / Tool Guidelines / AGENTS.md spec)を
   丸ごと差し替える。Claude 側の `--append-system-prompt` が持つ「追記」の意味を持つ手段は Codex には無く、置換を選ぶと
   Harness の動作規則を盤面が肩代わりする設計になる。`base_instructions` は 0.147.0 の config キーではない(実測で
   strict-config が拒否。binary に文字列はあるが `ConfigToml` に無く、app-server の programmatic 面にのみ存在する)。

4. **層に届いていることは preflight が実物で観測する。** `--json` にも stderr にも developer 文面は現れず、`--ephemeral`
   は rollout も書かないため、session の記録から事後に確かめる術は無い。よって Codex の封じ込め preflight
   (ADR 0098 決定4 / ADR 0108 と同じ declared-vs-observed の表)に行を1つ足し、probe 専用の marker を
   `developer_instructions` で渡して `role: "developer"` の item に載ることを観測する。不一致は Codex Harness だけの
   quarantine。probe は `codex debug prompt-input` で、推論リクエストを送らないので marker はモデルに届かない。

5. **provider 間で層の機構が違うことを、実行設定の評価(ADR 0110)の交絡として扱わない。** 学習器のセルは
   (provider, model, effort, advisor) で provider 内の比較には効かず、provider 間の比較は元々 Harness 差を含む。
   配置を揃える前の観測を選り分ける欄(`worker_spawned` の「prompt の組み方の版」)も作らない —— 未公表で、
   揃える前のデータを残す理由が無い。

## 退けた案

- **現状維持(user prompt のまま)で痛みの観測を待つ** —— 現状は決定の結果ではなく引き継ぎの結果である。定義と authority を
  user prompt の先頭に置く形は「task の一部として自分の定義を読む」意味を Codex にだけ与えており、既存挙動の構造的な差で
  あって拡張の是非ではない。
- **`model_instructions_file` で盤面の文面を置く** —— 決定3 のとおり置換。ただし翻訳・下書きのような**生成系 Board call**
  では Codex の coding agent としての組み込み prompt が不要なので、置換が適する余地がある。その検討は #456。
- **probe を触らず adapter テスト(argv)だけで守る** —— argv は盤面が何を渡したかしか言わず、CLI がその層に置いたかは
  言わない。版を固定している以上 drift は起きうる変化であり、ADR 0098 が観測で照合すると決めた対象そのものである。
- **probe で「developer role の item が存在する」形だけを見る** —— 組み込み prompt 自体が developer item なので、config
  キーが無視されても真になる。

## Consequences

- Codex adapter の `taskPrompt` は2つに割れ、spawn の argv に `-c developer_instructions=...` が増える。文面は TOML 文字列
  として渡り、developer item 内で次の part(`<skills_instructions>`)と区切り無しに連結されるため末尾に空行が要る。
- preflight の照合表に行が増えるが、#645 のとおり MCP 行が今どの環境でも不成立なので、実機で成立を見られるのは #645 の後。
- Codex worker に届く盤面の文面は Claude より**中身**も少ない(Board doctrine、Rules of the road、network egress、Roster、
  当時版定義、review の authority 差し替え)。この非対称は本 ADR の主語ではなく、決定1 の層を継承する別 issue が担う。
