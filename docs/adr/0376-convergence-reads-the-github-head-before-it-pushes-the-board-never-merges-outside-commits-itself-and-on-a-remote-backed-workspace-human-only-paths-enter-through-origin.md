# 収束は push の前に GitHub の head を読み、外の commit を盤面は自分では merge しない —— remote-backed の人間しか書けない path は origin 経由のまま

2026-11-13〜14 の wayfinder(map #3178、ticket #3203・#3233・#3205、決定9 は #3190)で決定。外の push が origin の `task/<root>` を進めると、
盤面の push は force 無しなので拒まれ、PR 昇格失敗 question の `retry` は同じ理由で落ち、`merge` の回答はその question を名指して拒む ——
2つの question が互いを指して閉じない(実 GitHub の盤面で再現、#3250)。盤面が GitHub の head を local のタスクブランチへ入れる経路は無い。
この ADR は、収束が origin の側の何を読んでどの形に分けるかと、remote-backed の workspace で人間が origin へ入れる道を決める。人間が書く場所と
盤面が受け取る行為(作業台、取り込み)は ADR 0371 が持ち、その決定10 は「外の push が落とした内容を盤面は自分では merge しない」までを書いた。
実測・読んだコード・`file:line` は ticket に置く。決定はコードと ADR の読みで、この形の盤面は走らせていない。

以下、「GitHub の head」は PR が在ればその head、無ければ origin の `task/<root>` の head、「push する sha」は local の `task/<root>` の tip、
「最後に push した値」は盤面がそのブランチへ最後に push した sha を指す。

## 決定

1. **収束は、push すると決めた後・push の前に GitHub の head を読む。** PR が在れば状態を読む同じ読み取りで読み、PR が見つからなければ
   origin のブランチの head を毎回読む。push するかの判定(積み残しの比較)は ADR 0242 決定2 のままである。git の拒否文は解析しない ——
   non-fast-forward と認証・網の失敗を見分けられない。読んだ後に head が動いて push が落ちれば今どおり昇格の失敗で、`retry` が読み直す。
2. **push する条件は1つである —— GitHub の head が push する sha の祖先で、かつ、head が最後に push した値を祖先に持つ(または値が読めない)。**
   「読めて、ブランチが無い」は今どおり push して PR を作る。外から消されたブランチは初回と見分けず、盤面が作り直す(昇格をやめる出口は
   `abandon promotion`)。head が「読めなかった」ときは push せず、昇格の失敗にする。ADR 0242 決定3 の fail-closed は読めないものを
   積み残しと読む側で、ここは push を撃たない側である。
3. **最後に push した値は、PR が記録済みなら盤面の記録から(ADR 0242 決定2 のまま)、PR が無いか未記録なら写し
   `refs/remotes/origin/task/<root>` から読む。** 写しは盤面が push の成功を見て書く値で(ADR 0052 追記)、event を残さない publish の push も
   書く。ADR 0242 が退けた写しの使い方(fetch し直して GitHub の head の鏡として読む)ではない —— fetch せず、盤面自身が書いた値として読む。
4. **盤面は外の commit を自分では local の `task/<root>` に merge しない。** GitHub の head が push する sha の祖先でなければ、clean に merge
   できても、PR の有無に依らず、盤面は merge も push もしない(PR が記録済みの書き換え・巻き戻しは決定7、PR が無いか未記録の巻き戻しは決定6)。昇格の失敗の時点で作業台を開き(tip は local の `task/<root>` と GitHub の
   head)、人間が merge を commit し、`retry` が取り込んで push する(ADR 0371 決定2)。答えていない昇格失敗 question がある根を収束は撃たない
   (ADR 0240 決定2)ので、その根では盤面が head を最初に読むのは `retry` の中で、作業台はその拒否の中で開く。本文と拒否文は ADR 0371 決定11 の
   要素に、盤面の知らない commit がある事実と、中身を見るコマンドを足して言う。
   理由: 盤面の merge は、外の内容を検査なしで修理の子の fork 元に入れる。検査を足さない前提「origin に書ける者は人間」は、PR の head に
   ついて疑いが開いている(#3210)。人間の merge を必須にして壊れる運用は挙げられなかった。
5. **人間が merge した外の head に、盤面は新しい検査を足さない。** 人間の merge は見たうえでの同意で、検査ではない。拒んでも内容は PR の
   head に残って PR の merge で入り、PR の無いブランチだけ検査しても、人間が手で PR を開けば同じ内容が通る。着地の側の検査は #3210 が持つ。
6. **PR が無いか未記録の巻き戻し(head は push する sha の祖先だが、最後に push した値を祖先に持たない)は push を止め、`retry` は毎回拒む。**
   同意は origin への操作で表す —— 落とされた commit を push し直すか、ブランチを消す。どちらかの後の `retry` は決定2 を満たして通る。
   作業台は開かず、盤面は印も event も足さない。`retry` を「戻してよい」の同意と読まないのは、人間が巻き戻しの文を見ないまま答えうるうえ、
   拒んだ後の2回目を見分ける印が無いからである(merge するものが無く、tip は1回目と同じ)。見分けずに push すれば、落とされた内容が黙って戻る。
7. **PR が記録済みで、head が最後に push した値を祖先に持たない(書き換え・巻き戻し)とき、収束は push せず、昇格失敗 question も立てず、
   キューの行を外して推奨 hold の merge question を立てる。** すでに開いていれば何もしない。未 push の修理が重なっていても同じで、落ちた内容の
   文はその場合にも出る。clean でも人間が作業台で merge を書き、`merge` の回答が取り込んで push する(ADR 0371 決定10)。別の失敗で開いていた
   昇格失敗 question への `retry` は、この merge question を id で名指して拒む。巻き戻しに未 push の修理が重なると fast-forward の push が
   内容を黙って戻す今の挙動は、ここで止まる。立てるのを収束にするのは、無人 merge の tick が積み残しを読むのは CI が緑のときだけで、
   待つと `retry` の拒否が名指す相手を持たないからである。
8. **順は「人間の tip の取り込み → 追いつき → push」である。**
9. **開いている PR が GitHub 上で保護ブランチと conflict したら、人間が PR の head へ外から push して解く。扉は作らない。** 人間は名前の場所の
   ref を書かない。その push の後・PR の merge の前に修理の子が帰ると、決定4 により盤面は1度止まり、人間は自分の push した commit を作業台で
   merge して `retry` と答える。盤面は push した者を見分けられないので、この費用を受け入れる。
10. **remote-backed の workspace で、人間しか書けない path(ADR 0362)に扉は作らない。** 正規の道は origin の保護ブランチに入れること ——
    自前の clone からの fast-forward の push か、自分の PR の merge である。origin が正本で(ADR 0052)、worker は origin に書けない。盤面は
    question・受理・event のどれも足さず、origin の履歴が記録の正本になる。purely-local(取り込みが記録に残る、ADR 0371)との食い違いは残す。
    question と受理に揃えないのは、内容が既に正本に在り、誰が push したかを盤面が知らないので、拒む出口の無い受理になるからである。
11. **前提を明記する —— remote-backed でこの path を守るのは、worker の完了の門と、origin に書ける者が人間であることである。** 盤面は
    入ってくる側を検査しない。PR の head への push でも入るが、案内するのは保護ブランチの道だけである。
12. **この道を人間に伝える面は4つで、同じ4要素を言う。** 面は、取り込みの入口の拒否文、docs、足す操作が remote-backed を拒む文、回答の時点で
    remote-backed になっていて拒む文。要素は、origin の保護ブランチに入れる / fast-forward で入れる / 名前の場所からは push しない /
    既に fork した task には届かない。完了の門が worker を拒む文は変えない(ADR 0371 決定11)。最終文面は spec が書く。

## 退けた形

- **足しただけで clean なら盤面が merge する**(#3203 の最初の版)—— 決定4 の理由。PR が無いときだけ止める形も採らない(前提が疑われているのは
  PR の head の側)。
- **外の commit が変えた entry に完了の門と同じ検査を掛けて拒む** —— 決定5 の抜け道が残る。
- **PR の head を最後に push した値へ force-push で戻してから運び直す** —— 名前の場所は書かないが、途中で PR の head から外の commit が消える。
- **push の直後に sha を event に刻む** —— publish の push を拾えない。
- **巻き戻しを伝えた event を刻み、同じ head への2回目の `retry` を同意と読む** —— 稀な場面のために記録が1種類増える。
- **無人 merge の tick に CI を問わず積み残しを読ませる** —— 知らせが次の tick まで遅れる。
- **人間しか書けない path の origin 経由の変更を event にだけ残す** —— 読み手が居ない(origin の履歴で author つきで読める)。
- ADR 0242 が退けた「外の push が落とした head を失敗 question に倒す」は、決定6 と乗り物が同じだが、退けた理由(`retry` が何も変えずに
  question だけ閉じる)は起きない —— `retry` は拒まれ続け、question は origin が直るまで閉じない。決定7 は merge question に倒すので当たらない。
- ADR 0241 が退けた「push で積み残しが消えないと分かれば push しない」とは条件が違う。push を止めるのは決定2 を外れたときだけで、根の新しい
  内容は人間の merge の後の push が運ぶ。

## 帰結

- ADR 0242 決定2 の「GitHub も写しも読まない」と決定4 の末文、ADR 0243 決定2・6 の「タスクブランチの写しは誰も読まない」が偽になる。
  ADR 0052・0105・0240・0241・0362 に射程の追記を置いた。
- 決定10・11 の「origin の履歴が正本」は、どの repo が origin かを盤面が宣言から決めることに依る(#3254。同じ map の別の ADR が書く)。
  前提の穴の疑いは #3210・#3211 が持ち、ここでは解かない。
- spec が決める(#3178 の「Spec へ渡すもの」): origin の head を読む手段(`gh` か `ls-remote` か —— ADR 0330 決定1 の規則が掛かる)。決定7 で
  収束が立てる merge question が、tick と同じ読み直し(ADR 0217 決定1、順は ADR 0232 決定3)を通すか。外の commit を断る道を文が言うか。
  PR が記録済みの根の「最後に push した値」を写しに寄せるか。ADR 0370 決定1 の比較との順。
- 限界: checkout を clone し直すと写しは origin の今の値になり、決定6 の巻き戻しを見落として push する。外から消されたブランチを盤面が
  作り直すことは知らせない。
