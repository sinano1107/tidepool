# 名前の場所の ref への盤面自身の書き込みは、全部が基準への予告と畳みの内側か(#3194)

- 問い: issue #3194(map #3178 の子)。前提を問われているのは #3183 の resolution の決定3〜7。
- 読んだコード: main `25c845515dd750edbbad43d15580323b41676a5d`。以下の `file:line` はすべてこの commit のもの。
- 設計の推奨は書かない。事実と、確かめた方法だけを書く。

## 0. 答え

**偽。ただし外にあるのは2経路だけで、どちらも完了の門を通った内容や task の成果を運ぶ書き込みではない。**

基準の行を持つ名前の場所で、盤面が予告せずに `refs/*` を変える経路:

| # | 経路 | 予告なしに変わる ref | 条件 | 「基準へ戻す」が巻き戻すもの | 確かめ方 |
|---|---|---|---|---|---|
| X1 | registry clone の口の fallback(`src/server-options.ts:506–518`): registry clone に当たる workspace を引けなければ `write()` を素で撃つ | remote-backed: registry clone の `refs/remotes/origin/main`(fetch の写し `src/registry.ts:717–720`、push の後の写し `src/registry-write.ts:165–167`)。purely-local: `refs/heads/main`(`src/registry-write.ts:169–171`) | registry clone が workspace として登録され基準の行を持ち、かつその書き込みの瞬間に `registeredWorkspaces(board)` が投げる(registry が読めない、`src/server-options.ts:550–553`) | 写しを盤面が fetch する前の commit へ戻す(= 読めなかった registry の commit へ戻す)。purely-local なら着地した registry の commit を `main` から外す | 経路と条件は読み。起きた例は見ていない。巻き戻すものは推論 |
| X2 | publish の巻き戻しの `git remote remove origin`(`src/workspace-create.ts:555`)。口の内側だが、予告した N 本以外も消す | その時点で在る `refs/remotes/origin/*` の全部と `refs/remotes/origin/HEAD` | publish する checkout に、`remote.origin` の節が無いのに写しが残っていて、push か registry の commit が落ちる | 消えた残りの写しを作り直す(盤面の削除を巻き戻す)。内容は失われない | `remote remove` が消す範囲は実測(M-D)。盤面がそこへ届く経路は読み。巻き戻すものは推論 |

それ以外の、名前の場所の `refs/*` と HEAD への盤面の書き込みは、全部 `writeBoardRefs` / `boardRefWriter` / `advanceBranch` の内側にある(§2)。口の外にあって基準の行より**前**に走る書き込み(面接室の最初の build、clone、create)は、行が無いので決定6 の「比べるものが無いので何もせず通す」に入る(§2.3)。git が副作用で `refs/*` を書く経路は見つからなかった(§2.4、実測)。

「基準 = 盤面が最後に書いた正しい状態」が成り立たないのは、口の外の書き込みよりも次の3つのほうが広い(§3・§4):

1. **基準は「盤面が書いた値」ではなく「最後に受け入れた値」**である。最初の pickup の全撮りと `repaired by hand` の受理は人間が書いた値をそのまま迎え入れ、門の掛からない解放はタスクブランチの行を読み返した値で畳む(`src/workspace.ts:1668`)。
2. **落ちて残った2値行は、書き終えた書き込み(ref = new)と書く前(ref = old)を区別しない。** 決定7 が「書く前の値」へ戻すと、書き終えていた盤面の書き込みを巻き戻す場合がある。撃ち直しは読んだ限りどの経路でも効く(§3.2、読みと推論)。
3. **行が別の checkout のもの**でありうる(path の差し替え、削除の扉が registry の commit の後・行を消す前に落ちた名前、手で作り直された面接室)。

## 1. 確かめ方の区別

| 印 | 意味 |
|---|---|
| **実測** | 素の git 2.47.0(macOS)を使い捨てのディレクトリで走らせた。env は `localGitEnv`(`src/git.ts:257–278`)を shell に写したもの。盤面の関数も test も走らせていない。script の全文と出力は付録(§7)。 |
| **読み** | コード・ADR・git の man page(この Mac の git 2.47.0 に付属のもの)を読んだだけ。 |
| **推論** | 読みと実測から導いたが、その形そのものは走らせていない。 |
| **未確認** | 読んでも走らせてもいない。 |

盤面は一度も走らせていない。「盤面がその時点でどう振る舞うか」はすべて読みか推論である。

## 2. 名前の場所の `refs/*` と HEAD を書く盤面の経路

「名前の場所」は実環境の workspace の checkout と面接室(基準の行の鍵は名前、面接室は root の id —— `src/workspace.ts:1104`・`1119`・`261–265`)。registry clone は workspace として登録されているときだけ名前の場所になる(`registryRefWriter`、`src/server-options.ts:506–518`)。

洗い出しは `src/`(test を除く)で `update-ref` / `symbolic-ref` と、ref を書きうる git の subcommand(`commit` `merge` `checkout` `switch` `reset` `fetch` `push` `clone` `init` `branch` `tag` `worktree` `stash` `rebase` `cherry-pick` `remote` `pull` `gc` `read-tree`)、および `execFileSync("git"` / `gitWithInput` の grep。`merge` `checkout` `switch` `reset` `branch` `tag` `stash` `rebase` `pull` `gc` を盤面が撃つ箇所は無い(読み)。

### 2.1 口の内側(読み)

| 経路 | 書く ref | 口 | 場所 |
|---|---|---|---|
| pickup・受理・解放・収束の保護ブランチの fetch(`fetchBranchCopy`) | `refs/remotes/origin/<保護ブランチ>` | `boardRefWriter` を渡す(`src/workspace.ts:331`・`1071`・`1677`)。`ls-remote` → 予告 → sha の fetch → `update-ref`(`src/registry.ts:709–721`) | workspace |
| 休止位置へ戻す HEAD の移動(`checkoutThroughGate`) | `HEAD`、無ければ `refs/heads/<保護ブランチ>` | `writeBoardRefs`(`src/workspace.ts:935–940`)。**ticket の `937–938` はこの内側** | workspace、面接室 |
| 保護ブランチの fast-forward(`parkOnProtectedBranch`) | `refs/heads/<保護ブランチ>` | `advanceBranch`(`src/workspace.ts:1465`) | workspace |
| タスクブランチの作成(`createTaskBranch`) | `refs/heads/task/<id>` | `boardRefWriter`(`src/workspace.ts:986`) | workspace、面接室 |
| 完了の門の tip の記録(`recordTaskCheckoutTip`) | `refs/heads/task/<id>` | `boardRefWriter`(`src/workspace.ts:743`) | workspace、面接室 |
| 門の掛からない解放の WIP の退避 | `refs/heads/task/<id>` | `boardRefWriter`(`src/workspace.ts:1796`) | workspace、面接室 |
| merge back(解放・受理の `redoMergeBacks`) | `refs/heads/<帰り先>` | `advanceBranch`(`src/workspace.ts:1878`) | workspace |
| fork 元への追いつき(`catchUpTaskBranch`) | `refs/heads/task/<id>` | `advanceBranch`(`src/workspace.ts:1987`) | workspace |
| purely-local の着地(`mergeTaskToProtected`) | `refs/heads/<保護ブランチ>` | `advanceBranch`(`src/workspace.ts:2029`) | workspace |
| 着地の push と、その後の写し | `refs/remotes/origin/task/<id>` | `boardRefWriter`(`src/landing.ts:1191`)の中で `authedPush`(`src/github-auth.ts:316–325`)。**ticket の `github-auth.ts:324` はこの内側**。`authedPush` の呼び手は3つだけ: ここ(`src/github.ts:262` 経由)、publish(`src/workspace-create.ts:541`)、registry の着地(`src/registry-write.ts:166`) | workspace |
| 出題の写しの ref(`commitRoomCopy`) | `refs/keep-around/<head>` | `boardRefWriter`(`src/workspace.ts:862`) | 面接室 |
| 未生の HEAD を持つ記録済みの面接室の補い(`reopenUnbornRoom`) | `HEAD`、`refs/heads/main` | `writeBoardRefs`(`src/workspace.ts:254–258`) | 面接室 |
| publish の N 本の写し | `refs/remotes/origin/<全 branch>` | `writeBoardRefs`(`src/workspace-create.ts:559`)。ただし巻き戻しは X2 | workspace |
| registry の fetch・push の写し・purely-local の着地 | registry clone の `refs/remotes/origin/main` / `refs/heads/main` | `registry.writeRef` = `registryRefWriter`(`src/server-options.ts:831–834`・`893`、`src/registry-write.ts:33`・`165–171`)。**ticket の `registry.ts:719` は、渡された口の内側**。workspace を引けたときだけ `boardRefWriter`、引けなければ X1 | registry clone |

