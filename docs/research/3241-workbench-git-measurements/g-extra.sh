#!/bin/bash
# follow-up: row6 with the board's fetch spellings + packed refs; non-cone sparse; #3188 claims; 4-03 natural form
set -u; ROOT=$1; W=$ROOT/extra; rm -rf "$W"; mkdir -p "$W"; cd "$W"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid LC_ALL=C GIT_CONFIG_NOSYSTEM=1
echo "# $(hostname) $(git --version)"
t3() { local out=""; for i in 1 2 3; do local s=$(date +%s%N); "$@" >/dev/null 2>&1; out="$out $(( ($(date +%s%N)-s)/1000000 ))"; done; echo "$out ms"; }
git init -q -b main src; cd src; for i in $(seq 1 60); do echo $i > f$((i%7)); git add .; git commit -q -m "c$i"; done; cd ..
git init -q --bare -b main up.git; git -C src push -q ../up.git main
for N in 0 500 5000; do
  git clone -q up.git ka$N; cd ka$N; T=$(git rev-parse 'HEAD^{tree}'); P=$(git rev-parse HEAD~30)
  for i in $(seq 1 $N); do c=$(git commit-tree $T -p $P -m "dropped $i"); echo "create refs/keep-around/$c $c"; done | git update-ref --stdin
  cd ..
done
cd src; echo new > newf; git add .; git commit -q -m new; NEW=$(git rev-parse HEAD); git push -q ../up.git main; cd ..
# board repo stand-in: bare repo holding the new commit at refs/board/fetched (hop1's result), and a worker-copy repo holding a task tip
git init -q --bare board.git; git -C src push -q ../board.git HEAD:refs/board/fetched
for pass in loose packed; do
  for N in 0 500 5000; do
    rm -rf k; cp -r ka$N k; cd k
    [ $pass = packed ] && git pack-refs --all
    tips=$(git for-each-ref --format='--negotiation-tip=%(objectname)' refs/remotes/origin | tr '\n' ' ')
    echo "[$pass] N=$N for-each-ref:$(t3 git for-each-ref) | rev-parse HEAD:$(t3 git rev-parse HEAD)"
    # hop2 spelling (src/github-auth.ts:308): local, no dst
    s=$(date +%s%N); GIT_TRACE_PACKET=$W/tr git fetch --quiet --no-auto-gc --no-recurse-submodules ../board.git refs/board/fetched 2>/dev/null; e=$(( ($(date +%s%N)-s)/1000000 )); echo "[$pass] N=$N hop2 fetch (object new): ${e}ms haves=$(grep -c 'fetch> have' $W/tr) | again (object present):$(t3 git fetch --quiet --no-auto-gc --no-recurse-submodules ../board.git refs/board/fetched)"
    cd ..; rm -rf k; cp -r ka$N k; cd k; [ $pass = packed ] && git pack-refs --all
    # hop1 shape (src/github-auth.ts:305): --negotiation-tip = origin copies, dst given (here into this repo; the board uses a separate empty repo)
    s=$(date +%s%N); GIT_TRACE_PACKET=$W/tr2 git fetch --quiet $tips ../up.git $NEW:refs/board/fetched 2>/dev/null; e=$(( ($(date +%s%N)-s)/1000000 )); echo "[$pass] N=$N fetch with --negotiation-tip=<origin copies>: ${e}ms haves=$(grep -c 'fetch> have' $W/tr2)"
    cd ..; rm -rf k; cp -r ka$N k; cd k; [ $pass = packed ] && git pack-refs --all
    s=$(date +%s%N); GIT_TRACE_PACKET=$W/tr3 git fetch --quiet origin 2>/dev/null; e=$(( ($(date +%s%N)-s)/1000000 )); echo "[$pass] N=$N plain fetch origin (human's spelling): ${e}ms haves=$(grep -c 'fetch> have' $W/tr3)"
    cd ..
  done
done
rm -rf k

echo; echo "## non-cone sparse workbench + updateInstead (local path push; receiver is this host's git)"
git init -q -b main np; cd np; mkdir -p dirA dirB .claude; echo a > dirA/a; echo b > dirB/b; echo '{}' > .claude/settings.json; git add .; git commit -q -m base; git branch task/H; cd ..
git init -q --template= -b scratch wbs; cd wbs; git fetch -q ../np task/H:refs/heads/task/H
git config core.sparseCheckout true; git config core.sparseCheckoutCone false; mkdir -p .git/info; printf '/*\n!/.claude/settings.json\n' > .git/info/sparse-checkout
git checkout -q task/H; git config receive.denyCurrentBranch updateInstead; echo "worktree: $(find . -path ./.git -prune -o -type f -print | sort | tr '\n' ' ')"; cd ..
git clone -q np own; cd own; git checkout -q task/H; git remote add wb ../wbs
for step in "echo x >> dirA/a|inside patterns" "echo '{\"x\":1}' > .claude/settings.json|excluded path changed" ; do eval "${step%%|*}"; git commit -q -am s; git push -q wb task/H 2>&1 | tail -1; echo "push (${step##*|}): rc=${PIPESTATUS[0]} remote status=[$(git -C ../wbs status --porcelain | tr '\n' ';')] settings in worktree=$(test -f ../wbs/.claude/settings.json && echo y || echo n) S-bits=$(git -C ../wbs ls-files -t | grep -c '^S')"; done
cd ..

echo; echo "## #3188: alternates checkout sees later objects; sha-named merge; sparse-excluded path changed by the return target"
git clone -q --shared --no-checkout np co; cd co; git config core.sparseCheckout true; git config core.sparseCheckoutCone false; printf '/*\n!/.claude/settings.json\n' > .git/info/sparse-checkout; git checkout -q -b task/C origin/task/H; echo c > c; git add c; git commit -q -m child
cd ../np; echo '{"human":1}' > .claude/settings.json; echo m > m; git add .; git commit -q -m target-moved; TGT=$(git rev-parse HEAD); cd ../co
echo "object added to the named place after the checkout is visible: $(git cat-file -t $TGT 2>&1)"
git merge -q --no-edit $TGT 2>&1 | tail -1; echo "merge <sha> rc=${PIPESTATUS[0]} status=[$(git status --porcelain | tr '\n' ';')] settings materialised=$(test -f .claude/settings.json && echo y || echo n) S-bit=$(git ls-files -t .claude/settings.json) tip blob==target blob: $([ $(git rev-parse HEAD:.claude/settings.json) = $(git rev-parse $TGT:.claude/settings.json) ] && echo y || echo n)"
BASE=$(git -C ../np rev-parse main)
echo "gate delta(target now, tip) = [$(git --no-replace-objects diff-tree -r --raw -z --ignore-submodules=none --merge-base $BASE HEAD | tr '\0' '\n' | grep -v '^:' | tr '\n' ' ')]"
cd ..

echo; echo "## 4-03 natural form: outside rewrites the head from the base (drops A's file), local merges it cleanly"
git init -q --bare -b main o.git; git init -q -b main n2; cd n2; echo 1 > f; git add f; git commit -q -m b; git remote add origin ../o.git; git push -q origin main; git checkout -q -b task/r; echo a > a; git add a; git commit -q -m A; git push -q origin task/r
git clone -q ../o.git ../out2; (cd ../out2; git checkout -q -B task/r origin/main; echo x > x; git add x; git commit -q -m X; git push -q -f origin task/r)
git fetch -q origin; git merge -q --no-edit origin/task/r; echo "merge rc=$? files: $(ls | tr '\n' ' ') (a = dropped by the outside push)"
echo "# extra done"
