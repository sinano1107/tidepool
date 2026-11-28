# agent が名指した subagent 定義は、盤面が許す鍵だけで組み直して worker に届ける —— 門の1周は `/implement` で回る

2026-11-28 の grilling(issue #4038)で決定。門(#1879)の1周は worker が `/implement` で tidepool 自身の issue を実装する形で
回すと決め、`/implement` は実装を必ず `ponytail-implementer` に書かせ、選べなければ止まる(#4039)。ADR 0354 決定2 は checkout
の subagent 定義を全部名前で閉じ、Codex では project 層が trust されないので `.codex/agents` が載らない(#2987 の実測)。#2936 Q1
が届けない側を選んだ前提 ——「盤面の worker が `/implement` の実装者を使う記録は無い」—— は、1周を `/implement` で回すと決めた
時点で崩れた。閉じた理由(定義の frontmatter が床の軸に触る)はそのまま残るので、届ける形はその理由に当たらないものにする。

## 決定

1. **届けてよい定義は、registry の agent 定義の任意欄 `subagents`(名前の列)が名指す。** 欄が無ければ `[]` で何も届けない
   (advisor と同じ「欄が無い = 無効」。ADR 0025 決定1 が `skills` を必須にしたのは「省略 = 全許可」を潰すためで、ここでは省略は
   閉じる側に倒れる)。列は agent 単位で1つで、同じ名前を Claude は checkout の `.claude/agents/**` の `name:`、Codex は
   `.codex/agents/**` の role の `name` から引く。checkout に無い名前は何も届けない —— 許可リストは参照であって在庫の主張ではない
   (ADR 0025 決定2 の線。agent は複数の workspace を渡る)。名指しの無い定義は ADR 0354 決定2 のとおり閉じる。
2. **名指した定義も、盤面が許す鍵の集合の外の鍵を持てば届けない。** 許すのは Claude が `name`・`description`・`model` と本文、
   Codex が `name`・`description`・`developer_instructions`。ADR 0354 が退けた「届けて `permissionMode` だけを見る」は、床に触る
   鍵の列(denylist)を盤面が抱えて vendor の次の鍵を追う形だった。許す鍵の列なら vendor が足す次の鍵は閉じる側に落ちるので、
   その却下理由に当たらない。Codex では vendor 自身が role の床に触る鍵(sandbox・approval・permissions・MCP・provider)を適用
   せずに捨てる(#2987 の実測と 0.163.0 の source の読み)が、規則は両 Provider で揃える。
3. **検査は ADR 0040 の形に乗せる。** 床は pickup の検査で、名指している agent の task の pickup で checkout の定義を検査し、
   違反なら spawn せず workspace を quarantine する(needs-human + 確認 question)。boot 時に登録済みの全 workspace へ同じ検査を
   掛け、workspace の登録の門と registry の書き込みでも即座に報せる。spawn にも最後の線として同じ検査を残す。止める単位が
   workspace なのは、直す場所が checkout の定義(PR で直す)で、quarantine 解除の検証も workspace のものだから —— session の
   途中や task ごとの spawn の失敗で人間に届くのを待たない。
4. **届ける定義は盤面が組み直して渡し、CLI に checkout の file を読ませない。** 中身の出所は checkout の file(人間の merge を
   通った内容)で、盤面は許す鍵だけを写す。Claude は `--agents` で渡し、その名前を `Agent(<name>)` の deny から外す —— 同名なら
   flag の定義が checkout の定義に勝つ(固定版 2.1.286 の binary の読み)ので checkout の file は隠れる。Codex は spawn ごとに盤面が
   role file を書き、`-c agents.<name>.config_file=<絶対 path>` で渡す。file は ADR 0354 決定1 の config dir と同じく task temp
   の兄弟として sandbox の書き込みの外に置き、settle で消す。組み直すので、検査の漏れや検査と CLI の読みの間の書き換えは CLI に
   届かない。
5. **登録の門の live-checkout 信号(ADR 0354 決定3)は立てる条件を変えず、文言を「agent が名指した定義だけが届く」に直す。**
   どの agent がどの定義を名指すかは registry にあって後から変わるので、登録時に名前ごとの届く・届かないは判定しない。

## 退けた形

- **`$CODEX_HOME/agents/` に置く** —— `--ignore-user-config` の下でも載るが、`CODEX_HOME` は盤面に1つなので全 agent の worker に
  届き、決定1 の agent ごとの名指しが崩れる。
- **検査だけして CLI に checkout の file を読ませる** —— 検査の漏れと、検査と読みの間の書き換えがそのまま CLI に届く。
- **名指しを盤面設定や workspace 側に置く** —— 前者は agent ごとの職能の差を書けず、後者は checkout が自分で開ける形になる。
- **検査を spawn だけに置く** —— 違反が task ごとの失敗と retry として積もり、人間が先に直せない。
- **定義を workspace の `.tidepool/` に移し保護ブランチの内容だけを読む(#3759)** —— 同じ軸を強めるが範囲が大きく、門の後に回す。

## 派生

- Status 追記: ADR 0354 決定2・3、ADR 0025(`subagents` 欄)。
- GLOSSARY: Subagent(名指した定義だけが許す鍵だけで届く)。
- 実装は #4038 の agent brief。受け入れ条件に、Claude で同名の勝ち負けを定義の中身の marker で確かめること(init の `agents` は
  同名を1件しか出さず、`Agent(<name>)` の deny も反映しない)と、Codex で `--strict-config` の下で `agents.<name>.config_file` が
  通ることの実測を持たせる(どちらも今は binary / source の読み)。
