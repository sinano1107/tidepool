# 面接室・受験者の checkout の在り処は規約から導く —— `*_opened` event は実体の綴りの記録で、repo の無い在り処は後始末が触る checkout ではない

2026-10-19 の grilling(issue #2225 —— #2192 の code-review の残り)で決定。面接室(ADR 0273 決定1)と受験者の checkout(ADR 0276 決定1)は
`mkdir` → `realpath` → `*_opened` event → git の順に開き、quarantine の回答の検査と後始末は在り処を event からだけ引いていた。
`mkdir` が落ちる(規約の基点がディレクトリでない・書けない、その番地に異物がある)と event が無く、pickup は面接室(root id)の
workspace quarantine に落ちるが、回答の検査は在り処を引けずに拒み(purely-local の盤面では既定 workspace を検査して通す)、
後始末は `taskRunPlace` で投げて落ちた後始末 = 盤面全体の停止(ADR 0112)になる。この停止は回答でも cancel でも解けない —— 解放の門は
後始末の再実行で、同じ所で投げる。実測の表は #2225 のコメントに置く。

## 決定

1. **在り処は規約(基点 + task id)から導く。event は実体の綴りの記録である。** 回答の検査と後始末は、名前が Interview の root の id なら
   event の有無に依らず `conventionCheckoutPath(id)` を在り処として扱い、root id の名前を workspace の resolver には落とさない(purely-local
   の fallback が既定 workspace を返す)。event は今までどおり `mkdir` の後に実体の綴りで書き、root の cwd・sandbox の読み・`read_paths` の
   正本であり続ける —— `realpath` は存在を要るので先には書けず、ADR 0113 決定3「導く、保存しない」と、`path` 省略の登録 workspace を
   毎回基点から導く ADR 0018 の線に揃える。回答の検査は、在り処に repo があれば今までの workspace の検査、無ければ「盤面がその番地を
   作れる(`mkdir -p` が通りディレクトリである)」を確かめる。次の pickup が event を書く。
2. **止める単位は面接室(root id)のまま。** 基点そのものに書けない形でも、既存 checkout の登録 workspace は走り続けるので盤面全体の停止
   (CONTEXT.md の線「止められるより狭い資源が存在するか」)ではなく、基点を9つ目の資源にもしない —— Interview の root は人間が登録する
   少数で、並んだ root の数だけ同じ理由の quarantine が立つことを受け入れる。積み上がりが観測されたら資源に切り出す。
3. **導いた在り処に repo が無い Interview の場所は、process を持たなかった session の後始末にとって「触る checkout が無い」である。**
   ADR 0274 決定3 / #2255 の drift の枝と同じで、退避・tree rule・休止位置を撃たず、印を消して slot を解放し pickup の契機だけ撃つ。
   ADR 0112 決定3 の「盤面のコードが直るまで動かないのは正しい」は盤面コードの欠陥に当たる文で、未記録の場所で投げるのがその欠陥である。

## 退けた案

- **mkdir の前に event を書く** —— 実体の綴りを運べず、cwd と sandbox の読みの一致(#1954)を別の場所でやり直す。
- **event を廃して全部導く** —— 基点が変わると控えの無い旧い面接室(監査・retry が読む)が見えなくなる。
- **#2255 の spec に上書きコメントで足す** —— 並行実装中で、拾われる保証が無く、拾われれば spec と実装の両方が動く。#2225 の実装が
  #2255 の merge 後にその枝を広げる。
