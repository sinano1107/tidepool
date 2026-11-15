# 人間は名前の場所に書かず、盤面が開く作業台で commit し、盤面がその tip を取り込む —— 入口は今ある回答で、sha も path も運ばない

2026-11-13〜15 の wayfinder(map #3178、入口は #3158)で決定。ADR 0370 は「残る穴と根」で、人間が書いた内容を記録に入れる正規の扉が無く、
手で名前の場所に書かせる決定(ADR 0105 決定2、ADR 0239 帰結、ADR 0240 決定4、ADR 0242 決定4)が、名前の場所が盤面の記録になる(ADR 0356)
より前のものだと書いた。渡された要件は「門を通った内容を、回答1つで落とせない」。この ADR はその扉のうち、人間が書く場所と、盤面がそれを
受け取る行為を決める。Quarantine の受理と基準、人間担当の work、origin 経由の道、Codex の封じ込めの検査は、同じ map の別の ADR が持つ。
場面の表・実測・`file:line` は ticket に置く(#3181・#3182・#3184・#3190・#3191・#3216・#3235。素の git と実 worker の実測は #3241・#3252)。

前提: 作業台に人間が書けるのは、盤面と人間が同じ OS ユーザーだからである(Pi の本番は実測、VM はコードの読み —— #3209)。これを決めた
ADR は無い。盤面を専用のユーザーで走らせるなら、決定1 から決め直す。

## 決定

1. **人間は作業台(Workbench)で書く。** 盤面は人間のために、(workspace, 書く先の ref) ごとに1つの checkout を盤面の host 上に開く。
   書く先は、人間の commit が入る ref で、3種ある —— 帰り先の `task/<id>`、保護ブランチ、人間担当の work 自身の `task/<id>`。名前の場所とも
   task の checkout とも別の git ディレクトリで、人間は書く先と同じ名前の branch に commit し、盤面はその tip だけを読む。対象は `task/<id>`
   向けの全場面と、purely-local の保護ブランチ向けである。remote-backed の保護ブランチ向けの内容には開かない(origin が正本、ADR 0052)。
   盤面が作る場所なので path と形を盤面が知っていて、入口は何も運ばずに済む。
2. **入口は今ある回答で、取り込み(Intake)は1つの行為である。** conflict を受ける入口は、今と同じ question の今と同じ回答(`repaired by
   hand`、`retry`、`merge`)で、verb も選択肢も足さない。回答は sha も branch も path も運ばない。盤面が作業台の tip を読み、検査し、包む
   commit を作って、書く先の ref を口を通して書く。入口はほかにもある(purely-local の封じ込めの Quarantine の回答、決定6 の `take in`、
   人間担当の work の取り込みと完了)が行為は1つで、入口で違うのは検査だけである。成功は1種類の event `workbench_taken_in` が書く先の ref・
   人間の tip・包む commit・入口を残し、拒否は記録に足さない。
3. **受け取る条件は祖先だけで、解決は採点しない。** 人間の tip は書く先の今の値を祖先に持ち、merge で運ばれる側のブランチがある入口では
   その tip も祖先に持つ。その上に人間が何を足すかは制限せず、片側の tree を捨てた merge(`-s ours` の形)も通る。要件は「落とすには commit
   を書く必要があり、それが履歴に残る」で満たす —— 修理を捨てるのも、作業台の merge commit で表す。
4. **検査は盤面所有の写しの中で済ませ、全部通ってから書く。包む commit は常に作る。** tip は ADR 0364 と同じ手で読む。書く先は merge back や
   着地が運ぶ ref なので、拒んだ tip を名前の場所に残さない(完了の門の「ref を書いてから検査」の順は借りない)。包む commit は、第1親が
   書く先の値、第2親が人間の tip、tree は人間の tip のもの。tip が1つだけの取り込みでも作るので、取り込みごとに履歴に輪が1つ出る ——
   記録に入る人間の入口の commit を、この形と event で1対1に見分けるために払う。同時の回答は旧値の CAS と、1度読んだ sha で守る。
5. **内容の検査は場面で分けない。** 隠せない形・gitlink・人間しか書けない path(ADR 0362)は、入力の tip のどちらとも違う entry があれば
   path を名指して拒み、作業台の作業ツリーが tip と違えば拒む。人間しか書けない path を一律に拒むのは、書く先の task が未決着なら、人間の
   merge が置いた変更がその task の後の完了の門の delta に入り、worker が自分で書いていない変更で完了を拒まれるからである(#3182 の実測)。
   通すのは purely-local の保護ブランチ向けの2つの入口(決定6 の `take in` と封じ込めの Quarantine の回答)だけで、purely-local でこの path を
   記録に入れる道はここになる。入口は author も署名も見ない。
6. **purely-local の保護ブランチ向けに、人間が始める操作を1つだけ足す(`open_workbench`)。** 操作は (workspace, 保護ブランチ) の作業台を
   開き、workspace 単位の question `intake`(`take in` / `close`)を1枚立てるだけで、取り込む入口はその回答である。作らなければ、最初の
   pickup の後に人間しか書けない path を変える出口が「task を全部決着させて削除の扉 → 再登録」しか無い。ADR 0351 決定4 の「verb は作らない」
   は契機についてだけ決め直す —— 内容を運ぶのは回答のままである。remote-backed は拒み、回答の時点でも確かめ直す。取り込める条件は local
   着地の `merge` と同じ(保護ブランチが基準と同じ。workspace の Quarantine が開いている間は拒む)。未決着か着地待ちの task のブランチに
   属する commit を含む tip は拒み、その task の `merge` を名指す —— task の内容が保護ブランチへ入る道は着地の回答だけに保つ。question は
   Quarantine ではないので pickup を止めず、workspace の未決着に数えて、開いている間は削除の扉が拒む。purely-local の封じ込めの Quarantine の
   回答は、同じ手順で作業台の tip を取り込んでから検査する(取り込むものが無ければ検査だけ。取り込んだ後の tree に隠せない形が残るなら
   書く前に拒む)。「基準へ戻す」が落とした commit を拾い直す専用の道は作らない —— 同じ作業台で merge か cherry-pick できる。
7. **作業台は、盤面が拒むその操作の中で開く。** conflict で回答を拒むとき、昇格の失敗が追いつきの conflict だったとき(question を立てる
   時点)、外の push が落とした内容で `merge` を拒むとき(conflict の有無に依らない)に開き、question を立てる時点で merge を試す事前検査は
   足さない。Quarantine が立つ場面で開く時点は受理の決定が持つ(#3185)。同じ鍵の入口は1つの作業台を共有する。拒むたびに盤面は ref を
   `refs/heads/board/*` に引き直すが、人間の commit は branch に残る。
8. **「人間が渡した」は場所と面で担保し、身元の検査は足さない。** 作業台は全 worker の書き込み root の外に置き、操作と回答は人間の面
   (WebUI と management MCP)からだけ届く。強さは今のほかの回答と同じで、それより強くはしない。
9. **作業台は、人間の自前の clone の git remote になる。** 盤面は作業台の全部に `receive.denyCurrentBranch=updateInstead` を置き(task の
   checkout には置かない)、人間はいつもの環境で fetch して書き、作業台へ push する。remote-backed でも purely-local でも同じ手で、盤面の host に
   入らなくてよい。入口は変えない —— 自前の clone の path も sha も受けず、盤面は自前の clone を読まない。人間担当の work を origin 経由で
   受ける扉は作らない(#3232)。
10. **積み残しは `retry` が merge back を撃ち直し、外の push が落とした内容は `merge` が取り込んで盤面が push する。** 積み残しの失敗
    question の `retry` は、その root の分解ツリーの merge back を受理と同じ条件で撃ち直す。外の push が落とした内容を盤面は自分では merge
    しない —— clean に戻せる場合でも人間が作業台で merge を commit し(戻すか、捨てるか。GitHub の head が巻き戻されただけなら commit は
    要らない)、`merge` の回答が取り込んで、同じ回答の中で盤面が origin へ push する。
11. **拒否文は、作業台の path、そこで打つ `git merge <ref>`、tip の条件、答え直す回答を言う。** 場所を言うのは作業台を開いた拒否文で
    (開いた時点で question が立つ場面は本文も)、本文に予告は足さない。人間は名前の場所の ref を動かさないので、ADR 0370 決定7 の3手
    (retry が拒まれる → Quarantine に回答 → もう一度 retry)は無くなる。決めたのは文が言う要素までで、最終文面は spec が書く(#3191)。

## 退けた形

- **conflict を worker の task に寄せる**(追いつき・local 着地・外の push)—— worker の子が abandon か cancel になれば conflict は人間の入口に
  戻るので、寄せても入口は消せず機構が2つになる。外の push は「戻すか捨てるか」が人間の選択で、選択肢は運べない。完了の門で worker に
  帰り先へ追いつかせる形は map の外(#3189)。
- **入口が自前の clone の path や sha を受ける** —— 盤面が形を知らない git を読むことになる。
- **包む commit を作らない形**(親がちょうど2つの merge commit 1個に締める、first-parent を検査する、正しい向きなら包まない、tip が1つなら
  fast-forward)—— 書く先が進んだ後の続きの merge が壊れるか、記録に入る形が2通りになる。盤面が親を固定して人間の tree だけ使う形は、
  人間が一緒に merge した別の子の祖先関係を落とす。
- **「開く」と「取り込む」を操作2つにして question を作らない** —— 取り込みの入口が回答と操作の2通りになる。
- **別名の branch へ push して host で `git merge --ff-only`** —— host に入る1手が残る。毎回 host に入って環境のずれを抱える費用で退けた。
- **本文に作業台の path を予告する / 開いたことを event に残す** —— コマンド列は拒否の時点でしか決まらず、記録が1種類増える。

## 帰結

- 記録に入る object に、人間が作業台に書いたものと盤面が作る包む commit が加わる(ADR 0364 決定1 の不変条件に項が足される)。
- 人間しか書けない path を拒む場所に取り込みが加わる。比べる相手は fork 元との merge-base でなく、入力の tip である(ADR 0362 決定2)。
- 取り込みは作業台の branch を動かさない。続きを書く人は、盤面が引き直した ref へ fast-forward してから書く(#3216)。
- 「作業台」は人間の側の語になる。ADR 0356 の「worker の作業台」は task の checkout を指す。
- Mac の盤面では作業台の path は VM の中を指す。届き方は docs が言う。
