# 復旧が transcript を読めなかった exit は印を持ち、Board call の入力は観測できない欄を外して、持っている値の説明だけを出す

2026-11-27 の triage → grilling(issue #3898、#3857 / ADR 0317 追記が分けた記録の側の問い)で決定。起動時の復旧は transcript の無い・読めない
session を「欠測のまま閉じる」(ADR 0316 決定2)が、`model_swaps` / `refusals` は配列で欠測を表せず `[]` が書かれ、Claude の session でも
「stream を読んで何も無かった」と区別できなかった。ADR 0317 決定5 は judge の入力で「読んでいない」を Harness と exit の有無から組み直したが、
この経路はどちらにも当たらない。Codex の不観測は `worker_spawned.harness` から導けるが、この事実は記録のどこからも導けない。読み手の表と
`file:line` は #3898 のコメントに置く。

## 決定

1. **復旧が transcript の読み込みで例外に当たったとき、`worker_exited` に `stream_read: false` を書く。** 省略可能な印で、無ければ読めた。
   空・途中で切れた transcript は読めたうちに入る —— 読めた範囲がその session の記録である。Harness によらず書く。ADR 0316 決定2 の
   「欠測」はこの印で記録の値になる。stream 由来の欄の値は今のまま(`[]` / null)。
2. **配分評価の judge の入力は、`model_swaps` / `refusals` / `advisor` を1つのまとまり `output_observations` にする。** Claude の session で
   `worker_exited` が無いか印があるとき、まとまりごと null。欄ごとの null(ADR 0317 決定5)では、`advisor` の null が「親 thread で相談も
   失敗も観測されなかった」(同 決定6)と読まれる。Codex の session ではまとまりも `actions` も入力から外す(決定4)。
3. **学習器は印のある Claude の session を `excluded` に数える。** ADR 0215 決定4 と同じ理由 —— 差し替えの有無が分からない session の結果を
   pin の行の実績にしない。数えて誤ると別の model の結果が cell に混ざり、除いて誤ると1件を捨てるだけ。Codex は差し替えを観測しないので変えない。
4. **Board call 全体の規則: 入力が持たない値の説明は出さず、構造的に観測できない欄は入力から外す。**
   - 一部の入力にしか要らない説明(欄や要素の null の意味、Harness ごとの注意、省略可能な欄の説明)は、入力がその値を持つときだけ出す。
     欄が何かの定義の文は、その欄が値を持てば毎回出す。
   - Harness や行の種別で構造的に観測できない欄は外し、null は「観測できたが観測しなかった」に限る。
   - 配分評価の `usage` の null は、報告しなかったのか出力を読めなかったのかを分けずに1文で書く —— Codex では入力から区別できず、
     どちらも judge には「費用が分からない」で同じ。
   - 読み手に届く語は prompt の文と入力だけ(ADR 0324 決定3 と同じ線)。stream / transcript の語を使わず、session の出力として言う。

## 退けた案

- **据え置き** —— 記録から導けない事実で、ADR 0316 決定2 の「欠測」が値として守られていなかった。
- **`model_swaps` / `refusals` を null にする** —— 学習器の判定まで型が広がる。印なら live の adapter と他の読み手の値は変わらない。
- **出所の列挙(`pipe` / `transcript` / null)を常に書く** —— pipe と transcript の違いを読む読み手が無い。
- **入力の欄ごとの null を保つ** —— 決定2。`advisor` だけ誤読が残る。
- **学習器を据え置く** —— 決定3。学習器の数は pickup の推奨と routing のメタレビューに届く。
- **規則を配分評価の prompt だけに当てる** —— 振り返りの4本にも同じ形の文があり、prompt ごとに規則が割れる。

## 帰結

- ADR 0316 決定2・ADR 0317 決定5・6・ADR 0215 決定4・ADR 0083(Codex の行動列は null)に Status 追記。
- 印を書いた後で transcript が読めるようになっても(権限を直した受理の閉じ直しで投影される)、`worker_exited` は append-only で書き直さない。
  judge は観測なし、学習器は除外のままで、どちらも安全な側に倒れる。
- 振り返りの4本の prompt への適用は #3937。洗い出しで出た別の欠陥は #3934(落ちた位置によっては走っていない session に exit が書かれる)・
  #3935(起草の tier の半文)・#3936(判事の入力の null の2つの意味)。
- 実装は1 slice、#3898 のコメントが spec。記録の形の変更は省略可能な欄の追加で、migration は書かない。
