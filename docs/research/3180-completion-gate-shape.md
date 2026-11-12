# 完了の門が worker の tip を受け取る形 —— 何を検査し、worker session の何を前提にしているか(#3180)

- 問い: issue #3180(文脈は #3158)。設計の推奨は書かない。
- 読んだ版: main `25c84551`(2026-11-12)。行番号はすべてこの版のもの。#3158 のコメントの行番号(`src/mcp.ts:356–395`、`src/workspace.ts:727` など)はずれている。
- 置き場所: `docs/research/` はこの調査で新しく作った(既存の research 用の置き場・ブランチの慣習は見つからなかった —— `ls docs`、`docs/agents/workflow.md` の grep、`git branch -r | grep research`)。

## 実行したもの / 読んだだけのもの

- **実行した**: `gh issue view`(#3180、#3158)、`git rev-parse HEAD`、`grep` / `sed` / ファイルの読み。**盤面の関数もテストも走らせていない。素の git での実測も無い**(scratchpad での `diff-tree --merge-base` の実測は worktree の隔離に拒まれて走らなかった)。
- **読んだ**: 下の「読んだ範囲」。この文書の主張はすべてコード・テスト・ADR の読みである。

## 1. 手順 —— worker が verb を呼んでから tip が名前の場所に入るまで

### 0. pickup が先に置くもの(門が前提にする状態)

| 置くもの | 場所 |
|---|---|
| 名前の場所の基準(`workspace_state.ref_snapshot`)。行が無ければ全撮り、あれば除外無しで比較 | `prepareRefBaseline` `src/workspace.ts:1178–1190`、呼び手 `:1104` |
| 名前の場所の `refs/heads/task/<id>`。fork 元の sha で、口(`boardRefWriter`)を通して作る | `createTaskBranch` `src/workspace.ts:982–987`、fork 元は `taskForkSource` `:975–979` |
| task の checkout(`git init` + 名前の場所から `task/<id>` だけ fetch、work / review は alternates) | `openTaskCheckout` `src/workspace.ts:440–478` |
| event `task_checkout_opened`(`path`、work なら `completion_gate: "recorded_tip"`) | `src/workspace.ts:470–477` |
| slot の占有(task id と session id = `task_picked_up` の event id) | `src/scheduler.ts:593–600`、`src/slot.ts:53–60` |

### A. verb から `done` まで(同期、1回の MCP call の中)

| # | 段 | 検査するもの | 書くもの | file:line |
|---|---|---|---|---|
| A1 | Worker MCP の入口 | URL の `?task=`(spawn 時に付く)を帰属として読む。`/mcp` は 127.0.0.1 の専用 port | — | `createMcpRouter` `src/mcp.ts:1924–1934`、`src/server.ts:816–821` |
| A2 | verb の登録 | task ごとの差し替えで `complete_task` が伏せられていないこと(Interview の root・統合レビュー・meta-review・RCA には登録しない) | — | `src/mcp.ts:640`、`:735–771` |
| A3 | 帰属の解決 | `?task=` が slot の `currentTaskId` と一致、session が後始末に入っていない、task の行がある | — | `resolveAttributedTask` `src/mcp.ts:297–311` |
| A4 | 門は verb の前 | `runReleasingVerb` が `gate` を先に呼ぶ | — | `src/mcp.ts:458–467` |
| A5 | 門が掛かるか | `task.type === "work"` だけ | — | `completionTreeGateApplies` `src/workspace.ts:1426–1428`、`src/mcp.ts:334` |
| A6 | 走る場所の解決 | 名前の場所 = 受験者なら記録の面接室、他は `task.workspace` を registry で解く。task の checkout の path = 最新の `task_picked_up` より後の `task_checkout_opened` の `path`。名前が解けなければ DomainError(Quarantine は立てない、ADR 0363 決定1・2) | — | `taskRunPlaceForBoard` `src/workspace.ts:384–395`、`taskCheckoutPath` `src/tasks.ts:594–612`、`src/mcp.ts:339–350` |
| A7 | worker の tip の値を読む | checkout の `.git` が dir。`refs/heads/task/<task id>` の file、無ければ `packed-refs` の行。symlink を辿らず、symref は故障。git には開かせない | — | `readWorkerTip` `src/workspace.ts:581–606` |
| A8 | 写して検証する | 盤面の tmp に bare repo を2つ(`raw` / `verified`)。checkout の loose と `.pack` だけ byte で写す。`rev-list --objects <sha>` で閉包、`pack-objects`、`index-pack --strict`。work は名前の場所の objects を alternates で借りる(受験者は借りない)。段全体が 30 秒の上限 | tmp の repo だけ | `withVerifiedWorkerTip` `src/workspace.ts:676–700`、`copyAndVerifyWorkerTip` `:642–673`、上限 `src/worker-tree-git-timeout.ts:3` |
| A9 | 名前の場所へ fetch | `git fetch <旗> <verified> <ref>` を名前の場所で撃ち、`cat-file -e <sha>^{commit}` | 名前の場所の **objects だけ**(ref は書かない) | `fetchWorkerTip` `src/workspace.ts:703–708`、`fetchFromBoardCopy` `:711–719`、旗 `:159` |
| A10 | 1本の ref だけの基準検査 | 名前の場所の `task/<id>` の今の値が symref でなく、基準のその行の値(予告中なら2値のどちらか)と一致すること。外れれば `RefsMovedError` → 門は Quarantine を立てず「Retry complete_task or escalate」で拒む(ADR 0359 決定4) | — | `recordTaskCheckoutTip` `src/workspace.ts:737–742`、`baselineAllows` `:1248–1250`、`src/mcp.ts:355–360` |
| A11 | ref を書く | `update-ref --no-deref <ref> <tip> <old>`(旧値の CAS)。口が基準の行を `<old>\|<new>` に予告し、書いた後に畳む | 名前の場所の `refs/heads/task/<id>` と基準のその行 | `src/workspace.ts:743`、`writeBoardRefs` `:1334–1371` |
| A12 | 隠せない形 | 記録した tip の `.claude` が tree でなければ拒む(ADR 0360 決定4) | — | `src/mcp.ts:363–371`、`recordedSettingsDisposition` `src/sandbox.ts:605–619` |
| A13 | 人間しか書けない path | fork 元(今の ref から導き直す)と tip の **merge-base** から tip までに entry が変わった path のうち、人間しか書けない形に当たるものがあれば path を名指して拒む(ADR 0362 決定2)。merge-base が無ければ「could not verify」で拒む | — | `src/mcp.ts:372–383`、`treeDeltaEntries` `src/sandbox.ts:635–637`、`diffTreeEntries` `src/git.ts:206–214`、形 `src/sandbox.ts:630–642` |
| A14 | gitlink | 同じ delta で gitlink を足す・進める path があれば拒む(ADR 0365 決定2) | — | `src/mcp.ts:384–392`、`src/git.ts:218–220` |
| A15 | 未 commit の変更 | task の checkout の worktree を、記録した tip に対して盤面の view で読む。変更があれば path を名指して拒む | — | `src/mcp.ts:393–406`、`completionTreePaths` `src/workspace.ts:1404–1408`、`boardViewStatus` `src/git.ts:236–249` |
| A16 | verb 本体 | 種別固有の verb で終わる task でない、未決着、work で担当が人間でなければ handoff の全欄、終わっていない子が無い | `tasks.status = 'done'`、`handoff_doc`、event `task_completed`(actor は agent 名、origin `worker`)。後始末の印と同じ transaction | `completeTask` `src/tasks.ts:1415–1441`、`finishTask` `:1444–1484`、`src/mcp.ts:471–480`、actor `:251–258` |
| A17 | session を後始末へ | — | `slot.enterTeardown()`、回収済み観測の後に `runTeardown`(門が検査した場所を渡す) | `src/mcp.ts:481–483` |

読みから言えること:

- **tip は A11 で名前の場所の ref になり、中身の検査(A12〜A15)と handoff の検査(A16)はその後である。** 拒まれた tip は `task/<id>` に残り、task は `in_progress` のまま。`tests/completion-commit-gate.test.ts:165–179` が、拒否の後に名前の場所の `task/<id>` が拒まれた tip であることを assert している。ADR 0359 決定1 の `done` ⇔ tip が記録にある、は「`done` なら tip が記録にある」の向きで、「記録の ref にある tip は門を通った」は成り立たない。
- **門に祖先の検査は無い。** A11 は旧値の CAS だけで、新しい tip が旧値の子孫であることを確かめない。ADR 0364 決定1 は「tip が fork 元と無関係な commit でもよいのは今日どおり」と書く。祖先・merge-base を読むのは A13 の delta(merge-base が取れないと拒む —— `tests/completion-commit-gate.test.ts:318–333`。このとき tip は A11 で既に ref に入っている)と、門の外の2か所: WIP の退避の base 選び(`src/workspace.ts:1764`)と merge back(`:1867–1870`)。
- **門が書く ref は呼んだ task 自身の `refs/heads/task/<id>` 1本だけ。** 他の task のブランチ・保護ブランチ・HEAD を外の tip から書く手は門に無い。
- A10 は基準全体の比較ではない(ADR 0359 決定4)。他の ref が帯域外に動いていても門は通る。
- **門が何も検査せずに verb へ進む枝が1つある。** workspace の resolver が無い盤面では `taskRunPlaceForBoard` が undefined を返し、`completionGatedPlace` は `src/mcp.ts:350` で undefined を返して A7〜A15 を全部飛ばす(受験者は面接室が記録にあるのでこの枝に入らない)。`gate` 自体は渡されているので `:475` の不変条件にも掛からない。どの構成で resolver が無くなるかは読んでいない。

### B. `done` の後(後始末、非同期)

| # | 段 | 検査するもの | 書くもの | file:line |
|---|---|---|---|---|
| B1 | 解放してよいか | slot の主がこの task、梯子の底で保留されていない | — | `src/teardown.ts:386–394` |
| B2 | 門の掛かる完了の解放 | tip は worker の checkout から**読み直さない**。基準の行から記録の tip を取り、checkout は観測だけ(報告後の書き込み) | event `task_checkout_written_after_completion`(あれば) | `settleTaskCheckout` `src/workspace.ts:1741–1760`、`:1786–1791`、`observeCheckoutAfterCompletion` `:1431–1443` |
| B3 | 基準の全体比較 | 名前の場所の全 ref と HEAD を除外無しで基準と比べる。動いていれば名前の場所の Quarantine | 2値行の畳み | `src/workspace.ts:1800`、`compareAndFoldBaseline` `:1269–1287`、`:1812–1815` |
| B4 | 記録の tip の tree が読めるか | `ls-tree -r` か `cat-file -e <tip>^{tree}` | — | `src/workspace.ts:1802–1810` |
| B5 | merge back | work の完了だけ。帰り先は lineage が指す祖先のタスクブランチ。祖先なら何もしない / ff / `merge-tree` + `commit-tree`。conflict は名前の場所の Quarantine(手の merge を指示する文) | 帰り先の `task/<親>`(口を通す)、remote-backed なら保護ブランチの写し | `settleBranches` `src/workspace.ts:1663–1682`、`mergeBackInto` `:1855–1879`、`src/teardown.ts:396` |
| B6 | 休止位置 | HEAD を保護ブランチへ、remote-backed は ff だけ | HEAD、local の保護ブランチ | `parkOnProtectedBranch` `src/workspace.ts:1447–1477` |
| B7 | checkout を消す | — | event `task_checkout_released`、checkout の削除 | `releaseTaskCheckout` `src/workspace.ts:1686–1707` |

着地(PR 昇格・local 着地)はこの後で、この調査では読んでいない。

### C. 同じ部品を使う隣の経路

- **WIP の退避(門の掛からない解放、ADR 0367)**: `fetchWorkerTip`(A7〜A9 と同じ手)→ base は「tip が記録の値の祖先なら記録の値、でなければ tip」(`src/workspace.ts:1762–1764`)→ worktree を盤面所有の repo に stage(`boardWriteTree` `src/git.ts:166–196`)→ その repo で `commit-tree`(盤面名義、`WIP: task <id>`)して名前の場所へ fetch(`fetchStagedTree` `src/workspace.ts:721–729`)→ `update-ref <taskRef> <tip> <old>`(`:1795–1796`)。基準の比較は自分の task の ref を除外して行う(`:1800`)。
- **出題の写し(`commitRoomCopy`、`pose_probe` の門)**: `withVerifiedWorkerTip` で tip を検証(名前の場所へは fetch しない)→ worktree を stage → 面接室の保護ブランチの head を親にした盤面名義の commit を面接室へ fetch → `refs/keep-around/<head>` を口を通して書く(`src/workspace.ts:844–866`、`src/mcp.ts:859–889`)。

## 2. worker session を前提にしている段 / していない段

「前提」は関数が引数・記録・状態として読むものから数えた。

| 段 | worker session の何を前提にするか | コードの場所 |
|---|---|---|
| A1〜A3 入口 | **前提にする**: `?task=` の帰属、slot がその task の session に握られていること、後始末に入っていないこと | `src/mcp.ts:297–311`、`:1924–1934` |
| A2 verb の登録 | **前提にする**: task の種別ごとの verb の面 | `src/mcp.ts:640`、`:735` |
| A5 門の適用 | **前提にする**: task の行(`type === "work"`) | `src/workspace.ts:1426–1428` |
| A6 走る場所 | **前提にする**: task の行(`workspace` 列、Interview の役)、registry の名前の解決、**この pickup の** `task_checkout_opened` event(path は盤面が作った checkout のもので、入力から来ない) | `src/workspace.ts:384–395`、`src/tasks.ts:608–612` |
| A7 tip の読み | **前提にする**: その checkout の `.git` が dir、branch の名前が `task/<task id>`。値は ref から読み、sha を引数で受けない | `src/workspace.ts:581–606` |
| A8 写しと検証 | **前提にする**: checkout の `objects/` の regular file、役(名前の場所の objects を借りるか)。「worker が生きている最中に読む」前提の検査(Linux の `/proc/self/fd`)と 30 秒の上限 | `src/workspace.ts:539–555`、`:642–700` |
| A9 fetch | **前提にしない**: 引数は名前の場所・盤面所有の repo・ref・sha・説明文だけ | `fetchFromBoardCopy` `src/workspace.ts:711–719` |
| A10 1本の基準検査 | 名前の場所の名前で引く基準の行と ref 名だけ。ref 名は task id から作る。task の行・session は読まない | `src/workspace.ts:736–742`、`recordedRef` `:1255–1257` |
| A11 ref の書き込み | **前提にしない**: 口の引数は `db`・名前の場所・ref・新値・書く手 | `boardRefWriter` `src/workspace.ts:1374–1376` |
| A12 隠せない形 | **前提にしない**: repo の path と tip | `src/sandbox.ts:605` |
| A13 人間しか書けない path | fork 元を **task の行の系譜**(`parent_id` の鎖、種別、受験者なら出題の head)から導く。比較そのものは名前の場所・base・tip だけ。**誰が書いた tip かは読まず、path の形で拒む** | `taskForkSource` `src/workspace.ts:975–979`、`resolveTaskBranchLineage` `:870–908`、`src/sandbox.ts:635–642` |
| A14 gitlink | 同上(同じ delta) | `src/git.ts:218–220` |
| A15 未 commit | **前提にする**: task の checkout の worktree、task の `worker_spawned` / `task_picked_up` event(Harness で除外が変わる) | `src/workspace.ts:1018–1027`、`:1399–1408` |
| 門の中の上限超過 | **前提にする**: slot の session id、容器(session を強制回収で決着させる) | `forceReclaimOnWorkerTreeTimeout` `src/mcp.ts:417–429` |
| A16 verb 本体 | task の行(未決着、子)、handoff。actor は **task の担当の名前**(`assignee`、未指定なら種別ごとの既定の agent)、origin は `worker`。`completeTask` 自体は人間の扉と共有 | `src/tasks.ts:1415–1484`、`src/mcp.ts:244–258`、`resolveTaskAgent` `src/tasks.ts:3882–3892` |
| A16 の不変条件 | 門が掛かる task が門なしに `done` になれば巻き戻す —— **この検査は worker の扉(`runReleasingVerb`)にだけある** | `src/mcp.ts:474–477` |
| A17・B1 後始末 | **前提にする**: slot、session の回収済み観測 | `src/mcp.ts:481–483`、`src/teardown.ts:386–394` |
| B2 | **前提にする**: `task_checkout_opened` の `completion_gate: "recorded_tip"`(無ければ旧版の完了として別扱い)、task の checkout | `src/workspace.ts:1752–1760` |
| B3・B4・B6 | 名前の場所だけ | `src/workspace.ts:1269–1287`、`:1447–1477` |
| B5 merge back | task の行の系譜と `type === "work"`。引数は名前の場所・帰り先・task id・記録の tip | `src/workspace.ts:1679–1680`、`:1855–1879` |

封じ込めについて: 門のコードは封じ込めの成立を検査しない(検査は pickup / spawn の側で、この調査では読んでいない)。門が持つのは、checkout の byte を信用しない読み方(A7・A8)である。封じ込めを前提として**書いている**箇所は、写しの置き場のコメント「盤面 process の tmp —— worker は書けない」(`src/workspace.ts:685`)、ADR 0359 決定3 の「名前の場所は worker が書けない」、後始末の `heldForContainment`(`src/teardown.ts:389`)。ADR 0364 決定1 の不変条件は「記録に入る object は、名前の場所に既にあるか、worker が自分の checkout の `objects/` に regular file として書いたもののみ」。

## 3. 人間の commit(別の git ディレクトリで作ったもの)を同じ経路に通すとき、欠ける前提

埋め方は書かない。

1. **入口の帰属が無い。** 経路の入口は Worker MCP の `?task=` と slot の一致で、人間の扉(HTTP / 管理 MCP)はここを通らない。人間の完了の扉 `completeThroughHumanDoor`(`src/human-verbs.ts:948–973`)は担当が人間の task だけを受け、`in_progress` を拒み、**門を通さずに** `completeTask` を呼ぶ。
2. **走っている session が無い。** A6 の checkout の path は、この pickup の `task_checkout_opened` からしか引けない。path を運ぶ入力は無く、event を書くのは `openTaskCheckout` だけである。人間が担当した work は「盤面のタスクブランチに内容を持たない」と `src/landing.ts:430–431` のコメントが書く。
3. **読む ref の名前が固定。** A7 が読むのは、その checkout の `refs/heads/task/<呼んだ task の id>` だけ。sha や branch 名を受ける引数は `recordTaskCheckoutTip(db, place, taskId)` に無い。
4. **`.git` の形。** A7・A8 は `.git` が dir であること、objects が自分の `objects/` の loose か `.pack`、または名前の場所に既にあることを要求する。`.git` が file の checkout(`git worktree`)、bare repo、その repo 自身の alternates の先にしか無い object は「worker の repo の故障」になる。checkout の `objects/pack/` の `.pack` は、閉包が名前の場所にあるかに依らず全部写して `index-pack` する(`src/workspace.ts:654–659`)。その段が 30 秒の上限の中にある。
5. **書く先が自分の `task/<id>` 1本。** #3158 の表で人間の内容の行き先になっている ref(H1 の帰り先 = 親の `task/<id>`、H7・H18・H19・H21 の保護ブランチ)へ、外の tip を書く手は門に無い。読んだ範囲で、親のブランチと保護ブランチに盤面が書く手は、名前の場所に既にある ref どうしの merge back(`mergeBackInto`)と休止位置の ff(`parkOnProtectedBranch`)、origin からの保護ブランチの fetch である(`mergeTaskToProtected` / `catchUpTaskBranch` の本体は読んでいない)。
6. **基準の行。** A10 は名前の場所の `task/<id>` が基準の値(pickup が予告した fork 元か、盤面が後から書いた値)のままであることを要求する。A10 は自分の1本しか見ないが、B3(解放の全体比較)は全 ref と HEAD を見る。
7. **Quarantine 中は session が始まらない。** 門自体は workspace の Quarantine で変わらない(ADR 0350 決定1、`tests/completion-commit-gate.test.ts:335`)が、Quarantine が開いている間その workspace の task は slot に入らない(`src/workspace.ts:1507–1511` のコメントの読み。pickup の停止の門は読んでいない)。
8. **fork 元。** A13・A14 の base は task の行(`parent_id` の鎖、種別、役)から導く。task の行が無ければ base を導く入力が無い。base と tip の merge-base が取れなければ拒む。
9. **人間しか書けない path の検査は書き手を見ない。** A13 は path の形で拒むので、人間の commit がこの門を通ると、人間しか書けない path の変更(#3158 の H18・H19 の内容そのもの)は拒まれる側に入る。
10. **未 commit の検査の対象。** A15 は task の checkout の worktree を読む。
11. **actor と origin。** A16 の event は task の担当の名前と origin `worker` で刻まれる。`src/mcp.ts:244–250` のコメントは「MCP の call は必ず agent の session に帰属し、人間にはならない」と書くが、`resolveTaskAgent` の本体は `assignee` が非 null ならそのまま返す(`src/tasks.ts:3889`)—— 人間が担当の task が pickup されないことに依る主張で、そこは読んでいない。
12. **`done` の後の運び。** merge back と休止位置は後始末(slot と session の回収済み観測)が駆動する。`completion_gate: "recorded_tip"` の印は pickup が開いた event にしか付かない。

## 4. 人間向けの回答の面が今運べるもの

- **入力の形**: `answers: string[]`(項目ごとに1つ、非空)、`comment?: string`、`amendment?: Record<string, unknown>`(`answerInputSchema` `src/human-verbs.ts:1128–1140`)。HTTP は `triage?: boolean` を足す(`src/api.ts:431`)。扉は `POST /api/tasks/:id/answer`(`src/api.ts:1494`)と管理 MCP の `answer_question`(`src/management-mcp.ts:1244`)で、どちらも `submitAnswer`(`src/human-verbs.ts:1148`)。
- **`question_kind`**(12 種、`src/question-kind.ts:6–30`)が持つ値: task id(`stop_reason` / `local_merge` / `pr_promotion_retry`)、`cancel_option`、分解判断の番号、破綻の理由、`pending_child`、PR 番号、`proposal`、quarantine の種類と値(workspace 名など)、期限。**sha も branch も無い。**
- **`amendment`** は提案の approve だけが受け、形は routing の行(tier / effort)、段の追加(name / description / position)、段の説明、Interview(hypothesis / measured_work / workspace / targets)、agent の tier(`to`)、memory(title / text / addressee ほか)(`src/human-verbs.ts:1168–1177`、`src/execution-setting.ts:632–775`、`src/memory.ts:1002`)。git の値を持つ形は無い。
- **#3158 の主張「sha やブランチを運ぶ回答は無い」は、構造を持つ欄については確認できた。** 補正が1つ: 選択肢に縛られるのは 8 種(`failure` / `premise_breach` / `broken_probe` / `approval` / `pr_merge` / `local_merge` / `pr_promotion_retry` / `proposal`)で、`escalation` / `quarantine` / `stop_reason` / `cli_auth_expiry_warning` は**自由文を受ける**(`isFixedChoiceQuestion` `src/tasks.ts:2036–2053`、`assertAnswerable` `:1969–2001`)。Quarantine の確認の項目は、種類の行が自分の項目を持たなければ「repaired by hand」1つ(`src/quarantine.ts:606–608`。workspace の行は自分の項目を持たない `:287–301`、自分の項目を持つ行は `:111`・`:121`・`:147`・`:340` にあり本文は読んでいない)だが、回答の文はそれに縛られない。workspace の Quarantine の本文自身が「Any answer text is kept as a repair note」「refs moved since the board last recorded them are accepted as correct」と書く(`src/quarantine.ts:297–299`)。回答と comment は event `question_answered` にそのまま残る(`src/tasks.ts:2155–2163`)。Quarantine の回答の文を読むコードは1か所で、Interview の対象の2種類の Quarantine で `answers[0]` が「do not measure this target」かを見る(`dropsRefusedTarget` `src/tasks.ts:755–757`、`src/human-verbs.ts:1323`)。それ以外は、検査に渡るのは `kind.value` だけである(`src/human-verbs.ts:1324–1328`)。つまり文字列として sha を書くことはできるが、それを git の値として読むコードは読んだ範囲に無い。
- **回答が刻む git の値は盤面が読んだもの**: `local_merge_executed` の `sha`、`local_merge_held` の `head`、`pr_merged`(`src/human-verbs.ts:1221–1236`、`:1314`)。
- **git の object id を受ける人間の verb / HTTP route**: 見つからなかった。確かめ方は、`src/api.ts` の route の一覧(`router.get/post/patch/delete` 全行)、入力 schema(`:206–368`、`:423–431` は全文、`:369–565` は欄名の列挙)、管理 MCP の全 tool 名と `inputSchema` の欄名の列挙。git に関わる入力は workspace の `path`(register)、`repo`(clone / publish)、task の `workspace`(名前)、`github_issue_number` だけで、PR 番号も回答の入力には無い(question の列が持つ)。registry の workspace entry の `branch`(`src/registry.ts:426`)は branch 名で、HTTP の作成・更新 schema には無い。

## #3158 と食い違う点・補う点

- 「別の git ディレクトリから commit を運ぶ仕組み(`fetchWorkerTip` など)は worker 専用」: **呼び手と入口は worker の session に限られるが、中の部品は一様ではない。** `fetchFromBoardCopy`・`boardRefWriter`・`recordedSettingsDisposition`・`treeDeltaEntries` は task も session も引数に取らない。task の checkout・`task/<id>` の名前・役を取るのは `readWorkerTip` / `withVerifiedWorkerTip` / `recordTaskCheckoutTip` / `completionTreePaths` である(§2)。
- 「worker の tip が完了の門を通るのと同じ形」: 門の形は「祖先を確かめて受け取る」ではない。旧値の CAS + 自分の1本の基準検査で ref を書き、**書いた後に**中身を検査して `done` を拒む(§1)。記録の ref に入ることと門を通ることは同じでない。
- 「回答は意図を運ばない(選択肢は repaired by hand の1つ)」: workspace の Quarantine の選択肢は1つだが、回答は自由文を受けて記録に残る。その文を git の値や意図として読むコードは読んだ範囲に無い(§4)。
- #3158 の行番号は `f7c172ed` / `c6ea7378` のもので、`25c84551` では門は `src/mcp.ts:333–407`、1本の検査は `src/workspace.ts:737–742`、比較器は `:1269`、全撮りは `:1203`。

## 読んだ範囲 / 読んでいない範囲

**読んだ**(`25c84551`):

- `src/mcp.ts:225–486`、`:560–900`、`:1905–1942`
- `src/workspace.ts:120–170`、`:340–745`、`:780–1070`、`:1090–1500`、`:1640–1880`
- `src/git.ts:1–339`、`src/sandbox.ts:585–642`、`src/tasks.ts:585–612`、`:1404–1484`、`:1969–2053`、`:2117–2163`(一部)
- `src/human-verbs.ts:600–724`、`:925–973`、`:1105–1334`、`src/question-kind.ts` 全文、`src/quarantine.ts:285–306`、`:585–615`、`src/tasks.ts:748–757`、`:3882–3892`
- `src/api.ts:200–368`、`:423–431`、`:1470–1562`、`src/teardown.ts:384–432`、`src/slot.ts:1–60`
- ADR 0359 全文、ADR 0356・0362・0363・0364・0367 の決定の節と Status 追記(0362 の Status 追記は各行の先頭 600 字まで)
- テスト: `tests/completion-commit-gate.test.ts` の test 名の一覧と `:165–188`、`:312–345`

**読んでいない**:

- pickup の停止の門・封じ込めの検査・spawn(`src/scheduler.ts` は `:593–651` の grep の行だけ、`src/claude-worker.ts` / `src/codex-worker.ts` / `src/harness-containment.ts`)
- 着地(`src/landing.ts` は `:420–436` だけ)、`mergeTaskToProtected` / `catchUpTaskBranch` の本体、`redoMergeBacks`、`src/workspace.ts:1880–2031`
- `submitAnswer` の `:1334–1449`(grep だけ)、`src/management-mcp.ts` の各 tool の本体(tool 名と欄名の列挙だけ)、`src/api.ts:369–565` の schema の本文、`src/workspace-create.ts`、`src/registry-write.ts`
- 人間が担当した task が pickup されるかどうか
- ADR 0084・0350・0351・0357・0360・0365・0369・0370、ADR 0356〜0367 の「退けた形」の一部
- `tests/worker-tip-copy.test.ts`・`tests/task-checkout.test.ts`・`tests/board-ref-gate.test.ts` の本文
- 実測は無い: `update-ref` の CAS が巻き戻し・無関係な commit を通すこと、merge-base が無いときの `diff-tree --merge-base` の exit は、コードとテスト名の読みである。
