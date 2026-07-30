#!/usr/bin/env bash
# End-to-end smoke test: registers a real work task, forces immediate pickup
# (registration alone does NOT trigger the scheduler — see
# references/troubleshooting.md), waits for the default agent (tako) to run it via the real
# `claude` CLI, and prints the handoff doc. Costs one real agent session.
#
# The task can't be deleted afterward (events table is append-only by DB
# trigger, on purpose). This script prefixes the title with
# "[deploy verification <date>]" up front so it never needs cleaning up.
#
# CREDENTIAL (issue #153 / ADR 0036). Unlike verify-deploy.sh — which now asserts
# a 401 and therefore carries no secret at all — this script *writes* to the
# board, so it needs the real token. The board stores only a hash and cannot
# reproduce it, so the operator supplies it:
#
#     TIDEPOOL_TOKEN=<token> bash .../smoke-test.sh
#
# Two deliberate choices about how it travels:
#
#   - Over the tailnet URL from this machine, not `ssh $PI curl localhost`. The
#     token then never lands on the Pi at all — the host that runs workers.
#   - Into curl via `--config` on stdin, never `-H` on the command line. argv is
#     world-visible in `ps`, and #151 means a `work`-profile worker's Read tool
#     has no path floor to stop it looking.
set -euo pipefail

PI="masaki@100.78.52.97"
BOARD="https://raspberrypi.tailc0084f.ts.net:8443"
TIMEOUT_S="${1:-90}"
DATE_TAG=$(date +%Y-%m-%d)

if [[ -z "${TIDEPOOL_TOKEN:-}" ]]; then
  echo "[smoke-test] TIDEPOOL_TOKEN is not set." >&2
  echo "[smoke-test]   The board keeps only a hash of it, so it cannot be read off the Pi." >&2
  echo "[smoke-test]   Use the token you already hold, or rotate: ssh $PI 'cd /opt/tidepool && sudo -u masaki npm run token'" >&2
  echo "[smoke-test]   (rotating invalidates every live cookie and the management MCP header —" >&2
  echo "[smoke-test]    see docs/human-surface-credential.md)" >&2
  exit 2
fi

# `--config -` keeps the header out of argv; -k because tailscale serve's cert
# chain is the tailnet's own, same as verify-deploy.sh
board_curl() {
  printf 'header = "Authorization: Bearer %s"\n' "$TIDEPOOL_TOKEN" | curl -sk --config - "$@"
}

echo "[smoke-test] registering task..."
TASK_JSON=$(board_curl -X POST "$BOARD/api/tasks" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"work\",\"title\":\"[deploy verification $DATE_TAG] smoke test\",\"purpose\":\"Confirm the board can pick up and run a trivial task after deployment.\",\"completion_criteria\":\"Create a file smoke-test.txt containing the text ok, commit it, and complete the task.\"}")

TASK_ID=$(echo "$TASK_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])') || {
  echo "[smoke-test] could not read a task id out of the board's reply:" >&2
  echo "$TASK_JSON" >&2
  echo "[smoke-test] a 401 here means TIDEPOOL_TOKEN is stale — rotate and retry." >&2
  exit 1
}
echo "[smoke-test] task id: $TASK_ID"

echo "[smoke-test] forcing immediate pickup (move-to-front triggers onQueueHeadChanged -> scheduler.pollNow)..."
board_curl -X POST "$BOARD/api/tasks/$TASK_ID/move" \
  -H 'Content-Type: application/json' -d '{"after":null}' > /dev/null

echo "[smoke-test] waiting up to ${TIMEOUT_S}s for completion..."
end=$(( $(date +%s) + TIMEOUT_S ))
status=""
while [ "$(date +%s)" -lt "$end" ]; do
  status=$(board_curl "$BOARD/api/tasks/$TASK_ID" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  if [ "$status" != "todo" ] && [ "$status" != "in_progress" ]; then
    echo "[smoke-test] final status: $status"
    break
  fi
  sleep 3
done

if [ "$status" = "todo" ] || [ "$status" = "in_progress" ]; then
  echo "[smoke-test] TIMED OUT still $status — check:"
  echo "[smoke-test]   ssh $PI 'journalctl -u tidepool.service -f'"
  echo "[smoke-test]   throttle_state (see troubleshooting.md)"
  # A board-wide halt looks exactly like a throttle from out here, so name the
  # other cause: an unmet containment capability (ADR 0033 / ADR 0036, issue
  # #154) stops every pickup and stands one Tidepool-attributed question.
  echo "[smoke-test]   a standing 'worker containment is not established' question (containment-canary.sh, npm run token)"
  exit 1
fi

board_curl "$BOARD/api/tasks/$TASK_ID" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("status:", d["status"]); print(); print(d["handoff_doc"] or "(no handoff doc)")'
