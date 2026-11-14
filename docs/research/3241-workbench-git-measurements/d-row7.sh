#!/bin/bash
# row 7: re-run the plain-git claims (ids from row7-claims.md) on this host. usage: bash -s <root>
# fixtures are re-derived from prose (the tickets carry no command lists) unless noted.
set -u
ROOT=$1; W=$ROOT/row7; rm -rf "$W"; mkdir -p "$W"; cd "$W" || exit 1
export GIT_AUTHOR_NAME=t3241 GIT_AUTHOR_EMAIL=t3241@example.invalid GIT_COMMITTER_NAME=t3241 GIT_COMMITTER_EMAIL=t3241@example.invalid
export GIT_CONFIG_NOSYSTEM=1 LC_ALL=C
echo "# $(hostname) $(git --version)"
ck() { local id=$1 d=$2; shift 2; if "$@" >/dev/null 2>&1; then echo "$id PASS $d"; else echo "$id FAIL $d"; fi; }
no() { ! "$@"; }
snap() { git -C "$1" for-each-ref --format='%(refname) %(objectname)'; git -C "$1" symbolic-ref -q HEAD || git -C "$1" rev-parse HEAD; }
same() { [ "$1" = "$2" ]; }
mk() { git init -q -b main "$1"; ( cd "$1"; echo 1 > f; git add f; git commit -q -m base ); }
old() { local t; t=$(date -d '21 days ago' +%Y%m%d%H%M 2>/dev/null || date -v-21d +%Y%m%d%H%M); find .git/objects -type f -exec touch -t "$t" {} +; }
msg() { echo "$1 MSG $(echo "$2" | head -2 | tr '\n' ' ' | cut -c1-200)"; }

### 1 reflog / gc
mk g1; cd g1
git checkout -q -b b; C1=$(git rev-parse HEAD); echo 2 > f; git commit -q -am c2; git checkout -q main
ck 1-01 "moved branch keeps old sha in its reflog" sh -c "git reflog show b | grep -q ${C1:0:7}"
echo "1-01 INFO expire defaults: reflogExpire=$(git config gc.reflogExpire || echo unset/90d) unreachable=$(git config gc.reflogExpireUnreachable || echo unset/30d)"
git branch -q -D b
ck 1-02 "deleted branch loses its reflog" sh -c '! test -e .git/logs/refs/heads/b && ! git reflog show b'
T=$(git rev-parse 'HEAD^{tree}'); N1=$(git commit-tree $T -p HEAD -m n1); git update-ref refs/heads/nb $N1; N2=$(git commit-tree $T -p $N1 -m n2); git update-ref refs/heads/nb $N2
ck 1-03 "never-checked-out branch shas are absent from HEAD reflog" sh -c "! git reflog show HEAD | grep -q -e ${N1:0:7} -e ${N2:0:7}"
git update-ref refs/keep-around/$N1 $N1
ck 1-04 "refs/keep-around has no reflog" sh -c '! test -e .git/logs/refs/keep-around && ! git reflog exists refs/keep-around/'$N1
# 1-05: old-mtime object dies at the first gc after its ref is deleted; fresh unreachable object survives (control)
git update-ref -d refs/keep-around/$N1; old; git update-ref -d refs/heads/nb
Y=$(git commit-tree $T -p HEAD -m fresh-unreachable)
git gc -q 2>/dev/null
ck 1-05 "old-mtime tip gone after first gc once ref deleted" no git cat-file -e $N2
ck 1-05c "control: fresh unreachable object survives the same gc" git cat-file -e $Y
# 1-06/07: which commands spawn auto maintenance
git config gc.auto 1; for i in 1 2 3; do git commit-tree $T -p HEAD -m "l$i" >/dev/null; done
trc() { GIT_TRACE=1 "$@" 2>&1 | grep -c -E 'maintenance run --auto|gc --auto'; }
echo z > z; git add z
echo "1-06 INFO auto-maintenance spawned: commit=$(trc git commit -q -m z) | commit-tree=$(trc git commit-tree $T -p HEAD -m x) | update-ref=$(trc git update-ref refs/heads/tmp HEAD)"
mk ../g1src >/dev/null; git -C ../g1src branch other
echo "1-07 INFO fetch(no dst, --no-auto-gc)=$(trc git fetch --quiet --no-auto-gc --no-recurse-submodules ../g1src other) | fetch(plain, control)=$(trc git fetch --quiet ../g1src other) | merge=$(git checkout -q -b mm; trc git merge -q --no-edit -s ours --allow-unrelated-histories FETCH_HEAD)"
git config --unset gc.auto; git checkout -q main
# 1-09/10 stash
echo s1 > f; git stash -q; S1=$(git rev-parse refs/stash); echo s2 > f; git stash -q; S2=$(git rev-parse refs/stash)
ck 1-10 "2nd stash entry lives only in refs/stash reflog" sh -c "[ \$(git for-each-ref refs/stash | wc -l) -eq 1 ] && [ \$(git rev-parse stash@{1}) = $S1 ] && [ $S1 != $S2 ] && ! git merge-base --is-ancestor $S1 $S2"
git update-ref -d refs/stash; git gc -q --prune=now 2>/dev/null
ck 1-09 "deleting refs/stash + gc --prune=now drops both entries" sh -c "! git cat-file -e $S1 && ! git cat-file -e $S2"
cd ..

