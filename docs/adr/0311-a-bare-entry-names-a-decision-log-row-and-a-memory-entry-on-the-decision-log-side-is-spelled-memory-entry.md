# 英語の名前の裸の `entry` は判断ログの行で、判断ログ側の面に出る記憶のエントリは `memory_entry` と書く

2026-10-26 の triage(issue #2578、#2577 の triage で行った名前の監査から派生)で決定。英語の名前(event の鍵・verb の入出力・wire)では、
判断ログの行(`read_decision_log` の `entries`、異議の `entry_id`)も記憶のエントリ(`list_memory_entries` の `entries`、`memory_entry_*`)も
`entry` と呼ばれていた。両方が1つの面に並ぶ箇所では、読み手は名前だけで区別できない —— `read_decision_log` の判断の行の中にある
`judgment.entry`(記憶のエントリ)、異議つき判断の id の隣にある `precedent_entries`(記憶のエントリ)。管理 MCP は payload を説明なしに返す。
#2577 は帰責の `entries` だけを `wrong_memory_entries` に改名し、残りをこの issue に送った。箇所ごとの照合は #2578 のコメントに置く。

## 決定

1. **裸の `entry` は判断ログの行を指す。** 修飾のない `entry` / `entry_id` / `entries` は判断ログの行(log entry)である ——
   `read_decision_log` の `entries`、`objection_raised` などの `entry_id`、kind `log_entry_displayed` が既にそう呼んでいる。
2. **記憶のエントリは、判断ログ側の面では `memory_entry` と書く。** 判断ログ側の面とは、判断ログの行の中(`decision_logged` の `judgment`、
   `list_precedents` の行)、判断の id の隣、kind が `memory_*` でない event のこと。`memory_*` の event と記憶の verb の中では今どおり `entry`
   と書く。名前に entry を含まないもの(`candidates`、Definition)は修飾しない。盤面が判断ログ側に書く文(判断の行の文、帰責の
   evidence、帰責の Board call の prompt)にも同じ規則を当て、記憶の側を `memory entry` / `memory entries` と書く。
3. **`memory_*` の event に判断ログの行が入るときは `log_entry_id` と書く。** 決定2 により `memory_*` の中の `entry` は記憶を指すので、
   判断ログの行のほうを修飾する。
4. **材料の記録(`meta_review_material_injected`)の配列の鍵は、持っている id の物を名指す。** 部分の名前がそれを名指していれば、そのまま
   にする。綴りは `<部分>_<id の物>_ids`。#2579 がコードのコメントに置いた規則(原則は部分の名前のまま、例外は別の鍵で引かれる借りた
   id と、同じ語の二義)を言い直したもので、routing の結果は変わらない。memory では `store_changes` が新たに改名の側に入る(記憶の
   エントリの id を持つが、名前は変更を指す)。
5. **当てはめ。**
   - `judgment.entry`、材料の `items[].entry`、`complete_memory_review` の項目の鍵 → `memory_entry`。`complete_memory_review` は
     meta-review の verb だが、同じ形の項目が判断の行(`decision_logged.judgment`)にそのまま記録されるので、判断ログ側として扱う。
     memory meta-review の判断の行の文(`left_as_is: entry #<id>`)も `memory entry #<id>` と書く(項目の名前は記憶の修理の拒否文と
     共有なので、拒否文も同じになる)
   - 帰責の門が書く evidence(`entry <id> was not read before the decision`、`it names no entry`)→ `memory entry`。帰責の Board call の
     prompt が記憶のエントリを指す `entries`(`written` の説明、`wrong_memory_entries` の説明)→ `memory entries`
   - `propose_from_material` の返り値の `entry_id` → `memory_entry_id`
   - `list_precedents` の `entries_read` / `entries_seen` → `memory_entries_read` / `memory_entries_seen`(#2577 はこの2つを残した。当時の範囲が
     同じ payload に並ぶ帰責の `entries` だけだったため)
   - `memory_draft_failed.entry_id` → `log_entry_id`
   - 材料の記録: `store_changes` → `changed_memory_entry_ids`、`precedent_entries`(memory と routing)→ `precedent_memory_entry_ids`、
     `proposal_entries` → `proposal_memory_entry_ids`、`branches` → `branch_definition_ids`
   - 決定1 により残すもの: RCA の purpose の `entry <id>:` と拒否文、人間の再撃ちの一覧の `entry`
6. **日本語の語との対応。** CONTEXT.md は判断ログの側を「行」(または「ログエントリ」)、記憶の側を「エントリ」と呼ぶ。英語の裸の
   `entry` は日本語の「行」に当たる。CONTEXT.md で判断ログの行の意味に使っていた裸の「エントリ」は「行」に直す(registry のエントリは別の語なので触らない)。

## 理由

- **向き。** 判断ログ側の裸の `entry_id` は5種の event、`read_decision_log` の鍵、kind 名 `log_entry_displayed` にある。記憶側で修飾が要るのは
  数か所だけである。#2577 の `wrong_memory_entries` も、#2285 が起草の記録に付けた `memory_event_id` も、記憶の側を修飾している。
- **`memory_draft_failed` に `decision_event_id`(`list_precedents` の呼び方)を採らない。** 起草は完了の行(`task_completed`)への異議からも
  立つので、decision では範囲が狭い。
- **費用。** 英語の `entry` と日本語の「エントリ」が別の物を指す、ねじれた対応になる。決定6 で CONTEXT.md にこの対応を書いて補う。

## 検討して採らなかった案

- **記憶を裸、判断ログの行を修飾する(`row` など)。** 日本語の語とは揃うが、判断ログ側の event 5種と wire をすべて書き換えることになる。
- **両方に接頭辞を付ける。** 費用は前の案と同じで、加えて `memory_*` の中の記憶の名前まで冗長になる。
