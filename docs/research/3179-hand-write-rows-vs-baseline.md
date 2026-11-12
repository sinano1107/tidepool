# H1〜H21 の各行は、基準と比べられる ref を動かすか(#3179)

- 問い: issue #3179。表の出どころは #3158 の最初のコメント(H1〜H21)と3つ目のコメント(行番号の訂正、H4)。
- 読んだコード: main `25c845515dd750edbbad43d15580323b41676a5d`。以下の `file:line` はすべてこの commit のもの。
- 設計の推奨は書かない。事実と、確かめた方法だけを書く。

## 1. 確かめ方の区別

この文書の主張には次の3種類の印を付ける。

| 印 | 意味 |
|---|---|
| **実測** | 素の git(2.47.0)を使い捨てのディレクトリで走らせた。盤面の関数も test も走らせていない。基準の文字列は `currentRefs`(`src/workspace.ts:1149–1154`、`1162–1169`)と同じ `for-each-ref` の format と HEAD の行を shell で写したもので、盤面のコードそのものではない。fixture は合成(main、親 `task/P`、同じファイルを書いて conflict する子 `task/C`、bare の origin)。script と出力は付録。 |
| **読み** | コード・ADR・test を読んだだけ。走らせていない。 |
| **未確認** | 読んでも走らせてもいない。 |

実測が言えるのは「その git コマンドの後、基準と同じ形の文字列のどの行が変わるか」までである。盤面がそれをどの時点で違反として捕まえるかは、すべて読みである。

## 2. 基準が撮る ref の集合と、比較器が捕まえる変化

### 2.1 撮る集合(読み)

- 基準は `workspace_state.ref_snapshot` の1本の text で、鍵は名前(`src/db.ts:241–250`、`src/workspace.ts:1192–1197`)。持つのは名前の場所だけ —— 実環境の workspace、面接室(鍵は root の id)、Interview の root が読む場所(`src/workspace.ts:1104`、`1119`、ADR 0356 決定4、ADR 0351 決定6)。task の checkout は基準を持たない。
- 中身は `git for-each-ref` の全行に HEAD の1行を足したもの(`src/workspace.ts:1149–1154`)。**`refs/*` の全部**: `refs/heads/*`、`refs/remotes/*`(写し)、`refs/tags/*`、`refs/stash`、`refs/notes/*`、盤面自身の `refs/keep-around/*`(`src/workspace.ts:861–862`)、その他どの名前空間も。範囲を名前で切らない(ADR 0064 決定1)。
- 値は objectname。symref の行(`refs/remotes/origin/HEAD` など)は解決値でなく指し先 `symref=<target>`(ADR 0081、`src/workspace.ts:1149`)。HEAD の行は指し先、detached なら sha(`src/workspace.ts:1162–1169`、ADR 0345 決定2)。
- 盤面が口(`writeBoardRefs`、`src/workspace.ts:1334–1371`)で書いている最中の行は `<old>|<new>` の2値で、どちらの値も一致と読む(`src/workspace.ts:1241–1250`、ADR 0243 決定1・2)。

### 2.2 比較器(読み)

`compareAndFoldBaseline`(`src/workspace.ts:1269–1287`)は、基準の行の集合と今の行の集合の和集合を歩き、`except` に無い ref で値が合わないものを全部違反にする。

- 捕まえる変化は3つ: **移動**(値が違う)、**削除**(基準にあって今は無い)、**新規作成**(基準に無くて今はある)(`:1272–1274`、ADR 0064 決定2)。symref は付け替え・削除・作成、HEAD は別のブランチへの付け替えと detach。
- 違反は `RefsMovedError` で、動いた ref を `was:` / `now:` で名指す(`:1275–1283`)。呼び手は workspace の Quarantine に落とす。
- 呼び手は HEAD で2箇所だけ: pickup(`prepareRefBaseline` `:1181`、呼ぶのは `prepareWorkspaceAtPickup` の `:1104` と読む場所の `:1119`、除外なし)と解放(`settleTaskCheckout` の `:1800`、門の掛かる完了は除外なし、それ以外は自分の `task/<id>` だけ除外)。
- 1本の ref だけを基準と突き合わせる検査が2箇所: 完了の門(`recordTaskCheckoutTip` `src/workspace.ts:737–742`、自分の `task/<id>`)と local 着地(`mergeTaskToProtected` `src/workspace.ts:2017–2021`、保護ブランチ)。
- 比べずに全部を撮り直すのが Quarantine の受理(`retakeRefBaselines` `src/workspace.ts:1203–1209`、呼び手 `src/human-verbs.ts:667`)。workspace の Quarantine の受理だけで、封じ込めの受理(`src/human-verbs.ts:692–711`)は撮り直さない。
- 着地の収束・PR の merge の回答・無人 merge の tick は、HEAD では基準と比べない。ADR 0370 決定1 は決定済みだが、実装の spec #3166 は OPEN で、`compareAndFoldBaseline` は export されておらず呼び手は上の2箇所だけである(`grep`)。ADR 0369 の受理のやり直し(#3152)も OPEN で、受理のコード(`src/human-verbs.ts:628–668`)に無い。
- 口は、書く ref の今の値を基準と比べない: 予告は基準の行の値に `|<new>` を足し、書いた後に ref が `new` なら行を `new` に畳む(`src/workspace.ts:1341–1357`)。ref の今の値を読んでから書く盤面の手(`advanceBranch` `:944–951` の4つの呼び手 —— 休止位置 `:1465`、merge back `:1878`、追いつき `:1987`、local 着地 `:2029` —— と完了の門)のうち、書く前にその値を基準と突き合わせるのは、上に挙げた完了の門と local 着地の2つだけである。registry の clone への書き込みが通る口は `src/server-options.ts:516`。

### 2.3 基準が見ないもの

| 見ないもの | 根拠 |
|---|---|
| `.git/config`(remote の有無・URL・`user.*`・upstream の設定)、`.git/info/exclude`、hooks、sparse-checkout の設定 | 実測 X1、H12b、H12d |
| 作業ツリーと index の中身 | 実測 H11、H11c。作業ツリーは基準でなく別の検査が読む: pickup の休止位置の clean 検査(`src/workspace.ts:1109–1114`)と受理の `verifyWorkspaceClean`(`:1484–1500`) |
| `ORIG_HEAD` / `FETCH_HEAD` / `MERGE_HEAD` などの擬似 ref、reflog、objects、pack の形 | 実測 H1(残った `ORIG_HEAD`・`FETCH_HEAD` は行に出ない)、H16 の2つ目(宛先 ref の無い fetch)、X6 |
| linked worktree の detached HEAD とそこでの commit | 実測 X2(`-b` 付きの `worktree add` は新しい `refs/heads/*` を作るので見える —— X3) |
| 動いて元の値に戻った ref | 実測 T1。比較は2時点の値の突き合わせで、間の経過は見ない |
| origin 側(remote の repo)の状態、registry の内容、別の checkout | 基準は1つの checkout の ref の表(2.1)。registry の clone が workspace として登録されているときだけ、registry の ref がその workspace の基準に入る(`src/registry-write.ts:157–173` が口 `writeRef` を通す) |

## 3. H1〜H21: 指示どおりに手を動かすと何が変わるか

- 前提(読み): 名前の場所の HEAD は休止中、保護ブランチに居る(ADR 0356 決定1、`src/workspace.ts:1447–1452`)。したがって `task/<id>` に手で merge するには、人間が先に `git checkout task/<id>` をすることになり、HEAD の行も動く(戻せば HEAD の行は元に戻る —— 実測 H1 の2つ目)。
- 「基準が覆う ref」の列は、指示の文面をそのまま git に写したときに行が変わる ref。「基準が覆わない変化」はそれ以外。
- 「remote-backed」「purely-local」は GLOSSARY.md の語のとおり。

