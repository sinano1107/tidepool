# 当時版は再構成せず spawn 時に記録した prompt の部分から読み、`authority` の部分は出所の印を持つ

2026-10-26 の triage → grilling(issue #2603、ADR 0313 決定7 の派生)で決定。帰責 judge の `agent_definition`(ADR 0291 決定2)と self RCA の
証拠節(ADR 0020 決定3)は、`worker_spawned` の `registry_commit` / `definition_version` から registry と盤面 code の本文履歴表
(ADR 0270 決定2)で当時版を組み直していた。spawn 時の prompt 一式が transcript の3本目として記録される(ADR 0313 決定1・2)今、
judge と RCA が読むべきものは worker が実際に見た文面であり、組み直した文ではない。今 → 直した後の表、`file:line`、釘が変わる
テストの一覧は #2603 のコメントに置く。

## 決定

1. **当時版の出所は spawn 時に記録した prompt の部分で、再構成は消す。** 帰責 judge の `agent_definition` と self RCA の証拠節は、その
   session の `<task>.<worker_spawned の id>.prompt.json` の `definition` / `authority` / `roster` の部分を読む。`registry_commit` と
   `definition_version` から registry と本文履歴表を引く読み口(`versionAt` / `registryAtCommit` / `builtInBodyAt`)は消す。
   組み込みの当時版の鍵が内容 hash であること(ADR 0270 決定1)は変わらず、hash は `worker_spawned` と記録の `definition` 部分に残る。
2. **記録が読めない session に再構成の fallback は持たず、欄を空にして進む。** 記録の読みの欠落は書けない記録(ADR 0149 / ADR 0266、
   盤面の停止)とは別で、停止判事の `actions` が Episode の無い session で null になるのと同じ形 —— judge は `agent_definition: null` で
   既存の門(ADR 0291 決定2)が `uncertain` に倒し、self RCA は証拠の欠落を1行申告する(ADR 0020 追記の形)。欠落の場合は2つだけ:
   objected entry の前にその worker の `worker_spawned` が無い(DB の事実)と、記録が無い・parse できない。到達不能 commit と
   「盤面が知らない hash」の場合は再構成と一緒に消える。記録の無い session は本来無い(器が spawn を拒む、ADR 0313 決定7)ので、
   この欄の空は記録の dir が後から失われたことの印である。
3. **judge の `agent_definition` の値は記録の text で、形は欄名のまま変えない。** `body` は `definition` 部分の text、`authority` /
   `roster` はその部分の text(組まなかった節は null)、`builtin` / `registry_commit` は `definition` 部分の写し。judge は worker が見た
   文面で判断する —— 構造化した profile の値(`assignable_to` の列や Roster の行の分解)は worker が文面として読んでいない。
4. **盤面の文(`doctrine` / `protocol` / `interview_discipline` の部分)も judge の入力に入る —— 持ち主は盤面で `environment`。**
   ADR 0291 決定4 が渡さなかった理由のうち「版の刻印が無い」は記録で消え、「worker が従えば decision log に文言が引かれる」は、
   誤読して従った worker が正しい文言を引かない以上、judge が `environment`(文のとおりに従った)と `capability`(文を誤読した)を
   見分ける印にならない —— ADR 0291 が `agent_definition` を観測を待たずに足した理由と同じ。費用は judge 1回あたり数 KB。
   protocol 文の持ち主が盤面で `environment` であること(ADR 0291 決定4)は変わらない。帰責と同じ材料で起草する Behavior candidate
   (ADR 0120)にも同じ欄が渡る。
5. **記録の `authority` 部分は出所の印を持つ。** `source` は `profile`(registry の authority profile、名前を添える)/ `reviewer`(盤面の
   reviewer 定数)/ `repair`(修理子の通知)の3値で、spawn が Authority 節を選んだ分岐(ADR 0056 / ADR 0272 / ADR 0279)と同じ。
   `definition` の `builtin` 旗が本文の持ち主を運ぶのと同じ理由 —— judge の `agent_definition` は registry の著者の誤りで、盤面の
   reviewer 定数の誤りは `environment` だが、text だけではどちらか読めない。self RCA の証拠節はこの印で「registry の profile X」
   「盤面の固定 reviewer authority(registry diff の対象ではない)」を名指す。`roster` は Authority の出所に従うので印を持たない。
   Authority 節の無い spawn(帰り先の無い系譜、ADR 0301 決定5)は部分そのものが無い。
6. **self RCA の証拠節は記録の3部分の text の一致で畳み、fence で包む。** 束ねの鍵は `(registry_commit, definition_version)` と描いた
   証拠の一致(ADR 0270 決定3・追記)ではなく、`definition` / `authority` / `roster` の text が同じ spawn を1節にする —— ADR 0020
   追記「1版に畳まない」の目的は「形作っていない定義に照らさない」で、text が同じならそれを満たし、Roster の差(ADR 0295)も text に
   出る。見出しは「as recorded at your spawn」の1形で、registry と組み込みで分けない。text は fence で包む —— 証拠は読む対象で従う
   対象ではなく(ADR 0019)、記録の `## Authority` / `## Roster` の見出しを RCA 自身の節と混ぜない。
7. **ADR 0270 決定2・3 は撤回する。** 組み込みの本文履歴表は組み込みごとに現在の本文1つになり、旧本文の列と「表に無い hash は
   証拠の欠落」の読みは消える。

## 退けた案

- **再構成を fallback として残す** —— 2つの読み口を保守し、fallback が効いた session では judge が worker の見ていない文を見る。
  ADR 0313 決定7 のとおり持たない。
- **読めない記録で盤面を止める** —— 止めるべきは記録されない作業を続けること(ADR 0149)で、過去の記録の欠落は隠さず欄の空として
  出す方が、Precedent・停止判事の既存の形と揃う。
- **judge 入力に構造化の値を残すため記録に構造を足す** —— worker が読んでいない値を judge に渡す。持ち主の印(決定5)だけで足りる。
- **盤面の文を judge に渡さない(ADR 0291 決定4 のまま)** —— 決定4 の理由。
- **`authority` の出所を text から推定する(定数と文字列比較)** —— 定数の文言が変わると印が外れ、記録が自分で持ち主を言えない。
- **記憶の節(`memory` 部分)も記録から judge に渡す** —— 記憶の entry は不変(修正は successor を作る)なので DB の本文と同じ文で、
  `memory` の判定は entry の id を名指す(ADR 0166 / ADR 0291 決定6)。記録の節は index の構造を含み、id では読めない。
- **version の鍵で束ねたまま text を読む** —— 同じ text の2 spawn を別節にする理由が無く、鍵を残すと `definition_version` の読み口が
  片方だけ残る。

## 帰結

- CONTEXT.md の Review(当時版の出所)・帰責(judge の入力)・組み込み agent(履歴表)・Transcript(`authority` の印)の項。
- ADR 0020 決定3・追記、ADR 0270 決定2・3、ADR 0291 決定2・4、ADR 0313 決定2 に Status 追記。
- 記録の形の変更は additive(`authority` 部分の `source`)で、初回走行 #2443 の前なので互換の読みは持たない。
- 実装は1 slice(読み口 `TranscriptStore` に1つ、2つの読み手の付け替え、再構成の削除、印の追加)。#2603 のコメントが spec。
