#!/usr/bin/env bash
# Post-deploy health check for tidepool on the Pi. Run from the dev machine
# (SSHes in itself). Exits non-zero and dumps diagnostics on any failure.
set -uo pipefail

PI="masaki@100.78.52.97"
PUBLIC_URL="https://raspberrypi.tailc0084f.ts.net:8443"

log() { printf '\033[1;34m[verify]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; }

failed=0

check_service() {
  local name="$1"
  if ssh "$PI" "systemctl is-active --quiet $name"; then
    log "active: $name"
  else
    fail "$name is not active"
    ssh "$PI" "sudo systemctl status $name --no-pager -l | tail -20"
    failed=1
  fi
}

check_service tidepool.service
check_service context-vault-mcp.service
check_service context-vault-auth.service

# The class of failure this catches: `deploy-pi.sh` restarts the service
# unconditionally, so a stale/unpushed source tree still passes every health
# check below (the OLD code is healthy too) — this is the only check that
# actually confirms the deployed commit is the one just worked on, not
# whatever the Pi's clone happened to have last time someone pushed.
local_head=$(git rev-parse HEAD)
pi_head=$(ssh "$PI" "cd /mnt/ssd/tidepool && git rev-parse HEAD")
log "commit: local HEAD=$local_head  Pi HEAD=$pi_head"
if [[ "$local_head" != "$pi_head" ]]; then
  fail "Pi is not on this machine's HEAD — were local commits pushed before deploying?"
  fail "  git log origin/main..HEAD   (anything listed there hasn't been pushed)"
  failed=1
fi

# Unauthenticated, on purpose (issue #154 / ADR 0036). The old check asked for
# 200 over the tailnet URL, which needed a token in transit and proved only that
# *something* answers. A 401 proves two things at once with no secret carried:
# the listener is alive AND the credential middleware is actually in front of it.
#
# A 200 here is a production incident, not a stale expectation: it means the
# board fail-opened (lost or unusable token hash — ADR 0036). Worker pickup will
# already be halted board-wide with a standing question, so read the board.
code=$(ssh "$PI" "curl -sk -o /dev/null -w '%{http_code}' $PUBLIC_URL/")
log "GET  $PUBLIC_URL/ (no credential) -> $code"
[[ "$code" == "401" ]] || {
  fail "tidepool WebUI answered $code to an unauthenticated request, expected 401"
  [[ "$code" == "200" ]] && fail "  200 = the human surface is OPEN — check the board's standing containment question and \`npm run token\`"
  failed=1
}

code=$(ssh "$PI" "curl -sk -o /dev/null -w '%{http_code}' $PUBLIC_URL/api/tasks")
log "GET  $PUBLIC_URL/api/tasks (no credential) -> $code"
[[ "$code" == "401" ]] || {
  fail "tidepool API answered $code to an unauthenticated request, expected 401"
  failed=1
}

# /mcp and the WebUI/API port must both stay 127.0.0.1-only — if either shows
# up on 0.0.0.0 here, MCP tool calls (or unauthenticated API writes) would be
# reachable from the whole tailnet, not just via tailscale serve's own proxy.
bindings=$(ssh "$PI" "sudo ss -tlnp | grep -E ':4589|:4590'")
log "port bindings:"
echo "$bindings"
if echo "$bindings" | grep -qE '0\.0\.0\.0:(4589|4590)'; then
  fail "tidepool port bound to 0.0.0.0 — should be 127.0.0.1-only"
  failed=1
fi

serve_status=$(ssh "$PI" "sudo tailscale serve status")
log "tailscale serve status:"
echo "$serve_status"
echo "$serve_status" | grep -q ":8443 (tailnet only)" || { fail "tidepool's tailnet-only serve entry (8443) is missing"; failed=1; }
echo "$serve_status" | grep -q "Funnel on" || { fail "context-vault's Funnel entry is missing — unrelated regression?"; failed=1; }

if [[ "$failed" == "0" ]]; then
  log "all checks passed"
else
  fail "one or more checks failed — see output above"
  exit 1
fi
