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
   記録が持てるので通す。各段は自分の delta にだけ答え、spawn 時の停止は足さない(ADR 0362 決定2 と同じ)。**出題の写し**(root の
   worktree を面接室に commit する口、ADR 0273 決定1)も記録に worker の tree を書くので同じ分類で、面接室の保護ブランチの head との差に
   gitlink を足す・進める tree は path を名指して拒み、root が直して呼び直す —— 完了の門は Interview の root に掛からず、受験者は populate
   できない gitlink を環境として受け取ることになる。
3. **盤面は gitlink の値を記録からしか読まない —— worktree は gitlink の値を供給しない。** 入れ子の repo(`.git` という entry を持つ dir ——
   その `.git` が dir でも `gitdir:` の file でも symlink でも)は盤面の view(WIP の `add -A`、完了の門と出題の写しの観測)から除き、記録に
   書く gitlink は base の tree にある値だけ。WIP は gitlink を足さず進めず、untracked の入れ子の repo は記録に入らず、submodule の dir が
   消えていれば gitlink の削除は今日どおり通る(記録が持てる変更)。入れ子の repo の中身は記録の外で運ばれない —— commit 済みでも未 commit
   でも、名前の場所にも WIP にも入らない。宣言であって観測ではない: 観測するには入れ子の repo で git を撃つ(ADR 0356 決定3 とぶつかる)か、
   worker が書ける `.git/modules` の object を借りる(ADR 0360 決定2 / ADR 0364 決定1 とぶつかる)しかないので、観測できないものは記録にも
   残さない。決定2 の下で失うのは「submodule の中で始めて gitlink を commit しなかった作業」だけになる。門から見えなくなる「submodule の tip を
   進めて commit していない」の信号は、従っても決定2 で拒まれる行き止まりなので残さない。
   **旧(2026-11-09 の初版)**: 「完了以外の解放の WIP は進んだ gitlink の pointer を運ぶ」—— その pointer の値は git が worktree の入れ子の
   `.git` を開いて決めており、worker が書いた gitfile の先の repo(盤面の user が読める任意の repo)の HEAD や手書きの任意の sha がそのまま
   `task/<id>` に入り、commit の無い入れ子の repo では `add -A` が落ちて WIP 全体が task の失敗 / quarantine になった(#3117、macOS git 2.47、
   `boardWriteTree` を直接呼んだ実測)。値の出所を記録に置けば3形とも同じ1つの規則で消える。worker が自分の commit で gitlink を進める経路は
   残るので決定2 はそのまま要る。検査と読みの間の窓(列挙の後に worker が入れ子の `.git` を作る)は、書いた tree の gitlink を base と比べる
   釘で閉じる —— 違えば worker の repo の故障。

名指す代償: submodule を upstream に追従させる(gitlink を進める)仕事と、submodule の path を移す仕事(`git mv` は diff で D + A になり、
A は「足す」に当たる —— sha が同じでも一律に拒む)は worker にできず、人間の仕事になる。需要は観測されておらず、tidepool 自身は
`.gitmodules` を持たない。

## 退けた形

- **記録を submodule の取得元まで広げる**(worker の `.git/modules` から submodule の commit を fetch し、landing で取得元へ push)—— ADR 0364
  決定1 の allowlist を入れ子の repo へ広げる新機能で、需要が無い。
- **保護ブランチと比べる** —— 親が進めた gitlink で子が拒まれ、子には直せない(ADR 0362 退けた形と同じ)。
- **参照先の object が親 repo の記録にあれば通す** —— gitlink は `.gitmodules` の url から解決されるので、親 repo の object store に同じ sha が
  あっても意味を持たない。変更は一律に拒む。
- **入れ子の worktree を読んで未 commit を拒む** —— 読み方は2つしかなく、どちらも上の ADR とぶつかる(決定3)。
- **worker が submodule を populate できるかを測ってから決める** —— 直す形が測定結果で変わらない。
- **`--ignore-submodules=all` で黙らせる**(決定3)—— tracked な gitlink の前進しか覆わず、untracked の入れ子の repo で `add -A` が落ちるのは
  防げない。
- **入れ子の `.git` の形(gitfile・symlink)を検査して拒む**(決定3)—— ADR 0364 が退けた denylist と同じで、検査と読みの間に窓が残る。

## 射程の境界

`.gitmodules` だけの変更(url の差し替え)は塞がない —— gitlink の sha が commit を pin するので、別の url は同じ commit しか供給できないか失敗
する。ADR 0362 の `scripts/*` と同じ線で review の主題。

## 派生

- Status 追記: ADR 0364(閉包の検証は gitlink を見ない)、ADR 0356 決定3(gitlink だけで読む → 足す・進めるは門が拒む)。GLOSSARY.md:
  完了の門、task の checkout。
- 実装は1 slice、#3052 のコメントが spec。
- 決定3 の書き直し(2026-11-09、issue #3117): Status 追記: ADR 0356 決定3(gitlink の値の出所)、ADR 0364(入れ子の `.git` も view が
  開いていた)。GLOSSARY.md: task の checkout。実装は1 slice、#3117 のコメントが spec。
