# 4段目の要求ティア(Haiku 4.5 / Luna の帯)

要求ティアは `economy` / `standard` / `frontier` の3段のままにし、Haiku 4.5 / GPT-5.6 Luna の帯に要求の綴りを与えない。
種の表にもこの2つの行は入れない。

## なぜ範囲外か

表の行は「その model はそのティアの品質を満たす」という分類である(ADR 0114 決定2)。`/implementation-delegation` §4 / §5 は
Haiku 4.5 / Luna を rename・機械的置換・大量処理に置き、MCP verb を通して decision log を書き commit する worker session の
仕事から外している。行を足すことは「worker session の品質を満たす」と言うことなので、そう置かれていないモデルに行は無い。

価格が行の属性になったので(ADR 0114)、4段目を退ける理由は「ティアの価格帯を壊す」ではなくなった。残る理由は1つ ——
「最下段と廉価を**同時に別々の要求として**出し分けたい場面」がまだ観測されていない。「もっと安く」だけなら、盤面の表の
economy 行を差し替えれば3段のまま届く(編集面は #545)。

盤面内の Haiku 利用(翻訳 client、CLI auth probe)は selector を通らない盤面自身の呼び出しで、要求の語彙とは別経路である。

## 再開条件

同一盤面で、worker session を Haiku 4.5 / Luna 級で走らせたい task と economy で走らせたい task が同時に存在し、
表の差し替えでは届かないことが観測されたとき。そのときは ADR 0110 決定2 / ADR 0114 の値域と、`TIERS`・3入口・
`execution_settings` の CHECK・学習器の文脈変数が一緒に動く。

## Prior requests

- #553 — 価格帯は4段だがティアは3段 — 最下段(haiku / luna)に要求の綴りが無い
