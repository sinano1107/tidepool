#!/bin/bash
# rows 1-4: updateInstead push over ssh, dirty/non-ff, sparse, hooks, board/* fetch.
# usage: a-workbench.sh <label> <ssh-host> <remote-root> [ssh -F config]
set -u
LABEL=$1; HOST=$2; ROOT=$3; CFG=${4:-}
if [ -n "$CFG" ]; then SSHC="ssh -F $CFG -o BatchMode=yes"; else SSHC="ssh -o BatchMode=yes"; fi
export GIT_SSH_COMMAND="$SSHC"
S=/private/tmp/claude-501/-Users-<user>-tidepool/11f133ec-41f4-41cb-8567-0e25e54d2c23/scratchpad
C=$S/client-$LABEL; rm -rf "$C"; mkdir -p "$C"
R() { $SSHC "$HOST" bash -s; }
G="git -c user.name=t3241 -c user.email=t3241@example.invalid"
PRE="set -u; g() { git -c user.name=t3241 -c user.email=t3241@example.invalid \"\$@\"; }; cd $ROOT"
say() { echo; echo "## $*"; }
try() { echo "\$ $*"; "$@" 2>&1 | sed 's/^/    /'; local rc=${PIPESTATUS[0]}; echo "    => exit $rc"; return $rc; }

say "[$LABEL] versions: sender $(git --version) / receiver $($SSHC $HOST git --version)"

say "setup remote: named place np, workbench wb (--template=), wbtpl (template with active hooks), wbsparse"
R <<EOF
$PRE
rm -rf np wb wbtpl wbsparse tpl marker; mkdir -p tpl/hooks
g init -q -b main np && cd np
mkdir -p dirA dirB && echo a > dirA/a.txt && echo b > dirB/b.txt && echo r > root.txt
g add . && g commit -q -m base
g branch task/H && g branch other
cd ..
for h in pre-receive update post-receive post-update reference-transaction; do
  printf '#!/bin/sh\necho %s >> $ROOT/marker\n' \$h > tpl/hooks/\$h; chmod +x tpl/hooks/\$h
done
mk() { # name template-arg
  g init -q \$2 -b scratch \$1 && cd \$1
  g fetch -q ../np task/H:refs/heads/task/H main:refs/heads/board/base other:refs/heads/board/incoming
  g checkout -q task/H
  g config receive.denyCurrentBranch updateInstead
  cd ..
}
mk wb --template=
mk wbtpl --template=$ROOT/tpl
mk wbsparse --template=
cd wbsparse && g sparse-checkout set --cone dirA && cd ..
echo "wb hooks dir: \$(ls wb/.git/hooks 2>&1 | tr '\n' ' ')"
echo "wbtpl hooks: \$(ls wbtpl/.git/hooks | tr '\n' ' ')"
echo "wbsparse worktree: \$(cd wbsparse && find . -path ./.git -prune -o -type f -print | tr '\n' ' ')"
rm -f marker
EOF

say "row4: remote add + default fetch brings board/* and task/H"
cd "$C" && $G init -q -b main own && cd own
URL="ssh://$HOST$ROOT"
try git remote add wb "$URL/wb"
try git fetch wb
try git for-each-ref --format='%(refname) %(objectname:short)'
git config --get-all remote.wb.fetch

say "row1: push to checked-out task/H (clean worktree)"
$G checkout -q -b task/H wb/task/H
echo c1 >> dirA/a.txt; $G commit -q -am c1
try git push wb task/H
R <<EOF
$PRE; cd wb; echo "HEAD=\$(git rev-parse --short HEAD) branch=\$(git symbolic-ref --short HEAD)"; echo "status: [\$(git status --porcelain)]"; echo "a.txt: \$(tr '\n' ' ' < dirA/a.txt)"; ls $ROOT/marker 2>&1
EOF

dirty() { # desc, remote-prep, local-change
  say "row1 dirty: $1"
  R <<EOF
$PRE; cd wb; $2; echo "remote status before: [\$(git status --porcelain | tr '\n' ';')]"
EOF
  cd "$C/own"; eval "$3"; try git push wb task/H; local rc=$?
  R <<EOF
$PRE; cd wb; echo "remote HEAD=\$(git rev-parse --short HEAD) status after: [\$(git status --porcelain | tr '\n' ';')]"
git reset -q --hard; git clean -qfd
EOF
  # make the two sides agree again
  if [ $rc -ne 0 ]; then try git push wb task/H; fi
}
dirty "unrelated tracked file modified, unstaged (push touches dirA/a.txt)" "echo x >> root.txt" "echo c2 >> dirA/a.txt; $G commit -q -am c2"
dirty "unrelated tracked file modified AND staged" "echo x >> root.txt; git add root.txt" "echo c3 >> dirA/a.txt; $G commit -q -am c3"
dirty "same file modified unstaged" "echo x >> dirA/a.txt" "echo c4 >> dirA/a.txt; $G commit -q -am c4"
dirty "untracked unrelated file" "echo u > untracked.txt" "echo c5 >> dirA/a.txt; $G commit -q -am c5"
dirty "untracked file colliding with a pushed new path" "echo u > newfile.txt" "echo n > newfile.txt; $G add newfile.txt; $G commit -q -m c6"

