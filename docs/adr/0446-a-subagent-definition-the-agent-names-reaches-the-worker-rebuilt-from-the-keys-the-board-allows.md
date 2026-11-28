# agent が名指した subagent 定義は、保護ブランチから盤面が許す鍵だけで組み直して worker に届ける —— 門の1周は `/implement` で回る

2026-11-28 の grilling(issue #4038)で決定。門(#1879)の1周は、worker が `/implement` で tidepool 自身の issue を実装する形で
回すと決めた。`/implement` は実装を必ず `ponytail-implementer` に書かせ、選べなければ止まる(#4039)。

今の盤面はその定義を届けない。ADR 0354 決定2 は checkout の subagent 定義を全部名前で閉じ、Codex では project 層が trust され
ないので `.codex/agents` が載らない(#2987 の実測)。#2936 Q1 が届けない側を選んだ前提は「盤面の worker が `/implement` の実装者を
使う記録は無い」で、1周を `/implement` で回すと決めた時点で崩れた。

閉じた理由(定義の frontmatter が床の軸に触る)はそのまま残るので、届ける形はその理由に当たらないものにする。加えて、定義の中身は
`/implement` が必ず dispatch する実装者の指示で、`model` は財布に効く。worker が書き換えた定義が後続の worker に届けば、正当な
定義の顔をした指示が永続する。鍵を絞っても本文と `model` は残るので、届く定義は人間の merge を通った内容だけでなければならない。

## 決定

1. **届けてよい定義は、registry の agent 定義の任意欄 `subagents`(名前の列)が名指す。**
   - 欄が無ければ `[]` で、何も届けない。advisor の「欄が無い = 無効」と同じ形で、ADR 0025 決定1 が `skills` を必須にした理由
     (省略 = 全許可を潰す)はここに無い —— 省略は閉じる側に倒れる。
   - 列は agent 単位で1つ。同じ名前を Claude は `.claude/agents/**` の `name:`、Codex は `.codex/agents/**` の role の `name` から
     引く。
   - 保護ブランチに無い名前は何も届けない。許可リストは参照であって在庫の主張ではない(ADR 0025 決定2 の線 —— agent は複数の
     workspace を渡る)。
   - built-in と同名でも、名指しは人間の選択なので届ける(ADR 0354 決定2 の「同名は閉じる側」は名指しの無い定義について残る)。
   - 名指しの無い定義は ADR 0354 決定2 のとおり閉じる。
2. **定義は workspace の保護ブランチの commit から読み、task の checkout からは読まない。** タスクブランチは worker の commit を
   含み、子タスクや再実行はその上で走るので、checkout から読めば worker が書き換えた定義が同じ木の後続の task に届く。盤面は自分の
   使い捨て GIT_DIR で保護ブランチの内容を読む(ADR 0356 の形)。CLI は checkout の file を読まない(決定5)ので、盤面がどこから
   読むかで閉じる。#3759 の「保護ブランチに載った内容だけを読む」の一部を先に取る形で、`.tidepool/` への移設は門の後に回す。
3. **`.claude/agents/**` と `.codex/agents/**` は、ADR 0395 決定4 の人間が merge する path の外せない既定に入る。** 決定2 だけでは、
   無人 merge で保護ブランチに載った定義を正本として読む。両方そろって、届く定義は人間の merge を通った内容になる。
4. **名指した定義も、盤面が許す鍵の集合の外の鍵を持てば届けない。**
   - 許すのは、Claude が `name`・`description`・`model` と本文、Codex が `name`・`description`・`developer_instructions`。
   - ADR 0354 が退けた「届けて `permissionMode` だけを見る」は、床に触る鍵の列(denylist)を盤面が抱えて vendor の次の鍵を追う
     形だった。許す鍵の列なら vendor が足す次の鍵は閉じる側に落ちるので、その却下理由に当たらない。
   - Codex では vendor 自身が role の床に触る鍵(sandbox・approval・permissions・MCP・provider)を適用せずに捨てる(#2987 の実測と
     0.163.0 の source の読み)が、規則は両 Provider で揃える。
   - 同じ名前の定義が2つあれば、どちらを組み直すか決まらないので違反とする。
   - 名前は、CLI に渡すどの綴り(Claude の deny の token と `--agents` の鍵、Codex の `-c` の鍵)でも綴れ、Codex の `agents` 表の
     既存の欄と衝突しないこと。違反は registry の書き込みで拒む。
5. **届ける定義は盤面が組み直して渡し、CLI に checkout の file を読ませない。**
   - Claude は `--agents` で渡し、その名前を `Agent(<name>)` の deny から外す。同名なら flag の定義が checkout の定義に勝つ
     (固定版 2.1.286 の binary の読み)ので、checkout の file は隠れる。
   - Codex は spawn ごとに盤面が role file を書き、`-c agents.<name>.config_file=<絶対 path>` で渡す。file は ADR 0354 決定1 の
     config dir と同じく task temp の兄弟として sandbox の書き込みの外に置き、settle で消す。
   - 組み直すので、検査の漏れや、検査と CLI の読みの間の書き換えは CLI に届かない。
6. **検査は ADR 0040 の形に乗せる。**
   - 床は pickup の検査。名指している agent の task の pickup で、保護ブランチの定義を検査する。違反なら spawn せず、workspace を
     quarantine する(needs-human + 確認 question)。
   - boot 時に、登録済みの全 workspace へ同じ検査を掛ける。workspace の登録の門と registry の書き込みでも、即座に報せる。
   - spawn にも最後の線として同じ検査を残す。
   - 止める単位が workspace なのは、直す場所が保護ブランチの定義(PR で直す)で、quarantine 解除の検証も workspace のものだから
     —— session の途中や task ごとの spawn の失敗で人間に届くのを待たない。
7. **登録の門の live-checkout 信号(ADR 0354 決定3)は、立てる条件を変えず、文言を「agent が名指した定義だけが届く」に直す。**
   どの agent がどの定義を名指すかは registry にあって後から変わるので、登録時に名前ごとの届く・届かないは判定しない。

## 退けた形

- **task の checkout から読み、鍵の allowlist で床を守る(この grilling の初版)** —— 本文と `model` は鍵を絞っても残り、worker が
  タスクブランチに commit した定義が後続の worker に届く。床の軸だけでなく、財布と判断に効く。
- **`$CODEX_HOME/agents/` に置く** —— `--ignore-user-config` の下でも載るが、`CODEX_HOME` は盤面に1つなので全 agent の worker に
  届き、決定1 の agent ごとの名指しが崩れる。
- **検査だけして CLI に checkout の file を読ませる** —— 検査の漏れと、検査と読みの間の書き換えがそのまま CLI に届く。
- **名指しを盤面設定や workspace 側に置く** —— 前者は agent ごとの職能の差を書けず、後者は checkout が自分で開ける形になる。
- **検査を spawn だけに置く** —— 違反が task ごとの失敗と retry として積もり、人間が先に直せない。
- **定義を workspace の `.tidepool/` に移す(#3759)** —— 同じ軸を強めるが範囲が大きく、門の後に回す。
- **何を届けたかを spawn の記録に足す** —— 中身は保護ブランチの commit から辿れ、使ったことは transcript の Agent 呼び出しに出る。

## 派生

- Status 追記: ADR 0354 決定2・3、ADR 0025(`subagents` 欄)、ADR 0395 決定4(外せない既定)。
- GLOSSARY: Subagent。
- 同じ穴の別の面(CLAUDE.md・AGENTS.md・`@workspace` の skill をタスクブランチに commit した内容が、同じブランチの後続の
  worker に注入される疑い)は派生 issue #4046。worker が正当に編集するファイルなので、この ADR の形がそのまま当てはまるとは限らない。
- 実装は #4038 の agent brief。受け入れ条件に次の2つの実測を持たせる(どちらも今は binary / source の読み)。
  - Claude で、同名の勝ち負けを定義の中身の marker で確かめる(init の `agents` は同名を1件しか出さず、`Agent(<name>)` の deny も
    反映しない)。
  - Codex で、`--strict-config` の下で `agents.<name>.config_file` が通る。
