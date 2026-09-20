# Board call は呼び出しごとの容器の中で起き、「孤児を残さない」は記録された不変条件になる

2026-09-21 の grilling(issue #460)で決定。ADR 0099 決定8 が範囲外に分けた Board call の子 process の回収を決める。「孤児を残さない」は issue #81 の受け入れ基準とコードコメントにしか根拠が無いまま、issue #741 では teardown の SIGKILL を外す案を退ける盾として既に決定のように働いていた。加えて実測(issue #460 のコメントに置く)で、skill 列挙の probe は model turn を立てないのに task workspace の設定が持ち込んだ MCP server を workspace の中に立て、stdin の EOF を無視する子は root の SIGKILL 後にも**自然終了後にも**残ることが分かった — 「短命な probe だから弱い床で足りる」の前提はこの呼び出しには成り立たない。

## 決定

1. **不変条件: 盤面が Board call のために起こした process は、その呼び出しより長生きしない。** 守るのはホスト資源の衛生(常駐ホストでは漏れが積もる)と、workspace を cwd にする probe の残存が次の worker と同居しないこと(ADR 0099 決定4 と同じ汚染クラス)。
2. **範囲は Board call の全部。** kill 経路を持つ probe だけでなく、答えを取りに行く呼び出しも同じ1つの spawn の口を通る。床は構成で成立させる — 新しい Board call が増えるたびに誰かが kill を正しく書くことに依存しない(ADR 0099 決定2 と同じ論法)。
3. **機構は ADR 0099 の容器機構をそのまま使う。** 容器は呼び出し1回につき1つ。Board call 全体で常設の1つにはしない(呼び出しは重なるので空を観測できない)。skill 列挙を task の worker session の容器に入れる例外も置かない — 残存を抱えたまま worker が走る状態が正常になり、回収失敗の原因が probe か worker か区別できなくなる。
4. **口の契約は「容器 + 時間上限 + 上限で強制回収」。** 上限の無い呼び出しは force を撃つ契機を持たず、容器に入れても populated のまま残りうるので、上限は別件ではなく口の一部である。
5. **root の exit を見たら強制回収を撃つ**(ADR 0109 決定4 の形)。結果は root の exit で返してよい — 答えの正しさは残存の有無で変わらない。**workspace を cwd にする呼び出しだけは回収済み観測のあとに返す** — 門を launch の直前に置くのが最も狭い。
6. **空を観測できなかったときの停止範囲は盤面全体**(既存の Containment quarantine)。cwd では線を引かない — 容器への kill が効かない process が居る事実は cwd が何であってもホスト規模であり、残存が書ける先は cwd に限られない。
7. **容器の機構前提が不成立の platform では Board call も起こさない。** 新しい停止機構は足さない。容器なしで起こすのは ADR 0099 決定5 が禁じた「黙って弱い回収へ落とす」そのものである。人間面の閲覧と操作は開いたまま。
8. **usage TUI の teardown から root への直接 SIGKILL を外す。** Ctrl-C×2 → root の exit を短く待つ → 出なければ強制回収。SIGKILL の唯一の根拠だった「捕捉不可にして孤児を防ぐ」は容器が引き受けた。issue #741 の症状がこれで消えるかは未確認で、そちらの観測に委ねる。
9. **Board call 用の contract suite は足さない。** 機構が同じなので証明も ADR 0099 決定5 の1本で足りる。Board call 側で固定するのは「口が容器を通ること」で、入り方が違う pty 経路はその確認を実装の受け入れ基準に持つ。
10. **用語: 「Worker 容器」を「容器」に改める。** 単位が worker session と Board call の2つになった。別項を立てると同じ3語彙(graceful / force / reclaimed)を二度書いて片方が古くなる。

## Considered options

- **Board call 用の弱い床(process group への kill)** —— 実測では子孫は全員 spawner と同じ pgid に居たので今日の CLI には効く。ただし Board call に敵対的子孫が居ないのは「空のツール面・model turn なし」という今日の CLI の性質であって盤面が置いた保証ではなく、workspace 由来の任意の MCP server が `setsid` しないことにも依存する。回収機構と証明が2本になる費用にも見合わない。
- **root への SIGKILL のまま基準の文言を下げる** —— 実測で残存が確認された以上、基準ではなく観測を否定することになる。
- **停止範囲を workspace cwd の呼び出しに限る** —— 決定6 のとおり、cwd は残存の届く範囲を限らない。