### 2 linked worktrees
mk g2; cd g2; git branch eb; E0=$(git rev-parse HEAD); mk ../g2other >/dev/null
for n in a b; do git worktree add -q ../lw1$n -b nb$n; ( cd ../lw1$n; echo n > n; git add n; git commit -q -m n; echo dirty >> f ); done
B=$(snap .);
ck 2-08d "update-ref -d passes on a branch checked out in a linked worktree" git update-ref -d refs/heads/nba; git update-ref -d refs/heads/nbb
ST=$(git -C ../lw1a status 2>&1); P=$(git -C ../lw1a status --porcelain | tr '\n' ';')
ck 2-01 "after delete: unborn HEAD, content staged, uncommitted change kept [$P]" sh -c "echo \"$ST\" | grep -q 'No commits yet on nba' && echo '$P' | grep -q 'A[ M] n;' && echo '$P' | grep -q 'AM f;'"
ck 2-06a "dir and .git/worktrees registration remain" sh -c 'test -d ../lw1a && test -d .git/worktrees/lw1a'
OUT=$(git fetch -q ../g2other main:refs/heads/nba 2>&1); ck 2-11 "dst fetch into the unborn checked-out branch refused" sh -c "echo \"$OUT\" | grep -qi 'refusing to fetch into'"; msg 2-11 "$OUT"
( cd ../lw1a; git commit -q -am regrow ); ck 2-02 "commit regrows the branch as a root commit" sh -c 'git rev-parse -q --verify refs/heads/nba && [ "$(git rev-list --count nba)" = 1 ]'
( cd ../lw1b; git switch -q --detach $E0 ) ; P=$(git -C ../lw1b status --porcelain | tr '\n' ';'); ck 2-14 "switch --detach <sha> works from the unborn state, staged carried [$P]" sh -c "[ \$(git -C ../lw1b rev-parse HEAD) = $E0 ] && echo '$P' | grep -q 'A  n;'"
for n in a b c; do git branch eb$n $E0; git worktree add -q ../lw2$n eb$n; ( cd ../lw2$n; echo e > f; git commit -q -am e1 ); done
ck 2-08r "update-ref rewind passes on a checked-out branch" git update-ref refs/heads/eba $E0; git update-ref refs/heads/ebb $E0; git update-ref refs/heads/ebc $E0
P=$(git -C ../lw2a status --porcelain | tr '\n' ';'); ck 2-03 "rewound branch: advanced part shows staged [$P]" same "$P" "M  f;"
ck 2-06b "rewind does not move the worktree tree" sh -c '[ "$(cat ../lw2a/f)" = e ]'
( cd ../lw2a; git commit -q -m again ); ck 2-04 "commit advances the branch again, parent = rewound value" sh -c "[ \$(git rev-parse eba^) = $E0 ]"
( cd ../lw2b; git reset -q --hard ); ck 2-13 "reset --hard cleans the rewound shape" sh -c '[ -z "$(git -C ../lw2b status --porcelain)" ] && [ "$(cat ../lw2b/f)" = 1 ]'
OUT=$(git worktree remove ../lw2c 2>&1); R1=$?; git worktree remove --force ../lw2c; R2=$?; ck 2-12 "worktree remove refused with staged leftovers, --force passes" sh -c "[ $R1 -ne 0 ] && [ $R2 -eq 0 ]"; msg 2-12 "$OUT"
OUT=$(git branch -D eba 2>&1); ck 2-09 "branch -D refused for a branch checked out in a linked worktree" sh -c "[ -n \"\$(git rev-parse -q --verify refs/heads/eba)\" ]"; msg 2-09 "$OUT"
OUT=$(git fetch -q ../g2other main:refs/heads/eba 2>&1); ck 2-10 "dst fetch into checked-out branch refused" sh -c "echo \"$OUT\" | grep -qi 'refusing to fetch into'"; msg 2-10 "$OUT"
B=$(snap .); git worktree add -q --detach ../lw3; ( cd ../lw3; echo d > d; git add d; git commit -q -m d ); ck 2-05 "--detach worktree: add + commit move no refs" same "$B" "$(snap .)"
ck 2-07 "linked worktree HEAD not in for-each-ref" sh -c '! git for-each-ref | grep -q -e worktrees -e " HEAD$"'
B=$(snap .); git worktree add -q ../lw4 eb; ck 2-21 "worktree add <path> <existing branch> moves no refs" same "$B" "$(snap .)"
git worktree add -q ../lwx 2>/dev/null; ck 2-20 "argument-less worktree add creates refs/heads/<basename>" git rev-parse -q --verify refs/heads/lwx
B=$(snap .); ( cd ../lw3; git update-ref refs/worktree/foo HEAD; git update-ref refs/bisect/bad HEAD ); ck 2-22 "refs/worktree/* and refs/bisect/* written in a linked worktree are invisible to main for-each-ref" same "$B" "$(snap .)"
git update-ref refs/bisect/bad HEAD; ck 2-23 "main-side refs/bisect/* shows in for-each-ref" sh -c 'git for-each-ref | grep -q refs/bisect/bad'; git update-ref -d refs/bisect/bad
( cd ../lw4; echo st > f; git stash -q ); ck 2-24 "stash in a linked worktree writes the shared refs/stash" git rev-parse -q --verify refs/stash
P0=$(git rev-parse eb); echo adv > f; git add f; T1=$(git write-tree); git reset -q --hard; P1=$(git commit-tree $T1 -p $P0 -m advance); git update-ref refs/heads/eb $P1
P=$(git -C ../lw4 status --porcelain | tr '\n' ';'); ck 2-25 "branch advanced from outside: linked worktree index stays old [$P]" same "$P" "M  f;"
( cd ../lw4; git commit -q -m human ); ck 2-26 "human commit there stacks a commit undoing the advance" sh -c "[ \$(git rev-parse eb^) = $P1 ] && [ \$(git rev-parse 'eb^{tree}') = \$(git rev-parse '$P0^{tree}') ]"
git clone -q . ../g2clone; ( cd ../g2clone; git checkout -q eb; echo p > p; git add p; git commit -q -m p ); OUT=$(git -C ../g2clone push origin eb 2>&1); ck 2-27 "push into a branch checked out in a linked worktree refused" sh -c "echo \"$OUT\" | grep -q 'refusing to update checked out branch'"
rm -rf ../lw3; git worktree prune; ck 2-15 "prune drops the registration of a removed dir" sh -c '! test -d .git/worktrees/lw3'
git worktree add -q --detach inner; P=$(git status --porcelain --untracked-files=all | tr '\n' ';'); ck 2-16 "inner linked worktree shows as ?? inner/ [$P]" same "$P" "?? inner/;"
git restore --staged --worktree .; git clean -q -fd; ck 2-17 "restore + clean -fd leave the inner worktree" sh -c 'test -d inner && git status --porcelain | grep -q "?? inner/"'
OUT=$(git clean -ffd -n); ck 2-18 "clean -ffd (dry-run) would remove inner/" sh -c "echo '$OUT' | grep -q 'Would remove inner/'"
git worktree remove --force inner; ck 2-19 "worktree remove --force inner -> status empty" sh -c '[ -z "$(git status --porcelain --untracked-files=all)" ]'
cd ..

