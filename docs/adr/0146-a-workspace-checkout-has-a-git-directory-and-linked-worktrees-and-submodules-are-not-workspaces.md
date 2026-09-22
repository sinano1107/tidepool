# workspace の checkout は `.git` をディレクトリに持つ: linked worktree・submodule は workspace にならない

issue #866 の grilling(2026-09-22)で決定。#849(PR #865)が Codex work worker の filesystem 表に `<workspace>/.git` = write、`.git/hooks` / `.git/config` = read を足したところ、`.git` が**ファイル**の checkout(linked worktree・submodule の形)では Linux の sandbox が mount 先を作れず起動しない(Lima VM で実測、exit 101)。ただし退行の範囲は issue の見立てより狭い —— linked worktree の gitdir は workspace の外にあり sandbox が隠すので、#849 以前から Codex route の Linux では git 操作ができなかった(同じ VM で `git add` が `not a git repository`)。#849 が変えたのは「git だけ壊れている」→「sandbox 自体が立たない」である。測定は #866 のコメントに置く。

## 決定

1. **workspace の checkout は `.git` をディレクトリに持つ。** linked worktree(`git worktree add`)と submodule は `.git` がファイルで gitdir が checkout の外にあるため workspace にならない。`.git` が無い checkout は今日どおり git 側の失敗で pickup に落ちるので、新しい門が言うのは「`.git` が存在してディレクトリでない」だけである。
2. **門は pickup 側の workspace quarantine で、回答受理の検証と登録の門にも同じ条件を置く。** pickup の準備がこの形を見て quarantine に落とし、修理確認の回答は同じ条件を再検査してから受理する(ADR 0040 と同じ「床は pickup 側」)。既存 checkout を登録する門(WebUI / 管理MCP)は**拒否**する —— #383 / ADR 0082 の「信号は提示して同意を求める」は同意すれば動く信号向けで、同意しても動かない形には当てない。boot 時の一斉検査は足さない: ADR 0040 が boot で撃つのは最初の poll で slot に入る前に見せるためだが、ここでは pickup 自身が止める。
3. **判定はファイルシステムの形(`.git` の stat)で、Harness に依らない。** 守る理由は「sandbox の mount 先がディレクトリでない」であって git の解釈ではない。workspace は Harness に依らない資源なので、Claude route にも同じ門が効く(Claude route の linked worktree は未測定。動く観測が出たら、そのとき条件を Harness で分ける)。
4. **`permissionConfig()` の3行は触らない。** 門が checkout を弾くので、`.git` がファイルの path は spawn に届かない。

## 採らなかった選択肢

- **`permissionConfig()` で `.git` がディレクトリのときだけ3行を出す** —— sandbox は立つが git は動かず、失敗が spawn 時から worker の実行時(escalate → question)へ後退する。登録の門も preflight も黙って通す。床の形(hooks / config の read)がファイル状態で変わるのも ADR 0013 の「床はデータの状態に依存しない」から外れる。guard が守るのは「非 git のコマンドは走る」だけで、linked worktree で git 抜きの task を流す場面は未観測。
- **registry のロード(`assertValidWorkspaces`)で拒む** —— registry の検証は宣言だけを見て clone を覗かない(ADR 0052 決定3)。checkout の性質は pickup の quarantine が受ける場所である。
- **`.git` がファイルで gitdir が checkout 内にある形を許す** —— `git init --separate-git-dir` を checkout の中に向けて手で作る以外に生まれず、ニーズは無い。
