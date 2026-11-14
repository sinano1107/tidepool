#!/bin/bash
# Mac side over ssh: row 6 (fetch from / push into repos with keep-around refs), row 9, board/* non-ff re-point.
set -u
LABEL=$1; HOST=$2; ROOT=$3; CFG=${4:-}
if [ -n "$CFG" ]; then SSHC="ssh -F $CFG -o BatchMode=yes"; else SSHC="ssh -o BatchMode=yes"; fi
export GIT_SSH_COMMAND="$SSHC"
export GIT_AUTHOR_NAME=t3241 GIT_AUTHOR_EMAIL=t3241@example.invalid GIT_COMMITTER_NAME=t3241 GIT_COMMITTER_EMAIL=t3241@example.invalid
S=/private/tmp/claude-501/-Users-<user>-tidepool/11f133ec-41f4-41cb-8567-0e25e54d2c23/scratchpad
C=$S/client2-$LABEL; rm -rf "$C"; mkdir -p "$C"; cd "$C"
URL="ssh://$HOST$ROOT"
say() { echo; echo "## $*"; }
now() { python3 -c 'import time;print(int(time.time()*1000))'; }
try() { echo "\$ $*"; "$@" 2>&1 | sed 's/^/    /'; local rc=${PIPESTATUS[0]}; echo "    => exit $rc"; return $rc; }
say "[$LABEL] sender $(git --version) / receiver $($SSHC $HOST git --version); ssh round trip: $(s=$(now); $SSHC $HOST true; echo $(( $(now)-s ))ms)"

say "row6 over ssh: clone/fetch FROM kaN and push INTO kaN"
for N in 0 500 5000; do
  s=$(now); git clone -q "$URL/ka/ka$N" c$N 2>/dev/null; e1=$(( $(now)-s ))
  cd c$N
  s=$(now); GIT_TRACE_PACKET=$C/tr-fetch-$N git fetch -q origin 2>/dev/null; e2=$(( $(now)-s ))
  git checkout -q -b side; echo p$N > pushed; git add pushed; git commit -q -m push
  s=$(now); GIT_TRACE_PACKET=$C/tr-push-$N git push -q origin side 2>/dev/null; rc=$?; e3=$(( $(now)-s ))
  echo n >> pushed; git commit -q -am push2
  s=$(now); git push -q origin side 2>/dev/null; e4=$(( $(now)-s ))
  # push to the checked-out branch with updateInstead
  git checkout -q main; git merge -q --ff-only origin/main 2>/dev/null; echo m > m$N; git add .; git commit -q -m onmain
  s=$(now); git push -q origin main 2>/dev/null; rc5=$?; e5=$(( $(now)-s ))
  echo "ka$N: clone ${e1}ms refs-in-clone=$(git for-each-ref | wc -l | tr -d ' ') | no-op fetch ${e2}ms adv-lines=$(grep -c 'fetch< [0-9a-f]\{40\} refs/' $C/tr-fetch-$N) keep-around-in-fetch-adv=$(grep -c 'fetch<.*refs/keep-around' $C/tr-fetch-$N) | push new branch ${e3}ms rc=$rc adv-lines=$(grep -c 'push< [0-9a-f]\{40\}' $C/tr-push-$N) keep-around-in-push-adv=$(grep -c 'push<.*refs/keep-around' $C/tr-push-$N) | 2nd push ${e4}ms | updateInstead push to main ${e5}ms rc=$rc5"
  cd ..
done

say "row9: human clone over ssh has B; origin rewound to A from outside; push B back without force"
git clone -q "$URL/r9/origin.git" human; cd human
git checkout -q task/root; B=$(git rev-parse HEAD); A=$(git rev-parse HEAD~1)
$SSHC $HOST "git -C $ROOT/r9/origin.git update-ref refs/heads/task/root $A && echo origin rewound to \$(git -C $ROOT/r9/origin.git rev-parse --short task/root)"
try git push origin task/root
$SSHC $HOST "echo origin task/root=\$(git -C $ROOT/r9/origin.git rev-parse --short task/root)"; echo "B=${B:0:7}"
say "row9 variant: clone never checked out task/root (only the remote-tracking ref holds B), origin rewound; push the tracking ref"
cd ..; git clone -q "$URL/r9/origin.git" human2; cd human2
$SSHC $HOST "git -C $ROOT/r9/origin.git update-ref refs/heads/task/root $A"
try git push origin refs/remotes/origin/task/root:refs/heads/task/root
say "row9 variant: same, but the human fetched first (tracking ref forced back to A); B only by sha"
$SSHC $HOST "git -C $ROOT/r9/origin.git update-ref refs/heads/task/root $A"
try git fetch origin
echo "tracking=$(git rev-parse --short origin/task/root) B object present: $(git cat-file -t $B 2>&1)"
try git push origin $B:refs/heads/task/root
say "row9 variant: fresh clone made after the rewind (no B object)"
$SSHC $HOST "git -C $ROOT/r9/origin.git update-ref refs/heads/task/root $A"
cd ..; git clone -q "$URL/r9/origin.git" human3; cd human3; echo "B object: $(git cat-file -t $B 2>&1 | head -1)"
try git push origin $B:refs/heads/task/root
say "row9 variant: origin rewound AND advanced with a different commit (diverged) -> pushing B"
cd ../human; $SSHC $HOST "cd $ROOT/r9 && rm -rf x && git clone -q origin.git x && cd x && git checkout -q -B task/root $A && echo X > f && git -c user.name=o -c user.email=o@example.invalid commit -q -am X && git push -q -f origin task/root && echo origin=\$(git rev-parse --short HEAD)"
try git push origin task/root

say "row4 supplement: board re-points board/base non-fast-forward on the host; default fetch follows"
cd "$C"; git init -q -b main own; cd own; git remote add wb "$URL/wb"; git fetch -q wb
echo "before: $(git rev-parse --short wb/board/base)"
$SSHC $HOST "cd $ROOT/wb && git update-ref refs/heads/board/base \$(git rev-parse task/H~3) && git rev-parse --short board/base"
try git fetch wb
echo; echo "## client done [$LABEL]"
