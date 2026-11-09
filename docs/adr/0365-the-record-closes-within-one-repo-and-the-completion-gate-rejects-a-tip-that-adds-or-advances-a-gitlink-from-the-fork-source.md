# 記録は名前の場所の1 repo で閉じる —— 完了の門は fork 元から gitlink を足す・進める tip を拒み、入れ子の repo の中身は運ばない

2026-11-09 の grilling(issue #3052、#3030 の実装の派生)で決定。ADR 0364 決定1 の不変条件「記録に入る object は、名前の場所に既にあるか
worker が自分の checkout の `objects/` に書いたもののみ」は、tip の閉包を object の到達可能性で検証する。git の到達可能性は gitlink を辿らない ——
gitlink(mode `160000`)は tree の中で submodule を指す entry で、中身は**別の repo の commit の sha** だけ、object は親 repo に無い。だから worker が
task の checkout の submodule の中で commit し、親で gitlink を commit すると、閉包は解け、門は通り、解放で worker の `.git/modules/<name>` は
checkout ごと消え、保護ブランチには**どこにも無い commit を指す gitlink** が着く(#3052 の再現、macOS と VM の git 2.53)。submodule の
中の未 commit の編集は門に見えず WIP にも入らない(本文の観測)。読み側は決まっていた —— ADR 0146「submodule は workspace にならない」、
ADR 0356 決定3「submodule は gitlink だけで読み、入れ子の repo で git を撃たない」、fetch は `--no-recurse-submodules`(#2895)。書き側の
「記録はどの entry を受け入れるか」は持ち主が無く、#3030 が test の釘を書き換えて通していた。主題が「worker の `.git` をどう読むか」(0364)
でなく「記録がどの entry を受け入れるか」なので、追記でなく ADR を立てる。実測と `file:line` は #3052 のコメントに置く。

## 決定

1. **記録は名前の場所の1 repo で閉じる。** tip の entry の参照先は全部その repo の object でなければならない。gitlink の参照先は定義上
   別 repo の commit で、盤面はそれを持てない —— submodule の取得元へ撃たず、worker の `.git/modules` は写さない(ADR 0364 決定1 の
   allowlist)—— ので、存在を判定することもできない。
2. **完了の門は、fork 元との merge-base から gitlink を足した・進めた tip を path を名指して拒む。** 比較の起点と「直して commit し直せ」の型は
   ADR 0362 決定2 と同じで、軸が違う —— 人間しか書けない path ではなく、記録が持てない entry。gitlink を消す・blob や tree に置き換える変更は
   記録が持てるので通す。各段は自分の delta にだけ答え、spawn 時の停止は足さない(ADR 0362 決定2 と同じ)。
3. **入れ子の repo の中身は記録の外で、運ばれない。** commit 済みでも未 commit でも、名前の場所にも WIP にも入らない —— 宣言であって
   観測ではない。観測するには入れ子の repo で git を撃つ(ADR 0356 決定3 とぶつかる)か、worker が書ける `.git/modules` の object を借りる
   (ADR 0360 決定2 / ADR 0364 決定1 とぶつかる)しかないので、観測できないものは記録にも残さない。決定2 の下で失うのは「submodule の中で
   始めて gitlink を commit しなかった作業」だけになる。

名指す代償: submodule を upstream に追従させる(gitlink を進める)仕事は worker にできず、人間の仕事になる。需要は観測されておらず、tidepool
自身は `.gitmodules` を持たない。

## 退けた形

- **記録を submodule の取得元まで広げる**(worker の `.git/modules` から submodule の commit を fetch し、landing で取得元へ push)—— ADR 0364
  決定1 の allowlist を入れ子の repo へ広げる新機能で、需要が無い。
- **保護ブランチと比べる** —— 親が進めた gitlink で子が拒まれ、子には直せない(ADR 0362 退けた形と同じ)。
- **参照先の object が親 repo の記録にあれば通す** —— gitlink は `.gitmodules` の url から解決されるので、親 repo の object store に同じ sha が
  あっても意味を持たない。変更は一律に拒む。
- **入れ子の worktree を読んで未 commit を拒む** —— 読み方は2つしかなく、どちらも上の ADR とぶつかる(決定3)。
- **worker が submodule を populate できるかを測ってから決める** —— 直す形が測定結果で変わらない。

## 射程の境界

`.gitmodules` だけの変更(url の差し替え)は塞がない —— gitlink の sha が commit を pin するので、別の url は同じ commit しか供給できないか失敗
する。ADR 0362 の `scripts/*` と同じ線で review の主題。

## 派生

- Status 追記: ADR 0364(閉包の検証は gitlink を見ない)、ADR 0356 決定3(gitlink だけで読む → 足す・進めるは門が拒む)。GLOSSARY.md:
  完了の門、task の checkout。
- 実装は1 slice、#3052 のコメントが spec。
