#!/usr/bin/env bash
# Tests for scripts/mac-install.sh and scripts/vm-board.sh (issue #484).
# Same shape as scripts/deploy-pi.test.sh: stubs record every external
# command, each case sources the script into a fresh `bash -c` subprocess so
# its `set -e` is real, and the summary is PASS/FAIL counts.
#
# What is pinned here is external behaviour at the command boundary: which
# commands run, in what order, and which are skipped on a second run. No real
# `limactl` is ever reached — PATH inside each case is the stub dir plus
# /usr/bin:/bin only, never Homebrew's, because this Mac has a real Lima
# instance named `tidepool` that a stray call would restart.
#
# Provisioning itself is not covered: the template's scripts are exercised by
# the real acceptance run (#482), not here.
#
# Run: bash scripts/mac-install.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

DEFAULT_TEMPLATE_URL="https://raw.githubusercontent.com/sinano1107/tidepool/main/lima/tidepool.yaml"

PASS=0
FAIL=0

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    PASS=$((PASS + 1))
    echo "ok - $desc"
  else
    FAIL=$((FAIL + 1))
    echo "not ok - $desc"
    echo "  --- expected ---"
    echo "$expected" | sed 's/^/  /'
    echo "  --- actual ---"
    echo "$actual" | sed 's/^/  /'
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
    echo "  --- actual ---"
    echo "$haystack" | sed 's/^/  /'
  fi
}

assert_not_contains() {
  local desc="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    PASS=$((PASS + 1))
    echo "ok - $desc"
  else
    FAIL=$((FAIL + 1))
    echo "not ok - $desc (expected output NOT to contain [$needle])"
    echo "  --- actual ---"
    echo "$haystack" | sed 's/^/  /'
  fi
}

# --- stubs -----------------------------------------------------------------
# Every stub appends its invocation to $CMD_LOG (a file, not a variable: the
# installer reads stub output through `$(...)`, which runs in a subshell where
# a variable assignment would be lost). VM-side commands are only ever reached
# through `limactl shell`, so the limactl stub answers them by matching the
# inner command string against the case's state variables.

write_stubs() {
  cat > "$STUB_DIR/uname" <<'STUB'
#!/bin/bash
echo "uname $*" >> "$CMD_LOG"
if [ "${1:-}" = "-m" ]; then echo "$UNAME_M"; fi
exit 0
STUB

  cat > "$STUB_DIR/brew" <<'STUB'
#!/bin/bash
echo "brew $*" >> "$CMD_LOG"
if [ "${1:-}" = "install" ] && [ "${2:-}" = "lima" ]; then
  cp "$LIMACTL_SRC" "$STUB_DIR/limactl"
  chmod +x "$STUB_DIR/limactl"
fi
exit 0
STUB

  # Held aside rather than installed: `brew install lima` copies it into place,
  # so the fresh case can prove the installer really goes through Homebrew.
  cat > "$LIMACTL_SRC" <<'STUB'
#!/bin/bash
sub="$1"; shift
case "$sub" in
  list)
    echo "limactl list $*" >> "$CMD_LOG"
    [ "$INSTANCE_EXISTS" = "1" ] || exit 1
    echo "$INSTANCE_STATUS"
    ;;
  start)
    echo "limactl start $*" >> "$CMD_LOG"
    ;;
  shell)
    name="$1"; shift
    shift # --
    shift # bash
    shift # -lc
    cmd="$1"
    echo "vm($name) $cmd" >> "$CMD_LOG"
    case "$cmd" in
      "gh auth status")
        [ "$GH_LOGGED_IN" = "1" ] || exit 1 ;;
      "claude auth status --json")
        if [ "$CLAUDE_LOGGED_IN" = "1" ]; then
          echo '{"loggedIn": true, "account": "someone@example.com"}'
        else
          echo '{"loggedIn": false}'
        fi ;;
      "git config --global user.name && git config --global user.email")
        [ "$GIT_IDENTITY_SET" = "1" ] || exit 1
        echo "Existing Name"
        echo "existing@example.com" ;;
      "gh api user"*)
        printf 'testlogin\t4242\tTest User\n' ;;
      "gh repo view "*)
        [ "$REGISTRY_REPO_EXISTS" = "1" ] || exit 1 ;;
      *"test -d"*)
        [ "$REGISTRY_CLONED" = "1" ] || exit 1 ;;
      *"ls-remote --heads origin")
        if [ "$REGISTRY_SEEDED" = "1" ]; then echo "abc123	refs/heads/main"; fi ;;
      *) : ;;
    esac
    ;;
  *)
    echo "limactl $sub $*" >> "$CMD_LOG"
    ;;
