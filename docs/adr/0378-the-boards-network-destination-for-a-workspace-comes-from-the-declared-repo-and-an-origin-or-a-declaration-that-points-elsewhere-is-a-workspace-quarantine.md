# workspace の網の行き先は宣言 `repo` から決める —— origin が別の repo を指すか、宣言が覚えた repo と違えば workspace の Quarantine

2026-11-15 の wayfinder(map #3178、ticket #3254、実測は #3250)で決定。名前の場所で `git remote set-url origin <別の repo>` を打つと、
ref は1つも動かないのに、次の pickup が別の repo から fetch して保護ブランチを fast-forward し、その内容が Quarantine・question・event
なしに task の fork 元へ入る(実 GitHub の盤面で再現)。pickup の述語が比べるのは origin の有無までで、盤面の URL・token・`gh` の `-R` は
checkout の origin から組まれていた。ADR 0376 決定10・11 の「origin の履歴が記録の正本」は、どの repo が origin かを記録なしに
変えられないことに依る。この ADR は、盤面が網の行き先を何から決め、食い違いをどこで止めるかを決める。registry clone が workspace で
ないことは ADR 0377 が持つ。実測・読んだコード・`file:line` は ticket に置く。決定の形の盤面は走らせていない。

## 決定

1. **workspace の網の操作は、行き先を宣言 `repo` から決める。** fetch・push・`ls-remote` の URL、token の repo key、`gh` の `-R` は
   registry の `repo:` から組み、checkout の `remote.origin.url` は行き先に使わない。task の checkout(origin を持たない)を cwd にする
   呼び出しも同じである。`set-url` しても盤面は別の repo へ出ない。
2. **registry clone は今どおり自分の origin を読む。** 宣言の行を持たない(ADR 0377 決定1)。行き先の出所は、workspace = 宣言、
   registry clone = origin の2つになる。
3. **checkout の origin が宣言と別の repo を指していたら、workspace の Quarantine である。** pickup の前半の述語の「origin の有無が宣言と
   一致する」に「同じ repo を指す」を足す。workspace の Quarantine の受理は同じ述語を撃つので、直っていない回答は拒まれる。
4. **「同じ repo」は、盤面が出る URL に直した形どうしで比べる。** GitHub は `owner/name` が同じなら同じで、綴り・`.git` の有無・
   大文字小文字を無視する。GitHub 以外は文字列の一致。origin は `insteadOf` を当てる前の生の値を読む —— 盤面が出る先はその値で、
   `insteadOf` があると適用後の値と食い違いうる(実測)。ADR 0377 決定6 の保護の判定と出所を1つにする。
5. **基準に `remote.origin.url` は足さない。** 比べる相手は宣言で、基準は今どおり `refs/*` と HEAD である。同じ事実の置き場所を2つに
   しない。
6. **`repo:` の手編集は盤面が止める。** workspace の基準の行を作るとき、そのときの宣言の repo を一緒に覚える。盤面は宣言から行き先を
   決めるたびに、覚えた repo と今の宣言を決定4 の比べ方で比べ、違えば網に出ない。盤面は PR を番号で覚えているので、PR が開いた task が
   ある状態で `repo:` を書き換えると、新しい repo の同じ番号の無関係な PR を読んで merge しに行く(読みからの導出、未実測)。守る線は
   ADR 0373 決定13 の「yaml と git だけでは扉を通らずに基準をやり直せない」を repo に広げたものである。
7. **比べる場所は、行き先を決める所である。** 着地の tick は pickup を通らずに PR を読む。決定1 で行き先の入口が1つになるので、検査も
   そこ1箇所に置く。同じ比較を前半の述語の項にも置く(受理が撃ち直す)。
8. **行き先の検査が食い違いを見つけた時点で、pickup を待たずに workspace の Quarantine を立てる。** 壊れているのは workspace の宣言で
   個々の task ではないので、知らせは workspace に1回だけ出す。着地待ちの root だけがあり pickup が起きない盤面でも人間に届く。pickup
   以外が workspace の Quarantine を立てる先例は解放である。
9. **出口は扉も選択肢も足さない。** 間違いの向け替えは `git remote set-url origin <宣言の repo>` で戻し、手編集した `repo:` は元に戻す。
   repo を移す正規の道は 削除の扉 → 登録し直し で、path の差し替え・改名と同じ線である(ADR 0373 決定14)。削除の扉は未決着の task と
   着地待ちの task があれば拒む。
10. **publish の扉は、覚えた repo も書く。** 書くのは `remote add` から registry の commit までの await の無い区間の中(ADR 0066 決定5)で、
    巻き戻しは覚えた値も戻す。削除の扉は行ごと消すので、登録し直しで新しい repo が覚え直される。

## 退けた形

- **前半の述語で比べるだけで、行き先は origin のまま** —— 述語を通ってから網に出るのは pickup と Quarantine の回答だけである。session 中に
  向け替えると、後始末の fetch が別の repo を読み、着地が別の repo へ push して PR を開く。
- **origin を読む全箇所で宣言と比べる** —— 塞がるが、10 以上の呼び出しに宣言を運び、失敗の文がそれぞれ要る。
- **基準に URL を足す** —— 決定5 の理由。
- **registry の `repo:` の手編集を、repo を移す出口にする**(最初の版)—— 決定6 の理由で取り消した。
- **map の外に出す** —— ADR 0376 決定10・11 の前提がここに乗る。

## 帰結

- ADR 0339 決定4 は workspace について偽になる —— repo key の出所は宣言で、「URL の元を registry の `repo` 宣言にしない」理由のうち
  「綴りを照合しない人間向けの provenance」は外れる(「registry clone 自身に宣言の行が無い」は決定2 として残る)。ADR 0052 決定3 の
  「宣言と実態のずれ」に「別の repo を指す」が足される。ADR 0066 決定5、ADR 0351 決定2・7 に射程の追記を置いた。
- fast-forward できる別の repo の内容が Quarantine なしに fork 元へ入る形と、無関係な履歴の別の repo の値が写しと基準に入る形(#3250 の
  実測)は、盤面がそこへ出ないので起きない。後始末の token の温めは宣言から repo key を取る(#3260 の疑いは読み口ごと消える)。
- spec が決める(#3178 の「Spec へ渡すもの」): 覚えた repo の置き場所(基準の行の外に置くなら ADR 0087 決定4 の「削除は registry
  エントリだけ」に当たる)。行はあるが値を持たない既存の行。purely-local の行に手で `repo:` を足した場合の文。食い違いの文面と、repo の
  移し方の docs。行き先の検査の失敗を握りつぶす呼び手があっても Quarantine が立つこと。
- 限界: GitHub 上の repo の改名・移譲は `owner/name` が変わるので別の repo と読み、新しい名前に替える道は 削除の扉 → 登録し直し だけ
  である。GitHub 以外の origin の綴りの揺れ(末尾の `/`、`.git`、`file://` と path)と、`insteadOf` 付きの checkout を `register` した
  場合は決定3 で止まり、出口は `set-url` で宣言の値に揃えること。基準の行を持たない workspace は覚えた値が無く、`repo:` の手編集は
  通る(壊れるものは挙げられなかった)。宣言から組んだ URL で fetch・push・`gh` が通ることは未実測。`repo:` と同じ形の穴が `branch:` に
  あるかは確かめていない。
