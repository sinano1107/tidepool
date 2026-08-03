#!/usr/bin/env bash
# Unit tests for preflight() and SRC derivation in deploy-pi.sh (issue
# #167). Builds real git repos under a tmp dir for each case — a bare
# "origin" plus a working checkout that plays the role of $SRC — and
# sources deploy-pi.sh into a fresh `bash -c` subprocess per case (same
# isolation pattern as deploy-pi.test.sh's run_verify).
#
# Two groups:
#   - preflight() cases override SRC after sourcing, so the script's own
#     SRC auto-derivation (this repo's toplevel) doesn't leak into the case
#     under test. Covers the three checks: protected-branch, clean-worktree,
#     HEAD-matches-origin/main.
#   - SRC-derivation cases do the opposite: they copy deploy-pi.sh into a
#     throwaway checkout elsewhere and source it unmodified, to prove SRC
#     follows the script's own location rather than a hardcoded path.
#
# Neither group touches sync_app/sync_unit/restart/verify, and neither needs
# sudo/systemd/Pi.
#
# Run: bash scripts/deploy-pi-preflight.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PASS=0
FAIL=0

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

# make_repo builds a fresh bare "origin" plus a "main"-branch checkout
# cloned from it, one commit deep and pushed — the shape preflight() must
# accept as-is. Each case starts from this and then breaks exactly one
# check.
make_repo() {
  local case_dir="$1" origin checkout
  origin="$case_dir/origin.git"
  checkout="$case_dir/checkout"
  git init -q --bare "$origin"
  git clone -q "$origin" "$checkout" 2>/dev/null
  (
    cd "$checkout"
    git config user.email test@example.invalid
    git config user.name test
    git checkout -q -b main
    echo hello > file.txt
    git add file.txt
    git commit -q -m init
    git push -q -u origin main
  )
  echo "$checkout"
}

# run_preflight sources deploy-pi.sh in a separate subprocess (real errexit,
# same reasoning as deploy-pi.test.sh's run_verify), then overrides SRC to
# the case's checkout — sourcing itself re-derives SRC from this script's
# own location first, which must not leak into the case under test.
run_preflight() {
  local checkout="$1"
  export SCRIPT_DIR TEST_SRC="$checkout"
  output=$(bash -c 'set -euo pipefail; source "$SCRIPT_DIR/deploy-pi.sh"; SRC="$TEST_SRC"; preflight' 2>&1) && rc=0 || rc=$?
}

# --- cases -----------------------------------------------------------------

case_dir="$WORK_DIR/success"; mkdir -p "$case_dir"
checkout="$(make_repo "$case_dir")"
run_preflight "$checkout"
assert_eq "success: exit 0 on main, clean, matching origin/main" "0" "$rc"
assert_contains "success: logs preflight ok" "preflight ok" "$output"

case_dir="$WORK_DIR/wrong-branch"; mkdir -p "$case_dir"
checkout="$(make_repo "$case_dir")"
(cd "$checkout" && git checkout -q -b feature)
run_preflight "$checkout"
assert_eq "wrong branch: exit 1" "1" "$rc"
assert_contains "wrong branch: reason names the actual branch" "'feature'" "$output"
assert_contains "wrong branch: reason names the protected branch" "not 'main'" "$output"

case_dir="$WORK_DIR/dirty"; mkdir -p "$case_dir"
checkout="$(make_repo "$case_dir")"
echo dirty >> "$checkout/file.txt"
run_preflight "$checkout"
assert_eq "dirty worktree: exit 1" "1" "$rc"
assert_contains "dirty worktree: reason mentions uncommitted changes" "uncommitted changes" "$output"

case_dir="$WORK_DIR/diverged"; mkdir -p "$case_dir"
checkout="$(make_repo "$case_dir")"
(cd "$checkout" && git commit -q --allow-empty -m "local-only, never pushed")
run_preflight "$checkout"
assert_eq "diverged from origin/main: exit 1" "1" "$rc"
assert_contains "diverged from origin/main: reason names origin/main" "does not match origin/main" "$output"

# --- SRC derivation ("works from any path", the other half of issue #167) --
#
# Copies deploy-pi.sh, unmodified, into a throwaway checkout and sources it
# from an unrelated cwd — proving SRC comes from the script's own location
# (`git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel`), not
# a hardcoded /mnt/ssd/tidepool.

case_dir="$WORK_DIR/derivation"
mkdir -p "$case_dir/scripts"
cp "$SCRIPT_DIR/deploy-pi.sh" "$case_dir/scripts/deploy-pi.sh"
(
  cd "$case_dir"
  git init -q
  git config user.email test@example.invalid
  git config user.name test
  git add scripts/deploy-pi.sh
  git commit -q -m init
)
expected_toplevel="$(git -C "$case_dir" rev-parse --show-toplevel)"

derived_absolute="$(cd / && SCRIPT_PATH="$case_dir/scripts/deploy-pi.sh" \
  bash -c 'set -euo pipefail; source "$SCRIPT_PATH"; printf %s "$SRC"')"
assert_eq "SRC derivation: follows the script's own checkout, not a hardcoded path" \
  "$expected_toplevel" "$derived_absolute"

# the shape the Pi actually uses: `cd <checkout> && sudo bash scripts/deploy-pi.sh`
derived_relative="$(cd "$case_dir" && SCRIPT_PATH="scripts/deploy-pi.sh" \
  bash -c 'set -euo pipefail; source "$SCRIPT_PATH"; printf %s "$SRC"')"
assert_eq "SRC derivation: also resolves via a relative invocation path" \
  "$expected_toplevel" "$derived_relative"

# --- summary -----------------------------------------------------------------

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
