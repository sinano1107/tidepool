set -u; d=$(mktemp -d); cd $d
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid LC_ALL=C
git init -q -b main a; cd a; echo 1 > f; git add f; git commit -q -m base; git init -q -b main ../b; (cd ../b; echo 2 > g; git add g; git commit -q -m other-different)
git config gc.auto 1; T=$(git rev-parse 'HEAD^{tree}'); for i in 1 2 3; do git commit-tree $T -p HEAD -m l$i >/dev/null; done
git fetch -q --no-auto-gc ../b main
echo "$(git --version): merge spawns auto maintenance = $(GIT_TRACE=1 git merge -q --no-edit --allow-unrelated-histories FETCH_HEAD 2>&1 | grep -c -E 'maintenance run --auto|gc --auto') (merged: $(git rev-list --count HEAD))"
cd /; rm -rf $d
