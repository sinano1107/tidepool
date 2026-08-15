# symref は指し先で数える — ref スナップショットに解決値を保存しない

issue #304 のグリリング(2026-08-15)で決定。ADR 0052 の実環境動作確認 第2段で、registry workspace の
スナップショットのうち `refs/remotes/origin/HEAD` の行だけが古いまま残る痕跡が見つかった。失敗はまだ
起きていない — 「registry clone を workspace として使う」かつ「セッション中に人間が registry を編集する」
が同時に成立した次の解放で、誤検知の quarantine として発火する状態だった。

## 破れの形 — 1本書くと2行動く

`for-each-ref` は symref(`refs/remotes/origin/HEAD` 等)を**解決値で**出す。symref の行の objectname は
指し先の ref と常に連動して動くので、盤面が `origin/main` を1本書くと、スナップショット上は2行動く。
一方 ADR 0064 決定4 の外科的再基準化は、設計どおり名指しした1行しか撮り直さない — 連動して動いた
symref の行が古いまま取り残される。

ADR 0064 の「盤面が書いた ref はどの経路でも確定している」は、#285(ADR 0066 決定4)が本数について
「1本ではなく N 本」へ改訂したのとは別の軸で破れていた: あちらは盤面が**書く本数**、こちらは**1本書いた
ときに動く行数**である。原因は書く側ではなく保存の形にある — symref を解決値で数えることが二重計上で
ある。

## 決定: symref の行は解決値ではなく指し先を保存する

スナップショットの綴りを1つの `for-each-ref` で変える:

```
%(if)%(symref)%(then)symref=%(symref)%(else)%(objectname)%(end) %(refname)
```

symref の行は `symref=refs/remotes/origin/main refs/remotes/origin/HEAD` の形になる。効果は3つ:

- **二重計上が消える。** 指し先の ref が動いても symref の行は不変なので、外科的再基準化に取り残しが
  生じない。盤面が symref を名指しで書く経路は存在せず、`rebaselineRef` も比較も無変更で成立する。
- **symref 自身の可動部は不変条件に残る。** symref は worker が `git remote set-head` / `git symbolic-ref`
  でそれ自身を動かせる — 状態は解決値ではなく**指し先**である。付け替え・削除・新規作成はすべて行差分に
  出る。検出力はむしろ上がる: 付け替えは registry clone に限れば `guardRegistryDefaultBranch` が独立に
  捕まえていたが、**削除は同 guard も素通し**(`origin/HEAD` 不在は「remote 既定なし」として合格扱い)で、
  新規 symref の作成はどこにも掛かっていなかった。
- **種類で切る。** `refs/stash` は実 ref なので対象に残り、`origin/HEAD` 以外の symref も名指しなしで
  同じ扱いになる — 決定1 の「列挙は黙って古くなる」に沿う。なお除外を選ぶ場合でも `for-each-ref --exclude`
  は採れない: refname パターンによる名前の列挙であるうえ、実機の git 2.39.5 に存在しない
  (`%(symref)` は動作確認済み)。

移行は不要である。保存済みスナップショットは次の pickup が丸ごと撮り直す(ADR 0064 決定7 と同じ根拠)。
形式変更を跨ぐ実行中セッションがあれば解放時に誤検知が1枚立つが、それは ADR 0064 決定3 が織り込んだ
コスト(1択の確認 question、30秒で解除)であり、決定時点で in_progress のタスクは無かった。

## Considered options

- **(a) 再基準化が、対象 ref を指す symref も併せて撮り直す** — 書く側が「1本書くと何行動くか」の逆引きを
  毎回背負う。原因(解決値の保存)は温存され、二重計上は残る。
- **(b) symref をスナップショット・比較から除外する** — 「symref は ref ではなく参照なので数えない」
  という筋は通るが、worker が動かせる実在の可動部(指し先)を不変条件から手放す。削除・新規作成が
  素通りになる。
- **(c) 比較の側で「今 symref である refname」の行を両側から無視する** — 保存形式は守れるが、検査側に
  checkout への問い合わせ分岐が増え、二重計上された行はスナップショットに残り続ける。
