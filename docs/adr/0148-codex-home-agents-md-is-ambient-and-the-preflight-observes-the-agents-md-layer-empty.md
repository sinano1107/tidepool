# `$CODEX_HOME` の AGENTS.md も ambient であり、フラグでは除けないので Codex preflight が AGENTS.md の層を空と観測する

2026-09-22 の triage → grilling(issue #697)で決定。ADR 0098 決定3 は `--ignore-user-config`・`--ignore-rules`・`--ephemeral` によって
ambient な設定を経路から除くと書いたが、`--ignore-user-config` が落とすのは `$CODEX_HOME/config.toml` だけで、
`$CODEX_HOME/AGENTS.md`(および `AGENTS.override.md`)は読まれ続ける。0.147.0 の実測で、盤面と同じフラグの `codex exec` の
推論リクエストに載り、`project_doc_max_bytes=0` も効かないことを確かめた。載る層は `role: "user"` の item で、task 本文と
同じ層 —— 盤面の文面を上の層に置いた ADR 0124 より下から、盤面の書いていない指示が届く。実測表は issue #697 に置く。

## 決定

1. **`$CODEX_HOME` の指示ファイルは ADR 0098 決定3 の「ambient」に含まれる。** 決定3 が挙げたフラグはこの読み込み元を除かないので、
   「フラグで除く」は Codex では成り立っていなかった。本 ADR はその主張を精密化し、0098 本文は変えない。
2. **塞ぐ手段は Codex の containment preflight の観測である。** ADR 0124 決定4 の developer marker 行と同じ `codex debug prompt-input`
   の出力で、AGENTS.md の層(`# AGENTS.md instructions` の user item)が**空**であることを期待値とする行を足す。不一致は他の行と
   同じく Codex Harness だけの quarantine。preflight は起動時・pickup ごとに回るので、後から置かれたファイルも次の pickup で止まる。
3. **射程は Codex に限る。** Claude worker の user `CLAUDE.md` は `--setting-sources project` で落ちる(実測)が、auto-memory は
   落ちない(実測)。後者は別の機構と別の問い(書き込めるか、ADR 0083 の Memory との関係)なので派生 issue #881 に分け、Harness
   共通の原則にするかは Claude 側が決まってから問う。

## Considered options

- **ファイルの有無を stat で検査する** —— 観測先が Codex の実装詳細(ファイル名と優先順位)になり、版で変わる。prompt-input の層を見れば、
  ファイル名を知らずに同じ層へ入る読み込み元をまとめて捕まえられる。
- **盤面が `AGENTS.override.md` を置いて上書きする** —— 空ファイルでは効かない(実測: 空の override は無視され base が載る)。
  中身を置けば盤面の文面が task 層に1枚増え、ADR 0124 の向きと逆になる。
- **塞がない(`CODEX_HOME` は盤面が所有しているので誰も書かない)** —— 決定3 の主張が既存の挙動で成り立っていない欠陥であり、
  痛みの観測を待つ対象ではない。
