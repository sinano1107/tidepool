#!/usr/bin/env bash
# Unit tests for verify()/verify_fail() in deploy-pi.sh (issue #98 regression
# guard). Runs entirely without a real Pi/systemd: sudo/systemctl/journalctl
# are stubbed here and deploy-pi.sh is sourced (not executed) so its
# functions can be called directly against the stubs.
#
# This only exercises verify()'s control flow (log-line success, failed-unit
# abort, crash-loop abort, timeout). It does not replace the Pi smoke test in
# .agents/skills/deploy-pi/scripts/smoke-test.sh or the manual "verify"
# section in issue #98 (real journalctl filtering, real sudo permissions).
#
# Run: bash scripts/deploy-pi.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- stub state ------------------------------------------------------------
# ITER counts verify() poll iterations (bumped once per journalctl call,
# which verify() calls first each loop). *_AT thresholds say "from this
# iteration onward, the stub reports X"; empty means "never".
#
# ITER lives in a file, not a shell variable: `sudo journalctl ... | grep`
# runs the journalctl side of that pipe in a subshell, so a plain variable
# increment there would be invisible to the next loop iteration.

ITER_FILE="$(mktemp)"
trap 'rm -f "$ITER_FILE"' EXIT
BASE_NRESTARTS=5
LOG_APPEARS_AT=""
FAILED_AT=""
NRESTARTS_AT=""

sleep() { :; } # keep the timeout test fast; verify()'s only use of sleep

next_iter() {
  local n
  n=$(($(cat "$ITER_FILE") + 1))
  echo "$n" > "$ITER_FILE"
  echo "$n"
}

fake_journalctl() {
  local iter
  iter=$(next_iter)
  if [[ -n "$LOG_APPEARS_AT" ]] && (( iter >= LOG_APPEARS_AT )); then
    echo "tidepool listening on http://127.0.0.1:4589"
  else
    echo "some unrelated startup line"
  fi
}

fake_systemctl() {
  local sub="$1"; shift
  case "$sub" in
    show)
      local prop=""
      while [[ $# -gt 0 ]]; do
        case "$1" in
          -p) prop="$2"; shift 2 ;;
          *) shift ;;
        esac
      done
      case "$prop" in
        NRestarts)
          local iter
          iter=$(cat "$ITER_FILE")
          if [[ -n "$NRESTARTS_AT" ]] && (( iter >= NRESTARTS_AT )); then
            echo "$((BASE_NRESTARTS + 1))"
          else
            echo "$BASE_NRESTARTS"
          fi
          ;;
        InvocationID) echo "fake-invocation-id" ;;
      esac
      ;;
    is-failed)
      local iter
      iter=$(cat "$ITER_FILE")
      if [[ -n "$FAILED_AT" ]] && (( iter >= FAILED_AT )); then
        return 0
      fi
      return 1
      ;;
    status) echo "fake status output" ;;
    *) : ;;
  esac
}

sudo() {
  local cmd="$1"; shift
  case "$cmd" in
    systemctl) fake_systemctl "$@" ;;
    journalctl) fake_journalctl "$@" ;;
    *) : ;;
  esac
}

# --- load deploy-pi.sh as functions only ------------------------------------

source "$SCRIPT_DIR/deploy-pi.sh"

# --- test framework ----------------------------------------------------------

PASS=0
FAIL=0

reset_state() {
  echo 0 > "$ITER_FILE"
  LOG_APPEARS_AT=""
  FAILED_AT=""
  NRESTARTS_AT=""
  PRE_RESTART_NRESTARTS="$BASE_NRESTARTS"
  INVOCATION_ID="fake-invocation-id"
}

# run_verify sets $rc and $output; must not let verify()'s internal `exit 1`
# (via fail()) kill this test script, and must not trip our own set -e.
run_verify() {
  output=$(verify 2>&1) && rc=0 || rc=$?
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
    echo "ok - $desc"
  else
    FAIL=$((FAIL + 1))
    echo "not ok - $desc (expected [$expected], got [$actual])"
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    PASS=$((PASS + 1))
    echo "ok - $desc"
  else
    FAIL=$((FAIL + 1))
    echo "not ok - $desc (expected output to contain [$needle])"
    echo "  --- actual output ---"
    echo "$haystack" | sed 's/^/  /'
  fi
}

# --- cases ---------------------------------------------------------------

reset_state
LOG_APPEARS_AT=2
run_verify
assert_eq "success: exit 0 once listening log appears" "0" "$rc"
assert_contains "success: logs 'active'" "active:" "$output"

reset_state
FAILED_AT=1
run_verify
assert_eq "failed unit: exit 1" "1" "$rc"
assert_contains "failed unit: reason mentions failed state" "entered failed state" "$output"

reset_state
NRESTARTS_AT=1
run_verify
assert_eq "crash loop: exit 1" "1" "$rc"
assert_contains "crash loop: reason mentions NRestarts" "crash-looped" "$output"

reset_state
run_verify
assert_eq "timeout: exit 1 when nothing ever happens" "1" "$rc"
assert_contains "timeout: reason mentions timeout" "did not report listening" "$output"

# --- summary ---------------------------------------------------------------

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