### 3 H4 / H11
# origin (bare) = GitHub stand-in. named place np has task/x with a local repair L on top of pushed head Bp; outside rewrites origin to X.
h4() { rm -rf h4; mkdir h4; cd h4; git init -q --bare -b main o.git; mk np >/dev/null; cd np; git remote add origin ../o.git; git push -q -u origin main
  git checkout -q -b task/x; echo a > a; git add a; git commit -q -m A; git push -q origin task/x; git fetch -q origin; echo l > l; git add l; git commit -q -m L
  git clone -q ../o.git ../out; ( cd ../out; git checkout -q task/x; eval "$1"; git push -q -f origin task/x ); }
h4 'git reset -q --hard HEAD~1; echo x > x; git add x; git commit -q -m X'   # rewritten head (does not contain A)
git fetch -q origin; GH=$(git rev-parse origin/task/x); L=$(git rev-parse HEAD)
git merge -q -s ours --no-commit $GH 2>/dev/null; git read-tree -u --reset $GH; git commit -q -m discard
ck 3-01 "new 3 commands (discard): tree == GitHub head, commit has both tips as ancestors" sh -c "[ \$(git rev-parse 'HEAD^{tree}') = \$(git rev-parse '$GH^{tree}') ] && git merge-base --is-ancestor $L HEAD && git merge-base --is-ancestor $GH HEAD"
ck 3-01p "…and the result pushes without force" git push -q origin task/x
cd ../..; h4 'git reset -q --hard HEAD~1'   # origin only rewound to an ancestor
git fetch -q origin; GH=$(git rev-parse origin/task/x); OUT=$(git merge -s ours --no-commit $GH 2>&1); git read-tree -u --reset $GH; git commit -q -m discard
ck 3-02 "rewound-to-ancestor: merge says Already up to date, commit has 1 parent, 3 commands pass" sh -c "echo '$OUT' | grep -q 'Already up to date' && [ \$(git rev-list --parents -1 HEAD | wc -w) = 2 ] && [ \$(git rev-parse 'HEAD^{tree}') = \$(git rev-parse '$GH^{tree}') ]"
# 3-11/3-12 current wording, typed literally from the protected branch (main has upstream)
cd ../..; h4 'echo x > x; git add x; git commit -q -m X'   # outside ADDED X on top of A (origin main is ancestor of PR head)
git checkout -q main; TX=$(git rev-parse task/x); OM=$(git -C ../o.git rev-parse main)
git fetch -q origin; git reset -q --hard origin/task/x; git merge -q -s ours task/x -m ours 2>/dev/null; OUT=$(git push 2>&1); R=$?
ck 3-11 "current H4 wording typed on the protected branch: local main and origin/task/x copy move, task/x does not" sh -c "[ \$(git rev-parse task/x) = $TX ] && [ \$(git rev-parse main) != $OM ] && [ \$(git rev-parse origin/task/x) = \$(git -C ../o.git rev-parse task/x) ]"
ck 3-12 "…and the bare git push lands on origin's protected branch (rc=$R)" sh -c "[ $R -eq 0 ] && [ \$(git -C ../o.git rev-parse main) = \$(git rev-parse main) ] && [ \$(git rev-parse origin/main) = \$(git rev-parse main) ]"
cd ../..
mk h11; cd h11; echo n > n; echo m > f; git add f n; echo u > u
git checkout -q -- .; git clean -q -fd; P=$(git status --porcelain | tr '\n' ';'); ck 3-03 "checkout -- . + clean -fd leave staged changes [$P]" same "$P" "M  f;A  n;"
B=$(snap .); echo u > u; git restore --staged --worktree .; git clean -q -fd; ck 3-04 "restore --staged --worktree . + clean -fd -> status empty, refs/HEAD unchanged" sh -c "[ -z \"\$(git status --porcelain)\" ]" ; ck 3-04r "refs unchanged" same "$B" "$(snap .)"
git init -q nested; git clean -q -fd; ck 3-05 "untracked nested git repo survives clean -fd" sh -c 'git status --porcelain | grep -q "?? nested/"'; git clean -q -ffd; ck 3-05f "clean -ffd removes it" sh -c '! test -d nested'
# 3-06..3-10: ref old, index+worktree new
H0=$(git rev-parse HEAD); echo new > f; git commit -q -am new; git update-ref refs/heads/main $H0
P=$(git status --porcelain | tr '\n' ';'); ck 3-06 "ref back at old value with index/worktree new -> staged M [$P]" same "$P" "M  f;"
git checkout -q -- .; git clean -q -fd; ck 3-07 "checkout -- . + clean do not clean it" sh -c '[ "$(git status --porcelain)" = "M  f" ]'
git restore --staged --worktree .; git clean -q -fd; ck 3-10 "restore --staged --worktree . + clean -fd cleans it, HEAD stays old" sh -c "[ -z \"\$(git status --porcelain)\" ] && [ \$(git rev-parse HEAD) = $H0 ]"
echo new > f; git commit -q -am new; git update-ref refs/heads/main $H0; git read-tree -u --reset HEAD; ck 3-08 "read-tree -u --reset HEAD cleans it" sh -c '[ -z "$(git status --porcelain)" ]'
B=$(snap .); echo st > f; git stash -q; ck 3-13a "stash creates refs/stash" sh -c 'git rev-parse -q --verify refs/stash'
echo cc > f; B=$(snap .); git checkout -q -- .; echo u > u; git clean -q -fd; ck 3-13b "checkout -- . / clean move no refs" same "$B" "$(snap .)"
cd ..

