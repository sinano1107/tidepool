# WIP の退避は段で帰責する —— worktree は盤面所有の repo に stage し、名前の場所へは fetch で運ぶ

2026-11-10 の grilling(issue #3141 / #3142、#3117 の実装とレビューの派生)で決定。ADR 0364 決定2 は worker の tip の転送を3段(写す段 /
写しを作る host / 名前の場所へ fetch する段)に分けて帰責したが、同じ解放の次の手である WIP の退避には分割が入っていなかった。ADR 0356
決定3 の view は `add -A` 1手で worker の worktree を読みながら**名前の場所の objects に直接書く**ので、落ちたときにどちらの故障かを型で
言えない。呼び手は推測で分類していた —— 決着していない task の解放は全部を worker の repo の故障(task の失敗)に包み、名前の場所の
書き込み失敗も worker のせいになる(ADR 0364 が fetch で消した #3061 の形)。完了済みで門の掛からない解放は素の失敗を全部名前の場所の quarantine にし、同じ原因でも型付きの失敗(gitlink の釘)なら観測になって割れる。
この quarantine は誰も決めていない写しである —— ADR 0364 決定2 が決めたのは host の失敗だけで、#3053 の spec は「読めれば今日どおり
退避する」としか言っていない。#3141 と #3142 は、worker の tree の形だけで `add -A` が落ちるこの1つの口の2つの形だった。実測の表・
到達する役の棚卸し・`file:line` は #3141 のコメントに置く。

## 決定

1. **WIP の退避は3段で帰責する(ADR 0364 決定2 と同じ線)。** worktree を盤面所有の repo に stage して tree を書き、gitlink の釘
   (ADR 0365 決定3)をそこで確かめる段の失敗は worker の repo の故障。その repo を作る host の失敗は `TaskCheckoutHostError` の線。
   盤面所有の repo から名前の場所へ運び ref を書く段の失敗は名前の場所の側。worker の段が落ちたとき、名前の場所には object が1つも
   書かれない。**除外の列を導くために worktree を読む手(shadow 残骸の `lstat`)も worker の段に入る** —— 段の外に置くと、worker が
   祖先を自分への symlink にしただけで(`ELOOP`)型の無い失敗になり、決着していない work の解放でも名前の場所が quarantine される。
   名前の場所の記録を読んで除外を導く手は今日どおり名前の場所の側(ADR 0360 Status 追記、#3111)。**出題の写し**(ADR 0273 決定1)も
   同じ view で worktree を記録に書くので同じ3段で、verb の時点なのでどの段の失敗も資源を止めず拒むだけ(ADR 0359 決定4)。
2. **`add -A` が落ちる worktree の形を除外の列に足さない。** 記録に書けない形(base の file の path に置いた commit の無い入れ子の repo、
   隠す path の祖先を symlink にした tree)は worker の repo の故障である。除外すれば base の値が黙って残り(ADR 0365 の Status が gitlink で
   退けた形)、隠す path と symlink の祖先は1つの tree に共存できない(ADR 0360 決定3 の「隠せない形は書き手の軸で止める」)。
3. **完了済みの解放で worker の段が落ちたら「読めない」観測である(ADR 0359 決定3・5)。** 名前の場所は quarantine せず、
   checkout は解放の最後の step で消す —— 同じ解放で tip を写す段が落ちた場合と同じ扱い。名前の場所は汚れておらず、人間が修理するものが無い。
4. **決着していない task の解放で名前の場所へ運ぶ段が落ちたら、名前の場所の quarantine である。** task は失敗にせず、checkout は残す ——
   tip の fetch の失敗(`NamedPlaceFetchError`)と同じ。書けないのは名前の場所で、retry は同じ場所で落ちる。
5. **運ぶ手は fetch。** WIP の commit は盤面所有の repo で作り、`fetchWorkerTip` と同じ手・同じ flags で運ぶ。ADR 0364 決定3 の有界の
   対象(盤面所有の写しからの fetch)にそのまま入り、上限超過は worker の repo の故障のまま。

名指す代償: 退避は object を2回書く。大きい untracked file では時間がおよそ2〜3倍になり(200MB 1つで 6 秒 → 17 秒、macOS git 2.47)、
tmp と名前の場所の両方に disk が要る。上限(ADR 0357 決定5)の値は実装で測り直す。

## 退けた形

- **解放の catch の分類だけを直す**(#3141 / #3142 のコメントの見立て)—— 1手が読みと書きを兼ねたままでは、名前の場所の書き込み失敗と
  worker の tree の失敗が同じ「`add -A` の非0終了」で、分類の入力が stderr の文面しか無い。
- **落ちる形を1つずつ除外に足す** —— 決定2。除外の綴りは denylist で、#3117 の後も2形が残っていた。
- **index-pack で運ぶ** —— 大きい WIP では速いが、1行の変更でも解放ごとに pack が1つ増え、運ぶ手が2種類になる。
- **tip の fetch と WIP を1回の fetch に畳む** —— 運ばない path を導く読みが名前の場所に着いた tip を要る(ADR 0360 Status 追記、#3111)。
  順序を入れ替える費用で得るのは fetch 1回ぶん。

## 派生

- Status 追記: ADR 0356 決定2・3、ADR 0359 決定5、ADR 0364 決定2、ADR 0365 決定3(釘を確かめる場所)。GLOSSARY.md: task の checkout。
- 完了の門が worker の tree の形で観測に失敗したときの拒否文は #3142(決定2 の形を worker に名指す。拒むこと自体は ADR 0359 決定1 のまま)。
- 実装は1 slice、#3141 のコメントが spec。
