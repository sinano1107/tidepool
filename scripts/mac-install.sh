#!/usr/bin/env bash
# scripts/mac-install.sh — set up a Tidepool board on an Apple Silicon Mac
# with one command (ADR 0101). Creates a Lima VM from the template in this
# repository, walks the two browser logins inside it, and leaves the board
# ready to start.
#
#   curl -fsSL https://raw.githubusercontent.com/sinano1107/tidepool/main/scripts/mac-install.sh | bash
#
# Every stage checks its own state first, so an interrupted run continues
# where it stopped and a run on a finished setup changes nothing.
# macOS ships bash 3.2 and `curl | bash` uses it — keep this 3.2-compatible.

set -euo pipefail

log() { printf '\033[1;34m[tidepool]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

VM="${TIDEPOOL_VM:-tidepool}"
TEMPLATE_URL="${TIDEPOOL_TEMPLATE_URL:-https://raw.githubusercontent.com/sinano1107/tidepool/main/lima/tidepool.yaml}"

# Piped in through `curl | bash`, stdin is the pipe, but `gh auth login` and
# `claude auth login` below want a terminal. Reattach to the controlling one
# if there is any; a machine without one (CI, a detached shell) must not die
# here, so the failing redirection is contained in its own group.
reattach_tty() {
  if [[ ! -t 0 && -e /dev/tty ]]; then
    { exec < /dev/tty; } 2> /dev/null || true
  fi
}

# Every VM-side command goes through here. `bash -lc` because a login shell is
# what puts ~/.local/bin (the `claude` install location) on PATH, and every
# command names its own directory because `limactl shell` starts in the Mac's
# cwd, which is mounted read-only inside the VM.
vm() { limactl shell "$VM" -- bash -lc "$*"; }

precheck() {
  [[ "$(uname -m)" == "arm64" ]] \
    || fail "this needs an Apple Silicon Mac (Intel Macs cannot run the board's VM). You also need Homebrew, a GitHub account, and a Claude subscription."
  command -v brew > /dev/null \
    || fail "Homebrew is missing — install it from https://brew.sh and run this again. You also need a GitHub account and a Claude subscription."
}

announce() {
  log "Setting up a Tidepool board in a Linux VM on this Mac."
  log "You will need: a GitHub account, and a Claude subscription to log in with."
  log "Node, the claude CLI and gh are installed inside the VM, not on your Mac."
  log "First run downloads a ~941 MB VM image and takes about 30 minutes."
}

ensure_lima() {
  command -v limactl > /dev/null || brew install lima
}

ensure_vm() {
  local status
  status="$(limactl list --format '{{.Status}}' "$VM" 2> /dev/null || true)"
  if [[ -z "$status" ]]; then
    log "Creating the VM '$VM' — this is the long part; provisioning progress follows."
    limactl start --tty=false --progress --name "$VM" "$TEMPLATE_URL"
  elif [[ "$status" != "Running" ]]; then
    log "Starting the existing VM '$VM'."
    limactl start "$VM"
  fi
}

ensure_gh_login() {
  if vm 'gh auth status' > /dev/null 2>&1; then
    log "gh is already logged in inside the VM."
    return
  fi
  log "Logging the VM's gh in — this opens a browser. It is the VM's own login, not your Mac's."
  vm 'gh auth login --git-protocol https --web'
  vm 'gh auth setup-git'
}

ensure_claude_login() {
  if vm 'claude auth status --json' 2> /dev/null | grep -q '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
    log "claude is already logged in inside the VM."
    return
  fi
  log "Logging the VM's claude in — this opens a browser too, and needs your Claude subscription."
  vm 'claude auth login'
}

# Without this the board's `claude --safe-mode` usage scrape stops at the
# folder-trust dialog and the board silently picks nothing up (#442). The seed
# is idempotent, so it runs on every pass rather than being state-checked.
seed_trust() {
  vm 'cd ~/tidepool && node scripts/seed-claude-trust.mjs ~/tidepool'
}

fetch_github_user() {
  local tsv
  tsv="$(vm "gh api user --jq '[.login, .id, (.name // \"\")] | @tsv'")"
  IFS=$'\t' read -r LOGIN USER_ID USER_NAME <<< "$tsv"
  [[ -n "${LOGIN:-}" ]] || fail "could not read your GitHub login from the VM's gh"
  [[ -n "${USER_NAME:-}" ]] || USER_NAME="$LOGIN"
}

ensure_git_identity() {
  if vm 'git config --global user.name && git config --global user.email' > /dev/null 2>&1; then
    log "The VM already has a git identity."
    return
  fi
  vm "git config --global user.name \"$USER_NAME\""
  vm "git config --global user.email \"$USER_ID+$LOGIN@users.noreply.github.com\""
}

ensure_registry() {
  if vm "gh repo view $LOGIN/tidepool-registry" > /dev/null 2>&1; then
    log "The registry repository already exists."
  else
    log "Creating your private $LOGIN/tidepool-registry repository."
    vm "gh repo create $LOGIN/tidepool-registry --private"
  fi

  if ! vm 'source ~/.tidepool/env && test -d "$TIDEPOOL_REGISTRY/.git"'; then
    vm "source ~/.tidepool/env && git clone https://github.com/$LOGIN/tidepool-registry.git \"\$TIDEPOOL_REGISTRY\""
  fi

  # init-registry refuses a non-empty remote itself (ADR 0089); this check only
  # keeps a re-run from printing that refusal.
  if [[ -n "$(vm 'source ~/.tidepool/env && git -C "$TIDEPOOL_REGISTRY" ls-remote --heads origin')" ]]; then
    log "The registry is already seeded."
  else
    log "Seeding the registry."
    vm 'source ~/.tidepool/env && cd ~/tidepool && npm run init-registry'
  fi
}

print_next_steps() {
  log "Done. Start the board from this Mac with:"
  echo
  echo "  caffeinate -i -s limactl shell $VM -- ~/tidepool/scripts/vm-board.sh"
  echo
  log "Leave it running in the foreground. The first boot prints a one-time bootstrap URL —"
  log "open that in your browser first, then the WebUI at http://127.0.0.1:4589."
  log "To stop the board:"
  echo
  echo "  limactl shell $VM -- systemctl --user stop tidepool-board.scope"
  echo
  log "To update Tidepool later (your decision, never automatic):"
  echo
  echo "  limactl shell $VM --workdir ~/tidepool -- bash -lc 'git pull && npm install'"
  echo
}

main() {
  precheck
  reattach_tty
  announce
  ensure_lima
  ensure_vm
  ensure_gh_login
  ensure_claude_login
  seed_trust
  fetch_github_user
  ensure_git_identity
  ensure_registry
  print_next_steps
}

# guarded so scripts/mac-install.test.sh can `source` this file and call
# main() against its stubs
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