`writeBoardRefs` は基準の行が無い名前には予告せず素で書く(`updateBaseline` が false、`src/workspace.ts:1291–1295`・`1350–1353`)。行は最初の pickup の全撮りが作る(`prepareRefBaseline`、`src/workspace.ts:1178–1190`)。

### 2.2 口の外で、基準の行があるときに走りうるもの

**X1. registry clone の口の fallback(読み)。** `registryRefWriter` は書くたびに `registeredWorkspaces(board)` で registry clone に当たる workspace を探し、それが投げると warn を出して `write()` だけを撃つ(`src/server-options.ts:509–517`)。コメントは「説明の欠けは次の比較が誤検知の quarantine として大きな音で出す、ADR 0351 決定2」と書いていて、意図された穴である。`registeredWorkspaces` は `loadBoardRegistry` → `loadRegistry` を通る(`src/server-options.ts:422–425`・`550–553`)。`loadRegistry` が投げるのは、registry の ref が解けない、agent か authority の file が1つでも parse できない、`workspaces.yaml` が無い・schema に合わない・`assertValidWorkspaces` に落ちる、のどれか(`src/registry.ts:1054–1080`)。手元の写しがそういう commit を指している間は、registry clone への書き込みは全部予告なしになる。

- 届く呼び手: 起動時の refresh(`src/server-options.ts:834`)、pickup と回答時の到達性の検査(`893`)、書き込み verb の入口の `refreshRegistryForWrite`(`src/registry-write.ts:33`)、`land` の両 mode(`165–171`)。
- remote-backed で届く形(推論): origin に壊れた registry が入り、手元の写しがそれを指す → 人間が origin を直す → 次の refresh は、書く瞬間にはまだ壊れた写しを読むので workspace を引けず、予告なしで `refs/remotes/origin/main` を直った commit へ進める。registry clone の基準の行は壊れた commit のまま残る。次にその workspace を比べたとき(pickup か解放)、盤面自身の書き込みが違反と読まれる。
- 「基準へ戻す」が巻き戻すもの(推論): 写しを壊れた commit へ戻す。object は残っているので決定6 では拒まれない。今の出口は `repaired by hand` の受理の撮り直し(`retakeRefBaselines`、`src/human-verbs.ts:667`)だが、決定3 は「`repaired by hand` は、基準と違う ref があれば名指しして拒む」なので、この形の出口は「基準へ戻す」だけになる。戻した直後に同じ回答の中で後半の fetch(`src/human-verbs.ts:663`、口を通る)が写しを進め直すかは、その workspace の保護ブランチが registry の branch と同じかどうかと、戻した後に registry を読む検査が先に落ちないかに依る —— **未確認**。
- purely-local の `refs/heads/main`(`src/registry-write.ts:169–171`)も同じ fallback を通るが、`commitToRegistry` の呼び手は書く前に registry を読めている(例 `src/workspace-create.ts:404–405`)ので、その直後に `registeredWorkspaces` が投げる形は見つけていない(推論)。

**X2. publish の巻き戻し(実測 + 読み)。** `publishWorkspace` は `git remote add origin` の後、その時点の `refs/heads/*` の N 本について写し N 行を予告し、口の中で push → 写しの `update-ref` → registry の commit を撃つ。どれかが落ちると口の中で `git remote remove origin` を撃つ(`src/workspace-create.ts:521`・`526–559`)。

- `git remote remove origin` は `refs/remotes/origin/*` を全部と `refs/remotes/origin/HEAD` を消す。`remote.origin` の節が無いまま写しだけが残っていた checkout に `remote add` → `remote remove` を撃つと、残っていた写し(`origin/main`・`origin/old`・`origin/HEAD`)が全部消えた(実測 M-D)。
- 予告した N 本のうち元から写しが在ったものは、畳みが `before`(元の値)へ戻すが ref は消えている。予告していない写し(local に branch が無いもの、`origin/HEAD`)は行がそのまま残る。どちらも次の比較で違反になる(読み)。
- 入口の条件「origin が無い」は `remote.origin.url` の有無しか見ない(`CheckoutHasOriginError`、`src/workspace-create.ts:499–500`)。写しだけが残る状態は、決定12 が「origin が余分な側」の直し方に挙げた `git config --remove-section remote.origin` が作る(resolution の限界にあった「`remote.origin` の節を消して写しが残った状態で後の盤面の操作が困らないこと」の、困る1例)。
- 「基準へ戻す」が巻き戻すもの(推論): 盤面が消した残りの写しを基準の値で作り直す。sha の object は branch から届く限り残る。

### 2.3 口の外だが、基準の行ができる前に走るもの(読み)

| 経路 | 書くもの | 行が無いと言える根拠 |
|---|---|---|
| 面接室の最初の build(`openInterviewRoom` → `git init` → `initialRoomCommit`、`src/workspace.ts:228–245`) | `HEAD` の symref、`refs/heads/main`(`git commit --allow-empty`) | この分岐は `interview_room_opened` の記録が無いときだけ(`recordedPlace` が undefined、`225–228`)。面接室の行を作るのは `prepareRefBaseline` だけで、呼ばれるのは `openInterviewRoom` の後(`src/scheduler.ts:644–651`)か、記録済みの面接室を読む場所として(`roomsReadBy`、`src/workspace.ts:1119`)。`git init` と event の間で落ちても、撃ち直しは HEAD が在るので `initialRoomCommit` が何もしない(`240`) |
| clone mode の `git clone`(`authedClone`、`src/workspace-create.ts:832`) | `HEAD`、`refs/heads/<default>`、`refs/remotes/origin/*`、`refs/remotes/origin/HEAD`、tag(実測 M-A の clone 直後の列) | 登録前。行は削除の扉が消す(`dropWorkspaceState`、`src/workspace-create.ts:435`)。残りうる場合は §4 |
| create mode の `git init` + `git commit --allow-empty`(`src/workspace-create.ts:630–631`) | `HEAD`、`refs/heads/main` | 同上 |

決定11 の「空の面接室で走らせる」は、基準の行が**在る**名前に同じ `git init` + build を撃つことになる。今の `initialRoomCommit` は口を通らないので、行の作り直しを別に持たない限り、この表の「行が無い」が崩れる(推論)。

### 2.4 git が副作用で書く ref(実測)

名前の場所で盤面が撃つ形を、tag 付きの fetch 元に対して撃ち、前後で `currentRefs` と同じ形の文字列(HEAD の行 + `for-each-ref`)を diff した。

