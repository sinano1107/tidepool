# advisor のペアリングは表で検証しない — 版依存の意味を持つ文字列を盤面が judge しない

issue #33 で決定。**この決定は issue #33 本文の実装メモ「モデルペアリング制約あり
…spawn 前に registry 側でも検証し、無効ペアは明確なエラーにする」を却下する。**
理由は下記のとおり、その検証が**正しくあり続けられない**ことにある。

## 決定

`AgentDefinition.advisor` は `model` と同格の**自由文字列**とし、値の妥当性も
main モデルとのペアリングも adapter は検査しない。`--advisor <値>` をそのまま
ピン留めし、判定は CLI に委ねる。

これは ADR 0005 の適用であって例外ではない。ADR 0005 は「CLI 側で値の集合が閉じて
いる場合にのみ adapter でバリデーションする」と決め、`--effort` の5値は enum で
検査し、`--model` は**開いた集合**なのでホワイトリストを作らないとした ——
「tidepool 側のホワイトリストが常に古くなり、正当な新モデル指定を誤って拒否する
リスクの方が、防ぎたかった安定性の欠如より実害が大きい」。`--advisor` の値集合は
`--model` と同じくエイリアスとフルネームから成る開いた集合である。

**advisor にはさらに強い理由がある: エイリアスの意味そのものがホストで変わる。**
2026-08-04 の実測で、同じ `--advisor opus` が CLI 2.1.207 では `claude-opus-4-8`、
2.1.221 では `claude-opus-5` に解決した(公式 docs も "These aliases resolve to
Claude Code's built-in default version for each model family, which advances with
new Claude Code releases" と明記)。つまり表を持てば、盤面は**自分が意味を知らない
文字列**を judge することになる。ペアリング可否は解決先で決まり、解決先は走らせる
ホストの CLI 版で決まるので、表は「今このホストで」しか正しくなく、しかも古くなった
ことを誰も気づけない —— 表のほうが先に陳腐化する。

「具体 id のときだけ検証する」も採らない。未知の具体 id は**通す**しかない(でなければ
新モデルを誤って弾く)ので、表が守れるのは「既に知っている組み合わせ」だけになり、
守備範囲が最も狭いところで最も陳腐化しやすいコードを抱えることになる。

**advisor == main の禁止も採らない。** 検証結果コメントはこれを実装時の判断として
残していた(禁じれば `spend` が常に分離できる)。しかし禁じられるのは**文字列の
一致**だけであり、`main: sonnet` × `advisor: claude-sonnet-5` は文字列としては
異なるまま同じモデルに解決される。分離不能なケースは残るので `spend: null` の枝は
どのみち実装する必要があり、この禁止が消せるコストは1つも無い。何も買わないガードは
無いほうがよい。

## 不在は「フラグを省く」では綴らない — ADR 0005 の読み替え

ADR 0005 は「agent 定義に値が無くても、spawn 時は常に既定値込みで明示的に CLI へ
渡す — CLI のデフォルト任せ(フラグ省略)にはしない」と決めている。advisor の不在は
その形では綴れない: `--model` には「値が無いなら `sonnet`」という**綴れる既定値**が
あるが、「advisor なし」に相当するモデル名は存在しないので、渡すべき値がそもそも無い。

ここで単に `--advisor` を省くと、ADR 0005 が塞いだはずの穴がそのまま開く ——
**ホストの設定が答えを決める**。実測(2026-08-04): workspace の checkout が持つ
`.claude/settings.json` の `advisorModel` は、本番と同じ `--setting-sources project`
の下で advisor を attach させる。registry が「advisor なし」と言っているセッションが
上位モデルを焼き、判断6 の記録は「advisor なし」と書いたままになる。
(`.claude/settings.json` は quarantine の spawn 時ガードが見る対象だが、見ているのは
`sandbox` / `permissions` だけ —— ADR 0037 —— で `advisorModel` は素通りする。)

したがって**不在は env で明示的に綴る**: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1`。
これは ADR 0005 の例外ではなくその目的の充足である —— 綴りがフラグ層から env 層へ
移るだけで、「ホストの状態が spawn の挙動を決めることを許さない」という要求は同じ
ように満たされる。同じ env を判断8 の kill switch も使う: 「このセッションに advisor は
無い」という状態の綴りは1つで、原因(capability が無い / ホストがマスクした)で
分かれない。

なお user tier(`~/.claude/settings.json`)の継承は `--setting-sources project`
だけで既に塞がっている(実測)。この env が買っているのは**それではなく** project
tier のほうである。

## 防げなくなるものと、その代わり

表を持たないので、以下は spawn するまで分からない:

- **未知のモデル / advisor になれないモデル**(`haiku` など)→ exit 1、stdout は
  完全に空、stderr に `Error: The model "haiku" cannot be used as an advisor.`
  (実測)。`worker_exited(exit_code: 1, usage: null, stderr_tail: …)` に落ち、
  slot は watchdog の `work` = 90分が回収して失敗 question になる。
- **能力不足の advisor**(main opus × advisor sonnet)→ **exit 0 で完走**し、
  stderr に警告1行を残して未 attach のまま終わる(実測)。盤面から見て成功
  セッションと区別が付かない。

前者の代償(agent.md の1行の綴り間違いが slot 90分)は、ADR 0005 が `model: bogus`
という**同じフラグの兄弟**に対して既に受け入れたものと同一である。ここだけ別扱いに
する根拠が無い。

後者はそもそも表では防ぎきれない —— 版ズレでエイリアスの解決先が動けば、書いた
時点で有効だったペアが後から無効になる。したがってこの形への唯一の防壁は**事前の
検証ではなく事後の観測**であり、それが判断6 の `worker_exited.usage.advisor` である:
相談が1本も観測されなければ `null` になり、`worker_spawned.advisor` が値を持つ
セッション群でその比率が落ちれば、盤面全体が未 attach になったことが統計として
現れる。予防できないものを検出可能にする、という置き換えである。

## Considered options

- **ペアリング表を adapter に持つ(実装メモの原案)** — 却下。表が judge する
  文字列の意味を盤面が所有していない(エイリアスの解決先はホストの CLI 版が決める)。
  表のほうが先に陳腐化し、しかも陳腐化を誰も観測できない。
- **具体モデル id のときだけ表で検証する** — 未知の id は通すしかないので、
  守れるのは既知の組み合わせだけ。最も狭い守備範囲で最も陳腐化しやすい。
- **spawn 時に探る(probe)** — 未知モデルは exit 1 で安く判るが、能力不足ケースは
  exit 0 で完走するため、probe が「attach されたか」を答えるには実際に1回相談させる
  必要がある。判定のために毎 spawn 1相談ぶんのコスト(実測 $0.2〜0.4)を払うのは、
  防ごうとしている損失より高い。
- **advisor == main を禁じる** — 文字列一致でしか禁じられず、エイリアスと具体 id の
  組み合わせをすり抜ける。`spend: null` の枝を消せないので、何も買わない。
