# remote-backed で origin へ push した人間しか書けない path は、受理なしに次の pickup の fork 元に入るか(#3195)

- 問い: [#3195](https://github.com/sinano1107/tidepool/issues/3195)。地図は #3178、訂正の出どころは #3181 / #3184、delta の先行の測定は #3188(`research/3188-catch-up-at-completion-gate`)。
- 行番号は main `25c845515dd750edbbad43d15580323b41676a5d`(`25c84551`)のもの。
- 各主張に **測定**(下の合成 fixture で走らせた)、**読み**(その code / test / ADR を読んだ。走らせていない)、**推論**(読みと測定からの導出で、その経路自体は読み切っても走らせてもいない)を付ける。
- 設計の推奨は書かない。成り立つことと欠けているものを並べる。

## 答え

**入る。question も受理も Quarantine も無しに、次に保護ブランチから fork する task の fork 元になる。**
人間が自前の clone から origin の保護ブランチへ fast-forward で push した変更は、次の pickup の後半で盤面が口を通して写し(`refs/remotes/origin/<保護ブランチ>`)に引き、同じ pickup が切るタスクブランチの fork 元になる。盤面はこの経路で path を1つも見ない。既に fork 済みの task の完了の門の delta にその path は出ず、着地でも片側だけの変更なので conflict しない。remote-backed の H19 に足す扉は、この読みと測定の範囲では要らない。欠けているのは扉ではなく、(a) 入ったことを残す記録、(b) 例外3つ(名前の場所から push した場合・origin の履歴を書き換えた場合・門を通らずに task 側がその path を変えた場合)の文面と出口、(c) 「人間しか書けない」を remote-backed で支えているのが origin 側の権限だけだという前提の明記。

## 走らせたもの

- `gh issue view`、`grep`、ファイルの読み。
- **合成 fixture 1本**(素の git 2.47.0、この Mac、scratchpad の使い捨て repo。bare の origin 役 `O`、名前の場所役 `N`、人間の自前の clone 役 `H`)。script は末尾の付録。
- **走らせていないもの**: 盤面の関数、test suite(この worktree に `node_modules` が無い)、Lima VM、Pi、GitHub。fixture は盤面のコードが綴る git コマンドを素の git で写したもので、盤面の測定ではない。特に盤面の fetch は checkout の外の盤面所有 repo を経由する 2 hop(ADR 0339 決定5、`src/registry.ts:699–704`)で、fixture の `git fetch origin <sha>` とは経路が違う。

| # | 測ったもの | 結果 |
|---|---|---|
| A1 | 人間が `H` から origin へ push した直後の `N` の `for-each-ref` | push の前と同一 |
| A2 | `N` で `ls-remote origin refs/heads/main` | 人間の commit M1 |
| A3 | `N` で `fetch origin <sha>` の後の `for-each-ref` | fetch の前と同一(`refs/` に書かない) |
| A4 | `update-ref refs/remotes/origin/main <sha>` の後に変わった行 | `refs/remotes/origin/main` と `refs/remotes/origin/HEAD`(後者は解決値で出したため。盤面の基準は symref を指し先で数える —— ADR 0081、`src/workspace.ts:1142–1149`) |
| A5 | local `main` が `origin/main` の祖先か | yes(休止位置の ff の枝) |
| A6 | `update-ref refs/heads/task/T2 origin/main^{commit} ""` で切った T2 の `.claude/settings.json` | 人間の値 `{"v":1}` |
| B1 | push の**前**に M0 から fork し `a.txt` だけ変えた T1 を、進んだ `origin/main`(M1)と `diff-tree -r --raw --merge-base` | `M a.txt` だけ |
| B2 | そのときの merge-base | M0 |
| C1 | M1 から fork した T2 の tip を、M1 を持たない ref(M0)と `--merge-base` で比べる | `M .claude/settings.json; A b.txt` |
| C2 | origin の保護ブランチを M1 を含まない履歴に force-push し、その sha と T2 の tip を比べる | `M .claude/settings.json; A b.txt`。local `main` と書き換え後の sha は互いに祖先でない |
| C3 | 人間が M1 の上に revert(M2)を push し、M2 と T2 の tip を比べる | `A b.txt` だけ |
| D1 | T1 の tip と M1 の `merge-tree --write-tree` | clean |
| D2 | その merge commit の `.claude/settings.json` と、M1 との delta | 人間の値 `{"v":1}`、delta は `M a.txt` だけ |
| D3 | task 側も `.claude/settings.json` を変えた tip(M0 から fork)を M1 と比べる / merge する | delta に `M .claude/settings.json`、`merge-tree` は conflict(exit 1) |
| E1 | 人間が**名前の場所役で** commit して origin へ push した後に変わった行 | `refs/heads/main`、`refs/remotes/origin/main`(と解決値の `origin/HEAD`) |
| E2 | origin が進んだ後、人間が名前の場所役で素の `git fetch` だけをした後に変わった行 | `refs/remotes/origin/main`(と解決値の `origin/HEAD`) |

## 1. pickup が origin から保護ブランチを引く経路と、基準に入る位置

**語の訂正: pickup は `refreshProtectedBranch` を呼ばない。** `refreshProtectedBranch`(`src/workspace.ts:1068–1072`)の呼び手は着地(`src/landing.ts:1025`、`:1127`)、Claude の封じ込めの受理(`src/human-verbs.ts:703`)、Quarantine の受理の後(`src/workspace.ts:1923`)。pickup が撃つのは同じ `fetchBranchCopy` を呼ぶ別の入口で、pickup の述語の後半(after-open)の `fire.fetch`(`src/workspace.ts:327–332`)。#3181 の決定2 の「盤面が `refreshProtectedBranch` で引く」は、pickup については関数名が違う(引く手は同じ)。**読み**

pickup の準備 `prepareWorkspaceAtPickup`(`src/workspace.ts:1093–1133`)の順:

1. **基準の比較が先**(`:1104` → `prepareRefBaseline` `:1178–1181` → `compareAndFoldBaseline` `:1269–1287`、除外なし)。この時点で名前の場所の ref はまだ人間の push を知らない —— 人間が自前の clone から origin へ push しても名前の場所の ref は1本も動かない(**測定** A1)ので、比較は通る。**読み + 測定**
2. 休止中の未 commit の検査(`:1109–1114`)。
3. **後半の述語**(`:1127–1128`)。`afterOpenPredicates`(`src/pickup-predicates.ts:76–104`)の1つ目が `fire.fetch` → `fetchBranchCopy`(`src/registry.ts:709–722`): `ls-remote` で原本の sha を知り、口(`boardRefWriter` → `writeBoardRefs`、`src/workspace.ts:1334–1376`)が基準の `refs/remotes/origin/<保護ブランチ>` の行を `<old>|<new>` に予告し、sha で fetch し(`refs/` に書かない、**測定** A3)、`update-ref` で写しを書き、読み返して `new` に畳む(`:1354–1357`、`:1370`)。**ここが「引いた値が基準に入る位置」** —— 帯域外の移動ではなく盤面自身の書き込みとして基準に入るので、Quarantine にならない(ADR 0243 決定1〜3、ADR 0351 決定3)。**読み**
4. 2つ目の述語が `fire.park` → `parkOnProtectedBranch`(`src/workspace.ts:1447–1477`): local の保護ブランチが写しの祖先なら `advanceBranch`(`:944–951`)で ff。これも口を通り、HEAD が保護ブランチに乗っていれば名前の場所の worktree も追従する(`writeWithWorktree` `:954–972`)。**読み**
5. `createTaskBranch`(`:982–987`)が `taskForkSource`(`:975–979`)= `lineageTaskBranch(...) ?? exactProtectedBranchRef` を `rev-parse` して切る。remote-backed の `exactProtectedBranchRef` は写し(`src/pickup-predicates.ts:54–56`)。**読み**

この経路のどこにも tree や path を読む箇所は無い。`HUMAN_ONLY_PATH`(`src/sandbox.ts:630`)の使い手は `humanOnlyPathChanges`(`:640–642`)1つで、呼び手は完了の門(`src/mcp.ts:375–383`)だけ。**読み**(`grep` で `src/` の非 test を全件)

**test が釘にしていること(読んだだけ、走らせていない):**

- `tests/workspace-remote-fork.test.ts:24`・`:50` —— remote-backed のタスクブランチは remote 側の保護ブランチから切られ、盤面が pickup の直前に自分で fetch する。
- `tests/ref-baseline-continuity.test.ts:162` —— 休止中に remote の main だけが進めば次の pickup は通り、基準は fetch 先の1値を持つ。
- `tests/board-ref-gate.test.ts:349` —— pickup の fetch の後の基準の行。

どれも publish するのは `merged.txt` で、人間しか書けない path では測っていない。path に依らないことは上の「path を読む箇所が無い」の**読み**による。

**「次の pickup」の範囲。** fork 元が保護ブランチに解ける task だけ —— 未決着の work 祖先も、内容が保護ブランチに届いていない決着済みの work 祖先も持たない task(`resolveTaskBranchLineage`、`src/workspace.ts:870–908`)。系譜の子は `task/<親>` から fork するので、親のブランチがその変更を持つまで受け取らない。受験者は出題の head から fork する(`:976–977`)。**読み**

**Quarantine になる場合(この経路の例外):**

- **人間が名前の場所で commit して push した。** local の保護ブランチと写しが push で動く(**測定** E1)。次の pickup の比較(`:1181`)が `RefsMovedError` を投げ、workspace の Quarantine になる(`src/scheduler.ts:651–661`)。人間が名前の場所で `git fetch` しただけでも写しが動き(**測定** E2)、同じ比較に当たる。「origin 経由」は**自前の clone から**でなければ成り立たない。**読み + 測定**(Quarantine まで走らせてはいない)
- **origin の保護ブランチを non-ff に書き換えた(force-push)。** `fetchBranchCopy` は sha が何であれ写しに書く(祖先かを見ない、`src/registry.ts:709–722`)。その後の `parkOnProtectedBranch` が「the local and remote histories diverged」を投げ(`src/workspace.ts:1468`、**測定** C2 で互いに祖先でない)、`PickupGateError` として workspace の Quarantine になる(`src/scheduler.ts:658–663`)。写しは Quarantine の前に書き換え後の値になっている。**読み**
- **origin に届かない・token が出ない。** fetch の失敗として Quarantine(`tests/workspace-remote-quarantine.test.ts:45`・`:164`)。path に依らない既存の挙動。**読み**
- **名前の場所の worktree に、push された path と同じ untracked の file がある。** 休止中の未 commit の検査(`:1109`)か worktree の追従(`:959`)が止めるはずだが、どちらが先に何と言うかは読んでいない。**推論**

## 2. 既に fork 済みの task の完了の門の delta に出るか

**出ない。その worker は自分で書いていない変更で完了を拒まれない。**

- 門は `treeDeltaEntries(名前の場所, taskForkSource(...), tip)`(`src/mcp.ts:375`)で、`diff-tree -r --raw --merge-base <fork 元> <tip>`(`src/git.ts:206–209`、`src/sandbox.ts:635–637`)。fork 元は門のたびに引き直される関数の値(`src/workspace.ts:975–979`)で、保護ブランチから fork した task では写しの今の値。**読み**
- delta に path が出るのは **tip の entry が merge-base の entry と違うとき**だけ。push の前に fork した task の tip は M1 を祖先に持たないので merge-base は元の fork 点 M0 に留まり、tip はその path を M0 の値のまま持つ。**測定** B1・B2(#3184 が推論のまま残した点を、この場面の形で測った。#3188 の F6 と同じ結論)
- 写しが動くのは盤面の fetch(別の task の pickup、解放の `settleBranches` `:1677`、着地)だけなので、走っている task の門が「進んだ保護ブランチ」を読むことは普通に起きる。それでも delta は変わらない。**読み + 測定**
- 人間が後から revert を積んでも(M1 から fork した task、M2 = revert)、merge-base は M1 で delta に出ない。**測定** C3

**出る形(逆向き: tip がその変更を持ち、門が読む fork 元が持たない)。** **測定** C1 で、この形なら delta にその path が出て、worker は書いていない変更で「take the change out of the task branch」(`src/mcp.ts:378–382`)と拒まれる。盤面がこの形に到達する道:

- **origin の保護ブランチの履歴の書き換え。** M1 から fork した task が走っている間に、人間が M1 を含まない履歴を force-push し、盤面のどれかの fetch が写しを書き換え後の値にする(上の 1 のとおり `fetchBranchCopy` は祖先を見ない。`refreshProtectedBranch` は fetch だけで休止位置の ff を撃たない(`src/workspace.ts:1068–1072`)。pickup と解放 `settleBranches`(`:1677`・`:1681`)は fetch の後に休止位置の ff を撃って投げるが、どちらも写しを書いた後)。その task の門は書き換え後の写しと比べ、delta に人間の変更が出る(**測定** C2)。git の挙動は測定、盤面がこの順で門に達することは**推論**(走らせていない)。保護ブランチの force-push 自体が稀で、次の pickup は休止位置の ff で Quarantine になる。解放の側で投げた後の行き先は読んでいない。
- **worker が merge の解決でその path を fork 元と違う値にした。** #3188 の F7。今日の worker は追いつかないので、起点は worker 自身の merge。
- **門の時点で fork 元が保護ブランチから祖先のブランチへ切り替わる。** `taskForkSource` は作成時の sha を覚えず、門のたびに `lineageTaskBranch` を引き直す。保護ブランチ(変更あり)から fork した task の門で、候補が変更を持たない祖先のブランチに替われば同じ形になる。決着済みの祖先のブランチに後から内容が着く順序が要る。**その順序が盤面で起きるかは辿り切っていない**(下の「読んでいない」)。

## 3. 着地でその path が conflict したときの出口

**門を通った tip はその path を fork 元から変えていないので、人間の push とは片側だけの変更になり、conflict しない。**(**測定** D1: clean。D2: 追いつきの merge は人間の値を取り、その後の delta にも出ない)

conflict するのは task 側もその path を変えているときだけ(**測定** D3)。門の外から task のブランチに内容が着く道は #3188 の 3 が並べている(人間の完了の扉、Quarantine の受理の `redoMergeBacks`、旧版の盤面で完了した task)。加えて、盤面が開く checkout で人間が task のブランチへ書く道(#3181 決定1)ができれば、そこが新しい入口になる。そのときの出口は、その path に限らない一般の conflict の出口と同じ:

| 場面 | 何が起きるか | 出口 |
|---|---|---|
| fork 元を outlive した根の追いつき(`catchUpTaskBranch`、`src/workspace.ts:1974–1988`。呼び手は `src/landing.ts:1169–1171`) | 「`<写し>` does not merge cleanly into 'task/…' — resolve it by hand, then retry PR promotion」を投げる | `failed(..., "promotion_failed")`(`src/landing.ts:1280`)が PR 昇格の失敗 question を立てる(`:942–953`)。「resolve it by hand」の場所は今は名前の場所(#3181 が置き換える指示の1つ) |
| 追いつかない根(fork 元を outlive していない)の PR が GitHub 上で conflict | 盤面は追いつかせない(`outlivedForkSource` のときだけ、`:1170`)。盤面は PR の mergeable を読まない(`readPullRequest` は `state,statusCheckRollup,headRefOid,mergedBy`、`src/github.ts:294`) | 無人 merge: CI が success なら `mergePullRequest` が失敗し、head が同じなら「could not merge PR #N: … Merge once it is fixed, or hold?」の question(`src/landing.ts:1485–1508`)。CI が報告されなければ猶予の後に CI 赤の question(`:1450–1461`)。人間の merge 回答: 失敗は `DomainError` で question は開いたまま(`src/human-verbs.ts:1306–1312`) |
| 系譜の子の merge back | 帰り先は親のブランチで、保護ブランチの変更は関わらない | この問いの外(#3188) |

- conflict する PR に GitHub が何を返すか(mergeable、check が走るか、merge API の文面)は**ここから測れない**。上の表の GitHub 側は盤面のコードの**読み**だけ。
- どの出口も「conflict している」「その path が人間しか書けない」を名指ししない。**読み**

## 4. remote-backed の H19 に扉を足す必要があるか

**この読みと測定の範囲では、足す必要は無い。origin 経由で足りる。** 人間が自前の clone から ff で push すれば、内容は次の保護ブランチ由来の pickup に届き(1)、走っている task を拒ませず(2)、着地でも当たらない(3)。扉(question・受理・盤面が開く checkout)が運ぶはずのものは、盤面の既存の fetch が運んでいる。

**確かになったこと**

- 入る位置は pickup の後半の `fetchBranchCopy`(口を通る盤面自身の書き込み)。Quarantine にならない。
- 完了の門の検査は、保護ブランチの進みに巻き込まれない(B1)。
- 片側だけの変更は clean に merge する(D1)。

**欠けているもの(扉ではない)**

1. **記録。** 人間しか書けない path が保護ブランチに入ったことを残す event も question も無い。この場面に question と受理が無いことは #3181 の訂正のとおり。event は**部分の読み**: `fetchBranchCopy` 自体は event を書かず(`src/registry.ts:709–722`)、`task_picked_up`(`src/events.ts:203`)と `task_checkout_opened`(`:222`)の payload は fork 元の sha を持たない。`fetchBranchCopy` の呼び手すべてと `openTaskCheckout` の中に event の書き込みが無いことまでは確かめていない。見つけた範囲で残るのは git の履歴(origin の commit の author)だけ。purely-local 側は #3184 の決定4 の「取り込む」(決定で、未実装)が盤面の回答として残る形なので、実装されれば2つのセルで記録の有無が割れる。
2. **「人間しか書けない」を支えるもの。** `fetchBranchCopy` は origin が持つ sha を何であれ取る。remote-backed でこの性質を支えるのは origin の保護ブランチへの書き込み権限と、worker の完了が門を通ること(門の外から task のブランチに内容が着く道は #3188 の 3 にある)と PR の review だけで、盤面は入ってくる側を検査しない。ADR 0362 は書き手の道を言わない(決定1)。worker の push の身元が保護ブランチへ直接届くかは読んでいない。**読み + 推論**
3. **例外の文面。** 名前の場所から push した人間は基準の違反の Quarantine に当たる(1、E1)。門の拒否文(`src/mcp.ts:378–382`)は worker に「取り除け」と言うだけで、人間に「自前の clone から origin へ push する」とは言わない。文面は #3191 の射程。**読み**
4. **履歴の書き換えの下の誤拒否。** 2 の逆向きの形。稀で、次の pickup は Quarantine になるが、走っている task の門は理由の合わない拒否文を返す。**推論**
5. **届く範囲。** 系譜の子と、既に fork 済みの task には届かない。Claude の worker の checkout からは `.claude/settings.json` / `.claude/settings.local.json` が sparse で外される(`src/workspace.ts:1034–1036`、`src/sandbox.ts:185`)ので、この2つは届く・届かないの差が出ない。`.mcp.json`、`.codex/config.toml`、`.codex/rules` が worker の checkout でどう扱われるか、それを走っている task に届けたい場面があるかは確かめていない。**読み**(2 path の分だけ)
6. **隠せない形の push。** 人間が `.claude` を symlink / blob / gitlink にして push すると、次の pickup の spawn が `unhideable-task-settings` で落ちる(`src/scheduler.ts:687`)。これは封じ込めの修理(H18)の側の話で、H19 の扉の有無には関わらない。**読み**(spawn の経路は辿っていない)

## 読んでいない・確かめていない

- 盤面の関数は1つも走らせていない。test も読んだだけ。
- 2 の「fork 元が保護ブランチから祖先のブランチへ切り替わる」順序が盤面で起きるか。`resolveTaskBranchLineage` と `branchMergeEffect`(`src/workspace.ts:819–834`)は読んだが、決着済みの祖先のブランチに後から内容が着く経路を file:line で1本通していない。欠陥としては報告しない。
- `authedFetch` の 2 hop の中身(`src/github-auth.ts`)。fixture の `git fetch origin <sha>` と同じく `refs/` に書かないことは `src/registry.ts:699–702` のコメントの読みだけ。
- `openTaskCheckout` の中身と、`.mcp.json` / `.codex/*` の worker 側の扱い。
- 解放の休止位置の ff が投げた後の行き先(Quarantine になるはずだが辿っていない)。
- GitHub 側(conflict する PR の mergeable、check、merge API、保護ブランチの ruleset)。
- worker の sandbox から origin への push が保護ブランチに届くか(身元と権限)。
- Codex の worker の fork 元の tree の読み方(`src/codex-worker.ts`)。
- Interview の面接室・受験者(保護ブランチは面接室のもので、origin 経由が当たらない)。
- purely-local。この問いの外(#3184 が決めた)。

## 付録: fixture の script

`bash fixture.sh <空の作業ディレクトリ>` で走る。

```bash
#!/bin/bash
# #3195 fixture: plain git only. O = origin (bare), N = named-place role (clone of O), H = the human's own clone.
# None of the board's functions run here; each step mirrors the git commands the board's code spells.
set -eu
ROOT="$1"; rm -rf "$ROOT"; mkdir -p "$ROOT"; cd "$ROOT"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=x GIT_AUTHOR_EMAIL=x@x GIT_COMMITTER_NAME=x GIT_COMMITTER_EMAIL=x@x
g() { git -c init.defaultBranch=main -c protocol.file.allow=always "$@"; }
delta() { g -C N diff-tree -r --raw --merge-base "$1" "$2" | awk '{print $5,$6}' | tr '\n' ';'; }
refs() { g -C N for-each-ref --format='%(objectname) %(refname)'; }
echo "git: $(git --version)"

g init -q --bare O
g clone -q O H 2>/dev/null
mkdir -p H/.claude
echo '{"v":0}' > H/.claude/settings.json; echo a0 > H/a.txt
g -C H add -A; g -C H commit -q -m M0; g -C H push -q origin HEAD:main
g clone -q O N
M0=$(g -C N rev-parse refs/remotes/origin/main)

# T1: a task forked before the human's push (createTaskBranch: update-ref refs/heads/task/T1 <fork source> "")
g -C N update-ref refs/heads/task/T1 "$M0" ""
T1=$(printf 'a1\n' | g -C N hash-object -w --stdin)
TREE=$(g -C N ls-tree "$M0" | sed "s/[0-9a-f]\{40\}\ta.txt/$T1\ta.txt/" | g -C N mktree)
TIP1=$(g -C N commit-tree "$TREE" -p "$M0" -m "T1 work")
g -C N update-ref refs/heads/task/T1 "$TIP1"

# The human pushes a human-only path change to origin's protected branch from their own clone.
echo '{"v":1}' > H/.claude/settings.json
g -C H commit -q -am "M1 human edits .claude/settings.json"; g -C H push -q origin HEAD:main
M1=$(g -C H rev-parse HEAD)

# --- A: the pull at pickup, spelled as fetchBranchCopy spells it (ls-remote -> fetch <sha> -> update-ref)
BEFORE=$(refs)
echo "A1 named place refs unchanged by the human's push to origin: $([ "$(refs)" = "$BEFORE" ] && echo yes || echo no)"
SHA=$(g -C N ls-remote origin refs/heads/main | cut -f1)
echo "A2 ls-remote sees M1: $([ "$SHA" = "$M1" ] && echo yes || echo no)"
g -C N fetch -q origin "$SHA"
echo "A3 refs after 'fetch origin <sha>' identical to before: $([ "$(refs)" = "$BEFORE" ] && echo yes || echo no)"
g -C N update-ref refs/remotes/origin/main "$SHA"
echo "A4 rows that differ after update-ref: $(diff <(echo "$BEFORE") <(refs) | grep '^>' | awk '{print $3}' | tr '\n' ';')"
# parkOnProtectedBranch: local main is an ancestor of origin/main -> ff
g -C N merge-base --is-ancestor refs/heads/main refs/remotes/origin/main && echo "A5 local main is an ancestor of origin/main (ff branch of park): yes"
g -C N merge -q --ff-only refs/remotes/origin/main
# createTaskBranch for the next pickup: fork source = refs/remotes/origin/main^{commit}
FS=$(g -C N rev-parse "refs/remotes/origin/main^{commit}")
g -C N update-ref refs/heads/task/T2 "$FS" ""
echo "A6 next task's fork source carries the human's change: $(g -C N show task/T2:.claude/settings.json)"

# --- B: the already-forked T1 at the completion gate, base = the advanced origin/main
echo "B1 delta merge-base(origin/main@M1, T1 tip)..tip: $(delta refs/remotes/origin/main "$TIP1")"
echo "B2 merge-base is M0: $([ "$(g -C N merge-base refs/remotes/origin/main "$TIP1")" = "$M0" ] && echo yes || echo no)"

# --- C: inverse — a tip that carries the change, compared with a base that lacks it
# C1: base is a ref that never had M1 (a branch at M0); tip is T2 forked at M1 plus one commit
T2B=$(printf 'b\n' | g -C N hash-object -w --stdin)
TREE2=$( (g -C N ls-tree "$M1"; printf '100644 blob %s\tb.txt\n' "$T2B") | g -C N mktree)
TIP2=$(g -C N commit-tree "$TREE2" -p "$M1" -m "T2 work")
g -C N update-ref refs/heads/other "$M0"
echo "C1 delta merge-base(base lacking M1, T2 tip)..tip: $(delta refs/heads/other "$TIP2")"
# C2: origin's protected branch is rewritten (force-push) so that M1 is gone: M1' = M0 + unrelated commit
g -C H reset -q --hard "$M0"; echo z > H/z.txt; g -C H add -A; g -C H commit -q -m "M1' rewrite"; g -C H push -q -f origin HEAD:main
SHA2=$(g -C N ls-remote origin refs/heads/main | cut -f1); g -C N fetch -q origin "$SHA2"
echo "C2 delta merge-base(rewritten origin main, T2 tip)..tip: $(delta "$SHA2" "$TIP2")"
echo "C2 park: local main ancestor of rewritten? $(g -C N merge-base --is-ancestor refs/heads/main "$SHA2" && echo yes || echo no); rewritten ancestor of local main? $(g -C N merge-base --is-ancestor "$SHA2" refs/heads/main && echo yes || echo no)"
# C3: the human reverts the change on origin after T2 forked (no rewrite)
g -C H reset -q --hard "$M1"; echo '{"v":0}' > H/.claude/settings.json; g -C H commit -q -am "M2 revert"; g -C H push -q -f origin HEAD:main
M2=$(g -C H rev-parse HEAD); g -C N fetch -q origin "$M2"
echo "C3 delta merge-base(M2 = revert on top of M1, T2 tip)..tip: $(delta "$M2" "$TIP2")"

# --- D: landing-side merges (mergeCommit spells merge-tree --write-tree)
mt() { if g -C N merge-tree --write-tree "$1" "$2" >/dev/null 2>&1; then echo clean; else echo "conflict (exit $?)"; fi; }
echo "D1 merge-tree T1 tip (never touched the path) with M1: $(mt "$TIP1" "$M1")"
MERGED=$(g -C N commit-tree "$(g -C N merge-tree --write-tree "$TIP1" "$M1")" -p "$TIP1" -p "$M1" -m "catch up")
echo "D2 after catching T1 up to M1: settings=$(g -C N show "$MERGED":.claude/settings.json) delta vs M1: $(delta "$M1" "$MERGED")"
# D3: a tip that did change the path (reaches the branch only outside the gate) against M1
S3=$(printf '{"v":"worker"}\n' | g -C N hash-object -w --stdin)
CL=$(printf '100644 blob %s\tsettings.json\n' "$S3" | g -C N mktree)
TREE3=$(g -C N ls-tree "$M0" | sed "s/[0-9a-f]\{40\}\t.claude/$CL\t.claude/" | g -C N mktree)
TIP3=$(g -C N commit-tree "$TREE3" -p "$M0" -m "T3 changes settings")
echo "D3 delta of that tip vs M1: $(delta "$M1" "$TIP3")"
echo "D3 merge-tree of that tip with M1: $(mt "$TIP3" "$M1")"

# --- E: the human commits and pushes from the named place itself (not from their own clone)
g clone -q O N2
B2=$(g -C N2 for-each-ref --format='%(objectname) %(refname)')
echo '{"v":9}' > N2/.claude/settings.json; g -C N2 commit -q -am "human writes in the named place"; g -C N2 push -q origin HEAD:main
echo "E1 rows that differ in the named place after its own commit+push: $(diff <(echo "$B2") <(g -C N2 for-each-ref --format='%(objectname) %(refname)') | grep '^>' | awk '{print $3}' | tr '\n' ';')"
# E2: the human only runs a bare fetch in the named place after origin moved
g clone -q O N3
B3=$(g -C N3 for-each-ref --format='%(objectname) %(refname)')
g -C H reset -q --hard origin/main 2>/dev/null || true
g -C H pull -q origin main
echo y > H/y.txt; g -C H add -A; g -C H commit -q -m "another push"; g -C H push -q origin HEAD:main
g -C N3 fetch -q
echo "E2 rows that differ in the named place after a bare fetch: $(diff <(echo "$B3") <(g -C N3 for-each-ref --format='%(objectname) %(refname)') | grep '^>' | awk '{print $3}' | tr '\n' ';')"
```
