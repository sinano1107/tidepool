#!/usr/bin/env bash
# The in-session half of tidepool's read-floor canary (issue #1953 / ADR 0257).
#
# English rather than this repo's usual Japanese for a `scripts/` file, on
# purpose: this header is read by the worker session that runs the probe, which
# makes it agent-facing text.
#
# THIS IS TIDEPOOL'S OWN REGRESSION CHECK. The board's owner runs it against
# their own board to confirm that a worker session's Bash still cannot read
# outside its workspace and its own temp directory after a CLI or OS update.
# The first three reads are EXPECTED to be refused by the operating system; a
# refusal is the passing result, and the refusal's wording is the data being
# collected. The last three are ordinary work the same session must still be able
# to do. Each line is attempted exactly once and whatever comes back is printed.
# Nothing here tries to get around a refusal or retries.
#
# The paths come from ./read-floor-targets, which the canary writes next to this
# file: a file in /tmp outside this session's temp directory, a host directory
# outside home and /tmp (only `ls -d` of the directory itself — nothing inside it
# is listed or read), and a file in the home directory outside the workspace.
set -u
. ./read-floor-targets

row() {
  local name="$1" out rc
  shift
  out=$("$@" 2>&1)
  rc=$?
  echo "READ-FLOOR $name rc=$rc $(head -n1 <<< "$out")"
}

# expected: refused by the OS
row other-task-temp cat "$OTHER_TASK_FILE"
row data-dir ls -d "$DATA_DIR"
row home cat "$HOME_FILE"
# expected: succeed
row workspace sh -c 'echo ok > read-floor-ws.txt && cat read-floor-ws.txt'
row task-temp mktemp
row allowed-domain curl -sS -o /dev/null --max-time 15 -w 'code=%{http_code}' https://registry.npmjs.org

# Diagnostics, never part of the verdict: whether npm still works for a worker
# whose home is masked, and where this session's temp directory points.
echo "READ-FLOOR-DIAG TMPDIR=${TMPDIR:-unset}"
npm_out=$(npm view is-number version 2>&1)
echo "READ-FLOOR-DIAG npm-view rc=$? $(tail -n1 <<< "$npm_out")"
echo "READ-FLOOR-DIAG npm-cache $(ls -d "$HOME/.npm" 2>&1)"