| # | 今の出どころ(HEAD) | 基準が覆う ref で動くもの | 基準が覆わない変化 | 確かめ方 |
|---|---|---|---|---|
| H1 | `mergeBackInto` の文 `src/workspace.ts:1873–1875`(関数 `:1855–1879`、呼び手 `:1680`、`:1931`)。ADR 0240 決定4 | 帰り先の `refs/heads/task/<帰り先>`(追加の merge commit)。HEAD の行(保護ブランチ → `task/<帰り先>`、人間が戻さなければ) | 作業ツリー・index、`ORIG_HEAD` | 実測 H1・L-H1。受理の後に基準が merge 後の位置を持つことは test の読み(`tests/board-ref-gate.test.ts:459–489`) |
| H2 | 同じ文の `git merge -s ours`(`:1874`)。ADR 0239 帰結(帰結は「そのブランチを push する」まで言うが、コードの文は push を言わない —— 名前の場所から push すれば写しも動く) | H1 と同じ2行(`task/<帰り先>` に内容を変えない merge commit、HEAD) | 作業ツリーは変わらない | 実測 H2 |
| H3 | `outsidePushDropNotice` `src/landing.ts:283–288`(関数 `:273–289`、呼び手 `src/human-verbs.ts:1282–1283`、`src/landing.ts:1467`)。ADR 0242 決定4。`push that content back onto task/<id>` | どこから push するかで割れる。**名前の場所から**で origin が盤面の最後の push の祖先へ巻き戻されただけなら、行は1つも変わらない(写しが元からその sha を持つ)。origin が分岐していれば push は拒まれ、`git fetch origin` が `refs/remotes/origin/task/<id>` を、手の merge が `refs/heads/task/<id>` と HEAD を、push が写しをもう一度動かす。**別の clone から**なら名前の場所の ref は動かない | origin 側の `task/<id>`。`git fetch origin` は origin で動いていた他の写しも全部動かす(それは覆われる側) | 実測 H3(巻き戻し)・H3b(分岐)。別の clone の場合は読み(sha の fetch は `refs/` に書かない —— `src/workspace.ts:1074–1083`、`src/github-auth.ts:301–309`) |
| H4 | 同じ文の `git fetch origin` → `git reset --hard origin/task/<id>` → `git merge -s ours` → push(`src/landing.ts:285–287`) | 文面どおり(checkout を挟まない)だと: `refs/remotes/origin/task/<id>`(fetch)、**`refs/heads/<保護ブランチ>`**(reset が `origin/task/<id>` へ動かし、`merge -s ours` がその上に commit を足す)。**`refs/heads/task/<id>` は動かない**。最後の `git push` は、保護ブランチに upstream があり、origin の保護ブランチが PR の head の祖先で、origin が拒まなければ、`refs/remotes/origin/<保護ブランチ>` も動かす。先に `git checkout task/<id>` をする読みなら: `refs/heads/task/<id>`(巻き戻しと追加)、写し、HEAD | 文面どおりで、次の3つが揃うとき、**origin の保護ブランチ**が `task/<id>` の head と merge commit へ fast-forward される: 保護ブランチに upstream がある、origin の保護ブランチが `origin/task/<id>` の祖先である(そうでなければ non-fast-forward で拒まれる —— fixture は作りの上でこれを満たす)、origin が push を拒まない(branch protection の無い bare の origin での実測。GitHub の branch protection は未確認)。upstream が無ければ `git push` は exit 128 で何も送らない。作業ツリーは `origin/task/<id>` の内容になる | 実測 H4(upstream なし: 素の `git push` は exit 128、`push.default=current` を付けると保護ブランチが送られる)・H4b(upstream あり)・H4c(checkout を挟む読み)。upstream の有無は作り方による: clone モードは `git clone`(`src/github-auth.ts:329–333`、`src/workspace-create.ts:832`)、create + `publish` は `git remote add` だけ(`src/workspace-create.ts:521`)—— `git clone` が upstream を張ることは git の既定の読みで、盤面の関数では測っていない。同じ手順を打つ test(`tests/landing.test.ts:4190–4203`)は checkout を挟まず、最後は `git push origin task/<id>` と branch を名指す —— その fixture の HEAD の位置は読んでいない |
| H5 | 着地の `afterPush` の文 `src/landing.ts:1115–1116`(`:1102–1121`)。remote-backed の PR の経路だけ | `refs/heads/task/<root>`(子孫の内容の merge)、HEAD(戻さなければ) | 作業ツリー | 実測 H5。retry の収束が比べずに今の tip を push し、口が予告するのは写し `refs/remotes/origin/task/<root>` だけであることは読み(`src/landing.ts:1175–1194`、`:1214–1215`) |
| H6 | `catchUpTaskBranch` の文 `src/workspace.ts:1983–1984`(関数 `:1974–1988`、呼び手 `src/landing.ts:1169–1171`)。ADR 0105 決定2。remote-backed だけ | `refs/heads/task/<id>`(`origin/<保護ブランチ>` との merge)、HEAD(戻さなければ)。先に `git fetch origin` を打てば動いていた写しも | 作業ツリー | 実測 H6。retry で `catchUpTaskBranch` が何も書かずに返ることは読み(`:1978`) |
| H7 | `landingConflict` の文 `src/workspace.ts:1994–1995`(`:1992–1997`、投げるのは `:2027`)。ADR 0103 決定4。purely-local だけ(`:2012–2014`) | 文は merge の向きを言わない。(a) 保護ブランチを `task/<id>` に merge: `refs/heads/task/<id>`、HEAD(戻さなければ)。(b) `task/<id>` を保護ブランチに merge: `refs/heads/<保護ブランチ>`(HEAD は動かない) | 作業ツリー | 実測 L-H7a・L-H7b。(a) の後の回答し直しは保護ブランチの行だけを突き合わせて通り、(b) の後は帯域外と読まれて Quarantine に落ちることは読み(`src/workspace.ts:2017–2021`、`src/human-verbs.ts:1220–1231`) |
| H8 | Quarantine の本文 `src/quarantine.ts:296–298`、受理 `src/human-verbs.ts:628–668`、全撮り `src/workspace.ts:1203–1209`。ADR 0064 決定7、ADR 0351 決定4 | 回答するだけなら何も動かない(受理が今の全 ref を基準に撮る)。手で戻すなら、動いた ref をもう一度書く(`update-ref` / `branch -f` / `reset`) | — | 読み。「戻した ref は比較に見えない」は実測 T1 |
| H9 | `parkOnProtectedBranch` `src/workspace.ts:1447–1477`(分岐 `:1468`、ff できない `:1471`、先行 `:1474–1475`)。ADR 0052 §7(`docs/adr/0052-…md:114–122`)。remote-backed だけ(`:1457`)。文は事実を言うだけで手順は書いていない | origin へ巻き戻すなら `refs/heads/<保護ブランチ>`。push するなら `refs/remotes/origin/<保護ブランチ>` | push なら origin の保護ブランチ。巻き戻しなら作業ツリー | 実測 H9a・H9b |
| H10 | `src/workspace.ts:1455`(「cannot be checked out」、`checkoutThroughGate` `:922–941`)。remote-backed は盤面が origin から口を通して作る(`:930–933`) | 手で作るなら新しい `refs/heads/<保護ブランチ>`(基準にその行が残っていて同じ sha に戻すなら行は一致する)。HEAD が detached になっていれば、戻すときに HEAD の行も | registry の `branch` を手で直すなら registry の内容(名前の場所の ref ではない) | 実測 H10・L-H10。test は題だけ読んだ(`tests/workspace-ref-snapshot.test.ts:56`) |
| H11 | 受理の `verifyWorkspaceClean` `src/workspace.ts:1484–1500`(文 `:1498`)、pickup の clean 検査 `:1109–1114`、本文の予告 `src/quarantine.ts:282` | 直し方で割れる。`git stash`: 新しい `refs/stash`。commit: HEAD のブランチ(休止中は保護ブランチ)。`git checkout -- .` / `git clean`: 何も動かない | 作業ツリー(どの直し方でも) | 実測 H11・H11a〜c・L-H11a |
| H12 | `CheckoutHasOriginError` `src/workspace-create.ts:476–483`(文 `:479`、投げるのは `publish` の `:500`)。pickup 側の同じ食い違いは `assertRemoteDeclarationMatchesClone` `src/pickup-predicates.ts:384–392`(文は事実だけ) | `git remote remove origin`: `refs/remotes/origin/*` が全部消える(symref `origin/HEAD` を含む)。`git remote add` の後の `git fetch origin`: 写しが新規に並ぶ(git 2.47.0 では `origin/HEAD` は作られなかった) | `git remote add` / `set-url` だけなら `.git/config` だけ。registry に `repo` を足す直し方なら registry の内容 | 実測 H12a〜d |
| H13 | `.git` の形: `assertOwnGitDirectory` `src/pickup-predicates.ts:297–`(ADR 0146 決定1・2)。path の差し替え: ADR 0351 決定7、行を消す削除の扉は `dropWorkspaceState` `src/workspace.ts:1213–1218`(呼び手 `src/workspace-create.ts:435`) | 基準の鍵は名前なので、同じ名前の path を別の checkout に差し替えると、旧い基準と新しい checkout の全 ref が比べられる。origin の新しい clone なら `refs/heads/task/*` の行が全部消える側に出る(写しと保護ブランチは値が同じなら一致) | registry の `path`、別の checkout そのもの(作業ツリー・config・objects 全部) | 実測 H13(新しい clone との差)。鍵が名前であることは読み(`src/workspace.ts:1179`、`:1194`) |
| H14 | `guardRegistryDefaultBranch` `src/workspace.ts:1563–1586`(文 `:1583`、呼び手 `src/claude-worker.ts:1566`)。registry の clone が workspace として登録されているときだけ Quarantine になる(`:1578–1579`) | symref `refs/remotes/origin/HEAD` の行(付け替えも削除も行が変わる) | remote 側の default branch を変える直し方なら origin 側だけ(その後 `git remote set-head` を打てば symref の行) | 実測 H14a〜c |
| H15 | `GONE_ROOM_EXITS` `src/pickup-predicates.ts:13`(使うのは `:111`)。ADR 0277 追記 決定2(`docs/adr/0277-…md:48–52`、出題前だけ —— 同 `:3`) | 手の `git init` の直後: `refs/*` は空、HEAD は未生で指し先は `init.defaultBranch`(設定が無ければ `master`)。面接室の基準(鍵は root の id)の行は全部「消えた」側。復元なら復元した写しの ref | 新しい repo そのもの(objects・config) | 実測 H15(素の `git init`)。その後の開き直しが `main` と HEAD を口で書くことは読み(`src/workspace.ts:250–259`)、test は題だけ(`tests/ref-baseline-continuity.test.ts:264`) |
| H16 | `src/workspace.ts:1755–1757`(`settleTaskCheckout` の門の掛かる完了の枝 `:1745–1760`)。文は tip の置き場所を言わない | 名前の場所の `task/<id>` に置くなら `refs/heads/task/<id>` | 残した task の checkout(別の git ディレクトリ)。宛先 ref を付けない fetch なら objects と `FETCH_HEAD` だけ | 実測 H16/H17 の2つ。到達するかは未確認(#3150 は OPEN) |
| H17 | `runPlaceToRelease` `src/teardown.ts:447–449`(`:440–457`)、文は `KEPT_TASK_CHECKOUT.at` `src/workspace.ts:1821–1825`。ADR 0363 決定4。ADR 0369 決定6(`docs/adr/0369-…md:31–32`、理由に在り処を書かない)は未実装(#3152 OPEN)で、HEAD は在り処を書く | 文は行き先を言わない(「not on the task branch」だけ)。名前の場所へ運ぶなら H16 と同じ `refs/heads/task/<id>` | drift の修理そのものは registry(名前の再登録)。残した task の checkout | 実測 H16/H17(運ぶ場合)。文面は読み |
| H18 | `claudeWorkspaceContainment` `src/harness-containment.ts:36–38`(関数 `:28–40`、呼び手 `src/claude-worker.ts:1628`、`src/human-verbs.ts:702–705`)。本文 `src/quarantine.ts:388–392`。ADR 0360 決定3 | purely-local: 名前の場所の `refs/heads/<保護ブランチ>`(commit の追加)。remote-backed: 人間が origin へ push するなら名前の場所の ref は人間の手では動かない(受理の fetch が写しを口で書く —— `src/workspace.ts:1068–1072`、読むのは写し `src/pickup-predicates.ts:54–56`) | 作業ツリー(名前の場所で commit するなら)。remote-backed は origin 側 | 実測 L-H18/19/21。この受理が基準を撮り直さないことは読み(`src/human-verbs.ts:692–711` に `retakeRefBaselines` が無い)、remote-backed は test の題だけ(`tests/workspace-containment.test.ts:237`) |
| H19 | ADR 0362 決定1(`docs/adr/0362-…md:19–21`)。コード側は worker の tip を拒む門だけ(`src/mcp.ts:372–383`)。人間がどこに書くかを言う文は、`src/*.ts` の grep(`by hand` / `by the human` / `yourself` / `manually` / `then answer` / `then retry` ほかの指示の句)と ADR 0362 の決定1〜3・射程の境界には無かった | purely-local で名前の場所に書くなら H18 と同じ `refs/heads/<保護ブランチ>` | remote-backed なら origin 側 | 実測 L-H18/19/21(commit した場合)。書く場所は読みでも決まらない |
| H20 | `landingCandidateIds` `src/landing.ts:430–431`(コメント)、`:437`(SQL)。test は題だけ(`tests/landing.test.ts:1576`) | 何も動かない(人間が担当した work は根にならず、内容を運ぶ手が無い) | — | 読み |
| H21 | ADR 0351 決定1、`docs/mac-first-boot.md:285–286` | 最初の pickup の後に名前の場所で commit すれば `refs/heads/<保護ブランチ>`。ほかの手(branch、tag、stash)もそれぞれ新しい行 | 作業ツリー | 実測 L-H18/19/21、X4。次の pickup が保護ブランチを名指して止めることは test の題だけ(`tests/ref-baseline-continuity.test.ts:60`、`tests/teardown-rerun.test.ts:363`) |

### 3.1 行をまたぐ事実

- **基準が覆う ref を1本も動かさない行**: H8(回答するだけ)、H20、H11 のうち `checkout -- .` / `clean` で直す場合、H12 のうち `remote add` / `set-url` だけの場合、H14 のうち remote 側だけ直す場合、H18・H19 の remote-backed(人間は origin に書く)、H3 のうち別の clone から push する場合と、名前の場所から巻き戻しを押し戻すだけの場合。
- **保護ブランチを動かす行**: H4(文面どおり)、H7(b)、H9(巻き戻し)、H10、H11(commit)、H18・H19・H21(purely-local)。
- **`task/<id>` を動かす行**: H1、H2、H3(分岐)、H4(checkout を挟む読み)、H5、H6、H7(a)、H16、H17。
- **写しを動かす行**: H3(分岐)、H4、H9(push)、H12、H14。人間が名前の場所から打つ `git push` は、送ったブランチの `refs/remotes/origin/<branch>` を動かす(実測 H9b、H3b、H4b)。
- **HEAD の行**: 名前の場所の HEAD は保護ブランチに居るので、`task/<id>` への手の merge(H1、H2、H3、H5、H6、H7a)は checkout を伴い、戻さない限り HEAD の行が動く。

## 4. 「読んでいない範囲」を読んだ結果と、足す行

#3158 の最初のコメントが挙げた5つの範囲について。

| 範囲 | 読んだもの | 結果 |
|---|---|---|
| tests | 指示の文面と、名前の場所への素の git の手を grep(`by hand` / `merge -s ours` / `reset --hard origin` ほか、`git(<place>.path, "merge"\|"checkout"\|"reset"\|"stash"\|"commit"\|"update-ref"\|"remote"\|…)`)。`it(` の題を読んだのは `tests/workspace-ref-snapshot.test.ts`、`ref-baseline-continuity.test.ts`、`board-ref-gate.test.ts`、`read-place-baseline.test.ts` の4本。本体を読んだのは `tests/board-ref-gate.test.ts:459–532` と `tests/github-auth.test.ts:509–517` | 表に無い場面を1つ足す(N2)。ほかは H1・H2・H8・H10・H15・H18・H21 と完了の門(N6)に当たる題だった。着地側は `tests/landing.test.ts`・`purely-local-landing.test.ts`・`open-pr-repair-push.test.ts`・`task-checkout.test.ts`・`release-workspace-completion.test.ts` の題を `conflict` / 積み残し / 外の push / 手で / 帯域外 / 追いつ で grep して読み、どれも H1〜H7 の行に当たった(本体を読んだのは `tests/landing.test.ts:4190–4203` だけ)。`tests/landing.test.ts` のほかの本体(名前の場所への素の git の手が 149 箇所)は読んでいない |
| `mcp.ts` の完了の門の呼び手 | `src/mcp.ts:300–429`、`:752–775`(`complete_task`)、`:855–885`(`pose_probe`) | 門の呼び手は `complete_task` の1箇所(`:768`)。記録へ書く verb はもう1つ `pose_probe` → `commitRoomCopy`(`:868`)。どちらも worker 宛ての拒否で、人間に名前の場所へ書けと言う文は無い(N6 に事実だけ書く) |
| `registry-write.ts` / `github.ts` / `push.ts` の本体 | `src/registry-write.ts` 全部、`src/github.ts:228–285`・`:317–323`(`:286–401` の残りは method の頭と `throw` の行だけ)、`src/push.ts` 全部、`src/github-auth.ts:180–333` | `src/push.ts` は Web Push の通知で、git を撃たない。盤面の git の push は `authedPush`(`src/github-auth.ts:316–325`)の1つで、写しを push の成功の後に `update-ref` で書く。人間宛ての手の書き込みの指示は、この範囲では N2 の1つ。`src/github.ts:1–227` と `src/registry.ts` は読んでいない |
| GitHub でない origin の着地 | `src/landing.ts:1145–1281`、`:586–624`、`:942–953`、`src/github.ts:244–263`、`src/github-auth.ts:180–184` | N3 |
| Codex の封じ込めの理由文 | `src/codex-worker.ts:695–712`、`:925–989`、`:1278–1292`、`:1392–1425`、`:1516–1524`、`:1596–1630`、`src/quarantine.ts:349–396` | N1 |

### 4.1 足す行

| # | 場面 | 出どころ(HEAD) | 基準が覆う ref で動くもの | 基準が覆わない変化 | 確かめ方 |
|---|---|---|---|---|---|
| N1 | (codex, workspace) の封じ込めの修理 | 理由文 `src/codex-worker.ts:986–989`(「find where Codex loads them from and remove or disable them there」)。本文 `src/quarantine.ts:388–392`(「Repair the checkout as described above」)。spawn の検査は `realpathSync(place.path)`(`src/codex-worker.ts:1523`、`:1608`)、回答時の検査は名前の場所の `target.path`(`src/codex-worker.ts:1400`、`src/human-verbs.ts:694–701`)に `skills/list` を撃つ | 文は場所を言わない。skill が tracked な file で、名前の場所の保護ブランチから消す直し方なら H18 と同じ `refs/heads/<保護ブランチ>`(purely-local) | 名前の場所の作業ツリーの untracked / ignored な file を消す、host の Codex の設定を直す、のどちらも ref は動かない | 読み。spawn 側の `place` は `taskRunPlace` の戻り値(`src/codex-worker.ts:1492`)で、回答時は名前の場所 —— 2つの検査は別のディレクトリに撃つ(`taskRunPlace` の本体は読んでいない)。この受理も基準を撮り直さない(`src/human-verbs.ts:692–711`) |
| N2 | GitHub でない ssh の origin で盤面の git が止まる | `src/github-auth.ts:363–364`(「the board reaches a remote only over https or a local path — the origin `…` is an ssh remote outside GitHub」)。test `tests/github-auth.test.ts:509–517` | 何も動かない | `.git/config` の `remote.origin.url`(人間が直す値として文が名指す) | 文面は読み。`git remote set-url` で行が変わらないことは実測 H12d |
| N3 | GitHub でない origin を持つ remote-backed の workspace の着地 | PR の経路は push の前に `findPullRequestByHead` を撃ち(`src/landing.ts:1222`)、`gh` の口が「the checkout … has no origin on GitHub」で投げる(`src/github.ts:244–247`、`originRepo` は GitHub でない値に `undefined` —— `src/github-auth.ts:180–184`)。失敗は PR 昇格失敗 question になり、選択肢は `retry` / `abandon promotion`(`src/landing.ts:586–598`、`:942–953`、`:1274–1281`、`src/tasks.ts:2932`) | 文は手の書き込みを指示しない。盤面にこの origin へ着地させる経路は読んだ範囲に無い。人間が名前の場所から `git push origin task/<id>` を打てば `refs/remotes/origin/task/<id>` | origin 側 | 読み。push で写しが動くことは実測 H9b の類推で、この場面そのものは走らせていない。`deps.github` が無い盤面では先に `github_not_configured` で返る(`:1165–1167`) |
| N4 | 出題済みの面接室で、出題の head や fetch する閉包の object が無い | `GONE_POSED_PLACE_EXITS` `src/pickup-predicates.ts:15`(「restore it there or cancel the task that opens it」、使うのは `:111`、`:121`、`:141`)、検査 `:122–125`、`:142–155` | 復元の仕方による。object だけを戻す(宛先 ref の無い fetch、objects のコピー)なら何も動かない。ref ごと戻せばその ref | objects | 読み。宛先 ref の無い fetch で行が変わらないことは実測 H16 の2つ目 |
| N5 | registry の clone の2つの宣言の食い違い | `assertRegistryRoleAgrees` `src/pickup-predicates.ts:404–416`(文は事実だけ) | origin を足す・外す直し方なら H12 と同じ | registry の mode か entry を直すなら registry / 盤面の設定 | 読み |
| N6 | 完了の門が、人間が動かした名前の場所の `task/<id>` に当たる | `recordTaskCheckoutTip` `src/workspace.ts:737–742` が `RefsMovedError` を投げ、worker には理由を載せない一般の文が返る(`src/mcp.ts:359`)。資源の停止は登録しない(ADR 0359 決定4)。test は題だけ(`tests/task-checkout.test.ts:226`) | 人間への指示は無い(場面の事実だけ)。この時点で人間に届く文は、読んだ範囲に無い | — | 読み |

表に足さなかったもの(理由つき、いずれも読み):

- worker の repo の故障で残した task の checkout(`failTaskOnRelease` `src/workspace.ts:1829–1851`、文 `:1821–1825`): failure question は在り処と `retry` を言うだけで、名前の場所へ書けとは言わない。人間が中身を名前の場所へ運ぶなら H16 と同じ ref が動く。H17(drift)とは契機が違う。
- 盤面の状態 path との重なり(`src/human-verbs.ts:653–656`、`src/claude-worker.ts:1616–1620`): 直すのは path(registry か filesystem)で、ref ではない。理由文(`boardStateOverlap` の本体)は読んでいない。
- `OrphanCheckoutMismatchError`(`src/workspace-create.ts:580–587`、「move it aside by hand」): 登録の前で、その名前の基準の行はまだ無い。
- `human-verbs.ts:729`(「Kill them by hand」): process の話で、名前の場所への書き込みではない。

## 5. #3158 の表・コメントと食い違う点

1. **H4**: 3つ目のコメントは「`reset --hard` がローカルの保護ブランチを動かす」まで実測していた。加えて、文面どおりに最後の `git push` まで打つと、保護ブランチに upstream がある checkout で、origin の保護ブランチが PR の head の祖先で、origin が拒まなければ、**origin の保護ブランチ**へ `task/<id>` の head と merge commit が fast-forward で入る(実測 H4b、branch protection の無い origin)。この間 `refs/heads/task/<id>` は1度も動かない。最初のコメントの表の「`task/<id>` の巻き戻しと追加、写しの ref、HEAD」は、先に `git checkout task/<id>` を打つ読み(実測 H4c)にだけ当たる。
2. **H3**: 表は「名前の場所から push すれば写しの ref」。origin が盤面の最後の push の祖先へ巻き戻されただけの場合、押し戻しても写しは元からその sha を持つので、基準の文字列は1行も変わらない(実測 H3)。行が動くのは origin が分岐していた場合(実測 H3b)。
3. **「読んでいない範囲」の `push.ts`**: git の push ではなく Web Push の通知だった。git の push は `src/github-auth.ts:316–325`。
4. **行番号**: 最初のコメント(`f7c172ed`)も3つ目のコメントの例(追いつき `1970–1971`、local 着地 `1981–1982`)も、HEAD とは合わない。HEAD の番号は3章の表。比較器まわりは: `compareAndFoldBaseline` `:1248` → `:1269`、pickup の呼び手 `:1160` → `:1181`、解放の呼び手 `:1787` → `:1800`、完了の門 `:727` → `:737–742`、local 着地 `:2005` → `:2017–2021`、`retakeRefBaselines` `:1182` → `:1203`(`src/human-verbs.ts:667` は同じ)。変わっていないのは H15(`:13`)、H17(`:447`)、H21(`:285`)。
5. **#3158 本文の「従うと盤面自身の比較が違反として捕まえ」**: HEAD で捕まえるのは次の pickup か解放の比較(と、H7(b) の local 着地の1本の検査)で、着地の retry そのものは比べずに進む(2.2)。本文と矛盾はしないが、捕まえる時点は着地ではない。

表のほかの行(H1、H2、H5〜H21 の「名前の場所で変わるもの」)は、読んだ範囲と実測した範囲で食い違いは見つからなかった。「種類」と「今ある扉」の列は、この調査では確かめていない(H18 の「この受理は基準を撮り直さない」だけ読みで確かめた)。

## 6. 読んでいない・走らせていないもの

- 盤面の関数と test suite は1つも走らせていない。受理・pickup・解放・着地が実際にどう振る舞うかは全部読みである。
- git は 2.47.0 の1版だけ。別の版で `git fetch` が消えた `origin/HEAD` を作り直すかは未確認(H12c・H14c に効く)。
- GitHub の branch protection、GitHub 上の PR、installation token の経路は使っていない(origin はローカルの bare repo)。
- `src/scheduler.ts` は pickup の順の行(`:633`、`:644`、`:651`、`:658`)を grep で見ただけ。`src/server-options.ts:516`、`src/workspace-create.ts:435`、`src/claude-worker.ts:1566` も grep の1行だけで、前後は読んでいない。`src/api.ts`、`src/registry.ts`、`src/management-mcp.ts`、`src/board-state.ts`、`src/recorded-place.ts` は読んでいない。
- `src/codex-worker.ts` は 4章の表の範囲だけ。spawn の `place` の型は確かめていない。
- `tests/` は 410 個の entry のうち、題を読んだのが4本、本体を読んだのが2箇所。
- ADR は 0064・0239・0240・0242・0351・0370 を全文、0356 を決定6まで、0052(§7)・0103(決定4)・0105(決定2)・0146(決定1〜4)・0360(決定3)・0362(決定1・3)・0363(決定4)を該当の決定だけ、0243・0359・0369 は決定の見出し行だけ(0369 は決定6 だけ全文)読んだ。0066・0081・0277(Status 追記の1行と追記 決定2 だけ)・0345 は本文を読んでいない。
- #3158 の3つ目のコメントの読み手の表(A1〜A5、C1〜C11)は照合していない。

## 付録: 実測の script と出力

`bash run.sh <W>` の後に `bash run2.sh <W>` を走らせた(`<W>` は使い捨てのディレクトリ)。出力は `<W>` の絶対 path を置き換え、sha を先頭7桁に縮めただけで、ほかは手を入れていない。`was:` は基準の文字列にあって今は無い行、`now:` は今あって基準に無い行。

### run.sh

```bash
#!/bin/bash
# Plain-git experiments for #3179. No tidepool code is run.
# baseline() reproduces the text of currentRefs() in src/workspace.ts (REF_SNAPSHOT_FORMAT + HEAD line).
set -u
ROOT="$1"
rm -rf "$ROOT"; mkdir -p "$ROOT"; cd "$ROOT" || exit 1
export HOME="$ROOT/home"; mkdir -p "$HOME"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=h GIT_AUTHOR_EMAIL=h@example.invalid GIT_COMMITTER_NAME=h GIT_COMMITTER_EMAIL=h@example.invalid
export GIT_AUTHOR_DATE="2026-11-12T00:00:00Z" GIT_COMMITTER_DATE="2026-11-12T00:00:00Z"
G() { git -c init.defaultBranch=main -c advice.detachedHead=false "$@"; }

baseline() { # $1 = repo
  local head
  if head=$(G -C "$1" symbolic-ref -q HEAD); then head="symref=$head"; else head=$(G -C "$1" rev-parse HEAD); fi
  echo "$head HEAD"
  G -C "$1" for-each-ref '--format=%(if)%(symref)%(then)symref=%(symref)%(else)%(objectname)%(end) %(refname)'
}
show() { # $1 = label, $2 = repo ; prints diff baseline-before vs now
  baseline "$2" > "$ROOT/after.txt"
  echo "### $1"
  if diff "$ROOT/before.txt" "$ROOT/after.txt" > "$ROOT/d.txt"; then echo "(baseline text identical)"; else grep '^[<>]' "$ROOT/d.txt" | sed -e 's/^</was:/' -e 's/^>/now:/'; fi
  echo
}
fresh() { # copy the template to a new named place, record its baseline
  rm -rf "$ROOT/named" "$ROOT/origin.git"
  cp -R "$ROOT/tpl/named" "$ROOT/named"; cp -R "$ROOT/tpl/origin.git" "$ROOT/origin.git"
  baseline "$ROOT/named" > "$ROOT/before.txt"
}

echo "git version: $(git --version)"; echo

# ---- template: remote-backed named place; HEAD rests on main (ADR 0356 決定1) ----
mkdir -p tpl; G init -q --bare "$ROOT/origin.git"
G init -q tpl/named; N="$ROOT/tpl/named"
echo base > "$N/f.txt"; G -C "$N" add f.txt; G -C "$N" commit -q -m base
G -C "$N" branch task/P; G -C "$N" checkout -q task/P; echo p1 > "$N/p.txt"; G -C "$N" add p.txt; G -C "$N" commit -q -m p1
G -C "$N" branch task/C                      # child forks from the parent
echo parent > "$N/f.txt"; G -C "$N" commit -q -am "parent edits f"
G -C "$N" checkout -q task/C; echo child > "$N/f.txt"; G -C "$N" commit -q -am "child edits f (conflicts with parent)"
G -C "$N" checkout -q main
G -C "$N" remote add origin "$ROOT/origin.git"
G -C "$N" push -q origin main task/P
G -C "$N" fetch -q origin
G -C "$N" remote set-head origin main
cp -R "$ROOT/origin.git" "$ROOT/tpl/origin.git"
echo "## template baseline (remote-backed named place)"; baseline "$N"; echo

N="$ROOT/named"

echo "## H1 merge back conflict resolved by hand"
fresh; G -C "$N" checkout -q task/P; G -C "$N" merge -q task/C >/dev/null 2>&1; echo "merge exit=$? (conflict expected)"
echo resolved > "$N/f.txt"; G -C "$N" add f.txt; G -C "$N" commit -q -m "Merge task/C into task/P (by hand)"
show "H1 after merge+commit (HEAD left on task/P)" "$N"
G -C "$N" checkout -q main; show "H1 after the human also switches back to main" "$N"
echo "non-ref leftovers: $(ls "$N/.git" | grep -E 'ORIG_HEAD|MERGE_HEAD|FETCH_HEAD|AUTO_MERGE' | tr '\n' ' ')"; echo

echo "## H2 discard with merge -s ours"
fresh; G -C "$N" checkout -q task/P; G -C "$N" merge -q -s ours --no-edit task/C
show "H2 after checkout task/P + merge -s ours task/C" "$N"

echo "## H3 outside push dropped content; push it back"
fresh
# an outside clone force-pushes origin task/P back to its first commit
P1=$(G -C "$N" rev-parse task/P~1); G -C "$N" push -q -f origin "$P1:refs/heads/task/P"; G -C "$N" update-ref refs/remotes/origin/task/P "$(G -C "$N" rev-parse task/P)"
baseline "$N" > "$ROOT/before.txt"   # the board's copy still holds the head it last pushed
G -C "$N" push origin task/P:task/P > "$ROOT/out.txt" 2>&1; echo "plain push exit=$? : $(tail -1 "$ROOT/out.txt")"
show "H3 after 'git push origin task/P' from the named place" "$N"

echo "## H4 literal discard recipe: git fetch origin; git reset --hard origin/task/P; git merge -s ours task/C; git push"
fresh
P1=$(G -C "$N" rev-parse task/P~1); G -C "$N" push -q -f origin "$P1:refs/heads/task/P"; G -C "$N" update-ref refs/remotes/origin/task/P "$(G -C "$N" rev-parse task/P)"
baseline "$N" > "$ROOT/before.txt"
G -C "$N" fetch -q origin; show "H4 step1 after git fetch origin" "$N"
G -C "$N" reset -q --hard origin/task/P; show "H4 step2 after git reset --hard origin/task/P (HEAD is on main)" "$N"
G -C "$N" merge -q -s ours --no-edit task/C; show "H4 step3 after git merge -s ours task/C" "$N"
G -C "$N" push origin > "$ROOT/out.txt" 2>&1; echo "git push exit=$? :"; sed 's/^/    /' "$ROOT/out.txt"
G -C "$N" -c push.default=current push origin > "$ROOT/out.txt" 2>&1; echo "git push (push.default=current) exit=$? :"; sed 's/^/    /' "$ROOT/out.txt"
show "H4 step4 after push" "$N"
echo "origin now: $(G -C "$ROOT/origin.git" for-each-ref '--format=%(objectname:short) %(refname)' | tr '\n' ';')"; echo

echo "## H4b same recipe where main tracks origin/main (as in a cloned checkout): plain git push"
fresh
P1=$(G -C "$N" rev-parse task/P~1); G -C "$N" push -q -f origin "$P1:refs/heads/task/P"; G -C "$N" update-ref refs/remotes/origin/task/P "$(G -C "$N" rev-parse task/P)"
G -C "$N" branch -q --set-upstream-to=origin/main main
baseline "$N" > "$ROOT/before.txt"
G -C "$N" fetch -q origin; G -C "$N" reset -q --hard origin/task/P; G -C "$N" merge -q -s ours --no-edit task/C
G -C "$N" push > "$ROOT/out.txt" 2>&1; echo "git push exit=$? :"; sed 's/^/    /' "$ROOT/out.txt"
show "H4b after fetch + reset --hard + merge -s ours + push" "$N"
echo "local task/P: $(G -C "$N" rev-parse --short task/P)  origin: $(G -C "$ROOT/origin.git" for-each-ref '--format=%(objectname:short) %(refname)' | tr '\n' ';')"
echo "status: $(G -C "$N" status -sb | head -1)"; echo

echo "## H5 / H6 / H7 merges by hand on a task branch or the protected branch"
fresh; G -C "$N" checkout -q task/P; G -C "$N" merge -q -s ours --no-edit task/C; G -C "$N" checkout -q main
show "H5 merge the child into task/<root>, back on main" "$N"
fresh; echo m > "$N/m.txt"; G -C "$N" add m.txt; G -C "$N" commit -q -m "main moves"; G -C "$N" push -q origin main; baseline "$N" > "$ROOT/before.txt"
G -C "$N" checkout -q task/P; G -C "$N" merge -q --no-edit origin/main; G -C "$N" checkout -q main
show "H6 merge origin/main into task/<id>, back on main" "$N"
fresh; G -C "$N" merge -q --no-edit task/P
show "H7 variant b: merge task/<id> into the protected branch by hand (HEAD on main)" "$N"

echo "## H9 local protected branch ahead of origin"
fresh; echo x > "$N/x.txt"; G -C "$N" add x.txt; G -C "$N" commit -q -m "out of band on main"; baseline "$N" > "$ROOT/before.txt"
G -C "$N" reset -q --hard origin/main; show "H9a git reset --hard origin/main" "$N"
fresh; echo x > "$N/x.txt"; G -C "$N" add x.txt; G -C "$N" commit -q -m "out of band on main"; baseline "$N" > "$ROOT/before.txt"
G -C "$N" push -q origin main; show "H9b git push origin main" "$N"

echo "## H10 protected branch missing"
fresh; G -C "$N" checkout -q --detach; G -C "$N" branch -D main >/dev/null; baseline "$N" > "$ROOT/before.txt"
G -C "$N" branch main origin/main; show "H10 git branch main origin/main (HEAD detached before)" "$N"

echo "## H11 dirty resting tree"
fresh; echo dirty >> "$N/f.txt"; show "H11 dirty file only" "$N"
G -C "$N" stash -q; show "H11a git stash" "$N"
fresh; echo dirty >> "$N/f.txt"; G -C "$N" commit -q -am "commit the stray change"; show "H11b git commit -am on main" "$N"
fresh; echo dirty >> "$N/f.txt"; echo u > "$N/u.txt"; G -C "$N" checkout -q -- .; G -C "$N" clean -qfd; show "H11c git checkout -- . ; git clean -fd" "$N"

echo "## H12 origin / repo mismatch"
fresh; G -C "$N" remote remove origin; show "H12a git remote remove origin" "$N"
baseline "$N" > "$ROOT/before.txt"; G -C "$N" remote add origin "$ROOT/origin.git"; show "H12b git remote add origin (no fetch)" "$N"
G -C "$N" fetch -q origin; show "H12c then git fetch origin" "$N"
fresh; G -C "$N" remote set-url origin "$ROOT/elsewhere.git"; show "H12d git remote set-url origin <other>" "$N"

echo "## H13 path replaced by another checkout (fresh clone of origin)"
fresh; G clone -q "$ROOT/origin.git" "$ROOT/clone"; baseline "$ROOT/clone" > "$ROOT/after.txt"
echo "### H13 baseline of the old place vs a fresh clone"; diff "$ROOT/before.txt" "$ROOT/after.txt" | grep '^[<>]' | sed -e 's/^</was:/' -e 's/^>/now:/'; echo; rm -rf "$ROOT/clone"

echo "## H14 origin/HEAD symref"
fresh; G -C "$N" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/task/P; show "H14a origin/HEAD repointed" "$N"
fresh; G -C "$N" remote set-head origin -d; show "H14b git remote set-head origin -d" "$N"
baseline "$N" > "$ROOT/before.txt"; G -C "$N" fetch -q origin; show "H14c git fetch origin after the symref was deleted" "$N"

echo "## H15 interview room recreated with git init"
fresh; rm -rf "$ROOT/room"; mkdir "$ROOT/room"; git -C "$ROOT/room" init -q
echo "### H15 baseline text of a room made by bare 'git init' (no init.defaultBranch configured)"; baseline "$ROOT/room" 2>&1; echo
rm -rf "$ROOT/room"

echo "## H16 / H17 put a tip into task/<id> by hand"
fresh; G clone -q "$N" "$ROOT/kept"; G -C "$ROOT/kept" checkout -q task/P; echo k > "$ROOT/kept/k.txt"; G -C "$ROOT/kept" add k.txt; G -C "$ROOT/kept" commit -q -m "work left in the kept checkout"
G -C "$N" fetch -q "$ROOT/kept" task/P:refs/heads/task/P; show "H16/H17 git fetch <kept checkout> task/P:refs/heads/task/P" "$N"
fresh; G -C "$N" fetch -q "$ROOT/kept" task/P; show "H16/H17 git fetch <kept checkout> task/P (no destination ref; FETCH_HEAD only)" "$N"
rm -rf "$ROOT/kept"

echo "## H18 / H19 / H21 a human commit on the protected branch of a named place"
fresh; echo x > "$N/.claude"; G -C "$N" add .claude; G -C "$N" commit -q -m ".claude as a file"; baseline "$N" > "$ROOT/before.txt"
G -C "$N" rm -q .claude; mkdir "$N/.claude"; echo '{}' > "$N/.claude/settings.json"; G -C "$N" add .claude; G -C "$N" commit -q -m ".claude as a directory"
show "H18/H19/H21 commit on main in the named place" "$N"

echo "## things outside refs/ and HEAD"
fresh
G -C "$N" config user.name someone; echo '*.log' >> "$N/.git/info/exclude"; printf '#!/bin/sh\n' > "$N/.git/hooks/pre-commit"
G -C "$N" sparse-checkout init >/dev/null 2>&1
show "X1 .git/config, info/exclude, hooks, sparse-checkout init" "$N"
fresh; G -C "$N" worktree add -q --detach "$ROOT/wt" task/P; echo w > "$ROOT/wt/w.txt"; G -C "$ROOT/wt" add w.txt; G -C "$ROOT/wt" commit -q -m "commit on a detached linked worktree"
show "X2 linked worktree with a detached HEAD, one commit there" "$N"
G -C "$N" worktree remove --force "$ROOT/wt"
fresh; G -C "$N" worktree add -q "$ROOT/wt2" -b scratch main; show "X3 git worktree add -b scratch" "$N"; G -C "$N" worktree remove --force "$ROOT/wt2"
fresh; G -C "$N" tag v1; G -C "$N" notes add -m n main; G -C "$N" update-ref refs/custom/x main
show "X4 tag, notes, refs/custom" "$N"
fresh; G -C "$N" checkout -q --detach main; show "X5 git checkout --detach main (same commit)" "$N"
fresh; G -C "$N" gc -q --prune=now; G -C "$N" pack-refs --all; show "X6 gc + pack-refs --all" "$N"
fresh; G -C "$N" branch -m task/C task/C2; show "X7 branch rename" "$N"
```

### run2.sh

```bash
#!/bin/bash
# Second pass for #3179: purely-local template and variants missing from run.sh. Reuses the template run.sh built in $1/tpl.
set -u
ROOT="$1"
cd "$ROOT" || exit 1
export HOME="$ROOT/home"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=h GIT_AUTHOR_EMAIL=h@example.invalid GIT_COMMITTER_NAME=h GIT_COMMITTER_EMAIL=h@example.invalid
export GIT_AUTHOR_DATE="2026-11-12T00:00:00Z" GIT_COMMITTER_DATE="2026-11-12T00:00:00Z"
G() { git -c init.defaultBranch=main -c advice.detachedHead=false "$@"; }
baseline() {
  local head
  if head=$(G -C "$1" symbolic-ref -q HEAD); then head="symref=$head"; else head=$(G -C "$1" rev-parse HEAD); fi
  echo "$head HEAD"
  G -C "$1" for-each-ref '--format=%(if)%(symref)%(then)symref=%(symref)%(else)%(objectname)%(end) %(refname)'
}
show() {
  baseline "$2" > "$ROOT/after.txt"
  echo "### $1"
  if diff "$ROOT/before.txt" "$ROOT/after.txt" > "$ROOT/d.txt"; then echo "(baseline text identical)"; else grep '^[<>]' "$ROOT/d.txt" | sed -e 's/^</was:/' -e 's/^>/now:/'; fi
  echo
}
fresh() {
  rm -rf "$ROOT/named" "$ROOT/origin.git"
  cp -R "$ROOT/tpl/named" "$ROOT/named"; cp -R "$ROOT/tpl/origin.git" "$ROOT/origin.git"
  baseline "$ROOT/named" > "$ROOT/before.txt"
}
N="$ROOT/named"
freshlocal() { fresh; G -C "$N" remote remove origin; baseline "$N" > "$ROOT/before.txt"; }

echo "## purely-local template baseline (no origin)"; freshlocal; cat "$ROOT/before.txt"; echo

echo "## L-H1 purely-local: merge back conflict by hand, HEAD left on the target"
freshlocal; G -C "$N" checkout -q task/P; G -C "$N" merge -q task/C >/dev/null 2>&1; echo resolved > "$N/f.txt"; G -C "$N" add f.txt; G -C "$N" commit -q -m "by hand"
show "L-H1" "$N"
echo "## L-H7a purely-local: merge the protected branch into task/<id> by hand, back on main"
freshlocal; echo m > "$N/m.txt"; G -C "$N" add m.txt; G -C "$N" commit -q -m "main moved by the board"; baseline "$N" > "$ROOT/before.txt"
G -C "$N" checkout -q task/P; G -C "$N" merge -q --no-edit main; G -C "$N" checkout -q main; show "L-H7a" "$N"
echo "## L-H7b purely-local: merge task/<id> into the protected branch by hand"
freshlocal; G -C "$N" merge -q --no-edit task/P; show "L-H7b" "$N"
echo "## L-H10 purely-local: protected branch missing, recreated by hand"
freshlocal; G -C "$N" checkout -q --detach; G -C "$N" branch -D main >/dev/null; baseline "$N" > "$ROOT/before.txt"
G -C "$N" branch main task/P~1; show "L-H10 git branch main <sha>" "$N"
G -C "$N" checkout -q main; show "L-H10 then git checkout main" "$N"
echo "## L-H11 purely-local: stash"
freshlocal; echo dirty >> "$N/f.txt"; G -C "$N" stash -q; show "L-H11a git stash" "$N"
echo "## L-H18/19/21 purely-local: human commit on the protected branch"
freshlocal; mkdir "$N/.claude"; echo '{}' > "$N/.claude/settings.json"; G -C "$N" add .claude; G -C "$N" commit -q -m "settings"; show "L-H18/19/21" "$N"

echo "## H3b outside push diverged (dropped the repair and added its own commit); human merges and pushes from the named place"
fresh
G clone -q "$ROOT/origin.git" "$ROOT/outside"; G -C "$ROOT/outside" checkout -q -b task/P origin/task/P; G -C "$ROOT/outside" reset -q --hard HEAD~1
echo o > "$ROOT/outside/o.txt"; G -C "$ROOT/outside" add o.txt; G -C "$ROOT/outside" commit -q -m "outside commit"; G -C "$ROOT/outside" push -q -f origin task/P; rm -rf "$ROOT/outside"
G -C "$N" push origin task/P:task/P > "$ROOT/out.txt" 2>&1; echo "plain push exit=$? : $(grep -E 'rejected|->' "$ROOT/out.txt" | head -1)"
show "H3b after the rejected push" "$N"
G -C "$N" fetch -q origin; show "H3b after git fetch origin" "$N"
G -C "$N" checkout -q task/P; G -C "$N" merge -q --no-edit origin/task/P; G -C "$N" push -q origin task/P; show "H3b after checkout task/P + merge origin/task/P + push (HEAD left on task/P)" "$N"

echo "## H4c discard recipe read as 'check out task/<id> first'"
fresh
P1=$(G -C "$N" rev-parse task/P~1); G -C "$N" push -q -f origin "$P1:refs/heads/task/P"; G -C "$N" update-ref refs/remotes/origin/task/P "$(G -C "$N" rev-parse task/P)"
baseline "$N" > "$ROOT/before.txt"
G -C "$N" checkout -q task/P; G -C "$N" fetch -q origin; G -C "$N" reset -q --hard origin/task/P; G -C "$N" merge -q -s ours --no-edit task/C
G -C "$N" push origin task/P > "$ROOT/out.txt" 2>&1; echo "git push origin task/P exit=$? : $(grep -E 'rejected|->' "$ROOT/out.txt" | head -1)"
show "H4c after checkout task/P + fetch + reset --hard + merge -s ours + push" "$N"

echo "## point-in-time: a ref moved and moved back between two comparisons"
fresh; OLD=$(G -C "$N" rev-parse task/P); G -C "$N" update-ref refs/heads/task/P task/C; G -C "$N" update-ref refs/heads/task/P "$OLD"; show "T1 moved and restored" "$N"
echo "reflog entries of HEAD after T1: $(G -C "$N" reflog show HEAD | wc -l | tr -d ' ')"
```

### run.sh の出力

```text
git version: git version 2.47.0

## template baseline (remote-backed named place)
symref=refs/heads/main HEAD
e261881 refs/heads/main
2fdd862 refs/heads/task/C
591dcf6 refs/heads/task/P
symref=refs/remotes/origin/main refs/remotes/origin/HEAD
e261881 refs/remotes/origin/main
591dcf6 refs/remotes/origin/task/P

## H1 merge back conflict resolved by hand
merge exit=1 (conflict expected)
### H1 after merge+commit (HEAD left on task/P)
was: symref=refs/heads/main HEAD
now: symref=refs/heads/task/P HEAD
was: 591dcf6 refs/heads/task/P
now: ecc3014 refs/heads/task/P

### H1 after the human also switches back to main
was: 591dcf6 refs/heads/task/P
now: ecc3014 refs/heads/task/P

non-ref leftovers: FETCH_HEAD ORIG_HEAD 

## H2 discard with merge -s ours
### H2 after checkout task/P + merge -s ours task/C
was: symref=refs/heads/main HEAD
now: symref=refs/heads/task/P HEAD
was: 591dcf6 refs/heads/task/P
now: 81cbad9 refs/heads/task/P

## H3 outside push dropped content; push it back
plain push exit=0 :    61a9a2a..591dcf6  task/P -> task/P
### H3 after 'git push origin task/P' from the named place
(baseline text identical)

## H4 literal discard recipe: git fetch origin; git reset --hard origin/task/P; git merge -s ours task/C; git push
### H4 step1 after git fetch origin
was: 591dcf6 refs/remotes/origin/task/P
now: 61a9a2a refs/remotes/origin/task/P

### H4 step2 after git reset --hard origin/task/P (HEAD is on main)
was: e261881 refs/heads/main
now: 61a9a2a refs/heads/main
was: 591dcf6 refs/remotes/origin/task/P
now: 61a9a2a refs/remotes/origin/task/P

### H4 step3 after git merge -s ours task/C
was: e261881 refs/heads/main
now: 20003c4 refs/heads/main
was: 591dcf6 refs/remotes/origin/task/P
now: 61a9a2a refs/remotes/origin/task/P

git push exit=128 :
    fatal: The current branch main has no upstream branch.
    To push the current branch and set the remote as upstream, use
    
        git push --set-upstream origin main
    
    To have this happen automatically for branches without a tracking
    upstream, see 'push.autoSetupRemote' in 'git help config'.
    
git push (push.default=current) exit=0 :
    To <W>/origin.git
       e261881..20003c4  main -> main
### H4 step4 after push
was: e261881 refs/heads/main
now: 20003c4 refs/heads/main
was: e261881 refs/remotes/origin/main
was: 591dcf6 refs/remotes/origin/task/P
now: 20003c4 refs/remotes/origin/main
now: 61a9a2a refs/remotes/origin/task/P

origin now: 20003c4 refs/heads/main;61a9a2a refs/heads/task/P;

## H4b same recipe where main tracks origin/main (as in a cloned checkout): plain git push
git push exit=0 :
    To <W>/origin.git
       e261881..20003c4  main -> main
### H4b after fetch + reset --hard + merge -s ours + push
was: e261881 refs/heads/main
now: 20003c4 refs/heads/main
was: e261881 refs/remotes/origin/main
was: 591dcf6 refs/remotes/origin/task/P
now: 20003c4 refs/remotes/origin/main
now: 61a9a2a refs/remotes/origin/task/P

local task/P: 591dcf6  origin: 20003c4 refs/heads/main;61a9a2a refs/heads/task/P;
status: ## main...origin/main

## H5 / H6 / H7 merges by hand on a task branch or the protected branch
### H5 merge the child into task/<root>, back on main
was: 591dcf6 refs/heads/task/P
now: 81cbad9 refs/heads/task/P

### H6 merge origin/main into task/<id>, back on main
was: 591dcf6 refs/heads/task/P
now: d451788 refs/heads/task/P

### H7 variant b: merge task/<id> into the protected branch by hand (HEAD on main)
was: e261881 refs/heads/main
now: 591dcf6 refs/heads/main

## H9 local protected branch ahead of origin
### H9a git reset --hard origin/main
was: 30e38e1 refs/heads/main
now: e261881 refs/heads/main

### H9b git push origin main
was: e261881 refs/remotes/origin/main
now: 30e38e1 refs/remotes/origin/main

## H10 protected branch missing
branch 'main' set up to track 'origin/main'.
### H10 git branch main origin/main (HEAD detached before)
now: e261881 refs/heads/main

## H11 dirty resting tree
### H11 dirty file only
(baseline text identical)

### H11a git stash
now: f1858ad refs/stash

### H11b git commit -am on main
was: e261881 refs/heads/main
now: b97d510 refs/heads/main

### H11c git checkout -- . ; git clean -fd
(baseline text identical)

## H12 origin / repo mismatch
### H12a git remote remove origin
was: symref=refs/remotes/origin/main refs/remotes/origin/HEAD
was: e261881 refs/remotes/origin/main
was: 591dcf6 refs/remotes/origin/task/P

### H12b git remote add origin (no fetch)
(baseline text identical)

### H12c then git fetch origin
now: e261881 refs/remotes/origin/main
now: 591dcf6 refs/remotes/origin/task/P

### H12d git remote set-url origin <other>
(baseline text identical)

## H13 path replaced by another checkout (fresh clone of origin)
### H13 baseline of the old place vs a fresh clone
was: 2fdd862 refs/heads/task/C
was: 591dcf6 refs/heads/task/P

## H14 origin/HEAD symref
### H14a origin/HEAD repointed
was: symref=refs/remotes/origin/main refs/remotes/origin/HEAD
now: symref=refs/remotes/origin/task/P refs/remotes/origin/HEAD

### H14b git remote set-head origin -d
was: symref=refs/remotes/origin/main refs/remotes/origin/HEAD

### H14c git fetch origin after the symref was deleted
(baseline text identical)

## H15 interview room recreated with git init
### H15 baseline text of a room made by bare 'git init' (no init.defaultBranch configured)
symref=refs/heads/master HEAD

## H16 / H17 put a tip into task/<id> by hand
### H16/H17 git fetch <kept checkout> task/P:refs/heads/task/P
was: 591dcf6 refs/heads/task/P
now: d365886 refs/heads/task/P

### H16/H17 git fetch <kept checkout> task/P (no destination ref; FETCH_HEAD only)
(baseline text identical)

## H18 / H19 / H21 a human commit on the protected branch of a named place
### H18/H19/H21 commit on main in the named place
was: b2cb50c refs/heads/main
now: 6eaa129 refs/heads/main

## things outside refs/ and HEAD
### X1 .git/config, info/exclude, hooks, sparse-checkout init
(baseline text identical)

### X2 linked worktree with a detached HEAD, one commit there
(baseline text identical)

### X3 git worktree add -b scratch
now: e261881 refs/heads/scratch

### X4 tag, notes, refs/custom
now: e261881 refs/custom/x
now: 251ff8e refs/notes/commits
now: e261881 refs/tags/v1

### X5 git checkout --detach main (same commit)
was: symref=refs/heads/main HEAD
now: e261881 HEAD

### X6 gc + pack-refs --all
(baseline text identical)

### X7 branch rename
was: 2fdd862 refs/heads/task/C
now: 2fdd862 refs/heads/task/C2

```

### run2.sh の出力

```text
## purely-local template baseline (no origin)
symref=refs/heads/main HEAD
e261881 refs/heads/main
2fdd862 refs/heads/task/C
591dcf6 refs/heads/task/P

## L-H1 purely-local: merge back conflict by hand, HEAD left on the target
### L-H1
was: symref=refs/heads/main HEAD
now: symref=refs/heads/task/P HEAD
was: 591dcf6 refs/heads/task/P
now: ea4464a refs/heads/task/P

## L-H7a purely-local: merge the protected branch into task/<id> by hand, back on main
### L-H7a
was: 591dcf6 refs/heads/task/P
now: 53abdae refs/heads/task/P

## L-H7b purely-local: merge task/<id> into the protected branch by hand
### L-H7b
was: e261881 refs/heads/main
now: 591dcf6 refs/heads/main

## L-H10 purely-local: protected branch missing, recreated by hand
### L-H10 git branch main <sha>
now: 61a9a2a refs/heads/main

### L-H10 then git checkout main
was: e261881 HEAD
now: symref=refs/heads/main HEAD
now: 61a9a2a refs/heads/main

## L-H11 purely-local: stash
### L-H11a git stash
now: f1858ad refs/stash

## L-H18/19/21 purely-local: human commit on the protected branch
### L-H18/19/21
was: e261881 refs/heads/main
now: 948c7f6 refs/heads/main

## H3b outside push diverged (dropped the repair and added its own commit); human merges and pushes from the named place
plain push exit=1 :  ! [rejected]        task/P -> task/P (fetch first)
### H3b after the rejected push
(baseline text identical)

### H3b after git fetch origin
was: 591dcf6 refs/remotes/origin/task/P
now: cf13e40 refs/remotes/origin/task/P

### H3b after checkout task/P + merge origin/task/P + push (HEAD left on task/P)
was: symref=refs/heads/main HEAD
now: symref=refs/heads/task/P HEAD
was: 591dcf6 refs/heads/task/P
now: 4d2d3b9 refs/heads/task/P
was: 591dcf6 refs/remotes/origin/task/P
now: 4d2d3b9 refs/remotes/origin/task/P

## H4c discard recipe read as 'check out task/<id> first'
git push origin task/P exit=0 :    61a9a2a..5077a96  task/P -> task/P
### H4c after checkout task/P + fetch + reset --hard + merge -s ours + push
was: symref=refs/heads/main HEAD
now: symref=refs/heads/task/P HEAD
was: 591dcf6 refs/heads/task/P
now: 5077a96 refs/heads/task/P
was: 591dcf6 refs/remotes/origin/task/P
now: 5077a96 refs/remotes/origin/task/P

## point-in-time: a ref moved and moved back between two comparisons
### T1 moved and restored
(baseline text identical)

reflog entries of HEAD after T1: 7
```
