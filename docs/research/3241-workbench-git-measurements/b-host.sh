#!/bin/bash
# runs ON the host (VM / Pi): rows 5, 6 (host side), 8, 9 (setup). usage: bash -s <root>
set -u
ROOT=$1; cd "$ROOT" || exit 1
export GIT_AUTHOR_NAME=t3241 GIT_AUTHOR_EMAIL=t3241@example.invalid GIT_COMMITTER_NAME=t3241 GIT_COMMITTER_EMAIL=t3241@example.invalid
say() { echo; echo "## $*"; }
ms() { local s=$(date +%s%N); "$@" >/dev/null 2>&1; local rc=$?; echo "$(( ($(date +%s%N)-s)/1000000 ))ms rc=$rc"; }
say "host $(hostname) $(git --version) user=$(id -un)"

say "row5: ownership"
stat -c 'wb owner=%U mode=%a' wb; git -C wb rev-parse --short HEAD
echo "safe.directory: [$(git config --get-all safe.directory)]"
echo "control (GIT_TEST_ASSUME_DIFFERENT_OWNER=1):"; GIT_TEST_ASSUME_DIFFERENT_OWNER=1 git -C wb rev-parse --short HEAD 2>&1 | head -3
if command -v systemctl >/dev/null && systemctl cat tidepool.service >/dev/null 2>&1; then echo "tidepool.service $(systemctl show tidepool.service -p User -p UMask | tr '\n' ' ')"; fi
[ -d /mnt/ssd/tidepool ] && { stat -c '/mnt/ssd/tidepool owner=%U mode=%a' /mnt/ssd/tidepool; git -C /mnt/ssd/tidepool rev-parse --git-dir 2>&1 | head -2; }

say "row8: human-only path arriving via merge back shows in the parent's gate delta"
rm -rf r8; git init -q -b main r8; cd r8
mkdir .claude; echo '{}' > .claude/settings.json; echo x > f; git add .; git commit -q -m base
F=$(git rev-parse HEAD)                       # fork source of task/P
git branch task/P; git branch task/C task/P   # child forks from parent
# variant ff: child changes the human-only path, parent has not moved -> mergeBackInto takes sourceTip
git checkout -q task/C; echo '{"a":1}' > .claude/settings.json; echo '{}' > .mcp.json; git add .; git commit -q -m child
C=$(git rev-parse HEAD); git checkout -q main
gate() { git --no-replace-objects diff-tree -r --raw -z --ignore-submodules=none --merge-base "$1" "$2" | tr '\0' '\n' | grep -v '^:' | tr '\n' ' '; }
git update-ref refs/heads/task/P "$C"
echo "ff variant: gate delta(F, P) paths = [$(gate $F task/P)]"
# variant merge: parent moved too -> merge-tree --write-tree oldTip sourceTip ; commit-tree -p oldTip -p sourceTip
git update-ref refs/heads/task/P "$F"; git checkout -q task/P; echo y > g; git add g; git commit -q -m parent-work; git checkout -q main
OLD=$(git rev-parse task/P); TREE=$(git merge-tree --write-tree "$OLD" "$C"); echo "merge-tree rc=$? tree=${TREE:0:7}"
M=$(git commit-tree "$TREE" -p "$OLD" -p "$C" -m "Merge task/C into task/P"); git update-ref refs/heads/task/P "$M"
echo "merge variant: gate delta(F, P) paths = [$(gate $F task/P)]"
# control: main advanced with a human-only change (not from the task) and parent merged main -> should NOT show
git checkout -q main; echo '{"m":1}' > .mcp.json 2>/dev/null; mkdir -p .codex; echo 'x=1' > .codex/config.toml; git add .; git commit -q -m main-human
git branch task/Q "$F"; git checkout -q task/Q; echo q > q; git add q; git commit -q -m q; git merge -q --no-edit main; git checkout -q main
echo "control (Q merged main that carries .codex/config.toml): gate delta(main, Q) = [$(gate main task/Q)]  gate delta(F, Q) = [$(gate $F task/Q)]"
cd ..

say "row9 setup: bare origin (stand-in for GitHub), board pushes A then B, outside rewinds to A"
rm -rf r9; mkdir r9; cd r9; git init -q --bare -b main origin.git
git init -q -b main board; cd board; echo 1 > f; git add f; git commit -q -m base; git checkout -q -b task/root; echo A > f; git commit -q -am A; A=$(git rev-parse HEAD)
git remote add origin ../origin.git; git push -q origin main task/root; echo B > f; git commit -q -am B; B=$(git rev-parse HEAD); git push -q origin task/root; cd ..
echo "A=${A:0:7} B=${B:0:7} origin task/root=$(git -C origin.git rev-parse --short task/root)"
cd ..

say "row6 setup: repos with N keep-around refs (distinct unreachable commits)"
rm -rf ka; mkdir ka; cd ka
git init -q -b main src; cd src; for i in $(seq 1 60); do echo $i > f$((i%7)); git add .; git commit -q -m "c$i"; done; cd ..
git init -q --bare -b main upstream.git; git -C src push -q ../upstream.git main
for N in 0 500 5000; do
  git clone -q upstream.git ka$N; cd ka$N; git config receive.denyCurrentBranch updateInstead
  T=$(git rev-parse 'HEAD^{tree}'); P=$(git rev-parse HEAD~30)
  s=$(date +%s)
  for i in $(seq 1 $N); do c=$(git commit-tree $T -p $P -m "dropped $i"); echo "create refs/keep-around/$c $c"; done | git update-ref --stdin
  echo "ka$N: refs=$(git for-each-ref | wc -l) keep-around=$(git for-each-ref refs/keep-around | wc -l) build=$(( $(date +%s)-s ))s loose=$(git count-objects | cut -d' ' -f1) packed-refs=$( [ -f .git/packed-refs ] && wc -l < .git/packed-refs || echo none) for-each-ref: $(ms git for-each-ref)"
  cd ..
done
# upstream gains 1 commit; each kaN fetches (board fetch into the named place): count 'have' lines
cd src; echo new > newf; git add .; git commit -q -m upstream-new; git push -q ../upstream.git main; cd ..
for N in 0 500 5000; do
  cd ka$N
  s=$(date +%s%N); GIT_TRACE_PACKET=$PWD/../trace-fetch-$N git fetch -q origin 2>/dev/null; e=$(( ($(date +%s%N)-s)/1000000 ))
  echo "ka$N fetch from upstream (1 new commit): ${e}ms haves=$(grep -c 'fetch> have' ../trace-fetch-$N) wants=$(grep -c 'fetch> want' ../trace-fetch-$N)"
  s=$(date +%s%N); git fetch -q origin 2>/dev/null; echo "ka$N no-op fetch: $(( ($(date +%s%N)-s)/1000000 ))ms"
  s=$(date +%s%N); git clone -q . ../wk$N 2>/dev/null; echo "ka$N local clone (worker-like): $(( ($(date +%s%N)-s)/1000000 ))ms refs-in-clone=$(git -C ../wk$N for-each-ref | wc -l)"
  echo "ka$N status: $(ms git status)  rev-list --all: $(ms git rev-list --all)  gc --auto: $(ms git gc --auto)"
  cd ..
done
echo; echo "## host done"
