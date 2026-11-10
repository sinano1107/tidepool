# worker の作業台と盤面の記録は別の `.git` である —— task の checkout は session ごとに作って捨て、盤面は worker の `.git` を GIT_DIR にしない

**Status 追記: 決定2 の「解放のどの失敗でも checkout は残して既存の失敗経路へ」は、成果が名前の場所の ref になる前の失敗に限る —— 着いた後の失敗(ref の比較・merge back・休止位置)は checkout を残さない —— 解放の event は成果が着いた時点で書き、削除は最後の step のまま後の段が落ちても撃つ。名前の場所の事情で運べなかった解放は、その workspace の Quarantine の受理がやり直し、済んでいない解放を持つ task は走らせない。worker の repo の故障で残した checkout は変わらない([ADR 0369](0369-a-release-the-named-place-kept-from-finishing-is-redone-by-the-acceptance-of-its-quarantine-and-a-task-that-owes-one-is-not-picked-up.md) 決定1・4・7、2026-11-11、issue #3147)。**

**Status 追記: 決定3 の view の `add -A` は名前の場所の objects に直接書かない —— worktree は盤面所有の repo に stage し、名前の場所へは fetch で運ぶ。決定2 の「worker の repo の故障は task の失敗」は stage する段の失敗に限り、名前の場所へ運ぶ段の失敗は名前の場所の quarantine([ADR 0367](0367-the-wip-evacuation-is-attributed-by-stage-the-worktree-is-staged-in-a-board-owned-repo-and-fetched-into-the-named-place.md) 決定1・4、2026-11-10、issue #3141)。**

**Status 追記: 決定3 の view の「sparse policy は tip の tree から導く」は、運ばない path を tip の tree から導いて pathspec で外す形に置き換わる —— view は sparse で seed しない([ADR 0360](0360-the-board-judges-what-reaches-the-worker-from-the-recorded-tree-reads-the-checkout-only-to-verify-its-own-hide-and-stops-unhideable-shapes-on-the-writers-axis.md) Status 追記、2026-11-10、issue #3111)。**

**Status 追記: 決定3 の「submodule は gitlink だけで読む」の書き側 —— 記録は名前の場所の1 repo で閉じ、入れ子の repo の中身は持たないので、fork 元から gitlink を足す・進める tip は完了の門が拒み、submodule の中の作業は commit 済みでも未 commit でも運ばれない([ADR 0365](0365-the-record-closes-within-one-repo-and-the-completion-gate-rejects-a-tip-that-adds-or-advances-a-gitlink-from-the-fork-source.md)、2026-11-09、issue #3052)。**

**Status 追記: 決定3 の「gitlink だけで読む」の値の出所 —— 盤面は gitlink の値を記録からしか読まず、worktree の入れ子の repo は view から除く。gitlink を「読む」は入れ子の `.git` を開くことではない([ADR 0365](0365-the-record-closes-within-one-repo-and-the-completion-gate-rejects-a-tip-that-adds-or-advances-a-gitlink-from-the-fork-source.md) 決定3、2026-11-09、issue #3117)。**

**Status 追記: 決定3 の「upload-pack は protected config しか読まない」は保証が足りなかった —— config でないリポジトリ定義(`gitdir:`・alternates・ref の symlink)も worker が書け、盤面ユーザーの upload-pack がそれを辿る。盤面は worker の `.git` をリポジトリとして開かず、regular file だけを盤面所有の repo に写してそこから fetch する([ADR 0364](0364-the-board-never-opens-the-workers-git-as-a-repository-and-fetches-the-tip-from-a-board-owned-copy-of-its-regular-files.md)、2026-11-09、issue #3097)。**

**Status 追記: 決定2 の「答案の ref は面接室の `task/<id>` に着く」はそのまま。検討していなかった読み手(retry の root・root 配下の review)は面接室の `.git` を開かず、出題の head の checkout を読む([ADR 0361](0361-interview-readers-read-a-checkout-of-the-posed-head-not-the-rooms-git-and-the-answers-stay-in-the-room.md)、2026-11-09、issue #3071)。**

**Status 追記: 決定3 の「GIT_DIR にしない」は「task の checkout の `.git` を判定の入力にしない」に広がる —— 盤面が worker の repo に撃つのは tip の fetch と自分の隠しの `lstat` 検証だけで、index・`info/sparse-checkout`・alternates の存在を判定に使わず、view の sparse policy は tip の tree から、sandbox の読み path は Interview の役から導く([ADR 0360](0360-the-board-judges-what-reaches-the-worker-from-the-recorded-tree-reads-the-checkout-only-to-verify-its-own-hide-and-stops-unhideable-shapes-on-the-writers-axis.md)、2026-11-08、issue #3074)。**

**Status 追記: 決定2 の「worker の repo の故障は task の失敗」は決着していない task(`todo` に戻る解放)に限る —— `done` の task の解放は記録の tip だけを運び、読めない checkout は報告後の書き込みの観測として記録する([ADR 0359](0359-the-completion-gate-lands-the-tip-in-the-record-before-done-and-a-completed-release-carries-only-the-recorded-tip.md) 決定2・3・5、2026-11-08、issue #3053)。**

**Status 追記: 決定3 の「worktree の FIFO で盤面の git が止まる形(#3018)はこれでは閉じない」は [ADR 0357](0357-the-boards-git-on-a-workers-tree-is-bounded-and-expiry-is-a-worker-repo-failure.md) が閉じる —— view の git は有界で、超過は決定2 の worker の repo の故障(2026-11-07、issue #2966)。**

2026-11-07 の grilling(issue #2956、#2912 / ADR 0352 の族の根)で決定。worker が走った checkout には ref にも tracked content にも無く
session を越えて残る層(ignored・index の印・`.git/info/exclude`・`.git/config`・hooks)があり、盤面の「clean」(`git status`)はその層を
見ないか HEAD の branch で出方が変わる(#2945 / #2957 / #3011)。ADR 0352 は層の1行に持ち主を置いたが、残りを行ごとに reset するのは
denylist で、次の行ごとに1つ増える。根は乗り物でなく持ち主にある —— work task だけが、盤面の記録(ref・基準・休止位置・人間が覗く写し)と
worker の作業台(index・`info/`・config・hooks・objects)を**同じ `.git`** に置いていた。tree の乗り物は既に3つあり(名前の場所の共有
checkout、registry 書き込みの使い捨て worktree(ADR 0052 決定6)、受験者の `git init` + fetch(ADR 0276))、持ち主が2人なのは1つだけ。
加えて、worker が書ける `.git/config` の `filter.<x>.clean` / `core.fsmonitor` は、その checkout を cwd にした盤面の `add -A` / `status` で
盤面のユーザーとして sandbox の外で走る(実測、#3027)—— 乗り物を替えても盤面が worker の `.git` を読む限り消えない。実測の表
(層の行 × 乗り物、GIT_DIR の分離、plumbing と hooks / 署名、fetch の費用)と ADR の分類(決定 14 / 写し 24 / 無関係 65)は #2956 のコメントに置く。

## 決定

1. **worker の形で走る process(work・review・受験者・Interview の root)は全部 task の checkout で走り、名前の場所(面接室を含む)は盤面だけが書く。**
   名前の場所の HEAD は保護ブランチを離れない。
2. **task の checkout の寿命は session。** pickup で名前の場所から `git init` + fetch で作り(work / review は alternates で名前の場所の objects を
   読み専用で借りる —— 今日と同じ可視性。受験者は ADR 0276 どおり複製)、解放で tip の fetch と退避のあと消す。削除は tip が名前の場所の ref に
   なった後の**最後の冪等 step**で、解放のどの失敗でも checkout は残して既存の失敗経路へ —— worker の repo の故障は task の失敗で、名前の場所の
   quarantine ではない。準備(`init` / fetch)の失敗は fetch 元の性質として名前の場所の quarantine(ADR 0276 決定3 の線)。受験者の
   ADR 0276 決定1「再開は同じ checkout」は同じ線に揃え、決定4(決着した最後の checkout は記録として残る)は保つ。session を越える ignored の
   生成物は失うが、ADR 0352 決定2 が既に手放したものである。
   Interview の場所(root・受験者)は alternates を使わず複製で作る(面接室は小さく、ADR 0276 の線をそのまま保つ)。受験者の WIP と tip は
   解放の fetch で**面接室の `task/<id>`** に着く —— 盤面は worker の `.git` に書かないので、答案の ref の置き場は面接室になる。次の受験者は
   自分の branch だけを fetch する(clone でも alternates でもない)ので兄弟の答案は見えない(ADR 0276 決定1 の退けた clone とは別)。
3. **盤面は worker の `.git` を GIT_DIR にしない。** 退避・完了の門・再実行と pickup の検査は、盤面所有の使い捨て GIT_DIR + worker の worktree
   (`GIT_WORK_TREE`)+ 新規 index + 名前の場所の objects(`GIT_OBJECT_DIRECTORY`)で読み書きし、worker の commit は fetch で引く(upload-pack の
   hook は protected config しか読まない)。順は fetch → 退避 → `update-ref` を1つの口の中で詰める(`update-ref` 前の loose object は未到達)。
   副産物として index の印や `info/exclude` で隠した変更は門に見え、「commit せよ」になる —— 門の拒否文は path を名指す。宣言として消えるのは
   `.gitignore` だけ(ADR 0352 決定1 のまま)。worktree の FIFO で盤面の git が止まる形(#3018)はこれでは閉じない。
4. **ref の基準(ADR 0064 / 0351)は名前の場所だけが持つ。** task の checkout に ref の門は無い —— 封じ込めは「見張る」から「盤面が読むのは
   `task/<id>` 1本」に替わる。受験者ごとの `snapshot_key`(ADR 0276 決定3)は要らなくなる。
5. **名前の場所で盤面が撃つ手は plumbing。** `symbolic-ref` / `read-tree -u -m` / `update-ref` / `commit-tree`、fetch は `--no-auto-gc`、global /
   system config は読まない(ADR 0339 決定1 の形を local の runner にも)。保護ブランチの ref を書く手(local landing・catch-up・remote への ff)は
   worktree の追従と1つの口の step —— HEAD が常に保護ブランチに居るので、ref だけ進めると tree が stale になり、ADR 0351 決定5 が人間の書き込みと
   誤読する。register モードは残す(local だけの既存 checkout の唯一の扉。人間の hooks は盤面の手で走らなくなり、ADR 0352 の削除は人間の
   checkout で繰り返されない)。
6. **系譜は fetch で fork し、merge back は名前の場所の中で `merge-tree` + `commit-tree` + `update-ref`。** 親の再開は決定2 の作り直しで自分の
   branch を得る。Interview の出題の写し(ADR 0273 決定3 の head)は決定3 の形で root の worktree から面接室の objects に作り、同じ verb の
   解放の fetch で到達可能になる(code の読み、未測)。
7. **git に無いものは worker に届かない。** `node_modules` は task の checkout で再生成、秘密は spawn env の側、人間が渡したいものは commit する。
   登録の門の文言は「worker には commit されたものだけが届く」に書き直す。

## 退けた形

- **層の行ごとに reset の持ち主を足す**(#2956 本文の「使う」側)—— denylist。register モードでは人間の行と区別できず reset できない。
- **`git worktree`(`extensions.worktreeConfig` 込み)** —— index は分かれるが `info/exclude`・config・hooks は共有(実測)。
- **名前の場所の `.git` を盤面の GIT_DIR にする** —— 人間の `info/exclude` と sparse-checkout が退避に漏れる。
- **名前の場所を bare にする** —— clone モードだけ休止の追従が消え、register と形が2つになる。
- **register をやめて clone に強制する**(#2842)—— GitHub に無い既存 checkout の扉が消える。

## 派生

- Status 追記: ADR 0040、0052 決定7、0064、0103 決定3、0146 決定1・3、0243 決定4、0274 決定3、0276 決定1・3、0293、0345 決定2・3、
  0346 決定2(untracked 側)、0351 決定2・5、0352。GLOSSARY.md: 「task の checkout」を立て、記録された場所・Slot-release tree rule・
  休止位置・Branch discipline・タスクブランチは worker の唯一の可変 ref・sparse snapshot・受験者の行を直す。
- 実装は複数 slice(`/to-spec` → `/to-tickets`)。#2945 / #2957 / #2960 / #2819 はその spec が閉じ、#3027 は決定3 の確認を持つ。#2842 は決定5 で閉じる。