| 盤面の綴り | 結果 |
|---|---|
| `git fetch --quiet --no-auto-gc --no-write-fetch-head --no-recurse-submodules <path> <ref>`(`FETCH_FLAGS`、`src/workspace.ts:159`・`713`) | `refs/*` と HEAD は不変。`FETCH_HEAD` も書かない。tag は付いて来ない。object は入る(M-B) |
| `git fetch --quiet --no-auto-gc --no-recurse-submodules <盤面の repo> refs/board/fetched`(hop2、`src/github-auth.ts:308`) | `refs/*` と HEAD は不変。`FETCH_HEAD` を書く(基準の外)。`refs/remotes/origin/HEAD` が無い clone でも作られない(M-B) |
| `git worktree add --detach` → `git commit` → `git worktree remove --force`(registry の書き込み、`src/registry-write.ts:134–150`) | 本体の `refs/*` と HEAD は不変(M-E)。linked worktree の HEAD は `for-each-ref` に出ない |
| `git remote add origin <url>` | ref は不変(M-D) |
| `git remote remove origin` | X2 のとおり全部消す(M-D) |

- push は使い捨ての盤面の repo から撃つので、checkout の写しを git は動かさない(`inBoardRepo`、`src/github-auth.ts:265–284`。写しは `authedPush` が自分で書く、`324`)—— 読み。
- 網に出る fetch(hop1)は盤面の repo の `refs/board/fetched` に書く(`src/github-auth.ts:305`)。名前の場所ではない —— 読み。
- `gh` は cwd を名前の場所にして撃つが、必ず `-R <repo>` を付け、`pr create` は `--head` を明示し、`pr merge` は `--merge --match-head-commit` だけ(`src/github.ts:244–250`・`267–278`・`308`)。local の git を動かす flag(`--delete-branch` など)は付けていない —— 読み。gh が local の ref を書かないこと自体は**未確認**。

### 2.5 名前の場所ではない書き込み(読み)

ticket が挙げた `src/workspace.ts:463` は **task の checkout**(pickup ごとに `git init` する別の repo、`440–464`)の HEAD で、名前の場所ではない。task の checkout は基準を持たない(ADR 0356 決定4)。同じく名前の場所の外:

- 読み専用の checkout(`src/workspace.ts:488–496`)。
- worker の tip の検証用の使い捨て repo `raw` / `verified`(`668`・`691`・`724`)。
- 盤面の view の使い捨て gitdir(`src/git.ts:64`・`100`)。object は名前の場所へ書くが ref は書かない。
- 網に出る使い捨ての盤面の repo(`src/github-auth.ts:276`)、Codex の preflight の空 repo(`src/codex-worker.ts:1240`・`1319`)。

### 2.6 基準の行を直接書く経路(ref は書かない、読み)

基準が「盤面が書いた値」から離れる入口はここにある。

| 経路 | 行に入る値 |
|---|---|
| 最初の pickup の全撮り(`snapshotRefs`、`src/workspace.ts:1174–1190`) | その時点の全 ref。登録前に人間が置いたものを含む |
| quarantine の受理の撮り直し(`retakeRefBaselines`、`1203–1209`、`src/human-verbs.ts:667`) | 検査が通った時点の全 ref。人間が手で直した値を含む。行を既に持つ場所だけ |
| 比較が通ったときの2値行の畳み(`compareAndFoldBaseline`、`1284–1285`) | 2値のうち ref が持つ側 |
| 門の掛からない解放のタスクブランチの行(`settleBranches`、`1665–1669`) | `readRef` で読み返した今の値。この解放は比較からタスクブランチを除く(`1800`)ので、session 中にタスクブランチへ入った帯域外の値も行に入る |
| 削除の扉(`dropWorkspaceState`、`1213–1218`) | 行ごと消す |

## 3. 書き込みの途中で盤面が落ちたときの形

### 3.1 1本の書き込み `R: old → new` の組(読み)

`writeBoardRefs`(`src/workspace.ts:1334–1371`)は 予告 → `write()` → 読み返して畳む、の同期の1区間。落ちる位置ごとの組:

| 落ちた位置 | 基準の行 | ref | 次の比較 |
|---|---|---|---|
| 予告の前 | `old` | `old` | 通る |
| 予告の後、git の前 | `old\|new` | `old` | 通り、`old` に畳む |
| git の後、畳みの前 | `old\|new` | `new` | 通り、`new` に畳む |
| 畳みの後 | `new`(書けた)/ `old`(書けなかった) | 同じ | 通る |

作成は `|new`、複数本(HEAD + branch、publish の N 本)は ref ごとに独立に上のどれか。盤面の git は `execFileSync` なので、盤面が死んでも子の git は完走しうる(ADR 0243 の前文)。

**2値とは限らない。** 2値行が畳まれる前に同じ ref へ別の値を書くと、予告は `${previous}|${newValue}` で継ぎ足される(`1345–1347`)ので `old|new|new2` の3値になる。`write()` が投げれば畳みは `before` = `old|new` へ戻し、成功すれば `new2` の1値になる。3値が残るのは継ぎ足した書き込みの途中でもう一度落ちたときだけ。2値行を畳むのは比較(pickup・解放)だけで、比較を挟まずに同じ ref を書く経路は在る: 起動時と pickup ごとの registry の refresh、収束の `refreshProtectedBranch`、着地の push、purely-local の着地、fork 元への追いつき(読み)。3値行の先頭が「今の書き込みの書く前の値」とは限らない(`a|b` で ref = `b` のところへ `b → c` を予告すると `a|b|c`、この書き込みの書く前の値は `b`)。決定7 の「書く前の値」は、行の形からは一意に読めない(推論)。

### 3.2 決定7(どちらの値とも違うときだけ書く前の値へ戻す)で撃ち直せるか

2値行 `old|new` で ref が第3の値 X のとき、基準からは「git が書く前に落ちた」のか「書き終えた後に人間が動かした」のかを区別できない。`old` へ戻すと、後者では盤面が書き終えた `old → new` も巻き戻す。撃ち直しが効くかを経路ごとに読んだ(すべて読みと推論。盤面では走らせていない)。

| 経路 | `old` から撃ち直す契機 | 撃ち直しの形 |
|---|---|---|
| 写しの fetch(保護ブランチ、registry) | 次の pickup・受理の後半・refresh | `ls-remote` からやり直す。冪等 |
| タスクブランチの作成 | 次の pickup | 無ければ fork 元から作る(`src/workspace.ts:983`) |
| 完了の門の tip の記録 | 落ちた task は完了していない(tip の記録は完了の前)。後始末の解放が task の checkout から tip を引き直す(`1762–1768`) | task の checkout が残っている限り |
| WIP の退避 | 後始末の再実行 | 同上 |
| merge back | 受理の `redoMergeBacks` が届いていない done の work を数え直す(`1884–1942`) | merge commit は作り直し(sha は変わる) |
| 保護ブランチの fast-forward・休止位置 | 次の pickup・受理の後半の park | 冪等 |
| purely-local の着地 | 人間が merge question に答え直す | 帯域外判定は2値のどちらでも通す(`2018–2021`)。merge commit は作り直し |
| fork 元への追いつき | PR 昇格の再試行 | merge commit は作り直し |
| 着地の push と写し | 次の tick | origin は既に `new`。同じ sha の push は up-to-date |
| 出題の写しの ref | root の verb の再試行 | `refs/keep-around/<sha>` は名前が値。戻す = 消す。写しは作り直し(sha は変わる) |
| publish | 人間が publish をやり直す | 落ちた位置が `remote add` の後なら origin が残り、`CheckoutHasOriginError` で拒まれる。人間が節を消してから。写しが残っていれば X2 の入口 |

