# merge back の conflict は、完了の門で worker に帰り先へ追いつかせれば無くせるか(#3188)

- 問い: [#3188](https://github.com/sinano1107/tidepool/issues/3188)。地図は #3178、止めてある ticket は #3182、完了の門の読みは #3180。
- 行番号は main `25c845515dd750edbbad43d15580323b41676a5d`(`25c84551`)のもの。
- 各主張に **読み**(その code path / ADR / test を読んだ)か **推論**(読んだ事実からの導出で、その経路自体は読んでも走らせてもいない)を付ける。
- 設計の推奨は書かない。想定の形が成り立つ場所と成り立たない場所を並べる。

想定の形(#3188 本文): 完了の門が「tip が帰り先の今の値を祖先に持たない、または clean に merge できない」完了を拒み、worker が自分の task の checkout で merge して呼び直す。

**この文書は「tip が帰り先の今の値を祖先に持つこと」を門が要求する読みで分析する。** 「祖先に持たなくても clean に merge できれば通す」読みでは、後始末の merge back は ff でなく盤面の merge commit になり、5 の「ff の枝に入る」は当てはまらない(その場合の検査の delta は fixture F6)。

## 走らせたもの

- `gh issue view`、`grep`、ファイルの読み。
- **合成 fixture 1本**(素の git 2.47.0、この Mac、scratchpad の使い捨て repo 5つ。盤面の関数・test suite・Lima VM・Pi はどれも走らせていない。盤面の host(VM / Pi)の git の版は見ていない —— sparse の下の merge の挙動(F3・F8)は版に依りうる)。`openTaskCheckout` と同じ手順(`git init --template=` → `objects/info/alternates` に名前の場所役の objects → 自分の branch だけ fetch → `read-tree -u --reset`、`sparse-checkout set --no-cone` で `.claude/settings.json` を外す)で checkout 役を作り、名前の場所役で親の branch を進めてから、下の F0〜F9 を測った。走らせた script は末尾の付録にそのまま置く。sandbox の中ではない。

| # | 測ったもの | 結果 |
|---|---|---|
| F0 | `sparse-checkout set --no-cone` の後の checkout 役の `.claude/` | file 0 個 |
| F1 | checkout を作った**後**に名前の場所役で作った commit(loose、`gc` 後は pack)を、checkout 役から `cat-file -t <sha>` | 両方 `commit`。checkout 役の ref は自分の `task/C1` 1本だけ |
| F3 | checkout 役で `git merge <帰り先の sha>`(帰り先は sparse で外した `.claude/settings.json` も変えている) | 成功。`.claude/` は実体化されず、`ls-files -t` は `S`(skip-worktree)のまま、tip の blob は帰り先の値、`status` は空 |
| F2 | merge した tip で `rev-list --objects <tip> --not --alternate-refs` | 5 object(件数だけ出した。内訳は見ていない)。同じ tip の全閉包より少なく、帰り先の ref から届く分は入らない —— 後半は `--alternate-refs` の意味からの**推論** |
| F2 | `diff-tree -r --raw --merge-base <帰り先> <tip>` | `M a.txt` だけ。帰り先が変えた `.claude/settings.json` と `shared.txt` は出ない |
| F4 | `merge-base --is-ancestor <帰り先> <tip>` | yes |
| F5 | 門の後に帰り先をもう1 commit 進める(`a.txt` と `.claude/settings.json`) | `is-ancestor` は no、`merge-tree --write-tree` は conflict。`--merge-base` の delta は `M a.txt` のまま |
| F6 | 追いつかない tip(今日の形)を、進んだ帰り先と `--merge-base` で比べる | `A c2.txt` だけ |
| F7 | worker が merge して、人間しか書けない path だけ自分側(旧い値)に戻して commit | delta に `M .claude/settings.json` が出る |
| F8 | sparse で外した path を帰り先が変え、別の file で conflict する merge | exit 1、unmerged は `a.txt` だけ、`.claude/` は実体化されない |
| F9 | 門の後に進んだ帰り先の commit を、fetch せずに最初の checkout 役から `cat-file -t` | `commit` |

## 前提として読んだ機構(6項目が共有する)

- **帰り先の決め方。** `lineageTaskBranch` は系譜を根から親へ下り、未決着の work 祖先のブランチ、または決着済みで `branchMergeEffect` が「候補を変える」と答える祖先のブランチを候補にする。無ければ undefined(底は保護ブランチ)(`src/workspace.ts:870–918`)。**読み**
- **門が読む fork 元と merge back の帰り先は同じ関数から出る。** `taskForkSource` は受験者以外で `lineageTaskBranch(...) ?? exactProtectedBranchRef` を `rev-parse` する(`src/workspace.ts:975–979`)。merge back は `mergeBack && lineageTaskBranch(...)` で、undefined なら走らない(`:1679–1680`)。**根の work(帰り先が無い)に merge back は無い。** **読み**
- **merge back の本体。** `mergeBackInto` は帰り先の ref を `rev-parse` し、source が帰り先の祖先なら何もしない、帰り先が source の祖先なら ff、どちらでもなければ `merge-tree --write-tree` + `commit-tree` で merge commit を作り、undefined(conflict)なら「merge it there by hand … or … `git merge -s ours`」を投げる(`src/workspace.ts:1855–1879`、`:782–812`)。**読み**
- **門から merge back までの時間。** 門と verb は1つの MCP call の同期区間(`src/mcp.ts:464–481`)。後始末は `containers.reclaimed(...)` の Promise の後(`:482–483`)で、`teardown` は merge back の前に `ensureWorkspaceToken` を await する(`src/teardown.ts:401–407`)。その後の `releaseWorkspace` → `settleTaskCheckout`(基準の全体比較 `:1800` → `settleBranches` `:1811`)→ `mergeBackInto` は同期(`src/workspace.ts:1647–1682`、`:1728–1818`)。ただし `settleBranches` は帰り先を引く前に remote-backed なら `fetchBranchCopy` を撃つ(`:1677`、同期の git)。**読み**

## 1. worker は帰り先の今の値の objects を読めるか

**work(と review)は読める。受験者と Interview の root は読めないが、どちらにも帰り先が無い。**

- work / review の task の checkout は `objects/info/alternates` に名前の場所の objects の実体の path を書く(`src/workspace.ts:446`、`:453–456`)。fetch するのは自分の `refs/heads/task/<id>` 1本だけ(`:461`)。**読み**
- sandbox の読み取り範囲に、その objects の path が入る: `runPlaceReadPaths` は `borrowsNamedObjects` のとき `namedObjects(namedPlace)` を足し(`src/workspace.ts:420–423`、`borrowsNamedObjects` は面接室でないとき true `:394`)、Claude は `allowRead` に(`src/sandbox.ts:446–453`、渡すのは `src/claude-worker.ts:1983`)、Codex は `read` に(`src/codex-worker.ts:762`、渡すのは `:1555`)入れる。**読み**(sandbox の中で実際に読めるかは測っていない)
- alternates は directory を借りるので、checkout を作った後に名前の場所へ入った object(兄弟の merge back が `commit-tree` で作る merge commit、門が fetch した兄弟の tip)も見える。**fixture F1 で測った**(loose と pack の両方)。
- **worker の checkout に帰り先の ref は無く、名前の場所の `refs/` は読み取り範囲に無い**(開くのは objects の path だけ、`src/workspace.ts:415–423`)。fork 元や帰り先の値を worker に渡す箇所は、`src/mcp.ts`・`src/worker.ts`・`src/claude-worker.ts`・`src/codex-worker.ts`・`src/scheduler.ts`・`src/board-prose.ts` の grep(`taskForkSource` / `lineageTaskBranch` / `fork` を含む欄名)では門の1箇所(`src/mcp.ts:375`)だけだった。読んだ範囲では worker が帰り先の sha を知る手段が無く、門の拒否文が sha を運ばなければ worker は merge する相手を名指せない。**読み + 推論**(spawn の envelope と `get_current_task` の返す欄の本文は読んでいない)
- worker の checkout は書ける(Claude `allowWrite: [workspacePath, taskTemp]` `src/sandbox.ts:454`、Codex は `.git` を `write` `src/codex-worker.ts:756–760`)ので、merge commit を作ること自体は床に当たらない。**読み**(committer の身元と hooks の扱いは読んでいない)
- merge した tip を門が写す段は、名前の場所の ref から届く閉包を pack に入れない(`rev-list --objects <sha> --not --alternate-refs`、`src/workspace.ts:662`)。帰り先の今の値は名前の場所の ref の値なので、写す量は worker の分だけになる。**読み、fixture F2 で同じ git の手を測った**
- **受験者・Interview の root**: alternates を使わない複製で(`src/workspace.ts:444–446`)、sandbox も名前の場所の objects を開かない(`:421`)。受験者は `parent_id` を持たずに登録され(`src/tasks.ts:2773–2783`)、系譜の下りは祖先が空なので帰り先は undefined(`src/workspace.ts:887–907`)。Interview の root は type が `interview` で、門も merge back も掛からない(`:1426–1428`、`src/teardown.ts:396`)。**読み**

## 2. 門を通ってから merge back までに、帰り先の ref を動かす道

**slot が保証するもの(読み):** 枠を握るのは session で、後始末が終わるまで空かない(`src/slot.ts:11–15`、`src/teardown.ts:430`)。`task/<id>` を書く worker 起点の手 —— pickup の `createTaskBranch`(`src/workspace.ts:982–987`)、門の `recordTaskCheckoutTip`(`:732–745`)、WIP の退避(`:1794–1797`)、後始末の `mergeBackInto`(`:1680`)—— はどれも枠の主の session のものなので、**別の task の完了・退避・merge back が門と merge back の間に帰り先を動かすことは無い**。

**slot が保証しないもの:**

| 書き手 | 門〜merge back の間に帰り先を動かせるか | 場所 |
|---|---|---|
| Quarantine の受理(`redoMergeBacks`) | 動かせない。受理は、その名前を開いた session か後始末が走っていれば拒み(`src/human-verbs.ts:659–662`)、`redoMergeBacks` 自身も `in_progress` か後始末の印のある task があれば投げる(`src/workspace.ts:1915–1922`)。後始末の印は `done` と同じ transaction で付く(`src/mcp.ts:471–480`) | **読み** |
| 収束の追いつき(`catchUpTaskBranch`) | **構造上は塞がれていない。** 書くのは根の `task/<root>`(`src/workspace.ts:1974–1988`)で、done の根に付いた修理の帰り先になりうる。`landRoot` は冒頭で後始末が未了の木を外し(`src/landing.ts:1046`)、付帯子が未決着なら待つ(`:186–191`)が、`catchUp()` はその後の await(`getPullRequestState` / `findPullRequestByHead`)を挟んで撃たれ(`:1169–1171`、`:1213`、`:1237`)、直前に読み直さない。push の門が読み直すのは `landingBlock` と quarantine だけ(`:1175–1183`)。当たるには、付帯子の登録から完了の門までが `landRoot` の await 1つの間に収まる必要がある | 道具立ては**読み**、起こりうるかは**推論** |
| local 着地の回答(`mergeTaskToProtected`) | 書くのは保護ブランチで、帰り先(祖先のタスクブランチ)ではない(`src/workspace.ts:2011–2030`)。ただし保護ブランチは系譜の下りの比較相手なので、**帰り先がどのブランチかを変えうる**。門は付帯子が未決着なら拒み(`src/human-verbs.ts:870–878`)、done になった後は積み残しの比較が拒む(`:1208–1219`) | **読み** |
| 後始末自身の fetch | remote-backed では帰り先を引く直前に保護ブランチの写しを進める(`src/workspace.ts:1677–1679`)。門は fetch しない(`src/mcp.ts:375`)。**決着済みの祖先**(done の根に付いた修理)では、session の間に根の PR が GitHub で merge されていると、門の時点の帰り先(`task/<root>`)と後始末の時点の帰り先(undefined か別の祖先)が食い違いうる。未決着の祖先は比較に依らず候補になる(`:899–902`)ので食い違わない | **読み**(食い違いの帰結は**推論**) |
| 起動時の復旧 | 行に残った後始末の印から同じ `teardown` を撃ち直す(`src/teardown.ts:278–285`、`src/server.ts:567`)。merge back はそこで初めて走る。復旧自身が帰り先を書く手は読んだ範囲に無い。起動の収束はその後(ADR 0240 決定3) | **読み**(起動の他の段は未読) |
| 人間の帯域外の書き込み | 動かせる。後始末は merge back の前に全 ref を基準と比べ(`src/workspace.ts:1800`)、動いていれば名前の場所を quarantine して **merge back を撃たずに** `false` を返す(`:1812–1816`)。比較と `rev-parse`(`:1865`)は同じ同期区間だが、OS の別 process の書き込みとは排他でない。そのときは `advanceBranch` の `update-ref <ref> <new> <old>` の旧値が外れて投げる(`:944–950`) | **読み** |
| 門そのものの読み | 門は自分の `task/<id>` 1本の行しか基準と比べない(`src/workspace.ts:737–742`、ADR 0359 決定4)。今の門が fork 元として帰り先を読む手(`src/mcp.ts:375`)も基準と比べていない。想定の形の「帰り先の今の値」は、人間が帯域外に動かした値でもそのまま読まれる | **読み** |

**同じ session の中で帰り先が正当に動くことは無い**(上の追いつきの窓を除く)。今日 conflict が起きる筋は、子の**ブランチを切った後・最後の pickup より前**に帰り先が進む形 —— `createTaskBranch` は既にあるブランチに何もしない(`src/workspace.ts:983`)ので、再開した子の分岐点は古いまま残る。test がこの順(子が escalate → 兄弟が完了して親を進める → 子が再開して完了)で conflict を作っている(`tests/task-branch-lineage.test.ts:489–548`)。**読み**

**merge back が同じ後始末で撃たれるとは限らない。** `settleTaskCheckout` が quarantine を登録して `false` を返すと `releaseTaskCheckout` は戻り(`src/workspace.ts:1700`)、`teardown` はそのまま印を消して枠を空ける(`src/teardown.ts:426–430`)。届かなかった merge back は Quarantine の受理の `redoMergeBacks` が撃つ。その間、人間は名前の場所を手で直している。**読み**

## 3. merge back が走るのに完了の門が掛からない経路

門の述語と後始末の merge back の述語は同じ `task.type === "work"` と「完了」(`src/workspace.ts:1426–1428`、`src/teardown.ts:396`、`:77–80`、`:99`)。**後始末の中で、門が掛からない type の merge back が走ることは無い。** **読み**

| 経路 | merge back | conflict |
|---|---|---|
| review・記憶の修理子など work 以外の type の完了 | 走らない(`mergeBack` が false) | 起きない |
| `todo` に戻る解放(escalate・decompose・中断)の WIP | 走らない。WIP は自分の `task/<id>` に着くだけ(`src/workspace.ts:1762–1768`、`:1794–1797`) | 起きない。WIP は次の session の tip の祖先になり、その完了の門が見る |
| cancel | 走らない(決着は `released`、`src/teardown.ts:80`)。`undeliveredMergeBacks` も `done` だけを数える(`src/workspace.ts:1892`) | 起きない |
| worker の他の verb が work を `done` にする | 門なしの `done` は transaction ごと巻き戻る(`src/mcp.ts:475–477`) | — |
| resolver の無い盤面 | 門は検査せずに通す(`src/mcp.ts:350`)が、後始末も走る場所を解けず解放を飛ばす(`src/workspace.ts:391`、`src/teardown.ts:395`、`:413`) | 起きない(merge back が無い) |
| **人間の完了の扉** | `completeThroughHumanDoor` は門も後始末も通さず `completeTask` を呼ぶ(`src/human-verbs.ts:948–973`)。後始末の merge back は走らない。しかし `undeliveredMergeBacks`(`src/workspace.ts:1889–1900`)と積み残しの `leftBehindTargets`(`src/landing.ts:245–255`)は担当を見ず、「done の work で、タスクブランチがあり、内容が届いていない」を数える。ブランチは pickup でしか作られないので、当たるのは**agent の session が WIP か commit を残した後で人間の担当に替わり、人間が完了した** task | **起きうる**(受理の `redoMergeBacks`、または積み残しの H5)。その担当替えが扉で通るかは読んでいない —— **推論** |
| **Quarantine の受理の `redoMergeBacks`** | 門の外で `mergeBackInto` を撃つ(`src/workspace.ts:1928–1932`)。相手の task は done で session が無い | **起きうる**。5 を参照 |
| 旧版の盤面で完了した task | `completion_gate: "recorded_tip"` の印が無い checkout の解放は別の検査を通る(`src/workspace.ts:1752–1760`)。想定の形の門を通っていない tip が merge back へ進みうる | 起きうる(移行の残り) |

## 4. merge した tip に、門の既存の検査はどう当たるか

**帰り先を merge しただけの tip は、人間しか書けない path / gitlink の検査に拒まれない。**

- 検査の delta は `diff-tree -r --raw --merge-base <fork 元> <tip>`(`src/git.ts:206–214`、`src/sandbox.ts:635–637`)。fork 元は門の時点で引き直した帰り先の値(`src/mcp.ts:375`、`src/workspace.ts:975–979`)。tip が帰り先を祖先に持てば merge-base は帰り先そのものになり、delta は「帰り先 → tip」= worker 自身の変更と conflict の解き方だけになる。帰り先の側が持ち込んだ人間しか書けない path の変更(追いつきが保護ブランチから根のブランチへ運ぶもの)は出ない。**読み、fixture F2 で測った**
- 門の後に帰り先がさらに進んでも、merge-base は worker が merge した値に留まり、delta は変わらない(fixture F5)。追いつかない今日の tip でも delta は worker の分だけ(F6)—— 検査は今日も帰り先の進みに巻き込まれていない。
- **拒まれる形**: worker が merge の解決で、人間しか書けない path を帰り先の値と違う entry にしたとき(自分側の旧い値に戻すなど)。delta にその path が出る(fixture F7)。拒否文は「take the change out of the task branch」で(`src/mcp.ts:378–382`)、この場合の直し方(帰り先の値に揃える)とは向きが違う。**読み + 測定**
- gitlink も同じ delta を読む(`src/mcp.ts:385`)ので同じ結論。**読み**
- **隠せない形**(`.claude` が tree でない)は delta でなく tip の tree そのものを読む(`src/mcp.ts:364`、`src/sandbox.ts:605–620`)。帰り先がその形を持っていれば merge した tip も持ち、拒まれる —— ただし帰り先がその形になるには人間の書き込みが要る。**推論**
- **未 commit の検査**は記録した tip に対して checkout の worktree を読む(`src/mcp.ts:393`、`src/workspace.ts:1399–1408`)。Claude の session では settings の path が sparse で外れている(`src/workspace.ts:1034–1036`)。素の git では、外した path を帰り先が変えていても merge はそれを実体化せず、skip-worktree のまま tip に帰り先の blob が入る(fixture F3、conflict する merge でも同じ F8)。**測ったのは素の git で、sandbox の stub(0 byte の file、`src/workspace.ts:1383–1396`)と worker の git env(ADR 0037 機構2)の下では測っていない。**
- ADR 0362 決定2 は fork 元を「タスクブランチを切った sha と同じ出所」と書くが、出所は関数で、値は門のたびに引き直される(`src/workspace.ts:975–979`)。**読み**

## 5. この形にしたとき、merge back の conflict が残る場面

想定の形が**消す**もの: 門の時点の帰り先が、後始末の merge back の時点でも同じ値・同じブランチであるとき。`mergeBackInto` は ff の枝(`src/workspace.ts:1868–1869`)に入り、`merge-tree` を呼ばない。今日 test が作っている conflict(子の再開より前に兄弟が親を進めた、`tests/task-branch-lineage.test.ts:489–548`)はこれに当たる。**読み**

**残る場面:**

1. **後始末が merge back の手前で止まり、受理の `redoMergeBacks` が撃つとき。** 基準の比較の違反(`src/workspace.ts:1800`)、token / fetch の失敗(`:1675–1677`)、記録の tree の読みの失敗(`:1806–1808`)はどれも quarantine して merge back を飛ばす(`:1812–1816`)。受理の時点の帰り先は、人間が Quarantine の間に手で動かした後の値でありうる。task は done で session が無く、追いつく worker がいない。**読み**(conflict に至るかは人間の修理の中身に依る —— **推論**)
2. **人間の完了の扉で done になった、ブランチを持つ work**(3 の表)。門を通っていないので、tip は帰り先を祖先に持たない。**推論**(担当替えの扉は未読)
3. **門の時点と後始末の時点で帰り先のブランチが食い違うとき**(2 の表の「後始末自身の fetch」、local 着地)。門は別のブランチに対して追いつきを確かめたことになる。**推論**
4. **収束の追いつきが、門と merge back の間に根の `task/<root>` を進めたとき**(2 の表)。**推論**、窓は `landRoot` の await 1つ分
5. **人間が門と merge back の間に帰り先を帯域外に動かしたとき。** 基準の比較が捕まえれば 1 に合流する。
6. **旧版の盤面で完了した task の merge back**(3 の表)。

**H5(積み残し)はどこから来るか。** H5 の question は、根を push した後に `leftBehindTargets` のどれかが push した head を変え、かつ workspace の Quarantine が開いていないときに立つ(`src/landing.ts:1102–1121`、`:245–255`、`:239–243`)。Quarantine が開いていれば収束は `quarantined` を返して H5 を立てない(`:1108`)。受理は届いていない merge back が無くなるまで拒む(`src/workspace.ts:1928–1932`、conflict なら投げる)ので、**merge back の conflict(H1)が Quarantine を経て H5 に流れる道は、読んだ範囲では受理が塞いでいる**。Quarantine を経ずに積み残しが生まれる道として読めたのは、上の 2(人間の完了の扉)だけである(走る場所の名前が解けずに解放を飛ばす後始末は、その名前を quarantine する、`src/teardown.ts:440–451`)。**H5 の発生源を全部は列挙できていない** —— `leftBehindTargets` は「根自身」も数え(`src/landing.ts:250`)、比べる相手は帰り先でなく push した head なので、merge back の述語と一致しない。**読み + 推論**

**`redoMergeBacks` は何を撃つことになるか。** 述語は変わらず「その workspace の、親を持つ done の work で、ブランチがあり、帰り先を変える内容を持つもの」を新しい行から(`src/workspace.ts:1884–1901`)。想定の形の下では、門を通って同じ後始末で ff された task はここに現れない。現れるのは上の 1・2・3・6。1 で帰り先が門の時点のままなら ff で通り、人間が帰り先を**巻き戻して**いた場合も `isAncestor(帰り先, tip)` が真なので ff になり、巻き戻した内容が tip ごと戻る(`:1867–1870`)。conflict するのは、人間が帰り先に、門の時点の値から分かれた内容を足したときである。conflict した1件で loop は止まり、同じ帰り先の残りは次の回答まで撃たれない(`:1928–1934`)。届いていない done の work が帰り先になっている間は、その下の修理の merge back はその work のブランチへ着き、受理の loop が「子孫を先に子へ、子を親へ」の順で運ぶ(`:1881–1883`、`:1927`)—— 門を通った後に子孫の内容が足された tip が、門を通らずに帰り先へ撃たれる(ADR 0370 退けた形「受理の merge back を門の tip に固定する —— 門の後に子孫から届いた内容を落とす」が同じ事実を書く)。**読み + 推論**

`undeliveredMergeBacks` と走行中の検査は行の `workspace` 列を `COALESCE(workspace, 既定)` で絞る(`src/workspace.ts:1892`、`:1917`)。work の行は自分の列で走る場所が決まり、祖先から導くのは review だけ(`src/tasks.ts:972–978`)なので、work の merge back の数え漏れにはならない。**読み**

## 6. 既存の ADR

読んだ範囲に、**完了の門で帰り先へ追いつかせる形を退けた決定は無い。前提にした決定も無い。** `docs/adr/*.md` 全体に `追いつかせ` / `worker (に|が|自身が)…(merge|rebase)` / `conflict…worker` / `worker…conflict` を grep して当たったのは 0053・0103・0105(盤面が merge で追いつかせる側)と 0109 の Status 追記だけで、worker に追いつかせる形に触れる行は無かった(grep の語に依る —— 別の言い回しの決定は拾えていない)。当たる決定:

| ADR | 関係 |
|---|---|
| **0053 決定2**(merge back を決めた ADR) | 「**ff-only では撃たない。正当な非 ff が起きる** —— C1 が escalate で中断している間に C2 が完了して親ブランチを進め、その後 C1 が再開して完了する順序では、C1 の merge back は真の merge になる」。conflict は workspace の quarantine。想定の形はこの「正当な非 ff」を門で ff に変える —— 決定の理由になっている場面が消える。帰り先は記録せず完了時に規則を走らせ直す、も同じ決定 |
| 0053 決定4 | 「worker がタスクブランチの土台を動かすことは検知しない」。worker が自分のブランチへ祖先を merge するのは合法と書く。Considered options は「worker への明示指示として作法を文書化する」を「モデルの判断は floor ではない」で退けているが、対象は fork 元の作り直しを**指示だけ**に任せる形で、門が拒む形ではない |
| 0084 決定1・4 | 門の拒否は domain error で、worker は同じ session で直して呼び直す —— 想定の形はこの型に乗る。「merge-back のコミットは変更しない」 |
| 0240 決定4 | merge back は受理の検査の中でやり直し、conflict は「手で解くか `-s ours`」。人間が解くことを前提にしている。想定の形でも 5 の 1 はこの決定が受ける場面として残る |
| 0239 帰結 | 捨てる出口は `git merge -s ours`。0240 と同じ前提 |
| 0356 決定2・6 | work は alternates で名前の場所の objects を「読み専用で借りる —— 今日と同じ可視性」。merge back は名前の場所の中で `merge-tree` + `commit-tree` + `update-ref`。worker 側で merge することは決めても退けてもいない |
| 0359 決定1・2・4 | `done` ⇔ tip が記録にある。完了済みの解放は記録の tip だけを運ぶ。**verb の時点では基準を比較しない**(人間の ref の移動は解放の比較が quarantine にする)—— 想定の形が門で帰り先の ref を読むなら、基準と比べない読みが1つ増える(今の fork 元の読みと同じ位置) |
| 0362 決定2 | delta は fork 元との merge-base から。「各段は自分の delta にだけ答え」る。退けた形「保護ブランチと比べる」は親の変更で子が拒まれるから —— merge した tip でも merge-base が帰り先になるので、この線は保たれる(4) |
| 0364 決定1 | 「tip が fork 元と無関係な commit でもよいのは今日どおり」(`docs/adr/0364-…md:33`)。門は祖先を検査しない、が今の決定。想定の形はここに祖先の検査を足す。退けた形4つ(ポインタの denylist、sandbox 内の `upload-pack`、fetch 前の検査、Lima の測定待ち)に追いつきは無い |
| 0365 決定2 | gitlink の検査も fork 元との merge-base から。退けた形「保護ブランチと比べる」は 0362 と同じ理由。追いつきは無い |
| 0105 決定2 | 根の追いつきは盤面が保護ブランチを merge し、合わなければ PR 昇格失敗 question で「人間がセッション外で手で解決」。対象は根で、merge back ではない |
| 0064 | 自分のタスクブランチ以外の ref は session の間動かない、が不変条件。2 の「同じ session の中で帰り先は正当に動かない」の根拠 |
| 0369(未実装) | 受理が、済まなかった解放の「運ぶ」段をやり直し、merge back のやり直しの手前に置く(決定1)。「merge back と休止位置は冪等で再走できる」「走らなかった ref の比較はやり直さず、受理の全撮りがその時点の ref を受け入れる」(決定7)。5 の 1 の経路をそのまま残し、門を通った tip が `task/<id>` から辿れなければ受理を拒む(決定3)を足す。退けた形5つに追いつきは無い |
| 0370 | 決定1 は着地の読みを基準の比較の後に限る(対象は着地で、完了の門ではない。「verb は比べないと決めてあり(ADR 0359 決定4)」と退けた形に書く)。「残る穴と根」は「Quarantine が開いている間に動いた ref は、見せられないまま受け入れられ、merge back で親のブランチへ運ばれる」と書く —— 5 の 1 と同じ場面。取り下げた決定5(門を通った `done` の `task/<id>` は内容を落とす移動を受理しない)と、退けた形「受理の merge back を門の tip に固定する」は、どちらも門の後の tip の扱いで、追いつきの形ではない。決定7 は積み残しの merge back を手で書いた後の retry が Quarantine を1枚経ることを書く |

## #3182 の暫定の決定と当たる点

- 「merge back(H1、H5)は … 場面ごと消える見込み」: **消えるのは同じ後始末で撃たれる merge back だけ。** 受理の撃ち直し(5 の 1)と、門を通らない done(5 の 2・6)では conflict が残り、そこには追いつく session が無い。H1 の受け皿(Quarantine の受理)と決定 11(H5 の `retry` が merge back を撃ち直す)の対象は、数は減るが空にはならない。
- 限界の「人間しか書けない path を通すと後の完了の門が worker の tip を拒む」(推論のまま、とある): 帰り先に入った変更は、帰り先を祖先に持つ tip では delta に出ない(4、F2)。追いつかない tip でも出ない(F6)。拒まれるのは worker の tip がその path を帰り先と違う entry にしたときだけ(F7)。
- 決定 2(受け取る条件は両方の tip を祖先に持つこと)と想定の形の門の条件(帰り先の今の値を祖先に持つ)は同じ述語(`merge-base --is-ancestor`)で、矛盾しない。

## 読んでいない・確かめていない

- sandbox の中で worker が実際に名前の場所の objects を読み、`git merge <sha>` を通せるか(Claude / Codex とも設定の読みだけ)。committer の身元、hooks、sparse と sandbox の stub の下での merge。
- 収束の追いつきの窓(2)が実際に開くか。`pickupIdle`、付帯子の登録の扉、pickup の門は読んでいない。
- 人間が担当の task が pickup されるか、agent の session の後で担当を人間に替えられるか(`editTask`)。
- `src/landing.ts` は `:80–112`、`:140–275`、`:350–380`、`:425–470`、`:514–519`、`:560–585`、`:1030–1330` だけ。`settleMerged`、無人 merge の tick、`outsidePushDropNotice` は未読。
- `src/teardown.ts` の `runTeardownSteps`・`drive`・`deferToSessionRest`、`src/watchdog.ts`、`src/scheduler.ts`、起動の他の段(`src/server.ts` は `:548–600` だけ)。
- cancel の本体(`cancelTaskDirectly` 以下)。祖先の cancel が門と merge back の間に入ったときの帰り先は読んでいない(GLOSSARY は「cancelled の work の祖先を挟む task の成果は捨てられて」いると書く)。
- ADR は 0053(全文)、0084(全文)、0239(決定2 以降)、0240(全文)、0356(決定と退けた形)、0359(全文)、0362(決定〜射程)、0369(決定と退けた形)、0370(決定2〜7・残る穴と根・退けた形。決定1 の本文は見出し行だけ)、0364(該当行と退けた形)、0365(決定の見出し行と退けた形)、0105(決定2 と Considered options の頭)、0241 決定7。0064 は見出しだけ、0103・0243 の本文は読んでいない。merge back に触れる ADR は 31 本あり、残りは上の grep だけ。
- spawn の envelope と `get_current_task` が worker に返す欄。
- test は `tests/task-branch-lineage.test.ts:489–548` の本文と、`tests/teardown-rerun.test.ts` の該当 test の題だけ。
- H5 の発生源の全列挙(5)。

## 付録: fixture の script

走らせたそのまま。`bash fx3188.sh <空の dir>`。

```bash
#!/bin/bash
# Synthetic fixture for #3188: plain git only, throwaway repos. Not the board.
set -u
S="$1"
rm -rf "$S"; mkdir -p "$S"; cd "$S" || exit 1
export GIT_AUTHOR_NAME=a GIT_AUTHOR_EMAIL=a@x GIT_COMMITTER_NAME=a GIT_COMMITTER_EMAIL=a@x GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
git --version
# named place
git init -q --initial-branch=main N; cd N
mkdir .claude; echo '{"v":1}' > .claude/settings.json; echo base > shared.txt; echo a > a.txt; git add -A; git commit -qm base
git branch task/P; git branch task/C1 task/P; git branch task/C2 task/P
cd ..
# borrower = task checkout of C1 (same recipe as openTaskCheckout)
mk_checkout() { # dir branch
  mkdir "$1"; git -C "$1" init -q --template= --initial-branch=main
  mkdir -p "$1/.git/objects/info"; (cd N && git rev-parse --path-format=absolute --git-path objects) > "$1/.git/objects/info/alternates"
  git -C "$1" -c core.logAllRefUpdates=false fetch -q --no-tags "$S/N" "refs/heads/$2:refs/heads/$2"
  git -C "$1" symbolic-ref HEAD "refs/heads/$2"; git -C "$1" read-tree -u --reset HEAD
}
mk_checkout B task/C1
printf '/*\n!/.claude/settings.json\n' | git -C B sparse-checkout set --no-cone --stdin
echo "F0 files in B/.claude after sparse: $(ls B/.claude 2>/dev/null | wc -l | tr -d ' ')"
# AFTER the checkout exists: target moves in N (loose objects), incl. a human-only path change
cd N; git checkout -q task/P; echo "parent version" > shared.txt; echo '{"v":2}' > .claude/settings.json; echo sib > sib.txt; git add -A; git commit -qm "sibling content on P"; T1=$(git rev-parse HEAD); git checkout -q main; cd ..
echo "F1 T1 (loose in N) visible in B via alternates: $(git -C B cat-file -t "$T1")"
echo "F1 refs in B: $(git -C B for-each-ref --format='%(refname)' | tr '\n' ' ')"
git -C N gc -q; echo "F1 after gc in N: $(git -C B cat-file -t "$T1")"
# worker work: non-conflicting file, then merge target by sha
cd B; echo mine > a.txt; git commit -qam "child work"
git merge -q --no-edit "$T1" && echo "F3 merge of T1 by sha: ok"
echo "F3 B/.claude after merge: [$(ls .claude 2>/dev/null | tr '\n' ' ')]"
echo "F3 tip settings blob: $(git cat-file -p HEAD:.claude/settings.json)"
echo "F3 status: [$(git status --porcelain | tr '\n' ' ')]"
echo "F3 ls-files -t: $(git ls-files -t .claude/settings.json)"
TIP=$(git rev-parse HEAD); cd ..
echo "F2 objects the gate would pack (rev-list --objects tip --not --alternate-refs): $(git -C B rev-list --objects "$TIP" --not --alternate-refs | wc -l | tr -d ' ')"
git -C N fetch -q --no-tags "$S/B" refs/heads/task/C1; git -C N update-ref refs/heads/task/C1 "$TIP"
echo "F2 delta merge-base(T1,tip)..tip: $(git -C N diff-tree -r --raw --merge-base "$T1" "$TIP" | awk '{print $5,$6}' | tr '\n' ';')"
echo "F4 isAncestor(T1, tip): $(git -C N merge-base --is-ancestor "$T1" "$TIP" && echo yes || echo no)"
# target moves again after the gate (T2), touching the human-only path and a.txt (conflicting with child)
cd N; git checkout -q task/P; echo '{"v":3}' > .claude/settings.json; echo theirs > a.txt; git add -A; git commit -qm "P moves after gate"; T2=$(git rev-parse HEAD); git checkout -q main; cd ..
echo "F5 after target moved to T2: isAncestor(T2,tip)=$(git -C N merge-base --is-ancestor "$T2" "$TIP" && echo yes || echo no); merge-tree: $(git -C N merge-tree --write-tree "$T2" "$TIP" >/dev/null 2>&1 && echo clean || echo conflict)"
echo "F5 delta merge-base(T2,tip)..tip: $(git -C N diff-tree -r --raw --merge-base "$T2" "$TIP" | awk '{print $5,$6}' | tr '\n' ';')"
# F6: no catch-up (today's shape): child C2 forked at base, never merges; delta vs moved target
mk_checkout B2 task/C2
cd B2; echo c2 > c2.txt; git add -A; git commit -qm "c2 work"; TIP2=$(git rev-parse HEAD); cd ..
git -C N fetch -q --no-tags "$S/B2" refs/heads/task/C2; git -C N update-ref refs/heads/task/C2 "$TIP2"
echo "F6 no catch-up: delta merge-base(T2,tip2)..tip2: $(git -C N diff-tree -r --raw --merge-base "$T2" "$TIP2" | awk '{print $5,$6}' | tr '\n' ';')"
# F7: worker merges but resolves the human-only path to the OLD value (keeps ours)
mk_checkout B3 task/C2
cd B3; git reset -q --hard "$TIP2"; git merge -q --no-commit "$T2" 2>/dev/null; git checkout -q HEAD -- .claude/settings.json 2>/dev/null; git commit -qm "merge keeping old settings"; TIP3=$(git rev-parse HEAD); cd ..
git -C N fetch -q --no-tags "$S/B3" refs/heads/task/C2
echo "F7 merge keeping ours on human-only path: delta merge-base(T2,tip3)..tip3: $(git -C N diff-tree -r --raw --merge-base "$T2" "$TIP3" | awk '{print $5,$6}' | tr '\n' ';')"
# F8: sparse-hidden path with a real conflict on it is impossible for worker (can't write); instead conflict in visible file while hidden path changed on theirs
mk_checkout B4 task/C1
printf '/*\n!/.claude/settings.json\n' | git -C B4 sparse-checkout set --no-cone --stdin
cd B4; git reset -q --hard "$TIP"; git merge --no-edit "$T2" >/dev/null 2>&1; echo "F8 conflicting merge exit=$?; B4/.claude: [$(ls .claude 2>/dev/null | tr '\n' ' ')]; unmerged: [$(git diff --name-only --diff-filter=U | tr '\n' ' ')]"; cd ..
# F9: fetch by ref name from the named place path is what a worker cannot do without reading N's refs; by sha objects are enough
echo "F9 B has T2 object without any fetch: $(git -C B cat-file -t "$T2")"
```
