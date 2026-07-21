#!/usr/bin/env bash
# scripts/deploy-pi.sh — sync tidepool source to /opt/tidepool and restart the
# service. Mirrors the sinano1107/context-vault-infra deploy.sh pattern:
# /mnt/ssd holds the git-tracked source (exFAT — weak on symlinks/exec bits/
# native module builds), /opt holds the npm-installed runtime copy on the
# Pi's native filesystem.
#
# Run this ON THE PI, from the /mnt/ssd/tidepool checkout.

set -euo pipefail

SRC="/mnt/ssd/tidepool"
DST="/opt/tidepool"
SERVICE="tidepool"
UNIT_SRC="$SRC/systemd/$SERVICE.service"
UNIT_DST="/etc/systemd/system/$SERVICE.service"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

sync_app() {
  [[ -d "$SRC" ]] || fail "missing source: $SRC"
  sudo mkdir -p "$DST"
  log "sync $SRC/ -> $DST/"
  # board.sqlite / data / worker-logs are runtime state, not part of the
  # deploy payload — never let --delete remove them across redeploys.
  sudo rsync -a --delete \
    --exclude=node_modules --exclude=.env --exclude='.env.*' \
    --exclude=data --exclude=worker-logs --exclude=board.sqlite \
    --exclude=.git \
    "$SRC/" "$DST/"
  sudo chown -R masaki:masaki "$DST"
  log "npm install ($DST)"
  # tsx runs src/*.ts directly (no build step) — devDependencies are required
  # at runtime, unlike context-vault's --omit=dev plain-JS services.
  (cd "$DST" && sudo -u masaki npm install --no-audit --no-fund)
  sudo -u masaki mkdir -p "$DST/data" "$DST/worker-logs"
}

sync_unit() {
  [[ -f "$UNIT_SRC" ]] || fail "missing unit source: $UNIT_SRC"
  if ! sudo cmp -s "$UNIT_SRC" "$UNIT_DST" 2>/dev/null; then
    log "unit changed: $SERVICE.service"
    sudo install -m 0644 "$UNIT_SRC" "$UNIT_DST"
    sudo systemctl daemon-reload
  fi
}

restart() {
  log "restart $SERVICE"
  PRE_RESTART_NRESTARTS="$(sudo systemctl show -p NRestarts --value "$SERVICE.service")"
  sudo systemctl restart "$SERVICE.service"
  INVOCATION_ID="$(sudo systemctl show -p InvocationID --value "$SERVICE.service")"
}

# verify() waits for the "tidepool listening on" line (src/main.ts, near the
# server startup call) to show up in this invocation's journal, instead of a
# fixed sleep + is-active check — that log line is the direct proof the
# process reached a listening state, not just "still running so far". Do not
# rename/remove that log line in src/ without updating VERIFY_LOG_PATTERN here.
VERIFY_LOG_PATTERN='tidepool listening on'
VERIFY_TIMEOUT=30
VERIFY_POLL_INTERVAL=1

verify_fail() {
  sudo systemctl status "$SERVICE.service" --no-pager -l | tail -30 || true
  sudo journalctl "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" --no-pager | tail -30 || true
  fail "$1"
}

verify() {
  local waited=0
  while (( waited < VERIFY_TIMEOUT )); do
    if sudo journalctl "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" --no-pager 2>/dev/null \
        | grep -qF "$VERIFY_LOG_PATTERN"; then
      log "active: $SERVICE (listening)"
      return 0
    fi

    if sudo systemctl is-failed --quiet "$SERVICE.service" 2>/dev/null; then
      verify_fail "$SERVICE entered failed state during startup"
    fi

    local current_nrestarts
    current_nrestarts="$(sudo systemctl show -p NRestarts --value "$SERVICE.service")"
    if (( current_nrestarts > PRE_RESTART_NRESTARTS )); then
      verify_fail "$SERVICE crash-looped during startup (NRestarts $PRE_RESTART_NRESTARTS -> $current_nrestarts)"
    fi

    sleep "$VERIFY_POLL_INTERVAL"
    waited=$(( waited + VERIFY_POLL_INTERVAL ))
  done

  verify_fail "$SERVICE did not report listening within ${VERIFY_TIMEOUT}s"
}

main() {
  sync_app
  sync_unit
  restart
  verify
}

main "$@"