撃ち直せない経路は見つからなかった。ただし「書き終えていた merge commit が ref から外れ、別の sha の merge commit で置き換わる」ことは起きる(merge back、purely-local の着地、追いつき)。外れた commit を event が sha で記録している場合(着地が根に刻む執行の記録、`src/workspace.ts:2010`)に、その記録と ref が食い違うかは**未確認**。

### 3.3 ref は2値のどちらかなのに tree が壊れている形(実測)

checkout 中の branch を進める書き込み(`advanceBranch` の `follows`、`checkoutThroughGate`)は、`writeWithWorktree` が **ref を書く前に** `read-tree -u -m old new` で index と worktree を新しい tree にする(`src/workspace.ts:954–971`、`src/git.ts:86–92`)。`write()` が投げれば戻すが、その間で盤面が落ちれば戻らない。

- この状態: ref = `old`(基準の `old|new` と一致)、`git status --porcelain` は `M  f`(index に staged)。次の pickup は ref の比較を通り、休止中の未コミットの変更で止まる(`src/workspace.ts:1109–1114`)—— G-D、後半は読み。
- **`git checkout -- .` と `git clean -fd` では clean にならない**(index が新しい tree を持つので、index から worktree を戻しても同じ)。`git read-tree -u --reset HEAD` で clean になった(G-D)。決定12 の H11 の直し方(`git checkout -- .` / `git clean`)は、この形と、人間が `git add` しただけの形を直せない。
- 盤面が同じ書き込みを撃ち直すと自分で直る: 同じ `old → new` の `read-tree -u -m` は成功し、`update-ref` の後は clean(R-A)。同じ tree の別 commit でも成功(R-B)。**tree の違う `new3`** への撃ち直しは `Entry 'f' would be overwritten by merge` で落ちる(R-C)。ただし pickup は park より前に dirty で止まるので、pickup 経由ではこの撃ち直しに届かない(読み)。再起動後の後始末の再実行(`settleBranches` → park)が pickup より先に同じ書き込みを撃ち直して R-A の形で直るかは**未確認**。
- 逆向き: 書き終えた後(ref = `new`、tree = `new`)に ref だけ `old` へ戻すと `M  f` になる(R-D)。決定5 の「書いた後に盤面が tree を HEAD へ揃える」が要る場面はこれで、決定7 の2値行の戻しにも同じく要る。

## 4. 基準の行が無い / 古いまま Quarantine に答えられる時点(読み)

「基準へ戻す」は workspace の Quarantine に常設(決定3)なので、Quarantine の理由が ref でなくても選べる。行の状態ごと:

**行が無い**(決定6 で何もせず通る)

- 一度も pickup されていない workspace の Quarantine: 起動時の overlap の sweep(`src/board-state.ts:204–225`)、pickup の門の前半の失敗(`pickupGate` は `prepareRefBaseline` より前、`src/scheduler.ts:632–651`)、registry の default branch の guard(`src/workspace.ts:1563–1580`)、spawn 時の overlap(`src/claude-worker.ts:1618`、`src/codex-worker.ts:1495`)。
- 面接室: `openInterviewRoom` が落ちた Quarantine(`src/scheduler.ts:644–648`)。
- 受理は行を持たない場所を撮らない(`retakeRefBaselines`、`src/workspace.ts:1204`)ので、行は最初の pickup まで無いまま。

**行が在り、盤面の書き込みと一致している**が、Quarantine の本文が名指していない ref が動いている

- 比較が走るのは pickup と解放だけ(保護ブランチは着地、タスクブランチは完了の門でも)。休止中に人間が動かした ref は、次の比較まで違反にならない。別の理由(dirty、overlap、origin の食い違い、fetch の失敗)で立った Quarantine の本文は最初の登録で固定されるので、その ref を名指していない。「基準へ戻す」はそれも戻す(決定4 が event に残す対象)。

**行が古い / 別物**

| 形 | 行と ref の関係 | 「基準へ戻す」 |
|---|---|---|
| 落ちて残った多値行 | §3 | 決定7 |
| X1(registry clone の予告なしの書き込み) | 行が盤面の書き込みより古い | 盤面の書き込みを巻き戻す |
| X2(publish の巻き戻し) | 行に在る写しが盤面に消されている | 写しを作り直す |
| registry の `path` の手編集、同じ path での checkout の作り直し(H13) | 行は旧い checkout のもの | object が無ければ拒む(決定6)。**同じ repo の clone し直しなら、写しと default branch の旧い sha は祖先として在り、origin に push 済みの `task/<id>` の object も clone が運ぶので、全部の object が揃って戻せてしまう場合がある**(推論)。決定10 はこの形の出口を削除の扉 → 再登録としている |
| 削除の扉が途中で落ちた名前 | `deleteWorkspace` は registry の commit の後に行を消す(`src/workspace-create.ts:424–435`)。間で落ちると、registry に無い名前の行が残り、扉は `UnknownWorkspaceError` で撃ち直せない。同名で再登録すると最初の pickup が全撮りでなく旧い行との比較になる(`prepareRefBaseline` の `first` が false) | 上の行と同じ |
| 手で `git init` し直された面接室 | 面接室の行は消されない(`src/workspace.ts:1211–1212`)。`reopenUnbornRoom` は行を持つので口を通し、他の行(旧い `refs/keep-around/*`、`task/<id>`)は旧い値のまま | object が無いので拒む(決定6)。決定11 の対象 |
| 門の掛からない解放が畳んだタスクブランチの行 | 帯域外の値でも行に入る(§2.6) | 戻す先がその値になる |

起動時に2値行を畳む機構は無い(ADR 0243 の Considered options が退けた)。盤面の再起動は行を変えない。

## 5. 基準の sha の object はいつまで残るか

### 5.1 reflog(実測 + 読み)

- 名前の場所は non-bare なので `core.logAllRefUpdates` は true(`git init` / `git clone` が `.git/config` に書く。clone で `true` を読んだ、M-C)。盤面の env は global と system の config を外すが、repo の config は読む(`src/git.ts:257–278`)。
- 盤面の `update-ref` は `refs/heads/*`・`refs/remotes/*` に reflog を残し、checkout 中の branch なら HEAD の reflog にも残る。**`refs/keep-around/*` には残らない**(M-C。man page の `core.logAllRefUpdates`: true で作られるのは heads・remotes・notes・HEAD だけ)。
- reflog の期限は 90 日、どの tip からも届かない entry は 30 日(`gc.reflogExpire` / `gc.reflogExpireUnreachable` の既定、man git-gc)。期限切れを実際に消すのは gc。
- **branch を消すとその reflog も消える**(G-B: `git branch -D` と `update-ref -d` の後、`logs/refs/heads/` からその file が消えた)。消えた branch の tip が残るのは、checkout したことがあって HEAD の reflog に載っているときだけ(G-B: `gc --prune=now` の後も present)。checkout されたことのない tip はどの reflog にも無い(G-B)。盤面は名前の場所でタスクブランチを checkout しない(ADR 0356 決定1)ので、`task/<id>` の tip は HEAD の reflog に載らない(読み)。

つまり、人間が branch を**動かした**(reset・commit・`branch -f`)場合、基準の sha はその branch の reflog に 30〜90 日残る。**消した**場合と `refs/keep-around/*` は、他の ref から届かなければ reflog の保護が無い。

### 5.2 gc の猶予(実測 + 読み)

