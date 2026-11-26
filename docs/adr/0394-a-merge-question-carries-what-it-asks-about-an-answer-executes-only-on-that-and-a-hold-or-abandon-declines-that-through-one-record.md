# merge question は問うた内容を持ち、回答はその内容にだけ執行し、hold と abandon は1つの記録でその内容を断る

**Status 追記: 決定3 の立て直しは、収束の中では書く直前に profile → 門 → workspace の Quarantine を読み、止まっていれば立て直さずにその verdict で回答を拒む —— 答えた question は開いて残り、止まりが解けた後の回答が取り替える([ADR 0429](0429-convergence-reads-one-stop-right-before-it-writes-any-question-on-a-root-and-a-stopped-pr-creation-defers-its-record.md) 決定2、2026-11-26、issue #3879)。**

**Status 追記: 決定5 の「hold は一致しなくても拒まない」は、根の記録した repo が今の宣言と食い違うときも同じである —— 食い違いを拒否で返すのは merge の回答で、`pr_merge` の hold は読まずに受ける。拒むと、その question を閉じる回答が無くなる。ローカル着地の hold(ADR 0401 決定4 の例外を含む)は変えない([ADR 0419](0419-a-repo-disagreement-is-read-from-the-records-at-the-entrance-of-a-task-bound-operation-and-a-first-branch-cut-compares-the-record-of-its-fork-source.md) 決定4、2026-11-25、issue #3849)。**

**Status 追記: 決定1 の盤面の部分の tip は、読めなければ(workspace を解決できない・git が落ちた)無しになり、question は立つ([ADR 0403](0403-a-landing-roots-failure-always-reaches-a-human-and-an-unreadable-resource-stops-once-on-its-own-axis.md) 決定1、2026-11-23、issue #3554)。**

**Status 追記: 決定5 の「hold は一致しなくても拒まない」に例外が1つ入る —— question が問うた tip がもう保護ブランチに履歴で含まれていれば、hold は断られ `merge` が名指される([ADR 0401](0401-a-death-between-an-outside-write-and-its-record-needs-only-the-post-crash-minimum-fail-closed-no-wrong-record-and-a-named-exit.md) 決定4、2026-11-22、issue #3515。判定する値は追記(2026-11-24、issue #3647)で今のタスクブランチから問うた tip に改めた)。**

2026-11-21 の grilling(issue #3402、族の根として #3485・#3407・#3408 を寄せた)で決定。`pr_merge` の question は PR 番号しか持たず、
何について問うたか(どの head、どの理由)は本文の文章にしか無かった。盤面が「もう問うた」と知る状態は「その PR に開いた question があるか」
だけだった。立てる経路が1回きり(PR を開いたとき、キューの行を外す tick)だった間はそれで足りていた。ADR 0376 決定7 が、条件を収束の
たびに読み直す書き手を初めて足したことで、欠落が4つの症状になった —— hold が何も断れない(#3402)、寄り道の後に人間が見ていない head を
merge しうる(#3485)、理由の違う書き手が衝突する(#3407)、回答が根の verdict を収束の回から借りる(#3408)。読んだコードと場面は #3402 に置く。

1. **着地の question は、問うた内容を2つの部分で持つ。内容は question ごとに変わらない。** **外の部分**は盤面の外から来た head —— sha と、
   種類(盤面が push していない head か、内容が落ちた head か の2値。巻き戻しかどうかは本文にだけ使う)—— で、無ければ無し。`pr_merge` の
   question だけが持ち、回答を拒むかの判定(決定3)と `pr_merge` の断った記録(決定5)に使う。立てる時点の外の部分は、どの本文を選ぶかに
   依らず出所の判定の結果で、同じかどうかは sha と種類の組で比べる —— 同じ sha でも、取り込みの後に読みが変われば一致しない(問うた時の種類の
   まま執行すると、寄り道を通さずに内容の落ちた head を merge する)。**盤面の部分**は問うた時点のタスクブランチの tip(書き換えの question
   では本文が名指す欠けたブランチも)で、sha で比べる。`pr_merge`・`local_merge`・`pr_promotion_retry` の3つが持ち、断った内容の記録
   (決定5)にだけ使う。**理由**(CI 赤・面の変化など)も question が持つが、本文と推奨を組むためだけで、判定にも記録にも使わない。本文は、
   外の部分があれば外の本文を先に置き、ほかの理由は後ろに1行添える(ADR 0387 決定1 の「CI 赤と重なればこの本文を先にする」を書き換えの
   本文にも当てる)。線は ADR 0387 と同じく「盤面の push か、外から来たものか」で、人間が見たかではない —— 盤面自身の push や修理で内容が
   進んでも回答は拒まない。1つの塊を判定と記録の両方に使う形は退けた —— 理由ごと・question の種類ごとに例外が要った。
2. **`pr_merge` の question の書き手は1つで、開いた question と外の部分が違えば、開いた question を盤面の観測として閉じ(決定ログは立てない)、
   今の内容で新しい question を立てる。** 同じ外の部分が開いていれば何もしない。1つの PR に開いた question は1つのまま。閉じた question への
   回答は今どおり「question closed」で拒まれ、新しい question は今どおり通知される。同じ question のまま内容と本文を直す形は退けた ——
   通知は question ごとに1回なので直しが人間に届かず、`hold` を押してから記録するまでの間に直しが入ると、人間の見ていない外の head を断ったと
   刻む。ローカル着地の question は開いている間は根が候補から外れるので取り下げる書き手が来ず、昇格失敗の question は今どおりタスクごとに
   複数開きうる —— どちらもこの決定の外である。
3. **`merge` の回答は、今の外の部分が無しか、問うた外の部分と同じときだけ執行する。** それ以外 —— 人間に見せていない外の head —— なら
   回答を拒み、決定2 で立て直し、拒否文で足された commit と新しい question を名指す。外の部分が無ければ head は盤面の push した値なので、
   理由が消えた question(人間が落とされた commit を origin へ push し直した後など)への `merge` もそのまま執行する —— `external` の根でも
   ADR 0376 の Status 追記どおり merge する。内容が落ちた head の question への `merge` は寄り道(取り込み → 追いつき → push、ADR 0376
   決定8)を通し、その後は外の部分が無しのときだけ通す —— 寄り道の間に外の head が動けば、同じ書き換えへ戻されても拒む。外の commit を盤面は
   merge しない(ADR 0376 決定4)のは寄り道が保つ。「伝えた head の集合」で判定する形は退けた —— 書き換えの head を question で伝えると
   merge が通り、理由ごとの例外が要る。
4. **回答が待つ根を収束が飛ばしたら、収束は飛ばした理由をその根の verdict として返し、回答の拒否文はその理由を言う。** 入口は相手を名指し
   せず収束を突くだけ(ADR 0241 決定1・5)のまま変えない。回答の根を id で指して撃つ形は退けた —— 0241 の1本の列と守りを通るかが宙に浮く。
5. **断る回答 —— `pr_merge` の hold、ローカル着地の hold、abandon promotion —— は、根に1種類の記録を刻み、断るのは答えた question の
   内容である。** question の内容は変わらない(決定1・2)ので、記録は断った question を指し、その盤面の部分(`pr_merge` では外の部分も)を
   写す。比べるのは写した内容の全体で、どちらかが違えば問い直す。回答の時点の head を刻む形は改める —— question が開いている間に届いた内容
   まで、人間が見ないまま断ったことになる。同じ計算が2箇所にあり、3箇所目を足す前に出所を1つにする。`hold` は外の部分が今と一致しなくても
   拒まない —— 断るのは人間が見たもので、今の内容が違えば決定7 / ADR 0289 の問い直しが続く。
6. **断った後に何を止めるかと、いつ効かなくなるかは、種類ごとに分けたまま残し、読み手は記録が指す question の種類で絞る。** abandon promotion
   は昇格を止め、後の `pr_opened` / `pr_branch_pushed` で効かなくなる(ADR 0225)。ローカル着地の hold は根の着地を止め、merge の執行の
   記録で効かなくなる(ADR 0289)。PR の hold は question を立てることだけを止め(push は続く)、その PR の決着の記録か、同じ PR に新しい
   question が立つと効かなくなる。種類で絞らないと、abandon → retry で PR を開く → PR の hold の順で、PR の hold を断念と読んで着地が止まる。
   PR の hold が効いている間に別の失敗の昇格失敗の question へ `retry` が来たら、人間の明示の操作として merge question を新しく立て(hold は
   効かなくなる)、拒否文でそれを名指す(ADR 0376 決定7 の名指しの相手)。
7. **PR の hold の後は、断った内容と今の内容が違うときだけ問い直す。** 問い直しは新しい question を立てる。条件を読み直すのは収束だけで、
   収束が GitHub の head を読むのは積み残しがあるときだけなので、実際に起きるのは外の push の question で積み残しがあるときに限る。積み残しが
   無いまま head が動いても問い直さない —— その PR は ADR 0387 の帰結のとおり、人間が GitHub で merge か close する。tick の question は
   キューの行が外れているので問い直さない。

## Consequences

- ADR 0387 決定2 の「伝えた」の記録は決定3 に置き換わって無くなる。同じ question に同時に走る回答が互いの立て直しで通らないこと(ADR 0387
  Status 追記 (1))は、決定2 の取り下げと決定3 の検査の間で保つ —— 形は実装の spec が決める。
- ADR 0376 決定7 の作業台の「1回拒んだ」印は、伝えたことの記録ではなく作業台の状態なので、決定3 の外に残る。
- 盤面の部分の tip を読むのは、回答の時点から question を立てる時点へ移る。ADR 0370 決定1 の「hold・断念の head の記録は比べずに書く」例外も
  立てる時点へ移る —— tip は運ぶ値ではなく人間に見せたものの記録で、昇格失敗の question は ref 検査の失敗からも立つので、比べると読めない。
- abandon の記録は今は回答の transaction の外で、ローカル着地の hold は中で刻まれている。1種類にするときにどちらへ揃えるかは spec が決める。
- 人間の根で完了レビューを待つための local merge の hold が戻らない #3469 は、この族に入れない —— 欠けているのは記録の対象ではなく、
  「待つ」という意図を hold が表せないことである。
