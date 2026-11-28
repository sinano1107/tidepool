# agent が名指した subagent 定義は、保護ブランチから盤面が許す鍵だけで組み直して worker に届ける —— 門の1周は `/implement` で回る

**Status 追記: 門の1周は subagent 定義を使わない —— 盤面の worker は `/implement` を使わず、実装専門の agent が装備した skill で書く([ADR 0447](0447-a-board-worker-does-not-run-implement-a-specialist-agent-implements-with-an-equipped-skill-and-review-perspectives-live-in-the-reviewers-definition.md)、2026-11-28、issue #4034)。この ADR の決定は、subagent 定義を worker に届けるときのものとして残り、門の後に回る(#4038)。冒頭の「門の1周は `/implement` で回る」の前提は ADR 0447 で置き換わった。**

2026-11-28 の grilling(issue #4038)で決定。門(#1879)の1周は、worker が `/implement` で tidepool 自身の issue を実装する形で
回すと決めた。`/implement` は実装を必ず `ponytail-implementer` に書かせ、選べなければ止まる(#4039)。

今の盤面はその定義を届けない。ADR 0354 決定2 は checkout の subagent 定義を全部名前で閉じ、Codex では project 層が trust され
ないので `.codex/agents` が載らない(#2987 の実測)。#2936 Q1 が届けない側を選んだ前提は「盤面の worker が `/implement` の実装者を
使う記録は無い」で、1周を `/implement` で回すと決めた時点で崩れた。

閉じた理由(定義の frontmatter が床の軸に触る)はそのまま残るので、届ける形はその理由に当たらないものにする。加えて、定義の中身は
`/implement` が必ず dispatch する実装者の指示で、`model` は財布に効く。worker が書き換えた定義が後続の worker に届けば、正当な
定義の顔をした指示が永続する。鍵を絞っても本文と `model` は残るので、届く定義は人間が書いた内容でなければならない。

## 決定

1. **届けてよい定義は、registry の agent 定義の任意欄 `subagents`(名前の列)が名指す。**
   - 欄が無ければ `[]` で、何も届けない。advisor の「欄が無い = 無効」と同じ形で、ADR 0025 決定1 が `skills` を必須にした理由
     (省略 = 全許可を潰す)はここに無い —— 省略は閉じる側に倒れる。
   - 列は agent 単位で1つ。同じ名前を Claude は `.claude/agents/**` の `name:`、Codex は `.codex/agents/**` の role の `name` から
     引く。
   - 保護ブランチに無い名前は何も届けない。許可リストは参照であって在庫の主張ではない(ADR 0025 決定2 の線 —— agent は複数の
     workspace を渡る)。Interview の面接室の保護ブランチには定義が無いので、受験者には何も届かない。
   - 届けなかった名前(保護ブランチに無い名前、決定4 の違反)は、名指されていても ADR 0354 決定2 の deny に残る。deny から外すのは
     盤面が組み直して渡す名前だけ。
   - built-in と同名でも、名指しは人間の選択なので届ける(ADR 0354 決定2 の「同名は閉じる側」は名指しの無い定義について残る)。
   - 名前は、CLI に渡すどの綴り(Claude の deny の token と `--agents` の鍵、Codex の `-c` の鍵)でも綴れ、Codex の `agents` 表の
     既存の欄と衝突しないこと。registry の書き込みと読み込みの両方で拒む(registry-edit PR は書き込みの門を通らない —— ADR 0040)。
   - `subagents` を空でない値にすることは危険な値の門に掛けない。届く定義は人間しか書けない内容で(決定3)、鍵は床の軸に触らない
     ものに絞られ(決定4)、同じ職能の軸の `skills` も掛からない。
2. **定義は workspace の保護ブランチから読み、task の checkout からは読まない。**
   - タスクブランチは worker の commit を含み、子タスクは親の完了の門より前の work branch の上で走る。checkout から読めば、worker が
     書き換えた定義が同じ木の後続の task に届く。
   - 盤面は自分の使い捨て GIT_DIR で読む(ADR 0356 の形)。読むのは pickup の fetch の後の保護ブランチの tip で、読んだ sha を spawn
     の記録に残す —— 写しは後から進むので、記録しなければ何が届いたかを辿れない。
   - tree の中の link や tree でない entry は辿らず、違反とする(決定4)。
   - CLI に checkout の file を読ませない形(決定5)と合わせて、盤面がどこから読むかで閉じる。#3759 の「保護ブランチに載った内容
     だけを読む」の一部を先に取る形で、`.tidepool/` への移設は門の後に回す。
3. **`.claude/agents/**` と `.codex/agents/**` は、ADR 0362 の人間しか書けない path に入る。**
   - 決定2 だけでは、worker の書き換えが着地して保護ブランチの正本になる。ADR 0395 決定4 の人間が merge する path では足りない ——
     `external` ダイヤルには掛からず、それ以外でも人間が merge question の差分で気づかなければ通る。ADR 0362 の完了の門は、ダイヤル
     にも Harness にも依らず、fork 元からの差分(plumbing で書いた commit を含む)で拒む。
   - ADR 0362 決定3 は `.claude/agents/*.md` を「人間の model が選んだときに効く repo 内容」として外していた。この ADR で盤面
     自身が後続の worker に届けるので、その前提が崩れる。人間しか書けない path の軸に、「CLI の起動時に実行される」に加えて
     「盤面が worker に届ける」が並ぶ。
   - 代償として、worker は subagent 定義を直せない。帰責が定義に落ちた修理子も、定義の書き換えは人間に回る。skills・CLAUDE.md は
     ADR 0362 決定3 のまま review の主題に残る(#4046)。
4. **名指した定義も、盤面が許す鍵の集合の外の鍵を持てば届けない。**
   - 許すのは、Claude が `name`・`description`・`model` と本文、Codex が `name`・`description`・`developer_instructions`。
   - ADR 0354 が退けた「届けて `permissionMode` だけを見る」は、床に触る鍵の列(denylist)を盤面が抱えて vendor の次の鍵を追う
     形だった。許す鍵の列なら vendor が足す次の鍵は閉じる側に落ちるので、その却下理由に当たらない。
   - Codex では vendor 自身が role の床に触る鍵(sandbox・approval・permissions・MCP・provider)を適用せずに捨てる(#2987 の実測と
     0.163.0 の source の読み)が、規則は両 Provider で揃える。
   - 同じ名前の定義が2つある、frontmatter / toml を解釈できない、link か tree でない entry である —— どれも違反とする。
5. **届ける定義は盤面が組み直して渡す。**
   - Claude は `--agents` で渡し、その名前を `Agent(<name>)` の deny から外す。同名なら flag の定義が checkout の定義に勝つ ——
     固定版 2.1.286 の binary の読みで、実装の受け入れで定義の中身の marker で実測する。勝てば checkout の file は隠れる。
   - Codex は spawn ごとに盤面が role file を書き、`-c agents.<name>.config_file=<絶対 path>` で渡す。file は ADR 0354 決定1 の
     config dir と同じく task temp の兄弟として sandbox の書き込みの外に置き、settle で消す。`--strict-config` の下で通ることは
     source の読みで、受け入れで実測する。
   - 組み直すので、検査の漏れや、検査と CLI の読みの間の書き換えは CLI に届かない。
   - どちらも CLI の版を上げるたびの検査に乗せる(Claude の同名の勝ち負け、Codex の role の `-c` が作る層)。版で勝ち負けや層が
     変われば、届く形が黙って変わるからである。
6. **検査は ADR 0040 の形に乗せる。**
   - 床は pickup の検査。名指している agent の task の pickup で、保護ブランチの定義を検査する。違反なら spawn せず、workspace を
     quarantine する(needs-human + 確認 question)。
   - boot 時に、登録済みの全 workspace へ同じ検査を掛ける。workspace の登録の門と registry の書き込みでも、即座に報せる。
   - spawn にも最後の線として同じ検査を残す。
   - 止める単位が workspace なのは、直す場所の一方が保護ブランチの定義(PR で直す)で、quarantine 解除の検証も workspace のもの
     だから —— session の途中や task ごとの spawn の失敗で人間に届くのを待たない。違反は「名指す agent × workspace」の性質なので、
     registry から名指しを外しても直る。解除の検証は、保護ブランチを fetch してから、今の registry で検査し直す。
7. **登録の門の live-checkout 信号(ADR 0354 決定3)は、`.codex/agents/*.toml` にも立て、文言を「agent が名指した定義だけが届く」
   に直す。** どの agent がどの定義を名指すかは registry にあって後から変わるので、登録時に名前ごとの届く・届かないは判定しない。

## 射程の境界

- **定義の本文が読ませる file は閉じていない。** `ponytail-implementer` の本文は `.agents/skills/ponytail/SKILL.md` と
  `CODING_STANDARDS.md` を先に読ませる。どちらもタスクブランチで worker が書き換えられ、後続の worker の指示の中身になる。
  CLAUDE.md・AGENTS.md・skill と同じ問いなので #4046 が持つ。

## 退けた形

- **task の checkout から読み、鍵の allowlist で床を守る(この grilling の初版)** —— 本文と `model` は鍵を絞っても残り、worker が
  タスクブランチに commit した定義が後続の worker に届く。床の軸だけでなく、財布と判断に効く。
- **ADR 0395 決定4 の外せない既定に足す(この grilling の第2版)** —— `external` ダイヤルには掛からず、それ以外でも止めるのは
  merge question の差分を見る人間の目である。
- **何を届けたかを記録しない(第2版)** —— 保護ブランチの写しは後から進むので、sha が無ければ届いた中身を辿れない。
- **`$CODEX_HOME/agents/` に置く** —— `--ignore-user-config` の下でも載るが、`CODEX_HOME` は盤面に1つなので全 agent の worker に
  届き、決定1 の agent ごとの名指しが崩れる。
- **検査だけして CLI に checkout の file を読ませる** —— 検査の漏れと、検査と読みの間の書き換えがそのまま CLI に届く。
- **名指しを盤面設定や workspace 側に置く** —— 前者は agent ごとの職能の差を書けず、後者は checkout が自分で開ける形になる。
- **検査を spawn だけに置く** —— 違反が task ごとの失敗と retry として積もり、人間が先に直せない。
- **定義を workspace の `.tidepool/` に移す(#3759)** —— 同じ軸を強めるが範囲が大きく、門の後に回す。

## 派生

- Status 追記: ADR 0354 決定2・3、ADR 0025(`subagents` 欄)、ADR 0362 決定3(人間しか書けない path の2つ目の軸)。
- GLOSSARY: Subagent、完了の門の人間しか書けない形。
- 同じ穴の別の面は派生 issue #4046(CLAUDE.md・AGENTS.md・skill と、定義の本文が読ませる file)。
- 実装は #4038 の agent brief。