- `git gc` は届かない loose object を `gc.pruneExpire`(既定 2 週間)より古ければ消す。pack の中の届かない object は cruft pack に移して同じ期限で消す(man git-gc、2.47 は `--cruft` が既定)。
- **期限は「届かなくなってから」ではなく object の mtime から数える。** 20 日前の mtime にした loose commit を、ref を今消した直後の既定の `git gc` が消した(G-C)。基準の sha は盤面が何日も前に書いたものが普通なので、ref が消えた後の最初の gc で消えうる。
- 新しい object は残る: 作ったばかりの届かない commit は既定の `git gc` では present、`git gc --prune=now` で MISSING(G-B)。

### 5.3 誰が gc を起こすか(実測 + 読み)

`gc.auto=1` にした repo で、盤面の綴りごとに `GIT_TRACE=1` で子を見た(G-A)。

| 綴り | `git maintenance run --auto` を起動するか |
|---|---|
| `fetch --no-auto-gc …`(盤面の fetch は全部これ) | しない |
| `fetch`(`--no-auto-gc` 無し、対照) | する |
| `commit-tree`、`merge-tree --write-tree`、`update-ref`、`symbolic-ref`、`read-tree -u -m`、`for-each-ref`、`worktree prune / add / remove`、`remote add / remove` | しない |
| `commit` | **する** |

盤面が名前の場所で `git commit` を撃つのは3箇所(読み):

- 面接室の最初の build(`src/workspace.ts:244`)と create mode(`src/workspace-create.ts:631`)—— 作ったばかりの repo で、消すものが無い。
- **registry の書き込み**(`src/registry-write.ts:143`)—— linked worktree での commit で、object の置き場は registry clone と共有。registry clone が workspace として登録されていれば、盤面の git が名前の場所の auto gc を起動しうる唯一の経路。ADR 0356 決定5 の「fetch は `--no-auto-gc`」はここを覆っていない。fixture では起動だけを見た(loose 10 個では `gc.auto=1` でも pack されなかった —— 閾値の判定は `objects/17` の数からの推定、man git-gc)。

`gc --auto` が実際に動くのは loose object がおよそ 6700 個(`gc.auto`)か pack が 50 個(`gc.autoPackLimit`)を超えたとき(man git-gc)。名前の場所の `.git/config` がこれらを変えていれば変わる。盤面は設定しない(`src/` に `gc.` の設定は網に出る子の `-c gc.auto=0` だけ、`src/github-auth.ts:347`)。

人間の git 操作(`commit`・`merge`・`rebase`・`fetch`・`pull`、名前の場所への push を受ける `receive-pack`)は auto gc を起動する(man git-gc「common porcelain operations that create objects」。fetch は対照で実測)。盤面は gc を起こさないまま loose object を溜める側にいる: 小さな fetch は unpack されて loose になり(G-E: 8 object が全部 loose、pack 0)、`commit-tree` と `merge-tree` も loose を書く。閾値を超えた後の最初の人間の porcelain が gc を引く(推論)。

### 5.4 決定6(戻せなければ何も書かずに拒む)が当たる場面の見積もり

頻度の数字は出せない(盤面の実データを見ていない)。当たる形と当たらない形を分ける:

| 形 | object | 根拠 |
|---|---|---|
| 人間が branch を別の commit へ動かした | 残る(30〜90 日) | その branch の reflog(M-C、man) |
| 人間が写しを動かした(手の `git fetch origin`) | 残る | `refs/remotes/*` の reflog(M-C) |
| 人間が HEAD を動かした | 関係しない | 行は指し先の名前 |
| 人間が branch を消し、tip が他の ref から届く(merge back 済みのタスクブランチ) | 残る | 届く |
| 人間が branch を消し、tip が他から届かない(merge back されていないタスクブランチ、WIP) | **次の gc まで**。mtime が 2 週間より古ければ最初の gc で消える | G-B、G-C |
| `refs/keep-around/<head>` を消した | 受験者のタスクブランチがその head の子孫なら残る。無ければ上と同じ | reflog 無し(M-C) |
| checkout の作り直し・面接室の作り直し | 無い(同じ repo の clone し直しは一部〜全部在る、§4) | 読み |
| `git gc --prune=now`、`gc.pruneExpire=now` | reflog からも届かなければ即座に無い | G-B |

gc が走る契機は、人間がその checkout で porcelain を撃つことと、registry clone での盤面の `git commit` だけ。名前の場所は読むだけの運用(決定9 の「名前の場所は読むだけ」)なら、gc はほぼ人間の修理の手そのものが引く(推論)。

決定6 の「全部を確かめてから書く」で commit の存在だけを見ると、partial clone や欠けた blob を持つ checkout では commit が在っても決定5 の tree の揃えで落ちる可能性がある —— **未確認**(名前の場所が partial clone でありうるかも読んでいない)。

## 6. 限界

