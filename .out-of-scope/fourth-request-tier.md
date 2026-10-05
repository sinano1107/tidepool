# 種の4段目(Haiku 4.5 / Luna の帯)

種の段は `economy` / `standard` / `frontier` の3つのままにし、Haiku 4.5 / Luna の帯の段と行を種に入れない。
ティアは盤面が持つ段の一覧なので(ADR 0200)、運用者が自分の盤面に下の段と行を足すことは範囲内である。範囲外なのは種だけ。

## なぜ範囲外か

表の行は「その model はそのティアの品質を満たす」という分類である(ADR 0114 決定2)。`/implementation-delegation` §4 / §5 は
Haiku 4.5 / Luna を rename・機械的置換・大量処理に置いている。この帯が worker session の手順(MCP verb で decision log を
書き、commit し、handoff を出す)を最後まで回せるかは測っていない。測っていない model を、配布物が worker の候補として
出荷しない。

段を足す理由は worker への要求だけである。表示時翻訳(Board call)の都合では足さない(ADR 0200 決定9)。

## 再開条件

#1415 の実測(Interview で `claude-haiku-4-5` / Luna を測る)の結果が「機械的な密度の仕事だけ通る」だったとき。
economy の密度も通るなら economy の行を足すだけで、段は増えない。手順を回せないなら、その結果をここに却下の理由として書く。

旧い再開条件(「Haiku 級で走らせたい task と economy で走らせたい task が同時にあることが観測されたとき」)は、要求ティアに
綴りが無く記録されえなかったので置き換えた(#1346)。

## Prior requests

- #553 — 価格帯は4段だがティアは3段 — 最下段(haiku / luna)に要求の綴りが無い
- #1346 — 再開条件はいまの機構で観測できない。段を盤面の一覧にし、再開条件を実測に置き換えた(ADR 0200)
