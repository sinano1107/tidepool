#!/usr/bin/env bash
# The in-session half of tidepool's interview-room canary (issue #2197 / ADR 0273).
#
# English rather than this repo's usual Japanese for a `scripts/` file, on
# purpose: this header is read by the worker session that runs the probe, which
# makes it agent-facing text.
#
# THIS IS TIDEPOOL'S OWN REGRESSION CHECK. The board's owner runs it to confirm
# that, from this directory, a session can still read a second checkout (the
# "real environment"), cannot write to it, and can work and commit here, after a
# CLI or OS update. The write into the real environment and the read of the home
# file are EXPECTED to be refused by the operating system; a refusal is the
# passing result, and the refusal's wording is the data being collected. The
# other lines are ordinary work the same session must be able to do. Each line is
# attempted exactly once and whatever comes back is printed. Nothing here tries to
# get around a refusal or retries.
#
# The paths come from ./interview-room-targets, which the canary writes next to
# this file.
set -u
. ./interview-room-targets

row() {
  local name="$1" out rc
  shift
  out=$("$@" 2>&1)
  rc=$?
  echo "INTERVIEW-ROOM $name rc=$rc $(head -n1 <<< "$out")"
}

# expected: succeed (read the real environment)
row real-env-log git -C "$REAL_ENV" log -1 --format=%H
row real-env-cat cat "$REAL_FILE"
# expected: refused by the OS
row real-env-write sh -c 'echo x > "$1"' _ "$REAL_WRITE"
# expected: succeed (work and commit here)
row room-git sh -c 'echo ok > interview-room.txt && git add interview-room.txt && git commit -qm interview-room-canary && git log -1 --format=%s'
# expected: refused by the OS
row home cat "$HOME_FILE"
# expected: succeed
row task-temp mktemp
if [[ "$ALLOWED_DOMAIN" == "yes" ]]; then
  row allowed-domain curl -sS -o /dev/null --max-time 15 -w 'code=%{http_code}' https://registry.npmjs.org
fi
