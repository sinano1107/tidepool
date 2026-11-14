# map の決定が寄りかかる、読み直されていないコードの読みを確かめる(#3245)

- 問い: [#3245](https://github.com/sinano1107/tidepool/issues/3245)。地図は #3178。確かめる一覧の出所は #3236 の[訂正と記載漏れ 2](https://github.com/sinano1107/tidepool/issues/3236#issuecomment-6877685880)。
- 行番号は main `3e2447ac661d4faed682053d2f870ab123eeecf8`(`3e2447ac`)のもの。出所の ticket が書いた行番号(`25c84551` / `645a522b`)は引き直した。
- **走らせたのは `gh` / `git log` / `git grep` / `grep` / ファイルの読みだけ。** 盤面、test、素の git の fixture、VM、Pi はどれも走らせていない。下の判定は全部「読み」で、「測定」は1つも無い。
- 決め直さない。判定と、外れた点が触れる決定を並べるだけ。「触れる決定」の欄は私の読みで、決定ではない。
- 判定の語: **当たっていた** / **外れていた**(今のコードが何をするか)/ **読み切れなかった**(残りを書く)。1行に主張が複数あるものは枝番で分けた。

## 判定の一覧

| 行 | 確かめたこと | 判定 |
|---|---|---|
| 1a | 無人 merge は最後に push した sha と照合しない | 当たっていた |
| 1b | 同じ root が完了の門を2度通る経路は無い | 当たっていた |
| 2 | origin へ push された人間しか書けない path の変更を記録する event は無い | 当たっていた |
| 3a | 着地は pickup の event も task の checkout も読まない | 当たっていた |
| 3b | tip が fork 元と同じでも門は拒まない | 当たっていた |
| 3c | `HUMAN_ONLY_PATH` の読み手は完了の門1箇所 | 当たっていた |
| 4 | 予告中の行の先頭の値は、比較が最後に確かめた値(門の掛からない解放の畳みの後は当たらない) | 当たっていた(1値を書く書き手は5つで、限界が挙げた例外のほかに全撮りが2つある) |
| 5a | 「紐付けを読む機構は無い」 | 当たっていた(grep で閉じた範囲で) |
| 5a′ | その列挙は3点(完了時レビュー・着地の候補・handoff の欄) | 外れていた(漏れ: cancel が捨てる成果の一覧) |
| 5b | 人間担当の祖先を持つ系譜の経路の列挙 | 元の一覧が記録に無く照合できない。今の経路は列挙した(下)。結論「存在しない `task/<祖先>` に当たる」は当たっていた |
| 6a | H14 の検査の位置 | 対象外(#3245 のコメント、#3238 の決定) |
| 6b | 受理の順 | 外れていた(`25c84551` の後に2手増えた) |
| 6c | 削除の扉の呼び手 | 呼び手は1つ。扉の動作の読みは当たっていた(拒否は読みより2つ多い) |
| 7a | 解放の conflict は Quarantine に登録される | 当たっていた(`settleTaskCheckout` という関数は今は無い) |
| 7b | 受理の `places` は名前の場所1つで、Interview の root が読む実環境は入らない | 当たっていた |
| 8 | `submitAnswer` と管理 MCP の各 tool の本体に、sha や branch を運ぶ引数は無い | 当たっていた |
| 9a | 門の時点と後始末の時点で帰り先のブランチが食い違いうる | 当たっていた(構造の読み。起きることは走らせていない) |
| 9b | sandbox の中の merge の committer と hooks | 読み切れなかった(盤面が置く env までは読んだ。sandbox の中の挙動は読みでは決まらない) |

## 行1 — #3205 の限界(決定1・5・7)

### 1a 無人 merge は最後に push した sha と照合しない — 当たっていた

- 無人 merge の tick は GitHub の PR を読み(`src/landing.ts:1438`)、読んだ `head` を取り(`:1446`)、その head に固定して merge する(`:1485`、実装は `gh pr merge --match-head-commit <head>`、`src/github.ts:307–308`)。
- merge の前に head と比べるのは積み残しの述語だけ(`src/landing.ts:1462–1465`)。述語は「盤面が持つ内容が head に載っているか」の片方向で(`contentLeftBehind`、`:215–227`、`:239–243`)、doc comment が「head を candidate に置くので、盤面の外の push で先へ進んでいても積み残しと読まない」と書く(`:193–198`)。
- 盤面が最後に push した sha(`lastPushedHead`、`:259–267`)の読み手は2つ: 収束が開いている PR へ push するかを決める積み残し(`:1161`)と、外の push が内容を**落とした**ときの文(`outsidePushDropNotice`、`:280`)。どちらも「GitHub の head が最後に push した sha と同じか」は問わない。head に外から commit が**足された**形は、どの検査にも当たらずに merge される。
- 人間の `merge` 回答も同じ形(`src/human-verbs.ts:1270`・`:1280`・`:1316`)。
- `observePrHead`(`src/landing.ts:833–842`)は記録に無い head を `pr_head_observed` に刻むが、CI 未報告の猶予の起点で、照合ではない。

### 1b 同じ root が完了の門を2度通る経路は無い — 当たっていた

- `in_progress` に入る UPDATE は pickup の1つで、`status = 'todo'` を条件にする(`src/tasks.ts:1414`)。完了は `assertUnsettled` を通る(`:1495`)。したがって2度通るには `done` → `todo` が要る。
- `status` を書く UPDATE は `src/` に11本(`grep -n "SET status" src/*.ts`、全部 `src/tasks.ts`: `:1414`・`:1513`・`:1597`・`:1662`・`:1733`・`:2188`・`:2515`・`:2563`・`:2748`・`:3044`・`:3383`)。パラメータで status を渡す UPDATE は無い。
- `todo` に戻す6本は SQL に status の条件を持たないので、呼び手を全部読んだ:

| UPDATE | 関数 | 呼び手と、done に当たらない根拠 |
|---|---|---|
| `:1597` | `returnToQueue` | `src/watchdog.ts:190`・`:215`(`settleAndReclaim` `:326–349` → `unsettledSession` `:316–321` が、後始末の外で `in_progress` の session だけを返す)、`:674`(`recordDecision`、同じ門)、`src/teardown.ts:96`(`ready: status === "in_progress"`) |
| `:1662` | `escalateTask` | `src/mcp.ts:1103`(worker の verb)、`src/scheduler.ts:742`(`status !== "todo"` なら戻る)、`src/tasks.ts:1688`(`registerFailureQuestion`)、`:2518`、`:2904` |
| `:2515` | `declarePremiseBreach` | `src/mcp.ts:1126`(worker の verb) |
| `:2563` | `continueDecomposition` | `src/mcp.ts:1147`(worker の verb) |
| `:2748` | `poseProbe` | `src/mcp.ts:856`(worker の verb、Interview の root) |
| `:3383` | `decomposeTask` | `src/mcp.ts:818`、`src/tasks.ts:2586`(`redecompose` ← `src/mcp.ts:1170`)、`:3519`(`humanDecomposeTask`、`assertHumanDecomposable` の後) |

- `registerFailureQuestion` の呼び手: `src/workspace.ts:1915`(直前の `:1907` が done / cancelled で戻る)、`src/watchdog.ts:129`(`registerFailureAndMarkTeardown` ← `:471` は `unsettledSession` の後、`src/server.ts:430` は `status = 'in_progress'` の行、`src/mcp.ts:418` は門の中 = verb の前)、`:141`(直前の `:139` が `in_progress` でなければ拒む)、`:239`(`settleAndReclaim` の中)、`:354`(同)、`:520`(`onReclaimTimeout` が `unsettledSession` を読んだ後)、`:682`(`recordDecision`)。
- worker の verb は `resolveAttributedTask` を通り、後始末に入った session を拒む(`src/mcp.ts:301–307`)。完了の verb は `done` と後始末の印を同じ transaction で書き、直後に同期で `enterTeardown` する(`:471–481`)。
- PR の後に走るのは新しく登録される修理子(`src/triage.ts:395–427`、`parent_id: taskId` の新しい task)。
- 読んでいないもの: worker の verb 6本について「slot の task が後始末の外なら `in_progress`」は、上の2点からの導出で、slot の実装(`src/slot.ts`)は読んでいない。`assertHumanDecomposable` の本体は読んでいない(名前と `:3427–3440` の comment だけ)。

## 行2 — #3195 の限界(#3205 決定2)

**当たっていた。** 保護ブランチの写しを進める手 `fetchBranchCopy`(`src/registry.ts:709–722`)の呼び手は4箇所で、どれも event を書かない。

| 呼び手 | その関数が書くもの |
|---|---|
| `src/workspace.ts:336`(`firePickupPredicates` の `fire.fetch`) | 無し。呼び手は pickup の準備(`:1129`・`:1133`)と受理(`src/human-verbs.ts:638`) |
| `src/workspace.ts:1076`(`refreshProtectedBranch`) | 無し。呼び手は `src/landing.ts:1025`・`:1127`、`src/human-verbs.ts:710`、`src/workspace.ts:1996` |
| `src/workspace.ts:1680`(`settleBranches`) | 無し |
| `src/registry.ts:770`(`refreshRegistry`、registry の写し) | 無し(到達性を data で返す) |

- 口(`writeBoardRefs`、`src/workspace.ts:1343–1380`)が書くのは基準の行(`workspace_state.ref_snapshot`)だけで、`appendEvent` を呼ばない。基準は現在値で、old → new は残らない。
- event の種類を全部見た(`src/events.ts:158–771` の `kind:`)。sha を持つのは `decision_logged`(出題の head、`:195`)、`pr_opened` / `pr_branch_pushed` / `pr_head_observed`(PR の head = タスクブランチ、`:267–272`)、`local_merge_executed`(`:306`)、`pr_promotion_abandoned` / `local_merge_held`(タスクブランチの head、`:303`・`:308`)、`agent_tier_changed`(registry の commit、`:675`)。保護ブランチの写しの sha も、path も、どれも持たない。`nothing_to_land` の `base` は ref の名前(`src/landing.ts:1132–1133`)。
- `task_picked_up`(`src/events.ts:203`)と `task_checkout_opened`(`:222`)は fork 元の sha を持たない。
- 人間しか書けない path を読む関数 `humanOnlyPathChanges` の呼び手は完了の門だけ(行3c)なので、引いた内容の path を読む箇所も無い。
- 補足(主張の外): PR の head への外の push は `pr_head_observed` に sha だけ残る(`src/landing.ts:833–842`、書くのは無人 merge の tick `:1445`・`:1502` と人間の `merge` 回答 `src/human-verbs.ts:1276`)。path は残らない。
- 読んでいないもの: `refreshRegistry` の呼び手(registry は #3238 で workspace でなくなる前提なので追っていない)。

## 行3 — #3214 の限界(決定1・13)

### 3a 着地は pickup の event も task の checkout も読まない — 当たっていた

- `src/landing.ts` が `latestEventOfTask` で読む種類は `local_merge_executed`・`local_merge_held`(`:171–172`)、`pr_promotion_abandoned`(`:178`)、`landing_finished`・`auto_merge_withdrawn`(`:419–420`)、`landing_deferred`(`:861`)。SQL で読むのは `pr_opened` / `pr_branch_pushed`(`:181`・`:263`)、`pr_merged` と観測の2種(`:345`)、着地の終わりの2種(`:424`)。`task_picked_up`・`task_checkout_*`・`worker_spawned` は `grep` で0件。
- `src/landing.ts` が `./workspace.js` から取り込む関数(`:42–61`)に、task の checkout の在り処を引くもの(`taskCheckoutPath`・`taskRunPlace*`)は無い。取り込む git の読み書き(`branchMergeEffect` `src/workspace.ts:824–839`、`catchUpTaskBranch` `:2047–2061`、`taskBranchTip` `:843–845`、`resolveTaskBranchLineage` `:875–913`、`refreshProtectedBranch` `:1073–1077`、`fetchCommitIfMissing` `:1081–1088`)はどれも名前の場所の path だけを読む。
- 権限の読みは task の `assignee` 列から(`src/landing.ts:874–886`)で、pickup の event からではない。
- 着地が読む session の事実は「後始末が未了の行があるか」の列 `teardown_started_at` だけ(`:514–518`)。
- purely-local の着地の執行(`src/human-verbs.ts:1206–1239` → `mergeTaskToProtected`、`src/workspace.ts:2084–2104`)も名前の場所の ref と基準だけを読む。
- 読んでいないもの: `src/landing.ts:680–1000`(merge question の決着・`retire`・`failed` などの補助)は `grep` の0件で確かめただけで、通読していない。`src/tasks.ts` の `landingSurface`・`recordPrOpened`・`registerMergeQuestion` の本体は読んでいない(`src/tasks.ts` で `task_picked_up` / `task_checkout_*` を読む行は `:586–651`・`:3210`・`:3666` で、この3関数の位置 `:2985`・`:3091`・`:3145` ではない、という行番号の照合まで)。

### 3b tip が fork 元と同じでも門は拒まない — 当たっていた

- 門(`src/mcp.ts:333–407`)の拒否は、tip を記録に書けない(`:352–360`)、`.claude` が tree でない(`:364–371`)、人間しか書けない path の delta(`:375–383`)、gitlink の delta(`:385–392`)、未 commit(`:393–406`)。「変更が無い」を拒む枝は無い。
- tip を書く手は、名前の場所の今の値と同じなら書かずに返す(`src/workspace.ts:748` の `if (old !== tip)`)。fork 元と同じ tip は delta が空になる(`treeDeltaEntries`、`src/sandbox.ts:635–637`)。
- verb の本体(`completeTask` `src/tasks.ts:1456–1481`、`finishTask` `:1485–1540` 付近)が確かめるのは、未決着・handoff の全欄・未完了の子で、内容の有無は見ない。
- 根ならその後、着地が `nothing_to_land` を刻む(`src/landing.ts:1128–1135`)。

### 3c `HUMAN_ONLY_PATH` の読み手は完了の門1箇所 — 当たっていた

- 正規表現の定義は `src/sandbox.ts:630`、読むのは同じ file の `humanOnlyPathChanges`(`:640–642`)だけ。
- `humanOnlyPathChanges` の呼び手(`grep -rn "HUMAN_ONLY\|humanOnly" src scripts webui broker tests e2e`): `src/` では `src/mcp.ts:376` の1箇所。ほかは test(`tests/sandbox-settings.test.ts:424`、`tests/completion-commit-gate.test.ts` の補助関数)。

## 行4 — #3196 の限界(決定3)

**当たっていた。** 限界が書いた2箇所と例外は今も同じ形。ただし「行を1値に畳むのは比較と口の畳みだけ」は、1値を**書く**書き手を全部数えると5つになる。

基準の行(`workspace_state.ref_snapshot`)の書き手(`grep -rn "workspace_state\|updateBaseline(\|writeSnapshot(" src`):

| 書き手 | 何を入れるか |
|---|---|
| 最初の pickup の全撮り(`prepareRefBaseline` → `snapshotRefs`、`src/workspace.ts:1187–1198`) | その時点の全 ref(比べない) |
| 受理の全撮り(`retakeRefBaselines`、`:1212–1218`、呼び手は `src/human-verbs.ts:674`) | その時点の全 ref(比べない) |
| 比較の畳み(`compareAndFoldBaseline`、`:1293–1294`) | 予告中の行を、ref が今持つ値へ。直前に `baselineAllows` がその値を予告のどれかと一致と読んでいる(`:1281–1283`) |
| 口の畳み(`writeBoardRefs`、`:1363–1366`) | 読み返しが新しい値なら新しい値、違えば予告の前の行の値(`before`) |
| 門の掛からない解放(`:1718–1721`) | タスクブランチの行を読み返した値(比べない) |

- 予告は、行の今の値の後ろに `|<new>` を足す(`:1352–1356`)。先頭の値は「予告の前に行が持っていた値」で、その出所は上の5つのどれか。
- 落ちて残った予告中の行に、別の値の予告が重なると3値になる(`:1356`: 候補が2値以上で新しい値を含まなければ `${previous}|${newValue}`)。先頭は変わらない。
- 門の掛からない解放の例外は今も当たる。退避の土台は ref の今の値を比べずに読み(`:1832`)、比較はタスクブランチを除外し(`:1717` の `gated || released ? [] : [taskRef]`)、行は読み返した値で書く(`:1720`)。`15d85be5` が足した確かめ(`:1864`・`:1868`)は「読んでから書くまでに動いていないか」で、基準との突き合わせではない。
- `25c84551` の後に基準の書き手は増えていない(`compareAndFoldBaseline` の呼び手は `:1190` と `:1717` の2つ。ADR 0370 の「着地が比べる」は `src/` に無い)。
- 作成の予告は `|<sha>` で、先頭は空文字(`:1238–1239` の comment、`:1352`)。空の値の行は保存時に落とす(`:1309`)。

## 行5 — #3207 の限界(決定1・2)

「紐付け」を、ここでは「人間担当の work と、その内容(commit)の対応」と読んだ(決定2 の文から)。この読みが違えば判定は当たらない。

### 5a 紐付けを読む機構は無い — 当たっていた(grep で閉じた範囲)

人間であることを見分ける箇所を `grep -rn "HUMAN_ACTOR_ID\|humanWorkerId\|humanActorId\|'human'\|\"human\"" src` で全部出し、event の名義にするだけの行を除いて読んだ。task の担当・実行者が人間かで枝を分ける箇所は次のとおりで、**git や commit を読むものは1つも無い**:

| 箇所 | 何をするか |
|---|---|
| `src/db.ts:175` | 人間担当の行は `in_progress` になれない(CHECK) |
| `src/tasks.ts:1414`、`:4749`、`:4367` | pickup・次の slot の候補・キューの表示から外す |
| `src/tasks.ts:1478`・`:1496` | handoff の全欄の免除(限界の3点の1つ) |
| `src/webui-rules.ts:49` | 完了時レビューを立てない(同) |
| `src/landing.ts:437` | 着地の候補から外す(同) |
| `src/human-verbs.ts:965`、`src/api.ts:1582` | 人間の完了の扉は人間担当だけ |
| `src/tasks.ts:1949–1959`(`cancelDiscards`) | **cancel が捨てる成果の一覧から、人間が完了した done の work を外す**(`task_completed` の名義が人間かを event で読む) |
| `src/tasks.ts:3202–3210`(`reviewedTaskExecutor` / `executionEvent`)→ `src/board-prose.ts:184`、`src/tasks.ts:3224`・`:489` | 被レビュー task の実行者を `task_completed` / `task_picked_up` の名義から引く(人間が完了した task なら人間になる) |
| `src/tasks.ts:4396`、`src/push.ts:113` | 人間の task の一覧、通知 |
| `src/assignee.ts:18`、`src/human-verbs.ts:279`、`src/server-options.ts:679`、`src/triage.ts:398` | 担当・reviewer の名前の検査、選択肢、question への修理子の担当 |
| `src/retrospective.ts:655`・`:984`・`:1147` | 停止の RCA で、人間が走らせた session を外す |

### 5a′ 列挙は3点 — 外れていた(漏れ1件)

- 限界は列挙を「完了時レビュー・着地の候補・handoff の欄の3点まで」と書いた。上の表のうち、**人間担当(人間が完了した)work は盤面のブランチに内容を持たない、という前提に立つ箇所**として、3点のほかに `cancelDiscards`(`src/tasks.ts:1945–1960`)がある。doc comment は「成果が捨てられる done の work —— agent が実行したもの(Executor が人間でない)だけ」と書く(ADR 0271 決定4)。読み手は `directCancelDiscards`(`src/tasks.ts:1964`)の呼び手: 管理 MCP の `list_board` / `get_task` / `cancel_task`(`src/management-mcp.ts:354`・`:372`・`:446`・`:1034`)と HTTP の task の表示(`src/api.ts:2257`)。
- pickup の3箇所(ブランチを作るのは pickup の準備だけ `src/workspace.ts:1136`、pickup は人間を除く `src/tasks.ts:1414`、pickup 済みの task の担当は変えられない `:3666`)は #3207 の「訂正した前提」が既に挙げていて、今も同じ。
- 読んでいないもの: `webui/src`(ブラウザ側)。`directCancelDiscards` の本体(`src/tasks.ts:1964–`)は読んでいない(呼び手の行と `cancelDiscards` の本体だけ)。`src/memory.ts` の出所の読み(#3214 の訂正が挙げた `:2346`)は引き直していない。

### 5b 人間担当の祖先を持つ系譜の経路 — 元の一覧は記録に無い

#3207 のコメントは sub-agent の一覧そのものを載せていないので、項目ごとの照合はできない。今の main で系譜を解く経路を全部挙げる(`grep -rn "resolveTaskBranchLineage(\|lineageTaskBranch(\|taskForkSource(\|landingRootOf(\|undeliveredMergeBacks(\|closedRootOf(" src`):

| 経路 | 場所 |
|---|---|
| pickup がタスクブランチを切る | `createTaskBranch` → `taskForkSource`、`src/workspace.ts:987–992`・`:980–984`、呼び手 `:1136` |
| 完了の門の delta の base | `src/mcp.ts:375` |
| 後始末の merge back の帰り先 | `src/workspace.ts:1682` |
| 受理の merge back のやり直し | `undeliveredMergeBacks`、`:1971` |
| 着地の根の導出 | `landingRootOf`、`src/landing.ts:465`(呼び手 `:144`・`:1298`) |
| 閉じた根に塞がれた子 | `closedRootOf`、`src/landing.ts:368`(呼び手 `src/scheduler.ts:954`、`src/api.ts:756`、`src/human-verbs.ts:867`、`src/management-mcp.ts:352`、`src/landing.ts:966`) |

- 系譜の関数(`resolveTaskBranchLineage`、`src/workspace.ts:875–913`)は担当を読まない。未決着の work の祖先は、ブランチの有無を確かめずに候補になる(`:904–906`)。決着済みの祖先は `branchMergeEffect` に渡る(`:908`)。ブランチの有無を確かめるのは読みだけの type の枝(`:885`)と `undeliveredMergeBacks` が運ぶ側を見る行(`:1970`)だけ。
- したがって、ブランチを持たない人間担当の祖先の下の work は、pickup で `rev-parse task/<祖先>^{commit}`(`:983`)が落ち、`prepareWorkspaceAtPickup` の catch が名前の場所を Quarantine に落とす(`src/scheduler.ts:651–661`)。#3207 の「存在しない `task/<祖先>` に当たって workspace の Quarantine に落ちる」と同じ形 —— 読みで、走らせていない。
- 読んでいないもの: 決着済みの人間担当の祖先で `branchMergeEffect` が存在しない ref にどう落ちるか(`git rev-list --count` の失敗が各呼び手でどの出口になるか)は、`landingRootOf` の catch(`src/landing.ts:467–469`)と `closedRootOf` の catch(`:377–379`)を見ただけで、受理の `undeliveredMergeBacks` と後始末の側は追っていない。

## 行6 — #3183 の限界(決定10・12・13)

### 6a H14 の検査の位置 — 対象外

#3245 の[コメント](https://github.com/sinano1107/tidepool/issues/3238#issuecomment-6877944162)が外した。参考: 今の検査は `guardRegistryDefaultBranch`(`src/workspace.ts:1572–1595`)で、呼び手は `src/claude-worker.ts:1566` の1箇所。

### 6b 受理の順 — 外れていた(後の commit で2手増えた)

読みは「前半 → clean → session の検査 → 後半 → `redoMergeBacks` → 全撮り、比較は無い」(#3185 が `25c84551` の `src/human-verbs.ts:628–668` を読んだもの)。今の workspace の受理(`src/human-verbs.ts:630–675`):

1. workspace を引く(`:631`)
2. 前半の項(`:650`)
3. clean と盤面の state path との overlap(`:654–660`。面接室で repo が無ければ飛ばす)
4. その名前を開いている session・後始末の検査(`:662–665`)
5. 後半の項(fetch・park、`:666`)
6. **済まなかった解放の「運ぶ」のやり直し**(`redoOwedReleases`、`:668`)—— `47d94144` が足した
7. merge back のやり直し(`:669`)
8. **運び終えた task の checkout の削除**(`removeReleasedTaskCheckoutsOn`、`:671`)—— `c1cfb48e` が足した
9. 全撮り(`:673–674`)

比較が無いことは今も同じ(受理の中に `compareAndFoldBaseline` の呼び出しは無い)。

### 6c 削除の扉の呼び手 — 1つ

- `deleteWorkspace`(`src/workspace-create.ts:400–437`)の呼び手は `src/server-options.ts:723` の束ね(`workspaceAdmin.delete`)だけで、それを呼ぶのは HTTP の `DELETE /api/workspaces/:name`(`src/api.ts:1162–1200`、`:1175`)の1箇所。管理 MCP に削除の tool は無い(`create_workspace`・`list_workspaces`・`update_workspace`・`publish_workspace` の4つ、`src/management-mcp.ts:466–570`)。
- 扉の動作の読み(registry の行と基準の行を消し、未決着・着地待ち・既定 workspace を拒む)は当たっていた: `:413–419`、`:424–435`(`dropWorkspaceState` は `src/workspace.ts:1222–1227` で基準と sparse の pin の行を消す)。読みに無かった拒否が2つある: 盤面自身の registry clone(`src/workspace-create.ts:409–411`)と、`confirm` の無い要求(`:420`)。
- 読んでいないもの: `public/` と `webui/` の側でこの route を呼ぶ箇所。

## 行7 — #3185 の限界(決定2・4・15)

### 7a 解放の conflict は Quarantine に登録される — 当たっていた

- conflict は `mergeBackInto` が投げる(`src/workspace.ts:1944–1949`)。呼ぶのは `settleBranches`(`:1683`)、それを呼ぶのは `releaseTaskCheckout` の try(`:1725`)で、catch が `quarantineWorkspace` を呼ぶ(`:1726–1728`)。
- 読みが書いた `settleTaskCheckout` は今は無い。`14051b57` が `bringTaskCheckout`(`:1782–1887`)に分け、catch は `releaseTaskCheckout` の本体に移った(`25c84551` では `src/workspace.ts:1700`・`:1728` にあった)。
- 「運ぶ」段の失敗も同じ Quarantine に落ちる(`:1706–1711`)。conflict の後、解放済みの刻みがあれば task の checkout は消される(`:1730`)。

### 7b 受理の `places` は名前の場所1つ — 当たっていた

- `places` は「後半の項が撃った場所」(`src/human-verbs.ts:673`)。項は `namePickupPredicates` が返す `own` と `openers`(`:634–635`)。
- 実環境の名前では `own` が `checkoutPickupPredicates(place)`、`openers` は空(`src/pickup-predicates.ts:229`)。後半の項2つは同じ `place` を持つ(`:76–103`)。
- 面接室の名前では `own` が `roomPickupPredicates`(後半の項の場所は面接室、`:246`・`:256`)、`openers` は `taskRoomPickupPredicates` で前半の項だけ(`:138–156`)。Interview の root が読む実環境を場所に持つ項は、どちらの枝にも無い。

## 行8 — #3180 の限界(#3182 決定1 の前提)

**当たっていた。**

- `submitAnswer` を全文読んだ(`src/human-verbs.ts:1155–1456`)。引数は `answers: string[]`・`comment`・`amendment` と盤面側の値だけ(`:1155–1164`)。本体が使う git の値は全部盤面が自分で引く: ローカル着地のブランチ名は question が持つ task id から(`:1216`)、PR の head は GitHub から(`:1270`)、hold の head は名前の場所から(`:1242`)。Quarantine の検査に渡るのは question が持つ `kind.value`(`:1333`)で、回答の文は `dropsRefusedTarget` の判定にだけ使う(`:1330`)。
- `amendment` を受けるのは提案の approve だけ(`:1176–1184`)。種別ごとの欄は、routing の行(tier / effort)、段の追加、段の説明、Interview(hypothesis・measured_work・workspace・targets)、agent の tier(`to`)、memory(title・text・addressee・原文・annotations)—— `src/execution-setting.ts:632–772` と `src/memory.ts:993–1005` の schema の行を見た。sha・branch・ref の欄は無い。
- 回答の入力 schema は `answers`・`comment`・`amendment`(`src/human-verbs.ts:1135–1147`)。HTTP はこれに `triage` を足す(`src/api.ts:431`)。
- 管理 MCP の tool 49本の handler を全部読んだ(`src/management-mcp.ts:360–1281`)。git に関わる入力は `create_workspace` の `path` / `repo`(`:190–204`)、`publish_workspace` の `repo`(`:550–559`)、各 tool の `workspace` の名前、`github_issue_number` だけ。`update_workspace` は保護ブランチの名前(`branch`)も受けない(`:525–537`)。file 全体で `sha`・`ref`・`oid`・`head`・`tip` の語は0件、`branch` は memory の枝の意味だけ、`commit` は説明文だけ(`grep -n -i`)。
- 読んでいないもの: `answerQuestion` の本体(`src/tasks.ts:2161–`、署名だけ)。`amendment` の parser は schema の行だけで、本体の全文は読んでいない。`src/api.ts` の route 全部(語の `grep` で `sha`・`branch`(git の意味)・`refs/`・`oid` が0件、までは確かめた)。tool の handler が呼ぶ先の関数(`cancelThroughHumanDoor`・`registerThroughHumanDoor`・memory の各関数など)の本体。

## 行9 — #3188 の限界(#3214 決定7、#3189)

### 9a 門の時点と後始末の時点で帰り先が食い違いうる — 当たっていた(構造の読み)

- 門は fork 元を `taskForkSource` で導く(`src/mcp.ts:375` → `src/workspace.ts:980–984`)。門の中に fetch は無い(`src/mcp.ts:333–407`)。
- 後始末は、帰り先を導く**前に**保護ブランチの写しを origin から進める(`settleBranches`、`src/workspace.ts:1680` → `:1682`)。
- 系譜は、決着済みの祖先のブランチを保護ブランチの参照と内容で比べて、候補にするかを決める(`:903`・`:908–910`)。remote-backed ではその参照が写し `refs/remotes/origin/<branch>`(`src/pickup-predicates.ts:48–51`)。
- したがって、門と後始末の間に origin の保護ブランチが進み、決着済みの祖先のブランチの内容がそこに入った場合、門は `task/<祖先>` を fork 元に読み、後始末は帰り先を「無し(保護ブランチが底)」に読む。その場合 merge back は撃たれず(`:1683` の `if (target)`)、その work は自分が着地の根になる(`src/landing.ts:465–466`)。
- これは読みからの導出で、盤面がその順に達することは走らせていない。逆向き(無し → `task/<祖先>`)は origin の履歴の書き換えが要る、というのは推論。

### 9b sandbox の中の merge の committer と hooks — 読み切れなかった

読めたのは、盤面が worker に置く設定まで:

- worker の env は名指しで組み、`GIT_CONFIG_GLOBAL=/dev/null` と `GIT_CONFIG_NOSYSTEM=1` を置く(`src/worker.ts:20–27`)。
- author と committer は agent の名前に固定する4つの env(`agentGitIdentityEnv`、`src/claude-worker.ts:730–738`)。Claude は `:2095–2098`(`:2097`)、Codex は `src/codex-worker.ts:1443` で載せる。
- worker の env に `core.hooksPath` は無い。Claude の worker が持つ `GIT_CONFIG_*` は sparse の1項目だけ(`src/claude-worker.ts:690–692`)。hooks を `/dev/null` にするのは盤面自身の git の env(`src/git.ts:262–283`)。
- task の checkout は `git init --template=` で作る(`src/workspace.ts:457`)ので、template の hooks は入らない。work の sandbox は checkout 全体を書き込み可にし、拒むのは settings の path だけ(`src/sandbox.ts:455–458`、`:206–208`)。`.git/hooks` は「CLI 自身の既定の保護が拒む」と comment が書く(`src/sandbox.ts:415–416`)が、comment の読みで、確かめていない。
- 門は tip の committer も author も読まない(`src/mcp.ts:333–407`)。盤面は worker の `.git` を repo として開かない(`src/workspace.ts:586–611`・`:647–678` は file の読みと、盤面所有の写しの上の git)。

残り(読みでは決まらない):

- sandbox の中で worker が撃つ `git merge <sha>` の commit が、実際にその env の名義になるか(worker は自分の shell で env を上書きできる)。
- worker が checkout の `.git/hooks` に置いた hook が、worker 自身の `git merge` / `git commit` で走るか(Claude の CLI の既定の保護、Codex の sandbox の書き込み規則)。Codex の sandbox の書き込み範囲(`src/codex-worker.ts` の該当部分)は読んでいない。

## 外れていた行が触れる決定(私の読み)

| 行 | 触れる決定 | 覆すか |
|---|---|---|
| 5a′ | #3207 決定1 の「上書きするもの」の一覧。#3214 決定12(cancel)にも掛かる | 覆さない。一覧に `cancelDiscards`(ADR 0271 決定4 の「Executor が人間でない」)が足りない。人間担当の work が `task/<H>` に内容を持つようになると、cancel が捨てる成果の一覧から人間の成果が外れたままになる —— spec へ渡す項目 |
| 6b | #3185 決定15(受理の順)。#3183 決定10・12・13 には当たらない | 覆さない。決定15 の 9(「運ぶ」のやり直し)は実装済みになった。決定15 の順に「運び終えた checkout の削除」(今は merge back の後・全撮りの前)の位置が書かれていない —— 文面だけ |

## 読んだ範囲 / 読んでいない範囲

読んだ(全文または該当の関数の全文):

- `src/workspace.ts:300–780`・`:856–2104`、`src/mcp.ts:290–486`、`src/sandbox.ts:404–462`・`:595–642`、`src/pickup-predicates.ts:35–432`、`src/landing.ts:120–680`・`:1000–1535`、`src/human-verbs.ts:575–1456`、`src/management-mcp.ts:186–275`・`:340–1287`、`src/workspace-create.ts:384–437`、`src/registry.ts:695–782`、`src/teardown.ts:70–110`・`:380–432`、`src/watchdog.ts:108–250`・`:318–360`・`:436–530`・`:630–692`、`src/scheduler.ts:628–664`・`:722–748`、`src/server.ts:405–440`、`src/worker.ts:1–45`、`src/claude-worker.ts:650–745`・`:2088–2100`、`src/codex-worker.ts:1418–1450`、`src/git.ts:258–284`、`src/api.ts:1160–1200`、`src/triage.ts:395–432`、`src/webui-rules.ts:38–52`。
- `src/tasks.ts` は該当の関数だけ: `:1408–1418`・`:1436–1530`・`:1560–1600`・`:1630–1700`・`:1936–1960`・`:2480–2566`・`:2715–2750`・`:2885–2912`・`:3200–3235`・`:3350–3386`・`:3421–3440`・`:3505–3525`・`:3658–3672`・`:4360–4398`・`:4738–4752`・`:2013–2043`。
- `src/events.ts` は `kind:` の行だけ(payload の型の全文ではない)。
- 出所の ticket(#3205・#3195・#3214・#3196・#3207・#3183・#3185・#3180・#3188)の resolution と訂正コメント、#3182 は該当行だけ。

読んでいない:

- 盤面・test・fixture の実行(全部)。test の本文。ADR の本文(コードの comment が引く番号を写しただけ)。
- `src/slot.ts`、`src/quarantine.ts`、`src/board-state.ts`、`src/github-auth.ts`、`src/codex-worker.ts` の sandbox の部分、`src/claude-worker.ts` の上記以外、`src/landing.ts:680–1000` の通読、`src/tasks.ts` の上記以外、`src/api.ts` の上記以外、`webui/`・`public/`。
- 出所の research の branch の全文(`research/3180-*`・`research/3188-*`・`research/3195-*`)。sub-agent の元の出力(記録に無い)。