### 4 outside push
o4() { rm -rf o4; mkdir o4; cd o4; git init -q --bare -b main o.git; mk np >/dev/null; cd np; git remote add origin ../o.git; git push -q origin main; git checkout -q -b task/r; echo a > a; git add a; git commit -q -m A; git push -q origin task/r; git fetch -q origin
  git clone -q ../o.git ../out; ( cd ../out; git checkout -q task/r; echo x > x; git add x; git commit -q -m X; git push -q origin task/r ); }
o4; LP=$(git rev-parse HEAD)
OUT=$(git push origin task/r 2>&1); R=$?; ck 4-04 "origin advanced outside, local tip == last pushed: force-less push refused (rc=$R)" sh -c "[ $R -ne 0 ]"; msg 4-04 "$(echo "$OUT" | grep -E 'rejected|up-to-date')"
echo fix > fix; git add fix; git commit -q -m repair; OUT=$(git push origin task/r 2>&1); R=$?; ck 4-01 "with an unpushed repair on top: refused non-fast-forward (rc=$R)" sh -c "[ $R -ne 0 ] && echo \"$OUT\" | grep -q -e 'fetch first' -e 'non-fast-forward'"; msg 4-01 "$(echo "$OUT" | grep rejected)"
XS=$(git -C ../o.git rev-parse task/r)
( cd ../out; git push -q -f origin $LP:refs/heads/task/r ); ck 4-07 "after origin is force-pushed back to last pushed sha, board push passes" git push -q origin task/r
( cd ../out; git fetch -q origin; git merge -q --no-edit origin/task/r; git push -q origin task/r ); ck 4-02 "then merging the outside commit and pushing again passes; head has both" sh -c "git -C ../o.git merge-base --is-ancestor $XS task/r && git -C ../o.git merge-base --is-ancestor \$(git rev-parse HEAD) task/r"
cd ../..; o4; git -C ../o.git update-ref -d refs/heads/task/r; ck 4-06 "after origin branch is deleted, board push passes" git push -q origin task/r
OUT=$(git ls-remote ../o.git refs/heads/nope); R=$?; ck 4-08 "ls-remote of a missing branch: empty output, exit 0" sh -c "[ $R -eq 0 ] && [ -z '$OUT' ]"
# 4-03 rewritten head dropped file 'a'; clean local merge keeps it
cd ../..; o4; ( cd ../out; git checkout -q --orphan tmp; git rm -q -rf .; echo 1 > f; echo x > x; git add .; git commit -q -m rewritten; git push -q -f origin tmp:task/r ); git fetch -q origin
git merge -q --no-edit --allow-unrelated-histories origin/task/r 2>/dev/null; R=$?; ck 4-03 "rewritten head + clean local merge keeps the file the outside push dropped (rc=$R)" sh -c "[ $R -eq 0 ] && test -f a && test -f x"
# 4-10 revert on origin does not make head an ancestor
cd ../..; o4; ( cd ../out; git revert --no-edit HEAD >/dev/null; git push -q origin task/r ); git fetch -q origin; ck 4-10 "revert added on origin: origin head still not an ancestor of the local tip" no git merge-base --is-ancestor origin/task/r HEAD
cd ../..

