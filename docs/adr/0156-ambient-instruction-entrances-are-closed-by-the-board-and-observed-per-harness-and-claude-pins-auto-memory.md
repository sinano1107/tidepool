# フラグで除けない ambient な指示の入口は盤面が閉じて Harness ごとに観測する —— Claude では auto-memory を無効化・移し先固定・deny で閉じる

2026-09-26 の triage → grilling(issue #881)で決定。ADR 0148 決定3 が Claude 側に分けた問いの答え。Claude worker は
`--setting-sources project` でもホストの auto-memory(`MEMORY.md`)を読み、さらにその memory ディレクトリには組み込みの書き込み許可が
あって、auto-memory を無効にしても review の `manual` 床(ADR 0035)を in-process の Write / Edit が素通りする。workspace の
project 設定 `autoMemoryDirectory` はその例外の場所を任意に移せるので、workspace が worker にホーム配下の任意の場所へ書かせられた。
実測表は issue #881 に置く。

## 決定

1. **Harness 共通の原則。** フラグで除けない ambient な指示の入口は ADR 0098 決定3 の「ambient」に含まれ、盤面が閉じ、その
   Harness の containment preflight で閉じていることを観測する。Harness を足すとき・版を上げるときに「この Harness の ambient な
   指示の入口は何で、どこで観測するか」を問う。Codex の答えは ADR 0148、Claude の答えは以下。
2. **Claude は per-task `--settings` の3キーで閉じる。** auto-memory を無効化し(読み)、`autoMemoryDirectory` を盤面所有の
   固定パスに置き、そこへの `Edit` を deny する(書き)。work / review の区別はしない。flag tier の値は workspace の project 設定に
   勝つ(実測)ので、workspace 側の `autoMemoryDirectory` は検査で弾かずとも無効になる。
3. **読みは init 報告の `memory_paths` の不在で観測する。** 正本の probe は閉じる設定だけを inline で運び(タスク単位の生成物でなく
   姿勢なので、ADR 0108 決定3 の線に抵触しない)、CLI のキー改名を pickup 前に捕まえる。実セッションの init 行でも同じ不在を
   確かめ、あれば強制回収して quarantine する —— これは per-task `--settings` が丸ごと黙って無視されたことの、初めての実行時の
   観測面にもなる。
4. **書きの閉鎖は init に出ないので deploy 時の canary に預ける。** 設定ファイルへの `Edit()` deny を確かめる既存の行と同じ形で、
   固定した移し先への Write が拒否されることを確かめる。

## Considered options

- **env `CLAUDE_CODE_DISABLE_AUTO_MEMORY` で読みを閉じる** —— 効く(実測)が、書きの deny は settings にしか書けないので閉じる面が
  2つに割れる。
- **`autoMemoryDirectory` を書いた workspace を quarantine し、既定の置き場所 `~/.claude/projects/**` を deny する** —— ベンダーの
  既定の置き場所(slug 規則・`CLAUDE_CONFIG_DIR`)と検査キーの列挙の2つに依存する。移し先を盤面が決めれば1か所を閉じるだけで済む。
- **`--bare`** —— auto-memory を止めるが OAuth を読まなくなり、worker の認証が成り立たない。
- **Claude 固有の決定に留め、共通化は3例目を待つ** —— 2例が「フラグで除けているつもりだった」同じ誤りから出ており、原則が
  無ければ3例目は実測されるまで気づかれない。

## 追記(実装時、issue #994)

決定3 の「`memory_paths` の不在」は **`memory_paths.auto` の不在**と読む。`memory_paths` は memory の種類ごとの
入れ物で、項目ごと消えるかどうかを期待値にすると、ベンダーが別種の memory を足しただけで Claude の封じ込めが
誤って不成立になる。閉じたいのは auto-memory の層だけなので、見るのも `auto` だけでよい(#881 の追補で決定)。
逆に `auto` や `memory_paths` が読めない形で現れたときは閉じているとみなさず、不成立に倒す —— `mcp_servers`
の読み取りと同じ fail-closed の線である。