say "row1 non-ff: amend then push without force, then with --force"
cd "$C/own"; $G commit -q --amend -m c6-amended
try git push wb task/H
try git push --force wb task/H
R <<EOF
$PRE; cd wb; echo "remote HEAD=\$(git rev-parse --short HEAD) subject=\$(git log -1 --format=%s) status: [\$(git status --porcelain)]"
EOF

say "row1 fallback shape: push to another branch name, then host-side merge --ff-only"
echo c7 >> dirA/a.txt; $G commit -q -am c7
try git push wb task/H:refs/heads/incoming/H
R <<EOF
$PRE; cd wb; g merge --ff-only incoming/H 2>&1 | tail -1; echo "remote HEAD=\$(git rev-parse --short HEAD)"
EOF
try git fetch wb

say "row4: can the own clone push into refs/heads/board/*? and delete it?"
try git push wb task/H:refs/heads/board/base
try git push wb :refs/heads/board/incoming
R <<EOF
$PRE; cd wb; git for-each-ref --format='%(refname) %(objectname:short)'
EOF

say "row4: board re-points board/base non-ff on the host; default fetch follows; push of task/H still works"
R <<EOF
$PRE; cd wb; git update-ref refs/heads/board/base \$(git rev-parse other 2>/dev/null || git -C ../np rev-parse main); git update-ref refs/heads/board/incoming \$(git -C ../np rev-parse other); git fetch -q ../np main:refs/heads/board/base 2>&1; git for-each-ref refs/heads/board --format='%(refname) %(objectname:short)'
EOF
try git fetch wb
echo c8 >> dirA/a.txt; $G commit -q -am c8
try git push wb task/H
try git push wb
git config push.default; git rev-parse --abbrev-ref task/H@{upstream} 2>&1

say "row3: hooks — wb (--template=) marker after all pushes above"
R <<EOF
$PRE; ls -la marker 2>&1; ls wb/.git/hooks 2>&1
EOF
say "row3 positive control: same push into wbtpl (template carries active hooks)"
cd "$C/own"; try git remote add wbtpl "$URL/wbtpl"
try git push wbtpl task/H
R <<EOF
$PRE; echo "marker: \$(tr '\n' ' ' < marker 2>&1)"; echo "wbtpl HEAD=\$(git -C wbtpl rev-parse --short HEAD)"
EOF

say "row2: sparse (cone dirA) workbench — push inside cone, outside cone, new file outside cone"
cd "$C/own"; try git remote add wbsparse "$URL/wbsparse"
sp() {
  say "row2: $1"; cd "$C/own"; eval "$2"; try git push wbsparse task/H
  R <<EOF
$PRE; cd wbsparse; echo "HEAD=\$(git rev-parse --short HEAD) status: [\$(git status --porcelain | tr '\n' ';')]"; echo "files: \$(find . -path ./.git -prune -o -type f -print | sort | tr '\n' ' ')"; echo "sparse: \$(git sparse-checkout list | tr '\n' ' ') skip-worktree count: \$(git ls-files -t | grep -c '^S')"
EOF
}
sp "catch-up push (all commits so far; touches dirA only + newfile.txt at root)" ":"
sp "change outside cone (dirB/b.txt)" "echo s1 >> dirB/b.txt; $G commit -q -am s1"
sp "new file outside cone (dirC/c.txt)" "mkdir -p dirC; echo c > dirC/c.txt; $G add dirC; $G commit -q -m s2"
sp "inside cone (dirA/a.txt)" "echo s3 >> dirA/a.txt; $G commit -q -am s3"
say "row2: sparse + dirty file outside cone materialised by hand on the host"
R <<EOF
$PRE; cd wbsparse; mkdir -p dirB; echo stray > dirB/b.txt; echo "status: [\$(git status --porcelain | tr '\n' ';')]"
EOF
cd "$C/own"; echo s4 >> dirB/b.txt; $G commit -q -am s4; try git push wbsparse task/H
R <<EOF
$PRE; cd wbsparse; echo "HEAD=\$(git rev-parse --short HEAD) status: [\$(git status --porcelain | tr '\n' ';')]"; cat dirB/b.txt 2>&1 | tr '\n' ' '
EOF
echo; echo "## done [$LABEL]"
