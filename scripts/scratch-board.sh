#!/usr/bin/env bash
# scripts/scratch-board.sh — stand up a throwaway board on the dev machine,
# with every piece of state in a scratch directory. For work that needs a real
# `claude` worker session against real board verbs (capturing a transcript
# fixture, reproducing a spawn-path bug) without touching the production Pi.
#
#   bash scripts/scratch-board.sh [base-dir]
#
# It prints the board URL, its token, and the two calls that get a task
# running. Stop it with the printed pkill line; the base dir is yours to keep
# or delete.
#
# THE SOURCE IS THIS CHECKOUT, AS IT STANDS. The board runs `tsx src/main.ts`
# from here, so check out the commit you mean first — the printed commit is
# the only thing that says which code answered. Nothing is written into the
# checkout: DB, worker-logs, token and workspaces all resolve to absolute
# paths under the base dir.
#
# Three things this script exists to get right, each of which fails in a way
# that does not name itself:
#
#   1. The board reads the registry from `refs/remotes/origin/main`, never the
#      working tree (loadRegistry / ADR 0052). Editing workspaces.yaml in a
#      clone therefore does nothing. So the scratch registry is a bare mirror
#      plus a working clone that pushes into it — the push is what moves the
#      ref the board actually reads.
#   2. The `/usage` scrape (ADR 0028) spawns the CLI in a PTY at
#      `process.cwd()`. In a directory the CLI has never been trusted in, that
#      spawn returns nothing, `checkUsage` hands back null, and the board goes
#      fail-closed throttled with no pickup and no error naming the cause —
#      which is why the board is launched with this checkout as its cwd rather
#      than from a fresh clone.
#   3. A workspace has to be a git repo with a commit before a task can run in
#      it (ADR 0064: the task branch is the worker's only mutable ref).
#
# A fourth thing it deliberately does NOT do: clear the throttle. The pace
# line (ADR 0030) is read off the real account, so a board that is up can
# still sit at `todo` for hours. `POST /api/settings/pace-offsets` and
# `POST /api/spend-down` are the levers, and spending the human's quota is
# their call, not this script's.

set -euo pipefail

log() { printf '\033[1;34m[scratch-board]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

SRC=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
BASE=${1:-${TMPDIR:-/tmp}/tidepool-scratch-board}
REGISTRY_SRC=${REGISTRY_SRC:-$HOME/tidepool-registry}
PORT=${PORT:-4789}

[ -d "$REGISTRY_SRC/.git" ] || fail "no registry clone at $REGISTRY_SRC (set REGISTRY_SRC)"
[ -e "$BASE" ] && fail "$BASE already exists — delete it or pass another base dir"

log "source:   $SRC @ $(git -C "$SRC" rev-parse --short HEAD) ($(git -C "$SRC" rev-parse --abbrev-ref HEAD))"
log "base dir: $BASE"

mkdir -p "$BASE/state" "$BASE/workspaces"

# (1) registry: bare mirror + a clone that pushes into it, so the ref the
# board reads carries the rewritten host paths.
git clone -q --bare "$REGISTRY_SRC" "$BASE/registry.git"
git clone -q "$BASE/registry.git" "$BASE/registry"
python3 - "$BASE" <<'PY'
import re, sys
base = sys.argv[1]
path = f"{base}/registry/workspaces.yaml"
text = open(path, encoding="utf-8").read()
# every entry's path is host-specific (the file says so itself); point the one
# workspace a scratch run uses at the base dir and leave the rest alone
text = re.sub(r"^(\s+)path: .*/sandbox$", rf"\g<1>path: {base}/workspaces/sandbox", text, flags=re.M)
open(path, "w", encoding="utf-8").write(text)
PY
git -C "$BASE/registry" -c user.email=scratch@local -c user.name=scratch \
  commit -qam "chore: point the sandbox workspace at this scratch host"
git -C "$BASE/registry" push -q origin main

# (3) the workspace itself
git init -q -b main "$BASE/workspaces/sandbox"
printf '# sandbox\n\nthrowaway workspace for a scratch board run.\n' > "$BASE/workspaces/sandbox/README.md"
git -C "$BASE/workspaces/sandbox" add -A
git -C "$BASE/workspaces/sandbox" -c user.email=scratch@local -c user.name=scratch \
  commit -qm "chore: seed the scratch sandbox workspace"

export PORT MCP_PORT=$((PORT + 1))
export TIDEPOOL_REGISTRY="$BASE/registry"
export TIDEPOOL_WORKSPACES_DIR="$BASE/workspaces"
export TIDEPOOL_DB="$BASE/state/board.sqlite"
export TIDEPOOL_WORKER_LOGS="$BASE/state/worker-logs"
export TIDEPOOL_API_TOKEN_FILE="$BASE/state/token"
export TIDEPOOL_PUBLIC_ORIGINS="http://127.0.0.1:$PORT"

TOKEN=$(cd "$SRC" && npx tsx scripts/token.ts | grep -o 'token=[A-Za-z0-9_-]*' | head -1 | cut -d= -f2)
[ -n "$TOKEN" ] || fail "could not mint a board token"

# (2) cwd is this checkout, not $BASE — see the header.
(cd "$SRC" && nohup npx tsx src/main.ts > "$BASE/state/board.log" 2>&1 &)

for _ in $(seq 1 30); do
  curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/queue" && break
  sleep 1
done
curl -sf -o /dev/null -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/queue" \
  || fail "board did not answer — see $BASE/state/board.log"

cat <<EOF

$(log "up at http://127.0.0.1:$PORT")

  export T=$TOKEN B=http://127.0.0.1:$PORT

  # register a task, then move it to the head — registration alone does not
  # trigger pickup
  curl -s -X POST -H "Authorization: Bearer \$T" -H 'Content-Type: application/json' \\
    -d '{"type":"work","title":"…","purpose":"…","completion_criteria":"…"}' "\$B/api/tasks"
  curl -s -X POST -H "Authorization: Bearer \$T" -H 'Content-Type: application/json' \\
    -d '{"after":null}' "\$B/api/tasks/<id>/move"

  transcripts  $BASE/state/worker-logs/<task>.<spawn-event>.stream.jsonl
  events       sqlite3 $BASE/state/board.sqlite 'select * from events'
  board log    $BASE/state/board.log
  stop         pkill -f 'tsx src/main.ts'

EOF
