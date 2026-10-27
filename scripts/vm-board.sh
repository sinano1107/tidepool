#!/usr/bin/env bash
# scripts/vm-board.sh — start the board inside the Lima VM. Launched from the
# Mac as `caffeinate -i -s limactl shell <instance> -- bash -lc '~/tidepool/scripts/vm-board.sh'`
# (ADR 0090 決定2: foreground, no launchd). The `~` has to reach the guest
# unexpanded — bare, the Mac's shell would expand it to /Users/<mac-user>, the
# read-only mount of the Mac home, which on a friend's Mac has no checkout.
#
# The board runs as a transient systemd service, not a scope (ADR 0318): when
# the board dies, systemd kills its worker containers with it, and the same
# start line works again right after a crash. --pty --pipe --wait keeps it in
# the foreground of this terminal; -G unloads the unit when it ends. Delegate=yes
# gives the board the cgroup subtree it puts the containers in; without a
# service and Delegate the board refuses to pick anything up.
#
# A service is started by the user manager, not by this shell, so it inherits
# neither this environment nor this directory: its own login shell sets PATH
# (the board spawns `claude` from ~/.local/bin), sources the state pointers in
# ~/.tidepool/env (ADR 0090 決定3) and enters the checkout.
set -euo pipefail

exec systemd-run --user --unit tidepool-board -p Delegate=yes --pty --pipe --wait -G -- \
  bash -lc 'export PATH="$HOME/.local/bin:$PATH" && source "$HOME/.tidepool/env" && cd "$HOME/tidepool" && exec npm start'
