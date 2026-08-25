#!/usr/bin/env bash
# scripts/vm-board.sh — start the board inside the Lima VM. Launched from the
# Mac as `caffeinate -i -s limactl shell <instance> -- ~/tidepool/scripts/vm-board.sh`
# (ADR 0090 決定2: foreground, no launchd).
#
# `limactl shell -- <path>` runs without a login shell and without rc files, so
# PATH and the environment file are set here: the board spawns `claude` from
# ~/.local/bin, and its state pointers live in ~/.tidepool/env (ADR 0090 決定3).
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
source "$HOME/.tidepool/env"
cd "$HOME/tidepool"

# --scope with Delegate=yes gives the board a cgroup subtree of its own for its
# worker containers; without it the board refuses to pick anything up.
exec systemd-run --user --scope --unit tidepool-board -p Delegate=yes -- npm start
