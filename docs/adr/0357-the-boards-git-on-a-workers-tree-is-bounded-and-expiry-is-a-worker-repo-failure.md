# 盤面が worker の tree に撃つ git は有界で、上限で止まった手は worker の repo の故障である —— 観測の失敗でも名前の場所の quarantine でもない

**Status 追記: 決定1 の有界の対象は path の持ち主でなく byte の出所 —— worker の `.git` から写した盤面所有の repo からの fetch も含む。決定2 の分類は、写す段の失敗(worker の repo の故障)と名前の場所へ fetch する段の失敗(名前の場所の側)に分かれる([ADR 0364](0364-the-board-never-opens-the-workers-git-as-a-repository-and-fetches-the-tip-from-a-board-owned-copy-of-its-regular-files.md) 決定2・3、2026-11-09、issue #3097)。**

**Status 追記: 決定2 の分類は完了済みの解放には当たらない —— そこでは fetch が走らず、view の上限超過は報告後の書き込みの「読めない」観測になる([ADR 0359](0359-the-completion-gate-lands-the-tip-in-the-record-before-done-and-a-completed-release-carries-only-the-recorded-tip.md) 決定5、2026-11-08、issue #3053)。**

**Status 追記: 決定2 の「checkout は残す」は解放でも worker の tree を読めなかったときに限る —— 門で強制回収した後の解放の再読が上限内に終われば、WIP は退避され checkout は ADR 0356 決定2 の最後の step で今日どおり消える(2026-11-08、issue #3033)。**

2026-11-07 の grilling(issue #2966、派生 #3018)で決定。#2966 の sparse pattern ファイルの site は ADR 0356 で消えるが、残る形は
GIT_DIR に依らない —— worker は worktree に FIFO を置け、`.gitignore`(root、または走査される dir の中)や `.gitattributes` が
FIFO なら、盤面の `git status` / `add -A` / `ls-files --exclude-standard` / `diff` はそれを open して永久に止まる(実測、macOS git 2.47。
ADR 0356 決定3 の別 GIT_DIR の形でも同じ)。盤面の local の git(`git.ts` の `run`)は `execFileSync` で上限が無く、同じ runner が盤面所有の
repo も worker の tree も読む。ref の書き込みが同期なのは ADR 0243 の決定、網の git が有界なのは ADR 0330 / 0334 の決定だが、
**worker の tree を同期・無界で読む**ことは誰も決めていない写しである。決め手は完了の門: `treeIsDirty` は worker の `complete_task` verb の
中で `git status` を同期に撃ち、投げを「観測の失敗 → `false`」と飲む(ADR 0084 決定2)。上限だけ足すと、worker は verb を繰り返して上限ぶんの
凍結を何度でも起こせ、超過が門を開く鍵になる。測定の表・呼び出しの数・`file:line` は #2966 のコメントに置く。

## 決定

1. **盤面が worker の tree / repo に撃つ git は「盤面の外の入力」の読みであり、有界である。** 対象は cwd **または引数の出所**が task の
   checkout(受験者の checkout・面接室を含む)であるもの —— ADR 0356 決定3 の盤面所有 view の `status` / `add -A` / `write-tree` と、
   worker の `.git` から tip を引く fetch(`upload-pack` は worker の repo の中で走る)。上限は view の runner **1箇所**に置く(ADR 0330 決定4
   の線)。cwd も引数も盤面所有の名前の場所に撃つ plumbing は今日どおり同期・上限なし。
2. **上限で止まった手は worker の repo の故障である(ADR 0356 決定2 の分類)。** session を強制回収で決着させ(ADR 0331 決定6 と同じ畳み方)、
   task は failure question へ、checkout は残す。verb の門で起きても DomainError で拒んで続けさせない —— 拒めば凍結を繰り返せる。
   名前の場所は quarantine しない。
3. **上限超過は観測の失敗ではない。** ADR 0084 決定2 の「repo が壊れていて観測できない → `false`」は git が即座に失敗した場合に限り、
   超過は別の型で投げて門は開かない(fail-closed)。
4. **view の git は同期のまま。** 後始末は `releasable()` の再読から `slot.release()` までを1つの同期区間に置き(ADR 0330 決定1 の窓の
   規則)、ADR 0356 決定3 は fetch → 退避 → `update-ref` を1つの口に詰める。決定2 で繰り返しが消えるので、残る凍結は worker 1 session に
   つき「view の呼び出し数 × 上限」の1回に有界。
5. **上限は view 専用の定数1つ。** `GIT_NETWORK_TIMEOUT_MS`(網の往復)とも `CAPABILITY_PROBE_TIMEOUT_MS`(local binary の probe)とも
   理由が違う —— worker の tree の大きさに依る。値は spec で VM の実 repo を測って決め、既定は 30 秒。

## 退けた形

- **pattern ファイルを `lstat` で見て特殊ファイルなら Quarantine**(#2966 sweep の Q1)—— ADR 0356 で site が消え、worktree 側の
  `.gitignore` / `.gitattributes` には同じ形が置き場所ごとに増える(denylist)。
- **`add -A -f`** —— 止まらないが ignored を WIP に入れる。
- **view の git を非同期に** —— 口と窓の規則の両方を作り直す費用で、得るのは有界1回の凍結だけ。
- **定数を `GIT_NETWORK_TIMEOUT_MS` と共有** —— ADR 0330 が別定数を退けたのは理由が同じだったからで、ここは理由が違う。

## 決めないこと・帰結

- 名前の場所の plumbing の無界は残す —— 書き手は盤面と人間だけ(ADR 0351)で、人間が自分の checkout に置く FIFO は範囲外。
- Node の読みの脚は決定にしない —— #2935 の `lstat` 化と ADR 0356 の後、worker が生きている間に worker の内容を open する Node の
  読みは残らない。
- FIFO は commit できない(`add -A` が拒む、symlink の `.gitignore` は git が辿らない)ので、作り直した checkout での retry は安全。
  ただし #3028 の再開が残した checkout を再利用しないことが前提(#3028 にコメント)。
- 実装は ADR 0356 の view が生まれてから(spec #3033 は blocked-by #3029 / #3030)。#3018 はここで決まり、同じ spec で閉じる。