- 盤面は走らせていない。口の内外は grep と読みで、動的に組まれる git の引数(`...args`)は `src/` の呼び手を辿った範囲。test は洗い出しから除いた。
- 実測は macOS の git 2.47.0 だけ。Pi と Lima VM の git の版は確かめていない。`remote remove` の削除範囲、auto maintenance を起動する command、cruft pack の既定は版で変わりうる。
- X1 が実際に起きたことがあるか、X2 の入口の「節の無い写し」が実在の checkout に在るかは見ていない。
- X1 の「基準へ戻す」の後に同じ回答の検査がどう進むか、§3.2 の merge commit の置き換わりと event の記録の食い違いは未確認。
- `gh` が local の ref を書かないことは flag の読みだけ。
- 受験者の名前の行(ADR 0276 決定4 が言う「受験者の行」)が今も書かれるかは追っていない。`prepareRefBaseline` の呼び手は走る名前の場所と読む場所だけだった。
- linked worktree(人間が `git worktree add` したもの)の HEAD は基準に入らない(#3179 の範囲)。ここでは registry の書き込みが作る使い捨ての worktree だけを見た。
- 頻度(§5.4)は形の列挙で、数ではない。
- ADR の決定番号は、本文を読んだ ADR 0243 を除き、コードのコメントが引いている番号をそのまま写した。ADR の本文と照合していない。
- 再起動後に後始末がどの順で何を撃ち直すか(`src/teardown.ts`)は読んでいない。

## 7. 付録: fixture

3本とも素の git、使い捨てのディレクトリ。script の全文は §7.4。env は共通:

```sh
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=file
export GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false \
       GIT_CONFIG_KEY_2=commit.gpgsign GIT_CONFIG_VALUE_2=false GIT_CONFIG_KEY_3=core.excludesFile GIT_CONFIG_VALUE_3=/dev/null
FMT='--format=%(if)%(symref)%(then)symref=%(symref)%(else)%(objectname)%(end) %(refname)'
snap(){ (cd "$1"; echo "$(git symbolic-ref -q HEAD || git rev-parse HEAD) HEAD"; git for-each-ref "$FMT"); }
```

### 7.1 副作用の ref・reflog・remote remove(M-A〜M-E)

手順(要点):

```sh
# M-A/M-B: named = origin.git の clone。seed に c2・c3・tag v2 を足し、src.git(task/x と v2)と board.git(refs/board/fetched と全 tag)を作る
snap named > before.txt
(cd named; git fetch --quiet --no-auto-gc --no-write-fetch-head --no-recurse-submodules "$W/src.git" refs/heads/task/x)
snap named | diff before.txt -
(cd named; git fetch --quiet --no-auto-gc --no-recurse-submodules "$W/board.git" refs/board/fetched)
snap named | diff before.txt -
(cd named; git symbolic-ref -d refs/remotes/origin/HEAD; git fetch --quiet --no-auto-gc --no-recurse-submodules "$W/board.git" refs/board/fetched
 git symbolic-ref -q refs/remotes/origin/HEAD)
# M-C
(cd named; git update-ref refs/heads/task/x $C3 ""; git update-ref refs/remotes/origin/main $C3; git update-ref refs/keep-around/$C3 $C3
 git update-ref refs/heads/main $C3 $A; git symbolic-ref HEAD refs/heads/task/x; git reflog show <各 ref> | wc -l)
# M-D
git init -q -b main local; (cd local; git commit -q --allow-empty -m c1; S=$(git rev-parse HEAD)
 git update-ref refs/remotes/origin/main $S; git update-ref refs/remotes/origin/old $S; git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
 git remote add origin https://example.invalid/x.git; git for-each-ref "$FMT"; git remote remove origin; git for-each-ref "$FMT")
# M-E
(cd named; git worktree prune; git worktree add -q --detach "$W/wt" refs/remotes/origin/main
 cd "$W/wt"; echo x > f; git add -A; git commit -q -m w; cd "$W/named"; git worktree remove --force "$W/wt")
```

出力:

```
git version 2.47.0
== M-A: origin with tags; named place = clone ==
-- after clone:
refs/heads/main HEAD
52677a44236f9afd0b1073b60b2d628289dd7b91 refs/heads/main
symref=refs/remotes/origin/main refs/remotes/origin/HEAD
52677a44236f9afd0b1073b60b2d628289dd7b91 refs/remotes/origin/main
52677a44236f9afd0b1073b60b2d628289dd7b91 refs/tags/v1
== M-B: board fetch spellings into named place ==
FETCH_FLAGS <repo> <ref>: refs+HEAD unchanged
FETCH_HEAD files: 0
object present
hop2 fetch: refs+HEAD unchanged
FETCH_HEAD files: 1
origin/HEAD stays absent after path fetch
== M-C: reflogs written by update-ref / symbolic-ref (non-bare, default config) ==
HEAD reflog entries:        3
refs/heads/task/x reflog entries:        1
refs/heads/main reflog entries:        2
refs/remotes/origin/main reflog entries:        1
refs/keep-around/b538328a3c8b5b9ae7a9b9f73b990da8571646a5 reflog entries:        0
true                                   <- git config --get core.logAllRefUpdates
== M-D: remote remove deletes leftover copies without a remote section ==
-- before (no remote section):
024f02f1c1328010f6c305281d0303491b1dfa73 refs/heads/main
symref=refs/remotes/origin/main refs/remotes/origin/HEAD
024f02f1c1328010f6c305281d0303491b1dfa73 refs/remotes/origin/main
024f02f1c1328010f6c305281d0303491b1dfa73 refs/remotes/origin/old
remotes: []
-- after remote add:
(同じ4行)
-- after remote remove:
024f02f1c1328010f6c305281d0303491b1dfa73 refs/heads/main
== M-E: registry-style worktree add/commit/remove leaves main repo refs alone ==
worktree add/commit/remove: refs+HEAD unchanged
```

### 7.2 auto gc の起動・object の残り方・追従の途中の crash(G-A〜G-E)

手順(要点):

```sh
# G-A: named に commit 2つ、gc.auto=1、gc.autoDetach=false。各綴りを GIT_TRACE=1 で撃ち、stderr から maintenance / gc の子を拾う
# G-B
git init -q -b main surv; cd surv; echo a > f; git add f; git commit -q -m base
git branch task/keep; git branch task/gone
git checkout -q task/gone; echo g > g; git add g; git commit -q -m gone-tip; GONE=$(git rev-parse HEAD); git checkout -q main
git update-ref refs/heads/side "$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m side-tip)"; SIDE=$(git rev-parse refs/heads/side)
git branch -q -D task/gone; git update-ref -d refs/heads/side
git gc -q; git gc -q --prune=now          # それぞれの後に cat-file -e
# G-C
OLD=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m old-loose); git update-ref refs/heads/b "$OLD"
touch -t <20日前> ".git/objects/${OLD:0:2}/${OLD:2}"; git update-ref -d refs/heads/b; git gc -q
# G-D
N=$(git commit-tree "$(echo b > f; git add f; git write-tree)" -p "$O" -m c2); git read-tree -u --reset "$O"
git read-tree -u -m "$O" "$N"            # ここで落ちたことにする。update-ref は撃たない
git status --porcelain; git checkout -- .; git clean -fdq; git read-tree -u --reset HEAD
# G-E
git init -q -b main loose; cd loose; git commit -q --allow-empty -m base
git fetch --quiet --no-auto-gc --no-write-fetch-head "$W/src.git" refs/board/fetched; git count-objects -v
```

出力(G-A の右辺は trace から拾った子。空は起動なし。`git maintenance run --auto` を拾う grep が行を途中で切っている):

```
git version 2.47.0
== G-A: which board spellings start auto maintenance (gc.auto=1 so that any --auto run would act) ==
fetch --no-auto-gc (FETCH_FLAGS) <path> <ref>        ->
fetch (no --no-auto-gc) <path> <ref> [contrast]      -> built-in: git maintenance ru;git maintenance ru;
commit-tree                                          ->
merge-tree --write-tree                              ->
update-ref                                           ->
symbolic-ref HEAD                                    ->
read-tree -u -m                                      ->
for-each-ref                                         ->
worktree prune                                       ->
worktree add --detach                                ->
loose objects before commit in linked worktree: 8, packs: 0
commit (in linked worktree, registry-write.ts:143)   -> built-in: git maintenance ru;git maintenance ru;
loose objects after: 10, packs: 0
worktree remove --force                              ->
commit --allow-empty (room / create, fresh repo)     -> built-in: git maintenance ru;git maintenance ru;
remote add                                           ->
remote remove                                        ->
== G-B: object survival after a ref moves away / is deleted ==
reflog files before delete: ./main ./side ./task/gone ./task/keep
reflog files after delete : ./main ./task/keep
HEAD reflog still names gone-tip (it was checked out): 1
side-tip (never checked out) in any reflog: 0
after 'git gc' (default gc.pruneExpire=2.weeks.ago): gone-tip=present side-tip=present
after 'git gc --prune=now': gone-tip=present [held by HEAD reflog] side-tip=MISSING
== G-C: prune goes by object mtime, not by when the object became unreachable ==
loose, 20 days old, ref deleted just now, then default 'git gc': MISSING
== G-D: crash between read-tree (worktree follow) and update-ref ==
clean before: []
ref still old: yes
status after the crash: [M  f]
after 'git checkout -- .': [M  f]
after 'git clean -fd': [M  f]
after 'git read-tree -u --reset HEAD': []
== G-E: do --no-auto-gc fetches leave loose objects for the next porcelain command? ==
fetch.unpackLimit / transfer.unpackLimit: [] [] (unset = 100)
count: 8 in-pack: 0 packs: 0
```

### 7.3 追従の書き込みの撃ち直し(R-A〜R-D)

各 case は `f=a` の commit `O` と、`f=b` の commit `N`(親 `O`)を持つ repo。

```sh
# R-A
git read-tree -u -m "$O" "$N"; git read-tree -u -m "$O" "$N"; git update-ref refs/heads/main "$N" "$O"; git status --porcelain
# R-B: N2 = N と同じ tree の別 commit
git read-tree -u -m "$O" "$N"; git read-tree -u -m "$O" "$N2"
# R-C: N3 = f=z の commit。index と worktree は N、ref は O
git read-tree -u -m "$O" "$N3"
# R-D
git read-tree -u -m "$O" "$N"; git update-ref refs/heads/main "$N" "$O"; git update-ref refs/heads/main "$O" "$N"; git status --porcelain
```

```
== R-A: crash after read-tree, before update-ref; the same write is fired again ==
second read-tree old->new exit: 0
update-ref exit: 0; status: []
== R-B: crash after read-tree; the retry computes a different new value (a fresh merge commit) ==
read-tree old->new2 (same tree) exit: 0
== R-C: crash after read-tree; the retry's new value has a different tree ==
state: index+worktree at new, ref at old: [M  f]
error: Entry 'f' would be overwritten by merge. Cannot merge.
read-tree old->new3 exit: 128
== R-D: write completed (ref=new, tree=new), then the ref alone is put back to old (the 'restore to baseline' of a 2-valued row) ==
after the completed write: []
after ref put back without touching the tree: [M  f]
```

### 7.4 script の全文

`fx1.sh` —— §7.1(M-A〜M-E)

```sh
#!/bin/bash
# Synthetic fixture for #3194. Plain git in a temp dir, with the board's local git env (src/git.ts localGitEnv).
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
W=$(mktemp -d "$BASE/run.XXXXXX"); cd "$W"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=file
export GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false GIT_CONFIG_KEY_2=commit.gpgsign GIT_CONFIG_VALUE_2=false GIT_CONFIG_KEY_3=core.excludesFile GIT_CONFIG_VALUE_3=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
FMT='--format=%(if)%(symref)%(then)symref=%(symref)%(else)%(objectname)%(end) %(refname)'
snap(){ (cd "$1"; echo "$(git symbolic-ref -q HEAD || git rev-parse HEAD) HEAD"; git for-each-ref "$FMT"); }
git --version

echo "== M-A: origin with tags; named place = clone =="
git init -q -b main --bare origin.git
git init -q -b main seed; (cd seed; git commit -q --allow-empty -m c1; git tag v1; git remote add origin ../origin.git; git push -q origin main v1)
git clone -q "$W/origin.git" named
echo "-- after clone:"; snap named
(cd seed; git commit -q --allow-empty -m c2; git tag v2; git commit -q --allow-empty -m c3; git push -q origin main v2)
C3=$(cd seed; git rev-parse HEAD)

echo "== M-B: board fetch spellings into named place =="
git init -q --bare src.git; (cd seed; git push -q ../src.git main:refs/heads/task/x v2)
snap named > before.txt
(cd named; git fetch --quiet --no-auto-gc --no-write-fetch-head --no-recurse-submodules "$W/src.git" refs/heads/task/x)
snap named > after1.txt; diff before.txt after1.txt && echo "FETCH_FLAGS <repo> <ref>: refs+HEAD unchanged"; echo "FETCH_HEAD files: $(ls named/.git | grep -c FETCH_HEAD)"
(cd named; git cat-file -e "$C3^{commit}" && echo "object present")
git init -q --bare board.git; (cd seed; git commit -q --allow-empty -m c4; git push -q ../board.git HEAD:refs/board/fetched; git push -q --tags ../board.git)
(cd named; git fetch --quiet --no-auto-gc --no-recurse-submodules "$W/board.git" refs/board/fetched)
snap named > after2.txt; diff before.txt after2.txt && echo "hop2 fetch: refs+HEAD unchanged"; echo "FETCH_HEAD files: $(ls named/.git | grep -c FETCH_HEAD)"
(cd named; git symbolic-ref -d refs/remotes/origin/HEAD; git fetch --quiet --no-auto-gc --no-recurse-submodules "$W/board.git" refs/board/fetched; git symbolic-ref -q refs/remotes/origin/HEAD || echo "origin/HEAD stays absent after path fetch")

echo "== M-C: reflogs written by update-ref / symbolic-ref (non-bare, default config) =="
(cd named
 A=$(git rev-parse HEAD)
 git update-ref refs/heads/task/x "$C3" ""
 git update-ref refs/remotes/origin/main "$C3"
 git update-ref "refs/keep-around/$C3" "$C3"
 git update-ref refs/heads/main "$C3" "$A"
 git symbolic-ref HEAD refs/heads/task/x
 for r in HEAD refs/heads/task/x refs/heads/main refs/remotes/origin/main "refs/keep-around/$C3"; do printf '%s reflog entries: ' "$r"; git reflog show "$r" 2>/dev/null | wc -l; done
 git config --get core.logAllRefUpdates || echo "core.logAllRefUpdates unset (default)"
 echo "-- HEAD reflog:"; git reflog show HEAD
 git symbolic-ref HEAD refs/heads/main)

echo "== M-D: remote remove deletes leftover copies without a remote section =="
git init -q -b main local; (cd local; git commit -q --allow-empty -m c1
 S=$(git rev-parse HEAD)
 git update-ref refs/remotes/origin/main "$S"; git update-ref refs/remotes/origin/old "$S"; git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
 echo "-- before (no remote section):"; git for-each-ref "$FMT"; echo "remotes: [$(git remote)]"
 git remote add origin https://example.invalid/x.git; echo "-- after remote add:"; git for-each-ref "$FMT"
 git remote remove origin; echo "-- after remote remove:"; git for-each-ref "$FMT")

echo "== M-E: registry-style worktree add/commit/remove leaves main repo refs alone =="
snap named > wb.txt
(cd named; git worktree prune; git worktree add -q --detach "$W/wt" refs/remotes/origin/main; cd "$W/wt"; echo x > f; git add -A; git commit -q -m w; cd "$W/named"; git worktree remove --force "$W/wt")
snap named > wa.txt; diff wb.txt wa.txt && echo "worktree add/commit/remove: refs+HEAD unchanged"
echo "W=$W"
```

`fx2.sh` —— §7.2(G-A〜G-E)

```sh
#!/bin/bash
# Synthetic fixture 2 for #3194: auto-gc triggers, object survival, crash inside the worktree-following write.
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
W=$(mktemp -d "$BASE/run2.XXXXXX"); cd "$W"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=file
export GIT_CONFIG_COUNT=4 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/dev/null GIT_CONFIG_KEY_1=core.fsmonitor GIT_CONFIG_VALUE_1=false GIT_CONFIG_KEY_2=commit.gpgsign GIT_CONFIG_VALUE_2=false GIT_CONFIG_KEY_3=core.excludesFile GIT_CONFIG_VALUE_3=/dev/null
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
git --version
# which children does a command spawn? (GIT_TRACE prints "run_command: git maintenance run --auto ..." etc.)
kids(){ label="$1"; shift; out=$( { GIT_TRACE=1 "$@" >/dev/null; } 2>&1 ); printf '%-52s -> ' "$label"; echo "$out" | grep -oE 'run_command: (git )?(maintenance|gc)[^\n]*|built-in: git (gc|maintenance|prune|repack|reflog|pack-refs)[^\n]*' | sed 's/run_command: //' | sort -u | tr '\n' ';'; echo; }

echo "== G-A: which board spellings start auto maintenance (gc.auto=1 so that any --auto run would act) =="
git init -q -b main named; cd named
echo a > f; git add f; git commit -q -m c1; A=$(git rev-parse HEAD)
echo b > f; git commit -q -am c2; B=$(git rev-parse HEAD)
git config gc.auto 1; git config gc.autoDetach false
git init -q --bare "$W/src.git"; git push -q "$W/src.git" main:refs/board/fetched
kids "fetch --no-auto-gc (FETCH_FLAGS) <path> <ref>" git fetch --quiet --no-auto-gc --no-write-fetch-head --no-recurse-submodules "$W/src.git" refs/board/fetched
kids "fetch (no --no-auto-gc) <path> <ref> [contrast]" git fetch --quiet "$W/src.git" refs/board/fetched
T=$(git rev-parse "$B^{tree}")
kids "commit-tree" git commit-tree "$T" -p "$B" -m m
kids "merge-tree --write-tree" git merge-tree --write-tree "$A" "$B"
kids "update-ref" git update-ref refs/heads/task/x "$B" ""
kids "symbolic-ref HEAD" git symbolic-ref HEAD refs/heads/main
kids "read-tree -u -m" git read-tree -u -m "$B" "$B"
kids "for-each-ref" git for-each-ref
kids "worktree prune" git worktree prune
kids "worktree add --detach" git worktree add -q --detach "$W/wt" main
echo x > "$W/wt/g"; git -C "$W/wt" add -A
echo "loose objects before commit in linked worktree: $(git count-objects | cut -d' ' -f1), packs: $(ls .git/objects/pack | grep -c '\.pack$')"
kids "commit (in linked worktree, registry-write.ts:143)" git -C "$W/wt" commit -q -m w
echo "loose objects after: $(git count-objects | cut -d' ' -f1), packs: $(ls .git/objects/pack | grep -c '\.pack$')"
kids "worktree remove --force" git worktree remove --force "$W/wt"
kids "commit --allow-empty (room / create, fresh repo)" git commit -q --allow-empty -m e
kids "remote add" git remote add origin https://example.invalid/x.git
kids "remote remove" git remote remove origin
cd "$W"

echo "== G-B: object survival after a ref moves away / is deleted =="
git init -q -b main surv; cd surv
echo a > f; git add f; git commit -q -m base
git branch task/keep; git branch task/gone
git checkout -q task/gone 2>/dev/null; echo g > g; git add g; git commit -q -m gone-tip; GONE=$(git rev-parse HEAD); git checkout -q main
git update-ref refs/heads/side "$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m side-tip)"; SIDE=$(git rev-parse refs/heads/side)
echo "reflog files before delete: $(cd .git/logs/refs/heads && find . -type f | sort | tr '\n' ' ')"
git branch -q -D task/gone; git update-ref -d refs/heads/side
echo "reflog files after delete : $(cd .git/logs/refs/heads && find . -type f | sort | tr '\n' ' ')"
echo "HEAD reflog still names gone-tip (it was checked out): $(git reflog show HEAD | grep -c "${GONE:0:7}")"
echo "side-tip (never checked out) in any reflog: $(git reflog show --all | grep -c "${SIDE:0:7}")"
chk(){ git cat-file -e "$1^{commit}" 2>/dev/null && echo present || echo MISSING; }
git gc -q; echo "after 'git gc' (default gc.pruneExpire=2.weeks.ago): gone-tip=$(chk "$GONE") side-tip=$(chk "$SIDE")"
git gc -q --prune=now; echo "after 'git gc --prune=now': gone-tip=$(chk "$GONE") [held by HEAD reflog] side-tip=$(chk "$SIDE")"
cd "$W"

echo "== G-C: prune goes by object mtime, not by when the object became unreachable =="
git init -q -b main age; cd age
echo a > f; git add f; git commit -q -m base
OLD=$(git commit-tree "$(git rev-parse HEAD^{tree})" -p HEAD -m old-loose); git update-ref refs/heads/b "$OLD"
# backdate the loose object by 20 days, as if the ref had been written long ago; then delete the ref *now*
touch -t "$(date -v-20d +%Y%m%d%H%M 2>/dev/null || date -d '20 days ago' +%Y%m%d%H%M)" ".git/objects/${OLD:0:2}/${OLD:2}"
git update-ref -d refs/heads/b
git gc -q; echo "loose, 20 days old, ref deleted just now, then default 'git gc': $(git cat-file -e "$OLD^{commit}" 2>/dev/null && echo present || echo MISSING)"
cd "$W"

echo "== G-D: crash between read-tree (worktree follow) and update-ref =="
git init -q -b main crash; cd crash
echo a > f; git add f; git commit -q -m c1; O=$(git rev-parse HEAD)
N=$(git commit-tree "$(echo b > f; git add f; git write-tree)" -p "$O" -m c2); git read-tree -u --reset "$O"
echo "clean before: [$(git status --porcelain)]"
git read-tree -u -m "$O" "$N"      # boardReadTree(old -> new); the process dies here, update-ref never runs
echo "ref still old: $([ "$(git rev-parse refs/heads/main)" = "$O" ] && echo yes)"
echo "status after the crash: [$(git status --porcelain)]"
git checkout -- . ; echo "after 'git checkout -- .': [$(git status --porcelain)]"
git clean -fdq; echo "after 'git clean -fd': [$(git status --porcelain)]"
git read-tree -u --reset HEAD; echo "after 'git read-tree -u --reset HEAD': [$(git status --porcelain)]"
cd "$W"

echo "== G-E: do --no-auto-gc fetches leave loose objects for the next porcelain command? =="
git init -q -b main loose; cd loose; git commit -q --allow-empty -m base
echo "fetch.unpackLimit / transfer.unpackLimit: [$(git config --get fetch.unpackLimit)] [$(git config --get transfer.unpackLimit)] (unset = 100)"
git fetch --quiet --no-auto-gc --no-write-fetch-head "$W/src.git" refs/board/fetched
git count-objects -v | grep -E '^(count|in-pack|packs):' | tr '\n' ' '; echo
echo "W=$W"
```

`fx3.sh` —— §7.3(R-A〜R-D)

```sh
#!/bin/bash
# Synthetic fixture 3 for #3194: re-firing the worktree-following write after a crash, and from a rolled-back ref.
set -u
BASE="$(cd "$(dirname "$0")" && pwd)"
W=$(mktemp -d "$BASE/run3.XXXXXX"); cd "$W"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=file
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@e GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@e
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
mk(){ git init -q -b main "$1"; cd "$1"; echo a > f; git add f; git commit -q -m c1; O=$(git rev-parse HEAD)
      N=$(git commit-tree "$(echo b > f; git add f; git write-tree)" -p "$O" -m c2); git read-tree -u --reset "$O"; }

echo "== R-A: crash after read-tree, before update-ref; the same write is fired again =="
mk a
git read-tree -u -m "$O" "$N"                       # died here
git read-tree -u -m "$O" "$N"; echo "second read-tree old->new exit: $?"
git update-ref refs/heads/main "$N" "$O"; echo "update-ref exit: $?; status: [$(git status --porcelain)]"
cd "$W"

echo "== R-B: crash after read-tree; the retry computes a different new value (a fresh merge commit) =="
mk b
N2=$(git commit-tree "$(git rev-parse "$N^{tree}")" -p "$O" -m c2-again-later-timestamp-differs-in-real-life)
git read-tree -u -m "$O" "$N"                       # died here
git read-tree -u -m "$O" "$N2"; echo "read-tree old->new2 (same tree) exit: $?"
cd "$W"

echo "== R-C: crash after read-tree; the retry's new value has a different tree =="
mk c
N3=$(git commit-tree "$(echo z > f; git add f; git write-tree)" -p "$O" -m c3); git read-tree --reset "$N"; echo b > f
echo "state: index+worktree at new, ref at old: [$(git status --porcelain)]"
git read-tree -u -m "$O" "$N3" 2>&1 | head -2; echo "read-tree old->new3 exit: ${PIPESTATUS[0]}"
cd "$W"

echo "== R-D: write completed (ref=new, tree=new), then the ref alone is put back to old (the 'restore to baseline' of a 2-valued row) =="
mk d
git read-tree -u -m "$O" "$N"; git update-ref refs/heads/main "$N" "$O"; echo "after the completed write: [$(git status --porcelain)]"
git update-ref refs/heads/main "$O" "$N"; echo "after ref put back without touching the tree: [$(git status --porcelain)]"
echo "W=$W"
```
