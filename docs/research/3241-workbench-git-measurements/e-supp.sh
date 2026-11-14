set -u; cd "$1/row7" || exit 1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid LC_ALL=C
snap() { git for-each-ref --format='%(refname) %(objectname)'; git symbolic-ref -q HEAD || git rev-parse HEAD; }
r() { if [ "$2" = "$3" ]; then echo "$1 PASS $4"; else echo "$1 FAIL $4"; fi; }
echo "# $(git --version)"
rm -rf e1; git init -q -b main e1; cd e1; echo 1 > f; git add f; git commit -q -m b
git worktree add -q ../e1w -b nb; (cd ../e1w; echo n > n; git add n; git commit -q -m n; echo d >> f); git update-ref -d refs/heads/nb
echo "2-01 status head: $(git -C ../e1w status | head -3 | tr '\n' '|') porcelain: $(git -C ../e1w status --porcelain | tr '\n' ';')"
B=$(snap); git worktree add -q --detach ../e1r; (cd ../e1r; echo r > r; git add r; git commit -q -m r); git worktree remove --force ../e1r; r 5-02 "$B" "$(snap)" "worktree add --detach / commit / remove write no refs"
B=$(snap); git checkout -q -b t1; echo c > c; git add c; git commit -q -m c; git checkout -q main; git merge -q --no-edit t1; echo "5-10 ORIG_HEAD exists=$(test -f .git/ORIG_HEAD && echo y || echo n); in for-each-ref=$(git for-each-ref | grep -c -e ORIG_HEAD -e FETCH_HEAD)"
# 6-01/6-04: hand merge on a checked-out branch moves that branch (and HEAD symref if left there)
git branch dst HEAD~1 2>/dev/null; H=$(git symbolic-ref HEAD); D0=$(git rev-parse dst); git checkout -q dst; git merge -q --no-edit t1; echo "6-01/04 dst moved=$([ $D0 != $(git rev-parse dst) ] && echo y) HEAD line changed=$([ $H != $(git symbolic-ref HEAD) ] && echo y) t1 unchanged=$([ $(git rev-parse t1) = $(git rev-parse main) ] && echo y)"
git checkout -q main; B=$(snap); git branch newprot; echo "6-05 new protected branch ref appears=$(git for-each-ref | grep -c refs/heads/newprot)"
cd ..
# 5-12: origin diverged; current H4 wording typed after `git checkout task/x`
rm -rf e2; mkdir e2; cd e2; git init -q --bare -b main o.git; git init -q -b main np; cd np; echo 1 > f; git add f; git commit -q -m b; git remote add origin ../o.git; git push -q -u origin main
git checkout -q -b task/x; echo a > a; git add a; git commit -q -m A; git push -q origin task/x; git fetch -q origin; echo l > l; git add l; git commit -q -m L; L=$(git rev-parse HEAD); git checkout -q main
git clone -q ../o.git ../out; (cd ../out; git checkout -q task/x; echo x > x; git add x; git commit -q -m X; git push -q origin task/x)
B=$(snap); git checkout -q task/x; git fetch -q origin; git reset -q --hard origin/task/x; git merge -q -s ours $L -m ours; A=$(snap)
echo "5-12 changed lines: $(diff <(echo "$B") <(echo "$A") | grep '^>' | awk '{print $2}' | tr '\n' ' ')"