esac
exit 0
STUB
}

# --- case setup ------------------------------------------------------------

CASE_N=0
reset_case() {
  CASE_N=$((CASE_N + 1))
  CASE_DIR="$WORK_DIR/case$CASE_N"
  STUB_DIR="$CASE_DIR/bin"
  LIMACTL_SRC="$CASE_DIR/limactl.src"
  CMD_LOG="$CASE_DIR/cmd.log"
  mkdir -p "$STUB_DIR"
  : > "$CMD_LOG"

  UNAME_M="arm64"
  BREW_INSTALLED=1
  LIMA_INSTALLED=0
  INSTANCE_EXISTS=0
  INSTANCE_STATUS="Running"
  GH_LOGGED_IN=0
  CLAUDE_LOGGED_IN=0
  GIT_IDENTITY_SET=0
  REGISTRY_REPO_EXISTS=0
  REGISTRY_CLONED=0
  REGISTRY_SEEDED=0
  EXTRA_ENV=""
  STDIN_PIPE=0
}

# run_install sets $rc, $output and $log. main() runs as a bare top-level
# command in a separate subprocess (deploy-pi.test.sh's run_verify pattern) so
# a `set -e` abort inside it is not suspended by this script's own `||` capture.
run_install() {
  write_stubs
  chmod +x "$STUB_DIR"/*
  if [ "$BREW_INSTALLED" != "1" ]; then rm -f "$STUB_DIR/brew"; fi
  if [ "$LIMA_INSTALLED" = "1" ]; then
    cp "$LIMACTL_SRC" "$STUB_DIR/limactl"
    chmod +x "$STUB_DIR/limactl"
  fi

  if [ "$STDIN_PIPE" = "1" ]; then
    output=$(printf '' | run_main 2>&1) && rc=0 || rc=$?
  else
    output=$(run_main < /dev/null 2>&1) && rc=0 || rc=$?
  fi
  log="$(cat "$CMD_LOG")"
}

# run_main is split out so the caller can choose stdin: an unquoted
# "< /dev/null" in a variable would be words, not a redirection.
run_main() {
  env \
    PATH="$STUB_DIR:/usr/bin:/bin" \
    HOME="$CASE_DIR" \
    CMD_LOG="$CMD_LOG" \
    STUB_DIR="$STUB_DIR" \
    LIMACTL_SRC="$LIMACTL_SRC" \
    UNAME_M="$UNAME_M" \
    INSTANCE_EXISTS="$INSTANCE_EXISTS" \
    INSTANCE_STATUS="$INSTANCE_STATUS" \
    GH_LOGGED_IN="$GH_LOGGED_IN" \
    CLAUDE_LOGGED_IN="$CLAUDE_LOGGED_IN" \
    GIT_IDENTITY_SET="$GIT_IDENTITY_SET" \
    REGISTRY_REPO_EXISTS="$REGISTRY_REPO_EXISTS" \
    REGISTRY_CLONED="$REGISTRY_CLONED" \
    REGISTRY_SEEDED="$REGISTRY_SEEDED" \
    SCRIPT_DIR="$SCRIPT_DIR" \
    ${EXTRA_ENV} \
    bash -c 'set -euo pipefail; source "$SCRIPT_DIR/mac-install.sh"; main'
}

# --- precheck ---------------------------------------------------------------

reset_case
UNAME_M="x86_64"
run_install
assert_eq "precheck: non-arm64 Mac exits non-zero" "1" "$rc"
assert_contains "precheck: names Apple Silicon" "Apple Silicon" "$output"
assert_eq "precheck: stops before brew and limactl" "uname -m" "$log"

reset_case
BREW_INSTALLED=0
run_install
assert_eq "precheck: missing Homebrew exits non-zero" "1" "$rc"
assert_contains "precheck: names Homebrew" "Homebrew" "$output"
assert_eq "precheck: no limactl call without Homebrew" "uname -m" "$log"

reset_case
BREW_INSTALLED=0
run_install
assert_contains "precheck: names the GitHub account it will need" "GitHub" "$output"
assert_contains "precheck: names the Claude subscription it will need" "Claude" "$output"

# --- fresh Mac --------------------------------------------------------------
# The full order of operations, pinned as one exact log: this is the sequence
# ADR 0101 決定1 describes, and the only place it is written down as machine
# -checkable text.

reset_case
run_install
assert_eq "fresh: exits 0" "0" "$rc"
assert_eq "fresh: runs the whole sequence in order" "uname -m
brew install lima
limactl list --format {{.Status}} tidepool
limactl start --tty=false --progress --name tidepool $DEFAULT_TEMPLATE_URL
vm(tidepool) gh auth status
vm(tidepool) gh auth login --git-protocol https --web
vm(tidepool) gh auth setup-git
vm(tidepool) claude auth status --json
vm(tidepool) claude auth login
vm(tidepool) cd ~/tidepool && node scripts/seed-claude-trust.mjs ~/tidepool
vm(tidepool) gh api user --jq '[.login, .id, (.name // \"\")] | @tsv'
vm(tidepool) git config --global user.name && git config --global user.email
vm(tidepool) git config --global user.name \"Test User\"
vm(tidepool) git config --global user.email \"4242+testlogin@users.noreply.github.com\"
vm(tidepool) gh repo view testlogin/tidepool-registry
vm(tidepool) gh repo create testlogin/tidepool-registry --private
vm(tidepool) source ~/.tidepool/env && test -d \"\$TIDEPOOL_REGISTRY/.git\"
vm(tidepool) source ~/.tidepool/env && git clone https://github.com/testlogin/tidepool-registry.git \"\$TIDEPOOL_REGISTRY\"
vm(tidepool) source ~/.tidepool/env && git -C \"\$TIDEPOOL_REGISTRY\" ls-remote --heads origin
vm(tidepool) source ~/.tidepool/env && cd ~/tidepool && npm run init-registry" "$log"
assert_contains "fresh: prints the start line" \
  "caffeinate -i -s limactl shell tidepool -- ~/tidepool/scripts/vm-board.sh" "$output"
assert_contains "fresh: prints the update line" \
  "limactl shell tidepool --workdir ~/tidepool -- bash -lc 'git pull && npm install'" "$output"
assert_contains "fresh: prints the stop line" \
  "limactl shell tidepool -- systemctl --user stop tidepool-board.scope" "$output"
assert_contains "fresh: points at the first-boot bootstrap URL" "bootstrap" "$output"

# --- resume after an interruption -------------------------------------------

reset_case
LIMA_INSTALLED=1
INSTANCE_EXISTS=1
GH_LOGGED_IN=1
CLAUDE_LOGGED_IN=1
GIT_IDENTITY_SET=1
REGISTRY_REPO_EXISTS=1
REGISTRY_CLONED=1
run_install
assert_eq "resume: exits 0" "0" "$rc"
assert_not_contains "resume: does not reinstall Lima" "brew install" "$log"
assert_not_contains "resume: does not touch the existing VM" "limactl start" "$log"
assert_not_contains "resume: skips the gh login" "gh auth login" "$log"
assert_not_contains "resume: skips the claude login" "claude auth login" "$log"
assert_not_contains "resume: skips creating the registry repository" "gh repo create" "$log"
assert_not_contains "resume: skips cloning the registry" "git clone" "$log"
assert_not_contains "resume: leaves the existing git identity alone" 'user.name "' "$log"
assert_contains "resume: still seeds trust" "node scripts/seed-claude-trust.mjs" "$log"
assert_contains "resume: still seeds the unseeded registry" "npm run init-registry" "$log"

reset_case
LIMA_INSTALLED=1
INSTANCE_EXISTS=1
INSTANCE_STATUS="Stopped"
GH_LOGGED_IN=1
CLAUDE_LOGGED_IN=1
GIT_IDENTITY_SET=1
REGISTRY_REPO_EXISTS=1
REGISTRY_CLONED=1
REGISTRY_SEEDED=1
run_install
assert_contains "resume: restarts a stopped VM by name only" "limactl start tidepool" "$log"

# --- re-run on a finished setup ---------------------------------------------
# Usable as a "check my setup" command: nothing that creates or changes state
# runs. The trust seed is the deliberate exception — it is idempotent and
# cheap, so it is not state-checked (#442).

reset_case
LIMA_INSTALLED=1
INSTANCE_EXISTS=1
GH_LOGGED_IN=1
CLAUDE_LOGGED_IN=1
GIT_IDENTITY_SET=1
REGISTRY_REPO_EXISTS=1
REGISTRY_CLONED=1
REGISTRY_SEEDED=1
run_install
assert_eq "re-run: exits 0" "0" "$rc"
for mutating in "brew install" "limactl start" "gh auth login" "claude auth login" \
  'user.name "' "gh repo create" "git clone" "npm run init-registry"; do
  assert_not_contains "re-run: does not run [$mutating]" "$mutating" "$log"
done
assert_contains "re-run: still prints the start line" \
  "caffeinate -i -s limactl shell tidepool -- ~/tidepool/scripts/vm-board.sh" "$output"

# --- instance name and template overrides -----------------------------------

reset_case
EXTRA_ENV="TIDEPOOL_VM=other TIDEPOOL_TEMPLATE_URL=file:///tmp/branch.yaml"
run_install
assert_eq "override: exits 0" "0" "$rc"
assert_not_contains "override: never names the default instance" "tidepool)" "$log"
assert_not_contains "override: never names the default instance in limactl args" "--name tidepool" "$log"
assert_contains "override: starts the named instance from the given template" \
  "limactl start --tty=false --progress --name other file:///tmp/branch.yaml" "$log"
assert_contains "override: prints the start line for the named instance" \
  "caffeinate -i -s limactl shell other -- ~/tidepool/scripts/vm-board.sh" "$output"

# --- curl | bash ------------------------------------------------------------
# stdin is a pipe, so the installer reattaches to /dev/tty for the two
# interactive logins. Where there is no controlling terminal (CI, this test)
# that reattach fails, and `set -e` must not take the run down with it.

reset_case
STDIN_PIPE=1
run_install
assert_eq "piped stdin: the run survives a failed /dev/tty reattach" "0" "$rc"
assert_contains "piped stdin: still reaches the end" "npm run init-registry" "$log"

# --- vm-board.sh ------------------------------------------------------------
# Runs inside the VM, launched by `limactl shell -- <path>`: no login shell, no
# rc files, so it has to put ~/.local/bin on PATH and source the env itself.

reset_case
mkdir -p "$CASE_DIR/tidepool" "$CASE_DIR/.tidepool" "$STUB_DIR"
cat > "$CASE_DIR/.tidepool/env" <<'ENV'
export TIDEPOOL_REGISTRY="$HOME/tidepool-registry"
export TIDEPOOL_DB="$HOME/.tidepool/board.sqlite"
ENV
cat > "$STUB_DIR/systemd-run" <<'STUB'
#!/bin/bash
echo "systemd-run $*"
echo "TIDEPOOL_REGISTRY=$TIDEPOOL_REGISTRY"
echo "cwd=$PWD"
echo "PATH=$PATH"
STUB
chmod +x "$STUB_DIR/systemd-run"
board_out=$(env PATH="$STUB_DIR:/usr/bin:/bin" HOME="$CASE_DIR" \
  bash "$SCRIPT_DIR/vm-board.sh" 2>&1) && rc=0 || rc=$?
assert_eq "vm-board: exits 0" "0" "$rc"
assert_contains "vm-board: hands the board its own delegated cgroup scope" \
  "systemd-run --user --scope --unit tidepool-board -p Delegate=yes -- npm start" "$board_out"
assert_contains "vm-board: exports the environment file to the board" \
  "TIDEPOOL_REGISTRY=$CASE_DIR/tidepool-registry" "$board_out"
assert_contains "vm-board: starts from the checkout" "cwd=$CASE_DIR/tidepool" "$board_out"
assert_contains "vm-board: puts the claude install location on PATH" \
  "PATH=$CASE_DIR/.local/bin:" "$board_out"

# --- summary ---------------------------------------------------------------

echo
echo "$PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
