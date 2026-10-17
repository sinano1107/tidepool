# 組み込み agent の当時版は本文の内容 hash で、盤面は本文の履歴表を code に持つ

2026-10-17 の grilling(issue #2156)で決定。self RCA の当時版(ADR 0020)は registry commit から agent 本文を読むが、組み込み agent
(ADR 0117)の本文は盤面の code にあって registry に無い。`fugu` の本文が空だった間は「本文が無い」の一文で済んだが、本文を持つ
`suzumedai`(ADR 0269 決定4)が現れると、RCA は実際に走った本文を見られず、誤った当時版を証拠として渡される。ADR 0117 の 2026-09-16
追記が預けた「盤面の版が必要になったら別の決定」が、この決定である。

## 決定

1. **組み込みの当時版の鍵は本文の内容 hash(sha256 の先頭 16 文字)で、`worker_spawned.definition_version` がそれを運ぶ。** 固定文字列
   `"built-in"` は廃止し、空本文の組み込みも空文字列の hash を載せる —— 1 フィールドに 1 つの意味で、組み込みの印は
   `definition_version` の形ではなく、当時版を読む側の `builtin` の印(registry commit にその名のファイルが無い)が担う。
   `definition_version` は registry の agent では frontmatter の人手の版、組み込みでは内容 hash と、出どころで意味が変わる。
2. **盤面の code は組み込みごとに `hash → 本文` の履歴表を持ち、現在の本文は表の末尾である。** 本文を変える PR は旧本文を表に残す。
   CI の釘は「現在の本文の hash が表にある」—— 足し忘れは落ちるが、表の既存行を書き換える誤りは捕まえない(その線は実装 issue に)。
   古い版は落とさない。
3. **RCA は記録の hash で表を引き、本文があれば当時版として出す。** 空なら「本文は空」の一文。表に無い hash は証拠の欠落として宣言する
   (ADR 0020 追記の unresolved と同じ扱い —— 読む盤面がその版を知らない)。当時版の束ねは `(registry_commit, definition_version)`
   で行い、同じ registry commit で盤面だけが更新された spawn は別の版として別節になる(ADR 0020 追記「1 版に畳まない」の組み込みへの
   延長)。

## 退けた形

- **spawn ごとに本文そのものを event に記録する** —— 同じ本文が spawn の数だけ重なる。
- **盤面の git commit sha を記録し、`git show` で本文を読む** —— 配布形(npm package、焼き込みイメージ)に `.git` は無い。組み込みの本文は
  盤面の code の一部なので、当時版を導く元も code の中に閉じる。
- **`package.json` に人手の版を持つ** —— 本文を変えて版を上げ忘れると同じ版に 2 つの本文が載り、決定的でなくなる。何が変わったら上げる
  べきかを code は知らず、釘が打てない。
- **文言だけ直し、本文は出さない** —— 誤りは消えるが、Interview の root への異議から立つ RCA(ADR 0268 決定3)が本文を見られない問題は
  残る。
