#!/usr/bin/env bash
# scripts/deploy-pi.sh — sync tidepool source to /opt/tidepool and restart the
# service. Mirrors the sinano1107/context-vault-infra deploy.sh pattern:
# the git-tracked source checkout (exFAT on the Pi — weak on symlinks/exec
# bits/native module builds) syncs to /opt, the npm-installed runtime copy on
# the Pi's native filesystem.
#
# Run this ON THE PI, from the source checkout (any path — see SRC below).

set -euo pipefail

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# The documented invocation (SKILL.md) is `sudo bash scripts/deploy-pi.sh`
# from masaki's own checkout, so git ops against the deploy source below run
# as masaki (via `sudo -u`), not root: root has no ssh-agent/credential
# helper for `fetch`, and a root-owned git process touching a masaki-owned
# checkout trips git's dubious-ownership guard (safe.directory) even for a
# read-only rev-parse. Only downgrades when $SUDO_USER is actually set (we
# were invoked via sudo, same as every real deploy) — a plain root shell or
# an unprivileged `source` (tests) runs git as the current user, unchanged.
# -n: this inner sudo runs inside a non-interactive ssh session — without it
# a stray password prompt would hang the deploy instead of failing it.
# -H: pins HOME to masaki's home. sudo does not reliably repoint HOME to the
# target user by itself (depends on env_reset/always_set_home), and without
# it git would look for ~/.gitconfig / ~/.ssh / credential helpers under
# root's home, where masaki's credentials aren't.
src_git() {
  if [[ "$(id -u)" -eq 0 && -n "${SUDO_USER:-}" ]]; then
    sudo -n -u "$SUDO_USER" -H git "$@"
  else
    git "$@"
  fi
}

# SRC is derived from this script's own location, not hardcoded (issue #167):
# a checkout that moves off /mnt/ssd/tidepool must keep working, and
# preflight() below must inspect the actual deploy source, wherever it is.
# BASH_SOURCE[0], not $0, so this also resolves correctly when the script is
# sourced (scripts/deploy-pi.test.sh) rather than executed directly. The
# `|| fail` must sit on the assignment (not inside the substitution) so
# `exit 1` runs in this shell, not a subshell errexit silently swallows.
SRC="$(src_git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)" \
  || fail "cannot derive deploy source from $(dirname "${BASH_SOURCE[0]}") — not a git checkout"
DST="/opt/tidepool"
SERVICE="tidepool"
PROTECTED_BRANCH="main"
UNIT_SRC="$SRC/systemd/$SERVICE.service"
UNIT_DST="/etc/systemd/system/$SERVICE.service"

# preflight() closes the hole ADR 0040 identifies but cannot close from the
# board side: the rsync *source* is never a workspace the board's own
# overlap guard can see, so a task-branch commit (or a stray uncommitted
# edit) sitting in $SRC would ride an ordinary human deploy straight to
# production, skipping PR review entirely. Fail-closed on any of the three
# checks — issue #167.
preflight() {
  local branch head origin_head

  branch="$(src_git -C "$SRC" rev-parse --abbrev-ref HEAD)"
  [[ "$branch" == "$PROTECTED_BRANCH" ]] \
    || fail "deploy source is on branch '$branch', not '$PROTECTED_BRANCH' — refusing to deploy an unreviewed branch"

  [[ -z "$(src_git -C "$SRC" status --porcelain)" ]] \
    || fail "deploy source has uncommitted changes — refusing to deploy a dirty working tree"

  src_git -C "$SRC" fetch -q origin "$PROTECTED_BRANCH" \
    || fail "git fetch origin $PROTECTED_BRANCH failed"
  head="$(src_git -C "$SRC" rev-parse HEAD)"
  origin_head="$(src_git -C "$SRC" rev-parse "origin/$PROTECTED_BRANCH")"
  [[ "$head" == "$origin_head" ]] \
    || fail "deploy source HEAD ($head) does not match origin/$PROTECTED_BRANCH ($origin_head) — push or pull before deploying"

  log "preflight ok: $SRC is on $PROTECTED_BRANCH, clean, matches origin/$PROTECTED_BRANCH"
}

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

# this invocation's journal only — never let a transient `sudo journalctl`
# hiccup under set -e kill the poll loop, just treat it as "no lines yet"
journal_lines() {
  sudo journalctl "_SYSTEMD_INVOCATION_ID=$INVOCATION_ID" --no-pager 2>/dev/null || true
}

verify_fail() {
  sudo systemctl status "$SERVICE.service" --no-pager -l | tail -30 || true
  journal_lines | tail -30 || true
  fail "$1"
}

verify() {
  local waited=0
  while (( waited < VERIFY_TIMEOUT )); do
    if journal_lines | grep -qF "$VERIFY_LOG_PATTERN"; then
      log "active: $SERVICE (listening)"
      return 0
    fi

    if sudo systemctl is-failed --quiet "$SERVICE.service" 2>/dev/null; then
      verify_fail "$SERVICE entered failed state during startup"
    fi

    # a transient `systemctl show` failure must not kill the loop under set -e
    # (fail() is a bad enough surprise on its own without this contributing);
    # an empty/non-numeric read just skips this iteration's crash-loop check
    local current_nrestarts
    current_nrestarts="$(sudo systemctl show -p NRestarts --value "$SERVICE.service" 2>/dev/null)" || current_nrestarts=""
    if [[ "$current_nrestarts" =~ ^[0-9]+$ ]] && (( current_nrestarts > PRE_RESTART_NRESTARTS )); then
      verify_fail "$SERVICE crash-looped during startup (NRestarts $PRE_RESTART_NRESTARTS -> $current_nrestarts)"
    fi

    sleep "$VERIFY_POLL_INTERVAL"
    waited=$(( waited + VERIFY_POLL_INTERVAL ))
  done

  verify_fail "$SERVICE did not report listening within ${VERIFY_TIMEOUT}s"
}

main() {
  preflight
  sync_app
  sync_unit
  restart
  verify
}

# guarded so scripts/deploy-pi.test.sh can `source` this file and exercise
# verify()/verify_fail() in isolation without running the real deploy
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
