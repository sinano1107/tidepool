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

## 追記(2026-10-29 の triage、issue #2705)

決定1 の「repo が無ければ `mkdir -p` が通ることを確かめる」は、**まだ開いていない面接室**(event が無い、または event はあるが git の途中で
落ちてディレクトリだけが残った)のための線で、次の pickup が init する前提だった。`*_opened` event が残る面接室のディレクトリそのものが
無い —— 盤面に消す扉は無いので外部で消された —— 場合は別で、その面接室は記録(監査・異議・retry の新しい root が読む環境)であり、
盤面に作り直す材料が無い。今までは読む面接室の在り処を誰も確かめず(remote 追従の loop は面接室を対象外、実体の綴りへの解決は失敗を
握りつぶす)、無い path が sandbox の読みに入り、Harness は無い path を黙って skip する(上流の sandbox-runtime / codex の source と Claude の固定版 binary の文字列で読んだ範囲。
Codex の固定版は未確認)ので、root は根拠を読めないまま採点していた。

1. **読む面接室は pickup で repo の有無を確かめ、無ければその面接室の名前(root id)の quarantine に落ちる。** 対象は task が読みだけ
   開く面接室(root の根拠の面接室と retry 前の面接室、root 配下の review が読む root の面接室と根拠の面接室)。述語は在り処に `.git` が
   あること —— 起動時の sparse snapshot の掃除が「checkout が消えた」を同じ述語で判定しているのに揃える。止める単位・解除の形は
   ADR 0273 決定8・追記のまま(その面接室を開く task はすべて止まる)。root 自身の面接室と受験者の checkout は、開く手順の git が
   投げて同じ quarantine に落ちるので今までどおり。
2. **event が残る在り処のディレクトリが無い面接室の名前への回答は拒む。盤面は作り直さない。** 「記録が無いのに採点する」を盤面が既定で
   許さない(fail-closed)。出口は人間が在り処を復元するか、root を cancel するか、空の面接室で走らせると決めて手で作ること —— その手の
   操作と回答が記録になる。ディレクトリはあるが repo が無い名前の回答は決定1 のまま(`mkdir -p` が通ること)。init するのは root 自身の面接室を開く pickup だけで、決着した root の面接室
   (根拠の面接室・retry 前の面接室)を開く pickup は無いので、人間がディレクトリだけ作り直した根拠の面接室は次の pickup が決定1 の門で止まり直す ——
   そこへ repo を置く(`git init`)のも人間の手である。

退けた案:

- **実測を先に置く**(issue 本文の手順)—— CLI が無い path を skip しても spawn を拒んでも直す形は同じ pickup の門で、結果で形が
  変わらない。skip する方は上流の sandbox-runtime / codex の source と固定版 2.1.286 の binary の文字列で読めた。
- **回答の検査を今のまま(`mkdir -p` で受理)にする** —— 回答で空ディレクトリになり、根拠の無い採点が盤面の既定の経路になる。
- **回答時に盤面が空の repo を作り直す** —— 同じく既定で記録の欠落を埋めて走らせる形。
- **`safeRealpath` に投げさせる** —— 呼び手の残り(registry clone の比較、MCP の `real_environment`)は生 path の fallback が正しく、
  後始末も `taskRunPlace` を通るので投げる場所にできない(決定3)。

## 追記(2026-10-30 の grilling、issue #2724 / ADR 0329)

決定1 の「次の pickup が event を書く」と、上の追記 決定2 の3分岐(消えた・ディレクトリだけ・repo あり)は ADR 0329 で置き換わる —— 開いた
event は repo ができた後に書くので、分岐は「event あり → repo がある / event 無し → 番地を作れる」の2つになり、人間が `git init` を
要る場面を本文が言わない綻び(#2724)は消える。決定2・3 はそのまま。

## 追記(2026-10-30 の grilling、issue #2737 / ADR 0329 追記 決定8)

追記 決定1 の「述語は在り処に `.git` があること」は、読む面接室が走る面接室と同じ種類として同じ一覧(ADR 0329 追記 決定6)を撃つ形に移った。
`.git` の有無はその一覧の第1項として残り、`.git` がディレクトリであることなどが同じ門に並ぶ。止める単位・解除の形は変わらない。