### 5 side-effect ref writes
mk s5src >/dev/null; git -C s5src branch other; git -C s5src update-ref refs/board/fetched HEAD
mk s5; cd s5
B=$(snap .); rm -f .git/FETCH_HEAD; git fetch --quiet --no-auto-gc --no-recurse-submodules ../s5src refs/board/fetched; A=$(snap .); ck 5-04 "dst-less fetch writes FETCH_HEAD only" sh -c "test -f .git/FETCH_HEAD && [ '$B' = '$A' ]"
git fetch --quiet --no-auto-gc --no-tags ../s5src other; ck 5-01 "dst-less fetch of a branch (2nd spelling) writes no refs" same "$B" "$(snap .)"
SH=$(git -C ../s5src rev-parse other); git -C ../s5src config uploadpack.allowAnySHA1InWant true; git fetch --quiet ../s5src $SH; ck 5-05 "fetch by sha writes no refs" same "$B" "$(snap .)"
git remote add origin ../s5src; ck 5-03 "remote add writes no refs" same "$B" "$(snap .)"
git remote set-url origin ../s5src; ck 5-08a "remote set-url writes no refs" same "$B" "$(snap .)"
git fetch -q origin; git remote set-head origin -a >/dev/null; ck 5-08b "fetch after remote add creates the copies" sh -c 'git for-each-ref | grep -q refs/remotes/origin/other'
git -C ../s5src checkout -q other; B=$(git symbolic-ref refs/remotes/origin/HEAD); git remote set-head origin -a >/dev/null; ck 5-15 "origin/HEAD symref follows the remote default branch on set-head ($B -> $(git symbolic-ref refs/remotes/origin/HEAD))" sh -c "[ '$B' != \"\$(git symbolic-ref refs/remotes/origin/HEAD)\" ]"
B=$(snap .); git fetch -q origin; ck 5-15b "a plain fetch does not move origin/HEAD by itself" same "$B" "$(snap .)"
cp -r . ../s5b; git remote remove origin; ck 5-06 "remote remove deletes every refs/remotes/origin/* incl. origin/HEAD" sh -c '[ -z "$(git for-each-ref refs/remotes)" ]'
cd ../s5b; git config --remove-section remote.origin; ck 5-09 "config --remove-section leaves the copies with no remote section" sh -c '[ -n "$(git for-each-ref refs/remotes/origin)" ] && ! git config --get remote.origin.url'
cd ..; git clone -q s5src s5c; ck 5-17 "clone creates a copy for every origin branch" sh -c '[ "$(git -C s5c for-each-ref refs/remotes/origin | grep -v HEAD | wc -l)" -eq "$(git -C s5src for-each-ref refs/heads | wc -l)" ]'
mkdir s5i; cd s5i; git init -q; ck 5-16 "hand git init: refs empty, HEAD unborn at init.defaultBranch ($(git symbolic-ref HEAD))" sh -c '[ -z "$(git for-each-ref)" ] && ! git rev-parse -q --verify HEAD'
cd ..
# 5-11 / 5-12 / 5-14: H3 pushing back a rewind from the named place; H9
cd h4 2>/dev/null && cd .. ; h4 'git reset -q --hard HEAD~1' ; git reset -q --hard origin/task/x   # local == last pushed; origin rewound
B=$(snap .); git push -q origin task/x; ck 5-11 "pushing a rewind back from the named place moves no refs" same "$B" "$(snap .)"
git checkout -q main; echo m > m; git add m; git commit -q -m m; B=$(git rev-parse origin/main); git push -q origin main; ck 5-14 "push from the named place moves the origin/<protected> copy" sh -c "[ $B != \$(git rev-parse origin/main) ]"
cd ../..
echo "# row7 done"
