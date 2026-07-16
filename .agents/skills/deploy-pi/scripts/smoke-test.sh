#!/usr/bin/env bash
# End-to-end smoke test: registers a real work task, forces immediate pickup
# (registration alone does NOT trigger the scheduler — see
# references/troubleshooting.md), waits for the default agent (tako) to run it via the real
# `claude` CLI, and prints the handoff doc. Costs one real agent session.
#
# The task can't be deleted afterward (events table is append-only by DB
# trigger, on purpose). This script prefixes the title with
# "[deploy verification <date>]" up front so it never needs cleaning up.
set -euo pipefail

PI="masaki@100.78.52.97"
TIMEOUT_S="${1:-90}"
DATE_TAG=$(date +%Y-%m-%d)

echo "[smoke-test] registering task..."
TASK_JSON=$(ssh "$PI" "curl -s -X POST http://127.0.0.1:4589/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{\"type\":\"work\",\"title\":\"[deploy verification $DATE_TAG] smoke test\",\"purpose\":\"Confirm the board can pick up and run a trivial task after deployment.\",\"completion_criteria\":\"Create a file smoke-test.txt containing the text ok, commit it, and complete the task.\"}'")

TASK_ID=$(echo "$TASK_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')
echo "[smoke-test] task id: $TASK_ID"

echo "[smoke-test] forcing immediate pickup (move-to-front triggers onQueueHeadChanged -> scheduler.pollNow)..."
ssh "$PI" "curl -s -X POST http://127.0.0.1:4589/api/tasks/$TASK_ID/move -H 'Content-Type: application/json' -d '{\"after\":null}'" > /dev/null

echo "[smoke-test] waiting up to ${TIMEOUT_S}s for completion..."
ssh "$PI" "
end=\$((\$(date +%s) + $TIMEOUT_S))
while [ \$(date +%s) -lt \$end ]; do
  status=\$(curl -s http://127.0.0.1:4589/api/tasks/$TASK_ID | python3 -c 'import json,sys; print(json.load(sys.stdin)[\"status\"])')
  if [ \"\$status\" != \"todo\" ] && [ \"\$status\" != \"in_progress\" ]; then
    echo \"[smoke-test] final status: \$status\"
    exit 0
  fi
  sleep 3
done
echo '[smoke-test] TIMED OUT still in_progress/todo — check: journalctl -u tidepool.service -f, and throttle_state (see troubleshooting.md)'
exit 1
"

ssh "$PI" "curl -s http://127.0.0.1:4589/api/tasks/$TASK_ID | python3 -c 'import json,sys; d=json.load(sys.stdin); print(\"status:\", d[\"status\"]); print(); print(d[\"handoff_doc\"] or \"(no handoff doc)\")'"
