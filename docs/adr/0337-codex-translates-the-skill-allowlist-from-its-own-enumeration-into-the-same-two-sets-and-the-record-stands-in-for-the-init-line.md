# Codex は自身の列挙の scope から skill allowlist を同じ2集合へ翻訳し、観測で確かめた許可集合が init 行の代わりを務める

**Status 追記: 決定4 の「本文はその行の `aggregated_output`(worker が実際に読んだ文面)」は [ADR 0340](0340-a-followed-skill-row-carries-the-text-that-reached-the-worker-and-the-action-it-came-from-and-does-not-claim-to-be-the-skills-text.md) で「その行で worker に届いた文」に読み替える** —— `cat` の全文も `python3` の加工後も `wc` の数値も同じ述語に当たり(#2817 の実測)、記録は出力が skill の文面であるとは主張せず、行の `command` を出所として添える。述語(全行を数える)は変えない(2026-11-01、issue #2818)。

2026-11-01 の grilling(issue #2689、#2682 / ADR 0325 の派生)で決定。Codex worker は v1 の契約「skill 0件」(#195 / ADR 0098 決定7)のまま
`skills/list` が返した path を全部閉じ(ADR 0259 決定2)、経路の能力表の `openai: { skills: false }`(ADR 0116)が allowlist を持つ agent を
Codex に割り当てさせなかった。tako / fugu / 組み込み agent は全部 `@workspace` なので、Codex worker は門(#1879)の時点で1体も走れない。
ADR 0335 決定5 が Codex の scope の対応(`system` → 同梱、`repo` かつ実体が checkout の下 → 運ぶ、それ以外は閉じる)を置き、翻訳の形は
ここで決める。Codex 0.163.0 の実測(skill の本文は `command_execution` の `aggregated_output` に逐語で残る、`$名前` の mention は stdout に何も
残さない)の表・`file:line`・未測の範囲は #2689 のコメントに置く。

## 決定

1. **skill の提供は経路の能力ではない。** 能力表の `skills` 列と登録拒否「does not offer skills in v1」を消し、ADR 0116 決定1 の省略の
   展開は「盤面が知る Provider 全部」に縮む(advisor の列は残る)。省略した agent(組み込みの auditor / interviewer を含む)は Codex にも乗る。
2. **翻訳は Codex 自身の `skills/list` 1回から、名前・`scope`・path で行い、列挙の `enabled` は見ない。** 列挙の `enabled` は盤面所有の
   `config.toml` の写しで worker は `--ignore-user-config` で読まない(#893)。許可 = ADR 0335 決定1 の解決 ∩ **spawn 設定を当てた観測で
   `enabled: true` と答えた集合**。deny は列挙 − 許可を path で閉じる(ADR 0033 の線のまま)。記録は `worker_spawned.skills = { workspace, host,
   permitted }`(ADR 0335 決定3)に Codex だけ `paths: { [name]: path }` を足す —— 投影が path で結ぶため。`skills: []` の agent でも列挙は撃つので
   `workspace` / `host` は埋める(Claude の `host: []` は ping が無いからであって、空に揃える規則ではない)。
3. **封じ込めの述語は「盤面が閉じた path がすべて `enabled: false`」に改める(ADR 0259 決定3 の改定)。** 許した path が開いていることは
   封じ込めの性質ではない。述語の持ち主は1関数で、spawn は allowlist の deny 集合を、quarantine の回答時の再検査と版上げの適合試験は列挙の
   全部を渡す(agent に依らない placeholder のまま)。
4. **Codex の Episode の「見た集合」は記録の `permitted` で、従った skill は許した path を `command` に含む `command_execution` の完了行。**
   Codex の stdout に `init` 行相当は無い。ADR 0325 決定2 が盤面の列挙を退けたのは Claude の列挙に worker が見ない user 層の名前が混ざる
   からで、ここで使うのは同じ cwd・同じ `--strict-config` の spawn 設定を当てた観測であり、決定2 の交差で worker に載らない名前は落ちている。
   判事の入力は Claude と同じ式で非 null。本文はその行の `aggregated_output`(worker が実際に読んだ文面)で、path の一致だけで結び、dir 名や
   frontmatter から名前を引かない。Codex では本文は注入でなく worker が読むが、文面の持ち主(workspace / ベンダー)と cause の語彙は変えない。
5. **同梱 skill を許した spawn に限り、sandbox の read に `$CODEX_HOME/skills/.system` を足す。** Codex はモデル自身が sandbox の中で SKILL.md を
   `cat` する(Claude は CLI が外で読んで注入する —— ADR 0335 決定3 が `skillReadPaths` を消せた理由)。`CODEX_HOME` の root は `auth.json` を
   持つので開けず、`user` scope の skill は `.system` の兄弟なので読めないまま。
6. **名前指定の skill がその Harness の列挙に無い形に新しい門は置かず、置き方は workspace の規約、Harness 固有の skill を持つ agent は
   `provider` を明示して固定する。** 無い名前は ADR 0335 決定1 で既に閉じ、`permitted` に載らないことが観測(ADR 0025 決定2「参照であって
   在庫の主張ではない」のまま)。SKILL.md は両 CLI が読む同じ形式で中間表現は既にあり、「変換」は checkout 内の symlink 1本(tidepool 自身の
   形: 実体 `.agents/skills/<name>`、`.claude/skills/<name>` は相対 link、frontmatter の `name` = dir 名、入れ子なし)。Harness で指示文が
   違いうることは CLAUDE.md / AGENTS.md と同じで設計が既に受け入れており(ADR 0291 決定3)、`provider` 省略は「どの Provider でも同じ性質で
   走る」を author が引き受ける綴り(ADR 0116 決定1)。

## 退けた形

- **列挙に無い名前指定で spawn_failed / pickup の経路除外 / 登録拒否** —— 登録時は checkout に依るので判定できず、pickup の門は head ごとの
  app-server(ADR 0259 の退けた案)、spawn_failed は Claude 側も巻き込んで ADR 0025 決定2 を反転する。
- **盤面が Provider 間で skill を変換する・`.tidepool/` の共通置き場から配る** —— 探索の規則を盤面に写し(ADR 0025 決定4 / ADR 0259 決定2)、
  盤面が workspace 面の書き手になる。checkout の外の本文は ADR 0335 が閉じた形そのもの。
- **両置き場の本文の一致を盤面が検査する** —— 探索の写しに戻り、CLAUDE.md / AGENTS.md にも同じ検査が要る。
- **Codex の判事の入力を null(不明)にする** —— 全 session で skill の帰責が消える。
- **`@host` を Codex では inert のままにする** —— 記録の `permitted` が読めない本文を見た集合として主張する。
- **`aggregated_output` の frontmatter や path の dir 名から名前を引く** —— Codex は frontmatter で名乗り、部分読みでは frontmatter が無い。
  結ぶ鍵は記録の path だけ(ADR 0083 の線)。
